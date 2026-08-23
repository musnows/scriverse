import type { Server } from "node:http";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, join } from "node:path";
import { createRuntime, type Runtime } from "./app.js";
import { resolveAiChatTabLimit } from "./ai-chat-tab-limit.js";
import { resolveAiRetryPolicy } from "./ai-retry.js";
import { AI_STREAM_IDLE_TIMEOUT_SECONDS_ENV, resolveAiStreamIdleTimeoutMs } from "./ai-stream-timeout.js";
import { DATABASE_SCHEMA_VERSION, readDatabaseSchemaVersion } from "./database.js";
import { loadMasterSecret } from "./credential-vault.js";
import { isDevelopmentAuthBypassEnabled, resolveRuntimeSecurity, warnIfPrivateAiEndpointsEnabled, type RuntimeSecurityOptions } from "./security.js";
import { logger, sanitizeError } from "./logger.js";
import { resolveReleaseCheckIntervalMs, resolveReleaseCheckRetries, resolveReleaseCheckTimeoutMs } from "./release-update.js";
import { resolveImageUploadLimits } from "./upload-limits.js";
import { resolveBetaVersionLabel } from "./version.js";
import { claimServerDataDirectory, STORAGE_MANIFEST_FILENAME } from "./storage-manifest.js";

export type LocalServerOptions = {
  host: string;
  port: number;
  dataDirectory: string;
  databasePath: string;
  env: NodeJS.ProcessEnv;
};

export type RunningLocalServer = {
  server: Server;
  runtime: Runtime;
  url: string;
  host: string;
  port: number;
  dataDirectory: string;
  databasePath: string;
  security: RuntimeSecurityOptions;
  close: () => Promise<void>;
};

const publicPath = fileURLToPath(new URL("./public/", import.meta.url));
export const PRE_MIGRATION_BACKUP_RETENTION_ENV = "SCRIVERSE_PRE_MIGRATION_BACKUP_RETENTION";
export const DEFAULT_PRE_MIGRATION_BACKUP_RETENTION = 5;
export const MIN_PRE_MIGRATION_BACKUP_RETENTION = 2;
export const STARTUP_RETRY_LIMIT_ENV = "SCRIVERSE_STARTUP_RETRY_LIMIT";
export const DEFAULT_STARTUP_RETRY_LIMIT = 2;
export const STARTUP_RETRY_STATE_FILENAME = ".startup-retry.json";
export const SERVER_SHUTDOWN_TIMEOUT_MS = 10_000;

export function isDevelopmentServer(environment: NodeJS.ProcessEnv): boolean {
  return environment.NODE_ENV === "development" || environment.npm_lifecycle_event === "dev";
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLocaleLowerCase().replace(/^\[|\]$/gu, "");
  return normalized === "localhost" || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/u.test(normalized);
}

export function resolvePreMigrationBackupRetention(environment: NodeJS.ProcessEnv): number {
  const raw = environment[PRE_MIGRATION_BACKUP_RETENTION_ENV]?.trim() ?? "";
  if (raw === "") return DEFAULT_PRE_MIGRATION_BACKUP_RETENTION;
  const configured = Number(raw);
  if (!Number.isFinite(configured)) return DEFAULT_PRE_MIGRATION_BACKUP_RETENTION;
  return Math.max(MIN_PRE_MIGRATION_BACKUP_RETENTION, Math.floor(configured));
}

export function resolveStartupRetryLimit(environment: NodeJS.ProcessEnv): number {
  const raw = environment[STARTUP_RETRY_LIMIT_ENV]?.trim() ?? "";
  if (raw === "") return DEFAULT_STARTUP_RETRY_LIMIT;
  const configured = Number(raw);
  if (!Number.isFinite(configured) || configured < 1) return DEFAULT_STARTUP_RETRY_LIMIT;
  return Math.floor(configured);
}

function startupRetryStatePath(dataDirectory: string): string {
  return join(dataDirectory, STARTUP_RETRY_STATE_FILENAME);
}

function readStartupRetryCount(dataDirectory: string): number {
  const statePath = startupRetryStatePath(dataDirectory);
  if (!existsSync(statePath)) return 0;
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as { attempts?: unknown };
    const attempts = Number(parsed.attempts);
    return Number.isInteger(attempts) && attempts >= 0 ? attempts : 0;
  } catch (error) {
    logger.warn("server.startup_retry_state.invalid", { retryStatePath: statePath, error: sanitizeError(error) });
    return 0;
  }
}

function writeStartupRetryCount(dataDirectory: string, attempts: number): void {
  const statePath = startupRetryStatePath(dataDirectory);
  const temporaryPath = `${statePath}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify({ attempts, updatedAt: new Date().toISOString() }, null, 2), { encoding: "utf8", mode: 0o600 });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, statePath);
  chmodSync(statePath, 0o600);
}

function recordStartupAttempt(dataDirectory: string, environment: NodeJS.ProcessEnv): void {
  const retryLimit = resolveStartupRetryLimit(environment);
  const previousAttempts = readStartupRetryCount(dataDirectory);
  const retryStatePath = startupRetryStatePath(dataDirectory);
  if (previousAttempts >= retryLimit) {
    logger.error("server.startup_retry_limit_reached", {
      retryStatePath,
      attempts: previousAttempts,
      retryLimit,
      message: "Startup retry limit reached. Fix the previous initialization error, remove the startup retry state file, and restart Scriverse."
    });
    throw new Error(`Startup retry limit reached (${retryLimit}); fix the previous initialization error and remove ${retryStatePath} before restarting`);
  }
  const attempts = previousAttempts + 1;
  writeStartupRetryCount(dataDirectory, attempts);
  logger.warn("server.startup_attempt.recorded", { retryStatePath, attempts, retryLimit });
}

function clearStartupRetryState(dataDirectory: string): void {
  const statePath = startupRetryStatePath(dataDirectory);
  if (!existsSync(statePath)) return;
  try {
    rmSync(statePath, { force: true });
    logger.info("server.startup_retry_state.cleared", { retryStatePath: statePath });
  } catch (error) {
    logger.error("server.startup_retry_state.clear_failed", { retryStatePath: statePath, error: sanitizeError(error) });
  }
}

type PreMigrationBackup = {
  directory: string;
  modifiedAt: number;
};

function listPreMigrationBackups(backupsDirectory: string): PreMigrationBackup[] {
  if (!existsSync(backupsDirectory)) return [];
  return readdirSync(backupsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("pre-migration-v") && !entry.name.endsWith(".incomplete"))
    .map((entry) => {
      const directory = join(backupsDirectory, entry.name);
      return { directory, modifiedAt: statSync(directory).mtimeMs };
    })
    .filter(({ directory }) => existsSync(join(directory, "backup.json")))
    .sort((left, right) => left.modifiedAt - right.modifiedAt || left.directory.localeCompare(right.directory));
}

function prunePreMigrationBackups(backupsDirectory: string, maximumCount: number): void {
  const backups = listPreMigrationBackups(backupsDirectory);
  const excessCount = Math.max(0, backups.length - maximumCount);
  for (const backup of backups.slice(0, excessCount)) {
    try {
      rmSync(backup.directory, { recursive: true, force: true });
      logger.info("database.pre_migration_backup.pruned", {
        backupDirectory: backup.directory,
        retentionCount: maximumCount
      });
    } catch (error) {
      logger.warn("database.pre_migration_backup.prune_failed", {
        backupDirectory: backup.directory,
        error: sanitizeError(error)
      });
    }
  }
}

export function createPreMigrationBackup(
  options: Pick<LocalServerOptions, "dataDirectory" | "databasePath">,
  environment: NodeJS.ProcessEnv = process.env
): string | null {
  const backupsDirectory = join(options.dataDirectory, "backups");
  const retentionCount = resolvePreMigrationBackupRetention(environment);
  prunePreMigrationBackups(backupsDirectory, retentionCount);
  const schemaVersion = readDatabaseSchemaVersion(options.databasePath);
  if (schemaVersion === null || schemaVersion >= DATABASE_SCHEMA_VERSION) return null;
  prunePreMigrationBackups(backupsDirectory, retentionCount - 1);
  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const backupName = `pre-migration-v${schemaVersion}-to-v${DATABASE_SCHEMA_VERSION}-${timestamp}`;
  const incompleteDirectory = join(backupsDirectory, `${backupName}.incomplete`);
  const backupDirectory = join(backupsDirectory, backupName);
  mkdirSync(incompleteDirectory, { recursive: true, mode: 0o700 });
  chmodSync(incompleteDirectory, 0o700);
  for (const source of [options.databasePath, `${options.databasePath}-wal`, `${options.databasePath}-shm`]) {
    if (!existsSync(source)) continue;
    const target = join(incompleteDirectory, basename(source));
    cpSync(source, target, { preserveTimestamps: true });
    chmodSync(target, 0o600);
  }
  const masterKeyPath = join(options.dataDirectory, "master.key");
  if (existsSync(masterKeyPath)) {
    const target = join(incompleteDirectory, "master.key");
    cpSync(masterKeyPath, target, { preserveTimestamps: true });
    chmodSync(target, 0o600);
  }
  const storageManifestPath = join(options.dataDirectory, STORAGE_MANIFEST_FILENAME);
  if (existsSync(storageManifestPath)) {
    const target = join(incompleteDirectory, STORAGE_MANIFEST_FILENAME);
    cpSync(storageManifestPath, target, { preserveTimestamps: true });
    chmodSync(target, 0o600);
  }
  const attachmentsPath = join(options.dataDirectory, "attachments");
  if (existsSync(attachmentsPath)) {
    cpSync(attachmentsPath, join(incompleteDirectory, "attachments"), { recursive: true, preserveTimestamps: true });
  }
  const characterAvatarsPath = join(options.dataDirectory, "character-avatars");
  if (existsSync(characterAvatarsPath)) {
    cpSync(characterAvatarsPath, join(incompleteDirectory, "character-avatars"), { recursive: true, preserveTimestamps: true });
  }
  writeFileSync(join(incompleteDirectory, "backup.json"), JSON.stringify({
    createdAt: new Date().toISOString(),
    fromSchemaVersion: schemaVersion,
    toSchemaVersion: DATABASE_SCHEMA_VERSION,
    databaseFile: basename(options.databasePath)
  }, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(incompleteDirectory, backupDirectory);
  logger.info("database.pre_migration_backup.created", {
    backupDirectory,
    fromSchemaVersion: schemaVersion,
    toSchemaVersion: DATABASE_SCHEMA_VERSION
  });
  return backupDirectory;
}

export async function startLocalServer(options: LocalServerOptions): Promise<RunningLocalServer> {
  logger.info("server.starting", { host: options.host, port: options.port, dataDirectory: options.dataDirectory, databasePath: options.databasePath });
  let security: RuntimeSecurityOptions;
  let runtime: Runtime;
  try {
    mkdirSync(options.dataDirectory, { recursive: true, mode: 0o700 });
    chmodSync(options.dataDirectory, 0o700);
    claimServerDataDirectory(options.dataDirectory, options.databasePath);
    recordStartupAttempt(options.dataDirectory, options.env);
    security = resolveRuntimeSecurity(options.env);
    warnIfPrivateAiEndpointsEnabled(options.env);
    createPreMigrationBackup(options, options.env);
    const devAuthBypass = isDevelopmentAuthBypassEnabled(options.env);
    if (devAuthBypass && !isLoopbackHost(options.host)) {
      throw new Error("APP_DEV_SKIP_AUTH 仅允许绑定本机回环地址");
    }
    runtime = createRuntime({
      databasePath: options.databasePath,
      liteLlmPriceCachePath: join(options.dataDirectory, "litellm-model-prices.json"),
      attachmentDirectory: join(options.dataDirectory, "attachments"),
      characterAvatarDirectory: join(options.dataDirectory, "character-avatars"),
      masterSecret: loadMasterSecret(join(options.dataDirectory, "master.key"), options.env.AI_NOVEL_MASTER_KEY),
      publicPath,
      security,
      disableUserAuth: devAuthBypass,
      devAuthBypass,
      developmentServer: isDevelopmentServer(options.env),
      betaVersionLabel: resolveBetaVersionLabel(options.env),
      releaseCheckIntervalMs: resolveReleaseCheckIntervalMs(options.env.APP_UPDATE_CHECK_INTERVAL_MINUTES),
      releaseCheckTimeoutMs: resolveReleaseCheckTimeoutMs(options.env.APP_UPDATE_CHECK_TIMEOUT_SECONDS),
      releaseCheckRetries: resolveReleaseCheckRetries(options.env.APP_UPDATE_CHECK_RETRIES),
      aiChatTabLimit: resolveAiChatTabLimit(options.env),
      aiRetryPolicy: resolveAiRetryPolicy(options.env),
      ...(options.env[AI_STREAM_IDLE_TIMEOUT_SECONDS_ENV]?.trim()
        ? { aiStreamIdleTimeoutMs: resolveAiStreamIdleTimeoutMs(options.env) }
        : {}),
      uploadLimits: resolveImageUploadLimits(options.env)
    });
    await runtime.cleanupAttachments();
  } catch (error) {
    logger.error("server.initialization_failed", { host: options.host, port: options.port, error: sanitizeError(error) });
    throw error;
  }

  return await new Promise<RunningLocalServer>((resolveStart, rejectStart) => {
    const server = runtime.app.listen(options.port, options.host);
    const handleStartupError = (error: Error): void => {
      logger.error("server.start_failed", { host: options.host, port: options.port, error: sanitizeError(error) });
      void runtime.close().then(
        () => rejectStart(error),
        (closeError: unknown) => {
          logger.error("server.runtime_close_failed", { error: sanitizeError(closeError) });
          rejectStart(error);
        }
      );
    };
    server.once("error", handleStartupError);
    server.once("listening", () => {
      server.off("error", handleStartupError);
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        void runtime.close().catch((closeError: unknown) => {
          logger.error("server.runtime_close_failed", { error: sanitizeError(closeError) });
        });
        rejectStart(new Error("Scriverse server did not expose a TCP port"));
        return;
      }
      const port = address.port;
      const displayHost = options.host.includes(":") ? `[${options.host}]` : options.host;
      clearStartupRetryState(options.dataDirectory);
      let closePromise: Promise<void> | null = null;
      const close = (): Promise<void> => {
        if (closePromise) return closePromise;
        closePromise = (async () => {
          logger.info("server.stopping", { host: options.host, port });
          const serverClose = new Promise<void>((resolveClose, rejectClose) => {
            server.close((error) => error ? rejectClose(error) : resolveClose());
          });
          server.closeAllConnections();
          try {
            await serverClose;
          } finally {
            await runtime.close();
            logger.info("server.stopped", { host: options.host, port });
          }
        })();
        return closePromise;
      };
      resolveStart({
        server,
        runtime,
        url: `http://${displayHost}:${port}`,
        host: options.host,
        port,
        dataDirectory: options.dataDirectory,
        databasePath: options.databasePath,
        security,
        close
      });
    });
  });
}

export function installServerShutdownHandlers(running: RunningLocalServer): void {
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("server.shutdown_signal_received", { signal });
    const forceExitTimer = setTimeout(() => {
      logger.error("server.shutdown_timeout", { signal, timeoutMs: SERVER_SHUTDOWN_TIMEOUT_MS });
      process.exit(1);
    }, SERVER_SHUTDOWN_TIMEOUT_MS);
    forceExitTimer.unref();
    void running.close().then(
      () => {
        clearTimeout(forceExitTimer);
        process.exitCode = 0;
      },
      (error: unknown) => {
        logger.error("server.stop_failed", { signal, error: sanitizeError(error) });
        process.exitCode = 1;
      }
    );
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}
