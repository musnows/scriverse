import { createHash } from "node:crypto";

export const MAX_CHAPTER_LINE_IDS = 100_000;

export type ChapterAnnotationAnchor = {
  id: string;
  startLine: number;
  endLine: number;
  quote: string;
  lineHashes: readonly string[];
  lineIds: readonly string[];
};

export type ReanchoredChapterAnnotation = ChapterAnnotationAnchor & {
  anchorStrategy: "hash" | "line-id" | "fallback";
  changed: boolean;
};

type LinePair = {
  beforeIndex: number;
  afterIndex: number;
};

function chapterLines(content: string): string[] {
  return content.replace(/\r\n?/gu, "\n").split("\n");
}

function lineHash(line: string): string {
  return createHash("sha256").update(line, "utf8").digest("hex");
}

export function chapterAnnotationLineHashes(content: string): string[] {
  return chapterLines(content).map((line) => lineHash(line));
}

export function parseChapterAnnotationLineHashes(value: unknown, fallbackContent: string): string[] {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      parsed = null;
    }
  }
  if (
    Array.isArray(parsed)
    && parsed.length > 0
    && parsed.every((hash) => typeof hash === "string" && /^[a-f0-9]{64}$/u.test(hash))
  ) return [...parsed];
  return chapterAnnotationLineHashes(fallbackContent);
}

function linePositions(lines: readonly string[]): Map<string, number[]> {
  const positions = new Map<string, number[]>();
  lines.forEach((line, index) => {
    const matching = positions.get(line);
    if (matching) matching.push(index);
    else positions.set(line, [index]);
  });
  return positions;
}

function exactSequenceStarts(
  values: readonly string[],
  positions: ReadonlyMap<string, readonly number[]>,
  sequence: readonly string[]
): number[] {
  const candidates = positions.get(sequence[0] ?? "") ?? [];
  return candidates.filter((start) => (
    start + sequence.length <= values.length
    && sequence.every((value, offset) => values[start + offset] === value)
  ));
}

function sameHashes(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((hash, index) => hash === right[index]);
}

function sameLineIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((lineId, index) => lineId === right[index]);
}

function closestStart(candidates: readonly number[], target: number): number | null {
  let closest: number | null = null;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate - target);
    if (distance < closestDistance) {
      closest = candidate;
      closestDistance = distance;
    }
  }
  return closest;
}

function longestIncreasingPairs(candidates: readonly LinePair[]): LinePair[] {
  if (candidates.length === 0) return [];
  const tailCandidateIndexes: number[] = [];
  const previousCandidateIndexes = new Int32Array(candidates.length);
  previousCandidateIndexes.fill(-1);

  candidates.forEach((candidate, candidateIndex) => {
    let low = 0;
    let high = tailCandidateIndexes.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (candidates[tailCandidateIndexes[middle]!]!.afterIndex < candidate.afterIndex) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previousCandidateIndexes[candidateIndex] = tailCandidateIndexes[low - 1]!;
    tailCandidateIndexes[low] = candidateIndex;
  });

  const result: LinePair[] = [];
  let candidateIndex = tailCandidateIndexes.at(-1) ?? -1;
  while (candidateIndex >= 0) {
    result.push(candidates[candidateIndex]!);
    candidateIndex = previousCandidateIndexes[candidateIndex]!;
  }
  return result.reverse();
}

function matchingLinePairs(beforeLines: readonly string[], afterLines: readonly string[]): LinePair[] {
  let prefixLength = 0;
  while (
    prefixLength < beforeLines.length
    && prefixLength < afterLines.length
    && beforeLines[prefixLength] === afterLines[prefixLength]
  ) prefixLength += 1;

  let suffixLength = 0;
  while (
    suffixLength < beforeLines.length - prefixLength
    && suffixLength < afterLines.length - prefixLength
    && beforeLines[beforeLines.length - suffixLength - 1] === afterLines[afterLines.length - suffixLength - 1]
  ) suffixLength += 1;

  const pairs: LinePair[] = Array.from({ length: prefixLength }, (_, index) => ({
    beforeIndex: index,
    afterIndex: index
  }));
  const beforeMiddleStart = prefixLength;
  const beforeMiddleEnd = beforeLines.length - suffixLength;
  const afterMiddleStart = prefixLength;
  const afterMiddleEnd = afterLines.length - suffixLength;
  const beforePositions = linePositions(beforeLines.slice(beforeMiddleStart, beforeMiddleEnd));
  const afterPositions = linePositions(afterLines.slice(afterMiddleStart, afterMiddleEnd));
  const uniqueCandidates: LinePair[] = [];
  for (const [line, positions] of beforePositions) {
    const matching = afterPositions.get(line);
    if (positions.length !== 1 || matching?.length !== 1) continue;
    uniqueCandidates.push({
      beforeIndex: beforeMiddleStart + positions[0]!,
      afterIndex: afterMiddleStart + matching[0]!
    });
  }
  uniqueCandidates.sort((left, right) => left.beforeIndex - right.beforeIndex);
  pairs.push(...longestIncreasingPairs(uniqueCandidates));
  for (let offset = suffixLength; offset > 0; offset -= 1) {
    pairs.push({
      beforeIndex: beforeLines.length - offset,
      afterIndex: afterLines.length - offset
    });
  }
  return pairs;
}

function lineIndexMapper(beforeLines: readonly string[], afterLines: readonly string[]): (beforeIndex: number) => number {
  const pairs = matchingLinePairs(beforeLines, afterLines);
  return (requestedBeforeIndex) => {
    const beforeIndex = Math.max(0, Math.min(beforeLines.length - 1, requestedBeforeIndex));
    let low = 0;
    let high = pairs.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (pairs[middle]!.beforeIndex < beforeIndex) low = middle + 1;
      else high = middle;
    }
    const next = pairs[low];
    if (next?.beforeIndex === beforeIndex) return next.afterIndex;
    const previous = low > 0 ? pairs[low - 1] : undefined;
    let mapped: number;
    if (previous && next) {
      const beforeDistance = next.beforeIndex - previous.beforeIndex;
      const afterDistance = next.afterIndex - previous.afterIndex;
      mapped = previous.afterIndex + Math.round((beforeIndex - previous.beforeIndex) * afterDistance / beforeDistance);
      mapped = Math.max(previous.afterIndex + 1, Math.min(next.afterIndex - 1, mapped));
    } else if (previous) {
      mapped = previous.afterIndex + beforeIndex - previous.beforeIndex;
    } else if (next) {
      mapped = next.afterIndex - (next.beforeIndex - beforeIndex);
    } else {
      mapped = beforeLines.length <= 1
        ? 0
        : Math.round(beforeIndex * (afterLines.length - 1) / (beforeLines.length - 1));
    }
    return Math.max(0, Math.min(afterLines.length - 1, mapped));
  };
}

export function parseChapterLineIds(value: unknown, content: string): string[] {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      parsed = null;
    }
  }
  const expectedLength = chapterLines(content).length;
  if (expectedLength > MAX_CHAPTER_LINE_IDS) return [];
  if (
    !Array.isArray(parsed)
    || parsed.length !== expectedLength
    || !parsed.every((lineId) => typeof lineId === "string" && lineId.length > 0)
    || new Set(parsed).size !== parsed.length
  ) return [];
  return [...parsed];
}

export function parseChapterAnnotationLineIds(value: unknown): string[] {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      parsed = null;
    }
  }
  if (
    !Array.isArray(parsed)
    || parsed.length === 0
    || !parsed.every((lineId) => typeof lineId === "string" && lineId.length > 0)
    || new Set(parsed).size !== parsed.length
  ) return [];
  return [...parsed];
}

export function createChapterLineIds(content: string, createId: () => string): string[] {
  const lines = chapterLines(content);
  return lines.length <= MAX_CHAPTER_LINE_IDS ? lines.map(() => createId()) : [];
}

function normalizeRequestedLineIds(
  beforeLineIds: readonly string[],
  afterLineCount: number,
  requestedLineIds: readonly (string | null)[]
): (string | null)[] | null {
  if (requestedLineIds.length !== afterLineCount) return null;
  const beforeIndexes = new Map(beforeLineIds.map((lineId, index) => [lineId, index]));
  const seen = new Set<string>();
  let lastBeforeIndex = -1;
  for (const lineId of requestedLineIds) {
    if (lineId === null) continue;
    const beforeIndex = beforeIndexes.get(lineId);
    if (beforeIndex === undefined || seen.has(lineId) || beforeIndex <= lastBeforeIndex) return null;
    seen.add(lineId);
    lastBeforeIndex = beforeIndex;
  }
  return [...requestedLineIds];
}

export function reconcileChapterLineIds(
  beforeContent: string,
  afterContent: string,
  beforeLineIds: readonly string[],
  requestedLineIds: readonly (string | null)[] | undefined,
  createId: () => string
): string[] | null {
  const beforeLines = chapterLines(beforeContent);
  const afterLines = chapterLines(afterContent);
  if (beforeLines.length > MAX_CHAPTER_LINE_IDS || afterLines.length > MAX_CHAPTER_LINE_IDS) return [];
  if (beforeLineIds.length !== beforeLines.length || new Set(beforeLineIds).size !== beforeLineIds.length) return null;
  if (requestedLineIds !== undefined) {
    const normalized = normalizeRequestedLineIds(beforeLineIds, afterLines.length, requestedLineIds);
    return normalized?.map((lineId) => lineId ?? createId()) ?? null;
  }

  const result: Array<string | null> = Array.from({ length: afterLines.length }, () => null);
  const assignedBeforeIndexes = new Set<number>();
  for (const pair of matchingLinePairs(beforeLines, afterLines)) {
    result[pair.afterIndex] = beforeLineIds[pair.beforeIndex] ?? null;
    assignedBeforeIndexes.add(pair.beforeIndex);
  }
  const mapLineIndex = lineIndexMapper(beforeLines, afterLines);
  beforeLineIds.forEach((lineId, beforeIndex) => {
    if (assignedBeforeIndexes.has(beforeIndex)) return;
    const afterIndex = mapLineIndex(beforeIndex);
    if (result[afterIndex] === null) result[afterIndex] = lineId;
  });
  return result.map((lineId) => lineId ?? createId());
}

function annotationIdentityRange(afterLineIds: readonly string[], annotationLineIds: readonly string[]): { start: number; end: number } | null {
  if (annotationLineIds.length === 0) return null;
  const positions = new Map(afterLineIds.map((lineId, index) => [lineId, index]));
  const matched = annotationLineIds.map((lineId) => positions.get(lineId));
  if (matched.some((index) => index === undefined)) return null;
  const indexes = matched as number[];
  if (indexes.some((index, offset) => offset > 0 && index <= indexes[offset - 1]!)) return null;
  return { start: indexes[0]!, end: indexes.at(-1)! };
}

export function reanchorChapterAnnotations(
  beforeContent: string,
  afterContent: string,
  annotations: readonly ChapterAnnotationAnchor[],
  afterLineIds: readonly string[] = []
): ReanchoredChapterAnnotation[] {
  const beforeLines = chapterLines(beforeContent);
  const afterLines = chapterLines(afterContent);
  const beforePositions = linePositions(beforeLines);
  const afterPositions = linePositions(afterLines);
  const afterLineHashes = afterLines.map((line) => lineHash(line));
  const afterHashPositions = linePositions(afterLineHashes);
  const mapLineIndex = lineIndexMapper(beforeLines, afterLines);

  return annotations.map((annotation) => {
    const storedStart = Math.max(0, Math.min(beforeLines.length - 1, annotation.startLine - 1));
    const storedEnd = Math.max(storedStart, Math.min(beforeLines.length - 1, annotation.endLine - 1));
    const quoteLines = chapterLines(annotation.quote);
    const recoveredStart = closestStart(
      exactSequenceStarts(beforeLines, beforePositions, quoteLines),
      storedStart
    );
    const beforeStart = recoveredStart ?? storedStart;
    const beforeEnd = recoveredStart === null
      ? storedEnd
      : Math.min(beforeLines.length - 1, recoveredStart + quoteLines.length - 1);
    const mappedStart = mapLineIndex(beforeStart);
    const mappedEnd = Math.max(mappedStart, mapLineIndex(beforeEnd));
    const hashMatches = exactSequenceStarts(afterLineHashes, afterHashPositions, annotation.lineHashes);
    const exactAfterStart = closestStart(exactSequenceStarts(afterLines, afterPositions, quoteLines), mappedStart);
    const identityRange = annotationIdentityRange(afterLineIds, annotation.lineIds);
    const identityHashes = identityRange
      ? afterLineHashes.slice(identityRange.start, identityRange.end + 1)
      : [];
    const identityHashMatches = identityRange
      ? sameHashes(identityHashes, annotation.lineHashes)
      : false;
    const canUseHashWithoutIdentity = annotation.lineIds.length === 0 && hashMatches.length === 1;
    const anchorStrategy = identityRange
      ? identityHashMatches ? "hash" : "line-id"
      : canUseHashWithoutIdentity ? "hash" : "fallback";
    const nextStart = identityRange?.start
      ?? (canUseHashWithoutIdentity ? hashMatches[0]! : exactAfterStart ?? mappedStart);
    const nextEnd = identityRange?.end
      ?? (canUseHashWithoutIdentity
        ? Math.min(afterLines.length - 1, nextStart + annotation.lineHashes.length - 1)
        : exactAfterStart === null
          ? mappedEnd
          : Math.min(afterLines.length - 1, exactAfterStart + quoteLines.length - 1));
    const startLine = nextStart + 1;
    const endLine = nextEnd + 1;
    const quote = afterLines.slice(nextStart, nextEnd + 1).join("\n");
    const lineHashes = afterLineHashes.slice(nextStart, nextEnd + 1);
    const lineIds = afterLineIds.slice(nextStart, nextEnd + 1);
    return {
      ...annotation,
      startLine,
      endLine,
      quote,
      lineHashes,
      lineIds,
      anchorStrategy,
      changed: startLine !== annotation.startLine
        || endLine !== annotation.endLine
        || quote !== annotation.quote
        || !sameHashes(lineHashes, annotation.lineHashes)
        || !sameLineIds(lineIds, annotation.lineIds)
    };
  });
}
