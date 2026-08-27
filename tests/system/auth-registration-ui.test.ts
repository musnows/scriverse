import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

describe("注册入口状态", () => {
  let runtime: Runtime;

  beforeAll(() => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "auth-registration-ui-system-test-secret",
      disableUserAuth: true,
      serveUi: true
    });
  });

  afterAll(() => runtime.close());

  it("关闭注册时展示不可交互的注册已禁用状态", async () => {
    const page = await request(runtime.app).get("/").expect(200);
    const application = await request(runtime.app).get("/app.js").expect(200);
    const styles = await request(runtime.app).get("/styles.css").expect(200);

    expect(page.text).toContain('id="auth-register-tab" type="button" role="tab" aria-selected="false" aria-disabled="true" disabled>注册已禁用</button>');
    expect(application.text).toContain("function showAuth(setupRequired, registrationOpen = false, setupTokenRequired = false)");
    expect(application.text).toContain("const canRegister = registrationOpen === true;");
    expect(application.text).toContain('registerTab.disabled = !canRegister;');
    expect(application.text).toContain('registerTab.setAttribute("aria-disabled", String(!canRegister));');
    expect(application.text).toContain('registerTab.textContent = canRegister ? "注册" : "注册已禁用";');
    expect(application.text).toContain('if (response.status === 401 && !path.startsWith("/api/auth/") && !path.includes("/presence")) {');
    expect(application.text).toContain('const login = mode === "login" || registerTab.disabled;');
    expect(application.text).not.toContain('$("#auth-register-tab").classList.toggle("hidden", !canRegister);');
    expect(page.text).toContain('id="register-setup-token-field" class="hidden"');
    expect(page.text).toContain('<form id="login-form" class="auth-form" method="post" action="/api/auth/login">');
    expect(page.text).toContain('<form id="register-form" class="auth-form hidden" method="post" action="/api/auth/register">');
    expect(page.text).toContain('<form id="password-form" class="account-settings-form password-settings-form" method="post" action="/api/auth/password">');
    expect(application.text).toContain('setupTokenField.classList.toggle("hidden", !setupTokenRequired);');
    expect(application.text).toContain("setupTokenInput.required = setupTokenRequired;");
    expect(styles.text).toContain(".auth-tabs button:disabled {");
    expect(styles.text).toContain("cursor: not-allowed;");
    expect(page.text).toContain('<input name="passwordConfirmation" type="password" autocomplete="new-password" minlength="10" maxlength="200" required>');
    expect(application.text).toContain("function validatePasswordChangeConfirmation()");
    expect(application.text).toContain("passwordConfirmation");
    expect(styles.text).toContain(".password-settings-form { grid-template-columns: repeat(3, minmax(0, 1fr)) auto; }");
    expect(page.text).toContain('aria-describedby="login-lock-hint"');
    expect(page.text).toContain('<input id="login-password" name="password" type="password" autocomplete="current-password" maxlength="200" required aria-describedby="login-lock-hint">');
    expect(page.text).not.toContain('data-password-toggle="login-password"');
    expect(page.text).toContain('id="login-lock-hint" class="auth-security-hint">登录和注册采用验证码与来源限速防护，不会因他人输错密码而锁定账户。</p>');
    expect(styles.text).toContain(".auth-security-hint {");
    expect(styles.text).toContain("width: min(400px, 100%);");
    expect(styles.text).toContain("padding: 24px;");
    expect(styles.text).toContain(".auth-product-footer { align-self: end; max-width: 400px;");
    expect(page.text).toContain("feature=auth-compact-v2");
  });
});
