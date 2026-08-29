import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

describe("AI 对话历史弹窗", () => {
  const runtimes: Runtime[] = [];

  afterEach(async () => {
    while (runtimes.length) await runtimes.pop()?.close();
  });

  it("将历史列表放入独立弹窗并保留会话切换交互", async () => {
    const runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "ai-history-dialog-system-test-secret",
      disableUserAuth: true,
      serveUi: true
    });
    runtimes.push(runtime);

    const page = await request(runtime.app).get("/").expect(200);
    const application = await request(runtime.app).get("/app.js").expect(200);
    const styles = await request(runtime.app).get("/styles.css").expect(200);

    expect(page.text).toContain('id="ai-history-toggle"');
    expect(page.text).toContain('id="ai-history-toggle" type="button" aria-label="历史记录"');
    expect(page.text).toContain('class="ai-heading-action-icon"');
    expect(page.text.indexOf('id="ai-history-toggle"')).toBeLessThan(page.text.indexOf('id="ai-new-conversation"'));
    expect(page.text).toContain('aria-controls="ai-history-dialog"');
    expect(page.text).toContain('id="ai-history-dialog" class="dialog wide-dialog ai-history-dialog"');
    expect(page.text).toContain('id="ai-history-list" class="ai-history-list"');
    expect(page.text).toContain('id="ai-history-action-menu" class="ai-history-action-menu hidden" role="menu"');
    expect(page.text).toContain('data-ai-history-action="favorite"');
    expect(page.text).toContain('data-ai-history-action="copy-session-id"');
    expect(page.text).toContain('data-ai-history-action="export"');
    expect(page.text).toContain('data-ai-history-action="delete"');
    expect(page.text).toContain('id="ai-history-pagination" class="module-pagination ai-history-pagination hidden"');
    expect(page.text).toContain('<option value="chat">问答</option>');
    expect(page.text).toContain('<option value="roleplay">角色扮演</option>');
    expect(page.text).not.toContain('<option value="continue">续写</option>');
    expect(page.text).not.toContain('<option value="polish">润色选中文本</option>');
    expect(page.text).toContain('提到续写或润色时会自动加载对应 Skill');
    expect(page.text).toContain('id="ai-history-previous"');
    expect(page.text).toContain('id="ai-history-next"');
    expect(page.text).not.toContain('id="ai-history-panel"');
    expect(application.text).toContain('$("#ai-history-dialog").open');
    expect(application.text).toContain("dialog.showModal()");
    expect(application.text).toContain('$("#ai-history-close").addEventListener');
    expect(application.text).toContain('$("#ai-history-previous").addEventListener');
    expect(application.text).toContain('$("#ai-history-next").addEventListener');
    expect(application.text).toContain('more.setAttribute("aria-haspopup", "menu")');
    expect(application.text).toContain("function aiConversationTaskTypeLabel(taskType)");
    expect(application.text).toContain("function aiConversationContextScopeLabel(scope)");
    expect(application.text).toContain("meta.textContent = aiConversationHistoryMeta(conversation);");
    expect(application.text).toContain('book: "全书"');
    expect(application.text).toContain('chat: "问答"');
    expect(application.text).not.toContain('continue: "续写"');
    expect(application.text).not.toContain('polish: "润色选中文本"');
    expect(application.text).toContain('writingChapterVersion: state.chapter.versionNo');
    expect(application.text).toContain('attachWritingSuggestion(assistantMessage, writingSuggestion');
    expect(application.text).toContain("function syncAiHistoryActionMenu(conversation)");
    expect(application.text).toContain("async function copyAiConversationSessionId(conversation)");
    expect(application.text).toContain('if (action === "copy-session-id") {');
    expect(application.text).toContain('toast("对话 Session ID 已复制")');
    expect(application.text).toContain('/api/ai-conversations/${encodeURIComponent(conversation.id)}/favorite');
    expect(application.text).toContain('method: "DELETE"');
    expect(application.text).toContain("收藏的对话不能清理，请先取消收藏");
    expect(application.text).toContain('/api/ai-conversations/${encodeURIComponent(conversation.id)}/export');
    expect(application.text).toContain('label.textContent = "下载中"');
    expect(application.text).toContain('toast(`对话导出失败：${error.message}`, "error")');
    expect(application.text).toContain('$("#ai-history-dialog").addEventListener("cancel"');
    expect(application.text).toContain('fork.setAttribute("aria-label", "从此消息续写为新对话")');
    expect(application.text).toContain("const forkRequestId = createAiIdempotencyKey()");
    expect(application.text).toContain("body: { messageId: message.dataset.messageId, requestId: forkRequestId }");
    expect(application.text).toContain('message.dataset.messageId && message.classList.contains("assistant-message")');
    expect(styles.text).toContain(".ai-history-dialog-body");
    expect(styles.text).toContain(".ai-heading-action-icon");
    expect(styles.text).toContain(".ai-history-row { display: grid;");
    expect(styles.text).toContain(".ai-history-title-row { display: flex;");
    expect(styles.text).toContain(".ai-history-favorite {");
    expect(styles.text).toContain(".ai-history-action-menu { position: fixed;");
    expect(styles.text).not.toContain(".ai-history-panel");
  });
});
