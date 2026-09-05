import type { Server } from "node:http";
import { chmodSync, cpSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, join } from "node:path";
import { createRuntime, type Runtime } from "./app.js";
import { DATABASE_SCHEMA_VERSION, readDatabaseSchemaVersion } from "./database.js";
import { loadMasterSecret } from "./credential-vault.js";
import { isDevelopmentAuthBypassEnabled, resolveRuntimeSecurity, type RuntimeSecurityOptions } from "./security.js";
import { logger, sanitizeError } from "./logger.js";

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

export function isDevelopmentServer(environment: NodeJS.ProcessEnv): boolean {
  return environment.NODE_ENV === "development" || environment.npm_lifecycle_event === "dev";
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLocaleLowerCase().replace(/^\[|\]$/gu, "");
  return normalized === "localhost" || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/u.test(normalized);
}

export function createPreMigrationBackup(options: Pick<LocalServerOptions, "dataDirectory" | "databasePath">): string | null {
  const schemaVersion = readDatabaseSchemaVersion(options.databasePath);
  if (schemaVersion === null || schemaVersion >= DATABASE_SCHEMA_VERSION) return null;
  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const backupsDirectory = join(options.dataDirectory, "backups");
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
  const attachmentsPath = join(options.dataDirectory, "attachments");
  if (existsSync(attachmentsPath)) {
    cpSync(attachmentsPath, join(incompleteDirectory, "attachments"), { recursive: true, preserveTimestamps: true });
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
    security = resolveRuntimeSecurity(options.env);
    createPreMigrationBackup(options);
    const devAuthBypass = isDevelopmentAuthBypassEnabled(options.env);
    if (devAuthBypass && !isLoopbackHost(options.host)) {
      throw new Error("APP_DEV_SKIP_AUTH 仅允许绑定本机回环地址");
    }
    runtime = createRuntime({
      databasePath: options.databasePath,
      attachmentDirectory: join(options.dataDirectory, "attachments"),
      masterSecret: loadMasterSecret(join(options.dataDirectory, "master.key"), options.env.AI_NOVEL_MASTER_KEY),
      publicPath,
      security,
      s3Backup: { allowPrivateEndpoints: options.env.APP_ALLOW_PRIVATE_S3_ENDPOINTS === "true" || isDevelopmentServer(options.env) },
      disableUserAuth: devAuthBypass,
      devAuthBypass,
      developmentServer: isDevelopmentServer(options.env)
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
      runtime.close();
      rejectStart(error);
    };
    server.once("error", handleStartupError);
    server.once("listening", () => {
      server.off("error", handleStartupError);
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        runtime.close();
        rejectStart(new Error("Scriverse server did not expose a TCP port"));
        return;
      }
      const port = address.port;
      const displayHost = options.host.includes(":") ? `[${options.host}]` : options.host;
      let closed = false;
      const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        logger.info("server.stopping", { host: options.host, port });
        runtime.s3Backup.dispose();
        await runtime.s3Backup.waitForIdle();
        server.closeAllConnections();
        try {
          await new Promise<void>((resolveClose, rejectClose) => {
            server.close((error) => error ? rejectClose(error) : resolveClose());
          });
        } finally {
          runtime.close();
          logger.info("server.stopped", { host: options.host, port });
        }
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
    void running.close().then(
      () => { process.exitCode = 0; },
      (error: unknown) => {
        logger.error("server.stop_failed", { signal, error: sanitizeError(error) });
        process.exitCode = 1;
      }
    );
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}
