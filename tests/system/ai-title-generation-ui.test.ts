import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("AI 对话标题生成设置", () => {
  it("展示创作助手对话标题生成模型并接收延后标题结果", async () => {
    const publicPath = join(process.cwd(), "src", "public");
    const [application, page] = await Promise.all([
      readFile(join(publicPath, "app.js"), "utf8"),
      readFile(join(publicPath, "index.html"), "utf8")
    ]);

    expect(application).toContain("data-title-generation-default");
    expect(application).toContain("创作助手对话标题生成");
    expect(application).toContain("使用提示词前 15 个字");
    expect(application).toContain("titleGenerationModelId: select.value");
    expect(application).toContain("applyAiConversationTitle(streamed.conversationTitle, streamedRequest.conversationId)");
    expect(application).toContain("conversationTitle = typeof payload.conversationTitle === \"string\"");
    expect(page).toContain('id="ai-conversation-title"');
  });
});
