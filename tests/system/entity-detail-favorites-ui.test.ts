import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

describe("资料详情收藏界面", () => {
  let runtime: Runtime;

  beforeEach(() => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "entity-detail-favorites-system-test-secret",
      disableUserAuth: true,
      serveUi: true
    });
  });
  afterEach(() => runtime.close());

  it("在可收藏资料的详情标题区把星标放到编辑按钮左侧，并排除种族", async () => {
    const [application, styles, page] = await Promise.all([
      request(runtime.app).get("/app.js").expect(200),
      request(runtime.app).get("/styles.css").expect(200),
      request(runtime.app).get("/").expect(200)
    ]);

    expect(page.text.indexOf('id="setting-editor-favorite"')).toBeLessThan(page.text.indexOf('id="setting-editor-edit"'));
    expect(page.text.indexOf('id="character-editor-favorite"')).toBeLessThan(page.text.indexOf('id="character-editor-edit"'));
    expect(page.text.indexOf('id="knowledge-editor-favorite"')).toBeLessThan(page.text.indexOf('id="knowledge-editor-edit"'));
    expect(page.text).toContain('id="dialog-context-actions" class="dialog-context-actions"');
    expect(application.text).toContain('character: { module: "characters", resource: "characters", label: "角色", nameField: "name" }');
    expect(application.text).toContain('function bindEntityDetailFavoriteButton(button, type, getItem, onUpdated)');
    expect(application.text).toContain('bindEntityDetailFavoriteButton($("#setting-editor-favorite"), "setting"');
    expect(application.text).toContain('bindEntityDetailFavoriteButton($("#character-editor-favorite"), "character"');
    expect(application.text).toContain('bindEntityDetailFavoriteButton($("#knowledge-editor-favorite"), "organization", () => !isRace && viewOnly ? knowledgeEditorItem : null');
    expect(application.text).toContain('id="draft-dialog-favorite" class="entity-detail-favorite-button"');
    expect(application.text).toContain('<button id="draft-dialog-edit" class="ghost-button" type="button">编辑想法</button>');
    expect(application.text).toContain('$("#dialog-context-actions").replaceChildren();');
    expect(application.text).toContain('button.innerHTML = characterFavoriteIconMarkup();');
    expect(styles.text).toContain('.entity-detail-favorite-button { display: inline-grid;');
    expect(styles.text).toContain('.entity-detail-favorite-button.is-favorite svg { fill: currentColor; }');
    expect(styles.text).toContain('.dialog-context-actions { display: flex; align-items: center; gap: 8px; }');
    expect(styles.text).toContain('.entity-editor-mode-actions > .entity-detail-favorite-button, .character-editor-header-actions > .entity-detail-favorite-button { flex: 0 0 40px;');
    expect(page.text.match(/feature=entity-detail-favorites-v1/gu)).toHaveLength(2);
  });
});
