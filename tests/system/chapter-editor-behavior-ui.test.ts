import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("正文编辑器输入行为界面", () => {
  it("按当前作品设置加载自动缩进和打字机模式", async () => {
    const publicPath = join(process.cwd(), "src", "public");
    const [page, application, styles] = await Promise.all([
      readFile(join(publicPath, "index.html"), "utf8"),
      readFile(join(publicPath, "app.js"), "utf8"),
      readFile(join(publicPath, "styles.css"), "utf8")
    ]);
    expect(page).toContain("feature=chapter-auto-indent-v1");
    expect(page).toContain("feature=chapter-centered-scroll-v1");
    expect(page).toContain("feature=chapter-center-bottom-space-v1");
    expect(application).toContain('event.key !== "Enter"');
    expect(application).toContain("!state.work?.editorAutoIndentEnabled");
    expect(application).toContain("scheduleChapterCaretScroll()");
    expect(application).toContain("!state.work?.editorTypewriterModeEnabled");
    expect(styles).toContain("padding: 32px 36px 72px");
    expect(styles).toContain(".app-shell.editor-typewriter-mode .chapter-content { padding-bottom: max(72px, 45dvh); }");
    expect(styles).toContain("padding: 22px 16px 64px 12px");
    expect(styles).toContain(".app-shell.editor-typewriter-mode .chapter-content { padding-bottom: max(64px, 45dvh); }");
  });
});
