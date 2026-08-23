import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("AI 模型选择收纳界面", () => {
  it("将模型选择收纳为 Context 右侧的脑图标按钮，并保留可访问的弹出选择器", async () => {
    const publicPath = join(process.cwd(), "src", "public");
    const [application, page, styles] = await Promise.all([
      readFile(join(publicPath, "app.js"), "utf8"),
      readFile(join(publicPath, "index.html"), "utf8"),
      readFile(join(publicPath, "styles.css"), "utf8")
    ]);

    expect(page).not.toContain('class="field-label prompt-model-field"');
    expect(page).toContain('id="ai-model-picker" class="ai-model-picker" type="button"');
    expect(page).toContain('aria-controls="ai-model-popover"');
    expect(page).toContain('class="ai-model-picker-icon"');
    expect(page).toContain('id="ai-model-popover" class="ai-model-popover hidden" role="dialog"');
    expect(page).toContain('<label id="ai-model-popover-title" for="ai-model">实际使用模型</label>');
    expect(page).toContain('<select id="ai-model" class="ai-model-native-select" aria-label="实际使用模型">');
    expect(page).toContain('id="ai-model-options" class="ai-model-options" role="listbox"');
    expect(page).toContain('id="ai-attachment-button" class="ai-attachment-button hidden"');
    expect(page).toContain('id="ai-attachment-input" class="ai-attachment-input" type="file"');
    expect(page).toContain("feature=ai-model-picker-v1");
    expect(page).toContain("feature=ai-fork-model-unlock-v1");
    expect(page).toContain("feature=ai-model-thinking-label-v3");
    expect(page).toContain("feature=ai-model-picker-focus-v1");

    expect(application).toContain("function selectedAiModelLabel()");
    expect(application).toContain("function aiConversationModelLocked()");
    expect(application).toContain("aiConversationHasImages");
    expect(application).toContain("hasImageAttachments");
    expect(application).toContain("modelLockedByImage");
    expect(application).toContain("function syncAiModelPicker()");
    expect(application).toContain("const modelLocked = aiConversationModelLocked();");
    expect(application).toContain('button.setAttribute("aria-label", label);');
    expect(application).toContain('button.disabled = interactionBusy;');
    expect(application).toContain("function setAiModelPickerVisible(visible)");
    expect(application).toContain('popover.classList.toggle("hidden", !visible);');
    expect(application).toContain('$("#ai-model-picker").addEventListener("click", async (event) => {');
    expect(application).toContain("if (notifyAiConversationModelLocked(button)) return;");
    expect(application).toContain("setAiContextDistributionVisible(false);");
    expect(application).toContain("setAiModelPickerVisible(willOpen);");
    expect(application).toContain('!event.target.closest("#ai-model-picker") && !event.target.closest("#ai-model-popover")');
    expect(application).toContain('if (!$("#ai-model-popover").classList.contains("hidden")) {');
    expect(application).toContain("syncAiModelPicker();");
    expect(application).toContain("function renderAiModelOptions()");
    expect(application).toContain("modelThinkingEffortLabel(model)");
    expect(application).toContain('.join(" · ")');
    expect(application).toContain("setAiContextMeter(null);\n  setAiModelPickerVisible(false);\n  syncAiModelPicker();");
    expect(application).toContain("model.multimodalEnabled === true");
    expect(application).toContain("aiModelImageIconMarkup()");
    expect(application).toContain("function syncAiImageAttachmentControl()");

    expect(styles).toContain(".ai-model-picker { display: grid; flex: 0 0 32px;");
    expect(styles).toContain(".ai-model-picker-icon { width: 18px; height: 18px;");
    expect(styles).toContain(".ai-model-popover { position: absolute; right: 0;");
    expect(styles).toContain(".ai-model-popover::after { position: absolute; right: 49px;");
    expect(styles).toContain(".ai-model-popover.hidden { display: none; }");
    expect(styles).toContain(".ai-model-options { display: grid;");
    expect(styles).toContain(".ai-model-option-image-icon");
    expect(styles).toContain(".prompt-composer-leading { position: absolute; bottom: 8px; left: 8px;");
  });
});
