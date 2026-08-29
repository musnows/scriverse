import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AiWritePlanManager } from "../../src/ai-write-plans.js";
import { workModuleRequirements } from "../../src/user-auth.js";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime, seedChapter } from "../helpers.js";

describe("AI 可写工具与审批中心 API", () => {
  let runtime: Runtime;
  let manager: AiWritePlanManager;
  let workId: string;

  beforeEach(async () => {
    runtime = createTestRuntime();
    manager = new AiWritePlanManager({
      database: runtime.database,
      store: runtime.store,
      auth: runtime.auth,
      resolveAnalysisTask: (id, input) => runtime.ai.resolveTaskInput(id, input),
      startAnalysisTask: (id, input) => runtime.store.createTask(id, input)
    });
    runtime.ai.attachWritePlanManager(manager);
    const { work } = await seedChapter(runtime, "第一段。\n第二段。");
    workId = String(work.id);
  });

  afterEach(() => runtime.close());

  describe("工具开关接口的模块权限映射", () => {
    const fakeRequest = (path: string): never => ({ path }) as never;

    it("工具开关读取需要 AI 设置权限，修改需要其写权限", () => {
      expect(workModuleRequirements(fakeRequest(`/api/works/${workId}/ai/tools`), false)).toEqual({ read: ["ai-settings"] });
      expect(workModuleRequirements(fakeRequest(`/api/works/${workId}/ai/tools`), true)).toEqual({ write: ["ai-settings"] });
    });

    it("审批中心与提问接口按 AI 对话模块校验", () => {
      expect(workModuleRequirements(fakeRequest(`/api/works/${workId}/ai/write-plans`), false)).toEqual({ read: ["ai-chat"] });
      expect(workModuleRequirements(fakeRequest(`/api/works/${workId}/ai/write-plans/p1/confirm`), true)).toEqual({ write: ["ai-chat"] });
      expect(workModuleRequirements(fakeRequest(`/api/works/${workId}/ai/write-plans/p1/undo`), true)).toEqual({ write: ["ai-chat"] });
      expect(workModuleRequirements(fakeRequest(`/api/works/${workId}/ai/questions`), false)).toEqual({ read: ["ai-chat"] });
      expect(workModuleRequirements(fakeRequest(`/api/works/${workId}/ai/questions/q1/answer`), true)).toEqual({ write: ["ai-chat"] });
      expect(workModuleRequirements(fakeRequest(`/api/works/${workId}/ai/questions/q1/reject`), true)).toEqual({ write: ["ai-chat"] });
    });
  });

  it("工具开关默认全关，PUT 接口可以增量开启并持久化", async () => {
    const initial = await request(runtime.app).get(`/api/works/${workId}/ai/tools`).expect(200);
    for (const enabled of Object.values(initial.body.data.tools)) expect(enabled).toBe(false);
    expect(initial.body.data.maxOperations).toBe(5);

    const updated = await request(runtime.app).put(`/api/works/${workId}/ai/tools`)
      .send({ tools: { settings: true, annotations: true } })
      .expect(200);
    expect(updated.body.data.tools).toMatchObject({ settings: true, annotations: true });

    // 未知开关必须被拒绝。
    await request(runtime.app).put(`/api/works/${workId}/ai/tools`).send({ tools: { not_a_tool: true } }).expect(400);
    // 重启级别的重新读取：直接从数据库确认已持久化。
    expect(manager.getEnabledTools(workId).settings).toBe(true);
  });

  it("审批计划可以经由 HTTP 确认、拒绝重复确认并走撤销闭环", async () => {
    manager.updateToolSettings(workId, { settings: true }, null);
    const setting = await runtime.store.createSetting(workId, { title: "旧标题", category: "地点", content: "内容" });
    const plan = manager.createWritePlan({
      workId,
      conversationId: null,
      initiator: null,
      conversationOwnerUserId: null,
      aiSummary: "更新设定标题",
      operations: [{ opType: "update_entry", entityType: "setting", entityId: String(setting.id), input: { title: "新标题" } }]
    });

    const detail = await request(runtime.app).get(`/api/works/${workId}/ai/write-plans/${plan.id}`).expect(200);
    expect(detail.body.data.status).toBe("pending");
    expect(detail.body.data.operations[0].fields[0].before).toBe("旧标题");

    const confirmed = await request(runtime.app).post(`/api/works/${workId}/ai/write-plans/${plan.id}/confirm`).expect(200);
    expect(confirmed.body.data.status).toBe("executed");
    expect(confirmed.body.data.operations[0].result.versionNo).toBe(2);

    // 重复确认必须失败，且不产生第三个版本。
    const repeated = await request(runtime.app).post(`/api/works/${workId}/ai/write-plans/${plan.id}/confirm`);
    expect(repeated.status).toBe(409);
    expect(repeated.body.error.code).toBe("AI_PLAN_ALREADY_DECIDED");
    const versions = runtime.database.all<{ version_no: number }>(
      "SELECT version_no FROM entity_versions WHERE entity_type = 'setting' AND entity_id = ?",
      String(setting.id)
    );
    expect(versions).toHaveLength(2);

    // 撤销也要经过一次新的待确认审批。
    const undoCreated = await request(runtime.app).post(`/api/works/${workId}/ai/write-plans/${plan.id}/undo`).expect(201);
    expect(undoCreated.body.data.kind).toBe("undo");
    expect(undoCreated.body.data.status).toBe("pending");
    const undone = await request(runtime.app).post(`/api/works/${workId}/ai/write-plans/${undoCreated.body.data.id}/confirm`).expect(200);
    expect(undone.body.data.status).toBe("executed");
    expect((await runtime.store.getSetting(String(setting.id))).title).toBe("旧标题");

    // 列表接口返回最新状态。
    const list = await request(runtime.app).get(`/api/works/${workId}/ai/write-plans?limit=10`).expect(200);
    expect(list.body.data.plans).toHaveLength(2);
    expect(list.body.data.plans[0].kind).toBe("undo");

    // 非法状态过滤参数被拒绝。
    await request(runtime.app).get(`/api/works/${workId}/ai/write-plans?status=nonsense`).expect(400);
  });

  it("拒绝入口不会写入任何数据，提问接口支持回答与拒绝", async () => {
    manager.updateToolSettings(workId, { characters: true, ask_user_questions: true }, null);
    const plan = manager.createWritePlan({
      workId,
      conversationId: null,
      initiator: null,
      conversationOwnerUserId: null,
      aiSummary: "新建角色",
      operations: [{ opType: "create_entry", entityType: "character", input: { name: "路人甲" } }]
    });
    const rejected = await request(runtime.app).post(`/api/works/${workId}/ai/write-plans/${plan.id}/reject`).expect(200);
    expect(rejected.body.data.status).toBe("rejected");
    const count = runtime.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM characters WHERE work_id = ?", workId);
    expect(Number(count?.count ?? 0)).toBe(0);

    const question = manager.createQuestion({
      workId,
      conversationId: "conv-api",
      initiator: null,
      recipientUserId: null,
      question: "选哪个？",
      options: ["甲", "乙"]
    });
    const listed = await request(runtime.app).get(`/api/works/${workId}/ai/questions?conversationId=conv-api`).expect(200);
    expect(listed.body.data.questions[0].id).toBe(question.id);

    const missingAnswer = await request(runtime.app).post(`/api/works/${workId}/ai/questions/${question.id}/answer`).send({});
    expect(missingAnswer.status).toBe(400);
    await request(runtime.app).post(`/api/works/${workId}/ai/questions/${question.id}/answer`)
      .send({ customAnswer: "界".repeat(3001) })
      .expect(400);
    const bothAnswers = await request(runtime.app).post(`/api/works/${workId}/ai/questions/${question.id}/answer`)
      .send({ selectedOption: 0, customAnswer: "补充说明" })
      .expect(200);
    expect(bothAnswers.body.data).toMatchObject({
      selectedOption: 0,
      selectedOptionLabel: "甲",
      customAnswer: "补充说明",
      answerText: "甲\n补充信息：补充说明",
      isCustomAnswer: true
    });

    const customQuestion = manager.createQuestion({
      workId,
      conversationId: "conv-api",
      initiator: null,
      recipientUserId: null,
      question: "再选一次？",
      options: ["甲", "乙"]
    });
    const answered = await request(runtime.app).post(`/api/works/${workId}/ai/questions/${customQuestion.id}/answer`)
      .send({ customAnswer: "界".repeat(3000) })
      .expect(200);
    expect(answered.body.data.isCustomAnswer).toBe(true);
    expect(answered.body.data.answerText).toHaveLength(3000);

    // 二次回答与拒绝都已关闭的问题必须冲突。
    const again = await request(runtime.app).post(`/api/works/${workId}/ai/questions/${customQuestion.id}/reject`);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("AI_QUESTION_CLOSED");
  });
});
