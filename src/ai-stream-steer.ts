import { AppError } from "./errors.js";
import { id, now } from "./utils.js";

export const AI_STEER_MAX_CHARS = 100_000;
export const AI_STEER_INSTRUCTION_HEADING = "【执行流引导】";

export type AiSteerEntry = {
  id: string;
  conversationId: string;
  content: string;
  createdAt: string;
};

export function createAiSteerRefreshError(): AppError {
  return new AppError(409, "AI_STEER_REFRESH", "收到执行流引导，正在把当前回复交给引导继续");
}

export function isAiSteerRefreshError(error: unknown): error is AppError {
  return error instanceof AppError && error.code === "AI_STEER_REFRESH";
}

export function normalizeAiSteerContent(value: unknown): string {
  return String(value ?? "").trim();
}

export function formatAiSteerInstruction(content: string): string {
  const normalized = normalizeAiSteerContent(content);
  return `${AI_STEER_INSTRUCTION_HEADING}\n作者在当前回答尚未结束时补充了以下引导，请立即按此调整后续执行，不要重新开始整个任务：\n\n${normalized}`;
}

export class AiStreamSteerMailbox {
  private readonly active = new Set<string>();
  private readonly pending = new Map<string, AiSteerEntry[]>();
  private readonly waiters = new Map<string, Set<AbortController>>();

  begin(conversationId: string): () => void {
    const key = String(conversationId ?? "").trim();
    if (!key) throw new AppError(400, "AI_STEER_CONVERSATION_REQUIRED", "执行流引导必须绑定对话");
    this.active.add(key);
    if (!this.pending.has(key)) this.pending.set(key, []);
    return () => this.end(key);
  }

  isActive(conversationId: string): boolean {
    return this.active.has(String(conversationId ?? "").trim());
  }

  enqueue(conversationId: string, content: string): AiSteerEntry {
    const key = String(conversationId ?? "").trim();
    const normalized = normalizeAiSteerContent(content);
    if (!key) throw new AppError(400, "AI_STEER_CONVERSATION_REQUIRED", "执行流引导必须绑定对话");
    if (!normalized) throw new AppError(400, "AI_STEER_EMPTY", "请输入引导内容");
    if (normalized.length > AI_STEER_MAX_CHARS) {
      throw new AppError(400, "AI_STEER_TOO_LONG", `引导内容不能超过 ${AI_STEER_MAX_CHARS} 个字符`);
    }
    if (!this.active.has(key)) {
      throw new AppError(409, "AI_STEER_NO_ACTIVE_STREAM", "当前对话没有正在执行的回复，无法发送引导");
    }
    const entry: AiSteerEntry = {
      id: id("steer"),
      conversationId: key,
      content: normalized,
      createdAt: now()
    };
    const queue = this.pending.get(key) ?? [];
    queue.push(entry);
    this.pending.set(key, queue);
    this.signal(key);
    return entry;
  }

  drain(conversationId: string): AiSteerEntry[] {
    const key = String(conversationId ?? "").trim();
    const items = this.pending.get(key) ?? [];
    this.pending.set(key, []);
    return items;
  }

  subscribe(conversationId: string, controller: AbortController): () => void {
    const key = String(conversationId ?? "").trim();
    if (!key) return () => undefined;
    let waiters = this.waiters.get(key);
    if (!waiters) {
      waiters = new Set();
      this.waiters.set(key, waiters);
    }
    waiters.add(controller);
    return () => {
      waiters?.delete(controller);
      if (waiters && waiters.size === 0) this.waiters.delete(key);
    };
  }

  private signal(conversationId: string): void {
    const waiters = this.waiters.get(conversationId);
    if (!waiters) return;
    for (const controller of waiters) {
      if (!controller.signal.aborted) controller.abort(createAiSteerRefreshError());
    }
  }

  private end(conversationId: string): void {
    this.active.delete(conversationId);
    this.pending.delete(conversationId);
    this.waiters.delete(conversationId);
  }
}
