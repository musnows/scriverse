import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

describe("知识模块布局切换", () => {
  const runtimes: Runtime[] = [];

  afterEach(async () => {
    while (runtimes.length) await runtimes.pop()?.close();
  });

  it("设定、角色、种族、组织、伏笔与审核保留卡片并支持列表切换", async () => {
    const runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "module-layout-toggle-system-test-secret",
      disableUserAuth: true,
      serveUi: true
    });
    runtimes.push(runtime);

    const page = await request(runtime.app).get("/").expect(200);
    const styles = await request(runtime.app).get("/styles.css").expect(200);
    const application = await request(runtime.app).get("/app.js").expect(200);
    const layoutModule = await request(runtime.app).get("/module-layout.js").expect(200);

    expect(page.text).toContain('/styles.css?v=20260816-task-scope-volume-collapse-v2');
    expect(page.text).toContain('/app.js?v=20260816-extended-thinking-effort-v1');
    expect(page.text).toContain('&feature=ai-message-actions-v1')
    expect(page.text).toContain('&feature=assistant-responsive-navigation-v3')
    expect(page.text).toContain('&feature=annotation-permissions-v1')
    expect(page.text).toContain('&feature=annotation-line-counts-v1')
    expect(page.text).toContain('&feature=ai-write-tools-v2')
    expect(page.text).toContain('&feature=ai-write-tools-v3')
    expect(page.text).toContain('id="setting-editor-readonly-badge"');
    expect(page.text).toContain('id="character-editor-readonly-badge"');
    expect(page.text).toContain('id="knowledge-editor-readonly-badge"');
    expect(styles.text).toContain('.entity-editor-readonly-badge');
    expect(application.text).toContain('error.code === "INVALID_CURRENT_PASSWORD" ? "当前密码错误，请重新输入"');

    expect(layoutModule.text).toContain('export const MODULE_LAYOUTS = ["cards", "rows"]');
    expect(application.text).toContain('/module-layout.js?v=20260723-module-layout-toggle');
    expect(styles.text).toContain('input[type="checkbox"] {');
    expect(styles.text).toContain('input[type="checkbox"]:checked::before');
    expect(styles.text).toContain('.character-editor-section-fields .member-chip input[type="checkbox"] { position: absolute; width: 1px !important; min-width: 1px; height: 1px; padding: 0; border: 0; opacity: 0; }');
    expect(styles.text).toContain('.setting-editor-lock span { display: inline-flex; align-items: center; min-height: 16px; line-height: 16px; }');
    expect(application.text).toContain('data-module-layout="cards"');
    expect(application.text).toContain('data-module-layout="rows"');
    expect(application.text).toContain('aria-label="卡片视图" title="卡片视图"');
    expect(application.text).toContain('aria-label="列表视图" title="列表视图"');
    expect(application.text).toContain('function moduleLayoutIconMarkup(layout)');
    expect(application.text).not.toContain('class="module-layout-hint"');
    expect(application.text).toContain('class="card-grid"');
    expect(application.text).toContain('class="module-row-list"');
    expect(application.text).toContain("MODULE_LAYOUT_STORAGE_KEY");
    const characterCardsStart = application.text.indexOf("const characterCards = () =>");
    const characterRowsStart = application.text.indexOf("const characterRows = () =>", characterCardsStart);
    const characterCardsSource = application.text.slice(characterCardsStart, characterRowsStart);
    expect(characterCardsSource).toContain('recordCardEditButton("edit-character", item.id');
    expect(characterCardsSource).not.toContain('<div class="card-actions">${characterActions(item)}</div>');
    expect(application.text).toContain('data-open-setting="${esc(item.id)}" role="button" tabindex="0"');
    expect(application.text).toContain('data-open-character="${esc(item.id)}" role="button" tabindex="0"');
    expect(application.text).toContain('data-open-race="${esc(item.id)}" role="button" tabindex="0"');
    expect(application.text).toContain('function bindRecordPreview(selector, open)');
    expect(application.text).toContain('function openReviewDetailDialog(item)');
    expect(application.text).toContain('data-open-review="${esc(item.id)}" role="button" tabindex="0"');
    expect(application.text).toContain('bindRecordPreview("[data-open-review]"');
    expect(application.text).toContain('entry.sourceTitle || entry.chapterTitle || entry.chapterId');
    expect(application.text).toContain('置信度 ${Math.round(entry.confidence * 100)}%');
    expect(page.text).toContain('id="dialog-meta" class="dialog-header-meta hidden"');
    expect(application.text).toContain('hideCancel: true');
expect(application.text).toContain('/display-labels.js?v=20260816-character-gender-v1');
    expect(application.text).toContain('settingStatusLabel(item.status)');
    expect(application.text).not.toContain('characterVisibilityLabel(item.visibility)');
    expect(application.text).toContain('timelineStatusLabel(item.status)');
    expect(application.text).toContain('relationshipConfirmationLabel(item.confirmationStatus)');
    expect(application.text).not.toContain('<small>${esc(item.taskType)}</small>');
    expect(application.text).toContain('if (event.target.closest("button, a, summary")) return;');
    expect(application.text).toContain('{ readOnly: true }');
    expect(page.text).toContain('id="setting-editor-edit"');
    expect(page.text).toContain('<span id="setting-editor-eyebrow" class="eyebrow">新建设定</span>');
    expect(page.text).not.toContain('id="setting-change-note-field"');
    expect(page.text).toContain('id="character-editor-edit"');
    expect(page.text).toContain('id="knowledge-editor-edit"');
    expect(page.text).toContain('id="chapter-edit-button"');
    expect(page.text).toContain('id="chapter-delete-button"');
    expect(page.text).toContain(">编辑</button>");
    expect(application.text).toContain("function applyChapterEditorMode()");
    expect(application.text).toContain("function enterChapterEditMode()");
    expect(application.text).toContain('$("#chapter-delete-button").classList.toggle("hidden", permissionBlocked || chapterEditorReadOnly || !state.chapter);');
    expect(application.text).toContain("let chapterEditorReadOnly = true");
    expect(application.text).toContain("async function selectChapter(chapterId, { editMode = false } = {})");
    expect(application.text).toContain("await selectChapter(chapter.id, { editMode: true })");
    expect(styles.text).toContain(".editor-view.is-read-only #tidy-blank-lines-button");
    expect(styles.text).toContain(".editor-view.is-read-only #save-button");
    expect(application.text).toContain('aria-label="角色列表分页"');
    expect(application.text).toContain('const pageSize = pageSizeFor("characters")');
    expect(application.text).toContain('paginateCharacters(filterCharacters(characterSource, characterFilters), page, pageSize)');
    expect(application.text).toContain("data-character-page");
    expect(application.text).toContain("上一页");
    expect(application.text).toContain("下一页");
    expect(application.text).toContain("共 ${characterPage.total} 个角色");
    expect(application.text).toContain("第 ${characterPage.page}/${Math.ceil(characterPage.total / characterPage.limit)} 页");
    expect(application.text).toContain("function mountModuleCount(count)");
    expect(application.text).toContain("class=\"module-count-badge\"");
    expect(styles.text).toContain(".module-count-badge { display: inline-grid; min-width: 28px; height: 28px;");
    expect(styles.text).toContain(".module-header h1 { margin: 0 0 6px; font-weight: 500; font-size: 24px;");
    expect(application.text).toContain("characterPage.hasMore");
    expect(application.text).toContain("pageCharacters.length && (characterPage.page > 1 || characterPage.hasMore)");
    expect(application.text).toContain("if (!characterPage.items.length && page > 1) return renderCharacters(page - 1)");
    expect(application.text).toContain('const hasCharacterFilters = characterFilters.raceIds.length > 0\n    || characterFilters.organizationIds.length > 0\n    || characterFilters.genderValues.length > 0\n    || characterFilters.deathState !== "all";');
    expect(application.text).toContain('moduleApiAllPages("characters", `/api/works/${state.work.id}/characters`)');
    expect(application.text).toContain('filterOptionList(orderRaceFilterOptions(races), selectedRaceIds)');
    expect(application.text).toContain('filterOptionList(organizations, selectedOrganizationIds, "id")');
    expect(application.text).toContain('/relationship-filters.js?v=20260818-character-relationship-group-v1');
    expect(application.text).toContain('aria-controls="relationship-filter-panel"');
    expect(application.text).toContain('id="relationship-from-character-filter"');
    expect(application.text).toContain('id="relationship-to-character-filter"');
    expect(application.text).toContain('筛选后剩余 ${filteredRelationships.length} 条关系');
    expect(application.text).toContain('relationshipFilters.fromCharacterIds = [];');
    expect(application.text).toContain('relationshipFilters.toCharacterIds = [];');
    expect(application.text).toContain('await api(`/api/${route.entity === "setting" ? "settings" : route.entity === "character" ? "characters" : route.entity === "race" ? "races" : "organizations"}/${encodeURIComponent(route.entityId)}`)');
    expect(application.text).toContain('api(`/api/works/${state.work.id}/races`)');
    expect(application.text).not.toContain('apiAllPages(`/api/works/${state.work.id}/races`)');
    expect(application.text).toContain('${directChildCount(item)} 个直接子种族');
    expect(application.text).toContain('apiAllPages(`/api/works/${state.work.id}/organizations`)');
    expect(application.text).toContain('data-open-organization="${esc(item.id)}" role="button" tabindex="0" aria-label="查看组织 ${esc(item.name)}"');
    expect(application.text).not.toContain("人工修正");
    expect(application.text).toContain('item ? "编辑设定" : "新建设定"');
    expect(application.text).toContain('const changeNote = currentItem ? await inputToast(');
    expect(application.text).toContain('title: "填写版本说明"');
    expect(application.text).toContain('mountModuleLayoutToggle(layout, "设定列表样式")');
    expect(application.text).toContain('mountModuleLayoutToggle(layout, "角色列表样式")');
    expect(application.text).toContain('mountModuleLayoutToggle(layout, "种族列表样式")');
    expect(application.text).toContain('function mountRaceTreeExpandToggle()');
    expect(application.text).toContain('function setAllRaceTreeNodesOpen(open)');
    expect(application.text).toContain('function bindRaceTreeNodeToggles()');
    expect(application.text).toContain('function syncRaceTreeExpandToggle()');
    expect(application.text).toContain('function raceTreeExpandAction()');
    expect(application.text).toContain('collapsedRaceIds: new Set()');
    expect(application.text).toContain('data-race-tree-expand="${action}"');
    expect(application.text).toContain('const label = action === "collapse" ? "全部折叠" : "全部展开"');
    expect(application.text).toContain('if (state.races.length && layout !== "rows") mountRaceTreeExpandToggle()');
    expect(application.text).toContain('class="race-tree-node"${state.collapsedRaceIds.has(item.id) ? "" : " open"}');
    expect(application.text).toContain('mountModuleLayoutToggle(layout, "组织列表样式")');
    expect(styles.text).toContain(".race-tree-expand-toolbar ~ .module-layout-toolbar { order: 2; }");
    expect(styles.text).toContain(".race-tree-expand-toolbar ~ #module-create-button { order: 3; }");
    expect(application.text).toContain('mountModuleLayoutToggle(layout, "伏笔列表样式")');
    expect(application.text).toContain("function foreshadowOccurrencesField(item, chapters)");
    expect(application.text).toContain("function bindForeshadowOccurrenceControls(container, chapters)");
    expect(application.text).toContain("function readForeshadowOccurrences(item)");
    expect(application.text).toContain("function updateForeshadowOccurrenceRowSummary(row)");
    expect(application.text).toContain('data-occurrence-role="${esc(role)}"');
    expect(application.text).toContain('meta: "完整编辑伏笔信息、章节节点与回收结果"');
    expect(application.text).toContain('data-foreshadow-occurrence-add');
    expect(application.text).toContain('data-foreshadow-occurrence-remove');
    expect(application.text).toContain('field("plannedPayoffChapterId", "计划回收章节"');
    expect(application.text).not.toContain('const occurrence = (role) => item?.occurrences?.find');
    expect(styles.text).toContain(".foreshadow-occurrence-grid { display: grid;");
    expect(styles.text).toContain(".large-dialog { width: min(1120px, 94vw);");
    expect(styles.text).toContain('.foreshadow-occurrence-row[data-occurrence-role="payoff"]');
    expect(application.text).toContain('mountModuleLayoutToggle(layout, "审核列表样式")');
    expect(page.text).toContain('id="module-header-actions"');
    expect(application.text).toContain('$("#module-header-actions").insertAdjacentHTML');
    expect(application.text).toContain('function mountModuleLayoutToggle(layout, ariaLabel)');
    expect(application.text).toContain('id="timeline-tools" class="timeline-tools" data-module-header-action="timeline-tools"');
    expect(application.text).toContain('id="timeline-multi-select-toggle"');
    expect(application.text).toContain('function setTimelineMultiSelectMode(enabled)');
    expect(application.text).toContain('aria-label="选择 ${esc(item.name)}" hidden');
    expect(application.text).toContain('$("#module-header-actions").querySelectorAll("[data-module-layout]")');

    expect(styles.text).toContain(".card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 13px; }");
    expect(styles.text).toContain(".settings-row-list, .module-row-list { display: grid; gap: 8px; }");
    expect(styles.text).toContain(".setting-row, .module-row {");
    expect(styles.text).toContain(".module-row .module-row-preview { display: -webkit-box;");
    expect(styles.text).toContain("max-height: 2.9em;");
    expect(styles.text).toContain("white-space: normal; -webkit-box-orient: vertical; -webkit-line-clamp: 2;");
    expect(styles.text).toContain(".settings-layout-toggle, .module-layout-toggle");
    expect(styles.text).toContain(".module-layout-toggle svg { width: 16px; height: 16px;");
    expect(styles.text).toContain(".settings-layout-toolbar, .module-layout-toolbar { display: flex;");
    expect(styles.text).toContain(".module-header-actions { display: flex;");
    expect(styles.text).toContain(".module-header-actions > .module-count-badge { order: 0; }");
    expect(styles.text).toContain(".module-pagination { display: flex;");
    expect(styles.text).toContain(".module-pagination button { min-width: 58px; min-height: 28px;");
    expect(styles.text).toContain('.entity-editor-page.is-read-only .vditor-ir pre.vditor-reset[contenteditable="false"]');
    expect(styles.text).toContain(".card-actions .record-card-edit { position: static; padding: 0; }");
    expect(styles.text).toContain("body.work-viewer-mode #timeline-multi-select-toggle");
  });
});
