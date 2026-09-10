import { describe, expect, it } from "vitest";
import { publicAiStreamError } from "../../src/app.js";
import { AppError } from "../../src/errors.js";

describe("publicAiStreamError", () => {
  it("保留 AppError 的公开错误码与文案", () => {
    expect(publicAiStreamError(new AppError(400, "MODEL_REQUIRED", "请选择模型", {
      failure: "missing_model",
      callId: "call_1",
      providerName: "demo",
      providerId: "provider_1",
      modelId: "gpt-test",
      modelRecordId: "model_1"
    }))).toEqual({
      code: "MODEL_REQUIRED",
      message: "请选择模型",
      status: 400,
      failure: "missing_model",
      callId: "call_1",
      providerName: "demo",
      providerId: "provider_1",
      modelId: "gpt-test",
      modelRecordId: "model_1"
    });
  });

  it("对内部 Error 使用通用文案，不透传原始 message", () => {
    expect(publicAiStreamError(new Error("ENOENT: /secret/path.sql failed at https://provider.example/v1"))).toEqual({
      code: "AI_STREAM_FAILED",
      message: "AI 流式调用失败"
    });
  });

  it("向客户端透传已脱敏的 AI 上游失败详情", () => {
    expect(publicAiStreamError(new AppError(502, "AI_CALL_FAILED", "AI 调用失败", {
      failureOrigin: "provider",
      failure: "ENOENT: /secret/path.sql failed at https://provider.example/v1",
      callId: "call_secret",
      providerId: "provider_1"
    }))).toEqual({
      code: "AI_CALL_FAILED",
      message: "AI 调用失败",
      status: 502,
      failureOrigin: "provider",
      failure: "ENOENT: /secret/path.sql failed at https://provider.example/v1",
      callId: "call_secret",
      providerId: "provider_1"
    });
  });

  it("向客户端公开叙界平台响应保护来源", () => {
    expect(publicAiStreamError(new AppError(502, "AI_RESPONSE_TOO_LARGE", "AI 供应商响应超过 20971520 字节上限", {
      failureOrigin: "platform",
      callId: "call_limit",
      providerName: "demo",
      providerId: "provider_1",
      modelId: "gpt-test"
    }))).toEqual({
      code: "AI_RESPONSE_TOO_LARGE",
      message: "AI 供应商响应超过 20971520 字节上限",
      status: 502,
      failureOrigin: "platform",
      callId: "call_limit",
      providerName: "demo",
      providerId: "provider_1",
      modelId: "gpt-test"
    });
  });

  it("仍然隐藏非 AI 调用的内部 5xx 详情", () => {
    expect(publicAiStreamError(new AppError(500, "INTERNAL_ERROR", "服务器内部错误", {
      failure: "内部数据库路径和堆栈"
    }))).toEqual({
      code: "INTERNAL_ERROR",
      message: "服务器内部错误",
      status: 500
    });
  });

  it("向客户端公开流空闲超时阶段与实际秒数", () => {
    expect(publicAiStreamError(new AppError(504, "AI_STREAM_IDLE_TIMEOUT", "AI 流已关闭", {
      callId: "call_timeout",
      phase: "between_events",
      idleTimeoutSeconds: 30
    }))).toEqual({
      code: "AI_STREAM_IDLE_TIMEOUT",
      message: "AI 流已关闭",
      status: 504,
      callId: "call_timeout",
      phase: "between_events",
      idleTimeoutSeconds: 30
    });
  });

  it("向客户端公开叙界平台 Token 额度限制来源", () => {
    expect(publicAiStreamError(new AppError(429, "PROVIDER_MONTHLY_TOKEN_QUOTA_EXCEEDED", "叙界平台限制了后续 Token 使用：配置的供应商“demo”额度已达到每月 Token 额度", {
      platformLimited: true,
      limitScope: "provider",
      limitPeriod: "monthly",
      providerId: "provider_1",
      providerName: "demo",
      monthlyTokenQuota: 10_000,
      usedTokens: 10_000,
      remainingTokens: 0,
      resetsAt: "2026-09-01T00:00:00.000Z",
      timezone: "Asia/Shanghai",
      secret: "must-not-be-forwarded"
    }))).toEqual({
      code: "PROVIDER_MONTHLY_TOKEN_QUOTA_EXCEEDED",
      message: "叙界平台限制了后续 Token 使用：配置的供应商“demo”额度已达到每月 Token 额度",
      status: 429,
      details: {
        platformLimited: true,
        limitScope: "provider",
        limitPeriod: "monthly",
        providerId: "provider_1",
        providerName: "demo",
        monthlyTokenQuota: 10_000,
        usedTokens: 10_000,
        remainingTokens: 0,
        resetsAt: "2026-09-01T00:00:00.000Z",
        timezone: "Asia/Shanghai"
      },
      providerName: "demo",
      providerId: "provider_1"
    });
  });

  it("只公开待回答问题的恢复标识", () => {
    expect(publicAiStreamError(new AppError(409, "AI_QUESTION_PENDING", "请先处理问题", {
      questionId: "aiQ_pending_1",
      conversationId: "conversation-private",
      secret: "must-not-be-forwarded"
    }))).toEqual({
      code: "AI_QUESTION_PENDING",
      message: "请先处理问题",
      status: 409,
      details: { questionId: "aiQ_pending_1" }
    });
  });
});
