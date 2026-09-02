import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";
import { runWithRequestActor, type RequestActor } from "../../src/request-context.js";

function actor(user: { userId: string; username: string; displayName: string; role: "admin" | "user" }): RequestActor {
  return { userId: user.userId, username: user.username, displayName: user.displayName, role: user.role, authentication: "session" };
}

function completion(content: string, stream: boolean): Response {
  if (stream) {
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    );
  }
  return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

async function waitForChain(runtime: Runtime, chainId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const chain = runtime.database.get("SELECT * FROM im_chains WHERE id = ?", chainId);
    if (chain && !["queued", "running"].includes(String(chain.status))) return chain;
    if (Date.now() >= deadline) throw new Error("IM chain did not finish in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function seedModels(runtime: Runtime): { primaryModelId: string; fallbackModelId: string } {
  const provider = runtime.ai.createProvider({
    name: "IM Provider",
    baseUrl: "https://example.test/v1",
    apiKey: "secret-key",
    status: "enabled"
  });
  runtime.database.run("UPDATE providers SET connection_status = 'success' WHERE id = ?", String(provider.id));
  const primary = runtime.ai.createModel(String(provider.id), { displayName: "Primary", modelId: "primary-model" });
  const fallback = runtime.ai.createModel(String(provider.id), { displayName: "Fallback", modelId: "fallback-model" });
  return { primaryModelId: String(primary.id), fallbackModelId: String(fallback.id) };
}

describe("IM AI 调度", () => {
  let runtime: Runtime;

  afterEach(async () => {
    await runtime?.close();
  });

  it("限制每用户实时连接并隔离异常 listener", async () => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-event-listener-limit-secret-with-enough-length",
      serveUi: false
    });
    const owner = runtime.auth.register({ username: "event_listener_owner", password: "secure-password-123" }).session.user;
    const member = runtime.auth.register({ username: "event_listener_member", password: "secure-password-123" }).session.user;
    const character = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "实时连接授权作品" });
      return runtime.store.createCharacter(String(work.id), { name: "实时连接角色" });
    });
    const group = runtime.im.createGroup(owner, {
      title: "实时连接授权群",
      characterIds: [String(character.id)],
      humanUserIds: [member.userId]
    });
    const secondGroup = runtime.im.createGroup(owner, {
      title: "实时连接保留群",
      characterIds: [String(character.id)],
      humanUserIds: [member.userId]
    });
    let healthyEvents = 0;
    const unsubscribes = [
      runtime.imOrchestrator.subscribe(owner.userId, () => { throw new Error("closed listener"); }),
      runtime.imOrchestrator.subscribe(owner.userId, () => { healthyEvents += 1; }),
      runtime.imOrchestrator.subscribe(owner.userId, () => undefined),
      runtime.imOrchestrator.subscribe(owner.userId, () => undefined),
      runtime.imOrchestrator.subscribe(owner.userId, () => undefined)
    ];
    expect(() => runtime.imOrchestrator.subscribe(owner.userId, () => undefined)).toThrowError("IM 实时连接过多");

    expect(() => runtime.imOrchestrator.publishConversationToUser(owner.userId, String(group.id))).not.toThrow();
    expect(healthyEvents).toBe(1);
    const replacement = runtime.imOrchestrator.subscribe(owner.userId, () => undefined);
    replacement();
    for (const unsubscribe of unsubscribes) unsubscribe();
    const afterRelease = runtime.imOrchestrator.subscribe(owner.userId, () => undefined);
    afterRelease();
    let expiredConnectionClosed = false;
    runtime.imOrchestrator.subscribe(
      owner.userId,
      () => undefined,
      () => { expiredConnectionClosed = true; },
      new Date(Date.now() + 10).toISOString()
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(expiredConnectionClosed).toBe(true);

    let memberEvents = 0;
    let memberDisconnected = false;
    runtime.imOrchestrator.subscribe(member.userId, () => { memberEvents += 1; }, () => { memberDisconnected = true; });
    runtime.imOrchestrator.publishConversation(String(group.id));
    runtime.imOrchestrator.publishConversation(String(secondGroup.id));
    memberEvents = 0;
    runtime.im.removeHuman(owner, String(group.id), member.userId);
    runtime.imOrchestrator.cancelConversation(String(group.id), "human_member_removed");
    runtime.imOrchestrator.publishConversation(String(secondGroup.id));
    expect(memberEvents).toBe(1);

    runtime.auth.updateUser(owner, member.userId, { status: "disabled" });
    runtime.imOrchestrator.disconnectUser(member.userId);
    runtime.imOrchestrator.publishConversation(String(secondGroup.id));
    expect(memberEvents).toBe(1);
    expect(memberDisconnected).toBe(true);
  });

  it("主模型重试耗尽后单次调用切换 fallback 并持久化完整回复", async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const bodies: Record<string, unknown>[] = [];
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-orchestrator-test-master-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        bodies.push(body);
        if (body.model === "primary-model") {
          primaryCalls += 1;
          return new Response("temporary failure", { status: 500 });
        }
        fallbackCalls += 1;
        return completion("已收到，立即启航。", body.stream === true);
      },
      aiRetrySleep: async () => undefined
    });
    const owner = runtime.auth.register({ username: "im_owner", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const { work, character } = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "远航纪事" });
      const character = runtime.store.createCharacter(String(work.id), {
        name: "林舟",
        attributes: { identity: "北港领航员" },
        profile: { summary: "谨慎而可靠" }
      });
      return { work, character };
    });
    runtime.im.updateSettings(owner.userId, {
      preferredName: "舰长",
      identitySummary: "远航队指挥官",
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 3
    });
    const direct = runtime.im.createDirect(owner, String(character.id));
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const unsubscribe = runtime.imOrchestrator.subscribe(owner.userId, (event) => events.push({ type: event.type, payload: event.payload }));
    const sent = runtime.im.sendMessage(owner, String(direct.id), {
      content: "准备出发。",
      requestId: "im-orchestrator-request-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    const chainId = String((sent.chain as Record<string, unknown>).id);
    const chain = await waitForChain(runtime, chainId);
    unsubscribe();

    expect(chain).toMatchObject({ status: "completed", model_stage: "fallback", generated_count: 1 });
    const sentEvent = events.find((event) => event.type === "message"
      && (event.payload.message as Record<string, unknown> | undefined)?.id === (sent.message as Record<string, unknown>).id);
    expect(sentEvent?.payload.chain).toEqual({
      id: (sent.chain as Record<string, unknown>).id,
      status: "queued"
    });
    expect(JSON.stringify(sentEvent?.payload)).not.toContain("primary_model_id");
    expect(JSON.stringify(sentEvent?.payload)).not.toContain("fallback_model_id");
    expect(primaryCalls).toBe(3);
    expect(fallbackCalls).toBe(1);
    const messages = runtime.database.all(
      "SELECT sender_kind, content, metadata_json FROM im_messages WHERE conversation_id = ? ORDER BY sequence",
      String(direct.id)
    );
    expect(messages.map((message) => ({ sender: message.sender_kind, content: message.content }))).toEqual([
      { sender: "human", content: "准备出发。" },
      { sender: "character", content: "已收到，立即启航。" }
    ]);
    expect(JSON.parse(String(messages[1]?.metadata_json))).toMatchObject({
      modelStage: "fallback",
      retryCount: 3,
      primaryAttemptCount: 3,
      fallbackAttemptCount: 1,
      attemptCount: 4
    });
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["chain", "turn", "reset", "delta", "message"]));
    expect(events.filter((event) => event.type === "turn" && event.payload.kind === "reply").map((event) => event.payload.status)).toEqual([
      "pending",
      "running",
      "completed"
    ]);
    expect(events.find((event) => event.type === "turn" && event.payload.status === "pending")?.payload).toMatchObject({
      characterId: character.id,
      character: { name: "林舟" }
    });
    expect((runtime.im.getConversation(String(direct.id), owner.userId).activeChain as Record<string, unknown>).turns).toEqual([
      expect.objectContaining({ characterId: character.id, status: "completed" })
    ]);
    const systemPrompt = bodies.find((body) => body.model === "fallback-model")?.messages as Array<{ role: string; content: string }>;
    expect(systemPrompt[0]?.content).toContain("<im_roleplay_rules>");
    expect(systemPrompt[0]?.content).toContain("舰长");
    expect(systemPrompt[0]?.content).toContain("北港领航员");
    expect(systemPrompt[0]?.content).toContain("mention://character/{角色ID}");
    expect(systemPrompt[0]?.content).toContain("mention://user/{用户ID}");
    expect(systemPrompt[0]?.content).toContain("被有效提及的 AI 角色会跳过“是否回答”判断并直接生成回答");
    expect(systemPrompt[0]?.content).not.toContain("remember_roleplay");
    expect(runtime.database.get(
      "SELECT created_by_user_id FROM ai_calls WHERE id = ?",
      JSON.parse(String(messages[1]?.metadata_json)).callId
    )).toEqual({ created_by_user_id: owner.userId });
    expect(String(work.id)).toBeTruthy();
  });

  it("链创建后主模型被删除时直接使用 fallback", async () => {
    let fallbackCalls = 0;
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-deleted-primary-fallback-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        if (body.model !== "fallback-model") throw new Error("deleted primary model must not be invoked");
        fallbackCalls += 1;
        return completion("主模型删除后由 fallback 回复。", body.stream === true);
      },
      aiRetrySleep: async () => undefined
    });
    const owner = runtime.auth.register({ username: "deleted_primary_owner", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const character = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "主模型删除来源" });
      return runtime.store.createCharacter(String(work.id), { name: "主模型删除角色" });
    });
    runtime.im.updateSettings(owner.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 2
    });
    const direct = runtime.im.createDirect(owner, String(character.id));
    const sent = runtime.im.sendMessage(owner, String(direct.id), {
      content: "删除主模型后继续。",
      requestId: "im-deleted-primary-fallback-0001"
    });
    runtime.database.run("DELETE FROM models WHERE id = ?", models.primaryModelId);
    runtime.imOrchestrator.publishMessageResult(sent);
    const chain = await waitForChain(runtime, String((sent.chain as Record<string, unknown>).id));

    expect(chain).toMatchObject({ status: "completed", model_stage: "fallback", generated_count: 1 });
    expect(fallbackCalls).toBe(1);
    const reply = runtime.database.get(
      "SELECT content, metadata_json FROM im_messages WHERE conversation_id = ? AND sender_kind = 'character'",
      String(direct.id)
    );
    expect(reply?.content).toBe("主模型删除后由 fallback 回复。");
    expect(JSON.parse(String(reply?.metadata_json))).toMatchObject({
      modelStage: "fallback",
      primaryAttemptCount: 0,
      fallbackAttemptCount: 1
    });
  });

  it("工具轮次共享一次角色调用的模型失败预算", async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-tool-round-retry-budget-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        if (body.model === "primary-model") {
          primaryCalls += 1;
          if (primaryCalls <= 2 || primaryCalls === 4) return new Response("temporary failure", { status: 500 });
          if (primaryCalls === 3) {
            return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{
              id: "im-date-calculation",
              type: "function",
              function: {
                name: "calculate_time",
                arguments: JSON.stringify({ startDate: "2026-09-01", endDate: "2026-09-02" })
              }
            }] }, finish_reason: "tool_calls" }] }), {
              status: 200,
              headers: { "Content-Type": "application/json" }
            });
          }
          throw new Error("primary model exceeded the shared failure budget");
        }
        fallbackCalls += 1;
        return completion("fallback 在累计第三次失败后接管。", body.stream === true);
      },
      aiRetrySleep: async () => undefined
    });
    const owner = runtime.auth.register({ username: "tool_round_retry_owner", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const character = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "工具轮次重试作品" });
      return runtime.store.createCharacter(String(work.id), { name: "工具轮次角色" });
    });
    runtime.im.updateSettings(owner.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 3
    });
    const direct = runtime.im.createDirect(owner, String(character.id));
    const sent = runtime.im.sendMessage(owner, String(direct.id), {
      content: "先计算日期，再回答。",
      requestId: "im-tool-round-retry-budget-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    const chain = await waitForChain(runtime, String((sent.chain as Record<string, unknown>).id));

    expect(chain).toMatchObject({ status: "completed", model_stage: "fallback", generated_count: 1 });
    expect(primaryCalls).toBe(4);
    expect(fallbackCalls).toBe(1);
    const reply = runtime.database.get(
      "SELECT content, metadata_json FROM im_messages WHERE conversation_id = ? AND sender_kind = 'character'",
      String(direct.id)
    );
    expect(reply?.content).toBe("fallback 在累计第三次失败后接管。");
    expect(JSON.parse(String(reply?.metadata_json))).toMatchObject({
      modelStage: "fallback",
      primaryAttemptCount: 4,
      fallbackAttemptCount: 1,
      attemptCount: 5
    });
  });

  it("IM 回复可以调用角色扮演记忆检索工具", async () => {
    let requestCount = 0;
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-roleplay-memory-tool-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async (_url, init) => {
        requestCount += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const messages = body.messages as Array<{ role: string; content: string }>;
        if (requestCount === 1) {
          expect((body.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name))
            .toContain("recall_roleplay_memory");
          return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{
            id: "im-recall-roleplay-memory",
            type: "function",
            function: { name: "recall_roleplay_memory", arguments: JSON.stringify({ query: "远航凭证" }) }
          }] }, finish_reason: "tool_calls" }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        const toolResult = messages.filter((message) => message.role === "tool").at(-1)?.content ?? "";
        expect(toolResult).not.toContain("TOOL_NOT_AVAILABLE");
        expect(toolResult).toContain("远航凭证");
        return completion("我记得那枚远航凭证。", body.stream === true);
      },
      aiRetrySleep: async () => undefined
    });
    const owner = runtime.auth.register({ username: "im_memory_tool_owner", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const character = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "IM 记忆工具作品" });
      const createdCharacter = runtime.store.createCharacter(String(work.id), { name: "IM 记忆工具角色" });
      for (let index = 1; index <= 13; index += 1) {
        runtime.store.createRoleplayMemory(String(createdCharacter.id), {
          category: "knowledge",
          content: index === 1 ? "我保管着一枚远航凭证。" : `普通共享记忆 ${index}`
        });
      }
      return createdCharacter;
    });
    runtime.im.updateSettings(owner.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 1
    });
    const direct = runtime.im.createDirect(owner, String(character.id));
    const sent = runtime.im.sendMessage(owner, String(direct.id), {
      content: "你还记得远航凭证吗？",
      requestId: "im-roleplay-memory-tool-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    const chain = await waitForChain(runtime, String((sent.chain as Record<string, unknown>).id));

    expect(chain).toMatchObject({ status: "completed", generated_count: 1 });
    expect(requestCount).toBe(2);
    expect(runtime.database.get(
      "SELECT content FROM im_messages WHERE chain_id = ? AND sender_kind = 'character'",
      String(chain.id)
    )).toEqual({ content: "我记得那枚远航凭证。" });
  });

  it("IM 记忆工具执行前重新检查发起人实时权限", async () => {
    const responseControl: { release?: () => void } = {};
    let markStarted: (() => void) | null = null;
    const requestStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const responseGate = new Promise<void>((resolve) => { responseControl.release = resolve; });
    let requestCount = 0;
    let toolResult = "";
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-memory-tool-permission-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async (_url, init) => {
        requestCount += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const messages = body.messages as Array<{ role: string; content: string }>;
        if (requestCount === 1) {
          markStarted?.();
          await responseGate;
          return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{
            id: "im-denied-roleplay-memory",
            type: "function",
            function: { name: "recall_roleplay_memory", arguments: JSON.stringify({ query: "权限密钥" }) }
          }] }, finish_reason: "tool_calls" }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        toolResult = messages.filter((message) => message.role === "tool").at(-1)?.content ?? "";
        return completion("权限变化后不应读取共享记忆。", body.stream === true);
      },
      aiRetrySleep: async () => undefined
    });
    const workOwner = runtime.auth.register({ username: "memory_tool_work_owner", password: "secure-password-123" }).session.user;
    const chatOwner = runtime.auth.register({ username: "memory_tool_chat_owner", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const { work, character } = runWithRequestActor(actor(workOwner), () => {
      const work = runtime.store.createWork({ title: "IM 工具撤权作品" });
      const character = runtime.store.createCharacter(String(work.id), { name: "IM 工具撤权角色" });
      runtime.store.createRoleplayMemory(String(character.id), { category: "knowledge", content: "权限密钥只能由有权用户读取。" });
      return { work, character };
    });
    runtime.auth.addMember(String(work.id), chatOwner.userId, { role: "editor" }, workOwner.userId);
    runtime.im.updateSettings(chatOwner.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 1
    });
    const direct = runtime.im.createDirect(chatOwner, String(character.id));
    const sent = runtime.im.sendMessage(chatOwner, String(direct.id), {
      content: "检索权限密钥。",
      requestId: "im-memory-tool-permission-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    await requestStarted;
    runtime.auth.updateMemberPermissions(String(work.id), chatOwner.userId, {
      permissions: {
        prose: "read", comments: "read", todos: "read", drafts: "read", settings: "read",
        characters: "none", races: "read", organizations: "read", timeline: "read", relationships: "read",
        outlines: "read", reviews: "read", "ai-chat": "none", "ai-analysis": "read", "ai-settings": "read"
      }
    });
    responseControl.release?.();
    const chain = await waitForChain(runtime, String((sent.chain as Record<string, unknown>).id));

    expect(chain).toMatchObject({ status: "failed", error_code: "IM_CHARACTER_ACCESS_DENIED", generated_count: 0 });
    expect(requestCount).toBe(1);
    expect(toolResult).toBe("");
  });

  it("角色权限在模型请求期间失效时不写入迟到回复", async () => {
    const responseControl: { release?: () => void } = {};
    let markStarted: (() => void) | null = null;
    const requestStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const responseGate = new Promise<void>((resolve) => { responseControl.release = resolve; });
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-mid-request-authorization-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async (_url, init) => {
        markStarted?.();
        await responseGate;
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return completion("这条迟到回复不能写入。", body.stream === true);
      },
      aiRetrySleep: async () => undefined
    });
    const workOwner = runtime.auth.register({ username: "mid_request_work_owner", password: "secure-password-123" }).session.user;
    const owner = runtime.auth.register({ username: "mid_request_auth_owner", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const { work, character } = runWithRequestActor(actor(workOwner), () => {
      const work = runtime.store.createWork({ title: "请求中失效作品" });
      return { work, character: runtime.store.createCharacter(String(work.id), { name: "请求中失效角色" }) };
    });
    runtime.auth.addMember(String(work.id), owner.userId, { role: "editor" }, workOwner.userId);
    runtime.im.updateSettings(owner.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 1
    });
    const direct = runtime.im.createDirect(owner, String(character.id));
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const unsubscribe = runtime.imOrchestrator.subscribe(owner.userId, (event) => {
      if (event.conversationId === direct.id) events.push({ type: event.type, payload: event.payload });
    });
    const sent = runtime.im.sendMessage(owner, String(direct.id), {
      content: "等待角色请求返回。",
      requestId: "im-mid-request-authorization-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    await requestStarted;
    runtime.auth.updateMemberPermissions(String(work.id), owner.userId, { role: "viewer" });
    responseControl.release?.();
    const chain = await waitForChain(runtime, String((sent.chain as Record<string, unknown>).id));
    unsubscribe();

    expect(chain).toMatchObject({ status: "failed", error_code: "IM_CHARACTER_ACCESS_DENIED", generated_count: 0 });
    expect(runtime.database.all(
      "SELECT sender_kind, content FROM im_messages WHERE conversation_id = ? ORDER BY sequence",
      String(direct.id)
    )).toEqual([{ sender_kind: "human", content: "等待角色请求返回。" }]);
    expect(events.filter((event) => event.type === "delta")).toEqual([]);
    expect(runtime.database.get(
      `SELECT status, model_id, model_stage, attempt_count, ai_call_ids_json
       FROM im_chain_turns WHERE chain_id = ? AND kind = 'reply'`,
      String((sent.chain as Record<string, unknown>).id)
    )).toEqual({
      status: "failed",
      model_id: models.primaryModelId,
      model_stage: "primary",
      attempt_count: 1,
      ai_call_ids_json: expect.not.stringMatching(/^\[\]$/u)
    });
  });

  it("使用私有资料的回复在发起人权限撤销后不写入群聊", async () => {
    const responseControl: { release?: () => void } = {};
    let markStarted: (() => void) | null = null;
    const requestStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const responseGate = new Promise<void>((resolve) => { responseControl.release = resolve; });
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-initiator-private-access-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async (_url, init) => {
        markStarted?.();
        await responseGate;
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return completion("这条回复使用了请求开始时的私有角色资料。", body.stream === true);
      },
      aiRetrySleep: async () => undefined
    });
    const workOwner = runtime.auth.register({ username: "private_reply_work_owner", password: "secure-password-123" }).session.user;
    const groupOwner = runtime.auth.register({ username: "private_reply_group_owner", password: "secure-password-123" }).session.user;
    const initiator = runtime.auth.register({ username: "private_reply_initiator", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const { work, character } = runWithRequestActor(actor(workOwner), () => {
      const work = runtime.store.createWork({ title: "发起人撤权作品" });
      return {
        work,
        character: runtime.store.createCharacter(String(work.id), {
          name: "发起人撤权角色",
          attributes: { privateSecret: "INITIATOR_PRIVATE_CHARACTER_DATA" }
        })
      };
    });
    runtime.auth.addMember(String(work.id), groupOwner.userId, { role: "editor" }, workOwner.userId);
    runtime.auth.addMember(String(work.id), initiator.userId, { role: "editor" }, workOwner.userId);
    runtime.im.updateSettings(initiator.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 1
    });
    const group = runtime.im.createGroup(groupOwner, {
      title: "发起人撤权群",
      characterIds: [String(character.id)],
      humanUserIds: [initiator.userId],
      replyMode: "mention",
      maxAiMessages: 1
    });
    const sent = runtime.im.sendMessage(initiator, String(group.id), {
      content: `mention://character/${character.id} 请使用角色资料回复。`,
      requestId: "im-initiator-private-access-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    await requestStarted;
    runtime.auth.updateMemberPermissions(String(work.id), initiator.userId, {
      permissions: {
        prose: "read", comments: "read", todos: "read", drafts: "read", settings: "read",
        characters: "none", races: "read", organizations: "read", timeline: "read", relationships: "read",
        outlines: "read", reviews: "read", "ai-chat": "none", "ai-analysis": "read", "ai-settings": "read"
      }
    });
    responseControl.release?.();
    const chainId = String((sent.chain as Record<string, unknown>).id);
    const chain = await waitForChain(runtime, chainId);

    expect(chain).toMatchObject({ status: "failed", error_code: "IM_CHARACTER_ACCESS_DENIED", generated_count: 0 });
    expect(runtime.database.get(
      "SELECT COUNT(*) AS count FROM im_messages WHERE chain_id = ? AND sender_kind = 'character'",
      chainId
    )).toEqual({ count: 0 });
    expect(runtime.database.get(
      "SELECT status FROM im_chain_turns WHERE chain_id = ? AND kind = 'reply'",
      chainId
    )).toEqual({ status: "failed" });
  });

  it("主模型等待期间撤权后不再向 fallback 发送私有上下文", async () => {
    const responseControl: { release?: () => void } = {};
    let markStarted: (() => void) | null = null;
    const requestStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const responseGate = new Promise<void>((resolve) => { responseControl.release = resolve; });
    let primaryCalls = 0;
    let fallbackCalls = 0;
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-fallback-permission-recheck-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        if (body.model === "primary-model") {
          primaryCalls += 1;
          markStarted?.();
          await responseGate;
          return new Response("primary failed after permission change", { status: 500 });
        }
        fallbackCalls += 1;
        return completion("fallback 不应收到私有上下文。", body.stream === true);
      },
      aiRetrySleep: async () => undefined
    });
    const workOwner = runtime.auth.register({ username: "fallback_access_work_owner", password: "secure-password-123" }).session.user;
    const groupOwner = runtime.auth.register({ username: "fallback_access_group_owner", password: "secure-password-123" }).session.user;
    const initiator = runtime.auth.register({ username: "fallback_access_initiator", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const { work, character } = runWithRequestActor(actor(workOwner), () => {
      const work = runtime.store.createWork({ title: "Fallback 撤权作品" });
      return {
        work,
        character: runtime.store.createCharacter(String(work.id), {
          name: "Fallback 撤权角色",
          attributes: { privateSecret: "FALLBACK_PRIVATE_CHARACTER_DATA" }
        })
      };
    });
    runtime.auth.addMember(String(work.id), groupOwner.userId, { role: "editor" }, workOwner.userId);
    runtime.auth.addMember(String(work.id), initiator.userId, { role: "editor" }, workOwner.userId);
    runtime.im.updateSettings(initiator.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 1
    });
    const group = runtime.im.createGroup(groupOwner, {
      title: "Fallback 撤权群",
      characterIds: [String(character.id)],
      humanUserIds: [initiator.userId],
      replyMode: "mention",
      maxAiMessages: 1
    });
    const sent = runtime.im.sendMessage(initiator, String(group.id), {
      content: `mention://character/${character.id} 请回复。`,
      requestId: "im-fallback-permission-recheck-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    await requestStarted;
    runtime.auth.updateMemberPermissions(String(work.id), initiator.userId, {
      permissions: {
        prose: "read", comments: "read", todos: "read", drafts: "read", settings: "read",
        characters: "none", races: "read", organizations: "read", timeline: "read", relationships: "read",
        outlines: "read", reviews: "read", "ai-chat": "none", "ai-analysis": "read", "ai-settings": "read"
      }
    });
    responseControl.release?.();
    const chain = await waitForChain(runtime, String((sent.chain as Record<string, unknown>).id));

    expect(chain).toMatchObject({ status: "failed", error_code: "IM_CHARACTER_ACCESS_DENIED", generated_count: 0 });
    expect(primaryCalls).toBe(1);
    expect(fallbackCalls).toBe(0);
  });

  it("撤销未被 IM 使用的模块权限不丢弃角色回复", async () => {
    const responseControl: { release?: () => void } = {};
    let markStarted: (() => void) | null = null;
    const requestStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const responseGate = new Promise<void>((resolve) => { responseControl.release = resolve; });
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-unrelated-permission-change-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async (_url, init) => {
        markStarted?.();
        await responseGate;
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return completion("无关权限变化不影响这条回复。", body.stream === true);
      },
      aiRetrySleep: async () => undefined
    });
    const workOwner = runtime.auth.register({ username: "unrelated_access_work_owner", password: "secure-password-123" }).session.user;
    const initiator = runtime.auth.register({ username: "unrelated_access_initiator", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const { work, character } = runWithRequestActor(actor(workOwner), () => {
      const work = runtime.store.createWork({ title: "无关权限变化作品" });
      return { work, character: runtime.store.createCharacter(String(work.id), { name: "无关权限变化角色" }) };
    });
    runtime.auth.addMember(String(work.id), initiator.userId, { role: "editor" }, workOwner.userId);
    runtime.im.updateSettings(initiator.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 1
    });
    const group = runtime.im.createGroup(workOwner, {
      title: "无关权限变化群",
      characterIds: [String(character.id)],
      humanUserIds: [initiator.userId],
      replyMode: "mention",
      maxAiMessages: 1
    });
    const sent = runtime.im.sendMessage(initiator, String(group.id), {
      content: `mention://character/${character.id} 请回复。`,
      requestId: "im-unrelated-permission-change-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    await requestStarted;
    runtime.auth.updateMemberPermissions(String(work.id), initiator.userId, {
      permissions: {
        prose: "write", comments: "write", todos: "write", drafts: "write", settings: "write",
        characters: "write", races: "write", organizations: "write", timeline: "write", relationships: "write",
        outlines: "write", reviews: "none", "ai-chat": "write", "ai-analysis": "write", "ai-settings": "write"
      }
    });
    responseControl.release?.();
    const chainId = String((sent.chain as Record<string, unknown>).id);
    const chain = await waitForChain(runtime, chainId);

    expect(chain).toMatchObject({ status: "limit", generated_count: 1 });
    expect(runtime.database.get(
      "SELECT content FROM im_messages WHERE chain_id = ? AND sender_kind = 'character'",
      chainId
    )).toEqual({ content: "无关权限变化不影响这条回复。" });
  });

  it("发起人停用后不再执行模型提出的角色工具", async () => {
    const responseControl: { release?: () => void } = {};
    let markStarted: (() => void) | null = null;
    const requestStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const responseGate = new Promise<void>((resolve) => { responseControl.release = resolve; });
    let requestCount = 0;
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-disabled-initiator-tool-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async () => {
        requestCount += 1;
        markStarted?.();
        await responseGate;
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{
          id: "im-disabled-recall-self",
          type: "function",
          function: { name: "recall_self", arguments: "{}" }
        }] }, finish_reason: "tool_calls" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      },
      aiRetrySleep: async () => undefined
    });
    const workOwner = runtime.auth.register({ username: "disabled_tool_work_owner", password: "secure-password-123" }).session.user;
    const initiator = runtime.auth.register({ username: "disabled_tool_initiator", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const { work, character } = runWithRequestActor(actor(workOwner), () => {
      const work = runtime.store.createWork({ title: "停用工具发起人作品" });
      return { work, character: runtime.store.createCharacter(String(work.id), { name: "停用工具发起人角色" }) };
    });
    runtime.auth.addMember(String(work.id), initiator.userId, { role: "editor" }, workOwner.userId);
    runtime.im.updateSettings(initiator.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 1
    });
    const group = runtime.im.createGroup(workOwner, {
      title: "停用工具发起人群",
      characterIds: [String(character.id)],
      humanUserIds: [initiator.userId],
      replyMode: "mention",
      maxAiMessages: 1
    });
    const sent = runtime.im.sendMessage(initiator, String(group.id), {
      content: `mention://character/${character.id} 请查询角色资料。`,
      requestId: "im-disabled-initiator-tool-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    await requestStarted;
    runtime.auth.updateUser(workOwner, initiator.userId, { status: "disabled" });
    responseControl.release?.();
    const chain = await waitForChain(runtime, String((sent.chain as Record<string, unknown>).id));

    expect(chain).toMatchObject({ status: "failed", error_code: "IM_INITIATOR_DISABLED", generated_count: 0 });
    expect(requestCount).toBe(1);
  });

  it("角色消息写入失败时原子回滚回复 turn 的完成状态", async () => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-atomic-reply-message-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return completion("这条角色消息会被测试触发器拒绝。", body.stream === true);
      },
      aiRetrySleep: async () => undefined
    });
    const owner = runtime.auth.register({ username: "atomic_reply_owner", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const character = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "回复原子写入作品" });
      return runtime.store.createCharacter(String(work.id), { name: "回复原子写入角色" });
    });
    runtime.im.updateSettings(owner.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 1
    });
    const direct = runtime.im.createDirect(owner, String(character.id));
    runtime.database.run(
      `CREATE TRIGGER fail_character_message_insert
       BEFORE INSERT ON im_messages WHEN NEW.sender_kind = 'character'
       BEGIN SELECT RAISE(ABORT, 'forced character message failure'); END;`
    );
    const sent = runtime.im.sendMessage(owner, String(direct.id), {
      content: "触发角色消息原子回滚。",
      requestId: "im-atomic-reply-message-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    const chainId = String((sent.chain as Record<string, unknown>).id);
    const chain = await waitForChain(runtime, chainId);

    expect(chain).toMatchObject({ status: "failed", generated_count: 0 });
    expect(runtime.database.get(
      "SELECT status FROM im_chain_turns WHERE chain_id = ? AND kind = 'reply'",
      chainId
    )).toEqual({ status: "failed" });
    expect(runtime.database.all(
      "SELECT sender_kind, content FROM im_messages WHERE conversation_id = ? ORDER BY sequence",
      String(direct.id)
    )).toEqual([{ sender_kind: "human", content: "触发角色消息原子回滚。" }]);
  });

  it("取消链后忽略不遵守 abort 的迟到模型结果", async () => {
    const responseControl: { release?: () => void } = {};
    let markStarted: (() => void) | null = null;
    const requestStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const responseGate = new Promise<void>((resolve) => { responseControl.release = resolve; });
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-late-cancel-result-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async (_url, init) => {
        markStarted?.();
        await responseGate;
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return completion("已取消链的迟到结果。", body.stream === true);
      },
      aiRetrySleep: async () => undefined
    });
    const owner = runtime.auth.register({ username: "late_cancel_owner", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const character = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "迟到取消作品" });
      return runtime.store.createCharacter(String(work.id), { name: "迟到取消角色" });
    });
    runtime.im.updateSettings(owner.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 1
    });
    const direct = runtime.im.createDirect(owner, String(character.id));
    const sent = runtime.im.sendMessage(owner, String(direct.id), {
      content: "开始后立即取消。",
      requestId: "im-late-cancel-result-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    await requestStarted;
    runtime.imOrchestrator.cancelConversation(String(direct.id), "manual_stop");
    responseControl.release?.();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(runtime.database.get("SELECT status FROM im_chains WHERE id = ?", String((sent.chain as Record<string, unknown>).id)))
      .toEqual({ status: "cancelled" });
    expect(runtime.database.get(
      "SELECT COUNT(*) AS count FROM im_messages WHERE conversation_id = ? AND sender_kind = 'character'",
      String(direct.id)
    )).toEqual({ count: 0 });
  });

  it("消息或重试写入回滚时不提前中止原活动链", () => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-atomic-replacement-secret-with-enough-length",
      serveUi: false
    });
    const owner = runtime.auth.register({ username: "atomic_replacement_owner", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const character = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "原子替换活动链作品" });
      return runtime.store.createCharacter(String(work.id), { name: "原子替换角色" });
    });
    runtime.im.updateSettings(owner.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 1
    });
    const direct = runtime.im.createDirect(owner, String(character.id));
    const first = runtime.im.sendMessage(owner, String(direct.id), {
      content: "保留第一条活动链。",
      requestId: "im-atomic-replacement-0001"
    });
    const firstChainId = String((first.chain as Record<string, unknown>).id);
    const originalAudit = runtime.store.audit.bind(runtime.store);
    let messageAbortCalled = false;
    runtime.store.audit = (_workId, action) => {
      if (action === "im.message-sent") throw new Error("forced IM message audit failure");
      originalAudit(_workId, action, "im-test", null);
    };
    try {
      expect(() => runtime.im.sendMessage(owner, String(direct.id), {
        content: "这条消息必须完整回滚。",
        requestId: "im-atomic-replacement-0002"
      }, () => { messageAbortCalled = true; })).toThrow(/forced IM message audit failure/u);
    } finally {
      runtime.store.audit = originalAudit;
    }
    expect(messageAbortCalled).toBe(false);
    expect(runtime.database.get("SELECT status FROM im_chains WHERE id = ?", firstChainId)).toEqual({ status: "queued" });
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM im_messages WHERE conversation_id = ?", String(direct.id)))
      .toEqual({ count: 1 });

    const second = runtime.im.sendMessage(owner, String(direct.id), {
      content: "建立第二条活动链。",
      requestId: "im-atomic-replacement-0003"
    });
    const secondChainId = String((second.chain as Record<string, unknown>).id);
    runtime.database.run(
      "UPDATE im_chains SET status = 'failed', completed_at = ?, updated_at = ? WHERE id = ?",
      "2026-09-03T00:00:00.000Z",
      "2026-09-03T00:00:00.000Z",
      firstChainId
    );
    let retryAbortCalled = false;
    runtime.store.audit = (_workId, action) => {
      if (action === "im.chain-retried") throw new Error("forced IM retry audit failure");
      originalAudit(_workId, action, "im-test", null);
    };
    try {
      expect(() => runtime.im.retryChain(owner, String(direct.id), firstChainId, () => { retryAbortCalled = true; }))
        .toThrow(/forced IM retry audit failure/u);
    } finally {
      runtime.store.audit = originalAudit;
    }
    expect(retryAbortCalled).toBe(false);
    expect(runtime.database.get("SELECT status FROM im_chains WHERE id = ?", secondChainId)).toEqual({ status: "queued" });
    expect(runtime.database.get(
      "SELECT COUNT(*) AS count FROM im_chains WHERE retry_source_chain_id = ?",
      firstChainId
    )).toEqual({ count: 0 });
  });

  it("同一毫秒创建的链按数据库插入顺序选择最新一条", () => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-chain-rowid-order-secret-with-enough-length",
      serveUi: false
    });
    const owner = runtime.auth.register({ username: "chain_rowid_owner", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const character = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "链顺序作品" });
      return runtime.store.createCharacter(String(work.id), { name: "链顺序角色" });
    });
    runtime.im.updateSettings(owner.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 1
    });
    const direct = runtime.im.createDirect(owner, String(character.id));
    const first = runtime.im.sendMessage(owner, String(direct.id), {
      content: "同毫秒第一条链。",
      requestId: "im-chain-rowid-order-0001"
    });
    const second = runtime.im.sendMessage(owner, String(direct.id), {
      content: "同毫秒第二条链。",
      requestId: "im-chain-rowid-order-0002"
    });
    const firstChainId = String((first.chain as Record<string, unknown>).id);
    const secondChainId = String((second.chain as Record<string, unknown>).id);
    runtime.database.run(
      "UPDATE im_chains SET created_at = ?, updated_at = ? WHERE id IN (?, ?)",
      "2026-09-03T00:00:00.000Z",
      "2026-09-03T00:00:00.000Z",
      firstChainId,
      secondChainId
    );

    expect(runtime.im.getConversation(String(direct.id), owner.userId)).toMatchObject({
      activeChain: { id: secondChainId }
    });
    expect(runtime.im.getDiagnostics(owner, String(direct.id))).toMatchObject({
      chain: { id: secondChainId }
    });
  });

  it("同一毫秒退出并重入时优先使用当前有效成员任期", () => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-membership-rowid-order-secret-with-enough-length",
      serveUi: false
    });
    const owner = runtime.auth.register({ username: "membership_rowid_owner", password: "secure-password-123" }).session.user;
    const member = runtime.auth.register({ username: "membership_rowid_member", password: "secure-password-123" }).session.user;
    const character = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "成员任期排序作品" });
      return runtime.store.createCharacter(String(work.id), { name: "成员任期排序角色" });
    });
    const group = runtime.im.createGroup(owner, {
      title: "成员任期排序群",
      characterIds: [String(character.id)],
      humanUserIds: [member.userId]
    });
    runtime.im.removeHuman(owner, String(group.id), member.userId);
    runtime.im.addHuman(owner, String(group.id), member.userId);
    const memberships = runtime.database.all(
      "SELECT id, left_at FROM im_human_memberships WHERE conversation_id = ? AND user_id = ? ORDER BY rowid",
      String(group.id),
      member.userId
    );
    const activeMembershipId = String(memberships.find((membership) => membership.left_at === null)?.id);
    runtime.database.run(
      "UPDATE im_human_memberships SET joined_sequence = 0, joined_at = ? WHERE conversation_id = ? AND user_id = ?",
      "2026-09-03T00:00:00.000Z",
      String(group.id),
      member.userId
    );

    const detail = runtime.im.getConversation(String(group.id), member.userId);
    expect(detail).toMatchObject({ active: true });
    expect((detail.participants as { humans: Array<{ userId: string; membershipId: string }> }).humans
      .find((human) => human.userId === member.userId)).toMatchObject({ membershipId: activeMembershipId });
    expect(runtime.im.listConversations(member.userId).find((conversation) => conversation.id === group.id))
      .toMatchObject({ active: true });
  });

  it("停止后不接受忽略 abort 的迟到主动判断结果", async () => {
    const responseControl: { release?: () => void } = {};
    let markStarted: (() => void) | null = null;
    const requestStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const responseGate = new Promise<void>((resolve) => { responseControl.release = resolve; });
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-late-judge-result-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async () => {
        markStarted?.();
        await responseGate;
        return completion('{"score":100}', false);
      },
      aiRetrySleep: async () => undefined
    });
    const owner = runtime.auth.register({ username: "late_judge_owner", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const character = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "迟到主动判断作品" });
      return runtime.store.createCharacter(String(work.id), { name: "迟到判断角色" });
    });
    runtime.im.updateSettings(owner.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 1
    });
    const group = runtime.im.createGroup(owner, {
      title: "迟到主动判断群",
      characterIds: [String(character.id)],
      replyMode: "proactive",
      responseThreshold: 0,
      maxAiMessages: 1
    });
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const unsubscribe = runtime.imOrchestrator.subscribe(owner.userId, (event) => events.push({ type: event.type, payload: event.payload }));
    const sent = runtime.im.sendMessage(owner, String(group.id), {
      content: "开始判断后立即停止。",
      requestId: "im-late-judge-result-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    await requestStarted;
    runtime.im.stopChain(owner.userId, String(group.id));
    runtime.imOrchestrator.cancelConversation(String(group.id), "stopped_by_user");
    responseControl.release?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
    unsubscribe();

    const chainId = String((sent.chain as Record<string, unknown>).id);
    expect(runtime.database.get("SELECT status FROM im_chains WHERE id = ?", chainId)).toEqual({ status: "cancelled" });
    expect(runtime.database.get(
      "SELECT status, score FROM im_chain_turns WHERE chain_id = ? AND kind = 'judge'",
      chainId
    )).toEqual({ status: "cancelled", score: null });
    expect(events.some((event) => event.type === "turn" && event.payload.kind === "judge" && event.payload.score === 100)).toBe(false);
  });

  it("停止后不写入忽略 abort 的迟到上下文压缩结果", async () => {
    const responseControl: { release?: () => void } = {};
    let markStarted: (() => void) | null = null;
    const requestStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const responseGate = new Promise<void>((resolve) => { responseControl.release = resolve; });
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-late-compaction-result-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async () => {
        markStarted?.();
        await responseGate;
        return completion("不应写入的迟到摘要。", false);
      },
      aiRetrySleep: async () => undefined
    });
    const owner = runtime.auth.register({ username: "late_compaction_owner", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const character = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "迟到压缩作品" });
      return runtime.store.createCharacter(String(work.id), { name: "迟到压缩角色" });
    });
    runtime.im.updateSettings(owner.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 1
    });
    const group = runtime.im.createGroup(owner, {
      title: "迟到压缩群",
      characterIds: [String(character.id)],
      replyMode: "proactive",
      responseThreshold: 0,
      maxAiMessages: 1
    });
    for (let index = 1; index <= 61; index += 1) {
      runtime.im.publishAnnouncement(owner, String(group.id), {
        content: `用于触发压缩的公告 ${index}`,
        requestId: `im-late-compaction-announcement-${index}`
      });
    }
    const sent = runtime.im.sendMessage(owner, String(group.id), {
      content: "开始压缩后立即停止。",
      requestId: "im-late-compaction-result-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    await requestStarted;
    runtime.im.stopChain(owner.userId, String(group.id));
    runtime.imOrchestrator.cancelConversation(String(group.id), "stopped_by_user");
    responseControl.release?.();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const chainId = String((sent.chain as Record<string, unknown>).id);
    expect(runtime.database.get("SELECT status FROM im_chains WHERE id = ?", chainId)).toEqual({ status: "cancelled" });
    expect(runtime.database.get(
      "SELECT status FROM im_chain_turns WHERE chain_id = ? AND kind = 'compact'",
      chainId
    )).toEqual({ status: "cancelled" });
    expect(runtime.database.get(
      "SELECT COUNT(*) AS count FROM im_character_contexts WHERE character_membership_id IN (SELECT id FROM im_character_memberships WHERE conversation_id = ?)",
      String(group.id)
    )).toEqual({ count: 0 });
  });

  it("角色授权在压缩期间失效时不写入迟到摘要", async () => {
    const responseControl: { release?: () => void } = {};
    let markStarted: (() => void) | null = null;
    const requestStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const responseGate = new Promise<void>((resolve) => { responseControl.release = resolve; });
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-mid-compaction-authorization-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async () => {
        markStarted?.();
        await responseGate;
        return completion("授权失效后不应写入的摘要。", false);
      },
      aiRetrySleep: async () => undefined
    });
    const workOwner = runtime.auth.register({ username: "compact_auth_work_owner", password: "secure-password-123" }).session.user;
    const chatOwner = runtime.auth.register({ username: "compact_auth_chat_owner", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const { work, character } = runWithRequestActor(actor(workOwner), () => {
      const work = runtime.store.createWork({ title: "压缩授权失效作品" });
      return { work, character: runtime.store.createCharacter(String(work.id), { name: "压缩授权失效角色" }) };
    });
    runtime.auth.addMember(String(work.id), chatOwner.userId, { role: "editor" }, workOwner.userId);
    runtime.im.updateSettings(chatOwner.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 1
    });
    const group = runtime.im.createGroup(chatOwner, {
      title: "压缩授权失效群",
      characterIds: [String(character.id)],
      replyMode: "proactive",
      responseThreshold: 0,
      maxAiMessages: 1
    });
    for (let index = 1; index <= 61; index += 1) {
      runtime.im.publishAnnouncement(chatOwner, String(group.id), {
        content: `压缩授权公告 ${index}`,
        requestId: `im-mid-compaction-authorization-announcement-${index}`
      });
    }
    const sent = runtime.im.sendMessage(chatOwner, String(group.id), {
      content: "等待压缩授权复核。",
      requestId: "im-mid-compaction-authorization-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    await requestStarted;
    runtime.auth.updateMemberPermissions(String(work.id), chatOwner.userId, { role: "viewer" });
    responseControl.release?.();
    const chainId = String((sent.chain as Record<string, unknown>).id);
    const chain = await waitForChain(runtime, chainId);

    expect(chain).toMatchObject({ status: "failed", error_code: "IM_CHARACTER_ACCESS_DENIED", generated_count: 0 });
    expect(runtime.database.get(
      "SELECT status FROM im_chain_turns WHERE chain_id = ? AND kind = 'compact'",
      chainId
    )).toEqual({ status: "failed" });
    expect(runtime.database.get(
      "SELECT COUNT(*) AS count FROM im_character_contexts WHERE character_membership_id IN (SELECT id FROM im_character_memberships WHERE conversation_id = ?)",
      String(group.id)
    )).toEqual({ count: 0 });
  });

  it("优雅关闭把运行链保留为可重试的中断状态", async () => {
    let markStarted: (() => void) | null = null;
    const requestStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-graceful-interruption-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async (_url, init) => {
        markStarted?.();
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) reject(signal.reason);
          else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      aiRetrySleep: async () => undefined
    });
    const owner = runtime.auth.register({ username: "graceful_interruption_owner", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const character = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "优雅关闭来源" });
      return runtime.store.createCharacter(String(work.id), { name: "优雅关闭角色" });
    });
    runtime.im.updateSettings(owner.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 1
    });
    const direct = runtime.im.createDirect(owner, String(character.id));
    const sent = runtime.im.sendMessage(owner, String(direct.id), {
      content: "等待服务关闭。",
      requestId: "im-graceful-interruption-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    await requestStarted;
    await runtime.imOrchestrator.dispose();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const chainId = String((sent.chain as Record<string, unknown>).id);
    expect(runtime.database.get("SELECT status, error_code FROM im_chains WHERE id = ?", chainId)).toEqual({
      status: "interrupted",
      error_code: "IM_CHAIN_RUNTIME_RESTARTED"
    });
    expect(() => runtime.im.retryChain(owner, String(direct.id), chainId)).not.toThrow();
  });

  it("主动判断请求在关闭时同样保留中断状态", async () => {
    const responseControl: { release?: () => void } = {};
    const responseGate = new Promise<void>((resolve) => { responseControl.release = resolve; });
    let requestCount = 0;
    let markStarted: (() => void) | null = null;
    const requestStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-judge-shutdown-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async (_url, init) => {
        requestCount += 1;
        if (requestCount === 2) markStarted?.();
        if (requestCount === 2) {
          await responseGate;
          return completion('{"score":100}', false);
        }
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) reject(new Error("transport aborted"));
          else signal?.addEventListener("abort", () => reject(new Error("transport aborted")), { once: true });
        });
      },
      aiRetrySleep: async () => undefined
    });
    const owner = runtime.auth.register({ username: "judge_shutdown_owner", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const characters = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "主动判断关闭来源" });
      return [
        runtime.store.createCharacter(String(work.id), { name: "关闭判断角色一" }),
        runtime.store.createCharacter(String(work.id), { name: "关闭判断角色二" })
      ];
    });
    runtime.im.updateSettings(owner.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 1
    });
    const group = runtime.im.createGroup(owner, {
      title: "主动判断关闭群",
      characterIds: characters.map((character) => String(character.id)),
      replyMode: "proactive"
    });
    const sent = runtime.im.sendMessage(owner, String(group.id), {
      content: "触发主动判断后关闭。",
      requestId: "im-judge-shutdown-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    await requestStarted;
    let disposalCompleted = false;
    const disposal = runtime.imOrchestrator.dispose().then(() => { disposalCompleted = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(disposalCompleted).toBe(false);
    responseControl.release?.();
    await disposal;

    expect(runtime.database.get("SELECT status, error_code FROM im_chains WHERE id = ?", String((sent.chain as Record<string, unknown>).id)))
      .toEqual({ status: "interrupted", error_code: "IM_CHAIN_RUNTIME_RESTARTED" });
    expect(runtime.database.all(
      "SELECT status FROM im_chain_turns WHERE chain_id = ? AND kind = 'judge' ORDER BY created_at, id",
      String((sent.chain as Record<string, unknown>).id)
    )).toEqual([{ status: "cancelled" }, { status: "cancelled" }]);
  });

  it("流式响应中断后按配置次数重试并只重置当前 turn", async () => {
    const encoder = new TextEncoder();
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const interrupted = (content: string): Response => {
      let emitted = false;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!emitted) {
            emitted = true;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`));
            return;
          }
          controller.error(new Error("stream interrupted"));
        }
      }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-partial-stream-retry-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        if (body.model === "primary-model") {
          primaryCalls += 1;
          return interrupted(`主模型残片${primaryCalls}`);
        }
        fallbackCalls += 1;
        return fallbackCalls < 3
          ? interrupted(`fallback 残片${fallbackCalls}`)
          : completion("fallback 完整回复。", true);
      },
      aiRetrySleep: async () => undefined
    });
    const owner = runtime.auth.register({ username: "partial_stream_retry_owner", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const character = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "流式重试来源" });
      return runtime.store.createCharacter(String(work.id), { name: "流式重试角色" });
    });
    runtime.im.updateSettings(owner.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 3
    });
    const direct = runtime.im.createDirect(owner, String(character.id));
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const unsubscribe = runtime.imOrchestrator.subscribe(owner.userId, (event) => events.push({ type: event.type, payload: event.payload }));
    const sent = runtime.im.sendMessage(owner, String(direct.id), {
      content: "测试流式中断重试。",
      requestId: "im-partial-stream-retry-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    const chain = await waitForChain(runtime, String((sent.chain as Record<string, unknown>).id));
    unsubscribe();

    expect(chain).toMatchObject({ status: "completed", model_stage: "fallback", generated_count: 1 });
    expect(primaryCalls).toBe(3);
    expect(fallbackCalls).toBe(3);
    const reply = runtime.database.get(
      "SELECT content, metadata_json FROM im_messages WHERE conversation_id = ? AND sender_kind = 'character'",
      String(direct.id)
    );
    expect(reply?.content).toBe("fallback 完整回复。");
    expect(JSON.parse(String(reply?.metadata_json))).toMatchObject({
      primaryAttemptCount: 3,
      fallbackAttemptCount: 3,
      attemptCount: 6
    });
    const resetEvents = events.filter((event) => event.type === "reset");
    expect(resetEvents).toHaveLength(5);
    expect(new Set(resetEvents.map((event) => event.payload.turnId))).toEqual(new Set([
      events.find((event) => event.type === "turn" && event.payload.kind === "reply")?.payload.turnId
    ]));
  });

  it("非 HTTP 可重试错误也遵守每个模型的失败次数", async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-invalid-json-retry-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        if (body.model === "primary-model") {
          primaryCalls += 1;
          return new Response("not-json", { status: 200, headers: { "Content-Type": "application/json" } });
        }
        fallbackCalls += 1;
        return completion("fallback 成功。", body.stream === true);
      },
      aiRetrySleep: async () => undefined
    });
    const owner = runtime.auth.register({ username: "invalid_json_retry_owner", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const character = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "无效 JSON 重试来源" });
      return runtime.store.createCharacter(String(work.id), { name: "重试角色" });
    });
    runtime.im.updateSettings(owner.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 5
    });
    const direct = runtime.im.createDirect(owner, String(character.id));
    const sent = runtime.im.sendMessage(owner, String(direct.id), {
      content: "测试重试次数。",
      requestId: "im-invalid-json-retry-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    const chain = await waitForChain(runtime, String((sent.chain as Record<string, unknown>).id));

    expect(chain).toMatchObject({ status: "completed", generated_count: 1 });
    expect(primaryCalls).toBe(5);
    expect(fallbackCalls).toBe(1);
  });

  it("fallback 失败时持久化真实模型阶段、尝试次数和调用记录", async () => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-fallback-diagnostics-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async () => new Response("upstream failed", { status: 500 }),
      aiRetrySleep: async () => undefined
    });
    const owner = runtime.auth.register({ username: "fallback_diagnostics_owner", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const character = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "失败诊断来源" });
      return runtime.store.createCharacter(String(work.id), { name: "失败诊断角色" });
    });
    runtime.im.updateSettings(owner.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 3
    });
    const direct = runtime.im.createDirect(owner, String(character.id));
    const sent = runtime.im.sendMessage(owner, String(direct.id), {
      content: "触发双模型失败。",
      requestId: "im-fallback-diagnostics-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    const chain = await waitForChain(runtime, String((sent.chain as Record<string, unknown>).id));

    expect(chain).toMatchObject({ status: "failed", model_stage: "fallback" });
    const turn = runtime.database.get(
      "SELECT status, model_id, model_stage, attempt_count, ai_call_ids_json FROM im_chain_turns WHERE chain_id = ? AND kind = 'reply'",
      String(chain.id)
    );
    expect(turn).toMatchObject({
      status: "failed",
      model_id: models.fallbackModelId,
      model_stage: "fallback",
      attempt_count: 6
    });
    expect(JSON.parse(String(turn?.ai_call_ids_json))).toHaveLength(2);
  });

  it("HTTP 403 和 404 也遵守主模型与 fallback 的配置失败次数", async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-http-permission-retry-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        if (body.model === "primary-model") {
          primaryCalls += 1;
          return new Response("forbidden", { status: 403 });
        }
        fallbackCalls += 1;
        return new Response("not found", { status: 404 });
      },
      aiRetrySleep: async () => undefined
    });
    const owner = runtime.auth.register({ username: "http_permission_retry_owner", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const character = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "HTTP 权限失败来源" });
      return runtime.store.createCharacter(String(work.id), { name: "HTTP 权限失败角色" });
    });
    runtime.im.updateSettings(owner.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 3
    });
    const direct = runtime.im.createDirect(owner, String(character.id));
    const sent = runtime.im.sendMessage(owner, String(direct.id), {
      content: "测试 403 和 404 重试。",
      requestId: "im-http-permission-retry-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    const chain = await waitForChain(runtime, String((sent.chain as Record<string, unknown>).id));

    expect(chain).toMatchObject({ status: "failed", model_stage: "fallback" });
    expect(primaryCalls).toBe(3);
    expect(fallbackCalls).toBe(3);
  });

  it("无效重试链不会执行取消当前链的回调", () => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-invalid-retry-chain-secret-with-enough-length",
      serveUi: false
    });
    const owner = runtime.auth.register({ username: "invalid_retry_chain_owner", password: "secure-password-123" }).session.user;
    const character = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "无效重试来源" });
      return runtime.store.createCharacter(String(work.id), { name: "重试目标" });
    });
    const direct = runtime.im.createDirect(owner, String(character.id));
    let cancellationCalled = false;

    expect(() => runtime.im.retryChain(owner, String(direct.id), "missing-chain", () => { cancellationCalled = true; })).toThrowError("IM 交流链不存在");
    expect(cancellationCalled).toBe(false);

    const waiting = runtime.im.sendMessage(owner, String(direct.id), {
      content: "等待模型配置",
      requestId: "im-retry-contract-waiting-0001"
    });
    const waitingChainId = String((waiting.chain as Record<string, unknown>).id);
    runtime.database.run("UPDATE im_chains SET status = 'completed' WHERE id = ?", waitingChainId);
    expect(() => runtime.im.retryChain(owner, String(direct.id), waitingChainId, () => { cancellationCalled = true; }))
      .toThrowError("只有失败、中断或等待模型配置的 IM 交流链可以重试");
    expect(cancellationCalled).toBe(false);

    runtime.database.run("UPDATE im_chains SET status = 'waiting_config' WHERE id = ?", waitingChainId);
    runtime.database.run("UPDATE im_conversations SET context_epoch = context_epoch + 1 WHERE id = ?", String(direct.id));
    expect(() => runtime.im.retryChain(owner, String(direct.id), waitingChainId, () => { cancellationCalled = true; }))
      .toThrowError("群成员或上下文已经变化，不能重试旧上下文中的交流链");
    expect(cancellationCalled).toBe(false);

    const idempotentCharacter = runWithRequestActor(actor(owner), () => runtime.store.createCharacter(String(character.workId), { name: "幂等重试角色" }));
    const idempotentDirect = runtime.im.createDirect(owner, String(idempotentCharacter.id));
    const idempotentSource = runtime.im.sendMessage(owner, String(idempotentDirect.id), {
      content: "等待幂等重试。",
      requestId: "im-idempotent-retry-source-0001"
    });
    const idempotentSourceChainId = String((idempotentSource.chain as Record<string, unknown>).id);
    let invalidMentionCancellationCalled = false;
    expect(() => runtime.im.sendMessage(owner, String(idempotentDirect.id), {
      content: Array.from({ length: 51 }, () => `mention://character/${idempotentCharacter.id}`).join(" "),
      requestId: "im-invalid-mention-limit-0001"
    }, () => { invalidMentionCancellationCalled = true; })).toThrowError("单条 IM 消息最多允许 50 个 mention");
    expect(invalidMentionCancellationCalled).toBe(false);
    expect(runtime.database.get("SELECT status FROM im_chains WHERE id = ?", idempotentSourceChainId)).toEqual({ status: "waiting_config" });
    let retryCancellationCount = 0;
    const firstRetry = runtime.im.retryChain(owner, String(idempotentDirect.id), idempotentSourceChainId, () => { retryCancellationCount += 1; });
    const duplicateRetry = runtime.im.retryChain(owner, String(idempotentDirect.id), idempotentSourceChainId, () => { retryCancellationCount += 1; });
    expect(duplicateRetry.id).toBe(firstRetry.id);
    expect(retryCancellationCount).toBe(1);
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM im_chains WHERE conversation_id = ?", String(idempotentDirect.id)))
      .toEqual({ count: 2 });

    const member = runtime.auth.register({ username: "retry_topology_member", password: "secure-password-123" }).session.user;
    const secondCharacter = runWithRequestActor(actor(owner), () => runtime.store.createCharacter(String(character.workId), { name: "拓扑变更角色" }));
    const group = runtime.im.createGroup(owner, {
      title: "重试拓扑群",
      characterIds: [String(character.id)],
      humanUserIds: [member.userId],
      replyMode: "proactive"
    });
    const topologyMessage = runtime.im.sendMessage(owner, String(group.id), {
      content: "拓扑变化前的消息",
      requestId: "im-retry-topology-0001"
    });
    const topologyChainId = String((topologyMessage.chain as Record<string, unknown>).id);
    runtime.database.run("UPDATE im_chains SET status = 'failed' WHERE id = ?", topologyChainId);
    let crossMemberCancellationCount = 0;
    const memberRetry = runtime.im.retryChain(member, String(group.id), topologyChainId, () => { crossMemberCancellationCount += 1; });
    const ownerDuplicateRetry = runtime.im.retryChain(owner, String(group.id), topologyChainId, () => { crossMemberCancellationCount += 1; });
    expect(ownerDuplicateRetry.id).toBe(memberRetry.id);
    expect(ownerDuplicateRetry).not.toHaveProperty("primary_model_id");
    expect(ownerDuplicateRetry).not.toHaveProperty("fallback_model_id");
    expect(ownerDuplicateRetry).not.toHaveProperty("retry_count");
    expect(ownerDuplicateRetry).not.toHaveProperty("initiator_user_id");
    expect(crossMemberCancellationCount).toBe(1);
    runtime.im.addCharacter(owner, String(group.id), String(secondCharacter.id));
    expect(runtime.database.get("SELECT context_epoch FROM im_conversations WHERE id = ?", String(group.id))).toEqual({ context_epoch: 2 });
    expect(() => runtime.im.retryChain(owner, String(group.id), topologyChainId))
      .toThrowError("群成员或上下文已经变化，不能重试旧上下文中的交流链");
    runtime.im.removeCharacter(owner, String(group.id), String(secondCharacter.id));
    expect(runtime.database.get("SELECT context_epoch FROM im_conversations WHERE id = ?", String(group.id))).toEqual({ context_epoch: 3 });
    runtime.im.leaveGroup(member, String(group.id));
    expect(runtime.database.get("SELECT context_epoch FROM im_conversations WHERE id = ?", String(group.id))).toEqual({ context_epoch: 4 });
  });

  it("会话没有可用 AI 角色时拒绝写入无回复消息", () => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-unavailable-character-secret-with-enough-length",
      serveUi: false
    });
    const owner = runtime.auth.register({ username: "unavailable_character_owner", password: "secure-password-123" }).session.user;
    const character = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "失效角色来源" });
      return runtime.store.createCharacter(String(work.id), { name: "失效角色" });
    });
    const direct = runtime.im.createDirect(owner, String(character.id));
    runtime.store.deleteCharacter(String(character.id));

    expect(() => runtime.im.sendMessage(owner, String(direct.id), {
      content: "这条消息不应写入。",
      requestId: "im-unavailable-character-message-0001"
    })).toThrowError("当前 IM 会话没有可用的 AI 角色");
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM im_messages WHERE conversation_id = ?", String(direct.id)))
      .toEqual({ count: 0 });

    runtime.store.restoreCharacter(String(character.id), 1);
    const restoredDirect = runtime.im.createDirect(owner, String(character.id));
    expect(restoredDirect.id).toBe(direct.id);
    expect(restoredDirect.participants).toMatchObject({
      characters: [expect.objectContaining({ characterId: character.id, status: "active" })]
    });
    expect(runtime.im.sendMessage(owner, String(direct.id), {
      content: "恢复后应重新使用既有单聊。",
      requestId: "im-restored-character-message-0001"
    }).message).toMatchObject({ content: "恢复后应重新使用既有单聊。" });
  });

  it("不触发 AI 的 mention 消息不保存悬空 chain id", () => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-message-without-chain-secret-with-enough-length",
      serveUi: false
    });
    const owner = runtime.auth.register({ username: "no_chain_owner", password: "secure-password-123" }).session.user;
    const member = runtime.auth.register({ username: "no_chain_member", password: "secure-password-123" }).session.user;
    const character = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "无链消息作品" });
      return runtime.store.createCharacter(String(work.id), { name: "无链消息角色" });
    });
    const group = runtime.im.createGroup(owner, {
      title: "无链消息群",
      characterIds: [String(character.id)],
      humanUserIds: [member.userId],
      replyMode: "mention"
    });
    const sent = runtime.im.sendMessage(owner, String(group.id), {
      content: `mention://user/${member.userId} 只通知人类成员。`,
      requestId: "im-message-without-chain-0001"
    });

    expect(sent.chain).toBeNull();
    expect(sent.message).toMatchObject({ chainId: null });
    expect(runtime.database.get(
      "SELECT chain_id FROM im_messages WHERE id = ?",
      String((sent.message as Record<string, unknown>).id)
    )).toEqual({ chain_id: null });
    expect(runtime.im.listConversations(owner.userId).find((conversation) => conversation.id === group.id))
      .toMatchObject({ unreadCount: 0 });
  });

  it("重复保存相同群设置不会取消活动链", () => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-noop-group-settings-secret-with-enough-length",
      serveUi: false
    });
    const owner = runtime.auth.register({ username: "noop_group_settings_owner", password: "secure-password-123" }).session.user;
    const character = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "重复群设置作品" });
      return runtime.store.createCharacter(String(work.id), { name: "重复群设置角色" });
    });
    const group = runtime.im.createGroup(owner, {
      title: "重复群设置群",
      characterIds: [String(character.id)],
      replyMode: "mention",
      responseThreshold: 60,
      maxAiMessages: 20
    });
    const sent = runtime.im.sendMessage(owner, String(group.id), {
      content: `mention://character/${character.id} 保持排队。`,
      requestId: "im-noop-group-settings-0001"
    });
    const chainId = String((sent.chain as Record<string, unknown>).id);

    runtime.im.updateGroup(owner, String(group.id), {
      title: "重复群设置群",
      replyMode: "mention",
      responseThreshold: 60,
      maxAiMessages: 20
    });
    expect(runtime.database.get("SELECT status FROM im_chains WHERE id = ?", chainId)).toEqual({ status: "waiting_config" });
  });

  it("失效角色墓碑不占群容量且不能绕过至少一个可用角色约束", () => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-character-tombstone-secret-with-enough-length",
      serveUi: false
    });
    const owner = runtime.auth.register({ username: "character_tombstone_owner", password: "secure-password-123" }).session.user;
    const { work, characters } = runWithRequestActor(actor(owner), () => {
      const createdWork = runtime.store.createWork({ title: "角色墓碑容量作品" });
      return {
        work: createdWork,
        characters: Array.from({ length: 11 }, (_, index) => runtime.store.createCharacter(String(createdWork.id), {
          name: `墓碑容量角色 ${index + 1}`
        }))
      };
    });
    const group = runtime.im.createGroup(owner, {
      title: "角色墓碑容量群",
      characterIds: characters.slice(0, 10).map((character) => String(character.id))
    });
    runtime.store.deleteCharacter(String(characters[0]!.id));
    runtime.im.refreshCharacterAvailability(String(group.id));

    runtime.im.addCharacter(owner, String(group.id), String(characters[10]!.id));
    expect(runtime.database.get(
      `SELECT COUNT(*) AS count FROM im_character_memberships
       WHERE conversation_id = ? AND left_at IS NULL AND status = 'active' AND character_id IS NOT NULL`,
      String(group.id)
    )).toEqual({ count: 10 });
    runtime.store.restoreCharacter(String(characters[0]!.id), 1);
    runtime.im.refreshCharacterAvailability(String(group.id));
    expect(runtime.database.get(
      `SELECT status FROM im_character_memberships
       WHERE conversation_id = ? AND character_id = ? AND left_at IS NULL`,
      String(group.id),
      String(characters[10]!.id)
    )).toEqual({ status: "active" });
    expect(runtime.database.get(
      `SELECT status FROM im_character_memberships
       WHERE conversation_id = ? AND character_id IS NULL
         AND json_extract(snapshot_json, '$.id') = ? AND left_at IS NULL`,
      String(group.id),
      String(characters[0]!.id)
    )).toEqual({ status: "suspended" });
    for (const character of characters.slice(1, 10)) {
      runtime.im.removeCharacter(owner, String(group.id), String(character.id));
    }
    expect(() => runtime.im.removeCharacter(owner, String(group.id), String(characters[10]!.id)))
      .toThrowError("群聊必须至少保留一个 AI 角色");

    expect(() => runtime.im.removeCharacter(owner, String(group.id), String(characters[0]!.id))).not.toThrow();
    expect(runtime.database.get(
      `SELECT COUNT(*) AS count FROM im_character_memberships
       WHERE conversation_id = ? AND left_at IS NULL AND character_id IS NULL`,
      String(group.id)
    )).toEqual({ count: 0 });
    expect(runtime.store.getWork(String(work.id))).toMatchObject({ id: work.id });
  });

  it("三个 IM 写入口都拒绝已合并角色", () => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-merged-character-secret-with-enough-length",
      serveUi: false
    });
    const owner = runtime.auth.register({ username: "merged_character_owner", password: "secure-password-123" }).session.user;
    const { source, target } = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "已合并角色作品" });
      return {
        source: runtime.store.createCharacter(String(work.id), { name: "已合并来源角色" }),
        target: runtime.store.createCharacter(String(work.id), { name: "合并目标角色" })
      };
    });
    runtime.database.run("UPDATE characters SET merged_into_character_id = ? WHERE id = ?", String(target.id), String(source.id));

    expect(() => runtime.im.createDirect(owner, String(source.id))).toThrowError("已合并角色不能加入 IM 会话");
    expect(() => runtime.im.createGroup(owner, {
      title: "错误合并角色群",
      characterIds: [String(source.id)]
    })).toThrowError("已合并角色不能加入 IM 会话");
    const group = runtime.im.createGroup(owner, {
      title: "有效角色群",
      characterIds: [String(target.id)]
    });
    expect(() => runtime.im.addCharacter(owner, String(group.id), String(source.id)))
      .toThrowError("已合并角色不能加入 IM 会话");
  });

  it("重新打开会话时恢复重新获得权限的角色", () => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-character-permission-refresh-secret-with-enough-length",
      serveUi: false
    });
    const workOwner = runtime.auth.register({ username: "permission_refresh_work_owner", password: "secure-password-123" }).session.user;
    const chatOwner = runtime.auth.register({ username: "permission_refresh_chat_owner", password: "secure-password-123" }).session.user;
    const { work, character } = runWithRequestActor(actor(workOwner), () => {
      const createdWork = runtime.store.createWork({ title: "权限恢复作品" });
      return {
        work: createdWork,
        character: runtime.store.createCharacter(String(createdWork.id), { name: "权限恢复角色" })
      };
    });
    runtime.auth.addMember(String(work.id), chatOwner.userId, { role: "editor" }, workOwner.userId);
    const direct = runtime.im.createDirect(chatOwner, String(character.id));

    runtime.auth.updateMemberPermissions(String(work.id), chatOwner.userId, { role: "viewer" });
    expect(runtime.im.getConversation(String(direct.id), chatOwner.userId).participants).toMatchObject({
      characters: [expect.objectContaining({ characterId: character.id, status: "suspended" })]
    });

    runtime.auth.updateMemberPermissions(String(work.id), chatOwner.userId, { role: "editor" });
    expect(runtime.im.getConversation(String(direct.id), chatOwner.userId).participants).toMatchObject({
      characters: [expect.objectContaining({ characterId: character.id, status: "active" })]
    });
  });

  it("批量读取多书籍 IM 目录权限", () => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-catalog-permission-batch-secret-with-enough-length",
      serveUi: false
    });
    const owner = runtime.auth.register({ username: "catalog_batch_owner", password: "secure-password-123" }).session.user;
    runWithRequestActor(actor(owner), () => {
      for (let index = 0; index < 5; index += 1) {
        const work = runtime.store.createWork({ title: `目录批量作品 ${index + 1}` });
        runtime.store.createCharacter(String(work.id), { name: `目录批量角色 ${index + 1}` });
      }
    });

    const allSpy = vi.spyOn(runtime.database, "all");
    const getSpy = vi.spyOn(runtime.database, "get");
    expect(runtime.im.listAvailableWorks(owner)).toHaveLength(5);
    expect(allSpy).toHaveBeenCalledTimes(1);
    expect(getSpy).not.toHaveBeenCalled();
    allSpy.mockClear();
    getSpy.mockClear();
    expect(runtime.im.listAvailableCharacters(owner)).toHaveLength(5);
    expect(allSpy).toHaveBeenCalledTimes(1);
    expect(getSpy).not.toHaveBeenCalled();
    allSpy.mockRestore();
    getSpy.mockRestore();
  });

  it("角色目录单次查询结果有硬上限", () => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-character-directory-limit-secret-with-enough-length",
      serveUi: false
    });
    const owner = runtime.auth.register({ username: "character_directory_limit_owner", password: "secure-password-123" }).session.user;
    const work = runWithRequestActor(actor(owner), () => {
      const createdWork = runtime.store.createWork({ title: "角色目录上限作品" });
      for (let index = 0; index < 105; index += 1) {
        runtime.store.createCharacter(String(createdWork.id), { name: `目录上限角色 ${String(index).padStart(3, "0")}` });
      }
      return createdWork;
    });

    expect(runtime.im.listAvailableCharacters(owner, "", String(work.id))).toHaveLength(100);
    expect(runtime.im.listAvailableCharacters(owner, "目录上限角色 104", String(work.id))).toHaveLength(1);
  });

  it("SSE 重连时重放正在生成气泡的完整流式快照", async () => {
    const encoder = new TextEncoder();
    let releaseStream: (() => void) | null = null;
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-stream-replay-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"前半"}}]}\n\n'));
          releaseStream = () => {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"后半"},"finish_reason":"stop"}]}\n\n'));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          };
        }
      }), { status: 200, headers: { "Content-Type": "text/event-stream" } }),
      aiRetrySleep: async () => undefined
    });
    const owner = runtime.auth.register({ username: "stream_replay_owner", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const character = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "流快照来源" });
      return runtime.store.createCharacter(String(work.id), { name: "流式角色" });
    });
    runtime.im.updateSettings(owner.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 1
    });
    const direct = runtime.im.createDirect(owner, String(character.id));
    const initialEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const unsubscribeInitial = runtime.imOrchestrator.subscribe(owner.userId, (event) => initialEvents.push({ type: event.type, payload: event.payload }));
    const sent = runtime.im.sendMessage(owner, String(direct.id), {
      content: "开始流式回复。",
      requestId: "im-stream-replay-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    const runningDeadline = Date.now() + 2_000;
    while (!initialEvents.some((event) => event.type === "turn" && event.payload.status === "running") && Date.now() < runningDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(initialEvents.some((event) => event.type === "delta")).toBe(false);
    expect(runtime.imOrchestrator.streamingReplySnapshots(String(direct.id))).toEqual([
      expect.objectContaining({ status: "running", content: "" })
    ]);
    let duplicateCancellationCalled = false;
    const duplicate = runtime.im.sendMessage(owner, String(direct.id), {
      content: "开始流式回复。",
      requestId: "im-stream-replay-0001"
    }, () => { duplicateCancellationCalled = true; });
    expect(duplicate).toMatchObject({ duplicate: true });
    expect(duplicateCancellationCalled).toBe(false);
    unsubscribeInitial();

    const replayed: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const unsubscribeReplay = runtime.imOrchestrator.subscribe(owner.userId, (event) => replayed.push({ type: event.type, payload: event.payload }));
    expect(replayed).toEqual([
      expect.objectContaining({ type: "turn", payload: expect.objectContaining({ status: "running", content: "" }) })
    ]);
    expect(releaseStream).not.toBeNull();
    releaseStream!();
    const chain = await waitForChain(runtime, String((sent.chain as Record<string, unknown>).id));
    unsubscribeReplay();

    expect(chain.status).toBe("completed");
    expect(replayed).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "delta", payload: expect.objectContaining({ delta: "前半后半" }) })
    ]));
    expect(runtime.database.get(
      "SELECT content FROM im_messages WHERE chain_id = ? AND sender_kind = 'character'",
      String(chain.id)
    )).toEqual({ content: "前半后半" });
  });

  it("取消旧链后 SSE 重连不再重放旧回复气泡", async () => {
    const responseControl: { release?: () => void } = {};
    let markStarted: (() => void) | null = null;
    const requestStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const responseGate = new Promise<void>((resolve) => { responseControl.release = resolve; });
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-cancelled-stream-replay-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async (_url, init) => {
        markStarted?.();
        await responseGate;
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return completion("取消后的迟到回复。", body.stream === true);
      },
      aiRetrySleep: async () => undefined
    });
    const owner = runtime.auth.register({ username: "cancelled_stream_owner", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const character = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "取消流快照作品" });
      return runtime.store.createCharacter(String(work.id), { name: "取消流快照角色" });
    });
    runtime.im.updateSettings(owner.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 1
    });
    const direct = runtime.im.createDirect(owner, String(character.id));
    const sent = runtime.im.sendMessage(owner, String(direct.id), {
      content: "开始后取消流快照。",
      requestId: "im-cancelled-stream-replay-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    await requestStarted;
    expect(runtime.imOrchestrator.streamingReplySnapshots(String(direct.id))).toHaveLength(1);
    runtime.im.stopChain(owner.userId, String(direct.id));
    runtime.imOrchestrator.cancelConversation(String(direct.id), "stopped_by_user");
    expect(runtime.imOrchestrator.streamingReplySnapshots(String(direct.id))).toEqual([]);
    const replayed: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const unsubscribe = runtime.imOrchestrator.subscribe(owner.userId, (event) => replayed.push({ type: event.type, payload: event.payload }));
    expect(replayed).toEqual([]);
    unsubscribe();
    responseControl.release?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it("按实际送入模型的最早完整历史推进角色压缩游标", async () => {
    let compactPrompt = "";
    let primaryCompactCalls = 0;
    let fallbackCompactCalls = 0;
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-compaction-prefix-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const messages = body.messages as Array<{ role: string; content: string }>;
        const prompt = messages.map((message) => message.content).join("\n");
        if (prompt.includes("只把已送达给当前角色的 IM 历史压缩")) {
          compactPrompt = prompt;
          if (body.model === "primary-model") {
            primaryCompactCalls += 1;
            return completion("   ", false);
          }
          fallbackCompactCalls += 1;
          return completion("已压缩的完整前缀摘要。", false);
        }
        return completion("压缩后继续回答。", body.stream === true);
      },
      aiRetrySleep: async () => undefined
    });
    const owner = runtime.auth.register({ username: "compaction_prefix_owner", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const character = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "压缩前缀来源" });
      const createdCharacter = runtime.store.createCharacter(String(work.id), {
        name: "压缩角色",
        attributes: { privateSecret: "COMPACTION_PRIVATE_CHARACTER_SECRET" }
      });
      runtime.store.createRoleplayMemory(String(createdCharacter.id), {
        category: "knowledge",
        content: "COMPACTION_PRIVATE_ROLEPLAY_MEMORY"
      });
      return createdCharacter;
    });
    runtime.im.updateSettings(owner.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 1
    });
    const group = runtime.im.createGroup(owner, {
      title: "压缩前缀群",
      characterIds: [String(character.id)],
      replyMode: "mention",
      maxAiMessages: 1
    });
    for (let index = 1; index <= 81; index += 1) {
      runtime.im.publishAnnouncement(owner, String(group.id), {
        content: `公告编号 ${String(index).padStart(3, "0")}`,
        requestId: `im-compaction-announcement-${index}`
      });
    }
    const sent = runtime.im.sendMessage(owner, String(group.id), {
      content: `mention://character/${character.id} 请继续。`,
      requestId: "im-compaction-prefix-message-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    const chain = await waitForChain(runtime, String((sent.chain as Record<string, unknown>).id));

    expect(chain.generated_count).toBe(1);
    expect(compactPrompt).toContain("[1] 旁白：公告编号 001");
    expect(compactPrompt).toContain("[62] 旁白：公告编号 062");
    expect(compactPrompt).not.toContain("COMPACTION_PRIVATE_CHARACTER_SECRET");
    expect(compactPrompt).not.toContain("COMPACTION_PRIVATE_ROLEPLAY_MEMORY");
    expect(compactPrompt).not.toContain("recall_roleplay_memory");
    expect(primaryCompactCalls).toBe(1);
    expect(fallbackCompactCalls).toBe(1);
    expect(runtime.database.get(
      `SELECT context.summarized_through_sequence FROM im_character_contexts context
       JOIN im_character_memberships membership ON membership.id = context.character_membership_id
       WHERE membership.conversation_id = ?`,
      String(group.id)
    )).toEqual({ summarized_through_sequence: 62 });
  });

  it("主模型和 fallback 都返回空白摘要时不推进压缩游标", async () => {
    let replyPrompt = "";
    let primaryCompactCalls = 0;
    let fallbackCompactCalls = 0;
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-empty-compaction-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const messages = body.messages as Array<{ role: string; content: string }>;
        const compact = messages.some((message) => message.content.includes("只把已送达给当前角色的 IM 历史压缩"));
        if (compact) {
          if (body.model === "primary-model") primaryCompactCalls += 1;
          else fallbackCompactCalls += 1;
          return completion(" \n ", body.stream === true);
        }
        replyPrompt = messages.map((message) => message.content).join("\n");
        return completion("压缩失败后仍正常回复。", body.stream === true);
      },
      aiRetrySleep: async () => undefined
    });
    const owner = runtime.auth.register({ username: "empty_compaction_owner", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const character = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "空白压缩来源" });
      return runtime.store.createCharacter(String(work.id), { name: "空白压缩角色" });
    });
    runtime.im.updateSettings(owner.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 3
    });
    const group = runtime.im.createGroup(owner, {
      title: "空白压缩群",
      characterIds: [String(character.id)],
      replyMode: "mention",
      maxAiMessages: 1
    });
    for (let index = 1; index <= 81; index += 1) {
      runtime.im.publishAnnouncement(owner, String(group.id), {
        content: `空白压缩公告 ${index}`,
        requestId: `im-empty-compaction-announcement-${index}`
      });
    }
    const sent = runtime.im.sendMessage(owner, String(group.id), {
      content: `mention://character/${character.id} 继续。`,
      requestId: "im-empty-compaction-message-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    const chain = await waitForChain(runtime, String((sent.chain as Record<string, unknown>).id));

    expect(chain.generated_count).toBe(1);
    expect(replyPrompt).toContain("空白压缩公告 1");
    expect(replyPrompt).toContain("空白压缩公告 81");
    expect(primaryCompactCalls).toBe(3);
    expect(fallbackCompactCalls).toBe(3);
    expect(runtime.database.get(
      `SELECT COUNT(*) AS count FROM im_character_contexts context
       JOIN im_character_memberships membership ON membership.id = context.character_membership_id
       WHERE membership.conversation_id = ?`,
      String(group.id)
    )).toEqual({ count: 0 });
    expect(runtime.database.get(
      "SELECT failure FROM im_chain_turns WHERE chain_id = ? AND kind = 'compact'",
      String(chain.id)
    )).toEqual({ failure: expect.any(String) });
  });

  it("compact turn 完成失败时回滚摘要和压缩游标", async () => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-atomic-compaction-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const messages = body.messages as Array<{ role: string; content: string }>;
        const compact = messages.some((message) => message.content.includes("只把已送达给当前角色的 IM 历史压缩"));
        const judge = messages.some((message) => message.content.includes("只判断当前角色现在是否有必要发送一条新消息"));
        if (compact) return completion("这条摘要必须随 turn 一起回滚。", false);
        if (judge) return completion('{"score":0}', false);
        return completion("不应生成回复。", body.stream === true);
      },
      aiRetrySleep: async () => undefined
    });
    const owner = runtime.auth.register({ username: "atomic_compaction_owner", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const character = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "压缩原子事务作品" });
      return runtime.store.createCharacter(String(work.id), { name: "压缩原子事务角色" });
    });
    runtime.im.updateSettings(owner.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 1
    });
    const group = runtime.im.createGroup(owner, {
      title: "压缩原子事务群",
      characterIds: [String(character.id)],
      replyMode: "proactive",
      responseThreshold: 100,
      maxAiMessages: 1
    });
    for (let index = 1; index <= 61; index += 1) {
      runtime.im.publishAnnouncement(owner, String(group.id), {
        content: `压缩原子事务公告 ${index}`,
        requestId: `im-atomic-compaction-announcement-${index}`
      });
    }
    runtime.database.run(
      `CREATE TRIGGER fail_compact_turn_completion
       BEFORE UPDATE OF status ON im_chain_turns
       WHEN OLD.kind = 'compact' AND NEW.status = 'completed'
       BEGIN SELECT RAISE(ABORT, 'forced compact turn completion failure'); END;`
    );
    const sent = runtime.im.sendMessage(owner, String(group.id), {
      content: "触发压缩原子事务。",
      requestId: "im-atomic-compaction-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    const chainId = String((sent.chain as Record<string, unknown>).id);
    await waitForChain(runtime, chainId);

    expect(runtime.database.get(
      "SELECT COUNT(*) AS count FROM im_character_contexts WHERE character_membership_id IN (SELECT id FROM im_character_memberships WHERE conversation_id = ?)",
      String(group.id)
    )).toEqual({ count: 0 });
    expect(runtime.database.get(
      "SELECT status FROM im_chain_turns WHERE chain_id = ? AND kind = 'compact'",
      chainId
    )).toEqual({ status: "failed" });
  });

  it("长消息以完整原子进入压缩和普通角色历史", async () => {
    let compactPrompt = "";
    let replyPrompt = "";
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-long-history-atom-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const messages = body.messages as Array<{ role: string; content: string }>;
        const prompt = messages.map((message) => message.content).join("\n");
        if (prompt.includes("只把已送达给当前角色的 IM 历史压缩")) {
          compactPrompt = prompt;
          return completion("长消息已完整压缩。", false);
        }
        replyPrompt = prompt;
        return completion("已读取完整长消息。", body.stream === true);
      },
      aiRetrySleep: async () => undefined
    });
    const owner = runtime.auth.register({ username: "long_history_atom_owner", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    runtime.database.run("UPDATE models SET context_window = 32768 WHERE id IN (?, ?)", models.primaryModelId, models.fallbackModelId);
    const character = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "长消息原子来源" });
      return runtime.store.createCharacter(String(work.id), { name: "长消息原子角色" });
    });
    runtime.im.updateSettings(owner.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 1
    });
    const group = runtime.im.createGroup(owner, {
      title: "长消息原子群",
      characterIds: [String(character.id)],
      replyMode: "mention",
      maxAiMessages: 1
    });
    const longContent = `LONG-BEGIN-${"长".repeat(19_970)}-LONG-END`;
    runtime.im.publishAnnouncement(owner, String(group.id), {
      content: longContent,
      requestId: "im-long-history-announcement-1"
    });
    for (let index = 2; index <= 61; index += 1) {
      runtime.im.publishAnnouncement(owner, String(group.id), {
        content: `短公告 ${index}`,
        requestId: `im-long-history-announcement-${index}`
      });
    }
    const sent = runtime.im.sendMessage(owner, String(group.id), {
      content: `mention://character/${character.id} 继续。`,
      requestId: "im-long-history-message-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    const chain = await waitForChain(runtime, String((sent.chain as Record<string, unknown>).id));

    expect(chain.generated_count).toBe(1);
    expect(compactPrompt).toContain("LONG-BEGIN-");
    expect(compactPrompt).toContain("-LONG-END");
    expect(replyPrompt).toContain("长消息已完整压缩。");
    expect(runtime.database.get(
      `SELECT context.summarized_through_sequence FROM im_character_contexts context
       JOIN im_character_memberships membership ON membership.id = context.character_membership_id
       WHERE membership.conversation_id = ?`,
      String(group.id)
    )).toEqual({ summarized_through_sequence: 42 });
  });

  it("最小上下文模型会先分批压缩多条长中文消息", async () => {
    const compactPrompts: string[] = [];
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-long-token-budget-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const messages = body.messages as Array<{ role: string; content: string }>;
        const prompt = messages.map((message) => message.content).join("\n");
        if (prompt.includes("只把已送达给当前角色的 IM 历史压缩")) {
          compactPrompts.push(prompt);
          return completion(`分批摘要 ${compactPrompts.length}`, false);
        }
        return completion("长消息分批压缩后回复。", body.stream === true);
      },
      aiRetrySleep: async () => undefined
    });
    const owner = runtime.auth.register({ username: "long_token_budget_owner", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    runtime.database.run("UPDATE models SET context_window = 32768 WHERE id IN (?, ?)", models.primaryModelId, models.fallbackModelId);
    const character = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "长消息 Token 预算来源" });
      return runtime.store.createCharacter(String(work.id), { name: "长消息 Token 预算角色" });
    });
    runtime.im.updateSettings(owner.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 1
    });
    const group = runtime.im.createGroup(owner, {
      title: "长消息 Token 预算群",
      characterIds: [String(character.id)],
      replyMode: "mention",
      maxAiMessages: 1
    });
    for (let index = 1; index <= 3; index += 1) {
      runtime.im.publishAnnouncement(owner, String(group.id), {
        content: `LONG-${index}-BEGIN-${"中".repeat(19_960)}-LONG-${index}-END`,
        requestId: `im-long-token-budget-announcement-${index}`
      });
    }
    const sent = runtime.im.sendMessage(owner, String(group.id), {
      content: `mention://character/${character.id} 继续。`,
      requestId: "im-long-token-budget-message-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    const chain = await waitForChain(runtime, String((sent.chain as Record<string, unknown>).id));

    expect(chain.generated_count).toBe(1);
    expect(compactPrompts).toHaveLength(2);
    expect(compactPrompts[0]).toContain("LONG-1-BEGIN-");
    expect(compactPrompts[0]).toContain("-LONG-1-END");
    expect(compactPrompts[1]).toContain("LONG-2-BEGIN-");
    expect(compactPrompts[1]).toContain("-LONG-2-END");
    expect(runtime.database.get(
      `SELECT context.summarized_through_sequence FROM im_character_contexts context
       JOIN im_character_memberships membership ON membership.id = context.character_membership_id
       WHERE membership.conversation_id = ?`,
      String(group.id)
    )).toEqual({ summarized_through_sequence: 2 });
  });

  it("合法最大身份卡可用且多人身份总量超过模型预算时明确失败", async () => {
    let fetchCalls = 0;
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-participant-budget-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async (_url, init) => {
        fetchCalls += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return completion("身份预算内回复。", body.stream === true);
      },
      aiRetrySleep: async () => undefined
    });
    const owner = runtime.auth.register({ username: "participant_budget_owner", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    runtime.database.run("UPDATE models SET context_window = 32768 WHERE id IN (?, ?)", models.primaryModelId, models.fallbackModelId);
    const character = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "身份预算来源" });
      return runtime.store.createCharacter(String(work.id), { name: "身份预算角色" });
    });
    runtime.im.updateSettings(owner.userId, {
      identitySummary: "身份".repeat(1000),
      additionalNotes: "说明".repeat(2000),
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 1
    });
    const direct = runtime.im.createDirect(owner, String(character.id));
    const sent = runtime.im.sendMessage(owner, String(direct.id), {
      content: "验证身份预算。",
      requestId: "im-participant-budget-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    const chain = await waitForChain(runtime, String((sent.chain as Record<string, unknown>).id));

    expect(chain).toMatchObject({ status: "completed", generated_count: 1 });
    expect(fetchCalls).toBe(1);
    const members = Array.from({ length: 4 }, (_, index) => runtime.auth.register({
      username: `participant_budget_member_${index + 1}`,
      password: "secure-password-123"
    }).session.user);
    for (const member of members) {
      runtime.im.updateSettings(member.userId, {
        identitySummary: "身份".repeat(1000),
        additionalNotes: "说明".repeat(2000)
      });
    }
    const group = runtime.im.createGroup(owner, {
      title: "多人身份预算群",
      characterIds: [String(character.id)],
      humanUserIds: members.map((member) => member.userId)
    });
    const oversized = runtime.im.sendMessage(owner, String(group.id), {
      content: `mention://character/${character.id} 验证多人身份预算。`,
      requestId: "im-participant-budget-oversized-0001"
    });
    runtime.imOrchestrator.publishMessageResult(oversized);
    const oversizedChain = await waitForChain(runtime, String((oversized.chain as Record<string, unknown>).id));
    expect(oversizedChain).toMatchObject({ status: "failed", error_code: "IM_PARTICIPANT_CONTEXT_TOO_LARGE" });
    expect(fetchCalls).toBe(1);
    expect(runtime.database.get(
      "SELECT model_id, model_stage, attempt_count, ai_call_ids_json FROM im_chain_turns WHERE chain_id = ? AND kind = 'reply'",
      String(oversizedChain.id)
    )).toEqual({ model_id: null, model_stage: null, attempt_count: 0, ai_call_ids_json: "[]" });
  });

  it("在角色生成前发布气泡状态并把最终错误保留在角色 turn 中", async () => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-reply-failure-test-master-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async () => new Response("provider unavailable", { status: 500 }),
      aiRetrySleep: async () => undefined
    });
    const owner = runtime.auth.register({ username: "reply_failure_owner", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const character = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "失败气泡来源" });
      return runtime.store.createCharacter(String(work.id), { name: "沈砚" });
    });
    runtime.im.updateSettings(owner.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 1
    });
    const direct = runtime.im.createDirect(owner, String(character.id));
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const unsubscribe = runtime.imOrchestrator.subscribe(owner.userId, (event) => events.push({ type: event.type, payload: event.payload }));
    const sent = runtime.im.sendMessage(owner, String(direct.id), {
      content: "能收到吗？",
      requestId: "im-reply-failure-request-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    const chain = await waitForChain(runtime, String((sent.chain as Record<string, unknown>).id));
    unsubscribe();

    expect(chain).toMatchObject({ status: "failed", generated_count: 0 });
    const replyEvents = events.filter((event) => event.type === "turn" && event.payload.kind === "reply");
    expect(replyEvents.map((event) => event.payload.status)).toEqual(["pending", "running", "failed"]);
    expect(replyEvents.at(-1)?.payload).toMatchObject({
      characterId: character.id,
      error: { code: "AI_CALL_FAILED" }
    });
    const activeChain = runtime.im.getConversation(String(direct.id), owner.userId).activeChain as Record<string, unknown>;
    expect(activeChain.status).toBe("failed");
    expect(activeChain.turns).toEqual([
      expect.objectContaining({ characterId: character.id, status: "failed", failure: expect.stringContaining("AI_CALL_FAILED") })
    ]);
  });

  it("未知模型异常不会把内部错误文本写入链路或 turn", async () => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-unknown-error-redaction-secret-with-enough-length",
      serveUi: false
    });
    const owner = runtime.auth.register({ username: "unknown_error_owner", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const character = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "未知异常来源" });
      return runtime.store.createCharacter(String(work.id), { name: "未知异常角色" });
    });
    runtime.im.updateSettings(owner.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 1
    });
    vi.spyOn(runtime.ai, "generateIm").mockRejectedValue(new Error("sensitive /internal/database/path"));
    const direct = runtime.im.createDirect(owner, String(character.id));
    const sent = runtime.im.sendMessage(owner, String(direct.id), {
      content: "触发未知异常。",
      requestId: "im-unknown-error-redaction-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    const chain = await waitForChain(runtime, String((sent.chain as Record<string, unknown>).id));
    const turn = runtime.database.get("SELECT failure, attempt_count FROM im_chain_turns WHERE chain_id = ? AND kind = 'reply'", String(chain.id));

    expect(chain).toMatchObject({ status: "failed", error_code: "IM_AI_CHAIN_FAILED", error_message: "IM AI 交流链失败" });
    expect(turn).toEqual({ failure: "IM_AI_CHAIN_FAILED: IM AI 交流链失败", attempt_count: 0 });
    expect(JSON.stringify({ chain, turn })).not.toContain("sensitive");
  });

  it("拒绝超过消息存储上限的角色回复并保留明确错误", async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-reply-length-limit-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        if (body.model === "primary-model") primaryCalls += 1;
        else fallbackCalls += 1;
        return completion("长".repeat(20_001), body.stream === true);
      },
      aiRetrySleep: async () => undefined
    });
    const owner = runtime.auth.register({ username: "reply_length_owner", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const character = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "超长回复来源" });
      return runtime.store.createCharacter(String(work.id), { name: "长文角色" });
    });
    runtime.im.updateSettings(owner.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 3
    });
    const direct = runtime.im.createDirect(owner, String(character.id));
    const sent = runtime.im.sendMessage(owner, String(direct.id), {
      content: "生成超长回复。",
      requestId: "im-reply-length-limit-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    const chainId = String((sent.chain as Record<string, unknown>).id);
    const chain = await waitForChain(runtime, chainId);

    expect(chain).toMatchObject({ status: "failed", generated_count: 0, error_code: "IM_AI_REPLY_TOO_LONG" });
    expect(primaryCalls).toBe(3);
    expect(fallbackCalls).toBe(3);
    expect(runtime.database.get(
      "SELECT failure, attempt_count FROM im_chain_turns WHERE chain_id = ? AND kind = 'reply'",
      chainId
    )).toEqual({ failure: expect.stringContaining("IM_AI_REPLY_TOO_LONG"), attempt_count: 6 });
    expect(runtime.database.get(
      "SELECT COUNT(*) AS count FROM im_messages WHERE chain_id = ? AND sender_kind = 'character'",
      chainId
    )).toEqual({ count: 0 });
  });

  it("主模型回复超长时切换 fallback 生成可写入消息", async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-primary-long-fallback-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        if (body.model === "primary-model") {
          primaryCalls += 1;
          return completion("长".repeat(20_001), body.stream === true);
        }
        fallbackCalls += 1;
        return completion("fallback 长度正常。", body.stream === true);
      },
      aiRetrySleep: async () => undefined
    });
    const owner = runtime.auth.register({ username: "primary_long_fallback_owner", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const character = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "超长 fallback 来源" });
      return runtime.store.createCharacter(String(work.id), { name: "超长 fallback 角色" });
    });
    runtime.im.updateSettings(owner.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 1
    });
    const direct = runtime.im.createDirect(owner, String(character.id));
    const sent = runtime.im.sendMessage(owner, String(direct.id), {
      content: "生成可回退的回复。",
      requestId: "im-primary-long-fallback-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    const chain = await waitForChain(runtime, String((sent.chain as Record<string, unknown>).id));

    expect(chain).toMatchObject({ status: "completed", model_stage: "fallback", generated_count: 1 });
    expect(primaryCalls).toBe(1);
    expect(fallbackCalls).toBe(1);
    expect(runtime.database.get(
      "SELECT content FROM im_messages WHERE chain_id = ? AND sender_kind = 'character'",
      String(chain.id)
    )).toEqual({ content: "fallback 长度正常。" });
  });

  it("同一模型重试无效流式输出前重置当前回复气泡", async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-output-validation-reset-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        if (body.model === "primary-model") {
          primaryCalls += 1;
          return completion(primaryCalls === 1 ? "长".repeat(20_001) : "第二次有效回复。", body.stream === true);
        }
        fallbackCalls += 1;
        return completion("不应进入 fallback。", body.stream === true);
      },
      aiRetrySleep: async () => undefined
    });
    const owner = runtime.auth.register({ username: "output_validation_reset_owner", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const character = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "无效输出重置来源" });
      return runtime.store.createCharacter(String(work.id), { name: "无效输出重置角色" });
    });
    runtime.im.updateSettings(owner.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 2
    });
    const direct = runtime.im.createDirect(owner, String(character.id));
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const unsubscribe = runtime.imOrchestrator.subscribe(owner.userId, (event) => events.push({ type: event.type, payload: event.payload }));
    const sent = runtime.im.sendMessage(owner, String(direct.id), {
      content: "验证输出重试重置。",
      requestId: "im-output-validation-reset-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    const chain = await waitForChain(runtime, String((sent.chain as Record<string, unknown>).id));
    unsubscribe();

    expect(chain).toMatchObject({ status: "completed", model_stage: "primary", generated_count: 1 });
    expect(primaryCalls).toBe(2);
    expect(fallbackCalls).toBe(0);
    const resetEvents = events.filter((event) => event.type === "reset");
    expect(resetEvents).toHaveLength(1);
    expect(resetEvents[0]?.payload).toMatchObject({ reason: "output_validation_retry", modelStage: "primary" });
    expect(resetEvents[0]?.payload.turnId).toBeTruthy();
    expect(runtime.database.get(
      "SELECT content FROM im_messages WHERE chain_id = ? AND sender_kind = 'character'",
      String(chain.id)
    )).toEqual({ content: "第二次有效回复。" });
  });

  it("AI 输出 mention 超限时切换 fallback 且不逐项查询", async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-output-mention-limit-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        if (body.model === "primary-model") {
          primaryCalls += 1;
          return completion(Array.from({ length: 51 }, () => "mention://user/nonexistent").join(" "), body.stream === true);
        }
        fallbackCalls += 1;
        return completion("fallback mention 数量正常。", body.stream === true);
      },
      aiRetrySleep: async () => undefined
    });
    const owner = runtime.auth.register({ username: "output_mention_limit_owner", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const character = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "输出 Mention 限制来源" });
      return runtime.store.createCharacter(String(work.id), { name: "输出 Mention 限制角色" });
    });
    runtime.im.updateSettings(owner.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 1
    });
    const direct = runtime.im.createDirect(owner, String(character.id));
    const sent = runtime.im.sendMessage(owner, String(direct.id), {
      content: "验证输出 mention 限制。",
      requestId: "im-output-mention-limit-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    const chain = await waitForChain(runtime, String((sent.chain as Record<string, unknown>).id));

    expect(chain).toMatchObject({ status: "completed", model_stage: "fallback", generated_count: 1 });
    expect(primaryCalls).toBe(1);
    expect(fallbackCalls).toBe(1);
  });

  it("AI 输出失效 mention 时切换 fallback", async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-output-invalid-mention-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        if (body.model === "primary-model") {
          primaryCalls += 1;
          return completion("mention://character/missing-character 这条提及无效。", body.stream === true);
        }
        fallbackCalls += 1;
        return completion("fallback 不再包含失效提及。", body.stream === true);
      },
      aiRetrySleep: async () => undefined
    });
    const owner = runtime.auth.register({ username: "output_invalid_mention_owner", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const character = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "输出失效 Mention 来源" });
      return runtime.store.createCharacter(String(work.id), { name: "输出失效 Mention 角色" });
    });
    runtime.im.updateSettings(owner.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 1
    });
    const direct = runtime.im.createDirect(owner, String(character.id));
    const sent = runtime.im.sendMessage(owner, String(direct.id), {
      content: "验证输出失效 mention。",
      requestId: "im-output-invalid-mention-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    const chain = await waitForChain(runtime, String((sent.chain as Record<string, unknown>).id));

    expect(chain).toMatchObject({ status: "completed", model_stage: "fallback", generated_count: 1 });
    expect(primaryCalls).toBe(1);
    expect(fallbackCalls).toBe(1);
    expect(runtime.database.get(
      "SELECT content FROM im_messages WHERE chain_id = ? AND sender_kind = 'character'",
      String(chain.id)
    )).toEqual({ content: "fallback 不再包含失效提及。" });
  });

  it("主模型回复空白时切换 fallback 生成有效消息", async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-primary-empty-fallback-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        if (body.model === "primary-model") {
          primaryCalls += 1;
          return completion(" \n ", body.stream === true);
        }
        fallbackCalls += 1;
        return completion("fallback 有效回复。", body.stream === true);
      },
      aiRetrySleep: async () => undefined
    });
    const owner = runtime.auth.register({ username: "primary_empty_fallback_owner", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const character = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "空白 fallback 来源" });
      return runtime.store.createCharacter(String(work.id), { name: "空白 fallback 角色" });
    });
    runtime.im.updateSettings(owner.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 1
    });
    const direct = runtime.im.createDirect(owner, String(character.id));
    const sent = runtime.im.sendMessage(owner, String(direct.id), {
      content: "生成非空回复。",
      requestId: "im-primary-empty-fallback-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    const chain = await waitForChain(runtime, String((sent.chain as Record<string, unknown>).id));

    expect(chain).toMatchObject({ status: "completed", model_stage: "fallback", generated_count: 1 });
    expect(primaryCalls).toBe(1);
    expect(fallbackCalls).toBe(1);
    expect(runtime.database.get(
      "SELECT content FROM im_messages WHERE chain_id = ? AND sender_kind = 'character'",
      String(chain.id)
    )).toEqual({ content: "fallback 有效回复。" });
  });

  it("主模型和 fallback 空白回复各自耗尽配置失败次数", async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-empty-reply-attempts-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        if (body.model === "primary-model") primaryCalls += 1;
        else fallbackCalls += 1;
        return completion(" \n ", body.stream === true);
      },
      aiRetrySleep: async () => undefined
    });
    const owner = runtime.auth.register({ username: "empty_reply_attempts_owner", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const character = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "空白回复次数来源" });
      return runtime.store.createCharacter(String(work.id), { name: "空白回复次数角色" });
    });
    runtime.im.updateSettings(owner.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 3
    });
    const direct = runtime.im.createDirect(owner, String(character.id));
    const sent = runtime.im.sendMessage(owner, String(direct.id), {
      content: "验证空白回复失败次数。",
      requestId: "im-empty-reply-attempts-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    const chain = await waitForChain(runtime, String((sent.chain as Record<string, unknown>).id));

    expect(chain).toMatchObject({ status: "failed", model_stage: "fallback", error_code: "AI_CALL_FAILED" });
    expect(primaryCalls).toBe(3);
    expect(fallbackCalls).toBe(3);
    expect(runtime.database.get(
      "SELECT attempt_count FROM im_chain_turns WHERE chain_id = ? AND kind = 'reply'",
      String(chain.id)
    )).toEqual({ attempt_count: 6 });
  });

  it("一个角色回答失败时继续执行同批其他角色", async () => {
    const normalCharacterModels: string[] = [];
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-partial-reply-failure-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const messages = body.messages as Array<{ role: string; content: string }>;
        const system = messages[0]?.content ?? "";
        if (system.indexOf("故障角色") < system.indexOf("正常角色")) return new Response("provider unavailable", { status: 500 });
        normalCharacterModels.push(String(body.model));
        return completion("正常角色已回复。", body.stream === true);
      },
      aiRetrySleep: async () => undefined
    });
    const owner = runtime.auth.register({ username: "partial_failure_owner", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const characters = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "局部失败来源" });
      return [
        runtime.store.createCharacter(String(work.id), { name: "故障角色" }),
        runtime.store.createCharacter(String(work.id), { name: "正常角色" })
      ];
    });
    runtime.im.updateSettings(owner.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 1
    });
    const group = runtime.im.createGroup(owner, {
      title: "局部失败群",
      characterIds: characters.map((character) => String(character.id)),
      replyMode: "mention",
      maxAiMessages: 5
    });
    const sent = runtime.im.sendMessage(owner, String(group.id), {
      content: characters.map((character) => `mention://character/${character.id}`).join(" 请分别回复 "),
      requestId: "im-partial-reply-failure-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    const chainId = String((sent.chain as Record<string, unknown>).id);
    const chain = await waitForChain(runtime, chainId);

    expect(chain).toMatchObject({ status: "completed", generated_count: 1 });
    expect(runtime.database.all(
      `SELECT membership.character_id, turn.status FROM im_chain_turns turn
       JOIN im_character_memberships membership ON membership.id = turn.character_membership_id
       WHERE turn.chain_id = ? AND turn.kind = 'reply' ORDER BY turn.rowid`,
      chainId
    )).toEqual([
      { character_id: characters[0]?.id, status: "failed" },
      { character_id: characters[1]?.id, status: "completed" }
    ]);
    expect(runtime.database.get(
      "SELECT sender_character_id, content FROM im_messages WHERE chain_id = ? AND sender_kind = 'character'",
      chainId
    )).toEqual({ sender_character_id: characters[1]?.id, content: "正常角色已回复。" });
    expect(normalCharacterModels).toEqual(["primary-model"]);
  });

  it("在多个被提及角色开始生成前一次性发布全部等待气泡", async () => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-multiple-pending-test-master-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return completion("收到。", body.stream === true);
      },
      aiRetrySleep: async () => undefined
    });
    const owner = runtime.auth.register({ username: "multiple_pending_owner", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const characters = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "多气泡来源" });
      return [
        runtime.store.createCharacter(String(work.id), { name: "南乔" }),
        runtime.store.createCharacter(String(work.id), { name: "闻溪" })
      ];
    });
    runtime.im.updateSettings(owner.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 1
    });
    const group = runtime.im.createGroup(owner, {
      title: "多气泡群",
      characterIds: characters.map((character) => String(character.id)),
      replyMode: "mention",
      maxAiMessages: 5
    });
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const unsubscribe = runtime.imOrchestrator.subscribe(owner.userId, (event) => events.push({ type: event.type, payload: event.payload }));
    const sent = runtime.im.sendMessage(owner, String(group.id), {
      content: characters.map((character) => `mention://character/${character.id}`).join(" 请分别回答 "),
      requestId: "im-multiple-pending-request-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    const chain = await waitForChain(runtime, String((sent.chain as Record<string, unknown>).id));
    unsubscribe();

    expect(chain).toMatchObject({ status: "completed", generated_count: 2 });
    const replyEvents = events.filter((event) => event.type === "turn" && event.payload.kind === "reply");
    expect(replyEvents.slice(0, 2).map((event) => ({ status: event.payload.status, characterId: event.payload.characterId }))).toEqual([
      { status: "pending", characterId: characters[0]?.id },
      { status: "pending", characterId: characters[1]?.id }
    ]);
    expect(replyEvents.findIndex((event) => event.payload.status === "running")).toBeGreaterThan(1);
  });

  it("主动模式让所有达到阈值的角色进入回复队列并关闭判断思考", async () => {
    const requestPrompts: string[] = [];
    const replyPrompts: string[] = [];
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-proactive-test-master-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const messages = body.messages as Array<{ role: string; content: string }>;
        const system = messages[0]?.content ?? "";
        requestPrompts.push(messages.map((message) => message.content).join("\n"));
        const judge = system.includes("只判断当前角色现在是否有必要发送一条新消息");
        if (judge) {
          expect(body.max_tokens).toBe(1024);
          expect(body.thinking).toEqual({ type: "disabled" });
          return completion(system.indexOf("林舟") < system.indexOf("顾遥") ? '{"score":85}' : '{"score":75}', false);
        }
        const replyPrompt = messages.map((message) => message.content).join("\n");
        replyPrompts.push(replyPrompt);
        return completion(replyPrompt.includes("林舟：我来处理这件事。") ? "偏离原消息。" : "我来处理这件事。", body.stream === true);
      },
      aiRetrySleep: async () => undefined
    });
    const owner = runtime.auth.register({ username: "proactive_owner", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const characters = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "主动群来源" });
      return [
        runtime.store.createCharacter(String(work.id), { name: "林舟" }),
        runtime.store.createCharacter(String(work.id), { name: "顾遥" })
      ];
    });
    const avatarSha256 = "b".repeat(64);
    runtime.store.setCharacterAvatar(String(characters[0]?.id), {
      mimeType: "image/png",
      byteLength: 128,
      sha256: avatarSha256,
      storageKey: "im-orchestrator-character-avatar.png",
      width: 64,
      height: 64
    });
    runtime.im.updateSettings(owner.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 1
    });
    const group = runtime.im.createGroup(owner, {
      title: "主动交流群",
      characterIds: characters.map((character) => String(character.id)),
      replyMode: "proactive",
      responseThreshold: 60,
      maxAiMessages: 2
    });
    const announcement = runtime.im.publishAnnouncement(owner, String(group.id), {
      content: "远方的风暴正在逼近，甲板开始剧烈摇晃。",
      requestId: "im-proactive-announcement-0001"
    });
    expect(announcement).toMatchObject({ chain: null, duplicate: false });
    expect(runtime.database.get(
      "SELECT COUNT(*) AS count FROM im_message_deliveries WHERE message_id = ?",
      String((announcement.message as Record<string, unknown>).id)
    )).toEqual({ count: 2 });
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM im_chains WHERE conversation_id = ?", String(group.id))).toEqual({ count: 0 });
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const unsubscribe = runtime.imOrchestrator.subscribe(owner.userId, (event) => events.push({ type: event.type, payload: event.payload }));
    const sent = runtime.im.sendMessage(owner, String(group.id), {
      content: "谁来安排今天的航线？",
      requestId: "im-proactive-request-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    const chainId = String((sent.chain as Record<string, unknown>).id);
    const chain = await waitForChain(runtime, chainId);
    unsubscribe();
    expect(chain).toMatchObject({ status: "limit", generated_count: 2 });
    expect(requestPrompts.length).toBeGreaterThanOrEqual(4);
    expect(requestPrompts.every((prompt) => prompt.includes("[1] 旁白：远方的风暴正在逼近，甲板开始剧烈摇晃。"))).toBe(true);
    expect(replyPrompts).toHaveLength(2);
    expect(replyPrompts.every((prompt) => prompt.includes("谁来安排今天的航线？"))).toBe(true);
    expect(replyPrompts[0]).not.toContain("林舟：我来处理这件事。");
    expect(replyPrompts[1]).toContain("林舟：我来处理这件事。");
    expect(runtime.database.all(
      `SELECT membership.character_id, turn.score, turn.selected FROM im_chain_turns turn
       JOIN im_character_memberships membership ON membership.id = turn.character_membership_id
       WHERE turn.chain_id = ? AND turn.kind = 'judge' ORDER BY turn.score DESC`,
      chainId
    )).toEqual([
      { character_id: characters[0]?.id, score: 85, selected: 1 },
      { character_id: characters[1]?.id, score: 75, selected: 1 }
    ]);
    const selectedJudgeEvents = events.filter((event) => event.type === "turn" && event.payload.kind === "judge" && event.payload.selected === true);
    expect(selectedJudgeEvents).toHaveLength(2);
    expect(new Set(selectedJudgeEvents.map((event) => event.payload.turnId))).toEqual(new Set(runtime.database.all(
      "SELECT id FROM im_chain_turns WHERE chain_id = ? AND kind = 'judge' AND selected = 1",
      chainId
    ).map((turn) => turn.id)));
    const characterMessages = runtime.database.all(
      "SELECT sender_character_id, sender_snapshot_json, content FROM im_messages WHERE conversation_id = ? AND sender_kind = 'character' ORDER BY sequence",
      String(group.id)
    );
    expect(characterMessages.map((message) => ({ sender_character_id: message.sender_character_id, content: message.content }))).toEqual([
      { sender_character_id: characters[0]?.id, content: "我来处理这件事。" },
      { sender_character_id: characters[1]?.id, content: "偏离原消息。" }
    ]);
    expect(JSON.parse(String(characterMessages[0]?.sender_snapshot_json))).toMatchObject({
      avatarUrl: `/api/im/conversations/${group.id}/characters/${characters[0]?.id}/avatar?v=${avatarSha256}`
    });
  });

  it("已排队角色被 AI mention 时只保留一个高优先级回复 turn", async () => {
    let secondCharacterReplies = 0;
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-queued-mention-priority-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const messages = body.messages as Array<{ role: string; content: string }>;
        const prompt = messages.map((message) => message.content).join("\n");
        const characterCard = prompt.match(/<character_card>[\s\S]*?<\/character_card>/u)?.[0] ?? "";
        const isFirstCharacter = characterCard.includes('"name":"甲角色"');
        const judge = messages[0]?.content.includes("只判断当前角色现在是否有必要发送一条新消息");
        if (judge) return completion(prompt.includes("乙已回复") ? '{"score":0}' : isFirstCharacter ? '{"score":100}' : '{"score":90}', false);
        if (isFirstCharacter) {
          const targetId = String(runtime.database.get("SELECT id FROM characters WHERE name = '乙角色'")?.id);
          return completion(`mention://character/${targetId} 请接续。`, body.stream === true);
        }
        secondCharacterReplies += 1;
        return completion("乙已回复", body.stream === true);
      },
      aiRetrySleep: async () => undefined
    });
    const owner = runtime.auth.register({ username: "queued_mention_owner", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const characters = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "排队 Mention 来源" });
      return [
        runtime.store.createCharacter(String(work.id), { name: "甲角色" }),
        runtime.store.createCharacter(String(work.id), { name: "乙角色" })
      ];
    });
    runtime.im.updateSettings(owner.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 1
    });
    const group = runtime.im.createGroup(owner, {
      title: "排队 Mention 群",
      characterIds: characters.map((character) => String(character.id)),
      replyMode: "proactive",
      responseThreshold: 50,
      maxAiMessages: 3
    });
    const sent = runtime.im.sendMessage(owner, String(group.id), {
      content: "请依次讨论。",
      requestId: "im-queued-mention-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    const chain = await waitForChain(runtime, String((sent.chain as Record<string, unknown>).id));

    expect(chain).toMatchObject({ status: "quiet", generated_count: 2 });
    expect(secondCharacterReplies).toBe(1);
    expect(runtime.database.get(
      "SELECT COUNT(*) AS count FROM im_chain_turns WHERE chain_id = ? AND kind = 'reply'",
      String(chain.id)
    )).toEqual({ count: 2 });
  });

  it("只剩一个活跃角色的主动群在回答后自然结束", async () => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-single-proactive-character-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const messages = body.messages as Array<{ role: string; content: string }>;
        const judge = messages[0]?.content.includes("只判断当前角色现在是否有必要发送一条新消息");
        return completion(judge ? '{"score":100}' : "我来回答。", body.stream === true);
      },
      aiRetrySleep: async () => undefined
    });
    const owner = runtime.auth.register({ username: "single_proactive_owner", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const character = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "单角色主动群来源" });
      return runtime.store.createCharacter(String(work.id), { name: "独行者" });
    });
    runtime.im.updateSettings(owner.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 1
    });
    const group = runtime.im.createGroup(owner, {
      title: "单角色主动群",
      characterIds: [String(character.id)],
      replyMode: "proactive",
      responseThreshold: 60,
      maxAiMessages: 5
    });
    const sent = runtime.im.sendMessage(owner, String(group.id), {
      content: "你怎么看？",
      requestId: "im-single-proactive-character-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    const chain = await waitForChain(runtime, String((sent.chain as Record<string, unknown>).id));

    expect(chain).toMatchObject({ status: "quiet", generated_count: 1, error_code: null });
    expect(runtime.database.get(
      "SELECT sender_character_id, content FROM im_messages WHERE chain_id = ? AND sender_kind = 'character'",
      String(chain.id)
    )).toEqual({ sender_character_id: character.id, content: "我来回答。" });
  });

  it("judge 语义无效时按失败次数重试主模型并切换 fallback", async () => {
    let primaryJudgeCalls = 0;
    let fallbackJudgeCalls = 0;
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-invalid-judge-score-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const messages = body.messages as Array<{ role: string; content: string }>;
        const judge = messages[0]?.content.includes("只判断当前角色现在是否有必要发送一条新消息");
        if (!judge) return completion("语义校验后的正常回复。", body.stream === true);
        if (body.model === "primary-model") {
          primaryJudgeCalls += 1;
          return completion("不是合法分数", false);
        }
        fallbackJudgeCalls += 1;
        return completion('{"score":100}', false);
      },
      aiRetrySleep: async () => undefined
    });
    const owner = runtime.auth.register({ username: "invalid_judge_owner", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const character = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "无效判断来源" });
      return runtime.store.createCharacter(String(work.id), { name: "判断角色" });
    });
    runtime.im.updateSettings(owner.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 3
    });
    const group = runtime.im.createGroup(owner, {
      title: "无效判断群",
      characterIds: [String(character.id)],
      replyMode: "proactive",
      responseThreshold: 60,
      maxAiMessages: 5
    });
    const sent = runtime.im.sendMessage(owner, String(group.id), {
      content: "请判断是否回答。",
      requestId: "im-invalid-judge-score-0001"
    });
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const unsubscribe = runtime.imOrchestrator.subscribe(owner.userId, (event) => events.push({ type: event.type, payload: event.payload }));
    runtime.imOrchestrator.publishMessageResult(sent);
    const chain = await waitForChain(runtime, String((sent.chain as Record<string, unknown>).id));
    unsubscribe();

    expect(chain).toMatchObject({ status: "quiet", generated_count: 1 });
    expect(primaryJudgeCalls).toBe(3);
    expect(fallbackJudgeCalls).toBe(1);
    const judgeTurn = runtime.database.get(
      "SELECT model_stage, attempt_count, ai_call_ids_json FROM im_chain_turns WHERE chain_id = ? AND kind = 'judge'",
      String(chain.id)
    );
    expect(judgeTurn).toMatchObject({ model_stage: "fallback", attempt_count: 4 });
    expect(JSON.parse(String(judgeTurn?.ai_call_ids_json))).toHaveLength(4);
    expect(events.filter((event) => event.type === "reset")).toEqual([]);
  });

  it("judge 传输与语义混合失败共享每模型总尝试预算", async () => {
    let primaryJudgeCalls = 0;
    let fallbackJudgeCalls = 0;
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-judge-shared-budget-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const messages = body.messages as Array<{ role: string; content: string }>;
        const judge = messages[0]?.content.includes("只判断当前角色现在是否有必要发送一条新消息");
        if (!judge) return completion("共享预算后的回复。", body.stream === true);
        if (body.model === "primary-model") {
          primaryJudgeCalls += 1;
          return primaryJudgeCalls === 1
            ? new Response("temporary", { status: 500 })
            : completion("无效分数", false);
        }
        fallbackJudgeCalls += 1;
        return completion('{"score":100}', false);
      },
      aiRetrySleep: async () => undefined
    });
    const owner = runtime.auth.register({ username: "judge_shared_budget_owner", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const character = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "判断共享预算来源" });
      return runtime.store.createCharacter(String(work.id), { name: "判断共享预算角色" });
    });
    runtime.im.updateSettings(owner.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 3
    });
    const group = runtime.im.createGroup(owner, {
      title: "判断共享预算群",
      characterIds: [String(character.id)],
      replyMode: "proactive",
      responseThreshold: 60,
      maxAiMessages: 1
    });
    const sent = runtime.im.sendMessage(owner, String(group.id), {
      content: "验证共享失败预算。",
      requestId: "im-judge-shared-budget-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    const chain = await waitForChain(runtime, String((sent.chain as Record<string, unknown>).id));

    expect(chain.generated_count).toBe(1);
    expect(primaryJudgeCalls).toBe(3);
    expect(fallbackJudgeCalls).toBe(1);
  });

  it("主动模式中的 mention 角色优先回复且完全跳过自身发言判断", async () => {
    const requestPrompts: string[] = [];
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-proactive-mention-priority-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const messages = body.messages as Array<{ role: string; content: string }>;
        const prompt = messages.map((message) => message.content).join("\n");
        requestPrompts.push(prompt);
        const judge = messages[0]?.content.includes("只判断当前角色现在是否有必要发送一条新消息");
        return completion(judge ? '{"score":0}' : "我被点名了，马上处理。", body.stream === true);
      },
      aiRetrySleep: async () => undefined
    });
    const owner = runtime.auth.register({ username: "proactive_mention_owner", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const characters = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "Mention 优先级来源" });
      return [
        runtime.store.createCharacter(String(work.id), { name: "程霁" }),
        runtime.store.createCharacter(String(work.id), { name: "陆川" })
      ];
    });
    runtime.im.updateSettings(owner.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 1
    });
    const group = runtime.im.createGroup(owner, {
      title: "主动 Mention 群",
      characterIds: characters.map((character) => String(character.id)),
      replyMode: "proactive",
      responseThreshold: 100,
      maxAiMessages: 3
    });
    const sent = runtime.im.sendMessage(owner, String(group.id), {
      content: `mention://character/${characters[1]?.id} 请立刻确认。`,
      requestId: "im-proactive-mention-priority-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    const chainId = String((sent.chain as Record<string, unknown>).id);
    const chain = await waitForChain(runtime, chainId);

    expect(chain).toMatchObject({ status: "quiet", generated_count: 1 });
    expect(runtime.database.all(
      `SELECT membership.character_id, turn.kind, turn.status FROM im_chain_turns turn
       JOIN im_character_memberships membership ON membership.id = turn.character_membership_id
       WHERE turn.chain_id = ? ORDER BY turn.rowid`,
      chainId
    )).toEqual([
      { character_id: characters[1]?.id, kind: "reply", status: "completed" },
      { character_id: characters[0]?.id, kind: "judge", status: "completed" }
    ]);
    expect(runtime.database.get(
      `SELECT COUNT(*) AS count FROM im_chain_turns turn
       JOIN im_character_memberships membership ON membership.id = turn.character_membership_id
       WHERE turn.chain_id = ? AND turn.kind = 'judge' AND membership.character_id = ?`,
      chainId,
      String(characters[1]?.id)
    )).toEqual({ count: 0 });
    expect(requestPrompts[0]).toContain(`mention://character/${characters[1]?.id}`);
    expect(requestPrompts[0]).toContain("mention://user/{用户ID}");
    expect(requestPrompts[0]).toContain("无论群聊处于 Mention 模式还是主动交流模式");
    expect(requestPrompts[0]).not.toContain("只判断当前角色现在是否有必要发送一条新消息");
  });

  it("运行中的 AI mention 插到普通队列最前但仍受绝对链路上限约束", async () => {
    let firstCharacterId = "";
    let secondCharacterId = "";
    let queuedCharacterId = "";
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-runtime-mention-priority-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const messages = body.messages as Array<{ role: string; content: string }>;
        const system = messages[0]?.content ?? "";
        const judge = system.includes("只判断当前角色现在是否有必要发送一条新消息");
        const positions = ["先发角色", "被提及角色", "普通排队角色"].map((name) => ({ name, index: system.indexOf(name) }));
        const current = positions.sort((left, right) => left.index - right.index)[0]?.name;
        if (judge) return completion(current === "先发角色" ? '{"score":100}' : current === "普通排队角色" ? '{"score":90}' : '{"score":0}', false);
        return completion(current === "先发角色"
          ? `请你回应，mention://character/${secondCharacterId}`
          : current === "被提及角色" ? "我已收到点名并回应。" : "普通队列回复。", body.stream === true);
      },
      aiRetrySleep: async () => undefined
    });
    const owner = runtime.auth.register({ username: "runtime_mention_owner", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const characters = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "运行中 Mention 来源" });
      return [
        runtime.store.createCharacter(String(work.id), { name: "先发角色" }),
        runtime.store.createCharacter(String(work.id), { name: "被提及角色" }),
        runtime.store.createCharacter(String(work.id), { name: "普通排队角色" })
      ];
    });
    firstCharacterId = String(characters[0]?.id);
    secondCharacterId = String(characters[1]?.id);
    queuedCharacterId = String(characters[2]?.id);
    runtime.im.updateSettings(owner.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 1
    });
    const group = runtime.im.createGroup(owner, {
      title: "运行中 Mention 群",
      characterIds: [firstCharacterId, secondCharacterId, queuedCharacterId],
      replyMode: "proactive",
      responseThreshold: 60,
      maxAiMessages: 2
    });
    const sent = runtime.im.sendMessage(owner, String(group.id), {
      content: "谁先说？",
      requestId: "im-runtime-mention-priority-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    const chainId = String((sent.chain as Record<string, unknown>).id);
    const chain = await waitForChain(runtime, chainId);

    expect(chain).toMatchObject({ status: "limit", generated_count: 2 });
    expect(runtime.database.all(
      "SELECT sender_character_id, content FROM im_messages WHERE chain_id = ? AND sender_kind = 'character' ORDER BY sequence",
      chainId
    )).toEqual([
      { sender_character_id: firstCharacterId, content: `请你回应，mention://character/${secondCharacterId}` },
      { sender_character_id: secondCharacterId, content: "我已收到点名并回应。" }
    ]);
    expect(runtime.database.get(
      `SELECT COUNT(*) AS count FROM im_chain_turns turn
       JOIN im_character_memberships membership ON membership.id = turn.character_membership_id
       WHERE turn.chain_id = ? AND turn.kind = 'judge' AND membership.character_id = ?`,
      chainId,
      secondCharacterId
    )).toEqual({ count: 1 });
    expect(runtime.database.get(
      `SELECT turn.status FROM im_chain_turns turn
       JOIN im_character_memberships membership ON membership.id = turn.character_membership_id
       WHERE turn.chain_id = ? AND turn.kind = 'reply' AND membership.character_id = ?`,
      chainId,
      queuedCharacterId
    )).toEqual({ status: "skipped" });
  });

  it("允许 AI 互相 mention 并使用最初人类发起人的模型归属", async () => {
    let firstCharacterId = "";
    let secondCharacterId = "";
    const requestBodies: Record<string, unknown>[] = [];
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-mutual-mention-test-master-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        requestBodies.push(body);
        const messages = body.messages as Array<{ role: string; content: string }>;
        const system = messages[0]?.content ?? "";
        const firstSpeaker = system.indexOf("林舟") < system.indexOf("顾遥");
        return completion(firstSpeaker
          ? `航线交给你复核，mention://character/${secondCharacterId}`
          : "复核完成，星图没有异常。", body.stream === true);
      },
      aiRetrySleep: async () => undefined
    });
    const workOwner = runtime.auth.register({ username: "source_owner", password: "secure-password-123" }).session.user;
    const groupOwner = runtime.auth.register({ username: "group_owner", password: "secure-password-123" }).session.user;
    const member = runtime.auth.register({ username: "trigger_member", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const seeded = runWithRequestActor(actor(workOwner), () => {
      const work = runtime.store.createWork({ title: "共享角色来源" });
      const first = runtime.store.createCharacter(String(work.id), {
        name: "林舟",
        attributes: { privateSecret: "PRIVATE_SOURCE_WORK_SECRET" }
      });
      const second = runtime.store.createCharacter(String(work.id), { name: "顾遥" });
      runtime.store.createRoleplayMemory(String(first.id), { category: "knowledge", content: "PRIVATE_ROLEPLAY_MEMORY_SECRET" });
      runtime.auth.addMember(String(work.id), groupOwner.userId, { role: "editor" }, workOwner.userId);
      return { work, first, second };
    });
    firstCharacterId = String(seeded.first.id);
    secondCharacterId = String(seeded.second.id);
    runtime.im.updateSettings(member.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 1
    });
    const group = runtime.im.createGroup(groupOwner, {
      title: "跨权限联络群",
      characterIds: [firstCharacterId, secondCharacterId],
      humanUserIds: [member.userId],
      replyMode: "mention",
      maxAiMessages: 5
    });
    const sent = runtime.im.sendMessage(member, String(group.id), {
      content: `mention://character/${firstCharacterId} 请开始复核。`,
      requestId: "im-mutual-mention-request-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    const chainId = String((sent.chain as Record<string, unknown>).id);
    const chain = await waitForChain(runtime, chainId);

    expect(chain).toMatchObject({ status: "completed", generated_count: 2, initiator_user_id: member.userId, authorization_user_id: groupOwner.userId });
    expect(runtime.database.all(
      "SELECT sender_character_id, content FROM im_messages WHERE conversation_id = ? AND sender_kind = 'character' ORDER BY sequence",
      String(group.id)
    )).toEqual([
      { sender_character_id: firstCharacterId, content: `航线交给你复核，mention://character/${secondCharacterId}` },
      { sender_character_id: secondCharacterId, content: "复核完成，星图没有异常。" }
    ]);
    expect(runtime.database.all(
      "SELECT DISTINCT created_by_user_id, work_id FROM ai_calls ORDER BY work_id",
    )).toEqual([{ created_by_user_id: member.userId, work_id: String(seeded.work.id) }]);
    expect(runtime.auth.workRole(member, String(seeded.work.id))).toBeNull();
    expect(JSON.stringify(requestBodies)).not.toContain("PRIVATE_SOURCE_WORK_SECRET");
    expect(JSON.stringify(requestBodies)).not.toContain("PRIVATE_ROLEPLAY_MEMORY_SECRET");
    expect(JSON.stringify(requestBodies)).not.toContain("recall_story");
    expect(JSON.stringify(requestBodies)).toContain("群主邀请角色时冻结的公开角色资料");
    runtime.auth.addMember(String(seeded.work.id), member.userId, {
      permissions: {
        prose: "none",
        drafts: "none",
        settings: "none",
        characters: "none",
        races: "none",
        organizations: "none",
        timeline: "none",
        relationships: "none",
        outlines: "none",
        comments: "none",
        todos: "none",
        reviews: "none",
        "ai-chat": "read",
        "ai-analysis": "none",
        "ai-settings": "none"
      }
    }, workOwner.userId);
    const secondRequestStart = requestBodies.length;
    const secondSent = runtime.im.sendMessage(member, String(group.id), {
      content: `mention://character/${firstCharacterId} 再次复核。`,
      requestId: "im-mutual-mention-request-0002"
    });
    runtime.imOrchestrator.publishMessageResult(secondSent);
    await waitForChain(runtime, String((secondSent.chain as Record<string, unknown>).id));
    const secondRequestBodies = requestBodies.slice(secondRequestStart);
    expect(JSON.stringify(secondRequestBodies)).not.toContain("PRIVATE_ROLEPLAY_MEMORY_SECRET");
    expect(JSON.stringify(secondRequestBodies)).not.toContain("recall_roleplay_memory");
    expect(JSON.stringify(secondRequestBodies)).toContain("群主邀请角色时冻结的公开角色资料");
  });

  it("Mention 模式为最初同时被提及的角色保留各自已送达的触发消息", async () => {
    const requestPrompts: string[] = [];
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-parallel-mention-source-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const messages = body.messages as Array<{ role: string; content: string }>;
        const system = messages[0]?.content ?? "";
        requestPrompts.push(system);
        const firstSpeaker = system.indexOf("并行甲") < system.indexOf("并行乙");
        return completion(firstSpeaker ? "甲已收到。" : "乙也已收到。", body.stream === true);
      },
      aiRetrySleep: async () => undefined
    });
    const owner = runtime.auth.register({ username: "parallel_mention_owner", password: "secure-password-123" }).session.user;
    const models = seedModels(runtime);
    const characters = runWithRequestActor(actor(owner), () => {
      const work = runtime.store.createWork({ title: "并行 Mention 来源" });
      return [
        runtime.store.createCharacter(String(work.id), { name: "并行甲" }),
        runtime.store.createCharacter(String(work.id), { name: "并行乙" })
      ];
    });
    runtime.im.updateSettings(owner.userId, {
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId,
      retryCount: 1
    });
    const group = runtime.im.createGroup(owner, {
      title: "并行 Mention 群",
      characterIds: characters.map((character) => String(character.id)),
      replyMode: "mention",
      maxAiMessages: 4
    });
    const sent = runtime.im.sendMessage(owner, String(group.id), {
      content: `mention://character/${characters[0]?.id} mention://character/${characters[1]?.id} 请分别确认。`,
      requestId: "im-parallel-mention-source-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    const chain = await waitForChain(runtime, String((sent.chain as Record<string, unknown>).id));

    expect(chain).toMatchObject({ status: "completed", generated_count: 2 });
    expect(requestPrompts).toHaveLength(2);
    expect(requestPrompts[1]).toContain(`"currentSender":{"userId":"${owner.userId}"`);
    expect(requestPrompts[1]).not.toContain('"currentSender":{"id":');
    expect(requestPrompts[1]).not.toContain("甲已收到。");
  });
});
