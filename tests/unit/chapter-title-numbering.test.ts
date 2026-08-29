import { describe, expect, it } from "vitest";
import {
  chapterTitleWithoutNumber,
  formatChapterNumber,
  isChapterNumberTemplate,
  renumberChapterTitle
} from "../../src/chapter-title-numbering.js";

describe("章节标题序号重排", () => {
  it("校验单个序号占位符和安全长度", () => {
    expect(isChapterNumberTemplate("第{n}章")).toBe(true);
    expect(isChapterNumberTemplate("Chapter {n}:")).toBe(true);
    expect(isChapterNumberTemplate("第1章")).toBe(false);
    expect(isChapterNumberTemplate("{n}-{n}")).toBe(false);
    expect(isChapterNumberTemplate("第{n}章\n")).toBe(false);
    expect(isChapterNumberTemplate(`${"章".repeat(50)}{n}`)).toBe(false);
  });

  it("输出阿拉伯数字和常用中文数字", () => {
    expect(formatChapterNumber(12, "arabic")).toBe("12");
    expect([
      1,
      10,
      11,
      20,
      101,
      1_001,
      10_010,
      100_000,
      999_999
    ].map((value) => formatChapterNumber(value, "chinese"))).toEqual([
      "一",
      "十",
      "十一",
      "二十",
      "一百零一",
      "一千零一",
      "一万零一十",
      "十万",
      "九十九万九千九百九十九"
    ]);
  });

  it("只清洗可识别的旧序号并保留异常标题", () => {
    expect(chapterTitleWithoutNumber("第十二章：旧城")).toBe("旧城");
    expect(chapterTitleWithoutNumber("Chapter 77 - Return")).toBe("Return");
    expect(chapterTitleWithoutNumber("003、远航")).toBe("远航");
    expect(chapterTitleWithoutNumber("第X章 异常编号")).toBe("第X章 异常编号");
    expect(chapterTitleWithoutNumber("序章")).toBe("序章");
  });

  it("按指定模板生成统一标题并规范副标题间距", () => {
    expect(renumberChapterTitle("第九章： 旧城", 1, "第{n}章", "chinese")).toBe("第一章 旧城");
    expect(renumberChapterTitle("Chapter 9", 2, "第{n}章", "arabic")).toBe("第2章");
    expect(renumberChapterTitle("序章", 3, "Chapter {n}:", "arabic")).toBe("Chapter 3: 序章");
    expect(renumberChapterTitle("第X章 异常编号", 4, "第{n}章", "chinese")).toBe("第四章 第X章 异常编号");
  });
});
