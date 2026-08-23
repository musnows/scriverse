import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

type WebSession = {
  agent: ReturnType<typeof request.agent>;
  csrfToken: string;
  userId: string;
  username: string;
};

const setupToken = "offline-sync-test-setup-token-with-at-least-32-characters";

async function solveCaptcha(runtime: Runtime): Promise<{ captchaId: string; captchaAnswer: string }> {
  const response = await request(runtime.app).get("/api/auth/captcha").expect(200);
  return {
    captchaId: String(response.body.data.captchaId),
    captchaAnswer: String(response.body.data.answer)
  };
}

async function register(runtime: Runtime, username: string): Promise<WebSession> {
  const agent = request.agent(runtime.app);
  const response = await agent.post("/api/auth/register").send({
    username,
    password: "secure-password-123",
    passwordConfirmation: "secure-password-123",
    setupToken,
    ...await solveCaptcha(runtime)
  }).expect(201);
  return {
    agent,
    csrfToken: String(response.body.data.csrfToken),
    userId: String(response.body.data.user.userId),
    username
  };
}

async function desktopAuthorization(runtime: Runtime, username: string, profileId: string): Promise<string> {
  const response = await request(runtime.app).post("/api/desktop/auth/login").send({
    username,
    password: "secure-password-123",
    desktopId: "22222222-2222-4222-8222-222222222222",
    profileId,
    clientVersion: "0.8.7",
    ...await solveCaptcha(runtime)
  }).expect(200);
  expect(response.headers["set-cookie"]).toBeUndefined();
  return `Bearer ${String(response.body.data.token)}`;
}

async function createOfflineFixture(runtime: Runtime, owner: WebSession) {
  const workResponse = await owner.agent.post("/api/works")
    .set("X-CSRF-Token", owner.csrfToken)
    .send({ title: "离线快照作品", author: "测试作者" })
    .expect(201);
  const workId = String(workResponse.body.data.id);
  const volumeResponse = await owner.agent.post(`/api/works/${workId}/volumes`)
    .set("X-CSRF-Token", owner.csrfToken)
    .send({ title: "第一卷" })
    .expect(201);
  const volumeId = String(volumeResponse.body.data.id);
  const chapterResponse = await owner.agent.post(`/api/works/${workId}/chapters`)
    .set("X-CSRF-Token", owner.csrfToken)
    .send({ volumeId, title: "第一章", content: "快照旧正文", chapterType: "正文" })
    .expect(201);
  const settingResponse = await owner.agent.post(`/api/works/${workId}/settings`)
    .set("X-CSRF-Token", owner.csrfToken)
    .send({ title: "星球", category: "地理", content: "快照旧设定" })
    .expect(201);
  await owner.agent.patch(`/api/works/${workId}/offline-access`)
    .set("X-CSRF-Token", owner.csrfToken)
    .send({ enabled: true })
    .expect(200);
  return {
    workId,
    volumeId,
    chapterId: String(chapterResponse.body.data.id),
    settingId: String(settingResponse.body.data.id)
  };
}

describe("Desktop 离线同步快照 API", () => {
  let runtime: Runtime;

  beforeEach(() => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "offline-sync-test-master-secret-with-enough-length",
      serveUi: false,
      revealCaptchaAnswer: true,
      security: { allowRegistration: true, enforceSameOrigin: true, setupToken }
    });
  });

  afterEach(async () => runtime.close());

  it("通过 Desktop Bearer 分页读取一致快照且不依赖 Cookie", async () => {
    const owner = await register(runtime, "snapshot_owner");
    const fixture = await createOfflineFixture(runtime, owner);
    const authorization = await desktopAuthorization(
      runtime,
      owner.username,
      "11111111-1111-4111-8111-111111111111"
    );

    const created = await request(runtime.app).post(`/api/sync/works/${fixture.workId}/snapshots`)
      .set("Authorization", authorization)
      .send({})
      .expect(201);
    expect(created.headers["set-cookie"]).toBeUndefined();
    expect(created.headers["cache-control"]).toBe("no-store");
    expect(created.body.data).toMatchObject({
      workId: fixture.workId,
      itemCount: 4,
      syncProtocol: 1,
      cutoffCursor: expect.any(Number)
    });
    expect(created.body.data.cutoffCursor).toBeGreaterThan(0);
    const snapshotId = String(created.body.data.snapshotId);

    await owner.agent.patch(`/api/chapters/${fixture.chapterId}`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "第一章已更新", content: "快照后新正文", expectedVersionNo: 1 })
      .expect(200);
    await owner.agent.post(`/api/works/${fixture.workId}/settings`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ title: "新设定", category: "地理", content: "快照之后创建" })
      .expect(201);

    const items: Array<Record<string, unknown>> = [];
    let after = 0;
    while (true) {
      const page = await request(runtime.app)
        .get(`/api/sync/snapshots/${snapshotId}/items?after=${after}&limit=2`)
        .set("Authorization", authorization)
        .expect(200);
      expect(page.headers["set-cookie"]).toBeUndefined();
      items.push(...page.body.data.items);
      if (!page.body.data.hasMore) break;
      after = Number(page.body.data.nextAfter);
    }
    expect(items.map((item) => item.entityType)).toEqual(["work", "volume", "chapter", "setting"]);
    const chapter = items.find((item) => item.entityType === "chapter")?.data as Record<string, unknown>;
    const setting = items.find((item) => item.entityType === "setting")?.data as Record<string, unknown>;
    expect(chapter).toMatchObject({ id: fixture.chapterId, title: "第一章", content: "快照旧正文", versionNo: 1 });
    expect(setting).toMatchObject({ id: fixture.settingId, content: "快照旧设定", versionNo: 1 });
    expect(items.some((item) => (item.data as Record<string, unknown>).title === "新设定")).toBe(false);

    await request(runtime.app)
      .get(`/api/sync/snapshots/${snapshotId}/items?limit=101`)
      .set("Authorization", authorization)
      .expect(400);
    await request(runtime.app).delete(`/api/sync/snapshots/${snapshotId}`)
      .set("Authorization", authorization)
      .expect(204);
    await request(runtime.app).get(`/api/sync/snapshots/${snapshotId}/items`)
      .set("Authorization", authorization)
      .expect(404);
  });

  it("按单调 cursor 返回章节与设定的历史版本变更", async () => {
    const owner = await register(runtime, "changes_owner");
    const fixture = await createOfflineFixture(runtime, owner);
    const authorization = await desktopAuthorization(
      runtime,
      owner.username,
      "55555555-5555-4555-8555-555555555555"
    );
    const snapshot = await request(runtime.app).post(`/api/sync/works/${fixture.workId}/snapshots`)
      .set("Authorization", authorization)
      .send({})
      .expect(201);
    const cutoffCursor = Number(snapshot.body.data.cutoffCursor);

    const updatedChapter = await owner.agent.patch(`/api/chapters/${fixture.chapterId}`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ content: "增量新正文", expectedVersionNo: 1 })
      .expect(200);
    expect(updatedChapter.body.data.versionNo).toBe(2);
    await owner.agent.delete(`/api/chapters/${fixture.chapterId}`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ expectedVersionNo: 2 })
      .expect(204);
    await owner.agent.post(`/api/chapters/${fixture.chapterId}/restore`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ versionNo: 2, expectedVersionNo: 3 })
      .expect(200);
    await owner.agent.patch(`/api/settings/${fixture.settingId}`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ content: "增量新设定", expectedVersionNo: 1 })
      .expect(200);
    await owner.agent.delete(`/api/settings/${fixture.settingId}`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ expectedVersionNo: 2 })
      .expect(204);

    const changes: Array<Record<string, unknown>> = [];
    let cursor = cutoffCursor;
    while (true) {
      const page = await request(runtime.app)
        .get(`/api/sync/works/${fixture.workId}/changes?after=${cursor}&limit=2`)
        .set("Authorization", authorization)
        .expect(200);
      expect(page.headers["set-cookie"]).toBeUndefined();
      changes.push(...page.body.data.items);
      cursor = Number(page.body.data.nextCursor);
      if (!page.body.data.hasMore) {
        expect(page.body.data.latestCursor).toBe(cursor);
        break;
      }
    }
    expect(changes.map((change) => [change.entityType, change.operation, change.versionNo])).toEqual([
      ["chapter", "upsert", 2],
      ["chapter", "delete", 3],
      ["chapter", "upsert", 4],
      ["setting", "upsert", 2],
      ["setting", "delete", 3]
    ]);
    expect(changes.every((change) => change.changedByUserId === owner.userId)).toBe(true);
    expect(changes[0]?.data).toMatchObject({ id: fixture.chapterId, content: "增量新正文", versionNo: 2 });
    expect(changes[1]?.data).toBeNull();
    expect(changes[2]?.data).toMatchObject({ id: fixture.chapterId, content: "增量新正文", versionNo: 4 });
    expect(changes[3]?.data).toMatchObject({ id: fixture.settingId, content: "增量新设定", versionNo: 2 });
    expect(changes[4]?.data).toBeNull();
    await request(runtime.app)
      .get(`/api/sync/works/${fixture.workId}/changes?after=-1`)
      .set("Authorization", authorization)
      .expect(400);
  });

  it("逐条事务应用离线变更并幂等重放已存结果", async () => {
    const owner = await register(runtime, "push_owner");
    const fixture = await createOfflineFixture(runtime, owner);
    const authorization = await desktopAuthorization(
      runtime,
      owner.username,
      "66666666-6666-4666-8666-666666666666"
    );
    const snapshot = await request(runtime.app).post(`/api/sync/works/${fixture.workId}/snapshots`)
      .set("Authorization", authorization)
      .send({})
      .expect(201);
    const cutoffCursor = Number(snapshot.body.data.cutoffCursor);
    const body = {
      clientId: "77777777-7777-4777-8777-777777777777",
      mutations: [
        {
          mutationId: "88888888-8888-4888-8888-888888888888",
          entityType: "chapter",
          entityId: fixture.chapterId,
          operation: "update",
          baseVersionNo: 1,
          localSnapshot: { title: "Desktop 第一章", content: "Desktop 离线正文", chapterType: "正文" },
          changeNote: "Desktop 离线修改"
        },
        {
          mutationId: "99999999-9999-4999-8999-999999999999",
          entityType: "setting",
          entityId: fixture.settingId,
          operation: "update",
          baseVersionNo: 1,
          localSnapshot: { title: "星球", category: "地理", content: "Desktop 离线设定", status: "confirmed" },
          changeNote: "Desktop 离线修改"
        }
      ]
    };
    const pushed = await request(runtime.app).post(`/api/sync/works/${fixture.workId}/push`)
      .set("Authorization", authorization)
      .send(body)
      .expect(200);
    expect(pushed.headers["set-cookie"]).toBeUndefined();
    expect(pushed.body.data.summary).toEqual({ applied: 2, conflict: 0, rejected: 0, replayed: 0 });
    expect(pushed.body.data.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ mutationId: body.mutations[0]!.mutationId, status: "applied", appliedVersionNo: 2, replayed: false }),
      expect.objectContaining({ mutationId: body.mutations[1]!.mutationId, status: "applied", appliedVersionNo: 2, replayed: false })
    ]));
    expect((await owner.agent.get(`/api/chapters/${fixture.chapterId}`).expect(200)).body.data).toMatchObject({
      title: "Desktop 第一章",
      content: "Desktop 离线正文",
      versionNo: 2
    });
    expect((await owner.agent.get(`/api/settings/${fixture.settingId}`).expect(200)).body.data).toMatchObject({
      content: "Desktop 离线设定",
      status: "confirmed",
      versionNo: 2
    });

    const replayed = await request(runtime.app).post(`/api/sync/works/${fixture.workId}/push`)
      .set("Authorization", authorization)
      .send(body)
      .expect(200);
    expect(replayed.body.data.summary).toEqual({ applied: 2, conflict: 0, rejected: 0, replayed: 2 });
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM sync_mutation_results WHERE work_id = ?", fixture.workId)).toEqual({ count: 2 });
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM chapter_versions WHERE chapter_id = ?", fixture.chapterId)).toEqual({ count: 2 });
    expect(runtime.database.get(
      "SELECT COUNT(*) AS count FROM entity_versions WHERE entity_type = 'setting' AND entity_id = ?",
      fixture.settingId
    )).toEqual({ count: 2 });

    const stored = await request(runtime.app)
      .get(`/api/sync/works/${fixture.workId}/mutations/${body.mutations[0]!.mutationId}`)
      .set("Authorization", authorization)
      .expect(200);
    expect(stored.body.data).toMatchObject({ status: "applied", replayed: false, appliedVersionNo: 2 });
    const changes = await request(runtime.app)
      .get(`/api/sync/works/${fixture.workId}/changes?after=${cutoffCursor}`)
      .set("Authorization", authorization)
      .expect(200);
    expect(changes.body.data.items.map((change: { entityType: string; versionNo: number }) => [change.entityType, change.versionNo])).toEqual([
      ["chapter", 2],
      ["setting", 2]
    ]);

    const reused = await request(runtime.app).post(`/api/sync/works/${fixture.workId}/push`)
      .set("Authorization", authorization)
      .send({
        clientId: body.clientId,
        mutations: [{
          ...body.mutations[0],
          localSnapshot: { title: "Desktop 第一章", content: "不同请求", chapterType: "正文" }
        }]
      })
      .expect(409);
    expect(reused.body.error.code).toBe("MUTATION_ID_REUSED");
  });

  it("冲突时保留 base local server 且不阻断同批其他变更", async () => {
    const owner = await register(runtime, "conflict_owner");
    const fixture = await createOfflineFixture(runtime, owner);
    const authorization = await desktopAuthorization(
      runtime,
      owner.username,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    );
    await owner.agent.patch(`/api/chapters/${fixture.chapterId}`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ content: "Server 在线正文", expectedVersionNo: 1 })
      .expect(200);
    const body = {
      clientId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      mutations: [
        {
          mutationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          entityType: "chapter",
          entityId: fixture.chapterId,
          operation: "update",
          baseVersionNo: 1,
          localSnapshot: { title: "第一章", content: "Desktop 离线正文", chapterType: "正文" },
          changeNote: "Desktop 离线修改"
        },
        {
          mutationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          entityType: "setting",
          entityId: "missing-setting",
          operation: "update",
          baseVersionNo: 1,
          localSnapshot: { title: "不存在", category: "地理", content: "不应写入" },
          changeNote: "Desktop 离线修改"
        },
        {
          mutationId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          entityType: "setting",
          entityId: fixture.settingId,
          operation: "update",
          baseVersionNo: 1,
          localSnapshot: { title: "星球", category: "地理", content: "同批正常设定" },
          changeNote: "Desktop 离线修改"
        }
      ]
    };
    const pushed = await request(runtime.app).post(`/api/sync/works/${fixture.workId}/push`)
      .set("Authorization", authorization)
      .send(body)
      .expect(200);
    expect(pushed.body.data.summary).toEqual({ applied: 1, conflict: 1, rejected: 1, replayed: 0 });
    const conflict = pushed.body.data.results[0];
    expect(conflict).toMatchObject({
      status: "conflict",
      errorCode: "VERSION_CONFLICT",
      baseVersionNo: 1,
      conflictVersionNo: 2,
      baseSnapshot: { content: "快照旧正文", versionNo: 1 },
      localSnapshot: { content: "Desktop 离线正文", versionNo: 1 },
      serverSnapshot: { content: "Server 在线正文", versionNo: 2 }
    });
    expect(pushed.body.data.results[1]).toMatchObject({ status: "rejected", errorCode: "SYNC_ENTITY_NOT_FOUND" });
    expect(pushed.body.data.results[2]).toMatchObject({ status: "applied", appliedVersionNo: 2 });
    expect((await owner.agent.get(`/api/chapters/${fixture.chapterId}`).expect(200)).body.data.content).toBe("Server 在线正文");
    expect((await owner.agent.get(`/api/settings/${fixture.settingId}`).expect(200)).body.data.content).toBe("同批正常设定");
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM sync_mutation_results WHERE work_id = ?", fixture.workId)).toEqual({ count: 3 });

    const replayed = await request(runtime.app).post(`/api/sync/works/${fixture.workId}/push`)
      .set("Authorization", authorization)
      .send(body)
      .expect(200);
    expect(replayed.body.data.summary).toEqual({ applied: 1, conflict: 1, rejected: 1, replayed: 3 });
  });

  it("在解析后拒绝超过 2500000 bytes 的同步批次", async () => {
    const owner = await register(runtime, "size_owner");
    const fixture = await createOfflineFixture(runtime, owner);
    const authorization = await desktopAuthorization(
      runtime,
      owner.username,
      "ffffffff-ffff-4fff-8fff-ffffffffffff"
    );
    const oversized = await request(runtime.app).post(`/api/sync/works/${fixture.workId}/push`)
      .set("Authorization", authorization)
      .send({
        clientId: "01234567-89ab-4def-8123-456789abcdef",
        mutations: [
          {
            mutationId: "10000000-0000-4000-8000-000000000001",
            entityType: "chapter",
            entityId: fixture.chapterId,
            operation: "update",
            baseVersionNo: 1,
            localSnapshot: { title: "第一章", content: "a".repeat(1_300_000), chapterType: "正文" },
            changeNote: "Desktop 离线修改"
          },
          {
            mutationId: "10000000-0000-4000-8000-000000000002",
            entityType: "chapter",
            entityId: fixture.chapterId,
            operation: "update",
            baseVersionNo: 1,
            localSnapshot: { title: "第一章", content: "b".repeat(1_300_000), chapterType: "正文" },
            changeNote: "Desktop 离线修改"
          }
        ]
      })
      .expect(413);
    expect(oversized.body.error.code).toBe("SYNC_PUSH_TOO_LARGE");
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM sync_mutation_results WHERE work_id = ?", fixture.workId)).toEqual({ count: 0 });

    const tooMany = Array.from({ length: 21 }, (_, index) => ({
      mutationId: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      entityType: "chapter",
      entityId: fixture.chapterId,
      operation: "update",
      baseVersionNo: 1,
      localSnapshot: { title: `标题 ${index}`, content: "快照旧正文", chapterType: "正文" },
      changeNote: "Desktop 离线修改"
    }));
    await request(runtime.app).post(`/api/sync/works/${fixture.workId}/push`)
      .set("Authorization", authorization)
      .send({ clientId: "01234567-89ab-4def-8123-456789abcdef", mutations: tooMany })
      .expect(400);
    await request(runtime.app).post(`/api/sync/works/${fixture.workId}/push`)
      .set("Authorization", authorization)
      .send({ clientId: "01234567-89ab-4def-8123-456789abcdef", mutations: [tooMany[0], tooMany[0]] })
      .expect(400);
  });

  it("要求模块写权限并隔离不同用户的 mutation 结果", async () => {
    const owner = await register(runtime, "result_owner");
    const viewer = await register(runtime, "result_viewer");
    const fixture = await createOfflineFixture(runtime, owner);
    await owner.agent.post(`/api/works/${fixture.workId}/members`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ userId: viewer.userId, role: "viewer" })
      .expect(201);
    const ownerAuthorization = await desktopAuthorization(
      runtime,
      owner.username,
      "30000000-0000-4000-8000-000000000001"
    );
    const viewerAuthorization = await desktopAuthorization(
      runtime,
      viewer.username,
      "30000000-0000-4000-8000-000000000002"
    );
    const mutation = {
      mutationId: "30000000-0000-4000-8000-000000000003",
      entityType: "chapter",
      entityId: fixture.chapterId,
      operation: "update",
      baseVersionNo: 1,
      localSnapshot: { title: "第一章", content: "仅所有者可写", chapterType: "正文" },
      changeNote: "Desktop 离线修改"
    };
    const viewerDenied = await request(runtime.app).post(`/api/sync/works/${fixture.workId}/push`)
      .set("Authorization", viewerAuthorization)
      .send({ clientId: "30000000-0000-4000-8000-000000000004", mutations: [mutation] })
      .expect(403);
    expect(viewerDenied.body.error.code).toBe("WORK_EDIT_DENIED");
    const csrfDenied = await owner.agent.post(`/api/sync/works/${fixture.workId}/push`)
      .send({ clientId: "30000000-0000-4000-8000-000000000004", mutations: [mutation] })
      .expect(403);
    expect(csrfDenied.body.error.code).toBe("CSRF_TOKEN_INVALID");

    await request(runtime.app).post(`/api/sync/works/${fixture.workId}/push`)
      .set("Authorization", ownerAuthorization)
      .send({ clientId: "30000000-0000-4000-8000-000000000004", mutations: [mutation] })
      .expect(200);
    const privateResult = await request(runtime.app)
      .get(`/api/sync/works/${fixture.workId}/mutations/${mutation.mutationId}`)
      .set("Authorization", viewerAuthorization)
      .expect(404);
    expect(privateResult.body.error.code).toBe("SYNC_MUTATION_NOT_FOUND");
  });

  it("在离线授权或作品权限撤销后立即停止快照访问", async () => {
    const owner = await register(runtime, "permission_owner");
    const collaborator = await register(runtime, "permission_collaborator");
    const fixture = await createOfflineFixture(runtime, owner);
    await owner.agent.post(`/api/works/${fixture.workId}/members`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ userId: collaborator.userId, role: "editor" })
      .expect(201);
    const collaboratorAuthorization = await desktopAuthorization(
      runtime,
      collaborator.username,
      "33333333-3333-4333-8333-333333333333"
    );
    const snapshot = await request(runtime.app).post(`/api/sync/works/${fixture.workId}/snapshots`)
      .set("Authorization", collaboratorAuthorization)
      .send({})
      .expect(201);
    const snapshotId = String(snapshot.body.data.snapshotId);

    await owner.agent.delete(`/api/works/${fixture.workId}/members/${collaborator.userId}`)
      .set("X-CSRF-Token", owner.csrfToken)
      .expect(200);
    const revoked = await request(runtime.app).get(`/api/sync/snapshots/${snapshotId}/items`)
      .set("Authorization", collaboratorAuthorization)
      .expect(403);
    expect(revoked.body.error.code).toBe("WORK_ACCESS_DENIED");

    await owner.agent.patch(`/api/works/${fixture.workId}/offline-access`)
      .set("X-CSRF-Token", owner.csrfToken)
      .send({ enabled: false })
      .expect(200);
    const ownerAuthorization = await desktopAuthorization(
      runtime,
      owner.username,
      "44444444-4444-4444-8444-444444444444"
    );
    const disabled = await request(runtime.app).post(`/api/sync/works/${fixture.workId}/snapshots`)
      .set("Authorization", ownerAuthorization)
      .send({})
      .expect(403);
    expect(disabled.body.error.code).toBe("OFFLINE_ACCESS_DISABLED");

    const apiKey = await owner.agent.post("/api/auth/api-key/reset")
      .set("X-CSRF-Token", owner.csrfToken)
      .send({})
      .expect(200);
    const apiKeyDenied = await request(runtime.app).post(`/api/sync/works/${fixture.workId}/snapshots`)
      .set("Authorization", `Bearer ${String(apiKey.body.data.apiKey)}`)
      .send({})
      .expect(403);
    expect(apiKeyDenied.body.error.code).toBe("CLI_SCOPE_DENIED");
  });
});
