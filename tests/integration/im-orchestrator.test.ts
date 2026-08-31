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

  it("主模型重试耗尽后整条链粘在 fallback 并持久化完整回复", async () => {
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
    const events: string[] = [];
    const unsubscribe = runtime.imOrchestrator.subscribe(owner.userId, (event) => events.push(event.type));
    const sent = runtime.im.sendMessage(owner, String(direct.id), {
      content: "准备出发。",
      requestId: "im-orchestrator-request-0001"
    });
    runtime.imOrchestrator.publishMessageResult(sent);
    const chainId = String((sent.chain as Record<string, unknown>).id);
    const chain = await waitForChain(runtime, chainId);
    unsubscribe();

    expect(chain).toMatchObject({ status: "completed", model_stage: "fallback", generated_count: 1 });
    expect(primaryCalls).toBe(4);
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
      primaryAttemptCount: 4,
      fallbackAttemptCount: 1,
      attemptCount: 5
    });
    expect(events).toEqual(expect.arrayContaining(["chain", "reset", "delta", "message"]));
    const systemPrompt = bodies.find((body) => body.model === "fallback-model")?.messages as Array<{ role: string; content: string }>;
    expect(systemPrompt[0]?.content).toContain("<im_roleplay_rules>");
    expect(systemPrompt[0]?.content).toContain("舰长");
    expect(systemPrompt[0]?.content).not.toContain("remember_roleplay");
    expect(runtime.database.get(
      "SELECT created_by_user_id FROM ai_calls WHERE id = ?",
      JSON.parse(String(messages[1]?.metadata_json)).callId
    )).toEqual({ created_by_user_id: owner.userId });
    expect(String(work.id)).toBeTruthy();
  });

  it("主动模式让各角色独立打分并只选择最高分角色", async () => {
    const requestPrompts: string[] = [];
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
        if (judge) return completion(system.indexOf("林舟") < system.indexOf("顾遥") ? '{"score":85}' : '{"score":30}', false);
        return completion("我来处理这件事。", body.stream === true);
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
      maxAiMessages: 1
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
    expect(chain).toMatchObject({ status: "limit", generated_count: 1 });
    expect(requestPrompts.length).toBeGreaterThanOrEqual(3);
    expect(requestPrompts.every((prompt) => prompt.includes("[1] 旁白：远方的风暴正在逼近，甲板开始剧烈摇晃。"))).toBe(true);
    expect(runtime.database.all(
      `SELECT membership.character_id, turn.score, turn.selected FROM im_chain_turns turn
       JOIN im_character_memberships membership ON membership.id = turn.character_membership_id
       WHERE turn.chain_id = ? AND turn.kind = 'judge' ORDER BY turn.score DESC`,
      chainId
    )).toEqual([
      { character_id: characters[0]?.id, score: 85, selected: 1 },
      { character_id: characters[1]?.id, score: 30, selected: 0 }
    ]);
    expect(runtime.database.get(
      "SELECT sender_character_id, content FROM im_messages WHERE conversation_id = ? AND sender_kind = 'character'",
      String(group.id)
    )).toEqual({ sender_character_id: characters[0]?.id, content: "我来处理这件事。" });
  });

  it("允许 AI 互相 mention 并使用最初人类发起人的模型归属", async () => {
    let firstCharacterId = "";
    let secondCharacterId = "";
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-mutual-mention-test-master-secret-with-enough-length",
      serveUi: false,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
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
      const first = runtime.store.createCharacter(String(work.id), { name: "林舟" });
      const second = runtime.store.createCharacter(String(work.id), { name: "顾遥" });
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
  });
});
