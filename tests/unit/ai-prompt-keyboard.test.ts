import { describe, expect, it } from "vitest";
// @ts-expect-error 浏览器端模块没有单独的类型声明，测试仅调用纯函数导出。
import { shouldSendAiPrompt, shouldSteerAiPrompt } from "../../src/public/ai-prompt-keyboard.js";

function keyEvent(overrides: Record<string, unknown> = {}) {
  return {
    key: "Enter",
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    isComposing: false,
    ...overrides
  };
}

describe("AI 策略栏键盘", () => {
  it("Enter 发送或排队，Ctrl/Cmd+Enter 发送为引导，不把引导当成普通发送", () => {
    expect(shouldSendAiPrompt(keyEvent({}))).toBe(true);
    expect(shouldSteerAiPrompt(keyEvent({}))).toBe(false);
    expect(shouldSendAiPrompt(keyEvent({ shiftKey: true }))).toBe(false);
    expect(shouldSendAiPrompt(keyEvent({ ctrlKey: true }))).toBe(false);
    expect(shouldSteerAiPrompt(keyEvent({ ctrlKey: true }))).toBe(true);
    expect(shouldSteerAiPrompt(keyEvent({ metaKey: true }))).toBe(true);
    expect(shouldSteerAiPrompt(keyEvent({ ctrlKey: true, shiftKey: true }))).toBe(false);
  });
});
