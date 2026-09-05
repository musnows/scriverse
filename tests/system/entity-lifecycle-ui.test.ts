import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

describe("实体存续状态界面", () => {
  let runtime: Runtime;

  beforeEach(() => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "entity-lifecycle-system-test-secret",
      disableUserAuth: true,
      serveUi: true
    });
  });
  afterEach(() => runtime.close());

  it("为角色、种族和组织提供编辑控件与列表标识", async () => {
    const [application, styles, page] = await Promise.all([
      request(runtime.app).get("/app.js").expect(200),
      request(runtime.app).get("/styles.css").expect(200),
      request(runtime.app).get("/").expect(200)
    ]);

    expect(application.text).toContain('field("isDead", "标记为已死亡", "checkbox"');
    expect(application.text).toContain('field(isRace ? "isExtinct" : "isDissolved", isRace ? "标记为已灭绝" : "标记为已解散", "checkbox"');
    expect(application.text).toContain('entityLifecycleBadge(item.isDead, "已死亡")');
    expect(application.text).toContain('entityLifecycleBadge(item.isExtinct, "已灭绝")');
    expect(application.text).toContain('entityLifecycleBadge(item.isDissolved, "已解散")');
    expect(styles.text).toContain(".entity-lifecycle-badge");
    expect(page.text).toContain('/styles.css?v=20260905-ai-approvals-v4');
    expect(page.text).toContain('/app.js?v=20260905-ai-approvals-v4');
  });
});
