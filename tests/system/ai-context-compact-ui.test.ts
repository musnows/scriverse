import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("AI 对话上下文 compact 界面", () => {
  it("提供独立预算 compact 阈值、整理操作和自动整理前置检查", async () => {
    const publicPath = join(process.cwd(), "src", "public");
    const [page, application, styles] = await Promise.all([
      readFile(join(publicPath, "index.html"), "utf8"),
      readFile(join(publicPath, "app.js"), "utf8"),
      readFile(join(publicPath, "styles.css"), "utf8")
    ]);
    const applyRoleplayCharacter = application.slice(
      application.indexOf("function applyAiRoleplayCharacter"),
      application.indexOf("function refreshAiMessageRoleLabels")
    );
    const updateRoleplayCharacter = application.slice(
      application.indexOf("async function updateAiRoleplayCharacter"),
      application.indexOf("async function ensureAiConversation()")
    );

    expect(page).toContain('id="ai-context-warning"');
    expect(page).toContain('id="ai-context-popover"');
    expect(page).toContain('id="ai-context-distribution"');
    expect(page).toContain('id="ai-context-compact"');
    expect(page).toContain('id="ai-context-dismiss"');
    expect(page).toContain('id="ai-context-new-conversation"');
    expect(page).toContain('&feature=context-percent-format-v1');
    expect(page).toContain("当前对话上下文过长，是否进行压缩？不压缩可能会导致后续请求失败");
    expect(page).toContain('id="ai-context-compact" type="button">压缩</button>');
    expect(page).toContain('id="ai-context-dismiss" type="button">忽略</button>');
    expect(application).toContain('id="context-compact-threshold" type="number" min="50" max="90"');
    expect(application).toContain('<h2>对话上下文 Compact</h2>');
    expect(application).toContain('Compact 阈值（%）');
    expect(application).toContain("该阈值按对话历史的独立预算计算");
    expect(application).toContain("整次请求达到模型上下文窗口 95% 时仍会强制压缩");
    expect(application).toContain("当前对话上下文过长，是否进行压缩？不压缩可能会导致后续请求失败");
    expect(application).toContain('eventName === "context"');
    expect(application).toContain('eventName === "context_compacted"');
    expect(application).toContain('eventName === "user_message"');
    expect(application).toContain('if (!tab.promptSent) setAiChatTabContextUsage(tab, payload.usage);');
    expect(application).toContain("/compact`");
    expect(application).not.toContain("prepareAiConversationContext");
    expect(application).toContain('contextAction === "warn"');
    expect(application).toContain('contextAction === "compacted"');
    expect(application).toContain('divider.innerHTML = "<span>—— 当前上下文已压缩 ——</span>"');
    expect(application).toContain('payload.warningOnly === true');
    expect(application).toContain('sendAiWithOptions({ ignoreContextWarning: true })');
    expect(application).toContain('...(ignoreContextWarning ? { ignoreContextWarning: true } : {})');
    expect(application).toContain("function setAiContextWarningActionsDisabled(disabled)");
    expect(application).toContain('if ($("#ai-context-warning").classList.contains("hidden")) $("#ai-prompt").focus();');
    expect(application).toContain("renderConversationCompactionDivider(conversation.compactedMessageCount, conversation.messageCount, tab.feed, conversation)");
    expect(application).toContain('step?.type === "context_compaction"');
    expect(application).toContain('function createAiContextCompactionDivider({ kind = "conversation"');
    expect(application).toContain('kind: "tool"');
    expect(application).toContain('divider.className = "ai-context-compaction-divider"');
    expect(application).not.toContain("ai-process-context-compaction");
    expect(application).toContain('writingSuggestion = streamed.writingSuggestion;');
    expect(application).toContain('setAiChatTabContextUsage(tab, payload.contextUsage);');
    expect(application).toContain('setAiChatTabContextUsage(tab, payload.contextUsage, announcedCompaction);');
    expect(application).toContain('const announcedCompaction = contextAction === "compacted" || streamContextCompacted;');
    expect(application).toContain("function setAiContextMeter(usage, allowShrink = true)");
    expect(application).toContain("mergeAiContextUsage(latestAiContextUsage, usage, false)");
    expect(application).toContain("latestAiContextUsage = displayUsage;");
    expect(application).toContain("function resetAiContextMeter()");
    expect(applyRoleplayCharacter).not.toContain("resetAiContextMeter()");
    expect(updateRoleplayCharacter).toContain("resetAiContextMeter()");
    expect(application).toContain("normalizeAiContextTokenDistribution");
    expect(application).toContain("formatAiContextUsagePercent");
    expect(application).toContain("formatAiContextUsagePercent(distribution.occupiedTokens, distribution.contextWindow)");
    expect(application).toContain('/ai-context-meter.js?v=20260828-context-output-usage-v1');
    expect(application).toContain("setAiContextDistributionVisible");
    expect(styles).toContain(".ai-context-popover::after { position: absolute; right: 87px;");
    expect(styles).toContain(".ai-context-popover.hidden { display: none; }");
    expect(styles).toContain(".ai-context-warning.hidden { display: none; }");
    expect(styles).toContain(".ai-context-compaction-divider { display: grid;");
    expect(styles).toContain(".ai-context-compaction-divider::before, .ai-context-compaction-divider::after");
    expect(styles).toContain(".ai-feed > .ai-context-compaction-divider { margin: 4px 0 16px; }");
    expect(styles).toContain(".ai-process-list > .ai-context-compaction-divider { padding: 2px 0; }");
    expect(styles).not.toContain(".ai-process-context-compaction");
  });
});
