import { readFile } from "node:fs/promises";
import { join } from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createRuntime } from "../../src/app.js";

describe("AI 策略栏排队与执行流引导 UI", () => {
  it("策略栏用全局发送方式选择排队或引导，发送键不再打断，输入框底栏没有引导按钮", async () => {
    const publicPath = join(process.cwd(), "src", "public");
    const [application, page, styles, keyboard, sendMode] = await Promise.all([
      readFile(join(publicPath, "app.js"), "utf8"),
      readFile(join(publicPath, "index.html"), "utf8"),
      readFile(join(publicPath, "styles.css"), "utf8"),
      readFile(join(publicPath, "ai-prompt-keyboard.js"), "utf8"),
      readFile(join(publicPath, "ai-send-mode.js"), "utf8")
    ]);

    expect(page).toContain('id="ai-prompt-queue"');
    expect(page).toContain('id="ai-prompt-queue-list"');
    expect(page).toContain('aria-label="排队 Prompt"');
    expect(page).not.toContain('id="ai-prompt-queue-title"');
    expect(page).not.toContain("ai-prompt-queue-header");
    expect(page).not.toContain('id="ai-steer"');
    expect(page).not.toContain("ai-steer-button");
    expect(page).not.toContain('id="ai-stop"');
    expect(page).not.toContain("ai-stop-button");
    expect(page).toContain('id="ai-send-mode" aria-label="发送方式"');
    expect(page).toContain('<option value="queue">排队发送</option>');
    expect(page).toContain('<option value="steer">引导发送</option>');
    expect(page).toContain("Enter 按策略栏发送方式发送，Shift+Enter 换行");
    expect(page).toContain("&feature=ai-send-mode-v2");
    expect(application).toContain("/ai-prompt-queue.js?v=20260919-ai-prompt-queue-v2");
    expect(application).toContain("/ai-send-mode.js?v=20260919-ai-send-mode-v2");
    expect(application).toContain("function queueActiveComposerPrompt()");
    expect(application).toContain("function sendQueuedPromptAsSteer(itemId)");
    expect(application).toContain("function sendActiveComposerAsSteer()");
    expect(application).toContain("aiPromptQueue.restore(tab.id, queuedComposer, 0)");
    expect(application).toContain('primary.textContent = "立即引导"');
    expect(application).not.toContain('primary.textContent = "发送为引导"');
    expect(application).toContain('primary.textContent = "现在发送"');
    expect(application).toContain("function beginAiPromptQueueEdit(item)");
    expect(application).toContain("function moveAiPromptQueueItem(sourceId, targetId, placeAfter)");
    expect(application).toContain("ai-prompt-queue-editor");
    expect(application).toContain("aiPromptQueue.update(tab.id, itemId, queuedPromptEditPatch(item, value))");
    expect(application).toContain("aiPromptQueue.move(tab.id, sourceId, targetId, placeAfter)");
    expect(application).toContain("const sendAction = aiSendModeAction(aiComposerSendMode(), sending, aiComposerHasSendablePrompt())");
    expect(application).not.toContain('const stateName = sending ? "stop"');
    expect(application).toContain("if (aiRequestManager.hasActive(tab?.id) && !aiComposerHasSendablePrompt())");
    expect(application).toContain("function submitAiComposerPrompt()");
    expect(application).toContain("select.disabled = aiReadOnly;");
    expect(application).toContain("queueActiveComposerPrompt()");
    expect(application).toContain("$(\"#ai-send\").addEventListener(\"click\", activateAiSendControl);");
    expect(application).not.toContain("$(\"#ai-stop\")");
    expect(application).not.toContain("$(\"#ai-steer\")");
    expect(application).not.toContain("promoteNow");
    expect(keyboard).toContain("export function shouldActivateAiSendControl(event)");
    expect(keyboard).not.toContain("shouldSteerAiPrompt");
    expect(sendMode).toContain("export function aiSendModeAction(mode, streaming, hasComposerContent = true)");
    expect(styles).toContain(".ai-prompt-queue ");
    expect(styles).toContain(".ai-prompt-queue-item { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center;");
    expect(styles).toContain(".ai-prompt-queue-item.is-drag-over");
    expect(styles).toContain(".ai-prompt-queue-editor ");
    expect(styles).not.toContain(".ai-prompt-queue-header");
    expect(styles).not.toContain(".ai-prompt-queue-count");
    expect(styles).not.toContain(".ai-steer-button");
    expect(styles).not.toContain(".ai-stop-button");
    expect(styles).toContain(".ai-send-button.is-stop .ai-send-button-icon");
    expect(styles).toContain(".ai-send-button.is-queue");
    expect(styles).toContain(".user-message.is-steer");
    expect(styles).toContain(".prompt-options { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));");
    expect(styles).toContain("@media (max-width: 540px)");
    expect(styles).not.toContain(".prompt-composer.is-streaming .ai-prompt { padding-right: 128px; }");
    expect(styles).not.toContain("emoji");
  });

  it("运行时提供排队与引导静态脚本", async () => {
    const runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "ai-prompt-queue-steer-system-test-secret-32",
      disableUserAuth: true,
      serveUi: true
    });
    try {
      const [queue, keyboard, sendMode, page] = await Promise.all([
        request(runtime.app).get("/ai-prompt-queue.js").expect(200),
        request(runtime.app).get("/ai-prompt-keyboard.js").expect(200),
        request(runtime.app).get("/ai-send-mode.js").expect(200),
        request(runtime.app).get("/").expect(200)
      ]);
      expect(queue.text).toContain("export function canSendQueuedPromptAsSteer");
      expect(queue.text).toContain("export function moveQueuedPromptItem");
      expect(queue.text).toContain("export function queuedPromptEditPatch");
      expect(keyboard.text).toContain("export function shouldActivateAiSendControl");
      expect(sendMode.text).toContain("export function aiSendModeAction");
      expect(page.text).toContain('id="ai-prompt-queue"');
      expect(page.text).toContain('id="ai-send-mode"');
      expect(page.text).not.toContain('id="ai-prompt-queue-title"');
      expect(page.text).not.toContain('id="ai-steer"');
      expect(page.text).not.toContain('id="ai-stop"');
      expect(page.text).toContain("&feature=ai-send-mode-v2");
    } finally {
      await runtime.close();
    }
  });
});
