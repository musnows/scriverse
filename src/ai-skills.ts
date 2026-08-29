import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const AI_WRITING_SKILL_NAMES = ["continue-writing", "polish-writing"] as const;
export type AiWritingSkillName = typeof AI_WRITING_SKILL_NAMES[number];

export type AiSkill = {
  name: AiWritingSkillName;
  description: string;
  instructions: string;
};

export type AiWritingSkillResolution = {
  skill: AiSkill | null;
  explicitSkillNames: AiWritingSkillName[];
  unknownSkillNames: string[];
  cleanedInstruction: string;
};

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const CONTINUE_WRITING_INTENT_PATTERNS = [
  /(?:^|[，。！？；：\s])(?:请|帮我|给我|直接|开始|继续)?续写/u,
  /(?:继续|接着|往下)(?:写|创作)(?:$|[，。！？；：\s]|当前|本|这|一|下)/u
];
const POLISH_WRITING_INTENT_PATTERNS = [
  /(?:^|[，。！？；：\s])(?:请|帮我|给我|直接|开始)?润色/u,
  /(?:优化|调整|改写)(?:一下|当前|这段|选中|下面)?(?:文字|文本|正文|文笔|表达|句子|段落)/u
];
const DISCUSSION_ONLY_PATTERNS = [
  /(?:续写|润色)(?:功能|模块|模式|按钮|选项|机制|接口|bug|缺陷)/iu,
  /(?:功能|模块|模式|按钮|选项|机制|接口|bug|缺陷)(?:里的|中的|这个|这项|的)?(?:续写|润色)/iu,
  /(?:为什么|怎么用|有没有意义).*(?:续写|润色)|(?:续写|润色).*(?:为什么|怎么用|有没有意义)/u,
  /(?:评价|分析|比较|讨论|解释|说明)(?:这次|这个|一下)?(?:续写|润色)/u
];
const AI_SKILL_REFERENCE_PATTERN = /(^|\s)\/skills[ \t]+([^\s，。！？；：,.!?;:]+)/gimu;
const AI_WRITING_SKILL_ALIASES: Readonly<Record<string, AiWritingSkillName>> = {
  "continue-writing": "continue-writing",
  "续写": "continue-writing",
  "续写正文": "continue-writing",
  "polish-writing": "polish-writing",
  "润色": "polish-writing",
  "润色选中文本": "polish-writing"
};

function parseFrontmatter(frontmatter: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of frontmatter.split(/\r?\n/u)) {
    const match = line.match(/^([a-z][a-z0-9-]*):\s*(.+)$/u);
    if (!match) continue;
    result[match[1]!] = match[2]!.trim().replace(/^(["'])(.*)\1$/u, "$2");
  }
  return result;
}

export function parseAiSkillMarkdown(markdown: string): AiSkill {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/u);
  if (!match) throw new Error("AI skill must contain YAML frontmatter and instructions.");
  const metadata = parseFrontmatter(match[1]!);
  const name = metadata.name ?? "";
  const description = metadata.description ?? "";
  const instructions = match[2]!.trim();
  if (!SKILL_NAME_PATTERN.test(name) || name.length > 64 || !AI_WRITING_SKILL_NAMES.includes(name as AiWritingSkillName)) {
    throw new Error(`Unsupported AI skill name: ${name || "(empty)"}`);
  }
  if (!description || description.length > 1_024) throw new Error(`AI skill '${name}' has an invalid description.`);
  if (!instructions) throw new Error(`AI skill '${name}' has no instructions.`);
  return { name: name as AiWritingSkillName, description, instructions };
}

function loadAiSkills(directory: string): AiSkill[] {
  const skills = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(directory, entry.name, "SKILL.md"))
    .filter((path) => statSync(path).isFile())
    .map((path) => parseAiSkillMarkdown(readFileSync(path, "utf8")));
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  for (const name of AI_WRITING_SKILL_NAMES) {
    if (!byName.has(name)) throw new Error(`Required AI skill is missing: ${name}`);
  }
  return AI_WRITING_SKILL_NAMES.map((name) => byName.get(name)!);
}

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
export const AI_SKILLS = loadAiSkills(join(moduleDirectory, "skills"));

function semanticallyMatchedAiWritingSkill(instruction: string): AiSkill | null {
  const normalized = instruction.normalize("NFKC").trim();
  if (!normalized || DISCUSSION_ONLY_PATTERNS.some((pattern) => pattern.test(normalized))) return null;
  const matches: Array<{ name: AiWritingSkillName; index: number }> = [];
  for (const [name, patterns] of [
    ["continue-writing", CONTINUE_WRITING_INTENT_PATTERNS],
    ["polish-writing", POLISH_WRITING_INTENT_PATTERNS]
  ] as const) {
    const indexes = patterns.map((pattern) => normalized.search(pattern)).filter((index) => index >= 0);
    if (indexes.length > 0) matches.push({ name, index: Math.min(...indexes) });
  }
  matches.sort((left, right) => left.index - right.index);
  const matchedName = matches[0]?.name;
  return matchedName ? AI_SKILLS.find((skill) => skill.name === matchedName) ?? null : null;
}

export function resolveAiWritingSkill(instruction: string): AiWritingSkillResolution {
  const explicitSkillNames: AiWritingSkillName[] = [];
  const unknownSkillNames: string[] = [];
  const cleanedInstruction = instruction.replace(
    AI_SKILL_REFERENCE_PATTERN,
    (_matched, prefix: string, referencedName: string) => {
      const normalizedName = referencedName.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
      const skillName = AI_WRITING_SKILL_ALIASES[normalizedName];
      if (skillName) {
        if (!explicitSkillNames.includes(skillName)) explicitSkillNames.push(skillName);
      } else if (!unknownSkillNames.includes(referencedName)) {
        unknownSkillNames.push(referencedName);
      }
      return prefix;
    }
  ).replace(/[ \t]+\n/gu, "\n")
    .replace(/\s+([，。！？；：,.!?;:])/gu, "$1")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  const matchedName = explicitSkillNames[0];
  return {
    skill: matchedName
      ? AI_SKILLS.find((skill) => skill.name === matchedName) ?? null
      : semanticallyMatchedAiWritingSkill(cleanedInstruction),
    explicitSkillNames,
    unknownSkillNames,
    cleanedInstruction
  };
}

export function matchAiWritingSkill(instruction: string): AiSkill | null {
  return resolveAiWritingSkill(instruction).skill;
}

export function renderAiSkillsPrompt(instruction: string, forcedSkillName?: AiWritingSkillName): string {
  const activeSkill = forcedSkillName
    ? AI_SKILLS.find((skill) => skill.name === forcedSkillName) ?? null
    : resolveAiWritingSkill(instruction).skill;
  const available = AI_SKILLS.map((skill) => [
    "<skill>",
    `<name>${skill.name}</name>`,
    `<description>${skill.description}</description>`,
    "</skill>"
  ].join("\n")).join("\n");
  const active = activeSkill
    ? [
        "<active_skill>",
        `<name>${activeSkill.name}</name>`,
        activeSkill.instructions,
        "</active_skill>"
      ].join("\n")
    : "";
  return [
    "<available_skills>",
    available,
    "</available_skills>",
    active ? `<active_skills>\n${active}\n</active_skills>` : ""
  ].filter(Boolean).join("\n\n");
}

export function aiSkillPromptText(systemPrompt: string): string {
  return [...systemPrompt.matchAll(/<skills>\n([\s\S]*?)\n<\/skills>/gu)]
    .map((match) => match[1] ?? "")
    .filter(Boolean)
    .join("\n\n");
}
