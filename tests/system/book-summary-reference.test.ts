import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

describe("全书概要上下文引用", () => {
  const runtimes: Runtime[] = [];

  afterEach(async () => {
    while (runtimes.length) await runtimes.pop()?.close();
  });

  it("默认不引用上下文并保留显式的章节与全书范围", async () => {
    const runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "book-summary-reference-system-test-secret",
      disableUserAuth: true,
      serveUi: true
    });
    runtimes.push(runtime);

    const page = await request(runtime.app).get("/").expect(200);
    const application = await request(runtime.app).get("/app.js").expect(200);
    const styles = await request(runtime.app).get("/styles.css").expect(200);

    expect(page.text).toContain('<select id="ai-scope" aria-label="上下文范围">\n              <option value="none">无上下文</option>');
    expect(page.text).toContain('<option value="chapter-summary">当前章节 + 全书概要</option>');
    expect(page.text).toContain('<option value="settings-catalog">设定库</option>');
    expect(page.text).not.toContain('id="ai-include-setting-info"');
    expect(page.text).not.toContain('<option value="selection">选中文本</option>');
    expect(page.text).not.toContain('id="ai-book-summary-reference"');
    expect(page.text).toContain('/app.js?v=20260816-extended-thinking-effort-v1');
    expect(page.text).toContain('feature=ai-write-tools-v2');
    expect(application.text).toContain('id="save-agent-tools"');
    expect(application.text).toContain('class="book-summary-context-percent-field"');
    expect(application.text).toContain('class="config-inline-save"');
    expect(application.text).toContain('class="ghost-button config-save-button"');
    expect(application.text).toContain('id="save-book-summary-context-percent" class="ghost-button config-save-button" type="button">保存</button>');
    expect(application.text).toContain('id="save-context-compact-threshold" class="ghost-button config-save-button" type="button">保存</button>');
    expect(application.text).toContain('id="save-agent-tool-call-limit" class="ghost-button config-save-button" type="button">保存</button>');
    expect(application.text).toContain('<h2>设定上下文注入</h2>');
    expect(application.text.indexOf('<h2>设定上下文注入</h2>')).toBeLessThan(application.text.indexOf('<h2>Agent 工具调用上限</h2>'));
    expect(application.text).toContain('<label class="checkbox-field config-checkbox-field"><input id="always-include-setting-info"');
    expect(application.text).toContain('id="always-include-setting-info" type="checkbox"');
    expect(application.text).toContain('id="save-always-include-setting-info"');
    expect(application.text).toContain('body: { alwaysIncludeSettingInfo }');
    expect(application.text).toContain('即使本轮同时使用“@注入上下文设定”，也只会注入一次');
    expect(application.text).toContain('id="agent-tool-call-global-multiplier"');
    expect(application.text).toContain('aria-label="Agent 工具调用全局倍数"');
    expect(application.text).toContain('class="settings-layout-toggle agent-tool-call-global-multiplier-toggle"');
    expect(application.text).toContain('data-global-multiplier="${value}"');
    expect(application.text).toContain('href="https://scriverse.top/docs/global-tool-call-limit.html"');
    expect(application.text).toContain('class="config-doc-link"');
    expect(styles.text).toContain(".config-section-header .config-doc-link {");
    expect(application.text).toContain('id="sync-relationship-search-index"');
    expect(application.text).toContain('id="refresh-relationship-search-index"');
    expect(application.text).toContain('id="rebuild-relationship-search-index"');
    expect(application.text).toContain('增量任务队列');
    expect(application.text).toContain('ready: "已索引"');
    expect(application.text).toContain('<dt>已索引正文段落</dt>');
    expect(application.text).toContain('<dt>已索引设定来源</dt>');
    expect(application.text).toContain('class="ai-agent-tools"');
    expect(application.text).toContain('class="config-section ai-agent-tools-section"');
    expect(application.text).toContain('const includeBookSummary = scopeType === "chapter-summary";');
    expect(application.text).toContain('const requiresChapter = taskType === "polish" || taskType === "continue" || (scopeType !== "none" && scopeType !== "settings-catalog");');
    expect(application.text).not.toContain('syncAiIncludeSettingInfoControl');
    expect(application.text).toContain('conversationScope.includeSettingInfo = false');
    expect(application.text).toContain('mergeAiReferenceScope(conversationScope, state.aiReferences)');
    expect(application.text).toContain('if (!state.work) return toast("请先选择作品", "error");');
    expect(application.text).toContain('scopeType === "none" ? { type: "none"');
    expect(application.text).toContain("if (includeBookSummary) conversationScope.includeBookSummary = true;");
    expect(application.text).toContain('scopeType === "settings-catalog" ? { type: "settings-catalog" }');
    expect(application.text).toContain('body.append("expectedVersionNo", String(state.work.versionNo));');
    expect(styles.text).not.toContain(".ai-book-summary-reference");
    expect(styles.text).not.toContain(".prompt-options .ai-include-setting-info");
    expect(styles.text).toContain(".book-summary-context-percent-field input, .context-compact-threshold-field input, .agent-tool-call-limit-field input, .daily-token-quota-field input { width: 64px; min-height: 32px; padding: 5px 8px; font-size: 13px;");
    expect(styles.text).toContain(".config-inline-save .context-compact-threshold-field input { width: 88px; }");
    expect(styles.text).toContain(".config-inline-save { display: flex; align-items: flex-end; gap: 10px;");
    expect(styles.text).toContain(".config-inline-save .agent-tool-call-limit-field,\n.config-inline-save .daily-token-quota-field { display: grid; gap: 6px; width: 64px;");
    expect(styles.text).toContain(".config-inline-save .agent-tool-call-global-multiplier-field { display: grid; gap: 6px; width: auto;");
    expect(styles.text).toContain(".agent-tool-call-global-multiplier-toggle button { width: 32px; min-width: 32px; height: 30px; min-height: 30px; padding: 0;");
    expect(styles.text).toContain(".relationship-index-summary { display: grid;");
    expect(styles.text).toContain(".config-section .config-save-button { min-height: 32px; padding: 5px 11px; font-size: 11px; }");
    expect(styles.text).toContain(".config-inline-save > .config-checkbox-field { display: inline-flex !important; align-items: center; gap: 8px;");
    expect(styles.text).toContain('.config-inline-save > .config-checkbox-field input[type="checkbox"] { width: 18px; min-width: 18px; height: 18px; }');
    expect(styles.text).toContain(".ai-agent-tools { display: grid; gap: 8px; }");
    expect(styles.text).toContain(".ai-agent-tools-section + .empty-state { margin-top: 24px; border-top: 1px solid var(--line); }");
    expect(styles.text).toContain(".card-actions .primary-button { border-color: var(--accent);");
  });
});
