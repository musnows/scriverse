import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("AI 角色扮演界面", () => {
  it("允许为当前对话选择角色卡并展示受限记忆模式", async () => {
    const publicPath = join(process.cwd(), "src", "public");
    const [application, page, styles] = await Promise.all([
      readFile(join(publicPath, "app.js"), "utf8"),
      readFile(join(publicPath, "index.html"), "utf8"),
      readFile(join(publicPath, "styles.css"), "utf8")
    ]);

    expect(page).toContain('<option value="roleplay">角色扮演</option>');
    expect(page).toContain('id="ai-roleplay-character" class="ai-roleplay-character hidden"');
    expect(page).toContain('id="ai-roleplay-user-character" class="ai-roleplay-character ai-roleplay-user-character hidden"');
    expect(page).toContain("选择角色卡");
    expect(page).toContain("选择我的角色（可选）");
    expect(page).toContain("feature=ai-relationship-roleplay-v1");
    expect(page).toContain("feature=ai-roleplay-story-recall-v1");
    expect(application).toContain("function roleplayCharacterOptionLabel(character)");
    expect(application).toContain('const favoriteLabel = character?.isFavorite === true ? "[已收藏] " : "";');
    expect(application).toContain("输入对 ${String(state.aiRoleplayCharacter.name)} 说的台词或行动……");
    expect(application).toContain("以 ${String(state.aiRoleplayUserCharacter.name)} 的身份输入台词或行动……");
    expect(application).toContain("/roleplay`");
    expect(application).toContain("function renderAiRoleplayUserCharacterSelect()");
    expect(application).toContain("const relationshipRoleplaySelectable = roleplaySelected\n    && Boolean(state.aiRoleplayCharacter)\n    && (!state.aiPromptSent || Boolean(state.aiRoleplayUserCharacter));");
    expect(application).toContain('body: { characterId: characterId || null, userCharacterId: userCharacterId || null }');
    expect(application).toContain('tab.roleplayUserCharacter = conversation.roleplayUserCharacter ?? null;');
    expect(application).toContain('return roleplayUserCharacter?.name || "作者";');
    expect(application).toContain("会话选项在会话开始后不支持修改，若需要修改，请新建会话");
    expect(application).toContain('$("#ai-task").disabled = interactionBusy;');
    expect(application).toContain('$("#ai-scope").disabled = interactionBusy || roleplaySelected;');
    expect(application).toContain("function syncAiModelPicker()");
    expect(application).toContain('select.disabled = interactionBusy;');
    expect(application).toContain("select.addEventListener(\"pointerdown\", blockLockedAiConversationOptionInteraction);");
    expect(application).toContain("select.addEventListener(\"keydown\", blockLockedAiConversationOptionKeydown);");
    expect(application).toContain("if (state.aiPromptSent) {");
    expect(application).toContain("return toast(aiConversationOptionLockedMessage);");
    expect(application).toContain("角色扮演模式可以查询角色记忆、相识角色、知情设定、故事正文和设定图片");
    expect(page).toContain("&feature=ai-roleplay-user-character-visibility-v1");
    expect(application).toContain("主输入是该角色的台词或行动；旁白请写在场景框");
    expect(application).toContain("/task-type`");
    expect(application).toContain("/context-scope`");
    expect(application).toContain("if (state.aiPromptSent) {");
    expect(application).toContain("state.aiContextScope ?? { type: \"none\" }");
    expect(application).toContain('await prepareAiRequestConversation(requestHolder, selectedTaskType, requestScope.conversationScope);');
    expect(application).toContain("mergeAiReferenceScope(conversationScope, state.aiReferences)");
    expect(application).toContain("Agent 可以查询角色记忆、相识角色、知情设定、故事正文和设定图片");
    expect(application).toContain("recall_self: \"回忆自身\"");
    expect(application).toContain("recall_relationship: \"回忆人物关系\"");
    expect(application).toContain("recall_other: \"回忆相识角色\"");
    expect(application).toContain("recall_known: \"回忆知情设定\"");
    expect(application).toContain("recall_story: \"回忆故事\"");
    expect(application).toContain("image: \"读取设定图片\"");
    expect(page).toContain("feature=ai-roleplay-knowledge-tools-v1");
    expect(application).toContain("function syncAiTaskOptions()");
    expect(application).toContain('const taskType = roleplaySelected ? "chat" : selectedTaskType;');
    expect(application).toContain('message.querySelector(".message-heading > span").textContent = aiAssistantLabel("", tab.roleplayCharacter);');
    expect(page).toContain("feature=ai-roleplay-speaker-label-v1");
    expect(styles).toContain(".prompt-options .ai-roleplay-character { min-width: 0; }");
    expect(styles).toContain(".prompt-options .ai-roleplay-user-character { grid-column: 1 / -1; }");
    expect(styles).toContain(".ai-panel.is-roleplaying .ai-roleplay-character");
    expect(page).toContain('id="ai-scene-button" class="ai-scene-button hidden"');
    expect(page).toContain('id="ai-scene-panel" class="ai-scene-panel hidden"');
    expect(page).toContain('id="ai-scene-direction"');
    expect(page).toContain("feature=ai-roleplay-scene-turn-v1");
    expect(application).toContain("/roleplay-turn.js?v=20260823-ai-roleplay-scene-turn-v1");
    expect(application).toContain("function syncAiSceneComposer()");
    expect(application).toContain("function toggleAiScenePanel()");
    expect(application).toContain("sceneDirection");
    expect(application).toContain("user-message-scene");
    expect(styles).toContain(".prompt-composer-leading { position: absolute; bottom: 8px; left: 8px;");
    expect(styles).toContain(".ai-scene-panel { display: grid;");
    expect(styles).toContain(".ai-scene-pin-fields { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));");
    expect(styles).toContain(".ai-scene-pin-fields { grid-template-columns: minmax(0, 1fr); }");
    expect(styles).toContain(".user-message-scene { margin: 0 0 8px;");
  });
});
