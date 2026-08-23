import { describe, expect, it } from "vitest";
import {
  DEFAULT_AI_ANALYSIS_TIMEOUT_SECONDS,
  isLongRunningAiAnalysisTaskType,
  normalizeAiAnalysisTimeoutSeconds
} from "../../src/ai-analysis-timeout.js";

describe("供应商分析请求超时", () => {
  it("默认保持 300 秒并限制到允许范围", () => {
    expect(DEFAULT_AI_ANALYSIS_TIMEOUT_SECONDS).toBe(300);
    expect(normalizeAiAnalysisTimeoutSeconds(Number.NaN)).toBe(300);
    expect(normalizeAiAnalysisTimeoutSeconds(29)).toBe(30);
    expect(normalizeAiAnalysisTimeoutSeconds(900)).toBe(900);
    expect(normalizeAiAnalysisTimeoutSeconds(3_601)).toBe(3_600);
  });

  it("只把全书分析和关系分析视为长分析请求", () => {
    expect(isLongRunningAiAnalysisTaskType("book-analysis")).toBe(true);
    expect(isLongRunningAiAnalysisTaskType("relationship-analysis")).toBe(true);
    expect(isLongRunningAiAnalysisTaskType("chapter-analysis")).toBe(false);
    expect(isLongRunningAiAnalysisTaskType("chat")).toBe(false);
  });
});
