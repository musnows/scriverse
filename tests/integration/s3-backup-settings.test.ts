import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";
import { nextS3RunAt, s3Root } from "../../src/s3-backup-settings.js";

const target = {
  id: "372ca2db-8fd4-4f37-9911-39567f716e6e", name: "Primary", endpoint: "https://s3.example.com",
  region: "us-east-1", bucket: "backup-test", prefix: "/小说//副本/", forcePathStyle: true,
  enabled: true, includeImages: true, scheduleEnabled: true, scheduleTime: "03:30", retentionCount: 7,
  accessKeyId: "test-access-key", secretAccessKey: "test-secret-key"
};
let runtime: Runtime;
afterEach(() => runtime?.close());
function start(auth = false) {
  runtime = createRuntime({ databasePath: ":memory:", masterSecret: "s3-backup-test-master-secret-32-characters", disableUserAuth: !auth, serveUi: false });
  return runtime;
}

describe("S3 backup settings", () => {
  it("migrates without touching work data and stores credentials encrypted", async () => {
    start();
    const work = runtime.store.createWork({ title: "Keep this work" });
    const saved = await request(runtime.app).put("/api/platform/s3-backup").send({ revision: 0, targets: [target] }).expect(200);
    expect(saved.body.data.targets[0]).toMatchObject({ prefix: "小说/副本", hasCredentials: true, retentionCount: 7 });
    expect(JSON.stringify(saved.body)).not.toContain(target.accessKeyId);
    expect(JSON.stringify(saved.body)).not.toContain(target.secretAccessKey);
    const stored = String(runtime.database.get("SELECT targets_json FROM platform_s3_backup")?.targets_json);
    expect(stored).not.toContain(target.secretAccessKey);
    expect(stored).not.toContain(target.accessKeyId);
    expect(runtime.s3BackupSettings.credentials(runtime.s3BackupSettings.read().targets[0]!)).toEqual({ accessKeyId: target.accessKeyId, secretAccessKey: target.secretAccessKey });
    expect(runtime.database.get("SELECT title FROM works WHERE id = ?", String(work.id))?.title).toBe("Keep this work");
    expect(runtime.database.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
    expect(s3Root(saved.body.data.targets[0])).toBe("小说/副本/scriverse");
    expect(s3Root({ prefix: "" })).toBe("scriverse");
  });

  it("preserves keys on edit and rejects stale or invalid configurations", async () => {
    start();
    await request(runtime.app).put("/api/platform/s3-backup").send({ revision: 0, targets: [target] }).expect(200);
    const edited = { ...target, name: "Updated", accessKeyId: "", secretAccessKey: "" };
    await request(runtime.app).put("/api/platform/s3-backup").send({ revision: 1, targets: [edited] }).expect(200);
    expect(runtime.s3BackupSettings.credentials(runtime.s3BackupSettings.read().targets[0]!).accessKeyId).toBe(target.accessKeyId);
    await request(runtime.app).put("/api/platform/s3-backup").send({ revision: 1, targets: [] }).expect(409);
    for (const change of [{ retentionCount: 0 }, { retentionCount: 1001 }, { prefix: "../escape" }, { endpoint: "https://ak:sk@example.com" }, { endpoint: "file:///etc/hosts" }, { endpoint: "https://example.com?ak=secret" }, { scheduleTime: "25:00" }, { accessKeyId: "" }, { unexpected: true }]) {
      await request(runtime.app).put("/api/platform/s3-backup").send({ revision: 2, targets: [{ ...target, ...change }] }).expect(400);
    }
    await request(runtime.app).put("/api/platform/s3-backup").send({ revision: 2, targets: [target, target] }).expect(400);
  });

  it("requires an administrator session and CSRF for writes", async () => {
    start(true);
    const admin = runtime.auth.register({ username: "admin", password: "a-safe-password-123" });
    const user = runtime.auth.register({ username: "reader", password: "a-safe-password-123" });
    await request(runtime.app).get("/api/platform/s3-backup").expect(401);
    await request(runtime.app).get("/api/platform/s3-backup").set("Cookie", `scriverse_session=${user.token}`).expect(403);
    await request(runtime.app).get("/api/platform/s3-backup").set("Authorization", `Bearer ${runtime.auth.resetApiKey(admin.session.user.userId).apiKey}`).expect(403);
    await request(runtime.app).put("/api/platform/s3-backup").set("Cookie", `scriverse_session=${admin.token}`).send({ revision: 0, targets: [target] }).expect(403);
    await request(runtime.app).put("/api/platform/s3-backup").set("Cookie", `scriverse_session=${admin.token}`).set("X-CSRF-Token", admin.session.csrfToken).send({ revision: 0, targets: [target] }).expect(200);
  });

  it("calculates the next daily trigger using the server local clock", () => {
    start();
    const now = new Date(2026, 8, 5, 10, 0);
    expect(new Date(nextS3RunAt("11:30", now)).getHours()).toBe(11);
    expect(new Date(nextS3RunAt("09:30", now)).getDate()).toBe(6);
    expect(new Date(nextS3RunAt("10:00", now)).getDate()).toBe(6);
  });
});
