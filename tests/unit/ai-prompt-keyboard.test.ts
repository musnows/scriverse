import { describe, expect, it } from "vitest";
// @ts-expect-error 浏览器端模块没有单独的类型声明，测试仅调用纯函数导出。
import { shouldActivateAiSendControl, shouldSendAiPrompt } from "../../src/public/ai-prompt-keyboard.js";

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
  it("Enter 与 Ctrl/Cmd+Enter 都走策略栏发送方式，Shift+Enter 换行", () => {
    expect(shouldSendAiPrompt(keyEvent({}))).toBe(true);
    expect(shouldActivateAiSendControl(keyEvent({}))).toBe(true);
    expect(shouldSendAiPrompt(keyEvent({ shiftKey: true }))).toBe(false);
    expect(shouldActivateAiSendControl(keyEvent({ shiftKey: true }))).toBe(false);
    expect(shouldSendAiPrompt(keyEvent({ ctrlKey: true }))).toBe(false);
    expect(shouldActivateAiSendControl(keyEvent({ ctrlKey: true }))).toBe(true);
    expect(shouldActivateAiSendControl(keyEvent({ metaKey: true }))).toBe(true);
    expect(shouldActivateAiSendControl(keyEvent({ altKey: true }))).toBe(false);
  });
});
