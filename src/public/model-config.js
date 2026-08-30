export const MODEL_PURPOSE_OPTIONS = Object.freeze([
  ["chat", "通用对话"],
  ["continue", "创作续写"],
  ["polish", "文本润色"],
  ["chapter-analysis", "章节理解"],
  ["book-analysis", "全书分析"],
  ["timeline-analysis", "时间轴抽取"],
  ["relationship-analysis", "人物关系分析"],
  ["consistency-check", "一致性校对"]
]);

export const MODEL_THINKING_EFFORT_OPTIONS = Object.freeze([
  ["default", "模型默认"],
  ["auto", "自动（auto）"],
  ["low", "低（low）"],
  ["medium", "中（medium）"],
  ["high", "高（high）"],
  ["xhigh", "超高（xhigh）"],
  ["max", "最高（max）"]
]);

const modelThinkingEfforts = new Set(MODEL_THINKING_EFFORT_OPTIONS.map(([value]) => value));
const modelKinds = new Set(["chat", "embedding", "rerank"]);

export const MIN_MODEL_CONTEXT_WINDOW = 32_768;
export const RECOMMENDED_MODEL_CONTEXT_WINDOW = 128_000;

export function supportsMultimodalModelProtocol(protocol, protocolOptions = []) {
  return Array.isArray(protocolOptions)
    && protocolOptions.some((option) => option?.value === protocol && option?.supportsMultimodal === true);
}

const purposeAliases = new Map([
  ...MODEL_PURPOSE_OPTIONS.flatMap(([key, label]) => [[key, key], [label, key]]),
  ["章节分析", "chapter-analysis"],
  ["时间轴分析", "timeline-analysis"],
  ["关系分析", "relationship-analysis"]
]);

export function normalizeModelPurposes(purposes) {
  const values = Array.isArray(purposes) ? purposes : String(purposes ?? "").split(/[,，]/u);
  return [...new Set(values.map((value) => purposeAliases.get(String(value).trim())).filter(Boolean))];
}

export function isKimiModelId(modelId) {
  return String(modelId ?? "").toLowerCase().includes("kimi");
}

export function modelContextWindowGuidance(value) {
  const contextWindow = Number(value);
  const hasNumericValue = String(value ?? "").trim() !== "" && Number.isFinite(contextWindow);
  return {
    belowMinimum: hasNumericValue && contextWindow < MIN_MODEL_CONTEXT_WINDOW,
    showRecommendation: hasNumericValue
      && contextWindow >= MIN_MODEL_CONTEXT_WINDOW
      && contextWindow < RECOMMENDED_MODEL_CONTEXT_WINDOW
  };
}

export function modelFormValues(model = null) {
  const modelId = String(model?.modelId ?? "");
  const modelKind = modelKinds.has(model?.modelKind) ? model.modelKind : "chat";
  const configuredTemperature = model?.preset?.temperature;
  return {
    displayName: model?.displayName ?? "",
    modelId,
    modelKind,
    purposes: modelKind === "chat" ? (model ? normalizeModelPurposes(model.purposes) : ["chat", "continue"]) : [],
    contextWindow: model?.contextWindow ?? 128000,
    temperature: isKimiModelId(modelId) && !(typeof configuredTemperature === "number" && Number.isFinite(configuredTemperature))
      ? 1
      : (configuredTemperature ?? 0.7),
    maxTokens: model?.preset?.max_tokens ?? 32000,
    thinkingEnabled: model?.thinkingEnabled ?? true,
    thinkingEffort: modelThinkingEfforts.has(model?.thinkingEffort) ? model.thinkingEffort : "default",
    multimodalEnabled: model?.multimodalEnabled ?? false,
    imageToolDefault: model?.imageToolDefault ?? false,
    enabled: model?.enabled ?? true
  };
}

export function modelPayload(values, existingPreset = {}) {
  const modelId = String(values.modelId);
  const modelKind = modelKinds.has(values.modelKind) ? values.modelKind : "chat";
  return {
    displayName: String(values.displayName),
    modelId,
    modelKind,
    purposes: modelKind === "chat" ? normalizeModelPurposes(values.purposes) : [],
    contextWindow: Number(values.contextWindow),
    preset: {
      ...existingPreset,
      temperature: Number(values.temperature),
      max_tokens: Number(values.maxTokens)
    },
    thinkingEnabled: Boolean(values.thinkingEnabled),
    thinkingEffort: modelThinkingEfforts.has(values.thinkingEffort) ? values.thinkingEffort : "default",
    multimodalEnabled: modelKind === "chat" && Boolean(values.multimodalEnabled),
    imageToolDefault: modelKind === "chat" && Boolean(values.imageToolDefault),
    enabled: Boolean(values.enabled)
  };
}

export function modelOptionLabel(model) {
  const providerName = String(model?.providerName ?? "").trim();
  const modelName = String(model?.displayName ?? model?.modelId ?? "").trim();
  return [providerName, modelName].filter(Boolean).join(" · ");
}

export function modelThinkingEffortLabel(model) {
  if (model?.thinkingEnabled !== true) return "";
  const thinkingEffort = String(model?.thinkingEffort ?? "").trim().toLowerCase();
  return thinkingEffort && thinkingEffort !== "default" ? thinkingEffort : "default";
}
