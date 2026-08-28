import { describe, expect, it } from "vitest";
import {
  chapterAnnotationLineHashes,
  parseChapterAnnotationLineHashes,
  reanchorChapterAnnotations,
  type ChapterAnnotationAnchor
} from "../../src/chapter-annotation-anchor.js";

function anchor(input: Omit<ChapterAnnotationAnchor, "id" | "lineHashes"> & { lineHashesFrom?: string }): ChapterAnnotationAnchor {
  return {
    id: "annotation-1",
    startLine: input.startLine,
    endLine: input.endLine,
    quote: input.quote,
    lineHashes: chapterAnnotationLineHashes(input.lineHashesFrom ?? input.quote)
  };
}

describe("正文评论行锚点", () => {
  it("优先通过逐行哈希将评论精准移动到唯一命中的原文", () => {
    const result = reanchorChapterAnnotations(
      "甲\n乙\n丙\n丁",
      "新增一\n新增二\n甲\n乙\n丙\n丁",
      [anchor({ startLine: 2, endLine: 3, quote: "已经过时的引用", lineHashesFrom: "乙\n丙" })]
    )[0];

    expect(result).toMatchObject({
      startLine: 4,
      endLine: 5,
      quote: "乙\n丙",
      anchorStrategy: "hash",
      changed: true
    });
  });

  it("删除评论前的正文行时通过哈希跟随原文上移", () => {
    expect(reanchorChapterAnnotations(
      "新增一\n新增二\n甲\n乙\n丙\n丁",
      "甲\n乙\n丙\n丁",
      [anchor({ startLine: 4, endLine: 5, quote: "乙\n丙" })]
    )[0]).toMatchObject({ startLine: 2, endLine: 3, quote: "乙\n丙", anchorStrategy: "hash", changed: true });
  });

  it("评论原文被编辑时使用兜底定位并立刻刷新行哈希", () => {
    const result = reanchorChapterAnnotations(
      "甲\n旧正文\n丙",
      "甲\n新正文\n丙",
      [anchor({ startLine: 2, endLine: 2, quote: "旧正文" })]
    )[0];

    expect(result).toMatchObject({
      startLine: 2,
      endLine: 2,
      quote: "新正文",
      lineHashes: chapterAnnotationLineHashes("新正文"),
      anchorStrategy: "fallback",
      changed: true
    });
    expect(result?.lineHashes).not.toEqual(chapterAnnotationLineHashes("旧正文"));
  });

  it("行哈希重复时使用现有位置映射消除歧义", () => {
    expect(reanchorChapterAnnotations(
      "重复\n中间\n重复\n末尾",
      "新增\n重复\n中间\n重复\n末尾",
      [anchor({ startLine: 3, endLine: 3, quote: "重复" })]
    )[0]).toMatchObject({ startLine: 4, endLine: 4, quote: "重复", anchorStrategy: "fallback", changed: true });
  });

  it("使用引用原文兜底修复缺失哈希的旧评论位置", () => {
    expect(reanchorChapterAnnotations(
      "甲\n乙\n目标行\n丙",
      "新增\n甲\n乙\n目标行\n丙",
      [{ id: "annotation-1", startLine: 2, endLine: 2, quote: "目标行", lineHashes: [] }]
    )[0]).toMatchObject({
      startLine: 4,
      endLine: 4,
      quote: "目标行",
      lineHashes: chapterAnnotationLineHashes("目标行"),
      anchorStrategy: "fallback",
      changed: true
    });
  });

  it("换行符变化不会误移动评论或更新哈希", () => {
    expect(reanchorChapterAnnotations(
      "甲\r\n乙",
      "甲\n乙",
      [anchor({ startLine: 2, endLine: 2, quote: "乙" })]
    )[0]).toMatchObject({ startLine: 2, endLine: 2, quote: "乙", anchorStrategy: "hash", changed: false });
  });

  it("无效的持久化哈希会根据引用原文重新生成", () => {
    expect(parseChapterAnnotationLineHashes("[]", "甲\n乙"))
      .toEqual(chapterAnnotationLineHashes("甲\n乙"));
    expect(parseChapterAnnotationLineHashes('["invalid"]', "甲"))
      .toEqual(chapterAnnotationLineHashes("甲"));
  });
});
