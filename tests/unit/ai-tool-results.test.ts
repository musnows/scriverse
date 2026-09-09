import { describe, expect, it } from "vitest";
import {
  AGENT_TOOL_RESULT_MAX_CHARS,
  paginateToolResultRecords,
  restoreAgentToolCallQuotaUsed,
  serializedToolResultChars,
  structuralToolResultRecords
} from "../../src/ai-tool-results.js";

describe("AI tool continuation quota", () => {
  it("preserves used quota when no compaction occurred, including legacy metadata", () => {
    expect(restoreAgentToolCallQuotaUsed(11, [], 12)).toBe(11);
    expect(restoreAgentToolCallQuotaUsed(2, [{ type: "tool" }, { type: "thinking" }, { type: "tool" }], 12)).toBe(2);
  });

  it("counts only tool executions after the latest compaction", () => {
    expect(restoreAgentToolCallQuotaUsed(31, [
      { type: "tool" }, { type: "context_compaction" }, { type: "tool" },
      { type: "context_compaction" }, { type: "thinking" }, { type: "tool" },
      { type: "intermediate" }, { type: "tool" }
    ], 12)).toBe(4);
  });

  it("preserves the reset when compaction happened after the question result", () => {
    expect(restoreAgentToolCallQuotaUsed(31, [{ type: "tool" }, { type: "context_compaction" }], 12)).toBe(2);
  });
});

describe("AI 工具结果分页", () => {
  it("在完整列表元素边界内限制单页字符数并通过游标续读", () => {
    const source = Array.from({ length: 10 }, (_, index) => ({ id: `item-${index}`, content: `${index}`.repeat(1_050) }));
    const records = structuralToolResultRecords(source);
    const build = (page: Record<string, unknown>[], pagination: { cursor: number; nextCursor: number | null; maxChars: number }) => ({
      ok: true,
      data: { items: page },
      pagination
    });
    const first = paginateToolResultRecords(records, 0, build) as {
      data: { items: Array<{ id: string; content: string }> };
      pagination: { nextCursor: number | null };
    };

    expect(serializedToolResultChars(first)).toBeLessThanOrEqual(AGENT_TOOL_RESULT_MAX_CHARS);
    expect(first.data.items.length).toBeLessThan(source.length);
    expect(first.data.items).toEqual(source.slice(0, first.data.items.length));
    expect(first.pagination.nextCursor).toBe(first.data.items.length);

    const second = paginateToolResultRecords(records, first.pagination.nextCursor ?? 0, build) as {
      data: { items: Array<{ id: string; content: string }> };
      pagination: { nextCursor: number | null };
    };
    expect(serializedToolResultChars(second)).toBeLessThanOrEqual(AGENT_TOOL_RESULT_MAX_CHARS);
    expect([...first.data.items, ...second.data.items]).toEqual(source);
    expect(second.pagination.nextCursor).toBeNull();
  });

  it("单个记录过大时优先按嵌套数组元素拆分并保留片段信息", () => {
    const details = Array.from({ length: 12 }, (_, index) => ({ index, text: `片段${index}`.repeat(350) }));
    const fragments = structuralToolResultRecords([{ id: "large-item", title: "超大记录", details }]);

    expect(fragments.length).toBeGreaterThan(1);
    expect(fragments.every((fragment) => serializedToolResultChars(fragment) <= 6_000)).toBe(true);
    expect(fragments.every((fragment) => fragment.id === "large-item" && fragment._fragment)).toBe(true);
    expect(fragments.flatMap((fragment) => fragment.details as typeof details)).toEqual(details);
  });

  it("单个长文本字段按合法字符串片段分页而不截断 JSON", () => {
    const content = "超长正文。".repeat(4_000);
    const fragments = structuralToolResultRecords([{ chapterId: "chapter-1", title: "第一章", content }]);
    const restored = fragments.map((fragment) => String(fragment.content ?? "")).join("");

    expect(fragments.length).toBeGreaterThan(1);
    expect(restored).toBe(content);
    expect(fragments.every((fragment) => {
      expect(() => JSON.parse(JSON.stringify(fragment))).not.toThrow();
      return serializedToolResultChars(fragment) <= 6_000;
    })).toBe(true);
  });
});
