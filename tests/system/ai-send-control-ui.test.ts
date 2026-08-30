import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("AI 对话发送与终止按钮", () => {
  it("空闲时显示纸飞机并在生成期间切换为可用的终止按钮", async () => {
    const publicPath = join(process.cwd(), "src", "public");
    const [application, page, styles] = await Promise.all([
      readFile(join(publicPath, "app.js"), "utf8"),
      readFile(join(publicPath, "index.html"), "utf8"),
      readFile(join(publicPath, "styles.css"), "utf8")
    ]);

    expect(page).toContain('id="ai-send" class="ai-send-button" type="button" data-state="send" aria-label="发送消息" title="发送消息"');
    expect(page).toContain("&feature=phone-client-entry-v1");
    expect(page).toContain('class="ai-send-button-icon"');
    expect(application).toContain("function aiSendButtonIconMarkup(stateName)");
    expect(application).toContain('const stateName = sending ? "stop" : (switching || continuingQuestion) ? "switching" : "send";');
    expect(application).toContain("button.disabled = switching || continuingQuestion;");
    expect(application).toContain('button.classList.toggle("is-stop", sending);');
    expect(application).toContain('continuingQuestion ? "AI 正在根据回答继续处理" : switching ? "正在切换对话" : "发送消息"');
    expect(styles).toContain(".ai-send-button-icon { width: 17px; height: 17px;");
    expect(styles).toContain(".ai-context-meter { --context-usage: 0; --context-meter-color: var(--green); position: relative; display: grid; flex: 0 0 32px; place-items: center; width: 32px; min-height: 32px; height: 32px;");
    expect(styles).toContain(".ai-send-button { display: grid; flex: 0 0 32px; place-items: center; width: 32px; min-width: 32px; min-height: 32px; height: 32px;");
    expect(styles).toContain(".ai-heading #ai-panel-toggle { flex-basis: 30px; width: 30px; min-width: 30px; min-height: 30px; height: 30px; }");
    expect(application).toContain('import { isPhoneClient } from "/phone-client.js?v=20260819-phone-client-v1";');
    expect(application).toContain("const phoneClient = isPhoneClient();");
    expect(application).toContain("if (phoneClient && !aiConversationWorkspaceOpen) panelLayout.aiCollapsed = true;");
    expect(application).toContain('app.classList.toggle("phone-client", phoneClient);');
    expect(application).toContain("const mobileWorkspace = isPhoneClient() || isMobileViewport();");
    expect(styles).toContain(".app-shell.phone-client.ai-panel-collapsed:not(.ai-workspace-mode) { --ai-panel-width: 0px !important; }");
    expect(styles).toContain(".app-shell.phone-client.ai-panel-collapsed:not(.ai-workspace-mode) .ai-panel { display: none; }");
    expect(styles).not.toContain(".app-shell.ai-panel-collapsed:not(.ai-workspace-mode) .ai-panel { display: none; }");
    expect(styles).toContain(".ai-send-button.is-stop .ai-send-button-icon");
    expect(styles).not.toContain(".ai-send-button.is-stop { background");
    expect(styles).not.toContain(".ai-send-button.is-stop:hover");
  });

  it("点击终止只取消当前页签请求并恢复重新发送能力", async () => {
    const publicPath = join(process.cwd(), "src", "public");
    const [application, page] = await Promise.all([
      readFile(join(publicPath, "app.js"), "utf8"),
      readFile(join(publicPath, "index.html"), "utf8")
    ]);

    expect(application).toContain("function activateAiSendControl()");
    expect(application).toContain('cancelActiveAiRequest("用户已终止当前回复")');
    expect(application).toContain('toast("已终止当前回复，可以重新发送")');
    expect(application).toContain('$("#ai-send").addEventListener("click", activateAiSendControl);');
    expect(application).toContain("if (aiRequestManager.hasActive(tab.id)) return;");
    expect(application).toContain('request.signal.reason.message === "用户已终止当前回复"');
    expect(application).toContain('const cancelledByClient = request.signal.reason?.code === "AI_REQUEST_CANCELLED";');
    expect(application).toContain('if (code === "AI_REQUEST_CANCELLED") return "已终止";');
    expect(application).toContain("const hasRenderableProcessSteps = processSteps.some(shouldRenderAiProcessStep);");
    expect(application).toContain("const interruption = streamedText || hasRenderableProcessSteps ? {");
    expect(application).toContain("...(processSteps.length ? { processSteps } : {})");
    expect(application).toContain("...(interruption?.metadata ?? {})");
    expect(page).toContain("&feature=ai-send-control-v3");
    expect(page).toContain("&feature=ai-cancel-preserve-process-v2");
  });
});
