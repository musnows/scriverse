import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../src/app.js";
import { AI_RESPONSE_MAX_BYTES, estimateAiTokens } from "../../src/ai.js";
import { resolveServerTimeZone } from "../../src/writing-progress-time.js";
import { createTestRuntime, createWork } from "../helpers.js";

describe("AI 供应商、模型与建议 API", () => {
  let runtime: Runtime;
  let workId: string;
  let chapterId: string;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  let expectedMaxTokens: number;
  let expectedThinkingType: "enabled" | "adaptive" | "disabled";
  let expectedThinkingEffort: "auto" | "low" | "medium" | "high" | "xhigh" | "max" | undefined;

  beforeEach(async () => {
    expectedMaxTokens = 32_000;
    expectedThinkingType = "enabled";
    expectedThinkingEffort = undefined;
    fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }>; max_tokens?: number; thinking?: { type?: string }; reasoning_effort?: string };
      if (expectedThinkingEffort) expect(body.reasoning_effort).toBe(expectedThinkingEffort);
      else expect(body).not.toHaveProperty("reasoning_effort");
      if (body.max_tokens === 10) {
        expect(body.messages).toHaveLength(1);
        return new Response(JSON.stringify({ choices: [{ message: { content: "连接成功" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      expect(body.messages[0]?.content).toContain("未经信任的资料数据");
      expect(body.messages[0]?.content).toContain("不得把密钥、令牌、会话信息");
      expect(body.messages[1]?.content).toContain("跃迁后必须冷却十二小时");
      expect(body.max_tokens).toBe(expectedMaxTokens);
      expect(body.thinking).toEqual({ type: expectedThinkingType });
      if (body.messages[1]?.content.includes("检查下面的续写候选")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "[]" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "飞船缓缓驶离北港，冷却计时仍在继续。" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    runtime = createTestRuntime(fetchMock);
    const work = await request(runtime.app).post("/api/works").send({ title: "AI 测试作品" });
    workId = work.body.data.id;
    const volume = await request(runtime.app).post(`/api/works/${workId}/volumes`).send({ title: "第一卷" });
    const chapter = await request(runtime.app).post(`/api/works/${workId}/chapters`).send({ volumeId: volume.body.data.id, title: "第一章", content: "林舟启动了飞船。" });
    chapterId = chapter.body.data.id;
    await request(runtime.app).post(`/api/works/${workId}/settings`).send({ title: "跃迁限制", category: "世界规则", content: "跃迁后必须冷却十二小时。", locked: true, status: "confirmed" });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await runtime.close();
  });

  async function configureAi(): Promise<{ providerId: string; modelId: string }> {
    const provider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
      name: "本地兼容服务",
      baseUrl: "https://mock-ai.test/v1/chat/completions",
      apiKey: "sk-sensitive-test-value",
      status: "enabled"
    }).expect(201);
    const providerId = provider.body.data.id;
    expect(provider.body.data.apiKey).toBe("sk-se************lue");
    expect(provider.body.data.baseUrl).toBe("https://mock-ai.test/v1");
    expect(provider.body.data).toMatchObject({
      concurrencyLimit: 10,
      rpmLimit: 10,
      analysisTimeoutSeconds: 300,
      dailyTokenQuota: null,
      monthlyTokenQuota: null,
      maxTokensParameter: "max_tokens",
      thinkingType: "enabled"
    });
    expect(provider.body.data).not.toHaveProperty("maxTokens");
    const databaseRow = runtime.database.get<Record<string, unknown>>("SELECT encrypted_key FROM providers WHERE id = ?", providerId);
    expect(databaseRow?.encrypted_key).not.toContain("sk-sensitive-test-value");

    const model = await request(runtime.app).post(`/api/providers/${providerId}/models`).send({
      displayName: "小说模型",
      modelId: "mock-novel-model",
      preset: { temperature: 0.4, unsupported: "ignored" }
    }).expect(201);
    expect(model.body.data.preset).toMatchObject({ temperature: 0.4, max_tokens: 32_000, unsupported: "ignored" });
    expect(model.body.data.thinkingEnabled).toBe(true);
    expect(model.body.data.thinkingEffort).toBe("default");
    return { providerId, modelId: model.body.data.id };
  }

  function setLegacyModelContextWindow(modelId: string, contextWindow: number): void {
    runtime.database.run("UPDATE models SET context_window = ? WHERE id = ?", contextWindow, modelId);
  }

  it.each([
    ["openai-responses", "input"],
    ["anthropic-messages", "messages"],
    ["google-vertex", "messages"]
  ] as const)("允许 Desktop 本地运行模型使用 %s 协议", async (protocol, expectedBodyField) => {
    const started = await request(runtime.app).post(`/api/works/${workId}/desktop-local-ai/runs`).send({
      taskType: "continue",
      instruction: "继续这一章",
      scope: { type: "chapter", chapterId },
      runtimeModel: {
        id: `desktop-${protocol}-model`,
        providerId: `desktop-${protocol}-provider`,
        providerName: `local/${protocol}`,
        protocol,
        maxTokensParameter: "max_tokens",
        thinkingType: "enabled",
        concurrencyLimit: 3,
        rpmLimit: 30,
        analysisTimeoutSeconds: 300,
        displayName: protocol,
        modelId: `model-${protocol}`,
        purposes: ["chat", "continue", "polish"],
        contextNote: "",
        contextWindow: 128_000,
        outputNote: "",
        preset: { temperature: 0.4, max_tokens: 4_096 },
        thinkingEnabled: false,
        thinkingEffort: "default",
        multimodalEnabled: false,
        note: ""
      }
    }).expect(202);
    const runId = String(started.body.data.id);
    let pending: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const polled = await request(runtime.app).get(`/api/works/${workId}/desktop-local-ai/runs/${runId}`).expect(200);
      if (polled.body.data.status === "awaiting-completion") {
        pending = polled.body.data as Record<string, unknown>;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(pending).not.toBeNull();
    const completion = pending?.completion as { body: Record<string, unknown> };
    expect(completion.body).toHaveProperty(expectedBodyField);
    if (protocol === "openai-responses") expect(completion.body).not.toHaveProperty("messages");
    if (protocol === "anthropic-messages") expect(completion.body).toHaveProperty("system");
    await request(runtime.app).delete(`/api/works/${workId}/desktop-local-ai/runs/${runId}`).expect(200);
  });

  it("让 Desktop 本地模型复用 Server Agent 工具循环且不调用远端供应商", async () => {
    await request(runtime.app).patch("/api/platform/ai/settings").send({
      systemPrompt: "平台远端 Prompt"
    }).expect(200);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      systemPrompt: "作品远端 Prompt",
      agentTools: ["story_index"]
    }).expect(200);
    const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    const conversationId = String(conversation.body.data.id);
    await request(runtime.app).post(`/api/ai-conversations/${conversationId}/messages`).send({
      role: "user",
      content: "上一轮问题"
    }).expect(201);
    await request(runtime.app).post(`/api/ai-conversations/${conversationId}/messages`).send({
      role: "assistant",
      content: "上一轮回答"
    }).expect(201);
    const current = await request(runtime.app).post(`/api/ai-conversations/${conversationId}/messages`).send({
      role: "user",
      content: "请结合跃迁限制继续讨论"
    }).expect(201);

    const started = await request(runtime.app).post(`/api/works/${workId}/desktop-local-ai/runs`).send({
      taskType: "chat",
      instruction: "请结合跃迁限制继续讨论",
      scope: { type: "chapter", chapterId },
      runtimeModel: {
        id: "desktop-local-model",
        providerId: "desktop-local-provider",
        providerName: "local/LM Studio",
        protocol: "openai-chat-completions",
        maxTokensParameter: "max_tokens",
        thinkingType: "enabled",
        concurrencyLimit: 3,
        rpmLimit: 30,
        analysisTimeoutSeconds: 300,
        displayName: "本地模型",
        modelId: "local-model",
        purposes: ["chat", "continue", "polish"],
        contextNote: "",
        contextWindow: 128_000,
        outputNote: "",
        preset: { temperature: 0.4, max_tokens: 4_096 },
        thinkingEnabled: false,
        thinkingEffort: "default",
        multimodalEnabled: false,
        note: ""
      },
      conversationId,
      currentMessageId: current.body.data.id
    }).expect(202);

    const runId = String(started.body.data.id);
    const waitForStatus = async (expected: string): Promise<Record<string, unknown>> => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const polled = await request(runtime.app).get(`/api/works/${workId}/desktop-local-ai/runs/${runId}`).expect(200);
        if (polled.body.data.status === expected) return polled.body.data as Record<string, unknown>;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      throw new Error(`Desktop local AI run did not reach ${expected}`);
    };

    const firstRound = await waitForStatus("awaiting-completion");
    const firstCompletion = firstRound.completion as { requestId: string; body: Record<string, unknown> };
    const firstBody = firstCompletion.body as {
      model: string;
      messages: Array<{ role: string; content: unknown }>;
      tools: Array<{ function?: { name?: string } }>;
      tool_choice: string;
    };

    expect(fetchMock).not.toHaveBeenCalled();
    expect(firstBody.model).toBe("local-model");
    expect(firstBody.tool_choice).toBe("auto");
    expect(firstBody.tools.some((tool) => tool.function?.name === "story_index")).toBe(true);
    expect(JSON.stringify(firstBody.messages[0]?.content)).toContain("<platform_system_prompt>");
    expect(JSON.stringify(firstBody.messages[0]?.content)).toContain("平台远端 Prompt");
    expect(JSON.stringify(firstBody.messages[0]?.content)).toContain("<work_system_prompt>");
    expect(JSON.stringify(firstBody.messages[0]?.content)).toContain("作品远端 Prompt");
    expect(JSON.stringify(firstBody.messages)).toContain("上一轮问题");
    expect(JSON.stringify(firstBody.messages)).toContain("上一轮回答");
    expect(JSON.stringify(firstBody.messages)).toContain("跃迁后必须冷却十二小时");
    expect(JSON.stringify(firstBody.messages)).toContain("<author_instruction>");
    expect(firstRound.contextUsage).toMatchObject({
      modelId: "desktop-local-model",
      contextWindow: 128_000
    });
    expect(Number(((firstRound.contextUsage as { tokenDistribution: { functionTokens: number } }).tokenDistribution.functionTokens))).toBeGreaterThan(0);

    await request(runtime.app)
      .post(`/api/works/${workId}/desktop-local-ai/runs/${runId}/responses`)
      .send({
        requestId: firstCompletion.requestId,
        status: 200,
        body: JSON.stringify({
          choices: [{
            finish_reason: "tool_calls",
            message: {
              content: null,
              tool_calls: [{
                id: "call-story-index",
                type: "function",
                function: { name: "story_index", arguments: "{}" }
              }]
            }
          }]
        })
      })
      .expect(200);

    const secondRound = await waitForStatus("awaiting-completion");
    const secondCompletion = secondRound.completion as { requestId: string; body: Record<string, unknown> };
    expect(secondCompletion.requestId).not.toBe(firstCompletion.requestId);
    expect(JSON.stringify(secondCompletion.body)).toContain('"role":"tool"');
    expect(JSON.stringify(secondCompletion.body)).toContain("AI 测试作品");
    expect((secondCompletion.body.tools as unknown[]).length).toBeGreaterThan(0);

    await request(runtime.app)
      .post(`/api/works/${workId}/desktop-local-ai/runs/${runId}/responses`)
      .send({
        requestId: secondCompletion.requestId,
        status: 200,
        body: JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "已查询作品目录，跃迁冷却限制仍然有效。" } }] })
      })
      .expect(200);

    const completed = await waitForStatus("completed");
    expect(completed.result).toMatchObject({
      content: "已查询作品目录，跃迁冷却限制仍然有效。",
      provider: { scope: "local", name: "local/LM Studio" },
      model: { id: "desktop-local-model", scope: "local" },
      toolCalls: [expect.objectContaining({ name: "story_index", status: "completed" })]
    });
    expect(Number((((completed.result as { contextUsage: { tokenDistribution: { functionTokens: number } } }).contextUsage.tokenDistribution.functionTokens)))).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Desktop 本地角色扮演在最终消息落库后提交记忆候选", async () => {
    const character = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "林舟" }).expect(201);
    const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({ taskType: "roleplay" }).expect(201);
    const conversationId = String(conversation.body.data.id);
    await request(runtime.app).patch(`/api/ai-conversations/${conversationId}/roleplay`).send({
      characterId: character.body.data.id
    }).expect(200);
    const current = await request(runtime.app).post(`/api/ai-conversations/${conversationId}/messages`).send({
      role: "user",
      content: "我把旧罗盘交给你。"
    }).expect(201);
    const runtimeModel = {
      id: "desktop-roleplay-model",
      providerId: "desktop-roleplay-provider",
      providerName: "local/LM Studio",
      protocol: "openai-chat-completions",
      maxTokensParameter: "max_tokens",
      thinkingType: "enabled",
      concurrencyLimit: 3,
      rpmLimit: 30,
      analysisTimeoutSeconds: 300,
      displayName: "本地角色模型",
      modelId: "local-roleplay-model",
      purposes: ["chat", "continue", "polish"],
      contextNote: "",
      contextWindow: 128_000,
      outputNote: "",
      preset: { temperature: 0.4, max_tokens: 4_096 },
      thinkingEnabled: false,
      thinkingEffort: "default",
      multimodalEnabled: false,
      note: ""
    };
    const started = await request(runtime.app).post(`/api/works/${workId}/desktop-local-ai/runs`).send({
      taskType: "chat",
      instruction: "我把旧罗盘交给你。",
      scope: { type: "none" },
      runtimeModel,
      conversationId,
      currentMessageId: current.body.data.id
    }).expect(202);
    const runId = String(started.body.data.id);
    const waitForStatus = async (expected: string): Promise<Record<string, unknown>> => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const polled = await request(runtime.app).get(`/api/works/${workId}/desktop-local-ai/runs/${runId}`).expect(200);
        if (polled.body.data.status === expected) return polled.body.data as Record<string, unknown>;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      throw new Error(`Desktop roleplay run did not reach ${expected}`);
    };
    const firstRound = await waitForStatus("awaiting-completion");
    const firstCompletion = firstRound.completion as { requestId: string; body: { tools: Array<{ function?: { name?: string } }> } };
    expect(firstCompletion.body.tools.map((tool) => tool.function?.name)).toEqual(expect.arrayContaining([
      "recall_roleplay_memory",
      "remember_roleplay"
    ]));
    await request(runtime.app).post(`/api/works/${workId}/desktop-local-ai/runs/${runId}/responses`).send({
      requestId: firstCompletion.requestId,
      status: 200,
      body: JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{
        id: "desktop-remember",
        type: "function",
        function: {
          name: "remember_roleplay",
          arguments: JSON.stringify({ memories: [{ category: "event", content: "用户角色把旧罗盘交给了林舟。" }] })
        }
      }] } }] })
    }).expect(200);
    const secondRound = await waitForStatus("awaiting-completion");
    const secondCompletion = secondRound.completion as { requestId: string; body: Record<string, unknown> };
    expect(JSON.stringify(secondCompletion.body)).toContain("will be committed only after");
    await request(runtime.app).post(`/api/works/${workId}/desktop-local-ai/runs/${runId}/responses`).send({
      requestId: secondCompletion.requestId,
      status: 200,
      body: JSON.stringify({ choices: [{ message: { content: "我接过旧罗盘，把它系在腰间。" } }] })
    }).expect(200);
    const completed = await waitForStatus("completed");
    expect(completed.result).toMatchObject({ content: "我接过旧罗盘，把它系在腰间。" });
    const memories = await request(runtime.app).get(`/api/characters/${character.body.data.id}/roleplay-memories`).expect(200);
    expect(memories.body.data.items).toEqual([
      expect.objectContaining({ content: "用户角色把旧罗盘交给了林舟。", sourceType: "ai", canonical: false })
    ]);
    const reloaded = await request(runtime.app).get(`/api/ai-conversations/${conversationId}`).expect(200);
    expect(reloaded.body.data.messages.at(-1)).toMatchObject({ role: "assistant", content: "我接过旧罗盘，把它系在腰间。" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["openai-chat-completions", "OpenAI Chat"],
    ["openai-responses", "OpenAI Responses"]
  ] as const)("通过 %s /models 幂等导入模型", async (protocol, name) => {
    fetchMock.mockImplementation(async (input) => {
      expect(String(input)).toBe("https://models.example/v1/models");
      return new Response(JSON.stringify({
        object: "list",
        data: [{ id: "model-one" }, { id: "model-two" }, { object: "model" }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const provider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
      name,
      protocol,
      baseUrl: "https://models.example/v1",
      apiKey: "sk-import-models",
      status: "enabled"
    }).expect(201);
    const providerId = String(provider.body.data.id);

    const imported = await request(runtime.app).post(`/api/providers/${providerId}/models/import`).send({}).expect(200);
    expect(imported.body.data).toEqual({
      availableCount: 2,
      importedCount: 2,
      existingCount: 0,
      invalidItemCount: 1
    });
    const models = await request(runtime.app).get(`/api/providers/${providerId}/models`).expect(200);
    expect(models.body.data).toHaveLength(2);
    expect(models.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ modelId: "model-one", displayName: "model-one", contextWindow: 128_000, preset: { max_tokens: 32_000 } }),
      expect.objectContaining({ modelId: "model-two", displayName: "model-two", contextWindow: 128_000, preset: { max_tokens: 32_000 } })
    ]));

    const repeated = await request(runtime.app).post(`/api/providers/${providerId}/models/import`).send({}).expect(200);
    expect(repeated.body.data).toMatchObject({ availableCount: 2, importedCount: 0, existingCount: 2 });
    expect(runtime.database.get(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'provider.models-imported' AND entity_id = ?",
      providerId
    )).toEqual({ count: 1 });
  });

  it("分页导入 Anthropic 模型元数据并携带协议鉴权头", async () => {
    const requestedUrls: string[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      requestedUrls.push(url);
      const headers = new Headers(init?.headers);
      expect(headers.get("x-api-key")).toBe("sk-anthropic-import");
      expect(headers.get("anthropic-version")).toBe("2023-06-01");
      if (!url.includes("after_id=")) {
        return new Response(JSON.stringify({
          data: [{
            id: "claude-sonnet",
            display_name: "Claude Sonnet",
            max_input_tokens: 200_000,
            max_tokens: 64_000,
            capabilities: { image_input: { supported: true } }
          }],
          has_more: true,
          last_id: "claude-sonnet"
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: [{ id: "claude-haiku", display_name: "Claude Haiku" }],
        has_more: false,
        last_id: "claude-haiku"
      }), { status: 200 });
    });
    const provider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
      name: "Anthropic",
      protocol: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-anthropic-import",
      status: "enabled"
    }).expect(201);
    const providerId = String(provider.body.data.id);

    const imported = await request(runtime.app).post(`/api/providers/${providerId}/models/import`).send({}).expect(200);
    expect(imported.body.data).toMatchObject({ availableCount: 2, importedCount: 2, existingCount: 0 });
    expect(requestedUrls).toEqual([
      "https://api.anthropic.com/v1/models?limit=1000",
      "https://api.anthropic.com/v1/models?limit=1000&after_id=claude-sonnet"
    ]);
    const models = await request(runtime.app).get(`/api/providers/${providerId}/models`).expect(200);
    expect(models.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({
        modelId: "claude-sonnet",
        displayName: "Claude Sonnet",
        contextWindow: 200_000,
        preset: { max_tokens: 64_000 },
        multimodalEnabled: true
      }),
      expect.objectContaining({ modelId: "claude-haiku", displayName: "Claude Haiku", contextWindow: 128_000 })
    ]));
  });

  it("在供应商不支持 /models 时给出明确提示且不写入模型", async () => {
    fetchMock.mockResolvedValue(new Response("not found", { status: 404 }));
    const provider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
      name: "无模型端点",
      protocol: "openai-chat-completions",
      baseUrl: "https://no-models.example/v1",
      apiKey: "sk-no-models",
      status: "enabled"
    }).expect(201);
    const providerId = String(provider.body.data.id);

    const response = await request(runtime.app).post(`/api/providers/${providerId}/models/import`).send({}).expect(400);
    expect(response.body.error).toEqual({
      code: "PROVIDER_MODELS_ENDPOINT_UNSUPPORTED",
      message: "当前供应商 Base URL 不支持 /models 端点，请手动添加模型"
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM models WHERE provider_id = ?", providerId)).toEqual({ count: 0 });
  });

  it("批量导入审计失败时回滚全部模型", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "rollback-one" }, { id: "rollback-two" }] }), { status: 200 }));
    const provider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
      name: "回滚供应商",
      baseUrl: "https://rollback.example/v1",
      apiKey: "sk-rollback",
      status: "enabled"
    }).expect(201);
    const providerId = String(provider.body.data.id);
    runtime.database.raw.exec(`
      CREATE TRIGGER reject_provider_models_import_audit BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'provider.models-imported'
      BEGIN SELECT RAISE(ABORT, 'reject provider model import audit'); END
    `);

    await request(runtime.app).post(`/api/providers/${providerId}/models/import`).send({}).expect(500);
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM models WHERE provider_id = ?", providerId)).toEqual({ count: 0 });
  });

  function streamedDeltas(value: string): string {
    return value.split(/\r?\n\r?\n/u).flatMap((eventText) => {
      const lines = eventText.split(/\r?\n/u);
      if (!lines.some((line) => line.trim() === "event: delta")) return [];
      const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (!data) return [];
      const payload = JSON.parse(data) as unknown;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
      const delta = (payload as Record<string, unknown>).delta;
      return typeof delta === "string" ? [delta] : [];
    }).join("");
  }

  it("只有连接测试成功的启用供应商才能设置默认模型", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).put(`/api/works/${workId}/task-defaults/continue`).send({ modelId }).expect(409);

    const tested = await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    expect(tested.body.data).toMatchObject({ ok: true, availableModels: ["mock-novel-model"] });
    const limited = await request(runtime.app).patch(`/api/providers/${providerId}`).send({ concurrencyLimit: 3, rpmLimit: 120 }).expect(200);
    expect(limited.body.data).toMatchObject({ concurrencyLimit: 3, rpmLimit: 120 });
    await request(runtime.app).put(`/api/works/${workId}/task-defaults/continue`).send({ modelId }).expect(200);

    await request(runtime.app).patch(`/api/providers/${providerId}`).send({ status: "disabled" }).expect(200);
    await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "continue",
      instruction: "续写一段",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(409);
  });

  it("删除模型时清理任务默认值并记录审计", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    await request(runtime.app).put(`/api/works/${workId}/task-defaults/continue`).send({ modelId }).expect(200);

    await request(runtime.app).delete(`/api/models/${modelId}`).expect(204);

    expect(runtime.database.get("SELECT id FROM models WHERE id = ?", modelId)).toBeUndefined();
    expect(runtime.database.get("SELECT model_id FROM task_defaults WHERE model_id = ?", modelId)).toBeUndefined();
    const audit = runtime.database.get<{ detail_json: string }>(
      "SELECT detail_json FROM audit_logs WHERE action = 'model.deleted' AND entity_id = ? ORDER BY created_at DESC LIMIT 1",
      modelId
    );
    expect(audit).toBeDefined();
    expect(JSON.parse(audit?.detail_json ?? "{}")).toMatchObject({ providerId, modelId: "mock-novel-model", displayName: "小说模型" });
  });

  it("供应商连接测试复用 402 普通重试策略", async () => {
    const { providerId } = await configureAi();
    let modelListAttempts = 0;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) {
        modelListAttempts += 1;
        if (modelListAttempts <= 3) {
          return new Response(JSON.stringify({ error: { message: "payment required" } }), { status: 402 });
        }
        return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as { max_tokens?: number };
      expect(body.max_tokens).toBe(10);
      return new Response(JSON.stringify({ choices: [{ message: { content: "连接成功" } }] }), { status: 200 });
    });

    const tested = await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    expect(tested.body.data).toMatchObject({ ok: true, availableModels: ["mock-novel-model"] });
    expect(modelListAttempts).toBe(4);
  });

  it("供应商可切换 max_completion_tokens，连通性测试与生成请求使用相同字段", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);

    const updated = await request(runtime.app).patch(`/api/providers/${providerId}`).send({
      maxTokensParameter: "max_completion_tokens"
    }).expect(200);
    expect(updated.body.data).toMatchObject({
      maxTokensParameter: "max_completion_tokens",
      connectionStatus: "unchecked"
    });

    const completionBodies: Array<Record<string, unknown>> = [];
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      completionBodies.push(body);
      expect(body).not.toHaveProperty("max_tokens");
      if (body.max_completion_tokens === 10) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "连接成功" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      expect(body.max_completion_tokens).toBe(32_000);
      return new Response(JSON.stringify({ choices: [{ message: { content: "飞船驶离北港。" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "概括当前场景",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(201);

    expect(completionBodies.some((body) => body.max_completion_tokens === 10)).toBe(true);
    expect(completionBodies.some((body) => body.max_completion_tokens === 32_000)).toBe(true);
  });

  it("达到本书每日 Token 额度后拒绝新的 AI 调用", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      dailyTokenQuota: 10_000,
      agentTools: []
    }).expect(200);
    const createdAt = new Date().toISOString();
    runtime.database.run(
      `INSERT INTO ai_calls (
         id, work_id, task_type, provider_id, model_id, context_scope_json, status,
         input_tokens, output_tokens, token_usage_source, created_at, completed_at
       ) VALUES ('quota-used', ?, 'chat', ?, ?, '{}', 'completed', 9000, 1000, 'reported', ?, ?)`,
      workId,
      providerId,
      modelId,
      createdAt,
      createdAt
    );

    const rejected = await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "继续分析",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(429);
    expect(rejected.body.error).toMatchObject({
      code: "DAILY_TOKEN_QUOTA_EXCEEDED",
      details: {
        dailyTokenQuota: 10_000,
        usedTokens: 10_000,
        remainingTokens: 0,
        timezone: resolveServerTimeZone()
      }
    });
    expect(rejected.body.error.message).toContain("叙界平台限制了后续 Token 使用");
    expect(rejected.body.error.message).toContain("单个小说额度");
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM ai_calls WHERE work_id = ?", workId)).toEqual({ count: 1 });
  });

  it("达到本书每月 Token 额度后拒绝新的 AI 调用", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      monthlyTokenQuota: 10_000,
      agentTools: []
    }).expect(200);
    const createdAt = new Date().toISOString();
    runtime.database.run(
      `INSERT INTO ai_calls (
         id, work_id, task_type, provider_id, model_id, context_scope_json, status,
         input_tokens, output_tokens, token_usage_source, created_at, completed_at
       ) VALUES ('monthly-quota-used', ?, 'chat', ?, ?, '{}', 'completed', 9000, 1000, 'reported', ?, ?)`,
      workId,
      providerId,
      modelId,
      createdAt,
      createdAt
    );

    const rejected = await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "继续分析",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(429);
    expect(rejected.body.error).toMatchObject({
      code: "MONTHLY_TOKEN_QUOTA_EXCEEDED",
      details: {
        monthlyTokenQuota: 10_000,
        usedTokens: 10_000,
        remainingTokens: 0,
        timezone: resolveServerTimeZone()
      }
    });
    expect(rejected.body.error.message).toContain("叙界平台限制了后续 Token 使用");
    expect(rejected.body.error.message).toContain("单个小说额度");
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM ai_calls WHERE work_id = ?", workId)).toEqual({ count: 1 });
  });

  it("供应商每日 Token 额度跨作品累计且不消耗当前小说的额度", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    const otherWork = await createWork(runtime, "供应商额度占用作品");
    await request(runtime.app).patch(`/api/providers/${providerId}`).send({ dailyTokenQuota: 10_000 }).expect(200);
    const createdAt = new Date().toISOString();
    runtime.database.run(
      `INSERT INTO ai_calls (
         id, work_id, task_type, provider_id, model_id, context_scope_json, status,
         input_tokens, output_tokens, token_usage_source, created_at, completed_at
       ) VALUES ('provider-daily-cross-work', ?, 'chat', ?, ?, '{}', 'completed', 9000, 1000, 'reported', ?, ?)`,
      String(otherWork.id),
      providerId,
      modelId,
      createdAt,
      createdAt
    );

    expect(runtime.ai.getWorkDailyTokenQuotaStatus(workId)).toMatchObject({ usedTokens: 0, dailyTokenQuota: null });
    expect(runtime.ai.getProviderDailyTokenQuotaStatus(providerId)).toMatchObject({
      dailyTokenQuota: 10_000,
      usedTokens: 10_000,
      remainingTokens: 0,
      timezone: resolveServerTimeZone()
    });
    const rejected = await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "继续分析",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(429);
    expect(rejected.body.error).toMatchObject({
      code: "PROVIDER_DAILY_TOKEN_QUOTA_EXCEEDED",
      details: {
        platformLimited: true,
        limitScope: "provider",
        limitPeriod: "daily",
        providerId,
        providerName: "本地兼容服务",
        usedTokens: 10_000,
        remainingTokens: 0,
        timezone: resolveServerTimeZone()
      }
    });
    expect(rejected.body.error.message).toContain("叙界平台限制了后续 Token 使用");
    expect(rejected.body.error.message).toContain("配置的供应商");
  });

  it("供应商每月 Token 额度按服务器时区跨作品累计", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    const otherWork = await createWork(runtime, "供应商月度额度占用作品");
    await request(runtime.app).patch(`/api/providers/${providerId}`).send({ monthlyTokenQuota: 10_000 }).expect(200);
    const createdAt = new Date().toISOString();
    runtime.database.run(
      `INSERT INTO ai_calls (
         id, work_id, task_type, provider_id, model_id, context_scope_json, status,
         input_tokens, output_tokens, token_usage_source, created_at, completed_at
       ) VALUES ('provider-monthly-cross-work', ?, 'chat', ?, ?, '{}', 'completed', 9000, 1000, 'reported', ?, ?)`,
      String(otherWork.id),
      providerId,
      modelId,
      createdAt,
      createdAt
    );

    expect(runtime.ai.getProviderMonthlyTokenQuotaStatus(providerId)).toMatchObject({
      monthlyTokenQuota: 10_000,
      usedTokens: 10_000,
      remainingTokens: 0,
      timezone: resolveServerTimeZone()
    });
    const rejected = await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "继续分析",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(429);
    expect(rejected.body.error).toMatchObject({
      code: "PROVIDER_MONTHLY_TOKEN_QUOTA_EXCEEDED",
      details: {
        platformLimited: true,
        limitScope: "provider",
        limitPeriod: "monthly",
        providerId,
        providerName: "本地兼容服务",
        usedTokens: 10_000,
        remainingTokens: 0,
        timezone: resolveServerTimeZone()
      }
    });
    expect(rejected.body.error.message).toContain("叙界平台限制了后续 Token 使用");
    expect(rejected.body.error.message).toContain("配置的供应商");
  });

  it("日、月 Token 额度允许低用量正数但拒绝零和负数", async () => {
    const { providerId } = await configureAi();
    const workLowQuota = await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      dailyTokenQuota: 1,
      monthlyTokenQuota: 999_999
    }).expect(200);
    expect(workLowQuota.body.data).toMatchObject({ dailyTokenQuota: 1, monthlyTokenQuota: 999_999 });

    const workZeroQuota = await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ dailyTokenQuota: 0 }).expect(400);
    expect(workZeroQuota.body.error.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "dailyTokenQuota", message: "Token 额度必须设置大于 0" })
    ]));
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ monthlyTokenQuota: -1 }).expect(400);

    const providerLowQuota = await request(runtime.app).patch(`/api/providers/${providerId}`).send({
      dailyTokenQuota: 1,
      monthlyTokenQuota: 999_999
    }).expect(200);
    expect(providerLowQuota.body.data).toMatchObject({ dailyTokenQuota: 1, monthlyTokenQuota: 999_999 });

    await request(runtime.app).patch(`/api/providers/${providerId}`).send({ dailyTokenQuota: 0 }).expect(400);
    const providerNegativeQuota = await request(runtime.app).patch(`/api/providers/${providerId}`).send({ monthlyTokenQuota: -1 }).expect(400);
    expect(providerNegativeQuota.body.error.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "monthlyTokenQuota", message: "Token 额度必须设置大于 0" })
    ]));
  });

  it("聊天模型和历史列表通过独立接口返回", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    for (let index = 1; index <= 21; index += 1) {
      await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({ title: `初始化会话 ${index}` }).expect(201);
    }

    const models = await request(runtime.app).get(`/api/works/${workId}/models`).expect(200);
    const firstPage = await request(runtime.app).get(`/api/works/${workId}/ai-conversations`).expect(200);
    const secondPage = await request(runtime.app).get(`/api/works/${workId}/ai-conversations?page=2`).expect(200);

    expect(models.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: modelId })]));
    expect(firstPage.body.data).toMatchObject({ page: 1, limit: 20, hasMore: true, nextPage: 2 });
    expect(firstPage.body.data.items).toHaveLength(20);
    expect(secondPage.body.data).toMatchObject({ page: 2, limit: 20, hasMore: false, nextPage: null });
    expect(secondPage.body.data.items).toHaveLength(1);
  });

  it("支持通过标题接口人工重命名对话并规范输入", async () => {
    const created = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({ title: "旧对话名称" }).expect(201);
    const conversationId = String(created.body.data.id);

    const renamed = await request(runtime.app).patch(`/api/ai-conversations/${conversationId}/title`).send({
      title: "  新  对话\n名称  "
    }).expect(200);
    expect(renamed.body.data).toMatchObject({ id: conversationId, title: "新 对话 名称" });

    const listed = await request(runtime.app).get(`/api/works/${workId}/ai-conversations`).expect(200);
    expect(listed.body.data.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: conversationId, title: "新 对话 名称" })]));
    await request(runtime.app).patch(`/api/ai-conversations/${conversationId}/title`).send({ title: "   " }).expect(400);
    await request(runtime.app).patch(`/api/ai-conversations/${conversationId}/title`).send({ title: "合法标题", unexpected: true }).expect(400);
  });

  it("收藏对话后置顶历史并禁止清理", async () => {
    const first = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({ title: "待收藏对话" }).expect(201);
    const second = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({ title: "普通对话" }).expect(201);
    const firstId = String(first.body.data.id);
    const secondId = String(second.body.data.id);

    const favorited = await request(runtime.app).patch(`/api/ai-conversations/${firstId}/favorite`).send({ isFavorite: true }).expect(200);
    expect(favorited.body.data).toMatchObject({ id: firstId, isFavorite: true });
    const listed = await request(runtime.app).get(`/api/works/${workId}/ai-conversations`).expect(200);
    expect(listed.body.data.items.slice(0, 2).map((item: { id: string }) => item.id)).toEqual([firstId, secondId]);

    const protectedCleanup = await request(runtime.app).delete(`/api/ai-conversations/${firstId}`).expect(409);
    expect(protectedCleanup.body.error).toMatchObject({
      code: "AI_CONVERSATION_FAVORITED",
      message: "收藏的对话不能清理，请先取消收藏"
    });
    await request(runtime.app).patch(`/api/ai-conversations/${firstId}/favorite`).send({ isFavorite: false }).expect(200);
    await request(runtime.app).delete(`/api/ai-conversations/${firstId}`).expect(200);
    await request(runtime.app).get(`/api/ai-conversations/${firstId}`).expect(404);
  });

  it("将单个 AI 对话安全导出为与消息顺序一致的 Markdown", async () => {
    await configureAi();
    const created = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({
      title: "../星海：密谈\r\nX-Evil: injected"
    }).expect(201);
    const conversationId = String(created.body.data.id);
    const userContent = "请保留 @林舟 与特殊字符 *原样*。\n\n```ts\nconst answer = 42;\n```";
    const assistantContent = "第一行\n第二行\n\n- 列表项";
    runtime.store.addAiConversationMessage(conversationId, {
      role: "user",
      content: userContent,
      metadata: { mentionCharacterIds: ["character_reference"] }
    });
    runtime.store.addAiConversationMessage(conversationId, {
      role: "assistant",
      content: assistantContent,
      metadata: {
        modelDisplayName: "小说模型",
        reasoningContent: "INTERNAL_REASONING",
        anthropicContent: [{ type: "thinking", thinking: "INTERNAL_THINKING" }]
      }
    });

    const exported = await request(runtime.app).get(`/api/ai-conversations/${conversationId}/export`).expect(200);
    expect(exported.headers["content-type"]).toContain("text/markdown");
    expect(exported.headers["content-disposition"]).toContain(`filename="ai-conversation-${conversationId}.md"`);
    expect(exported.headers["content-disposition"]).not.toMatch(/[\r\n]/u);
    expect(exported.headers["content-disposition"]).not.toContain("../");
    expect(exported.text).toContain("## 作者 · ");
    expect(exported.text).toContain("## 助手 · ");
    expect(exported.text).toContain(userContent);
    expect(exported.text).toContain(assistantContent);
    expect(exported.text.indexOf(userContent)).toBeLessThan(exported.text.indexOf(assistantContent));
    expect(exported.text).not.toContain("sk-sensitive-test-value");
    expect(exported.text).not.toContain("INTERNAL_REASONING");
    expect(exported.text).not.toContain("INTERNAL_THINKING");
  });

  it("从所选历史消息事务化幂等续写，并沿用 compact 上下文边界", async () => {
    let generatedMessages: Array<{ role: string; content: unknown }> = [];
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: unknown }>;
        max_tokens?: number;
      };
      if (body.max_tokens === 10) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "连接成功" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      generatedMessages = body.messages;
      return new Response(JSON.stringify({ choices: [{ message: { content: "分支后的回答" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);

    const source = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({
      title: "上下文分支源对话"
    }).expect(201);
    const sourceId = String(source.body.data.id);
    const sourceMessages = [];
    for (const [role, content] of [
      ["user", "SOURCE_BEFORE_USER"],
      ["assistant", "SOURCE_BEFORE_ASSISTANT"],
      ["user", "SOURCE_SELECTED_USER"],
      ["assistant", "SOURCE_AFTER_ASSISTANT"]
    ] as const) {
      const message = await request(runtime.app).post(`/api/ai-conversations/${sourceId}/messages`).send({ role, content }).expect(201);
      sourceMessages.push(message.body.data);
    }
    runtime.store.saveAiConversationCompaction(sourceId, JSON.stringify({
      authorGoals: [{ text: "COMPACTED_BEFORE_CONTEXT", sourceMessageIds: sourceMessages.slice(0, 2).map((message) => message.id) }],
      confirmedDecisions: [],
      storyFacts: [],
      constraints: [],
      unresolvedQuestions: [],
      importantReferences: []
    }), 2);
    const sourceBefore = await request(runtime.app).get(`/api/ai-conversations/${sourceId}`).expect(200);
    const conversationCountBefore = Number(runtime.database.get("SELECT COUNT(*) AS count FROM ai_conversations WHERE work_id = ?", workId)?.count ?? 0);

    const requestId = "fork-selected-message-request";
    const firstFork = await request(runtime.app).post(`/api/ai-conversations/${sourceId}/fork`).send({
      messageId: sourceMessages[2].id,
      requestId
    }).expect(201);
    const repeatedFork = await request(runtime.app).post(`/api/ai-conversations/${sourceId}/fork`).send({
      messageId: sourceMessages[2].id,
      requestId
    }).expect(201);
    expect(repeatedFork.body.data.id).toBe(firstFork.body.data.id);
    expect(repeatedFork.body.data.messages.map((message: Record<string, unknown>) => message.id))
      .toEqual(firstFork.body.data.messages.map((message: Record<string, unknown>) => message.id));
    expect(firstFork.body.data.messages.map((message: Record<string, unknown>) => message.content)).toEqual([
      "SOURCE_BEFORE_USER",
      "SOURCE_BEFORE_ASSISTANT",
      "SOURCE_SELECTED_USER"
    ]);
    expect(firstFork.body.data.messages.map((message: Record<string, unknown>) => message.id))
      .not.toEqual(sourceMessages.slice(0, 3).map((message) => message.id));
    expect(firstFork.body.data).toMatchObject({ compactedMessageCount: 2, hasCompactedSummary: true });
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM ai_conversation_forks WHERE source_conversation_id = ?", sourceId)).toEqual({ count: 1 });
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM ai_conversations WHERE work_id = ?", workId)).toEqual({ count: conversationCountBefore + 1 });
    expect(runtime.database.get(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'ai-conversation.forked' AND entity_id = ?",
      firstFork.body.data.id
    )).toEqual({ count: 1 });

    const reusedForAnotherMessage = await request(runtime.app).post(`/api/ai-conversations/${sourceId}/fork`).send({
      messageId: sourceMessages[3].id,
      requestId
    }).expect(409);
    expect(reusedForAnotherMessage.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    await request(runtime.app).post(`/api/ai-conversations/${sourceId}/fork`).send({
      messageId: sourceMessages[2].id,
      requestId: "fork-strict-input",
      unexpected: true
    }).expect(400);

    const forkContext = runtime.store.getAiConversationContext(String(firstFork.body.data.id), workId);
    expect(forkContext).toMatchObject({ compactedMessageCount: 2, totalMessageCount: 3 });
    expect(forkContext.summary).toContain("COMPACTED_BEFORE_CONTEXT");
    expect(forkContext.messages.map((message) => message.content)).toEqual(["SOURCE_SELECTED_USER"]);

    const streamed = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "BRANCH_FIRST_REQUEST",
      scope: { type: "none" },
      modelId,
      conversationId: firstFork.body.data.id
    }).expect(200);
    expect(streamed.text).toContain("分支后的回答");
    const generatedPayload = JSON.stringify(generatedMessages);
    expect(generatedPayload).toContain("COMPACTED_BEFORE_CONTEXT");
    expect(generatedPayload).toContain("SOURCE_SELECTED_USER");
    expect(generatedPayload).toContain("BRANCH_FIRST_REQUEST");
    expect(generatedPayload).not.toContain("SOURCE_AFTER_ASSISTANT");

    const sourceAfter = await request(runtime.app).get(`/api/ai-conversations/${sourceId}`).expect(200);
    expect(sourceAfter.body.data).toEqual(sourceBefore.body.data);

    const countsBeforeRollback = {
      conversations: runtime.database.get("SELECT COUNT(*) AS count FROM ai_conversations WHERE work_id = ?", workId),
      messages: runtime.database.get("SELECT COUNT(*) AS count FROM ai_conversation_messages"),
      forks: runtime.database.get("SELECT COUNT(*) AS count FROM ai_conversation_forks")
    };
    runtime.database.run(`CREATE TRIGGER reject_conversation_fork_audit BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'ai-conversation.forked'
      BEGIN SELECT RAISE(ABORT, 'reject fork audit'); END`);
    await request(runtime.app).post(`/api/ai-conversations/${sourceId}/fork`).send({
      messageId: sourceMessages[2].id,
      requestId: "fork-rollback-request"
    }).expect(500);
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM ai_conversations WHERE work_id = ?", workId)).toEqual(countsBeforeRollback.conversations);
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM ai_conversation_messages")).toEqual(countsBeforeRollback.messages);
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM ai_conversation_forks")).toEqual(countsBeforeRollback.forks);
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("拒绝新增或改为低于 32K 上下文的模型", async () => {
    const { providerId, modelId } = await configureAi();
    const invalidCreate = await request(runtime.app).post(`/api/providers/${providerId}/models`).send({
      displayName: "过小上下文模型",
      modelId: "short-context-model",
      contextWindow: 32_767
    }).expect(400);
    expect(invalidCreate.body.error).toMatchObject({
      code: "VALIDATION_ERROR",
      details: [{ path: "contextWindow", message: "模型上下文不能低于 32768 Token" }]
    });

    const invalidUpdate = await request(runtime.app).patch(`/api/models/${modelId}`).send({ contextWindow: 32_767 }).expect(400);
    expect(invalidUpdate.body.error).toMatchObject({
      code: "VALIDATION_ERROR",
      details: [{ path: "contextWindow", message: "模型上下文不能低于 32768 Token" }]
    });

    const minimum = await request(runtime.app).patch(`/api/models/${modelId}`).send({ contextWindow: 32_768 }).expect(200);
    expect(minimum.body.data.contextWindow).toBe(32_768);
  });

  it("供应商模型列表结构不标准时仍可回退测试已配置模型", async () => {
    const { providerId } = await configureAi();
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ models: [] }), { status: 200 });
      const body = JSON.parse(String(init?.body)) as { model?: string; max_tokens?: number };
      expect(body).toMatchObject({ model: "mock-novel-model", max_tokens: 10 });
      return new Response(JSON.stringify({ choices: [{ message: { content: "连接成功" } }] }), { status: 200 });
    });

    const tested = await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    expect(tested.body.data).toMatchObject({ ok: true, availableModels: [], provider: { connectionStatus: "success" } });
  });

  it("连接测试必须用 max_tokens=10 收到正文或 thinking", async () => {
    const { providerId } = await configureAi();
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as { max_tokens?: number };
      expect(body.max_tokens).toBe(10);
      return new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });

    const tested = await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    expect(tested.body.data).toMatchObject({ ok: false, provider: { connectionStatus: "failed" } });
    expect(tested.body.data.error).toContain("响应缺少可用回复");
  });

  it("连接测试在只有 thinking 时也视为成功", async () => {
    const { providerId } = await configureAi();
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as { max_tokens?: number };
      expect(body.max_tokens).toBe(10);
      return new Response(JSON.stringify({
        choices: [{ message: { content: "", reasoning_content: "正在确认连接。" } }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });

    const tested = await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    expect(tested.body.data).toMatchObject({
      ok: true,
      availableModels: ["mock-novel-model"],
      provider: { connectionStatus: "success" }
    });
  });

  it("连接测试拒绝成功状态下的超大模型列表响应", async () => {
    const { providerId } = await configureAi();
    fetchMock.mockImplementation(async () => new Response("{}", {
      status: 200,
      headers: { "Content-Length": String(AI_RESPONSE_MAX_BYTES + 1) }
    }));

    const tested = await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    expect(tested.body.data).toMatchObject({
      ok: false,
      provider: { connectionStatus: "failed" }
    });
    expect(tested.body.data.error).toContain("AI 供应商响应超过");
  });

  it("可以单独测试指定模型并使用该模型标识符", async () => {
    const { providerId, modelId } = await configureAi();
    fetchMock.mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { model?: string; max_tokens?: number };
      expect(body).toMatchObject({ model: "mock-novel-model", max_tokens: 10 });
      return new Response(JSON.stringify({ choices: [{ message: { content: "模型连接成功" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });

    const tested = await request(runtime.app).post(`/api/models/${modelId}/test`).send({}).expect(200);
    expect(tested.body.data).toMatchObject({
      ok: true,
      model: { id: modelId, modelId: "mock-novel-model" },
      provider: { id: providerId, connectionStatus: "success" }
    });
  });

  it("多模态模型单独测试会发送图片内容块", async () => {
    const { modelId } = await configureAi();
    await request(runtime.app).patch(`/api/models/${modelId}`).send({ multimodalEnabled: true }).expect(200);
    fetchMock.mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages?: Array<{ content?: unknown }>; max_tokens?: number };
      expect(body.max_tokens).toBe(10);
      const content = body.messages?.[0]?.content;
      expect(Array.isArray(content)).toBe(true);
      expect(content).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "text" }),
        expect.objectContaining({ type: "image_url", image_url: expect.objectContaining({ detail: "low" }) })
      ]));
      const imageBlock = (content as Array<Record<string, unknown>>).find((block) => block.type === "image_url");
      const imageUrl = String((imageBlock?.image_url as Record<string, unknown>)?.url);
      expect(imageUrl).toMatch(/^data:image\/png;base64,/u);
      const imageBytes = Buffer.from(imageUrl.slice("data:image/png;base64,".length), "base64");
      expect(imageBytes.subarray(16, 20).readUInt32BE(0)).toBe(128);
      expect(imageBytes.subarray(20, 24).readUInt32BE(0)).toBe(128);
      return new Response(JSON.stringify({ choices: [{ message: { content: "图片连接成功" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });

    const tested = await request(runtime.app).post(`/api/models/${modelId}/test`).send({}).expect(200);
    expect(tested.body.data).toMatchObject({ ok: true, multimodalTested: true });
  });

  it("Anthropic Messages 供应商可以启用多模态模型", async () => {
    const provider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
      name: "Anthropic 测试供应商",
      protocol: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-anthropic-test",
      status: "enabled"
    }).expect(201);
    const model = await request(runtime.app).post(`/api/providers/${provider.body.data.id}/models`).send({
      displayName: "Anthropic 多模态模型",
      modelId: "claude-test",
      multimodalEnabled: true
    }).expect(201);
    expect(model.body.data.multimodalEnabled).toBe(true);
  });

  it("模型默认开启 thinking，可独立设置思考强度并按模型关闭", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "验证默认思考参数",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(201);

    await request(runtime.app).patch(`/api/models/${modelId}`).send({ thinkingEffort: "extreme" }).expect(400);
    expectedThinkingEffort = "xhigh";
    const effortUpdated = await request(runtime.app).patch(`/api/models/${modelId}`).send({ thinkingEffort: "xhigh" }).expect(200);
    expect(effortUpdated.body.data.thinkingEffort).toBe("xhigh");
    const providerTested = await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    expect(providerTested.body.data.ok).toBe(true);
    expectedThinkingEffort = "max";
    const maxEffortUpdated = await request(runtime.app).patch(`/api/models/${modelId}`).send({ thinkingEffort: "max" }).expect(200);
    expect(maxEffortUpdated.body.data.thinkingEffort).toBe("max");
    const modelTested = await request(runtime.app).post(`/api/models/${modelId}/test`).send({}).expect(200);
    expect(modelTested.body.data.ok).toBe(true);
    expectedThinkingEffort = "auto";
    const autoEffortUpdated = await request(runtime.app).patch(`/api/models/${modelId}`).send({ thinkingEffort: "auto" }).expect(200);
    expect(autoEffortUpdated.body.data.thinkingEffort).toBe("auto");
    const autoModelTested = await request(runtime.app).post(`/api/models/${modelId}/test`).send({}).expect(200);
    expect(autoModelTested.body.data.ok).toBe(true);
    await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "验证自动思考强度参数",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(201);

    expectedThinkingEffort = undefined;
    expectedThinkingType = "disabled";
    const updated = await request(runtime.app).patch(`/api/models/${modelId}`).send({ thinkingEnabled: false }).expect(200);
    expect(updated.body.data.thinkingEnabled).toBe(false);
    expect(updated.body.data.thinkingEffort).toBe("auto");
    await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "验证关闭思考参数",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(201);
  });

  it("供应商可切换 thinking.type 的 enabled 与 adaptive", async () => {
    const { providerId, modelId } = await configureAi();
    const invalid = await request(runtime.app).patch(`/api/providers/${providerId}`).send({ thinkingType: "unsupported" }).expect(400);
    expect(invalid.body.error.code).toBe("VALIDATION_ERROR");

    const updated = await request(runtime.app).patch(`/api/providers/${providerId}`).send({ thinkingType: "adaptive" }).expect(200);
    expect(updated.body.data.thinkingType).toBe("adaptive");
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    expectedThinkingType = "adaptive";
    await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "验证自适应思考参数",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(201);

    await request(runtime.app).patch(`/api/models/${modelId}`).send({ thinkingEnabled: false }).expect(200);
    expectedThinkingType = "disabled";
    await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "验证关闭思考仍发送 disabled",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(201);
  });

  it("供应商可配置长分析请求超时并拒绝范围外数值", async () => {
    const { providerId } = await configureAi();
    await request(runtime.app).patch(`/api/providers/${providerId}`).send({ analysisTimeoutSeconds: 29 }).expect(400);
    await request(runtime.app).patch(`/api/providers/${providerId}`).send({ analysisTimeoutSeconds: 3_601 }).expect(400);

    const updated = await request(runtime.app)
      .patch(`/api/providers/${providerId}`)
      .send({ analysisTimeoutSeconds: 900 })
      .expect(200);
    expect(updated.body.data.analysisTimeoutSeconds).toBe(900);
    expect(runtime.database.get("SELECT analysis_timeout_seconds FROM providers WHERE id = ?", providerId)).toEqual({
      analysis_timeout_seconds: 900
    });
  });

  it("Kimi 模型默认温度为 1 并保留用户手动设置", async () => {
    const provider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
      name: "Kimi 测试供应商",
      baseUrl: "https://api.kimi.com/coding/v1",
      apiKey: "sk-kimi-test-value",
      status: "enabled"
    }).expect(201);
    const model = await request(runtime.app).post(`/api/providers/${provider.body.data.id}/models`).send({
      displayName: "Kimi Coding",
      modelId: "kimi-for-coding"
    }).expect(201);
    expect(model.body.data.preset.temperature).toBe(1);

    await request(runtime.app).post(`/api/providers/${provider.body.data.id}/test`).send({}).expect(200);
    await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "使用 Kimi 默认温度",
      scope: { type: "chapter", chapterId },
      modelId: model.body.data.id
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "使用 Kimi 自定义温度",
      scope: { type: "chapter", chapterId },
      modelId: model.body.data.id,
      parameters: { temperature: 0.2 }
    }).expect(201);

    const calls = await request(runtime.app).get(`/api/works/${workId}/ai-calls`).expect(200);
    const temperatures: number[] = calls.body.data
      .filter((call: { model: { id: string }; taskType: string }) => call.model.id === model.body.data.id && call.taskType === "chat")
      .map((call: { parameters: { temperature?: number } }) => Number(call.parameters.temperature));
    expect(temperatures.sort((left, right) => left - right)).toEqual([0.2, 1]);
  });

  it("AI 工具设置支持 calculate_time 并兼容旧默认工具配置", async () => {
    const legacyDefaultTools = ["story_index", "read_chapters", "grep", "search_story_entities", "read_character_sections", "search_drafts", "image"];
    runtime.database.run("UPDATE work_ai_settings SET agent_tools_json = ? WHERE work_id = ?", JSON.stringify(legacyDefaultTools), workId);

    const migrated = await request(runtime.app).get(`/api/works/${workId}/ai-settings`).expect(200);
    expect(migrated.body.data.agentTools).toEqual([...legacyDefaultTools, "calculate_time"]);

    const selected = await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ agentTools: ["calculate_time"] }).expect(200);
    expect(selected.body.data.agentTools).toEqual(["calculate_time"]);

    const disabled = await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ agentTools: [] }).expect(200);
    expect(disabled.body.data.agentTools).toEqual([]);
  });

  it("Gemini endpoint 或模型名命中时不发送 thinking 字段", async () => {
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ agentTools: [] }).expect(200);
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "mock-model" }] }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as { model?: string; stream?: boolean; thinking?: unknown };
      expect(body).not.toHaveProperty("thinking");
      if (body.stream) {
        return new Response("data: {\"choices\":[{\"delta\":{\"content\":\"Gemini\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n", {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "Gemini" } }] }), { status: 200 });
    });

    const endpointProvider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
      name: "Gemini endpoint 测试",
      baseUrl: "https://gemini-compatible.test/v1",
      apiKey: "sk-gemini-endpoint-test",
      status: "enabled"
    }).expect(201);
    const endpointModel = await request(runtime.app).post(`/api/providers/${endpointProvider.body.data.id}/models`).send({
      displayName: "兼容模型",
      modelId: "mock-model"
    }).expect(201);
    await request(runtime.app).post(`/api/providers/${endpointProvider.body.data.id}/test`).send({}).expect(200);
    await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "测试 Gemini endpoint 参数",
      scope: { type: "chapter", chapterId },
      modelId: endpointModel.body.data.id
    }).expect(200).expect("Content-Type", /text\/event-stream/u);

    const modelProvider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
      name: "Gemini model 测试",
      baseUrl: "https://generic-ai.test/v1",
      apiKey: "sk-gemini-model-test",
      status: "enabled"
    }).expect(201);
    const model = await request(runtime.app).post(`/api/providers/${modelProvider.body.data.id}/models`).send({
      displayName: "Gemini 模型",
      modelId: "gemini-2.5-flash"
    }).expect(201);
    await request(runtime.app).post(`/api/providers/${modelProvider.body.data.id}/test`).send({}).expect(200);
    await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "测试 Gemini model 参数",
      scope: { type: "chapter", chapterId },
      modelId: model.body.data.id
    }).expect(201);
  });

  it("平台供应商可被多本书复用，并在内置提示词后追加平台和书籍提示词", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    const secondWork = await request(runtime.app).post("/api/works").send({ title: "第二本 AI 作品" }).expect(201);
    const secondVolume = await request(runtime.app).post(`/api/works/${secondWork.body.data.id}/volumes`).send({ title: "第二卷" }).expect(201);
    const secondChapter = await request(runtime.app).post(`/api/works/${secondWork.body.data.id}/chapters`).send({
      volumeId: secondVolume.body.data.id,
      title: "第二章",
      content: "第二本书的正文。"
    }).expect(201);

    const platformProviders = await request(runtime.app).get("/api/platform/ai/providers").expect(200);
    expect(platformProviders.body.data.map((item: { id: string }) => item.id)).toContain(providerId);
    const sharedModels = await request(runtime.app).get(`/api/works/${secondWork.body.data.id}/models`).expect(200);
    expect(sharedModels.body.data.map((item: { id: string }) => item.id)).toContain(modelId);

    await request(runtime.app).patch("/api/platform/ai/settings").send({ systemPrompt: "平台追加：保持克制叙事。" }).expect(200);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ systemPrompt: "本书追加：哥斯拉不得离开地球。" }).expect(200);
    const updatedModel = await request(runtime.app).patch(`/api/models/${modelId}`).send({ contextWindow: 32_768 }).expect(200);
    expect(updatedModel.body.data.contextWindow).toBe(32_768);

    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      expect(body.messages[0]?.content).toContain("作者锁定的事实是不可违反的硬约束");
      expect(body.messages[0]?.content).toContain("平台追加：保持克制叙事。");
      expect(body.messages[0]?.content).toContain("本书追加：哥斯拉不得离开地球。");
      return new Response(JSON.stringify({ choices: [{ message: { content: "提示词已生效。" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const measured = await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "检查提示词",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(201);
    expect(measured.body.data.contextUsage).toMatchObject({ modelId, contextWindow: 32_768 });
    expect(measured.body.data.contextUsage.inputTokens).toBeGreaterThan(0);
    await request(runtime.app).put(`/api/works/${secondWork.body.data.id}/task-defaults/chat`).send({ modelId }).expect(200);
    expect(secondChapter.body.data.title).toBe("第二章");
  });

  it("功能模型列表排除禁用模型但保留历史任务中的模型", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "book-analysis",
      scope: { type: "book" },
      modelId
    }).expect(201);

    const availableBeforeDisable = await request(runtime.app).get(`/api/works/${workId}/models`).expect(200);
    expect(availableBeforeDisable.body.data.map((model: { id: string }) => model.id)).toContain(modelId);

    await request(runtime.app).patch(`/api/models/${modelId}`).send({ enabled: false }).expect(200);

    const availableAfterDisable = await request(runtime.app).get(`/api/works/${workId}/models`).expect(200);
    expect(availableAfterDisable.body.data.map((model: { id: string }) => model.id)).not.toContain(modelId);
    const tasks = await request(runtime.app).get(`/api/works/${workId}/tasks`).expect(200);
    expect(tasks.body.data.items.find((item: { id: string }) => item.id === task.body.data.id)?.model)
      .toMatchObject({ id: modelId, modelId: "mock-novel-model" });
  });

  it("按模型上下文比例裁剪全书概要引用", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    setLegacyModelContextWindow(modelId, 1_024);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ bookSummaryContextPercent: 25 }).expect(200);
    runtime.store.db.run(
      `INSERT INTO chapter_insights (id, chapter_id, chapter_version, summary, events_json, characters_json,
       settings_json, evidence_json, uncertainties_json, status, created_at) VALUES (?, ?, ?, ?, '[]', '[]', '[]', '[]', '[]', 'review', ?)`,
      "insight-book-summary-budget",
      chapterId,
      1,
      `${"较早概要。".repeat(120)}保留最新概要。`,
      "2026-07-15T00:00:00.000Z"
    );
    let sentContext = "";
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      sentContext = body.messages[1]?.content ?? "";
      return new Response(JSON.stringify({ choices: [{ message: { content: "已根据概要回答。" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "根据全书概要回答。",
      scope: { type: "entities", includeBookSummary: true },
      modelId
    }).expect(201);

    expect(sentContext).toContain("本卷其余章节概要已按预算折叠");
    expect(sentContext).toContain("较早概要");
    expect(sentContext).toContain("保留最新概要");
    expect(estimateAiTokens(sentContext)).toBeLessThan(450);
  });

  it("无上下文请求只携带用户主动添加的正文引用", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    let sentPrompt = "";
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      sentPrompt = body.messages[1]?.content ?? "";
      return new Response(JSON.stringify({ choices: [{ message: { content: "仅根据主动引用回答。" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "只检查我添加的引用。",
      scope: { type: "none" },
      modelId,
      citations: [{ chapterId, chapterTitle: "第一章", startLine: 1, endLine: 1, text: "用户主动引用的句子。" }]
    }).expect(201);

    expect(sentPrompt).toContain("[第一章 L1]");
    expect(sentPrompt).toContain("用户主动引用的句子。");
    expect(sentPrompt).not.toContain("林舟启动了飞船。");
    expect(sentPrompt).not.toContain("跃迁后必须冷却十二小时");
  });

  it("作品全局开关自动注入设定且与主动注入合并为一次", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      alwaysIncludeSettingInfo: true,
      agentTools: []
    }).expect(200);
    const sentContexts: string[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      sentContexts.push(body.messages[1]?.content ?? "");
      return new Response(JSON.stringify({ choices: [{ message: { content: "设定上下文已生效。" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    for (const includeSettingInfo of [false, true]) {
      await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
        taskType: "chat",
        instruction: "检查设定上下文。",
        scope: { type: "none", includeSettingInfo },
        modelId
      }).expect(201);
    }

    expect(sentContexts).toHaveLength(2);
    for (const context of sentContexts) {
      expect(context).toContain("跃迁后必须冷却十二小时");
      expect(context.match(/<locked_settings>/gu)).toHaveLength(1);
    }
  });

  it("无上下文请求将 @ 章节的当前保存正文作为显式上下文发送", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    let sentPrompt = "";
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      sentPrompt = body.messages[1]?.content ?? "";
      return new Response(JSON.stringify({ choices: [{ message: { content: "已读取主动引用章节。" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "概括我 @ 的章节。",
      scope: { type: "none", chapterIds: [chapterId] },
      modelId
    }).expect(201);

    expect(sentPrompt).toContain("作者主动引用的章节");
    expect(sentPrompt).toContain("第一章");
    expect(sentPrompt).toContain("林舟启动了飞船。");
    expect(sentPrompt).not.toContain("跃迁后必须冷却十二小时");
  });

  it("无上下文作品问题会收到主动工具指引并通过目录读取作品信息", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    let completionCount = 0;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      completionCount += 1;
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content?: string }>; tools?: Array<{ function?: { name?: string } }> };
      if (completionCount === 1) {
        expect(body.messages[0]?.content).toContain("预加载上下文为空或不足时，必须先调用工具主动查询");
        expect(body.messages[0]?.content).toContain("整体介绍、作品基本信息、目录、最新剧情、情节先后或章节定位优先调用 story_index");
        expect(body.messages[1]?.content).toContain("本轮未预加载作品上下文");
        expect(body.tools?.map((tool) => tool.function?.name)).toContain("story_index");
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: "project-index", type: "function", function: { name: "story_index", arguments: "{}" } }] } }] }), { status: 200 });
      }
      const toolMessage = body.messages.find((message) => message.role === "tool");
      expect(toolMessage?.content).toContain('"title":"AI 测试作品"');
      expect(toolMessage?.content).toContain('"chapterCount":1');
      return new Response(JSON.stringify({ choices: [{ message: { content: "这是《AI 测试作品》，当前包含一章。" } }] }), { status: 200 });
    });

    const response = await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "这是一个什么项目？",
      scope: { type: "none" },
      modelId
    }).expect(201);

    expect(response.body.data.content).toBe("这是《AI 测试作品》，当前包含一章。");
    expect(response.body.data.toolCalls).toEqual([expect.objectContaining({ name: "story_index", status: "completed" })]);
    expect(completionCount).toBe(2);
  });

  it("story_index 首页独立返回第二十一章作为结构最新章节并明确 nextOffset", async () => {
    const volumeId = String(runtime.store.getChapter(chapterId).volumeId);
    const addedChapters = Array.from({ length: 20 }, (_, index) => runtime.store.createChapter(workId, {
      volumeId,
      title: `第${index + 2}章`,
      content: `第${index + 2}章正文。`
    }));
    const latestChapterId = String(addedChapters.at(-1)?.id);
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    let completionCount = 0;
    let observedToolResult: Record<string, unknown> = {};
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      completionCount += 1;
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content?: string }> };
      if (completionCount === 1) {
        expect(body.messages[0]?.content).toContain("latestChaptersByStructure 是不受当前分页影响的结构最新章节");
        expect(body.messages[0]?.content).toContain("nextOffset 非空时用该值作为 offset");
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{
          id: "long-story-index",
          type: "function",
          function: { name: "story_index", arguments: "{}" }
        }] } }] }), { status: 200 });
      }
      const toolMessage = body.messages.find((message) => message.role === "tool");
      observedToolResult = JSON.parse(String(toolMessage?.content ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: "已识别第二十一章为最新剧情。" } }] }), { status: 200 });
    });

    const response = await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "找出当前最新剧情。",
      scope: { type: "none" },
      modelId
    }).expect(201);

    expect(observedToolResult).toMatchObject({
      ok: true,
      data: {
        totalChapters: 21,
        offset: 0,
        nextOffset: 20,
        latestChaptersByStructure: [{
          id: latestChapterId,
          title: "第21章",
          storyOrder: { chapter: { order: 20, isLatestByStructure: true } }
        }]
      }
    });
    expect(observedToolResult).not.toMatchObject({ data: { chapters: expect.arrayContaining([{ id: latestChapterId }]) } });
    expect(response.body.data.content).toBe("已识别第二十一章为最新剧情。");
    expect(completionCount).toBe(2);
  });

  it("普通 Chat 的 grep 同时返回关键词结构末位与同轨道时间末位", async () => {
    await request(runtime.app).patch(`/api/chapters/${chapterId}`).send({
      content: "密钥在主线后期被交接。"
    }).expect(200);
    const flashbackVolume = await request(runtime.app).post(`/api/works/${workId}/volumes`).send({
      title: "倒叙卷",
      storyOrder: 8
    }).expect(201);
    const flashbackChapter = await request(runtime.app).post(`/api/works/${workId}/chapters`).send({
      volumeId: flashbackVolume.body.data.id,
      title: "倒叙末章",
      content: "密钥在倒叙中再次出现。"
    }).expect(201);
    const track = await request(runtime.app).post(`/api/works/${workId}/timeline-tracks`).send({ name: "主线" }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/timeline`).send({
      name: "主线交接",
      trackId: track.body.data.id,
      timeLabel: "第 42 日",
      timeSort: 42,
      chapterIds: [chapterId],
      status: "confirmed"
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/timeline`).send({
      name: "倒叙回忆",
      trackId: track.body.data.id,
      timeLabel: "第 5 日",
      timeSort: 5,
      chapterIds: [flashbackChapter.body.data.id],
      status: "confirmed"
    }).expect(201);
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    let completionCount = 0;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      completionCount += 1;
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content?: string }> };
      if (completionCount === 1) {
        expect(body.messages[0]?.content).toContain("grep.latestOccurrences.byStructure");
        expect(body.messages[0]?.content).toContain("grep.latestOccurrences.byTimelineTrack");
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{
          id: "ordinary-last-keyword",
          type: "function",
          function: { name: "grep", arguments: { keyword: "密钥", limit: 1 } }
        }] } }] }), { status: 200 });
      }
      const toolMessage = body.messages.find((message) => message.role === "tool");
      const result = JSON.parse(String(toolMessage?.content ?? "{}")) as Record<string, unknown>;
      expect(result).toMatchObject({
        ok: true,
        data: {
          latestOccurrences: {
            byStructure: [{ chapterId: flashbackChapter.body.data.id, paragraphOrder: 0 }],
            byTimelineTrack: [{
              trackId: track.body.data.id,
              timeSort: 42,
              timeLabel: "第 42 日",
              occurrence: { chapterId, paragraphOrder: 0 }
            }]
          },
          matches: [{ chapterId: flashbackChapter.body.data.id, paragraphOrder: 0 }]
        }
      });
      return new Response(JSON.stringify({ choices: [{ message: { content: "结构末位在倒叙末章，但主线最后时间是第 42 日。" } }] }), { status: 200 });
    });

    const response = await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "密钥最后在哪里出现？",
      scope: { type: "none" },
      modelId
    }).expect(201);

    expect(response.body.data.content).toContain("第 42 日");
    expect(completionCount).toBe(2);
  });

  it("已开始的对话锁定工具集，中途改作品设置不影响该对话", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      agentTools: ["story_index", "read_chapters", "grep", "search_story_entities", "read_character_sections", "search_drafts"]
    }).expect(200);

    const created = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({ title: "锁定工具对话" }).expect(201);
    const conversationId = created.body.data.id as string;
    expect(created.body.data.agentTools).toEqual([
      "story_index",
      "read_chapters",
      "grep",
      "search_story_entities",
      "read_character_sections",
      "search_drafts"
    ]);

    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      agentTools: ["story_index"]
    }).expect(200);

    let lockedTools: string[] | undefined;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as {
        tools?: Array<{ function?: { name?: string } }>;
        messages?: Array<{ role?: string; content?: string }>;
      };
      lockedTools = body.tools?.map((tool) => tool.function?.name).filter((name): name is string => Boolean(name));
      expect(body.messages?.[0]?.content).toContain("当前可用作品查询工具：story_index、read_chapters、grep、search_story_entities、read_character_sections、search_drafts");
      return new Response(JSON.stringify({
        choices: [{ message: { content: "仍可使用创建时锁定的工具集。" } }]
      }), { status: 200 });
    });

    const streamed = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "确认本对话工具是否仍完整。",
      scope: { type: "none" },
      modelId,
      conversationId
    }).expect(200);

    expect(streamed.text).toContain("仍可使用创建时锁定的工具集。");
    expect(lockedTools).toEqual([
      "story_index",
      "read_chapters",
      "grep",
      "search_story_entities",
      "read_character_sections",
      "search_drafts"
    ]);

    const summary = await request(runtime.app).get(`/api/ai-conversations/${conversationId}`).expect(200);
    expect(summary.body.data.agentTools).toEqual(lockedTools);

    let newConversationTools: string[] | undefined;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as { tools?: Array<{ function?: { name?: string } }> };
      newConversationTools = body.tools?.map((tool) => tool.function?.name).filter((name): name is string => Boolean(name));
      return new Response(JSON.stringify({
        choices: [{ message: { content: "新对话只看到 story_index。" } }]
      }), { status: 200 });
    });

    const fresh = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "新对话应使用最新设置。",
      scope: { type: "none" },
      modelId
    }).expect(200);
    expect(fresh.text).toContain("新对话只看到 story_index。");
    expect(newConversationTools).toEqual(["story_index"]);
  });

  it("聊天默认暴露聚合查询工具并把结果回传给模型", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    let completionCount = 0;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      completionCount += 1;
      const body = JSON.parse(String(init?.body)) as { tools?: Array<{ function?: { name?: string } }>; messages: Array<{ role: string; content?: string }> };
      expect(body.tools?.map((tool) => tool.function?.name)).toEqual(["story_index", "read_chapters", "grep", "search_story_entities", "read_character_sections", "search_drafts", "image", "calculate_time"]);
      if (completionCount === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: "tool-call-1", type: "function", function: { name: "story_index", arguments: "{\"limit\":1}" } }] } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const toolMessage = body.messages.find((message) => message.role === "tool");
      expect(toolMessage?.content).toContain("第一章");
      expect(toolMessage?.content).toContain('"storyOrdering"');
      expect(toolMessage?.content).toContain('"storyOrder"');
      return new Response(JSON.stringify({ choices: [{ message: { content: "已根据章节目录回答。" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const response = await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "先查看章节目录再回答。",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(201);

    expect(response.body.data.content).toBe("已根据章节目录回答。");
    expect(response.body.data.toolCalls).toEqual([
      expect.objectContaining({ id: "tool-call-1", name: "story_index", calledAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u), status: "completed", arguments: { offset: 0, limit: 1 } })
    ]);
    expect(completionCount).toBe(2);
  });

  it("Agent 搜索草稿时明确返回未确认语义且不把草稿当作正式事实", async () => {
    await request(runtime.app).post(`/api/works/${workId}/drafts`).send({
      draftType: "setting",
      title: "跃迁失忆备选",
      content: "也许每次跃迁都会失去一段记忆，但这个方向可能永远不会采用。"
    }).expect(201);
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    let completionCount = 0;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      completionCount += 1;
      const body = JSON.parse(String(init?.body)) as {
        tools?: Array<{ function?: { name?: string; description?: string } }>;
        messages: Array<{ role: string; content?: string }>;
      };
      const draftTool = body.tools?.find((tool) => tool.function?.name === "search_drafts");
      expect(draftTool?.function?.description).toContain("可能永远不会写入正文或正式设定");
      expect(body.messages[0]?.content).toContain("不得把它当作故事事实");
      if (completionCount === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{
          id: "draft-search",
          type: "function",
          function: { name: "search_drafts", arguments: { query: "跃迁", draftType: "setting", limit: 5 } }
        }] } }] }), { status: 200 });
      }
      const toolMessage = body.messages.find((message) => message.role === "tool");
      expect(toolMessage?.content).toContain("这些内容是作者记录的未确认临时想法");
      expect(toolMessage?.content).toContain("跃迁失忆备选");
      expect(toolMessage?.content).toContain("这个方向可能永远不会采用");
      return new Response(JSON.stringify({ choices: [{ message: { content: "草稿里有一个未确认的跃迁失忆方向，不能视为正式设定。" } }] }), { status: 200 });
    });

    const response = await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "草稿里有没有跃迁相关的备选想法？",
      scope: { type: "none" },
      modelId
    }).expect(201);

    expect(response.body.data.content).toContain("未确认");
    expect(response.body.data.toolCalls).toEqual([
      expect.objectContaining({ name: "search_drafts", status: "completed", arguments: { query: "跃迁", draftType: "setting", limit: 5 } })
    ]);
    expect(completionCount).toBe(2);
  });

  it("种族知识查询向模型返回层级与继承设定", async () => {
    const titan = await request(runtime.app).post(`/api/works/${workId}/races`).send({ name: "泰坦", isExtinct: true, settings: ["体型巨大"] }).expect(201);
    const original = await request(runtime.app).post(`/api/works/${workId}/races`).send({
      name: "原生泰坦",
      parentRaceId: titan.body.data.id,
      settings: ["源自远古"]
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "哥斯拉", gender: "male", isDead: true, raceId: original.body.data.id }).expect(201);
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    let completionCount = 0;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      completionCount += 1;
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content?: string }>;
        tools?: Array<{ function?: {
          name?: string;
          description?: string;
          parameters?: { properties?: { query?: { maxLength?: number }; includePhonetic?: { type?: string; default?: boolean; description?: string } } };
        } }>;
      };
      if (completionCount === 1) {
        const searchTool = body.tools?.find((tool) => tool.function?.name === "search_story_entities");
        expect(searchTool?.function?.description).toContain("gender=unknown 时禁止");
        expect(searchTool?.function?.description).toContain("只有值为 true 才能判定");
        expect(searchTool?.function?.description).toContain("字段为 false 时必须视为仍存活、未灭绝或未解散");
        expect(searchTool?.function?.description).toContain("拼音索引极其缓慢，必须谨慎使用");
        expect(searchTool?.function?.parameters?.properties?.query?.maxLength).toBe(100);
        expect(searchTool?.function?.parameters?.properties?.includePhonetic).toMatchObject({
          type: "boolean",
          default: false,
          description: expect.stringContaining("极其缓慢")
        });
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{
          id: "race-knowledge",
          type: "function",
          function: { name: "search_story_entities", arguments: { query: "泰坦", categories: ["race", "character"] } }
        }] } }] }), { status: 200 });
      }
      const toolMessage = body.messages.find((message) => message.role === "tool");
      expect(toolMessage?.content).toContain('"racePath":"泰坦 / 原生泰坦"');
      expect(toolMessage?.content).toContain('"gender":"male"');
      expect(toolMessage?.content).toContain('"isDead":true');
      expect(toolMessage?.content).toContain('"isExtinct":true');
      expect(toolMessage?.content).toContain('"lineage":[{"id":"' + titan.body.data.id + '","name":"泰坦"}');
      expect(toolMessage?.content).toContain('"value":"体型巨大"');
      return new Response(JSON.stringify({ choices: [{ message: { content: "已读取种族层级。" } }] }), { status: 200 });
    });

    const response = await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "查询泰坦种族层级。",
      scope: { type: "none" },
      modelId
    }).expect(201);

    expect(response.body.data.content).toBe("已读取种族层级。");
    expect(response.body.data.toolCalls).toEqual([expect.objectContaining({ name: "search_story_entities", status: "completed" })]);
  });

  it("时间线实体查询返回可比较时间与关联章节剧情顺序", async () => {
    const track = await request(runtime.app).post(`/api/works/${workId}/timeline-tracks`).send({
      name: "港口主线",
      sortOrder: 3
    }).expect(201);
    const event = await request(runtime.app).post(`/api/works/${workId}/timeline`).send({
      name: "港口密钥交接",
      trackId: track.body.data.id,
      timeLabel: "远航第 42 日",
      timeSort: 42,
      chapterIds: [chapterId],
      status: "confirmed"
    }).expect(201);
    const internalAi = runtime.ai as unknown as {
      executeAgentTool: (
        workId: string,
        toolCall: Record<string, unknown>,
        maximumResultChars?: number
      ) => Promise<{ result: Record<string, unknown> }>;
    };
    const smallBudgetExecution = await internalAi.executeAgentTool(workId, {
      id: "small-budget-timeline-entity",
      type: "function",
      function: { name: "search_story_entities", arguments: { query: "港口密钥", categories: ["timeline"] } }
    }, 1_000);
    expect(JSON.stringify(smallBudgetExecution.result).length).toBeLessThanOrEqual(1_000);
    expect(smallBudgetExecution.result).toMatchObject({
      ok: true,
      data: { storyOrdering: expect.any(Object), matches: expect.any(Array) },
      pagination: { maxChars: 1_000 }
    });
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    let completionCount = 0;
    let observedToolResult: Record<string, unknown> = {};
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      completionCount += 1;
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content?: string }>;
        tools?: Array<{ function?: { name?: string; description?: string } }>;
      };
      if (completionCount === 1) {
        const tool = body.tools?.find((candidate) => candidate.function?.name === "search_story_entities");
        expect(tool?.function?.description).toContain("trackId、timeSort、chapterIds、chapterStoryOrders 与 orderEligible");
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{
          id: "timeline-knowledge",
          type: "function",
          function: { name: "search_story_entities", arguments: { query: "港口密钥", categories: ["timeline"] } }
        }] } }] }), { status: 200 });
      }
      const toolMessage = body.messages.find((message) => message.role === "tool");
      observedToolResult = JSON.parse(String(toolMessage?.content ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: "已读取可比较时间线。" } }] }), { status: 200 });
    });

    const response = await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "查询港口密钥交接在剧情中的时间。",
      scope: { type: "none" },
      modelId
    }).expect(201);

    expect(observedToolResult).toMatchObject({
      ok: true,
      data: {
        storyOrdering: expect.any(Object),
        matches: [expect.objectContaining({
          id: event.body.data.id,
          sourceType: "timeline-event",
          trackId: track.body.data.id,
          track: { id: track.body.data.id, name: "港口主线", sortOrder: 3 },
          timeSort: 42,
          timeLabel: "远航第 42 日",
          chapterIds: [chapterId],
          chapterStoryOrders: [{
            chapterId,
            storyOrder: expect.objectContaining({
              volume: expect.objectContaining({ storyOrder: 0 }),
              chapter: expect.objectContaining({ order: 0 })
            })
          }],
          orderEligible: true,
          status: "confirmed"
        })]
      }
    });
    expect(response.body.data.content).toBe("已读取可比较时间线。");
    expect(response.body.data.toolCalls).toEqual([expect.objectContaining({ name: "search_story_entities", status: "completed" })]);
    expect(completionCount).toBe(2);
  });

  it("覆盖所有查询工具的可选参数组合并把结构化结果交回模型", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    const character = runtime.store.createCharacter(workId, { name: "哥斯拉", gender: "male" });
    const section = runtime.store.createCharacterProfileSection(String(character.id), {
      sectionType: "background",
      title: "背景故事",
      summary: "哥斯拉在远古时期守护地球生态。",
      contentMarkdown: "## 远古时期\n\n哥斯拉守护地球生态。"
    });
    const calls = [
      { id: "index-default", name: "story_index", arguments: {} },
      { id: "index-page", name: "story_index", arguments: { offset: 0, limit: 1 } },
      { id: "chapter-summary", name: "read_chapters", arguments: { chapterIds: [chapterId], include: "summary" } },
      { id: "chapter-content", name: "read_chapters", arguments: { chapterIds: [chapterId], include: "content" } },
      { id: "chapter-both", name: "read_chapters", arguments: { chapterIds: [chapterId], include: "both" } },
      { id: "grep-default", name: "grep", arguments: { keyword: "林舟" } },
      { id: "grep-limit", name: "grep", arguments: { keyword: "林舟", limit: 1 } },
      { id: "knowledge-default", name: "search_story_entities", arguments: { query: "跃迁" } },
      { id: "knowledge-categories", name: "search_story_entities", arguments: { query: "跃迁", categories: ["setting", "character", "race", "organization", "timeline", "relationship", "outline", "foreshadow"], includePhonetic: true } },
      { id: "character-section-summary", name: "read_character_sections", arguments: { sectionIds: [section.id], include: "summary" } },
      { id: "character-section-content", name: "read_character_sections", arguments: { sectionIds: [section.id], include: "content" } },
      { id: "character-section-both", name: "read_character_sections", arguments: { sectionIds: [section.id], include: "both" } }
    ];
    let completionCount = 0;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      completionCount += 1;
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; tool_call_id?: string; content?: string }> };
      if (completionCount === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) } }] }), { status: 200 });
      }
      const results = new Map(body.messages.filter((message) => message.role === "tool").map((message) => [message.tool_call_id, JSON.parse(message.content ?? "{}") as Record<string, unknown>]));
      expect(results.size).toBe(calls.length);
      expect(results.get("index-default")).toMatchObject({
        ok: true,
        data: {
          offset: 0,
          totalChapters: 1,
          storyOrdering: expect.any(Object),
          latestChaptersByStructure: [{ id: chapterId, storyOrder: { chapter: { isLatestByStructure: true } } }]
        }
      });
      expect(results.get("index-page")).toMatchObject({ ok: true, data: { chapters: [{ title: "第一章", storyOrder: { volume: { storyOrder: 0 }, chapter: { order: 0 } } }] } });
      expect(results.get("chapter-summary")).toMatchObject({ ok: true, data: { storyOrdering: expect.any(Object), chapters: [{ chapterId, summary: "", storyOrder: { volume: { storyOrder: 0 }, chapter: { order: 0 } } }] } });
      expect(results.get("chapter-summary")).not.toHaveProperty("data.chapters.0.content");
      expect(results.get("chapter-content")).toMatchObject({ ok: true, data: { chapters: [{ chapterId, content: "林舟启动了飞船。" }] } });
      expect(results.get("chapter-content")).not.toHaveProperty("data.chapters.0.summary");
      expect(results.get("chapter-both")).toMatchObject({ ok: true, data: { chapters: [{ chapterId, summary: "", content: "林舟启动了飞船。" }] } });
      expect(results.get("grep-default")).toMatchObject({
        ok: true,
        data: {
          keyword: "林舟",
          limit: 20,
          storyOrdering: expect.any(Object),
          latestOccurrences: {
            byStructure: [{ chapterId, paragraphOrder: 0 }]
          },
          matches: [{ chapterId, chapterTitle: "第一章", paragraph: "林舟启动了飞船。", paragraphOrder: 0, storyOrder: { volume: { storyOrder: 0 }, chapter: { order: 0 } } }]
        }
      });
      expect(results.get("grep-limit")).toMatchObject({ ok: true, data: { limit: 1, matches: [{ chapterId }] } });
      expect(results.get("knowledge-default")).toMatchObject({ ok: true, data: { query: "跃迁", matchMode: "hybrid_exact" } });
      expect(results.get("knowledge-categories")).toMatchObject({ ok: true, data: { matchMode: "hybrid_exact_phonetic", matches: expect.any(Array) } });
      expect(results.get("character-section-summary")).toMatchObject({ ok: true, data: { sections: [{ sectionId: section.id, characterName: "哥斯拉", gender: "male", summary: "哥斯拉在远古时期守护地球生态。" }] } });
      expect(results.get("character-section-summary")).not.toHaveProperty("data.sections.0.contentMarkdown");
      expect(results.get("character-section-content")).toMatchObject({ ok: true, data: { sections: [{ sectionId: section.id, contentMarkdown: "## 远古时期\n\n哥斯拉守护地球生态。" }] } });
      expect(results.get("character-section-content")).not.toHaveProperty("data.sections.0.summary");
      expect(results.get("character-section-both")).toMatchObject({ ok: true, data: { sections: [{ sectionId: section.id, summary: "哥斯拉在远古时期守护地球生态。", contentMarkdown: "## 远古时期\n\n哥斯拉守护地球生态。" }] } });
      return new Response(JSON.stringify({ choices: [{ message: { content: "工具参数组合均已处理。" } }] }), { status: 200 });
    });

    const response = await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "依次验证所有查询工具。",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(201);

    expect(response.body.data.content).toBe("工具参数组合均已处理。");
    expect(response.body.data.toolCalls).toHaveLength(calls.length);
    expect(response.body.data.toolCalls.every((call: { status: string }) => call.status === "completed")).toBe(true);
  });

  it("所有 AI 查询工具都排除作者的话章节", async () => {
    const chapter = runtime.store.getChapter(chapterId);
    const authorNote = runtime.store.createChapter(workId, {
      volumeId: String(chapter.volumeId),
      title: "作者的话",
      chapterType: "作者的话",
      content: "AUTHOR_NOTE_TOOL_MARKER"
    });
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      agentTools: ["story_index", "read_chapters", "grep", "search_story_entities"]
    }).expect(200);

    const calls = [
      { id: "author-index", name: "story_index", arguments: {} },
      { id: "author-read", name: "read_chapters", arguments: { chapterIds: [String(authorNote.id)], include: "content" } },
      { id: "author-grep", name: "grep", arguments: { keyword: "AUTHOR_NOTE_TOOL_MARKER" } }
    ];
    let completionCount = 0;
    fetchMock.mockImplementation(async (_input, init) => {
      completionCount += 1;
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; tool_call_id?: string; content?: string }> };
      if (completionCount === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments }
        })) } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const results = new Map(body.messages.filter((message) => message.role === "tool").map((message) => [
        message.tool_call_id,
        JSON.parse(message.content ?? "{}") as Record<string, unknown>
      ]));
      expect(results.get("author-index")).toMatchObject({ ok: true, data: { totalChapters: 1, chapters: [{ id: chapterId }] } });
      expect(results.get("author-index")).not.toContain("AUTHOR_NOTE_TOOL_MARKER");
      expect(results.get("author-read")).toMatchObject({
        ok: true,
        data: { chapters: [{ chapterId: authorNote.id, error: { code: "CHAPTER_AUTHOR_NOTE_EXCLUDED" } }] }
      });
      expect(results.get("author-grep")).toMatchObject({ ok: true, data: { matches: [] } });
      return new Response(JSON.stringify({ choices: [{ message: { content: "作者的话未进入查询结果。" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const response = await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "查询正文。",
      scope: { type: "none" },
      modelId
    }).expect(201);

    expect(response.body.data.content).toBe("作者的话未进入查询结果。");
    expect(response.body.data.toolCalls).toHaveLength(calls.length);
    expect(response.body.data.toolCalls.every((call: { status: string }) => call.status === "completed")).toBe(true);
  });

  it("长工具结果按完整结构限制在一万字符内并通过游标续读", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    setLegacyModelContextWindow(modelId, 30_000);
    const content = "长正文。".repeat(3_000);
    runtime.store.saveChapter(chapterId, { content });
    const fragments: string[] = [];
    const maxTokens: number[] = [];
    let compactRequestCount = 0;
    let completionCount = 0;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      completionCount += 1;
      const body = JSON.parse(String(init?.body)) as { max_tokens: number; messages: Array<{ role: string; tool_call_id?: string; content?: string }> };
      if (body.messages[0]?.content?.includes("压缩已完成的 AI 工具调用上下文")) {
        compactRequestCount += 1;
        return new Response(JSON.stringify({ choices: [{ message: { content: "已压缩先前分页正文，仍需继续读取剩余游标。" } }] }), { status: 200 });
      }
      maxTokens.push(body.max_tokens);
      if (completionCount === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{
          id: "long-chapter-first",
          type: "function",
          function: { name: "read_chapters", arguments: { chapterIds: [chapterId], include: "content" } }
        }] } }] }), { status: 200 });
      }
      const latest = body.messages.filter((message) => message.role === "tool").at(-1);
      const result = JSON.parse(latest?.content ?? "{}") as {
        data: { chapters: Array<{ content?: string; _fragment?: { index: number; total: number; path: string | null } }> };
        pagination: { cursor: number; nextCursor: number | null; maxChars: number };
      };
      expect((latest?.content ?? "").length).toBeLessThanOrEqual(10_000);
      expect(result.pagination.maxChars).toBeGreaterThan(0);
      expect(result.pagination.maxChars).toBeLessThanOrEqual(10_000);
      expect(result.data.chapters.every((chapter) => chapter._fragment)).toBe(true);
      fragments.push(...result.data.chapters.map((chapter) => chapter.content ?? ""));
      if (result.pagination.nextCursor !== null) {
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{
          id: `long-chapter-${result.pagination.nextCursor}`,
          type: "function",
          function: {
            name: "read_chapters",
            arguments: { chapterIds: [chapterId], include: "content", cursor: result.pagination.nextCursor }
          }
        }] } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "已读取全部分页正文。" } }] }), { status: 200 });
    });

    const response = await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "分页读取当前章节。",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(201);

    expect(response.body.data.content).toBe("已读取全部分页正文。");
    expect(response.body.data.toolCalls.length).toBeGreaterThan(1);
    expect(response.body.data.toolCalls[1].arguments).toMatchObject({ cursor: expect.any(Number) });
    expect(fragments.join("")).toBe(content);
    expect(maxTokens.every((value) => value > 0)).toBe(true);
    expect(compactRequestCount).toBeGreaterThan(0);
  });

  it("工具结果接近模型上限时先压缩旧工具上下文再拼入新结果", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    setLegacyModelContextWindow(modelId, 16_000);
    runtime.database.run("UPDATE models SET preset_json = ? WHERE id = ?", JSON.stringify({ max_tokens: 1_024 }), modelId);
    runtime.store.saveChapter(chapterId, { content: "分页上下文证据。".repeat(2_500) });
    let completionCount = 0;
    let firstPageContent = "";
    let compactedFirstPage = false;
    let finalMessages: Array<{ role: string; content?: string }> = [];
    const requestInputTokens: number[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      completionCount += 1;
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content?: string }>;
        tools?: unknown[];
      };
      requestInputTokens.push(estimateAiTokens(JSON.stringify(body.messages)));
      if (body.messages[0]?.content?.includes("压缩已完成的 AI 工具调用上下文")) {
        expect(body.tools).toBeUndefined();
        const prefix = "待压缩的工具调用上下文：\n";
        const compactionInput = body.messages[1]?.content ?? "";
        const compactedMessages = JSON.parse(compactionInput.slice(prefix.length)) as Array<{ role: string; content?: string }>;
        compactedFirstPage = compactedMessages.some((message) => message.role === "tool" && message.content === firstPageContent);
        return new Response(JSON.stringify({ choices: [{ message: { content: "已确认前一页包含章节正文证据，后续仍需按游标读取。" } }] }), { status: 200 });
      }
      const toolMessages = body.messages.filter((message) => message.role === "tool");
      if (toolMessages.length === 0) {
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{
          id: "context-page-1",
          type: "function",
          function: { name: "read_chapters", arguments: { chapterIds: [chapterId], include: "content" } }
        }] } }] }), { status: 200 });
      }
      const joined = body.messages.map((message) => message.content ?? "").join("\n");
      if (!joined.includes("已压缩的工具调用上下文")) {
        firstPageContent = toolMessages[0]?.content ?? "";
        const firstPage = JSON.parse(firstPageContent) as { pagination: { nextCursor: number | null } };
        expect(firstPage.pagination.nextCursor).toEqual(expect.any(Number));
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{
          id: "context-page-2",
          type: "function",
          function: {
            name: "read_chapters",
            arguments: { chapterIds: [chapterId], include: "content", cursor: firstPage.pagination.nextCursor }
          }
        }] } }] }), { status: 200 });
      }
      finalMessages = body.messages;
      expect(toolMessages).toHaveLength(1);
      expect(toolMessages[0]?.content).not.toBe(firstPageContent);
      return new Response(JSON.stringify({ choices: [{ message: { content: "已结合压缩摘要和最新分页结果回答。" } }] }), { status: 200 });
    });

    const response = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "读取章节后回答。",
      scope: { type: "none" },
      modelId
    }).expect(200).expect("Content-Type", /text\/event-stream/u);

    expect(response.text).toContain('event: delta\ndata: {"delta":"已结合压缩摘要和最新分页结果回答。"}');
    expect(response.text).toContain("event: context_compacted");
    expect(response.text).toContain('event: process_step\ndata: {"id":"process_');
    expect(response.text).toContain('"type":"context_compaction"');
    const compactPayload = JSON.parse(response.text.match(/event: context_compacted\ndata: ([^\n]+)/u)?.[1] ?? "{}") as {
      contextUsage?: { inputTokens?: number; contextWindow?: number; usagePercent?: number };
    };
    expect(compactPayload.contextUsage?.inputTokens).toBeGreaterThan(0);
    expect(compactPayload.contextUsage?.inputTokens).toBeLessThan(compactPayload.contextUsage?.contextWindow ?? 0);
    expect(compactPayload.contextUsage?.usagePercent).toEqual(expect.any(Number));
    const completePayload = JSON.parse(response.text.match(/event: complete\ndata: ([^\n]+)/u)?.[1] ?? "{}") as {
      contextUsage?: { inputTokens?: number; contextWindow?: number };
      toolCalls?: unknown[];
    };
    expect(completePayload.contextUsage?.inputTokens).toBeLessThan(completePayload.contextUsage?.contextWindow ?? 0);
    expect(completePayload.toolCalls?.length).toBe(2);
    expect(completionCount).toBe(4);
    expect(compactedFirstPage).toBe(true);
    const finalContext = finalMessages.map((message) => message.content ?? "").join("\n");
    expect(finalContext).toContain("已压缩的工具调用上下文");
    expect(finalContext).toContain("已确认前一页包含章节正文证据");
    expect(finalContext).not.toContain(firstPageContent);
    const firstUserMessageIndex = finalMessages.findIndex((message) => message.role === "user");
    expect(firstUserMessageIndex).toBeGreaterThan(0);
    expect(finalMessages.slice(0, firstUserMessageIndex).every((message) => message.role === "system")).toBe(true);
    expect(finalMessages[firstUserMessageIndex]?.content).toContain("已压缩的工具调用上下文");
    expect(finalMessages.filter((message) => message.role === "system").every((message) => !message.content?.includes("已压缩的工具调用上下文"))).toBe(true);
    expect(requestInputTokens.every((tokens) => tokens < 16_000)).toBe(true);
  });

  it("模型上下文较小时按剩余预算缩小工具结果分页", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    setLegacyModelContextWindow(modelId, 6_000);
    runtime.store.saveChapter(chapterId, { content: "小窗口分页正文。".repeat(2_000) });
    let completionCount = 0;
    const returnedPages: Array<{ pagination: { maxChars: number; nextCursor: number | null } }> = [];
    const requestTokenEstimates: number[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      completionCount += 1;
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content?: string }> };
      const toolMessage = body.messages.find((message) => message.role === "tool");
      if (!toolMessage) {
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{
          id: "small-context-page",
          type: "function",
          function: { name: "read_chapters", arguments: { chapterIds: [chapterId], include: "content" } }
        }] } }] }), { status: 200 });
      }
      returnedPages.push(JSON.parse(toolMessage.content ?? "{}") as { pagination: { maxChars: number; nextCursor: number | null } });
      requestTokenEstimates.push(estimateAiTokens(JSON.stringify(body.messages)));
      return new Response(JSON.stringify({ choices: [{ message: { content: "已读取适配小窗口的结构化分页。" } }] }), { status: 200 });
    });

    const response = await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "读取章节后回答。",
      scope: { type: "none" },
      modelId
    });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.data.content).toBe("已读取适配小窗口的结构化分页。");
    expect(completionCount).toBe(2);
    expect(returnedPages[0]?.pagination.maxChars).toBeLessThan(10_000);
    expect(returnedPages[0]?.pagination.nextCursor).toEqual(expect.any(Number));
    expect(Math.max(...requestTokenEstimates)).toBeLessThan(6_000);
  });

  it("模型最大输出达到上下文 95% 时工具上下文也会先压缩", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    setLegacyModelContextWindow(modelId, 128_000);
    runtime.database.run("UPDATE models SET preset_json = ? WHERE id = ?", JSON.stringify({ max_tokens: 110_000 }), modelId);
    runtime.store.saveChapter(chapterId, { content: "工具分页证据。".repeat(2_500) });
    let completionCount = 0;
    let compactRequestCount = 0;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      completionCount += 1;
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content?: string }>; tools?: unknown[] };
      if (body.messages[0]?.content?.includes("压缩已完成的 AI 工具调用上下文")) {
        compactRequestCount += 1;
        expect(body.tools).toBeUndefined();
        return new Response(JSON.stringify({ choices: [{ message: { content: "已压缩旧工具结果，继续读取剩余分页。" } }] }), { status: 200 });
      }
      const toolMessages = body.messages.filter((message) => message.role === "tool");
      if (toolMessages.length === 0) {
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{
          id: "output-threshold-page-1",
          type: "function",
          function: { name: "read_chapters", arguments: { chapterIds: [chapterId], include: "content" } }
        }] } }] }), { status: 200 });
      }
      if (!body.messages.some((message) => message.content?.includes("已压缩的工具调用上下文"))) {
        const firstPage = JSON.parse(toolMessages.at(-1)?.content ?? "{}") as { pagination: { nextCursor: number | null } };
        expect(firstPage.pagination.nextCursor).not.toBeNull();
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{
          id: "output-threshold-page-2",
          type: "function",
          function: { name: "read_chapters", arguments: { chapterIds: [chapterId], include: "content", cursor: firstPage.pagination.nextCursor } }
        }] } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "已完成工具上下文回答。" } }] }), { status: 200 });
    });

    const response = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "读取章节后回答。",
      scope: { type: "none" },
      modelId
    }).expect(200).expect("Content-Type", /text\/event-stream/u);

    expect(response.text).toContain('event: delta\ndata: {"delta":"已完成工具上下文回答。"}');
    expect(response.text).toContain("event: context_compacted");
    expect(compactRequestCount).toBe(1);
    expect(completionCount).toBe(4);
  });

  it("把无效工具参数和未知工具作为英文错误结果反馈给模型", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    let completionCount = 0;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      completionCount += 1;
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content?: string }> };
      if (completionCount === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [
          { id: "bad-json", type: "function", function: { name: "story_index", arguments: "{" } },
          { id: "bad-index", type: "function", function: { name: "story_index", arguments: { limit: 0, extra: true } } },
          { id: "bad-read", type: "function", function: { name: "read_chapters", arguments: { chapterIds: [], include: "invalid" } } },
          { id: "bad-character-section", type: "function", function: { name: "read_character_sections", arguments: { sectionIds: [], include: "invalid" } } },
          { id: "bad-grep", type: "function", function: { name: "grep", arguments: { keyword: "", limit: 0 } } },
          { id: "bad-query", type: "function", function: { name: "search_story_entities", arguments: { query: "", categories: ["unknown"] } } },
          { id: "unknown", type: "function", function: { name: "write_chapter", arguments: {} } }
        ] } }] }), { status: 200 });
      }
      const errors = body.messages.filter((message) => message.role === "tool").map((message) => JSON.parse(message.content ?? "{}") as { ok: boolean; error: { code: string; message: string } });
      expect(errors).toHaveLength(7);
      expect(errors.every((result) => result.ok === false && /^[A-Z_]+$/u.test(result.error.code))).toBe(true);
      expect(errors.every((result) => /Invalid|not available/u.test(result.error.message))).toBe(true);
      return new Response(JSON.stringify({ choices: [{ message: { content: "工具失败信息已正确处理。" } }] }), { status: 200 });
    });

    const response = await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "验证工具错误。",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(201);

    expect(response.body.data.toolCalls).toHaveLength(7);
    expect(response.body.data.toolCalls.every((call: { status: string }) => call.status === "failed")).toBe(true);
    expect(response.body.data.content).toBe("工具失败信息已正确处理。");
  });

  it("上游返回 402 时按普通策略默认重试 3 次", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: { message: "invalid request" } }), {
      status: 402,
      headers: { "Content-Type": "application/json" }
    }));

    await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "触发上游参数错误。",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(502);

    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("上游返回 403 时不重试", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: { message: "forbidden" } }), {
      status: 403,
      headers: { "Content-Type": "application/json" }
    }));

    await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "触发上游权限错误。",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(502);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([429, 502])("上游返回 %s 时按退避策略默认重试 10 次", async (status) => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    await request(runtime.app).patch(`/api/providers/${providerId}`).send({ rpmLimit: 10_000 }).expect(200);
    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: { message: "temporarily unavailable" } }), {
      status,
      headers: { "Content-Type": "application/json" }
    }));

    await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "触发上游退避重试。",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(502);

    expect(fetchMock).toHaveBeenCalledTimes(11);
  });

  it("工具配额限制不改动 prompt cache 前缀的 tools 定义与系统消息", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      agentToolCallLimit: 5,
      agentToolCallGlobalMultiplier: 1
    }).expect(200);

    const generationToolSnapshots: string[] = [];
    const generationSystemSnapshots: string[] = [];
    const generationToolChoices: Array<string | undefined> = [];
    let generationCount = 0;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as {
        messages?: Array<{ role?: string; content?: string }>;
        tools?: unknown[];
        tool_choice?: string;
      };
      const isCompaction = body.messages?.[0]?.content?.includes("压缩已完成的 AI 工具调用上下文");
      if (isCompaction) {
        expect(body.tools).toBeUndefined();
        return new Response(JSON.stringify({
          choices: [{ message: { content: "压缩摘要仅用于测试。" } }]
        }), { status: 200 });
      }
      generationCount += 1;
      generationToolSnapshots.push(JSON.stringify(body.tools ?? null));
      generationSystemSnapshots.push(JSON.stringify(
        (body.messages ?? []).filter((message) => message.role === "system")
      ));
      generationToolChoices.push(body.tool_choice);
      expect(body.tools?.length).toBeGreaterThan(0);
      expect(body.tool_choice).toBe("auto");
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: `quota-round-${generationCount}`,
              type: "function",
              function: { name: "story_index", arguments: "{\"limit\":1}" }
            }]
          }
        }]
      }), { status: 200 });
    });

    const response = await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "反复查询目录直到得出结论。",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(502);

    expect(response.body.error).toMatchObject({ code: "AI_CALL_FAILED", message: "AI 调用失败" });
    const failureText = JSON.stringify(response.body.error);
    expect(failureText).toMatch(/more than 5 tool calls|global tool call limit/iu);
    expect(generationCount).toBeGreaterThan(1);
    expect(new Set(generationToolSnapshots).size).toBe(1);
    expect(new Set(generationSystemSnapshots).size).toBe(1);
    expect(generationToolChoices.every((choice) => choice === "auto")).toBe(true);
    expect(generationToolSnapshots[0]).toContain("story_index");
  });

  it("角色扮演对话可将用户视为指定角色，并提供角色记忆、关系和故事查询工具", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    const race = await request(runtime.app).post(`/api/works/${workId}/races`).send({
      name: "北港人",
      description: "北港近海族群。",
      settings: ["熟悉潮汐"]
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/races`).send({
      name: "深海种",
      description: "不该被林舟直接回忆的深海族群。",
      settings: ["深海禁术"]
    }).expect(201);
    const organization = await request(runtime.app).post(`/api/works/${workId}/organizations`).send({
      name: "领航公会",
      description: "北港领航员的互助组织。",
      settings: ["夜间点灯"]
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/settings`).send({
      title: "领航夜灯",
      category: "职业规矩",
      content: "领航公会要求夜间必须点灯。",
      status: "confirmed"
    }).expect(201);
    const role = await request(runtime.app).post(`/api/works/${workId}/characters`).send({
      name: "林舟",
      gender: "male",
      isDead: false,
      raceId: race.body.data.id,
      organizationIds: [organization.body.data.id],
      profile: { summary: "北港领航员" },
      currentState: { location: "北港" }
    }).expect(201);
    await request(runtime.app).post(`/api/characters/${role.body.data.id}/sections`).send({
      sectionType: "background",
      title: "旧日记忆",
      contentMarkdown: "林舟记得十二岁那年第一次看见星舰。",
      summary: "第一次看见星舰"
    }).expect(201);
    const otherRole = await request(runtime.app).post(`/api/works/${workId}/characters`).send({
      name: "顾潮",
      gender: "female",
      aliases: ["潮哥"],
      isDead: false,
      profile: { summary: "北港旧识", personaSummary: "说话干脆，码头上认得路。", secret: "这段其他角色的私密档案不得被读取" },
      currentState: { location: "南码头" }
    }).expect(201);
    const thirdRole = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "沈星", gender: "none" }).expect(201);
    const guildmate = await request(runtime.app).post(`/api/works/${workId}/characters`).send({
      name: "陈锚",
      gender: "male",
      organizationIds: [organization.body.data.id],
      profile: { summary: "公会值夜员" }
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: role.body.data.id,
      toCharacterId: otherRole.body.data.id,
      category: "social",
      subtype: "旧友",
      keywords: ["共同远航"],
      directed: false,
      currentStatus: "active",
      confirmationStatus: "confirmed",
      evidence: [{ quote: "林舟和顾潮曾共同远航" }]
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: otherRole.body.data.id,
      toCharacterId: thirdRole.body.data.id,
      category: "conflict",
      subtype: "秘密对手",
      keywords: ["其他两人的关系"],
      directed: false,
      currentStatus: "active",
      confirmationStatus: "confirmed"
    }).expect(201);
    await request(runtime.app).patch(`/api/chapters/${chapterId}`).send({
      content: "林舟启动了飞船。\n\n顾潮独自藏起了只有自己知道的密钥。"
    }).expect(200);
    const roleplayTrack = await request(runtime.app).post(`/api/works/${workId}/timeline-tracks`).send({
      name: "远航主线",
      sortOrder: 0
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/timeline`).send({
      name: "顾潮藏起密钥",
      trackId: roleplayTrack.body.data.id,
      timeLabel: "远航第 12 日",
      timeSort: 12,
      chapterIds: [chapterId],
      participantIds: [role.body.data.id],
      status: "confirmed"
    }).expect(201);
    const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    const roleplay = await request(runtime.app).patch(`/api/ai-conversations/${conversation.body.data.id}/roleplay`).send({
      characterId: role.body.data.id
    }).expect(200);
    expect(roleplay.body.data.taskType).toBe("roleplay");
    expect(roleplay.body.data.roleplayCharacter).toMatchObject({ id: role.body.data.id, name: "林舟" });
    expect(roleplay.body.data.roleplayUserCharacter).toBeNull();
    expect(roleplay.body.data.agentTools).toEqual([
      "recall_self",
      "recall_relationship",
      "recall_other",
      "recall_known",
      "recall_story",
      "image",
      "calculate_time"
    ]);
    const otherWork = await request(runtime.app).post("/api/works").send({ title: "其他作品" }).expect(201);
    const foreignCharacter = await request(runtime.app).post(`/api/works/${otherWork.body.data.id}/characters`).send({ name: "越界角色" }).expect(201);
    const mismatch = await request(runtime.app).patch(`/api/ai-conversations/${conversation.body.data.id}/roleplay`).send({
      characterId: foreignCharacter.body.data.id
    }).expect(400);
    expect(mismatch.body.error.code).toBe("ROLEPLAY_CHARACTER_WORK_MISMATCH");
    const userMismatch = await request(runtime.app).patch(`/api/ai-conversations/${conversation.body.data.id}/roleplay`).send({
      characterId: role.body.data.id,
      userCharacterId: foreignCharacter.body.data.id
    }).expect(400);
    expect(userMismatch.body.error.code).toBe("ROLEPLAY_USER_CHARACTER_WORK_MISMATCH");
    const sameCharacter = await request(runtime.app).patch(`/api/ai-conversations/${conversation.body.data.id}/roleplay`).send({
      characterId: role.body.data.id,
      userCharacterId: role.body.data.id
    }).expect(400);
    expect(sameCharacter.body.error.code).toBe("ROLEPLAY_CHARACTER_SAME_AS_USER");
    const relationshipRoleplay = await request(runtime.app).patch(`/api/ai-conversations/${conversation.body.data.id}/roleplay`).send({
      characterId: role.body.data.id,
      userCharacterId: otherRole.body.data.id
    }).expect(200);
    expect(relationshipRoleplay.body.data.roleplayCharacter).toMatchObject({ id: role.body.data.id, name: "林舟" });
    expect(relationshipRoleplay.body.data.roleplayUserCharacter).toMatchObject({ id: otherRole.body.data.id, name: "顾潮" });
    await request(runtime.app).patch("/api/platform/ai/settings").send({
      systemPrompt: "平台创作助手提示不得进入角色扮演。"
    }).expect(200);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      systemPrompt: "作品创作助手提示不得进入角色扮演。"
    }).expect(200);

    let completionCount = 0;
    const roleplaySystemPrompts: string[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      completionCount += 1;
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role?: string; content?: string }>;
        tools?: Array<{ function?: { name?: string; description?: string; parameters?: Record<string, unknown> } }>;
      };
      const systemPrompt = String(body.messages[0]?.content ?? "");
      roleplaySystemPrompts.push(systemPrompt);
      expect(systemPrompt).toContain("<roleplay_main_prompt>");
      expect(systemPrompt).toContain("你是沉浸式角色扮演引擎");
      expect(systemPrompt).toContain("个人内心独白必须单独写成 Markdown 引用块，每一行都以 > 开头");
      expect(systemPrompt).toContain("<character_card>");
      expect(systemPrompt).toContain("<user_character_card>");
      expect(systemPrompt).toContain('"name":"林舟"');
      expect(systemPrompt).toContain('"gender":"male"');
      expect(systemPrompt).toContain('"isDead":false');
      expect(systemPrompt).toContain('"name":"顾潮"');
      expect(systemPrompt).toContain("将每一条 <user_message> 都视为该角色");
      expect(systemPrompt).toContain("<scene_direction>");
      expect(systemPrompt).toContain("<scene_pin>");
      expect(systemPrompt).toContain("不要把它读成用户角色正在说话");
      expect(systemPrompt).toContain('"personaSummary":"说话干脆，码头上认得路。"');
      expect(systemPrompt).toContain('"summary":"北港旧识"');
      expect(systemPrompt).not.toContain("这段其他角色的私密档案不得被读取");
      expect(systemPrompt).not.toContain("小说作者的创作协作助手");
      expect(systemPrompt).not.toContain("平台创作助手提示不得进入角色扮演");
      expect(systemPrompt).not.toContain("作品创作助手提示不得进入角色扮演");
      expect(systemPrompt).not.toContain("<platform_system_prompt>");
      expect(systemPrompt).not.toContain("<work_system_prompt>");
      expect(systemPrompt).not.toContain("<extra_system_prompt>");
      expect(systemPrompt).not.toContain("<current_time>");
      expect(systemPrompt).toContain("使用 calculate_time");
      expect(systemPrompt).toContain("使用 recall_story 按关键词查询当前正文");
      expect(systemPrompt).toContain("只返回当前扮演角色姓名或别名出现过的段落");
      expect(systemPrompt).toContain("使用 recall_other");
      expect(systemPrompt).toContain("使用 recall_known");
      expect(systemPrompt).toContain("使用 recall_roleplay_memory");
      expect(systemPrompt).toContain("调用 remember_roleplay");
      expect(systemPrompt).toContain("canonical=false");
      expect(systemPrompt).toContain("使用 image");
      expect(systemPrompt).toContain("latestOccurrences.byStructure");
      expect(systemPrompt).toContain("latestOccurrences.byTimelineTrack");
      expect(JSON.stringify(body.messages)).toContain("<scene_context>");
      expect(JSON.stringify(body.messages)).toContain("<user_message>");
      expect(JSON.stringify(body.messages)).not.toContain("<author_instruction>");
      expect(body.tools?.map((tool) => tool.function?.name)).toEqual([
        "recall_self",
        "recall_relationship",
        "recall_other",
        "recall_known",
        "recall_story",
        "recall_roleplay_memory",
        "remember_roleplay",
        "image",
        "calculate_time"
      ]);
      expect(body.tools?.[0]?.function?.description).toContain("只有值为 true 才能判定已死亡");
      expect(body.tools?.[0]?.function?.description).toContain("gender=unknown 时禁止");
      expect(body.tools?.[0]?.function?.description).toContain("字段为 false 时必须视为仍存活");
      expect(body.tools?.[1]?.function?.description).toContain("只能返回当前角色参与的关系");
      expect(body.tools?.[1]?.function?.description).toContain("未传入 characters");
      expect(body.tools?.[1]?.function?.description).toContain("关系双方的权威 gender");
      expect(body.tools?.[2]?.function?.description).toContain("不会返回对方私密档案");
      expect(body.tools?.[3]?.function?.description).toContain("知情范围内的世界知识");
      expect(body.tools?.[4]?.function?.description).toContain("只返回当前扮演角色姓名或别名出现过的段落");
      expect(body.tools?.[5]?.function?.description).toContain("canonical=false");
      expect(body.tools?.[6]?.function?.description).toContain("最终回复成功保存后才会提交");
      expect(body.tools?.[7]?.function?.description).toContain("attachmentId");
      expect(body.tools?.[8]?.function?.description).toContain("纯计算工具");
      expect(body.tools?.[8]?.function?.parameters).toEqual({
        type: "object",
        properties: {
          startDate: { type: "string", pattern: "^-?\\d{4}-\\d{2}-\\d{2}$", description: "起始日期，格式 YYYY-MM-DD；公元前年份可在年份前加 -" },
          endDate: { type: "string", pattern: "^-?\\d{4}-\\d{2}-\\d{2}$", description: "结束日期，格式 YYYY-MM-DD；公元前年份可在年份前加 -" }
        },
        required: ["startDate", "endDate"],
        additionalProperties: false
      });
      expect(JSON.stringify(body.tools)).not.toContain("characterId");
      expect(JSON.stringify(body.tools)).not.toContain("otherCharacter");
      if (completionCount === 1) {
        expect(JSON.stringify(body.messages)).not.toContain("顾潮独自藏起");
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [
          { id: "self-memory", type: "function", function: { name: "recall_self", arguments: JSON.stringify({ categories: ["profile", "sections", "chapters"] }) } },
          { id: "relationship-list", type: "function", function: { name: "recall_relationship", arguments: "{}" } },
          { id: "known-people", type: "function", function: { name: "recall_other", arguments: "{}" } },
          { id: "known-world", type: "function", function: { name: "recall_known", arguments: "{}" } },
          { id: "story-memory", type: "function", function: { name: "recall_story", arguments: JSON.stringify({ keyword: "飞船" }) } },
          { id: "secret-memory", type: "function", function: { name: "recall_story", arguments: JSON.stringify({ keyword: "密钥" }) } },
          { id: "date-calculation", type: "function", function: { name: "calculate_time", arguments: JSON.stringify({ startDate: "2025-01-01", endDate: "2025-01-08" }) } },
          { id: "forbidden-index", type: "function", function: { name: "story_index", arguments: "{}" } },
          { id: "forbidden-grep", type: "function", function: { name: "grep", arguments: JSON.stringify({ keyword: "密钥" }) } }
        ] } }] }), { status: 200 });
      }
      if (completionCount === 2) {
        const toolMessages = body.messages.filter((message) => message.role === "tool").map((message) => String(message.content));
        expect(toolMessages[0]).toContain("北港领航员");
        expect(toolMessages[0]).toContain('"gender":"male"');
        expect(toolMessages[0]).toContain('"isDead":false');
        expect(toolMessages[0]).toContain("第一次看见星舰");
        expect(toolMessages[0]).toContain("林舟启动了飞船");
        expect(toolMessages[0]).toContain('"storyOrdering"');
        expect(toolMessages[0]).toContain('"timeSort":12');
        expect(toolMessages[0]).not.toContain("其他角色的私密档案");
        expect(toolMessages[0]).not.toContain("只有自己知道的密钥");
        expect(toolMessages[1]).toContain("顾潮");
        expect(toolMessages[1]).toContain('"gender":"female"');
        expect(toolMessages[1]).toContain("潮哥");
        expect(toolMessages[1]).toContain("relationshipCount");
        expect(toolMessages[1]).toContain('"isDead":false');
        expect(toolMessages[1]).toContain("北港旧识");
        expect(toolMessages[1]).not.toContain("旧友");
        expect(toolMessages[1]).not.toContain("共同远航");
        expect(toolMessages[1]).not.toContain("其他角色的私密档案");
        expect(toolMessages[2]).toContain("顾潮");
        expect(toolMessages[2]).toContain("陈锚");
        expect(toolMessages[2]).toContain("公会值夜员");
        expect(toolMessages[2]).toContain("北港旧识");
        expect(toolMessages[2]).not.toContain("沈星");
        expect(toolMessages[2]).not.toContain("其他角色的私密档案");
        expect(toolMessages[3]).toContain("北港人");
        expect(toolMessages[3]).toContain("领航公会");
        expect(toolMessages[3]).toContain("领航夜灯");
        expect(toolMessages[3]).toContain("熟悉潮汐");
        expect(toolMessages[3]).not.toContain("跃迁后必须冷却十二小时");
        expect(toolMessages[3]).not.toContain("深海禁术");
        expect(toolMessages[4]).toContain("林舟启动了飞船");
        expect(toolMessages[4]).toContain('"storyOrdering"');
        expect(toolMessages[4]).toContain('"storyOrder"');
        expect(toolMessages[4]).toContain('"latestOccurrences"');
        expect(toolMessages[4]).not.toContain("顾潮独自藏起了只有自己知道的密钥");
        expect(toolMessages[5]).not.toContain("顾潮独自藏起了只有自己知道的密钥");
        expect(toolMessages[5]).toContain("No story memory mentioning this keyword");
        expect(toolMessages[6]).toContain('"totalDays":7');
        expect(toolMessages[7]).toContain("TOOL_NOT_AVAILABLE");
        expect(toolMessages[8]).toContain("TOOL_NOT_AVAILABLE");
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [
          { id: "relationship-details", type: "function", function: { name: "recall_relationship", arguments: JSON.stringify({ characters: ["潮哥", "沈星"] }) } }
        ] } }] }), { status: 200 });
      }
      if (completionCount === 3) {
        const toolMessages = body.messages.filter((message) => message.role === "tool").map((message) => String(message.content));
        const relationshipDetails = toolMessages.at(-1) ?? "";
        expect(relationshipDetails).toContain('"mode":"details"');
        expect(relationshipDetails).toContain("顾潮");
        expect(relationshipDetails).toContain('"selfGender":"male"');
        expect(relationshipDetails).toContain('"otherGender":"female"');
        expect(relationshipDetails).toContain("旧友");
        expect(relationshipDetails).toContain("共同远航");
        expect(relationshipDetails).not.toContain("秘密对手");
        expect(relationshipDetails).not.toContain("其他两人的关系");
        return new Response(JSON.stringify({ choices: [{ message: { content: "我记得第一次看见星舰，也记得自己在北港启动了飞船。" } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "我还在北港。你想知道什么？" } }] }), { status: 200 });
    });

    const streamed = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "你记得什么？",
      scope: { type: "book" },
      modelId,
      conversationId: conversation.body.data.id
    }).expect(200);
    expect(streamed.text).toContain('"name":"recall_self"');
    expect(streamed.text).toContain('"name":"recall_story"');
    expect(streamed.text).toContain('"name":"story_index"');
    expect(streamed.text).toContain('"name":"calculate_time"');
    expect(streamed.text).toContain('"status":"failed"');
    expect(streamed.text).toContain("我记得第一次看见星舰");
    const secondTurn = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "你现在在哪里？",
      scope: { type: "none", suppressAutomaticContext: true },
      modelId,
      conversationId: conversation.body.data.id
    }).expect(200);
    expect(secondTurn.text).toContain("我还在北港");
    expect(roleplaySystemPrompts).toHaveLength(4);
    expect(new Set(roleplaySystemPrompts).size).toBe(1);

    const reloaded = await request(runtime.app).get(`/api/ai-conversations/${conversation.body.data.id}`).expect(200);
    expect(reloaded.body.data.taskType).toBe("roleplay");
    expect(reloaded.body.data.roleplayCharacter).toMatchObject({ id: role.body.data.id, name: "林舟" });
    expect(reloaded.body.data.roleplayUserCharacter).toMatchObject({ id: otherRole.body.data.id, name: "顾潮" });
    expect(reloaded.body.data.agentTools).toEqual([
      "recall_self",
      "recall_relationship",
      "recall_other",
      "recall_known",
      "recall_story",
      "image",
      "calculate_time"
    ]);
    const forked = await request(runtime.app).post(`/api/ai-conversations/${conversation.body.data.id}/fork`).send({
      messageId: reloaded.body.data.messages.at(-1).id
    }).expect(201);
    expect(forked.body.data.taskType).toBe("roleplay");
    expect(forked.body.data.roleplayCharacter).toMatchObject({ id: role.body.data.id, name: "林舟" });
    expect(forked.body.data.roleplayUserCharacter).toMatchObject({ id: otherRole.body.data.id, name: "顾潮" });
    expect(forked.body.data.agentTools).toEqual([
      "recall_self",
      "recall_relationship",
      "recall_other",
      "recall_known",
      "recall_story",
      "image",
      "calculate_time"
    ]);
    const lockedUserRole = await request(runtime.app).patch(`/api/ai-conversations/${conversation.body.data.id}/roleplay`).send({
      characterId: role.body.data.id,
      userCharacterId: thirdRole.body.data.id
    }).expect(409);
    expect(lockedUserRole.body.error.code).toBe("ROLEPLAY_CHARACTER_LOCKED");
    const lockedRole = await request(runtime.app).patch(`/api/ai-conversations/${conversation.body.data.id}/roleplay`).send({
      characterId: otherRole.body.data.id
    }).expect(409);
    expect(lockedRole.body.error.code).toBe("ROLEPLAY_CHARACTER_LOCKED");
    const exitLockedRole = await request(runtime.app).patch(`/api/ai-conversations/${conversation.body.data.id}/roleplay`).send({
      characterId: null
    }).expect(409);
    expect(exitLockedRole.body.error.code).toBe("ROLEPLAY_CHARACTER_LOCKED");

    const ordinaryConversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    await request(runtime.app).post(`/api/ai-conversations/${ordinaryConversation.body.data.id}/messages`).send({
      role: "user",
      content: "普通问答已经开始"
    }).expect(201);
    const started = await request(runtime.app).patch(`/api/ai-conversations/${ordinaryConversation.body.data.id}/roleplay`).send({
      characterId: role.body.data.id
    }).expect(409);
    expect(started.body.error.code).toBe("ROLEPLAY_CONVERSATION_STARTED");
  }, 20_000);

  it("角色扮演记忆只在最终回复成功后提交并与普通问答隔离", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    const character = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "林舟" }).expect(201);
    const otherCharacter = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "顾潮" }).expect(201);
    const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({ taskType: "roleplay" }).expect(201);
    const conversationId = String(conversation.body.data.id);
    await request(runtime.app).patch(`/api/ai-conversations/${conversationId}/roleplay`).send({
      characterId: character.body.data.id
    }).expect(200);
    const secondConversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({ taskType: "roleplay" }).expect(201);
    await request(runtime.app).patch(`/api/ai-conversations/${secondConversation.body.data.id}/roleplay`).send({
      characterId: character.body.data.id
    }).expect(200);
    const otherConversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({ taskType: "roleplay" }).expect(201);
    await request(runtime.app).patch(`/api/ai-conversations/${otherConversation.body.data.id}/roleplay`).send({
      characterId: otherCharacter.body.data.id
    }).expect(200);
    const manual = await request(runtime.app).post(`/api/characters/${character.body.data.id}/roleplay-memories`).send({
      category: "scene",
      content: "当前场景在北港码头。",
      importance: "high",
      isPinned: true
    }).expect(201);
    expect(manual.body.data).toMatchObject({ origin: "roleplay", canonical: false, sourceType: "manual" });
    fetchMock.mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role?: string; content?: string }>;
        tools?: Array<{ function?: { name?: string } }>;
      };
      const serializedMessages = JSON.stringify(body.messages);
      const joinedMessages = body.messages.map((message) => String(message.content ?? "")).join("\n");
      const currentInstruction = String(body.messages.filter((message) => message.role === "user").at(-1)?.content ?? "");
      const lastToolResult = String(body.messages.filter((message) => message.role === "tool").at(-1)?.content ?? "");
      if (lastToolResult.includes("will be committed only after") && serializedMessages.includes("remember-key")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "我接过银钥匙，把它收进贴身口袋。" } }] }), { status: 200 });
      }
      if (lastToolResult.includes("用户角色把银钥匙交给了林舟")) {
        expect(lastToolResult).toContain('"origin":"roleplay"');
        expect(lastToolResult).toContain('"canonical":false');
        return new Response(JSON.stringify({ choices: [{ message: { content: "银钥匙还在我这里。" } }] }), { status: 200 });
      }
      if (lastToolResult.includes("will be committed only after") && serializedMessages.includes("remember-failed-turn")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "stop" }] }), { status: 200 });
      }
      if (currentInstruction.includes("收好这把银钥匙")) {
        expect(body.tools?.map((tool) => tool.function?.name)).toContain("remember_roleplay");
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{
          id: "remember-key",
          type: "function",
          function: {
            name: "remember_roleplay",
            arguments: JSON.stringify({ memories: [{
              category: "event",
              content: "用户角色把银钥匙交给了林舟。",
              importance: "high",
              certainty: "experienced"
            }] })
          }
        }] } }] }), { status: 200 });
      }
      if (currentInstruction.includes("钥匙还在吗")) {
        expect(joinedMessages).toContain("<roleplay_memory>");
        expect(joinedMessages).toContain("用户角色把银钥匙交给了林舟");
        expect(joinedMessages).toContain('"canonical":false');
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{
          id: "recall-key",
          type: "function",
          function: { name: "recall_roleplay_memory", arguments: JSON.stringify({ query: "银钥匙" }) }
        }] } }] }), { status: 200 });
      }
      if (currentInstruction.includes("这一轮让上游返回空正文")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{
          id: "remember-failed-turn",
          type: "function",
          function: {
            name: "remember_roleplay",
            arguments: JSON.stringify({ memories: [{ category: "state", content: "这条候选不应落库。" }] })
          }
        }] } }] }), { status: 200 });
      }
      if (currentInstruction.includes("另一个角色不能看到")) {
        expect(body.tools?.map((tool) => tool.function?.name)).toEqual(expect.arrayContaining([
          "recall_roleplay_memory",
          "remember_roleplay"
        ]));
        expect(joinedMessages).not.toContain("银钥匙");
        expect(joinedMessages).not.toContain("当前场景在北港码头");
        return new Response(JSON.stringify({ choices: [{ message: { content: "我不知道你说的银钥匙。" } }] }), { status: 200 });
      }
      expect(body.tools?.map((tool) => tool.function?.name) ?? []).not.toEqual(expect.arrayContaining([
        "recall_roleplay_memory",
        "remember_roleplay"
      ]));
      expect(joinedMessages).not.toContain("<roleplay_memory>");
      return new Response(JSON.stringify({ choices: [{ message: { content: "普通问答回复。" } }] }), { status: 200 });
    });

    const first = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "收好这把银钥匙。",
      scope: { type: "none" },
      modelId,
      conversationId
    }).expect(200);
    expect(first.text).toContain("我接过银钥匙");
    const afterFirst = await request(runtime.app).get(`/api/characters/${character.body.data.id}/roleplay-memories`).expect(200);
    expect(afterFirst.body.data.items.map((item: { content: string }) => item.content)).toEqual(expect.arrayContaining([
      "用户角色把银钥匙交给了林舟。",
      "当前场景在北港码头。"
    ]));
    expect(afterFirst.body.data.items).toHaveLength(2);
    const globalSearch = await request(runtime.app).get(`/api/works/${workId}/search`).query({ q: "用户角色把银钥匙交给了林舟" }).expect(200);
    expect(JSON.stringify(globalSearch.body)).not.toContain("用户角色把银钥匙交给了林舟");
    const second = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "钥匙还在吗？",
      scope: { type: "none" },
      modelId,
      conversationId: secondConversation.body.data.id
    }).expect(200);
    expect(second.text).toContain("银钥匙还在我这里");
    const failed = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "这一轮让上游返回空正文。",
      scope: { type: "none" },
      modelId,
      conversationId: secondConversation.body.data.id
    }).expect(200);
    expect(failed.text).toContain("event: error");
    expect(runtime.database.get(
      "SELECT COUNT(*) AS count FROM roleplay_memories WHERE content = ?",
      "这条候选不应落库。"
    )).toEqual({ count: 0 });

    const otherRoleplay = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "另一个角色不能看到这批记忆。",
      scope: { type: "none" },
      modelId,
      conversationId: otherConversation.body.data.id
    }).expect(200);
    expect(otherRoleplay.text).toContain("我不知道你说的银钥匙");

    const edited = await request(runtime.app).patch(`/api/roleplay-memories/${manual.body.data.id}`).send({
      expectedVersion: 1,
      content: "当前场景仍在北港码头。"
    }).expect(200);
    const archived = await request(runtime.app).delete(`/api/roleplay-memories/${manual.body.data.id}`).send({
      expectedVersion: edited.body.data.versionNo
    }).expect(200);
    expect(archived.body.data.status).toBe("archived");
    await request(runtime.app).post(`/api/roleplay-memories/${manual.body.data.id}/restore`).send({
      expectedVersion: archived.body.data.versionNo
    }).expect(200);

    const ordinary = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    const ordinaryStream = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "普通问答不能看到扮演记忆。",
      scope: { type: "none" },
      modelId,
      conversationId: ordinary.body.data.id
    }).expect(200);
    expect(ordinaryStream.text).toContain("普通问答回复");
  }, 20_000);

  it("角色扮演将旁白 XML 放在台词之前并写入会话场景钉", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    const character = await request(runtime.app).post(`/api/works/${workId}/characters`).send({
      name: "林舟",
      gender: "male"
    }).expect(201);
    const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({
      taskType: "roleplay"
    }).expect(201);
    await request(runtime.app).patch(`/api/ai-conversations/${conversation.body.data.id}/roleplay`).send({
      characterId: character.body.data.id
    }).expect(200);

    const capturedTurns: Array<{ systemPrompt: string; currentUser: string; sceneContext: string }> = [];
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role?: string; content?: string }> };
      const systemPrompt = String(body.messages[0]?.content ?? "");
      const currentUser = String(body.messages.filter((message) => message.role === "user").at(-1)?.content ?? "");
      const sceneContext = String(body.messages.find((message) => (
        message.role === "user" && String(message.content ?? "").trimStart().startsWith("<scene_context>")
      ))?.content ?? "");
      capturedTurns.push({ systemPrompt, currentUser, sceneContext });
      if (currentUser.includes("潮水拍上木桩")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "潮声没停。" } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "灯还亮着。你先走。" } }] }), { status: 200 });
    });

    const streamed = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "你还要走吗？",
      sceneDirection: "夜雨刚停，码头只剩几盏灯。",
      scenePin: { location: "北港码头", present: "林舟、顾潮", timeLabel: "远航第 12 日黄昏" },
      scope: { type: "none" },
      modelId,
      conversationId: conversation.body.data.id
    }).expect(200);
    expect(streamed.text).toContain("灯还亮着");
    expect(capturedTurns.length).toBeGreaterThan(0);
    expect(capturedTurns[0]?.systemPrompt).toContain("<scene_direction>");
    expect(capturedTurns[0]?.systemPrompt).toContain("<scene_pin>");
    expect(capturedTurns[0]?.systemPrompt).toContain("不要把它读成用户角色正在说话");
    expect(capturedTurns[0]?.currentUser.indexOf("<scene_direction>")).toBeGreaterThanOrEqual(0);
    expect(capturedTurns[0]?.currentUser.indexOf("<scene_direction>")).toBeLessThan(capturedTurns[0]?.currentUser.indexOf("<user_message>") ?? -1);
    expect(capturedTurns[0]?.currentUser).toContain("夜雨刚停，码头只剩几盏灯。");
    expect(capturedTurns[0]?.currentUser).toContain("你还要走吗？");
    expect(capturedTurns[0]?.sceneContext).toContain("<scene_pin>");
    expect(capturedTurns[0]?.sceneContext).toContain("地点：北港码头");
    expect(capturedTurns[0]?.sceneContext).toContain("在场：林舟、顾潮");
    expect(capturedTurns[0]?.sceneContext).toContain("故事时间：远航第 12 日黄昏");

    const reloaded = await request(runtime.app).get(`/api/ai-conversations/${conversation.body.data.id}`).expect(200);
    expect(reloaded.body.data.scenePin).toEqual({
      location: "北港码头",
      present: "林舟、顾潮",
      timeLabel: "远航第 12 日黄昏"
    });
    expect(reloaded.body.data.title).toBe("你还要走吗？");
    expect(reloaded.body.data.title).not.toContain("scene_direction");
    const userMessage = (reloaded.body.data.messages as Array<{ role: string; content: string }>).find((message) => message.role === "user");
    expect(userMessage?.content).toContain("<scene_direction>");
    expect(String(userMessage?.content).indexOf("<scene_direction>")).toBeLessThan(String(userMessage?.content).indexOf("<user_message>"));
    expect(userMessage?.content).toContain("夜雨刚停，码头只剩几盏灯。");
    expect(userMessage?.content).toContain("你还要走吗？");

    const onlyScene = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "",
      sceneDirection: "潮水拍上木桩。",
      scenePin: { location: "北港码头", present: "林舟、顾潮", timeLabel: "远航第 12 日黄昏" },
      scope: { type: "none" },
      modelId,
      conversationId: conversation.body.data.id
    }).expect(200);
    expect(onlyScene.text).toContain("潮声没停");
    const sceneOnlyTurn = capturedTurns.at(-1);
    expect(sceneOnlyTurn?.currentUser).toContain("<scene_direction>");
    expect(sceneOnlyTurn?.currentUser).toContain("潮水拍上木桩。");
    expect(sceneOnlyTurn?.currentUser).not.toContain("<user_message>");
    expect(sceneOnlyTurn?.sceneContext).toContain("地点：北港码头");

    const emptyBoth = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "",
      scope: { type: "none" },
      modelId,
      conversationId: conversation.body.data.id
    }).expect(400);
    expect(emptyBoth.body.error.code).toBe("INSTRUCTION_REQUIRED");

    const forked = await request(runtime.app).post(`/api/ai-conversations/${conversation.body.data.id}/fork`).send({
      messageId: (reloaded.body.data.messages as Array<{ id: string }>).at(-1)?.id
    }).expect(201);
    expect(forked.body.data.scenePin).toEqual({
      location: "北港码头",
      present: "林舟、顾潮",
      timeLabel: "远航第 12 日黄昏"
    });
  }, 20_000);

  it("对话只保留问答与角色扮演模式并拒绝旧写作模式", async () => {
    const taskTypes = ["chat", "roleplay"] as const;
    const draftConversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({
      taskType: "chat"
    }).expect(201);
    for (const taskType of taskTypes) {
      const changed = await request(runtime.app).patch(`/api/ai-conversations/${draftConversation.body.data.id}/task-type`).send({
        taskType
      }).expect(200);
      expect(changed.body.data.taskType).toBe(taskType);
    }

    for (const initialTaskType of taskTypes) {
      const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({
        taskType: initialTaskType
      }).expect(201);
      await request(runtime.app).post(`/api/ai-conversations/${conversation.body.data.id}/messages`).send({
        role: "user",
        content: `已开始 ${initialTaskType} 对话`
      }).expect(201);
      const unchanged = await request(runtime.app).patch(`/api/ai-conversations/${conversation.body.data.id}/task-type`).send({
        taskType: initialTaskType
      }).expect(200);
      expect(unchanged.body.data.taskType).toBe(initialTaskType);
      for (const nextTaskType of taskTypes.filter((taskType) => taskType !== initialTaskType)) {
        const locked = await request(runtime.app).patch(`/api/ai-conversations/${conversation.body.data.id}/task-type`).send({
          taskType: nextTaskType
        }).expect(409);
        expect(locked.body.error.code).toBe("AI_CONVERSATION_TASK_LOCKED");
      }
    }

    for (const removedTaskType of ["continue", "polish", "analysis"]) {
      await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({ taskType: removedTaskType }).expect(400);
    }

    const legacy = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({ taskType: "chat" }).expect(201);
    runtime.database.run("UPDATE ai_conversations SET task_type = 'continue' WHERE id = ?", legacy.body.data.id);
    await request(runtime.app).post(`/api/ai-conversations/${legacy.body.data.id}/messages`).send({
      role: "user",
      content: "旧续写会话"
    }).expect(201);
    const normalizedLegacy = await request(runtime.app).get(`/api/ai-conversations/${legacy.body.data.id}`).expect(200);
    expect(normalizedLegacy.body.data.taskType).toBe("chat");
    await request(runtime.app).patch(`/api/ai-conversations/${legacy.body.data.id}/task-type`).send({ taskType: "chat" }).expect(200);
  });

  it("对话开始后锁定实际使用模型", async () => {
    const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({ taskType: "chat" }).expect(201);
    await request(runtime.app).post(`/api/ai-conversations/${conversation.body.data.id}/messages`).send({
      role: "user",
      content: "已锁定模型的对话",
      metadata: { modelId: "model-a" }
    }).expect(201);
    const reloaded = await request(runtime.app).get(`/api/ai-conversations/${conversation.body.data.id}`).expect(200);
    expect(reloaded.body.data.modelId).toBe("model-a");
    const changed = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "尝试切换模型",
      scope: { type: "none" },
      modelId: "model-b",
      conversationId: conversation.body.data.id
    }).expect(409);
    expect(changed.body.error.code).toBe("AI_CONVERSATION_MODEL_LOCKED");
  });

  it("分支对话仅在首次新请求后重新锁定模型", async () => {
    const { providerId, modelId: sourceModelId } = await configureAi();
    const branchModel = await request(runtime.app).post(`/api/providers/${providerId}/models`).send({
      displayName: "分支模型",
      modelId: "branch-model"
    }).expect(201);
    const branchModelId = String(branchModel.body.data.id);
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    await request(runtime.app).patch(`/api/providers/${providerId}`).send({ rpmLimit: 10_000 }).expect(200);

    const source = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({ taskType: "chat" }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "源对话首轮",
      scope: { type: "none" },
      modelId: sourceModelId,
      conversationId: source.body.data.id
    }).expect(200);
    const sourceReloaded = await request(runtime.app).get(`/api/ai-conversations/${source.body.data.id}`).expect(200);
    expect(sourceReloaded.body.data.modelId).toBe(sourceModelId);

    const forked = await request(runtime.app).post(`/api/ai-conversations/${source.body.data.id}/fork`).send({
      messageId: sourceReloaded.body.data.messages.at(-1).id
    }).expect(201);
    expect(forked.body.data).not.toHaveProperty("modelId");
    expect(forked.body.data.messages.find((message: { role: string }) => message.role === "user")?.metadata)
      .not.toHaveProperty("modelId");

    await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "分支改用另一模型",
      scope: { type: "none" },
      modelId: branchModelId,
      conversationId: forked.body.data.id
    }).expect(200);
    const forkedReloaded = await request(runtime.app).get(`/api/ai-conversations/${forked.body.data.id}`).expect(200);
    expect(forkedReloaded.body.data.modelId).toBe(branchModelId);

    const locked = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "分支再次切换模型",
      scope: { type: "none" },
      modelId: sourceModelId,
      conversationId: forked.body.data.id
    }).expect(409);
    expect(locked.body.error.code).toBe("AI_CONVERSATION_MODEL_LOCKED");

    const reforked = await request(runtime.app).post(`/api/ai-conversations/${forked.body.data.id}/fork`).send({
      messageId: forkedReloaded.body.data.messages.at(-1).id
    }).expect(201);
    expect(reforked.body.data).not.toHaveProperty("modelId");

    await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "二次分支切回源模型",
      scope: { type: "none" },
      modelId: sourceModelId,
      conversationId: reforked.body.data.id
    }).expect(200);
    const reforkedReloaded = await request(runtime.app).get(`/api/ai-conversations/${reforked.body.data.id}`).expect(200);
    expect(reforkedReloaded.body.data.modelId).toBe(sourceModelId);
    expect((await request(runtime.app).get(`/api/ai-conversations/${source.body.data.id}`).expect(200)).body.data.modelId)
      .toBe(sourceModelId);
  });

  it("包含图片的对话及其分支始终锁定原模型", async () => {
    const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({ taskType: "chat" }).expect(201);
    const conversationId = String(conversation.body.data.id);
    const userMessage = runtime.store.addAiConversationMessage(conversationId, {
      role: "user",
      content: "请描述这张图片",
      metadata: { modelId: "image-model-a", chatImageAttachmentIds: ["chat-image-1"] }
    });
    const reloaded = await request(runtime.app).get(`/api/ai-conversations/${conversationId}`).expect(200);
    expect(reloaded.body.data).toMatchObject({ modelId: "image-model-a", hasImageAttachments: true, modelLockedByImage: true });

    const forked = await request(runtime.app).post(`/api/ai-conversations/${conversationId}/fork`).send({
      messageId: userMessage.id
    }).expect(201);
    expect(forked.body.data).toMatchObject({ modelId: "image-model-a", hasImageAttachments: true, modelLockedByImage: true });
    expect(forked.body.data.messages[0].metadata).toMatchObject({
      modelId: "image-model-a",
      chatImageAttachmentIds: ["chat-image-1"]
    });

    const changed = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "尝试切换图片对话模型",
      scope: { type: "none" },
      modelId: "image-model-b",
      conversationId: forked.body.data.id
    }).expect(409);
    expect(changed.body.error.code).toBe("AI_CONVERSATION_MODEL_LOCKED");

    const reforked = await request(runtime.app).post(`/api/ai-conversations/${forked.body.data.id}/fork`).send({
      messageId: forked.body.data.messages[0].id
    }).expect(201);
    expect(reforked.body.data).toMatchObject({ modelId: "image-model-a", hasImageAttachments: true, modelLockedByImage: true });
  });

  it("对话开始后锁定实际上下文引用并在分支中保留", async () => {
    const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({
      taskType: "chat"
    }).expect(201);
    await request(runtime.app).patch(`/api/ai-conversations/${conversation.body.data.id}/context-scope`).send({
      scope: { type: "book" }
    }).expect(200);
    const selected = await request(runtime.app).patch(`/api/ai-conversations/${conversation.body.data.id}/context-scope`).send({
      scope: { type: "chapter", chapterId, includeBookSummary: true }
    }).expect(200);
    expect(selected.body.data.contextScope).toEqual({ type: "chapter", chapterId, includeBookSummary: true });
    const message = await request(runtime.app).post(`/api/ai-conversations/${conversation.body.data.id}/messages`).send({
      role: "user",
      content: "已开始固定章节上下文的对话"
    }).expect(201);
    await request(runtime.app).patch(`/api/ai-conversations/${conversation.body.data.id}/context-scope`).send({
      scope: { type: "chapter", chapterId, includeBookSummary: true }
    }).expect(200);
    const locked = await request(runtime.app).patch(`/api/ai-conversations/${conversation.body.data.id}/context-scope`).send({
      scope: { type: "book" }
    }).expect(409);
    expect(locked.body.error.code).toBe("AI_CONVERSATION_CONTEXT_LOCKED");

    const forked = await request(runtime.app).post(`/api/ai-conversations/${conversation.body.data.id}/fork`).send({
      messageId: message.body.data.id
    }).expect(201);
    expect(forked.body.data.contextScope).toEqual({ type: "chapter", chapterId, includeBookSummary: true });

    const otherWork = await request(runtime.app).post("/api/works").send({ title: "上下文越界作品" }).expect(201);
    const otherVolume = await request(runtime.app).post(`/api/works/${otherWork.body.data.id}/volumes`).send({ title: "越界卷" }).expect(201);
    const otherChapter = await request(runtime.app).post(`/api/works/${otherWork.body.data.id}/chapters`).send({
      volumeId: otherVolume.body.data.id,
      title: "越界章节",
      content: "不得引用"
    }).expect(201);
    const draft = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    const mismatch = await request(runtime.app).patch(`/api/ai-conversations/${draft.body.data.id}/context-scope`).send({
      scope: { type: "chapter", chapterId: otherChapter.body.data.id }
    }).expect(400);
    expect(mismatch.body.error.code).toBe("CHAPTER_WORK_MISMATCH");
  });

  it("生成建议不改正文，作者采纳后才生成新版本", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    expectedMaxTokens = 64_000;
    const updatedModel = await request(runtime.app).patch(`/api/models/${modelId}`).send({ preset: { max_tokens: expectedMaxTokens } }).expect(200);
    expect(updatedModel.body.data.preset.max_tokens).toBe(expectedMaxTokens);

    const suggestion = await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "continue",
      instruction: "续写离港场景",
      scope: { type: "chapter", chapterId },
      modelId,
      parameters: { temperature: 9, unsupported: "drop" }
    }).expect(201);
    expect(suggestion.body.data).toMatchObject({ status: "pending", action: "append", chapterVersion: 1 });
    const unchanged = await request(runtime.app).get(`/api/chapters/${chapterId}`).expect(200);
    expect(unchanged.body.data).toMatchObject({ content: "林舟启动了飞船。", versionNo: 1 });

    const accepted = await request(runtime.app).post(`/api/suggestions/${suggestion.body.data.id}/accept`).send({}).expect(200);
    expect(accepted.body.data.chapter.content).toContain("飞船缓缓驶离北港");
    expect(accepted.body.data.chapter.versionNo).toBe(2);

    const calls = await request(runtime.app).get(`/api/works/${workId}/ai-calls`).expect(200);
    const continuationCall = calls.body.data.find((call: { taskType: string }) => call.taskType === "continue");
    expect(continuationCall).toMatchObject({ status: "completed", parameters: { temperature: 2, max_tokens: 64_000 } });
    expect(continuationCall.provider.name).toBe("本地兼容服务");
    expect(continuationCall.model.displayName).toBe("小说模型");
    expect(suggestion.body.data.guard).toMatchObject({ status: "clear", issues: [] });
  });

  it("拒绝采纳基于旧正文版本的建议", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({});
    const suggestion = await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "continue",
      instruction: "续写",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(201);
    await request(runtime.app).patch(`/api/chapters/${chapterId}`).send({ content: "作者已经重写正文。" }).expect(200);
    const stale = await request(runtime.app).post(`/api/suggestions/${suggestion.body.data.id}/accept`).send({}).expect(409);
    expect(stale.body.error.code).toBe("STALE_SUGGESTION");
  });

  it("润色缺少选中文本时在调用模型前失败", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({});
    fetchMock.mockClear();
    await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "polish",
      instruction: "润色",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("问答中自动加载续写 Skill 并保留一致性守卫与采纳链路", async () => {
    const { providerId, modelId } = await configureAi();
    let streamSystemPrompt = "";
    let streamUserMessages = "";
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as {
        stream?: boolean;
        max_tokens?: number;
        messages: Array<{ role: string; content: string }>;
      };
      if (body.max_tokens === 10) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "连接成功" } }] }), { status: 200 });
      }
      if (body.stream) {
        streamSystemPrompt = String(body.messages[0]?.content ?? "");
        streamUserMessages = body.messages.slice(1).map((message) => String(message.content ?? "")).join("\n");
        return new Response('data: {"choices":[{"delta":{"content":"飞船驶入夜色。"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        });
      }
      expect(body.messages.some((message) => String(message.content).includes("检查下面的续写候选"))).toBe(true);
      return new Response(JSON.stringify({ choices: [{ message: { content: "[]" } }] }), { status: 200 });
    });
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);

    const streamed = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "续写当前章节，保持现在的节奏。",
      scope: { type: "none", chapterId, writingChapterVersion: 1 },
      modelId
    }).expect(200).expect("Content-Type", /text\/event-stream/u);

    expect(streamSystemPrompt).toContain("<available_skills>");
    expect(streamSystemPrompt).toContain("<active_skills>");
    expect(streamSystemPrompt).toContain("# 续写正文");
    expect(streamSystemPrompt).not.toContain("# 润色选中文本");
    expect(streamUserMessages).toContain("林舟启动了飞船。");
    expect(streamUserMessages).toContain("跃迁后必须冷却十二小时。");
    const completed = JSON.parse(streamed.text.match(/event: complete\ndata: ([^\n]+)/u)?.[1] ?? "{}") as {
      conversationId: string;
      contextUsage: { tokenDistribution: { skillsTokens: number } };
      writingSuggestion: Record<string, unknown>;
    };
    expect(completed.contextUsage.tokenDistribution.skillsTokens).toBeGreaterThan(0);
    expect(completed.writingSuggestion).toMatchObject({
      taskType: "continue",
      action: "append",
      status: "pending",
      guard: { status: "clear" }
    });
    const conversation = await request(runtime.app).get(`/api/ai-conversations/${completed.conversationId}`).expect(200);
    expect(conversation.body.data.taskType).toBe("chat");
    expect(conversation.body.data.messages.at(-1).metadata).toMatchObject({
      activeSkills: ["continue-writing"],
      writingSuggestionId: completed.writingSuggestion.id
    });

    const accepted = await request(runtime.app)
      .post(`/api/suggestions/${completed.writingSuggestion.id}/accept`)
      .send({})
      .expect(200);
    expect(accepted.body.data.chapter.content).toBe("林舟启动了飞船。\n\n飞船驶入夜色。");
    expect(accepted.body.data.chapter.versionNo).toBe(2);
  });

  it("问答中的润色 Skill 按本轮精确选区替换重复文本", async () => {
    const { providerId, modelId } = await configureAi();
    const original = "重复句。中间段。重复句。";
    await request(runtime.app).patch(`/api/chapters/${chapterId}`).send({ content: original }).expect(200);
    const selection = "重复句。";
    const selectionStart = original.lastIndexOf(selection);
    const selectionEnd = selectionStart + selection.length;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as { stream?: boolean; max_tokens?: number; messages: Array<{ content: string }> };
      if (body.max_tokens === 10) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "连接成功" } }] }), { status: 200 });
      }
      expect(String(body.messages[0]?.content)).toContain("# 润色选中文本");
      expect(JSON.stringify(body.messages)).toContain("当前选中文本（本次修改目标）");
      return new Response('data: {"choices":[{"delta":{"content":"夜色重复回响。"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      });
    });
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);

    const streamed = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "/polish-writing\n让当前选区的表达更顺畅。",
      scope: {
        type: "none",
        chapterId,
        writingChapterVersion: 2,
        selection,
        selectionStart,
        selectionEnd
      },
      modelId
    }).expect(200);
    expect(fetchMock.mock.calls.some((call) => String(call[1]?.body).includes("/polish-writing"))).toBe(false);
    const completed = JSON.parse(streamed.text.match(/event: complete\ndata: ([^\n]+)/u)?.[1] ?? "{}") as {
      writingSuggestion: { id: string; taskType: string; action: string };
    };
    expect(completed.writingSuggestion).toMatchObject({ taskType: "polish", action: "replace-selection" });

    const accepted = await request(runtime.app)
      .post(`/api/suggestions/${completed.writingSuggestion.id}/accept`)
      .send({})
      .expect(200);
    expect(accepted.body.data.chapter.content).toBe("重复句。中间段。夜色重复回响。");
  });

  it("usage 将 Skill 元数据和激活正文计入 skills，角色扮演保持为零", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({ taskType: "chat" }).expect(201);
    const ordinary = await request(runtime.app).post(`/api/ai-conversations/${conversation.body.data.id}/context/prepare`).send({
      instruction: "讨论下一段可以采用哪些方向。",
      scope: { type: "none", chapterId, writingChapterVersion: 1 },
      modelId
    }).expect(200);
    const forced = await request(runtime.app).post(`/api/ai-conversations/${conversation.body.data.id}/context/prepare`).send({
      instruction: "/continue-writing\n沿当前情节继续创作。",
      scope: { type: "none", chapterId, writingChapterVersion: 1 },
      modelId
    }).expect(200);
    const ordinarySkillTokens = Number(ordinary.body.data.usage.tokenDistribution.skillsTokens);
    const forcedSkillTokens = Number(forced.body.data.usage.tokenDistribution.skillsTokens);
    expect(ordinarySkillTokens).toBeGreaterThan(0);
    expect(forcedSkillTokens).toBeGreaterThan(ordinarySkillTokens);

    const multiple = await request(runtime.app).post(`/api/ai-conversations/${conversation.body.data.id}/context/prepare`).send({
      instruction: "/continue-writing\n/polish-writing",
      scope: { type: "none", chapterId, writingChapterVersion: 1 },
      modelId
    }).expect(400);
    expect(multiple.body.error.code).toBe("MULTIPLE_WRITING_SKILLS_UNSUPPORTED");

    const character = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "林舟" }).expect(201);
    const roleplay = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({ taskType: "roleplay" }).expect(201);
    await request(runtime.app).patch(`/api/ai-conversations/${roleplay.body.data.id}/roleplay`).send({
      characterId: character.body.data.id
    }).expect(200);
    const roleplayUsage = await request(runtime.app).post(`/api/ai-conversations/${roleplay.body.data.id}/context/prepare`).send({
      instruction: "/continue-writing\n继续当前互动。",
      scope: { type: "none" },
      modelId
    }).expect(200);
    expect(roleplayUsage.body.data.usage.tokenDistribution.skillsTokens).toBe(0);
  });

  it("侧栏问答通过 SSE 逐段输出并在完整读取后记录建议", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ agentTools: [] }).expect(200);
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const body = JSON.parse(String(init?.body)) as { stream?: boolean; max_tokens?: number; messages?: Array<{ content: string }>; thinking?: { type?: string } };
      expect(body).toMatchObject({ stream: true, max_tokens: 32_000 });
      expect(body.thinking).toEqual({ type: "enabled" });
      expect(body.messages?.some((message) => message.content.includes("[第一章 L1-L2]"))).toBe(true);
      expect(body.messages?.some((message) => message.content.includes("林舟启动了飞船。"))).toBe(true);
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"先读取"}}]}\n\n'));
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"现有上下文。"}}]}\n\n'));
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"飞船"}}]}\n\n'));
          setTimeout(() => {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"离港"},"finish_reason":"stop"}]}\n\n'));
            controller.enqueue(encoder.encode('data: {"choices":[],"usage":{"prompt_tokens":100,"prompt_tokens_details":{"cached_tokens":75},"completion_tokens":4}}\n\n'));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          }, 5);
        }
      }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    });

    const streamed = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "飞船接下来怎样？",
      scope: { type: "chapter", chapterId },
      modelId,
      citations: [{ chapterId, chapterTitle: "第一章", startLine: 1, endLine: 2, text: "林舟启动了飞船。\n跃迁准备完成。" }]
    }).expect(200).expect("Content-Type", /text\/event-stream/u);
    expect(streamed.text).toContain('event: delta\ndata: {"delta":"飞船"}');
    expect(streamed.text).toContain('event: delta\ndata: {"delta":"离港"}');
    expect(streamed.text).toContain('event: process_step\ndata: {"id":"process_');
    expect(streamed.text).toContain('"type":"thinking","round":1,"content":"先读取"');
    expect(streamed.text).toContain('"content":"现有上下文。"');
    expect(streamed.text.indexOf('"飞船"')).toBeLessThan(streamed.text.indexOf('"离港"'));
    expect(streamed.text).toContain("event: complete");
    expect(streamed.text).toContain('"outputTokens":4,"cacheHitPercent":75');
    expect(streamed.text).toContain('"processSteps":[{"id":"process_');
    expect(streamed.text).toContain('"content":"先读取现有上下文。"');

    const suggestions = await request(runtime.app).get(`/api/works/${workId}/suggestions`).expect(200);
    expect(suggestions.body.data[0]).toMatchObject({ taskType: "chat", action: "note", content: "飞船离港" });
    const calls = await request(runtime.app).get(`/api/works/${workId}/ai-calls`).expect(200);
    expect(calls.body.data[0]).toMatchObject({ taskType: "chat", status: "completed", outputChars: 4 });
    const usage = await request(runtime.app).get(`/api/works/${workId}/ai-settings/usage`).expect(200);
    expect(usage.body.data.summary).toMatchObject({
      totalTokens: 104,
      inputTokens: 100,
      outputTokens: 4,
      cachedInputTokens: 75,
      cacheEligibleInputTokens: 100,
      cacheHitRate: 75,
      estimatedRequestCount: 0
    });
  });

  it("流式用户消息持久化角色、种族与组织引用且角色扮演不自动识别", async () => {
    const manualCharacter = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "顾潮", gender: "male" }).expect(201);
    const automaticCharacter = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "林舟", gender: "female" }).expect(201);
    const roleplayCharacter = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "宋遥", gender: "none" }).expect(201);
    const automaticRace = await request(runtime.app).post(`/api/works/${workId}/races`).send({ name: "火焰翼龙族" }).expect(201);
    const automaticOrganization = await request(runtime.app).post(`/api/works/${workId}/organizations`).send({ name: "星火议会" }).expect(201);
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ agentTools: [] }).expect(200);
    const sentContexts: string[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as { messages?: Array<{ content?: string }> };
      sentContexts.push(JSON.stringify(body.messages ?? []));
      return new Response('data: {"choices":[{"delta":{"content":"已确认引用。"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      });
    });

    const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    const conversationId = String(conversation.body.data.id);
    const streamed = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "请让顾潮与林舟、火焰翼龙族和星火议会一起出场。",
      scope: { type: "none", characterIds: [manualCharacter.body.data.id] },
      modelId,
      conversationId
    }).expect(200).expect("Content-Type", /text\/event-stream/u);
    const userMessagePayload = JSON.parse(streamed.text.match(/event: user_message\ndata: ([^\n]+)/u)?.[1] ?? "{}") as {
      message?: { metadata?: { mentionCharacterIds?: string[]; mentionRaceIds?: string[]; mentionOrganizationIds?: string[] } };
    };
    expect(userMessagePayload.message?.metadata?.mentionCharacterIds).toEqual([
      manualCharacter.body.data.id,
      automaticCharacter.body.data.id
    ]);
    expect(userMessagePayload.message?.metadata?.mentionRaceIds).toEqual([automaticRace.body.data.id]);
    expect(userMessagePayload.message?.metadata?.mentionOrganizationIds).toEqual([automaticOrganization.body.data.id]);
    expect(sentContexts[0]).toContain("<selected_characters>");
    expect(sentContexts[0]).toContain("<mentioned_characters>");
    expect(sentContexts[0]).toContain("<mentioned_races>");
    expect(sentContexts[0]).toContain("<mentioned_organizations>");
    expect(sentContexts[0]).toContain("gender=male");
    expect(sentContexts[0]).toContain("gender=female");
    expect(runtime.store.getAiConversationInjectedEntities(conversationId, workId).characters).toEqual([
      automaticCharacter.body.data.id
    ]);
    expect(runtime.store.getAiConversationInjectedEntities(conversationId, workId).races).toEqual([
      automaticRace.body.data.id
    ]);
    expect(runtime.store.getAiConversationInjectedEntities(conversationId, workId).organizations).toEqual([
      automaticOrganization.body.data.id
    ]);

    const reloaded = await request(runtime.app).get(`/api/ai-conversations/${conversationId}`).expect(200);
    expect(reloaded.body.data.messages[0].metadata.mentionCharacterIds).toEqual([
      manualCharacter.body.data.id,
      automaticCharacter.body.data.id
    ]);
    expect(reloaded.body.data.messages[0].metadata.mentionRaceIds).toEqual([automaticRace.body.data.id]);
    expect(reloaded.body.data.messages[0].metadata.mentionOrganizationIds).toEqual([automaticOrganization.body.data.id]);

    const plainStream = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "请概括当前问题。",
      scope: { type: "none" },
      modelId,
      conversationId
    }).expect(200).expect("Content-Type", /text\/event-stream/u);
    const plainUserMessagePayload = JSON.parse(plainStream.text.match(/event: user_message\ndata: ([^\n]+)/u)?.[1] ?? "{}") as {
      message?: { metadata?: Record<string, unknown> };
    };
    expect(plainUserMessagePayload.message?.metadata).not.toHaveProperty("mentionCharacterIds");

    const roleplayConversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    const roleplayConversationId = String(roleplayConversation.body.data.id);
    await request(runtime.app).patch(`/api/ai-conversations/${roleplayConversationId}/roleplay`).send({
      characterId: roleplayCharacter.body.data.id
    }).expect(200);
    const roleplayStream = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "林舟现在在哪里？",
      scope: { type: "none" },
      modelId,
      conversationId: roleplayConversationId
    }).expect(200).expect("Content-Type", /text\/event-stream/u);
    const roleplayUserMessagePayload = JSON.parse(roleplayStream.text.match(/event: user_message\ndata: ([^\n]+)/u)?.[1] ?? "{}") as {
      message?: { metadata?: Record<string, unknown> };
    };
    expect(roleplayUserMessagePayload.message?.metadata).not.toHaveProperty("mentionCharacterIds");
    expect(sentContexts.at(-1)).not.toContain("<mentioned_characters>");
    expect(runtime.store.getAiConversationInjectedEntities(roleplayConversationId, workId).characters).toEqual([]);
  });

  it("同一角色跨消息再次出现时仍写入本条用户消息 metadata", async () => {
    const manualCharacter = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "沈星" }).expect(201);
    const automaticCharacter = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "林舟" }).expect(201);
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ agentTools: [] }).expect(200);
    const sentContexts: string[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as { messages?: Array<{ content?: string }> };
      sentContexts.push(body.messages?.find((message) => message.content?.startsWith("<story_context>"))?.content ?? "");
      return new Response('data: {"choices":[{"delta":{"content":"已确认。"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      });
    });
    const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    const conversationId = String(conversation.body.data.id);

    const first = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "林舟第一次出场。",
      scope: { type: "none" },
      modelId,
      conversationId
    }).expect(200).expect("Content-Type", /text\/event-stream/u);
    const firstUserMessage = JSON.parse(first.text.match(/event: user_message\ndata: ([^\n]+)/u)?.[1] ?? "{}") as {
      message?: { metadata?: { mentionCharacterIds?: string[] } };
    };
    expect(firstUserMessage.message?.metadata?.mentionCharacterIds).toEqual([automaticCharacter.body.data.id]);
    expect(sentContexts[0]).toContain("<mentioned_characters>");

    const second = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "请让沈星与林舟再次会面。",
      scope: { type: "none", mentionCharacterIds: [manualCharacter.body.data.id] },
      modelId,
      conversationId
    }).expect(200).expect("Content-Type", /text\/event-stream/u);
    const secondUserMessage = JSON.parse(second.text.match(/event: user_message\ndata: ([^\n]+)/u)?.[1] ?? "{}") as {
      message?: { metadata?: { mentionCharacterIds?: string[] } };
    };
    expect(secondUserMessage.message?.metadata?.mentionCharacterIds).toEqual([
      manualCharacter.body.data.id,
      automaticCharacter.body.data.id
    ]);
    expect(sentContexts[1]).toContain("<mentioned_characters>");
    expect(sentContexts[1]).toContain("沈星");
    expect(sentContexts[1]).not.toContain("林舟");
    expect(runtime.store.getAiConversationInjectedEntities(conversationId, workId).characters).toEqual([
      automaticCharacter.body.data.id
    ]);

    const reloaded = await request(runtime.app).get(`/api/ai-conversations/${conversationId}`).expect(200);
    const userMessages = reloaded.body.data.messages.filter((message: { role: string }) => message.role === "user");
    expect(userMessages.map((message: { metadata: { mentionCharacterIds?: string[] } }) => message.metadata.mentionCharacterIds)).toEqual([
      [automaticCharacter.body.data.id],
      [manualCharacter.body.data.id, automaticCharacter.body.data.id]
    ]);
  });

  it("工具定义开启时在上游响应结束前推送首个正文 delta", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    let upstreamFinished = false;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as {
        stream?: boolean;
        tools?: Array<{ function?: { name?: string } }>;
      };
      expect(body.stream).toBe(true);
      expect(body.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({ function: expect.objectContaining({ name: "story_index" }) })
      ]));
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"首个"}}]}\n\n'));
          setTimeout(() => {
            upstreamFinished = true;
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"增量"},"finish_reason":"stop"}]}\n\n'));
            controller.enqueue(encoder.encode('data: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":4}}\n\n'));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          }, 20);
        }
      }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    });

    const deltas: string[] = [];
    const firstDeltaBeforeUpstreamFinished: boolean[] = [];
    const generated = await runtime.ai.createStreamingChat({
      workId,
      instruction: "不调用工具，直接回答。",
      scope: { type: "chapter", chapterId },
      modelId,
      maxAttempts: 1
    }, (delta) => {
      if (deltas.length === 0) firstDeltaBeforeUpstreamFinished.push(!upstreamFinished);
      deltas.push(delta);
    });

    expect(firstDeltaBeforeUpstreamFinished).toEqual([true]);
    expect(deltas).toEqual(["首个", "增量"]);
    expect(generated.content).toBe("首个增量");
  });

  it("第二轮助手回复后保留首个提示词截断标题，并由独立模型生成标题", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    const settingsBefore = await request(runtime.app).get(`/api/works/${workId}/ai-settings`).expect(200);
    expect(settingsBefore.body.data.titleGenerationModelId).toBeNull();

    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ titleGenerationModelId: modelId, agentTools: [] }).expect(200);
    const completionBodies: Array<{ stream?: boolean; tools?: unknown; messages?: Array<{ content?: string }> }> = [];
    let chatRequestCount = 0;
    let titleRequestStarted = false;
    let releaseTitleRequest: (() => void) | null = null;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      const body = JSON.parse(String(init?.body)) as { stream?: boolean; tools?: unknown; messages?: Array<{ content?: string }> };
      completionBodies.push(body);
      if (body.stream) {
        chatRequestCount += 1;
        const content = chatRequestCount === 1 ? "首轮助手回答" : "第二轮助手回答";
        return new Response(`data: {"choices":[{"delta":{"content":"${content}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        });
      }
      expect(body.tools).toBeUndefined();
      expect(body.messages?.some((message) => message.content?.includes("你好"))).toBe(true);
      expect(body.messages?.some((message) => message.content?.includes("请规划北港跃迁路线"))).toBe(true);
      expect(body.messages?.some((message) => message.content?.includes("第二轮助手回答"))).toBe(true);
      titleRequestStarted = true;
      return new Promise<Response>((resolve) => {
        releaseTitleRequest = () => resolve(new Response(JSON.stringify({ choices: [{ message: { content: "标题：北港跃迁路线" } }] }), { status: 200 }));
      });
    });

    const firstStream = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "你好",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(200).expect("Content-Type", /text\/event-stream/u);
    const firstComplete = JSON.parse(firstStream.text.match(/event: complete\ndata: ([^\n]+)/u)?.[1] ?? "{}") as { conversationId?: string };
    const conversationId = String(firstComplete.conversationId ?? "");
    expect(conversationId).not.toBe("");
    expect(titleRequestStarted).toBe(false);
    expect(completionBodies).toHaveLength(1);
    let reloaded = await request(runtime.app).get(`/api/ai-conversations/${conversationId}`).expect(200);
    expect(reloaded.body.data.title).toBe("你好");
    expect(reloaded.body.data.messages.map((message: { role: string }) => message.role)).toEqual(["user", "assistant"]);

    const streamPromise = request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "请规划北港跃迁路线",
      scope: { type: "chapter", chapterId },
      modelId,
      conversationId
    }).expect(200).expect("Content-Type", /text\/event-stream/u).then((response) => response);
    for (let index = 0; index < 50 && !titleRequestStarted; index += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(titleRequestStarted).toBe(true);
    const streamed = await Promise.race([
      streamPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("流式回答被标题生成阻塞")), 500))
    ]).finally(() => releaseTitleRequest?.());

    expect(streamed.text).toContain("event: context");
    expect(streamed.text).toContain("event: user_message");
    expect(streamed.text).not.toContain('"conversationTitle":"北港跃迁路线"');
    expect(completionBodies).toHaveLength(3);
    reloaded = await request(runtime.app).get(`/api/ai-conversations/${conversationId}`).expect(200);
    for (let index = 0; index < 50 && reloaded.body.data.title !== "北港跃迁路线"; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      reloaded = await request(runtime.app).get(`/api/ai-conversations/${conversationId}`).expect(200);
    }
    expect(reloaded.body.data.title).toBe("北港跃迁路线");
    expect(reloaded.body.data.messages.map((message: { role: string }) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    const settingsAfter = await request(runtime.app).get(`/api/works/${workId}/ai-settings`).expect(200);
    expect(settingsAfter.body.data.titleGenerationModelId).toBe(modelId);
  });

  it("浏览器中断流式连接会取消上游并保留此前完整 turn 与已收到的助手正文", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ agentTools: [] }).expect(200);
    const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    const conversationId = String(conversation.body.data.id);
    await request(runtime.app).post(`/api/ai-conversations/${conversationId}/messages`).send({
      role: "user",
      content: "此前完整问题"
    }).expect(201);
    await request(runtime.app).post(`/api/ai-conversations/${conversationId}/messages`).send({
      role: "assistant",
      content: "此前完整回答"
    }).expect(201);
    let upstreamAborted = false;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"不应落库的部分回复"}}]}\n\n'));
          init?.signal?.addEventListener("abort", () => {
            upstreamAborted = true;
            controller.error(init.signal?.reason ?? new Error("aborted"));
          }, { once: true });
        },
        cancel() {
          upstreamAborted = true;
        }
      }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    });

    const address = (runtime.app as unknown as { address(): string | { port: number } | null }).address();
    if (!address || typeof address === "string") throw new Error("测试服务未监听 TCP 端口");
    const controller = new AbortController();
    const streamed = await fetch(`http://127.0.0.1:${address.port}/api/works/${workId}/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", "Idempotency-Key": "disconnect-request-0001" },
      body: JSON.stringify({
        instruction: "切换对话时取消旧流",
        scope: { type: "chapter", chapterId },
        modelId,
        conversationId
      }),
      signal: controller.signal
    });
    const reader = streamed.body?.getReader();
    if (!reader) throw new Error("流式响应缺少正文");
    const decoder = new TextDecoder();
    let received = "";
    while (!received.includes("不应落库的部分回复")) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("未收到流式部分回复")), 1_000))
      ]);
      if (chunk.done) break;
      received += decoder.decode(chunk.value, { stream: true });
    }
    expect(received).toContain("event: user_message");
    expect(received).toContain("不应落库的部分回复");

    const inProgressReloaded = await request(runtime.app).get(`/api/ai-conversations/${conversationId}`).expect(200);
    expect(inProgressReloaded.body.data.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "不应落库的部分回复"
    });

    controller.abort();
    await reader.read().catch(() => ({ done: true, value: undefined }));
    for (let index = 0; index < 50 && !upstreamAborted; index += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(upstreamAborted).toBe(true);

    let streamRequest = runtime.database.get<Record<string, unknown>>(
      "SELECT status, terminal_reason, assistant_message_id FROM ai_conversation_stream_requests WHERE idempotency_key = ?",
      "disconnect-request-0001"
    );
    for (let index = 0; index < 50 && streamRequest?.status === "in_progress"; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      streamRequest = runtime.database.get(
        "SELECT status, terminal_reason, assistant_message_id FROM ai_conversation_stream_requests WHERE idempotency_key = ?",
        "disconnect-request-0001"
      );
    }
    expect(streamRequest).toMatchObject({ status: "cancelled", assistant_message_id: expect.any(String) });

    const reloaded = await request(runtime.app).get(`/api/ai-conversations/${conversationId}`).expect(200);
    expect(reloaded.body.data.title).toBe("此前完整问题");
    expect(reloaded.body.data.messages.map((message: { role: string; content: string }) => ({ role: message.role, content: message.content }))).toEqual([
      { role: "user", content: "此前完整问题" },
      { role: "assistant", content: "此前完整回答" },
      { role: "user", content: "切换对话时取消旧流" },
      { role: "assistant", content: "不应落库的部分回复" }
    ]);
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM ai_suggestions WHERE work_id = ?", workId)).toEqual({ count: 0 });

    let resumedMessages: Array<{ role?: string; content?: string }> = [];
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      resumedMessages = (JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ role?: string; content?: string }> }).messages ?? [];
      return new Response('data: {"choices":[{"delta":{"content":"取消后恢复"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      });
    });
    const resumed = await request(runtime.app).post(`/api/works/${workId}/chat/stream`)
      .set("Idempotency-Key", "disconnect-request-0002")
      .send({
        instruction: "取消后继续",
        scope: { type: "chapter", chapterId },
        modelId,
        conversationId
      })
      .expect(200);
    expect(resumed.text).toContain("event: complete");
    expect(resumedMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", content: "此前完整问题" }),
      expect.objectContaining({ role: "assistant", content: "此前完整回答" })
    ]));
    const resumedHistory = await request(runtime.app).get(`/api/ai-conversations/${conversationId}`).expect(200);
    expect(resumedHistory.body.data.messages.map((message: { role: string; content: string }) => ({ role: message.role, content: message.content }))).toEqual([
      { role: "user", content: "此前完整问题" },
      { role: "assistant", content: "此前完整回答" },
      { role: "user", content: "切换对话时取消旧流" },
      { role: "assistant", content: "不应落库的部分回复" },
      { role: "user", content: "取消后继续" },
      { role: "assistant", content: "取消后恢复" }
    ]);
  });

  it("客户端完成回调重试使用用户消息请求键避免重复 assistant 消息", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ agentTools: [] }).expect(200);
    const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    const conversationId = String(conversation.body.data.id);
    fetchMock.mockImplementation(async (input) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      return new Response('data: {"choices":[{"delta":{"content":"唯一助手回复"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      });
    });

    const streamed = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "验证完成回调幂等",
      scope: { type: "chapter", chapterId },
      modelId,
      conversationId
    }).expect(200);
    const userPayload = JSON.parse(streamed.text.match(/event: user_message\ndata: ([^\n]+)/u)?.[1] ?? "{}") as { message?: { id?: string } };
    const completePayload = JSON.parse(streamed.text.match(/event: complete\ndata: ([^\n]+)/u)?.[1] ?? "{}") as { messageId?: string };
    const userMessageId = String(userPayload.message?.id ?? "");
    expect(userMessageId).not.toBe("");

    const retried = await request(runtime.app).post(`/api/ai-conversations/${conversationId}/messages`).send({
      role: "assistant",
      content: "调用失败：客户端未读取到完成事件",
      requestId: `assistant:${userMessageId}`,
      metadata: {
        interrupted: true,
        interruptionCode: "AI_STREAM_UPSTREAM_CLOSED",
        interruptionMessage: "AI 流在收到完成事件前已关闭，已保留已生成内容"
      }
    }).expect(201);
    expect(retried.body.data).toMatchObject({
      id: completePayload.messageId,
      content: "唯一助手回复",
      metadata: {
        interrupted: true,
        interruptionCode: "AI_STREAM_UPSTREAM_CLOSED",
        interruptionMessage: "AI 流在收到完成事件前已关闭，已保留已生成内容"
      }
    });

    const reloaded = await request(runtime.app).get(`/api/ai-conversations/${conversationId}`).expect(200);
    expect(reloaded.body.data.messages.map((message: { role: string; content: string }) => ({ role: message.role, content: message.content }))).toEqual([
      { role: "user", content: "验证完成回调幂等" },
      { role: "assistant", content: "唯一助手回复" }
    ]);
    expect(reloaded.body.data.messages.at(-1)?.metadata).toMatchObject({
      interrupted: true,
      interruptionCode: "AI_STREAM_UPSTREAM_CLOSED"
    });
  });

  it("第二轮助手回复后的标题生成失败时不影响主回答", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ titleGenerationModelId: modelId, agentTools: [] }).expect(200);
    let titleRequestCount = 0;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      const body = JSON.parse(String(init?.body)) as { stream?: boolean };
      if (body.stream) {
        return new Response('data: {"choices":[{"delta":{"content":"主回答"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        });
      }
      titleRequestCount += 1;
      return new Response(JSON.stringify({ error: { message: "标题模型不可用" } }), { status: 400 });
    });

    const firstStream = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "标题生成失败时仍保留默认",
      scope: { type: "none" },
      modelId
    }).expect(200).expect("Content-Type", /text\/event-stream/u);
    const firstComplete = JSON.parse(firstStream.text.match(/event: complete\ndata: ([^\n]+)/u)?.[1] ?? "{}") as { conversationId?: string };
    const conversationId = String(firstComplete.conversationId ?? "");
    expect(conversationId).not.toBe("");
    expect(titleRequestCount).toBe(0);

    const streamed = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "请继续说明",
      scope: { type: "none" },
      modelId,
      conversationId
    }).expect(200).expect("Content-Type", /text\/event-stream/u);

    for (let index = 0; index < 50 && titleRequestCount < 1; index += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(streamed.text).toContain('event: delta\ndata: {"delta":"主回答"}');
    expect(streamed.text).toContain("event: complete");
    expect(streamed.text).not.toContain("event: error");
    expect(titleRequestCount).toBe(4);
    const reloaded = await request(runtime.app).get(`/api/ai-conversations/${conversationId}`).expect(200);
    expect(reloaded.body.data.title).toBe("标题生成失败时仍保留默认");
  });

  it("侧栏问答失败时通过 SSE 返回受控错误信息", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      }
      const authorization = new Headers(init?.headers).get("Authorization");
      return new Response(JSON.stringify({ error: { message: `上游参数无效：${authorization}` } }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    });

    const streamed = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "触发可读错误",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(200).expect("Content-Type", /text\/event-stream/u);

    expect(streamed.text).toContain("event: error");
    expect(streamed.text).toContain('"code":"AI_CALL_FAILED"');
    expect(streamed.text).toContain('"status":502');
    expect(streamed.text).toContain('"providerName":"本地兼容服务"');
    expect(streamed.text).toContain(`"providerId":"${providerId}"`);
    expect(streamed.text).toContain('"modelId":"mock-novel-model"');
    expect(streamed.text).toContain(`"modelRecordId":"${modelId}"`);
    expect(streamed.text).toContain('"failure":"HTTP 400: {\\"error\\":{\\"message\\":\\"上游参数无效：Bearer sk-s*****lue\\"}}"');
    expect(streamed.text).not.toContain("sk-sensitive-test-value");
    expect(streamed.text).toMatch(/"callId":"call_[^"]+"/u);
    const calls = await request(runtime.app).get(`/api/works/${workId}/ai-calls`).expect(200);
    expect(calls.body.data[0].failure).toContain("上游参数无效：Bearer sk-s*****lue");
  });

  it("流式成功响应不会向浏览器或记录回显供应商密钥", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ agentTools: [] }).expect(200);
    fetchMock.mockImplementation(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"安全前缀 sk-sensitive-"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"test-value 安全后缀s"},"finish_reason":"stop"}]}\n\n'));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } }));

    const streamed = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "检查密钥回显",
      scope: { type: "none" },
      modelId
    }).expect(200).expect("Content-Type", /text\/event-stream/u);
    const suggestions = await request(runtime.app).get(`/api/works/${workId}/suggestions`).expect(200);

    expect(streamedDeltas(streamed.text)).toBe("安全前缀 sk-s*****lue 安全后缀s");
    expect(streamed.text).not.toContain("sk-sensitive-test-value");
    expect(suggestions.body.data[0].content).toBe("安全前缀 sk-s*****lue 安全后缀s");
  });

  it("上游读取异常时安全刷新尾部且保持失败持久化语义", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ agentTools: [] }).expect(200);
    fetchMock.mockImplementation(async () => {
      let sent = false;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) {
            sent = true;
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode(
              'data: {"choices":[{"delta":{"content":"安全前缀 sk-sensitive-"}}]}\n\n'
            ));
            return;
          }
          controller.error(new Error("upstream network disconnected"));
        }
      }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    });

    const streamed = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "测试异常尾部",
      scope: { type: "none" },
      modelId
    }).expect(200).expect("Content-Type", /text\/event-stream/u);
    const assistantMessages = runtime.database.all<{ content: string }>(
      "SELECT content FROM ai_conversation_messages WHERE role = 'assistant'"
    );
    const failedCall = runtime.database.get<{ status: string; output_chars: number }>(
      "SELECT status, output_chars FROM ai_calls ORDER BY created_at DESC LIMIT 1"
    );

    expect(streamedDeltas(streamed.text)).toBe("安全前缀 sk-s*****");
    expect(streamed.text).toContain("event: error");
    expect(streamed.text).toContain('"code":"AI_STREAM_NETWORK_ERROR"');
    expect(streamed.text).toContain('"status":502');
    expect(streamed.text).not.toContain("event: complete");
    expect(streamed.text).not.toContain("sk-sensitive-test-value");
    expect(streamed.text).not.toContain("sk-sensitive-");
    expect(assistantMessages).toEqual([{ content: "安全前缀 sk-s*****" }]);
    expect(failedCall).toEqual({ status: "failed", output_chars: "安全前缀 sk-s*****".length });
  });

  it("用户取消流式请求时安全刷新尾部并保存临时助手正文", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ agentTools: [] }).expect(200);
    fetchMock.mockImplementation(async (_input, init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"取消正文末尾s"}}]}\n\n'));
        init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
      }
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    const conversation = runtime.store.createAiConversation(workId);
    const userMessage = runtime.store.addAiConversationMessage(String(conversation.id), {
      role: "user",
      content: "取消流式请求"
    });
    const controller = new AbortController();
    const deltas: string[] = [];
    let cancelled = false;

    const call = runtime.ai.createStreamingChat({
      workId,
      instruction: "取消流式请求",
      scope: { type: "none" },
      modelId,
      conversationId: String(conversation.id),
      assistantMessageRequestId: `assistant:${String(userMessage.id)}`,
      signal: controller.signal
    }, (delta) => {
      deltas.push(delta);
      if (!cancelled) {
        cancelled = true;
        controller.abort(new Error("用户取消流式请求"));
      }
    });

    await expect(call).rejects.toMatchObject({
      status: 499,
      code: "AI_STREAM_REQUEST_CANCELLED"
    });
    const assistantMessages = runtime.database.all<{ content: string }>(
      "SELECT content FROM ai_conversation_messages WHERE conversation_id = ? AND role = 'assistant'",
      String(conversation.id)
    );
    const failedCall = runtime.database.get<{ status: string; output_chars: number }>(
      "SELECT status, output_chars FROM ai_calls ORDER BY created_at DESC LIMIT 1"
    );

    expect(deltas.join("")).toBe("取消正文末尾s");
    expect(assistantMessages).toEqual([{ content: "取消正文末尾s" }]);
    expect(failedCall).toEqual({ status: "failed", output_chars: "取消正文末尾s".length });
  });

  it("收到 OpenAI 流式 DONE 标记后不等待供应商关闭连接", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ agentTools: [] }).expect(200);
    let cancelled = false;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"已结束"},"finish_reason":"stop"}]}\n\n'));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
        },
        cancel() {
          cancelled = true;
        }
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    });

    const streamed = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "测试 DONE 结束标记",
      scope: { type: "none" },
      modelId
    }).timeout({ deadline: 1_000 }).expect(200).expect("Content-Type", /text\/event-stream/u);

    expect(streamed.text).toContain('event: delta\ndata: {"delta":"已结束"}');
    expect(streamed.text).toContain("event: complete");
    expect(cancelled).toBe(true);
  });

  it("首轮整窗超限且无历史可压缩时不请求模型并提示减少上下文", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    setLegacyModelContextWindow(modelId, 1_024);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ agentTools: [] }).expect(200);
    fetchMock.mockClear();

    const failed = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "必须保留的超长首轮指令。".repeat(1_000),
      scope: { type: "none" },
      modelId
    }).expect(409);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(failed.body.error).toMatchObject({
      code: "AI_CONTEXT_COMPACTION_UNAVAILABLE",
      message: expect.stringContaining("没有可压缩的较早对话")
    });
  });

  it("OpenAI 工具参数收齐前暂存正文，结束标记后才执行工具并继续流式回答", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    let releaseFirstRound = (): void => undefined;
    const firstRoundGate = new Promise<void>((resolve) => {
      releaseFirstRound = resolve;
    });
    let firstRoundFinished = false;
    let completionCount = 0;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      }
      completionCount += 1;
      const body = JSON.parse(String(init?.body)) as {
        stream?: boolean;
        tools?: Array<{ function?: { name?: string } }>;
        messages: Array<{ role: string; tool_calls?: Array<{ function?: { arguments?: string } }> }>;
      };
      expect(body.stream).toBe(true);
      expect(body.tools?.some((tool) => tool.function?.name === "story_index")).toBe(true);
      if (completionCount === 1) {
        return new Response(new ReadableStream<Uint8Array>({
          async start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"我先读取目录。"}}]}\n\n'));
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"stream-tool","type":"function","function":{"name":"story_index","arguments":"{\\"lim"}}]}}]}\n\n'));
            await firstRoundGate;
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"it\\":1}"}}]},"finish_reason":"tool_calls"}]}\n\n'));
            controller.enqueue(encoder.encode('data: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":5}}\n\n'));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            firstRoundFinished = true;
            controller.close();
          }
        }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      const assistant = body.messages.find((message) => message.role === "assistant");
      expect(assistant?.tool_calls?.[0]?.function?.arguments).toBe('{"limit":1}');
      expect(body.messages.some((message) => message.role === "tool")).toBe(true);
      return new Response([
        'data: {"choices":[{"delta":{"content":"已读取"}}]}',
        'data: {"choices":[{"delta":{"content":"目录。"},"finish_reason":"stop"}]}',
        'data: {"choices":[],"usage":{"prompt_tokens":30,"completion_tokens":4}}',
        "data: [DONE]"
      ].join("\n\n") + "\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } });
    });

    const deltas: string[] = [];
    const toolEvents: Array<{ arguments: unknown }> = [];
    const generatedPromise = runtime.ai.createStreamingChat({
      workId,
      instruction: "读取目录后回答。",
      scope: { type: "chapter", chapterId },
      modelId,
      onToolCall: (toolCall) => toolEvents.push({ arguments: toolCall.arguments })
    }, (delta) => deltas.push(delta));
    const safetyRelease = setTimeout(releaseFirstRound, 1_000);
    for (let index = 0; index < 100 && firstRoundFinished === false; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(deltas).toEqual(["我先读取目录。"]);
    expect(toolEvents).toHaveLength(0);
    expect(firstRoundFinished).toBe(false);
    releaseFirstRound();
    clearTimeout(safetyRelease);

    const generated = await generatedPromise;
    expect(deltas).toEqual(["我先读取目录。", "已读取", "目录。"]);
    expect(generated.content).toBe("已读取目录。");
    expect(generated.toolCalls).toEqual([
      expect.objectContaining({ id: "stream-tool", name: "story_index", arguments: { offset: 0, limit: 1 }, status: "completed" })
    ]);
    expect(toolEvents).toEqual([{ arguments: { offset: 0, limit: 1 } }]);
    expect(completionCount).toBe(2);
  });

  it("通过 SSE 推送工具调用并在对话 metadata 中持久化详情", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    let completionCount = 0;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      const body = JSON.parse(String(init?.body)) as {
        stream?: boolean;
        tools?: Array<{ function?: { name?: string } }>;
        messages: Array<{ role: string; reasoning_content?: string | null; tool_calls?: Array<{ function?: { arguments?: string } }> }>;
      };
      expect(body.stream).toBe(true);
      expect(body.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({ function: expect.objectContaining({ name: "story_index" }) })
      ]));
      completionCount += 1;
      if (completionCount === 1) {
        return new Response([
          'data: {"choices":[{"delta":{"reasoning_content":"需要先确认作品结构。"}}]}',
          'data: {"choices":[{"delta":{"content":"我先读取作品目录。"}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"stream-tool","type":"function","function":{"name":"story_","arguments":"{\\"lim"}}]}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"index","arguments":"it\\":1}"}}]},"finish_reason":"tool_calls"}]}',
          'data: {"choices":[],"usage":{"prompt_tokens":100,"prompt_tokens_details":{"cached_tokens":50},"completion_tokens":6}}',
          "data: [DONE]"
        ].join("\n\n"), { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      expect(body.messages.find((message) => message.role === "assistant")?.reasoning_content).toBe("需要先确认作品结构。");
      expect(body.messages.find((message) => message.role === "assistant")?.tool_calls?.[0]?.function?.arguments).toBe("{\"limit\":1}");
      return new Response([
        'data: {"choices":[{"delta":{"reasoning_content":"目录结果足以回答。"}}]}',
        'data: {"choices":[{"delta":{"content":"已读取"}}]}',
        'data: {"choices":[{"delta":{"content":"目录。"},"finish_reason":"stop"}]}',
        'data: {"choices":[],"usage":{"prompt_tokens":200,"prompt_tokens_details":{"cached_tokens":150},"completion_tokens":8}}',
        "data: [DONE]"
      ].join("\n\n"), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    });

    const streamed = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "读取目录后回答。",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(200).expect("Content-Type", /text\/event-stream/u);

    expect(streamed.text).toContain("event: tool_call");
    expect(streamed.text).toContain("event: process_step");
    expect(streamed.text).toContain('"type":"thinking","round":1,"content":"需要先确认作品结构。"');
    expect(streamed.text).toContain('"type":"thinking","round":2,"content":"目录结果足以回答。"');
    expect(streamed.text.indexOf('"type":"thinking","round":1')).toBeLessThan(streamed.text.indexOf("event: tool_call"));
    expect(streamed.text).toContain('event: delta\ndata: {"delta":"我先读取作品目录。"}');
    expect(streamed.text).toContain('event: process_step\ndata: {"id":"process_');
    expect(streamed.text).toContain('"type":"intermediate","round":1,"content":"我先读取作品目录。"');
    expect(streamed.text.indexOf('"delta":"我先读取作品目录。"')).toBeLessThan(streamed.text.indexOf('"type":"intermediate","round":1,"content":"我先读取作品目录。"'));
    expect(streamed.text.indexOf('"type":"intermediate","round":1,"content":"我先读取作品目录。"')).toBeLessThan(streamed.text.indexOf("event: tool_call"));
    expect(streamed.text).toContain('"name":"story_index"');
    expect(streamed.text).toContain('"arguments":{"offset":0,"limit":1}');
    expect(streamed.text).toMatch(/"calledAt":"\d{4}-\d{2}-\d{2}T/u);
    expect(streamed.text).toContain('"result":{"ok":true');
    expect(streamed.text).toContain('event: delta\ndata: {"delta":"已读取"}');
    expect(streamed.text).toContain('event: delta\ndata: {"delta":"目录。"}');
    expect(streamed.text).toContain('event: complete');
    expect(streamed.text).toContain('"outputTokens":8,"cacheHitPercent":66.7');
    expect(streamed.text).toContain('"toolCalls":[{"id":"stream-tool"');
    expect(streamed.text).toContain('"processSteps":[{"id":"process_');
    const completePayload = JSON.parse(streamed.text.match(/event: complete\ndata: ([^\n]+)/u)?.[1] ?? "{}") as { conversationId?: string; processDurationMs?: number };
    expect(completePayload.processDurationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(completePayload.processDurationMs)).toBe(true);
    const streamedConversation = await request(runtime.app).get(`/api/ai-conversations/${completePayload.conversationId}`).expect(200);
    expect(streamedConversation.body.data.messages.at(-1).metadata.processDurationMs).toBe(completePayload.processDurationMs);
    const generatedSuggestions = await request(runtime.app).get(`/api/works/${workId}/suggestions`).expect(200);
    expect(generatedSuggestions.body.data[0].content).toBe("已读取目录。");

    const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    const toolCalls = [{ id: "stream-tool", name: "story_index", calledAt: "2026-07-17T12:34:56.000Z", arguments: { offset: 0, limit: 1 }, status: "completed", result: { ok: true, data: { totalChapters: 1 } } }];
    const processSteps = [
      { id: "process-thinking", type: "thinking", round: 1, content: "需要读取目录。", createdAt: "2026-07-17T12:34:55.000Z" },
      { id: "process-compaction", type: "context_compaction", round: 1, sourceMessageCount: 2, sourceChars: 12000, summaryChars: 180, createdAt: "2026-07-17T12:34:55.500Z" },
      { id: "process-tool", type: "tool", round: 1, toolCall: toolCalls[0], createdAt: "2026-07-17T12:34:56.000Z" }
    ];
    await request(runtime.app).post(`/api/ai-conversations/${conversation.body.data.id}/messages`).send({
      role: "assistant",
      content: "已读取目录。",
      metadata: { modelDisplayName: "小说模型", outputTokens: 8, cacheHitPercent: 66.7, processDurationMs: 1450, toolCalls, processSteps }
    }).expect(201);
    const reloaded = await request(runtime.app).get(`/api/ai-conversations/${conversation.body.data.id}`).expect(200);
    expect(reloaded.body.data.messages[0].metadata.toolCalls).toEqual(toolCalls);
    expect(reloaded.body.data.messages[0].metadata.processSteps).toEqual(processSteps);
    expect(reloaded.body.data.messages[0].metadata.processDurationMs).toBe(1450);
    expect(reloaded.body.data.messages[0].metadata.cacheHitPercent).toBe(66.7);
  });

  it("完整读取响应正文前不释放供应商并发槽", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    await request(runtime.app).patch(`/api/providers/${providerId}`).send({ concurrencyLimit: 3, rpmLimit: 100 }).expect(200);
    let active = 0;
    let maximumActive = 0;
    let chatStarts = 0;
    fetchMock.mockImplementation(async (input) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      chatStarts += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          setTimeout(() => {
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ choices: [{ message: { content: "并发响应" } }] })));
            controller.close();
            active -= 1;
          }, 20);
        }
      });
      return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
    });
    await Promise.all(Array.from({ length: 7 }, (_, index) => runtime.ai.generate({
      workId,
      taskType: "chat",
      instruction: `并发请求 ${index}`,
      scope: { type: "chapter", chapterId },
      modelId
    })));
    expect(chatStarts).toBe(7);
    expect(maximumActive).toBe(3);
  });

  it("按滚动一分钟窗口限制供应商 RPM", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    await request(runtime.app).patch(`/api/providers/${providerId}`).send({ concurrencyLimit: 10, rpmLimit: 2 }).expect(200);
    let chatStarts = 0;
    fetchMock.mockImplementation(async () => {
      chatStarts += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: "限流响应" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.useFakeTimers();
    const calls = Array.from({ length: 3 }, (_, index) => runtime.ai.generate({
      workId,
      taskType: "chat",
      instruction: `RPM 请求 ${index}`,
      scope: { type: "chapter", chapterId },
      modelId
    }));
    await vi.advanceTimersByTimeAsync(0);
    expect(chatStarts).toBe(2);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(chatStarts).toBe(2);
    await vi.advanceTimersByTimeAsync(2);
    await Promise.all(calls);
    expect(chatStarts).toBe(3);
  });

  it("修改供应商限额后立即刷新已经存在的排队请求", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    await request(runtime.app).patch(`/api/providers/${providerId}`).send({ concurrencyLimit: 1, rpmLimit: 1 }).expect(200);
    let chatStarts = 0;
    const resolveRequests: Array<() => void> = [];
    fetchMock.mockImplementation(async (input) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      chatStarts += 1;
      return new Promise<Response>((resolve) => {
        resolveRequests.push(() => resolve(new Response(JSON.stringify({ choices: [{ message: { content: "动态限额响应" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })));
      });
    });
    const calls = Array.from({ length: 3 }, (_, index) => runtime.ai.generate({
      workId,
      taskType: "chat",
      instruction: `动态限额请求 ${index}`,
      scope: { type: "chapter", chapterId },
      modelId
    }));
    for (let index = 0; index < 50 && chatStarts < 1; index += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(chatStarts).toBe(1);

    await request(runtime.app).patch(`/api/providers/${providerId}`).send({ concurrencyLimit: 2, rpmLimit: 2 }).expect(200);
    for (let index = 0; index < 50 && chatStarts < 2; index += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(chatStarts).toBe(2);
    resolveRequests.splice(0).forEach((resolve) => resolve());

    await request(runtime.app).patch(`/api/providers/${providerId}`).send({ rpmLimit: 3 }).expect(200);
    for (let index = 0; index < 50 && chatStarts < 3; index += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(chatStarts).toBe(3);
    resolveRequests.splice(0).forEach((resolve) => resolve());
    await Promise.all(calls);
  });

  it("请求超时覆盖响应正文读取阶段", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    fetchMock.mockImplementation(async (_input, init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
      }
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.useFakeTimers();
    const call = runtime.ai.generate({
      workId,
      taskType: "chat",
      instruction: "等待慢响应正文",
      scope: { type: "chapter", chapterId },
      modelId,
      maxAttempts: 1
    });
    const rejection = expect(call).rejects.toMatchObject({
      message: "AI 调用失败",
      details: { failure: "AI 请求超时（60 秒）" }
    });
    await vi.advanceTimersByTimeAsync(60_001);
    await rejection;
    const calls = await request(runtime.app).get(`/api/works/${workId}/ai-calls`).expect(200);
    expect(calls.body.data[0]).toMatchObject({ status: "failed" });
  });

  it("全书分析使用供应商配置的单次请求超时", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    await request(runtime.app).patch(`/api/providers/${providerId}`).send({ analysisTimeoutSeconds: 30 }).expect(200);
    fetchMock.mockImplementation(async (_input, init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
      }
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.useFakeTimers();
    const call = runtime.ai.generate({
      workId,
      taskType: "book-analysis",
      instruction: "等待供应商分析超时",
      scope: { type: "chapter", chapterId },
      modelId,
      maxAttempts: 1
    });
    const rejection = expect(call).rejects.toMatchObject({
      message: "AI 调用失败",
      details: { failure: "AI 请求超时（30 秒）" }
    });
    await vi.advanceTimersByTimeAsync(30_001);
    await rejection;
  });

  it("AskUserQuestions 必选提示随对话工具快照冻结且只影响新对话", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    await request(runtime.app).put(`/api/works/${workId}/ai/tools`).send({
      tools: { ask_user_questions: true }
    }).expect(200);
    const captured: Array<{ systemPrompt: string; toolNames: string[] }> = [];
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: Array<{ role?: string; content?: string }>;
        tools?: Array<{ function?: { name?: string } }>;
      };
      captured.push({
        systemPrompt: String(body.messages?.find((message) => message.role === "system")?.content ?? ""),
        toolNames: (body.tools ?? []).flatMap((tool) => typeof tool.function?.name === "string" ? [tool.function.name] : [])
      });
      return new Response(JSON.stringify({ choices: [{ message: { content: "无需向作者提问。" } }] }), { status: 200 });
    });

    const frozenConversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    const frozenConversationId = String(frozenConversation.body.data.id);
    const send = (conversationId: string, instruction: string) => request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction,
      scope: { type: "chapter", chapterId },
      modelId,
      conversationId
    }).expect(200);
    await send(frozenConversationId, "第一轮无需提问");
    await request(runtime.app).put(`/api/works/${workId}/ai/tools`).send({
      tools: { ask_user_questions: false }
    }).expect(200);
    await send(frozenConversationId, "关闭开关后的同一对话");

    const newConversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    const newConversationId = String(newConversation.body.data.id);
    await send(newConversationId, "关闭开关后的新对话");

    expect(captured).toHaveLength(3);
    const mandatoryGuidance = "只要你需要向作者提出任何问题";
    expect(captured[0]?.systemPrompt).toContain(mandatoryGuidance);
    expect(captured[0]?.systemPrompt).toContain("禁止在普通回复正文中直接写出问题");
    expect(captured[0]?.toolNames).toContain("ask_user_question");
    expect(captured[1]?.systemPrompt).toBe(captured[0]?.systemPrompt);
    expect(captured[1]?.toolNames).toContain("ask_user_question");
    expect(captured[2]?.systemPrompt).not.toContain(mandatoryGuidance);
    expect(captured[2]?.toolNames).not.toContain("ask_user_question");
  });

  it("AskUserQuestions 持久化挂起 Agent loop 并在回答后只恢复一次", async () => {
    const { providerId, modelId } = await configureAi();
    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    await request(runtime.app).put(`/api/works/${workId}/ai/tools`).send({
      tools: { ask_user_questions: true, settings: true }
    }).expect(200);
    const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    const conversationId = String(conversation.body.data.id);
    let completionCount = 0;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), { status: 200 });
      completionCount += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: Array<{
          role?: string;
          content?: string;
          tool_call_id?: string;
          tool_calls?: Array<{ id?: string; function?: { name?: string } }>;
        }>;
      };
      if (completionCount === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [
          { id: "ask-once", type: "function", function: { name: "ask_user_question", arguments: { question: "采用哪个方向？", options: ["甲", "乙"] } } },
          { id: "must-not-run", type: "function", function: { name: "propose_write_plan", arguments: { aiSummary: "不应提前执行", operations: [{ opType: "create_entry", entityType: "setting", input: { title: "未确认", category: "地点", content: "内容" } }] } } }
        ] } }] }), { status: 200 });
      }
      const assistantToolMessage = body.messages?.find((message) => message.role === "assistant" && message.tool_calls?.length);
      expect(assistantToolMessage?.tool_calls).toEqual([
        expect.objectContaining({ id: "ask-once", function: expect.objectContaining({ name: "ask_user_question" }) })
      ]);
      const toolResult = body.messages?.find((message) => message.role === "tool" && message.tool_call_id === "ask-once");
      expect(toolResult?.content).toContain('"selectedOption":"甲"');
      expect(toolResult?.content).toContain('"supplementalAnswer":"补充采用冷色调"');
      return new Response(JSON.stringify({ choices: [{ message: { content: "已按真实回答继续。" } }] }), { status: 200 });
    });

    const suspended = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "先询问再继续",
      scope: { type: "chapter", chapterId },
      modelId,
      conversationId
    }).expect(200);
    expect(suspended.text).toContain('"name":"ask_user_question"');
    expect(suspended.text).toContain("已向你提出问题，等待回答后继续。");
    expect(suspended.text).toMatch(/"messageId":"message_[^"]+"/u);
    expect(suspended.text).not.toContain('"name":"propose_write_plan"');
    expect(completionCount).toBe(1);
    const suspendedAssistant = runtime.database.get<{ content: string; metadata_json: string }>(
      "SELECT content, metadata_json FROM ai_conversation_messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1",
      conversationId
    );
    expect(suspendedAssistant?.content).toBe("已向你提出问题，等待回答后继续。");
    const suspendedMetadata = JSON.parse(String(suspendedAssistant?.metadata_json ?? "{}"));
    expect(suspendedMetadata.toolCalls).toMatchObject([
      { name: "ask_user_question", status: "completed" }
    ]);
    expect(suspendedMetadata).not.toHaveProperty("anthropicContent");
    const questions = await request(runtime.app).get(`/api/works/${workId}/ai/questions?conversationId=${conversationId}`).expect(200);
    const questionId = String(questions.body.data.questions[0].id);
    expect(questions.body.data.questions[0]).toMatchObject({ status: "pending", resumeState: "pending" });

    const answered = await request(runtime.app).post(`/api/works/${workId}/ai/questions/${questionId}/answer`)
      .send({ selectedOption: 0, customAnswer: "补充采用冷色调" })
      .expect(200);
    expect(answered.body.data).toMatchObject({
      status: "answered",
      selectedOptionLabel: "甲",
      customAnswer: "补充采用冷色调",
      answerText: "甲\n补充信息：补充采用冷色调",
      resumeState: "completed"
    });
    expect(completionCount).toBe(2);
    const completedMessages = runtime.database.all<{ role: string; content: string; metadata_json: string }>(
      "SELECT role, content, metadata_json FROM ai_conversation_messages WHERE conversation_id = ? ORDER BY created_at, rowid",
      conversationId
    );
    expect(completedMessages).toHaveLength(2);
    expect(completedMessages[1]).toMatchObject({ role: "assistant", content: "已按真实回答继续。" });
    const completedMetadata = JSON.parse(String(completedMessages[1]?.metadata_json ?? "{}"));
    expect(completedMetadata.toolCalls).toMatchObject([
      { id: "ask-once", name: "ask_user_question", result: { question: { status: "answered", answerText: "甲\n补充信息：补充采用冷色调" } } }
    ]);
    await request(runtime.app).post(`/api/works/${workId}/ai/questions/${questionId}/answer`).send({ selectedOption: 0 }).expect(409);
    expect(completionCount).toBe(2);
  });
});
