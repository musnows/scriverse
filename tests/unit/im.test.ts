import { describe, expect, it } from "vitest";
import { parseImMentions } from "../../src/im.js";

describe("IM mention URI", () => {
  it("按正文顺序解析带参与者类型的 canonical URI", () => {
    expect(parseImMentions("请 mention://character/character_1 联系 mention://user/user-2。"))
      .toEqual([
        expect.objectContaining({ kind: "character", id: "character_1" }),
        expect.objectContaining({ kind: "user", id: "user-2" })
      ]);
  });

  it("拒绝缺少类型、包含路径分隔符或超长的 mention", () => {
    expect(parseImMentions("mention://character_1 mention://character/a/b mention://other/user-1")).toEqual([
      expect.objectContaining({ kind: "character", id: "a" })
    ]);
  });
});
