import { describe, expect, it } from "vitest";
import {
  composeRoleplayCurrentUserTurn,
  composeRoleplayStoredUserContent,
  formatRoleplayScenePinText,
  normalizeRoleplayScenePin,
  parseRoleplayUserTurn,
  roleplayScenePinHasContent,
  roleplayUserTurnTitleSource
} from "../../src/roleplay-turn.js";
// @ts-expect-error 浏览器端模块没有单独的类型声明，测试仅调用纯函数导出。
import * as frontend from "../../src/public/roleplay-turn.js";

describe("角色扮演回合 XML", () => {
  it("把旁白放在 user_message 之前，无旁白时存储原文", () => {
    expect(composeRoleplayStoredUserContent("", "你还要走吗？")).toBe("你还要走吗？");
    expect(composeRoleplayCurrentUserTurn("", "你还要走吗？")).toBe("<user_message>\n你还要走吗？\n</user_message>");
    expect(composeRoleplayCurrentUserTurn("夜雨刚停。", "你还要走吗？")).toBe([
      "<scene_direction>",
      "夜雨刚停。",
      "</scene_direction>",
      "",
      "<user_message>",
      "你还要走吗？",
      "</user_message>"
    ].join("\n"));
    expect(composeRoleplayStoredUserContent("夜雨刚停。", "")).toBe("<scene_direction>\n夜雨刚停。\n</scene_direction>");
  });

  it("转义旁白中的 XML 特殊字符并在解析时还原", () => {
    const stored = composeRoleplayStoredUserContent("灯下写着 A & B <夜航>", "跟我走。");
    expect(stored).toContain("A &amp; B &lt;夜航>");
    expect(stored).not.toContain("<夜航>");
    expect(parseRoleplayUserTurn(stored)).toEqual({
      sceneDirection: "灯下写着 A & B <夜航>",
      userMessage: "跟我走。",
      hasMarkup: true
    });
  });

  it("旧消息没有旁白标签时保持原样", () => {
    expect(parseRoleplayUserTurn("你还要走吗？")).toEqual({
      sceneDirection: "",
      userMessage: "你还要走吗？",
      hasMarkup: false
    });
    expect(roleplayUserTurnTitleSource("<scene_direction>\n夜雨刚停。\n</scene_direction>\n\n<user_message>\n你还要走吗？\n</user_message>")).toBe("你还要走吗？");
    expect(roleplayUserTurnTitleSource("<scene_direction>\n夜雨刚停。\n</scene_direction>")).toBe("夜雨刚停。");
    expect(roleplayUserTurnTitleSource("你还要走吗？")).toBe("你还要走吗？");
  });

  it("格式化会话场景钉并忽略空字段", () => {
    expect(formatRoleplayScenePinText({
      location: " 北港码头 ",
      present: "林舟、顾潮",
      timeLabel: "远航第 12 日黄昏"
    })).toBe("地点：北港码头\n在场：林舟、顾潮\n故事时间：远航第 12 日黄昏");
    expect(roleplayScenePinHasContent(normalizeRoleplayScenePin({ location: "  " }))).toBe(false);
    expect(roleplayScenePinHasContent(normalizeRoleplayScenePin({ location: "北港" }))).toBe(true);
  });

  it("前后端纯函数保持同一契约", () => {
    const scene = "潮水拍上木桩。";
    const speech = "别回头。";
    expect(frontend.composeRoleplayCurrentUserTurn(scene, speech)).toBe(composeRoleplayCurrentUserTurn(scene, speech));
    expect(frontend.parseRoleplayUserTurn(composeRoleplayStoredUserContent(scene, speech))).toEqual(
      parseRoleplayUserTurn(composeRoleplayStoredUserContent(scene, speech))
    );
  });
});
