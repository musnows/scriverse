import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { DATABASE_SCHEMA_VERSION, Database, PLATFORM_AI_WORK_ID, SYSTEM_USER_ID } from "../../src/database.js";
import { Store } from "../../src/store.js";
import { chapterAnnotationLineHashes } from "../../src/chapter-annotation-anchor.js";

const roots: string[] = [];

function createLegacyDatabase(conflict = false): string {
  const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-"));
  roots.push(root);
  const filename = join(root, "legacy.db");
  const database = new DatabaseSync(filename);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE works (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
      language TEXT NOT NULL DEFAULT 'zh-CN', cover_url TEXT, tags_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE volumes (
      id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE, title TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'main', source TEXT NOT NULL DEFAULT 'manual', sort_order INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE chapters (
      id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
      volume_id TEXT NOT NULL REFERENCES volumes(id) ON DELETE CASCADE, title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL, word_count INTEGER NOT NULL DEFAULT 0, version_no INTEGER NOT NULL DEFAULT 1,
      analysis_status TEXT NOT NULL DEFAULT 'pending', excluded_from_analysis INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE platform_ui_settings (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      toast_position TEXT NOT NULL DEFAULT 'bottom-right' CHECK(toast_position IN ('bottom-right', 'top-right')),
      updated_at TEXT NOT NULL
    );
    INSERT INTO platform_ui_settings (id, toast_position, updated_at) VALUES (1, 'top-right', '2025-01-01');
    CREATE TABLE characters (
      id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE, name TEXT NOT NULL,
      aliases_json TEXT NOT NULL DEFAULT '[]', attributes_json TEXT NOT NULL DEFAULT '{}', profile_json TEXT NOT NULL DEFAULT '{}',
      current_state_json TEXT NOT NULL DEFAULT '{}', locked_fields_json TEXT NOT NULL DEFAULT '[]', visibility TEXT NOT NULL DEFAULT 'author',
      first_chapter_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO works VALUES ('work-old', '旧作品', '', '', 'zh-CN', NULL, '[]', '2025-01-01', '2025-01-01');
    INSERT INTO volumes VALUES ('volume-old', 'work-old', '第一卷', 'main', 'manual', 0, '2025-01-01', '2025-01-01');
    INSERT INTO chapters VALUES ('chapter-old', 'work-old', 'volume-old', '第一章', '旧正文', 0, 3, 1, 'pending', 0, '2025-01-01', '2025-01-01');
  `);
  const insert = database.prepare(`INSERT INTO characters
    (id, work_id, name, aliases_json, attributes_json, profile_json, current_state_json, locked_fields_json, visibility, first_chapter_id, created_at, updated_at)
    VALUES (?, 'work-old', ?, ?, '{}', '{}', '{}', '[]', 'author', NULL, '2025-01-01', '2025-01-01')`);
  insert.run("character-a", "魔斯拉", JSON.stringify(["小魔", "Mothra"]));
  insert.run("character-b", conflict ? "小魔" : "拉顿", JSON.stringify([]));
  database.prepare("UPDATE characters SET attributes_json = ? WHERE id = 'character-a'").run(JSON.stringify({ species: "泰坦族" }));
  database.prepare("UPDATE characters SET profile_json = ? WHERE id = 'character-a'").run(JSON.stringify({
    summary: "星球守护者",
    sections: [{ title: "背景故事", content: "## 远古时期\n\n守护地球生态。" }]
  }));
  database.close();
  return filename;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function insertSystemOwnedWork(database: Database, workId: string, title: string, timestamp: string): void {
  database.run(
    `INSERT INTO works (id, title, created_at, updated_at, owner_user_id)
     VALUES (?, ?, ?, ?, ?)`,
    workId,
    title,
    timestamp,
    timestamp,
    SYSTEM_USER_ID
  );
}

describe("数据库版本化迁移", () => {
  it("迁移 127 为 AI 提问增加批量问题与回答字段", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-question-batch-"));
    roots.push(root);
    const filename = join(root, "question-batch.db");
    const current = new Database(filename);
    const store = new Store(current);
    const work = store.createWork({ title: "旧提问迁移作品" });
    current.run(
      `INSERT INTO ai_user_questions (
         id, work_id, question, options_json, status, selected_option, answer_text,
         is_custom_answer, created_at, expires_at
       ) VALUES ('legacy-question', ?, '旧问题？', '["甲","乙"]', 'answered', 1, '乙', 0, ?, ?)`,
      String(work.id),
      "2026-09-01T00:00:00.000Z",
      "2026-09-01T00:10:00.000Z"
    );
    current.run("ALTER TABLE ai_user_questions DROP COLUMN questions_json");
    current.run("ALTER TABLE ai_user_questions DROP COLUMN answers_json");
    current.run("DELETE FROM schema_migrations WHERE version = 127");
    current.close();

    const migrated = new Database(filename);
    const columns = migrated.all<{ name: string }>("PRAGMA table_info(ai_user_questions)").map((column) => column.name);
    expect(columns).toContain("questions_json");
    expect(columns).toContain("answers_json");
    expect(migrated.get("SELECT question, options_json, questions_json, answers_json FROM ai_user_questions WHERE id = 'legacy-question'"))
      .toEqual({ question: "旧问题？", options_json: '["甲","乙"]', questions_json: "[]", answers_json: "[]" });
    expect(migrated.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 127")).toEqual({ count: 1 });
    expect(migrated.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(migrated.all("PRAGMA foreign_key_check")).toEqual([]);
    migrated.close();
  });

  it("迁移 126 创建按作品级联清理的加密远程 MCP 配置表", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-remote-mcp-"));
    roots.push(root);
    const filename = join(root, "remote-mcp.db");
    const current = new Database(filename);
    current.run("DROP TABLE work_mcp_settings");
    current.run("DELETE FROM schema_migrations WHERE version = 126");
    current.close();

    const migrated = new Database(filename);
    expect(migrated.all("PRAGMA table_info(work_mcp_settings)").map((column) => column.name)).toEqual([
      "work_id",
      "config_encrypted",
      "config_iv",
      "config_tag",
      "tool_catalog_json",
      "updated_at"
    ]);
    const store = new Store(migrated);
    const work = store.createWork({ title: "MCP 迁移测试作品" });
    migrated.run(
      `INSERT INTO work_mcp_settings (
         work_id, config_encrypted, config_iv, config_tag, tool_catalog_json, updated_at
       ) VALUES (?, 'cipher', 'iv', 'tag', '[]', '2026-08-29T00:00:00.000Z')`,
      String(work.id)
    );
    migrated.run("DELETE FROM works WHERE id = ?", String(work.id));
    expect(migrated.get("SELECT COUNT(*) AS count FROM work_mcp_settings")).toEqual({ count: 0 });
    expect(migrated.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 126")).toEqual({ count: 1 });
    expect(migrated.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(migrated.all("PRAGMA foreign_key_check")).toEqual([]);
    migrated.close();
  });

  it("迁移 124 为重复正文和评论回填稳定且不同的行身份", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-stable-line-ids-"));
    roots.push(root);
    const filename = join(root, "stable-line-ids.db");
    const current = new Database(filename);
    const store = new Store(current);
    const work = store.createWork({ title: "稳定行身份迁移作品" });
    const volume = store.createVolume(String(work.id), { title: "第一卷" });
    const chapter = store.createChapter(String(work.id), {
      volumeId: String(volume.id),
      title: "第一章",
      content: "相同正文\n相同正文"
    });
    const annotation = store.createChapterAnnotation(String(chapter.id), {
      kind: "note",
      startLine: 2,
      endLine: 2,
      note: "绑定第二行"
    });
    current.raw.exec("ALTER TABLE chapter_annotations DROP COLUMN anchor_line_ids_json");
    current.raw.exec("ALTER TABLE chapters DROP COLUMN line_ids_json");
    current.run("DELETE FROM schema_migrations WHERE version = 124");
    current.close();

    const migrated = new Database(filename);
    const lineIds = JSON.parse(String(migrated.get(
      "SELECT line_ids_json FROM chapters WHERE id = ?",
      String(chapter.id)
    )?.line_ids_json)) as string[];
    const anchorLineIds = JSON.parse(String(migrated.get(
      "SELECT anchor_line_ids_json FROM chapter_annotations WHERE id = ?",
      String(annotation.id)
    )?.anchor_line_ids_json)) as string[];
    expect(lineIds).toHaveLength(2);
    expect(new Set(lineIds).size).toBe(2);
    expect(anchorLineIds).toEqual([lineIds[1]]);
    expect(migrated.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 124")).toEqual({ count: 1 });
    expect(migrated.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(migrated.all("PRAGMA foreign_key_check")).toEqual([]);
    migrated.close();
  });

  it("迁移 123 为历史正文评论回填逐行哈希并支持幂等重启", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-annotation-line-hashes-"));
    roots.push(root);
    const filename = join(root, "annotation-line-hashes.db");
    const current = new Database(filename);
    const store = new Store(current);
    const work = store.createWork({ title: "评论行哈希迁移作品" });
    const volume = store.createVolume(String(work.id), { title: "第一卷" });
    const chapter = store.createChapter(String(work.id), {
      volumeId: String(volume.id),
      title: "第一章",
      content: "第一行\n历史评论行\n最后一行"
    });
    const annotation = store.createChapterAnnotation(String(chapter.id), {
      kind: "note",
      startLine: 2,
      endLine: 2,
      note: "历史评论"
    });
    current.raw.exec("ALTER TABLE chapter_annotations DROP COLUMN line_hashes_json");
    current.run("DELETE FROM schema_migrations WHERE version = 123");
    current.close();

    const migrated = new Database(filename);
    const lineHashesColumn = migrated.all<{ name: string; notnull: number }>("PRAGMA table_info(chapter_annotations)")
      .find((column) => column.name === "line_hashes_json");
    expect(lineHashesColumn?.notnull).toBe(1);
    expect(JSON.parse(String(migrated.get(
      "SELECT line_hashes_json FROM chapter_annotations WHERE id = ?",
      String(annotation.id)
    )?.line_hashes_json))).toEqual(chapterAnnotationLineHashes("历史评论行"));
    expect(migrated.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 123")).toEqual({ count: 1 });
    expect(migrated.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(migrated.all("PRAGMA foreign_key_check")).toEqual([]);
    migrated.close();

    const restarted = new Database(filename);
    expect(JSON.parse(String(restarted.get(
      "SELECT line_hashes_json FROM chapter_annotations WHERE id = ?",
      String(annotation.id)
    )?.line_hashes_json))).toEqual(chapterAnnotationLineHashes("历史评论行"));
    restarted.close();
  });

  it("迁移 121 回填作品 Owner 并强制用户外键非空", () => {
    const filename = createLegacyDatabase();
    const database = new Database(filename);
    const ownerColumn = database.all<{ name: string; notnull: number }>("PRAGMA table_info(works)")
      .find((column) => column.name === "owner_user_id");
    const ownerForeignKey = database.all<{ table: string; from: string; on_delete: string }>("PRAGMA foreign_key_list(works)")
      .find((foreignKey) => foreignKey.from === "owner_user_id");
    const workColumns = database.all<{ name: string; notnull: number; dflt_value: string | null }>("PRAGMA table_info(works)");

    expect(ownerColumn?.notnull).toBe(1);
    expect(ownerForeignKey).toMatchObject({ table: "users", from: "owner_user_id", on_delete: "RESTRICT" });
    expect(database.get("SELECT owner_user_id FROM works WHERE id = 'work-old'")).toEqual({ owner_user_id: SYSTEM_USER_ID });
    expect(database.get("SELECT owner_user_id FROM works WHERE id = ?", PLATFORM_AI_WORK_ID)).toEqual({ owner_user_id: SYSTEM_USER_ID });
    expect(database.get("SELECT status FROM users WHERE id = ?", SYSTEM_USER_ID)).toEqual({ status: "disabled" });
    expect(workColumns).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "editor_auto_indent_enabled", notnull: 1, dflt_value: "0" }),
      expect.objectContaining({ name: "editor_typewriter_mode_enabled", notnull: 1, dflt_value: "0" })
    ]));
    expect(database.get(
      "SELECT editor_auto_indent_enabled, editor_typewriter_mode_enabled FROM works WHERE id = 'work-old'"
    )).toEqual({ editor_auto_indent_enabled: 0, editor_typewriter_mode_enabled: 0 });
    expect(() => database.run("UPDATE works SET editor_auto_indent_enabled = 2 WHERE id = 'work-old'")).toThrow();
    expect(() => database.run("UPDATE works SET editor_typewriter_mode_enabled = -1 WHERE id = 'work-old'")).toThrow();
    expect(() => database.run(
      "INSERT INTO works (id, title, created_at, updated_at, owner_user_id) VALUES ('owner-null', '空 Owner', '2026-08-25', '2026-08-25', NULL)"
    )).toThrow();
    expect(() => database.run(
      "INSERT INTO works (id, title, created_at, updated_at, owner_user_id) VALUES ('owner-missing', '错误 Owner', '2026-08-25', '2026-08-25', 'missing-user')"
    )).toThrow();
    expect(database.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(database.all("PRAGMA foreign_key_check")).toEqual([]);
    database.close();
  });

  it("迁移 122 建立角色共享记忆表且不迁移 compact 摘要", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-122-"));
    roots.push(root);
    const filename = join(root, "migration-122.db");
    const current = new Database(filename);
    insertSystemOwnedWork(current, "work-roleplay-memory", "角色扮演迁移", "2025-01-01");
    current.run(
      `INSERT INTO characters (id, work_id, name, created_at, updated_at)
       VALUES ('character-roleplay-memory', 'work-roleplay-memory', '林舟', '2025-01-01', '2025-01-01')`
    );
    current.run(
      `INSERT INTO ai_conversations (
        id, work_id, roleplay_character_id, task_type, title, compacted_summary,
        compacted_message_count, created_at, updated_at, created_by_user_id
      ) VALUES (?, ?, ?, 'roleplay', '旧扮演', ?, 4, '2025-01-01', '2025-01-01', ?)`,
      "conversation-roleplay-memory",
      "work-roleplay-memory",
      "character-roleplay-memory",
      JSON.stringify({ storyFacts: [{ text: "这只是上下文摘要" }] }),
      SYSTEM_USER_ID
    );
    current.run("DELETE FROM schema_migrations WHERE version = 122");
    current.close();

    const migrated = new Database(filename);
    expect(migrated.all("PRAGMA table_info(roleplay_memories)").map((column) => column.name)).toEqual(expect.arrayContaining([
      "work_id",
      "character_id",
      "content_hash",
      "origin",
      "canonical"
    ]));
    expect(migrated.all("PRAGMA table_info(roleplay_memories)").map((column) => column.name)).not.toContain("scope_id");
    expect(migrated.all("PRAGMA table_info(ai_conversations)").map((column) => column.name)).not.toContain("roleplay_memory_scope_id");
    expect(migrated.all("PRAGMA table_info(ai_conversation_messages)").map((column) => column.name)).not.toContain("roleplay_memory_revision");
    expect(migrated.get("SELECT name FROM sqlite_master WHERE name = 'roleplay_memory_scopes'")).toBeUndefined();
    expect(migrated.get("SELECT COUNT(*) AS count FROM roleplay_memories")).toEqual({ count: 0 });
    expect(migrated.get("SELECT compacted_summary FROM ai_conversations WHERE id = 'conversation-roleplay-memory'")).toEqual({
      compacted_summary: JSON.stringify({ storyFacts: [{ text: "这只是上下文摘要" }] })
    });
    expect(migrated.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(migrated.all("PRAGMA foreign_key_check")).toEqual([]);
    migrated.close();
  });

  it("无损回填角色主名与别名并支持幂等重启", () => {
    const filename = createLegacyDatabase();
    const first = new Database(filename);
    new Store(first);
    expect(first.all("SELECT display_name, kind FROM character_names ORDER BY character_id, sort_order")).toEqual([
      { display_name: "魔斯拉", kind: "primary" },
      { display_name: "小魔", kind: "alias" },
      { display_name: "Mothra", kind: "alias" },
      { display_name: "拉顿", kind: "primary" }
    ]);
    expect(first.all("SELECT version FROM schema_migrations ORDER BY version")).toEqual(Array.from({ length: DATABASE_SCHEMA_VERSION }, (_, index) => ({ version: index + 1 })));
    expect(first.all("PRAGMA table_info(characters)").map((column) => column.name)).toEqual(expect.arrayContaining(["code", "gender", "merged_into_character_id", "merged_at", "is_dead", "is_favorite"]));
    expect(first.all("PRAGMA index_list(characters)").some((index) => index.name === "idx_characters_favorite")).toBe(true);
    expect(first.get("SELECT is_favorite FROM characters WHERE id = 'character-a'")).toEqual({ is_favorite: 0 });
    expect(first.all("PRAGMA table_info(races)").map((column) => column.name)).toContain("is_extinct");
    expect(first.all("PRAGMA table_info(races)").map((column) => column.name)).not.toContain("is_favorite");
    expect(first.all("PRAGMA table_info(drafts)").map((column) => column.name)).toContain("is_favorite");
    expect(first.all("PRAGMA table_info(settings)").map((column) => column.name)).toContain("is_favorite");
    expect(first.all("PRAGMA table_info(organizations)").map((column) => column.name)).toEqual(expect.arrayContaining(["is_dissolved", "is_favorite"]));
    expect(first.all("PRAGMA index_list(drafts)").some((index) => index.name === "idx_drafts_favorite")).toBe(true);
    expect(first.all("PRAGMA index_list(settings)").some((index) => index.name === "idx_settings_favorite")).toBe(true);
    expect(first.all("PRAGMA index_list(organizations)").some((index) => index.name === "idx_organizations_favorite")).toBe(true);
    expect(first.all("PRAGMA table_info(work_entity_favorites)").map((column) => column.name)).toEqual(expect.arrayContaining([
      "work_id",
      "entity_type",
      "entity_id",
      "user_id",
      "is_favorite",
      "updated_at"
    ]));
    expect(first.all("PRAGMA table_info(work_entity_pins)").map((column) => column.name)).toEqual(expect.arrayContaining([
      "work_id",
      "entity_type",
      "entity_id",
      "is_pinned",
      "pinned_by_user_id",
      "updated_at"
    ]));
    expect(first.all("PRAGMA index_list(work_entity_favorites)").some((index) => index.name === "idx_work_entity_favorites_user")).toBe(true);
    expect(first.all("PRAGMA index_list(work_entity_pins)").some((index) => index.name === "idx_work_entity_pins_entity")).toBe(true);
    expect(first.all("PRAGMA table_info(user_desktop_sessions)").map((column) => column.name)).toEqual(expect.arrayContaining([
      "id",
      "user_id",
      "token_hash",
      "desktop_id",
      "profile_id",
      "client_version",
      "expires_at",
      "revoked_at"
    ]));
    expect(first.all("PRAGMA index_list(user_desktop_sessions)").map((index) => index.name)).toEqual(expect.arrayContaining([
      "idx_user_desktop_sessions_token",
      "idx_user_desktop_sessions_user",
      "idx_user_desktop_sessions_active_profile"
    ]));
    expect(first.get("SELECT offline_access_enabled FROM works WHERE id = 'work-old'")).toEqual({ offline_access_enabled: 0 });
    expect(first.all("PRAGMA table_info(sync_changes)").map((column) => column.name)).toEqual(expect.arrayContaining([
      "cursor",
      "work_id",
      "entity_type",
      "entity_id",
      "operation",
      "version_no",
      "changed_by_user_id",
      "changed_at"
    ]));
    expect(first.all("PRAGMA table_info(sync_mutation_results)").map((column) => column.name)).toEqual(expect.arrayContaining([
      "mutation_id",
      "client_id",
      "user_id",
      "work_id",
      "request_hash",
      "status",
      "result_json"
    ]));
    expect(first.all("PRAGMA index_list(sync_changes)").map((index) => index.name)).toEqual(expect.arrayContaining([
      "idx_sync_changes_work_cursor",
      "idx_sync_changes_entity"
    ]));
    expect(first.all("PRAGMA table_info(s3_backup_targets)").map((column) => column.name)).toEqual(expect.arrayContaining([
      "id",
      "endpoint",
      "bucket",
      "base_path",
      "access_key_encrypted",
      "secret_key_encrypted",
      "backup_images",
      "schedule_time",
      "retention_count",
      "sort_order"
    ]));
    expect(first.all("PRAGMA index_list(s3_backup_targets)").some((index) => index.name === "idx_s3_backup_targets_schedule")).toBe(true);
    expect(first.all("PRAGMA table_info(s3_backup_runs)").map((column) => column.name)).toEqual(expect.arrayContaining([
      "id",
      "target_id",
      "trigger",
      "status",
      "database_key",
      "images_uploaded",
      "images_skipped",
      "databases_deleted",
      "server_response_json"
    ]));
    expect(first.all("PRAGMA index_list(s3_backup_runs)").some((index) => index.name === "idx_s3_backup_runs_started")).toBe(true);
    expect(first.all("PRAGMA table_info(s3_backup_encryption)").map((column) => column.name)).toEqual([
      "id",
      "enabled",
      "kek_encrypted",
      "kek_iv",
      "kek_tag",
      "created_at",
      "updated_at"
    ]);
    expect(first.get("SELECT COUNT(*) AS count FROM s3_backup_encryption")).toEqual({ count: 0 });
    expect(first.get("SELECT is_dead FROM characters WHERE id = 'character-a'")).toEqual({ is_dead: 0 });
    expect(first.get("SELECT gender FROM characters WHERE id = 'character-a'")).toEqual({ gender: "unknown" });
    expect(() => first.run("UPDATE characters SET gender = 'invalid' WHERE id = 'character-a'")).toThrow();
    expect(first.get("SELECT is_extinct FROM races WHERE id = 'race_migration_1'")).toEqual({ is_extinct: 0 });
    expect(first.all("PRAGMA table_info(characters)").some((column) => column.name === "visibility")).toBe(false);
    expect(first.get("SELECT code FROM characters WHERE id = 'character-a'")).toEqual({ code: "" });
    expect(first.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'character_merges'")?.name).toBe("character_merges");
    expect(first.all("PRAGMA table_info(works)").some((column) => column.name === "owner_user_id")).toBe(true);
    expect(first.all("PRAGMA table_info(works)").some((column) => column.name === "version_no")).toBe(true);
    expect(first.all("PRAGMA table_info(works)").some((column) => column.name === "deleted_at")).toBe(true);
    expect(first.all("PRAGMA table_info(volumes)").some((column) => column.name === "version_no")).toBe(true);
    expect(first.all("PRAGMA table_info(volumes)").some((column) => column.name === "deleted_at")).toBe(true);
    expect(first.all("PRAGMA table_info(work_memberships)").some((column) => column.name === "permissions_json")).toBe(true);
    expect(first.all("PRAGMA table_info(chapter_versions)").some((column) => column.name === "created_by_user_id")).toBe(true);
    expect(first.all("PRAGMA table_info(chapter_versions)").some((column) => column.name === "work_id")).toBe(true);
    expect(first.all("PRAGMA table_info(chapter_versions)").some((column) => column.name === "change_note")).toBe(true);
    expect(first.all("PRAGMA table_info(audit_logs)").some((column) => column.name === "user_id")).toBe(true);
    expect(first.all("PRAGMA table_info(entity_versions)").map((column) => column.name)).toEqual(expect.arrayContaining(["entity_type", "entity_id", "version_no", "snapshot_json"]));
    expect(first.all("PRAGMA table_info(drafts)").map((column) => column.name)).toEqual(expect.arrayContaining(["work_id", "draft_type", "volume_id", "setting_module", "title", "content"]));
    expect(first.all("PRAGMA index_list(drafts)").some((index) => index.name === "idx_drafts_work")).toBe(true);
    expect(first.all("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'drafts'").map((row) => row.name)).toEqual(expect.arrayContaining(["drafts_binding_insert", "drafts_binding_update"]));
    expect(first.all("PRAGMA table_info(relationships)").some((column) => column.name === "keywords_json")).toBe(true);
    expect(first.all("PRAGMA table_info(providers)").filter((column) => ["concurrency_limit", "rpm_limit", "daily_token_quota", "monthly_token_quota", "max_tokens"].includes(String(column.name)))).toHaveLength(5);
    expect(first.all("PRAGMA table_info(providers)").some((column) => column.name === "protocol" && column.dflt_value === "'openai-chat-completions'")).toBe(true);
    expect(first.all("PRAGMA table_info(providers)").some((column) => column.name === "thinking_type" && column.dflt_value === "'enabled'")).toBe(true);
    expect(first.all("PRAGMA table_info(providers)").some((column) => column.name === "analysis_timeout_seconds" && column.dflt_value === "300")).toBe(true);
    expect(first.all("PRAGMA table_info(ai_connectivity_test_states)").map((column) => column.name)).toEqual([
      "object_type",
      "object_id",
      "config_fingerprint",
      "state",
      "attempt_id",
      "retry_at_ms",
      "updated_at"
    ]);
    expect(first.all("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN ('providers', 'models')").map((row) => row.name))
      .toEqual(expect.arrayContaining([
        "ai_connectivity_test_states_provider_delete",
        "ai_connectivity_test_states_model_delete"
      ]));
    expect(first.all("PRAGMA table_info(chapters)").some((column) => column.name === "chapter_type")).toBe(true);
    expect(first.all("PRAGMA table_info(chapters)").some((column) => column.name === "deleted_at")).toBe(true);
    expect(first.all("PRAGMA table_info(chapters)").some((column) => column.name === "deleted_via_volume_id")).toBe(true);
    expect(first.all("PRAGMA index_list(works)").some((index) => index.name === "idx_works_recycle_bin")).toBe(true);
    expect(first.all("PRAGMA index_list(volumes)").map((index) => index.name)).toEqual(expect.arrayContaining([
      "idx_volumes_active_work",
      "idx_volumes_recycle_bin"
    ]));
    expect(first.all("PRAGMA index_list(chapters)").some((index) => index.name === "idx_chapters_deleted_via_volume")).toBe(true);
    expect(first.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chapter_annotations'")?.name).toBe("chapter_annotations");
    expect(first.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chapter_annotation_versions'")?.name).toBe("chapter_annotation_versions");
    expect(first.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'writing_goals'")?.name).toBe("writing_goals");
    expect(first.get("SELECT title, chapter_type FROM chapters WHERE id = 'chapter-old'")).toEqual({ title: "第一章", chapter_type: "正文" });
    expect(first.all("SELECT name, species FROM characters ORDER BY name")).toEqual([
      { name: "拉顿", species: "" },
      { name: "魔斯拉", species: "泰坦族" }
    ]);
    expect(first.all("SELECT name, description FROM races")).toEqual([{ name: "泰坦族", description: "由旧人物种族字段迁移生成" }]);
    expect(first.get("SELECT parent_race_id FROM races WHERE id = 'race_migration_1'")?.parent_race_id).toBeNull();
    expect(first.all("PRAGMA index_list(races)").some((index) => index.name === "idx_races_parent")).toBe(true);
    expect(first.all("PRAGMA table_info(races)").some((column) => column.name === "settings_sections_json")).toBe(true);
    expect(first.all("PRAGMA table_info(organizations)").some((column) => column.name === "settings_sections_json")).toBe(true);
    expect(first.all("PRAGMA index_list(analysis_tasks)").some((index) => index.name === "idx_tasks_work_created")).toBe(true);
    expect(first.all("PRAGMA table_info(analysis_tasks)").some((column) => column.name === "model_id")).toBe(true);
    expect(first.all("PRAGMA index_list(analysis_tasks)").some((index) => index.name === "idx_tasks_model")).toBe(true);
    expect(first.all("PRAGMA table_info(ai_calls)").some((column) => column.name === "task_id")).toBe(true);
    expect(first.all("PRAGMA table_info(ai_calls)").map((column) => column.name)).toEqual(expect.arrayContaining([
      "input_tokens",
      "output_tokens",
      "cached_input_tokens",
      "cache_write_input_tokens",
      "cache_eligible_input_tokens",
      "cache_usage_available",
      "token_usage_source"
    ]));
    expect(first.all("PRAGMA table_info(work_ai_settings)").some((column) => column.name === "daily_token_quota")).toBe(true);
    expect(first.all("PRAGMA table_info(work_ai_settings)").some((column) => column.name === "monthly_token_quota")).toBe(true);
    expect(first.all("PRAGMA table_info(ai_call_traces)").map((column) => column.name)).toEqual(
      expect.arrayContaining(["call_id", "task_id", "initial_messages_json", "rounds_json", "source_refs_json", "created_at", "updated_at"])
    );
    expect(first.all("PRAGMA index_list(ai_calls)").some((index) => index.name === "idx_calls_task")).toBe(true);
    expect(first.all("PRAGMA index_list(ai_call_traces)").some((index) => index.name === "idx_ai_call_traces_task")).toBe(true);
    expect(first.get("SELECT race_id FROM characters WHERE id = 'character-a'")?.race_id).toBe("race_migration_1");
    expect(first.get("SELECT race_id FROM characters WHERE id = 'character-b'")?.race_id).toBeNull();
    expect(first.all("SELECT character_id, version_no, source, change_note FROM character_versions ORDER BY character_id")).toEqual([
      { character_id: "character-a", version_no: 1, source: "migration", change_note: "建立人物版本基线" },
      { character_id: "character-b", version_no: 1, source: "migration", change_note: "建立人物版本基线" }
    ]);
    const migratedSnapshot = JSON.parse(String(first.get("SELECT snapshot_json FROM character_versions WHERE character_id = 'character-a'")?.snapshot_json));
    expect(migratedSnapshot).toMatchObject({ name: "魔斯拉", gender: "unknown", raceId: "race_migration_1", species: "泰坦族", organizationIds: [] });
    expect(first.get("SELECT COUNT(*) AS count FROM organizations")?.count).toBe(0);
    expect(first.get("SELECT COUNT(*) AS count FROM timeline_tracks")?.count).toBe(0);
    expect(first.all("PRAGMA table_info(timeline_events)").some((column) => column.name === "track_id")).toBe(true);
    expect(first.all("PRAGMA table_info(volumes)").filter((column) => ["description", "keywords_json"].includes(String(column.name)))).toHaveLength(2);
    expect(first.get("SELECT description, keywords_json FROM volumes WHERE id = 'volume-old'")).toEqual({ description: "", keywords_json: "[]" });
    expect(first.all("PRAGMA table_info(works)").some((column) => column.name === "is_internal")).toBe(true);
    expect(first.all("PRAGMA table_info(models)").some((column) => column.name === "context_window")).toBe(true);
    expect(first.all("PRAGMA table_info(models)").some((column) => column.name === "thinking_enabled" && column.dflt_value === "1")).toBe(true);
    expect(first.all("PRAGMA table_info(models)").some((column) => column.name === "thinking_effort" && column.dflt_value === "'default'")).toBe(true);
    expect(first.all("PRAGMA table_info(providers)").some((column) => column.name === "max_tokens_parameter" && column.dflt_value === "'max_tokens'")).toBe(true);
    expect(first.all("PRAGMA table_info(ai_conversation_messages)").some((column) => column.name === "metadata_json")).toBe(true);
    expect(first.all("PRAGMA table_info(ai_conversation_messages)").some((column) => column.name === "request_id")).toBe(true);
    expect(first.all("PRAGMA index_list(ai_conversation_messages)").some((index) => index.name === "idx_ai_conversation_messages_request")).toBe(true);
    expect(first.all("PRAGMA table_info(ai_history_search)").map((column) => column.name)).toEqual(expect.arrayContaining([
      "work_id",
      "conversation_id",
      "message_id",
      "source_type",
      "source_id",
      "search_content"
    ]));
    expect(first.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ai_history_search_fts'")?.name).toBe("ai_history_search_fts");
    expect(first.all("PRAGMA index_list(ai_history_search)").some((index) => index.name === "idx_ai_history_search_work")).toBe(true);
    expect(first.all("PRAGMA index_list(ai_history_search_short_terms)").some(
      (index) => index.name === "idx_ai_history_search_short_terms_search"
    )).toBe(true);
    expect(first.get("SELECT is_internal FROM works WHERE id = '__scriverse_platform_ai__'")).toEqual({ is_internal: 1 });
    expect(first.get("SELECT system_prompt FROM platform_ai_settings WHERE id = 1")).toEqual({ system_prompt: "" });
    expect(first.get("SELECT stream_idle_timeout_seconds FROM platform_ai_settings WHERE id = 1")).toEqual({ stream_idle_timeout_seconds: 90 });
    expect(first.all("PRAGMA table_info(platform_ai_settings)").some((column) => column.name === "stream_idle_timeout_seconds" && column.dflt_value === "90")).toBe(true);
    expect(String(first.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'platform_ai_settings'")?.sql)).toContain("BETWEEN 30 AND 600");
    expect(first.get("SELECT toast_position, page_sizes_json, galaxy_frame_rate FROM platform_ui_settings WHERE id = 1")).toEqual({
      toast_position: "top-right",
      page_sizes_json: '{"characters":30,"analysisTasks":30,"fileVersions":30}',
      galaxy_frame_rate: 30
    });
    expect(first.all("PRAGMA table_info(platform_ui_settings)").map((column) => column.name)).toEqual(expect.arrayContaining([
      "page_sizes_json",
      "galaxy_frame_rate"
    ]));
    expect(first.all("PRAGMA table_info(presence_entries)").map((column) => column.name)).toEqual(expect.arrayContaining([
      "work_id",
      "client_id",
      "page_kind",
      "last_seen_at"
    ]));
    expect(first.all("PRAGMA index_list(presence_entries)").map((index) => index.name)).toEqual(expect.arrayContaining([
      "idx_presence_entries_work",
      "idx_presence_entries_last_seen"
    ]));
    expect(first.all("PRAGMA table_info(presence_changes)").map((column) => column.name)).toEqual(expect.arrayContaining([
      "id",
      "work_id",
      "page_key",
      "action",
      "page_deleted",
      "recipient_client_ids_json"
    ]));
    expect(first.all("PRAGMA index_list(presence_changes)").map((index) => index.name)).toEqual(expect.arrayContaining([
      "idx_presence_changes_work",
      "idx_presence_changes_saved_at"
    ]));
    expect(first.get("SELECT chapter_id, content FROM chapter_paragraph_search WHERE chapter_id = 'chapter-old'")).toEqual({ chapter_id: "chapter-old", content: "旧正文" });
    expect(first.get(
      `SELECT line_range.chapter_version, line_range.start_line, line_range.end_line
       FROM chapter_paragraph_line_ranges line_range
       JOIN chapter_paragraph_search paragraph ON paragraph.id = line_range.paragraph_id
       WHERE paragraph.chapter_id = 'chapter-old'`
    )).toEqual({ chapter_version: 1, start_line: 1, end_line: 1 });
    expect(first.all("PRAGMA index_list(chapter_paragraph_short_terms)").some(
      (index) => index.name === "idx_chapter_paragraph_short_terms_paragraph"
    )).toBe(true);
    expect(first.all("EXPLAIN QUERY PLAN DELETE FROM chapter_paragraph_short_terms WHERE paragraph_id = 1").some(
      (step) => String(step.detail).includes("idx_chapter_paragraph_short_terms_paragraph")
    )).toBe(true);
    expect(first.get(`SELECT paragraph.rowid AS id FROM chapter_paragraph_search_fts paragraph
      WHERE chapter_paragraph_search_fts MATCH '"旧正文"'`)).toEqual({ id: 1 });
    expect(first.all("PRAGMA table_info(work_ai_settings)").map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "auto_run_enabled",
        "auto_run_concurrency",
        "auto_run_batch_limit",
        "auto_run_daily_task_limit",
        "auto_run_failure_threshold",
        "auto_run_stability_delay_minutes",
        "auto_run_paused",
        "auto_run_pause_reason",
        "auto_run_resume_at",
        "auto_run_consecutive_failures",
        "book_summary_context_percent",
        "context_compact_threshold",
        "agent_tool_call_limit",
        "agent_tool_call_global_multiplier",
        "agent_tools_json",
        "always_include_setting_info",
        "title_generation_model_id"
      ])
    );
    const workAiSettingsSql = String(first.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'work_ai_settings'")?.sql ?? "");
    expect(workAiSettingsSql).toContain("agent_tool_call_limit INTEGER NOT NULL DEFAULT 12 CHECK(agent_tool_call_limit BETWEEN 5 AND 1000)");
    first.run(
      "INSERT INTO work_ai_settings (work_id, agent_tool_call_limit, updated_at) VALUES (?, ?, ?)",
      "work-old",
      80,
      "2025-01-01"
    );
    expect(first.get("SELECT agent_tool_call_limit FROM work_ai_settings WHERE work_id = 'work-old'")).toEqual({ agent_tool_call_limit: 80 });
    expect(first.all("PRAGMA table_info(analysis_tasks)").map((column) => column.name)).toEqual(
      expect.arrayContaining(["attempt_count", "next_attempt_at", "last_attempt_at"])
    );
    expect(first.all("PRAGMA table_info(ai_conversations)").map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "compacted_summary",
        "compacted_message_count",
        "context_warning_at",
        "agent_tools_json",
        "injected_entities_json",
        "system_clock_text",
        "roleplay_character_id",
        "roleplay_user_character_id",
        "task_type",
        "context_scope_json",
        "is_favorite",
        "scene_pin_json"
      ])
    );
    expect(first.all("PRAGMA index_list(ai_conversations)").some((index) => index.name === "idx_ai_conversations_roleplay_character")).toBe(true);
    expect(first.all("PRAGMA index_list(ai_conversations)").some((index) => index.name === "idx_ai_conversations_roleplay_user_character")).toBe(true);
    expect(first.all("PRAGMA index_list(ai_conversations)").some((index) => index.name === "idx_ai_conversations_favorite")).toBe(true);
    expect(first.all("PRAGMA table_info(user_api_keys)").map((column) => column.name)).toEqual(
      expect.arrayContaining(["user_id", "key_hash", "key_prefix", "created_at", "rotated_at", "last_used_at"])
    );
    expect(first.all("PRAGMA table_info(users)").map((column) => column.name)).toEqual(expect.arrayContaining(["avatar_updated_at", "avatar_sha256", "onboarding_completed_at"]));
    expect(first.all("PRAGMA table_info(login_attempts)").map((column) => column.name)).toEqual(
      expect.arrayContaining(["normalized_username", "failure_timestamps_json", "locked_until", "updated_at"])
    );
    expect(first.all("PRAGMA index_list(login_attempts)").some((index) => index.name === "idx_login_attempts_updated")).toBe(true);
    expect(first.all("PRAGMA table_info(user_avatars)").map((column) => column.name)).toEqual(
      expect.arrayContaining(["user_id", "mime_type", "content", "byte_length", "sha256", "width", "height", "updated_at"])
    );
    expect(first.get("SELECT character_id, section_type, title, content_markdown FROM character_profile_sections")).toEqual({
      character_id: "character-a",
      section_type: "custom",
      title: "背景故事",
      content_markdown: "## 远古时期\n\n守护地球生态。"
    });
    first.run(
      `INSERT INTO ai_calls (id, work_id, task_type, provider_id, model_id, context_scope_json, status, created_at)
       VALUES ('call-running', 'work-old', 'book-analysis', 'provider-old', 'model-old', '{}', 'running', '2025-01-01')`
    );
    first.run(
      `INSERT INTO analysis_tasks (id, work_id, task_type, status, created_at, updated_at)
       VALUES ('task-running', 'work-old', 'book-analysis', 'running', '2025-01-01', '2025-01-01')`
    );
    first.run(
      `INSERT INTO ai_conversations (id, work_id, roleplay_character_id, task_type, context_scope_json, title, created_at, updated_at)
       VALUES ('conversation-chat-old', 'work-old', NULL, NULL, NULL, '旧问答', '2025-01-01', '2025-01-01'),
              ('conversation-roleplay-old', 'work-old', 'character-a', NULL, NULL, '旧角色扮演', '2025-01-01', '2025-01-01')`
    );
    first.run("DELETE FROM schema_migrations WHERE version = 68");
    first.run("DELETE FROM schema_migrations WHERE version = 69");
    first.run("DELETE FROM schema_migrations WHERE version = 70");
    first.close();

    const second = new Database(filename);
    expect(second.get("SELECT COUNT(*) AS count FROM character_names")?.count).toBe(4);
    expect(second.get("SELECT title FROM works WHERE id = 'work-old'")?.title).toBe("旧作品");
    expect(second.get("SELECT COUNT(*) AS count FROM races")?.count).toBe(1);
    expect(second.get("SELECT status FROM ai_calls WHERE id = 'call-running'")?.status).toBe("failed");
    expect(second.get("SELECT status FROM analysis_tasks WHERE id = 'task-running'")?.status).toBe("partial");
    expect(second.all("SELECT id, task_type, context_scope_json FROM ai_conversations ORDER BY id")).toEqual([
      { id: "conversation-chat-old", task_type: "chat", context_scope_json: '{"type":"none"}' },
      { id: "conversation-roleplay-old", task_type: "roleplay", context_scope_json: '{"type":"none"}' }
    ]);
    second.close();
  });

  it("迁移 101 放宽平台 AI 流超时上限并保留已有设置", () => {
    const filename = createLegacyDatabase();
    const current = new Database(filename);
    current.run("ALTER TABLE platform_ai_settings RENAME TO platform_ai_settings_v101_test_old");
    current.run(`CREATE TABLE platform_ai_settings (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      system_prompt TEXT NOT NULL DEFAULT '',
      image_tool_model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
      stream_idle_timeout_seconds INTEGER NOT NULL DEFAULT 90 CHECK(stream_idle_timeout_seconds BETWEEN 30 AND 120),
      updated_at TEXT NOT NULL
    )`);
    current.run(`INSERT INTO platform_ai_settings (id, system_prompt, image_tool_model_id, stream_idle_timeout_seconds, updated_at)
      SELECT id, system_prompt, image_tool_model_id, stream_idle_timeout_seconds, updated_at
      FROM platform_ai_settings_v101_test_old`);
    current.run("DROP TABLE platform_ai_settings_v101_test_old");
    current.run("UPDATE platform_ai_settings SET stream_idle_timeout_seconds = 120 WHERE id = 1");
    current.run("DELETE FROM schema_migrations WHERE version = 101");
    current.close();

    const migrated = new Database(filename);
    expect(migrated.get("SELECT stream_idle_timeout_seconds FROM platform_ai_settings WHERE id = 1")).toEqual({ stream_idle_timeout_seconds: 120 });
    expect(String(migrated.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'platform_ai_settings'")?.sql)).toContain("BETWEEN 30 AND 600");
    expect(() => migrated.run("UPDATE platform_ai_settings SET stream_idle_timeout_seconds = 600 WHERE id = 1")).not.toThrow();
    expect(migrated.get("SELECT stream_idle_timeout_seconds FROM platform_ai_settings WHERE id = 1")).toEqual({ stream_idle_timeout_seconds: 600 });
    expect(migrated.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(migrated.all("PRAGMA foreign_key_check")).toEqual([]);
    migrated.close();
  });

  it("从已有迁移 74 平滑升级到当前版本并重建 AI 历史短词索引", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-74-upgrade-"));
    roots.push(root);
    const filename = join(root, "migration-74.db");
    const current = new Database(filename);
    current.close();

    const legacy = new DatabaseSync(filename);
    legacy.exec("PRAGMA foreign_keys = OFF");
    legacy.exec(`
      DELETE FROM ai_history_search_short_terms;
      DELETE FROM ai_history_search;
      INSERT INTO works (id, title, created_at, updated_at, owner_user_id)
      VALUES ('work-migration-74', '迁移作品', '2025-01-01', '2025-01-01', '${SYSTEM_USER_ID}');
      INSERT INTO ai_conversations (id, work_id, title, compacted_summary, created_at, updated_at)
      VALUES ('conversation-migration-74', 'work-migration-74', '旧对话', '重复重复', '2025-01-01', '2025-01-01');
      DROP TABLE s3_backup_runs;
      DROP TABLE s3_backup_targets;
      DELETE FROM schema_migrations WHERE version IN (75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85);
    `);
    const searchRow = legacy.prepare(
      "SELECT id FROM ai_history_search WHERE source_type = 'conversation' AND source_id = 'conversation-migration-74'"
    ).get() as { id?: unknown } | undefined;
    const searchId = Number(searchRow?.id);
    legacy.prepare(
      "INSERT INTO ai_history_search_short_terms (search_id, term) VALUES (?, ?), (?, ?)"
    ).run(searchId, "重", searchId, "复");
    legacy.close();

    const migrated = new Database(filename);
    new Store(migrated);
    expect(migrated.get("SELECT MAX(version) AS version FROM schema_migrations")?.version).toBe(DATABASE_SCHEMA_VERSION);
    expect(migrated.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 's3_backup_runs'")?.name).toBe("s3_backup_runs");
    expect(migrated.all(
      "SELECT term, COUNT(*) AS count FROM ai_history_search_short_terms WHERE search_id = ? GROUP BY term HAVING COUNT(*) > 1",
      searchId
    )).toEqual([]);
    expect(migrated.all<{ term: string }>(
      "SELECT term FROM ai_history_search_short_terms WHERE search_id = ?",
      searchId
    )).toEqual(expect.arrayContaining([{ term: "重" }, { term: "复" }]));
    expect(migrated.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(migrated.all("PRAGMA foreign_key_check")).toEqual([]);
    migrated.close();
  });

  it("从迁移 77 保留银河图帧率并扩展到高刷新率档位", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-77-upgrade-"));
    roots.push(root);
    const filename = join(root, "migration-77.db");
    const current = new Database(filename);
    current.close();

    const legacy = new DatabaseSync(filename);
    legacy.exec(`
      DROP TABLE platform_ui_settings;
      CREATE TABLE platform_ui_settings (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        toast_position TEXT NOT NULL DEFAULT 'bottom-right' CHECK(toast_position IN ('bottom-right', 'top-right')),
        page_sizes_json TEXT NOT NULL DEFAULT '{"characters":30,"analysisTasks":30,"fileVersions":30}' CHECK(json_valid(page_sizes_json) AND json_type(page_sizes_json) = 'object'),
        galaxy_frame_rate INTEGER NOT NULL DEFAULT 30 CHECK(galaxy_frame_rate IN (24, 30, 60)),
        updated_at TEXT NOT NULL
      );
      INSERT INTO platform_ui_settings (id, toast_position, page_sizes_json, galaxy_frame_rate, updated_at)
      VALUES (1, 'top-right', '{"characters":25}', 60, '2026-08-09T00:00:00.000Z');
      DELETE FROM schema_migrations WHERE version IN (78, 79, 80, 81, 82, 83, 84, 85);
    `);
    legacy.close();

    const migrated = new Database(filename);
    expect(migrated.get("SELECT toast_position, page_sizes_json, galaxy_frame_rate, updated_at FROM platform_ui_settings WHERE id = 1")).toEqual({
      toast_position: "top-right",
      page_sizes_json: '{"characters":25}',
      galaxy_frame_rate: 60,
      updated_at: "2026-08-09T00:00:00.000Z"
    });
    expect(() => migrated.run("UPDATE platform_ui_settings SET galaxy_frame_rate = 120 WHERE id = 1")).not.toThrow();
    expect(migrated.get("SELECT galaxy_frame_rate FROM platform_ui_settings WHERE id = 1")).toEqual({ galaxy_frame_rate: 120 });
    expect(migrated.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(migrated.all("PRAGMA foreign_key_check")).toEqual([]);
    migrated.close();
  });

  it("从迁移 78 保留现有银河图帧率并扩展到最终高刷新率档位", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-78-upgrade-"));
    roots.push(root);
    const filename = join(root, "migration-78.db");
    const current = new Database(filename);
    current.close();

    const legacy = new DatabaseSync(filename);
    legacy.exec(`
      DROP TABLE platform_ui_settings;
      CREATE TABLE platform_ui_settings (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        toast_position TEXT NOT NULL DEFAULT 'bottom-right' CHECK(toast_position IN ('bottom-right', 'top-right')),
        page_sizes_json TEXT NOT NULL DEFAULT '{"characters":30,"analysisTasks":30,"fileVersions":30}' CHECK(json_valid(page_sizes_json) AND json_type(page_sizes_json) = 'object'),
        galaxy_frame_rate INTEGER NOT NULL DEFAULT 30 CHECK(galaxy_frame_rate IN (24, 30, 60, 90, 120)),
        updated_at TEXT NOT NULL
      );
      INSERT INTO platform_ui_settings (id, toast_position, page_sizes_json, galaxy_frame_rate, updated_at)
      VALUES (1, 'top-right', '{"characters":25}', 120, '2026-08-09T00:00:00.000Z');
      DELETE FROM schema_migrations WHERE version IN (79, 80, 81, 82, 83, 84, 85);
    `);
    legacy.close();

    const migrated = new Database(filename);
    expect(migrated.get("SELECT toast_position, page_sizes_json, galaxy_frame_rate, updated_at FROM platform_ui_settings WHERE id = 1")).toEqual({
      toast_position: "top-right",
      page_sizes_json: '{"characters":25}',
      galaxy_frame_rate: 120,
      updated_at: "2026-08-09T00:00:00.000Z"
    });
    expect(() => migrated.run("UPDATE platform_ui_settings SET galaxy_frame_rate = 240 WHERE id = 1")).not.toThrow();
    expect(migrated.get("SELECT galaxy_frame_rate FROM platform_ui_settings WHERE id = 1")).toEqual({ galaxy_frame_rate: 240 });
    expect(migrated.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(migrated.all("PRAGMA foreign_key_check")).toEqual([]);
    migrated.close();
  });

  it("迁移 80 为既有库补建审计列表索引并保留日志", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-audit-index-existing-"));
    roots.push(root);
    const filename = join(root, "audit-index-existing.db");
    const current = new Database(filename);
    const timestamp = "2026-08-10T00:00:00.000Z";
    insertSystemOwnedWork(current, "work-audit-index", "审计索引迁移", timestamp);
    current.run(
      `INSERT INTO audit_logs (id, work_id, action, entity_type, actor, detail_json, created_at)
       VALUES ('audit-before-index', 'work-audit-index', 'work.updated', 'work', 'owner', '{}', ?)`,
      timestamp
    );
    current.run("DROP INDEX idx_audit_logs_work_created");
    current.run("DELETE FROM schema_migrations WHERE version = 80");
    current.close();

    const migrated = new Database(filename);
    expect(migrated.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 80")).toEqual({ count: 1 });
    expect(migrated.all("PRAGMA index_xinfo('idx_audit_logs_work_created')")
      .filter((column) => column.key === 1)
      .map((column) => ({ name: column.name, desc: column.desc }))).toEqual([
      { name: "work_id", desc: 0 },
      { name: "created_at", desc: 1 }
    ]);
    expect(migrated.get("SELECT id FROM audit_logs WHERE id = 'audit-before-index'")).toEqual({ id: "audit-before-index" });
    expect(migrated.all(
      `EXPLAIN QUERY PLAN SELECT log.*, user.display_name AS actor_display_name, user.username AS actor_username
       FROM audit_logs log LEFT JOIN users user ON user.id = log.user_id
       WHERE log.work_id = ? ORDER BY log.created_at DESC LIMIT 200`,
      "work-audit-index"
    ).some((step) => String(step.detail).includes("USING INDEX idx_audit_logs_work_created"))).toBe(true);
    expect(migrated.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(migrated.all("PRAGMA foreign_key_check")).toEqual([]);
    migrated.close();
  });

  it("迁移 80 在全新库预建索引后可幂等登记并重启", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-audit-index-fresh-"));
    roots.push(root);
    const filename = join(root, "audit-index-fresh.db");

    const first = new Database(filename);
    expect(first.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 80")).toEqual({ count: 1 });
    expect(first.all("PRAGMA index_list(audit_logs)").filter((index) => index.name === "idx_audit_logs_work_created")).toHaveLength(1);
    first.close();

    const restarted = new Database(filename);
    expect(restarted.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 80")).toEqual({ count: 1 });
    expect(restarted.all("PRAGMA index_list(audit_logs)").filter((index) => index.name === "idx_audit_logs_work_created")).toHaveLength(1);
    expect(restarted.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(restarted.all("PRAGMA foreign_key_check")).toEqual([]);
    restarted.close();
  });

  it("迁移 81 为既有库补建列表索引并保留领域数据", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-list-index-existing-"));
    roots.push(root);
    const filename = join(root, "list-index-existing.db");
    const current = new Database(filename);
    const timestamp = "2026-08-10T00:00:00.000Z";
    insertSystemOwnedWork(current, "work-list-index", "列表索引迁移", timestamp);
    current.run(
      `INSERT INTO volumes (id, work_id, title, sort_order, created_at, updated_at)
       VALUES ('volume-list-index', 'work-list-index', '第一卷', 0, ?, ?)`,
      timestamp,
      timestamp
    );
    current.run(
      `INSERT INTO chapters (id, work_id, volume_id, title, sort_order, created_at, updated_at)
       VALUES ('chapter-list-index', 'work-list-index', 'volume-list-index', '第一章', 0, ?, ?)`,
      timestamp,
      timestamp
    );
    current.run(
      `INSERT INTO ai_calls (id, work_id, task_type, provider_id, model_id, context_scope_json, status, created_at)
       VALUES ('call-list-index', 'work-list-index', 'chat', 'provider-list-index', 'model-list-index', '{}', 'succeeded', ?)`,
      timestamp
    );
    current.run(
      `INSERT INTO ai_suggestions (id, call_id, work_id, chapter_id, chapter_version, task_type, instruction, content, status, created_at)
       VALUES ('suggestion-before-index', 'call-list-index', 'work-list-index', 'chapter-list-index', 1, 'chat', '迁移', '保留建议', 'pending', ?)`,
      timestamp
    );
    current.run(
      `INSERT INTO file_versions (id, work_id, file_name, file_type, word_count, paragraph_count, snapshot_json, created_at)
       VALUES ('file-version-before-index', 'work-list-index', 'before.txt', 'txt', 4, 1, '{}', ?)`,
      timestamp
    );
    current.run(
      `INSERT INTO chapter_insights (id, chapter_id, chapter_version, summary, created_at)
       VALUES ('insight-before-index', 'chapter-list-index', 1, '保留洞察', ?)`,
      timestamp
    );
    current.run("DROP INDEX idx_ai_suggestions_work");
    current.run("DROP INDEX idx_file_versions_work");
    current.run("DROP INDEX idx_chapter_insights_chapter");
    current.run("DELETE FROM schema_migrations WHERE version = 81");
    current.close();

    const migrated = new Database(filename);
    expect(migrated.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 81")).toEqual({ count: 1 });
    expect(migrated.all("PRAGMA index_xinfo('idx_ai_suggestions_work')")
      .filter((column) => column.key === 1)
      .map((column) => ({ name: column.name, desc: column.desc }))).toEqual([
      { name: "work_id", desc: 0 },
      { name: "status", desc: 0 },
      { name: "created_at", desc: 1 }
    ]);
    expect(migrated.all("PRAGMA index_xinfo('idx_file_versions_work')")
      .filter((column) => column.key === 1)
      .map((column) => ({ name: column.name, desc: column.desc }))).toEqual([
      { name: "work_id", desc: 0 },
      { name: "created_at", desc: 1 },
      { name: "id", desc: 1 }
    ]);
    expect(migrated.all("PRAGMA index_xinfo('idx_chapter_insights_chapter')")
      .filter((column) => column.key === 1)
      .map((column) => ({ name: column.name, desc: column.desc }))).toEqual([
      { name: "chapter_id", desc: 0 },
      { name: "chapter_version", desc: 1 },
      { name: "created_at", desc: 1 }
    ]);
    expect(migrated.get("SELECT id FROM ai_suggestions WHERE id = 'suggestion-before-index'")).toEqual({ id: "suggestion-before-index" });
    expect(migrated.get("SELECT id FROM file_versions WHERE id = 'file-version-before-index'")).toEqual({ id: "file-version-before-index" });
    expect(migrated.get("SELECT id FROM chapter_insights WHERE id = 'insight-before-index'")).toEqual({ id: "insight-before-index" });
    expect(migrated.all(
      "EXPLAIN QUERY PLAN SELECT * FROM ai_suggestions WHERE work_id = ? AND status = ? ORDER BY created_at DESC",
      "work-list-index",
      "pending"
    ).some((step) => String(step.detail).includes("USING INDEX idx_ai_suggestions_work"))).toBe(true);
    expect(migrated.all(
      "EXPLAIN QUERY PLAN SELECT * FROM file_versions WHERE work_id = ? ORDER BY created_at DESC, id DESC",
      "work-list-index"
    ).some((step) => String(step.detail).includes("USING INDEX idx_file_versions_work"))).toBe(true);
    expect(migrated.all(
      "EXPLAIN QUERY PLAN SELECT * FROM chapter_insights WHERE chapter_id = ? ORDER BY chapter_version DESC, created_at DESC",
      "chapter-list-index"
    ).some((step) => String(step.detail).includes("USING INDEX idx_chapter_insights_chapter"))).toBe(true);
    expect(migrated.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(migrated.all("PRAGMA foreign_key_check")).toEqual([]);
    migrated.close();
  });

  it("迁移 81 在全新库预建三个列表索引后可幂等登记并重启", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-list-index-fresh-"));
    roots.push(root);
    const filename = join(root, "list-index-fresh.db");

    const first = new Database(filename);
    expect(first.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 81")).toEqual({ count: 1 });
    expect(first.all("PRAGMA index_list(ai_suggestions)").filter((index) => index.name === "idx_ai_suggestions_work")).toHaveLength(1);
    expect(first.all("PRAGMA index_list(file_versions)").filter((index) => index.name === "idx_file_versions_work")).toHaveLength(1);
    expect(first.all("PRAGMA index_list(chapter_insights)").filter((index) => index.name === "idx_chapter_insights_chapter")).toHaveLength(1);
    first.close();

    const restarted = new Database(filename);
    expect(restarted.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 81")).toEqual({ count: 1 });
    expect(restarted.all("PRAGMA index_list(ai_suggestions)").filter((index) => index.name === "idx_ai_suggestions_work")).toHaveLength(1);
    expect(restarted.all("PRAGMA index_list(file_versions)").filter((index) => index.name === "idx_file_versions_work")).toHaveLength(1);
    expect(restarted.all("PRAGMA index_list(chapter_insights)").filter((index) => index.name === "idx_chapter_insights_chapter")).toHaveLength(1);
    expect(restarted.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(restarted.all("PRAGMA foreign_key_check")).toEqual([]);
    restarted.close();
  });

  it("迁移 81 的外键检查失败时不登记版本并连续阻断启动", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-list-index-invalid-"));
    roots.push(root);
    const filename = join(root, "list-index-invalid.db");
    const current = new Database(filename);
    current.run("DROP INDEX idx_ai_suggestions_work");
    current.run("DROP INDEX idx_file_versions_work");
    current.run("DROP INDEX idx_chapter_insights_chapter");
    current.run("DELETE FROM schema_migrations WHERE version = 81");
    current.close();

    const invalid = new DatabaseSync(filename);
    invalid.exec("PRAGMA foreign_keys = OFF");
    invalid.prepare(
      `INSERT INTO file_versions (id, work_id, file_name, file_type, word_count, paragraph_count, snapshot_json, created_at)
       VALUES ('file-version-invalid-work', 'work-missing', 'invalid.txt', 'txt', 0, 0, '{}', '2026-08-10T00:00:00.000Z')`
    ).run();
    invalid.close();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(() => new Database(filename)).toThrow("数据库外键检查失败：发现 1 条异常记录");
      const inspected = new DatabaseSync(filename);
      expect(inspected.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 81").get()?.count).toBe(0);
      expect(inspected.prepare("PRAGMA foreign_key_check").all()).toHaveLength(1);
      inspected.close();
    }
  });

  it("迁移 83 为既有 v82 数据库创建协作状态表并原子登记", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-presence-existing-"));
    roots.push(root);
    const filename = join(root, "presence-existing.db");
    const current = new Database(filename);
    new Store(current);
    current.close();

    const legacy = new DatabaseSync(filename);
    legacy.exec(`
      DROP TABLE s3_backup_encryption;
      DROP TABLE presence_changes;
      DROP TABLE presence_entries;
      DELETE FROM schema_migrations WHERE version IN (83, 84, 85);
    `);
    legacy.close();

    const migrated = new Database(filename);
    expect(migrated.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 83")).toEqual({ count: 1 });
    expect(migrated.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 84")).toEqual({ count: 1 });
    expect(migrated.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 85")).toEqual({ count: 1 });
    expect(migrated.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'presence_entries'")).toEqual({ name: "presence_entries" });
    expect(migrated.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'presence_changes'")).toEqual({ name: "presence_changes" });
    expect(migrated.all("PRAGMA index_list(presence_entries)").map((index) => index.name)).toEqual(expect.arrayContaining([
      "idx_presence_entries_work",
      "idx_presence_entries_last_seen"
    ]));
    expect(migrated.all("PRAGMA index_list(presence_changes)").map((index) => index.name)).toEqual(expect.arrayContaining([
      "idx_presence_changes_work",
      "idx_presence_changes_saved_at"
    ]));
    expect(migrated.all("PRAGMA table_info(presence_changes)").map((column) => column.name)).toEqual(expect.arrayContaining([
      "action",
      "page_deleted"
    ]));
    expect(migrated.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(migrated.all("PRAGMA foreign_key_check")).toEqual([]);
    migrated.close();
  });

  it("迁移 83 的外键检查失败时回滚建表与迁移记录", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-presence-invalid-"));
    roots.push(root);
    const filename = join(root, "presence-invalid.db");
    const current = new Database(filename);
    new Store(current);
    current.close();

    const invalid = new DatabaseSync(filename);
    invalid.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE s3_backup_encryption;
      DROP TABLE presence_changes;
      DROP TABLE presence_entries;
      DELETE FROM schema_migrations WHERE version IN (83, 84, 85);
      INSERT INTO file_versions (id, work_id, file_name, file_type, word_count, paragraph_count, snapshot_json, created_at)
      VALUES ('presence-migration-invalid-work', 'work-missing', 'invalid.txt', 'txt', 0, 0, '{}', '2026-08-10T00:00:00.000Z');
    `);
    invalid.close();

    expect(() => new Database(filename)).toThrow("数据库外键检查失败：发现 1 条异常记录");
    const inspected = new DatabaseSync(filename);
    expect(inspected.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 83").get()?.count).toBe(0);
    expect(inspected.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 84").get()?.count).toBe(0);
    expect(inspected.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 85").get()?.count).toBe(0);
    expect(inspected.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('presence_entries', 'presence_changes')").get()?.count).toBe(0);
    expect(inspected.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 's3_backup_encryption'").get()?.count).toBe(0);
    expect(inspected.prepare("PRAGMA foreign_key_check").all()).toHaveLength(1);
    inspected.close();
  });

  it("迁移 84 新增备份加密单行表并兼容早期开发数据库", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-backup-encryption-"));
    roots.push(root);
    const filename = join(root, "backup-encryption.db");
    const current = new Database(filename);
    new Store(current);
    current.run("DROP TABLE s3_backup_encryption");
    current.run("DROP INDEX idx_ai_suggestions_work");
    current.run("DROP INDEX idx_file_versions_work");
    current.run("DROP INDEX idx_chapter_insights_chapter");
    current.run("DELETE FROM schema_migrations WHERE version = 84");
    current.close();

    const migrated = new Database(filename);
    for (const version of [81, 82, 83, 84]) {
      expect(migrated.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = ?", version)).toEqual({ count: 1 });
    }
    expect(migrated.all("PRAGMA table_info(s3_backup_encryption)").map((column) => column.name)).toEqual([
      "id",
      "enabled",
      "kek_encrypted",
      "kek_iv",
      "kek_tag",
      "created_at",
      "updated_at"
    ]);
    expect(migrated.get("SELECT COUNT(*) AS count FROM s3_backup_encryption")).toEqual({ count: 0 });
    expect(migrated.all("PRAGMA index_list(ai_suggestions)").some((index) => index.name === "idx_ai_suggestions_work")).toBe(true);
    expect(migrated.all("PRAGMA index_list(file_versions)").some((index) => index.name === "idx_file_versions_work")).toBe(true);
    expect(migrated.all("PRAGMA index_list(chapter_insights)").some((index) => index.name === "idx_chapter_insights_chapter")).toBe(true);
    expect(migrated.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(migrated.all("PRAGMA foreign_key_check")).toEqual([]);
    migrated.close();
  });

  it("迁移 85 为既有协作变更补充动作字段并保留旧记录", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-presence-action-"));
    roots.push(root);
    const filename = join(root, "presence-action.db");
    const current = new Database(filename);
    insertSystemOwnedWork(current, "work-presence-action", "协作动作迁移作品", "2026-08-11T00:00:00.000Z");
    current.run(
      `INSERT INTO presence_changes (
         id, work_id, page_key, label, actor_user_id, actor_display_name, saved_at, recipient_client_ids_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      "change-legacy-save",
      "work-presence-action",
      "editor:chapter-1",
      "正文编辑",
      "owner",
      "作者",
      "2026-08-11T00:00:01.000Z",
      "[]"
    );
    current.run("ALTER TABLE presence_changes DROP COLUMN page_deleted");
    current.run("ALTER TABLE presence_changes DROP COLUMN action");
    current.run("DELETE FROM schema_migrations WHERE version = 85");
    current.close();

    const migrated = new Database(filename);
    expect(migrated.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 85")).toEqual({ count: 1 });
    expect(migrated.all("PRAGMA table_info(presence_changes)").map((column) => column.name)).toEqual(expect.arrayContaining([
      "action",
      "page_deleted"
    ]));
    expect(migrated.get("SELECT action, page_deleted FROM presence_changes WHERE id = ?", "change-legacy-save")).toEqual({
      action: "save",
      page_deleted: 0
    });
    expect(migrated.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(migrated.all("PRAGMA foreign_key_check")).toEqual([]);
    migrated.close();
  });

  it("迁移 53 只重排可重建索引并保留领域数据", () => {
    const filename = createLegacyDatabase();
    const current = new Database(filename);
    current.run(
      `INSERT INTO relationship_source_search(work_id, source_type, source_id, source_version, content_hash, updated_at)
       VALUES ('work-old', 'character', 'character-a', '1', 'hash-before', '2025-01-01')`
    );
    current.run("DELETE FROM relationship_source_index_queue WHERE work_id = 'work-old'");
    current.run(
      `INSERT INTO relationship_source_index_state(work_id, status, generation, error, updated_at)
       VALUES ('work-old', 'ready', 4, '', '2025-01-01')
       ON CONFLICT(work_id) DO UPDATE SET status = excluded.status, generation = excluded.generation, updated_at = excluded.updated_at`
    );
    current.run("DELETE FROM schema_migrations WHERE version = 53");
    current.close();

    const migrated = new Database(filename);
    expect(migrated.all(
      "SELECT source_type, source_id FROM relationship_source_index_queue WHERE work_id = 'work-old' ORDER BY source_type, source_id"
    )).toEqual([
      { source_type: "chapter", source_id: "chapter-old" },
      { source_type: "character", source_id: "character-a" }
    ]);
    expect(migrated.get(
      "SELECT source_version, content_hash FROM relationship_source_search WHERE work_id = 'work-old' AND source_type = 'character'"
    )).toEqual({ source_version: "1", content_hash: "hash-before" });
    expect(migrated.get("SELECT status, generation FROM relationship_source_index_state WHERE work_id = 'work-old'"))
      .toEqual({ status: "queued", generation: 4 });
    expect(migrated.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(migrated.all("PRAGMA foreign_key_check")).toEqual([]);
    migrated.close();
  });

  it("历史名称冲突时原子回滚名称索引迁移", () => {
    const filename = createLegacyDatabase(true);
    expect(() => new Database(filename)).toThrow(/重复角色名或别名/u);
    const database = new DatabaseSync(filename);
    expect(database.prepare("SELECT COUNT(*) AS count FROM character_names").get()?.count).toBe(0);
    expect(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 2").get()?.count).toBe(0);
    database.close();
  });

  it("修复迁移编号冲突遗留的作品与分卷版本字段", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-collision-"));
    roots.push(root);
    const filename = join(root, "collision.db");
    const current = new Database(filename);
    current.close();

    const legacy = new DatabaseSync(filename);
    legacy.exec(`
      DELETE FROM schema_migrations WHERE version = 35;
      ALTER TABLE works DROP COLUMN version_no;
      ALTER TABLE volumes DROP COLUMN version_no;
    `);
    legacy.close();

    const repaired = new Database(filename);
    expect(repaired.all("PRAGMA table_info(works)").some((column) => column.name === "version_no")).toBe(true);
    expect(repaired.all("PRAGMA table_info(volumes)").some((column) => column.name === "version_no")).toBe(true);
    expect(repaired.all("PRAGMA table_info(work_memberships)").some((column) => column.name === "permissions_json")).toBe(true);
    expect(repaired.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 35")?.count).toBe(1);
    repaired.close();
  });

  it("迁移 105 以目录顺序回填独立的分卷剧情顺序", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-volume-story-order-"));
    roots.push(root);
    const filename = join(root, "story-order.db");
    const current = new Database(filename);
    const timestamp = "2026-08-20T00:00:00.000Z";
    insertSystemOwnedWork(current, "work-story-order", "剧情顺序迁移", timestamp);
    current.run(
      `INSERT INTO volumes (id, work_id, title, kind, source, description, keywords_json, sort_order, story_order, created_at, updated_at)
       VALUES ('volume-story-order', 'work-story-order', '倒叙卷', 'main', 'manual', '', '[]', 6, 2, ?, ?)`,
      timestamp,
      timestamp
    );
    current.close();

    const legacy = new DatabaseSync(filename);
    legacy.exec(`
      DELETE FROM schema_migrations WHERE version = 105;
      DROP INDEX idx_volumes_story_order;
      ALTER TABLE volumes DROP COLUMN story_order;
    `);
    legacy.close();

    const migrated = new Database(filename);
    expect(migrated.get("SELECT sort_order, story_order FROM volumes WHERE id = 'volume-story-order'"))
      .toEqual({ sort_order: 6, story_order: 6 });
    expect(migrated.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 105")?.count).toBe(1);
    expect(migrated.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(migrated.all("PRAGMA foreign_key_check")).toEqual([]);
    migrated.close();
  });

  it("迁移 109 为已有供应商增加日、月 Token 额度", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-provider-quota-"));
    roots.push(root);
    const filename = join(root, "provider-quota.db");
    const current = new Database(filename);
    expect(current.all("PRAGMA table_info(providers)").map((column) => column.name)).toEqual(expect.arrayContaining([
      "daily_token_quota",
      "monthly_token_quota"
    ]));
    current.close();

    const legacy = new DatabaseSync(filename);
    legacy.exec(`
      DELETE FROM schema_migrations WHERE version = 109;
      ALTER TABLE providers DROP COLUMN daily_token_quota;
      ALTER TABLE providers DROP COLUMN monthly_token_quota;
    `);
    legacy.close();

    const migrated = new Database(filename);
    expect(migrated.all("PRAGMA table_info(providers)").map((column) => column.name)).toEqual(expect.arrayContaining([
      "daily_token_quota",
      "monthly_token_quota"
    ]));
    expect(migrated.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 109")).toEqual({ count: 1 });
    expect(migrated.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(migrated.all("PRAGMA foreign_key_check")).toEqual([]);
    migrated.close();
  });

  it("迁移 112 为已有 API Key 增加可复制密文列并保留摘要", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-api-key-copy-"));
    roots.push(root);
    const filename = join(root, "api-key-copy.db");
    const timestamp = "2026-08-22T00:00:00.000Z";
    const current = new Database(filename);
    current.run(
      `INSERT INTO users (id, username, normalized_username, display_name, password_hash, password_salt, role, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'user', 'active', ?, ?)`,
      "api-key-copy-user",
      "api_key_copy_user",
      "api_key_copy_user",
      "API Key 复制迁移用户",
      "hash",
      "salt",
      timestamp,
      timestamp
    );
    current.run(
      `INSERT INTO user_api_keys (user_id, key_hash, key_prefix, created_at, rotated_at, last_used_at)
       VALUES (?, 'legacy-api-key-hash', 'scrv_legacyxx', ?, ?, NULL)`,
      "api-key-copy-user",
      timestamp,
      timestamp
    );
    current.close();

    const legacy = new DatabaseSync(filename);
    legacy.exec(`
      DELETE FROM schema_migrations WHERE version = 112;
      ALTER TABLE user_api_keys DROP COLUMN key_encrypted;
      ALTER TABLE user_api_keys DROP COLUMN key_iv;
      ALTER TABLE user_api_keys DROP COLUMN key_tag;
    `);
    legacy.close();

    const migrated = new Database(filename);
    expect(migrated.all("PRAGMA table_info(user_api_keys)").map((column) => column.name)).toEqual(expect.arrayContaining([
      "key_hash",
      "key_prefix",
      "key_encrypted",
      "key_iv",
      "key_tag"
    ]));
    expect(migrated.get("SELECT key_hash, key_prefix, key_encrypted, key_iv, key_tag FROM user_api_keys WHERE user_id = 'api-key-copy-user'")).toEqual({
      key_hash: "legacy-api-key-hash",
      key_prefix: "scrv_legacyxx",
      key_encrypted: null,
      key_iv: null,
      key_tag: null
    });
    expect(migrated.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 112")).toEqual({ count: 1 });
    expect(migrated.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(migrated.all("PRAGMA foreign_key_check")).toEqual([]);
    migrated.close();
  });

  it("迁移 110 将日、月 Token 额度约束调整为正整数并保留数据", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-positive-quota-"));
    roots.push(root);
    const filename = join(root, "positive-quota.db");
    const timestamp = "2026-08-21T00:00:00.000Z";
    const current = new Database(filename);
    insertSystemOwnedWork(current, "work-positive-quota", "正额度迁移", timestamp);
    current.run(
      `INSERT INTO work_ai_settings (work_id, daily_token_quota, monthly_token_quota, updated_at)
       VALUES ('work-positive-quota', 12345, 67890, ?)`,
      timestamp
    );
    current.run(
      `INSERT INTO providers (id, work_id, name, base_url, encrypted_key, key_iv, key_tag, key_hint, created_at, updated_at)
       VALUES ('provider-positive-quota', '__scriverse_platform_ai__', '正额度供应商', 'https://mock-ai.test/v1', 'encrypted', 'iv', 'tag', 'hint', ?, ?)`,
      timestamp,
      timestamp
    );
    current.close();

    const legacy = new DatabaseSync(filename);
    legacy.exec(`
      PRAGMA foreign_keys = OFF;
      DELETE FROM schema_migrations WHERE version = 110;
      CREATE TABLE work_ai_settings_v107 AS SELECT * FROM work_ai_settings;
      DROP TABLE work_ai_settings;
      ALTER TABLE work_ai_settings_v107 RENAME TO work_ai_settings;
      CREATE TABLE providers_v107 AS SELECT * FROM providers;
      DROP TABLE providers;
      ALTER TABLE providers_v107 RENAME TO providers;
      PRAGMA foreign_keys = ON;
    `);
    legacy.close();

    const migrated = new Database(filename);
    expect(migrated.get("SELECT daily_token_quota, monthly_token_quota FROM work_ai_settings WHERE work_id = 'work-positive-quota'")).toEqual({
      daily_token_quota: 12345,
      monthly_token_quota: 67890
    });
    expect(migrated.get("SELECT name FROM providers WHERE id = 'provider-positive-quota'")).toEqual({ name: "正额度供应商" });
    expect(String(migrated.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'work_ai_settings'")?.sql)).toContain("daily_token_quota IS NULL OR daily_token_quota >= 1");
    expect(String(migrated.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'providers'")?.sql)).toContain("monthly_token_quota IS NULL OR monthly_token_quota >= 1");
    migrated.run("UPDATE work_ai_settings SET daily_token_quota = 1, monthly_token_quota = 1 WHERE work_id = 'work-positive-quota'");
    migrated.run("UPDATE providers SET daily_token_quota = 1, monthly_token_quota = 1 WHERE id = 'provider-positive-quota'");
    expect(() => migrated.run("UPDATE work_ai_settings SET daily_token_quota = 0 WHERE work_id = 'work-positive-quota'")).toThrow();
    expect(() => migrated.run("UPDATE providers SET monthly_token_quota = -1 WHERE id = 'provider-positive-quota'")).toThrow();
    expect(migrated.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 110")).toEqual({ count: 1 });
    expect(migrated.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(migrated.all("PRAGMA foreign_key_check")).toEqual([]);
    migrated.close();
  });

  it("迁移 40 将 query_story_knowledge 重命名为 search_story_entities", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-tool-rename-"));
    roots.push(root);
    const filename = join(root, "tool-rename.db");
    const first = new Database(filename);
    const timestamp = "2025-01-01T00:00:00.000Z";
    insertSystemOwnedWork(first, "work-tool", "工具迁移", timestamp);
    first.run(
      `INSERT INTO work_ai_settings (work_id, system_prompt, agent_tools_json, updated_at)
       VALUES ('work-tool', '', ?, ?)`,
      JSON.stringify(["story_index", "read_chapters", "query_story_knowledge", "grep", "read_character_sections"]),
      timestamp
    );
    first.run("DELETE FROM schema_migrations WHERE version = 40");
    first.close();

    const second = new Database(filename);
    expect(JSON.parse(String(second.get("SELECT agent_tools_json FROM work_ai_settings WHERE work_id = 'work-tool'")?.agent_tools_json))).toEqual([
      "story_index",
      "read_chapters",
      "search_story_entities",
      "grep",
      "read_character_sections"
    ]);
    expect(second.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 40")?.count).toBe(1);
    second.close();
  });

  it("迁移 55 创建草稿表并为已有作品启用草稿搜索工具", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-drafts-"));
    roots.push(root);
    const filename = join(root, "drafts.db");
    const current = new Database(filename);
    const timestamp = "2026-07-29T00:00:00.000Z";
    insertSystemOwnedWork(current, "work-drafts", "草稿迁移", timestamp);
    current.run(
      `INSERT INTO work_ai_settings (work_id, system_prompt, agent_tools_json, updated_at)
       VALUES ('work-drafts', '', ?, ?)`,
      JSON.stringify(["story_index", "grep"]),
      timestamp
    );
    current.run("DELETE FROM schema_migrations WHERE version = 55");
    current.run("DROP TABLE drafts");
    current.close();

    const migrated = new Database(filename);
    expect(migrated.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'drafts'")?.name).toBe("drafts");
    expect(JSON.parse(String(migrated.get("SELECT agent_tools_json FROM work_ai_settings WHERE work_id = 'work-drafts'")?.agent_tools_json))).toEqual([
      "story_index",
      "grep",
      "search_drafts"
    ]);
    expect(migrated.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(migrated.all("PRAGMA foreign_key_check")).toEqual([]);
    migrated.close();
  });

  it("从迁移 40 的历史调用表升级并保留任务追踪索引", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-call-trace-"));
    roots.push(root);
    const filename = join(root, "call-trace.db");
    const current = new Database(filename);
    current.close();

    const legacy = new DatabaseSync(filename);
    legacy.exec(`
      DROP INDEX idx_calls_task;
      DROP TABLE ai_call_traces;
      ALTER TABLE ai_calls DROP COLUMN task_id;
      DELETE FROM schema_migrations WHERE version = 41;
    `);
    legacy.close();

    const migrated = new Database(filename);
    expect(migrated.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 41")?.count).toBe(1);
    expect(migrated.all("PRAGMA table_info(ai_calls)").some((column) => column.name === "task_id")).toBe(true);
    expect(migrated.all("PRAGMA table_info(ai_call_traces)").map((column) => column.name)).toEqual(
      expect.arrayContaining(["call_id", "task_id", "initial_messages_json", "rounds_json", "created_at", "updated_at"])
    );
    expect(migrated.all("PRAGMA index_list(ai_calls)").some((index) => index.name === "idx_calls_task")).toBe(true);
    expect(migrated.all("PRAGMA index_list(ai_call_traces)").some((index) => index.name === "idx_ai_call_traces_task")).toBe(true);
    migrated.close();
  });

  it("为历史任务追踪补充轻量来源标题字段", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-trace-source-refs-"));
    roots.push(root);
    const filename = join(root, "trace-source-refs.db");
    const current = new Database(filename);
    current.close();

    const legacy = new DatabaseSync(filename);
    legacy.exec(`
      ALTER TABLE ai_call_traces DROP COLUMN source_refs_json;
      DELETE FROM schema_migrations WHERE version = 43;
    `);
    legacy.close();

    const migrated = new Database(filename);
    expect(migrated.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 43")?.count).toBe(1);
    const sourceRefsColumn = migrated.all("PRAGMA table_info(ai_call_traces)")
      .find((column) => column.name === "source_refs_json");
    expect(sourceRefsColumn).toMatchObject({ notnull: 1, dflt_value: "'[]'" });
    expect(migrated.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(migrated.all("PRAGMA foreign_key_check")).toEqual([]);
    migrated.close();
  });

  it("为历史分析任务补充可选模型并保留原任务", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-task-model-"));
    roots.push(root);
    const filename = join(root, "task-model.db");
    const current = new Database(filename);
    const timestamp = "2025-01-01T00:00:00.000Z";
    insertSystemOwnedWork(current, "work-task-model", "任务模型迁移", timestamp);
    current.run(
      `INSERT INTO analysis_tasks (id, work_id, task_type, status, created_at, updated_at)
       VALUES ('task-before-model', 'work-task-model', 'book-analysis', 'pending', ?, ?)`,
      timestamp,
      timestamp
    );
    current.close();

    const legacy = new DatabaseSync(filename);
    legacy.exec(`
      DROP INDEX idx_tasks_model;
      ALTER TABLE analysis_tasks DROP COLUMN model_id;
      DELETE FROM schema_migrations WHERE version = 44;
    `);
    legacy.close();

    const migrated = new Database(filename);
    expect(migrated.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 44")?.count).toBe(1);
    expect(migrated.get("SELECT id, model_id FROM analysis_tasks WHERE id = 'task-before-model'")).toEqual({
      id: "task-before-model",
      model_id: null
    });
    expect(migrated.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(migrated.all("PRAGMA foreign_key_check")).toEqual([]);
    migrated.close();
  });

  it("为历史供应商补充 OpenAI 默认协议并保留配置", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-provider-protocol-"));
    roots.push(root);
    const filename = join(root, "provider-protocol.db");
    const current = new Database(filename);
    const timestamp = "2025-01-01T00:00:00.000Z";
    current.run(
      `INSERT INTO providers (
        id, work_id, name, base_url, encrypted_key, key_iv, key_tag, key_hint, status, created_at, updated_at
      ) VALUES (
        'provider-before-protocol', '__scriverse_platform_ai__', '历史供应商', 'https://legacy-provider.test/v1',
        'encrypted', 'iv', 'tag', '***', 'disabled', ?, ?
      )`,
      timestamp,
      timestamp
    );
    current.close();

    const legacy = new DatabaseSync(filename);
    legacy.exec(`
      ALTER TABLE providers DROP COLUMN protocol;
      DELETE FROM schema_migrations WHERE version = 47;
    `);
    legacy.close();

    const migrated = new Database(filename);
    expect(migrated.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 47")?.count).toBe(1);
    expect(migrated.get("SELECT id, protocol FROM providers WHERE id = 'provider-before-protocol'")).toEqual({
      id: "provider-before-protocol",
      protocol: "openai-chat-completions"
    });
    expect(migrated.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(migrated.all("PRAGMA foreign_key_check")).toEqual([]);
    migrated.close();
  });

  it("建立可重建的关系来源拼音索引并只回填待构建队列", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-relationship-search-"));
    roots.push(root);
    const filename = join(root, "relationship-search.db");
    const database = new Database(filename);

    expect(database.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 45")?.count).toBe(1);
    expect(database.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 46")?.count).toBe(1);
    expect(database.all("PRAGMA table_info(review_items)").some((column) => column.name === "dedupe_key")).toBe(true);
    expect(database.get("SELECT sql FROM sqlite_master WHERE name = 'chapter_paragraph_pinyin_fts'")?.sql)
      .toContain("contentless_delete=1");
    expect(database.get("SELECT sql FROM sqlite_master WHERE name = 'relationship_source_pinyin_fts'")?.sql)
      .toContain("content=''");
    expect(database.all("PRAGMA table_info(relationship_source_search)").map((column) => column.name))
      .not.toContain("pinyin_content");
    expect(database.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(database.all("PRAGMA foreign_key_check")).toEqual([]);
    database.close();

    const schema45 = new Database(filename);
    schema45.run("DELETE FROM schema_migrations WHERE version = 46");
    schema45.raw.exec(`
      DROP TRIGGER relationship_index_volume_dependencies_au;
      CREATE TRIGGER relationship_index_volume_dependencies_au AFTER UPDATE ON volumes BEGIN
        INSERT INTO relationship_source_index_queue(work_id, source_type, source_id, queued_at)
        SELECT chapter.work_id, 'chapter-outline', chapter.id, datetime('now')
        FROM chapters chapter JOIN chapter_outlines outline ON outline.chapter_id = chapter.id
        WHERE chapter.volume_id = new.id
        ON CONFLICT(work_id, source_type, source_id) DO UPDATE SET queued_at = excluded.queued_at;
      END;
    `);
    schema45.close();
    const migrated = new Database(filename);
    expect(migrated.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 46")?.count).toBe(1);
    expect(String(migrated.get("SELECT sql FROM sqlite_master WHERE name = 'relationship_index_volume_dependencies_au'")?.sql))
      .toContain("foreshadow_occurrences");
    expect(migrated.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(migrated.all("PRAGMA foreign_key_check")).toEqual([]);
    migrated.close();
  });

  it("迁移 66 扩大 providers.protocol CHECK 并保留已有供应商与模型", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-vertex-protocol-"));
    roots.push(root);
    const filename = join(root, "provider-vertex-protocol.db");
    const current = new Database(filename);
    const timestamp = "2025-01-01T00:00:00.000Z";
    current.run(
      `INSERT INTO providers (
        id, work_id, name, base_url, protocol, encrypted_key, key_iv, key_tag, key_hint, status, created_at, updated_at
      ) VALUES (
        'provider-before-vertex', '__scriverse_platform_ai__', '历史供应商', 'https://legacy-provider.test/v1',
        'openai-chat-completions', 'encrypted', 'iv', 'tag', '***', 'disabled', ?, ?
      )`,
      timestamp,
      timestamp
    );
    current.run(
      `INSERT INTO models (
        id, provider_id, display_name, model_id, purposes_json, context_note, context_window, output_note,
        preset_json, thinking_enabled, enabled, note, created_at, updated_at
      ) VALUES (
        'model-before-vertex', 'provider-before-vertex', '历史模型', 'legacy-model', '[]', '', 128000, '',
        '{}', 1, 1, '', ?, ?
      )`,
      timestamp,
      timestamp
    );
    current.close();

    const legacy = new DatabaseSync(filename);
    legacy.exec("DELETE FROM schema_migrations WHERE version = 66");
    legacy.close();

    const migrated = new Database(filename);
    expect(migrated.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 66")?.count).toBe(1);
    expect(migrated.get("SELECT id, protocol FROM providers WHERE id = 'provider-before-vertex'")).toEqual({
      id: "provider-before-vertex",
      protocol: "openai-chat-completions"
    });
    expect(migrated.get("SELECT id FROM models WHERE id = 'model-before-vertex'")?.id).toBe("model-before-vertex");
    migrated.run(
      `INSERT INTO providers (
        id, work_id, name, base_url, protocol, encrypted_key, key_iv, key_tag, key_hint, status, created_at, updated_at
      ) VALUES (
        'provider-vertex', '__scriverse_platform_ai__', 'Vertex', 'https://aiplatform.googleapis.com/v1/projects/demo/locations/global/endpoints/openapi',
        'google-vertex', 'encrypted', 'iv', 'tag', 'sa:bot@demo.iam.gserviceaccount.com', 'disabled', ?, ?
      )`,
      timestamp,
      timestamp
    );
    expect(migrated.get("SELECT protocol FROM providers WHERE id = 'provider-vertex'")?.protocol).toBe("google-vertex");
    expect(migrated.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(migrated.all("PRAGMA foreign_key_check")).toEqual([]);
    migrated.close();
  });

  it("迁移 86 扩展封面和头像图片格式并保留已有数据", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-image-format-"));
    roots.push(root);
    const filename = join(root, "image-format.db");
    const current = new Database(filename);
    const work = new Store(current).createWork({ title: "图片格式迁移作品" });
    const timestamp = "2026-08-12T00:00:00.000Z";
    current.run(
      "INSERT INTO work_covers (work_id, mime_type, content, byte_length, sha256, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      String(work.id),
      "image/png",
      Buffer.from("legacy-cover"),
      12,
      "legacy-cover-sha",
      timestamp
    );
    current.run(
      `INSERT INTO users (id, username, normalized_username, display_name, password_hash, password_salt, role, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'user', 'active', ?, ?)`,
      "image-format-user",
      "image-format-user",
      "image-format-user",
      "图片用户",
      "hash",
      "salt",
      timestamp,
      timestamp
    );
    current.run(
      "INSERT INTO user_avatars (user_id, mime_type, content, byte_length, sha256, width, height, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      "image-format-user",
      "image/png",
      Buffer.from("legacy-avatar"),
      13,
      "legacy-avatar-sha",
      1,
      1,
      timestamp
    );
    current.close();

    const legacy = new DatabaseSync(filename);
    legacy.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE work_covers_v85 (
        work_id TEXT PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
        mime_type TEXT NOT NULL CHECK(mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
        content BLOB NOT NULL,
        byte_length INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO work_covers_v85 SELECT work_id, mime_type, content, byte_length, sha256, updated_at FROM work_covers;
      DROP TABLE work_covers;
      ALTER TABLE work_covers_v85 RENAME TO work_covers;
      CREATE TABLE user_avatars_v85 (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        mime_type TEXT NOT NULL CHECK(mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
        content BLOB NOT NULL,
        byte_length INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO user_avatars_v85 SELECT user_id, mime_type, content, byte_length, sha256, width, height, updated_at FROM user_avatars;
      DROP TABLE user_avatars;
      ALTER TABLE user_avatars_v85 RENAME TO user_avatars;
      DELETE FROM schema_migrations WHERE version = 86;
    `);
    legacy.close();

    const migrated = new Database(filename);
    const migratedCover = migrated.get<{ mime_type: string; content: Uint8Array }>(
      "SELECT mime_type, content FROM work_covers WHERE work_id = ?",
      String(work.id)
    );
    expect(migratedCover?.mime_type).toBe("image/png");
    expect(Buffer.from(migratedCover?.content ?? new Uint8Array())).toEqual(Buffer.from("legacy-cover"));
    const migratedAvatar = migrated.get<{ mime_type: string; content: Uint8Array }>(
      "SELECT mime_type, content FROM user_avatars WHERE user_id = ?",
      "image-format-user"
    );
    expect(migratedAvatar?.mime_type).toBe("image/png");
    expect(Buffer.from(migratedAvatar?.content ?? new Uint8Array())).toEqual(Buffer.from("legacy-avatar"));
    expect(String(migrated.get("SELECT sql FROM sqlite_master WHERE name = 'work_covers'")?.sql)).toContain("image/gif");
    expect(String(migrated.get("SELECT sql FROM sqlite_master WHERE name = 'user_avatars'")?.sql)).toContain("image/gif");
    expect(() => migrated.run("UPDATE work_covers SET mime_type = 'image/gif' WHERE work_id = ?", String(work.id))).not.toThrow();
    expect(() => migrated.run("UPDATE user_avatars SET mime_type = 'image/gif' WHERE user_id = ?", "image-format-user")).not.toThrow();
    expect(migrated.get("SELECT MAX(version) AS version FROM schema_migrations")).toEqual({ version: DATABASE_SCHEMA_VERSION });
    expect(migrated.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(migrated.all("PRAGMA foreign_key_check")).toEqual([]);
    migrated.close();
  });

  it("迁移 87 创建 AI 对话分支幂等映射并通过完整性检查", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-conversation-fork-"));
    roots.push(root);
    const filename = join(root, "conversation-fork.db");
    const current = new Database(filename);
    const store = new Store(current);
    const work = store.createWork({ title: "对话分支迁移作品" });
    const conversation = store.createAiConversation(String(work.id), "迁移前对话");
    const message = store.addAiConversationMessage(String(conversation.id), { role: "user", content: "迁移前消息" });
    current.close();

    const legacy = new DatabaseSync(filename);
    legacy.exec("DROP TABLE ai_conversation_forks; DELETE FROM schema_migrations WHERE version = 87");
    legacy.close();

    const migrated = new Database(filename);
    const migratedStore = new Store(migrated);
    const forked = migratedStore.forkAiConversation(
      String(conversation.id),
      String(message.id),
      undefined,
      "migration-fork-request"
    );
    const retried = migratedStore.forkAiConversation(
      String(conversation.id),
      String(message.id),
      undefined,
      "migration-fork-request"
    );
    expect(retried.id).toBe(forked.id);
    expect(migrated.get("SELECT COUNT(*) AS count FROM ai_conversation_forks")).toEqual({ count: 1 });
    expect(migrated.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 87")).toEqual({ count: 1 });
    expect(migrated.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(migrated.all("PRAGMA foreign_key_check")).toEqual([]);
    migrated.close();
  });

  it("迁移 89 创建 AI 对话流请求锁并保持旧对话完整", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-stream-lock-"));
    roots.push(root);
    const filename = join(root, "stream-lock.db");
    const current = new Database(filename);
    const store = new Store(current);
    const work = store.createWork({ title: "流请求锁迁移作品" });
    const conversation = store.createAiConversation(String(work.id), "迁移前对话");
    store.addAiConversationMessage(String(conversation.id), { role: "user", content: "迁移前消息" });
    current.close();

    const legacy = new DatabaseSync(filename);
    legacy.exec("DROP TABLE ai_conversation_stream_requests; DELETE FROM schema_migrations WHERE version = 89");
    legacy.close();

    const migrated = new Database(filename);
    const migratedStore = new Store(migrated);
    const started = migratedStore.beginAiConversationStreamRequest({
      workId: String(work.id),
      conversationId: String(conversation.id),
      actorScope: "user:migration-author",
      idempotencyKey: "migration-request-0001",
      requestHash: "a".repeat(64),
      userMessage: { content: "迁移后消息" }
    });
    expect(started.disposition).toBe("started");
    expect(migrated.all("PRAGMA index_list(ai_conversation_stream_requests)").map((index) => index.name)).toEqual(expect.arrayContaining([
      "idx_ai_conversation_stream_requests_active",
      "idx_ai_conversation_stream_requests_lease"
    ]));
    expect(migrated.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 89")).toEqual({ count: 1 });
    expect(migrated.get("SELECT COUNT(*) AS count FROM ai_conversation_messages WHERE conversation_id = ?", String(conversation.id))).toEqual({ count: 2 });
    expect(migrated.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(migrated.all("PRAGMA foreign_key_check")).toEqual([]);
    migrated.close();
  });

  it("迁移 93 为既有库补建伏笔计划回收章节索引并优化直接关联查询", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-foreshadow-payoff-index-existing-"));
    roots.push(root);
    const filename = join(root, "foreshadow-payoff-index-existing.db");
    const current = new Database(filename);
    const timestamp = "2026-08-15T00:00:00.000Z";
    insertSystemOwnedWork(current, "work-payoff-index", "伏笔索引迁移", timestamp);
    current.run(
      `INSERT INTO volumes (id, work_id, title, sort_order, created_at, updated_at)
       VALUES ('volume-payoff-index', 'work-payoff-index', '第一卷', 0, ?, ?)`,
      timestamp,
      timestamp
    );
    current.run(
      `INSERT INTO chapters (id, work_id, volume_id, title, sort_order, created_at, updated_at)
       VALUES ('chapter-payoff-index', 'work-payoff-index', 'volume-payoff-index', '第一章', 0, ?, ?)`,
      timestamp,
      timestamp
    );
    current.run(
      `INSERT INTO foreshadows
         (id, work_id, title, status, importance, planned_payoff_chapter_id, created_at, updated_at)
       VALUES ('foreshadow-before-index', 'work-payoff-index', '迁移前伏笔', 'planted', 'high',
         'chapter-payoff-index', ?, ?)`,
      timestamp,
      timestamp
    );
    current.run("DROP INDEX idx_foreshadows_work_payoff_status");
    current.run("DELETE FROM schema_migrations WHERE version = 93");
    current.close();

    const migrated = new Database(filename);
    expect(migrated.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 93")).toEqual({ count: 1 });
    expect(migrated.all("PRAGMA index_xinfo('idx_foreshadows_work_payoff_status')")
      .filter((column) => column.key === 1)
      .map((column) => column.name)).toEqual(["work_id", "planned_payoff_chapter_id", "status"]);
    expect(migrated.get("SELECT title FROM foreshadows WHERE id = 'foreshadow-before-index'")).toEqual({ title: "迁移前伏笔" });

    const statusFilterPlan = migrated.all(
      `EXPLAIN QUERY PLAN SELECT chapter.id FROM chapters chapter
       WHERE chapter.work_id = ? AND EXISTS (
         SELECT 1 FROM foreshadows foreshadow
         WHERE foreshadow.work_id = chapter.work_id
           AND foreshadow.planned_payoff_chapter_id = chapter.id
           AND foreshadow.status IN ('planned', 'planted')
       )`,
      "work-payoff-index"
    );
    expect(statusFilterPlan.some((step) => String(step.detail).includes(
      "USING COVERING INDEX idx_foreshadows_work_payoff_status (work_id=? AND planned_payoff_chapter_id=? AND status=?)"
    ))).toBe(true);

    const searchPlan = migrated.all(
      `EXPLAIN QUERY PLAN SELECT chapter.id FROM chapters chapter
       WHERE chapter.work_id = ? AND EXISTS (
         SELECT 1 FROM foreshadows foreshadow
         WHERE foreshadow.work_id = chapter.work_id
           AND foreshadow.planned_payoff_chapter_id = chapter.id
           AND lower(foreshadow.title) LIKE ? ESCAPE '\\'
       )`,
      "work-payoff-index",
      "%迁移前伏笔%"
    );
    expect(searchPlan.some((step) => String(step.detail).includes(
      "USING INDEX idx_foreshadows_work_payoff_status (work_id=? AND planned_payoff_chapter_id=?)"
    ))).toBe(true);

    const associationPlan = migrated.all(
      `EXPLAIN QUERY PLAN SELECT chapter.id, foreshadow.id
       FROM chapters chapter
       JOIN foreshadows foreshadow ON foreshadow.planned_payoff_chapter_id = chapter.id
       WHERE chapter.id IN (?) AND chapter.work_id = ? AND chapter.deleted_at IS NULL
         AND foreshadow.work_id = ?`,
      "chapter-payoff-index",
      "work-payoff-index",
      "work-payoff-index"
    );
    expect(associationPlan.some((step) => String(step.detail).includes(
      "USING INDEX idx_foreshadows_work_payoff_status (work_id=? AND planned_payoff_chapter_id=?)"
    ))).toBe(true);
    expect(migrated.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(migrated.all("PRAGMA foreign_key_check")).toEqual([]);
    migrated.close();
  });

  it("迁移 93 在空库预建索引后可幂等登记并重启", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-foreshadow-payoff-index-fresh-"));
    roots.push(root);
    const filename = join(root, "foreshadow-payoff-index-fresh.db");

    const first = new Database(filename);
    expect(first.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 93")).toEqual({ count: 1 });
    expect(first.all("PRAGMA index_list(foreshadows)")
      .filter((index) => index.name === "idx_foreshadows_work_payoff_status")).toHaveLength(1);
    first.close();

    const restarted = new Database(filename);
    expect(restarted.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 93")).toEqual({ count: 1 });
    expect(restarted.all("PRAGMA index_list(foreshadows)")
      .filter((index) => index.name === "idx_foreshadows_work_payoff_status")).toHaveLength(1);
    expect(restarted.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(restarted.all("PRAGMA foreign_key_check")).toEqual([]);
    restarted.close();
  });

  it("迁移 94 为既有模型补充默认思考强度并保留数据", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-model-thinking-effort-"));
    roots.push(root);
    const filename = join(root, "model-thinking-effort.db");
    const timestamp = "2026-08-16T00:00:00.000Z";
    const current = new Database(filename);
    current.run(
      `INSERT INTO providers (
        id, work_id, name, base_url, protocol, encrypted_key, key_iv, key_tag, key_hint, status, created_at, updated_at
      ) VALUES (
        'provider-thinking-effort', '__scriverse_platform_ai__', '思考强度迁移供应商', 'https://thinking-effort.test/v1',
        'openai-chat-completions', 'encrypted', 'iv', 'tag', '***', 'disabled', ?, ?
      )`,
      timestamp,
      timestamp
    );
    current.run(
      `INSERT INTO models (
        id, provider_id, display_name, model_id, thinking_effort, created_at, updated_at
      ) VALUES (
        'model-thinking-effort', 'provider-thinking-effort', '迁移前模型', 'legacy-thinking-model', 'high', ?, ?
      )`,
      timestamp,
      timestamp
    );
    current.raw.exec("ALTER TABLE models DROP COLUMN thinking_effort");
    current.run("DELETE FROM schema_migrations WHERE version = 94");
    current.close();

    const migrated = new Database(filename);
    expect(migrated.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 94")).toEqual({ count: 1 });
    expect(migrated.get("SELECT display_name, model_id, thinking_effort FROM models WHERE id = 'model-thinking-effort'")).toEqual({
      display_name: "迁移前模型",
      model_id: "legacy-thinking-model",
      thinking_effort: "default"
    });
    expect(migrated.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(migrated.all("PRAGMA foreign_key_check")).toEqual([]);
    migrated.close();
  });

  it("迁移 95 为既有供应商补充默认最大输出参数并保留数据", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-provider-max-token-parameter-"));
    roots.push(root);
    const filename = join(root, "provider-max-token-parameter.db");
    const timestamp = "2026-08-16T00:00:00.000Z";
    const current = new Database(filename);
    current.run(
      `INSERT INTO providers (
        id, work_id, name, base_url, protocol, encrypted_key, key_iv, key_tag, key_hint, status, max_tokens_parameter, created_at, updated_at
      ) VALUES (
        'provider-max-token-parameter', '__scriverse_platform_ai__', '输出参数迁移供应商', 'https://max-token-parameter.test/v1',
        'openai-chat-completions', 'encrypted', 'iv', 'tag', '***', 'disabled', 'max_completion_tokens', ?, ?
      )`,
      timestamp,
      timestamp
    );
    current.raw.exec("ALTER TABLE providers DROP COLUMN max_tokens_parameter");
    current.run("DELETE FROM schema_migrations WHERE version = 95");
    current.close();

    const migrated = new Database(filename);
    expect(migrated.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 95")).toEqual({ count: 1 });
    expect(migrated.get("SELECT name, protocol, max_tokens_parameter FROM providers WHERE id = 'provider-max-token-parameter'")).toEqual({
      name: "输出参数迁移供应商",
      protocol: "openai-chat-completions",
      max_tokens_parameter: "max_tokens"
    });
    expect(migrated.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(migrated.all("PRAGMA foreign_key_check")).toEqual([]);
    migrated.close();
  });

  it("迁移 106 为既有供应商补充默认思考类型并保留数据", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-provider-thinking-type-"));
    roots.push(root);
    const filename = join(root, "provider-thinking-type.db");
    const timestamp = "2026-08-21T00:00:00.000Z";
    const current = new Database(filename);
    current.run(
      `INSERT INTO providers (
        id, work_id, name, base_url, protocol, encrypted_key, key_iv, key_tag, key_hint, status, thinking_type, created_at, updated_at
      ) VALUES (
        'provider-thinking-type', '__scriverse_platform_ai__', '思考类型迁移供应商', 'https://thinking-type.test/v1',
        'openai-chat-completions', 'encrypted', 'iv', 'tag', '***', 'disabled', 'adaptive', ?, ?
      )`,
      timestamp,
      timestamp
    );
    current.raw.exec("ALTER TABLE providers DROP COLUMN thinking_type");
    current.run("DELETE FROM schema_migrations WHERE version = 106");
    current.close();

    const migrated = new Database(filename);
    expect(migrated.get("SELECT name, thinking_type FROM providers WHERE id = 'provider-thinking-type'")).toEqual({
      name: "思考类型迁移供应商",
      thinking_type: "enabled"
    });
    expect(migrated.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 106")).toEqual({ count: 1 });
    expect(migrated.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(migrated.all("PRAGMA foreign_key_check")).toEqual([]);
    migrated.close();
  });

  it("迁移 118 为既有供应商补充默认分析请求超时并保留数据", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-provider-analysis-timeout-"));
    roots.push(root);
    const filename = join(root, "provider-analysis-timeout.db");
    const timestamp = "2026-08-24T00:00:00.000Z";
    const current = new Database(filename);
    current.run(
      `INSERT INTO providers (
        id, work_id, name, base_url, protocol, encrypted_key, key_iv, key_tag, key_hint, status, created_at, updated_at
      ) VALUES (
        'provider-analysis-timeout', '__scriverse_platform_ai__', '分析超时迁移供应商', 'https://analysis-timeout.test/v1',
        'openai-chat-completions', 'encrypted', 'iv', 'tag', '***', 'disabled', ?, ?
      )`,
      timestamp,
      timestamp
    );
    current.raw.exec("ALTER TABLE providers DROP COLUMN analysis_timeout_seconds");
    current.run("DELETE FROM schema_migrations WHERE version = 118");
    current.close();

    const migrated = new Database(filename);
    expect(migrated.get("SELECT name, analysis_timeout_seconds FROM providers WHERE id = 'provider-analysis-timeout'")).toEqual({
      name: "分析超时迁移供应商",
      analysis_timeout_seconds: 300
    });
    expect(migrated.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 118")).toEqual({ count: 1 });
    expect(migrated.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(migrated.all("PRAGMA foreign_key_check")).toEqual([]);
    migrated.close();
  });

  it("迁移 119 为既有分析任务补充 API Key 创建来源并保留数据", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-task-api-key-source-"));
    roots.push(root);
    const filename = join(root, "task-api-key-source.db");
    const timestamp = "2026-08-24T00:00:00.000Z";
    const current = new Database(filename);
    current.run(
      `INSERT INTO analysis_tasks (
        id, work_id, task_type, scope_json, status, created_via_api_key, created_at, updated_at
      ) VALUES ('task-api-key-source', '__scriverse_platform_ai__', 'book-analysis', '{}', 'pending', 1, ?, ?)`,
      timestamp,
      timestamp
    );
    current.raw.exec("ALTER TABLE analysis_tasks DROP COLUMN created_via_api_key");
    current.run("DELETE FROM schema_migrations WHERE version = 119");
    current.close();

    const migrated = new Database(filename);
    expect(migrated.get("SELECT created_via_api_key FROM analysis_tasks WHERE id = 'task-api-key-source'")).toEqual({
      created_via_api_key: 0
    });
    expect(migrated.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 119")).toEqual({ count: 1 });
    expect(migrated.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(migrated.all("PRAGMA foreign_key_check")).toEqual([]);
    migrated.close();
  });

  it("迁移 96 扩展思考强度约束并保留模型引用和删除触发器", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-extended-thinking-effort-"));
    roots.push(root);
    const filename = join(root, "extended-thinking-effort.db");
    const timestamp = "2026-08-16T00:00:00.000Z";
    const current = new Database(filename);
    current.raw.exec("PRAGMA foreign_keys = OFF");
    current.raw.exec(`
      CREATE TABLE models_v95 (
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
        thinking_effort TEXT NOT NULL DEFAULT 'default' CHECK(thinking_effort IN ('default', 'low', 'medium', 'high')),
        multimodal_enabled INTEGER NOT NULL DEFAULT 0 CHECK(multimodal_enabled IN (0, 1)),
        enabled INTEGER NOT NULL DEFAULT 1,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(provider_id, model_id)
      );
      DROP TABLE models;
      ALTER TABLE models_v95 RENAME TO models;
      CREATE TRIGGER ai_connectivity_test_states_model_delete
      AFTER DELETE ON models BEGIN
        DELETE FROM ai_connectivity_test_states WHERE object_type = 'model' AND object_id = OLD.id;
      END;
      PRAGMA foreign_keys = ON;
    `);
    current.run(
      `INSERT INTO providers (
        id, work_id, name, base_url, protocol, encrypted_key, key_iv, key_tag, key_hint, status, created_at, updated_at
      ) VALUES (
        'provider-extended-thinking-effort', '__scriverse_platform_ai__', '扩展思考强度迁移供应商',
        'https://extended-thinking-effort.test/v1', 'openai-chat-completions', 'encrypted', 'iv', 'tag', '***', 'disabled', ?, ?
      )`,
      timestamp,
      timestamp
    );
    current.run(
      `INSERT INTO models (id, provider_id, display_name, model_id, thinking_effort, created_at, updated_at)
       VALUES ('model-extended-thinking-effort', 'provider-extended-thinking-effort', '迁移前模型', 'legacy-effort-model', 'high', ?, ?)`,
      timestamp,
      timestamp
    );
    current.run(
      "INSERT INTO task_defaults (work_id, task_type, model_id) VALUES ('__scriverse_platform_ai__', 'chat', 'model-extended-thinking-effort')"
    );
    current.run(
      `INSERT INTO ai_connectivity_test_states (object_type, object_id, config_fingerprint, state, attempt_id, retry_at_ms, updated_at)
       VALUES ('model', 'model-extended-thinking-effort', ?, 'success', 'attempt-extended-thinking-effort', 0, ?)`,
      "a".repeat(64),
      timestamp
    );
    current.run("DELETE FROM schema_migrations WHERE version = 96");
    current.close();

    const migrated = new Database(filename);
    expect(migrated.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 96")).toEqual({ count: 1 });
    expect(migrated.get("SELECT display_name, thinking_effort FROM models WHERE id = 'model-extended-thinking-effort'")).toEqual({
      display_name: "迁移前模型",
      thinking_effort: "high"
    });
    expect(migrated.get("SELECT model_id FROM task_defaults WHERE task_type = 'chat'")).toEqual({ model_id: "model-extended-thinking-effort" });
    expect(migrated.get("SELECT state FROM ai_connectivity_test_states WHERE object_id = 'model-extended-thinking-effort'")).toEqual({ state: "success" });
    migrated.run("UPDATE models SET thinking_effort = 'xhigh' WHERE id = 'model-extended-thinking-effort'");
    expect(migrated.get("SELECT thinking_effort FROM models WHERE id = 'model-extended-thinking-effort'")).toEqual({ thinking_effort: "xhigh" });
    migrated.run("UPDATE models SET thinking_effort = 'max' WHERE id = 'model-extended-thinking-effort'");
    expect(migrated.get("SELECT thinking_effort FROM models WHERE id = 'model-extended-thinking-effort'")).toEqual({ thinking_effort: "max" });
    expect(migrated.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(migrated.all("PRAGMA foreign_key_check")).toEqual([]);
    migrated.run("DELETE FROM models WHERE id = 'model-extended-thinking-effort'");
    expect(migrated.get("SELECT COUNT(*) AS count FROM task_defaults WHERE task_type = 'chat'")).toEqual({ count: 0 });
    expect(migrated.get("SELECT COUNT(*) AS count FROM ai_connectivity_test_states WHERE object_id = 'model-extended-thinking-effort'")).toEqual({ count: 0 });
    migrated.close();
  });

  it("迁移 111 扩展 auto 思考强度并保留模型引用和删除触发器", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-auto-thinking-effort-"));
    roots.push(root);
    const filename = join(root, "auto-thinking-effort.db");
    const timestamp = "2026-08-22T00:00:00.000Z";
    const current = new Database(filename);
    current.raw.exec("PRAGMA foreign_keys = OFF");
    current.raw.exec(`
      CREATE TABLE models_v110 (
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
      );
      DROP TABLE models;
      ALTER TABLE models_v110 RENAME TO models;
      CREATE TRIGGER ai_connectivity_test_states_model_delete
      AFTER DELETE ON models BEGIN
        DELETE FROM ai_connectivity_test_states WHERE object_type = 'model' AND object_id = OLD.id;
      END;
      PRAGMA foreign_keys = ON;
    `);
    current.run(
      `INSERT INTO providers (
        id, work_id, name, base_url, protocol, encrypted_key, key_iv, key_tag, key_hint, status, created_at, updated_at
      ) VALUES (
        'provider-auto-thinking-effort', '__scriverse_platform_ai__', '自动思考强度迁移供应商',
        'https://auto-thinking-effort.test/v1', 'openai-chat-completions', 'encrypted', 'iv', 'tag', '***', 'disabled', ?, ?
      )`,
      timestamp,
      timestamp
    );
    current.run(
      `INSERT INTO models (id, provider_id, display_name, model_id, thinking_effort, created_at, updated_at)
       VALUES ('model-auto-thinking-effort', 'provider-auto-thinking-effort', '迁移前模型', 'legacy-auto-effort-model', 'high', ?, ?)`,
      timestamp,
      timestamp
    );
    current.run(
      "INSERT INTO task_defaults (work_id, task_type, model_id) VALUES ('__scriverse_platform_ai__', 'chat', 'model-auto-thinking-effort')"
    );
    current.run(
      `INSERT INTO ai_connectivity_test_states (object_type, object_id, config_fingerprint, state, attempt_id, retry_at_ms, updated_at)
       VALUES ('model', 'model-auto-thinking-effort', ?, 'success', 'attempt-auto-thinking-effort', 0, ?)`,
      "a".repeat(64),
      timestamp
    );
    current.run("DELETE FROM schema_migrations WHERE version = 111");
    current.close();

    const migrated = new Database(filename);
    expect(migrated.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 111")).toEqual({ count: 1 });
    expect(migrated.get("SELECT display_name, thinking_effort FROM models WHERE id = 'model-auto-thinking-effort'")).toEqual({
      display_name: "迁移前模型",
      thinking_effort: "high"
    });
    expect(migrated.get("SELECT model_id FROM task_defaults WHERE task_type = 'chat'")).toEqual({ model_id: "model-auto-thinking-effort" });
    expect(migrated.get("SELECT state FROM ai_connectivity_test_states WHERE object_id = 'model-auto-thinking-effort'")).toEqual({ state: "success" });
    migrated.run("UPDATE models SET thinking_effort = 'auto' WHERE id = 'model-auto-thinking-effort'");
    expect(migrated.get("SELECT thinking_effort FROM models WHERE id = 'model-auto-thinking-effort'")).toEqual({ thinking_effort: "auto" });
    expect(migrated.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(migrated.all("PRAGMA foreign_key_check")).toEqual([]);
    migrated.run("DELETE FROM models WHERE id = 'model-auto-thinking-effort'");
    expect(migrated.get("SELECT COUNT(*) AS count FROM task_defaults WHERE task_type = 'chat'")).toEqual({ count: 0 });
    expect(migrated.get("SELECT COUNT(*) AS count FROM ai_connectivity_test_states WHERE object_id = 'model-auto-thinking-effort'")).toEqual({ count: 0 });
    migrated.close();
  });

  it("迁移 103 将无归属历史对话回填给作品创建者并建立列表索引", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-conversation-owner-"));
    roots.push(root);
    const filename = join(root, "conversation-owner.db");
    const timestamp = "2026-08-20T00:00:00.000Z";
    const current = new Database(filename);
    const store = new Store(current);
    current.run(
      `INSERT INTO users (
        id, username, normalized_username, display_name, password_hash, password_salt,
        role, status, created_at, updated_at
      ) VALUES ('migration-owner', 'migration_owner', 'migration_owner', '迁移创建者', 'hash', 'salt', 'admin', 'active', ?, ?)`,
      timestamp,
      timestamp
    );
    const work = store.createWork({ title: "历史对话迁移作品" });
    current.run("UPDATE works SET owner_user_id = 'migration-owner' WHERE id = ?", String(work.id));
    const conversation = store.createAiConversation(String(work.id), "待回填对话");
    expect(current.get("SELECT created_by_user_id FROM ai_conversations WHERE id = ?", String(conversation.id))).toEqual({
      created_by_user_id: null
    });
    current.run("DELETE FROM schema_migrations WHERE version = 103");
    current.close();

    const migrated = new Database(filename);
    expect(migrated.get("SELECT created_by_user_id FROM ai_conversations WHERE id = ?", String(conversation.id))).toEqual({
      created_by_user_id: "migration-owner"
    });
    expect(migrated.all("PRAGMA index_list(ai_conversations)").some((index) => index.name === "idx_ai_conversations_work_creator")).toBe(true);
    expect(migrated.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(migrated.all("PRAGMA foreign_key_check")).toEqual([]);
    migrated.close();
  });

  it("迁移 125 创建语义检索配置、索引和快照结构并默认关闭", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-semantic-search-"));
    roots.push(root);
    const filename = join(root, "semantic-search.db");
    const database = new Database(filename);
    const store = new Store(database);
    const work = store.createWork({ title: "语义检索迁移作品" });

    expect(database.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 125")).toEqual({ count: 1 });
    expect(database.all("PRAGMA table_info(models)").some((column) => column.name === "model_kind")).toBe(true);
    expect(database.all("PRAGMA table_info(work_ai_settings)").map((column) => column.name)).toEqual(expect.arrayContaining([
      "semantic_search_enabled",
      "semantic_embedding_model_id",
      "semantic_rerank_model_id",
      "semantic_vector_dimension",
      "semantic_recall_limit",
      "semantic_result_limit",
      "semantic_budget_tokens",
      "semantic_channel_weight"
    ]));
    expect(store.getWorkAiSettings(String(work.id))).toMatchObject({ workId: work.id });
    expect(database.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'semantic_index_entries'")).toEqual({
      name: "semantic_index_entries"
    });
    expect(database.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'semantic_context_snapshots'")).toEqual({
      name: "semantic_context_snapshots"
    });
    expect(database.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(database.all("PRAGMA foreign_key_check")).toEqual([]);
    database.close();
  });
});
