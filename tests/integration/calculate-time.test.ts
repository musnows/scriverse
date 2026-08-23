import { afterEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime, seedChapter } from "../helpers.js";

type AgentToolExecutor = (
  candidateWorkId: string,
  toolCall: Record<string, unknown>,
  maximumResultChars?: number,
  roleplayCharacterId?: string | null,
  allowedToolIds?: ReadonlySet<string>
) => Promise<Record<string, unknown>>;

describe("AI 时间计算工具", () => {
  let runtime: Runtime | null = null;

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
    vi.restoreAllMocks();
  });

  function buildToolCall(args: Record<string, unknown>): Record<string, unknown> {
    return {
      id: "test-calculate-time",
      type: "function",
      function: {
        name: "calculate_time",
        arguments: JSON.stringify(args)
      }
    };
  }

  async function execute(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    runtime = createTestRuntime();
    const seeded = await seedChapter(runtime, "测试章节。");
    const executeAgentTool = (runtime.ai as unknown as { executeAgentTool: AgentToolExecutor }).executeAgentTool;
    return executeAgentTool.call(runtime.ai, String(seeded.work.id), buildToolCall(args));
  }

  function readData(execution: Record<string, unknown>): Record<string, unknown> {
    const result = execution.result as Record<string, unknown>;
    expect(result.ok).toBe(true);
    return result.data as Record<string, unknown>;
  }

  it("使用两个 YYYY-MM-DD 参数计算日期差", async () => {
    const execution = await execute({ startDate: "2024-01-01", endDate: "2024-12-31" });

    expect(execution.status).toBe("completed");
    expect(execution.arguments).toEqual({ startDate: "2024-01-01", endDate: "2024-12-31" });
    const data = readData(execution);
    expect(data.startDate).toBe("2024-01-01");
    expect(data.endDate).toBe("2024-12-31");
    expect(data.totalDays).toBe(365);
    expect(data.absoluteDays).toBe(365);
    expect(data.direction).toBe("forward");
  });

  it("处理反向日期并保持年月日分解方向一致", async () => {
    const execution = await execute({ startDate: "2025-06-15", endDate: "2025-06-10" });

    expect(execution.status).toBe("completed");
    const data = readData(execution);
    expect(data.totalDays).toBe(-5);
    expect(data.absoluteDays).toBe(5);
    expect(data.direction).toBe("backward");
    expect(data.ymdBreakdown).toEqual({ years: 0, months: 0, days: -5 });
  });

  it("正确处理闰年以及公元 0 年和早期年份", async () => {
    const leapYearExecution = await execute({ startDate: "2024-01-01", endDate: "2024-03-01" });
    expect(readData(leapYearExecution).totalDays).toBe(60);

    const earlyYearExecution = await execute({ startDate: "0001-01-01", endDate: "0100-01-01" });
    expect(readData(earlyYearExecution).totalDays).toBe(36159);

    const yearZeroExecution = await execute({ startDate: "0000-02-29", endDate: "0000-03-01" });
    expect(readData(yearZeroExecution).totalDays).toBe(1);

    const beforeCommonEraExecution = await execute({ startDate: "-0001-01-01", endDate: "0000-01-01" });
    expect(readData(beforeCommonEraExecution).totalDays).toBe(365);
  });

  it("同一天的日期差为零", async () => {
    const execution = await execute({ startDate: "2025-06-15", endDate: "2025-06-15" });

    const data = readData(execution);
    expect(data.totalDays).toBe(0);
    expect(data.direction).toBe("forward");
    expect(data.note).toBe("两个日期相同");
  });

  it("非法日历日期应返回失败", async () => {
    const execution = await execute({ startDate: "2024-02-30", endDate: "2024-03-01" });

    expect(execution.status).toBe("failed");
    const result = execution.result as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect((result.error as Record<string, unknown>).code).toBe("INVALID_DATE");
  });

  it("非法格式、缺少参数和旧 add 参数应返回失败", async () => {
    const invalidFormat = await execute({ startDate: "2024-1-01", endDate: "2024-03-01" });
    const invalidFormatResult = invalidFormat.result as Record<string, unknown>;
    expect(invalidFormat.status).toBe("failed");
    expect((invalidFormatResult.error as Record<string, unknown>).code).toBe("TOOL_ARGUMENTS_INVALID");

    const missingEndDate = await execute({ startDate: "2024-01-01" });
    const missingEndDateResult = missingEndDate.result as Record<string, unknown>;
    expect(missingEndDate.status).toBe("failed");
    expect((missingEndDateResult.error as Record<string, unknown>).code).toBe("TOOL_ARGUMENTS_INVALID");

    const oldAddArguments = await execute({
      operation: "add",
      startYear: 2024,
      startMonth: 1,
      startDay: 1,
      addDays: 1
    });
    const oldAddResult = oldAddArguments.result as Record<string, unknown>;
    expect(oldAddArguments.status).toBe("failed");
    expect((oldAddResult.error as Record<string, unknown>).code).toBe("TOOL_ARGUMENTS_INVALID");
  });
});
