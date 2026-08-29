import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("AI 错误详情界面", () => {
  it("普通流式失败在追加持久化失败消息前移除临时流式消息", async () => {
    const application = await readFile(join(process.cwd(), "src", "public", "app.js"), "utf8");
    const sendAiSource = application.slice(
      application.indexOf("async function sendAi()"),
      application.indexOf("async function streamChat(requestHolder, body, idempotencyKey)")
    );
    const sendFailureSource = sendAiSource.slice(
      sendAiSource.lastIndexOf("  } catch (error) {"),
      sendAiSource.lastIndexOf("  } finally {")
    );
    const streamChatSource = application.slice(
      application.indexOf("async function streamChat(requestHolder, body, idempotencyKey)"),
      application.indexOf("function appendMessage(role, text")
    );
    const streamFailureSource = streamChatSource.slice(streamChatSource.lastIndexOf("  } catch (error) {"));
    const currentRequestFailureSource = streamFailureSource.slice(
      streamFailureSource.indexOf("    assertAiRequestCurrent(requestHolder.snapshot);")
    );

    expect(currentRequestFailureSource).toContain("typewriter.reveal();");
    expect(currentRequestFailureSource).toContain("revealProcessStepTypewriters();");
    expect(currentRequestFailureSource).toContain("if (!interruption) {");
    expect(currentRequestFailureSource).toContain("if (messageMounted) message.remove();");
    expect(currentRequestFailureSource).not.toContain("mountAssistantMessage();");
    expect(currentRequestFailureSource).not.toContain("生成中断");
    expect(sendFailureSource.match(/persistAiConversationMessage\(/gu)).toHaveLength(2);
    expect(sendFailureSource.match(/appendMessage\("assistant", failureMessage/gu)).toHaveLength(1);
  });

  it("将模型目标和上游失败详情写入带状态标识的助手消息", async () => {
    const application = await readFile(join(process.cwd(), "src", "public", "app.js"), "utf8");
    const sendAiSource = application.slice(
      application.indexOf("async function sendAi()"),
      application.indexOf("async function streamChat(requestHolder, body, idempotencyKey)")
    );

    expect(application).toContain("function createClientError(payload, fallbackMessage, fallbackStatus = null)");
    expect(application).toContain("function formatAiFailureMessage(error)");
    expect(application).toContain("error.failure = typeof source.failure === \"string\" ? source.failure : undefined;");
    expect(application).toContain("error.callId = typeof source.callId === \"string\" ? source.callId : undefined;");
    expect(application).toContain("error.providerName = typeof source.providerName === \"string\" ? source.providerName : undefined;");
    expect(application).toContain("error.modelId = typeof source.modelId === \"string\" ? source.modelId : undefined;");
    expect(application).toContain("lines.push(`模型供应商：${providerName || providerId}`)");
    expect(application).toContain("lines.push(`模型 ID：${modelId}`)");
    expect(application).toContain("lines.push(`调用 ID：${callId}`)");
    expect(application).toContain("lines.push(`详细原因：${failure}`)");
    expect(application).toContain("叙界平台限制来源：${limitSource}");
    expect(application).toContain("details.platformLimited === true");
    expect(application).toContain('return lines.join("\\n");');
    expect(application).not.toContain('return lines.join("\\n\\n");');
    expect(application).toContain("function isAgentToolCallLimitFailure(text)");
    expect(application).toContain("data-ai-tool-call-settings-link");
    expect(application).toContain("前往本书 AI 设置调整工具调用上限");
    expect(application).toContain("async function openAiToolCallSettings()");
    expect(sendAiSource).toContain("const failureMessage = formatAiFailureMessage(error);");
    expect(application).toContain('streamError = createClientError(payload, "AI 流式调用失败", response.status);');
    expect(application).toContain('const isFailure = role === "assistant" && text.startsWith("调用失败：");');
    expect(application).toContain('message.className = `${role === "user" ? "user-message" : "assistant-message"}${isFailure || isInterrupted ? " is-error" : ""}`;');
    expect(application).toContain('<p class="ai-error-text">${esc(text)}</p>');
    expect(application).toContain('message.dataset.status = isInterrupted ? "interrupted" : "failed";');
    expect(application).toContain('failureBadge.className = "ai-message-status is-error";');
    expect(application).toContain('failureBadge.textContent = isInterrupted ? "中断" : "失败";');
    expect(application).toContain('failureBadge.setAttribute("aria-label", `消息状态：${isInterrupted ? aiStreamInterruptionLabel(interruptionCode) : "失败"}`);');
  });

  it("突出失败卡片并让错误正文继承正常助手消息的字体和字号", async () => {
    const styles = await readFile(join(process.cwd(), "src", "public", "styles.css"), "utf8");

    expect(styles).toContain(".assistant-message.is-error { border: 1px solid color-mix(in srgb, var(--accent) 42%, var(--line)); border-left: 3px solid var(--accent);");
    expect(styles).toContain(".assistant-message.is-error > .message-heading { color: var(--accent-dark); opacity: 1; }");
    expect(styles).toContain(".ai-message-status.is-error { border-color: var(--accent); background: var(--accent); color: #fff; }");
    expect(styles).toContain(".assistant-message.is-error .message-body { font-family: inherit; font-size: inherit; line-height: inherit; }");
    expect(styles).toContain(".assistant-message.is-error .ai-error-text { margin: 0; white-space: pre-wrap; font: inherit; }");
    expect(styles).toContain(".ai-error-settings-link-wrap");
    expect(styles).toContain(".config-section.is-targeted");
  });

  it("创作助手执行失败时将标题状态点切换为红色", async () => {
    const [page, application, styles] = await Promise.all([
      readFile(join(process.cwd(), "src", "public", "index.html"), "utf8"),
      readFile(join(process.cwd(), "src", "public", "app.js"), "utf8"),
      readFile(join(process.cwd(), "src", "public", "styles.css"), "utf8")
    ]);

    expect(page).toContain('id="ai-status-dot" class="status-dot" role="status" aria-label="创作助手状态：正常"');
    expect(application).toContain("function setAiAssistantStatus(status)");
    expect(application).toContain('dot.classList.toggle("is-error", failed);');
    expect(application).toContain('setAiChatTabStatus(tab, "streaming");');
    expect(application).toContain('if (toolCall.status === "failed") setAiChatTabStatus(tab, "error");');
    expect(application).toContain('const writingSuggestionFailed = writingSuggestion?.guard?.status === "failed"');
    expect(application).toContain('if (writingSuggestionFailed) setAiChatTabStatus(tab, "error");');
    expect(application).toContain('streamError = createClientError(payload, "AI 流式调用失败", response.status);');
    expect(styles).toContain('.status-dot.is-error { background: var(--accent);');
  });

  it("区分流超时与断流并持久化已收到的部分内容", async () => {
    const application = await readFile(join(process.cwd(), "src", "public", "app.js"), "utf8");

    expect(application).toContain('if (code === "AI_STREAM_IDLE_TIMEOUT") return "网络超时";');
    expect(application).toContain('if (code === "AI_STREAM_UPSTREAM_CLOSED") return "流被关闭";');
    expect(application).toContain("const { completed: streamCompleted } = await readAiEventStream(response.body, consume);");
    expect(application).toContain("assertAiStreamCompleted(streamCompleted);");
    expect(application).toContain('metadata?.interrupted === true');
    expect(application).toContain('interruptionMessage: streamFailure.message.slice(0, 500)');
    expect(application).toContain('{ requestId: aiAssistantRequestId(request) }');
    expect(application).toContain('persistAiRequestInterruption(request, error?.streamInterruption)');
    expect(application).toContain('formatAiStreamInterruptionMeta(error.code, persistedContent.length)');
    expect(application).toContain('toast(`${aiStreamInterruptionLabel(error.code)}：${error.message}`, "error")');
  });
});
