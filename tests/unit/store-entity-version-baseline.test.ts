import { afterEach, describe, expect, it, vi } from "vitest";
import { Database, ENTITY_VERSION_BASELINE_MIGRATION_VERSION, SYSTEM_USER_ID } from "../../src/database.js";
import { Store } from "../../src/store.js";

const ENTITY_SCAN_QUERIES = [
  "SELECT id, updated_at FROM works",
  "SELECT id, updated_at FROM volumes",
  "SELECT id, updated_at FROM drafts",
  "SELECT id, updated_at FROM settings",
  "SELECT id, updated_at FROM races",
  "SELECT id, updated_at FROM organizations",
  "SELECT id, updated_at FROM timeline_tracks",
  "SELECT id, updated_at FROM timeline_events",
  "SELECT id, updated_at FROM relationships",
  "SELECT chapter_id, updated_at FROM chapter_outlines",
  "SELECT id, updated_at FROM foreshadows"
] as const;

const databases: Database[] = [];

function createDatabase(options: { hasVersions: boolean; hasMarker: boolean }): Database {
  const database = new Database(":memory:");
  databases.push(database);
  database.run(
    "INSERT INTO works (id, title, created_at, updated_at, owner_user_id) VALUES (?, ?, ?, ?, ?)",
    "work-baseline",
    "基线迁移测试作品",
    "2026-08-01T00:00:00.000Z",
    "2026-08-02T00:00:00.000Z",
    SYSTEM_USER_ID
  );
  if (options.hasVersions) {
    database.run(
      `INSERT INTO entity_versions
       (id, work_id, entity_type, entity_id, version_no, snapshot_json, source, change_note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "entity-version-existing",
      "work-baseline",
      "work",
      "work-baseline",
      1,
      JSON.stringify({ title: "已有版本" }),
      "update",
      "已有版本记录",
      "2026-08-03T00:00:00.000Z"
    );
  }
  if (options.hasMarker) {
    database.run(
      "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      ENTITY_VERSION_BASELINE_MIGRATION_VERSION,
      "2026-08-04T00:00:00.000Z"
    );
  }
  return database;
}

function entityScans(calls: readonly (readonly unknown[])[]): string[] {
  return calls
    .map(([sql]) => String(sql))
    .filter((sql) => ENTITY_SCAN_QUERIES.includes(sql as (typeof ENTITY_SCAN_QUERIES)[number]));
}

function expectHealthy(database: Database): void {
  expect(database.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
  expect(database.all("PRAGMA foreign_key_check")).toEqual([]);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
});

describe("实体版本基线一次性迁移", () => {
  it("无版本数据且无标记时补齐基线并让后续启动只查询标记", () => {
    const database = createDatabase({ hasVersions: false, hasMarker: false });
    const allSpy = vi.spyOn(database, "all");

    new Store(database);

    expect(entityScans(allSpy.mock.calls)).toEqual(ENTITY_SCAN_QUERIES);
    expect(database.get(
      "SELECT source, change_note, created_at FROM entity_versions WHERE entity_type = ? AND entity_id = ?",
      "work",
      "work-baseline"
    )).toEqual({
      source: "migration",
      change_note: "建立版本基线",
      created_at: "2026-08-02T00:00:00.000Z"
    });
    expect(database.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = ?", ENTITY_VERSION_BASELINE_MIGRATION_VERSION)).toEqual({ count: 1 });

    allSpy.mockClear();
    const getSpy = vi.spyOn(database, "get");
    new Store(database);

    expect(entityScans(allSpy.mock.calls)).toEqual([]);
    expect(getSpy.mock.calls).toHaveLength(1);
    expect(String(getSpy.mock.calls[0]?.[0])).toContain("schema_migrations");
    expectHealthy(database);
  });

  it("无版本数据但有标记时直接跳过", () => {
    const database = createDatabase({ hasVersions: false, hasMarker: true });
    const allSpy = vi.spyOn(database, "all");
    const getSpy = vi.spyOn(database, "get");

    new Store(database);

    expect(entityScans(allSpy.mock.calls)).toEqual([]);
    expect(getSpy.mock.calls).toHaveLength(1);
    expect(String(getSpy.mock.calls[0]?.[0])).toContain("schema_migrations");
    expect(database.get("SELECT COUNT(*) AS count FROM entity_versions")).toEqual({ count: 0 });
    expectHealthy(database);
  });

  it("已有版本数据但无标记时仅写入标记", () => {
    const database = createDatabase({ hasVersions: true, hasMarker: false });
    const allSpy = vi.spyOn(database, "all");

    new Store(database);

    expect(entityScans(allSpy.mock.calls)).toEqual([]);
    expect(database.get(
      "SELECT COUNT(*) AS count FROM entity_versions WHERE entity_type = ? AND entity_id = ?",
      "work",
      "work-baseline"
    )).toEqual({ count: 1 });
    expect(database.get("SELECT source FROM entity_versions WHERE id = ?", "entity-version-existing")).toEqual({ source: "update" });
    expect(database.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = ?", ENTITY_VERSION_BASELINE_MIGRATION_VERSION)).toEqual({ count: 1 });
    expectHealthy(database);
  });

  it("已有版本数据且有标记时直接跳过", () => {
    const database = createDatabase({ hasVersions: true, hasMarker: true });
    const allSpy = vi.spyOn(database, "all");
    const getSpy = vi.spyOn(database, "get");

    new Store(database);

    expect(entityScans(allSpy.mock.calls)).toEqual([]);
    expect(getSpy.mock.calls).toHaveLength(1);
    expect(String(getSpy.mock.calls[0]?.[0])).toContain("schema_migrations");
    expect(database.get("SELECT COUNT(*) AS count FROM entity_versions")).toEqual({ count: 1 });
    expectHealthy(database);
  });

  it("补齐失败时回滚版本记录与标记并允许下次启动重试", () => {
    const database = createDatabase({ hasVersions: false, hasMarker: false });
    database.raw.exec(`CREATE TRIGGER reject_entity_version_baseline
      BEFORE INSERT ON entity_versions
      BEGIN
        SELECT RAISE(ABORT, 'baseline failure');
      END`);

    expect(() => new Store(database)).toThrow(/baseline failure/u);
    expect(database.get("SELECT COUNT(*) AS count FROM entity_versions")).toEqual({ count: 0 });
    expect(database.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = ?", ENTITY_VERSION_BASELINE_MIGRATION_VERSION)).toEqual({ count: 0 });

    database.raw.exec("DROP TRIGGER reject_entity_version_baseline");
    new Store(database);

    expect(database.get(
      "SELECT COUNT(*) AS count FROM entity_versions WHERE entity_type = ? AND entity_id = ?",
      "work",
      "work-baseline"
    )).toEqual({ count: 1 });
    expect(database.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = ?", ENTITY_VERSION_BASELINE_MIGRATION_VERSION)).toEqual({ count: 1 });
    expectHealthy(database);
  });
});
