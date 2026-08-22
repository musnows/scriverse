import { describe, expect, it } from "vitest";
import {
  connectivityConfigurationSavedToast,
  connectivityTestErrorToast,
  connectivityTestResultToast
} from "../../src/public/ai-connectivity-test.js";

describe("AI 连通性测试 Toast 文案", () => {
  it("说明成功 2 分钟冷却、失败 10 秒重试和多模态结果", () => {
    const providerSuccess = connectivityTestResultToast({
      ok: true,
      cooldown: { reason: "success_cooldown", retryAfterSeconds: 120, retryAt: "2026-08-12T12:02:00.000Z" }
    }, "provider");
    expect(providerSuccess).toMatchObject({ type: "info" });
    expect(providerSuccess.message).toContain("供应商连接测试成功");
    expect(providerSuccess.message).toContain("接下来 2 分钟内不能再次测试");
    expect(providerSuccess.message).toContain("可于");

    const privateAllowed = connectivityTestResultToast({
      ok: true,
      privateNetworkAllowed: true,
      cooldown: { reason: "success_cooldown", retryAfterSeconds: 120 }
    }, "provider");
    expect(privateAllowed).toMatchObject({ type: "warning" });
    expect(privateAllowed.message).toContain("供应商连接测试成功");
    expect(privateAllowed.message).toContain("当前地址指向本机或内网，已允许连接，请确认该地址可信");

    const modelSuccess = connectivityTestResultToast({
      ok: true,
      multimodalTested: true,
      cooldown: { reason: "success_cooldown", retryAfterSeconds: 120 }
    }, "model");
    expect(modelSuccess.message).toContain("图片请求已验证");

    const failed = connectivityTestResultToast({
      ok: false,
      error: "上游不可用",
      cooldown: { reason: "failure_cooldown", retryAfterSeconds: 10, retryAt: "2026-08-12T12:00:10.000Z" }
    }, "model");
    expect(failed).toMatchObject({ type: "error" });
    expect(failed.message).toContain("模型连接测试失败：上游不可用");
    expect(failed.message).toContain("10 秒后可以重试");
  });

  it("区分进行中、成功冷却、失败冷却和测试期间配置变化", () => {
    const inProgress = connectivityTestErrorToast({
      details: { reason: "in_progress", retryAfterSeconds: 42, retryAt: "2026-08-12T12:00:42.000Z" }
    }, "provider");
    expect(inProgress).toMatchObject({ type: "warning" });
    expect(inProgress.message).toContain("已有连接测试正在进行");
    expect(inProgress.message).toContain("42 秒");

    const successCooldown = connectivityTestErrorToast({
      details: { reason: "success_cooldown", retryAfterSeconds: 87 }
    }, "model");
    expect(successCooldown.message).toContain("仍在成功冷却中，剩余 87 秒");

    const failureCooldown = connectivityTestErrorToast({
      details: { reason: "failure_cooldown", retryAfterSeconds: 4 }
    }, "model");
    expect(failureCooldown.message).toContain("仍在失败冷却中，剩余 4 秒");

    const changed = connectivityTestResultToast({
      ok: true,
      cooldown: { reason: "configuration_changed", retryAfterSeconds: 0, retryAt: null }
    }, "model");
    expect(changed).toMatchObject({ type: "warning" });
    expect(changed.message).toContain("配置已在测试期间更新");
    expect(changed.message).toContain("现在可以重新测试");
  });

  it("配置保存后明确提示旧冷却已清除", () => {
    expect(connectivityConfigurationSavedToast("provider")).toBe("供应商配置已保存，旧连接测试冷却已清除，现在可以重新测试");
    expect(connectivityConfigurationSavedToast("model")).toBe("模型配置已保存，旧连接测试冷却已清除，现在可以重新测试");
  });
});
