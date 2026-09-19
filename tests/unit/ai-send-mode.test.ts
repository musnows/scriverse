import { describe, expect, it } from "vitest";
// @ts-expect-error 浏览器端模块没有单独的类型声明，测试仅调用纯函数导出。
import { AI_SEND_MODE_QUEUE, AI_SEND_MODE_STEER, AI_SEND_MODE_STORAGE_KEY, aiSendModeAction, normalizeAiSendMode, readStoredAiSendMode, writeStoredAiSendMode } from "../../src/public/ai-send-mode.js";

describe("AI 全局发送方式", () => {
  it("只接受排队发送或引导发送，默认排队", () => {
    expect(normalizeAiSendMode("steer")).toBe(AI_SEND_MODE_STEER);
    expect(normalizeAiSendMode("queue")).toBe(AI_SEND_MODE_QUEUE);
    expect(normalizeAiSendMode("")).toBe(AI_SEND_MODE_QUEUE);
    expect(normalizeAiSendMode("interrupt")).toBe(AI_SEND_MODE_QUEUE);
    expect(aiSendModeAction("queue", false)).toBe("send");
    expect(aiSendModeAction("steer", false)).toBe("send");
    expect(aiSendModeAction("queue", true)).toBe("queue");
    expect(aiSendModeAction("steer", true)).toBe("steer");
    expect(aiSendModeAction("queue", true, false)).toBe("stop");
    expect(aiSendModeAction("steer", true, false)).toBe("stop");
    expect(aiSendModeAction("queue", true, true)).toBe("queue");
  });

  it("把发送方式记在本地，不把未知值写回去", () => {
    const storage = new Map();
    const fakeStorage = {
      getItem(key: string) { return storage.get(key) ?? null; },
      setItem(key: string, value: string) { storage.set(key, value); }
    };
    expect(readStoredAiSendMode(fakeStorage)).toBe(AI_SEND_MODE_QUEUE);
    expect(writeStoredAiSendMode(fakeStorage, "steer")).toBe(AI_SEND_MODE_STEER);
    expect(storage.get(AI_SEND_MODE_STORAGE_KEY)).toBe(AI_SEND_MODE_STEER);
    expect(readStoredAiSendMode(fakeStorage)).toBe(AI_SEND_MODE_STEER);
    expect(writeStoredAiSendMode(fakeStorage, "promoteNow")).toBe(AI_SEND_MODE_QUEUE);
    expect(readStoredAiSendMode(fakeStorage)).toBe(AI_SEND_MODE_QUEUE);
  });
});
