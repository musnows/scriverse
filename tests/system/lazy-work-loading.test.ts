import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("作品工作台按需加载", () => {
  it("打开作品时先加载折叠分卷，再异步加载章节目录", async () => {
    const application = await readFile(join(process.cwd(), "src/public/app.js"), "utf8");
    const selectWorkSource = application.slice(
      application.indexOf("async function selectWork(workId, preferredChapterId = null)"),
      application.indexOf("function renderTree()")
    );

    expect(selectWorkSource).toContain("renderTree();");
    expect(selectWorkSource).toContain("?directory=volumes");
    expect(selectWorkSource).toContain('if (state.work?.id !== nextWork.id) resetWorkScopedUiCaches();\n  showSystemStatus();');
    expect(selectWorkSource).not.toContain('if (discarding) setSaveState("就绪");');
    expect(selectWorkSource).not.toContain('setSaveState("就绪")');
    expect(selectWorkSource).toContain("void loadAllVolumeChapters(nextWork.id)");
    expect(selectWorkSource).not.toContain("await selectChapter(targetChapter.id)");
    expect(selectWorkSource).not.toContain("await loadModels()");
    expect(selectWorkSource).not.toContain("await loadAiReferences()");
    expect(selectWorkSource).not.toContain("await loadAiConversations()");
  });

  it("作品树先显示折叠分卷，展开后才渲染章节节点", async () => {
    const application = await readFile(join(process.cwd(), "src/public/app.js"), "utf8");
    const renderTreeSource = application.slice(
      application.indexOf("function renderTree()"),
      application.indexOf("function renderChapterBatchDialog()")
    );

    expect(renderTreeSource).toContain("const collapsed = state.collapsedVolumeIds.has(volume.id);");
    expect(renderTreeSource).toContain("const chapterContent = collapsed");
    expect(renderTreeSource).toContain("void loadVolumeChapters(volumeId)");
    expect(application).toContain("/api/volumes/${encodeURIComponent(volumeId)}/chapters");
  });

  it("全局替换后只重载正文目录并拒绝旧请求清理新请求状态", async () => {
    const application = await readFile(join(process.cwd(), "src/public/app.js"), "utf8");
    const refreshSource = application.slice(
      application.indexOf("async function refreshWorkAfterGlobalReplace("),
      application.indexOf("async function submitGlobalReplace(")
    );
    const chapterLoadingSource = application.slice(
      application.indexOf("async function loadVolumeChapters("),
      application.indexOf("function mergeChapterDirectoryEntry(")
    );

    expect(refreshSource).toContain("buildGlobalReplaceRefreshPlan");
    expect(refreshSource).toContain("chapterCount: resolveGlobalReplaceChapterCount(volume, previousVolume)");
    expect(refreshSource).toContain("++workScopedUiGeneration");
    expect(refreshSource).toContain("await Promise.all(refreshPlan.reloadVolumeIds.map((volumeId) => loadVolumeChapters(volumeId)))");
    expect(refreshSource).not.toContain("state.collapsedVolumeIds = new Set(state.work.volumes.map((volume) => volume.id));");
    expect(chapterLoadingSource).toContain("volumeChapterRequests.get(volumeId) === request");
    expect(chapterLoadingSource).toContain("const generation = workScopedUiGeneration;");
  });

  it("子模块和创作助手资源只在首次使用时加载", async () => {
    const application = await readFile(join(process.cwd(), "src/public/app.js"), "utf8");
    const showModuleSource = application.slice(
      application.indexOf("async function showModule(module)"),
      application.indexOf("function emptyModule(")
    );

    expect(showModuleSource).toContain('if (module === "settings") await renderSettings()');
    expect(showModuleSource).toContain('if (module === "characters") await renderCharacters(characterListPage)');
    expect(showModuleSource).toContain('if (module === "timeline") await renderTimeline()');
    expect(showModuleSource).toContain('if (module === "relationships") await renderRelationships()');
    expect(showModuleSource).toContain("showSystemStatus();");
    expect(application).toContain('updateSystemHealth({ status: "offline" });');
    expect(application).toContain("const systemHealthPollInterval = 30_000;");
    expect(application).toContain('$("#ai-prompt").addEventListener("focus"');
    expect(application).toContain("await ensureAiReferencesLoaded();");
    expect(application).toContain("await ensureAiConversationsLoaded();");
    expect(application).toContain('apiPage(`/api/works/${workId}/ai-conversations`, page, aiConversationHistoryPageLimit)');
    expect(application).toContain("const aiConversationHistoryPageLimit = 20;");
    expect(application).toContain("if (aiModelsLoadPromise && aiModelsLoadWorkId === workId) return aiModelsLoadPromise;");
    expect(application).toContain("if (aiConversationsLoadPromise && aiConversationsLoadWorkId === workId) return aiConversationsLoadPromise;");
    expect(application).not.toContain('/api/works/${workId}/chat');
  });

  it("会话写入后增量更新历史摘要而不重复拉取列表", async () => {
    const application = await readFile(join(process.cwd(), "src/public/app.js"), "utf8");
    const persistMessageSource = application.slice(
      application.indexOf("async function persistAiConversationMessage("),
      application.indexOf("function promptTextFromNode(")
    );
    const createConversationSource = application.slice(
      application.indexOf("async function createNewAiConversation("),
      application.indexOf("async function ensureAiConversation()")
    );
    const sendAiSource = application.slice(
      application.indexOf("async function sendAi()"),
      application.indexOf("async function streamChat(")
    );

    expect(persistMessageSource).toContain("updateAiConversationSummaryFromMessage(message);");
    expect(persistMessageSource).not.toContain("loadAiConversations");
    expect(createConversationSource).toContain("upsertAiConversationSummary(conversation);");
    expect(createConversationSource).not.toContain("loadAiConversations");
    expect(createConversationSource).not.toContain("ensureAiConversationsLoaded");
    expect(sendAiSource).not.toContain('/suggestions`');
    expect(sendAiSource).toContain("writingSuggestion = streamed.writingSuggestion;");
    expect(sendAiSource).not.toContain("ensureAiConversationsLoaded");
    expect(sendAiSource).not.toContain("context/prepare");
    expect(sendAiSource).not.toContain("currentMessageId");
    expect(application).toContain("upsertAiConversationSummary(conversation);");
  });

  it("作品模块按模块和请求参数复用页面生命周期缓存", async () => {
    const application = await readFile(join(process.cwd(), "src/public/app.js"), "utf8");

    expect(application).toContain('createModuleRequestCache } from "/module-request-cache.js?v=20260730-module-request-cache-v1"');
    expect(application).toContain('moduleApiAllPages("drafts", `/api/works/${state.work.id}/drafts`)');
    expect(application).toContain('moduleApiAllPages("settings", `/api/works/${state.work.id}/settings`)');
    expect(application).toContain('moduleApiPage("characters", `/api/works/${state.work.id}/characters`, page, pageSize)');
    expect(application).toContain('moduleApiAllPages("relationships", `/api/works/${state.work.id}/relationships`)');
    expect(application).toContain('moduleApiPage("tasks", `/api/works/${state.work.id}/tasks`, page, pageSize, { refresh })');
    expect(application).toContain('selectedChapter = await api(`/api/chapters/${encodeURIComponent(chapterId)}`);');
    expect(application).toContain('if (String(selectedChapter?.id ?? "") !== String(chapterId) || String(selectedChapter?.workId ?? "") !== String(workId)) return false;');
    expect(application).toContain("mergeChapterDirectoryEntry(state.chapter);");
    expect(application).toContain('const selectionRequestId = ++chapterSelectionRequestId;');
    expect(application).toContain('if (selectionGeneration !== chapterSelectionRequestGeneration || selectionRequestId !== chapterSelectionRequestId || state.work?.id !== workId) return false;');
    expect(application).toContain('await loadChapterForeshadowReminders();');
    expect(application).toContain('await renderTasks(taskListPage, { refresh: true });');
    expect(application).toContain("invalidateModuleRequestsAfterMutation(path, method);");
  });

  it("种族列表不预加载角色，编辑器按需加载成员选项", async () => {
    const application = await readFile(join(process.cwd(), "src/public/app.js"), "utf8");
    const renderRacesSource = application.slice(
      application.indexOf("async function renderRaces("),
      application.indexOf("async function renderOrganizations(")
    );
    const openKnowledgeEditorSource = application.slice(
      application.indexOf("async function openKnowledgeEditor(kind, item"),
      application.indexOf("async function openRaceDialog(item, options)")
    );

    expect(renderRacesSource).toContain('const roots = await moduleApi("races", `/api/works/${workId}/races?scope=roots`)');
    expect(renderRacesSource).toContain('const dismissLoadingToast = persistentToast("正在加载子种族……")');
    expect(renderRacesSource).toContain('moduleApi("races", `/api/works/${workId}/races?scope=descendants`)');
    expect(renderRacesSource).toContain('state.races = [...roots.items, ...descendants]');
    expect(renderRacesSource).toContain("dismissLoadingToast();");
    expect(renderRacesSource).not.toContain("apiAllPages");
    expect(renderRacesSource).not.toContain('/characters');
    expect(openKnowledgeEditorSource).toContain('const memberCharacters = readOnly');
    expect(openKnowledgeEditorSource).toContain('await moduleApiAllPages("characters", `/api/works/${state.work.id}/characters`)');
    expect(openKnowledgeEditorSource).toContain('if (!readOnly) state.characters = memberCharacters;');
    expect(openKnowledgeEditorSource).not.toContain('state.characters = canReadModule("characters") ? await apiAllPages(`/api/works/${state.work.id}/characters`) : []');
  });

  it("组织列表不预加载未用于列表渲染的角色目录", async () => {
    const application = await readFile(join(process.cwd(), "src/public/app.js"), "utf8");
    const renderOrganizationsSource = application.slice(
      application.indexOf("async function renderOrganizations("),
      application.indexOf("function updateTimelineMultiSelectControls(")
    );

    expect(renderOrganizationsSource).toContain('state.organizations = await moduleApiAllPages("organizations", `/api/works/${state.work.id}/organizations`)');
    expect(renderOrganizationsSource).not.toContain("/characters");
    expect(renderOrganizationsSource).toContain("item.members");
  });

  it("审核面板仅为角色查重审核项加载角色目录", async () => {
    const application = await readFile(join(process.cwd(), "src/public/app.js"), "utf8");
    const renderReviewsSource = application.slice(
      application.indexOf("async function renderReviews("),
      application.indexOf("async function renderTasks(")
    );

    expect(renderReviewsSource).toContain('const reviews = await moduleApiAllPages("reviews", `/api/works/${state.work.id}/reviews`)');
    expect(renderReviewsSource).toContain('const hasCharacterDuplicateReviews = reviews.some((item) => item.itemType === "character-duplicate");');
    expect(renderReviewsSource).toContain('canReadCharacters && hasCharacterDuplicateReviews');
    expect(renderReviewsSource).toContain('`/api/works/${state.work.id}/characters?includeMerged=1`');
  });

  it("审核状态按钮在提交期间禁用并向用户反馈失败", async () => {
    const application = await readFile(join(process.cwd(), "src/public/app.js"), "utf8");
    const renderReviewsSource = application.slice(
      application.indexOf("async function renderReviews("),
      application.indexOf("async function renderTasks(")
    );
    const statusHandlerSource = renderReviewsSource.slice(
      renderReviewsSource.indexOf('querySelectorAll("[data-review-id]")'),
      renderReviewsSource.indexOf('querySelectorAll("[data-merge-review]")')
    );

    expect(statusHandlerSource).toContain("button.disabled = true;");
    expect(statusHandlerSource).toContain("try {");
    expect(statusHandlerSource).toContain('await api(`/api/reviews/${button.dataset.reviewId}`');
    expect(statusHandlerSource).toContain("await renderReviews(pageResult.page);");
    expect(statusHandlerSource).toContain("} catch (error) {");
    expect(statusHandlerSource).toContain('toast(error.message, "error");');
    expect(statusHandlerSource).toContain("button.disabled = false;");
  });

  it("角色分页不覆盖跨模块全量引用缓存", async () => {
    const application = await readFile(join(process.cwd(), "src/public/app.js"), "utf8");
    const renderCharactersSource = application.slice(
      application.indexOf("async function renderCharacters("),
      application.indexOf("async function renderRaces(")
    );
    const openCharacterEditorSource = application.slice(
      application.indexOf("async function openCharacterEditor("),
      application.indexOf("async function openRaceDialog(")
    );

    expect(renderCharactersSource).toContain("const pageCharacters = characterPage.items;");
    expect(renderCharactersSource).not.toContain("state.characters = characterPage.items");
    expect(renderCharactersSource).toContain('openCharacterEditor(pageCharacters.find((item) => item.id === id)');
    expect(openCharacterEditorSource).not.toContain('canReadModule("characters") ? apiAllPages(`/api/works/${state.work.id}/characters`)');
    expect(openCharacterEditorSource).toContain('const candidates = await moduleApiAllPages("characters", `/api/works/${workId}/characters`)');
    expect(openCharacterEditorSource).not.toContain("loadCharacterEditorRelationships(item.id)");
    expect(application).toContain('moduleApiAllPages("characters", `/api/works/${workId}/characters`)');
    expect(application).toContain('key === "relationships"');
  });

  it("角色卡预览只由角色列表处理，避免模块事件代理重复打开", async () => {
    const application = await readFile(join(process.cwd(), "src/public/app.js"), "utf8");
    const moduleInteractionSource = application.slice(
      application.indexOf("function bindModuleContentInteractions()"),
      application.indexOf("function openReviewDetailDialog(")
    );

    expect(moduleInteractionSource).not.toContain("openCharacter");
    expect(moduleInteractionSource).not.toContain("openCharacterEditor(await api");
    expect(application).toContain('bindRecordPreview("[data-open-character]"');
  });
});
