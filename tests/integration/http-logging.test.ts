import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createRequestLoggingMiddleware } from "../../src/http-logging.js";
import { accountReference, createLogger, type LogRecord } from "../../src/logger.js";

describe("HTTP 请求日志", () => {
  it("记录请求进入和完成状态，同时隐藏账户路径、查询令牌和认证头", async () => {
    const records: LogRecord[] = [];
    const log = createLogger({ level: "debug", write: (_level, record) => records.push(record) });
    const app = express();
    app.use(createRequestLoggingMiddleware(log));
    app.get("/api/users/:userId", (incoming, response) => {
      incoming.authMethod = "session";
      incoming.authUser = {
        userId: "private-authenticated-user-id",
        username: "private-authenticated-username",
        displayName: "private-authenticated-name",
        role: "user",
        status: "active",
        createdAt: "2026-07-19T00:00:00.000Z",
        avatarUrl: null,
        onboardingCompleted: false,
        isSystemAdmin: false
      };
      response.status(200).json({ data: { ok: true } });
    });

    const response = await request(app)
      .get("/api/users/private-account-id?token=private-query-token")
      .set("Authorization", "Bearer private-bearer-token")
      .set("Cookie", "scriverse_session=private-session-token");

    expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(records.map((record) => record.event)).toEqual(["http.request.started", "http.request.completed"]);
    expect(records[0]?.requestId).toBe(response.headers["x-request-id"]);
    expect(records[1]?.requestId).toBe(response.headers["x-request-id"]);
    expect(records[0]).toMatchObject({ method: "GET", path: "/api/users/[REDACTED]" });
    expect(records[1]).toMatchObject({
      method: "GET",
      route: "/api/users/:userId",
      status: 200,
      authMethod: "session",
      actorRef: accountReference("private-authenticated-user-id")
    });

    const serialized = JSON.stringify(records);
    for (const secret of ["private-account-id", "private-query-token", "private-bearer-token", "private-session-token", "private-authenticated-user-id", "private-authenticated-username", "private-authenticated-name"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("隐藏作品成员路由中的账户 ID", async () => {
    const records: LogRecord[] = [];
    const log = createLogger({ level: "debug", write: (_level, record) => records.push(record) });
    const app = express();
    app.use(createRequestLoggingMiddleware(log));
    app.delete("/api/works/:workId/members/:userId", (_request, response) => response.status(204).end());

    await request(app).delete("/api/works/work-1/members/private-member-id").expect(204);

    expect(records[0]).toMatchObject({ path: "/api/works/work-1/members/[REDACTED]" });
    expect(JSON.stringify(records)).not.toContain("private-member-id");
  });

  it("默认 info 级别不记录正常请求生命周期", async () => {
    const records: LogRecord[] = [];
    const log = createLogger({ level: "info", write: (_level, record) => records.push(record) });
    const app = express();
    app.use(createRequestLoggingMiddleware(log));
    app.get("/api/health", (_request, response) => response.status(200).json({ data: { ok: true } }));

    await request(app).get("/api/health").expect(200);

    expect(records).toEqual([]);
  });
});
