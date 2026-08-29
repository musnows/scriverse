import { z } from "zod";
import type { Database } from "./database.js";
import type { Store } from "./store.js";
import { analysisTaskReadModules } from "./user-auth.js";
import { UserAuthService } from "./user-auth.js";
import { AppError } from "./errors.js";
import { logger } from "./logger.js";
import { id as randomId, json, now } from "./utils.js";
import {
  canReadWorkModule,
  canWriteWorkModule,
  emptyWorkModulePermissions,
  fullWorkModulePermissions,
  storedWorkModulePermissions,
  workPermissionModuleLabels,
  type WorkModuleAccess,
  type WorkModulePermissions
} from "./work-permissions.js";

/**
 * AI 可写工具与持久化审批工作流。
 *
 * 设计要点（与 issue 需求一一对应）：
 * - AI 永远只提交“修改计划”，确认接口只接收审批 ID；计划内容由系统根据当前数据库生成并固化。
 * - 所有可写操作在执行前重新校验双方权限、工具开关与目标版本，任何变化都会把计划标记为已失效。
 * - 单个计划的执行在一个数据库事务内完成，失败整体回滚，保证不产生半成品数据。
 */

// ---------------------------------------------------------------------------
// 工具开关常量
// ---------------------------------------------------------------------------

/** 可独立开关的 AI 写入类工具：与作品设置页的开关一一对应。 */
export const AI_WRITE_TOOL_IDS = [
  "settings",
  "characters",
  "races",
  "organizations",
  "timeline",
  "relationships",
  "outlines",
  "annotations",
  "analysis_tasks",
  "ask_user_questions"
] as const;

export type AiWriteToolId = (typeof AI_WRITE_TOOL_IDS)[number];

export const aiWriteToolLabels: Record<AiWriteToolId, string> = {
  settings: "世界设定",
  characters: "角色",
  races: "种族",
  organizations: "组织",
  timeline: "时间线",
  relationships: "人物关系",
  outlines: "大纲/伏笔",
  annotations: "正文评论与待办",
  analysis_tasks: "分析任务",
  ask_user_questions: "用户提问"
};

export const aiWriteToolDescriptions: Record<AiWriteToolId, string> = {
  settings: "允许侧边栏 AI 创建或编辑世界设定词条（不能删除）。",
  characters: "允许侧边栏 AI 创建或编辑角色条目（不能删除）。",
  races: "允许侧边栏 AI 创建或编辑种族设定（不能删除）。",
  organizations: "允许侧边栏 AI 创建或编辑组织设定（不能删除成员归属之外的内容，不能删除组织）。",
  timeline: "允许侧边栏 AI 创建或编辑时间轴轨道与事件（不能删除）。",
  relationships: "允许侧边栏 AI 创建或编辑人物关系（不能删除）。",
  outlines: "允许侧边栏 AI 编辑章节大纲以及创建或编辑伏笔（不能删除）。",
  annotations: "允许侧边栏 AI 复用现有批注能力，在正文指定位置创建评论或待办。",
  analysis_tasks: "允许侧边栏 AI 触发已有类型的分析任务进入现有队列。",
  ask_user_questions: "允许侧边栏 AI 通过 AskUserQuestions 向用户提出单选问题。"
};

/** 全部关闭时的默认开关状态。 */
export function defaultAiWriteToolToggles(): Record<AiWriteToolId, boolean> {
  return Object.fromEntries(AI_WRITE_TOOL_IDS.map((toolId) => [toolId, false])) as Record<AiWriteToolId, boolean>;
}

const aiWriteToolIdSchema = z.enum(AI_WRITE_TOOL_IDS);

/** 作品设置页提交的工具开关增量；未知工具 ID 由管理器在合并时拒绝。 */
export const aiWriteToolsUpdateSchema = z.object({
  tools: z.record(z.string(), z.boolean()).refine(
    (value) => Object.keys(value).length > 0,
    { message: "至少需要更新一个工具开关" }
  )
}).strict();

// ---------------------------------------------------------------------------
// 计划上限解析
// ---------------------------------------------------------------------------

export const DEFAULT_AI_WRITE_PLAN_MAX_OPERATIONS = 5;
export const MIN_AI_WRITE_PLAN_MAX_OPERATIONS = 1;
export const MAX_AI_WRITE_PLAN_MAX_OPERATIONS = 20;

/**
 * 解析环境变量 AI_WRITE_PLAN_MAX_OPERATIONS。
 * 默认 5，有效范围 1-20；超出范围或非法值时直接抛出错误阻止启动。
 */
export function resolveAiWritePlanMaxOperations(rawEnvironmentValue: unknown): number {
  const raw = rawEnvironmentValue === undefined || rawEnvironmentValue === null ? "" : String(rawEnvironmentValue).trim();
  if (!raw) return DEFAULT_AI_WRITE_PLAN_MAX_OPERATIONS;
  if (!/^\d+$/u.test(raw)) {
    throw new Error(`环境变量 AI_WRITE_PLAN_MAX_OPERATIONS 的值无效："${raw}"（必须为 1-20 的整数）`);
  }
  const parsed = Number(raw);
  if (parsed < MIN_AI_WRITE_PLAN_MAX_OPERATIONS || parsed > MAX_AI_WRITE_PLAN_MAX_OPERATIONS) {
    throw new Error(`环境变量 AI_WRITE_PLAN_MAX_OPERATIONS 的值 ${parsed} 超出有效范围（1-20）`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// 时间与有效期
// ---------------------------------------------------------------------------

/** 待确认计划的有效期：默认 24 小时。 */
export const AI_WRITE_PLAN_TTL_MS = 24 * 60 * 60 * 1000;
/** 用户提问的有效期：默认 10 分钟。 */
export const AI_USER_QUESTION_TTL_MS = 10 * 60 * 1000;

function isoFromNow(baseIso: string, ttlMs: number): string {
  const base = Date.parse(baseIso);
  return Number.isFinite(base) ? new Date(base + ttlMs).toISOString() : baseIso;
}

// ---------------------------------------------------------------------------
// 操作输入模式（字段白名单与既有路由 schema 对齐）
// ---------------------------------------------------------------------------

const identifierSchema = z.string().trim().min(1).max(200);
const jsonObjectSchema = z.record(z.string(), z.unknown());

/** 设定条目可写字段：锁定标记、审核状态等治理字段保留给人工。 */
const settingInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(100),
  content: z.string().trim().min(1).max(200_000),
  tags: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  authorNote: z.string().max(20_000).optional()
}).strict();

/** 角色可写字段：合并、锁定字段、首次出场章节保留给人工。 */
const characterInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  isDead: z.boolean().optional(),
  code: z.string().trim().max(200).optional(),
  aliases: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  raceId: identifierSchema.nullable().optional(),
  organizationIds: z.array(identifierSchema).max(100).optional(),
  attributes: jsonObjectSchema.optional(),
  profile: jsonObjectSchema.optional(),
  currentState: jsonObjectSchema.optional()
}).strict();

/** 种族可写字段：成员归属与分节设定结构保留给人工。 */
const raceInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  isExtinct: z.boolean().optional(),
  parentRaceId: identifierSchema.nullable().optional(),
  description: z.string().max(100_000).optional(),
  settingsMarkdown: z.string().max(200_000).optional()
}).strict();

/** 组织可写字段：与种族一致，但不含父子层级。 */
const organizationInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  isDissolved: z.boolean().optional(),
  description: z.string().max(100_000).optional(),
  settingsMarkdown: z.string().max(200_000).optional()
}).strict();

const timelineTrackInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(20_000).optional(),
  sortOrder: z.number().int().min(0).max(100_000).optional()
}).strict();

const timelineEventInputSchema = z.object({
  name: z.string().trim().min(1).max(300),
  trackId: identifierSchema.nullable().optional(),
  description: z.string().max(100_000).optional(),
  eventType: z.string().max(100).optional(),
  timeLabel: z.string().max(300).optional(),
  timeSort: z.number().finite().nullable().optional(),
  chapterIds: z.array(identifierSchema).max(100).optional(),
  participantIds: z.array(identifierSchema).max(200).optional(),
  location: z.string().max(500).optional(),
  causes: z.array(z.string().trim().min(1).max(200)).max(30).optional(),
  impactScope: z.enum(["personal", "organization", "regional", "world", "galaxy"]).optional(),
  status: z.enum(["candidate", "pending", "confirmed", "deprecated"]).optional()
}).strict();

/**
 * 人物关系：分类必须是既有枚举；update 不允许改端点人物，
 * 避免 AI 借机重接关系指向其他作品的人物。
 */
const relationshipCreateInputSchema = z.object({
  fromCharacterId: identifierSchema,
  toCharacterId: identifierSchema,
  category: z.enum(["family", "social", "emotional", "conflict", "uncertain"]),
  subtype: z.string().max(100).optional(),
  keywords: z.array(z.string().trim().min(1).max(100)).max(30).optional(),
  directed: z.boolean().optional(),
  currentStatus: z.string().max(100).optional(),
  timeRange: jsonObjectSchema.optional(),
  confidence: z.number().min(0).max(1).optional()
}).strict().refine((input) => input.fromCharacterId !== input.toCharacterId, {
  message: "人物关系不能指向自身"
});

const relationshipUpdateInputSchema = z.object({
  category: z.enum(["family", "social", "emotional", "conflict", "uncertain"]).optional(),
  subtype: z.string().max(100).optional(),
  keywords: z.array(z.string().trim().min(1).max(100)).max(30).optional(),
  directed: z.boolean().optional(),
  currentStatus: z.string().max(100).optional(),
  timeRange: jsonObjectSchema.optional(),
  confidence: z.number().min(0).max(1).optional()
}).strict().refine((input) => Object.keys(input).length > 0, {
  message: "至少需要提供一个修改字段"
});

const chapterOutlineInputSchema = z.object({
  goal: z.string().max(100_000).optional(),
  conflict: z.string().max(100_000).optional(),
  turningPoint: z.string().max(100_000).optional(),
  notes: z.string().max(100_000).optional(),
  status: z.enum(["draft", "ready", "completed"]).optional()
}).strict();

const foreshadowInputSchema = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(100_000).optional(),
  status: z.enum(["planned", "planted", "resolved", "abandoned"]).optional(),
  importance: z.enum(["low", "medium", "high"]).optional(),
  plannedPayoffChapterId: identifierSchema.nullable().optional(),
  resolutionNote: z.string().max(100_000).optional()
}).strict();

/** 词条实体类型：用于 create_entry / update_entry。 */
export const AI_ENTRY_ENTITY_TYPES = [
  "setting",
  "character",
  "race",
  "organization",
  "timeline-track",
  "timeline-event",
  "relationship",
  "chapter-outline",
  "foreshadow"
] as const;

export type AiEntryEntityType = (typeof AI_ENTRY_ENTITY_TYPES)[number];

const entryEntityTypeSchema = z.enum(AI_ENTRY_ENTITY_TYPES);

const entryEntitySchemas = {
  setting: settingInputSchema,
  character: characterInputSchema,
  race: raceInputSchema,
  organization: organizationInputSchema,
  "timeline-track": timelineTrackInputSchema,
  "timeline-event": timelineEventInputSchema,
  relationship: relationshipCreateInputSchema,
  "chapter-outline": chapterOutlineInputSchema,
  foreshadow: foreshadowInputSchema
} as const;

/** 编辑操作：所有实体类型都使用 partial 形态，且必须包含至少一个修改字段。 */
const entryEntityUpdateSchemas = {
  setting: settingInputSchema.partial().refine(hasAtLeastOneField, { message: "至少需要提供一个修改字段" }),
  character: characterInputSchema.partial().refine(hasAtLeastOneField, { message: "至少需要提供一个修改字段" }),
  race: raceInputSchema.partial().refine(hasAtLeastOneField, { message: "至少需要提供一个修改字段" }),
  organization: organizationInputSchema.partial().refine(hasAtLeastOneField, { message: "至少需要提供一个修改字段" }),
  "timeline-track": timelineTrackInputSchema.partial().refine(hasAtLeastOneField, { message: "至少需要提供一个修改字段" }),
  "timeline-event": timelineEventInputSchema.partial().refine(hasAtLeastOneField, { message: "至少需要提供一个修改字段" }),
  relationship: relationshipUpdateInputSchema,
  "chapter-outline": chapterOutlineInputSchema.partial().refine(hasAtLeastOneField, { message: "至少需要提供一个修改字段" }),
  foreshadow: foreshadowInputSchema.partial().refine(hasAtLeastOneField, { message: "至少需要提供一个修改字段" })
} as const;

function toolInputJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(schema, {
    target: "draft-07",
    unrepresentable: "any",
    io: "input"
  }) as Record<string, unknown>;
  return jsonSchema;
}

/**
 * 为模型生成与服务端严格校验一致的操作 schema。
 *
 * 每个操作类型和实体类型都使用独立分支，避免通用对象把 entityId、scope 等
 * 仅属于其他操作的字段错误地暴露给 create_entry。
 */
export function aiWritePlanOperationToolSchemas(
  toggles: Readonly<Record<AiWriteToolId, boolean>>
): Record<string, unknown>[] {
  const entityTypes: AiEntryEntityType[] = [
    ...(toggles.settings ? ["setting" as const] : []),
    ...(toggles.characters ? ["character" as const] : []),
    ...(toggles.races ? ["race" as const] : []),
    ...(toggles.organizations ? ["organization" as const] : []),
    ...(toggles.timeline ? ["timeline-track" as const, "timeline-event" as const] : []),
    ...(toggles.relationships ? ["relationship" as const] : []),
    ...(toggles.outlines ? ["chapter-outline" as const, "foreshadow" as const] : [])
  ];
  const identifierJsonSchema = { type: "string", minLength: 1, maxLength: 200 };
  const operations: Record<string, unknown>[] = entityTypes.flatMap((entityType) => {
    const targetProperty = entityType === "chapter-outline"
      ? { chapterId: identifierJsonSchema }
      : { entityId: identifierJsonSchema };
    const targetName = entityType === "chapter-outline" ? "chapterId" : "entityId";
    return [
      {
        type: "object",
        description: `新建 ${entityType}；系统会生成对象 ID，不得传 entityId。`,
        properties: {
          opType: { type: "string", enum: ["create_entry"] },
          entityType: { type: "string", enum: [entityType] },
          ...(entityType === "chapter-outline" ? { chapterId: identifierJsonSchema } : {}),
          input: toolInputJsonSchema(entryEntitySchemas[entityType])
        },
        required: ["opType", "entityType", ...(entityType === "chapter-outline" ? ["chapterId"] : []), "input"],
        additionalProperties: false
      },
      {
        type: "object",
        description: `编辑已有 ${entityType}；${targetName} 必须来自读取工具返回的真实对象。`,
        properties: {
          opType: { type: "string", enum: ["update_entry"] },
          entityType: { type: "string", enum: [entityType] },
          ...targetProperty,
          input: toolInputJsonSchema(entryEntityUpdateSchemas[entityType])
        },
        required: ["opType", "entityType", targetName, "input"],
        additionalProperties: false
      }
    ];
  });
  if (toggles.annotations) {
    operations.push({
      type: "object",
      description: "在已有章节的行区间创建评论或待办。",
      properties: {
        opType: { type: "string", enum: ["create_annotation"] },
        chapterId: identifierJsonSchema,
        kind: { type: "string", enum: ["note", "todo"] },
        startLine: { type: "integer", minimum: 1 },
        endLine: { type: "integer", minimum: 1 },
        note: { type: "string", minLength: 1, maxLength: 2000 }
      },
      required: ["opType", "chapterId", "kind", "startLine", "endLine", "note"],
      additionalProperties: false
    });
  }
  if (toggles.analysis_tasks) {
    operations.push({
      type: "object",
      description: "使用当前已固化模型和范围创建分析任务。",
      properties: {
        opType: { type: "string", enum: ["create_task"] },
        taskType: { type: "string", enum: [...AI_ANALYSIS_TASK_TYPES, "relationship-analysis"] },
        scope: { type: "object" },
        modelId: identifierJsonSchema
      },
      required: ["opType", "taskType"],
      additionalProperties: false
    });
  }
  return operations;
}

function hasAtLeastOneField(value: Record<string, unknown>): boolean {
  return Object.keys(value).length > 0;
}

/** 分析任务类型：镜像 src/app.ts 的 analysisTaskTypeSchema。 */
export const AI_ANALYSIS_TASK_TYPES = [
  "structure",
  "chapter-analysis",
  "character-extraction",
  "character-summary",
  "character-identity-audit",
  "timeline-analysis",
  "worldview-analysis",
  "setting-extraction",
  "consistency-check",
  "report-update",
  "book-analysis"
] as const;

export type AiAnalysisTaskType = (typeof AI_ANALYSIS_TASK_TYPES)[number];

export const aiAnalysisTaskTypeLabels: Record<string, string> = {
  structure: "结构分析",
  "chapter-analysis": "章节分析",
  "character-extraction": "角色抽取",
  "character-summary": "角色小结",
  "character-identity-audit": "身份一致性审计",
  "timeline-analysis": "时间线分析",
  "worldview-analysis": "世界观分析",
  "setting-extraction": "设定抽取",
  "consistency-check": "一致性检查",
  "report-update": "报告更新",
  "book-analysis": "整书分析",
  "relationship-analysis": "人物关系分析"
};

const createOperationSchema = z.discriminatedUnion("opType", [
  z.object({
    opType: z.literal("create_entry"),
    entityType: entryEntityTypeSchema,
    /** 章节大纲按章节定位。 */
    chapterId: identifierSchema.optional(),
    input: z.unknown()
  }).strict(),
  z.object({
    opType: z.literal("update_entry"),
    entityType: entryEntityTypeSchema,
    entityId: identifierSchema.optional(),
    chapterId: identifierSchema.optional(),
    input: z.unknown()
  }).strict(),
  z.object({
    opType: z.literal("create_annotation"),
    chapterId: identifierSchema,
    kind: z.enum(["note", "todo"]),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    note: z.string().trim().min(1).max(2000)
  }).strict(),
  z.object({
    opType: z.literal("create_task"),
    taskType: z.enum([...AI_ANALYSIS_TASK_TYPES, "relationship-analysis"]),
    scope: jsonObjectSchema.optional(),
    modelId: identifierSchema.optional()
  }).strict()
]);

export type PlanOperationRaw = z.infer<typeof createOperationSchema>;

const planOperationsSchema = z.array(createOperationSchema).min(1);

export const createAiWritePlanInputSchema = z.object({
  aiSummary: z.string().trim().min(1).max(2000),
  operations: z.unknown()
}).strict();

export type CreateAiWritePlanInput = z.infer<typeof createAiWritePlanInputSchema>;

/** 提问选项数量限制：一次一个问题和 2-6 个预设选项。 */
export const MIN_AI_QUESTION_OPTIONS = 2;
export const MAX_AI_QUESTION_OPTIONS = 6;

export const askAiUserQuestionInputSchema = z.object({
  question: z.string().trim().min(1).max(2000),
  options: z.array(z.string().trim().min(1).max(200))
    .min(MIN_AI_QUESTION_OPTIONS)
    .max(MAX_AI_QUESTION_OPTIONS)
}).strict();

export const answerAiUserQuestionSchema = z.object({
  selectedOption: z.number().int().min(0).optional(),
  customAnswer: z.string().trim().min(1).max(2000).optional()
}).strict().refine(
  // 至少提供一种回答；选择预设项后仍可附带自定义补充信息。
  (input) => input.selectedOption !== undefined || input.customAnswer !== undefined,
  { message: "必须选择预设选项或填写自定义回答" }
);

// ---------------------------------------------------------------------------
// 标签与展示辅助
// ---------------------------------------------------------------------------

export function aiEntryEntityTypeLabel(entityType: AiEntryEntityType): string {
  switch (entityType) {
    case "setting": return "世界设定";
    case "character": return "角色";
    case "race": return "种族";
    case "organization": return "组织";
    case "timeline-track": return "时间轴轨道";
    case "timeline-event": return "时间轴事件";
    case "relationship": return "人物关系";
    case "chapter-outline": return "章节大纲";
    case "foreshadow": return "伏笔";
  }
}

const opTypeLabels: Record<string, string> = {
  create_entry: "新增",
  update_entry: "编辑",
  create_annotation: "新增批注",
  create_task: "新建分析任务"
};

export function aiOpTypeLabel(opType: string): string {
  return opTypeLabels[opType] ?? opType;
}

export const aiPlanStatusLabels: Record<string, string> = {
  pending: "待确认",
  rejected: "已拒绝",
  expired: "已过期",
  invalidated: "已失效",
  executing: "执行中",
  executed: "执行成功",
  failed: "执行失败"
};

/** 审批计划的全部状态，供路由层校验过滤参数。 */
export const AI_WRITE_PLAN_STATUSES = Object.keys(aiPlanStatusLabels) as Array<keyof typeof aiPlanStatusLabels>;
export type WritePlanStatus = (typeof AI_WRITE_PLAN_STATUSES)[number];

export const aiQuestionStatusLabels: Record<string, string> = {
  pending: "待回答",
  answered: "已回答",
  rejected: "已拒绝",
  expired: "已过期"
};

/** 提问的全部状态，供路由层校验过滤参数。 */
export const AI_USER_QUESTION_STATUSES = Object.keys(aiQuestionStatusLabels) as Array<keyof typeof aiQuestionStatusLabels>;
export type QuestionStatus = (typeof AI_USER_QUESTION_STATUSES)[number];

export const annotationKindLabels: Record<string, string> = {
  note: "评论",
  todo: "待办"
};

// ---------------------------------------------------------------------------
// 字段标签表（diff 与详情展示共用）
// ---------------------------------------------------------------------------

type FieldLabelMap = Record<string, string>;

const fieldLabelsByEntity: Record<AiEntryEntityType, FieldLabelMap> = {
  setting: {
    title: "标题",
    category: "分类",
    content: "内容",
    tags: "标签",
    authorNote: "作者备注"
  },
  character: {
    name: "姓名",
    isDead: "死亡状态",
    code: "代号",
    aliases: "别名",
    raceId: "所属种族",
    organizationIds: "所属组织",
    attributes: "扩展属性",
    profile: "人物档案",
    currentState: "当前状态"
  },
  race: {
    name: "名称",
    isExtinct: "是否灭亡",
    parentRaceId: "父级种族",
    description: "描述",
    settingsMarkdown: "设定内容"
  },
  organization: {
    name: "名称",
    isDissolved: "是否解散",
    description: "描述",
    settingsMarkdown: "设定内容"
  },
  "timeline-track": {
    name: "轨道名称",
    description: "说明",
    sortOrder: "排序值"
  },
  "timeline-event": {
    name: "事件名称",
    trackId: "所属轨道",
    description: "描述",
    eventType: "事件类型",
    timeLabel: "时间标签",
    timeSort: "时间排序",
    chapterIds: "关联章节",
    participantIds: "参与人物",
    location: "地点",
    causes: "起因",
    impactScope: "影响范围",
    status: "状态"
  },
  relationship: {
    fromCharacterId: "起始人物",
    toCharacterId: "目标人物",
    category: "关系类别",
    subtype: "关系细分",
    keywords: "关键词",
    directed: "是否有向",
    currentStatus: "当前状态",
    timeRange: "时间范围",
    confidence: "置信度"
  },
  "chapter-outline": {
    goal: "章节目标",
    conflict: "冲突",
    turningPoint: "转折点",
    notes: "笔记",
    status: "状态"
  },
  foreshadow: {
    title: "标题",
    description: "描述",
    status: "状态",
    importance: "重要程度",
    plannedPayoffChapterId: "计划回收章节",
    resolutionNote: "回收说明"
  }
};

export const impactScopeLabels: Record<string, string> = {
  personal: "个人",
  organization: "组织",
  regional: "地区",
  world: "世界",
  galaxy: "星系"
};

const outlineStatusLabels: Record<string, string> = { draft: "草稿", ready: "就绪", completed: "已完成" };
const foreshadowStatusLabels: Record<string, string> = { planned: "规划中", planted: "已埋设", resolved: "已回收", abandoned: "已废弃" };
const eventStatusLabels: Record<string, string> = { candidate: "候选", pending: "待定", confirmed: "已确认", deprecated: "已弃用" };
const relationshipCategoryLabels: Record<string, string> = {
  family: "亲缘",
  social: "社会",
  emotional: "情感",
  conflict: "冲突",
  uncertain: "不确定"
};

/** 按 `${entityType}.${key}` 定位的枚举值中文标签。 */
const enumValueLabelsByField: Record<string, Record<string, string>> = {
  "timeline-event.impactScope": impactScopeLabels,
  "timeline-event.status": eventStatusLabels,
  "chapter-outline.status": outlineStatusLabels,
  "foreshadow.status": foreshadowStatusLabels,
  "relationship.category": relationshipCategoryLabels
};

function completeCreatePreview(entityType: AiEntryEntityType, input: Record<string, unknown>): Record<string, unknown> {
  const defaults: Record<AiEntryEntityType, Record<string, unknown>> = {
    setting: { tags: [], authorNote: "" },
    character: { isDead: false, code: "", aliases: [], raceId: null, organizationIds: [], attributes: {}, profile: {}, currentState: {} },
    race: { isExtinct: false, parentRaceId: null, description: "", settingsMarkdown: "" },
    organization: { isDissolved: false, description: "", settingsMarkdown: "" },
    "timeline-track": { description: "", sortOrder: 0 },
    "timeline-event": {
      trackId: null,
      description: "",
      eventType: "other",
      timeLabel: "时间待定",
      timeSort: null,
      chapterIds: [],
      participantIds: [],
      location: "",
      causes: [],
      impactScope: "personal",
      status: "candidate"
    },
    relationship: { subtype: "", keywords: [], directed: false, currentStatus: "", timeRange: {}, confidence: 1 },
    "chapter-outline": { goal: "", conflict: "", turningPoint: "", notes: "", status: "draft" },
    foreshadow: { description: "", status: "planned", importance: "medium", plannedPayoffChapterId: null, resolutionNote: "" }
  };
  return { ...defaults[entityType], ...input };
}

/** 字段值的人类可读展示（不泄露模型密钥等信息，仅面向业务字段）。 */
export function formatFieldValue(contextKey: string, value: unknown): string {
  if (value === undefined || value === "") return "";
  if (value === null) return "空";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (Array.isArray(value)) {
    if (value.length === 0) return "空列表";
    return value.map((item) => formatFieldValue(contextKey, item)).join("、");
  }
  if (typeof value === "object") return JSON.stringify(value);
  const text = String(value);
  return enumValueLabelsByField[contextKey]?.[text] ?? text;
}

// ---------------------------------------------------------------------------
// 行级 diff（纯函数，带规模护栏）
// ---------------------------------------------------------------------------

export type DiffLineKind = "same" | "add" | "del";

export type DiffLine = { kind: DiffLineKind; text: string };

const MAX_DIFF_LINES = 200;
const MAX_DIFF_MATRIX = 120 * 120;

function splitLines(text: string): string[] {
  // 空文本视为零行，避免空字符串到有内容时出现虚假的删除行。
  return text === "" ? [] : text.split(/\r?\n/u);
}

/**
 * 行级 diff：对短文本使用 LCS，超出矩阵规模的退化为首尾公共前后缀裁剪，
 * 保证长文本 diff 有界且稳定。
 */
export function lineDiff(beforeText: string, afterText: string): DiffLine[] {
  const before = splitLines(String(beforeText ?? ""));
  const after = splitLines(String(afterText ?? ""));
  if (before.length * after.length <= MAX_DIFF_MATRIX) return lcsDiffLines(before, after);
  return boundedDiffLines(before, after);
}

function lcsDiffLines(before: string[], after: string[]): DiffLine[] {
  const rows = before.length;
  const columns = after.length;
  const stride = columns + 1;
  const lengths: Uint32Array = new Uint32Array((rows + 1) * stride);
  const readLength = (row: number, column: number): number => lengths[row * stride + column] ?? 0;
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = columns - 1; j >= 0; j -= 1) {
      lengths[i * stride + j] = before[i] === after[j]
        ? readLength(i + 1, j + 1) + 1
        : Math.max(readLength(i + 1, j), readLength(i, j + 1));
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let last: DiffLine | null = null;
  const push = (kind: DiffLineKind, text: string) => {
    if (last && last.kind === kind && last.text === text) return;
    last = { kind, text };
    lines.push(last);
  };
  while (i < rows && j < columns) {
    if (before[i] === after[j]) {
      push("same", before[i] ?? "");
      i += 1;
      j += 1;
    } else if (readLength(i + 1, j) >= readLength(i, j + 1)) {
      push("del", before[i] ?? "");
      i += 1;
    } else {
      push("add", after[j] ?? "");
      j += 1;
    }
  }
  while (i < rows) {
    push("del", before[i] ?? "");
    i += 1;
  }
  while (j < columns) {
    push("add", after[j] ?? "");
    j += 1;
  }
  return collapseConsecutive(lines);
}

function boundedDiffLines(before: string[], after: string[]): DiffLine[] {
  let prefixStart = 0;
  while (
    prefixStart < before.length && prefixStart < after.length && before[prefixStart] === after[prefixStart]
  ) prefixStart += 1;
  let suffixLength = 0;
  while (
    suffixLength < before.length - prefixStart
    && suffixLength < after.length - prefixStart
    && before[before.length - 1 - suffixLength] === after[after.length - 1 - suffixLength]
  ) suffixLength += 1;
  const removedCore = before.slice(prefixStart, before.length - suffixLength);
  const addedCore = after.slice(prefixStart, after.length - suffixLength);
  const suffix = before.slice(before.length - suffixLength).map((text) => ({ kind: "same" as const, text }));
  const head = before.slice(0, prefixStart).map((text) => ({ kind: "same" as const, text }));
  const tailDiff = collapseConsecutive([
    ...removedCore.map((text) => ({ kind: "del" as const, text })),
    ...addedCore.map((text) => ({ kind: "add" as const, text }))
  ]);
  return [...head, ...tailDiff, ...suffix];
}

function collapseConsecutive(lines: DiffLine[]): DiffLine[] {
  if (lines.length <= MAX_DIFF_LINES) return mergeAdjacent(lines);
  const kept = mergeAdjacent(lines.filter((line) => line.kind !== "same"));
  const added = kept.filter((line) => line.kind === "add").length;
  const removed = kept.filter((line) => line.kind === "del").length;
  return [
    ...kept.slice(0, MAX_DIFF_LINES - 2),
    { kind: "same", text: `… 其余变更行已省略（新增 ${added} 行 / 删除 ${removed} 行）` }
  ];
}

function mergeAdjacent(lines: DiffLine[]): DiffLine[] {
  const merged: DiffLine[] = [];
  for (const line of lines) {
    const previous = merged[merged.length - 1];
    if (previous && previous.kind === line.kind) previous.text = `${previous.text}\n${line.text}`;
    else merged.push({ ...line });
  }
  return merged;
}

export type LineChangeSummary = { added: number; removed: number };

export function summarizeLineChanges(lines: DiffLine[]): LineChangeSummary {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "add") added += 1;
    if (line.kind === "del") removed += 1;
  }
  return { added, removed };
}

// ---------------------------------------------------------------------------
// 字段级 diff 构建
// ---------------------------------------------------------------------------

export type FieldDiffItem = {
  key: string;
  label: string;
  /** 库内的原始修改前值：撤销操作必须用它还原，而不是人类可读的展示文本。 */
  beforeRaw: unknown;
  before: string;
  after: string;
  changed: boolean;
  lines: DiffLine[];
};

/**
 * 基于当前库内值与计划输入构建字段级 diff。
 * 未出现在 updates 中的字段不会出现；出现的字段如果与当前值一致则仍显示（changed=false）。
 */
export function buildFieldDiffs(
  entityType: AiEntryEntityType,
  current: Record<string, unknown> | null,
  updates: Record<string, unknown>
): FieldDiffItem[] {
  const labels = fieldLabelsByEntity[entityType] ?? {};
  const items: FieldDiffItem[] = [];
  for (const key of Object.keys(updates)) {
    const after = updates[key];
    const rawBefore = current ? current[key] : undefined;
    const equalValues = sameComparableValue(rawBefore, after);
    items.push({
      key,
      label: labels[key] ?? key,
      beforeRaw: rawBefore ?? null,
      before: current === null ? "" : formatFieldValue(`${entityType}.${key}`, rawBefore),
      after: formatFieldValue(`${entityType}.${key}`, after),
      changed: !equalValues,
      lines: equalValues ? [] : lineDiff(textualize(rawBefore), textualize(after))
    });
  }
  return items;
}

function textualize(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

/** 比较库内值与计划值是否一致；undefined 与 null 视为相同。 */
function sameComparableValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

// ---------------------------------------------------------------------------
// 权限交叉计算
// ---------------------------------------------------------------------------

const moduleAccessRank: Record<WorkModuleAccess, number> = { none: 0, read: 1, write: 2 };

/** 取两个用户权限的交集：任一方没有读取权限即视为不可见，写入需双方均可写。 */
export function intersectWorkModulePermissions(
  left: WorkModulePermissions,
  right: WorkModulePermissions
): WorkModulePermissions {
  const result = {} as WorkModulePermissions;
  for (const module of Object.keys(left) as Array<keyof WorkModulePermissions>) {
    const rankLeft = moduleAccessRank[left[module]];
    const rankRight = moduleAccessRank[right[module]];
    const minRank = Math.min(rankLeft, rankRight);
    result[module] = minRank >= 2 ? "write" : minRank >= 1 ? "read" : "none";
  }
  return result;
}

// ---------------------------------------------------------------------------
// 操作 → 工具与权限模块映射
// ---------------------------------------------------------------------------

export type PlanOperationRequirement = {
  toolId: AiWriteToolId;
  writeModules: string[];
  readModules: string[];
};

const moduleForTool: Record<Exclude<AiWriteToolId, "annotations" | "analysis_tasks" | "ask_user_questions">, string> = {
  settings: "settings",
  characters: "characters",
  races: "races",
  organizations: "organizations",
  timeline: "timeline",
  relationships: "relationships",
  outlines: "outlines"
};

function moduleForEntityType(entityType: AiEntryEntityType): string {
  switch (entityType) {
    case "setting": return "settings";
    case "character": return "characters";
    case "race": return "races";
    case "organization": return "organizations";
    case "timeline-track":
    case "timeline-event": return "timeline";
    case "relationship": return "relationships";
    case "chapter-outline":
    case "foreshadow": return "outlines";
  }
}

/**
 * 推导一个规范化操作的权限需求：
 * - 写入对应模块写权限；注释需要正文权限；任务需要 AI 分析权限加上范围材料的读取权限。
 */
export function planOperationRequirements(operation: NormalizedPlanOperation): PlanOperationRequirement {
  if (operation.opType === "create_annotation") {
    return { toolId: "annotations", writeModules: ["prose"], readModules: [] };
  }
  if (operation.opType === "create_task") {
    const readModules = analysisTaskReadModules(operation.taskType, operation.scope ?? { type: "book" });
    return { toolId: "analysis_tasks", writeModules: ["ai-analysis"], readModules };
  }
  const module = moduleForEntityType(operation.entityType);
  const toolId = module === "relationships"
    ? "relationships"
    : (Object.entries(moduleForTool).find(([, value]) => value === module)?.[0] ?? "outlines");
  const writeModules = new Set<string>([module]);
  const readModules = new Set<string>();
  const input = operation.input;
  if (operation.entityType === "character") {
    if (Object.prototype.hasOwnProperty.call(input, "raceId")) writeModules.add("races");
    if (Object.prototype.hasOwnProperty.call(input, "organizationIds")) writeModules.add("organizations");
  }
  if (operation.entityType === "timeline-event") {
    if (Object.prototype.hasOwnProperty.call(input, "chapterIds")) writeModules.add("prose");
    if (Object.prototype.hasOwnProperty.call(input, "participantIds")) writeModules.add("characters");
  }
  if (operation.entityType === "relationship" && operation.opType === "create_entry") {
    writeModules.add("characters");
  }
  if (operation.entityType === "chapter-outline") readModules.add("prose");
  if (operation.entityType === "foreshadow" && Object.prototype.hasOwnProperty.call(input, "plannedPayoffChapterId")) {
    readModules.add("prose");
  }
  return { toolId: toolId as AiWriteToolId, writeModules: [...writeModules], readModules: [...readModules] };
}

/** 转换为既定的操作记录形状（校验后的规范化形态）。 */
export type NormalizedPlanOperation =
  | { opType: "create_entry"; entityType: AiEntryEntityType; chapterId?: string; input: Record<string, unknown> }
  | { opType: "update_entry"; entityType: AiEntryEntityType; entityId?: string; chapterId?: string; input: Record<string, unknown> }
  | { opType: "create_annotation"; chapterId: string; kind: "note" | "todo"; startLine: number; endLine: number; note: string }
  | { opType: "create_task"; taskType: string; scope?: Record<string, unknown>; modelId?: string };

export function normalizePlanOperations(rawOperations: unknown, maxOperations: number): NormalizedPlanOperation[] {
  const rawList = planOperationsSchema.max(maxOperations, `单次计划最多包含 ${maxOperations} 个操作`).safeParse(rawOperations);
  if (!rawList.success) {
    const firstIssue = rawList.error.issues[0];
    throw new AppError(400, "AI_PLAN_OPERATION_INVALID", `${firstIssue?.path.join(".") || "operation"}：${firstIssue?.message ?? "操作格式无效"}`);
  }
  const normalized: NormalizedPlanOperation[] = [];
  for (const [offset, item] of rawList.data.entries()) {
    const index = offset + 1;
    switch (item.opType) {
      case "create_entry": {
        const { entityType } = item;
        const resolved = entryEntitySchemas[entityType].safeParse(item.input);
        if (!resolved.success) throw planInputError(offset, resolved.error);
        if (entityType === "chapter-outline" && !item.chapterId) {
          throw new AppError(400, "AI_PLAN_OPERATION_INVALID", `第 ${index} 个操作缺少章节 ID`);
        }
        normalized.push({ opType: "create_entry", entityType, chapterId: item.chapterId, input: resolved.data as Record<string, unknown> });
        break;
      }
      case "update_entry": {
        const { entityType } = item;
        const resolved = entryEntityUpdateSchemas[entityType].safeParse(item.input);
        if (!resolved.success) throw planInputError(offset, resolved.error);
        if (entityType === "chapter-outline") {
          if (!item.chapterId) throw new AppError(400, "AI_PLAN_OPERATION_INVALID", `第 ${index} 个操作缺少章节 ID`);
        } else if (!item.entityId) {
          throw new AppError(400, "AI_PLAN_OPERATION_INVALID", `第 ${index} 个操作缺少目标对象 ID`);
        }
        normalized.push({
          opType: "update_entry",
          entityType,
          entityId: item.entityId,
          chapterId: item.chapterId,
          input: resolved.data as Record<string, unknown>
        });
        break;
      }
      case "create_annotation": {
        if (item.endLine < item.startLine) {
          throw new AppError(400, "AI_PLAN_OPERATION_INVALID", `第 ${index} 个操作的结束行不能早于开始行`);
        }
        normalized.push({
          opType: "create_annotation",
          chapterId: item.chapterId,
          kind: item.kind,
          startLine: item.startLine,
          endLine: item.endLine,
          note: item.note
        });
        break;
      }
      case "create_task":
        normalized.push({ opType: "create_task", taskType: item.taskType, scope: item.scope, modelId: item.modelId });
        break;
    }
  }
  return normalized;
}

function planInputError(index: number, error: z.ZodError): AppError {
  const firstIssue = error.issues[0];
  return new AppError(400, "AI_PLAN_OPERATION_INVALID", `第 ${index + 1} 个操作的 ${firstIssue?.path.join(".") || "input"} 字段无效：${firstIssue?.message ?? "输入不符合要求"}`);
}

// ---------------------------------------------------------------------------
// 数据访问层
// ---------------------------------------------------------------------------

type PlanRow = {
  id: string;
  work_id: string;
  conversation_id: string | null;
  plan_kind: string;
  status: string;
  ai_summary: string;
  max_operations: number;
  invalid_reason: string;
  failure_message: string | null;
  initiator_user_id: string | null;
  conversation_owner_user_id: string | null;
  source_plan_id: string | null;
  created_at: string;
  decided_at: string | null;
  executed_at: string | null;
  executed_by_user_id: string | null;
};

type OperationRow = {
  id: string;
  plan_id: string;
  seq: number;
  op_type: string;
  module: string;
  entity_type: string;
  entity_id: string | null;
  target_version_no: number | null;
  title: string;
  operation_input_json: string;
  detail_json: string;
  required_modules_json: string;
  result_entity_id: string | null;
  result_version_no: number | null;
  result_summary: string;
};

type QuestionRow = {
  id: string;
  work_id: string;
  conversation_id: string | null;
  initiator_user_id: string | null;
  recipient_user_id: string | null;
  question: string;
  options_json: string;
  status: string;
  selected_option: number | null;
  answer_text: string;
  is_custom_answer: number;
  tool_call_id: string | null;
  continuation_json: string;
  resume_state: string;
  resume_result_json: string;
  resumed_at: string | null;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
};

export type PlanViewer = { userId: string | null; role: string } | null;

export type WritePlanSummaryView = {
  id: string;
  workId: string;
  conversationId: string | null;
  kind: string;
  kindLabel: string;
  status: string;
  statusLabel: string;
  aiSummary: string;
  operationCount: number;
  moduleLabels: string[];
  createdAt: string;
  decidedAt: string | null;
  executedAt: string | null;
  expiresAt: string | null;
  initiatorUserId: string | null;
  conversationOwnerUserId: string | null;
  /** 确认/拒绝/撤销该审批的用户：即“操作者”审计口径。 */
  decidedByUserId: string | null;
  decidedByName: string | null;
  sourcePlanId: string | null;
};

export type PlanDetailFieldView = {
  key: string;
  label: string;
  before: string | null;
  after: string | null;
  changed: boolean;
  addedLines: number;
  removedLines: number;
  previewBefore: string | null;
  previewAfter: string | null;
};

export type PlanDetailOperationView = {
  seq: number;
  opType: string;
  opTypeLabel: string;
  module: string;
  moduleLabel: string;
  entityType: string;
  entityId: string | null;
  targetVersionNo: number | null;
  title: string;
  annotation: { kind: string; kindLabel: string; startLine: number; endLine: number; quote: string; note: string } | null;
  task: { taskType: string; taskTypeLabel: string; scopeSummary: string; modelId: string | null } | null;
  fields: PlanDetailFieldView[];
  requiredModuleLabels: string[];
  restricted: boolean;
  result: { entityId: string | null; versionNo: number | null; summary: string } | null;
  auditRecords: Array<{ action: string; actor: string; userId: string | null; createdAt: string }>;
};

export type PlanDetailView = WritePlanSummaryView & {
  invalidReason: string;
  failureMessage: string | null;
  operations: PlanDetailOperationView[];
  undoAvailable: boolean;
  sourcePlanId: string | null;
};

export type QuestionView = {
  id: string;
  workId: string;
  conversationId: string | null;
  question: string;
  status: string;
  statusLabel: string;
  options: Array<{ index: number; label: string; recommended: boolean }>;
  selectedOption: number | null;
  selectedOptionLabel: string | null;
  customAnswer: string;
  answerText: string;
  isCustomAnswer: boolean;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  resumeState: string;
};

function resolvedQuestionAnswer(row: QuestionRow): {
  selectedOption: number | null;
  selectedOptionLabel: string | null;
  customAnswer: string;
  answerText: string;
} {
  const options = json<Array<string>>(row.options_json, []);
  const selectedOption = row.selected_option === null ? null : Number(row.selected_option);
  const selectedOptionLabel = selectedOption !== null && selectedOption >= 0 && selectedOption < options.length
    ? options[selectedOption] ?? null
    : null;
  const customAnswer = row.is_custom_answer === 1 ? row.answer_text : "";
  const answerText = selectedOptionLabel
    ? (customAnswer ? `${selectedOptionLabel}\n补充信息：${customAnswer}` : selectedOptionLabel)
    : (customAnswer || row.answer_text);
  return { selectedOption, selectedOptionLabel, customAnswer, answerText };
}

export type AiWriteToolsView = Record<AiWriteToolId, boolean>;

export type AnalysisTaskInput = { taskType: string; scope?: Record<string, unknown>; modelId?: string };
export type ResolvedAnalysisTaskInput = { taskType: string; scope: Record<string, unknown>; modelId?: string };
export type AnalysisTaskResolver = (workId: string, input: AnalysisTaskInput) => ResolvedAnalysisTaskInput;
/** 分析任务的启动器：由应用装配注入（ai.createTask），保持同步、事务安全。 */
export type AnalysisTaskStarter = (workId: string, input: ResolvedAnalysisTaskInput) => Record<string, unknown>;

export type AiWritePlanManagerOptions = {
  planTtlMs?: number;
  questionTtlMs?: number;
};

export class AiWritePlanManager {
  private readonly database: Database;
  private readonly store: Store;
  private readonly auth: UserAuthService;
  private readonly resolveAnalysisTask: AnalysisTaskResolver;
  private readonly startAnalysisTask: AnalysisTaskStarter;
  private readonly planTtlMs: number;
  private readonly questionTtlMs: number;

  constructor(
    deps: {
      database: Database;
      store: Store;
      auth: UserAuthService;
      resolveAnalysisTask: AnalysisTaskResolver;
      startAnalysisTask: AnalysisTaskStarter;
    },
    options: AiWritePlanManagerOptions = {}
  ) {
    this.database = deps.database;
    this.store = deps.store;
    this.auth = deps.auth;
    this.resolveAnalysisTask = deps.resolveAnalysisTask;
    this.startAnalysisTask = deps.startAnalysisTask;
    this.planTtlMs = options.planTtlMs ?? AI_WRITE_PLAN_TTL_MS;
    this.questionTtlMs = options.questionTtlMs ?? AI_USER_QUESTION_TTL_MS;
    this.recoverStaleExecutingPlans();
  }

  // --------------------------------------------------------------- 工具开关

  getEnabledTools(workId: string): AiWriteToolsView {
    const row = this.database.get<{ tools_json: string }>("SELECT tools_json FROM work_ai_tool_settings WHERE work_id = ?", workId);
    const enabled = json(row?.tools_json, {}) as Record<string, unknown>;
    const view = defaultAiWriteToolToggles();
    for (const toolId of AI_WRITE_TOOL_IDS) {
      if (enabled[toolId] === true) view[toolId] = true;
    }
    return view;
  }

  getConversationTools(workId: string, conversationId: string): AiWriteToolsView {
    const conversation = this.database.get<{ work_id: string; ai_write_tools_json: string | null; message_count: number }>(
      `SELECT conversation.work_id, conversation.ai_write_tools_json,
        (SELECT COUNT(*) FROM ai_conversation_messages message WHERE message.conversation_id = conversation.id) AS message_count
       FROM ai_conversations conversation WHERE conversation.id = ?`,
      conversationId
    );
    if (!conversation || conversation.work_id !== workId) {
      throw new AppError(400, "CONVERSATION_WORK_MISMATCH", "AI 对话不属于当前作品");
    }
    const current = this.getEnabledTools(workId);
    if (Number(conversation.message_count) === 0) {
      this.database.run(
        "UPDATE ai_conversations SET ai_write_tools_json = ?, updated_at = ? WHERE id = ?",
        JSON.stringify(current),
        now(),
        conversationId
      );
      return current;
    }
    const stored = json<Record<string, unknown>>(conversation.ai_write_tools_json ?? "{}", {});
    if (conversation.ai_write_tools_json) {
      const snapshot = defaultAiWriteToolToggles();
      for (const toolId of AI_WRITE_TOOL_IDS) snapshot[toolId] = stored[toolId] === true;
      return snapshot;
    }
    this.database.run(
      "UPDATE ai_conversations SET ai_write_tools_json = ?, updated_at = ? WHERE id = ? AND ai_write_tools_json IS NULL",
      JSON.stringify(current),
      now(),
      conversationId
    );
    return current;
  }

  /** 增量更新工具开关：未提及的开关保持不变；未知工具 ID 直接拒绝。 */
  updateToolSettings(workId: string, updates: Partial<Record<AiWriteToolId, boolean>>, updaterUserId: string | null): AiWriteToolsView {
    this.store.getWork(workId);
    const next = this.getEnabledTools(workId);
    for (const [toolId, enabled] of Object.entries(updates)) {
      if (!(toolId in next)) throw new AppError(400, "AI_TOOL_UNKNOWN", `未知的 AI 工具：${toolId}`);
      next[toolId as AiWriteToolId] = Boolean(enabled);
    }
    const timestamp = now();
    this.database.run(
      `INSERT INTO work_ai_tool_settings (work_id, tools_json, updated_at, updated_by_user_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(work_id) DO UPDATE SET tools_json = excluded.tools_json, updated_at = excluded.updated_at, updated_by_user_id = excluded.updated_by_user_id`,
      workId,
      JSON.stringify(next),
      timestamp,
      updaterUserId
    );
    this.store.audit(workId, "ai.tool_settings.updated", "work-ai-tool-settings", workId, {
      tools: updates,
      updatedByUserId: updaterUserId
    });
    logger.info("ai_write_tools.updated", { workId, tools: updates });
    return next;
  }

  assertToolEnabled(workId: string, toolId: AiWriteToolId): void {
    if (!this.getEnabledTools(workId)[toolId]) {
      throw new AppError(403, "AI_TOOL_DISABLED", `作品未开启「${aiWriteToolLabels[toolId]}」工具`);
    }
  }

  // --------------------------------------------------------------- 权限解析

  /**
   * 会话发起人的实时权限。未登录（开发直通模式）回退为全权限，
   * 与 requestPermissions 保持一致的语义；否则严格取会员权限。
   */
  private livePermissions(actor: PlanViewer, workId: string): WorkModulePermissions {
    if (!actor?.userId) return fullWorkModulePermissions();
    if (this.userIsAdmin(actor.userId)) return fullWorkModulePermissions();
    return this.auth.workModulePermissions({ userId: actor.userId, role: actor.role } as never, workId, true)
      ?? emptyWorkModulePermissions();
  }

  private userIsAdmin(userId: string): boolean {
    const row = this.database.get<{ role: string }>("SELECT role FROM users WHERE id = ?", userId);
    return row?.role === "admin";
  }

  private assertPlanViewer(row: PlanRow, workId: string, viewer: PlanViewer): void {
    if (row.work_id !== workId) throw notFoundPlan();
    if (!viewer?.userId) return;
    if (row.initiator_user_id !== viewer.userId && row.conversation_owner_user_id !== viewer.userId) {
      throw notFoundPlan();
    }
  }

  private assertQuestionViewer(row: QuestionRow, workId: string, viewer: PlanViewer): void {
    if (row.work_id !== workId) throw new AppError(404, "AI_QUESTION_NOT_FOUND", "问题不存在");
    if (!viewer?.userId) return;
    if (row.initiator_user_id !== viewer.userId && row.recipient_user_id !== viewer.userId) {
      throw new AppError(404, "AI_QUESTION_NOT_FOUND", "问题不存在");
    }
  }

  /** 从数据库静态解析指定用户的模块权限（用于对话属主，避免依赖登录态）。 */
  private permissionsForStoredUser(userId: string | null, workId: string): WorkModulePermissions {
    if (!userId) return emptyWorkModulePermissions();
    if (this.userIsAdmin(userId)) return fullWorkModulePermissions();
    const work = this.database.get<{ owner_user_id: string | null }>("SELECT owner_user_id FROM works WHERE id = ?", workId);
    if (!work) return emptyWorkModulePermissions();
    if (String(work.owner_user_id ?? "") === userId) return fullWorkModulePermissions();
    const membership = this.database.get<{ role: string; permissions_json: string | null }>(
      "SELECT role, permissions_json FROM work_memberships WHERE work_id = ? AND user_id = ?",
      workId,
      userId
    );
    if (!membership) return emptyWorkModulePermissions();
    // 与 user-auth.workModulePermissions 相同的兼容逻辑：role + stored permissions JSON。
    return storedWorkModulePermissions(membership.role, membership.permissions_json ?? "");
  }

  /** 发起人 × 对话属主的交集权限（写入判断依据）；对话属主未知时退化为发起人自身权限。 */
  private effectiveWritePermissions(initiator: PlanViewer, ownerUserId: string | null, workId: string): WorkModulePermissions {
    const initiatorPermissions = this.livePermissions(initiator, workId);
    if (!ownerUserId) return initiatorPermissions;
    return intersectWorkModulePermissions(initiatorPermissions, this.permissionsForStoredUser(ownerUserId, workId));
  }

  // --------------------------------------------------------------- 版本定位

  private currentEntityVersionNo(entityType: AiEntryEntityType, entityId: string): number | null {
    if (entityType === "character") {
      const row = this.database.get<{ version_no: number | null }>(
        "SELECT MAX(version_no) AS version_no FROM character_versions WHERE character_id = ?",
        entityId
      );
      return row?.version_no === null || row?.version_no === undefined ? null : Number(row.version_no);
    }
    if (entityType === "setting") {
      const row = this.database.get<{ version_no: number | null }>(
        "SELECT MAX(version_no) AS version_no FROM entity_versions WHERE entity_type = 'setting' AND entity_id = ?",
        entityId
      );
      return row?.version_no === null || row?.version_no === undefined ? null : Number(row.version_no);
    }
    const row = this.database.get<{ version_no: number | null }>(
      "SELECT MAX(version_no) AS version_no FROM entity_versions WHERE entity_type = ? AND entity_id = ?",
      entityType,
      entityId
    );
    return row?.version_no === null || row?.version_no === undefined ? null : Number(row.version_no);
  }

  private referenceVersion(workId: string, entityType: string, entityId: string): number | null {
    if (entityType === "chapter") {
      const chapter = this.store.getChapter(entityId);
      if (String(chapter.workId) !== workId) throw crossWorkError();
      return Number(chapter.versionNo);
    }
    if (entityType === "chapter-outline") {
      const chapter = this.store.getChapter(entityId);
      if (String(chapter.workId) !== workId) throw crossWorkError();
      return this.currentEntityVersionNo("chapter-outline", entityId);
    }
    const loaders: Partial<Record<AiEntryEntityType, () => Record<string, unknown>>> = {
      setting: () => this.store.getSetting(entityId),
      character: () => this.store.getCharacter(entityId),
      race: () => this.store.getRace(entityId),
      organization: () => this.store.getOrganization(entityId),
      "timeline-track": () => this.store.getTimelineTrack(entityId),
      "timeline-event": () => this.store.getTimelineEvent(entityId),
      relationship: () => this.store.getRelationship(entityId),
      foreshadow: () => this.store.getForeshadow(entityId)
    };
    const normalizedType = entityType === "timeline" ? "timeline-event" : entityType;
    const loader = loaders[normalizedType as AiEntryEntityType];
    if (!loader) throw new AppError(400, "AI_PLAN_REFERENCE_TYPE_INVALID", `不支持的版本引用类型：${entityType}`);
    const entity = loader();
    if (String(entity.workId) !== workId) throw crossWorkError();
    return this.currentEntityVersionNo(normalizedType as AiEntryEntityType, entityId);
  }

  private operationVersionSnapshot(workId: string, operation: NormalizedPlanOperation): Array<{ entityType: string; entityId: string; versionNo: number | null }> {
    const snapshots = new Map<string, { entityType: string; entityId: string; versionNo: number | null }>();
    const add = (entityType: string, rawId: unknown): void => {
      if (typeof rawId !== "string" || !rawId.trim()) return;
      const entityId = rawId.trim();
      const key = `${entityType}:${entityId}`;
      if (!snapshots.has(key)) snapshots.set(key, { entityType, entityId, versionNo: this.referenceVersion(workId, entityType, entityId) });
    };
    const addMany = (entityType: string, value: unknown): void => {
      if (Array.isArray(value)) value.forEach((item) => add(entityType, item));
    };

    if (operation.opType === "create_annotation") add("chapter", operation.chapterId);
    if (operation.opType === "create_task") {
      const scope = operation.scope ?? {};
      add("chapter", scope.chapterId);
      addMany("chapter", scope.chapterIds);
      addMany("character", scope.characterIds);
      addMany("character", scope.mentionCharacterIds);
      addMany("setting", scope.settingIds);
      addMany("race", scope.raceIds);
      addMany("organization", scope.organizationIds);
      if (Array.isArray(scope.relationshipSourceRefs)) {
        for (const reference of scope.relationshipSourceRefs) {
          if (!reference || typeof reference !== "object" || Array.isArray(reference)) continue;
          const value = reference as Record<string, unknown>;
          add(String(value.sourceType ?? ""), value.sourceId);
        }
      }
      return [...snapshots.values()];
    }
    if (operation.opType === "create_entry" || operation.opType === "update_entry") {
      const input = operation.input;
      if (operation.entityType === "chapter-outline") add("chapter", operation.chapterId);
      if (operation.entityType === "character") {
        add("race", input.raceId);
        addMany("organization", input.organizationIds);
      }
      if (operation.entityType === "timeline-event") {
        add("timeline-track", input.trackId);
        addMany("chapter", input.chapterIds);
        addMany("character", input.participantIds);
      }
      if (operation.entityType === "relationship") {
        add("character", input.fromCharacterId);
        add("character", input.toCharacterId);
      }
      if (operation.entityType === "foreshadow") add("chapter", input.plannedPayoffChapterId);
    }
    return [...snapshots.values()];
  }

  // --------------------------------------------------------------- 计划创建

  createWritePlan(input: {
    workId: string;
    conversationId: string | null;
    initiator: PlanViewer;
    conversationOwnerUserId: string | null;
    aiSummary: unknown;
    operations: unknown;
  }): PlanDetailView {
    const { workId } = input;
    this.store.getWork(workId);
    if (input.conversationId && this.latestPendingQuestion(input.conversationId)) {
      throw new AppError(409, "AI_QUESTION_PENDING", "当前对话仍有待回答问题，不能提交依赖未确认选择的写入计划");
    }
    const summaryParse = z.string().trim().min(1).max(2000).safeParse(input.aiSummary);
    if (!summaryParse.success) throw new AppError(400, "AI_PLAN_SUMMARY_REQUIRED", "AI 必须提供一段简要说明");
    const maxOperations = resolveAiWritePlanMaxOperations(process.env.AI_WRITE_PLAN_MAX_OPERATIONS);
    const operations = normalizePlanOperations(input.operations, maxOperations);

    const toggles = this.getEnabledTools(workId);
    const effective = this.effectiveWritePermissions(input.initiator, input.conversationOwnerUserId, workId);

    // 先统一做逐操作校验，收集标题与详情。
    const prepared = operations.map((operation) => this.prepareOperation(workId, operation, effective, toggles));

    const planId = randomId("aiPlan");
    const timestamp = now();
    const expiresAt = isoFromNow(timestamp, this.planTtlMs);
    this.database.transaction(() => {
      this.database.run(
        `INSERT INTO ai_write_plans (
          id, work_id, conversation_id, plan_kind, status, ai_summary, max_operations,
          initiator_user_id, conversation_owner_user_id, created_at
        ) VALUES (?, ?, ?, 'write', 'pending', ?, ?, ?, ?, ?)`,
        planId,
        workId,
        input.conversationId,
        summaryParse.data,
        operations.length,
        input.initiator?.userId ?? null,
        input.conversationOwnerUserId,
        timestamp
      );
      for (const [index, item] of prepared.entries()) {
        this.database.run(
          `INSERT INTO ai_write_plan_operations (
            id, plan_id, seq, op_type, module, entity_type, entity_id, target_version_no, title,
            operation_input_json, detail_json, required_modules_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          randomId("aiPlanOp"),
          planId,
          index + 1,
          item.operation.opType,
          item.requirement.writeModules[0] ?? "",
          "entityType" in item.operation ? item.operation.entityType : "",
          item.targetEntityId,
          item.targetVersionNo,
          item.title,
          JSON.stringify(item.operation),
          JSON.stringify(item.detail),
          JSON.stringify([...item.requirement.writeModules])
        );
      }
    });
    this.store.audit(workId, "ai.write_plan.created", "ai_write_plan", planId, {
      operationCount: prepared.length,
      createdBy: input.initiator?.userId ?? null
    });
    logger.info("ai_write_plan.created", { workId, planId, operations: prepared.length });
    return this.getPlanDetail(planId, workId, input.initiator);
  }

  /** 创建期的单个操作准备：工具开关、版本、diff 与目标标题都在这里定型。 */
  private prepareOperation(
    workId: string,
    operation: NormalizedPlanOperation,
    effective: WorkModulePermissions,
    toggles: AiWriteToolsView
  ): {
    operation: NormalizedPlanOperation;
    requirement: PlanOperationRequirement;
    targetEntityId: string | null;
    targetVersionNo: number | null;
    title: string;
    detail: Record<string, unknown>;
  } {
    const requirement = planOperationRequirements(operation);
    if (!toggles[requirement.toolId]) {
      throw new AppError(403, "AI_TOOL_DISABLED", `第 ${this.seqHintOf(operation)} 处使用了未开启的「${aiWriteToolLabels[requirement.toolId]}」工具`);
    }
    for (const module of requirement.readModules) {
      if (!canReadWorkModule(effective, module as keyof WorkModulePermissions)) {
        throw new AppError(403, "WORK_MODULE_READ_DENIED", `你没有读取“${workPermissionModuleLabels[module as keyof typeof workPermissionModuleLabels]}”相关资料的权限`);
      }
    }
    for (const module of requirement.writeModules) {
      if (!canWriteWorkModule(effective, module as keyof WorkModulePermissions)) {
        throw new AppError(403, "WORK_MODULE_WRITE_DENIED", `「${aiWriteToolLabels[requirement.toolId]}」需要双方都具备“${workPermissionModuleLabels[module as keyof typeof workPermissionModuleLabels]}”模块的编辑权限`);
      }
    }

    if (operation.opType === "create_annotation") {
      const versionSnapshot = this.operationVersionSnapshot(workId, operation);
      const chapter = this.store.getChapter(operation.chapterId);
      if (String(chapter.workId) !== workId) throw crossWorkError();
      const totalLines = splitLines(String(chapter.content)).length;
      if (operation.endLine > totalLines) {
        throw new AppError(400, "AI_PLAN_LINE_OUT_OF_RANGE", `批注位置超出了《${String(chapter.title)}》的实际行数（${totalLines} 行）`);
      }
      const contentLines = splitLines(String(chapter.content));
      const quote = contentLines.slice(operation.startLine - 1, operation.endLine).join("\n").slice(0, 1000);
      return {
        operation,
        requirement,
        targetEntityId: operation.chapterId,
        targetVersionNo: null,
        title: String(chapter.title),
        detail: {
          affectedModule: requirement.writeModules[0],
          affectedModuleLabel: workPermissionModuleLabels.prose,
          action: "新增批注",
          chapterId: operation.chapterId,
          chapterTitle: String(chapter.title),
          annotationKind: operation.kind,
          annotationKindLabel: annotationKindLabels[operation.kind],
          startLine: operation.startLine,
          endLine: operation.endLine,
          quote,
          note: operation.note,
          versionSnapshot
        }
      };
    }

    if (operation.opType === "create_task") {
      const resolvedOperation = this.resolveAnalysisTask(workId, operation);
      const normalizedOperation: NormalizedPlanOperation = { opType: "create_task", ...resolvedOperation };
      const versionSnapshot = this.operationVersionSnapshot(workId, normalizedOperation);
      const taskTypeLabel = aiAnalysisTaskTypeLabels[resolvedOperation.taskType] ?? resolvedOperation.taskType;
      const scopePreview = summarizeTaskScope(resolvedOperation.taskType, resolvedOperation.scope);
      return {
        operation: normalizedOperation,
        requirement,
        targetEntityId: null,
        targetVersionNo: null,
        title: taskTypeLabel,
        detail: {
          affectedModule: "ai-analysis",
          affectedModuleLabel: workPermissionModuleLabels["ai-analysis"],
          action: "新建分析任务",
          taskType: resolvedOperation.taskType,
          taskTypeLabel,
          modelId: resolvedOperation.modelId ?? null,
          scope: resolvedOperation.scope,
          scopeSummary: scopePreview.summary,
          scopeDescription: scopePreview.description,
          versionSnapshot
        }
      };
    }

    // 词条创建：无需当前快照，title 由输入决定。
    if (operation.opType === "create_entry") {
      const versionSnapshot = this.operationVersionSnapshot(workId, operation);
      const input = operation.input as Record<string, unknown>;
      let title = String(input.name ?? input.title ?? "");
      if (operation.entityType === "chapter-outline") {
        const chapter = this.store.getChapter(operation.chapterId ?? "");
        if (String(chapter.workId) !== workId) throw crossWorkError();
        title = String(chapter.title);
      }
      return {
        operation,
        requirement,
        targetEntityId: operation.entityType === "chapter-outline" ? operation.chapterId ?? null : null,
        targetVersionNo: null,
        title,
        detail: {
          affectedModule: requirement.writeModules[0],
          affectedModuleLabel: workPermissionModuleLabels[requirement.writeModules[0] as keyof typeof workPermissionModuleLabels],
          targetTypeLabel: aiEntryEntityTypeLabel(operation.entityType),
          action: "新增",
          title,
          versionSnapshot,
          fields: Object.entries(completeCreatePreview(operation.entityType, operation.input as Record<string, unknown>)).map(([key, value]) => ({
            key,
            label: fieldLabelsByEntity[operation.entityType][key] ?? key,
            after: formatFieldValue(key, value),
            changed: true
          }))
        }
      };
    }

    // 词条编辑：读取当前实体与版本，生成系统侧 before/after diff。
    const lookup = this.locateUpdateTarget(workId, operation);
    if (!lookup.exists) {
      throw new AppError(404, "AI_PLAN_TARGET_NOT_FOUND", `要编辑的${aiEntryEntityTypeLabel(operation.entityType)}不存在：${lookup.targetTitle || operation.entityId || ""}`);
    }
    const detail = {
      affectedModule: requirement.writeModules[0],
      affectedModuleLabel: workPermissionModuleLabels[requirement.writeModules[0] as keyof typeof workPermissionModuleLabels],
      targetTypeLabel: aiEntryEntityTypeLabel(operation.entityType),
      action: "编辑",
      target: lookup.targetTitle,
      title: lookup.targetTitle,
      targetVersionNo: lookup.currentVersionNo,
      versionSnapshot: this.operationVersionSnapshot(workId, operation),
      fields: buildFieldDiffs(operation.entityType, lookup.current, operation.input as Record<string, unknown>)
        .filter((field) => field.changed)
        .map((field) => ({
          key: field.key,
          label: field.label,
          // 保存库内原始修改前值：撤销执行需要它还原，而不是人类可读文本。
          beforeRaw: field.beforeRaw,
          before: field.before,
          after: field.after,
          changed: field.changed,
          lines: summarizeLineChanges(field.lines),
          linePreview: field.lines.slice(0, 40)
        }))
    };
    return {
      operation,
      requirement,
      targetEntityId: lookup.entityId,
      targetVersionNo: lookup.currentVersionNo,
      title: lookup.targetTitle,
      detail
    };
  }

  private seqHintOf(operation: NormalizedPlanOperation): string {
    switch (operation.opType) {
      case "create_entry": return aiEntryEntityTypeLabel(operation.entityType);
      case "update_entry": return `${aiEntryEntityTypeLabel(operation.entityType)}${operation.entityId}`;
      case "create_annotation": return "正文批注";
      case "create_task": return "分析任务";
    }
  }

  private locateUpdateTarget(workId: string, operation: Extract<NormalizedPlanOperation, { opType: "update_entry" }>): {
    exists: boolean;
    entityId: string;
    current: Record<string, unknown> | null;
    currentVersionNo: number | null;
    targetTitle: string;
  } {
    const { entityType } = operation;
    if (entityType === "chapter-outline") {
      // 大纲采用 upsert 语义：计划时不存在是合法状态（版本号为空表示“仍不存在”）。
      const chapterId = operation.chapterId ?? "";
      const chapter = this.store.getChapter(chapterId);
      if (String(chapter.workId) !== workId) throw crossWorkError();
      const current = this.tryGetChapterOutline(chapterId);
      return {
        exists: true,
        entityId: chapterId,
        current,
        currentVersionNo: current ? this.currentEntityVersionNo("chapter-outline", chapterId) : null,
        targetTitle: String(chapter.title)
      };
    }
    const entityId = operation.entityId ?? "";
    switch (entityType) {
      case "setting": {
        const current = this.safeGet(() => this.store.getSetting(entityId));
        this.assertSameWork(current, workId);
        return {
          exists: current !== undefined,
          entityId,
          current: current ?? null,
          currentVersionNo: this.currentEntityVersionNo(entityType, entityId),
          targetTitle: String(current?.title ?? "")
        };
      }
      case "character": {
        const current = this.safeGet(() => this.store.getCharacter(entityId));
        this.assertSameWork(current, workId);
        return {
          exists: current !== undefined,
          entityId,
          current: current ?? null,
          currentVersionNo: this.currentEntityVersionNo(entityType, entityId),
          targetTitle: String(current?.name ?? "")
        };
      }
      case "race": {
        const current = this.safeGet(() => this.store.getRace(entityId));
        this.assertSameWork(current, workId);
        return {
          exists: current !== undefined,
          entityId,
          current: current ?? null,
          currentVersionNo: this.currentEntityVersionNo(entityType, entityId),
          targetTitle: String(current?.name ?? "")
        };
      }
      case "organization": {
        const current = this.safeGet(() => this.store.getOrganization(entityId));
        this.assertSameWork(current, workId);
        return {
          exists: current !== undefined,
          entityId,
          current: current ?? null,
          currentVersionNo: this.currentEntityVersionNo(entityType, entityId),
          targetTitle: String(current?.name ?? "")
        };
      }
      case "timeline-track": {
        const current = this.safeGet(() => this.store.getTimelineTrack(entityId));
        this.assertSameWork(current, workId);
        return {
          exists: current !== undefined,
          entityId,
          current: current ?? null,
          currentVersionNo: this.currentEntityVersionNo(entityType, entityId),
          targetTitle: String(current?.name ?? "")
        };
      }
      case "timeline-event": {
        const current = this.safeGet(() => this.store.getTimelineEvent(entityId));
        this.assertSameWork(current, workId);
        return {
          exists: current !== undefined,
          entityId,
          current: current ?? null,
          currentVersionNo: this.currentEntityVersionNo(entityType, entityId),
          targetTitle: String(current?.name ?? "")
        };
      }
      case "relationship": {
        const current = this.safeGet(() => this.store.getRelationship(entityId));
        this.assertSameWork(current, workId);
        return {
          exists: current !== undefined,
          entityId,
          current: current ?? null,
          currentVersionNo: this.currentEntityVersionNo(entityType, entityId),
          targetTitle: describeRelationshipTitle(current)
        };
      }
      case "foreshadow": {
        const current = this.safeGet(() => this.store.getForeshadow(entityId));
        this.assertSameWork(current, workId);
        return {
          exists: current !== undefined,
          entityId,
          current: current ?? null,
          currentVersionNo: this.currentEntityVersionNo(entityType, entityId),
          targetTitle: String(current?.title ?? "")
        };
      }
    }
  }

  private safeGet<T>(loader: () => T): T | undefined {
    try {
      return loader();
    } catch {
      return undefined;
    }
  }

  private tryGetChapterOutline(chapterId: string): Record<string, unknown> | null {
    try {
      return this.store.getChapterOutline(chapterId);
    } catch {
      return null;
    }
  }

  private assertSameWork(current: Record<string, unknown> | undefined, workId: string): void {
    if (current && String(current.workId ?? "") !== workId) throw crossWorkError();
  }

  // --------------------------------------------------------------- 计划查询

  expireStalePlan(planRow: PlanRow): PlanRow {
    if (planRow.status !== "pending") return planRow;
    if (Date.parse(planRow.created_at) + this.planTtlMs > Date.now()) return planRow;
    this.database.run(
      "UPDATE ai_write_plans SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending'",
      now(),
      planRow.id
    );
    this.store.audit(planRow.work_id, "ai.write_plan.expired", "ai_write_plan", planRow.id, {});
    return this.loadPlan(planRow.id);
  }

  private loadPlan(planId: string): PlanRow {
    const row = this.database.get<PlanRow>("SELECT * FROM ai_write_plans WHERE id = ?", planId);
    if (!row) throw notFoundPlan();
    return row;
  }

  listPlansForWork(workId: string, viewer: PlanViewer, options: { status?: string; limit?: number } = {}): WritePlanSummaryView[] {
    this.recoverStaleExecutingPlans();
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const participantClause = viewer?.userId ? " AND (initiator_user_id = ? OR conversation_owner_user_id = ?)" : "";
    const participantParams = viewer?.userId ? [viewer.userId, viewer.userId] : [];
    const rows = options.status
      ? this.database.all<PlanRow>(
        `SELECT * FROM ai_write_plans WHERE work_id = ? AND status = ?${participantClause} ORDER BY created_at DESC LIMIT ?`,
        workId,
        options.status,
        ...participantParams,
        limit
      )
      : this.database.all<PlanRow>(
        `SELECT * FROM ai_write_plans WHERE work_id = ?${participantClause} ORDER BY created_at DESC LIMIT ?`,
        workId,
        ...participantParams,
        limit
      );
    return rows.map((row) => this.expireStalePlan(row)).map((row) => this.toSummaryView(row));
  }

  getPlanDetail(planId: string, workId: string, viewer: PlanViewer): PlanDetailView {
    let row = this.loadPlan(planId);
    this.assertPlanViewer(row, workId, viewer);
    row = this.expireStalePlan(row);
    return this.toDetailView(row, viewer);
  }

  // --------------------------------------------------------------- 决策流水线

  /**
   * 确认执行。只有待确认状态可以进入执行；重复确认会得到明确的失败提示且绝不重复写入。
   */
  async confirmPlan(planId: string, workId: string, confirmer: PlanViewer): Promise<PlanDetailView> {
    await Promise.resolve();
    let row = this.expireStalePlan(this.loadPlan(planId));
    this.assertPlanViewer(row, workId, confirmer);
    if (row.status !== "pending") throw decisionConflict(row);

    const claim = this.database.run(
      `UPDATE ai_write_plans SET status = 'executing', decided_at = ?, executed_by_user_id = ?
       WHERE id = ? AND status = 'pending'`,
      now(),
      confirmer?.userId ?? null,
      planId
    );
    if (claim.changes !== 1) {
      row = this.loadPlan(planId);
      throw decisionConflict(row);
    }
    this.store.audit(row.work_id, "ai.write_plan.confirmed", "ai_write_plan", planId, { confirmedBy: confirmer?.userId ?? null });

    try {
      const outcome = this.database.transaction(() => this.executePlanWithinTransaction(planId, confirmer));
      if (outcome.ok) {
        logger.info("ai_write_plan.executed", { planId, operations: outcome.operationResults.length });
        return this.getPlanDetail(planId, workId, confirmer);
      }
      const invalidated = this.database.run(
        `UPDATE ai_write_plans SET status = 'invalidated', invalid_reason = ?
         WHERE id = ? AND status = 'executing'`,
        outcome.reason,
        planId
      );
      if (invalidated.changes === 1) {
        this.store.audit(row.work_id, "ai.write_plan.invalidated", "ai_write_plan", planId, { reason: outcome.reason });
      }
      logger.warn("ai_write_plan.invalidated", { planId, reason: outcome.reason });
      throw new AppError(409, "AI_PLAN_INVALIDATED", outcome.reason);
    } catch (error) {
      if (error instanceof AppError && error.code === "AI_PLAN_INVALIDATED") throw error;
      const message = sanitizeFailure(error);
      this.database.run(
        `UPDATE ai_write_plans SET status = 'failed', failure_message = ?
         WHERE id = ? AND status = 'executing'`,
        message,
        planId
      );
      this.store.audit(row.work_id, "ai.write_plan.failed", "ai_write_plan", planId, { message });
      logger.error("ai_write_plan.failed", { planId, message });
      throw new AppError(409, "AI_PLAN_EXECUTION_FAILED", `计划执行失败，未产生任何写入：${message}`);
    }
  }

  private executePlanWithinTransaction(
    planId: string,
    confirmer: PlanViewer
  ): { ok: true; operationResults: Array<{ seq: number }> } | { ok: false; reason: string } {
    const row = this.loadPlan(planId);
    const operations = this.database.all<OperationRow>(
      "SELECT * FROM ai_write_plan_operations WHERE plan_id = ? ORDER BY seq",
      planId
    );

    // ---- 再校验 1：双方权限是否仍然满足（R8/R13）。
    const effective = this.effectiveWritePermissions(confirmer, row.conversation_owner_user_id, row.work_id);
    const initiatorPermissions = this.livePermissions(confirmer, row.work_id);
    const ownersPermissions = this.permissionsForStoredUser(row.conversation_owner_user_id, row.work_id);
    void initiatorPermissions;
    void ownersPermissions;

    for (const operation of operations) {
      const requiredModules = json<Array<string>>(operation.required_modules_json, []);
      for (const moduleName of requiredModules) {
        if (!canWriteWorkModule(effective, moduleName as keyof WorkModulePermissions)) {
          return {
            ok: false,
            reason: `执行前校验失败：当前不再具备“${workPermissionModuleLabels[moduleName as keyof typeof workPermissionModuleLabels]}”模块的编辑权限（操作 ${operation.seq}）`
          };
        }
      }
      // ---- 再校验 2：工具开关仍然开启（R7/R13）。
      const requirement = requirementForStoredOperation(operation);
      if (!this.getEnabledTools(row.work_id)[requirement.toolId]) {
        return { ok: false, reason: `执行前校验失败：「${aiWriteToolLabels[requirement.toolId]}」工具已被关闭（操作 ${operation.seq}）` };
      }
      const detail = json<Record<string, unknown>>(operation.detail_json, {});
      const versionSnapshot = Array.isArray(detail.versionSnapshot)
        ? detail.versionSnapshot as Array<Record<string, unknown>>
        : [];
      for (const reference of versionSnapshot) {
        const entityType = String(reference.entityType ?? "");
        const entityId = String(reference.entityId ?? "");
        const expectedVersion = reference.versionNo === null ? null : Number(reference.versionNo);
        let currentVersion: number | null;
        try {
          currentVersion = this.referenceVersion(row.work_id, entityType, entityId);
        } catch {
          return { ok: false, reason: `执行前校验失败：关联对象已不存在或不再属于当前作品（${entityType}:${entityId}，操作 ${operation.seq}）` };
        }
        if (currentVersion !== expectedVersion) {
          return { ok: false, reason: `执行前校验失败：关联对象已发生变化（${entityType}:${entityId}，版本 ${expectedVersion ?? "不存在"} -> ${currentVersion ?? "不存在"}，操作 ${operation.seq}）` };
        }
      }
      // ---- 再校验 3：目标对象与版本没有变化（R10/R13）。
      if (operation.op_type === "update_entry" && operation.entity_type && operation.entity_id) {
        const entityType = operation.entity_type as AiEntryEntityType;
        const currentVersionNo = this.currentEntityVersionNo(entityType, operation.entity_id);
        const expected = operation.target_version_no;
        // 章节大纲允许“计划时不存在”的编辑计划（upsert 语义）：要求此刻仍不存在。
        const outlineStillAbsent = entityType === "chapter-outline" && expected === null;
        if (outlineStillAbsent ? currentVersionNo !== null : (currentVersionNo === null || expected === null || currentVersionNo !== expected)) {
          const target = { title: operation.title };
          return {
            ok: false,
            reason: `执行前校验失败：「${target.title || aiEntryEntityTypeLabel(entityType)}」已发生变化，请让 AI 重新提交计划（版本 ${expected ?? "?"} -> ${currentVersionNo ?? "不存在"}，操作 ${operation.seq}）`
          };
        }
      }
      if (operation.op_type === "create_entry" && operation.entity_type === "chapter-outline" && operation.entity_id) {
        const currentVersionNo = this.currentEntityVersionNo("chapter-outline", operation.entity_id);
        if (currentVersionNo !== null) {
          return { ok: false, reason: `执行前校验失败：「${operation.title}」的大纲已被创建，请让 AI 重新提交计划（操作 ${operation.seq}）` };
        }
      }
    }

    const operationResults = operations.map((operation) => this.applyPlanOperation(row.work_id, planId, operation, confirmer));
    this.database.run(
      "UPDATE ai_write_plans SET status = 'executed', executed_at = ? WHERE id = ?",
      now(),
      planId
    );
    this.store.audit(row.work_id, "ai.write_plan.executed", "ai_write_plan", planId, {
      executedBy: confirmer?.userId ?? null,
      operations: operationResults.map((result) => result.seq)
    });
    return { ok: true, operationResults };
  }

  /** 执行单个操作并把结果写回操作记录。 */
  private applyPlanOperation(workId: string, planId: string, operation: OperationRow, confirmer: PlanViewer): { seq: number } {
    const sourceRef = `ai-plan:${planId}:${operation.seq}`;
    const changeNote = `AI 审批计划 ${planId}`;
    const input = json<Record<string, unknown>>(operation.operation_input_json, {});
    const detail = json<Record<string, unknown>>(operation.detail_json, {});
    let resultEntityId: string | null = null;
    let resultVersionNo: number | null = null;
    let resultSummary = "";

    if (operation.op_type === "create_entry") {
      const entityType = operation.entity_type as AiEntryEntityType;
      const entityInput = stripMetadata(input.input) as never;
      let created: Record<string, unknown>;
      switch (entityType) {
        case "setting":
          created = this.store.createSetting(workId, entityInput as never, "ai", sourceRef);
          break;
        case "character":
          created = this.store.createCharacter(workId, entityInput as never);
          break;
        case "race":
          created = this.store.createRace(workId, entityInput as never);
          break;
        case "organization":
          created = this.store.createOrganization(workId, entityInput as never);
          break;
        case "timeline-track":
          created = this.store.createTimelineTrack(workId, entityInput as never, "ai", sourceRef);
          break;
        case "timeline-event":
          created = this.store.createTimelineEvent(workId, entityInput as never, "ai", sourceRef);
          break;
        case "relationship":
          created = this.store.createRelationship(workId, entityInput as never, "ai", sourceRef);
          break;
        case "chapter-outline":
          created = this.store.upsertChapterOutline(String(operation.entity_id), entityInput as never, "ai", sourceRef, changeNote);
          break;
        case "foreshadow":
          created = this.store.createForeshadow(workId, entityInput as never);
          break;
      }
      resultEntityId = String(created.id ?? "");
      resultVersionNo = entityType === "character"
        ? Number(created.versionNo ?? 1)
        : this.currentEntityVersionNoAfterWrite(entityType, resultEntityId);
      resultSummary = `已创建${aiEntryEntityTypeLabel(entityType)}「${operation.title}」`;
    } else if (operation.op_type === "update_entry") {
      const entityType = operation.entity_type as AiEntryEntityType;
      const entityId = String(operation.entity_id);
      const entityInput = stripMetadata(input.input) as never;
      const expectedVersionNo = operation.target_version_no === null ? undefined : operation.target_version_no;
      const undoPayload = prepareUndoPayload(detail, entityType, entityId);
      switch (entityType) {
        case "setting":
          this.store.updateSetting(entityId, entityInput, "ai", sourceRef, changeNote, expectedVersionNo);
          break;
        case "character":
          this.store.updateCharacter(entityId, entityInput, "ai", sourceRef, changeNote, expectedVersionNo);
          break;
        case "race":
          this.store.updateRace(entityId, entityInput, "ai", sourceRef, changeNote, expectedVersionNo);
          break;
        case "organization":
          this.store.updateOrganization(entityId, entityInput, "ai", sourceRef, changeNote, expectedVersionNo);
          break;
        case "timeline-track":
          this.store.updateTimelineTrack(entityId, entityInput, "ai", sourceRef, changeNote, expectedVersionNo);
          break;
        case "timeline-event":
          this.store.updateTimelineEvent(entityId, entityInput, "ai", sourceRef, changeNote, expectedVersionNo);
          break;
        case "relationship":
          this.store.updateRelationship(entityId, entityInput, "ai", sourceRef, changeNote, expectedVersionNo);
          break;
        case "chapter-outline":
          this.store.upsertChapterOutline(entityId, entityInput, "ai", sourceRef, changeNote, expectedVersionNo);
          break;
        case "foreshadow":
          this.store.updateForeshadow(entityId, entityInput, "ai", sourceRef, changeNote, expectedVersionNo);
          break;
      }
      resultEntityId = entityId;
      resultVersionNo = entityType === "chapter-outline"
        ? this.currentEntityVersionNo(entityType, entityId)
        : this.currentEntityVersionNo(entityType, entityId);
      resultSummary = `已更新${aiEntryEntityTypeLabel(entityType)}「${operation.title}」（版本 ${resultVersionNo ?? "?"}）`;
      if (undoPayload) {
        this.database.run(
          "UPDATE ai_write_plan_operations SET detail_json = ? WHERE id = ?",
          JSON.stringify({ ...(detail as Record<string, unknown>), undoPayload: undoPayload.undoJson }),
          operation.id
        );
      }
    } else if (operation.op_type === "create_annotation") {
      const created = this.store.createChapterAnnotation(String(operation.entity_id), {
        kind: String(input.kind) === "todo" ? "todo" : "note",
        startLine: Number(input.startLine),
        endLine: Number(input.endLine),
        note: String(input.note)
      });
      resultEntityId = String(created.id ?? "");
      resultVersionNo = Number(created.versionNo ?? 1);
      resultSummary = `已在「${detail.chapterTitle ?? operation.title}」第 ${input.startLine}-${input.endLine} 行创建${annotationKindLabels[String(input.kind)] ?? "批注"}`;
    } else if (operation.op_type === "create_task") {
      const created = this.startAnalysisTask(workId, {
        taskType: String(input.taskType),
        scope: input.scope && typeof input.scope === "object" && !Array.isArray(input.scope)
          ? input.scope as Record<string, unknown>
          : { type: "book" },
        ...(input.modelId ? { modelId: String(input.modelId) } : {})
      });
      resultEntityId = String(created.id ?? "");
      resultSummary = `已创建${aiAnalysisTaskTypeLabels[String(input.taskType)] ?? String(input.taskType)}分析任务`;
      void confirmer;
    }

    this.database.run(
      `UPDATE ai_write_plan_operations
       SET result_entity_id = ?, result_version_no = ?, result_summary = ?
       WHERE id = ?`,
      resultEntityId,
      resultVersionNo,
      resultSummary,
      operation.id
    );
    this.store.audit(workId, `ai.plan_operation.${operation.op_type}`, "ai_write_plan_operation", operation.id, {
      planId,
      seq: operation.seq,
      entityId: resultEntityId,
      versionNo: resultVersionNo
    });
    return { seq: operation.seq };
  }

  private currentEntityVersionNoAfterWrite(entityType: AiEntryEntityType, entityId: string): number | null {
    return this.currentEntityVersionNo(entityType, entityId);
  }

  rejectPlan(planId: string, workId: string, rejecter: PlanViewer): PlanDetailView {
    const row = this.expireStalePlan(this.loadPlan(planId));
    this.assertPlanViewer(row, workId, rejecter);
    if (row.status !== "pending") throw decisionConflict(row);
    const updated = this.database.run(
      "UPDATE ai_write_plans SET status = 'rejected', decided_at = ?, executed_by_user_id = ? WHERE id = ? AND status = 'pending'",
      now(),
      rejecter?.userId ?? null,
      planId
    );
    if (updated.changes !== 1) throw decisionConflict(this.loadPlan(planId));
    this.store.audit(row.work_id, "ai.write_plan.rejected", "ai_write_plan", planId, { rejectedBy: rejecter?.userId ?? null });
    logger.info("ai_write_plan.rejected", { planId });
    return this.getPlanDetail(planId, workId, rejecter);
  }

  /** 服务恢复后清理卡在执行中的陈旧计划：其事务必然没有提交，可以安全判定为失败。 */
  private recoverStaleExecutingPlans(): void {
    const rows = this.database.all<PlanRow>(
      "SELECT * FROM ai_write_plans WHERE status = 'executing' ORDER BY created_at LIMIT 20"
    );
    for (const row of rows) {
      const updatedAt = row.decided_at ?? row.created_at;
      // 宽限 10 分钟：正常执行远快于此；超时的执行事务一定没有提交。
      if (Date.parse(updatedAt) + 600_000 > Date.now()) continue;
      this.database.run(
        "UPDATE ai_write_plans SET status = 'failed', failure_message = '服务中断导致执行未完成，未产生写入，请重新发起' WHERE id = ? AND status = 'executing'",
        row.id
      );
      logger.warn("ai_write_plan.stale_recovered", { planId: row.id });
    }
  }

  // --------------------------------------------------------------- 撤销

  /** 已成功审批中哪些操作仍支持撤销。 */
  undoEligibility(planId: string): {
    undoAvailable: boolean;
    eligibleOps: Array<{ seq: number; title: string }>;
    skippedOps: Array<{ seq: number; title: string; reason: string }>;
  } {
    const row = this.loadPlan(planId);
    const operations = this.database.all<OperationRow>(
      "SELECT * FROM ai_write_plan_operations WHERE plan_id = ? ORDER BY seq",
      planId
    );
    const eligibleOps: Array<{ seq: number; title: string }> = [];
    const skippedOps: Array<{ seq: number; title: string; reason: string }> = [];
    for (const operation of operations) {
      const reversible = operation.op_type === "update_entry"
        && operation.result_entity_id
        && operation.result_version_no !== null
        && this.currentEntityVersionNo(operation.entity_type as AiEntryEntityType, String(operation.result_entity_id)) === operation.result_version_no;
      if (reversible) eligibleOps.push({ seq: operation.seq, title: operation.title });
      else if (operation.op_type === "create_entry") {
        skippedOps.push({ seq: operation.seq, title: operation.title, reason: "AI 新建的条目不支持通过撤销删除" });
      } else if (operation.op_type === "create_annotation" || operation.op_type === "create_task") {
        skippedOps.push({ seq: operation.seq, title: operation.title, reason: "批注与分析任务不在撤销范围内" });
      } else {
        skippedOps.push({ seq: operation.seq, title: operation.title, reason: "对象已被后续修改，无法撤销" });
      }
    }
    void row;
    return { undoAvailable: eligibleOps.length > 0, eligibleOps, skippedOps };
  }

  /** 为已成功审批创建撤销计划（撤销本身也需要再次确认）。 */
  createUndoPlan(sourcePlanId: string, workId: string, requester: PlanViewer): PlanDetailView {
    const source = this.loadPlan(sourcePlanId);
    this.assertPlanViewer(source, workId, requester);
    if (source.status !== "executed") throw new AppError(409, "AI_UNDO_SOURCE_NOT_EXECUTED", "只有执行成功的审批才能撤销");
    const eligibility = this.undoEligibility(sourcePlanId);
    if (!eligibility.undoAvailable) {
      throw new AppError(409, "AI_UNDO_NOT_AVAILABLE", "该审批已经没有可撤销的操作（目标可能被后续修改）");
    }
    const operations = this.database.all<OperationRow>(
      "SELECT * FROM ai_write_plan_operations WHERE plan_id = ? ORDER BY seq",
      sourcePlanId
    );
    const planId = randomId("aiPlan");
    const timestamp = now();
    const titles: string[] = [];
    this.database.transaction(() => {
      this.database.run(
        `INSERT INTO ai_write_plans (
          id, work_id, conversation_id, plan_kind, status, ai_summary, max_operations,
          initiator_user_id, conversation_owner_user_id, source_plan_id, created_at
        ) VALUES (?, ?, ?, 'undo', 'pending', ?, ?, ?, ?, ?, ?)`,
        planId,
        source.work_id,
        source.conversation_id,
        `撤销审批 ${sourcePlanId} 中已被修改的条目`,
        operations.length,
        requester?.userId ?? null,
        source.conversation_owner_user_id,
        sourcePlanId,
        timestamp
      );
      for (const operation of operations) {
        const detail = json<Record<string, unknown>>(operation.detail_json, {});
        const undoPayload = detail.undoPayload as Record<string, unknown> | undefined;
        // 仅恢复“编辑已有条目”且执行成功的操作；AI 新建条目不可通过撤销删除。
        if (!undoPayload) continue;
        if (String(operation.op_type) !== "update_entry") continue;
        if (!operation.result_entity_id || operation.result_version_no === null) continue;
        if (String(undoPayload.entityId) !== String(operation.result_entity_id)) continue;
        const entityType = operation.entity_type as AiEntryEntityType;
        titles.push(`#${operation.seq} ${operation.title}`);
        this.database.run(
          `INSERT INTO ai_write_plan_operations (
            id, plan_id, seq, op_type, module, entity_type, entity_id, target_version_no, title,
            operation_input_json, detail_json, required_modules_json
          ) VALUES (?, ?, ?, 'update_entry', ?, ?, ?, ?, ?, ?, ?, ?)`,
          randomId("aiPlanOp"),
          planId,
          operation.seq,
          operation.module,
          operation.entity_type,
          operation.result_entity_id,
          operation.result_version_no,
          `撤销：${operation.title}`,
          JSON.stringify({ opType: "update_entry", entityType, entityId: operation.result_entity_id, input: undoPayload.beforeFields }),
          JSON.stringify({
            affectedModule: operation.module,
            targetTypeLabel: aiEntryEntityTypeLabel(entityType),
            action: "撤销",
            target: operation.title,
            revertedFromPlanId: sourcePlanId,
            sourceSeq: operation.seq
          }),
          operation.required_modules_json
        );
      }
    });
    if (titles.length === 0) {
      throw new AppError(409, "AI_UNDO_NOT_AVAILABLE", "该审批中已没有任何可撤销的操作");
    }
    this.store.audit(source.work_id, "ai.undo_plan.created", "ai_write_plan", planId, {
      sourcePlanId,
      requestedBy: requester?.userId ?? null,
      operations: titles.length
    });
    return this.getPlanDetail(planId, workId, requester);
  }

  // --------------------------------------------------------------- 投影视图

  private toSummaryView(row: PlanRow): WritePlanSummaryView {
    const counts = this.database.all<{ module: string }>(
      "SELECT DISTINCT module FROM ai_write_plan_operations WHERE plan_id = ?",
      row.id
    );
    const operator = row.executed_by_user_id
      ? this.database.get<{ display_name: string; username: string }>("SELECT display_name, username FROM users WHERE id = ?", row.executed_by_user_id)
      : undefined;
    return {
      id: row.id,
      workId: row.work_id,
      conversationId: row.conversation_id,
      kind: row.plan_kind,
      kindLabel: row.plan_kind === "undo" ? "撤销审批" : "写入审批",
      status: row.status,
      statusLabel: aiPlanStatusLabels[row.status] ?? row.status,
      aiSummary: row.ai_summary,
      operationCount: this.countPlanOperations(row.id),
      moduleLabels: counts.map((item) => workPermissionModuleLabels[item.module as keyof typeof workPermissionModuleLabels] ?? item.module),
      createdAt: row.created_at,
      decidedAt: row.decided_at,
      executedAt: row.executed_at,
      expiresAt: row.status === "pending" ? isoFromNow(row.created_at, this.planTtlMs) : null,
      initiatorUserId: row.initiator_user_id,
      conversationOwnerUserId: row.conversation_owner_user_id,
      decidedByUserId: row.executed_by_user_id,
      decidedByName: operator ? String(operator.display_name || operator.username) : null,
      sourcePlanId: row.source_plan_id
    };
  }

  private countPlanOperations(planId: string): number {
    const row = this.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM ai_write_plan_operations WHERE plan_id = ?", planId);
    return Number(row?.count ?? 0);
  }

  private toDetailView(row: PlanRow, viewer: PlanViewer): PlanDetailView {
    const base = this.toSummaryView(row);
    const operations = this.database.all<OperationRow>(
      "SELECT * FROM ai_write_plan_operations WHERE plan_id = ? ORDER BY seq",
      row.id
    );
    const viewerPermissions = this.livePermissions(viewer, row.work_id);
    const undoAvailability = row.plan_kind === "write" && row.status === "executed" ? this.undoEligibility(row.id).undoAvailable : false;
    return {
      ...base,
      invalidReason: row.invalid_reason,
      failureMessage: row.failure_message,
      undoAvailable: undoAvailability,
      sourcePlanId: row.source_plan_id,
      operations: operations.map((operation) => this.toOperationView(operation, viewerPermissions))
    };
  }

  private toOperationView(operation: OperationRow, viewerPermissions: WorkModulePermissions): PlanDetailOperationView {
    const detail = json<Record<string, unknown>>(operation.detail_json, {});
    const requiredModules = json<Array<string>>(operation.required_modules_json, []);
    const restricted = requiredModules.some((module) => !canReadWorkModule(viewerPermissions, module as keyof WorkModulePermissions));
    const fields = Array.isArray(detail.fields) ? detail.fields as Array<Record<string, unknown>> : [];
    const auditRecords = this.database.all<{
      action: string;
      actor: string;
      user_id: string | null;
      actor_display_name: string | null;
      actor_username: string | null;
      created_at: string;
    }>(
      `SELECT log.action, log.actor, log.user_id, log.created_at,
        user.display_name AS actor_display_name, user.username AS actor_username
       FROM audit_logs log LEFT JOIN users user ON user.id = log.user_id
       WHERE log.entity_type = 'ai_write_plan_operation' AND log.entity_id = ?
       ORDER BY log.created_at`,
      operation.id
    ).map((record) => ({
      action: record.action,
      actor: String(record.actor_display_name || record.actor_username || record.actor),
      userId: record.user_id,
      createdAt: record.created_at
    }));
    return {
      seq: operation.seq,
      opType: operation.op_type,
      opTypeLabel: aiOpTypeLabel(operation.op_type),
      module: operation.module,
      moduleLabel: workPermissionModuleLabels[operation.module as keyof typeof workPermissionModuleLabels] ?? operation.module,
      entityType: operation.entity_type,
      entityId: operation.entity_id,
      targetVersionNo: operation.target_version_no,
      title: restricted ? "无权查看该模块内容" : operation.title,
      annotation: operation.op_type === "create_annotation"
        ? {
          kind: String(detail.annotationKind ?? ""),
          kindLabel: String(detail.annotationKindLabel ?? ""),
          startLine: Number(detail.startLine ?? 0),
          endLine: Number(detail.endLine ?? 0),
          quote: restricted ? "" : String(detail.quote ?? ""),
          note: restricted ? "" : String(detail.note ?? "")
        }
        : null,
      task: operation.op_type === "create_task"
        ? {
          taskType: String(detail.taskType ?? ""),
          taskTypeLabel: String(detail.taskTypeLabel ?? ""),
          scopeSummary: restricted ? "" : String(detail.scopeDescription ?? detail.scopeSummary ?? ""),
          modelId: detail.modelId ? String(detail.modelId) : null
        }
        : null,
      fields: restricted
        ? fields.map((field) => ({
          key: String(field.key ?? ""),
          label: String(field.label ?? ""),
          before: null,
          after: null,
          changed: field.changed === true,
          addedLines: 0,
          removedLines: 0,
          previewBefore: null,
          previewAfter: null
        }))
        : fields.map((field) => ({
          key: String(field.key ?? ""),
          label: String(field.label ?? ""),
          before: field.before === undefined || field.before === null ? "" : String(field.before),
          after: field.after === undefined || field.after === null ? "" : String(field.after),
          changed: field.changed === true,
          addedLines: Number((field.lines as { added?: number } | undefined)?.added ?? 0),
          removedLines: Number((field.lines as { removed?: number } | undefined)?.removed ?? 0),
          previewBefore: diffPreview((field.linePreview as Array<{ kind: string; text: string }> | undefined) ?? [], "del"),
          previewAfter: diffPreview((field.linePreview as Array<{ kind: string; text: string }> | undefined) ?? [], "add")
        })),
      requiredModuleLabels: requiredModules.map((module) => workPermissionModuleLabels[module as keyof typeof workPermissionModuleLabels] ?? module),
      restricted,
      result: operation.result_summary
        ? { entityId: operation.result_entity_id, versionNo: operation.result_version_no, summary: operation.result_summary }
        : null,
      auditRecords
    };
  }

  // --------------------------------------------------------------- 用户提问

  createQuestion(input: {
    workId: string;
    conversationId: string | null;
    initiator: PlanViewer;
    recipientUserId: string | null;
    question: unknown;
    options: unknown;
    toolCallId?: string;
  }): QuestionView {
    this.assertToolEnabled(input.workId, "ask_user_questions");
    const parsed = askAiUserQuestionInputSchema.parse({ question: input.question, options: input.options });
    const questionId = randomId("aiQ");
    const timestamp = now();
    const expiresAt = isoFromNow(timestamp, this.questionTtlMs);
    this.database.transaction(() => {
      const pending = input.conversationId
        ? this.database.get("SELECT 1 AS present FROM ai_user_questions WHERE conversation_id = ? AND status = 'pending'", input.conversationId)
        : undefined;
      if (pending) throw new AppError(409, "AI_QUESTION_PENDING", "当前对话已有一个待回答问题");
      this.database.run(
        `INSERT INTO ai_user_questions (
          id, work_id, conversation_id, initiator_user_id, recipient_user_id, question,
          options_json, status, tool_call_id, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        questionId,
        input.workId,
        input.conversationId,
        input.initiator?.userId ?? null,
        input.recipientUserId,
        parsed.question,
        JSON.stringify(parsed.options),
        input.toolCallId ?? null,
        timestamp,
        expiresAt
      );
    });
    this.store.audit(input.workId, "ai.question.asked", "ai_user_question", questionId, {
      conversationId: input.conversationId,
      askedBy: input.initiator?.userId ?? null
    });
    return this.getQuestion(questionId, input.workId, input.initiator);
  }

  answerQuestion(questionId: string, workId: string, respondent: PlanViewer, payload: { selectedOption?: number; customAnswer?: string }): QuestionView {
    const row = this.assertAnswerable(questionId, workId, respondent);
    const options = json<Array<string>>(row.options_json, []);
    const customAnswer = payload.customAnswer?.trim().slice(0, 2000) ?? "";
    if (payload.customAnswer !== undefined && !customAnswer) {
      throw new AppError(400, "AI_QUESTION_CUSTOM_ANSWER_INVALID", "自定义回答不能为空");
    }
    let selectedOption: number | null = null;
    let selectedOptionLabel = "";
    if (payload.selectedOption !== undefined) {
      if (payload.selectedOption < 0 || payload.selectedOption >= options.length) {
        throw new AppError(400, "AI_QUESTION_OPTION_INVALID", "选择的选项编号无效");
      }
      selectedOption = payload.selectedOption;
      selectedOptionLabel = options[selectedOption] ?? "";
    }
    if (selectedOption === null && !customAnswer) throw new AppError(400, "AI_QUESTION_ANSWER_REQUIRED", "必须提供回答");
    const isCustom = Boolean(customAnswer);
    const storedAnswerText = customAnswer || selectedOptionLabel;
    const updated = this.database.run(
      `UPDATE ai_user_questions
       SET status = 'answered', selected_option = ?, answer_text = ?, is_custom_answer = ?, decided_at = ?
      WHERE id = ? AND status = 'pending'`,
      selectedOption,
      storedAnswerText,
      isCustom ? 1 : 0,
      now(),
      questionId
    );
    if (updated.changes !== 1) throw new AppError(409, "AI_QUESTION_ALREADY_DECIDED", "该问题已被处理");
    this.store.audit(row.work_id, "ai.question.answered", "ai_user_question", questionId, {
      answeredBy: respondent?.userId ?? null,
      isCustomAnswer: isCustom,
      hasSelectedOption: selectedOption !== null
    });
    return this.getQuestion(questionId, workId, respondent);
  }

  rejectQuestion(questionId: string, workId: string, respondent: PlanViewer): QuestionView {
    const row = this.assertAnswerable(questionId, workId, respondent);
    const updated = this.database.run(
      "UPDATE ai_user_questions SET status = 'rejected', decided_at = ? WHERE id = ? AND status = 'pending'",
      now(),
      questionId
    );
    if (updated.changes !== 1) throw new AppError(409, "AI_QUESTION_ALREADY_DECIDED", "该问题已被处理");
    this.store.audit(row.work_id, "ai.question.rejected", "ai_user_question", questionId, {
      rejectedBy: respondent?.userId ?? null
    });
    return this.getQuestion(questionId, workId, respondent);
  }

  private assertAnswerable(questionId: string, workId: string, respondent: PlanViewer): QuestionRow {
    let row = this.database.get<QuestionRow>("SELECT * FROM ai_user_questions WHERE id = ?", questionId);
    if (!row) throw new AppError(404, "AI_QUESTION_NOT_FOUND", "问题不存在");
    this.assertQuestionViewer(row, workId, respondent);
    if (Date.parse(row.expires_at) < Date.now() && row.status === "pending") {
      this.database.run(
        "UPDATE ai_user_questions SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending'",
        now(),
        questionId
      );
      row = this.database.get<QuestionRow>("SELECT * FROM ai_user_questions WHERE id = ?", questionId)!;
    }
    if (row.status !== "pending") {
      const labels: Record<string, string> = { answered: "已回答", rejected: "已拒绝", expired: "已过期" };
      throw new AppError(409, "AI_QUESTION_CLOSED", `问题已被处理：${labels[row.status] ?? row.status}`);
    }
    if (row.recipient_user_id && respondent?.userId && row.recipient_user_id !== respondent.userId) {
      throw new AppError(403, "AI_QUESTION_RECIPIENT_ONLY", "该提问仅限目标用户回答");
    }
    return row;
  }

  getQuestion(questionId: string, workId: string, viewer: PlanViewer): QuestionView {
    const row = this.database.get<QuestionRow>("SELECT * FROM ai_user_questions WHERE id = ?", questionId);
    if (!row) throw new AppError(404, "AI_QUESTION_NOT_FOUND", "问题不存在");
    this.assertQuestionViewer(row, workId, viewer);
    return this.toQuestionView(row);
  }

  listQuestions(workId: string, viewer: PlanViewer, filters: { conversationId?: string; status?: string; limit?: number } = {}): QuestionView[] {
    const limit = Math.min(Math.max(filters.limit ?? 30, 1), 200);
    const participantClause = viewer?.userId ? " AND (initiator_user_id = ? OR recipient_user_id = ?)" : "";
    const participantParams = viewer?.userId ? [viewer.userId, viewer.userId] : [];
    const rows = filters.conversationId
      ? this.database.all<QuestionRow>(
        `SELECT * FROM ai_user_questions WHERE work_id = ? AND conversation_id = ?${participantClause} ORDER BY created_at DESC LIMIT ?`,
        workId,
        filters.conversationId,
        ...participantParams,
        limit
      )
      : this.database.all<QuestionRow>(
        `SELECT * FROM ai_user_questions WHERE work_id = ?${participantClause} ORDER BY created_at DESC LIMIT ?`,
        workId,
        ...participantParams,
        limit
      );
    return rows
      .map((row) => (row.status === "pending" && Date.parse(row.expires_at) < Date.now() ? this.expireQuestion(row) : row))
      .filter((row) => !filters.status || row.status === filters.status)
      .map((row) => this.toQuestionView(row));
  }

  /** 会话中的最新待回答问题（供聊天界面提示与上下文注入）。 */
  latestPendingQuestion(conversationId: string): QuestionView | null {
    const row = this.database.get<QuestionRow>(
      "SELECT * FROM ai_user_questions WHERE conversation_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
      conversationId
    );
    if (!row) return null;
    if (Date.parse(row.expires_at) < Date.now()) {
      return this.toQuestionView(this.expireQuestion(row));
    }
    return this.toQuestionView(row);
  }

  saveQuestionContinuation(questionId: string, continuation: Record<string, unknown>): void {
    const updated = this.database.run(
      "UPDATE ai_user_questions SET continuation_json = ? WHERE id = ? AND status = 'pending'",
      JSON.stringify(continuation),
      questionId
    );
    if (updated.changes !== 1) throw new AppError(409, "AI_QUESTION_CLOSED", "问题已经无法挂起当前工作流");
  }

  claimQuestionContinuation(questionId: string, workId: string, viewer: PlanViewer): Record<string, unknown> | null {
    const row = this.database.get<QuestionRow>("SELECT * FROM ai_user_questions WHERE id = ?", questionId);
    if (!row) throw new AppError(404, "AI_QUESTION_NOT_FOUND", "问题不存在");
    this.assertQuestionViewer(row, workId, viewer);
    const continuation = json<Record<string, unknown>>(row.continuation_json, {});
    if (typeof continuation.conversationId !== "string" || !continuation.conversationId) return null;
    const claimed = this.database.run(
      "UPDATE ai_user_questions SET resume_state = 'claimed', resumed_at = ? WHERE id = ? AND resume_state = 'pending' AND status IN ('answered', 'rejected', 'expired')",
      now(),
      questionId
    );
    if (claimed.changes !== 1) return null;
    const answer = resolvedQuestionAnswer(row);
    return {
      ...continuation,
      questionId,
      status: row.status,
      answerText: answer.answerText,
      selectedOption: answer.selectedOption,
      selectedOptionLabel: answer.selectedOptionLabel,
      customAnswer: answer.customAnswer,
      toolCallId: row.tool_call_id,
      questionView: this.toQuestionView(row)
    };
  }

  finishQuestionContinuation(questionId: string, result: Record<string, unknown>, failed = false): void {
    this.database.run(
      "UPDATE ai_user_questions SET resume_state = ?, resume_result_json = ? WHERE id = ? AND resume_state = 'claimed'",
      failed ? "failed" : "completed",
      JSON.stringify(result),
      questionId
    );
  }

  /** 聊天流结束前调用的兜底清理：把过期待回答的问题统一落成过期态。 */
  expireStaleQuestions(workId: string): void {
    const timestamp = now();
    this.database.run(
      "UPDATE ai_user_questions SET status = 'expired', decided_at = ? WHERE work_id = ? AND status = 'pending' AND expires_at < ?",
      timestamp,
      workId,
      timestamp
    );
  }

  /**
   * 解析一次对话的“发起人/对话属主”：
   * 侧边栏对话以 created_by_user_id 为唯一归属，发起人与属主一致，
   * 写入权限取两者交集后仍然等价于归属用户本人的权限。
   */
  resolveConversationActor(conversationId: string | null): { viewer: PlanViewer; conversationOwnerUserId: string | null } {
    if (!conversationId) return { viewer: null, conversationOwnerUserId: null };
    const row = this.database.get<{ created_by_user_id: string | null }>(
      "SELECT created_by_user_id FROM ai_conversations WHERE id = ?",
      conversationId
    );
    if (!row) return { viewer: null, conversationOwnerUserId: null };
    const ownerId = row.created_by_user_id === null || row.created_by_user_id === undefined ? null : String(row.created_by_user_id);
    return { viewer: ownerId ? { userId: ownerId, role: "member" } : null, conversationOwnerUserId: ownerId };
  }

  /** 会话最近的审批计划（用于系统上下文注入与回显）。 */
  listRecentPlansForConversation(workId: string, conversationId: string, limit = 5): WritePlanSummaryView[] {
    const rows = this.database.all<PlanRow>(
      "SELECT * FROM ai_write_plans WHERE work_id = ? AND conversation_id = ? ORDER BY created_at DESC LIMIT ?",
      workId,
      conversationId,
      Math.min(Math.max(limit, 1), 10)
    );
    return rows.map((row) => this.expireStalePlan(row)).map((row) => this.toSummaryView(row));
  }

  /** 会话最近的问题（含已回答/已过期），供系统上下文注入。 */
  listRecentQuestionsForConversation(conversationId: string, limit = 3): QuestionView[] {
    const rows = this.database.all<QuestionRow>(
      "SELECT * FROM ai_user_questions WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?",
      conversationId,
      Math.min(Math.max(limit, 1), 10)
    );
    return rows.map((row) => this.toQuestionView(row));
  }

  private expireQuestion(row: QuestionRow): QuestionRow {
    this.database.run(
      "UPDATE ai_user_questions SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending'",
      now(),
      row.id
    );
    return this.database.get<QuestionRow>("SELECT * FROM ai_user_questions WHERE id = ?", row.id)!;
  }

  private toQuestionView(row: QuestionRow): QuestionView {
    const options = json<Array<string>>(row.options_json, []);
    const answer = resolvedQuestionAnswer(row);
    return {
      id: row.id,
      workId: row.work_id,
      conversationId: row.conversation_id,
      question: row.question,
      status: row.status,
      statusLabel: aiQuestionStatusLabels[row.status] ?? row.status,
      options: options.map((label, index) => ({ index, label, recommended: index === 0 })),
      selectedOption: answer.selectedOption,
      selectedOptionLabel: answer.selectedOptionLabel,
      customAnswer: answer.customAnswer,
      answerText: answer.answerText,
      isCustomAnswer: row.is_custom_answer === 1,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      decidedAt: row.decided_at,
      resumeState: row.resume_state
    };
  }
}

// ---------------------------------------------------------------------------
// 内部小工具
// ---------------------------------------------------------------------------

function crossWorkError(): AppError {
  return new AppError(403, "CROSS_WORK_REFERENCE", "跨作品的对象引用不允许出现在同一个计划里");
}

function notFoundPlan(): AppError {
  return new AppError(404, "AI_PLAN_NOT_FOUND", "审批计划不存在");
}

function decisionConflict(row: PlanRow): AppError {
  const label = aiPlanStatusLabels[row.status] ?? row.status;
  return new AppError(409, "AI_PLAN_ALREADY_DECIDED", `该审批已被处理（当前状态：${label}），请刷新审批中心查看结果`);
}

function sanitizeFailure(error: unknown): string {
  if (error instanceof AppError) return error.message;
  if (error instanceof Error) return error.message.slice(0, 500);
  return String(error).slice(0, 500);
}

function requirementForStoredOperation(operation: OperationRow): PlanOperationRequirement {
  const input = json<Record<string, unknown>>(operation.operation_input_json, {});
  if (operation.op_type === "create_annotation") return { toolId: "annotations", writeModules: ["prose"], readModules: [] };
  if (operation.op_type === "create_task") {
    const readModules = analysisTaskReadModules(String(input.taskType), input.scope ?? { type: "book" });
    return { toolId: "analysis_tasks", writeModules: ["ai-analysis"], readModules };
  }
  const entityType = operation.entity_type as AiEntryEntityType;
  return { toolId: (moduleForEntityType(entityType) as AiWriteToolId), writeModules: [], readModules: [] };
}

/**
 * 执行前根据系统生成的字段 diff 准备撤销载荷：
 * 只有真正变化的字段会参与还原（使用库内原始值）。
 * 版本校验由 undoEligibility 基于执行结果版本完成，这里不重复记录。
 */
function prepareUndoPayload(
  detail: Record<string, unknown>,
  entityType: AiEntryEntityType,
  entityId: string
): { undoJson: Record<string, unknown>; beforeFields: Record<string, unknown>; entityId: string } | null {
  void entityType;
  const fields = Array.isArray(detail.fields) ? detail.fields as Array<Record<string, unknown>> : [];
  const beforeFields: Record<string, unknown> = {};
  let hasChangedField = false;
  for (const field of fields) {
    if (field.changed !== true) continue;
    if ("beforeRaw" in field && field.beforeRaw !== undefined) {
      beforeFields[String(field.key)] = field.beforeRaw;
    } else if (typeof field.before === "string" && field.before.length > 0) {
      // 兜底：没有原始值时退回展示文本（旧数据），仅对纯文本字段有意义。
      beforeFields[String(field.key)] = field.before;
    }
    hasChangedField = true;
  }
  if (!hasChangedField) return null;
  return {
    undoJson: { entityId, beforeFields },
    beforeFields,
    entityId
  };
}

function summarizeTaskScope(taskType: string, scope: Record<string, unknown> | undefined): { summary: string; description: string } {
  if (!scope || Object.keys(scope).length === 0) {
    return { summary: "{}", description: "全书范围（默认）" };
  }
  if (scope.type === "book") {
    return { summary: JSON.stringify(scope), description: "全书范围" };
  }
  const parts: string[] = [];
  if (scope.type) parts.push(`范围 ${String(scope.type)}`);
  if (taskType === "relationship-analysis" && Array.isArray(scope.characterIds)) {
    parts.push(`${(scope.characterIds as unknown[]).length} 位指定人物`);
  }
  if (typeof scope.additionalPrompt === "string" && scope.additionalPrompt.trim()) {
    parts.push("含补充提示");
  }
  if (scope.includeAllSettings === true) parts.push("包含全部设定");
  const summary = JSON.stringify(scope).slice(0, 500);
  const description = parts.length > 0 ? parts.join("，") : "自定义分析范围";
  return { summary, description };
}

function diffPreview(lines: Array<{ kind: string; text: string }>, kind: string): string | null {
  const matched = lines.filter((line) => line.kind === kind).map((line) => line.text.split("\n")).flat();
  if (matched.length === 0) return null;
  return matched.slice(0, 12).join("\n");
}

/** 存储行的截断值交给现成的 store 输入类型即可，这里仅去掉元数据包装。 */
function stripMetadata(value: unknown): unknown {
  return value;
}

/** 关系条目的展示标题：优先使用双方人物名称，缺失时退回 ID。 */
function describeRelationshipTitle(current: Record<string, unknown> | undefined): string {
  if (!current) return "";
  const from = String(current.fromCharacterName ?? current.fromCharacterId ?? "");
  const to = String(current.toCharacterName ?? current.toCharacterId ?? "");
  if (from && to) return `${from} → ${to}`;
  return String(current.id ?? "");
}
