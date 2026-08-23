import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

describe("资料收藏界面", () => {
  let runtime: Runtime;

  beforeEach(() => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "record-favorites-system-test-secret",
      disableUserAuth: true,
      serveUi: true
    });
  });
  afterEach(() => runtime.close());

  it("为组织、设定档案和想法提供收藏操作，并保持种族列表不变", async () => {
    const [application, styles, page] = await Promise.all([
      request(runtime.app).get("/app.js").expect(200),
      request(runtime.app).get("/styles.css").expect(200),
      request(runtime.app).get("/").expect(200)
    ]);

    expect(application.text).toContain('draft: { module: "drafts", resource: "drafts", label: "想法", nameField: "title" }');
    expect(application.text).toContain('setting: { module: "settings", resource: "settings", label: "设定", nameField: "title" }');
    expect(application.text).toContain('organization: { module: "organizations", resource: "organizations", label: "组织", nameField: "name" }');
    expect(application.text).toContain('data-record-favorite="${esc(item.id)}"');
    expect(application.text).toContain('data-record-favorite-type="${esc(type)}"');
    expect(application.text).toContain('recordFavoriteButton("draft", item)');
    expect(application.text).toContain('recordFavoriteButton("setting", item)');
    expect(application.text).toContain('recordFavoriteButton("organization", item');
    expect(application.text).toContain('/api/${config.resource}/${encodeURIComponent(item.id)}/favorite');
    expect(application.text).toContain('body: { isFavorite: item.isFavorite !== true }');
    const raceRenderer = application.text.slice(
      application.text.indexOf("function renderRaceCollection"),
      application.text.indexOf("async function renderOrganizations")
    );
    expect(raceRenderer).not.toContain('recordFavoriteButton("race"');
    expect(styles.text).toContain(".record-favorite-button {");
    expect(styles.text).toContain(".record-favorite-button.is-card-control {");
    expect(styles.text).toContain(".record-favorite-button.is-favorite {");
    expect(styles.text).toContain(".module-row .record-favorite-button { position: static; }");
    expect(page.text.match(/feature=record-favorites-v1/gu)).toHaveLength(2);
  });
});
