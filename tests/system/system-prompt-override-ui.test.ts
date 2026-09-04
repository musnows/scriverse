import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("系统提示词覆写设置界面", () => {
  it("在平台与作品提示词中折叠高风险开关并确认后保存", async () => {
    const publicPath = join(process.cwd(), "src", "public");
    const [page, application, styles] = await Promise.all([
      readFile(join(publicPath, "index.html"), "utf8"),
      readFile(join(publicPath, "app.js"), "utf8"),
      readFile(join(publicPath, "styles.css"), "utf8")
    ]);

    expect(page).toContain("feature=system-prompt-override-v3");
    expect(application).toContain('class="system-prompt-override-settings${checked ? " is-enabled" : ""}"');
    expect(application).toContain('inputId: "platform-system-prompt-override"');
    expect(application).toContain('inputId: "work-system-prompt-override"');
    expect(application).toContain('aria-describedby="${inputId}-warning"');
    expect(application).toContain("确认开启系统提示词覆写");
    expect(application).toContain("错误配置可能导致功能异常或安全约束失效");
    expect(application).toContain('systemPromptOverride: $("#platform-system-prompt-override").checked');
    expect(application).toContain('systemPromptOverride: $("#work-system-prompt-override").checked');
    expect(styles).toContain(".system-prompt-override-settings[open] summary::before");
    expect(styles).toContain(".system-prompt-override-warning");
  });
});
