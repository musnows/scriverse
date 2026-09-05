import { z } from "zod";
import { AppError } from "./errors.js";
import { currentRequestActor } from "./request-context.js";
import type { Store } from "./store.js";
import { id, now } from "./utils.js";
import { analysisTaskReadModules } from "./user-auth.js";
import { fullWorkModulePermissions, storedWorkModulePermissions, workPermissionModuleLabels, type WorkModulePermissions, type WorkPermissionModule } from "./work-permissions.js";
import {
  AI_WRITE_TOOLS, aiWritePlanMaxOperations, approvalChanges, approvalDigest, approvalEntitySchemas,
  askUserQuestionSchema, entityModules, parseApprovalInput, stableJson, writePlanSchema,
  type AiAnalysisOperation, type AiApprovalEntity, type AiApprovalStatus, type AiEntityOperation,
  type AiFieldChange, type AiPlanOperation, type AiUserQuestion, type AiWriteTool
} from "./ai-approval-contract.js";

type Guard = { entity: AiApprovalEntity | "chapter" | "volume"; id: string; version: number; digest: string };
type PreparedOperation = {
  input: AiPlanOperation; module: WorkPermissionModule; targetId: string | null; targetName: string; targetVersion: number;
  read: WorkPermissionModule[]; write: WorkPermissionModule[]; guards: Guard[]; changes: AiFieldChange[];
  effects: Array<{ module: WorkPermissionModule; targetId: string; targetName: string; changes: AiFieldChange[] }>;
  restoreFields?: Record<string, unknown>; model?: Record<string, unknown>; sourceDigest?: string;
};
type ApprovalContent = {
  version: 1; workId: string; workTitle: string; conversationId: string; initiatedBy: string; conversationOwner: string;
  workOwner: string; createdAt: string; summary: string; toolRevision: number; permissions: Record<string, WorkModulePermissions>;
  operations: PreparedOperation[]; question?: AiUserQuestion; questions: Array<{ id: string; digest: string }>;
};
type ApprovalRow = Record<string, unknown> & {
  id: string; work_id: string; conversation_id: string; initiated_by_user_id: string; conversation_owner_user_id: string;
  kind: "plan" | "question" | "undo"; status: AiApprovalStatus; content_json: string; content_hash: string;
  result_json: string | null; reason: string; created_at: string; expires_at: string; updated_at: string; executed_by_user_id: string | null;
};
export type ApprovalTaskAdapter = {
  describe(workId: string, operation: AiAnalysisOperation): Record<string, unknown>;
  create(workId: string, operation: AiAnalysisOperation): Record<string, unknown>;
};

const toolSettingsSchema = z.object({ enabled: z.array(z.enum(AI_WRITE_TOOLS)).max(AI_WRITE_TOOLS.length).refine((items) => new Set(items).size === items.length) }).strict();
const fieldRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const valueIds = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

export class AiApprovalService {
  readonly maxOperations: number;
  constructor(private readonly store: Store, private readonly tasks?: ApprovalTaskAdapter, private readonly sensitiveValues?: () => string[]) {
    this.maxOperations = aiWritePlanMaxOperations();
  }

  private assertSafeContent(workId: string, value: unknown): void {
    const serialized = JSON.stringify(value);
    if (serialized.length > 1_500_000) throw new AppError(400, "AI_APPROVAL_CONTENT_TOO_LARGE", "完整修改详情过大，请缩小计划范围");
    const secrets = [
      ...this.store.db.all("SELECT csrf_token FROM user_sessions WHERE revoked_at IS NULL").map((row) => String(row.csrf_token)),
      String(this.store.getPlatformAiSettings().systemPrompt ?? ""),
      String(this.store.getWorkAiSettings(workId).systemPrompt ?? ""),
      "你是小说作者的创作协作助手。作者锁定的事实是不可违反的硬约束。",
      ...(this.sensitiveValues?.() ?? [])
    ].flatMap((secret) => [secret, ...secret.split("\n")]).filter((secret) => secret.trim().length >= 12);
    if (/\bsk-[A-Za-z0-9_-]{12,}|\bBearer\s+[A-Za-z0-9._~-]{12,}|-----BEGIN[^-]*PRIVATE KEY-----/u.test(serialized)
      || secrets.some((secret) => serialized.includes(JSON.stringify(secret).slice(1, -1)))) {
      throw new AppError(400, "AI_APPROVAL_SENSITIVE_CONTENT", "计划或回答包含凭据、会话信息或系统提示词，未保存该内容");
    }
  }

  private actorId(): string {
    const actor = currentRequestActor();
    if (!actor || actor.authentication === "api-key") throw new AppError(401, "AI_APPROVAL_SESSION_REQUIRED", "AI 操作审批需要登录后的用户会话");
    return actor.userId;
  }

  private permissions(workId: string, userId: string): WorkModulePermissions {
    const user = this.store.db.get("SELECT status FROM users WHERE id = ?", userId);
    const work = this.store.db.get("SELECT owner_user_id FROM works WHERE id = ?", workId);
    if (user?.status !== "active" || !work) throw new AppError(403, "AI_APPROVAL_ACCESS_CHANGED", "用户或作品已不可访问");
    if (work.owner_user_id === userId) return fullWorkModulePermissions();
    const membership = this.store.db.get("SELECT role, permissions_json FROM work_memberships WHERE work_id = ? AND user_id = ?", workId, userId);
    if (!membership) throw new AppError(403, "AI_APPROVAL_ACCESS_CHANGED", "用户已失去作品访问权限");
    return storedWorkModulePermissions(String(membership.role), membership.permissions_json);
  }

  private requireModules(permissions: WorkModulePermissions, read: WorkPermissionModule[], write: WorkPermissionModule[]): void {
    for (const module of read) if (permissions[module] === "none") throw new AppError(403, "AI_APPROVAL_PERMISSION_CHANGED", `缺少${workPermissionModuleLabels[module]}读取权限`);
    for (const module of write) if (permissions[module] !== "write") throw new AppError(403, "AI_APPROVAL_PERMISSION_CHANGED", `缺少${workPermissionModuleLabels[module]}写入权限`);
  }

  private context(workId: string, conversationId: string): { actorId: string; ownerId: string; permissions: Record<string, WorkModulePermissions> } {
    const actorId = this.actorId();
    const conversation = this.store.db.get("SELECT work_id, created_by_user_id, task_type, roleplay_character_id FROM ai_conversations WHERE id = ?", conversationId);
    if (!conversation || conversation.work_id !== workId || !conversation.created_by_user_id || conversation.roleplay_character_id || conversation.task_type !== "chat") throw new AppError(403, "AI_APPROVAL_CONVERSATION_INVALID", "审批仅支持当前作品的普通 AI 对话");
    const ownerId = String(conversation.created_by_user_id);
    const permissions = Object.fromEntries([...new Set([actorId, ownerId])].map((userId) => [userId, this.permissions(workId, userId)]));
    for (const value of Object.values(permissions)) this.requireModules(value, [], ["ai-chat"]);
    return { actorId, ownerId, permissions };
  }

  getSettings(workId: string): { enabled: AiWriteTool[]; revision: number; maxOperations: number } {
    const row = this.store.db.get("SELECT enabled_json, revision FROM ai_write_tool_settings WHERE work_id = ?", workId);
    const stored: unknown = row ? JSON.parse(String(row.enabled_json)) : [];
    return { enabled: AI_WRITE_TOOLS.filter((tool) => Array.isArray(stored) && stored.includes(tool)), revision: Number(row?.revision ?? 0), maxOperations: this.maxOperations };
  }

  updateSettings(workId: string, value: unknown): ReturnType<AiApprovalService["getSettings"]> {
    const actorId = this.actorId();
    this.requireModules(this.permissions(workId, actorId), [], ["ai-settings"]);
    const input = parseApprovalInput(toolSettingsSchema, value);
    return this.store.db.transaction(() => {
      this.store.db.run(`INSERT INTO ai_write_tool_settings (work_id, enabled_json, revision, updated_at, updated_by_user_id) VALUES (?, ?, 1, ?, ?)
        ON CONFLICT(work_id) DO UPDATE SET enabled_json = excluded.enabled_json, revision = revision + 1, updated_at = excluded.updated_at, updated_by_user_id = excluded.updated_by_user_id`, workId, JSON.stringify(input.enabled), now(), actorId);
      this.store.audit(workId, "ai.write-tools.updated", "work-ai-settings", workId, { enabled: input.enabled });
      return this.getSettings(workId);
    });
  }

  availableTools(workId: string, conversationId?: string): AiWriteTool[] {
    if (!conversationId) return [];
    try {
      const context = this.context(workId, conversationId);
      return this.getSettings(workId).enabled.filter((tool) => Object.values(context.permissions).every((permissions) => {
        const module = tool === "annotations" ? "prose" : tool === "analysis" ? "ai-analysis" : tool === "AskUserQuestions" ? "ai-chat" : tool;
        return permissions[module] === "write";
      }));
    } catch { return []; }
  }

  private snapshot(entity: Guard["entity"], entityId: string): Record<string, unknown> {
    if (entity === "chapter") return this.store.getChapter(entityId);
    if (entity === "volume") return this.store.getVolume(entityId);
    if (entity === "setting") return this.store.getSetting(entityId);
    if (entity === "character") return this.store.getCharacter(entityId);
    if (entity === "character-section") return this.store.getCharacterProfileSection(entityId);
    if (entity === "race") return this.store.getRace(entityId);
    if (entity === "organization") return this.store.getOrganization(entityId);
    if (entity === "timeline-track") return this.store.getTimelineTrack(entityId);
    if (entity === "timeline-event") return this.store.getTimelineEvent(entityId);
    if (entity === "relationship") return this.store.getRelationship(entityId);
    if (entity === "chapter-outline") return this.store.getChapterOutline(entityId) ?? { workId: this.store.getChapter(entityId).workId, versionNo: 0 };
    return this.store.getForeshadow(entityId);
  }

  private guard(entity: Guard["entity"], entityId: string, workId: string): Guard {
    const snapshot = this.snapshot(entity, entityId);
    if (snapshot.workId !== workId) throw new AppError(400, "AI_APPROVAL_TARGET_INVALID", "操作对象不属于当前作品");
    const fields = entity === "chapter" ? ["title", "content", "volumeId", "sortOrder", "chapterType"]
      : entity === "volume" ? ["title", "sortOrder"] : Object.keys(approvalEntitySchemas[entity].shape);
    return { entity, id: entityId, version: Number(snapshot.versionNo ?? 0), digest: approvalDigest(Object.fromEntries(fields.map((field) => [field, snapshot[field] ?? null]))) };
  }

  private questions(conversationId: string): Array<{ id: string; digest: string }> {
    const rows = this.store.db.all<ApprovalRow>("SELECT * FROM ai_operation_approvals WHERE conversation_id = ? AND kind = 'question' ORDER BY created_at, id", conversationId);
    for (const row of rows) if (row.status !== "succeeded" || !row.result_json) throw new AppError(409, "AI_QUESTION_UNANSWERED", "本对话仍有未回答、已拒绝或失效的提问，不能据此创建或执行写入计划");
    return rows.map((row) => ({ id: row.id, digest: approvalDigest(row.result_json) }));
  }

  private prepare(workId: string, input: AiPlanOperation, permissions: Record<string, WorkModulePermissions>): PreparedOperation {
    const module = input.kind === "annotation" ? "prose" : input.kind === "analysis" ? "ai-analysis" : entityModules[input.entity];
    const tool: AiWriteTool = input.kind === "annotation" ? "annotations" : input.kind === "analysis" ? "analysis" : module as AiWriteTool;
    if (!this.getSettings(workId).enabled.includes(tool)) throw new AppError(409, "AI_APPROVAL_TOOL_DISABLED", "该操作的 AI 工具已关闭");
    const read = new Set<WorkPermissionModule>([module]);
    const write = new Set<WorkPermissionModule>([module]);
    const authorize = (): void => { for (const value of Object.values(permissions)) this.requireModules(value, [...read], [...write]); };
    authorize();
    const guards: Guard[] = [];
    const effects: PreparedOperation["effects"] = [];
    const reference = (entity: Guard["entity"], entityId: unknown, writeAccess = false): Record<string, unknown> | null => {
      if (typeof entityId !== "string" || !entityId) return null;
      const referenceModule = entity === "chapter" || entity === "volume" ? "prose" : entityModules[entity];
      read.add(referenceModule);
      if (writeAccess) write.add(referenceModule);
      authorize();
      guards.push(this.guard(entity, entityId, workId));
      return this.snapshot(entity, entityId);
    };
    if (input.kind === "annotation") {
      const chapter = reference("chapter", input.chapterId)!;
      const lines = String(chapter.content).replace(/\r\n?/gu, "\n").split("\n");
      if (input.endLine > lines.length) throw new AppError(400, "AI_APPROVAL_TARGET_INVALID", "批注行号超出当前正文范围");
      return { input, module, targetId: input.chapterId, targetName: String(chapter.title), targetVersion: Number(chapter.versionNo), read: [...read], write: [...write], guards, effects,
        changes: approvalChanges(null, { annotationType: input.annotationType === "todo" ? "待办" : "评论", quote: lines.slice(input.startLine - 1, input.endLine).join("\n"), startLine: input.startLine, endLine: input.endLine, note: input.note }) };
    }
    if (input.kind === "analysis") {
      for (const required of analysisTaskReadModules(input.taskType, input.scope)) read.add(required);
      authorize();
      reference("chapter", input.scope.chapterId);
      reference("volume", input.scope.volumeId);
      for (const characterId of input.scope.characterIds ?? []) reference("character", characterId);
      if (!this.tasks) throw new AppError(409, "AI_APPROVAL_MODEL_INVALID", "分析任务模型不可用");
      const operation = input.taskType === "relationship-analysis" ? { ...input, scope: { ...input.scope, previewRelationshipChanges: true as const } } : input;
      const model = this.tasks.describe(workId, operation);
      return { input: operation, module, targetId: null, targetName: String(this.store.getWork(workId).title), targetVersion: 0, read: [...read], write: [...write], guards, effects, model,
        sourceDigest: this.sourceDigest(workId, [...read]), changes: approvalChanges(null, { taskType: input.taskType, modelId: model, scope: operation.scope }) };
    }
    const isCreate = input.kind === "create";
    const schema = approvalEntitySchemas[input.entity];
    const fields = parseApprovalInput<Record<string, unknown>>(isCreate ? schema : schema.partial(), input.fields);
    if (!Object.keys(fields).length) throw new AppError(400, "AI_APPROVAL_INPUT_INVALID", "修改字段不能为空");
    const parentTarget = input.entity === "chapter-outline" || input.entity === "character-section";
    if ((!isCreate || parentTarget) && !input.targetId) throw new AppError(400, "AI_APPROVAL_TARGET_INVALID", "必须指定操作对象");
    if (isCreate && !parentTarget && input.targetId) throw new AppError(400, "AI_APPROVAL_TARGET_INVALID", "新增词条不能指定已有对象标识");
    let current: Record<string, unknown> | null = null;
    if (!isCreate) {
      guards.push(this.guard(input.entity, input.targetId!, workId));
      current = this.snapshot(input.entity, input.targetId!);
      if (!Number(current.versionNo)) throw new AppError(409, "AI_APPROVAL_TARGET_INVALID", "目标词条不存在");
    } else if (input.entity === "chapter-outline") {
      reference("chapter", input.targetId);
      guards.push(this.guard("chapter-outline", input.targetId!, workId));
      if (Number(this.snapshot("chapter-outline", input.targetId!).versionNo)) throw new AppError(409, "AI_APPROVAL_TARGET_INVALID", "章节大纲已经存在，请使用编辑操作");
    } else if (input.entity === "character-section") reference("character", input.targetId);
    if (input.entity === "character" && isCreate && fields.raceId === undefined) fields.raceId = null;
    reference("race", fields.raceId, true);
    reference("race", fields.parentRaceId);
    reference("chapter", fields.firstChapterId);
    reference("chapter", fields.plannedPayoffChapterId);
    reference("timeline-track", fields.trackId);
    reference("character", fields.fromCharacterId ?? current?.fromCharacterId);
    reference("character", fields.toCharacterId ?? current?.toCharacterId);
    for (const entityId of valueIds(fields.organizationIds)) reference("organization", entityId, true);
    for (const entityId of valueIds(fields.chapterIds)) reference("chapter", entityId);
    for (const entityId of valueIds(fields.participantIds)) reference("character", entityId);
    if (input.entity === "character" && ("raceId" in input.fields || "organizationIds" in fields)) {
      if ("raceId" in input.fields) { write.add("races"); reference("race", current?.raceId, true); }
      if ("organizationIds" in fields) { write.add("organizations"); for (const entityId of valueIds(current?.organizationIds)) reference("organization", entityId, true); }
    }
    if (input.entity === "race" || input.entity === "organization") {
      const currentMemberIds = valueIds(current?.memberIds);
      const membersChanged = "memberIds" in fields;
      const raceRenamed = input.entity === "race" && fields.name !== undefined && fields.name !== current?.name;
      if (membersChanged || raceRenamed) {
        const nextMemberIds = membersChanged ? valueIds(fields.memberIds) : currentMemberIds;
        for (const memberId of [...new Set([...currentMemberIds, ...nextMemberIds])]) {
          const character = reference("character", memberId, true)!;
          const included = nextMemberIds.includes(memberId);
          const changes = input.entity === "race"
            ? approvalChanges(character, { raceId: included ? input.targetId ?? "（新增种族）" : null, species: included ? fields.name ?? current?.name ?? "" : "" })
            : approvalChanges(character, { organizationIds: included ? [...new Set([...valueIds(character.organizationIds), input.targetId ?? "（新增组织）"])] : valueIds(character.organizationIds).filter((value) => value !== input.targetId) });
          if (changes.length) effects.push({ module: "characters", targetId: memberId, targetName: String(character.name), changes });
        }
      }
    }
    authorize();
    const operation = { ...input, fields };
    const changes = approvalChanges(current, fields);
    if (!isCreate && !changes.length) throw new AppError(400, "AI_APPROVAL_NO_CHANGES", "修改前后内容相同");
    const restoreFields = current ? Object.fromEntries(Object.keys(fields).map((field) => [field, current[field] ?? null])) : undefined;
    const relationshipName = input.entity === "relationship" ? `${this.store.getCharacter(String(fields.fromCharacterId ?? current?.fromCharacterId)).name} 与 ${this.store.getCharacter(String(fields.toCharacterId ?? current?.toCharacterId)).name}` : null;
    const targetName = String(fields.name ?? fields.title ?? current?.name ?? current?.title ?? current?.chapterTitle ?? relationshipName ?? (input.entity === "chapter-outline" ? this.store.getChapter(input.targetId!).title : "新增词条"));
    return { input: operation, module, targetId: input.targetId ?? null, targetName, targetVersion: Number(current?.versionNo ?? 0), read: [...read], write: [...write], guards, effects, changes, ...(restoreFields ? { restoreFields } : {}) };
  }

  private sourceDigest(workId: string, modules: WorkPermissionModule[]): string {
    const tables: Partial<Record<WorkPermissionModule, string[]>> = { prose: ["chapters", "volumes"], settings: ["settings"], characters: ["characters", "character_profile_sections"], races: ["races"], organizations: ["organizations"], timeline: ["timeline_tracks", "timeline_events"], relationships: ["relationships"], outlines: ["foreshadows"], reviews: ["review_items"] };
    return approvalDigest(modules.flatMap((module) => (tables[module] ?? []).map((table) => ({ table, rows: this.store.db.all(`SELECT * FROM ${table} WHERE work_id = ? ORDER BY id`, workId) }))));
  }

  propose(workId: string, conversationId: string, value: unknown, toolCallId?: string): Record<string, unknown> {
    const input = parseApprovalInput(writePlanSchema, value);
    if (input.operations.length > this.maxOperations) throw new AppError(400, "AI_APPROVAL_PLAN_TOO_LARGE", `每份计划最多包含 ${this.maxOperations} 项操作`);
    return this.create(workId, conversationId, "plan", input.summary, input.operations, undefined, toolCallId);
  }

  ask(workId: string, conversationId: string, value: unknown, toolCallId?: string): Record<string, unknown> {
    const input = parseApprovalInput(askUserQuestionSchema, value);
    return this.create(workId, conversationId, "question", input.question, [], input, toolCallId);
  }

  private create(workId: string, conversationId: string, kind: ApprovalRow["kind"], summary: string, inputs: AiPlanOperation[], question?: AiUserQuestion, toolCallId?: string, parentId?: string): Record<string, unknown> {
    return this.store.db.transaction(() => {
      const context = this.context(workId, conversationId);
      if (toolCallId) {
        const existing = this.store.db.get<ApprovalRow>("SELECT * FROM ai_operation_approvals WHERE conversation_id = ? AND tool_call_id = ?", conversationId, toolCallId);
        if (existing) return this.get(workId, existing.id);
      }
      const settings = this.getSettings(workId);
      if (question && !settings.enabled.includes("AskUserQuestions")) throw new AppError(409, "AI_APPROVAL_TOOL_DISABLED", "AskUserQuestions 工具已关闭");
      const questions = this.questions(conversationId);
      const operations = inputs.map((input) => this.prepare(workId, input, context.permissions));
      const targets = operations.filter((operation) => operation.input.kind === "edit" || operation.input.kind === "create" && operation.targetId).map((operation) => `${(operation.input as AiEntityOperation).entity}:${operation.targetId}`);
      if (new Set(targets).size !== targets.length) throw new AppError(400, "AI_APPROVAL_TARGET_REPEATED", "同一份计划不能重复修改同一词条");
      const timestamp = now();
      const work = this.store.db.get("SELECT title, owner_user_id FROM works WHERE id = ?", workId)!;
      const content: ApprovalContent = { version: 1, workId, workTitle: String(work.title), workOwner: String(work.owner_user_id), conversationId, initiatedBy: context.actorId, conversationOwner: context.ownerId, createdAt: timestamp, summary, toolRevision: settings.revision, permissions: context.permissions, operations, question, questions };
      this.assertSafeContent(workId, content);
      const approvalId = id("aiApproval");
      this.store.db.run(`INSERT INTO ai_operation_approvals (id, work_id, conversation_id, initiated_by_user_id, conversation_owner_user_id, kind, status, content_json, content_hash, parent_approval_id, tool_call_id, created_at, expires_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`, approvalId, workId, conversationId, context.actorId, context.ownerId, kind, JSON.stringify(content), approvalDigest(content), parentId ?? null, toolCallId ?? null, timestamp, new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), timestamp);
      this.store.audit(workId, "ai.approval.proposed", "ai-approval", approvalId, { kind, operationCount: operations.length });
      return this.get(workId, approvalId);
    });
  }

  private row(workId: string, approvalId: string): ApprovalRow {
    const actorId = this.actorId();
    this.requireModules(this.permissions(workId, actorId), ["ai-chat"], []);
    const row = this.store.db.get<ApprovalRow>("SELECT * FROM ai_operation_approvals WHERE id = ? AND work_id = ?", approvalId, workId);
    if (!row || ![row.initiated_by_user_id, row.conversation_owner_user_id].includes(actorId)) throw new AppError(404, "AI_APPROVAL_NOT_FOUND", "审批记录不存在或无权访问");
    return row;
  }

  private validate(row: ApprovalRow): void {
    const content = JSON.parse(row.content_json) as ApprovalContent;
    this.assertSafeContent(row.work_id, content);
    if (approvalDigest(content) !== row.content_hash) throw new AppError(409, "AI_APPROVAL_PLAN_CHANGED", "审批计划完整性校验失败");
    const context = this.context(row.work_id, row.conversation_id);
    if (context.ownerId !== content.conversationOwner) throw new AppError(409, "AI_APPROVAL_CONVERSATION_INVALID", "对话归属已发生变化");
    if (String(this.store.db.get("SELECT owner_user_id FROM works WHERE id = ?", row.work_id)?.owner_user_id) !== content.workOwner) throw new AppError(409, "AI_APPROVAL_ACCESS_CHANGED", "作品归属已发生变化");
    for (const [userId, original] of Object.entries(content.permissions)) {
      if (stableJson(this.permissions(row.work_id, userId)) !== stableJson(original)) throw new AppError(409, "AI_APPROVAL_PERMISSION_CHANGED", "发起用户或对话归属用户的作品权限已发生变化");
    }
    if (this.getSettings(row.work_id).revision !== content.toolRevision) throw new AppError(409, "AI_APPROVAL_TOOL_DISABLED", "作品 AI 工具设置已发生变化");
    if (row.kind !== "question" && stableJson(this.questions(row.conversation_id)) !== stableJson(content.questions)) throw new AppError(409, "AI_QUESTION_UNANSWERED", "提问交互状态已发生变化");
    for (const operation of content.operations) {
      for (const permissions of Object.values(context.permissions)) this.requireModules(permissions, operation.read, operation.write);
      for (const guard of operation.guards) {
        if (stableJson(this.guard(guard.entity, guard.id, row.work_id)) !== stableJson(guard)) throw new AppError(409, "AI_APPROVAL_VERSION_CHANGED", "目标词条、正文位置或关联资料版本已发生变化");
      }
      if (operation.input.kind === "analysis") {
        if (!this.tasks || stableJson(this.tasks.describe(row.work_id, operation.input)) !== stableJson(operation.model)) throw new AppError(409, "AI_APPROVAL_MODEL_INVALID", "分析模型已发生变化或不可用");
        if (this.sourceDigest(row.work_id, operation.read) !== operation.sourceDigest) throw new AppError(409, "AI_APPROVAL_VERSION_CHANGED", "分析范围内的资料已发生变化");
      }
    }
  }

  private reason(error: unknown): string {
    if (error instanceof AppError && /^(AI_APPROVAL_|AI_QUESTION_)/u.test(error.code)) return error.message;
    return "操作对象、版本、模型或输入校验失败，请重新生成计划";
  }

  private refresh(row: ApprovalRow): ApprovalRow {
    if (row.status !== "pending") return row;
    if (row.expires_at <= now()) this.transition(row.id, "expired", "审批已超过 24 小时有效期");
    else {
      try { this.validate(row); }
      catch (error) { this.transition(row.id, "invalid", this.reason(error)); }
    }
    return this.store.db.get<ApprovalRow>("SELECT * FROM ai_operation_approvals WHERE id = ?", row.id)!;
  }

  private transition(approvalId: string, status: AiApprovalStatus, reason = "", result?: unknown): void {
    this.store.db.run("UPDATE ai_operation_approvals SET status = ?, reason = ?, result_json = ?, updated_at = ?, executed_by_user_id = ? WHERE id = ? AND status IN ('pending', 'executing')", status, reason, result === undefined ? null : JSON.stringify(result), now(), currentRequestActor()?.userId ?? null, approvalId);
  }

  get(workId: string, approvalId: string): Record<string, unknown> {
    const row = this.refresh(this.row(workId, approvalId));
    const content = JSON.parse(row.content_json) as ApprovalContent;
    const userName = (userId: string | null): string => String(this.store.db.get("SELECT display_name FROM users WHERE id = ?", userId)?.display_name ?? userId ?? "系统");
    const base = { initiatedByName: userName(row.initiated_by_user_id), conversationOwnerName: userName(row.conversation_owner_user_id), executedByName: userName(row.executed_by_user_id), id: row.id, workId, conversationId: row.conversation_id, kind: row.kind, status: row.status, createdAt: row.created_at, expiresAt: row.expires_at, updatedAt: row.updated_at, reason: row.reason, initiatedBy: row.initiated_by_user_id, conversationOwner: row.conversation_owner_user_id, executedBy: row.executed_by_user_id, parentApprovalId: row.parent_approval_id ?? null };
    try {
      this.assertSafeContent(workId, content);
      if (row.result_json) this.assertSafeContent(workId, JSON.parse(row.result_json) as unknown);
      for (const userId of [...new Set([this.actorId(), row.conversation_owner_user_id])]) {
        const permissions = this.permissions(workId, userId);
        this.requireModules(permissions, ["ai-chat", ...content.operations.flatMap((operation) => [...operation.read, ...operation.write])], []);
      }
    } catch { return { ...base, redacted: true, summary: "当前权限不足，修改内容已隐藏", operations: [] }; }
    const result: unknown = row.result_json ? JSON.parse(row.result_json) : null;
    return { ...base, summary: content.summary, workTitle: content.workTitle, operations: content.operations.map(({ input, targetId, targetName, targetVersion, module, read, write, changes, effects, model }) => ({ kind: input.kind, entity: "entity" in input ? input.entity : input.kind, targetId, targetName, targetVersion, module, requiredRead: read, requiredWrite: write, changes, effects, model })), question: content.question, result, canUndo: row.status === "succeeded" && row.kind === "plan" && content.operations.some((operation) => operation.input.kind === "edit") && !this.store.db.get("SELECT 1 FROM ai_operation_approvals WHERE parent_approval_id = ?", row.id), audit: this.store.db.all("SELECT id, action, entity_type AS entityType, entity_id AS entityId, user_id AS actorId, created_at AS createdAt FROM audit_logs WHERE work_id = ? AND entity_type = 'ai-approval' AND entity_id = ? ORDER BY created_at, id", workId, approvalId) };
  }

  list(workId: string, offset = 0, limit = 30, status?: AiApprovalStatus): Record<string, unknown> {
    const actorId = this.actorId();
    this.requireModules(this.permissions(workId, actorId), ["ai-chat"], []);
    const rows = this.store.db.all<{ id: string }>("SELECT id FROM ai_operation_approvals WHERE work_id = ? AND (initiated_by_user_id = ? OR conversation_owner_user_id = ?) AND (? IS NULL OR status = ?) ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?", workId, actorId, actorId, status ?? null, status ?? null, limit, offset);
    const total = Number(this.store.db.get("SELECT COUNT(*) AS count FROM ai_operation_approvals WHERE work_id = ? AND (initiated_by_user_id = ? OR conversation_owner_user_id = ?) AND (? IS NULL OR status = ?)", workId, actorId, actorId, status ?? null, status ?? null)?.count ?? 0);
    return { items: rows.map((row) => this.get(workId, row.id)), total, offset, limit };
  }

  reject(workId: string, approvalId: string): Record<string, unknown> {
    return this.store.db.transaction(() => {
      const row = this.refresh(this.row(workId, approvalId));
      if (row.status === "pending") { this.transition(row.id, "rejected", "用户已拒绝"); this.store.audit(workId, "ai.approval.rejected", "ai-approval", row.id); }
      return this.get(workId, approvalId);
    });
  }

  answer(workId: string, approvalId: string, value: unknown): Record<string, unknown> {
    const answer = parseApprovalInput(z.object({ answer: z.string().trim().min(1).max(2000) }).strict(), value).answer;
    return this.store.db.transaction(() => {
      const row = this.refresh(this.row(workId, approvalId));
      if (row.kind !== "question") throw new AppError(400, "AI_APPROVAL_INPUT_INVALID", "该记录不是提问");
      if (row.status === "pending") {
        this.validate(row);
        this.assertSafeContent(workId, { answer });
        this.transition(row.id, "succeeded", "", { answer, answeredBy: this.actorId(), answeredAt: now() });
        this.store.audit(workId, "ai.question.answered", "ai-approval", row.id);
      }
      return this.get(workId, approvalId);
    });
  }

  confirm(workId: string, approvalId: string): Record<string, unknown> {
    const initial = this.row(workId, approvalId);
    if (initial.kind === "question") throw new AppError(400, "AI_APPROVAL_INPUT_INVALID", "提问必须由用户提供回答");
    try {
      this.store.db.transaction(() => {
        const row = this.refresh(this.row(workId, approvalId));
        if (row.status !== "pending") return;
        this.validate(row);
        this.transition(row.id, "executing");
        const content = JSON.parse(row.content_json) as ApprovalContent;
        const results = content.operations.map((operation, index) => {
          const result = this.execute(workId, operation, row.id);
          const resultId = String(result.id ?? result.chapterId);
          const entity = "entity" in operation.input ? operation.input.entity : operation.input.kind;
          const versionNo = Number(result.versionNo ?? 0);
          const effects = operation.effects.map((effect) => ({ targetId: effect.targetId, versionNo: Number(this.store.getCharacter(effect.targetId).versionNo) }));
          this.store.audit(workId, "ai.approval.operation-executed", "ai-approval", row.id, { index, entity, targetId: resultId, versionNo });
          return { index, entity, targetId: resultId, targetName: operation.targetName, versionNo, actorId: this.actorId(), effects };
        });
        this.transition(row.id, "succeeded", "", { operations: results, executedAt: now() });
        this.store.audit(workId, "ai.approval.succeeded", "ai-approval", row.id);
      });
    } catch (error) {
      this.store.db.transaction(() => {
        const row = this.row(workId, approvalId);
        if (row.status === "pending") {
          this.transition(row.id, error instanceof AppError && error.status < 500 ? "invalid" : "failed", this.reason(error));
          this.store.audit(workId, "ai.approval.failed", "ai-approval", row.id, { reason: this.reason(error) });
        }
      });
    }
    return this.get(workId, approvalId);
  }

  private execute(workId: string, operation: PreparedOperation, approvalId: string): Record<string, unknown> {
    const input = operation.input;
    if (input.kind === "annotation") return this.store.createChapterAnnotation(input.chapterId, { kind: input.annotationType, startLine: input.startLine, endLine: input.endLine, note: input.note });
    if (input.kind === "analysis") return this.tasks!.create(workId, input);
    const target = input.targetId!;
    const fields = input.fields;
    const args = ["ai-approval", approvalId, "用户确认 AI 修改计划", operation.targetVersion] as const;
    if (input.entity === "setting") return input.kind === "create" ? this.store.createSetting(workId, fields as Parameters<Store["createSetting"]>[1]) : this.store.updateSetting(target, fields, ...args);
    if (input.entity === "character") return input.kind === "create" ? this.store.createCharacter(workId, fields as Parameters<Store["createCharacter"]>[1]) : this.store.updateCharacter(target, fields, ...args);
    if (input.entity === "character-section") return input.kind === "create" ? this.store.createCharacterProfileSection(target, fields as Parameters<Store["createCharacterProfileSection"]>[1]) : this.store.updateCharacterProfileSection(target, fields, ...args);
    if (input.entity === "race") return input.kind === "create" ? this.store.createRace(workId, fields as Parameters<Store["createRace"]>[1]) : this.store.updateRace(target, fields, ...args);
    if (input.entity === "organization") return input.kind === "create" ? this.store.createOrganization(workId, fields as Parameters<Store["createOrganization"]>[1]) : this.store.updateOrganization(target, fields, ...args);
    if (input.entity === "timeline-track") return input.kind === "create" ? this.store.createTimelineTrack(workId, fields as Parameters<Store["createTimelineTrack"]>[1], args[0], approvalId) : this.store.updateTimelineTrack(target, fields, ...args);
    if (input.entity === "timeline-event") return input.kind === "create" ? this.store.createTimelineEvent(workId, fields as Parameters<Store["createTimelineEvent"]>[1], args[0], approvalId) : this.store.updateTimelineEvent(target, fields, ...args);
    if (input.entity === "relationship") return input.kind === "create" ? this.store.createRelationship(workId, fields as Parameters<Store["createRelationship"]>[1], args[0], approvalId) : this.store.updateRelationship(target, fields, ...args);
    if (input.entity === "chapter-outline") return this.store.upsertChapterOutline(target, fields, ...args);
    return input.kind === "create" ? this.store.createForeshadow(workId, fields as Parameters<Store["createForeshadow"]>[1]) : this.store.updateForeshadow(target, fields, ...args);
  }

  requestUndo(workId: string, approvalId: string): Record<string, unknown> {
    return this.store.db.transaction(() => {
      const row = this.row(workId, approvalId);
      if (row.status !== "succeeded" || row.kind !== "plan") throw new AppError(409, "AI_APPROVAL_UNDO_INVALID", "只有执行成功的修改计划可以申请撤销");
      const existing = this.store.db.get<{ id: string }>("SELECT id FROM ai_operation_approvals WHERE parent_approval_id = ?", approvalId);
      if (existing) return this.get(workId, existing.id);
      const content = JSON.parse(row.content_json) as ApprovalContent;
      const result = fieldRecord(JSON.parse(row.result_json!));
      const results = Array.isArray(result.operations) ? result.operations.map(fieldRecord) : [];
      const operations: AiPlanOperation[] = [];
      content.operations.forEach((operation, index) => {
        if (operation.input.kind !== "edit" || !operation.restoreFields) return;
        const target = this.snapshot(operation.input.entity, operation.input.targetId!);
        if (Number(target.versionNo) !== results[index]?.versionNo) throw new AppError(409, "AI_APPROVAL_UNDO_INVALID", "目标词条已有后续版本，不能撤销本次审批");
        for (const effect of Array.isArray(results[index]?.effects) ? results[index]!.effects as Array<{ targetId: string; versionNo: number }> : []) {
          if (Number(this.store.getCharacter(effect.targetId).versionNo) !== effect.versionNo) throw new AppError(409, "AI_APPROVAL_UNDO_INVALID", "关联角色已有后续版本，不能撤销本次审批");
        }
        operations.push({ ...operation.input, fields: operation.restoreFields });
      });
      if (!operations.length) throw new AppError(409, "AI_APPROVAL_UNDO_INVALID", "此审批没有可撤销的词条编辑；新增词条、批注和任务不会被删除");
      return this.create(workId, row.conversation_id, "undo", "撤销本次审批中的词条编辑；保留新增词条、正文批注和分析任务", operations, undefined, undefined, row.id);
    });
  }

  conversationState(workId: string, conversationId: string): Array<Record<string, unknown>> {
    this.context(workId, conversationId);
    const rows = this.store.db.all<{ id: string }>("SELECT id FROM ai_operation_approvals WHERE work_id = ? AND conversation_id = ? ORDER BY created_at DESC LIMIT 20", workId, conversationId);
    return rows.map((row) => {
      const approval = this.get(workId, row.id);
      return { id: approval.id, kind: approval.kind, status: approval.status, question: approval.question, result: approval.status === "succeeded" ? approval.result : null };
    });
  }
}
