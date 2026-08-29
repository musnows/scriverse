import { describe, expect, it } from "vitest";
import {
  AI_SKILLS,
  aiSkillPromptText,
  matchAiWritingSkill,
  parseAiSkillMarkdown,
  renderAiSkillsPrompt
} from "../../src/ai-skills.js";

describe("AI writing skills", () => {
  it("loads valid SKILL.md metadata and instructions", () => {
    expect(AI_SKILLS.map((skill) => skill.name)).toEqual(["continue-writing", "polish-writing"]);
    expect(AI_SKILLS.every((skill) => skill.description.length > 0 && skill.instructions.includes("## 要求"))).toBe(true);
  });

  it("rejects unsupported or incomplete skill packages", () => {
    expect(() => parseAiSkillMarkdown("# missing frontmatter")).toThrow(/frontmatter/u);
    expect(() => parseAiSkillMarkdown("---\nname: unknown-skill\ndescription: test\n---\nbody"))
      .toThrow(/Unsupported AI skill name/u);
    expect(() => parseAiSkillMarkdown("---\nname: continue-writing\ndescription:\n---\nbody"))
      .toThrow(/invalid description/u);
  });

  it("matches writing actions but keeps discussion in ordinary chat", () => {
    expect(matchAiWritingSkill("续写当前章节，保持人物状态。")?.name).toBe("continue-writing");
    expect(matchAiWritingSkill("续写离港场景")?.name).toBe("continue-writing");
    expect(matchAiWritingSkill("请续写并解决上一段的问题")?.name).toBe("continue-writing");
    expect(matchAiWritingSkill("请接着写一段夜航情节")?.name).toBe("continue-writing");
    expect(matchAiWritingSkill("帮我润色这段文字")?.name).toBe("polish-writing");
    expect(matchAiWritingSkill("润色第二段")?.name).toBe("polish-writing");
    expect(matchAiWritingSkill("优化选中文本的文笔")?.name).toBe("polish-writing");
    expect(matchAiWritingSkill("续写模块为什么有 bug？")).toBeNull();
    expect(matchAiWritingSkill("请继续说明你的判断")).toBeNull();
  });

  it("keeps metadata discoverable and loads only the matched skill body", () => {
    const ordinary = renderAiSkillsPrompt("讨论后续剧情方向");
    expect(ordinary).toContain("<available_skills>");
    expect(ordinary).toContain("continue-writing");
    expect(ordinary).toContain("polish-writing");
    expect(ordinary).not.toContain("<active_skills>");

    const active = renderAiSkillsPrompt("续写本章");
    expect(active).toContain("<active_skills>");
    expect(active).toContain("# 续写正文");
    expect(active).not.toContain("# 润色选中文本");
    expect(aiSkillPromptText(`<system_prompt>\n<skills>\n${active}\n</skills>\n</system_prompt>`)).toBe(active);
  });
});
