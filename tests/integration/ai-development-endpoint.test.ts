import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

const runtimes: Runtime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
});

async function testProviderConnection(options: {
  developmentServer: boolean;
  allowPrivateAiEndpoints?: boolean;
  disableAiEndpointValidation?: boolean;
  baseUrl: string;
}): Promise<{
  result: Record<string, unknown>;
  requestedUrls: string[];
}> {
  const requestedUrls: string[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.endsWith("/models")) {
      return new Response(JSON.stringify({ data: [{ id: "development-model" }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "连接成功" } }] }), { status: 200 });
  });
  const runtime = createRuntime({
    databasePath: ":memory:",
    masterSecret: "test-master-secret-with-at-least-32-characters",
    disableUserAuth: true,
    fetchImpl: fetchMock,
    serveUi: false,
    security: {
      allowPrivateAiEndpoints: options.allowPrivateAiEndpoints === true,
      enforceSameOrigin: false
    },
    disableAiEndpointValidation: options.disableAiEndpointValidation === true,
    developmentServer: options.developmentServer
  });
  runtimes.push(runtime);

  const provider = await request(runtime.app).post("/api/platform/ai/providers").send({
    name: "开发地址测试供应商",
    baseUrl: options.baseUrl,
    apiKey: "development-test-key",
    status: "enabled"
  }).expect(201);
  const tested = await request(runtime.app).post(`/api/providers/${provider.body.data.id}/test`).send({}).expect(200);
  return { result: tested.body.data as Record<string, unknown>, requestedUrls };
}

describe("开发服务 AI 供应商地址校验", () => {
  it("开发模式跳过供应商地址 SSRF 校验", async () => {
    const result = await testProviderConnection({
      developmentServer: true,
      baseUrl: "https://198.18.0.7/v1"
    });

    expect(result.result).toMatchObject({ ok: true, availableModels: ["development-model"] });
    expect(result.requestedUrls).toEqual([
      "https://198.18.0.7/v1/models",
      "https://198.18.0.7/v1/chat/completions"
    ]);
  });

  it("非开发模式仍拒绝受保护地址", async () => {
    const result = await testProviderConnection({
      developmentServer: false,
      baseUrl: "https://198.18.0.7/v1"
    });

    expect(result.result).toMatchObject({ ok: false });
    expect(result.result.error).toContain("AI 供应商地址指向受保护的本机、内网或链路本地网络");
    expect(result.requestedUrls).toEqual([]);
  });
});

describe("私有网络 AI 供应商地址", () => {
  it("默认拦截本机供应商地址", async () => {
    const result = await testProviderConnection({
      developmentServer: false,
      baseUrl: "http://127.0.0.1:11434/v1"
    });

    expect(result.result).toMatchObject({ ok: false });
    expect(result.result.error).toContain("AI 供应商地址指向受保护的本机、内网或链路本地网络");
    expect(result.result.privateNetworkAllowed).toBeUndefined();
    expect(result.requestedUrls).toEqual([]);
  });

  it("开启私有地址后允许本机连接并返回提示", async () => {
    const result = await testProviderConnection({
      developmentServer: false,
      allowPrivateAiEndpoints: true,
      baseUrl: "http://127.0.0.1:11434/v1"
    });

    expect(result.result).toMatchObject({
      ok: true,
      availableModels: ["development-model"],
      privateNetworkAllowed: true
    });
    expect(result.requestedUrls).toEqual([
      "http://127.0.0.1:11434/v1/models",
      "http://127.0.0.1:11434/v1/chat/completions"
    ]);
  });

  it("开启私有地址后仍拒绝保留网段", async () => {
    const result = await testProviderConnection({
      developmentServer: false,
      allowPrivateAiEndpoints: true,
      baseUrl: "https://198.18.0.7/v1"
    });

    expect(result.result).toMatchObject({ ok: false });
    expect(result.result.error).toContain("AI 供应商地址指向受保护的本机、内网或链路本地网络");
    expect(result.result.privateNetworkAllowed).toBeUndefined();
    expect(result.requestedUrls).toEqual([]);
  });

  it("受信任本机运行时完全禁用 AI endpoint validator", async () => {
    const result = await testProviderConnection({
      developmentServer: false,
      allowPrivateAiEndpoints: true,
      disableAiEndpointValidation: true,
      baseUrl: "https://198.18.0.7/v1"
    });

    expect(result.result).toMatchObject({ ok: true, availableModels: ["development-model"] });
    expect(result.requestedUrls).toEqual([
      "https://198.18.0.7/v1/models",
      "https://198.18.0.7/v1/chat/completions"
    ]);
  });
});
