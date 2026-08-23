import { afterEach, describe, expect, it } from "vitest";
import { Database } from "../../src/database.js";
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
});
