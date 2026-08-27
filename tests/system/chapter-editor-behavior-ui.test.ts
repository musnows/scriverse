import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("正文编辑器输入行为界面", () => {
  it("加载自动缩进逻辑，并为末行居中保留可滚动空间", async () => {
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
    expect(application).toContain("scheduleChapterCaretScroll()");
    expect(styles).toContain("padding: 32px 36px max(72px, 45dvh)");
    expect(styles).toContain("padding: 22px 16px max(64px, 45dvh) 12px");
  });
});
