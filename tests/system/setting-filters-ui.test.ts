import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createRuntime } from "../../src/app.js";

const runtime = createRuntime({
  databasePath: ":memory:",
  masterSecret: "setting-filters-ui-system-test-secret",
  disableUserAuth: true,
  serveUi: true
});

afterAll(() => runtime.close());

describe("设定筛选界面", () => {
  it("提供初始收起的关键词、分类与锁定状态筛选，并同步无障碍状态", async () => {
    const [page, application, styles, filters] = await Promise.all([
      request(runtime.app).get("/").expect(200),
      request(runtime.app).get("/app.js").expect(200),
      request(runtime.app).get("/styles.css").expect(200),
      request(runtime.app).get("/setting-filters.js").expect(200)
    ]);

    expect(page.text).toContain('/styles.css?v=20260816-task-scope-volume-collapse-v2');
    expect(page.text).toContain('/app.js?v=20260816-extended-thinking-effort-v1');
    expect(page.text).toContain('feature=setting-category-preservation-v1');
    expect(application.text).toContain('setSettingEditorCategory(item?.category);');
    expect(application.text).toContain('/setting-filters.js?v=20260810-setting-inline-filters-v1');
    expect(application.text).toContain('const settingFilters = { keyword: "", category: "", lockState: "all" };');
    expect(application.text).toContain('aria-label="筛选设定" aria-controls="setting-filter-panel" aria-expanded="${settingFiltersPanelOpen}"');
    expect(application.text).toContain('id="setting-filter-panel" class="character-filter-toolbar setting-filter-toolbar${settingFiltersPanelOpen ? "" : " hidden"}"');
    expect(application.text).toContain('id="setting-keyword-filter" type="search"');
    expect(application.text).toContain('id="setting-category-filter"');
    expect(application.text).toContain('id="setting-lock-filter"');
    expect(application.text).toContain('id="setting-filter-result-count"');
    expect(application.text).toContain('role="status" aria-live="polite"');
    expect(application.text).toContain('moduleListPages.settings = 1;');
    expect(application.text).toContain('filterSettings(state.settings, settingFilters)');
    expect(application.text).toContain('没有符合筛选条件的设定');
    expect(application.text).toContain('$("#setting-lock-filter").value = "all";\n    settingFiltersPanelOpen = true;\n    moduleListPages.settings = 1;\n    renderSettingResults(1);\n    $("#setting-keyword-filter").focus();');
    expect(filters.text).toContain('export function filterSettings');
    expect(styles.text).toContain('.setting-filter-toolbar { grid-template-columns:');
    expect(styles.text).toContain('.setting-filter-field input, .setting-filter-field select { width: 100%;');
  });

  it("切换作品时重置设定筛选与面板状态", async () => {
    const application = await request(runtime.app).get("/app.js").expect(200);
    const resetWorkScopedUiCachesSource = application.text.slice(
      application.text.indexOf("function resetWorkScopedUiCaches()"),
      application.text.indexOf("async function selectWork(workId, preferredChapterId = null)")
    );
    const selectWorkSource = application.text.slice(
      application.text.indexOf("async function selectWork(workId, preferredChapterId = null)"),
      application.text.indexOf("function renderTree()")
    );

    expect(resetWorkScopedUiCachesSource).toContain('settingFilters.keyword = "";');
    expect(resetWorkScopedUiCachesSource).toContain('settingFilters.category = "";');
    expect(resetWorkScopedUiCachesSource).toContain('settingFilters.lockState = "all";');
    expect(resetWorkScopedUiCachesSource).toContain("settingFiltersPanelOpen = false;");
    expect(resetWorkScopedUiCachesSource).toContain("Object.keys(moduleListPages).forEach((key) => { moduleListPages[key] = 1; });");
    expect(selectWorkSource).toContain("if (state.work?.id !== nextWork.id) resetWorkScopedUiCaches();");
  });
});
