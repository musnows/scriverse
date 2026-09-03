import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("AI 消息正文引用浮层", () => {
  it("为消息引用提供可访问的点击入口和正文浮层", async () => {
    const [page, application, styles] = await Promise.all([
      readFile(join(process.cwd(), "src", "public", "index.html"), "utf8"),
      readFile(join(process.cwd(), "src", "public", "app.js"), "utf8"),
      readFile(join(process.cwd(), "src", "public", "styles.css"), "utf8")
    ]);

    expect(page).toContain("feature=ai-message-citation-popover-v1");
    expect(page).toContain('id="ai-citation-popover"');
    expect(page).toContain('aria-label="关闭正文引用"');
    expect(application).toContain("function openAiCitationPopover(citation, trigger)");
    expect(application).toContain('reference.className = "message-citation";');
    expect(application).toContain('reference.setAttribute("aria-haspopup", "dialog");');
    expect(application).toContain('reference.setAttribute("aria-controls", "ai-citation-popover");');
    expect(application).toContain('$("#ai-citation-popover-quote").textContent = citation.text || "（空白行）";');
    expect(application).toContain('closeAiCitationPopover({ restoreFocus: true });');
    expect(styles).toContain(".message-citations .message-citation");
    expect(styles).toContain(".ai-citation-popover");
    expect(styles).toContain(".ai-citation-popover-quote");
  });
});
