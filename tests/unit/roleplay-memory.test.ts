import { afterEach, describe, expect, it } from "vitest";
import type { Runtime } from "../../src/app.js";
import { runWithRequestActor, type RequestActor } from "../../src/request-context.js";
import { createTestRuntime } from "../helpers.js";

const actorOne: RequestActor = {
  userId: "roleplay-memory-user-one",
  username: "memory_one",
  displayName: "记忆用户一",
  role: "user",
  authentication: "session"
};
const actorTwo: RequestActor = {
  userId: "roleplay-memory-user-two",
  username: "memory_two",
  displayName: "记忆用户二",
  role: "user",
  authentication: "session"
};
const adminActor: RequestActor = { ...actorTwo, role: "admin" };

describe("角色扮演共享记忆存储", () => {
  let runtime: Runtime | null = null;

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
  });

  function createFixture(): { workId: string; characterId: string; otherCharacterId: string } {
    runtime = createTestRuntime();
    runtime.database.run(
      `INSERT INTO users (id, username, normalized_username, display_name, password_hash, password_salt, role, status, created_at, updated_at)
       VALUES (?, 'memory_one', 'memory_one', '记忆用户一', 'disabled', 'disabled', 'user', 'active', '2026-08-27', '2026-08-27'),
              (?, 'memory_two', 'memory_two', '记忆用户二', 'disabled', 'disabled', 'user', 'active', '2026-08-27', '2026-08-27')`,
      actorOne.userId,
      actorTwo.userId
    );
    const work = runtime.store.createWork({ title: "角色扮演共享记忆测试" });
    const workId = String(work.id);
    const character = runtime.store.createCharacter(workId, { name: "林舟" });
    const other = runtime.store.createCharacter(workId, { name: "顾潮" });
    return { workId, characterId: String(character.id), otherCharacterId: String(other.id) };
  }

  function createRoleplayConversation(workId: string, characterId: string, actor: RequestActor): string {
    return runWithRequestActor(actor, () => {
      const conversation = runtime!.store.createAiConversation(workId);
      return String(runtime!.store.setAiConversationRoleplayCharacter(String(conversation.id), characterId).id);
    });
  }

  it("按角色保存唯一共享库并固定非正史约束", () => {
    const { workId, characterId, otherCharacterId } = createFixture();
    const memory = runWithRequestActor(actorOne, () => runtime!.store.createRoleplayMemory(characterId, {
      category: "commitment",
      content: "林舟答应会在天亮前返回港口，并带回旧航海图。",
      importance: "high",
      certainty: "experienced",
      isPinned: true
    }));

    expect(memory).toMatchObject({
      workId,
      characterId,
      origin: "roleplay",
      canonical: false,
      status: "active",
      versionNo: 1,
      sourceType: "manual"
    });
    expect(memory.content).toBe("林舟答应会在天亮前返回港口，并带回旧航海图。");
    expect((runtime!.store.listRoleplayMemories(characterId) as { items: unknown[] }).items).toHaveLength(1);
    expect((runtime!.store.listRoleplayMemories(otherCharacterId) as { items: unknown[] }).items).toEqual([]);
    expect(() => runtime!.store.createRoleplayMemory(characterId, { category: "event", content: String(memory.content) }))
      .toThrowError(expect.objectContaining({ code: "ROLEPLAY_MEMORY_DUPLICATE" }));
    expect(() => runtime!.database.run("UPDATE roleplay_memories SET canonical = 1 WHERE id = ?", String(memory.id))).toThrow();
    expect(() => runtime!.database.run("UPDATE roleplay_memories SET origin = 'story' WHERE id = ?", String(memory.id))).toThrow();
  });

  it("两个用户扮演同一角色时共享 AI 记忆且不同角色隔离", () => {
    const { workId, characterId, otherCharacterId } = createFixture();
    const firstConversationId = createRoleplayConversation(workId, characterId, actorOne);
    const userMessage = runWithRequestActor(actorOne, () => runtime!.store.addAiConversationMessage(firstConversationId, {
      role: "user",
      content: "我把银钥匙交给你。"
    }));
    const assistantMessage = runWithRequestActor(actorOne, () => runtime!.store.addAiConversationMessage(firstConversationId, {
      role: "assistant",
      content: "我接过钥匙，郑重收好。"
    }));
    runWithRequestActor(actorOne, () => runtime!.store.commitRoleplayMemoryCandidates(
      firstConversationId,
      String(assistantMessage.id),
      String(userMessage.id),
      [{ category: "event", content: "用户角色把银钥匙交给了林舟。", importance: "high", certainty: "experienced" }]
    ));

    const secondConversationId = createRoleplayConversation(workId, characterId, actorTwo);
    const secondContext = runWithRequestActor(actorTwo, () => runtime!.store.getAiConversationContext(secondConversationId, workId));
    expect(secondContext.roleplayMemories).toEqual([
      expect.objectContaining({ content: "用户角色把银钥匙交给了林舟。", characterId })
    ]);
    expect(runtime!.store.getRoleplayMemoryPromptItems(workId, otherCharacterId)).toEqual([]);

    const forked = runWithRequestActor(actorOne, () => runtime!.store.forkAiConversation(firstConversationId, String(assistantMessage.id)));
    expect((runtime!.store.listRoleplayMemories(characterId) as { items: unknown[] }).items).toHaveLength(1);
    expect(forked).not.toHaveProperty("roleplayMemoryScope");
    runtime!.store.deleteAiConversation(firstConversationId);
    expect((runtime!.store.listRoleplayMemories(characterId) as { items: unknown[] }).items).toHaveLength(1);
  });

  it("跨用户只返回来源时间与类型，不泄露原消息", () => {
    const { workId, characterId } = createFixture();
    const conversationId = createRoleplayConversation(workId, characterId, actorOne);
    const userMessage = runWithRequestActor(actorOne, () => runtime!.store.addAiConversationMessage(conversationId, { role: "user", content: "私有用户原文" }));
    const assistantMessage = runWithRequestActor(actorOne, () => runtime!.store.addAiConversationMessage(conversationId, { role: "assistant", content: "私有角色回复" }));
    runWithRequestActor(actorOne, () => runtime!.store.commitRoleplayMemoryCandidates(
      conversationId,
      String(assistantMessage.id),
      String(userMessage.id),
      [{ category: "knowledge", content: "林舟知道银钥匙已经交接。", importance: "medium", certainty: "experienced" }]
    ));

    const ownerItem = (runWithRequestActor(actorOne, () => runtime!.store.listRoleplayMemories(characterId)) as { items: Array<Record<string, unknown>> }).items[0]!;
    expect(ownerItem.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ canOpen: true, restricted: false, evidence: "私有用户原文", sourceType: "ai" })
    ]));
    const otherItem = (runWithRequestActor(actorTwo, () => runtime!.store.listRoleplayMemories(characterId)) as { items: Array<Record<string, unknown>> }).items[0]!;
    expect(otherItem.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ canOpen: false, restricted: true, evidence: null, conversationId: null, messageId: null, sourceType: "ai" })
    ]));
    expect(JSON.stringify(otherItem)).not.toContain("私有用户原文");
    const adminItem = (runWithRequestActor(adminActor, () => runtime!.store.listRoleplayMemories(characterId)) as { items: Array<Record<string, unknown>> }).items[0]!;
    expect(adminItem.sources).toEqual(expect.arrayContaining([expect.objectContaining({ canOpen: true, evidence: "私有用户原文" })]));
  });

  it("支持搜索、版本冲突、删除与恢复", () => {
    const { characterId } = createFixture();
    const memory = runWithRequestActor(actorOne, () => runtime!.store.createRoleplayMemory(characterId, {
      category: "knowledge",
      content: "林舟从旧航海图得知白塔下有密道。"
    }));
    expect((runtime!.store.listRoleplayMemories(characterId, { query: "白塔下有" }) as { items: unknown[] }).items).toHaveLength(1);
    const updated = runWithRequestActor(actorOne, () => runtime!.store.updateRoleplayMemory(String(memory.id), {
      expectedVersion: 1,
      content: "林舟从旧航海图确认白塔下有密道。",
      isPinned: true
    }));
    expect(updated).toMatchObject({ versionNo: 2, isPinned: true });
    expect(() => runtime!.store.updateRoleplayMemory(String(memory.id), { expectedVersion: 1, content: "过期更新" }))
      .toThrowError(expect.objectContaining({ code: "ROLEPLAY_MEMORY_VERSION_CONFLICT" }));
    const archived = runWithRequestActor(actorOne, () => runtime!.store.setRoleplayMemoryArchived(String(memory.id), true, 2));
    expect(archived).toMatchObject({ status: "archived", versionNo: 3 });
    expect((runtime!.store.listRoleplayMemories(characterId) as { items: unknown[] }).items).toEqual([]);
    const restored = runWithRequestActor(actorOne, () => runtime!.store.setRoleplayMemoryArchived(String(memory.id), false, 3));
    expect(restored).toMatchObject({ status: "active", versionNo: 4 });
    expect(runtime!.database.get("SELECT COUNT(*) AS count FROM roleplay_memory_versions WHERE memory_id = ?", String(memory.id))).toEqual({ count: 4 });
  });

  it("角色合并迁移共享记忆并按内容哈希去重", () => {
    const { workId, characterId: targetId, otherCharacterId: sourceId } = createFixture();
    runtime!.store.createRoleplayMemory(targetId, { category: "event", content: "两边重复的记忆。", isPinned: true });
    runtime!.store.createRoleplayMemory(sourceId, { category: "event", content: "两边重复的记忆。" });
    runtime!.store.createRoleplayMemory(sourceId, { category: "scene", content: "只属于来源角色的记忆。" });

    const merged = runtime!.store.mergeCharacters({
      reviewId: null,
      targetCharacterId: targetId,
      sourceCharacterId: sourceId,
      expectedTargetVersionNo: 1,
      expectedSourceVersionNo: 1
    });
    expect(merged.roleplayMemoryMerge).toEqual({ migrated: 1, deduplicated: 1 });
    expect(runtime!.database.all(
      "SELECT character_id, content FROM roleplay_memories WHERE work_id = ? ORDER BY content",
      workId
    )).toEqual([
      { character_id: targetId, content: "两边重复的记忆。" },
      { character_id: targetId, content: "只属于来源角色的记忆。" }
    ]);
    expect(runtime!.database.get("SELECT COUNT(*) AS count FROM roleplay_memory_versions")).toEqual({ count: 4 });
  });

  it("角色删除时级联删除该角色的共享记忆", () => {
    const { characterId, otherCharacterId } = createFixture();
    runtime!.store.createRoleplayMemory(characterId, { category: "event", content: "随角色删除的记忆。" });
    runtime!.store.createRoleplayMemory(otherCharacterId, { category: "event", content: "另一个角色保留的记忆。" });
    runtime!.store.deleteCharacter(characterId, 1);
    expect(runtime!.database.get("SELECT COUNT(*) AS count FROM roleplay_memories WHERE character_id = ?", characterId)).toEqual({ count: 0 });
    expect(runtime!.database.get("SELECT COUNT(*) AS count FROM roleplay_memories WHERE character_id = ?", otherCharacterId)).toEqual({ count: 1 });
  });

  it("角色记忆迁移失败时完整回滚角色合并", () => {
    const { characterId: targetId, otherCharacterId: sourceId } = createFixture();
    runtime!.store.createRoleplayMemory(sourceId, { category: "event", content: "触发回滚的记忆。" });
    runtime!.database.raw.exec(`CREATE TRIGGER reject_roleplay_memory_merge BEFORE UPDATE OF character_id ON roleplay_memories
      WHEN NEW.character_id = '${targetId}' BEGIN SELECT RAISE(ABORT, 'reject roleplay memory merge'); END`);

    expect(() => runtime!.store.mergeCharacters({
      reviewId: null,
      targetCharacterId: targetId,
      sourceCharacterId: sourceId,
      expectedTargetVersionNo: 1,
      expectedSourceVersionNo: 1
    })).toThrow("reject roleplay memory merge");
    expect(runtime!.store.getCharacter(sourceId).mergedIntoCharacterId).toBeNull();
    expect(runtime!.database.get("SELECT character_id FROM roleplay_memories WHERE content = '触发回滚的记忆。'")).toEqual({ character_id: sourceId });
    expect(runtime!.database.get("SELECT COUNT(*) AS count FROM character_merges")).toEqual({ count: 0 });
  });
});
