import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";
import { runWithRequestActor } from "../../src/request-context.js";

type SessionCredentials = {
  agent: ReturnType<typeof request.agent>;
  cookie: string;
  csrfToken: string;
  user: { userId: string; username: string; displayName: string; role: "admin" | "user" };
};

const setupToken = "user-auth-test-setup-token-with-at-least-32-characters";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2z94AAAAASUVORK5CYII=",
  "base64"
);
const onePixelGif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
const maximumAvatarImageUploadBytes = 2 * 1024 * 1024;

function gifOfSize(size: number): Buffer {
  return Buffer.concat([onePixelGif.subarray(0, -1), Buffer.alloc(size - onePixelGif.length), onePixelGif.subarray(-1)]);
}

function pngOfSize(size: number): Buffer {
  return Buffer.concat([onePixelPng, Buffer.alloc(size - onePixelPng.length)]);
}
let authTestServer: Server;
let activeRuntimeApp: Runtime["app"] | null = null;

async function solveCaptcha(app: Runtime["app"]): Promise<{ captchaId: string; captchaAnswer: string }> {
  const response = await request(app).get("/api/auth/captcha").expect(200);
  expect(response.body.data.captchaId).toBeTruthy();
  expect(response.body.data.answer).toBeTruthy();
  return { captchaId: response.body.data.captchaId, captchaAnswer: response.body.data.answer };
}

async function register(runtime: Runtime, username: string): Promise<SessionCredentials> {
  const agent = request.agent(runtime.app);
  const captcha = await solveCaptcha(runtime.app);
  const response = await agent.post("/api/auth/register").send({
    username,
    password: "secure-password-123",
    passwordConfirmation: "secure-password-123",
    setupToken,
    ...captcha
  }).expect(201);
  expect(response.body.data.user.displayName).toBe(username);
  const cookie = response.headers["set-cookie"]?.[0]?.split(";", 1)[0] ?? "";
  expect(cookie).toContain("scriverse_session=");
  return { agent, cookie, csrfToken: response.body.data.csrfToken, user: response.body.data.user };
}

async function submitLogin(runtime: Runtime, username: string, password: string) {
  const captcha = await solveCaptcha(runtime.app);
  return request(runtime.app).post("/api/auth/login").send({ username, password, ...captcha });
}

function createUserAuthTestRuntime(allowRegistration = true): Runtime {
  const runtime = createRuntime({
    databasePath: ":memory:",
    masterSecret: "user-auth-test-master-secret-with-enough-length",
    serveUi: false,
    revealCaptchaAnswer: true,
    security: { allowRegistration, enforceSameOrigin: true, setupToken }
  });
  activeRuntimeApp = runtime.app;
  return {
    ...runtime,
    app: authTestServer as unknown as Runtime["app"],
    close: async () => {
      if (activeRuntimeApp === runtime.app) activeRuntimeApp = null;
      await runtime.close();
    }
  };
}

describe("用户、作品权限与操作者追踪 API", () => {
  let runtime: Runtime;

  beforeAll(async () => {
    authTestServer = createServer((incoming, outgoing) => {
      if (!activeRuntimeApp) {
        outgoing.writeHead(503).end();
        return;
      }
      activeRuntimeApp(incoming, outgoing);
    });
    await new Promise<void>((resolve, reject) => {
      const rejectStart = (error: Error) => reject(error);
      authTestServer.once("error", rejectStart);
      authTestServer.listen(0, "127.0.0.1", () => {
        authTestServer.off("error", rejectStart);
        authTestServer.unref();
        resolve();
      });
    });
  });
  afterAll(async () => {
    authTestServer.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      authTestServer.close((error) => error ? reject(error) : resolve());
    });
  });

  beforeEach(() => {
    runtime = createUserAuthTestRuntime();
  });
  afterEach(() => runtime.close());

  it("仅向作品成员展示在线协作者及其受控页面", async () => {
    const owner = await register(runtime, "presence_owner");
    const writer = await register(runtime, "presence_writer");
    const outsider = await register(runtime, "presence_outsider");
    const work = await owner.agent.post("/api/works").set("X-CSRF-Token", owner.csrfToken).send({ title: "协作作品" }).expect(201);
    const workId = work.body.data.id;
    await owner.agent.post(`/api/works/${workId}/members`).set("X-CSRF-Token", owner.csrfToken).send({
      userId: writer.user.userId,
      role: "editor"
    }).expect(201);

    await outsider.agent.post(`/api/works/${workId}/presence`).set("X-CSRF-Token", outsider.csrfToken).send({
      clientId: "9c554179-6a29-46d2-82ca-c3c6cb9858a0",
      page: { kind: "welcome" }
    }).expect(403);
    await owner.agent.post(`/api/works/${workId}/presence`).send({
      clientId: "4c1c2bbb-4e04-431d-a67c-d834d004a55c",
      page: { kind: "editor", resourceId: "chapter-secret", label: "不应被接收" }
    }).expect(403);

    await owner.agent.post(`/api/works/${workId}/presence`).set("X-CSRF-Token", owner.csrfToken).send({
      clientId: "4c1c2bbb-4e04-431d-a67c-d834d004a55c",
      page: { kind: "editor", resourceId: "chapter-1" }
    }).expect(200);
    const active = await writer.agent.post(`/api/works/${workId}/presence`).set("X-CSRF-Token", writer.csrfToken).send({
      clientId: "2f38ed97-e31a-4a16-a599-a94b47a65d35",
      page: { kind: "editor", resourceId: "chapter-1" }
    }).expect(200);

    expect(active.body.data).toEqual(expect.objectContaining({
      participants: expect.arrayContaining([
        expect.objectContaining({ userId: owner.user.userId, displayName: "presence_owner", page: { key: "editor:chapter-1", label: "正文编辑" } }),
        expect.objectContaining({ userId: writer.user.userId, displayName: "presence_writer", page: { key: "editor:chapter-1", label: "正文编辑" } })
      ]),
      recentChanges: []
    }));
  });

  it("仅向正在查看同一页面的协作者返回主要编辑更新提醒", async () => {
    const owner = await register(runtime, "change_owner");
    const writer = await register(runtime, "change_writer");
    const work = await owner.agent.post("/api/works").set("X-CSRF-Token", owner.csrfToken).send({ title: "变更提醒作品" }).expect(201);
    const workId = work.body.data.id;
    await owner.agent.post(`/api/works/${workId}/members`).set("X-CSRF-Token", owner.csrfToken).send({
      userId: writer.user.userId,
      role: "editor"
    }).expect(201);

    const volume = await owner.agent.post(`/api/works/${workId}/volumes`).set("X-CSRF-Token", owner.csrfToken).send({ title: "第一卷" }).expect(201);
    const chapter = await owner.agent.post(`/api/works/${workId}/chapters`).set("X-CSRF-Token", owner.csrfToken).send({
      volumeId: volume.body.data.id,
      title: "第一章",
      content: "原始正文。"
    }).expect(201);
    const chapterId = chapter.body.data.id;

    await writer.agent.post(`/api/works/${workId}/presence`).set("X-CSRF-Token", writer.csrfToken).send({
      clientId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      page: { kind: "editor", resourceId: chapterId }
    }).expect(200);
    await owner.agent.patch(`/api/chapters/${chapterId}`).set("X-CSRF-Token", owner.csrfToken).send({
      content: "作者更新后的正文。",
      expectedVersionNo: chapter.body.data.versionNo
    }).expect(200);
    const chapterHeartbeat = await writer.agent.post(`/api/works/${workId}/presence`).set("X-CSRF-Token", writer.csrfToken).send({
      clientId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      page: { kind: "editor", resourceId: chapterId }
    }).expect(200);
    expect(chapterHeartbeat.body.data.recentChanges).toEqual([
      expect.objectContaining({
        pageKey: `editor:${chapterId}`,
        label: "正文编辑",
        action: "save",
        pageDeleted: false,
        actorUserId: owner.user.userId,
        actorDisplayName: "change_owner"
      })
    ]);

    const setting = await owner.agent.post(`/api/works/${workId}/settings`).set("X-CSRF-Token", owner.csrfToken).send({
      title: "跃迁规则",
      category: "世界规则",
      content: "跃迁后必须冷却十二小时。"
    }).expect(201);
    await writer.agent.post(`/api/works/${workId}/presence`).set("X-CSRF-Token", writer.csrfToken).send({
      clientId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      page: { kind: "entity-editor", module: "setting", resourceId: setting.body.data.id }
    }).expect(200);
    await owner.agent.patch(`/api/settings/${setting.body.data.id}`).set("X-CSRF-Token", owner.csrfToken).send({
      content: "跃迁后必须冷却二十四小时。",
      expectedVersionNo: setting.body.data.versionNo
    }).expect(200);
    const settingHeartbeat = await writer.agent.post(`/api/works/${workId}/presence`).set("X-CSRF-Token", writer.csrfToken).send({
      clientId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      page: { kind: "entity-editor", module: "setting", resourceId: setting.body.data.id }
    }).expect(200);
    expect(settingHeartbeat.body.data.recentChanges).toEqual([
      expect.objectContaining({
        pageKey: `entity-editor:setting:${setting.body.data.id}`,
        label: "设定编辑",
        action: "save",
        pageDeleted: false,
        actorUserId: owner.user.userId
      })
    ]);

    const firstCharacter = await owner.agent.post(`/api/works/${workId}/characters`).set("X-CSRF-Token", owner.csrfToken).send({
      name: "林舟"
    }).expect(201);
    const secondCharacter = await owner.agent.post(`/api/works/${workId}/characters`).set("X-CSRF-Token", owner.csrfToken).send({
      name: "沈星"
    }).expect(201);
    await writer.agent.post(`/api/works/${workId}/presence`).set("X-CSRF-Token", writer.csrfToken).send({
      clientId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      page: { kind: "entity-editor", module: "character", resourceId: firstCharacter.body.data.id }
    }).expect(200);
    await owner.agent.patch(`/api/characters/${firstCharacter.body.data.id}`).set("X-CSRF-Token", owner.csrfToken).send({
      aliases: ["舰长"],
      expectedVersionNo: firstCharacter.body.data.versionNo
    }).expect(200);
    const characterHeartbeat = await writer.agent.post(`/api/works/${workId}/presence`).set("X-CSRF-Token", writer.csrfToken).send({
      clientId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      page: { kind: "entity-editor", module: "character", resourceId: firstCharacter.body.data.id }
    }).expect(200);
    expect(characterHeartbeat.body.data.recentChanges).toEqual([
      expect.objectContaining({
        pageKey: `entity-editor:character:${firstCharacter.body.data.id}`,
        label: "角色编辑",
        action: "save",
        pageDeleted: false,
        actorUserId: owner.user.userId
      })
    ]);
    const relationship = await owner.agent.post(`/api/works/${workId}/relationships`).set("X-CSRF-Token", owner.csrfToken).send({
      fromCharacterId: firstCharacter.body.data.id,
      toCharacterId: secondCharacter.body.data.id,
      category: "social",
      subtype: "朋友",
      directed: false
    }).expect(201);
    const relationshipId = relationship.body.data.id;

    await writer.agent.post(`/api/works/${workId}/presence`).set("X-CSRF-Token", writer.csrfToken).send({
      clientId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      page: { kind: "module", module: "relationships" }
    }).expect(200);
    const unobservedUpdate = await owner.agent.patch(`/api/relationships/${relationshipId}`).set("X-CSRF-Token", owner.csrfToken).send({
      subtype: "旧友",
      expectedVersionNo: relationship.body.data.versionNo
    }).expect(200);
    const openedAfterUpdate = await writer.agent.post(`/api/works/${workId}/presence`).set("X-CSRF-Token", writer.csrfToken).send({
      clientId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      page: { kind: "entity-editor", module: "relationship", resourceId: relationshipId }
    }).expect(200);
    expect(openedAfterUpdate.body.data.recentChanges).toEqual([]);

    await owner.agent.post(`/api/works/${workId}/presence`).set("X-CSRF-Token", owner.csrfToken).send({
      clientId: "b1c2d3e4-f5a6-7890-abcd-ef1234567890",
      page: { kind: "entity-editor", module: "relationship", resourceId: relationshipId }
    }).expect(200);
    await owner.agent.patch(`/api/relationships/${relationshipId}`).set("X-CSRF-Token", owner.csrfToken).send({
      subtype: "盟友",
      expectedVersionNo: unobservedUpdate.body.data.versionNo
    }).expect(200);
    const sameRelationship = await writer.agent.post(`/api/works/${workId}/presence`).set("X-CSRF-Token", writer.csrfToken).send({
      clientId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      page: { kind: "entity-editor", module: "relationship", resourceId: relationshipId }
    }).expect(200);
    expect(sameRelationship.body.data.recentChanges).toEqual([
      expect.objectContaining({
        pageKey: `entity-editor:relationship:${relationshipId}`,
        label: "人物关系编辑",
        action: "save",
        pageDeleted: false,
        actorUserId: owner.user.userId,
        actorDisplayName: "change_owner"
      })
    ]);

    const globalList = await writer.agent.post(`/api/works/${workId}/presence`).set("X-CSRF-Token", writer.csrfToken).send({
      clientId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      page: { kind: "module", module: "relationships" }
    }).expect(200);
    expect(globalList.body.data.recentChanges).toEqual([]);
  });

  it("在节流窗口内向后来进入同页的协作者返回下一次保存提醒", async () => {
    const owner = await register(runtime, "late_change_owner");
    const writer = await register(runtime, "late_change_writer");
    const lateWriter = await register(runtime, "late_change_reader");
    const work = await owner.agent.post("/api/works").set("X-CSRF-Token", owner.csrfToken).send({
      title: "后来加入提醒作品"
    }).expect(201);
    const workId = work.body.data.id;
    for (const member of [writer, lateWriter]) {
      await owner.agent.post(`/api/works/${workId}/members`).set("X-CSRF-Token", owner.csrfToken).send({
        userId: member.user.userId,
        role: "editor"
      }).expect(201);
    }

    const volume = await owner.agent.post(`/api/works/${workId}/volumes`).set("X-CSRF-Token", owner.csrfToken).send({
      title: "第一卷"
    }).expect(201);
    const chapter = await owner.agent.post(`/api/works/${workId}/chapters`).set("X-CSRF-Token", owner.csrfToken).send({
      volumeId: volume.body.data.id,
      title: "第一章",
      content: "原始正文。"
    }).expect(201);
    const chapterId = chapter.body.data.id;
    const page = { kind: "editor", resourceId: chapterId };

    await writer.agent.post(`/api/works/${workId}/presence`).set("X-CSRF-Token", writer.csrfToken).send({
      clientId: "11111111-1111-4111-8111-111111111111",
      page
    }).expect(200);
    const firstUpdate = await owner.agent.patch(`/api/chapters/${chapterId}`).set("X-CSRF-Token", owner.csrfToken).send({
      content: "第一次更新。",
      expectedVersionNo: chapter.body.data.versionNo
    }).expect(200);
    const firstHeartbeat = await writer.agent.post(`/api/works/${workId}/presence`).set("X-CSRF-Token", writer.csrfToken).send({
      clientId: "11111111-1111-4111-8111-111111111111",
      page
    }).expect(200);
    expect(firstHeartbeat.body.data.recentChanges).toHaveLength(1);
    const firstChangeId = firstHeartbeat.body.data.recentChanges[0]?.id;

    const joinedHeartbeat = await lateWriter.agent.post(`/api/works/${workId}/presence`).set("X-CSRF-Token", lateWriter.csrfToken).send({
      clientId: "22222222-2222-4222-8222-222222222222",
      page
    }).expect(200);
    expect(joinedHeartbeat.body.data.recentChanges).toEqual([]);

    await owner.agent.patch(`/api/chapters/${chapterId}`).set("X-CSRF-Token", owner.csrfToken).send({
      content: "第二次更新。",
      expectedVersionNo: firstUpdate.body.data.versionNo
    }).expect(200);
    const writerHeartbeat = await writer.agent.post(`/api/works/${workId}/presence`).set("X-CSRF-Token", writer.csrfToken).send({
      clientId: "11111111-1111-4111-8111-111111111111",
      page
    }).expect(200);
    const lateWriterHeartbeat = await lateWriter.agent.post(`/api/works/${workId}/presence`).set("X-CSRF-Token", lateWriter.csrfToken).send({
      clientId: "22222222-2222-4222-8222-222222222222",
      page
    }).expect(200);

    expect(writerHeartbeat.body.data.recentChanges).toEqual([
      expect.objectContaining({ id: firstChangeId, actorUserId: owner.user.userId })
    ]);
    expect(lateWriterHeartbeat.body.data.recentChanges).toEqual([
      expect.objectContaining({
        pageKey: `editor:${chapterId}`,
        actorUserId: owner.user.userId
      })
    ]);
    expect(lateWriterHeartbeat.body.data.recentChanges[0]?.id).not.toBe(firstChangeId);
  });

  it("在主要删除和设定库写路径发布对应页面变更", async () => {
    const owner = await register(runtime, "route_change_owner");
    const writer = await register(runtime, "route_change_writer");
    const trackDeleter = await register(runtime, "track_deleter");
    const eventUpdater = await register(runtime, "event_updater");
    const eventDeleter = await register(runtime, "event_deleter");
    const work = await owner.agent.post("/api/works").set("X-CSRF-Token", owner.csrfToken).send({
      title: "主要写路径广播作品"
    }).expect(201);
    const workId = work.body.data.id;
    for (const member of [writer, trackDeleter, eventUpdater, eventDeleter]) {
      await owner.agent.post(`/api/works/${workId}/members`).set("X-CSRF-Token", owner.csrfToken).send({
        userId: member.user.userId,
        role: "editor"
      }).expect(201);
    }

    const writerClientId = "c1d2e3f4-a5b6-4789-8abc-def123456789";
    const expectPublishedChange = async (
      page: Record<string, string>,
      expected: { pageKey: string; label: string; action: "save" | "delete"; pageDeleted: boolean; actorUserId: string },
      mutate: () => Promise<unknown>
    ): Promise<void> => {
      await writer.agent.post(`/api/works/${workId}/presence`).set("X-CSRF-Token", writer.csrfToken).send({
        clientId: writerClientId,
        page
      }).expect(200);
      await mutate();
      const heartbeat = await writer.agent.post(`/api/works/${workId}/presence`).set("X-CSRF-Token", writer.csrfToken).send({
        clientId: writerClientId,
        page
      }).expect(200);
      expect(heartbeat.body.data.recentChanges).toEqual(expect.arrayContaining([
        expect.objectContaining(expected)
      ]));
    };

    const volume = await owner.agent.post(`/api/works/${workId}/volumes`).set("X-CSRF-Token", owner.csrfToken).send({
      title: "第一卷"
    }).expect(201);
    const chapter = await owner.agent.post(`/api/works/${workId}/chapters`).set("X-CSRF-Token", owner.csrfToken).send({
      volumeId: volume.body.data.id,
      title: "待删除章节",
      content: "待删除正文。"
    }).expect(201);
    await expectPublishedChange(
      { kind: "editor", resourceId: chapter.body.data.id },
      { pageKey: `editor:${chapter.body.data.id}`, label: "正文编辑", action: "delete", pageDeleted: true, actorUserId: owner.user.userId },
      async () => {
        await owner.agent.delete(`/api/chapters/${chapter.body.data.id}`).set("X-CSRF-Token", owner.csrfToken).send({
          expectedVersionNo: chapter.body.data.versionNo
        }).expect(204);
      }
    );

    const setting = await owner.agent.post(`/api/works/${workId}/settings`).set("X-CSRF-Token", owner.csrfToken).send({
      title: "待删除设定",
      category: "世界规则",
      content: "旧规则。"
    }).expect(201);
    await expectPublishedChange(
      { kind: "entity-editor", module: "setting", resourceId: setting.body.data.id },
      { pageKey: `entity-editor:setting:${setting.body.data.id}`, label: "设定编辑", action: "delete", pageDeleted: true, actorUserId: owner.user.userId },
      async () => {
        await owner.agent.delete(`/api/settings/${setting.body.data.id}`).set("X-CSRF-Token", owner.csrfToken).send({
          expectedVersionNo: setting.body.data.versionNo
        }).expect(204);
      }
    );

    const removedCharacter = await owner.agent.post(`/api/works/${workId}/characters`).set("X-CSRF-Token", owner.csrfToken).send({
      name: "待删除角色"
    }).expect(201);
    await expectPublishedChange(
      { kind: "entity-editor", module: "character", resourceId: removedCharacter.body.data.id },
      { pageKey: `entity-editor:character:${removedCharacter.body.data.id}`, label: "角色编辑", action: "delete", pageDeleted: true, actorUserId: owner.user.userId },
      async () => {
        await owner.agent.delete(`/api/characters/${removedCharacter.body.data.id}`).set("X-CSRF-Token", owner.csrfToken).send({
          expectedVersionNo: removedCharacter.body.data.versionNo
        }).expect(204);
      }
    );

    const sectionCharacter = await owner.agent.post(`/api/works/${workId}/characters`).set("X-CSRF-Token", owner.csrfToken).send({
      name: "档案更新角色"
    }).expect(201);
    const updatedSection = await owner.agent.post(`/api/characters/${sectionCharacter.body.data.id}/sections`).set("X-CSRF-Token", owner.csrfToken).send({
      title: "角色概览",
      contentMarkdown: "原始档案。"
    }).expect(201);
    await expectPublishedChange(
      { kind: "entity-editor", module: "character", resourceId: sectionCharacter.body.data.id },
      { pageKey: `entity-editor:character:${sectionCharacter.body.data.id}`, label: "角色编辑", action: "save", pageDeleted: false, actorUserId: owner.user.userId },
      async () => {
        await owner.agent.patch(`/api/character-sections/${updatedSection.body.data.id}`).set("X-CSRF-Token", owner.csrfToken).send({
          contentMarkdown: "更新后的档案。",
          expectedVersionNo: updatedSection.body.data.versionNo
        }).expect(200);
      }
    );

    const sectionDeleteCharacter = await owner.agent.post(`/api/works/${workId}/characters`).set("X-CSRF-Token", owner.csrfToken).send({
      name: "档案删除角色"
    }).expect(201);
    const removedSection = await owner.agent.post(`/api/characters/${sectionDeleteCharacter.body.data.id}/sections`).set("X-CSRF-Token", owner.csrfToken).send({
      title: "待删除档案"
    }).expect(201);
    await expectPublishedChange(
      { kind: "entity-editor", module: "character", resourceId: sectionDeleteCharacter.body.data.id },
      { pageKey: `entity-editor:character:${sectionDeleteCharacter.body.data.id}`, label: "角色档案章节", action: "delete", pageDeleted: false, actorUserId: owner.user.userId },
      async () => {
        await owner.agent.delete(`/api/character-sections/${removedSection.body.data.id}`).set("X-CSRF-Token", owner.csrfToken).send({
          expectedVersionNo: removedSection.body.data.versionNo
        }).expect(204);
      }
    );

    const updatedRace = await owner.agent.post(`/api/works/${workId}/races`).set("X-CSRF-Token", owner.csrfToken).send({
      name: "更新种族"
    }).expect(201);
    await expectPublishedChange(
      { kind: "entity-editor", module: "race", resourceId: updatedRace.body.data.id },
      { pageKey: `entity-editor:race:${updatedRace.body.data.id}`, label: "种族编辑", action: "save", pageDeleted: false, actorUserId: owner.user.userId },
      async () => {
        await owner.agent.patch(`/api/races/${updatedRace.body.data.id}`).set("X-CSRF-Token", owner.csrfToken).send({
          description: "更新后的种族说明。",
          expectedVersionNo: updatedRace.body.data.versionNo
        }).expect(200);
      }
    );
    const removedRace = await owner.agent.post(`/api/works/${workId}/races`).set("X-CSRF-Token", owner.csrfToken).send({
      name: "删除种族"
    }).expect(201);
    await expectPublishedChange(
      { kind: "entity-editor", module: "race", resourceId: removedRace.body.data.id },
      { pageKey: `entity-editor:race:${removedRace.body.data.id}`, label: "种族编辑", action: "delete", pageDeleted: true, actorUserId: owner.user.userId },
      async () => {
        await owner.agent.delete(`/api/races/${removedRace.body.data.id}`).set("X-CSRF-Token", owner.csrfToken).send({
          expectedVersionNo: removedRace.body.data.versionNo
        }).expect(204);
      }
    );

    const updatedOrganization = await owner.agent.post(`/api/works/${workId}/organizations`).set("X-CSRF-Token", owner.csrfToken).send({
      name: "更新组织"
    }).expect(201);
    await expectPublishedChange(
      { kind: "entity-editor", module: "organization", resourceId: updatedOrganization.body.data.id },
      { pageKey: `entity-editor:organization:${updatedOrganization.body.data.id}`, label: "组织编辑", action: "save", pageDeleted: false, actorUserId: owner.user.userId },
      async () => {
        await owner.agent.patch(`/api/organizations/${updatedOrganization.body.data.id}`).set("X-CSRF-Token", owner.csrfToken).send({
          description: "更新后的组织说明。",
          expectedVersionNo: updatedOrganization.body.data.versionNo
        }).expect(200);
      }
    );
    const removedOrganization = await owner.agent.post(`/api/works/${workId}/organizations`).set("X-CSRF-Token", owner.csrfToken).send({
      name: "删除组织"
    }).expect(201);
    await expectPublishedChange(
      { kind: "entity-editor", module: "organization", resourceId: removedOrganization.body.data.id },
      { pageKey: `entity-editor:organization:${removedOrganization.body.data.id}`, label: "组织编辑", action: "delete", pageDeleted: true, actorUserId: owner.user.userId },
      async () => {
        await owner.agent.delete(`/api/organizations/${removedOrganization.body.data.id}`).set("X-CSRF-Token", owner.csrfToken).send({
          expectedVersionNo: removedOrganization.body.data.versionNo
        }).expect(204);
      }
    );

    const updatedTrack = await owner.agent.post(`/api/works/${workId}/timeline-tracks`).set("X-CSRF-Token", owner.csrfToken).send({
      name: "更新轨道"
    }).expect(201);
    await expectPublishedChange(
      { kind: "module", module: "timeline" },
      { pageKey: "module:timeline", label: "时间轴", action: "save", pageDeleted: false, actorUserId: owner.user.userId },
      async () => {
        await owner.agent.patch(`/api/timeline-tracks/${updatedTrack.body.data.id}`).set("X-CSRF-Token", owner.csrfToken).send({
          description: "更新后的轨道说明。",
          expectedVersionNo: updatedTrack.body.data.versionNo
        }).expect(200);
      }
    );
    const removedTrack = await owner.agent.post(`/api/works/${workId}/timeline-tracks`).set("X-CSRF-Token", owner.csrfToken).send({
      name: "删除轨道"
    }).expect(201);
    await expectPublishedChange(
      { kind: "module", module: "timeline" },
      { pageKey: "module:timeline", label: "时间轴轨道", action: "delete", pageDeleted: false, actorUserId: trackDeleter.user.userId },
      async () => {
        await trackDeleter.agent.delete(`/api/timeline-tracks/${removedTrack.body.data.id}`).set("X-CSRF-Token", trackDeleter.csrfToken).send({
          expectedVersionNo: removedTrack.body.data.versionNo
        }).expect(204);
      }
    );

    const updatedEvent = await owner.agent.post(`/api/works/${workId}/timeline`).set("X-CSRF-Token", owner.csrfToken).send({
      name: "更新事件"
    }).expect(201);
    await expectPublishedChange(
      { kind: "module", module: "timeline" },
      { pageKey: "module:timeline", label: "时间轴", action: "save", pageDeleted: false, actorUserId: eventUpdater.user.userId },
      async () => {
        await eventUpdater.agent.patch(`/api/timeline/${updatedEvent.body.data.id}`).set("X-CSRF-Token", eventUpdater.csrfToken).send({
          description: "更新后的事件说明。",
          expectedVersionNo: updatedEvent.body.data.versionNo
        }).expect(200);
      }
    );
    const removedEvent = await owner.agent.post(`/api/works/${workId}/timeline`).set("X-CSRF-Token", owner.csrfToken).send({
      name: "删除事件"
    }).expect(201);
    await expectPublishedChange(
      { kind: "module", module: "timeline" },
      { pageKey: "module:timeline", label: "时间轴事件", action: "delete", pageDeleted: false, actorUserId: eventDeleter.user.userId },
      async () => {
        await eventDeleter.agent.delete(`/api/timeline/${removedEvent.body.data.id}`).set("X-CSRF-Token", eventDeleter.csrfToken).send({
          expectedVersionNo: removedEvent.body.data.versionNo
        }).expect(204);
      }
    );
  });

  it("首个用户成为管理员，并完成作品邀请、共同编辑与越权拦截", async () => {
    await request(runtime.app).get("/api/works").expect(401);
    const initialSession = await request(runtime.app).get("/api/auth/session").expect(200);
    expect(initialSession.body.data).toMatchObject({
      authenticated: false,
      setupRequired: true,
      setupTokenRequired: true,
      registrationOpen: true
    });

    const invalidSetupCaptcha = await solveCaptcha(runtime.app);
    const invalidSetup = await request(runtime.app).post("/api/auth/register").send({
      username: "attacker",
      password: "secure-password-123",
      passwordConfirmation: "secure-password-123",
      setupToken: "incorrect-setup-token-with-at-least-32-characters",
      ...invalidSetupCaptcha
    }).expect(403);
    expect(invalidSetup.body.error.code).toBe("SETUP_TOKEN_INVALID");

    const admin = await register(runtime, "admin");
    const writer = await register(runtime, "writer");
    expect(admin.user.role).toBe("admin");
    expect(writer.user.role).toBe("user");

    const adminWork = await admin.agent.post("/api/works").set("X-CSRF-Token", admin.csrfToken).send({ title: "管理员作品" }).expect(201);
    const writerWork = await writer.agent.post("/api/works").set("X-CSRF-Token", writer.csrfToken).send({ title: "作者作品" }).expect(201);
    const adminWorkId = adminWork.body.data.id;
    const writerWorkId = writerWork.body.data.id;

    const privateWorks = await writer.agent.get("/api/works").expect(200);
    expect(privateWorks.body.data.map((work: { id: string }) => work.id)).toEqual([writerWorkId]);
    await writer.agent.get(`/api/works/${adminWorkId}`).expect(403);

    await admin.agent.post(`/api/works/${adminWorkId}/members`).set("X-CSRF-Token", admin.csrfToken).send({ userId: writer.user.userId, role: "editor" }).expect(201);
    const sharedWorks = await writer.agent.get("/api/works").expect(200);
    expect(new Set(sharedWorks.body.data.map((work: { id: string }) => work.id))).toEqual(new Set([adminWorkId, writerWorkId]));

    const volume = await admin.agent.post(`/api/works/${adminWorkId}/volumes`).set("X-CSRF-Token", admin.csrfToken).send({ title: "正文" }).expect(201);
    const chapter = await admin.agent.post(`/api/works/${adminWorkId}/chapters`).set("X-CSRF-Token", admin.csrfToken).send({
      volumeId: volume.body.data.id,
      title: "第一章",
      content: "初稿。"
    }).expect(201);
    await writer.agent.patch(`/api/chapters/${chapter.body.data.id}`).set("X-CSRF-Token", writer.csrfToken).send({ content: "协作修改。" }).expect(200);

    const versions = await writer.agent.get(`/api/chapters/${chapter.body.data.id}/versions`).expect(200);
    expect(versions.body.data[0]).toMatchObject({ versionNo: 2, actor: "writer" });
    const auditLogs = await admin.agent.get(`/api/works/${adminWorkId}/audit-logs`).expect(200);
    expect(auditLogs.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "chapter.saved", actor: "writer", userId: writer.user.userId })
    ]));

    await writer.agent.delete(`/api/works/${adminWorkId}`).set("X-CSRF-Token", writer.csrfToken).expect(403);
    await writer.agent.get("/api/platform/ai/providers").expect(403);
    await writer.agent.get("/api/platform/ai/usage").expect(403);
    await writer.agent.get(`/api/works/${adminWorkId}/ai-settings/usage`).expect(200);
    await writer.agent.patch(`/api/chapters/${chapter.body.data.id}`).send({ content: "缺少 CSRF。" }).expect(403);
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("人物关系增量索引同步校验登录、CSRF 和 AI 设置写权限", async () => {
    const owner = await register(runtime, "relationship_index_owner");
    const viewer = await register(runtime, "relationship_index_viewer");
    const work = await owner.agent.post("/api/works")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "索引同步权限测试" })
      .expect(201);
    const workId = String(work.body.data.id);
    await owner.agent.post(`/api/works/${workId}/members`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ userId: viewer.user.userId, role: "viewer" })
      .expect(201);

    await request(runtime.app)
      .get(`/api/works/${workId}/ai-settings/relationship-search-index`)
      .expect(401);
    await viewer.agent
      .get(`/api/works/${workId}/ai-settings/relationship-search-index`)
      .expect(200);
    const viewerWrite = await viewer.agent
      .post(`/api/works/${workId}/ai-settings/relationship-search-index/sync`)
      .set("X-CSRF-Token", viewer.csrfToken)
      .send({})
      .expect(403);
    expect(viewerWrite.body.error.code).toBe("WORK_EDIT_DENIED");
    const missingCsrf = await owner.agent
      .post(`/api/works/${workId}/ai-settings/relationship-search-index/sync`)
      .send({})
      .expect(403);
    expect(missingCsrf.body.error.code).toBe("CSRF_TOKEN_INVALID");
    await owner.agent
      .post(`/api/works/${workId}/ai-settings/relationship-search-index/sync`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({})
      .expect(202);
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("角色收藏接口校验登录、CSRF 和角色写权限", async () => {
    const owner = await register(runtime, "character_favorite_owner");
    const viewer = await register(runtime, "character_favorite_viewer");
    const editor = await register(runtime, "character_favorite_editor");
    const work = await owner.agent.post("/api/works")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "角色收藏权限测试" })
      .expect(201);
    const workId = String(work.body.data.id);
    await owner.agent.post(`/api/works/${workId}/members`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ userId: viewer.user.userId, role: "viewer" })
      .expect(201);
    await owner.agent.post(`/api/works/${workId}/members`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ userId: editor.user.userId, role: "editor" })
      .expect(201);
    const character = await owner.agent.post(`/api/works/${workId}/characters`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ name: "林舟" })
      .expect(201);
    const endpoint = `/api/characters/${String(character.body.data.id)}/favorite`;

    await request(runtime.app).patch(endpoint).send({ isFavorite: true }).expect(401);
    const missingCsrf = await owner.agent.patch(endpoint).send({ isFavorite: true }).expect(403);
    expect(missingCsrf.body.error.code).toBe("CSRF_TOKEN_INVALID");
    const viewerDenied = await viewer.agent.patch(endpoint)
      .set("X-CSRF-Token", viewer.csrfToken)
      .send({ isFavorite: true })
      .expect(403);
    expect(viewerDenied.body.error.code).toBe("WORK_EDIT_DENIED");
    const updated = await editor.agent.patch(endpoint)
      .set("X-CSRF-Token", editor.csrfToken)
      .send({ isFavorite: true })
      .expect(200);
    expect(updated.body.data).toMatchObject({ id: character.body.data.id, isFavorite: true });
  });

  it("资料收藏接口校验登录、CSRF 和对应模块写权限", async () => {
    const owner = await register(runtime, "record_favorites_owner");
    const viewer = await register(runtime, "record_favorites_viewer");
    const editor = await register(runtime, "record_favorites_editor");
    const work = await owner.agent.post("/api/works")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "资料收藏权限测试" })
      .expect(201);
    const workId = String(work.body.data.id);
    await owner.agent.post(`/api/works/${workId}/members`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ userId: viewer.user.userId, role: "viewer" })
      .expect(201);
    await owner.agent.post(`/api/works/${workId}/members`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ userId: editor.user.userId, role: "editor" })
      .expect(201);
    const draft = await owner.agent.post(`/api/works/${workId}/drafts`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ draftType: "prose", title: "权限想法", content: "" })
      .expect(201);
    const setting = await owner.agent.post(`/api/works/${workId}/settings`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "权限设定", category: "规则", content: "权限测试内容" })
      .expect(201);
    const organization = await owner.agent.post(`/api/works/${workId}/organizations`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ name: "权限组织" })
      .expect(201);
    const endpoints = [
      `/api/drafts/${String(draft.body.data.id)}/favorite`,
      `/api/settings/${String(setting.body.data.id)}/favorite`,
      `/api/organizations/${String(organization.body.data.id)}/favorite`
    ];

    for (const endpoint of endpoints) {
      await request(runtime.app).patch(endpoint).send({ isFavorite: true }).expect(401);
      const missingCsrf = await owner.agent.patch(endpoint).send({ isFavorite: true }).expect(403);
      expect(missingCsrf.body.error.code).toBe("CSRF_TOKEN_INVALID");
      const viewerDenied = await viewer.agent.patch(endpoint)
        .set("X-CSRF-Token", viewer.csrfToken)
        .send({ isFavorite: true })
        .expect(403);
      expect(viewerDenied.body.error.code).toBe("WORK_EDIT_DENIED");
      const updated = await editor.agent.patch(endpoint)
        .set("X-CSRF-Token", editor.csrfToken)
        .send({ isFavorite: true })
        .expect(200);
      expect(updated.body.data.isFavorite).toBe(true);
    }
  });

  it("按用户在数据库中记录新手引导完成状态", async () => {
    const firstUser = await register(runtime, "onboarding_first");
    const secondUser = await register(runtime, "onboarding_second");
    expect(firstUser.user).toMatchObject({ onboardingCompleted: false });
    expect(secondUser.user).toMatchObject({ onboardingCompleted: false });

    await firstUser.agent.post("/api/auth/onboarding/complete").send({}).expect(403);
    const completed = await firstUser.agent
      .post("/api/auth/onboarding/complete")
      .set("X-CSRF-Token", firstUser.csrfToken)
      .send({})
      .expect(200);
    expect(completed.body.data).toMatchObject({ userId: firstUser.user.userId, onboardingCompleted: true });
    expect(runtime.database.get(
      "SELECT onboarding_completed_at IS NOT NULL AS completed FROM users WHERE id = ?",
      firstUser.user.userId
    )).toEqual({ completed: 1 });

    const session = await firstUser.agent.get("/api/auth/session").expect(200);
    expect(session.body.data.user.onboardingCompleted).toBe(true);
    const otherSession = await secondUser.agent.get("/api/auth/session").expect(200);
    expect(otherSession.body.data.user.onboardingCompleted).toBe(false);
  });

  it("服务器重启后使旧网页会话失效并要求重新登录", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-auth-restart-"));
    const databasePath = join(root, "novel.db");
    let firstRuntime: Runtime | null = null;
    let restartedRuntime: Runtime | null = null;
    try {
      firstRuntime = createRuntime({
        databasePath,
        masterSecret: "user-auth-restart-test-master-secret-with-enough-length",
        serveUi: false,
        revealCaptchaAnswer: true,
        security: { allowRegistration: true, enforceSameOrigin: true, setupToken }
      });
      const user = await register(firstRuntime, "restart_user");
      await user.agent.get("/api/auth/session").expect(200);
      await firstRuntime.close();
      firstRuntime = null;

      restartedRuntime = createRuntime({
        databasePath,
        masterSecret: "user-auth-restart-test-master-secret-with-enough-length",
        serveUi: false,
        revealCaptchaAnswer: true,
        security: { allowRegistration: true, enforceSameOrigin: true, setupToken }
      });
      const expiredSession = await request(restartedRuntime.app)
        .get("/api/auth/session")
        .set("Cookie", user.cookie)
        .expect(200);
      expect(expiredSession.body.data).toMatchObject({ authenticated: false, user: null, csrfToken: null });
      await request(restartedRuntime.app).get("/api/works").set("Cookie", user.cookie).expect(401);

      const captcha = await solveCaptcha(restartedRuntime.app);
      await request(restartedRuntime.app).post("/api/auth/login").send({
        username: "restart_user",
        password: "secure-password-123",
        ...captcha
      }).expect(200);
    } finally {
      await restartedRuntime?.close();
      await firstRuntime?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("他人重复输错密码不会锁定目标账户", async () => {
    await register(runtime, "available_user");
    for (let index = 0; index < 8; index += 1) {
      const response = await submitLogin(runtime, index % 2 === 0 ? "AVAILABLE_USER" : "available_user", "wrong-password");
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("INVALID_CREDENTIALS");
    }

    const successful = await submitLogin(runtime, "available_user", "secure-password-123");
    expect(successful.status).toBe(200);
    expect(runtime.database.get(
      "SELECT COUNT(*) AS count FROM login_attempts WHERE normalized_username = ?",
      "available_user"
    )?.count).toBe(0);
  });

  it("仅查看成员可读取正文和设定，但所有作品写操作都会被拒绝", async () => {
    const owner = await register(runtime, "viewer_owner");
    const viewer = await register(runtime, "readonly_guest");
    const workResponse = await owner.agent.post("/api/works")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "只读测试作品" })
      .expect(201);
    const workId = String(workResponse.body.data.id);
    const volume = await owner.agent.post(`/api/works/${workId}/volumes`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "正文" })
      .expect(201);
    const chapter = await owner.agent.post(`/api/works/${workId}/chapters`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ volumeId: volume.body.data.id, title: "第一章", content: "只能阅读的正文。" })
      .expect(201);
    const setting = await owner.agent.post(`/api/works/${workId}/settings`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "潮汐规则", category: "世界规则", content: "月升时开启航道。" })
      .expect(201);
    const firstCharacter = await owner.agent.post(`/api/works/${workId}/characters`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ name: "林舟" })
      .expect(201);
    const secondCharacter = await owner.agent.post(`/api/works/${workId}/characters`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ name: "林船长" })
      .expect(201);

    const invited = await owner.agent.post(`/api/works/${workId}/members`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ userId: viewer.user.userId, role: "viewer" })
      .expect(201);
    expect(invited.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: viewer.user.userId, role: "viewer" })
    ]));

    const works = await viewer.agent.get("/api/works").expect(200);
    expect(works.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: workId, accessRole: "viewer" })
    ]));
    const workTree = await viewer.agent.get(`/api/works/${workId}`).expect(200);
    expect(workTree.body.data.volumes[0].chapters[0]).toMatchObject({ id: chapter.body.data.id, title: "第一章" });
    const visibleChapter = await viewer.agent.get(`/api/chapters/${chapter.body.data.id}`).expect(200);
    expect(visibleChapter.body.data.content).toBe("只能阅读的正文。");
    const settings = await viewer.agent.get(`/api/works/${workId}/settings?includeContent=true`).expect(200);
    expect(settings.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: setting.body.data.id, content: "月升时开启航道。" })
    ]));

    const chapterWrite = await viewer.agent.patch(`/api/chapters/${chapter.body.data.id}`)
      .set("X-CSRF-Token", viewer.csrfToken)
      .send({ content: "越权修改。" })
      .expect(403);
    expect(chapterWrite.body.error.code).toBe("WORK_EDIT_DENIED");
    await viewer.agent.post(`/api/works/${workId}/settings`)
      .set("X-CSRF-Token", viewer.csrfToken)
      .send({ title: "越权设定", category: "世界规则", content: "不应创建。" })
      .expect(403);
    const chapterVersionsBeforeMissingScopeReplace = Number(runtime.database.get(
      "SELECT COUNT(*) AS count FROM chapter_versions WHERE chapter_id = ?",
      chapter.body.data.id
    )?.count);
    const missingScopeReplace = await viewer.agent.post(`/api/works/${workId}/replace`)
      .set("X-CSRF-Token", viewer.csrfToken)
      .send({ find: "只能阅读", replacement: "越权替换" })
      .expect(400);
    expect(missingScopeReplace.body.error.code).toBe("VALIDATION_ERROR");
    expect(runtime.database.get("SELECT content FROM chapters WHERE id = ?", chapter.body.data.id)?.content).toBe("只能阅读的正文。");
    expect(Number(runtime.database.get(
      "SELECT COUNT(*) AS count FROM chapter_versions WHERE chapter_id = ?",
      chapter.body.data.id
    )?.count)).toBe(chapterVersionsBeforeMissingScopeReplace);
    const replaceWrite = await viewer.agent.post(`/api/works/${workId}/replace`)
      .set("X-CSRF-Token", viewer.csrfToken)
      .send({ find: "只能阅读", replacement: "越权替换", scope: "prose-and-settings" })
      .expect(403);
    expect(replaceWrite.body.error.code).toBe("WORK_EDIT_DENIED");
    const mergeBody = {
      targetCharacterId: firstCharacter.body.data.id,
      expectedTargetVersionNo: firstCharacter.body.data.versionNo,
      expectedSourceVersionNo: secondCharacter.body.data.versionNo
    };
    await viewer.agent.post(`/api/characters/${secondCharacter.body.data.id}/merge`)
      .set("X-CSRF-Token", viewer.csrfToken)
      .send(mergeBody)
      .expect(403);
    await owner.agent.post(`/api/characters/${secondCharacter.body.data.id}/merge`)
      .send(mergeBody)
      .expect(403);
    await viewer.agent.patch(`/api/works/${workId}/members/${viewer.user.userId}`)
      .set("X-CSRF-Token", viewer.csrfToken)
      .send({ role: "editor" })
      .expect(403);
    expect(runtime.database.get("SELECT content FROM chapters WHERE id = ?", chapter.body.data.id)?.content).toBe("只能阅读的正文。");

    const promoted = await owner.agent.patch(`/api/works/${workId}/members/${viewer.user.userId}`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ role: "editor" })
      .expect(200);
    expect(promoted.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: viewer.user.userId, role: "editor" })
    ]));
    await viewer.agent.patch(`/api/chapters/${chapter.body.data.id}`)
      .set("X-CSRF-Token", viewer.csrfToken)
      .send({ content: "获得编辑权限后的修改。" })
      .expect(200);
    const editorReplace = await viewer.agent.post(`/api/works/${workId}/replace`)
      .set("X-CSRF-Token", viewer.csrfToken)
      .send({ find: "获得编辑权限", replacement: "完整编辑权限", scope: "prose" })
      .expect(200);
    expect(editorReplace.body.data).toMatchObject({ scope: "prose", chapterCount: 1, totalMatches: 1 });
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("设定编辑可维护设定集，但不能修改分卷、正文和作品配置", async () => {
    const owner = await register(runtime, "settings_owner");
    const collaborator = await register(runtime, "settings_editor");
    const work = await owner.agent.post("/api/works")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "设定协作测试" })
      .expect(201);
    const workId = String(work.body.data.id);
    const volume = await owner.agent.post(`/api/works/${workId}/volumes`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "正文" })
      .expect(201);
    const chapter = await owner.agent.post(`/api/works/${workId}/chapters`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ volumeId: volume.body.data.id, title: "第一章", content: "原始正文。" })
      .expect(201);

    const invited = await owner.agent.post(`/api/works/${workId}/members`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ userId: collaborator.user.userId, role: "settings-editor" })
      .expect(201);
    expect(invited.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: collaborator.user.userId, role: "settings-editor" })
    ]));
    const storedMembership = runtime.database.get(
      "SELECT role, permissions_json FROM work_memberships WHERE work_id = ? AND user_id = ?",
      workId,
      collaborator.user.userId
    );
    expect(storedMembership?.role).toBe("editor");
    expect(JSON.parse(String(storedMembership?.permissions_json))).toMatchObject({
      modules: { prose: "read", settings: "write", characters: "write", "ai-chat": "read", "ai-analysis": "read" }
    });

    const works = await collaborator.agent.get("/api/works").expect(200);
    expect(works.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: workId, accessRole: "settings-editor" })
    ]));
    const setting = await collaborator.agent.post(`/api/works/${workId}/settings`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ title: "潮汐规则", category: "世界规则", content: "月升时航道开启。" })
      .expect(201);
    await collaborator.agent.patch(`/api/settings/${setting.body.data.id}`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ content: "双月同时升起时航道开启。", changeNote: "修正开启条件" })
      .expect(200);
    await collaborator.agent.put(`/api/chapters/${chapter.body.data.id}/outline`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ goal: "确认航道规则", conflict: "双月并未同时升起", status: "ready" })
      .expect(200);

    const chapterWrite = await collaborator.agent.patch(`/api/chapters/${chapter.body.data.id}`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ content: "不应写入的正文。" })
      .expect(403);
    expect(chapterWrite.body.error.code).toBe("WORK_PROSE_EDIT_DENIED");
    const volumeWrite = await collaborator.agent.patch(`/api/volumes/${volume.body.data.id}`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ title: "不应修改的分卷" })
      .expect(403);
    expect(volumeWrite.body.error.code).toBe("WORK_PROSE_EDIT_DENIED");
    const taskWrite = await collaborator.agent.post(`/api/works/${workId}/tasks`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ taskType: "book-analysis" })
      .expect(403);
    expect(taskWrite.body.error.code).toBe("WORK_PROSE_EDIT_DENIED");
    await collaborator.agent.patch(`/api/works/${workId}`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ title: "不应修改的作品名" })
      .expect(403);
    expect(runtime.database.get("SELECT content FROM chapters WHERE id = ?", chapter.body.data.id)?.content).toBe("原始正文。");

    const promoted = await owner.agent.patch(`/api/works/${workId}/members/${collaborator.user.userId}`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ role: "editor" })
      .expect(200);
    expect(promoted.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: collaborator.user.userId, role: "editor" })
    ]));
    expect(JSON.parse(String(runtime.database.get(
      "SELECT permissions_json FROM work_memberships WHERE work_id = ? AND user_id = ?",
      workId,
      collaborator.user.userId
    )?.permissions_json))).toMatchObject({ modules: { prose: "write", settings: "write", "ai-chat": "write", "ai-analysis": "write" } });
    await collaborator.agent.patch(`/api/chapters/${chapter.body.data.id}`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ content: "完整协作权限可以修改正文。" })
      .expect(200);
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("章节大纲看板按作品与大纲模块权限隔离，且不扩大正文读取权限", async () => {
    const owner = await register(runtime, "outline_board_owner");
    const reader = await register(runtime, "outline_board_reader");
    const outsider = await register(runtime, "outline_board_outsider");
    const work = await owner.agent.post("/api/works")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "大纲看板权限作品" })
      .expect(201);
    const workId = String(work.body.data.id);
    const volume = await owner.agent.post(`/api/works/${workId}/volumes`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "第一卷" })
      .expect(201);
    const chapter = await owner.agent.post(`/api/works/${workId}/chapters`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ volumeId: volume.body.data.id, title: "保密章节标题", content: "PROSE_CONTENT_SECRET" })
      .expect(201);
    await owner.agent.put(`/api/chapters/${chapter.body.data.id}/outline`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ goal: "OUTLINE_BOARD_SECRET", status: "ready" })
      .expect(200);
    const noAccess = {
      prose: "none",
      drafts: "none",
      settings: "none",
      characters: "none",
      races: "none",
      organizations: "none",
      timeline: "none",
      relationships: "none",
      outlines: "none",
      reviews: "none",
      "ai-chat": "none",
      "ai-analysis": "none",
      "ai-settings": "none"
    };
    await owner.agent.post(`/api/works/${workId}/members`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ userId: reader.user.userId, permissions: { ...noAccess, outlines: "read" } })
      .expect(201);

    const board = await reader.agent.get(`/api/works/${workId}/outline-board`).expect(200);
    expect(board.body.data.volumes[0].chapters[0]).toMatchObject({
      id: chapter.body.data.id,
      title: "保密章节标题",
      outline: { goal: "OUTLINE_BOARD_SECRET", status: "ready" }
    });
    expect(JSON.stringify(board.body.data)).not.toContain("PROSE_CONTENT_SECRET");
    const proseDenied = await reader.agent.get(`/api/chapters/${chapter.body.data.id}`).expect(403);
    expect(proseDenied.body.error.code).toBe("WORK_MODULE_READ_DENIED");
    const writeDenied = await reader.agent.put(`/api/chapters/${chapter.body.data.id}/outline`)
      .set("X-CSRF-Token", reader.csrfToken)
      .send({ goal: "不应写入" })
      .expect(403);
    expect(writeDenied.body.error.code).toBe("WORK_MODULE_WRITE_DENIED");

    const outsiderDenied = await outsider.agent.get(`/api/works/${workId}/outline-board`).expect(403);
    expect(outsiderDenied.body.error.code).toBe("WORK_ACCESS_DENIED");
    expect(JSON.stringify(outsiderDenied.body)).not.toContain("OUTLINE_BOARD_SECRET");
    await owner.agent.patch(`/api/works/${workId}/members/${reader.user.userId}`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ permissions: noAccess })
      .expect(200);
    const revoked = await reader.agent.get(`/api/works/${workId}/outline-board`).expect(403);
    expect(revoked.body.error.code).toBe("WORK_MODULE_READ_DENIED");
  });

  it("管理员可按成员配置模块读写权限，并在 API 层拒绝跨模块访问", async () => {
    const owner = await register(runtime, "module_owner");
    const collaborator = await register(runtime, "module_collaborator");
    const outsider = await register(runtime, "module_outsider");
    const work = await owner.agent.post("/api/works")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "模块权限测试" })
      .expect(201);
    const workId = String(work.body.data.id);
    const volume = await owner.agent.post(`/api/works/${workId}/volumes`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "正文" })
      .expect(201);
    const chapter = await owner.agent.post(`/api/works/${workId}/chapters`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ volumeId: volume.body.data.id, title: "第一章", content: "模块权限正文，双向词。" })
      .expect(201);
    const outsiderReplace = await outsider.agent.post(`/api/works/${workId}/replace`)
      .set("X-CSRF-Token", outsider.csrfToken)
      .send({ find: "模块权限", replacement: "越权替换", scope: "prose-and-settings" })
      .expect(403);
    expect(outsiderReplace.body.error.code).toBe("WORK_ACCESS_DENIED");
    expect(runtime.database.get("SELECT content FROM chapters WHERE id = ?", chapter.body.data.id)?.content)
      .toBe("模块权限正文，双向词。");
    const fileVersionId = "file_module_permission_history";
    runtime.database.run(
      `INSERT INTO file_versions (id, work_id, file_name, file_type, word_count, paragraph_count, warnings_json, snapshot_json, created_at, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      fileVersionId,
      workId,
      "module-permission.txt",
      "txt",
      0,
      0,
      "[]",
      JSON.stringify(runtime.store.getWorkTree(workId)),
      new Date().toISOString(),
      owner.user.userId
    );
    const ownerFileVersions = await owner.agent.get(`/api/works/${workId}/file-versions`).expect(200);
    expect(ownerFileVersions.body.data[0].id).toBe(fileVersionId);

    const permissions = {
      prose: "read",
      comments: "read",
      todos: "read",
      drafts: "read",
      settings: "write",
      characters: "none",
      races: "none",
      organizations: "none",
      timeline: "read",
      relationships: "none",
      outlines: "read",
      reviews: "none",
      "ai-chat": "none",
      "ai-analysis": "none",
      "ai-settings": "none"
    };
    const invited = await owner.agent.post(`/api/works/${workId}/members`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ userId: collaborator.user.userId, permissions })
      .expect(201);
    expect(invited.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: collaborator.user.userId, role: "custom", permissions })
    ]));

    const listedWorks = await collaborator.agent.get("/api/works").expect(200);
    expect(listedWorks.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: workId, accessRole: "custom", modulePermissions: permissions })
    ]));
    const workTree = await collaborator.agent.get(`/api/works/${workId}`).expect(200);
    expect(workTree.body.data.volumes[0].chapters[0].title).toBe("第一章");
    await collaborator.agent.get(`/api/chapters/${chapter.body.data.id}`).expect(200);
    const proseWriteDenied = await collaborator.agent.patch(`/api/chapters/${chapter.body.data.id}`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ content: "不应写入。" })
      .expect(403);
    expect(proseWriteDenied.body.error.code).toBe("WORK_MODULE_WRITE_DENIED");
    const proseImportDenied = await collaborator.agent.post(`/api/works/${workId}/import`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .attach("file", Buffer.from("第一章\n\n不应导入。"), "readonly.txt")
      .expect(403);
    expect(proseImportDenied.body.error.code).toBe("WORK_MODULE_WRITE_DENIED");
    const readableFileVersions = await collaborator.agent.get(`/api/works/${workId}/file-versions`).expect(200);
    expect(readableFileVersions.body.data[0].id).toBe(fileVersionId);
    const restoreDenied = await collaborator.agent
      .post(`/api/works/${workId}/file-versions/${fileVersionId}/restore`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({})
      .expect(403);
    expect(restoreDenied.body.error.code).toBe("WORK_MODULE_WRITE_DENIED");

    const editableSetting = await collaborator.agent.post(`/api/works/${workId}/settings`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ title: "可编辑设定", category: "世界规则", content: "模块权限设定，双向词，允许写入。" })
      .expect(201);
    const editableSettingId = String(editableSetting.body.data.id);
    const settingsReplace = await collaborator.agent.post(`/api/works/${workId}/replace`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ find: "允许", replacement: "已经", scope: "settings" })
      .expect(200);
    expect(settingsReplace.body.data).toMatchObject({ scope: "settings", settingCount: 1, totalMatches: 1 });
    const chapterVersionsBeforeDeniedProseReplace = Number(runtime.database.get(
      "SELECT COUNT(*) AS count FROM chapter_versions WHERE chapter_id = ?",
      chapter.body.data.id
    )?.count);
    const proseReplaceDenied = await collaborator.agent.post(`/api/works/${workId}/replace`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ find: "模块权限正文", replacement: "不应替换", scope: "prose" })
      .expect(403);
    expect(proseReplaceDenied.body.error.code).toBe("WORK_MODULE_WRITE_DENIED");
    expect(runtime.database.get("SELECT content FROM chapters WHERE id = ?", chapter.body.data.id)?.content)
      .toBe("模块权限正文，双向词。");
    expect(Number(runtime.database.get(
      "SELECT COUNT(*) AS count FROM chapter_versions WHERE chapter_id = ?",
      chapter.body.data.id
    )?.count)).toBe(chapterVersionsBeforeDeniedProseReplace);
    const chapterVersionsBeforeSettingsOnlyReplace = Number(runtime.database.get(
      "SELECT COUNT(*) AS count FROM chapter_versions WHERE chapter_id = ?",
      chapter.body.data.id
    )?.count);
    const combinedSettingsOnlyReplace = await collaborator.agent.post(`/api/works/${workId}/replace`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ find: "模块权限", replacement: "设定侧替换", scope: "prose-and-settings" })
      .expect(200);
    expect(combinedSettingsOnlyReplace.body.data).toMatchObject({
      scope: "prose-and-settings",
      processedModules: ["settings"],
      skippedModules: ["prose"],
      chapterCount: 0,
      settingCount: 1,
      totalMatches: 1
    });
    expect(runtime.database.get("SELECT content FROM chapters WHERE id = ?", chapter.body.data.id)?.content)
      .toBe("模块权限正文，双向词。");
    expect(runtime.database.get("SELECT content FROM settings WHERE id = ?", editableSettingId)?.content)
      .toBe("设定侧替换设定，双向词，已经写入。");
    expect(Number(runtime.database.get(
      "SELECT COUNT(*) AS count FROM chapter_versions WHERE chapter_id = ?",
      chapter.body.data.id
    )?.count)).toBe(chapterVersionsBeforeSettingsOnlyReplace);
    await collaborator.agent.get(`/api/works/${workId}/drafts`).expect(200);
    await collaborator.agent.post(`/api/works/${workId}/drafts`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ draftType: "prose", title: "只读草稿", content: "不应写入。" })
      .expect(403);
    const characterReadDenied = await collaborator.agent.get(`/api/works/${workId}/characters`).expect(403);
    expect(characterReadDenied.body.error).toMatchObject({ code: "WORK_MODULE_READ_DENIED" });
    await collaborator.agent.get(`/api/works/${workId}/timeline`).expect(200);
    await collaborator.agent.post(`/api/works/${workId}/timeline`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ name: "越权事件", timeLabel: "未知", timeSort: null })
      .expect(403);

    const updatedPermissions = { ...permissions, prose: "write", settings: "read" };
    const updated = await owner.agent.patch(`/api/works/${workId}/members/${collaborator.user.userId}`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ permissions: updatedPermissions })
      .expect(200);
    expect(updated.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: collaborator.user.userId, permissions: updatedPermissions })
    ]));
    await collaborator.agent.patch(`/api/chapters/${chapter.body.data.id}`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ content: "已授权正文编辑，双向词。" })
      .expect(200);
    const proseReplace = await collaborator.agent.post(`/api/works/${workId}/replace`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ find: "已授权正文", replacement: "已批量替换正文", scope: "prose" })
      .expect(200);
    expect(proseReplace.body.data).toMatchObject({ scope: "prose", chapterCount: 1, totalMatches: 1 });
    const settingVersionsBeforeProseOnlyReplace = Number(runtime.database.get(
      "SELECT COUNT(*) AS count FROM entity_versions WHERE entity_type = 'setting' AND entity_id = ?",
      editableSettingId
    )?.count);
    const combinedProseOnlyReplace = await collaborator.agent.post(`/api/works/${workId}/replace`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ find: "双向词", replacement: "正文侧替换", scope: "prose-and-settings" })
      .expect(200);
    expect(combinedProseOnlyReplace.body.data).toMatchObject({
      scope: "prose-and-settings",
      processedModules: ["prose"],
      skippedModules: ["settings"],
      chapterCount: 1,
      settingCount: 0,
      totalMatches: 1
    });
    expect(runtime.database.get("SELECT content FROM chapters WHERE id = ?", chapter.body.data.id)?.content)
      .toBe("已批量替换正文编辑，正文侧替换。");
    expect(runtime.database.get("SELECT content FROM settings WHERE id = ?", editableSettingId)?.content)
      .toBe("设定侧替换设定，双向词，已经写入。");
    expect(Number(runtime.database.get(
      "SELECT COUNT(*) AS count FROM entity_versions WHERE entity_type = 'setting' AND entity_id = ?",
      editableSettingId
    )?.count)).toBe(settingVersionsBeforeProseOnlyReplace);
    const settingVersionsBeforeDeniedSettingsReplace = Number(runtime.database.get(
      "SELECT COUNT(*) AS count FROM entity_versions WHERE entity_type = 'setting' AND entity_id = ?",
      editableSettingId
    )?.count);
    const settingsReplaceDenied = await collaborator.agent.post(`/api/works/${workId}/replace`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ find: "已经", replacement: "不应替换", scope: "settings" })
      .expect(403);
    expect(settingsReplaceDenied.body.error.code).toBe("WORK_MODULE_WRITE_DENIED");
    expect(runtime.database.get("SELECT content FROM settings WHERE id = ?", editableSettingId)?.content)
      .toBe("设定侧替换设定，双向词，已经写入。");
    expect(Number(runtime.database.get(
      "SELECT COUNT(*) AS count FROM entity_versions WHERE entity_type = 'setting' AND entity_id = ?",
      editableSettingId
    )?.count)).toBe(settingVersionsBeforeDeniedSettingsReplace);
    await collaborator.agent.post(`/api/works/${workId}/settings`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ title: "只读后越权", category: "世界规则", content: "不应写入。" })
      .expect(403);

    const versionCountBeforeDeniedReplacement = Number(runtime.database.get(
      "SELECT COUNT(*) AS count FROM file_versions WHERE work_id = ?",
      workId
    )?.count);
    const limitedRestore = await collaborator.agent
      .post(`/api/works/${workId}/file-versions/${fileVersionId}/restore`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({})
      .expect(403);
    expect(limitedRestore.body.error.code).toBe("WORK_MODULE_WRITE_DENIED");
    const limitedOverwrite = await collaborator.agent.post(`/api/works/${workId}/import`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .field("mode", "overwrite")
      .attach("file", Buffer.from("第一章\n\n不应覆盖。"), "limited-overwrite.txt")
      .expect(403);
    expect(limitedOverwrite.body.error.code).toBe("WORK_MODULE_WRITE_DENIED");
    const unchangedChapter = await collaborator.agent.get(`/api/chapters/${chapter.body.data.id}`).expect(200);
    expect(unchangedChapter.body.data.content).toBe("已批量替换正文编辑，正文侧替换。");
    expect(Number(runtime.database.get(
      "SELECT COUNT(*) AS count FROM file_versions WHERE work_id = ?",
      workId
    )?.count)).toBe(versionCountBeforeDeniedReplacement);
    await collaborator.agent.post(`/api/works/${workId}/import`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .field("mode", "append")
      .attach("file", Buffer.from("第二章\n\n允许追加。"), "limited-append.txt")
      .expect(201);

    const readOnlyReplacementPermissions = { ...updatedPermissions, prose: "read", settings: "read" };
    await owner.agent.patch(`/api/works/${workId}/members/${collaborator.user.userId}`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ permissions: readOnlyReplacementPermissions })
      .expect(200);
    const chapterVersionsBeforeReadOnlyReplace = Number(runtime.database.get(
      "SELECT COUNT(*) AS count FROM chapter_versions WHERE chapter_id = ?",
      chapter.body.data.id
    )?.count);
    const settingVersionsBeforeReadOnlyReplace = Number(runtime.database.get(
      "SELECT COUNT(*) AS count FROM entity_versions WHERE entity_type = 'setting' AND entity_id = ?",
      editableSettingId
    )?.count);
    const missingScopeReplace = await collaborator.agent.post(`/api/works/${workId}/replace`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ find: "正文侧替换", replacement: "不应替换" })
      .expect(400);
    expect(missingScopeReplace.body.error.code).toBe("VALIDATION_ERROR");
    expect(runtime.database.get("SELECT content FROM chapters WHERE id = ?", chapter.body.data.id)?.content)
      .toBe("已批量替换正文编辑，正文侧替换。");
    expect(Number(runtime.database.get(
      "SELECT COUNT(*) AS count FROM chapter_versions WHERE chapter_id = ?",
      chapter.body.data.id
    )?.count)).toBe(chapterVersionsBeforeReadOnlyReplace);
    const combinedReplaceDenied = await collaborator.agent.post(`/api/works/${workId}/replace`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ find: "正文侧替换", replacement: "不应替换", scope: "prose-and-settings" })
      .expect(403);
    expect(combinedReplaceDenied.body.error.code).toBe("WORK_MODULE_WRITE_DENIED");
    const invalidScopeReplace = await collaborator.agent.post(`/api/works/${workId}/replace`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ find: "正文侧替换", replacement: "不应替换", scope: "unknown" })
      .expect(400);
    expect(invalidScopeReplace.body.error.code).toBe("VALIDATION_ERROR");
    expect(runtime.database.get("SELECT content FROM chapters WHERE id = ?", chapter.body.data.id)?.content)
      .toBe("已批量替换正文编辑，正文侧替换。");
    expect(runtime.database.get("SELECT content FROM settings WHERE id = ?", editableSettingId)?.content)
      .toBe("设定侧替换设定，双向词，已经写入。");
    expect(Number(runtime.database.get(
      "SELECT COUNT(*) AS count FROM chapter_versions WHERE chapter_id = ?",
      chapter.body.data.id
    )?.count)).toBe(chapterVersionsBeforeReadOnlyReplace);
    expect(Number(runtime.database.get(
      "SELECT COUNT(*) AS count FROM entity_versions WHERE entity_type = 'setting' AND entity_id = ?",
      editableSettingId
    )?.count)).toBe(settingVersionsBeforeReadOnlyReplace);

    await collaborator.agent
      .post(`/api/works/${workId}/file-versions/${fileVersionId}/restore`)
      .send({})
      .expect(403);
    const fullPermissions = Object.fromEntries(Object.keys(updatedPermissions).map((module) => [module, "write"]));
    await owner.agent.patch(`/api/works/${workId}/members/${collaborator.user.userId}`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ permissions: fullPermissions })
      .expect(200);
    const currentWork = await collaborator.agent.get(`/api/works/${workId}`).expect(200);
    const versionCountBeforeConflict = Number(runtime.database.get(
      "SELECT COUNT(*) AS count FROM file_versions WHERE work_id = ?",
      workId
    )?.count);
    const conflict = await collaborator.agent
      .post(`/api/works/${workId}/file-versions/${fileVersionId}/restore`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ expectedVersionNo: Number(currentWork.body.data.versionNo) + 1 })
      .expect(409);
    expect(conflict.body.error.code).toBe("VERSION_CONFLICT");
    expect(Number(runtime.database.get(
      "SELECT COUNT(*) AS count FROM file_versions WHERE work_id = ?",
      workId
    )?.count)).toBe(versionCountBeforeConflict);
    const restored = await collaborator.agent
      .post(`/api/works/${workId}/file-versions/${fileVersionId}/restore`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ expectedVersionNo: currentWork.body.data.versionNo })
      .expect(200);
    expect(restored.body.data.restoredFrom).toBe(fileVersionId);

    await owner.agent.patch(`/api/works/${workId}/members/${collaborator.user.userId}`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ permissions: { ...updatedPermissions, prose: "invalid" } })
      .expect(400);
    await collaborator.agent.patch(`/api/works/${workId}/members/${collaborator.user.userId}`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ permissions: updatedPermissions })
      .expect(403);
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("正文评论与待办分别受独立模块权限控制且读取结果按模块过滤", async () => {
    const owner = await register(runtime, "annotation_permission_owner");
    const collaborator = await register(runtime, "annotation_permission_collaborator");
    const work = await owner.agent.post("/api/works")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "正文批注权限作品" })
      .expect(201);
    const workId = String(work.body.data.id);
    const volume = await owner.agent.post(`/api/works/${workId}/volumes`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "正文" })
      .expect(201);
    const chapter = await owner.agent.post(`/api/works/${workId}/chapters`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ volumeId: volume.body.data.id, title: "第一章", content: "第一行正文。\n第二行正文。" })
      .expect(201);
    const chapterId = String(chapter.body.data.id);
    const ownerNote = await owner.agent.post(`/api/chapters/${chapterId}/annotations`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ kind: "note", startLine: 1, endLine: 1, note: "作者评论" })
      .expect(201);
    const ownerTodo = await owner.agent.post(`/api/chapters/${chapterId}/annotations`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ kind: "todo", startLine: 2, endLine: 2, note: "作者待办" })
      .expect(201);
    const commentOnly = {
      prose: "read",
      comments: "write",
      todos: "none",
      drafts: "none",
      settings: "none",
      characters: "none",
      races: "none",
      organizations: "none",
      timeline: "none",
      relationships: "none",
      outlines: "none",
      reviews: "none",
      "ai-chat": "none",
      "ai-analysis": "none",
      "ai-settings": "none"
    } as const;
    await owner.agent.post(`/api/works/${workId}/members`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ userId: collaborator.user.userId, permissions: commentOnly })
      .expect(201);

    const visibleAnnotations = await collaborator.agent.get(`/api/chapters/${chapterId}/annotations`).expect(200);
    expect(visibleAnnotations.body.data).toEqual([
      expect.objectContaining({ id: ownerNote.body.data.id, kind: "note" })
    ]);
    const visibleCounts = await collaborator.agent.get(`/api/chapters/${chapterId}/annotation-counts`).expect(200);
    expect(visibleCounts.body.data).toEqual([{ line: 1, count: 1 }]);
    const visibleWorkAnnotations = await collaborator.agent.get(`/api/works/${workId}/chapter-annotations?page=1&limit=30`).expect(200);
    expect(visibleWorkAnnotations.body.data.items).toEqual([
      expect.objectContaining({ id: ownerNote.body.data.id, kind: "note" })
    ]);
    const collaboratorNote = await collaborator.agent.post(`/api/chapters/${chapterId}/annotations`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ kind: "note", startLine: 1, endLine: 1, note: "协作者评论" })
      .expect(201);
    const todoCreateDenied = await collaborator.agent.post(`/api/chapters/${chapterId}/annotations`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ kind: "todo", startLine: 1, endLine: 1, note: "不应创建的待办" })
      .expect(403);
    expect(todoCreateDenied.body.error.code).toBe("WORK_MODULE_WRITE_DENIED");
    const commentUpdateDenied = await collaborator.agent.patch(`/api/chapter-annotations/${ownerNote.body.data.id}`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ status: "resolved", expectedVersionNo: ownerNote.body.data.versionNo })
      .expect(403);
    expect(commentUpdateDenied.body.error.code).toBe("WORK_MODULE_WRITE_DENIED");
    const ownCommentDeleteDenied = await collaborator.agent.delete(`/api/chapter-annotations/${collaboratorNote.body.data.id}`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ expectedVersionNo: collaboratorNote.body.data.versionNo })
      .expect(403);
    expect(ownCommentDeleteDenied.body.error.code).toBe("WORK_MODULE_WRITE_DENIED");

    const addOnly = { ...commentOnly, todos: "write" };
    await owner.agent.patch(`/api/works/${workId}/members/${collaborator.user.userId}`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ permissions: addOnly })
      .expect(200);
    const visibleAllAnnotations = await collaborator.agent.get(`/api/chapters/${chapterId}/annotations`).expect(200);
    expect(visibleAllAnnotations.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: ownerNote.body.data.id, kind: "note" }),
      expect.objectContaining({ id: ownerTodo.body.data.id, kind: "todo" })
    ]));
    const collaboratorTodo = await collaborator.agent.post(`/api/chapters/${chapterId}/annotations`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ kind: "todo", startLine: 2, endLine: 2, note: "协作者待办" })
      .expect(201);
    const visibleTodosAcrossCreators = await collaborator.agent.get(`/api/chapters/${chapterId}/annotations`).expect(200);
    expect(visibleTodosAcrossCreators.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: ownerTodo.body.data.id, kind: "todo" }),
      expect.objectContaining({ id: collaboratorTodo.body.data.id, kind: "todo" })
    ]));
    const todoUpdateDenied = await collaborator.agent.patch(`/api/chapter-annotations/${ownerTodo.body.data.id}`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ status: "resolved", expectedVersionNo: ownerTodo.body.data.versionNo })
      .expect(403);
    expect(todoUpdateDenied.body.error.code).toBe("WORK_MODULE_WRITE_DENIED");
    const todoDeleteDenied = await collaborator.agent.delete(`/api/chapter-annotations/${ownerTodo.body.data.id}`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ expectedVersionNo: ownerTodo.body.data.versionNo })
      .expect(403);
    expect(todoDeleteDenied.body.error.code).toBe("WORK_MODULE_WRITE_DENIED");
    await collaborator.agent.patch(`/api/chapter-annotations/${collaboratorTodo.body.data.id}`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ status: "resolved", expectedVersionNo: collaboratorTodo.body.data.versionNo })
      .expect(200);
    await collaborator.agent.delete(`/api/chapter-annotations/${collaboratorTodo.body.data.id}`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ expectedVersionNo: collaboratorTodo.body.data.versionNo + 1 })
      .expect(204);

    await owner.agent.patch(`/api/works/${workId}/members/${collaborator.user.userId}`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ permissions: { ...addOnly, prose: "write" } })
      .expect(200);
    await owner.agent.patch(`/api/chapter-annotations/${ownerTodo.body.data.id}`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ status: "resolved", expectedVersionNo: ownerTodo.body.data.versionNo })
      .expect(200);
    await collaborator.agent.delete(`/api/chapter-annotations/${ownerNote.body.data.id}`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ expectedVersionNo: ownerNote.body.data.versionNo })
      .expect(204);
  });

  it("章节伏笔提醒同时校验正文与大纲权限、CSRF 和对象归属", async () => {
    const owner = await register(runtime, "reminder_owner");
    const collaborator = await register(runtime, "reminder_collaborator");
    const work = await owner.agent.post("/api/works")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "伏笔提醒权限作品" })
      .expect(201);
    const workId = String(work.body.data.id);
    const volume = await owner.agent.post(`/api/works/${workId}/volumes`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "正文" })
      .expect(201);
    const chapter = await owner.agent.post(`/api/works/${workId}/chapters`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ volumeId: volume.body.data.id, title: "提醒章", content: "主角重新看见火漆。" })
      .expect(201);
    const secret = "REMINDER_PERMISSION_SECRET";
    const foreshadow = await owner.agent.post(`/api/works/${workId}/foreshadows`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({
        title: `旧信 ${secret}`,
        description: `只有获授权成员可读 ${secret}`,
        status: "planted",
        occurrences: [{ chapterId: chapter.body.data.id, role: "reminder", note: `节点 ${secret}` }]
      })
      .expect(201);
    const basePermissions = {
      prose: "none",
      drafts: "none",
      settings: "none",
      characters: "none",
      races: "none",
      organizations: "none",
      timeline: "none",
      relationships: "none",
      outlines: "none",
      reviews: "none",
      "ai-chat": "none",
      "ai-analysis": "none",
      "ai-settings": "none"
    };
    await owner.agent.post(`/api/works/${workId}/members`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ userId: collaborator.user.userId, permissions: { ...basePermissions, prose: "read" } })
      .expect(201);

    const noOutlineRead = await collaborator.agent
      .get(`/api/works/${workId}/chapters/${chapter.body.data.id}/foreshadow-reminders`)
      .expect(403);
    expect(noOutlineRead.body.error.code).toBe("WORK_MODULE_READ_DENIED");
    expect(JSON.stringify(noOutlineRead.body)).not.toContain(secret);

    await owner.agent.patch(`/api/works/${workId}/members/${collaborator.user.userId}`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ permissions: { ...basePermissions, outlines: "read" } })
      .expect(200);
    const noProseRead = await collaborator.agent
      .get(`/api/works/${workId}/chapters/${chapter.body.data.id}/foreshadow-reminders`)
      .expect(403);
    expect(noProseRead.body.error.code).toBe("WORK_MODULE_READ_DENIED");
    expect(JSON.stringify(noProseRead.body)).not.toContain(secret);

    const readPermissions = { ...basePermissions, prose: "read", outlines: "read" };
    await owner.agent.patch(`/api/works/${workId}/members/${collaborator.user.userId}`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ permissions: readPermissions })
      .expect(200);
    const visible = await collaborator.agent
      .get(`/api/works/${workId}/chapters/${chapter.body.data.id}/foreshadow-reminders`)
      .expect(200);
    expect(visible.body.data).toEqual([
      expect.objectContaining({ foreshadowId: foreshadow.body.data.id, title: `旧信 ${secret}` })
    ]);
    const writeDenied = await collaborator.agent
      .post(`/api/works/${workId}/chapters/${chapter.body.data.id}/foreshadow-reminders/${foreshadow.body.data.id}/resolve`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ expectedVersionNo: visible.body.data[0].versionNo })
      .expect(403);
    expect(writeDenied.body.error.code).toBe("WORK_MODULE_WRITE_DENIED");

    const writePermissions = { ...basePermissions, prose: "read", outlines: "write" };
    await owner.agent.patch(`/api/works/${workId}/members/${collaborator.user.userId}`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ permissions: writePermissions })
      .expect(200);
    const missingCsrf = await collaborator.agent
      .post(`/api/works/${workId}/chapters/${chapter.body.data.id}/foreshadow-reminders/${foreshadow.body.data.id}/resolve`)
      .send({ expectedVersionNo: visible.body.data[0].versionNo })
      .expect(403);
    expect(missingCsrf.body.error.code).toBe("CSRF_TOKEN_INVALID");

    const otherWork = await owner.agent.post("/api/works")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "未授权的其他作品" })
      .expect(201);
    const otherWorkId = String(otherWork.body.data.id);
    const otherVolume = await owner.agent.post(`/api/works/${otherWorkId}/volumes`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "其他正文" })
      .expect(201);
    const otherChapter = await owner.agent.post(`/api/works/${otherWorkId}/chapters`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ volumeId: otherVolume.body.data.id, title: "其他提醒章" })
      .expect(201);
    const otherSecret = "CROSS_WORK_REMINDER_SECRET";
    const otherForeshadow = await owner.agent.post(`/api/works/${otherWorkId}/foreshadows`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({
        title: otherSecret,
        status: "planted",
        occurrences: [{ chapterId: otherChapter.body.data.id, role: "payoff", note: otherSecret }]
      })
      .expect(201);
    const otherWorkDenied = await collaborator.agent
      .get(`/api/works/${otherWorkId}/chapters/${otherChapter.body.data.id}/foreshadow-reminders`)
      .expect(403);
    expect(otherWorkDenied.body.error.code).toBe("WORK_ACCESS_DENIED");
    expect(JSON.stringify(otherWorkDenied.body)).not.toContain(otherSecret);
    const foreignForeshadowDenied = await collaborator.agent
      .post(`/api/works/${workId}/chapters/${chapter.body.data.id}/foreshadow-reminders/${otherForeshadow.body.data.id}/resolve`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ expectedVersionNo: otherForeshadow.body.data.versionNo })
      .expect(404);
    expect(JSON.stringify(foreignForeshadowDenied.body)).not.toContain(otherSecret);

    const resolved = await collaborator.agent
      .post(`/api/works/${workId}/chapters/${chapter.body.data.id}/foreshadow-reminders/${foreshadow.body.data.id}/resolve`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ expectedVersionNo: visible.body.data[0].versionNo })
      .expect(200);
    expect(resolved.body.data).toMatchObject({ foreshadowId: foreshadow.body.data.id, status: "resolved" });
    expect(runtime.database.get(
      "SELECT created_by_user_id FROM entity_versions WHERE entity_type = 'foreshadow' AND entity_id = ? ORDER BY version_no DESC LIMIT 1",
      foreshadow.body.data.id
    )?.created_by_user_id).toBe(collaborator.user.userId);
    expect(runtime.database.get(
      "SELECT user_id FROM audit_logs WHERE action = 'foreshadow.updated' AND entity_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      foreshadow.body.data.id
    )?.user_id).toBe(collaborator.user.userId);
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("模块权限默认拒绝未知路由，并裁剪跨模块数据与关联写入", async () => {
    const owner = await register(runtime, "boundary_owner");
    const collaborator = await register(runtime, "boundary_collaborator");
    const work = await owner.agent.post("/api/works")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "权限边界作品" })
      .expect(201);
    const workId = String(work.body.data.id);
    const character = await owner.agent.post(`/api/works/${workId}/characters`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ name: "边界角色" })
      .expect(201);
    const characterId = String(character.body.data.id);
    const race = await owner.agent.post(`/api/works/${workId}/races`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ name: "边界种族", settings: ["不可跨模块泄露"], memberIds: [characterId] })
      .expect(201);
    const raceId = String(race.body.data.id);
    const organization = await owner.agent.post(`/api/works/${workId}/organizations`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ name: "边界组织", memberIds: [characterId] })
      .expect(201);
    const organizationId = String(organization.body.data.id);
    const review = await owner.agent.post(`/api/works/${workId}/reviews`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ itemType: "timeline-conflict", title: "边界审核项", description: "仅审核模块可见。" })
      .expect(201);
    const reviewId = String(review.body.data.id);
    const permissions = {
      prose: "none",
      drafts: "none",
      settings: "none",
      characters: "none",
      races: "write",
      organizations: "write",
      timeline: "none",
      relationships: "none",
      outlines: "none",
      reviews: "read",
      "ai-chat": "none",
      "ai-analysis": "read",
      "ai-settings": "none"
    };
    await owner.agent.post(`/api/works/${workId}/members`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ userId: collaborator.user.userId, permissions })
      .expect(201);

    await collaborator.agent.get(`/api/works/${workId}/audit-logs`).expect(403);
    await collaborator.agent.get(`/api/works/${workId}/unclassified-route`).expect(403);
    const scopedSearch = await collaborator.agent.get(`/api/works/${workId}/search?q=边界`).expect(200);
    expect(new Set(scopedSearch.body.data.map((item: { type: string }) => item.type))).toEqual(new Set([
      "race",
      "organization",
      "review"
    ]));
    const overlongSearch = await collaborator.agent
      .get(`/api/works/${workId}/search`)
      .query({ q: "界".repeat(101) })
      .expect(400);
    expect(overlongSearch.body.error.code).toBe("VALIDATION_ERROR");
    await collaborator.agent.get(`/api/works/${workId}/file-versions`).expect(403);
    const commentReadDenied = await collaborator.agent.get(`/api/works/${workId}/chapter-annotations`).expect(403);
    expect(commentReadDenied.body.error.code).toBe("WORK_MODULE_READ_DENIED");
    await collaborator.agent
      .post(`/api/works/${workId}/file-versions/file_missing/restore`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({})
      .expect(403);
    const hiddenProseImport = await collaborator.agent.post(`/api/works/${workId}/import`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .attach("file", Buffer.from("第一章\n\n不应导入。"), "hidden-prose.txt")
      .expect(403);
    expect(hiddenProseImport.body.error.code).toBe("WORK_MODULE_WRITE_DENIED");
    await collaborator.agent.get(`/api/works/${workId}/reviews`).expect(200);
    await collaborator.agent.get(`/api/reviews/${reviewId}`).expect(200);
    await collaborator.agent.get(`/api/works/${workId}/ai-calls`).expect(200);
    await collaborator.agent.get(`/api/works/${workId}/models`).expect(200);
    const chatDenied = await collaborator.agent.get(`/api/works/${workId}/ai-conversations`).expect(403);
    expect(chatDenied.body.error.code).toBe("WORK_MODULE_READ_DENIED");

    const visibleRaces = await collaborator.agent.get(`/api/works/${workId}/races`).expect(200);
    expect(visibleRaces.body.data[0]).toMatchObject({ id: raceId, memberIds: [], members: [] });
    const raceVersions = await collaborator.agent.get(`/api/entity-versions/race/${raceId}`).expect(200);
    expect(raceVersions.body.data[0].snapshot).toMatchObject({ memberIds: [] });
    const visibleOrganizations = await collaborator.agent.get(`/api/works/${workId}/organizations`).expect(200);
    expect(visibleOrganizations.body.data[0]).toMatchObject({ id: organizationId, memberIds: [], members: [] });

    await collaborator.agent.patch(`/api/races/${raceId}`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ description: "仅修改种族自身字段。" })
      .expect(200);
    const raceMemberWrite = await collaborator.agent.patch(`/api/races/${raceId}`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ memberIds: [] })
      .expect(403);
    expect(raceMemberWrite.body.error.code).toBe("WORK_MODULE_WRITE_DENIED");
    await collaborator.agent.patch(`/api/races/${raceId}`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ name: "越权更名" })
      .expect(403);
    await collaborator.agent.delete(`/api/races/${raceId}`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({})
      .expect(403);
    await collaborator.agent.patch(`/api/organizations/${organizationId}`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ description: "仅修改组织自身字段。" })
      .expect(200);
    await collaborator.agent.patch(`/api/organizations/${organizationId}`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ memberIds: [] })
      .expect(403);

    const characterOnly = { ...permissions, characters: "read", races: "none", organizations: "none" };
    await owner.agent.patch(`/api/works/${workId}/members/${collaborator.user.userId}`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ permissions: characterOnly })
      .expect(200);
    const visibleCharacters = await collaborator.agent.get(`/api/works/${workId}/characters`).expect(200);
    expect(visibleCharacters.body.data[0]).toMatchObject({
      id: characterId,
      raceId: null,
      race: null,
      species: "",
      organizationIds: [],
      organizations: []
    });
    expect(JSON.stringify(visibleCharacters.body.data)).not.toContain("不可跨模块泄露");
    const noReviewPermissions = { ...characterOnly, reviews: "none" };
    await owner.agent.patch(`/api/works/${workId}/members/${collaborator.user.userId}`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ permissions: noReviewPermissions })
      .expect(200);
    const reviewReadDenied = await collaborator.agent.get(`/api/reviews/${reviewId}`).expect(403);
    expect(reviewReadDenied.body.error.code).toBe("WORK_MODULE_READ_DENIED");
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("按成员可读模块限制显式与全局搜索并保持身份入口契约", async () => {
    const admin = await register(runtime, "search_matrix_admin");
    const owner = await register(runtime, "search_matrix_owner");
    const proseReader = await register(runtime, "search_matrix_prose_reader");
    const noAccessReader = await register(runtime, "search_matrix_no_access");
    const work = await owner.agent.post("/api/works")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "搜索权限矩阵作品" })
      .expect(201);
    const workId = String(work.body.data.id);
    const volume = await owner.agent.post(`/api/works/${workId}/volumes`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "权限矩阵分卷" })
      .expect(201);
    const chapter = await owner.agent.post(`/api/works/${workId}/chapters`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ volumeId: volume.body.data.id, title: "权限矩阵正文", content: "权限矩阵命中只应展示正文。" })
      .expect(201);
    const character = await owner.agent.post(`/api/works/${workId}/characters`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ name: "权限矩阵保密角色", profile: { secret: "权限矩阵命中不可泄露人物档案" } })
      .expect(201);
    const noPermissions = {
      prose: "none",
      drafts: "none",
      settings: "none",
      characters: "none",
      races: "none",
      organizations: "none",
      timeline: "none",
      relationships: "none",
      outlines: "none",
      reviews: "none",
      "ai-chat": "none",
      "ai-analysis": "none",
      "ai-settings": "none"
    };
    await owner.agent.post(`/api/works/${workId}/members`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ userId: proseReader.user.userId, permissions: { ...noPermissions, prose: "read" } })
      .expect(201);
    await owner.agent.post(`/api/works/${workId}/members`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ userId: noAccessReader.user.userId, permissions: noPermissions })
      .expect(201);

    await request(runtime.app).get(`/api/works/${workId}/search`).query({ q: "权限矩阵" }).expect(401);
    const chapterSearch = await proseReader.agent.get(`/api/works/${workId}/search`)
      .query({ q: "权限矩阵", type: "chapter" })
      .expect(200);
    expect(chapterSearch.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: chapter.body.data.id, type: "chapter" })
    ]));
    const characterDenied = await proseReader.agent.get(`/api/works/${workId}/search`)
      .query({ q: "权限矩阵", type: "character" })
      .expect(403);
    expect(characterDenied.body.error.code).toBe("WORK_MODULE_READ_DENIED");
    expect(JSON.stringify(characterDenied.body)).not.toContain("权限矩阵保密角色");

    const globalSearch = await proseReader.agent.get(`/api/works/${workId}/search`)
      .query({ q: "权限矩阵" })
      .expect(200);
    expect(globalSearch.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: chapter.body.data.id, type: "chapter" })
    ]));
    expect(globalSearch.body.data.every((item: { type: string }) => item.type === "chapter")).toBe(true);
    expect(JSON.stringify(globalSearch.body.data)).not.toContain(String(character.body.data.id));
    expect(JSON.stringify(globalSearch.body.data)).not.toContain("权限矩阵保密角色");

    const emptyPermissionSearch = await noAccessReader.agent.get(`/api/works/${workId}/search`)
      .query({ q: "权限矩阵" })
      .expect(403);
    expect(emptyPermissionSearch.body.error.code).toBe("WORK_MODULE_READ_DENIED");
    await owner.agent.get(`/api/works/${workId}/search`).query({ q: "权限矩阵", type: "character" }).expect(200);
    await admin.agent.get(`/api/works/${workId}/search`).query({ q: "权限矩阵", type: "character" }).expect(200);

    const proseReaderKeyReset = await proseReader.agent.post("/api/auth/api-key/reset")
      .set("X-CSRF-Token", proseReader.csrfToken)
      .send({})
      .expect(200);
    const proseReaderKey = String(proseReaderKeyReset.body.data.apiKey);
    const apiKeyGlobalSearch = await request(runtime.app).get(`/api/works/${workId}/search`)
      .set("Authorization", `Bearer ${proseReaderKey}`)
      .query({ q: "权限矩阵" })
      .expect(200);
    expect(apiKeyGlobalSearch.body.data.every((item: { type: string }) => item.type === "chapter")).toBe(true);
    await request(runtime.app).get(`/api/works/${workId}/search`)
      .set("Authorization", `Bearer ${proseReaderKey}`)
      .query({ q: "权限矩阵", type: "character" })
      .expect(403);
  });

  it("JSON 导出拒绝缺少审核读取权限的协作者且正文格式保持可用", async () => {
    const owner = await register(runtime, "export_review_owner");
    const collaborator = await register(runtime, "export_review_collaborator");
    const outsider = await register(runtime, "export_review_outsider");
    const work = await owner.agent.post("/api/works")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "审核权限导出作品" })
      .expect(201);
    const workId = String(work.body.data.id);
    const volume = await owner.agent.post(`/api/works/${workId}/volumes`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "正文" })
      .expect(201);
    const proseSecret = "EXPORT_PROSE_CONTENT";
    await owner.agent.post(`/api/works/${workId}/chapters`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ volumeId: volume.body.data.id, title: "第一章", content: proseSecret })
      .expect(201);
    const reviewSecrets = {
      title: "EXPORT_REVIEW_TITLE_SECRET",
      description: "EXPORT_REVIEW_DESCRIPTION_SECRET",
      evidence: "EXPORT_REVIEW_EVIDENCE_SECRET",
      suggestion: "EXPORT_REVIEW_SUGGESTION_SECRET",
      resolutionNote: "EXPORT_REVIEW_RESOLUTION_SECRET"
    };
    await owner.agent.post(`/api/works/${workId}/reviews`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({
        itemType: "timeline-conflict",
        title: reviewSecrets.title,
        description: reviewSecrets.description,
        evidence: [{ excerpt: reviewSecrets.evidence }],
        suggestion: reviewSecrets.suggestion,
        resolutionNote: reviewSecrets.resolutionNote
      })
      .expect(201);
    const permissions = {
      prose: "read",
      drafts: "read",
      settings: "read",
      characters: "read",
      races: "read",
      organizations: "read",
      timeline: "read",
      relationships: "read",
      outlines: "read",
      reviews: "none",
      "ai-chat": "none",
      "ai-analysis": "none",
      "ai-settings": "none"
    };
    await owner.agent.post(`/api/works/${workId}/members`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ userId: collaborator.user.userId, permissions })
      .expect(201);

    for (const query of ["", "?format=json"]) {
      const denied = await collaborator.agent.get(`/api/works/${workId}/export${query}`).expect(403);
      expect(denied.body.error.code).toBe("WORK_MODULE_READ_DENIED");
      expect(denied.headers["content-disposition"]).toBeUndefined();
      const deniedBody = JSON.stringify(denied.body);
      for (const secret of Object.values(reviewSecrets)) expect(deniedBody).not.toContain(secret);
    }
    const outsiderDenied = await outsider.agent.get(`/api/works/${workId}/export?format=json`).expect(403);
    expect(outsiderDenied.body.error.code).toBe("WORK_ACCESS_DENIED");
    for (const secret of Object.values(reviewSecrets)) {
      expect(JSON.stringify(outsiderDenied.body)).not.toContain(secret);
    }
    const outsiderVolumeDenied = await outsider.agent.get(`/api/volumes/${volume.body.data.id}/export?format=epub`).expect(403);
    expect(outsiderVolumeDenied.body.error.code).toBe("WORK_ACCESS_DENIED");
    expect(outsiderVolumeDenied.headers["content-disposition"]).toBeUndefined();
    await outsider.agent.head(`/api/volumes/${volume.body.data.id}/export?format=epub`).expect(403);
    const otherWork = await outsider.agent.post("/api/works")
      .set("X-CSRF-Token", outsider.csrfToken)
      .send({ title: "其他作品" })
      .expect(201);
    const otherWorkId = String(otherWork.body.data.id);
    const otherWorkSecret = "CROSS_WORK_REVIEW_SECRET";
    await outsider.agent.post(`/api/works/${otherWorkId}/reviews`)
      .set("X-CSRF-Token", outsider.csrfToken)
      .send({ itemType: "timeline-conflict", title: otherWorkSecret })
      .expect(201);
    const crossWorkDenied = await collaborator.agent.get(`/api/works/${otherWorkId}/export?format=json`).expect(403);
    expect(crossWorkDenied.body.error.code).toBe("WORK_ACCESS_DENIED");
    expect(JSON.stringify(crossWorkDenied.body)).not.toContain(otherWorkSecret);

    const textExport = await collaborator.agent.get(`/api/works/${workId}/export?format=txt`)
      .expect("Content-Type", /text\/plain/u)
      .expect("Content-Disposition", `attachment; filename=novel-${workId}.txt`)
      .expect(200);
    expect(textExport.text).toContain(proseSecret);
    for (const secret of Object.values(reviewSecrets)) expect(textExport.text).not.toContain(secret);

    const markdownExport = await collaborator.agent.get(`/api/works/${workId}/export?format=markdown`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
        response.on("error", callback);
      })
      .expect("Content-Type", /application\/zip/u)
      .expect("Content-Disposition", `attachment; filename=novel-${workId}.zip`)
      .expect(200);
    const markdownArchive = await JSZip.loadAsync(markdownExport.body as Buffer);
    const markdown = await markdownArchive.file(`novel-${workId}.md`)?.async("string");
    expect(markdown).toContain(proseSecret);
    for (const secret of Object.values(reviewSecrets)) expect(markdown).not.toContain(secret);

    const docxExport = await collaborator.agent.get(`/api/works/${workId}/export?format=docx`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
        response.on("error", callback);
      })
      .expect("Content-Type", /application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document/u)
      .expect("Content-Disposition", `attachment; filename=novel-${workId}.docx`)
      .expect(200);
    const docxArchive = await JSZip.loadAsync(docxExport.body as Buffer);
    const documentXml = await docxArchive.file("word/document.xml")?.async("string");
    expect(documentXml).toContain(proseSecret);
    for (const secret of Object.values(reviewSecrets)) expect(documentXml).not.toContain(secret);

    const epubExport = await collaborator.agent.get(`/api/works/${workId}/export?format=epub`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
        response.on("error", callback);
      })
      .expect("Content-Type", /application\/epub\+zip/u)
      .expect(200);
    const epubArchive = await JSZip.loadAsync(epubExport.body as Buffer);
    const epubText = (await Promise.all(Object.values(epubArchive.files)
      .filter((file) => !file.dir && !/\.(?:png|jpe?g)$/iu.test(file.name))
      .map((file) => file.async("string")))).join("\n");
    expect(epubText).toContain(proseSecret);
    for (const secret of Object.values(reviewSecrets)) expect(epubText).not.toContain(secret);
    await collaborator.agent.head(`/api/works/${workId}/export?format=epub`).expect(204);

    const volumeEpubExport = await collaborator.agent.get(`/api/volumes/${volume.body.data.id}/export?format=epub`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
        response.on("error", callback);
      })
      .expect(200);
    const volumeEpubArchive = await JSZip.loadAsync(volumeEpubExport.body as Buffer);
    const volumeChapter = await volumeEpubArchive.file("OEBPS/text/chapter-001-001.xhtml")?.async("string");
    expect(volumeChapter).toContain(proseSecret);
    for (const secret of Object.values(reviewSecrets)) expect(volumeChapter).not.toContain(secret);

    await owner.agent.patch(`/api/works/${workId}/members/${collaborator.user.userId}`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ permissions: { ...permissions, reviews: "read" } })
      .expect(200);
    const authorized = await collaborator.agent.get(`/api/works/${workId}/export?format=json`)
      .expect("Content-Type", /application\/json/u)
      .expect("Content-Disposition", `attachment; filename=novel-${workId}.json`)
      .expect(200);
    expect(authorized.body.data.reviews).toEqual([
      expect.objectContaining({
        workId,
        title: reviewSecrets.title,
        description: reviewSecrets.description,
        evidence: [{ excerpt: reviewSecrets.evidence }],
        suggestion: reviewSecrets.suggestion,
        resolutionNote: reviewSecrets.resolutionNote
      })
    ]);
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("按实际资料模块隔离 Markdown 图片附件", async () => {
    const owner = await register(runtime, "attachment_owner");
    const characterEditor = await register(runtime, "attachment_character_editor");
    const settingsReader = await register(runtime, "attachment_settings_reader");
    const work = await owner.agent.post("/api/works")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "附件权限作品" })
      .expect(201);
    const workId = String(work.body.data.id);
    const noAccess = {
      prose: "none",
      drafts: "none",
      settings: "none",
      characters: "none",
      races: "none",
      organizations: "none",
      timeline: "none",
      relationships: "none",
      outlines: "none",
      reviews: "none",
      "ai-chat": "none",
      "ai-analysis": "none",
      "ai-settings": "none"
    };
    await owner.agent.post(`/api/works/${workId}/members`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ userId: characterEditor.user.userId, permissions: { ...noAccess, characters: "write" } })
      .expect(201);
    await owner.agent.post(`/api/works/${workId}/members`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ userId: settingsReader.user.userId, permissions: { ...noAccess, settings: "read" } })
      .expect(201);

    await characterEditor.agent.post(`/api/works/${workId}/attachments`)
      .set("X-CSRF-Token", characterEditor.csrfToken)
      .attach("file", onePixelPng, "missing-module.png")
      .expect(403);
    const uploaded = await characterEditor.agent.post(`/api/works/${workId}/attachments?module=characters`)
      .set("X-CSRF-Token", characterEditor.csrfToken)
      .attach("file", onePixelPng, "character-profile.png")
      .expect(201);
    const attachmentId = String(uploaded.body.data.id);
    const character = await characterEditor.agent.post(`/api/works/${workId}/characters`)
      .set("X-CSRF-Token", characterEditor.csrfToken)
      .send({ name: "保密角色" })
      .expect(201);
    await characterEditor.agent.post(`/api/characters/${String(character.body.data.id)}/sections`)
      .set("X-CSRF-Token", characterEditor.csrfToken)
      .send({ title: "保密档案", contentMarkdown: `![](attachment://${attachmentId})` })
      .expect(201);

    await characterEditor.agent.get(`/api/attachments/${attachmentId}/content`).expect(200);
    const hiddenList = await settingsReader.agent.get(`/api/works/${workId}/attachments`).expect(200);
    expect(hiddenList.body.data).toEqual([]);
    const hiddenContent = await settingsReader.agent.get(`/api/attachments/${attachmentId}/content`).expect(403);
    expect(hiddenContent.body.error.code).toBe("WORK_MODULE_READ_DENIED");
  });

  it("可单独授权 AI 对话或 AI 分析，互不影响", async () => {
    const owner = await register(runtime, "ai_split_owner");
    const chatOnly = await register(runtime, "ai_chat_only");
    const analysisOnly = await register(runtime, "ai_analysis_only");
    const historyOnly = await register(runtime, "ai_history_only");
    const work = await owner.agent.post("/api/works")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "AI 权限拆分作品" })
      .expect(201);
    const workId = String(work.body.data.id);
    const basePermissions = {
      prose: "read",
      drafts: "read",
      settings: "read",
      characters: "read",
      races: "read",
      organizations: "read",
      timeline: "read",
      relationships: "read",
      outlines: "read",
      reviews: "none",
      "ai-chat": "none",
      "ai-analysis": "none",
      "ai-settings": "none"
    };
    await owner.agent.post(`/api/works/${workId}/members`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ userId: chatOnly.user.userId, permissions: { ...basePermissions, "ai-chat": "write" } })
      .expect(201);
    await owner.agent.post(`/api/works/${workId}/members`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ userId: analysisOnly.user.userId, permissions: { ...basePermissions, "ai-analysis": "write" } })
      .expect(201);
    await owner.agent.post(`/api/works/${workId}/members`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({
        userId: historyOnly.user.userId,
        permissions: {
          ...basePermissions,
          prose: "none",
          drafts: "none",
          settings: "none",
          characters: "none",
          races: "none",
          organizations: "none",
          timeline: "none",
          relationships: "none",
          outlines: "none",
          "ai-chat": "write"
        }
      })
      .expect(201);

    await chatOnly.agent.get(`/api/works/${workId}/ai-conversations`).expect(200);
    await chatOnly.agent.get(`/api/works/${workId}/chapter-annotations`).expect(200);
    const chatConversation = await chatOnly.agent.post(`/api/works/${workId}/ai-conversations`)
      .set("X-CSRF-Token", chatOnly.csrfToken)
      .send({})
      .expect(201);
    await chatOnly.agent.post(`/api/ai-conversations/${String(chatConversation.body.data.id)}/messages`)
      .set("X-CSRF-Token", chatOnly.csrfToken)
      .send({ role: "user", content: "检索专用的 Agent 历史内容" })
      .expect(201);
    const historySearch = await chatOnly.agent
      .get(`/api/works/${workId}/search?q=检索专用&type=agent-history`)
      .expect(200);
    expect(historySearch.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "agent-history", conversationId: chatConversation.body.data.id })
    ]));
    const historyOnlyConversation = await historyOnly.agent.post(`/api/works/${workId}/ai-conversations`)
      .set("X-CSRF-Token", historyOnly.csrfToken)
      .send({})
      .expect(201);
    await historyOnly.agent.post(`/api/ai-conversations/${String(historyOnlyConversation.body.data.id)}/messages`)
      .set("X-CSRF-Token", historyOnly.csrfToken)
      .send({ role: "user", content: "正文权限之外的 Agent 历史内容" })
      .expect(201);
    const historyOnlySearch = await historyOnly.agent
      .get(`/api/works/${workId}/search?q=正文权限之外&type=agent-history`)
      .expect(200);
    expect(historyOnlySearch.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "agent-history", conversationId: historyOnlyConversation.body.data.id })
    ]));
    const historyOnlyGlobalSearch = await historyOnly.agent
      .get(`/api/works/${workId}/search?q=正文权限之外`)
      .expect(200);
    expect(historyOnlyGlobalSearch.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "agent-history", conversationId: historyOnlyConversation.body.data.id })
    ]));
    expect(historyOnlyGlobalSearch.body.data.every((item: { type: string }) => item.type === "agent-history")).toBe(true);
    await chatOnly.agent.get(`/api/works/${workId}/models`).expect(200);
    const chatTasksDenied = await chatOnly.agent.get(`/api/works/${workId}/tasks`).expect(403);
    expect(chatTasksDenied.body.error.code).toBe("WORK_MODULE_READ_DENIED");
    await chatOnly.agent.post(`/api/works/${workId}/tasks`)
      .set("X-CSRF-Token", chatOnly.csrfToken)
      .send({ taskType: "book-analysis", scope: { type: "book" } })
      .expect(403);

    await analysisOnly.agent.get(`/api/works/${workId}/tasks`).expect(200);
    await analysisOnly.agent.get(`/api/works/${workId}/models`).expect(200);
    await analysisOnly.agent.get(`/api/works/${workId}/task-defaults`).expect(200);
    const taskDefaultWriteDenied = await analysisOnly.agent
      .put(`/api/works/${workId}/task-defaults/book-analysis`)
      .set("X-CSRF-Token", analysisOnly.csrfToken)
      .send({ modelId: "model_not_authorized" })
      .expect(403);
    expect(taskDefaultWriteDenied.body.error.code).toBe("WORK_MODULE_WRITE_DENIED");
    const analysisChatDenied = await analysisOnly.agent.get(`/api/works/${workId}/ai-conversations`).expect(403);
    expect(analysisChatDenied.body.error.code).toBe("WORK_MODULE_READ_DENIED");
    await analysisOnly.agent.get(`/api/works/${workId}/search?q=检索专用&type=agent-history`).expect(403);
    await analysisOnly.agent.post(`/api/works/${workId}/ai-conversations`)
      .set("X-CSRF-Token", analysisOnly.csrfToken)
      .send({})
      .expect(403);

    const analysisTask = await analysisOnly.agent.post(`/api/works/${workId}/tasks`)
      .set("X-CSRF-Token", analysisOnly.csrfToken)
      .send({ taskType: "book-analysis", scope: { type: "book" } })
      .expect(201);
    const taskId = String(analysisTask.body.data.id);
    const traceTimestamp = new Date().toISOString();
    runtime.database.run(
      `INSERT INTO ai_calls (id, work_id, task_id, task_type, provider_id, model_id, context_scope_json, parameters_json,
       status, input_chars, output_chars, created_at, completed_at) VALUES (?, ?, ?, 'book-analysis', ?, ?, '{}', '{}',
       'completed', 16, 2, ?, ?)`,
      "call_permission_trace",
      workId,
      taskId,
      "deleted_provider_permission_trace",
      "deleted_model_permission_trace",
      traceTimestamp,
      traceTimestamp
    );
    runtime.database.run(
      `INSERT INTO ai_call_traces (call_id, task_id, initial_messages_json, rounds_json, created_at, updated_at)
       VALUES (?, ?, ?, '[]', ?, ?)`,
      "call_permission_trace",
      taskId,
      JSON.stringify([{ role: "user", content: "TOP_SECRET_PROSE" }]),
      traceTimestamp,
      traceTimestamp
    );
    const ownerTrace = await owner.agent.get(`/api/tasks/${taskId}/trace`).expect(200);
    expect(JSON.stringify(ownerTrace.body.data)).not.toContain("TOP_SECRET_PROSE");
    const ownerTracePreview = await owner.agent.get(`/api/tasks/${taskId}/trace/calls/call_permission_trace`).expect(200);
    expect(JSON.stringify(ownerTracePreview.body.data)).toContain("TOP_SECRET_PROSE");

    const secretCharacter = await owner.agent.post(`/api/works/${workId}/characters`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ name: "TOP_SECRET_CHARACTER" })
      .expect(201);
    await owner.agent.post(`/api/works/${workId}/characters`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ name: "TOP_SECRET_OTHER" })
      .expect(201);
    const targetedTask = await owner.agent.post(`/api/works/${workId}/tasks`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({
        taskType: "relationship-analysis",
        scope: { type: "book", characterIds: [secretCharacter.body.data.id] }
      })
      .expect(201);
    expect(targetedTask.body.data.scopeSummary).toBe("全书 · 定向 1 人：TOP_SECRET_CHARACTER · 已预检 0 条来源");
    const collaboratorTargetedTask = await analysisOnly.agent.post(`/api/works/${workId}/tasks`)
      .set("X-CSRF-Token", analysisOnly.csrfToken)
      .send({
        taskType: "relationship-analysis",
        scope: { type: "book", characterIds: [secretCharacter.body.data.id] }
      })
      .expect(201);
    const settingsSourceDenied = await analysisOnly.agent.post(`/api/works/${workId}/tasks`)
      .set("X-CSRF-Token", analysisOnly.csrfToken)
      .send({
        taskType: "relationship-analysis",
        scope: { type: "book", includeAllSettings: true, characterIds: [secretCharacter.body.data.id] }
      })
      .expect(403);
    expect(settingsSourceDenied.body.error.code).toBe("WORK_MODULE_READ_DENIED");
    runtime.database.run(
      "UPDATE analysis_tasks SET result_json = ? WHERE id = ?",
      JSON.stringify({
        relationshipResults: [{
          relationshipId: "relationship_secret",
          fromCharacterId: secretCharacter.body.data.id,
          fromCharacterName: "TOP_SECRET_CHARACTER",
          toCharacterId: "character_other",
          toCharacterName: "TOP_SECRET_OTHER",
          subtype: "盟友"
        }],
        analysisTarget: {
          mode: "targeted-characters",
          characterIds: [secretCharacter.body.data.id],
          characterNames: ["TOP_SECRET_CHARACTER"]
        }
      }),
      targetedTask.body.data.id
    );
    const secretTimeline = runtime.store.createTimelineEvent(workId, {
      name: "TOP_SECRET_TIMELINE",
      description: "TOP_SECRET_TIMELINE_DESCRIPTION",
      eventType: "conflict",
      timeLabel: "秘密年代",
      chapterIds: [],
      participantIds: [],
      location: "秘密地点",
      impactScope: "秘密范围"
    }, "manual", "permission-readable-result-test");
    const timelineTask = await owner.agent.post(`/api/works/${workId}/tasks`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ taskType: "timeline-analysis", scope: { type: "book" } })
      .expect(201);
    runtime.store.updateTask(String(timelineTask.body.data.id), {
      status: "completed",
      progress: 100,
      result: { eventIds: [secretTimeline.id] }
    });
    const secretSelectionTask = await owner.agent.post(`/api/works/${workId}/tasks`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ taskType: "book-analysis", scope: { type: "selection", selection: "TOP_SECRET_SELECTION_PROSE" } })
      .expect(201);
    expect(secretSelectionTask.body.data.scopeSummary).toContain("TOP_SECRET_SELECTION_PROSE");

    const noContentPermissions = Object.fromEntries(Object.keys(basePermissions).map((module) => [module, "none"]));
    await owner.agent.patch(`/api/works/${workId}/members/${analysisOnly.user.userId}`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ permissions: { ...noContentPermissions, "ai-analysis": "write" } })
      .expect(200);
    await analysisOnly.agent.get(`/api/works/${workId}/characters`).expect(403);
    const protectedTasks = await analysisOnly.agent.get(`/api/works/${workId}/tasks?page=1&limit=30`).expect(200);
    const protectedTaskSummary = protectedTasks.body.data.items.find((item: { id: string }) => item.id === targetedTask.body.data.id);
    expect(protectedTaskSummary.scopeSummary).toBe("全书 · 定向 1 人 · 已预检 0 条来源");
    expect(JSON.stringify(protectedTaskSummary)).not.toContain("TOP_SECRET_CHARACTER");
    const protectedSelectionSummary = protectedTasks.body.data.items.find((item: { id: string }) => item.id === secretSelectionTask.body.data.id);
    expect(protectedSelectionSummary.scopeSummary).toBe("选定内容（正文读取权限受限）");
    expect(JSON.stringify(protectedSelectionSummary)).not.toContain("TOP_SECRET_SELECTION_PROSE");
    const protectedTaskDetail = await analysisOnly.agent.get(`/api/tasks/${targetedTask.body.data.id}`).expect(200);
    expect(protectedTaskDetail.body.data.scopeSummary).toBe("全书 · 定向 1 人 · 已预检 0 条来源");
    expect(protectedTaskDetail.body.data.scope.targetCharacters).toBeUndefined();
    expect(protectedTaskDetail.body.data.result.relationshipResults[0].fromCharacterName).toBeUndefined();
    expect(protectedTaskDetail.body.data.result.relationshipResults[0].toCharacterName).toBeUndefined();
    expect(protectedTaskDetail.body.data.result.analysisTarget.characterNames).toBeUndefined();
    expect(JSON.stringify(protectedTaskDetail.body.data)).not.toContain("TOP_SECRET_CHARACTER");
    const protectedReadableTaskDetail = await analysisOnly.agent.get(`/api/tasks/${targetedTask.body.data.id}/detail`).expect(200);
    expect(protectedReadableTaskDetail.body.data).not.toHaveProperty("result");
    expect(protectedReadableTaskDetail.body.data.resultSummary.restricted).toBe(true);
    expect(protectedReadableTaskDetail.body.data.resultSummary.sections).toEqual([]);
    expect(JSON.stringify(protectedReadableTaskDetail.body.data)).not.toContain("TOP_SECRET_CHARACTER");
    const protectedFullTaskResult = await analysisOnly.agent.get(`/api/tasks/${targetedTask.body.data.id}/result`).expect(403);
    expect(protectedFullTaskResult.body.error.code).toBe("WORK_MODULE_READ_DENIED");
    const protectedRelationshipApply = await analysisOnly.agent.post(`/api/tasks/${targetedTask.body.data.id}/relationship-changes/apply`)
      .set("X-CSRF-Token", analysisOnly.csrfToken)
      .send({})
      .expect(403);
    expect(["WORK_MODULE_WRITE_DENIED", "WORK_EDIT_DENIED"]).toContain(protectedRelationshipApply.body.error.code);
    const protectedTimelineDetail = await analysisOnly.agent.get(`/api/tasks/${timelineTask.body.data.id}/detail`).expect(200);
    expect(protectedTimelineDetail.body.data.resultSummary.restricted).toBe(true);
    expect(protectedTimelineDetail.body.data.resultSummary.sections).toEqual([]);
    expect(JSON.stringify(protectedTimelineDetail.body.data)).not.toContain("TOP_SECRET_TIMELINE");
    const protectedTimelineResult = await analysisOnly.agent.get(`/api/tasks/${timelineTask.body.data.id}/result`).expect(403);
    expect(protectedTimelineResult.body.error.code).toBe("WORK_MODULE_READ_DENIED");
    const protectedSelectionDetail = await analysisOnly.agent.get(`/api/tasks/${secretSelectionTask.body.data.id}/detail`).expect(200);
    expect(protectedSelectionDetail.body.data.scopeSummary).toBe("选定内容（正文读取权限受限）");
    expect(protectedSelectionDetail.body.data.scope.selection).toBeUndefined();
    expect(protectedSelectionDetail.body.data.scopeDetails).toEqual([{ type: "selection", restricted: true }]);
    expect(protectedSelectionDetail.body.data.resultSummary.restricted).toBe(true);
    expect(JSON.stringify(protectedSelectionDetail.body.data)).not.toContain("TOP_SECRET_SELECTION_PROSE");
    const protectedSelectionResult = await analysisOnly.agent.get(`/api/tasks/${secretSelectionTask.body.data.id}/result`).expect(403);
    expect(protectedSelectionResult.body.error.code).toBe("WORK_MODULE_READ_DENIED");
    const protectedTaskRun = await analysisOnly.agent.post(`/api/tasks/${targetedTask.body.data.id}/run`)
      .set("X-CSRF-Token", analysisOnly.csrfToken)
      .send({})
      .expect(403);
    expect(protectedTaskRun.body.error.code).toBe("WORK_MODULE_READ_DENIED");
    const protectedAutoRun = await analysisOnly.agent.post(`/api/works/${workId}/tasks/auto-run`)
      .set("X-CSRF-Token", analysisOnly.csrfToken)
      .send({})
      .expect(403);
    expect(protectedAutoRun.body.error.code).toBe("WORK_MODULE_READ_DENIED");
    const protectedSourcePreview = await analysisOnly.agent.post(`/api/works/${workId}/tasks/relationship-source-preview`)
      .set("X-CSRF-Token", analysisOnly.csrfToken)
      .send({ scope: { type: "book", characterIds: [secretCharacter.body.data.id] } })
      .expect(403);
    expect(protectedSourcePreview.body.error.code).toBe("WORK_MODULE_READ_DENIED");
    await expect(runtime.ai.runTask(String(collaboratorTargetedTask.body.data.id))).rejects.toMatchObject({
      code: "WORK_MODULE_READ_DENIED"
    });
    expect(runtime.store.getTask(String(collaboratorTargetedTask.body.data.id)).status).toBe("pending");
    await expect(runtime.ai.runTask(taskId)).rejects.toMatchObject({
      code: "WORK_MODULE_READ_DENIED"
    });
    expect(runtime.store.getTask(taskId).status).toBe("pending");
    const protectedBookTaskCreation = await analysisOnly.agent.post(`/api/works/${workId}/tasks`)
      .set("X-CSRF-Token", analysisOnly.csrfToken)
      .send({ taskType: "book-analysis", scope: { type: "book" } })
      .expect(403);
    expect(protectedBookTaskCreation.body.error.code).toBe("WORK_MODULE_READ_DENIED");
    const protectedTaskCancellation = await analysisOnly.agent.post(`/api/tasks/${targetedTask.body.data.id}/cancel`)
      .set("X-CSRF-Token", analysisOnly.csrfToken)
      .send({})
      .expect(200);
    expect(protectedTaskCancellation.body.data.scopeSummary).toBe("全书 · 定向 1 人 · 已预检 0 条来源");
    expect(protectedTaskCancellation.body.data.scope.targetCharacters).toBeUndefined();
    expect(JSON.stringify(protectedTaskCancellation.body.data)).not.toContain("TOP_SECRET_CHARACTER");
    const protectedTaskRerun = await analysisOnly.agent.post(`/api/tasks/${targetedTask.body.data.id}/rerun`)
      .set("X-CSRF-Token", analysisOnly.csrfToken)
      .send({})
      .expect(403);
    expect(protectedTaskRerun.body.error.code).toBe("WORK_MODULE_READ_DENIED");
    const targetedTaskDenied = await analysisOnly.agent.post(`/api/works/${workId}/tasks`)
      .set("X-CSRF-Token", analysisOnly.csrfToken)
      .send({
        taskType: "relationship-analysis",
        scope: { type: "book", characterIds: [secretCharacter.body.data.id] }
      })
      .expect(403);
    expect(targetedTaskDenied.body.error.code).toBe("WORK_MODULE_READ_DENIED");
    const trailingSlashTaskDenied = await analysisOnly.agent.post(`/api/works/${workId}/tasks/`)
      .set("X-CSRF-Token", analysisOnly.csrfToken)
      .send({
        taskType: "relationship-analysis",
        scope: { type: "book", characterIds: [secretCharacter.body.data.id] }
      })
      .expect(403);
    expect(trailingSlashTaskDenied.body.error.code).toBe("WORK_MODULE_READ_DENIED");
    await analysisOnly.agent.get(`/api/tasks/${taskId}`).expect(200);
    const protectedTrace = await analysisOnly.agent.get(`/api/tasks/${taskId}/trace`).expect(403);
    expect(protectedTrace.body.error.code).toBe("WORK_MODULE_READ_DENIED");
    expect(JSON.stringify(protectedTrace.body)).not.toContain("TOP_SECRET_PROSE");
    const protectedTracePreview = await analysisOnly.agent.get(`/api/tasks/${taskId}/trace/calls/call_permission_trace`).expect(403);
    expect(protectedTracePreview.body.error.code).toBe("WORK_MODULE_READ_DENIED");
    expect(JSON.stringify(protectedTracePreview.body)).not.toContain("TOP_SECRET_PROSE");
    const protectedTraceFull = await analysisOnly.agent.get(`/api/tasks/${taskId}/trace/calls/call_permission_trace?full=true`).expect(403);
    expect(protectedTraceFull.body.error.code).toBe("WORK_MODULE_READ_DENIED");
    expect(JSON.stringify(protectedTraceFull.body)).not.toContain("TOP_SECRET_PROSE");
  });

  it("AI 历史消息续写要求 CSRF、作品权限并保持请求幂等", async () => {
    const owner = await register(runtime, "fork_owner");
    const collaborator = await register(runtime, "fork_collaborator");
    const outsider = await register(runtime, "fork_outsider");
    const work = await owner.agent.post("/api/works")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "续写权限作品" })
      .expect(201);
    const workId = String(work.body.data.id);
    await owner.agent.post(`/api/works/${workId}/members`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({
        userId: collaborator.user.userId,
        permissions: {
          prose: "read",
          drafts: "none",
          settings: "none",
          characters: "none",
          races: "none",
          organizations: "none",
          timeline: "none",
          relationships: "none",
          outlines: "none",
          reviews: "none",
          "ai-chat": "write",
          "ai-analysis": "none",
          "ai-settings": "none"
        }
      })
      .expect(201);
    const source = await collaborator.agent.post(`/api/works/${workId}/ai-conversations`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ title: "个人历史对话" })
      .expect(201);
    const sourceId = String(source.body.data.id);
    const message = await collaborator.agent.post(`/api/ai-conversations/${sourceId}/messages`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ role: "user", content: "个人历史消息" })
      .expect(201);
    const body = { messageId: message.body.data.id, requestId: "authorized-fork-request" };

    const csrfDenied = await collaborator.agent.post(`/api/ai-conversations/${sourceId}/fork`).send(body).expect(403);
    expect(csrfDenied.body.error.code).toBe("CSRF_TOKEN_INVALID");
    const first = await collaborator.agent.post(`/api/ai-conversations/${sourceId}/fork`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send(body)
      .expect(201);
    const retried = await collaborator.agent.post(`/api/ai-conversations/${sourceId}/fork`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send(body)
      .expect(201);
    expect(retried.body.data.id).toBe(first.body.data.id);
    expect(retried.body.data.messages).toHaveLength(1);
    const roleplayCharacter = await owner.agent.post(`/api/works/${workId}/characters`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ name: "受限角色" })
      .expect(201);
    const roleplaySource = await owner.agent.post(`/api/works/${workId}/ai-conversations`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "受限角色扮演对话" })
      .expect(201);
    await owner.agent.patch(`/api/ai-conversations/${roleplaySource.body.data.id}/roleplay`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ characterId: roleplayCharacter.body.data.id })
      .expect(200);
    const roleplayMessage = await owner.agent.post(`/api/ai-conversations/${roleplaySource.body.data.id}/messages`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ role: "user", content: "角色私有上下文" })
      .expect(201);
    runtime.database.run(
      "UPDATE ai_conversations SET created_by_user_id = ? WHERE id = ?",
      collaborator.user.userId,
      String(roleplaySource.body.data.id)
    );
    const characterDenied = await collaborator.agent.post(`/api/ai-conversations/${roleplaySource.body.data.id}/fork`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ messageId: roleplayMessage.body.data.id, requestId: "roleplay-fork-denied" })
      .expect(403);
    expect(characterDenied.body.error.code).toBe("WORK_MODULE_READ_DENIED");
    const outsiderDenied = await outsider.agent.post(`/api/ai-conversations/${sourceId}/fork`)
      .set("X-CSRF-Token", outsider.csrfToken)
      .send(body)
      .expect(403);
    expect(outsiderDenied.body.error.code).toBe("WORK_ACCESS_DENIED");
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM ai_conversation_forks WHERE source_conversation_id = ?", sourceId)).toEqual({ count: 1 });
  });

  it("type none 的显式 AI 引用仍要求对应模块读取权限", async () => {
    const owner = await register(runtime, "ai_explicit_ref_owner");
    const collaborator = await register(runtime, "ai_explicit_ref_collaborator");
    const work = await owner.agent.post("/api/works")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "AI 显式引用权限作品" })
      .expect(201);
    const workId = String(work.body.data.id);
    const volume = await owner.agent.post(`/api/works/${workId}/volumes`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "第一卷" })
      .expect(201);
    const chapter = await owner.agent.post(`/api/works/${workId}/chapters`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ volumeId: volume.body.data.id, title: "机密章节", content: "不得泄露的正文" })
      .expect(201);
    const character = await owner.agent.post(`/api/works/${workId}/characters`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ name: "机密角色" })
      .expect(201);
    const setting = await owner.agent.post(`/api/works/${workId}/settings`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "机密设定", category: "规则", content: "不得泄露的设定" })
      .expect(201);
    const race = await owner.agent.post(`/api/works/${workId}/races`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ name: "机密种族" })
      .expect(201);
    const organization = await owner.agent.post(`/api/works/${workId}/organizations`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ name: "机密组织" })
      .expect(201);
    await owner.agent.post(`/api/works/${workId}/members`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({
        userId: collaborator.user.userId,
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
          reviews: "none",
          "ai-chat": "write",
          "ai-analysis": "none",
          "ai-settings": "none"
        }
      })
      .expect(201);

    const restrictedScopes = [
      { type: "none", chapterIds: [chapter.body.data.id] },
      { type: "none", includeBookSummary: true },
      { type: "none", characterIds: [character.body.data.id] },
      { type: "none", mentionCharacterIds: [character.body.data.id] },
      { type: "none", settingIds: [setting.body.data.id] },
      { type: "none", raceIds: [race.body.data.id] },
      { type: "none", organizationIds: [organization.body.data.id] }
    ];
    for (const scope of restrictedScopes) {
      const denied = await collaborator.agent.post(`/api/works/${workId}/chat/stream`)
        .set("X-CSRF-Token", collaborator.csrfToken)
        .send({ instruction: "复述显式引用资料", scope })
        .expect(403);
      expect(denied.body.error.code).toBe("WORK_MODULE_READ_DENIED");
    }
    expect(runtime.database.get(
      "SELECT COUNT(*) AS count FROM ai_conversation_stream_requests WHERE work_id = ?",
      workId
    )).toEqual({ count: 0 });
  });

  it("AI 工具按当前成员模块权限限制正文读取", async () => {
    const owner = await register(runtime, "ai_tool_owner");
    const collaborator = await register(runtime, "ai_tool_collaborator");
    const work = await owner.agent.post("/api/works")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "AI 工具权限作品" })
      .expect(201);
    const workId = String(work.body.data.id);
    const volume = await owner.agent.post(`/api/works/${workId}/volumes`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "第一卷" })
      .expect(201);
    const chapter = await owner.agent.post(`/api/works/${workId}/chapters`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ volumeId: volume.body.data.id, title: "机密章", content: "TOP_SECRET_PROSE_TOOL" })
      .expect(201);
    await owner.agent.post(`/api/works/${workId}/timeline`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({
        name: "TOP_SECRET_TIMELINE_TOOL",
        timeLabel: "秘密时点",
        timeSort: 88,
        chapterIds: [chapter.body.data.id],
        status: "confirmed"
      })
      .expect(201);
    const permissions = {
      prose: "none",
      drafts: "none",
      settings: "none",
      characters: "none",
      races: "none",
      organizations: "none",
      timeline: "none",
      relationships: "none",
      outlines: "none",
      reviews: "none",
      "ai-chat": "write",
      "ai-analysis": "none",
      "ai-settings": "none"
    };
    await owner.agent.post(`/api/works/${workId}/members`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ userId: collaborator.user.userId, permissions })
      .expect(201);
    await owner.agent.patch(`/api/works/${workId}/ai-settings`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ agentTools: ["story_index", "read_chapters", "grep", "search_story_entities", "read_character_sections", "search_drafts"] })
      .expect(200);
    const protectedCharacter = await owner.agent.post(`/api/works/${workId}/characters`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ name: "受限角色" })
      .expect(201);
    const restrictedConversation = await collaborator.agent.post(`/api/works/${workId}/ai-conversations`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({})
      .expect(201);
    const roleplayDenied = await collaborator.agent.patch(`/api/ai-conversations/${restrictedConversation.body.data.id}/roleplay`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ characterId: protectedCharacter.body.data.id })
      .expect(403);
    expect(roleplayDenied.body.error.code).toBe("WORK_MODULE_READ_DENIED");

    const internalAi = runtime.ai as unknown as {
      enabledAgentToolIds: (candidateWorkId: string, taskType: "chat") => string[];
      executeAgentTool: (candidateWorkId: string, toolCall: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    const result = await runWithRequestActor({ ...collaborator.user, authentication: "session" }, async () => ({
      enabledTools: internalAi.enabledAgentToolIds(workId, "chat"),
      execution: await internalAi.executeAgentTool(workId, {
        id: "permission-check",
        type: "function",
        function: {
          name: "read_chapters",
          arguments: JSON.stringify({ chapterIds: [chapter.body.data.id], include: "content", cursor: 0 })
        }
      })
    }));

    expect(result.enabledTools).toEqual([]);
    expect(result.execution).toMatchObject({
      status: "failed",
      result: { ok: false, error: { code: "TOOL_NOT_AVAILABLE" } }
    });
    expect(JSON.stringify(result)).not.toContain("TOP_SECRET_PROSE_TOOL");

    await owner.agent.patch(`/api/works/${workId}/members/${collaborator.user.userId}`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ permissions: { ...permissions, prose: "read" } })
      .expect(200);
    const structureOnly = await runWithRequestActor(
      { ...collaborator.user, authentication: "session" },
      () => internalAi.executeAgentTool(workId, {
        id: "structure-only",
        type: "function",
        function: { name: "story_index", arguments: JSON.stringify({ offset: 0, limit: 20, cursor: 0 }) }
      })
    );
    expect(structureOnly).toMatchObject({ status: "completed", result: { ok: true } });
    expect(JSON.stringify(structureOnly)).toContain('"storyOrder"');
    expect(JSON.stringify(structureOnly)).not.toContain("TOP_SECRET_TIMELINE_TOOL");
    expect(JSON.stringify(structureOnly)).not.toContain("confirmedTimelineEvents");
  });

  it("AI 调用列表按成员权限隐藏原始上下文", async () => {
    const owner = await register(runtime, "ai_call_owner");
    const collaborator = await register(runtime, "ai_call_reader");
    const work = await owner.agent.post("/api/works")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "AI 调用权限作品" })
      .expect(201);
    const workId = String(work.body.data.id);
    const permissions = {
      prose: "none",
      drafts: "none",
      settings: "none",
      characters: "none",
      races: "none",
      organizations: "none",
      timeline: "none",
      relationships: "none",
      outlines: "none",
      reviews: "none",
      "ai-chat": "none",
      "ai-analysis": "read",
      "ai-settings": "none"
    };
    await owner.agent.post(`/api/works/${workId}/members`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ userId: collaborator.user.userId, permissions })
      .expect(201);
    const provider = await owner.agent.post("/api/platform/ai/providers")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ name: "调用记录供应商", baseUrl: "https://example.com", apiKey: "audit-call-key", status: "enabled" })
      .expect(201);
    const model = await owner.agent.post(`/api/providers/${provider.body.data.id}/models`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ displayName: "调用记录模型", modelId: "audit-call-model" })
      .expect(201);
    runtime.database.run(
      `INSERT INTO ai_calls (id, work_id, task_type, provider_id, model_id, context_scope_json, parameters_json,
       status, input_chars, created_at) VALUES (?, ?, 'chat', ?, ?, ?, '{}', 'completed', 1, ?)`,
      "call_restricted_context",
      workId,
      provider.body.data.id,
      model.body.data.id,
      JSON.stringify({
        type: "selection",
        selection: "TOP_SECRET_SELECTION_CONTEXT",
        chapterId: "chapter_secret",
        volumeId: "volume_secret",
        chapterIds: ["chapter_secret"],
        characterIds: ["character_secret"],
        settingIds: ["setting_secret"],
        includeBookSummary: true
      }),
      new Date().toISOString()
    );

    const response = await collaborator.agent.get(`/api/works/${workId}/ai-calls`).expect(200);
    expect(response.body.data[0].contextScope).toEqual({ type: "selection", restricted: true });
    expect(JSON.stringify(response.body.data)).not.toContain("TOP_SECRET_SELECTION_CONTEXT");
    expect(JSON.stringify(response.body.data)).not.toContain("chapter_secret");
    expect(JSON.stringify(response.body.data)).not.toContain("character_secret");
    expect(JSON.stringify(response.body.data)).not.toContain("setting_secret");
  });

  it("无角色读取权限时从对话消息 metadata 移除角色引用", async () => {
    const owner = await register(runtime, "ai_message_mention_owner");
    const collaborator = await register(runtime, "ai_message_mention_reader");
    const work = await owner.agent.post("/api/works")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "AI 消息角色引用权限作品" })
      .expect(201);
    const workId = String(work.body.data.id);
    const character = await owner.agent.post(`/api/works/${workId}/characters`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ name: "机密角色" })
      .expect(201);
    await owner.agent.post(`/api/works/${workId}/members`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({
        userId: collaborator.user.userId,
        permissions: {
          prose: "read",
          drafts: "none",
          settings: "none",
          characters: "none",
          races: "none",
          organizations: "none",
          timeline: "none",
          relationships: "none",
          outlines: "none",
          reviews: "none",
          "ai-chat": "write",
          "ai-analysis": "none",
          "ai-settings": "none"
        }
      })
      .expect(201);
    const conversation = await collaborator.agent.post(`/api/works/${workId}/ai-conversations`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({})
      .expect(201);
    const conversationId = String(conversation.body.data.id);
    runtime.store.addAiConversationMessage(conversationId, {
      role: "user",
      content: "可读取的对话正文",
      metadata: {
        mentionCharacterIds: [String(character.body.data.id)],
        mentionRaceIds: ["secret-race-id"],
        mentionOrganizationIds: ["secret-organization-id"],
        modelDisplayName: "保留的模型信息"
      }
    });

    const ownerView = await owner.agent.get(`/api/ai-conversations/${conversationId}`).expect(403);
    expect(ownerView.body.error.code).toBe("AI_CONVERSATION_ACCESS_DENIED");

    const collaboratorView = await collaborator.agent.get(`/api/ai-conversations/${conversationId}`).expect(200);
    expect(collaboratorView.body.data.messages[0]).toMatchObject({
      content: "可读取的对话正文",
      metadata: { modelDisplayName: "保留的模型信息" }
    });
    expect(collaboratorView.body.data.messages[0].metadata).not.toHaveProperty("mentionCharacterIds");
    expect(collaboratorView.body.data.messages[0].metadata).not.toHaveProperty("mentionRaceIds");
    expect(collaboratorView.body.data.messages[0].metadata).not.toHaveProperty("mentionOrganizationIds");

    const pagedView = await collaborator.agent.get(`/api/ai-conversations/${conversationId}?page=1&limit=20`).expect(200);
    expect(pagedView.body.data.messagesPage.items[0].metadata).toEqual({ modelDisplayName: "保留的模型信息" });
  });

  it("AI 建议与对话按成员正文权限脱敏", async () => {
    const owner = await register(runtime, "ai_redact_owner");
    const collaborator = await register(runtime, "ai_redact_reader");
    const outsider = await register(runtime, "ai_export_outsider");
    const work = await owner.agent.post("/api/works")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "AI 脱敏作品" })
      .expect(201);
    const workId = String(work.body.data.id);
    await owner.agent.post(`/api/works/${workId}/members`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({
        userId: collaborator.user.userId,
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
          reviews: "none",
          "ai-chat": "write",
          "ai-analysis": "write",
          "ai-settings": "none"
        }
      })
      .expect(201);

    const provider = await owner.agent.post("/api/platform/ai/providers")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ name: "脱敏供应商", baseUrl: "https://example.com", apiKey: "redact-key", status: "enabled" })
      .expect(201);
    const model = await owner.agent.post(`/api/providers/${provider.body.data.id}/models`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ displayName: "脱敏模型", modelId: "redact-model" })
      .expect(201);
    const callId = "call_redact_suggestion";
    const suggestionId = "suggestion_redact_source";
    const guardId = "guard_redact_evidence";
    const conversationId = "conversation_redact_messages";
    const now = new Date().toISOString();
    runtime.database.run(
      `INSERT INTO ai_calls (id, work_id, task_type, provider_id, model_id, context_scope_json, parameters_json,
       status, input_chars, created_at) VALUES (?, ?, 'rewrite', ?, ?, '{}', '{}', 'completed', 1, ?)`,
      callId,
      workId,
      provider.body.data.id,
      model.body.data.id,
      now
    );
    runtime.database.run(
      `INSERT INTO ai_suggestions (id, call_id, work_id, chapter_id, chapter_version, task_type, instruction,
       source_text, content, action, status, created_at) VALUES (?, ?, ?, NULL, NULL, 'rewrite', ?, ?, '建议正文', 'replace', 'pending', ?)`,
      suggestionId,
      callId,
      workId,
      "TOP_SECRET_SUGGESTION_INSTRUCTION",
      "TOP_SECRET_SOURCE_TEXT",
      now
    );
    runtime.database.run(
      `INSERT INTO continuation_guard_runs (id, suggestion_id, call_id, chapter_version, content_hash, status,
       issues_json, context_refs_json, failure, created_at) VALUES (?, ?, ?, 1, 'guard-hash', 'warning', ?, ?, ?, ?)`,
      guardId,
      suggestionId,
      callId,
      JSON.stringify([{ description: "TOP_SECRET_GUARD_ISSUE", candidateQuote: "TOP_SECRET_CANDIDATE_QUOTE" }]),
      JSON.stringify({ chapter: "TOP_SECRET_GUARD_CONTEXT" }),
      "TOP_SECRET_GUARD_FAILURE",
      now
    );
    runtime.database.run(
      `INSERT INTO ai_conversations (id, work_id, title, compacted_summary, compacted_message_count, created_at, updated_at, created_by_user_id)
       VALUES (?, ?, 'TOP_SECRET_CHAT_TITLE', '', 0, ?, ?, ?)`,
      conversationId,
      workId,
      now,
      now,
      collaborator.user.userId
    );
    runtime.database.run(
      `INSERT INTO ai_conversation_messages (id, conversation_id, role, content, citations_json, metadata_json, created_at)
       VALUES (?, ?, 'assistant', ?, ?, ?, ?)`,
      "message_redact_1",
      conversationId,
      "包含 TOP_SECRET_CHAT_PROSE 的回复",
      JSON.stringify([{ chapterId: "chapter_secret", text: "TOP_SECRET_CITATION_TEXT" }]),
      JSON.stringify({
        toolCalls: [{ result: { excerpt: "TOP_SECRET_TOOL_RESULT" } }],
        processSteps: [{ content: "TOP_SECRET_PROCESS_STEP" }]
      }),
      now
    );

    const suggestion = await collaborator.agent.get(`/api/suggestions/${suggestionId}`).expect(200);
    expect(suggestion.body.data.sourceText).toBe("");
    expect(suggestion.body.data.instruction).toBe("（正文读取权限受限）");
    expect(suggestion.body.data.guard).toMatchObject({ issues: [], contextRefs: {}, failure: null, restricted: true });
    expect(suggestion.body.data.restricted).toBe(true);
    expect(JSON.stringify(suggestion.body.data)).not.toContain("TOP_SECRET_");

    const suggestions = await collaborator.agent.get(`/api/works/${workId}/suggestions`).expect(200);
    expect(JSON.stringify(suggestions.body.data)).not.toContain("TOP_SECRET_");

    const guards = await collaborator.agent.get(`/api/suggestions/${suggestionId}/guards`).expect(200);
    expect(guards.body.data[0]).toMatchObject({ issues: [], contextRefs: {}, failure: null, restricted: true });
    expect(JSON.stringify(guards.body.data)).not.toContain("TOP_SECRET_");

    const conversation = await collaborator.agent.get(`/api/ai-conversations/${conversationId}`).expect(200);
    expect(conversation.body.data.title).toBe("（正文读取权限受限）");
    expect(conversation.body.data.messages[0].content).toBe("（正文读取权限受限）");
    expect(conversation.body.data.messages[0].citations).toEqual([]);
    expect(conversation.body.data.messages[0].metadata).toEqual({ restricted: true });
    expect(JSON.stringify(conversation.body.data)).not.toContain("TOP_SECRET_");

    const exportedConversation = await collaborator.agent.get(`/api/ai-conversations/${conversationId}/export`).expect(200);
    expect(exportedConversation.text).toContain("（正文读取权限受限）");
    expect(exportedConversation.text).not.toContain("TOP_SECRET_");
    const exportDenied = await outsider.agent.get(`/api/ai-conversations/${conversationId}/export`).expect(403);
    expect(exportDenied.body.error.code).toBe("WORK_ACCESS_DENIED");

    const conversations = await collaborator.agent.get(`/api/works/${workId}/ai-conversations`).expect(200);
    expect(conversations.body.data.items[0].title).toBe("（正文读取权限受限）");
    expect(conversations.body.data.items[0].preview).toBe("（正文读取权限受限）");
    expect(JSON.stringify(conversations.body.data)).not.toContain("TOP_SECRET_");

    const postedMessage = await collaborator.agent.post(`/api/ai-conversations/${conversationId}/messages`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({
        role: "user",
        content: "TOP_SECRET_POSTED_MESSAGE",
        citations: [{ chapterId: "chapter_secret", chapterTitle: "第一章", startLine: 1, endLine: 1, text: "TOP_SECRET_POSTED_CITATION" }],
        metadata: { modelDisplayName: "TOP_SECRET_POSTED_METADATA" }
      })
      .expect(201);
    expect(postedMessage.body.data).toMatchObject({
      content: "（正文读取权限受限）",
      citations: [],
      metadata: { restricted: true },
      restricted: true
    });
    expect(JSON.stringify(postedMessage.body.data)).not.toContain("TOP_SECRET_");

    for (const attempt of [
      collaborator.agent.post(`/api/suggestions/${suggestionId}/guard`).set("X-CSRF-Token", collaborator.csrfToken).send({ content: "候选内容" }),
      collaborator.agent.post(`/api/ai-conversations/${conversationId}/context/prepare`).set("X-CSRF-Token", collaborator.csrfToken).send({ scope: { type: "none" }, instruction: "继续" }),
      collaborator.agent.post(`/api/ai-conversations/${conversationId}/compact`).set("X-CSRF-Token", collaborator.csrfToken).send({ scope: { type: "none" } }),
      collaborator.agent.post(`/api/ai-conversations/${conversationId}/fork`).set("X-CSRF-Token", collaborator.csrfToken).send({ messageId: "message_redact_1" }),
      collaborator.agent.post(`/api/works/${workId}/chat/stream`).set("X-CSRF-Token", collaborator.csrfToken).send({
        instruction: "复述先前历史",
        scope: { type: "none" },
        conversationId
      })
    ]) {
      const denied = await attempt.expect(403);
      expect(denied.body.error.code).toBe("WORK_MODULE_READ_DENIED");
    }

    const rejected = await collaborator.agent.post(`/api/suggestions/${suggestionId}/reject`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({})
      .expect(200);
    expect(rejected.body.data).toMatchObject({
      instruction: "（正文读取权限受限）",
      sourceText: "",
      restricted: true
    });
    expect(JSON.stringify(rejected.body.data)).not.toContain("TOP_SECRET_");
  });

  it("成员变更保护作品创建者，并在审计失败时回滚", async () => {
    const owner = await register(runtime, "member_owner");
    const collaborator = await register(runtime, "member_transaction_target");
    const work = await owner.agent.post("/api/works")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "成员事务作品" })
      .expect(201);
    const workId = String(work.body.data.id);

    const overwriteOwner = await owner.agent.post(`/api/works/${workId}/members`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ userId: owner.user.userId, role: "viewer" })
      .expect(409);
    expect(overwriteOwner.body.error.code).toBe("OWNER_REQUIRED");
    expect(runtime.database.get(
      "SELECT role FROM work_memberships WHERE work_id = ? AND user_id = ?",
      workId,
      owner.user.userId
    )).toEqual({ role: "owner" });

    runtime.database.raw.exec(`
      CREATE TRIGGER reject_member_audit BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'work.member-added'
      BEGIN
        SELECT RAISE(ABORT, 'forced member audit failure');
      END
    `);
    await owner.agent.post(`/api/works/${workId}/members`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ userId: collaborator.user.userId, role: "viewer" })
      .expect(500);
    expect(runtime.database.get(
      "SELECT role FROM work_memberships WHERE work_id = ? AND user_id = ?",
      workId,
      collaborator.user.userId
    )).toBeUndefined();
    runtime.database.raw.exec("DROP TRIGGER reject_member_audit");

    await owner.agent.post(`/api/works/${workId}/members`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ userId: collaborator.user.userId, role: "viewer" })
      .expect(201);
    expect(runtime.database.get(
      "SELECT action FROM audit_logs WHERE work_id = ? AND action = 'work.member-added'",
      workId
    )).toEqual({ action: "work.member-added" });
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("仅向对话创建者暴露对话 Session ID，不暴露认证会话 ID", async () => {
    const owner = await register(runtime, "ai_session_id_owner");
    const reader = await register(runtime, "ai_session_id_reader");
    const outsider = await register(runtime, "ai_session_id_outsider");
    const work = await owner.agent.post("/api/works")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "Session ID 权限边界作品" })
      .expect(201);
    const workId = String(work.body.data.id);
    await owner.agent.post(`/api/works/${workId}/members`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({
        userId: reader.user.userId,
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
          reviews: "none",
          "ai-chat": "write",
          "ai-analysis": "none",
          "ai-settings": "none"
        }
      })
      .expect(201);
    const created = await reader.agent.post(`/api/works/${workId}/ai-conversations`)
      .set("X-CSRF-Token", reader.csrfToken)
      .send({ title: "诊断对话" })
      .expect(201);
    const conversationId = String(created.body.data.id);

    const unauthenticated = await request(runtime.app).get(`/api/ai-conversations/${conversationId}`).expect(401);
    expect(unauthenticated.body.error.code).toBe("AUTH_REQUIRED");
    const forbidden = await outsider.agent.get(`/api/ai-conversations/${conversationId}`).expect(403);
    expect(forbidden.body.error.code).toBe("WORK_ACCESS_DENIED");
    const ownerDenied = await owner.agent.get(`/api/ai-conversations/${conversationId}`).expect(403);
    expect(ownerDenied.body.error.code).toBe("AI_CONVERSATION_ACCESS_DENIED");

    const readable = await reader.agent.get(`/api/ai-conversations/${conversationId}`).expect(200);
    expect(readable.body.data.id).toBe(conversationId);
    expect(readable.body.data).not.toHaveProperty("sessionId");
    expect(readable.body.data).not.toHaveProperty("csrfToken");
    expect(readable.body.data).not.toHaveProperty("token");

    const authSession = await reader.agent.get("/api/auth/session").expect(200);
    expect(authSession.body.data).not.toHaveProperty("id");
    expect(authSession.body.data).not.toHaveProperty("sessionId");
    expect(authSession.body.data).not.toHaveProperty("token");
    expect(authSession.body.data.csrfToken).toBe(reader.csrfToken);
  });

  it("作品 Chat 仅返回当前用户对话，管理员可从系统列表查看全部对话", async () => {
    const admin = await register(runtime, "conversation_owner_admin");
    const collaborator = await register(runtime, "conversation_owner_collaborator");
    const work = await admin.agent.post("/api/works")
      .set("X-CSRF-Token", admin.csrfToken)
      .send({ title: "对话归属作品" })
      .expect(201);
    const workId = String(work.body.data.id);
    await admin.agent.post(`/api/works/${workId}/members`)
      .set("X-CSRF-Token", admin.csrfToken)
      .send({
        userId: collaborator.user.userId,
        permissions: {
          prose: "read",
          drafts: "none",
          settings: "none",
          characters: "none",
          races: "none",
          organizations: "none",
          timeline: "none",
          relationships: "none",
          outlines: "none",
          reviews: "none",
          "ai-chat": "write",
          "ai-analysis": "none",
          "ai-settings": "none"
        }
      })
      .expect(201);

    const adminConversation = await admin.agent.post(`/api/works/${workId}/ai-conversations`)
      .set("X-CSRF-Token", admin.csrfToken)
      .send({ title: "管理员私有对话" })
      .expect(201);
    const collaboratorConversation = await collaborator.agent.post(`/api/works/${workId}/ai-conversations`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ title: "协作者私有对话" })
      .expect(201);
    await collaborator.agent.post(`/api/ai-conversations/${collaboratorConversation.body.data.id}/messages`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ role: "user", content: "协作者独有搜索词" })
      .expect(201);

    const adminList = await admin.agent.get(`/api/works/${workId}/ai-conversations`).expect(200);
    expect(adminList.body.data.items.map((item: { id: string }) => item.id)).toEqual([adminConversation.body.data.id]);
    const collaboratorList = await collaborator.agent.get(`/api/works/${workId}/ai-conversations`).expect(200);
    expect(collaboratorList.body.data.items.map((item: { id: string }) => item.id)).toEqual([collaboratorConversation.body.data.id]);

    const adminDirectDenied = await admin.agent.get(`/api/ai-conversations/${collaboratorConversation.body.data.id}`).expect(403);
    expect(adminDirectDenied.body.error.code).toBe("AI_CONVERSATION_ACCESS_DENIED");
    const collaboratorDirectDenied = await collaborator.agent.get(`/api/ai-conversations/${adminConversation.body.data.id}`).expect(403);
    expect(collaboratorDirectDenied.body.error.code).toBe("AI_CONVERSATION_ACCESS_DENIED");
    const crossWriteDenied = await collaborator.agent.patch(`/api/ai-conversations/${adminConversation.body.data.id}/favorite`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ isFavorite: true })
      .expect(403);
    expect(crossWriteDenied.body.error.code).toBe("AI_CONVERSATION_ACCESS_DENIED");
    const crossStreamDenied = await collaborator.agent.post(`/api/works/${workId}/chat/stream`)
      .set("X-CSRF-Token", collaborator.csrfToken)
      .send({ instruction: "继续", scope: { type: "none" }, conversationId: adminConversation.body.data.id })
      .expect(403);
    expect(crossStreamDenied.body.error.code).toBe("AI_CONVERSATION_ACCESS_DENIED");

    const collaboratorSearch = await collaborator.agent
      .get(`/api/works/${workId}/search?q=${encodeURIComponent("协作者独有搜索词")}&type=agent-history`)
      .expect(200);
    expect(collaboratorSearch.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ conversationId: collaboratorConversation.body.data.id })
    ]));
    const adminSearch = await admin.agent
      .get(`/api/works/${workId}/search?q=${encodeURIComponent("协作者独有搜索词")}&type=agent-history`)
      .expect(200);
    expect(adminSearch.body.data).toEqual([]);

    const platformList = await admin.agent.get("/api/platform/ai-conversations?page=1&limit=20").expect(200);
    expect(platformList.body.data.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: adminConversation.body.data.id,
        work: expect.objectContaining({ id: workId, title: "对话归属作品" }),
        creator: expect.objectContaining({ userId: admin.user.userId })
      }),
      expect.objectContaining({
        id: collaboratorConversation.body.data.id,
        creator: expect.objectContaining({ userId: collaborator.user.userId })
      })
    ]));
    const filteredPlatformList = await admin.agent
      .get(`/api/platform/ai-conversations?q=${encodeURIComponent("协作者独有搜索词")}&userId=${encodeURIComponent(collaborator.user.userId)}`)
      .expect(200);
    expect(filteredPlatformList.body.data.items.map((item: { id: string }) => item.id)).toEqual([collaboratorConversation.body.data.id]);
    const nonAdminPlatformDenied = await collaborator.agent.get("/api/platform/ai-conversations").expect(403);
    expect(nonAdminPlatformDenied.body.error.code).toBe("ADMIN_REQUIRED");
  });

  it("首位管理员注册时自动接管迁移前的现有作品", async () => {
    const legacyWork = runtime.store.createWork({ title: "既有作品" });
    const legacyConversation = runtime.store.createAiConversation(String(legacyWork.id), "既有历史对话");
    const admin = await register(runtime, "first_admin");
    const works = await admin.agent.get("/api/works").expect(200);
    expect(works.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: legacyWork.id, accessRole: "owner" })]));
    expect(runtime.database.get("SELECT owner_user_id FROM works WHERE id = ?", String(legacyWork.id))?.owner_user_id).toBe(admin.user.userId);
    expect(runtime.database.get("SELECT role FROM work_memberships WHERE work_id = ? AND user_id = ?", String(legacyWork.id), admin.user.userId)?.role).toBe("owner");
    expect(runtime.database.get(
      "SELECT created_by_user_id FROM ai_conversations WHERE id = ?",
      String(legacyConversation.id)
    )?.created_by_user_id).toBe(admin.user.userId);
  });

  it("管理员可管理账户，但不能停用自己或移除最后一名管理员", async () => {
    const admin = await register(runtime, "root_admin");
    const writer = await register(runtime, "normal_writer");
    await admin.agent.patch(`/api/users/${admin.user.userId}`).set("X-CSRF-Token", admin.csrfToken).send({ role: "user" }).expect(409);
    const promoted = await admin.agent.patch(`/api/users/${writer.user.userId}`).set("X-CSRF-Token", admin.csrfToken).send({ role: "admin" }).expect(200);
    expect(promoted.body.data.role).toBe("admin");
    const disabled = await admin.agent.patch(`/api/users/${writer.user.userId}`).set("X-CSRF-Token", admin.csrfToken).send({ status: "disabled" }).expect(200);
    expect(disabled.body.data.status).toBe("disabled");
    expect(runtime.database.get(
      "SELECT COUNT(*) AS count FROM user_sessions WHERE user_id = ? AND revoked_at IS NULL",
      writer.user.userId
    )).toEqual({ count: 0 });
    await writer.agent.get("/api/works").expect(401);
  });

  it("大小写变体 API 路径不能绕过鉴权、作品授权或管理员校验", async () => {
    const admin = await register(runtime, "case_admin");
    const writer = await register(runtime, "case_writer");
    const outsider = await register(runtime, "case_outsider");
    const work = await admin.agent.post("/api/works").set("X-CSRF-Token", admin.csrfToken).send({ title: "大小写作品" }).expect(201);
    const workId = work.body.data.id as string;
    await admin.agent.post(`/api/works/${workId}/members`).set("X-CSRF-Token", admin.csrfToken).send({
      userId: writer.user.userId,
      role: "editor"
    }).expect(201);

    await request(runtime.app).get(`/API/WORKS/${workId}`).expect(401);
    await request(runtime.app).get(`/api/WORKS/${workId}`).expect(401);
    await outsider.agent.get(`/API/WORKS/${workId}`).expect(403);
    await outsider.agent.get(`/api/WORKS/${workId}`).expect(403);
    await writer.agent.get(`/API/WORKS/${workId}`).expect(200);
    await writer.agent.get(`/api/WORKS/${workId}`).expect(200);

    const escalateUpper = await writer.agent.patch(`/API/USERS/${writer.user.userId}`)
      .set("X-CSRF-Token", writer.csrfToken)
      .send({ role: "admin" })
      .expect(403);
    expect(escalateUpper.body.error.code).toBe("ADMIN_REQUIRED");
    const escalateMixed = await writer.agent.patch(`/api/USERS/${writer.user.userId}`)
      .set("X-CSRF-Token", writer.csrfToken)
      .send({ role: "admin" })
      .expect(403);
    expect(escalateMixed.body.error.code).toBe("ADMIN_REQUIRED");
    expect(runtime.database.get("SELECT role FROM users WHERE id = ?", writer.user.userId)?.role).toBe("user");
  });

  it("供应商与模型连接测试在外部调用前强制认证、CSRF 和管理员权限", async () => {
    const admin = await register(runtime, "connectivity_admin");
    const writer = await register(runtime, "connectivity_writer");
    const provider = await admin.agent.post("/api/platform/ai/providers")
      .set("X-CSRF-Token", admin.csrfToken)
      .send({
        name: "权限测试供应商",
        baseUrl: "https://permission-ai.test/v1",
        apiKey: "sk-permission-test",
        status: "enabled"
      })
      .expect(201);
    const providerId = String(provider.body.data.id);
    const model = await admin.agent.post(`/api/providers/${providerId}/models`)
      .set("X-CSRF-Token", admin.csrfToken)
      .send({ displayName: "权限测试模型", modelId: "permission-model" })
      .expect(201);
    const modelId = String(model.body.data.id);

    await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(401);
    await request(runtime.app).post(`/api/models/${modelId}/test`).send({}).expect(401);
    const providerDenied = await writer.agent.post(`/api/providers/${providerId}/test`)
      .set("X-CSRF-Token", writer.csrfToken)
      .send({})
      .expect(403);
    expect(providerDenied.body.error.code).toBe("ADMIN_REQUIRED");
    const modelDenied = await writer.agent.post(`/api/models/${modelId}/test`)
      .set("X-CSRF-Token", writer.csrfToken)
      .send({})
      .expect(403);
    expect(modelDenied.body.error.code).toBe("ADMIN_REQUIRED");
    const providerCsrfDenied = await admin.agent.post(`/api/providers/${providerId}/test`).send({}).expect(403);
    expect(providerCsrfDenied.body.error.code).toBe("CSRF_TOKEN_INVALID");
    const modelCsrfDenied = await admin.agent.post(`/api/models/${modelId}/test`).send({}).expect(403);
    expect(modelCsrfDenied.body.error.code).toBe("CSRF_TOKEN_INVALID");

    expect(runtime.database.get("SELECT COUNT(*) AS count FROM ai_connectivity_test_states")).toEqual({ count: 0 });
    expect(runtime.database.get("SELECT connection_status FROM providers WHERE id = ?", providerId)).toEqual({ connection_status: "unchecked" });
  });

  it("管理员可统一设置界面与分模块分页，普通用户只能读取", async () => {
    const admin = await register(runtime, "ui_admin");
    const writer = await register(runtime, "ui_writer");

    const defaults = await writer.agent.get("/api/ui-settings").expect(200);
    expect(defaults.body.data).toMatchObject({
      toastPosition: "bottom-right",
      galaxyFrameRate: 30,
      pageSizes: {
        settings: 30,
        characters: 30,
        races: 30,
        organizations: 30,
        timeline: 30,
        outlines: 30,
        relationships: 30,
        comments: 30,
        reviews: 30,
        analysisTasks: 30,
        fileVersions: 30
      }
    });
    await writer.agent.get("/api/platform/ui-settings").expect(403);
    await writer.agent.patch("/api/platform/ui-settings")
      .set("X-CSRF-Token", writer.csrfToken)
      .send({ toastPosition: "top-right" })
      .expect(403);
    await admin.agent.patch("/api/platform/ui-settings").send({ toastPosition: "top-right" }).expect(403);
    await admin.agent.patch("/api/platform/ui-settings")
      .set("X-CSRF-Token", admin.csrfToken)
      .send({ toastPosition: "top-left" })
      .expect(400);
    await admin.agent.patch("/api/platform/ui-settings")
      .set("X-CSRF-Token", admin.csrfToken)
      .send({ toastPosition: "top-right", unknown: true })
      .expect(400);
    await admin.agent.patch("/api/platform/ui-settings")
      .set("X-CSRF-Token", admin.csrfToken)
      .send({ pageSizes: { characters: 9 } })
      .expect(400);
    await admin.agent.patch("/api/platform/ui-settings")
      .set("X-CSRF-Token", admin.csrfToken)
      .send({ pageSizes: { chapters: 20 } })
      .expect(400);
    await admin.agent.patch("/api/platform/ui-settings")
      .set("X-CSRF-Token", admin.csrfToken)
      .send({ galaxyFrameRate: 25 })
      .expect(400);

    const updated = await admin.agent.patch("/api/platform/ui-settings")
      .set("X-CSRF-Token", admin.csrfToken)
      .send({
        toastPosition: "top-right",
        galaxyFrameRate: 144,
        pageSizes: {
          settings: 18,
          characters: 20,
          races: 21,
          organizations: 22,
          timeline: 23,
          outlines: 24,
          relationships: 25,
          comments: 27,
          reviews: 26,
          analysisTasks: 40,
          fileVersions: 15
        }
      })
      .expect(200);
    expect(updated.body.data).toMatchObject({
      toastPosition: "top-right",
      galaxyFrameRate: 144,
      pageSizes: {
        settings: 18,
        characters: 20,
        races: 21,
        organizations: 22,
        timeline: 23,
        outlines: 24,
        relationships: 25,
        comments: 27,
        reviews: 26,
        analysisTasks: 40,
        fileVersions: 15
      }
    });
    for (const galaxyFrameRate of [165, 240]) {
      const highRefreshUpdate = await admin.agent.patch("/api/platform/ui-settings")
        .set("X-CSRF-Token", admin.csrfToken)
        .send({ galaxyFrameRate })
        .expect(200);
      expect(highRefreshUpdate.body.data.galaxyFrameRate).toBe(galaxyFrameRate);
    }
    const partialUpdate = await admin.agent.patch("/api/platform/ui-settings")
      .set("X-CSRF-Token", admin.csrfToken)
      .send({ pageSizes: { characters: 25 } })
      .expect(200);
    expect(partialUpdate.body.data).toMatchObject({
      toastPosition: "top-right",
      galaxyFrameRate: 240,
      pageSizes: { settings: 18, characters: 25, races: 21, organizations: 22, timeline: 23, outlines: 24, relationships: 25, comments: 27, reviews: 26, analysisTasks: 40, fileVersions: 15 }
    });
    const visibleToWriter = await writer.agent.get("/api/ui-settings").expect(200);
    expect(visibleToWriter.body.data).toMatchObject({
      toastPosition: "top-right",
      galaxyFrameRate: 240,
      pageSizes: { settings: 18, characters: 25, races: 21, organizations: 22, timeline: 23, outlines: 24, relationships: 25, comments: 27, reviews: 26, analysisTasks: 40, fileVersions: 15 }
    });
    expect(runtime.database.get(
      "SELECT action, user_id FROM audit_logs WHERE action = 'platform.ui-settings.updated'"
    )).toEqual({ action: "platform.ui-settings.updated", user_id: admin.user.userId });
  });

  it("用户可修改自己的显示名称和密码", async () => {
    const user = await register(runtime, "profile_user");
    const profile = await user.agent.patch("/api/auth/profile").set("X-CSRF-Token", user.csrfToken).send({ displayName: "新名称" }).expect(200);
    expect(profile.body.data.displayName).toBe("新名称");
    const wrongCurrentPassword = await user.agent.patch("/api/auth/password").set("X-CSRF-Token", user.csrfToken).send({
      currentPassword: "wrong-current-password",
      newPassword: "new-secure-password-456",
      passwordConfirmation: "new-secure-password-456"
    }).expect(401);
    expect(wrongCurrentPassword.body.error).toMatchObject({
      code: "INVALID_CURRENT_PASSWORD",
      message: "当前密码错误，请重新输入"
    });
    await user.agent.patch("/api/auth/password").set("X-CSRF-Token", user.csrfToken).send({
      currentPassword: "secure-password-123",
      newPassword: "new-secure-password-456",
      passwordConfirmation: "new-secure-password-456"
    }).expect(204);
    const staleLogin = await solveCaptcha(runtime.app);
    await request(runtime.app).post("/api/auth/login").send({
      username: "profile_user",
      password: "secure-password-123",
      ...staleLogin
    }).expect(401);
    const loginCaptcha = await solveCaptcha(runtime.app);
    await request(runtime.app).post("/api/auth/login").send({
      username: "profile_user",
      password: "new-secure-password-456",
      ...loginCaptcha
    }).expect(200);
  });

  it("修改密码必须二次确认且两次新密码相同", async () => {
    const user = await register(runtime, "password_change_confirm_user");
    const response = await user.agent.patch("/api/auth/password").set("X-CSRF-Token", user.csrfToken).send({
      currentPassword: "secure-password-123",
      newPassword: "new-secure-password-456",
      passwordConfirmation: "different-password-456"
    }).expect(400);
    expect(response.body.error.details).toContainEqual(expect.objectContaining({
      path: "passwordConfirmation",
      message: "两次输入的密码不一致"
    }));
  });

  it("用户可安全上传、读取、替换和移除自己的头像", async () => {
    const user = await register(runtime, "avatar_user");
    const viewer = await register(runtime, "avatar_viewer");
    expect(user.user).toMatchObject({ avatarUrl: null });

    await request(runtime.app).put("/api/auth/avatar").attach("file", onePixelPng, "avatar.png").expect(401);
    await user.agent.put("/api/auth/avatar").attach("file", onePixelPng, "avatar.png").expect(403);
    const invalid = await user.agent.put("/api/auth/avatar")
      .set("X-CSRF-Token", user.csrfToken)
      .attach("file", Buffer.from("not an image"), "avatar.png")
      .expect(415);
    expect(invalid.body.error.code).toBe("INVALID_AVATAR");

    const gifUploaded = await user.agent.put("/api/auth/avatar")
      .set("X-CSRF-Token", user.csrfToken)
      .attach("file", onePixelGif, "avatar.gif")
      .expect(200);
    const gifAvatar = await viewer.agent.get(String(gifUploaded.body.data.avatarUrl)).expect(200);
    expect(gifAvatar.headers["content-type"]).toBe("image/gif");
    expect(Buffer.from(gifAvatar.body)).toEqual(onePixelGif);
    expect(runtime.database.get("SELECT mime_type, width, height FROM user_avatars WHERE user_id = ?", user.user.userId)).toEqual({
      mime_type: "image/gif",
      width: 1,
      height: 1
    });
    await user.agent.put("/api/auth/avatar")
      .set("X-CSRF-Token", user.csrfToken)
      .attach("file", gifOfSize(maximumAvatarImageUploadBytes), "large.gif")
      .expect(200);
    expect(runtime.database.get("SELECT byte_length FROM user_avatars WHERE user_id = ?", user.user.userId)?.byte_length).toBe(maximumAvatarImageUploadBytes);

    const uploaded = await user.agent.put("/api/auth/avatar")
      .set("X-CSRF-Token", user.csrfToken)
      .attach("file", onePixelPng, "avatar.png")
      .expect(200);
    expect(uploaded.body.data.avatarUrl).toMatch(new RegExp(`^/api/user-avatars/${user.user.userId}\\?v=`, "u"));
    const avatarUrl = String(uploaded.body.data.avatarUrl);
    const avatar = await viewer.agent.get(avatarUrl).expect(200);
    expect(avatar.headers["content-type"]).toBe("image/png");
    expect(avatar.headers["content-length"]).toBe(String(onePixelPng.byteLength));
    expect(avatar.headers.etag).toMatch(/^"[a-f0-9]{64}"$/u);
    expect(avatar.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(Buffer.from(avatar.body)).toEqual(onePixelPng);
    expect(runtime.database.get("SELECT mime_type, width, height FROM user_avatars WHERE user_id = ?", user.user.userId)).toEqual({
      mime_type: "image/png",
      width: 1,
      height: 1
    });

    const session = await user.agent.get("/api/auth/session").expect(200);
    expect(session.body.data.user.avatarUrl).toBe(avatarUrl);
    const directory = await viewer.agent.get("/api/users/directory?q=avatar_user").expect(200);
    expect(directory.body.data[0]).toMatchObject({ userId: user.user.userId, avatarUrl });
    expect(runtime.database.get("SELECT action FROM audit_logs WHERE entity_id = ? AND action = 'user.avatar-updated'", user.user.userId)).toEqual({
      action: "user.avatar-updated"
    });

    const oversizedGif = await user.agent.put("/api/auth/avatar")
      .set("X-CSRF-Token", user.csrfToken)
      .attach("file", gifOfSize(maximumAvatarImageUploadBytes + 1), "too-large.gif")
      .expect(413);
    expect(oversizedGif.body.error.code).toBe("IMAGE_TOO_LARGE");
    expect(oversizedGif.body.error.message).toBe("头像图片不能超过 2 MB");
    const oversized = await user.agent.put("/api/auth/avatar")
      .set("X-CSRF-Token", user.csrfToken)
      .attach("file", pngOfSize(maximumAvatarImageUploadBytes + 1), "too-large.png")
      .expect(413);
    expect(oversized.body.error.code).toBe("IMAGE_TOO_LARGE");
    expect(oversized.body.error.message).toBe("头像图片不能超过 2 MB");
    expect(runtime.database.get("SELECT byte_length FROM user_avatars WHERE user_id = ?", user.user.userId)?.byte_length).toBe(onePixelPng.byteLength);

    const removed = await user.agent.delete("/api/auth/avatar").set("X-CSRF-Token", user.csrfToken).expect(200);
    expect(removed.body.data.avatarUrl).toBeNull();
    await viewer.agent.get(avatarUrl).expect(404);
    expect(runtime.database.get("SELECT * FROM user_avatars WHERE user_id = ?", user.user.userId)).toBeUndefined();
    expect(runtime.database.get("SELECT action FROM audit_logs WHERE entity_id = ? AND action = 'user.avatar-deleted'", user.user.userId)).toEqual({
      action: "user.avatar-deleted"
    });
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("用户可重置 API Key，且密钥仅访问所属用户的作品数据和 CLI 白名单", async () => {
    const admin = await register(runtime, "api_admin");
    const writer = await register(runtime, "api_writer");
    const adminWork = await admin.agent.post("/api/works").set("X-CSRF-Token", admin.csrfToken).send({ title: "管理员私有作品" }).expect(201);
    const writerWork = await writer.agent.post("/api/works").set("X-CSRF-Token", writer.csrfToken).send({ title: "作者私有作品" }).expect(201);
    const adminWorkId = String(adminWork.body.data.id);
    const writerWorkId = String(writerWork.body.data.id);

    const emptyStatus = await admin.agent.get("/api/auth/api-key").expect(200);
    expect(emptyStatus.body.data).toEqual({
      configured: false,
      prefix: null,
      createdAt: null,
      rotatedAt: null,
      lastUsedAt: null,
      copyable: false
    });
    await admin.agent.post("/api/auth/api-key/reveal")
      .set("X-CSRF-Token", admin.csrfToken)
      .send({})
      .expect(404);

    const firstReset = await admin.agent.post("/api/auth/api-key/reset")
      .set("X-CSRF-Token", admin.csrfToken)
      .send({})
      .expect(200);
    const firstKey = String(firstReset.body.data.apiKey);
    expect(firstKey).toMatch(/^scrv_[A-Za-z0-9_-]{43}$/u);
    expect(firstReset.body.data).toMatchObject({ configured: true, prefix: firstKey.slice(0, 13), lastUsedAt: null, copyable: true });
    const storedKey = runtime.database.get("SELECT * FROM user_api_keys WHERE user_id = ?", admin.user.userId);
    expect(storedKey?.key_hash).not.toBe(firstKey);
    expect(storedKey?.key_encrypted).toBeTruthy();
    expect(JSON.stringify(storedKey)).not.toContain(firstKey);
    const copied = await admin.agent.post("/api/auth/api-key/reveal")
      .set("X-CSRF-Token", admin.csrfToken)
      .send({})
      .expect(200);
    expect(copied.body.data).toEqual({ apiKey: firstKey });
    await admin.agent.post("/api/auth/api-key/reveal").send({}).expect(403);
    await request(runtime.app).post("/api/auth/api-key/reveal").send({}).expect(401);

    const cliSession = await request(runtime.app).get("/api/cli/session").set("Authorization", `Bearer ${firstKey}`).expect(200);
    expect(cliSession.body.data).toMatchObject({
      authenticated: true,
      user: { userId: admin.user.userId, username: "api_admin" },
      apiKeyPrefix: firstKey.slice(0, 13)
    });
    const adminKeyWorks = await request(runtime.app).get("/api/works").set("Authorization", `Bearer ${firstKey}`).expect(200);
    expect(adminKeyWorks.body.data.map((work: { id: string }) => work.id)).toEqual([adminWorkId]);
    await request(runtime.app).get(`/api/works/${writerWorkId}`).set("Authorization", `Bearer ${firstKey}`).expect(403);

    const volume = await request(runtime.app).post(`/api/works/${adminWorkId}/volumes`)
      .set("Authorization", `Bearer ${firstKey}`)
      .send({ title: "CLI 正文" })
      .expect(201);
    const chapter = await request(runtime.app).post(`/api/works/${adminWorkId}/chapters`)
      .set("Authorization", `Bearer ${firstKey}`)
      .send({ volumeId: volume.body.data.id, title: "CLI 第一章", content: "初始正文。" })
      .expect(201);
    await request(runtime.app).patch(`/api/chapters/${chapter.body.data.id}`)
      .set("X-Scriverse-API-Key", firstKey)
      .send({ content: "API Key 修改后的正文。", changeNote: "CLI 调整开场正文" })
      .expect(200);
    await request(runtime.app)
      .get(`/api/works/${adminWorkId}/search`)
      .query({ q: "API Key 修改", type: "chapter" })
      .expect(401);
    await admin.agent
      .get(`/api/works/${adminWorkId}/search`)
      .query({ q: "API Key 修改", type: "chapter" })
      .expect(200);
    await admin.agent
      .get(`/api/works/${writerWorkId}/search`)
      .query({ q: "不存在的正文", type: "chapter" })
      .expect(200);
    const apiKeySearch = await request(runtime.app)
      .get(`/api/works/${adminWorkId}/search`)
      .set("Authorization", `Bearer ${firstKey}`)
      .query({ q: "API Key 修改", type: "chapter" })
      .expect(200);
    expect(apiKeySearch.body.data).toEqual([
      expect.objectContaining({ id: chapter.body.data.id, type: "chapter", startLine: 1, endLine: 1 })
    ]);
    await request(runtime.app)
      .get(`/api/works/${writerWorkId}/search`)
      .set("Authorization", `Bearer ${firstKey}`)
      .query({ q: "API Key 修改", type: "chapter" })
      .expect(403);
    const versions = await request(runtime.app).get(`/api/chapters/${chapter.body.data.id}/versions`)
      .set("Authorization", `Bearer ${firstKey}`)
      .expect(200);
    expect(versions.body.data[0]).toMatchObject({ versionNo: 2, actor: "api_admin", changeNote: "CLI 调整开场正文" });
    const setting = await request(runtime.app).post(`/api/works/${adminWorkId}/settings`)
      .set("Authorization", `Bearer ${firstKey}`)
      .send({ title: "潮汐航线", category: "交通", content: "初始设定。" })
      .expect(201);
    await request(runtime.app).patch(`/api/settings/${setting.body.data.id}`)
      .set("Authorization", `Bearer ${firstKey}`)
      .send({ content: "补充后的航线设定。", changeNote: "CLI 补充航线限制" })
      .expect(200);
    const settingVersions = await request(runtime.app).get(`/api/entity-versions/setting/${setting.body.data.id}`)
      .set("Authorization", `Bearer ${firstKey}`)
      .expect(200);
    expect(settingVersions.body.data[0]).toMatchObject({ versionNo: 2, actor: "api_admin", changeNote: "CLI 补充航线限制" });
    const draft = await request(runtime.app).post(`/api/works/${adminWorkId}/drafts`)
      .set("Authorization", `Bearer ${firstKey}`)
      .send({ draftType: "prose", title: "CLI 草稿", content: "初始草稿。" })
      .expect(201);
    await request(runtime.app).patch(`/api/drafts/${draft.body.data.id}`)
      .set("Authorization", `Bearer ${firstKey}`)
      .send({ content: "API Key 修改后的草稿。", changeNote: "CLI 补充草稿" })
      .expect(200);
    const draftVersions = await request(runtime.app).get(`/api/entity-versions/draft/${draft.body.data.id}`)
      .set("Authorization", `Bearer ${firstKey}`)
      .expect(200);
    expect(draftVersions.body.data[0]).toMatchObject({ versionNo: 2, actor: "api_admin", changeNote: "CLI 补充草稿" });

    await request(runtime.app).get("/api/users").set("Authorization", `Bearer ${firstKey}`).expect(403);
    await request(runtime.app).get("/api/platform/ai/providers").set("Authorization", `Bearer ${firstKey}`).expect(403);
    await request(runtime.app).get(`/api/works/${adminWorkId}/members`).set("Authorization", `Bearer ${firstKey}`).expect(403);
    await request(runtime.app).post("/api/auth/api-key/reset").set("Authorization", `Bearer ${firstKey}`).send({}).expect(403);
    await request(runtime.app).post("/api/auth/api-key/reveal").set("Authorization", `Bearer ${firstKey}`).send({}).expect(403);
    await request(runtime.app).delete(`/api/chapters/${chapter.body.data.id}`).set("Authorization", `Bearer ${firstKey}`).expect(403);
    await request(runtime.app).delete(`/api/drafts/${draft.body.data.id}`).set("Authorization", `Bearer ${firstKey}`).expect(403);

    const secondReset = await admin.agent.post("/api/auth/api-key/reset")
      .set("X-CSRF-Token", admin.csrfToken)
      .send({})
      .expect(200);
    const secondKey = String(secondReset.body.data.apiKey);
    expect(secondKey).not.toBe(firstKey);
    await request(runtime.app).get("/api/cli/session").set("Authorization", `Bearer ${firstKey}`).expect(401);
    await request(runtime.app).get("/api/cli/session").set("Authorization", `Bearer ${secondKey}`).expect(200);
    await request(runtime.app).get("/api/cli/session").set("Authorization", "Bearer scrv_invalid").expect(401);

    const writerReset = await writer.agent.post("/api/auth/api-key/reset")
      .set("X-CSRF-Token", writer.csrfToken)
      .send({})
      .expect(200);
    const writerKey = String(writerReset.body.data.apiKey);
    const writerKeyWorks = await request(runtime.app).get("/api/works").set("Authorization", `Bearer ${writerKey}`).expect(200);
    expect(writerKeyWorks.body.data.map((work: { id: string }) => work.id)).toEqual([writerWorkId]);

    await admin.agent.patch(`/api/users/${writer.user.userId}`)
      .set("X-CSRF-Token", admin.csrfToken)
      .send({ status: "disabled" })
      .expect(200);
    await request(runtime.app).get("/api/cli/session").set("Authorization", `Bearer ${writerKey}`).expect(401);
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("升级前仅保存摘要的 API Key 无法复制，重置后可复制", async () => {
    const admin = await register(runtime, "api_copy_legacy");
    const created = await admin.agent.post("/api/auth/api-key/reset")
      .set("X-CSRF-Token", admin.csrfToken)
      .send({})
      .expect(200);
    const apiKey = String(created.body.data.apiKey);
    runtime.database.run(
      "UPDATE user_api_keys SET key_encrypted = NULL, key_iv = NULL, key_tag = NULL WHERE user_id = ?",
      admin.user.userId
    );
    const status = await admin.agent.get("/api/auth/api-key").expect(200);
    expect(status.body.data).toMatchObject({ configured: true, copyable: false, prefix: apiKey.slice(0, 13) });
    const blocked = await admin.agent.post("/api/auth/api-key/reveal")
      .set("X-CSRF-Token", admin.csrfToken)
      .send({})
      .expect(409);
    expect(blocked.body.error.code).toBe("API_KEY_NOT_RECOVERABLE");
    const rotated = await admin.agent.post("/api/auth/api-key/reset")
      .set("X-CSRF-Token", admin.csrfToken)
      .send({})
      .expect(200);
    expect(rotated.body.data.copyable).toBe(true);
    const copied = await admin.agent.post("/api/auth/api-key/reveal")
      .set("X-CSRF-Token", admin.csrfToken)
      .send({})
      .expect(200);
    expect(copied.body.data.apiKey).toBe(rotated.body.data.apiKey);
    expect(copied.body.data.apiKey).not.toBe(apiKey);
  });

  it("仅允许具备删除权限的成员查看和操作对应回收站", async () => {
    const owner = await register(runtime, "recycle_owner");
    const editor = await register(runtime, "recycle_editor");
    const viewer = await register(runtime, "recycle_viewer");
    const outsider = await register(runtime, "recycle_outsider");
    const work = await owner.agent.post("/api/works").set("X-CSRF-Token", owner.csrfToken).send({ title: "权限回收站" }).expect(201);
    const workId = String(work.body.data.id);
    await owner.agent.post(`/api/works/${workId}/members`).set("X-CSRF-Token", owner.csrfToken).send({
      userId: editor.user.userId,
      role: "editor"
    }).expect(201);
    await owner.agent.post(`/api/works/${workId}/members`).set("X-CSRF-Token", owner.csrfToken).send({
      userId: viewer.user.userId,
      role: "viewer"
    }).expect(201);
    const volume = await owner.agent.post(`/api/works/${workId}/volumes`).set("X-CSRF-Token", owner.csrfToken).send({ title: "第一卷" }).expect(201);
    const chapter = await owner.agent.post(`/api/works/${workId}/chapters`).set("X-CSRF-Token", owner.csrfToken).send({
      volumeId: volume.body.data.id,
      title: "第一章",
      content: "权限边界正文。"
    }).expect(201);

    await viewer.agent.get(`/api/works/${workId}/recycle-bin`).expect(403);
    await editor.agent.get(`/api/works/${workId}/recycle-bin`).expect(200);
    await editor.agent.delete(`/api/chapters/${chapter.body.data.id}`).set("X-CSRF-Token", editor.csrfToken).send({ expectedVersionNo: 1 }).expect(204);
    const editorRecycleBin = await editor.agent.get(`/api/works/${workId}/recycle-bin`).expect(200);
    expect(editorRecycleBin.body.data.chapters).toEqual([expect.objectContaining({ id: chapter.body.data.id })]);
    await viewer.agent.post(`/api/chapters/${chapter.body.data.id}/restore`).set("X-CSRF-Token", viewer.csrfToken).send({
      versionNo: 2,
      expectedVersionNo: 2
    }).expect(403);
    await editor.agent.post(`/api/chapters/${chapter.body.data.id}/restore`).set("X-CSRF-Token", editor.csrfToken).send({
      versionNo: 2,
      expectedVersionNo: 2
    }).expect(200);

    await editor.agent.delete(`/api/works/${workId}`).set("X-CSRF-Token", editor.csrfToken).send({ expectedVersionNo: 1 }).expect(403);
    await owner.agent.delete(`/api/works/${workId}`).send({ expectedVersionNo: 1 }).expect(403);
    await owner.agent.delete(`/api/works/${workId}`).set("X-CSRF-Token", owner.csrfToken).send({ expectedVersionNo: 1 }).expect(204);
    expect((await owner.agent.get("/api/recycle-bin/works").expect(200)).body.data.works).toEqual([
      expect.objectContaining({ id: workId })
    ]);
    expect((await editor.agent.get("/api/recycle-bin/works").expect(200)).body.data.works).toEqual([]);
    expect((await outsider.agent.get("/api/recycle-bin/works").expect(200)).body.data.works).toEqual([]);
    await editor.agent.post(`/api/recycle-bin/works/${workId}/restore`).set("X-CSRF-Token", editor.csrfToken).send({ expectedVersionNo: 2 }).expect(403);
    await owner.agent.post(`/api/recycle-bin/works/${workId}/restore`).set("X-CSRF-Token", owner.csrfToken).send({ expectedVersionNo: 2 }).expect(200);

    expect(runtime.database.all(
      "SELECT action, user_id FROM audit_logs WHERE entity_id IN (?, ?) AND action IN ('chapter.deleted', 'chapter.restored', 'work.deleted', 'work.restored') ORDER BY created_at, id",
      chapter.body.data.id,
      workId
    )).toEqual(expect.arrayContaining([
      { action: "chapter.deleted", user_id: editor.user.userId },
      { action: "chapter.restored", user_id: editor.user.userId },
      { action: "work.deleted", user_id: owner.user.userId },
      { action: "work.restored", user_id: owner.user.userId }
    ]));
  });

  it("未显式开启注册时连首位管理员注册也会被拒绝", async () => {
    await runtime.close();
    runtime = createUserAuthTestRuntime(false);
    const closedSession = await request(runtime.app).get("/api/auth/session").expect(200);
    expect(closedSession.body.data).toMatchObject({ setupRequired: true, registrationOpen: false });
    const captcha = await solveCaptcha(runtime.app);
    const rejected = await request(runtime.app).post("/api/auth/register").send({
      username: "blocked_first_admin",
      password: "secure-password-123",
      passwordConfirmation: "secure-password-123",
      ...captcha
    }).expect(403);
    expect(rejected.body.error.code).toBe("REGISTRATION_DISABLED");
  });

  it("登录与注册必须通过图片验证码", async () => {
    await request(runtime.app).post("/api/auth/register").send({
      username: "captcha_user",
      password: "secure-password-123"
    }).expect(400);
    const wrong = await solveCaptcha(runtime.app);
    await request(runtime.app).post("/api/auth/register").send({
      username: "captcha_user",
      password: "secure-password-123",
      passwordConfirmation: "secure-password-123",
      captchaId: wrong.captchaId,
      captchaAnswer: "XXXX"
    }).expect(400);
    const user = await register(runtime, "captcha_user");
    await user.agent.post("/api/auth/login").send({
      username: "captcha_user",
      password: "secure-password-123",
      captchaId: "missing",
      captchaAnswer: "ABCD"
    }).expect(400);
  });

  it("注册必须二次确认且两次密码相同", async () => {
    const captcha = await solveCaptcha(runtime.app);
    const response = await request(runtime.app).post("/api/auth/register").send({
      username: "password_confirm_user",
      password: "secure-password-123",
      passwordConfirmation: "different-password-456",
      ...captcha
    }).expect(400);
    expect(response.body.error.details).toContainEqual(expect.objectContaining({
      path: "passwordConfirmation",
      message: "两次输入的密码不一致"
    }));
  });
});
