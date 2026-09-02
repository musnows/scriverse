import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";
import { PLATFORM_AI_WORK_ID } from "../../src/database.js";

type RegisteredUser = {
  agent: ReturnType<typeof request.agent>;
  csrfToken: string;
  user: { userId: string; username: string; displayName: string };
};

const setupToken = "im-api-test-setup-token-with-at-least-32-characters";
const avatarPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2z94AAAAASUVORK5CYII=",
  "base64"
);
const avatarGif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
const avatarSecondPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mP8z8BQDwAFgwJ/lPObWQAAAABJRU5ErkJggg==",
  "base64"
);

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
    await owner.agent.patch("/api/im/settings")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ fallbackModelId: null })
      .expect(200);
    runtime.database.run("UPDATE models SET enabled = 0 WHERE id = ?", models.fallbackModelId);
    await owner.agent.patch("/api/im/settings")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ fallbackModelId: models.fallbackModelId })
      .expect(400);
    runtime.database.run("UPDATE models SET enabled = 1 WHERE id = ?", models.fallbackModelId);
    await owner.agent.patch("/api/im/settings")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ fallbackModelId: models.fallbackModelId })
      .expect(200);
    runtime.database.run("UPDATE providers SET connection_status = 'failed' WHERE id = 'provider-im'");
    const identityOnlyUpdate = await owner.agent.patch("/api/im/settings")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ preferredName: "模型失效时仍可改身份", primaryModelId: models.primaryModelId, fallbackModelId: models.fallbackModelId })
      .expect(200);
    expect(identityOnlyUpdate.body.data).toMatchObject({
      preferredName: "模型失效时仍可改身份",
      primaryModelId: models.primaryModelId,
      fallbackModelId: models.fallbackModelId
    });
    runtime.database.run("UPDATE providers SET connection_status = 'success' WHERE id = 'provider-im'");

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
    await owner.agent.post(`/api/im/conversations/${groupId}/announcements`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ content: "不同的公告内容。", requestId: "im-announcement-request-0001" })
      .expect(409);
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
    const duplicateMessage = await owner.agent.post(`/api/im/conversations/${groupId}/messages`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({
        content: `mention://character/${character.body.data.id} 我们出发。`,
        requestId: "im-message-request-0001"
      })
      .expect(201);
    expect(duplicateMessage.body.data).toMatchObject({ duplicate: true });
    expect(duplicateMessage.body.data.message.id).toBe(firstMessage.body.data.message.id);
    await owner.agent.post(`/api/im/conversations/${groupId}/messages`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ content: "不同内容", requestId: "im-message-request-0001" })
      .expect(409);
    await member.agent.post(`/api/im/conversations/${groupId}/messages`)
      .set("X-CSRF-Token", member.csrfToken)
      .send({
        content: `mention://character/${character.body.data.id} 我们出发。`,
        requestId: "im-message-request-0001"
      })
      .expect(409);
    await owner.agent.post(`/api/im/conversations/${groupId}/messages`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ content: "公告不能作为普通消息幂等命中", requestId: "im-announcement-request-0001" })
      .expect(409);
    const mentionOverflow = await owner.agent.post(`/api/im/conversations/${groupId}/messages`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({
        content: Array.from({ length: 51 }, () => `mention://character/${character.body.data.id}`).join(" "),
        requestId: "im-message-mention-overflow-0001"
      })
      .expect(400);
    expect(mentionOverflow.body.error.code).toBe("IM_MENTION_LIMIT_EXCEEDED");

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
    expect(lateView.body.data.activeChain).toBeNull();
    expect(lateView.body.data.messages[0].metadata).toMatchObject({ type: "human-joined" });
    expect(lateView.body.data.messages[0].content).not.toContain("我们出发");

    const lateMessage = await lateMember.agent.post(`/api/im/conversations/${groupId}/messages`)
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

    const preExitAvatarSha256 = "b".repeat(64);
    runtime.store.setCharacterAvatar(character.body.data.id, {
      mimeType: "image/png",
      byteLength: 80,
      sha256: preExitAvatarSha256,
      storageKey: "pre-exit-avatar.png",
      width: 40,
      height: 40
    });
    await lateMember.agent.post(`/api/im/conversations/${groupId}/leave`)
      .set("X-CSRF-Token", lateMember.csrfToken)
      .send({})
      .expect(204);
    const readOnly = await lateMember.agent.get(`/api/im/conversations/${groupId}`).expect(200);
    expect(readOnly.body.data.active).toBe(false);
    expect(readOnly.body.data.participants.characters[0].avatarUrl).toContain(preExitAvatarSha256);
    const originalCharacterMembership = runtime.database.get(
      "SELECT id FROM im_character_memberships WHERE conversation_id = ? AND character_id = ? ORDER BY joined_at LIMIT 1",
      groupId,
      character.body.data.id
    );
    runtime.database.run(
      `INSERT INTO im_chains (
         id, conversation_id, initiator_user_id, authorization_user_id, trigger_message_id,
         mode, threshold, max_ai_messages, retry_count, primary_model_id, fallback_model_id,
         status, created_at, updated_at, completed_at
       ) VALUES ('im-departed-avatar-chain', ?, ?, ?, ?, 'mention', 60, 20, 3, ?, ?, 'failed', ?, ?, ?)`,
      groupId,
      lateMember.user.userId,
      owner.user.userId,
      lateMessage.body.data.message.id,
      models.primaryModelId,
      models.fallbackModelId,
      lateMessage.body.data.message.createdAt,
      lateMessage.body.data.message.createdAt,
      lateMessage.body.data.message.createdAt
    );
    runtime.database.run(
      `INSERT INTO im_chain_turns (id, chain_id, character_membership_id, kind, status, failure, created_at, completed_at)
       VALUES ('im-departed-avatar-turn', 'im-departed-avatar-chain', ?, 'reply', 'failed', 'test failure', ?, ?)`,
      String(originalCharacterMembership?.id),
      "2026-09-02T00:00:00.000Z",
      "2026-09-02T00:00:00.000Z"
    );
    const updatedExistingAvatarSha256 = "e".repeat(64);
    runtime.store.setCharacterAvatar(character.body.data.id, {
      mimeType: "image/png",
      byteLength: 96,
      sha256: updatedExistingAvatarSha256,
      storageKey: "updated-existing-avatar.png",
      width: 48,
      height: 48
    });
    const ownerAvatarView = await owner.agent.get(`/api/im/conversations/${groupId}`).expect(200);
    expect(ownerAvatarView.body.data.participants.characters[0].avatarUrl).toContain(updatedExistingAvatarSha256);
    const departedAvatarView = await lateMember.agent.get(`/api/im/conversations/${groupId}`).expect(200);
    expect(departedAvatarView.body.data.participants.characters[0].avatarUrl).toContain(preExitAvatarSha256);
    expect(departedAvatarView.body.data.activeChain?.turns?.length ?? 0).toBeGreaterThan(0);
    expect(departedAvatarView.body.data.activeChain?.turns ?? []).toEqual(
      expect.arrayContaining((departedAvatarView.body.data.activeChain?.turns ?? []).map(() => (
        expect.objectContaining({ character: expect.objectContaining({ avatarUrl: expect.stringContaining(preExitAvatarSha256) }) })
      )))
    );
    await lateMember.agent.get(`/api/im/conversations/${groupId}/characters/${character.body.data.id}/avatar?v=${updatedExistingAvatarSha256}`).expect(404);
    runtime.database.run("UPDATE users SET display_name = '退出后新显示名' WHERE id = ?", member.user.userId);
    const ownerProfileView = await owner.agent.get(`/api/im/conversations/${groupId}`).expect(200);
    expect(ownerProfileView.body.data.participants.humans.find((item: { userId: string }) => item.userId === member.user.userId)?.displayName)
      .toBe("退出后新显示名");
    const departedProfileView = await lateMember.agent.get(`/api/im/conversations/${groupId}`).expect(200);
    expect(departedProfileView.body.data.participants.humans.find((item: { userId: string }) => item.userId === member.user.userId)?.displayName)
      .toBe("im_member");
    runtime.database.run(
      "UPDATE im_chains SET status = 'waiting_config', created_at = ?, updated_at = ? WHERE id = ?",
      "9999-12-31T23:59:59.999Z",
      "9999-12-31T23:59:59.999Z",
      firstMessage.body.data.chain.id
    );
    const ownerRetryView = await owner.agent.get(`/api/im/conversations/${groupId}`).expect(200);
    expect(ownerRetryView.body.data.activeChain?.id).toBe(firstMessage.body.data.chain.id);
    const departedRetryView = await lateMember.agent.get(`/api/im/conversations/${groupId}`).expect(200);
    expect(departedRetryView.body.data.activeChain?.id).toBe("im-departed-avatar-chain");
    const postDepartureAvatarSha256 = "d".repeat(64);
    runtime.store.setCharacterAvatar(pinnedCharacter.body.data.id, {
      mimeType: "image/png",
      byteLength: 64,
      sha256: postDepartureAvatarSha256,
      storageKey: "post-departure-avatar.png",
      width: 32,
      height: 32
    });
    await owner.agent.post(`/api/im/conversations/${groupId}/characters`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ characterId: pinnedCharacter.body.data.id })
      .expect(201);
    await lateMember.agent.get(`/api/im/conversations/${groupId}/characters/${pinnedCharacter.body.data.id}/avatar`).expect(404);
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
    expect(historicalView.body.data.latestSequence).toBe(readOnly.body.data.latestSequence);
    expect(historicalView.body.data.updatedAt).toBe(readOnly.body.data.updatedAt);
    await owner.agent.patch(`/api/im/conversations/${groupId}`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "退出后修改的群名", responseThreshold: 5, maxAiMessages: 99 })
      .expect(200);
    const frozenDetails = await lateMember.agent.get(`/api/im/conversations/${groupId}`).expect(200);
    expect(frozenDetails.body.data).toMatchObject({
      title: readOnly.body.data.title,
      responseThreshold: readOnly.body.data.responseThreshold,
      maxAiMessages: readOnly.body.data.maxAiMessages,
      latestSequence: readOnly.body.data.latestSequence,
      updatedAt: readOnly.body.data.updatedAt
    });
    const frozenListItem = (await lateMember.agent.get("/api/im/conversations").expect(200)).body.data
      .find((conversation: { id: string }) => conversation.id === groupId);
    expect(frozenListItem).toMatchObject({
      title: readOnly.body.data.title,
      latestSequence: readOnly.body.data.latestSequence,
      updatedAt: readOnly.body.data.updatedAt
    });
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

    const zeroMessageGroup = await owner.agent.post("/api/im/conversations/group")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({
        title: "零消息群",
        characterIds: [character.body.data.id],
        humanUserIds: [lateMember.user.userId],
        replyMode: "mention",
        responseThreshold: 60,
        maxAiMessages: 20
      })
      .expect(201);
    await lateMember.agent.post(`/api/im/conversations/${zeroMessageGroup.body.data.id}/leave`)
      .set("X-CSRF-Token", lateMember.csrfToken)
      .send({})
      .expect(204);
    const zeroMessageHistory = await lateMember.agent.get(`/api/im/conversations/${zeroMessageGroup.body.data.id}`).expect(200);
    expect(zeroMessageHistory.body.data.participants.humans.map((item: { userId: string }) => item.userId)).toEqual(expect.arrayContaining([
      owner.user.userId,
      lateMember.user.userId
    ]));
    expect(zeroMessageHistory.body.data.participants.characters.map((item: { characterId: string }) => item.characterId)).toContain(character.body.data.id);

    const pagedGroup = await owner.agent.post("/api/im/conversations/group")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({
        title: "分页群",
        characterIds: [character.body.data.id],
        replyMode: "mention",
        responseThreshold: 60,
        maxAiMessages: 20
      })
      .expect(201);
    for (let sequence = 1; sequence <= 55; sequence += 1) {
      runtime.database.run(
        `INSERT INTO im_messages (id, conversation_id, sequence, context_epoch, sender_kind, content, created_at)
         VALUES (?, ?, ?, 1, 'system', ?, ?)`,
        `im-page-message-${sequence}`,
        pagedGroup.body.data.id,
        sequence,
        `分页消息 ${sequence}`,
        new Date(sequence * 1000).toISOString()
      );
    }
    const pagedCharacterMembership = runtime.database.get(
      "SELECT id FROM im_character_memberships WHERE conversation_id = ? AND left_at IS NULL",
      pagedGroup.body.data.id
    );
    runtime.database.run(
      `INSERT INTO im_chains (
         id, conversation_id, initiator_user_id, authorization_user_id, trigger_message_id,
         mode, threshold, max_ai_messages, retry_count, status, created_at, updated_at, completed_at
       ) VALUES ('im-page-query-chain', ?, ?, ?, 'im-page-message-55', 'mention', 60, 20, 3, 'failed', ?, ?, ?)`,
      pagedGroup.body.data.id,
      owner.user.userId,
      owner.user.userId,
      "9998-09-02T00:01:00.000Z",
      "9998-09-02T00:01:00.000Z",
      "9998-09-02T00:01:00.000Z"
    );
    for (let index = 1; index <= 20; index += 1) {
      runtime.database.run(
        `INSERT INTO im_chain_turns (id, chain_id, character_membership_id, kind, status, created_at, completed_at)
         VALUES (?, 'im-page-query-chain', ?, 'reply', 'failed', ?, ?)`,
        `im-page-query-turn-${index}`,
        String(pagedCharacterMembership?.id),
        `9998-09-02T00:01:${String(index).padStart(2, "0")}.000Z`,
        `9998-09-02T00:01:${String(index).padStart(2, "0")}.000Z`
      );
    }
    const newestPage = await owner.agent.get(`/api/im/conversations/${pagedGroup.body.data.id}`).expect(200);
    expect(newestPage.body.data.hasMoreMessages).toBe(true);
    expect(newestPage.body.data.messages).toHaveLength(50);
    expect(newestPage.body.data.activeChain.turns).toHaveLength(20);
    expect(newestPage.body.data.messages[0]).toMatchObject({ sequence: 6, content: "分页消息 6" });
    const pageAllSpy = vi.spyOn(runtime.database, "all");
    const pageGetSpy = vi.spyOn(runtime.database, "get");
    expect((runtime.im.getConversation(pagedGroup.body.data.id, owner.user.userId).messages as unknown[])).toHaveLength(50);
    expect(pageAllSpy.mock.calls.length + pageGetSpy.mock.calls.length).toBeLessThanOrEqual(20);
    pageAllSpy.mockRestore();
    pageGetSpy.mockRestore();
    const oldestPage = await owner.agent.get(`/api/im/conversations/${pagedGroup.body.data.id}?beforeSequence=6`).expect(200);
    expect(oldestPage.body.data.hasMoreMessages).toBe(false);
    expect(oldestPage.body.data.messages.map((message: { sequence: number }) => message.sequence)).toEqual([1, 2, 3, 4, 5]);
    const firstForwardPage = await owner.agent.get(`/api/im/conversations/${pagedGroup.body.data.id}?afterSequence=1`).expect(200);
    expect(firstForwardPage.body.data.hasMoreMessagesAfter).toBe(true);
    expect(firstForwardPage.body.data.messages).toHaveLength(50);
    expect(firstForwardPage.body.data.messages[0].sequence).toBe(2);
    expect(firstForwardPage.body.data.messages.at(-1).sequence).toBe(51);
    const secondForwardPage = await owner.agent.get(`/api/im/conversations/${pagedGroup.body.data.id}?afterSequence=51`).expect(200);
    expect(secondForwardPage.body.data.hasMoreMessagesAfter).toBe(false);
    expect(secondForwardPage.body.data.messages.map((message: { sequence: number }) => message.sequence)).toEqual([52, 53, 54, 55]);
    await owner.agent.get(`/api/im/conversations/${pagedGroup.body.data.id}?beforeSequence=6&afterSequence=1`).expect(400);

    await owner.agent.post(`/api/im/conversations/${groupId}/transfer`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ userId: member.user.userId })
      .expect(403);
    const allSpy = vi.spyOn(runtime.database, "all");
    const getSpy = vi.spyOn(runtime.database, "get");
    const listedConversations = runtime.im.listConversations(owner.user.userId);
    expect(listedConversations.length).toBeGreaterThanOrEqual(4);
    expect(allSpy).toHaveBeenCalledTimes(7);
    expect(getSpy).not.toHaveBeenCalled();
    const scopedListQueries = allSpy.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => sql.includes("WITH visible_conversations"));
    expect(scopedListQueries).toHaveLength(3);
    allSpy.mockRestore();
    getSpy.mockRestore();
    const plans = scopedListQueries.map((sql) => runtime.database.all(
      `EXPLAIN QUERY PLAN ${sql}`,
      owner.user.userId
    ).map((row) => String(row.detail)));
    expect(plans[0]).toEqual(expect.arrayContaining([
      expect.stringContaining("idx_im_messages_conversation")
    ]));
    expect(plans[1]).toEqual(expect.arrayContaining([
      expect.stringContaining("idx_im_human_memberships_conversation")
    ]));
    expect(plans[2]).toEqual(expect.arrayContaining([
      expect.stringContaining("idx_im_character_memberships_conversation")
    ]));
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("为退出与解散历史保留可读取的角色和人类头像版本", async () => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "im-avatar-version-master-secret-with-enough-length",
      serveUi: false,
      revealCaptchaAnswer: true,
      security: { allowRegistration: true, enforceSameOrigin: true, setupToken }
    });
    const owner = await register(runtime, "im_avatar_owner");
    const member = await register(runtime, "im_avatar_member");
    const lateMember = await register(runtime, "im_avatar_late_member");
    const work = await owner.agent.post("/api/works")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "IM 头像版本作品" })
      .expect(201);
    const character = await owner.agent.post(`/api/works/${work.body.data.id}/characters`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ name: "头像版本角色" })
      .expect(201);
    await owner.agent.put(`/api/characters/${character.body.data.id}/avatar`)
      .set("X-CSRF-Token", owner.csrfToken)
      .attach("file", avatarPng, { filename: "avatar.png", contentType: "image/png" })
      .expect(200);
    await member.agent.put("/api/auth/avatar")
      .set("X-CSRF-Token", member.csrfToken)
      .attach("file", avatarPng, { filename: "avatar.png", contentType: "image/png" })
      .expect(200);
    const deletedCharacter = await owner.agent.post(`/api/works/${work.body.data.id}/characters`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ name: "删除后头像角色" })
      .expect(201);
    await owner.agent.put(`/api/characters/${deletedCharacter.body.data.id}/avatar`)
      .set("X-CSRF-Token", owner.csrfToken)
      .attach("file", avatarSecondPng, { filename: "avatar.png", contentType: "image/png" })
      .expect(200);
    const deletedCharacterGroup = await owner.agent.post("/api/im/conversations/group")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "删除角色头像群", characterIds: [deletedCharacter.body.data.id], humanUserIds: [member.user.userId] })
      .expect(201);
    const deletedCharacterAvatarUrl = deletedCharacterGroup.body.data.participants.characters[0].avatarUrl;
    runtime.im.captureCharacterAvatarVersion(deletedCharacterGroup.body.data.id, deletedCharacter.body.data.id, "2026-09-02T00:00:00.000Z");
    runtime.database.run(
      `INSERT INTO im_messages (
         id, conversation_id, sequence, context_epoch, sender_kind, sender_character_id,
         sender_snapshot_json, content, created_at
       ) VALUES ('im-deleted-avatar-character-message', ?, 1, 1, 'character', ?, ?, '删除后角色头像历史消息', ?)`,
      deletedCharacterGroup.body.data.id,
      deletedCharacter.body.data.id,
      JSON.stringify({
        id: deletedCharacter.body.data.id,
        name: "删除后头像角色",
        avatarUrl: deletedCharacterAvatarUrl
      }),
      "2026-09-02T00:00:00.000Z"
    );
    runtime.store.deleteCharacter(deletedCharacter.body.data.id);
    const deletedCharacterView = await member.agent.get(`/api/im/conversations/${deletedCharacterGroup.body.data.id}`).expect(200);
    const deletedCharacterMessageUrl = deletedCharacterView.body.data.messages[0].sender.avatarUrl;
    expect(deletedCharacterMessageUrl).toBe(deletedCharacterAvatarUrl);
    expect(Buffer.from((await member.agent.get(deletedCharacterMessageUrl).expect(200)).body)).toEqual(avatarSecondPng);
    const visibilityAllSpy = vi.spyOn(runtime.database, "all");
    const visibilityGetSpy = vi.spyOn(runtime.database, "get");
    expect((runtime.im as unknown as {
      messageAvatarVersionVisible: (userId: string, conversationId: string, kind: "character", senderId: string, sha256: string) => boolean;
    }).messageAvatarVersionVisible(
      member.user.userId,
      deletedCharacterGroup.body.data.id,
      "character",
      deletedCharacter.body.data.id,
      String(deletedCharacterMessageUrl).split("v=")[1] ?? ""
    )).toBe(true);
    expect(visibilityAllSpy).not.toHaveBeenCalled();
    expect(visibilityGetSpy).toHaveBeenCalledTimes(2);
    const [snapshotLookupSql, ...snapshotLookupParams] = visibilityGetSpy.mock.calls.at(-1) ?? [];
    visibilityAllSpy.mockRestore();
    visibilityGetSpy.mockRestore();
    expect(runtime.database.all(
      `EXPLAIN QUERY PLAN ${String(snapshotLookupSql)}`,
      ...(snapshotLookupParams as import("node:sqlite").SQLInputValue[])
    ).map((row) => String(row.detail))).toEqual(expect.arrayContaining([
      expect.stringContaining("idx_im_messages_character_snapshot_avatar")
    ]));
    await owner.agent.post(`/api/im/conversations/${deletedCharacterGroup.body.data.id}/humans`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ userId: lateMember.user.userId })
      .expect(201);
    await lateMember.agent.get(deletedCharacterMessageUrl).expect(404);
    const exitedGroup = await owner.agent.post("/api/im/conversations/group")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "退出头像群", characterIds: [character.body.data.id], humanUserIds: [member.user.userId] })
      .expect(201);
    runtime.database.run(
      `INSERT INTO im_messages (
         id, conversation_id, sequence, context_epoch, sender_kind, sender_character_id,
         sender_snapshot_json, content, created_at
       ) VALUES ('im-avatar-character-message', ?, 1, 1, 'character', ?, ?, '角色头像历史消息', ?)`,
      exitedGroup.body.data.id,
      character.body.data.id,
      JSON.stringify({
        name: "头像版本角色",
        avatarUrl: exitedGroup.body.data.participants.characters[0].avatarUrl
      }),
      "2026-09-02T00:00:00.000Z"
    );
    await member.agent.post(`/api/im/conversations/${exitedGroup.body.data.id}/messages`)
      .set("X-CSRF-Token", member.csrfToken)
      .send({ content: "人类头像历史消息", requestId: "im-avatar-human-message" })
      .expect(201);
    await member.agent.post(`/api/im/conversations/${exitedGroup.body.data.id}/leave`)
      .set("X-CSRF-Token", member.csrfToken)
      .send({})
      .expect(204);
    const exitedView = await member.agent.get(`/api/im/conversations/${exitedGroup.body.data.id}`).expect(200);
    const exitedCharacterUrl = exitedView.body.data.participants.characters[0].avatarUrl;
    const exitedHumanUrl = exitedView.body.data.participants.humans
      .find((item: { userId: string }) => item.userId === member.user.userId).avatarUrl;
    const exitedCharacterMessageUrl = exitedView.body.data.messages
      .find((message: { senderKind: string }) => message.senderKind === "character").sender.avatarUrl;
    const exitedHumanMessageUrl = exitedView.body.data.messages
      .find((message: { senderUserId: string }) => message.senderUserId === member.user.userId).sender.avatarUrl;
    expect(exitedCharacterMessageUrl).toBe(exitedCharacterUrl);
    expect(exitedHumanMessageUrl).toBe(exitedHumanUrl);
    expect(Buffer.from((await member.agent.get(exitedCharacterUrl).expect(200)).body)).toEqual(avatarPng);
    expect(Buffer.from((await member.agent.get(exitedHumanUrl).expect(200)).body)).toEqual(avatarPng);
    expect(Buffer.from((await member.agent.get(exitedCharacterMessageUrl).expect(200)).body)).toEqual(avatarPng);
    expect(Buffer.from((await member.agent.get(exitedHumanMessageUrl).expect(200)).body)).toEqual(avatarPng);

    const secondCharacterAvatar = await owner.agent.put(`/api/characters/${character.body.data.id}/avatar`)
      .set("X-CSRF-Token", owner.csrfToken)
      .attach("file", avatarSecondPng, { filename: "avatar.png", contentType: "image/png" })
      .expect(200);
    const secondCharacterContent = Buffer.from((await owner.agent.get(secondCharacterAvatar.body.data.avatarUrl).expect(200)).body);
    await member.agent.put("/api/auth/avatar")
      .set("X-CSRF-Token", member.csrfToken)
      .attach("file", avatarGif, { filename: "avatar.gif", contentType: "image/gif" })
      .expect(200);
    expect(Buffer.from((await member.agent.get(exitedCharacterUrl).expect(200)).body)).toEqual(avatarPng);
    expect(Buffer.from((await member.agent.get(exitedHumanUrl).expect(200)).body)).toEqual(avatarPng);
    await owner.agent.post(`/api/im/conversations/${exitedGroup.body.data.id}/humans`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ userId: member.user.userId })
      .expect(201);
    const rejoinedView = await member.agent.get(`/api/im/conversations/${exitedGroup.body.data.id}`).expect(200);
    expect(rejoinedView.body.data.messages.find((message: { senderKind: string }) => message.senderKind === "character").sender.avatarUrl)
      .toBe(exitedCharacterUrl);
    expect(rejoinedView.body.data.messages.find((message: { senderUserId: string }) => message.senderUserId === member.user.userId).sender.avatarUrl)
      .toBe(exitedHumanUrl);
    expect(Buffer.from((await member.agent.get(exitedCharacterUrl).expect(200)).body)).toEqual(avatarPng);
    expect(Buffer.from((await member.agent.get(exitedHumanUrl).expect(200)).body)).toEqual(avatarPng);
    await owner.agent.post(`/api/im/conversations/${exitedGroup.body.data.id}/humans`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ userId: lateMember.user.userId })
      .expect(201);
    await lateMember.agent.get(exitedCharacterUrl).expect(404);
    await lateMember.agent.get(exitedHumanUrl).expect(404);

    const disbandedGroup = await owner.agent.post("/api/im/conversations/group")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "解散头像群", characterIds: [character.body.data.id], humanUserIds: [member.user.userId] })
      .expect(201);
    const disbandEvents: string[] = [];
    const unsubscribeDisband = runtime.imOrchestrator.subscribe(member.user.userId, (event) => {
      if (event.conversationId === disbandedGroup.body.data.id) disbandEvents.push(event.type);
    });
    await owner.agent.post(`/api/im/conversations/${disbandedGroup.body.data.id}/disband`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({})
      .expect(204);
    unsubscribeDisband();
    expect(disbandEvents).toContain("conversation");
    const disbandedView = await member.agent.get(`/api/im/conversations/${disbandedGroup.body.data.id}`).expect(200);
    expect(disbandedView.body.data).toMatchObject({ active: false, status: "disbanded" });
    const disbandedCharacterUrl = disbandedView.body.data.participants.characters[0].avatarUrl;
    const disbandedHumanUrl = disbandedView.body.data.participants.humans
      .find((item: { userId: string }) => item.userId === member.user.userId).avatarUrl;
    const disbandedDisplayName = disbandedView.body.data.participants.humans
      .find((item: { userId: string }) => item.userId === member.user.userId).displayName;
    await owner.agent.put(`/api/characters/${character.body.data.id}/avatar`)
      .set("X-CSRF-Token", owner.csrfToken)
      .attach("file", avatarPng, { filename: "avatar.png", contentType: "image/png" })
      .expect(200);
    await member.agent.put("/api/auth/avatar")
      .set("X-CSRF-Token", member.csrfToken)
      .attach("file", avatarPng, { filename: "avatar.png", contentType: "image/png" })
      .expect(200);
    await member.agent.patch("/api/auth/profile")
      .set("X-CSRF-Token", member.csrfToken)
      .send({ displayName: "解散后新名字" })
      .expect(200);
    const disbandedCharacterContent = Buffer.from((await member.agent.get(disbandedCharacterUrl).expect(200)).body);
    expect(disbandedCharacterContent).toEqual(secondCharacterContent);
    expect(Buffer.from((await member.agent.get(disbandedHumanUrl).expect(200)).body)).toEqual(avatarGif);
    const frozenDisbandProfile = await member.agent.get(`/api/im/conversations/${disbandedGroup.body.data.id}`).expect(200);
    expect(frozenDisbandProfile.body.data.participants.humans
      .find((item: { userId: string }) => item.userId === member.user.userId).displayName).toBe(disbandedDisplayName);
    expect(runtime.database.get(
      "SELECT COUNT(*) AS count FROM im_avatar_versions WHERE conversation_id IN (?, ?)",
      exitedGroup.body.data.id,
      disbandedGroup.body.data.id
    )).toEqual({ count: 4 });
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });
});
