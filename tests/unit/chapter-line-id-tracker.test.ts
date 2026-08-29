import { describe, expect, it } from "vitest";
import { MAX_CHAPTER_LINE_IDS, reconcileChapterLineIdDraft, remapChapterLineCounts } from "../../src/public/chapter-line-id-tracker.js";

describe("正文行身份跟踪", () => {
  it("删除两条相同正文中的第一条时保留第二条身份", () => {
    expect(reconcileChapterLineIdDraft(
      "相同正文\n相同正文",
      "相同正文",
      ["line-first", "line-second"],
      { selectionStart: 0, selectionEnd: 5, inputType: "deleteContentForward" }
    )).toEqual(["line-second"]);
  });

  it("删除两条相同正文中的第二条时保留第一条身份", () => {
    expect(reconcileChapterLineIdDraft(
      "相同正文\n相同正文",
      "相同正文",
      ["line-first", "line-second"],
      { selectionStart: 5, selectionEnd: 9, inputType: "deleteContentBackward" }
    )).toEqual(["line-first"]);
  });

  it("编辑第一条重复正文时分别保留两行身份", () => {
    expect(reconcileChapterLineIdDraft(
      "相同正文\n相同正文",
      "修改正文\n相同正文",
      ["line-first", "line-second"],
      { selectionStart: 0, selectionEnd: 4, inputType: "insertText" }
    )).toEqual(["line-first", "line-second"]);
  });

  it("在重复正文前插入新行时只给新行保留空身份", () => {
    expect(reconcileChapterLineIdDraft(
      "相同正文\n相同正文",
      "新增正文\n相同正文\n相同正文",
      ["line-first", "line-second"],
      { selectionStart: 0, selectionEnd: 0, inputType: "insertText" }
    )).toEqual([null, "line-first", "line-second"]);
  });

  it("超大行数正文跳过浏览器行身份跟踪", () => {
    expect(reconcileChapterLineIdDraft("", "\n".repeat(MAX_CHAPTER_LINE_IDS), ["line-first"]))
      .toEqual([]);
  });

  it("在评论前插入新行时立即把气泡移动到原正文的新行号", () => {
    expect(remapChapterLineCounts(
      ["line-first", "line-second"],
      [null, "line-first", "line-second"],
      new Map([[1, 2], [2, 1]])
    )).toEqual(new Map([[2, 2], [3, 1]]));
  });

  it("修改评论所在行的内容时保留该行气泡", () => {
    expect(remapChapterLineCounts(
      ["line-first", "line-second"],
      ["line-first", "line-second"],
      new Map([[2, 3]])
    )).toEqual(new Map([[2, 3]]));
  });

  it("没有稳定行身份时保留后端行号等待保存校准", () => {
    expect(remapChapterLineCounts([], [], new Map([[2, 1]])))
      .toEqual(new Map([[2, 1]]));
  });
});
