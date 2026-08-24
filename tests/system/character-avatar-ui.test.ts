import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

describe("角色头像界面", () => {
  let runtime: Runtime;

  beforeEach(() => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "character-avatar-system-test-secret",
      disableUserAuth: true,
      serveUi: true
    });
  });
  afterEach(() => runtime.close());

  it("在角色编辑器中提供头像入口并沿用头像裁剪流程", async () => {
    const [application, styles, page] = await Promise.all([
      request(runtime.app).get("/app.js").expect(200),
      request(runtime.app).get("/styles.css").expect(200),
      request(runtime.app).get("/").expect(200)
    ]);

    expect(application.text).toContain("const characterAvatarImageMaxBytes = 2 * 1024 * 1024;");
    expect(application.text).toContain('const characterAvatarFileAccept = "image/png,image/jpeg,image/webp";');
    expect(application.text).toContain('id="character-avatar-upload-button"');
    expect(application.text).toContain('id="character-avatar-remove-button"');
    expect(application.text).toContain("characterAvatarInitial(character)");
    expect(application.text).toContain("const maximumBytes = isCharacter ? characterAvatarImageMaxBytes : imageUploadLimits.avatarBytes;");
    expect(application.text).toContain('if (isCharacter && isGifImageFile(file))');
    expect(application.text).toContain('toast("角色头像不支持 GIF 图片", "error")');
    expect(application.text).toContain("if (blob.size > maximumBytes)");
    expect(application.text).toContain("支持 PNG、JPEG、WebP，文件不超过 2 MB");
    expect(application.text).toContain("/api/characters/${encodeURIComponent(target.characterId)}/avatar");
    expect(application.text).toContain('toast("角色头像已更新")');
    expect(styles.text).toContain(".character-avatar {");
    expect(styles.text).toContain(".character-avatar-settings {");
    expect(styles.text).toContain(".character-card.has-card-edit > .character-favorite-button, .character-card.has-card-edit > .record-card-edit { top: 21px; }");
    expect(styles.text).toContain(".character-card.has-card-edit > .character-favorite-button, .character-card.has-card-edit > .record-card-edit { top: 12px; }");
    expect(page.text).toContain('id="avatar-file" class="hidden" type="file" accept="image/png,image/jpeg,image/webp"');
    expect(page.text).toContain("feature=character-avatar-v6");
    expect(page.text).toContain("feature=character-card-header-alignment-v3");
  });
});
