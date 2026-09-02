import type { SQLInputValue } from "node:sqlite";
import { PLATFORM_AI_WORK_ID } from "./database.js";
import { AppError, notFound } from "./errors.js";
import type { Store } from "./store.js";
import type { AuthUser, UserAuthService } from "./user-auth.js";
import {
  canReadWorkModule,
  canWriteWorkModule,
  fullWorkModulePermissions,
  storedWorkModulePermissions,
  type WorkModulePermissions
} from "./work-permissions.js";
import { id, json, now } from "./utils.js";

export const IM_MAX_AI_PARTICIPANTS = 10;
export const IM_MAX_HUMAN_PARTICIPANTS = 50;
export const IM_DEFAULT_RESPONSE_THRESHOLD = 60;
export const IM_DEFAULT_MAX_AI_MESSAGES = 20;
export const IM_DEFAULT_RETRY_COUNT = 3;
export const IM_MAX_MENTIONS_PER_MESSAGE = 50;

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

type PreparedConversationSummary = {
  participants: { humans: Record<string, unknown>[]; characters: Record<string, unknown>[] };
  activeMembership?: Record<string, unknown>;
  viewerMembership: Record<string, unknown>;
  latestSequence: number;
  unreadCount: number;
  mentionUnreadCount: number;
};
type PreparedMessagePage = {
  mentionsByMessageId: Map<string, Record<string, unknown>[]>;
  avatarShaByCharacterId: Map<string, string>;
};

const IM_MENTION_PATTERN = /mention:\/\/(character|user)\/([A-Za-z0-9_.:-]{1,200})/gu;

function requiredString(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function avatarVersionFromUrl(value: unknown): string | null {
  const match = optionalString(value)?.match(/[?&]v=([^&]+)/u);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
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
       WHERE model.id = ? AND model.model_kind = 'chat' AND model.enabled = 1
         AND provider.status = 'enabled' AND provider.connection_status = 'success'
         AND provider.work_id = ?`,
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
    if (input.primaryModelId !== undefined && primaryModelId !== current.primaryModelId && primaryModelId) this.assertModel(primaryModelId);
    if (input.fallbackModelId !== undefined && fallbackModelId !== current.fallbackModelId && fallbackModelId) this.assertModel(fallbackModelId);
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

  private catalogWorkPermissions(user: Pick<AuthUser, "userId" | "role">, row: Record<string, unknown>): WorkModulePermissions | null {
    if (user.role === "admin" || requiredString(row.owner_user_id) === user.userId) return fullWorkModulePermissions();
    if (optionalString(row.membership_user_id) !== user.userId) return null;
    return storedWorkModulePermissions(requiredString(row.membership_role), row.membership_permissions_json);
  }

  listAvailableWorks(user: AuthUser): Record<string, unknown>[] {
    return this.db.all(
      `SELECT work.id, work.title, work.owner_user_id,
              membership.user_id AS membership_user_id, membership.role AS membership_role,
              membership.permissions_json AS membership_permissions_json, (
         SELECT COUNT(*) FROM characters character
         WHERE character.work_id = work.id AND character.merged_into_character_id IS NULL
       ) AS character_count FROM works work
       LEFT JOIN work_memberships membership ON membership.work_id = work.id AND membership.user_id = ?
       WHERE work.deleted_at IS NULL AND COALESCE(work.is_internal, 0) = 0
         AND (work.owner_user_id = ? OR membership.user_id = ?)
       ORDER BY work.updated_at DESC, work.title`,
      user.userId,
      user.userId,
      user.userId
    ).flatMap((work) => {
      const workId = requiredString(work.id);
      const permissions = this.catalogWorkPermissions(user, work);
      if (!permissions || !canReadWorkModule(permissions, "characters") || !canWriteWorkModule(permissions, "ai-chat")) return [];
      return [{
        id: workId,
        title: requiredString(work.title),
        characterCount: Number(work.character_count)
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
      `SELECT character.id, character.work_id, character.name, character.code, character.gender,
              character.is_dead, character.attributes_json, character.profile_json,
              work.title AS work_title, work.owner_user_id,
              membership.user_id AS membership_user_id, membership.role AS membership_role,
              membership.permissions_json AS membership_permissions_json,
              avatar.sha256 AS avatar_sha256,
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
       LEFT JOIN character_avatars avatar ON avatar.character_id = character.id
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
      const permissions = this.catalogWorkPermissions(user, row);
      if (!permissions || !canReadWorkModule(permissions, "characters") || !canWriteWorkModule(permissions, "ai-chat")) return [];
      const character = {
        id: requiredString(row.id),
        name: requiredString(row.name),
        code: requiredString(row.code),
        gender: requiredString(row.gender),
        isDead: booleanValue(row.is_dead),
        attributes: json<Record<string, unknown>>(requiredString(row.attributes_json), {}),
        profile: json<Record<string, unknown>>(requiredString(row.profile_json), {})
      };
      const avatarSha256 = optionalString(row.avatar_sha256);
      return [{
        id: character.id,
        workId,
        workTitle: requiredString(row.work_title),
        name: requiredString(character.name),
        code: requiredString(character.code),
        gender: requiredString(character.gender),
        isDead: character.isDead,
        isPinned: Boolean(row.is_pinned),
        isFavorite: Boolean(row.user_is_favorite),
        avatarUrl: avatarSha256
          ? `/api/characters/${encodeURIComponent(character.id)}/avatar?v=${encodeURIComponent(avatarSha256)}`
          : null,
        publicSummary: publicCharacterSummary(character)
      }];
    });
  }

  private characterSnapshot(character: Record<string, unknown>): Record<string, unknown> {
    const work = this.store.getWork(requiredString(character.workId));
    const avatar = this.store.getCharacterAvatar(requiredString(character.id));
    return {
      id: requiredString(character.id),
      name: requiredString(character.name),
      code: requiredString(character.code),
      avatarUrl: character.avatarUrl ?? null,
      avatarSha256: avatar?.sha256 ?? null,
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
      avatarUrl: user.avatarUrl,
      avatarSha256: avatarVersionFromUrl(user.avatarUrl)
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

  private advanceContextEpoch(conversationId: string, timestamp = now()): void {
    this.db.run(
      "UPDATE im_conversations SET context_epoch = context_epoch + 1, updated_at = ? WHERE id = ?",
      timestamp,
      conversationId
    );
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
    if (existing) {
      const existingConversationId = requiredString(existing.id);
      this.refreshCharacterAvailability(existingConversationId);
      return this.getConversation(existingConversationId, user.userId);
    }
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
    const characterId = optionalString(row.character_id) ?? optionalString(snapshot.id);
    const avatarSha256 = optionalString(row.avatar_sha256);
    return {
      membershipId: requiredString(row.id),
      characterId,
      sourceWorkId: optionalString(row.source_work_id) ?? snapshot.workId ?? null,
      name: snapshot.name ?? "已删除角色",
      code: snapshot.code ?? "",
      avatarUrl: characterId && avatarSha256
        ? `/api/im/conversations/${encodeURIComponent(requiredString(row.conversation_id))}/characters/${encodeURIComponent(characterId)}/avatar?v=${encodeURIComponent(avatarSha256)}`
        : null,
      workTitle: snapshot.workTitle ?? "已删除作品",
      publicSummary: snapshot.publicSummary ?? "",
      status: requiredString(row.status),
      joinedAt: requiredString(row.joined_at),
      leftAt: optionalString(row.left_at)
    };
  }

  private conversationParticipants(conversationId: string, viewerUserId: string): { humans: Record<string, unknown>[]; characters: Record<string, unknown>[] } {
    const viewerMembership = this.db.get(
      `SELECT joined_sequence, left_sequence, left_at, conversation_snapshot_json FROM im_human_memberships
       WHERE conversation_id = ? AND user_id = ?
       ORDER BY joined_sequence DESC, joined_at DESC LIMIT 1`,
      conversationId,
      viewerUserId
    );
    if (!viewerMembership) throw new AppError(403, "IM_CONVERSATION_ACCESS_DENIED", "你不是这个 IM 会话的成员");
    const leftSequence = viewerMembership.left_sequence === null || viewerMembership.left_sequence === undefined
      ? null
      : Number(viewerMembership.left_sequence);
    const viewerLeftAt = optionalString(viewerMembership.left_at);
    if (leftSequence !== null) {
      const snapshot = json<Record<string, unknown>>(requiredString(viewerMembership.conversation_snapshot_json), {});
      const frozenParticipants = snapshot.participants;
      if (frozenParticipants && typeof frozenParticipants === "object" && !Array.isArray(frozenParticipants)) {
        const record = frozenParticipants as Record<string, unknown>;
        if (Array.isArray(record.humans) && Array.isArray(record.characters)) {
          return {
            humans: record.humans.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item))),
            characters: record.characters.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
          };
        }
      }
    }
    const humanVisibility = leftSequence === null
      ? "membership.left_at IS NULL"
      : `(membership.joined_sequence < ? OR (membership.joined_sequence = ? AND membership.joined_at <= ?))
         AND (membership.left_sequence IS NULL OR membership.left_sequence > ? OR (membership.left_sequence = ? AND membership.left_at >= ?))`;
    const characterVisibility = leftSequence === null
      ? "membership.left_at IS NULL"
      : `(membership.joined_sequence < ? OR (membership.joined_sequence = ? AND membership.joined_at <= ?))
         AND (membership.left_sequence IS NULL OR membership.left_sequence > ? OR (membership.left_sequence = ? AND membership.left_at >= ?))`;
    const visibilityParams = leftSequence === null ? [] : [leftSequence, leftSequence, viewerLeftAt, leftSequence, leftSequence, viewerLeftAt];
    const humans = this.db.all(
      `SELECT membership.id AS membership_id, membership.user_id, membership.role, membership.joined_at, membership.left_at,
              user.username, user.display_name, user.avatar_sha256
       FROM im_human_memberships membership JOIN users user ON user.id = membership.user_id
       WHERE membership.conversation_id = ? AND ${humanVisibility}
       ORDER BY membership.joined_at, membership.id`,
      conversationId,
      ...visibilityParams
    ).map((row) => ({ ...this.mapHumanMembership(row), ...(leftSequence === null ? {} : { leftAt: null }) }));
    const characters = this.db.all(
      `SELECT membership.*, avatar.sha256 AS avatar_sha256
       FROM im_character_memberships membership
       LEFT JOIN character_avatars avatar ON avatar.character_id = membership.character_id
       WHERE membership.conversation_id = ? AND ${characterVisibility}
       ORDER BY membership.joined_at, membership.id`,
      conversationId,
      ...visibilityParams
    ).map((row) => {
      const snapshot = json<Record<string, unknown>>(requiredString(row.snapshot_json), {});
      const currentAvatarSha256 = optionalString(row.avatar_sha256);
      const frozenAvatarSha256 = optionalString(snapshot.avatarSha256);
      const visibleRow = leftSequence === null || (currentAvatarSha256 && currentAvatarSha256 === frozenAvatarSha256)
        ? row
        : { ...row, avatar_sha256: null };
      return {
        ...this.mapCharacterMembership(visibleRow),
        ...(leftSequence === null ? {} : { leftAt: null, status: "active" })
      };
    });
    return { humans, characters };
  }

  private visibleMessagePage(
    conversationId: string,
    userId: string,
    limit = 50,
    beforeSequence?: number,
    afterSequence?: number
  ): { messages: Record<string, unknown>[]; hasMore: boolean; hasMoreAfter: boolean } {
    if (afterSequence !== undefined) {
      const rows = this.db.all(
        `SELECT message.* FROM im_messages message
         WHERE message.conversation_id = ? AND message.sequence > ?
           AND EXISTS (
             SELECT 1 FROM im_human_memberships membership
             WHERE membership.conversation_id = message.conversation_id AND membership.user_id = ?
               AND message.sequence > membership.joined_sequence
               AND (membership.left_sequence IS NULL OR message.sequence <= membership.left_sequence)
           )
         ORDER BY message.sequence ASC LIMIT ?`,
        conversationId,
        afterSequence,
        userId,
        limit + 1
      );
      const hasMoreAfter = rows.length > limit;
      const activeMembership = this.activeMembership(conversationId, userId);
      const historicalParticipants = activeMembership ? undefined : this.conversationParticipants(conversationId, userId);
      return {
        messages: this.mapMessagePage(rows.slice(0, limit), Boolean(activeMembership), historicalParticipants),
        hasMore: false,
        hasMoreAfter
      };
    }
    const params: SQLInputValue[] = [conversationId, userId];
    const before = beforeSequence === undefined ? "" : " AND message.sequence < ?";
    if (beforeSequence !== undefined) params.push(beforeSequence);
    params.push(limit + 1);
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
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(rows.length - limit) : rows;
    const activeMembership = this.activeMembership(conversationId, userId);
    const historicalParticipants = activeMembership ? undefined : this.conversationParticipants(conversationId, userId);
    return {
      messages: this.mapMessagePage(pageRows, Boolean(activeMembership), historicalParticipants),
      hasMore,
      hasMoreAfter: false
    };
  }

  private mapMessage(
    row: Record<string, unknown>,
    showCurrentCharacterAvatar = true,
    historicalParticipants?: { humans: Record<string, unknown>[]; characters: Record<string, unknown>[] },
    prepared?: PreparedMessagePage
  ): Record<string, unknown> {
    const messageId = requiredString(row.id);
    const conversationId = requiredString(row.conversation_id);
    const sender = json<Record<string, unknown>>(requiredString(row.sender_snapshot_json), {});
    const senderCharacterId = optionalString(row.sender_character_id) ?? optionalString(sender.id);
    if (requiredString(row.sender_kind) === "character" && senderCharacterId) {
      const snapshotAvatarSha256 = optionalString(sender.avatarSha256) ?? avatarVersionFromUrl(sender.avatarUrl);
      const avatarSha256 = snapshotAvatarSha256 ?? (showCurrentCharacterAvatar
        ? prepared
          ? prepared.avatarShaByCharacterId.get(senderCharacterId) ?? null
          : optionalString(this.db.get("SELECT sha256 FROM character_avatars WHERE character_id = ?", senderCharacterId)?.sha256)
        : null);
      sender.avatarUrl = avatarSha256
        ? `/api/im/conversations/${encodeURIComponent(conversationId)}/characters/${encodeURIComponent(senderCharacterId)}/avatar?v=${encodeURIComponent(avatarSha256)}`
        : optionalString(historicalParticipants?.characters
            .find((character) => optionalString(character.characterId) === senderCharacterId)?.avatarUrl);
    } else if (requiredString(row.sender_kind) === "human") {
      const senderUserId = optionalString(row.sender_user_id);
      const avatarSha256 = optionalString(sender.avatarSha256) ?? avatarVersionFromUrl(sender.avatarUrl);
      sender.avatarUrl = senderUserId && avatarSha256
        ? `/api/im/conversations/${encodeURIComponent(conversationId)}/users/${encodeURIComponent(senderUserId)}/avatar?v=${encodeURIComponent(avatarSha256)}`
        : !showCurrentCharacterAvatar
          ? optionalString(historicalParticipants?.humans
              .find((human) => optionalString(human.userId) === senderUserId)?.avatarUrl)
          : null;
    }
    const mentionRows = prepared
      ? prepared.mentionsByMessageId.get(messageId) ?? []
      : this.db.all("SELECT * FROM im_mentions WHERE message_id = ? ORDER BY position", messageId);
    const mentions = mentionRows.map((mention) => ({
      kind: requiredString(mention.target_kind),
      id: requiredString(mention.target_id),
      position: Number(mention.position),
      snapshot: json(requiredString(mention.target_snapshot_json), {})
    }));
    return {
      id: messageId,
      conversationId,
      sequence: Number(row.sequence),
      contextEpoch: Number(row.context_epoch),
      senderKind: requiredString(row.sender_kind),
      senderUserId: optionalString(row.sender_user_id),
      senderCharacterId,
      sender,
      content: requiredString(row.content),
      mentions,
      chainId: optionalString(row.chain_id),
      metadata: json(requiredString(row.metadata_json), {}),
      createdAt: requiredString(row.created_at)
    };
  }

  private mapMessagePage(
    rows: Record<string, unknown>[],
    showCurrentCharacterAvatars: boolean,
    historicalParticipants?: { humans: Record<string, unknown>[]; characters: Record<string, unknown>[] }
  ): Record<string, unknown>[] {
    if (rows.length === 0) return [];
    const messageIds = rows.map((row) => requiredString(row.id));
    const messagePlaceholders = messageIds.map(() => "?").join(", ");
    const mentionsByMessageId = new Map<string, Record<string, unknown>[]>();
    for (const mention of this.db.all(
      `SELECT * FROM im_mentions WHERE message_id IN (${messagePlaceholders}) ORDER BY message_id, position`,
      ...messageIds
    )) {
      const messageId = requiredString(mention.message_id);
      const mentions = mentionsByMessageId.get(messageId) ?? [];
      mentions.push(mention);
      mentionsByMessageId.set(messageId, mentions);
    }
    const characterIds = showCurrentCharacterAvatars
      ? [...new Set(rows.flatMap((row) => optionalString(row.sender_character_id) ? [requiredString(row.sender_character_id)] : []))]
      : [];
    const avatarShaByCharacterId = new Map<string, string>();
    if (characterIds.length > 0) {
      const characterPlaceholders = characterIds.map(() => "?").join(", ");
      for (const avatar of this.db.all(
        `SELECT character_id, sha256 FROM character_avatars WHERE character_id IN (${characterPlaceholders})`,
        ...characterIds
      )) {
        avatarShaByCharacterId.set(requiredString(avatar.character_id), requiredString(avatar.sha256));
      }
    }
    const prepared = { mentionsByMessageId, avatarShaByCharacterId };
    return rows.map((row) => this.mapMessage(row, showCurrentCharacterAvatars, historicalParticipants, prepared));
  }

  private mapConversation(row: Record<string, unknown>, userId: string, prepared?: PreparedConversationSummary): Record<string, unknown> {
    const conversationId = requiredString(row.id);
    const participants = prepared?.participants ?? this.conversationParticipants(conversationId, userId);
    const avatarCharacters = participants.characters
      .filter((membership) => requiredString(membership.status) === "active")
      .slice(0, 3)
      .map((membership) => ({
        characterId: requiredString(membership.characterId),
        name: requiredString(membership.name),
        avatarUrl: optionalString(membership.avatarUrl)
      }));
    const avatarMembers = [
      ...participants.characters.filter((membership) => requiredString(membership.status) === "active").map((membership) => ({
        kind: "character",
        participantId: requiredString(membership.characterId),
        name: requiredString(membership.name),
        avatarUrl: optionalString(membership.avatarUrl),
        joinedAt: requiredString(membership.joinedAt),
        membershipId: requiredString(membership.membershipId)
      })),
      ...participants.humans.map((membership) => ({
        kind: "user",
        participantId: requiredString(membership.userId),
        name: requiredString(membership.displayName),
        displayName: requiredString(membership.displayName),
        username: requiredString(membership.username),
        avatarUrl: optionalString(membership.avatarUrl),
        joinedAt: requiredString(membership.joinedAt),
        membershipId: requiredString(membership.membershipId)
      }))
    ].sort((left, right) => left.joinedAt.localeCompare(right.joinedAt)
      || left.kind.localeCompare(right.kind)
      || left.membershipId.localeCompare(right.membershipId))
      .slice(0, 9)
      .map((member) => ({
        kind: member.kind,
        participantId: member.participantId,
        name: member.name,
        avatarUrl: member.avatarUrl,
        ...("displayName" in member ? {
          displayName: member.displayName,
          username: "username" in member ? member.username : ""
        } : {})
      }));
    const activeMembership = prepared?.activeMembership ?? (prepared ? undefined : this.activeMembership(conversationId, userId));
    const viewerMembership = prepared?.viewerMembership ?? activeMembership ?? this.db.get(
      `SELECT * FROM im_human_memberships
       WHERE conversation_id = ? AND user_id = ?
       ORDER BY joined_sequence DESC, joined_at DESC LIMIT 1`,
      conversationId,
      userId
    );
    const historicalSnapshot: Record<string, unknown> = activeMembership
      ? {}
      : json<Record<string, unknown>>(requiredString(viewerMembership?.conversation_snapshot_json), {});
    const conversationValue = (column: string, snapshotKey: string): unknown => historicalSnapshot[snapshotKey] ?? row[column];
    const conversationLatestSequence = prepared?.latestSequence ?? Number(this.db.get(
      "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM im_messages WHERE conversation_id = ?",
      conversationId
    )?.sequence ?? 0);
    const latestSequence = activeMembership
      ? conversationLatestSequence
      : Math.min(conversationLatestSequence, Number(viewerMembership?.left_sequence ?? conversationLatestSequence));
    const lastReadSequence = Number(activeMembership?.last_read_sequence ?? latestSequence);
    const unread = prepared?.unreadCount ?? (activeMembership ? Number(this.db.get(
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
    )?.count ?? 0) : 0);
    const mentionUnread = prepared?.mentionUnreadCount ?? (activeMembership ? Number(this.db.get(
      `SELECT COUNT(DISTINCT message.id) AS count FROM im_messages message
       JOIN im_mentions mention ON mention.message_id = message.id
       WHERE message.conversation_id = ? AND message.sequence > ?
         AND mention.target_kind = 'user' AND mention.target_id = ?`,
      conversationId,
      lastReadSequence,
      userId
    )?.count ?? 0) : 0);
    return {
      id: conversationId,
      kind: requiredString(row.kind),
      ownerUserId: requiredString(conversationValue("owner_user_id", "ownerUserId")),
      title: requiredString(conversationValue("title", "title")),
      replyMode: requiredString(conversationValue("reply_mode", "replyMode")),
      responseThreshold: Number(conversationValue("response_threshold", "responseThreshold")),
      maxAiMessages: Number(conversationValue("max_ai_messages", "maxAiMessages")),
      contextEpoch: Number(conversationValue("context_epoch", "contextEpoch")),
      status: requiredString(conversationValue("status", "status")),
      avatarCharacters,
      avatarMembers,
      active: Boolean(activeMembership) && requiredString(row.status) === "active",
      unreadCount: unread,
      mentionUnreadCount: mentionUnread,
      latestSequence,
      createdAt: requiredString(row.created_at),
      updatedAt: requiredString(historicalSnapshot.updatedAt ?? viewerMembership?.left_at ?? row.updated_at)
    };
  }

  listConversations(userId: string): Record<string, unknown>[] {
    const conversations = this.db.all(
      `SELECT DISTINCT conversation.* FROM im_conversations conversation
       JOIN im_human_memberships membership ON membership.conversation_id = conversation.id
       WHERE membership.user_id = ?`,
      userId
    );
    if (conversations.length === 0) return [];
    const viewerMemberships = this.db.all(
      `SELECT * FROM im_human_memberships WHERE user_id = ?
       ORDER BY conversation_id, joined_sequence DESC, joined_at DESC`,
      userId
    );
    const viewerByConversation = new Map<string, Record<string, unknown>>();
    for (const membership of viewerMemberships) {
      const conversationId = requiredString(membership.conversation_id);
      if (!viewerByConversation.has(conversationId)) viewerByConversation.set(conversationId, membership);
    }
    const latestByConversation = new Map(this.db.all(
      `WITH visible_conversations AS (
         SELECT DISTINCT conversation_id FROM im_human_memberships WHERE user_id = ?
       )
       SELECT visible.conversation_id, MAX(message.sequence) AS sequence
       FROM visible_conversations visible
       JOIN im_messages message ON message.conversation_id = visible.conversation_id
       GROUP BY visible.conversation_id`,
      userId
    ).map((row) => [requiredString(row.conversation_id), Number(row.sequence)]));
    const unreadByConversation = new Map(this.db.all(
      `SELECT membership.conversation_id, COUNT(message.id) AS count
       FROM im_human_memberships membership
       JOIN im_messages message ON message.conversation_id = membership.conversation_id
         AND message.sequence > membership.last_read_sequence
         AND message.sequence > membership.joined_sequence
       WHERE membership.user_id = ? AND membership.left_at IS NULL
       GROUP BY membership.conversation_id`,
      userId
    ).map((row) => [requiredString(row.conversation_id), Number(row.count)]));
    const mentionUnreadByConversation = new Map(this.db.all(
      `SELECT membership.conversation_id, COUNT(DISTINCT message.id) AS count
       FROM im_human_memberships membership
       JOIN im_messages message ON message.conversation_id = membership.conversation_id
         AND message.sequence > membership.last_read_sequence
         AND message.sequence > membership.joined_sequence
       JOIN im_mentions mention ON mention.message_id = message.id
         AND mention.target_kind = 'user' AND mention.target_id = membership.user_id
       WHERE membership.user_id = ? AND membership.left_at IS NULL
       GROUP BY membership.conversation_id`,
      userId
    ).map((row) => [requiredString(row.conversation_id), Number(row.count)]));
    const humanRows = this.db.all(
      `WITH visible_conversations AS (
         SELECT DISTINCT conversation_id FROM im_human_memberships WHERE user_id = ?
       )
       SELECT membership.id AS membership_id, membership.conversation_id, membership.user_id, membership.role,
              membership.joined_sequence, membership.left_sequence, membership.joined_at, membership.left_at,
              user.username, user.display_name, user.avatar_sha256
       FROM visible_conversations visible
       JOIN im_human_memberships membership ON membership.conversation_id = visible.conversation_id
       JOIN users user ON user.id = membership.user_id
       ORDER BY membership.conversation_id, membership.joined_at, membership.id`,
      userId
    );
    const characterRows = this.db.all(
      `WITH visible_conversations AS (
         SELECT DISTINCT conversation_id FROM im_human_memberships WHERE user_id = ?
       )
       SELECT membership.*, avatar.sha256 AS avatar_sha256
       FROM visible_conversations visible
       JOIN im_character_memberships membership ON membership.conversation_id = visible.conversation_id
       LEFT JOIN character_avatars avatar ON avatar.character_id = membership.character_id
       ORDER BY membership.conversation_id, membership.joined_at, membership.id`,
      userId
    );
    const humanRowsByConversation = new Map<string, Record<string, unknown>[]>();
    for (const membership of humanRows) {
      const conversationId = requiredString(membership.conversation_id);
      const memberships = humanRowsByConversation.get(conversationId) ?? [];
      memberships.push(membership);
      humanRowsByConversation.set(conversationId, memberships);
    }
    const characterRowsByConversation = new Map<string, Record<string, unknown>[]>();
    for (const membership of characterRows) {
      const conversationId = requiredString(membership.conversation_id);
      const memberships = characterRowsByConversation.get(conversationId) ?? [];
      memberships.push(membership);
      characterRowsByConversation.set(conversationId, memberships);
    }
    const visibleDuringViewerTenure = (membership: Record<string, unknown>, viewer: Record<string, unknown>): boolean => {
      if (viewer.left_sequence === null || viewer.left_sequence === undefined) return membership.left_at === null || membership.left_at === undefined;
      const leftSequence = Number(viewer.left_sequence);
      const leftAt = requiredString(viewer.left_at);
      const joinedSequence = Number(membership.joined_sequence);
      const membershipLeftSequence = membership.left_sequence === null || membership.left_sequence === undefined
        ? null
        : Number(membership.left_sequence);
      return (joinedSequence < leftSequence || (joinedSequence === leftSequence && requiredString(membership.joined_at) <= leftAt))
        && (membershipLeftSequence === null || membershipLeftSequence > leftSequence
          || (membershipLeftSequence === leftSequence && requiredString(membership.left_at) >= leftAt));
    };
    return conversations.map((row) => {
      const conversationId = requiredString(row.id);
      const viewer = viewerByConversation.get(conversationId);
      if (!viewer) throw new AppError(403, "IM_CONVERSATION_ACCESS_DENIED", "你不是这个 IM 会话的成员");
      const activeMembership = viewer.left_at === null || viewer.left_at === undefined ? viewer : undefined;
      const snapshot = activeMembership ? {} : json<Record<string, unknown>>(requiredString(viewer.conversation_snapshot_json), {});
      const frozen = snapshot.participants && typeof snapshot.participants === "object" && !Array.isArray(snapshot.participants)
        ? snapshot.participants as Record<string, unknown>
        : null;
      let participants: PreparedConversationSummary["participants"];
      if (frozen && Array.isArray(frozen.humans) && Array.isArray(frozen.characters)) {
        participants = {
          humans: frozen.humans.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item))),
          characters: frozen.characters.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
        };
      } else {
        const humans = (humanRowsByConversation.get(conversationId) ?? [])
          .filter((membership) => visibleDuringViewerTenure(membership, viewer)).map((membership) => ({
          ...this.mapHumanMembership(membership),
          ...(activeMembership ? {} : { leftAt: null })
        }));
        const characters = (characterRowsByConversation.get(conversationId) ?? [])
          .filter((membership) => visibleDuringViewerTenure(membership, viewer)).map((membership) => {
          const membershipSnapshot = json<Record<string, unknown>>(requiredString(membership.snapshot_json), {});
          const currentAvatarSha256 = optionalString(membership.avatar_sha256);
          const frozenAvatarSha256 = optionalString(membershipSnapshot.avatarSha256);
          return {
            ...this.mapCharacterMembership(activeMembership || (currentAvatarSha256 && currentAvatarSha256 === frozenAvatarSha256)
              ? membership
              : { ...membership, avatar_sha256: null }),
            ...(activeMembership ? {} : { leftAt: null, status: "active" })
          };
        });
        participants = { humans, characters };
      }
      return this.mapConversation(row, userId, {
        participants,
        activeMembership,
        viewerMembership: viewer,
        latestSequence: latestByConversation.get(conversationId) ?? 0,
        unreadCount: unreadByConversation.get(conversationId) ?? 0,
        mentionUnreadCount: mentionUnreadByConversation.get(conversationId) ?? 0
      });
    })
      .sort((left, right) => requiredString(right.updatedAt).localeCompare(requiredString(left.updatedAt))
        || requiredString(right.createdAt).localeCompare(requiredString(left.createdAt)));
  }

  getConversationSummary(conversationId: string, userId: string): Record<string, unknown> {
    return this.mapConversation(this.assertReadableConversation(conversationId, userId), userId);
  }

  getConversation(conversationId: string, userId: string, beforeSequence?: number, afterSequence?: number): Record<string, unknown> {
    const row = this.assertReadableConversation(conversationId, userId);
    const viewerMembership = this.db.get(
      `SELECT joined_sequence, left_sequence, joined_at, left_at, conversation_snapshot_json FROM im_human_memberships
       WHERE conversation_id = ? AND user_id = ?
       ORDER BY joined_sequence DESC, joined_at DESC LIMIT 1`,
      conversationId,
      userId
    );
    if (!viewerMembership) throw new AppError(403, "IM_CONVERSATION_ACCESS_DENIED", "你不是这个 IM 会话的成员");
    if (requiredString(row.status) === "active" && !optionalString(viewerMembership.left_at)) {
      this.refreshCharacterAvailability(conversationId, requiredString(row.owner_user_id));
    }
    const viewerLeftSequence = viewerMembership.left_sequence === null || viewerMembership.left_sequence === undefined
      ? null
      : Number(viewerMembership.left_sequence);
    const activeChain = this.db.get(
      `SELECT chain.id, chain.status, chain.model_stage, chain.generated_count, chain.error_code, chain.error_message,
              chain.created_at, chain.updated_at, trigger.sequence AS trigger_sequence
       FROM im_chains chain JOIN im_messages trigger ON trigger.id = chain.trigger_message_id
       WHERE chain.conversation_id = ? AND trigger.sequence > ?
         AND (? IS NULL OR trigger.sequence <= ?)
         AND chain.created_at >= ?
         AND (? IS NULL OR chain.created_at <= ?)
       ORDER BY chain.created_at DESC LIMIT 1`,
      conversationId,
      Number(viewerMembership.joined_sequence),
      viewerLeftSequence,
      viewerLeftSequence,
      requiredString(viewerMembership.joined_at),
      optionalString(viewerMembership.left_at),
      optionalString(viewerMembership.left_at)
    );
    const activeChainId = requiredString(activeChain?.id);
    const replyTurnRows = activeChain ? this.db.all(
      `SELECT turn.*, membership.character_id, membership.snapshot_json
       FROM im_chain_turns turn JOIN im_character_memberships membership ON membership.id = turn.character_membership_id
       WHERE turn.chain_id = ? AND turn.kind = 'reply' AND membership.joined_sequence <= ?
         AND (membership.left_sequence IS NULL OR membership.left_sequence >= ?)
       ORDER BY turn.created_at, turn.id`,
      requiredString(activeChain.id),
      Number(activeChain.trigger_sequence),
      Number(activeChain.trigger_sequence)
    ) : [];
    const replyCharacterIds = [...new Set(replyTurnRows.flatMap((turn) => optionalString(turn.character_id) ? [requiredString(turn.character_id)] : []))];
    const replyAvatarShaByCharacterId = new Map<string, string>();
    if (viewerLeftSequence === null && replyCharacterIds.length > 0) {
      const placeholders = replyCharacterIds.map(() => "?").join(", ");
      for (const avatar of this.db.all(
        `SELECT character_id, sha256 FROM character_avatars WHERE character_id IN (${placeholders})`,
        ...replyCharacterIds
      )) {
        replyAvatarShaByCharacterId.set(requiredString(avatar.character_id), requiredString(avatar.sha256));
      }
    }
    const conversationSnapshot = json<Record<string, unknown>>(requiredString(viewerMembership.conversation_snapshot_json), {});
    const frozenParticipants = conversationSnapshot.participants && typeof conversationSnapshot.participants === "object"
      ? conversationSnapshot.participants as Record<string, unknown>
      : {};
    const replyTurns = replyTurnRows.map((turn) => {
      const snapshot = json<Record<string, unknown>>(requiredString(turn.snapshot_json), {});
      const characterId = optionalString(turn.character_id) ?? requiredString(snapshot.id);
      const currentAvatarSha256 = characterId ? replyAvatarShaByCharacterId.get(characterId) ?? null : null;
      const frozenCharacter = Array.isArray(frozenParticipants.characters)
        ? frozenParticipants.characters.find((item) => item && typeof item === "object" && !Array.isArray(item)
          && optionalString((item as Record<string, unknown>).characterId) === characterId) as Record<string, unknown> | undefined
        : undefined;
      const avatarUrl = viewerLeftSequence === null
        ? characterId && currentAvatarSha256
          ? `/api/im/conversations/${encodeURIComponent(conversationId)}/characters/${encodeURIComponent(characterId)}/avatar?v=${encodeURIComponent(currentAvatarSha256)}`
          : null
        : optionalString(frozenCharacter?.avatarUrl);
      return {
        id: requiredString(turn.id),
        chainId: activeChainId,
        characterId,
        character: {
          characterId,
          name: snapshot.name ?? "角色",
          avatarUrl
        },
        kind: "reply",
        status: requiredString(turn.status),
        failure: optionalString(turn.failure),
        createdAt: requiredString(turn.created_at),
        completedAt: optionalString(turn.completed_at)
      };
    });
    const messagePage = this.visibleMessagePage(conversationId, userId, 50, beforeSequence, afterSequence);
    return {
      ...this.mapConversation(row, userId),
      participants: this.conversationParticipants(conversationId, userId),
      messages: messagePage.messages,
      hasMoreMessages: messagePage.hasMore,
      hasMoreMessagesAfter: messagePage.hasMoreAfter,
      activeChain: activeChain ? {
        id: activeChain.id,
        status: activeChain.status,
        model_stage: activeChain.model_stage,
        generated_count: activeChain.generated_count,
        error_code: activeChain.error_code,
        error_message: activeChain.error_message,
        created_at: activeChain.created_at,
        updated_at: activeChain.updated_at,
        turns: replyTurns
      } : null
    };
  }

  refreshCharacterAvailability(conversationId: string, knownOwnerUserId?: string): void {
    const ownerUserId = optionalString(knownOwnerUserId) ?? optionalString(
      this.db.get("SELECT owner_user_id FROM im_conversations WHERE id = ?", conversationId)?.owner_user_id
    );
    if (!ownerUserId) throw notFound("IM 会话");
    const memberships = this.db.all(
      `SELECT membership.id, membership.character_id, membership.source_work_id, membership.snapshot_json,
              character.id AS available_character_id, character.work_id AS available_work_id,
              work.owner_user_id, work_member.user_id AS membership_user_id,
              work_member.role AS membership_role, work_member.permissions_json AS membership_permissions_json,
              owner.status AS conversation_owner_status, owner.role AS conversation_owner_role
       FROM im_character_memberships membership
       JOIN users owner ON owner.id = ?
       LEFT JOIN characters character
         ON character.id = COALESCE(membership.character_id, json_extract(membership.snapshot_json, '$.id'))
        AND character.merged_into_character_id IS NULL
       LEFT JOIN works work ON work.id = character.work_id AND work.deleted_at IS NULL
       LEFT JOIN work_memberships work_member ON work_member.work_id = work.id AND work_member.user_id = ?
       WHERE membership.conversation_id = ? AND membership.left_at IS NULL
       ORDER BY CASE WHEN membership.character_id IS NOT NULL AND membership.status = 'active' THEN 0 ELSE 1 END,
                membership.joined_at, membership.id`,
      ownerUserId,
      ownerUserId,
      conversationId
    );
    const owner = {
      userId: ownerUserId,
      role: requiredString(memberships[0]?.conversation_owner_role) === "admin" ? "admin" as const : "user" as const
    };
    let availableCharacterCount = 0;
    for (const membership of memberships) {
      const snapshot = json<Record<string, unknown>>(requiredString(membership.snapshot_json), {});
      const currentCharacterId = optionalString(membership.character_id);
      const characterId = currentCharacterId ?? optionalString(snapshot.id);
      let status: "active" | "suspended" = "suspended";
      let restoredCharacterId: string | null = null;
      const permissions = requiredString(membership.conversation_owner_status) === "active"
        ? this.catalogWorkPermissions(owner, membership)
        : null;
      if (characterId && optionalString(membership.available_character_id) === characterId
        && permissions && canReadWorkModule(permissions, "characters") && canWriteWorkModule(permissions, "ai-chat")) {
        const sourceWorkId = optionalString(membership.source_work_id) ?? optionalString(snapshot.workId);
        if (!sourceWorkId || requiredString(membership.available_work_id) === sourceWorkId) {
          const duplicate = currentCharacterId ? undefined : memberships.find((candidate) => (
            requiredString(candidate.id) !== requiredString(membership.id)
            && optionalString(candidate.character_id) === characterId
          ));
          if (!duplicate && availableCharacterCount < IM_MAX_AI_PARTICIPANTS) {
            status = "active";
            restoredCharacterId = characterId;
            availableCharacterCount += 1;
          }
        }
      }
      this.db.run(
        "UPDATE im_character_memberships SET character_id = COALESCE(character_id, ?), status = ? WHERE id = ?",
        restoredCharacterId,
        status,
        requiredString(membership.id)
      );
    }
  }

  getCharacterAvatarAccess(userId: string, conversationId: string, characterId: string): Record<string, unknown> {
    return this.getCharacterAvatarVersionAccess(userId, conversationId, characterId);
  }

  getCharacterAvatarVersionAccess(userId: string, conversationId: string, characterId: string, sha256?: string): Record<string, unknown> {
    this.assertReadableConversation(conversationId, userId);
    const visibleCharacter = this.conversationParticipants(conversationId, userId).characters
      .find((membership) => requiredString(membership.characterId) === characterId);
    const visibleSha256 = avatarVersionFromUrl(visibleCharacter?.avatarUrl);
    const requestedSha256 = optionalString(sha256) ?? visibleSha256;
    const visibleInMessage = requestedSha256
      ? this.messageAvatarVersionVisible(userId, conversationId, "character", characterId, requestedSha256)
      : false;
    if (!requestedSha256 || (requestedSha256 !== visibleSha256 && !visibleInMessage)) {
      throw new AppError(404, "CHARACTER_AVATAR_NOT_FOUND", "该角色头像版本不在你的 IM 可见任期内");
    }
    if (requestedSha256) {
      const version = this.db.get(
        `SELECT mime_type, byte_length, sha256, storage_key, width, height, created_at
         FROM im_avatar_versions
         WHERE conversation_id = ? AND participant_kind = 'character' AND participant_id = ? AND sha256 = ?`,
        conversationId,
        characterId,
        requestedSha256
      );
      if (version) return {
        mimeType: requiredString(version.mime_type),
        byteLength: Number(version.byte_length),
        sha256: requiredString(version.sha256),
        storageKey: requiredString(version.storage_key),
        width: Number(version.width),
        height: Number(version.height),
        updatedAt: requiredString(version.created_at)
      };
    }
    const avatar = this.store.getCharacterAvatar(characterId);
    if (!avatar) throw new AppError(404, "CHARACTER_AVATAR_NOT_FOUND", "角色头像不存在");
    if (requestedSha256 !== avatar.sha256) {
      throw new AppError(404, "CHARACTER_AVATAR_NOT_FOUND", "IM 角色头像版本不存在");
    }
    if (!this.activeMembership(conversationId, userId)) {
      throw new AppError(404, "CHARACTER_AVATAR_NOT_FOUND", "离开群聊后的角色头像版本不存在");
    }
    return avatar;
  }

  getHumanAvatarVersionAccess(userId: string, conversationId: string, targetUserId: string, sha256: string): Record<string, unknown> {
    this.assertReadableConversation(conversationId, userId);
    const visibleHuman = this.conversationParticipants(conversationId, userId).humans
      .find((membership) => requiredString(membership.userId) === targetUserId);
    if (avatarVersionFromUrl(visibleHuman?.avatarUrl) !== sha256
      && !this.messageAvatarVersionVisible(userId, conversationId, "human", targetUserId, sha256)) {
      throw new AppError(404, "USER_AVATAR_NOT_FOUND", "该成员头像版本不在你的 IM 可见任期内");
    }
    const version = this.db.get(
      `SELECT mime_type, content, byte_length, sha256, width, height, created_at
       FROM im_avatar_versions
       WHERE conversation_id = ? AND participant_kind = 'user' AND participant_id = ? AND sha256 = ?`,
      conversationId,
      targetUserId,
      sha256
    );
    if (!version) throw new AppError(404, "USER_AVATAR_NOT_FOUND", "IM 成员头像版本不存在");
    return {
      mimeType: requiredString(version.mime_type),
      content: Buffer.from(version.content as Uint8Array),
      byteLength: Number(version.byte_length),
      sha256: requiredString(version.sha256),
      width: Number(version.width),
      height: Number(version.height),
      updatedAt: requiredString(version.created_at)
    };
  }

  private messageAvatarVersionVisible(
    userId: string,
    conversationId: string,
    senderKind: "character" | "human",
    senderId: string,
    sha256: string
  ): boolean {
    const visibleMessage = (senderCondition: string, senderParams: SQLInputValue[]): boolean => Boolean(this.db.get(
      `SELECT 1 AS present FROM im_messages message
       WHERE message.conversation_id = ? AND message.sender_kind = ? AND ${senderCondition}
         AND COALESCE(
           NULLIF(json_extract(message.sender_snapshot_json, '$.avatarSha256'), ''),
           CASE WHEN instr(json_extract(message.sender_snapshot_json, '$.avatarUrl'), '?v=') > 0
             THEN substr(json_extract(message.sender_snapshot_json, '$.avatarUrl'), instr(json_extract(message.sender_snapshot_json, '$.avatarUrl'), '?v=') + 3)
           END
         ) = ?
         AND EXISTS (
           SELECT 1 FROM im_human_memberships membership
           WHERE membership.conversation_id = message.conversation_id AND membership.user_id = ?
             AND message.sequence > membership.joined_sequence
             AND (membership.left_sequence IS NULL OR message.sequence <= membership.left_sequence)
         ) LIMIT 1`,
      conversationId,
      senderKind,
      ...senderParams,
      sha256,
      userId
    ));
    if (senderKind === "human") return visibleMessage("message.sender_user_id = ?", [senderId]);
    return visibleMessage("message.sender_character_id = ?", [senderId])
      || visibleMessage(
        "message.sender_character_id IS NULL AND json_extract(message.sender_snapshot_json, '$.id') = ?",
        [senderId]
      );
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
      const timestamp = now();
      const joinedSequence = this.nextSequence(conversationId) - 1;
      this.cancelActiveChain(conversationId, "human_member_joined");
      this.insertHumanMembership(conversationId, user, "member", joinedSequence);
      this.advanceContextEpoch(conversationId, timestamp);
      this.insertSystemMessage(conversationId, `${user.displayName} 加入了群聊`, { type: "human-joined", user: this.humanSnapshot(user) });
      this.store.audit(null, "im.human-added", "im-conversation", conversationId, { userId });
    });
    return this.getConversation(conversationId, owner.userId);
  }

  private captureConversationAvatarVersions(conversationId: string, timestamp: string): void {
    this.db.run(
      `INSERT OR IGNORE INTO im_avatar_versions (
         conversation_id, participant_kind, participant_id, sha256, mime_type, byte_length,
         storage_key, content, width, height, created_at
       )
       SELECT membership.conversation_id, 'character', membership.character_id, avatar.sha256,
              avatar.mime_type, avatar.byte_length, avatar.storage_key, NULL, avatar.width, avatar.height, ?
       FROM im_character_memberships membership
       JOIN character_avatars avatar ON avatar.character_id = membership.character_id
       WHERE membership.conversation_id = ? AND membership.left_at IS NULL AND membership.character_id IS NOT NULL`,
      timestamp,
      conversationId
    );
    this.db.run(
      `INSERT OR IGNORE INTO im_avatar_versions (
         conversation_id, participant_kind, participant_id, sha256, mime_type, byte_length,
         storage_key, content, width, height, created_at
       )
       SELECT membership.conversation_id, 'user', membership.user_id, avatar.sha256,
              avatar.mime_type, avatar.byte_length, NULL, avatar.content, avatar.width, avatar.height, ?
       FROM im_human_memberships membership
       JOIN user_avatars avatar ON avatar.user_id = membership.user_id
       WHERE membership.conversation_id = ? AND membership.left_at IS NULL`,
      timestamp,
      conversationId
    );
  }

  captureCharacterAvatarVersion(conversationId: string, characterId: string, timestamp: string): void {
    this.db.run(
      `INSERT OR IGNORE INTO im_avatar_versions (
         conversation_id, participant_kind, participant_id, sha256, mime_type, byte_length,
         storage_key, content, width, height, created_at
       )
       SELECT ?, 'character', avatar.character_id, avatar.sha256, avatar.mime_type, avatar.byte_length,
              avatar.storage_key, NULL, avatar.width, avatar.height, ?
       FROM character_avatars avatar WHERE avatar.character_id = ?`,
      conversationId,
      timestamp,
      characterId
    );
  }

  private captureHumanAvatarVersion(conversationId: string, userId: string, timestamp: string): void {
    this.db.run(
      `INSERT OR IGNORE INTO im_avatar_versions (
         conversation_id, participant_kind, participant_id, sha256, mime_type, byte_length,
         storage_key, content, width, height, created_at
       )
       SELECT ?, 'user', avatar.user_id, avatar.sha256, avatar.mime_type, avatar.byte_length,
              NULL, avatar.content, avatar.width, avatar.height, ?
       FROM user_avatars avatar WHERE avatar.user_id = ?`,
      conversationId,
      timestamp,
      userId
    );
  }

  private frozenParticipantSnapshot(conversationId: string, userId: string): {
    humans: Record<string, unknown>[];
    characters: Record<string, unknown>[];
  } {
    const participants = this.conversationParticipants(conversationId, userId);
    return {
      humans: participants.humans.map((human) => {
        const sha256 = avatarVersionFromUrl(human.avatarUrl);
        return {
          ...human,
          avatarUrl: sha256
            ? `/api/im/conversations/${encodeURIComponent(conversationId)}/users/${encodeURIComponent(requiredString(human.userId))}/avatar?v=${encodeURIComponent(sha256)}`
            : null
        };
      }),
      characters: participants.characters
    };
  }

  private finishMembership(conversationId: string, userId: string, actorUserId: string, action: "left" | "removed"): void {
    const membership = this.activeMembership(conversationId, userId);
    if (!membership) throw notFound("IM 群成员");
    const conversation = this.db.get("SELECT * FROM im_conversations WHERE id = ?", conversationId);
    if (!conversation) throw notFound("IM 会话");
    const sequence = this.nextSequence(conversationId) - 1;
    const timestamp = now();
    this.captureConversationAvatarVersions(conversationId, timestamp);
    const conversationSnapshot = {
      ownerUserId: requiredString(conversation.owner_user_id),
      title: requiredString(conversation.title),
      replyMode: requiredString(conversation.reply_mode),
      responseThreshold: Number(conversation.response_threshold),
      maxAiMessages: Number(conversation.max_ai_messages),
      contextEpoch: Number(conversation.context_epoch),
      status: requiredString(conversation.status),
      participants: this.frozenParticipantSnapshot(conversationId, userId),
      updatedAt: timestamp
    };
    this.db.run(
      `UPDATE im_human_memberships SET left_sequence = ?, left_at = ?, conversation_snapshot_json = ?
       WHERE id = ?`,
      sequence,
      timestamp,
      JSON.stringify(conversationSnapshot),
      requiredString(membership.id)
    );
    this.cancelActiveChain(conversationId, `human_member_${action}`);
    this.advanceContextEpoch(conversationId, timestamp);
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
    this.refreshCharacterAvailability(conversationId);
    const activeCount = Number(this.db.get(
      `SELECT COUNT(*) AS count FROM im_character_memberships
       WHERE conversation_id = ? AND left_at IS NULL AND status = 'active' AND character_id IS NOT NULL`,
      conversationId
    )?.count ?? 0);
    if (activeCount >= IM_MAX_AI_PARTICIPANTS) throw new AppError(409, "IM_CHARACTER_LIMIT_REACHED", "群聊 AI 角色已达到上限");
    if (this.db.get(
      `SELECT 1 AS present FROM im_character_memberships
       WHERE conversation_id = ? AND left_at IS NULL
         AND (character_id = ? OR (character_id IS NULL AND json_extract(snapshot_json, '$.id') = ?))`,
      conversationId,
      characterId,
      characterId
    )) throw new AppError(409, "IM_CHARACTER_EXISTS", "该角色已经在群聊中");
    const character = this.assertCharacterAvailable(owner, characterId);
    this.db.transaction(() => {
      const timestamp = now();
      this.cancelActiveChain(conversationId, "character_member_joined");
      this.insertCharacterMembership(conversationId, character, this.nextSequence(conversationId) - 1);
      this.advanceContextEpoch(conversationId, timestamp);
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
    const membership = rows.find((row) => {
      if (optionalString(row.character_id) === characterId) return true;
      const snapshot = json<Record<string, unknown>>(requiredString(row.snapshot_json), {});
      return !optionalString(row.character_id) && optionalString(snapshot.id) === characterId;
    });
    if (!membership) throw notFound("IM 群角色");
    const removesActiveCharacter = optionalString(membership.character_id) !== null && requiredString(membership.status) === "active";
    const activeCount = rows.filter((row) => optionalString(row.character_id) !== null && requiredString(row.status) === "active").length;
    if (removesActiveCharacter && activeCount <= 1) {
      throw new AppError(409, "IM_CHARACTER_REQUIRED", "群聊必须至少保留一个 AI 角色");
    }
    const timestamp = now();
    this.db.transaction(() => {
      this.cancelActiveChain(conversationId, "character_member_removed");
      this.captureConversationAvatarVersions(conversationId, timestamp);
      this.db.run(
        `UPDATE im_character_memberships SET status = 'removed', left_sequence = ?, left_at = ? WHERE id = ?`,
        this.nextSequence(conversationId) - 1,
        timestamp,
        requiredString(membership.id)
      );
      this.advanceContextEpoch(conversationId, timestamp);
      this.store.audit(optionalString(membership.source_work_id), "im.character-removed", "im-conversation", conversationId, { characterId });
    });
  }

  transferGroup(owner: AuthUser, conversationId: string, nextOwnerUserId: string): Record<string, unknown> {
    const conversation = this.assertOwner(conversationId, owner.userId);
    if (requiredString(conversation.kind) !== "group") throw new AppError(400, "IM_GROUP_REQUIRED", "单聊不能转让");
    if (!this.activeMembership(conversationId, nextOwnerUserId)) throw new AppError(400, "IM_OWNER_NOT_MEMBER", "新群主必须是当前群成员");
    const nextOwner = this.assertActiveUser(nextOwnerUserId);
    const characterIds = this.db.all(
      `SELECT character_id FROM im_character_memberships
       WHERE conversation_id = ? AND left_at IS NULL AND status = 'active' AND character_id IS NOT NULL`,
      conversationId
    ).map((row) => requiredString(row.character_id));
    for (const characterId of characterIds) this.assertCharacterAvailable(nextOwner, characterId);
    this.db.transaction(() => {
      const timestamp = now();
      this.cancelActiveChain(conversationId, "group_owner_transferred");
      this.db.run("UPDATE im_human_memberships SET role = 'member' WHERE conversation_id = ? AND user_id = ? AND left_at IS NULL", conversationId, owner.userId);
      this.db.run("UPDATE im_human_memberships SET role = 'owner' WHERE conversation_id = ? AND user_id = ? AND left_at IS NULL", conversationId, nextOwnerUserId);
      this.db.run(
        "UPDATE im_conversations SET owner_user_id = ?, context_epoch = context_epoch + 1, updated_at = ? WHERE id = ?",
        nextOwnerUserId,
        timestamp,
        conversationId
      );
      this.store.audit(null, "im.group-transferred", "im-conversation", conversationId, { previousOwnerUserId: owner.userId, nextOwnerUserId });
    });
    return this.getConversation(conversationId, owner.userId);
  }

  disbandGroup(owner: AuthUser, conversationId: string): string[] {
    const conversation = this.assertOwner(conversationId, owner.userId);
    if (requiredString(conversation.kind) !== "group") throw new AppError(400, "IM_GROUP_REQUIRED", "单聊不能解散");
    const timestamp = now();
    const memberUserIds = this.db.all(
      "SELECT user_id FROM im_human_memberships WHERE conversation_id = ? AND left_at IS NULL",
      conversationId
    ).map((membership) => requiredString(membership.user_id));
    this.db.transaction(() => {
      this.cancelActiveChain(conversationId, "group_disbanded");
      this.captureConversationAvatarVersions(conversationId, timestamp);
      const participants = this.frozenParticipantSnapshot(conversationId, owner.userId);
      const sequence = this.nextSequence(conversationId) - 1;
      const conversationSnapshot = JSON.stringify({
        ownerUserId: requiredString(conversation.owner_user_id),
        title: requiredString(conversation.title),
        replyMode: requiredString(conversation.reply_mode),
        responseThreshold: Number(conversation.response_threshold),
        maxAiMessages: Number(conversation.max_ai_messages),
        contextEpoch: Number(conversation.context_epoch),
        status: "disbanded",
        participants,
        updatedAt: timestamp
      });
      this.db.run(
        `UPDATE im_human_memberships
         SET left_sequence = ?, left_at = ?, conversation_snapshot_json = ?
         WHERE conversation_id = ? AND left_at IS NULL`,
        sequence,
        timestamp,
        conversationSnapshot,
        conversationId
      );
      this.db.run(
        `UPDATE im_conversations SET status = 'disbanded', context_epoch = context_epoch + 1,
         disbanded_at = ?, updated_at = ? WHERE id = ?`,
        timestamp,
        timestamp,
        conversationId
      );
      this.store.audit(null, "im.group-disbanded", "im-conversation", conversationId);
    });
    return memberUserIds;
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
    const mentions = parseImMentions(content);
    if (mentions.length > IM_MAX_MENTIONS_PER_MESSAGE) {
      throw new AppError(400, "IM_MENTION_LIMIT_EXCEEDED", `单条 IM 消息最多允许 ${IM_MAX_MENTIONS_PER_MESSAGE} 个 mention`);
    }
    const userIds = [...new Set(mentions.filter((mention) => mention.kind === "user").map((mention) => mention.id))];
    const characterIds = [...new Set(mentions.filter((mention) => mention.kind === "character").map((mention) => mention.id))];
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
    const result: Array<ImMention & { snapshot: Record<string, unknown>; membershipId?: string }> = [];
    for (const mention of mentions) {
      if (mention.kind === "user") {
        const row = users.get(mention.id);
        if (row) result.push({ ...mention, snapshot: {
          userId: requiredString(row.id),
          username: requiredString(row.username),
          displayName: requiredString(row.display_name),
          avatarUrl: row.avatar_sha256
            ? `/api/user-avatars/${encodeURIComponent(requiredString(row.id))}?v=${encodeURIComponent(requiredString(row.avatar_sha256))}`
            : null,
          avatarSha256: optionalString(row.avatar_sha256)
        } });
        continue;
      }
      const row = characters.get(mention.id);
      if (row) result.push({
        ...mention,
        membershipId: requiredString(row.id),
        snapshot: json<Record<string, unknown>>(requiredString(row.snapshot_json), {})
      });
    }
    if (result.length !== mentions.length) {
      throw new AppError(400, "IM_MENTION_TARGET_INVALID", "消息包含已经离开或不可用的 mention 目标，请重新选择群成员");
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

  sendMessage(user: AuthUser, conversationId: string, input: ImMessageInput, beforeCreate?: () => void): Record<string, unknown> {
    const conversation = this.assertActiveMembership(conversationId, user.userId);
    this.refreshCharacterAvailability(conversationId);
    const existing = this.db.get(
      "SELECT * FROM im_messages WHERE conversation_id = ? AND request_id = ?",
      conversationId,
      input.requestId
    );
    if (existing) {
      const membership = this.activeMembership(conversationId, user.userId);
      const sameRequest = requiredString(existing.sender_kind) === "human"
        && requiredString(existing.sender_user_id) === user.userId
        && requiredString(existing.content) === input.content
        && membership
        && Number(existing.sequence) > Number(membership.joined_sequence);
      if (!sameRequest) throw new AppError(409, "IM_REQUEST_ID_CONFLICT", "请求标识已被其他 IM 消息、其他成员或不同内容使用");
      const existingChainId = optionalString(existing.chain_id);
      const chain = existingChainId ? this.db.get("SELECT * FROM im_chains WHERE id = ?", existingChainId) ?? null : null;
      return { message: this.mapMessage(existing), chain, duplicate: true };
    }
    const activeCharacters = this.db.all(
      `SELECT * FROM im_character_memberships
       WHERE conversation_id = ? AND left_at IS NULL AND status = 'active' AND character_id IS NOT NULL`,
      conversationId
    );
    if (activeCharacters.length === 0) {
      throw new AppError(409, "IM_CHARACTER_UNAVAILABLE", "当前 IM 会话没有可用的 AI 角色，无法发送消息");
    }
    const mentions = this.validatedMentions(conversationId, input.content);
    beforeCreate?.();
    const settings = this.getSettings(user.userId);
    const messageId = id("imMessage");
    const chainId = id("imChain");
    const timestamp = now();
    return this.db.transaction(() => {
      this.cancelActiveChain(conversationId, "human_message_received");
      this.captureHumanAvatarVersion(conversationId, user.userId, timestamp);
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

  publishAnnouncement(owner: AuthUser, conversationId: string, input: ImMessageInput): Record<string, unknown> {
    const conversation = this.assertOwner(conversationId, owner.userId);
    if (requiredString(conversation.kind) !== "group") throw new AppError(400, "IM_GROUP_REQUIRED", "单聊不能发布旁白公告");
    this.refreshCharacterAvailability(conversationId);
    const existing = this.db.get(
      "SELECT * FROM im_messages WHERE conversation_id = ? AND request_id = ?",
      conversationId,
      input.requestId
    );
    if (existing) {
      const metadata = json<Record<string, unknown>>(requiredString(existing.metadata_json), {});
      const publishedBy = metadata.publishedBy && typeof metadata.publishedBy === "object" && !Array.isArray(metadata.publishedBy)
        ? metadata.publishedBy as Record<string, unknown>
        : {};
      if (
        metadata.type !== "announcement"
        || requiredString(existing.sender_kind) !== "system"
        || requiredString(existing.content) !== input.content
        || requiredString(publishedBy.userId) !== owner.userId
      ) {
        throw new AppError(409, "IM_REQUEST_ID_CONFLICT", "请求标识已被其他 IM 消息使用");
      }
      return { message: this.mapMessage(existing), chain: null, duplicate: true };
    }
    const messageId = id("imMessage");
    const timestamp = now();
    return this.db.transaction(() => {
      const sequence = this.nextSequence(conversationId);
      this.db.run(
        `INSERT INTO im_messages (
           id, conversation_id, sequence, context_epoch, sender_kind, sender_snapshot_json,
           content, request_id, metadata_json, created_at
         ) VALUES (?, ?, ?, ?, 'system', ?, ?, ?, ?, ?)`,
        messageId,
        conversationId,
        sequence,
        Number(conversation.context_epoch),
        JSON.stringify({ name: "旁白" }),
        input.content,
        input.requestId,
        JSON.stringify({ type: "announcement", publishedBy: this.humanSnapshot(owner) }),
        timestamp
      );
      const activeCharacters = this.db.all(
        `SELECT id FROM im_character_memberships
         WHERE conversation_id = ? AND left_at IS NULL AND status = 'active' AND character_id IS NOT NULL`,
        conversationId
      );
      for (const membership of activeCharacters) {
        this.db.run(
          "INSERT INTO im_message_deliveries (message_id, character_membership_id, delivered_at) VALUES (?, ?, ?)",
          messageId,
          requiredString(membership.id),
          timestamp
        );
      }
      this.db.run("UPDATE im_conversations SET updated_at = ? WHERE id = ?", timestamp, conversationId);
      this.store.audit(null, "im.announcement-published", "im-message", messageId, {
        conversationId,
        sequence,
        deliveredCharacterCount: activeCharacters.length
      });
      const message = this.db.get("SELECT * FROM im_messages WHERE id = ?", messageId);
      if (!message) throw notFound("IM 公告");
      return { message: this.mapMessage(message), chain: null, duplicate: false };
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

  retryChain(user: AuthUser, conversationId: string, sourceChainId: string, beforeCreate?: () => void): Record<string, unknown> {
    const conversation = this.assertActiveMembership(conversationId, user.userId);
    const source = this.db.get("SELECT * FROM im_chains WHERE id = ? AND conversation_id = ?", sourceChainId, conversationId);
    if (!source) throw notFound("IM 交流链");
    const triggerMessageId = requiredString(source.trigger_message_id);
    const trigger = this.db.get(
      `SELECT message.id, message.context_epoch FROM im_messages message
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
    if (Number(trigger.context_epoch) !== Number(conversation.context_epoch)) {
      throw new AppError(409, "IM_CHAIN_CONTEXT_CHANGED", "群成员或上下文已经变化，不能重试旧上下文中的交流链");
    }
    const existingRetry = this.db.get(
      `SELECT * FROM im_chains
       WHERE conversation_id = ? AND retry_source_chain_id = ?`,
      conversationId,
      sourceChainId
    );
    if (existingRetry) return existingRetry;
    if (!["failed", "interrupted", "waiting_config"].includes(requiredString(source.status))) {
      throw new AppError(409, "IM_CHAIN_NOT_RETRYABLE", "只有失败、中断或等待模型配置的 IM 交流链可以重试");
    }
    const settings = this.getSettings(user.userId);
    const chainId = id("imChain");
    const timestamp = now();
    const mode = requiredString(conversation.kind) === "direct"
      ? "direct"
      : requiredString(conversation.reply_mode) === "proactive" ? "proactive" : "mention";
    beforeCreate?.();
    return this.db.transaction(() => {
      this.cancelActiveChain(conversationId, "manual_retry");
      const configured = Boolean(settings.primaryModelId && settings.fallbackModelId);
      this.db.run(
        `INSERT INTO im_chains (
           id, conversation_id, initiator_user_id, authorization_user_id, trigger_message_id, retry_source_chain_id,
           mode, threshold, max_ai_messages, retry_count, primary_model_id, fallback_model_id,
           status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        chainId,
        conversationId,
        user.userId,
        requiredString(conversation.owner_user_id),
        triggerMessageId,
        sourceChainId,
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
