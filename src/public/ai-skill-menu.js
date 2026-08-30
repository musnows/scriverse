export const AI_SKILL_COMMAND_OPTIONS = Object.freeze([
  Object.freeze({
    name: "continue-writing",
    label: "续写正文",
    description: "延续当前章节，并保持情节、人物与设定一致。"
  }),
  Object.freeze({
    name: "polish-writing",
    label: "润色选中文本",
    description: "润色当前章节的精确选区，并生成可确认的替换建议。"
  })
]);

export function findAiSkillCommand(value, cursor = String(value ?? "").length) {
  const text = String(value ?? "");
  const safeCursor = Math.max(0, Math.min(Number(cursor) || 0, text.length));
  const match = text.slice(0, safeCursor).match(/(?:^|\s)(\/([^/\s]*))$/u);
  if (!match) return null;
  return {
    start: safeCursor - match[1].length,
    end: safeCursor,
    query: match[2]
  };
}

export function listAiSkillOptions(query = "") {
  const keyword = String(query).trim().toLocaleLowerCase("zh-CN");
  if (!keyword) return [...AI_SKILL_COMMAND_OPTIONS];
  return AI_SKILL_COMMAND_OPTIONS.filter((skill) => [skill.name, skill.label]
    .some((value) => value.toLocaleLowerCase("zh-CN").includes(keyword)));
}

export function applyAiSkillCommand(value, match, skillName) {
  const text = String(value ?? "");
  const command = `/${String(skillName).trim()}`;
  const separator = /^\s/u.test(text.slice(match.end)) ? "" : " ";
  return {
    text: `${text.slice(0, match.start)}${command}${separator}${text.slice(match.end)}`,
    command,
    cursor: match.start + command.length + separator.length
  };
}
