import { describe, expect, it } from "vitest";
// @ts-expect-error 浏览器端模块没有单独的类型声明，测试仅调用纯函数导出。
import { applyAiSkillCommand, findAiSkillCommand, listAiSkillOptions } from "../../src/public/ai-skill-menu.js";

describe("AI 输入框 Skill 候选", () => {
  it("在行首或空白后的斜杠命令处匹配并过滤候选", () => {
    expect(findAiSkillCommand("/")).toEqual({ start: 0, end: 1, query: "" });
    expect(findAiSkillCommand("请处理 /pol")).toEqual({ start: 4, end: 8, query: "pol" });
    expect(findAiSkillCommand("https://example.com/")).toBeNull();
    expect(listAiSkillOptions().map((item: { name: string }) => item.name)).toEqual([
      "continue-writing",
      "polish-writing"
    ]);
    expect(listAiSkillOptions("polish").map((item: { name: string }) => item.name)).toEqual(["polish-writing"]);
    expect(listAiSkillOptions("续写").map((item: { name: string }) => item.name)).toEqual(["continue-writing"]);
  });

  it("用选中的完整命令替换当前斜杠查询并保留后续文本", () => {
    const value = "请处理 /pol 后续";
    const match = findAiSkillCommand(value, 8);
    expect(applyAiSkillCommand(value, match, "polish-writing")).toEqual({
      text: "请处理 /polish-writing 后续",
      command: "/polish-writing",
      cursor: 19
    });
  });
});
