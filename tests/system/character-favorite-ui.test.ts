import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

describe("角色收藏界面", () => {
  let runtime: Runtime;

  beforeEach(() => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "character-favorite-system-test-secret",
      disableUserAuth: true,
      serveUi: true
    });
  });
  afterEach(() => runtime.close());

  it("在角色卡片和列表行提供收藏与置顶操作，并在两个角色扮演列表中置顶优先且带有标记", async () => {
    const [application, styles, page] = await Promise.all([
      request(runtime.app).get("/app.js").expect(200),
      request(runtime.app).get("/styles.css").expect(200),
      request(runtime.app).get("/").expect(200)
    ]);

    expect(application.text).toContain("function favoriteCharactersFirst(characters)");
    expect(application.text).toContain("function pushPinIconMarkup()");
    expect(application.text).toContain("M16 9V4h1V2H7v2h1v5c0 1.66-1.34 3-3 3v2h5.97v6l1.03 1 1.03-1v-6H20v-2c-2.21 0-4-1.79-4-4Z");
    expect(application.text).toContain("favoriteCharactersFirst(state.characters.filter((character) => !character.mergedIntoCharacterId))");
    expect(application.text).toContain("favoriteCharactersFirst(state.characters.filter((character) => (");
    expect(application.text).toContain('const pinLabel = character?.isPinned === true ? "[置顶]" : "";');
    expect(application.text).toContain('const favoriteLabel = character?.isFavorite === true ? "[收藏]" : "";');
    expect(application.text).toContain('return `${pinLabel}${favoriteLabel}${pinLabel || favoriteLabel ? " " : ""}${String(character?.name ?? "")}${deathLabel}`;');
    expect(application.text.match(/name: roleplayCharacterOptionLabel\(character\)/gu)).toHaveLength(2);
    expect(application.text).toContain("name: roleplayCharacterOptionLabel(state.aiRoleplayCharacter)");
    expect(application.text).toContain("name: roleplayCharacterOptionLabel(state.aiRoleplayUserCharacter)");
    expect(application.text).toContain('data-character-favorite="${esc(item.id)}"');
    expect(application.text).toContain('data-character-pin="${esc(item.id)}"');
    expect(application.text).toContain('aria-pressed="${isFavorite}"');
    expect(application.text).toContain("/api/characters/${encodeURIComponent(item.id)}/favorite");
    expect(application.text).toContain("/api/characters/${encodeURIComponent(item.id)}/pin");
    expect(application.text).toContain('body: { isFavorite: item.isFavorite !== true }');
    expect(styles.text).toContain(".character-favorite-button {");
    expect(styles.text).toContain(".character-favorite-button.is-favorite {");
    expect(styles.text).toContain(".character-pin-button.is-pinned {");
    expect(styles.text).toContain(".module-row .character-favorite-button { position: static; }");
    expect(page.text).toContain("feature=character-favorite-v1");
    expect(page.text).toContain("feature=roleplay-favorite-label-v1");
    expect(page.text).toContain("feature=entity-pin-v1");
  });
});
