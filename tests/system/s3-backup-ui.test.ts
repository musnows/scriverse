import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";
let runtime: Runtime;
afterEach(() => runtime?.close());
describe("S3 backup settings UI", () => {
  it("serves system settings, accessible controls, and versioned assets", async () => {
    runtime = createRuntime({ databasePath: ":memory:", masterSecret: "s3-ui-system-test-master-secret-32-characters", disableUserAuth: true, serveUi: true });
    const html = await request(runtime.app).get("/").expect(200);
    const module = await request(runtime.app).get("/s3-backup-ui.js?v=20260905-s3-backup-v2").expect(200);
    const app = await request(runtime.app).get("/app.js").expect(200);
    expect(html.text).toContain('id="s3-backup-button" class="settings-hub-card hidden"');
    expect(html.text).toContain('aria-labelledby="s3-backup-title"');
    expect(html.text).toContain('/app.js?v=20260905-s3-backup-v2');
    expect(html.text).toContain('/styles.css?v=20260905-s3-backup-v2');
    expect(module.text).toContain('"/api/platform/s3-backup/status"');
    expect(module.text).toContain('type="password" autocomplete="new-password"');
    expect(module.text).toContain('event.status === "error"');
    expect(app.text).toContain('s3BackupUi.setUser(session.user)');
  });
});
