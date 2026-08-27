import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

describe("工作台资源压缩", () => {
  let runtime: Runtime;

  beforeAll(() => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "ui-response-compression-test-secret",
      disableUserAuth: true,
      serveUi: true
    });
  });

  afterAll(() => runtime.close());

  it("压缩页面和大型静态资源但不缓冲 API 响应", async () => {
    const page = await request(runtime.app)
      .get("/")
      .set("Accept-Encoding", "gzip")
      .expect(200);
    const application = await request(runtime.app)
      .get("/app.js?v=mobile-performance")
      .set("Accept-Encoding", "gzip")
      .expect(200);
    const styles = await request(runtime.app)
      .get("/styles.css?v=mobile-performance")
      .set("Accept-Encoding", "gzip")
      .expect(200);
    const vendor = await request(runtime.app)
      .get("/vendor/vditor/dist/index.min.js?v=3.11.2")
      .set("Accept-Encoding", "gzip")
      .expect(200);
    const health = await request(runtime.app)
      .get("/api/health")
      .set("Accept-Encoding", "gzip")
      .expect(200);

    expect(page.headers["content-encoding"]).toBe("gzip");
    expect(application.headers["content-encoding"]).toBe("gzip");
    expect(styles.headers["content-encoding"]).toBe("gzip");
    expect(vendor.headers["content-encoding"]).toBe("gzip");
    expect(application.headers.vary).toContain("Accept-Encoding");
    expect(health.headers["content-encoding"]).toBeUndefined();
    expect(health.body.data.status).toBe("ok");
  });
});
