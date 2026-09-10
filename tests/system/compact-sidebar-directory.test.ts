import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

describe("窄侧栏作品目录", () => {
  const runtimes: Runtime[] = [];

  afterEach(async () => {
    while (runtimes.length) await runtimes.pop()?.close();
  });

  it("为作品目录标题和卷章数量提供紧凑显示结构", async () => {
    const runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "compact-sidebar-directory-system-test-secret",
      disableUserAuth: true,
      serveUi: true
    });
    runtimes.push(runtime);

    const [page, application, styles] = await Promise.all([
      request(runtime.app).get("/"),
      request(runtime.app).get("/app.js"),
      request(runtime.app).get("/styles.css")
    ]);

    expect(page.status).toBe(200);
    expect(application.status).toBe(200);
    expect(styles.status).toBe(200);
    expect(page.text).toContain('feature=compact-sidebar-directory-v5');
    expect(page.text).toContain('feature=chapter-directory-ai-reference-v3');
    expect(page.text).toContain('class="panel-heading-label-full">作品目录</span><span class="panel-heading-label-compact">目录</span>');
    expect(page.text).toContain('id="chapter-count"><span class="chapter-count-number">0</span><span class="chapter-count-unit"> 章</span>');
    expect(application.text).toContain('$("#chapter-count").querySelector(".chapter-count-number").textContent = String(count);');
    expect(application.text).toContain('class="volume-chapter-count"><span class="volume-chapter-count-number">');
    expect(page.text).toContain('data-add-chapter-ai-reference>添加到助手引用</button>');
    expect(page.text).toContain('id="chapter-type-ai-reference-separator" class="line-citation-menu-separator hidden" role="separator" aria-orientation="horizontal"></div>');
    expect(application.text).toContain('function addChapterAsAiReference(chapterId)');
    expect(application.text).toContain('state.aiReferences.push(reference);');
    expect(application.text).toContain('renderAiReferences();');
    expect(application.text).toContain('if (!canEditProse() && !canWritePermissionModule(state.work, "ai-chat")) return;');
    expect(application.text).toContain('menu.querySelector("#chapter-type-ai-reference-separator")?.classList.toggle("hidden", !(canManageChapter && canAddAiReference));');
    expect(styles.text).toContain('container: left-panel-body / inline-size;');
    expect(styles.text).toContain('@container left-panel-body (max-width: 220px)');
    expect(styles.text).toContain('.chapter-count-unit, .volume-chapter-count-unit { display: none; }');
    expect(styles.text).toContain('.module-nav > #ai-assistant-entry');
    expect(styles.text).toContain('grid-template-columns: auto minmax(0, 2em);');
    expect(styles.text).toContain('justify-content: start;');
    expect(styles.text).toContain('.module-nav > button[data-module="outlines"]');
    expect(styles.text).toContain('grid-template-columns: auto minmax(0, 3em);');
    expect(styles.text).not.toContain('.module-nav > button[data-module="tasks"]');
    expect(styles.text).not.toContain('.module-nav > button[data-module="ai-settings"]');
  });
});
