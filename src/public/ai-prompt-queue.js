export const AI_PROMPT_QUEUE_LIMIT = 20;

function normalizedId(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function nextQueueItemId() {
  return globalThis.crypto?.randomUUID?.() ?? `queue-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function snapshotComposer(input = {}) {
  return Object.freeze({
    text: String(input.text ?? "").trim(),
    markup: String(input.markup ?? input.text ?? "").trim(),
    citations: Object.freeze([...(Array.isArray(input.citations) ? input.citations : [])].map((citation) => ({ ...citation }))),
    references: Object.freeze([...(Array.isArray(input.references) ? input.references : [])].map((reference) => ({ ...reference }))),
    images: Object.freeze([...(Array.isArray(input.images) ? input.images : [])].map((image) => ({ ...image }))),
    sceneDirection: String(input.sceneDirection ?? "").trim(),
    scenePin: input.scenePin && typeof input.scenePin === "object" ? Object.freeze({ ...input.scenePin }) : null
  });
}

export function aiPromptQueuePreview(text, limit = 72) {
  const normalized = String(text ?? "").replace(/\s+/gu, " ").trim();
  if (!normalized) return "空 Prompt";
  const max = Number.isSafeInteger(limit) && limit > 0 ? limit : 72;
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

export function queuedPromptSteerContent(item) {
  return [item?.sceneDirection, item?.text]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .join("\n\n");
}

export function canSendQueuedPromptAsSteer(item, streaming) {
  if (!streaming || !item) return false;
  return Boolean(queuedPromptSteerContent(item));
}

export function createAiPromptQueue() {
  const queues = new Map();

  const list = (tabId) => [...(queues.get(normalizedId(tabId) ?? "default") ?? [])];

  const enqueue = (tabId, composer) => {
    const key = normalizedId(tabId) ?? "default";
    const snapshot = snapshotComposer(composer);
    if (!snapshot.text && !snapshot.sceneDirection) {
      const error = new Error("排队 Prompt 不能为空");
      error.code = "AI_PROMPT_QUEUE_EMPTY";
      throw error;
    }
    const current = list(key);
    if (current.length >= AI_PROMPT_QUEUE_LIMIT) {
      const error = new Error(`最多排队 ${AI_PROMPT_QUEUE_LIMIT} 条 Prompt`);
      error.code = "AI_PROMPT_QUEUE_LIMIT";
      throw error;
    }
    const item = Object.freeze({
      id: nextQueueItemId(),
      createdAt: new Date().toISOString(),
      ...snapshot
    });
    queues.set(key, Object.freeze([...current, item]));
    return item;
  };

  const remove = (tabId, itemId) => {
    const key = normalizedId(tabId) ?? "default";
    const id = normalizedId(itemId);
    const current = list(key);
    const next = current.filter((item) => item.id !== id);
    if (next.length === current.length) return null;
    if (next.length) queues.set(key, Object.freeze(next));
    else queues.delete(key);
    return current.find((item) => item.id === id) ?? null;
  };

  const takeNext = (tabId) => {
    const key = normalizedId(tabId) ?? "default";
    const [first, ...rest] = list(key);
    if (!first) return null;
    if (rest.length) queues.set(key, Object.freeze(rest));
    else queues.delete(key);
    return first;
  };

  const restore = (tabId, item, index = 0) => {
    const key = normalizedId(tabId) ?? "default";
    if (!item?.id) return null;
    const current = list(key).filter((entry) => entry.id !== item.id);
    if (current.length >= AI_PROMPT_QUEUE_LIMIT) {
      const error = new Error(`最多排队 ${AI_PROMPT_QUEUE_LIMIT} 条 Prompt`);
      error.code = "AI_PROMPT_QUEUE_LIMIT";
      throw error;
    }
    const next = [...current];
    const at = Math.max(0, Math.min(Number.isSafeInteger(index) ? index : 0, next.length));
    next.splice(at, 0, item);
    queues.set(key, Object.freeze(next));
    return item;
  };

  const clear = (tabId) => {
    const key = normalizedId(tabId) ?? "default";
    const current = list(key);
    queues.delete(key);
    return current;
  };

  return {
    clear,
    count: (tabId) => list(tabId).length,
    enqueue,
    list,
    remove,
    restore,
    takeNext
  };
}
