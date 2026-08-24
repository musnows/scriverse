import { afterEach, describe, expect, it } from "vitest";
import type { Runtime } from "../../src/app.js";
import { runWithRequestActor, type RequestActor } from "../../src/request-context.js";
import { createTestRuntime } from "../helpers.js";

describe("系统管理员后台分析任务权限", () => {
  let runtime: Runtime;

  afterEach(async () => {
    await runtime?.close();
  });

  it("管理员登录会话创建的后台任务始终拥有作品权限", async () => {
    runtime = createTestRuntime();
    const admin = runtime.auth.register({ username: "task_admin", password: "secure-password-123" }).session.user;
    const author = runtime.auth.register({ username: "task_author", password: "secure-password-123" }).session.user;
    const actor = (user: typeof admin, authentication: RequestActor["authentication"]): RequestActor => ({
      userId: user.userId,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      authentication
    });
    const adminWork = runWithRequestActor(actor(admin, "session"), () => runtime.store.createWork({ title: "管理员自己的作品" }));
    const authorWork = runWithRequestActor(actor(author, "session"), () => runtime.store.createWork({ title: "其他作者作品" }));

    expect(() => runtime.auth.assertWorkAccess(admin, String(authorWork.id), {
      read: ["prose"],
      write: ["ai-analysis"]
    }, false, true)).not.toThrow();

    const adminTask = runWithRequestActor(actor(admin, "session"), () => runtime.store.createTask(String(authorWork.id), {
      taskType: "unsupported-admin-task",
      scope: { type: "book" }
    }));
    expect(runtime.database.get("SELECT created_via_api_key FROM analysis_tasks WHERE id = ?", String(adminTask.id))).toEqual({
      created_via_api_key: 0
    });
    await expect(runtime.ai.runTask(String(adminTask.id))).rejects.toMatchObject({ code: "UNSUPPORTED_TASK_TYPE" });

    const apiKeyTask = runWithRequestActor(actor(admin, "api-key"), () => runtime.store.createTask(String(authorWork.id), {
      taskType: "unsupported-admin-api-key-task",
      scope: { type: "book" }
    }));
    expect(runtime.database.get("SELECT created_via_api_key FROM analysis_tasks WHERE id = ?", String(apiKeyTask.id))).toEqual({
      created_via_api_key: 1
    });
    await expect(runtime.ai.runTask(String(apiKeyTask.id))).rejects.toMatchObject({ code: "WORK_ACCESS_DENIED" });

    const authorTask = runWithRequestActor(actor(author, "session"), () => runtime.store.createTask(String(adminWork.id), {
      taskType: "unsupported-author-task",
      scope: { type: "book" }
    }));
    await expect(runtime.ai.runTask(String(authorTask.id))).rejects.toMatchObject({ code: "WORK_ACCESS_DENIED" });
  });
});
