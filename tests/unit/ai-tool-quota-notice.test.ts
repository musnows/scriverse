import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_AGENT_TOOL_CALL_LIMIT,
  MAX_AGENT_TOOL_CALL_LIMIT_ENV,
  agentToolCallGlobalLimit,
  agentToolCallQuotaNoticeBudgetChars,
  agentToolCallQuotaUsedAfterCompact,
  agentToolCallSoftWarningThreshold,
  buildAgentToolCallQuotaNotice,
  clampAgentToolCallGlobalMultiplier,
  shouldRejectAgentToolCalls,
  shouldRejectGlobalToolCalls,
  resolveMaxAgentToolCallLimit,
  withAgentToolCallQuotaNotice
} from "../../src/ai-tool-results.js";

describe("AI 工具调用配额提醒", () => {
  it("默认上限为 80 且支持通过环境变量调整", () => {
    expect(DEFAULT_MAX_AGENT_TOOL_CALL_LIMIT).toBe(80);
    expect(resolveMaxAgentToolCallLimit({})).toBe(80);
    expect(resolveMaxAgentToolCallLimit({ [MAX_AGENT_TOOL_CALL_LIMIT_ENV]: "120" })).toBe(120);
    expect(resolveMaxAgentToolCallLimit({ [MAX_AGENT_TOOL_CALL_LIMIT_ENV]: "not-a-number" })).toBe(80);
    expect(resolveMaxAgentToolCallLimit({ [MAX_AGENT_TOOL_CALL_LIMIT_ENV]: "2" })).toBe(5);
  });

  it("按上限的 20% + 1 计算软提醒阈值，并保证下限为 3", () => {
    expect(agentToolCallSoftWarningThreshold(12)).toBe(3);
    expect(agentToolCallSoftWarningThreshold(5)).toBe(3);
    expect(agentToolCallSoftWarningThreshold(48)).toBe(10);
    expect(agentToolCallSoftWarningThreshold(20)).toBe(5);
  });

  it("compact 后把已用次数重置为上限的 20%（向下取整）", () => {
    expect(agentToolCallQuotaUsedAfterCompact(15)).toBe(3);
    expect(agentToolCallQuotaUsedAfterCompact(12)).toBe(2);
    expect(agentToolCallQuotaUsedAfterCompact(5)).toBe(1);
    expect(agentToolCallQuotaUsedAfterCompact(48)).toBe(9);
  });

  it("全局上限默认按调用上限的 3 倍计算，且独立于 compact 重置", () => {
    expect(agentToolCallGlobalLimit(15, 3)).toBe(45);
    expect(agentToolCallGlobalLimit(12, 1)).toBe(12);
    expect(agentToolCallGlobalLimit(12, 6)).toBe(72);
    expect(clampAgentToolCallGlobalMultiplier(0)).toBe(1);
    expect(clampAgentToolCallGlobalMultiplier(7)).toBe(6);
    expect(shouldRejectGlobalToolCalls(44, 1, 45)).toBe(false);
    expect(shouldRejectGlobalToolCalls(45, 1, 45)).toBe(true);
    expect(shouldRejectGlobalToolCalls(43, 3, 45)).toBe(true);
  });

  it("配额提醒字段的额外字符会计入 compact 体积预算估算", () => {
    expect(agentToolCallQuotaNoticeBudgetChars(4, 12)).toBe(0);
    const warningBudget = agentToolCallQuotaNoticeBudgetChars(3, 12);
    const criticalBudget = agentToolCallQuotaNoticeBudgetChars(0, 12);
    expect(warningBudget).toBeGreaterThan(0);
    expect(criticalBudget).toBeGreaterThan(warningBudget);
    expect(criticalBudget).toBeGreaterThan(buildAgentToolCallQuotaNotice(0, 12)?.length ?? 0);
  });

  it("默认上限 12 时仅在剩余不超过 3 次时注入提醒字符串", () => {
    expect(buildAgentToolCallQuotaNotice(4, 12)).toBeNull();
    expect(withAgentToolCallQuotaNotice({ ok: true }, 4, 12)).toEqual({ ok: true });
    for (const remaining of [3, 2, 1]) {
      const notice = buildAgentToolCallQuotaNotice(remaining, 12);
      expect(notice?.startsWith("[warning] ")).toBe(true);
      expect(notice).toContain(`当前剩余 ${remaining} 次`);
      expect(withAgentToolCallQuotaNotice({ ok: true, data: [] }, remaining, 12)).toEqual({
        ok: true,
        data: [],
        toolCallQuotaNotice: notice
      });
    }
  });

  it("较大上限时按比例提前注入提醒字符串", () => {
    expect(buildAgentToolCallQuotaNotice(11, 48)).toBeNull();
    const notice = buildAgentToolCallQuotaNotice(10, 48);
    expect(notice?.startsWith("[warning] ")).toBe(true);
    expect(notice).toContain("当前剩余 10 次");
    expect(withAgentToolCallQuotaNotice({ ok: true }, 10, 48).toolCallQuotaNotice).toBe(notice);
  });

  it("剩余 0 次时注入 critical 文案并告知没有可用次数", () => {
    const notice = buildAgentToolCallQuotaNotice(0, 12);
    expect(notice?.startsWith("[critical] ")).toBe(true);
    expect(notice).toContain("现在没有可用的工具调用次数了");
    expect(notice).toContain("直接总结作答");
    expect(withAgentToolCallQuotaNotice({ ok: true }, 0, 12).toolCallQuotaNotice).toBe(notice);
  });

  it("允许用满配置次数，仅拒绝超过剩余额度的工具批次", () => {
    expect(shouldRejectAgentToolCalls(10, 1, 12)).toBe(false);
    expect(shouldRejectAgentToolCalls(11, 1, 12)).toBe(false);
    expect(shouldRejectAgentToolCalls(11, 2, 12)).toBe(true);
    expect(shouldRejectAgentToolCalls(12, 1, 12)).toBe(true);
    expect(shouldRejectAgentToolCalls(0, 12, 12)).toBe(false);
    expect(shouldRejectAgentToolCalls(0, 13, 12)).toBe(true);
  });

  it("较低上限时也允许用完最后一次调用", () => {
    expect(shouldRejectAgentToolCalls(3, 1, 5)).toBe(false);
    expect(shouldRejectAgentToolCalls(4, 1, 5)).toBe(false);
    expect(shouldRejectAgentToolCalls(5, 1, 5)).toBe(true);
  });
});
