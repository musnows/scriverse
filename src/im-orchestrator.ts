import { AppError, notFound } from "./errors.js";
import type { AiManager, ImAiPromptInput } from "./ai.js";
import type { Store } from "./store.js";
import type { AuthUser, UserAuthService } from "./user-auth.js";
import { runWithRequestActor } from "./request-context.js";
import { id, json, now } from "./utils.js";
import { ImService, parseImMentions } from "./im.js";

export type ImRealtimeEvent = {
  id: string;
  type: "conversation" | "message" | "chain" | "turn" | "delta" | "reset";
  conversationId: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

type EventListener = (event: ImRealtimeEvent) => void;

type InvocationResult = {
  callId: string;
  attemptCount: number;
  primaryAttemptCount: number;
  content: string;
  model: Record<string, unknown>;
  stage: "primary" | "fallback";
  durationMs: number;
};

const IM_USER_CHAIN_CONCURRENCY = 3;

function requiredString(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function publicError(error: unknown): { code: string; message: string } {
  if (error instanceof AppError) return { code: error.code, message: error.message };
  return { code: "IM_AI_CHAIN_FAILED", message: error instanceof Error ? error.message : "IM AI 交流链失败" };
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
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly queuedChainIds: string[] = [];
  private readonly queuedChainSet = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly activeByUser = new Map<string, number>();
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

  subscribe(userId: string, listener: EventListener): () => void {
    let listeners = this.listeners.get(userId);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(userId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.listeners.delete(userId);
    };
  }

  private publish(conversationId: string, type: ImRealtimeEvent["type"], payload: Record<string, unknown>): void {
    const event: ImRealtimeEvent = { id: id("imEvent"), type, conversationId, payload, createdAt: now() };
    const userIds = this.db.all(
      `SELECT DISTINCT user_id FROM im_human_memberships
       WHERE conversation_id = ? AND left_at IS NULL`,
      conversationId
    ).map((row) => requiredString(row.user_id));
    for (const userId of userIds) {
      this.publishToUser(userId, event);
    }
  }

  private publishToUser(userId: string, event: ImRealtimeEvent): void {
    for (const listener of this.listeners.get(userId) ?? []) listener(event);
  }

  publishConversation(conversationId: string): void {
    this.publish(conversationId, "conversation", {});
  }

  publishMessageResult(result: Record<string, unknown>): void {
    const message = result.message && typeof result.message === "object" && !Array.isArray(result.message)
      ? result.message as Record<string, unknown>
      : null;
    if (!message) return;
    const conversationId = requiredString(message.conversationId);
    this.publish(conversationId, "message", { message, chain: result.chain ?? null, duplicate: result.duplicate === true });
    const chain = result.chain && typeof result.chain === "object" && !Array.isArray(result.chain)
      ? result.chain as Record<string, unknown>
      : null;
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
      void this.runChain(chainId, controller.signal).finally(() => {
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
    return this.db.all(
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

  private characterHistory(membership: Record<string, unknown>, conversation: Record<string, unknown>, throughSequence: number): { history: string; summary: string } {
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
       ORDER BY message.sequence DESC LIMIT 80`,
      membershipId,
      contextEpoch,
      summarizedThroughSequence,
      throughSequence
    ).reverse();
    const history = rows.map((row) => {
      const sender = json<Record<string, unknown>>(requiredString(row.sender_snapshot_json), {});
      const label = sender.name ?? sender.displayName ?? (requiredString(row.sender_kind) === "system" ? "系统" : "成员");
      return `[${Number(row.sequence)}] ${String(label)}：${requiredString(row.content)}`;
    }).join("\n\n").slice(-60_000);
    return { history, summary: requiredString(context?.summary) };
  }

  private async maybeCompact(
    chain: Record<string, unknown>,
    membership: Record<string, unknown>,
    sourceMessage: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<void> {
    const conversation = this.conversationRow(requiredString(chain.conversation_id));
    const contextEpoch = Number(conversation.context_epoch);
    const context = this.db.get(
      `SELECT summarized_through_sequence FROM im_character_contexts
       WHERE character_membership_id = ? AND context_epoch = ?`,
      requiredString(membership.id),
      contextEpoch
    );
    const summarizedThroughSequence = Number(context?.summarized_through_sequence ?? 0);
    const rows = this.db.all(
      `SELECT message.sequence FROM im_message_deliveries delivery
       JOIN im_messages message ON message.id = delivery.message_id
       WHERE delivery.character_membership_id = ? AND message.context_epoch = ?
         AND message.sequence > ? AND message.sequence <= ?
       ORDER BY message.sequence`,
      requiredString(membership.id),
      contextEpoch,
      summarizedThroughSequence,
      Number(sourceMessage.sequence)
    );
    if (rows.length <= 60) return;
    const compactThrough = Number(rows[Math.max(0, rows.length - 20)]?.sequence ?? 0);
    if (compactThrough <= summarizedThroughSequence) return;
    const turnId = this.createTurn(requiredString(chain.id), requiredString(membership.id), "compact");
    try {
      const result = await this.invoke(
        chain,
        membership,
        "compact",
        `把已送达历史压缩为当前角色可继续使用的第一人称 IM 记忆；压缩到消息序号 ${compactThrough}，只保留事实、关系变化、承诺、未决事项和重要称呼。`,
        sourceMessage,
        signal
      );
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
      this.failTurn(turnId, error);
      if (signal.aborted) throw error;
    }
  }

  private assertCharacterAuthorization(chain: Record<string, unknown>, membership: Record<string, unknown>): { owner: AuthUser; workId: string; characterId: string } {
    const owner = this.auth.getUser(requiredString(chain.authorization_user_id));
    if (owner.status !== "active") throw new AppError(403, "IM_OWNER_DISABLED", "群主账户已停用，角色能力暂停");
    const characterId = optionalString(membership.character_id);
    const workId = optionalString(membership.source_work_id);
    if (!characterId || !workId) throw new AppError(409, "IM_CHARACTER_UNAVAILABLE", "来源角色或作品已不可用");
    this.im.assertCharacterAvailable(owner, characterId);
    return { owner, workId, characterId };
  }

  private shouldFailover(error: unknown): boolean {
    if (!(error instanceof AppError)) return true;
    return ![
      "IM_CHAIN_CANCELLED",
      "AI_STREAM_REQUEST_CANCELLED",
      "DAILY_TOKEN_QUOTA_EXCEEDED",
      "MONTHLY_TOKEN_QUOTA_EXCEEDED",
      "WORK_ACCESS_DENIED",
      "WORK_MODULE_READ_DENIED",
      "WORK_MODULE_WRITE_DENIED"
    ].includes(error.code);
  }

  private async invoke(
    chain: Record<string, unknown>,
    membership: Record<string, unknown>,
    kind: ImAiPromptInput["kind"],
    instruction: string,
    sourceMessage: Record<string, unknown>,
    signal: AbortSignal,
    onDelta?: (delta: string) => void
  ): Promise<InvocationResult> {
    const conversation = this.conversationRow(requiredString(chain.conversation_id));
    const authorization = this.assertCharacterAuthorization(chain, membership);
    const snapshot = json<Record<string, unknown>>(requiredString(sourceMessage.sender_snapshot_json), {});
    const context = this.characterHistory(membership, conversation, Number(sourceMessage.sequence));
    const common = {
      workId: authorization.workId,
      characterId: authorization.characterId,
      kind,
      instruction,
      participantContext: this.participantContext(requiredString(conversation.id), snapshot),
      history: context.history,
      summary: context.summary,
      retryCount: Number(chain.retry_count),
      createdByUserId: requiredString(chain.initiator_user_id),
      signal
    } satisfies Omit<ImAiPromptInput, "modelId">;
    const invokeModel = async (modelId: string, stage: "primary" | "fallback"): Promise<InvocationResult> => {
      const started = process.hrtime.bigint();
      const result = await runWithRequestActor({
        userId: authorization.owner.userId,
        username: authorization.owner.username,
        displayName: authorization.owner.displayName,
        role: authorization.owner.role,
        authentication: "session"
      }, () => this.ai.generateIm({ ...common, modelId }, onDelta));
      return {
        callId: result.callId,
        attemptCount: result.attemptCount,
        primaryAttemptCount: 0,
        content: result.content,
        model: result.model,
        stage,
        durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1_000_000)
      };
    };
    const currentStage = requiredString(this.chainRow(requiredString(chain.id)).model_stage) === "fallback" ? "fallback" : "primary";
    if (currentStage === "fallback") {
      const fallbackModelId = optionalString(chain.fallback_model_id);
      if (!fallbackModelId) throw new AppError(409, "IM_MODEL_NOT_CONFIGURED", "fallback 模型未配置");
      return invokeModel(fallbackModelId, "fallback");
    }
    const primaryModelId = optionalString(chain.primary_model_id);
    if (!primaryModelId) throw new AppError(409, "IM_MODEL_NOT_CONFIGURED", "主模型未配置");
    try {
      return await invokeModel(primaryModelId, "primary");
    } catch (error) {
      if (!this.shouldFailover(error) || signal.aborted) throw error;
      const fallbackModelId = optionalString(chain.fallback_model_id);
      if (!fallbackModelId) throw error;
      const timestamp = now();
      this.db.run("UPDATE im_chains SET model_stage = 'fallback', updated_at = ? WHERE id = ?", timestamp, requiredString(chain.id));
      this.publish(requiredString(chain.conversation_id), "reset", {
        chainId: requiredString(chain.id),
        reason: "fallback",
        modelStage: "fallback"
      });
      const fallback = await invokeModel(fallbackModelId, "fallback");
      const details = error instanceof AppError && error.details && typeof error.details === "object"
        ? error.details as Record<string, unknown>
        : {};
      return { ...fallback, primaryAttemptCount: Number(details.attemptCount) || Number(chain.retry_count) + 1 };
    }
  }

  private createTurn(chainId: string, membershipId: string, kind: "judge" | "reply" | "compact"): string {
    const turnId = id("imTurn");
    this.db.run(
      `INSERT INTO im_chain_turns (id, chain_id, character_membership_id, kind, status, created_at)
       VALUES (?, ?, ?, ?, 'running', ?)`,
      turnId,
      chainId,
      membershipId,
      kind,
      now()
    );
    return turnId;
  }

  private finishTurn(turnId: string, result: InvocationResult, score?: number, selected = false): void {
    this.db.run(
      `UPDATE im_chain_turns SET status = 'completed', score = ?, selected = ?, model_id = ?, model_stage = ?,
       attempt_count = ?, duration_ms = ?, ai_call_ids_json = ?, completed_at = ? WHERE id = ?`,
      score ?? null,
      selected ? 1 : 0,
      requiredString(result.model.id),
      result.stage,
      result.primaryAttemptCount + result.attemptCount,
      result.durationMs,
      JSON.stringify([result.callId]),
      now(),
      turnId
    );
  }

  private failTurn(turnId: string, error: unknown): void {
    const failure = publicError(error);
    this.db.run(
      "UPDATE im_chain_turns SET status = 'failed', failure = ?, completed_at = ? WHERE id = ?",
      `${failure.code}: ${failure.message}`.slice(0, 2000),
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
        signal
      );
      const score = scoreFromContent(result.content);
      if (score === null) throw new AppError(502, "IM_JUDGE_INVALID_SCORE", "AI 没有返回有效的发言意愿分数");
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
      this.failTurn(turnId, error);
      if (signal.aborted) throw error;
      return null;
    }
  }

  private validatedOutputMentions(conversationId: string, content: string): Array<{
    kind: "character" | "user";
    id: string;
    snapshot: Record<string, unknown>;
    membershipId?: string;
  }> {
    const result: Array<{ kind: "character" | "user"; id: string; snapshot: Record<string, unknown>; membershipId?: string }> = [];
    for (const mention of parseImMentions(content)) {
      if (mention.kind === "character") {
        const row = this.db.get(
          `SELECT * FROM im_character_memberships
           WHERE conversation_id = ? AND character_id = ? AND left_at IS NULL AND status = 'active'`,
          conversationId,
          mention.id
        );
        if (!row) continue;
        result.push({ kind: mention.kind, id: mention.id, membershipId: requiredString(row.id), snapshot: json(requiredString(row.snapshot_json), {}) });
        continue;
      }
      const row = this.db.get(
        `SELECT user.id, user.username, user.display_name, user.avatar_sha256
         FROM im_human_memberships membership JOIN users user ON user.id = membership.user_id
         WHERE membership.conversation_id = ? AND membership.user_id = ? AND membership.left_at IS NULL`,
        conversationId,
        mention.id
      );
      if (!row) continue;
      result.push({ kind: mention.kind, id: mention.id, snapshot: {
        userId: requiredString(row.id), username: requiredString(row.username), displayName: requiredString(row.display_name), avatarUrl: null
      } });
    }
    return result;
  }

  private appendCharacterMessage(
    chain: Record<string, unknown>,
    membership: Record<string, unknown>,
    invocation: InvocationResult
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
    const metadata = {
      modelId: requiredString(invocation.model.id),
      modelDisplayName: requiredString(invocation.model.displayName),
      modelStage: invocation.stage,
      durationMs: invocation.durationMs,
      callId: invocation.callId,
      retryCount: Number(chain.retry_count),
      attemptCount: invocation.primaryAttemptCount + invocation.attemptCount,
      primaryAttemptCount: invocation.primaryAttemptCount,
      fallbackAttemptCount: invocation.stage === "fallback" ? invocation.attemptCount : 0
    };
    const timestamp = now();
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO im_messages (
           id, conversation_id, sequence, context_epoch, sender_kind, sender_character_id,
           sender_snapshot_json, content, chain_id, metadata_json, created_at
         ) VALUES (?, ?, ?, ?, 'character', ?, ?, ?, ?, ?, ?)`,
        messageId,
        conversationId,
        sequence,
        Number(conversation.context_epoch),
        optionalString(membership.character_id),
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
    sourceMessage: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<Record<string, unknown>> {
    const membership = this.characterMembership(membershipId);
    await this.maybeCompact(chain, membership, sourceMessage, signal);
    const turnId = this.createTurn(requiredString(chain.id), membershipId, "reply");
    let streamed = "";
    try {
      const result = await this.invoke(
        chain,
        membership,
        "reply",
        "回复最新收到的 IM 消息；只有确实需要点名时才使用 canonical mention URI。",
        sourceMessage,
        signal,
        (delta) => {
          streamed += delta;
          this.publish(requiredString(chain.conversation_id), "delta", {
            chainId: requiredString(chain.id),
            turnId,
            characterId: membership.character_id,
            delta
          });
        }
      );
      if (!result.content.trim()) throw new AppError(502, "IM_AI_EMPTY_REPLY", "AI 返回了空消息");
      this.finishTurn(turnId, result, undefined, true);
      const message = this.appendCharacterMessage(chain, membership, result);
      this.publish(requiredString(chain.conversation_id), "message", { message });
      return this.messageRow(requiredString(message.id));
    } catch (error) {
      if (streamed) this.publish(requiredString(chain.conversation_id), "reset", { chainId: requiredString(chain.id), turnId, reason: "retry" });
      this.failTurn(turnId, error);
      throw error;
    }
  }

  private finishChain(chainId: string, status: "quiet" | "completed" | "cancelled" | "failed" | "limit", error?: { code: string; message: string }): void {
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
      this.db.run("UPDATE im_chains SET status = 'running', updated_at = ? WHERE id = ?", now(), chainId);
      this.publish(conversationId, "chain", { chainId, status: "running", modelStage: chain.model_stage });
      let sourceMessage = this.messageRow(requiredString(chain.trigger_message_id));
      let forcedQueue = this.mentionedCharacterMembershipIds(requiredString(sourceMessage.id), conversationId);
      if (requiredString(chain.mode) === "direct") {
        const target = this.activeCharacters(conversationId)[0];
        if (!target) throw new AppError(409, "IM_CHARACTER_UNAVAILABLE", "单聊角色已不可用");
        await this.reply(chain, requiredString(target.id), sourceMessage, signal);
        this.finishChain(chainId, "completed");
        return;
      }
      for (;;) {
        if (signal.aborted) throw signal.reason;
        chain = this.chainRow(chainId);
        if (requiredString(chain.status) !== "running") return;
        if (Number(chain.generated_count) >= Number(chain.max_ai_messages)) {
          this.finishChain(chainId, "limit");
          return;
        }
        let targetMembershipId = forcedQueue.shift() ?? null;
        if (!targetMembershipId && requiredString(chain.mode) === "mention") {
          this.finishChain(chainId, "completed");
          return;
        }
        if (!targetMembershipId) {
          const senderCharacterId = optionalString(sourceMessage.sender_character_id);
          const candidates = this.activeCharacters(conversationId).filter((row) => requiredString(row.character_id) !== senderCharacterId);
          const scores = await Promise.all(candidates.map(async (candidate) => ({
            membershipId: requiredString(candidate.id),
            score: await this.judge(chain, candidate, sourceMessage, signal)
          })));
          const available = scores.filter((item): item is { membershipId: string; score: number } => item.score !== null)
            .sort((left, right) => right.score - left.score || left.membershipId.localeCompare(right.membershipId));
          if (available.length === 0) throw new AppError(502, "IM_JUDGE_ALL_FAILED", "所有 AI 角色的发言判断都失败了");
          const selected = available[0];
          if (!selected || selected.score < Number(chain.threshold)) {
            this.finishChain(chainId, "quiet");
            return;
          }
          targetMembershipId = selected.membershipId;
          this.db.run(
            `UPDATE im_chain_turns SET selected = 1
             WHERE id = (
               SELECT id FROM im_chain_turns
               WHERE chain_id = ? AND character_membership_id = ? AND kind = 'judge' AND status = 'completed'
               ORDER BY created_at DESC, id DESC LIMIT 1
             )`,
            chainId,
            targetMembershipId
          );
        }
        sourceMessage = await this.reply(chain, targetMembershipId, sourceMessage, signal);
        const newMentions = this.mentionedCharacterMembershipIds(
          requiredString(sourceMessage.id),
          conversationId,
          optionalString(sourceMessage.sender_character_id)
        );
        for (const membershipId of newMentions) if (!forcedQueue.includes(membershipId)) forcedQueue.push(membershipId);
      }
    } catch (error) {
      const failure = publicError(error);
      if (signal.aborted || failure.code === "IM_CHAIN_CANCELLED" || failure.code === "AI_STREAM_REQUEST_CANCELLED") {
        this.finishChain(chainId, "cancelled", failure);
        return;
      }
      this.finishChain(chainId, "failed", failure);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const controller of this.controllers.values()) controller.abort(new AppError(499, "IM_CHAIN_CANCELLED", "服务正在关闭"));
    this.controllers.clear();
    this.queuedChainIds.length = 0;
    this.queuedChainSet.clear();
    this.listeners.clear();
  }
}
