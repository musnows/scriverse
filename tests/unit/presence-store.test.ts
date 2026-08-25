import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PersistedCollaborativeChange, PersistedPresenceEntry } from "../../src/collaboration-presence.js";
import { Database, SYSTEM_USER_ID } from "../../src/database.js";
import { PresenceStore } from "../../src/presence-store.js";

function entry(workId: string, clientId: string, lastSeenAt: string): PersistedPresenceEntry {
  return {
    workId,
    clientId,
    userId: `user-${clientId}`,
    username: `username-${clientId}`,
    displayName: `用户 ${clientId}`,
    avatarUrl: null,
    page: { kind: "editor", resourceId: "chapter-1" },
    lastSeenAt
  };
}

function change(workId: string, id: string, savedAt: string): PersistedCollaborativeChange {
  return {
    id,
    workId,
    pageKey: "editor:chapter-1",
    label: "正文编辑",
    action: "delete",
    pageDeleted: true,
    actorUserId: "owner",
    actorDisplayName: "作者",
    savedAt,
    recipients: [
      { userId: "user-client-boundary", clientId: "client-boundary" },
      { userId: "user-client-boundary", clientId: "client-boundary" }
    ]
  };
}

describe("协作状态持久层", () => {
  let database: Database;
  let store: PresenceStore;

  beforeEach(() => {
    database = new Database(":memory:");
    database.run(
      "INSERT INTO works (id, title, created_at, updated_at, owner_user_id) VALUES (?, ?, ?, ?, ?)",
      "work-1",
      "持久化测试作品",
      "2026-07-24T08:00:00.000Z",
      "2026-07-24T08:00:00.000Z",
      SYSTEM_USER_ID
    );
    store = new PresenceStore(database);
  });

  afterEach(() => database.close());

  it("批量往返参与者和变更并拒绝较旧心跳覆盖新状态", () => {
    store.flush({
      entries: [entry("work-1", "client-boundary", "2026-07-24T08:00:01.000Z")],
      changes: [change("work-1", "change-1", "2026-07-24T08:00:01.000Z")]
    });
    store.flush({
      entries: [{
        ...entry("work-1", "client-boundary", "2026-07-24T08:00:02.000Z"),
        displayName: "最新用户",
        page: { kind: "module", module: "timeline" }
      }],
      changes: []
    });
    store.flush({
      entries: [{
        ...entry("work-1", "client-boundary", "2026-07-24T08:00:00.000Z"),
        displayName: "过期用户"
      }],
      changes: [change("work-1", "change-1", "2026-07-24T08:00:03.000Z")]
    });

    expect(store.loadEntries("2026-07-24T08:00:01.000Z")).toEqual([
      expect.objectContaining({
        clientId: "client-boundary",
        displayName: "最新用户",
        page: { kind: "module", module: "timeline" },
        lastSeenAt: "2026-07-24T08:00:02.000Z"
      })
    ]);
    expect(store.loadChanges("2026-07-24T08:00:01.000Z", 50)).toEqual([
      expect.objectContaining({
        id: "change-1",
        savedAt: "2026-07-24T08:00:01.000Z",
        action: "delete",
        pageDeleted: true,
        recipients: [{ userId: "user-client-boundary", clientId: "client-boundary" }]
      })
    ]);
    expect(database.get("SELECT action, page_deleted, recipient_client_ids_json FROM presence_changes WHERE id = ?", "change-1")).toEqual({
      action: "delete",
      page_deleted: 1,
      recipient_client_ids_json: '[{"userId":"user-client-boundary","clientId":"client-boundary"}]'
    });
  });

  it("读取旧版仅含 clientId 的收件列表时安全地拒绝投递", () => {
    database.run(
      `INSERT INTO presence_changes (
         id, work_id, page_key, label, actor_user_id, actor_display_name, saved_at, recipient_client_ids_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      "legacy-change",
      "work-1",
      "editor:chapter-1",
      "正文编辑",
      "owner",
      "作者",
      "2026-07-24T08:00:01.000Z",
      JSON.stringify(["client-boundary"])
    );

    expect(store.loadChanges("2026-07-24T08:00:00.000Z", 50)).toEqual([
      expect.objectContaining({ id: "legacy-change", action: "save", pageDeleted: false, recipients: [] })
    ]);
  });

  it("按严格过期边界清理并由作品外键级联删除", () => {
    store.flush({
      entries: [
        entry("work-1", "client-expired", "2026-07-24T08:00:00.999Z"),
        entry("work-1", "client-boundary", "2026-07-24T08:00:01.000Z")
      ],
      changes: [
        change("work-1", "change-expired", "2026-07-24T08:00:00.999Z"),
        change("work-1", "change-boundary", "2026-07-24T08:00:01.000Z")
      ]
    });
    store.flush({
      entries: [],
      changes: [],
      entryExpiryCutoff: "2026-07-24T08:00:01.000Z",
      changeExpiryCutoff: "2026-07-24T08:00:01.000Z"
    });

    expect(database.all("SELECT client_id FROM presence_entries ORDER BY client_id")).toEqual([{ client_id: "client-boundary" }]);
    expect(database.all("SELECT id FROM presence_changes ORDER BY id")).toEqual([{ id: "change-boundary" }]);

    database.run("DELETE FROM works WHERE id = ?", "work-1");
    expect(database.get("SELECT COUNT(*) AS count FROM presence_entries")).toEqual({ count: 0 });
    expect(database.get("SELECT COUNT(*) AS count FROM presence_changes")).toEqual({ count: 0 });
  });

  it("批量写中任一外键失败时回滚整个事务", () => {
    expect(() => store.flush({
      entries: [
        entry("work-1", "client-valid", "2026-07-24T08:00:01.000Z"),
        entry("missing-work", "client-invalid", "2026-07-24T08:00:01.000Z")
      ],
      changes: []
    })).toThrow();
    expect(database.get("SELECT COUNT(*) AS count FROM presence_entries")).toEqual({ count: 0 });
  });
});
