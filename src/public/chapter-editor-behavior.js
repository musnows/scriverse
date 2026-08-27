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
