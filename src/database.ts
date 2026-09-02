import { chmodSync, existsSync, mkdirSync, readFileSync, statfsSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  DEFAULT_AI_ANALYSIS_TIMEOUT_SECONDS,
  MAX_AI_ANALYSIS_TIMEOUT_SECONDS,
  MIN_AI_ANALYSIS_TIMEOUT_SECONDS
} from "./ai-analysis-timeout.js";
import { documentParagraphLineRanges } from "./hybrid-search.js";
import { logger, sanitizeError } from "./logger.js";
import { documentShortSearchTerms, id, normalizeDocumentSearchText, splitDocumentParagraphs } from "./utils.js";
import {
  createChapterLineIds,
  parseChapterAnnotationLineHashes,
  parseChapterLineIds
} from "./chapter-annotation-anchor.js";

export type Row = Record<string, unknown>;
export const PLATFORM_AI_WORK_ID = "__scriverse_platform_ai__";
export const SYSTEM_USER_ID = "__scriverse_system_user__";
// 版本 81 用于列表查询索引；版本 82 由 Store 写入实体版本基线标记；版本 83 创建协作状态表；版本 84 创建备份加密表；版本 85 持久化协作变更动作；版本 86 扩展直接图片上传格式；版本 87 增加作品与分卷回收站；版本 88 持久化 AI 对话分支幂等键；版本 89 持久化 AI 对话流请求锁与幂等状态；版本 90 持久化 AI 连通性测试冷却状态；版本 91 建立章节段落行号索引；版本 92 增加 AI 对话收藏状态；版本 93 优化伏笔计划回收章节查询；版本 94 增加模型思考强度；版本 95 增加供应商最大输出参数选择；版本 96 扩展模型思考强度档位；版本 97 增加人物性别字段；版本 98 增加正文稳定等待配置；版本 99 持久化关系扮演中的用户角色；版本 100 增加平台 AI 流事件空闲超时配置；版本 101 将平台 AI 流事件空闲超时上限提升至 600 秒；版本 102 创建角色头像元数据表；版本 103 回填历史 AI 对话归属并建立用户列表索引；版本 104 扩大供应商协议约束以支持 OpenAI Responses；版本 105 增加独立分卷剧情顺序；版本 106 增加供应商思考类型配置；版本 107 增加 AI Cache Write 输入 Token 统计；版本 108 增加作品 AI 每月 Token 额度；版本 109 增加供应商日、月 Token 额度；版本 110 将日、月 Token 额度下限调整为大于 0；版本 111 扩展模型思考强度为 auto；版本 112 为 CLI API Key 增加可复制的加密密文；版本 113 增加角色收藏状态与列表索引；版本 114 增加组织、设定档案与想法收藏状态及列表索引；版本 115 增加 AI 对话会话级场景钉；版本 116 增加可持久化且可撤销的 Desktop Bearer 会话；版本 117 增加作品离线授权、同步变更游标与幂等变更结果；版本 118 增加供应商分析请求超时配置；版本 119 记录分析任务是否由 API Key 创建；版本 120 将书籍资料收藏按用户隔离并增加书籍级共享置顶；版本 121 强制作品 Owner 非空并建立用户外键约束；版本 122 创建 AI 写入审批与持久化提问表，并增加按角色归属的共享角色扮演记忆及作品级正文编辑偏好；版本 123 为正文评论持久化逐行哈希锚点；版本 124 为正文行和评论锚点持久化稳定行身份；版本 125 增加显式语义检索配置、分片索引、模型类型与上下文快照；版本 126 为作品增加加密的远程 MCP 配置与工具目录；版本 127 创建跨作品 IM 会话、成员、消息、角色上下文与 AI 链路状态；版本 128 为退出成员冻结会话快照；版本 129 持久化 IM 历史头像版本；版本 130 为 IM 手动重试增加幂等来源；版本 131 限定迁移期回填已有 IM 头像版本；版本 132 优化 IM 会话成员范围查询；版本 133 优化 IM 历史头像授权查询。
export const ENTITY_VERSION_BASELINE_MIGRATION_VERSION = 82;
export const DATABASE_SCHEMA_VERSION = 133;
export const SQLITE_IOERR_SHMSIZE = 4874;

const IM_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS im_user_settings (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    preferred_name TEXT NOT NULL DEFAULT '' CHECK(length(preferred_name) <= 80),
    pronouns TEXT NOT NULL DEFAULT '' CHECK(length(pronouns) <= 80),
    identity_summary TEXT NOT NULL DEFAULT '' CHECK(length(identity_summary) <= 2000),
    additional_notes TEXT NOT NULL DEFAULT '' CHECK(length(additional_notes) <= 4000),
    primary_model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
    fallback_model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
    retry_count INTEGER NOT NULL DEFAULT 3 CHECK(retry_count BETWEEN 1 AND 20),
    updated_at TEXT NOT NULL,
    CHECK(primary_model_id IS NULL OR fallback_model_id IS NULL OR primary_model_id <> fallback_model_id)
  );

  CREATE TABLE IF NOT EXISTS im_conversations (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('direct', 'group')),
    owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    direct_character_id TEXT,
    title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 80),
    reply_mode TEXT NOT NULL DEFAULT 'mention' CHECK(reply_mode IN ('mention', 'proactive')),
    response_threshold INTEGER NOT NULL DEFAULT 60 CHECK(response_threshold BETWEEN 0 AND 100),
    max_ai_messages INTEGER NOT NULL DEFAULT 20 CHECK(max_ai_messages BETWEEN 1 AND 100),
    context_epoch INTEGER NOT NULL DEFAULT 1 CHECK(context_epoch > 0),
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disbanded')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    disbanded_at TEXT,
    UNIQUE(owner_user_id, direct_character_id),
    CHECK((kind = 'direct' AND direct_character_id IS NOT NULL) OR (kind = 'group' AND direct_character_id IS NULL))
  );

  CREATE TABLE IF NOT EXISTS im_human_memberships (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES im_conversations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('owner', 'member')),
    joined_sequence INTEGER NOT NULL DEFAULT 0 CHECK(joined_sequence >= 0),
    left_sequence INTEGER CHECK(left_sequence IS NULL OR left_sequence >= joined_sequence),
    last_read_sequence INTEGER NOT NULL DEFAULT 0 CHECK(last_read_sequence >= 0),
    conversation_snapshot_json TEXT CHECK(conversation_snapshot_json IS NULL OR (json_valid(conversation_snapshot_json) AND json_type(conversation_snapshot_json) = 'object')),
    joined_at TEXT NOT NULL,
    left_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_im_human_memberships_active
    ON im_human_memberships(conversation_id, user_id) WHERE left_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_im_human_memberships_user
    ON im_human_memberships(user_id, left_at, conversation_id);
  CREATE INDEX IF NOT EXISTS idx_im_human_memberships_conversation
    ON im_human_memberships(conversation_id, joined_at, id);

  CREATE TABLE IF NOT EXISTS im_character_memberships (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES im_conversations(id) ON DELETE CASCADE,
    character_id TEXT REFERENCES characters(id) ON DELETE SET NULL,
    source_work_id TEXT REFERENCES works(id) ON DELETE SET NULL,
    snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json) AND json_type(snapshot_json) = 'object'),
    joined_sequence INTEGER NOT NULL DEFAULT 0 CHECK(joined_sequence >= 0),
    left_sequence INTEGER CHECK(left_sequence IS NULL OR left_sequence >= joined_sequence),
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'suspended', 'removed')),
    joined_at TEXT NOT NULL,
    left_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_im_character_memberships_active
    ON im_character_memberships(conversation_id, character_id) WHERE left_at IS NULL AND character_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_im_character_memberships_character
    ON im_character_memberships(character_id, left_at, conversation_id);
  CREATE INDEX IF NOT EXISTS idx_im_character_memberships_conversation
    ON im_character_memberships(conversation_id, joined_at, id);

  CREATE TABLE IF NOT EXISTS im_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES im_conversations(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL CHECK(sequence > 0),
    context_epoch INTEGER NOT NULL DEFAULT 1 CHECK(context_epoch > 0),
    sender_kind TEXT NOT NULL CHECK(sender_kind IN ('human', 'character', 'system')),
    sender_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    sender_character_id TEXT REFERENCES characters(id) ON DELETE SET NULL,
    sender_snapshot_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(sender_snapshot_json) AND json_type(sender_snapshot_json) = 'object'),
    content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 20000),
    chain_id TEXT,
    request_id TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
    created_at TEXT NOT NULL,
    UNIQUE(conversation_id, sequence),
    UNIQUE(conversation_id, request_id),
    CHECK(
      (sender_kind = 'human' AND sender_user_id IS NOT NULL AND sender_character_id IS NULL)
      OR (sender_kind = 'character' AND sender_user_id IS NULL)
      OR (sender_kind = 'system' AND sender_user_id IS NULL AND sender_character_id IS NULL)
    )
  );
  CREATE INDEX IF NOT EXISTS idx_im_messages_conversation
    ON im_messages(conversation_id, sequence DESC);
  CREATE INDEX IF NOT EXISTS idx_im_messages_human_avatar
    ON im_messages(conversation_id, sender_user_id, sequence) WHERE sender_kind = 'human';
  CREATE INDEX IF NOT EXISTS idx_im_messages_character_avatar
    ON im_messages(conversation_id, sender_character_id, sequence) WHERE sender_kind = 'character';
  CREATE INDEX IF NOT EXISTS idx_im_messages_character_snapshot_avatar
    ON im_messages(conversation_id, json_extract(sender_snapshot_json, '$.id'), sequence)
    WHERE sender_kind = 'character' AND sender_character_id IS NULL;

  CREATE TABLE IF NOT EXISTS im_mentions (
    message_id TEXT NOT NULL REFERENCES im_messages(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK(position >= 0),
    target_kind TEXT NOT NULL CHECK(target_kind IN ('character', 'user')),
    target_id TEXT NOT NULL,
    target_snapshot_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(target_snapshot_json) AND json_type(target_snapshot_json) = 'object'),
    PRIMARY KEY(message_id, position)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_im_mentions_target
    ON im_mentions(target_kind, target_id, message_id);

  CREATE TABLE IF NOT EXISTS im_message_deliveries (
    message_id TEXT NOT NULL REFERENCES im_messages(id) ON DELETE CASCADE,
    character_membership_id TEXT NOT NULL REFERENCES im_character_memberships(id) ON DELETE CASCADE,
    delivered_at TEXT NOT NULL,
    PRIMARY KEY(message_id, character_membership_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_im_message_deliveries_character
    ON im_message_deliveries(character_membership_id, message_id);

  CREATE TABLE IF NOT EXISTS im_character_contexts (
    character_membership_id TEXT NOT NULL REFERENCES im_character_memberships(id) ON DELETE CASCADE,
    context_epoch INTEGER NOT NULL CHECK(context_epoch > 0),
    summary TEXT NOT NULL DEFAULT '',
    summarized_through_sequence INTEGER NOT NULL DEFAULT 0 CHECK(summarized_through_sequence >= 0),
    updated_at TEXT NOT NULL,
    PRIMARY KEY(character_membership_id, context_epoch)
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS im_chains (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES im_conversations(id) ON DELETE CASCADE,
    initiator_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    authorization_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    trigger_message_id TEXT NOT NULL REFERENCES im_messages(id) ON DELETE CASCADE,
    retry_source_chain_id TEXT REFERENCES im_chains(id) ON DELETE SET NULL,
    mode TEXT NOT NULL CHECK(mode IN ('direct', 'mention', 'proactive')),
    threshold INTEGER NOT NULL CHECK(threshold BETWEEN 0 AND 100),
    max_ai_messages INTEGER NOT NULL CHECK(max_ai_messages BETWEEN 1 AND 100),
    retry_count INTEGER NOT NULL CHECK(retry_count BETWEEN 1 AND 20),
    primary_model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
    fallback_model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
    model_stage TEXT NOT NULL DEFAULT 'primary' CHECK(model_stage IN ('primary', 'fallback')),
    status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'waiting_config', 'quiet', 'completed', 'cancelled', 'failed', 'interrupted', 'limit')),
    generated_count INTEGER NOT NULL DEFAULT 0 CHECK(generated_count >= 0),
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_im_chains_active
    ON im_chains(conversation_id) WHERE status IN ('queued', 'running', 'waiting_config');
  CREATE INDEX IF NOT EXISTS idx_im_chains_initiator
    ON im_chains(initiator_user_id, status, created_at);

  CREATE TABLE IF NOT EXISTS im_chain_turns (
    id TEXT PRIMARY KEY,
    chain_id TEXT NOT NULL REFERENCES im_chains(id) ON DELETE CASCADE,
    character_membership_id TEXT NOT NULL REFERENCES im_character_memberships(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('judge', 'reply', 'compact')),
    score INTEGER CHECK(score IS NULL OR score BETWEEN 0 AND 100),
    selected INTEGER NOT NULL DEFAULT 0 CHECK(selected IN (0, 1)),
    status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'skipped', 'failed', 'cancelled')),
    model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
    model_stage TEXT CHECK(model_stage IS NULL OR model_stage IN ('primary', 'fallback')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
    duration_ms INTEGER CHECK(duration_ms IS NULL OR duration_ms >= 0),
    failure TEXT,
    ai_call_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(ai_call_ids_json) AND json_type(ai_call_ids_json) = 'array'),
    created_at TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_im_chain_turns_chain
    ON im_chain_turns(chain_id, created_at, id);

  CREATE TABLE IF NOT EXISTS im_avatar_versions (
    conversation_id TEXT NOT NULL REFERENCES im_conversations(id) ON DELETE CASCADE,
    participant_kind TEXT NOT NULL CHECK(participant_kind IN ('character', 'user')),
    participant_id TEXT NOT NULL,
    sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
    mime_type TEXT NOT NULL,
    byte_length INTEGER NOT NULL CHECK(byte_length >= 0),
    storage_key TEXT,
    content BLOB,
    width INTEGER NOT NULL CHECK(width > 0),
    height INTEGER NOT NULL CHECK(height > 0),
    created_at TEXT NOT NULL,
    PRIMARY KEY(conversation_id, participant_kind, participant_id, sha256),
    CHECK((participant_kind = 'character' AND storage_key IS NOT NULL AND content IS NULL)
      OR (participant_kind = 'user' AND storage_key IS NULL AND content IS NOT NULL))
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_im_avatar_versions_storage
    ON im_avatar_versions(storage_key) WHERE storage_key IS NOT NULL;
`;

export type AvailableDiskSpace = {
  availableBytes: number;
  availableMiB: number;
};

export function isSqliteDiskIoError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & { code?: unknown; errcode?: unknown; errstr?: unknown };
  return Number(candidate.errcode) === SQLITE_IOERR_SHMSIZE
    || (candidate.code === "ERR_SQLITE_ERROR" && candidate.errstr === "disk I/O error")
    || (candidate.code === "ERR_SQLITE_ERROR" && error.message === "disk I/O error");
}

export function readAvailableDiskSpace(path: string): AvailableDiskSpace | null {
  try {
    const stats = statfsSync(path);
    const availableBytes = Number(stats.bavail) * Number(stats.bsize);
    if (!Number.isFinite(availableBytes) || availableBytes < 0) return null;
    return {
      availableBytes,
      availableMiB: Math.round(availableBytes / (1024 * 1024) * 100) / 100
    };
  } catch {
    return null;
  }
}

export function logSqliteDiskIoError(filename: string, error: unknown): void {
  if (!isSqliteDiskIoError(error)) return;
  const diskSpace = readAvailableDiskSpace(filename === ":memory:" ? "." : dirname(filename));
  logger.error("database.disk_io_error.space_check", {
    databasePath: filename,
    availableBytes: diskSpace?.availableBytes ?? null,
    availableMiB: diskSpace?.availableMiB ?? null,
    spaceCheck: diskSpace ? "completed" : "failed"
  });
  logger.error("database.disk_io_error.guidance", {
    databasePath: filename,
    message: "SQLite reported a disk I/O error. Check the host disk's available space and ensure the database directory is writable before restarting Scriverse."
  });
}
export function readDatabaseSchemaVersion(filename: string): number | null {
  if (!existsSync(filename)) return null;
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(filename, { readOnly: true });
    const migrationTable = database.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
    ).get();
    if (!migrationTable) return 0;
    const row = database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version?: unknown } | undefined;
    return Number(row?.version ?? 0);
  } catch (error) {
    logSqliteDiskIoError(filename, error);
    throw error;
  } finally {
    database?.close();
  }
}

export class Database {
  readonly raw: DatabaseSync;

  constructor(readonly filename: string) {
    logger.info("database.opening", { databasePath: filename, inMemory: filename === ":memory:" });
    try {
      if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
      this.raw = new DatabaseSync(filename);
      this.raw.exec("PRAGMA foreign_keys = ON");
      this.raw.exec("PRAGMA busy_timeout = 5000");
      if (filename !== ":memory:") this.raw.exec("PRAGMA journal_mode = WAL");
      this.migrate();
      this.recoverInterruptedOperations();
      if (filename !== ":memory:") {
        for (const path of [filename, `${filename}-wal`, `${filename}-shm`]) {
          if (existsSync(path)) chmodSync(path, 0o600);
        }
      }
      const migration = this.get<{ version: number }>("SELECT MAX(version) AS version FROM schema_migrations");
      logger.info("database.ready", { inMemory: filename === ":memory:", schemaVersion: Number(migration?.version ?? 0) });
    } catch (error) {
      logSqliteDiskIoError(filename, error);
      logger.error("database.open_failed", { databasePath: filename, error: sanitizeError(error) });
      throw error;
    }
  }

  close(): void {
    logger.info("database.closing");
    this.raw.close();
    logger.info("database.closed");
  }

  createSnapshotBuffer(): Buffer {
    if (this.filename === ":memory:") throw new Error("内存数据库不能创建文件快照");
    if (this.raw.isTransaction) throw new Error("事务执行期间不能创建数据库快照");
    // 项目只使用当前这一条同步连接；截断 WAL 后立即同步读取主库，期间不会穿插其他写入。
    const checkpoint = this.get<{ busy: number; log: number; checkpointed: number }>("PRAGMA wal_checkpoint(TRUNCATE)");
    if (Number(checkpoint?.busy ?? 0) !== 0 || Number(checkpoint?.log ?? 0) !== Number(checkpoint?.checkpointed ?? 0)) {
      throw new Error("数据库 WAL 尚未完整合并，无法创建一致性快照");
    }
    return readFileSync(this.filename);
  }

  run(sql: string, ...params: SQLInputValue[]): { changes: number; lastInsertRowid: number | bigint } {
    const result = this.raw.prepare(sql).run(...params);
    return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
  }

  get<T extends Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  all<T extends Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  transaction<T>(operation: () => T): T {
    if (this.raw.isTransaction) return operation();
    const startedAt = process.hrtime.bigint();
    logger.debug("database.transaction.started");
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.raw.exec("COMMIT");
      logger.debug("database.transaction.committed", { durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000 });
      return result;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      logger.warn("database.transaction.rolled_back", {
        durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
        error: sanitizeError(error)
      });
      throw error;
    }
  }

  rollbackTransaction<T>(operation: () => T): T {
    if (this.raw.isTransaction) throw new Error("Rollback-only transaction cannot be nested");
    const startedAt = process.hrtime.bigint();
    logger.debug("database.rollback_transaction.started");
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.raw.exec("ROLLBACK");
      logger.debug("database.rollback_transaction.completed", {
        durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000
      });
      return result;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      logger.warn("database.rollback_transaction.failed", {
        durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
        error: sanitizeError(error)
      });
      throw error;
    }
  }

  private migrate(): void {
    this.raw.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS works (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        author TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        language TEXT NOT NULL DEFAULT 'zh-CN',
        cover_url TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]',
        is_internal INTEGER NOT NULL DEFAULT 0,
        offline_access_enabled INTEGER NOT NULL DEFAULT 0 CHECK(offline_access_enabled IN (0, 1)),
        editor_auto_indent_enabled INTEGER NOT NULL DEFAULT 0 CHECK(editor_auto_indent_enabled IN (0, 1)),
        editor_typewriter_mode_enabled INTEGER NOT NULL DEFAULT 0 CHECK(editor_typewriter_mode_enabled IN (0, 1)),
        version_no INTEGER NOT NULL DEFAULT 1,
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS file_versions (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        file_name TEXT NOT NULL,
        file_type TEXT NOT NULL,
        word_count INTEGER NOT NULL,
        paragraph_count INTEGER NOT NULL,
        warnings_json TEXT NOT NULL DEFAULT '[]',
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS volumes (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'main',
        source TEXT NOT NULL DEFAULT 'manual',
        description TEXT NOT NULL DEFAULT '',
        keywords_json TEXT NOT NULL DEFAULT '[]',
        sort_order INTEGER NOT NULL,
        story_order INTEGER NOT NULL DEFAULT 0,
        version_no INTEGER NOT NULL DEFAULT 1,
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chapters (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        volume_id TEXT NOT NULL REFERENCES volumes(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        chapter_type TEXT NOT NULL DEFAULT '正文' CHECK(chapter_type IN ('正文', '设定', '作者的话', '其他')),
        sort_order INTEGER NOT NULL,
        word_count INTEGER NOT NULL DEFAULT 0,
        version_no INTEGER NOT NULL DEFAULT 1,
        analysis_status TEXT NOT NULL DEFAULT 'pending',
        excluded_from_analysis INTEGER NOT NULL DEFAULT 0,
        deleted_at TEXT,
        deleted_via_volume_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chapter_versions (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        chapter_id TEXT NOT NULL,
        version_no INTEGER NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        volume_id TEXT,
        sort_order INTEGER,
        chapter_type TEXT,
        source TEXT NOT NULL DEFAULT 'manual',
        source_ref TEXT,
        change_note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        created_by_user_id TEXT,
        UNIQUE(chapter_id, version_no)
      );

      CREATE TABLE IF NOT EXISTS chapter_insights (
        id TEXT PRIMARY KEY,
        chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
        chapter_version INTEGER NOT NULL,
        summary TEXT NOT NULL,
        events_json TEXT NOT NULL DEFAULT '[]',
        characters_json TEXT NOT NULL DEFAULT '[]',
        settings_json TEXT NOT NULL DEFAULT '[]',
        evidence_json TEXT NOT NULL DEFAULT '[]',
        uncertainties_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'review',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        content TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'draft',
        locked INTEGER NOT NULL DEFAULT 0,
        is_favorite INTEGER NOT NULL DEFAULT 0 CHECK(is_favorite IN (0, 1)),
        evidence_json TEXT NOT NULL DEFAULT '[]',
        scope_json TEXT NOT NULL DEFAULT '{}',
        author_note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS drafts (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        draft_type TEXT NOT NULL CHECK(draft_type IN ('prose', 'setting')),
        volume_id TEXT REFERENCES volumes(id) ON DELETE SET NULL,
        setting_module TEXT,
        title TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        is_favorite INTEGER NOT NULL DEFAULT 0 CHECK(is_favorite IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK(setting_module IS NULL OR setting_module IN ('settings', 'characters', 'races', 'organizations', 'timeline', 'relationships', 'outlines')),
        CHECK((draft_type = 'prose' AND setting_module IS NULL) OR (draft_type = 'setting' AND volume_id IS NULL))
      );

      CREATE TABLE IF NOT EXISTS races (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        parent_race_id TEXT REFERENCES races(id) ON DELETE RESTRICT,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        is_extinct INTEGER NOT NULL DEFAULT 0 CHECK(is_extinct IN (0, 1)),
        settings_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(work_id, normalized_name)
      );

      CREATE TABLE IF NOT EXISTS characters (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        code TEXT NOT NULL DEFAULT '',
        gender TEXT NOT NULL DEFAULT 'unknown' CHECK(gender IN ('male', 'female', 'none', 'unknown')),
        aliases_json TEXT NOT NULL DEFAULT '[]',
        species TEXT NOT NULL DEFAULT '',
        race_id TEXT REFERENCES races(id) ON DELETE SET NULL,
        attributes_json TEXT NOT NULL DEFAULT '{}',
        profile_json TEXT NOT NULL DEFAULT '{}',
        current_state_json TEXT NOT NULL DEFAULT '{}',
        is_dead INTEGER NOT NULL DEFAULT 0 CHECK(is_dead IN (0, 1)),
        is_favorite INTEGER NOT NULL DEFAULT 0 CHECK(is_favorite IN (0, 1)),
        locked_fields_json TEXT NOT NULL DEFAULT '[]',
        first_chapter_id TEXT REFERENCES chapters(id) ON DELETE SET NULL,
        merged_into_character_id TEXT,
        merged_at TEXT,
        version_no INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS character_versions (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        character_id TEXT NOT NULL,
        version_no INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'manual',
        source_ref TEXT,
        change_note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        created_by_user_id TEXT,
        UNIQUE(character_id, version_no)
      );

      CREATE TABLE IF NOT EXISTS entity_versions (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        version_no INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'manual',
        source_ref TEXT,
        change_note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        UNIQUE(entity_type, entity_id, version_no)
      );

      CREATE TABLE IF NOT EXISTS timeline_tracks (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(work_id, name)
      );

      CREATE TABLE IF NOT EXISTS timeline_events (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        track_id TEXT REFERENCES timeline_tracks(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        event_type TEXT NOT NULL DEFAULT 'other',
        time_label TEXT NOT NULL DEFAULT '时间待定',
        time_sort REAL,
        chapter_ids_json TEXT NOT NULL DEFAULT '[]',
        participant_ids_json TEXT NOT NULL DEFAULT '[]',
        location TEXT NOT NULL DEFAULT '',
        causes_json TEXT NOT NULL DEFAULT '[]',
        impact_scope TEXT NOT NULL DEFAULT 'personal',
        evidence_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'candidate',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS relationships (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        from_character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        to_character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        category TEXT NOT NULL,
        subtype TEXT NOT NULL DEFAULT '',
        keywords_json TEXT NOT NULL DEFAULT '[]',
        directed INTEGER NOT NULL DEFAULT 0,
        current_status TEXT NOT NULL DEFAULT 'active',
        time_range_json TEXT NOT NULL DEFAULT '{}',
        confidence REAL NOT NULL DEFAULT 0.5,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        confirmation_status TEXT NOT NULL DEFAULT 'pending',
        locked INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK(from_character_id <> to_character_id)
      );

      CREATE TABLE IF NOT EXISTS review_items (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        item_type TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'medium',
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        entity_refs_json TEXT NOT NULL DEFAULT '[]',
        evidence_json TEXT NOT NULL DEFAULT '[]',
        suggestion TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        resolution_note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS character_merges (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        source_character_id TEXT NOT NULL UNIQUE,
        target_character_id TEXT NOT NULL,
        review_id TEXT REFERENCES review_items(id) ON DELETE SET NULL,
        source_snapshot_json TEXT NOT NULL,
        target_snapshot_json TEXT NOT NULL,
        reference_snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by_user_id TEXT
      );

      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        protocol TEXT NOT NULL DEFAULT 'openai-chat-completions' CHECK(protocol IN ('openai-chat-completions', 'anthropic-messages', 'google-vertex')),
        encrypted_key TEXT NOT NULL,
        key_iv TEXT NOT NULL,
        key_tag TEXT NOT NULL,
        key_hint TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'disabled',
        connection_status TEXT NOT NULL DEFAULT 'unchecked',
        concurrency_limit INTEGER NOT NULL DEFAULT 10 CHECK(concurrency_limit BETWEEN 1 AND 100),
        rpm_limit INTEGER NOT NULL DEFAULT 10 CHECK(rpm_limit BETWEEN 1 AND 10000),
        analysis_timeout_seconds INTEGER NOT NULL DEFAULT ${DEFAULT_AI_ANALYSIS_TIMEOUT_SECONDS} CHECK(analysis_timeout_seconds BETWEEN ${MIN_AI_ANALYSIS_TIMEOUT_SECONDS} AND ${MAX_AI_ANALYSIS_TIMEOUT_SECONDS}),
        daily_token_quota INTEGER CHECK(daily_token_quota IS NULL OR daily_token_quota >= 1),
        monthly_token_quota INTEGER CHECK(monthly_token_quota IS NULL OR monthly_token_quota >= 1),
        max_tokens INTEGER NOT NULL DEFAULT 32000 CHECK(max_tokens BETWEEN 1 AND 32768),
        max_tokens_parameter TEXT NOT NULL DEFAULT 'max_tokens' CHECK(max_tokens_parameter IN ('max_tokens', 'max_completion_tokens')),
        thinking_type TEXT NOT NULL DEFAULT 'enabled' CHECK(thinking_type IN ('enabled', 'adaptive')),
        default_model_id TEXT,
        note TEXT NOT NULL DEFAULT '',
        last_error TEXT,
        last_success_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS models (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        display_name TEXT NOT NULL,
        model_id TEXT NOT NULL,
        purposes_json TEXT NOT NULL DEFAULT '[]',
        context_note TEXT NOT NULL DEFAULT '',
        context_window INTEGER NOT NULL DEFAULT 128000 CHECK(context_window BETWEEN 1024 AND 2000000),
        output_note TEXT NOT NULL DEFAULT '',
        preset_json TEXT NOT NULL DEFAULT '{}',
        thinking_enabled INTEGER NOT NULL DEFAULT 1,
        thinking_effort TEXT NOT NULL DEFAULT 'default' CHECK(thinking_effort IN ('default', 'auto', 'low', 'medium', 'high', 'xhigh', 'max')),
        multimodal_enabled INTEGER NOT NULL DEFAULT 0 CHECK(multimodal_enabled IN (0, 1)),
        enabled INTEGER NOT NULL DEFAULT 1,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(provider_id, model_id)
      );

      CREATE TABLE IF NOT EXISTS ai_connectivity_test_states (
        object_type TEXT NOT NULL CHECK(object_type IN ('provider', 'model')),
        object_id TEXT NOT NULL,
        config_fingerprint TEXT NOT NULL CHECK(length(config_fingerprint) = 64),
        state TEXT NOT NULL CHECK(state IN ('in_progress', 'success', 'failure')),
        attempt_id TEXT NOT NULL,
        retry_at_ms INTEGER NOT NULL CHECK(retry_at_ms >= 0),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(object_type, object_id)
      );
      CREATE INDEX IF NOT EXISTS idx_ai_connectivity_test_states_retry_at ON ai_connectivity_test_states(retry_at_ms);
      CREATE TRIGGER IF NOT EXISTS ai_connectivity_test_states_provider_delete
      AFTER DELETE ON providers BEGIN
        DELETE FROM ai_connectivity_test_states WHERE object_type = 'provider' AND object_id = OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS ai_connectivity_test_states_model_delete
      AFTER DELETE ON models BEGIN
        DELETE FROM ai_connectivity_test_states WHERE object_type = 'model' AND object_id = OLD.id;
      END;

      CREATE TABLE IF NOT EXISTS task_defaults (
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        task_type TEXT NOT NULL,
        model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
        PRIMARY KEY(work_id, task_type)
      );

      CREATE TABLE IF NOT EXISTS platform_ai_settings (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        system_prompt TEXT NOT NULL DEFAULT '',
        image_tool_model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
        stream_idle_timeout_seconds INTEGER NOT NULL DEFAULT 90 CHECK(stream_idle_timeout_seconds BETWEEN 30 AND 600),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS platform_ui_settings (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        toast_position TEXT NOT NULL DEFAULT 'bottom-right' CHECK(toast_position IN ('bottom-right', 'top-right')),
        page_sizes_json TEXT NOT NULL DEFAULT '{"characters":30,"analysisTasks":30,"fileVersions":30}' CHECK(json_valid(page_sizes_json) AND json_type(page_sizes_json) = 'object'),
        galaxy_frame_rate INTEGER NOT NULL DEFAULT 30 CHECK(galaxy_frame_rate IN (24, 30, 60, 90, 120, 144, 165, 240)),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS work_ai_settings (
        work_id TEXT PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
        system_prompt TEXT NOT NULL DEFAULT '',
        daily_token_quota INTEGER CHECK(daily_token_quota IS NULL OR daily_token_quota >= 1),
        monthly_token_quota INTEGER CHECK(monthly_token_quota IS NULL OR monthly_token_quota >= 1),
        auto_run_enabled INTEGER NOT NULL DEFAULT 0,
        auto_run_concurrency INTEGER NOT NULL DEFAULT 2,
        auto_run_batch_limit INTEGER NOT NULL DEFAULT 20,
        auto_run_daily_task_limit INTEGER NOT NULL DEFAULT 0 CHECK(auto_run_daily_task_limit BETWEEN 0 AND 10000),
        auto_run_failure_threshold INTEGER NOT NULL DEFAULT 3 CHECK(auto_run_failure_threshold BETWEEN 1 AND 10),
        auto_run_paused INTEGER NOT NULL DEFAULT 0 CHECK(auto_run_paused IN (0, 1)),
        auto_run_pause_reason TEXT NOT NULL DEFAULT '',
        auto_run_resume_at TEXT,
        auto_run_consecutive_failures INTEGER NOT NULL DEFAULT 0,
        book_summary_context_percent INTEGER NOT NULL DEFAULT 50 CHECK(book_summary_context_percent BETWEEN 1 AND 90),
        context_compact_threshold INTEGER NOT NULL DEFAULT 85 CHECK(context_compact_threshold BETWEEN 50 AND 90),
        agent_tool_call_limit INTEGER NOT NULL DEFAULT 12 CHECK(agent_tool_call_limit BETWEEN 5 AND 1000),
        agent_tool_call_global_multiplier INTEGER NOT NULL DEFAULT 3 CHECK(agent_tool_call_global_multiplier BETWEEN 1 AND 6),
        agent_tools_json TEXT NOT NULL DEFAULT '["story_index","read_chapters","search_story_entities","grep","read_character_sections","search_drafts","image"]',
        title_generation_model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
        image_tool_model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
        always_include_setting_info INTEGER NOT NULL DEFAULT 0 CHECK(always_include_setting_info IN (0, 1)),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS work_mcp_settings (
        work_id TEXT PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
        config_encrypted TEXT NOT NULL,
        config_iv TEXT NOT NULL,
        config_tag TEXT NOT NULL,
        tool_catalog_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tool_catalog_json) AND json_type(tool_catalog_json) = 'array'),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ai_calls (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES analysis_tasks(id) ON DELETE SET NULL,
        task_type TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        context_scope_json TEXT NOT NULL,
        parameters_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL,
        failure TEXT,
        input_chars INTEGER NOT NULL DEFAULT 0,
        output_chars INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0 CHECK(input_tokens >= 0),
        output_tokens INTEGER NOT NULL DEFAULT 0 CHECK(output_tokens >= 0),
        cached_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK(cached_input_tokens >= 0),
        cache_write_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK(cache_write_input_tokens >= 0),
        cache_eligible_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK(cache_eligible_input_tokens >= 0),
        cache_usage_available INTEGER NOT NULL DEFAULT 0 CHECK(cache_usage_available IN (0, 1)),
        token_usage_source TEXT NOT NULL DEFAULT 'estimated' CHECK(token_usage_source IN ('reported', 'estimated', 'mixed')),
        created_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS ai_suggestions (
        id TEXT PRIMARY KEY,
        call_id TEXT NOT NULL REFERENCES ai_calls(id) ON DELETE CASCADE,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        chapter_id TEXT REFERENCES chapters(id) ON DELETE SET NULL,
        chapter_version INTEGER,
        task_type TEXT NOT NULL,
        instruction TEXT NOT NULL,
        source_text TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        action TEXT NOT NULL DEFAULT 'note',
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        decided_at TEXT
      );

      CREATE TABLE IF NOT EXISTS ai_conversations (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        roleplay_character_id TEXT REFERENCES characters(id) ON DELETE SET NULL,
        roleplay_user_character_id TEXT REFERENCES characters(id) ON DELETE SET NULL,
        task_type TEXT CHECK(task_type IN ('chat', 'roleplay', 'continue', 'polish')),
        context_scope_json TEXT,
        title TEXT NOT NULL DEFAULT '新对话',
        is_favorite INTEGER NOT NULL DEFAULT 0 CHECK(is_favorite IN (0, 1)),
        compacted_summary TEXT NOT NULL DEFAULT '',
        compacted_message_count INTEGER NOT NULL DEFAULT 0,
        context_warning_at TEXT,
        agent_tools_json TEXT,
        injected_entities_json TEXT NOT NULL DEFAULT '{"characters":[],"races":[],"organizations":[]}',
        system_clock_text TEXT NOT NULL DEFAULT '',
        scene_pin_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ai_conversation_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        citations_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        request_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS roleplay_memories (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        category TEXT NOT NULL CHECK(category IN ('event', 'state', 'relationship', 'commitment', 'knowledge', 'scene')),
        content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 2000),
        content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
        importance TEXT NOT NULL DEFAULT 'medium' CHECK(importance IN ('low', 'medium', 'high')),
        certainty TEXT NOT NULL DEFAULT 'experienced' CHECK(certainty IN ('experienced', 'observed', 'heard', 'believed')),
        origin TEXT NOT NULL DEFAULT 'roleplay' CHECK(origin = 'roleplay'),
        canonical INTEGER NOT NULL DEFAULT 0 CHECK(canonical = 0),
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'superseded', 'archived')),
        is_pinned INTEGER NOT NULL DEFAULT 0 CHECK(is_pinned IN (0, 1)),
        version_no INTEGER NOT NULL DEFAULT 1 CHECK(version_no > 0),
        superseded_by_memory_id TEXT REFERENCES roleplay_memories(id) ON DELETE SET NULL,
        source_type TEXT NOT NULL CHECK(source_type IN ('ai', 'manual')),
        source_assistant_message_id TEXT REFERENCES ai_conversation_messages(id) ON DELETE SET NULL,
        idempotency_key TEXT,
        created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(character_id, content_hash),
        UNIQUE(character_id, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS roleplay_memory_sources (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL REFERENCES roleplay_memories(id) ON DELETE CASCADE,
        conversation_id TEXT REFERENCES ai_conversations(id) ON DELETE SET NULL,
        message_id TEXT REFERENCES ai_conversation_messages(id) ON DELETE SET NULL,
        message_role TEXT NOT NULL CHECK(message_role IN ('user', 'assistant')),
        source_created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        source_created_at TEXT NOT NULL,
        evidence_snapshot TEXT NOT NULL CHECK(length(evidence_snapshot) <= 2000),
        created_at TEXT NOT NULL,
        UNIQUE(memory_id, message_id)
      );

      CREATE TABLE IF NOT EXISTS roleplay_memory_versions (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL REFERENCES roleplay_memories(id) ON DELETE CASCADE,
        version_no INTEGER NOT NULL CHECK(version_no > 0),
        category TEXT NOT NULL CHECK(category IN ('event', 'state', 'relationship', 'commitment', 'knowledge', 'scene')),
        content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 2000),
        importance TEXT NOT NULL CHECK(importance IN ('low', 'medium', 'high')),
        certainty TEXT NOT NULL CHECK(certainty IN ('experienced', 'observed', 'heard', 'believed')),
        status TEXT NOT NULL CHECK(status IN ('active', 'superseded', 'archived')),
        is_pinned INTEGER NOT NULL CHECK(is_pinned IN (0, 1)),
        action TEXT NOT NULL CHECK(action IN ('created', 'edited', 'pinned', 'archived', 'restored', 'superseded', 'merged')),
        actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        UNIQUE(memory_id, version_no)
      );

      CREATE TABLE IF NOT EXISTS ai_conversation_stream_requests (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
        actor_scope TEXT NOT NULL CHECK(length(actor_scope) BETWEEN 1 AND 200),
        idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 16 AND 128),
        request_hash TEXT NOT NULL CHECK(length(request_hash) = 64),
        status TEXT NOT NULL CHECK(status IN ('in_progress', 'completed', 'cancelled', 'failed', 'timed_out', 'abandoned')),
        terminal_reason TEXT,
        user_message_id TEXT REFERENCES ai_conversation_messages(id) ON DELETE SET NULL,
        assistant_message_id TEXT REFERENCES ai_conversation_messages(id) ON DELETE SET NULL,
        lease_expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE(actor_scope, work_id, idempotency_key),
        CHECK(
          (status = 'in_progress' AND lease_expires_at IS NOT NULL AND completed_at IS NULL)
          OR (status <> 'in_progress' AND lease_expires_at IS NULL AND completed_at IS NOT NULL)
        )
      );

      CREATE TABLE IF NOT EXISTS ai_conversation_forks (
        source_conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
        source_message_id TEXT NOT NULL REFERENCES ai_conversation_messages(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 1 AND 200),
        conversation_id TEXT NOT NULL UNIQUE REFERENCES ai_conversations(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY(source_conversation_id, request_id)
      );

      CREATE TABLE IF NOT EXISTS analysis_tasks (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
        task_type TEXT NOT NULL,
        scope_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending',
        progress INTEGER NOT NULL DEFAULT 0,
        result_json TEXT NOT NULL DEFAULT '{}',
        failure_json TEXT NOT NULL DEFAULT '[]',
        source_versions_json TEXT NOT NULL DEFAULT '{}',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        last_attempt_at TEXT,
        created_via_api_key INTEGER NOT NULL DEFAULT 0 CHECK(created_via_api_key IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ai_call_traces (
        call_id TEXT PRIMARY KEY REFERENCES ai_calls(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES analysis_tasks(id) ON DELETE CASCADE,
        initial_messages_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(initial_messages_json) AND json_type(initial_messages_json) = 'array'),
        rounds_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(rounds_json) AND json_type(rounds_json) = 'array'),
        source_refs_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(source_refs_json) AND json_type(source_refs_json) = 'array'),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        work_id TEXT REFERENCES works(id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT,
        actor TEXT NOT NULL DEFAULT 'owner',
        detail_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS work_covers (
        work_id TEXT PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
        mime_type TEXT NOT NULL CHECK(mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif')),
        content BLOB NOT NULL,
        byte_length INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS character_names (
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        normalized_name TEXT NOT NULL,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        display_name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('primary', 'alias')),
        sort_order INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(work_id, normalized_name)
      );

      CREATE TABLE IF NOT EXISTS organizations (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        is_dissolved INTEGER NOT NULL DEFAULT 0 CHECK(is_dissolved IN (0, 1)),
        is_favorite INTEGER NOT NULL DEFAULT 0 CHECK(is_favorite IN (0, 1)),
        settings_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(work_id, normalized_name)
      );

      CREATE TABLE IF NOT EXISTS character_organization_memberships (
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(character_id, organization_id)
      );

      CREATE TABLE IF NOT EXISTS chapter_outlines (
        chapter_id TEXT PRIMARY KEY REFERENCES chapters(id) ON DELETE CASCADE,
        goal TEXT NOT NULL DEFAULT '',
        conflict TEXT NOT NULL DEFAULT '',
        turning_point TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'ready', 'completed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS foreshadows (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned', 'planted', 'resolved', 'abandoned')),
        importance TEXT NOT NULL DEFAULT 'medium' CHECK(importance IN ('low', 'medium', 'high')),
        planned_payoff_chapter_id TEXT REFERENCES chapters(id) ON DELETE SET NULL,
        resolution_note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS foreshadow_occurrences (
        id TEXT PRIMARY KEY,
        foreshadow_id TEXT NOT NULL REFERENCES foreshadows(id) ON DELETE CASCADE,
        chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('setup', 'reminder', 'payoff')),
        note TEXT NOT NULL DEFAULT '',
        evidence_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(foreshadow_id, chapter_id, role)
      );

      CREATE TABLE IF NOT EXISTS continuation_guard_runs (
        id TEXT PRIMARY KEY,
        suggestion_id TEXT NOT NULL REFERENCES ai_suggestions(id) ON DELETE CASCADE,
        call_id TEXT REFERENCES ai_calls(id) ON DELETE SET NULL,
        chapter_version INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('clear', 'warning', 'failed')),
        issues_json TEXT NOT NULL DEFAULT '[]',
        context_refs_json TEXT NOT NULL DEFAULT '{}',
        failure TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_volumes_work ON volumes(work_id, sort_order);
      CREATE INDEX IF NOT EXISTS idx_chapters_work ON chapters(work_id, volume_id, sort_order);
      CREATE INDEX IF NOT EXISTS idx_versions_chapter ON chapter_versions(chapter_id, version_no DESC);
      CREATE INDEX IF NOT EXISTS idx_file_versions_work ON file_versions(work_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_chapter_insights_chapter ON chapter_insights(chapter_id, chapter_version DESC, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_settings_work ON settings(work_id, category);
      CREATE INDEX IF NOT EXISTS idx_drafts_work ON drafts(work_id, draft_type, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_characters_work ON characters(work_id, name);
      CREATE INDEX IF NOT EXISTS idx_events_work ON timeline_events(work_id, time_sort);
      CREATE INDEX IF NOT EXISTS idx_timeline_tracks_work ON timeline_tracks(work_id, sort_order);
      CREATE INDEX IF NOT EXISTS idx_relationships_work ON relationships(work_id);
      CREATE INDEX IF NOT EXISTS idx_reviews_work ON review_items(work_id, status);
      CREATE INDEX IF NOT EXISTS idx_character_merges_work ON character_merges(work_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_work ON analysis_tasks(work_id, status);
      CREATE INDEX IF NOT EXISTS idx_calls_work ON ai_calls(work_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ai_suggestions_work ON ai_suggestions(work_id, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ai_conversations_work ON ai_conversations(work_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ai_conversation_messages ON ai_conversation_messages(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_roleplay_memories_character
        ON roleplay_memories(work_id, character_id, status, is_pinned DESC, importance DESC, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_roleplay_memory_sources_memory
        ON roleplay_memory_sources(memory_id, created_at, id);
      CREATE INDEX IF NOT EXISTS idx_roleplay_memory_versions_memory
        ON roleplay_memory_versions(memory_id, version_no DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_conversation_stream_requests_active
        ON ai_conversation_stream_requests(conversation_id) WHERE status = 'in_progress';
      CREATE INDEX IF NOT EXISTS idx_ai_conversation_stream_requests_lease
        ON ai_conversation_stream_requests(status, lease_expires_at);
      CREATE INDEX IF NOT EXISTS idx_ai_conversation_forks_message ON ai_conversation_forks(source_message_id);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_work_created ON audit_logs(work_id, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_character_names_primary ON character_names(character_id) WHERE kind = 'primary';
      CREATE INDEX IF NOT EXISTS idx_character_names_character ON character_names(character_id, sort_order);
      CREATE INDEX IF NOT EXISTS idx_character_versions_character ON character_versions(character_id, version_no DESC);
      CREATE INDEX IF NOT EXISTS idx_entity_versions_entity ON entity_versions(entity_type, entity_id, version_no DESC);
      CREATE INDEX IF NOT EXISTS idx_entity_versions_work ON entity_versions(work_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_races_work ON races(work_id, name);
      CREATE INDEX IF NOT EXISTS idx_organizations_work ON organizations(work_id, name);
      CREATE INDEX IF NOT EXISTS idx_memberships_organization ON character_organization_memberships(organization_id, character_id);
      CREATE INDEX IF NOT EXISTS idx_foreshadows_work ON foreshadows(work_id, status, importance);
      CREATE INDEX IF NOT EXISTS idx_foreshadows_work_payoff_status ON foreshadows(work_id, planned_payoff_chapter_id, status);
      CREATE INDEX IF NOT EXISTS idx_foreshadow_occurrences_chapter ON foreshadow_occurrences(chapter_id, role);
      CREATE INDEX IF NOT EXISTS idx_continuation_guards_suggestion ON continuation_guard_runs(suggestion_id, created_at DESC);
    `);
    this.raw.exec(IM_SCHEMA_SQL);
    this.applyDataMigrations();
  }

  private applyDataMigrations(): void {
    const applied = new Set(this.all<{ version: number }>("SELECT version FROM schema_migrations").map((row) => Number(row.version)));
    if (!applied.has(1)) {
      this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)", new Date().toISOString());
    }
    if (!applied.has(2)) {
      this.transaction(() => {
        this.run("DELETE FROM character_names");
        const characters = this.all<{ id: string; work_id: string; name: string; aliases_json: string }>(
          "SELECT id, work_id, name, aliases_json FROM characters ORDER BY created_at, id"
        );
        for (const character of characters) {
          const aliases = this.parseAliases(character.aliases_json);
          const names = [
            { displayName: character.name, kind: "primary", sortOrder: 0 },
            ...aliases.map((displayName, index) => ({ displayName, kind: "alias", sortOrder: index + 1 }))
          ];
          const localNames = new Set<string>();
          for (const name of names) {
            const normalizedName = this.normalizeCharacterName(name.displayName);
            if (!normalizedName) throw new Error(`角色 ${character.id} 存在空名称，无法完成名称索引迁移`);
            if (localNames.has(normalizedName)) throw new Error(`角色 ${character.id} 的名称或别名重复：${name.displayName}`);
            localNames.add(normalizedName);
            try {
              this.run(
                `INSERT INTO character_names (work_id, normalized_name, character_id, display_name, kind, sort_order)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                character.work_id,
                normalizedName,
                character.id,
                name.displayName.trim(),
                name.kind,
                name.sortOrder
              );
            } catch {
              throw new Error(`作品 ${character.work_id} 存在重复角色名或别名：${name.displayName}`);
            }
          }
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (2, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(3)) {
      this.transaction(() => {
        const relationshipColumns = new Set(this.all("PRAGMA table_info(relationships)").map((row) => String(row.name)));
        if (!relationshipColumns.has("keywords_json")) {
          this.run("ALTER TABLE relationships ADD COLUMN keywords_json TEXT NOT NULL DEFAULT '[]'");
        }
        const providerColumns = new Set(this.all("PRAGMA table_info(providers)").map((row) => String(row.name)));
        if (!providerColumns.has("concurrency_limit")) {
          this.run("ALTER TABLE providers ADD COLUMN concurrency_limit INTEGER NOT NULL DEFAULT 10 CHECK(concurrency_limit BETWEEN 1 AND 100)");
        }
        if (!providerColumns.has("rpm_limit")) {
          this.run("ALTER TABLE providers ADD COLUMN rpm_limit INTEGER NOT NULL DEFAULT 10 CHECK(rpm_limit BETWEEN 1 AND 10000)");
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (3, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(4)) {
      this.transaction(() => {
        const chapterColumns = new Set(this.all("PRAGMA table_info(chapters)").map((row) => String(row.name)));
        if (!chapterColumns.has("chapter_type")) {
          this.run("ALTER TABLE chapters ADD COLUMN chapter_type TEXT NOT NULL DEFAULT '正文' CHECK(chapter_type IN ('正文', '设定', '作者的话', '其他'))");
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (4, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(5)) {
      this.transaction(() => {
        const providerColumns = new Set(this.all("PRAGMA table_info(providers)").map((row) => String(row.name)));
        if (!providerColumns.has("max_tokens")) {
          this.run("ALTER TABLE providers ADD COLUMN max_tokens INTEGER NOT NULL DEFAULT 32000 CHECK(max_tokens BETWEEN 1 AND 32768)");
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (5, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(6)) {
      this.transaction(() => {
        this.run(`CREATE TABLE IF NOT EXISTS timeline_tracks (
          id TEXT PRIMARY KEY,
          work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(work_id, name)
        )`);
        const eventColumns = new Set(this.all("PRAGMA table_info(timeline_events)").map((row) => String(row.name)));
        if (!eventColumns.has("track_id")) {
          this.run("ALTER TABLE timeline_events ADD COLUMN track_id TEXT REFERENCES timeline_tracks(id) ON DELETE SET NULL");
        }
        this.run("CREATE INDEX IF NOT EXISTS idx_timeline_tracks_work ON timeline_tracks(work_id, sort_order)");
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (6, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(7)) {
      this.transaction(() => {
        const volumeColumns = new Set(this.all("PRAGMA table_info(volumes)").map((row) => String(row.name)));
        if (!volumeColumns.has("description")) {
          this.run("ALTER TABLE volumes ADD COLUMN description TEXT NOT NULL DEFAULT ''");
        }
        if (!volumeColumns.has("keywords_json")) {
          this.run("ALTER TABLE volumes ADD COLUMN keywords_json TEXT NOT NULL DEFAULT '[]'");
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (7, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(8)) {
      this.transaction(() => {
        const timestamp = new Date().toISOString();
        const workColumns = new Set(this.all("PRAGMA table_info(works)").map((row) => String(row.name)));
        if (!workColumns.has("is_internal")) {
          this.run("ALTER TABLE works ADD COLUMN is_internal INTEGER NOT NULL DEFAULT 0");
        }
        const modelColumns = new Set(this.all("PRAGMA table_info(models)").map((row) => String(row.name)));
        if (!modelColumns.has("context_window")) {
          this.run("ALTER TABLE models ADD COLUMN context_window INTEGER NOT NULL DEFAULT 128000 CHECK(context_window BETWEEN 1024 AND 2000000)");
        }
        this.run(`CREATE TABLE IF NOT EXISTS platform_ai_settings (
          id INTEGER PRIMARY KEY CHECK(id = 1),
          system_prompt TEXT NOT NULL DEFAULT '',
          stream_idle_timeout_seconds INTEGER NOT NULL DEFAULT 90 CHECK(stream_idle_timeout_seconds BETWEEN 30 AND 600),
          updated_at TEXT NOT NULL
        )`);
        this.run(`CREATE TABLE IF NOT EXISTS work_ai_settings (
          work_id TEXT PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
          system_prompt TEXT NOT NULL DEFAULT '',
          updated_at TEXT NOT NULL
        )`);
        this.run(
          `INSERT INTO works (id, title, author, description, language, cover_url, tags_json, is_internal, created_at, updated_at)
           VALUES (?, '平台 AI 配置', '', '', 'zh-CN', NULL, '[]', 1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET is_internal = 1`,
          PLATFORM_AI_WORK_ID,
          timestamp,
          timestamp
        );
        this.run(
          "INSERT INTO platform_ai_settings (id, system_prompt, updated_at) VALUES (1, '', ?) ON CONFLICT(id) DO NOTHING",
          timestamp
        );
        this.run("UPDATE providers SET work_id = ? WHERE work_id <> ?", PLATFORM_AI_WORK_ID, PLATFORM_AI_WORK_ID);
        this.run("CREATE INDEX IF NOT EXISTS idx_work_ai_settings_work ON work_ai_settings(work_id)");
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (8, ?)", timestamp);
      });
    }
    if (!applied.has(9)) {
      this.transaction(() => {
        const messageColumns = new Set(this.all("PRAGMA table_info(ai_conversation_messages)").map((row) => String(row.name)));
        if (!messageColumns.has("metadata_json")) {
          this.run("ALTER TABLE ai_conversation_messages ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'");
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (9, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(10)) {
      this.transaction(() => {
        const characterColumns = new Set(this.all("PRAGMA table_info(characters)").map((row) => String(row.name)));
        if (!characterColumns.has("species")) {
          this.run("ALTER TABLE characters ADD COLUMN species TEXT NOT NULL DEFAULT ''");
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (10, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(11)) {
      this.transaction(() => {
        const characters = this.all<{ id: string; species: string; attributes_json: string }>(
          "SELECT id, species, attributes_json FROM characters WHERE species = ''"
        );
        for (const character of characters) {
          try {
            const attributes = JSON.parse(character.attributes_json) as Record<string, unknown>;
            if (typeof attributes.species === "string" && attributes.species.trim()) {
              this.run("UPDATE characters SET species = ? WHERE id = ?", attributes.species.trim(), character.id);
            }
          } catch {
            // 无效的旧扩展属性保持原样，避免迁移阻断数据库启动。
          }
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (11, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(12)) {
      this.transaction(() => {
        const characterColumns = new Set(this.all("PRAGMA table_info(characters)").map((row) => String(row.name)));
        if (!characterColumns.has("version_no")) {
          this.run("ALTER TABLE characters ADD COLUMN version_no INTEGER NOT NULL DEFAULT 1");
        }
        this.run(`CREATE TABLE IF NOT EXISTS character_versions (
          id TEXT PRIMARY KEY,
          character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
          version_no INTEGER NOT NULL,
          snapshot_json TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'manual',
          source_ref TEXT,
          change_note TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          UNIQUE(character_id, version_no)
        )`);
        this.run("CREATE INDEX IF NOT EXISTS idx_character_versions_character ON character_versions(character_id, version_no DESC)");
        const characterVersionColumns = new Set(this.all("PRAGMA table_info(character_versions)").map((row) => String(row.name)));
        const characters = this.all<Record<string, unknown>>("SELECT * FROM characters ORDER BY created_at, id");
        for (const character of characters) {
          const characterId = String(character.id);
          const organizationIds = this.all<{ organization_id: string }>(
            "SELECT organization_id FROM character_organization_memberships WHERE character_id = ? ORDER BY organization_id",
            characterId
          ).map((membership) => membership.organization_id);
          const parseJson = (value: unknown, fallback: unknown): unknown => {
            try {
              return JSON.parse(String(value));
            } catch {
              return fallback;
            }
          };
          const snapshot = {
            name: String(character.name),
            gender: ["male", "female", "none", "unknown"].includes(String(character.gender)) ? String(character.gender) : "unknown",
            aliases: parseJson(character.aliases_json, []),
            species: String(character.species ?? ""),
            organizationIds,
            attributes: parseJson(character.attributes_json, {}),
            profile: parseJson(character.profile_json, {}),
            currentState: parseJson(character.current_state_json, {}),
            lockedFields: parseJson(character.locked_fields_json, []),
            firstChapterId: character.first_chapter_id === null ? null : String(character.first_chapter_id)
          };
          this.run(
            characterVersionColumns.has("work_id")
              ? `INSERT INTO character_versions (id, work_id, character_id, version_no, snapshot_json, source, change_note, created_at)
                 VALUES (?, ?, ?, 1, ?, 'migration', '建立人物版本基线', ?)
                 ON CONFLICT(character_id, version_no) DO NOTHING`
              : `INSERT INTO character_versions (id, character_id, version_no, snapshot_json, source, change_note, created_at)
                 VALUES (?, ?, 1, ?, 'migration', '建立人物版本基线', ?)
                 ON CONFLICT(character_id, version_no) DO NOTHING`,
            ...(characterVersionColumns.has("work_id")
              ? [`characterVersion_migration_${characterId}`, String(character.work_id), characterId, JSON.stringify(snapshot), String(character.updated_at)]
              : [`characterVersion_migration_${characterId}`, characterId, JSON.stringify(snapshot), String(character.updated_at)])
          );
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (12, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(13)) {
      this.transaction(() => {
        this.run(`CREATE TABLE IF NOT EXISTS races (
          id TEXT PRIMARY KEY,
          work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          normalized_name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          settings_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(work_id, normalized_name)
        )`);
        this.run("CREATE INDEX IF NOT EXISTS idx_races_work ON races(work_id, name)");
        const characterColumns = new Set(this.all("PRAGMA table_info(characters)").map((row) => String(row.name)));
        if (!characterColumns.has("race_id")) {
          this.run("ALTER TABLE characters ADD COLUMN race_id TEXT REFERENCES races(id) ON DELETE SET NULL");
        }
        const legacySpecies = this.all<{ work_id: string; species: string; created_at: string; updated_at: string }>(
          `SELECT work_id, species, MIN(created_at) AS created_at, MAX(updated_at) AS updated_at
           FROM characters WHERE TRIM(species) <> '' GROUP BY work_id, species ORDER BY work_id, species`
        );
        const raceByWorkAndName = new Map<string, string>();
        let migrationIndex = 0;
        for (const legacy of legacySpecies) {
          const name = legacy.species.normalize("NFKC").trim().replace(/\s+/gu, " ");
          const normalizedName = name.toLocaleLowerCase("zh-CN");
          const key = `${legacy.work_id}\u0000${normalizedName}`;
          let raceId = raceByWorkAndName.get(key);
          if (!raceId) {
            const existing = this.get<{ id: string }>("SELECT id FROM races WHERE work_id = ? AND normalized_name = ?", legacy.work_id, normalizedName);
            raceId = existing?.id ?? `race_migration_${++migrationIndex}`;
            if (!existing) {
              this.run(
                `INSERT INTO races (id, work_id, name, normalized_name, description, settings_json, created_at, updated_at)
                 VALUES (?, ?, ?, ?, '由旧人物种族字段迁移生成', '[]', ?, ?)`,
                raceId,
                legacy.work_id,
                name,
                normalizedName,
                legacy.created_at,
                legacy.updated_at
              );
            }
            raceByWorkAndName.set(key, raceId);
          }
          this.run("UPDATE characters SET race_id = ?, species = ? WHERE work_id = ? AND species = ?", raceId, name, legacy.work_id, legacy.species);
        }
        const versions = this.all<{ id: string; work_id: string; snapshot_json: string }>(
          `SELECT cv.id, c.work_id, cv.snapshot_json FROM character_versions cv
           JOIN characters c ON c.id = cv.character_id`
        );
        for (const version of versions) {
          try {
            const snapshot = JSON.parse(version.snapshot_json) as Record<string, unknown>;
            const species = typeof snapshot.species === "string" ? snapshot.species.normalize("NFKC").trim().replace(/\s+/gu, " ") : "";
            if (!species) {
              snapshot.raceId = null;
            } else {
              const normalizedName = species.toLocaleLowerCase("zh-CN");
              const race = this.get<{ id: string }>("SELECT id FROM races WHERE work_id = ? AND normalized_name = ?", version.work_id, normalizedName);
              snapshot.raceId = race?.id ?? null;
            }
            this.run("UPDATE character_versions SET snapshot_json = ? WHERE id = ?", JSON.stringify(snapshot), version.id);
          } catch {
            // 无效历史快照保持原样，避免阻断数据库迁移。
          }
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (13, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(14)) {
      this.transaction(() => {
        this.run(`CREATE TABLE IF NOT EXISTS entity_versions (
          id TEXT PRIMARY KEY,
          work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          version_no INTEGER NOT NULL,
          snapshot_json TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'manual',
          source_ref TEXT,
          change_note TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          UNIQUE(entity_type, entity_id, version_no)
        )`);
        this.run("CREATE INDEX IF NOT EXISTS idx_entity_versions_entity ON entity_versions(entity_type, entity_id, version_no DESC)");
        this.run("CREATE INDEX IF NOT EXISTS idx_entity_versions_work ON entity_versions(work_id, created_at DESC)");
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (14, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(15)) {
      this.transaction(() => {
        this.run(`CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          normalized_username TEXT NOT NULL UNIQUE,
          display_name TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          password_salt TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'user')),
          status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_login_at TEXT
        )`);
        this.run(`CREATE TABLE IF NOT EXISTS user_sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          csrf_token TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          revoked_at TEXT
        )`);
        const workColumns = new Set(this.all("PRAGMA table_info(works)").map((row) => String(row.name)));
        if (!workColumns.has("owner_user_id")) {
          this.run("ALTER TABLE works ADD COLUMN owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL");
        }
        this.run(`CREATE TABLE IF NOT EXISTS work_memberships (
          work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK(role IN ('owner', 'editor')),
          invited_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(work_id, user_id)
        )`);
        const actorColumns: Array<[string, string]> = [
          ["file_versions", "created_by_user_id"],
          ["chapter_versions", "created_by_user_id"],
          ["character_versions", "created_by_user_id"],
          ["entity_versions", "created_by_user_id"],
          ["ai_calls", "created_by_user_id"],
          ["ai_suggestions", "created_by_user_id"],
          ["ai_suggestions", "decided_by_user_id"],
          ["ai_conversations", "created_by_user_id"],
          ["ai_conversation_messages", "created_by_user_id"],
          ["analysis_tasks", "created_by_user_id"],
          ["audit_logs", "user_id"],
          ["continuation_guard_runs", "created_by_user_id"]
        ];
        for (const [table, column] of actorColumns) {
          const columns = new Set(this.all(`PRAGMA table_info(${table})`).map((row) => String(row.name)));
          if (!columns.has(column)) this.run(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT REFERENCES users(id) ON DELETE SET NULL`);
        }
        this.run("CREATE INDEX IF NOT EXISTS idx_users_status ON users(status, username)");
        this.run("CREATE INDEX IF NOT EXISTS idx_user_sessions_token ON user_sessions(token_hash)");
        this.run("CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id, expires_at)");
        this.run("CREATE INDEX IF NOT EXISTS idx_work_memberships_user ON work_memberships(user_id, work_id)");
        this.run("CREATE INDEX IF NOT EXISTS idx_works_owner ON works(owner_user_id, updated_at DESC)");
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (15, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(16)) {
      this.transaction(() => {
        const chapterVersionColumns = new Set(this.all("PRAGMA table_info(chapter_versions)").map((row) => String(row.name)));
        if (!chapterVersionColumns.has("work_id")) {
          this.run(`CREATE TABLE chapter_versions_v16 (
            id TEXT PRIMARY KEY,
            work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
            chapter_id TEXT NOT NULL,
            version_no INTEGER NOT NULL,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            volume_id TEXT,
            sort_order INTEGER,
            chapter_type TEXT,
            source TEXT NOT NULL DEFAULT 'manual',
            source_ref TEXT,
            created_at TEXT NOT NULL,
            created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
            UNIQUE(chapter_id, version_no)
          )`);
          this.run(`INSERT INTO chapter_versions_v16 (
              id, work_id, chapter_id, version_no, title, content, volume_id, sort_order, chapter_type,
              source, source_ref, created_at, created_by_user_id
            )
            SELECT version.id, chapter.work_id, version.chapter_id, version.version_no, version.title, version.content,
              chapter.volume_id, chapter.sort_order, chapter.chapter_type, version.source, version.source_ref,
              version.created_at, version.created_by_user_id
            FROM chapter_versions version
            JOIN chapters chapter ON chapter.id = version.chapter_id`);
          this.run("DROP TABLE chapter_versions");
          this.run("ALTER TABLE chapter_versions_v16 RENAME TO chapter_versions");
        }
        const characterVersionColumns = new Set(this.all("PRAGMA table_info(character_versions)").map((row) => String(row.name)));
        if (!characterVersionColumns.has("work_id")) {
          this.run(`CREATE TABLE character_versions_v16 (
            id TEXT PRIMARY KEY,
            work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
            character_id TEXT NOT NULL,
            version_no INTEGER NOT NULL,
            snapshot_json TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'manual',
            source_ref TEXT,
            change_note TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
            UNIQUE(character_id, version_no)
          )`);
          this.run(`INSERT INTO character_versions_v16 (
              id, work_id, character_id, version_no, snapshot_json, source, source_ref, change_note, created_at, created_by_user_id
            )
            SELECT version.id, character.work_id, version.character_id, version.version_no, version.snapshot_json,
              version.source, version.source_ref, version.change_note, version.created_at, version.created_by_user_id
            FROM character_versions version
            JOIN characters character ON character.id = version.character_id`);
          this.run("DROP TABLE character_versions");
          this.run("ALTER TABLE character_versions_v16 RENAME TO character_versions");
        }
        this.run("CREATE INDEX IF NOT EXISTS idx_chapter_versions_work ON chapter_versions(work_id, chapter_id, version_no)");
        this.run("CREATE INDEX IF NOT EXISTS idx_character_versions_work ON character_versions(work_id, character_id, version_no)");
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (16, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(17)) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(work_ai_settings)").map((row) => String(row.name)));
        if (!columns.has("auto_run_enabled")) {
          this.run("ALTER TABLE work_ai_settings ADD COLUMN auto_run_enabled INTEGER NOT NULL DEFAULT 0");
        }
        if (!columns.has("auto_run_concurrency")) {
          this.run("ALTER TABLE work_ai_settings ADD COLUMN auto_run_concurrency INTEGER NOT NULL DEFAULT 2");
        }
        if (!columns.has("auto_run_batch_limit")) {
          this.run("ALTER TABLE work_ai_settings ADD COLUMN auto_run_batch_limit INTEGER NOT NULL DEFAULT 20");
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (17, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(18)) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(work_ai_settings)").map((row) => String(row.name)));
        if (!columns.has("book_summary_context_percent")) {
          this.run("ALTER TABLE work_ai_settings ADD COLUMN book_summary_context_percent INTEGER NOT NULL DEFAULT 50");
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (18, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(19)) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(work_ai_settings)").map((row) => String(row.name)));
        if (!columns.has("agent_tools_json")) {
          this.run("ALTER TABLE work_ai_settings ADD COLUMN agent_tools_json TEXT NOT NULL DEFAULT '[\"story_index\",\"read_chapters\",\"query_story_knowledge\"]'");
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (19, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(20)) {
      this.transaction(() => {
        const settingsColumns = new Set(this.all("PRAGMA table_info(work_ai_settings)").map((row) => String(row.name)));
        if (!settingsColumns.has("context_compact_threshold")) {
          this.run("ALTER TABLE work_ai_settings ADD COLUMN context_compact_threshold INTEGER NOT NULL DEFAULT 85");
        }
        const conversationColumns = new Set(this.all("PRAGMA table_info(ai_conversations)").map((row) => String(row.name)));
        if (!conversationColumns.has("compacted_summary")) {
          this.run("ALTER TABLE ai_conversations ADD COLUMN compacted_summary TEXT NOT NULL DEFAULT ''");
        }
        if (!conversationColumns.has("compacted_message_count")) {
          this.run("ALTER TABLE ai_conversations ADD COLUMN compacted_message_count INTEGER NOT NULL DEFAULT 0");
        }
        if (!conversationColumns.has("context_warning_at")) {
          this.run("ALTER TABLE ai_conversations ADD COLUMN context_warning_at TEXT");
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (20, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(21)) {
      this.transaction(() => {
        this.run(`CREATE TABLE IF NOT EXISTS user_api_keys (
          user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          key_hash TEXT NOT NULL UNIQUE,
          key_prefix TEXT NOT NULL,
          created_at TEXT NOT NULL,
          rotated_at TEXT NOT NULL,
          last_used_at TEXT
        )`);
        this.run("CREATE INDEX IF NOT EXISTS idx_user_api_keys_hash ON user_api_keys(key_hash)");
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (21, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(22)) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(chapter_versions)").map((row) => String(row.name)));
        if (!columns.has("change_note")) {
          this.run("ALTER TABLE chapter_versions ADD COLUMN change_note TEXT NOT NULL DEFAULT ''");
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (22, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(23)) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(models)").map((row) => String(row.name)));
        if (!columns.has("thinking_enabled")) {
          this.run("ALTER TABLE models ADD COLUMN thinking_enabled INTEGER NOT NULL DEFAULT 1");
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (23, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(24)) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(users)").map((row) => String(row.name)));
        if (!columns.has("avatar_updated_at")) {
          this.run("ALTER TABLE users ADD COLUMN avatar_updated_at TEXT");
        }
        this.run(`CREATE TABLE IF NOT EXISTS user_avatars (
          user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          mime_type TEXT NOT NULL CHECK(mime_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
          content BLOB NOT NULL,
          byte_length INTEGER NOT NULL,
          sha256 TEXT NOT NULL,
          width INTEGER NOT NULL,
          height INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        )`);
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (24, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(25)) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(users)").map((row) => String(row.name)));
        if (!columns.has("avatar_sha256")) {
          this.run("ALTER TABLE users ADD COLUMN avatar_sha256 TEXT");
        }
        this.run(`UPDATE users SET avatar_sha256 = (
          SELECT avatar.sha256 FROM user_avatars avatar WHERE avatar.user_id = users.id
        ) WHERE avatar_updated_at IS NOT NULL AND avatar_sha256 IS NULL`);
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (25, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(26)) {
      this.transaction(() => {
        const timestamp = new Date().toISOString();
        this.run(`CREATE TABLE IF NOT EXISTS platform_ui_settings (
          id INTEGER PRIMARY KEY CHECK(id = 1),
          toast_position TEXT NOT NULL DEFAULT 'bottom-right' CHECK(toast_position IN ('bottom-right', 'top-right')),
          updated_at TEXT NOT NULL
        )`);
        this.run(
          "INSERT INTO platform_ui_settings (id, toast_position, updated_at) VALUES (1, 'bottom-right', ?) ON CONFLICT(id) DO NOTHING",
          timestamp
        );
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (26, ?)", timestamp);
      });
    }
    if (!applied.has(27)) {
      this.transaction(() => {
        this.run(`CREATE TABLE work_memberships_v27 (
          work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK(role IN ('owner', 'editor', 'viewer')),
          invited_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(work_id, user_id)
        )`);
        this.run(`INSERT INTO work_memberships_v27 (work_id, user_id, role, invited_by_user_id, created_at)
          SELECT work_id, user_id, role, invited_by_user_id, created_at FROM work_memberships`);
        this.run("DROP TABLE work_memberships");
        this.run("ALTER TABLE work_memberships_v27 RENAME TO work_memberships");
        this.run("CREATE INDEX idx_work_memberships_user ON work_memberships(user_id, work_id)");
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (27, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(28)) {
      this.transaction(() => {
        this.raw.exec(`
          CREATE TABLE IF NOT EXISTS chapter_paragraph_search (
            id INTEGER PRIMARY KEY,
            work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
            chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
            paragraph_order INTEGER NOT NULL,
            content TEXT NOT NULL,
            search_content TEXT NOT NULL,
            UNIQUE(chapter_id, paragraph_order)
          );
          CREATE INDEX IF NOT EXISTS idx_chapter_paragraph_search_work
            ON chapter_paragraph_search(work_id, chapter_id, paragraph_order);
          CREATE VIRTUAL TABLE IF NOT EXISTS chapter_paragraph_search_fts USING fts5(
            search_content,
            content='chapter_paragraph_search',
            content_rowid='id',
            tokenize='trigram'
          );
          CREATE TRIGGER IF NOT EXISTS chapter_paragraph_search_ai AFTER INSERT ON chapter_paragraph_search BEGIN
            INSERT INTO chapter_paragraph_search_fts(rowid, search_content) VALUES (new.id, new.search_content);
          END;
          CREATE TRIGGER IF NOT EXISTS chapter_paragraph_search_ad AFTER DELETE ON chapter_paragraph_search BEGIN
            INSERT INTO chapter_paragraph_search_fts(chapter_paragraph_search_fts, rowid, search_content)
            VALUES ('delete', old.id, old.search_content);
          END;
          CREATE TRIGGER IF NOT EXISTS chapter_paragraph_search_au AFTER UPDATE ON chapter_paragraph_search BEGIN
            INSERT INTO chapter_paragraph_search_fts(chapter_paragraph_search_fts, rowid, search_content)
            VALUES ('delete', old.id, old.search_content);
            INSERT INTO chapter_paragraph_search_fts(rowid, search_content) VALUES (new.id, new.search_content);
          END;
          CREATE TABLE IF NOT EXISTS chapter_paragraph_short_terms (
            paragraph_id INTEGER NOT NULL REFERENCES chapter_paragraph_search(id) ON DELETE CASCADE,
            term TEXT NOT NULL,
            PRIMARY KEY(term, paragraph_id)
          ) WITHOUT ROWID;
        `);
        const insertParagraph = this.raw.prepare(
          `INSERT INTO chapter_paragraph_search (work_id, chapter_id, paragraph_order, content, search_content)
           VALUES (?, ?, ?, ?, ?)`
        );
        const insertTerm = this.raw.prepare(
          "INSERT INTO chapter_paragraph_short_terms (paragraph_id, term) VALUES (?, ?)"
        );
        const chapters = this.all<{ id: string; work_id: string; content: string }>(
          "SELECT id, work_id, content FROM chapters ORDER BY work_id, volume_id, sort_order"
        );
        for (const chapter of chapters) {
          for (const [paragraphOrder, content] of splitDocumentParagraphs(chapter.content).entries()) {
            const searchContent = normalizeDocumentSearchText(content);
            const result = insertParagraph.run(chapter.work_id, chapter.id, paragraphOrder, content, searchContent);
            for (const term of documentShortSearchTerms(searchContent)) insertTerm.run(result.lastInsertRowid, term);
          }
        }
        this.run(`UPDATE work_ai_settings
          SET agent_tools_json = CASE
            WHEN json_valid(agent_tools_json) THEN json_insert(agent_tools_json, '$[#]', 'grep')
            ELSE '["story_index","read_chapters","query_story_knowledge","grep"]'
          END
          WHERE NOT json_valid(agent_tools_json)
             OR NOT EXISTS (SELECT 1 FROM json_each(agent_tools_json) WHERE value = 'grep')`);
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (28, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(29)) {
      this.transaction(() => {
        const userColumns = new Set(this.all("PRAGMA table_info(users)").map((row) => String(row.name)));
        if (!userColumns.has("onboarding_completed_at")) {
          this.run("ALTER TABLE users ADD COLUMN onboarding_completed_at TEXT");
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (29, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(30)) {
      this.transaction(() => {
        const characterColumns = new Set(this.all("PRAGMA table_info(characters)").map((row) => String(row.name)));
        if (!characterColumns.has("merged_into_character_id")) {
          this.run("ALTER TABLE characters ADD COLUMN merged_into_character_id TEXT");
        }
        if (!characterColumns.has("merged_at")) {
          this.run("ALTER TABLE characters ADD COLUMN merged_at TEXT");
        }
        this.raw.exec(`
          CREATE TABLE IF NOT EXISTS character_merges (
            id TEXT PRIMARY KEY,
            work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
            source_character_id TEXT NOT NULL UNIQUE,
            target_character_id TEXT NOT NULL,
            review_id TEXT REFERENCES review_items(id) ON DELETE SET NULL,
            source_snapshot_json TEXT NOT NULL,
            target_snapshot_json TEXT NOT NULL,
            reference_snapshot_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            created_by_user_id TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_character_merges_work ON character_merges(work_id, created_at DESC);
        `);
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (30, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(31)) {
      this.transaction(() => {
        this.raw.exec(`
          CREATE TABLE IF NOT EXISTS character_profile_sections (
            id TEXT PRIMARY KEY,
            work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
            character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
            section_type TEXT NOT NULL DEFAULT 'custom',
            title TEXT NOT NULL,
            content_markdown TEXT NOT NULL DEFAULT '',
            summary TEXT NOT NULL DEFAULT '',
            sort_order INTEGER NOT NULL DEFAULT 0,
            source_path TEXT,
            source_hash TEXT,
            version_no INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_character_profile_sections_character
            ON character_profile_sections(character_id, sort_order, created_at);
          CREATE INDEX IF NOT EXISTS idx_character_profile_sections_work
            ON character_profile_sections(work_id, updated_at DESC);

          CREATE TABLE IF NOT EXISTS character_profile_section_versions (
            id TEXT PRIMARY KEY,
            work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
            character_id TEXT NOT NULL,
            section_id TEXT NOT NULL,
            version_no INTEGER NOT NULL,
            snapshot_json TEXT NOT NULL,
            source TEXT NOT NULL,
            source_ref TEXT,
            change_note TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
            UNIQUE(section_id, version_no)
          );
          CREATE INDEX IF NOT EXISTS idx_character_profile_section_versions_section
            ON character_profile_section_versions(section_id, version_no DESC);

          CREATE TABLE IF NOT EXISTS attachments (
            id TEXT PRIMARY KEY,
            work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
            original_name TEXT NOT NULL,
            original_mime_type TEXT NOT NULL,
            stored_mime_type TEXT NOT NULL,
            original_byte_length INTEGER NOT NULL,
            stored_byte_length INTEGER NOT NULL,
            original_sha256 TEXT NOT NULL,
            stored_sha256 TEXT NOT NULL,
            storage_key TEXT NOT NULL,
            width INTEGER NOT NULL,
            height INTEGER NOT NULL,
            page_count INTEGER NOT NULL DEFAULT 1,
            animated INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
            UNIQUE(work_id, stored_sha256)
          );
          CREATE INDEX IF NOT EXISTS idx_attachments_storage_key ON attachments(storage_key);

          CREATE TABLE IF NOT EXISTS attachment_references (
            attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
            work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
            entity_type TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY(attachment_id, entity_type, entity_id)
          ) WITHOUT ROWID;
          CREATE INDEX IF NOT EXISTS idx_attachment_references_entity
            ON attachment_references(entity_type, entity_id);

          CREATE TABLE IF NOT EXISTS character_profile_section_search (
            id INTEGER PRIMARY KEY,
            work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
            character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
            section_id TEXT NOT NULL REFERENCES character_profile_sections(id) ON DELETE CASCADE,
            search_content TEXT NOT NULL,
            UNIQUE(section_id)
          );
          CREATE INDEX IF NOT EXISTS idx_character_profile_section_search_work
            ON character_profile_section_search(work_id, character_id, section_id);
          CREATE VIRTUAL TABLE IF NOT EXISTS character_profile_section_search_fts USING fts5(
            search_content,
            content='character_profile_section_search',
            content_rowid='id',
            tokenize='trigram'
          );
          CREATE TRIGGER IF NOT EXISTS character_profile_section_search_ai AFTER INSERT ON character_profile_section_search BEGIN
            INSERT INTO character_profile_section_search_fts(rowid, search_content) VALUES (new.id, new.search_content);
          END;
          CREATE TRIGGER IF NOT EXISTS character_profile_section_search_ad AFTER DELETE ON character_profile_section_search BEGIN
            INSERT INTO character_profile_section_search_fts(character_profile_section_search_fts, rowid, search_content)
              VALUES ('delete', old.id, old.search_content);
          END;
          CREATE TRIGGER IF NOT EXISTS character_profile_section_search_au AFTER UPDATE ON character_profile_section_search BEGIN
            INSERT INTO character_profile_section_search_fts(character_profile_section_search_fts, rowid, search_content)
              VALUES ('delete', old.id, old.search_content);
            INSERT INTO character_profile_section_search_fts(rowid, search_content) VALUES (new.id, new.search_content);
          END;
          CREATE TABLE IF NOT EXISTS character_profile_section_short_terms (
            search_id INTEGER NOT NULL REFERENCES character_profile_section_search(id) ON DELETE CASCADE,
            term TEXT NOT NULL,
            PRIMARY KEY(term, search_id)
          ) WITHOUT ROWID;
        `);

        const timestamp = new Date().toISOString();
        const characters = this.all("SELECT id, work_id, profile_json, created_at, updated_at FROM characters");
        for (const character of characters) {
          let profile: Record<string, unknown> = {};
          try {
            const parsed = JSON.parse(String(character.profile_json ?? "{}")) as unknown;
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) profile = parsed as Record<string, unknown>;
          } catch {
            profile = {};
          }
          if (!Array.isArray(profile.sections)) continue;
          for (const [index, candidate] of profile.sections.entries()) {
            if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
            const section = candidate as Record<string, unknown>;
            const title = String(section.title ?? "").trim();
            const content = String(section.content ?? "").trim();
            if (!title || !content) continue;
            const sectionId = `characterSection_${String(character.id)}_${index + 1}`;
            const createdAt = String(character.created_at ?? timestamp);
            const updatedAt = String(character.updated_at ?? createdAt);
            this.run(
              `INSERT INTO character_profile_sections
               (id, work_id, character_id, section_type, title, content_markdown, summary, sort_order, created_at, updated_at)
               VALUES (?, ?, ?, 'custom', ?, ?, '', ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
              sectionId,
              String(character.work_id),
              String(character.id),
              title,
              content,
              index,
              createdAt,
              updatedAt
            );
            const snapshot = JSON.stringify({ sectionType: "custom", title, contentMarkdown: content, summary: "", sortOrder: index, sourcePath: null, sourceHash: null });
            this.run(
              `INSERT INTO character_profile_section_versions
               (id, work_id, character_id, section_id, version_no, snapshot_json, source, change_note, created_at)
               VALUES (?, ?, ?, ?, 1, ?, 'migration', '迁移人物 Markdown 章节', ?) ON CONFLICT(section_id, version_no) DO NOTHING`,
              `characterSectionVersion_${String(character.id)}_${index + 1}`,
              String(character.work_id),
              String(character.id),
              sectionId,
              snapshot,
              updatedAt
            );
            const searchContent = normalizeDocumentSearchText(`${title}\n${content}`);
            const result = this.run(
              `INSERT INTO character_profile_section_search (work_id, character_id, section_id, search_content)
               VALUES (?, ?, ?, ?) ON CONFLICT(section_id) DO UPDATE SET search_content = excluded.search_content`,
              String(character.work_id),
              String(character.id),
              sectionId,
              searchContent
            );
            const searchRow = this.get("SELECT id FROM character_profile_section_search WHERE section_id = ?", sectionId);
            const searchId = Number(searchRow?.id ?? result.lastInsertRowid);
            this.run("DELETE FROM character_profile_section_short_terms WHERE search_id = ?", searchId);
            for (const term of documentShortSearchTerms(searchContent)) {
              this.run("INSERT INTO character_profile_section_short_terms (search_id, term) VALUES (?, ?)", searchId, term);
            }
          }
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (31, ?)", timestamp);
      });
    }
    if (!applied.has(32)) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(races)").map((row) => String(row.name)));
        if (!columns.has("parent_race_id")) {
          this.run("ALTER TABLE races ADD COLUMN parent_race_id TEXT REFERENCES races(id) ON DELETE RESTRICT");
        }
        this.run("CREATE INDEX IF NOT EXISTS idx_races_parent ON races(work_id, parent_race_id, name)");
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (32, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(33)) {
      this.transaction(() => {
        this.run(`UPDATE work_ai_settings
          SET agent_tools_json = CASE
            WHEN json_valid(agent_tools_json) THEN json_insert(agent_tools_json, '$[#]', 'read_character_sections')
            ELSE '["story_index","read_chapters","query_story_knowledge","grep","read_character_sections"]'
          END
          WHERE NOT json_valid(agent_tools_json)
             OR NOT EXISTS (SELECT 1 FROM json_each(agent_tools_json) WHERE value = 'read_character_sections')`);
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (33, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(34)) {
      this.transaction(() => {
        const workColumns = new Set(this.all("PRAGMA table_info(works)").map((row) => String(row.name)));
        if (!workColumns.has("version_no")) {
          this.run("ALTER TABLE works ADD COLUMN version_no INTEGER NOT NULL DEFAULT 1");
        }
        const volumeColumns = new Set(this.all("PRAGMA table_info(volumes)").map((row) => String(row.name)));
        if (!volumeColumns.has("version_no")) {
          this.run("ALTER TABLE volumes ADD COLUMN version_no INTEGER NOT NULL DEFAULT 1");
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (34, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(35)) {
      this.transaction(() => {
        const workColumns = new Set(this.all("PRAGMA table_info(works)").map((row) => String(row.name)));
        if (!workColumns.has("version_no")) {
          this.run("ALTER TABLE works ADD COLUMN version_no INTEGER NOT NULL DEFAULT 1");
        }
        const volumeColumns = new Set(this.all("PRAGMA table_info(volumes)").map((row) => String(row.name)));
        if (!volumeColumns.has("version_no")) {
          this.run("ALTER TABLE volumes ADD COLUMN version_no INTEGER NOT NULL DEFAULT 1");
        }
        const membershipColumns = new Set(this.all("PRAGMA table_info(work_memberships)").map((row) => String(row.name)));
        if (!membershipColumns.has("permissions_json")) {
          this.run("ALTER TABLE work_memberships ADD COLUMN permissions_json TEXT NOT NULL DEFAULT '{}'");
        }
        this.run(`UPDATE work_memberships SET permissions_json = '{}'
          WHERE NOT json_valid(permissions_json) OR json_type(permissions_json) <> 'object'`);
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (35, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(36)) {
      this.transaction(() => {
        for (const table of ["races", "organizations"] as const) {
          const columns = new Set(this.all(`PRAGMA table_info(${table})`).map((row) => String(row.name)));
          if (!columns.has("settings_sections_json")) {
            this.run(`ALTER TABLE ${table} ADD COLUMN settings_sections_json TEXT NOT NULL DEFAULT '[]'`);
          }
          const rows = this.all<{ id: string; settings_json: string; settings_sections_json: string }>(
            `SELECT id, settings_json, settings_sections_json FROM ${table}`
          );
          for (const row of rows) {
            let existing: unknown = [];
            let legacy: unknown = [];
            try { existing = JSON.parse(String(row.settings_sections_json)); } catch { existing = []; }
            try { legacy = JSON.parse(String(row.settings_json)); } catch { legacy = []; }
            if (Array.isArray(existing) && existing.length > 0) continue;
            const sections = Array.isArray(legacy)
              ? legacy.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((contentMarkdown, index) => ({
                title: contentMarkdown.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/mu)?.[1]?.trim() || `设定 ${index + 1}`,
                contentMarkdown,
                summary: "",
                sortOrder: index
              }))
              : [];
            this.run(`UPDATE ${table} SET settings_sections_json = ? WHERE id = ?`, JSON.stringify(sections), row.id);
          }
        }
        this.run("CREATE INDEX IF NOT EXISTS idx_tasks_work_created ON analysis_tasks(work_id, created_at DESC, id DESC)");
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (36, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(37)) {
      this.transaction(() => {
        const characterColumns = new Set(this.all("PRAGMA table_info(characters)").map((row) => String(row.name)));
        if (!characterColumns.has("code")) {
          this.run("ALTER TABLE characters ADD COLUMN code TEXT NOT NULL DEFAULT ''");
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (37, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(38)) {
      this.transaction(() => {
        this.run(`CREATE TABLE IF NOT EXISTS login_attempts (
          normalized_username TEXT PRIMARY KEY,
          failure_timestamps_json TEXT NOT NULL CHECK(json_valid(failure_timestamps_json) AND json_type(failure_timestamps_json) = 'array'),
          locked_until TEXT,
          updated_at TEXT NOT NULL
        )`);
        this.run("CREATE INDEX IF NOT EXISTS idx_login_attempts_updated ON login_attempts(updated_at)");
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (38, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(39)) {
      this.transaction(() => {
        const characterColumns = new Set(this.all("PRAGMA table_info(characters)").map((row) => String(row.name)));
        if (characterColumns.has("visibility")) this.run("ALTER TABLE characters DROP COLUMN visibility");
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (39, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(40)) {
      this.transaction(() => {
        const rows = this.all<{ work_id: string; agent_tools_json: string }>("SELECT work_id, agent_tools_json FROM work_ai_settings");
        for (const row of rows) {
          let tools: unknown = [];
          try {
            tools = JSON.parse(String(row.agent_tools_json));
          } catch {
            tools = [];
          }
          if (!Array.isArray(tools)) {
            this.run(
              `UPDATE work_ai_settings SET agent_tools_json = ? WHERE work_id = ?`,
              '["story_index","read_chapters","search_story_entities","grep","read_character_sections"]',
              row.work_id
            );
            continue;
          }
          const next = [...new Set(tools.map((item) => item === "query_story_knowledge" ? "search_story_entities" : item)
            .filter((item): item is string => typeof item === "string" && item.length > 0))];
          this.run(`UPDATE work_ai_settings SET agent_tools_json = ? WHERE work_id = ?`, JSON.stringify(next), row.work_id);
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (40, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(41)) {
      this.transaction(() => {
        const callColumns = new Set(this.all("PRAGMA table_info(ai_calls)").map((row) => String(row.name)));
        if (!callColumns.has("task_id")) {
          this.run("ALTER TABLE ai_calls ADD COLUMN task_id TEXT REFERENCES analysis_tasks(id) ON DELETE SET NULL");
        }
        this.run(`CREATE TABLE IF NOT EXISTS ai_call_traces (
          call_id TEXT PRIMARY KEY REFERENCES ai_calls(id) ON DELETE CASCADE,
          task_id TEXT NOT NULL REFERENCES analysis_tasks(id) ON DELETE CASCADE,
          initial_messages_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(initial_messages_json) AND json_type(initial_messages_json) = 'array'),
          rounds_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(rounds_json) AND json_type(rounds_json) = 'array'),
          source_refs_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(source_refs_json) AND json_type(source_refs_json) = 'array'),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`);
        this.run("CREATE INDEX IF NOT EXISTS idx_calls_task ON ai_calls(task_id, created_at, id)");
        this.run("CREATE INDEX IF NOT EXISTS idx_ai_call_traces_task ON ai_call_traces(task_id, created_at, call_id)");
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (41, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(42)) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(platform_ui_settings)").map((row) => String(row.name)));
        if (!columns.has("page_sizes_json")) {
          this.run(`ALTER TABLE platform_ui_settings ADD COLUMN page_sizes_json TEXT NOT NULL
            DEFAULT '{"characters":30,"analysisTasks":30,"fileVersions":30}'
            CHECK(json_valid(page_sizes_json) AND json_type(page_sizes_json) = 'object')`);
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (42, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(43)) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(ai_call_traces)").map((row) => String(row.name)));
        if (!columns.has("source_refs_json")) {
          this.run(`ALTER TABLE ai_call_traces ADD COLUMN source_refs_json TEXT NOT NULL DEFAULT '[]'
            CHECK(json_valid(source_refs_json) AND json_type(source_refs_json) = 'array')`);
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (43, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(44)) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(analysis_tasks)").map((row) => String(row.name)));
        if (!columns.has("model_id")) {
          this.run("ALTER TABLE analysis_tasks ADD COLUMN model_id TEXT REFERENCES models(id) ON DELETE SET NULL");
        }
        this.run("CREATE INDEX IF NOT EXISTS idx_tasks_model ON analysis_tasks(model_id, status)");
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (44, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(45)) {
      this.transaction(() => {
        const reviewColumns = new Set(this.all("PRAGMA table_info(review_items)").map((row) => String(row.name)));
        if (!reviewColumns.has("dedupe_key")) {
          this.run("ALTER TABLE review_items ADD COLUMN dedupe_key TEXT NOT NULL DEFAULT ''");
        }
        this.raw.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_review_items_dedupe
            ON review_items(work_id, item_type, dedupe_key) WHERE dedupe_key <> '';

          CREATE VIRTUAL TABLE IF NOT EXISTS chapter_paragraph_pinyin_fts USING fts5(
            pinyin_tokens,
            content='',
            contentless_delete=1,
            tokenize='unicode61'
          );
          CREATE TRIGGER IF NOT EXISTS chapter_paragraph_pinyin_ad AFTER DELETE ON chapter_paragraph_search BEGIN
            DELETE FROM chapter_paragraph_pinyin_fts WHERE rowid = old.id;
          END;

          CREATE TABLE IF NOT EXISTS relationship_source_search (
            id INTEGER PRIMARY KEY,
            work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
            source_type TEXT NOT NULL,
            source_id TEXT NOT NULL,
            source_version TEXT NOT NULL DEFAULT '',
            content_hash TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL,
            UNIQUE(work_id, source_type, source_id)
          );
          CREATE INDEX IF NOT EXISTS idx_relationship_source_search_work
            ON relationship_source_search(work_id, source_type, source_id);
          CREATE VIRTUAL TABLE IF NOT EXISTS relationship_source_exact_fts USING fts5(
            character_tokens,
            content='',
            contentless_delete=1,
            tokenize='unicode61'
          );
          CREATE VIRTUAL TABLE IF NOT EXISTS relationship_source_pinyin_fts USING fts5(
            pinyin_tokens,
            content='',
            contentless_delete=1,
            tokenize='unicode61'
          );
          CREATE TRIGGER IF NOT EXISTS relationship_source_search_ad AFTER DELETE ON relationship_source_search BEGIN
            DELETE FROM relationship_source_exact_fts WHERE rowid = old.id;
            DELETE FROM relationship_source_pinyin_fts WHERE rowid = old.id;
          END;

          CREATE TABLE IF NOT EXISTS relationship_source_index_queue (
            work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
            source_type TEXT NOT NULL,
            source_id TEXT NOT NULL,
            queued_at TEXT NOT NULL,
            PRIMARY KEY(work_id, source_type, source_id)
          ) WITHOUT ROWID;
          CREATE TABLE IF NOT EXISTS relationship_source_index_state (
            work_id TEXT PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
            status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'building', 'ready', 'failed')),
            generation INTEGER NOT NULL DEFAULT 0,
            error TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL
          ) WITHOUT ROWID;
        `);

        const queueSources: Array<{ table: string; sourceType: string; idColumn: string }> = [
          { table: "works", sourceType: "work", idColumn: "id" },
          { table: "chapters", sourceType: "chapter", idColumn: "id" },
          { table: "settings", sourceType: "setting", idColumn: "id" },
          { table: "characters", sourceType: "character", idColumn: "id" },
          { table: "races", sourceType: "race", idColumn: "id" },
          { table: "organizations", sourceType: "organization", idColumn: "id" },
          { table: "timeline_tracks", sourceType: "timeline-track", idColumn: "id" },
          { table: "timeline_events", sourceType: "timeline-event", idColumn: "id" },
          { table: "relationships", sourceType: "relationship", idColumn: "id" },
          { table: "foreshadows", sourceType: "foreshadow", idColumn: "id" },
          { table: "review_items", sourceType: "review", idColumn: "id" }
        ];
        for (const source of queueSources) {
          const workExpression = source.table === "works" ? "new.id" : "new.work_id";
          const oldWorkExpression = source.table === "works" ? "old.id" : "old.work_id";
          this.raw.exec(`
            CREATE TRIGGER IF NOT EXISTS relationship_index_${source.table}_ai AFTER INSERT ON ${source.table} BEGIN
              INSERT INTO relationship_source_index_queue(work_id, source_type, source_id, queued_at)
              VALUES (${workExpression}, '${source.sourceType}', new.${source.idColumn}, datetime('now'))
              ON CONFLICT(work_id, source_type, source_id) DO UPDATE SET queued_at = excluded.queued_at;
            END;
            CREATE TRIGGER IF NOT EXISTS relationship_index_${source.table}_au AFTER UPDATE ON ${source.table} BEGIN
              INSERT INTO relationship_source_index_queue(work_id, source_type, source_id, queued_at)
              VALUES (${workExpression}, '${source.sourceType}', new.${source.idColumn}, datetime('now'))
              ON CONFLICT(work_id, source_type, source_id) DO UPDATE SET queued_at = excluded.queued_at;
            END;
            CREATE TRIGGER IF NOT EXISTS relationship_index_${source.table}_bd BEFORE DELETE ON ${source.table} BEGIN
              INSERT INTO relationship_source_index_queue(work_id, source_type, source_id, queued_at)
              VALUES (${oldWorkExpression}, '${source.sourceType}', old.${source.idColumn}, datetime('now'))
              ON CONFLICT(work_id, source_type, source_id) DO UPDATE SET queued_at = excluded.queued_at;
            END;
          `);
        }
        this.raw.exec(`
          CREATE TRIGGER IF NOT EXISTS relationship_index_outlines_ai AFTER INSERT ON chapter_outlines BEGIN
            INSERT INTO relationship_source_index_queue(work_id, source_type, source_id, queued_at)
            SELECT work_id, 'chapter-outline', new.chapter_id, datetime('now') FROM chapters WHERE id = new.chapter_id
            ON CONFLICT(work_id, source_type, source_id) DO UPDATE SET queued_at = excluded.queued_at;
          END;
          CREATE TRIGGER IF NOT EXISTS relationship_index_outlines_au AFTER UPDATE ON chapter_outlines BEGIN
            INSERT INTO relationship_source_index_queue(work_id, source_type, source_id, queued_at)
            SELECT work_id, 'chapter-outline', new.chapter_id, datetime('now') FROM chapters WHERE id = new.chapter_id
            ON CONFLICT(work_id, source_type, source_id) DO UPDATE SET queued_at = excluded.queued_at;
          END;
          CREATE TRIGGER IF NOT EXISTS relationship_index_outlines_bd BEFORE DELETE ON chapter_outlines BEGIN
            INSERT INTO relationship_source_index_queue(work_id, source_type, source_id, queued_at)
            SELECT work_id, 'chapter-outline', old.chapter_id, datetime('now') FROM chapters WHERE id = old.chapter_id
            ON CONFLICT(work_id, source_type, source_id) DO UPDATE SET queued_at = excluded.queued_at;
          END;
          CREATE TRIGGER IF NOT EXISTS relationship_index_sections_ai AFTER INSERT ON character_profile_sections BEGIN
            INSERT INTO relationship_source_index_queue(work_id, source_type, source_id, queued_at)
            VALUES (new.work_id, 'character', new.character_id, datetime('now'))
            ON CONFLICT(work_id, source_type, source_id) DO UPDATE SET queued_at = excluded.queued_at;
          END;
          CREATE TRIGGER IF NOT EXISTS relationship_index_sections_au AFTER UPDATE ON character_profile_sections BEGIN
            INSERT INTO relationship_source_index_queue(work_id, source_type, source_id, queued_at)
            VALUES (new.work_id, 'character', new.character_id, datetime('now'))
            ON CONFLICT(work_id, source_type, source_id) DO UPDATE SET queued_at = excluded.queued_at;
          END;
          CREATE TRIGGER IF NOT EXISTS relationship_index_sections_bd BEFORE DELETE ON character_profile_sections BEGIN
            INSERT INTO relationship_source_index_queue(work_id, source_type, source_id, queued_at)
            VALUES (old.work_id, 'character', old.character_id, datetime('now'))
            ON CONFLICT(work_id, source_type, source_id) DO UPDATE SET queued_at = excluded.queued_at;
          END;
          CREATE TRIGGER IF NOT EXISTS relationship_index_occurrences_ai AFTER INSERT ON foreshadow_occurrences BEGIN
            INSERT INTO relationship_source_index_queue(work_id, source_type, source_id, queued_at)
            SELECT foreshadow.work_id, 'foreshadow', new.foreshadow_id, datetime('now')
            FROM foreshadows foreshadow WHERE foreshadow.id = new.foreshadow_id
            ON CONFLICT(work_id, source_type, source_id) DO UPDATE SET queued_at = excluded.queued_at;
          END;
          CREATE TRIGGER IF NOT EXISTS relationship_index_occurrences_au AFTER UPDATE ON foreshadow_occurrences BEGIN
            INSERT INTO relationship_source_index_queue(work_id, source_type, source_id, queued_at)
            SELECT foreshadow.work_id, 'foreshadow', new.foreshadow_id, datetime('now')
            FROM foreshadows foreshadow WHERE foreshadow.id = new.foreshadow_id
            ON CONFLICT(work_id, source_type, source_id) DO UPDATE SET queued_at = excluded.queued_at;
          END;
          CREATE TRIGGER IF NOT EXISTS relationship_index_occurrences_bd BEFORE DELETE ON foreshadow_occurrences BEGIN
            INSERT INTO relationship_source_index_queue(work_id, source_type, source_id, queued_at)
            SELECT foreshadow.work_id, 'foreshadow', old.foreshadow_id, datetime('now')
            FROM foreshadows foreshadow WHERE foreshadow.id = old.foreshadow_id
            ON CONFLICT(work_id, source_type, source_id) DO UPDATE SET queued_at = excluded.queued_at;
          END;
          CREATE TRIGGER IF NOT EXISTS relationship_index_memberships_ai AFTER INSERT ON character_organization_memberships BEGIN
            INSERT INTO relationship_source_index_queue(work_id, source_type, source_id, queued_at)
            SELECT work_id, 'character', new.character_id, datetime('now') FROM characters WHERE id = new.character_id
            ON CONFLICT(work_id, source_type, source_id) DO UPDATE SET queued_at = excluded.queued_at;
            INSERT INTO relationship_source_index_queue(work_id, source_type, source_id, queued_at)
            SELECT work_id, 'organization', new.organization_id, datetime('now') FROM organizations WHERE id = new.organization_id
            ON CONFLICT(work_id, source_type, source_id) DO UPDATE SET queued_at = excluded.queued_at;
          END;
          CREATE TRIGGER IF NOT EXISTS relationship_index_memberships_au AFTER UPDATE ON character_organization_memberships BEGIN
            INSERT INTO relationship_source_index_queue(work_id, source_type, source_id, queued_at)
            SELECT work_id, 'character', new.character_id, datetime('now') FROM characters WHERE id = new.character_id
            ON CONFLICT(work_id, source_type, source_id) DO UPDATE SET queued_at = excluded.queued_at;
            INSERT INTO relationship_source_index_queue(work_id, source_type, source_id, queued_at)
            SELECT work_id, 'organization', new.organization_id, datetime('now') FROM organizations WHERE id = new.organization_id
            ON CONFLICT(work_id, source_type, source_id) DO UPDATE SET queued_at = excluded.queued_at;
          END;
          CREATE TRIGGER IF NOT EXISTS relationship_index_memberships_bd BEFORE DELETE ON character_organization_memberships BEGIN
            INSERT INTO relationship_source_index_queue(work_id, source_type, source_id, queued_at)
            SELECT work_id, 'character', old.character_id, datetime('now') FROM characters WHERE id = old.character_id
            ON CONFLICT(work_id, source_type, source_id) DO UPDATE SET queued_at = excluded.queued_at;
            INSERT INTO relationship_source_index_queue(work_id, source_type, source_id, queued_at)
            SELECT work_id, 'organization', old.organization_id, datetime('now') FROM organizations WHERE id = old.organization_id
            ON CONFLICT(work_id, source_type, source_id) DO UPDATE SET queued_at = excluded.queued_at;
          END;
          CREATE TRIGGER IF NOT EXISTS relationship_index_volume_dependencies_au AFTER UPDATE ON volumes BEGIN
            INSERT INTO relationship_source_index_queue(work_id, source_type, source_id, queued_at)
            SELECT chapter.work_id, 'chapter-outline', chapter.id, datetime('now')
            FROM chapters chapter JOIN chapter_outlines outline ON outline.chapter_id = chapter.id
            WHERE chapter.volume_id = new.id
            ON CONFLICT(work_id, source_type, source_id) DO UPDATE SET queued_at = excluded.queued_at;
          END;
          CREATE TRIGGER IF NOT EXISTS relationship_index_chapter_dependencies_au AFTER UPDATE ON chapters BEGIN
            INSERT INTO relationship_source_index_queue(work_id, source_type, source_id, queued_at)
            SELECT new.work_id, 'chapter-outline', new.id, datetime('now')
            WHERE EXISTS(SELECT 1 FROM chapter_outlines WHERE chapter_id = new.id)
            ON CONFLICT(work_id, source_type, source_id) DO UPDATE SET queued_at = excluded.queued_at;
            INSERT INTO relationship_source_index_queue(work_id, source_type, source_id, queued_at)
            SELECT foreshadow.work_id, 'foreshadow', foreshadow.id, datetime('now')
            FROM foreshadows foreshadow JOIN foreshadow_occurrences occurrence ON occurrence.foreshadow_id = foreshadow.id
            WHERE occurrence.chapter_id = new.id
            ON CONFLICT(work_id, source_type, source_id) DO UPDATE SET queued_at = excluded.queued_at;
          END;
          CREATE TRIGGER IF NOT EXISTS relationship_index_character_dependencies_au AFTER UPDATE ON characters BEGIN
            INSERT INTO relationship_source_index_queue(work_id, source_type, source_id, queued_at)
            SELECT organization.work_id, 'organization', organization.id, datetime('now')
            FROM organizations organization JOIN character_organization_memberships membership ON membership.organization_id = organization.id
            WHERE membership.character_id = new.id
            ON CONFLICT(work_id, source_type, source_id) DO UPDATE SET queued_at = excluded.queued_at;
            INSERT INTO relationship_source_index_queue(work_id, source_type, source_id, queued_at)
            SELECT race.work_id, 'race', race.id, datetime('now') FROM races race
            WHERE race.id IN (old.race_id, new.race_id)
            ON CONFLICT(work_id, source_type, source_id) DO UPDATE SET queued_at = excluded.queued_at;
            INSERT INTO relationship_source_index_queue(work_id, source_type, source_id, queued_at)
            SELECT event.work_id, 'timeline-event', event.id, datetime('now') FROM timeline_events event
            WHERE EXISTS(SELECT 1 FROM json_each(event.participant_ids_json) participant WHERE participant.value = new.id)
            ON CONFLICT(work_id, source_type, source_id) DO UPDATE SET queued_at = excluded.queued_at;
            INSERT INTO relationship_source_index_queue(work_id, source_type, source_id, queued_at)
            SELECT relation.work_id, 'relationship', relation.id, datetime('now') FROM relationships relation
            WHERE relation.from_character_id = new.id OR relation.to_character_id = new.id
            ON CONFLICT(work_id, source_type, source_id) DO UPDATE SET queued_at = excluded.queued_at;
          END;
          CREATE TRIGGER IF NOT EXISTS relationship_index_race_dependencies_au AFTER UPDATE ON races BEGIN
            INSERT INTO relationship_source_index_queue(work_id, source_type, source_id, queued_at)
            SELECT race.work_id, 'race', race.id, datetime('now') FROM races race
            WHERE race.id IN (
              WITH RECURSIVE descendants(id) AS (
                SELECT new.id
                UNION ALL
                SELECT child.id FROM races child JOIN descendants parent ON child.parent_race_id = parent.id
              )
              SELECT id FROM descendants
            )
            ON CONFLICT(work_id, source_type, source_id) DO UPDATE SET queued_at = excluded.queued_at;
            INSERT INTO relationship_source_index_queue(work_id, source_type, source_id, queued_at)
            SELECT character.work_id, 'character', character.id, datetime('now') FROM characters character
            WHERE character.race_id IN (
              WITH RECURSIVE descendants(id) AS (
                SELECT new.id
                UNION ALL
                SELECT child.id FROM races child JOIN descendants parent ON child.parent_race_id = parent.id
              )
              SELECT id FROM descendants
            )
            ON CONFLICT(work_id, source_type, source_id) DO UPDATE SET queued_at = excluded.queued_at;
          END;
          CREATE TRIGGER IF NOT EXISTS relationship_index_organization_dependencies_au AFTER UPDATE ON organizations BEGIN
            INSERT INTO relationship_source_index_queue(work_id, source_type, source_id, queued_at)
            SELECT character.work_id, 'character', character.id, datetime('now')
            FROM characters character JOIN character_organization_memberships membership ON membership.character_id = character.id
            WHERE membership.organization_id = new.id
            ON CONFLICT(work_id, source_type, source_id) DO UPDATE SET queued_at = excluded.queued_at;
          END;
        `);

        const timestamp = new Date().toISOString();
        for (const source of queueSources) {
          const workColumn = source.table === "works" ? "id" : "work_id";
          this.run(
            `INSERT INTO relationship_source_index_queue(work_id, source_type, source_id, queued_at)
             SELECT ${workColumn}, ?, ${source.idColumn}, ? FROM ${source.table}
             WHERE 1
             ON CONFLICT(work_id, source_type, source_id) DO UPDATE SET queued_at = excluded.queued_at`,
            source.sourceType,
            timestamp
          );
        }
        this.run(
          `INSERT INTO relationship_source_index_queue(work_id, source_type, source_id, queued_at)
           SELECT chapter.work_id, 'chapter-outline', outline.chapter_id, ?
           FROM chapter_outlines outline JOIN chapters chapter ON chapter.id = outline.chapter_id
           WHERE 1
           ON CONFLICT(work_id, source_type, source_id) DO UPDATE SET queued_at = excluded.queued_at`,
          timestamp
        );
        this.run(
          `INSERT INTO relationship_source_index_state(work_id, status, generation, error, updated_at)
           SELECT id, 'queued', 0, '', ? FROM works
           WHERE 1
           ON CONFLICT(work_id) DO UPDATE SET status = 'queued', error = '', updated_at = excluded.updated_at`,
          timestamp
        );
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (45, ?)", timestamp);
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(46)) {
      this.transaction(() => {
        this.raw.exec(`
          DROP TRIGGER IF EXISTS relationship_index_volume_dependencies_au;
          CREATE TRIGGER relationship_index_volume_dependencies_au AFTER UPDATE ON volumes BEGIN
            INSERT INTO relationship_source_index_queue(work_id, source_type, source_id, queued_at)
            SELECT chapter.work_id, 'chapter-outline', chapter.id, datetime('now')
            FROM chapters chapter JOIN chapter_outlines outline ON outline.chapter_id = chapter.id
            WHERE chapter.volume_id = new.id
            ON CONFLICT(work_id, source_type, source_id) DO UPDATE SET queued_at = excluded.queued_at;
            INSERT INTO relationship_source_index_queue(work_id, source_type, source_id, queued_at)
            SELECT DISTINCT foreshadow.work_id, 'foreshadow', foreshadow.id, datetime('now')
            FROM foreshadows foreshadow
            JOIN foreshadow_occurrences occurrence ON occurrence.foreshadow_id = foreshadow.id
            JOIN chapters chapter ON chapter.id = occurrence.chapter_id
            WHERE chapter.volume_id = new.id
            ON CONFLICT(work_id, source_type, source_id) DO UPDATE SET queued_at = excluded.queued_at;
          END;
        `);
        const timestamp = new Date().toISOString();
        this.run(
          `INSERT INTO relationship_source_index_queue(work_id, source_type, source_id, queued_at)
           SELECT work_id, 'foreshadow', id, ? FROM foreshadows
           WHERE 1
           ON CONFLICT(work_id, source_type, source_id) DO UPDATE SET queued_at = excluded.queued_at`,
          timestamp
        );
        this.run(
          `UPDATE relationship_source_index_state SET status = 'queued', error = '', updated_at = ?
           WHERE work_id IN (SELECT DISTINCT work_id FROM foreshadows)`,
          timestamp
        );
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (46, ?)", timestamp);
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(47)) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(providers)").map((row) => String(row.name)));
        if (!columns.has("protocol")) {
          this.run(`ALTER TABLE providers ADD COLUMN protocol TEXT NOT NULL DEFAULT 'openai-chat-completions'
            CHECK(protocol IN ('openai-chat-completions', 'anthropic-messages'))`);
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (47, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(48)) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(ai_calls)").map((row) => String(row.name)));
        if (!columns.has("input_tokens")) {
          this.run("ALTER TABLE ai_calls ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0 CHECK(input_tokens >= 0)");
        }
        if (!columns.has("output_tokens")) {
          this.run("ALTER TABLE ai_calls ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0 CHECK(output_tokens >= 0)");
        }
        if (!columns.has("cached_input_tokens")) {
          this.run("ALTER TABLE ai_calls ADD COLUMN cached_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK(cached_input_tokens >= 0)");
        }
        if (!columns.has("cache_eligible_input_tokens")) {
          this.run("ALTER TABLE ai_calls ADD COLUMN cache_eligible_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK(cache_eligible_input_tokens >= 0)");
        }
        if (!columns.has("cache_usage_available")) {
          this.run("ALTER TABLE ai_calls ADD COLUMN cache_usage_available INTEGER NOT NULL DEFAULT 0 CHECK(cache_usage_available IN (0, 1))");
        }
        if (!columns.has("token_usage_source")) {
          this.run(`ALTER TABLE ai_calls ADD COLUMN token_usage_source TEXT NOT NULL DEFAULT 'estimated'
            CHECK(token_usage_source IN ('reported', 'estimated', 'mixed'))`);
        }
        this.run(
          `UPDATE ai_calls
           SET input_tokens = CASE WHEN input_chars > 0 THEN input_chars ELSE 0 END,
               output_tokens = CASE WHEN output_chars > 0 THEN output_chars ELSE 0 END,
               token_usage_source = 'estimated'
           WHERE status = 'completed' AND input_tokens = 0 AND output_tokens = 0`
        );
        this.run("CREATE INDEX IF NOT EXISTS idx_calls_usage_daily ON ai_calls(created_at, work_id)");
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (48, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(49)) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(chapters)").map((row) => String(row.name)));
        if (!columns.has("deleted_at")) {
          this.run("ALTER TABLE chapters ADD COLUMN deleted_at TEXT");
        }
        this.run("CREATE INDEX IF NOT EXISTS idx_chapters_active_work ON chapters(work_id, deleted_at, volume_id, sort_order)");
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (49, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(50)) {
      this.transaction(() => {
        this.run(`
          CREATE TABLE IF NOT EXISTS writing_goals (
            work_id TEXT PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
            daily_goal INTEGER NOT NULL DEFAULT 1000 CHECK(daily_goal >= 0 AND daily_goal <= 1000000),
            target_total INTEGER NOT NULL DEFAULT 100000 CHECK(target_total >= 0 AND target_total <= 100000000),
            deadline TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
          )
        `);
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (50, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(51)) {
      this.transaction(() => {
        this.run(`CREATE TABLE IF NOT EXISTS chapter_annotations (
          id TEXT PRIMARY KEY,
          work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
          chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK(kind IN ('note', 'todo')),
          start_line INTEGER NOT NULL CHECK(start_line > 0),
          end_line INTEGER NOT NULL CHECK(end_line >= start_line),
          quote TEXT NOT NULL,
          note TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'resolved')),
          version_no INTEGER NOT NULL DEFAULT 1,
          deleted_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
        )`);
        this.run(`CREATE TABLE IF NOT EXISTS chapter_annotation_versions (
          id TEXT PRIMARY KEY,
          annotation_id TEXT NOT NULL REFERENCES chapter_annotations(id) ON DELETE CASCADE,
          version_no INTEGER NOT NULL,
          snapshot_json TEXT NOT NULL,
          source TEXT NOT NULL,
          created_at TEXT NOT NULL,
          created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          UNIQUE(annotation_id, version_no)
        )`);
        this.run("CREATE INDEX IF NOT EXISTS idx_chapter_annotations_chapter ON chapter_annotations(chapter_id, deleted_at, status, created_at)");
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (51, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(52)) {
      this.transaction(() => {
        this.run(`CREATE INDEX IF NOT EXISTS idx_chapter_paragraph_short_terms_paragraph
          ON chapter_paragraph_short_terms(paragraph_id)`);
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (52, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(53)) {
      this.transaction(() => {
        const timestamp = new Date().toISOString();
        this.run(
          `INSERT INTO relationship_source_index_queue(work_id, source_type, source_id, queued_at)
           SELECT work_id, source_type, source_id, ? FROM relationship_source_search WHERE true
           ON CONFLICT(work_id, source_type, source_id) DO UPDATE SET queued_at = excluded.queued_at`,
          timestamp
        );
        this.run(
          `INSERT INTO relationship_source_index_queue(work_id, source_type, source_id, queued_at)
           SELECT work_id, 'chapter', id, ? FROM chapters WHERE deleted_at IS NULL
           ON CONFLICT(work_id, source_type, source_id) DO UPDATE SET queued_at = excluded.queued_at`,
          timestamp
        );
        this.run(
          `UPDATE relationship_source_index_state SET status = 'queued', error = '', updated_at = ?
           WHERE work_id IN (SELECT DISTINCT work_id FROM relationship_source_index_queue)`,
          timestamp
        );
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (53, ?)", timestamp);
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(54)) {
      this.transaction(() => {
        const settingsColumns = new Set(this.all("PRAGMA table_info(work_ai_settings)").map((row) => String(row.name)));
        if (!settingsColumns.has("auto_run_daily_task_limit")) {
          this.run("ALTER TABLE work_ai_settings ADD COLUMN auto_run_daily_task_limit INTEGER NOT NULL DEFAULT 0 CHECK(auto_run_daily_task_limit BETWEEN 0 AND 10000)");
        }
        if (!settingsColumns.has("auto_run_failure_threshold")) {
          this.run("ALTER TABLE work_ai_settings ADD COLUMN auto_run_failure_threshold INTEGER NOT NULL DEFAULT 3 CHECK(auto_run_failure_threshold BETWEEN 1 AND 10)");
        }
        if (!settingsColumns.has("auto_run_paused")) {
          this.run("ALTER TABLE work_ai_settings ADD COLUMN auto_run_paused INTEGER NOT NULL DEFAULT 0 CHECK(auto_run_paused IN (0, 1))");
        }
        if (!settingsColumns.has("auto_run_pause_reason")) {
          this.run("ALTER TABLE work_ai_settings ADD COLUMN auto_run_pause_reason TEXT NOT NULL DEFAULT ''");
        }
        if (!settingsColumns.has("auto_run_resume_at")) {
          this.run("ALTER TABLE work_ai_settings ADD COLUMN auto_run_resume_at TEXT");
        }
        if (!settingsColumns.has("auto_run_consecutive_failures")) {
          this.run("ALTER TABLE work_ai_settings ADD COLUMN auto_run_consecutive_failures INTEGER NOT NULL DEFAULT 0");
        }
        const taskColumns = new Set(this.all("PRAGMA table_info(analysis_tasks)").map((row) => String(row.name)));
        if (!taskColumns.has("attempt_count")) {
          this.run("ALTER TABLE analysis_tasks ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0");
        }
        if (!taskColumns.has("next_attempt_at")) {
          this.run("ALTER TABLE analysis_tasks ADD COLUMN next_attempt_at TEXT");
        }
        if (!taskColumns.has("last_attempt_at")) {
          this.run("ALTER TABLE analysis_tasks ADD COLUMN last_attempt_at TEXT");
        }
        this.run("CREATE INDEX IF NOT EXISTS idx_tasks_auto_run_ready ON analysis_tasks(work_id, status, next_attempt_at, created_at)");
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (54, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(55)) {
      this.transaction(() => {
        this.run(`CREATE TABLE IF NOT EXISTS drafts (
          id TEXT PRIMARY KEY,
          work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
          draft_type TEXT NOT NULL CHECK(draft_type IN ('prose', 'setting')),
          title TEXT NOT NULL,
          content TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`);
        this.run("CREATE INDEX IF NOT EXISTS idx_drafts_work ON drafts(work_id, draft_type, updated_at DESC)");
        const aiSettings = this.all<{ work_id: string; agent_tools_json: string }>("SELECT work_id, agent_tools_json FROM work_ai_settings");
        for (const row of aiSettings) {
          let tools: unknown = [];
          try {
            tools = JSON.parse(row.agent_tools_json) as unknown;
          } catch {
            tools = [];
          }
          const next = Array.isArray(tools)
            ? [...new Set([...tools.filter((tool): tool is string => typeof tool === "string"), "search_drafts"])]
            : ["story_index", "read_chapters", "search_story_entities", "grep", "read_character_sections", "search_drafts"];
          this.run("UPDATE work_ai_settings SET agent_tools_json = ? WHERE work_id = ?", JSON.stringify(next), row.work_id);
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (55, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(56)) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(ai_conversation_messages)").map((row) => String(row.name)));
        if (!columns.has("request_id")) {
          this.run("ALTER TABLE ai_conversation_messages ADD COLUMN request_id TEXT");
        }
        this.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_conversation_messages_request ON ai_conversation_messages(conversation_id, request_id) WHERE request_id IS NOT NULL");
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (56, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(57)) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(work_ai_settings)").map((row) => String(row.name)));
        if (!columns.has("title_generation_model_id")) {
          this.run("ALTER TABLE work_ai_settings ADD COLUMN title_generation_model_id TEXT REFERENCES models(id) ON DELETE SET NULL");
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (57, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(58)) {
      this.transaction(() => {
        this.run(`CREATE TABLE IF NOT EXISTS attachment_access_modules (
          attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
          module TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(attachment_id, module)
        ) WITHOUT ROWID`);
        this.run("CREATE INDEX IF NOT EXISTS idx_attachment_access_modules_module ON attachment_access_modules(module, attachment_id)");
        const timestamp = new Date().toISOString();
        this.run(`INSERT OR IGNORE INTO attachment_access_modules (attachment_id, module, created_at)
          SELECT attachment_id,
            CASE entity_type
              WHEN 'draft' THEN 'drafts'
              WHEN 'setting' THEN 'settings'
              WHEN 'race' THEN 'races'
              WHEN 'organization' THEN 'organizations'
              WHEN 'character-section' THEN 'characters'
              WHEN 'chapter' THEN 'prose'
              ELSE 'settings'
            END,
            ?
          FROM attachment_references`, timestamp);
        this.run(`INSERT OR IGNORE INTO attachment_access_modules (attachment_id, module, created_at)
          SELECT attachment.id, 'settings', ? FROM attachments attachment
          WHERE NOT EXISTS (
            SELECT 1 FROM attachment_access_modules access WHERE access.attachment_id = attachment.id
          )`, timestamp);
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (58, ?)", timestamp);
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(59)) {
      this.transaction(() => {
        this.run(`CREATE TABLE IF NOT EXISTS attachment_cleanup_queue (
          storage_key TEXT PRIMARY KEY,
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) WITHOUT ROWID`);
        this.run("CREATE INDEX IF NOT EXISTS idx_attachment_cleanup_queue_updated ON attachment_cleanup_queue(updated_at, storage_key)");
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (59, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(60)) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(drafts)").map((row) => String(row.name)));
        if (!columns.has("volume_id")) {
          this.run("ALTER TABLE drafts ADD COLUMN volume_id TEXT REFERENCES volumes(id) ON DELETE SET NULL");
        }
        if (!columns.has("setting_module")) {
          this.run("ALTER TABLE drafts ADD COLUMN setting_module TEXT");
        }
        this.run("CREATE INDEX IF NOT EXISTS idx_drafts_volume ON drafts(volume_id)");
        this.run("CREATE INDEX IF NOT EXISTS idx_drafts_setting_module ON drafts(work_id, setting_module)");
        this.run(`CREATE TRIGGER IF NOT EXISTS drafts_binding_insert
          BEFORE INSERT ON drafts
          WHEN (NEW.draft_type = 'prose' AND NEW.setting_module IS NOT NULL)
            OR (NEW.draft_type = 'setting' AND NEW.volume_id IS NOT NULL)
            OR (NEW.setting_module IS NOT NULL AND NEW.setting_module NOT IN ('settings', 'characters', 'races', 'organizations', 'timeline', 'relationships', 'outlines'))
            OR (NEW.volume_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM volumes WHERE id = NEW.volume_id AND work_id = NEW.work_id))
          BEGIN SELECT RAISE(ABORT, 'invalid draft binding'); END`);
        this.run(`CREATE TRIGGER IF NOT EXISTS drafts_binding_update
          BEFORE UPDATE OF work_id, draft_type, volume_id, setting_module ON drafts
          WHEN (NEW.draft_type = 'prose' AND NEW.setting_module IS NOT NULL)
            OR (NEW.draft_type = 'setting' AND NEW.volume_id IS NOT NULL)
            OR (NEW.setting_module IS NOT NULL AND NEW.setting_module NOT IN ('settings', 'characters', 'races', 'organizations', 'timeline', 'relationships', 'outlines'))
            OR (NEW.volume_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM volumes WHERE id = NEW.volume_id AND work_id = NEW.work_id))
          BEGIN SELECT RAISE(ABORT, 'invalid draft binding'); END`);
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (60, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(61)) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(work_ai_settings)").map((row) => String(row.name)));
        if (!columns.has("agent_tool_call_limit")) {
          this.run("ALTER TABLE work_ai_settings ADD COLUMN agent_tool_call_limit INTEGER NOT NULL DEFAULT 12 CHECK(agent_tool_call_limit BETWEEN 5 AND 48)");
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (61, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(62)) {
      this.transaction(() => {
        this.run("UPDATE work_ai_settings SET agent_tool_call_limit = 5 WHERE agent_tool_call_limit < 5");
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (62, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(63)) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(work_ai_settings)").map((row) => String(row.name)));
        if (!columns.has("agent_tool_call_global_multiplier")) {
          this.run("ALTER TABLE work_ai_settings ADD COLUMN agent_tool_call_global_multiplier INTEGER NOT NULL DEFAULT 3 CHECK(agent_tool_call_global_multiplier BETWEEN 2 AND 10)");
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (63, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(64)) {
      this.transaction(() => {
        this.run(`CREATE TABLE work_ai_settings_v64 (
          work_id TEXT PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
          system_prompt TEXT NOT NULL DEFAULT '',
          auto_run_enabled INTEGER NOT NULL DEFAULT 0,
          auto_run_concurrency INTEGER NOT NULL DEFAULT 2,
          auto_run_batch_limit INTEGER NOT NULL DEFAULT 20,
          auto_run_daily_task_limit INTEGER NOT NULL DEFAULT 0 CHECK(auto_run_daily_task_limit BETWEEN 0 AND 10000),
          auto_run_failure_threshold INTEGER NOT NULL DEFAULT 3 CHECK(auto_run_failure_threshold BETWEEN 1 AND 10),
          auto_run_paused INTEGER NOT NULL DEFAULT 0 CHECK(auto_run_paused IN (0, 1)),
          auto_run_pause_reason TEXT NOT NULL DEFAULT '',
          auto_run_resume_at TEXT,
          auto_run_consecutive_failures INTEGER NOT NULL DEFAULT 0,
          book_summary_context_percent INTEGER NOT NULL DEFAULT 50 CHECK(book_summary_context_percent BETWEEN 1 AND 90),
          context_compact_threshold INTEGER NOT NULL DEFAULT 85 CHECK(context_compact_threshold BETWEEN 50 AND 90),
          agent_tool_call_limit INTEGER NOT NULL DEFAULT 12 CHECK(agent_tool_call_limit BETWEEN 5 AND 48),
          agent_tool_call_global_multiplier INTEGER NOT NULL DEFAULT 3 CHECK(agent_tool_call_global_multiplier BETWEEN 1 AND 6),
          agent_tools_json TEXT NOT NULL DEFAULT '["story_index","read_chapters","search_story_entities","grep","read_character_sections","search_drafts"]',
          title_generation_model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
          updated_at TEXT NOT NULL
        )`);
        this.run(`INSERT INTO work_ai_settings_v64 (
          work_id, system_prompt, auto_run_enabled, auto_run_concurrency, auto_run_batch_limit,
          auto_run_daily_task_limit, auto_run_failure_threshold, auto_run_paused, auto_run_pause_reason,
          auto_run_resume_at, auto_run_consecutive_failures, book_summary_context_percent,
          context_compact_threshold, agent_tool_call_limit, agent_tool_call_global_multiplier,
          agent_tools_json, title_generation_model_id, updated_at
        )
        SELECT
          work_id, system_prompt, auto_run_enabled, auto_run_concurrency, auto_run_batch_limit,
          auto_run_daily_task_limit, auto_run_failure_threshold, auto_run_paused, auto_run_pause_reason,
          auto_run_resume_at, auto_run_consecutive_failures, book_summary_context_percent,
          context_compact_threshold, agent_tool_call_limit,
          CASE
            WHEN agent_tool_call_global_multiplier < 1 THEN 1
            WHEN agent_tool_call_global_multiplier > 6 THEN 6
            ELSE agent_tool_call_global_multiplier
          END,
          agent_tools_json, title_generation_model_id, updated_at
        FROM work_ai_settings`);
        this.run("DROP TABLE work_ai_settings");
        this.run("ALTER TABLE work_ai_settings_v64 RENAME TO work_ai_settings");
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (64, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(65)) {
      this.transaction(() => {
        const conversationColumns = new Set(this.all("PRAGMA table_info(ai_conversations)").map((row) => String(row.name)));
        if (!conversationColumns.has("agent_tools_json")) {
          this.run("ALTER TABLE ai_conversations ADD COLUMN agent_tools_json TEXT");
        }
        const workSettingsColumns = new Set(this.all("PRAGMA table_info(work_ai_settings)").map((row) => String(row.name)));
        if (!workSettingsColumns.has("daily_token_quota")) {
          this.run("ALTER TABLE work_ai_settings ADD COLUMN daily_token_quota INTEGER CHECK(daily_token_quota IS NULL OR daily_token_quota >= 10000)");
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (65, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(66)) {
      this.raw.exec("PRAGMA foreign_keys = OFF");
      try {
        this.transaction(() => {
          this.run(`CREATE TABLE providers_v66 (
            id TEXT PRIMARY KEY,
            work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            base_url TEXT NOT NULL,
            protocol TEXT NOT NULL DEFAULT 'openai-chat-completions' CHECK(protocol IN ('openai-chat-completions', 'anthropic-messages', 'google-vertex')),
            encrypted_key TEXT NOT NULL,
            key_iv TEXT NOT NULL,
            key_tag TEXT NOT NULL,
            key_hint TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'disabled',
            connection_status TEXT NOT NULL DEFAULT 'unchecked',
            concurrency_limit INTEGER NOT NULL DEFAULT 10 CHECK(concurrency_limit BETWEEN 1 AND 100),
            rpm_limit INTEGER NOT NULL DEFAULT 10 CHECK(rpm_limit BETWEEN 1 AND 10000),
            max_tokens INTEGER NOT NULL DEFAULT 32000 CHECK(max_tokens BETWEEN 1 AND 32768),
            default_model_id TEXT,
            note TEXT NOT NULL DEFAULT '',
            last_error TEXT,
            last_success_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          )`);
          this.run(`INSERT INTO providers_v66 (
            id, work_id, name, base_url, protocol, encrypted_key, key_iv, key_tag, key_hint, status,
            connection_status, concurrency_limit, rpm_limit, max_tokens, default_model_id, note,
            last_error, last_success_at, created_at, updated_at
          )
          SELECT
            id, work_id, name, base_url, protocol, encrypted_key, key_iv, key_tag, key_hint, status,
            connection_status, concurrency_limit, rpm_limit, max_tokens, default_model_id, note,
            last_error, last_success_at, created_at, updated_at
          FROM providers`);
          this.run("DROP TABLE providers");
          this.run("ALTER TABLE providers_v66 RENAME TO providers");
          this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (66, ?)", new Date().toISOString());
        });
      } finally {
        this.raw.exec("PRAGMA foreign_keys = ON");
      }
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(67)) {
      this.transaction(() => {
        const conversationColumns = new Set(this.all("PRAGMA table_info(ai_conversations)").map((row) => String(row.name)));
        if (!conversationColumns.has("injected_entities_json")) {
          this.run(`ALTER TABLE ai_conversations ADD COLUMN injected_entities_json TEXT NOT NULL DEFAULT '{"characters":[],"races":[],"organizations":[]}'`);
        }
        if (!conversationColumns.has("system_clock_text")) {
          this.run("ALTER TABLE ai_conversations ADD COLUMN system_clock_text TEXT NOT NULL DEFAULT ''");
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (67, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(68)) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(ai_conversations)").map((row) => String(row.name)));
        if (!columns.has("roleplay_character_id")) {
          this.run("ALTER TABLE ai_conversations ADD COLUMN roleplay_character_id TEXT REFERENCES characters(id) ON DELETE SET NULL");
        }
        this.run("CREATE INDEX IF NOT EXISTS idx_ai_conversations_roleplay_character ON ai_conversations(roleplay_character_id)");
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (68, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(69)) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(ai_conversations)").map((row) => String(row.name)));
        if (!columns.has("task_type")) {
          this.run("ALTER TABLE ai_conversations ADD COLUMN task_type TEXT CHECK(task_type IN ('chat', 'roleplay', 'continue', 'polish'))");
        }
        this.run("UPDATE ai_conversations SET task_type = CASE WHEN roleplay_character_id IS NOT NULL THEN 'roleplay' ELSE 'chat' END WHERE task_type IS NULL");
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (69, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(70)) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(ai_conversations)").map((row) => String(row.name)));
        if (!columns.has("context_scope_json")) {
          this.run("ALTER TABLE ai_conversations ADD COLUMN context_scope_json TEXT");
        }
        this.run("UPDATE ai_conversations SET context_scope_json = '{\"type\":\"none\"}' WHERE context_scope_json IS NULL");
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (70, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(71)) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(work_ai_settings)").map((row) => String(row.name)));
        if (!columns.has("always_include_setting_info")) {
          this.run("ALTER TABLE work_ai_settings ADD COLUMN always_include_setting_info INTEGER NOT NULL DEFAULT 0 CHECK(always_include_setting_info IN (0, 1))");
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (71, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(72)) {
      this.transaction(() => {
        const characterColumns = new Set(this.all("PRAGMA table_info(characters)").map((row) => String(row.name)));
        if (!characterColumns.has("is_dead")) {
          this.run("ALTER TABLE characters ADD COLUMN is_dead INTEGER NOT NULL DEFAULT 0 CHECK(is_dead IN (0, 1))");
        }
        const raceColumns = new Set(this.all("PRAGMA table_info(races)").map((row) => String(row.name)));
        if (!raceColumns.has("is_extinct")) {
          this.run("ALTER TABLE races ADD COLUMN is_extinct INTEGER NOT NULL DEFAULT 0 CHECK(is_extinct IN (0, 1))");
        }
        const organizationColumns = new Set(this.all("PRAGMA table_info(organizations)").map((row) => String(row.name)));
        if (!organizationColumns.has("is_dissolved")) {
          this.run("ALTER TABLE organizations ADD COLUMN is_dissolved INTEGER NOT NULL DEFAULT 0 CHECK(is_dissolved IN (0, 1))");
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (72, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    const s3TargetsPresent = this.all("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 's3_backup_targets'").length > 0;
    const modelColumnsAt73 = new Set(this.all("PRAGMA table_info(models)").map((row) => String(row.name)));
    const platformAiColumnsAt73 = new Set(this.all("PRAGMA table_info(platform_ai_settings)").map((row) => String(row.name)));
    const workAiColumnsAt73 = new Set(this.all("PRAGMA table_info(work_ai_settings)").map((row) => String(row.name)));
    const multimodalMigrationPresent = modelColumnsAt73.has("multimodal_enabled")
      && platformAiColumnsAt73.has("image_tool_model_id")
      && workAiColumnsAt73.has("image_tool_model_id");
    if (!applied.has(73) || !s3TargetsPresent || !multimodalMigrationPresent) {
      this.transaction(() => {
        this.run(`CREATE TABLE IF NOT EXISTS s3_backup_targets (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          endpoint TEXT NOT NULL,
          region TEXT NOT NULL DEFAULT 'us-east-1',
          bucket TEXT NOT NULL,
          base_path TEXT NOT NULL DEFAULT '',
          access_key_encrypted TEXT NOT NULL,
          access_key_iv TEXT NOT NULL,
          access_key_tag TEXT NOT NULL,
          secret_key_encrypted TEXT NOT NULL,
          secret_key_iv TEXT NOT NULL,
          secret_key_tag TEXT NOT NULL,
          force_path_style INTEGER NOT NULL DEFAULT 1 CHECK(force_path_style IN (0, 1)),
          enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
          backup_images INTEGER NOT NULL DEFAULT 1 CHECK(backup_images IN (0, 1)),
          schedule_time TEXT NOT NULL DEFAULT '03:00' CHECK(
            schedule_time GLOB '[0-2][0-9]:[0-5][0-9]'
            AND substr(schedule_time, 1, 2) <= '23'
          ),
          retention_count INTEGER NOT NULL DEFAULT 7 CHECK(retention_count BETWEEN 1 AND 365),
          last_started_at TEXT,
          last_success_at TEXT,
          last_failure_at TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`);
        this.run("CREATE INDEX IF NOT EXISTS idx_s3_backup_targets_schedule ON s3_backup_targets(enabled, schedule_time, created_at)");
        const modelColumns = new Set(this.all("PRAGMA table_info(models)").map((row) => String(row.name)));
        if (!modelColumns.has("multimodal_enabled")) {
          this.run("ALTER TABLE models ADD COLUMN multimodal_enabled INTEGER NOT NULL DEFAULT 0 CHECK(multimodal_enabled IN (0, 1))");
        }
        const platformColumns = new Set(this.all("PRAGMA table_info(platform_ai_settings)").map((row) => String(row.name)));
        if (!platformColumns.has("image_tool_model_id")) {
          this.run("ALTER TABLE platform_ai_settings ADD COLUMN image_tool_model_id TEXT REFERENCES models(id) ON DELETE SET NULL");
        }
        const workColumns = new Set(this.all("PRAGMA table_info(work_ai_settings)").map((row) => String(row.name)));
        if (!workColumns.has("image_tool_model_id")) {
          this.run("ALTER TABLE work_ai_settings ADD COLUMN image_tool_model_id TEXT REFERENCES models(id) ON DELETE SET NULL");
        }
        for (const row of this.all("SELECT work_id, agent_tools_json FROM work_ai_settings")) {
          let tools: unknown[] = [];
          try {
            const parsed = JSON.parse(String(row.agent_tools_json ?? "[]")) as unknown;
            tools = Array.isArray(parsed) ? parsed : [];
          } catch {
            tools = [];
          }
          if (tools.includes("image")) continue;
          tools.push("image");
          this.run("UPDATE work_ai_settings SET agent_tools_json = ? WHERE work_id = ?", JSON.stringify(tools), String(row.work_id));
        }
        this.run("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (73, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    const s3RunsPresent = this.all("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 's3_backup_runs'").length > 0;
    const aiHistorySearchPresent = this.all("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ai_history_search'").length > 0;
    if (!applied.has(74) || !s3RunsPresent || !aiHistorySearchPresent) {
      this.transaction(() => {
        this.run(`CREATE TABLE IF NOT EXISTS s3_backup_runs (
          id TEXT PRIMARY KEY,
          target_id TEXT REFERENCES s3_backup_targets(id) ON DELETE SET NULL,
          target_name TEXT NOT NULL,
          trigger TEXT NOT NULL CHECK(trigger IN ('manual', 'scheduled')),
          status TEXT NOT NULL CHECK(status IN ('running', 'succeeded', 'failed')),
          database_key TEXT,
          images_uploaded INTEGER NOT NULL DEFAULT 0,
          images_skipped INTEGER NOT NULL DEFAULT 0,
          databases_deleted INTEGER NOT NULL DEFAULT 0,
          error_message TEXT,
          server_response_json TEXT,
          started_at TEXT NOT NULL,
          finished_at TEXT
        )`);
        this.run("CREATE INDEX IF NOT EXISTS idx_s3_backup_runs_started ON s3_backup_runs(started_at DESC, id)");
        this.run("CREATE INDEX IF NOT EXISTS idx_s3_backup_runs_target ON s3_backup_runs(target_id, started_at DESC)");
        this.raw.exec(`
          CREATE TABLE IF NOT EXISTS ai_history_search (
            id INTEGER PRIMARY KEY,
            work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
            conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
            message_id TEXT REFERENCES ai_conversation_messages(id) ON DELETE CASCADE,
            source_type TEXT NOT NULL CHECK(source_type IN ('conversation', 'message')),
            source_id TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT '' CHECK(role IN ('', 'user', 'assistant')),
            title TEXT NOT NULL DEFAULT '',
            content TEXT NOT NULL DEFAULT '',
            search_content TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(source_type, source_id)
          );
          CREATE INDEX IF NOT EXISTS idx_ai_history_search_work
            ON ai_history_search(work_id, created_at DESC, id DESC);
          CREATE INDEX IF NOT EXISTS idx_ai_history_search_conversation
            ON ai_history_search(work_id, conversation_id, source_type, created_at DESC, id DESC);
          CREATE VIRTUAL TABLE IF NOT EXISTS ai_history_search_fts USING fts5(
            search_content,
            content='ai_history_search',
            content_rowid='id',
            tokenize='trigram'
          );
          CREATE TRIGGER IF NOT EXISTS ai_history_search_ai AFTER INSERT ON ai_history_search BEGIN
            INSERT INTO ai_history_search_fts(rowid, search_content) VALUES (new.id, new.search_content);
          END;
          CREATE TRIGGER IF NOT EXISTS ai_history_search_ad AFTER DELETE ON ai_history_search BEGIN
            INSERT INTO ai_history_search_fts(ai_history_search_fts, rowid, search_content)
            VALUES ('delete', old.id, old.search_content);
          END;
          CREATE TRIGGER IF NOT EXISTS ai_history_search_au AFTER UPDATE ON ai_history_search BEGIN
            INSERT INTO ai_history_search_fts(ai_history_search_fts, rowid, search_content)
            VALUES ('delete', old.id, old.search_content);
            INSERT INTO ai_history_search_fts(rowid, search_content) VALUES (new.id, new.search_content);
          END;
          CREATE TRIGGER IF NOT EXISTS ai_history_search_conversation_ai AFTER INSERT ON ai_conversations BEGIN
            INSERT INTO ai_history_search
              (work_id, conversation_id, message_id, source_type, source_id, role, title, content, search_content, created_at)
            VALUES
              (new.work_id, new.id, NULL, 'conversation', new.id, '', new.title, COALESCE(new.compacted_summary, ''),
               lower(new.title || char(10) || COALESCE(new.compacted_summary, '')), new.created_at);
          END;
          CREATE TRIGGER IF NOT EXISTS ai_history_search_conversation_au AFTER UPDATE OF title, compacted_summary ON ai_conversations BEGIN
            UPDATE ai_history_search
            SET title = new.title,
                content = COALESCE(new.compacted_summary, ''),
                search_content = lower(new.title || char(10) || COALESCE(new.compacted_summary, ''))
            WHERE source_type = 'conversation' AND source_id = new.id;
          END;
          CREATE TRIGGER IF NOT EXISTS ai_history_search_message_ai AFTER INSERT ON ai_conversation_messages BEGIN
            INSERT INTO ai_history_search
              (work_id, conversation_id, message_id, source_type, source_id, role, title, content, search_content, created_at)
            SELECT conversation.work_id, new.conversation_id, new.id, 'message', new.id, new.role, conversation.title,
                   new.content, lower(new.content), new.created_at
            FROM ai_conversations conversation
            WHERE conversation.id = new.conversation_id;
          END;
          CREATE TRIGGER IF NOT EXISTS ai_history_search_message_au AFTER UPDATE OF role, content ON ai_conversation_messages BEGIN
            UPDATE ai_history_search
            SET role = new.role, content = new.content, search_content = lower(new.content)
            WHERE source_type = 'message' AND source_id = new.id;
          END;
          CREATE TABLE IF NOT EXISTS ai_history_search_short_terms (
            search_id INTEGER NOT NULL REFERENCES ai_history_search(id) ON DELETE CASCADE,
            term TEXT NOT NULL,
            PRIMARY KEY(term, search_id)
          ) WITHOUT ROWID;
          CREATE INDEX IF NOT EXISTS idx_ai_history_search_short_terms_search
            ON ai_history_search_short_terms(search_id);
        `);
        this.run(`
          INSERT INTO ai_history_search
            (work_id, conversation_id, message_id, source_type, source_id, role, title, content, search_content, created_at)
          SELECT conversation.work_id, conversation.id, NULL, 'conversation', conversation.id, '', conversation.title,
                 COALESCE(conversation.compacted_summary, ''),
                 lower(conversation.title || char(10) || COALESCE(conversation.compacted_summary, '')),
                 conversation.created_at
          FROM ai_conversations conversation
          WHERE 1
          ON CONFLICT(source_type, source_id) DO UPDATE SET
            work_id = excluded.work_id,
            conversation_id = excluded.conversation_id,
            title = excluded.title,
            content = excluded.content,
            search_content = excluded.search_content,
            created_at = excluded.created_at
        `);
        this.run(`
          INSERT INTO ai_history_search
            (work_id, conversation_id, message_id, source_type, source_id, role, title, content, search_content, created_at)
          SELECT conversation.work_id, message.conversation_id, message.id, 'message', message.id, message.role, conversation.title,
                 message.content, lower(message.content), message.created_at
          FROM ai_conversation_messages message
          JOIN ai_conversations conversation ON conversation.id = message.conversation_id
          WHERE 1
          ON CONFLICT(source_type, source_id) DO UPDATE SET
            work_id = excluded.work_id,
            conversation_id = excluded.conversation_id,
            message_id = excluded.message_id,
            role = excluded.role,
            title = excluded.title,
            content = excluded.content,
            search_content = excluded.search_content,
            created_at = excluded.created_at
        `);
        for (const row of this.all<{ id: number; source_type: string; title: string; content: string }>(
          "SELECT id, source_type, title, content FROM ai_history_search"
        )) {
          const searchContent = row.source_type === "message"
            ? normalizeDocumentSearchText(row.content)
            : normalizeDocumentSearchText(`${row.title}\n${row.content}`);
          this.run("UPDATE ai_history_search SET search_content = ? WHERE id = ?", searchContent, row.id);
        }
        this.run("INSERT INTO ai_history_search_fts(ai_history_search_fts) VALUES ('rebuild')");
        this.run("DELETE FROM ai_history_search_short_terms");
        const insertTerm = this.raw.prepare(
          "INSERT INTO ai_history_search_short_terms (search_id, term) VALUES (?, ?)"
        );
        for (const row of this.all<{ id: number; search_content: string }>("SELECT id, search_content FROM ai_history_search")) {
          for (const term of documentShortSearchTerms(String(row.search_content))) insertTerm.run(row.id, term);
        }
        this.run("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (74, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    const s3TargetsTablePresentForOrder = this.all("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 's3_backup_targets'").length > 0;
    const s3SortOrderPresent = s3TargetsTablePresentForOrder
      && new Set(this.all("PRAGMA table_info(s3_backup_targets)").map((row) => String(row.name))).has("sort_order");
    if (!applied.has(75) || !s3SortOrderPresent) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(s3_backup_targets)").map((row) => String(row.name)));
        if (!columns.has("sort_order")) {
          this.run("ALTER TABLE s3_backup_targets ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0");
        }
        this.run(`UPDATE s3_backup_targets AS target SET sort_order = (
          SELECT COUNT(*) FROM s3_backup_targets AS previous
          WHERE previous.created_at < target.created_at
             OR (previous.created_at = target.created_at AND previous.id < target.id)
        )`);
        this.run("CREATE INDEX IF NOT EXISTS idx_s3_backup_targets_order ON s3_backup_targets(sort_order, created_at, id)");
        this.run("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (75, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(76)) {
      this.raw.exec("PRAGMA foreign_keys = OFF");
      try {
        this.transaction(() => {
          this.run(`CREATE TABLE work_ai_settings_v76 (
            work_id TEXT PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
            system_prompt TEXT NOT NULL DEFAULT '',
            daily_token_quota INTEGER CHECK(daily_token_quota IS NULL OR daily_token_quota >= 10000),
            auto_run_enabled INTEGER NOT NULL DEFAULT 0,
            auto_run_concurrency INTEGER NOT NULL DEFAULT 2,
            auto_run_batch_limit INTEGER NOT NULL DEFAULT 20,
            auto_run_daily_task_limit INTEGER NOT NULL DEFAULT 0 CHECK(auto_run_daily_task_limit BETWEEN 0 AND 10000),
            auto_run_failure_threshold INTEGER NOT NULL DEFAULT 3 CHECK(auto_run_failure_threshold BETWEEN 1 AND 10),
            auto_run_paused INTEGER NOT NULL DEFAULT 0 CHECK(auto_run_paused IN (0, 1)),
            auto_run_pause_reason TEXT NOT NULL DEFAULT '',
            auto_run_resume_at TEXT,
            auto_run_consecutive_failures INTEGER NOT NULL DEFAULT 0,
            book_summary_context_percent INTEGER NOT NULL DEFAULT 50 CHECK(book_summary_context_percent BETWEEN 1 AND 90),
            context_compact_threshold INTEGER NOT NULL DEFAULT 85 CHECK(context_compact_threshold BETWEEN 50 AND 90),
            agent_tool_call_limit INTEGER NOT NULL DEFAULT 12 CHECK(agent_tool_call_limit BETWEEN 5 AND 1000),
            agent_tool_call_global_multiplier INTEGER NOT NULL DEFAULT 3 CHECK(agent_tool_call_global_multiplier BETWEEN 1 AND 6),
            agent_tools_json TEXT NOT NULL DEFAULT '["story_index","read_chapters","search_story_entities","grep","read_character_sections","search_drafts","image"]',
            title_generation_model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
            image_tool_model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
            always_include_setting_info INTEGER NOT NULL DEFAULT 0 CHECK(always_include_setting_info IN (0, 1)),
            updated_at TEXT NOT NULL
          )`);
          this.run(`INSERT INTO work_ai_settings_v76 (
            work_id, system_prompt, daily_token_quota, auto_run_enabled, auto_run_concurrency, auto_run_batch_limit,
            auto_run_daily_task_limit, auto_run_failure_threshold, auto_run_paused, auto_run_pause_reason,
            auto_run_resume_at, auto_run_consecutive_failures, book_summary_context_percent,
            context_compact_threshold, agent_tool_call_limit, agent_tool_call_global_multiplier,
            agent_tools_json, title_generation_model_id, image_tool_model_id, always_include_setting_info, updated_at
          )
          SELECT
            work_id, system_prompt, daily_token_quota, auto_run_enabled, auto_run_concurrency, auto_run_batch_limit,
            auto_run_daily_task_limit, auto_run_failure_threshold, auto_run_paused, auto_run_pause_reason,
            auto_run_resume_at, auto_run_consecutive_failures, book_summary_context_percent,
            context_compact_threshold,
            CASE
              WHEN agent_tool_call_limit < 5 THEN 5
              WHEN agent_tool_call_limit > 1000 THEN 1000
              ELSE agent_tool_call_limit
            END,
            agent_tool_call_global_multiplier,
            agent_tools_json, title_generation_model_id, image_tool_model_id, always_include_setting_info, updated_at
          FROM work_ai_settings`);
          this.run("DROP TABLE work_ai_settings");
          this.run("ALTER TABLE work_ai_settings_v76 RENAME TO work_ai_settings");
          this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (76, ?)", new Date().toISOString());
        });
      } finally {
        this.raw.exec("PRAGMA foreign_keys = ON");
      }
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(77)) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(platform_ui_settings)").map((row) => String(row.name)));
        if (!columns.has("galaxy_frame_rate")) {
          this.run(`ALTER TABLE platform_ui_settings ADD COLUMN galaxy_frame_rate INTEGER NOT NULL DEFAULT 30
            CHECK(galaxy_frame_rate IN (24, 30, 60))`);
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (77, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(78)) {
      this.transaction(() => {
        this.run(`CREATE TABLE platform_ui_settings_v78 (
          id INTEGER PRIMARY KEY CHECK(id = 1),
          toast_position TEXT NOT NULL DEFAULT 'bottom-right' CHECK(toast_position IN ('bottom-right', 'top-right')),
          page_sizes_json TEXT NOT NULL DEFAULT '{"characters":30,"analysisTasks":30,"fileVersions":30}' CHECK(json_valid(page_sizes_json) AND json_type(page_sizes_json) = 'object'),
          galaxy_frame_rate INTEGER NOT NULL DEFAULT 30 CHECK(galaxy_frame_rate IN (24, 30, 60, 90, 120)),
          updated_at TEXT NOT NULL
        )`);
        this.run(`INSERT INTO platform_ui_settings_v78 (id, toast_position, page_sizes_json, galaxy_frame_rate, updated_at)
          SELECT id, toast_position, page_sizes_json,
            CASE WHEN galaxy_frame_rate IN (24, 30, 60, 90, 120) THEN galaxy_frame_rate ELSE 30 END,
            updated_at
          FROM platform_ui_settings`);
        this.run("DROP TABLE platform_ui_settings");
        this.run("ALTER TABLE platform_ui_settings_v78 RENAME TO platform_ui_settings");
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (78, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(79)) {
      this.transaction(() => {
        this.run(`CREATE TABLE platform_ui_settings_v79 (
          id INTEGER PRIMARY KEY CHECK(id = 1),
          toast_position TEXT NOT NULL DEFAULT 'bottom-right' CHECK(toast_position IN ('bottom-right', 'top-right')),
          page_sizes_json TEXT NOT NULL DEFAULT '{"characters":30,"analysisTasks":30,"fileVersions":30}' CHECK(json_valid(page_sizes_json) AND json_type(page_sizes_json) = 'object'),
          galaxy_frame_rate INTEGER NOT NULL DEFAULT 30 CHECK(galaxy_frame_rate IN (24, 30, 60, 90, 120, 144, 165, 240)),
          updated_at TEXT NOT NULL
        )`);
        this.run(`INSERT INTO platform_ui_settings_v79 (id, toast_position, page_sizes_json, galaxy_frame_rate, updated_at)
          SELECT id, toast_position, page_sizes_json,
            CASE WHEN galaxy_frame_rate IN (24, 30, 60, 90, 120, 144, 165, 240) THEN galaxy_frame_rate ELSE 30 END,
            updated_at
          FROM platform_ui_settings`);
        this.run("DROP TABLE platform_ui_settings");
        this.run("ALTER TABLE platform_ui_settings_v79 RENAME TO platform_ui_settings");
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (79, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(80)) {
      this.transaction(() => {
        this.run("CREATE INDEX IF NOT EXISTS idx_audit_logs_work_created ON audit_logs(work_id, created_at DESC)");
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (80, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(81)) {
      this.transaction(() => {
        this.run("CREATE INDEX IF NOT EXISTS idx_ai_suggestions_work ON ai_suggestions(work_id, status, created_at DESC)");
        this.run("CREATE INDEX IF NOT EXISTS idx_file_versions_work ON file_versions(work_id, created_at DESC, id DESC)");
        this.run("CREATE INDEX IF NOT EXISTS idx_chapter_insights_chapter ON chapter_insights(chapter_id, chapter_version DESC, created_at DESC)");
        const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
        if (integrity.some((row) => row.integrity_check !== "ok")) {
          throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
        }
        const foreignKeys = this.all("PRAGMA foreign_key_check");
        if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (81, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(83)) {
      this.transaction(() => {
        this.run(`CREATE TABLE IF NOT EXISTS presence_entries (
          work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
          client_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          username TEXT NOT NULL,
          display_name TEXT NOT NULL,
          avatar_url TEXT,
          page_kind TEXT NOT NULL,
          page_module TEXT,
          page_resource_id TEXT,
          last_seen_at TEXT NOT NULL,
          PRIMARY KEY(work_id, client_id)
        )`);
        this.run("CREATE INDEX IF NOT EXISTS idx_presence_entries_work ON presence_entries(work_id, last_seen_at)");
        this.run("CREATE INDEX IF NOT EXISTS idx_presence_entries_last_seen ON presence_entries(last_seen_at)");
        this.run(`CREATE TABLE IF NOT EXISTS presence_changes (
          id TEXT PRIMARY KEY,
          work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
          page_key TEXT NOT NULL,
          label TEXT NOT NULL,
          actor_user_id TEXT NOT NULL,
          actor_display_name TEXT NOT NULL,
          saved_at TEXT NOT NULL,
          recipient_client_ids_json TEXT NOT NULL DEFAULT '[]'
            CHECK(json_valid(recipient_client_ids_json) AND json_type(recipient_client_ids_json) = 'array')
        )`);
        this.run("CREATE INDEX IF NOT EXISTS idx_presence_changes_work ON presence_changes(work_id, page_key, saved_at DESC)");
        this.run("CREATE INDEX IF NOT EXISTS idx_presence_changes_saved_at ON presence_changes(saved_at)");
        const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
        if (integrity.some((row) => row.integrity_check !== "ok")) {
          throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
        }
        const foreignKeys = this.all("PRAGMA foreign_key_check");
        if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (83, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(84)) {
      this.transaction(() => {
        // 兼容曾使用更早迁移号创建备份加密表的开发版本，并确保列表索引完整。
        this.run("CREATE INDEX IF NOT EXISTS idx_ai_suggestions_work ON ai_suggestions(work_id, status, created_at DESC)");
        this.run("CREATE INDEX IF NOT EXISTS idx_file_versions_work ON file_versions(work_id, created_at DESC, id DESC)");
        this.run("CREATE INDEX IF NOT EXISTS idx_chapter_insights_chapter ON chapter_insights(chapter_id, chapter_version DESC, created_at DESC)");
        this.run(`CREATE TABLE IF NOT EXISTS s3_backup_encryption (
          id INTEGER PRIMARY KEY CHECK(id = 1),
          enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
          kek_encrypted TEXT,
          kek_iv TEXT,
          kek_tag TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK(
            (kek_encrypted IS NULL AND kek_iv IS NULL AND kek_tag IS NULL)
            OR (kek_encrypted IS NOT NULL AND kek_iv IS NOT NULL AND kek_tag IS NOT NULL)
          ),
          CHECK(enabled = 0 OR kek_encrypted IS NOT NULL)
        )`);
        const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
        if (integrity.some((row) => row.integrity_check !== "ok")) {
          throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
        }
        const foreignKeys = this.all("PRAGMA foreign_key_check");
        if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (84, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(85)) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(presence_changes)").map((row) => String(row.name)));
        if (!columns.has("action")) {
          this.run("ALTER TABLE presence_changes ADD COLUMN action TEXT NOT NULL DEFAULT 'save' CHECK(action IN ('save', 'delete'))");
        }
        if (!columns.has("page_deleted")) {
          this.run("ALTER TABLE presence_changes ADD COLUMN page_deleted INTEGER NOT NULL DEFAULT 0 CHECK(page_deleted IN (0, 1))");
        }
        const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
        if (integrity.some((row) => row.integrity_check !== "ok")) {
          throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
        }
        const foreignKeys = this.all("PRAGMA foreign_key_check");
        if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (85, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(86)) {
      this.transaction(() => {
        this.run(`CREATE TABLE work_covers_v86 (
          work_id TEXT PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
          mime_type TEXT NOT NULL CHECK(mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif')),
          content BLOB NOT NULL,
          byte_length INTEGER NOT NULL,
          sha256 TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`);
        this.run("INSERT INTO work_covers_v86 SELECT work_id, mime_type, content, byte_length, sha256, updated_at FROM work_covers");
        this.run("DROP TABLE work_covers");
        this.run("ALTER TABLE work_covers_v86 RENAME TO work_covers");
        this.run(`CREATE TABLE user_avatars_v86 (
          user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          mime_type TEXT NOT NULL CHECK(mime_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
          content BLOB NOT NULL,
          byte_length INTEGER NOT NULL,
          sha256 TEXT NOT NULL,
          width INTEGER NOT NULL,
          height INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        )`);
        this.run("INSERT INTO user_avatars_v86 SELECT user_id, mime_type, content, byte_length, sha256, width, height, updated_at FROM user_avatars");
        this.run("DROP TABLE user_avatars");
        this.run("ALTER TABLE user_avatars_v86 RENAME TO user_avatars");
        const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
        if (integrity.some((row) => row.integrity_check !== "ok")) {
          throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
        }
        const foreignKeys = this.all("PRAGMA foreign_key_check");
        if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (86, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(87)) {
      this.transaction(() => {
        const workColumns = new Set(this.all("PRAGMA table_info(works)").map((row) => String(row.name)));
        if (!workColumns.has("deleted_at")) this.run("ALTER TABLE works ADD COLUMN deleted_at TEXT");
        const volumeColumns = new Set(this.all("PRAGMA table_info(volumes)").map((row) => String(row.name)));
        if (!volumeColumns.has("deleted_at")) this.run("ALTER TABLE volumes ADD COLUMN deleted_at TEXT");
        const chapterColumns = new Set(this.all("PRAGMA table_info(chapters)").map((row) => String(row.name)));
        if (!chapterColumns.has("deleted_via_volume_id")) this.run("ALTER TABLE chapters ADD COLUMN deleted_via_volume_id TEXT");
        this.run("CREATE INDEX IF NOT EXISTS idx_works_recycle_bin ON works(deleted_at, owner_user_id)");
        this.run("CREATE INDEX IF NOT EXISTS idx_volumes_active_work ON volumes(work_id, deleted_at, sort_order)");
        this.run("CREATE INDEX IF NOT EXISTS idx_volumes_recycle_bin ON volumes(work_id, deleted_at DESC)");
        this.run("CREATE INDEX IF NOT EXISTS idx_chapters_deleted_via_volume ON chapters(deleted_via_volume_id, deleted_at)");
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (87, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(88)) {
      this.transaction(() => {
        this.run(`CREATE TABLE IF NOT EXISTS ai_conversation_forks (
          source_conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
          source_message_id TEXT NOT NULL REFERENCES ai_conversation_messages(id) ON DELETE CASCADE,
          request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 1 AND 200),
          conversation_id TEXT NOT NULL UNIQUE REFERENCES ai_conversations(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL,
          PRIMARY KEY(source_conversation_id, request_id)
        )`);
        this.run("CREATE INDEX IF NOT EXISTS idx_ai_conversation_forks_message ON ai_conversation_forks(source_message_id)");
        const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
        if (integrity.some((row) => row.integrity_check !== "ok")) {
          throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
        }
        const foreignKeys = this.all("PRAGMA foreign_key_check");
        if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (88, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(89)) {
      this.transaction(() => {
        this.run(`CREATE TABLE IF NOT EXISTS ai_conversation_stream_requests (
          id TEXT PRIMARY KEY,
          work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
          conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
          actor_scope TEXT NOT NULL CHECK(length(actor_scope) BETWEEN 1 AND 200),
          idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 16 AND 128),
          request_hash TEXT NOT NULL CHECK(length(request_hash) = 64),
          status TEXT NOT NULL CHECK(status IN ('in_progress', 'completed', 'cancelled', 'failed', 'timed_out', 'abandoned')),
          terminal_reason TEXT,
          user_message_id TEXT REFERENCES ai_conversation_messages(id) ON DELETE SET NULL,
          assistant_message_id TEXT REFERENCES ai_conversation_messages(id) ON DELETE SET NULL,
          lease_expires_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          UNIQUE(actor_scope, work_id, idempotency_key),
          CHECK(
            (status = 'in_progress' AND lease_expires_at IS NOT NULL AND completed_at IS NULL)
            OR (status <> 'in_progress' AND lease_expires_at IS NULL AND completed_at IS NOT NULL)
          )
        )`);
        this.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_conversation_stream_requests_active
          ON ai_conversation_stream_requests(conversation_id) WHERE status = 'in_progress'`);
        this.run(`CREATE INDEX IF NOT EXISTS idx_ai_conversation_stream_requests_lease
          ON ai_conversation_stream_requests(status, lease_expires_at)`);
        const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
        if (integrity.some((row) => row.integrity_check !== "ok")) {
          throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
        }
        const foreignKeys = this.all("PRAGMA foreign_key_check");
        if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (89, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(90)) {
      this.transaction(() => {
        this.run(`CREATE TABLE IF NOT EXISTS ai_connectivity_test_states (
          object_type TEXT NOT NULL CHECK(object_type IN ('provider', 'model')),
          object_id TEXT NOT NULL,
          config_fingerprint TEXT NOT NULL CHECK(length(config_fingerprint) = 64),
          state TEXT NOT NULL CHECK(state IN ('in_progress', 'success', 'failure')),
          attempt_id TEXT NOT NULL,
          retry_at_ms INTEGER NOT NULL CHECK(retry_at_ms >= 0),
          updated_at TEXT NOT NULL,
          PRIMARY KEY(object_type, object_id)
        )`);
        this.run("CREATE INDEX IF NOT EXISTS idx_ai_connectivity_test_states_retry_at ON ai_connectivity_test_states(retry_at_ms)");
        this.run(`CREATE TRIGGER IF NOT EXISTS ai_connectivity_test_states_provider_delete
          AFTER DELETE ON providers BEGIN
            DELETE FROM ai_connectivity_test_states WHERE object_type = 'provider' AND object_id = OLD.id;
          END`);
        this.run(`CREATE TRIGGER IF NOT EXISTS ai_connectivity_test_states_model_delete
          AFTER DELETE ON models BEGIN
            DELETE FROM ai_connectivity_test_states WHERE object_type = 'model' AND object_id = OLD.id;
          END`);
        const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
        if (integrity.some((row) => row.integrity_check !== "ok")) {
          throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
        }
        const foreignKeys = this.all("PRAGMA foreign_key_check");
        if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (90, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(91)) {
      this.transaction(() => {
        this.run(`CREATE TABLE IF NOT EXISTS chapter_paragraph_line_ranges (
          paragraph_id INTEGER PRIMARY KEY REFERENCES chapter_paragraph_search(id) ON DELETE CASCADE,
          chapter_version INTEGER NOT NULL CHECK(chapter_version >= 1),
          start_line INTEGER NOT NULL CHECK(start_line >= 1),
          end_line INTEGER NOT NULL CHECK(end_line >= start_line)
        ) WITHOUT ROWID`);
        const insertRange = this.raw.prepare(
          `INSERT INTO chapter_paragraph_line_ranges (paragraph_id, chapter_version, start_line, end_line)
           VALUES (?, ?, ?, ?)`
        );
        const chapters = this.all<{ id: string; content: string; version_no: number }>(
          `SELECT DISTINCT chapter.id, chapter.content, chapter.version_no
           FROM chapters chapter
           JOIN chapter_paragraph_search paragraph ON paragraph.chapter_id = chapter.id
           ORDER BY chapter.id`
        );
        for (const chapter of chapters) {
          const ranges = documentParagraphLineRanges(chapter.content);
          const paragraphs = this.all<{ id: number; paragraph_order: number }>(
            "SELECT id, paragraph_order FROM chapter_paragraph_search WHERE chapter_id = ? ORDER BY paragraph_order",
            chapter.id
          );
          for (const paragraph of paragraphs) {
            const range = ranges[paragraph.paragraph_order];
            if (range) insertRange.run(paragraph.id, chapter.version_no, range.startLine, range.endLine);
          }
        }
        const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
        if (integrity.some((row) => row.integrity_check !== "ok")) {
          throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
        }
        const foreignKeys = this.all("PRAGMA foreign_key_check");
        if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (91, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(92)) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(ai_conversations)").map((row) => String(row.name)));
        if (!columns.has("is_favorite")) {
          this.run("ALTER TABLE ai_conversations ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0 CHECK(is_favorite IN (0, 1))");
        }
        this.run("CREATE INDEX IF NOT EXISTS idx_ai_conversations_favorite ON ai_conversations(work_id, is_favorite, updated_at DESC, created_at DESC)");
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (92, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(93)) {
      this.transaction(() => {
        this.run("CREATE INDEX IF NOT EXISTS idx_foreshadows_work_payoff_status ON foreshadows(work_id, planned_payoff_chapter_id, status)");
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (93, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(94)) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(models)").map((row) => String(row.name)));
        if (!columns.has("thinking_effort")) {
          this.run("ALTER TABLE models ADD COLUMN thinking_effort TEXT NOT NULL DEFAULT 'default' CHECK(thinking_effort IN ('default', 'low', 'medium', 'high'))");
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (94, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(95)) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(providers)").map((row) => String(row.name)));
        if (!columns.has("max_tokens_parameter")) {
          this.run("ALTER TABLE providers ADD COLUMN max_tokens_parameter TEXT NOT NULL DEFAULT 'max_tokens' CHECK(max_tokens_parameter IN ('max_tokens', 'max_completion_tokens'))");
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (95, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(96)) {
      const modelsSql = String(this.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'models'")?.sql ?? "");
      if (!modelsSql.includes("'xhigh'") || !modelsSql.includes("'max'")) {
        this.raw.exec("PRAGMA foreign_keys = OFF");
        try {
          this.transaction(() => {
            this.run(`CREATE TABLE models_v96 (
              id TEXT PRIMARY KEY,
              provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
              display_name TEXT NOT NULL,
              model_id TEXT NOT NULL,
              purposes_json TEXT NOT NULL DEFAULT '[]',
              context_note TEXT NOT NULL DEFAULT '',
              context_window INTEGER NOT NULL DEFAULT 128000 CHECK(context_window BETWEEN 1024 AND 2000000),
              output_note TEXT NOT NULL DEFAULT '',
              preset_json TEXT NOT NULL DEFAULT '{}',
              thinking_enabled INTEGER NOT NULL DEFAULT 1,
              thinking_effort TEXT NOT NULL DEFAULT 'default' CHECK(thinking_effort IN ('default', 'low', 'medium', 'high', 'xhigh', 'max')),
              multimodal_enabled INTEGER NOT NULL DEFAULT 0 CHECK(multimodal_enabled IN (0, 1)),
              enabled INTEGER NOT NULL DEFAULT 1,
              note TEXT NOT NULL DEFAULT '',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              UNIQUE(provider_id, model_id)
            )`);
            this.run(`INSERT INTO models_v96 (
              id, provider_id, display_name, model_id, purposes_json, context_note, context_window, output_note,
              preset_json, thinking_enabled, thinking_effort, multimodal_enabled, enabled, note, created_at, updated_at
            )
            SELECT
              id, provider_id, display_name, model_id, purposes_json, context_note, context_window, output_note,
              preset_json, thinking_enabled, thinking_effort, multimodal_enabled, enabled, note, created_at, updated_at
            FROM models`);
            this.run("DROP TABLE models");
            this.run("ALTER TABLE models_v96 RENAME TO models");
            this.run(`CREATE TRIGGER IF NOT EXISTS ai_connectivity_test_states_model_delete
              AFTER DELETE ON models BEGIN
                DELETE FROM ai_connectivity_test_states WHERE object_type = 'model' AND object_id = OLD.id;
              END`);
          });
        } finally {
          this.raw.exec("PRAGMA foreign_keys = ON");
        }
      }
      this.transaction(() => {
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (96, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(97)) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(characters)").map((row) => String(row.name)));
        if (!columns.has("gender")) {
          this.run("ALTER TABLE characters ADD COLUMN gender TEXT NOT NULL DEFAULT 'unknown' CHECK(gender IN ('male', 'female', 'none', 'unknown'))");
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (97, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(98)) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(work_ai_settings)").map((row) => String(row.name)));
        if (!columns.has("auto_run_stability_delay_minutes")) {
          this.run(`ALTER TABLE work_ai_settings ADD COLUMN auto_run_stability_delay_minutes INTEGER NOT NULL DEFAULT 2
            CHECK(auto_run_stability_delay_minutes BETWEEN 1 AND 120)`);
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (98, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(99)) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(ai_conversations)").map((row) => String(row.name)));
        if (!columns.has("roleplay_user_character_id")) {
          this.run("ALTER TABLE ai_conversations ADD COLUMN roleplay_user_character_id TEXT REFERENCES characters(id) ON DELETE SET NULL");
        }
        this.run("CREATE INDEX IF NOT EXISTS idx_ai_conversations_roleplay_user_character ON ai_conversations(roleplay_user_character_id)");
        this.run(`CREATE TRIGGER IF NOT EXISTS ai_conversations_clear_roleplay_user_character
          AFTER UPDATE OF roleplay_character_id ON ai_conversations
          WHEN NEW.roleplay_character_id IS NULL AND NEW.roleplay_user_character_id IS NOT NULL
          BEGIN
            UPDATE ai_conversations SET roleplay_user_character_id = NULL WHERE id = NEW.id;
          END`);
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (99, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(100)) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(platform_ai_settings)").map((row) => String(row.name)));
        if (!columns.has("stream_idle_timeout_seconds")) {
          this.run("ALTER TABLE platform_ai_settings ADD COLUMN stream_idle_timeout_seconds INTEGER NOT NULL DEFAULT 90 CHECK(stream_idle_timeout_seconds BETWEEN 30 AND 120)");
        }
        this.run(
          "UPDATE platform_ai_settings SET stream_idle_timeout_seconds = 90 WHERE stream_idle_timeout_seconds IS NULL OR stream_idle_timeout_seconds < 30 OR stream_idle_timeout_seconds > 120"
        );
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (100, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(101)) {
      this.transaction(() => {
        const tableSql = String(this.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'platform_ai_settings'")?.sql ?? "");
        if (!tableSql.includes("BETWEEN 30 AND 600")) {
          this.run("ALTER TABLE platform_ai_settings RENAME TO platform_ai_settings_v101_old");
          this.run(`CREATE TABLE platform_ai_settings (
            id INTEGER PRIMARY KEY CHECK(id = 1),
            system_prompt TEXT NOT NULL DEFAULT '',
            image_tool_model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
            stream_idle_timeout_seconds INTEGER NOT NULL DEFAULT 90 CHECK(stream_idle_timeout_seconds BETWEEN 30 AND 600),
            updated_at TEXT NOT NULL
          )`);
          this.run(`INSERT INTO platform_ai_settings (id, system_prompt, image_tool_model_id, stream_idle_timeout_seconds, updated_at)
            SELECT id, system_prompt, image_tool_model_id, stream_idle_timeout_seconds, updated_at
            FROM platform_ai_settings_v101_old`);
          this.run("DROP TABLE platform_ai_settings_v101_old");
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (101, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    const characterAvatarsTablePresent = this.all("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'character_avatars'").length > 0;
    if (!applied.has(102) || !characterAvatarsTablePresent) {
      this.transaction(() => {
        this.run(`CREATE TABLE IF NOT EXISTS character_avatars (
          character_id TEXT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
          mime_type TEXT NOT NULL CHECK(mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif')),
          byte_length INTEGER NOT NULL CHECK(byte_length > 0 AND byte_length <= 2097152),
          sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
          storage_key TEXT NOT NULL UNIQUE,
          width INTEGER NOT NULL CHECK(width > 0),
          height INTEGER NOT NULL CHECK(height > 0),
          updated_at TEXT NOT NULL
        )`);
        this.run("CREATE INDEX IF NOT EXISTS idx_character_avatars_storage_key ON character_avatars(storage_key)");
        this.run("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (102, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    const aiConversationUserIndexPresent = this.all("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_ai_conversations_work_creator'").length > 0;
    if (!applied.has(103) || !aiConversationUserIndexPresent) {
      this.transaction(() => {
        this.run(`UPDATE ai_conversations
          SET created_by_user_id = (
            SELECT work.owner_user_id FROM works work WHERE work.id = ai_conversations.work_id
          )
          WHERE created_by_user_id IS NULL
            AND EXISTS (
              SELECT 1 FROM works work
              WHERE work.id = ai_conversations.work_id AND work.owner_user_id IS NOT NULL
            )`);
        this.run(`CREATE INDEX IF NOT EXISTS idx_ai_conversations_work_creator
          ON ai_conversations(work_id, created_by_user_id, is_favorite, updated_at DESC, created_at DESC)`);
        this.run("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (103, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(104)) {
      this.raw.exec("PRAGMA foreign_keys = OFF");
      try {
        this.transaction(() => {
          this.run(`CREATE TABLE providers_v104 (
            id TEXT PRIMARY KEY,
            work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            base_url TEXT NOT NULL,
            protocol TEXT NOT NULL DEFAULT 'openai-chat-completions' CHECK(protocol IN ('openai-chat-completions', 'openai-responses', 'anthropic-messages', 'google-vertex')),
            encrypted_key TEXT NOT NULL,
            key_iv TEXT NOT NULL,
            key_tag TEXT NOT NULL,
            key_hint TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'disabled',
            connection_status TEXT NOT NULL DEFAULT 'unchecked',
            concurrency_limit INTEGER NOT NULL DEFAULT 10 CHECK(concurrency_limit BETWEEN 1 AND 100),
            rpm_limit INTEGER NOT NULL DEFAULT 10 CHECK(rpm_limit BETWEEN 1 AND 10000),
            max_tokens INTEGER NOT NULL DEFAULT 32000 CHECK(max_tokens BETWEEN 1 AND 32768),
            max_tokens_parameter TEXT NOT NULL DEFAULT 'max_tokens' CHECK(max_tokens_parameter IN ('max_tokens', 'max_completion_tokens')),
            default_model_id TEXT,
            note TEXT NOT NULL DEFAULT '',
            last_error TEXT,
            last_success_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          )`);
          this.run(`INSERT INTO providers_v104 (
            id, work_id, name, base_url, protocol, encrypted_key, key_iv, key_tag, key_hint, status,
            connection_status, concurrency_limit, rpm_limit, max_tokens, max_tokens_parameter, default_model_id, note,
            last_error, last_success_at, created_at, updated_at
          )
          SELECT
            id, work_id, name, base_url, protocol, encrypted_key, key_iv, key_tag, key_hint, status,
            connection_status, concurrency_limit, rpm_limit, max_tokens, max_tokens_parameter, default_model_id, note,
            last_error, last_success_at, created_at, updated_at
          FROM providers`);
          this.run("DROP TABLE providers");
          this.run("ALTER TABLE providers_v104 RENAME TO providers");
          this.run(`CREATE TRIGGER IF NOT EXISTS ai_connectivity_test_states_provider_delete
            AFTER DELETE ON providers BEGIN
              DELETE FROM ai_connectivity_test_states WHERE object_type = 'provider' AND object_id = OLD.id;
            END`);
          this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (104, ?)", new Date().toISOString());
        });
      } finally {
        this.raw.exec("PRAGMA foreign_keys = ON");
      }
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    const volumeStoryOrderIndexPresent = this.all("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_volumes_story_order'").length > 0;
    if (!applied.has(105) || !volumeStoryOrderIndexPresent) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(volumes)").map((row) => String(row.name)));
        if (!columns.has("story_order")) {
          this.run("ALTER TABLE volumes ADD COLUMN story_order INTEGER NOT NULL DEFAULT 0");
          this.run("UPDATE volumes SET story_order = sort_order");
        }
        this.run("CREATE INDEX IF NOT EXISTS idx_volumes_story_order ON volumes(work_id, story_order)");
        this.run("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (105, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    const providerThinkingTypePresent = this.all("PRAGMA table_info(providers)").some((row) => String(row.name) === "thinking_type");
    if (!applied.has(106) || !providerThinkingTypePresent) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(providers)").map((row) => String(row.name)));
        if (!columns.has("thinking_type")) {
          this.run("ALTER TABLE providers ADD COLUMN thinking_type TEXT NOT NULL DEFAULT 'enabled' CHECK(thinking_type IN ('enabled', 'adaptive'))");
        }
        this.run("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (106, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    const cacheWriteInputTokensPresent = this.all("PRAGMA table_info(ai_calls)").some((row) => String(row.name) === "cache_write_input_tokens");
    if (!applied.has(107) || !cacheWriteInputTokensPresent) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(ai_calls)").map((row) => String(row.name)));
        if (!columns.has("cache_write_input_tokens")) {
          this.run("ALTER TABLE ai_calls ADD COLUMN cache_write_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK(cache_write_input_tokens >= 0)");
        }
        this.run("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (107, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(108)) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(work_ai_settings)").map((row) => String(row.name)));
        if (!columns.has("monthly_token_quota")) {
          this.run("ALTER TABLE work_ai_settings ADD COLUMN monthly_token_quota INTEGER CHECK(monthly_token_quota IS NULL OR monthly_token_quota >= 10000)");
        }
        this.run("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (108, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(109)) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(providers)").map((row) => String(row.name)));
        if (!columns.has("daily_token_quota")) {
          this.run("ALTER TABLE providers ADD COLUMN daily_token_quota INTEGER CHECK(daily_token_quota IS NULL OR daily_token_quota >= 10000)");
        }
        if (!columns.has("monthly_token_quota")) {
          this.run("ALTER TABLE providers ADD COLUMN monthly_token_quota INTEGER CHECK(monthly_token_quota IS NULL OR monthly_token_quota >= 10000)");
        }
        this.run("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (109, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(110)) {
      this.raw.exec("PRAGMA foreign_keys = OFF");
      try {
        this.transaction(() => {
          this.run(`CREATE TABLE work_ai_settings_v110 (
            work_id TEXT PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
            system_prompt TEXT NOT NULL DEFAULT '',
            daily_token_quota INTEGER CHECK(daily_token_quota IS NULL OR daily_token_quota >= 1),
            auto_run_enabled INTEGER NOT NULL DEFAULT 0,
            auto_run_concurrency INTEGER NOT NULL DEFAULT 2,
            auto_run_batch_limit INTEGER NOT NULL DEFAULT 20,
            auto_run_daily_task_limit INTEGER NOT NULL DEFAULT 0 CHECK(auto_run_daily_task_limit BETWEEN 0 AND 10000),
            auto_run_failure_threshold INTEGER NOT NULL DEFAULT 3 CHECK(auto_run_failure_threshold BETWEEN 1 AND 10),
            auto_run_paused INTEGER NOT NULL DEFAULT 0 CHECK(auto_run_paused IN (0, 1)),
            auto_run_pause_reason TEXT NOT NULL DEFAULT '',
            auto_run_resume_at TEXT,
            auto_run_consecutive_failures INTEGER NOT NULL DEFAULT 0,
            book_summary_context_percent INTEGER NOT NULL DEFAULT 50 CHECK(book_summary_context_percent BETWEEN 1 AND 90),
            context_compact_threshold INTEGER NOT NULL DEFAULT 85 CHECK(context_compact_threshold BETWEEN 50 AND 90),
            agent_tool_call_limit INTEGER NOT NULL DEFAULT 12 CHECK(agent_tool_call_limit BETWEEN 5 AND 1000),
            agent_tool_call_global_multiplier INTEGER NOT NULL DEFAULT 3 CHECK(agent_tool_call_global_multiplier BETWEEN 1 AND 6),
            agent_tools_json TEXT NOT NULL DEFAULT '["story_index","read_chapters","search_story_entities","grep","read_character_sections","search_drafts","image"]',
            title_generation_model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
            image_tool_model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
            always_include_setting_info INTEGER NOT NULL DEFAULT 0 CHECK(always_include_setting_info IN (0, 1)),
            updated_at TEXT NOT NULL,
            auto_run_stability_delay_minutes INTEGER NOT NULL DEFAULT 2 CHECK(auto_run_stability_delay_minutes BETWEEN 1 AND 120),
            monthly_token_quota INTEGER CHECK(monthly_token_quota IS NULL OR monthly_token_quota >= 1)
          )`);
          this.run(`INSERT INTO work_ai_settings_v110 (
            work_id, system_prompt, daily_token_quota, auto_run_enabled, auto_run_concurrency, auto_run_batch_limit,
            auto_run_daily_task_limit, auto_run_failure_threshold, auto_run_paused, auto_run_pause_reason,
            auto_run_resume_at, auto_run_consecutive_failures, book_summary_context_percent,
            context_compact_threshold, agent_tool_call_limit, agent_tool_call_global_multiplier,
            agent_tools_json, title_generation_model_id, image_tool_model_id, always_include_setting_info,
            updated_at, auto_run_stability_delay_minutes, monthly_token_quota
          )
          SELECT
            work_id, system_prompt, daily_token_quota, auto_run_enabled, auto_run_concurrency, auto_run_batch_limit,
            auto_run_daily_task_limit, auto_run_failure_threshold, auto_run_paused, auto_run_pause_reason,
            auto_run_resume_at, auto_run_consecutive_failures, book_summary_context_percent,
            context_compact_threshold, agent_tool_call_limit, agent_tool_call_global_multiplier,
            agent_tools_json, title_generation_model_id, image_tool_model_id, always_include_setting_info,
            updated_at, auto_run_stability_delay_minutes, monthly_token_quota
          FROM work_ai_settings`);
          this.run("DROP TABLE work_ai_settings");
          this.run("ALTER TABLE work_ai_settings_v110 RENAME TO work_ai_settings");
          this.run("CREATE INDEX IF NOT EXISTS idx_work_ai_settings_work ON work_ai_settings(work_id)");

          this.run(`CREATE TABLE providers_v110 (
            id TEXT PRIMARY KEY,
            work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            base_url TEXT NOT NULL,
            protocol TEXT NOT NULL DEFAULT 'openai-chat-completions' CHECK(protocol IN ('openai-chat-completions', 'openai-responses', 'anthropic-messages', 'google-vertex')),
            encrypted_key TEXT NOT NULL,
            key_iv TEXT NOT NULL,
            key_tag TEXT NOT NULL,
            key_hint TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'disabled',
            connection_status TEXT NOT NULL DEFAULT 'unchecked',
            concurrency_limit INTEGER NOT NULL DEFAULT 10 CHECK(concurrency_limit BETWEEN 1 AND 100),
            rpm_limit INTEGER NOT NULL DEFAULT 10 CHECK(rpm_limit BETWEEN 1 AND 10000),
            daily_token_quota INTEGER CHECK(daily_token_quota IS NULL OR daily_token_quota >= 1),
            monthly_token_quota INTEGER CHECK(monthly_token_quota IS NULL OR monthly_token_quota >= 1),
            max_tokens INTEGER NOT NULL DEFAULT 32000 CHECK(max_tokens BETWEEN 1 AND 32768),
            max_tokens_parameter TEXT NOT NULL DEFAULT 'max_tokens' CHECK(max_tokens_parameter IN ('max_tokens', 'max_completion_tokens')),
            thinking_type TEXT NOT NULL DEFAULT 'enabled' CHECK(thinking_type IN ('enabled', 'adaptive')),
            default_model_id TEXT,
            note TEXT NOT NULL DEFAULT '',
            last_error TEXT,
            last_success_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          )`);
          this.run(`INSERT INTO providers_v110 (
            id, work_id, name, base_url, protocol, encrypted_key, key_iv, key_tag, key_hint, status,
            connection_status, concurrency_limit, rpm_limit, daily_token_quota, monthly_token_quota,
            max_tokens, max_tokens_parameter, thinking_type, default_model_id, note, last_error, last_success_at, created_at, updated_at
          )
          SELECT
            id, work_id, name, base_url, protocol, encrypted_key, key_iv, key_tag, key_hint, status,
            connection_status, concurrency_limit, rpm_limit, daily_token_quota, monthly_token_quota,
            max_tokens, max_tokens_parameter, thinking_type, default_model_id, note, last_error, last_success_at, created_at, updated_at
          FROM providers`);
          this.run("DROP TABLE providers");
          this.run("ALTER TABLE providers_v110 RENAME TO providers");
          this.run(`CREATE TRIGGER IF NOT EXISTS ai_connectivity_test_states_provider_delete
            AFTER DELETE ON providers BEGIN
              DELETE FROM ai_connectivity_test_states WHERE object_type = 'provider' AND object_id = OLD.id;
            END`);
          this.run("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (110, ?)", new Date().toISOString());
        });
      } finally {
        this.raw.exec("PRAGMA foreign_keys = ON");
      }
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(111)) {
      const modelsSql = String(this.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'models'")?.sql ?? "");
      if (!modelsSql.includes("'auto'")) {
        this.raw.exec("PRAGMA foreign_keys = OFF");
        try {
          this.transaction(() => {
            this.run(`CREATE TABLE models_v111 (
              id TEXT PRIMARY KEY,
              provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
              display_name TEXT NOT NULL,
              model_id TEXT NOT NULL,
              purposes_json TEXT NOT NULL DEFAULT '[]',
              context_note TEXT NOT NULL DEFAULT '',
              context_window INTEGER NOT NULL DEFAULT 128000 CHECK(context_window BETWEEN 1024 AND 2000000),
              output_note TEXT NOT NULL DEFAULT '',
              preset_json TEXT NOT NULL DEFAULT '{}',
              thinking_enabled INTEGER NOT NULL DEFAULT 1,
              thinking_effort TEXT NOT NULL DEFAULT 'default' CHECK(thinking_effort IN ('default', 'auto', 'low', 'medium', 'high', 'xhigh', 'max')),
              multimodal_enabled INTEGER NOT NULL DEFAULT 0 CHECK(multimodal_enabled IN (0, 1)),
              enabled INTEGER NOT NULL DEFAULT 1,
              note TEXT NOT NULL DEFAULT '',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              UNIQUE(provider_id, model_id)
            )`);
            this.run(`INSERT INTO models_v111 (
              id, provider_id, display_name, model_id, purposes_json, context_note, context_window, output_note,
              preset_json, thinking_enabled, thinking_effort, multimodal_enabled, enabled, note, created_at, updated_at
            )
            SELECT
              id, provider_id, display_name, model_id, purposes_json, context_note, context_window, output_note,
              preset_json, thinking_enabled, thinking_effort, multimodal_enabled, enabled, note, created_at, updated_at
            FROM models`);
            this.run("DROP TABLE models");
            this.run("ALTER TABLE models_v111 RENAME TO models");
            this.run(`CREATE TRIGGER IF NOT EXISTS ai_connectivity_test_states_model_delete
              AFTER DELETE ON models BEGIN
                DELETE FROM ai_connectivity_test_states WHERE object_type = 'model' AND object_id = OLD.id;
              END`);
          });
        } finally {
          this.raw.exec("PRAGMA foreign_keys = ON");
        }
      }
      this.transaction(() => {
        this.run("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (111, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    if (!applied.has(112)) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(user_api_keys)").map((row) => String(row.name)));
        if (!columns.has("key_encrypted")) {
          this.run("ALTER TABLE user_api_keys ADD COLUMN key_encrypted TEXT");
        }
        if (!columns.has("key_iv")) {
          this.run("ALTER TABLE user_api_keys ADD COLUMN key_iv TEXT");
        }
        if (!columns.has("key_tag")) {
          this.run("ALTER TABLE user_api_keys ADD COLUMN key_tag TEXT");
        }
        this.run("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (112, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    const characterFavoritePresent = this.all("PRAGMA table_info(characters)").some((row) => String(row.name) === "is_favorite");
    const characterFavoriteIndexPresent = this.all("PRAGMA index_list(characters)").some((row) => String(row.name) === "idx_characters_favorite");
    if (!applied.has(113) || !characterFavoritePresent || !characterFavoriteIndexPresent) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(characters)").map((row) => String(row.name)));
        if (!columns.has("is_favorite")) {
          this.run("ALTER TABLE characters ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0 CHECK(is_favorite IN (0, 1))");
        }
        this.run("CREATE INDEX IF NOT EXISTS idx_characters_favorite ON characters(work_id, is_favorite DESC, name)");
        this.run("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (113, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    const favoriteRecordTables = ["drafts", "settings", "organizations"] as const;
    const favoriteRecordColumnsPresent = favoriteRecordTables.every((table) => (
      this.all(`PRAGMA table_info(${table})`).some((row) => String(row.name) === "is_favorite")
    ));
    const favoriteRecordIndexes = [
      ["drafts", "idx_drafts_favorite"],
      ["settings", "idx_settings_favorite"],
      ["organizations", "idx_organizations_favorite"]
    ] as const;
    const favoriteRecordIndexesPresent = favoriteRecordIndexes.every(([table, index]) => (
      this.all(`PRAGMA index_list(${table})`).some((row) => String(row.name) === index)
    ));
    if (!applied.has(114) || !favoriteRecordColumnsPresent || !favoriteRecordIndexesPresent) {
      this.transaction(() => {
        for (const table of favoriteRecordTables) {
          const columns = new Set(this.all(`PRAGMA table_info(${table})`).map((row) => String(row.name)));
          if (!columns.has("is_favorite")) {
            this.run(`ALTER TABLE ${table} ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0 CHECK(is_favorite IN (0, 1))`);
          }
        }
        this.run("CREATE INDEX IF NOT EXISTS idx_drafts_favorite ON drafts(work_id, is_favorite DESC, updated_at DESC, title)");
        this.run("CREATE INDEX IF NOT EXISTS idx_settings_favorite ON settings(work_id, is_favorite DESC, locked DESC, category, title)");
        this.run("CREATE INDEX IF NOT EXISTS idx_organizations_favorite ON organizations(work_id, is_favorite DESC, name)");
        this.run("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (114, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    const scenePinPresent = this.all("PRAGMA table_info(ai_conversations)").some((row) => String(row.name) === "scene_pin_json");
    if (!applied.has(115) || !scenePinPresent) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(ai_conversations)").map((row) => String(row.name)));
        if (!columns.has("scene_pin_json")) {
          this.run("ALTER TABLE ai_conversations ADD COLUMN scene_pin_json TEXT NOT NULL DEFAULT '{}'");
        }
        this.run("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (115, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    const desktopSessionTablePresent = this.get(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'user_desktop_sessions'"
    ) !== undefined;
    const desktopSessionIndexesPresent = [
      "idx_user_desktop_sessions_token",
      "idx_user_desktop_sessions_user",
      "idx_user_desktop_sessions_active_profile"
    ].every((index) => this.get(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = ?",
      index
    ) !== undefined);
    if (!applied.has(116) || !desktopSessionTablePresent || !desktopSessionIndexesPresent) {
      this.transaction(() => {
        this.run(`CREATE TABLE IF NOT EXISTS user_desktop_sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          desktop_id TEXT NOT NULL,
          profile_id TEXT NOT NULL,
          client_version TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          revoked_at TEXT
        )`);
        this.run("CREATE INDEX IF NOT EXISTS idx_user_desktop_sessions_token ON user_desktop_sessions(token_hash)");
        this.run("CREATE INDEX IF NOT EXISTS idx_user_desktop_sessions_user ON user_desktop_sessions(user_id, expires_at)");
        this.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_desktop_sessions_active_profile
          ON user_desktop_sessions(desktop_id, profile_id) WHERE revoked_at IS NULL`);
        this.run("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (116, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    const workOfflineAccessPresent = this.all("PRAGMA table_info(works)").some((row) => String(row.name) === "offline_access_enabled");
    const syncChangesTablePresent = this.get(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'sync_changes'"
    ) !== undefined;
    const syncMutationResultsTablePresent = this.get(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'sync_mutation_results'"
    ) !== undefined;
    const syncIndexesPresent = [
      "idx_sync_changes_work_cursor",
      "idx_sync_changes_entity",
      "idx_sync_mutation_results_client"
    ].every((index) => this.get(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = ?",
      index
    ) !== undefined);
    if (!applied.has(117) || !workOfflineAccessPresent || !syncChangesTablePresent || !syncMutationResultsTablePresent || !syncIndexesPresent) {
      this.transaction(() => {
        const workColumns = new Set(this.all("PRAGMA table_info(works)").map((row) => String(row.name)));
        if (!workColumns.has("offline_access_enabled")) {
          this.run("ALTER TABLE works ADD COLUMN offline_access_enabled INTEGER NOT NULL DEFAULT 0 CHECK(offline_access_enabled IN (0, 1))");
        }
        this.run(`CREATE TABLE IF NOT EXISTS sync_changes (
          cursor INTEGER PRIMARY KEY AUTOINCREMENT,
          work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
          entity_type TEXT NOT NULL CHECK(entity_type IN ('chapter', 'setting')),
          entity_id TEXT NOT NULL,
          operation TEXT NOT NULL CHECK(operation IN ('upsert', 'delete')),
          version_no INTEGER NOT NULL CHECK(version_no > 0),
          changed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          changed_at TEXT NOT NULL
        )`);
        this.run(`CREATE TABLE IF NOT EXISTS sync_mutation_results (
          mutation_id TEXT PRIMARY KEY,
          client_id TEXT NOT NULL,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
          request_hash TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('applied', 'conflict', 'rejected')),
          applied_version_no INTEGER,
          conflict_version_no INTEGER,
          error_code TEXT,
          result_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`);
        this.run("CREATE INDEX IF NOT EXISTS idx_sync_changes_work_cursor ON sync_changes(work_id, cursor)");
        this.run("CREATE INDEX IF NOT EXISTS idx_sync_changes_entity ON sync_changes(work_id, entity_type, entity_id, cursor)");
        this.run("CREATE INDEX IF NOT EXISTS idx_sync_mutation_results_client ON sync_mutation_results(client_id, user_id, work_id, created_at)");
        this.run("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (117, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    const providerAnalysisTimeoutPresent = this.all("PRAGMA table_info(providers)").some((row) => String(row.name) === "analysis_timeout_seconds");
    if (!applied.has(118) || !providerAnalysisTimeoutPresent) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(providers)").map((row) => String(row.name)));
        if (!columns.has("analysis_timeout_seconds")) {
          this.run(`ALTER TABLE providers ADD COLUMN analysis_timeout_seconds INTEGER NOT NULL DEFAULT ${DEFAULT_AI_ANALYSIS_TIMEOUT_SECONDS}
            CHECK(analysis_timeout_seconds BETWEEN ${MIN_AI_ANALYSIS_TIMEOUT_SECONDS} AND ${MAX_AI_ANALYSIS_TIMEOUT_SECONDS})`);
        }
        this.run("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (118, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    const taskApiKeySourcePresent = this.all("PRAGMA table_info(analysis_tasks)")
      .some((row) => String(row.name) === "created_via_api_key");
    if (!applied.has(119) || !taskApiKeySourcePresent) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(analysis_tasks)").map((row) => String(row.name)));
        if (!columns.has("created_via_api_key")) {
          this.run(`ALTER TABLE analysis_tasks ADD COLUMN created_via_api_key INTEGER NOT NULL DEFAULT 0
            CHECK(created_via_api_key IN (0, 1))`);
        }
        this.run("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (119, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    const workEntityFavoritesTablePresent = this.get(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'work_entity_favorites'"
    ) !== undefined;
    const workEntityPinsTablePresent = this.get(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'work_entity_pins'"
    ) !== undefined;
    const workEntityPreferenceIndexesPresent = [
      "idx_work_entity_favorites_user",
      "idx_work_entity_favorites_entity",
      "idx_work_entity_pins_entity"
    ].every((index) => this.get(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = ?",
      index
    ) !== undefined);
    if (!applied.has(120) || !workEntityFavoritesTablePresent || !workEntityPinsTablePresent || !workEntityPreferenceIndexesPresent) {
      this.transaction(() => {
        this.run(`CREATE TABLE IF NOT EXISTS work_entity_favorites (
          work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
          entity_type TEXT NOT NULL CHECK(entity_type IN ('character', 'draft', 'setting', 'organization')),
          entity_id TEXT NOT NULL,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          is_favorite INTEGER NOT NULL DEFAULT 0 CHECK(is_favorite IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(work_id, entity_type, entity_id, user_id)
        )`);
        this.run(`CREATE TABLE IF NOT EXISTS work_entity_pins (
          work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
          entity_type TEXT NOT NULL CHECK(entity_type IN ('character', 'draft', 'setting', 'organization')),
          entity_id TEXT NOT NULL,
          is_pinned INTEGER NOT NULL DEFAULT 0 CHECK(is_pinned IN (0, 1)),
          pinned_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(work_id, entity_type, entity_id)
        )`);
        this.run("CREATE INDEX IF NOT EXISTS idx_work_entity_favorites_user ON work_entity_favorites(work_id, user_id, entity_type, is_favorite, entity_id)");
        this.run("CREATE INDEX IF NOT EXISTS idx_work_entity_favorites_entity ON work_entity_favorites(work_id, entity_type, entity_id, is_favorite)");
        this.run("CREATE INDEX IF NOT EXISTS idx_work_entity_pins_entity ON work_entity_pins(work_id, entity_type, is_pinned, entity_id)");
        const timestamp = new Date().toISOString();
        this.run(`
          INSERT INTO work_entity_favorites (work_id, entity_type, entity_id, user_id, is_favorite, created_at, updated_at)
          SELECT character.work_id, 'character', character.id, work.owner_user_id, 1,
            COALESCE(character.created_at, ?), COALESCE(character.updated_at, ?)
          FROM characters character
          JOIN works work ON work.id = character.work_id
          WHERE character.is_favorite = 1 AND work.owner_user_id IS NOT NULL
          ON CONFLICT(work_id, entity_type, entity_id, user_id) DO UPDATE SET is_favorite = excluded.is_favorite, updated_at = excluded.updated_at`,
          timestamp,
          timestamp
        );
        this.run(`
          INSERT INTO work_entity_favorites (work_id, entity_type, entity_id, user_id, is_favorite, created_at, updated_at)
          SELECT draft.work_id, 'draft', draft.id, work.owner_user_id, 1,
            COALESCE(draft.created_at, ?), COALESCE(draft.updated_at, ?)
          FROM drafts draft
          JOIN works work ON work.id = draft.work_id
          WHERE draft.is_favorite = 1 AND work.owner_user_id IS NOT NULL
          ON CONFLICT(work_id, entity_type, entity_id, user_id) DO UPDATE SET is_favorite = excluded.is_favorite, updated_at = excluded.updated_at`,
          timestamp,
          timestamp
        );
        this.run(`
          INSERT INTO work_entity_favorites (work_id, entity_type, entity_id, user_id, is_favorite, created_at, updated_at)
          SELECT setting.work_id, 'setting', setting.id, work.owner_user_id, 1,
            COALESCE(setting.created_at, ?), COALESCE(setting.updated_at, ?)
          FROM settings setting
          JOIN works work ON work.id = setting.work_id
          WHERE setting.is_favorite = 1 AND work.owner_user_id IS NOT NULL
          ON CONFLICT(work_id, entity_type, entity_id, user_id) DO UPDATE SET is_favorite = excluded.is_favorite, updated_at = excluded.updated_at`,
          timestamp,
          timestamp
        );
        this.run(`
          INSERT INTO work_entity_favorites (work_id, entity_type, entity_id, user_id, is_favorite, created_at, updated_at)
          SELECT organization.work_id, 'organization', organization.id, work.owner_user_id, 1,
            COALESCE(organization.created_at, ?), COALESCE(organization.updated_at, ?)
          FROM organizations organization
          JOIN works work ON work.id = organization.work_id
          WHERE organization.is_favorite = 1 AND work.owner_user_id IS NOT NULL
          ON CONFLICT(work_id, entity_type, entity_id, user_id) DO UPDATE SET is_favorite = excluded.is_favorite, updated_at = excluded.updated_at`,
          timestamp,
          timestamp
        );
        this.run("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (120, ?)", timestamp);
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    const workOwnerColumn = this.all<{ name: string; notnull: number }>("PRAGMA table_info(works)")
      .find((column) => column.name === "owner_user_id");
    const workOwnerForeignKeyPresent = this.all<{ table: string; from: string; on_delete: string }>("PRAGMA foreign_key_list(works)")
      .some((foreignKey) => foreignKey.table === "users" && foreignKey.from === "owner_user_id" && foreignKey.on_delete === "RESTRICT");
    const systemUserPresent = this.get("SELECT 1 AS present FROM users WHERE id = ?", SYSTEM_USER_ID) !== undefined;
    if (!applied.has(121) || workOwnerColumn?.notnull !== 1 || !workOwnerForeignKeyPresent || !systemUserPresent) {
      this.raw.exec("PRAGMA foreign_keys = OFF");
      try {
        this.transaction(() => {
          const timestamp = new Date().toISOString();
          this.run(
            `INSERT INTO users (
              id, username, normalized_username, display_name, password_hash, password_salt,
              role, status, created_at, updated_at
            ) VALUES (?, '__scriverse_system__', '__scriverse_system__', 'Scriverse System', 'disabled', 'disabled', 'user', 'disabled', ?, ?)
            ON CONFLICT(id) DO UPDATE SET status = 'disabled', updated_at = excluded.updated_at`,
            SYSTEM_USER_ID,
            timestamp,
            timestamp
          );
          this.run("UPDATE works SET owner_user_id = ? WHERE id = ?", SYSTEM_USER_ID, PLATFORM_AI_WORK_ID);
          this.run(
            `UPDATE works SET owner_user_id = COALESCE(
              (
                SELECT membership.user_id
                FROM work_memberships membership
                JOIN users member ON member.id = membership.user_id
                WHERE membership.work_id = works.id AND member.id <> ?
                ORDER BY CASE membership.role WHEN 'owner' THEN 0 ELSE 1 END, membership.created_at, membership.user_id
                LIMIT 1
              ),
              (
                SELECT candidate.id
                FROM users candidate
                WHERE candidate.id <> ? AND candidate.status = 'active'
                ORDER BY CASE candidate.role WHEN 'admin' THEN 0 ELSE 1 END, candidate.created_at, candidate.id
                LIMIT 1
              ),
              ?
            )
            WHERE id <> ? AND (
              owner_user_id IS NULL
              OR NOT EXISTS (SELECT 1 FROM users owner WHERE owner.id = works.owner_user_id)
            )`,
            SYSTEM_USER_ID,
            SYSTEM_USER_ID,
            SYSTEM_USER_ID,
            PLATFORM_AI_WORK_ID
          );
          this.run("DROP TABLE IF EXISTS works_v121");
          this.run(`CREATE TABLE works_v121 (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            author TEXT NOT NULL DEFAULT '',
            description TEXT NOT NULL DEFAULT '',
            language TEXT NOT NULL DEFAULT 'zh-CN',
            cover_url TEXT,
            tags_json TEXT NOT NULL DEFAULT '[]',
            is_internal INTEGER NOT NULL DEFAULT 0,
            offline_access_enabled INTEGER NOT NULL DEFAULT 0 CHECK(offline_access_enabled IN (0, 1)),
            version_no INTEGER NOT NULL DEFAULT 1,
            deleted_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT
          )`);
          this.run(`INSERT INTO works_v121 (
            id, title, author, description, language, cover_url, tags_json, is_internal,
            offline_access_enabled, version_no, deleted_at, created_at, updated_at, owner_user_id
          )
          SELECT
            id, title, author, description, language, cover_url, tags_json, is_internal,
            offline_access_enabled, version_no, deleted_at, created_at, updated_at, owner_user_id
          FROM works`);
          this.run("DROP TABLE works");
          this.run("ALTER TABLE works_v121 RENAME TO works");
          this.run("CREATE INDEX IF NOT EXISTS idx_works_owner ON works(owner_user_id, updated_at DESC)");
          this.run("CREATE INDEX IF NOT EXISTS idx_works_recycle_bin ON works(deleted_at, owner_user_id)");
          this.run("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (121, ?)", timestamp);
        });
      } finally {
        this.raw.exec("PRAGMA foreign_keys = ON");
      }
    }
    const aiWritePlanTablesPresent = [
      "work_ai_tool_settings",
      "ai_write_plans",
      "ai_write_plan_operations",
      "ai_user_questions"
    ].every((table) => this.get(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
      table
    ) !== undefined);
    if (!applied.has(122) || !aiWritePlanTablesPresent) {
      this.transaction(() => {
        const conversationColumns = new Set(this.all("PRAGMA table_info(ai_conversations)").map((row) => String(row.name)));
        if (!conversationColumns.has("ai_write_tools_json")) {
          this.run("ALTER TABLE ai_conversations ADD COLUMN ai_write_tools_json TEXT");
        }
        // 作品级 AI 可写工具开关：默认全部关闭，仅拥有 AI 设置权限的用户可修改。
        this.run(`
          CREATE TABLE IF NOT EXISTS work_ai_tool_settings (
            work_id TEXT PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
            tools_json TEXT NOT NULL DEFAULT '{}',
            updated_at TEXT NOT NULL,
            updated_by_user_id TEXT
          )
        `);
        // AI 修改计划（审批）：AI 只能提交计划，确认接口只接收审批 ID。
        this.run(`
          CREATE TABLE IF NOT EXISTS ai_write_plans (
            id TEXT PRIMARY KEY,
            work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
            conversation_id TEXT,
            plan_kind TEXT NOT NULL DEFAULT 'write' CHECK(plan_kind IN ('write', 'undo')),
            status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'rejected', 'expired', 'invalidated', 'executing', 'executed', 'failed')),
            ai_summary TEXT NOT NULL DEFAULT '',
            max_operations INTEGER NOT NULL,
            invalid_reason TEXT NOT NULL DEFAULT '',
            failure_message TEXT,
            initiator_user_id TEXT,
            conversation_owner_user_id TEXT,
            source_plan_id TEXT,
            created_at TEXT NOT NULL,
            decided_at TEXT,
            executed_at TEXT,
            executed_by_user_id TEXT
          )
        `);
        // 计划操作明细：创建时由系统根据当前数据库内容生成不可变 diff，执行成功后补充结果列。
        this.run(`
          CREATE TABLE IF NOT EXISTS ai_write_plan_operations (
            id TEXT PRIMARY KEY,
            plan_id TEXT NOT NULL REFERENCES ai_write_plans(id) ON DELETE CASCADE,
            seq INTEGER NOT NULL,
            op_type TEXT NOT NULL CHECK(op_type IN ('create_entry', 'update_entry', 'create_annotation', 'create_task')),
            module TEXT NOT NULL,
            entity_type TEXT NOT NULL DEFAULT '',
            entity_id TEXT,
            target_version_no INTEGER,
            title TEXT NOT NULL DEFAULT '',
            operation_input_json TEXT NOT NULL DEFAULT '{}',
            detail_json TEXT NOT NULL DEFAULT '{}',
            required_modules_json TEXT NOT NULL DEFAULT '[]',
            result_entity_id TEXT,
            result_version_no INTEGER,
            result_summary TEXT NOT NULL DEFAULT ''
          )
        `);
        this.run("CREATE INDEX IF NOT EXISTS idx_ai_write_plans_work ON ai_write_plans(work_id, created_at)");
        this.run("CREATE INDEX IF NOT EXISTS idx_ai_write_plans_initiator ON ai_write_plans(initiator_user_id)");
        this.run("CREATE INDEX IF NOT EXISTS idx_ai_write_plans_owner ON ai_write_plans(conversation_owner_user_id)");
        this.run("CREATE INDEX IF NOT EXISTS idx_ai_write_plan_operations_plan ON ai_write_plan_operations(plan_id, seq)");
        // AskUserQuestions 提问记录：一次一个问题，持久化保存，支持刷新后继续查看。
        this.run(`
          CREATE TABLE IF NOT EXISTS ai_user_questions (
            id TEXT PRIMARY KEY,
            work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
            conversation_id TEXT,
            initiator_user_id TEXT,
            recipient_user_id TEXT,
            question TEXT NOT NULL,
            options_json TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'answered', 'rejected', 'expired')),
            selected_option INTEGER,
            answer_text TEXT NOT NULL DEFAULT '',
            is_custom_answer INTEGER NOT NULL DEFAULT 0,
            tool_call_id TEXT,
            continuation_json TEXT NOT NULL DEFAULT '{}',
            resume_state TEXT NOT NULL DEFAULT 'pending' CHECK(resume_state IN ('pending', 'claimed', 'completed', 'failed')),
            resume_result_json TEXT NOT NULL DEFAULT '{}',
            resumed_at TEXT,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            decided_at TEXT
          )
        `);
        this.run("CREATE INDEX IF NOT EXISTS idx_ai_user_questions_conversation ON ai_user_questions(conversation_id, status)");
        this.run("CREATE INDEX IF NOT EXISTS idx_ai_user_questions_work ON ai_user_questions(work_id, created_at)");
        this.run("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (122, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    const roleplayMemoryTablesPresent = [
      "roleplay_memories",
      "roleplay_memory_sources",
      "roleplay_memory_versions",
      "roleplay_memory_fts"
    ].every((name) => this.get("SELECT 1 AS present FROM sqlite_master WHERE name = ?", name) !== undefined);
    const roleplayMemoryColumns = new Set(this.all("PRAGMA table_info(roleplay_memories)").map((column) => String(column.name)));
    if (!applied.has(122) || !roleplayMemoryTablesPresent || !roleplayMemoryColumns.has("character_id") || !roleplayMemoryColumns.has("content_hash")) {
      this.transaction(() => {
        this.run(`CREATE TABLE IF NOT EXISTS roleplay_memories (
          id TEXT PRIMARY KEY,
          work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
          character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
          category TEXT NOT NULL CHECK(category IN ('event', 'state', 'relationship', 'commitment', 'knowledge', 'scene')),
          content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 2000),
          content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
          importance TEXT NOT NULL DEFAULT 'medium' CHECK(importance IN ('low', 'medium', 'high')),
          certainty TEXT NOT NULL DEFAULT 'experienced' CHECK(certainty IN ('experienced', 'observed', 'heard', 'believed')),
          origin TEXT NOT NULL DEFAULT 'roleplay' CHECK(origin = 'roleplay'),
          canonical INTEGER NOT NULL DEFAULT 0 CHECK(canonical = 0),
          status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'superseded', 'archived')),
          is_pinned INTEGER NOT NULL DEFAULT 0 CHECK(is_pinned IN (0, 1)),
          version_no INTEGER NOT NULL DEFAULT 1 CHECK(version_no > 0),
          superseded_by_memory_id TEXT REFERENCES roleplay_memories(id) ON DELETE SET NULL,
          source_type TEXT NOT NULL CHECK(source_type IN ('ai', 'manual')),
          source_assistant_message_id TEXT REFERENCES ai_conversation_messages(id) ON DELETE SET NULL,
          idempotency_key TEXT,
          created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(character_id, content_hash),
          UNIQUE(character_id, idempotency_key)
        )`);
        this.run(`CREATE TABLE IF NOT EXISTS roleplay_memory_sources (
          id TEXT PRIMARY KEY,
          memory_id TEXT NOT NULL REFERENCES roleplay_memories(id) ON DELETE CASCADE,
          conversation_id TEXT REFERENCES ai_conversations(id) ON DELETE SET NULL,
          message_id TEXT REFERENCES ai_conversation_messages(id) ON DELETE SET NULL,
          message_role TEXT NOT NULL CHECK(message_role IN ('user', 'assistant')),
          source_created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          source_created_at TEXT NOT NULL,
          evidence_snapshot TEXT NOT NULL CHECK(length(evidence_snapshot) <= 2000),
          created_at TEXT NOT NULL,
          UNIQUE(memory_id, message_id)
        )`);
        this.run(`CREATE TABLE IF NOT EXISTS roleplay_memory_versions (
          id TEXT PRIMARY KEY,
          memory_id TEXT NOT NULL REFERENCES roleplay_memories(id) ON DELETE CASCADE,
          version_no INTEGER NOT NULL CHECK(version_no > 0),
          category TEXT NOT NULL CHECK(category IN ('event', 'state', 'relationship', 'commitment', 'knowledge', 'scene')),
          content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 2000),
          importance TEXT NOT NULL CHECK(importance IN ('low', 'medium', 'high')),
          certainty TEXT NOT NULL CHECK(certainty IN ('experienced', 'observed', 'heard', 'believed')),
          status TEXT NOT NULL CHECK(status IN ('active', 'superseded', 'archived')),
          is_pinned INTEGER NOT NULL CHECK(is_pinned IN (0, 1)),
          action TEXT NOT NULL CHECK(action IN ('created', 'edited', 'pinned', 'archived', 'restored', 'superseded', 'merged')),
          actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL,
          UNIQUE(memory_id, version_no)
        )`);
        this.run("CREATE INDEX IF NOT EXISTS idx_roleplay_memories_character ON roleplay_memories(work_id, character_id, status, is_pinned DESC, importance DESC, updated_at DESC)");
        this.run("CREATE INDEX IF NOT EXISTS idx_roleplay_memory_sources_memory ON roleplay_memory_sources(memory_id, created_at, id)");
        this.run("CREATE INDEX IF NOT EXISTS idx_roleplay_memory_versions_memory ON roleplay_memory_versions(memory_id, version_no DESC)");
        this.raw.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS roleplay_memory_fts USING fts5(
            memory_id UNINDEXED,
            character_id UNINDEXED,
            category UNINDEXED,
            status UNINDEXED,
            content,
            tokenize='trigram'
          );
          CREATE TRIGGER IF NOT EXISTS roleplay_memory_fts_ai AFTER INSERT ON roleplay_memories BEGIN
            INSERT INTO roleplay_memory_fts(memory_id, character_id, category, status, content)
            VALUES (new.id, new.character_id, new.category, new.status, lower(new.content));
          END;
          CREATE TRIGGER IF NOT EXISTS roleplay_memory_fts_ad AFTER DELETE ON roleplay_memories BEGIN
            DELETE FROM roleplay_memory_fts WHERE memory_id = old.id;
          END;
          CREATE TRIGGER IF NOT EXISTS roleplay_memory_fts_au AFTER UPDATE OF character_id, category, status, content ON roleplay_memories BEGIN
            DELETE FROM roleplay_memory_fts WHERE memory_id = old.id;
            INSERT INTO roleplay_memory_fts(memory_id, character_id, category, status, content)
            VALUES (new.id, new.character_id, new.category, new.status, lower(new.content));
          END;
        `);
        this.run("DELETE FROM roleplay_memory_fts");
        this.run(`INSERT INTO roleplay_memory_fts(memory_id, character_id, category, status, content)
          SELECT id, character_id, category, status, lower(content) FROM roleplay_memories`);
        const timestamp = new Date().toISOString();
        this.run("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (122, ?)", timestamp);
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    const workPreferenceColumns = new Set(
      this.all<{ name: string }>("PRAGMA table_info(works)").map((column) => column.name)
    );
    if (!applied.has(122) || !workPreferenceColumns.has("editor_auto_indent_enabled") || !workPreferenceColumns.has("editor_typewriter_mode_enabled")) {
      this.transaction(() => {
        if (!workPreferenceColumns.has("editor_auto_indent_enabled")) {
          this.run("ALTER TABLE works ADD COLUMN editor_auto_indent_enabled INTEGER NOT NULL DEFAULT 0 CHECK(editor_auto_indent_enabled IN (0, 1))");
        }
        if (!workPreferenceColumns.has("editor_typewriter_mode_enabled")) {
          this.run("ALTER TABLE works ADD COLUMN editor_typewriter_mode_enabled INTEGER NOT NULL DEFAULT 0 CHECK(editor_typewriter_mode_enabled IN (0, 1))");
        }
        this.run("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (122, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    const chapterAnnotationLineHashesPresent = this.all<{ name: string }>("PRAGMA table_info(chapter_annotations)")
      .some((column) => column.name === "line_hashes_json");
    if (!applied.has(123) || !chapterAnnotationLineHashesPresent) {
      this.transaction(() => {
        if (!chapterAnnotationLineHashesPresent) {
          this.run("ALTER TABLE chapter_annotations ADD COLUMN line_hashes_json TEXT NOT NULL DEFAULT '[]'");
        }
        const annotations = this.all<{ id: string; quote: string; line_hashes_json: string }>(
          "SELECT id, quote, line_hashes_json FROM chapter_annotations"
        );
        for (const annotation of annotations) {
          this.run(
            "UPDATE chapter_annotations SET line_hashes_json = ? WHERE id = ?",
            JSON.stringify(parseChapterAnnotationLineHashes(annotation.line_hashes_json, annotation.quote)),
            annotation.id
          );
        }
        this.run("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (123, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    const chapterLineIdsPresent = this.all<{ name: string }>("PRAGMA table_info(chapters)")
      .some((column) => column.name === "line_ids_json");
    const chapterAnnotationLineIdsPresent = this.all<{ name: string }>("PRAGMA table_info(chapter_annotations)")
      .some((column) => column.name === "anchor_line_ids_json");
    if (!applied.has(124) || !chapterLineIdsPresent || !chapterAnnotationLineIdsPresent) {
      this.transaction(() => {
        if (!chapterLineIdsPresent) {
          this.run("ALTER TABLE chapters ADD COLUMN line_ids_json TEXT NOT NULL DEFAULT '[]'");
        }
        if (!chapterAnnotationLineIdsPresent) {
          this.run("ALTER TABLE chapter_annotations ADD COLUMN anchor_line_ids_json TEXT NOT NULL DEFAULT '[]'");
        }
        const chapters = this.all<{ id: string; content: string; line_ids_json: string }>(
          "SELECT id, content, line_ids_json FROM chapters"
        );
        for (const chapter of chapters) {
          const existingLineIds = parseChapterLineIds(chapter.line_ids_json, chapter.content);
          const lineIds = existingLineIds.length > 0
            ? existingLineIds
            : createChapterLineIds(chapter.content, () => id("chapterLine"));
          this.run("UPDATE chapters SET line_ids_json = ? WHERE id = ?", JSON.stringify(lineIds), chapter.id);
          const annotations = this.all<{ id: string; start_line: number; end_line: number }>(
            "SELECT id, start_line, end_line FROM chapter_annotations WHERE chapter_id = ?",
            chapter.id
          );
          for (const annotation of annotations) {
            const startIndex = Math.max(0, Math.min(lineIds.length - 1, Number(annotation.start_line) - 1));
            const endIndex = Math.max(startIndex, Math.min(lineIds.length - 1, Number(annotation.end_line) - 1));
            this.run(
              "UPDATE chapter_annotations SET anchor_line_ids_json = ? WHERE id = ?",
              JSON.stringify(lineIds.slice(startIndex, endIndex + 1)),
              annotation.id
            );
          }
        }
        this.run("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (124, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    const modelKindPresent = this.all<{ name: string }>("PRAGMA table_info(models)")
      .some((column) => column.name === "model_kind");
    const semanticSettingsColumns = new Set(
      this.all<{ name: string }>("PRAGMA table_info(work_ai_settings)").map((column) => column.name)
    );
    const semanticIndexPresent = Boolean(this.get(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'semantic_index_entries'"
    ));
    if (!applied.has(125) || !modelKindPresent || !semanticIndexPresent) {
      this.transaction(() => {
        if (!modelKindPresent) {
          this.run("ALTER TABLE models ADD COLUMN model_kind TEXT NOT NULL DEFAULT 'chat' CHECK(model_kind IN ('chat', 'embedding', 'rerank'))");
        }
        const semanticSettings: Array<[string, string]> = [
          ["semantic_search_enabled", "INTEGER NOT NULL DEFAULT 0 CHECK(semantic_search_enabled IN (0, 1))"],
          ["semantic_embedding_model_id", "TEXT REFERENCES models(id) ON DELETE SET NULL"],
          ["semantic_rerank_model_id", "TEXT REFERENCES models(id) ON DELETE SET NULL"],
          ["semantic_vector_dimension", "INTEGER NOT NULL DEFAULT 1024 CHECK(semantic_vector_dimension BETWEEN 1 AND 65536)"],
          ["semantic_recall_limit", "INTEGER NOT NULL DEFAULT 20 CHECK(semantic_recall_limit BETWEEN 1 AND 200)"],
          ["semantic_result_limit", "INTEGER NOT NULL DEFAULT 12 CHECK(semantic_result_limit BETWEEN 1 AND 100)"],
          ["semantic_budget_tokens", "INTEGER NOT NULL DEFAULT 4000 CHECK(semantic_budget_tokens BETWEEN 256 AND 100000)"],
          ["semantic_channel_weight", "REAL NOT NULL DEFAULT 1 CHECK(semantic_channel_weight BETWEEN 0.1 AND 5)"]
        ];
        for (const [column, definition] of semanticSettings) {
          if (!semanticSettingsColumns.has(column)) this.run(`ALTER TABLE work_ai_settings ADD COLUMN ${column} ${definition}`);
        }
        this.raw.exec(`
          CREATE TABLE IF NOT EXISTS semantic_index_entries (
            id TEXT PRIMARY KEY,
            work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
            source_type TEXT NOT NULL CHECK(source_type IN (
              'chapter', 'setting', 'character', 'race', 'organization', 'timeline-track',
              'timeline-event', 'relationship', 'chapter-outline', 'foreshadow'
            )),
            source_id TEXT NOT NULL,
            section_id TEXT NOT NULL DEFAULT '',
            source_version TEXT NOT NULL,
            source_title TEXT NOT NULL,
            chunk_order INTEGER NOT NULL CHECK(chunk_order >= 0),
            start_line INTEGER NOT NULL CHECK(start_line >= 1),
            end_line INTEGER NOT NULL CHECK(end_line >= start_line),
            start_offset INTEGER NOT NULL CHECK(start_offset >= 0),
            end_offset INTEGER NOT NULL CHECK(end_offset >= start_offset),
            content TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            vector_json TEXT NOT NULL CHECK(json_valid(vector_json) AND json_type(vector_json) = 'array'),
            vector_dimension INTEGER NOT NULL CHECK(vector_dimension BETWEEN 1 AND 65536),
            embedding_model_id TEXT NOT NULL,
            config_fingerprint TEXT NOT NULL CHECK(length(config_fingerprint) = 64),
            chunk_rule_version INTEGER NOT NULL DEFAULT 1 CHECK(chunk_rule_version >= 1),
            created_at TEXT NOT NULL,
            UNIQUE(work_id, source_type, source_id, section_id, source_version, chunk_order, config_fingerprint)
          );
          CREATE INDEX IF NOT EXISTS idx_semantic_index_entries_recall
            ON semantic_index_entries(work_id, config_fingerprint, source_type, source_id);
          CREATE INDEX IF NOT EXISTS idx_semantic_index_entries_source
            ON semantic_index_entries(work_id, source_type, source_id, section_id, source_version);

          CREATE TABLE IF NOT EXISTS semantic_index_state (
            work_id TEXT PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
            status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('disabled', 'idle', 'building', 'ready', 'failed', 'paused')),
            config_fingerprint TEXT NOT NULL DEFAULT '',
            total_sources INTEGER NOT NULL DEFAULT 0 CHECK(total_sources >= 0),
            processed_sources INTEGER NOT NULL DEFAULT 0 CHECK(processed_sources >= 0),
            failed_sources INTEGER NOT NULL DEFAULT 0 CHECK(failed_sources >= 0),
            consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_failures >= 0),
            error TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL
          ) WITHOUT ROWID;

          CREATE TABLE IF NOT EXISTS semantic_context_snapshots (
            id TEXT PRIMARY KEY,
            work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
            conversation_id TEXT REFERENCES ai_conversations(id) ON DELETE SET NULL,
            query TEXT NOT NULL,
            scope_json TEXT NOT NULL CHECK(json_valid(scope_json) AND json_type(scope_json) = 'object'),
            config_fingerprint TEXT NOT NULL CHECK(length(config_fingerprint) = 64),
            created_by_user_id TEXT,
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_semantic_context_snapshots_work
            ON semantic_context_snapshots(work_id, created_at DESC);

          CREATE TABLE IF NOT EXISTS semantic_context_snapshot_items (
            snapshot_id TEXT NOT NULL REFERENCES semantic_context_snapshots(id) ON DELETE CASCADE,
            position INTEGER NOT NULL CHECK(position >= 0),
            entry_id TEXT NOT NULL,
            source_type TEXT NOT NULL,
            source_id TEXT NOT NULL,
            section_id TEXT NOT NULL DEFAULT '',
            source_version TEXT NOT NULL,
            source_title TEXT NOT NULL,
            start_line INTEGER NOT NULL CHECK(start_line >= 1),
            end_line INTEGER NOT NULL CHECK(end_line >= start_line),
            content TEXT NOT NULL,
            estimated_tokens INTEGER NOT NULL CHECK(estimated_tokens >= 0),
            semantic_score REAL NOT NULL,
            rerank_score REAL,
            match_kinds_json TEXT NOT NULL CHECK(json_valid(match_kinds_json) AND json_type(match_kinds_json) = 'array'),
            PRIMARY KEY(snapshot_id, position),
            UNIQUE(snapshot_id, entry_id)
          ) WITHOUT ROWID;
        `);
        this.run("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (125, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    const workMcpSettingsPresent = this.get(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'work_mcp_settings'"
    ) !== undefined;
    if (!applied.has(126) || !workMcpSettingsPresent) {
      this.transaction(() => {
        this.run(`CREATE TABLE IF NOT EXISTS work_mcp_settings (
          work_id TEXT PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
          config_encrypted TEXT NOT NULL,
          config_iv TEXT NOT NULL,
          config_tag TEXT NOT NULL,
          tool_catalog_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tool_catalog_json) AND json_type(tool_catalog_json) = 'array'),
          updated_at TEXT NOT NULL
        )`);
        this.run("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (126, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    const imTablesPresent = [
      "im_user_settings",
      "im_conversations",
      "im_human_memberships",
      "im_character_memberships",
      "im_messages",
      "im_mentions",
      "im_message_deliveries",
      "im_character_contexts",
      "im_chains",
      "im_chain_turns"
    ].every((table) => this.get(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
      table
    ) !== undefined);
    const imMessageContextEpochPresent = this.all<{ name: string }>("PRAGMA table_info(im_messages)")
      .some((column) => column.name === "context_epoch");
    if (!applied.has(127) || !imTablesPresent || !imMessageContextEpochPresent) {
      this.transaction(() => {
        this.raw.exec(IM_SCHEMA_SQL);
        const messageColumns = new Set(this.all<{ name: string }>("PRAGMA table_info(im_messages)").map((column) => column.name));
        if (!messageColumns.has("context_epoch")) {
          this.run("ALTER TABLE im_messages ADD COLUMN context_epoch INTEGER NOT NULL DEFAULT 1 CHECK(context_epoch > 0)");
        }
        this.run("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (127, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    const imHumanConversationSnapshotPresent = this.all<{ name: string }>("PRAGMA table_info(im_human_memberships)")
      .some((column) => column.name === "conversation_snapshot_json");
    if (!applied.has(128) || !imHumanConversationSnapshotPresent) {
      this.transaction(() => {
        if (!imHumanConversationSnapshotPresent) {
          this.run(`ALTER TABLE im_human_memberships ADD COLUMN conversation_snapshot_json TEXT
            CHECK(conversation_snapshot_json IS NULL OR (json_valid(conversation_snapshot_json) AND json_type(conversation_snapshot_json) = 'object'))`);
        }
        this.run("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (128, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    const imAvatarVersionsPresent = this.get(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'im_avatar_versions'"
    ) !== undefined;
    if (!applied.has(129) || !imAvatarVersionsPresent) {
      this.transaction(() => {
        this.raw.exec(`CREATE TABLE IF NOT EXISTS im_avatar_versions (
          conversation_id TEXT NOT NULL REFERENCES im_conversations(id) ON DELETE CASCADE,
          participant_kind TEXT NOT NULL CHECK(participant_kind IN ('character', 'user')),
          participant_id TEXT NOT NULL,
          sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
          mime_type TEXT NOT NULL,
          byte_length INTEGER NOT NULL CHECK(byte_length >= 0),
          storage_key TEXT,
          content BLOB,
          width INTEGER NOT NULL CHECK(width > 0),
          height INTEGER NOT NULL CHECK(height > 0),
          created_at TEXT NOT NULL,
          PRIMARY KEY(conversation_id, participant_kind, participant_id, sha256),
          CHECK((participant_kind = 'character' AND storage_key IS NOT NULL AND content IS NULL)
            OR (participant_kind = 'user' AND storage_key IS NULL AND content IS NOT NULL))
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS idx_im_avatar_versions_storage
          ON im_avatar_versions(storage_key) WHERE storage_key IS NOT NULL;`);
        this.run("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (129, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    const imChainRetrySourcePresent = this.all<{ name: string }>("PRAGMA table_info(im_chains)")
      .some((column) => column.name === "retry_source_chain_id");
    const imChainRetrySourceIndexPresent = this.get(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = 'idx_im_chains_retry_source'"
    ) !== undefined;
    if (!applied.has(130) || !imChainRetrySourcePresent || !imChainRetrySourceIndexPresent) {
      this.transaction(() => {
        if (!imChainRetrySourcePresent) {
          this.run("ALTER TABLE im_chains ADD COLUMN retry_source_chain_id TEXT REFERENCES im_chains(id) ON DELETE SET NULL");
        }
        this.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_im_chains_retry_source
          ON im_chains(retry_source_chain_id) WHERE retry_source_chain_id IS NOT NULL`);
        this.run("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (130, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    const imAvatarVersionsEmpty = Number(this.get(
      "SELECT COUNT(*) AS count FROM im_avatar_versions"
    )?.count ?? 0) === 0;
    const imAvatarVersionRecoverySourcePresent = imAvatarVersionsEmpty && this.get(
      `SELECT 1 AS present
       WHERE EXISTS (
         SELECT 1 FROM im_character_memberships membership
         JOIN character_avatars avatar ON avatar.character_id = membership.character_id
         WHERE membership.left_at IS NULL
       ) OR EXISTS (
         SELECT 1 FROM im_human_memberships membership
         JOIN user_avatars avatar ON avatar.user_id = membership.user_id
         WHERE membership.left_at IS NULL
       )`
    ) !== undefined;
    if (!applied.has(131) || !imAvatarVersionsPresent || imAvatarVersionRecoverySourcePresent) {
      this.transaction(() => {
          this.run(`INSERT OR IGNORE INTO im_avatar_versions (
            conversation_id, participant_kind, participant_id, sha256, mime_type, byte_length,
            storage_key, content, width, height, created_at
          )
          SELECT membership.conversation_id, 'character', avatar.character_id, avatar.sha256,
                 avatar.mime_type, avatar.byte_length, avatar.storage_key, NULL,
                 avatar.width, avatar.height, avatar.updated_at
          FROM im_character_memberships membership
          JOIN character_avatars avatar ON avatar.character_id = membership.character_id
          WHERE membership.left_at IS NULL`);
          this.run(`INSERT OR IGNORE INTO im_avatar_versions (
            conversation_id, participant_kind, participant_id, sha256, mime_type, byte_length,
            storage_key, content, width, height, created_at
          )
          SELECT membership.conversation_id, 'user', avatar.user_id, avatar.sha256,
                 avatar.mime_type, avatar.byte_length, NULL, avatar.content,
                 avatar.width, avatar.height, avatar.updated_at
          FROM im_human_memberships membership
          JOIN user_avatars avatar ON avatar.user_id = membership.user_id
          WHERE membership.left_at IS NULL`);
          this.run(`INSERT OR IGNORE INTO im_avatar_versions (
            conversation_id, participant_kind, participant_id, sha256, mime_type, byte_length,
            storage_key, content, width, height, created_at
          )
          SELECT message.conversation_id, 'character', avatar.character_id, avatar.sha256,
                 avatar.mime_type, avatar.byte_length, avatar.storage_key, NULL,
                 avatar.width, avatar.height, message.created_at
          FROM im_messages message
          JOIN character_avatars avatar
            ON avatar.character_id = COALESCE(message.sender_character_id, json_extract(message.sender_snapshot_json, '$.id'))
           AND avatar.sha256 = COALESCE(
             NULLIF(json_extract(message.sender_snapshot_json, '$.avatarSha256'), ''),
             CASE WHEN instr(json_extract(message.sender_snapshot_json, '$.avatarUrl'), '?v=') > 0
               THEN substr(json_extract(message.sender_snapshot_json, '$.avatarUrl'), instr(json_extract(message.sender_snapshot_json, '$.avatarUrl'), '?v=') + 3)
             END
           )
          WHERE message.sender_kind = 'character'`);
          this.run(`INSERT OR IGNORE INTO im_avatar_versions (
            conversation_id, participant_kind, participant_id, sha256, mime_type, byte_length,
            storage_key, content, width, height, created_at
          )
          SELECT message.conversation_id, 'user', avatar.user_id, avatar.sha256,
                 avatar.mime_type, avatar.byte_length, NULL, avatar.content,
                 avatar.width, avatar.height, message.created_at
          FROM im_messages message
          JOIN user_avatars avatar
            ON avatar.user_id = COALESCE(message.sender_user_id, json_extract(message.sender_snapshot_json, '$.userId'))
           AND avatar.sha256 = COALESCE(
             NULLIF(json_extract(message.sender_snapshot_json, '$.avatarSha256'), ''),
             CASE WHEN instr(json_extract(message.sender_snapshot_json, '$.avatarUrl'), '?v=') > 0
               THEN substr(json_extract(message.sender_snapshot_json, '$.avatarUrl'), instr(json_extract(message.sender_snapshot_json, '$.avatarUrl'), '?v=') + 3)
             END
           )
          WHERE message.sender_kind = 'human'`);
          this.run(`INSERT OR IGNORE INTO im_avatar_versions (
            conversation_id, participant_kind, participant_id, sha256, mime_type, byte_length,
            storage_key, content, width, height, created_at
          )
          SELECT viewer.conversation_id, 'character', avatar.character_id, avatar.sha256,
                 avatar.mime_type, avatar.byte_length, avatar.storage_key, NULL,
                 avatar.width, avatar.height, viewer.left_at
          FROM im_human_memberships viewer, json_each(viewer.conversation_snapshot_json, '$.participants.characters') participant
          JOIN character_avatars avatar
            ON avatar.character_id = json_extract(participant.value, '$.characterId')
           AND avatar.sha256 = substr(
             json_extract(participant.value, '$.avatarUrl'),
             instr(json_extract(participant.value, '$.avatarUrl'), '?v=') + 3
           )
          WHERE viewer.conversation_snapshot_json IS NOT NULL AND viewer.left_at IS NOT NULL`);
          this.run(`INSERT OR IGNORE INTO im_avatar_versions (
            conversation_id, participant_kind, participant_id, sha256, mime_type, byte_length,
            storage_key, content, width, height, created_at
          )
          SELECT viewer.conversation_id, 'user', avatar.user_id, avatar.sha256,
                 avatar.mime_type, avatar.byte_length, NULL, avatar.content,
                 avatar.width, avatar.height, viewer.left_at
          FROM im_human_memberships viewer, json_each(viewer.conversation_snapshot_json, '$.participants.humans') participant
          JOIN user_avatars avatar
            ON avatar.user_id = json_extract(participant.value, '$.userId')
           AND avatar.sha256 = substr(
             json_extract(participant.value, '$.avatarUrl'),
             instr(json_extract(participant.value, '$.avatarUrl'), '?v=') + 3
           )
          WHERE viewer.conversation_snapshot_json IS NOT NULL AND viewer.left_at IS NOT NULL`);
        this.run("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (131, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    const imMembershipConversationIndexesPresent = [
      "idx_im_human_memberships_conversation",
      "idx_im_character_memberships_conversation"
    ].every((index) => this.get(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = ?",
      index
    ) !== undefined);
    if (!applied.has(132) || !imMembershipConversationIndexesPresent) {
      this.transaction(() => {
        this.run(`CREATE INDEX IF NOT EXISTS idx_im_human_memberships_conversation
          ON im_human_memberships(conversation_id, joined_at, id)`);
        this.run(`CREATE INDEX IF NOT EXISTS idx_im_character_memberships_conversation
          ON im_character_memberships(conversation_id, joined_at, id)`);
        this.run("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (132, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
    const imMessageAvatarIndexesPresent = [
      "idx_im_messages_human_avatar",
      "idx_im_messages_character_avatar",
      "idx_im_messages_character_snapshot_avatar"
    ].every((index) => this.get(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = ?",
      index
    ) !== undefined);
    if (!applied.has(133) || !imMessageAvatarIndexesPresent) {
      this.transaction(() => {
        this.run(`CREATE INDEX IF NOT EXISTS idx_im_messages_human_avatar
          ON im_messages(conversation_id, sender_user_id, sequence) WHERE sender_kind = 'human'`);
        this.run(`CREATE INDEX IF NOT EXISTS idx_im_messages_character_avatar
          ON im_messages(conversation_id, sender_character_id, sequence) WHERE sender_kind = 'character'`);
        this.run(`CREATE INDEX IF NOT EXISTS idx_im_messages_character_snapshot_avatar
          ON im_messages(conversation_id, json_extract(sender_snapshot_json, '$.id'), sequence)
          WHERE sender_kind = 'character' AND sender_character_id IS NULL`);
        this.run("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (133, ?)", new Date().toISOString());
      });
      const integrity = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
    }
  }

  private normalizeCharacterName(value: string): string {
    return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("zh-CN");
  }

  private parseAliases(value: string): string[] {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch {
      return [];
    }
  }

  private recoverInterruptedOperations(): void {
    const timestamp = new Date().toISOString();
    this.run(
      `UPDATE ai_calls SET status = 'failed', failure = COALESCE(failure, '服务重启导致调用中断'), completed_at = ?
       WHERE status = 'running'`,
      timestamp
    );
    this.run(
      `UPDATE analysis_tasks SET status = 'partial', failure_json = ?, updated_at = ?
       WHERE status = 'running'`,
      JSON.stringify([{ message: "服务重启导致任务中断" }]),
      timestamp
    );
    this.run(
      `UPDATE s3_backup_runs SET status = 'failed', error_message = COALESCE(error_message, '服务重启导致备份中断'), finished_at = ?
       WHERE status = 'running'`,
      timestamp
    );
    this.run(
      `UPDATE im_chains SET status = 'interrupted', error_code = 'IM_CHAIN_RUNTIME_RESTARTED',
       error_message = '服务重启导致 IM 交流链中断，可从原消息重试', updated_at = ?, completed_at = ?
       WHERE status IN ('queued', 'running')`,
      timestamp,
      timestamp
    );
    this.run(
      `UPDATE im_chain_turns SET status = 'cancelled', failure = COALESCE(failure, '服务重启导致调用中断'), completed_at = ?
       WHERE status IN ('pending', 'running')`,
      timestamp
    );
  }
}
