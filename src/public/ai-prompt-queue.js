export const AI_PROMPT_QUEUE_LIMIT = 20;
export const AI_PROMPT_QUEUE_DRAG_PREFIX = "scriverse-ai-prompt-queue:";

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

function queueEmptyError() {
  const error = new Error("排队 Prompt 不能为空");
  error.code = "AI_PROMPT_QUEUE_EMPTY";
  return error;
}

function queueLimitError() {
  const error = new Error(`最多排队 ${AI_PROMPT_QUEUE_LIMIT} 条 Prompt`);
  error.code = "AI_PROMPT_QUEUE_LIMIT";
  return error;
}

function sameQueuedOrder(left, right) {
  return left.length === right.length && left.every((item, index) => item.id === right[index]?.id);
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

export function queuedPromptEditContent(item) {
  if (String(item?.text ?? "").trim()) return String(item.text ?? "");
  return String(item?.sceneDirection ?? "");
}

export function queuedPromptEditPatch(item, nextText) {
  const value = String(nextText ?? "");
  if (String(item?.text ?? "").trim()) {
    return { text: value, markup: value };
  }
  return { sceneDirection: value };
}

export function canSendQueuedPromptAsSteer(item, streaming) {
  if (!streaming || !item) return false;
  return Boolean(queuedPromptSteerContent(item));
}

export function aiPromptQueueDragPayload(itemId) {
  const id = normalizedId(itemId);
  return id ? `${AI_PROMPT_QUEUE_DRAG_PREFIX}${id}` : "";
}

export function parseAiPromptQueueDragPayload(value) {
  const text = String(value ?? "");
  if (!text.startsWith(AI_PROMPT_QUEUE_DRAG_PREFIX)) return null;
  return normalizedId(text.slice(AI_PROMPT_QUEUE_DRAG_PREFIX.length));
}

export function moveQueuedPromptItem(items, sourceId, targetId, placeAfter = false) {
  const current = Array.isArray(items) ? items : [];
  const source = normalizedId(sourceId);
  const target = normalizedId(targetId);
  if (!source || !target || source === target) return current;
  const from = current.findIndex((item) => item.id === source);
  if (from < 0) return current;
  const next = [...current];
  const [moved] = next.splice(from, 1);
  let to = next.findIndex((item) => item.id === target);
  if (to < 0) return current;
  if (placeAfter) to += 1;
  next.splice(to, 0, moved);
  return sameQueuedOrder(current, next) ? current : next;
}

export function moveQueuedPromptItemByOffset(items, itemId, offset) {
  const current = Array.isArray(items) ? items : [];
  const id = normalizedId(itemId);
  if (!id || !Number.isSafeInteger(offset) || offset === 0) return current;
  const from = current.findIndex((item) => item.id === id);
  const to = from + offset;
  if (from < 0 || to < 0 || to >= current.length) return current;
  const next = [...current];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export function createAiPromptQueue() {
  const queues = new Map();

  const list = (tabId) => [...(queues.get(normalizedId(tabId) ?? "default") ?? [])];

  const replace = (key, next) => {
    if (next.length) queues.set(key, Object.freeze(next));
    else queues.delete(key);
    return list(key);
  };

  const enqueue = (tabId, composer) => {
    const key = normalizedId(tabId) ?? "default";
    const snapshot = snapshotComposer(composer);
    if (!snapshot.text && !snapshot.sceneDirection) throw queueEmptyError();
    const current = list(key);
    if (current.length >= AI_PROMPT_QUEUE_LIMIT) throw queueLimitError();
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
    replace(key, next);
    return current.find((item) => item.id === id) ?? null;
  };

  const takeNext = (tabId) => {
    const key = normalizedId(tabId) ?? "default";
    const [first, ...rest] = list(key);
    if (!first) return null;
    replace(key, rest);
    return first;
  };

  const restore = (tabId, item, index = 0) => {
    const key = normalizedId(tabId) ?? "default";
    if (!item?.id) return null;
    const current = list(key).filter((entry) => entry.id !== item.id);
    if (current.length >= AI_PROMPT_QUEUE_LIMIT) throw queueLimitError();
    const next = [...current];
    const at = Math.max(0, Math.min(Number.isSafeInteger(index) ? index : 0, next.length));
    next.splice(at, 0, item);
    queues.set(key, Object.freeze(next));
    return item;
  };

  const update = (tabId, itemId, patch = {}) => {
    const key = normalizedId(tabId) ?? "default";
    const id = normalizedId(itemId);
    const current = list(key);
    const index = current.findIndex((item) => item.id === id);
    if (index < 0) return null;
    const existing = current[index];
    const snapshot = snapshotComposer({ ...existing, ...patch });
    if (!snapshot.text && !snapshot.sceneDirection) throw queueEmptyError();
    const nextItem = Object.freeze({
      id: existing.id,
      createdAt: existing.createdAt,
      ...snapshot
    });
    const next = [...current];
    next[index] = nextItem;
    queues.set(key, Object.freeze(next));
    return nextItem;
  };

  const move = (tabId, sourceId, targetId, placeAfter = false) => {
    const key = normalizedId(tabId) ?? "default";
    const current = list(key);
    const next = moveQueuedPromptItem(current, sourceId, targetId, placeAfter);
    if (next === current) return current;
    queues.set(key, Object.freeze(next));
    return list(key);
  };

  const moveByOffset = (tabId, itemId, offset) => {
    const key = normalizedId(tabId) ?? "default";
    const current = list(key);
    const next = moveQueuedPromptItemByOffset(current, itemId, offset);
    if (next === current) return current;
    queues.set(key, Object.freeze(next));
    return list(key);
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
    move,
    moveByOffset,
    remove,
    restore,
    takeNext,
    update
  };
}
