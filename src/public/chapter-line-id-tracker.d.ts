export type ChapterLineEditHint = {
  selectionStart: number;
  selectionEnd: number;
  inputType?: string;
};

export const MAX_CHAPTER_LINE_IDS: number;

export function normalizeChapterLineIdDraft(
  content: unknown,
  lineIds: unknown
): Array<string | null>;

export function remapChapterLineCounts(
  beforeLineIds: unknown,
  afterLineIds: unknown,
  lineCounts: unknown
): Map<number, number>;

export function reconcileChapterLineIdDraft(
  beforeContent: unknown,
  afterContent: unknown,
  beforeLineIds: unknown,
  hint?: ChapterLineEditHint | null
): Array<string | null>;
