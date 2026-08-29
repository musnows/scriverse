import { describe, expect, it } from "vitest";
import { MODEL_THINKING_EFFORT_OPTIONS, isKimiModelId, modelContextWindowGuidance, modelFormValues, modelPayload, modelThinkingEffortLabel, supportsMultimodalModelProtocol } from "../../src/public/model-config.js";

describe("AI 模型配置", () => {
  it("按后端返回的协议能力判断是否支持多模态", () => {
    const protocolOptions = [
      { value: "openai-chat-completions", supportsMultimodal: true },
      { value: "openai-responses", supportsMultimodal: true },
      { value: "anthropic-messages", supportsMultimodal: true },
      { value: "google-vertex", supportsMultimodal: true }
    ];
    expect(supportsMultimodalModelProtocol("openai-chat-completions", protocolOptions)).toBe(true);
    expect(supportsMultimodalModelProtocol("openai-responses", protocolOptions)).toBe(true);
    expect(supportsMultimodalModelProtocol("anthropic-messages", protocolOptions)).toBe(true);
    expect(supportsMultimodalModelProtocol("google-vertex", protocolOptions)).toBe(true);
    expect(supportsMultimodalModelProtocol("unsupported", protocolOptions)).toBe(false);
    expect(supportsMultimodalModelProtocol("openai-responses")).toBe(false);
  });

  it("新模型默认开启 thinking 并写入配置载荷", () => {
    const values = modelFormValues();
    expect(values.thinkingEnabled).toBe(true);
    expect(values.thinkingEffort).toBe("default");
    expect(modelPayload({ ...values, displayName: "思考模型", modelId: "thinking-model" })).toMatchObject({
      thinkingEnabled: true,
      thinkingEffort: "default"
    });
  });

  it("显示全部思考强度的原始英文值并保留扩展档位", () => {
    expect(MODEL_THINKING_EFFORT_OPTIONS).toEqual([
      ["default", "模型默认"],
      ["auto", "自动（auto）"],
      ["low", "低（low）"],
      ["medium", "中（medium）"],
      ["high", "高（high）"],
      ["xhigh", "超高（xhigh）"],
      ["max", "最高（max）"]
    ]);
    expect(modelFormValues({ thinkingEffort: "auto" }).thinkingEffort).toBe("auto");
    expect(modelFormValues({ thinkingEffort: "xhigh" }).thinkingEffort).toBe("xhigh");
    const values = modelFormValues({ thinkingEffort: "max" });
    expect(modelPayload({ ...values, displayName: "最高强度模型", modelId: "max-effort-model" }).thinkingEffort).toBe("max");
    expect(modelPayload({ ...values, displayName: "自动强度模型", modelId: "auto-effort-model", thinkingEffort: "auto" }).thinkingEffort).toBe("auto");
  });

  it("保留模型已有的 thinking 关闭状态", () => {
    const values = modelFormValues({ thinkingEnabled: false, thinkingEffort: "high" });
    expect(values.thinkingEnabled).toBe(false);
    expect(values.thinkingEffort).toBe("high");
    expect(modelPayload({ ...values, displayName: "普通模型", modelId: "plain-model" })).toMatchObject({
      thinkingEnabled: false,
      thinkingEffort: "high"
    });
  });

  it("仅为开启 thinking 的模型显示思考强度", () => {
    expect(modelThinkingEffortLabel({ thinkingEnabled: true, thinkingEffort: "high" })).toBe("high");
    expect(modelThinkingEffortLabel({ thinkingEnabled: true, thinkingEffort: "auto" })).toBe("auto");
    expect(modelThinkingEffortLabel({ thinkingEnabled: true, thinkingEffort: "default" })).toBe("default");
    expect(modelThinkingEffortLabel({ thinkingEnabled: true })).toBe("default");
    expect(modelThinkingEffortLabel({ thinkingEnabled: false, thinkingEffort: "high" })).toBe("");
    expect(modelThinkingEffortLabel({ thinkingEffort: "high" })).toBe("");
  });

  it("拒绝未知思考强度并回退为模型默认", () => {
    const values = modelFormValues({ thinkingEffort: "unsupported" });
    expect(values.thinkingEffort).toBe("default");
    expect(modelPayload({ ...values, displayName: "兼容模型", modelId: "compatible-model", thinkingEffort: "unsupported" as never }).thinkingEffort).toBe("default");
  });

  it("保留多模态能力和默认读图模型选项", () => {
    const values = modelFormValues({ multimodalEnabled: true, imageToolDefault: true });
    expect(values.multimodalEnabled).toBe(true);
    expect(values.imageToolDefault).toBe(true);
    expect(modelPayload({ ...values, displayName: "视觉模型", modelId: "vision-model" })).toMatchObject({
      multimodalEnabled: true,
      imageToolDefault: true
    });
  });

  it("区分 chat、embedding 与 rerank 模型并清除专用模型的聊天能力", () => {
    expect(modelFormValues({ modelKind: "embedding", purposes: ["chat"], multimodalEnabled: true })).toMatchObject({
      modelKind: "embedding",
      purposes: []
    });
    expect(modelPayload({
      ...modelFormValues(),
      displayName: "嵌入模型",
      modelId: "embedding-model",
      modelKind: "embedding",
      purposes: ["chat"],
      multimodalEnabled: true,
      imageToolDefault: true
    })).toMatchObject({
      modelKind: "embedding",
      purposes: [],
      multimodalEnabled: false,
      imageToolDefault: false
    });
    expect(modelPayload({
      ...modelFormValues(),
      displayName: "重排模型",
      modelId: "rerank-model",
      modelKind: "rerank"
    }).modelKind).toBe("rerank");
  });

  it("Kimi 模型默认温度为 1 并允许手动调整", () => {
    expect(isKimiModelId("kimi-for-coding")).toBe(true);
    expect(modelFormValues({ modelId: "kimi-for-coding" }).temperature).toBe(1);
    expect(modelFormValues({ modelId: "kimi-for-coding", preset: { temperature: 0.7 } }).temperature).toBe(0.7);
    const payload = modelPayload({ ...modelFormValues(), displayName: "Kimi", modelId: "KIMI-K2", temperature: 0.2 });
    expect((payload.preset as { temperature: number }).temperature).toBe(0.2);
  });

  it("区分禁止配置和建议使用更长上下文的模型", () => {
    expect(modelContextWindowGuidance(32_767)).toEqual({ belowMinimum: true, showRecommendation: false });
    expect(modelContextWindowGuidance(32_768)).toEqual({ belowMinimum: false, showRecommendation: true });
    expect(modelContextWindowGuidance(127_999)).toEqual({ belowMinimum: false, showRecommendation: true });
    expect(modelContextWindowGuidance(128_000)).toEqual({ belowMinimum: false, showRecommendation: false });
    expect(modelContextWindowGuidance("")).toEqual({ belowMinimum: false, showRecommendation: false });
  });
});
