import { AI_APPROVAL_STATUSES } from "./ai-approval-contract.js";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import JSZip from "jszip";
import multer from "multer";
import mammoth from "mammoth";
import { randomUUID } from "node:crypto";
import { dirname, extname, join } from "node:path";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pipeline } from "node:stream/promises";
import { z, ZodError } from "zod";
import { AI_PROVIDER_PROTOCOLS } from "./ai-protocol.js";
import { AttachmentStorage } from "./attachment-storage.js";
import { AiManager } from "./ai.js";
import { CredentialVault } from "./credential-vault.js";
import { Database } from "./database.js";
import { assertSafeDocxArchive } from "./docx-security.js";
import { DRAFT_SETTING_MODULES, TASK_TYPES, type ContextScope, type TaskType } from "./domain.js";
import { AppError } from "./errors.js";
import { isOfficialGoogleVertexBaseUrl, parseGoogleServiceAccount } from "./google-vertex-auth.js";
import { HYBRID_SEARCH_TYPES } from "./hybrid-search.js";
import { applyImportFileHints, parseNovelText } from "./parser.js";
import { aiConversationTaskTypes, attachmentPermissionModules, Store, versionedEntityTypes } from "./store.js";
import { paginated, parsePagination } from "./pagination.js";
import { normalizeUploadFileName } from "./utils.js";
import { assertSafeAiEndpoint, createApiRateLimitMiddleware, createAuthenticationRateLimitMiddleware, createBasicAuthMiddleware, createCaptchaRateLimitMiddleware, createExpensiveApiRateLimitMiddleware, createSameOriginMiddleware, createSecurityHeadersMiddleware, createUploadRateLimitMiddleware, enforceCaseInsensitiveRouting, normalizeApiPath, resolveTrustProxySetting, verifySetupToken, type RuntimeSecurityOptions } from "./security.js";
import { ImageCaptchaService } from "./image-captcha.js";
import { assertSafeImportedPlainText, decodeUtf8ImportedText } from "./import-security.js";
import { InvalidRasterImageError, readRasterImageMetadata } from "./image-metadata.js";
import { createRequestLoggingMiddleware, sanitizeRequestPath } from "./http-logging.js";
import { accountReference, logger, sanitizeError } from "./logger.js";
import { currentRequestActor, runWithRequestActor } from "./request-context.js";
import { APP_VERSION } from "./version.js";
import { ReleaseUpdateChecker } from "./release-update.js";
import { canReadWorkModule, canWriteWorkModule, fullWorkModulePermissions, proseReplacementPermissionModules, type WorkModulePermissions } from "./work-permissions.js";
import {
  CollaborationPresence,
  entityEditorPageKey,
  presencePageKinds
} from "./collaboration-presence.js";
import {
  analysisTaskReadModules,
  clearSessionCookie,
  createCliApiScopeMiddleware,
  createUserSessionMiddleware,
  createWorkAuthorizationMiddleware,
  relationshipAnalysisReadModules,
  setSessionCookie,
  UserAuthService,
  type AuthUser
} from "./user-auth.js";

const nonEmpty = z.string().trim().min(1);
const identifier = z.string().trim().min(1).max(200);
const optionalStrings = z.array(z.string()).optional();
const jsonObject = z.record(z.string(), z.unknown());
const chapterTypeSchema = z.enum(["正文", "设定", "作者的话", "其他"]);
const aiConversationTaskTypeSchema = z.enum(aiConversationTaskTypes);
const versionedEntityTypeSchema = z.enum(versionedEntityTypes);
const attachmentPermissionModuleSchema = z.enum(attachmentPermissionModules);
const maximumImportedTextLength = 20_000_000;
const maximumKnowledgeSectionsLength = 4_000_000;

const captchaFields = {
  captchaId: z.string().trim().min(1).max(200),
  captchaAnswer: z.string().trim().min(1).max(16)
};
const usernameSchema = z.string().trim().min(3).max(40).regex(/^[\p{L}\p{N}_.-]+$/u, "用户名只能包含文字、数字、点、下划线和短横线");
const passwordSchema = z.string().min(10).max(200);
const registrationSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  passwordConfirmation: passwordSchema,
  setupToken: z.string().max(500).optional(),
  ...captchaFields
}).strict().refine((input) => input.password === input.passwordConfirmation, {
  path: ["passwordConfirmation"],
  message: "两次输入的密码不一致"
});
const loginSchema = z.object({
  username: z.string().trim().min(1).max(100),
  password: z.string().max(200),
  ...captchaFields
}).strict();
const userUpdateSchema = z.object({ role: z.enum(["admin", "user"]).optional(), status: z.enum(["active", "disabled"]).optional() }).strict();
const memberRoleValueSchema = z.enum(["editor", "settings-editor", "viewer"]);
const moduleAccessSchema = z.enum(["none", "read", "write"]);
const modulePermissionsSchema = z.object({
  prose: moduleAccessSchema,
  drafts: moduleAccessSchema.optional(),
  settings: moduleAccessSchema,
  characters: moduleAccessSchema,
  races: moduleAccessSchema,
  organizations: moduleAccessSchema,
  timeline: moduleAccessSchema,
  relationships: moduleAccessSchema,
  outlines: moduleAccessSchema,
  reviews: moduleAccessSchema,
  "ai-chat": moduleAccessSchema,
  "ai-analysis": moduleAccessSchema,
  "ai-settings": moduleAccessSchema
}).strict().transform((permissions) => ({
  ...permissions,
  drafts: permissions.drafts ?? (
    permissions.prose === "write" && permissions.settings === "write"
      ? "write"
      : permissions.prose === "none" || permissions.settings === "none" ? "none" : "read"
  )
}));
const memberSchema = z.union([
  z.object({ userId: identifier, permissions: modulePermissionsSchema }).strict(),
  z.object({ userId: identifier, role: memberRoleValueSchema }).strict()
]);
const memberPermissionSchema = z.union([
  z.object({ permissions: modulePermissionsSchema }).strict(),
  z.object({ role: memberRoleValueSchema }).strict()
]);
const profileSchema = z.object({ displayName: z.string().trim().min(1).max(80) }).strict();
const passwordChangeSchema = z.object({ currentPassword: z.string().max(200), newPassword: passwordSchema, passwordConfirmation: passwordSchema }).strict().refine((input) => input.newPassword === input.passwordConfirmation, {
  path: ["passwordConfirmation"],
  message: "两次输入的密码不一致"
});
const changeNoteSchema = z.string().trim().max(500).optional();
const expectedVersionNoSchema = z.coerce.number().int().positive().optional();
const presenceHeartbeatSchema = z.object({
  clientId: z.string().uuid(),
  page: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal(presencePageKinds[0]) }).strict(),
    z.object({ kind: z.literal(presencePageKinds[1]), resourceId: identifier }).strict(),
    z.object({ kind: z.literal(presencePageKinds[2]), module: z.enum(["drafts", "settings", "characters", "races", "organizations", "timeline", "comments", "relationships", "outlines", "reviews", "tasks", "approvals", "ai-settings"]) }).strict(),
    z.object({ kind: z.literal(presencePageKinds[3]), module: z.enum(["setting", "character", "race", "organization", "relationship"]), resourceId: identifier.optional() }).strict(),
    z.object({ kind: z.literal(presencePageKinds[4]) }).strict()
  ])
}).strict();

function validateImportedText(text: string): string {
  if (text.length > maximumImportedTextLength) throw new AppError(413, "IMPORT_TEXT_TOO_LARGE", "导入文件解压后的文本超过 2000 万字符限制");
  assertSafeImportedPlainText(text);
  return text;
}

async function extractDocxText(buffer: Buffer): Promise<string> {
  assertSafeDocxArchive(buffer);
  try {
    return (await mammoth.extractRawText({ buffer })).value;
  } catch {
    throw new AppError(415, "INVALID_DOCX_FILE", "文件内容不是有效的 DOCX 文档");
  }
}

const workSchema = z.object({
  title: nonEmpty.max(200),
  author: z.string().max(200).optional(),
  description: z.string().max(10_000).optional(),
  language: z.string().max(30).optional(),
  coverUrl: z.string().url().nullable().optional(),
  tags: optionalStrings
});

const settingSchema = z.object({
  title: nonEmpty.max(200),
  category: nonEmpty.max(100),
  content: nonEmpty.max(200_000),
  tags: optionalStrings,
  status: z.enum(["draft", "pending", "confirmed", "deprecated"]).optional(),
  locked: z.boolean().optional(),
  evidence: z.array(z.unknown()).optional(),
  scope: jsonObject.optional(),
  authorNote: z.string().max(20_000).optional()
});

const draftSchema = z.object({
  draftType: z.enum(["prose", "setting"]),
  volumeId: identifier.nullable().optional(),
  settingModule: z.enum(DRAFT_SETTING_MODULES).nullable().optional(),
  title: nonEmpty.max(200),
  content: z.string().max(200_000)
}).strict();

const characterSchema = z.object({
  name: nonEmpty.max(200),
  isDead: z.boolean().optional(),
  code: z.string().trim().max(200).optional(),
  aliases: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  raceId: identifier.nullable().optional(),
  organizationIds: z.array(identifier).max(100).optional(),
  attributes: jsonObject.optional(),
  profile: jsonObject.optional(),
  currentState: jsonObject.optional(),
  lockedFields: optionalStrings,
  firstChapterId: identifier.nullable().optional()
}).strict();

const characterUpdateSchema = characterSchema.partial().extend({
  changeNote: z.string().trim().max(500).optional()
});

const characterProfileSectionSchema = z.object({
  sectionType: z.enum(["overview", "appearance", "abilities", "personality", "ecology", "background", "history", "legends", "research", "notes", "custom"]).optional(),
  title: nonEmpty.max(200),
  contentMarkdown: z.string().max(500_000).optional(),
  summary: z.string().max(20_000).optional(),
  sortOrder: z.number().int().min(0).max(100_000).optional(),
  sourcePath: z.string().max(2_000).nullable().optional(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/u).nullable().optional()
}).strict();

const timelineSchema = z.object({
  name: nonEmpty.max(300),
  trackId: identifier.nullable().optional(),
  description: z.string().max(100_000).optional(),
  eventType: z.string().max(100).optional(),
  timeLabel: z.string().max(300).optional(),
  timeSort: z.number().finite().nullable().optional(),
  chapterIds: optionalStrings,
  participantIds: optionalStrings,
  location: z.string().max(500).optional(),
  causes: optionalStrings,
  impactScope: z.enum(["personal", "organization", "regional", "world", "galaxy"]).optional(),
  evidence: z.array(z.unknown()).optional(),
  status: z.enum(["candidate", "pending", "confirmed", "deprecated"]).optional()
});

const timelineTrackSchema = z.object({
  name: nonEmpty.max(200),
  description: z.string().max(20_000).optional(),
  sortOrder: z.number().int().min(0).optional()
});

const aiCitationSchema = z.object({
  chapterId: identifier,
  chapterTitle: nonEmpty.max(300),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  text: z.string().max(20_000)
}).refine((citation) => citation.endLine >= citation.startLine, "引用结束行不能早于开始行");

const aiCitationsSchema = z.array(aiCitationSchema).max(20).refine(
  (citations) => citations.reduce((total, citation) => total + citation.text.length, 0) <= 100_000,
  "引用正文总长度不能超过 100000 字符"
);

type AiCitation = z.infer<typeof aiCitationSchema>;

function instructionWithCitations(instruction: string, citations: AiCitation[]): string {
  if (!citations.length) return instruction;
  const references = citations.map((citation) => {
    const lines = citation.startLine === citation.endLine ? `L${citation.startLine}` : `L${citation.startLine}-L${citation.endLine}`;
    return `[${citation.chapterTitle} ${lines}]\n${citation.text}`;
  }).join("\n\n");
  return `${instruction}\n\n作者显式添加了以下正文引用。请优先依据这些引用回答，并在引用相关结论中注明章节与行号：\n\n${references}`;
}

const relationshipSchema = z.object({
  fromCharacterId: identifier,
  toCharacterId: identifier,
  category: z.enum(["family", "social", "emotional", "conflict", "uncertain"]),
  subtype: z.string().max(100).optional(),
  keywords: z.array(z.string().trim().min(1).max(100)).max(30).optional(),
  directed: z.boolean().optional(),
  currentStatus: z.string().max(100).optional(),
  timeRange: jsonObject.optional(),
  confidence: z.number().min(0).max(1).optional(),
  evidence: z.array(z.unknown()).optional(),
  confirmationStatus: z.enum(["pending", "confirmed", "rejected"]).optional(),
  locked: z.boolean().optional()
});

const knowledgeSectionSchema = z.object({
  title: nonEmpty.max(200),
  contentMarkdown: z.string().max(200_000).optional(),
  summary: z.string().max(100_000).optional(),
  sortOrder: z.number().int().min(0).max(100_000).optional()
}).strict();

const knowledgeSectionsSchema = knowledgeSectionSchema.array().max(200).superRefine((sections, context) => {
  const totalLength = sections.reduce((total, section) => total + (section.contentMarkdown?.length ?? 0) + (section.summary?.length ?? 0), 0);
  if (totalLength > maximumKnowledgeSectionsLength) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Markdown 章节总长度不能超过 4000000 个字符" });
  }
});

const organizationSchema = z.object({
  name: nonEmpty.max(200),
  isDissolved: z.boolean().optional(),
  description: z.string().max(100_000).optional(),
  settings: z.array(z.string().trim().min(1).max(20_000)).max(200).optional(),
  settingsMarkdown: z.string().max(200_000).optional(),
  settingsSections: knowledgeSectionsSchema.optional(),
  memberIds: z.array(identifier).max(1000).optional()
}).strict();

const raceSchema = z.object({
  name: nonEmpty.max(200),
  isExtinct: z.boolean().optional(),
  parentRaceId: identifier.nullable().optional(),
  description: z.string().max(100_000).optional(),
  settings: z.array(z.string().trim().min(1).max(20_000)).max(200).optional(),
  settingsMarkdown: z.string().max(200_000).optional(),
  settingsSections: knowledgeSectionsSchema.optional(),
  memberIds: z.array(identifier).max(1000).optional()
}).strict();

const raceHierarchyScopeSchema = z.enum(["roots", "descendants"]).optional();

const chapterOutlineSchema = z.object({
  goal: z.string().max(100_000).optional(),
  conflict: z.string().max(100_000).optional(),
  turningPoint: z.string().max(100_000).optional(),
  notes: z.string().max(100_000).optional(),
  status: z.enum(["draft", "ready", "completed"]).optional()
});

const foreshadowOccurrenceSchema = z.object({
  chapterId: identifier,
  role: z.enum(["setup", "reminder", "payoff"]),
  note: z.string().max(100_000).optional(),
  evidence: z.array(z.unknown()).optional()
});

const foreshadowSchema = z.object({
  title: nonEmpty.max(300),
  description: z.string().max(100_000).optional(),
  status: z.enum(["planned", "planted", "resolved", "abandoned"]).optional(),
  importance: z.enum(["low", "medium", "high"]).optional(),
  plannedPayoffChapterId: identifier.nullable().optional(),
  resolutionNote: z.string().max(100_000).optional(),
  occurrences: z.array(foreshadowOccurrenceSchema).max(500).optional()
});

const reviewSchema = z.object({
  itemType: nonEmpty.max(100),
  severity: z.enum(["low", "medium", "high"]).optional(),
  title: nonEmpty.max(300),
  description: z.string().max(100_000).optional(),
  entityRefs: z.array(z.unknown()).optional(),
  evidence: z.array(z.unknown()).optional(),
  suggestion: z.string().max(100_000).optional(),
  status: z.enum(["pending", "ignored", "fixing", "fixed", "exception"]).optional(),
  resolutionNote: z.string().max(20_000).optional()
});

const providerBaseSchema = z.object({
  name: nonEmpty.max(200),
  baseUrl: z.string().url().refine((value) => value.startsWith("http://") || value.startsWith("https://"), "接口地址必须使用 HTTP 或 HTTPS"),
  apiKey: z.string().trim().min(1).max(50_000),
  protocol: z.enum(AI_PROVIDER_PROTOCOLS).optional(),
  status: z.enum(["enabled", "disabled"]).optional(),
  note: z.string().max(10_000).optional(),
  concurrencyLimit: z.number().int().min(1).max(100).optional(),
  rpmLimit: z.number().int().min(1).max(10_000).optional()
});

function refineProviderApiKey(
  value: { protocol?: (typeof AI_PROVIDER_PROTOCOLS)[number]; baseUrl?: string; apiKey?: string },
  ctx: z.RefinementCtx
): void {
  if (value.protocol === "google-vertex" && value.baseUrl && !isOfficialGoogleVertexBaseUrl(value.baseUrl)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["baseUrl"],
      message: "Google Vertex 接口地址必须使用官方 aiplatform.googleapis.com 或 *-aiplatform.googleapis.com 域名"
    });
  }
  if (!value.apiKey) return;
  const protocol = value.protocol ?? "openai-chat-completions";
  if (protocol === "google-vertex") {
    try {
      parseGoogleServiceAccount(value.apiKey);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["apiKey"],
        message: error instanceof AppError ? error.message : "服务账号 JSON 无效"
      });
    }
    return;
  }
  if (value.apiKey.length > 10_000) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["apiKey"],
      message: "API 密钥过长"
    });
  }
}

const providerSchema = providerBaseSchema.superRefine((value, ctx) => {
  refineProviderApiKey(value, ctx);
});

const providerUpdateSchema = providerBaseSchema.partial().superRefine((value, ctx) => {
  refineProviderApiKey(value, ctx);
});

const modelSchema = z.object({
  displayName: nonEmpty.max(200),
  modelId: nonEmpty.max(300),
  purposes: optionalStrings,
  contextNote: z.string().max(10_000).optional(),
  contextWindow: z.number().int().min(32_768, "模型上下文不能低于 32768 Token").max(2_000_000).optional(),
  outputNote: z.string().max(10_000).optional(),
  preset: jsonObject.optional(),
  thinkingEnabled: z.boolean().optional(),
  multimodalEnabled: z.boolean().optional(),
  imageToolDefault: z.boolean().optional(),
  enabled: z.boolean().optional(),
  note: z.string().max(10_000).optional()
});

const aiPromptSchema = z.object({
  systemPrompt: z.string().max(100_000).optional(),
  imageToolModelId: identifier.nullable().optional()
});

const aiUsageQuerySchema = z.object({
  timezoneOffset: z.coerce.number().int().min(-840).max(840).default(0)
}).strict();

const platformPageSizesSchema = z.object({
  drafts: z.number().int().min(10).max(100).optional(),
  settings: z.number().int().min(10).max(100).optional(),
  characters: z.number().int().min(10).max(100).optional(),
  races: z.number().int().min(10).max(100).optional(),
  organizations: z.number().int().min(10).max(100).optional(),
  timeline: z.number().int().min(10).max(100).optional(),
  outlines: z.number().int().min(10).max(100).optional(),
  relationships: z.number().int().min(10).max(100).optional(),
  comments: z.number().int().min(10).max(100).optional(),
  reviews: z.number().int().min(10).max(100).optional(),
  analysisTasks: z.number().int().min(10).max(100).optional(),
  fileVersions: z.number().int().min(10).max(100).optional()
}).strict();

const platformUiSettingsSchema = z.object({
  toastPosition: z.enum(["bottom-right", "top-right"]).optional(),
  pageSizes: platformPageSizesSchema.optional()
}).strict().refine((input) => input.toastPosition !== undefined || input.pageSizes !== undefined, {
  message: "至少需要提供一项界面设置"
});

const aiToolCallResultSchema = z.object({
  id: z.string().min(1).max(300),
  name: z.string().min(1).max(200),
  calledAt: z.string().datetime({ offset: true }).optional(),
  arguments: z.record(z.string(), z.unknown()).nullable(),
  status: z.enum(["completed", "failed"]),
  result: z.record(z.string(), z.unknown())
}).strict();

const aiProcessStepSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string().min(1).max(300),
    type: z.literal("thinking"),
    round: z.number().int().min(1).max(20),
    content: z.string().max(500_000),
    createdAt: z.string().datetime({ offset: true })
  }).strict(),
  z.object({
    id: z.string().min(1).max(300),
    type: z.literal("intermediate"),
    round: z.number().int().min(1).max(20),
    content: z.string().max(500_000),
    createdAt: z.string().datetime({ offset: true })
  }).strict(),
  z.object({
    id: z.string().min(1).max(300),
    type: z.literal("tool"),
    round: z.number().int().min(1).max(20),
    toolCall: aiToolCallResultSchema,
    createdAt: z.string().datetime({ offset: true })
  }).strict(),
  z.object({
    id: z.string().min(1).max(300),
    type: z.literal("context_compaction"),
    round: z.number().int().min(1).max(20),
    sourceMessageCount: z.number().int().min(1).max(100),
    sourceChars: z.number().int().min(1).max(10_000_000),
    summaryChars: z.number().int().min(1).max(1_000_000),
    createdAt: z.string().datetime({ offset: true })
  }).strict()
]);

const workAiSettingsSchema = z.object({
  systemPrompt: z.string().max(100_000).optional(),
  dailyTokenQuota: z.number().int().min(10_000).max(2_000_000_000).nullable().optional(),
  autoRunEnabled: z.boolean().optional(),
  autoRunConcurrency: z.number().int().min(1).max(8).optional(),
  autoRunBatchLimit: z.number().int().min(1).max(200).optional(),
  autoRunDailyTaskLimit: z.number().int().min(0).max(10_000).optional(),
  autoRunFailureThreshold: z.number().int().min(1).max(10).optional(),
  bookSummaryContextPercent: z.number().int().min(1).max(90).optional(),
  contextCompactThreshold: z.number().int().min(50).max(90).optional(),
  agentToolCallLimit: z.number().int().min(5).max(48).optional(),
  agentToolCallGlobalMultiplier: z.number().int().min(1).max(6).optional(),
  agentTools: z.array(z.enum(["story_index", "read_chapters", "grep", "search_story_entities", "read_character_sections", "search_drafts", "image"])).max(7).optional(),
  alwaysIncludeSettingInfo: z.boolean().optional(),
  titleGenerationModelId: z.string().trim().max(200).optional(),
  imageToolModelId: identifier.nullable().optional()
}).strict();

const contextSchema = z.object({
  type: z.enum(["none", "selection", "chapter", "volume", "book", "settings-catalog", "entities"]),
  chapterId: identifier.optional(),
  volumeId: identifier.optional(),
  selection: z.string().max(200_000).optional(),
  chapterIds: z.array(identifier).max(20).optional(),
  characterIds: optionalStrings,
  mentionCharacterIds: optionalStrings,
  settingIds: optionalStrings,
  raceIds: optionalStrings,
  organizationIds: optionalStrings,
  includeBookSummary: z.boolean().optional(),
  includeSettingInfo: z.boolean().optional()
});

const analysisTaskTypeSchema = z.enum(["structure", "chapter-analysis", "character-extraction", "character-summary", "character-identity-audit", "timeline-analysis", "worldview-analysis", "setting-extraction", "consistency-check", "report-update", "book-analysis"]);
const relationshipSourceRefSchema = z.object({
  sourceType: z.string().trim().min(1).max(50).regex(/^[a-z][a-z-]*$/u),
  sourceId: identifier,
  sourceVersion: z.string().trim().min(1).max(200)
}).strict();
const relationshipAnalysisScopeSchema = z.object({
  type: z.enum(["chapter", "book", "settings"]),
  chapterId: identifier.optional(),
  includeAllSettings: z.boolean().optional(),
  additionalPrompt: z.string().trim().max(10_000).optional(),
  characterIds: z.array(identifier).max(20).optional(),
  preFilterRelationshipSources: z.boolean().optional(),
  previewRelationshipChanges: z.boolean().optional(),
  relationshipSourceRefs: z.array(relationshipSourceRefSchema).max(5_000).optional(),
  replaceExistingRelationships: z.boolean().optional()
}).strict().superRefine((scope, context) => {
  if (scope.type === "chapter" && !scope.chapterId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["chapterId"], message: "指定章节分析必须提供章节标识" });
  }
  if (scope.includeAllSettings && scope.type !== "book") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["includeAllSettings"], message: "包含所有设定仅支持全书人物关系分析" });
  }
  if (scope.characterIds && new Set(scope.characterIds).size !== scope.characterIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["characterIds"], message: "被分析角色不能重复" });
  }
  if (scope.replaceExistingRelationships && !scope.characterIds?.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["replaceExistingRelationships"], message: "覆盖已有关系前必须选择被分析角色" });
  }
  if (scope.preFilterRelationshipSources !== undefined && !scope.characterIds?.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["preFilterRelationshipSources"], message: "来源前置过滤仅支持定向人物关系分析" });
  }
  if (scope.relationshipSourceRefs !== undefined && !scope.characterIds?.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["relationshipSourceRefs"], message: "预检来源仅支持定向人物关系分析" });
  }
  if (scope.relationshipSourceRefs) {
    const keys = scope.relationshipSourceRefs.map((ref) => `${ref.sourceType}:${ref.sourceId}`);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["relationshipSourceRefs"], message: "预检来源不能重复" });
    }
  }
});
const analysisTaskSchema = z.union([
  z.object({ taskType: z.literal("relationship-analysis"), scope: relationshipAnalysisScopeSchema.optional(), modelId: identifier.optional() }).strict(),
  z.object({ taskType: analysisTaskTypeSchema, scope: jsonObject.optional(), modelId: identifier.optional() }).strict().superRefine((input, context) => {
    if (input.scope?.includeAllSettings !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["scope", "includeAllSettings"], message: "包含所有设定仅支持人物关系分析" });
    }
    if (input.scope?.additionalPrompt !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["scope", "additionalPrompt"], message: "额外分析提示仅支持人物关系分析" });
    }
    if (input.scope?.preFilterRelationshipSources !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["scope", "preFilterRelationshipSources"], message: "来源前置过滤仅支持人物关系分析" });
    }
    if (input.scope?.previewRelationshipChanges !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["scope", "previewRelationshipChanges"], message: "变更预览仅支持人物关系分析" });
    }
    if (input.scope?.relationshipSourceRefs !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["scope", "relationshipSourceRefs"], message: "预检来源仅支持人物关系分析" });
    }
    if (input.scope?.characterIds !== undefined || input.scope?.replaceExistingRelationships !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["scope", "characterIds"], message: "被分析角色仅支持人物关系分析" });
    }
  })
]);

export type RuntimeOptions = {
  databasePath: string;
  masterSecret: string;
  attachmentDirectory?: string;
  fetchImpl?: typeof fetch;
  /** 测试用：覆盖 GitHub Release 探测请求。 */
  releaseFetchImpl?: typeof fetch;
  /** GitHub Release 实际探测间隔，最短为 10 分钟。 */
  releaseCheckIntervalMs?: number;
  /** GitHub Release 单次请求超时，最长为 300 秒。 */
  releaseCheckTimeoutMs?: number;
  /** GitHub Release 请求失败后的内部重试次数。 */
  releaseCheckRetries?: number;
  serveUi?: boolean;
  publicPath?: string;
  security?: RuntimeSecurityOptions;
  disableUserAuth?: boolean;
  /** 开发环境专用：使用已有的第一个活动账户进入工作台，不创建会话。 */
  devAuthBypass?: boolean;
  /** 测试用：在验证码接口中回显答案 */
  revealCaptchaAnswer?: boolean;
  /** 当前服务是否由开发模式启动。 */
  developmentServer?: boolean;
};

export type Runtime = {
  app: Express;
  database: Database;
  store: Store;
  ai: AiManager;
  auth: UserAuthService;
  attachmentStorage: AttachmentStorage;
  cleanupAttachments: () => Promise<void>;
  close: () => void;
};

function data(response: Response, value: unknown, status = 200): void {
  response.status(status).json({ data: value });
}

function noContent(response: Response): void {
  response.status(204).end();
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  return schema.parse(value);
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function mapRecords(value: unknown, mapper: (record: Record<string, unknown>) => Record<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map((item) => recordValue(item) ? mapper(item as Record<string, unknown>) : item);
  const record = recordValue(value);
  if (!record) return value;
  if (Array.isArray(record.items)) {
    return { ...record, items: record.items.map((item) => recordValue(item) ? mapper(item as Record<string, unknown>) : item) };
  }
  return mapper(record);
}

function redactCharacterLinks(record: Record<string, unknown>, permissions: WorkModulePermissions): Record<string, unknown> {
  const result = { ...record };
  if (permissions.races === "none") {
    result.raceId = null;
    result.race = null;
    result.species = "";
  }
  if (permissions.organizations === "none") {
    result.organizationIds = [];
    result.organizations = [];
  }
  return result;
}

function redactRaceMembers(record: Record<string, unknown>, permissions: WorkModulePermissions): Record<string, unknown> {
  return permissions.characters === "none" ? { ...record, memberIds: [], members: [] } : record;
}

function redactOrganizationMembers(record: Record<string, unknown>, permissions: WorkModulePermissions): Record<string, unknown> {
  return permissions.characters === "none" ? { ...record, memberIds: [], members: [] } : record;
}

const taskResultPermissionModules: Partial<Record<string, keyof WorkModulePermissions>> = {
  "chapter-analysis": "prose",
  "character-extraction": "characters",
  "character-summary": "characters",
  "character-identity-audit": "reviews",
  "timeline-analysis": "timeline",
  "relationship-analysis": "relationships",
  "worldview-analysis": "settings",
  "setting-extraction": "settings",
  "consistency-check": "reviews",
  "book-analysis": "prose",
  structure: "outlines",
  "report-update": "prose"
};

function requiredTaskResultModule(taskType: unknown): keyof WorkModulePermissions | undefined {
  return taskResultPermissionModules[String(taskType)];
}

function redactTaskCharacterNames(record: Record<string, unknown>, permissions: WorkModulePermissions): Record<string, unknown> {
  const { scopeSummaryWithoutCharacterNames, ...result } = record;
  const proseRestricted = permissions.prose === "none";
  const proseScope = recordValue(result.scope);
  const selectionScopeRestricted = proseRestricted
    && (proseScope?.type === "selection" || String(result.scopeSummary ?? "").startsWith("选定内容："));
  if (selectionScopeRestricted) {
    if (proseScope) {
      const { selection: _selection, ...redactedScope } = proseScope;
      result.scope = redactedScope;
    }
    result.scopeSummary = "选定内容（正文读取权限受限）";
    if (Array.isArray(result.scopeDetails)) {
      result.scopeDetails = result.scopeDetails.map((item) => {
        const detail = recordValue(item);
        return detail?.type === "selection" ? { type: "selection", restricted: true } : item;
      });
    }
  }
  const characterRestricted = permissions.characters === "none";
  if (characterRestricted) {
    if (!selectionScopeRestricted && typeof scopeSummaryWithoutCharacterNames === "string") result.scopeSummary = scopeSummaryWithoutCharacterNames;
    const scope = recordValue(result.scope);
    if (scope) {
      const { targetCharacters: _targetCharacters, ...redactedScope } = scope;
      result.scope = redactedScope;
    }
    const taskResult = recordValue(result.result);
    if (taskResult) {
      const redactedTaskResult = { ...taskResult };
      if (Array.isArray(taskResult.relationshipResults)) {
        redactedTaskResult.relationshipResults = taskResult.relationshipResults.map((value) => {
          const relationship = recordValue(value);
          if (!relationship) return value;
          const {
            fromCharacterName: _fromCharacterName,
            toCharacterName: _toCharacterName,
            ...redactedRelationship
          } = relationship;
          return redactedRelationship;
        });
      }
      const changePreview = recordValue(taskResult.relationshipChangePreview);
      if (changePreview) {
        const { operations: _operations, ...redactedChangePreview } = changePreview;
        redactedTaskResult.relationshipChangePreview = redactedChangePreview;
      }
      const analysisTarget = recordValue(taskResult.analysisTarget);
      if (analysisTarget) {
        const { characterNames: _characterNames, ...redactedAnalysisTarget } = analysisTarget;
        redactedTaskResult.analysisTarget = redactedAnalysisTarget;
      }
      result.result = redactedTaskResult;
    }
  }
  if (permissions.relationships === "none") {
    const taskResult = recordValue(result.result);
    const changePreview = recordValue(taskResult?.relationshipChangePreview);
    if (taskResult && changePreview) {
      const { operations: _operations, ...redactedChangePreview } = changePreview;
      result.result = { ...taskResult, relationshipChangePreview: redactedChangePreview };
    }
  }
  const resultSummary = recordValue(result.resultSummary);
  const characterSensitiveTask = ["character-extraction", "character-summary", "character-identity-audit", "relationship-analysis"]
    .includes(String(result.taskType));
  const requiredResultModule = requiredTaskResultModule(result.taskType);
  const resultRestricted = requiredResultModule !== undefined && permissions[requiredResultModule] === "none";
  if (resultSummary && (resultRestricted || (characterRestricted && characterSensitiveTask))) {
    result.resultSummary = {
      ...resultSummary,
      analysisContent: `${String(resultSummary.title ?? "AI 分析")}；范围：${String(result.scopeSummary ?? "未指定")}`,
      summary: "当前账号缺少相关资料的读取权限，无法展示对应的可读结论。",
      sections: [],
      restricted: true
    };
  }
  return result;
}

function redactAiCallContext(record: Record<string, unknown>, permissions: WorkModulePermissions): Record<string, unknown> {
  const result = { ...record };
  const scope = recordValue(result.contextScope);
  if (!scope) return result;
  const redactedScope = { ...scope };
  let restricted = false;
  if (permissions.prose === "none") {
    for (const field of ["selection", "chapterId", "volumeId", "chapterIds", "includeBookSummary"] as const) {
      if (field in redactedScope) {
        delete redactedScope[field];
        restricted = true;
      }
    }
  }
  if (permissions.characters === "none" && "characterIds" in redactedScope) {
    delete redactedScope.characterIds;
    restricted = true;
  }
  if (permissions.characters === "none" && "mentionCharacterIds" in redactedScope) {
    delete redactedScope.mentionCharacterIds;
    restricted = true;
  }
  if (permissions.races === "none" && "raceIds" in redactedScope) {
    delete redactedScope.raceIds;
    restricted = true;
  }
  if (permissions.organizations === "none" && "organizationIds" in redactedScope) {
    delete redactedScope.organizationIds;
    restricted = true;
  }
  if (permissions.settings === "none" && "settingIds" in redactedScope) {
    delete redactedScope.settingIds;
    restricted = true;
  }
  result.contextScope = restricted ? { ...redactedScope, restricted: true } : redactedScope;
  return result;
}

const proseRestrictedPlaceholder = "（正文读取权限受限）";

function redactContinuationGuard(record: Record<string, unknown>, permissions: WorkModulePermissions): Record<string, unknown> {
  if (permissions.prose !== "none") return record;
  return {
    ...record,
    issues: [],
    contextRefs: {},
    failure: null,
    restricted: true
  };
}

/** 无正文读取权限时移除建议中的原文、指令和检查证据，避免通过 AI 接口绕过 prose=none。 */
function redactSuggestion(record: Record<string, unknown>, permissions: WorkModulePermissions): Record<string, unknown> {
  if (permissions.prose !== "none") return record;
  const guard = recordValue(record.guard);
  return {
    ...record,
    instruction: proseRestrictedPlaceholder,
    sourceText: "",
    ...(guard ? { guard: redactContinuationGuard(guard, permissions) } : {}),
    restricted: true
  };
}

function redactAiConversationMessage(item: unknown, permissions: WorkModulePermissions): unknown {
  if (permissions.prose !== "none") return item;
  const message = recordValue(item);
  if (!message) return item;
  return {
    ...message,
    content: proseRestrictedPlaceholder,
    citations: [],
    metadata: { restricted: true },
    restricted: true
  };
}

/** 无正文读取权限时隐藏对话预览与消息正文，避免历史对话泄露章节原文。 */
function redactAiConversation(record: Record<string, unknown>, permissions: WorkModulePermissions): Record<string, unknown> {
  const readableRecord = permissions.characters === "none" ? { ...record, roleplayCharacter: null } : record;
  const scopedRecord = redactAiCallContext(readableRecord, permissions);
  if (permissions.prose !== "none") return scopedRecord;
  const result: Record<string, unknown> = {
    ...scopedRecord,
    title: proseRestrictedPlaceholder
  };
  if (typeof result.preview === "string" && result.preview.length > 0) {
    result.preview = proseRestrictedPlaceholder;
  }
  if (Array.isArray(result.messages)) {
    result.messages = result.messages.map((item) => redactAiConversationMessage(item, permissions));
  }
  const messagesPage = recordValue(result.messagesPage);
  if (messagesPage && Array.isArray(messagesPage.items)) {
    result.messagesPage = {
      ...messagesPage,
      items: messagesPage.items.map((item) => redactAiConversationMessage(item, permissions))
    };
  }
  return { ...result, restricted: true };
}

/** SSE 错误事件只暴露 AppError 的公开信息；AI_CALL_FAILED 的 failure 已在 AI 层完成密钥脱敏。 */
export function publicAiStreamError(error: unknown): {
  code: string;
  message: string;
  status?: number;
  failure?: string;
  callId?: string;
  providerName?: string;
  providerId?: string;
  modelId?: string;
  modelRecordId?: string;
} {
  if (error instanceof AppError) {
    const details = error.details && typeof error.details === "object" && !Array.isArray(error.details)
      ? error.details as Record<string, unknown>
      : null;
    return {
      code: error.code,
      message: error.message,
      status: error.status,
      ...((error.status < 500 || error.code === "AI_CALL_FAILED") && typeof details?.failure === "string" ? { failure: details.failure } : {}),
      ...(typeof details?.callId === "string" ? { callId: details.callId } : {}),
      ...(typeof details?.providerName === "string" ? { providerName: details.providerName } : {}),
      ...(typeof details?.providerId === "string" ? { providerId: details.providerId } : {}),
      ...(typeof details?.modelId === "string" ? { modelId: details.modelId } : {}),
      ...(typeof details?.modelRecordId === "string" ? { modelRecordId: details.modelRecordId } : {})
    };
  }
  return { code: "AI_STREAM_FAILED", message: "AI 流式调用失败" };
}

function redactMergeRecords(
  value: unknown,
  mapper: (record: Record<string, unknown>) => Record<string, unknown>
): unknown {
  const record = recordValue(value);
  if (!record) return value;
  return {
    ...record,
    ...(recordValue(record.target) ? { target: mapper(record.target as Record<string, unknown>) } : {}),
    ...(recordValue(record.source) ? { source: mapper(record.source as Record<string, unknown>) } : {})
  };
}

function redactVersionSnapshots(
  value: unknown,
  mapper: (record: Record<string, unknown>) => Record<string, unknown>
): unknown {
  return mapRecords(value, (version) => {
    const snapshot = recordValue(version.snapshot);
    return snapshot ? { ...version, snapshot: mapper(snapshot) } : version;
  });
}

export function createRuntime(options: RuntimeOptions): Runtime {
  logger.info("runtime.initializing", {
    databasePath: options.databasePath,
    serveUi: options.serveUi ?? true,
    userAuthDisabled: options.disableUserAuth === true,
    devAuthBypass: options.devAuthBypass === true,
    deploymentAuthEnabled: Boolean(options.security?.auth),
    sameOriginEnforced: options.security?.enforceSameOrigin ?? true
  });
  const database = new Database(options.databasePath);
  const bootId = randomUUID();
  const temporaryAttachmentRoot = options.databasePath === ":memory:" && !options.attachmentDirectory
    ? mkdtempSync(join(tmpdir(), "scriverse-attachments-"))
    : null;
  const attachmentStorage = new AttachmentStorage(
    options.attachmentDirectory ?? temporaryAttachmentRoot ?? join(dirname(options.databasePath), "attachments")
  );
  mkdirSync(attachmentStorage.temporaryDirectory, { recursive: true, mode: 0o700 });
  const auth = new UserAuthService(database);
  const collaborationPresence = new CollaborationPresence();
  const publishRelationshipChange = (workId: string, relationshipId: string): void => {
    const actor = currentRequestActor();
    if (!actor || !workId || !relationshipId) return;
    collaborationPresence.publishChange(workId, entityEditorPageKey("relationship", relationshipId), {
      userId: actor.userId,
      displayName: actor.displayName
    });
  };
  const getDevelopmentUser = (): AuthUser | null => options.devAuthBypass
    ? auth.listUsers().find((user) => user.status === "active") ?? null
    : null;
  const store = new Store(database);
  let attachmentCleanupChain = Promise.resolve();
  const cleanupAttachments = (): Promise<void> => {
    const cleanup = attachmentCleanupChain.then(async () => {
      store.queueUnreferencedAttachments();
      for (const queued of store.listAttachmentCleanupQueue()) {
        if (!store.attachmentCleanupStillRequired(queued.storageKey)) {
          store.completeAttachmentCleanup(queued.storageKey);
          continue;
        }
        try {
          await attachmentStorage.remove(queued.storageKey);
          store.completeAttachmentCleanup(queued.storageKey);
        } catch (error) {
          store.failAttachmentCleanup(queued.storageKey, error instanceof Error ? error.message : "Attachment cleanup failed");
          logger.warn("attachment.cleanup.failed", {
            storageKey: queued.storageKey,
            attempts: queued.attempts + 1,
            error: sanitizeError(error)
          });
        }
      }
    });
    attachmentCleanupChain = cleanup.catch(() => undefined);
    return cleanup;
  };
  const requestPermissions = (request: Request, workId?: string): WorkModulePermissions => {
    if (!request.authUser) return fullWorkModulePermissions();
    const resolvedWorkId = workId ?? auth.resolveWorkId(request.path) ?? undefined;
    if (!resolvedWorkId) return fullWorkModulePermissions();
    return auth.workModulePermissions(request.authUser, resolvedWorkId, request.authMethod !== "api-key") ?? fullWorkModulePermissions();
  };
  const captcha = new ImageCaptchaService({ revealAnswer: options.revealCaptchaAnswer === true });
  const releaseUpdateChecker = new ReleaseUpdateChecker(
    APP_VERSION,
    options.releaseFetchImpl ?? fetch,
    {
      intervalMs: options.releaseCheckIntervalMs,
      timeoutMs: options.releaseCheckTimeoutMs,
      retries: options.releaseCheckRetries
    }
  );
  const ai = new AiManager(
    store,
    new CredentialVault(options.masterSecret),
    options.fetchImpl ?? fetch,
    options.security ? (url) => assertSafeAiEndpoint(url, options.security?.allowPrivateAiEndpoints) : undefined,
    (task, actor) => {
      const requiredModules = analysisTaskReadModules(task.taskType, task.scope);
      const creator = actor ? null : database.get(
        "SELECT created_by_user_id FROM analysis_tasks WHERE id = ?",
        String(task.id)
      );
      const userId = actor?.userId ?? (typeof creator?.created_by_user_id === "string" ? creator.created_by_user_id : null);
      if (!userId) return;
      const user = auth.getUser(userId);
      if (user.status !== "active") throw new AppError(403, "WORK_ACCESS_DENIED", "任务创建者已无法访问这部作品");
      auth.assertWorkAccess(user, String(task.workId), {
        read: requiredModules,
        write: ["ai-analysis"]
      }, false, actor?.allowAdminAccess ?? false);
    },
    attachmentStorage
  );
  const app = express();
  enforceCaseInsensitiveRouting(app);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 30 * 1024 * 1024, files: 1, fields: 10, fieldSize: 64 * 1024, parts: 11, headerPairs: 100 }
  });
  const coverUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 4, fieldSize: 16 * 1024, parts: 5, headerPairs: 100 }
  });
  const avatarUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 1, fieldSize: 1024, parts: 2, headerPairs: 50 }
  });
  const attachmentUpload = multer({
    storage: multer.diskStorage({
      destination: attachmentStorage.temporaryDirectory,
      filename: (_request, _file, callback) => callback(null, randomUUID())
    }),
    limits: { fileSize: 30 * 1024 * 1024, files: 1, fields: 4, fieldSize: 16 * 1024, parts: 5, headerPairs: 100 }
  });

  app.disable("x-powered-by");
  const trustProxy = resolveTrustProxySetting(options.security?.trustProxy);
  if (options.security?.trustProxy === true) {
    logger.warn("security.trust_proxy.coerced", { from: true, to: 1 });
  }
  if (trustProxy !== undefined) app.set("trust proxy", trustProxy);
  app.use(createRequestLoggingMiddleware());
  app.use(createSecurityHeadersMiddleware());

  app.get("/api/health", (_request, response) => {
    data(response, {
      status: "ok",
      bootId,
      version: APP_VERSION,
      protocol: "openai-chat-completions",
      protocols: [...AI_PROVIDER_PROTOCOLS],
      development: options.developmentServer === true
    });
  });
  app.get("/api/update-check", async (_request, response) => {
    data(response, await releaseUpdateChecker.check());
  });

  if (options.security?.auth) app.use(createBasicAuthMiddleware(options.security.auth));
  app.use(createAuthenticationRateLimitMiddleware());
  app.use(createCaptchaRateLimitMiddleware());
  app.use(createApiRateLimitMiddleware(options.security?.apiRateLimit, options.security?.apiRateWindowMs));
  if (options.security?.enforceSameOrigin ?? true) app.use(createSameOriginMiddleware());
  app.use(express.json({ limit: "2mb" }));

  app.get("/api/auth/session", (request, response) => {
    const session = auth.authenticate(request);
    const registrationOpen = options.security?.allowRegistration === true;
    const setupRequired = !auth.hasUsers();
    const setupTokenRequired = setupRequired && Boolean(options.security?.setupToken);
    const developmentUser = getDevelopmentUser();
    if (!session && developmentUser) {
      data(response, { authenticated: true, user: developmentUser, csrfToken: null, bootId, setupRequired: false, setupTokenRequired: false, registrationOpen });
      return;
    }
    data(response, session
      ? { authenticated: true, user: session.user, csrfToken: session.csrfToken, bootId, setupRequired: false, setupTokenRequired: false, registrationOpen }
      : { authenticated: false, user: null, csrfToken: null, bootId, setupRequired, setupTokenRequired, registrationOpen });
  });
  app.get("/api/auth/captcha", (_request, response) => {
    data(response, captcha.create());
  });
  app.post("/api/auth/register", (request, response) => {
    if (options.security?.allowRegistration !== true) {
      throw new AppError(403, "REGISTRATION_DISABLED", "当前部署已关闭新用户注册");
    }
    const input = parse(registrationSchema, request.body);
    captcha.consume(input.captchaId, input.captchaAnswer);
    if (!auth.hasUsers() && !verifySetupToken(options.security?.setupToken, input.setupToken)) {
      throw new AppError(403, "SETUP_TOKEN_INVALID", "初始化令牌无效或未配置");
    }
    const result = auth.register({ username: input.username, password: input.password });
    setSessionCookie(response, result.token, request.secure);
    runWithRequestActor(result.session.user, () => store.audit(null, "user.registered", "user", result.session.user.userId, { role: result.session.user.role }));
    logger.info("auth.registration.succeeded", { actorRef: accountReference(result.session.user.userId) });
    data(response, { user: result.session.user, csrfToken: result.session.csrfToken }, 201);
  });
  app.post("/api/auth/login", (request, response) => {
    const input = parse(loginSchema, request.body);
    captcha.consume(input.captchaId, input.captchaAnswer);
    const result = auth.login(input.username, input.password);
    setSessionCookie(response, result.token, request.secure);
    runWithRequestActor(result.session.user, () => store.audit(null, "user.logged-in", "user", result.session.user.userId));
    logger.info("auth.login.succeeded", { actorRef: accountReference(result.session.user.userId) });
    data(response, { user: result.session.user, csrfToken: result.session.csrfToken });
  });
  app.use(createUserSessionMiddleware(auth, {
    disabled: options.disableUserAuth === true,
    resolveBypassUser: getDevelopmentUser
  }));
  app.use(createUploadRateLimitMiddleware());
  app.use(createExpensiveApiRateLimitMiddleware());
  app.use(createCliApiScopeMiddleware(options.disableUserAuth));
  app.use(createWorkAuthorizationMiddleware(auth, options.disableUserAuth));
  app.use((request, response, next) => {
    if (!/^\/api\/works\/[^/]+\/(?:ai-approvals(?:\/|$)|ai-settings\/write-tools(?:\/|$))/iu.test(request.path)) return next();
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return next();
    if (!request.get("origin")) throw new AppError(403, "AI_APPROVAL_ORIGIN_REQUIRED", "AI 审批操作必须由同源页面发起");
    createSameOriginMiddleware()(request, response, next);
  });
  app.get("/api/cli/session", (request, response) => {
    if (!request.authUser || request.authMethod !== "api-key") throw new AppError(401, "API_KEY_REQUIRED", "请使用 API Key 登录");
    data(response, { authenticated: true, user: request.authUser, apiKeyPrefix: request.authApiKey?.prefix ?? null });
  });
  app.delete("/api/auth/session", (request, response) => {
    if (request.authSession) auth.revoke(request.authSession.id);
    clearSessionCookie(response, request.secure);
    noContent(response);
  });
  app.post("/api/auth/onboarding/complete", (request, response) => {
    if (!request.authUser || request.authMethod !== "session") throw new AppError(401, "SESSION_REQUIRED", "请使用网页会话完成新手引导");
    parse(z.object({}).strict(), request.body ?? {});
    const updated = auth.completeOnboarding(request.authUser.userId);
    store.audit(null, "user.onboarding-completed", "user", updated.userId);
    data(response, updated);
  });
  app.patch("/api/auth/profile", (request, response) => {
    if (!request.authUser) throw new AppError(401, "AUTH_REQUIRED", "请先登录");
    const updated = auth.updateProfile(request.authUser.userId, parse(profileSchema, request.body).displayName);
    store.audit(null, "user.profile-updated", "user", updated.userId);
    data(response, updated);
  });
  app.put("/api/auth/avatar", avatarUpload.single("file"), (request, response) => {
    if (!request.authUser) throw new AppError(401, "AUTH_REQUIRED", "请先登录");
    if (!request.file) throw new AppError(400, "FILE_REQUIRED", "请选择 PNG、JPEG 或 WebP 头像");
    try {
      const metadata = readRasterImageMetadata(request.file.buffer);
      const updated = database.transaction(() => {
        const user = auth.setAvatar(request.authUser!.userId, { ...metadata, content: request.file!.buffer });
        store.audit(null, "user.avatar-updated", "user", user.userId, {
          mimeType: metadata.mimeType,
          byteLength: request.file!.buffer.byteLength,
          width: metadata.width,
          height: metadata.height
        });
        return user;
      });
      data(response, updated);
    } catch (error) {
      if (error instanceof InvalidRasterImageError) throw new AppError(415, "INVALID_AVATAR", error.message);
      throw error;
    }
  });
  app.delete("/api/auth/avatar", (request, response) => {
    if (!request.authUser) throw new AppError(401, "AUTH_REQUIRED", "请先登录");
    const updated = database.transaction(() => {
      const user = auth.deleteAvatar(request.authUser!.userId);
      store.audit(null, "user.avatar-deleted", "user", user.userId);
      return user;
    });
    data(response, updated);
  });
  app.patch("/api/auth/password", (request, response) => {
    if (!request.authUser || !request.authSession) throw new AppError(401, "AUTH_REQUIRED", "请先登录");
    const input = parse(passwordChangeSchema, request.body);
    auth.changePassword(request.authUser.userId, request.authSession.id, input.currentPassword, input.newPassword);
    store.audit(null, "user.password-changed", "user", request.authUser.userId);
    noContent(response);
  });
  app.get("/api/auth/api-key", (request, response) => {
    if (!request.authUser || request.authMethod !== "session") throw new AppError(401, "SESSION_REQUIRED", "请使用网页会话管理 API Key");
    data(response, auth.getApiKeyStatus(request.authUser.userId));
  });
  app.post("/api/auth/api-key/reset", (request, response) => {
    if (!request.authUser || request.authMethod !== "session") throw new AppError(401, "SESSION_REQUIRED", "请使用网页会话管理 API Key");
    parse(z.object({}).strict(), request.body ?? {});
    const userId = request.authUser.userId;
    const result = database.transaction(() => {
      const reset = auth.resetApiKey(userId);
      store.audit(null, "user.api-key-reset", "user", userId, { prefix: reset.prefix });
      return reset;
    });
    data(response, result);
  });

  app.get("/api/users", (request, response) => {
    const pagination = parsePagination(request.query);
    data(response, pagination ? auth.listUsersPage(pagination) : auth.listUsers());
  });
  app.get("/api/users/directory", (request, response) => {
    const pagination = parsePagination(request.query);
    const query = String(request.query.q ?? "");
    data(response, pagination ? auth.directoryPage(query, pagination) : auth.directory(query));
  });
  app.get("/api/user-avatars/:userId", (request, response) => {
    const avatar = auth.getAvatar(request.params.userId);
    response.setHeader("Content-Type", avatar.mimeType);
    response.setHeader("Content-Length", String(avatar.byteLength));
    response.setHeader("ETag", `\"${avatar.sha256}\"`);
    response.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    response.send(avatar.content);
  });
  app.patch("/api/users/:userId", (request, response) => {
    if (!request.authUser) throw new AppError(401, "AUTH_REQUIRED", "请先登录");
    if (request.authUser.role !== "admin") throw new AppError(403, "ADMIN_REQUIRED", "该操作仅限系统管理员");
    const updated = auth.updateUser(request.authUser, request.params.userId, parse(userUpdateSchema, request.body));
    store.audit(null, "user.updated", "user", updated.userId, { role: updated.role, status: updated.status });
    data(response, updated);
  });

  app.get("/api/works", (request, response) => {
    const pagination = parsePagination(request.query);
    data(response, pagination ? store.listWorksPage(pagination) : store.listWorks());
  });
  app.post("/api/works", (request, response) => data(response, store.createWork(parse(workSchema, request.body)), 201));
  app.post("/api/works/import", upload.single("file"), async (request, response) => {
    if (!request.file) throw new AppError(400, "FILE_REQUIRED", "请选择要导入的 TXT 或 DOCX 文件");
    const originalFileName = normalizeUploadFileName(request.file.originalname);
    const extension = extname(originalFileName).toLocaleLowerCase();
    if (extension !== ".txt" && extension !== ".docx") throw new AppError(415, "UNSUPPORTED_FILE", "仅支持 TXT 和 DOCX 导入");
    const text = validateImportedText(extension === ".docx"
      ? await extractDocxText(request.file.buffer)
      : decodeUtf8ImportedText(request.file.buffer));
    const parsedNovel = applyImportFileHints(parseNovelText(text), originalFileName);
    const inferredTitle = originalFileName.replace(/\.(txt|docx)$/iu, "").trim() || "未命名作品";
    const input = parse(workSchema, {
      title: typeof request.body.title === "string" && request.body.title.trim() ? request.body.title : inferredTitle,
      author: typeof request.body.author === "string" ? request.body.author : "",
      description: typeof request.body.description === "string" ? request.body.description : ""
    });
    data(response, store.createImportedWork(input, originalFileName, extension.slice(1), parsedNovel), 201);
  });
  app.get("/api/works/:workId", (request, response) => {
    if (request.query.directory === "volumes") {
      data(response, store.getWorkVolumeDirectory(request.params.workId));
      return;
    }
    const pagination = parsePagination(request.query);
    data(response, pagination ? store.getWorkDirectoryPage(request.params.workId, pagination) : store.getWorkDirectory(request.params.workId));
  });
  app.post("/api/works/:workId/presence", (request, response) => {
    if (!request.authUser || request.authMethod !== "session") throw new AppError(401, "SESSION_REQUIRED", "请使用网页会话上报协作状态");
    const input = parse(presenceHeartbeatSchema, request.body);
    data(response, collaborationPresence.heartbeat(request.params.workId, input.clientId, {
      userId: request.authUser.userId,
      username: request.authUser.username,
      displayName: request.authUser.displayName,
      avatarUrl: request.authUser.avatarUrl
    }, input.page));
  });
  app.get("/api/works/:workId/members", (request, response) => {
    const pagination = parsePagination(request.query);
    data(response, pagination ? auth.listMembersPage(request.params.workId, pagination) : auth.listMembers(request.params.workId));
  });
  app.post("/api/works/:workId/members", (request, response) => {
    if (!request.authUser) throw new AppError(401, "AUTH_REQUIRED", "请先登录");
    const input = parse(memberSchema, request.body);
    const permissionInput = "permissions" in input
      ? { permissions: input.permissions as WorkModulePermissions }
      : { role: input.role };
    const members = database.transaction(() => {
      const result = auth.addMember(request.params.workId, input.userId, permissionInput, request.authUser!.userId);
      store.audit(request.params.workId, "work.member-added", "user", input.userId, permissionInput);
      return result;
    });
    data(response, members, 201);
  });
  app.patch("/api/works/:workId/members/:userId", (request, response) => {
    const input = parse(memberPermissionSchema, request.body);
    const permissionInput = "permissions" in input
      ? { permissions: input.permissions as WorkModulePermissions }
      : { role: input.role };
    const members = database.transaction(() => {
      const result = auth.updateMemberPermissions(request.params.workId, request.params.userId, permissionInput);
      store.audit(request.params.workId, "work.member-role-updated", "user", request.params.userId, permissionInput);
      return result;
    });
    data(response, members);
  });
  app.delete("/api/works/:workId/members/:userId", (request, response) => {
    const members = database.transaction(() => {
      const result = auth.removeMember(request.params.workId, request.params.userId);
      store.audit(request.params.workId, "work.member-removed", "user", request.params.userId);
      return result;
    });
    data(response, members);
  });
  app.patch("/api/works/:workId", (request, response) => {
    const { expectedVersionNo, changeNote, ...input } = parse(
      workSchema.partial().extend({ expectedVersionNo: expectedVersionNoSchema, changeNote: changeNoteSchema }).strict(),
      request.body
    );
    data(response, store.updateWork(request.params.workId, input, expectedVersionNo, "manual", null, changeNote));
  });
  app.delete("/api/works/:workId", async (request, response) => {
    const input = parse(z.object({ expectedVersionNo: expectedVersionNoSchema }).strict(), request.body ?? {});
    store.deleteWork(request.params.workId, input.expectedVersionNo);
    await cleanupAttachments();
    noContent(response);
  });
  app.get("/api/works/:workId/cover", (request, response) => {
    const cover = store.getWorkCover(request.params.workId);
    response.setHeader("Content-Type", cover.mimeType);
    response.setHeader("Content-Length", String(cover.byteLength));
    response.setHeader("ETag", `\"${cover.sha256}\"`);
    response.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    response.send(cover.content);
  });
  app.put("/api/works/:workId/cover", coverUpload.single("file"), (request, response) => {
    if (!request.file) throw new AppError(400, "FILE_REQUIRED", "请选择 PNG、JPEG 或 WebP 封面");
    const bytes = request.file.buffer;
    try {
      const metadata = readRasterImageMetadata(bytes);
      const expectedVersionNo = parse(expectedVersionNoSchema, request.body.expectedVersionNo);
      data(response, store.setWorkCover(String(request.params.workId), metadata.mimeType, bytes, expectedVersionNo));
    } catch (error) {
      if (error instanceof InvalidRasterImageError) throw new AppError(415, "INVALID_COVER", error.message);
      throw error;
    }
  });
  app.delete("/api/works/:workId/cover", (request, response) => {
    const input = parse(z.object({ expectedVersionNo: expectedVersionNoSchema }).strict(), request.body ?? {});
    store.deleteWorkCover(request.params.workId, input.expectedVersionNo);
    noContent(response);
  });

  app.get("/api/works/:workId/file-versions", (request, response) => {
    const pagination = parsePagination(request.query);
    data(response, pagination ? store.listFileVersionsPage(request.params.workId, pagination) : store.listFileVersions(request.params.workId));
  });
  app.post("/api/works/:workId/file-versions/:fileVersionId/restore", (request, response) => {
    const input = parse(z.object({ expectedVersionNo: expectedVersionNoSchema }).strict(), request.body ?? {});
    data(response, store.restoreFileVersion(request.params.workId, request.params.fileVersionId, input.expectedVersionNo));
  });
  app.post("/api/works/:workId/import", upload.single("file"), async (request, response) => {
    if (!request.file) throw new AppError(400, "FILE_REQUIRED", "请选择要导入的 TXT 或 DOCX 文件");
    const originalFileName = normalizeUploadFileName(request.file.originalname);
    const extension = extname(originalFileName).toLocaleLowerCase();
    if (extension !== ".txt" && extension !== ".docx") {
      throw new AppError(415, "UNSUPPORTED_FILE", "MVP 仅支持 TXT 和 DOCX 导入");
    }
    const mode = parse(z.enum(["append", "overwrite"]), request.body.mode ?? "overwrite");
    if (mode === "overwrite" && request.authUser) {
      auth.assertWorkAccess(
        request.authUser,
        String(request.params.workId),
        { write: proseReplacementPermissionModules },
        false,
        request.authMethod !== "api-key"
      );
    }
    const text = validateImportedText(extension === ".docx"
      ? await extractDocxText(request.file.buffer)
      : decodeUtf8ImportedText(request.file.buffer));
    const parsed = applyImportFileHints(parseNovelText(text), originalFileName);
    const expectedVersionNo = parse(expectedVersionNoSchema, request.body.expectedVersionNo);
    data(response, store.importNovel(String(request.params.workId), originalFileName, extension.slice(1), parsed, mode, expectedVersionNo), 201);
  });

  app.post("/api/works/:workId/volumes", (request, response) => {
    const input = parse(z.object({ title: nonEmpty.max(200), kind: z.enum(["main", "prequel", "extra", "epilogue", "appendix"]).optional(), description: z.string().max(5_000).optional(), keywords: z.array(nonEmpty.max(100)).max(100).optional() }), request.body);
    data(response, store.createVolume(request.params.workId, input), 201);
  });
  app.patch("/api/volumes/:volumeId", (request, response) => {
    const input = parse(z.object({ title: nonEmpty.max(200).optional(), kind: z.enum(["main", "prequel", "extra", "epilogue", "appendix"]).optional(), description: z.string().max(5_000).optional(), keywords: z.array(nonEmpty.max(100)).max(100).optional(), sortOrder: z.number().int().min(0).optional(), expectedVersionNo: expectedVersionNoSchema, changeNote: changeNoteSchema }).strict(), request.body);
    const { expectedVersionNo, changeNote, ...volumeInput } = input;
    data(response, store.updateVolume(request.params.volumeId, volumeInput, expectedVersionNo, "manual", null, changeNote));
  });
  app.get("/api/volumes/:volumeId", (request, response) => data(response, store.getVolume(request.params.volumeId)));
  app.get("/api/volumes/:volumeId/chapters", (request, response) => {
    const pagination = parsePagination(request.query);
    data(response, pagination
      ? store.listVolumeChaptersPage(request.params.volumeId, pagination)
      : store.listVolumeChapters(request.params.volumeId));
  });
  app.delete("/api/volumes/:volumeId", (request, response) => {
    const input = parse(z.object({ expectedVersionNo: expectedVersionNoSchema }).strict(), request.body ?? {});
    store.deleteVolume(request.params.volumeId, input.expectedVersionNo);
    noContent(response);
  });

  app.post("/api/works/:workId/chapters", (request, response) => {
    const input = parse(z.object({ volumeId: identifier, title: nonEmpty.max(300), content: z.string().max(2_000_000).optional(), chapterType: chapterTypeSchema.optional() }), request.body);
    data(response, store.createChapter(request.params.workId, input), 201);
  });
  app.get("/api/works/:workId/deleted-chapters", (request, response) => {
    const pagination = parsePagination(request.query);
    data(response, pagination
      ? store.listDeletedChaptersPage(request.params.workId, pagination)
      : store.listDeletedChapters(request.params.workId));
  });
  app.get("/api/chapters/:chapterId", (request, response) => data(response, store.getChapter(request.params.chapterId)));
  app.patch("/api/chapters/:chapterId", (request, response) => {
    const input = parse(z.object({ title: nonEmpty.max(300).optional(), content: z.string().max(2_000_000).optional(), excludedFromAnalysis: z.boolean().optional(), chapterType: chapterTypeSchema.optional(), source: z.enum(["manual", "auto"]).optional(), changeNote: changeNoteSchema, expectedVersionNo: expectedVersionNoSchema }).strict(), request.body);
    const { source, changeNote, expectedVersionNo, ...chapterInput } = input;
    const chapter = store.saveChapter(request.params.chapterId, chapterInput, source ?? "manual", null, changeNote, expectedVersionNo);
    data(response, chapter);
  });
  app.delete("/api/chapters/:chapterId", (request, response) => {
    const input = parse(z.object({ expectedVersionNo: expectedVersionNoSchema }).strict(), request.body ?? {});
    store.deleteChapter(request.params.chapterId, input.expectedVersionNo);
    noContent(response);
  });
  app.delete("/api/chapters/:chapterId/permanent", (request, response) => {
    const input = parse(z.object({ expectedVersionNo: expectedVersionNoSchema }).strict(), request.body ?? {});
    store.permanentlyDeleteChapter(request.params.chapterId, input.expectedVersionNo);
    noContent(response);
  });
  app.get("/api/chapters/:chapterId/versions", (request, response) => {
    const pagination = parsePagination(request.query);
    data(response, pagination ? store.listChapterVersionsPage(request.params.chapterId, pagination) : store.listChapterVersions(request.params.chapterId));
  });
  app.get("/api/chapters/:chapterId/insights", (request, response) => {
    const pagination = parsePagination(request.query);
    data(response, pagination ? store.listChapterInsightsPage(request.params.chapterId, pagination) : store.listChapterInsights(request.params.chapterId));
  });
  app.get("/api/chapters/:chapterId/annotations", (request, response) => data(response, store.listChapterAnnotations(request.params.chapterId)));
  app.get("/api/works/:workId/chapter-annotations", (request, response) => {
    const pagination = parsePagination(request.query);
    data(response, pagination
      ? store.listWorkChapterAnnotationsPage(request.params.workId, pagination)
      : store.listWorkChapterAnnotations(request.params.workId));
  });
  app.post("/api/chapters/:chapterId/annotations", (request, response) => {
    const input = parse(z.object({
      kind: z.enum(["note", "todo"]),
      startLine: z.number().int().positive(),
      endLine: z.number().int().positive(),
      note: z.string().trim().min(1).max(2000)
    }).strict().refine((value) => value.endLine >= value.startLine, { message: "结束行不能早于开始行", path: ["endLine"] }), request.body);
    data(response, store.createChapterAnnotation(request.params.chapterId, input), 201);
  });
  app.patch("/api/chapter-annotations/:annotationId", (request, response) => {
    const input = parse(z.object({ note: z.string().trim().min(1).max(2000).optional(), status: z.enum(["open", "resolved"]).optional(), expectedVersionNo: expectedVersionNoSchema }).strict().refine((value) => value.note !== undefined || value.status !== undefined, { message: "至少需要修改一项" }), request.body);
    const { expectedVersionNo, ...update } = input;
    data(response, store.updateChapterAnnotation(request.params.annotationId, update, expectedVersionNo));
  });
  app.delete("/api/chapter-annotations/:annotationId", (request, response) => {
    const input = parse(z.object({ expectedVersionNo: expectedVersionNoSchema }).strict(), request.body ?? {});
    store.deleteChapterAnnotation(request.params.annotationId, input.expectedVersionNo);
    noContent(response);
  });
  app.post("/api/chapters/:chapterId/restore", (request, response) => {
    const input = parse(z.object({ versionNo: z.number().int().positive(), expectedVersionNo: expectedVersionNoSchema }).strict(), request.body);
    const chapter = store.restoreChapter(request.params.chapterId, input.versionNo, input.expectedVersionNo);
    data(response, chapter);
  });
  app.post("/api/chapters/:chapterId/move", (request, response) => {
    const input = parse(z.object({ volumeId: identifier, sortOrder: z.number().int().min(0), expectedVersionNo: expectedVersionNoSchema }).strict(), request.body);
    const { expectedVersionNo, ...moveInput } = input;
    data(response, store.moveChapter(request.params.chapterId, moveInput, expectedVersionNo));
  });
  app.post("/api/works/:workId/chapters/batch", (request, response) => {
    const selectedChapters = z.array(z.object({ id: identifier, expectedVersionNo: z.number().int().positive() }).strict()).min(1).max(200);
    const action = z.discriminatedUnion("type", [
      z.object({ type: z.literal("move"), volumeId: identifier }).strict(),
      z.object({ type: z.literal("setType"), chapterType: chapterTypeSchema }).strict(),
      z.object({ type: z.literal("setAnalysisExclusion"), excludedFromAnalysis: z.boolean() }).strict(),
      z.object({ type: z.literal("delete") }).strict()
    ]);
    const input = parse(z.object({ chapters: selectedChapters, action }).strict(), request.body);
    data(response, store.batchManageChapters(request.params.workId, input.chapters, input.action));
  });

  app.get("/api/works/:workId/outlines", (request, response) => {
    const pagination = parsePagination(request.query);
    data(response, pagination ? store.listChapterOutlinesPage(request.params.workId, pagination) : store.listChapterOutlines(request.params.workId));
  });
  app.get("/api/chapters/:chapterId/outline", (request, response) => data(response, store.getChapterOutline(request.params.chapterId)));
  app.put("/api/chapters/:chapterId/outline", (request, response) => {
    const { changeNote, expectedVersionNo, ...input } = parse(chapterOutlineSchema.extend({ changeNote: changeNoteSchema, expectedVersionNo: expectedVersionNoSchema }).strict(), request.body);
    const outline = store.upsertChapterOutline(request.params.chapterId, input, "manual", null, changeNote, expectedVersionNo);
    data(response, outline);
  });
  app.delete("/api/chapters/:chapterId/outline", (request, response) => {
    const input = parse(z.object({ expectedVersionNo: expectedVersionNoSchema }).strict(), request.body ?? {});
    store.deleteChapterOutline(request.params.chapterId, input.expectedVersionNo);
    noContent(response);
  });

  app.get("/api/works/:workId/foreshadows", (request, response) => {
    const query = parse(z.object({
      status: z.enum(["all", "unresolved", "resolved"]).default("all"),
      currentChapterId: identifier.optional()
    }), request.query);
    const pagination = parsePagination(request.query);
    data(response, pagination
      ? store.listForeshadowsPage(request.params.workId, pagination, query.status, query.currentChapterId)
      : store.listForeshadows(request.params.workId, query.status, query.currentChapterId));
  });
  app.post("/api/works/:workId/foreshadows", (request, response) => {
    const foreshadow = store.createForeshadow(request.params.workId, parse(foreshadowSchema, request.body));
    data(response, foreshadow, 201);
  });
  app.get("/api/foreshadows/:foreshadowId", (request, response) => data(response, store.getForeshadow(request.params.foreshadowId)));
  app.patch("/api/foreshadows/:foreshadowId", (request, response) => {
    const { changeNote, expectedVersionNo, ...input } = parse(foreshadowSchema.partial().extend({ changeNote: changeNoteSchema, expectedVersionNo: expectedVersionNoSchema }).strict(), request.body);
    const foreshadow = store.updateForeshadow(request.params.foreshadowId, input, "manual", null, changeNote, expectedVersionNo);
    data(response, foreshadow);
  });
  app.delete("/api/foreshadows/:foreshadowId", (request, response) => {
    const input = parse(z.object({ expectedVersionNo: expectedVersionNoSchema }).strict(), request.body ?? {});
    store.deleteForeshadow(request.params.foreshadowId, input.expectedVersionNo);
    noContent(response);
  });
  app.post("/api/foreshadows/:foreshadowId/occurrences", (request, response) => {
    const input = parse(foreshadowOccurrenceSchema.extend({ expectedVersionNo: expectedVersionNoSchema }).strict(), request.body);
    const { expectedVersionNo, ...occurrenceInput } = input;
    const occurrence = store.createForeshadowOccurrence(request.params.foreshadowId, occurrenceInput, expectedVersionNo);
    data(response, occurrence, 201);
  });
  app.patch("/api/foreshadow-occurrences/:occurrenceId", (request, response) => {
    const input = parse(foreshadowOccurrenceSchema.partial().extend({ expectedVersionNo: expectedVersionNoSchema }).strict(), request.body);
    const { expectedVersionNo, ...occurrenceInput } = input;
    const occurrence = store.updateForeshadowOccurrence(request.params.occurrenceId, occurrenceInput, expectedVersionNo);
    data(response, occurrence);
  });
  app.delete("/api/foreshadow-occurrences/:occurrenceId", (request, response) => {
    const input = parse(z.object({ expectedVersionNo: expectedVersionNoSchema }).strict(), request.body ?? {});
    store.deleteForeshadowOccurrence(request.params.occurrenceId, input.expectedVersionNo);
    noContent(response);
  });

  app.get("/api/works/:workId/drafts", (request, response) => {
    const query = parse(z.object({
      draftType: z.enum(["prose", "setting"]).optional(),
      includeContent: z.enum(["true", "false"]).default("false")
    }), request.query);
    const pagination = parsePagination(request.query);
    const includeContent = query.includeContent === "true";
    data(response, pagination
      ? store.listDraftsPage(request.params.workId, pagination, query.draftType, includeContent)
      : store.listDrafts(request.params.workId, query.draftType, includeContent));
  });
  app.post("/api/works/:workId/drafts", (request, response) => {
    data(response, store.createDraft(request.params.workId, parse(draftSchema, request.body)), 201);
  });
  app.get("/api/drafts/:draftId", (request, response) => data(response, store.getDraft(request.params.draftId)));
  app.patch("/api/drafts/:draftId", (request, response) => {
    const { changeNote, expectedVersionNo, ...input } = parse(draftSchema.partial().extend({
      changeNote: changeNoteSchema,
      expectedVersionNo: expectedVersionNoSchema
    }).strict(), request.body);
    data(response, store.updateDraft(request.params.draftId, input, "manual", null, changeNote, expectedVersionNo));
  });
  app.delete("/api/drafts/:draftId", (request, response) => {
    const input = parse(z.object({ expectedVersionNo: expectedVersionNoSchema }).strict(), request.body ?? {});
    store.deleteDraft(request.params.draftId, input.expectedVersionNo);
    noContent(response);
  });

  app.get("/api/works/:workId/settings", (request, response) => {
    const pagination = parsePagination(request.query);
    const includeContent = request.query.includeContent === "true";
    data(response, pagination ? store.listSettingsPage(request.params.workId, pagination, includeContent) : store.listSettings(request.params.workId, includeContent));
  });
  app.post("/api/works/:workId/settings", (request, response) => {
    const setting = store.createSetting(request.params.workId, parse(settingSchema, request.body));
    data(response, setting, 201);
  });
  app.get("/api/works/:workId/settings/context", (request, response) => data(response, store.listSettings(request.params.workId, true)));
  app.get("/api/settings/:settingId", (request, response) => data(response, store.getSetting(request.params.settingId)));
  app.patch("/api/settings/:settingId", (request, response) => {
    const { changeNote, expectedVersionNo, ...input } = parse(settingSchema.partial().extend({ changeNote: changeNoteSchema, expectedVersionNo: expectedVersionNoSchema }).strict(), request.body);
    const setting = store.updateSetting(request.params.settingId, input, "manual", null, changeNote, expectedVersionNo);
    data(response, setting);
  });
  app.delete("/api/settings/:settingId", (request, response) => {
    const input = parse(z.object({ expectedVersionNo: expectedVersionNoSchema }).strict(), request.body ?? {});
    store.deleteSetting(request.params.settingId, input.expectedVersionNo);
    noContent(response);
  });

  app.get("/api/works/:workId/characters", (request, response) => {
    const { includeSections, includeMerged } = parse(z.object({
      includeSections: z.enum(["true", "false"]).default("false"),
      includeMerged: z.enum(["0", "1"]).default("0")
    }), request.query);
    const pagination = parsePagination(request.query);
    const includeRaceMarkdown = request.query.includeContent === "true";
    const permissions = requestPermissions(request, request.params.workId);
    const characters = pagination
      ? store.listCharactersPage(request.params.workId, pagination, includeSections === "true", includeMerged === "1", includeRaceMarkdown)
      : store.listCharacters(request.params.workId, includeSections === "true", includeMerged === "1", includeRaceMarkdown);
    data(response, mapRecords(characters, (character) => redactCharacterLinks(character, permissions)));
  });
  app.post("/api/works/:workId/characters", (request, response) => {
    const character = store.createCharacter(request.params.workId, parse(characterSchema, request.body));
    data(response, redactCharacterLinks(character, requestPermissions(request, request.params.workId)), 201);
  });
  app.get("/api/characters/:characterId", (request, response) => {
    data(response, redactCharacterLinks(store.getCharacter(request.params.characterId), requestPermissions(request)));
  });
  app.patch("/api/characters/:characterId", (request, response) => {
    const { changeNote, expectedVersionNo, ...input } = parse(characterUpdateSchema.extend({ expectedVersionNo: expectedVersionNoSchema }), request.body);
    const character = store.updateCharacter(request.params.characterId, input, "manual", null, changeNote, expectedVersionNo);
    data(response, redactCharacterLinks(character, requestPermissions(request)));
  });
  app.get("/api/characters/:characterId/versions", (request, response) => {
    const pagination = parsePagination(request.query);
    const versions = pagination ? store.listCharacterVersionsPage(request.params.characterId, pagination) : store.listCharacterVersions(request.params.characterId);
    const permissions = requestPermissions(request);
    data(response, redactVersionSnapshots(versions, (snapshot) => redactCharacterLinks(snapshot, permissions)));
  });
  app.post("/api/characters/:characterId/restore", (request, response) => {
    const input = parse(z.object({ versionNo: z.number().int().positive(), expectedVersionNo: expectedVersionNoSchema }).strict(), request.body);
    const character = store.restoreCharacter(request.params.characterId, input.versionNo, input.expectedVersionNo);
    data(response, redactCharacterLinks(character, requestPermissions(request)));
  });
  app.delete("/api/characters/:characterId", (request, response) => {
    const input = parse(z.object({ expectedVersionNo: expectedVersionNoSchema }).strict(), request.body ?? {});
    store.deleteCharacter(request.params.characterId, input.expectedVersionNo);
    noContent(response);
  });
  app.post("/api/characters/:characterId/merge", (request, response) => {
    const input = parse(z.object({
      targetCharacterId: identifier,
      expectedTargetVersionNo: z.number().int().positive(),
      expectedSourceVersionNo: z.number().int().positive()
    }).strict(), request.body);
    const result = store.mergeCharacters({
      reviewId: null,
      sourceCharacterId: request.params.characterId,
      ...input
    });
    const permissions = requestPermissions(request);
    data(response, redactMergeRecords(result, (character) => redactCharacterLinks(character, permissions)));
  });
  app.get("/api/characters/:characterId/sections", (request, response) => {
    const pagination = parsePagination(request.query);
    data(response, pagination
      ? store.listCharacterProfileSectionsPage(request.params.characterId, pagination)
      : store.listCharacterProfileSections(request.params.characterId));
  });
  app.post("/api/characters/:characterId/sections", (request, response) => {
    const section = store.createCharacterProfileSection(
      request.params.characterId,
      parse(characterProfileSectionSchema, request.body)
    );
    data(response, section, 201);
  });
  app.get("/api/character-sections/:sectionId", (request, response) => {
    data(response, store.getCharacterProfileSection(request.params.sectionId));
  });
  app.patch("/api/character-sections/:sectionId", (request, response) => {
    const { changeNote, expectedVersionNo, ...input } = parse(
      characterProfileSectionSchema.partial().extend({ changeNote: changeNoteSchema, expectedVersionNo: expectedVersionNoSchema }).strict(),
      request.body
    );
    const section = store.updateCharacterProfileSection(request.params.sectionId, input, "manual", null, changeNote, expectedVersionNo);
    data(response, section);
  });
  app.delete("/api/character-sections/:sectionId", (request, response) => {
    const input = parse(z.object({ expectedVersionNo: expectedVersionNoSchema }).strict(), request.body ?? {});
    store.deleteCharacterProfileSection(request.params.sectionId, input.expectedVersionNo);
    noContent(response);
  });
  app.get("/api/character-sections/:sectionId/versions", (request, response) => {
    const pagination = parsePagination(request.query);
    data(response, pagination
      ? store.listCharacterProfileSectionVersionsPage(request.params.sectionId, pagination)
      : store.listCharacterProfileSectionVersions(request.params.sectionId));
  });
  app.post("/api/character-sections/:sectionId/restore", (request, response) => {
    const input = parse(z.object({ versionNo: z.number().int().positive(), expectedVersionNo: expectedVersionNoSchema }).strict(), request.body);
    const section = store.restoreCharacterProfileSection(request.params.sectionId, input.versionNo, input.expectedVersionNo);
    data(response, section);
  });

  app.get("/api/works/:workId/attachments", (request, response) => {
    const pagination = parsePagination(request.query);
    const permissions = requestPermissions(request, request.params.workId);
    const readable = store.listAttachments(request.params.workId).filter((attachment) => (
      store.attachmentModules(String(attachment.id)).some((module) => canReadWorkModule(permissions, module))
    ));
    data(response, pagination
      ? paginated(readable.slice(pagination.offset, pagination.offset + pagination.limit + 1), pagination, readable.length)
      : readable);
  });
  app.post("/api/works/:workId/attachments", attachmentUpload.single("file"), async (request, response) => {
    if (!request.file) throw new AppError(400, "FILE_REQUIRED", "请选择要上传的图片附件");
    const accessModule = parse(attachmentPermissionModuleSchema, request.query.module ?? "settings");
    let storageKey: string | null = null;
    try {
      const stored = await attachmentStorage.ingest(request.file.path);
      storageKey = stored.storageKey;
      const result = store.createAttachment(String(request.params.workId), {
        originalName: normalizeUploadFileName(request.file.originalname),
        ...stored
      }, accessModule);
      data(response, { ...result.attachment, deduplicated: !result.created }, result.created ? 201 : 200);
    } catch (error) {
      if (storageKey) {
        const inUse = Number(database.get("SELECT COUNT(*) AS count FROM attachments WHERE storage_key = ?", storageKey)?.count ?? 0) > 0;
        if (!inUse) await attachmentStorage.remove(storageKey);
      }
      throw error;
    } finally {
      await rm(request.file.path, { force: true });
    }
  });
  app.get("/api/attachments/:attachmentId/content", async (request, response) => {
    const attachment = store.getAttachment(request.params.attachmentId);
    const permissions = requestPermissions(request, String(attachment.workId));
    if (!store.attachmentModules(request.params.attachmentId).some((module) => canReadWorkModule(permissions, module))) {
      throw new AppError(403, "WORK_MODULE_READ_DENIED", "你没有读取该附件所属资料模块的权限");
    }
    const content = await attachmentStorage.read(String(attachment.storageKey));
    response.setHeader("Content-Type", String(attachment.storedMimeType));
    response.setHeader("Content-Length", String(attachment.storedByteLength));
    response.setHeader("ETag", `"${String(attachment.storedSha256)}"`);
    response.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.send(content);
  });
  app.delete("/api/attachments/:attachmentId", async (request, response) => {
    const attachment = store.getAttachment(request.params.attachmentId);
    const permissions = requestPermissions(request, String(attachment.workId));
    if (!store.attachmentModules(request.params.attachmentId).some((module) => canWriteWorkModule(permissions, module))) {
      throw new AppError(403, "WORK_MODULE_WRITE_DENIED", "你没有编辑该附件所属资料模块的权限");
    }
    store.deleteAttachment(request.params.attachmentId);
    await cleanupAttachments();
    noContent(response);
  });

  app.get("/api/works/:workId/races", (request, response) => {
    const hierarchyScope = parse(raceHierarchyScopeSchema, request.query.scope);
    const pagination = parsePagination(request.query);
    if (hierarchyScope && pagination) {
      throw new AppError(400, "RACE_HIERARCHY_PAGINATION_CONFLICT", "分层种族请求不能同时使用分页参数");
    }
    const includeMarkdown = request.query.includeContent === "true";
    const races = hierarchyScope
      ? hierarchyScope === "roots"
        ? { items: store.listRacesByHierarchyScope(request.params.workId, hierarchyScope, includeMarkdown), total: store.countRaces(request.params.workId) }
        : store.listRacesByHierarchyScope(request.params.workId, hierarchyScope, includeMarkdown)
      : pagination
        ? store.listRacesPage(request.params.workId, pagination, includeMarkdown)
        : store.listRaces(request.params.workId, includeMarkdown);
    const permissions = requestPermissions(request, request.params.workId);
    data(response, mapRecords(races, (race) => redactRaceMembers(race, permissions)));
  });
  app.post("/api/works/:workId/races", (request, response) => {
    const race = store.createRace(request.params.workId, parse(raceSchema, request.body));
    data(response, redactRaceMembers(race, requestPermissions(request, request.params.workId)), 201);
  });
  app.get("/api/races/:raceId", (request, response) => {
    data(response, redactRaceMembers(store.getRace(request.params.raceId), requestPermissions(request)));
  });
  app.patch("/api/races/:raceId", (request, response) => {
    const { changeNote, expectedVersionNo, ...input } = parse(raceSchema.partial().extend({ changeNote: changeNoteSchema, expectedVersionNo: expectedVersionNoSchema }).strict(), request.body);
    const race = store.updateRace(request.params.raceId, input, "manual", null, changeNote, expectedVersionNo);
    data(response, redactRaceMembers(race, requestPermissions(request)));
  });
  app.delete("/api/races/:raceId", (request, response) => {
    const input = parse(z.object({ expectedVersionNo: expectedVersionNoSchema }).strict(), request.body ?? {});
    store.deleteRace(request.params.raceId, input.expectedVersionNo);
    noContent(response);
  });
  app.post("/api/races/:raceId/merge", (request, response) => {
    const input = parse(z.object({ targetRaceId: identifier }).strict(), request.body);
    const result = store.mergeRaces(request.params.raceId, input.targetRaceId);
    const permissions = requestPermissions(request);
    data(response, redactMergeRecords(result, (race) => redactRaceMembers(race, permissions)));
  });

  app.get("/api/works/:workId/organizations", (request, response) => {
    const pagination = parsePagination(request.query);
    const includeMarkdown = request.query.includeContent === "true";
    const organizations = pagination ? store.listOrganizationsPage(request.params.workId, pagination, includeMarkdown) : store.listOrganizations(request.params.workId, includeMarkdown);
    const permissions = requestPermissions(request, request.params.workId);
    data(response, mapRecords(organizations, (organization) => redactOrganizationMembers(organization, permissions)));
  });
  app.post("/api/works/:workId/organizations", (request, response) => {
    const organization = store.createOrganization(request.params.workId, parse(organizationSchema, request.body));
    data(response, redactOrganizationMembers(organization, requestPermissions(request, request.params.workId)), 201);
  });
  app.get("/api/organizations/:organizationId", (request, response) => {
    data(response, redactOrganizationMembers(store.getOrganization(request.params.organizationId), requestPermissions(request)));
  });
  app.patch("/api/organizations/:organizationId", (request, response) => {
    const { changeNote, expectedVersionNo, ...input } = parse(organizationSchema.partial().extend({ changeNote: changeNoteSchema, expectedVersionNo: expectedVersionNoSchema }).strict(), request.body);
    const organization = store.updateOrganization(request.params.organizationId, input, "manual", null, changeNote, expectedVersionNo);
    data(response, redactOrganizationMembers(organization, requestPermissions(request)));
  });
  app.delete("/api/organizations/:organizationId", (request, response) => {
    const input = parse(z.object({ expectedVersionNo: expectedVersionNoSchema }).strict(), request.body ?? {});
    store.deleteOrganization(request.params.organizationId, input.expectedVersionNo);
    noContent(response);
  });
  app.post("/api/organizations/:organizationId/merge", (request, response) => {
    const input = parse(z.object({ targetOrganizationId: identifier }).strict(), request.body);
    const result = store.mergeOrganizations(request.params.organizationId, input.targetOrganizationId);
    const permissions = requestPermissions(request);
    data(response, redactMergeRecords(result, (organization) => redactOrganizationMembers(organization, permissions)));
  });

  app.get("/api/works/:workId/timeline-tracks", (request, response) => {
    const pagination = parsePagination(request.query);
    data(response, pagination ? store.listTimelineTracksPage(request.params.workId, pagination) : store.listTimelineTracks(request.params.workId));
  });
  app.post("/api/works/:workId/timeline-tracks", (request, response) => {
    const track = store.createTimelineTrack(request.params.workId, parse(timelineTrackSchema, request.body));
    data(response, track, 201);
  });
  app.get("/api/timeline-tracks/:trackId", (request, response) => data(response, store.getTimelineTrack(request.params.trackId)));
  app.patch("/api/timeline-tracks/:trackId", (request, response) => {
    const { changeNote, expectedVersionNo, ...input } = parse(timelineTrackSchema.partial().extend({ changeNote: changeNoteSchema, expectedVersionNo: expectedVersionNoSchema }).strict(), request.body);
    const track = store.updateTimelineTrack(request.params.trackId, input, "manual", null, changeNote, expectedVersionNo);
    data(response, track);
  });
  app.delete("/api/timeline-tracks/:trackId", (request, response) => {
    const input = parse(z.object({ expectedVersionNo: expectedVersionNoSchema }).strict(), request.body ?? {});
    store.deleteTimelineTrack(request.params.trackId, input.expectedVersionNo);
    noContent(response);
  });

  app.get("/api/works/:workId/timeline", (request, response) => {
    const pagination = parsePagination(request.query);
    data(response, pagination ? store.listTimelineEventsPage(request.params.workId, pagination) : store.listTimelineEvents(request.params.workId));
  });
  app.post("/api/works/:workId/timeline", (request, response) => {
    const event = store.createTimelineEvent(request.params.workId, parse(timelineSchema, request.body));
    data(response, event, 201);
  });
  app.post("/api/works/:workId/timeline/merge", (request, response) => {
    const input = parse(z.object({
      eventIds: z.array(identifier).min(2),
      name: nonEmpty.max(300),
      description: z.string().max(100_000).optional(),
      timeLabel: z.string().max(300).optional(),
      timeSort: z.number().finite().nullable().optional(),
      expectedVersionNos: z.record(identifier, z.number().int().positive()).optional()
    }).strict(), request.body);
    const { expectedVersionNos, ...mergeInput } = input;
    const merged = store.mergeTimelineEvents(request.params.workId, input.eventIds, mergeInput, expectedVersionNos);
    data(response, merged, 201);
  });
  app.get("/api/timeline/:eventId", (request, response) => data(response, store.getTimelineEvent(request.params.eventId)));
  app.patch("/api/timeline/:eventId", (request, response) => {
    const { changeNote, expectedVersionNo, ...input } = parse(timelineSchema.partial().extend({ changeNote: changeNoteSchema, expectedVersionNo: expectedVersionNoSchema }).strict(), request.body);
    const event = store.updateTimelineEvent(request.params.eventId, input, "manual", null, changeNote, expectedVersionNo);
    data(response, event);
  });
  app.post("/api/timeline/:eventId/split", (request, response) => {
    const input = parse(z.object({
      parts: z.array(z.object({
        name: nonEmpty.max(300),
        description: z.string().max(100_000).optional(),
        timeLabel: z.string().max(300).optional(),
        timeSort: z.number().finite().nullable().optional()
    })).min(2),
      expectedVersionNo: expectedVersionNoSchema
    }).strict(), request.body);
    const split = store.splitTimelineEvent(request.params.eventId, input.parts, input.expectedVersionNo);
    data(response, split, 201);
  });
  app.delete("/api/timeline/:eventId", (request, response) => {
    const input = parse(z.object({ expectedVersionNo: expectedVersionNoSchema }).strict(), request.body ?? {});
    store.deleteTimelineEvent(request.params.eventId, input.expectedVersionNo);
    noContent(response);
  });

  app.get("/api/works/:workId/relationships", (request, response) => {
    const confidence = request.query.minimumConfidence ? Number(request.query.minimumConfidence) : 0;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new AppError(400, "INVALID_CONFIDENCE", "置信度必须在 0 到 1 之间");
    const pagination = parsePagination(request.query);
    data(response, pagination
      ? store.listRelationshipsPage(request.params.workId, pagination, confidence)
      : store.listRelationships(request.params.workId, confidence));
  });
  app.post("/api/works/:workId/relationships", (request, response) => {
    const relationship = store.createRelationship(request.params.workId, parse(relationshipSchema, request.body));
    data(response, relationship, 201);
  });
  app.get("/api/relationships/:relationshipId", (request, response) => data(response, store.getRelationship(request.params.relationshipId)));
  app.patch("/api/relationships/:relationshipId", (request, response) => {
    const { changeNote, expectedVersionNo, ...input } = parse(relationshipSchema.partial().extend({ changeNote: changeNoteSchema, expectedVersionNo: expectedVersionNoSchema }).strict(), request.body);
    const relationship = store.updateRelationship(request.params.relationshipId, input, "manual", null, changeNote, expectedVersionNo);
    publishRelationshipChange(String(relationship.workId), String(relationship.id));
    data(response, relationship);
  });
  app.delete("/api/relationships/:relationshipId", (request, response) => {
    const input = parse(z.object({ expectedVersionNo: expectedVersionNoSchema }).strict(), request.body ?? {});
    const relationship = store.getRelationship(request.params.relationshipId);
    store.deleteRelationship(request.params.relationshipId, input.expectedVersionNo);
    publishRelationshipChange(String(relationship.workId), String(relationship.id));
    noContent(response);
  });

  app.get("/api/entity-versions/:entityType/:entityId", (request, response) => {
    const input = parse(z.object({ entityType: versionedEntityTypeSchema, entityId: identifier }), request.params);
    const pagination = parsePagination(request.query);
    const versions = pagination
      ? store.listEntityVersionsPage(input.entityType, input.entityId, pagination)
      : store.listEntityVersions(input.entityType, input.entityId);
    const permissions = requestPermissions(request);
    if (input.entityType === "race") {
      data(response, redactVersionSnapshots(versions, (snapshot) => redactRaceMembers(snapshot, permissions)));
      return;
    }
    if (input.entityType === "organization") {
      data(response, redactVersionSnapshots(versions, (snapshot) => redactOrganizationMembers(snapshot, permissions)));
      return;
    }
    data(response, versions);
  });
  app.post("/api/entity-versions/:entityType/:entityId/restore", (request, response) => {
    const params = parse(z.object({ entityType: versionedEntityTypeSchema, entityId: identifier }), request.params);
    const input = parse(z.object({ versionNo: z.number().int().positive(), expectedVersionNo: expectedVersionNoSchema }).strict(), request.body);
    data(response, store.restoreEntityVersion(params.entityType, params.entityId, input.versionNo, input.expectedVersionNo));
  });

  app.get("/api/works/:workId/reviews", (request, response) => {
    const status = typeof request.query.status === "string" ? request.query.status : undefined;
    const pagination = parsePagination(request.query);
    data(response, pagination ? store.listReviewItemsPage(request.params.workId, pagination, status) : store.listReviewItems(request.params.workId, status));
  });
  app.post("/api/works/:workId/reviews", (request, response) => data(response, store.createReviewItem(request.params.workId, parse(reviewSchema, request.body)), 201));
  app.get("/api/reviews/:reviewId", (request, response) => data(response, store.getReviewItem(request.params.reviewId)));
  app.patch("/api/reviews/:reviewId", (request, response) => data(response, store.updateReviewItem(request.params.reviewId, parse(reviewSchema.partial(), request.body))));
  app.post("/api/reviews/:reviewId/character-resolution", (request, response) => {
    const input = parse(z.discriminatedUnion("action", [
      z.object({ action: z.literal("keep-separate") }).strict(),
      z.object({
        action: z.literal("merge"),
        targetCharacterId: identifier,
        sourceCharacterId: identifier,
        expectedTargetVersionNo: z.number().int().positive(),
        expectedSourceVersionNo: z.number().int().positive()
      }).strict()
    ]), request.body);
    if (input.action === "keep-separate") {
      data(response, store.resolveCharacterDuplicateReview(request.params.reviewId));
      return;
    }
    data(response, store.mergeCharacters({ reviewId: request.params.reviewId, ...input }));
  });

  app.get("/api/works/:workId/tasks", (request, response) => {
    const permissions = requestPermissions(request, request.params.workId);
    data(response, mapRecords(store.listTaskSummariesPage(
      request.params.workId,
      parsePagination(request.query) ?? { page: 1, limit: 30, offset: 0 }
    ), (task) => redactTaskCharacterNames(task, permissions)));
  });
  app.post("/api/works/:workId/tasks/relationship-source-preview", async (request, response) => {
    const input = parse(z.object({
      scope: relationshipAnalysisScopeSchema,
      modelId: identifier.optional()
    }).strict(), request.body);
    const permissions = requestPermissions(request, request.params.workId);
    const deniedModules = relationshipAnalysisReadModules(input.scope).filter((module) => permissions[module] === "none");
    if (deniedModules.length > 0) {
      throw new AppError(403, "WORK_MODULE_READ_DENIED", "你没有读取人物关系来源预检所需资料模块的权限", {
        modules: deniedModules
      });
    }
    data(response, await ai.previewRelationshipSources(
      request.params.workId,
      input.scope as ContextScope,
      input.modelId
    ));
  });
  app.post("/api/works/:workId/tasks", (request, response) => {
    const input = parse(analysisTaskSchema, request.body);
    data(response, redactTaskCharacterNames(
      ai.createTask(request.params.workId, input),
      requestPermissions(request, request.params.workId)
    ), 201);
  });
  app.post("/api/works/:workId/tasks/auto-run", (request, response) => {
    const permissions = requestPermissions(request, request.params.workId);
    for (const taskId of store.listOldestPendingTaskIds(request.params.workId, store.countPendingTasks(request.params.workId))) {
      const task = store.getTask(taskId);
      const deniedModules = analysisTaskReadModules(task.taskType, task.scope).filter((module) => permissions[module] === "none");
      if (deniedModules.length > 0) {
        throw new AppError(403, "WORK_MODULE_READ_DENIED", "你没有读取待运行分析任务所需资料模块的权限", {
          taskId,
          modules: deniedModules
        });
      }
    }
    data(response, ai.resumeAutoRun(request.params.workId));
  });
  app.get("/api/tasks/:taskId/detail", (request, response) => data(
    response,
    redactTaskCharacterNames(store.getTaskDetail(request.params.taskId), requestPermissions(request))
  ));
  app.get("/api/tasks/:taskId/result", (request, response) => {
    const task = store.getTaskResultPayload(request.params.taskId);
    const permissions = requestPermissions(request);
    const requiredModule = requiredTaskResultModule(task.taskType);
    if (requiredModule && permissions[requiredModule] === "none") {
      throw new AppError(403, "WORK_MODULE_READ_DENIED", "你没有读取该分析结果对应资料模块的权限");
    }
    const redacted = redactTaskCharacterNames(
      task,
      permissions
    );
    data(response, { taskId: task.id, result: redacted.result });
  });
  app.get("/api/tasks/:taskId", (request, response) => data(
    response,
    redactTaskCharacterNames(store.getTask(request.params.taskId), requestPermissions(request))
  ));
  app.get("/api/tasks/:taskId/trace", (request, response) => data(response, ai.getTaskTrace(request.params.taskId)));
  app.get("/api/tasks/:taskId/trace/calls/:callId", (request, response) =>
    data(response, ai.getTaskTraceCall(request.params.taskId, request.params.callId)));
  app.post("/api/tasks/:taskId/run", async (request, response) => {
    const input = parse(z.object({ modelId: identifier.optional() }), request.body ?? {});
    const task = store.getTask(request.params.taskId);
    const permissions = requestPermissions(request, String(task.workId));
    const deniedModules = analysisTaskReadModules(task.taskType, task.scope).filter((module) => permissions[module] === "none");
    if (deniedModules.length > 0) {
      throw new AppError(403, "WORK_MODULE_READ_DENIED", "你没有读取本次分析所需资料模块的权限", {
        modules: deniedModules
      });
    }
    data(response, redactTaskCharacterNames(
      await ai.runTask(request.params.taskId, input.modelId, request.authUser ? {
        userId: request.authUser.userId,
        allowAdminAccess: request.authMethod !== "api-key"
      } : undefined),
      requestPermissions(request)
    ));
  });
  app.post("/api/tasks/:taskId/rerun", (request, response) => {
    const input = parse(z.object({ modelId: identifier.optional() }).strict(), request.body ?? {});
    const task = store.getTask(request.params.taskId);
    const permissions = requestPermissions(request, String(task.workId));
    const deniedModules = analysisTaskReadModules(task.taskType, task.scope).filter((module) => permissions[module] === "none");
    if (deniedModules.length > 0) {
      throw new AppError(403, "WORK_MODULE_READ_DENIED", "你没有读取本次分析所需资料模块的权限", {
        modules: deniedModules
      });
    }
    data(response, redactTaskCharacterNames(
      ai.rerunTask(request.params.taskId, input.modelId),
      requestPermissions(request)
    ), 201);
  });
  app.post("/api/tasks/:taskId/cancel", (request, response) => data(
    response,
    redactTaskCharacterNames(ai.cancelTask(request.params.taskId), requestPermissions(request))
  ));
  app.post("/api/tasks/:taskId/relationship-changes/apply", (request, response) => {
    parse(z.object({}).strict(), request.body ?? {});
    const applied = ai.applyRelationshipChangePreview(request.params.taskId);
    data(response, redactTaskCharacterNames(applied, requestPermissions(request)));
  });
  app.post("/api/tasks/:taskId/relationship-changes/discard", (request, response) => {
    parse(z.object({}).strict(), request.body ?? {});
    data(response, redactTaskCharacterNames(
      ai.discardRelationshipChangePreview(request.params.taskId),
      requestPermissions(request)
    ));
  });

  app.get("/api/platform/ai/providers", (request, response) => {
    const pagination = parsePagination(request.query);
    data(response, pagination ? ai.listProvidersPage(pagination) : ai.listProviders());
  });
  app.post("/api/platform/ai/providers", (request, response) => data(response, ai.createProvider(parse(providerSchema, request.body)), 201));
  app.get("/api/platform/ai/models", (request, response) => {
    const pagination = parsePagination(request.query);
    data(response, pagination ? ai.listPlatformModelsPage(pagination) : ai.listPlatformModels());
  });
  app.get("/api/platform/ai/settings", (_request, response) => data(response, store.getPlatformAiSettings()));
  app.patch("/api/platform/ai/settings", (request, response) => {
    const input = parse(aiPromptSchema, request.body);
    if (input.imageToolModelId) ai.assertImageToolModelAvailable(input.imageToolModelId);
    data(response, store.updatePlatformAiSettings(input));
  });
  app.get("/api/platform/ai/usage", (request, response) => {
    const query = parse(aiUsageQuerySchema, request.query);
    data(response, ai.getPlatformTokenUsage(query.timezoneOffset));
  });
  app.get("/api/ui-settings", (_request, response) => data(response, store.getPlatformUiSettings()));
  app.get("/api/platform/ui-settings", (_request, response) => data(response, store.getPlatformUiSettings()));
  app.patch("/api/platform/ui-settings", (request, response) => {
    data(response, store.updatePlatformUiSettings(parse(platformUiSettingsSchema, request.body)));
  });

  app.get("/api/works/:workId/ai-settings", (request, response) => data(response, store.getWorkAiSettings(request.params.workId)));
  app.get("/api/works/:workId/ai-settings/write-tools", (request, response) => data(response, ai.approvals.getSettings(request.params.workId)));
  app.patch("/api/works/:workId/ai-settings/write-tools", (request, response) => data(response, ai.approvals.updateSettings(request.params.workId, request.body)));
  app.get("/api/works/:workId/ai-approvals", (request, response) => {
    const query = parse(z.object({ offset: z.coerce.number().int().min(0).max(100000).default(0), limit: z.coerce.number().int().min(1).max(100).default(30), status: z.enum(AI_APPROVAL_STATUSES).optional() }).strict(), request.query);
    data(response, ai.approvals.list(request.params.workId, query.offset, query.limit, query.status));
  });
  app.get("/api/works/:workId/ai-approvals/:approvalId", (request, response) => data(response, ai.approvals.get(request.params.workId, request.params.approvalId)));
  app.post("/api/works/:workId/ai-approvals/:approvalId/confirm", (request, response) => {
    parse(z.object({}).strict(), request.body ?? {});
    data(response, ai.approvals.confirm(request.params.workId, request.params.approvalId));
  });
  app.post("/api/works/:workId/ai-approvals/:approvalId/reject", (request, response) => {
    parse(z.object({}).strict(), request.body ?? {});
    data(response, ai.approvals.reject(request.params.workId, request.params.approvalId));
  });
  app.post("/api/works/:workId/ai-approvals/:approvalId/answer", (request, response) => data(response, ai.approvals.answer(request.params.workId, request.params.approvalId, request.body)));
  app.post("/api/works/:workId/ai-approvals/:approvalId/undo", (request, response) => {
    parse(z.object({}).strict(), request.body ?? {});
    data(response, ai.approvals.requestUndo(request.params.workId, request.params.approvalId));
  });
  app.get("/api/works/:workId/ai-settings/usage", (request, response) => {
    const query = parse(aiUsageQuerySchema, request.query);
    data(response, ai.getWorkTokenUsage(request.params.workId, query.timezoneOffset));
  });
  app.get("/api/works/:workId/ai-settings/relationship-search-index", (request, response) => {
    data(response, ai.getRelationshipSearchIndexStatus(request.params.workId));
  });
  app.post("/api/works/:workId/ai-settings/relationship-search-index/sync", (request, response) => {
    const workId = request.params.workId;
    const result = ai.syncRelationshipSearchIndex(workId);
    store.audit(workId, "relationship.search-index.incremental-sync-queued", "work-ai-settings", workId, {
      queuedSourceCount: result.queuedSourceCount
    });
    data(response, result, 202);
  });
  app.post("/api/works/:workId/ai-settings/relationship-search-index/rebuild", (request, response) => {
    const workId = request.params.workId;
    const result = ai.rebuildRelationshipSearchIndex(workId);
    store.audit(workId, "relationship.search-index.rebuild-queued", "work-ai-settings", workId, {
      queuedSourceCount: result.queuedSourceCount
    });
    data(response, result, 202);
  });
  app.patch("/api/works/:workId/ai-settings", (request, response) => {
    const workId = request.params.workId;
    const input = parse(workAiSettingsSchema, request.body);
    if (input.titleGenerationModelId) ai.assertModelAvailable(input.titleGenerationModelId);
    if (input.imageToolModelId) ai.assertImageToolModelAvailable(input.imageToolModelId);
    const before = store.getWorkAiSettings(workId);
    let updated = store.updateWorkAiSettings(workId, input);
    if (updated.autoRunEnabled) {
      if (input.autoRunEnabled === true && !before.autoRunEnabled) updated = ai.resumeAutoRun(workId);
      else ai.scheduleAutoRun(workId);
    }
    data(response, updated);
  });
  app.get("/api/works/:workId/ai-conversations", (request, response) => {
    const pagination = parsePagination({
      page: request.query.page ?? "1",
      limit: request.query.limit ?? "20"
    }) ?? { page: 1, limit: 20, offset: 0 };
    const permissions = requestPermissions(request, request.params.workId);
    data(response, mapRecords(store.listAiConversationsPage(request.params.workId, pagination), (conversation) => (
      redactAiConversation(conversation, permissions)
    )));
  });
  app.post("/api/works/:workId/ai-conversations", (request, response) => {
    const input = parse(z.object({
      title: z.string().max(200).optional(),
      taskType: aiConversationTaskTypeSchema.optional()
    }).strict(), request.body ?? {});
    data(response, store.createAiConversation(request.params.workId, input.title, input.taskType), 201);
  });
  app.get("/api/ai-conversations/:conversationId", (request, response) => {
    const pagination = parsePagination(request.query);
    const focusMessageId = request.query.messageId === undefined
      ? undefined
      : parse(identifier, request.query.messageId);
    const conversation = pagination
      ? store.getAiConversationPage(request.params.conversationId, pagination, focusMessageId)
      : store.getAiConversation(request.params.conversationId);
    const permissions = requestPermissions(request, String(conversation.workId));
    data(response, redactAiConversation(conversation, permissions));
  });
  app.post("/api/ai-conversations/:conversationId/fork", (request, response) => {
    const input = parse(z.object({ messageId: identifier, title: z.string().max(200).optional() }), request.body);
    const forked = store.forkAiConversation(request.params.conversationId, input.messageId, input.title);
    const permissions = requestPermissions(request, String(forked.workId));
    data(response, redactAiConversation(forked, permissions), 201);
  });
  app.patch("/api/ai-conversations/:conversationId/task-type", (request, response) => {
    const input = parse(z.object({ taskType: aiConversationTaskTypeSchema }).strict(), request.body);
    const updated = store.setAiConversationTaskType(request.params.conversationId, input.taskType);
    const permissions = requestPermissions(request, String(updated.workId));
    data(response, redactAiConversation(updated, permissions));
  });
  app.patch("/api/ai-conversations/:conversationId/context-scope", (request, response) => {
    const input = parse(z.object({ scope: contextSchema }).strict(), request.body);
    const updated = store.setAiConversationContextScope(request.params.conversationId, input.scope as ContextScope);
    const permissions = requestPermissions(request, String(updated.workId));
    data(response, redactAiConversation(updated, permissions));
  });
  app.patch("/api/ai-conversations/:conversationId/roleplay", (request, response) => {
    const input = parse(z.object({ characterId: identifier.nullable() }).strict(), request.body);
    const updated = store.setAiConversationRoleplayCharacter(request.params.conversationId, input.characterId);
    const permissions = requestPermissions(request, String(updated.workId));
    data(response, redactAiConversation(updated, permissions));
  });
  app.post("/api/ai-conversations/:conversationId/messages", (request, response) => {
    const input = parse(z.object({
      role: z.enum(["user", "assistant"]),
      content: nonEmpty.max(200_000),
      citations: z.array(z.unknown()).max(100).optional(),
      requestId: identifier.optional(),
      metadata: z.object({
        modelDisplayName: z.string().max(200).optional(),
        outputTokens: z.number().int().min(0).max(10_000_000).optional(),
        cacheHitPercent: z.number().min(0).max(100).optional(),
        processDurationMs: z.number().int().min(0).max(86_400_000).optional(),
        toolCalls: z.array(aiToolCallResultSchema).max(12).optional(),
        processSteps: z.array(aiProcessStepSchema).max(50).optional()
      }).optional()
    }), request.body);
    const message = store.addAiConversationMessage(request.params.conversationId, input);
    const conversation = store.getAiConversationSummary(request.params.conversationId);
    const permissions = requestPermissions(request, String(conversation.workId));
    data(response, redactAiConversationMessage(message, permissions), 201);
  });
  app.post("/api/ai-conversations/:conversationId/context/prepare", async (request, response) => {
    const input = parse(z.object({
      modelId: identifier.optional(),
      scope: contextSchema,
      instruction: z.string().max(100_000).default(""),
      citations: aiCitationsSchema.optional()
    }), request.body ?? {});
    const conversation = store.getAiConversation(request.params.conversationId);
    data(response, await ai.prepareConversationContext({
      conversationId: request.params.conversationId,
      workId: String(conversation.workId),
      modelId: input.modelId,
      scope: input.scope,
      instruction: instructionWithCitations(input.instruction, input.citations ?? [])
    }));
  });
  app.post("/api/ai-conversations/:conversationId/compact", async (request, response) => {
    const input = parse(z.object({ modelId: identifier.optional(), scope: contextSchema }), request.body);
    const conversation = store.getAiConversation(request.params.conversationId);
    const compacted = await ai.compactConversation({
      conversationId: request.params.conversationId,
      workId: String(conversation.workId),
      modelId: input.modelId,
      scope: input.scope
    });
    data(response, {
      ...compacted,
      usage: ai.getContextUsage({
        workId: String(conversation.workId),
        taskType: "chat",
        instruction: "",
        conversationId: request.params.conversationId,
        modelId: input.modelId,
        scope: input.scope
      })
    });
  });

  app.get("/api/works/:workId/providers", (request, response) => {
    store.getWork(request.params.workId);
    data(response, ai.listProviders());
  });
  app.post("/api/works/:workId/providers", (request, response) => {
    store.getWork(request.params.workId);
    data(response, ai.createProvider(parse(providerSchema, request.body)), 201);
  });
  app.get("/api/providers/:providerId", (request, response) => data(response, ai.getProvider(request.params.providerId)));
  app.patch("/api/providers/:providerId", (request, response) => data(response, ai.updateProvider(request.params.providerId, parse(providerUpdateSchema, request.body))));
  app.delete("/api/providers/:providerId", (request, response) => {
    ai.deleteProvider(request.params.providerId);
    noContent(response);
  });
  app.post("/api/providers/:providerId/test", async (request, response) => data(response, await ai.testProvider(request.params.providerId)));
  app.get("/api/providers/:providerId/models", (request, response) => {
    const pagination = parsePagination(request.query);
    data(response, pagination ? ai.listModelsPage(request.params.providerId, pagination) : ai.listModels(request.params.providerId));
  });
  app.post("/api/providers/:providerId/models", (request, response) => data(response, ai.createModel(request.params.providerId, parse(modelSchema, request.body)), 201));
  app.post("/api/models/:modelId/test", async (request, response) => data(response, await ai.testModel(request.params.modelId)));
  app.get("/api/models/:modelId", (request, response) => data(response, ai.getModel(request.params.modelId)));
  app.patch("/api/models/:modelId", (request, response) => data(response, ai.updateModel(request.params.modelId, parse(modelSchema.partial(), request.body))));
  app.delete("/api/models/:modelId", (request, response) => {
    ai.deleteModel(request.params.modelId);
    noContent(response);
  });
  app.get("/api/works/:workId/models", (request, response) => {
    const pagination = parsePagination(request.query);
    data(response, pagination ? ai.listWorkModelsPage(request.params.workId, pagination) : ai.listWorkModels(request.params.workId));
  });
  app.get("/api/works/:workId/task-defaults", (request, response) => {
    const pagination = parsePagination(request.query);
    data(response, pagination ? ai.listTaskDefaultsPage(request.params.workId, pagination) : ai.listTaskDefaults(request.params.workId));
  });
  app.put("/api/works/:workId/task-defaults/:taskType", (request, response) => {
    const taskType = parse(z.enum(TASK_TYPES), request.params.taskType) as TaskType;
    const input = parse(z.object({ modelId: identifier }), request.body);
    data(response, ai.setTaskDefault(request.params.workId, taskType, input.modelId));
  });

  app.get("/api/works/:workId/suggestions", (request, response) => {
    const status = typeof request.query.status === "string" ? request.query.status : undefined;
    const pagination = parsePagination(request.query);
    const permissions = requestPermissions(request, request.params.workId);
    data(response, pagination
      ? mapRecords(ai.listSuggestionsPage(request.params.workId, pagination, status), (suggestion) => redactSuggestion(suggestion, permissions))
      : ai.listSuggestions(request.params.workId, status).map((suggestion) => redactSuggestion(suggestion, permissions)));
  });
  app.post("/api/works/:workId/suggestions", async (request, response) => {
    const input = parse(z.object({
      taskType: z.enum(TASK_TYPES),
      instruction: nonEmpty.max(100_000),
      scope: contextSchema,
      modelId: identifier.optional(),
      parameters: jsonObject.optional(),
      citations: aiCitationsSchema.optional()
    }), request.body);
    const citations = input.citations ?? [];
    for (const citation of citations) {
      if (store.getChapter(citation.chapterId).workId !== request.params.workId) throw new AppError(400, "CITATION_WORK_MISMATCH", "引用章节不属于当前作品");
    }
    data(response, redactSuggestion(await ai.createSuggestion({
      workId: request.params.workId,
      taskType: input.taskType,
      instruction: instructionWithCitations(input.instruction, citations),
      scope: input.scope as ContextScope,
      ...(input.modelId ? { modelId: input.modelId } : {}),
      ...(input.parameters ? { parameters: input.parameters } : {})
    }), requestPermissions(request, request.params.workId)), 201);
  });
  app.post("/api/works/:workId/chat/stream", async (request, response) => {
    const input = parse(z.object({
      instruction: nonEmpty.max(100_000),
      scope: contextSchema,
      modelId: identifier.optional(),
      parameters: jsonObject.optional(),
      citations: aiCitationsSchema.optional(),
      conversationId: identifier.optional(),
      currentMessageId: identifier.optional()
    }), request.body);
    const citations = input.citations ?? [];
    for (const citation of citations) {
      if (store.getChapter(citation.chapterId).workId !== request.params.workId) throw new AppError(400, "CITATION_WORK_MISMATCH", "引用章节不属于当前作品");
    }
    const controller = new AbortController();
    response.on("close", () => {
      if (!response.writableEnded) controller.abort(new Error("浏览器已中断流式请求"));
    });
    response.status(200);
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders();
    const sendEvent = (event: string, payload: unknown): void => {
      if (!response.writableEnded && !response.destroyed) response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    sendEvent("ready", { streaming: true });
    try {
      const conversation = input.conversationId
        ? store.getAiConversationSummary(input.conversationId)
        : store.createAiConversation(request.params.workId);
      if (String(conversation.workId) !== request.params.workId) {
        throw new AppError(400, "CONVERSATION_WORK_MISMATCH", "AI 对话不属于当前作品");
      }
      const conversationId = String(conversation.id);
      const permissions = requestPermissions(request, request.params.workId);
      const prepared = await ai.prepareConversationContext({
        conversationId,
        workId: request.params.workId,
        modelId: input.modelId,
        scope: input.scope as ContextScope,
        instruction: instructionWithCitations(input.instruction, citations),
        excludeConversationMessageId: input.currentMessageId
      });
      sendEvent("context", {
        ...prepared,
        conversation: redactAiConversation({
          ...store.getAiConversationSummary(conversationId),
          contextWarningPending: prepared.action === "warn"
        }, permissions)
      });
      if (prepared.action === "warn") return;
      const userMessage = input.currentMessageId
        ? null
        : store.addAiConversationMessage(conversationId, {
          role: "user",
          content: input.instruction,
          citations
        });
      const currentMessageId = input.currentMessageId ?? String(userMessage?.id ?? "");
      if (userMessage) sendEvent("user_message", { message: redactAiConversationMessage(userMessage, permissions) });
      const suggestion = await ai.createStreamingChat({
        workId: request.params.workId,
        instruction: instructionWithCitations(input.instruction, citations),
        scope: input.scope as ContextScope,
        signal: controller.signal,
        onToolCall: (toolCall, round) => sendEvent("tool_call", { ...toolCall, round }),
        onProcessStep: (step) => sendEvent("process_step", step),
        onContextCompacted: (event) => sendEvent("context_compacted", event),
        conversationId,
        excludeConversationMessageId: currentMessageId,
        ...(currentMessageId ? { assistantMessageRequestId: `assistant:${currentMessageId}` } : {}),
        ...(input.modelId ? { modelId: input.modelId } : {}),
        ...(input.parameters ? { parameters: input.parameters } : {})
      }, (delta) => sendEvent("delta", { delta }));
      sendEvent("complete", {
        suggestionId: suggestion.id,
        callId: suggestion.callId,
        provider: suggestion.provider,
        model: suggestion.model,
        outputTokens: suggestion.outputTokens,
        cacheHitPercent: suggestion.cacheHitPercent,
        chapterVersion: suggestion.chapterVersion,
        toolCalls: suggestion.toolCalls,
        processSteps: suggestion.processSteps,
        contextUsage: suggestion.contextUsage,
        conversationId,
        conversationTitle: suggestion.conversationTitle,
        messageId: typeof suggestion.conversationMessage === "object" && suggestion.conversationMessage !== null
          ? (suggestion.conversationMessage as Record<string, unknown>).id
          : undefined,
        messageCreatedAt: typeof suggestion.conversationMessage === "object" && suggestion.conversationMessage !== null
          ? (suggestion.conversationMessage as Record<string, unknown>).createdAt
          : undefined
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        logger.error("ai.stream.failed", {
          workId: request.params.workId,
          error: sanitizeError(error)
        });
        sendEvent("error", publicAiStreamError(error));
      }
    } finally {
      if (!response.writableEnded && !response.destroyed) response.end();
    }
  });
  app.get("/api/suggestions/:suggestionId", (request, response) => {
    const suggestion = ai.getSuggestion(request.params.suggestionId);
    const permissions = requestPermissions(request, String(suggestion.workId));
    data(response, redactSuggestion(suggestion, permissions));
  });
  app.get("/api/suggestions/:suggestionId/guards", (request, response) => {
    const pagination = parsePagination(request.query);
    const suggestion = ai.getSuggestion(request.params.suggestionId);
    const permissions = requestPermissions(request, String(suggestion.workId));
    data(response, mapRecords(pagination
      ? store.listContinuationGuardsPage(request.params.suggestionId, pagination)
      : store.listContinuationGuards(request.params.suggestionId), (guard) => redactContinuationGuard(guard, permissions)));
  });
  app.post("/api/suggestions/:suggestionId/guard", async (request, response) => {
    const input = parse(z.object({ content: z.string().max(2_000_000).optional() }), request.body ?? {});
    const suggestion = ai.getSuggestion(request.params.suggestionId);
    const permissions = requestPermissions(request, String(suggestion.workId));
    data(response, redactContinuationGuard(await ai.runSuggestionGuard(request.params.suggestionId, input.content), permissions), 201);
  });
  app.post("/api/suggestions/:suggestionId/accept", (request, response) => {
    const input = parse(z.object({ content: z.string().max(2_000_000).optional() }), request.body ?? {});
    data(response, ai.acceptSuggestion(request.params.suggestionId, input.content));
  });
  app.post("/api/suggestions/:suggestionId/reject", (request, response) => {
    const suggestion = ai.rejectSuggestion(request.params.suggestionId);
    const permissions = requestPermissions(request, String(suggestion.workId));
    data(response, redactSuggestion(suggestion, permissions));
  });
  app.get("/api/works/:workId/ai-calls", (request, response) => {
    const pagination = parsePagination(request.query);
    const permissions = requestPermissions(request, request.params.workId);
    data(response, pagination
      ? mapRecords(ai.listCallsPage(request.params.workId, pagination), (call) => redactAiCallContext(call, permissions))
      : ai.listCalls(request.params.workId).map((call) => redactAiCallContext(call, permissions)));
  });

  app.get("/api/works/:workId/search", async (request, response) => {
    const query = parse(z.object({
      q: z.string().trim().min(1).max(500),
      type: z.enum(HYBRID_SEARCH_TYPES).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional()
    }).strict(), request.query);
    const permissions = requestPermissions(request, request.params.workId);
    data(response, await ai.searchWork(request.params.workId, query.q, {
      type: query.type,
      limit: query.limit,
      includeAgentHistory: permissions["ai-chat"] !== "none"
    }));
  });
  app.get("/api/works/:workId/export", async (request, response) => {
    const format = parse(z.enum(["json", "txt", "markdown", "docx"]), request.query.format ?? "json");
    if (format === "json") {
      response.setHeader("Content-Disposition", `attachment; filename=novel-${request.params.workId}.json`);
      data(response, store.exportWork(request.params.workId));
      return;
    }
    if (format === "markdown") {
      const exportName = `novel-${request.params.workId}`;
      const archive = new JSZip();
      archive.file(`${exportName}.md`, store.exportText(request.params.workId, format));
      response.type("application/zip");
      response.setHeader("Content-Disposition", `attachment; filename=${exportName}.zip`);
      await pipeline(archive.generateNodeStream({
        type: "nodebuffer",
        streamFiles: true,
        compression: "DEFLATE",
        compressionOptions: { level: 6 }
      }), response);
      return;
    }
    if (format === "docx") {
      response.type("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      response.setHeader("Content-Disposition", `attachment; filename=novel-${request.params.workId}.docx`);
      response.send(await store.exportDocx(request.params.workId));
      return;
    }
    response.type("text/plain");
    response.setHeader("Content-Disposition", `attachment; filename=novel-${request.params.workId}.txt`);
    response.send(store.exportText(request.params.workId, format));
  });
  app.get("/api/works/:workId/audit-logs", (request, response) => {
    const pagination = parsePagination(request.query);
    data(response, pagination ? store.listAuditLogsPage(request.params.workId, pagination) : store.listAuditLogs(request.params.workId));
  });
  app.get("/api/works/:workId/writing-progress", (request, response) => data(response, store.getWritingProgress(request.params.workId)));
  app.put("/api/works/:workId/writing-goal", (request, response) => {
    const input = parse(z.object({
      dailyGoal: z.number().int().min(0).max(1_000_000),
      targetTotal: z.number().int().min(0).max(100_000_000),
      deadline: z.string().date().nullable()
    }).strict(), request.body);
    data(response, store.updateWritingGoal(request.params.workId, input));
  });

  if (options.serveUi ?? true) {
    const publicPath = options.publicPath ?? join(process.cwd(), "src", "public");
    // index.html 按登录态动态下发：未登录时注入 login-route 类，首帧直接渲染登录页；
    // 已登录时保持骨架屏，由前端恢复会话后进入工作台，避免两种闪烁。
    const sendIndexHtml = (request: Request, response: Response) => {
      const authenticated = options.disableUserAuth === true || auth.authenticate(request) !== null;
      let html = readFileSync(join(publicPath, "index.html"), "utf8");
      if (!authenticated) html = html.replace('<html lang="zh-CN">', '<html lang="zh-CN" class="login-route">');
      if (options.disableUserAuth === true) {
        html = html.replace('<html lang="zh-CN">', '<html lang="zh-CN" class="dev-auth-bypass">');
        html = html.replace('<body class="auth-pending">', '<body>');
        html = html.replace('id="auth-view" class="auth-view"', 'id="auth-view" class="auth-view hidden"');
      }
      response.setHeader("Cache-Control", "no-store");
      response.type("text/html").send(html);
    };
    app.get(["/", "/index.html"], sendIndexHtml);
    const setStaticCacheControl = (response: Response) => {
      const version = response.req.query.v;
      response.setHeader("Cache-Control", typeof version === "string" && version.length > 0
        ? "public, max-age=31536000, immutable"
        : "public, max-age=3600, must-revalidate");
    };
    const vditorPath = join(process.cwd(), "node_modules", "vditor", "dist");
    if (existsSync(vditorPath)) {
      app.use("/vendor/vditor/dist", express.static(vditorPath, {
        cacheControl: false,
        index: false,
        etag: true,
        lastModified: true,
        setHeaders: setStaticCacheControl
      }));
    }
    app.use(express.static(publicPath, {
      cacheControl: false,
      index: false,
      etag: true,
      lastModified: true,
      setHeaders: setStaticCacheControl
    }));
    app.get("/{*path}", (request, response, next) => {
      if (normalizeApiPath(request.path).startsWith("/api/")) return next();
      sendIndexHtml(request, response);
    });
  }

  app.use((_request, _response, next) => next(new AppError(404, "ROUTE_NOT_FOUND", "请求的接口不存在")));
  app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
    const commonFields = { method: request.method, path: sanitizeRequestPath(request.path), error: sanitizeError(error) };
    if (response.headersSent || response.destroyed) {
      logger.warn("http.request.response_stream_failed", commonFields);
      if (!response.destroyed) response.destroy(error instanceof Error ? error : undefined);
      return;
    }
    if (error instanceof ZodError) {
      logger.warn("http.request.validation_failed", { ...commonFields, issuePaths: error.issues.map((issue) => issue.path.join(".")) });
      response.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "请求参数不符合要求",
          details: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
        }
      });
      return;
    }
    if (error instanceof multer.MulterError) {
      logger.warn("http.request.upload_rejected", { ...commonFields, uploadCode: error.code });
      response.status(400).json({ error: { code: "UPLOAD_ERROR", message: error.message } });
      return;
    }
    if (error instanceof SyntaxError && "status" in error && error.status === 400) {
      logger.warn("http.request.invalid_json", commonFields);
      response.status(400).json({ error: { code: "INVALID_JSON", message: "请求体不是有效的 JSON" } });
      return;
    }
    if (error && typeof error === "object" && "type" in error && error.type === "entity.too.large") {
      logger.warn("http.request.body_too_large", commonFields);
      response.status(413).json({ error: { code: "REQUEST_TOO_LARGE", message: "请求体超过大小限制" } });
      return;
    }
    if (error instanceof AppError) {
      const logFields = { ...commonFields, errorCode: error.code, status: error.status };
      if (error.status >= 500) logger.error("http.request.application_error", logFields);
      else logger.warn("http.request.application_error", logFields);
      if (error.code === "LOGIN_LOCKED" && error.details && typeof error.details === "object") {
        const retryAfterSeconds = Number((error.details as Record<string, unknown>).retryAfterSeconds);
        if (Number.isInteger(retryAfterSeconds) && retryAfterSeconds > 0) {
          response.setHeader("Retry-After", String(retryAfterSeconds));
        }
      }
      response.status(error.status).json({ error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } });
      return;
    }
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
      logger.warn("http.request.duplicate_record", commonFields);
      response.status(409).json({ error: { code: "DUPLICATE_RECORD", message: "记录已存在" } });
      return;
    }
    logger.error("http.request.unhandled_error", commonFields);
    response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "服务器内部错误" } });
  });

  logger.info("runtime.ready", { serveUi: options.serveUi ?? true });
  return { app, database, store, ai, auth, attachmentStorage, cleanupAttachments, close: () => {
    logger.info("runtime.closing");
    ai.dispose();
    database.close();
    if (temporaryAttachmentRoot) rmSync(temporaryAttachmentRoot, { recursive: true, force: true });
    logger.info("runtime.closed");
  } };
}
