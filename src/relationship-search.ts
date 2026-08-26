import { pinyin } from "pinyin-pro";

export const RELATIONSHIP_SEARCH_POLICY_VERSION = 3;
export const RELATIONSHIP_PINYIN_JOINED_TOKEN_MAX_SYLLABLES = 6;

export function normalizeRelationshipSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN");
}

export function isRelationshipPhoneticReference(value: string): boolean {
  const normalized = normalizeRelationshipSearchText(value).trim();
  const hanCharacters = [...normalized].filter((character) => /\p{Script=Han}/u.test(character));
  if (hanCharacters.length < 2) return false;
  return [...normalized].every((character) => /[\p{Script=Han}\p{White_Space}·・\-—]/u.test(character));
}

function encodedCodePoint(value: string): string {
  return [...value].map((character) => character.codePointAt(0)!.toString(16)).join("x");
}

function safePinyinToken(value: string): string {
  const normalized = value.normalize("NFKC").toLocaleLowerCase("zh-CN").replaceAll("ü", "v");
  return /^[a-z0-9]+$/u.test(normalized) ? `p${normalized}` : `u${encodedCodePoint(normalized)}`;
}

export function relationshipCharacterTokens(value: string): string[] {
  return [...normalizeRelationshipSearchText(value)].map((character) => `u${encodedCodePoint(character)}`);
}

export function relationshipPinyinSyllables(value: string): string[] {
  const normalized = normalizeRelationshipSearchText(value);
  return pinyin(normalized, { toneType: "none", type: "array" })
    .map((item) => item.normalize("NFKC").toLocaleLowerCase("zh-CN").replaceAll("ü", "v"));
}

export function relationshipPinyinTokens(value: string): string[] {
  return relationshipPinyinSyllables(value).map(safePinyinToken);
}

export function relationshipPinyinSearchTokens(value: string): string[] {
  const normalized = normalizeRelationshipSearchText(value).trim();
  if (/\p{Script=Han}/u.test(normalized)) return relationshipPinyinTokens(normalized);
  const compact = normalized.replace(/[\p{White_Space}·・\-—']/gu, "");
  return compact ? [safePinyinToken(compact)] : [];
}

export function relationshipPinyinJoinedTokens(
  value: string,
  maximumSyllables = RELATIONSHIP_PINYIN_JOINED_TOKEN_MAX_SYLLABLES
): string[] {
  const tokens = new Set<string>();
  for (const match of value.matchAll(/[\p{Script=Han}]{2,}/gu)) {
    const syllables = relationshipPinyinSyllables(match[0]);
    for (let start = 0; start < syllables.length; start += 1) {
      for (let length = 2; length <= maximumSyllables && start + length <= syllables.length; length += 1) {
        tokens.add(safePinyinToken(syllables.slice(start, start + length).join("")));
      }
    }
  }
  return [...tokens];
}

export function relationshipCharacterTokenText(value: string): string {
  return relationshipCharacterTokens(value).join(" ");
}

export function relationshipPinyinTokenText(value: string): string {
  return [...relationshipPinyinTokens(value), ...relationshipPinyinJoinedTokens(value)].join(" ");
}

export function ftsPhrase(tokens: string[]): string {
  return `"${tokens.join(" ").replaceAll('"', '""')}"`;
}

export type RelationshipPinyinFtsQuery = {
  expression: string;
  verificationSyllables: string[] | null;
};

export function relationshipPinyinFtsQuery(value: string): RelationshipPinyinFtsQuery | null {
  const normalized = normalizeRelationshipSearchText(value).trim();
  const fallbackTokens = relationshipPinyinSearchTokens(normalized);
  if (fallbackTokens.length === 0) return null;
  if (!/^\p{Script=Han}{2,}$/u.test(normalized)) {
    return { expression: ftsPhrase(fallbackTokens), verificationSyllables: null };
  }
  const syllables = relationshipPinyinSyllables(normalized);
  const joinedTokens: string[] = [];
  for (let start = 0; start < syllables.length; start += RELATIONSHIP_PINYIN_JOINED_TOKEN_MAX_SYLLABLES) {
    joinedTokens.push(safePinyinToken(
      syllables.slice(start, start + RELATIONSHIP_PINYIN_JOINED_TOKEN_MAX_SYLLABLES).join("")
    ));
  }
  return {
    expression: joinedTokens.map((token) => ftsPhrase([token])).join(" AND "),
    verificationSyllables: joinedTokens.length > 1 ? syllables : null
  };
}

export function relationshipPinyinSequenceMatches(value: string, expectedSyllables: readonly string[]): boolean {
  if (expectedSyllables.length === 0) return false;
  const sourceSyllables = relationshipPinyinSyllables(value);
  for (let start = 0; start + expectedSyllables.length <= sourceSyllables.length; start += 1) {
    if (expectedSyllables.every((syllable, index) => sourceSyllables[start + index] === syllable)) return true;
  }
  return false;
}

export function damerauLevenshteinDistance(left: readonly string[], right: readonly string[], maximum = Number.POSITIVE_INFINITY): number {
  if (Math.abs(left.length - right.length) > maximum) return maximum + 1;
  const previousPrevious = new Array<number>(right.length + 1).fill(0);
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = new Array<number>(right.length + 1).fill(0);
    current[0] = leftIndex;
    let rowMinimum = current[0];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        previous[rightIndex]! + 1,
        current[rightIndex - 1]! + 1,
        previous[rightIndex - 1]! + substitutionCost
      );
      if (leftIndex > 1 && rightIndex > 1
        && left[leftIndex - 1] === right[rightIndex - 2]
        && left[leftIndex - 2] === right[rightIndex - 1]) {
        current[rightIndex] = Math.min(current[rightIndex]!, previousPrevious[rightIndex - 2]! + 1);
      }
      rowMinimum = Math.min(rowMinimum, current[rightIndex]!);
    }
    if (rowMinimum > maximum) return maximum + 1;
    for (let index = 0; index < previous.length; index += 1) previousPrevious[index] = previous[index]!;
    previous = current;
  }
  return previous[right.length]!;
}

export type ApproximateNameMatch = {
  observed: string;
  start: number;
  end: number;
  utf16Start: number;
  utf16End: number;
  characterDistance: number;
  pinyinDistance: number;
};

export class RelationshipApproximateMatchLimitError extends Error {
  constructor(readonly maximumCandidates: number) {
    super(`Approximate relationship match candidates exceeded ${maximumCandidates}`);
    this.name = "RelationshipApproximateMatchLimitError";
  }
}

function selectApproximateNameMatches(
  matches: ApproximateNameMatch[],
  referenceLength: number,
  limit: number
): ApproximateNameMatch[] {
  const ranked = matches.sort((left, right) =>
    Math.min(left.characterDistance, left.pinyinDistance) - Math.min(right.characterDistance, right.pinyinDistance)
    || Math.abs([...left.observed].length - referenceLength) - Math.abs([...right.observed].length - referenceLength)
    || left.start - right.start
  );
  const selected: ApproximateNameMatch[] = [];
  for (const match of ranked) {
    if (selected.some((item) => match.start < item.end && match.end > item.start)) continue;
    selected.push(match);
    if (selected.length >= limit) break;
  }
  return selected.sort((left, right) => left.start - right.start);
}

export function findApproximateNameMatches(
  content: string,
  reference: string,
  limit = 3,
  excludedObserved: ReadonlySet<string> = new Set(),
  maximumCandidates = 256
): ApproximateNameMatch[] {
  const normalizedContent = normalizeRelationshipSearchText(content);
  const normalizedReference = normalizeRelationshipSearchText(reference).trim();
  const sourceCharacters = [...normalizedContent];
  const utf16Offsets = new Array<number>(sourceCharacters.length + 1).fill(0);
  for (let index = 0; index < sourceCharacters.length; index += 1) {
    utf16Offsets[index + 1] = utf16Offsets[index]! + sourceCharacters[index]!.length;
  }
  const referenceCharacters = [...normalizedReference];
  if (referenceCharacters.length < 2 || sourceCharacters.length === 0) return [];
  const hanReference = referenceCharacters.every((character) => /\p{Script=Han}/u.test(character));
  const normalizedExcluded = new Set([...excludedObserved].map((item) => normalizeRelationshipSearchText(item).trim()));
  const referencePinyin = relationshipPinyinSyllables(normalizedReference);
  const sourcePinyin = relationshipPinyinSyllables(normalizedContent);
  const exactCoverage = new Uint8Array(sourceCharacters.length);
  for (let start = 0; start + referenceCharacters.length <= sourceCharacters.length; start += 1) {
    if (!referenceCharacters.every((character, index) => sourceCharacters[start + index] === character)) continue;
    exactCoverage.fill(1, start, start + referenceCharacters.length);
  }
  const matches: ApproximateNameMatch[] = [];
  const seen = new Set<string>();
  for (const windowLength of [referenceCharacters.length, referenceCharacters.length - 1, referenceCharacters.length + 1]) {
    if (windowLength < 1) continue;
    for (let start = 0; start + windowLength <= sourceCharacters.length; start += 1) {
      const observedCharacters = sourceCharacters.slice(start, start + windowLength);
      if (observedCharacters.length < 2) continue;
      if (hanReference && !observedCharacters.every((character) => /\p{Script=Han}/u.test(character))) continue;
      const observed = observedCharacters.join("");
      if (!observed.trim() || observed === normalizedReference || normalizedExcluded.has(observed)) continue;
      if (exactCoverage.subarray(start, start + windowLength).some((value) => value === 1)) continue;
      const characterDistance = damerauLevenshteinDistance(referenceCharacters, observedCharacters, 1);
      const observedPinyin = sourcePinyin.slice(start, start + windowLength);
      const pinyinDistance = damerauLevenshteinDistance(referencePinyin, observedPinyin, 1);
      if (characterDistance > 1 && pinyinDistance > 1) continue;
      const key = `${start}:${observed}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({
        observed,
        start,
        end: start + windowLength,
        utf16Start: utf16Offsets[start]!,
        utf16End: utf16Offsets[start + windowLength]!,
        characterDistance,
        pinyinDistance
      });
      if (matches.length > maximumCandidates) throw new RelationshipApproximateMatchLimitError(maximumCandidates);
    }
  }
  return selectApproximateNameMatches(matches, referenceCharacters.length, limit);
}

export async function findApproximateNameMatchesChunked(
  content: string,
  reference: string,
  limit = 3,
  excludedObserved: ReadonlySet<string> = new Set(),
  maximumCandidates = 256,
  chunkSize = 16_384
): Promise<ApproximateNameMatch[]> {
  const normalizedContent = normalizeRelationshipSearchText(content);
  const referenceLength = [...normalizeRelationshipSearchText(reference).trim()].length;
  if (referenceLength < 2 || !normalizedContent || chunkSize < 1) return [];
  const overlapSize = referenceLength + 1;
  const matches: ApproximateNameMatch[] = [];
  const seen = new Set<string>();
  let processedCharacters = 0;
  let processedCodeUnits = 0;
  let tail: string[] = [];
  let chunk: string[] = [];
  const processChunk = async (): Promise<void> => {
    if (chunk.length === 0) return;
    const prefixLength = tail.length;
    const prefixCodeUnits = tail.reduce((total, character) => total + character.length, 0);
    const combined = [...tail, ...chunk];
    const baseOffset = processedCharacters - prefixLength;
    const baseCodeUnitOffset = processedCodeUnits - prefixCodeUnits;
    const chunkMatches = findApproximateNameMatches(
      combined.join(""),
      reference,
      maximumCandidates + 1,
      excludedObserved,
      maximumCandidates
    );
    for (const match of chunkMatches) {
      if (match.end <= prefixLength) continue;
      const adjusted = {
        ...match,
        start: match.start + baseOffset,
        end: match.end + baseOffset,
        utf16Start: match.utf16Start + baseCodeUnitOffset,
        utf16End: match.utf16End + baseCodeUnitOffset
      };
      const key = `${adjusted.start}:${adjusted.observed}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push(adjusted);
      if (matches.length > maximumCandidates) throw new RelationshipApproximateMatchLimitError(maximumCandidates);
    }
    processedCharacters += chunk.length;
    processedCodeUnits += chunk.reduce((total, character) => total + character.length, 0);
    tail = combined.slice(-overlapSize);
    chunk = [];
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  for (const character of normalizedContent) {
    chunk.push(character);
    if (chunk.length >= chunkSize) await processChunk();
  }
  await processChunk();
  return selectApproximateNameMatches(matches, referenceLength, limit);
}
