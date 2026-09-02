import { AppError, notFound } from "./errors.js";
import { estimateAiTokens, type AiManager, type ImAiPromptInput } from "./ai.js";
import type { Store } from "./store.js";
import type { AuthUser, UserAuthService } from "./user-auth.js";
import { runWithRequestActor } from "./request-context.js";
import { id, json, now } from "./utils.js";
import { IM_MAX_MENTIONS_PER_MESSAGE, ImService, parseImMentions } from "./im.js";
import { canReadWorkModule, type WorkModulePermissions } from "./work-permissions.js";

export type ImRealtimeEvent = {
  id: string;
  type: "conversation" | "message" | "chain" | "turn" | "delta" | "reset";
  conversationId: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

type EventListener = (event: ImRealtimeEvent) => void;
type EventSubscription = { listener: EventListener; disconnect: () => void; expirationTimer?: NodeJS.Timeout };

type InvocationResult = {
  callId: string;
  callIds: string[];
  attemptCount: number;
  primaryAttemptCount: number;
  content: string;
  model: Record<string, unknown>;
  stage: "primary" | "fallback";
  durationMs: number;
};

const IM_USER_CHAIN_CONCURRENCY = 3;
const IM_MESSAGE_MAX_CHARACTERS = 20_000;
const IM_EVENT_CONNECTION_LIMIT_PER_USER = 5;
const IM_RECIPIENT_CACHE_LIMIT = 1_000;
const IM_CONTEXT_FIXED_RESERVE_TOKENS = 8_192;

function requiredString(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function publicError(error: unknown): { code: string; message: string } {
  if (error instanceof AppError) return { code: error.code, message: error.message };
  return { code: "IM_AI_CHAIN_FAILED", message: "IM AI 交流链失败" };
}

function effectiveAbortError(signal: AbortSignal, error: unknown): unknown {
  return signal.aborted && signal.reason instanceof Error ? signal.reason : error;
}

function scoreFromContent(content: string): number | null {
  const candidate = content.match(/\{[\s\S]*\}/u)?.[0] ?? "";
  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    const score = Number(parsed.score);
    return Number.isInteger(score) && score >= 0 && score <= 100 ? score : null;
  } catch {
    return null;
  }
}

export class ImOrchestrator {
  private readonly listeners = new Map<string, Set<EventSubscription>>();
  private readonly queuedChainIds: string[] = [];
  private readonly queuedChainSet = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly activeByUser = new Map<string, number>();
  private readonly streamingReplies = new Map<string, ImRealtimeEvent>();
  private readonly recipientCache = new Map<string, string[]>();
  private readonly activeRunPromises = new Set<Promise<void>>();
  private disposed = false;

  constructor(
    private readonly store: Store,
    private readonly auth: UserAuthService,
    private readonly im: ImService,
    private readonly ai: AiManager
  ) {}

  private get db() {
    return this.store.db;
  }

  subscribe(userId: string, listener: EventListener, disconnect: () => void = () => undefined, expiresAt?: string): () => void {
    let listeners = this.listeners.get(userId);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(userId, listeners);
    }
    if (listeners.size >= IM_EVENT_CONNECTION_LIMIT_PER_USER) {
      throw new AppError(429, "IM_EVENT_CONNECTION_LIMIT", "IM 实时连接过多，请关闭其他页面后重试");
    }
    const subscription: EventSubscription = { listener, disconnect };
    listeners.add(subscription);
    const scheduleExpiration = (): void => {
      if (!expiresAt || !listeners?.has(subscription)) return;
      const remainingMs = Date.parse(expiresAt) - Date.now();
      if (remainingMs <= 0) {
        listeners.delete(subscription);
        if (listeners.size === 0) this.listeners.delete(userId);
        disconnect();
        return;
      }
      subscription.expirationTimer = setTimeout(scheduleExpiration, Math.min(remainingMs, 2_147_483_647));
      subscription.expirationTimer.unref();
    };
    scheduleExpiration();
    for (const [turnId, event] of this.streamingReplies) {
      const chainId = optionalString(event.payload.chainId);
      const active = chainId ? this.db.get(
        `SELECT chain.status AS chain_status, turn.status AS turn_status
         FROM im_chains chain JOIN im_chain_turns turn ON turn.chain_id = chain.id
         WHERE chain.id = ? AND turn.id = ?`,
        chainId,
        turnId
      ) : null;
      if (requiredString(active?.chain_status) !== "running" || requiredString(active?.turn_status) !== "running") {
        this.streamingReplies.delete(turnId);
        continue;
      }
      const membership = this.db.get(
        `SELECT 1 AS present FROM im_human_memberships
         WHERE conversation_id = ? AND user_id = ? AND left_at IS NULL`,
        event.conversationId,
        userId
      );
      if (membership) {
        try {
          listener({ ...event, id: id("imEvent"), createdAt: now() });
        } catch (error) {
          listeners.delete(subscription);
          if (listeners.size === 0) this.listeners.delete(userId);
          throw error;
        }
      }
    }
    return () => {
      if (subscription.expirationTimer) clearTimeout(subscription.expirationTimer);
      listeners?.delete(subscription);
      if (listeners?.size === 0) this.listeners.delete(userId);
    };
  }

  disconnectUser(userId: string): void {
    const subscriptions = this.listeners.get(userId);
    if (!subscriptions) return;
    this.listeners.delete(userId);
    for (const subscription of subscriptions) {
      if (subscription.expirationTimer) clearTimeout(subscription.expirationTimer);
      try {
        subscription.disconnect();
      } catch {
        // 连接关闭失败不应阻塞其他订阅释放。
      }
    }
  }

  streamingReplySnapshots(conversationId: string): Record<string, unknown>[] {
    return [...this.streamingReplies.values()]
      .filter((event) => event.conversationId === conversationId)
      .map((event) => structuredClone(event.payload));
  }

  private publish(conversationId: string, type: ImRealtimeEvent["type"], payload: Record<string, unknown>): void {
    const event: ImRealtimeEvent = { id: id("imEvent"), type, conversationId, payload, createdAt: now() };
    let userIds = this.recipientCache.get(conversationId);
    if (!userIds) {
      userIds = this.db.all(
        `SELECT DISTINCT user_id FROM im_human_memberships
         WHERE conversation_id = ? AND left_at IS NULL`,
        conversationId
      ).map((row) => requiredString(row.user_id));
      if (this.recipientCache.size >= IM_RECIPIENT_CACHE_LIMIT) {
        const oldestConversationId = this.recipientCache.keys().next().value;
        if (oldestConversationId) this.recipientCache.delete(oldestConversationId);
      }
      this.recipientCache.set(conversationId, userIds);
    } else {
      this.recipientCache.delete(conversationId);
      this.recipientCache.set(conversationId, userIds);
    }
    for (const userId of userIds) {
      this.publishToUser(userId, event);
    }
  }

  private publishToUser(userId: string, event: ImRealtimeEvent): void {
    const listeners = this.listeners.get(userId);
    if (!listeners) return;
    for (const subscription of [...listeners]) {
      try {
        subscription.listener(event);
      } catch {
        listeners.delete(subscription);
      }
    }
    if (listeners.size === 0) this.listeners.delete(userId);
  }

  publishConversation(conversationId: string): void {
    this.recipientCache.delete(conversationId);
    this.publish(conversationId, "conversation", {});
  }

  publishConversationToUser(userId: string, conversationId: string): void {
    this.publishToUser(userId, {
      id: id("imEvent"),
      type: "conversation",
      conversationId,
      payload: { membershipChanged: true },
      createdAt: now()
    });
  }

  forgetConversation(conversationId: string): void {
    this.recipientCache.delete(conversationId);
  }

  publishMessageResult(result: Record<string, unknown>): void {
    const message = result.message && typeof result.message === "object" && !Array.isArray(result.message)
      ? result.message as Record<string, unknown>
      : null;
    if (!message) return;
    const conversationId = requiredString(message.conversationId);
    const chain = result.chain && typeof result.chain === "object" && !Array.isArray(result.chain)
      ? result.chain as Record<string, unknown>
      : null;
    this.publish(conversationId, "message", {
      message,
      chain: chain ? { id: requiredString(chain.id), status: requiredString(chain.status) } : null,
      duplicate: result.duplicate === true
    });
    if (chain && requiredString(chain.status) === "queued") this.enqueue(requiredString(chain.id));
  }

  enqueue(chainId: string): void {
    if (this.disposed || this.queuedChainSet.has(chainId) || this.controllers.has(chainId)) return;
    const chain = this.db.get("SELECT status FROM im_chains WHERE id = ?", chainId);
    if (!chain || requiredString(chain.status) !== "queued") return;
    this.queuedChainSet.add(chainId);
    this.queuedChainIds.push(chainId);
    this.drain();
  }

  cancelConversation(conversationId: string, reason = "human_message_received"): void {
    this.recipientCache.delete(conversationId);
    this.clearStreamingReplies(conversationId);
    for (const [chainId, controller] of this.controllers) {
      const chain = this.db.get("SELECT conversation_id FROM im_chains WHERE id = ?", chainId);
      if (requiredString(chain?.conversation_id) === conversationId) {
        controller.abort(new AppError(499, "IM_CHAIN_CANCELLED", reason));
      }
    }
    const active = this.db.all(
      `SELECT id FROM im_chains WHERE conversation_id = ? AND status IN ('queued', 'running', 'waiting_config')`,
      conversationId
    );
    for (const row of active) {
      const chainId = requiredString(row.id);
      this.controllers.get(chainId)?.abort(new AppError(499, "IM_CHAIN_CANCELLED", reason));
      this.queuedChainSet.delete(chainId);
    }
    const timestamp = now();
    this.db.run(
      `UPDATE im_chains SET status = 'cancelled', error_code = 'IM_CHAIN_CANCELLED', error_message = ?,
       updated_at = ?, completed_at = ? WHERE conversation_id = ? AND status IN ('queued', 'running', 'waiting_config')`,
      reason,
      timestamp,
      timestamp,
      conversationId
    );
    this.publish(conversationId, "chain", { status: "cancelled", reason });
  }

  abortConversationRuns(conversationId: string, reason: string, preservedChainId: string | null): void {
    this.recipientCache.delete(conversationId);
    this.clearStreamingReplies(conversationId, preservedChainId);
    for (const [chainId, controller] of this.controllers) {
      if (chainId === preservedChainId) continue;
      const chain = this.db.get("SELECT conversation_id FROM im_chains WHERE id = ?", chainId);
      if (requiredString(chain?.conversation_id) === conversationId) {
        controller.abort(new AppError(499, "IM_CHAIN_CANCELLED", reason));
      }
    }
    for (let index = this.queuedChainIds.length - 1; index >= 0; index -= 1) {
      const chainId = this.queuedChainIds[index];
      if (!chainId || chainId === preservedChainId) continue;
      const chain = this.db.get("SELECT conversation_id FROM im_chains WHERE id = ?", chainId);
      if (requiredString(chain?.conversation_id) !== conversationId) continue;
      this.queuedChainIds.splice(index, 1);
      this.queuedChainSet.delete(chainId);
    }
  }

  private clearStreamingReplies(conversationId: string, preservedChainId: string | null = null): void {
    for (const [turnId, event] of this.streamingReplies) {
      if (event.conversationId !== conversationId || optionalString(event.payload.chainId) === preservedChainId) continue;
      this.streamingReplies.delete(turnId);
    }
  }

  private drain(): void {
    if (this.disposed) return;
    for (let index = 0; index < this.queuedChainIds.length;) {
      const chainId = this.queuedChainIds[index];
      if (!chainId) break;
      const chain = this.db.get("SELECT initiator_user_id, status FROM im_chains WHERE id = ?", chainId);
      if (!chain || requiredString(chain.status) !== "queued") {
        this.queuedChainIds.splice(index, 1);
        this.queuedChainSet.delete(chainId);
        continue;
      }
      const userId = requiredString(chain.initiator_user_id);
      if ((this.activeByUser.get(userId) ?? 0) >= IM_USER_CHAIN_CONCURRENCY) {
        index += 1;
        continue;
      }
      this.queuedChainIds.splice(index, 1);
      this.queuedChainSet.delete(chainId);
      this.activeByUser.set(userId, (this.activeByUser.get(userId) ?? 0) + 1);
      const controller = new AbortController();
      this.controllers.set(chainId, controller);
      const run = this.runChain(chainId, controller.signal);
      this.activeRunPromises.add(run);
      void run.finally(() => {
        this.activeRunPromises.delete(run);
        this.controllers.delete(chainId);
        const remaining = Math.max(0, (this.activeByUser.get(userId) ?? 1) - 1);
        if (remaining === 0) this.activeByUser.delete(userId);
        else this.activeByUser.set(userId, remaining);
        this.drain();
      });
    }
  }

  private chainRow(chainId: string): Record<string, unknown> {
    const row = this.db.get("SELECT * FROM im_chains WHERE id = ?", chainId);
    if (!row) throw notFound("IM 交流链");
    return row;
  }

  private conversationRow(conversationId: string): Record<string, unknown> {
    const row = this.db.get("SELECT * FROM im_conversations WHERE id = ?", conversationId);
    if (!row) throw notFound("IM 会话");
    return row;
  }

  private characterMembership(membershipId: string): Record<string, unknown> {
    const row = this.db.get("SELECT * FROM im_character_memberships WHERE id = ?", membershipId);
    if (!row) throw notFound("IM 角色成员");
    return row;
  }

  private activeCharacters(conversationId: string): Record<string, unknown>[] {
    return this.db.all(
      `SELECT * FROM im_character_memberships
       WHERE conversation_id = ? AND left_at IS NULL AND status = 'active' AND character_id IS NOT NULL
       ORDER BY joined_at, id`,
      conversationId
    );
  }

  private messageRow(messageId: string): Record<string, unknown> {
    const row = this.db.get("SELECT * FROM im_messages WHERE id = ?", messageId);
    if (!row) throw notFound("IM 消息");
    return row;
  }

  private mentionedCharacterMembershipIds(messageId: string, conversationId: string, senderCharacterId?: string | null): string[] {
    const membershipIds = this.db.all(
      `SELECT membership.id FROM im_mentions mention
       JOIN im_character_memberships membership
         ON membership.character_id = mention.target_id AND membership.conversation_id = ?
       WHERE mention.message_id = ? AND mention.target_kind = 'character'
         AND membership.left_at IS NULL AND membership.status = 'active'
         AND (? IS NULL OR membership.character_id <> ?)
       ORDER BY mention.position`,
      conversationId,
      messageId,
      senderCharacterId ?? null,
      senderCharacterId ?? null
    ).map((row) => requiredString(row.id));
    return [...new Set(membershipIds)];
  }

  private participantContext(conversationId: string, currentSender: Record<string, unknown>): string {
    const humans = this.db.all(
      `SELECT user.id, user.username, user.display_name, user.avatar_sha256,
              settings.preferred_name, settings.pronouns, settings.identity_summary, settings.additional_notes
       FROM im_human_memberships membership JOIN users user ON user.id = membership.user_id
       LEFT JOIN im_user_settings settings ON settings.user_id = user.id
       WHERE membership.conversation_id = ? AND membership.left_at IS NULL
       ORDER BY membership.joined_at, membership.id`,
      conversationId
    ).map((row) => ({
      mentionUri: `mention://user/${requiredString(row.id)}`,
      userId: requiredString(row.id),
      username: requiredString(row.username),
      displayName: requiredString(row.display_name),
      identity: {
        preferredName: optionalString(row.preferred_name) ?? requiredString(row.display_name),
        pronouns: requiredString(row.pronouns),
        identitySummary: requiredString(row.identity_summary),
        additionalNotes: requiredString(row.additional_notes)
      }
    }));
    const characters = this.activeCharacters(conversationId).map((row) => {
      const snapshot = json<Record<string, unknown>>(requiredString(row.snapshot_json), {});
      return {
        mentionUri: `mention://character/${requiredString(row.character_id)}`,
        characterId: requiredString(row.character_id),
        name: snapshot.name ?? "未知角色",
        workTitle: snapshot.workTitle ?? "未知作品",
        publicSummary: snapshot.publicSummary ?? ""
      };
    });
    return JSON.stringify({ humans, characters, currentSender });
  }

  private characterHistory(
    membership: Record<string, unknown>,
    conversation: Record<string, unknown>,
    throughSequence: number,
    maximumHistoryTokens: number
  ): { history: string; summary: string } {
    const membershipId = requiredString(membership.id);
    const contextEpoch = Number(conversation.context_epoch);
    const context = this.db.get(
      `SELECT summary, summarized_through_sequence FROM im_character_contexts
       WHERE character_membership_id = ? AND context_epoch = ?`,
      membershipId,
      contextEpoch
    );
    const summarizedThroughSequence = Number(context?.summarized_through_sequence ?? 0);
    const rows = this.db.all(
      `SELECT message.* FROM im_message_deliveries delivery
       JOIN im_messages message ON message.id = delivery.message_id
       WHERE delivery.character_membership_id = ? AND message.context_epoch = ?
         AND message.sequence > ? AND message.sequence <= ?
       ORDER BY message.sequence DESC`,
      membershipId,
      contextEpoch,
      summarizedThroughSequence,
      throughSequence
    );
    const lines: string[] = [];
    let historyTokens = 0;
    for (const row of rows) {
      const line = this.historyLine(row);
      const additionTokens = estimateAiTokens(`${lines.length ? "\n\n" : ""}${line}`);
      if (historyTokens + additionTokens > maximumHistoryTokens) break;
      lines.unshift(line);
      historyTokens += additionTokens;
    }
    return { history: lines.join("\n\n"), summary: requiredString(context?.summary) };
  }

  private minimumContextWindow(chain: Record<string, unknown>): number {
    const modelIds = [optionalString(chain.primary_model_id), optionalString(chain.fallback_model_id)]
      .filter((modelId): modelId is string => Boolean(modelId));
    const contextWindows = modelIds.map((modelId) => Number(
      this.db.get("SELECT context_window FROM models WHERE id = ?", modelId)?.context_window ?? 128_000
    ));
    return contextWindows.length ? Math.min(...contextWindows) : 128_000;
  }

  private maximumHistoryTokens(chain: Record<string, unknown>, participantContext: string): number {
    const participantTokens = estimateAiTokens(participantContext);
    const availableHistoryTokens = this.minimumContextWindow(chain) - IM_CONTEXT_FIXED_RESERVE_TOKENS - participantTokens;
    if (availableHistoryTokens < 1) {
      throw new AppError(
        409,
        "IM_PARTICIPANT_CONTEXT_TOO_LARGE",
        "当前群成员身份信息过长，无法在所选模型上下文内完整暴露；请减少成员或缩短身份信息"
      );
    }
    return availableHistoryTokens;
  }

  private historyLine(row: Record<string, unknown>): string {
    const sender = json<Record<string, unknown>>(requiredString(row.sender_snapshot_json), {});
    const label = sender.name ?? sender.displayName ?? (requiredString(row.sender_kind) === "system" ? "系统" : "成员");
    return `[${Number(row.sequence)}] ${String(label)}：${requiredString(row.content)}`;
  }

  private assertGenerationStillCurrent(
    chain: Record<string, unknown>,
    sourceMessage: Record<string, unknown>,
    signal: AbortSignal
  ): void {
    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new AppError(499, "IM_CHAIN_CANCELLED", "IM 交流链已取消");
    }
    const currentChain = this.chainRow(requiredString(chain.id));
    const currentConversation = this.conversationRow(requiredString(chain.conversation_id));
    if (requiredString(currentChain.status) !== "running"
      || requiredString(currentConversation.status) !== "active"
      || Number(currentConversation.context_epoch) !== Number(sourceMessage.context_epoch)) {
      throw new AppError(499, "IM_CHAIN_CANCELLED", "IM 交流链已取消或上下文已经变化");
    }
  }

  private async maybeCompact(
    chain: Record<string, unknown>,
    membership: Record<string, unknown>,
    sourceMessage: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<void> {
    const conversation = this.conversationRow(requiredString(chain.conversation_id));
    const contextEpoch = Number(conversation.context_epoch);
    const senderSnapshot = json<Record<string, unknown>>(requiredString(sourceMessage.sender_snapshot_json), {});
    const participantContext = this.participantContext(requiredString(conversation.id), senderSnapshot);
    const historyLimit = this.maximumHistoryTokens(chain, participantContext);
    for (;;) {
      const context = this.db.get(
        `SELECT summary, summarized_through_sequence FROM im_character_contexts
         WHERE character_membership_id = ? AND context_epoch = ?`,
        requiredString(membership.id),
        contextEpoch
      );
      const summarizedThroughSequence = Number(context?.summarized_through_sequence ?? 0);
      const rows = this.db.all(
        `SELECT message.* FROM im_message_deliveries delivery
         JOIN im_messages message ON message.id = delivery.message_id
         WHERE delivery.character_membership_id = ? AND message.context_epoch = ?
           AND message.sequence > ? AND message.sequence <= ?
         ORDER BY message.sequence`,
        requiredString(membership.id),
        contextEpoch,
        summarizedThroughSequence,
        Number(sourceMessage.sequence)
      );
      const totalTokens = rows.reduce((total, row) => total + estimateAiTokens(`${total ? "\n\n" : ""}${this.historyLine(row)}`), 0);
      if (rows.length <= 60 && totalTokens <= historyLimit) return;
      let retainedTokens = 0;
      let compactCandidateCount = rows.length;
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const lineTokens = estimateAiTokens(`${retainedTokens ? "\n\n" : ""}${this.historyLine(rows[index] ?? {})}`);
        if (retainedTokens + lineTokens > historyLimit) break;
        retainedTokens += lineTokens;
        compactCandidateCount = index;
      }
      if (compactCandidateCount <= 0 && rows.length > 60) compactCandidateCount = Math.max(1, rows.length - 20);
      const compactCandidates = rows.slice(0, Math.max(1, compactCandidateCount));
      const compactLines: string[] = [];
      let compactTokens = 0;
      let compactThrough = summarizedThroughSequence;
      for (const row of compactCandidates) {
        const line = this.historyLine(row);
        const additionTokens = estimateAiTokens(`${compactLines.length ? "\n\n" : ""}${line}`);
        if (compactTokens + additionTokens > historyLimit) break;
        compactLines.push(line);
        compactTokens += additionTokens;
        compactThrough = Number(row.sequence);
      }
      if (compactThrough <= summarizedThroughSequence) {
        throw new AppError(409, "IM_MESSAGE_CONTEXT_TOO_LARGE", "单条 IM 消息超过所选模型可安全处理的上下文预算");
      }
      const turnId = this.createTurn(requiredString(chain.id), requiredString(membership.id), "compact");
      try {
        const result = await this.invoke(
          chain,
          membership,
          "compact",
          `把已送达历史压缩为当前角色可继续使用的第一人称 IM 记忆；压缩到消息序号 ${compactThrough}，只保留事实、关系变化、承诺、未决事项和重要称呼。`,
          sourceMessage,
          signal,
          undefined,
          (content) => {
            if (!content.trim()) throw new AppError(502, "IM_AI_EMPTY_COMPACTION", "AI 返回了空白的角色上下文摘要");
          },
          undefined,
          { history: compactLines.join("\n\n"), summary: requiredString(context?.summary) }
        );
        this.assertGenerationStillCurrent(chain, sourceMessage, signal);
        this.assertCharacterAuthorization(chain, this.characterMembership(requiredString(membership.id)));
        this.db.run(
          `INSERT INTO im_character_contexts (
             character_membership_id, context_epoch, summary, summarized_through_sequence, updated_at
           ) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(character_membership_id, context_epoch) DO UPDATE SET
             summary = excluded.summary,
             summarized_through_sequence = excluded.summarized_through_sequence,
             updated_at = excluded.updated_at`,
          requiredString(membership.id),
          contextEpoch,
          result.content.slice(0, 20_000),
          compactThrough,
          now()
        );
        this.finishTurn(turnId, result);
      } catch (error) {
        const effectiveError = effectiveAbortError(signal, error);
        this.failTurn(turnId, effectiveError, signal.aborted ? "cancelled" : "failed");
        if (signal.aborted) throw effectiveError;
        if (effectiveError instanceof AppError && [
          "IM_CHARACTER_ACCESS_DENIED",
          "IM_CHARACTER_UNAVAILABLE",
          "IM_OWNER_DISABLED",
          "IM_INITIATOR_DISABLED"
        ].includes(effectiveError.code)) throw effectiveError;
        if (totalTokens > historyLimit) {
          throw new AppError(502, "IM_CONTEXT_COMPACTION_FAILED", "角色上下文压缩失败，无法在不丢失历史的情况下继续回答");
        }
        return;
      }
    }
  }

  private assertCharacterAuthorization(chain: Record<string, unknown>, membership: Record<string, unknown>): {
    owner: AuthUser;
    initiator: AuthUser;
    initiatorPermissions: WorkModulePermissions | null;
    workId: string;
    characterId: string;
  } {
    if (optionalString(membership.left_at) || requiredString(membership.status) !== "active") {
      throw new AppError(409, "IM_CHARACTER_UNAVAILABLE", "IM 角色已经离开或暂停使用");
    }
    const owner = this.auth.getUser(requiredString(chain.authorization_user_id));
    if (owner.status !== "active") throw new AppError(403, "IM_OWNER_DISABLED", "群主账户已停用，角色能力暂停");
    const initiator = this.auth.getUser(requiredString(chain.initiator_user_id));
    if (initiator.status !== "active") throw new AppError(403, "IM_INITIATOR_DISABLED", "发起人账户已停用，角色能力暂停");
    const characterId = optionalString(membership.character_id);
    const workId = optionalString(membership.source_work_id);
    if (!characterId || !workId) throw new AppError(409, "IM_CHARACTER_UNAVAILABLE", "来源角色或作品已不可用");
    try {
      this.im.assertCharacterAvailable(owner, characterId);
    } catch (error) {
      this.db.run("UPDATE im_character_memberships SET status = 'suspended' WHERE id = ?", requiredString(membership.id));
      this.publishConversation(requiredString(chain.conversation_id));
      throw error;
    }
    return {
      owner,
      initiator,
      initiatorPermissions: this.auth.workModulePermissions(initiator, workId, true),
      workId,
      characterId
    };
  }

  private publicCharacterPrompt(membership: Record<string, unknown>): string {
    const snapshot = json<Record<string, unknown>>(requiredString(membership.snapshot_json), {});
    return [
      "以下 JSON 是群主邀请角色时冻结的公开角色资料。只能依据这些公开字段和当前 IM 历史扮演角色；不得推测、查询或声称知道来源作品中的其他私有内容。",
      JSON.stringify({
        name: snapshot.name ?? "角色",
        code: snapshot.code ?? "",
        workTitle: snapshot.workTitle ?? "",
        publicSummary: snapshot.publicSummary ?? ""
      })
    ].join("\n");
  }

  private shouldFailover(error: unknown): boolean {
    if (!(error instanceof AppError)) return true;
    return ![
      "IM_CHAIN_CANCELLED",
      "AI_STREAM_REQUEST_CANCELLED",
      "IM_CHARACTER_ACCESS_DENIED",
      "IM_CHARACTER_UNAVAILABLE",
      "IM_OWNER_DISABLED",
      "IM_INITIATOR_DISABLED",
      "IM_PARTICIPANT_CONTEXT_TOO_LARGE",
      "IM_MESSAGE_CONTEXT_TOO_LARGE",
      "DAILY_TOKEN_QUOTA_EXCEEDED",
      "MONTHLY_TOKEN_QUOTA_EXCEEDED",
      "WORK_ACCESS_DENIED",
      "WORK_MODULE_READ_DENIED",
      "WORK_MODULE_WRITE_DENIED"
    ].includes(error.code);
  }

  private resetStreamingReply(turnId: string): void {
    const snapshot = this.streamingReplies.get(turnId);
    if (snapshot) snapshot.payload.content = "";
  }

  private async invoke(
    chain: Record<string, unknown>,
    membership: Record<string, unknown>,
    kind: ImAiPromptInput["kind"],
    instruction: string,
    sourceMessage: Record<string, unknown>,
    signal: AbortSignal,
    onDelta?: (delta: string) => void,
    validateContent?: (content: string) => void,
    streamTurnId?: string,
    historyOverride?: { history: string; summary: string }
  ): Promise<InvocationResult> {
    const conversation = this.conversationRow(requiredString(chain.conversation_id));
    const authorization = this.assertCharacterAuthorization(chain, membership);
    const snapshot = json<Record<string, unknown>>(requiredString(sourceMessage.sender_snapshot_json), {});
    const participantContext = this.participantContext(requiredString(conversation.id), snapshot);
    const maximumHistoryTokens = this.maximumHistoryTokens(chain, participantContext);
    const context = this.characterHistory(membership, conversation, Number(sourceMessage.sequence), maximumHistoryTokens);
    const common = {
      workId: authorization.workId,
      characterId: authorization.characterId,
      kind,
      instruction,
      participantContext,
      history: historyOverride?.history ?? context.history,
      summary: historyOverride?.summary ?? context.summary,
      characterPrompt: kind === "compact"
        ? this.publicCharacterPrompt(membership)
        : authorization.initiatorPermissions && canReadWorkModule(authorization.initiatorPermissions, "characters")
          ? undefined
          : this.publicCharacterPrompt(membership),
      allowRoleplayMemory: kind !== "compact" && Boolean(
          authorization.initiatorPermissions
          && canReadWorkModule(authorization.initiatorPermissions, "characters")
          && canReadWorkModule(authorization.initiatorPermissions, "ai-chat")
        ),
      retryCount: Number(chain.retry_count),
      createdByUserId: requiredString(chain.initiator_user_id),
      signal
    } satisfies Omit<ImAiPromptInput, "modelId">;
    const invokeModel = async (modelId: string, stage: "primary" | "fallback", attemptLimit = Number(chain.retry_count)): Promise<InvocationResult> => {
      const started = process.hrtime.bigint();
      const result = await runWithRequestActor({
        userId: authorization.initiator.userId,
        username: authorization.initiator.username,
        displayName: authorization.initiator.displayName,
        role: authorization.initiator.role,
        authentication: "session"
      }, () => this.ai.generateIm({ ...common, modelId, retryCount: attemptLimit }, onDelta, streamTurnId ? () => {
        this.resetStreamingReply(streamTurnId);
        this.publish(requiredString(chain.conversation_id), "reset", {
          chainId: requiredString(chain.id),
          turnId: streamTurnId,
          reason: "retry",
          modelStage: stage,
          kind,
          characterId: membership.character_id
        });
      } : undefined));
      try {
        validateContent?.(result.content);
      } catch (error) {
        if (error instanceof AppError) {
          throw new AppError(error.status, error.code, error.message, {
            ...(error.details && typeof error.details === "object" ? error.details : {}),
            callId: result.callId,
            callIds: [result.callId],
            attemptCount: result.attemptCount,
            failureCount: result.failureCount + 1,
            modelRecordId: result.model.id,
            modelStage: stage
          });
        }
        throw error;
      }
      return {
        callId: result.callId,
        callIds: [result.callId],
        attemptCount: result.attemptCount,
        primaryAttemptCount: 0,
        content: result.content,
        model: result.model,
        stage,
        durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1_000_000)
      };
    };
    const errorDetails = (error: unknown): Record<string, unknown> => error instanceof AppError
      && error.details && typeof error.details === "object" && !Array.isArray(error.details)
      ? error.details as Record<string, unknown>
      : {};
    const errorCallIds = (error: unknown): string[] => {
      const details = errorDetails(error);
      return [...new Set([
        ...(Array.isArray(details.callIds) ? details.callIds.filter((callId): callId is string => typeof callId === "string") : []),
        ...(typeof details.callId === "string" ? [details.callId] : [])
      ])];
    };
    const recordedAttemptCount = (details: Record<string, unknown>, fallback: number): number => (
      Object.prototype.hasOwnProperty.call(details, "attemptCount") && Number.isFinite(Number(details.attemptCount))
        ? Math.max(0, Number(details.attemptCount))
        : fallback
    );
    const recordedFailureCount = (details: Record<string, unknown>, fallback: number): number => (
      Object.prototype.hasOwnProperty.call(details, "failureCount") && Number.isFinite(Number(details.failureCount))
        ? Math.max(0, Number(details.failureCount))
        : fallback
    );
    const enrichedError = (
      error: unknown,
      stage: "primary" | "fallback",
      callIds: string[],
      attemptCount: number,
      primaryAttemptCount: number,
      failureCount: number,
      modelRecordId: string
    ): AppError => {
      const details = errorDetails(error);
      const source = error instanceof AppError
        ? error
        : new AppError(502, "IM_AI_CHAIN_FAILED", "IM AI 交流链失败");
      return new AppError(source.status, source.code, source.message, {
        ...details,
        callId: callIds.at(-1) ?? details.callId,
        callIds,
        attemptCount,
        failureCount,
        primaryAttemptCount,
        fallbackAttemptCount: stage === "fallback" ? Math.max(0, attemptCount - primaryAttemptCount) : 0,
        modelRecordId,
        modelStage: stage
      });
    };
    const invokeValidatedModel = async (modelId: string, stage: "primary" | "fallback"): Promise<InvocationResult> => {
      const semanticAttemptLimit = Math.max(1, Number(chain.retry_count));
      const retryableOutputCodes = new Set([
        "IM_JUDGE_INVALID_SCORE",
        "IM_AI_EMPTY_REPLY",
        "IM_AI_REPLY_TOO_LONG",
        "IM_AI_MENTION_LIMIT_EXCEEDED",
        "IM_AI_MENTION_TARGET_INVALID",
        "IM_AI_EMPTY_COMPACTION",
        "AI_CALL_FAILED"
      ]);
      const started = process.hrtime.bigint();
      const callIds: string[] = [];
      let attemptCount = 0;
      let failureCount = 0;
      while (failureCount < semanticAttemptLimit) {
        try {
          const result = await invokeModel(modelId, stage, semanticAttemptLimit - failureCount);
          return {
            ...result,
            callIds: [...callIds, ...result.callIds],
            attemptCount: attemptCount + result.attemptCount,
            durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1_000_000)
          };
        } catch (error) {
          const details = errorDetails(error);
          for (const callId of errorCallIds(error)) if (!callIds.includes(callId)) callIds.push(callId);
          const consumedAttempts = Math.max(0, Number(details.attemptCount) || 0);
          const consumedFailures = Object.prototype.hasOwnProperty.call(details, "failureCount")
            && Number.isFinite(Number(details.failureCount))
            ? Math.max(0, Number(details.failureCount))
            : consumedAttempts;
          attemptCount += consumedAttempts;
          failureCount += consumedFailures;
          if (error instanceof AppError && retryableOutputCodes.has(error.code)
            && consumedFailures > 0 && failureCount < semanticAttemptLimit) {
            if (streamTurnId) {
              this.resetStreamingReply(streamTurnId);
              this.publish(requiredString(chain.conversation_id), "reset", {
                chainId: requiredString(chain.id),
                turnId: streamTurnId,
                reason: "output_validation_retry",
                modelStage: stage,
                kind,
                characterId: membership.character_id
              });
            }
            continue;
          }
          throw enrichedError(error, stage, callIds, attemptCount, 0, failureCount, modelId);
        }
      }
      throw new AppError(502, "IM_JUDGE_INVALID_SCORE", "AI 没有返回有效的发言意愿分数");
    };
    const primaryModelId = optionalString(chain.primary_model_id);
    const fallbackModelId = optionalString(chain.fallback_model_id);
    if (!primaryModelId) {
      if (!fallbackModelId) throw new AppError(409, "IM_MODEL_NOT_CONFIGURED", "主模型和 fallback 模型均不可用");
      this.db.run("UPDATE im_chains SET model_stage = 'fallback', updated_at = ? WHERE id = ?", now(), requiredString(chain.id));
      const fallback = await invokeValidatedModel(fallbackModelId, "fallback");
      return { ...fallback, primaryAttemptCount: 0 };
    }
    try {
      return await invokeValidatedModel(primaryModelId, "primary");
    } catch (error) {
      if (!this.shouldFailover(error) || signal.aborted) throw error;
      if (!fallbackModelId) throw error;
      if (streamTurnId) {
        this.resetStreamingReply(streamTurnId);
        this.publish(requiredString(chain.conversation_id), "reset", {
          chainId: requiredString(chain.id),
          turnId: streamTurnId,
          reason: "fallback",
          modelStage: "fallback",
          kind,
          characterId: membership.character_id
        });
      }
      this.db.run("UPDATE im_chains SET model_stage = 'fallback', updated_at = ? WHERE id = ?", now(), requiredString(chain.id));
      const primaryDetails = errorDetails(error);
      const primaryCallIds = errorCallIds(error);
      const primaryAttemptCount = recordedAttemptCount(primaryDetails, Number(chain.retry_count));
      const primaryFailureCount = recordedFailureCount(primaryDetails, Number(chain.retry_count));
      try {
        const fallback = await invokeValidatedModel(fallbackModelId, "fallback");
        return {
          ...fallback,
          callIds: [...primaryCallIds, ...fallback.callIds],
          primaryAttemptCount
        };
      } catch (fallbackError) {
        const fallbackDetails = errorDetails(fallbackError);
        const fallbackCallIds = errorCallIds(fallbackError);
        const fallbackAttemptCount = recordedAttemptCount(fallbackDetails, Number(chain.retry_count));
        const fallbackFailureCount = recordedFailureCount(fallbackDetails, fallbackAttemptCount);
        throw enrichedError(
          fallbackError,
          "fallback",
          [...primaryCallIds, ...fallbackCallIds],
          primaryAttemptCount + fallbackAttemptCount,
          primaryAttemptCount,
          primaryFailureCount + fallbackFailureCount,
          fallbackModelId
        );
      }
    }
  }

  private createTurn(chainId: string, membershipId: string, kind: "judge" | "reply" | "compact", status: "pending" | "running" = "running"): string {
    const turnId = id("imTurn");
    this.db.run(
      `INSERT INTO im_chain_turns (id, chain_id, character_membership_id, kind, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      turnId,
      chainId,
      membershipId,
      kind,
      status,
      now()
    );
    return turnId;
  }

  private replyTurnPayload(
    chain: Record<string, unknown>,
    membership: Record<string, unknown>,
    turnId: string,
    status: "pending" | "running" | "completed" | "failed" | "cancelled" | "skipped",
    error?: { code: string; message: string }
  ): Record<string, unknown> {
    const conversationId = requiredString(chain.conversation_id);
    const snapshot = json<Record<string, unknown>>(requiredString(membership.snapshot_json), {});
    const characterId = optionalString(membership.character_id) ?? requiredString(snapshot.id);
    const avatar = characterId ? this.db.get("SELECT sha256 FROM character_avatars WHERE character_id = ?", characterId) : null;
    const avatarSha256 = optionalString(avatar?.sha256);
    return {
      chainId: requiredString(chain.id),
      turnId,
      kind: "reply",
      status,
      characterId,
      character: {
        characterId,
        name: snapshot.name ?? "角色",
        avatarUrl: characterId && avatarSha256
          ? `/api/im/conversations/${encodeURIComponent(conversationId)}/characters/${encodeURIComponent(characterId)}/avatar?v=${encodeURIComponent(avatarSha256)}`
          : null
      },
      ...(error ? { error } : {})
    };
  }

  private publishReplyTurn(
    chain: Record<string, unknown>,
    membership: Record<string, unknown>,
    turnId: string,
    status: "pending" | "running" | "completed" | "failed" | "cancelled" | "skipped",
    error?: { code: string; message: string }
  ): void {
    this.publish(
      requiredString(chain.conversation_id),
      "turn",
      this.replyTurnPayload(chain, membership, turnId, status, error)
    );
  }

  private planReplyTurn(
    chain: Record<string, unknown>,
    membershipId: string,
    sourceMessageId: string
  ): { membershipId: string; turnId: string; sourceMessageId: string } {
    const membership = this.characterMembership(membershipId);
    const turnId = this.createTurn(requiredString(chain.id), membershipId, "reply", "pending");
    this.publishReplyTurn(chain, membership, turnId, "pending");
    return { membershipId, turnId, sourceMessageId };
  }

  private settlePendingReplyTurns(
    chain: Record<string, unknown>,
    status: "failed" | "cancelled" | "skipped",
    error: { code: string; message: string }
  ): void {
    const turns = this.db.all(
      `SELECT turn.id AS turn_id, membership.* FROM im_chain_turns turn
       JOIN im_character_memberships membership ON membership.id = turn.character_membership_id
       WHERE turn.chain_id = ? AND turn.kind = 'reply' AND turn.status = 'pending'
       ORDER BY turn.created_at, turn.id`,
      requiredString(chain.id)
    );
    for (const turn of turns) {
      this.db.run(
        "UPDATE im_chain_turns SET status = ?, failure = ?, completed_at = ? WHERE id = ?",
        status,
        `${error.code}: ${error.message}`.slice(0, 2000),
        now(),
        requiredString(turn.turn_id)
      );
      this.publishReplyTurn(chain, turn, requiredString(turn.turn_id), status, error);
    }
  }

  private finishTurn(turnId: string, result: InvocationResult, score?: number, selected = false): void {
    this.db.run(
      `UPDATE im_chain_turns SET status = 'completed', score = ?, selected = ?, model_id = ?, model_stage = ?,
       attempt_count = ?, duration_ms = ?, ai_call_ids_json = ?, completed_at = ?
       WHERE id = ? AND status IN ('pending', 'running')`,
      score ?? null,
      selected ? 1 : 0,
      requiredString(result.model.id),
      result.stage,
      result.primaryAttemptCount + result.attemptCount,
      result.durationMs,
      JSON.stringify(result.callIds),
      now(),
      turnId
    );
  }

  private failTurn(turnId: string, error: unknown, status: "failed" | "cancelled" = "failed"): void {
    const failure = publicError(error);
    const details = error instanceof AppError && error.details && typeof error.details === "object" && !Array.isArray(error.details)
      ? error.details as Record<string, unknown>
      : {};
    const callIds = [...new Set([
      ...(Array.isArray(details.callIds) ? details.callIds.filter((callId): callId is string => typeof callId === "string") : []),
      ...(typeof details.callId === "string" ? [details.callId] : [])
    ])];
    this.db.run(
      `UPDATE im_chain_turns SET status = ?, failure = ?, model_id = ?, model_stage = ?, attempt_count = ?,
       ai_call_ids_json = ?, completed_at = ? WHERE id = ? AND status IN ('pending', 'running')`,
      status,
      `${failure.code}: ${failure.message}`.slice(0, 2000),
      optionalString(details.modelRecordId),
      optionalString(details.modelStage),
      Math.max(0, Number(details.attemptCount) || 0),
      JSON.stringify(callIds),
      now(),
      turnId
    );
  }

  private async judge(
    chain: Record<string, unknown>,
    membership: Record<string, unknown>,
    sourceMessage: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<number | null> {
    await this.maybeCompact(chain, membership, sourceMessage, signal);
    const turnId = this.createTurn(requiredString(chain.id), requiredString(membership.id), "judge");
    try {
      const result = await this.invoke(
        chain,
        membership,
        "judge",
        "根据最新已送达消息和当前角色立场，判断自己现在是否需要发言。",
        sourceMessage,
        signal,
        undefined,
        (content) => {
          if (scoreFromContent(content) === null) throw new AppError(502, "IM_JUDGE_INVALID_SCORE", "AI 没有返回有效的发言意愿分数");
        }
      );
      const score = scoreFromContent(result.content);
      if (score === null) throw new AppError(502, "IM_JUDGE_INVALID_SCORE", "AI 没有返回有效的发言意愿分数");
      this.assertGenerationStillCurrent(chain, sourceMessage, signal);
      this.finishTurn(turnId, result, score, false);
      this.publishToUser(requiredString(chain.authorization_user_id), {
        id: id("imEvent"),
        type: "turn",
        conversationId: requiredString(chain.conversation_id),
        payload: {
          chainId: requiredString(chain.id),
          turnId,
          kind: "judge",
          characterId: membership.character_id,
          score
        },
        createdAt: now()
      });
      return score;
    } catch (error) {
      const effectiveError = effectiveAbortError(signal, error);
      this.failTurn(turnId, effectiveError, signal.aborted ? "cancelled" : "failed");
      if (signal.aborted) throw effectiveError;
      return null;
    }
  }

  private validatedOutputMentions(conversationId: string, content: string): Array<{
    kind: "character" | "user";
    id: string;
    snapshot: Record<string, unknown>;
    membershipId?: string;
  }> {
    const mentions = parseImMentions(content);
    if (mentions.length > IM_MAX_MENTIONS_PER_MESSAGE) {
      throw new AppError(502, "IM_AI_MENTION_LIMIT_EXCEEDED", `AI 回复超过 ${IM_MAX_MENTIONS_PER_MESSAGE} 个 mention，未写入会话`);
    }
    const characterIds = [...new Set(mentions.filter((mention) => mention.kind === "character").map((mention) => mention.id))];
    const userIds = [...new Set(mentions.filter((mention) => mention.kind === "user").map((mention) => mention.id))];
    const characters = new Map<string, Record<string, unknown>>();
    if (characterIds.length > 0) {
      const placeholders = characterIds.map(() => "?").join(", ");
      for (const row of this.db.all(
        `SELECT * FROM im_character_memberships
         WHERE conversation_id = ? AND character_id IN (${placeholders}) AND left_at IS NULL AND status = 'active'`,
        conversationId,
        ...characterIds
      )) characters.set(requiredString(row.character_id), row);
    }
    const users = new Map<string, Record<string, unknown>>();
    if (userIds.length > 0) {
      const placeholders = userIds.map(() => "?").join(", ");
      for (const row of this.db.all(
        `SELECT user.id, user.username, user.display_name, user.avatar_sha256
         FROM im_human_memberships membership JOIN users user ON user.id = membership.user_id
         WHERE membership.conversation_id = ? AND membership.user_id IN (${placeholders}) AND membership.left_at IS NULL`,
        conversationId,
        ...userIds
      )) users.set(requiredString(row.id), row);
    }
    const result: Array<{ kind: "character" | "user"; id: string; snapshot: Record<string, unknown>; membershipId?: string }> = [];
    for (const mention of mentions) {
      if (mention.kind === "character") {
        const row = characters.get(mention.id);
        if (row) result.push({
          kind: mention.kind,
          id: mention.id,
          membershipId: requiredString(row.id),
          snapshot: json<Record<string, unknown>>(requiredString(row.snapshot_json), {})
        });
        continue;
      }
      const row = users.get(mention.id);
      if (row) result.push({ kind: mention.kind, id: mention.id, snapshot: {
          userId: requiredString(row.id),
          username: requiredString(row.username),
          displayName: requiredString(row.display_name),
          avatarUrl: null,
          avatarSha256: optionalString(row.avatar_sha256)
        } });
    }
    if (result.length !== mentions.length) {
      throw new AppError(502, "IM_AI_MENTION_TARGET_INVALID", "AI 回复包含已经离开或不可用的 mention 目标，未写入会话");
    }
    return result;
  }

  private appendCharacterMessage(
    chain: Record<string, unknown>,
    membership: Record<string, unknown>,
    invocation: InvocationResult,
    turnId: string
  ): Record<string, unknown> {
    const conversationId = requiredString(chain.conversation_id);
    const conversation = this.conversationRow(conversationId);
    const messageId = id("imMessage");
    const sequence = Number(this.db.get(
      "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM im_messages WHERE conversation_id = ?",
      conversationId
    )?.sequence ?? 1);
    const mentions = this.validatedOutputMentions(conversationId, invocation.content);
    const snapshot = json<Record<string, unknown>>(requiredString(membership.snapshot_json), {});
    const senderCharacterId = optionalString(membership.character_id);
    const avatar = senderCharacterId
      ? this.db.get("SELECT sha256 FROM character_avatars WHERE character_id = ?", senderCharacterId)
      : undefined;
    const avatarSha256 = optionalString(avatar?.sha256);
    snapshot.avatarUrl = senderCharacterId && avatarSha256
      ? `/api/im/conversations/${encodeURIComponent(conversationId)}/characters/${encodeURIComponent(senderCharacterId)}/avatar?v=${encodeURIComponent(avatarSha256)}`
      : null;
    snapshot.avatarSha256 = avatarSha256;
    const metadata = {
      modelId: requiredString(invocation.model.id),
      modelDisplayName: requiredString(invocation.model.displayName),
      modelStage: invocation.stage,
      durationMs: invocation.durationMs,
      callId: invocation.callId,
      callIds: invocation.callIds,
      retryCount: Number(chain.retry_count),
      attemptCount: invocation.primaryAttemptCount + invocation.attemptCount,
      primaryAttemptCount: invocation.primaryAttemptCount,
      fallbackAttemptCount: invocation.stage === "fallback" ? invocation.attemptCount : 0
    };
    const timestamp = now();
    this.db.transaction(() => {
      if (senderCharacterId) this.im.captureCharacterAvatarVersion(conversationId, senderCharacterId, timestamp);
      this.db.run(
        `INSERT INTO im_messages (
           id, conversation_id, sequence, context_epoch, sender_kind, sender_character_id,
           sender_snapshot_json, content, chain_id, metadata_json, created_at
         ) VALUES (?, ?, ?, ?, 'character', ?, ?, ?, ?, ?, ?)`,
        messageId,
        conversationId,
        sequence,
        Number(conversation.context_epoch),
        senderCharacterId,
        JSON.stringify(snapshot),
        invocation.content,
        requiredString(chain.id),
        JSON.stringify(metadata),
        timestamp
      );
      mentions.forEach((mention, position) => this.db.run(
        `INSERT INTO im_mentions (message_id, position, target_kind, target_id, target_snapshot_json)
         VALUES (?, ?, ?, ?, ?)`,
        messageId,
        position,
        mention.kind,
        mention.id,
        JSON.stringify(mention.snapshot)
      ));
      const deliveryIds = new Set<string>([requiredString(membership.id)]);
      if (requiredString(chain.mode) === "proactive") {
        for (const participant of this.activeCharacters(conversationId)) deliveryIds.add(requiredString(participant.id));
      } else if (requiredString(chain.mode) === "mention") {
        for (const mention of mentions) if (mention.membershipId) deliveryIds.add(mention.membershipId);
      }
      for (const membershipId of deliveryIds) {
        this.db.run(
          "INSERT INTO im_message_deliveries (message_id, character_membership_id, delivered_at) VALUES (?, ?, ?)",
          messageId,
          membershipId,
          timestamp
        );
      }
      this.finishTurn(turnId, invocation, undefined, true);
      this.db.run(
        "UPDATE im_chains SET generated_count = generated_count + 1, updated_at = ? WHERE id = ?",
        timestamp,
        requiredString(chain.id)
      );
      this.db.run("UPDATE im_conversations SET updated_at = ? WHERE id = ?", timestamp, conversationId);
    });
    return {
      id: messageId,
      conversationId,
      sequence,
      contextEpoch: Number(conversation.context_epoch),
      senderKind: "character",
      senderCharacterId: membership.character_id ?? snapshot.id ?? null,
      sender: snapshot,
      content: invocation.content,
      mentions: mentions.map((mention, position) => ({ kind: mention.kind, id: mention.id, position, snapshot: mention.snapshot })),
      chainId: requiredString(chain.id),
      metadata,
      createdAt: timestamp
    };
  }

  private async reply(
    chain: Record<string, unknown>,
    membershipId: string,
    turnId: string,
    sourceMessage: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<Record<string, unknown>> {
    const membership = this.characterMembership(membershipId);
    let streamed = "";
    let result: InvocationResult | null = null;
    try {
      await this.maybeCompact(chain, membership, sourceMessage, signal);
      this.db.run("UPDATE im_chain_turns SET status = 'running' WHERE id = ?", turnId);
      this.publishReplyTurn(chain, membership, turnId, "running");
      this.streamingReplies.set(turnId, {
        id: id("imEvent"),
        type: "turn",
        conversationId: requiredString(chain.conversation_id),
        payload: { ...this.replyTurnPayload(chain, membership, turnId, "running"), content: "" },
        createdAt: now()
      });
      result = await this.invoke(
        chain,
        membership,
        "reply",
        "回复最新收到的 IM 消息；只有确实需要点名时才使用 canonical mention URI。",
        sourceMessage,
        signal,
        (delta) => {
          streamed += delta;
        },
        (content) => {
          if (!content.trim()) throw new AppError(502, "IM_AI_EMPTY_REPLY", "AI 返回了空消息");
          if (Array.from(content).length > IM_MESSAGE_MAX_CHARACTERS) {
            throw new AppError(502, "IM_AI_REPLY_TOO_LONG", `AI 回复超过 ${IM_MESSAGE_MAX_CHARACTERS} 字符，未写入会话`);
          }
          if (parseImMentions(content).length > IM_MAX_MENTIONS_PER_MESSAGE) {
            throw new AppError(502, "IM_AI_MENTION_LIMIT_EXCEEDED", `AI 回复超过 ${IM_MAX_MENTIONS_PER_MESSAGE} 个 mention，未写入会话`);
          }
          this.validatedOutputMentions(requiredString(chain.conversation_id), content);
        },
        turnId
      );
      if (signal.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new AppError(499, "IM_CHAIN_CANCELLED", "IM 交流链已取消");
      }
      const currentChain = this.chainRow(requiredString(chain.id));
      const currentConversation = this.conversationRow(requiredString(chain.conversation_id));
      if (requiredString(currentChain.status) !== "running"
        || requiredString(currentConversation.status) !== "active"
        || Number(currentConversation.context_epoch) !== Number(sourceMessage.context_epoch)) {
        throw new AppError(499, "IM_CHAIN_CANCELLED", "IM 交流链已取消或上下文已经变化");
      }
      if (!result.content.trim()) throw new AppError(502, "IM_AI_EMPTY_REPLY", "AI 返回了空消息");
      if (Array.from(result.content).length > IM_MESSAGE_MAX_CHARACTERS) {
        throw new AppError(502, "IM_AI_REPLY_TOO_LONG", `AI 回复超过 ${IM_MESSAGE_MAX_CHARACTERS} 字符，未写入会话`);
      }
      const currentMembership = this.characterMembership(membershipId);
      this.assertCharacterAuthorization(chain, currentMembership);
      const snapshot = this.streamingReplies.get(turnId);
      if (snapshot) snapshot.payload.content = result.content;
      this.publish(requiredString(chain.conversation_id), "delta", {
        chainId: requiredString(chain.id),
        turnId,
        characterId: currentMembership.character_id,
        delta: result.content
      });
      const message = this.appendCharacterMessage(chain, currentMembership, result, turnId);
      this.publish(requiredString(chain.conversation_id), "message", { message });
      this.publishReplyTurn(chain, membership, turnId, "completed");
      this.streamingReplies.delete(turnId);
      return this.messageRow(requiredString(message.id));
    } catch (error) {
      const effectiveError = effectiveAbortError(signal, error);
      if (streamed) this.publish(requiredString(chain.conversation_id), "reset", { chainId: requiredString(chain.id), turnId, reason: "retry" });
      const failure = publicError(effectiveError);
      const cancelled = signal.aborted || failure.code === "IM_CHAIN_CANCELLED" || failure.code === "AI_STREAM_REQUEST_CANCELLED";
      const failureForTurn = result ? new AppError(
        effectiveError instanceof AppError ? effectiveError.status : 502,
        failure.code,
        failure.message,
        {
          ...(effectiveError instanceof AppError && effectiveError.details && typeof effectiveError.details === "object" ? effectiveError.details : {}),
          modelRecordId: result.model.id,
          modelStage: result.stage,
          attemptCount: result.primaryAttemptCount + result.attemptCount,
          callId: result.callId,
          callIds: result.callIds
        }
      ) : effectiveError;
      this.failTurn(turnId, failureForTurn, cancelled ? "cancelled" : "failed");
      this.publishReplyTurn(chain, membership, turnId, cancelled ? "cancelled" : "failed", failure);
      this.streamingReplies.delete(turnId);
      throw effectiveError;
    }
  }

  private finishChain(chainId: string, status: "quiet" | "completed" | "cancelled" | "failed" | "interrupted" | "limit", error?: { code: string; message: string }): void {
    const timestamp = now();
    const chain = this.chainRow(chainId);
    this.db.run(
      `UPDATE im_chains SET status = ?, error_code = ?, error_message = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
      status,
      error?.code ?? null,
      error?.message ?? null,
      timestamp,
      timestamp,
      chainId
    );
    this.publish(requiredString(chain.conversation_id), "chain", {
      chainId,
      status,
      generatedCount: Number(chain.generated_count),
      ...(error ? { error } : {})
    });
  }

  private async runChain(chainId: string, signal: AbortSignal): Promise<void> {
    let chain = this.chainRow(chainId);
    const conversationId = requiredString(chain.conversation_id);
    try {
      if (requiredString(chain.status) !== "queued") return;
      this.im.refreshCharacterAvailability(conversationId);
      this.db.run("UPDATE im_chains SET status = 'running', updated_at = ? WHERE id = ?", now(), chainId);
      this.publish(conversationId, "chain", { chainId, status: "running", modelStage: chain.model_stage });
      let sourceMessage = this.messageRow(requiredString(chain.trigger_message_id));
      if (requiredString(chain.mode) === "direct") {
        const target = this.activeCharacters(conversationId)[0];
        if (!target) throw new AppError(409, "IM_CHARACTER_UNAVAILABLE", "单聊角色已不可用");
        const planned = this.planReplyTurn(chain, requiredString(target.id), requiredString(sourceMessage.id));
        await this.reply(chain, planned.membershipId, planned.turnId, sourceMessage, signal);
        this.finishChain(chainId, "completed");
        return;
      }
      let forcedQueue = this.mentionedCharacterMembershipIds(requiredString(sourceMessage.id), conversationId)
        .map((membershipId) => this.planReplyTurn(chain, membershipId, requiredString(sourceMessage.id)));
      let lastJudgedSourceMessageId: string | null = null;
      let lastReplyFailure: { code: string; message: string } | null = null;
      for (;;) {
        if (signal.aborted) throw signal.reason;
        chain = this.chainRow(chainId);
        if (requiredString(chain.status) !== "running") return;
        if (Number(chain.generated_count) >= Number(chain.max_ai_messages)) {
          this.settlePendingReplyTurns(chain, "skipped", { code: "IM_CHAIN_LIMIT", message: "已达到群聊链路上限，未继续生成回答" });
          this.finishChain(chainId, "limit");
          return;
        }
        let plannedReply = forcedQueue.shift() ?? null;
        if (!plannedReply && requiredString(chain.mode) === "mention") {
          const latest = this.chainRow(chainId);
          if (Number(latest.generated_count) === 0 && lastReplyFailure) this.finishChain(chainId, "failed", lastReplyFailure);
          else this.finishChain(chainId, "completed");
          return;
        }
        if (!plannedReply) {
          if (lastJudgedSourceMessageId === requiredString(sourceMessage.id)) {
            this.finishChain(chainId, "failed", lastReplyFailure ?? { code: "IM_REPLY_ALL_FAILED", message: "所有已选择角色的回答都生成失败" });
            return;
          }
          lastJudgedSourceMessageId = requiredString(sourceMessage.id);
          const senderCharacterId = optionalString(sourceMessage.sender_character_id);
          const candidates = this.activeCharacters(conversationId).filter((row) => requiredString(row.character_id) !== senderCharacterId);
          if (candidates.length === 0) {
            this.finishChain(chainId, "quiet");
            return;
          }
          const settledScores = await Promise.allSettled(candidates.map(async (candidate) => ({
            membershipId: requiredString(candidate.id),
            score: await this.judge(chain, candidate, sourceMessage, signal)
          })));
          if (signal.aborted) {
            throw signal.reason instanceof Error ? signal.reason : new AppError(499, "IM_CHAIN_CANCELLED", "IM 交流链已取消");
          }
          const rejectedScore = settledScores.find((result) => result.status === "rejected");
          if (rejectedScore?.status === "rejected") throw rejectedScore.reason;
          const scores = settledScores.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
          const available = scores.filter((item): item is { membershipId: string; score: number } => item.score !== null)
            .sort((left, right) => right.score - left.score || left.membershipId.localeCompare(right.membershipId));
          if (available.length === 0) throw new AppError(502, "IM_JUDGE_ALL_FAILED", "所有 AI 角色的发言判断都失败了");
          const selected = available.filter((item) => item.score >= Number(chain.threshold));
          if (selected.length === 0) {
            this.finishChain(chainId, "quiet");
            return;
          }
          for (const item of selected) {
            const selectedReply = this.planReplyTurn(chain, item.membershipId, requiredString(sourceMessage.id));
            forcedQueue.push(selectedReply);
            this.db.run(
              `UPDATE im_chain_turns SET selected = 1
               WHERE id = (
                 SELECT id FROM im_chain_turns
                 WHERE chain_id = ? AND character_membership_id = ? AND kind = 'judge' AND status = 'completed'
                 ORDER BY created_at DESC, id DESC LIMIT 1
              )`,
              chainId,
              selectedReply.membershipId
            );
          }
          plannedReply = forcedQueue.shift() ?? null;
          if (!plannedReply) throw new AppError(500, "IM_REPLY_QUEUE_EMPTY", "主动交流没有生成可执行的角色回复队列");
        }
        const replySourceMessage = this.messageRow(plannedReply.sourceMessageId);
        try {
          sourceMessage = await this.reply(chain, plannedReply.membershipId, plannedReply.turnId, replySourceMessage, signal);
        } catch (error) {
          const failure = publicError(error);
          if (signal.aborted || failure.code === "IM_CHAIN_CANCELLED" || failure.code === "AI_STREAM_REQUEST_CANCELLED") throw error;
          lastReplyFailure = failure;
          continue;
        }
        if (requiredString(chain.mode) === "proactive") {
          forcedQueue = forcedQueue.map((queuedReply) => ({
            ...queuedReply,
            sourceMessageId: requiredString(sourceMessage.id)
          }));
        }
        const newMentions = this.mentionedCharacterMembershipIds(
          requiredString(sourceMessage.id),
          conversationId,
          optionalString(sourceMessage.sender_character_id)
        );
        const prioritizedMentions: typeof forcedQueue = [];
        for (const membershipId of newMentions) {
          const existingIndex = forcedQueue.findIndex((item) => item.membershipId === membershipId);
          if (existingIndex >= 0) {
            const [existing] = forcedQueue.splice(existingIndex, 1);
            if (existing) prioritizedMentions.push({ ...existing, sourceMessageId: requiredString(sourceMessage.id) });
            continue;
          }
          prioritizedMentions.push(this.planReplyTurn(chain, membershipId, requiredString(sourceMessage.id)));
        }
        forcedQueue.unshift(...prioritizedMentions);
      }
    } catch (error) {
      const effectiveError = effectiveAbortError(signal, error);
      const failure = publicError(effectiveError);
      if (failure.code === "IM_CHAIN_RUNTIME_RESTARTED") {
        this.settlePendingReplyTurns(chain, "cancelled", failure);
        this.finishChain(chainId, "interrupted", failure);
        return;
      }
      if (signal.aborted || failure.code === "IM_CHAIN_CANCELLED" || failure.code === "AI_STREAM_REQUEST_CANCELLED") {
        this.settlePendingReplyTurns(chain, "cancelled", failure);
        this.finishChain(chainId, "cancelled", failure);
        return;
      }
      this.settlePendingReplyTurns(chain, "failed", failure);
      this.finishChain(chainId, "failed", failure);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const interruption = new AppError(503, "IM_CHAIN_RUNTIME_RESTARTED", "服务关闭导致 IM 交流链中断，可从原消息重试");
    for (const controller of this.controllers.values()) controller.abort(interruption);
    const timestamp = now();
    this.db.run(
      `UPDATE im_chains SET status = 'interrupted', error_code = ?, error_message = ?, updated_at = ?, completed_at = ?
       WHERE status IN ('queued', 'running')`,
      interruption.code,
      interruption.message,
      timestamp,
      timestamp
    );
    this.db.run(
      `UPDATE im_chain_turns SET status = 'cancelled', failure = COALESCE(failure, ?), completed_at = ?
       WHERE chain_id IN (SELECT id FROM im_chains WHERE status = 'interrupted')
         AND status IN ('pending', 'running')`,
      `${interruption.code}: ${interruption.message}`,
      timestamp
    );
    await Promise.allSettled([...this.activeRunPromises]);
    this.controllers.clear();
    this.streamingReplies.clear();
    this.recipientCache.clear();
    this.queuedChainIds.length = 0;
    this.queuedChainSet.clear();
    for (const userId of [...this.listeners.keys()]) this.disconnectUser(userId);
  }
}
