import { afterEach, describe, expect, it } from "vitest";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime } from "../helpers.js";

describe("角色扮演记忆存储", () => {
  let runtime: Runtime | null = null;

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
  });

  function createRoleplayConversation(): { workId: string; conversationId: string } {
    runtime = createTestRuntime();
    const work = runtime.store.createWork({ title: "角色扮演记忆测试" });
    const workId = String(work.id);
    const character = runtime.store.createCharacter(workId, { name: "林舟" });
    const conversation = runtime.store.createAiConversation(workId);
    const updated = runtime.store.setAiConversationRoleplayCharacter(String(conversation.id), String(character.id));
    return { workId, conversationId: String(updated.id) };
  }

  it("建立独立记忆线并固定非正史数据库约束", () => {
    const { conversationId } = createRoleplayConversation();
    const conversation = runtime!.store.getAiConversationSummary(conversationId);
    expect(conversation.roleplayMemoryScope).toMatchObject({
      title: "林舟 · 新记忆线",
      revisionNo: 0,
      activeMemoryCount: 0,
      roleplayCharacter: { name: "林舟" }
    });

    const memory = runtime!.store.createRoleplayMemory(conversationId, {
      category: "commitment",
      content: "林舟答应会在天亮前返回港口。",
      importance: "high",
      certainty: "experienced",
      isPinned: true
    });
    expect(memory).toMatchObject({
      origin: "roleplay",
      canonical: false,
      status: "active",
      versionNo: 1,
      createdRevision: 1,
      sourceType: "manual"
    });
    expect(() => runtime!.database.run(
      "UPDATE roleplay_memories SET canonical = 1 WHERE id = ?",
      String(memory.id)
    )).toThrow();
    expect(() => runtime!.database.run(
      "UPDATE roleplay_memories SET origin = 'story' WHERE id = ?",
      String(memory.id)
    )).toThrow();
    expect(runtime!.database.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(runtime!.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("只在成功回复后幂等提交 AI 候选并保留来源快照", () => {
    const { conversationId } = createRoleplayConversation();
    const userMessage = runtime!.store.addAiConversationMessage(conversationId, { role: "user", content: "我把银钥匙交给你。" });
    const assistantMessage = runtime!.store.addAiConversationMessage(conversationId, { role: "assistant", content: "我接过钥匙，郑重收好。" });
    const candidates = [{
      category: "event" as const,
      content: "用户角色把银钥匙交给了林舟。",
      importance: "high" as const,
      certainty: "experienced" as const
    }];

    const first = runtime!.store.commitRoleplayMemoryCandidates(
      conversationId,
      String(assistantMessage.id),
      String(userMessage.id),
      candidates
    );
    const repeated = runtime!.store.commitRoleplayMemoryCandidates(
      conversationId,
      String(assistantMessage.id),
      String(userMessage.id),
      candidates
    );

    expect(first).toHaveLength(1);
    expect(repeated).toEqual([]);
    expect(runtime!.database.get("SELECT COUNT(*) AS count FROM roleplay_memories")).toEqual({ count: 1 });
    expect(runtime!.database.get("SELECT roleplay_memory_revision FROM ai_conversation_messages WHERE id = ?", String(assistantMessage.id))).toEqual({
      roleplay_memory_revision: 1
    });
    expect(runtime!.database.all(
      "SELECT message_role, evidence_snapshot FROM roleplay_memory_sources ORDER BY message_role DESC"
    )).toEqual([
      { message_role: "user", evidence_snapshot: "我把银钥匙交给你。" },
      { message_role: "assistant", evidence_snapshot: "我接过钥匙，郑重收好。" }
    ]);

    runtime!.store.deleteAiConversation(conversationId);
    expect(runtime!.database.get("SELECT COUNT(*) AS count FROM roleplay_memories")).toEqual({ count: 1 });
    expect(runtime!.database.all(
      "SELECT conversation_id, message_id, evidence_snapshot FROM roleplay_memory_sources ORDER BY message_role DESC"
    )).toEqual([
      { conversation_id: null, message_id: null, evidence_snapshot: "我把银钥匙交给你。" },
      { conversation_id: null, message_id: null, evidence_snapshot: "我接过钥匙，郑重收好。" }
    ]);
  });

  it("按消息 revision 克隆分支并隔离后续记忆", () => {
    const { conversationId } = createRoleplayConversation();
    runtime!.store.createRoleplayMemory(conversationId, {
      category: "state",
      content: "林舟仍在北港。"
    });
    const userMessage = runtime!.store.addAiConversationMessage(conversationId, { role: "user", content: "我们离开北港。" });
    const assistantMessage = runtime!.store.addAiConversationMessage(conversationId, { role: "assistant", content: "我随你登船。" });
    runtime!.store.commitRoleplayMemoryCandidates(
      conversationId,
      String(assistantMessage.id),
      String(userMessage.id),
      [{
        category: "state",
        content: "林舟已经随用户角色离开北港。",
        importance: "medium",
        certainty: "experienced",
        supersedesMemoryId: String((runtime!.store.listRoleplayMemories(conversationId) as { items: Array<{ id: string }> }).items[0]?.id)
      }]
    );

    const beforeChange = runtime!.store.forkAiConversation(conversationId, String(userMessage.id), "变化前分支");
    const afterChange = runtime!.store.forkAiConversation(conversationId, String(assistantMessage.id), "变化后分支");
    const beforeItems = (runtime!.store.listRoleplayMemories(String(beforeChange.id)) as { items: Array<{ content: string }> }).items;
    const afterItems = (runtime!.store.listRoleplayMemories(String(afterChange.id)) as { items: Array<{ content: string }> }).items;

    expect(beforeItems.map((memory) => memory.content)).toEqual(["林舟仍在北港。"]);
    expect(afterItems.map((memory) => memory.content)).toEqual(["林舟已经随用户角色离开北港。"]);
    runtime!.store.createRoleplayMemory(String(afterChange.id), { category: "scene", content: "分支进入暴风雨海域。" });
    expect((runtime!.store.listRoleplayMemories(conversationId) as { items: unknown[] }).items).toHaveLength(1);
    expect((runtime!.store.listRoleplayMemories(String(beforeChange.id)) as { items: unknown[] }).items).toHaveLength(1);
  });

  it("支持全文检索、版本冲突、归档与恢复", () => {
    const { conversationId } = createRoleplayConversation();
    const memory = runtime!.store.createRoleplayMemory(conversationId, {
      category: "knowledge",
      content: "林舟从旧航海图得知白塔下有密道。"
    });
    const matched = runtime!.store.listRoleplayMemories(conversationId, { query: "白塔下有" }) as { items: unknown[] };
    expect(matched.items).toHaveLength(1);
    const updated = runtime!.store.updateRoleplayMemory(String(memory.id), {
      expectedVersion: 1,
      content: "林舟从旧航海图确认白塔下有密道。",
      isPinned: true
    });
    expect(updated).toMatchObject({ versionNo: 2, isPinned: true });
    expect(() => runtime!.store.updateRoleplayMemory(String(memory.id), { expectedVersion: 1, content: "过期更新" }))
      .toThrowError(expect.objectContaining({ code: "ROLEPLAY_MEMORY_VERSION_CONFLICT" }));
    const archived = runtime!.store.setRoleplayMemoryArchived(String(memory.id), true, 2);
    expect(archived).toMatchObject({ status: "archived", versionNo: 3 });
    expect((runtime!.store.listRoleplayMemories(conversationId) as { items: unknown[] }).items).toEqual([]);
    const restored = runtime!.store.setRoleplayMemoryArchived(String(memory.id), false, 3);
    expect(restored).toMatchObject({ status: "active", versionNo: 4 });
    expect(runtime!.database.get("SELECT COUNT(*) AS count FROM roleplay_memory_versions WHERE memory_id = ?", String(memory.id))).toEqual({ count: 4 });
  });
});
