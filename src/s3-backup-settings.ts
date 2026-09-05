import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database } from "./database.js";
import { CredentialVault, type EncryptedSecret } from "./credential-vault.js";
import { AppError } from "./errors.js";
import type { Store } from "./store.js";

export const s3TargetSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(100),
  endpoint: z.url().max(2048).transform((value) => value.replace(/\/+$/u, "")).refine((value) => {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  }, "服务地址必须为不含凭据、查询参数或片段的 HTTP(S) 地址"),
  region: z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9-]+$/u),
  bucket: z.string().trim().min(3).max(63).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*[a-zA-Z0-9]$/u),
  prefix: z.string().trim().max(500).refine((value) => !/[\\\u0000-\u001f\u007f]/u.test(value)
    && !value.split("/").some((part) => part === "." || part === "..") && Buffer.byteLength(value) <= 700,
  "子目录不能包含路径跳转或控制字符").transform((value) => value.split("/").filter(Boolean).join("/")),
  forcePathStyle: z.boolean(),
  enabled: z.boolean(),
  includeImages: z.boolean(),
  scheduleEnabled: z.boolean(),
  scheduleTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u),
  retentionCount: z.number().int().min(1).max(1000),
  accessKeyId: z.string().trim().max(256).optional(),
  secretAccessKey: z.string().trim().max(512).optional()
}).strict().refine((value) => Boolean(value.accessKeyId) === Boolean(value.secretAccessKey), "AK 和 SK 必须同时填写；编辑时均留空可保留原凭据");

export const s3SettingsSchema = z.object({
  revision: z.number().int().min(0),
  targets: z.array(s3TargetSchema).max(20)
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  const destinations = new Set<string>();
  for (const [index, target] of value.targets.entries()) {
    const destination = `${target.endpoint}/${target.bucket}/${target.prefix}`;
    if (ids.has(target.id) || destinations.has(destination)) {
      context.addIssue({ code: "custom", path: ["targets", index], message: "备份目标 ID 或存储路径重复" });
    }
    ids.add(target.id);
    destinations.add(destination);
  }
});

export type S3TargetInput = z.infer<typeof s3TargetSchema>;
export type S3Target = Omit<S3TargetInput, "accessKeyId" | "secretAccessKey"> & {
  credentials: EncryptedSecret;
  nextRunAt: string | null;
};
export type S3TargetPublic = Omit<S3Target, "credentials"> & { hasCredentials: boolean };
export type S3BackupResult = {
  id: string;
  targetId: string;
  targetName: string;
  trigger: "manual" | "scheduled";
  status: "success" | "error";
  completedAt: string;
  databaseKey?: string;
  uploadedImages?: number;
  skippedImages?: number;
  deletedDatabases?: number;
  message: string;
};

export function s3Root(target: Pick<S3Target, "prefix">): string {
  return `${target.prefix ? `${target.prefix}/` : ""}scriverse`;
}

export function nextS3RunAt(time: string, now: Date): string {
  const [hours, minutes] = time.split(":").map(Number);
  const next = new Date(now);
  next.setHours(hours!, minutes!, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

export function publicS3Target(target: S3Target): S3TargetPublic {
  const { credentials, ...configuration } = target;
  return { ...configuration, hasCredentials: Boolean(credentials) };
}

export class S3BackupSettings {
  constructor(private readonly db: Database, private readonly vault: CredentialVault, private readonly store: Store) {}

  read(): { revision: number; targets: S3Target[]; events: S3BackupResult[] } {
    const row = this.db.get("SELECT * FROM platform_s3_backup WHERE id = 1")!;
    return { revision: Number(row.revision), targets: JSON.parse(String(row.targets_json)) as S3Target[], events: JSON.parse(String(row.events_json)) as S3BackupResult[] };
  }

  publicSettings() {
    const { revision, targets, events } = this.read();
    return { revision, targets: targets.map(publicS3Target), events, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  }

  save(input: z.infer<typeof s3SettingsSchema>, now = new Date()): void {
    this.db.transaction(() => {
      const previous = this.read();
      if (input.revision !== previous.revision) throw new AppError(409, "S3_SETTINGS_CONFLICT", "备份配置已被其他管理员修改，请刷新后重试");
      const targets = input.targets.map((inputTarget): S3Target => {
        const old = previous.targets.find((target) => target.id === inputTarget.id);
        const { accessKeyId, secretAccessKey, ...configuration } = inputTarget;
        const credentials = accessKeyId && secretAccessKey
          ? this.vault.encrypt(JSON.stringify({ accessKeyId, secretAccessKey })) : old?.credentials;
        if (!credentials) throw new AppError(400, "S3_CREDENTIALS_REQUIRED", `请填写“${inputTarget.name}”的 AK 和 SK`);
        const sameSchedule = old?.enabled && old.scheduleEnabled && old.scheduleTime === inputTarget.scheduleTime;
        return { ...configuration, credentials, nextRunAt: inputTarget.enabled && inputTarget.scheduleEnabled
          ? (sameSchedule && old.nextRunAt ? old.nextRunAt : nextS3RunAt(inputTarget.scheduleTime, now)) : null };
      });
      this.db.run("UPDATE platform_s3_backup SET targets_json = ?, revision = revision + 1 WHERE id = 1", JSON.stringify(targets));
      this.store.audit(null, "s3-backup.settings-updated", "system", "s3-backup", { targetIds: targets.map((target) => target.id) });
    });
  }

  credentials(target: S3Target): { accessKeyId: string; secretAccessKey: string } {
    return z.object({ accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1) }).strict().parse(JSON.parse(this.vault.decrypt(target.credentials)));
  }

  claimScheduled(targetIds: string[], now: Date): void {
    const { targets } = this.read();
    for (const target of targets) {
      if (targetIds.includes(target.id)) target.nextRunAt = nextS3RunAt(target.scheduleTime, now);
    }
    this.db.run("UPDATE platform_s3_backup SET targets_json = ? WHERE id = 1", JSON.stringify(targets));
  }

  record(result: Omit<S3BackupResult, "id" | "completedAt">): S3BackupResult {
    const event = { ...result, id: randomUUID(), completedAt: new Date().toISOString() };
    const { events } = this.read();
    this.db.run("UPDATE platform_s3_backup SET events_json = ? WHERE id = 1", JSON.stringify([...events, event].slice(-100)));
    return event;
  }
}
