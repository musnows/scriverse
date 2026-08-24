import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Database } from "../../src/database.js";
import {
  claimServerDataDirectory,
  SERVER_STORAGE_KIND,
  STORAGE_MANIFEST_FILENAME,
  StorageManifestError
} from "../../src/storage-manifest.js";

function testDirectory(label: string): string {
  return join(tmpdir(), `scriverse-storage-manifest-${label}-${process.pid}-${crypto.randomUUID()}`);
}

describe("Server 存储清单", () => {
  it("为全新数据目录写入稳定的 Server 标识", () => {
    const root = testDirectory("fresh");
    const first = claimServerDataDirectory(root, join(root, "novel.db"));
    const second = claimServerDataDirectory(root, join(root, "novel.db"));
    expect(first).toEqual(second);
    expect(first.kind).toBe(SERVER_STORAGE_KIND);
    expect(existsSync(join(root, STORAGE_MANIFEST_FILENAME))).toBe(true);
    if (process.platform !== "win32") {
      expect((readFileSync(join(root, STORAGE_MANIFEST_FILENAME)).byteLength)).toBeGreaterThan(0);
    }
  });

  it("只认领可验证的既有 Scriverse 数据库", () => {
    const validRoot = testDirectory("valid-existing");
    mkdirSync(validRoot, { recursive: true });
    const database = new Database(join(validRoot, "novel.db"));
    database.close();
    expect(claimServerDataDirectory(validRoot, join(validRoot, "novel.db")).kind).toBe(SERVER_STORAGE_KIND);

    const unknownRoot = testDirectory("unknown-existing");
    mkdirSync(unknownRoot, { recursive: true });
    const unknown = new DatabaseSync(join(unknownRoot, "novel.db"));
    unknown.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)");
    unknown.close();
    expect(() => claimServerDataDirectory(unknownRoot, join(unknownRoot, "novel.db"))).toThrowError(StorageManifestError);
  });

  it("拒绝 Desktop 清单和未认领的非空目录", () => {
    const desktopRoot = testDirectory("desktop-kind");
    mkdirSync(desktopRoot, { recursive: true });
    writeFileSync(join(desktopRoot, STORAGE_MANIFEST_FILENAME), JSON.stringify({
      kind: "scriverse-desktop-local-vault",
      storageVersion: 1,
      desktopId: crypto.randomUUID(),
      createdAt: new Date().toISOString()
    }));
    expect(() => claimServerDataDirectory(desktopRoot, join(desktopRoot, "novel.db"))).toThrowError(/不属于 Scriverse Server/u);

    const nonemptyRoot = testDirectory("nonempty");
    mkdirSync(nonemptyRoot, { recursive: true });
    writeFileSync(join(nonemptyRoot, "master.key"), "not-a-real-key");
    expect(() => claimServerDataDirectory(nonemptyRoot, join(nonemptyRoot, "novel.db"))).toThrowError(/非空目录/u);
  });
});
