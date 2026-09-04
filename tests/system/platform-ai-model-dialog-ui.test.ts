import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("平台 AI 模型配置弹窗布局", () => {
  it("重置弹窗 checkbox 尺寸并让模型字段按宽度响应式排列", async () => {
    const publicPath = join(process.cwd(), "src", "public");
    const [application, page, styles] = await Promise.all([
      readFile(join(publicPath, "app.js"), "utf8"),
      readFile(join(publicPath, "index.html"), "utf8"),
      readFile(join(publicPath, "styles.css"), "utf8")
    ]);

    expect(application).toContain('class="form-field model-kind-fields"');
    expect(styles).toContain('.dialog-fields input[type="checkbox"]');
    expect(styles).toContain('height: 16px; min-height: 16px; margin: 0; padding: 0;');
    expect(styles).toContain('#dialog-fields:has(.model-kind-fields) [data-chat-model-fields] { display: contents; }');
    expect(styles).toContain('@media (max-width: 480px)');
    expect(page).toContain('&feature=ai-model-config-dialog-v1');
  });
});
