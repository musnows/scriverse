import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiManager } from "../../src/ai.js";
import type { Runtime } from "../../src/app.js";
import { CredentialVault } from "../../src/credential-vault.js";
import { createTestRuntime } from "../helpers.js";

function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("waitFor timeout"));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

async function setupWork(fetchMock: typeof fetch): Promise<{
  runtime: Runtime;
  workId: string;
  chapterIds: string[];
  releaseGates: Array<() => void>;
  gatedFetch: typeof fetch;
}> {
  const releaseGates: Array<() => void> = [];
  const gatedFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/models")) {
      return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as { max_tokens?: number };
    if (body.max_tokens === 10) {
      return new Response(JSON.stringify({ choices: [{ message: { content: "连接成功" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    await new Promise<void>((resolve, reject) => {
      const signal = init?.signal;
      const release = () => {
        signal?.removeEventListener("abort", rejectOnAbort);
        resolve();
      };
      const rejectOnAbort = () => reject(signal?.reason ?? new Error("AI request aborted"));
      if (signal?.aborted) {
        rejectOnAbort();
        return;
      }
      signal?.addEventListener("abort", rejectOnAbort, { once: true });
      releaseGates.push(release);
    });
    return fetchMock(input, init);
  };
  const runtime = createTestRuntime(gatedFetch);
  const work = await request(runtime.app).post("/api/works").send({ title: "自动运行测试" }).expect(201);
  const workId = work.body.data.id;
  const volume = await request(runtime.app).post(`/api/works/${workId}/volumes`).send({ title: "第一卷" }).expect(201);
  const chapterIds: string[] = [];
  for (let index = 1; index <= 5; index += 1) {
    const chapter = await request(runtime.app).post(`/api/works/${workId}/chapters`).send({
      volumeId: volume.body.data.id,
      title: `第${index}章`,
      content: `章节正文 ${index}`
    }).expect(201);
    chapterIds.push(chapter.body.data.id);
  }
  const provider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
    name: "本地兼容服务",
    baseUrl: "https://mock-ai.test/v1/chat/completions",
    apiKey: "sk-test-auto-run",
    status: "enabled"
  }).expect(201);
  await request(runtime.app).post(`/api/providers/${provider.body.data.id}/test`).send({}).expect(200);
  const model = await request(runtime.app).post(`/api/providers/${provider.body.data.id}/models`).send({
    displayName: "小说模型",
    modelId: "mock-novel-model",
    purposes: ["chapter-analysis", "chat"]
  }).expect(201);
  await request(runtime.app).put(`/api/works/${workId}/task-defaults/chapter-analysis`).send({ modelId: model.body.data.id }).expect(200);
  for (const chapterId of chapterIds) {
    await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "chapter-analysis",
      scope: { type: "chapter", chapterId }
    }).expect(201);
  }
  return { runtime, workId, chapterIds, releaseGates, gatedFetch };
}

describe("分析任务自动运行", () => {
  const runtimes: Runtime[] = [];

  afterEach(async () => {
    while (runtimes.length) await runtimes.pop()?.close();
  });

  it("keeps the new tool default when saving semantic settings and preserves valid existing values", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const workId = String(runtime.store.createWork({ title: "Tool defaults" }).id);
    expect(runtime.store.getWorkAiSettings(workId).agentToolCallLimit).toBe(20);
    runtime.store.updateWorkSemanticSearchSettings(workId, { enabled: false });
    expect(runtime.database.get("SELECT agent_tool_call_limit FROM work_ai_settings WHERE work_id = ?", workId)).toEqual({ agent_tool_call_limit: 20 });
    runtime.store.updateWorkAiSettings(workId, { agentToolCallLimit: 12 });
    runtime.store.updateWorkSemanticSearchSettings(workId, { enabled: false });
    expect(runtime.store.getWorkAiSettings(workId).agentToolCallLimit).toBe(12);
    runtime.database.run("UPDATE work_ai_settings SET agent_tool_call_limit = 5 WHERE work_id = ?", workId);
    expect(runtime.store.getWorkAiSettings(workId).agentToolCallLimit).toBe(10);
    runtime.store.updateWorkAiSettings(workId, { autoRunConcurrency: 3 });
    expect(runtime.database.get("SELECT agent_tool_call_limit FROM work_ai_settings WHERE work_id = ?", workId)).toEqual({ agent_tool_call_limit: 10 });
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ agentToolCallLimit: 10 }).expect(200);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ agentToolCallLimit: 10.5 }).expect(400);
  });

  it("校验自动运行设置并返回任务范围摘要", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ summary: "测试摘要", events: [], characters: [], settings: [], evidence: [], uncertainties: [] }) } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const { runtime, workId } = await setupWork(fetchMock);
    runtimes.push(runtime);

    const defaults = await request(runtime.app).get(`/api/works/${workId}/ai-settings`).expect(200);
    expect(defaults.body.data).toMatchObject({
      dailyTokenQuota: null,
      autoRunEnabled: false,
      autoRunConcurrency: 2,
      autoRunBatchLimit: 20,
      autoRunDailyTaskLimit: 0,
      autoRunFailureThreshold: 3,
      autoRunStabilityDelayMinutes: 2,
      autoRunPaused: false,
      autoRunPauseReason: "",
      autoRunResumeAt: null,
      autoRunConsecutiveFailures: 0,
      bookSummaryContextPercent: 50,
      contextCompactThreshold: 85,
      agentToolCallLimit: 20,
      agentToolCallLimitMaximum: 300,
      agentToolCallGlobalMultiplier: 3,
      alwaysIncludeSettingInfo: false,
      agentTools: ["story_index", "read_chapters", "grep", "search_story_entities", "read_character_sections", "search_drafts", "image", "calculate_time"]
    });

    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      autoRunConcurrency: 0
    }).expect(400);
    const lowQuota = await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      dailyTokenQuota: 9_999
    }).expect(200);
    expect(lowQuota.body.data.dailyTokenQuota).toBe(9_999);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      autoRunBatchLimit: 201
    }).expect(400);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      autoRunDailyTaskLimit: 10_001
    }).expect(400);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      autoRunFailureThreshold: 0
    }).expect(400);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      autoRunStabilityDelayMinutes: 0
    }).expect(400);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      autoRunStabilityDelayMinutes: 121
    }).expect(400);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      bookSummaryContextPercent: 91
    }).expect(400);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      contextCompactThreshold: 91
    }).expect(400);
    const tooManyToolCalls = await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      agentToolCallLimit: 301
    }).expect(400);
    expect(tooManyToolCalls.body.error).toMatchObject({
      code: "AGENT_TOOL_CALL_LIMIT_TOO_HIGH",
      message: "Agent 工具调用上限不能超过 300 次"
    });
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      agentToolCallLimit: 9
    }).expect(400);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      agentToolCallLimit: 0
    }).expect(400);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      agentToolCallGlobalMultiplier: 0
    }).expect(400);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      agentToolCallGlobalMultiplier: 7
    }).expect(400);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      alwaysIncludeSettingInfo: "true"
    }).expect(400);
    const updated = await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      dailyTokenQuota: 10_000,
      autoRunStabilityDelayMinutes: 1,
      bookSummaryContextPercent: 35,
      contextCompactThreshold: 90,
      agentToolCallLimit: 300,
      agentToolCallGlobalMultiplier: 4,
      alwaysIncludeSettingInfo: true
    }).expect(200);
    expect(updated.body.data.dailyTokenQuota).toBe(10_000);
    expect(updated.body.data.autoRunStabilityDelayMinutes).toBe(1);
    expect(updated.body.data.bookSummaryContextPercent).toBe(35);
    expect(updated.body.data.contextCompactThreshold).toBe(90);
    expect(updated.body.data.agentToolCallLimit).toBe(300);
    expect(updated.body.data.agentToolCallGlobalMultiplier).toBe(4);
    expect(updated.body.data.alwaysIncludeSettingInfo).toBe(true);

    const unlimited = await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      dailyTokenQuota: null
    }).expect(200);
    expect(unlimited.body.data.dailyTokenQuota).toBeNull();

    const minimumMultiplier = await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      agentToolCallGlobalMultiplier: 1
    }).expect(200);
    expect(minimumMultiplier.body.data.agentToolCallGlobalMultiplier).toBe(1);
    const maximumMultiplier = await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      agentToolCallGlobalMultiplier: 6
    }).expect(200);
    expect(maximumMultiplier.body.data.agentToolCallGlobalMultiplier).toBe(6);

    const tasks = await request(runtime.app).get(`/api/works/${workId}/tasks`).expect(200);
    expect(tasks.body.data.items.length).toBeGreaterThanOrEqual(5);
    const firstTask = await request(runtime.app).get(`/api/tasks/${tasks.body.data.items[0].id}`).expect(200);
    expect(firstTask.body.data).toEqual(expect.objectContaining({
      id: expect.stringMatching(/^task_/u),
      scopeSummary: expect.stringContaining("第一卷"),
      scopeDetails: expect.any(Array)
    }));

    const summaries = await request(runtime.app).get(`/api/works/${workId}/tasks?view=summary&page=1&limit=5`).expect(200);
    expect(summaries.body.data.items).toHaveLength(5);
    expect(summaries.body.data).toMatchObject({
      page: 1,
      limit: 5,
      total: tasks.body.data.total,
      stats: {
        total: tasks.body.data.total,
        pendingCount: tasks.body.data.total,
        runningCount: 0,
        runningProgress: 0
      }
    });
    expect(summaries.body.data.items[0]).toEqual(expect.objectContaining({
      id: expect.stringMatching(/^task_/u),
      scopeSummary: expect.stringContaining("第一卷")
    }));
    expect(summaries.body.data.items[0]).not.toHaveProperty("result");
    expect(summaries.body.data.items[0]).not.toHaveProperty("scopeDetails");
    expect(summaries.body.data.items[0]).not.toHaveProperty("scope");
    expect(summaries.body.data.items[0]).not.toHaveProperty("sourceVersions");
    expect(summaries.body.data.items[0]).not.toHaveProperty("failures");
    const defaultSummaryPage = await request(runtime.app).get(`/api/works/${workId}/tasks?view=summary`).expect(200);
    expect(defaultSummaryPage.body.data).toMatchObject({ page: 1, limit: 30, total: tasks.body.data.total });
    expect(defaultSummaryPage.body.data.items).toHaveLength(tasks.body.data.total);
    const detail = await request(runtime.app).get(`/api/tasks/${summaries.body.data.items[0].id}`).expect(200);
    expect(detail.body.data).toEqual(expect.objectContaining({
      result: expect.anything(),
      scopeDetails: expect.any(Array)
    }));
  });

  it("分析任务摘要默认分页且不返回详情字段", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const work = await request(runtime.app).post("/api/works").send({ title: "分页测试" }).expect(201);
    const workId = work.body.data.id;
    for (let index = 0; index < 55; index += 1) {
      runtime.store.createTask(workId, {
        taskType: "chapter-analysis",
        scope: { type: "book", additionalPrompt: `不可出现在摘要中的提示-${index}` }
      });
    }

    const firstPage = await request(runtime.app).get(`/api/works/${workId}/tasks`).expect(200);
    expect(firstPage.body.data).toMatchObject({
      page: 1,
      limit: 30,
      total: 55,
      hasMore: true,
      nextPage: 2,
      stats: { total: 55, pendingCount: 55, runningCount: 0, runningProgress: 0 }
    });
    expect(firstPage.body.data.items).toHaveLength(30);
    expect(JSON.stringify(firstPage.body.data)).not.toContain("不可出现在摘要中的提示");
    expect(firstPage.body.data.items[0]).not.toHaveProperty("scope");
    expect(firstPage.body.data.items[0]).not.toHaveProperty("result");
    expect(firstPage.body.data.items[0]).not.toHaveProperty("scopeDetails");
    expect(firstPage.body.data.items[0]).not.toHaveProperty("sourceVersions");
    expect(firstPage.body.data.items[0]).not.toHaveProperty("failures");

    const secondPage = await request(runtime.app).get(`/api/works/${workId}/tasks?page=2`).expect(200);
    expect(secondPage.body.data).toMatchObject({ page: 2, limit: 30, total: 55, hasMore: false, nextPage: null });
    expect(secondPage.body.data.items).toHaveLength(25);
  });

  it("正文持续编辑时重置稳定等待，并在停止编辑后才创建章节理解任务", async () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const work = runtime.store.createWork({ title: "章节分析稳定等待测试" });
    const volume = runtime.store.createVolume(String(work.id), { title: "第一卷" });
    const chapter = runtime.store.createChapter(String(work.id), {
      volumeId: String(volume.id),
      title: "第一章",
      content: "初始正文"
    });
    const workId = String(work.id);
    const chapterId = String(chapter.id);

    vi.useFakeTimers();
    try {
      runtime.store.saveChapter(chapterId, { content: "第一次编辑" });
      expect(runtime.store.countPendingTasks(workId)).toBe(0);
      await vi.advanceTimersByTimeAsync(119_999);
      expect(runtime.store.countPendingTasks(workId)).toBe(0);

      runtime.store.saveChapter(chapterId, { content: "第二次编辑" });
      await vi.advanceTimersByTimeAsync(119_999);
      expect(runtime.store.countPendingTasks(workId)).toBe(0);
      await vi.advanceTimersByTimeAsync(1);

      expect(runtime.store.countPendingTasks(workId)).toBe(1);
      const taskId = String(runtime.store.listTaskSummariesPage(workId, { page: 1, limit: 10, offset: 0 }).items[0]?.id);
      expect(runtime.store.getTask(taskId)).toMatchObject({
        taskType: "chapter-analysis",
        status: "pending",
        sourceVersions: { [chapterId]: 3 }
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["structure", "report-update", "future-analysis"])("不支持的任务类型 %s 明确失败且自动运行不重试", async (taskType) => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new Error("不支持的任务不应调用 AI 供应商");
    });
    const runtime = createTestRuntime(fetchMock);
    runtimes.push(runtime);
    const work = runtime.store.createWork({ title: "不支持的任务类型测试" });
    const task = runtime.store.createTask(String(work.id), {
      taskType,
      scope: { type: "book" }
    });

    await expect(runtime.ai.runTask(String(task.id), undefined, undefined, { autoRun: true })).rejects.toMatchObject({
      status: 400,
      code: "UNSUPPORTED_TASK_TYPE",
      message: `不支持的任务类型：${taskType}`
    });
    expect(runtime.store.getTask(String(task.id))).toMatchObject({
      status: "failed",
      progress: 100,
      attemptCount: 1,
      nextAttemptAt: null,
      failures: [{ message: `不支持的任务类型：${taskType}`, code: "UNSUPPORTED_TASK_TYPE" }]
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("以事务原子认领待执行任务并遵守运行上限", () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const work = runtime.store.createWork({ title: "原子认领测试" });
    const firstTask = runtime.store.createTask(String(work.id), {
      taskType: "chapter-analysis",
      scope: { type: "book" }
    });
    const secondTask = runtime.store.createTask(String(work.id), {
      taskType: "chapter-analysis",
      scope: { type: "book" }
    });

    expect(runtime.store.claimPendingTask(String(firstTask.id), 1)).toMatchObject({ status: "running", attemptCount: 1 });
    expect(runtime.store.claimPendingTask(String(firstTask.id), 1)).toBeNull();
    const nextAttemptAt = new Date(Date.now() + 60_000).toISOString();
    expect(runtime.store.rescheduleTask(String(firstTask.id), { message: "临时失败" }, nextAttemptAt)).toMatchObject({
      status: "pending",
      attemptCount: 1,
      nextAttemptAt
    });
    expect(runtime.store.claimPendingTask(String(firstTask.id), 1)).toBeNull();
    runtime.database.run("UPDATE analysis_tasks SET next_attempt_at = ? WHERE id = ?", new Date(Date.now() - 1_000).toISOString(), String(firstTask.id));
    expect(runtime.store.claimPendingTask(String(firstTask.id), 1)).toMatchObject({ status: "running", attemptCount: 2 });
    expect(runtime.store.claimPendingTask(String(secondTask.id), 1)).toBeNull();
    expect(runtime.store.getTask(String(secondTask.id)).status).toBe("pending");
  });

  it("连续失败达到阈值后持久化暂停状态", () => {
    const runtime = createTestRuntime();
    runtimes.push(runtime);
    const work = runtime.store.createWork({ title: "失败熔断测试" });
    const workId = String(work.id);
    runtime.store.updateWorkAiSettings(workId, {
      autoRunEnabled: true,
      autoRunFailureThreshold: 2
    });

    expect(runtime.store.recordAutoRunFailure(workId, "第一次失败")).toMatchObject({
      autoRunPaused: false,
      autoRunConsecutiveFailures: 1
    });
    expect(runtime.store.recordAutoRunFailure(workId, "第二次失败")).toMatchObject({
      autoRunPaused: true,
      autoRunConsecutiveFailures: 2,
      autoRunPauseReason: expect.stringContaining("第二次失败")
    });
    expect(runtime.store.clearAutoRunPause(workId)).toMatchObject({
      autoRunPaused: false,
      autoRunConsecutiveFailures: 0
    });
  });

  it("服务启动后恢复已开启作品的待执行队列", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            summary: "恢复执行摘要",
            events: [],
            characters: [],
            settings: [],
            evidence: [{ conclusion: "有据", quote: "原文" }],
            uncertainties: []
          })
        }
      }]
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const { runtime, workId, releaseGates, gatedFetch } = await setupWork(fetchMock);
    runtimes.push(runtime);
    runtime.ai.dispose();
    runtime.store.updateWorkAiSettings(workId, {
      autoRunEnabled: true,
      autoRunConcurrency: 2
    });

    const resumedAi = new AiManager(
      runtime.store,
      new CredentialVault("test-master-secret-with-at-least-32-characters"),
      gatedFetch
    );
    try {
      await waitFor(() => releaseGates.length >= 2);
      releaseGates.splice(0).forEach((release) => release());
      while (runtime.store.countPendingTasks(workId) > 0 || runtime.store.countRunningTasks(workId) > 0) {
        await waitFor(() => releaseGates.length > 0 || (runtime.store.countPendingTasks(workId) === 0 && runtime.store.countRunningTasks(workId) === 0));
        releaseGates.splice(0).forEach((release) => release());
      }
      expect(runtime.store.countPendingTasks(workId)).toBe(0);
    } finally {
      resumedAi.dispose();
    }
  });

  it("开启自动运行后遵守并发上限并持续清空队列", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            summary: "测试摘要",
            events: [],
            characters: [],
            settings: [],
            evidence: [{ conclusion: "有据", quote: "原文" }],
            uncertainties: []
          })
        }
      }]
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const { runtime, workId, releaseGates } = await setupWork(fetchMock);
    runtimes.push(runtime);

    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      autoRunEnabled: true,
      autoRunConcurrency: 2,
      autoRunBatchLimit: 3
    }).expect(200);

    await waitFor(() => releaseGates.length >= 2);
    expect(releaseGates.length).toBe(2);
    expect(runtime.store.countRunningTasks(workId)).toBe(2);

    releaseGates.splice(0).forEach((release) => release());
    while (runtime.store.countPendingTasks(workId) > 0 || runtime.store.countRunningTasks(workId) > 0) {
      await waitFor(() => releaseGates.length > 0 || (runtime.store.countPendingTasks(workId) === 0 && runtime.store.countRunningTasks(workId) === 0));
      releaseGates.splice(0).forEach((release) => release());
    }

    const tasks = await request(runtime.app).get(`/api/works/${workId}/tasks`).expect(200);
    const statuses = (tasks.body.data.items as Array<{ status: string }>).map((item) => item.status);
    expect(statuses.filter((status) => status === "review")).toHaveLength(5);
    expect(statuses.filter((status) => status === "pending")).toHaveLength(0);
  });

  it("作品进入回收站后中止运行任务并清理后续调度", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ summary: "不应写入", events: [], characters: [], settings: [], evidence: [], uncertainties: [] }) } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const { runtime, workId } = await setupWork(fetchMock);
    runtimes.push(runtime);

    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      autoRunEnabled: true,
      autoRunConcurrency: 1
    }).expect(200);
    await waitFor(() => runtime.store.countRunningTasks(workId) === 1);

    const aiInternals = runtime.ai as unknown as {
      autoRunStarting: Map<string, Set<string>>;
      autoRunTimers: Map<string, ReturnType<typeof setTimeout>>;
      relationshipIndexSyncTimers: Map<string, ReturnType<typeof setTimeout>>;
      scheduleRelationshipIndexSync: (targetWorkId: string) => void;
      taskControllers: Map<string, AbortController>;
    };
    const runningSignal = [...aiInternals.taskControllers.values()][0]?.signal;
    expect(runningSignal?.aborted).toBe(false);
    runtime.ai.scheduleAutoRun(workId, 25);
    aiInternals.scheduleRelationshipIndexSync(workId);
    expect(aiInternals.autoRunTimers.has(workId)).toBe(true);
    expect(aiInternals.relationshipIndexSyncTimers.has(workId)).toBe(true);

    await request(runtime.app).delete(`/api/works/${workId}`).send({ expectedVersionNo: 1 }).expect(204);
    await waitFor(() => aiInternals.taskControllers.size === 0);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(runningSignal?.aborted).toBe(true);
    expect(aiInternals.autoRunStarting.has(workId)).toBe(false);
    expect(aiInternals.autoRunTimers.has(workId)).toBe(false);
    expect(aiInternals.relationshipIndexSyncTimers.has(workId)).toBe(false);
    expect(runtime.database.all(
      "SELECT status, COUNT(*) AS count FROM analysis_tasks WHERE work_id = ? GROUP BY status ORDER BY status",
      workId
    )).toEqual([{ status: "expired", count: 5 }]);
    expect(fetchMock).not.toHaveBeenCalled();

    await request(runtime.app).post(`/api/recycle-bin/works/${workId}/restore`).send({ expectedVersionNo: 2 }).expect(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runtime.store.countPendingTasks(workId)).toBe(0);
    expect(runtime.store.countRunningTasks(workId)).toBe(0);
    expect(aiInternals.autoRunTimers.has(workId)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();

    const newTask = runtime.store.createTask(workId, { taskType: "book-analysis", scope: { type: "book" } });
    expect(aiInternals.autoRunTimers.has(workId)).toBe(true);
    runtime.ai.scheduleAutoRun(workId, 60_000);
    await request(runtime.app).delete(`/api/works/${workId}`).send({ expectedVersionNo: 3 }).expect(204);
    expect(runtime.store.getTask(String(newTask.id)).status).toBe("expired");
    expect(aiInternals.autoRunTimers.has(workId)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("自动任务连续失败后暂停剩余队列", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("invalid request", { status: 400 }));
    const { runtime, workId, releaseGates } = await setupWork(fetchMock);
    runtimes.push(runtime);

    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      autoRunEnabled: true,
      autoRunConcurrency: 2,
      autoRunFailureThreshold: 2
    }).expect(200);
    await waitFor(() => releaseGates.length >= 2);
    releaseGates.splice(0).forEach((release) => release());
    await waitFor(() => {
      releaseGates.splice(0).forEach((release) => release());
      return Boolean(runtime.store.getWorkAiSettings(workId).autoRunPaused);
    });
    while (runtime.store.countRunningTasks(workId) > 0) {
      releaseGates.splice(0).forEach((release) => release());
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(runtime.store.getWorkAiSettings(workId)).toMatchObject({
      autoRunEnabled: true,
      autoRunPaused: true,
      autoRunPauseReason: expect.stringContaining("AI 调用失败")
    });
    expect(runtime.store.countPendingTasks(workId)).toBeGreaterThan(0);
  });
});
