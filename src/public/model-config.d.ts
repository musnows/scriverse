export const MODEL_PURPOSE_OPTIONS: ReadonlyArray<readonly [string, string]>;
export const MODEL_THINKING_EFFORT_OPTIONS: ReadonlyArray<readonly ["default" | "auto" | "low" | "medium" | "high" | "xhigh" | "max", string]>;
export const MIN_MODEL_CONTEXT_WINDOW: number;
export const RECOMMENDED_MODEL_CONTEXT_WINDOW: number;
export type ModelProviderProtocolOption = { value: string; supportsMultimodal?: boolean };
export function supportsMultimodalModelProtocol(protocol: string | null | undefined, protocolOptions?: ReadonlyArray<ModelProviderProtocolOption>): boolean;

export type ModelFormValues = {
  displayName: string;
  modelId: string;
  modelKind: "chat" | "embedding" | "rerank";
  purposes: string[];
  contextWindow: number;
  temperature: number;
  maxTokens: number;
  thinkingEnabled: boolean;
  thinkingEffort: "default" | "auto" | "low" | "medium" | "high" | "xhigh" | "max";
  multimodalEnabled: boolean;
  imageToolDefault: boolean;
  enabled: boolean;
};

export function normalizeModelPurposes(purposes: unknown): string[];
export function isKimiModelId(modelId: unknown): boolean;
export function modelContextWindowGuidance(value: unknown): { belowMinimum: boolean; showRecommendation: boolean };
export function modelFormValues(model?: Record<string, unknown> | null): ModelFormValues;
export function modelPayload(values: ModelFormValues, existingPreset?: Record<string, unknown>): Record<string, unknown> & { thinkingEnabled: boolean; thinkingEffort: "default" | "auto" | "low" | "medium" | "high" | "xhigh" | "max" };
export function modelOptionLabel(model: Record<string, unknown> | null | undefined): string;
export function modelThinkingEffortLabel(model: Record<string, unknown> | null | undefined): string;
