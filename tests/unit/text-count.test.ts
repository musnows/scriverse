import { describe, expect, it } from "vitest";
import { countProseWords } from "../../src/public/text-count.js";
import { countWords } from "../../src/utils.js";

describe("正文前端字数统计", () => {
  it.each([
    ["你好，world 2026", 4],
    ["第一段。\n\nSecond paragraph!", 5],
    ["标点：，。！？；……", 2],
    ["", 0]
  ])("与后端使用相同口径：%s", (text, expected) => {
    expect(countProseWords(text)).toBe(expected);
    expect(countProseWords(text)).toBe(countWords(text));
  });
});
