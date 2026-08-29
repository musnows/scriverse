import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextBuilder } from "../../src/ai.js";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime, seedChapter } from "../helpers.js";

describe("主动语义检索 API", () => {
  let runtime: Runtime | null = null;

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
  });

  it("增量构建、融合、rerank、快照注入并拒绝返回失败后的旧版本", async () => {
    let invalidEmbedding = false;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/embeddings")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
        const values = Array.isArray(body.input) ? body.input : [];
        return new Response(JSON.stringify({
          object: "list",
          data: values.map((value, index) => ({
            object: "embedding",
            index,
            embedding: invalidEmbedding
              ? [Number.NaN, 0, 0]
              : value.includes("北港") || value.includes("议会") ? [1, 0, 0]
                : value.includes("南城") ? [0, 1, 0]
                  : [0, 0, 1]
          })),
          usage: { prompt_tokens: values.length * 3, total_tokens: values.length * 3 }
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/chat/completions")) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: "普通对话回复。" } }],
          usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/completions")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { prompt?: string };
        return new Response(JSON.stringify({
          choices: [{ text: body.prompt?.includes("北港议会") ? "yes" : "no" }],
          usage: { prompt_tokens: 20, completion_tokens: 1, total_tokens: 21 }
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    runtime = createTestRuntime(fetchMock);
    const seeded = await seedChapter(runtime, "林舟抵达北港。\n\n北港议会掌管港口航道。\n\n南城位于群山之间。");
    const workId = String(seeded.work.id);
    const setting = runtime.store.createSetting(workId, {
      title: "北港制度",
      category: "规则",
      content: "北港议会负责审批所有远航。"
    });
    const provider = runtime.ai.createProvider({
      name: "本地语义模型",
      baseUrl: "http://127.0.0.1:1234/v1",
      apiKey: "lm-studio",
      status: "enabled",
      rpmLimit: 10_000
    });
    runtime.database.run("UPDATE providers SET connection_status = 'success' WHERE id = ?", String(provider.id));
    const embeddingModel = runtime.ai.createModel(String(provider.id), {
      displayName: "Qwen3 Embedding",
      modelId: "text-embedding-qwen3-embedding-0.6b",
      modelKind: "embedding"
    });
    const rerankModel = runtime.ai.createModel(String(provider.id), {
      displayName: "Qwen3 Reranker",
      modelId: "qwen3-reranker-0.6b",
      modelKind: "rerank"
    });
    const chatModel = runtime.ai.createModel(String(provider.id), {
      displayName: "Chat Model",
      modelId: "chat-model",
      modelKind: "chat"
    });

    const configured = await request(runtime.app)
      .patch(`/api/works/${workId}/ai-settings/semantic-search`)
      .send({
        enabled: true,
        embeddingModelId: embeddingModel.id,
        rerankModelId: rerankModel.id,
        vectorDimension: 3,
        recallLimit: 10,
        resultLimit: 6,
        budgetTokens: 2_000,
        channelWeight: 1.2
      })
      .expect(200);
    expect(configured.body.data).toMatchObject({
      semanticSearchEnabled: true,
      semanticEmbeddingModelId: embeddingModel.id,
      semanticRerankModelId: rerankModel.id,
      semanticVectorDimension: 3,
      semanticIndex: { status: "idle" }
    });

    const internals = runtime.ai as unknown as {
      ensureSemanticSearchIndex(workId: string, force: boolean): Promise<Record<string, unknown>>;
    };
    const built = await internals.ensureSemanticSearchIndex(workId, true);
    expect(built).toMatchObject({ status: "ready", ready: true, failedSources: 0 });
    expect(Number(built.indexedChunkCount)).toBeGreaterThanOrEqual(2);

    const searched = await request(runtime.app)
      .post(`/api/works/${workId}/semantic-search`)
      .send({
        query: "谁控制北港的远航审批？",
        types: ["chapter", "setting"],
        currentChapterId: seeded.chapter.id,
        selection: "北港航道",
        includeKeyword: true
      })
      .expect(200);
    expect(searched.body.data).toMatchObject({ status: "ready", semanticUsed: true, degraded: false });
    expect(searched.body.data.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entryId: expect.stringMatching(/^semanticChunk_/u),
        matchKinds: expect.arrayContaining(["semantic"]),
        sourceVersion: expect.any(String),
        semanticScore: expect.any(Number),
        rerankScore: expect.any(Number),
        estimatedTokens: expect.any(Number)
      })
    ]));
    const selected = searched.body.data.results.find((item: { entryId?: string }) => item.entryId);
    expect(selected).toBeDefined();

    const snapshot = await request(runtime.app)
      .post(`/api/works/${workId}/semantic-search/snapshots`)
      .send({ query: "谁控制北港的远航审批？", entryIds: [selected.entryId], scope: { types: ["chapter", "setting"] } })
      .expect(201);
    expect(snapshot.body.data).toMatchObject({ itemCount: 1, estimatedTokens: expect.any(Number) });
    const context = new ContextBuilder(runtime.store).buildPlan(workId, {
      type: "none",
      semanticSnapshotId: snapshot.body.data.id
    }, 10_000);
    expect(context.context).toContain("用户主动语义检索快照");
    expect(context.context).toContain(String(selected.snippet));

    const embeddingCalls = runtime.database.get(
      "SELECT COUNT(*) AS count FROM ai_calls WHERE work_id = ? AND task_type = 'embedding'",
      workId
    );
    const rerankCalls = runtime.database.get(
      "SELECT COUNT(*) AS count FROM ai_calls WHERE work_id = ? AND task_type = 'rerank'",
      workId
    );
    expect(Number(embeddingCalls?.count)).toBeGreaterThan(1);
    expect(Number(rerankCalls?.count)).toBeGreaterThan(0);

    runtime.store.updateWorkAiSettings(workId, {
      agentTools: [...runtime.store.getWorkAiSettings(workId).agentTools as string[], "semantic_search_story"]
    });
    const toolRuntime = runtime.ai as unknown as {
      executeAgentTool(workId: string, toolCall: Record<string, unknown>): Promise<Record<string, unknown>>;
    };
    const toolExecution = await toolRuntime.executeAgentTool(workId, {
      id: "semantic-tool-call",
      type: "function",
      function: {
        name: "semantic_search_story",
        arguments: JSON.stringify({ query: "谁控制北港的远航审批？", modules: ["prose", "settings"], limit: 5 })
      }
    });
    expect(toolExecution).toMatchObject({
      name: "semantic_search_story",
      status: "completed",
      result: { ok: true, data: { semanticUsed: true, matches: expect.any(Array) } }
    });

    const embeddingsBeforeOrdinaryChat = Number(runtime.database.get(
      "SELECT COUNT(*) AS count FROM ai_calls WHERE work_id = ? AND task_type = 'embedding'",
      workId
    )?.count ?? 0);
    await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "普通聊天不应自动检索",
      scope: { type: "none" },
      modelId: chatModel.id
    }).expect(201);
    expect(Number(runtime.database.get(
      "SELECT COUNT(*) AS count FROM ai_calls WHERE work_id = ? AND task_type = 'embedding'",
      workId
    )?.count ?? 0)).toBe(embeddingsBeforeOrdinaryChat);

    invalidEmbedding = true;
    runtime.store.updateSetting(String(setting.id), { content: "当前版本只说明南城制度，不再包含旧的远航审批内容。" });
    const failed = await internals.ensureSemanticSearchIndex(workId, false);
    expect(failed).toMatchObject({ status: "failed", failedSources: 1 });
    const degraded = await request(runtime.app)
      .post(`/api/works/${workId}/semantic-search`)
      .send({ query: "远航审批", types: ["setting"], includeKeyword: false })
      .expect(200);
    expect(degraded.body.data.results).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ snippet: expect.stringContaining("负责审批所有远航") })
    ]));
    expect(runtime.database.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });
});
