import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

describe("沉浸式阅读预览界面", () => {
  let runtime: Runtime;

  beforeAll(() => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "reader-system-test-secret-with-enough-length",
      disableUserAuth: true,
      serveUi: true
    });
  });
  afterAll(() => runtime.close());

  it("提供独立路由、阅读入口、可访问控件和本地状态恢复", async () => {
    const page = await request(runtime.app).get("/").expect(200);
    const application = await request(runtime.app).get("/app.js").expect(200);
    const styles = await request(runtime.app).get("/styles.css").expect(200);
    const readingState = await request(runtime.app).get("/reading-preview.js").expect(200);
    const pageRoute = await request(runtime.app).get("/page-route.js").expect(200);

    expect(page.text).toContain('/styles.css?v=20260816-task-scope-volume-collapse-v2&feature=ai-tool-call-copy-feedback-v2&feature=ai-send-control-v3&feature=character-gender-v1&feature=character-filter-state-v1&feature=relationship-canvas-scale-v1&feature=relationship-table-scroll-v1&feature=galaxy-compact-controls-v2&feature=galaxy-motion-mode-v2&feature=chapter-search-replace-v3&feature=task-auto-run-ring-center-v3&feature=character-relationship-delete-v1&feature=ai-assistant-workspace-v2&feature=mobile-module-tab-position-v1&feature=volume-detail-icon-v1&feature=editor-actions-flow-v1&feature=reader-controls-subpanel-v1&feature=reader-focus-ring-v1');
    expect(page.text).toContain('&feature=editor-preview-toggle-v2');
    expect(page.text).toContain('&feature=ai-message-actions-v1');
    expect(page.text).toContain('&feature=assistant-responsive-navigation-v2');
    expect(page.text).toContain('&feature=annotation-line-counts-v1');
    expect(page.text).toContain('&feature=line-number-gutter-fill-v1');
    expect(page.text).toContain('/app.js?v=20260816-extended-thinking-effort-v1');
    expect(page.text).toContain('id="reader-open-button" class="module-nav-secondary hidden"');
    expect(page.text).toMatch(/id="module-more-button"[\s\S]*id="reader-open-button"[\s\S]*data-module="comments"/u);
    expect(page.text).not.toMatch(/data-module="editor"[\s\S]*id="reader-open-button"[\s\S]*data-module="drafts"/u);
    expect(page.text).not.toContain('id="chapter-reader-button"');
    expect(page.text).toContain('id="reader-view" class="reader-view hidden"');
    expect(page.text).toContain('role="dialog" aria-labelledby="reader-title"');
    expect(page.text).toContain('id="reader-volume" aria-label="从分卷开始阅读"');
    expect(page.text).toContain('id="reader-chapter" aria-label="快速跳章"');
    expect(page.text).toContain('id="reader-mode" aria-label="阅读方式"');
    expect(page.text).toMatch(/id="reader-settings"[\s\S]*class="reader-jump-controls"/u);
    expect(page.text).not.toMatch(/<\/details>\s*<div class="reader-jump-controls"/u);
    expect(page.text).toContain('id="reader-font-size" aria-label="阅读字号"');
    expect(page.text).toContain('id="reader-line-height" aria-label="阅读行距"');
    expect(page.text).toContain('id="reader-theme" aria-label="阅读主题"');
    expect(page.text).toContain('<option value="auto">跟随工作台</option>');

    expect(application.text).toContain('from "/reading-preview.js?v=20260813-reader-theme-v2"');
    expect(application.text).toContain('api(`/api/chapters/${encodeURIComponent(target.id)}`, { signal: request.signal })');
    expect(application.text).toContain("readingRequestGate.isCurrent(request)");
    expect(application.text).toContain("readingPositionStorageKey(state.work.id)");
    expect(application.text).toContain('localStorage.setItem(READING_PREFERENCES_STORAGE_KEY');
    expect(application.text).toContain("resolveReadingTheme(readingPreferences.theme, currentColorTheme())");
    expect(application.text).toContain('$("#module-more-button").setAttribute("aria-expanded", String(expanded))');
    expect(application.text).toContain('querySelectorAll(".module-nav-secondary").forEach((button) => button.classList.toggle("hidden", !expanded))');
    expect(application.text).toContain('$("#module-more-button").addEventListener("click", () => setModuleNavExpanded(!moduleNavExpanded))');
    expect(application.text).toContain('$("#reader-open-button").classList.toggle("permission-hidden", proseHidden)');
    expect(application.text).toContain('$("#reader-open-button").disabled = !canReadModule("editor") || count === 0');
    expect(application.text).toContain('const focusCandidates = [focus, $("#reader-open-button"), $("#home-button")]');
    expect(application.text).toContain("function handleReadingKeyboard(event)");
    expect(application.text).not.toContain("function handleReadingWheel(event)");
    expect(application.text).not.toContain('addEventListener("wheel", handleReadingWheel');
    expect(application.text).toContain('$("#reader-previous").addEventListener("click", () => void navigateReadingChapter(-1))');
    expect(application.text).toContain('$("#reader-next").addEventListener("click", () => void navigateReadingChapter(1))');
    expect(application.text).toContain("function layoutReadingPages");
    expect(styles.text).toContain(".reader-view {");
    expect(styles.text).toContain('.reader-view[data-reader-theme="dark"]');
    expect(styles.text).toContain(".reader-viewport.is-paged .reader-content");
    expect(styles.text).toContain(".reader-viewport:focus-visible { box-shadow: none; }");
    expect(styles.text).toContain("@media (max-width: 700px)");
    expect(styles.text).toContain(".reader-settings-panel { position: static;");
    expect(styles.text).toContain(".app-shell.ai-hidden-mode:not(.shelf-mode) { grid-template-columns: minmax(0, 1fr); }");
    expect(readingState.text).toContain("export function createReadingRequestGate()");
    expect(pageRoute.text).toContain('view === "reader"');
  });
});
