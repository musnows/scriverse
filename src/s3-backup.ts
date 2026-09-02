import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import {
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { AttachmentStorage } from "./attachment-storage.js";
import { encryptObject, generateKek } from "./backup-encryption.js";
import { CredentialVault, type EncryptedSecret } from "./credential-vault.js";
import { Database, PLATFORM_AI_WORK_ID, type Row } from "./database.js";
import { AppError } from "./errors.js";
import { logger, sanitizeError, type Logger } from "./logger.js";
import { Store } from "./store.js";

export type S3BackupTargetInput = {
  name: string;
  endpoint: string;
  region?: string;
  bucket: string;
  basePath?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
  enabled?: boolean;
  backupImages?: boolean;
  scheduleTime?: string;
  retentionCount?: number;
};

export type S3BackupTargetUpdate = Partial<S3BackupTargetInput>;

export type S3BackupTarget = {
  id: string;
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  basePath: string;
  rootPrefix: string;
  forcePathStyle: boolean;
  enabled: boolean;
  backupImages: boolean;
  scheduleTime: string;
  retentionCount: number;
  sortOrder: number;
  credentialsConfigured: true;
  lastStartedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type S3BackupTrigger = "manual" | "scheduled";

export type S3BackupRun = {
  sequence: number;
  id: string;
  targetId: string | null;
  targetName: string;
  trigger: S3BackupTrigger;
  status: "running" | "succeeded" | "failed";
  databaseKey: string | null;
  imagesUploaded: number;
  imagesSkipped: number;
  databasesDeleted: number;
  errorMessage: string | null;
  serverResponse: Record<string, unknown> | null;
  startedAt: string;
  finishedAt: string | null;
};

export type S3BackupConnection = {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  resolvedAddresses?: readonly S3ResolvedAddress[];
};

export type S3ResolvedAddress = { address: string; family: 4 | 6 };

export type S3ListedObject = {
  key: string;
  lastModified: Date | null;
};

export type S3ObjectClient = {
  objectExists: (bucket: string, key: string) => Promise<boolean>;
  putObject: (input: { bucket: string; key: string; body: Buffer; contentType: string; metadata?: Record<string, string> }) => Promise<void>;
  listObjects: (bucket: string, prefix: string) => Promise<S3ListedObject[]>;
  deleteObjects: (bucket: string, keys: string[]) => Promise<void>;
  close: () => void;
};

export type S3BackupManagerOptions = {
  clientFactory?: (connection: S3BackupConnection) => S3ObjectClient;
  snapshotDatabase?: () => Buffer | Promise<Buffer>;
  masterKey?: Buffer | string;
  requestTimeoutMs?: number;
  validateEndpoint?: (endpoint: string) => Promise<readonly S3ResolvedAddress[] | void>;
  now?: () => Date;
  logger?: Logger;
  encryptionConfirmationTtlMs?: number;
  characterAvatarStorage?: AttachmentStorage;
};

export type S3BackupQueueReceipt = {
  acceptedTargetIds: string[];
  skippedTargetIds: string[];
};

export type S3BackupEncryptionState = {
  enabled: boolean;
  keyConfiguredAt: string | null;
};

export type S3BackupEncryptionUpdate = S3BackupEncryptionState & {
  key?: string;
  confirmationToken?: string;
};

type PendingBackupEncryption = {
  key: string;
  confirmationTokenHash: Buffer;
  expiresAtMs: number;
};

type RuntimeTarget = S3BackupTarget & {
  accessKeyId: string;
  secretAccessKey: string;
};

type BackupImageSource = {
  objectKey: string;
  contentType: string;
  sha256: string;
  read: () => Promise<Buffer>;
};

type DatabaseImageLocation =
  | { table: "work_covers"; idColumn: "work_id"; label: "作品封面" }
  | { table: "user_avatars"; idColumn: "user_id"; label: "用户头像" };

type DatabaseImageMetadata = {
  sourceId: string;
  contentType: string;
  byteLength: number;
  sha256: string;
};

const sensitiveResponseKey = /(?:authorization|credential|accesskey|secret|securitytoken|set-cookie)/iu;

function redactedString(value: string, secrets: readonly string[]): string {
  let result = value;
  for (const secret of secrets) {
    if (secret) result = result.replaceAll(secret, "[REDACTED]");
  }
  return result.slice(0, 20_000);
}

function serializableValue(value: unknown, secrets: readonly string[], key = "", depth = 0, seen = new WeakSet<object>()): unknown {
  if (sensitiveResponseKey.test(key)) return "[REDACTED]";
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return redactedString(value, secrets);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return { byteLength: value.byteLength };
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[CIRCULAR]";
  if (depth >= 6) return "[TRUNCATED]";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 1_000).map((item) => serializableValue(item, secrets, "", depth + 1, seen));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([entryKey]) => entryKey !== "$response" && entryKey !== "stack")
    .slice(0, 1_000)
    .map(([entryKey, entryValue]) => [entryKey, serializableValue(entryValue, secrets, entryKey, depth + 1, seen)]));
}

export function s3FailureServerResponse(error: unknown, secrets: readonly string[] = []): Record<string, unknown> {
  const result: Record<string, unknown> = error instanceof Error
    ? { name: error.name, message: redactedString(error.message, secrets) }
    : { message: redactedString(String(error), secrets) };
  if (!error || typeof error !== "object") return result;
  const record = error as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (key === "$response" || key === "stack") continue;
    result[key] = serializableValue(value, secrets, key);
  }
  const response = record.$response;
  if (response && typeof response === "object") {
    const responseRecord = response as Record<string, unknown>;
    result.httpResponse = {
      statusCode: serializableValue(responseRecord.statusCode, secrets, "statusCode"),
      statusMessage: serializableValue(responseRecord.statusMessage, secrets, "statusMessage"),
      headers: serializableValue(responseRecord.headers, secrets, "headers")
    };
  }
  return result;
}

class AwsS3ObjectClient implements S3ObjectClient {
  private readonly client: S3Client;

  constructor(connection: S3BackupConnection) {
    const requestHandler = connection.resolvedAddresses?.length
      ? new NodeHttpHandler({
          httpAgent: new HttpAgent({ keepAlive: true, maxSockets: 10, lookup: pinnedS3Lookup(connection) }),
          httpsAgent: new HttpsAgent({ keepAlive: true, maxSockets: 10, lookup: pinnedS3Lookup(connection) })
        })
      : undefined;
    this.client = new S3Client({
      endpoint: connection.endpoint,
      region: connection.region,
      credentials: {
        accessKeyId: connection.accessKeyId,
        secretAccessKey: connection.secretAccessKey
      },
      forcePathStyle: connection.forcePathStyle,
      maxAttempts: 3,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      ...(requestHandler ? { requestHandler } : {})
    });
  }

  async objectExists(bucket: string, key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return true;
    } catch (error) {
      const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: number } };
      if (candidate.$metadata?.httpStatusCode === 404 || candidate.name === "NotFound" || candidate.name === "NoSuchKey") return false;
      throw error;
    }
  }

  async putObject(input: { bucket: string; key: string; body: Buffer; contentType: string; metadata?: Record<string, string> }): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: input.bucket,
      Key: input.key,
      Body: input.body,
      ContentLength: input.body.byteLength,
      ContentType: input.contentType,
      Metadata: input.metadata
    }));
  }

  async listObjects(bucket: string, prefix: string): Promise<S3ListedObject[]> {
    const objects: S3ListedObject[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await this.client.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken
      }));
      for (const item of page.Contents ?? []) {
        if (!item.Key) continue;
        objects.push({ key: item.Key, lastModified: item.LastModified ?? null });
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
    return objects;
  }

  async deleteObjects(bucket: string, keys: string[]): Promise<void> {
    for (let offset = 0; offset < keys.length; offset += 1_000) {
      const batch = keys.slice(offset, offset + 1_000);
      if (!batch.length) continue;
      const result = await this.client.send(new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true }
      }));
      if (result.Errors?.length) {
        throw new AppError(502, "S3_DELETE_OBJECTS_FAILED", "S3 服务未能删除部分过期数据库备份", {
          errors: result.Errors.map((item) => ({ key: item.Key, code: item.Code, message: item.Message }))
        });
      }
    }
  }

  close(): void {
    this.client.destroy();
  }
}

function normalizedHostname(value: string): string {
  return value.replace(/^\[|\]$/gu, "").replace(/\.$/u, "").toLocaleLowerCase("en-US");
}

function pinnedS3Lookup(connection: S3BackupConnection): LookupFunction {
  const endpointHostname = normalizedHostname(new URL(connection.endpoint).hostname);
  const addresses = (connection.resolvedAddresses ?? []).filter(({ address, family }) => isIP(address) === family);
  return (hostname, options, callback) => {
    const requestedHostname = normalizedHostname(hostname);
    const expectedHostname = requestedHostname === endpointHostname
      || (!connection.forcePathStyle && requestedHostname.endsWith(`.${endpointHostname}`));
    const requestedFamily = options.family === 4 || options.family === 6 ? options.family : 0;
    const candidates = expectedHostname
      ? addresses.filter(({ family }) => requestedFamily === 0 || family === requestedFamily)
      : [];
    if (candidates.length === 0) {
      const error = Object.assign(new Error("S3 endpoint hostname or address was not approved by the SSRF validator"), {
        code: "ENOTFOUND"
      });
      callback(error, "", 0);
      return;
    }
    if (options.all) {
      callback(null, candidates.map(({ address, family }) => ({ address, family })));
      return;
    }
    const selected = candidates[0]!;
    callback(null, selected.address, selected.family);
  };
}

function requiredString(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new AppError(500, "BACKUP_TARGET_INVALID", `S3 备份配置字段 ${key} 无效`);
  return value;
}

function nullableString(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function encryptedSecret(row: Row, prefix: "access_key" | "secret_key"): EncryptedSecret {
  return {
    encrypted: requiredString(row, `${prefix}_encrypted`),
    iv: requiredString(row, `${prefix}_iv`),
    tag: requiredString(row, `${prefix}_tag`)
  };
}

export function normalizeS3BasePath(value = ""): string {
  return value.trim().replace(/^\/+|\/+$/gu, "").replace(/\/{2,}/gu, "/");
}

export function s3BackupRootPrefix(basePath = ""): string {
  const normalized = normalizeS3BasePath(basePath);
  return normalized ? `${normalized}/scriverse` : "scriverse";
}

function normalizedEndpoint(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/gu, "") || "/";
  return url.toString().replace(/\/$/u, "");
}

export class S3BackupManager {
  private readonly clientFactory: (connection: S3BackupConnection) => S3ObjectClient;
  private readonly snapshotDatabase: () => Buffer | Promise<Buffer>;
  private readonly masterKey: Buffer | null;
  private readonly requestTimeoutMs: number;
  private readonly validateEndpoint?: (endpoint: string) => Promise<readonly S3ResolvedAddress[] | void>;
  private readonly now: () => Date;
  private readonly log: Logger;
  private readonly encryptionConfirmationTtlMs: number;
  private readonly characterAvatarStorage: AttachmentStorage | null;
  private readonly queuedTargetIds = new Set<string>();
  private executionChain: Promise<void> = Promise.resolve();
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private pendingBackupEncryption: PendingBackupEncryption | null = null;
  private disposed = false;

  constructor(
    private readonly database: Database,
    private readonly vault: CredentialVault,
    private readonly store: Store,
    private readonly attachmentStorage: AttachmentStorage,
    options: S3BackupManagerOptions = {}
  ) {
    this.clientFactory = options.clientFactory ?? ((connection) => new AwsS3ObjectClient(connection));
    this.snapshotDatabase = options.snapshotDatabase ?? (() => this.database.createSnapshotBuffer());
    this.masterKey = options.masterKey === undefined
      ? null
      : Buffer.isBuffer(options.masterKey) ? Buffer.from(options.masterKey) : Buffer.from(options.masterKey, "utf8");
    const requestTimeoutMs = Number(options.requestTimeoutMs ?? 30_000);
    this.requestTimeoutMs = Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0 ? requestTimeoutMs : 30_000;
    this.validateEndpoint = options.validateEndpoint;
    this.now = options.now ?? (() => new Date());
    this.log = options.logger ?? logger;
    const encryptionConfirmationTtlMs = Number(options.encryptionConfirmationTtlMs ?? 10 * 60_000);
    this.encryptionConfirmationTtlMs = Number.isFinite(encryptionConfirmationTtlMs) && encryptionConfirmationTtlMs > 0
      ? Math.floor(encryptionConfirmationTtlMs)
      : 10 * 60_000;
    this.characterAvatarStorage = options.characterAvatarStorage ?? null;
  }

  listTargets(): S3BackupTarget[] {
    return this.database.all("SELECT * FROM s3_backup_targets ORDER BY sort_order, created_at, id").map((row) => this.mapTarget(row));
  }

  getTarget(targetId: string): S3BackupTarget {
    return this.mapTarget(this.requireTargetRow(targetId));
  }

  getEncryptionState(): S3BackupEncryptionState {
    const row = this.database.get("SELECT * FROM s3_backup_encryption WHERE id = 1");
    if (!row) return { enabled: false, keyConfiguredAt: null };
    const keyConfigured = this.hasBackupEncryptionKey(row);
    if (Number(row.enabled) === 1 && !keyConfigured) {
      throw new AppError(500, "BACKUP_ENCRYPTION_STATE_INVALID", "S3 备份加密配置缺少密钥");
    }
    return {
      enabled: Number(row.enabled) === 1,
      keyConfiguredAt: keyConfigured ? requiredString(row, "created_at") : null
    };
  }

  setEncryptionEnabled(enabled: boolean): S3BackupEncryptionUpdate {
    if (!enabled) this.pendingBackupEncryption = null;
    return this.database.transaction(() => {
      const row = this.database.get("SELECT * FROM s3_backup_encryption WHERE id = 1");
      const currentEnabled = Number(row?.enabled ?? 0) === 1;
      const keyConfigured = row ? this.hasBackupEncryptionKey(row) : false;
      if (currentEnabled && !keyConfigured) {
        throw new AppError(500, "BACKUP_ENCRYPTION_STATE_INVALID", "S3 备份加密配置缺少密钥");
      }
      if (currentEnabled === enabled) {
        return {
          enabled,
          keyConfiguredAt: keyConfigured && row ? requiredString(row, "created_at") : null
        };
      }

      const timestamp = this.now().toISOString();
      if (!enabled) {
        this.database.run("UPDATE s3_backup_encryption SET enabled = 0, updated_at = ? WHERE id = 1", timestamp);
        this.store.audit(
          PLATFORM_AI_WORK_ID,
          "platform.backup-encryption.disabled",
          "s3-backup-encryption",
          "s3-backup-encryption"
        );
        return {
          enabled: false,
          keyConfiguredAt: keyConfigured && row ? requiredString(row, "created_at") : null
        };
      }

      if (row && keyConfigured) {
        this.database.run("UPDATE s3_backup_encryption SET enabled = 1, updated_at = ? WHERE id = 1", timestamp);
        this.store.audit(
          PLATFORM_AI_WORK_ID,
          "platform.backup-encryption.enabled",
          "s3-backup-encryption",
          "s3-backup-encryption",
          { keyGenerated: false }
        );
        return { enabled: true, keyConfiguredAt: requiredString(row, "created_at") };
      }

      const key = generateKek();
      const confirmationToken = randomBytes(32).toString("base64url");
      this.pendingBackupEncryption = {
        key,
        confirmationTokenHash: createHash("sha256").update(confirmationToken).digest(),
        expiresAtMs: this.now().getTime() + this.encryptionConfirmationTtlMs
      };
      return { enabled: false, keyConfiguredAt: null, key, confirmationToken };
    });
  }

  confirmEncryptionEnabled(confirmationToken: string): S3BackupEncryptionState {
    const pending = this.pendingBackupEncryption;
    const tokenHash = createHash("sha256").update(confirmationToken).digest();
    if (!pending || pending.expiresAtMs <= this.now().getTime() || !timingSafeEqual(pending.confirmationTokenHash, tokenHash)) {
      if (pending && pending.expiresAtMs <= this.now().getTime()) this.pendingBackupEncryption = null;
      throw new AppError(409, "BACKUP_ENCRYPTION_CONFIRMATION_INVALID", "备份加密确认已失效，请重新开启并保存新密钥");
    }

    const state = this.database.transaction(() => {
      const row = this.database.get("SELECT * FROM s3_backup_encryption WHERE id = 1");
      const currentEnabled = Number(row?.enabled ?? 0) === 1;
      const keyConfigured = row ? this.hasBackupEncryptionKey(row) : false;
      if (currentEnabled || keyConfigured) {
        throw new AppError(409, "BACKUP_ENCRYPTION_CONFIRMATION_INVALID", "备份加密状态已变化，请刷新后重试");
      }

      const timestamp = this.now().toISOString();
      const encrypted = this.vault.encrypt(pending.key);
      if (row) {
        this.database.run(
          `UPDATE s3_backup_encryption SET enabled = 1, kek_encrypted = ?, kek_iv = ?, kek_tag = ?,
           created_at = ?, updated_at = ? WHERE id = 1`,
          encrypted.encrypted,
          encrypted.iv,
          encrypted.tag,
          timestamp,
          timestamp
        );
      } else {
        this.database.run(
          `INSERT INTO s3_backup_encryption (
            id, enabled, kek_encrypted, kek_iv, kek_tag, created_at, updated_at
          ) VALUES (1, 1, ?, ?, ?, ?, ?)`,
          encrypted.encrypted,
          encrypted.iv,
          encrypted.tag,
          timestamp,
          timestamp
        );
      }
      this.store.audit(
        PLATFORM_AI_WORK_ID,
        "platform.backup-encryption.enabled",
        "s3-backup-encryption",
        "s3-backup-encryption",
        { keyGenerated: true }
      );
      return { enabled: true, keyConfiguredAt: timestamp };
    });
    this.pendingBackupEncryption = null;
    return state;
  }

  createTarget(input: S3BackupTargetInput): S3BackupTarget {
    const targetId = randomUUID();
    const timestamp = this.now().toISOString();
    const accessKey = this.vault.encrypt(input.accessKeyId);
    const secretKey = this.vault.encrypt(input.secretAccessKey);
    this.database.transaction(() => {
      const sortOrder = Number(this.database.get("SELECT COALESCE(MAX(sort_order), -1) + 1 AS value FROM s3_backup_targets")?.value ?? 0);
      this.database.run(
        `INSERT INTO s3_backup_targets (
          id, name, endpoint, region, bucket, base_path,
          access_key_encrypted, access_key_iv, access_key_tag,
          secret_key_encrypted, secret_key_iv, secret_key_tag,
          force_path_style, enabled, backup_images, schedule_time, retention_count, sort_order,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        targetId,
        input.name.trim(),
        normalizedEndpoint(input.endpoint),
        input.region?.trim() || "us-east-1",
        input.bucket.trim(),
        normalizeS3BasePath(input.basePath),
        accessKey.encrypted,
        accessKey.iv,
        accessKey.tag,
        secretKey.encrypted,
        secretKey.iv,
        secretKey.tag,
        input.forcePathStyle === false ? 0 : 1,
        input.enabled === true ? 1 : 0,
        input.backupImages === false ? 0 : 1,
        input.scheduleTime ?? "03:00",
        input.retentionCount ?? 7,
        sortOrder,
        timestamp,
        timestamp
      );
      this.store.audit(PLATFORM_AI_WORK_ID, "platform.backup-target.created", "s3-backup-target", targetId, {
        ...this.sanitizedInput(input),
        rootPrefix: s3BackupRootPrefix(input.basePath)
      });
    });
    return this.getTarget(targetId);
  }

  updateTarget(targetId: string, input: S3BackupTargetUpdate): S3BackupTarget {
    const current = this.requireTargetRow(targetId);
    const accessKey = input.accessKeyId === undefined ? encryptedSecret(current, "access_key") : this.vault.encrypt(input.accessKeyId);
    const secretKey = input.secretAccessKey === undefined ? encryptedSecret(current, "secret_key") : this.vault.encrypt(input.secretAccessKey);
    const timestamp = this.now().toISOString();
    this.database.transaction(() => {
      this.database.run(
        `UPDATE s3_backup_targets SET
          name = ?, endpoint = ?, region = ?, bucket = ?, base_path = ?,
          access_key_encrypted = ?, access_key_iv = ?, access_key_tag = ?,
          secret_key_encrypted = ?, secret_key_iv = ?, secret_key_tag = ?,
          force_path_style = ?, enabled = ?, backup_images = ?, schedule_time = ?, retention_count = ?, updated_at = ?
         WHERE id = ?`,
        input.name?.trim() ?? requiredString(current, "name"),
        input.endpoint === undefined ? requiredString(current, "endpoint") : normalizedEndpoint(input.endpoint),
        input.region?.trim() ?? requiredString(current, "region"),
        input.bucket?.trim() ?? requiredString(current, "bucket"),
        input.basePath === undefined ? requiredString(current, "base_path") : normalizeS3BasePath(input.basePath),
        accessKey.encrypted,
        accessKey.iv,
        accessKey.tag,
        secretKey.encrypted,
        secretKey.iv,
        secretKey.tag,
        input.forcePathStyle === undefined ? Number(current.force_path_style) : input.forcePathStyle ? 1 : 0,
        input.enabled === undefined ? Number(current.enabled) : input.enabled ? 1 : 0,
        input.backupImages === undefined ? Number(current.backup_images) : input.backupImages ? 1 : 0,
        input.scheduleTime ?? requiredString(current, "schedule_time"),
        input.retentionCount ?? Number(current.retention_count),
        timestamp,
        targetId
      );
      this.store.audit(PLATFORM_AI_WORK_ID, "platform.backup-target.updated", "s3-backup-target", targetId, {
        fields: Object.keys(input).filter((key) => key !== "accessKeyId" && key !== "secretAccessKey"),
        credentialsUpdated: input.accessKeyId !== undefined || input.secretAccessKey !== undefined
      });
    });
    return this.getTarget(targetId);
  }

  deleteTarget(targetId: string): void {
    const current = this.requireTargetRow(targetId);
    this.database.transaction(() => {
      this.database.run("DELETE FROM s3_backup_targets WHERE id = ?", targetId);
      this.store.audit(PLATFORM_AI_WORK_ID, "platform.backup-target.deleted", "s3-backup-target", targetId, {
        name: requiredString(current, "name"),
        endpoint: requiredString(current, "endpoint"),
        bucket: requiredString(current, "bucket"),
        basePath: requiredString(current, "base_path")
      });
    });
  }

  getRun(runId: string): S3BackupRun {
    const row = this.database.get("SELECT rowid AS sequence, * FROM s3_backup_runs WHERE id = ?", runId);
    if (!row) throw new AppError(404, "BACKUP_RUN_NOT_FOUND", "S3 备份记录不存在");
    return this.mapRun(row);
  }

  listRuns(options: { afterSequence?: number; limit?: number } = {}): { items: S3BackupRun[]; latestSequence: number } {
    const limit = Math.min(100, Math.max(1, options.limit ?? 30));
    const rows = options.afterSequence === undefined
      ? this.database.all("SELECT rowid AS sequence, * FROM s3_backup_runs ORDER BY rowid DESC LIMIT ?", limit)
      : this.database.all(
        "SELECT rowid AS sequence, * FROM s3_backup_runs WHERE rowid > ? ORDER BY rowid LIMIT ?",
        options.afterSequence,
        limit
      );
    const latestSequence = Number(this.database.get("SELECT COALESCE(MAX(rowid), 0) AS value FROM s3_backup_runs")?.value ?? 0);
    return { items: rows.map((row) => this.mapRun(row)), latestSequence };
  }

  enabledTargetIds(): string[] {
    return this.database.all<{ id: string }>(
      "SELECT id FROM s3_backup_targets WHERE enabled = 1 ORDER BY sort_order, created_at, id"
    ).map((row) => String(row.id));
  }

  enqueueTargets(targetIds: readonly string[], trigger: S3BackupTrigger): S3BackupQueueReceipt {
    if (this.disposed) throw new AppError(503, "BACKUP_MANAGER_STOPPED", "S3 备份服务正在停止");
    const uniqueIds = [...new Set(targetIds)];
    const targetRows = uniqueIds.map((targetId) => this.requireTargetRow(targetId));
    const disabledTargetIds = trigger === "manual"
      ? targetRows.filter((row) => Number(row.enabled) !== 1).map((row) => requiredString(row, "id"))
      : [];
    if (disabledTargetIds.length > 0) {
      throw new AppError(400, "BACKUP_TARGET_DISABLED", "停用的 S3 备份目标不能手动执行", { targetIds: disabledTargetIds });
    }
    const acceptedTargetIds = uniqueIds.filter((targetId) => !this.queuedTargetIds.has(targetId));
    const skippedTargetIds = uniqueIds.filter((targetId) => this.queuedTargetIds.has(targetId));
    for (const targetId of acceptedTargetIds) this.queuedTargetIds.add(targetId);
    if (acceptedTargetIds.length) {
      const execute = async (): Promise<void> => {
        for (const targetId of acceptedTargetIds) {
          try {
            if (!this.disposed) await this.runTarget(targetId, trigger);
          } catch (error) {
            this.log.error("backup.queue.target_failed", { targetId, trigger, error: sanitizeError(error) });
          } finally {
            this.queuedTargetIds.delete(targetId);
          }
        }
      };
      this.executionChain = this.executionChain.then(execute, execute).catch((error: unknown) => {
        this.log.error("backup.queue.failed", { trigger, error: sanitizeError(error) });
      });
    }
    return { acceptedTargetIds, skippedTargetIds };
  }

  enqueueEnabledTargets(trigger: S3BackupTrigger): S3BackupQueueReceipt {
    return this.enqueueTargets(this.enabledTargetIds(), trigger);
  }

  enqueueDueTargets(value = this.now()): S3BackupQueueReceipt {
    const currentTime = `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
    const dateKey = this.localDateKey(value);
    const dueTargetIds = this.database.all(
      `SELECT target.id, target.schedule_time,
        (SELECT run.started_at FROM s3_backup_runs run
         WHERE run.target_id = target.id AND run.trigger = 'scheduled'
         ORDER BY run.rowid DESC LIMIT 1) AS last_scheduled_at
       FROM s3_backup_targets target
       WHERE target.enabled = 1
       ORDER BY target.sort_order, target.created_at, target.id`
    ).filter((row) => {
      if (requiredString(row, "schedule_time") > currentTime) return false;
      const lastScheduledAt = nullableString(row, "last_scheduled_at");
      return !lastScheduledAt || this.localDateKey(new Date(lastScheduledAt)) !== dateKey;
    }).map((row) => requiredString(row, "id"));
    return this.enqueueTargets(dueTargetIds, "scheduled");
  }

  startScheduler(): void {
    if (this.schedulerTimer || this.disposed) return;
    const poll = (): void => {
      try {
        this.enqueueDueTargets();
      } catch (error) {
        this.log.error("backup.scheduler.poll_failed", { error: sanitizeError(error) });
      }
    };
    poll();
    this.schedulerTimer = setInterval(poll, 30_000);
    this.schedulerTimer.unref();
  }

  async waitForIdle(timeoutMs?: number): Promise<void> {
    const executionChain = this.executionChain;
    if (timeoutMs === undefined) {
      await executionChain;
      return;
    }
    const normalizedTimeoutMs = Math.floor(timeoutMs);
    if (!Number.isFinite(timeoutMs) || normalizedTimeoutMs < 1) {
      throw new RangeError("S3 backup idle timeout must be a positive finite number");
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AppError(
        504,
        "BACKUP_IDLE_TIMEOUT",
        `等待 S3 备份执行链结束超时（${normalizedTimeoutMs} 毫秒）`
      )), normalizedTimeoutMs);
    });
    try {
      await Promise.race([executionChain, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.pendingBackupEncryption = null;
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
    this.schedulerTimer = null;
  }

  async runEnabledTargets(trigger: S3BackupTrigger): Promise<S3BackupRun[]> {
    const targetIds = this.database.all<{ id: string }>(
      "SELECT id FROM s3_backup_targets WHERE enabled = 1 ORDER BY sort_order, created_at, id"
    ).map((row) => String(row.id));
    const runs: S3BackupRun[] = [];
    for (const targetId of targetIds) runs.push(await this.runTarget(targetId, trigger));
    return runs;
  }

  async runTarget(targetId: string, trigger: S3BackupTrigger): Promise<S3BackupRun> {
    const targetRow = this.requireTargetRow(targetId);
    const target = this.runtimeTarget(targetRow);
    const runId = randomUUID();
    const started = this.now();
    const startedAt = started.toISOString();
    this.database.transaction(() => {
      this.database.run(
        `INSERT INTO s3_backup_runs (id, target_id, target_name, trigger, status, started_at)
         VALUES (?, ?, ?, ?, 'running', ?)`,
        runId,
        target.id,
        target.name,
        trigger,
        startedAt
      );
      this.database.run(
        "UPDATE s3_backup_targets SET last_started_at = ?, last_error = NULL, updated_at = ? WHERE id = ?",
        startedAt,
        startedAt,
        target.id
      );
    });

    let client: S3ObjectClient | null = null;
    let databaseKey: string | null = null;
    let imagesUploaded = 0;
    let imagesSkipped = 0;
    let databasesDeleted = 0;
    let encryptionKey: string | null = null;
    try {
      encryptionKey = this.activeBackupEncryptionKey();
      const resolvedAddresses = await this.validateEndpoint?.(target.endpoint);
      client = this.clientFactory({
        endpoint: target.endpoint,
        region: target.region,
        accessKeyId: target.accessKeyId,
        secretAccessKey: target.secretAccessKey,
        forcePathStyle: target.forcePathStyle,
        ...(resolvedAddresses?.length ? { resolvedAddresses } : {})
      });
      const databaseSnapshot = await this.snapshotDatabase();
      databaseKey = `${target.rootPrefix}/db/scriverse-${this.snapshotTimestamp(started)}-${runId.replaceAll("-", "").slice(0, 8)}.db`;
      if (!this.masterKey) throw new AppError(500, "BACKUP_MASTER_KEY_UNAVAILABLE", "S3 备份缺少 CredentialVault 恢复密钥");
      const masterKeyBody = encryptionKey ? encryptObject(this.masterKey, encryptionKey) : this.masterKey;
      await this.withRequestTimeout(client.putObject({
        bucket: target.bucket,
        key: `${target.rootPrefix}/master.key`,
        body: masterKeyBody,
        contentType: "application/octet-stream"
      }), "上传 CredentialVault 恢复密钥");
      const databaseBody = encryptionKey ? encryptObject(databaseSnapshot, encryptionKey) : databaseSnapshot;
      await this.withRequestTimeout(client.putObject({
        bucket: target.bucket,
        key: databaseKey,
        body: databaseBody,
        contentType: encryptionKey ? "application/octet-stream" : "application/vnd.sqlite3"
      }), "上传数据库快照");

      if (target.backupImages) {
        for (const source of this.backupImageSources(target.rootPrefix)) {
          if (await this.withRequestTimeout(client.objectExists(target.bucket, source.objectKey), "检查远端图片")) {
            imagesSkipped += 1;
            continue;
          }
          const body = await source.read();
          const uploadBody = encryptionKey ? encryptObject(body, encryptionKey) : body;
          await this.withRequestTimeout(client.putObject({
            bucket: target.bucket,
            key: source.objectKey,
            body: uploadBody,
            contentType: encryptionKey ? "application/octet-stream" : source.contentType,
            metadata: { sha256: source.sha256 }
          }), "上传图片");
          imagesUploaded += 1;
        }
      }
      databasesDeleted = await this.enforceDatabaseRetention(client, target);

      const finishedAt = this.now().toISOString();
      this.database.transaction(() => {
        this.database.run(
          `UPDATE s3_backup_runs SET status = 'succeeded', database_key = ?, images_uploaded = ?, images_skipped = ?,
           databases_deleted = ?, finished_at = ? WHERE id = ?`,
          databaseKey,
          imagesUploaded,
          imagesSkipped,
          databasesDeleted,
          finishedAt,
          runId
        );
        this.database.run(
          "UPDATE s3_backup_targets SET last_success_at = ?, last_error = NULL, updated_at = ? WHERE id = ?",
          finishedAt,
          finishedAt,
          target.id
        );
        this.store.audit(PLATFORM_AI_WORK_ID, "platform.backup.succeeded", "s3-backup-target", target.id, {
          runId,
          trigger,
          databaseKey,
          imagesUploaded,
          imagesSkipped,
          databasesDeleted
        });
      });
      this.log.info("backup.s3_target.succeeded", {
        target: this.targetForLog(target),
        runId,
        trigger,
        databaseKey,
        imagesUploaded,
        imagesSkipped,
        databasesDeleted
      });
    } catch (error) {
      const serverResponse = s3FailureServerResponse(error, [
        target.accessKeyId,
        target.secretAccessKey,
        ...(encryptionKey ? [encryptionKey] : [])
      ]);
      const errorMessage = typeof serverResponse.message === "string" ? serverResponse.message : "S3 备份失败";
      const finishedAt = this.now().toISOString();
      this.database.transaction(() => {
        this.database.run(
          `UPDATE s3_backup_runs SET status = 'failed', database_key = ?, images_uploaded = ?, images_skipped = ?,
           databases_deleted = ?, error_message = ?, server_response_json = ?, finished_at = ? WHERE id = ?`,
          databaseKey,
          imagesUploaded,
          imagesSkipped,
          databasesDeleted,
          errorMessage,
          JSON.stringify(serverResponse),
          finishedAt,
          runId
        );
        this.database.run(
          "UPDATE s3_backup_targets SET last_failure_at = ?, last_error = ?, updated_at = ? WHERE id = ?",
          finishedAt,
          errorMessage,
          finishedAt,
          target.id
        );
        this.store.audit(PLATFORM_AI_WORK_ID, "platform.backup.failed", "s3-backup-target", target.id, {
          runId,
          trigger,
          databaseKey,
          errorMessage
        });
      });
      this.log.error("backup.s3_target.failed", {
        target: this.targetForLog(target),
        runId,
        trigger,
        databaseKey,
        error: sanitizeError(new Error(errorMessage)),
        serverResponse
      });
    } finally {
      try {
        client?.close();
      } catch (error) {
        this.log.warn("backup.s3_client.close_failed", {
          target: this.targetForLog(target),
          runId,
          error: sanitizeError(error)
        });
      }
    }
    return this.getRun(runId);
  }

  private requireTargetRow(targetId: string): Row {
    const row = this.database.get("SELECT * FROM s3_backup_targets WHERE id = ?", targetId);
    if (!row) throw new AppError(404, "BACKUP_TARGET_NOT_FOUND", "S3 备份目标不存在");
    return row;
  }

  private hasBackupEncryptionKey(row: Row): boolean {
    return typeof row.kek_encrypted === "string"
      && typeof row.kek_iv === "string"
      && typeof row.kek_tag === "string";
  }

  private activeBackupEncryptionKey(): string | null {
    const row = this.database.get("SELECT * FROM s3_backup_encryption WHERE id = 1");
    if (!row || Number(row.enabled) !== 1) return null;
    if (!this.hasBackupEncryptionKey(row)) {
      throw new AppError(500, "BACKUP_ENCRYPTION_STATE_INVALID", "S3 备份加密配置缺少密钥");
    }
    try {
      return this.vault.decrypt({
        encrypted: requiredString(row, "kek_encrypted"),
        iv: requiredString(row, "kek_iv"),
        tag: requiredString(row, "kek_tag")
      });
    } catch {
      throw new AppError(500, "BACKUP_ENCRYPTION_KEY_UNAVAILABLE", "S3 备份加密密钥无法读取");
    }
  }

  private runtimeTarget(row: Row): RuntimeTarget {
    return {
      ...this.mapTarget(row),
      accessKeyId: this.vault.decrypt(encryptedSecret(row, "access_key")),
      secretAccessKey: this.vault.decrypt(encryptedSecret(row, "secret_key"))
    };
  }

  private mapRun(row: Row): S3BackupRun {
    let serverResponse: Record<string, unknown> | null = null;
    const responseJson = nullableString(row, "server_response_json");
    if (responseJson) {
      try {
        const parsed = JSON.parse(responseJson) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) serverResponse = parsed as Record<string, unknown>;
      } catch {
        serverResponse = { message: "S3 服务返回结果无法解析" };
      }
    }
    const status = requiredString(row, "status");
    const trigger = requiredString(row, "trigger");
    if (status !== "running" && status !== "succeeded" && status !== "failed") {
      throw new AppError(500, "BACKUP_RUN_INVALID", "S3 备份记录状态无效");
    }
    if (trigger !== "manual" && trigger !== "scheduled") {
      throw new AppError(500, "BACKUP_RUN_INVALID", "S3 备份触发类型无效");
    }
    return {
      sequence: Number(row.sequence),
      id: requiredString(row, "id"),
      targetId: nullableString(row, "target_id"),
      targetName: requiredString(row, "target_name"),
      trigger,
      status,
      databaseKey: nullableString(row, "database_key"),
      imagesUploaded: Number(row.images_uploaded),
      imagesSkipped: Number(row.images_skipped),
      databasesDeleted: Number(row.databases_deleted),
      errorMessage: nullableString(row, "error_message"),
      serverResponse,
      startedAt: requiredString(row, "started_at"),
      finishedAt: nullableString(row, "finished_at")
    };
  }

  private backupImageSources(rootPrefix: string): BackupImageSource[] {
    const sources = new Map<string, BackupImageSource>();
    const databaseLocations: readonly DatabaseImageLocation[] = [
      { table: "work_covers", idColumn: "work_id", label: "作品封面" },
      { table: "user_avatars", idColumn: "user_id", label: "用户头像" }
    ];
    for (const location of databaseLocations) {
      for (const row of this.database.all(
        `SELECT ${location.idColumn} AS source_id, mime_type, byte_length, sha256
         FROM ${location.table} ORDER BY sha256`
      )) {
        const metadata = this.databaseImageMetadata(row, location.label);
        const objectKey = `${rootPrefix}/img/${metadata.sha256.slice(0, 2)}/${metadata.sha256}.${this.imageExtension(metadata.contentType)}`;
        sources.set(objectKey, {
          objectKey,
          contentType: metadata.contentType,
          sha256: metadata.sha256,
          read: async () => this.readDatabaseImage(location, metadata)
        });
      }
    }
    for (const row of this.database.all(
      "SELECT DISTINCT storage_key, stored_mime_type, stored_sha256 FROM attachments ORDER BY storage_key"
    )) {
      const storageKey = requiredString(row, "storage_key");
      const contentType = requiredString(row, "stored_mime_type");
      const sha256 = requiredString(row, "stored_sha256");
      const objectKey = `${rootPrefix}/img/${storageKey}`;
      if (!sources.has(objectKey)) {
        sources.set(objectKey, {
          objectKey,
          contentType,
          sha256,
          read: () => this.attachmentStorage.read(storageKey)
        });
      }
    }
    const characterAvatarStorage = this.characterAvatarStorage;
    for (const row of this.database.all(
      `SELECT storage_key, mime_type, sha256 FROM character_avatars
       UNION
       SELECT storage_key, mime_type, sha256 FROM im_avatar_versions
       WHERE participant_kind = 'character' AND storage_key IS NOT NULL AND storage_key <> ''
       ORDER BY storage_key`
    )) {
      const storageKey = requiredString(row, "storage_key");
      const contentType = requiredString(row, "mime_type");
      const sha256 = requiredString(row, "sha256");
      const objectKey = `${rootPrefix}/img/character-avatars/${storageKey}`;
      if (!sources.has(objectKey)) {
        sources.set(objectKey, {
          objectKey,
          contentType,
          sha256,
          read: async () => {
            if (!characterAvatarStorage) throw new AppError(500, "BACKUP_CHARACTER_AVATAR_STORAGE_UNAVAILABLE", "角色头像存储不可用");
            return characterAvatarStorage.read(storageKey);
          }
        });
      }
    }
    return [...sources.values()];
  }

  private databaseImageMetadata(row: Row, label: DatabaseImageLocation["label"]): DatabaseImageMetadata {
    const sourceId = row.source_id;
    const contentType = row.mime_type;
    const sha256 = row.sha256;
    const byteLength = Number(row.byte_length);
    if (typeof sourceId !== "string" || typeof contentType !== "string" || typeof sha256 !== "string"
      || !Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new AppError(500, "BACKUP_IMAGE_METADATA_INVALID", `待备份${label}元数据无效`);
    }
    return { sourceId, contentType, byteLength, sha256 };
  }

  private readDatabaseImage(location: DatabaseImageLocation, expected: DatabaseImageMetadata): Buffer {
    const row = this.database.get(
      `SELECT ${location.idColumn} AS source_id, mime_type, content, byte_length, sha256
       FROM ${location.table} WHERE ${location.idColumn} = ?`,
      expected.sourceId
    );
    if (!row) {
      throw new AppError(409, "BACKUP_IMAGE_SOURCE_MISSING", `待备份${location.label}在上传前已被删除，请重新执行备份`);
    }
    const current = this.databaseImageMetadata(row, location.label);
    if (current.contentType !== expected.contentType || current.byteLength !== expected.byteLength || current.sha256 !== expected.sha256) {
      throw new AppError(409, "BACKUP_IMAGE_SOURCE_CHANGED", `待备份${location.label}在上传前已被替换，请重新执行备份`);
    }
    if (!(row.content instanceof Uint8Array)) {
      throw new AppError(500, "BACKUP_IMAGE_CONTENT_INVALID", `待备份${location.label}内容校验失败，请检查数据库完整性`);
    }
    const content = Buffer.from(row.content);
    const actualSha256 = createHash("sha256").update(content).digest("hex");
    if (content.byteLength !== expected.byteLength || actualSha256 !== expected.sha256) {
      throw new AppError(500, "BACKUP_IMAGE_CONTENT_INVALID", `待备份${location.label}内容校验失败，请检查数据库完整性`);
    }
    return content;
  }

  private async enforceDatabaseRetention(client: S3ObjectClient, target: RuntimeTarget): Promise<number> {
    const prefix = `${target.rootPrefix}/db/`;
    const snapshotNamePattern = /^scriverse-\d{8}T\d{9}Z-[0-9a-f]{8}\.db$/u;
    const backups = (await this.withRequestTimeout(client.listObjects(target.bucket, prefix), "列出数据库快照"))
      .filter((item) => item.key.startsWith(prefix) && snapshotNamePattern.test(item.key.slice(prefix.length)))
      .sort((left, right) => {
        const timestampDelta = (left.lastModified?.getTime() ?? 0) - (right.lastModified?.getTime() ?? 0);
        return timestampDelta || left.key.localeCompare(right.key, "en");
      });
    const excessCount = Math.max(0, backups.length - target.retentionCount);
    const keys = backups.slice(0, excessCount).map((item) => item.key);
    if (keys.length) await this.withRequestTimeout(client.deleteObjects(target.bucket, keys), "清理过期数据库快照");
    return keys.length;
  }

  private async withRequestTimeout<T>(operation: Promise<T>, action: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AppError(504, "S3_REQUEST_TIMEOUT", `${action}超时`)), this.requestTimeoutMs);
    });
    try {
      return await Promise.race([operation, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private imageExtension(contentType: string): string {
    if (contentType === "image/jpeg") return "jpg";
    if (contentType === "image/png") return "png";
    if (contentType === "image/webp") return "webp";
    if (contentType === "image/gif") return "gif";
    throw new AppError(500, "BACKUP_IMAGE_TYPE_INVALID", "待备份图片的类型无效");
  }

  private snapshotTimestamp(value: Date): string {
    return value.toISOString().replace(/[-:.]/gu, "");
  }

  private localDateKey(value: Date): string {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }

  private targetForLog(target: RuntimeTarget): S3BackupTarget {
    const { accessKeyId: _accessKeyId, secretAccessKey: _secretAccessKey, ...safeTarget } = target;
    return safeTarget;
  }

  private mapTarget(row: Row): S3BackupTarget {
    const basePath = requiredString(row, "base_path");
    return {
      id: requiredString(row, "id"),
      name: requiredString(row, "name"),
      endpoint: requiredString(row, "endpoint"),
      region: requiredString(row, "region"),
      bucket: requiredString(row, "bucket"),
      basePath,
      rootPrefix: s3BackupRootPrefix(basePath),
      forcePathStyle: Number(row.force_path_style) === 1,
      enabled: Number(row.enabled) === 1,
      backupImages: Number(row.backup_images) === 1,
      scheduleTime: requiredString(row, "schedule_time"),
      retentionCount: Number(row.retention_count),
      sortOrder: Number(row.sort_order),
      credentialsConfigured: true,
      lastStartedAt: nullableString(row, "last_started_at"),
      lastSuccessAt: nullableString(row, "last_success_at"),
      lastFailureAt: nullableString(row, "last_failure_at"),
      lastError: nullableString(row, "last_error"),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at")
    };
  }

  private sanitizedInput(input: S3BackupTargetInput): Record<string, unknown> {
    return {
      name: input.name.trim(),
      endpoint: normalizedEndpoint(input.endpoint),
      region: input.region?.trim() || "us-east-1",
      bucket: input.bucket.trim(),
      basePath: normalizeS3BasePath(input.basePath),
      forcePathStyle: input.forcePathStyle !== false,
      enabled: input.enabled === true,
      backupImages: input.backupImages !== false,
      scheduleTime: input.scheduleTime ?? "03:00",
      retentionCount: input.retentionCount ?? 7
    };
  }
}
