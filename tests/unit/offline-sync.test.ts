import { afterEach, describe, expect, it } from "vitest";
import { Database, SYSTEM_USER_ID } from "../../src/database.js";
import { AppError } from "../../src/errors.js";
import { OfflineSyncService } from "../../src/offline-sync.js";
import { Store } from "../../src/store.js";

function expectAppError(operation: () => unknown, code: string, status: number): void {
  let caught: unknown;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AppError);
  expect(caught).toMatchObject({ code, status });
}

describe("离线同步快照", () => {
  let database: Database | null = null;

  afterEach(() => {
    database?.close();
    database = null;
  });

  it("过期后不再允许读取且不将快照分配给其他用户", () => {
    database = new Database(":memory:");
    const store = new Store(database);
    const work = store.createWork({ title: "过期快照作品" });
    store.setWorkOfflineAccess(String(work.id), true);
    let timestamp = Date.parse("2026-08-23T00:00:00.000Z");
    const sync = new OfflineSyncService(database, store, {
      now: () => timestamp,
      snapshotTtlMs: 1_000
    });
    const snapshot = sync.createSnapshot(String(work.id), "user-a");

    expectAppError(() => sync.describeOwnedSnapshot(snapshot.snapshotId, "user-b"), "SYNC_SNAPSHOT_NOT_FOUND", 404);
    timestamp += 1_000;
    expectAppError(() => sync.readSnapshotPage(snapshot.snapshotId, "user-a", 0, 100), "SYNC_SNAPSHOT_EXPIRED", 410);
    expectAppError(() => sync.describeOwnedSnapshot(snapshot.snapshotId, "user-a"), "SYNC_SNAPSHOT_NOT_FOUND", 404);
  });

  it("拒绝附件校验失败的更新时回滚正文、版本、审计和增量同步记录", () => {
    database = new Database(":memory:");
    const store = new Store(database);
    const workId = String(store.createWork({ title: "同步回滚" }).id);
    store.setWorkOfflineAccess(workId, true);
    const setting = store.createSetting(workId, { title: "Original", category: "Rules", content: "Original content" });
    const sync = new OfflineSyncService(database, store);
    const beforeChanges = database.all("SELECT * FROM sync_changes WHERE work_id = ?", workId);
    const beforeAudits = database.all("SELECT * FROM audit_logs WHERE work_id = ?", workId);
    const result = sync.pushMutations(workId, SYSTEM_USER_ID, "test-client", [{
      mutationId: "invalid-attachment-update", entityType: "setting", entityId: String(setting.id), operation: "update", baseVersionNo: 1, changeNote: "Invalid update",
      localSnapshot: { title: "Changed", category: "Changed", content: "![missing](attachment://missing-file)" }
    }]);
    expect(result.summary).toEqual({ applied: 0, conflict: 0, rejected: 1, replayed: 0 });
    expect(result.results[0]).toMatchObject({ status: "rejected", errorCode: "NOT_FOUND" });
    expect(store.getSetting(String(setting.id))).toEqual(setting);
    expect(database.all("SELECT * FROM sync_changes WHERE work_id = ?", workId)).toEqual(beforeChanges);
    expect(database.all("SELECT * FROM audit_logs WHERE work_id = ?", workId)).toEqual(beforeAudits);
    expect(database.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(database.all("PRAGMA foreign_key_check")).toEqual([]);
  });
});
