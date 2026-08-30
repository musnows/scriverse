export type ChapterNumberStyle = "arabic" | "chinese";

const chapterNumberTemplateToken = "{n}";
const existingChapterNumberPattern = /^(?:第\s*[〇零一二三四五六七八九十百千万两0-9０-９]+\s*章(?:\s*[上中下])?|chap(?:ter)?\.?\s*[0-9０-９]+|[0-9０-９]+\s*[.．、])\s*(?:[-—–:：.．、]\s*)?/iu;
const chineseDigits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"] as const;
const chineseGroupUnits = ["", "十", "百", "千"] as const;

function formatChineseGroup(value: number): string {
  const digits = String(value).padStart(4, "0");
  let result = "";
  let needsZero = false;
  for (const [index, character] of [...digits].entries()) {
    const digit = Number(character);
    const position = digits.length - index - 1;
    if (digit === 0) {
      if (result && [...digits.slice(index + 1)].some((remaining) => remaining !== "0")) needsZero = true;
      continue;
    }
    if (needsZero) result += chineseDigits[0];
    result += `${chineseDigits[digit] ?? ""}${chineseGroupUnits[position] ?? ""}`;
    needsZero = false;
  }
  return result;
}

export function isChapterNumberTemplate(value: string): boolean {
  const template = value.trim();
  if (!template || template.length > 50 || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  return template.split(chapterNumberTemplateToken).length === 2;
}

export function formatChapterNumber(value: number, style: ChapterNumberStyle): string {
  if (!Number.isSafeInteger(value) || value < 1 || value > 999_999) {
    throw new RangeError("Chapter number must be an integer between 1 and 999999");
  }
  if (style === "arabic") return String(value);

  const highGroup = Math.floor(value / 10_000);
  const lowGroup = value % 10_000;
  let result = highGroup ? `${formatChineseGroup(highGroup)}万` : "";
  if (lowGroup) {
    if (highGroup && lowGroup < 1_000) result += chineseDigits[0];
    result += formatChineseGroup(lowGroup);
  }
  return result.replace(/^一十/u, "十");
}

export function chapterTitleWithoutNumber(title: string): string {
  return title.trim().replace(existingChapterNumberPattern, "").trim();
}

export function renumberChapterTitle(
  title: string,
  sequence: number,
  template: string,
  style: ChapterNumberStyle
): string {
  if (!isChapterNumberTemplate(template)) throw new Error("Invalid chapter number template");
  const numberPrefix = template.trim().replace(chapterNumberTemplateToken, formatChapterNumber(sequence, style));
  const suffix = chapterTitleWithoutNumber(title);
  return suffix ? `${numberPrefix} ${suffix}` : numberPrefix;
}
