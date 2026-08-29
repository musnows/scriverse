import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime } from "../helpers.js";

describe("AI 分析任务模型", () => {
  let runtime: Runtime | null = null;

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
  });

  it("专用 embedding 与 rerank 模型不会进入对话和分析模型列表", async () => {
    runtime = createTestRuntime();
    const work = await request(runtime.app).post("/api/works").send({ title: "专用模型类型测试" }).expect(201);
    const workId = String(work.body.data.id);
    const provider = runtime.ai.createProvider({
      name: "语义模型服务",
      baseUrl: "https://semantic-model.test/v1",
      apiKey: "sk-semantic-model-test",
      status: "enabled"
    });
    runtime.database.run("UPDATE providers SET connection_status = 'success' WHERE id = ?", String(provider.id));
    const chatModel = await request(runtime.app).post(`/api/providers/${provider.id}/models`).send({
      displayName: "Chat 模型",
      modelId: "chat-model",
      modelKind: "chat"
    }).expect(201);
    const embeddingModel = await request(runtime.app).post(`/api/providers/${provider.id}/models`).send({
      displayName: "Embedding 模型",
      modelId: "embedding-model",
      modelKind: "embedding"
    }).expect(201);
    const rerankModel = await request(runtime.app).post(`/api/providers/${provider.id}/models`).send({
      displayName: "Rerank 模型",
      modelId: "rerank-model",
      modelKind: "rerank"
    }).expect(201);

    const models = await request(runtime.app).get(`/api/works/${workId}/models`).expect(200);
    expect(models.body.data.map((model: { id: string }) => model.id)).toEqual([chatModel.body.data.id]);
    await request(runtime.app).put(`/api/works/${workId}/task-defaults/chat`).send({
      modelId: embeddingModel.body.data.id
    }).expect(400).expect(({ body }) => expect(body.error.code).toBe("MODEL_KIND_UNSUPPORTED"));
    await request(runtime.app).put(`/api/works/${workId}/task-defaults/chat`).send({
      modelId: rerankModel.body.data.id
    }).expect(400).expect(({ body }) => expect(body.error.code).toBe("MODEL_KIND_UNSUPPORTED"));
  });

  it("创建任务时固化本书默认模型并允许单任务覆盖", async () => {
    const requestedModels: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "analysis-model-a" }, { id: "analysis-model-b" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string; max_tokens?: number };
      if (body.max_tokens !== 10 && body.model) requestedModels.push(body.model);
      return new Response(JSON.stringify({
        choices: [{ message: { content: "已完成全书综合分析。" } }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    runtime = createTestRuntime(fetchMock);

    const work = await request(runtime.app).post("/api/works").send({ title: "任务模型测试" }).expect(201);
    const workId = String(work.body.data.id);
    const volume = await request(runtime.app).post(`/api/works/${workId}/volumes`).send({ title: "第一卷" }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/chapters`).send({
      volumeId: volume.body.data.id,
      title: "第一章",
      content: "林舟在北港启动飞船。"
    }).expect(201);
    const provider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
      name: "分析模型服务",
      baseUrl: "https://analysis-model.test/v1",
      apiKey: "sk-analysis-model-test",
      status: "enabled"
    }).expect(201);
    await request(runtime.app).post(`/api/providers/${provider.body.data.id}/test`).send({}).expect(200);
    const modelA = await request(runtime.app).post(`/api/providers/${provider.body.data.id}/models`).send({
      displayName: "分析模型 A",
      modelId: "analysis-model-a"
    }).expect(201);
    const modelB = await request(runtime.app).post(`/api/providers/${provider.body.data.id}/models`).send({
      displayName: "分析模型 B",
      modelId: "analysis-model-b"
    }).expect(201);

    await request(runtime.app).put(`/api/works/${workId}/task-defaults/book-analysis`).send({
      modelId: modelA.body.data.id
    }).expect(200);
    const defaultTask = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "book-analysis",
      scope: { type: "book" }
    }).expect(201);
    expect(defaultTask.body.data.model).toMatchObject({
      id: modelA.body.data.id,
      displayName: "分析模型 A",
      modelId: "analysis-model-a"
    });

    await request(runtime.app).put(`/api/works/${workId}/task-defaults/book-analysis`).send({
      modelId: modelB.body.data.id
    }).expect(200);
    const mappedDefaultTask = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "worldview-analysis",
      scope: { type: "book" }
    }).expect(201);
    expect(mappedDefaultTask.body.data.model.id).toBe(modelB.body.data.id);

    const overriddenTask = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "book-analysis",
      scope: { type: "book" },
      modelId: modelA.body.data.id
    }).expect(201);
    expect(overriddenTask.body.data.model.id).toBe(modelA.body.data.id);

    const scopedIdentityTask = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "character-identity-audit",
      scope: { type: "volume", volumeId: volume.body.data.id, volumeIds: [volume.body.data.id] },
      modelId: modelA.body.data.id
    }).expect(201);
    expect(scopedIdentityTask.body.data.scope).toMatchObject({
      type: "volume",
      volumeIds: [volume.body.data.id]
    });

    const completed = await request(runtime.app).post(`/api/tasks/${defaultTask.body.data.id}/run`).send({}).expect(200);
    expect(completed.body.data).toMatchObject({
      taskType: "book-analysis",
      status: "review",
      result: { content: "已完成全书综合分析。", callId: expect.stringMatching(/^call_/u) }
    });
    expect(requestedModels).toEqual(["analysis-model-a"]);
    const storedTask = runtime.database.get<Record<string, unknown>>(
      "SELECT model_id FROM analysis_tasks WHERE id = ?",
      defaultTask.body.data.id
    );
    expect(storedTask?.model_id).toBe(modelA.body.data.id);

    const tasks = await request(runtime.app).get(`/api/works/${workId}/tasks`).expect(200);
    expect(tasks.body.data.items.find((item: { id: string }) => item.id === overriddenTask.body.data.id)?.model)
      .toMatchObject({ id: modelA.body.data.id, displayName: "分析模型 A" });
    const defaults = await request(runtime.app).get(`/api/works/${workId}/task-defaults`).expect(200);
    expect(defaults.body.data.find((item: { taskType: string }) => item.taskType === "book-analysis")?.model.id)
      .toBe(modelB.body.data.id);
  });

  it("创建任务前拒绝超过模型安全上下文阈值的注入范围", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "short-context-model" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as { choices?: unknown };
      return new Response(JSON.stringify({
        choices: [{ message: { content: body.choices ? "" : "[]" } }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    runtime = createTestRuntime(fetchMock);

    const work = await request(runtime.app).post("/api/works").send({ title: "上下文预检测试" }).expect(201);
    const workId = String(work.body.data.id);
    const volume = await request(runtime.app).post(`/api/works/${workId}/volumes`).send({ title: "第一卷" }).expect(201);
    const chapter = await request(runtime.app).post(`/api/works/${workId}/chapters`).send({
      volumeId: volume.body.data.id,
      title: "超长章节",
      content: "星".repeat(30_000)
    }).expect(201);
    const provider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
      name: "短上下文服务",
      baseUrl: "https://short-context.test/v1",
      apiKey: "sk-short-context-test",
      status: "enabled"
    }).expect(201);
    await request(runtime.app).post(`/api/providers/${provider.body.data.id}/test`).send({}).expect(200);
    const model = await request(runtime.app).post(`/api/providers/${provider.body.data.id}/models`).send({
      displayName: "短上下文模型",
      modelId: "short-context-model"
    }).expect(201);
    runtime.database.run("UPDATE models SET context_window = ? WHERE id = ?", 32_768, model.body.data.id);

    const preview = await request(runtime.app).post(`/api/works/${workId}/tasks/context-preview`).send({
      taskType: "book-analysis",
      scope: { type: "chapter", chapterId: chapter.body.data.id },
      modelId: model.body.data.id
    }).expect(200);
    expect(preview.body.data).toMatchObject({ allowed: false, overThreshold: true });
    expect(preview.body.data.message).toContain("上下文更长的模型");

    const rejected = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "book-analysis",
      scope: { type: "book" },
      modelId: model.body.data.id
    }).expect(413);
    expect(rejected.body.error).toMatchObject({ code: "AI_CONTEXT_TOO_LARGE" });
    expect(rejected.body.error.message).toContain("上下文更长的模型");
  });

  it("定向关系任务上下文预检只读取轻量范围元数据", () => {
    runtime = createTestRuntime();
    const work = runtime.store.createWork({ title: "定向关系上下文预检" });
    const workId = String(work.id);
    const volume = runtime.store.createVolume(workId, { title: "第一卷" });
    runtime.store.createChapter(workId, {
      volumeId: String(volume.id),
      title: "第一章",
      content: "林舟与沈星共同调查北港旧约。".repeat(2_000)
    });
    const character = runtime.store.createCharacter(workId, {
      name: "林舟",
      profile: { background: "长期人物档案".repeat(2_000) }
    });
    const secondCharacter = runtime.store.createCharacter(workId, { name: "沈星" });
    const provider = runtime.ai.createProvider({
      name: "上下文预检模型",
      baseUrl: "https://context-preview.test/v1",
      apiKey: "sk-context-preview-test",
      status: "enabled"
    });
    runtime.database.run("UPDATE providers SET connection_status = 'success' WHERE id = ?", String(provider.id));
    const model = runtime.ai.createModel(String(provider.id), {
      displayName: "上下文预检模型",
      modelId: "context-preview-model",
      contextWindow: 200_000
    });
    const compactModel = runtime.ai.createModel(String(provider.id), {
      displayName: "短上下文预检模型",
      modelId: "compact-context-preview-model",
      contextWindow: 20_000
    });
    const getWorkTree = vi.spyOn(runtime.store, "getWorkTree");
    const listCharacters = vi.spyOn(runtime.store, "listCharacters");

    const preview = runtime.ai.previewAnalysisTaskContext(workId, {
      taskType: "relationship-analysis",
      scope: { type: "book", characterIds: [String(character.id)] },
      modelId: String(model.id)
    });

    expect(preview).toMatchObject({ allowed: true, overThreshold: false });
    expect(getWorkTree).not.toHaveBeenCalled();
    expect(listCharacters).not.toHaveBeenCalled();

    const compactPreview = runtime.ai.previewAnalysisTaskContext(workId, {
      taskType: "relationship-analysis",
      scope: { type: "book", characterIds: [String(secondCharacter.id)] },
      modelId: String(compactModel.id)
    });
    expect(compactPreview).toMatchObject({ allowed: true, overThreshold: false });
  });

  it("百万字符时间线任务只按最大正文分片预检", async () => {
    runtime = createTestRuntime();
    const work = runtime.store.createWork({ title: "百万字符时间线预检" });
    const workId = String(work.id);
    const volume = runtime.store.createVolume(workId, { title: "第一卷" });
    runtime.store.createChapter(workId, {
      volumeId: String(volume.id),
      title: "百万字符长章",
      content: "星".repeat(1_000_000)
    });
    const provider = runtime.ai.createProvider({
      name: "时间线短上下文模型",
      baseUrl: "https://timeline-context-preview.test/v1",
      apiKey: "sk-timeline-context-preview-test",
      status: "enabled"
    });
    runtime.database.run("UPDATE providers SET connection_status = 'success' WHERE id = ?", String(provider.id));
    const model = runtime.ai.createModel(String(provider.id), {
      displayName: "时间线短上下文模型",
      modelId: "timeline-context-preview-model",
      contextWindow: 32_768
    });

    const preview = runtime.ai.previewAnalysisTaskContext(workId, {
      taskType: "timeline-analysis",
      scope: { type: "book" },
      modelId: String(model.id)
    });

    expect(preview).toMatchObject({ allowed: true, overThreshold: false });
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "timeline-analysis",
      scope: { type: "book" },
      modelId: model.id
    }).expect(201);
    expect(task.body.data).toMatchObject({ status: "pending", taskType: "timeline-analysis" });
  });
});
