import { describe, expect, it } from "vitest";
import { findImMentionQuery, normalizeImComposerHeight, normalizeImConversationWidth, resolveImConversationWidth, shouldFollowImFeed, shouldMarkImConversationRead, shouldRefreshImConversationListForEvent } from "../../src/public/im.js";

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
});
