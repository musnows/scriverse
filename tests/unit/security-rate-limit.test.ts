import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  createApiRateLimitMiddleware,
  createAuthenticationRateLimitMiddleware,
  createCaptchaRateLimitMiddleware,
  createExpensiveApiRateLimitMiddleware,
  createUploadRateLimitMiddleware,
  enforceCaseInsensitiveRouting,
  normalizeApiPath,
  resolveTrustProxySetting
} from "../../src/security.js";

describe("安全限速器", () => {
  it("达到来源状态上限后淘汰最早条目", async () => {
    const app = express();
    app.set("trust proxy", 1);
    app.use(createApiRateLimitMiddleware(1, 60_000, 2));
    app.get("/api/test", (_request, response) => response.json({ ok: true }));
    const agent = request.agent(app);

    await agent.get("/api/test").set("X-Forwarded-For", "192.0.2.1").expect(200);
    await agent.get("/api/test").set("X-Forwarded-For", "192.0.2.1").expect(429);
    await agent.get("/api/test").set("X-Forwarded-For", "192.0.2.2").expect(200);
    await agent.get("/api/test").set("X-Forwarded-For", "192.0.2.3").expect(200);
    await agent.get("/api/test").set("X-Forwarded-For", "192.0.2.1").expect(200);
  });

  it("未启用 trust proxy 时忽略可伪造的 X-Forwarded-For", async () => {
    const app = express();
    app.use(createApiRateLimitMiddleware(1, 60_000));
    app.get("/api/test", (_request, response) => response.json({ ok: true }));
    const agent = request.agent(app);

    await agent.get("/api/test").set("X-Forwarded-For", "198.51.100.1").expect(200);
    const blocked = await agent.get("/api/test").set("X-Forwarded-For", "198.51.100.2").expect(429);
    expect(blocked.body.error.code).toBe("API_RATE_LIMITED");
  });

  it("对高成本上传路由应用独立限额", async () => {
    const app = express();
    app.use(createUploadRateLimitMiddleware(1, 60_000, 10));
    app.all("/{*path}", (_request, response) => response.json({ ok: true }));
    const agent = request.agent(app);

    await agent.post("/api/works/import").expect(200);
    const blocked = await agent.put("/api/auth/avatar").expect(429);
    expect(blocked.body.error.code).toBe("UPLOAD_RATE_LIMITED");
    expect(blocked.headers["retry-after"]).toBe("60");
    await agent.post("/api/works").expect(200);
  });

  it("对验证码与昂贵接口应用独立限额", async () => {
    const captchaApp = express();
    captchaApp.use(createCaptchaRateLimitMiddleware(1, 60_000));
    captchaApp.all("/{*path}", (_request, response) => response.json({ ok: true }));
    const captchaAgent = request.agent(captchaApp);
    await captchaAgent.get("/api/auth/captcha").expect(200);
    const blockedCaptcha = await captchaAgent.get("/API/AUTH/CAPTCHA").expect(429);
    expect(blockedCaptcha.body.error.code).toBe("CAPTCHA_RATE_LIMITED");

    const expensiveApp = express();
    expensiveApp.use((request, _response, next) => {
      request.authUser = { userId: "user_expensive" } as typeof request.authUser;
      next();
    });
    expensiveApp.use(createExpensiveApiRateLimitMiddleware(60_000));
    expensiveApp.get("/api/ai-conversations/:conversationId/export", (_request, response) => response.json({ ok: true }));
    expensiveApp.all("/{*path}", (_request, response) => response.json({ ok: true }));
    const expensiveAgent = request.agent(expensiveApp);

    await expensiveAgent.post("/api/works/work_1/chat/stream").expect(200);
    for (let index = 0; index < 26; index += 1) {
      await expensiveAgent.post("/api/works/work_1/suggestions").expect(200);
    }
    await expensiveAgent.post("/api/providers/provider_1/test").expect(200);
    await expensiveAgent.post("/api/models/model_1/test").expect(200);
    await expensiveAgent.post("/api/providers/provider_1/models/import").expect(200);
    const blockedAi = await expensiveAgent.post("/API/WORKS/work_1/TASKS").expect(429);
    expect(blockedAi.body.error.code).toBe("EXPENSIVE_API_RATE_LIMITED");
    await expensiveAgent.post("/api/tasks/task_1/run").expect(429);
    await expensiveAgent.post("/api/tasks/task_1/rerun").expect(429);

    await expensiveAgent.get("/api/ai-conversations/conversation_1/export").expect(200);
    await expensiveAgent.get("/api/volumes/volume_1/export").expect(200);
    for (let index = 0; index < 8; index += 1) {
      await expensiveAgent.get("/api/works/work_1/export").expect(200);
    }
    const blockedExport = await expensiveAgent.get("/api/works/work_1/export").expect(429);
    expect(blockedExport.body.error.code).toBe("EXPENSIVE_API_RATE_LIMITED");

    const imApp = express();
    imApp.use((request, _response, next) => {
      request.authUser = { userId: "user_im_expensive" } as typeof request.authUser;
      next();
    });
    imApp.use(createExpensiveApiRateLimitMiddleware(60_000));
    imApp.all("/{*path}", (_request, response) => response.json({ ok: true }));
    const imAgent = request.agent(imApp);
    for (let index = 0; index < 15; index += 1) {
      await imAgent.post("/api/im/conversations/group_1/messages/").expect(200);
      await imAgent.post(`/api/im/conversations/group_1/chains/chain_${index}/retry/`).expect(200);
    }
    const blockedIm = await imAgent.post("/api/im/conversations/group_1/messages/").expect(429);
    expect(blockedIm.body.error.code).toBe("EXPENSIVE_API_RATE_LIMITED");
  });

  it("API 路径匹配忽略大小写，避免大小写变体绕过限速", async () => {
    const apiApp = express();
    enforceCaseInsensitiveRouting(apiApp);
    apiApp.use(createApiRateLimitMiddleware(1, 60_000));
    apiApp.all("/{*path}", (_request, response) => response.json({ ok: true }));
    const apiAgent = request.agent(apiApp);

    await apiAgent.get("/api/works/demo").expect(200);
    await apiAgent.get("/API/WORKS/demo").expect(429);

    const authApp = express();
    enforceCaseInsensitiveRouting(authApp);
    authApp.use(createAuthenticationRateLimitMiddleware(1, 60_000));
    authApp.all("/{*path}", (_request, response) => response.json({ ok: true }));
    const authAgent = request.agent(authApp);

    await authAgent.post("/api/auth/login").expect(200);
    const blockedLogin = await authAgent.post("/API/AUTH/LOGIN").expect(429);
    expect(blockedLogin.body.error.code).toBe("AUTH_RATE_LIMITED");
    await authAgent.post("/api/desktop/auth/login").expect(200);
    const blockedDesktopLogin = await authAgent.post("/API/DESKTOP/AUTH/LOGIN").expect(429);
    expect(blockedDesktopLogin.body.error.code).toBe("AUTH_RATE_LIMITED");
  });
});

describe("API 路径规范化", () => {
  it("将路径规范为小写供安全匹配使用", () => {
    expect(normalizeApiPath("/API/WORKS/abc")).toBe("/api/works/abc");
    expect(normalizeApiPath("/api/Users/Directory")).toBe("/api/users/directory");
  });

  it("强制保持大小写不敏感路由并拒绝开启", () => {
    const app = express();
    enforceCaseInsensitiveRouting(app);
    expect(app.get("case sensitive routing")).toBe(false);
    expect(() => app.set("case sensitive routing", true)).toThrow(/Case-sensitive routing is disabled/u);
    expect(app.get("case sensitive routing")).toBe(false);
    app.set("case sensitive routing", false);
    expect(app.get("case sensitive routing")).toBe(false);
  });
});

describe("trust proxy 解析", () => {
  it("将 trust proxy=true 收敛为单跳", () => {
    expect(resolveTrustProxySetting(true)).toBe(1);
    expect(resolveTrustProxySetting(2)).toBe(2);
    expect(resolveTrustProxySetting(false)).toBe(false);
    expect(resolveTrustProxySetting(undefined)).toBeUndefined();
  });
});
