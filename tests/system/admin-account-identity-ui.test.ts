import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

describe("系统管理员账户标识", () => {
  let runtime: Runtime;

  beforeAll(() => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "admin-account-identity-system-test-secret",
      disableUserAuth: true,
      serveUi: true
    });
  });

  afterAll(() => runtime.close());

  it("在头像区域渲染轻量管理员标识并由服务端身份字段控制", async () => {
    const page = await request(runtime.app).get("/").expect(200);
    const application = await request(runtime.app).get("/app.js").expect(200);
    const styles = await request(runtime.app).get("/styles.css").expect(200);

    expect(page.text).toContain('id="account-admin-mark" class="account-admin-mark hidden"');
    expect(page.text).not.toContain("account-admin-label");
    expect(page.text).toContain("feature=admin-account-identity-v2");
    expect(application.text).toContain("const isSystemAdmin = session.user.isSystemAdmin === true;");
    expect(application.text).toContain('$("#account-admin-mark").classList.toggle("hidden", !isSystemAdmin);');
    expect(application.text).not.toContain('accountButton.classList.toggle("is-system-admin"');
    expect(application.text).not.toContain('$("#account-admin-label")');
    expect(application.text).not.toContain('session.user.role === "admin" ? "系统管理员"');
    expect(styles.text).toContain(".account-admin-mark {");
    expect(styles.text).not.toContain(".account-button.is-system-admin");
    expect(styles.text).not.toContain(".account-admin-label {");
    expect(styles.text).toContain(".account-button > span:last-child { display: none; }");
  });
});
