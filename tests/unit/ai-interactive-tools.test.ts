import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AiWritePlanManager } from "../../src/ai-write-plans.js";
import { writePlanToolDefinition } from "../../src/ai.js";
import { createTestRuntime, seedChapter } from "../helpers.js";
import type { Runtime } from "../../src/app.js";

// AiManager 的工具执行入口是私有方法；测试通过结构化类型直接调用，
// 与生成管线的实际调用方式保持一致（conversationId 在管线中经由 chatContext 传入）。
type InteractiveToolExecutor = {
  executeAgentTool(
    workId: string,
    toolCall: { id: string; type: "function"; function: { name: string; arguments: unknown } },
    maximumResultChars?: number,
    roleplayCharacterId?: string | null,
    allowedToolIds?: ReadonlySet<string>,
    signal?: AbortSignal,
    onUsage?: (usage: unknown) => void,
    scope?: unknown,
    model?: unknown,
    provider?: unknown,
    chatContext?: { conversationId?: string | null }
  ): Promise<{ id: string; name: string; status: "completed" | "failed"; result: Record<string, unknown> }>;
};

describe("AI 可写交互工具（propose_write_plan / ask_user_question）", () => {
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

  function executor(): InteractiveToolExecutor {
    return runtime.ai as unknown as InteractiveToolExecutor;
  }

  it("写计划 schema 只暴露当前开启的模块与操作类型", () => {
    const tool = writePlanToolDefinition({
      settings: true,
      characters: false,
      races: false,
      organizations: false,
      timeline: false,
      relationships: false,
      outlines: false,
      annotations: true,
      analysis_tasks: false,
      ask_user_questions: false
    });
    const definition = JSON.stringify(tool);
    expect(definition).toContain('"setting"');
    expect(definition).toContain('"create_annotation"');
    expect(definition).not.toContain('"character"');
    expect(definition).not.toContain('"create_task"');

    const parameters = (tool.function as { parameters: Record<string, unknown> }).parameters;
    const properties = parameters.properties as Record<string, unknown>;
    const operations = properties.operations as { items: { oneOf: Array<Record<string, unknown>> } };
    const variants = operations.items.oneOf;
    const createSetting = variants.find((variant) => {
      const variantProperties = variant.properties as Record<string, { enum?: string[] }>;
      return variantProperties.opType?.enum?.[0] === "create_entry"
        && variantProperties.entityType?.enum?.[0] === "setting";
    });
    const updateSetting = variants.find((variant) => {
      const variantProperties = variant.properties as Record<string, { enum?: string[] }>;
      return variantProperties.opType?.enum?.[0] === "update_entry"
        && variantProperties.entityType?.enum?.[0] === "setting";
    });
    expect(createSetting).toBeDefined();
    expect(updateSetting).toBeDefined();
    expect(createSetting?.properties).not.toHaveProperty("entityId");
    expect(createSetting?.properties).not.toHaveProperty("scope");
    expect((createSetting?.properties as Record<string, unknown>).input).toMatchObject({
      required: ["title", "category", "content"],
      properties: {
        title: { type: "string" },
        category: { type: "string" },
        content: { type: "string" }
      },
      additionalProperties: false
    });
    expect(updateSetting?.required).toContain("entityId");
  });

  async function callTool(name: string, args: unknown, conversationId?: string) {
    return executor().executeAgentTool(
      workId,
      { id: `call_${name}`, type: "function", function: { name, arguments: args } },
      undefined,
      null,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { conversationId: conversationId ?? null }
    );
  }

  it("未开启任何写入开关时两个交互工具都不可用", async () => {
    const withoutConversation = await callTool("propose_write_plan", { aiSummary: "x", operations: [{ opType: "create_task", taskType: "structure" }] });
    expect(withoutConversation.status).toBe("failed");
    expect((withoutConversation.result.error as { code: string }).code).toBe("TOOL_CONVERSATION_REQUIRED");

    const conversation = await runtime.store.createAiConversation(workId, "会话");
    const gated = await callTool("ask_user_question", { question: "选哪个？", options: ["甲", "乙"] }, String(conversation.id));
    expect(gated.status).toBe("failed");
    expect((gated.result.error as { code: string }).code).toBe("TOOL_NOT_AVAILABLE");
  });

  it("开启开关后可以提交计划并创建提问，计划与提问都进入审批流", async () => {
    const conversation = await runtime.store.createAiConversation(workId, "侧边栏会话");
    const conversationId = String(conversation.id);
    manager.updateToolSettings(workId, { analysis_tasks: true, ask_user_questions: true }, null);

    const submitted = await callTool(
      "propose_write_plan",
      {
        aiSummary: "发起一次结构分析",
        operations: [{ opType: "create_task", taskType: "structure" }]
      },
      conversationId
    );
    expect(submitted.status).toBe("completed");
    expect(submitted.result.ok).toBe(true);
    const planRef = submitted.result.plan as { id: string; status: string };
    expect(planRef.status).toBe("pending");
    // 计划已经持久化，等待审批中心确认。
    expect(manager.getPlanDetail(planRef.id, workId, null).status).toBe("pending");

    const question = await callTool("ask_user_question", { questions: [
      { question: "分析用哪个视角？", options: ["全局", "单章"] },
      { question: "结果按什么顺序？", options: ["剧情顺序", "目录顺序"] }
    ] }, conversationId);
    expect(question.status).toBe("completed");
    expect(question.result.question).toMatchObject({ status: "pending", questionCount: 2 });
    expect(manager.latestPendingQuestion(conversationId)).toMatchObject({
      question: "分析用哪个视角？",
      questionCount: 2,
      questions: [{ question: "分析用哪个视角？" }, { question: "结果按什么顺序？" }]
    });
  });

  it("一次计划可以提交多个由系统生成 ID 的新建设定", async () => {
    const conversation = await runtime.store.createAiConversation(workId, "批量新建设定");
    const conversationId = String(conversation.id);
    manager.updateToolSettings(workId, { settings: true }, null);

    const submitted = await callTool(
      "propose_write_plan",
      {
        aiSummary: "新增观测者协议及三个关联设定",
        operations: ["观测者干扰协议", "熵增屏蔽层", "量子坍缩信标", "文明悖论"].map((title) => ({
          opType: "create_entry",
          entityType: "setting",
          input: { title, category: "技术与哲学", content: `${title}的正文。` }
        }))
      },
      conversationId
    );

    expect(submitted.status).toBe("completed");
    expect(submitted.result.ok).toBe(true);
    expect(submitted.result.plan).toMatchObject({ status: "pending", operationCount: 4 });
  });

  it("参数不合法的操作返回失败结果而不是抛出异常", async () => {
    const conversation = await runtime.store.createAiConversation(workId, "会话二");
    manager.updateToolSettings(workId, { settings: true }, null);
    const rejected = await callTool(
      "propose_write_plan",
      {
        aiSummary: "字段越权",
        operations: [{ opType: "create_entry", entityType: "setting", input: { title: "t", category: "c", content: "x", locked: true } }]
      },
      String(conversation.id)
    );
    expect(rejected.status).toBe("failed");
    expect(String(rejected.result.ok)).toBe("false");
  });
});
