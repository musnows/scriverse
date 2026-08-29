export const MAX_CHAPTER_LINE_IDS = 100_000;

function lineSpans(content) {
  const text = String(content ?? "").replace(/\r\n?/gu, "\n");
  const spans = [];
  let start = 0;
  for (let index = 0; index <= text.length; index += 1) {
    if (index !== text.length && text[index] !== "\n") continue;
    spans.push({ start, end: index });
    start = index + 1;
  }
  return spans;
}

function lineIndexAtOffset(spans, offset) {
  const target = Math.max(0, Number(offset) || 0);
  let low = 0;
  let high = spans.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (spans[middle].start <= target) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, Math.min(spans.length - 1, low - 1));
}

function previousCharacterStart(text, offset) {
  if (offset <= 0) return 0;
  const previous = text.charCodeAt(offset - 1);
  return previous >= 0xdc00 && previous <= 0xdfff && offset >= 2 ? offset - 2 : offset - 1;
}

function nextCharacterEnd(text, offset) {
  if (offset >= text.length) return text.length;
  const current = text.charCodeAt(offset);
  return current >= 0xd800 && current <= 0xdbff && offset + 1 < text.length ? offset + 2 : offset + 1;
}

function hintedChangeRange(beforeContent, afterContent, hint) {
  if (!hint || !Number.isInteger(hint.selectionStart) || !Number.isInteger(hint.selectionEnd)) return null;
  let start = Math.max(0, Math.min(beforeContent.length, hint.selectionStart));
  let end = Math.max(start, Math.min(beforeContent.length, hint.selectionEnd));
  if (start === end && hint.inputType === "deleteContentBackward") start = previousCharacterStart(beforeContent, start);
  if (start === end && hint.inputType === "deleteContentForward") end = nextCharacterEnd(beforeContent, end);
  const insertedLength = afterContent.length - (beforeContent.length - (end - start));
  if (insertedLength < 0) return null;
  const afterEnd = start + insertedLength;
  if (
    afterEnd > afterContent.length
    || beforeContent.slice(0, start) !== afterContent.slice(0, start)
    || beforeContent.slice(end) !== afterContent.slice(afterEnd)
  ) return null;
  return { beforeStart: start, beforeEnd: end, afterStart: start, afterEnd };
}

function inferredChangeRange(beforeContent, afterContent) {
  let prefixLength = 0;
  const maximumPrefix = Math.min(beforeContent.length, afterContent.length);
  while (prefixLength < maximumPrefix && beforeContent[prefixLength] === afterContent[prefixLength]) prefixLength += 1;
  let suffixLength = 0;
  while (
    suffixLength < beforeContent.length - prefixLength
    && suffixLength < afterContent.length - prefixLength
    && beforeContent[beforeContent.length - suffixLength - 1] === afterContent[afterContent.length - suffixLength - 1]
  ) suffixLength += 1;
  return {
    beforeStart: prefixLength,
    beforeEnd: beforeContent.length - suffixLength,
    afterStart: prefixLength,
    afterEnd: afterContent.length - suffixLength
  };
}

export function normalizeChapterLineIdDraft(content, lineIds) {
  const count = lineSpans(content).length;
  if (count > MAX_CHAPTER_LINE_IDS) return [];
  if (!Array.isArray(lineIds) || lineIds.length !== count) return Array.from({ length: count }, () => null);
  const seen = new Set();
  return lineIds.map((lineId) => {
    if (lineId === null) return null;
    if (typeof lineId !== "string" || !lineId || seen.has(lineId)) return null;
    seen.add(lineId);
    return lineId;
  });
}

export function remapChapterLineCounts(beforeLineIdsValue, afterLineIdsValue, lineCountsValue) {
  const counts = lineCountsValue instanceof Map ? lineCountsValue : new Map();
  const beforeLineIds = Array.isArray(beforeLineIdsValue) ? beforeLineIdsValue : [];
  const afterLineIds = Array.isArray(afterLineIdsValue) ? afterLineIdsValue : [];
  if (beforeLineIds.length === 0 || afterLineIds.length === 0) return new Map(counts);

  const countsByLineId = new Map();
  counts.forEach((countValue, lineValue) => {
    const line = Number(lineValue);
    const count = Number(countValue);
    const lineId = beforeLineIds[line - 1];
    if (!Number.isInteger(line) || line < 1 || !Number.isInteger(count) || count < 1 || typeof lineId !== "string" || !lineId) return;
    countsByLineId.set(lineId, count);
  });

  const remapped = new Map();
  afterLineIds.forEach((lineId, index) => {
    if (typeof lineId !== "string" || !lineId) return;
    const count = countsByLineId.get(lineId);
    if (count !== undefined) remapped.set(index + 1, count);
  });
  return remapped;
}

export function reconcileChapterLineIdDraft(beforeContentValue, afterContentValue, beforeLineIdsValue, hint = null) {
  const beforeContent = String(beforeContentValue ?? "").replace(/\r\n?/gu, "\n");
  const afterContent = String(afterContentValue ?? "").replace(/\r\n?/gu, "\n");
  const beforeSpans = lineSpans(beforeContent);
  const afterSpans = lineSpans(afterContent);
  if (beforeSpans.length > MAX_CHAPTER_LINE_IDS || afterSpans.length > MAX_CHAPTER_LINE_IDS) return [];
  const beforeLineIds = normalizeChapterLineIdDraft(beforeContent, beforeLineIdsValue);
  if (beforeContent === afterContent) return beforeLineIds;
  const change = hintedChangeRange(beforeContent, afterContent, hint)
    ?? inferredChangeRange(beforeContent, afterContent);
  const delta = (change.afterEnd - change.afterStart) - (change.beforeEnd - change.beforeStart);
  const result = Array.from({ length: afterSpans.length }, () => null);
  const affectedLineIds = [];

  beforeSpans.forEach((span, beforeIndex) => {
    const lineId = beforeLineIds[beforeIndex];
    if (span.end <= change.beforeStart) {
      const afterIndex = lineIndexAtOffset(afterSpans, span.start);
      if (result[afterIndex] === null) result[afterIndex] = lineId;
      return;
    }
    if (span.start >= change.beforeEnd) {
      const afterIndex = lineIndexAtOffset(afterSpans, span.start + delta);
      if (result[afterIndex] === null) result[afterIndex] = lineId;
      return;
    }
    if (lineId !== null) affectedLineIds.push(lineId);
  });

  const affectedAfterStart = lineIndexAtOffset(afterSpans, change.afterStart);
  const affectedAfterEnd = lineIndexAtOffset(afterSpans, Math.max(change.afterStart, change.afterEnd - 1));
  const availableAfterIndexes = [];
  for (let index = affectedAfterStart; index <= affectedAfterEnd; index += 1) {
    if (result[index] === null) availableAfterIndexes.push(index);
  }
  affectedLineIds.forEach((lineId, index) => {
    const afterIndex = availableAfterIndexes[index];
    if (afterIndex !== undefined) result[afterIndex] = lineId;
  });
  return result;
}
