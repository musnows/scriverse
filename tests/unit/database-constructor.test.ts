import { describe, expect, it, vi } from "vitest";

const databaseSync = vi.hoisted(() => ({
  close: vi.fn(),
  exec: vi.fn()
}));

vi.mock("node:sqlite", () => ({
  DatabaseSync: class {
    close = databaseSync.close;
    exec = databaseSync.exec;
  }
}));

import { Database } from "../../src/database.js";

describe("Database", () => {
  it("初始化失败时关闭已打开的连接并保留原始错误", () => {
    const initializationError = new Error("initialization failed");
    const closeError = new Error("close failed");
    databaseSync.exec.mockImplementation(() => {
      throw initializationError;
    });
    databaseSync.close.mockImplementation(() => {
      throw closeError;
    });

    expect(() => new Database(":memory:")).toThrow(initializationError);
    expect(databaseSync.close).toHaveBeenCalledTimes(1);
  });
});
