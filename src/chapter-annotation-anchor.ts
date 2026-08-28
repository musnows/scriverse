import { createHash } from "node:crypto";

export type ChapterAnnotationAnchor = {
  id: string;
  startLine: number;
  endLine: number;
  quote: string;
  lineHashes: readonly string[];
};

export type ReanchoredChapterAnnotation = ChapterAnnotationAnchor & {
  anchorStrategy: "hash" | "fallback";
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

export function reanchorChapterAnnotations(
  beforeContent: string,
  afterContent: string,
  annotations: readonly ChapterAnnotationAnchor[]
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
    const anchorStrategy = hashMatches.length === 1 ? "hash" : "fallback";
    const nextStart = hashMatches.length === 1 ? hashMatches[0]! : exactAfterStart ?? mappedStart;
    const nextEnd = hashMatches.length === 1
      ? Math.min(afterLines.length - 1, nextStart + annotation.lineHashes.length - 1)
      : exactAfterStart === null
        ? mappedEnd
        : Math.min(afterLines.length - 1, exactAfterStart + quoteLines.length - 1);
    const startLine = nextStart + 1;
    const endLine = nextEnd + 1;
    const quote = afterLines.slice(nextStart, nextEnd + 1).join("\n");
    const lineHashes = afterLineHashes.slice(nextStart, nextEnd + 1);
    return {
      ...annotation,
      startLine,
      endLine,
      quote,
      lineHashes,
      anchorStrategy,
      changed: startLine !== annotation.startLine
        || endLine !== annotation.endLine
        || quote !== annotation.quote
        || !sameHashes(lineHashes, annotation.lineHashes)
    };
  });
}
