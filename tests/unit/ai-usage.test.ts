import { describe, expect, it } from "vitest";
import { buildUsageCalendar, formatCacheHitRate, formatEstimatedCost, formatTokenCount, usageCalendarYears } from "../../src/public/ai-usage.js";

describe("AI 用量日历", () => {
  it("生成按周排列的 GitHub 风格年度网格", () => {
    const calendar = buildUsageCalendar([
      { date: "2026-07-25", totalTokens: 25 },
      { date: "2026-07-26", totalTokens: 100 },
      { date: "2026-07-27", totalTokens: 400 }
    ], 2026, "2026-07-27");
    expect(calendar.cells).toHaveLength(371);
    expect(calendar.cells[0]).toMatchObject({ date: "2025-12-28", week: 0, weekday: 0, outsideYear: true });
    expect(calendar.cells.find((cell) => cell.date === "2026-01-01")).toMatchObject({ week: 0, weekday: 4, outsideYear: false });
    expect(calendar.cells.find((cell) => cell.date === "2026-07-27")).toMatchObject({
      totalTokens: 400,
      level: 4,
      outsideYear: false,
      future: false
    });
    expect(calendar.cells.find((cell) => cell.date === "2026-07-28")).toMatchObject({ future: true, level: 0 });
    expect(calendar.cells.at(-1)).toMatchObject({ date: "2027-01-02", outsideYear: true, level: 0 });
    expect(calendar.months).toHaveLength(12);
    expect(calendar.months[0]).toEqual({ week: 0, label: "1月" });
    expect(calendar.year).toBe(2026);
  });

  it("只列出存在实际用量的年份并按新到旧排序", () => {
    expect(usageCalendarYears([
      { date: "2024-12-31", totalTokens: 10 },
      { date: "2025-01-01", totalTokens: 0 },
      { date: "2026-01-01", totalTokens: 20 },
      { date: "2026-08-30", totalTokens: 30 },
      { date: "invalid", totalTokens: 40 }
    ])).toEqual([2026, 2024]);
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
