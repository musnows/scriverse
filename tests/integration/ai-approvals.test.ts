import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Database } from "../../src/database.js";
import { Store } from "../../src/store.js";
import { UserAuthService } from "../../src/user-auth.js";
import { AiApprovalService } from "../../src/ai-approvals.js";
import { AI_WRITE_TOOLS, aiWritePlanMaxOperations, type AiPlanOperation } from "../../src/ai-approval-contract.js";
import { runWithRequestActor, type RequestActor } from "../../src/request-context.js";
import { fullWorkModulePermissions } from "../../src/work-permissions.js";

describe("persistent AI operation approvals", () => {
  let db: Database;
  let store: Store;
  let approvals: AiApprovalService;
  let auth: UserAuthService;
  let actor: RequestActor;
  let workId: string;
  let conversationId: string;
  let chapterId: string;
  let characterId: string;
  let secondCharacterId: string;
  const asActor = <T>(callback: () => T): T => runWithRequestActor(actor, callback);
  const plan = (operations: AiPlanOperation[]): Record<string, unknown> => asActor(() => approvals.propose(workId, conversationId, { summary: "AI summary is not the diff", operations }));
  const confirm = (approval: Record<string, unknown>): Record<string, unknown> => asActor(() => approvals.confirm(workId, String(approval.id)));
  const setting = (title = "Moon rule"): AiPlanOperation => ({ kind: "create", entity: "setting", fields: { title, category: "Rule", content: "Before approval" } });

  beforeEach(() => {
    db = new Database(":memory:");
    store = new Store(db);
    auth = new UserAuthService(db);
    actor = { ...auth.register({ username: "approval-owner", password: "Approval-owner-password1" }).session.user, authentication: "session" };
    approvals = new AiApprovalService(store, { describe: (_workId, operation) => ({ id: operation.modelId, name: "Confirmed model" }), create: (targetWorkId, operation) => store.createTask(targetWorkId, operation) });
    asActor(() => {
      workId = String(store.createWork({ title: "Approval work" }).id);
      const volumeId = String(store.createVolume(workId, { title: "Volume" }).id);
      chapterId = String(store.createChapter(workId, { volumeId, title: "Chapter", content: "Line one\nLine two\nLine three" }).id);
      characterId = String(store.createCharacter(workId, { name: "Alice" }).id);
      secondCharacterId = String(store.createCharacter(workId, { name: "Bob" }).id);
      conversationId = String(store.createAiConversation(workId, "Approval conversation", "chat").id);
      approvals.updateSettings(workId, { enabled: [...AI_WRITE_TOOLS] });
    });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); db.close(); });

  it("defaults all tools off and rejects invalid environment limits", () => {
    const other = asActor(() => store.createWork({ title: "Default settings" }));
    expect(approvals.getSettings(String(other.id)).enabled).toEqual([]);
    expect(aiWritePlanMaxOperations(undefined)).toBe(5);
    expect(aiWritePlanMaxOperations("20")).toBe(20);
    for (const value of ["0", "21", "100", "NaN", "5.5", "", "-1"]) expect(() => aiWritePlanMaxOperations(value)).toThrow();
    expect(() => plan(Array.from({ length: 6 }, (_, index) => setting(`Rule ${index}`)))).toThrow("最多包含 5");
  });

  it("persists immutable system diffs without writing domain entities before confirmation", () => {
    const record = asActor(() => store.createSetting(workId, { title: "Existing", category: "Rule", content: "Database truth" }));
    const proposed = plan([{ kind: "edit", entity: "setting", targetId: String(record.id), fields: { content: "Actual replacement" } }]);
    expect(store.getSetting(String(record.id)).content).toBe("Database truth");
    expect(proposed.operations).toMatchObject([{ targetVersion: record.versionNo, changes: [{ field: "content", before: "Database truth", after: "Actual replacement", diff: "- Database truth\n+ Actual replacement" }] }]);
    expect(() => db.run("UPDATE ai_operation_approvals SET content_json = '{}' WHERE id = ?", String(proposed.id))).toThrow("immutable");
    const restoredService = new AiApprovalService(store);
    expect(asActor(() => restoredService.get(workId, String(proposed.id))).status).toBe("pending");
    expect(confirm(proposed).status).toBe("succeeded");
    expect(store.getSetting(String(record.id)).content).toBe("Actual replacement");
  });

  it.each(["setting", "character", "character-section", "race", "organization", "timeline-track", "timeline-event", "relationship", "chapter-outline", "foreshadow"] as const)("creates and edits %s using existing versions", (entity) => {
    const fields = entity === "setting" ? { title: "New setting", category: "Rule", content: "Content" }
      : entity === "relationship" ? { fromCharacterId: characterId, toCharacterId: secondCharacterId, category: "social" }
      : entity === "chapter-outline" ? { goal: "Find the moon" }
      : entity === "foreshadow" || entity === "character-section" ? { title: "New entry" } : { name: "New entry" };
    const targetId = entity === "chapter-outline" ? chapterId : entity === "character-section" ? characterId : undefined;
    const created = confirm(plan([{ kind: "create", entity, fields, ...(targetId ? { targetId } : {}) }]));
    expect(created.status).toBe("succeeded");
    const results = created.result as { operations: Array<{ targetId: string; versionNo: number }> };
    expect(results.operations[0]?.versionNo).toBe(1);
    const editFields = entity === "setting" ? { content: "Edited" } : entity === "relationship" ? { subtype: "Old friend" } : entity === "chapter-outline" ? { goal: "Find the sun" } : entity === "character-section" || entity === "foreshadow" ? { title: "Edited title" } : { name: "Edited name" };
    const edited = confirm(plan([{ kind: "edit", entity, targetId: results.operations[0]!.targetId, fields: editFields }]));
    expect(edited.status).toBe("succeeded");
    expect(edited.result).toMatchObject({ operations: [{ versionNo: 2, actorId: actor.userId }] });
  });

  it("creates mixed plans atomically and never changes chapter content or placement", () => {
    const chapter = store.getChapter(chapterId);
    const proposed = plan([setting(), { kind: "annotation", chapterId, annotationType: "note", startLine: 2, endLine: 2, note: "Comment" }, { kind: "annotation", chapterId, annotationType: "todo", startLine: 1, endLine: 2, note: "Todo" }]);
    expect(store.listChapterAnnotations(chapterId)).toHaveLength(0);
    expect(proposed.operations).toMatchObject([{}, { changes: expect.arrayContaining([{ field: "quote", label: "引用正文", before: null, after: "Line two", diff: "+ Line two" }]) }, {}]);
    expect(confirm(proposed).status).toBe("succeeded");
    expect(store.listChapterAnnotations(chapterId)).toHaveLength(2);
    expect(store.getChapter(chapterId)).toEqual(chapter);
    expect(confirm(proposed).status).toBe("succeeded");
    expect(store.listChapterAnnotations(chapterId)).toHaveLength(2);
    expect(store.listSettings(workId)).toHaveLength(1);
  });

  it("rolls back every domain write and version when a later operation fails", () => {
    const before = db.all("SELECT * FROM entity_versions");
    const proposed = plan([setting(), { kind: "create", entity: "character", fields: { name: "Alice" } }]);
    expect(confirm(proposed).status).toBe("invalid");
    expect(store.listSettings(workId)).toHaveLength(0);
    expect(db.all("SELECT * FROM entity_versions")).toEqual(before);
    expect(confirm(proposed).status).toBe("invalid");
  });

  it("invalidates changed target versions and switched-off tools", () => {
    const proposed = plan([{ kind: "annotation", chapterId, annotationType: "note", startLine: 1, endLine: 1, note: "Comment" }]);
    asActor(() => store.saveChapter(chapterId, { content: "Changed text" }));
    expect(confirm(proposed)).toMatchObject({ status: "invalid", reason: expect.stringContaining("版本") });
    expect(store.listChapterAnnotations(chapterId)).toHaveLength(0);
    const next = plan([setting()]);
    asActor(() => approvals.updateSettings(workId, { enabled: [] }));
    expect(confirm(next)).toMatchObject({ status: "invalid", reason: expect.stringContaining("工具设置") });
  });

  it("expires and rejects plans without executing them", () => {
    const proposed = plan([setting()]);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
    expect(confirm(proposed).status).toBe("expired");
    vi.useRealTimers();
    const rejected = plan([setting()]);
    expect(asActor(() => approvals.reject(workId, String(rejected.id))).status).toBe("rejected");
    expect(confirm(rejected).status).toBe("rejected");
    expect(store.listSettings(workId)).toHaveLength(0);
  });

  it("requires a real single answer and persists it across service reconstruction", () => {
    expect(() => asActor(() => approvals.ask(workId, conversationId, { question: "Pick?", options: ["Only"] }))).toThrow();
    const question = asActor(() => approvals.ask(workId, conversationId, { question: "What next?", options: ["Recommended", "Alternative"] }));
    expect(() => plan([setting()])).toThrow("提问");
    expect(() => asActor(() => approvals.answer(workId, String(question.id), { answer: ["Recommended", "Alternative"] }))).toThrow();
    expect(asActor(() => approvals.answer(workId, String(question.id), { answer: "Custom answer" })).result).toMatchObject({ answer: "Custom answer", answeredBy: actor.userId });
    expect(asActor(() => new AiApprovalService(store).conversationState(workId, conversationId))).toMatchObject([{ result: { answer: "Custom answer" } }]);
    expect(confirm(plan([setting()])).status).toBe("succeeded");
  });

  it("cannot fabricate an answer after rejection", () => {
    const question = asActor(() => approvals.ask(workId, conversationId, { question: "What next?", options: ["Recommended", "Alternative"] }));
    asActor(() => approvals.reject(workId, String(question.id)));
    expect(asActor(() => approvals.answer(workId, String(question.id), { answer: "Forged" }))).toMatchObject({ status: "rejected", result: null });
    expect(() => plan([setting()])).toThrow("提问");
  });

  it("intersects initiator and conversation owner permissions and hides revoked content", () => {
    const owner = actor;
    const collaborator = auth.register({ username: "approval-collaborator", password: "Collaborator-password1" }).session.user;
    const modules = fullWorkModulePermissions();
    modules.settings = "read";
    db.run("INSERT INTO work_memberships (work_id, user_id, role, permissions_json, created_at) VALUES (?, ?, 'editor', ?, ?)", workId, collaborator.userId, JSON.stringify({ modules }), new Date().toISOString());
    actor = { ...collaborator, authentication: "session" };
    expect(() => plan([setting()])).toThrow("写入权限");
    const collaboratorConversation = asActor(() => store.createAiConversation(workId, "Collaborator", "chat"));
    actor = owner;
    const originalConversation = conversationId;
    conversationId = String(collaboratorConversation.id);
    expect(() => plan([setting()])).toThrow("写入权限");
    conversationId = originalConversation;
    const approved = plan([setting()]);
    db.run("UPDATE works SET owner_user_id = ? WHERE id = ?", collaborator.userId, workId);
    db.run("UPDATE work_memberships SET role = 'editor', permissions_json = ? WHERE work_id = ? AND user_id = ?", JSON.stringify({ modules: { ...fullWorkModulePermissions(), settings: "none" } }), workId, owner.userId);
    expect(confirm(approved)).toMatchObject({ status: "invalid", redacted: true });
  });

  it("rejects cross-work identifiers and unsupported deletion or chapter edits", () => {
    const other = asActor(() => store.createWork({ title: "Private work" }));
    const foreign = asActor(() => store.createSetting(String(other.id), { title: "Secret", category: "Rule", content: "Unauthorized" }));
    expect(() => plan([{ kind: "edit", entity: "setting", targetId: String(foreign.id), fields: { content: "Overwrite" } }])).toThrow("不属于");
    for (const operations of [[{ kind: "delete", entity: "setting", targetId: foreign.id }], [{ kind: "edit", entity: "chapter", targetId: chapterId, fields: { content: "Overwrite" } }]]) {
      expect(() => asActor(() => approvals.propose(workId, conversationId, { summary: "Skip all confirmation", operations }))).toThrow();
    }
    expect(store.getSetting(String(foreign.id)).content).toBe("Unauthorized");
    expect(() => approvals.propose(workId, conversationId, { summary: "No login", operations: [setting()] })).toThrow("会话");
  });

  it("creates a separately confirmed undo and refuses later target versions", () => {
    const existing = asActor(() => store.createSetting(workId, { title: "Existing", category: "Rule", content: "Original" }));
    const original = confirm(plan([{ kind: "edit", entity: "setting", targetId: String(existing.id), fields: { content: "Updated" } }, setting("Keep this new entry")]));
    const undo = asActor(() => approvals.requestUndo(workId, String(original.id)));
    expect(undo.status).toBe("pending");
    expect(store.getSetting(String(existing.id)).content).toBe("Updated");
    expect(confirm(undo).status).toBe("succeeded");
    expect(store.getSetting(String(existing.id))).toMatchObject({ content: "Original", versionNo: 3 });
    expect(store.listSettings(workId)).toHaveLength(2);
    const second = confirm(plan([{ kind: "edit", entity: "setting", targetId: String(existing.id), fields: { content: "Again" } }]));
    asActor(() => store.updateSetting(String(existing.id), { content: "Newer" }));
    expect(() => asActor(() => approvals.requestUndo(workId, String(second.id)))).toThrow("后续版本");
  });

  it("leaves database integrity and foreign keys intact", () => {
    expect(db.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("never persists credentials, active session tokens or system prompt material in plans or answers", () => {
    const csrf = String(db.get("SELECT csrf_token FROM user_sessions LIMIT 1")!.csrf_token);
    asActor(() => store.updateWorkAiSettings(workId, { systemPrompt: "Confidential system instructions for this work" }));
    for (const secret of ["sk-do-not-disclose-this-model-key", csrf, "Confidential system instructions for this work"]) {
      expect(() => asActor(() => approvals.propose(workId, conversationId, { summary: secret, operations: [setting()] }))).toThrow("未保存");
      expect(db.all("SELECT * FROM ai_operation_approvals")).toHaveLength(0);
    }
    const question = asActor(() => approvals.ask(workId, conversationId, { question: "Choose?", options: ["First", "Second"] }));
    expect(() => asActor(() => approvals.answer(workId, String(question.id), { answer: csrf }))).toThrow("未保存");
    expect(asActor(() => approvals.get(workId, String(question.id)))).toMatchObject({ status: "pending", result: null });
  });

  it("restores the original race of transferred members when undoing an approved race edit", () => {
    const originalRace = asActor(() => store.createRace(workId, { name: "Original race", memberIds: [characterId] }));
    const newRace = asActor(() => store.createRace(workId, { name: "New race" }));
    const approved = confirm(plan([{ kind: "edit", entity: "race", targetId: String(newRace.id), fields: { memberIds: [characterId] } }]));
    expect(approved.status).toBe("succeeded");
    expect(store.getCharacter(characterId)).toMatchObject({ raceId: newRace.id, species: "New race" });
    const undo = asActor(() => approvals.requestUndo(workId, String(approved.id)));
    expect(undo.operations).toMatchObject([{ effects: [{ targetId: characterId, changes: expect.arrayContaining([expect.objectContaining({ field: "raceId", before: newRace.id, after: originalRace.id })]) }] }]);
    expect(confirm(undo).status).toBe("succeeded");
    expect(store.getCharacter(characterId)).toMatchObject({ raceId: originalRace.id, species: "Original race" });
    expect(store.getRace(String(newRace.id)).memberIds).toEqual([]);
    expect(store.getRace(String(originalRace.id)).memberIds).toEqual([characterId]);
  });

  it("requires the character tool for cascade writes and rejects overlapping character effects", () => {
    const race = asActor(() => store.createRace(workId, { name: "Race", memberIds: [characterId] }));
    expect(() => plan([{ kind: "edit", entity: "race", targetId: String(race.id), fields: { name: "Renamed" } }, { kind: "edit", entity: "character", targetId: characterId, fields: { name: "Renamed Alice" } }])).toThrow("重复修改");
    asActor(() => approvals.updateSettings(workId, { enabled: ["races"] }));
    expect(() => plan([{ kind: "edit", entity: "race", targetId: String(race.id), fields: { name: "Renamed" } }])).toThrow("角色工具");
  });

  it("previews canonical relationship endpoints and knowledge sections exactly as they are stored", () => {
    const [fromCharacterId, toCharacterId] = [characterId, secondCharacterId].sort((a, b) => b.localeCompare(a));
    const proposed = plan([{ kind: "create", entity: "relationship", fields: { fromCharacterId, toCharacterId, category: "social", keywords: [" Friend ", "FRIEND"] } }, { kind: "create", entity: "race", fields: { name: "Detailed race", settingsSections: [{ title: "Origin", contentMarkdown: "History", summary: " Summary " }] } }]);
    expect(proposed.operations).toMatchObject([{ changes: expect.arrayContaining([expect.objectContaining({ field: "fromCharacterId", after: toCharacterId }), expect.objectContaining({ field: "keywords", after: ["FRIEND"] })]) }, { changes: expect.arrayContaining([expect.objectContaining({ field: "settingsSections", after: [{ title: "Origin", contentMarkdown: "History", summary: "Summary", sortOrder: 0 }] })]) }]);
    expect(confirm(proposed).status).toBe("succeeded");
  });

  it("rolls back unexpected normalization and rechecks actual switches even without a revision bump", () => {
    const proposed = plan([setting()]);
    const create = store.createSetting.bind(store);
    vi.spyOn(store, "createSetting").mockImplementation((targetWorkId, input) => create(targetWorkId, { ...input, content: "Unexpected mutation" }));
    expect(confirm(proposed)).toMatchObject({ status: "invalid", reason: expect.stringContaining("整份计划已回滚") });
    expect(store.listSettings(workId)).toHaveLength(0);
    vi.restoreAllMocks();
    const next = plan([setting()]);
    db.run("UPDATE ai_write_tool_settings SET enabled_json = '[]' WHERE work_id = ?", workId);
    expect(confirm(next).status).toBe("invalid");
  });
});
