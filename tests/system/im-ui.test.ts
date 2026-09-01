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
    expect(page.text).toContain('id="im-settings-button" class="im-icon-button im-settings-icon-button"');
    expect(page.text).toContain('id="im-settings-button" class="im-icon-button im-settings-icon-button" type="button" aria-label="IM 设置" title="IM 设置"><svg class="settings-icon"');
    expect(page.text).toContain('id="im-view" class="im-view hidden"');
    expect(page.text).toContain('id="im-view" class="im-view hidden" aria-label="IM 工作区"');
    expect(page.text).toContain('class="im-create-action-buttons"');
    expect(page.text).not.toContain('id="im-workspace-title"');
    expect(page.text).not.toContain('class="im-sidebar-header"');
    expect(page.text).toContain('id="im-conversation-list"');
    expect(page.text).toContain('id="im-message-feed"');
    expect(page.text).toContain('id="im-details"');
    expect(page.text).toContain('id="im-settings-dialog"');
    expect(page.text).toContain('id="im-group-dialog"');
    expect(page.text).toContain('id="im-announcement-button"');
    expect(page.text).toContain('id="im-announcement-dialog"');
    expect(page.text).toContain('id="im-announcement-form"');
    expect(page.text).toContain('id="im-member-add-dialog"');
    expect(page.text).toContain('id="im-member-add-work"');
    expect(page.text).toContain('id="im-member-add-character-search"');
    expect(page.text).toContain('id="im-member-add-human-search"');
    expect(page.text).toContain("公告将作为一次性旁白进入所有当前 AI 角色的后续上下文，不会触发 AI 回复");
    expect(page.text).toContain('id="im-new-conversation"');
    expect(page.text).toContain('id="im-create-work"');
    expect(page.text).toContain('id="im-create-search"');
    expect(page.text).toContain('id="im-create-selected"');
    expect(page.text).toContain('id="im-create-submit"');
    expect(page.text).toContain("单选角色创建单聊，多选角色创建群聊");
    expect(page.text).not.toContain('id="im-direct-character"');
    expect(page.text).not.toContain('id="im-new-group"');
    expect(page.text).toContain("feature=global-im-v21");
    expect(page.text).toContain("feature=im-narration-contrast-v1");
    expect(page.text).toContain("feature=im-member-add-plus-v2");
    expect(page.text).toContain("feature=im-button-hierarchy-v1");
    expect(page.text).toContain("feature=im-settings-gear-v1");
    expect(page.text).toContain("feature=im-icon-button-size-v1");
    expect(page.text).toContain("feature=im-sidebar-compact-v1");
    expect(application.text).toContain('/im.js?v=20260901-global-im-v21');
    expect(application.text).toContain("createImWorkspace({ api, esc, renderMarkdown, toast, confirmToast, state, showShelf })");
    expect(im.text).toContain('mentionMenu.addEventListener("pointerdown", (event) => event.preventDefault())');
    expect(application.text).toContain('if (!$("#im-view").classList.contains("hidden")) return { view: "im" }');
    expect(im.text).toContain("mention://${item.kind}/${item.id}");
    expect(im.text).toContain("const mentionPattern = /mention:");
    expect(im.text).toContain("(character|user)");
    expect(im.text).toContain('replyMode: String(form.get("replyMode") || "mention")');
    expect(im.text).toContain('api("/api/im/works")');
    expect(im.text).toContain('characterIds.length === 1');
    expect(im.text).toContain('submit.textContent = !hasWork ? "请先选择书籍" : count === 0 ? "请选择角色" : count === 1 ? "创建单聊"');
    expect(im.text).toContain("item.isPinned");
    expect(im.text).toContain("item.isFavorite");
    expect(im.text).toContain("data-im-remove-selected");
    expect(im.text).toContain('model.type === "announcement"');
    expect(im.text).toContain("/announcements");
    expect(im.text).toContain('toast("旁白公告已发布", "success")');
    expect(im.text).toContain("imAvatarHtml");
    expect(im.text).toContain("conversationAvatarHtml");
    expect(im.text).toContain("im-group-avatar-grid");
    expect(im.text).toContain('data-grid-size="${gridSize}"');
    expect(im.text).toContain("im-message-avatar");
    expect(im.text).toContain("im-member-avatar");
    expect(im.text).toContain("im-mention-avatar");
    expect(im.text).toContain("data-im-open-member-add");
    expect(im.text).toContain("im-member-section-heading");
    expect(im.text).toContain("openMemberAddDialog");
    expect(im.text).toContain("loadMemberAddCharacters");
    expect(im.text).toContain("loadMemberAddHumans");
    expect(im.text).toContain("confirmToast(");
    expect(im.text).toContain('title: "转让群主", confirmLabel: "确认转让"');
    expect(im.text).toContain('title: "解散群聊", confirmLabel: "确认解散"');
    expect(im.text).not.toContain("window.confirm(");
    expect(im.text).toContain('class="im-owner-action-buttons"');
    expect(im.text.indexOf("主动判断诊断")).toBeLessThan(im.text.indexOf('class="im-owner-actions"'));
    expect(im.text).not.toContain('id="im-add-character-select"');
    expect(im.text).not.toContain('id="im-add-human-select"');
    expect(im.text).toContain('document.querySelector("#im-detail-threshold")');
    expect(im.text).toContain("serializeImComposer");
    expect(styles.text).toContain(".im-view { display: grid; grid-template-columns:");
    expect(styles.text).toContain("@media (max-width: 620px)");
    expect(styles.text).toContain(".im-composer-mention");
    expect(styles.text).toContain(".im-button-secondary");
    expect(styles.text).toContain(".im-button-positive");
    expect(styles.text).toContain(".im-button-danger-quiet");
    expect(styles.text).toContain(".im-button:disabled");
    expect(styles.text).toContain(".im-button-announcement");
    expect(styles.text).toContain(".im-message.is-announcement");
    expect(styles.text).toContain(".im-announcement-form");
    expect(styles.text).toContain(".im-create-role-toolbar");
    expect(styles.text).toContain(".im-create-selected button");
    expect(styles.text).toContain(".im-character-preference.is-pinned");
    expect(styles.text).toContain('.im-option-grid input[type="checkbox"]');
    expect(styles.text).toContain("#im-details-content :is(input:not");
    expect(styles.text).toContain("#im-detail-threshold::-webkit-slider-thumb");
    expect(styles.text).toContain(".im-settings-dialog .account-settings-form");
    expect(styles.text).toContain(".im-conversation-single-avatar");
    expect(styles.text).toContain('.im-group-avatar-grid[data-grid-size="4"]');
    expect(styles.text).toContain('.im-group-avatar-grid[data-grid-size="9"]');
    expect(styles.text).toContain(".im-group-avatar-empty");
    expect(styles.text).toContain(".im-option-avatar");
    expect(styles.text).toContain(".im-selected-avatar");
    expect(styles.text).toContain(".im-message-avatar");
    expect(styles.text).toContain(".im-member-avatar");
    expect(styles.text).toContain(".im-member-add-button");
    expect(styles.text).toContain(".im-member-section-heading");
    expect(styles.text).toContain(".im-member-add-dialog");
    expect(styles.text).toContain(".im-member-picker-option");
    expect(styles.text).toContain(".im-chat-header .im-button { min-height: 28px;");
    expect(styles.text).toContain(".im-owner-action-buttons { display: grid; grid-template-columns: repeat(2");
    expect(styles.text).toContain(".im-conversations { display: flex; flex-direction: column;");
    expect(styles.text).toContain(".im-create-action-buttons");
    expect(styles.text).toContain(".im-button-secondary { border: 1px solid var(--line); background: var(--surface); color: var(--muted);");
    expect(styles.text).toContain(".im-button-announcement { border: 1px solid var(--im-narration-line); background: var(--im-narration-surface);");
    expect(styles.text).toContain("border: 1px solid color-mix(in srgb, var(--green) 58%, var(--line));");
    expect(styles.text).toContain("--im-narration-surface:");
    expect(styles.text).toContain("background: var(--im-narration-surface)");
    expect(styles.text).toContain("border-width: 1px 0");
  });
});
