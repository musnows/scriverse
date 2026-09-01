import { describe, expect, it } from "vitest";
import { normalizeImComposerHeight, normalizeImConversationWidth } from "../../src/public/im.js";

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
  });
});
