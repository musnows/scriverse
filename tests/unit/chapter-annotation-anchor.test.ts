import { describe, expect, it } from "vitest";
import { reanchorChapterAnnotations } from "../../src/chapter-annotation-anchor.js";

describe("正文评论行锚点", () => {
  it("在评论前插入或删除正文行时跟随原文移动", () => {
    const annotation = { id: "annotation-1", startLine: 2, endLine: 3, quote: "乙\n丙" };

    expect(reanchorChapterAnnotations(
      "甲\n乙\n丙\n丁",
      "新增一\n新增二\n甲\n乙\n丙\n丁",
      [annotation]
    )[0]).toMatchObject({ startLine: 4, endLine: 5, quote: "乙\n丙", changed: true });

    expect(reanchorChapterAnnotations(
      "新增一\n新增二\n甲\n乙\n丙\n丁",
      "甲\n乙\n丙\n丁",
      [{ ...annotation, startLine: 4, endLine: 5 }]
    )[0]).toMatchObject({ startLine: 2, endLine: 3, quote: "乙\n丙", changed: true });
  });

  it("评论原文被编辑时保留所在行并刷新引用", () => {
    expect(reanchorChapterAnnotations(
      "甲\n旧正文\n丙",
      "甲\n新正文\n丙",
      [{ id: "annotation-1", startLine: 2, endLine: 2, quote: "旧正文" }]
    )[0]).toMatchObject({ startLine: 2, endLine: 2, quote: "新正文", changed: true });
  });

  it("使用引用原文修复已经漂移的旧评论位置", () => {
    expect(reanchorChapterAnnotations(
      "甲\n乙\n目标行\n丙",
      "新增\n甲\n乙\n目标行\n丙",
      [{ id: "annotation-1", startLine: 2, endLine: 2, quote: "目标行" }]
    )[0]).toMatchObject({ startLine: 4, endLine: 4, quote: "目标行", changed: true });
  });

  it("引用原文重复时借助周边正文选择原来的位置", () => {
    expect(reanchorChapterAnnotations(
      "重复\n中间\n重复\n末尾",
      "新增\n重复\n中间\n重复\n末尾",
      [{ id: "annotation-1", startLine: 3, endLine: 3, quote: "重复" }]
    )[0]).toMatchObject({ startLine: 4, endLine: 4, quote: "重复", changed: true });
  });

  it("换行符变化不会误移动评论", () => {
    expect(reanchorChapterAnnotations(
      "甲\r\n乙",
      "甲\n乙",
      [{ id: "annotation-1", startLine: 2, endLine: 2, quote: "乙" }]
    )[0]).toMatchObject({ startLine: 2, endLine: 2, quote: "乙", changed: false });
  });
});
