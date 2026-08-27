export const CHAPTER_PARAGRAPH_INDENT = "\u3000\u3000";

export function insertIndentedParagraph(value, selectionStart, selectionEnd) {
  const text = String(value ?? "");
  const start = Math.max(0, Math.min(text.length, Number(selectionStart) || 0));
  const end = Math.max(start, Math.min(text.length, Number(selectionEnd) || start));
  const insertion = `\n${CHAPTER_PARAGRAPH_INDENT}`;
  const cursor = start + insertion.length;
  return {
    value: `${text.slice(0, start)}${insertion}${text.slice(end)}`,
    selectionStart: cursor,
    selectionEnd: cursor
  };
}

export function chapterLineIndexAtOffset(value, offset) {
  const text = String(value ?? "");
  const safeOffset = Math.max(0, Math.min(text.length, Number(offset) || 0));
  return (text.slice(0, safeOffset).match(/\n/gu) ?? []).length;
}

export function calculateChapterCaretScroll({
  caretBottom,
  scrollTop,
  clientHeight,
  scrollHeight,
  activationRatio = 0.6,
  targetRatio = 0.5
}) {
  const current = Math.max(0, Number(scrollTop) || 0);
  const viewportHeight = Math.max(0, Number(clientHeight) || 0);
  const contentHeight = Math.max(viewportHeight, Number(scrollHeight) || 0);
  const caretPosition = Math.max(0, Number(caretBottom) || 0);
  if (viewportHeight === 0 || contentHeight <= viewportHeight) return current;
  const activationPoint = current + viewportHeight * activationRatio;
  if (caretPosition <= activationPoint) return current;
  const maximum = Math.max(0, contentHeight - viewportHeight);
  const target = caretPosition - viewportHeight * targetRatio;
  return Math.min(maximum, Math.max(current, target));
}
