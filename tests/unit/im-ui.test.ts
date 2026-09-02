import { describe, expect, it } from "vitest";
import { collectImMessageGap, findImMentionQuery, hasImMessageSequenceGap, imConversationAccessibleLabel, imDiagnosticStatusLabel, isImRealtimeChainCurrent, matchImProvisionalReplyTurn, mergeImFailedReplyPages, mergeImMessagePages, normalizeImComposerHeight, normalizeImConversationWidth, normalizeImDetailsWidth, resolveImConversationWidth, sameImGroupSettings, shouldFollowImFeed, shouldMarkImConversationRead, shouldRefreshImConversationListForEvent } from "../../src/public/im.js";

describe("IM 编辑区域尺寸", () => {
  it("把拖动高度限制在当前视口允许范围内", () => {
    expect(normalizeImComposerHeight(40, 420)).toBe(64);
    expect(normalizeImComposerHeight(236, 420)).toBe(236);
    expect(normalizeImComposerHeight(520, 420)).toBe(420);
    expect(normalizeImComposerHeight(Number.NaN, 420)).toBe(64);
    expect(normalizeImComposerHeight(180, 48)).toBe(64);
  });

  it("把会话列表宽度限制在头像模式与最大宽度之间", () => {
    expect(normalizeImConversationWidth(40, 420)).toBe(72);
    expect(normalizeImConversationWidth(88, 420)).toBe(88);
    expect(normalizeImConversationWidth(320, 420)).toBe(320);
    expect(normalizeImConversationWidth(520, 420)).toBe(420);
    expect(normalizeImConversationWidth(Number.NaN, 420)).toBe(300);
    expect(resolveImConversationWidth(300, 390, 72)).toBe(72);
    expect(resolveImConversationWidth(300, 1280, 420)).toBe(300);
  });

  it("把会话详情宽度限制在可用阅读空间以内", () => {
    expect(normalizeImDetailsWidth(180, 520)).toBe(240);
    expect(normalizeImDetailsWidth(360, 520)).toBe(360);
    expect(normalizeImDetailsWidth(640, 520)).toBe(520);
    expect(normalizeImDetailsWidth(Number.NaN, 520)).toBe(320);
    expect(normalizeImDetailsWidth(360, 220)).toBe(240);
  });

  it("只在用户正在查看可见 IM 页面时标记会话已读", () => {
    expect(shouldMarkImConversationRead(true, "visible")).toBe(true);
    expect(shouldMarkImConversationRead(false, "visible")).toBe(false);
    expect(shouldMarkImConversationRead(true, "hidden")).toBe(false);
  });

  it("后台只为会影响列表的低频事件刷新会话列表", () => {
    expect(shouldRefreshImConversationListForEvent("message")).toBe(true);
    expect(shouldRefreshImConversationListForEvent("conversation")).toBe(true);
    expect(shouldRefreshImConversationListForEvent("chain")).toBe(true);
    expect(shouldRefreshImConversationListForEvent("delta")).toBe(false);
    expect(shouldRefreshImConversationListForEvent("turn")).toBe(false);
    expect(shouldRefreshImConversationListForEvent("reset")).toBe(false);
  });

  it("按链路和角色把最终消息匹配到正在生成的临时气泡", () => {
    const replies = [
      { turnId: "turn-waiting", chainId: "chain-1", characterId: "character-1", status: "pending" },
      { turnId: "turn-running", chainId: "chain-1", characterId: "character-1", status: "running" },
      { turnId: "turn-other", chainId: "chain-1", characterId: "character-2", status: "running" }
    ];
    expect(matchImProvisionalReplyTurn(replies, { chainId: "chain-1", senderCharacterId: "character-1" })).toBe("turn-running");
    expect(matchImProvisionalReplyTurn(replies, { chainId: "chain-1", senderCharacterId: "character-3" })).toBeNull();
    expect(matchImProvisionalReplyTurn(replies, { senderCharacterId: "character-1" })).toBeNull();
  });

  it("只在群设置草稿与服务端值完全一致时视为已保存", () => {
    const settings = { title: "讨论群", replyMode: "proactive", responseThreshold: 60, maxAiMessages: 20 };
    expect(sameImGroupSettings(settings, { ...settings })).toBe(true);
    expect(sameImGroupSettings(settings, { ...settings, title: "未保存群名" })).toBe(false);
    expect(sameImGroupSettings(settings, { ...settings, responseThreshold: 61 })).toBe(false);
  });

  it("把主动判断内部状态映射成中文结果", () => {
    expect(imDiagnosticStatusLabel({ selected: true, status: "completed" })).toBe("已选择");
    expect(imDiagnosticStatusLabel({ selected: false, status: "completed" })).toBe("未选择 · 低于阈值");
    expect(imDiagnosticStatusLabel({ selected: false, status: "failed" })).toBe("判断失败");
    expect(imDiagnosticStatusLabel({ selected: false, status: "cancelled" })).toBe("已取消");
    expect(imDiagnosticStatusLabel({ selected: false, status: "running" })).toBe("判断中");
  });

  it("只接受当前活动链的实时生成事件", () => {
    expect(isImRealtimeChainCurrent({ id: "chain-current" }, { chainId: "chain-current" })).toBe(true);
    expect(isImRealtimeChainCurrent({ id: "chain-current" }, { chainId: "chain-old" })).toBe(false);
    expect(isImRealtimeChainCurrent(null, { chainId: "chain-old" })).toBe(false);
    expect(isImRealtimeChainCurrent({ id: "chain-current" }, {})).toBe(false);
  });

  it("把会话未读和提及数加入可访问名称", () => {
    expect(imConversationAccessibleLabel("讨论群", "主动交流", 0, 0)).toBe("讨论群，主动交流");
    expect(imConversationAccessibleLabel("讨论群", "主动交流", 3, 0)).toBe("讨论群，主动交流，3 条未读");
    expect(imConversationAccessibleLabel("讨论群", "主动交流", 5, 2)).toBe("讨论群，主动交流，2 条提及未读，共 5 条未读");
  });

  it("按当前文本节点的光标位置识别 mention 查询", () => {
    expect(findImMentionQuery("开头 @林舟 后续文字", 6)).toEqual({ query: "林舟", startOffset: 3, endOffset: 6 });
    expect(findImMentionQuery("开头 @林舟 后续文字", 11)).toBeNull();
    expect(findImMentionQuery("@", 1)).toEqual({ query: "", startOffset: 0, endOffset: 1 });
  });

  it("只在接近底部或显式切换会话时跟随新消息", () => {
    expect(shouldFollowImFeed(1000, 720, 240)).toBe(true);
    expect(shouldFollowImFeed(1000, 300, 240)).toBe(false);
    expect(shouldFollowImFeed(1000, 300, 240, true)).toBe(true);
  });

  it("实时刷新时合并已加载的旧页与服务端最新页", () => {
    const previous = Array.from({ length: 59 }, (_, index) => ({ id: `message-${index + 1}`, sequence: index + 1 }));
    const latest = Array.from({ length: 50 }, (_, index) => ({ id: `message-${index + 11}`, sequence: index + 11 }));
    expect(mergeImMessagePages(previous, latest).map((message) => message.sequence)).toEqual(
      Array.from({ length: 60 }, (_, index) => index + 1)
    );
  });

  it("按触发消息顺序合并并去重历史失败回答", () => {
    expect(mergeImFailedReplyPages(
      [{ id: "failure-2", triggerSequence: 4, createdAt: "2026-09-03T00:00:02.000Z" }],
      [{ id: "failure-1", triggerSequence: 2, createdAt: "2026-09-03T00:00:01.000Z" }],
      [{ id: "failure-2", triggerSequence: 4, createdAt: "2026-09-03T00:00:02.000Z", failure: "latest" }]
    )).toEqual([
      expect.objectContaining({ id: "failure-1" }),
      expect.objectContaining({ id: "failure-2", failure: "latest" })
    ]);
  });

  it("识别断线期间超过一页的新消息缺口", () => {
    const previous = Array.from({ length: 50 }, (_, index) => ({ id: `old-${index + 1}`, sequence: index + 1 }));
    const latest = Array.from({ length: 50 }, (_, index) => ({ id: `new-${index + 102}`, sequence: index + 102 }));
    const gap = Array.from({ length: 51 }, (_, index) => ({ id: `gap-${index + 51}`, sequence: index + 51 }));
    expect(hasImMessageSequenceGap(previous, latest)).toBe(true);
    expect(hasImMessageSequenceGap(mergeImMessagePages(previous, gap), latest)).toBe(false);
  });

  it("通过多轮 afterSequence 请求补齐超过 100 条的断线缺口", async () => {
    const previous = Array.from({ length: 34 }, (_, index) => ({ id: `old-${index + 1}`, sequence: index + 1 }));
    const latest = Array.from({ length: 50 }, (_, index) => ({ id: `latest-${index + 135}`, sequence: index + 135 }));
    const cursors: number[] = [];
    const gap = await collectImMessageGap(previous, latest, async (afterSequence) => {
      cursors.push(afterSequence);
      return {
        messages: Array.from({ length: 50 }, (_, index) => ({
          id: `gap-${afterSequence + index + 1}`,
          sequence: afterSequence + index + 1
        })),
        hasMoreMessagesAfter: true
      };
    });
    expect(cursors).toEqual([34, 84]);
    expect(gap).toHaveLength(100);
    expect(mergeImMessagePages(previous, gap, latest)).toHaveLength(184);
  });
});
