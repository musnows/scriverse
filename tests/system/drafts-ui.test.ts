import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createRuntime } from "../../src/app.js";

const runtime = createRuntime({
  databasePath: ":memory:",
  masterSecret: "drafts-ui-system-test-secret-at-least-32-characters",
  disableUserAuth: true,
  serveUi: true
});

afterAll(() => runtime.close());

describe("想法模块界面", () => {
  it("提供想法入口、两种类型和 Vditor 编辑器", async () => {
    const page = await request(runtime.app).get("/").expect(200);
    const application = await request(runtime.app).get("/app.js").expect(200);
    const styles = await request(runtime.app).get("/styles.css").expect(200);

    expect(page.text).toContain('data-module="drafts"');
    expect(page.text).toContain(">想法</button>");
    expect(page.text).toContain('/app.js?v=20260905-ai-approvals-v4');
    expect(application.text).toContain('drafts: ["临时想法", "创作想法"');
    expect(application.text).toContain('[["prose", "正文想法"], ["setting", "设定想法"]]');
    expect(application.text).toContain('field("volumeId", "绑定分卷"');
    expect(application.text).toContain('field("settingModule", "绑定设定模块"');
    expect(application.text).toContain('field("content", "内容", "markdown"');
    expect(application.text).toContain('data-vditor-editor');
    expect(application.text).toContain('meta: "这里记录未确认的临时想法，可能采用，也可能永远不会写入正文或正式设定。"');
    expect(application.text).not.toContain('<p class="form-field-note">这里记录未确认的临时想法');
    expect(application.text).toContain('value="search_drafts"');
    expect(application.text).toContain('id="draft-type-filter"');
    expect(application.text).toContain('function mountDraftFilterToggle()');
    expect(application.text).toContain('aria-label="筛选想法" aria-controls="draft-filter-panel"');
    expect(application.text).toContain('id="draft-filter-panel" class="character-filter-toolbar draft-filter-toolbar${draftFiltersPanelOpen ? "" : " hidden"}"');
    expect(application.text).toContain('>全部想法</option>');
    expect(application.text).toContain('>正文想法</option>');
    expect(application.text).toContain('>设定想法</option>');
    expect(application.text).toContain('id="draft-binding-filter"');
    expect(application.text).toContain('按绑定位置筛选');
    expect(application.text).toContain('id="clear-draft-filters"');
    expect(application.text).toContain('selectedBindingKeys.has(draftBindingKey(draft))');
    expect(application.text).toContain('没有符合筛选条件的想法');
    expect(application.text).toContain('formDialogVditors = bindVditorEditors($("#dialog-fields"))');
    expect(application.text).toContain('formDialogVditors.forEach(destroyVditorEditor)');
    expect(application.text).toContain('markdown-editor-field${options.readOnly ? " is-read-only" : ""}');
    expect(application.text).toContain('aria-readonly="true"');
    expect(application.text).toContain('data-dialog-draft-delete');
    expect(application.text).not.toContain('data-delete-draft');
    expect(application.text).toContain('title: "删除操作需要再次确认"');
    expect(application.text).toContain('confirmLabel: "继续删除"');
    expect(application.text).toContain('confirmLabel: "确认删除"');
    expect(application.text).toContain('editor: true');
    expect(application.text).toContain('dialog.classList.toggle("editor-dialog", Boolean(options.editor))');
    expect(styles.text).toContain('.draft-filter-toolbar { grid-template-columns:');
    expect(styles.text).toContain('.draft-type-filter-field select { width: 100%;');
    expect(styles.text).toContain('font-size: 11px; }');
    expect(styles.text).toContain('.card-actions .record-card-edit { position: static; padding: 0; }');
    expect(styles.text).toContain('.editor-dialog { width: min(1180px, 94vw); max-height: calc(100dvh - 16px); }');
    expect(styles.text).toContain('.markdown-editor-field.is-read-only .vditor-ir pre.vditor-reset[contenteditable="false"]');
    expect(styles.text).toContain('.editor-dialog .dialog-fields input[readonly]');
    expect(styles.text).toContain('.editor-dialog .dialog-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); max-height: 76dvh;');
    expect(styles.text).toContain('.editor-dialog .markdown-editor-field .vditor-editor-host.vditor { min-height: clamp(420px, 56dvh, 640px) !important; }');
  });
});
