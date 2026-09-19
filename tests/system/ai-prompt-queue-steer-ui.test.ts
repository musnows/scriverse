import { readFile } from "node:fs/promises";
import { join } from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createRuntime } from "../../src/app.js";

describe("AI 策略栏排队与执行流引导 UI", () => {
  it("策略栏提供排队面板、独立终止和引导按钮，发送键执行中变为排队而不是打断", async () => {
    const publicPath = join(process.cwd(), "src", "public");
    const [application, page, styles, keyboard] = await Promise.all([
      readFile(join(publicPath, "app.js"), "utf8"),
      readFile(join(publicPath, "index.html"), "utf8"),
      readFile(join(publicPath, "styles.css"), "utf8"),
      readFile(join(publicPath, "ai-prompt-keyboard.js"), "utf8")
    ]);

    expect(page).toContain('id="ai-prompt-queue"');
    expect(page).toContain('id="ai-prompt-queue-list"');
    expect(page).toContain('aria-label="排队 Prompt"');
    expect(page).not.toContain('id="ai-prompt-queue-title"');
    expect(page).not.toContain("ai-prompt-queue-header");
    expect(page).not.toContain("当前回复结束后按顺序发送，不会打断正在执行的回复");
    expect(page).toContain('id="ai-steer" class="ai-steer-button hidden"');
    expect(page).toContain('id="ai-stop" class="ai-stop-button hidden"');
    expect(page).toContain('aria-label="发送为引导"');
    expect(page).toContain("Enter 发送或排队，Ctrl+Enter 发送为引导");
    expect(page).toContain("&feature=ai-prompt-queue-steer-v3");
    expect(application).toContain("/ai-prompt-queue.js?v=20260919-ai-prompt-queue-v2");
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
    expect(application).toContain('const stateName = sending ? "queue"');
    expect(application).not.toContain('const stateName = sending ? "stop"');
    expect(application).toContain("queueActiveComposerPrompt()");
    expect(application).toContain("$(\"#ai-stop\").addEventListener(\"click\", activateAiStopControl);");
    expect(application).not.toContain("promoteNow");
    expect(keyboard).toContain("export function shouldSteerAiPrompt(event)");
    expect(styles).toContain(".ai-prompt-queue ");
    expect(styles).toContain(".ai-prompt-queue-item { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center;");
    expect(styles).toContain(".ai-prompt-queue-item.is-drag-over");
    expect(styles).toContain(".ai-prompt-queue-editor ");
    expect(styles).not.toContain(".ai-prompt-queue-header");
    expect(styles).not.toContain(".ai-prompt-queue-count");
    expect(styles).toContain(".ai-steer-button ");
    expect(styles).toContain(".ai-stop-button ");
    expect(styles).toContain(".ai-send-button.is-queue");
    expect(styles).toContain(".user-message.is-steer");
    expect(styles).toContain("@media (max-width: 540px)");
    expect(styles).toContain(".prompt-composer.is-streaming .ai-prompt { padding-right: 176px; }");
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
      const [queue, keyboard, page] = await Promise.all([
        request(runtime.app).get("/ai-prompt-queue.js").expect(200),
        request(runtime.app).get("/ai-prompt-keyboard.js").expect(200),
        request(runtime.app).get("/").expect(200)
      ]);
      expect(queue.text).toContain("export function canSendQueuedPromptAsSteer");
      expect(queue.text).toContain("export function moveQueuedPromptItem");
      expect(queue.text).toContain("export function queuedPromptEditPatch");
      expect(keyboard.text).toContain("export function shouldSteerAiPrompt");
      expect(page.text).toContain('id="ai-prompt-queue"');
      expect(page.text).not.toContain('id="ai-prompt-queue-title"');
      expect(page.text).toContain("&feature=ai-prompt-queue-steer-v3");
    } finally {
      await runtime.close();
    }
  });
});
