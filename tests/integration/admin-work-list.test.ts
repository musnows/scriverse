import { afterEach, describe, expect, it } from "vitest";
import type { Runtime } from "../../src/app.js";
import { runWithRequestActor, type RequestActor } from "../../src/request-context.js";
import { createTestRuntime } from "../helpers.js";

describe("系统管理员默认作品列表", () => {
  let runtime: Runtime;

  afterEach(async () => {
    await runtime?.close();
  });

  it("书架只显示管理员拥有或加入的作品", () => {
    runtime = createTestRuntime();
    const admin = runtime.auth.register({ username: "list_admin", password: "secure-password-123" }).session.user;
    const author = runtime.auth.register({ username: "list_author", password: "secure-password-123" }).session.user;
    const actor = (user: typeof admin): RequestActor => ({
      userId: user.userId,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      authentication: "session"
    });
    const adminWork = runWithRequestActor(actor(admin), () => runtime.store.createWork({ title: "管理员自己的作品" }));
    runWithRequestActor(actor(author), () => runtime.store.createWork({ title: "其他作者作品" }));

    const listed = runWithRequestActor(actor(admin), () => runtime.store.listWorks());
    expect(listed.map((work) => work.id)).toEqual([adminWork.id]);
    const paged = runWithRequestActor(actor(admin), () => runtime.store.listWorksPage({ page: 1, limit: 30, offset: 0 }));
    expect(paged.items.map((work) => work.id)).toEqual([adminWork.id]);
  });
});
