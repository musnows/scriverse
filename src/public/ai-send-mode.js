export const AI_SEND_MODE_QUEUE = "queue";
export const AI_SEND_MODE_STEER = "steer";
export const AI_SEND_MODE_STORAGE_KEY = "scriverse.ai-send-mode";

export function normalizeAiSendMode(value) {
  return String(value ?? "").trim() === AI_SEND_MODE_STEER ? AI_SEND_MODE_STEER : AI_SEND_MODE_QUEUE;
}

export function readStoredAiSendMode(storage) {
  try {
    return normalizeAiSendMode(storage?.getItem?.(AI_SEND_MODE_STORAGE_KEY));
  } catch {
    return AI_SEND_MODE_QUEUE;
  }
}

export function writeStoredAiSendMode(storage, value) {
  const normalized = normalizeAiSendMode(value);
  try {
    storage?.setItem?.(AI_SEND_MODE_STORAGE_KEY, normalized);
  } catch {
    /* 浏览器禁用存储时仅保留本次选择 */
  }
  return normalized;
}

export function aiSendModeAction(mode, streaming, hasComposerContent = true) {
  if (!streaming) return "send";
  if (!hasComposerContent) return "stop";
  return normalizeAiSendMode(mode) === AI_SEND_MODE_STEER ? "steer" : "queue";
}
