import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("角色编辑器标题布局", () => {
  it("在页头编辑标准名并将种族放到基础资料首个字段", async () => {
    const publicPath = join(process.cwd(), "src/public");
    const [application, page, styles] = await Promise.all([
      readFile(join(publicPath, "app.js"), "utf8"),
      readFile(join(publicPath, "index.html"), "utf8"),
      readFile(join(publicPath, "styles.css"), "utf8")
    ]);
    const renderStart = application.indexOf("function renderCharacterEditorFields(item)");
    const renderEnd = application.indexOf("\nfunction collectCharacterBody", renderStart);
    const renderSource = application.slice(renderStart, renderEnd);

    expect(page).toContain('id="character-editor-name" class="character-editor-title-input" name="name"');
    expect(page).toContain('placeholder="新建角色" aria-label="角色标准名" required');
    expect(renderSource).not.toContain('field("name", "标准名"');
    expect(renderSource.indexOf("raceField +")).toBeLessThan(renderSource.indexOf('field("gender", "性别"'));
    expect(application).toContain('name: String(form.get("name") ?? "").trim()');
    expect(application).toContain('$("#character-editor-name").readOnly = viewOnly;');
    expect(application).toContain('$("#character-editor-name").focus();');
    expect(application).toContain('$("#character-editor-form").addEventListener("input", markEntityEditorDirty);');
    expect(styles).toContain(".character-editor-title-input { flex: 0 1 520px;");
    expect(styles).toContain(".character-editor-title-input:focus { border-color: var(--accent); box-shadow: none; }");
    expect(styles).toContain(".entity-editor-heading h1, .character-editor-title-row h1, .character-editor-title-input { font-size: 18px; }");
    expect(page).toContain("feature=character-title-input-v1");
  });
});
