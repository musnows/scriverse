import { describe, expect, it } from "vitest";
// @ts-expect-error 浏览器端模块没有单独的类型声明，测试仅调用纯函数导出。
import { formatAiContextUsagePercent, formatAiContextUsageTooltip, mergeAiContextUsage, normalizeAiContextTokenDistribution, resolveAiContextUsage } from "../../src/public/ai-context-meter.js";

describe("AI 上下文用量提示", () => {
  it("低于 10% 时保留一位小数，其余显示整数", () => {
    expect(formatAiContextUsagePercent(2_177, 200_000)).toBe("1.1%");
    expect(formatAiContextUsagePercent(962, 200_000)).toBe("0.5%");
    expect(formatAiContextUsagePercent(0, 0)).toBe("0.0%");
    expect(formatAiContextUsagePercent(48_400, 200_000)).toBe("24%");
    expect(formatAiContextUsagePercent(20_000, 200_000)).toBe("10%");
    expect(formatAiContextUsagePercent(19_999, 200_000)).toBe("10%");
  });

  it("分别显示作品、对话和本次最大输出", () => {
    expect(formatAiContextUsageTooltip({
      inputTokens: 12_345,
      contextWindow: 128_000,
      contextTokens: 6_000,
      conversationTokens: 2_500,
      conversationBudgetTokens: 30_000,
      outputReserveTokens: 32_000,
      effectiveOutputTokens: 18_000
    })).toBe("总输入 12,345 / 128,000 tok · 作品上下文 6,000 tok · 对话历史 2,500 / 30,000 tok · 本次最大输出 18,000 tok");
  });

  it("下一轮用量返回前保留上一轮结果", () => {
    const previousUsage = { inputTokens: 12_345, contextWindow: 128_000, usagePercent: 9.6 };
    const nextUsage = { inputTokens: 18_000, contextWindow: 128_000, usagePercent: 14.1 };

    expect(resolveAiContextUsage(previousUsage, null)).toBe(previousUsage);
    expect(resolveAiContextUsage(previousUsage, undefined)).toBe(previousUsage);
    expect(resolveAiContextUsage(previousUsage, nextUsage)).toBe(nextUsage);
    expect(resolveAiContextUsage(null, null)).toBeNull();
  });

  it("下一轮用量为空时保留上一轮单调用量", () => {
    const previousUsage = { inputTokens: 12_345, contextWindow: 128_000 };

    expect(mergeAiContextUsage(previousUsage, null)).toBe(previousUsage);
    expect(mergeAiContextUsage(previousUsage, undefined)).toBe(previousUsage);
    expect(mergeAiContextUsage(previousUsage, "invalid")).toBe(previousUsage);
    expect(mergeAiContextUsage(null, null)).toBeNull();
  });

  it("没有上一轮用量时直接采用下一轮用量", () => {
    const nextUsage = { inputTokens: 800, contextWindow: 200_000, usagePercent: 0 };

    expect(mergeAiContextUsage(null, nextUsage)).toBe(nextUsage);
  });

  it("默认逐字段钳制会收缩的累计用量并采用下一轮配置", () => {
    const previousUsage = {
      modelId: "old-model",
      contextWindow: 128_000,
      inputTokens: 20_000,
      contextTokens: 12_000,
      conversationTokens: 6_000,
      remainingTokens: 108_000,
      usagePercent: 15.6,
      conversationUsagePercent: 20
    };
    const nextUsage = {
      modelId: "next-model",
      contextWindow: 200_000,
      inputTokens: 10_000,
      contextTokens: 8_000,
      conversationTokens: 3_000,
      remainingTokens: 90_000,
      usagePercent: 5,
      conversationUsagePercent: 10,
      compactThreshold: 80
    };

    expect(mergeAiContextUsage(previousUsage, nextUsage)).toEqual({
      ...nextUsage,
      inputTokens: 20_000,
      contextTokens: 12_000,
      conversationTokens: 6_000,
      remainingTokens: 90_000,
      usagePercent: 15.6,
      conversationUsagePercent: 20
    });
  });

  it("明确允许收缩时直接采用下一轮用量", () => {
    const previousUsage = { inputTokens: 20_000, contextWindow: 128_000, usagePercent: 15.6 };
    const nextUsage = { inputTokens: 8_000, contextWindow: 128_000, usagePercent: 6.3 };

    expect(mergeAiContextUsage(previousUsage, nextUsage, true)).toBe(nextUsage);
  });

  it("按上下文窗口归一化六类 Token 分布并拆分 input 与 output", () => {
    expect(normalizeAiContextTokenDistribution({
      contextWindow: 1_000,
      outputReserveTokens: 500,
      effectiveOutputTokens: 200,
      tokenDistribution: {
        systemPromptTokens: 120,
        functionTokens: 80,
        skillsTokens: 0,
        contextTokens: 300,
        outputTokens: 200
      }
    })).toEqual({
      contextWindow: 1_000,
      occupiedTokens: 700,
      items: [
        { key: "system-prompt", label: "system prompt", tokens: 120, percent: 12 },
        { key: "function", label: "function", tokens: 80, percent: 8 },
        { key: "skills", label: "skills", tokens: 0, percent: 0 },
        { key: "input", label: "input", tokens: 300, percent: 30 },
        { key: "output", label: "output", tokens: 200, percent: 20 },
        { key: "left", label: "left", tokens: 300, percent: 30 }
      ]
    });
  });

  it("本次最大输出不会挤出上下文窗口", () => {
    expect(normalizeAiContextTokenDistribution({
      contextWindow: 1_000,
      outputReserveTokens: 500,
      effectiveOutputTokens: 500,
      tokenDistribution: {
        systemPromptTokens: 120,
        functionTokens: 80,
        skillsTokens: 0,
        contextTokens: 700
      }
    }).items.at(-2)).toEqual({ key: "output", label: "output", tokens: 100, percent: 10 });
  });
});
