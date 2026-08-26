import { describe, expect, it } from "vitest";
import { collapseExcessBlankLines, normalizeParagraphSpacing } from "../../src/public/text-formatting.js";

describe("正文排版整理", () => {
  it("把段间连续空行压缩为一个并清理首尾空行", () => {
    expect(normalizeParagraphSpacing("\n\n第一段。\n \n\t\n\n第二段。\n\n"))
      .toBe("第一段。\n\n第二段。");
  });

  it("保留段内单换行和已经规范的段间距", () => {
    expect(normalizeParagraphSpacing("第一行\n第二行\n\n下一段"))
      .toBe("第一行\n第二行\n\n下一段");
  });

  it("把全角空格、不换行空格和字节序标记组成的伪空行一并清理", () => {
    expect(normalizeParagraphSpacing("第一段。\r\n　\r\n\u00a0\r\n\uFEFF\r\n第二段。"))
      .toBe("第一段。\n\n第二段。");
  });

  it("整理时压缩多余空行并保留正在编辑的段尾空行", () => {
    expect(collapseExcessBlankLines("第一段。\n \n\t\n\n第二段。"))
      .toBe("第一段。\n\n第二段。");
    expect(collapseExcessBlankLines("第一段。\n\n"))
      .toBe("第一段。\n\n");
  });
});
