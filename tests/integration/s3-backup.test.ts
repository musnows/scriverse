import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";
import { databaseBackupName, retainedDatabaseKeys, type S3BackupOptions } from "../../src/s3-backup.js";
import { s3SettingsSchema } from "../../src/s3-backup-settings.js";
import type { S3StorageClient } from "../../src/s3-client.js";

let runtime: Runtime;
const fixture = join(process.cwd(), ".data", "s3-engine-tests");
const target = {
  id: "372ca2db-8fd4-4f37-9911-39567f716e6e", name: "Primary", endpoint: "https://s3.example.com",
  region: "us-east-1", bucket: "backup-test", prefix: "nested", forcePathStyle: true,
  enabled: true, includeImages: false, scheduleEnabled: true, scheduleTime: "03:30", retentionCount: 2,
  accessKeyId: "engine-access-key", secretAccessKey: "engine-secret-key"
};
afterEach(() => runtime?.close());
function start(options: S3BackupOptions, fileDatabase = false) {
  mkdirSync(fixture, { recursive: true });
  runtime = createRuntime({ databasePath: fileDatabase ? join(fixture, `live-${Date.now()}.db`) : ":memory:", attachmentDirectory: join(fixture, "attachments"), masterSecret: "s3-engine-test-master-secret-32-characters", disableUserAuth: true, serveUi: false, s3Backup: options });
  runtime.s3BackupSettings.save(s3SettingsSchema.parse({ revision: 0, targets: [target] }));
}
function storage(objects = new Map<string, Buffer>()) {
  const client: S3StorageClient = { exists: vi.fn(async (key) => objects.has(key)), upload: vi.fn(async (key, path) => { objects.set(key, readFileSync(path)); }),
    list: vi.fn(async (prefix) => [...objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key }))),
    delete: vi.fn(async (key) => { objects.delete(key); }), close: vi.fn() };
  return { client, objects };
}

describe("S3 backup engine", () => {
  it("uploads an intact WAL snapshot and prunes only owned database snapshots after success", async () => {
    const remote = storage();
    const old = [1, 2, 3].map((day) => `nested/scriverse/db/${databaseBackupName(new Date(2026, 0, day))}`);
    for (const key of [...old, "nested/scriverse/db/manual.db", "nested/scriverse/img/old.webp", "other/scriverse/db/keep.db"]) remote.objects.set(key, Buffer.from("keep"));
    start({ createClient: () => remote.client }, true);
    const work = runtime.store.createWork({ title: "WAL committed work" });
    await request(runtime.app).post("/api/platform/s3-backup/run").send({}).expect(202);
    await runtime.s3Backup.waitForIdle();
    const event = runtime.s3Backup.status().events[0]!;
    expect(event).toMatchObject({ status: "success", deletedDatabases: 2 });
    expect(remote.client.exists).not.toHaveBeenCalled();
    const downloaded = join(fixture, "downloaded.db");
    writeFileSync(downloaded, remote.objects.get(event.databaseKey!)!);
    const restored = new DatabaseSync(downloaded, { readOnly: true });
    try {
      expect(restored.prepare("SELECT title FROM works WHERE id = ?").get(String(work.id))?.title).toBe("WAL committed work");
      expect(restored.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
      expect(restored.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { restored.close(); }
    expect(remote.objects.has(old[2]!)).toBe(true);
    expect(remote.objects.has("nested/scriverse/db/manual.db")).toBe(true);
    expect(remote.objects.has("nested/scriverse/img/old.webp")).toBe(true);
    expect(remote.objects.has("other/scriverse/db/keep.db")).toBe(true);
  });

  it("processes enabled targets sequentially and continues after a failure without deleting old backups", async () => {
    const remote = storage();
    const failed = storage();
    failed.client.upload = vi.fn(async () => { throw new Error(`AccessDenied ${target.secretAccessKey}`); });
    const order: string[] = [];
    start({ createClient: (configuration) => { order.push(configuration.name); return configuration.name === "Primary" ? failed.client : remote.client; } });
    runtime.s3BackupSettings.save(s3SettingsSchema.parse({ revision: 1, targets: [target,
      { ...target, id: "bbba42eb-60ac-46d8-bfe5-ed51f3f88da5", name: "Secondary", bucket: "second-bucket" },
      { ...target, id: "011242eb-60ac-46d8-bfe5-ed51f3f88da5", name: "Disabled", bucket: "disabled-bucket", enabled: false }] }));
    runtime.s3Backup.start();
    await runtime.s3Backup.waitForIdle();
    expect(order).toEqual(["Primary", "Secondary"]);
    expect(failed.client.delete).not.toHaveBeenCalled();
    expect(runtime.s3Backup.status().events.map((event) => event.status)).toEqual(["error", "success"]);
    expect(JSON.stringify(runtime.s3Backup.status())).not.toContain(target.secretAccessKey);
  });

  it("uploads missing images, skips existing images, and preserves snapshot references", async () => {
    const remote = storage();
    start({ createClient: () => remote.client });
    const work = runtime.store.createWork({ title: "Images" });
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2z94AAAAASUVORK5CYII=", "base64");
    await request(runtime.app).post(`/api/works/${work.id}/attachments`).attach("file", png, { filename: "one.png", contentType: "image/png" }).expect(201);
    runtime.s3BackupSettings.save(s3SettingsSchema.parse({ revision: 1, targets: [{ ...target, includeImages: true }] }));
    runtime.s3Backup.start();
    await runtime.s3Backup.waitForIdle();
    expect(runtime.s3Backup.status().events[0]).toMatchObject({ status: "success", uploadedImages: 1, skippedImages: 0 });
    const imageKey = [...remote.objects.keys()].find((key) => key.includes("/img/"))!;
    expect(imageKey).toMatch(/^nested\/scriverse\/img\/[a-f0-9]{2}\/[a-f0-9]{64}\.(png|webp)$/u);
    runtime.s3Backup.start();
    await runtime.s3Backup.waitForIdle();
    expect(runtime.s3Backup.status().events[1]).toMatchObject({ status: "success", uploadedImages: 0, skippedImages: 1 });
    expect(remote.objects.get(imageKey)).toEqual(png);
  });

  it("prevents overlapping jobs and configuration writes, and runs a due schedule once", async () => {
    const remote = storage();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const upload = remote.client.upload;
    remote.client.upload = async (...args) => { await gate; await upload(...args); };
    start({ createClient: () => remote.client });
    runtime.s3Backup.start();
    await request(runtime.app).post("/api/platform/s3-backup/run").send({}).expect(409);
    await request(runtime.app).put("/api/platform/s3-backup").send({ revision: 1, targets: [] }).expect(409);
    release();
    await runtime.s3Backup.waitForIdle();
    const due = new Date(runtime.s3BackupSettings.read().targets[0]!.nextRunAt!);
    runtime.s3Backup.tick(due);
    await runtime.s3Backup.waitForIdle();
    runtime.s3Backup.tick(due);
    expect(runtime.s3Backup.isRunning).toBe(false);
    expect(runtime.s3Backup.status().events.map((event) => event.trigger)).toEqual(["manual", "scheduled"]);
    expect(new Date(runtime.s3BackupSettings.read().targets[0]!.nextRunAt!).getTime()).toBeGreaterThan(due.getTime());
  });

  it("limits retention to strictly named files in the exact database prefix", () => {
    start({ createClient: () => storage().client });
    expect(retainedDatabaseKeys(["db/other.db", `db/nested/${databaseBackupName()}`, `other/${databaseBackupName()}`], "db/", 1)).toEqual([]);
    const first = databaseBackupName();
    const second = databaseBackupName();
    expect(first).not.toBe(second);
  });
});
