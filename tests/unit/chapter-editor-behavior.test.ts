import { describe, expect, it } from "vitest";
// @ts-expect-error 浏览器端模块没有单独的类型声明，测试仅调用纯函数导出。
import { CHAPTER_PARAGRAPH_INDENT, insertIndentedParagraph } from "../../src/public/chapter-editor-behavior.js";

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
});
