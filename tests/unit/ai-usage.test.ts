import { describe, expect, it } from "vitest";
import { buildUsageCalendar, formatCacheHitRate, formatEstimatedCost, formatTokenCount } from "../../src/public/ai-usage.js";

describe("AI 用量日历", () => {
  it("生成按周排列的 GitHub 风格年度网格", () => {
    const calendar = buildUsageCalendar([
      { date: "2026-07-25", totalTokens: 25 },
      { date: "2026-07-26", totalTokens: 100 },
      { date: "2026-07-27", totalTokens: 400 }
    ], new Date("2026-07-27T12:00:00"), 2);
    expect(calendar.cells).toHaveLength(14);
    expect(calendar.cells[0]).toMatchObject({ date: "2026-07-19", week: 0, weekday: 0 });
    expect(calendar.cells.find((cell) => cell.date === "2026-07-27")).toMatchObject({
      totalTokens: 400,
      level: 4,
      future: false
    });
    expect(calendar.cells.at(-1)).toMatchObject({ date: "2026-08-01", future: true, level: 0 });
  });

  it("格式化总量与缓存命中率", () => {
    expect(formatTokenCount(9999)).toBe("9,999");
    expect(formatTokenCount(12000)).toBe("1.2万");
    expect(formatTokenCount(100_000_000)).toBe("1.00亿");
    expect(formatTokenCount(104_915_676)).toBe("1.05亿");
    expect(formatTokenCount(937_130_000)).toBe("9.37亿");
    expect(formatCacheHitRate(46.7)).toBe("46.7%");
    expect(formatCacheHitRate(null)).toBe("暂无数据");
    expect(formatEstimatedCost(0.000039)).toBe("$0.000039");
    expect(formatEstimatedCost(0)).toBe("$0.00");
    expect(formatEstimatedCost(null)).toBe("暂无价格");
  });
});
