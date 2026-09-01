import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";
import { PLATFORM_AI_WORK_ID } from "../../src/database.js";

type RegisteredUser = {
  agent: ReturnType<typeof request.agent>;
  csrfToken: string;
  user: { userId: string; username: string; displayName: string };
};

const setupToken = "im-api-test-setup-token-with-at-least-32-characters";

async function register(runtime: Runtime, username: string): Promise<RegisteredUser> {
  const agent = request.agent(runtime.app);
  const captcha = await request(runtime.app).get("/api/auth/captcha").expect(200);
  const response = await agent.post("/api/auth/register").send({
    username,
    password: "secure-password-123",
    passwordConfirmation: "secure-password-123",
    setupToken,
    captchaId: captcha.body.data.captchaId,
    captchaAnswer: captcha.body.data.answer
  }).expect(201);
  return { agent, csrfToken: response.body.data.csrfToken, user: response.body.data.user };
}

function seedModels(runtime: Runtime): { primaryModelId: string; fallbackModelId: string } {
  const timestamp = "2026-08-31T00:00:00.000Z";
  runtime.database.run(
    `INSERT INTO providers (
       id, work_id, name, base_url, encrypted_key, key_iv, key_tag, key_hint,
       status, connection_status, created_at, updated_at
     ) VALUES ('provider-im', ?, 'IM Provider', 'https://example.test/v1', 'cipher', 'iv', 'tag', 'hint',
       'enabled', 'success', ?, ?)`,
    PLATFORM_AI_WORK_ID,
    timestamp,
    timestamp
  );
  const models: Array<[string, string, string]> = [
    ["model-im-primary", "Primary", "primary-model"],
    ["model-im-fallback", "Fallback", "fallback-model"]
  ];
  for (const [id, displayName, modelId] of models) {
    runtime.database.run(
      `INSERT INTO models (
         id, provider_id, display_name, model_id, model_kind, created_at, updated_at
       ) VALUES (?, 'provider-im', ?, ?, 'chat', ?, ?)`,
      id,
      displayName,
      modelId,
      timestamp,
      timestamp
    );
  }
  return { primaryModelId: "model-im-primary", fallbackModelId: "model-im-fallback" };
}

describe("全局 IM API", () => {
  let runtime: Runtime;

  afterEach(async () => {
    await runtime?.close();
  });

  it("按成员任期隔离群历史并允许群主分享跨书角色", async () => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-api-test-master-secret-with-enough-length",
      serveUi: false,
      revealCaptchaAnswer: true,
      security: { allowRegistration: true, enforceSameOrigin: true, setupToken }
    });
    const admin = await register(runtime, "im_admin");
    const owner = await register(runtime, "im_owner");
    const member = await register(runtime, "im_member");
    const lateMember = await register(runtime, "im_late_member");
    const models = seedModels(runtime);

    await request(runtime.app).get("/api/im/conversations").expect(401);

    const work = await owner.agent.post("/api/works")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "IM 来源作品" })
      .expect(201);
    const character = await owner.agent.post(`/api/works/${work.body.data.id}/characters`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ name: "林舟", attributes: { identity: "北港领航员" }, profile: { summary: "谨慎而可靠" } })
      .expect(201);
    const characterAvatarSha256 = "a".repeat(64);
    runtime.store.setCharacterAvatar(character.body.data.id, {
      mimeType: "image/png",
      byteLength: 128,
      sha256: characterAvatarSha256,
      storageKey: "im-api-character-avatar.png",
      width: 64,
      height: 64
    });
    const favoriteCharacter = await owner.agent.post(`/api/works/${work.body.data.id}/characters`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ name: "收藏角色" })
      .expect(201);
    const pinnedCharacter = await owner.agent.post(`/api/works/${work.body.data.id}/characters`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ name: "置顶角色" })
      .expect(201);
    await owner.agent.patch(`/api/characters/${favoriteCharacter.body.data.id}/favorite`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ isFavorite: true })
      .expect(200);
    await owner.agent.patch(`/api/characters/${pinnedCharacter.body.data.id}/pin`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ isPinned: true })
      .expect(200);

    const imWorks = await owner.agent.get("/api/im/works").expect(200);
    expect(imWorks.body.data).toEqual([
      expect.objectContaining({ id: work.body.data.id, title: "IM 来源作品", characterCount: 3 })
    ]);
    const imCharacters = await owner.agent.get(`/api/im/characters?workId=${work.body.data.id}`).expect(200);
    expect(imCharacters.body.data.slice(0, 2)).toEqual([
      expect.objectContaining({ id: pinnedCharacter.body.data.id, isPinned: true }),
      expect.objectContaining({ id: favoriteCharacter.body.data.id, isFavorite: true })
    ]);
    const searchedCharacters = await owner.agent.get(`/api/im/characters?workId=${work.body.data.id}&q=${encodeURIComponent("林舟")}`).expect(200);
    expect(searchedCharacters.body.data).toEqual([
      expect.objectContaining({
        id: character.body.data.id,
        name: "林舟",
        avatarUrl: `/api/characters/${character.body.data.id}/avatar?v=${characterAvatarSha256}`
      })
    ]);

    const settings = await owner.agent.patch("/api/im/settings")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({
        preferredName: "舰长",
        pronouns: "她",
        identitySummary: "远航队指挥官",
        additionalNotes: "偏好直接沟通",
        primaryModelId: models.primaryModelId,
        fallbackModelId: models.fallbackModelId,
        retryCount: 3
      })
      .expect(200);
    expect(settings.body.data).toMatchObject({ configured: true, preferredName: "舰长", retryCount: 3 });
    await owner.agent.patch("/api/im/settings")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ primaryModelId: models.primaryModelId, fallbackModelId: models.primaryModelId })
      .expect(400);

    const direct = await owner.agent.post("/api/im/conversations/direct")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ characterId: character.body.data.id })
      .expect(201);
    expect(direct.body.data.avatarCharacters).toEqual([
      expect.objectContaining({
        characterId: character.body.data.id,
        name: "林舟",
        avatarUrl: `/api/im/conversations/${direct.body.data.id}/characters/${character.body.data.id}/avatar?v=${characterAvatarSha256}`
      })
    ]);
    const duplicateDirect = await owner.agent.post("/api/im/conversations/direct")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ characterId: character.body.data.id })
      .expect(201);
    expect(duplicateDirect.body.data.id).toBe(direct.body.data.id);

    const group = await owner.agent.post("/api/im/conversations/group")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({
        title: "远航群",
        characterIds: [character.body.data.id],
        humanUserIds: [member.user.userId],
        replyMode: "mention",
        responseThreshold: 60,
        maxAiMessages: 20
      })
      .expect(201);
    const groupId = group.body.data.id;
    expect(group.body.data.avatarCharacters).toEqual([
      expect.objectContaining({
        characterId: character.body.data.id,
        avatarUrl: `/api/im/conversations/${groupId}/characters/${character.body.data.id}/avatar?v=${characterAvatarSha256}`
      })
    ]);
    expect(group.body.data.avatarMembers).toHaveLength(3);
    expect(group.body.data.avatarMembers).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "character", participantId: character.body.data.id }),
      expect.objectContaining({ kind: "user", participantId: owner.user.userId }),
      expect.objectContaining({ kind: "user", participantId: member.user.userId })
    ]));
    expect(group.body.data.participants.characters[0]).toMatchObject({
      characterId: character.body.data.id,
      avatarUrl: `/api/im/conversations/${groupId}/characters/${character.body.data.id}/avatar?v=${characterAvatarSha256}`
    });

    await member.agent.post(`/api/im/conversations/${groupId}/announcements`)
      .set("X-CSRF-Token", member.csrfToken)
      .send({ content: "海面升起了白雾。", requestId: "im-announcement-request-denied" })
      .expect(403);
    await owner.agent.post(`/api/im/conversations/${direct.body.data.id}/announcements`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ content: "单聊旁白。", requestId: "im-announcement-request-direct" })
      .expect(400);
    const announcement = await owner.agent.post(`/api/im/conversations/${groupId}/announcements`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ content: "海面升起了白雾。", requestId: "im-announcement-request-0001" })
      .expect(201);
    expect(announcement.body.data).toMatchObject({
      chain: null,
      duplicate: false,
      message: {
        senderKind: "system",
        content: "海面升起了白雾。",
        metadata: { type: "announcement", publishedBy: { userId: owner.user.userId } }
      }
    });
    const duplicateAnnouncement = await owner.agent.post(`/api/im/conversations/${groupId}/announcements`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ content: "海面升起了白雾。", requestId: "im-announcement-request-0001" })
      .expect(201);
    expect(duplicateAnnouncement.body.data).toMatchObject({ duplicate: true });
    expect(duplicateAnnouncement.body.data.message.id).toBe(announcement.body.data.message.id);
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM im_chains WHERE conversation_id = ?", groupId)).toEqual({ count: 0 });
    expect(runtime.database.get(
      "SELECT COUNT(*) AS count FROM im_message_deliveries WHERE message_id = ?",
      announcement.body.data.message.id
    )).toEqual({ count: 1 });

    const firstMessage = await owner.agent.post(`/api/im/conversations/${groupId}/messages`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({
        content: `mention://character/${character.body.data.id} 我们出发。`,
        requestId: "im-message-request-0001"
      })
      .expect(201);
    expect(firstMessage.body.data.chain).toMatchObject({ status: "queued", mode: "mention" });
    expect(firstMessage.body.data.message.mentions).toEqual([
      expect.objectContaining({ kind: "character", id: character.body.data.id })
    ]);

    const memberView = await member.agent.get(`/api/im/conversations/${groupId}`).expect(200);
    expect(memberView.body.data.messages).toHaveLength(2);
    expect(memberView.body.data.messages[0]).toMatchObject({
      content: "海面升起了白雾。",
      metadata: { type: "announcement" }
    });
    expect(memberView.body.data.messages[1].content).toContain("mention://character/");
    expect(memberView.body.data.participants.characters[0].avatarUrl).toBe(
      `/api/im/conversations/${groupId}/characters/${character.body.data.id}/avatar?v=${characterAvatarSha256}`
    );
    expect(memberView.body.data.avatarMembers).toHaveLength(3);

    await admin.agent.get(`/api/im/conversations/${groupId}`).expect(403);

    const joined = await owner.agent.post(`/api/im/conversations/${groupId}/humans`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ userId: lateMember.user.userId })
      .expect(201);
    expect(joined.body.data.contextEpoch).toBe(2);

    const lateView = await lateMember.agent.get(`/api/im/conversations/${groupId}`).expect(200);
    expect(lateView.body.data.messages).toHaveLength(1);
    expect(lateView.body.data.messages[0].metadata).toMatchObject({ type: "human-joined" });
    expect(lateView.body.data.messages[0].content).not.toContain("我们出发");

    await lateMember.agent.post(`/api/im/conversations/${groupId}/messages`)
      .set("X-CSRF-Token", lateMember.csrfToken)
      .send({ content: "我已登舰。", requestId: "im-message-request-0002" })
      .expect(201);
    expect(runtime.database.all(
      "SELECT sequence, context_epoch FROM im_messages WHERE conversation_id = ? ORDER BY sequence",
      groupId
    )).toEqual([
      { sequence: 1, context_epoch: 1 },
      { sequence: 2, context_epoch: 1 },
      { sequence: 3, context_epoch: 2 },
      { sequence: 4, context_epoch: 2 }
    ]);
    const ownerAfter = await owner.agent.get(`/api/im/conversations/${groupId}`).expect(200);
    expect(ownerAfter.body.data.messages.map((item: { content: string }) => item.content)).toEqual([
      "海面升起了白雾。",
      expect.stringContaining("我们出发"),
      "im_late_member 加入了群聊",
      "我已登舰。"
    ]);

    await lateMember.agent.post(`/api/im/conversations/${groupId}/leave`)
      .set("X-CSRF-Token", lateMember.csrfToken)
      .send({})
      .expect(204);
    const readOnly = await lateMember.agent.get(`/api/im/conversations/${groupId}`).expect(200);
    expect(readOnly.body.data.active).toBe(false);
    await owner.agent.post(`/api/im/conversations/${groupId}/humans`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ userId: admin.user.userId })
      .expect(201);
    const ownerAfterLateJoin = await owner.agent.get(`/api/im/conversations/${groupId}`).expect(200);
    expect(ownerAfterLateJoin.body.data.participants.humans.map((item: { userId: string }) => item.userId)).toContain(admin.user.userId);
    const historicalView = await lateMember.agent.get(`/api/im/conversations/${groupId}`).expect(200);
    expect(historicalView.body.data.participants.humans.map((item: { userId: string }) => item.userId)).not.toContain(admin.user.userId);
    expect(historicalView.body.data.avatarMembers.map((item: { participantId: string }) => item.participantId)).not.toContain(admin.user.userId);
    expect(historicalView.body.data.messages.some((item: { content: string }) => item.content.includes("im_admin 加入了群聊"))).toBe(false);
    const removedMemberEvents: Array<{ type: string; conversationId: string }> = [];
    const unsubscribeRemovedMember = runtime.imOrchestrator.subscribe(admin.user.userId, (event) => {
      removedMemberEvents.push({ type: event.type, conversationId: event.conversationId });
    });
    await owner.agent.delete(`/api/im/conversations/${groupId}/humans/${admin.user.userId}`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({})
      .expect(204);
    unsubscribeRemovedMember();
    expect(removedMemberEvents).toContainEqual({ type: "conversation", conversationId: groupId });
    await lateMember.agent.post(`/api/im/conversations/${groupId}/messages`)
      .set("X-CSRF-Token", lateMember.csrfToken)
      .send({ content: "不能发送", requestId: "im-message-request-0003" })
      .expect(403);

    await owner.agent.post(`/api/im/conversations/${groupId}/transfer`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ userId: member.user.userId })
      .expect(403);
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });
});
