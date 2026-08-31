import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

describe("全局 IM 工作区界面", () => {
  let runtime: Runtime;

  afterEach(async () => {
    await runtime?.close();
  });

  it("提供全局入口、三栏工作区、模型设置和 typed mention composer", async () => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-ui-system-test-master-secret-with-enough-length",
      disableUserAuth: true,
      serveUi: true
    });
    const [page, application, im, styles] = await Promise.all([
      request(runtime.app).get("/").expect(200),
      request(runtime.app).get("/app.js").expect(200),
      request(runtime.app).get("/im.js").expect(200),
      request(runtime.app).get("/styles.css").expect(200)
    ]);

    expect(page.text).toContain('id="im-open-button"');
    expect(page.text).toContain('id="im-view" class="im-view hidden"');
    expect(page.text).toContain('id="im-conversation-list"');
    expect(page.text).toContain('id="im-message-feed"');
    expect(page.text).toContain('id="im-details"');
    expect(page.text).toContain('id="im-settings-dialog"');
    expect(page.text).toContain('id="im-group-dialog"');
    expect(page.text).toContain("feature=global-im-v9");
    expect(application.text).toContain('/im.js?v=20260831-global-im-v9');
    expect(im.text).toContain('mentionMenu.addEventListener("pointerdown", (event) => event.preventDefault())');
    expect(application.text).toContain('if (!$("#im-view").classList.contains("hidden")) return { view: "im" }');
    expect(im.text).toContain("mention://${item.kind}/${item.id}");
    expect(im.text).toContain("const mentionPattern = /mention:");
    expect(im.text).toContain("(character|user)");
    expect(im.text).toContain('replyMode: String(form.get("replyMode") || "mention")');
    expect(im.text).toContain('document.querySelector("#im-detail-threshold")');
    expect(im.text).toContain("serializeImComposer");
    expect(styles.text).toContain(".im-view { display: grid; grid-template-columns:");
    expect(styles.text).toContain("@media (max-width: 620px)");
    expect(styles.text).toContain(".im-composer-mention");
  });
});
