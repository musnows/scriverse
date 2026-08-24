import { createHash, randomUUID } from "node:crypto";
import { Database } from "./database.js";
import { AppError } from "./errors.js";
import { Store } from "./store.js";
import { countWords } from "./utils.js";

export const SYNC_SNAPSHOT_TTL_MS = 15 * 60 * 1_000;
export const SYNC_SNAPSHOT_PAGE_BYTE_LIMIT = 4 * 1024 * 1024;
const MAX_ACTIVE_SYNC_SNAPSHOTS = 128;

export type SyncSnapshotDescriptor = {
  snapshotId: string;
  workId: string;
  cutoffCursor: number;
  itemCount: number;
  expiresAt: string;
  syncProtocol: 1;
};

type SyncSnapshotItem = {
  sequence: number;
  entityType: "work" | "volume" | "chapter" | "setting";
  entityId: string;
  versionNo: number;
  data: Record<string, unknown>;
};

type StoredSyncSnapshotItem = SyncSnapshotItem & { byteLength: number };

type StoredSyncSnapshot = SyncSnapshotDescriptor & {
  userId: string;
  createdAtMs: number;
  expiresAtMs: number;
  items: StoredSyncSnapshotItem[];
};

export type SyncSnapshotPage = {
  snapshotId: string;
  workId: string;
  cutoffCursor: number;
  after: number;
  nextAfter: number | null;
  hasMore: boolean;
  items: SyncSnapshotItem[];
};

export type SyncChangeItem = {
  cursor: number;
  entityType: "chapter" | "setting";
  entityId: string;
  operation: "upsert" | "delete";
  versionNo: number;
  changedByUserId: string | null;
  changedAt: string;
  data: Record<string, unknown> | null;
};

export type SyncChangePage = {
  workId: string;
  after: number;
  nextCursor: number;
  latestCursor: number;
  hasMore: boolean;
  items: SyncChangeItem[];
};

export type ChapterSyncSnapshot = {
  title: string;
  content: string;
  chapterType: "正文" | "设定" | "作者的话" | "其他";
};

export type SettingSyncSnapshot = {
  title: string;
  category: string;
  content: string;
  tags?: string[];
  status?: "draft" | "pending" | "confirmed" | "deprecated";
  locked?: boolean;
  evidence?: unknown[];
  scope?: Record<string, unknown>;
  authorNote?: string;
};

export type SyncMutation = {
  mutationId: string;
  entityId: string;
  operation: "update";
  baseVersionNo: number;
  changeNote: string;
} & (
  | { entityType: "chapter"; localSnapshot: ChapterSyncSnapshot }
  | { entityType: "setting"; localSnapshot: SettingSyncSnapshot }
);

export type SyncMutationResult = {
  mutationId: string;
  entityType: "chapter" | "setting";
  entityId: string;
  status: "applied" | "conflict" | "rejected";
  baseVersionNo: number;
  appliedVersionNo: number | null;
  conflictVersionNo: number | null;
  errorCode: string | null;
  baseSnapshot: Record<string, unknown> | null;
  localSnapshot: Record<string, unknown> | null;
  serverSnapshot: Record<string, unknown> | null;
  replayed: boolean;
};

export type SyncPushResult = {
  clientId: string;
  results: SyncMutationResult[];
  summary: {
    applied: number;
    conflict: number;
    rejected: number;
    replayed: number;
  };
};

type OfflineSyncOptions = {
  now?: () => number;
  snapshotTtlMs?: number;
};

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function snapshotItem(
  sequence: number,
  entityType: SyncSnapshotItem["entityType"],
  data: Record<string, unknown>
): StoredSyncSnapshotItem {
  const item: SyncSnapshotItem = {
    sequence,
    entityType,
    entityId: String(data.id ?? ""),
    versionNo: Number(data.versionNo ?? 0),
    data
  };
  return { ...item, byteLength: Buffer.byteLength(JSON.stringify(item), "utf8") };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export class OfflineSyncService {
  private readonly snapshots = new Map<string, StoredSyncSnapshot>();
  private readonly now: () => number;
  private readonly snapshotTtlMs: number;

  constructor(
    private readonly database: Database,
    private readonly store: Store,
    options: OfflineSyncOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.snapshotTtlMs = options.snapshotTtlMs ?? SYNC_SNAPSHOT_TTL_MS;
  }

  createSnapshot(workId: string, userId: string): SyncSnapshotDescriptor {
    const captured = this.database.transaction(() => {
      this.assertOfflineAccessEnabled(workId);
      const tree = this.store.getWorkTree(workId);
      const volumes = recordArray(tree.volumes);
      const { volumes: _volumes, modulePermissions: _modulePermissions, accessRole: _accessRole, ...work } = tree;
      const rawItems: Array<{ entityType: SyncSnapshotItem["entityType"]; data: Record<string, unknown> }> = [
        { entityType: "work", data: work }
      ];
      for (const volumeWithChapters of volumes) {
        const chapters = recordArray(volumeWithChapters.chapters);
        const { chapters: _chapters, ...volume } = volumeWithChapters;
        rawItems.push({ entityType: "volume", data: volume });
        for (const chapter of chapters) rawItems.push({ entityType: "chapter", data: chapter });
      }
      for (const setting of this.store.listSettings(workId, true)) {
        rawItems.push({ entityType: "setting", data: setting });
      }
      const cutoffCursor = Number(this.database.get(
        "SELECT COALESCE(MAX(cursor), 0) AS cursor FROM sync_changes WHERE work_id = ?",
        workId
      )?.cursor ?? 0);
      return {
        cutoffCursor,
        items: rawItems.map((item, index) => snapshotItem(index + 1, item.entityType, item.data))
      };
    });
    const createdAtMs = this.now();
    this.pruneExpired(createdAtMs);
    for (const [snapshotId, snapshot] of this.snapshots) {
      if (snapshot.userId === userId && snapshot.workId === workId) this.snapshots.delete(snapshotId);
    }
    while (this.snapshots.size >= MAX_ACTIVE_SYNC_SNAPSHOTS) {
      const oldest = [...this.snapshots.values()].sort((left, right) => left.createdAtMs - right.createdAtMs)[0];
      if (!oldest) break;
      this.snapshots.delete(oldest.snapshotId);
    }
    const snapshot: StoredSyncSnapshot = {
      snapshotId: randomUUID(),
      workId,
      userId,
      cutoffCursor: captured.cutoffCursor,
      itemCount: captured.items.length,
      createdAtMs,
      expiresAtMs: createdAtMs + this.snapshotTtlMs,
      expiresAt: new Date(createdAtMs + this.snapshotTtlMs).toISOString(),
      syncProtocol: 1,
      items: captured.items
    };
    this.snapshots.set(snapshot.snapshotId, snapshot);
    return this.descriptor(snapshot);
  }

  describeOwnedSnapshot(snapshotId: string, userId: string): SyncSnapshotDescriptor {
    return this.descriptor(this.ownedSnapshot(snapshotId, userId));
  }

  readSnapshotPage(snapshotId: string, userId: string, after: number, limit: number): SyncSnapshotPage {
    const snapshot = this.ownedSnapshot(snapshotId, userId);
    this.assertOfflineAccessEnabled(snapshot.workId);
    const candidates = snapshot.items.filter((item) => item.sequence > after).slice(0, limit);
    const selected: StoredSyncSnapshotItem[] = [];
    let selectedBytes = 0;
    for (const item of candidates) {
      if (selected.length > 0 && selectedBytes + item.byteLength > SYNC_SNAPSHOT_PAGE_BYTE_LIMIT) break;
      selected.push(item);
      selectedBytes += item.byteLength;
    }
    const lastSequence = selected.at(-1)?.sequence ?? after;
    const hasMore = snapshot.items.some((item) => item.sequence > lastSequence);
    return {
      snapshotId,
      workId: snapshot.workId,
      cutoffCursor: snapshot.cutoffCursor,
      after,
      nextAfter: hasMore ? lastSequence : null,
      hasMore,
      items: selected.map(({ byteLength: _byteLength, ...item }) => item)
    };
  }

  deleteSnapshot(snapshotId: string, userId: string): void {
    this.ownedSnapshot(snapshotId, userId);
    this.snapshots.delete(snapshotId);
  }

  listChanges(workId: string, after: number, limit: number): SyncChangePage {
    return this.database.transaction(() => {
      this.assertOfflineAccessEnabled(workId);
      const rows = this.database.all(
        `SELECT cursor, entity_type, entity_id, operation, version_no, changed_by_user_id, changed_at
         FROM sync_changes WHERE work_id = ? AND cursor > ? ORDER BY cursor LIMIT ?`,
        workId,
        after,
        limit + 1
      );
      const hasMore = rows.length > limit;
      const pageRows = rows.slice(0, limit);
      const items = pageRows.map((row) => this.mapChange(row));
      const latestCursor = Number(this.database.get(
        "SELECT COALESCE(MAX(cursor), 0) AS cursor FROM sync_changes WHERE work_id = ?",
        workId
      )?.cursor ?? 0);
      return {
        workId,
        after,
        nextCursor: items.at(-1)?.cursor ?? after,
        latestCursor,
        hasMore,
        items
      };
    });
  }

  pushMutations(
    workId: string,
    userId: string,
    clientId: string,
    mutations: SyncMutation[]
  ): SyncPushResult {
    this.assertOfflineAccessEnabled(workId);
    const results = mutations.map((mutation) => this.processMutation(workId, userId, clientId, mutation));
    return {
      clientId,
      results,
      summary: {
        applied: results.filter((result) => result.status === "applied").length,
        conflict: results.filter((result) => result.status === "conflict").length,
        rejected: results.filter((result) => result.status === "rejected").length,
        replayed: results.filter((result) => result.replayed).length
      }
    };
  }

  getMutationResult(workId: string, userId: string, mutationId: string): SyncMutationResult {
    this.assertOfflineAccessEnabled(workId);
    const row = this.database.get(
      `SELECT result_json FROM sync_mutation_results
       WHERE mutation_id = ? AND work_id = ? AND user_id = ?`,
      mutationId,
      workId,
      userId
    );
    if (!row) throw new AppError(404, "SYNC_MUTATION_NOT_FOUND", "同步变更结果不存在");
    return this.parseMutationResult(String(row.result_json));
  }

  dispose(): void {
    this.snapshots.clear();
  }

  private ownedSnapshot(snapshotId: string, userId: string): StoredSyncSnapshot {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot || snapshot.userId !== userId) {
      throw new AppError(404, "SYNC_SNAPSHOT_NOT_FOUND", "同步快照不存在");
    }
    if (snapshot.expiresAtMs <= this.now()) {
      this.snapshots.delete(snapshotId);
      throw new AppError(410, "SYNC_SNAPSHOT_EXPIRED", "同步快照已过期，请重新创建");
    }
    return snapshot;
  }

  private assertOfflineAccessEnabled(workId: string): void {
    const work = this.database.get("SELECT offline_access_enabled FROM works WHERE id = ? AND deleted_at IS NULL", workId);
    if (!work) throw new AppError(404, "WORK_NOT_FOUND", "作品不存在");
    if (Number(work.offline_access_enabled) !== 1) {
      throw new AppError(403, "OFFLINE_ACCESS_DISABLED", "作品所有者尚未允许 Desktop 离线访问");
    }
  }

  private mapChange(row: Record<string, unknown>): SyncChangeItem {
    const entityType = String(row.entity_type) === "setting" ? "setting" : "chapter";
    const operation = String(row.operation) === "delete" ? "delete" : "upsert";
    const entityId = String(row.entity_id);
    const versionNo = Number(row.version_no);
    return {
      cursor: Number(row.cursor),
      entityType,
      entityId,
      operation,
      versionNo,
      changedByUserId: row.changed_by_user_id === null || row.changed_by_user_id === undefined
        ? null
        : String(row.changed_by_user_id),
      changedAt: String(row.changed_at),
      data: operation === "delete" ? null : entityType === "chapter"
        ? this.chapterVersionData(entityId, versionNo)
        : this.settingVersionData(entityId, versionNo)
    };
  }

  private processMutation(
    workId: string,
    userId: string,
    clientId: string,
    mutation: SyncMutation
  ): SyncMutationResult {
    const requestHash = createHash("sha256")
      .update(stableJson({ workId, userId, clientId, mutation }))
      .digest("hex");
    return this.database.transaction(() => {
      const existing = this.database.get(
        "SELECT request_hash, result_json FROM sync_mutation_results WHERE mutation_id = ?",
        mutation.mutationId
      );
      if (existing) {
        if (String(existing.request_hash) !== requestHash) {
          throw new AppError(409, "MUTATION_ID_REUSED", "mutationId 已用于不同的同步请求");
        }
        return { ...this.parseMutationResult(String(existing.result_json)), replayed: true };
      }
      const result = this.applyMutation(workId, mutation);
      const timestamp = new Date(this.now()).toISOString();
      this.database.run(
        `INSERT INTO sync_mutation_results (
           mutation_id, client_id, user_id, work_id, request_hash, status, applied_version_no,
           conflict_version_no, error_code, result_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        mutation.mutationId,
        clientId,
        userId,
        workId,
        requestHash,
        result.status,
        result.appliedVersionNo,
        result.conflictVersionNo,
        result.errorCode,
        JSON.stringify(result),
        timestamp,
        timestamp
      );
      return result;
    });
  }

  private applyMutation(workId: string, mutation: SyncMutation): SyncMutationResult {
    const state = this.currentMutationEntityState(mutation.entityType, mutation.entityId);
    if (!state) return this.rejectedMutation(mutation, "SYNC_ENTITY_NOT_FOUND");
    if (state.workId !== workId) return this.rejectedMutation(mutation, "SYNC_ENTITY_NOT_FOUND");
    const baseSnapshot = this.mutationVersionData(mutation.entityType, mutation.entityId, mutation.baseVersionNo);
    const serverSnapshot = state.active
      ? this.mutationVersionData(mutation.entityType, mutation.entityId, state.versionNo)
      : { id: mutation.entityId, workId, versionNo: state.versionNo, deleted: true };
    if (!baseSnapshot) {
      return this.rejectedMutation(mutation, "SYNC_BASE_VERSION_MISSING", null, serverSnapshot);
    }
    const localSnapshot = { ...baseSnapshot, ...mutation.localSnapshot, versionNo: mutation.baseVersionNo };
    if (!state.active || state.versionNo !== mutation.baseVersionNo) {
      return {
        mutationId: mutation.mutationId,
        entityType: mutation.entityType,
        entityId: mutation.entityId,
        status: "conflict",
        baseVersionNo: mutation.baseVersionNo,
        appliedVersionNo: null,
        conflictVersionNo: state.versionNo,
        errorCode: "VERSION_CONFLICT",
        baseSnapshot,
        localSnapshot,
        serverSnapshot,
        replayed: false
      };
    }
    try {
      const updated = mutation.entityType === "chapter"
        ? this.store.saveChapter(
          mutation.entityId,
          mutation.localSnapshot,
          "desktop-sync",
          mutation.mutationId,
          mutation.changeNote,
          mutation.baseVersionNo
        )
        : this.store.updateSetting(
          mutation.entityId,
          mutation.localSnapshot,
          "desktop-sync",
          mutation.mutationId,
          mutation.changeNote,
          mutation.baseVersionNo
        );
      return {
        mutationId: mutation.mutationId,
        entityType: mutation.entityType,
        entityId: mutation.entityId,
        status: "applied",
        baseVersionNo: mutation.baseVersionNo,
        appliedVersionNo: Number(updated.versionNo),
        conflictVersionNo: null,
        errorCode: null,
        baseSnapshot,
        localSnapshot,
        serverSnapshot: updated,
        replayed: false
      };
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      const latest = this.currentMutationEntityState(mutation.entityType, mutation.entityId);
      if (error.code === "VERSION_CONFLICT" && latest) {
        return {
          mutationId: mutation.mutationId,
          entityType: mutation.entityType,
          entityId: mutation.entityId,
          status: "conflict",
          baseVersionNo: mutation.baseVersionNo,
          appliedVersionNo: null,
          conflictVersionNo: latest.versionNo,
          errorCode: error.code,
          baseSnapshot,
          localSnapshot,
          serverSnapshot: latest.active
            ? this.mutationVersionData(mutation.entityType, mutation.entityId, latest.versionNo)
            : { id: mutation.entityId, workId, versionNo: latest.versionNo, deleted: true },
          replayed: false
        };
      }
      return this.rejectedMutation(mutation, error.code, baseSnapshot, serverSnapshot, localSnapshot);
    }
  }

  private rejectedMutation(
    mutation: SyncMutation,
    errorCode: string,
    baseSnapshot: Record<string, unknown> | null = null,
    serverSnapshot: Record<string, unknown> | null = null,
    localSnapshot: Record<string, unknown> | null = null
  ): SyncMutationResult {
    return {
      mutationId: mutation.mutationId,
      entityType: mutation.entityType,
      entityId: mutation.entityId,
      status: "rejected",
      baseVersionNo: mutation.baseVersionNo,
      appliedVersionNo: null,
      conflictVersionNo: null,
      errorCode,
      baseSnapshot,
      localSnapshot,
      serverSnapshot,
      replayed: false
    };
  }

  private currentMutationEntityState(
    entityType: "chapter" | "setting",
    entityId: string
  ): { workId: string; versionNo: number; active: boolean } | null {
    if (entityType === "chapter") {
      const chapter = this.database.get(
        "SELECT work_id, version_no, deleted_at FROM chapters WHERE id = ?",
        entityId
      );
      if (chapter) {
        return {
          workId: String(chapter.work_id),
          versionNo: Number(chapter.version_no),
          active: chapter.deleted_at === null || chapter.deleted_at === undefined
        };
      }
      const version = this.database.get(
        "SELECT work_id, MAX(version_no) AS version_no FROM chapter_versions WHERE chapter_id = ?",
        entityId
      );
      return version?.work_id
        ? { workId: String(version.work_id), versionNo: Number(version.version_no), active: false }
        : null;
    }
    const setting = this.database.get("SELECT work_id FROM settings WHERE id = ?", entityId);
    const version = this.database.get(
      `SELECT work_id, MAX(version_no) AS version_no FROM entity_versions
       WHERE entity_type = 'setting' AND entity_id = ?`,
      entityId
    );
    if (!version?.work_id) return null;
    return {
      workId: String(version.work_id),
      versionNo: Number(version.version_no),
      active: Boolean(setting)
    };
  }

  private mutationVersionData(
    entityType: "chapter" | "setting",
    entityId: string,
    versionNo: number
  ): Record<string, unknown> | null {
    try {
      return entityType === "chapter"
        ? this.chapterVersionData(entityId, versionNo)
        : this.settingVersionData(entityId, versionNo);
    } catch (error) {
      if (error instanceof AppError && error.code === "SYNC_CHANGE_HISTORY_MISSING") return null;
      throw error;
    }
  }

  private parseMutationResult(value: string): SyncMutationResult {
    try {
      const parsed = JSON.parse(value) as Partial<SyncMutationResult>;
      if (!parsed || typeof parsed !== "object" || !parsed.mutationId || !parsed.entityId) throw new Error("Invalid mutation result");
      if (!(["applied", "conflict", "rejected"] as const).includes(parsed.status as SyncMutationResult["status"])) {
        throw new Error("Invalid mutation status");
      }
      return { ...parsed, replayed: false } as SyncMutationResult;
    } catch {
      throw new AppError(500, "SYNC_MUTATION_RESULT_INVALID", "同步变更结果无法解析");
    }
  }

  private chapterVersionData(chapterId: string, versionNo: number): Record<string, unknown> {
    const version = this.database.get(
      `SELECT work_id, chapter_id, version_no, title, content, volume_id, sort_order, chapter_type, created_at
       FROM chapter_versions WHERE chapter_id = ? AND version_no = ?`,
      chapterId,
      versionNo
    );
    if (!version) {
      throw new AppError(500, "SYNC_CHANGE_HISTORY_MISSING", "章节同步历史不完整，请重新下载离线副本");
    }
    const content = String(version.content);
    return {
      id: String(version.chapter_id),
      workId: String(version.work_id),
      volumeId: version.volume_id === null || version.volume_id === undefined ? null : String(version.volume_id),
      title: String(version.title),
      content,
      chapterType: String(version.chapter_type ?? "正文"),
      sortOrder: version.sort_order === null || version.sort_order === undefined ? null : Number(version.sort_order),
      wordCount: countWords(content),
      versionNo: Number(version.version_no),
      updatedAt: String(version.created_at)
    };
  }

  private settingVersionData(settingId: string, versionNo: number): Record<string, unknown> {
    const version = this.database.get(
      `SELECT work_id, entity_id, version_no, snapshot_json, created_at
       FROM entity_versions WHERE entity_type = 'setting' AND entity_id = ? AND version_no = ?`,
      settingId,
      versionNo
    );
    if (!version) {
      throw new AppError(500, "SYNC_CHANGE_HISTORY_MISSING", "设定同步历史不完整，请重新下载离线副本");
    }
    let snapshot: Record<string, unknown>;
    try {
      const parsed = JSON.parse(String(version.snapshot_json)) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid setting snapshot");
      snapshot = parsed as Record<string, unknown>;
    } catch {
      throw new AppError(500, "SYNC_CHANGE_HISTORY_INVALID", "设定同步历史无法解析，请重新下载离线副本");
    }
    return {
      id: String(version.entity_id),
      workId: String(version.work_id),
      ...snapshot,
      versionNo: Number(version.version_no),
      updatedAt: String(version.created_at)
    };
  }

  private pruneExpired(timestamp: number): void {
    for (const [snapshotId, snapshot] of this.snapshots) {
      if (snapshot.expiresAtMs <= timestamp) this.snapshots.delete(snapshotId);
    }
  }

  private descriptor(snapshot: StoredSyncSnapshot): SyncSnapshotDescriptor {
    return {
      snapshotId: snapshot.snapshotId,
      workId: snapshot.workId,
      cutoffCursor: snapshot.cutoffCursor,
      itemCount: snapshot.itemCount,
      expiresAt: snapshot.expiresAt,
      syncProtocol: 1
    };
  }
}
