import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

describe("人物扩展属性内容换行", () => {
  let runtime: Runtime;

  beforeEach(() => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "character-detail-value-wrap-system-test-secret",
      disableUserAuth: true,
      serveUi: true
    });
  });

  afterEach(() => runtime.close());

  it("仅为扩展设定内容使用自动增高的多行输入框", async () => {
    const [application, styles, page] = await Promise.all([
      request(runtime.app).get("/app.js").expect(200),
      request(runtime.app).get("/styles.css").expect(200),
      request(runtime.app).get("/").expect(200)
    ]);

    expect(application.text).toContain('field("details", "扩展属性", "key-value-list", item?.attributes?.details, { multilineValue: true })');
    expect(application.text).toContain('class="key-value-list-value"');
    expect(application.text).toContain('rows="1"');
    expect(application.text).toContain('CSS.supports("field-sizing", "content")');
    expect(application.text).toContain("function resizeAutoGrowingTextarea(textarea)");
    expect(application.text).toContain('textarea.style.height = "0px"');
    expect(application.text).toContain('const autoGrowingTextareaObserver = typeof ResizeObserver === "function"');
    expect(application.text).toContain('window.addEventListener("resize", () => {');
    expect(application.text).toContain('resizeAutoGrowingTextareas(document.querySelector(`[data-character-editor-panel="${key}"]`))');
    expect(styles.text).toContain(".character-editor-section-fields .key-value-list-value");
    expect(styles.text).toContain("field-sizing: content");
    expect(styles.text).toContain("overflow-wrap: anywhere");
    expect(page.text).toMatch(/<link rel="stylesheet" href="[^"]*feature=character-detail-value-wrap-v2">/u);
    expect(page.text).toMatch(/<script type="module" src="[^"]*feature=character-detail-value-wrap-v2[^"]*"><\/script>/u);
  });
});
