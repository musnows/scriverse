import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readDatabaseSchemaVersion } from "./database.js";

export const STORAGE_MANIFEST_FILENAME = "storage-manifest.json";
export const SERVER_STORAGE_KIND = "scriverse-server-data";
export const STORAGE_MANIFEST_VERSION = 1;

export type ServerStorageManifest = {
  kind: typeof SERVER_STORAGE_KIND;
  storageVersion: typeof STORAGE_MANIFEST_VERSION;
  serverId: string;
  createdAt: string;
};

export class StorageManifestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "StorageManifestError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new StorageManifestError("STORAGE_MANIFEST_INVALID", `存储清单的 ${field} 无效`);
  }
  return value;
}

function assertCreatedAt(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new StorageManifestError("STORAGE_MANIFEST_INVALID", "存储清单的 createdAt 无效");
  }
  return value;
}

export function parseServerStorageManifest(value: unknown): ServerStorageManifest {
  if (!isRecord(value)) throw new StorageManifestError("STORAGE_MANIFEST_INVALID", "存储清单格式无效");
  if (value.kind !== SERVER_STORAGE_KIND) {
    throw new StorageManifestError("STORAGE_KIND_MISMATCH", "该目录不属于 Scriverse Server，已拒绝打开");
  }
  if (value.storageVersion !== STORAGE_MANIFEST_VERSION) {
    throw new StorageManifestError("STORAGE_VERSION_UNSUPPORTED", "该存储目录版本暂不受当前 Scriverse Server 支持");
  }
  return {
    kind: SERVER_STORAGE_KIND,
    storageVersion: STORAGE_MANIFEST_VERSION,
    serverId: assertUuid(value.serverId, "serverId"),
    createdAt: assertCreatedAt(value.createdAt)
  };
}

function syncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function writeJsonAtomically(path: string, value: unknown): void {
  const directory = join(path, "..");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const descriptor = openSync(temporaryPath, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, path);
  chmodSync(path, 0o600);
  syncDirectory(directory);
}

export function readServerStorageManifest(dataDirectory: string): ServerStorageManifest | null {
  const path = join(dataDirectory, STORAGE_MANIFEST_FILENAME);
  if (!existsSync(path)) return null;
  try {
    return parseServerStorageManifest(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch (error) {
    if (error instanceof StorageManifestError) throw error;
    throw new StorageManifestError("STORAGE_MANIFEST_INVALID", "存储清单无法读取或不是有效 JSON");
  }
}

export function claimServerDataDirectory(dataDirectory: string, databasePath: string): ServerStorageManifest {
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  chmodSync(dataDirectory, 0o700);
  const existing = readServerStorageManifest(dataDirectory);
  if (existing) return existing;

  if (existsSync(databasePath)) {
    const schemaVersion = readDatabaseSchemaVersion(databasePath);
    if (schemaVersion === null || schemaVersion < 1) {
      throw new StorageManifestError("STORAGE_DIRECTORY_UNCLAIMED", "现有数据库无法确认属于 Scriverse Server，已拒绝认领");
    }
  } else {
    const entries = readdirSync(dataDirectory).filter((entry) => !entry.startsWith(`${STORAGE_MANIFEST_FILENAME}.tmp-`));
    if (entries.length > 0) {
      throw new StorageManifestError("STORAGE_DIRECTORY_UNCLAIMED", "非空目录缺少可验证的 Scriverse Server 数据库，已拒绝认领");
    }
  }

  const manifest: ServerStorageManifest = {
    kind: SERVER_STORAGE_KIND,
    storageVersion: STORAGE_MANIFEST_VERSION,
    serverId: randomUUID(),
    createdAt: new Date().toISOString()
  };
  writeJsonAtomically(join(dataDirectory, STORAGE_MANIFEST_FILENAME), manifest);
  return manifest;
}
