import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime } from "../helpers.js";

async function configureModel(runtime: Runtime, workId: string): Promise<string> {
  const provider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
    name: "时间线测试模型",
    baseUrl: "https://timeline-ai.test/v1",
    apiKey: "sk-timeline-test",
    status: "enabled",
    concurrencyLimit: 4,
    rpmLimit: 1000
  }).expect(201);
  runtime.database.run("UPDATE providers SET connection_status = 'success' WHERE id = ?", provider.body.data.id);
  const model = await request(runtime.app).post(`/api/providers/${provider.body.data.id}/models`).send({
    displayName: "时间线模型",
    modelId: "timeline-model"
  }).expect(201);
  return model.body.data.id as string;
}

function completion(content: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

describe("时间线分片分析", () => {
  let runtime: Runtime | null = null;

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
  });

  it("并发抽取分片、校验证据与人物归属，并保守归并跨章重复事件", async () => {
    let firstChapterId = "";
    let secondChapterId = "";
    let foreignCharacterId = "";
    const extractionPrompts: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ content?: string }> };
      const prompt = body.messages?.map((message) => message.content ?? "").join("\n") ?? "";
      if (prompt.includes("小说时间线候选归并器")) {
        const candidateIds = [...new Set(prompt.match(/timeline-candidate-\d+/gu) ?? [])];
        return completion([{
          candidateIds,
          name: "北港大停电",
          description: "北港在同一场暴雨中断电。",
          eventType: "灾害",
          timeLabel: "时间待定",
          timeSort: 999,
          location: "北港",
          impactScope: "regional"
        }]);
      }
      extractionPrompts.push(prompt);
      if (prompt.includes("第一章唯一标记")) {
        return completion([{
          name: "北港大停电",
          description: "北港在暴雨中断电。",
          eventType: "灾害",
          timeLabel: "时间待定",
          timeSort: 7,
          location: "北港",
          impactScope: "regional",
          participantReferences: ["林舟", foreignCharacterId],
          chapterIds: ["伪造章节"],
          evidence: [{ chapterId: firstChapterId, chapterTitle: "伪造标题", quote: "北港在暴雨中突然断电。" }]
        }, {
          name: "不存在的加冕",
          description: "模型伪造事件。",
          eventType: "政治",
          timeLabel: "第七日",
          timeSort: 7,
          location: "王城",
          impactScope: "world",
          participantReferences: [foreignCharacterId],
          evidence: [{ chapterId: firstChapterId, chapterTitle: "第一章", quote: "正文中不存在的加冕引文" }]
        }]);
      }
      return completion([{
        name: "北港大停电",
        description: "停电波及港区。",
        eventType: "灾害",
        timeLabel: "时间待定",
        timeSort: null,
        location: "北港",
        impactScope: "regional",
        participantReferences: ["林舟"],
        evidence: [{ chapterId: secondChapterId, chapterTitle: "第二章", quote: "港区仍未恢复供电。" }]
      }]);
    });
    runtime = createTestRuntime(fetchMock);
    const foreignWork = runtime.store.createWork({ title: "异作品" });
    foreignCharacterId = String(runtime.store.createCharacter(String(foreignWork.id), { name: "异作品角色" }).id);
    const work = runtime.store.createWork({ title: "北港纪事" });
    const workId = String(work.id);
    const volume = runtime.store.createVolume(workId, { title: "第一卷" });
    const first = runtime.store.createChapter(workId, {
      volumeId: String(volume.id),
      title: "第一章唯一标记",
      content: `${"潮声拍岸。".repeat(1_300)}北港在暴雨中突然断电。林舟赶往灯塔。`
    });
    const second = runtime.store.createChapter(workId, {
      volumeId: String(volume.id),
      title: "第二章唯一标记",
      content: `${"雨水冲刷街道。".repeat(1_100)}港区仍未恢复供电。林舟检查备用电源。`
    });
    firstChapterId = String(first.id);
    secondChapterId = String(second.id);
    const currentCharacter = runtime.store.createCharacter(workId, { name: "林舟" });
    const modelId = await configureModel(runtime, workId);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "timeline-analysis",
      scope: { type: "book" },
      modelId
    }).expect(201);

    const completed = await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({}).expect(200);

    expect(completed.body.data).toMatchObject({ status: "review", progress: 100 });
    expect(completed.body.data.result).toMatchObject({
      candidateCount: 1,
      rawCandidateCount: 3,
      batchCount: 2,
      aggregationBatchCount: 1,
      coveredChapterCount: 2
    });
    expect(completed.body.data.result.callIds).toHaveLength(3);
    expect(completed.body.data.result.skipped).toEqual([
      expect.objectContaining({ name: "不存在的加冕", reason: "原文证据无效或不属于本次章节范围" })
    ]);
    expect(extractionPrompts).toHaveLength(2);
    expect(extractionPrompts.every((prompt) => prompt.length < 30_000)).toBe(true);
    expect(extractionPrompts.every((prompt) => !(prompt.includes("第一章唯一标记") && prompt.includes("第二章唯一标记")))).toBe(true);

    const events = runtime.store.listTimelineEvents(workId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      name: "北港大停电",
      status: "candidate",
      timeLabel: "时间待定",
      timeSort: null,
      chapterIds: [firstChapterId, secondChapterId],
      participantIds: [currentCharacter.id]
    });
    expect(events[0]?.participantIds).not.toContain(foreignCharacterId);
    expect(events[0]?.evidence).toEqual([
      { chapterId: firstChapterId, chapterTitle: "第一章唯一标记", quote: "北港在暴雨中突然断电。" },
      { chapterId: secondChapterId, chapterTitle: "第二章唯一标记", quote: "港区仍未恢复供电。" }
    ]);
  });

  it("以重叠片段覆盖超长单章边界，并精确合并重复引文", async () => {
    let chapterId = "";
    const boundaryQuote = "灯塔熄灭后，林舟在黑暗中拉响警报。";
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ content?: string }> };
      const prompt = body.messages?.map((message) => message.content ?? "").join("\n") ?? "";
      return completion(prompt.includes(boundaryQuote) ? [{
        name: "灯塔停摆",
        description: "灯塔熄灭并触发警报。",
        eventType: "事故",
        timeLabel: "时间待定",
        timeSort: null,
        location: "北港灯塔",
        impactScope: "regional",
        participantReferences: ["林舟"],
        evidence: [{ chapterId, chapterTitle: "超长章", quote: boundaryQuote }]
      }] : []);
    });
    runtime = createTestRuntime(fetchMock);
    const work = runtime.store.createWork({ title: "边界测试" });
    const workId = String(work.id);
    const volume = runtime.store.createVolume(workId, { title: "第一卷" });
    const chapter = runtime.store.createChapter(workId, {
      volumeId: String(volume.id),
      title: "超长章",
      content: `${"甲".repeat(9_400)}${boundaryQuote}${"乙".repeat(8_500)}`
    });
    chapterId = String(chapter.id);
    runtime.store.createCharacter(workId, { name: "林舟" });
    const modelId = await configureModel(runtime, workId);
    const task = runtime.store.createTask(workId, { taskType: "timeline-analysis", scope: { type: "book" }, modelId });

    const completed = await request(runtime.app).post(`/api/tasks/${task.id}/run`).send({}).expect(200);

    expect(completed.body.data.result).toMatchObject({ candidateCount: 1, rawCandidateCount: 2, batchCount: 2, aggregationBatchCount: 0 });
    expect(runtime.store.listTimelineEvents(workId)[0]?.evidence).toEqual([
      { chapterId, chapterTitle: "超长章", quote: boundaryQuote }
    ]);
  });

  it("任一正文分片双重失败时不写入候选、版本或审计记录", async () => {
    let firstChapterId = "";
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ content?: string }> };
      const prompt = body.messages?.map((message) => message.content ?? "").join("\n") ?? "";
      if (prompt.includes("故障第二章")) return new Response("upstream failed", { status: 500 });
      return completion([{
        name: "北港启航",
        description: "飞船离港。",
        eventType: "启程",
        timeLabel: "启航日",
        timeSort: 1,
        location: "北港",
        impactScope: "personal",
        evidence: [{ chapterId: firstChapterId, chapterTitle: "正常第一章", quote: "飞船驶离北港。" }]
      }]);
    });
    runtime = createTestRuntime(fetchMock);
    const work = runtime.store.createWork({ title: "失败回滚" });
    const workId = String(work.id);
    const volume = runtime.store.createVolume(workId, { title: "第一卷" });
    const first = runtime.store.createChapter(workId, {
      volumeId: String(volume.id),
      title: "正常第一章",
      content: `${"潮声。".repeat(1_600)}飞船驶离北港。`
    });
    runtime.store.createChapter(workId, {
      volumeId: String(volume.id),
      title: "故障第二章",
      content: `${"暴雨。".repeat(1_600)}港区关闭。`
    });
    firstChapterId = String(first.id);
    const modelId = await configureModel(runtime, workId);
    const task = runtime.store.createTask(workId, { taskType: "timeline-analysis", scope: { type: "book" }, modelId });

    const failed = await request(runtime.app).post(`/api/tasks/${task.id}/run`).send({}).expect(502);

    expect(failed.body.error.code).toBe("AI_BATCH_FAILED");
    expect(runtime.store.listTimelineEvents(workId)).toEqual([]);
    expect(runtime.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM entity_versions WHERE entity_type = 'timeline-event'")?.count).toBe(0);
    expect(runtime.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'timeline.created'")?.count).toBe(0);
  });

  it("来源章节在模型返回前变化时丢弃全部结果", async () => {
    let chapterId = "";
    let originalContent = "";
    let changed = false;
    const fetchMock = vi.fn<typeof fetch>(async () => {
      if (!changed) {
        changed = true;
        runtime?.store.saveChapter(chapterId, { content: `${originalContent}\n作者在分析期间修订正文。` });
      }
      return completion([{
        name: "过期事件",
        description: "不应落库。",
        eventType: "other",
        timeLabel: "时间待定",
        timeSort: null,
        location: "北港",
        impactScope: "personal",
        evidence: [{ chapterId, chapterTitle: "第一章", quote: "林舟抵达北港。" }]
      }]);
    });
    runtime = createTestRuntime(fetchMock);
    const work = runtime.store.createWork({ title: "来源版本测试" });
    const workId = String(work.id);
    const volume = runtime.store.createVolume(workId, { title: "第一卷" });
    originalContent = "林舟抵达北港。";
    const chapter = runtime.store.createChapter(workId, { volumeId: String(volume.id), title: "第一章", content: originalContent });
    chapterId = String(chapter.id);
    const modelId = await configureModel(runtime, workId);
    const task = runtime.store.createTask(workId, { taskType: "timeline-analysis", scope: { type: "book" }, modelId });

    const expired = await request(runtime.app).post(`/api/tasks/${task.id}/run`).send({}).expect(200);

    expect(expired.body.data.status).toBe("expired");
    expect(runtime.store.listTimelineEvents(workId)).toEqual([]);
  });

  it("任务在分片请求期间取消时不写入任何候选", async () => {
    let chapterId = "";
    let taskId = "";
    let cancelled = false;
    const fetchMock = vi.fn<typeof fetch>(async () => {
      if (!cancelled) {
        cancelled = true;
        runtime?.ai.cancelTask(taskId);
      }
      return completion([{
        name: "取消后的事件",
        description: "不应落库。",
        eventType: "other",
        timeLabel: "时间待定",
        timeSort: null,
        location: "北港",
        impactScope: "personal",
        evidence: [{ chapterId, chapterTitle: "第一章", quote: "林舟抵达北港。" }]
      }]);
    });
    runtime = createTestRuntime(fetchMock);
    const work = runtime.store.createWork({ title: "取消测试" });
    const workId = String(work.id);
    const volume = runtime.store.createVolume(workId, { title: "第一卷" });
    const chapter = runtime.store.createChapter(workId, { volumeId: String(volume.id), title: "第一章", content: "林舟抵达北港。" });
    chapterId = String(chapter.id);
    const modelId = await configureModel(runtime, workId);
    const task = runtime.store.createTask(workId, { taskType: "timeline-analysis", scope: { type: "book" }, modelId });
    taskId = String(task.id);

    const result = await request(runtime.app).post(`/api/tasks/${taskId}/run`).send({}).expect(200);

    expect(result.body.data.status).toBe("cancelled");
    expect(runtime.store.listTimelineEvents(workId)).toEqual([]);
  });

  it("最终批量写入任一候选失败时回滚同批事件、版本和审计", async () => {
    let chapterId = "";
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ content?: string }> };
      const prompt = body.messages?.map((message) => message.content ?? "").join("\n") ?? "";
      if (prompt.includes("小说时间线候选归并器")) {
        const candidateIds = [...new Set(prompt.match(/timeline-candidate-\d+/gu) ?? [])];
        return completion(candidateIds.map((candidateId, index) => ({
          candidateIds: [candidateId],
          name: index === 0 ? "第一次警报" : "第二次警报",
          description: "",
          eventType: "事故",
          timeLabel: "时间待定",
          timeSort: null,
          location: "北港",
          impactScope: "personal"
        })));
      }
      return completion([{
        name: "第一次警报",
        description: "第一次警报响起。",
        eventType: "事故",
        timeLabel: "时间待定",
        timeSort: null,
        location: "北港",
        impactScope: "personal",
        evidence: [{ chapterId, chapterTitle: "第一章", quote: "第一次警报响起。" }]
      }, {
        name: "第二次警报",
        description: "第二次警报响起。",
        eventType: "事故",
        timeLabel: "时间待定",
        timeSort: null,
        location: "北港",
        impactScope: "personal",
        evidence: [{ chapterId, chapterTitle: "第一章", quote: "第二次警报响起。" }]
      }]);
    });
    runtime = createTestRuntime(fetchMock);
    const work = runtime.store.createWork({ title: "事务测试" });
    const workId = String(work.id);
    const volume = runtime.store.createVolume(workId, { title: "第一卷" });
    const chapter = runtime.store.createChapter(workId, {
      volumeId: String(volume.id),
      title: "第一章",
      content: "第一次警报响起。守卫检查后，第二次警报响起。"
    });
    chapterId = String(chapter.id);
    const modelId = await configureModel(runtime, workId);
    const task = runtime.store.createTask(workId, { taskType: "timeline-analysis", scope: { type: "book" }, modelId });
    const createTimelineEvent = runtime.store.createTimelineEvent.bind(runtime.store);
    let writeCount = 0;
    vi.spyOn(runtime.store, "createTimelineEvent").mockImplementation((...args) => {
      writeCount += 1;
      if (writeCount === 2) throw new Error("simulated timeline write failure");
      return createTimelineEvent(...args);
    });

    await request(runtime.app).post(`/api/tasks/${task.id}/run`).send({}).expect(500);

    expect(runtime.store.listTimelineEvents(workId)).toEqual([]);
    expect(runtime.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM entity_versions WHERE entity_type = 'timeline-event'")?.count).toBe(0);
    expect(runtime.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'timeline.created'")?.count).toBe(0);
  });
});
