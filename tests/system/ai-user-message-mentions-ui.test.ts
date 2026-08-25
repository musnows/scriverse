import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("AI 用户消息引用横幅", () => {
  it("透传流式消息 metadata 并渲染可换行的三类引用标签", async () => {
    const [page, application, styles] = await Promise.all([
      readFile(join(process.cwd(), "src", "public", "index.html"), "utf8"),
      readFile(join(process.cwd(), "src", "public", "app.js"), "utf8"),
      readFile(join(process.cwd(), "src", "public", "styles.css"), "utf8")
    ]);

    expect(page).toContain('/styles.css?v=20260816-task-scope-volume-collapse-v2');
    expect(page).toContain('/app.js?v=20260816-extended-thinking-effort-v1');
    expect(page).toContain('feature=ai-roleplay-message-reference-v1');
    expect(application).toContain('/ai-mentions.js?v=20260811-user-message-mentions-v1');
    expect(application).toContain("persistedUserMessage.createdAt, persistedUserMessage.metadata, persistedUserMessage.id");
    expect(application).toContain('["角色", metadata?.mentionCharacterIds, state.characters]');
    expect(application).toContain('["种族", metadata?.mentionRaceIds, state.races]');
    expect(application).toContain('["组织", metadata?.mentionOrganizationIds, state.organizations]');
    expect(application).toContain('label.textContent = "引用";');
    expect(application).toContain('reference.setAttribute("aria-label", `${kind}：${name}`);');
    expect(application).toContain('canReadModule("races") ? api(`/api/works/${workId}/races`)');
    expect(application).toContain('canReadModule("organizations") ? apiAllPages(`/api/works/${workId}/organizations`)');
    expect(application).toContain("ensureAiReferencesLoaded()\n    ]);");
    expect(application).toContain("function aiPromptTextFromRange(range, prompt)");
    expect(application).toContain("function aiPromptTextBoundary(prompt, offset)");
    expect(application).toContain("const cursorText = aiPromptTextFromRange(aiMentionRange, prompt);");
    expect(application).toContain("const startBoundary = aiPromptTextBoundary(prompt, localMention.start);");
    expect(application).toContain('references.className = "user-message-mentions";');
    expect(styles).toContain(".user-message-mentions { display: flex; align-items: center; flex-wrap: wrap;");
    expect(styles).toContain(".user-message-mention { min-width: 0; max-width: 100%;");
  });
});
