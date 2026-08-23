import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("分析任务失败信息强调样式", () => {
  it("用深橙色突出失败标题和内容并更新静态资源版本", () => {
    const root = process.cwd();
    const application = readFileSync(join(root, "src/public/app.js"), "utf8");
    const styles = readFileSync(join(root, "src/public/styles.css"), "utf8");
    const page = readFileSync(join(root, "src/public/index.html"), "utf8");

    expect(application).toContain('class="task-detail-failures"><strong>失败信息</strong>');
    expect(styles).toContain("--failure-emphasis: #b54708");
    expect(styles).toContain("--failure-emphasis: #e06a28");
    expect(styles).toContain(".task-detail-failures { color: var(--failure-emphasis); font-weight: 600; }");
    expect(page.match(/feature=task-detail-failure-orange-v1/g)).toHaveLength(2);
  });
});
