import { describe, expect, it } from "vitest";
import { AppError } from "../../src/errors.js";
import {
  AiStreamSteerMailbox,
  AI_STEER_INSTRUCTION_HEADING,
  createAiSteerRefreshError,
  formatAiSteerInstruction,
  isAiSteerRefreshError,
  normalizeAiSteerContent
} from "../../src/ai-stream-steer.js";

describe("AI 执行流引导信箱", () => {
  it("格式化引导指令并拒绝空内容", () => {
    expect(normalizeAiSteerContent("  缩短旁白  ")).toBe("缩短旁白");
    expect(formatAiSteerInstruction("缩短旁白")).toContain(AI_STEER_INSTRUCTION_HEADING);
    expect(formatAiSteerInstruction("缩短旁白")).toContain("缩短旁白");
    expect(formatAiSteerInstruction("缩短旁白")).toContain("不要重新开始整个任务");
  });

  it("只在活跃执行流上入队，结束后不能再发送", () => {
    const mailbox = new AiStreamSteerMailbox();
    expect(() => mailbox.enqueue("conversation-a", "先别写结局")).toThrow(AppError);
    try {
      mailbox.enqueue("conversation-a", "先别写结局");
    } catch (error) {
      expect(isAiSteerRefreshError(error)).toBe(false);
      expect((error as AppError).code).toBe("AI_STEER_NO_ACTIVE_STREAM");
    }

    const release = mailbox.begin("conversation-a");
    const first = mailbox.enqueue("conversation-a", "先别写结局");
    const second = mailbox.enqueue("conversation-a", "改成北港视角");
    expect(mailbox.isActive("conversation-a")).toBe(true);
    expect(mailbox.drain("conversation-a")).toEqual([first, second]);
    expect(mailbox.drain("conversation-a")).toEqual([]);
    release();
    expect(mailbox.isActive("conversation-a")).toBe(false);
    expect(() => mailbox.enqueue("conversation-a", "已经结束")).toThrow(/没有正在执行的回复/u);
  });

  it("入队时中止当前模型请求以便实时应用引导，而不是取消整轮对话", () => {
    const mailbox = new AiStreamSteerMailbox();
    mailbox.begin("conversation-a");
    const controller = new AbortController();
    mailbox.subscribe("conversation-a", controller);
    mailbox.enqueue("conversation-a", "改成冷静克制");
    expect(controller.signal.aborted).toBe(true);
    expect(isAiSteerRefreshError(controller.signal.reason)).toBe(true);
    expect(createAiSteerRefreshError().code).toBe("AI_STEER_REFRESH");
    expect(createAiSteerRefreshError().message).not.toMatch(/终止|打断当前执行/u);
  });
});
