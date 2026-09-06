import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("AI 流式请求快照", () => {
  it("从请求快照构造流地址、取消信号和持久化目标", async () => {
    const publicPath = join(process.cwd(), "src", "public");
    const [application, page] = await Promise.all([
      readFile(join(publicPath, "app.js"), "utf8"),
      readFile(join(publicPath, "index.html"), "utf8")
    ]);

    expect(application).toContain('/ai-request-manager.js?v=20260905-question-stream-v2');
    expect(application).toContain('fetch(endpoint ?? `/api/works/${encodeURIComponent(request.workId)}/chat/stream`');
    expect(application).toContain("signal: request.signal");
    expect(application).toContain("request.conversationId,\n          \"assistant\"");
    expect(application).toContain("requestHolder.snapshot = aiRequestManager.bind(requestHolder.snapshot, { userMessageId: persistedUserMessage.id })");
    expect(page).toContain('/app.js?v=20260816-extended-thinking-effort-v1');
  });

  it("页签切换保留旧流，作品切换会取消全部流并拒绝过期回调", async () => {
    const application = await readFile(join(process.cwd(), "src", "public", "app.js"), "utf8");

    expect(application).toContain('beginAiConversationNavigation("已切换 AI 对话", "切换会话")');
    expect(application).toContain('beginAiConversationNavigation("已新建 AI 对话", "新建会话")');
    expect(application).toContain('invalidateAiConversationNavigation(state.work?.id === workId ? "已重新载入作品" : "已切换作品")');
    expect(application).toContain("selectionGeneration !== workSelectionRequestGeneration");
    expect(application).toContain("assertAiRequestCurrent(requestHolder.snapshot)");
    expect(application).toContain("persistAiRequestInterruption(request, error?.streamInterruption)");
    expect(application).toContain('tabId: tab.id');
    expect(application).toContain('aiRequestManager.cancelAll(reason)');
    expect(application).toContain('仍有 Agent turn 尚未结束，${action}会中断全部生成');
    expect(application).toContain('仍有 Agent turn 尚未结束，刷新会中断全部生成；已收到的内容会保留在历史记录中');
    expect(application).not.toContain('切换会话会中断生成');
    expect(application).not.toContain('event.returnValue = "";');
  });
});
