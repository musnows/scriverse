import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "./errors.js";
import type { WorkPermissionModule } from "./work-permissions.js";

export const AI_WRITE_TOOLS = ["settings", "characters", "races", "organizations", "timeline", "relationships", "outlines", "annotations", "analysis", "AskUserQuestions"] as const;
export type AiWriteTool = typeof AI_WRITE_TOOLS[number];
export const AI_APPROVAL_STATUSES = ["pending", "rejected", "expired", "invalid", "executing", "succeeded", "failed"] as const;
export type AiApprovalStatus = typeof AI_APPROVAL_STATUSES[number];
export const AI_APPROVAL_ENTITIES = ["setting", "character", "character-section", "race", "organization", "timeline-track", "timeline-event", "relationship", "chapter-outline", "foreshadow"] as const;
export type AiApprovalEntity = typeof AI_APPROVAL_ENTITIES[number];
export const AI_ANALYSIS_TYPES = ["structure", "chapter-analysis", "character-extraction", "character-summary", "character-identity-audit", "timeline-analysis", "worldview-analysis", "setting-extraction", "consistency-check", "report-update", "book-analysis", "relationship-analysis"] as const;

const identifier = z.string().trim().min(1).max(160).regex(/^[a-zA-Z0-9_-]+$/u);
const text = z.string().max(50_000);
const name = z.string().trim().min(1).max(300).transform((value) => value.normalize("NFKC").replace(/\s+/gu, " "));
const strings = z.array(z.string().max(2000)).max(100);
const ids = z.array(identifier).max(100).refine((value) => new Set(value).size === value.length);
const object = z.record(z.string().max(100), z.unknown()).refine((value) => JSON.stringify(value).length <= 50_000);
const section = z.object({ title: name, contentMarkdown: text.optional(), summary: z.string().max(5000).optional(), sortOrder: z.number().int().min(0).max(10000).optional() }).strict();
export const approvalEntitySchemas = {
  setting: z.object({ title: name, category: name, content: text, tags: strings.optional(), status: z.enum(["draft", "pending", "confirmed", "deprecated"]).optional(), locked: z.boolean().optional(), authorNote: text.optional() }).strict(),
  character: z.object({ name, code: z.string().trim().max(100).optional(), aliases: z.array(name).max(100).optional(), isDead: z.boolean().optional(), raceId: identifier.nullable().optional(), organizationIds: ids.optional(), attributes: object.optional(), profile: object.optional(), currentState: object.optional(), lockedFields: strings.optional(), firstChapterId: identifier.nullable().optional() }).strict(),
  "character-section": z.object({ title: name, sectionType: z.enum(["overview", "appearance", "abilities", "personality", "ecology", "background", "history", "legends", "research", "notes", "custom"]).optional(), contentMarkdown: text.optional(), summary: z.string().max(5000).optional(), sortOrder: z.number().int().min(0).max(10000).optional() }).strict(),
  race: z.object({ name, isExtinct: z.boolean().optional(), parentRaceId: identifier.nullable().optional(), description: text.optional(), settingsSections: z.array(section).max(100).optional(), memberIds: ids.optional() }).strict(),
  organization: z.object({ name, isDissolved: z.boolean().optional(), description: text.optional(), settingsSections: z.array(section).max(100).optional(), memberIds: ids.optional() }).strict(),
  "timeline-track": z.object({ name, description: text.optional(), sortOrder: z.number().int().min(0).max(10000).optional() }).strict(),
  "timeline-event": z.object({ name, trackId: identifier.nullable().optional(), description: text.optional(), eventType: z.string().max(100).optional(), timeLabel: z.string().max(1000).optional(), timeSort: z.number().finite().nullable().optional(), chapterIds: ids.optional(), participantIds: ids.optional(), location: z.string().max(2000).optional(), causes: strings.optional(), impactScope: z.enum(["personal", "organization", "regional", "world", "galaxy"]).optional(), status: z.enum(["candidate", "pending", "confirmed", "deprecated"]).optional() }).strict(),
  relationship: z.object({ fromCharacterId: identifier, toCharacterId: identifier, category: z.enum(["family", "social", "emotional", "conflict", "uncertain"]), subtype: z.string().max(100).optional(), keywords: strings.optional(), directed: z.boolean().optional(), currentStatus: z.string().max(100).optional(), timeRange: object.optional(), confidence: z.number().min(0).max(1).optional(), confirmationStatus: z.enum(["pending", "confirmed", "rejected"]).optional(), locked: z.boolean().optional() }).strict(),
  "chapter-outline": z.object({ goal: text.optional(), conflict: text.optional(), turningPoint: text.optional(), notes: text.optional(), status: z.enum(["draft", "ready", "completed"]).optional() }).strict(),
  foreshadow: z.object({ title: name, description: text.optional(), status: z.enum(["planned", "planted", "resolved", "abandoned"]).optional(), importance: z.enum(["low", "medium", "high"]).optional(), plannedPayoffChapterId: identifier.nullable().optional(), resolutionNote: text.optional() }).strict()
};

export const analysisScopeSchema = z.object({
  type: z.enum(["none", "chapter", "volume", "book", "settings"]),
  chapterId: identifier.optional(), volumeId: identifier.optional(),
  characterIds: ids.optional(), includeAllSettings: z.boolean().optional(),
  additionalPrompt: z.string().trim().max(10_000).optional(),
  preFilterRelationshipSources: z.boolean().optional(),
  previewRelationshipChanges: z.literal(true).optional()
}).strict().superRefine((scope, ctx) => {
  if (scope.type === "chapter" && !scope.chapterId) ctx.addIssue({ code: "custom", message: "Chapter scope requires chapterId" });
  if (scope.type === "volume" && !scope.volumeId) ctx.addIssue({ code: "custom", message: "Volume scope requires volumeId" });
  if (scope.type !== "chapter" && scope.chapterId) ctx.addIssue({ code: "custom", message: "Unexpected chapterId" });
  if (scope.type !== "volume" && scope.volumeId) ctx.addIssue({ code: "custom", message: "Unexpected volumeId" });
});
const entityOperationSchema = z.object({ kind: z.enum(["create", "edit"]), entity: z.enum(AI_APPROVAL_ENTITIES), targetId: identifier.optional(), fields: object }).strict();
const annotationOperationSchema = z.object({ kind: z.literal("annotation"), chapterId: identifier, annotationType: z.enum(["note", "todo"]), startLine: z.number().int().min(1).max(100000), endLine: z.number().int().min(1).max(100000), note: z.string().trim().min(1).max(10000) }).strict().refine((value) => value.endLine >= value.startLine && value.endLine - value.startLine < 20);
export const analysisOperationSchema = z.object({ kind: z.literal("analysis"), taskType: z.enum(AI_ANALYSIS_TYPES), modelId: identifier, scope: analysisScopeSchema }).strict().superRefine((operation, ctx) => {
  if (operation.taskType === "relationship-analysis") {
    if (!["chapter", "book", "settings"].includes(operation.scope.type)) ctx.addIssue({ code: "custom", message: "Invalid relationship analysis scope" });
    if (operation.scope.includeAllSettings && operation.scope.type !== "book") ctx.addIssue({ code: "custom", message: "All settings require book scope" });
    if (operation.scope.preFilterRelationshipSources !== undefined && !operation.scope.characterIds?.length) ctx.addIssue({ code: "custom", message: "Source filter requires characters" });
  } else if (["characterIds", "includeAllSettings", "additionalPrompt", "preFilterRelationshipSources", "previewRelationshipChanges"].some((key) => key in operation.scope)) {
    ctx.addIssue({ code: "custom", message: "Relationship options are only available for relationship analysis" });
  }
});
export const writePlanSchema = z.object({ summary: z.string().trim().min(1).max(1000), operations: z.array(z.union([entityOperationSchema, annotationOperationSchema, analysisOperationSchema])).min(1).max(20) }).strict();
export const askUserQuestionSchema = z.object({ question: z.string().trim().min(1).max(2000), options: z.array(z.string().trim().min(1).max(500)).min(2).max(8).refine((values) => new Set(values).size === values.length) }).strict();
export type AiPlanOperation = z.infer<typeof writePlanSchema>["operations"][number];
export type AiEntityOperation = z.infer<typeof entityOperationSchema>;
export type AiAnalysisOperation = z.infer<typeof analysisOperationSchema>;
export type AiUserQuestion = z.infer<typeof askUserQuestionSchema>;

export function aiWritePlanMaxOperations(value = process.env.AI_WRITE_PLAN_MAX_OPERATIONS): number {
  if (value === undefined) return 5;
  if (!/^(?:[1-9]|1[0-9]|20)$/u.test(value)) throw new AppError(500, "AI_WRITE_PLAN_LIMIT_INVALID", "AI_WRITE_PLAN_MAX_OPERATIONS 必须是 1–20 的整数");
  return Number(value);
}

export const entityModules: Record<AiApprovalEntity, WorkPermissionModule> = {
  setting: "settings", character: "characters", "character-section": "characters", race: "races", organization: "organizations", "timeline-track": "timeline", "timeline-event": "timeline", relationship: "relationships", "chapter-outline": "outlines", foreshadow: "outlines"
};
export const approvalFieldLabels: Record<string, string> = {
  title: "标题", name: "名称", category: "分类", content: "内容", tags: "标签", status: "状态", locked: "锁定", authorNote: "作者备注", code: "代号", aliases: "别名", isDead: "已死亡", raceId: "种族", species: "种族名称", organizationIds: "组织", attributes: "属性", profile: "档案", currentState: "当前状态", lockedFields: "锁定字段", firstChapterId: "首次出场章节", sectionType: "档案类型", contentMarkdown: "正文", summary: "摘要", sortOrder: "排序", isExtinct: "已灭绝", parentRaceId: "父种族", description: "描述", settingsSections: "设定章节", memberIds: "成员", isDissolved: "已解散", trackId: "时间线", eventType: "事件类型", timeLabel: "时间标记", timeSort: "时间排序", chapterIds: "相关章节", participantIds: "参与角色", location: "地点", causes: "原因", impactScope: "影响范围", fromCharacterId: "起点角色", toCharacterId: "终点角色", subtype: "关系细类", keywords: "关键词", directed: "有向关系", currentStatus: "当前状态", timeRange: "时间范围", confidence: "置信度", confirmationStatus: "确认状态", goal: "目标", conflict: "冲突", turningPoint: "转折", notes: "备注", importance: "重要程度", plannedPayoffChapterId: "计划回收章节", resolutionNote: "回收说明", note: "批注内容", annotationType: "批注类型", quote: "引用正文", startLine: "起始行", endLine: "结束行", taskType: "任务类型", modelId: "模型", scope: "分析范围"
};

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}
export function approvalDigest(value: unknown): string { return createHash("sha256").update(stableJson(value)).digest("hex"); }
export type AiFieldChange = { field: string; label: string; before: unknown; after: unknown; diff: string };
export function approvalChanges(before: Record<string, unknown> | null, after: Record<string, unknown>): AiFieldChange[] {
  return Object.entries(after).filter(([field, value]) => !before || stableJson(before[field]) !== stableJson(value)).map(([field, value]) => {
    const oldValue = before?.[field] ?? null;
    const display = (item: unknown): string => typeof item === "string" ? item : JSON.stringify(item, null, 2);
    const removed = before ? display(oldValue).split("\n").map((line) => `- ${line}`) : [];
    return { field, label: approvalFieldLabels[field] ?? field, before: oldValue, after: value, diff: [...removed, ...display(value).split("\n").map((line) => `+ ${line}`)].join("\n") };
  });
}
export function parseApprovalInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError(400, "AI_APPROVAL_INPUT_INVALID", "操作计划参数无效，请检查操作类型、字段、数量和范围");
  return parsed.data;
}
