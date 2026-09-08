import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";
import { runWithRequestActor } from "../../src/request-context.js";
import { emptyWorkModulePermissions } from "../../src/work-permissions.js";

describe("权限路径的末尾斜杠兼容", () => {
  let runtime: Runtime;
  beforeEach(() => {
    runtime = createRuntime({ databasePath: ":memory:", masterSecret: "path-authorization-test-secret-with-enough-length", serveUi: false });
  });
  afterEach(() => runtime.close());

  it("正文编辑者不能通过末尾斜杠读写大纲或创建未授权评论", async () => {
    const owner = runtime.auth.register({ username: "path_owner", password: "secure-password-123" });
    const member = runtime.auth.register({ username: "path_member", password: "secure-password-123" });
    const work = runWithRequestActor(owner.session.user, () => runtime.store.createWork({ title: "Path permissions" }));
    const workId = String(work.id);
    runtime.auth.addMember(workId, member.session.user.userId, { permissions: { ...emptyWorkModulePermissions(), prose: "write" } }, owner.session.user.userId);
    const volume = runtime.store.createVolume(workId, { title: "Volume" });
    const chapter = runtime.store.createChapter(workId, { volumeId: String(volume.id), title: "Chapter", content: "Original" });
    runtime.store.upsertChapterOutline(String(chapter.id), { goal: "Restricted outline" });
    for (const suffix of ["", "/"]) {
      const path = `/api/chapters/${chapter.id}/outline${suffix}`;
      await request(runtime.app).get(path).expect(401);
      const read = await request(runtime.app).get(path).set("Cookie", `scriverse_session=${member.token}`).expect(403);
      expect(JSON.stringify(read.body)).not.toContain("Restricted outline");
      await request(runtime.app).put(path).set("Cookie", `scriverse_session=${member.token}`).set("X-CSRF-Token", member.session.csrfToken).send({ goal: "Unauthorized" }).expect(403);
      await request(runtime.app).post(`/api/chapters/${chapter.id}/annotations${suffix}`).set("Cookie", `scriverse_session=${member.token}`).set("X-CSRF-Token", member.session.csrfToken).send({ kind: "note", startLine: 1, endLine: 1, note: "Unauthorized" }).expect(403);
      await request(runtime.app).get(path).set("Cookie", `scriverse_session=${owner.token}`).expect(200);
    }
    expect(runtime.store.getChapterOutline(String(chapter.id))?.goal).toBe("Restricted outline");
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM chapter_annotations")).toEqual({ count: 0 });
  });

  it("AI 分析读取权限不能绕过追踪正文权限，待办编辑权限也不能绕过创建者限制", async () => {
    const owner = runtime.auth.register({ username: "trace_owner", password: "secure-password-123" });
    const member = runtime.auth.register({ username: "trace_member", password: "secure-password-123" });
    const work = runWithRequestActor(owner.session.user, () => runtime.store.createWork({ title: "Trace permissions" }));
    const workId = String(work.id);
    runtime.auth.addMember(workId, member.session.user.userId, { permissions: { ...emptyWorkModulePermissions(), "ai-analysis": "read", todos: "write" } }, owner.session.user.userId);
    const task = runtime.store.createTask(workId, { taskType: "book-analysis", scope: { type: "book" } });
    const timestamp = new Date().toISOString();
    runtime.database.run("INSERT INTO ai_calls (id, work_id, task_id, task_type, provider_id, model_id, context_scope_json, status, created_at) VALUES ('path_trace', ?, ?, 'book-analysis', 'test', 'test', '{}', 'completed', ?)", workId, String(task.id), timestamp);
    runtime.database.run("INSERT INTO ai_call_traces (call_id, task_id, initial_messages_json, created_at, updated_at) VALUES ('path_trace', ?, ?, ?, ?)", String(task.id), JSON.stringify([{ role: "user", content: "Restricted prose" }]), timestamp, timestamp);
    const volume = runtime.store.createVolume(workId, { title: "Volume" });
    const chapter = runtime.store.createChapter(workId, { volumeId: String(volume.id), title: "Chapter", content: "Original" });
    const todo = runWithRequestActor(owner.session.user, () => runtime.store.createChapterAnnotation(String(chapter.id), { kind: "todo", startLine: 1, endLine: 1, note: "Owner todo" }));
    for (const suffix of ["", "/"]) {
      const trace = await request(runtime.app).get(`/api/tasks/${task.id}/trace/calls/path_trace${suffix}`).set("Cookie", `scriverse_session=${member.token}`).expect(403);
      expect(JSON.stringify(trace.body)).not.toContain("Restricted prose");
      await request(runtime.app).patch(`/api/chapter-annotations/${todo.id}${suffix}`).set("Cookie", `scriverse_session=${member.token}`).set("X-CSRF-Token", member.session.csrfToken).send({ note: "Unauthorized", expectedVersionNo: todo.versionNo }).expect(403);
    }
    expect(runtime.store.getChapterAnnotation(String(todo.id)).note).toBe("Owner todo");
    const ownTodo = runWithRequestActor(member.session.user, () => runtime.store.createChapterAnnotation(String(chapter.id), { kind: "todo", startLine: 1, endLine: 1, note: "Own todo" }));
    await request(runtime.app).patch(`/api/chapter-annotations/${ownTodo.id}/`).set("Cookie", `scriverse_session=${member.token}`).set("X-CSRF-Token", member.session.csrfToken).send({ note: "Allowed", expectedVersionNo: ownTodo.versionNo }).expect(200);
  });
});
