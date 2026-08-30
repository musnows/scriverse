import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

describe("AI 输入框引用气泡", () => {
  const runtimes: Runtime[] = [];

  afterEach(async () => {
    while (runtimes.length) await runtimes.pop()?.close();
  });

  it("将引用放入可编辑输入框并移除上方引用区", async () => {
    const runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "ai-mention-chip-system-test-secret",
      disableUserAuth: true,
      serveUi: true
    });
    runtimes.push(runtime);

    const page = await request(runtime.app).get("/").expect(200);
    const application = await request(runtime.app).get("/app.js").expect(200);
    const skillMenu = await request(runtime.app).get("/ai-skill-menu.js?v=ai-skill-slash-menu").expect(200);
    const styles = await request(runtime.app).get("/styles.css").expect(200);

    expect(page.text).toContain('id="ai-prompt" class="ai-prompt" contenteditable="true" role="textbox" aria-multiline="true" aria-autocomplete="list"');
    expect(page.text).toContain('aria-controls="ai-mention-menu" aria-haspopup="listbox" aria-expanded="false"');
    expect(page.text).toContain('aria-label="引用角色、设定、章节或上下文能力"');
    expect(page.text.match(/feature=ai-skill-slash-menu-v1/gu)).toHaveLength(3);
    expect(page.text).not.toContain('id="ai-include-setting-info"');
    expect(page.text).not.toContain('id="ai-references"');
    expect(application.text).toContain("function createAiReferenceChip(reference)");
    expect(application.text).toContain('chapter: "章节"');
    expect(application.text).toContain('"context-settings": "能力"');
    expect(application.text).toContain('item.kind !== "context-settings" || $("#ai-task").value !== "roleplay"');
    expect(application.text).toContain("volumeTitle: volume.title");
    expect(application.text).toContain("没有匹配的角色、设定、章节或上下文能力");
    expect(application.text).toContain("function moveAiMentionActiveOption(direction)");
    expect(application.text).toContain('/ai-skill-menu.js?v=20260830-ai-skill-slash-menu-v1');
    expect(application.text).toContain('menu.setAttribute("aria-label", "选择写作 Skill")');
    expect(application.text).toContain('data-ai-skill-name="${esc(item.name)}"');
    expect(application.text).toContain("function selectAiSkill(button)");
    expect(application.text).toContain("if (activeOption.dataset.aiSkillName) selectAiSkill(activeOption)");
    expect(application.text).toContain('prompt.setAttribute("aria-activedescendant", activeOption.id);');
    expect(application.text).toContain('option.setAttribute("aria-selected", String(active));');
    expect(application.text).toContain('bindPlainTextPaste($("#ai-prompt"));');
    expect(application.text).toContain('/plain-text-paste.js?v=20260815-plain-text-paste-v1');
    expect(application.text).toContain('event.key === "ArrowDown" || event.key === "ArrowUp"');
    expect(application.text).toContain('selectAiMention(activeOption);');
    expect(application.text).toContain("conversationScope.includeSettingInfo = false");
    expect(application.text).toContain("range.insertNode(createAiReferenceChip(reference));");
    expect(application.text).toContain("function clearAiPromptComposer({ collapseScenePanel = false } = {})");
    const sendAiSource = application.text.slice(
      application.text.indexOf("async function sendAi()"),
      application.text.indexOf("async function streamChat(requestHolder, body, idempotencyKey)")
    );
    const streamChatSource = application.text.slice(
      application.text.indexOf("async function streamChat(requestHolder, body, idempotencyKey)"),
      application.text.indexOf("function appendAiMessageImageAttachments")
    );
    expect(sendAiSource).toContain("const streamed = await streamChat");
    const appendUserMessageIndex = streamChatSource.indexOf('appendMessage("user"');
    const clearComposerIndex = streamChatSource.indexOf("clearAiPromptComposer({ collapseScenePanel:");
    expect(appendUserMessageIndex).toBeGreaterThanOrEqual(0);
    expect(clearComposerIndex).toBeGreaterThan(appendUserMessageIndex);
    expect(streamChatSource.match(/clearAiPromptComposer\(/gu)).toHaveLength(1);
    expect(styles.text).toContain(".ai-prompt-reference");
    expect(styles.text).toContain(".ai-mention-option.is-active");
    expect(styles.text).toContain(".ai-skill-option > span");
    expect(styles.text).toContain(".ai-skill-option em");
    expect(styles.text).not.toContain(".ai-reference-chip");
    expect(skillMenu.text).toContain('name: "continue-writing"');
    expect(skillMenu.text).toContain('name: "polish-writing"');
    expect(skillMenu.text).toContain("export function findAiSkillCommand");
  });
});
