import { afterEach, describe, expect, it } from "vitest";
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
    runtime.im.addCharacter(owner, String(group.id), String(secondCharacter.id));
    expect(runtime.database.get("SELECT context_epoch FROM im_conversations WHERE id = ?", String(group.id))).toEqual({ context_epoch: 2 });
    expect(() => runtime.im.retryChain(owner, String(group.id), topologyChainId))
      .toThrowError("群成员或上下文已经变化，不能重试旧上下文中的交流链");
    runtime.im.removeCharacter(owner, String(group.id), String(secondCharacter.id));
    expect(runtime.database.get("SELECT context_epoch FROM im_conversations WHERE id = ?", String(group.id))).toEqual({ context_epoch: 3 });
    runtime.im.leaveGroup(member, String(group.id));
    expect(runtime.database.get("SELECT context_epoch FROM im_conversations WHERE id = ?", String(group.id))).toEqual({ context_epoch: 4 });
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
    const deltaDeadline = Date.now() + 2_000;
    while (!initialEvents.some((event) => event.type === "delta") && Date.now() < deltaDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(initialEvents.some((event) => event.type === "delta")).toBe(true);
    expect(runtime.imOrchestrator.streamingReplySnapshots(String(direct.id))).toEqual([
      expect.objectContaining({ status: "running", content: "前半" })
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
      expect.objectContaining({ type: "turn", payload: expect.objectContaining({ status: "running", content: "前半" }) })
    ]);
    expect(releaseStream).not.toBeNull();
    releaseStream!();
    const chain = await waitForChain(runtime, String((sent.chain as Record<string, unknown>).id));
    unsubscribeReplay();

    expect(chain.status).toBe("completed");
    expect(runtime.database.get(
      "SELECT content FROM im_messages WHERE chain_id = ? AND sender_kind = 'character'",
      String(chain.id)
    )).toEqual({ content: "前半后半" });
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
      return runtime.store.createCharacter(String(work.id), { name: "压缩角色" });
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
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-empty-compaction-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const messages = body.messages as Array<{ role: string; content: string }>;
        const compact = messages.some((message) => message.content.includes("只把已送达给当前角色的 IM 历史压缩"));
        return completion(compact ? " \n " : "压缩失败后仍正常回复。", body.stream === true);
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
      retryCount: 1
    });
    const group = runtime.im.createGroup(owner, {
      title: "空白压缩群",
      characterIds: [String(character.id)],
      replyMode: "mention",
      maxAiMessages: 1
    });
    for (let index = 1; index <= 61; index += 1) {
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

  it("拒绝超过消息存储上限的角色回复并保留明确错误", async () => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-reply-length-limit-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
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
      retryCount: 1
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
    expect(runtime.database.get(
      "SELECT failure FROM im_chain_turns WHERE chain_id = ? AND kind = 'reply'",
      chainId
    )).toEqual({ failure: expect.stringContaining("IM_AI_REPLY_TOO_LONG") });
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
    const sent = runtime.im.sendMessage(owner, String(group.id), {
      content: "谁来安排今天的航线？",
      requestId: "im-proactive-request-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    const chainId = String((sent.chain as Record<string, unknown>).id);
    const chain = await waitForChain(runtime, chainId);
    expect(chain).toMatchObject({ status: "limit", generated_count: 2 });
    expect(requestPrompts.length).toBeGreaterThanOrEqual(4);
    expect(requestPrompts.every((prompt) => prompt.includes("[1] 旁白：远方的风暴正在逼近，甲板开始剧烈摇晃。"))).toBe(true);
    expect(replyPrompts).toHaveLength(2);
    expect(replyPrompts.every((prompt) => prompt.includes("谁来安排今天的航线？"))).toBe(true);
    expect(replyPrompts.every((prompt) => !prompt.includes("林舟：我来处理这件事。"))).toBe(true);
    expect(runtime.database.all(
      `SELECT membership.character_id, turn.score, turn.selected FROM im_chain_turns turn
       JOIN im_character_memberships membership ON membership.id = turn.character_membership_id
       WHERE turn.chain_id = ? AND turn.kind = 'judge' ORDER BY turn.score DESC`,
      chainId
    )).toEqual([
      { character_id: characters[0]?.id, score: 85, selected: 1 },
      { character_id: characters[1]?.id, score: 75, selected: 1 }
    ]);
    const characterMessages = runtime.database.all(
      "SELECT sender_character_id, sender_snapshot_json, content FROM im_messages WHERE conversation_id = ? AND sender_kind = 'character' ORDER BY sequence",
      String(group.id)
    );
    expect(characterMessages.map((message) => ({ sender_character_id: message.sender_character_id, content: message.content }))).toEqual([
      { sender_character_id: characters[0]?.id, content: "我来处理这件事。" },
      { sender_character_id: characters[1]?.id, content: "我来处理这件事。" }
    ]);
    expect(JSON.parse(String(characterMessages[0]?.sender_snapshot_json))).toMatchObject({
      avatarUrl: `/api/im/conversations/${group.id}/characters/${characters[0]?.id}/avatar?v=${avatarSha256}`
    });
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
});
