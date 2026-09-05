import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Database } from "./database.js";
import type { AttachmentStorage } from "./attachment-storage.js";
import type { Store } from "./store.js";
import { AppError } from "./errors.js";
import { logger, type Logger } from "./logger.js";
import { S3BackupSettings, publicS3Target, s3Root, type S3Target, type S3BackupResult } from "./s3-backup-settings.js";
import { createS3StorageClient, redactS3Text, redactS3Value, type S3StorageClient, type S3Credentials } from "./s3-client.js";

export type S3BackupOptions = {
  allowPrivateEndpoints?: boolean;
  fetchImpl?: typeof fetch;
  log?: Logger;
  createClient?: (target: S3Target, credentials: S3Credentials, signal: AbortSignal) => S3StorageClient;
};
type BackupJob = { id: string; trigger: "manual" | "scheduled"; startedAt: string; targetIds: string[]; currentTargetId: string | null };

export function databaseBackupName(now = new Date()): string {
  return `scriverse-${now.toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}.db`;
}

export function retainedDatabaseKeys(keys: string[], prefix: string, keep: number): string[] {
  const filename = /^scriverse-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9-]{36}\.db$/u;
  return [...new Set(keys)].filter((key) => key.startsWith(prefix) && filename.test(key.slice(prefix.length))).sort().reverse().slice(keep);
}

export class S3BackupManager {
  private timer: ReturnType<typeof setInterval> | undefined;
  private controller = new AbortController();
  private job: BackupJob | null = null;
  private pending: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly log: Logger;

  constructor(private readonly db: Database, private readonly settings: S3BackupSettings,
    private readonly attachments: AttachmentStorage, private readonly store: Store, private readonly options: S3BackupOptions = {}) {
    this.log = options.log ?? logger;
  }

  get isRunning(): boolean { return this.job !== null; }
  status() { return { running: this.job, events: this.settings.read().events }; }
  waitForIdle(): Promise<void> { return this.pending; }

  startScheduler(): void {
    if (this.timer || this.disposed) return;
    this.timer = setInterval(() => {
      try { this.tick(); } catch (error) { this.log.error("s3.backup.scheduler_failed", { error }); }
    }, 15_000);
    this.timer.unref();
  }

  tick(now = new Date()): void {
    if (this.isRunning || this.disposed) return;
    const targets = this.settings.read().targets.filter((target) => target.enabled && target.scheduleEnabled
      && target.nextRunAt && new Date(target.nextRunAt) <= now);
    if (targets.length) this.start("scheduled", targets.map((target) => target.id), now);
  }

  start(trigger: "manual" | "scheduled" = "manual", targetIds?: string[], now = new Date()): BackupJob {
    if (this.disposed) throw new AppError(503, "S3_BACKUP_STOPPING", "备份服务正在停止");
    if (this.isRunning) throw new AppError(409, "S3_BACKUP_BUSY", "已有备份正在执行，请等待完成");
    const targets = this.settings.read().targets.filter((target) => target.enabled && (!targetIds || targetIds.includes(target.id)));
    if (!targets.length) throw new AppError(400, "S3_NO_ENABLED_TARGET", "请先配置并启用至少一个备份目标");
    if (trigger === "scheduled") this.settings.claimScheduled(targets.map((target) => target.id), now);
    const job: BackupJob = { id: randomUUID(), trigger, startedAt: now.toISOString(), targetIds: targets.map((target) => target.id), currentTargetId: null };
    this.controller = new AbortController();
    this.job = job;
    this.store.audit(null, "s3-backup.started", "system", job.id, { trigger, targetIds: job.targetIds });
    this.pending = Promise.resolve().then(() => this.run(targets, job)).catch((error: unknown) => {
      this.log.error("s3.backup.job_failed", { error });
    }).finally(() => { this.job = null; });
    return job;
  }

  private snapshot(): { path: string; images: { storageKey: string; mimeType: string }[] } {
    const directory = join(this.attachments.temporaryDirectory, "s3-backup");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "snapshot.db");
    // 仅重用本功能的临时快照文件；VACUUM INTO 会包含 WAL 中已提交的数据。
    const descriptor = openSync(path, constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    closeSync(descriptor);
    chmodSync(path, 0o600);
    this.db.run("VACUUM main INTO ?", path);
    const snapshot = new DatabaseSync(path, { readOnly: true });
    try {
      const integrity = snapshot.prepare("PRAGMA integrity_check").all();
      if (integrity.some((row) => row.integrity_check !== "ok") || snapshot.prepare("PRAGMA foreign_key_check").all().length) {
        throw new Error("SQLite backup integrity check failed");
      }
      const images = snapshot.prepare("SELECT DISTINCT storage_key, stored_mime_type FROM attachments").all()
        .map((row) => ({ storageKey: String(row.storage_key), mimeType: String(row.stored_mime_type) }));
      return { path, images };
    } finally { snapshot.close(); }
  }

  private recordFailure(target: S3Target, job: BackupJob, error: unknown, credentials?: S3Credentials): void {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = credentials ? redactS3Text(rawMessage, credentials) : "Unable to prepare backup or decrypt S3 credentials";
    const configuration = credentials ? redactS3Value(publicS3Target(target), credentials) : publicS3Target(target);
    this.log.error("s3.backup.target_failed", { target: configuration, jobId: job.id, message });
    if (!this.disposed) this.settings.record({ targetId: target.id, targetName: target.name, trigger: job.trigger, status: "error", message: `备份失败：${message.slice(0, 1500)}` });
  }

  private async run(targets: S3Target[], job: BackupJob): Promise<void> {
    let snapshot: ReturnType<S3BackupManager["snapshot"]>;
    try { snapshot = this.snapshot(); } catch (error) {
      for (const target of targets) this.recordFailure(target, job, error);
      return;
    }
    const filename = databaseBackupName(new Date(job.startedAt));
    for (const target of targets) {
      if (this.disposed) break;
      job.currentTargetId = target.id;
      let client: S3StorageClient | undefined;
      let credentials: S3Credentials | undefined;
      try {
        credentials = this.settings.credentials(target);
        client = this.options.createClient?.(target, credentials, this.controller.signal)
          ?? createS3StorageClient(target, credentials, { ...this.options, signal: this.controller.signal });
        const root = s3Root(target);
        let uploadedImages = 0;
        let skippedImages = 0;
        if (target.includeImages) {
          for (const image of snapshot.images) {
            this.controller.signal.throwIfAborted();
            const key = `${root}/img/${image.storageKey}`;
            if (await client.exists(key)) { skippedImages += 1; continue; }
            await client.upload(key, this.attachments.path(image.storageKey), image.mimeType);
            uploadedImages += 1;
          }
        }
        const databaseKey = `${root}/db/${filename}`;
        await client.upload(databaseKey, snapshot.path, "application/vnd.sqlite3");
        this.controller.signal.throwIfAborted();
        const objects = await client.list(`${root}/db/`);
        if (!objects.some((object) => object.key === databaseKey)) throw new Error("Uploaded database is missing from the S3 listing; retention cleanup was skipped");
        const expired = retainedDatabaseKeys(objects.map((object) => object.key), `${root}/db/`, target.retentionCount);
        let deletedDatabases = 0;
        for (const key of expired) {
          this.controller.signal.throwIfAborted();
          if (key === databaseKey) continue;
          await client.delete(key);
          deletedDatabases += 1;
        }
        const result: Omit<S3BackupResult, "id" | "completedAt"> = { targetId: target.id, targetName: target.name, trigger: job.trigger,
          status: "success", databaseKey, uploadedImages, skippedImages, deletedDatabases, message: `数据库备份成功；图片上传 ${uploadedImages} 张、跳过 ${skippedImages} 张；清理旧快照 ${deletedDatabases} 个` };
        if (!this.disposed) this.settings.record(result);
        this.log.info("s3.backup.target_completed", { targetId: target.id, databaseKey, uploadedImages, skippedImages, deletedDatabases });
      } catch (error) {
        this.recordFailure(target, job, error, credentials);
      } finally { client?.close(); }
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.controller.abort(new Error("S3 backup service is stopping"));
  }
}
