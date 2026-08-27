import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("阅读预览首帧稳定性", () => {
  it("从路由阶段直接显示阅读骨架并隐藏后台工作台", async () => {
    const [themeInit, styles, page] = await Promise.all([
      readFile(join(process.cwd(), "src/public/theme-init.js"), "utf8"),
      readFile(join(process.cwd(), "src/public/styles.css"), "utf8"),
      readFile(join(process.cwd(), "src/public/index.html"), "utf8")
    ]);

    expect(themeInit).toContain('["editor", "module", "welcome", "reader"].includes(routeView)');
    expect(styles).toContain('[data-pending-view="reader"] #reader-view.hidden { display: grid !important; }');
    expect(styles).toContain('[data-pending-view="reader"] .app-shell { visibility: hidden; }');
    expect(page).toContain('id="reader-continuation" class="reader-continuation hidden"');
  });

  it("正文加载完成前不展示会被正文推离首屏的续章控件", async () => {
    const application = await readFile(join(process.cwd(), "src/public/app.js"), "utf8");

    expect(application.split('$("#reader-continuation").classList.toggle("hidden", readingLoading || readingPreferences.mode === "paged")')).toHaveLength(3);
    expect(application).toContain('document.documentElement.removeAttribute("data-pending-view")');
    expect(application).toContain('document.documentElement.classList.remove("pending-shelf-mode")');
  });
});
