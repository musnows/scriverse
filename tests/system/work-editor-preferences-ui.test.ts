import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("作品级正文编辑辅助设置", () => {
  it("只在作品设置中提供两个默认关闭的开关并即时应用", async () => {
    const publicPath = join(process.cwd(), "src", "public");
    const [page, application, styles] = await Promise.all([
      readFile(join(publicPath, "index.html"), "utf8"),
      readFile(join(publicPath, "app.js"), "utf8"),
      readFile(join(publicPath, "styles.css"), "utf8")
    ]);

    expect(page).toContain("feature=work-editor-preferences-v1");
    expect(application).toContain('id="work-editor-preferences-title">正文编辑辅助');
    expect(application).toContain('name="editorAutoIndentEnabled" type="checkbox"');
    expect(application).toContain('name="editorTypewriterModeEnabled" type="checkbox"');
    expect(application).toContain('editorAutoIndentEnabled: form.has("editorAutoIndentEnabled")');
    expect(application).toContain('editorTypewriterModeEnabled: form.has("editorTypewriterModeEnabled")');
    expect(application).toContain('classList.toggle("editor-typewriter-mode", Boolean(state.work?.editorTypewriterModeEnabled))');
    expect(styles).toContain(".work-editor-preference-options");
    expect(styles).toContain(".work-editor-preference-option");
  });
});
