import { describe, expect, it } from "vitest";
// @ts-expect-error 浏览器端模块没有单独的类型声明，测试仅调用纯函数导出。
import { CHAPTER_PARAGRAPH_INDENT, calculateChapterCaretScroll, chapterLineIndexAtOffset, insertIndentedParagraph } from "../../src/public/chapter-editor-behavior.js";

describe("正文编辑器段落行为", () => {
  it("在光标处换行并插入两个全角空格", () => {
    expect(insertIndentedParagraph("第一段", 3, 3)).toEqual({
      value: `第一段\n${CHAPTER_PARAGRAPH_INDENT}`,
      selectionStart: 6,
      selectionEnd: 6
    });
  });

  it("用新段落替换选中文本并把光标放在缩进后", () => {
    expect(insertIndentedParagraph("第一段第二段", 3, 6)).toEqual({
      value: `第一段\n${CHAPTER_PARAGRAPH_INDENT}`,
      selectionStart: 6,
      selectionEnd: 6
    });
  });

  it("约束越界的选区位置", () => {
    expect(insertIndentedParagraph("正文", -10, 99)).toEqual({
      value: `\n${CHAPTER_PARAGRAPH_INDENT}`,
      selectionStart: 3,
      selectionEnd: 3
    });
  });

  it("按光标偏移定位逻辑行", () => {
    expect(chapterLineIndexAtOffset("甲\n乙\n丙", 0)).toBe(0);
    expect(chapterLineIndexAtOffset("甲\n乙\n丙", 4)).toBe(2);
    expect(chapterLineIndexAtOffset("甲\n乙\n丙", 99)).toBe(2);
  });

  it("光标超过视口六成后滚到中部", () => {
    expect(calculateChapterCaretScroll({
      caretBottom: 650,
      scrollTop: 100,
      clientHeight: 800,
      scrollHeight: 1800
    })).toBe(250);
  });

  it("光标仍在上半视口或正文无需滚动时保持位置", () => {
    expect(calculateChapterCaretScroll({
      caretBottom: 560,
      scrollTop: 100,
      clientHeight: 800,
      scrollHeight: 1800
    })).toBe(100);
    expect(calculateChapterCaretScroll({
      caretBottom: 650,
      scrollTop: 0,
      clientHeight: 800,
      scrollHeight: 800
    })).toBe(0);
  });

  it("滚动位置不超过正文底部", () => {
    expect(calculateChapterCaretScroll({
      caretBottom: 1750,
      scrollTop: 900,
      clientHeight: 800,
      scrollHeight: 1800
    })).toBe(1000);
  });
});
