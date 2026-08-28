import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime } from "../helpers.js";

describe("AI 对话上下文压缩", () => {
  let runtime: Runtime;
  let workId: string;
  let chapterId: string;
  let modelId: string;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(async () => {
    fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "compact-model" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }>; tools?: unknown[] };
      const joined = body.messages.map((message) => message.content).join("\n");
      if (joined.includes("结构化中文长期记忆")) {
        expect(body.tools).toBeUndefined();
        const sourceIds = [...joined.matchAll(/\[(message_[^\]]+)\]/gu)].map((match) => match[1]).filter(Boolean);
        return new Response(JSON.stringify({ choices: [{ message: { content: `<json>${JSON.stringify({
          authorGoals: [{ text: "继续确认飞船状态", sourceMessageIds: sourceIds.slice(0, 1) }],
          confirmedDecisions: [],
          storyFacts: [{ text: "飞船仍在北港附近", sourceMessageIds: sourceIds }],
          constraints: [{ text: "必须遵守跃迁冷却规则", sourceMessageIds: sourceIds.slice(0, 1) }],
          unresolvedQuestions: [],
          importantReferences: []
        })}</json>` } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "已结合压缩摘要和最近对话回答。" } }] }), { status: 200 });
    });
    runtime = createTestRuntime(fetchMock);
    const work = await request(runtime.app).post("/api/works").send({ title: "上下文压缩测试" }).expect(201);
    workId = work.body.data.id;
    const volume = await request(runtime.app).post(`/api/works/${workId}/volumes`).send({ title: "第一卷" }).expect(201);
    const chapter = await request(runtime.app).post(`/api/works/${workId}/chapters`).send({ volumeId: volume.body.data.id, title: "第一章", content: "飞船停靠在北港。" }).expect(201);
    chapterId = chapter.body.data.id;
    const provider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
      name: "压缩测试服务",
      baseUrl: "https://compact.test/v1",
      apiKey: "sk-compact-test",
      status: "enabled"
    }).expect(201);
    await request(runtime.app).post(`/api/providers/${provider.body.data.id}/test`).send({}).expect(200);
    const model = await request(runtime.app).post(`/api/providers/${provider.body.data.id}/models`).send({
      displayName: "压缩模型",
      modelId: "compact-model",
      contextWindow: 32_768
    }).expect(201);
    modelId = model.body.data.id;
    runtime.database.run("UPDATE models SET context_window = ?, preset_json = ? WHERE id = ?", 4_096, JSON.stringify({ max_tokens: 1_024 }), modelId);
    fetchMock.mockClear();
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ contextCompactThreshold: 50 }).expect(200);
  });

  afterEach(() => runtime.close());

  it("达到可配置阈值时可忽略本次提醒且下次仍会提醒", async () => {
    runtime.database.run("UPDATE models SET context_window = ? WHERE id = ?", 16_384, modelId);
    const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    const conversationId = conversation.body.data.id;
    const oldUser = `旧作者要求：${"必须遵守跃迁冷却规则。".repeat(180)}`;
    const oldAssistant = `旧助手回答：${"飞船仍在北港附近。".repeat(180)}`;
    const recentUser = "最近问题：当前燃料还剩多少？";
    const recentAssistant = "最近回答：燃料数据尚未在正文中明确。";
    for (const [role, content] of [["user", oldUser], ["assistant", oldAssistant], ["user", recentUser], ["assistant", recentAssistant]] as const) {
      await request(runtime.app).post(`/api/ai-conversations/${conversationId}/messages`).send({ role, content }).expect(201);
    }
    const requestBody = { modelId, scope: { type: "chapter", chapterId }, instruction: "继续回答燃料问题。" };

    const warned = await request(runtime.app).post(`/api/ai-conversations/${conversationId}/context/prepare`).send(requestBody).expect(200);
    const usage = warned.body.data.usage;
    expect(warned.body.data).toMatchObject({ action: "warn", usage: { compactThreshold: 50, compactRecommended: true, contextWarningPending: true } });
    expect(usage.conversationUsagePercent).toBeGreaterThanOrEqual(50);
    expect(usage.usagePercent).toBeLessThan(95);
    expect(usage.tokenDistribution).toEqual(expect.objectContaining({
      systemPromptTokens: expect.any(Number),
      functionTokens: expect.any(Number),
      skillsTokens: 0,
      contextTokens: expect.any(Number),
      outputTokens: expect.any(Number),
      leftTokens: expect.any(Number)
    }));
    expect(usage.tokenDistribution.systemPromptTokens + usage.tokenDistribution.functionTokens
      + usage.tokenDistribution.skillsTokens + usage.tokenDistribution.contextTokens
      + usage.tokenDistribution.outputTokens
      + usage.tokenDistribution.leftTokens).toBe(usage.contextWindow);
    expect(usage.tokenDistribution.outputTokens).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();

    const ignored = await request(runtime.app).post(`/api/ai-conversations/${conversationId}/context/prepare`).send({
      ...requestBody,
      ignoreContextWarning: true
    }).expect(200);
    expect(ignored.body.data).toMatchObject({
      action: "ready",
      reason: "warning_ignored",
      usage: { contextWarningPending: false }
    });
    expect(fetchMock).not.toHaveBeenCalled();

    const warnedAgain = await request(runtime.app).post(`/api/ai-conversations/${conversationId}/context/prepare`).send(requestBody).expect(200);
    expect(warnedAgain.body.data).toMatchObject({ action: "warn", usage: { contextWarningPending: true } });

    const compacted = await request(runtime.app).post(`/api/ai-conversations/${conversationId}/compact`).send({
      modelId,
      scope: requestBody.scope
    }).expect(200);
    expect(compacted.body.data).toMatchObject({ compactedMessageCount: 1, retainedMessageCount: 3, changed: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const reloaded = await request(runtime.app).get(`/api/ai-conversations/${conversationId}`).expect(200);
    expect(reloaded.body.data).toMatchObject({ compactedMessageCount: 1, hasCompactedSummary: true, contextWarningPending: false });

    const current = await request(runtime.app).post(`/api/ai-conversations/${conversationId}/messages`).send({ role: "user", content: requestBody.instruction }).expect(201);
    let actualMessages: Array<{ role: string; content: string }> = [];
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "compact-model" }] }), { status: 200 });
      const probeBody = JSON.parse(String(init?.body ?? "{}")) as { max_tokens?: number };
      if (probeBody.max_tokens === 10) return new Response(JSON.stringify({ choices: [{ message: { content: "连接成功" } }] }), { status: 200 });
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
      actualMessages = body.messages;
      return new Response(JSON.stringify({ choices: [{ message: { content: "已结合压缩摘要和最近对话回答。" } }] }), { status: 200 });
    });
    const streamed = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      ...requestBody,
      conversationId,
      currentMessageId: current.body.data.id,
      ignoreContextWarning: true
    }).expect(200);
    expect(streamed.text).toContain("已结合压缩摘要和最近对话回答。");
    const modelContext = actualMessages.map((message) => message.content).join("\n");
    expect(modelContext).toContain("较早对话的上下文压缩摘要");
    expect(modelContext).toContain("必须遵守跃迁冷却规则");
    expect(modelContext).toContain(recentUser);
    expect(modelContext).toContain(recentAssistant);
    expect(modelContext).not.toContain("旧作者要求");
    expect(modelContext.match(/继续回答燃料问题。/gu)).toHaveLength(1);
    expect(streamed.text).toMatch(/"messageId":"message_[^"]+"/u);
    const persistedConversation = await request(runtime.app).get(`/api/ai-conversations/${conversationId}`).expect(200);
    expect(persistedConversation.body.data.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "已结合压缩摘要和最近对话回答。"
    });

    const retryConversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    const retryPayload = { role: "assistant", content: "可恢复的回答", requestId: "assistant-retry-1" };
    const firstRetry = await request(runtime.app).post(`/api/ai-conversations/${retryConversation.body.data.id}/messages`).send(retryPayload).expect(201);
    const secondRetry = await request(runtime.app).post(`/api/ai-conversations/${retryConversation.body.data.id}/messages`).send(retryPayload).expect(201);
    expect(secondRetry.body.data.id).toBe(firstRetry.body.data.id);
  });

  it("模型最大输出达到 Compact 阈值时也会触发压缩", async () => {
    runtime.database.run("UPDATE models SET context_window = ?, preset_json = ? WHERE id = ?", 32_768, JSON.stringify({ max_tokens: 20_000 }), modelId);
    const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    const conversationId = conversation.body.data.id;
    for (const [role, content] of [
      ["user", `较早问题：${"飞船现在在哪里？".repeat(1_000)}`],
      ["assistant", `较早回答：${"飞船在北港。".repeat(1_000)}`],
      ["user", "最近问题：燃料还剩多少？"]
    ] as const) {
      await request(runtime.app).post(`/api/ai-conversations/${conversationId}/messages`).send({ role, content }).expect(201);
    }

    const prepared = await request(runtime.app).post(`/api/ai-conversations/${conversationId}/context/prepare`).send({
      modelId,
      scope: { type: "chapter", chapterId },
      instruction: "继续回答燃料问题。"
    }).expect(200);

    expect(prepared.body.data).toMatchObject({
      action: "compacted",
      reason: "forced_usage_threshold",
      usage: {
        maxOutputTokens: 20_000,
        maxOutputUsagePercent: 61,
        maxOutputThresholdReached: true
      }
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("流式提醒以 warningOnly 正常结束，忽略后只持久化一次并继续生成", async () => {
    runtime.database.run("UPDATE models SET context_window = ? WHERE id = ?", 16_384, modelId);
    const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    const conversationId = conversation.body.data.id;
    for (const [role, content] of [
      ["user", `旧作者要求：${"必须遵守跃迁冷却规则。".repeat(120)}`],
      ["assistant", `旧助手回答：${"飞船仍在北港附近。".repeat(120)}`],
      ["user", "最近问题：当前燃料还剩多少？"],
      ["assistant", "最近回答：燃料数据尚未在正文中明确。"]
    ] as const) {
      await request(runtime.app).post(`/api/ai-conversations/${conversationId}/messages`).send({ role, content }).expect(201);
    }
    const body = {
      modelId,
      scope: { type: "chapter", chapterId },
      instruction: "继续回答燃料问题。",
      conversationId
    };
    fetchMock.mockClear();

    const warned = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send(body).expect(200);
    expect(warned.text).toContain('event: context\ndata: {"action":"warn"');
    expect(warned.text).not.toContain("event: user_message");
    expect(warned.text).toContain('event: complete\ndata: {"warningOnly":true');
    expect(fetchMock).not.toHaveBeenCalled();
    const afterWarning = await request(runtime.app).get(`/api/ai-conversations/${conversationId}`).expect(200);
    expect(afterWarning.body.data).toMatchObject({ messageCount: 4, contextWarningPending: true });

    const continued = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      ...body,
      ignoreContextWarning: true
    }).expect(200);
    expect(continued.text).toContain('event: context\ndata: {"action":"ready","reason":"warning_ignored"');
    expect(continued.text).toContain("event: user_message");
    expect(continued.text).toContain("event: complete");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const afterCompletion = await request(runtime.app).get(`/api/ai-conversations/${conversationId}`).expect(200);
    expect(afterCompletion.body.data).toMatchObject({ messageCount: 6, compactedMessageCount: 0, contextWarningPending: false });
    expect(afterCompletion.body.data.messages.slice(-2)).toEqual([
      expect.objectContaining({ role: "user", content: body.instruction }),
      expect.objectContaining({ role: "assistant", content: "已结合压缩摘要和最近对话回答。" })
    ]);

    fetchMock.mockClear();
    const warnedAgain = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      ...body,
      instruction: "下一次仍应提醒。"
    }).expect(200);
    expect(warnedAgain.text).toContain('event: context\ndata: {"action":"warn"');
    expect(warnedAgain.text).toContain('event: complete\ndata: {"warningOnly":true');
    expect(warnedAgain.text).not.toContain("event: user_message");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("整次请求达到 95% 时先自动压缩再保存用户消息并调用 Agent", async () => {
    runtime.database.run("UPDATE models SET context_window = ? WHERE id = ?", 16_384, modelId);
    const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    const conversationId = conversation.body.data.id;
    for (const [role, content] of [
      ["user", `旧作者要求：${"必须遵守跃迁冷却规则。".repeat(600)}`],
      ["assistant", `旧助手回答：${"飞船仍在北港附近。".repeat(600)}`],
      ["user", "最近问题：当前燃料还剩多少？"],
      ["assistant", "最近回答：燃料数据尚未在正文中明确。"]
    ] as const) {
      await request(runtime.app).post(`/api/ai-conversations/${conversationId}/messages`).send({ role, content }).expect(201);
    }

    fetchMock.mockClear();
    const streamed = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      modelId,
      scope: { type: "chapter", chapterId },
      instruction: "继续回答燃料问题。",
      conversationId
    }).expect(200);

    expect(streamed.text).toContain('event: context\ndata: {"action":"compacted","reason":"forced_usage_threshold"');
    expect(streamed.text).not.toContain('"action":"warn"');
    expect(streamed.text.indexOf("event: context")).toBeLessThan(streamed.text.indexOf("event: user_message"));
    expect(streamed.text.indexOf("event: user_message")).toBeLessThan(streamed.text.indexOf("event: delta"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const reloaded = await request(runtime.app).get(`/api/ai-conversations/${conversationId}`).expect(200);
    expect(reloaded.body.data).toMatchObject({ messageCount: 6, compactedMessageCount: 2, hasCompactedSummary: true });
  });

  it("整窗超限但无可压缩历史时返回可理解错误且不保存消息", async () => {
    const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    const conversationId = conversation.body.data.id;
    fetchMock.mockClear();

    const failed = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      modelId,
      scope: { type: "chapter", chapterId },
      instruction: `超长问题：${"请检查当前章节。".repeat(4_000)}`,
      conversationId
    }).expect(409);

    expect(failed.body.error).toMatchObject({
      code: "AI_CONTEXT_COMPACTION_UNAVAILABLE",
      message: expect.stringContaining("没有可压缩的较早对话")
    });
    const reloaded = await request(runtime.app).get(`/api/ai-conversations/${conversationId}`).expect(200);
    expect(reloaded.body.data.messageCount).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("自动压缩后仍达到 95% 时停止请求且不重复保存本轮消息", async () => {
    const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    const conversationId = conversation.body.data.id;
    for (const [role, content] of [
      ["user", `旧作者要求：${"必须遵守跃迁冷却规则。".repeat(90)}`],
      ["assistant", `旧助手回答：${"飞船仍在北港附近。".repeat(90)}`],
      ["user", "最近问题：当前燃料还剩多少？"],
      ["assistant", "最近回答：燃料数据尚未在正文中明确。"]
    ] as const) {
      await request(runtime.app).post(`/api/ai-conversations/${conversationId}/messages`).send({ role, content }).expect(201);
    }
    fetchMock.mockClear();

    const failed = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      modelId,
      scope: { type: "chapter", chapterId },
      instruction: `仍然过长的问题：${"请检查当前章节。".repeat(4_000)}`,
      conversationId
    }).expect(413);

    expect(failed.body.error).toMatchObject({
      code: "AI_CONTEXT_STILL_OVER_LIMIT",
      message: expect.stringContaining("自动压缩后")
    });
    const reloaded = await request(runtime.app).get(`/api/ai-conversations/${conversationId}`).expect(200);
    expect(reloaded.body.data).toMatchObject({ messageCount: 4, hasCompactedSummary: true });
    expect(reloaded.body.data.compactedMessageCount).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("拒绝非布尔值的本次忽略字段", async () => {
    const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      modelId,
      scope: { type: "chapter", chapterId },
      instruction: "继续回答。",
      conversationId: conversation.body.data.id,
      ignoreContextWarning: "true"
    }).expect(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("手动整理较长对话时优先保留最近八条原始消息", async () => {
    const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    const conversationId = conversation.body.data.id;
    for (let index = 0; index < 12; index += 1) {
      await request(runtime.app).post(`/api/ai-conversations/${conversationId}/messages`).send({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `第 ${index + 1} 条对话，记录跃迁计划。`
      }).expect(201);
    }

    const compacted = await request(runtime.app).post(`/api/ai-conversations/${conversationId}/compact`).send({
      modelId,
      scope: { type: "chapter", chapterId }
    }).expect(200);

    expect(compacted.body.data).toMatchObject({ compactedMessageCount: 4, retainedMessageCount: 8, changed: true });
    expect(compacted.body.data.memoryItemCount).toBeGreaterThan(0);
  });

  it("上下文估算和压缩复用同一份未压缩尾部快照", async () => {
    const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    const conversationId = conversation.body.data.id;
    for (let index = 0; index < 12; index += 1) {
      await request(runtime.app).post(`/api/ai-conversations/${conversationId}/messages`).send({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `第 ${index + 1} 条对话，记录跃迁计划。`
      }).expect(201);
    }
    const contextSpy = vi.spyOn(runtime.store, "getAiConversationContext");

    const usage = runtime.ai.getContextUsage({
      workId,
      taskType: "chat",
      modelId,
      scope: { type: "chapter", chapterId },
      instruction: "继续整理跃迁计划。",
      conversationId
    });

    expect(usage).toMatchObject({ conversationTokens: expect.any(Number), compactedMessageCount: 0 });
    expect(Number(usage.conversationTokens)).toBeGreaterThan(0);
    expect(contextSpy).toHaveBeenCalledTimes(1);

    contextSpy.mockClear();
    const compacted = await runtime.ai.compactConversation({
      workId,
      modelId,
      scope: { type: "chapter", chapterId },
      conversationId
    });
    expect(compacted).toMatchObject({ compactedMessageCount: 4, retainedMessageCount: 8, changed: true });
    expect(contextSpy).toHaveBeenCalledTimes(1);
  });

  it("正文区块过长时降级正文并标记上下文兜底", async () => {
    runtime.database.run("UPDATE models SET context_window = ? WHERE id = ?", 16_384, modelId);
    runtime.store.saveChapter(chapterId, { content: `当前章节开头。${"非常长的章节正文。".repeat(2_000)}当前章节结尾。` });
    const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    const conversationId = conversation.body.data.id;
    for (const [role, content] of [["user", "问题一"], ["assistant", "回答一"], ["user", "问题二"], ["assistant", "回答二"]] as const) {
      await request(runtime.app).post(`/api/ai-conversations/${conversationId}/messages`).send({ role, content }).expect(201);
    }

    const prepared = await request(runtime.app).post(`/api/ai-conversations/${conversationId}/context/prepare`).send({
      modelId,
      scope: { type: "chapter", chapterId },
      instruction: "概括当前章节。"
    }).expect(200);
    const usage = prepared.body.data.usage;

    expect(prepared.body.data.action).toBe("ready");
    expect(usage.compactRecommended).toBe(true);
    expect(usage.contextFallbackReached).toBe(true);
    expect(usage.degradedContextBlocks).toBeGreaterThan(0);
    expect(usage.inputTokens).toBeLessThan(usage.contextWindow);
    expect(usage).toMatchObject({ conversationTokens: expect.any(Number), conversationBudgetTokens: expect.any(Number) });
  });

  it("上下文剩余不足 5k 时即使低于 95% 也会自动压缩", async () => {
    runtime.database.run("UPDATE models SET context_window = ? WHERE id = ?", 20_000, modelId);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ contextCompactThreshold: 90, agentTools: [] }).expect(200);
    const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    const conversationId = conversation.body.data.id;
    for (const [role, content] of [
      ["user", `较早要求：${"必须遵守跃迁冷却规则。".repeat(400)}`],
      ["assistant", "最近回答：飞船仍在北港附近。"],
      ["user", "最近问题：燃料还剩多少？"]
    ] as const) {
      await request(runtime.app).post(`/api/ai-conversations/${conversationId}/messages`).send({ role, content }).expect(201);
    }
    const instruction = "请检查当前章节。".repeat(1_080);
    const usageBefore = runtime.ai.getContextUsage({
      workId,
      taskType: "chat",
      modelId,
      scope: { type: "chapter", chapterId },
      instruction,
      conversationId
    });
    expect(usageBefore.outputReserveTokens).toBe(1_024);
    expect(usageBefore.remainingTokens).toBeLessThanOrEqual(5_000);
    expect(usageBefore).toMatchObject({ contextFallbackReached: true });
    expect(Number(usageBefore.usagePercent)).toBeLessThan(95);
    expect(Number(usageBefore.conversationUsagePercent)).toBeLessThan(90);

    const prepared = await request(runtime.app).post(`/api/ai-conversations/${conversationId}/context/prepare`).send({
      modelId,
      scope: { type: "chapter", chapterId },
      instruction
    }).expect(200);

    expect(prepared.body.data).toMatchObject({ action: "compacted", reason: "forced_usage_threshold" });
    expect(prepared.body.data.usage.contextFallbackReached).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("拒绝把其他作品的章节混入当前对话上下文", async () => {
    const otherWork = await request(runtime.app).post("/api/works").send({ title: "其他作品" }).expect(201);
    const conversation = await request(runtime.app).post(`/api/works/${otherWork.body.data.id}/ai-conversations`).send({}).expect(201);
    const response = await request(runtime.app).post(`/api/ai-conversations/${conversation.body.data.id}/context/prepare`).send({
      modelId,
      scope: { type: "chapter", chapterId },
      instruction: "越权读取"
    }).expect(400);
    expect(response.body.error.code).toBe("CHAPTER_WORK_MISMATCH");
  });
});
