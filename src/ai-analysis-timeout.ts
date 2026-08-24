export const DEFAULT_AI_ANALYSIS_TIMEOUT_SECONDS = 300;
export const MIN_AI_ANALYSIS_TIMEOUT_SECONDS = 30;
export const MAX_AI_ANALYSIS_TIMEOUT_SECONDS = 3_600;

export function normalizeAiAnalysisTimeoutSeconds(value: number): number {
  if (!Number.isSafeInteger(value)) return DEFAULT_AI_ANALYSIS_TIMEOUT_SECONDS;
  return Math.min(MAX_AI_ANALYSIS_TIMEOUT_SECONDS, Math.max(MIN_AI_ANALYSIS_TIMEOUT_SECONDS, value));
}

export function isLongRunningAiAnalysisTaskType(taskType: string): boolean {
  return taskType === "book-analysis" || taskType === "relationship-analysis";
}
