export function formatAiContextUsageTooltip(usage) {
  if (!usage) return "选择可用模型后显示当前上下文用量";
  const inputTokens = Math.max(0, Math.round(Number(usage.inputTokens) || 0)).toLocaleString("zh-CN");
  const contextWindow = Math.max(0, Math.round(Number(usage.contextWindow) || 0)).toLocaleString("zh-CN");
  const contextTokens = Math.max(0, Math.round(Number(usage.contextTokens) || 0)).toLocaleString("zh-CN");
  const conversationTokens = Math.max(0, Math.round(Number(usage.conversationTokens) || 0)).toLocaleString("zh-CN");
  const conversationBudget = Math.max(0, Math.round(Number(usage.conversationBudgetTokens) || 0)).toLocaleString("zh-CN");
  const outputTokens = Math.max(0, Math.round(Number(usage.outputTokens) || 0)).toLocaleString("zh-CN");
  return `总输入 ${inputTokens} / ${contextWindow} tok · 作品上下文 ${contextTokens} tok · 对话历史 ${conversationTokens} / ${conversationBudget} tok · 当前调用实际输出 ${outputTokens} tok`;
}

function tokenCount(value) {
  return Math.max(0, Math.round(Number(value) || 0));
}

export function resolveAiContextUsage(previousUsage, nextUsage) {
  return nextUsage && typeof nextUsage === "object" ? nextUsage : previousUsage ?? null;
}

const maximumAiContextUsageFields = [
  "inputTokens",
  "contextTokens",
  "conversationTokens",
  "usagePercent",
  "conversationUsagePercent"
];
const minimumAiContextUsageFields = ["remainingTokens"];

export function mergeAiContextUsage(previousUsage, nextUsage, allowShrink = false) {
  if (!nextUsage || typeof nextUsage !== "object" || Array.isArray(nextUsage)) return previousUsage ?? null;
  if (!previousUsage || typeof previousUsage !== "object" || Array.isArray(previousUsage) || allowShrink) return nextUsage;
  const mergedUsage = { ...nextUsage };
  for (const field of [...maximumAiContextUsageFields, ...minimumAiContextUsageFields]) {
    const previousValue = Number(previousUsage[field]);
    const nextValue = Number(nextUsage[field]);
    if (Number.isFinite(previousValue) && Number.isFinite(nextValue)) {
      mergedUsage[field] = minimumAiContextUsageFields.includes(field)
        ? Math.min(previousValue, nextValue)
        : Math.max(previousValue, nextValue);
    }
    else if (Number.isFinite(previousValue)) mergedUsage[field] = previousValue;
    else if (Number.isFinite(nextValue)) mergedUsage[field] = nextValue;
  }
  return mergedUsage;
}

export function formatAiContextUsagePercent(occupiedTokens, contextWindow) {
  const occupied = tokenCount(occupiedTokens);
  const window = tokenCount(contextWindow);
  const percent = window > 0 ? Math.min(100, occupied / window * 100) : 0;
  const roundedDecimal = Number(percent.toFixed(1));
  return roundedDecimal < 10 ? `${roundedDecimal.toFixed(1)}%` : `${Math.round(percent)}%`;
}

export function normalizeAiContextTokenDistribution(usage) {
  const contextWindow = tokenCount(usage?.contextWindow);
  const distribution = usage?.tokenDistribution ?? {};
  const systemPromptTokens = tokenCount(distribution.systemPromptTokens);
  const functionTokens = tokenCount(distribution.functionTokens);
  const skillsTokens = tokenCount(distribution.skillsTokens);
  const inputTokens = Object.keys(distribution).length > 0
    ? tokenCount(distribution.contextTokens)
    : tokenCount(usage?.inputTokens);
  const outputTokens = Math.min(
    tokenCount(distribution.outputTokens ?? usage?.outputTokens),
    Math.max(0, contextWindow - systemPromptTokens - functionTokens - skillsTokens - inputTokens)
  );
  const occupiedTokens = systemPromptTokens + functionTokens + skillsTokens + inputTokens + outputTokens;
  const leftTokens = Math.max(0, contextWindow - occupiedTokens);
  const items = [
    { key: "system-prompt", label: "system prompt", tokens: systemPromptTokens },
    { key: "function", label: "function", tokens: functionTokens },
    { key: "skills", label: "skills", tokens: skillsTokens },
    { key: "input", label: "input", tokens: inputTokens },
    { key: "output", label: "output", tokens: outputTokens },
    { key: "left", label: "left", tokens: leftTokens }
  ];
  return {
    contextWindow,
    occupiedTokens,
    items: items.map((item) => ({
      ...item,
      percent: contextWindow > 0 ? Math.round(item.tokens / contextWindow * 1_000) / 10 : 0
    }))
  };
}
