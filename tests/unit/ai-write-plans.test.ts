import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AiWritePlanManager,
  buildFieldDiffs,
  createAiWritePlanInputSchema,
  intersectWorkModulePermissions,
  lineDiff,
  normalizePlanOperations,
  planOperationRequirements,
  resolveAiWritePlanMaxOperations
} from "../../src/ai-write-plans.js";
import { AppError } from "../../src/errors.js";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime, seedChapter } from "../helpers.js";

describe("resolveAiWritePlanMaxOperations", () => {
  it("默认值为 5 且接受边界内的整数", () => {
    expect(resolveAiWritePlanMaxOperations(undefined)).toBe(5);
    expect(resolveAiWritePlanMaxOperations(null)).toBe(5);
    expect(resolveAiWritePlanMaxOperations("")).toBe(5);
    expect(resolveAiWritePlanMaxOperations("1")).toBe(1);
    expect(resolveAiWritePlanMaxOperations("20")).toBe(20);
    expect(resolveAiWritePlanMaxOperations("7")).toBe(7);
  });

  it("超出范围或非法值时抛出包含环境变量名的错误", () => {
    expect(() => resolveAiWritePlanMaxOperations("0")).toThrowError(/AI_WRITE_PLAN_MAX_OPERATIONS/);
    expect(() => resolveAiWritePlanMaxOperations("21")).toThrowError(/AI_WRITE_PLAN_MAX_OPERATIONS/);
    expect(() => resolveAiWritePlanMaxOperations("-3")).toThrowError(/AI_WRITE_PLAN_MAX_OPERATIONS/);
    expect(() => resolveAiWritePlanMaxOperations("abc")).toThrowError(/AI_WRITE_PLAN_MAX_OPERATIONS/);
    expect(() => resolveAiWritePlanMaxOperations("3.5")).toThrowError(/AI_WRITE_PLAN_MAX_OPERATIONS/);
  });
});

describe("lineDiff", () => {
  it("识别新增、删除与未变行", () => {
    const diff = lineDiff(["a", "b", "c"].join("\n"), ["a", "X", "c"].join("\n"));
    expect(diff.some((line) => line.kind === "del" && line.text === "b")).toBe(true);
    expect(diff.some((line) => line.kind === "add" && line.text === "X")).toBe(true);
    expect(diff.some((line) => line.kind === "same" && line.text === "c")).toBe(true);
  });

  it("纯新增场景只产出 add 行", () => {
    const diff = lineDiff("第一行", "第一行\n第二行");
    const added = diff.filter((line) => line.kind === "add").map((line) => line.text.split("\n")).flat();
    expect(added).toEqual(["第二行"]);
  });

  it("空文本到有内容全部为 add", () => {
    const diff = lineDiff("", "唯一行");
    expect(diff.every((line) => line.kind === "add")).toBe(true);
  });
});

describe("buildFieldDiffs", () => {
  it("输出字段标签与原始修改前值", () => {
    const items = buildFieldDiffs("character", { name: "林舟", isDead: false }, { name: "林舟", isDead: true });
    const nameItem = items.find((item) => item.key === "name")!;
    const deadItem = items.find((item) => item.key === "isDead")!;
    expect(nameItem.label).toBe("姓名");
    expect(nameItem.changed).toBe(false);
    expect(deadItem.changed).toBe(true);
    expect(deadItem.beforeRaw).toBe(false);
    expect(deadItem.after).toBe("是");
    expect(deadItem.before).toBe("否");
  });

  it("对象字段使用 JSON 文本参与行级 diff", () => {
    const before = { profile: { age: 18 } };
    const items = buildFieldDiffs("character", before, { profile: { age: 19 } });
    expect(items[0]?.changed).toBe(true);
    expect(items[0]?.lines.length).toBeGreaterThan(0);
  });
});

describe("intersectWorkModulePermissions", () => {
  it("写入需要双方都可写，读取取较低者", () => {
    const left = {
      settings: "write",
      characters: "write",
      prose: "read"
    } as never;
    const right = {
      settings: "read",
      characters: "write",
      prose: "write"
    } as never;
    const intersected = intersectWorkModulePermissions(left, right) as Record<string, string>;
    expect(intersected.settings).toBe("read");
    expect(intersected.characters).toBe("write");
    expect(intersected.prose).toBe("read");
  });
});

describe("normalizePlanOperations", () => {
  it("接受混合操作类型并按白名单校验输入", () => {
    const operations = normalizePlanOperations(
      [
        {
          opType: "create_entry",
          entityType: "setting",
          input: { title: "北港", category: "地点", content: "北方的重要港口。" }
        },
        {
          opType: "update_entry",
          entityType: "foreshadow",
          entityId: "fs_1",
          input: { status: "planted" }
        },
        { opType: "create_annotation", chapterId: "ch_1", kind: "todo", startLine: 2, endLine: 2, note: "补一段过渡" },
        { opType: "create_task", taskType: "structure" }
      ],
      5
    );
    expect(operations).toHaveLength(4);
    expect(operations[0]).toMatchObject({ opType: "create_entry", entityType: "setting" });
    expect(operations[2]).toMatchObject({ opType: "create_annotation", startLine: 2 });
  });

  it("拒绝未知字段与超过上限的操作数", () => {
    expect(() => normalizePlanOperations(
      [{ opType: "create_entry", entityType: "setting", input: { title: "t", locked: true } }],
      5
    )).toThrowError(AppError);
    const tooMany = Array.from({ length: 6 }, (_, index) => ({
      opType: "create_task",
      taskType: "structure",
      scope: { tag: index }
    }));
    expect(() => normalizePlanOperations(tooMany, 5)).toThrowError(AppError);
  });

  it("编辑操作必须至少提供一个字段，批注的结束行不能早于开始行", () => {
    expect(() => normalizePlanOperations(
      [{ opType: "update_entry", entityType: "setting", entityId: "s1", input: {} }],
      5
    )).toThrowError(/至少需要提供一个修改字段/u);
    expect(() => normalizePlanOperations(
      [{ opType: "create_annotation", chapterId: "c1", kind: "note", startLine: 5, endLine: 3, note: "x" }],
      5
    )).toThrowError(/结束行不能早于开始行/u);
  });

  it("章节大纲操作需要 chapterId，关系端点不能相同", () => {
    expect(() => normalizePlanOperations(
      [{ opType: "update_entry", entityType: "chapter-outline", input: { goal: "g" } }],
      5
    )).toThrowError(/缺少章节 ID/u);
    expect(() => normalizePlanOperations(
      [{
        opType: "create_entry",
        entityType: "relationship",
        input: { fromCharacterId: "a", toCharacterId: "a", category: "family" }
      }],
      5
    )).toThrowError(/不能指向自身/u);
  });

  it("计划入参 schema 要求非空简述", () => {
    expect(createAiWritePlanInputSchema.safeParse({ aiSummary: "", operations: [] }).success).toBe(false);
  });
});

describe("planOperationRequirements", () => {
  it("角色关联字段与时间线引用要求关联模块权限", () => {
    const [character] = normalizePlanOperations([{
      opType: "create_entry",
      entityType: "character",
      input: { name: "林舟", raceId: "race-1", organizationIds: ["org-1"] }
    }], 5);
    expect(planOperationRequirements(character!)).toMatchObject({
      writeModules: expect.arrayContaining(["characters", "races", "organizations"])
    });

    const [timeline] = normalizePlanOperations([{
      opType: "create_entry",
      entityType: "timeline-event",
      input: { name: "相遇", chapterIds: ["chapter-1"], participantIds: ["character-1"] }
    }], 5);
    expect(planOperationRequirements(timeline!)).toMatchObject({
      writeModules: expect.arrayContaining(["timeline", "prose", "characters"])
    });
  });
});

describe("AiWritePlanManager 工具开关与审批流水线", () => {
  let runtime: Runtime;
  let manager: AiWritePlanManager;

  beforeEach(() => {
    runtime = createTestRuntime();
    manager = new AiWritePlanManager({
      database: runtime.database,
      store: runtime.store,
      auth: runtime.auth,
      resolveAnalysisTask: (workId, input) => runtime.ai.resolveTaskInput(workId, input),
      startAnalysisTask: (workId, input) => runtime.store.createTask(workId, input)
    });
  });

  afterEach(() => runtime.close());

  function enableTools(workId: string, toolIds: string[]): void {
    manager.updateToolSettings(workId, Object.fromEntries(toolIds.map((toolId) => [toolId, true])) as never, null);
  }

  it("工具开关默认全关，创建计划前必须逐个开启", async () => {
    const work = await runtime.store.createWork({ title: "审批作品", author: "测试作者" });
    const workId = String(work.id);
    expect(manager.getEnabledTools(workId)).toEqual({
      settings: false,
      characters: false,
      races: false,
      organizations: false,
      timeline: false,
      relationships: false,
      outlines: false,
      annotations: false,
      analysis_tasks: false,
      ask_user_questions: false
    });
    expect(() => manager.createWritePlan({
      workId,
      conversationId: null,
      initiator: null,
      conversationOwnerUserId: null,
      aiSummary: "新增一处设定",
      operations: [{ opType: "create_entry", entityType: "setting", input: { title: "北港", category: "地点", content: "港口" } }]
    })).toThrowError(/世界设定/);
  });

  it("确认后原子执行：创建设定、拒绝重复确认并可撤销编辑", async () => {
    const { work } = await seedChapter(runtime, "第一段。\n第二段。");
    const workId = String(work.id);
    enableTools(workId, ["settings", "characters"]);

    // 编辑目标不存在时必须直接拒绝，不能生成一个注定失败的计划。
    expect(() => manager.createWritePlan({
      workId,
      conversationId: null,
      initiator: null,
      conversationOwnerUserId: null,
      aiSummary: "更新不存在的设定",
      operations: [{ opType: "update_entry", entityType: "setting", entityId: "no_such_setting", input: { title: "x" } }]
    })).toThrowError(/不存在/);

    const createdSetting = await runtime.store.createSetting(workId, {
      title: "旧标题",
      category: "势力",
      content: "原来的内容"
    });
    const settingId = String(createdSetting.id);
    const plan = manager.createWritePlan({
      workId,
      conversationId: null,
      initiator: null,
      conversationOwnerUserId: null,
      aiSummary: "把设定标题改成新标题",
      operations: [
        { opType: "update_entry", entityType: "setting", entityId: settingId, input: { title: "新标题" } },
        { opType: "create_entry", entityType: "setting", input: { title: "南礁", category: "地点", content: "南方岛屿" } }
      ]
    });
    expect(plan.status).toBe("pending");
    expect(plan.operations).toHaveLength(2);
    // 系统生成的 diff 必须来自当前数据库。
    expect(plan.operations[0]?.fields.find((field) => field.key === "title")).toMatchObject({
      before: "旧标题",
      after: "新标题",
      changed: true
    });
    expect(plan.operations[1]?.opTypeLabel).toBe("新增");

    const executed = await manager.confirmPlan(plan.id, workId, null);
    expect(executed.status).toBe("executed");
    expect(executed.operations.every((operation) => operation.result !== null)).toBe(true);
    expect(executed.operations[0]?.auditRecords).toEqual([
      expect.objectContaining({ action: "ai.plan_operation.update_entry", actor: expect.any(String) })
    ]);

    const stored = await runtime.store.getSetting(settingId);
    expect(stored.title).toBe("新标题");

    // 重复确认：不产生第二次执行，也不产生第二个版本。
    await expect(manager.confirmPlan(plan.id, workId, null)).rejects.toMatchObject({ code: "AI_PLAN_ALREADY_DECIDED" });
    const versions = runtime.database.all<{ version_no: number }>(
      "SELECT version_no FROM entity_versions WHERE entity_type = 'setting' AND entity_id = ?",
      settingId
    );
    const highestVersion = Math.max(...versions.map((row: { version_no: number }) => row.version_no));
    expect(highestVersion).toBe(2);

    // 撤销仍处于结果版本时可用；撤销本身也是一份待确认审批。
    expect(executed.undoAvailable).toBe(true);
    const undoPlan = manager.createUndoPlan(plan.id, workId, null);
    expect(undoPlan.kind).toBe("undo");
    const undone = await manager.confirmPlan(undoPlan.id, workId, null);
    expect(undone.status).toBe("executed");
    expect((await runtime.store.getSetting(settingId)).title).toBe("旧标题");
  });

  it("目标已被人工修改的计划会被标记为已失效并拒绝执行", async () => {
    const work = await runtime.store.createWork({ title: "失效作品", author: "测试作者" });
    const workId = String(work.id);
    enableTools(workId, ["settings"]);
    const setting = await runtime.store.createSetting(workId, { title: "待编辑", category: "地点", content: "内容" });
    const plan = manager.createWritePlan({
      workId,
      conversationId: null,
      initiator: null,
      conversationOwnerUserId: null,
      aiSummary: "修改设定标题",
      operations: [{ opType: "update_entry", entityType: "setting", entityId: String(setting.id), input: { title: "AI 改法" } }]
    });
    // 在确认之前人为改动同一目标：版本漂移必须导致失效。
    await runtime.store.updateSetting(String(setting.id), { title: "人工改法" }, "manual", null, "人工调整");
    await expect(manager.confirmPlan(plan.id, workId, null)).rejects.toMatchObject({ code: "AI_PLAN_INVALIDATED" });
    const after = manager.getPlanDetail(plan.id, workId, null);
    expect(after.status).toBe("invalidated");
    expect(after.invalidReason).toContain("已发生变化");
    expect((await runtime.store.getSetting(String(setting.id))).title).toBe("人工改法");
  });

  it("正文版本或关联对象变化会让批注计划失效", async () => {
    const { work, chapter } = await seedChapter(runtime, "第一段。\n第二段。");
    const workId = String(work.id);
    enableTools(workId, ["annotations"]);
    const plan = manager.createWritePlan({
      workId,
      conversationId: null,
      initiator: null,
      conversationOwnerUserId: null,
      aiSummary: "在第二行添加待办",
      operations: [{ opType: "create_annotation", chapterId: String(chapter.id), kind: "todo", startLine: 2, endLine: 2, note: "补充细节" }]
    });
    runtime.store.saveChapter(String(chapter.id), { content: "第一段已修改。\n第二段。" });
    await expect(manager.confirmPlan(plan.id, workId, null)).rejects.toMatchObject({ code: "AI_PLAN_INVALIDATED" });
    expect(runtime.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM chapter_annotations")?.count).toBe(0);
  });

  it("审批与提问只允许发起人或对话归属用户查看处理", async () => {
    const work = await runtime.store.createWork({ title: "隔离作品", author: "测试作者" });
    const workId = String(work.id);
    enableTools(workId, ["settings", "ask_user_questions"]);
    const plan = manager.createWritePlan({
      workId,
      conversationId: "conversation-private",
      initiator: null,
      conversationOwnerUserId: null,
      aiSummary: "新增私有设定",
      operations: [{ opType: "create_entry", entityType: "setting", input: { title: "私有", category: "地点", content: "内容" } }]
    });
    runtime.database.run(
      "UPDATE ai_write_plans SET initiator_user_id = 'user-a', conversation_owner_user_id = 'user-a' WHERE id = ?",
      plan.id
    );
    expect(() => manager.getPlanDetail(plan.id, workId, { userId: "user-b", role: "user" })).toThrowError(/不存在/u);
    expect(manager.listPlansForWork(workId, { userId: "user-b", role: "user" })).toEqual([]);

    const question = manager.createQuestion({
      workId,
      conversationId: "conversation-private",
      initiator: null,
      recipientUserId: null,
      question: "私有问题？",
      options: ["甲", "乙"]
    });
    runtime.database.run(
      "UPDATE ai_user_questions SET initiator_user_id = 'user-a', recipient_user_id = 'user-a' WHERE id = ?",
      question.id
    );
    expect(() => manager.getQuestion(question.id, workId, { userId: "user-b", role: "user" })).toThrowError(/不存在/u);
  });

  it("空对话跟随工具开关，已有消息后冻结可写工具快照", async () => {
    const work = await runtime.store.createWork({ title: "快照作品", author: "测试作者" });
    const workId = String(work.id);
    const conversation = runtime.store.createAiConversation(workId, "快照会话");
    const conversationId = String(conversation.id);
    expect(manager.getConversationTools(workId, conversationId).settings).toBe(false);
    enableTools(workId, ["settings"]);
    expect(manager.getConversationTools(workId, conversationId).settings).toBe(true);
    runtime.store.addAiConversationMessage(conversationId, { role: "user", content: "开始对话" });
    manager.updateToolSettings(workId, { settings: false }, null);
    expect(manager.getConversationTools(workId, conversationId).settings).toBe(true);
  });

  it("新建详情包含系统默认字段，分析任务固化默认范围", async () => {
    const work = await runtime.store.createWork({ title: "详情作品", author: "测试作者" });
    const workId = String(work.id);
    const provider = runtime.ai.createProvider({
      name: "审批默认模型",
      baseUrl: "https://approval-model.test/v1",
      apiKey: "sk-approval-model-test",
      status: "enabled"
    });
    runtime.database.run("UPDATE providers SET connection_status = 'success' WHERE id = ?", String(provider.id));
    const model = runtime.ai.createModel(String(provider.id), {
      displayName: "审批默认模型",
      modelId: "approval-default-model"
    });
    runtime.ai.setTaskDefault(workId, "book-analysis", String(model.id));
    enableTools(workId, ["characters", "analysis_tasks"]);
    const plan = manager.createWritePlan({
      workId,
      conversationId: null,
      initiator: null,
      conversationOwnerUserId: null,
      aiSummary: "新建角色并分析",
      operations: [
        { opType: "create_entry", entityType: "character", input: { name: "林舟" } },
        { opType: "create_task", taskType: "structure" }
      ]
    });
    expect(plan.operations[0]?.fields.map((field) => field.key)).toEqual(expect.arrayContaining(["name", "isDead", "aliases", "organizationIds"]));
    expect(plan.operations[1]?.task?.scopeSummary).toContain("全书");
    expect(plan.operations[1]?.task?.modelId).toBe(String(model.id));
  });

  it("拒绝操作走 rejected 分支且永不触发写入", async () => {
    const work = await runtime.store.createWork({ title: "拒绝作品", author: "测试作者" });
    const workId = String(work.id);
    enableTools(workId, ["characters"]);
    const plan = manager.createWritePlan({
      workId,
      conversationId: null,
      initiator: null,
      conversationOwnerUserId: null,
      aiSummary: "新建角色",
      operations: [{ opType: "create_entry", entityType: "character", input: { name: "路人甲" } }]
    });
    const rejected = manager.rejectPlan(plan.id, workId, null);
    expect(rejected.status).toBe("rejected");
    const count = runtime.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM characters WHERE work_id = ?", workId);
    expect(Number(count?.count ?? 0)).toBe(0);
  });

  it("跨作品的实体引用会被直接拒绝", async () => {
    const { work: workA } = await seedChapter(runtime);
    const workB = await runtime.store.createWork({ title: "另一部作品", author: "测试作者" });
    const settingInB = await runtime.store.createSetting(String(workB.id), { title: "别的作品设定", category: "地点", content: "x" });
    enableTools(String(workA.id), ["settings"]);
    expect(() => manager.createWritePlan({
      workId: String(workA.id),
      conversationId: null,
      initiator: null,
      conversationOwnerUserId: null,
      aiSummary: "试图跨作品编辑",
      operations: [{ opType: "update_entry", entityType: "setting", entityId: String(settingInB.id), input: { title: "篡改" } }]
    })).toThrowError(/跨作品/);
  });

  it("提问工具持久化问题、支持选项与自定义回答，并禁止二次回答", async () => {
    const work = await runtime.store.createWork({ title: "提问作品", author: "测试作者" });
    const workId = String(work.id);
    expect(() => manager.createQuestion({
      workId,
      conversationId: "conv-1",
      initiator: null,
      recipientUserId: null,
      question: "主角的名字？",
      options: ["林舟", "陈砚"]
    })).toThrowError(/用户提问/);

    enableTools(workId, ["ask_user_questions"]);
    const question = manager.createQuestion({
      workId,
      conversationId: "conv-1",
      initiator: null,
      recipientUserId: null,
      question: "主角的名字？",
      options: ["林舟", "陈砚"]
    });
    expect(question.options[0]).toMatchObject({ index: 0, label: "林舟", recommended: true });
    expect(question.status).toBe("pending");

    const answered = manager.answerQuestion(question.id, workId, null, { selectedOption: 1 });
    expect(answered).toMatchObject({ status: "answered", selectedOption: 1, answerText: "陈砚" });
    // answerQuestion 是同步方法：重复回答必须同步抛出且不产生副作用。
    expect(() => manager.answerQuestion(question.id, workId, null, { customAnswer: "再答一次" }))
      .toThrowError(/问题已被处理/u);

    const second = manager.createQuestion({
      workId,
      conversationId: "conv-1",
      initiator: null,
      recipientUserId: null,
      question: "用哪个名字？",
      options: ["第一个", "自定义"]
    });
    // 新提问会成为会话中唯一的待回答问题。
    expect(manager.latestPendingQuestion("conv-1")?.id).toBe(second.id);
    const custom = manager.answerQuestion(second.id, workId, null, { customAnswer: "沈青梧" });
    expect(custom.isCustomAnswer).toBe(true);
    expect(custom.answerText).toBe("沈青梧");
    expect(manager.latestPendingQuestion("conv-1")).toBeNull();

    const third = manager.createQuestion({
      workId,
      conversationId: "conv-1",
      initiator: null,
      recipientUserId: null,
      question: "采用哪个方向？",
      options: ["第一个", "第二个"]
    });
    const supplemented = manager.answerQuestion(third.id, workId, null, {
      selectedOption: 0,
      customAnswer: "但保留第二个方案的结尾"
    });
    expect(supplemented).toMatchObject({
      selectedOption: 0,
      selectedOptionLabel: "第一个",
      customAnswer: "但保留第二个方案的结尾",
      answerText: "第一个\n补充信息：但保留第二个方案的结尾",
      isCustomAnswer: true
    });
  });

  it("待回答问题阻止写计划且 continuation 只能认领一次", async () => {
    const work = await runtime.store.createWork({ title: "阻塞提问", author: "测试作者" });
    const workId = String(work.id);
    enableTools(workId, ["settings", "ask_user_questions"]);
    const question = manager.createQuestion({
      workId,
      conversationId: "conv-blocked",
      initiator: null,
      recipientUserId: null,
      question: "选择方案？",
      options: ["甲", "乙"],
      toolCallId: "tool-question-1"
    });
    manager.saveQuestionContinuation(question.id, {
      conversationId: "conv-blocked",
      workId,
      scope: { type: "none" },
      modelId: "model-1"
    });
    expect(() => manager.createWritePlan({
      workId,
      conversationId: "conv-blocked",
      initiator: null,
      conversationOwnerUserId: null,
      aiSummary: "不能提前写入",
      operations: [{ opType: "create_entry", entityType: "setting", input: { title: "未确认", category: "地点", content: "内容" } }]
    })).toThrowError(/待回答/u);
    manager.answerQuestion(question.id, workId, null, { selectedOption: 0, customAnswer: "补充采用冷色调" });
    expect(manager.claimQuestionContinuation(question.id, workId, null)).toMatchObject({
      conversationId: "conv-blocked",
      answerText: "甲\n补充信息：补充采用冷色调",
      selectedOptionLabel: "甲",
      customAnswer: "补充采用冷色调",
      toolCallId: "tool-question-1"
    });
    expect(manager.claimQuestionContinuation(question.id, workId, null)).toBeNull();
    manager.finishQuestionContinuation(question.id, { completed: true });
    expect(manager.getQuestion(question.id, workId, null).resumeState).toBe("completed");
  });
});
