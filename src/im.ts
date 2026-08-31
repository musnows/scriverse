import type { SQLInputValue } from "node:sqlite";
import { PLATFORM_AI_WORK_ID } from "./database.js";
import { AppError, notFound } from "./errors.js";
import type { Store } from "./store.js";
import type { AuthUser, UserAuthService } from "./user-auth.js";
import { canReadWorkModule, canWriteWorkModule } from "./work-permissions.js";
import { id, json, now } from "./utils.js";

export const IM_MAX_AI_PARTICIPANTS = 10;
export const IM_MAX_HUMAN_PARTICIPANTS = 50;
export const IM_DEFAULT_RESPONSE_THRESHOLD = 60;
export const IM_DEFAULT_MAX_AI_MESSAGES = 20;
export const IM_DEFAULT_RETRY_COUNT = 3;

export type ImReplyMode = "mention" | "proactive";
export type ImMention = {
  kind: "character" | "user";
  id: string;
  start: number;
  end: number;
};

export type ImUserSettingsInput = {
  preferredName?: string;
  pronouns?: string;
  identitySummary?: string;
  additionalNotes?: string;
  primaryModelId?: string | null;
  fallbackModelId?: string | null;
  retryCount?: number;
};

export type ImGroupInput = {
  title: string;
  characterIds: string[];
  humanUserIds?: string[];
  replyMode?: ImReplyMode;
  responseThreshold?: number;
  maxAiMessages?: number;
};

export type ImMessageInput = {
  content: string;
  requestId: string;
};

const IM_MENTION_PATTERN = /mention:\/\/(character|user)\/([A-Za-z0-9_.:-]{1,200})/gu;

function requiredString(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function booleanValue(value: unknown): boolean {
  return Number(value) === 1;
}

function publicCharacterSummary(character: Record<string, unknown>): string {
  const profile = character.profile && typeof character.profile === "object" && !Array.isArray(character.profile)
    ? character.profile as Record<string, unknown>
    : {};
  const attributes = character.attributes && typeof character.attributes === "object" && !Array.isArray(character.attributes)
    ? character.attributes as Record<string, unknown>
    : {};
  return [profile.summary, attributes.identity]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .slice(0, 2000);
}

export function parseImMentions(content: string): ImMention[] {
  const mentions: ImMention[] = [];
  for (const match of content.matchAll(IM_MENTION_PATTERN)) {
    const kind = match[1];
    const targetId = match[2];
    if ((kind !== "character" && kind !== "user") || !targetId || match.index === undefined) continue;
    mentions.push({ kind, id: targetId, start: match.index, end: match.index + match[0].length });
  }
  return mentions;
}

export class ImService {
  constructor(
    private readonly store: Store,
    private readonly auth: UserAuthService
  ) {}

  private get db() {
    return this.store.db;
  }

  private assertActiveUser(userId: string): AuthUser {
    const user = this.auth.getUser(userId);
    if (user.status !== "active") throw new AppError(409, "IM_USER_DISABLED", "不能添加已停用用户");
    return user;
  }

  private assertWorkMembership(userId: string, workId: string): void {
    const membership = this.db.get(
      `SELECT 1 AS present FROM works work
       LEFT JOIN work_memberships membership ON membership.work_id = work.id AND membership.user_id = ?
       WHERE work.id = ? AND work.deleted_at IS NULL
         AND (work.owner_user_id = ? OR membership.user_id = ?)`,
      userId,
      workId,
      userId,
      userId
    );
    if (!membership) throw new AppError(403, "IM_CHARACTER_ACCESS_DENIED", "你不能在 IM 中使用这个角色");
  }

  assertCharacterAvailable(user: AuthUser, characterId: string): Record<string, unknown> {
    const character = this.store.getCharacter(characterId);
    const workId = requiredString(character.workId);
    this.assertWorkMembership(user.userId, workId);
    const permissions = this.auth.workModulePermissions(user, workId, true);
    if (!permissions || !canReadWorkModule(permissions, "characters") || !canWriteWorkModule(permissions, "ai-chat")) {
      throw new AppError(403, "IM_CHARACTER_ACCESS_DENIED", "需要角色读取和 AI 对话写入权限才能在 IM 中使用这个角色");
    }
    return character;
  }

  private assertModel(modelId: string): void {
    const model = this.db.get(
      `SELECT model.id FROM models model JOIN providers provider ON provider.id = model.provider_id
       WHERE model.id = ? AND model.model_kind = 'chat' AND provider.work_id = ?`,
      modelId,
      PLATFORM_AI_WORK_ID
    );
    if (!model) throw new AppError(400, "IM_MODEL_INVALID", "IM 只能使用平台 Chat 模型");
  }

  getSettings(userId: string): Record<string, unknown> {
    const user = this.auth.getUser(userId);
    const row = this.db.get("SELECT * FROM im_user_settings WHERE user_id = ?", userId);
    return {
      preferredName: optionalString(row?.preferred_name) ?? user.displayName,
      pronouns: requiredString(row?.pronouns),
      identitySummary: requiredString(row?.identity_summary),
      additionalNotes: requiredString(row?.additional_notes),
      primaryModelId: optionalString(row?.primary_model_id),
      fallbackModelId: optionalString(row?.fallback_model_id),
      retryCount: Number(row?.retry_count ?? IM_DEFAULT_RETRY_COUNT),
      configured: Boolean(row?.primary_model_id && row?.fallback_model_id),
      updatedAt: optionalString(row?.updated_at)
    };
  }

  updateSettings(userId: string, input: ImUserSettingsInput): Record<string, unknown> {
    const current = this.getSettings(userId);
    const primaryModelId = input.primaryModelId === undefined ? current.primaryModelId as string | null : input.primaryModelId;
    const fallbackModelId = input.fallbackModelId === undefined ? current.fallbackModelId as string | null : input.fallbackModelId;
    if (primaryModelId) this.assertModel(primaryModelId);
    if (fallbackModelId) this.assertModel(fallbackModelId);
    if (primaryModelId && fallbackModelId && primaryModelId === fallbackModelId) {
      throw new AppError(400, "IM_FALLBACK_MODEL_DUPLICATE", "主模型和 fallback 模型不能相同");
    }
    const timestamp = now();
    this.db.run(
      `INSERT INTO im_user_settings (
         user_id, preferred_name, pronouns, identity_summary, additional_notes,
         primary_model_id, fallback_model_id, retry_count, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         preferred_name = excluded.preferred_name,
         pronouns = excluded.pronouns,
         identity_summary = excluded.identity_summary,
         additional_notes = excluded.additional_notes,
         primary_model_id = excluded.primary_model_id,
         fallback_model_id = excluded.fallback_model_id,
         retry_count = excluded.retry_count,
         updated_at = excluded.updated_at`,
      userId,
      input.preferredName ?? requiredString(current.preferredName),
      input.pronouns ?? requiredString(current.pronouns),
      input.identitySummary ?? requiredString(current.identitySummary),
      input.additionalNotes ?? requiredString(current.additionalNotes),
      primaryModelId,
      fallbackModelId,
      input.retryCount ?? Number(current.retryCount),
      timestamp
    );
    this.store.audit(null, "im.settings.updated", "user", userId, {
      primaryModelId,
      fallbackModelId,
      retryCount: input.retryCount ?? current.retryCount
    });
    return this.getSettings(userId);
  }

  listModels(): Record<string, unknown>[] {
    return this.db.all(
      `SELECT model.id, model.display_name, model.model_id, model.context_window, model.multimodal_enabled,
              provider.id AS provider_id, provider.name AS provider_name
       FROM models model JOIN providers provider ON provider.id = model.provider_id
       WHERE model.model_kind = 'chat' AND model.enabled = 1
         AND provider.status = 'enabled' AND provider.connection_status = 'success'
         AND provider.work_id = ?
       ORDER BY provider.created_at, model.created_at`,
      PLATFORM_AI_WORK_ID
    ).map((row) => ({
      id: requiredString(row.id),
      displayName: requiredString(row.display_name),
      modelId: requiredString(row.model_id),
      contextWindow: Number(row.context_window),
      multimodalEnabled: booleanValue(row.multimodal_enabled),
      providerId: requiredString(row.provider_id),
      providerName: requiredString(row.provider_name)
    }));
  }

  listAvailableWorks(user: AuthUser): Record<string, unknown>[] {
    return this.db.all(
      `SELECT DISTINCT work.* FROM works work
       LEFT JOIN work_memberships membership ON membership.work_id = work.id AND membership.user_id = ?
       WHERE work.deleted_at IS NULL AND COALESCE(work.is_internal, 0) = 0
         AND (work.owner_user_id = ? OR membership.user_id = ?)
       ORDER BY work.updated_at DESC, work.title`,
      user.userId,
      user.userId,
      user.userId
    ).flatMap((work) => {
      const workId = requiredString(work.id);
      const permissions = this.auth.workModulePermissions(user, workId, true);
      if (!permissions || !canReadWorkModule(permissions, "characters") || !canWriteWorkModule(permissions, "ai-chat")) return [];
      return [{
        id: workId,
        title: requiredString(work.title),
        characterCount: Number(this.db.get(
          "SELECT COUNT(*) AS count FROM characters WHERE work_id = ? AND merged_into_character_id IS NULL",
          workId
        )?.count ?? 0)
      }];
    }).filter((work) => Number(work.characterCount) > 0);
  }

  listAvailableCharacters(user: AuthUser, query = "", selectedWorkId?: string): Record<string, unknown>[] {
    const normalizedQuery = query.normalize("NFKC").trim();
    if (selectedWorkId) {
      this.assertWorkMembership(user.userId, selectedWorkId);
      const permissions = this.auth.workModulePermissions(user, selectedWorkId, true);
      if (!permissions || !canReadWorkModule(permissions, "characters") || !canWriteWorkModule(permissions, "ai-chat")) {
        throw new AppError(403, "IM_CHARACTER_ACCESS_DENIED", "需要角色读取和 AI 对话写入权限才能浏览这本书的角色");
      }
    }
    const rows = this.db.all(
      `SELECT character.id, character.work_id, work.title AS work_title,
              EXISTS (
                SELECT 1 FROM work_entity_pins pin
                WHERE pin.work_id = character.work_id AND pin.entity_type = 'character'
                  AND pin.entity_id = character.id AND pin.is_pinned = 1
              ) AS is_pinned,
              EXISTS (
                SELECT 1 FROM work_entity_favorites favorite
                WHERE favorite.work_id = character.work_id AND favorite.entity_type = 'character'
                  AND favorite.entity_id = character.id AND favorite.user_id = ? AND favorite.is_favorite = 1
              ) AS user_is_favorite
       FROM characters character JOIN works work ON work.id = character.work_id
       LEFT JOIN work_memberships membership ON membership.work_id = work.id AND membership.user_id = ?
       WHERE work.deleted_at IS NULL AND character.merged_into_character_id IS NULL
         AND (work.owner_user_id = ? OR membership.user_id = ?)
         AND (? IS NULL OR character.work_id = ?)
         AND (? = '' OR character.name LIKE '%' || ? || '%' COLLATE NOCASE OR EXISTS (
           SELECT 1 FROM character_names name
           WHERE name.character_id = character.id AND name.display_name LIKE '%' || ? || '%' COLLATE NOCASE
         ))
       ORDER BY work.updated_at DESC, is_pinned DESC, user_is_favorite DESC, character.name`,
      user.userId,
      user.userId,
      user.userId,
      user.userId,
      selectedWorkId ?? null,
      selectedWorkId ?? null,
      normalizedQuery,
      normalizedQuery,
      normalizedQuery
    );
    return rows.flatMap((row) => {
      const workId = requiredString(row.work_id);
      const permissions = this.auth.workModulePermissions(user, workId, true);
      if (!permissions || !canReadWorkModule(permissions, "characters") || !canWriteWorkModule(permissions, "ai-chat")) return [];
      const character = this.store.getCharacter(requiredString(row.id));
      return [{
        id: requiredString(character.id),
        workId,
        workTitle: requiredString(row.work_title),
        name: requiredString(character.name),
        code: requiredString(character.code),
        gender: requiredString(character.gender),
        isDead: Boolean(character.isDead),
        isPinned: Boolean(row.is_pinned),
        isFavorite: Boolean(row.user_is_favorite),
        avatarUrl: character.avatarUrl ?? null,
        publicSummary: publicCharacterSummary(character)
      }];
    });
  }

  private characterSnapshot(character: Record<string, unknown>): Record<string, unknown> {
    const work = this.store.getWork(requiredString(character.workId));
    return {
      id: requiredString(character.id),
      name: requiredString(character.name),
      code: requiredString(character.code),
      avatarUrl: character.avatarUrl ?? null,
      workId: requiredString(work.id),
      workTitle: requiredString(work.title),
      publicSummary: publicCharacterSummary(character)
    };
  }

  private humanSnapshot(user: AuthUser): Record<string, unknown> {
    return {
      userId: user.userId,
      username: user.username,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl
    };
  }

  private activeMembership(conversationId: string, userId: string): Record<string, unknown> | undefined {
    return this.db.get(
      `SELECT * FROM im_human_memberships
       WHERE conversation_id = ? AND user_id = ? AND left_at IS NULL`,
      conversationId,
      userId
    );
  }

  private assertReadableConversation(conversationId: string, userId: string): Record<string, unknown> {
    const conversation = this.db.get("SELECT * FROM im_conversations WHERE id = ?", conversationId);
    if (!conversation) throw notFound("IM 会话");
    const membership = this.db.get(
      "SELECT 1 AS present FROM im_human_memberships WHERE conversation_id = ? AND user_id = ? LIMIT 1",
      conversationId,
      userId
    );
    if (!membership) throw new AppError(403, "IM_CONVERSATION_ACCESS_DENIED", "你不是这个 IM 会话的成员");
    return conversation;
  }

  private assertActiveMembership(conversationId: string, userId: string): Record<string, unknown> {
    const conversation = this.assertReadableConversation(conversationId, userId);
    if (requiredString(conversation.status) !== "active") throw new AppError(409, "IM_CONVERSATION_DISBANDED", "这个群聊已经解散");
    if (!this.activeMembership(conversationId, userId)) throw new AppError(403, "IM_MEMBERSHIP_INACTIVE", "你已经退出这个 IM 会话");
    return conversation;
  }

  private assertOwner(conversationId: string, userId: string): Record<string, unknown> {
    const conversation = this.assertActiveMembership(conversationId, userId);
    if (requiredString(conversation.owner_user_id) !== userId) throw new AppError(403, "IM_OWNER_REQUIRED", "该操作仅限群主");
    return conversation;
  }

  private nextSequence(conversationId: string): number {
    return Number(this.db.get(
      "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM im_messages WHERE conversation_id = ?",
      conversationId
    )?.sequence ?? 1);
  }

  private insertHumanMembership(conversationId: string, user: AuthUser, role: "owner" | "member", joinedSequence: number): void {
    this.db.run(
      `INSERT INTO im_human_memberships (
         id, conversation_id, user_id, role, joined_sequence, last_read_sequence, joined_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id("imHuman"),
      conversationId,
      user.userId,
      role,
      joinedSequence,
      joinedSequence,
      now()
    );
  }

  private insertCharacterMembership(conversationId: string, character: Record<string, unknown>, joinedSequence: number): void {
    this.db.run(
      `INSERT INTO im_character_memberships (
         id, conversation_id, character_id, source_work_id, snapshot_json, joined_sequence, joined_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id("imCharacter"),
      conversationId,
      requiredString(character.id),
      requiredString(character.workId),
      JSON.stringify(this.characterSnapshot(character)),
      joinedSequence,
      now()
    );
  }

  createDirect(user: AuthUser, characterId: string): Record<string, unknown> {
    const character = this.assertCharacterAvailable(user, characterId);
    const existing = this.db.get(
      "SELECT id FROM im_conversations WHERE kind = 'direct' AND owner_user_id = ? AND direct_character_id = ?",
      user.userId,
      characterId
    );
    if (existing) return this.getConversation(requiredString(existing.id), user.userId);
    const conversationId = id("imConversation");
    const timestamp = now();
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO im_conversations (
           id, kind, owner_user_id, direct_character_id, title, reply_mode,
           response_threshold, max_ai_messages, created_at, updated_at
         ) VALUES (?, 'direct', ?, ?, ?, 'mention', ?, ?, ?, ?)`,
        conversationId,
        user.userId,
        characterId,
        requiredString(character.name).slice(0, 80),
        IM_DEFAULT_RESPONSE_THRESHOLD,
        IM_DEFAULT_MAX_AI_MESSAGES,
        timestamp,
        timestamp
      );
      this.insertHumanMembership(conversationId, user, "owner", 0);
      this.insertCharacterMembership(conversationId, character, 0);
      this.store.audit(requiredString(character.workId), "im.direct-created", "im-conversation", conversationId, { characterId });
    });
    return this.getConversation(conversationId, user.userId);
  }

  createGroup(owner: AuthUser, input: ImGroupInput): Record<string, unknown> {
    const characterIds = [...new Set(input.characterIds)];
    const humanIds = [...new Set((input.humanUserIds ?? []).filter((userId) => userId !== owner.userId))];
    if (characterIds.length < 1 || characterIds.length > IM_MAX_AI_PARTICIPANTS) {
      throw new AppError(400, "IM_CHARACTER_COUNT_INVALID", `群聊必须包含 1-${IM_MAX_AI_PARTICIPANTS} 个 AI 角色`);
    }
    if (humanIds.length + 1 > IM_MAX_HUMAN_PARTICIPANTS) {
      throw new AppError(400, "IM_HUMAN_COUNT_INVALID", `群聊最多包含 ${IM_MAX_HUMAN_PARTICIPANTS} 个人类成员`);
    }
    const characters = characterIds.map((characterId) => this.assertCharacterAvailable(owner, characterId));
    const humans = humanIds.map((userId) => this.assertActiveUser(userId));
    const conversationId = id("imConversation");
    const timestamp = now();
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO im_conversations (
           id, kind, owner_user_id, title, reply_mode, response_threshold,
           max_ai_messages, created_at, updated_at
         ) VALUES (?, 'group', ?, ?, ?, ?, ?, ?, ?)`,
        conversationId,
        owner.userId,
        input.title,
        input.replyMode ?? "mention",
        input.responseThreshold ?? IM_DEFAULT_RESPONSE_THRESHOLD,
        input.maxAiMessages ?? IM_DEFAULT_MAX_AI_MESSAGES,
        timestamp,
        timestamp
      );
      this.insertHumanMembership(conversationId, owner, "owner", 0);
      for (const human of humans) this.insertHumanMembership(conversationId, human, "member", 0);
      for (const character of characters) this.insertCharacterMembership(conversationId, character, 0);
      this.store.audit(null, "im.group-created", "im-conversation", conversationId, {
        characterIds,
        humanUserIds: humanIds,
        replyMode: input.replyMode ?? "mention"
      });
    });
    return this.getConversation(conversationId, owner.userId);
  }

  private mapHumanMembership(row: Record<string, unknown>): Record<string, unknown> {
    return {
      membershipId: requiredString(row.membership_id ?? row.id),
      userId: requiredString(row.user_id),
      username: requiredString(row.username),
      displayName: requiredString(row.display_name),
      avatarUrl: row.avatar_sha256
        ? `/api/user-avatars/${encodeURIComponent(requiredString(row.user_id))}?v=${encodeURIComponent(requiredString(row.avatar_sha256))}`
        : null,
      role: requiredString(row.role),
      joinedAt: requiredString(row.joined_at),
      leftAt: optionalString(row.left_at)
    };
  }

  private mapCharacterMembership(row: Record<string, unknown>): Record<string, unknown> {
    const snapshot = json<Record<string, unknown>>(requiredString(row.snapshot_json), {});
    return {
      membershipId: requiredString(row.id),
      characterId: optionalString(row.character_id) ?? snapshot.id ?? null,
      sourceWorkId: optionalString(row.source_work_id) ?? snapshot.workId ?? null,
      name: snapshot.name ?? "已删除角色",
      code: snapshot.code ?? "",
      avatarUrl: row.character_id
        ? `/api/im/conversations/${encodeURIComponent(requiredString(row.conversation_id))}/characters/${encodeURIComponent(requiredString(row.character_id))}/avatar`
        : null,
      workTitle: snapshot.workTitle ?? "已删除作品",
      publicSummary: snapshot.publicSummary ?? "",
      status: requiredString(row.status),
      joinedAt: requiredString(row.joined_at),
      leftAt: optionalString(row.left_at)
    };
  }

  private conversationParticipants(conversationId: string): { humans: Record<string, unknown>[]; characters: Record<string, unknown>[] } {
    const humans = this.db.all(
      `SELECT membership.id AS membership_id, membership.user_id, membership.role, membership.joined_at, membership.left_at,
              user.username, user.display_name, user.avatar_sha256
       FROM im_human_memberships membership JOIN users user ON user.id = membership.user_id
       WHERE membership.conversation_id = ? ORDER BY membership.joined_at, membership.id`,
      conversationId
    ).map((row) => this.mapHumanMembership(row));
    const characters = this.db.all(
      `SELECT * FROM im_character_memberships WHERE conversation_id = ?
       ORDER BY joined_at, id`,
      conversationId
    ).map((row) => this.mapCharacterMembership(row));
    return { humans, characters };
  }

  private visibleMessages(conversationId: string, userId: string, limit = 50, beforeSequence?: number): Record<string, unknown>[] {
    const params: SQLInputValue[] = [conversationId, userId];
    const before = beforeSequence === undefined ? "" : " AND message.sequence < ?";
    if (beforeSequence !== undefined) params.push(beforeSequence);
    params.push(limit);
    const rows = this.db.all(
      `SELECT message.* FROM im_messages message
       WHERE message.conversation_id = ?
         AND EXISTS (
           SELECT 1 FROM im_human_memberships membership
           WHERE membership.conversation_id = message.conversation_id AND membership.user_id = ?
             AND message.sequence > membership.joined_sequence
             AND (membership.left_sequence IS NULL OR message.sequence <= membership.left_sequence)
         )${before}
       ORDER BY message.sequence DESC LIMIT ?`,
      ...params
    ).reverse();
    return rows.map((row) => this.mapMessage(row));
  }

  private mapMessage(row: Record<string, unknown>): Record<string, unknown> {
    const messageId = requiredString(row.id);
    const mentions = this.db.all(
      "SELECT * FROM im_mentions WHERE message_id = ? ORDER BY position",
      messageId
    ).map((mention) => ({
      kind: requiredString(mention.target_kind),
      id: requiredString(mention.target_id),
      position: Number(mention.position),
      snapshot: json(requiredString(mention.target_snapshot_json), {})
    }));
    return {
      id: messageId,
      conversationId: requiredString(row.conversation_id),
      sequence: Number(row.sequence),
      contextEpoch: Number(row.context_epoch),
      senderKind: requiredString(row.sender_kind),
      senderUserId: optionalString(row.sender_user_id),
      senderCharacterId: optionalString(row.sender_character_id),
      sender: json(requiredString(row.sender_snapshot_json), {}),
      content: requiredString(row.content),
      mentions,
      chainId: optionalString(row.chain_id),
      metadata: json(requiredString(row.metadata_json), {}),
      createdAt: requiredString(row.created_at)
    };
  }

  private mapConversation(row: Record<string, unknown>, userId: string): Record<string, unknown> {
    const conversationId = requiredString(row.id);
    const activeMembership = this.activeMembership(conversationId, userId);
    const latestSequence = Number(this.db.get(
      "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM im_messages WHERE conversation_id = ?",
      conversationId
    )?.sequence ?? 0);
    const lastReadSequence = Number(activeMembership?.last_read_sequence ?? latestSequence);
    const unread = activeMembership ? Number(this.db.get(
      `SELECT COUNT(*) AS count FROM im_messages message
       WHERE message.conversation_id = ? AND message.sequence > ?
         AND EXISTS (
           SELECT 1 FROM im_human_memberships membership
           WHERE membership.conversation_id = message.conversation_id AND membership.user_id = ?
             AND membership.left_at IS NULL AND message.sequence > membership.joined_sequence
         )`,
      conversationId,
      lastReadSequence,
      userId
    )?.count ?? 0) : 0;
    const mentionUnread = activeMembership ? Number(this.db.get(
      `SELECT COUNT(DISTINCT message.id) AS count FROM im_messages message
       JOIN im_mentions mention ON mention.message_id = message.id
       WHERE message.conversation_id = ? AND message.sequence > ?
         AND mention.target_kind = 'user' AND mention.target_id = ?`,
      conversationId,
      lastReadSequence,
      userId
    )?.count ?? 0) : 0;
    return {
      id: conversationId,
      kind: requiredString(row.kind),
      ownerUserId: requiredString(row.owner_user_id),
      title: requiredString(row.title),
      replyMode: requiredString(row.reply_mode),
      responseThreshold: Number(row.response_threshold),
      maxAiMessages: Number(row.max_ai_messages),
      contextEpoch: Number(row.context_epoch),
      status: requiredString(row.status),
      active: Boolean(activeMembership) && requiredString(row.status) === "active",
      unreadCount: unread,
      mentionUnreadCount: mentionUnread,
      latestSequence,
      createdAt: requiredString(row.created_at),
      updatedAt: requiredString(row.updated_at)
    };
  }

  listConversations(userId: string): Record<string, unknown>[] {
    return this.db.all(
      `SELECT DISTINCT conversation.* FROM im_conversations conversation
       JOIN im_human_memberships membership ON membership.conversation_id = conversation.id
       WHERE membership.user_id = ?
       ORDER BY conversation.updated_at DESC, conversation.created_at DESC`,
      userId
    ).map((row) => this.mapConversation(row, userId));
  }

  getConversation(conversationId: string, userId: string, beforeSequence?: number): Record<string, unknown> {
    const row = this.assertReadableConversation(conversationId, userId);
    return {
      ...this.mapConversation(row, userId),
      participants: this.conversationParticipants(conversationId),
      messages: this.visibleMessages(conversationId, userId, 50, beforeSequence),
      activeChain: this.db.get(
        `SELECT id, status, model_stage, generated_count, error_code, error_message, created_at, updated_at
         FROM im_chains WHERE conversation_id = ?
         ORDER BY created_at DESC LIMIT 1`,
        conversationId
      ) ?? null
    };
  }

  refreshCharacterAvailability(conversationId: string): void {
    const conversation = this.db.get("SELECT owner_user_id FROM im_conversations WHERE id = ?", conversationId);
    if (!conversation) throw notFound("IM 会话");
    let owner: AuthUser | null = null;
    try {
      owner = this.auth.getUser(requiredString(conversation.owner_user_id));
    } catch {
      owner = null;
    }
    for (const membership of this.db.all(
      `SELECT id, character_id FROM im_character_memberships
       WHERE conversation_id = ? AND left_at IS NULL AND character_id IS NOT NULL`,
      conversationId
    )) {
      let status: "active" | "suspended" = "suspended";
      if (owner?.status === "active") {
        try {
          this.assertCharacterAvailable(owner, requiredString(membership.character_id));
          status = "active";
        } catch {
          status = "suspended";
        }
      }
      this.db.run("UPDATE im_character_memberships SET status = ? WHERE id = ?", status, requiredString(membership.id));
    }
  }

  getCharacterAvatarAccess(userId: string, conversationId: string, characterId: string): Record<string, unknown> {
    this.assertReadableConversation(conversationId, userId);
    const membership = this.db.get(
      `SELECT 1 AS present FROM im_character_memberships
       WHERE conversation_id = ? AND character_id = ? LIMIT 1`,
      conversationId,
      characterId
    );
    if (!membership) throw notFound("IM 群角色");
    const avatar = this.store.getCharacterAvatar(characterId);
    if (!avatar) throw new AppError(404, "CHARACTER_AVATAR_NOT_FOUND", "角色头像不存在");
    return avatar;
  }

  updateGroup(owner: AuthUser, conversationId: string, input: Partial<Pick<ImGroupInput, "title" | "replyMode" | "responseThreshold" | "maxAiMessages">>): Record<string, unknown> {
    const conversation = this.assertOwner(conversationId, owner.userId);
    if (requiredString(conversation.kind) !== "group") throw new AppError(400, "IM_GROUP_REQUIRED", "单聊不能修改群设置");
    const timestamp = now();
    this.db.transaction(() => {
      this.cancelActiveChain(conversationId, "group_settings_changed");
      this.db.run(
        `UPDATE im_conversations SET title = ?, reply_mode = ?, response_threshold = ?,
         max_ai_messages = ?, updated_at = ? WHERE id = ?`,
        input.title ?? requiredString(conversation.title),
        input.replyMode ?? requiredString(conversation.reply_mode),
        input.responseThreshold ?? Number(conversation.response_threshold),
        input.maxAiMessages ?? Number(conversation.max_ai_messages),
        timestamp,
        conversationId
      );
      this.store.audit(null, "im.group-updated", "im-conversation", conversationId, input);
    });
    return this.getConversation(conversationId, owner.userId);
  }

  addHuman(owner: AuthUser, conversationId: string, userId: string): Record<string, unknown> {
    const conversation = this.assertOwner(conversationId, owner.userId);
    if (requiredString(conversation.kind) !== "group") throw new AppError(400, "IM_GROUP_REQUIRED", "单聊不能添加成员");
    if (this.activeMembership(conversationId, userId)) throw new AppError(409, "IM_MEMBER_EXISTS", "该用户已经在群聊中");
    const activeCount = Number(this.db.get(
      "SELECT COUNT(*) AS count FROM im_human_memberships WHERE conversation_id = ? AND left_at IS NULL",
      conversationId
    )?.count ?? 0);
    if (activeCount >= IM_MAX_HUMAN_PARTICIPANTS) throw new AppError(409, "IM_HUMAN_LIMIT_REACHED", "群聊人类成员已达到上限");
    const user = this.assertActiveUser(userId);
    this.db.transaction(() => {
      const joinedSequence = this.nextSequence(conversationId) - 1;
      this.cancelActiveChain(conversationId, "human_member_joined");
      this.insertHumanMembership(conversationId, user, "member", joinedSequence);
      this.db.run(
        "UPDATE im_conversations SET context_epoch = context_epoch + 1, updated_at = ? WHERE id = ?",
        now(),
        conversationId
      );
      this.insertSystemMessage(conversationId, `${user.displayName} 加入了群聊`, { type: "human-joined", user: this.humanSnapshot(user) });
      this.store.audit(null, "im.human-added", "im-conversation", conversationId, { userId });
    });
    return this.getConversation(conversationId, owner.userId);
  }

  private finishMembership(conversationId: string, userId: string, actorUserId: string, action: "left" | "removed"): void {
    const membership = this.activeMembership(conversationId, userId);
    if (!membership) throw notFound("IM 群成员");
    const sequence = this.nextSequence(conversationId) - 1;
    const timestamp = now();
    this.db.run(
      `UPDATE im_human_memberships SET left_sequence = ?, left_at = ?
       WHERE id = ?`,
      sequence,
      timestamp,
      requiredString(membership.id)
    );
    this.cancelActiveChain(conversationId, `human_member_${action}`);
    this.db.run("UPDATE im_conversations SET updated_at = ? WHERE id = ?", timestamp, conversationId);
    this.store.audit(null, action === "left" ? "im.human-left" : "im.human-removed", "im-conversation", conversationId, {
      userId,
      actorUserId
    });
  }

  leaveGroup(user: AuthUser, conversationId: string): void {
    const conversation = this.assertActiveMembership(conversationId, user.userId);
    if (requiredString(conversation.kind) !== "group") throw new AppError(400, "IM_GROUP_REQUIRED", "单聊不能退群");
    if (requiredString(conversation.owner_user_id) === user.userId) throw new AppError(409, "IM_OWNER_TRANSFER_REQUIRED", "群主需要先转让或解散群聊");
    this.db.transaction(() => this.finishMembership(conversationId, user.userId, user.userId, "left"));
  }

  removeHuman(owner: AuthUser, conversationId: string, userId: string): void {
    const conversation = this.assertOwner(conversationId, owner.userId);
    if (requiredString(conversation.kind) !== "group") throw new AppError(400, "IM_GROUP_REQUIRED", "单聊不能移除成员");
    if (userId === owner.userId) throw new AppError(409, "IM_OWNER_TRANSFER_REQUIRED", "群主不能移除自己");
    this.db.transaction(() => this.finishMembership(conversationId, userId, owner.userId, "removed"));
  }

  addCharacter(owner: AuthUser, conversationId: string, characterId: string): Record<string, unknown> {
    const conversation = this.assertOwner(conversationId, owner.userId);
    if (requiredString(conversation.kind) !== "group") throw new AppError(400, "IM_GROUP_REQUIRED", "单聊不能添加角色");
    const activeCount = Number(this.db.get(
      "SELECT COUNT(*) AS count FROM im_character_memberships WHERE conversation_id = ? AND left_at IS NULL",
      conversationId
    )?.count ?? 0);
    if (activeCount >= IM_MAX_AI_PARTICIPANTS) throw new AppError(409, "IM_CHARACTER_LIMIT_REACHED", "群聊 AI 角色已达到上限");
    if (this.db.get(
      "SELECT 1 AS present FROM im_character_memberships WHERE conversation_id = ? AND character_id = ? AND left_at IS NULL",
      conversationId,
      characterId
    )) throw new AppError(409, "IM_CHARACTER_EXISTS", "该角色已经在群聊中");
    const character = this.assertCharacterAvailable(owner, characterId);
    this.db.transaction(() => {
      this.cancelActiveChain(conversationId, "character_member_joined");
      this.insertCharacterMembership(conversationId, character, this.nextSequence(conversationId) - 1);
      this.insertSystemMessage(conversationId, `${requiredString(character.name)} 加入了群聊`, {
        type: "character-joined",
        character: this.characterSnapshot(character)
      });
      this.store.audit(requiredString(character.workId), "im.character-added", "im-conversation", conversationId, { characterId });
    });
    return this.getConversation(conversationId, owner.userId);
  }

  removeCharacter(owner: AuthUser, conversationId: string, characterId: string): void {
    const conversation = this.assertOwner(conversationId, owner.userId);
    if (requiredString(conversation.kind) !== "group") throw new AppError(400, "IM_GROUP_REQUIRED", "单聊不能移除角色");
    const rows = this.db.all(
      "SELECT * FROM im_character_memberships WHERE conversation_id = ? AND left_at IS NULL",
      conversationId
    );
    if (rows.length <= 1) throw new AppError(409, "IM_CHARACTER_REQUIRED", "群聊必须至少保留一个 AI 角色");
    const membership = rows.find((row) => requiredString(row.character_id) === characterId);
    if (!membership) throw notFound("IM 群角色");
    const timestamp = now();
    this.db.transaction(() => {
      this.cancelActiveChain(conversationId, "character_member_removed");
      this.db.run(
        `UPDATE im_character_memberships SET status = 'removed', left_sequence = ?, left_at = ? WHERE id = ?`,
        this.nextSequence(conversationId) - 1,
        timestamp,
        requiredString(membership.id)
      );
      this.db.run("UPDATE im_conversations SET updated_at = ? WHERE id = ?", timestamp, conversationId);
      this.store.audit(optionalString(membership.source_work_id), "im.character-removed", "im-conversation", conversationId, { characterId });
    });
  }

  transferGroup(owner: AuthUser, conversationId: string, nextOwnerUserId: string): Record<string, unknown> {
    const conversation = this.assertOwner(conversationId, owner.userId);
    if (requiredString(conversation.kind) !== "group") throw new AppError(400, "IM_GROUP_REQUIRED", "单聊不能转让");
    if (!this.activeMembership(conversationId, nextOwnerUserId)) throw new AppError(400, "IM_OWNER_NOT_MEMBER", "新群主必须是当前群成员");
    const nextOwner = this.assertActiveUser(nextOwnerUserId);
    const characterIds = this.db.all(
      "SELECT character_id FROM im_character_memberships WHERE conversation_id = ? AND left_at IS NULL AND character_id IS NOT NULL",
      conversationId
    ).map((row) => requiredString(row.character_id));
    for (const characterId of characterIds) this.assertCharacterAvailable(nextOwner, characterId);
    this.db.transaction(() => {
      this.cancelActiveChain(conversationId, "group_owner_transferred");
      this.db.run("UPDATE im_human_memberships SET role = 'member' WHERE conversation_id = ? AND user_id = ? AND left_at IS NULL", conversationId, owner.userId);
      this.db.run("UPDATE im_human_memberships SET role = 'owner' WHERE conversation_id = ? AND user_id = ? AND left_at IS NULL", conversationId, nextOwnerUserId);
      this.db.run("UPDATE im_conversations SET owner_user_id = ?, updated_at = ? WHERE id = ?", nextOwnerUserId, now(), conversationId);
      this.store.audit(null, "im.group-transferred", "im-conversation", conversationId, { previousOwnerUserId: owner.userId, nextOwnerUserId });
    });
    return this.getConversation(conversationId, owner.userId);
  }

  disbandGroup(owner: AuthUser, conversationId: string): void {
    const conversation = this.assertOwner(conversationId, owner.userId);
    if (requiredString(conversation.kind) !== "group") throw new AppError(400, "IM_GROUP_REQUIRED", "单聊不能解散");
    const timestamp = now();
    this.db.transaction(() => {
      this.cancelActiveChain(conversationId, "group_disbanded");
      this.db.run(
        "UPDATE im_conversations SET status = 'disbanded', disbanded_at = ?, updated_at = ? WHERE id = ?",
        timestamp,
        timestamp,
        conversationId
      );
      this.store.audit(null, "im.group-disbanded", "im-conversation", conversationId);
    });
  }

  private insertSystemMessage(conversationId: string, content: string, metadata: Record<string, unknown>): void {
    const timestamp = now();
    const contextEpoch = Number(this.db.get(
      "SELECT context_epoch FROM im_conversations WHERE id = ?",
      conversationId
    )?.context_epoch ?? 1);
    this.db.run(
      `INSERT INTO im_messages (
         id, conversation_id, sequence, context_epoch, sender_kind, content, metadata_json, created_at
       ) VALUES (?, ?, ?, ?, 'system', ?, ?, ?)`,
      id("imMessage"),
      conversationId,
      this.nextSequence(conversationId),
      contextEpoch,
      content,
      JSON.stringify(metadata),
      timestamp
    );
    this.db.run("UPDATE im_conversations SET updated_at = ? WHERE id = ?", timestamp, conversationId);
  }

  private validatedMentions(conversationId: string, content: string): Array<ImMention & { snapshot: Record<string, unknown>; membershipId?: string }> {
    const result: Array<ImMention & { snapshot: Record<string, unknown>; membershipId?: string }> = [];
    for (const mention of parseImMentions(content)) {
      if (mention.kind === "user") {
        const row = this.db.get(
          `SELECT user.id, user.username, user.display_name, user.avatar_sha256
           FROM im_human_memberships membership JOIN users user ON user.id = membership.user_id
           WHERE membership.conversation_id = ? AND membership.user_id = ? AND membership.left_at IS NULL`,
          conversationId,
          mention.id
        );
        if (!row) continue;
        result.push({ ...mention, snapshot: {
          userId: requiredString(row.id),
          username: requiredString(row.username),
          displayName: requiredString(row.display_name),
          avatarUrl: row.avatar_sha256
            ? `/api/user-avatars/${encodeURIComponent(requiredString(row.id))}?v=${encodeURIComponent(requiredString(row.avatar_sha256))}`
            : null
        } });
        continue;
      }
      const row = this.db.get(
        `SELECT * FROM im_character_memberships
         WHERE conversation_id = ? AND character_id = ? AND left_at IS NULL AND status = 'active'`,
        conversationId,
        mention.id
      );
      if (!row) continue;
      result.push({
        ...mention,
        membershipId: requiredString(row.id),
        snapshot: json(requiredString(row.snapshot_json), {})
      });
    }
    return result;
  }

  private cancelActiveChain(conversationId: string, reason: string): void {
    const timestamp = now();
    this.db.run(
      `UPDATE im_chains SET status = 'cancelled', error_code = 'IM_CHAIN_CANCELLED', error_message = ?,
       updated_at = ?, completed_at = ?
       WHERE conversation_id = ? AND status IN ('queued', 'running', 'waiting_config')`,
      reason,
      timestamp,
      timestamp,
      conversationId
    );
    this.db.run(
      `UPDATE im_chain_turns SET status = 'cancelled', failure = COALESCE(failure, ?), completed_at = ?
       WHERE chain_id IN (SELECT id FROM im_chains WHERE conversation_id = ? AND status = 'cancelled')
         AND status IN ('pending', 'running')`,
      reason,
      timestamp,
      conversationId
    );
  }

  sendMessage(user: AuthUser, conversationId: string, input: ImMessageInput): Record<string, unknown> {
    const conversation = this.assertActiveMembership(conversationId, user.userId);
    this.refreshCharacterAvailability(conversationId);
    const existing = this.db.get(
      "SELECT * FROM im_messages WHERE conversation_id = ? AND request_id = ?",
      conversationId,
      input.requestId
    );
    if (existing) {
      const existingChainId = optionalString(existing.chain_id);
      const chain = existingChainId ? this.db.get("SELECT * FROM im_chains WHERE id = ?", existingChainId) ?? null : null;
      return { message: this.mapMessage(existing), chain, duplicate: true };
    }
    const mentions = this.validatedMentions(conversationId, input.content);
    const settings = this.getSettings(user.userId);
    const messageId = id("imMessage");
    const chainId = id("imChain");
    const timestamp = now();
    return this.db.transaction(() => {
      this.cancelActiveChain(conversationId, "human_message_received");
      const sequence = this.nextSequence(conversationId);
      this.db.run(
        `INSERT INTO im_messages (
           id, conversation_id, sequence, context_epoch, sender_kind, sender_user_id, sender_snapshot_json,
           content, chain_id, request_id, created_at
         ) VALUES (?, ?, ?, ?, 'human', ?, ?, ?, ?, ?, ?)`,
        messageId,
        conversationId,
        sequence,
        Number(conversation.context_epoch),
        user.userId,
        JSON.stringify(this.humanSnapshot(user)),
        input.content,
        chainId,
        input.requestId,
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
      const activeCharacters = this.db.all(
        `SELECT * FROM im_character_memberships
         WHERE conversation_id = ? AND left_at IS NULL AND status = 'active'`,
        conversationId
      );
      const mode = requiredString(conversation.kind) === "direct"
        ? "direct"
        : requiredString(conversation.reply_mode) === "proactive" ? "proactive" : "mention";
      const deliveryIds = mode === "direct" || mode === "proactive"
        ? activeCharacters.map((row) => requiredString(row.id))
        : mentions.flatMap((mention) => mention.kind === "character" && mention.membershipId ? [mention.membershipId] : []);
      for (const membershipId of new Set(deliveryIds)) {
        this.db.run(
          "INSERT INTO im_message_deliveries (message_id, character_membership_id, delivered_at) VALUES (?, ?, ?)",
          messageId,
          membershipId,
          timestamp
        );
      }
      const shouldCreateChain = activeCharacters.length > 0
        && (mode === "direct" || mode === "proactive" || deliveryIds.length > 0);
      let chain: Record<string, unknown> | null = null;
      if (shouldCreateChain) {
        const configured = Boolean(settings.primaryModelId && settings.fallbackModelId);
        this.db.run(
          `INSERT INTO im_chains (
             id, conversation_id, initiator_user_id, authorization_user_id, trigger_message_id,
             mode, threshold, max_ai_messages, retry_count, primary_model_id, fallback_model_id,
             status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          chainId,
          conversationId,
          user.userId,
          requiredString(conversation.owner_user_id),
          messageId,
          mode,
          Number(conversation.response_threshold),
          Number(conversation.max_ai_messages),
          Number(settings.retryCount),
          optionalString(settings.primaryModelId),
          optionalString(settings.fallbackModelId),
          configured ? "queued" : "waiting_config",
          timestamp,
          timestamp
        );
        chain = this.db.get("SELECT * FROM im_chains WHERE id = ?", chainId) ?? null;
      }
      this.db.run("UPDATE im_conversations SET updated_at = ? WHERE id = ?", timestamp, conversationId);
      this.store.audit(null, "im.message-sent", "im-message", messageId, { conversationId, sequence, chainId: shouldCreateChain ? chainId : null });
      const message = this.db.get("SELECT * FROM im_messages WHERE id = ?", messageId);
      if (!message) throw notFound("IM 消息");
      return { message: this.mapMessage(message), chain, duplicate: false };
    });
  }

  markRead(userId: string, conversationId: string, sequence: number): Record<string, unknown> {
    const conversation = this.assertActiveMembership(conversationId, userId);
    const latest = this.nextSequence(conversationId) - 1;
    const safeSequence = Math.min(latest, Math.max(0, sequence));
    this.db.run(
      `UPDATE im_human_memberships SET last_read_sequence = MAX(last_read_sequence, ?)
       WHERE conversation_id = ? AND user_id = ? AND left_at IS NULL`,
      safeSequence,
      conversationId,
      userId
    );
    return this.mapConversation(conversation, userId);
  }

  stopChain(userId: string, conversationId: string): void {
    this.assertActiveMembership(conversationId, userId);
    this.db.transaction(() => this.cancelActiveChain(conversationId, "stopped_by_user"));
  }

  retryChain(user: AuthUser, conversationId: string, sourceChainId: string): Record<string, unknown> {
    const conversation = this.assertActiveMembership(conversationId, user.userId);
    const source = this.db.get("SELECT * FROM im_chains WHERE id = ? AND conversation_id = ?", sourceChainId, conversationId);
    if (!source) throw notFound("IM 交流链");
    const triggerMessageId = requiredString(source.trigger_message_id);
    const trigger = this.db.get(
      `SELECT message.id FROM im_messages message
       WHERE message.id = ? AND message.conversation_id = ?
         AND EXISTS (
           SELECT 1 FROM im_human_memberships membership
           WHERE membership.conversation_id = message.conversation_id AND membership.user_id = ?
             AND membership.left_at IS NULL AND message.sequence > membership.joined_sequence
         )`,
      triggerMessageId,
      conversationId,
      user.userId
    );
    if (!trigger) throw new AppError(403, "IM_MESSAGE_ACCESS_DENIED", "不能重试加入群聊前的消息");
    const settings = this.getSettings(user.userId);
    const chainId = id("imChain");
    const timestamp = now();
    const mode = requiredString(conversation.kind) === "direct"
      ? "direct"
      : requiredString(conversation.reply_mode) === "proactive" ? "proactive" : "mention";
    return this.db.transaction(() => {
      this.cancelActiveChain(conversationId, "manual_retry");
      const configured = Boolean(settings.primaryModelId && settings.fallbackModelId);
      this.db.run(
        `INSERT INTO im_chains (
           id, conversation_id, initiator_user_id, authorization_user_id, trigger_message_id,
           mode, threshold, max_ai_messages, retry_count, primary_model_id, fallback_model_id,
           status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        chainId,
        conversationId,
        user.userId,
        requiredString(conversation.owner_user_id),
        triggerMessageId,
        mode,
        Number(conversation.response_threshold),
        Number(conversation.max_ai_messages),
        Number(settings.retryCount),
        optionalString(settings.primaryModelId),
        optionalString(settings.fallbackModelId),
        configured ? "queued" : "waiting_config",
        timestamp,
        timestamp
      );
      this.db.run("UPDATE im_messages SET chain_id = ? WHERE id = ?", chainId, triggerMessageId);
      this.store.audit(null, "im.chain-retried", "im-chain", chainId, { sourceChainId, conversationId, triggerMessageId });
      return this.db.get("SELECT * FROM im_chains WHERE id = ?", chainId) ?? {};
    });
  }

  getDiagnostics(owner: AuthUser, conversationId: string): Record<string, unknown> {
    this.assertOwner(conversationId, owner.userId);
    const chain = this.db.get(
      "SELECT * FROM im_chains WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1",
      conversationId
    );
    if (!chain) return { chain: null, turns: [] };
    const turns = this.db.all(
      `SELECT turn.*, membership.character_id, membership.snapshot_json
       FROM im_chain_turns turn JOIN im_character_memberships membership ON membership.id = turn.character_membership_id
       WHERE turn.chain_id = ? ORDER BY turn.created_at, turn.id`,
      requiredString(chain.id)
    ).map((turn) => {
      const snapshot = json<Record<string, unknown>>(requiredString(turn.snapshot_json), {});
      return {
        id: requiredString(turn.id),
        characterId: optionalString(turn.character_id) ?? snapshot.id ?? null,
        characterName: snapshot.name ?? "已删除角色",
        kind: requiredString(turn.kind),
        score: turn.score === null || turn.score === undefined ? null : Number(turn.score),
        selected: booleanValue(turn.selected),
        status: requiredString(turn.status),
        modelId: optionalString(turn.model_id),
        modelStage: optionalString(turn.model_stage),
        attemptCount: Number(turn.attempt_count),
        durationMs: turn.duration_ms === null || turn.duration_ms === undefined ? null : Number(turn.duration_ms),
        failure: optionalString(turn.failure),
        createdAt: requiredString(turn.created_at),
        completedAt: optionalString(turn.completed_at)
      };
    });
    return {
      chain: {
        id: requiredString(chain.id),
        status: requiredString(chain.status),
        modelStage: requiredString(chain.model_stage),
        threshold: Number(chain.threshold),
        generatedCount: Number(chain.generated_count),
        maxAiMessages: Number(chain.max_ai_messages),
        createdAt: requiredString(chain.created_at),
        completedAt: optionalString(chain.completed_at)
      },
      turns
    };
  }
}
