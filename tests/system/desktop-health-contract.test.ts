import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";
import {
  DESKTOP_MINIMUM_VERSION,
  DESKTOP_PRODUCT_ID,
  DESKTOP_SHELL_PROTOCOL,
  DESKTOP_SYNC_PROTOCOL
} from "../../src/desktop-protocol.js";
import { APP_VERSION } from "../../src/version.js";

describe("Desktop Server 兼容元数据", () => {
  let runtime: Runtime | null = null;

  afterEach(() => runtime?.close());

  it("在 health 中发布稳定 shell 与 sync 协议范围", async () => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "desktop-health-contract-test-secret-with-enough-length",
      serveUi: false,
      disableUserAuth: true
    });
    const health = await request(runtime.app).get("/api/health").expect(200);
    expect(health.body.data).toMatchObject({
      product: DESKTOP_PRODUCT_ID,
      serverVersion: APP_VERSION,
      webAssetVersion: APP_VERSION,
      shellProtocol: DESKTOP_SHELL_PROTOCOL,
      minimumDesktopVersion: DESKTOP_MINIMUM_VERSION,
      syncProtocol: DESKTOP_SYNC_PROTOCOL
    });
    expect(health.body.data.syncProtocol.entityTypes).toEqual(["chapter", "setting"]);
    expect(health.body.data.syncProtocol.maxMutationBytes).toBe(2_500_000);
    expect(health.body.data.minimumDesktopVersion).toBe("0.0.1");
  });
});
