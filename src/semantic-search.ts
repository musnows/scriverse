import { createHash } from "node:crypto";

export const SEMANTIC_SOURCE_TYPES = [
  "chapter",
  "setting",
  "character",
  "race",
  "organization",
  "timeline-track",
  "timeline-event",
  "relationship",
  "chapter-outline",
  "foreshadow"
] as const;

export type SemanticSourceType = (typeof SEMANTIC_SOURCE_TYPES)[number];

export type SemanticSourceDocument = {
  sourceType: SemanticSourceType;
  sourceId: string;
  sectionId?: string;
  sourceVersion: string;
  sourceTitle: string;
  content: string;
};

export type SemanticChunk = Omit<SemanticSourceDocument, "content"> & {
  chunkOrder: number;
  startLine: number;
  endLine: number;
  startOffset: number;
  endOffset: number;
  content: string;
};

export type SemanticVectorEntry = {
  id: string;
  sourceType: SemanticSourceType;
  sourceId: string;
  sectionId?: string;
  sourceVersion: string;
  sourceTitle: string;
  startLine: number;
  endLine: number;
  content: string;
  vector: number[];
};

export type RankedSemanticEntry = Omit<SemanticVectorEntry, "vector"> & {
  semanticScore: number;
};

export type SearchChannelResult = {
  type: string;
  id: string;
  sectionId?: string;
  title: string;
  snippet: string;
  matchKinds: string[];
  startLine?: number;
  endLine?: number;
  score?: number;
  semanticScore?: number;
  rerankScore?: number | null;
  [key: string]: unknown;
};

export const SEMANTIC_CHUNK_RULE_VERSION = 1;
export const DEFAULT_SEMANTIC_CHUNK_MAXIMUM_CHARACTERS = 1_200;
const reciprocalRankConstant = 60;

type TextRange = {
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
};

function paragraphRanges(value: string): TextRange[] {
  const lines = value.split("\n");
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }
  const ranges: TextRange[] = [];
  let startIndex: number | null = null;
  for (let index = 0; index <= lines.length; index += 1) {
    const line = lines[index];
    const blank = line === undefined || /^\s*$/u.test(line);
    if (!blank && startIndex === null) startIndex = index;
    if (!blank || startIndex === null) continue;
    const endIndex = index - 1;
    ranges.push({
      startOffset: offsets[startIndex] ?? 0,
      endOffset: (offsets[endIndex] ?? 0) + (lines[endIndex]?.length ?? 0),
      startLine: startIndex + 1,
      endLine: endIndex + 1
    });
    startIndex = null;
  }
  return ranges;
}

function splitOversizedRange(value: string, range: TextRange, maximumCharacters: number): TextRange[] {
  if (range.endOffset - range.startOffset <= maximumCharacters) return [range];
  const ranges: TextRange[] = [];
  let startOffset = range.startOffset;
  let startLine = range.startLine;
  while (startOffset < range.endOffset) {
    const desiredEnd = Math.min(range.endOffset, startOffset + maximumCharacters);
    const newline = desiredEnd < range.endOffset ? value.lastIndexOf("\n", desiredEnd) : -1;
    const endOffset = newline > startOffset ? newline : desiredEnd;
    const consumed = value.slice(startOffset, endOffset);
    const newlineCount = consumed.match(/\n/gu)?.length ?? 0;
    const endLine = startLine + newlineCount;
    ranges.push({ startOffset, endOffset, startLine, endLine });
    startOffset = endOffset;
    if (value[startOffset] === "\n") {
      startOffset += 1;
      startLine = endLine + 1;
    } else {
      startLine = endLine;
    }
  }
  return ranges;
}

export function splitSemanticDocument(
  document: SemanticSourceDocument,
  maximumCharacters = DEFAULT_SEMANTIC_CHUNK_MAXIMUM_CHARACTERS
): SemanticChunk[] {
  const content = document.content.replace(/\r\n?/gu, "\n");
  const safeMaximum = Math.max(200, Math.trunc(maximumCharacters));
  const atomic = paragraphRanges(content).flatMap((range) => splitOversizedRange(content, range, safeMaximum));
  if (atomic.length === 0) return [];
  const merged: TextRange[] = [];
  let current: TextRange | null = null;
  for (const range of atomic) {
    if (!current) {
      current = { ...range };
      continue;
    }
    if (range.endOffset - current.startOffset <= safeMaximum) {
      current.endOffset = range.endOffset;
      current.endLine = range.endLine;
      continue;
    }
    merged.push(current);
    current = { ...range };
  }
  if (current) merged.push(current);
  return merged.map((range, chunkOrder) => ({
    sourceType: document.sourceType,
    sourceId: document.sourceId,
    ...(document.sectionId ? { sectionId: document.sectionId } : {}),
    sourceVersion: document.sourceVersion,
    sourceTitle: document.sourceTitle,
    chunkOrder,
    ...range,
    content: content.slice(range.startOffset, range.endOffset)
  }));
}

function stableFingerprintValue(value: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))));
}

export function semanticConfigurationFingerprint(input: {
  providerId: string;
  baseUrl: string;
  modelRecordId: string;
  modelId: string;
  vectorDimension: number;
  chunkRuleVersion?: number;
  chunkMaximumCharacters?: number;
}): string {
  return createHash("sha256").update(stableFingerprintValue({
    providerId: input.providerId,
    baseUrl: input.baseUrl,
    modelRecordId: input.modelRecordId,
    modelId: input.modelId,
    vectorDimension: input.vectorDimension,
    chunkRuleVersion: input.chunkRuleVersion ?? SEMANTIC_CHUNK_RULE_VERSION,
    chunkMaximumCharacters: input.chunkMaximumCharacters ?? DEFAULT_SEMANTIC_CHUNK_MAXIMUM_CHARACTERS
  })).digest("hex");
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function parseEmbeddingResponse(payload: unknown, expectedCount: number, vectorDimension: number): {
  vectors: number[][];
  usage: Record<string, unknown>;
} {
  const record = objectValue(payload);
  const data = Array.isArray(record?.data) ? record.data : null;
  if (!data || data.length !== expectedCount) throw new Error("Embedding response item count does not match the request");
  const vectors = new Array<number[] | undefined>(expectedCount);
  for (let position = 0; position < data.length; position += 1) {
    const item = objectValue(data[position]);
    const index = typeof item?.index === "number" ? item.index : position;
    const embedding = Array.isArray(item?.embedding) ? item.embedding : null;
    if (!Number.isInteger(index) || index < 0 || index >= expectedCount || vectors[index]) {
      throw new Error("Embedding response contains an invalid index");
    }
    if (!embedding || embedding.length !== vectorDimension) {
      throw new Error(`Embedding response vector dimension must be ${vectorDimension}`);
    }
    const vector = embedding.map(Number);
    if (vector.some((value) => !Number.isFinite(value))) throw new Error("Embedding response contains a non-finite vector value");
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (!Number.isFinite(norm) || norm === 0) throw new Error("Embedding response contains a zero-length vector");
    vectors[index] = vector;
  }
  if (vectors.some((vector) => !vector)) throw new Error("Embedding response omitted a vector");
  return {
    vectors: vectors as number[][],
    usage: objectValue(record?.usage) ?? {}
  };
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) return Number.NEGATIVE_INFINITY;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = Number(left[index]);
    const rightValue = Number(right[index]);
    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) return Number.NEGATIVE_INFINITY;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm === 0 || rightNorm === 0) return Number.NEGATIVE_INFINITY;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

export function rankSemanticVectors(
  queryVector: readonly number[],
  entries: readonly SemanticVectorEntry[],
  limit: number
): RankedSemanticEntry[] {
  const safeLimit = Math.max(1, Math.trunc(limit));
  return entries
    .map(({ vector, ...entry }) => ({ ...entry, semanticScore: cosineSimilarity(queryVector, vector) }))
    .filter((entry) => Number.isFinite(entry.semanticScore))
    .sort((left, right) => right.semanticScore - left.semanticScore || left.id.localeCompare(right.id))
    .slice(0, safeLimit)
    .map((entry) => ({ ...entry, semanticScore: Number(entry.semanticScore.toFixed(8)) }));
}

export function parseRerankCompletion(payload: unknown): number {
  const record = objectValue(payload);
  const choices = Array.isArray(record?.choices) ? record.choices : [];
  const choice = objectValue(choices[0]);
  const message = objectValue(choice?.message);
  const answer = (typeof choice?.text === "string" ? choice.text : typeof message?.content === "string" ? message.content : "")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z]/gu, "");
  if (answer.startsWith("yes")) return 1;
  if (answer.startsWith("no")) return 0;
  throw new Error("Rerank response must be yes or no");
}

function resultKey(result: SearchChannelResult): string {
  return `${result.type}:${result.id}:${result.sectionId ?? ""}`;
}

export function fuseSemanticSearchResults(
  keywordResults: readonly SearchChannelResult[],
  semanticResults: readonly SearchChannelResult[],
  semanticWeight: number,
  limit: number
): SearchChannelResult[] {
  const fused = new Map<string, { result: SearchChannelResult; score: number; matchKinds: Set<string> }>();
  const add = (result: SearchChannelResult, rank: number, weight: number): void => {
    const key = resultKey(result);
    const score = weight / (reciprocalRankConstant + rank + 1);
    const existing = fused.get(key);
    if (!existing) {
      fused.set(key, { result: { ...result }, score, matchKinds: new Set(result.matchKinds) });
      return;
    }
    existing.score += score;
    result.matchKinds.forEach((kind) => existing.matchKinds.add(kind));
    if ((result.semanticScore ?? Number.NEGATIVE_INFINITY) > (existing.result.semanticScore ?? Number.NEGATIVE_INFINITY)) {
      existing.result = { ...existing.result, ...result };
    }
  };
  keywordResults.forEach((result, index) => add(result, index, 1));
  semanticResults.forEach((result, index) => add(result, index, Math.max(0.1, Math.min(5, semanticWeight))));
  return [...fused.values()]
    .sort((left, right) => right.score - left.score || resultKey(left.result).localeCompare(resultKey(right.result)))
    .slice(0, Math.max(1, Math.trunc(limit)))
    .map(({ result, score, matchKinds }) => ({
      ...result,
      score: Number(score.toFixed(8)),
      matchKinds: ["metadata", "exact", "phonetic", "semantic"].filter((kind) => matchKinds.has(kind))
    }));
}
