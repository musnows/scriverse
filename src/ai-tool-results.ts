export const AGENT_TOOL_RESULT_MAX_CHARS = 10_000;
export const MIN_AGENT_TOOL_CALL_LIMIT = 5;
export const DEFAULT_MAX_AGENT_TOOL_CALL_LIMIT = 80;
export const MAX_AGENT_TOOL_CALL_LIMIT = DEFAULT_MAX_AGENT_TOOL_CALL_LIMIT;
export const MAX_AGENT_TOOL_CALL_LIMIT_ENV = "SCRIVERSE_MAX_AGENT_TOOL_CALL_LIMIT";
export const MAX_AGENT_TOOL_CALL_LIMIT_HARD_CAP = 1_000;
export const AGENT_TOOL_CALL_SOFT_WARNING_FLOOR = 3;
export const DEFAULT_AGENT_TOOL_CALL_GLOBAL_MULTIPLIER = 3;
export const MIN_AGENT_TOOL_CALL_GLOBAL_MULTIPLIER = 1;
export const MAX_AGENT_TOOL_CALL_GLOBAL_MULTIPLIER = 6;

export function resolveMaxAgentToolCallLimit(environment: NodeJS.ProcessEnv = process.env): number {
  const raw = environment[MAX_AGENT_TOOL_CALL_LIMIT_ENV]?.trim() ?? "";
  if (!/^\d+$/u.test(raw)) return DEFAULT_MAX_AGENT_TOOL_CALL_LIMIT;
  const configured = Number(raw);
  if (!Number.isSafeInteger(configured)) return DEFAULT_MAX_AGENT_TOOL_CALL_LIMIT;
  return Math.min(MAX_AGENT_TOOL_CALL_LIMIT_HARD_CAP, Math.max(MIN_AGENT_TOOL_CALL_LIMIT, configured));
}

export type AgentToolResultPagination = {
  cursor: number;
  nextCursor: number | null;
  maxChars: number;
};

export type AgentToolCallQuotaNotice = string;

export function agentToolCallSoftWarningThreshold(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return AGENT_TOOL_CALL_SOFT_WARNING_FLOOR;
  return Math.max(AGENT_TOOL_CALL_SOFT_WARNING_FLOOR, Math.floor(limit * 0.2) + 1);
}

export function agentToolCallQuotaUsedAfterCompact(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return Math.floor(limit * 0.2);
}

/** 按最后一次压缩恢复轮内配额；历史工具总数仍单独用于全局熔断。 */
export function restoreAgentToolCallQuotaUsed(
  executedCount: number,
  processSteps: readonly { type: string }[],
  limit: number
): number {
  const lastCompactIndex = processSteps.findLastIndex((step) => step.type === "context_compaction");
  if (lastCompactIndex < 0) return executedCount;
  return agentToolCallQuotaUsedAfterCompact(limit)
    + processSteps.slice(lastCompactIndex + 1).filter((step) => step.type === "tool").length;
}

export function clampAgentToolCallGlobalMultiplier(value: unknown): number {
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric)) return DEFAULT_AGENT_TOOL_CALL_GLOBAL_MULTIPLIER;
  return Math.min(
    MAX_AGENT_TOOL_CALL_GLOBAL_MULTIPLIER,
    Math.max(MIN_AGENT_TOOL_CALL_GLOBAL_MULTIPLIER, numeric)
  );
}

/** 单次响应周期内的全局工具调用上限；计数器只增不减，不受 compact 影响。 */
export function agentToolCallGlobalLimit(limit: number, multiplier: number): number {
  const safeLimit = Math.max(1, Math.floor(Number(limit) || 0));
  const safeMultiplier = clampAgentToolCallGlobalMultiplier(multiplier);
  return safeLimit * safeMultiplier;
}

export function shouldRejectGlobalToolCalls(globalUsed: number, requestedCount: number, globalLimit: number): boolean {
  if (!Number.isFinite(globalUsed) || !Number.isFinite(requestedCount) || !Number.isFinite(globalLimit)) return true;
  if (requestedCount <= 0) return false;
  return globalUsed + requestedCount > globalLimit;
}

export function buildAgentToolCallQuotaNotice(remaining: number, limit: number): AgentToolCallQuotaNotice | null {
  if (!Number.isFinite(remaining) || remaining < 0) return null;
  if (remaining === 0) {
    return "[critical] 重要提示：现在没有可用的工具调用次数了。请立即根据已有工具结果直接总结作答，不得再请求任何工具。若继续发起工具调用，系统将显示额度不足提示并结束本次回答。";
  }
  if (remaining <= agentToolCallSoftWarningThreshold(limit)) {
    return `[warning] 提醒：本轮工具调用配额即将用尽，当前剩余 ${remaining} 次。请尽快收敛并准备最终答案，避免继续大规模检索。`;
  }
  return null;
}

/** 估算把 toolCallQuotaNotice 并入工具结果后，额外占用的字符数（用于 compact 体积预估）。 */
export function agentToolCallQuotaNoticeBudgetChars(remaining: number, limit: number): number {
  const notice = buildAgentToolCallQuotaNotice(remaining, limit);
  if (!notice) return 0;
  return Math.max(0, serializedToolResultChars({ toolCallQuotaNotice: notice }) - 2);
}

export function withAgentToolCallQuotaNotice(
  result: Record<string, unknown>,
  remaining: number,
  limit: number
): Record<string, unknown> {
  const notice = buildAgentToolCallQuotaNotice(remaining, limit);
  if (!notice) return result;
  return { ...result, toolCallQuotaNotice: notice };
}

export function shouldRejectAgentToolCalls(executedCount: number, requestedCount: number, limit: number): boolean {
  if (!Number.isFinite(executedCount) || !Number.isFinite(requestedCount) || !Number.isFinite(limit)) return true;
  if (requestedCount <= 0) return false;
  if (executedCount + requestedCount > limit) return true;
  return false;
}

type StructuralFragment = {
  value: unknown;
  path: string;
};

const TOOL_RESULT_RECORD_MAX_CHARS = 6_000;
const TOOL_RESULT_IDENTITY_FIELDS = new Set([
  "id",
  "chapterId",
  "sectionId",
  "characterId",
  "characterName",
  "draftType",
  "draftTypeLabel",
  "name",
  "title",
  "type",
  "sourceType",
  "versionNo"
]);

export function serializedToolResultChars(value: unknown): number {
  return JSON.stringify(value).length;
}

function largestStringChunk(value: string, offset: number, maximumChars: number): string {
  let low = 1;
  let high = value.length - offset;
  let accepted = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = value.slice(offset, offset + middle);
    if (serializedToolResultChars(candidate) <= maximumChars) {
      accepted = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  const end = offset + accepted.length;
  const lastCodeUnit = accepted.charCodeAt(accepted.length - 1);
  const nextCodeUnit = value.charCodeAt(end);
  if (lastCodeUnit >= 0xD800 && lastCodeUnit <= 0xDBFF && nextCodeUnit >= 0xDC00 && nextCodeUnit <= 0xDFFF) {
    return accepted.slice(0, -1);
  }
  return accepted;
}

function structuralValueFragments(value: unknown, maximumChars: number, path: string): StructuralFragment[] {
  if (serializedToolResultChars(value) <= maximumChars) return [{ value, path }];
  if (typeof value === "string") {
    const fragments: StructuralFragment[] = [];
    let offset = 0;
    while (offset < value.length) {
      const chunk = largestStringChunk(value, offset, maximumChars);
      if (!chunk) throw new Error("Tool result string cannot fit within the structural page budget.");
      const nextOffset = offset + chunk.length;
      fragments.push({ value: chunk, path: `${path}[${offset}:${nextOffset}]` });
      offset = nextOffset;
    }
    return fragments;
  }
  if (Array.isArray(value)) {
    const fragments: StructuralFragment[] = [];
    let current: unknown[] = [];
    let currentStart = 0;
    const flush = (end: number): void => {
      if (current.length === 0) return;
      fragments.push({ value: current, path: `${path}[${currentStart}:${end}]` });
      current = [];
    };
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      const candidate = [...current, item];
      if (serializedToolResultChars(candidate) <= maximumChars) {
        if (current.length === 0) currentStart = index;
        current = candidate;
        continue;
      }
      flush(index);
      if (serializedToolResultChars([item]) <= maximumChars) {
        currentStart = index;
        current = [item];
        continue;
      }
      const nested = structuralValueFragments(item, Math.max(64, maximumChars - 2), `${path}[${index}]`);
      for (const fragment of nested) fragments.push({ value: [fragment.value], path: fragment.path });
    }
    flush(value.length);
    return fragments;
  }
  if (value && typeof value === "object") {
    const fragments: StructuralFragment[] = [];
    let current: Record<string, unknown> = {};
    const flush = (): void => {
      if (Object.keys(current).length === 0) return;
      fragments.push({ value: current, path });
      current = {};
    };
    for (const [key, item] of Object.entries(value)) {
      const candidate = { ...current, [key]: item };
      if (serializedToolResultChars(candidate) <= maximumChars) {
        current = candidate;
        continue;
      }
      flush();
      if (serializedToolResultChars({ [key]: item }) <= maximumChars) {
        current = { [key]: item };
        continue;
      }
      const keyOverhead = serializedToolResultChars({ [key]: null }) - serializedToolResultChars(null);
      const nested = structuralValueFragments(item, Math.max(64, maximumChars - keyOverhead), path ? `${path}.${key}` : key);
      for (const fragment of nested) fragments.push({ value: { [key]: fragment.value }, path: fragment.path });
    }
    flush();
    return fragments;
  }
  return [{ value: null, path }];
}

export function structuralToolResultRecords(
  records: Record<string, unknown>[],
  maximumChars = TOOL_RESULT_RECORD_MAX_CHARS
): Record<string, unknown>[] {
  return records.flatMap((record) => {
    if (serializedToolResultChars(record) <= maximumChars) return [record];
    const identity = Object.fromEntries(Object.entries(record).filter(([key]) => TOOL_RESULT_IDENTITY_FIELDS.has(key)));
    const payload = Object.fromEntries(Object.entries(record).filter(([key]) => !TOOL_RESULT_IDENTITY_FIELDS.has(key)));
    const identityChars = serializedToolResultChars(identity);
    const payloadBudget = Math.max(64, maximumChars - identityChars - 320);
    const fragments = structuralValueFragments(payload, payloadBudget, "");
    return fragments.map((fragment, index) => {
      const partial = fragment.value && typeof fragment.value === "object" && !Array.isArray(fragment.value)
        ? fragment.value as Record<string, unknown>
        : { value: fragment.value };
      const result = {
        ...identity,
        ...partial,
        _fragment: {
          index,
          total: fragments.length,
          path: fragment.path || null
        }
      };
      if (serializedToolResultChars(result) > maximumChars) {
        throw new Error("Tool result record cannot fit within the structural page budget.");
      }
      return result;
    });
  });
}

export function paginateToolResultRecords(
  records: Record<string, unknown>[],
  cursor: number,
  buildResult: (page: Record<string, unknown>[], pagination: AgentToolResultPagination) => Record<string, unknown>,
  maximumChars = AGENT_TOOL_RESULT_MAX_CHARS
): Record<string, unknown> {
  const safeCursor = Math.min(Math.max(0, Math.trunc(cursor)), records.length);
  const page: Record<string, unknown>[] = [];
  let nextIndex = safeCursor;
  while (nextIndex < records.length) {
    const candidatePage = [...page, records[nextIndex] as Record<string, unknown>];
    const candidateNextCursor = nextIndex + 1 < records.length ? nextIndex + 1 : null;
    const candidate = buildResult(candidatePage, {
      cursor: safeCursor,
      nextCursor: candidateNextCursor,
      maxChars: maximumChars
    });
    if (serializedToolResultChars(candidate) > maximumChars) break;
    page.push(records[nextIndex] as Record<string, unknown>);
    nextIndex += 1;
  }
  const nextCursor = nextIndex < records.length ? nextIndex : null;
  const result = buildResult(page, { cursor: safeCursor, nextCursor, maxChars: maximumChars });
  if (serializedToolResultChars(result) > maximumChars) {
    throw new Error("Tool result metadata exceeds the configured result budget.");
  }
  if (page.length === 0 && safeCursor < records.length) {
    throw new Error("Tool result item exceeds the configured result budget.");
  }
  return result;
}
