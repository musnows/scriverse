import { CHARACTER_GENDERS, DRAFT_SETTING_MODULES, type AiInjectedEntities, type CharacterGender, type ContextScope, type DraftSettingModule, type ParsedNovel } from "./domain.js";
import { createHash } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import {
  Database,
  ENTITY_VERSION_BASELINE_MIGRATION_VERSION,
  PLATFORM_AI_WORK_ID,
  SYSTEM_USER_ID,
  type Row
} from "./database.js";
import { exportWorkDocx } from "./docx-export.js";
import { createEpubArchive } from "./epub-export.js";
import { AppError, notFound } from "./errors.js";
import { documentParagraphLineRanges, normalizeWorkSearchQuery, type HybridSearchType } from "./hybrid-search.js";
import { accountReference, logger } from "./logger.js";
import { paginated, paginationSql, type PaginatedResult, type Pagination } from "./pagination.js";
import { currentRequestActor } from "./request-context.js";
import {
  canWriteWorkModule,
  classifyWorkModulePermissions,
  emptyWorkModulePermissions,
  fullWorkModulePermissions,
  storedWorkModulePermissions,
  type WorkModulePermissions,
  type WorkPermissionModule
} from "./work-permissions.js";
import {
  countWords,
  documentShortSearchTerms,
  escapeSqlLikePattern,
  id,
  json,
  normalizeDocumentSearchText,
  now,
  splitDocumentParagraphs
} from "./utils.js";
import { buildWritingCalendar, writingDateKey } from "./writing-progress-time.js";
import { resolveMaxAgentToolCallLimit } from "./ai-tool-results.js";
import { DEFAULT_AI_STREAM_IDLE_TIMEOUT_SECONDS, normalizeAiStreamIdleTimeoutSeconds } from "./ai-stream-timeout.js";
import {
  normalizeRoleplayScenePin,
  roleplayUserTurnDisplayText,
  roleplayUserTurnTitleSource,
  type RoleplayScenePin
} from "./roleplay-turn.js";
import {
  chapterAnnotationLineHashes,
  createChapterLineIds,
  MAX_CHAPTER_LINE_IDS,
  parseChapterAnnotationLineIds,
  parseChapterAnnotationLineHashes,
  parseChapterLineIds,
  reconcileChapterLineIds,
  reanchorChapterAnnotations
} from "./chapter-annotation-anchor.js";

type WorkInput = {
  title: string;
  author?: string;
  description?: string;
  language?: string;
  coverUrl?: string | null;
  tags?: string[];
};

type WorkListBatch = {
  memberships: Map<string, Row>;
  counts: Map<string, Row>;
  covers: Map<string, Row>;
};

export type AdminAiConversationFilters = {
  query?: string;
  workId?: string;
  userId?: string;
};

const WORK_LIST_BATCH_SIZE = 500;
const ENTITY_LIST_BATCH_SIZE = 400;
export const RECYCLE_BIN_RETENTION_DAYS = 30;

type OrganizationMemberSummary = {
  characterId: string;
  name: string;
  role: string;
  note: string;
};

type OrganizationListBatch = {
  members: Map<string, OrganizationMemberSummary[]>;
  versions: Map<string, number>;
};

function recycleBinExpiresAt(deletedAt: string): string {
  return new Date(new Date(deletedAt).getTime() + RECYCLE_BIN_RETENTION_DAYS * 24 * 60 * 60_000).toISOString();
}

type ChapterType = "正文" | "设定" | "作者的话" | "其他";
type ChapterAnnotationKind = "note" | "todo";
type ImportMode = "append" | "overwrite";

type VolumeInput = {
  title: string;
  kind?: string;
  source?: string;
  description?: string;
  keywords?: string[];
  sortOrder?: number;
  storyOrder?: number;
};

export const attachmentPermissionModules = ["prose", "drafts", "settings", "characters", "races", "organizations", "ai-chat"] as const satisfies readonly WorkPermissionModule[];
export const WORK_AGENT_TOOL_IDS = [
  "story_index",
  "read_chapters",
  "grep",
  "search_story_entities",
  "read_character_sections",
  "search_drafts",
  "image",
  "calculate_time"
] as const;
export type WorkAgentToolId = (typeof WORK_AGENT_TOOL_IDS)[number];
const DEFAULT_WORK_AGENT_TOOLS: WorkAgentToolId[] = [...WORK_AGENT_TOOL_IDS];
const LEGACY_DEFAULT_WORK_AGENT_TOOLS = [
  "story_index",
  "read_chapters",
  "grep",
  "search_story_entities",
  "read_character_sections",
  "search_drafts",
  "image"
] as const satisfies readonly WorkAgentToolId[];

export function normalizeWorkAgentTools(value: unknown): WorkAgentToolId[] {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? json<unknown[]>(value, DEFAULT_WORK_AGENT_TOOLS)
      : DEFAULT_WORK_AGENT_TOOLS;
  const enabled = new Set<WorkAgentToolId>();
  for (const item of source) {
    if (typeof item !== "string") continue;
    const toolId = item === "query_story_knowledge" ? "search_story_entities" : item;
    if (WORK_AGENT_TOOL_IDS.includes(toolId as WorkAgentToolId)) enabled.add(toolId as WorkAgentToolId);
  }
  if (LEGACY_DEFAULT_WORK_AGENT_TOOLS.every((toolId) => enabled.has(toolId))) enabled.add("calculate_time");
  return WORK_AGENT_TOOL_IDS.filter((toolId) => enabled.has(toolId));
}
export type AttachmentPermissionModule = typeof attachmentPermissionModules[number];

type PlatformPageSizes = {
  drafts: number;
  settings: number;
  characters: number;
  races: number;
  organizations: number;
  timeline: number;
  outlines: number;
  relationships: number;
  comments: number;
  reviews: number;
  analysisTasks: number;
  fileVersions: number;
};

const galaxyFrameRates = [24, 30, 60, 90, 120, 144, 165, 240] as const;
type GalaxyFrameRate = typeof galaxyFrameRates[number];

const defaultPlatformPageSizes: PlatformPageSizes = {
  drafts: 30,
  settings: 30,
  characters: 30,
  races: 30,
  organizations: 30,
  timeline: 30,
  outlines: 30,
  relationships: 30,
  comments: 30,
  reviews: 30,
  analysisTasks: 30,
  fileVersions: 30
};

function platformPageSizes(value: unknown): PlatformPageSizes {
  const stored = typeof value === "string"
    ? json<Record<string, unknown>>(value, {})
    : value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const pageSize = (key: keyof PlatformPageSizes): number => {
    const candidate = Number(stored[key]);
    return Number.isInteger(candidate) && candidate >= 10 && candidate <= 100
      ? candidate
      : defaultPlatformPageSizes[key];
  };
  return {
    drafts: pageSize("drafts"),
    settings: pageSize("settings"),
    characters: pageSize("characters"),
    races: pageSize("races"),
    organizations: pageSize("organizations"),
    timeline: pageSize("timeline"),
    outlines: pageSize("outlines"),
    relationships: pageSize("relationships"),
    comments: pageSize("comments"),
    reviews: pageSize("reviews"),
    analysisTasks: pageSize("analysisTasks"),
    fileVersions: pageSize("fileVersions")
  };
}

function galaxyFrameRate(value: unknown): GalaxyFrameRate {
  const candidate = Number(value);
  return galaxyFrameRates.includes(candidate as GalaxyFrameRate) ? candidate as GalaxyFrameRate : 30;
}

type SettingInput = {
  title: string;
  category: string;
  content: string;
  tags?: string[];
  status?: string;
  locked?: boolean;
  evidence?: unknown[];
  scope?: Record<string, unknown>;
  authorNote?: string;
};

type DraftInput = {
  draftType: "prose" | "setting";
  volumeId?: string | null;
  settingModule?: DraftSettingModule | null;
  title: string;
  content: string;
};

type CharacterInput = {
  name: string;
  gender?: CharacterGender;
  isDead?: boolean;
  code?: string;
  aliases?: string[];
  raceId?: string | null;
  species?: string;
  organizationIds?: string[];
  attributes?: Record<string, unknown>;
  profile?: Record<string, unknown>;
  currentState?: Record<string, unknown>;
  lockedFields?: string[];
  firstChapterId?: string | null;
};

export type CharacterProfileSectionInput = {
  sectionType?: string;
  title: string;
  contentMarkdown?: string;
  summary?: string;
  sortOrder?: number;
  sourcePath?: string | null;
  sourceHash?: string | null;
};

export type AttachmentInput = {
  originalName: string;
  originalMimeType: string;
  storedMimeType: string;
  originalByteLength: number;
  storedByteLength: number;
  originalSha256: string;
  storedSha256: string;
  storageKey: string;
  width: number;
  height: number;
  pageCount: number;
  animated: boolean;
};

export type CharacterAvatarInput = {
  mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  byteLength: number;
  sha256: string;
  storageKey: string;
  width: number;
  height: number;
};

export type CharacterAvatarMetadata = CharacterAvatarInput & {
  updatedAt: string;
};

export type CharacterAvatarUpdateResult = {
  character: Record<string, unknown>;
  previousStorageKey: string | null;
};

type CharacterSnapshot = {
  name: string;
  gender: CharacterGender;
  isDead: boolean;
  code?: string;
  aliases: string[];
  raceId: string | null;
  species: string;
  organizationIds: string[];
  attributes: Record<string, unknown>;
  profile: Record<string, unknown>;
  currentState: Record<string, unknown>;
  lockedFields: string[];
  firstChapterId: string | null;
};

type TimelineInput = {
  name: string;
  trackId?: string | null;
  description?: string;
  eventType?: string;
  timeLabel?: string;
  timeSort?: number | null;
  chapterIds?: string[];
  participantIds?: string[];
  location?: string;
  causes?: string[];
  impactScope?: string;
  evidence?: unknown[];
  status?: string;
};

type TimelineTrackInput = {
  name: string;
  description?: string;
  sortOrder?: number;
};

type RelationshipInput = {
  fromCharacterId: string;
  toCharacterId: string;
  category: string;
  subtype?: string;
  keywords?: string[];
  directed?: boolean;
  currentStatus?: string;
  timeRange?: Record<string, unknown>;
  confidence?: number;
  evidence?: unknown[];
  confirmationStatus?: string;
  locked?: boolean;
};

type OrganizationInput = {
  name: string;
  isDissolved?: boolean;
  description?: string;
  settings?: string[];
  settingsMarkdown?: string;
  settingsSections?: KnowledgeSectionInput[];
  memberIds?: string[];
};

type RaceInput = {
  name: string;
  isExtinct?: boolean;
  parentRaceId?: string | null;
  description?: string;
  settings?: string[];
  settingsMarkdown?: string;
  settingsSections?: KnowledgeSectionInput[];
  memberIds?: string[];
};

export type KnowledgeSectionInput = {
  title: string;
  contentMarkdown?: string;
  summary?: string;
  sortOrder?: number;
};

type KnowledgeSection = {
  title: string;
  contentMarkdown: string;
  summary: string;
  sortOrder: number;
};

function settingsFromInput(settingsMarkdown?: string, settings?: string[], fallback: string[] = []): string[] {
  if (settingsMarkdown !== undefined) return settingsMarkdown.trim() ? [settingsMarkdown] : [];
  return settings ?? fallback;
}

function settingsMarkdownFromList(settings: unknown): string {
  return Array.isArray(settings) ? settings.map(String).filter(Boolean).join("\n\n") : "";
}

function knowledgeSectionTitle(contentMarkdown: string, index: number): string {
  const heading = contentMarkdown.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/mu)?.[1]?.trim();
  return heading || `设定 ${index + 1}`;
}

function normalizeKnowledgeSections(sections: KnowledgeSectionInput[]): KnowledgeSection[] {
  return sections.map((section, index) => {
    const contentMarkdown = section.contentMarkdown ?? "";
    return {
      title: section.title.trim() || knowledgeSectionTitle(contentMarkdown, index),
      contentMarkdown,
      summary: section.summary?.trim() ?? "",
      sortOrder: Number.isFinite(section.sortOrder) ? Math.max(0, Math.trunc(section.sortOrder!)) : index
    };
  });
}

function knowledgeSectionInput(value: unknown, index: number): KnowledgeSectionInput | null {
  if (!isRecord(value)) return null;
  const contentMarkdown = typeof value.contentMarkdown === "string"
    ? value.contentMarkdown
    : typeof value.content === "string" ? value.content : "";
  const title = typeof value.title === "string" ? value.title : "";
  return {
    title: title || knowledgeSectionTitle(contentMarkdown, index),
    contentMarkdown,
    summary: typeof value.summary === "string" ? value.summary : "",
    sortOrder: typeof value.sortOrder === "number" ? value.sortOrder : index
  };
}

function knowledgeSectionsFromStored(value: unknown, fallback: string[] = []): KnowledgeSection[] {
  const parsed = typeof value === "string" ? json<unknown>(value, []) : value;
  if (Array.isArray(parsed)) {
    const sections = parsed.map((item, index) => knowledgeSectionInput(item, index)).filter((item): item is KnowledgeSectionInput => item !== null);
    if (sections.length > 0 || fallback.length === 0) return normalizeKnowledgeSections(sections);
  }
  return normalizeKnowledgeSections(fallback.map((contentMarkdown, index) => ({
    title: knowledgeSectionTitle(contentMarkdown, index),
    contentMarkdown,
    sortOrder: index
  })));
}

function knowledgeSectionsFromInput(
  sections: KnowledgeSectionInput[] | undefined,
  settingsMarkdown: string | undefined,
  settings: string[] | undefined,
  fallbackSections: KnowledgeSection[] = []
): KnowledgeSection[] {
  if (sections !== undefined) return normalizeKnowledgeSections(sections);
  if (settingsMarkdown !== undefined || settings !== undefined) {
    const legacySettings = settingsFromInput(settingsMarkdown, settings);
    return knowledgeSectionsFromStored(legacySettings.map((contentMarkdown, index) => ({
      title: knowledgeSectionTitle(contentMarkdown, index),
      contentMarkdown,
      sortOrder: index
    })));
  }
  return fallbackSections;
}

function settingsFromKnowledgeSections(sections: KnowledgeSection[]): string[] {
  return sections.map((section) => section.contentMarkdown).filter((content) => content.trim());
}

type ChapterOutlineInput = {
  goal?: string;
  conflict?: string;
  turningPoint?: string;
  notes?: string;
  status?: "draft" | "ready" | "completed";
};

type ChapterOutlineBoardForeshadow = {
  id: string;
  title: string;
  status: string;
  importance: string;
  roles: Array<"setup" | "reminder" | "payoff">;
  plannedPayoff: boolean;
};

type ChapterOutlineBoardChapter = {
  id: string;
  title: string;
  chapterType: string;
  sortOrder: number;
  outline: {
    goal: string;
    conflict: string;
    turningPoint: string;
    notes: string;
    status: string;
    truncated: boolean;
    updatedAt: string | null;
  } | null;
  foreshadows: ChapterOutlineBoardForeshadow[];
};

type ChapterOutlineBoardVolume = {
  id: string;
  title: string;
  sortOrder: number;
  chapterCount: number;
  filteredChapterCount: number;
  chapters: ChapterOutlineBoardChapter[];
};

type ChapterOutlineBoardFilters = {
  query: string;
  volumeId: string;
  outlineStatus: "all" | "empty" | "draft" | "ready" | "completed";
  foreshadowStatus: "all" | "none" | "unresolved" | "resolved" | "abandoned";
  sort: "tree" | "status" | "foreshadows" | "title";
};

export const chapterOutlineBoardForeshadowSortSql = {
  cte: `WITH foreshadow_associations AS MATERIALIZED (
    SELECT foreshadow.work_id, occurrence.chapter_id, foreshadow.id AS foreshadow_id, foreshadow.status
    FROM foreshadows foreshadow
    JOIN foreshadow_occurrences occurrence ON occurrence.foreshadow_id = foreshadow.id
    WHERE foreshadow.work_id = ?
    UNION
    SELECT foreshadow.work_id, foreshadow.planned_payoff_chapter_id AS chapter_id,
      foreshadow.id AS foreshadow_id, foreshadow.status
    FROM foreshadows foreshadow
    WHERE foreshadow.work_id = ? AND foreshadow.planned_payoff_chapter_id IS NOT NULL
  ), foreshadow_association_counts AS MATERIALIZED (
    SELECT association.work_id, association.chapter_id,
      SUM(CASE WHEN association.status IN ('planned', 'planted') THEN 1 ELSE 0 END) AS unresolved_count,
      COUNT(*) AS total_count
    FROM foreshadow_associations association
    GROUP BY association.work_id, association.chapter_id
  )`,
  join: `LEFT JOIN foreshadow_association_counts sorted_association
    ON sorted_association.work_id = chapter.work_id AND sorted_association.chapter_id = chapter.id`,
  order: `COALESCE(sorted_association.unresolved_count, 0) DESC,
    COALESCE(sorted_association.total_count, 0) DESC`
} as const;

const CHAPTER_OUTLINE_BOARD_PREVIEW_LENGTH = 600;

function chapterOutlineBoardLikePattern(value: string): string {
  return `%${value.normalize("NFKC").toLocaleLowerCase("zh-CN").replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

type ForeshadowOccurrenceInput = {
  chapterId: string;
  role: "setup" | "reminder" | "payoff";
  note?: string;
  evidence?: unknown[];
};

type ForeshadowInput = {
  title: string;
  description?: string;
  status?: "planned" | "planted" | "resolved" | "abandoned";
  importance?: "low" | "medium" | "high";
  plannedPayoffChapterId?: string | null;
  resolutionNote?: string;
  occurrences?: ForeshadowOccurrenceInput[];
};

export const versionedEntityTypes = [
  "work",
  "volume",
  "draft",
  "setting",
  "race",
  "organization",
  "timeline-track",
  "timeline-event",
  "relationship",
  "chapter-outline",
  "foreshadow"
] as const;

export type VersionedEntityType = typeof versionedEntityTypes[number];

const bookEntityTypes = ["character", "draft", "setting", "organization"] as const;
type BookEntityType = typeof bookEntityTypes[number];

const legacyFavoriteTables: Record<BookEntityType, string> = {
  character: "characters",
  draft: "drafts",
  setting: "settings",
  organization: "organizations"
};

type ReviewInput = {
  itemType: string;
  dedupeKey?: string;
  severity?: string;
  title: string;
  description?: string;
  entityRefs?: unknown[];
  evidence?: unknown[];
  suggestion?: string;
  status?: string;
  resolutionNote?: string;
};

type AiConversationMessageInput = {
  role: "user" | "assistant";
  content: string;
  citations?: unknown[];
  requestId?: string;
  metadata?: {
    mentionCharacterIds?: string[];
    mentionRaceIds?: string[];
    mentionOrganizationIds?: string[];
    modelId?: string;
    modelDisplayName?: string;
    outputTokens?: number;
    cacheHitPercent?: number;
    processDurationMs?: number;
    interrupted?: boolean;
    interruptionCode?: string;
    interruptionMessage?: string;
    toolCalls?: unknown[];
    processSteps?: unknown[];
    reasoningContent?: string;
    anthropicContent?: unknown[];
    chatImageAttachmentIds?: string[];
  };
};

export const AI_CONVERSATION_STREAM_REQUEST_LEASE_MS = 3 * 60_000;

export type AiConversationStreamRequestStatus =
  | "in_progress"
  | "completed"
  | "cancelled"
  | "failed"
  | "timed_out"
  | "abandoned";

type BeginAiConversationStreamRequestInput = {
  workId: string;
  conversationId: string;
  actorScope: string;
  idempotencyKey: string;
  requestHash: string;
  userMessage: {
    content: string;
    citations?: unknown[];
    metadata?: { mentionCharacterIds?: string[]; mentionRaceIds?: string[]; mentionOrganizationIds?: string[]; modelId?: string; chatImageAttachmentIds?: string[] };
    existingMessageId?: string;
  };
};

export type AiConversationStreamRequest = {
  id: string;
  workId: string;
  conversationId: string;
  actorScope: string;
  idempotencyKey: string;
  requestHash: string;
  status: AiConversationStreamRequestStatus;
  terminalReason: string | null;
  userMessageId: string | null;
  assistantMessageId: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type BeginAiConversationStreamRequestResult = {
  disposition: "started" | "in_progress" | "terminal";
  request: AiConversationStreamRequest;
  userMessage: Record<string, unknown> | null;
  assistantMessage: Record<string, unknown> | null;
};

export const aiConversationTaskTypes = ["chat", "roleplay", "continue", "polish"] as const;
export type AiConversationTaskType = typeof aiConversationTaskTypes[number];

export function defaultAiConversationTitle(prompt: string): string {
  const normalized = roleplayUserTurnTitleSource(prompt).replace(/\s+/gu, " ").trim();
  return Array.from(normalized).slice(0, 15).join("") || "新对话";
}

export type AiConversationContext = {
  workId: string;
  roleplayCharacterId: string | null;
  roleplayUserCharacterId: string | null;
  summary: string;
  compactedMessageCount: number;
  totalMessageCount: number;
  warningPending: boolean;
  injectedEntities: AiInjectedEntities;
  scenePin: RoleplayScenePin;
  messages: Array<{
    id: string;
    role: "user" | "assistant";
    content: string;
    metadata: Record<string, unknown>;
  }>;
};

export type AiConversationTitleContext = {
  title: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
};

export type StoryIndexChapterPage = {
  totalChapters: number;
  latestChaptersByStructure: Array<{
    id: string;
    title: string;
    versionNo: number;
    storyOrder: ChapterStoryOrderDetails;
    summary: string;
  }>;
  chapters: Array<{
    id: string;
    title: string;
    versionNo: number;
    storyOrder: ChapterStoryOrderDetails;
    summary: string;
  }>;
};

export type ConfirmedTimelineOrderEvent = {
  id: string;
  name: string;
  eventType: string;
  timeLabel: string;
  timeSort: number;
  trackId: string | null;
  trackName: string | null;
  trackOrder: number | null;
};

export type ChapterStoryOrderDetails = {
  volume: {
    volumeId: string;
    volumeTitle: string;
    directoryOrder: number;
    storyOrder: number;
  };
  chapter: {
    order: number;
    type: ChapterType;
    isLatestByStructure: boolean;
  };
  confirmedTimelineEvents?: ConfirmedTimelineOrderEvent[];
};

export type ChapterParagraphMatch = {
  chapterId: string;
  chapterTitle: string;
  paragraph: string;
  paragraphOrder?: number;
  storyOrder?: ChapterStoryOrderDetails;
};

export type LatestTimelineTrackChapterParagraph = {
  trackId: string | null;
  trackName: string | null;
  trackOrder: number | null;
  timeSort: number;
  timeLabel: string;
  timelineEvent: {
    id: string;
    name: string;
    eventType: string;
  };
  occurrence: ChapterParagraphMatch;
  matchingLinksAtLatestTime: number;
};

type ChapterParagraphSearchOptions = {
  excludeAuthorNotes?: boolean;
  includeStoryOrder?: boolean;
  includeTimeline?: boolean;
  order?: "directory_asc" | "story_asc" | "story_desc";
  chapterIds?: string[];
};

type RestorableFileSnapshotChapter = {
  title: string;
  content: string;
  sortOrder: number;
  chapterType: ChapterType;
};

type RestorableFileSnapshotVolume = {
  title: string;
  kind: string;
  source: string;
  description: string;
  keywords: string[];
  sortOrder: number;
  storyOrder: number;
  chapters: RestorableFileSnapshotChapter[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function characterGender(value: unknown): CharacterGender {
  return typeof value === "string" && CHARACTER_GENDERS.includes(value as CharacterGender)
    ? value as CharacterGender
    : "unknown";
}

function invalidFileSnapshot(): never {
  throw new AppError(409, "FILE_VERSION_INVALID", "正文历史快照已损坏，未执行恢复");
}

function parseRestorableFileSnapshot(value: string, workId: string): { volumes: RestorableFileSnapshotVolume[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    invalidFileSnapshot();
  }
  if (!isRecord(parsed) || parsed.id !== workId || !Array.isArray(parsed.volumes) || parsed.volumes.length > 10_000) {
    return invalidFileSnapshot();
  }
  let chapterCount = 0;
  let contentLength = 0;
  const volumes = parsed.volumes.map((volumeValue) => {
    if (!isRecord(volumeValue) || typeof volumeValue.title !== "string" || typeof volumeValue.kind !== "string"
      || typeof volumeValue.source !== "string" || typeof volumeValue.sortOrder !== "number"
      || !Number.isFinite(volumeValue.sortOrder) || !Array.isArray(volumeValue.chapters)) {
      return invalidFileSnapshot();
    }
    const description = volumeValue.description === undefined ? "" : volumeValue.description;
    const keywords = volumeValue.keywords === undefined ? [] : volumeValue.keywords;
    const storyOrder = volumeValue.storyOrder === undefined ? volumeValue.sortOrder : volumeValue.storyOrder;
    if (typeof description !== "string" || !Array.isArray(keywords) || !keywords.every((keyword) => typeof keyword === "string")) {
      return invalidFileSnapshot();
    }
    if (typeof storyOrder !== "number" || !Number.isInteger(storyOrder) || storyOrder < 0 || storyOrder > 1_000_000) {
      return invalidFileSnapshot();
    }
    const chapters = volumeValue.chapters.map((chapterValue) => {
      if (!isRecord(chapterValue) || typeof chapterValue.title !== "string" || typeof chapterValue.content !== "string"
        || typeof chapterValue.sortOrder !== "number" || !Number.isFinite(chapterValue.sortOrder)
        || !["正文", "设定", "作者的话", "其他"].includes(String(chapterValue.chapterType))) {
        return invalidFileSnapshot();
      }
      chapterCount += 1;
      contentLength += chapterValue.content.length;
      if (chapterCount > 100_000 || contentLength > 20_000_000) return invalidFileSnapshot();
      return {
        title: chapterValue.title,
        content: chapterValue.content,
        sortOrder: chapterValue.sortOrder,
        chapterType: chapterValue.chapterType as ChapterType
      };
    });
    return {
      title: volumeValue.title,
      kind: volumeValue.kind,
      source: volumeValue.source,
      description,
      keywords: [...keywords] as string[],
      sortOrder: volumeValue.sortOrder,
      storyOrder,
      chapters
    };
  });
  return { volumes };
}

function requiredString(row: Row, key: string): string {
  return String(row[key] ?? "");
}

function optionalString(row: Row, key: string): string | null {
  return row[key] === null || row[key] === undefined ? null : String(row[key]);
}

function numberValue(row: Row, key: string): number {
  return Number(row[key] ?? 0);
}

function booleanValue(row: Row, key: string): boolean {
  return Number(row[key] ?? 0) === 1;
}

export function normalizeCharacterName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("zh-CN");
}

const EMPTY_AI_INJECTED_ENTITIES: AiInjectedEntities = {
  characters: [],
  races: [],
  organizations: []
};

function parseAiInjectedEntities(value: unknown): AiInjectedEntities {
  const parsed = typeof value === "string" ? json<Record<string, unknown>>(value, {}) : isRecord(value) ? value : {};
  const uniqueIds = (items: unknown): string[] => [...new Set((Array.isArray(items) ? items : [])
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim()))];
  return {
    characters: uniqueIds(parsed.characters),
    races: uniqueIds(parsed.races),
    organizations: uniqueIds(parsed.organizations)
  };
}

function mergeAiInjectedEntities(base: AiInjectedEntities, extra: Partial<AiInjectedEntities>): AiInjectedEntities {
  return {
    characters: [...new Set([...base.characters, ...(extra.characters ?? [])])],
    races: [...new Set([...base.races, ...(extra.races ?? [])])],
    organizations: [...new Set([...base.organizations, ...(extra.organizations ?? [])])]
  };
}

export class Store {
  constructor(readonly db: Database) {
    this.migrateEntityVersionBaselines();
    this.purgeExpiredRecycleBin();
  }

  private entityPreferenceProjection(entityType: BookEntityType, alias: string): {
    columns: string;
    orderBy: string;
    params: SQLInputValue[];
  } {
    const actor = currentRequestActor();
    if (!actor) {
      return {
        columns: `${alias}.is_favorite AS user_is_favorite,
          EXISTS (
            SELECT 1 FROM work_entity_pins pin
            WHERE pin.work_id = ${alias}.work_id
              AND pin.entity_type = '${entityType}'
              AND pin.entity_id = ${alias}.id
              AND pin.is_pinned = 1
          ) AS is_pinned`,
        orderBy: "is_pinned DESC, user_is_favorite DESC",
        params: []
      };
    }
    return {
      columns: `
        EXISTS (
          SELECT 1 FROM work_entity_favorites favorite
          WHERE favorite.work_id = ${alias}.work_id
            AND favorite.entity_type = '${entityType}'
            AND favorite.entity_id = ${alias}.id
            AND favorite.user_id = ?
            AND favorite.is_favorite = 1
        ) AS user_is_favorite,
        EXISTS (
          SELECT 1 FROM work_entity_pins pin
          WHERE pin.work_id = ${alias}.work_id
            AND pin.entity_type = '${entityType}'
            AND pin.entity_id = ${alias}.id
            AND pin.is_pinned = 1
        ) AS is_pinned`,
      orderBy: "is_pinned DESC, user_is_favorite DESC",
      params: [actor.userId]
    };
  }

  private mapEntityFavorite(row: Row): boolean {
    return Object.hasOwn(row, "user_is_favorite")
      ? booleanValue(row, "user_is_favorite")
      : booleanValue(row, "is_favorite");
  }

  private mapEntityPin(row: Row): boolean {
    return booleanValue(row, "is_pinned");
  }

  private setEntityFavorite(
    workId: string,
    entityType: BookEntityType,
    entityId: string,
    isFavorite: boolean,
    legacyFavorite: boolean
  ): boolean {
    const actor = currentRequestActor();
    const previousFavorite = actor
      ? this.db.get(
        "SELECT is_favorite FROM work_entity_favorites WHERE work_id = ? AND entity_type = ? AND entity_id = ? AND user_id = ?",
        workId,
        entityType,
        entityId,
        actor.userId
      )
      : undefined;
    const previous = actor ? booleanValue(previousFavorite ?? {}, "is_favorite") : legacyFavorite;
    if (previous === isFavorite) return previous;
    const timestamp = now();
    if (actor) {
      this.db.run(
        `INSERT INTO work_entity_favorites (work_id, entity_type, entity_id, user_id, is_favorite, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(work_id, entity_type, entity_id, user_id)
         DO UPDATE SET is_favorite = excluded.is_favorite, updated_at = excluded.updated_at`,
        workId,
        entityType,
        entityId,
        actor.userId,
        isFavorite ? 1 : 0,
        timestamp,
        timestamp
      );
    } else {
      this.db.run(
        `UPDATE ${legacyFavoriteTables[entityType]} SET is_favorite = ? WHERE id = ?`,
        isFavorite ? 1 : 0,
        entityId
      );
    }
    return previous;
  }

  private setEntityPin(workId: string, entityType: BookEntityType, entityId: string, isPinned: boolean): boolean {
    const previousPin = this.db.get(
      "SELECT is_pinned FROM work_entity_pins WHERE work_id = ? AND entity_type = ? AND entity_id = ?",
      workId,
      entityType,
      entityId
    );
    const previous = booleanValue(previousPin ?? {}, "is_pinned");
    if (previous === isPinned) return previous;
    const timestamp = now();
    this.db.run(
      `INSERT INTO work_entity_pins (work_id, entity_type, entity_id, is_pinned, pinned_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(work_id, entity_type, entity_id)
       DO UPDATE SET is_pinned = excluded.is_pinned, pinned_by_user_id = excluded.pinned_by_user_id, updated_at = excluded.updated_at`,
      workId,
      entityType,
      entityId,
      isPinned ? 1 : 0,
      currentRequestActor()?.userId ?? null,
      timestamp,
      timestamp
    );
    return previous;
  }

  purgeExpiredRecycleBin(referenceTime = new Date()): { works: number; volumes: number; chapters: number } {
    const cutoff = new Date(referenceTime.getTime() - RECYCLE_BIN_RETENTION_DAYS * 24 * 60 * 60_000).toISOString();
    return this.db.transaction(() => {
      let works = 0;
      let volumes = 0;
      let chapters = 0;
      for (const work of this.db.all("SELECT * FROM works WHERE deleted_at IS NOT NULL AND deleted_at <= ?", cutoff)) {
        this.permanentlyRemoveWorkRow(work, "retention-expired");
        works += 1;
      }
      for (const volume of this.db.all(
        `SELECT volume.* FROM volumes volume JOIN works work ON work.id = volume.work_id
         WHERE work.deleted_at IS NULL AND volume.deleted_at IS NOT NULL AND volume.deleted_at <= ?`,
        cutoff
      )) {
        this.permanentlyRemoveVolumeRow(volume, "retention-expired");
        volumes += 1;
      }
      for (const chapter of this.db.all(
        `SELECT chapter.* FROM chapters chapter
         JOIN works work ON work.id = chapter.work_id
         JOIN volumes volume ON volume.id = chapter.volume_id
         WHERE work.deleted_at IS NULL AND volume.deleted_at IS NULL
           AND chapter.deleted_at IS NOT NULL AND chapter.deleted_via_volume_id IS NULL
           AND chapter.deleted_at <= ?`,
        cutoff
      )) {
        this.permanentlyRemoveChapterRow(chapter, "retention-expired");
        chapters += 1;
      }
      if (works || volumes || chapters) {
        logger.info("recycle_bin.retention_purged", { works, volumes, chapters, retentionDays: RECYCLE_BIN_RETENTION_DAYS });
      }
      return { works, volumes, chapters };
    });
  }

  private currentEntityVersionNo(type: VersionedEntityType, entityId: string): number {
    const row = this.db.get(
      "SELECT MAX(version_no) AS version_no FROM entity_versions WHERE entity_type = ? AND entity_id = ?",
      type,
      entityId
    );
    return numberValue(row ?? {}, "version_no");
  }

  private currentEntityVersionNos(type: VersionedEntityType, entityIds: string[]): Map<string, number> {
    const versions = new Map<string, number>();
    for (let offset = 0; offset < entityIds.length; offset += ENTITY_LIST_BATCH_SIZE) {
      const batchIds = entityIds.slice(offset, offset + ENTITY_LIST_BATCH_SIZE);
      const placeholders = batchIds.map(() => "?").join(", ");
      const rows = this.db.all(
        `SELECT entity_id, MAX(version_no) AS version_no FROM entity_versions
         WHERE entity_type = ? AND entity_id IN (${placeholders}) GROUP BY entity_id`,
        type,
        ...batchIds
      );
      for (const row of rows) versions.set(requiredString(row, "entity_id"), numberValue(row, "version_no"));
    }
    return versions;
  }

  private currentChapterVersionNo(chapterId: string): number {
    return numberValue(this.db.get("SELECT MAX(version_no) AS version_no FROM chapter_versions WHERE chapter_id = ?", chapterId) ?? {}, "version_no");
  }

  private currentCharacterVersionNo(characterId: string): number {
    return numberValue(this.db.get("SELECT MAX(version_no) AS version_no FROM character_versions WHERE character_id = ?", characterId) ?? {}, "version_no");
  }

  private currentCharacterSectionVersionNo(sectionId: string): number {
    return numberValue(this.db.get("SELECT MAX(version_no) AS version_no FROM character_profile_section_versions WHERE section_id = ?", sectionId) ?? {}, "version_no");
  }

  private assertExpectedVersion(
    type: VersionedEntityType,
    entityId: string,
    expectedVersionNo: number | undefined,
    entityName: string,
    currentVersionNo = this.currentEntityVersionNo(type, entityId)
  ): void {
    if (expectedVersionNo === undefined || expectedVersionNo === currentVersionNo) return;
    throw new AppError(409, "VERSION_CONFLICT", `${entityName}已发生变化，请刷新后重试`, {
      entityType: type,
      entityId,
      expectedVersionNo,
      currentVersionNo
    });
  }

  private assertExpectedRevision(
    entityType: string,
    entityId: string,
    expectedVersionNo: number | undefined,
    entityName: string,
    currentVersionNo: number
  ): void {
    if (expectedVersionNo === undefined || expectedVersionNo === currentVersionNo) return;
    throw new AppError(409, "VERSION_CONFLICT", `${entityName}已发生变化，请刷新后重试`, {
      entityType,
      entityId,
      expectedVersionNo,
      currentVersionNo
    });
  }

  private versionedEntity(type: VersionedEntityType, entityId: string): Record<string, unknown> {
    if (type === "work") return this.getWork(entityId);
    if (type === "volume") return this.getVolume(entityId);
    if (type === "draft") return this.getDraft(entityId);
    if (type === "setting") return this.getSetting(entityId);
    if (type === "race") return this.getRace(entityId);
    if (type === "organization") return this.getOrganization(entityId);
    if (type === "timeline-track") return this.getTimelineTrack(entityId);
    if (type === "timeline-event") return this.getTimelineEvent(entityId);
    if (type === "relationship") return this.getRelationship(entityId);
    if (type === "chapter-outline") {
      const outline = this.getChapterOutline(entityId);
      if (!outline) throw notFound("章节大纲");
      return outline;
    }
    return this.getForeshadow(entityId);
  }

  private tryVersionedEntity(type: VersionedEntityType, entityId: string): Record<string, unknown> | null {
    try {
      return this.versionedEntity(type, entityId);
    } catch (error) {
      if (error instanceof AppError && error.status === 404) return null;
      throw error;
    }
  }

  private versionedEntitySnapshot(type: VersionedEntityType, entity: Record<string, unknown>): Record<string, unknown> {
    if (type === "work") return {
      title: entity.title,
      author: entity.author,
      description: entity.description,
      language: entity.language,
      coverUrl: entity.coverUrl,
      tags: entity.tags,
      ownerUserId: entity.ownerUserId
    };
    if (type === "volume") return {
      title: entity.title,
      kind: entity.kind,
      source: entity.source,
      description: entity.description,
      keywords: entity.keywords,
      sortOrder: entity.sortOrder,
      storyOrder: entity.storyOrder
    };
    if (type === "draft") return {
      draftType: entity.draftType,
      volumeId: entity.volumeId,
      settingModule: entity.settingModule,
      title: entity.title,
      content: entity.content
    };
    if (type === "setting") return {
      title: entity.title,
      category: entity.category,
      content: entity.content,
      tags: entity.tags,
      status: entity.status,
      locked: entity.locked,
      evidence: entity.evidence,
      scope: entity.scope,
      authorNote: entity.authorNote
    };
    if (type === "race") return {
      name: entity.name,
      isExtinct: entity.isExtinct,
      parentRaceId: entity.parentRaceId,
      description: entity.description,
      settings: entity.settings,
      settingsSections: entity.settingsSections,
      memberIds: entity.memberIds
    };
    if (type === "organization") return {
      name: entity.name,
      isDissolved: entity.isDissolved,
      description: entity.description,
      settings: entity.settings,
      settingsSections: entity.settingsSections,
      memberIds: entity.memberIds
    };
    if (type === "timeline-track") return {
      name: entity.name,
      description: entity.description,
      sortOrder: entity.sortOrder
    };
    if (type === "timeline-event") return {
      name: entity.name,
      trackId: entity.trackId,
      description: entity.description,
      eventType: entity.eventType,
      timeLabel: entity.timeLabel,
      timeSort: entity.timeSort,
      chapterIds: entity.chapterIds,
      participantIds: entity.participantIds,
      location: entity.location,
      causes: entity.causes,
      impactScope: entity.impactScope,
      evidence: entity.evidence,
      status: entity.status
    };
    if (type === "relationship") return {
      fromCharacterId: entity.fromCharacterId,
      toCharacterId: entity.toCharacterId,
      category: entity.category,
      subtype: entity.subtype,
      keywords: entity.keywords,
      directed: entity.directed,
      currentStatus: entity.currentStatus,
      timeRange: entity.timeRange,
      confidence: entity.confidence,
      evidence: entity.evidence,
      confirmationStatus: entity.confirmationStatus,
      locked: entity.locked
    };
    if (type === "chapter-outline") return {
      goal: entity.goal,
      conflict: entity.conflict,
      turningPoint: entity.turningPoint,
      notes: entity.notes,
      status: entity.status
    };
    return {
      title: entity.title,
      description: entity.description,
      status: entity.status,
      importance: entity.importance,
      plannedPayoffChapterId: entity.plannedPayoffChapterId,
      resolutionNote: entity.resolutionNote,
      occurrences: (entity.occurrences as Array<Record<string, unknown>>).map((occurrence) => ({
        chapterId: occurrence.chapterId,
        role: occurrence.role,
        note: occurrence.note,
        evidence: occurrence.evidence
      }))
    };
  }

  private recordEntityVersion(
    type: VersionedEntityType,
    entityId: string,
    source: string,
    sourceRef: string | null,
    changeNote: string,
    timestamp?: string
  ): number {
    const entity = this.versionedEntity(type, entityId);
    const snapshot = this.versionedEntitySnapshot(type, entity);
    const snapshotJson = JSON.stringify(snapshot);
    const latest = this.db.get(
      "SELECT version_no, snapshot_json FROM entity_versions WHERE entity_type = ? AND entity_id = ? ORDER BY version_no DESC LIMIT 1",
      type,
      entityId
    );
    if (latest && requiredString(latest, "snapshot_json") === snapshotJson && source !== "restore" && source !== "delete") {
      return numberValue(latest, "version_no");
    }
    const versionNo = latest ? numberValue(latest, "version_no") + 1 : 1;
    this.db.run(
      `INSERT INTO entity_versions (id, work_id, entity_type, entity_id, version_no, snapshot_json, source, source_ref, change_note, created_at, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id("entityVersion"),
      type === "work" ? entityId : String(entity.workId),
      type,
      entityId,
      versionNo,
      snapshotJson,
      source,
      sourceRef,
      changeNote.trim(),
      timestamp ?? now(),
      currentRequestActor()?.userId ?? null
    );
    if (type === "setting") {
      this.recordSyncChange(
        String(entity.workId),
        "setting",
        entityId,
        source === "delete" ? "delete" : "upsert",
        versionNo,
        timestamp
      );
    }
    return versionNo;
  }

  private recordSyncChange(
    workId: string,
    entityType: "chapter" | "setting",
    entityId: string,
    operation: "upsert" | "delete",
    versionNo: number,
    timestamp?: string
  ): void {
    this.db.run(
      `INSERT INTO sync_changes (
         work_id, entity_type, entity_id, operation, version_no, changed_by_user_id, changed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      workId,
      entityType,
      entityId,
      operation,
      versionNo,
      currentRequestActor()?.userId ?? null,
      timestamp ?? now()
    );
  }

  private backfillEntityVersionBaselines(): void {
    const entities: Array<[VersionedEntityType, string, string]> = [
      ...this.db.all("SELECT id, updated_at FROM works").map((row) => ["work", requiredString(row, "id"), requiredString(row, "updated_at")] as [VersionedEntityType, string, string]),
      ...this.db.all("SELECT id, updated_at FROM volumes").map((row) => ["volume", requiredString(row, "id"), requiredString(row, "updated_at")] as [VersionedEntityType, string, string]),
      ...this.db.all("SELECT id, updated_at FROM drafts").map((row) => ["draft", requiredString(row, "id"), requiredString(row, "updated_at")] as [VersionedEntityType, string, string]),
      ...this.db.all("SELECT id, updated_at FROM settings").map((row) => ["setting", requiredString(row, "id"), requiredString(row, "updated_at")] as [VersionedEntityType, string, string]),
      ...this.db.all("SELECT id, updated_at FROM races").map((row) => ["race", requiredString(row, "id"), requiredString(row, "updated_at")] as [VersionedEntityType, string, string]),
      ...this.db.all("SELECT id, updated_at FROM organizations").map((row) => ["organization", requiredString(row, "id"), requiredString(row, "updated_at")] as [VersionedEntityType, string, string]),
      ...this.db.all("SELECT id, updated_at FROM timeline_tracks").map((row) => ["timeline-track", requiredString(row, "id"), requiredString(row, "updated_at")] as [VersionedEntityType, string, string]),
      ...this.db.all("SELECT id, updated_at FROM timeline_events").map((row) => ["timeline-event", requiredString(row, "id"), requiredString(row, "updated_at")] as [VersionedEntityType, string, string]),
      ...this.db.all("SELECT id, updated_at FROM relationships").map((row) => ["relationship", requiredString(row, "id"), requiredString(row, "updated_at")] as [VersionedEntityType, string, string]),
      ...this.db.all("SELECT chapter_id, updated_at FROM chapter_outlines").map((row) => ["chapter-outline", requiredString(row, "chapter_id"), requiredString(row, "updated_at")] as [VersionedEntityType, string, string]),
      ...this.db.all("SELECT id, updated_at FROM foreshadows").map((row) => ["foreshadow", requiredString(row, "id"), requiredString(row, "updated_at")] as [VersionedEntityType, string, string])
    ];
    this.db.transaction(() => {
      for (const [type, entityId, timestamp] of entities) {
        this.recordEntityVersion(type, entityId, "migration", null, "建立版本基线", timestamp);
      }
    });
  }

  private migrateEntityVersionBaselines(): void {
    const migrationSql = "SELECT 1 AS present FROM schema_migrations WHERE version = ?";
    if (this.db.get(migrationSql, ENTITY_VERSION_BASELINE_MIGRATION_VERSION)) return;
    this.db.transaction(() => {
      if (this.db.get(migrationSql, ENTITY_VERSION_BASELINE_MIGRATION_VERSION)) return;
      if (!this.db.get("SELECT 1 AS present FROM entity_versions LIMIT 1")) {
        this.backfillEntityVersionBaselines();
      }
      const integrity = this.db.all<{ integrity_check: string }>("PRAGMA integrity_check");
      if (integrity.some((row) => row.integrity_check !== "ok")) {
        throw new Error(`数据库完整性检查失败：${integrity.map((row) => row.integrity_check).join("；")}`);
      }
      const foreignKeys = this.db.all("PRAGMA foreign_key_check");
      if (foreignKeys.length > 0) throw new Error(`数据库外键检查失败：发现 ${foreignKeys.length} 条异常记录`);
      this.db.run(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
        ENTITY_VERSION_BASELINE_MIGRATION_VERSION,
        now()
      );
    });
  }

  listEntityVersions(type: VersionedEntityType, entityId: string): Record<string, unknown>[] {
    const rows = this.db.all(
      `SELECT version.*, user.display_name AS actor_display_name, user.username AS actor_username
       FROM entity_versions version LEFT JOIN users user ON user.id = version.created_by_user_id
       WHERE version.entity_type = ? AND version.entity_id = ? ORDER BY version.version_no DESC`,
      type,
      entityId
    );
    if (!rows.length) {
      this.versionedEntity(type, entityId);
      return [];
    }
    return rows.map((row) => ({
      id: requiredString(row, "id"),
      workId: requiredString(row, "work_id"),
      entityType: requiredString(row, "entity_type"),
      entityId: requiredString(row, "entity_id"),
      versionNo: numberValue(row, "version_no"),
      snapshot: json(requiredString(row, "snapshot_json"), {}),
      source: requiredString(row, "source"),
      sourceRef: optionalString(row, "source_ref"),
      changeNote: requiredString(row, "change_note"),
      createdAt: requiredString(row, "created_at"),
      actor: optionalString(row, "actor_display_name") ?? optionalString(row, "actor_username") ?? "历史数据"
    }));
  }

  listEntityVersionsPage(type: VersionedEntityType, entityId: string, pagination: Pagination): PaginatedResult<Record<string, unknown>> {
    const page = paginationSql(pagination);
    const rows = this.db.all(
      `SELECT version.*, user.display_name AS actor_display_name, user.username AS actor_username
       FROM entity_versions version LEFT JOIN users user ON user.id = version.created_by_user_id
       WHERE version.entity_type = ? AND version.entity_id = ? ORDER BY version.version_no DESC${page.sql}`,
      type,
      entityId,
      ...page.params
    );
    if (!rows.length && pagination.page === 1) this.versionedEntity(type, entityId);
    return paginated(rows.map((row) => ({
      id: requiredString(row, "id"),
      workId: requiredString(row, "work_id"),
      entityType: requiredString(row, "entity_type"),
      entityId: requiredString(row, "entity_id"),
      versionNo: numberValue(row, "version_no"),
      snapshot: json(requiredString(row, "snapshot_json"), {}),
      source: requiredString(row, "source"),
      sourceRef: optionalString(row, "source_ref"),
      changeNote: requiredString(row, "change_note"),
      createdAt: requiredString(row, "created_at"),
      actor: optionalString(row, "actor_display_name") ?? optionalString(row, "actor_username") ?? "历史数据"
    })), pagination);
  }

  restoreEntityVersion(type: VersionedEntityType, entityId: string, versionNo: number, expectedVersionNo?: number): Record<string, unknown> {
    if (type === "volume" && this.db.get("SELECT 1 AS present FROM volumes WHERE id = ? AND deleted_at IS NOT NULL", entityId)) {
      throw new AppError(409, "ENTITY_IN_RECYCLE_BIN", "分卷位于回收站，请先从回收站恢复");
    }
    const version = this.db.get(
      "SELECT * FROM entity_versions WHERE entity_type = ? AND entity_id = ? AND version_no = ?",
      type,
      entityId,
      versionNo
    );
    if (!version) throw notFound("历史版本");
    const snapshot = json<Record<string, unknown>>(requiredString(version, "snapshot_json"), {});
    if (!Object.keys(snapshot).length) throw new AppError(500, "ENTITY_VERSION_INVALID", "历史版本快照无效");
    const sourceRef = requiredString(version, "id");
    const changeNote = `恢复至 v${versionNo}`;
    const workId = requiredString(version, "work_id");
    const existing = this.tryVersionedEntity(type, entityId);
    const currentVersionNo = existing
      ? type === "work" ? Number(existing.versionNo) : type === "volume" ? Number(existing.versionNo) : this.currentEntityVersionNo(type, entityId)
      : this.currentEntityVersionNo(type, entityId);
    this.assertExpectedVersion(type, entityId, expectedVersionNo, type === "work" ? "作品" : type === "volume" ? "分卷" : "创作资料", currentVersionNo);
    let restored: Record<string, unknown>;
    if (!existing) {
      restored = this.recreateEntityFromSnapshot(type, workId, entityId, snapshot, sourceRef, changeNote);
    } else if (type === "work") restored = this.updateWork(entityId, snapshot as Partial<WorkInput>, expectedVersionNo, "restore", sourceRef, changeNote);
    else if (type === "volume") restored = this.updateVolume(entityId, snapshot as Partial<VolumeInput>, expectedVersionNo, "restore", sourceRef, changeNote);
    else if (type === "draft") restored = this.updateDraft(entityId, snapshot as Partial<DraftInput>, "restore", sourceRef, changeNote, expectedVersionNo);
    else if (type === "setting") restored = this.updateSetting(entityId, snapshot as Partial<SettingInput>, "restore", sourceRef, changeNote, expectedVersionNo);
    else if (type === "race") restored = this.updateRace(entityId, { isExtinct: false, ...snapshot } as Partial<RaceInput>, "restore", sourceRef, changeNote, expectedVersionNo);
    else if (type === "organization") restored = this.updateOrganization(entityId, { isDissolved: false, ...snapshot } as Partial<OrganizationInput>, "restore", sourceRef, changeNote, expectedVersionNo);
    else if (type === "timeline-track") restored = this.updateTimelineTrack(entityId, snapshot as Partial<TimelineTrackInput>, "restore", sourceRef, changeNote, expectedVersionNo);
    else if (type === "timeline-event") restored = this.updateTimelineEvent(entityId, snapshot as Partial<TimelineInput>, "restore", sourceRef, changeNote, expectedVersionNo);
    else if (type === "relationship") restored = this.updateRelationship(entityId, snapshot as Partial<RelationshipInput>, "restore", sourceRef, changeNote, expectedVersionNo);
    else if (type === "chapter-outline") restored = this.upsertChapterOutline(entityId, snapshot as ChapterOutlineInput, "restore", sourceRef, changeNote, expectedVersionNo);
    else restored = this.updateForeshadow(entityId, snapshot as Partial<ForeshadowInput>, "restore", sourceRef, changeNote, expectedVersionNo);
    const currentVersion = this.db.get(
      "SELECT MAX(version_no) AS version_no FROM entity_versions WHERE entity_type = ? AND entity_id = ?",
      type,
      entityId
    );
    return { ...restored, versionNo: numberValue(currentVersion ?? {}, "version_no") };
  }

  private recreateEntityFromSnapshot(
    type: VersionedEntityType,
    workId: string,
    entityId: string,
    snapshot: Record<string, unknown>,
    sourceRef: string,
    changeNote: string
  ): Record<string, unknown> {
    this.getWork(workId);
    if (type === "work") {
      return this.db.transaction(() => {
        const ownerUserId = this.resolveWorkOwnerUserId(typeof snapshot.ownerUserId === "string" ? snapshot.ownerUserId : null, true);
        const timestamp = now();
        this.db.run(
          `INSERT INTO works (id, title, author, description, language, cover_url, tags_json, version_no, created_at, updated_at, owner_user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
          entityId,
          String(snapshot.title ?? "未命名作品"),
          String(snapshot.author ?? ""),
          String(snapshot.description ?? ""),
          String(snapshot.language ?? "zh-CN"),
          snapshot.coverUrl as string | null ?? null,
          JSON.stringify(Array.isArray(snapshot.tags) ? snapshot.tags : []),
          timestamp,
          timestamp,
          ownerUserId
        );
        if (ownerUserId !== SYSTEM_USER_ID) {
          this.db.run(
            "INSERT INTO work_memberships (work_id, user_id, role, invited_by_user_id, created_at) VALUES (?, ?, 'owner', ?, ?)",
            entityId,
            ownerUserId,
            ownerUserId,
            timestamp
          );
        }
        const versionNo = this.recordEntityVersion("work", entityId, "restore", sourceRef, changeNote, timestamp);
        this.db.run("UPDATE works SET version_no = ? WHERE id = ?", versionNo, entityId);
        this.audit(entityId, "work.restored", "work", entityId, { sourceRef });
        return this.getWork(entityId);
      });
    }
    if (type === "volume") {
      return this.db.transaction(() => this.insertVolumeWithId(workId, entityId, snapshot as VolumeInput, "restore", sourceRef, changeNote));
    }
    if (type === "draft") {
      return this.insertDraftWithId(workId, entityId, snapshot as DraftInput, "restore", sourceRef, changeNote);
    }
    if (type === "setting") {
      return this.insertSettingWithId(workId, entityId, snapshot as SettingInput, "restore", sourceRef, changeNote);
    }
    if (type === "race") {
      return this.insertRaceWithId(workId, entityId, { isExtinct: false, ...snapshot } as RaceInput, "restore", sourceRef, changeNote);
    }
    if (type === "organization") {
      return this.insertOrganizationWithId(workId, entityId, { isDissolved: false, ...snapshot } as OrganizationInput, "restore", sourceRef, changeNote);
    }
    if (type === "timeline-track") {
      return this.insertTimelineTrackWithId(workId, entityId, snapshot as TimelineTrackInput, "restore", sourceRef, changeNote);
    }
    if (type === "timeline-event") {
      return this.insertTimelineEventWithId(workId, entityId, snapshot as TimelineInput, "restore", sourceRef, changeNote);
    }
    if (type === "relationship") {
      return this.insertRelationshipWithId(workId, entityId, snapshot as RelationshipInput, "restore", sourceRef, changeNote);
    }
    if (type === "chapter-outline") {
      this.getChapter(entityId);
      return this.upsertChapterOutline(entityId, snapshot as ChapterOutlineInput, "restore", sourceRef, changeNote);
    }
    return this.insertForeshadowWithId(workId, entityId, snapshot as ForeshadowInput, "restore", sourceRef, changeNote);
  }

  audit(workId: string | null, action: string, entityType: string, entityId: string | null, detail: unknown = {}): void {
    const actor = currentRequestActor();
    this.db.run(
      "INSERT INTO audit_logs (id, work_id, action, entity_type, entity_id, actor, detail_json, created_at, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id("audit"),
      workId,
      action,
      entityType,
      entityId,
      actor?.displayName || actor?.username || "system",
      JSON.stringify(detail),
      now(),
      actor?.userId ?? null
    );
    const detailKeys = detail && typeof detail === "object" && !Array.isArray(detail) ? Object.keys(detail as Record<string, unknown>) : [];
    logger.info("domain.change.recorded", {
      action,
      workId,
      entityType,
      entityId: entityType === "user" && entityId ? accountReference(entityId) : entityId,
      detailKeys
    });
    if (workId) {
      try {
        this.relationshipIndexQueuedHandler?.(workId);
      } catch {
        // 索引调度失败不影响主写入路径
      }
    }
  }

  createWork(input: WorkInput, ownerUserId: string | null = null): Record<string, unknown> {
    const workId = id("work");
    const timestamp = now();
    const resolvedOwnerUserId = this.resolveWorkOwnerUserId(ownerUserId);
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO works (id, title, author, description, language, cover_url, tags_json, created_at, updated_at, owner_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        workId,
        input.title,
        input.author ?? "",
        input.description ?? "",
        input.language ?? "zh-CN",
        input.coverUrl ?? null,
        JSON.stringify(input.tags ?? []),
        timestamp,
        timestamp,
        resolvedOwnerUserId
      );
      if (resolvedOwnerUserId !== SYSTEM_USER_ID) {
        this.db.run(
          "INSERT INTO work_memberships (work_id, user_id, role, invited_by_user_id, created_at) VALUES (?, ?, 'owner', ?, ?)",
          workId,
          resolvedOwnerUserId,
          resolvedOwnerUserId,
          timestamp
        );
      }
      this.recordEntityVersion("work", workId, "create", null, "建立作品", timestamp);
      this.audit(workId, "work.created", "work", workId);
    });
    return this.getWork(workId);
  }

  private resolveWorkOwnerUserId(ownerUserId: string | null = null, allowUnknownFallback = false): string {
    const candidate = ownerUserId ?? currentRequestActor()?.userId ?? null;
    if (candidate && this.db.get("SELECT 1 AS present FROM users WHERE id = ?", candidate)) return candidate;
    if (candidate && !allowUnknownFallback) throw new AppError(400, "WORK_OWNER_INVALID", "作品 Owner 用户不存在");
    return SYSTEM_USER_ID;
  }

  listWorks(): Record<string, unknown>[] {
    const actor = currentRequestActor();
    if (!actor) {
      return this.mapWorks(this.db.all("SELECT * FROM works WHERE COALESCE(is_internal, 0) = 0 AND deleted_at IS NULL ORDER BY updated_at DESC"));
    }
    return this.mapWorks(this.db.all(
      `SELECT DISTINCT work.* FROM works work LEFT JOIN work_memberships membership ON membership.work_id = work.id
       WHERE COALESCE(work.is_internal, 0) = 0 AND work.deleted_at IS NULL
         AND (work.owner_user_id = ? OR membership.user_id = ?)
       ORDER BY work.updated_at DESC`,
      actor.userId,
      actor.userId
    ));
  }

  listWorksPage(pagination: Pagination): PaginatedResult<Record<string, unknown>> {
    const actor = currentRequestActor();
    const page = paginationSql(pagination);
    const rows = !actor
      ? this.db.all(`SELECT * FROM works WHERE COALESCE(is_internal, 0) = 0 AND deleted_at IS NULL ORDER BY updated_at DESC${page.sql}`, ...page.params)
      : this.db.all(
        `SELECT DISTINCT work.* FROM works work LEFT JOIN work_memberships membership ON membership.work_id = work.id
         WHERE COALESCE(work.is_internal, 0) = 0 AND work.deleted_at IS NULL
           AND (work.owner_user_id = ? OR membership.user_id = ?)
         ORDER BY work.updated_at DESC${page.sql}`,
        actor.userId,
        actor.userId,
        ...page.params
      );
    return paginated(this.mapWorks(rows), pagination);
  }

  getWork(workId: string): Record<string, unknown> {
    const row = this.db.get("SELECT * FROM works WHERE id = ? AND deleted_at IS NULL", workId);
    if (!row) throw notFound("作品");
    return this.mapWork(row);
  }

  listDeletedWorks(): Record<string, unknown>[] {
    const actor = currentRequestActor();
    const actorRestricted = Boolean(actor);
    const rows = this.db.all(
      `SELECT work.*,
        (SELECT COUNT(*) FROM volumes volume WHERE volume.work_id = work.id) AS volume_count,
        (SELECT COUNT(*) FROM chapters chapter WHERE chapter.work_id = work.id) AS chapter_count,
        user.display_name AS actor_display_name, user.username AS actor_username
       FROM works work
       LEFT JOIN entity_versions version
         ON version.entity_type = 'work' AND version.entity_id = work.id
         AND version.version_no = work.version_no AND version.source = 'delete'
       LEFT JOIN users user ON user.id = version.created_by_user_id
       WHERE COALESCE(work.is_internal, 0) = 0 AND work.deleted_at IS NOT NULL
         ${actorRestricted ? "AND work.owner_user_id = ?" : ""}
       ORDER BY work.deleted_at DESC, work.id DESC`,
      ...(actorRestricted ? [actor!.userId] : [])
    );
    return rows.map((row) => {
      const deletedAt = requiredString(row, "deleted_at");
      return {
        id: requiredString(row, "id"),
        title: requiredString(row, "title"),
        author: requiredString(row, "author"),
        description: requiredString(row, "description"),
        versionNo: numberValue(row, "version_no"),
        volumeCount: numberValue(row, "volume_count"),
        chapterCount: numberValue(row, "chapter_count"),
        deletedAt,
        expiresAt: recycleBinExpiresAt(deletedAt),
        actor: optionalString(row, "actor_display_name") ?? optionalString(row, "actor_username") ?? "历史数据"
      };
    });
  }

  getPlatformAiSettings(): Record<string, unknown> {
    const row = this.db.get("SELECT * FROM platform_ai_settings WHERE id = 1");
    const streamIdleTimeoutValue = Number(row?.stream_idle_timeout_seconds);
    return {
      systemPrompt: String(row?.system_prompt ?? ""),
      imageToolModelId: row?.image_tool_model_id === null || row?.image_tool_model_id === undefined
        ? null
        : String(row.image_tool_model_id),
      streamIdleTimeoutSeconds: Number.isSafeInteger(streamIdleTimeoutValue)
        ? normalizeAiStreamIdleTimeoutSeconds(streamIdleTimeoutValue)
        : DEFAULT_AI_STREAM_IDLE_TIMEOUT_SECONDS,
      updatedAt: String(row?.updated_at ?? "")
    };
  }

  updatePlatformAiSettings(input: {
    systemPrompt?: string;
    imageToolModelId?: string | null;
    streamIdleTimeoutSeconds?: number;
  }): Record<string, unknown> {
    const timestamp = now();
    const current = this.getPlatformAiSettings();
    const currentStreamIdleTimeoutSeconds = Number(current.streamIdleTimeoutSeconds);
    const streamIdleTimeoutSeconds = normalizeAiStreamIdleTimeoutSeconds(
      input.streamIdleTimeoutSeconds ?? currentStreamIdleTimeoutSeconds
    );
    this.db.run(
      `INSERT INTO platform_ai_settings (id, system_prompt, image_tool_model_id, stream_idle_timeout_seconds, updated_at) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET system_prompt = excluded.system_prompt,
         image_tool_model_id = excluded.image_tool_model_id,
         stream_idle_timeout_seconds = excluded.stream_idle_timeout_seconds,
         updated_at = excluded.updated_at`,
      input.systemPrompt ?? String(current.systemPrompt),
      input.imageToolModelId === undefined
        ? (current.imageToolModelId === null ? null : String(current.imageToolModelId))
        : input.imageToolModelId,
      streamIdleTimeoutSeconds,
      timestamp
    );
    return this.getPlatformAiSettings();
  }

  getPlatformUiSettings(): Record<string, unknown> {
    const row = this.db.get("SELECT * FROM platform_ui_settings WHERE id = 1");
    return {
      toastPosition: String(row?.toast_position) === "top-right" ? "top-right" : "bottom-right",
      pageSizes: platformPageSizes(row?.page_sizes_json),
      galaxyFrameRate: galaxyFrameRate(row?.galaxy_frame_rate),
      updatedAt: String(row?.updated_at ?? "")
    };
  }

  updatePlatformUiSettings(input: {
    toastPosition?: "bottom-right" | "top-right";
    pageSizes?: Partial<PlatformPageSizes>;
    galaxyFrameRate?: GalaxyFrameRate;
  }): Record<string, unknown> {
    const timestamp = now();
    const current = this.getPlatformUiSettings();
    const currentPageSizes = platformPageSizes(current.pageSizes);
    const pageSizes = platformPageSizes(JSON.stringify({ ...currentPageSizes, ...input.pageSizes }));
    const toastPosition = input.toastPosition ?? (current.toastPosition === "top-right" ? "top-right" : "bottom-right");
    const frameRate = input.galaxyFrameRate ?? galaxyFrameRate(current.galaxyFrameRate);
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO platform_ui_settings (id, toast_position, page_sizes_json, galaxy_frame_rate, updated_at) VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET toast_position = excluded.toast_position,
           page_sizes_json = excluded.page_sizes_json, galaxy_frame_rate = excluded.galaxy_frame_rate,
           updated_at = excluded.updated_at`,
        toastPosition,
        JSON.stringify(pageSizes),
        frameRate,
        timestamp
      );
      this.audit(PLATFORM_AI_WORK_ID, "platform.ui-settings.updated", "platform-ui-settings", "platform-ui-settings", {
        toastPosition,
        pageSizes,
        galaxyFrameRate: frameRate
      });
    });
    return this.getPlatformUiSettings();
  }

  private analysisTaskQueuedHandler: ((workId: string) => void) | null = null;
  private chapterAnalysisInvalidatedHandler: ((workId: string, chapterId: string, versionNo: number) => void) | null = null;
  private relationshipIndexQueuedHandler: ((workId: string) => void) | null = null;

  setAnalysisTaskQueuedHandler(handler: ((workId: string) => void) | null): void {
    this.analysisTaskQueuedHandler = handler;
  }

  setChapterAnalysisInvalidatedHandler(handler: ((workId: string, chapterId: string, versionNo: number) => void) | null): void {
    this.chapterAnalysisInvalidatedHandler = handler;
  }

  setRelationshipIndexQueuedHandler(handler: ((workId: string) => void) | null): void {
    this.relationshipIndexQueuedHandler = handler;
  }

  private notifyAnalysisTaskQueued(workId: string): void {
    try {
      this.analysisTaskQueuedHandler?.(workId);
    } catch {
      // 自动运行调度失败不影响主写入路径
    }
  }

  private notifyChapterAnalysisInvalidated(workId: string, chapterId: string, versionNo: number): void {
    try {
      this.chapterAnalysisInvalidatedHandler?.(workId, chapterId, versionNo);
    } catch {
      // 稳定等待调度失败不影响主写入路径
    }
  }

  getWorkAiSettings(workId: string): Record<string, unknown> {
    this.getWork(workId);
    const row = this.db.get("SELECT * FROM work_ai_settings WHERE work_id = ?", workId);
    const maximumAgentToolCallLimit = resolveMaxAgentToolCallLimit();
    return {
      workId,
      systemPrompt: String(row?.system_prompt ?? ""),
      dailyTokenQuota: row?.daily_token_quota === null || row?.daily_token_quota === undefined
        ? null
        : Math.max(1, Number(row.daily_token_quota)),
      monthlyTokenQuota: row?.monthly_token_quota === null || row?.monthly_token_quota === undefined
        ? null
        : Math.max(1, Number(row.monthly_token_quota)),
      autoRunEnabled: Number(row?.auto_run_enabled ?? 0) === 1,
      autoRunConcurrency: Math.min(8, Math.max(1, Number(row?.auto_run_concurrency ?? 2) || 2)),
      autoRunBatchLimit: Math.min(200, Math.max(1, Number(row?.auto_run_batch_limit ?? 20) || 20)),
      autoRunDailyTaskLimit: Math.min(10_000, Math.max(0, Number(row?.auto_run_daily_task_limit ?? 0) || 0)),
      autoRunFailureThreshold: Math.min(10, Math.max(1, Number(row?.auto_run_failure_threshold ?? 3) || 3)),
      autoRunStabilityDelayMinutes: Math.min(120, Math.max(1, Number(row?.auto_run_stability_delay_minutes ?? 2) || 2)),
      autoRunPaused: Number(row?.auto_run_paused ?? 0) === 1,
      autoRunPauseReason: String(row?.auto_run_pause_reason ?? ""),
      autoRunResumeAt: row?.auto_run_resume_at === null || row?.auto_run_resume_at === undefined ? null : String(row.auto_run_resume_at),
      autoRunConsecutiveFailures: Math.max(0, Number(row?.auto_run_consecutive_failures ?? 0) || 0),
      bookSummaryContextPercent: Math.min(90, Math.max(1, Number(row?.book_summary_context_percent ?? 50) || 50)),
      contextCompactThreshold: Math.min(90, Math.max(50, Number(row?.context_compact_threshold ?? 85) || 85)),
      agentToolCallLimitMaximum: maximumAgentToolCallLimit,
      agentToolCallLimit: Math.min(maximumAgentToolCallLimit, Math.max(5, Number(row?.agent_tool_call_limit ?? 12) || 12)),
      agentToolCallGlobalMultiplier: Math.min(6, Math.max(1, Number(row?.agent_tool_call_global_multiplier ?? 3) || 3)),
      agentTools: normalizeWorkAgentTools(row?.agent_tools_json),
      imageToolModelId: row?.image_tool_model_id === null || row?.image_tool_model_id === undefined
        ? null
        : String(row.image_tool_model_id),
      alwaysIncludeSettingInfo: Number(row?.always_include_setting_info ?? 0) === 1,
      titleGenerationModelId: row?.title_generation_model_id === null || row?.title_generation_model_id === undefined
        ? null
        : String(row.title_generation_model_id),
      updatedAt: String(row?.updated_at ?? "")
    };
  }

  updateWorkAiSettings(workId: string, input: {
    systemPrompt?: string;
    dailyTokenQuota?: number | null;
    monthlyTokenQuota?: number | null;
    autoRunEnabled?: boolean;
    autoRunConcurrency?: number;
    autoRunBatchLimit?: number;
    autoRunDailyTaskLimit?: number;
    autoRunFailureThreshold?: number;
    autoRunStabilityDelayMinutes?: number;
    bookSummaryContextPercent?: number;
    contextCompactThreshold?: number;
    agentToolCallLimit?: number;
    agentToolCallGlobalMultiplier?: number;
    agentTools?: string[];
    imageToolModelId?: string | null;
    alwaysIncludeSettingInfo?: boolean;
    titleGenerationModelId?: string | null;
  }): Record<string, unknown> {
    this.getWork(workId);
    const current = this.getWorkAiSettings(workId);
    const maximumAgentToolCallLimit = resolveMaxAgentToolCallLimit();
    const timestamp = now();
    const nextPrompt = input.systemPrompt ?? String(current.systemPrompt);
    const nextDailyTokenQuota = input.dailyTokenQuota === undefined
      ? (current.dailyTokenQuota === null ? null : Number(current.dailyTokenQuota))
      : input.dailyTokenQuota;
    const nextMonthlyTokenQuota = input.monthlyTokenQuota === undefined
      ? (current.monthlyTokenQuota === null ? null : Number(current.monthlyTokenQuota))
      : input.monthlyTokenQuota;
    const nextEnabled = input.autoRunEnabled ?? Boolean(current.autoRunEnabled);
    const nextConcurrency = input.autoRunConcurrency ?? Number(current.autoRunConcurrency);
    const nextBatchLimit = input.autoRunBatchLimit ?? Number(current.autoRunBatchLimit);
    const nextDailyTaskLimit = input.autoRunDailyTaskLimit ?? Number(current.autoRunDailyTaskLimit);
    const nextFailureThreshold = input.autoRunFailureThreshold ?? Number(current.autoRunFailureThreshold);
    const nextStabilityDelayMinutes = input.autoRunStabilityDelayMinutes ?? Number(current.autoRunStabilityDelayMinutes);
    const nextBookSummaryContextPercent = input.bookSummaryContextPercent ?? Number(current.bookSummaryContextPercent);
    const nextContextCompactThreshold = input.contextCompactThreshold ?? Number(current.contextCompactThreshold);
    const nextAgentToolCallLimit = input.agentToolCallLimit ?? Number(current.agentToolCallLimit);
    const nextAgentToolCallGlobalMultiplier = input.agentToolCallGlobalMultiplier ?? Number(current.agentToolCallGlobalMultiplier);
    const nextAgentTools = normalizeWorkAgentTools(input.agentTools ?? current.agentTools);
    const nextImageToolModelId = input.imageToolModelId === undefined
      ? (current.imageToolModelId ? String(current.imageToolModelId) : null)
      : input.imageToolModelId?.trim() || null;
    const nextAlwaysIncludeSettingInfo = input.alwaysIncludeSettingInfo ?? Boolean(current.alwaysIncludeSettingInfo);
    const nextTitleGenerationModelId = input.titleGenerationModelId === undefined
      ? (current.titleGenerationModelId ? String(current.titleGenerationModelId) : null)
      : input.titleGenerationModelId?.trim() || null;
    this.db.run(
      `INSERT INTO work_ai_settings (
         work_id, system_prompt, daily_token_quota, monthly_token_quota, auto_run_enabled, auto_run_concurrency, auto_run_batch_limit,
         auto_run_daily_task_limit, auto_run_failure_threshold, auto_run_stability_delay_minutes, auto_run_paused, auto_run_pause_reason,
         auto_run_resume_at, auto_run_consecutive_failures, book_summary_context_percent,
         context_compact_threshold, agent_tool_call_limit, agent_tool_call_global_multiplier,
         agent_tools_json, title_generation_model_id, image_tool_model_id, always_include_setting_info, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(work_id) DO UPDATE SET
         system_prompt = excluded.system_prompt,
         daily_token_quota = excluded.daily_token_quota,
         monthly_token_quota = excluded.monthly_token_quota,
         auto_run_enabled = excluded.auto_run_enabled,
         auto_run_concurrency = excluded.auto_run_concurrency,
         auto_run_batch_limit = excluded.auto_run_batch_limit,
         auto_run_daily_task_limit = excluded.auto_run_daily_task_limit,
         auto_run_failure_threshold = excluded.auto_run_failure_threshold,
         auto_run_stability_delay_minutes = excluded.auto_run_stability_delay_minutes,
         auto_run_paused = excluded.auto_run_paused,
         auto_run_pause_reason = excluded.auto_run_pause_reason,
         auto_run_resume_at = excluded.auto_run_resume_at,
         auto_run_consecutive_failures = excluded.auto_run_consecutive_failures,
         book_summary_context_percent = excluded.book_summary_context_percent,
         context_compact_threshold = excluded.context_compact_threshold,
         agent_tool_call_limit = excluded.agent_tool_call_limit,
         agent_tool_call_global_multiplier = excluded.agent_tool_call_global_multiplier,
         agent_tools_json = excluded.agent_tools_json,
         title_generation_model_id = excluded.title_generation_model_id,
         image_tool_model_id = excluded.image_tool_model_id,
         always_include_setting_info = excluded.always_include_setting_info,
         updated_at = excluded.updated_at`,
      workId,
      nextPrompt,
      nextDailyTokenQuota,
      nextMonthlyTokenQuota,
      nextEnabled ? 1 : 0,
      Math.min(8, Math.max(1, nextConcurrency)),
      Math.min(200, Math.max(1, nextBatchLimit)),
      Math.min(10_000, Math.max(0, nextDailyTaskLimit)),
      Math.min(10, Math.max(1, nextFailureThreshold)),
      Math.min(120, Math.max(1, nextStabilityDelayMinutes)),
      current.autoRunPaused ? 1 : 0,
      String(current.autoRunPauseReason ?? ""),
      current.autoRunResumeAt === null ? null : String(current.autoRunResumeAt),
      Math.max(0, Number(current.autoRunConsecutiveFailures) || 0),
      Math.min(90, Math.max(1, nextBookSummaryContextPercent)),
      Math.min(90, Math.max(50, nextContextCompactThreshold)),
      Math.min(maximumAgentToolCallLimit, Math.max(5, nextAgentToolCallLimit)),
      Math.min(6, Math.max(1, nextAgentToolCallGlobalMultiplier)),
      JSON.stringify(nextAgentTools),
      nextTitleGenerationModelId,
      nextImageToolModelId,
      nextAlwaysIncludeSettingInfo ? 1 : 0,
      timestamp
    );
    this.audit(workId, "work.ai-settings.updated", "work-ai-settings", workId, {
      systemPromptChanged: input.systemPrompt !== undefined,
      dailyTokenQuota: nextDailyTokenQuota,
      monthlyTokenQuota: nextMonthlyTokenQuota,
      autoRunEnabled: nextEnabled,
      autoRunConcurrency: Math.min(8, Math.max(1, nextConcurrency)),
      autoRunBatchLimit: Math.min(200, Math.max(1, nextBatchLimit)),
      autoRunDailyTaskLimit: Math.min(10_000, Math.max(0, nextDailyTaskLimit)),
      autoRunFailureThreshold: Math.min(10, Math.max(1, nextFailureThreshold)),
      autoRunStabilityDelayMinutes: Math.min(120, Math.max(1, nextStabilityDelayMinutes)),
      bookSummaryContextPercent: Math.min(90, Math.max(1, nextBookSummaryContextPercent)),
      contextCompactThreshold: Math.min(90, Math.max(50, nextContextCompactThreshold)),
      agentToolCallLimit: Math.min(maximumAgentToolCallLimit, Math.max(5, nextAgentToolCallLimit)),
      agentToolCallGlobalMultiplier: Math.min(6, Math.max(1, nextAgentToolCallGlobalMultiplier)),
      agentTools: nextAgentTools,
      imageToolModelId: nextImageToolModelId,
      alwaysIncludeSettingInfo: nextAlwaysIncludeSettingInfo,
      titleGenerationModelId: nextTitleGenerationModelId
    });
    return this.getWorkAiSettings(workId);
  }

  clearAutoRunPause(workId: string): Record<string, unknown> {
    this.getWork(workId);
    const current = this.getWorkAiSettings(workId);
    this.db.run(
      `UPDATE work_ai_settings
       SET auto_run_paused = 0, auto_run_pause_reason = '', auto_run_resume_at = NULL,
           auto_run_consecutive_failures = 0, updated_at = ?
       WHERE work_id = ?`,
      now(),
      workId
    );
    if (current.autoRunPaused) {
      this.audit(workId, "task.auto-run.resumed", "work-ai-settings", workId, {
        previousReason: current.autoRunPauseReason
      });
    }
    return this.getWorkAiSettings(workId);
  }

  pauseAutoRun(workId: string, reason: string, resumeAt: string | null = null): Record<string, unknown> {
    this.getWork(workId);
    this.db.run(
      `UPDATE work_ai_settings
       SET auto_run_paused = 1, auto_run_pause_reason = ?, auto_run_resume_at = ?, updated_at = ?
       WHERE work_id = ?`,
      reason.slice(0, 500),
      resumeAt,
      now(),
      workId
    );
    this.audit(workId, "task.auto-run.paused", "work-ai-settings", workId, { reason, resumeAt });
    return this.getWorkAiSettings(workId);
  }

  recordAutoRunSuccess(workId: string): Record<string, unknown> {
    this.getWork(workId);
    this.db.run(
      "UPDATE work_ai_settings SET auto_run_consecutive_failures = 0, updated_at = ? WHERE work_id = ?",
      now(),
      workId
    );
    return this.getWorkAiSettings(workId);
  }

  recordAutoRunFailure(workId: string, message: string, pauseImmediately = false): Record<string, unknown> {
    return this.db.transaction(() => {
      const current = this.getWorkAiSettings(workId);
      const consecutiveFailures = Number(current.autoRunConsecutiveFailures) + 1;
      const shouldPause = pauseImmediately || consecutiveFailures >= Number(current.autoRunFailureThreshold);
      this.db.run(
        `UPDATE work_ai_settings
         SET auto_run_consecutive_failures = ?, auto_run_paused = ?,
             auto_run_pause_reason = CASE WHEN ? = 1 THEN ? ELSE auto_run_pause_reason END,
             auto_run_resume_at = CASE WHEN ? = 1 THEN NULL ELSE auto_run_resume_at END,
             updated_at = ? WHERE work_id = ?`,
        consecutiveFailures,
        shouldPause ? 1 : 0,
        shouldPause ? 1 : 0,
        `连续任务失败，自动执行已暂停：${message}`.slice(0, 500),
        shouldPause ? 1 : 0,
        now(),
        workId
      );
      if (shouldPause) {
        this.audit(workId, "task.auto-run.paused", "work-ai-settings", workId, {
          reason: "consecutive-failures",
          consecutiveFailures,
          message
        });
      }
      return this.getWorkAiSettings(workId);
    });
  }

  updateWork(workId: string, input: Partial<WorkInput>, expectedVersionNo?: number, source = "manual", sourceRef: string | null = null, changeNote = ""): Record<string, unknown> {
    this.db.transaction(() => {
      const current = this.getWork(workId);
      this.assertExpectedVersion("work", workId, expectedVersionNo, "作品", Number(current.versionNo));
      const timestamp = now();
      this.db.run(
        `UPDATE works SET title = ?, author = ?, description = ?, language = ?, cover_url = ?, tags_json = ?, version_no = version_no + 1, updated_at = ?
         WHERE id = ?`,
        input.title ?? String(current.title),
        input.author ?? String(current.author),
        input.description ?? String(current.description),
        input.language ?? String(current.language),
        input.coverUrl === undefined ? (current.coverUrl as string | null) : input.coverUrl,
        JSON.stringify(input.tags ?? current.tags),
        timestamp,
        workId
      );
      this.recordEntityVersion("work", workId, source, sourceRef, changeNote || "更新作品信息", timestamp);
      this.audit(workId, "work.updated", "work", workId, { fields: Object.keys(input), versionNo: Number(current.versionNo) + 1, source, sourceRef, changeNote });
    });
    return this.getWork(workId);
  }

  setWorkOfflineAccess(workId: string, enabled: boolean): Record<string, unknown> {
    this.db.transaction(() => {
      const current = this.getWork(workId);
      if (Boolean(current.offlineAccessEnabled) === enabled) return;
      const timestamp = now();
      this.db.run(
        "UPDATE works SET offline_access_enabled = ?, version_no = version_no + 1, updated_at = ? WHERE id = ?",
        enabled ? 1 : 0,
        timestamp,
        workId
      );
      this.recordEntityVersion(
        "work",
        workId,
        "manual",
        null,
        enabled ? "允许 Desktop 离线访问" : "禁止 Desktop 离线访问",
        timestamp
      );
      this.audit(workId, enabled ? "work.offline-access.enabled" : "work.offline-access.disabled", "work", workId, { enabled });
    });
    return this.getWork(workId);
  }

  deleteWork(workId: string, expectedVersionNo?: number): string[] {
    return this.db.transaction(() => {
      const current = this.getWork(workId);
      this.assertExpectedVersion("work", workId, expectedVersionNo, "作品", Number(current.versionNo));
      const timestamp = now();
      const activeTaskIds = this.db.all(
        "SELECT id FROM analysis_tasks WHERE work_id = ? AND status IN ('pending', 'running') ORDER BY id",
        workId
      ).map((row) => requiredString(row, "id"));
      const versionNo = this.recordEntityVersion("work", workId, "delete", null, "删除作品（可恢复）", timestamp);
      this.db.run("UPDATE works SET version_no = ?, deleted_at = ?, updated_at = ? WHERE id = ?", versionNo, timestamp, timestamp, workId);
      this.db.run(
        `UPDATE analysis_tasks SET status = 'expired', next_attempt_at = NULL, updated_at = ?
         WHERE work_id = ? AND status IN ('pending', 'running')`,
        timestamp,
        workId
      );
      this.db.run("DELETE FROM relationship_source_index_queue WHERE work_id = ?", workId);
      this.audit(workId, "work.deleted", "work", workId, {
        title: current.title,
        versionNo,
        recoverable: true,
        expiresAt: recycleBinExpiresAt(timestamp)
      });
      return activeTaskIds;
    });
  }

  restoreWork(workId: string, expectedVersionNo?: number): Record<string, unknown> {
    const deleted = this.db.get("SELECT * FROM works WHERE id = ? AND deleted_at IS NOT NULL", workId);
    if (!deleted) throw notFound("回收站作品");
    this.assertExpectedVersion("work", workId, expectedVersionNo, "作品", numberValue(deleted, "version_no"));
    this.db.transaction(() => {
      const locked = this.db.get("SELECT * FROM works WHERE id = ? AND deleted_at IS NOT NULL", workId);
      if (!locked) throw new AppError(409, "WORK_ALREADY_RESTORED", "作品已经恢复");
      this.assertExpectedVersion("work", workId, expectedVersionNo, "作品", numberValue(locked, "version_no"));
      const deletionVersion = this.db.get(
        "SELECT id FROM entity_versions WHERE entity_type = 'work' AND entity_id = ? AND source = 'delete' ORDER BY version_no DESC LIMIT 1",
        workId
      );
      const timestamp = now();
      this.db.run("UPDATE works SET deleted_at = NULL, updated_at = ? WHERE id = ?", timestamp, workId);
      const versionNo = this.recordEntityVersion(
        "work",
        workId,
        "restore",
        optionalString(deletionVersion ?? {}, "id"),
        "从回收站恢复作品",
        timestamp
      );
      this.db.run("UPDATE works SET version_no = ? WHERE id = ?", versionNo, workId);
      this.audit(workId, "work.restored", "work", workId, { versionNo, fromRecycleBin: true });
    });
    return this.getWorkDirectory(workId);
  }

  permanentlyDeleteWork(workId: string, expectedVersionNo?: number, reason = "manual"): string[] {
    const deleted = this.db.get("SELECT * FROM works WHERE id = ? AND deleted_at IS NOT NULL", workId);
    if (!deleted) throw new AppError(409, "WORK_NOT_IN_RECYCLE_BIN", "仅回收站中的作品可以彻底删除");
    this.assertExpectedVersion("work", workId, expectedVersionNo, "作品", numberValue(deleted, "version_no"));
    return this.db.transaction(() => {
      const locked = this.db.get("SELECT * FROM works WHERE id = ? AND deleted_at IS NOT NULL", workId);
      if (!locked) throw new AppError(409, "WORK_NOT_IN_RECYCLE_BIN", "仅回收站中的作品可以彻底删除");
      this.assertExpectedVersion("work", workId, expectedVersionNo, "作品", numberValue(locked, "version_no"));
      return this.permanentlyRemoveWorkRow(locked, reason);
    });
  }

  private permanentlyRemoveWorkRow(work: Row, reason: string): string[] {
    const workId = requiredString(work, "id");
    const storageKeys = this.db.all("SELECT DISTINCT storage_key FROM attachments WHERE work_id = ?", workId)
      .map((row) => requiredString(row, "storage_key"));
    this.db.raw.exec("PRAGMA defer_foreign_keys = ON");
    this.audit(null, "work.purged", "work", workId, {
      title: requiredString(work, "title"),
      versionNo: numberValue(work, "version_no"),
      reason,
      recoverable: false
    });
    this.db.run("DELETE FROM characters WHERE work_id = ?", workId);
    this.db.run("DELETE FROM organizations WHERE work_id = ?", workId);
    this.db.run("UPDATE races SET parent_race_id = NULL WHERE work_id = ? AND parent_race_id IS NOT NULL", workId);
    this.db.run("DELETE FROM races WHERE work_id = ?", workId);
    this.db.run("DELETE FROM works WHERE id = ?", workId);
    this.db.run("DELETE FROM relationship_source_index_queue WHERE work_id = ?", workId);
    for (const storageKey of storageKeys) {
      if (!this.attachmentStorageKeyInUse(storageKey)) this.enqueueAttachmentCleanup(storageKey);
    }
    return storageKeys.filter((storageKey) => !this.attachmentStorageKeyInUse(storageKey));
  }

  setWorkCover(workId: string, mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/gif", content: Buffer, expectedVersionNo?: number): Record<string, unknown> {
    const sha256 = createHash("sha256").update(content).digest("hex");
    this.db.transaction(() => {
      const current = this.getWork(workId);
      this.assertExpectedVersion("work", workId, expectedVersionNo, "作品", Number(current.versionNo));
      const timestamp = now();
      this.db.run(
        `INSERT INTO work_covers (work_id, mime_type, content, byte_length, sha256, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(work_id) DO UPDATE SET mime_type = excluded.mime_type, content = excluded.content,
         byte_length = excluded.byte_length, sha256 = excluded.sha256, updated_at = excluded.updated_at`,
        workId,
        mimeType,
        content,
        content.byteLength,
        sha256,
        timestamp
      );
      this.db.run("UPDATE works SET version_no = version_no + 1, updated_at = ? WHERE id = ?", timestamp, workId);
      this.recordEntityVersion("work", workId, "manual", null, "更新作品封面", timestamp);
      this.audit(workId, "work.cover.updated", "work", workId, { mimeType, byteLength: content.byteLength, sha256 });
    });
    return this.getWork(workId);
  }

  getWorkCover(workId: string): { mimeType: string; content: Buffer; byteLength: number; sha256: string; updatedAt: string } {
    const cover = this.findWorkCover(workId);
    if (!cover) throw notFound("作品封面");
    return cover;
  }

  findWorkCover(workId: string): { mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/gif"; content: Buffer; byteLength: number; sha256: string; updatedAt: string } | null {
    this.getWork(workId);
    const row = this.db.get("SELECT * FROM work_covers WHERE work_id = ?", workId);
    if (!row) return null;
    const mimeType = requiredString(row, "mime_type");
    if (mimeType !== "image/jpeg" && mimeType !== "image/png" && mimeType !== "image/webp" && mimeType !== "image/gif") {
      throw new AppError(500, "INVALID_COVER_MIME", "作品封面类型无效");
    }
    return {
      mimeType,
      content: Buffer.from(row.content as Uint8Array),
      byteLength: numberValue(row, "byte_length"),
      sha256: requiredString(row, "sha256"),
      updatedAt: requiredString(row, "updated_at")
    };
  }

  deleteWorkCover(workId: string, expectedVersionNo?: number): void {
    this.db.transaction(() => {
      const current = this.getWork(workId);
      this.assertExpectedVersion("work", workId, expectedVersionNo, "作品", Number(current.versionNo));
      const timestamp = now();
      this.db.run("DELETE FROM work_covers WHERE work_id = ?", workId);
      this.db.run("UPDATE works SET version_no = version_no + 1, updated_at = ? WHERE id = ?", timestamp, workId);
      this.recordEntityVersion("work", workId, "manual", null, "删除作品封面", timestamp);
      this.audit(workId, "work.cover.deleted", "work", workId);
    });
  }

  getWorkTree(workId: string): Record<string, unknown> {
    const work = this.getWork(workId);
    const volumeRows = this.db.all("SELECT * FROM volumes WHERE work_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at", workId);
    const chapterRows = this.db.all("SELECT * FROM chapters WHERE work_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at", workId);
    const chaptersByVolume = new Map<string, Record<string, unknown>[]>();
    for (const row of chapterRows) {
      const chapter = this.mapChapter(row);
      const volumeId = requiredString(row, "volume_id");
      const list = chaptersByVolume.get(volumeId) ?? [];
      list.push(chapter);
      chaptersByVolume.set(volumeId, list);
    }
    const volumes = volumeRows.map((row) => ({
      ...this.mapVolume(row),
      chapters: chaptersByVolume.get(requiredString(row, "id")) ?? []
    }));
    return { ...work, volumes };
  }

  getWorkDirectory(workId: string): Record<string, unknown> {
    const work = this.getWork(workId);
    const permissions = work.modulePermissions as WorkModulePermissions;
    if (permissions.prose === "none") return { ...work, volumes: [] };
    const volumeRows = this.db.all("SELECT * FROM volumes WHERE work_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at", workId);
    const chapterRows = this.db.all(
      `SELECT id, work_id, volume_id, title, chapter_type, sort_order, word_count, version_no,
        analysis_status, excluded_from_analysis, created_at, updated_at
       FROM chapters WHERE work_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at`,
      workId
    );
    const chaptersByVolume = new Map<string, Record<string, unknown>[]>();
    for (const row of chapterRows) {
      const chapter = this.mapChapterDirectoryEntry(row);
      const volumeId = requiredString(row, "volume_id");
      const list = chaptersByVolume.get(volumeId) ?? [];
      list.push(chapter);
      chaptersByVolume.set(volumeId, list);
    }
    const volumes = volumeRows.map((row) => ({
      ...this.mapVolume(row),
      chapters: chaptersByVolume.get(requiredString(row, "id")) ?? []
    }));
    return { ...work, volumes };
  }

  getWorkVolumeDirectory(workId: string): Record<string, unknown> {
    const work = this.getWork(workId);
    const permissions = work.modulePermissions as WorkModulePermissions;
    if (permissions.prose === "none") return { ...work, volumes: [] };
    const volumeRows = this.db.all(
      `SELECT volume.*,
        (SELECT COUNT(*) FROM chapters chapter WHERE chapter.volume_id = volume.id AND chapter.deleted_at IS NULL) AS chapter_count
       FROM volumes volume WHERE volume.work_id = ? AND volume.deleted_at IS NULL ORDER BY volume.sort_order, volume.created_at`,
      workId
    );
    const volumes = volumeRows.map((row) => ({
      ...this.mapVolume(row),
      chapterCount: numberValue(row, "chapter_count"),
      chapters: []
    }));
    return { ...work, volumes };
  }

  listVolumeChapters(volumeId: string): Record<string, unknown>[] {
    const volume = this.getVolume(volumeId);
    const work = this.getWork(String(volume.workId));
    if ((work.modulePermissions as WorkModulePermissions).prose === "none") return [];
    return this.db.all(
      `SELECT id, work_id, volume_id, title, chapter_type, sort_order, word_count, version_no,
        analysis_status, excluded_from_analysis, created_at, updated_at
       FROM chapters WHERE volume_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at`,
      volumeId
    ).map((row) => this.mapChapterDirectoryEntry(row));
  }

  listVolumeChaptersPage(volumeId: string, pagination: Pagination): PaginatedResult<Record<string, unknown>> {
    const volume = this.getVolume(volumeId);
    const work = this.getWork(String(volume.workId));
    if ((work.modulePermissions as WorkModulePermissions).prose === "none") return paginated([], pagination);
    const page = paginationSql(pagination);
    const rows = this.db.all(
      `SELECT id, work_id, volume_id, title, chapter_type, sort_order, word_count, version_no,
        analysis_status, excluded_from_analysis, created_at, updated_at
       FROM chapters WHERE volume_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at${page.sql}`,
      volumeId,
      ...page.params
    );
    return paginated(rows.map((row) => this.mapChapterDirectoryEntry(row)), pagination);
  }

  getWorkDirectoryPage(workId: string, pagination: Pagination): Record<string, unknown> {
    const work = this.getWork(workId);
    const permissions = work.modulePermissions as WorkModulePermissions;
    if (permissions.prose === "none") return { ...work, volumes: [], directoryPage: paginated([], pagination) };
    const volumeRows = this.db.all("SELECT * FROM volumes WHERE work_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at", workId);
    const page = paginationSql(pagination);
    const chapterRows = this.db.all(
      `SELECT id, work_id, volume_id, title, chapter_type, sort_order, word_count, version_no,
        analysis_status, excluded_from_analysis, created_at, updated_at
       FROM chapters WHERE work_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at${page.sql}`,
      workId,
      ...page.params
    );
    const pageResult = paginated(chapterRows.map((row) => this.mapChapterDirectoryEntry(row)), pagination);
    const chaptersByVolume = new Map<string, Record<string, unknown>[]>();
    for (const chapter of pageResult.items) {
      const volumeId = String(chapter.volumeId);
      const list = chaptersByVolume.get(volumeId) ?? [];
      list.push(chapter);
      chaptersByVolume.set(volumeId, list);
    }
    const volumes = volumeRows.map((row) => ({
      ...this.mapVolume(row),
      chapters: chaptersByVolume.get(requiredString(row, "id")) ?? []
    }));
    return { ...work, volumes, directoryPage: pageResult };
  }

  getStoryIndexChapterPage(
    workId: string,
    offset: number,
    limit: number,
    options: { excludeAuthorNotes?: boolean; includeTimeline?: boolean } = {}
  ): StoryIndexChapterPage {
    const work = this.getWork(workId);
    const permissions = work.modulePermissions as WorkModulePermissions;
    if (permissions.prose === "none") return { totalChapters: 0, latestChaptersByStructure: [], chapters: [] };
    const authorNoteFilter = options.excludeAuthorNotes ? " AND chapter.chapter_type <> '作者的话'" : "";
    const countRow = this.db.get(
      `SELECT COUNT(*) AS count FROM chapters chapter
       JOIN volumes volume ON volume.id = chapter.volume_id
       WHERE chapter.work_id = ? AND chapter.deleted_at IS NULL AND volume.deleted_at IS NULL${authorNoteFilter}`,
      workId
    );
    const chapterRows = this.db.all(
      `SELECT chapter.id, chapter.title, chapter.version_no
       FROM chapters chapter
       JOIN volumes volume ON volume.id = chapter.volume_id
       WHERE chapter.work_id = ? AND chapter.deleted_at IS NULL AND volume.deleted_at IS NULL${authorNoteFilter}
       ORDER BY volume.story_order, volume.sort_order, volume.created_at, chapter.sort_order, chapter.created_at
       LIMIT ? OFFSET ?`,
      workId,
      limit,
      offset
    );
    const latestChapterRows = this.db.all(
      `SELECT chapter.id, chapter.title, chapter.version_no
       FROM chapters chapter
       JOIN volumes volume ON volume.id = chapter.volume_id
       WHERE chapter.work_id = ? AND chapter.deleted_at IS NULL AND volume.deleted_at IS NULL
         AND chapter.chapter_type = '正文'
         AND volume.story_order = (
           SELECT MAX(candidate_volume.story_order)
           FROM volumes candidate_volume
           WHERE candidate_volume.work_id = ? AND candidate_volume.deleted_at IS NULL
             AND EXISTS (
               SELECT 1 FROM chapters candidate_volume_chapter
               WHERE candidate_volume_chapter.volume_id = candidate_volume.id
                 AND candidate_volume_chapter.deleted_at IS NULL
                 AND candidate_volume_chapter.chapter_type = '正文'
             )
         )
         AND chapter.sort_order = (
           SELECT MAX(candidate_chapter.sort_order)
           FROM chapters candidate_chapter
           WHERE candidate_chapter.volume_id = chapter.volume_id
             AND candidate_chapter.deleted_at IS NULL
             AND candidate_chapter.chapter_type = '正文'
         )
       ORDER BY volume.created_at, volume.id, chapter.created_at, chapter.id`,
      workId,
      workId
    );
    const chapterIds = [...new Set([...chapterRows, ...latestChapterRows].map((row) => requiredString(row, "id")))];
    const storyOrders = this.getChapterStoryOrders(workId, chapterIds, { includeTimeline: options.includeTimeline });
    const summaries = new Map<string, string>();
    if (chapterIds.length > 0) {
      const placeholders = chapterIds.map(() => "?").join(", ");
      const insightRows = this.db.all(
        `SELECT insight.chapter_id, insight.summary
         FROM chapter_insights insight
         JOIN chapters chapter ON chapter.id = insight.chapter_id AND chapter.version_no = insight.chapter_version
         WHERE chapter.work_id = ? AND insight.chapter_id IN (${placeholders})
           AND NOT EXISTS (
             SELECT 1 FROM chapter_insights newer
             WHERE newer.chapter_id = insight.chapter_id
               AND newer.chapter_version = insight.chapter_version
               AND (newer.created_at > insight.created_at OR (newer.created_at = insight.created_at AND newer.id > insight.id))
           )`,
        workId,
        ...chapterIds
      );
      for (const row of insightRows) summaries.set(requiredString(row, "chapter_id"), requiredString(row, "summary"));
    }
    return {
      totalChapters: numberValue(countRow ?? {}, "count"),
      latestChaptersByStructure: latestChapterRows.map((row) => {
        const chapterId = requiredString(row, "id");
        return {
          id: chapterId,
          title: requiredString(row, "title"),
          versionNo: numberValue(row, "version_no"),
          storyOrder: storyOrders.get(chapterId) as ChapterStoryOrderDetails,
          summary: summaries.get(chapterId) ?? ""
        };
      }),
      chapters: chapterRows.map((row) => {
        const chapterId = requiredString(row, "id");
        return {
          id: chapterId,
          title: requiredString(row, "title"),
          versionNo: numberValue(row, "version_no"),
          storyOrder: storyOrders.get(chapterId) as ChapterStoryOrderDetails,
          summary: summaries.get(chapterId) ?? ""
        };
      })
    };
  }

  getChapterStoryOrders(
    workId: string,
    chapterIds: string[],
    options: { includeTimeline?: boolean } = {}
  ): Map<string, ChapterStoryOrderDetails> {
    const work = this.getWork(workId);
    const permissions = work.modulePermissions as WorkModulePermissions;
    if (permissions.prose === "none") return new Map();
    const includeTimeline = options.includeTimeline === true && permissions.timeline !== "none";
    const uniqueChapterIds = [...new Set(chapterIds)].slice(0, 500);
    if (!uniqueChapterIds.length) return new Map();
    const placeholders = uniqueChapterIds.map(() => "?").join(", ");
    const rows = this.db.all(
      `SELECT chapter.id AS chapter_id, chapter.chapter_type, chapter.sort_order AS chapter_order,
        volume.id AS volume_id, volume.title AS volume_title, volume.sort_order AS volume_directory_order,
        volume.story_order AS volume_story_order,
        CASE WHEN chapter.chapter_type = '正文'
          AND volume.story_order = (
            SELECT MAX(candidate_volume.story_order)
            FROM volumes candidate_volume
            WHERE candidate_volume.work_id = chapter.work_id AND candidate_volume.deleted_at IS NULL
              AND EXISTS (
                SELECT 1 FROM chapters candidate_volume_chapter
                WHERE candidate_volume_chapter.volume_id = candidate_volume.id
                  AND candidate_volume_chapter.deleted_at IS NULL AND candidate_volume_chapter.chapter_type = '正文'
              )
          )
          AND chapter.sort_order = (
            SELECT MAX(candidate_chapter.sort_order)
            FROM chapters candidate_chapter
            WHERE candidate_chapter.volume_id = chapter.volume_id
              AND candidate_chapter.deleted_at IS NULL AND candidate_chapter.chapter_type = '正文'
          )
        THEN 1 ELSE 0 END AS is_latest_by_structure
       FROM chapters chapter
       JOIN volumes volume ON volume.id = chapter.volume_id AND volume.work_id = chapter.work_id
       WHERE chapter.work_id = ? AND chapter.deleted_at IS NULL AND volume.deleted_at IS NULL
         AND chapter.id IN (${placeholders})`,
      workId,
      ...uniqueChapterIds
    );
    const result = new Map<string, ChapterStoryOrderDetails>();
    for (const row of rows) {
      result.set(requiredString(row, "chapter_id"), {
        volume: {
          volumeId: requiredString(row, "volume_id"),
          volumeTitle: requiredString(row, "volume_title"),
          directoryOrder: numberValue(row, "volume_directory_order"),
          storyOrder: numberValue(row, "volume_story_order")
        },
        chapter: {
          order: numberValue(row, "chapter_order"),
          type: requiredString(row, "chapter_type") as ChapterType,
          isLatestByStructure: booleanValue(row, "is_latest_by_structure")
        },
        ...(includeTimeline ? { confirmedTimelineEvents: [] } : {})
      });
    }
    if (!includeTimeline || result.size === 0) return result;
    const timelineRows = this.db.all(
      `SELECT event.id, event.name, event.event_type, event.time_label, event.time_sort,
        event.track_id, track.name AS track_name, track.sort_order AS track_order, event.chapter_ids_json
       FROM timeline_events event
       LEFT JOIN timeline_tracks track ON track.id = event.track_id
       WHERE event.work_id = ? AND event.status = 'confirmed' AND event.time_sort IS NOT NULL
         AND typeof(event.time_sort) IN ('integer', 'real') AND json_valid(event.chapter_ids_json)
         AND EXISTS (
           SELECT 1 FROM json_each(event.chapter_ids_json) linked_chapter
           WHERE linked_chapter.value IN (${placeholders})
         )
       ORDER BY event.track_id IS NOT NULL, track.sort_order, event.time_sort, event.created_at, event.id`,
      workId,
      ...uniqueChapterIds
    );
    const requestedIds = new Set(uniqueChapterIds);
    for (const row of timelineRows) {
      const timeSort = Number(row.time_sort);
      if (!Number.isFinite(timeSort)) continue;
      const event: ConfirmedTimelineOrderEvent = {
        id: requiredString(row, "id"),
        name: requiredString(row, "name"),
        eventType: requiredString(row, "event_type"),
        timeLabel: requiredString(row, "time_label"),
        timeSort,
        trackId: optionalString(row, "track_id"),
        trackName: optionalString(row, "track_name"),
        trackOrder: row.track_order === null || row.track_order === undefined ? null : numberValue(row, "track_order")
      };
      for (const chapterId of json<string[]>(requiredString(row, "chapter_ids_json"), [])) {
        if (!requestedIds.has(chapterId)) continue;
        result.get(chapterId)?.confirmedTimelineEvents?.push(event);
      }
    }
    return result;
  }

  listFileVersions(workId: string): Record<string, unknown>[] {
    this.getWork(workId);
    return this.db
      .all(`SELECT version.id, version.work_id, version.file_name, version.file_type, version.word_count, version.paragraph_count,
        version.warnings_json, version.created_at, user.display_name AS actor_display_name, user.username AS actor_username
        FROM file_versions version LEFT JOIN users user ON user.id = version.created_by_user_id
        WHERE version.work_id = ? ORDER BY version.created_at DESC, version.id DESC`, workId)
      .map((row) => ({
        id: requiredString(row, "id"),
        workId: requiredString(row, "work_id"),
        fileName: requiredString(row, "file_name"),
        fileType: requiredString(row, "file_type"),
        wordCount: numberValue(row, "word_count"),
        paragraphCount: numberValue(row, "paragraph_count"),
        warnings: json(requiredString(row, "warnings_json"), []),
        createdAt: requiredString(row, "created_at"),
        actor: optionalString(row, "actor_display_name") ?? optionalString(row, "actor_username") ?? "历史数据"
      }));
  }

  listFileVersionsPage(workId: string, pagination: Pagination): PaginatedResult<Record<string, unknown>> {
    this.getWork(workId);
    const page = paginationSql(pagination);
    const rows = this.db.all(
      `SELECT version.id, version.work_id, version.file_name, version.file_type, version.word_count, version.paragraph_count,
        version.warnings_json, version.created_at, user.display_name AS actor_display_name, user.username AS actor_username
       FROM file_versions version LEFT JOIN users user ON user.id = version.created_by_user_id
       WHERE version.work_id = ? ORDER BY version.created_at DESC, version.id DESC${page.sql}`,
      workId,
      ...page.params
    );
    return paginated(rows.map((row) => ({
      id: requiredString(row, "id"),
      workId: requiredString(row, "work_id"),
      fileName: requiredString(row, "file_name"),
      fileType: requiredString(row, "file_type"),
      wordCount: numberValue(row, "word_count"),
      paragraphCount: numberValue(row, "paragraph_count"),
      warnings: json(requiredString(row, "warnings_json"), []),
      createdAt: requiredString(row, "created_at"),
      actor: optionalString(row, "actor_display_name") ?? optionalString(row, "actor_username") ?? "历史数据"
    })), pagination);
  }

  restoreFileVersion(workId: string, fileVersionId: string, expectedVersionNo?: number): Record<string, unknown> {
    this.getWork(workId);
    const version = this.db.get("SELECT * FROM file_versions WHERE id = ? AND work_id = ?", fileVersionId, workId);
    if (!version) throw notFound("文件版本");
    const { volumes } = parseRestorableFileSnapshot(requiredString(version, "snapshot_json"), workId);
    return this.db.transaction(() => {
      const current = this.getWork(workId);
      this.assertExpectedVersion("work", workId, expectedVersionNo, "作品", Number(current.versionNo));
      const currentTree = this.getWorkTree(workId);
      const currentChapters = this.db.all("SELECT content FROM chapters WHERE work_id = ? AND deleted_at IS NULL", workId);
      const wordCount = currentChapters.reduce((sum, row) => sum + countWords(requiredString(row, "content")), 0);
      const paragraphCount = currentChapters.reduce((sum, row) => {
        const content = requiredString(row, "content").trim();
        return sum + (content ? content.split(/\n+/u).filter(Boolean).length : 0);
      }, 0);
      const restorePointId = id("file");
      const timestamp = now();
      this.db.run(
        `INSERT INTO file_versions (id, work_id, file_name, file_type, word_count, paragraph_count, warnings_json, snapshot_json, created_at, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        restorePointId,
        workId,
        `before-restore:${requiredString(version, "file_name")}`,
        "snapshot",
        wordCount,
        paragraphCount,
        "[]",
        JSON.stringify(currentTree),
        timestamp,
        currentRequestActor()?.userId ?? null
      );
      const activeVolumeIds = this.db.all("SELECT id FROM volumes WHERE work_id = ? AND deleted_at IS NULL", workId)
        .map((row) => requiredString(row, "id"));
      for (const volumeId of activeVolumeIds) {
        this.recordEntityVersion("volume", volumeId, "delete", fileVersionId, "替换作品树前保存分卷历史");
      }
      this.clearDraftVolumeBindings(workId, activeVolumeIds, fileVersionId, "恢复文件版本时原分卷已被替换");
      this.db.run("DELETE FROM volumes WHERE work_id = ? AND deleted_at IS NULL", workId);
      for (const volume of volumes) {
        const volumeId = id("volume");
        this.insertVolumeWithId(workId, volumeId, {
          title: volume.title,
          kind: volume.kind,
          source: volume.source,
          description: volume.description,
          keywords: volume.keywords,
          sortOrder: volume.sortOrder,
          storyOrder: volume.storyOrder
        }, "restore", fileVersionId, `恢复文件版本 ${fileVersionId}`);
        for (const chapter of volume.chapters) {
          this.insertChapter(
            workId,
            volumeId,
            chapter.title,
            chapter.content,
            chapter.sortOrder,
            "restore",
            fileVersionId,
            chapter.chapterType
          );
        }
      }
      this.db.run("UPDATE works SET version_no = version_no + 1, updated_at = ? WHERE id = ?", timestamp, workId);
      this.recordEntityVersion("work", workId, "restore", fileVersionId, `恢复文件版本 ${fileVersionId}`, timestamp);
      this.audit(workId, "file.restored", "file-version", fileVersionId, { restorePointId });
      return {
        fileVersionId: restorePointId,
        restoredFrom: fileVersionId,
        tree: this.getWorkDirectory(workId)
      };
    });
  }

  importNovel(workId: string, fileName: string, fileType: string, parsed: ParsedNovel, mode: ImportMode = "overwrite", expectedVersionNo?: number): Record<string, unknown> {
    this.getWork(workId);
    let result: Record<string, unknown> = {};
    this.db.transaction(() => { result = this.importNovelInTransaction(workId, fileName, fileType, parsed, mode, expectedVersionNo); });
    return { ...result, tree: this.getWorkDirectory(workId) };
  }

  createImportedWork(input: WorkInput, fileName: string, fileType: string, parsed: ParsedNovel, ownerUserId: string | null = null): Record<string, unknown> {
    return this.db.transaction(() => {
      const work = this.createWork(input, ownerUserId);
      const imported = this.importNovelInTransaction(String(work.id), fileName, fileType, parsed, undefined, undefined, false);
      return { ...imported, work: this.getWork(String(work.id)) };
    });
  }

  private importNovelInTransaction(workId: string, fileName: string, fileType: string, parsed: ParsedNovel, mode: ImportMode = "overwrite", expectedVersionNo?: number, bumpWorkVersion = true): Record<string, unknown> {
    const current = this.getWork(workId);
    this.assertExpectedVersion("work", workId, expectedVersionNo, "作品", Number(current.versionNo));
    const fileVersionId = id("file");
    const timestamp = now();
    const snapshot = this.getWorkTree(workId);
    this.db.run(
      `INSERT INTO file_versions (id, work_id, file_name, file_type, word_count, paragraph_count, warnings_json, snapshot_json, created_at, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      fileVersionId,
      workId,
      fileName,
      fileType,
      parsed.wordCount,
      parsed.paragraphCount,
      JSON.stringify(parsed.warnings),
      JSON.stringify(snapshot),
      timestamp,
      currentRequestActor()?.userId ?? null
    );
    let volumeOrderOffset = 0;
    let volumeStoryOrderOffset = 0;
    if (mode === "overwrite") {
      const activeVolumeIds = this.db.all("SELECT id FROM volumes WHERE work_id = ? AND deleted_at IS NULL", workId)
        .map((row) => requiredString(row, "id"));
      for (const volumeId of activeVolumeIds) {
        this.recordEntityVersion("volume", volumeId, "delete", fileVersionId, "导入前保存分卷历史");
      }
      this.clearDraftVolumeBindings(workId, activeVolumeIds, fileVersionId, "覆盖导入时原分卷已被替换");
      this.db.run("DELETE FROM volumes WHERE work_id = ? AND deleted_at IS NULL", workId);
    } else {
      const lastVolume = this.db.get("SELECT COALESCE(MAX(sort_order), -1) AS value FROM volumes WHERE work_id = ? AND deleted_at IS NULL", workId);
      const lastStoryVolume = this.db.get("SELECT COALESCE(MAX(story_order), -1) AS value FROM volumes WHERE work_id = ? AND deleted_at IS NULL", workId);
      volumeOrderOffset = numberValue(lastVolume ?? {}, "value") + 1;
      volumeStoryOrderOffset = numberValue(lastStoryVolume ?? {}, "value") + 1;
    }
    let firstImportedChapterId: string | null = null;
    for (const volume of parsed.volumes) {
      const volumeId = id("volume");
      this.insertVolumeWithId(workId, volumeId, {
        title: volume.title,
        kind: volume.kind,
        source: volume.source,
        sortOrder: volumeOrderOffset + volume.order,
        storyOrder: volumeStoryOrderOffset + volume.order
      }, "import", fileVersionId, "导入分卷");
      for (const chapter of volume.chapters) {
        const chapterId = this.insertChapter(workId, volumeId, chapter.title, chapter.content, chapter.order, "import", fileVersionId, chapter.chapterType);
        firstImportedChapterId ??= chapterId;
      }
    }
    if (bumpWorkVersion) {
      this.db.run("UPDATE works SET version_no = version_no + 1, updated_at = ? WHERE id = ?", timestamp, workId);
      this.recordEntityVersion("work", workId, "import", fileVersionId, "导入作品正文", timestamp);
    }
    this.audit(workId, "work.imported", "file-version", fileVersionId, {
      fileName,
      mode,
      volumeCount: parsed.volumes.length,
      chapterCount: parsed.volumes.reduce((sum, volume) => sum + volume.chapters.length, 0)
    });
    return {
      fileVersionId,
      firstImportedChapterId,
      mode,
      warnings: parsed.warnings,
      wordCount: parsed.wordCount,
      paragraphCount: parsed.paragraphCount
    };
  }

  createVolume(workId: string, input: VolumeInput): Record<string, unknown> {
    return this.db.transaction(() => this.insertVolumeWithId(workId, id("volume"), input, "create", null, "建立分卷"));
  }

  private insertVolumeWithId(
    workId: string,
    volumeId: string,
    input: VolumeInput,
    source = "create",
    sourceRef: string | null = null,
    changeNote = ""
  ): Record<string, unknown> {
    this.getWork(workId);
    const timestamp = now();
    const last = this.db.get("SELECT COALESCE(MAX(sort_order), -1) AS value FROM volumes WHERE work_id = ? AND deleted_at IS NULL", workId);
    const lastStory = this.db.get("SELECT COALESCE(MAX(story_order), -1) AS value FROM volumes WHERE work_id = ? AND deleted_at IS NULL", workId);
    this.db.run(
      `INSERT INTO volumes (id, work_id, title, kind, source, description, keywords_json, sort_order, story_order, version_no, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      volumeId,
      workId,
      input.title,
      input.kind ?? "main",
      input.source ?? "manual",
      input.description?.trim() ?? "",
      JSON.stringify(this.normalizeVolumeKeywords(input.keywords ?? [])),
      input.sortOrder ?? numberValue(last ?? {}, "value") + 1,
      input.storyOrder ?? numberValue(lastStory ?? {}, "value") + 1,
      timestamp,
      timestamp
    );
    const versionNo = this.recordEntityVersion("volume", volumeId, source, sourceRef, changeNote || "建立分卷", timestamp);
    if (versionNo !== 1) this.db.run("UPDATE volumes SET version_no = ? WHERE id = ?", versionNo, volumeId);
    this.audit(workId, source === "restore" ? "volume.restored" : "volume.created", "volume", volumeId, { source, sourceRef });
    return this.getVolume(volumeId);
  }

  getVolume(volumeId: string): Record<string, unknown> {
    const row = this.db.get(
      `SELECT volume.* FROM volumes volume JOIN works work ON work.id = volume.work_id
       WHERE volume.id = ? AND volume.deleted_at IS NULL AND work.deleted_at IS NULL`,
      volumeId
    );
    if (!row) throw notFound("卷");
    return this.mapVolume(row);
  }

  updateVolume(volumeId: string, input: Partial<VolumeInput>, expectedVersionNo?: number, source = "manual", sourceRef: string | null = null, changeNote = ""): Record<string, unknown> {
    this.db.transaction(() => {
      const current = this.getVolume(volumeId);
      this.assertExpectedVersion("volume", volumeId, expectedVersionNo, "分卷", Number(current.versionNo));
      const timestamp = now();
      this.db.run(
        "UPDATE volumes SET title = ?, kind = ?, description = ?, keywords_json = ?, sort_order = ?, story_order = ?, source = ?, version_no = version_no + 1, updated_at = ? WHERE id = ?",
        input.title ?? String(current.title),
        input.kind ?? String(current.kind),
        input.description?.trim() ?? String(current.description),
        JSON.stringify(input.keywords === undefined ? current.keywords : this.normalizeVolumeKeywords(input.keywords)),
        input.sortOrder ?? Number(current.sortOrder),
        input.storyOrder ?? Number(current.storyOrder),
        source === "restore" ? String(current.source) : "manual",
        timestamp,
        volumeId
      );
      this.recordEntityVersion("volume", volumeId, source, sourceRef, changeNote || "更新分卷信息", timestamp);
      this.audit(String(current.workId), "volume.updated", "volume", volumeId, { ...input, versionNo: Number(current.versionNo) + 1, source, sourceRef, changeNote });
    });
    return this.getVolume(volumeId);
  }

  deleteVolume(volumeId: string, expectedVersionNo?: number): void {
    this.db.transaction(() => {
      const current = this.getVolume(volumeId);
      this.assertExpectedVersion("volume", volumeId, expectedVersionNo, "分卷", Number(current.versionNo));
      const timestamp = now();
      const workId = String(current.workId);
      const versionNo = this.recordEntityVersion("volume", volumeId, "delete", null, "删除分卷（可恢复）", timestamp);
      const activeChapters = this.db.all("SELECT id FROM chapters WHERE volume_id = ? AND deleted_at IS NULL", volumeId);
      this.db.run("UPDATE volumes SET version_no = ?, deleted_at = ?, updated_at = ? WHERE id = ?", versionNo, timestamp, timestamp, volumeId);
      for (const chapter of activeChapters) {
        const chapterId = requiredString(chapter, "id");
        this.db.run("UPDATE chapters SET deleted_at = ?, deleted_via_volume_id = ?, updated_at = ? WHERE id = ?", timestamp, volumeId, timestamp, chapterId);
        this.db.run("DELETE FROM chapter_paragraph_search WHERE chapter_id = ?", chapterId);
      }
      this.db.run(
        `UPDATE analysis_tasks SET status = 'expired', updated_at = ?
         WHERE work_id = ? AND status IN ('pending', 'running', 'completed', 'partial', 'review')
           AND (json_extract(scope_json, '$.type') = 'book'
             OR (json_extract(scope_json, '$.type') = 'volume' AND json_extract(scope_json, '$.volumeId') = ?)
             OR EXISTS (SELECT 1 FROM json_each(scope_json, '$.volumeIds') WHERE json_each.value = ?)
             OR EXISTS (
               SELECT 1 FROM json_each(scope_json, '$.chapterIds') selected_chapter
               WHERE selected_chapter.value IN (SELECT id FROM chapters WHERE volume_id = ?)
             ))`,
        timestamp,
        workId,
        volumeId,
        volumeId,
        volumeId
      );
      this.db.run("UPDATE works SET updated_at = ? WHERE id = ?", timestamp, workId);
      this.audit(workId, "volume.deleted", "volume", volumeId, {
        versionNo,
        chapterCount: activeChapters.length,
        recoverable: true,
        expiresAt: recycleBinExpiresAt(timestamp)
      });
    });
  }

  listDeletedVolumes(workId: string): Record<string, unknown>[] {
    this.getWork(workId);
    return this.db.all(
      `SELECT volume.*,
        (SELECT COUNT(*) FROM chapters chapter WHERE chapter.volume_id = volume.id) AS chapter_count,
        user.display_name AS actor_display_name, user.username AS actor_username
       FROM volumes volume
       LEFT JOIN entity_versions version
         ON version.entity_type = 'volume' AND version.entity_id = volume.id
         AND version.version_no = volume.version_no AND version.source = 'delete'
       LEFT JOIN users user ON user.id = version.created_by_user_id
       WHERE volume.work_id = ? AND volume.deleted_at IS NOT NULL
       ORDER BY volume.deleted_at DESC, volume.id DESC`,
      workId
    ).map((row) => {
      const deletedAt = requiredString(row, "deleted_at");
      return {
        ...this.mapVolume(row),
        chapterCount: numberValue(row, "chapter_count"),
        deletedAt,
        expiresAt: recycleBinExpiresAt(deletedAt),
        actor: optionalString(row, "actor_display_name") ?? optionalString(row, "actor_username") ?? "历史数据"
      };
    });
  }

  restoreVolume(volumeId: string, expectedVersionNo?: number): Record<string, unknown> {
    const deleted = this.db.get("SELECT * FROM volumes WHERE id = ? AND deleted_at IS NOT NULL", volumeId);
    if (!deleted) throw notFound("回收站分卷");
    const workId = requiredString(deleted, "work_id");
    this.getWork(workId);
    this.assertExpectedVersion("volume", volumeId, expectedVersionNo, "分卷", numberValue(deleted, "version_no"));
    this.db.transaction(() => {
      const locked = this.db.get("SELECT * FROM volumes WHERE id = ? AND deleted_at IS NOT NULL", volumeId);
      if (!locked) throw new AppError(409, "VOLUME_ALREADY_RESTORED", "分卷已经恢复");
      this.assertExpectedVersion("volume", volumeId, expectedVersionNo, "分卷", numberValue(locked, "version_no"));
      const deletionVersion = this.db.get(
        "SELECT id FROM entity_versions WHERE entity_type = 'volume' AND entity_id = ? AND source = 'delete' ORDER BY version_no DESC LIMIT 1",
        volumeId
      );
      const timestamp = now();
      this.db.run("UPDATE volumes SET deleted_at = NULL, updated_at = ? WHERE id = ?", timestamp, volumeId);
      const versionNo = this.recordEntityVersion(
        "volume",
        volumeId,
        "restore",
        optionalString(deletionVersion ?? {}, "id"),
        "从回收站恢复分卷",
        timestamp
      );
      this.db.run("UPDATE volumes SET version_no = ? WHERE id = ?", versionNo, volumeId);
      const chapters = this.db.all("SELECT id, content, version_no FROM chapters WHERE deleted_via_volume_id = ?", volumeId);
      for (const chapter of chapters) {
        const chapterId = requiredString(chapter, "id");
        this.db.run(
          "UPDATE chapters SET deleted_at = NULL, deleted_via_volume_id = NULL, analysis_status = 'expired', updated_at = ? WHERE id = ?",
          timestamp,
          chapterId
        );
        this.syncChapterParagraphSearch(workId, chapterId, requiredString(chapter, "content"));
        this.invalidateChapter(workId, chapterId, numberValue(chapter, "version_no"));
      }
      this.db.run("UPDATE works SET updated_at = ? WHERE id = ?", timestamp, workId);
      this.audit(workId, "volume.restored", "volume", volumeId, { versionNo, chapterCount: chapters.length, fromRecycleBin: true });
    });
    return this.getVolume(volumeId);
  }

  permanentlyDeleteVolume(volumeId: string, expectedVersionNo?: number, reason = "manual"): void {
    const deleted = this.db.get("SELECT * FROM volumes WHERE id = ? AND deleted_at IS NOT NULL", volumeId);
    if (!deleted) throw new AppError(409, "VOLUME_NOT_IN_RECYCLE_BIN", "仅回收站中的分卷可以彻底删除");
    this.assertExpectedVersion("volume", volumeId, expectedVersionNo, "分卷", numberValue(deleted, "version_no"));
    this.db.transaction(() => {
      const locked = this.db.get("SELECT * FROM volumes WHERE id = ? AND deleted_at IS NOT NULL", volumeId);
      if (!locked) throw new AppError(409, "VOLUME_NOT_IN_RECYCLE_BIN", "仅回收站中的分卷可以彻底删除");
      this.assertExpectedVersion("volume", volumeId, expectedVersionNo, "分卷", numberValue(locked, "version_no"));
      this.permanentlyRemoveVolumeRow(locked, reason);
    });
  }

  private permanentlyRemoveVolumeRow(volume: Row, reason: string): void {
    const volumeId = requiredString(volume, "id");
    const workId = requiredString(volume, "work_id");
    const chapters = this.db.all("SELECT * FROM chapters WHERE volume_id = ?", volumeId);
    for (const chapter of chapters) this.permanentlyRemoveChapterRow(chapter, reason, false);
    this.clearDraftVolumeBindings(workId, [volumeId], null, "绑定的分卷已彻底删除");
    this.db.run("DELETE FROM entity_versions WHERE entity_type = 'volume' AND entity_id = ?", volumeId);
    this.db.run("DELETE FROM volumes WHERE id = ?", volumeId);
    this.db.run("UPDATE works SET updated_at = ? WHERE id = ?", now(), workId);
    this.audit(workId, "volume.purged", "volume", volumeId, {
      title: requiredString(volume, "title"),
      chapterCount: chapters.length,
      versionNo: numberValue(volume, "version_no"),
      reason,
      recoverable: false
    });
  }

  createChapter(workId: string, input: { volumeId: string; title: string; content?: string; chapterType?: ChapterType }): Record<string, unknown> {
    return this.db.transaction(() => {
      this.getWork(workId);
      const volume = this.getVolume(input.volumeId);
      if (volume.workId !== workId) throw new AppError(400, "VOLUME_WORK_MISMATCH", "卷不属于当前作品");
      const last = this.db.get("SELECT COALESCE(MAX(sort_order), -1) AS value FROM chapters WHERE volume_id = ? AND deleted_at IS NULL", input.volumeId);
      const chapterId = this.insertChapter(
        workId,
        input.volumeId,
        input.title,
        input.content ?? "",
        numberValue(last ?? {}, "value") + 1,
        "manual",
        null,
        input.chapterType ?? "正文"
      );
      this.audit(workId, "chapter.created", "chapter", chapterId);
      return this.getChapter(chapterId);
    });
  }

  getChapter(chapterId: string): Record<string, unknown> {
    const row = this.db.get(
      `SELECT chapter.* FROM chapters chapter
       JOIN volumes volume ON volume.id = chapter.volume_id
       JOIN works work ON work.id = chapter.work_id
       WHERE chapter.id = ? AND chapter.deleted_at IS NULL
         AND volume.deleted_at IS NULL AND work.deleted_at IS NULL`,
      chapterId
    );
    if (!row) throw notFound("章节");
    return this.mapChapter(row);
  }

  listDeletedChapters(workId: string): Record<string, unknown>[] {
    this.getWork(workId);
    return this.findDeletedChapterRows(workId).map((row) => this.mapDeletedChapter(row));
  }

  listDeletedChaptersPage(workId: string, pagination: Pagination): PaginatedResult<Record<string, unknown>> {
    this.getWork(workId);
    const page = paginationSql(pagination);
    const rows = this.findDeletedChapterRows(workId, page.sql, page.params);
    return paginated(rows.map((row) => this.mapDeletedChapter(row)), pagination);
  }

  private findDeletedChapterRows(workId: string, pageSql = "", pageParams: Array<string | number> = []): Row[] {
    return this.db.all(
      `SELECT chapter.*, volume.title AS volume_title,
        user.display_name AS actor_display_name, user.username AS actor_username
       FROM chapters chapter
       JOIN volumes volume ON volume.id = chapter.volume_id
       LEFT JOIN chapter_versions version
         ON version.chapter_id = chapter.id AND version.version_no = chapter.version_no AND version.source = 'delete'
       LEFT JOIN users user ON user.id = version.created_by_user_id
       WHERE chapter.work_id = ? AND chapter.deleted_at IS NOT NULL
         AND chapter.deleted_via_volume_id IS NULL AND volume.deleted_at IS NULL
       ORDER BY chapter.deleted_at DESC, chapter.id DESC${pageSql}`,
      workId,
      ...pageParams
    );
  }

  private mapDeletedChapter(row: Row): Record<string, unknown> {
    const deletedAt = requiredString(row, "deleted_at");
    return {
      id: requiredString(row, "id"),
      workId: requiredString(row, "work_id"),
      volumeId: requiredString(row, "volume_id"),
      volumeTitle: requiredString(row, "volume_title"),
      title: requiredString(row, "title"),
      contentPreview: requiredString(row, "content").slice(0, 300),
      wordCount: numberValue(row, "word_count"),
      versionNo: numberValue(row, "version_no"),
      deletedAt,
      expiresAt: recycleBinExpiresAt(deletedAt),
      actor: optionalString(row, "actor_display_name") ?? optionalString(row, "actor_username") ?? "历史数据"
    };
  }

  getRecycleBin(workId: string): Record<string, unknown> {
    return {
      retentionDays: RECYCLE_BIN_RETENTION_DAYS,
      volumes: this.listDeletedVolumes(workId),
      chapters: this.listDeletedChapters(workId)
    };
  }

  private findChapterVersionRows(chapterId: string): Row[] {
    return this.db.all(
      `SELECT version.*, user.display_name AS actor_display_name, user.username AS actor_username
        FROM chapter_versions version LEFT JOIN users user ON user.id = version.created_by_user_id
        WHERE version.chapter_id = ? ORDER BY version.version_no DESC`,
      chapterId
    );
  }

  private mapChapterVersionRow(row: Row): Record<string, unknown> {
    return {
      id: requiredString(row, "id"),
      workId: optionalString(row, "work_id"),
      chapterId: requiredString(row, "chapter_id"),
      versionNo: numberValue(row, "version_no"),
      title: requiredString(row, "title"),
      content: requiredString(row, "content"),
      volumeId: optionalString(row, "volume_id"),
      sortOrder: row.sort_order === null || row.sort_order === undefined ? null : numberValue(row, "sort_order"),
      chapterType: optionalString(row, "chapter_type"),
      source: requiredString(row, "source"),
      sourceRef: optionalString(row, "source_ref"),
      changeNote: requiredString(row, "change_note"),
      createdAt: requiredString(row, "created_at"),
      actor: optionalString(row, "actor_display_name") ?? optionalString(row, "actor_username") ?? "历史数据"
    };
  }

  private insertChapterVersionRow(input: {
    workId: string;
    chapterId: string;
    versionNo: number;
    title: string;
    content: string;
    volumeId: string | null;
    sortOrder: number | null;
    chapterType: string | null;
    source: string;
    sourceRef: string | null;
    changeNote: string;
    timestamp?: string;
  }): void {
    const timestamp = input.timestamp ?? now();
    this.db.run(
      `INSERT INTO chapter_versions (
         id, work_id, chapter_id, version_no, title, content, volume_id, sort_order, chapter_type,
         source, source_ref, change_note, created_at, created_by_user_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id("chapterVersion"),
      input.workId,
      input.chapterId,
      input.versionNo,
      input.title,
      input.content,
      input.volumeId,
      input.sortOrder,
      input.chapterType,
      input.source,
      input.sourceRef,
      input.changeNote.trim(),
      timestamp,
      currentRequestActor()?.userId ?? null
    );
    this.recordSyncChange(
      input.workId,
      "chapter",
      input.chapterId,
      input.source === "delete" ? "delete" : "upsert",
      input.versionNo,
      timestamp
    );
  }

  listChapterVersions(chapterId: string): Record<string, unknown>[] {
    const rows = this.findChapterVersionRows(chapterId);
    if (!rows.length) {
      this.getChapter(chapterId);
      return [];
    }
    return rows.map((row) => this.mapChapterVersionRow(row));
  }

  listChapterVersionsPage(chapterId: string, pagination: Pagination): PaginatedResult<Record<string, unknown>> {
    const page = paginationSql(pagination);
    const rows = this.db.all(
      `SELECT version.*, user.display_name AS actor_display_name, user.username AS actor_username
        FROM chapter_versions version LEFT JOIN users user ON user.id = version.created_by_user_id
        WHERE version.chapter_id = ? ORDER BY version.version_no DESC${page.sql}`,
      chapterId,
      ...page.params
    );
    if (!rows.length) {
      this.getChapter(chapterId);
      return paginated([], pagination);
    }
    return paginated(rows.map((row) => this.mapChapterVersionRow(row)), pagination);
  }

  listChapterInsights(chapterId: string): Record<string, unknown>[] {
    this.getChapter(chapterId);
    return this.db
      .all("SELECT * FROM chapter_insights WHERE chapter_id = ? ORDER BY chapter_version DESC, created_at DESC", chapterId)
      .map((row) => ({
        id: requiredString(row, "id"),
        chapterId: requiredString(row, "chapter_id"),
        chapterVersion: numberValue(row, "chapter_version"),
        summary: requiredString(row, "summary"),
        events: json(requiredString(row, "events_json"), []),
        characters: json(requiredString(row, "characters_json"), []),
        settings: json(requiredString(row, "settings_json"), []),
        evidence: json(requiredString(row, "evidence_json"), []),
        uncertainties: json(requiredString(row, "uncertainties_json"), []),
        status: requiredString(row, "status"),
        createdAt: requiredString(row, "created_at")
      }));
  }

  listChapterInsightsPage(chapterId: string, pagination: Pagination): PaginatedResult<Record<string, unknown>> {
    this.getChapter(chapterId);
    const page = paginationSql(pagination);
    const rows = this.db.all(
      `SELECT * FROM chapter_insights WHERE chapter_id = ? ORDER BY chapter_version DESC, created_at DESC${page.sql}`,
      chapterId,
      ...page.params
    );
    return paginated(rows.map((row) => ({
      id: requiredString(row, "id"),
      chapterId: requiredString(row, "chapter_id"),
      chapterVersion: numberValue(row, "chapter_version"),
      summary: requiredString(row, "summary"),
      events: json(requiredString(row, "events_json"), []),
      characters: json(requiredString(row, "characters_json"), []),
      settings: json(requiredString(row, "settings_json"), []),
      evidence: json(requiredString(row, "evidence_json"), []),
      uncertainties: json(requiredString(row, "uncertainties_json"), []),
      status: requiredString(row, "status"),
      createdAt: requiredString(row, "created_at")
    })), pagination);
  }

  listCurrentChapterInsights(workId: string): Record<string, unknown>[] {
    this.getWork(workId);
    return this.db.all(
      `SELECT insight.id, insight.chapter_id, insight.summary, chapter.title AS chapter_title,
              volume.title AS volume_title, volume.sort_order AS volume_sort_order, chapter.sort_order AS chapter_sort_order
       FROM chapters chapter
       JOIN volumes volume ON volume.id = chapter.volume_id
       JOIN chapter_insights insight ON insight.chapter_id = chapter.id AND insight.chapter_version = chapter.version_no
       WHERE chapter.work_id = ? AND chapter.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM chapter_insights newer
           WHERE newer.chapter_id = insight.chapter_id
             AND newer.chapter_version = insight.chapter_version
             AND (newer.created_at > insight.created_at OR (newer.created_at = insight.created_at AND newer.id > insight.id))
         )
       ORDER BY volume.sort_order, chapter.sort_order`,
      workId
    ).map((row) => ({
      id: requiredString(row, "id"),
      chapterId: requiredString(row, "chapter_id"),
      chapterTitle: requiredString(row, "chapter_title"),
      volumeTitle: requiredString(row, "volume_title"),
      summary: requiredString(row, "summary")
    }));
  }

  saveChapter(
    chapterId: string,
    input: { title?: string; content?: string; lineIds?: Array<string | null>; excludedFromAnalysis?: boolean; chapterType?: ChapterType },
    source = "manual",
    sourceRef: string | null = null,
    changeNote = "",
    expectedVersionNo?: number
  ): Record<string, unknown> {
    const current = this.getChapter(chapterId);
    this.assertExpectedRevision("chapter", chapterId, expectedVersionNo, "章节", Number(current.versionNo));
    const nextTitle = input.title ?? String(current.title);
    const nextContent = input.content === undefined ? String(current.content) : input.content;
    const nextExcluded = input.excludedFromAnalysis ?? Boolean(current.excludedFromAnalysis);
    const nextChapterType = input.chapterType ?? String(current.chapterType) as ChapterType;
    const hasContentChange = nextContent !== current.content;
    const hasTextChange = nextTitle !== current.title || nextContent !== current.content;
    const hasTypeChange = nextChapterType !== current.chapterType;
    const hasOtherChange = nextExcluded !== current.excludedFromAnalysis || hasTypeChange;
    if (!hasTextChange && !hasOtherChange) return current;
    const timestamp = now();
    const versionNo = Number(current.versionNo) + (hasTextChange || hasTypeChange ? 1 : 0);
    this.db.transaction(() => {
      const lockedCurrent = this.getChapter(chapterId);
      this.assertExpectedRevision("chapter", chapterId, expectedVersionNo, "章节", Number(lockedCurrent.versionNo));
      const storedLineIds = parseChapterLineIds(lockedCurrent.lineIds, String(lockedCurrent.content));
      const beforeLineIds = storedLineIds.length > 0
        ? storedLineIds
        : createChapterLineIds(String(lockedCurrent.content), () => id("chapterLine"));
      const nextLineIds = hasContentChange
        ? reconcileChapterLineIds(
            String(lockedCurrent.content),
            nextContent,
            beforeLineIds,
            input.lineIds,
            () => id("chapterLine")
          )
        : beforeLineIds;
      if (!nextLineIds) throw new AppError(400, "CHAPTER_LINE_IDS_INVALID", "正文行身份与当前版本不匹配，请刷新后重试");
      this.db.run(
        `UPDATE chapters SET title = ?, content = ?, chapter_type = ?, word_count = ?, version_no = ?, analysis_status = ?,
         excluded_from_analysis = ?, line_ids_json = ?, updated_at = ? WHERE id = ?`,
        nextTitle,
        nextContent,
        nextChapterType,
        countWords(nextContent),
        versionNo,
        hasTextChange || hasTypeChange ? "expired" : String(current.analysisStatus),
        nextExcluded ? 1 : 0,
        JSON.stringify(nextLineIds),
        timestamp,
        chapterId
      );
      if (hasTextChange) this.syncChapterParagraphSearch(String(current.workId), chapterId, nextContent);
      else if (hasTypeChange) this.syncChapterParagraphSearchVersion(chapterId, versionNo);
      if (hasContentChange) this.reanchorChapterAnnotations(
        String(current.workId),
        chapterId,
        String(lockedCurrent.content),
        nextContent,
        nextLineIds,
        source,
        timestamp
      );
      if (hasTextChange || hasTypeChange) {
        this.insertChapterVersionRow({
          workId: String(current.workId),
          chapterId,
          versionNo,
          title: nextTitle,
          content: nextContent,
          volumeId: String(current.volumeId),
          sortOrder: Number(current.sortOrder),
          chapterType: nextChapterType,
          source,
          sourceRef,
          changeNote: changeNote || (hasTextChange ? "更新章节正文" : "更新章节类型"),
          timestamp
        });
      }
      if (hasTextChange || hasTypeChange) this.invalidateChapter(String(current.workId), chapterId, versionNo);
      this.db.run("UPDATE works SET updated_at = ? WHERE id = ?", timestamp, String(current.workId));
      this.audit(String(current.workId), "chapter.saved", "chapter", chapterId, { versionNo, source, chapterType: nextChapterType, changeNote });
    });
    return this.getChapter(chapterId);
  }

  private reanchorChapterAnnotations(
    workId: string,
    chapterId: string,
    beforeContent: string,
    afterContent: string,
    afterLineIds: readonly string[],
    source: string,
    timestamp: string
  ): void {
    const annotations = this.db.all(
      `SELECT id, start_line, end_line, quote, line_hashes_json, anchor_line_ids_json
       FROM chapter_annotations
       WHERE chapter_id = ? AND deleted_at IS NULL`,
      chapterId
    ).map((row) => ({
      id: requiredString(row, "id"),
      startLine: numberValue(row, "start_line"),
      endLine: numberValue(row, "end_line"),
      quote: requiredString(row, "quote"),
      lineHashes: parseChapterAnnotationLineHashes(row.line_hashes_json, requiredString(row, "quote")),
      lineIds: parseChapterAnnotationLineIds(row.anchor_line_ids_json)
    }));
    for (const annotation of reanchorChapterAnnotations(beforeContent, afterContent, annotations, afterLineIds)) {
      if (!annotation.changed) continue;
      this.db.run(
        `UPDATE chapter_annotations
         SET start_line = ?, end_line = ?, quote = ?, line_hashes_json = ?, anchor_line_ids_json = ?, version_no = version_no + 1
         WHERE id = ?`,
        annotation.startLine,
        annotation.endLine,
        annotation.quote,
        JSON.stringify(annotation.lineHashes),
        JSON.stringify(annotation.lineIds),
        annotation.id
      );
      const updated = this.getChapterAnnotation(annotation.id);
      this.recordChapterAnnotationVersion(updated, "reanchor", timestamp);
      this.audit(workId, "chapter.annotation.updated", "chapter-annotation", annotation.id, {
        chapterId,
        startLine: annotation.startLine,
        endLine: annotation.endLine,
        versionNo: updated.versionNo,
        anchorStrategy: annotation.anchorStrategy,
        reason: "reanchor",
        source
      });
    }
  }

  replaceWorkText(
    workId: string,
    input: { find: string; replacement: string; scope: "prose" | "settings" | "prose-and-settings"; volumeId?: string | null }
  ): Record<string, unknown> {
    const find = input.find;
    if (!find) throw new AppError(400, "REPLACE_TEXT_REQUIRED", "查找内容不能为空");
    if (!["prose", "settings", "prose-and-settings"].includes(input.scope)) {
      throw new AppError(400, "REPLACE_SCOPE_INVALID", "替换范围无效");
    }
    const work = this.getWork(workId);
    const volumeId = input.volumeId ?? null;
    if (volumeId) {
      const volume = this.getVolume(volumeId);
      if (String(volume.workId) !== workId) {
        throw new AppError(400, "REPLACE_VOLUME_INVALID", "分卷不属于当前作品");
      }
      if (input.scope === "settings") {
        throw new AppError(400, "REPLACE_VOLUME_SCOPE_INVALID", "分卷范围只能用于正文替换");
      }
    }
    const permissions = work.modulePermissions as WorkModulePermissions;
    const requestedProse = input.scope === "prose" || input.scope === "prose-and-settings";
    const requestedSettings = input.scope === "settings" || input.scope === "prose-and-settings";
    const includeProse = requestedProse && canWriteWorkModule(permissions, "prose");
    const includeSettings = requestedSettings && canWriteWorkModule(permissions, "settings");
    const processedModules: Array<"prose" | "settings"> = [];
    const skippedModules: Array<"prose" | "settings"> = [];
    if (includeProse) processedModules.push("prose");
    if (includeSettings) processedModules.push("settings");
    if (requestedProse && !includeProse) skippedModules.push("prose");
    if (requestedSettings && !includeSettings) skippedModules.push("settings");

    const operationId = id("globalReplace");
    let chapterCount = 0;
    let settingCount = 0;
    let totalMatches = 0;

    const replaceLiteral = (value: string): { content: string; matches: number } => {
      let matches = 0;
      let offset = 0;
      while (true) {
        const index = value.indexOf(find, offset);
        if (index < 0) break;
        matches += 1;
        offset = index + find.length;
      }
      return {
        content: value.replaceAll(find, () => input.replacement),
        matches
      };
    };

    this.db.transaction(() => {
      if (includeProse) {
        const chapters = volumeId
          ? this.db.all(
            "SELECT id, content FROM chapters WHERE work_id = ? AND volume_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at",
            workId,
            volumeId
          )
          : this.db.all(
            "SELECT id, content FROM chapters WHERE work_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at",
            workId
          );
        for (const row of chapters) {
          const chapterId = requiredString(row, "id");
          const result = replaceLiteral(requiredString(row, "content"));
          if (!result.matches || result.content === requiredString(row, "content")) continue;
          this.saveChapter(chapterId, { content: result.content }, "global-replace", operationId, "全局替换正文");
          chapterCount += 1;
          totalMatches += result.matches;
        }
      }
      if (includeSettings) {
        const settings = this.db.all("SELECT id, content FROM settings WHERE work_id = ? ORDER BY id", workId);
        for (const row of settings) {
          const settingId = requiredString(row, "id");
          const currentContent = requiredString(row, "content");
          const result = replaceLiteral(currentContent);
          if (!result.matches || result.content === currentContent) continue;
          this.updateSetting(settingId, { content: result.content }, "global-replace", operationId, "全局替换设定库");
          settingCount += 1;
          totalMatches += result.matches;
        }
      }
      if (totalMatches > 0) {
        this.db.run("UPDATE works SET updated_at = ? WHERE id = ?", now(), workId);
        this.audit(workId, "work.global-replace", "work", workId, {
          operationId,
          scope: input.scope,
          volumeId,
          chapterCount,
          settingCount,
          totalMatches,
          processedModules,
          skippedModules
        });
      }
    });

    return {
      operationId,
      scope: input.scope,
      volumeId,
      chapterCount,
      settingCount,
      totalMatches,
      processedModules,
      skippedModules,
      work: this.getWorkDirectory(workId)
    };
  }

  restoreChapter(chapterId: string, versionNo: number, expectedVersionNo?: number): Record<string, unknown> {
    const version = this.db.get("SELECT * FROM chapter_versions WHERE chapter_id = ? AND version_no = ?", chapterId, versionNo);
    if (!version) throw notFound("章节版本");
    const existing = this.db.get("SELECT id, deleted_at FROM chapters WHERE id = ?", chapterId);
    if (existing?.deleted_at) {
      return this.restoreSoftDeletedChapterFromVersion(chapterId, version, expectedVersionNo);
    }
    if (!existing) {
      this.assertExpectedRevision("chapter", chapterId, expectedVersionNo, "章节", this.currentChapterVersionNo(chapterId));
      return this.recreateChapterFromVersion(chapterId, version);
    }
    return this.saveChapter(
      chapterId,
      { title: requiredString(version, "title"), content: requiredString(version, "content") },
      "restore",
      requiredString(version, "id"),
      `恢复至 v${versionNo}`,
      expectedVersionNo
    );
  }

  private recreateChapterFromVersion(chapterId: string, version: Row): Record<string, unknown> {
    const workId = requiredString(version, "work_id");
    const volumeId = optionalString(version, "volume_id");
    if (!volumeId) throw new AppError(400, "CHAPTER_RESTORE_INCOMPLETE", "历史版本缺少分卷信息，无法恢复已删除章节");
    const volume = this.getVolume(volumeId);
    if (volume.workId !== workId) throw new AppError(400, "VOLUME_WORK_MISMATCH", "卷不属于当前作品");
    const title = requiredString(version, "title");
    const content = requiredString(version, "content");
    const chapterType = (optionalString(version, "chapter_type") ?? "正文") as ChapterType;
    const sortOrder = version.sort_order === null || version.sort_order === undefined
      ? numberValue(this.db.get("SELECT COALESCE(MAX(sort_order), -1) AS sort_order FROM chapters WHERE volume_id = ? AND deleted_at IS NULL", volumeId) ?? {}, "sort_order") + 1
      : numberValue(version, "sort_order");
    const timestamp = now();
    const lineIds = createChapterLineIds(content, () => id("chapterLine"));
    const nextVersionNo = numberValue(
      this.db.get("SELECT COALESCE(MAX(version_no), 0) AS version_no FROM chapter_versions WHERE chapter_id = ?", chapterId) ?? {},
      "version_no"
    ) + 1;
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO chapters (id, work_id, volume_id, title, content, line_ids_json, chapter_type, sort_order, word_count, version_no, analysis_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        chapterId,
        workId,
        volumeId,
        title,
        content,
        JSON.stringify(lineIds),
        chapterType,
        sortOrder,
        countWords(content),
        nextVersionNo,
        timestamp,
        timestamp
      );
      this.syncChapterParagraphSearch(workId, chapterId, content);
      this.insertChapterVersionRow({
        workId,
        chapterId,
        versionNo: nextVersionNo,
        title,
        content,
        volumeId,
        sortOrder,
        chapterType,
        source: "restore",
        sourceRef: requiredString(version, "id"),
        changeNote: `恢复至 v${numberValue(version, "version_no")}`,
        timestamp
      });
      this.db.run("UPDATE works SET updated_at = ? WHERE id = ?", timestamp, workId);
      this.audit(workId, "chapter.restored", "chapter", chapterId, { versionNo: nextVersionNo, fromVersion: numberValue(version, "version_no") });
    });
    return this.getChapter(chapterId);
  }

  private restoreSoftDeletedChapterFromVersion(
    chapterId: string,
    version: Row,
    expectedVersionNo?: number
  ): Record<string, unknown> {
    const deleted = this.db.get("SELECT * FROM chapters WHERE id = ? AND deleted_at IS NOT NULL", chapterId);
    if (!deleted) throw notFound("章节");
    if (optionalString(deleted, "deleted_via_volume_id")) {
      throw new AppError(409, "CHAPTER_DELETED_WITH_VOLUME", "章节随分卷进入回收站，请先恢复分卷");
    }
    const currentVersionNo = numberValue(deleted, "version_no");
    this.assertExpectedRevision("chapter", chapterId, expectedVersionNo, "章节", currentVersionNo);
    const workId = requiredString(deleted, "work_id");
    const volumeId = optionalString(version, "volume_id");
    if (!volumeId) throw new AppError(400, "CHAPTER_RESTORE_INCOMPLETE", "历史版本缺少分卷信息，无法恢复已删除章节");
    const volume = this.getVolume(volumeId);
    if (volume.workId !== workId) throw new AppError(400, "VOLUME_WORK_MISMATCH", "卷不属于当前作品");
    const title = requiredString(version, "title");
    const content = requiredString(version, "content");
    const chapterType = (optionalString(version, "chapter_type") ?? "正文") as ChapterType;
    const sortOrder = version.sort_order === null || version.sort_order === undefined
      ? numberValue(this.db.get("SELECT COALESCE(MAX(sort_order), -1) AS sort_order FROM chapters WHERE volume_id = ? AND deleted_at IS NULL", volumeId) ?? {}, "sort_order") + 1
      : numberValue(version, "sort_order");
    const nextVersionNo = Math.max(
      currentVersionNo,
      numberValue(this.db.get("SELECT COALESCE(MAX(version_no), 0) AS version_no FROM chapter_versions WHERE chapter_id = ?", chapterId) ?? {}, "version_no")
    ) + 1;
    const timestamp = now();
    this.db.transaction(() => {
      const locked = this.db.get("SELECT version_no, deleted_at, deleted_via_volume_id FROM chapters WHERE id = ?", chapterId);
      if (!locked?.deleted_at) throw new AppError(409, "CHAPTER_ALREADY_RESTORED", "章节已经恢复");
      if (optionalString(locked, "deleted_via_volume_id")) {
        throw new AppError(409, "CHAPTER_DELETED_WITH_VOLUME", "章节随分卷进入回收站，请先恢复分卷");
      }
      this.assertExpectedRevision("chapter", chapterId, expectedVersionNo, "章节", numberValue(locked, "version_no"));
      this.db.run(
        `UPDATE chapters SET volume_id = ?, title = ?, content = ?, chapter_type = ?, sort_order = ?, word_count = ?,
          version_no = ?, analysis_status = 'pending', deleted_at = NULL, deleted_via_volume_id = NULL, updated_at = ? WHERE id = ?`,
        volumeId,
        title,
        content,
        chapterType,
        sortOrder,
        countWords(content),
        nextVersionNo,
        timestamp,
        chapterId
      );
      this.syncChapterParagraphSearch(workId, chapterId, content);
      this.insertChapterVersionRow({
        workId,
        chapterId,
        versionNo: nextVersionNo,
        title,
        content,
        volumeId,
        sortOrder,
        chapterType,
        source: "restore",
        sourceRef: requiredString(version, "id"),
        changeNote: `恢复至 v${numberValue(version, "version_no")}`,
        timestamp
      });
      this.db.run("UPDATE works SET updated_at = ? WHERE id = ?", timestamp, workId);
      this.invalidateChapter(workId, chapterId, nextVersionNo);
      this.audit(workId, "chapter.restored", "chapter", chapterId, {
        versionNo: nextVersionNo,
        fromVersion: numberValue(version, "version_no")
      });
    });
    return this.getChapter(chapterId);
  }

  moveChapter(chapterId: string, input: { volumeId: string; sortOrder: number }, expectedVersionNo?: number): Record<string, unknown> {
    const chapter = this.getChapter(chapterId);
    this.assertExpectedRevision("chapter", chapterId, expectedVersionNo, "章节", Number(chapter.versionNo));
    const volume = this.getVolume(input.volumeId);
    if (volume.workId !== chapter.workId) throw new AppError(400, "VOLUME_WORK_MISMATCH", "卷不属于当前作品");
    this.db.transaction(() => {
      const lockedChapter = this.getChapter(chapterId);
      this.assertExpectedRevision("chapter", chapterId, expectedVersionNo, "章节", Number(lockedChapter.versionNo));
      const sourceVolumeId = String(lockedChapter.volumeId);
      const targetVolumeId = input.volumeId;
      const sourceChapterIds = this.db.all(
        "SELECT id FROM chapters WHERE volume_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at, id",
        sourceVolumeId
      ).map((row) => requiredString(row, "id")).filter((idValue) => idValue !== chapterId);
      const targetChapterIds = sourceVolumeId === targetVolumeId
        ? sourceChapterIds
        : this.db.all(
          "SELECT id FROM chapters WHERE volume_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at, id",
          targetVolumeId
        ).map((row) => requiredString(row, "id")).filter((idValue) => idValue !== chapterId);
      const targetIndex = Math.min(input.sortOrder, targetChapterIds.length);
      targetChapterIds.splice(targetIndex, 0, chapterId);
      const timestamp = now();
      sourceChapterIds.forEach((idValue, sortOrder) => {
        this.db.run("UPDATE chapters SET sort_order = ?, updated_at = ? WHERE id = ?", sortOrder, timestamp, idValue);
      });
      targetChapterIds.forEach((idValue, sortOrder) => {
        this.db.run("UPDATE chapters SET volume_id = ?, sort_order = ?, updated_at = ? WHERE id = ?", targetVolumeId, sortOrder, timestamp, idValue);
      });
      const versionNo = Number(lockedChapter.versionNo) + 1;
      this.db.run(
        `UPDATE analysis_tasks SET status = 'expired', updated_at = ?
         WHERE work_id = ? AND status IN ('pending', 'running', 'completed', 'partial', 'review')
         AND json_extract(scope_json, '$.type') = 'volume'
         AND json_extract(scope_json, '$.volumeId') IN (?, ?)`,
        timestamp,
        String(lockedChapter.workId),
        sourceVolumeId,
        targetVolumeId
      );
      this.db.run(
        "UPDATE chapters SET version_no = ?, analysis_status = 'expired', updated_at = ? WHERE id = ?",
        versionNo,
        timestamp,
        chapterId
      );
      this.syncChapterParagraphSearchVersion(chapterId, versionNo);
      this.insertChapterVersionRow({
        workId: String(lockedChapter.workId),
        chapterId,
        versionNo,
        title: String(lockedChapter.title),
        content: String(lockedChapter.content),
        volumeId: targetVolumeId,
        sortOrder: targetIndex,
        chapterType: String(lockedChapter.chapterType),
        source: "manual",
        sourceRef: null,
        changeNote: sourceVolumeId === targetVolumeId ? "调整章节顺序" : "移动章节分卷",
        timestamp
      });
      this.db.run("UPDATE works SET updated_at = ? WHERE id = ?", timestamp, String(lockedChapter.workId));
      this.invalidateChapter(String(lockedChapter.workId), chapterId, versionNo);
      this.audit(String(lockedChapter.workId), "chapter.moved", "chapter", chapterId, {
        volumeId: targetVolumeId,
        sortOrder: targetIndex,
        fromVolumeId: sourceVolumeId,
        versionNo
      });
    });
    return this.getChapter(chapterId);
  }

  private mapChapterAnnotation(row: Row): Record<string, unknown> {
    return {
      id: requiredString(row, "id"),
      workId: requiredString(row, "work_id"),
      chapterId: requiredString(row, "chapter_id"),
      kind: requiredString(row, "kind"),
      startLine: numberValue(row, "start_line"),
      endLine: numberValue(row, "end_line"),
      quote: requiredString(row, "quote"),
      note: requiredString(row, "note"),
      status: requiredString(row, "status"),
      versionNo: numberValue(row, "version_no"),
      createdByUserId: optionalString(row, "created_by_user_id"),
      actor: optionalString(row, "actor_display_name") ?? optionalString(row, "actor_username") ?? "历史数据",
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at")
    };
  }

  private chapterAnnotationSnapshot(annotation: Record<string, unknown>): Record<string, unknown> {
    const anchor = this.db.get("SELECT anchor_line_ids_json FROM chapter_annotations WHERE id = ?", String(annotation.id));
    return {
      kind: annotation.kind,
      startLine: annotation.startLine,
      endLine: annotation.endLine,
      quote: annotation.quote,
      lineHashes: chapterAnnotationLineHashes(String(annotation.quote)),
      lineIds: parseChapterAnnotationLineIds(anchor?.anchor_line_ids_json),
      note: annotation.note,
      status: annotation.status,
      deletedAt: annotation.deletedAt ?? null
    };
  }

  private recordChapterAnnotationVersion(annotation: Record<string, unknown>, source: string, timestamp: string): void {
    this.db.run(
      `INSERT INTO chapter_annotation_versions (id, annotation_id, version_no, snapshot_json, source, created_at, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id("chapterAnnotationVersion"),
      String(annotation.id),
      Number(annotation.versionNo),
      JSON.stringify(this.chapterAnnotationSnapshot(annotation)),
      source,
      timestamp,
      currentRequestActor()?.userId ?? null
    );
  }

  getChapterAnnotation(annotationId: string, includeDeleted = false): Record<string, unknown> {
    const row = this.db.get(
      `SELECT annotation.*, user.display_name AS actor_display_name, user.username AS actor_username
       FROM chapter_annotations annotation LEFT JOIN users user ON user.id = annotation.updated_by_user_id
       WHERE annotation.id = ?${includeDeleted ? "" : " AND annotation.deleted_at IS NULL"}`,
      annotationId
    );
    if (!row) throw notFound("章节批注");
    return { ...this.mapChapterAnnotation(row), deletedAt: optionalString(row, "deleted_at") };
  }

  listChapterAnnotations(chapterId: string, kinds?: readonly ChapterAnnotationKind[], line?: number): Record<string, unknown>[] {
    this.getChapter(chapterId);
    const kindFilter = kinds === undefined
      ? { sql: "", params: [] as string[] }
      : kinds.length > 0
        ? { sql: ` AND annotation.kind IN (${kinds.map(() => "?").join(",")})`, params: [...kinds] }
        : { sql: " AND 1 = 0", params: [] as string[] };
    const lineFilter = line === undefined
      ? { sql: "", params: [] as number[] }
      : { sql: " AND annotation.start_line <= ? AND annotation.end_line >= ?", params: [line, line] };
    return this.db.all(
      `SELECT annotation.*, user.display_name AS actor_display_name, user.username AS actor_username
       FROM chapter_annotations annotation LEFT JOIN users user ON user.id = annotation.updated_by_user_id
       WHERE annotation.chapter_id = ? AND annotation.deleted_at IS NULL${kindFilter.sql}${lineFilter.sql}
       ORDER BY CASE annotation.status WHEN 'open' THEN 0 ELSE 1 END, annotation.start_line, annotation.created_at`,
      chapterId,
      ...kindFilter.params,
      ...lineFilter.params
    ).map((row) => this.mapChapterAnnotation(row));
  }

  listChapterAnnotationCounts(chapterId: string, kinds?: readonly ChapterAnnotationKind[]): Array<{ line: number; count: number }> {
    this.getChapter(chapterId);
    const kindFilter = kinds === undefined
      ? { sql: "", params: [] as string[] }
      : kinds.length > 0
        ? { sql: ` AND annotation.kind IN (${kinds.map(() => "?").join(",")})`, params: [...kinds] }
        : { sql: " AND 1 = 0", params: [] as string[] };
    return this.db.all<{ line: number; count: number }>(
      `WITH RECURSIVE annotation_lines(line, end_line) AS (
         SELECT annotation.start_line, annotation.end_line
         FROM chapter_annotations annotation
         WHERE annotation.chapter_id = ? AND annotation.deleted_at IS NULL${kindFilter.sql}
         UNION ALL
         SELECT line + 1, end_line
         FROM annotation_lines
         WHERE line < end_line
       )
       SELECT line, COUNT(*) AS count
       FROM annotation_lines
       GROUP BY line
       ORDER BY line`,
      chapterId,
      ...kindFilter.params
    ).map((row) => ({ line: Number(row.line), count: Number(row.count) }));
  }

  listWorkChapterAnnotations(workId: string, kinds?: readonly ChapterAnnotationKind[]): Record<string, unknown>[] {
    this.getWork(workId);
    const kindFilter = kinds === undefined
      ? { sql: "", params: [] as string[] }
      : kinds.length > 0
        ? { sql: ` AND annotation.kind IN (${kinds.map(() => "?").join(",")})`, params: [...kinds] }
        : { sql: " AND 1 = 0", params: [] as string[] };
    return this.db.all(
      `SELECT annotation.*, user.display_name AS actor_display_name, user.username AS actor_username,
        chapter.title AS chapter_title, volume.title AS volume_title
       FROM chapter_annotations annotation
       JOIN chapters chapter ON chapter.id = annotation.chapter_id
       JOIN volumes volume ON volume.id = chapter.volume_id
       LEFT JOIN users user ON user.id = annotation.updated_by_user_id
       WHERE annotation.work_id = ? AND annotation.deleted_at IS NULL AND chapter.deleted_at IS NULL${kindFilter.sql}
       ORDER BY CASE annotation.status WHEN 'open' THEN 0 ELSE 1 END,
         volume.sort_order, volume.created_at, chapter.sort_order, chapter.created_at,
         annotation.start_line, annotation.created_at`,
      workId,
      ...kindFilter.params
    ).map((row) => ({
      ...this.mapChapterAnnotation(row),
      volumeTitle: requiredString(row, "volume_title"),
      chapterTitle: requiredString(row, "chapter_title")
    }));
  }

  listWorkChapterAnnotationsPage(workId: string, pagination: Pagination, kinds?: readonly ChapterAnnotationKind[]): PaginatedResult<Record<string, unknown>> {
    this.getWork(workId);
    const page = paginationSql(pagination);
    const kindFilter = kinds === undefined
      ? { sql: "", params: [] as string[] }
      : kinds.length > 0
        ? { sql: ` AND annotation.kind IN (${kinds.map(() => "?").join(",")})`, params: [...kinds] }
        : { sql: " AND 1 = 0", params: [] as string[] };
    const rows = this.db.all(
      `SELECT annotation.*, user.display_name AS actor_display_name, user.username AS actor_username,
        chapter.title AS chapter_title, volume.title AS volume_title
       FROM chapter_annotations annotation
       JOIN chapters chapter ON chapter.id = annotation.chapter_id
       JOIN volumes volume ON volume.id = chapter.volume_id
       LEFT JOIN users user ON user.id = annotation.updated_by_user_id
       WHERE annotation.work_id = ? AND annotation.deleted_at IS NULL AND chapter.deleted_at IS NULL${kindFilter.sql}
       ORDER BY CASE annotation.status WHEN 'open' THEN 0 ELSE 1 END,
         volume.sort_order, volume.created_at, chapter.sort_order, chapter.created_at,
         annotation.start_line, annotation.created_at${page.sql}`,
      workId,
      ...kindFilter.params,
      ...page.params
    );
    const total = numberValue(this.db.get(
      `SELECT COUNT(*) AS count
       FROM chapter_annotations annotation
       JOIN chapters chapter ON chapter.id = annotation.chapter_id
       WHERE annotation.work_id = ? AND annotation.deleted_at IS NULL AND chapter.deleted_at IS NULL${kindFilter.sql}`,
      workId,
      ...kindFilter.params
    ) ?? {}, "count");
    return paginated(rows.map((row) => ({
      ...this.mapChapterAnnotation(row),
      volumeTitle: requiredString(row, "volume_title"),
      chapterTitle: requiredString(row, "chapter_title")
    })), pagination, total);
  }

  createChapterAnnotation(chapterId: string, input: { kind: "note" | "todo"; startLine: number; endLine: number; note: string }): Record<string, unknown> {
    const chapter = this.getChapter(chapterId);
    const lines = String(chapter.content).replace(/\r\n?/gu, "\n").split("\n");
    if (input.startLine > lines.length || input.endLine > lines.length) throw new AppError(400, "ANNOTATION_LINE_RANGE_INVALID", "批注行号超出当前正文范围");
    if (input.endLine - input.startLine >= 20) throw new AppError(400, "ANNOTATION_LINE_RANGE_TOO_LARGE", "一次最多批注 20 行正文");
    const annotationId = id("chapterAnnotation");
    const timestamp = now();
    const actorId = currentRequestActor()?.userId ?? null;
    const quote = lines.slice(input.startLine - 1, input.endLine).join("\n");
    const chapterLineIds = parseChapterLineIds(chapter.lineIds, String(chapter.content));
    if (lines.length <= MAX_CHAPTER_LINE_IDS && chapterLineIds.length !== lines.length) {
      throw new AppError(409, "CHAPTER_LINE_IDS_MISSING", "正文行身份尚未初始化，请重新保存正文后再添加评论");
    }
    const anchorLineIds = chapterLineIds.slice(input.startLine - 1, input.endLine);
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO chapter_annotations (id, work_id, chapter_id, kind, start_line, end_line, quote, line_hashes_json, anchor_line_ids_json, note, status, version_no, created_at, updated_at, created_by_user_id, updated_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 1, ?, ?, ?, ?)`,
        annotationId,
        String(chapter.workId),
        chapterId,
        input.kind,
        input.startLine,
        input.endLine,
        quote,
        JSON.stringify(chapterAnnotationLineHashes(quote)),
        JSON.stringify(anchorLineIds),
        input.note.trim(),
        timestamp,
        timestamp,
        actorId,
        actorId
      );
      const annotation = this.getChapterAnnotation(annotationId);
      this.recordChapterAnnotationVersion(annotation, "create", timestamp);
      this.audit(String(chapter.workId), "chapter.annotation.created", "chapter-annotation", annotationId, { kind: input.kind, chapterId, startLine: input.startLine, endLine: input.endLine });
    });
    return this.getChapterAnnotation(annotationId);
  }

  updateChapterAnnotation(annotationId: string, input: { note?: string; status?: "open" | "resolved" }, expectedVersionNo?: number): Record<string, unknown> {
    const current = this.getChapterAnnotation(annotationId);
    this.assertExpectedRevision("chapter-annotation", annotationId, expectedVersionNo, "章节批注", Number(current.versionNo));
    const timestamp = now();
    this.db.transaction(() => {
      const locked = this.getChapterAnnotation(annotationId);
      this.assertExpectedRevision("chapter-annotation", annotationId, expectedVersionNo, "章节批注", Number(locked.versionNo));
      this.db.run(
        "UPDATE chapter_annotations SET note = ?, status = ?, version_no = version_no + 1, updated_at = ?, updated_by_user_id = ? WHERE id = ?",
        input.note?.trim() ?? String(locked.note),
        input.status ?? String(locked.status),
        timestamp,
        currentRequestActor()?.userId ?? null,
        annotationId
      );
      const updated = this.getChapterAnnotation(annotationId);
      this.recordChapterAnnotationVersion(updated, "update", timestamp);
      this.audit(String(updated.workId), "chapter.annotation.updated", "chapter-annotation", annotationId, { status: updated.status, versionNo: updated.versionNo });
    });
    return this.getChapterAnnotation(annotationId);
  }

  deleteChapterAnnotation(annotationId: string, expectedVersionNo?: number): void {
    const current = this.getChapterAnnotation(annotationId);
    this.assertExpectedRevision("chapter-annotation", annotationId, expectedVersionNo, "章节批注", Number(current.versionNo));
    const timestamp = now();
    this.db.transaction(() => {
      this.db.run("UPDATE chapter_annotations SET version_no = version_no + 1, deleted_at = ?, updated_at = ?, updated_by_user_id = ? WHERE id = ?", timestamp, timestamp, currentRequestActor()?.userId ?? null, annotationId);
      const deleted = this.getChapterAnnotation(annotationId, true);
      this.recordChapterAnnotationVersion(deleted, "delete", timestamp);
      this.audit(String(deleted.workId), "chapter.annotation.deleted", "chapter-annotation", annotationId, { versionNo: deleted.versionNo, recoverable: true });
    });
  }

  batchManageChapters(
    workId: string,
    chapters: { id: string; expectedVersionNo: number }[],
    action:
      | { type: "move"; volumeId: string }
      | { type: "setType"; chapterType: ChapterType }
      | { type: "setAnalysisExclusion"; excludedFromAnalysis: boolean }
      | { type: "delete" }
  ): Record<string, unknown> {
    this.getWork(workId);
    const uniqueIds = new Set(chapters.map((chapter) => chapter.id));
    if (uniqueIds.size !== chapters.length) throw new AppError(400, "DUPLICATE_CHAPTER", "批量操作中不能重复选择同一章节");
    return this.db.transaction(() => {
      const currentChapters = chapters.map((input) => {
        const chapter = this.getChapter(input.id);
        if (chapter.workId !== workId) throw new AppError(400, "CHAPTER_WORK_MISMATCH", "章节不属于当前作品");
        this.assertExpectedRevision("chapter", input.id, input.expectedVersionNo, "章节", Number(chapter.versionNo));
        return chapter;
      });
      const timestamp = now();
      if (action.type === "move") {
        const targetVolume = this.getVolume(action.volumeId);
        if (targetVolume.workId !== workId) throw new AppError(400, "VOLUME_WORK_MISMATCH", "卷不属于当前作品");
        const selectedIds = new Set(currentChapters.map((chapter) => String(chapter.id)));
        const affectedVolumeIds = new Set(currentChapters.map((chapter) => String(chapter.volumeId)));
        affectedVolumeIds.add(action.volumeId);
        const orderedByVolume = new Map<string, string[]>();
        for (const volumeId of affectedVolumeIds) {
          orderedByVolume.set(volumeId, this.db.all(
            "SELECT id FROM chapters WHERE volume_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at, id",
            volumeId
          ).map((row) => requiredString(row, "id")).filter((chapterId) => !selectedIds.has(chapterId)));
        }
        orderedByVolume.get(action.volumeId)?.push(...currentChapters.map((chapter) => String(chapter.id)));
        for (const [volumeId, chapterIds] of orderedByVolume) {
          chapterIds.forEach((chapterId, sortOrder) => {
            this.db.run("UPDATE chapters SET volume_id = ?, sort_order = ?, updated_at = ? WHERE id = ?", volumeId, sortOrder, timestamp, chapterId);
          });
        }
        for (const chapter of currentChapters) {
          const chapterId = String(chapter.id);
          const versionNo = Number(chapter.versionNo) + 1;
          const sortOrder = orderedByVolume.get(action.volumeId)?.indexOf(chapterId) ?? 0;
          this.db.run("UPDATE chapters SET version_no = ?, analysis_status = 'expired', updated_at = ? WHERE id = ?", versionNo, timestamp, chapterId);
          this.syncChapterParagraphSearchVersion(chapterId, versionNo);
          this.insertChapterVersionRow({
            workId,
            chapterId,
            versionNo,
            title: String(chapter.title),
            content: String(chapter.content),
            volumeId: action.volumeId,
            sortOrder,
            chapterType: String(chapter.chapterType),
            source: "manual",
            sourceRef: null,
            changeNote: "批量移动章节",
            timestamp
          });
          this.invalidateChapter(workId, chapterId, versionNo);
          this.audit(workId, "chapter.moved", "chapter", chapterId, { volumeId: action.volumeId, sortOrder, versionNo, batch: true });
        }
      } else if (action.type === "setType") {
        for (const chapter of currentChapters) {
          if (chapter.chapterType === action.chapterType) continue;
          const chapterId = String(chapter.id);
          const versionNo = Number(chapter.versionNo) + 1;
          this.db.run(
            "UPDATE chapters SET chapter_type = ?, version_no = ?, analysis_status = 'expired', updated_at = ? WHERE id = ?",
            action.chapterType,
            versionNo,
            timestamp,
            chapterId
          );
          this.syncChapterParagraphSearchVersion(chapterId, versionNo);
          this.insertChapterVersionRow({
            workId,
            chapterId,
            versionNo,
            title: String(chapter.title),
            content: String(chapter.content),
            volumeId: String(chapter.volumeId),
            sortOrder: Number(chapter.sortOrder),
            chapterType: action.chapterType,
            source: "manual",
            sourceRef: null,
            changeNote: "批量更新章节类型",
            timestamp
          });
          this.invalidateChapter(workId, chapterId, versionNo);
          this.audit(workId, "chapter.saved", "chapter", chapterId, { chapterType: action.chapterType, versionNo, batch: true });
        }
      } else if (action.type === "setAnalysisExclusion") {
        for (const chapter of currentChapters) {
          this.db.run("UPDATE chapters SET excluded_from_analysis = ?, updated_at = ? WHERE id = ?", action.excludedFromAnalysis ? 1 : 0, timestamp, String(chapter.id));
          this.audit(workId, "chapter.saved", "chapter", String(chapter.id), { excludedFromAnalysis: action.excludedFromAnalysis, batch: true });
        }
      } else {
        for (const chapter of currentChapters) {
          const chapterId = String(chapter.id);
          const versionNo = Number(chapter.versionNo) + 1;
          this.db.run("UPDATE chapters SET version_no = ?, deleted_at = ?, deleted_via_volume_id = NULL, updated_at = ? WHERE id = ?", versionNo, timestamp, timestamp, chapterId);
          this.insertChapterVersionRow({
            workId,
            chapterId,
            versionNo,
            title: String(chapter.title),
            content: String(chapter.content),
            volumeId: String(chapter.volumeId),
            sortOrder: Number(chapter.sortOrder),
            chapterType: String(chapter.chapterType),
            source: "delete",
            sourceRef: null,
            changeNote: "批量删除章节（可恢复）",
            timestamp
          });
          this.db.run("DELETE FROM chapter_paragraph_search WHERE chapter_id = ?", chapterId);
          this.db.run(
            `UPDATE analysis_tasks SET status = 'expired', updated_at = ?
             WHERE work_id = ? AND status IN ('pending', 'running', 'completed', 'partial', 'review')
             AND (json_extract(scope_json, '$.chapterId') = ?
               OR json_extract(scope_json, '$.type') = 'book'
               OR (json_extract(scope_json, '$.type') = 'volume'
                 AND json_extract(scope_json, '$.volumeId') = ?))`,
            timestamp,
            workId,
            chapterId,
            String(chapter.volumeId)
          );
          this.audit(workId, "chapter.deleted", "chapter", chapterId, { versionNo, batch: true, recoverable: true });
        }
      }
      this.db.run("UPDATE works SET updated_at = ? WHERE id = ?", timestamp, workId);
      return { processed: currentChapters.length, action: action.type };
    });
  }

  deleteChapter(chapterId: string, expectedVersionNo?: number): void {
    const chapter = this.getChapter(chapterId);
    this.assertExpectedRevision("chapter", chapterId, expectedVersionNo, "章节", Number(chapter.versionNo));
    const timestamp = now();
    const versionNo = Number(chapter.versionNo) + 1;
    this.db.transaction(() => {
      const lockedChapter = this.getChapter(chapterId);
      this.assertExpectedRevision("chapter", chapterId, expectedVersionNo, "章节", Number(lockedChapter.versionNo));
      this.db.run("UPDATE chapters SET version_no = ?, deleted_at = ?, deleted_via_volume_id = NULL, updated_at = ? WHERE id = ?", versionNo, timestamp, timestamp, chapterId);
      this.insertChapterVersionRow({
        workId: String(chapter.workId),
        chapterId,
        versionNo,
        title: String(chapter.title),
        content: String(chapter.content),
        volumeId: String(chapter.volumeId),
        sortOrder: Number(chapter.sortOrder),
        chapterType: String(chapter.chapterType),
        source: "delete",
        sourceRef: null,
        changeNote: "删除章节",
        timestamp
      });
      this.db.run("DELETE FROM chapter_paragraph_search WHERE chapter_id = ?", chapterId);
      this.db.run(
        `UPDATE analysis_tasks SET status = 'expired', updated_at = ?
         WHERE work_id = ? AND status IN ('pending', 'running', 'completed', 'partial', 'review')
         AND (json_extract(scope_json, '$.chapterId') = ?
           OR json_extract(scope_json, '$.type') = 'book'
           OR (json_extract(scope_json, '$.type') = 'volume'
             AND json_extract(scope_json, '$.volumeId') = ?))`,
        timestamp,
        String(chapter.workId),
        chapterId,
        String(chapter.volumeId)
      );
      this.db.run("UPDATE works SET updated_at = ? WHERE id = ?", timestamp, String(chapter.workId));
      this.audit(String(chapter.workId), "chapter.deleted", "chapter", chapterId, { versionNo });
    });
  }

  permanentlyDeleteChapter(chapterId: string, expectedVersionNo?: number, reason = "manual"): void {
    const chapter = this.db.get("SELECT * FROM chapters WHERE id = ?", chapterId);
    if (!chapter) throw notFound("章节");
    if (!chapter.deleted_at) throw new AppError(409, "CHAPTER_NOT_IN_RECYCLE_BIN", "仅回收站中的章节可以彻底删除");
    if (optionalString(chapter, "deleted_via_volume_id")) {
      throw new AppError(409, "CHAPTER_DELETED_WITH_VOLUME", "章节随分卷进入回收站，请在分卷条目上操作");
    }
    this.assertExpectedRevision("chapter", chapterId, expectedVersionNo, "章节", numberValue(chapter, "version_no"));
    this.db.transaction(() => {
      const locked = this.db.get("SELECT * FROM chapters WHERE id = ?", chapterId);
      if (!locked) throw notFound("章节");
      if (!locked.deleted_at) throw new AppError(409, "CHAPTER_NOT_IN_RECYCLE_BIN", "仅回收站中的章节可以彻底删除");
      if (optionalString(locked, "deleted_via_volume_id")) {
        throw new AppError(409, "CHAPTER_DELETED_WITH_VOLUME", "章节随分卷进入回收站，请在分卷条目上操作");
      }
      this.assertExpectedRevision("chapter", chapterId, expectedVersionNo, "章节", numberValue(locked, "version_no"));
      this.permanentlyRemoveChapterRow(locked, reason);
    });
  }

  private permanentlyRemoveChapterRow(chapter: Row, reason: string, recordAudit = true): void {
    const chapterId = requiredString(chapter, "id");
    const workId = requiredString(chapter, "work_id");
    this.db.run("DELETE FROM chapter_versions WHERE chapter_id = ?", chapterId);
    this.db.run("DELETE FROM entity_versions WHERE entity_type = 'chapter-outline' AND entity_id = ?", chapterId);
    this.db.run("DELETE FROM attachment_references WHERE entity_type = 'chapter' AND entity_id = ?", chapterId);
    this.db.run("DELETE FROM chapters WHERE id = ?", chapterId);
    if (!recordAudit) return;
    this.db.run("UPDATE works SET updated_at = ? WHERE id = ?", now(), workId);
    this.audit(workId, "chapter.purged", "chapter", chapterId, {
      title: requiredString(chapter, "title"),
      volumeId: requiredString(chapter, "volume_id"),
      versionNo: numberValue(chapter, "version_no"),
      reason,
      recoverable: false
    });
  }

  private insertChapter(
    workId: string,
    volumeId: string,
    title: string,
    content: string,
    sortOrder: number,
    source: string,
    sourceRef: string | null,
    chapterType: ChapterType = "正文"
  ): string {
    const chapterId = id("chapter");
    const timestamp = now();
    const lineIds = createChapterLineIds(content, () => id("chapterLine"));
    this.db.run(
      `INSERT INTO chapters (id, work_id, volume_id, title, content, line_ids_json, chapter_type, sort_order, word_count, version_no, analysis_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'pending', ?, ?)`,
      chapterId,
      workId,
      volumeId,
      title,
      content,
      JSON.stringify(lineIds),
      chapterType,
      sortOrder,
      countWords(content),
      timestamp,
      timestamp
    );
    this.syncChapterParagraphSearch(workId, chapterId, content);
    this.insertChapterVersionRow({
      workId,
      chapterId,
      versionNo: 1,
      title,
      content,
      volumeId,
      sortOrder,
      chapterType,
      source,
      sourceRef,
      changeNote: source === "import" ? "导入章节" : "建立章节",
      timestamp
    });
    return chapterId;
  }

  private syncChapterParagraphSearch(workId: string, chapterId: string, content: string): void {
    const chapterVersion = numberValue(
      this.db.get("SELECT version_no FROM chapters WHERE id = ? AND work_id = ?", chapterId, workId) ?? {},
      "version_no"
    );
    const ranges = documentParagraphLineRanges(content);
    this.db.run("DELETE FROM chapter_paragraph_search WHERE chapter_id = ?", chapterId);
    for (const [paragraphOrder, paragraph] of splitDocumentParagraphs(content).entries()) {
      const searchContent = normalizeDocumentSearchText(paragraph);
      const inserted = this.db.run(
        `INSERT INTO chapter_paragraph_search (work_id, chapter_id, paragraph_order, content, search_content)
         VALUES (?, ?, ?, ?, ?)`,
        workId,
        chapterId,
        paragraphOrder,
        paragraph,
        searchContent
      );
      const range = ranges[paragraphOrder];
      if (range) {
        this.db.run(
          `INSERT INTO chapter_paragraph_line_ranges (paragraph_id, chapter_version, start_line, end_line)
           VALUES (?, ?, ?, ?)`,
          inserted.lastInsertRowid,
          chapterVersion,
          range.startLine,
          range.endLine
        );
      }
      for (const term of documentShortSearchTerms(searchContent)) {
        this.db.run(
          "INSERT INTO chapter_paragraph_short_terms (paragraph_id, term) VALUES (?, ?)",
          inserted.lastInsertRowid,
          term
        );
      }
    }
  }

  private syncChapterParagraphSearchVersion(chapterId: string, versionNo: number): void {
    this.db.run(
      `UPDATE chapter_paragraph_line_ranges SET chapter_version = ?
       WHERE paragraph_id IN (SELECT id FROM chapter_paragraph_search WHERE chapter_id = ?)`,
      versionNo,
      chapterId
    );
  }

  private chapterParagraphSearchPlan(
    workId: string,
    normalizedKeyword: string,
    options: Pick<ChapterParagraphSearchOptions, "excludeAuthorNotes" | "chapterIds">
  ): { joinSql: string; whereSql: string; params: SQLInputValue[] } {
    const shortKeyword = [...normalizedKeyword].length < 3;
    const scopedChapterIds = options.chapterIds
      ? [...new Set(options.chapterIds.filter(Boolean))].slice(0, 10_000)
      : null;
    const scopeFilter = scopedChapterIds
      ? " AND chapter.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))"
      : "";
    const authorNoteFilter = options.excludeAuthorNotes ? " AND chapter.chapter_type <> '作者的话'" : "";
    return {
      joinSql: shortKeyword
        ? "JOIN chapter_paragraph_short_terms term ON term.paragraph_id = paragraph.id"
        : "JOIN chapter_paragraph_search_fts fts ON fts.rowid = paragraph.id",
      whereSql: `paragraph.work_id = ? AND chapter.deleted_at IS NULL AND volume.deleted_at IS NULL${authorNoteFilter}${scopeFilter}
        AND ${shortKeyword ? "term.term = ?" : "chapter_paragraph_search_fts MATCH ?"}`,
      params: [
        workId,
        ...(scopedChapterIds ? [JSON.stringify(scopedChapterIds)] : []),
        shortKeyword ? normalizedKeyword : `"${normalizedKeyword.replaceAll('"', '""')}"`
      ]
    };
  }

  private mapChapterParagraphMatches(
    workId: string,
    rows: Row[],
    options: { includeStoryOrder?: boolean; includeTimeline?: boolean; includeParagraphOrder?: boolean }
  ): ChapterParagraphMatch[] {
    const chapterIds = rows.map((row) => requiredString(row, "chapter_id"));
    const storyOrders = options.includeStoryOrder
      ? this.getChapterStoryOrders(workId, chapterIds, { includeTimeline: options.includeTimeline })
      : new Map<string, ChapterStoryOrderDetails>();
    return rows.map((row) => {
      const chapterId = requiredString(row, "chapter_id");
      const storyOrder = storyOrders.get(chapterId);
      return {
        chapterId,
        chapterTitle: requiredString(row, "chapter_title"),
        paragraph: requiredString(row, "content"),
        ...(options.includeParagraphOrder ? { paragraphOrder: numberValue(row, "paragraph_order") } : {}),
        ...(storyOrder ? { storyOrder } : {})
      };
    });
  }

  searchChapterParagraphs(
    workId: string,
    keyword: string,
    limit = 20,
    options: ChapterParagraphSearchOptions = {}
  ): ChapterParagraphMatch[] {
    const work = this.getWork(workId);
    if ((work.modulePermissions as WorkModulePermissions).prose === "none") return [];
    const normalizedKeyword = normalizeDocumentSearchText(keyword.trim());
    if (!normalizedKeyword) return [];
    if (options.chapterIds && options.chapterIds.length === 0) return [];
    const safeLimit = Math.min(100, Math.max(1, Math.trunc(limit)));
    const search = this.chapterParagraphSearchPlan(workId, normalizedKeyword, options);
    const columns = `SELECT paragraph.chapter_id, chapter.title AS chapter_title, paragraph.content, paragraph.paragraph_order
      FROM chapter_paragraph_search paragraph
      JOIN chapters chapter ON chapter.id = paragraph.chapter_id
      JOIN volumes volume ON volume.id = chapter.volume_id
      ${search.joinSql}`;
    const orderSql = options.order === "story_desc"
      ? "volume.story_order DESC, chapter.sort_order DESC, paragraph.paragraph_order DESC, volume.id, chapter.id, paragraph.id"
      : options.order === "story_asc"
        ? "volume.story_order, chapter.sort_order, paragraph.paragraph_order, volume.id, chapter.id, paragraph.id"
        : "volume.sort_order, chapter.sort_order, paragraph.paragraph_order, volume.id, chapter.id, paragraph.id";
    const rows = this.db.all(
      `${columns}
       WHERE ${search.whereSql}
       ORDER BY ${orderSql}
       LIMIT ?`,
      ...search.params,
      safeLimit
    );
    return this.mapChapterParagraphMatches(workId, rows, {
      includeStoryOrder: options.includeStoryOrder,
      includeTimeline: options.includeTimeline,
      includeParagraphOrder: options.includeStoryOrder
    });
  }

  searchLatestChapterParagraphsByStructure(
    workId: string,
    keyword: string,
    options: Pick<ChapterParagraphSearchOptions, "excludeAuthorNotes" | "includeTimeline" | "chapterIds"> = {}
  ): ChapterParagraphMatch[] {
    const work = this.getWork(workId);
    if ((work.modulePermissions as WorkModulePermissions).prose === "none") return [];
    const normalizedKeyword = normalizeDocumentSearchText(keyword.trim());
    if (!normalizedKeyword || (options.chapterIds && options.chapterIds.length === 0)) return [];
    const search = this.chapterParagraphSearchPlan(workId, normalizedKeyword, options);
    const rows = this.db.all(
      `WITH matched_paragraphs AS (
         SELECT DISTINCT paragraph.id AS paragraph_id, paragraph.chapter_id, chapter.title AS chapter_title,
           paragraph.content, paragraph.paragraph_order, chapter.sort_order AS chapter_order,
           volume.id AS volume_id, volume.story_order AS volume_story_order
         FROM chapter_paragraph_search paragraph
         JOIN chapters chapter ON chapter.id = paragraph.chapter_id
         JOIN volumes volume ON volume.id = chapter.volume_id
         ${search.joinSql}
         WHERE ${search.whereSql}
       ), latest_story_order AS (
         SELECT MAX(volume_story_order) AS value FROM matched_paragraphs
       ), ranked_paragraphs AS (
         SELECT matched_paragraphs.*,
           DENSE_RANK() OVER (
             PARTITION BY volume_id
             ORDER BY chapter_order DESC, paragraph_order DESC
           ) AS occurrence_rank
         FROM matched_paragraphs
         JOIN latest_story_order ON matched_paragraphs.volume_story_order = latest_story_order.value
       )
       SELECT chapter_id, chapter_title, content, paragraph_order
       FROM ranked_paragraphs
       WHERE occurrence_rank = 1
       ORDER BY volume_id, chapter_id, paragraph_id`,
      ...search.params
    );
    return this.mapChapterParagraphMatches(workId, rows, {
      includeStoryOrder: true,
      includeTimeline: options.includeTimeline,
      includeParagraphOrder: true
    });
  }

  searchLatestChapterParagraphsByTimelineTrack(
    workId: string,
    keyword: string,
    options: Pick<ChapterParagraphSearchOptions, "excludeAuthorNotes" | "chapterIds"> = {}
  ): LatestTimelineTrackChapterParagraph[] {
    const work = this.getWork(workId);
    const permissions = work.modulePermissions as WorkModulePermissions;
    if (permissions.prose === "none" || permissions.timeline === "none") return [];
    const normalizedKeyword = normalizeDocumentSearchText(keyword.trim());
    if (!normalizedKeyword || (options.chapterIds && options.chapterIds.length === 0)) return [];
    const search = this.chapterParagraphSearchPlan(workId, normalizedKeyword, options);
    const rows = this.db.all(
      `WITH matched_paragraphs AS (
         SELECT DISTINCT paragraph.id AS paragraph_id, paragraph.chapter_id, chapter.title AS chapter_title,
           paragraph.content, paragraph.paragraph_order, chapter.sort_order AS chapter_order,
           volume.story_order AS volume_story_order
         FROM chapter_paragraph_search paragraph
         JOIN chapters chapter ON chapter.id = paragraph.chapter_id
         JOIN volumes volume ON volume.id = chapter.volume_id
         ${search.joinSql}
         WHERE ${search.whereSql}
       ), ranked_links AS (
         SELECT matched_paragraphs.*, event.id AS event_id, event.name AS event_name,
           event.event_type, event.time_label, event.time_sort, event.track_id,
           track.name AS track_name, track.sort_order AS track_order,
           ROW_NUMBER() OVER (
             PARTITION BY event.track_id
             ORDER BY event.time_sort DESC, matched_paragraphs.volume_story_order DESC,
               matched_paragraphs.chapter_order DESC, matched_paragraphs.paragraph_order DESC,
               event.id, matched_paragraphs.paragraph_id
           ) AS track_rank,
           COUNT(*) OVER (PARTITION BY event.track_id, event.time_sort) AS matching_links_at_time
         FROM matched_paragraphs
         JOIN timeline_events event ON event.work_id = ?
           AND event.status = 'confirmed' AND event.time_sort IS NOT NULL
           AND typeof(event.time_sort) IN ('integer', 'real')
           AND event.time_sort BETWEEN -1.0e308 AND 1.0e308
           AND json_valid(event.chapter_ids_json)
         JOIN json_each(event.chapter_ids_json) linked_chapter
           ON CAST(linked_chapter.value AS TEXT) = matched_paragraphs.chapter_id
         LEFT JOIN timeline_tracks track ON track.id = event.track_id AND track.work_id = event.work_id
       )
       SELECT chapter_id, chapter_title, content, paragraph_order,
         event_id, event_name, event_type, time_label, time_sort,
         track_id, track_name, track_order, matching_links_at_time
       FROM ranked_links
       WHERE track_rank = 1
       ORDER BY track_order IS NULL, track_order, track_id
       LIMIT 100`,
      ...search.params,
      workId
    );
    const occurrences = this.mapChapterParagraphMatches(workId, rows, {
      includeStoryOrder: true,
      includeTimeline: false,
      includeParagraphOrder: true
    });
    return rows.flatMap((row, index) => {
      const timeSort = Number(row.time_sort);
      const occurrence = occurrences[index];
      if (!occurrence || !Number.isFinite(timeSort)) return [];
      return [{
        trackId: optionalString(row, "track_id"),
        trackName: optionalString(row, "track_name"),
        trackOrder: row.track_order === null || row.track_order === undefined ? null : numberValue(row, "track_order"),
        timeSort,
        timeLabel: requiredString(row, "time_label"),
        timelineEvent: {
          id: requiredString(row, "event_id"),
          name: requiredString(row, "event_name"),
          eventType: requiredString(row, "event_type")
        },
        occurrence,
        matchingLinksAtLatestTime: numberValue(row, "matching_links_at_time")
      }];
    });
  }

  private invalidateChapter(workId: string, chapterId: string, versionNo: number): void {
    this.db.run(
      `UPDATE analysis_tasks SET status = 'expired', updated_at = ?
       WHERE work_id = ? AND status IN ('pending', 'running', 'completed', 'partial', 'review')
       AND (json_extract(scope_json, '$.chapterId') = ?
         OR EXISTS (SELECT 1 FROM json_each(scope_json, '$.chapterIds') WHERE json_each.value = ?)
         OR json_extract(scope_json, '$.type') = 'book'
         OR (json_extract(scope_json, '$.type') = 'volume'
           AND (json_extract(scope_json, '$.volumeId') = (SELECT volume_id FROM chapters WHERE id = ?)
             OR EXISTS (
               SELECT 1 FROM json_each(scope_json, '$.volumeIds')
               WHERE json_each.value = (SELECT volume_id FROM chapters WHERE id = ?)
             ))))`,
      now(),
      workId,
      chapterId,
      chapterId,
      chapterId,
      chapterId
    );
    this.notifyChapterAnalysisInvalidated(workId, chapterId, versionNo);
  }

  private mapWorks(rows: Row[]): Record<string, unknown>[] {
    if (rows.length === 0) return [];
    const actor = currentRequestActor();
    const workIds = [...new Set(rows.map((row) => requiredString(row, "id")))];
    const batch: WorkListBatch = {
      memberships: new Map(),
      counts: new Map(),
      covers: new Map()
    };
    for (let offset = 0; offset < workIds.length; offset += WORK_LIST_BATCH_SIZE) {
      const batchIds = workIds.slice(offset, offset + WORK_LIST_BATCH_SIZE);
      const placeholders = batchIds.map(() => "?").join(", ");
      if (actor) {
        const memberships = this.db.all(
          `SELECT work_id, role, permissions_json FROM work_memberships
           WHERE user_id = ? AND work_id IN (${placeholders})`,
          actor.userId,
          ...batchIds
        );
        for (const membership of memberships) {
          batch.memberships.set(requiredString(membership, "work_id"), membership);
        }
      }
      const counts = this.db.all(
        `SELECT work_id, COUNT(*) AS chapter_count, COALESCE(SUM(word_count), 0) AS word_count
         FROM chapters WHERE work_id IN (${placeholders}) AND deleted_at IS NULL GROUP BY work_id`,
        ...batchIds
      );
      for (const count of counts) batch.counts.set(requiredString(count, "work_id"), count);
      const covers = this.db.all(
        `SELECT work_id, updated_at FROM work_covers WHERE work_id IN (${placeholders})`,
        ...batchIds
      );
      for (const cover of covers) batch.covers.set(requiredString(cover, "work_id"), cover);
    }
    return rows.map((row) => this.mapWork(row, batch));
  }

  private mapWork(row: Row, batch?: WorkListBatch): Record<string, unknown> {
    const actor = currentRequestActor();
    const workId = requiredString(row, "id");
    const ownerUserId = optionalString(row, "owner_user_id");
    const membership = batch
      ? batch.memberships.get(workId)
      : actor
        ? this.db.get("SELECT role, permissions_json FROM work_memberships WHERE work_id = ? AND user_id = ?", workId, actor.userId)
        : undefined;
    const membershipRole = String(membership?.role ?? "");
    const ownerAccess = ownerUserId === actor?.userId;
    const adminAccess = actor?.role === "admin" && actor.authentication !== "api-key";
    const modulePermissions = !actor || ownerAccess || adminAccess
      ? fullWorkModulePermissions()
      : membershipRole
        ? storedWorkModulePermissions(membershipRole, optionalString(membership ?? {}, "permissions_json"))
        : emptyWorkModulePermissions();
    const accessRole = ownerUserId === actor?.userId
      ? "owner"
      : adminAccess
        ? "admin"
        : membershipRole ? classifyWorkModulePermissions(modulePermissions) : null;
    const count = batch
      ? batch.counts.get(workId)
      : this.db.get(
        "SELECT COUNT(*) AS chapter_count, COALESCE(SUM(word_count), 0) AS word_count FROM chapters WHERE work_id = ? AND deleted_at IS NULL",
        workId
      );
    const cover = batch
      ? batch.covers.get(workId)
      : this.db.get("SELECT updated_at FROM work_covers WHERE work_id = ?", workId);
    return {
      id: workId,
      title: requiredString(row, "title"),
      author: requiredString(row, "author"),
      description: requiredString(row, "description"),
      language: requiredString(row, "language"),
      coverUrl: cover
        ? `/api/works/${encodeURIComponent(workId)}/cover?v=${encodeURIComponent(requiredString(cover, "updated_at"))}`
        : optionalString(row, "cover_url"),
      tags: json(requiredString(row, "tags_json"), []),
      offlineAccessEnabled: numberValue(row, "offline_access_enabled") === 1,
      versionNo: numberValue(row, "version_no") || this.currentEntityVersionNo("work", workId),
      ownerUserId,
      accessRole,
      modulePermissions,
      chapterCount: modulePermissions.prose === "none" ? 0 : numberValue(count ?? {}, "chapter_count"),
      wordCount: modulePermissions.prose === "none" ? 0 : numberValue(count ?? {}, "word_count"),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at")
    };
  }

  private mapVolume(row: Row): Record<string, unknown> {
    return {
      id: requiredString(row, "id"),
      workId: requiredString(row, "work_id"),
      title: requiredString(row, "title"),
      kind: requiredString(row, "kind"),
      source: requiredString(row, "source"),
      description: optionalString(row, "description") ?? "",
      keywords: json<string[]>(optionalString(row, "keywords_json"), []),
      sortOrder: numberValue(row, "sort_order"),
      storyOrder: numberValue(row, "story_order"),
      versionNo: numberValue(row, "version_no") || this.currentEntityVersionNo("volume", requiredString(row, "id")),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at")
    };
  }

  private normalizeVolumeKeywords(keywords: string[]): string[] {
    return [...new Set(keywords.map((keyword) => keyword.normalize("NFKC").trim()).filter(Boolean))].slice(0, 100);
  }

  private mapChapter(row: Row): Record<string, unknown> {
    return {
      ...this.mapChapterDirectoryEntry(row),
      content: requiredString(row, "content"),
      lineIds: parseChapterLineIds(row.line_ids_json, requiredString(row, "content"))
    };
  }

  private mapChapterDirectoryEntry(row: Row): Record<string, unknown> {
    return {
      id: requiredString(row, "id"),
      workId: requiredString(row, "work_id"),
      volumeId: requiredString(row, "volume_id"),
      title: requiredString(row, "title"),
      chapterType: requiredString(row, "chapter_type") || "正文",
      sortOrder: numberValue(row, "sort_order"),
      wordCount: numberValue(row, "word_count"),
      versionNo: numberValue(row, "version_no"),
      analysisStatus: requiredString(row, "analysis_status"),
      excludedFromAnalysis: booleanValue(row, "excluded_from_analysis"),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at")
    };
  }

  getChapterOutline(chapterId: string): Record<string, unknown> | null {
    const chapter = this.getChapter(chapterId);
    const row = this.db.get("SELECT * FROM chapter_outlines WHERE chapter_id = ?", chapterId);
    if (!row) return null;
    return this.mapChapterOutline(row, chapter);
  }

  getChapterOutlineBoard(workId: string, filters: ChapterOutlineBoardFilters, pagination: Pagination): {
    workId: string;
    volumes: ChapterOutlineBoardVolume[];
    volumeOptions: Array<Omit<ChapterOutlineBoardVolume, "chapters">>;
    filters: ChapterOutlineBoardFilters;
    page: number;
    limit: number;
    itemCount: number;
    total: number;
    pageCount: number;
    hasMore: boolean;
    nextPage: number | null;
    stats: {
      chapterCount: number;
      outlinedChapterCount: number;
      foreshadowCount: number;
      unresolvedForeshadowCount: number;
    };
  } {
    this.getWork(workId);
    const previewLength = CHAPTER_OUTLINE_BOARD_PREVIEW_LENGTH;
    const where = [
      "chapter.work_id = ?",
      "chapter.deleted_at IS NULL",
      "volume.deleted_at IS NULL"
    ];
    const whereParams: SQLInputValue[] = [workId];
    if (filters.volumeId) {
      where.push("chapter.volume_id = ?");
      whereParams.push(filters.volumeId);
    }
    if (filters.outlineStatus === "empty") {
      where.push("outline.chapter_id IS NULL");
    } else if (filters.outlineStatus !== "all") {
      where.push("outline.status = ?");
      whereParams.push(filters.outlineStatus);
    }

    const associatedForeshadow = (statusSql = ""): string => `(
      EXISTS (
        SELECT 1 FROM foreshadow_occurrences occurrence
        JOIN foreshadows foreshadow ON foreshadow.id = occurrence.foreshadow_id
        WHERE occurrence.chapter_id = chapter.id AND foreshadow.work_id = chapter.work_id${statusSql}
      ) OR EXISTS (
        SELECT 1 FROM foreshadows foreshadow
        WHERE foreshadow.work_id = chapter.work_id
          AND foreshadow.planned_payoff_chapter_id = chapter.id${statusSql}
      )
    )`;
    if (filters.foreshadowStatus === "none") {
      where.push(`NOT ${associatedForeshadow()}`);
    } else if (filters.foreshadowStatus !== "all") {
      const statusSql = filters.foreshadowStatus === "unresolved"
        ? " AND foreshadow.status IN ('planned', 'planted')"
        : filters.foreshadowStatus === "resolved"
          ? " AND foreshadow.status = 'resolved'"
          : " AND foreshadow.status = 'abandoned'";
      where.push(associatedForeshadow(statusSql));
    }
    const trimmedQuery = filters.query.trim();
    if (trimmedQuery) {
      const pattern = chapterOutlineBoardLikePattern(trimmedQuery);
      where.push(`(
        lower(chapter.title) LIKE ? ESCAPE '\\'
        OR lower(chapter.chapter_type) LIKE ? ESCAPE '\\'
        OR lower(outline.goal) LIKE ? ESCAPE '\\'
        OR lower(outline.conflict) LIKE ? ESCAPE '\\'
        OR lower(outline.turning_point) LIKE ? ESCAPE '\\'
        OR lower(outline.notes) LIKE ? ESCAPE '\\'
        OR EXISTS (
          SELECT 1 FROM foreshadow_occurrences occurrence
          JOIN foreshadows foreshadow ON foreshadow.id = occurrence.foreshadow_id
          WHERE occurrence.chapter_id = chapter.id AND foreshadow.work_id = chapter.work_id
            AND lower(foreshadow.title) LIKE ? ESCAPE '\\'
        )
        OR EXISTS (
          SELECT 1 FROM foreshadows foreshadow
          WHERE foreshadow.work_id = chapter.work_id
            AND foreshadow.planned_payoff_chapter_id = chapter.id
            AND lower(foreshadow.title) LIKE ? ESCAPE '\\'
        )
      )`);
      whereParams.push(...Array.from({ length: 8 }, () => pattern));
    }
    const whereSql = where.join(" AND ");

    const chapterTreeOrder = "chapter.sort_order, chapter.created_at, chapter.id";
    const chapterOrder = filters.sort === "status"
      ? `CASE WHEN outline.chapter_id IS NULL THEN 0 WHEN outline.status = 'draft' THEN 1 WHEN outline.status = 'ready' THEN 2 ELSE 3 END, ${chapterTreeOrder}`
      : filters.sort === "foreshadows"
        ? `${chapterOutlineBoardForeshadowSortSql.order}, ${chapterTreeOrder}`
        : filters.sort === "title"
          ? `chapter.title COLLATE NOCASE, ${chapterTreeOrder}`
          : chapterTreeOrder;
    const orderSql = `volume.sort_order, volume.created_at, volume.id, ${chapterOrder}`;
    const foreshadowSortCte = filters.sort === "foreshadows" ? chapterOutlineBoardForeshadowSortSql.cte : "";
    const foreshadowSortJoin = filters.sort === "foreshadows" ? chapterOutlineBoardForeshadowSortSql.join : "";
    const foreshadowSortParams: SQLInputValue[] = filters.sort === "foreshadows" ? [workId, workId] : [];

    const total = numberValue(this.db.get(
      `SELECT COUNT(*) AS count
       FROM chapters chapter
       JOIN volumes volume ON volume.id = chapter.volume_id AND volume.work_id = chapter.work_id
       LEFT JOIN chapter_outlines outline ON outline.chapter_id = chapter.id
       WHERE ${whereSql}`,
      ...whereParams
    ) ?? {}, "count");
    const pageRows = this.db.all(
      `${foreshadowSortCte}
       SELECT volume.id AS volume_id, volume.title AS volume_title, volume.sort_order AS volume_order,
       chapter.id AS chapter_id, chapter.title AS chapter_title, chapter.chapter_type,
       chapter.sort_order AS chapter_order,
       outline.chapter_id AS outline_chapter_id,
       substr(outline.goal, 1, ?) AS goal, length(outline.goal) > ? AS goal_truncated,
       substr(outline.conflict, 1, ?) AS conflict, length(outline.conflict) > ? AS conflict_truncated,
       substr(outline.turning_point, 1, ?) AS turning_point, length(outline.turning_point) > ? AS turning_point_truncated,
       substr(outline.notes, 1, ?) AS notes, length(outline.notes) > ? AS notes_truncated,
       outline.status, outline.updated_at AS outline_updated_at
       FROM chapters chapter
       JOIN volumes volume ON volume.id = chapter.volume_id AND volume.work_id = chapter.work_id
       LEFT JOIN chapter_outlines outline ON outline.chapter_id = chapter.id
       ${foreshadowSortJoin}
       WHERE ${whereSql}
       ORDER BY ${orderSql}
       LIMIT ? OFFSET ?`,
      ...foreshadowSortParams,
      previewLength,
      previewLength,
      previewLength,
      previewLength,
      previewLength,
      previewLength,
      previewLength,
      previewLength,
      ...whereParams,
      pagination.limit + 1,
      pagination.offset
    );
    const chapterPage = paginated(pageRows, pagination, total);

    const volumeRows = this.db.all(
      `SELECT volume.id, volume.title, volume.sort_order,
       COUNT(chapter.id) AS chapter_count
       FROM volumes volume
       LEFT JOIN chapters chapter
         ON chapter.volume_id = volume.id AND chapter.work_id = volume.work_id AND chapter.deleted_at IS NULL
       WHERE volume.work_id = ? AND volume.deleted_at IS NULL
       GROUP BY volume.id
       ORDER BY volume.sort_order, volume.created_at, volume.id`,
      workId
    );
    const filteredVolumeRows = this.db.all(
      `SELECT chapter.volume_id, COUNT(*) AS chapter_count
       FROM chapters chapter
       JOIN volumes volume ON volume.id = chapter.volume_id AND volume.work_id = chapter.work_id
       LEFT JOIN chapter_outlines outline ON outline.chapter_id = chapter.id
       WHERE ${whereSql}
       GROUP BY chapter.volume_id`,
      ...whereParams
    );
    const filteredCountByVolume = new Map(filteredVolumeRows.map((row) => [
      requiredString(row, "volume_id"),
      numberValue(row, "chapter_count")
    ]));
    const volumeOptions = volumeRows.map((row) => ({
      id: requiredString(row, "id"),
      title: requiredString(row, "title"),
      sortOrder: numberValue(row, "sort_order"),
      chapterCount: numberValue(row, "chapter_count"),
      filteredChapterCount: filteredCountByVolume.get(requiredString(row, "id")) ?? 0
    }));
    const volumeOptionById = new Map(volumeOptions.map((volume) => [volume.id, volume]));
    const volumeOrderById = new Map(volumeOptions.map((volume, index) => [volume.id, index]));
    const volumeById = new Map<string, ChapterOutlineBoardVolume>();
    const chapterById = new Map<string, ChapterOutlineBoardChapter>();
    for (const row of chapterPage.items) {
      const volumeId = requiredString(row, "volume_id");
      let volume = volumeById.get(volumeId);
      if (!volume) {
        const summary = volumeOptionById.get(volumeId);
        volume = {
          id: volumeId,
          title: requiredString(row, "volume_title"),
          sortOrder: numberValue(row, "volume_order"),
          chapterCount: summary?.chapterCount ?? 0,
          filteredChapterCount: summary?.filteredChapterCount ?? 0,
          chapters: []
        };
        volumeById.set(volumeId, volume);
      }
      const chapterId = requiredString(row, "chapter_id");
      const hasOutline = optionalString(row, "outline_chapter_id") !== null;
      const chapter: ChapterOutlineBoardChapter = {
        id: chapterId,
        title: requiredString(row, "chapter_title"),
        chapterType: requiredString(row, "chapter_type") || "正文",
        sortOrder: numberValue(row, "chapter_order"),
        outline: hasOutline ? {
          goal: optionalString(row, "goal") ?? "",
          conflict: optionalString(row, "conflict") ?? "",
          turningPoint: optionalString(row, "turning_point") ?? "",
          notes: optionalString(row, "notes") ?? "",
          status: optionalString(row, "status") ?? "draft",
          truncated: ["goal_truncated", "conflict_truncated", "turning_point_truncated", "notes_truncated"]
            .some((field) => booleanValue(row, field)),
          updatedAt: optionalString(row, "outline_updated_at")
        } : null,
        foreshadows: []
      };
      volume.chapters.push(chapter);
      chapterById.set(chapterId, chapter);
    }

    const chapterIds = [...chapterById.keys()];
    type MutableForeshadow = Omit<ChapterOutlineBoardForeshadow, "roles"> & {
      roles: Set<"setup" | "reminder" | "payoff">;
    };
    const associations = new Map<string, Map<string, MutableForeshadow>>();
    const associate = (
      chapterId: string | null,
      source: { id: string; title: string; status: string; importance: string },
      role?: "setup" | "reminder" | "payoff",
      plannedPayoff = false
    ): void => {
      if (!chapterId || !chapterById.has(chapterId)) return;
      const byForeshadow = associations.get(chapterId) ?? new Map<string, MutableForeshadow>();
      const summary = byForeshadow.get(source.id) ?? {
        ...source,
        roles: new Set<"setup" | "reminder" | "payoff">(),
        plannedPayoff: false
      };
      if (role) summary.roles.add(role);
      if (plannedPayoff) summary.plannedPayoff = true;
      byForeshadow.set(source.id, summary);
      associations.set(chapterId, byForeshadow);
    };

    const placeholders = chapterIds.map(() => "?").join(", ");
    const foreshadowRows = chapterIds.length === 0 ? [] : this.db.all(
      `SELECT association.* FROM (
         SELECT chapter.id AS chapter_id, foreshadow.id, foreshadow.title, foreshadow.status,
           foreshadow.importance, foreshadow.created_at AS foreshadow_created_at,
           occurrence.role, 0 AS planned_payoff, occurrence.created_at AS association_created_at,
           occurrence.id AS association_id
         FROM chapters chapter
         JOIN foreshadow_occurrences occurrence ON occurrence.chapter_id = chapter.id
         JOIN foreshadows foreshadow ON foreshadow.id = occurrence.foreshadow_id
         WHERE chapter.id IN (${placeholders}) AND chapter.work_id = ? AND chapter.deleted_at IS NULL
           AND foreshadow.work_id = ?
         UNION ALL
         SELECT chapter.id AS chapter_id, foreshadow.id, foreshadow.title, foreshadow.status,
           foreshadow.importance, foreshadow.created_at AS foreshadow_created_at,
           NULL AS role, 1 AS planned_payoff, foreshadow.created_at AS association_created_at,
           foreshadow.id AS association_id
         FROM chapters chapter
         JOIN foreshadows foreshadow ON foreshadow.planned_payoff_chapter_id = chapter.id
         WHERE chapter.id IN (${placeholders}) AND chapter.work_id = ? AND chapter.deleted_at IS NULL
           AND foreshadow.work_id = ?
       ) association
       ORDER BY CASE association.importance WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
         association.foreshadow_created_at, association.id, association.association_created_at, association.association_id`,
      ...chapterIds,
      workId,
      workId,
      ...chapterIds,
      workId,
      workId
    );
    for (const row of foreshadowRows) {
      const source = {
        id: requiredString(row, "id"),
        title: requiredString(row, "title"),
        status: requiredString(row, "status"),
        importance: requiredString(row, "importance")
      };
      const role = optionalString(row, "role");
      associate(
        requiredString(row, "chapter_id"),
        source,
        role === "setup" || role === "reminder" || role === "payoff" ? role : undefined,
        booleanValue(row, "planned_payoff")
      );
    }

    for (const [chapterId, byForeshadow] of associations) {
      const chapter = chapterById.get(chapterId);
      if (!chapter) continue;
      chapter.foreshadows = [...byForeshadow.values()].map((summary) => ({
        ...summary,
        roles: [...summary.roles]
      }));
    }

    const chapterFiltersActive = Boolean(trimmedQuery || filters.outlineStatus !== "all" || filters.foreshadowStatus !== "all");
    if (pagination.page === 1) {
      for (const option of volumeOptions) {
        if (option.chapterCount !== 0) continue;
        if (filters.volumeId && option.id !== filters.volumeId) continue;
        if (chapterFiltersActive && filters.volumeId !== option.id) continue;
        volumeById.set(option.id, { ...option, chapters: [] });
      }
    }
    const volumes = [...volumeById.values()].sort((left, right) => (
      (volumeOrderById.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (volumeOrderById.get(right.id) ?? Number.MAX_SAFE_INTEGER)
    ));
    const statsRow = this.db.get(
      `SELECT
       (SELECT COUNT(*) FROM chapters chapter
        JOIN volumes volume ON volume.id = chapter.volume_id AND volume.work_id = chapter.work_id
        WHERE chapter.work_id = ? AND chapter.deleted_at IS NULL AND volume.deleted_at IS NULL) AS chapter_count,
       (SELECT COUNT(*) FROM chapter_outlines outline
        JOIN chapters chapter ON chapter.id = outline.chapter_id
        JOIN volumes volume ON volume.id = chapter.volume_id AND volume.work_id = chapter.work_id
        WHERE chapter.work_id = ? AND chapter.deleted_at IS NULL AND volume.deleted_at IS NULL) AS outlined_chapter_count,
       (SELECT COUNT(*) FROM foreshadows foreshadow WHERE foreshadow.work_id = ?) AS foreshadow_count,
       (SELECT COUNT(*) FROM foreshadows foreshadow
        WHERE foreshadow.work_id = ? AND foreshadow.status IN ('planned', 'planted')) AS unresolved_foreshadow_count`,
      workId,
      workId,
      workId,
      workId
    ) ?? {};
    return {
      workId,
      volumes,
      volumeOptions,
      filters: { ...filters, query: trimmedQuery },
      page: chapterPage.page,
      limit: chapterPage.limit,
      itemCount: chapterById.size,
      total,
      pageCount: Math.max(1, Math.ceil(total / pagination.limit)),
      hasMore: chapterPage.hasMore,
      nextPage: chapterPage.nextPage,
      stats: {
        chapterCount: numberValue(statsRow, "chapter_count"),
        outlinedChapterCount: numberValue(statsRow, "outlined_chapter_count"),
        foreshadowCount: numberValue(statsRow, "foreshadow_count"),
        unresolvedForeshadowCount: numberValue(statsRow, "unresolved_foreshadow_count")
      }
    };
  }

  listChapterOutlines(workId: string): Record<string, unknown>[] {
    this.getWork(workId);
    const rows = this.db.all(
      `SELECT c.id AS chapter_id, c.title AS chapter_title, c.volume_id, c.sort_order AS chapter_order,
       v.title AS volume_title, v.sort_order AS volume_order,
       o.goal, o.conflict, o.turning_point, o.notes, o.status, o.created_at, o.updated_at,
       (SELECT COUNT(DISTINCT fo.foreshadow_id) FROM foreshadow_occurrences fo
        JOIN foreshadows f ON f.id = fo.foreshadow_id
        WHERE fo.chapter_id = c.id AND f.status IN ('planned', 'planted')) AS unresolved_count
       FROM chapters c
       JOIN volumes v ON v.id = c.volume_id
       LEFT JOIN chapter_outlines o ON o.chapter_id = c.id
       WHERE c.work_id = ? AND c.deleted_at IS NULL
       ORDER BY v.sort_order, c.sort_order, c.created_at`,
      workId
    );
    return rows.map((row) => ({
      chapterId: requiredString(row, "chapter_id"),
      chapterTitle: requiredString(row, "chapter_title"),
      volumeId: requiredString(row, "volume_id"),
      volumeTitle: requiredString(row, "volume_title"),
      goal: optionalString(row, "goal") ?? "",
      conflict: optionalString(row, "conflict") ?? "",
      turningPoint: optionalString(row, "turning_point") ?? "",
      notes: optionalString(row, "notes") ?? "",
      status: optionalString(row, "status") ?? "draft",
      unresolvedForeshadowCount: numberValue(row, "unresolved_count"),
      createdAt: optionalString(row, "created_at"),
      updatedAt: optionalString(row, "updated_at")
    }));
  }

  listChapterOutlinesPage(workId: string, pagination: Pagination): PaginatedResult<Record<string, unknown>> {
    this.getWork(workId);
    const page = paginationSql(pagination);
    const rows = this.db.all(
      `SELECT c.id AS chapter_id, c.title AS chapter_title, c.volume_id, c.sort_order AS chapter_order,
       v.title AS volume_title, v.sort_order AS volume_order,
       o.goal, o.conflict, o.turning_point, o.notes, o.status, o.created_at, o.updated_at,
       (SELECT COUNT(DISTINCT fo.foreshadow_id) FROM foreshadow_occurrences fo
        JOIN foreshadows f ON f.id = fo.foreshadow_id
        WHERE fo.chapter_id = c.id AND f.status IN ('planned', 'planted')) AS unresolved_count
       FROM chapters c
       JOIN volumes v ON v.id = c.volume_id
       LEFT JOIN chapter_outlines o ON o.chapter_id = c.id
       WHERE c.work_id = ? AND c.deleted_at IS NULL
       ORDER BY v.sort_order, c.sort_order, c.created_at${page.sql}`,
      workId,
      ...page.params
    );
    return paginated(rows.map((row) => ({
      chapterId: requiredString(row, "chapter_id"),
      chapterTitle: requiredString(row, "chapter_title"),
      volumeId: requiredString(row, "volume_id"),
      volumeTitle: requiredString(row, "volume_title"),
      goal: optionalString(row, "goal") ?? "",
      conflict: optionalString(row, "conflict") ?? "",
      turningPoint: optionalString(row, "turning_point") ?? "",
      notes: optionalString(row, "notes") ?? "",
      status: optionalString(row, "status") ?? "draft",
      unresolvedForeshadowCount: numberValue(row, "unresolved_count"),
      createdAt: optionalString(row, "created_at"),
      updatedAt: optionalString(row, "updated_at")
    })), pagination);
  }

  upsertChapterOutline(
    chapterId: string,
    input: ChapterOutlineInput,
    source = "manual",
    sourceRef: string | null = null,
    changeNote = "",
    expectedVersionNo?: number
  ): Record<string, unknown> {
    const chapter = this.getChapter(chapterId);
    const current = this.getChapterOutline(chapterId);
    const timestamp = now();
    this.db.transaction(() => {
      if (current) this.assertExpectedVersion("chapter-outline", chapterId, expectedVersionNo, "章节大纲");
      this.db.run(
        `INSERT INTO chapter_outlines (chapter_id, goal, conflict, turning_point, notes, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(chapter_id) DO UPDATE SET goal = excluded.goal, conflict = excluded.conflict,
         turning_point = excluded.turning_point, notes = excluded.notes, status = excluded.status,
         updated_at = excluded.updated_at`,
        chapterId,
        input.goal ?? String(current?.goal ?? ""),
        input.conflict ?? String(current?.conflict ?? ""),
        input.turningPoint ?? String(current?.turningPoint ?? ""),
        input.notes ?? String(current?.notes ?? ""),
        input.status ?? String(current?.status ?? "draft"),
        timestamp,
        timestamp
      );
      this.recordEntityVersion("chapter-outline", chapterId, current ? source : "create", sourceRef, changeNote || (current ? "更新章节大纲" : "建立章节大纲"), timestamp);
      this.audit(String(chapter.workId), current ? "outline.updated" : "outline.created", "chapter-outline", chapterId, { fields: Object.keys(input), source, sourceRef });
    });
    return this.getChapterOutline(chapterId) as Record<string, unknown>;
  }

  deleteChapterOutline(chapterId: string, expectedVersionNo?: number): void {
    const chapter = this.getChapter(chapterId);
    const outline = this.getChapterOutline(chapterId);
    if (!outline) return;
    this.db.transaction(() => {
      this.assertExpectedVersion("chapter-outline", chapterId, expectedVersionNo, "章节大纲");
      this.recordEntityVersion("chapter-outline", chapterId, "delete", null, "删除章节大纲");
      this.db.run("DELETE FROM chapter_outlines WHERE chapter_id = ?", chapterId);
      this.audit(String(chapter.workId), "outline.deleted", "chapter-outline", chapterId);
    });
  }

  private mapChapterOutline(row: Row, chapter: Record<string, unknown>): Record<string, unknown> {
    return {
      chapterId: requiredString(row, "chapter_id"),
      workId: chapter.workId,
      chapterTitle: chapter.title,
      volumeId: chapter.volumeId,
      goal: requiredString(row, "goal"),
      conflict: requiredString(row, "conflict"),
      turningPoint: requiredString(row, "turning_point"),
      notes: requiredString(row, "notes"),
      status: requiredString(row, "status"),
      versionNo: this.currentEntityVersionNo("chapter-outline", requiredString(row, "chapter_id")),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at")
    };
  }

  createForeshadow(workId: string, input: ForeshadowInput): Record<string, unknown> {
    this.getWork(workId);
    if (input.plannedPayoffChapterId) this.assertChapterInWork(input.plannedPayoffChapterId, workId);
    return this.insertForeshadowWithId(workId, id("foreshadow"), input, "create", null);
  }

  private insertForeshadowWithId(
    workId: string,
    foreshadowId: string,
    input: ForeshadowInput,
    source = "create",
    sourceRef: string | null = null,
    changeNote = ""
  ): Record<string, unknown> {
    if (input.plannedPayoffChapterId) this.assertChapterInWork(input.plannedPayoffChapterId, workId);
    const timestamp = now();
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO foreshadows (id, work_id, title, description, status, importance,
         planned_payoff_chapter_id, resolution_note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        foreshadowId,
        workId,
        input.title,
        input.description ?? "",
        input.status ?? "planned",
        input.importance ?? "medium",
        input.plannedPayoffChapterId ?? null,
        input.resolutionNote ?? "",
        timestamp,
        timestamp
      );
      for (const occurrence of input.occurrences ?? []) this.insertForeshadowOccurrence(foreshadowId, workId, occurrence);
      this.recordEntityVersion("foreshadow", foreshadowId, source, sourceRef, changeNote || "建立伏笔", timestamp);
      this.audit(workId, source === "restore" ? "foreshadow.restored" : "foreshadow.created", "foreshadow", foreshadowId);
    });
    return this.getForeshadow(foreshadowId);
  }

  getForeshadow(foreshadowId: string, currentChapterId?: string): Record<string, unknown> {
    const row = this.db.get("SELECT * FROM foreshadows WHERE id = ?", foreshadowId);
    if (!row) throw notFound("伏笔");
    const workId = requiredString(row, "work_id");
    if (currentChapterId) this.assertChapterInWork(currentChapterId, workId);
    const occurrences = this.db.all(
      `SELECT fo.*, c.title AS chapter_title, c.volume_id, c.sort_order AS chapter_order,
       v.title AS volume_title, v.sort_order AS volume_order
       FROM foreshadow_occurrences fo
       JOIN chapters c ON c.id = fo.chapter_id
       JOIN volumes v ON v.id = c.volume_id
       WHERE fo.foreshadow_id = ? ORDER BY v.sort_order, c.sort_order, fo.created_at`,
      foreshadowId
    ).map((item) => this.mapForeshadowOccurrence(item));
    const status = requiredString(row, "status");
    const plannedPayoffChapterId = optionalString(row, "planned_payoff_chapter_id");
    const overdue = Boolean(currentChapterId && plannedPayoffChapterId && ["planned", "planted"].includes(status)
      && this.chapterSequence(workId, plannedPayoffChapterId) < this.chapterSequence(workId, currentChapterId));
    return this.mapForeshadow(row, occurrences, this.currentEntityVersionNo("foreshadow", foreshadowId), overdue);
  }

  private mapForeshadow(
    row: Row,
    occurrences: Record<string, unknown>[],
    versionNo: number,
    overdue: boolean
  ): Record<string, unknown> {
    const status = requiredString(row, "status");
    return {
      id: requiredString(row, "id"),
      workId: requiredString(row, "work_id"),
      title: requiredString(row, "title"),
      description: requiredString(row, "description"),
      status,
      importance: requiredString(row, "importance"),
      plannedPayoffChapterId: optionalString(row, "planned_payoff_chapter_id"),
      resolutionNote: requiredString(row, "resolution_note"),
      unresolved: status === "planned" || status === "planted",
      overdue,
      occurrences,
      versionNo,
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at")
    };
  }

  listForeshadows(workId: string, status: "all" | "unresolved" | "resolved" = "all", currentChapterId?: string): Record<string, unknown>[] {
    this.getWork(workId);
    if (currentChapterId) this.assertChapterInWork(currentChapterId, workId);
    const where = status === "unresolved"
      ? "AND status IN ('planned', 'planted')"
      : status === "resolved" ? "AND status IN ('resolved', 'abandoned')" : "";
    const rows = this.db.all(
      `SELECT * FROM foreshadows WHERE work_id = ? ${where}
       ORDER BY CASE importance WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at`,
      workId
    );
    return this.mapForeshadowList(rows, currentChapterId);
  }

  listForeshadowsPage(workId: string, pagination: Pagination, status: "all" | "unresolved" | "resolved" = "all", currentChapterId?: string): PaginatedResult<Record<string, unknown>> {
    this.getWork(workId);
    if (currentChapterId) this.assertChapterInWork(currentChapterId, workId);
    const where = status === "unresolved"
      ? "AND status IN ('planned', 'planted')"
      : status === "resolved" ? "AND status IN ('resolved', 'abandoned')" : "";
    const page = paginationSql(pagination);
    const rows = this.db.all(
      `SELECT * FROM foreshadows WHERE work_id = ? ${where}
       ORDER BY CASE importance WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at${page.sql}`,
      workId,
      ...page.params
    );
    return paginated(this.mapForeshadowList(rows, currentChapterId), pagination);
  }

  private mapForeshadowList(rows: Row[], currentChapterId?: string): Record<string, unknown>[] {
    if (rows.length === 0) return [];
    const foreshadowIds = rows.map((row) => requiredString(row, "id"));
    const batch = {
      occurrences: new Map<string, Record<string, unknown>[]>(),
      versions: this.currentEntityVersionNos("foreshadow", foreshadowIds),
      chapterSequences: new Map<string, number>()
    };
    for (let offset = 0; offset < foreshadowIds.length; offset += ENTITY_LIST_BATCH_SIZE) {
      const batchIds = foreshadowIds.slice(offset, offset + ENTITY_LIST_BATCH_SIZE);
      const placeholders = batchIds.map(() => "?").join(", ");
      const occurrences = this.db.all(
        `SELECT fo.*, c.title AS chapter_title, c.volume_id, c.sort_order AS chapter_order,
         v.title AS volume_title, v.sort_order AS volume_order
         FROM foreshadow_occurrences fo
         JOIN chapters c ON c.id = fo.chapter_id
         JOIN volumes v ON v.id = c.volume_id
         WHERE fo.foreshadow_id IN (${placeholders})
         ORDER BY fo.foreshadow_id, v.sort_order, c.sort_order, fo.created_at`,
        ...batchIds
      );
      for (const occurrence of occurrences) {
        const foreshadowId = requiredString(occurrence, "foreshadow_id");
        const grouped = batch.occurrences.get(foreshadowId) ?? [];
        grouped.push(this.mapForeshadowOccurrence(occurrence));
        batch.occurrences.set(foreshadowId, grouped);
      }
    }
    if (currentChapterId) {
      const chapterIds = [...new Set([
        currentChapterId,
        ...rows.map((row) => optionalString(row, "planned_payoff_chapter_id")).filter((chapterId): chapterId is string => Boolean(chapterId))
      ])];
      for (let offset = 0; offset < chapterIds.length; offset += ENTITY_LIST_BATCH_SIZE) {
        const batchIds = chapterIds.slice(offset, offset + ENTITY_LIST_BATCH_SIZE);
        const placeholders = batchIds.map(() => "?").join(", ");
        const sequences = this.db.all(
          `SELECT c.id, v.sort_order * 1000000 + c.sort_order AS sequence
           FROM chapters c JOIN volumes v ON v.id = c.volume_id
           WHERE c.id IN (${placeholders}) AND c.work_id = ?`,
          ...batchIds,
          requiredString(rows[0] ?? {}, "work_id")
        );
        for (const sequence of sequences) {
          batch.chapterSequences.set(requiredString(sequence, "id"), numberValue(sequence, "sequence"));
        }
      }
    }
    const currentChapterSequence = currentChapterId
      ? batch.chapterSequences.get(currentChapterId) ?? Number.MAX_SAFE_INTEGER
      : Number.MAX_SAFE_INTEGER;
    return rows.map((row) => {
      const foreshadowId = requiredString(row, "id");
      const status = requiredString(row, "status");
      const plannedPayoffChapterId = optionalString(row, "planned_payoff_chapter_id");
      const overdue = Boolean(currentChapterId && plannedPayoffChapterId && ["planned", "planted"].includes(status)
        && (batch.chapterSequences.get(plannedPayoffChapterId) ?? Number.MAX_SAFE_INTEGER) < currentChapterSequence);
      return this.mapForeshadow(
        row,
        batch.occurrences.get(foreshadowId) ?? [],
        batch.versions.get(foreshadowId) ?? 0,
        overdue
      );
    });
  }

  listChapterForeshadowReminders(workId: string, chapterId: string): Record<string, unknown>[] {
    this.getWork(workId);
    this.assertChapterInWork(chapterId, workId);
    const seenForeshadowIds = new Set<string>();
    return this.db.all(
      `SELECT occurrence.id AS occurrence_id, occurrence.foreshadow_id, occurrence.role, occurrence.note,
       foreshadow.title, foreshadow.description, foreshadow.status, foreshadow.importance,
       foreshadow.updated_at,
       (SELECT MAX(version.version_no) FROM entity_versions version
        WHERE version.entity_type = 'foreshadow' AND version.entity_id = foreshadow.id) AS version_no
       FROM foreshadow_occurrences occurrence
       JOIN foreshadows foreshadow ON foreshadow.id = occurrence.foreshadow_id
       JOIN chapters chapter ON chapter.id = occurrence.chapter_id
       WHERE foreshadow.work_id = ? AND chapter.work_id = ? AND occurrence.chapter_id = ?
         AND foreshadow.status IN ('planned', 'planted')
         AND occurrence.role IN ('reminder', 'payoff')
       ORDER BY CASE occurrence.role WHEN 'payoff' THEN 0 ELSE 1 END,
         CASE foreshadow.importance WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
         foreshadow.created_at, occurrence.created_at`,
      workId,
      workId,
      chapterId
    ).flatMap((row) => {
      const foreshadowId = requiredString(row, "foreshadow_id");
      if (seenForeshadowIds.has(foreshadowId)) return [];
      seenForeshadowIds.add(foreshadowId);
      return [{
        foreshadowId,
        occurrenceId: requiredString(row, "occurrence_id"),
        title: requiredString(row, "title"),
        description: requiredString(row, "description"),
        status: requiredString(row, "status"),
        importance: requiredString(row, "importance"),
        role: requiredString(row, "role"),
        note: requiredString(row, "note"),
        versionNo: numberValue(row, "version_no"),
        updatedAt: requiredString(row, "updated_at")
      }];
    });
  }

  resolveChapterForeshadowReminder(
    workId: string,
    chapterId: string,
    foreshadowId: string,
    expectedVersionNo?: number
  ): Record<string, unknown> {
    this.getWork(workId);
    this.assertChapterInWork(chapterId, workId);
    const reminder = this.db.get(
      `SELECT occurrence.id AS occurrence_id
       FROM foreshadow_occurrences occurrence
       JOIN foreshadows foreshadow ON foreshadow.id = occurrence.foreshadow_id
       WHERE foreshadow.id = ? AND foreshadow.work_id = ? AND occurrence.chapter_id = ?
         AND foreshadow.status IN ('planned', 'planted')
         AND occurrence.role IN ('reminder', 'payoff')
       ORDER BY CASE occurrence.role WHEN 'payoff' THEN 0 ELSE 1 END, occurrence.created_at
       LIMIT 1`,
      foreshadowId,
      workId,
      chapterId
    );
    if (!reminder) throw notFound("伏笔提醒");
    const updated = this.updateForeshadow(
      foreshadowId,
      { status: "resolved" },
      "manual",
      requiredString(reminder, "occurrence_id"),
      "在编辑器标记伏笔已回收",
      expectedVersionNo
    );
    return {
      foreshadowId: String(updated.id),
      status: String(updated.status),
      versionNo: Number(updated.versionNo),
      updatedAt: String(updated.updatedAt)
    };
  }

  updateForeshadow(
    foreshadowId: string,
    input: Partial<ForeshadowInput>,
    source = "manual",
    sourceRef: string | null = null,
    changeNote = "",
    expectedVersionNo?: number
  ): Record<string, unknown> {
    const current = this.getForeshadow(foreshadowId);
    const workId = String(current.workId);
    if (input.plannedPayoffChapterId) this.assertChapterInWork(input.plannedPayoffChapterId, workId);
    this.db.transaction(() => {
      this.assertExpectedVersion("foreshadow", foreshadowId, expectedVersionNo, "伏笔");
      this.db.run(
        `UPDATE foreshadows SET title = ?, description = ?, status = ?, importance = ?,
         planned_payoff_chapter_id = ?, resolution_note = ?, updated_at = ? WHERE id = ?`,
        input.title ?? String(current.title),
        input.description ?? String(current.description),
        input.status ?? String(current.status),
        input.importance ?? String(current.importance),
        input.plannedPayoffChapterId === undefined ? current.plannedPayoffChapterId as string | null : input.plannedPayoffChapterId,
        input.resolutionNote ?? String(current.resolutionNote),
        now(),
        foreshadowId
      );
      if (input.occurrences) {
        this.db.run("DELETE FROM foreshadow_occurrences WHERE foreshadow_id = ?", foreshadowId);
        for (const occurrence of input.occurrences) this.insertForeshadowOccurrence(foreshadowId, workId, occurrence);
      }
      this.recordEntityVersion("foreshadow", foreshadowId, source, sourceRef, changeNote || "更新伏笔");
      this.audit(workId, "foreshadow.updated", "foreshadow", foreshadowId, { fields: Object.keys(input), source, sourceRef });
    });
    return this.getForeshadow(foreshadowId);
  }

  deleteForeshadow(foreshadowId: string, expectedVersionNo?: number): void {
    const current = this.getForeshadow(foreshadowId);
    this.db.transaction(() => {
      this.assertExpectedVersion("foreshadow", foreshadowId, expectedVersionNo, "伏笔");
      this.recordEntityVersion("foreshadow", foreshadowId, "delete", null, "删除伏笔");
      this.db.run("DELETE FROM foreshadows WHERE id = ?", foreshadowId);
      this.audit(String(current.workId), "foreshadow.deleted", "foreshadow", foreshadowId);
    });
  }

  createForeshadowOccurrence(foreshadowId: string, input: ForeshadowOccurrenceInput, expectedVersionNo?: number): Record<string, unknown> {
    const foreshadow = this.getForeshadow(foreshadowId);
    const occurrenceId = this.db.transaction(() => {
      this.assertExpectedVersion("foreshadow", foreshadowId, expectedVersionNo, "伏笔");
      const createdId = this.insertForeshadowOccurrence(foreshadowId, String(foreshadow.workId), input);
      this.recordEntityVersion("foreshadow", foreshadowId, "manual", createdId, "添加伏笔章节记录");
      this.audit(String(foreshadow.workId), "foreshadow.occurrence.created", "foreshadow-occurrence", createdId);
      return createdId;
    });
    return this.getForeshadowOccurrence(occurrenceId);
  }

  updateForeshadowOccurrence(occurrenceId: string, input: Partial<ForeshadowOccurrenceInput>, expectedVersionNo?: number): Record<string, unknown> {
    const current = this.getForeshadowOccurrence(occurrenceId);
    const foreshadow = this.getForeshadow(String(current.foreshadowId));
    const chapterId = input.chapterId ?? String(current.chapterId);
    this.assertChapterInWork(chapterId, String(foreshadow.workId));
    this.db.transaction(() => {
      this.assertExpectedVersion("foreshadow", String(current.foreshadowId), expectedVersionNo, "伏笔");
      this.db.run(
        `UPDATE foreshadow_occurrences SET chapter_id = ?, role = ?, note = ?, evidence_json = ?, updated_at = ? WHERE id = ?`,
        chapterId,
        input.role ?? String(current.role),
        input.note ?? String(current.note),
        JSON.stringify(input.evidence ?? current.evidence),
        now(),
        occurrenceId
      );
      this.recordEntityVersion("foreshadow", String(current.foreshadowId), "manual", occurrenceId, "更新伏笔章节记录");
    });
    return this.getForeshadowOccurrence(occurrenceId);
  }

  deleteForeshadowOccurrence(occurrenceId: string, expectedVersionNo?: number): void {
    const current = this.getForeshadowOccurrence(occurrenceId);
    this.db.transaction(() => {
      this.assertExpectedVersion("foreshadow", String(current.foreshadowId), expectedVersionNo, "伏笔");
      this.db.run("DELETE FROM foreshadow_occurrences WHERE id = ?", occurrenceId);
      this.recordEntityVersion("foreshadow", String(current.foreshadowId), "manual", occurrenceId, "删除伏笔章节记录");
    });
  }

  private insertForeshadowOccurrence(foreshadowId: string, workId: string, input: ForeshadowOccurrenceInput): string {
    this.assertChapterInWork(input.chapterId, workId);
    const occurrenceId = id("foreshadowOccurrence");
    const timestamp = now();
    this.db.run(
      `INSERT INTO foreshadow_occurrences (id, foreshadow_id, chapter_id, role, note, evidence_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      occurrenceId,
      foreshadowId,
      input.chapterId,
      input.role,
      input.note ?? "",
      JSON.stringify(input.evidence ?? []),
      timestamp,
      timestamp
    );
    return occurrenceId;
  }

  getForeshadowOccurrence(occurrenceId: string): Record<string, unknown> {
    const row = this.db.get(
      `SELECT fo.*, c.title AS chapter_title, c.volume_id, v.title AS volume_title
       FROM foreshadow_occurrences fo JOIN chapters c ON c.id = fo.chapter_id
       JOIN volumes v ON v.id = c.volume_id WHERE fo.id = ?`,
      occurrenceId
    );
    if (!row) throw notFound("伏笔章节记录");
    return this.mapForeshadowOccurrence(row);
  }

  private mapForeshadowOccurrence(row: Row): Record<string, unknown> {
    return {
      id: requiredString(row, "id"),
      foreshadowId: requiredString(row, "foreshadow_id"),
      chapterId: requiredString(row, "chapter_id"),
      chapterTitle: requiredString(row, "chapter_title"),
      volumeId: requiredString(row, "volume_id"),
      volumeTitle: requiredString(row, "volume_title"),
      role: requiredString(row, "role"),
      note: requiredString(row, "note"),
      evidence: json(requiredString(row, "evidence_json"), []),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at")
    };
  }

  private assertChapterInWork(chapterId: string, workId: string): void {
    const chapter = this.getChapter(chapterId);
    if (chapter.workId !== workId) throw new AppError(400, "CHAPTER_WORK_MISMATCH", "章节不属于当前作品");
  }

  private chapterSequence(workId: string, chapterId: string): number {
    const row = this.db.get(
      `SELECT v.sort_order * 1000000 + c.sort_order AS sequence
       FROM chapters c JOIN volumes v ON v.id = c.volume_id WHERE c.id = ? AND c.work_id = ?`,
      chapterId,
      workId
    );
    return row ? numberValue(row, "sequence") : Number.MAX_SAFE_INTEGER;
  }

  createDraft(workId: string, input: DraftInput, source = "create", sourceRef: string | null = null): Record<string, unknown> {
    this.getWork(workId);
    return this.insertDraftWithId(workId, id("draft"), input, source, sourceRef);
  }

  private insertDraftWithId(
    workId: string,
    draftId: string,
    input: DraftInput,
    source = "create",
    sourceRef: string | null = null,
    changeNote = ""
  ): Record<string, unknown> {
    const timestamp = now();
    const binding = this.normalizeDraftBinding(workId, input.draftType, input.volumeId ?? null, input.settingModule ?? null);
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO drafts (id, work_id, draft_type, volume_id, setting_module, title, content, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        draftId,
        workId,
        input.draftType,
        binding.volumeId,
        binding.settingModule,
        input.title,
        input.content,
        timestamp,
        timestamp
      );
      this.syncMarkdownAttachmentReferences(workId, "draft", draftId, input.content);
      this.recordEntityVersion("draft", draftId, source, sourceRef, changeNote || "建立创作想法", timestamp);
      this.audit(workId, source === "restore" ? "draft.restored" : "draft.created", "draft", draftId, {
        draftType: input.draftType,
        source,
        sourceRef
      });
    });
    return this.getDraft(draftId);
  }

  listDrafts(workId: string, draftType?: "prose" | "setting", includeContent = false): Record<string, unknown>[] {
    this.getWork(workId);
    const preferences = this.entityPreferenceProjection("draft", "draft");
    return this.db.all(
      `SELECT draft.*, volume.title AS volume_title, ${preferences.columns} FROM drafts draft
       LEFT JOIN volumes volume ON volume.id = draft.volume_id
       WHERE draft.work_id = ? AND (? IS NULL OR draft.draft_type = ?)
       ORDER BY ${preferences.orderBy}, draft.updated_at DESC, draft.title`,
      ...preferences.params,
      workId,
      draftType ?? null,
      draftType ?? null
    ).map((row) => this.mapDraft(row, includeContent));
  }

  listDraftsPage(
    workId: string,
    pagination: Pagination,
    draftType?: "prose" | "setting",
    includeContent = false
  ): PaginatedResult<Record<string, unknown>> {
    this.getWork(workId);
    const preferences = this.entityPreferenceProjection("draft", "draft");
    const page = paginationSql(pagination);
    const rows = this.db.all(
      `SELECT draft.*, volume.title AS volume_title, ${preferences.columns} FROM drafts draft
       LEFT JOIN volumes volume ON volume.id = draft.volume_id
       WHERE draft.work_id = ? AND (? IS NULL OR draft.draft_type = ?)
       ORDER BY ${preferences.orderBy}, draft.updated_at DESC, draft.title${page.sql}`,
      ...preferences.params,
      workId,
      draftType ?? null,
      draftType ?? null,
      ...page.params
    );
    return paginated(rows.map((row) => this.mapDraft(row, includeContent)), pagination);
  }

  searchDrafts(
    workId: string,
    query: string,
    draftType?: "prose" | "setting",
    limit = 20
  ): Record<string, unknown>[] {
    this.getWork(workId);
    const safeLimit = Math.min(30, Math.max(1, Math.trunc(limit)));
    const normalizedQuery = query.normalize("NFKC").trim();
    const escapedQuery = escapeSqlLikePattern(normalizedQuery);
    const pattern = `%${escapedQuery}%`;
    const preferences = this.entityPreferenceProjection("draft", "draft");
    const rows = normalizedQuery
      ? this.db.all(
          `SELECT draft.*, volume.title AS volume_title, ${preferences.columns} FROM drafts draft
           LEFT JOIN volumes volume ON volume.id = draft.volume_id
           WHERE draft.work_id = ? AND (? IS NULL OR draft.draft_type = ?)
             AND (draft.title LIKE ? ESCAPE '\\' COLLATE NOCASE OR draft.content LIKE ? ESCAPE '\\' COLLATE NOCASE)
           ORDER BY ${preferences.orderBy}, CASE WHEN draft.title LIKE ? ESCAPE '\\' COLLATE NOCASE THEN 0 ELSE 1 END, draft.updated_at DESC
           LIMIT ?`,
          ...preferences.params,
          workId,
          draftType ?? null,
          draftType ?? null,
          pattern,
          pattern,
          pattern,
          safeLimit
        )
      : this.db.all(
          `SELECT draft.*, volume.title AS volume_title, ${preferences.columns} FROM drafts draft
           LEFT JOIN volumes volume ON volume.id = draft.volume_id
           WHERE draft.work_id = ? AND (? IS NULL OR draft.draft_type = ?)
           ORDER BY ${preferences.orderBy}, draft.updated_at DESC, draft.title LIMIT ?`,
          ...preferences.params,
          workId,
          draftType ?? null,
          draftType ?? null,
          safeLimit
        );
    return rows.map((row) => this.mapDraft(row, true));
  }

  getDraft(draftId: string): Record<string, unknown> {
    const preferences = this.entityPreferenceProjection("draft", "draft");
    const row = this.db.get(
      `SELECT draft.*, volume.title AS volume_title, ${preferences.columns} FROM drafts draft
       LEFT JOIN volumes volume ON volume.id = draft.volume_id WHERE draft.id = ?`,
      ...preferences.params,
      draftId
    );
    if (!row) throw notFound("想法");
    return this.mapDraft(row, true);
  }

  setDraftFavorite(draftId: string, isFavorite: boolean): Record<string, unknown> {
    const draft = this.db.get("SELECT id, work_id, is_favorite FROM drafts WHERE id = ?", draftId);
    if (!draft) throw notFound("想法");
    const workId = requiredString(draft, "work_id");
    this.db.transaction(() => {
      const previousFavorite = this.setEntityFavorite(workId, "draft", draftId, isFavorite, booleanValue(draft, "is_favorite"));
      if (previousFavorite !== isFavorite) {
        this.audit(workId, "draft.favorite-updated", "draft", draftId, {
          previousFavorite,
          isFavorite
        });
      }
    });
    return this.getDraft(draftId);
  }

  setDraftPin(draftId: string, isPinned: boolean): Record<string, unknown> {
    const draft = this.db.get("SELECT id, work_id FROM drafts WHERE id = ?", draftId);
    if (!draft) throw notFound("想法");
    const workId = requiredString(draft, "work_id");
    this.db.transaction(() => {
      const previousPin = this.setEntityPin(workId, "draft", draftId, isPinned);
      if (previousPin !== isPinned) {
        this.audit(workId, "draft.pin-updated", "draft", draftId, {
          previousPin,
          isPinned
        });
      }
    });
    return this.getDraft(draftId);
  }

  updateDraft(
    draftId: string,
    input: Partial<DraftInput>,
    source = "manual",
    sourceRef: string | null = null,
    changeNote = "",
    expectedVersionNo?: number
  ): Record<string, unknown> {
    const current = this.getDraft(draftId);
    const content = input.content ?? String(current.content);
    const draftType = input.draftType ?? current.draftType as "prose" | "setting";
    const typeChanged = input.draftType !== undefined && input.draftType !== current.draftType;
    const restoreMissingBinding = source === "restore";
    const volumeId = Object.hasOwn(input, "volumeId") ? input.volumeId ?? null : typeChanged || restoreMissingBinding ? null : current.volumeId as string | null;
    const settingModule = Object.hasOwn(input, "settingModule") ? input.settingModule ?? null : typeChanged || restoreMissingBinding ? null : current.settingModule as DraftSettingModule | null;
    const binding = this.normalizeDraftBinding(String(current.workId), draftType, volumeId, settingModule);
    this.db.transaction(() => {
      this.assertExpectedVersion("draft", draftId, expectedVersionNo, "想法");
      this.db.run(
        "UPDATE drafts SET draft_type = ?, volume_id = ?, setting_module = ?, title = ?, content = ?, updated_at = ? WHERE id = ?",
        draftType,
        binding.volumeId,
        binding.settingModule,
        input.title ?? String(current.title),
        content,
        now(),
        draftId
      );
      this.syncMarkdownAttachmentReferences(String(current.workId), "draft", draftId, content);
      this.recordEntityVersion("draft", draftId, source, sourceRef, changeNote || "更新创作想法");
      this.audit(String(current.workId), "draft.updated", "draft", draftId, { fields: Object.keys(input), source, sourceRef });
    });
    return this.getDraft(draftId);
  }

  deleteDraft(draftId: string, expectedVersionNo?: number): void {
    const current = this.getDraft(draftId);
    this.db.transaction(() => {
      this.assertExpectedVersion("draft", draftId, expectedVersionNo, "想法");
      this.recordEntityVersion("draft", draftId, "delete", null, "删除创作想法");
      this.clearMarkdownAttachmentReferences("draft", draftId);
      this.db.run("DELETE FROM drafts WHERE id = ?", draftId);
      this.audit(String(current.workId), "draft.deleted", "draft", draftId);
    });
  }

  private mapDraft(row: Row, includeContent: boolean): Record<string, unknown> {
    const content = requiredString(row, "content");
    return {
      id: requiredString(row, "id"),
      workId: requiredString(row, "work_id"),
      draftType: requiredString(row, "draft_type"),
      volumeId: optionalString(row, "volume_id"),
      volumeTitle: optionalString(row, "volume_title"),
      settingModule: optionalString(row, "setting_module"),
      title: requiredString(row, "title"),
      isFavorite: this.mapEntityFavorite(row),
      isPinned: this.mapEntityPin(row),
      ...(includeContent ? { content } : { contentPreview: content.replace(/\s+/gu, " ").trim().slice(0, 320) }),
      versionNo: this.currentEntityVersionNo("draft", requiredString(row, "id")),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at")
    };
  }

  private normalizeDraftBinding(
    workId: string,
    draftType: "prose" | "setting",
    volumeId: string | null,
    settingModule: DraftSettingModule | null
  ): { volumeId: string | null; settingModule: DraftSettingModule | null } {
    if (draftType === "prose") {
      if (settingModule !== null) {
        throw new AppError(400, "DRAFT_BINDING_TYPE_MISMATCH", "正文想法不能绑定设定模块");
      }
      if (volumeId !== null) {
        const volume = this.getVolume(volumeId);
        if (volume.workId !== workId) {
          throw new AppError(400, "DRAFT_VOLUME_WORK_MISMATCH", "分卷不属于当前作品");
        }
      }
      return { volumeId, settingModule: null };
    }
    if (volumeId !== null) {
      throw new AppError(400, "DRAFT_BINDING_TYPE_MISMATCH", "设定想法不能绑定分卷");
    }
    if (settingModule !== null && !DRAFT_SETTING_MODULES.includes(settingModule)) {
      throw new AppError(400, "DRAFT_SETTING_MODULE_INVALID", "设定想法绑定模块无效");
    }
    return { volumeId: null, settingModule };
  }

  private clearDraftVolumeBindings(
    workId: string,
    volumeIds: string[] | null,
    sourceRef: string | null,
    changeNote: string
  ): void {
    const drafts = volumeIds === null
      ? this.db.all("SELECT id FROM drafts WHERE work_id = ? AND volume_id IS NOT NULL", workId)
      : volumeIds.length
        ? this.db.all(
            `SELECT id FROM drafts WHERE work_id = ? AND volume_id IN (${volumeIds.map(() => "?").join(", ")})`,
            workId,
            ...volumeIds
          )
        : [];
    const timestamp = now();
    for (const draft of drafts) {
      const draftId = requiredString(draft, "id");
      this.db.run("UPDATE drafts SET volume_id = NULL, updated_at = ? WHERE id = ?", timestamp, draftId);
      this.recordEntityVersion("draft", draftId, "manual", sourceRef, changeNote, timestamp);
      this.audit(workId, "draft.updated", "draft", draftId, { fields: ["volumeId"], source: "volume-deleted", sourceRef });
    }
  }

  createSetting(workId: string, input: SettingInput, source = "create", sourceRef: string | null = null): Record<string, unknown> {
    this.getWork(workId);
    return this.insertSettingWithId(workId, id("setting"), input, source, sourceRef);
  }

  private insertSettingWithId(
    workId: string,
    settingId: string,
    input: SettingInput,
    source = "create",
    sourceRef: string | null = null,
    changeNote = ""
  ): Record<string, unknown> {
    const timestamp = now();
    const content = input.content;
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO settings (id, work_id, title, category, content, tags_json, status, locked, evidence_json, scope_json, author_note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        settingId,
        workId,
        input.title,
        input.category,
        content,
        JSON.stringify(input.tags ?? []),
        input.status ?? "draft",
        input.locked ? 1 : 0,
        JSON.stringify(input.evidence ?? []),
        JSON.stringify(input.scope ?? {}),
        input.authorNote ?? "",
        timestamp,
        timestamp
      );
      this.syncMarkdownAttachmentReferences(workId, "setting", settingId, content);
      this.recordEntityVersion("setting", settingId, source, sourceRef, changeNote || "建立世界观设定", timestamp);
      this.audit(workId, source === "restore" ? "setting.restored" : "setting.created", "setting", settingId, {
        locked: input.locked ?? false,
        source,
        sourceRef
      });
    });
    return this.getSetting(settingId);
  }

  listSettings(workId: string, includeContent = true): Record<string, unknown>[] {
    this.getWork(workId);
    const preferences = this.entityPreferenceProjection("setting", "setting");
    return this.db.all(`SELECT setting.*, ${preferences.columns} FROM settings setting WHERE setting.work_id = ? ORDER BY ${preferences.orderBy}, setting.locked DESC, setting.category, setting.title`, ...preferences.params, workId).map((row) => this.mapSetting(row, includeContent));
  }

  listSettingsPage(workId: string, pagination: Pagination, includeContent = true): PaginatedResult<Record<string, unknown>> {
    this.getWork(workId);
    const preferences = this.entityPreferenceProjection("setting", "setting");
    const page = paginationSql(pagination);
    const rows = this.db.all(`SELECT setting.*, ${preferences.columns} FROM settings setting WHERE setting.work_id = ? ORDER BY ${preferences.orderBy}, setting.locked DESC, setting.category, setting.title${page.sql}`, ...preferences.params, workId, ...page.params);
    return paginated(rows.map((row) => this.mapSetting(row, includeContent)), pagination);
  }

  getSetting(settingId: string): Record<string, unknown> {
    const preferences = this.entityPreferenceProjection("setting", "setting");
    const row = this.db.get(`SELECT setting.*, ${preferences.columns} FROM settings setting WHERE setting.id = ?`, ...preferences.params, settingId);
    if (!row) throw notFound("设定");
    return this.mapSetting(row);
  }

  setSettingFavorite(settingId: string, isFavorite: boolean): Record<string, unknown> {
    const setting = this.db.get("SELECT id, work_id, is_favorite FROM settings WHERE id = ?", settingId);
    if (!setting) throw notFound("设定");
    const workId = requiredString(setting, "work_id");
    this.db.transaction(() => {
      const previousFavorite = this.setEntityFavorite(workId, "setting", settingId, isFavorite, booleanValue(setting, "is_favorite"));
      if (previousFavorite !== isFavorite) {
        this.audit(workId, "setting.favorite-updated", "setting", settingId, {
          previousFavorite,
          isFavorite
        });
      }
    });
    return this.getSetting(settingId);
  }

  setSettingPin(settingId: string, isPinned: boolean): Record<string, unknown> {
    const setting = this.db.get("SELECT id, work_id FROM settings WHERE id = ?", settingId);
    if (!setting) throw notFound("设定");
    const workId = requiredString(setting, "work_id");
    this.db.transaction(() => {
      const previousPin = this.setEntityPin(workId, "setting", settingId, isPinned);
      if (previousPin !== isPinned) {
        this.audit(workId, "setting.pin-updated", "setting", settingId, {
          previousPin,
          isPinned
        });
      }
    });
    return this.getSetting(settingId);
  }

  updateSetting(
    settingId: string,
    input: Partial<SettingInput>,
    source = "manual",
    sourceRef: string | null = null,
    changeNote = "",
    expectedVersionNo?: number
  ): Record<string, unknown> {
    const current = this.getSetting(settingId);
    const content = input.content ?? String(current.content);
    this.db.transaction(() => {
      this.assertExpectedVersion("setting", settingId, expectedVersionNo, "设定");
      this.db.run(
        `UPDATE settings SET title = ?, category = ?, content = ?, tags_json = ?, status = ?, locked = ?,
         evidence_json = ?, scope_json = ?, author_note = ?, updated_at = ? WHERE id = ?`,
        input.title ?? String(current.title),
        input.category ?? String(current.category),
        content,
        JSON.stringify(input.tags ?? current.tags),
        input.status ?? String(current.status),
        (input.locked ?? Boolean(current.locked)) ? 1 : 0,
        JSON.stringify(input.evidence ?? current.evidence),
        JSON.stringify(input.scope ?? current.scope),
        input.authorNote ?? String(current.authorNote),
        now(),
        settingId
      );
      this.syncMarkdownAttachmentReferences(String(current.workId), "setting", settingId, content);
      this.recordEntityVersion("setting", settingId, source, sourceRef, changeNote || "更新世界观设定");
      this.audit(String(current.workId), "setting.updated", "setting", settingId, { fields: Object.keys(input), source, sourceRef });
    });
    return this.getSetting(settingId);
  }

  deleteSetting(settingId: string, expectedVersionNo?: number): void {
    const current = this.getSetting(settingId);
    this.db.transaction(() => {
      this.assertExpectedVersion("setting", settingId, expectedVersionNo, "设定");
      this.recordEntityVersion("setting", settingId, "delete", null, "删除世界观设定");
      this.clearMarkdownAttachmentReferences("setting", settingId);
      this.db.run("DELETE FROM settings WHERE id = ?", settingId);
      this.audit(String(current.workId), "setting.deleted", "setting", settingId);
    });
  }

  private mapSetting(row: Row, includeContent = true): Record<string, unknown> {
    const content = requiredString(row, "content");
    return {
      id: requiredString(row, "id"),
      workId: requiredString(row, "work_id"),
      title: requiredString(row, "title"),
      category: requiredString(row, "category"),
      ...(includeContent ? { content } : { contentPreview: content.replace(/\s+/gu, " ").trim().slice(0, 320) }),
      tags: json(requiredString(row, "tags_json"), []),
      status: requiredString(row, "status"),
      locked: booleanValue(row, "locked"),
      isFavorite: this.mapEntityFavorite(row),
      isPinned: this.mapEntityPin(row),
      evidence: json(requiredString(row, "evidence_json"), []),
      scope: json(requiredString(row, "scope_json"), {}),
      authorNote: requiredString(row, "author_note"),
      versionNo: this.currentEntityVersionNo("setting", requiredString(row, "id")),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at")
    };
  }

  createRace(workId: string, input: RaceInput): Record<string, unknown> {
    return this.insertRaceWithId(workId, id("race"), input, "create", null);
  }

  private insertRaceWithId(
    workId: string,
    raceId: string,
    input: RaceInput,
    source = "create",
    sourceRef: string | null = null,
    changeNote = ""
  ): Record<string, unknown> {
    this.getWork(workId);
    const name = input.name.normalize("NFKC").trim().replace(/\s+/gu, " ");
    const normalizedName = normalizeCharacterName(name);
    if (!normalizedName) throw new AppError(400, "RACE_NAME_REQUIRED", "种族名称不能为空");
    this.assertRaceNameAvailable(workId, normalizedName);
    const parentRaceId = input.parentRaceId ?? null;
    this.assertRaceParent(workId, parentRaceId, raceId);
    const memberIds = [...new Set(input.memberIds ?? [])];
    this.assertCharactersInWork(workId, memberIds);
    const memberSnapshots = this.captureCharacterSnapshots(memberIds);
    const settingsSections = knowledgeSectionsFromInput(input.settingsSections, input.settingsMarkdown, input.settings);
    const settings = settingsFromKnowledgeSections(settingsSections);
    const timestamp = now();
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO races (id, work_id, parent_race_id, name, normalized_name, description, is_extinct, settings_json, settings_sections_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        raceId,
        workId,
        parentRaceId,
        name,
        normalizedName,
        input.description ?? "",
        input.isExtinct ? 1 : 0,
        JSON.stringify(settings),
        JSON.stringify(settingsSections),
        timestamp,
        timestamp
      );
      this.syncMarkdownAttachmentReferences(workId, "race", raceId, settingsMarkdownFromList(settings));
      this.replaceRaceMembers(raceId, name, memberIds);
      this.recordMembershipVersions(memberSnapshots, "race", raceId, `设为种族“${name}”`);
      this.recordEntityVersion("race", raceId, source, sourceRef, changeNote || "建立种族档案", timestamp);
      this.audit(workId, source === "restore" ? "race.restored" : "race.created", "race", raceId);
    });
    return this.getRace(raceId);
  }

  listRaces(workId: string, includeMarkdown = true): Record<string, unknown>[] {
    this.getWork(workId);
    return this.db.all("SELECT * FROM races WHERE work_id = ? ORDER BY name", workId).map((row) => this.mapRace(row, includeMarkdown));
  }

  listRacesByHierarchyScope(workId: string, scope: "roots" | "descendants", includeMarkdown = true): Record<string, unknown>[] {
    this.getWork(workId);
    const hierarchyCondition = scope === "roots" ? "IS NULL" : "IS NOT NULL";
    return this.db.all(
      `SELECT race.*,
              (SELECT COUNT(*) FROM races child WHERE child.parent_race_id = race.id) AS child_count
       FROM races race
       WHERE race.work_id = ? AND race.parent_race_id ${hierarchyCondition}
       ORDER BY race.name`,
      workId
    ).map((row) => this.mapRace(row, includeMarkdown));
  }

  countRaces(workId: string): number {
    this.getWork(workId);
    return numberValue(this.db.get("SELECT COUNT(*) AS count FROM races WHERE work_id = ?", workId) ?? {}, "count");
  }

  listRacesPage(workId: string, pagination: Pagination, includeMarkdown = true): PaginatedResult<Record<string, unknown>> {
    this.getWork(workId);
    const page = paginationSql(pagination);
    const rows = this.db.all(`SELECT * FROM races WHERE work_id = ? ORDER BY name${page.sql}`, workId, ...page.params);
    return paginated(rows.map((row) => this.mapRace(row, includeMarkdown)), pagination);
  }

  getRace(raceId: string, includeMarkdown = true): Record<string, unknown> {
    const row = this.db.get("SELECT * FROM races WHERE id = ?", raceId);
    if (!row) throw notFound("种族");
    return this.mapRace(row, includeMarkdown);
  }

  updateRace(
    raceId: string,
    input: Partial<RaceInput>,
    source = "manual",
    sourceRef: string | null = null,
    changeNote = "",
    expectedVersionNo?: number
  ): Record<string, unknown> {
    const current = this.getRace(raceId);
    const workId = String(current.workId);
    const name = input.name === undefined
      ? String(current.name)
      : input.name.normalize("NFKC").trim().replace(/\s+/gu, " ");
    const normalizedName = normalizeCharacterName(name);
    if (!normalizedName) throw new AppError(400, "RACE_NAME_REQUIRED", "种族名称不能为空");
    this.assertRaceNameAvailable(workId, normalizedName, raceId);
    const parentRaceId = input.parentRaceId === undefined
      ? current.parentRaceId as string | null
      : input.parentRaceId;
    this.assertRaceParent(workId, parentRaceId, raceId);
    const memberIds = input.memberIds === undefined ? null : [...new Set(input.memberIds)];
    if (memberIds) this.assertCharactersInWork(workId, memberIds);
    const nameChanged = name !== current.name;
    const touchedMemberIds = memberIds || nameChanged
      ? [...new Set([...(current.memberIds as string[]), ...(memberIds ?? [])])]
      : [];
    const memberSnapshots = this.captureCharacterSnapshots(touchedMemberIds);
    const currentSections = knowledgeSectionsFromStored(current.settingsSections, current.settings as string[]);
    const settingsSections = knowledgeSectionsFromInput(input.settingsSections, input.settingsMarkdown, input.settings, currentSections);
    const settings = settingsFromKnowledgeSections(settingsSections);
    this.db.transaction(() => {
      this.assertExpectedVersion("race", raceId, expectedVersionNo, "种族");
      this.db.run(
        `UPDATE races SET parent_race_id = ?, name = ?, normalized_name = ?, description = ?, is_extinct = ?, settings_json = ?, settings_sections_json = ?, updated_at = ? WHERE id = ?`,
        parentRaceId,
        name,
        normalizedName,
        input.description ?? String(current.description),
        input.isExtinct === undefined ? (current.isExtinct ? 1 : 0) : (input.isExtinct ? 1 : 0),
        JSON.stringify(settings),
        JSON.stringify(settingsSections),
        now(),
        raceId
      );
      this.syncMarkdownAttachmentReferences(workId, "race", raceId, settingsMarkdownFromList(settings));
      if (nameChanged) this.db.run("UPDATE characters SET species = ?, updated_at = ? WHERE race_id = ?", name, now(), raceId);
      if (memberIds) this.replaceRaceMembers(raceId, name, memberIds);
      this.recordMembershipVersions(memberSnapshots, "race", raceId, nameChanged ? `种族更名为“${name}”` : `种族“${name}”成员关系变更`);
      this.recordEntityVersion("race", raceId, source, sourceRef, changeNote || "更新种族档案");
      this.audit(workId, "race.updated", "race", raceId, { fields: Object.keys(input), source, sourceRef });
    });
    return this.getRace(raceId);
  }

  deleteRace(raceId: string, expectedVersionNo?: number): void {
    const current = this.getRace(raceId);
    const child = this.db.get("SELECT id FROM races WHERE parent_race_id = ? LIMIT 1", raceId);
    if (child) {
      throw new AppError(409, "RACE_HAS_CHILDREN", "该种族仍有子种族，请先迁移或删除子种族", { raceId: requiredString(child, "id") });
    }
    const memberSnapshots = this.captureCharacterSnapshots(current.memberIds as string[]);
    this.db.transaction(() => {
      this.assertExpectedVersion("race", raceId, expectedVersionNo, "种族");
      this.recordEntityVersion("race", raceId, "delete", null, "删除种族档案");
      this.db.run("UPDATE characters SET race_id = NULL, species = '', updated_at = ? WHERE race_id = ?", now(), raceId);
      this.clearMarkdownAttachmentReferences("race", raceId);
      this.db.run("DELETE FROM races WHERE id = ?", raceId);
      this.recordMembershipVersions(memberSnapshots, "race", raceId, `种族“${String(current.name)}”已删除`);
      this.audit(String(current.workId), "race.deleted", "race", raceId);
    });
  }

  mergeRaces(sourceRaceId: string, targetRaceId: string): Record<string, unknown> {
    if (sourceRaceId === targetRaceId) throw new AppError(400, "RACE_MERGE_SELF", "不能把种族合并到自身");
    const source = this.getRace(sourceRaceId);
    const target = this.getRace(targetRaceId);
    if (source.workId !== target.workId) throw new AppError(400, "RACE_WORK_MISMATCH", "待合并种族不属于同一作品");

    const workId = String(target.workId);
    const mergeId = id("raceMerge");
    const timestamp = now();
    const memberIds = [...new Set([...(target.memberIds as string[]), ...(source.memberIds as string[])])];
    const memberSnapshots = this.captureCharacterSnapshots(memberIds);
    const sourceChildren = this.db.all("SELECT id FROM races WHERE parent_race_id = ? ORDER BY id", sourceRaceId)
      .map((row) => requiredString(row, "id"))
      .filter((childRaceId) => childRaceId !== targetRaceId);
    const targetDescendsFromSource = (target.lineage as Array<{ id: string }>).some((race) => race.id === sourceRaceId);
    const targetParentRaceId = targetDescendsFromSource
      ? source.parentRaceId as string | null
      : target.parentRaceId as string | null;
    const descriptionParts = [String(target.description).trim(), String(source.description).trim()].filter(Boolean);
    const description = [...new Set(descriptionParts)].join("\n\n");
    const settingsSections = [...knowledgeSectionsFromStored(target.settingsSections, target.settings as string[]), ...knowledgeSectionsFromStored(source.settingsSections, source.settings as string[])]
      .map((section, index) => ({ ...section, sortOrder: index }));
    const settings = settingsFromKnowledgeSections(settingsSections);

    this.db.transaction(() => {
      this.recordEntityVersion("race", sourceRaceId, "delete", mergeId, `合并至种族“${String(target.name)}”`, timestamp);
      this.db.run(
        "UPDATE races SET parent_race_id = ?, description = ?, settings_json = ?, settings_sections_json = ?, updated_at = ? WHERE id = ?",
        targetParentRaceId,
        description,
        JSON.stringify(settings),
        JSON.stringify(settingsSections),
        timestamp,
        targetRaceId
      );
      this.syncMarkdownAttachmentReferences(workId, "race", targetRaceId, settingsMarkdownFromList(settings));
      this.db.run(
        "UPDATE characters SET race_id = ?, species = ?, updated_at = ? WHERE race_id = ?",
        targetRaceId,
        String(target.name),
        timestamp,
        sourceRaceId
      );
      for (const childRaceId of sourceChildren) {
        this.db.run("UPDATE races SET parent_race_id = ?, updated_at = ? WHERE id = ?", targetRaceId, timestamp, childRaceId);
        this.recordEntityVersion("race", childRaceId, "merge", mergeId, `因种族“${String(source.name)}”合并而迁移父种族`, timestamp);
      }
      this.clearMarkdownAttachmentReferences("race", sourceRaceId);
      this.db.run("DELETE FROM races WHERE id = ?", sourceRaceId);
      this.recordMembershipVersions(memberSnapshots, "race", targetRaceId, `合并种族“${String(source.name)}”`);
      this.recordEntityVersion("race", targetRaceId, "merge", mergeId, `合并种族“${String(source.name)}”`, timestamp);
      this.audit(workId, "race.merged", "race", targetRaceId, { mergeId, sourceRaceId });
    });
    return { mergeId, target: this.getRace(targetRaceId), source };
  }

  resolveRaceReference(workId: string, value: string): string | null {
    const normalizedName = normalizeCharacterName(value);
    if (!normalizedName) return null;
    const row = this.db.get("SELECT id FROM races WHERE work_id = ? AND normalized_name = ?", workId, normalizedName);
    return row ? requiredString(row, "id") : null;
  }

  private mapRace(row: Row, includeMarkdown = true): Record<string, unknown> {
    const raceId = requiredString(row, "id");
    const lineage = includeMarkdown ? this.raceLineage(raceId) : this.raceLineageNames(raceId);
    const settingsSections = knowledgeSectionsFromStored(row.settings_sections_json, json<string[]>(requiredString(row, "settings_json"), []));
    const settings = settingsFromKnowledgeSections(settingsSections);
    const members = this.db.all("SELECT id, name FROM characters WHERE race_id = ? ORDER BY name", requiredString(row, "id")).map((member) => ({
      characterId: requiredString(member, "id"),
      name: requiredString(member, "name")
    }));
    return {
      id: requiredString(row, "id"),
      workId: requiredString(row, "work_id"),
      parentRaceId: optionalString(row, "parent_race_id"),
      name: requiredString(row, "name"),
      description: requiredString(row, "description"),
      isExtinct: booleanValue(row, "is_extinct"),
      ...(row.child_count === undefined ? {} : { childCount: numberValue(row, "child_count") }),
      ...(includeMarkdown
        ? { settings, settingsMarkdown: settingsMarkdownFromList(settings), settingsSections }
        : { settings: [], settingsCount: settingsSections.length }),
      lineage: lineage.map((item) => ({ id: item.id, name: item.name })),
      ...(includeMarkdown
        ? { effectiveSettings: (lineage as Array<{ id: string; name: string; settings: string[]; settingsSections: KnowledgeSection[] }>).flatMap((item, index) => item.settingsSections.map((section) => ({
          title: section.title,
          summary: section.summary,
          sortOrder: section.sortOrder,
          value: section.contentMarkdown,
          sourceRaceId: item.id,
          sourceRaceName: item.name,
          inherited: index < lineage.length - 1
        }))) }
        : {}),
      memberIds: members.map((member) => member.characterId),
      members,
      versionNo: this.currentEntityVersionNo("race", requiredString(row, "id")),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at")
    };
  }

  private assertRaceNameAvailable(workId: string, normalizedName: string, excludeRaceId?: string): void {
    const row = this.db.get(
      `SELECT id FROM races WHERE work_id = ? AND normalized_name = ?${excludeRaceId ? " AND id <> ?" : ""}`,
      ...([workId, normalizedName, ...(excludeRaceId ? [excludeRaceId] : [])])
    );
    if (row) throw new AppError(409, "RACE_NAME_CONFLICT", "同一作品内的种族名称不能重复", { raceId: requiredString(row, "id") });
  }

  private assertRaceInWork(workId: string, raceId: string): Record<string, unknown> {
    const race = this.getRace(raceId);
    if (race.workId !== workId) throw new AppError(400, "RACE_WORK_MISMATCH", "角色绑定的种族不属于当前作品");
    return race;
  }

  private assertRaceParent(workId: string, parentRaceId: string | null, raceId: string): void {
    if (!parentRaceId) return;
    const seen = new Set<string>();
    let currentId: string | null = parentRaceId;
    while (currentId) {
      if (currentId === raceId || seen.has(currentId)) {
        throw new AppError(409, "RACE_HIERARCHY_CYCLE", "父种族不能是当前种族或其后代");
      }
      seen.add(currentId);
      const row = this.db.get("SELECT id, work_id, parent_race_id FROM races WHERE id = ?", currentId);
      if (!row) throw notFound("父种族");
      if (requiredString(row, "work_id") !== workId) {
        throw new AppError(400, "RACE_PARENT_WORK_MISMATCH", "父种族不属于当前作品");
      }
      currentId = optionalString(row, "parent_race_id");
    }
  }

  private raceLineage(raceId: string): Array<{ id: string; name: string; settings: string[]; settingsSections: KnowledgeSection[] }> {
    const lineage: Array<{ id: string; name: string; settings: string[]; settingsSections: KnowledgeSection[] }> = [];
    const seen = new Set<string>();
    let currentId: string | null = raceId;
    while (currentId) {
      if (seen.has(currentId)) throw new AppError(500, "RACE_HIERARCHY_INVALID", "种族层级存在循环");
      seen.add(currentId);
      const row = this.db.get("SELECT id, name, settings_json, settings_sections_json, parent_race_id FROM races WHERE id = ?", currentId);
      if (!row) throw new AppError(500, "RACE_HIERARCHY_INVALID", "种族层级引用了不存在的父种族");
      const settingsSections = knowledgeSectionsFromStored(row.settings_sections_json, json<string[]>(requiredString(row, "settings_json"), []));
      lineage.push({
        id: requiredString(row, "id"),
        name: requiredString(row, "name"),
        settings: settingsFromKnowledgeSections(settingsSections),
        settingsSections
      });
      currentId = optionalString(row, "parent_race_id");
    }
    return lineage.reverse();
  }

  private raceLineageNames(raceId: string): Array<{ id: string; name: string }> {
    const lineage: Array<{ id: string; name: string }> = [];
    const seen = new Set<string>();
    let currentId: string | null = raceId;
    while (currentId) {
      if (seen.has(currentId)) throw new AppError(500, "RACE_HIERARCHY_INVALID", "种族层级存在循环");
      seen.add(currentId);
      const row = this.db.get("SELECT id, name, parent_race_id FROM races WHERE id = ?", currentId);
      if (!row) throw new AppError(500, "RACE_HIERARCHY_INVALID", "种族层级引用了不存在的父种族");
      lineage.push({ id: requiredString(row, "id"), name: requiredString(row, "name") });
      currentId = optionalString(row, "parent_race_id");
    }
    return lineage.reverse();
  }

  private replaceRaceMembers(raceId: string, raceName: string, memberIds: string[]): void {
    const timestamp = now();
    this.db.run("UPDATE characters SET race_id = NULL, species = '', updated_at = ? WHERE race_id = ?", timestamp, raceId);
    for (const characterId of memberIds) {
      this.db.run("UPDATE characters SET race_id = ?, species = ?, updated_at = ? WHERE id = ?", raceId, raceName, timestamp, characterId);
    }
  }

  createOrganization(workId: string, input: OrganizationInput): Record<string, unknown> {
    return this.insertOrganizationWithId(workId, id("organization"), input, "create", null);
  }

  private insertOrganizationWithId(
    workId: string,
    organizationId: string,
    input: OrganizationInput,
    source = "create",
    sourceRef: string | null = null,
    changeNote = ""
  ): Record<string, unknown> {
    this.getWork(workId);
    const name = input.name.normalize("NFKC").trim().replace(/\s+/gu, " ");
    const normalizedName = normalizeCharacterName(name);
    if (!normalizedName) throw new AppError(400, "ORGANIZATION_NAME_REQUIRED", "组织名称不能为空");
    this.assertOrganizationNameAvailable(workId, normalizedName);
    const memberIds = [...new Set(input.memberIds ?? [])];
    this.assertCharactersInWork(workId, memberIds);
    const memberSnapshots = this.captureCharacterSnapshots(memberIds);
    const settingsSections = knowledgeSectionsFromInput(input.settingsSections, input.settingsMarkdown, input.settings);
    const settings = settingsFromKnowledgeSections(settingsSections);
    const timestamp = now();
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO organizations (id, work_id, name, normalized_name, description, is_dissolved, settings_json, settings_sections_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        organizationId,
        workId,
        name,
        normalizedName,
        input.description ?? "",
        input.isDissolved ? 1 : 0,
        JSON.stringify(settings),
        JSON.stringify(settingsSections),
        timestamp,
        timestamp
      );
      this.syncMarkdownAttachmentReferences(workId, "organization", organizationId, settingsMarkdownFromList(settings));
      this.replaceOrganizationMembers(organizationId, memberIds);
      this.recordMembershipVersions(memberSnapshots, "organization", organizationId, `加入组织“${name}”`);
      this.recordEntityVersion("organization", organizationId, source, sourceRef, changeNote || "建立组织档案", timestamp);
      this.audit(workId, source === "restore" ? "organization.restored" : "organization.created", "organization", organizationId);
    });
    return this.getOrganization(organizationId);
  }

  listOrganizations(workId: string, includeMarkdown = true): Record<string, unknown>[] {
    this.getWork(workId);
    const preferences = this.entityPreferenceProjection("organization", "organization");
    const rows = this.db.all(`SELECT organization.*, ${preferences.columns} FROM organizations organization WHERE organization.work_id = ? ORDER BY ${preferences.orderBy}, organization.name`, ...preferences.params, workId);
    const batch = this.organizationListBatch(rows);
    return rows.map((row) => this.mapOrganization(row, includeMarkdown, batch));
  }

  listOrganizationsPage(workId: string, pagination: Pagination, includeMarkdown = true): PaginatedResult<Record<string, unknown>> {
    this.getWork(workId);
    const preferences = this.entityPreferenceProjection("organization", "organization");
    const page = paginationSql(pagination);
    const rows = this.db.all(`SELECT organization.*, ${preferences.columns} FROM organizations organization WHERE organization.work_id = ? ORDER BY ${preferences.orderBy}, organization.name${page.sql}`, ...preferences.params, workId, ...page.params);
    const batch = this.organizationListBatch(rows);
    return paginated(rows.map((row) => this.mapOrganization(row, includeMarkdown, batch)), pagination);
  }

  getOrganization(organizationId: string): Record<string, unknown> {
    const preferences = this.entityPreferenceProjection("organization", "organization");
    const row = this.db.get(`SELECT organization.*, ${preferences.columns} FROM organizations organization WHERE organization.id = ?`, ...preferences.params, organizationId);
    if (!row) throw notFound("组织");
    return this.mapOrganization(row);
  }

  setOrganizationFavorite(organizationId: string, isFavorite: boolean): Record<string, unknown> {
    const organization = this.db.get("SELECT id, work_id, is_favorite FROM organizations WHERE id = ?", organizationId);
    if (!organization) throw notFound("组织");
    const workId = requiredString(organization, "work_id");
    this.db.transaction(() => {
      const previousFavorite = this.setEntityFavorite(workId, "organization", organizationId, isFavorite, booleanValue(organization, "is_favorite"));
      if (previousFavorite !== isFavorite) {
        this.audit(workId, "organization.favorite-updated", "organization", organizationId, {
          previousFavorite,
          isFavorite
        });
      }
    });
    return this.getOrganization(organizationId);
  }

  setOrganizationPin(organizationId: string, isPinned: boolean): Record<string, unknown> {
    const organization = this.db.get("SELECT id, work_id FROM organizations WHERE id = ?", organizationId);
    if (!organization) throw notFound("组织");
    const workId = requiredString(organization, "work_id");
    this.db.transaction(() => {
      const previousPin = this.setEntityPin(workId, "organization", organizationId, isPinned);
      if (previousPin !== isPinned) {
        this.audit(workId, "organization.pin-updated", "organization", organizationId, {
          previousPin,
          isPinned
        });
      }
    });
    return this.getOrganization(organizationId);
  }

  updateOrganization(
    organizationId: string,
    input: Partial<OrganizationInput>,
    source = "manual",
    sourceRef: string | null = null,
    changeNote = "",
    expectedVersionNo?: number
  ): Record<string, unknown> {
    const current = this.getOrganization(organizationId);
    const workId = String(current.workId);
    const name = input.name === undefined
      ? String(current.name)
      : input.name.normalize("NFKC").trim().replace(/\s+/gu, " ");
    const normalizedName = normalizeCharacterName(name);
    if (!normalizedName) throw new AppError(400, "ORGANIZATION_NAME_REQUIRED", "组织名称不能为空");
    this.assertOrganizationNameAvailable(workId, normalizedName, organizationId);
    const memberIds = input.memberIds === undefined ? null : [...new Set(input.memberIds)];
    if (memberIds) this.assertCharactersInWork(workId, memberIds);
    const touchedMemberIds = memberIds ? [...new Set([...(current.memberIds as string[]), ...memberIds])] : [];
    const memberSnapshots = this.captureCharacterSnapshots(touchedMemberIds);
    const currentSections = knowledgeSectionsFromStored(current.settingsSections, current.settings as string[]);
    const settingsSections = knowledgeSectionsFromInput(input.settingsSections, input.settingsMarkdown, input.settings, currentSections);
    const settings = settingsFromKnowledgeSections(settingsSections);
    this.db.transaction(() => {
      this.assertExpectedVersion("organization", organizationId, expectedVersionNo, "组织");
      this.db.run(
        `UPDATE organizations SET name = ?, normalized_name = ?, description = ?, is_dissolved = ?, settings_json = ?, settings_sections_json = ?, updated_at = ? WHERE id = ?`,
        name,
        normalizedName,
        input.description ?? String(current.description),
        input.isDissolved === undefined ? (current.isDissolved ? 1 : 0) : (input.isDissolved ? 1 : 0),
        JSON.stringify(settings),
        JSON.stringify(settingsSections),
        now(),
        organizationId
      );
      this.syncMarkdownAttachmentReferences(workId, "organization", organizationId, settingsMarkdownFromList(settings));
      if (memberIds) {
        this.replaceOrganizationMembers(organizationId, memberIds);
        this.recordMembershipVersions(memberSnapshots, "organization", organizationId, `组织“${name}”成员关系变更`);
      }
      this.recordEntityVersion("organization", organizationId, source, sourceRef, changeNote || "更新组织档案");
      this.audit(workId, "organization.updated", "organization", organizationId, { fields: Object.keys(input), source, sourceRef });
    });
    return this.getOrganization(organizationId);
  }

  deleteOrganization(organizationId: string, expectedVersionNo?: number): void {
    const current = this.getOrganization(organizationId);
    const memberSnapshots = this.captureCharacterSnapshots(current.memberIds as string[]);
    this.db.transaction(() => {
      this.assertExpectedVersion("organization", organizationId, expectedVersionNo, "组织");
      this.recordEntityVersion("organization", organizationId, "delete", null, "删除组织档案");
      this.clearMarkdownAttachmentReferences("organization", organizationId);
      this.db.run("DELETE FROM organizations WHERE id = ?", organizationId);
      this.recordMembershipVersions(memberSnapshots, "organization", organizationId, `组织“${String(current.name)}”已删除`);
      this.audit(String(current.workId), "organization.deleted", "organization", organizationId);
    });
  }

  mergeOrganizations(sourceOrganizationId: string, targetOrganizationId: string): Record<string, unknown> {
    if (sourceOrganizationId === targetOrganizationId) {
      throw new AppError(400, "ORGANIZATION_MERGE_SELF", "不能把组织合并到自身");
    }
    const source = this.getOrganization(sourceOrganizationId);
    const target = this.getOrganization(targetOrganizationId);
    if (source.workId !== target.workId) {
      throw new AppError(400, "ORGANIZATION_WORK_MISMATCH", "待合并组织不属于同一作品");
    }

    const workId = String(target.workId);
    const mergeId = id("organizationMerge");
    const timestamp = now();
    const memberIds = [...new Set([...(target.memberIds as string[]), ...(source.memberIds as string[])])];
    const memberSnapshots = this.captureCharacterSnapshots(memberIds);
    const descriptionParts = [String(target.description).trim(), String(source.description).trim()].filter(Boolean);
    const description = [...new Set(descriptionParts)].join("\n\n");
    const settingsSections = [...knowledgeSectionsFromStored(target.settingsSections, target.settings as string[]), ...knowledgeSectionsFromStored(source.settingsSections, source.settings as string[])]
      .map((section, index) => ({ ...section, sortOrder: index }));
    const settings = settingsFromKnowledgeSections(settingsSections);
    const sourceMemberships = this.db.all(
      "SELECT character_id, role, note, created_at FROM character_organization_memberships WHERE organization_id = ?",
      sourceOrganizationId
    );

    this.db.transaction(() => {
      this.recordEntityVersion("organization", sourceOrganizationId, "delete", mergeId, `合并至组织“${String(target.name)}”`, timestamp);
      this.db.run(
        "UPDATE organizations SET description = ?, settings_json = ?, settings_sections_json = ?, updated_at = ? WHERE id = ?",
        description,
        JSON.stringify(settings),
        JSON.stringify(settingsSections),
        timestamp,
        targetOrganizationId
      );
      this.syncMarkdownAttachmentReferences(workId, "organization", targetOrganizationId, settingsMarkdownFromList(settings));
      for (const membership of sourceMemberships) {
        this.db.run(
          `INSERT INTO character_organization_memberships (character_id, organization_id, role, note, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(character_id, organization_id) DO NOTHING`,
          requiredString(membership, "character_id"),
          targetOrganizationId,
          requiredString(membership, "role"),
          requiredString(membership, "note"),
          requiredString(membership, "created_at"),
          timestamp
        );
      }
      this.clearMarkdownAttachmentReferences("organization", sourceOrganizationId);
      this.db.run("DELETE FROM organizations WHERE id = ?", sourceOrganizationId);
      this.recordMembershipVersions(memberSnapshots, "organization", targetOrganizationId, `合并组织“${String(source.name)}”`);
      this.recordEntityVersion("organization", targetOrganizationId, "merge", mergeId, `合并组织“${String(source.name)}”`, timestamp);
      this.audit(workId, "organization.merged", "organization", targetOrganizationId, { mergeId, sourceOrganizationId });
    });
    return { mergeId, target: this.getOrganization(targetOrganizationId), source };
  }

  private organizationListBatch(rows: Row[]): OrganizationListBatch {
    const organizationIds = rows.map((row) => requiredString(row, "id"));
    const batch: OrganizationListBatch = {
      members: new Map(),
      versions: this.currentEntityVersionNos("organization", organizationIds)
    };
    for (let offset = 0; offset < organizationIds.length; offset += ENTITY_LIST_BATCH_SIZE) {
      const batchIds = organizationIds.slice(offset, offset + ENTITY_LIST_BATCH_SIZE);
      const placeholders = batchIds.map(() => "?").join(", ");
      const members = this.db.all(
        `SELECT m.organization_id, c.id, c.name, m.role, m.note
         FROM character_organization_memberships m
         JOIN characters c ON c.id = m.character_id
         WHERE m.organization_id IN (${placeholders}) ORDER BY m.organization_id, c.name`,
        ...batchIds
      );
      for (const member of members) {
        const organizationId = requiredString(member, "organization_id");
        const grouped = batch.members.get(organizationId) ?? [];
        grouped.push({
          characterId: requiredString(member, "id"),
          name: requiredString(member, "name"),
          role: requiredString(member, "role"),
          note: requiredString(member, "note")
        });
        batch.members.set(organizationId, grouped);
      }
    }
    return batch;
  }

  private mapOrganization(row: Row, includeMarkdown = true, batch?: OrganizationListBatch): Record<string, unknown> {
    const organizationId = requiredString(row, "id");
    const settingsSections = knowledgeSectionsFromStored(row.settings_sections_json, json<string[]>(requiredString(row, "settings_json"), []));
    const settings = settingsFromKnowledgeSections(settingsSections);
    const members = batch
      ? batch.members.get(organizationId) ?? []
      : this.db.all(
        `SELECT c.id, c.name, m.role, m.note
         FROM character_organization_memberships m
         JOIN characters c ON c.id = m.character_id
         WHERE m.organization_id = ? ORDER BY c.name`,
        organizationId
      ).map((member) => ({
        characterId: requiredString(member, "id"),
        name: requiredString(member, "name"),
        role: requiredString(member, "role"),
        note: requiredString(member, "note")
      }));
    return {
      id: organizationId,
      workId: requiredString(row, "work_id"),
      name: requiredString(row, "name"),
      description: requiredString(row, "description"),
      isDissolved: booleanValue(row, "is_dissolved"),
      isFavorite: this.mapEntityFavorite(row),
      isPinned: this.mapEntityPin(row),
      ...(includeMarkdown
        ? { settings, settingsMarkdown: settingsMarkdownFromList(settings), settingsSections }
        : { settings: [], settingsCount: settingsSections.length }),
      memberIds: members.map((member) => member.characterId),
      members,
      versionNo: batch ? batch.versions.get(organizationId) ?? 0 : this.currentEntityVersionNo("organization", organizationId),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at")
    };
  }

  private assertOrganizationNameAvailable(workId: string, normalizedName: string, excludeOrganizationId?: string): void {
    const row = this.db.get(
      `SELECT id FROM organizations WHERE work_id = ? AND normalized_name = ?${excludeOrganizationId ? " AND id <> ?" : ""}`,
      ...([workId, normalizedName, ...(excludeOrganizationId ? [excludeOrganizationId] : [])])
    );
    if (row) throw new AppError(409, "ORGANIZATION_NAME_CONFLICT", "同一作品内的组织名称不能重复", { organizationId: requiredString(row, "id") });
  }

  private assertCharactersInWork(workId: string, characterIds: string[]): void {
    for (const characterId of characterIds) {
      const character = this.getCharacter(characterId);
      if (character.workId !== workId) throw new AppError(400, "CHARACTER_WORK_MISMATCH", "组织成员不属于当前作品");
      if (character.mergedIntoCharacterId) throw new AppError(409, "CHARACTER_ALREADY_MERGED", "已合并角色不能继续被引用");
    }
  }

  private assertOrganizationsInWork(workId: string, organizationIds: string[]): void {
    for (const organizationId of organizationIds) {
      const organization = this.getOrganization(organizationId);
      if (organization.workId !== workId) throw new AppError(400, "ORGANIZATION_WORK_MISMATCH", "角色绑定的组织不属于当前作品");
    }
  }

  private replaceOrganizationMembers(organizationId: string, memberIds: string[]): void {
    const timestamp = now();
    this.db.run("DELETE FROM character_organization_memberships WHERE organization_id = ?", organizationId);
    for (const characterId of memberIds) {
      this.db.run(
        `INSERT INTO character_organization_memberships (character_id, organization_id, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
        characterId,
        organizationId,
        timestamp,
        timestamp
      );
    }
  }

  private replaceCharacterOrganizations(characterId: string, organizationIds: string[]): void {
    const timestamp = now();
    this.db.run("DELETE FROM character_organization_memberships WHERE character_id = ?", characterId);
    for (const organizationId of organizationIds) {
      this.db.run(
        `INSERT INTO character_organization_memberships (character_id, organization_id, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
        characterId,
        organizationId,
        timestamp,
        timestamp
      );
    }
  }

  private characterSnapshot(character: Record<string, unknown>): CharacterSnapshot {
    const profile = { ...(character.profile as Record<string, unknown>) };
    delete profile.sections;
    return {
      name: String(character.name),
      gender: characterGender(character.gender),
      isDead: Boolean(character.isDead),
      code: String(character.code),
      aliases: [...(character.aliases as string[])],
      raceId: character.raceId as string | null,
      species: String(character.species),
      organizationIds: [...(character.organizationIds as string[])].sort(),
      attributes: character.attributes as Record<string, unknown>,
      profile,
      currentState: character.currentState as Record<string, unknown>,
      lockedFields: [...(character.lockedFields as string[])],
      firstChapterId: character.firstChapterId as string | null
    };
  }

  private captureCharacterSnapshots(characterIds: string[]): Map<string, CharacterSnapshot> {
    return new Map(characterIds.map((characterId) => [characterId, this.characterSnapshot(this.getCharacter(characterId))]));
  }

  private snapshotsEqual(left: CharacterSnapshot, right: CharacterSnapshot): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  private insertCharacterVersion(
    characterId: string,
    versionNo: number,
    source: string,
    sourceRef: string | null,
    changeNote: string,
    timestamp = now(),
    workId?: string
  ): void {
    const character = this.getCharacter(characterId);
    const snapshot = this.characterSnapshot(character);
    this.db.run(
      `INSERT INTO character_versions (id, work_id, character_id, version_no, snapshot_json, source, source_ref, change_note, created_at, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id("characterVersion"),
      workId ?? String(character.workId),
      characterId,
      versionNo,
      JSON.stringify(snapshot),
      source,
      sourceRef,
      changeNote.trim(),
      timestamp,
      currentRequestActor()?.userId ?? null
    );
  }

  private recordMembershipVersions(
    snapshots: Map<string, CharacterSnapshot>,
    source: string,
    sourceRef: string,
    changeNote: string
  ): void {
    for (const [characterId, before] of snapshots) {
      const current = this.getCharacter(characterId);
      if (this.snapshotsEqual(before, this.characterSnapshot(current))) continue;
      const versionNo = Number(current.versionNo) + 1;
      const timestamp = now();
      this.db.run("UPDATE characters SET version_no = ?, updated_at = ? WHERE id = ?", versionNo, timestamp, characterId);
      this.insertCharacterVersion(characterId, versionNo, source, sourceRef, changeNote, timestamp);
      this.audit(String(current.workId), "character.versioned", "character", characterId, { versionNo, source, sourceRef });
    }
  }

  createCharacter(
    workId: string,
    input: CharacterInput,
    source = "create",
    sourceRef: string | null = null,
    changeNote = "建立人物档案"
  ): Record<string, unknown> {
    this.getWork(workId);
    const characterId = id("character");
    const timestamp = now();
    const names = this.prepareCharacterNames(input.name, input.aliases ?? []);
    const legacySpecies = typeof input.attributes?.species === "string" ? input.attributes.species.trim() : "";
    const candidateSpecies = input.species?.trim() || legacySpecies;
    const raceId = input.raceId === undefined ? (candidateSpecies ? this.resolveRaceReference(workId, candidateSpecies) : null) : input.raceId;
    const race = raceId ? this.assertRaceInWork(workId, raceId) : null;
    const species = race ? String(race.name) : "";
    this.assertCharacterNamesAvailable(workId, names.entries);
    if (input.firstChapterId) this.assertChapterInWork(input.firstChapterId, workId);
    const organizationIds = [...new Set(input.organizationIds ?? [])];
    this.assertOrganizationsInWork(workId, organizationIds);
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO characters (id, work_id, name, code, gender, aliases_json, species, race_id, attributes_json, profile_json, current_state_json,
         is_dead, locked_fields_json, first_chapter_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        characterId,
        workId,
        names.name,
        input.code?.trim() ?? "",
        input.gender ?? "unknown",
        JSON.stringify(names.aliases),
        species,
        raceId,
        JSON.stringify(input.attributes ?? {}),
        JSON.stringify(input.profile ?? {}),
        JSON.stringify(input.currentState ?? {}),
        input.isDead ? 1 : 0,
        JSON.stringify(input.lockedFields ?? []),
        input.firstChapterId ?? null,
        timestamp,
        timestamp
      );
      this.insertCharacterNames(workId, characterId, names.entries);
      this.replaceCharacterOrganizations(characterId, organizationIds);
      this.insertCharacterVersion(characterId, 1, source, sourceRef, changeNote, timestamp);
      this.audit(workId, "character.created", "character", characterId, { source, sourceRef });
    });
    return this.getCharacter(characterId);
  }

  listCharacters(workId: string, includeProfileSections = false, includeMerged = false, includeRaceMarkdown = true): Record<string, unknown>[] {
    this.getWork(workId);
    const preferences = this.entityPreferenceProjection("character", "character");
    return this.db.all(
      `SELECT character.*, ${preferences.columns} FROM characters character WHERE character.work_id = ?${includeMerged ? "" : " AND character.merged_into_character_id IS NULL"} ORDER BY ${preferences.orderBy}, character.name`,
      ...preferences.params,
      workId
    )
      .map((row) => this.mapCharacter(row, includeProfileSections, includeRaceMarkdown));
  }

  listCharactersPage(workId: string, pagination: Pagination, includeProfileSections = false, includeMerged = false, includeRaceMarkdown = true): PaginatedResult<Record<string, unknown>> {
    this.getWork(workId);
    const preferences = this.entityPreferenceProjection("character", "character");
    const page = paginationSql(pagination);
    const count = this.db.get(
      `SELECT COUNT(*) AS count FROM characters WHERE work_id = ?${includeMerged ? "" : " AND merged_into_character_id IS NULL"}`,
      workId
    );
    const rows = this.db.all(
      `SELECT character.*, ${preferences.columns} FROM characters character WHERE character.work_id = ?${includeMerged ? "" : " AND character.merged_into_character_id IS NULL"} ORDER BY ${preferences.orderBy}, character.name${page.sql}`,
      ...preferences.params,
      workId,
      ...page.params
    );
    return paginated(rows.map((row) => this.mapCharacter(row, includeProfileSections, includeRaceMarkdown)), pagination, Number(count?.count ?? 0));
  }

  private mapCharacterProfileSection(row: Row): Record<string, unknown> {
    return {
      id: requiredString(row, "id"),
      workId: requiredString(row, "work_id"),
      characterId: requiredString(row, "character_id"),
      sectionType: requiredString(row, "section_type"),
      title: requiredString(row, "title"),
      contentMarkdown: requiredString(row, "content_markdown"),
      summary: requiredString(row, "summary"),
      sortOrder: numberValue(row, "sort_order"),
      sourcePath: optionalString(row, "source_path"),
      sourceHash: optionalString(row, "source_hash"),
      versionNo: numberValue(row, "version_no"),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at")
    };
  }

  listCharacterProfileSections(characterId: string): Record<string, unknown>[] {
    this.getCharacter(characterId);
    return this.db.all(
      "SELECT * FROM character_profile_sections WHERE character_id = ? ORDER BY sort_order, created_at",
      characterId
    ).map((row) => this.mapCharacterProfileSection(row));
  }

  listCharacterProfileSectionsPage(characterId: string, pagination: Pagination): PaginatedResult<Record<string, unknown>> {
    this.getCharacter(characterId);
    const page = paginationSql(pagination);
    const rows = this.db.all(
      `SELECT * FROM character_profile_sections WHERE character_id = ? ORDER BY sort_order, created_at${page.sql}`,
      characterId,
      ...page.params
    );
    return paginated(rows.map((row) => this.mapCharacterProfileSection(row)), pagination);
  }

  listCharacterProfileSectionCatalog(characterId: string): Record<string, unknown>[] {
    this.getCharacter(characterId);
    return this.db.all(
      `SELECT id, character_id, section_type, title, summary, sort_order, version_no
       FROM character_profile_sections WHERE character_id = ? ORDER BY sort_order, created_at`,
      characterId
    ).map((row) => ({
      id: requiredString(row, "id"),
      characterId: requiredString(row, "character_id"),
      sectionType: requiredString(row, "section_type"),
      title: requiredString(row, "title"),
      summary: requiredString(row, "summary"),
      sortOrder: numberValue(row, "sort_order"),
      versionNo: numberValue(row, "version_no")
    }));
  }

  getCharacterProfileSection(sectionId: string): Record<string, unknown> {
    const row = this.db.get("SELECT * FROM character_profile_sections WHERE id = ?", sectionId);
    if (!row) throw notFound("人物档案章节");
    return this.mapCharacterProfileSection(row);
  }

  private characterProfileSectionSnapshot(section: Record<string, unknown>): Record<string, unknown> {
    return {
      sectionType: String(section.sectionType),
      title: String(section.title),
      contentMarkdown: String(section.contentMarkdown),
      summary: String(section.summary),
      sortOrder: Number(section.sortOrder),
      sourcePath: section.sourcePath ?? null,
      sourceHash: section.sourceHash ?? null
    };
  }

  private recordCharacterProfileSectionVersion(
    section: Record<string, unknown>,
    source: string,
    sourceRef: string | null,
    changeNote: string,
    timestamp = now()
  ): void {
    this.db.run(
      `INSERT INTO character_profile_section_versions
       (id, work_id, character_id, section_id, version_no, snapshot_json, source, source_ref, change_note, created_at, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id("characterSectionVersion"),
      String(section.workId),
      String(section.characterId),
      String(section.id),
      Number(section.versionNo),
      JSON.stringify(this.characterProfileSectionSnapshot(section)),
      source,
      sourceRef,
      changeNote.trim(),
      timestamp,
      currentRequestActor()?.userId ?? null
    );
  }

  private syncCharacterProfileSectionSearch(section: Record<string, unknown>): void {
    const searchContent = normalizeDocumentSearchText(
      `${String(section.title)}\n${String(section.summary)}\n${String(section.contentMarkdown)}`
    );
    this.db.run(
      `INSERT INTO character_profile_section_search (work_id, character_id, section_id, search_content)
       VALUES (?, ?, ?, ?) ON CONFLICT(section_id) DO UPDATE SET search_content = excluded.search_content`,
      String(section.workId),
      String(section.characterId),
      String(section.id),
      searchContent
    );
    const search = this.db.get("SELECT id FROM character_profile_section_search WHERE section_id = ?", String(section.id));
    const searchId = numberValue(search ?? {}, "id");
    this.db.run("DELETE FROM character_profile_section_short_terms WHERE search_id = ?", searchId);
    for (const term of documentShortSearchTerms(searchContent)) {
      this.db.run("INSERT INTO character_profile_section_short_terms (search_id, term) VALUES (?, ?)", searchId, term);
    }
  }

  private attachmentIdsInMarkdown(contentMarkdown: string): string[] {
    return [...new Set([...contentMarkdown.matchAll(/attachment:\/\/([A-Za-z0-9_-]{1,300})/gu)].map((match) => String(match[1])))];
  }

  private syncMarkdownAttachmentReferences(workId: string, entityType: string, entityId: string, contentMarkdown: string): void {
    const attachmentIds = this.attachmentIdsInMarkdown(contentMarkdown);
    for (const attachmentId of attachmentIds) {
      const attachment = this.getAttachment(attachmentId);
      if (attachment.workId !== workId) throw new AppError(400, "ATTACHMENT_WORK_MISMATCH", "附件不属于当前作品");
    }
    this.db.run("DELETE FROM attachment_references WHERE entity_type = ? AND entity_id = ?", entityType, entityId);
    for (const attachmentId of attachmentIds) {
      this.db.run(
        `INSERT INTO attachment_references (attachment_id, work_id, entity_type, entity_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        attachmentId,
        workId,
        entityType,
        entityId,
        now()
      );
    }
  }

  private clearMarkdownAttachmentReferences(entityType: string, entityId: string): void {
    this.db.run("DELETE FROM attachment_references WHERE entity_type = ? AND entity_id = ?", entityType, entityId);
  }

  private syncCharacterProfileSectionAttachments(section: Record<string, unknown>): void {
    const sectionId = String(section.id);
    const workId = String(section.workId);
    this.syncMarkdownAttachmentReferences(workId, "character-section", sectionId, String(section.contentMarkdown));
  }

  createCharacterProfileSection(
    characterId: string,
    input: CharacterProfileSectionInput,
    source = "create",
    sourceRef: string | null = null
  ): Record<string, unknown> {
    const character = this.getCharacter(characterId);
    const sectionId = id("characterSection");
    const timestamp = now();
    const sortOrder = input.sortOrder ?? Number(this.db.get(
      "SELECT COALESCE(MAX(sort_order), -1) + 1 AS sort_order FROM character_profile_sections WHERE character_id = ?",
      characterId
    )?.sort_order ?? 0);
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO character_profile_sections
         (id, work_id, character_id, section_type, title, content_markdown, summary, sort_order, source_path, source_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        sectionId,
        String(character.workId),
        characterId,
        input.sectionType ?? "custom",
        input.title,
        input.contentMarkdown ?? "",
        input.summary ?? "",
        sortOrder,
        input.sourcePath ?? null,
        input.sourceHash ?? null,
        timestamp,
        timestamp
      );
      const section = this.getCharacterProfileSection(sectionId);
      this.syncCharacterProfileSectionSearch(section);
      this.syncCharacterProfileSectionAttachments(section);
      this.recordCharacterProfileSectionVersion(section, source, sourceRef, "建立人物 Markdown 章节", timestamp);
      this.audit(String(character.workId), "character-section.created", "character-section", sectionId, { characterId, source, sourceRef });
    });
    return this.getCharacterProfileSection(sectionId);
  }

  updateCharacterProfileSection(
    sectionId: string,
    input: Partial<CharacterProfileSectionInput>,
    source = "manual",
    sourceRef: string | null = null,
    changeNote = "",
    expectedVersionNo?: number
  ): Record<string, unknown> {
    const current = this.getCharacterProfileSection(sectionId);
    this.assertExpectedRevision("character-section", sectionId, expectedVersionNo, "人物档案章节", Number(current.versionNo));
    const timestamp = now();
    this.db.transaction(() => {
      const lockedCurrent = this.getCharacterProfileSection(sectionId);
      this.assertExpectedRevision("character-section", sectionId, expectedVersionNo, "人物档案章节", Number(lockedCurrent.versionNo));
      this.db.run(
        `UPDATE character_profile_sections SET section_type = ?, title = ?, content_markdown = ?, summary = ?, sort_order = ?,
         source_path = ?, source_hash = ?, version_no = version_no + 1, updated_at = ? WHERE id = ?`,
        input.sectionType ?? String(current.sectionType),
        input.title ?? String(current.title),
        input.contentMarkdown ?? String(current.contentMarkdown),
        input.summary ?? String(current.summary),
        input.sortOrder ?? Number(current.sortOrder),
        input.sourcePath === undefined ? current.sourcePath as string | null : input.sourcePath,
        input.sourceHash === undefined ? current.sourceHash as string | null : input.sourceHash,
        timestamp,
        sectionId
      );
      const section = this.getCharacterProfileSection(sectionId);
      this.syncCharacterProfileSectionSearch(section);
      this.syncCharacterProfileSectionAttachments(section);
      this.recordCharacterProfileSectionVersion(section, source, sourceRef, changeNote || "更新人物 Markdown 章节", timestamp);
      this.audit(String(current.workId), "character-section.updated", "character-section", sectionId, { fields: Object.keys(input), source, sourceRef });
    });
    return this.getCharacterProfileSection(sectionId);
  }

  deleteCharacterProfileSection(sectionId: string, expectedVersionNo?: number): void {
    const current = this.getCharacterProfileSection(sectionId);
    this.assertExpectedRevision("character-section", sectionId, expectedVersionNo, "人物档案章节", Number(current.versionNo));
    this.db.transaction(() => {
      const lockedCurrent = this.getCharacterProfileSection(sectionId);
      this.assertExpectedRevision("character-section", sectionId, expectedVersionNo, "人物档案章节", Number(lockedCurrent.versionNo));
      this.db.run("UPDATE character_profile_sections SET version_no = version_no + 1 WHERE id = ?", sectionId);
      const deleting = this.getCharacterProfileSection(sectionId);
      this.recordCharacterProfileSectionVersion(deleting, "delete", null, "删除人物 Markdown 章节");
      this.db.run("DELETE FROM attachment_references WHERE entity_type = 'character-section' AND entity_id = ?", sectionId);
      this.db.run("DELETE FROM character_profile_sections WHERE id = ?", sectionId);
      this.audit(String(current.workId), "character-section.deleted", "character-section", sectionId, { characterId: current.characterId });
    });
  }

  listCharacterProfileSectionVersions(sectionId: string): Record<string, unknown>[] {
    const rows = this.db.all(
      `SELECT version.*, user.display_name AS actor_display_name, user.username AS actor_username
       FROM character_profile_section_versions version LEFT JOIN users user ON user.id = version.created_by_user_id
       WHERE version.section_id = ? ORDER BY version.version_no DESC`,
      sectionId
    );
    if (!rows.length) this.getCharacterProfileSection(sectionId);
    return rows.map((row) => ({
      id: requiredString(row, "id"),
      workId: requiredString(row, "work_id"),
      characterId: requiredString(row, "character_id"),
      sectionId: requiredString(row, "section_id"),
      versionNo: numberValue(row, "version_no"),
      snapshot: json(requiredString(row, "snapshot_json"), {}),
      source: requiredString(row, "source"),
      sourceRef: optionalString(row, "source_ref"),
      changeNote: requiredString(row, "change_note"),
      createdAt: requiredString(row, "created_at"),
      actor: optionalString(row, "actor_display_name") ?? optionalString(row, "actor_username") ?? "历史数据"
    }));
  }

  listCharacterProfileSectionVersionsPage(sectionId: string, pagination: Pagination): PaginatedResult<Record<string, unknown>> {
    const page = paginationSql(pagination);
    const rows = this.db.all(
      `SELECT version.*, user.display_name AS actor_display_name, user.username AS actor_username
       FROM character_profile_section_versions version LEFT JOIN users user ON user.id = version.created_by_user_id
       WHERE version.section_id = ? ORDER BY version.version_no DESC${page.sql}`,
      sectionId,
      ...page.params
    );
    if (!rows.length && pagination.page === 1) this.getCharacterProfileSection(sectionId);
    return paginated(rows.map((row) => ({
      id: requiredString(row, "id"),
      workId: requiredString(row, "work_id"),
      characterId: requiredString(row, "character_id"),
      sectionId: requiredString(row, "section_id"),
      versionNo: numberValue(row, "version_no"),
      snapshot: json(requiredString(row, "snapshot_json"), {}),
      source: requiredString(row, "source"),
      sourceRef: optionalString(row, "source_ref"),
      changeNote: requiredString(row, "change_note"),
      createdAt: requiredString(row, "created_at"),
      actor: optionalString(row, "actor_display_name") ?? optionalString(row, "actor_username") ?? "历史数据"
    })), pagination);
  }

  restoreCharacterProfileSection(sectionId: string, versionNo: number, expectedVersionNo?: number): Record<string, unknown> {
    const version = this.db.get(
      "SELECT * FROM character_profile_section_versions WHERE section_id = ? AND version_no = ?",
      sectionId,
      versionNo
    );
    if (!version) throw notFound("人物档案章节版本");
    const snapshot = json<Record<string, unknown>>(requiredString(version, "snapshot_json"), {});
    const existing = this.db.get("SELECT id FROM character_profile_sections WHERE id = ?", sectionId);
    if (existing) {
      return this.updateCharacterProfileSection(sectionId, snapshot as Partial<CharacterProfileSectionInput>, "restore", requiredString(version, "id"), `恢复至 v${versionNo}`, expectedVersionNo);
    }
    this.assertExpectedRevision("character-section", sectionId, expectedVersionNo, "人物档案章节", this.currentCharacterSectionVersionNo(sectionId));
    const characterId = requiredString(version, "character_id");
    const character = this.getCharacter(characterId);
    const timestamp = now();
    const nextVersionNo = Number(this.db.get(
      "SELECT COALESCE(MAX(version_no), 0) + 1 AS version_no FROM character_profile_section_versions WHERE section_id = ?",
      sectionId
    )?.version_no ?? 1);
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO character_profile_sections
         (id, work_id, character_id, section_type, title, content_markdown, summary, sort_order, source_path, source_hash, version_no, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        sectionId,
        String(character.workId),
        characterId,
        String(snapshot.sectionType ?? "custom"),
        String(snapshot.title ?? "恢复的章节"),
        String(snapshot.contentMarkdown ?? ""),
        String(snapshot.summary ?? ""),
        Number(snapshot.sortOrder ?? 0),
        snapshot.sourcePath as string | null ?? null,
        snapshot.sourceHash as string | null ?? null,
        nextVersionNo,
        timestamp,
        timestamp
      );
      const restored = this.getCharacterProfileSection(sectionId);
      this.syncCharacterProfileSectionSearch(restored);
      this.syncCharacterProfileSectionAttachments(restored);
      this.recordCharacterProfileSectionVersion(restored, "restore", requiredString(version, "id"), `恢复至 v${versionNo}`, timestamp);
      this.audit(String(character.workId), "character-section.restored", "character-section", sectionId, { versionNo });
    });
    return this.getCharacterProfileSection(sectionId);
  }

  searchCharacterProfileSections(workId: string, query: string, limit = 20): Record<string, unknown>[] {
    this.getWork(workId);
    const normalized = normalizeDocumentSearchText(query);
    const columns = `SELECT section.*, character.name AS character_name, character.gender AS character_gender,
                            character.is_dead AS character_is_dead
      FROM character_profile_section_search search
      JOIN character_profile_sections section ON section.id = search.section_id
      JOIN characters character ON character.id = search.character_id`;
    const rows = [...normalized].length <= 2
      ? this.db.all(
        `${columns} JOIN character_profile_section_short_terms term ON term.search_id = search.id
         WHERE search.work_id = ? AND character.merged_into_character_id IS NULL AND term.term = ?
         ORDER BY character.name, section.sort_order LIMIT ?`,
        workId,
        normalized,
        limit
      )
      : this.db.all(
        `${columns} JOIN character_profile_section_search_fts fts ON fts.rowid = search.id
         WHERE search.work_id = ? AND character.merged_into_character_id IS NULL
           AND character_profile_section_search_fts MATCH ?
         ORDER BY bm25(character_profile_section_search_fts), character.name, section.sort_order LIMIT ?`,
        workId,
        `"${normalized.replaceAll('"', '""')}"`,
        limit
      );
    return rows.map((row) => ({
      ...this.mapCharacterProfileSection(row),
      characterName: requiredString(row, "character_name"),
      gender: requiredString(row, "character_gender"),
      isDead: booleanValue(row, "character_is_dead")
    }));
  }

  private mapAttachment(row: Row): Record<string, unknown> {
    const attachmentId = requiredString(row, "id");
    return {
      id: attachmentId,
      workId: requiredString(row, "work_id"),
      originalName: requiredString(row, "original_name"),
      originalMimeType: requiredString(row, "original_mime_type"),
      storedMimeType: requiredString(row, "stored_mime_type"),
      originalByteLength: numberValue(row, "original_byte_length"),
      storedByteLength: numberValue(row, "stored_byte_length"),
      originalSha256: requiredString(row, "original_sha256"),
      storedSha256: requiredString(row, "stored_sha256"),
      storageKey: requiredString(row, "storage_key"),
      width: numberValue(row, "width"),
      height: numberValue(row, "height"),
      pageCount: numberValue(row, "page_count"),
      animated: booleanValue(row, "animated"),
      contentUrl: `/api/attachments/${encodeURIComponent(attachmentId)}/content`,
      createdAt: requiredString(row, "created_at")
    };
  }

  createAttachment(workId: string, input: AttachmentInput, accessModule: AttachmentPermissionModule = "settings"): { attachment: Record<string, unknown>; created: boolean } {
    this.getWork(workId);
    const existing = this.db.get("SELECT * FROM attachments WHERE work_id = ? AND stored_sha256 = ?", workId, input.storedSha256);
    if (existing) {
      this.db.transaction(() => {
        this.db.run(
          "INSERT OR IGNORE INTO attachment_access_modules (attachment_id, module, created_at) VALUES (?, ?, ?)",
          requiredString(existing, "id"),
          accessModule,
          now()
        );
        this.db.run("DELETE FROM attachment_cleanup_queue WHERE storage_key = ?", requiredString(existing, "storage_key"));
      });
      return { attachment: this.mapAttachment(existing), created: false };
    }
    const attachmentId = id("attachment");
    const timestamp = now();
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO attachments
         (id, work_id, original_name, original_mime_type, stored_mime_type, original_byte_length, stored_byte_length,
          original_sha256, stored_sha256, storage_key, width, height, page_count, animated, created_at, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        attachmentId,
        workId,
        input.originalName,
        input.originalMimeType,
        input.storedMimeType,
        input.originalByteLength,
        input.storedByteLength,
        input.originalSha256,
        input.storedSha256,
        input.storageKey,
        input.width,
        input.height,
        input.pageCount,
        input.animated ? 1 : 0,
        timestamp,
        currentRequestActor()?.userId ?? null
      );
      this.db.run(
        "INSERT INTO attachment_access_modules (attachment_id, module, created_at) VALUES (?, ?, ?)",
        attachmentId,
        accessModule,
        timestamp
      );
      this.db.run("DELETE FROM attachment_cleanup_queue WHERE storage_key = ?", input.storageKey);
      this.audit(workId, "attachment.created", "attachment", attachmentId, {
        originalMimeType: input.originalMimeType,
        storedMimeType: input.storedMimeType,
        originalByteLength: input.originalByteLength,
        storedByteLength: input.storedByteLength,
        animated: input.animated
      });
    });
    return { attachment: this.getAttachment(attachmentId), created: true };
  }

  listAttachments(workId: string): Record<string, unknown>[] {
    this.getWork(workId);
    return this.db.all("SELECT * FROM attachments WHERE work_id = ? ORDER BY created_at DESC", workId).map((row) => this.mapAttachment(row));
  }

  listAttachmentsPage(workId: string, pagination: Pagination): PaginatedResult<Record<string, unknown>> {
    this.getWork(workId);
    const page = paginationSql(pagination);
    const rows = this.db.all(`SELECT * FROM attachments WHERE work_id = ? ORDER BY created_at DESC${page.sql}`, workId, ...page.params);
    return paginated(rows.map((row) => this.mapAttachment(row)), pagination);
  }

  getAttachment(attachmentId: string): Record<string, unknown> {
    const row = this.db.get("SELECT * FROM attachments WHERE id = ?", attachmentId);
    if (!row) throw notFound("附件");
    return this.mapAttachment(row);
  }

  getAttachmentDownloadContextName(attachmentId: string): string | null {
    const reference = this.db.get<{ context_name?: unknown }>(
      `SELECT CASE reference.entity_type
         WHEN 'setting' THEN (SELECT title FROM settings WHERE id = reference.entity_id AND work_id = reference.work_id)
         WHEN 'character-section' THEN (
           SELECT character.name
           FROM character_profile_sections section
           JOIN characters character ON character.id = section.character_id
           WHERE section.id = reference.entity_id AND section.work_id = reference.work_id
         )
         WHEN 'race' THEN (SELECT name FROM races WHERE id = reference.entity_id AND work_id = reference.work_id)
         WHEN 'organization' THEN (SELECT name FROM organizations WHERE id = reference.entity_id AND work_id = reference.work_id)
         WHEN 'chapter' THEN (SELECT title FROM chapters WHERE id = reference.entity_id AND work_id = reference.work_id)
         WHEN 'draft' THEN (SELECT title FROM drafts WHERE id = reference.entity_id AND work_id = reference.work_id)
         ELSE NULL
       END AS context_name
       FROM attachment_references reference
       WHERE reference.attachment_id = ?
       ORDER BY CASE reference.entity_type
         WHEN 'setting' THEN 0
         WHEN 'character-section' THEN 1
         WHEN 'race' THEN 2
         WHEN 'organization' THEN 3
         WHEN 'chapter' THEN 4
         WHEN 'draft' THEN 5
         ELSE 6
       END, reference.created_at DESC, reference.entity_id
       LIMIT 1`,
      attachmentId
    );
    const contextName = optionalString(reference ?? {}, "context_name")?.trim();
    if (contextName) return contextName;

    const access = this.db.get<{ module?: unknown }>(
      "SELECT module FROM attachment_access_modules WHERE attachment_id = ? ORDER BY module LIMIT 1",
      attachmentId
    );
    const moduleLabels: Record<string, string> = {
      settings: "设定库",
      characters: "角色",
      races: "种族",
      organizations: "组织",
      drafts: "想法",
      prose: "正文",
      "ai-chat": "AI对话"
    };
    return moduleLabels[String(access?.module ?? "")] ?? null;
  }

  getSettingAttachment(workId: string, attachmentId: string): Record<string, unknown> {
    const row = this.db.get(
      `SELECT attachment.*
       FROM attachments attachment
       JOIN attachment_references reference ON reference.attachment_id = attachment.id
       WHERE attachment.id = ? AND attachment.work_id = ? AND reference.work_id = ?
         AND (
           (reference.entity_type = 'setting' AND EXISTS (
             SELECT 1 FROM settings current_setting
             WHERE current_setting.id = reference.entity_id AND current_setting.work_id = reference.work_id
           ))
           OR (reference.entity_type = 'character-section' AND EXISTS (
             SELECT 1
             FROM character_profile_sections current_section
             JOIN characters current_character ON current_character.id = current_section.character_id
             WHERE current_section.id = reference.entity_id
               AND current_section.work_id = reference.work_id
               AND current_character.work_id = reference.work_id
           ))
           OR (reference.entity_type = 'race' AND EXISTS (
             SELECT 1 FROM races current_race
             WHERE current_race.id = reference.entity_id AND current_race.work_id = reference.work_id
           ))
           OR (reference.entity_type = 'organization' AND EXISTS (
             SELECT 1 FROM organizations current_organization
             WHERE current_organization.id = reference.entity_id AND current_organization.work_id = reference.work_id
           ))
         )
       LIMIT 1`,
      attachmentId,
      workId,
      workId
    );
    if (!row) throw new AppError(404, "SETTING_IMAGE_ATTACHMENT_NOT_FOUND", "图片附件不存在或未被生效设定库当前文档引用");
    return this.mapAttachment(row);
  }

  attachmentModules(attachmentId: string): AttachmentPermissionModule[] {
    this.getAttachment(attachmentId);
    const modules = new Set<AttachmentPermissionModule>();
    for (const row of this.db.all("SELECT module FROM attachment_access_modules WHERE attachment_id = ?", attachmentId)) {
      const module = String(row.module);
      if ((attachmentPermissionModules as readonly string[]).includes(module)) modules.add(module as AttachmentPermissionModule);
    }
    const referenceModules: Record<string, AttachmentPermissionModule> = {
      chapter: "prose",
      draft: "drafts",
      setting: "settings",
      "character-section": "characters",
      race: "races",
      organization: "organizations"
    };
    for (const row of this.db.all("SELECT DISTINCT entity_type FROM attachment_references WHERE attachment_id = ?", attachmentId)) {
      const module = referenceModules[String(row.entity_type)];
      if (module) modules.add(module);
    }
    return [...modules];
  }

  private attachmentStorageKeyInUse(storageKey: string): boolean {
    return Number(this.db.get("SELECT COUNT(*) AS count FROM attachments WHERE storage_key = ?", storageKey)?.count ?? 0) > 0;
  }

  private enqueueAttachmentCleanup(storageKey: string): void {
    const timestamp = now();
    this.db.run(
      `INSERT INTO attachment_cleanup_queue (storage_key, attempts, last_error, created_at, updated_at)
       VALUES (?, 0, NULL, ?, ?) ON CONFLICT(storage_key) DO UPDATE SET updated_at = excluded.updated_at`,
      storageKey,
      timestamp,
      timestamp
    );
  }

  listAttachmentCleanupQueue(limit = 100): Array<{ storageKey: string; attempts: number }> {
    return this.db.all(
      "SELECT storage_key, attempts FROM attachment_cleanup_queue ORDER BY updated_at, storage_key LIMIT ?",
      Math.max(1, Math.min(1_000, Math.trunc(limit)))
    ).map((row) => ({ storageKey: requiredString(row, "storage_key"), attempts: numberValue(row, "attempts") }));
  }

  attachmentCleanupStillRequired(storageKey: string): boolean {
    return !this.attachmentStorageKeyInUse(storageKey);
  }

  completeAttachmentCleanup(storageKey: string): void {
    this.db.run("DELETE FROM attachment_cleanup_queue WHERE storage_key = ?", storageKey);
  }

  failAttachmentCleanup(storageKey: string, message: string): void {
    this.db.run(
      "UPDATE attachment_cleanup_queue SET attempts = attempts + 1, last_error = ?, updated_at = ? WHERE storage_key = ?",
      message.slice(0, 500),
      now(),
      storageKey
    );
  }

  private attachmentHistoricalReferenceCount(attachmentId: string): number {
    const needle = `attachment://${attachmentId}`;
    const sources = [
      ["entity_versions", "snapshot_json"],
      ["character_profile_section_versions", "snapshot_json"],
      ["character_versions", "snapshot_json"],
      ["chapter_versions", "content"],
      ["file_versions", "snapshot_json"]
    ] as const;
    const historicalCount = sources.reduce((count, [table, column]) => count + Number(
      this.db.get(`SELECT COUNT(*) AS count FROM ${table} WHERE instr(${column}, ?) > 0`, needle)?.count ?? 0
    ), 0);
    const conversationCount = Number(
      this.db.get(
        "SELECT COUNT(*) AS count FROM ai_conversation_messages WHERE instr(metadata_json, ?) > 0",
        attachmentId
      )?.count ?? 0
    );
    return historicalCount + conversationCount;
  }

  queueUnreferencedAttachments(retentionMs = 24 * 60 * 60_000, limit = 100): number {
    const cutoff = new Date(Date.now() - Math.max(0, retentionMs)).toISOString();
    const candidates = this.db.all(
      `SELECT attachment.* FROM attachments attachment
       WHERE attachment.created_at <= ?
         AND NOT EXISTS (
           SELECT 1 FROM attachment_references reference WHERE reference.attachment_id = attachment.id
         )
       ORDER BY attachment.created_at, attachment.id LIMIT ?`,
      cutoff,
      Math.max(1, Math.min(1_000, Math.trunc(limit)))
    );
    let queued = 0;
    for (const candidate of candidates) {
      const attachmentId = requiredString(candidate, "id");
      if (this.attachmentHistoricalReferenceCount(attachmentId) > 0) continue;
      const storageKey = requiredString(candidate, "storage_key");
      this.db.transaction(() => {
        this.db.run("DELETE FROM attachments WHERE id = ?", attachmentId);
        this.audit(requiredString(candidate, "work_id"), "attachment.garbage-collected", "attachment", attachmentId, { storageKey });
        if (!this.attachmentStorageKeyInUse(storageKey)) this.enqueueAttachmentCleanup(storageKey);
      });
      queued += 1;
    }
    return queued;
  }

  deleteAttachment(attachmentId: string): { storageKey: string; cleanupQueued: boolean } {
    const attachment = this.getAttachment(attachmentId);
    const references = Number(this.db.get("SELECT COUNT(*) AS count FROM attachment_references WHERE attachment_id = ?", attachmentId)?.count ?? 0);
    if (references > 0) throw new AppError(409, "ATTACHMENT_IN_USE", "附件仍被资料引用，无法删除");
    if (this.attachmentHistoricalReferenceCount(attachmentId) > 0) {
      throw new AppError(409, "ATTACHMENT_IN_VERSION_HISTORY", "附件仍被历史版本引用，无法删除");
    }
    const storageKey = String(attachment.storageKey);
    this.db.transaction(() => {
      this.db.run("DELETE FROM attachments WHERE id = ?", attachmentId);
      this.audit(String(attachment.workId), "attachment.deleted", "attachment", attachmentId, { storageKey });
      if (!this.attachmentStorageKeyInUse(storageKey)) this.enqueueAttachmentCleanup(storageKey);
    });
    return { storageKey, cleanupQueued: !this.attachmentStorageKeyInUse(storageKey) };
  }

  getCharacter(characterId: string): Record<string, unknown> {
    const preferences = this.entityPreferenceProjection("character", "character");
    const row = this.db.get(`SELECT character.*, ${preferences.columns} FROM characters character WHERE character.id = ?`, ...preferences.params, characterId);
    if (!row) throw notFound("角色");
    return this.mapCharacter(row);
  }

  setCharacterFavorite(characterId: string, isFavorite: boolean): Record<string, unknown> {
    const character = this.db.get("SELECT id, work_id, is_favorite, merged_into_character_id FROM characters WHERE id = ?", characterId);
    if (!character) throw notFound("角色");
    if (optionalString(character, "merged_into_character_id")) {
      throw new AppError(409, "CHARACTER_ALREADY_MERGED", "已合并角色不能收藏");
    }
    const workId = requiredString(character, "work_id");
    this.db.transaction(() => {
      const previousFavorite = this.setEntityFavorite(workId, "character", characterId, isFavorite, booleanValue(character, "is_favorite"));
      if (previousFavorite !== isFavorite) {
        this.audit(workId, "character.favorite-updated", "character", characterId, {
          previousFavorite,
          isFavorite
        });
      }
    });
    return this.getCharacter(characterId);
  }

  setCharacterPin(characterId: string, isPinned: boolean): Record<string, unknown> {
    const character = this.db.get("SELECT id, work_id, merged_into_character_id FROM characters WHERE id = ?", characterId);
    if (!character) throw notFound("角色");
    if (optionalString(character, "merged_into_character_id")) {
      throw new AppError(409, "CHARACTER_ALREADY_MERGED", "已合并角色不能置顶");
    }
    const workId = requiredString(character, "work_id");
    this.db.transaction(() => {
      const previousPin = this.setEntityPin(workId, "character", characterId, isPinned);
      if (previousPin !== isPinned) {
        this.audit(workId, "character.pin-updated", "character", characterId, {
          previousPin,
          isPinned
        });
      }
    });
    return this.getCharacter(characterId);
  }

  getCharacterAvatar(characterId: string): CharacterAvatarMetadata | null {
    const character = this.db.get("SELECT id FROM characters WHERE id = ?", characterId);
    if (!character) throw notFound("角色");
    const row = this.db.get("SELECT * FROM character_avatars WHERE character_id = ?", characterId);
    if (!row) return null;
    return {
      mimeType: requiredString(row, "mime_type") as CharacterAvatarMetadata["mimeType"],
      byteLength: numberValue(row, "byte_length"),
      sha256: requiredString(row, "sha256"),
      storageKey: requiredString(row, "storage_key"),
      width: numberValue(row, "width"),
      height: numberValue(row, "height"),
      updatedAt: requiredString(row, "updated_at")
    };
  }

  setCharacterAvatar(characterId: string, input: CharacterAvatarInput): CharacterAvatarUpdateResult {
    const character = this.db.get<{ work_id: string; merged_into_character_id?: unknown }>("SELECT work_id, merged_into_character_id FROM characters WHERE id = ?", characterId);
    if (!character) throw notFound("角色");
    if (character.merged_into_character_id) throw new AppError(409, "CHARACTER_ALREADY_MERGED", "已合并角色不能直接设置头像");
    const previous = this.db.get("SELECT storage_key FROM character_avatars WHERE character_id = ?", characterId);
    const previousStorageKey = optionalString(previous ?? {}, "storage_key");
    const timestamp = now();
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO character_avatars (character_id, mime_type, byte_length, sha256, storage_key, width, height, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(character_id) DO UPDATE SET mime_type = excluded.mime_type, byte_length = excluded.byte_length,
         sha256 = excluded.sha256, storage_key = excluded.storage_key, width = excluded.width,
         height = excluded.height, updated_at = excluded.updated_at`,
        characterId,
        input.mimeType,
        input.byteLength,
        input.sha256,
        input.storageKey,
        input.width,
        input.height,
        timestamp
      );
      this.audit(character.work_id, "character.avatar-updated", "character", characterId, {
        mimeType: input.mimeType,
        byteLength: input.byteLength,
        width: input.width,
        height: input.height
      });
    });
    return { character: this.getCharacter(characterId), previousStorageKey };
  }

  deleteCharacterAvatar(characterId: string): { character: Record<string, unknown>; storageKey: string | null } {
    const character = this.db.get<{ work_id: string }>("SELECT work_id FROM characters WHERE id = ?", characterId);
    if (!character) throw notFound("角色");
    const current = this.db.get("SELECT storage_key FROM character_avatars WHERE character_id = ?", characterId);
    const storageKey = optionalString(current ?? {}, "storage_key");
    if (storageKey) {
      this.db.transaction(() => {
        this.db.run("DELETE FROM character_avatars WHERE character_id = ?", characterId);
        this.audit(character.work_id, "character.avatar-deleted", "character", characterId);
      });
    }
    return { character: this.getCharacter(characterId), storageKey };
  }

  listCharacterAvatarStorageKeysForWork(workId: string): string[] {
    return this.db.all(
      `SELECT avatar.storage_key FROM character_avatars avatar
       JOIN characters character ON character.id = avatar.character_id
       WHERE character.work_id = ?`,
      workId
    ).map((row) => requiredString(row, "storage_key"));
  }

  characterAvatarStorageKeyInUse(storageKey: string): boolean {
    return Number(this.db.get("SELECT COUNT(*) AS count FROM character_avatars WHERE storage_key = ?", storageKey)?.count ?? 0) > 0;
  }

  updateCharacter(
    characterId: string,
    input: Partial<CharacterInput>,
    source = "manual",
    sourceRef: string | null = null,
    changeNote = "",
    expectedVersionNo?: number
  ): Record<string, unknown> {
    const current = this.getCharacter(characterId);
    this.assertExpectedRevision("character", characterId, expectedVersionNo, "人物", Number(current.versionNo));
    if (current.mergedIntoCharacterId) throw new AppError(409, "CHARACTER_ALREADY_MERGED", "已合并角色不能直接编辑");
    const before = this.characterSnapshot(current);
    const workId = String(current.workId);
    const names = this.prepareCharacterNames(input.name ?? String(current.name), input.aliases ?? current.aliases as string[]);
    const attributes = input.attributes ?? current.attributes as Record<string, unknown>;
    const legacySpecies = typeof attributes.species === "string" ? attributes.species.trim() : "";
    let raceId = input.raceId === undefined ? current.raceId as string | null : input.raceId;
    if (input.raceId === undefined && !raceId && input.species !== undefined) {
      raceId = this.resolveRaceReference(workId, input.species.trim() || legacySpecies);
    }
    const race = raceId ? this.assertRaceInWork(workId, raceId) : null;
    const species = race ? String(race.name) : "";
    this.assertCharacterNamesAvailable(workId, names.entries, characterId);
    if (input.firstChapterId) this.assertChapterInWork(input.firstChapterId, workId);
    const organizationIds = input.organizationIds === undefined ? null : [...new Set(input.organizationIds)];
    if (organizationIds) this.assertOrganizationsInWork(workId, organizationIds);
    this.db.transaction(() => {
      const lockedCurrent = this.getCharacter(characterId);
      this.assertExpectedRevision("character", characterId, expectedVersionNo, "人物", Number(lockedCurrent.versionNo));
      this.db.run(
        `UPDATE characters SET name = ?, code = ?, gender = ?, aliases_json = ?, species = ?, race_id = ?, attributes_json = ?, profile_json = ?, current_state_json = ?,
         is_dead = ?, locked_fields_json = ?, first_chapter_id = ?, updated_at = ? WHERE id = ?`,
        names.name,
        input.code === undefined ? String(current.code) : input.code.trim(),
        input.gender ?? characterGender(current.gender),
        JSON.stringify(names.aliases),
        species,
        raceId,
        JSON.stringify(attributes),
        JSON.stringify(input.profile ?? current.profile),
        JSON.stringify(input.currentState ?? current.currentState),
        input.isDead === undefined ? (current.isDead ? 1 : 0) : (input.isDead ? 1 : 0),
        JSON.stringify(input.lockedFields ?? current.lockedFields),
        input.firstChapterId === undefined ? (current.firstChapterId as string | null) : input.firstChapterId,
        now(),
        characterId
      );
      this.db.run("DELETE FROM character_names WHERE character_id = ?", characterId);
      this.insertCharacterNames(workId, characterId, names.entries);
      if (organizationIds) this.replaceCharacterOrganizations(characterId, organizationIds);
      const updated = this.getCharacter(characterId);
      if (!this.snapshotsEqual(before, this.characterSnapshot(updated))) {
        const versionNo = Number(current.versionNo) + 1;
        const timestamp = now();
        this.db.run("UPDATE characters SET version_no = ?, updated_at = ? WHERE id = ?", versionNo, timestamp, characterId);
        this.insertCharacterVersion(characterId, versionNo, source, sourceRef, changeNote || "更新人物档案", timestamp);
        this.audit(workId, "character.updated", "character", characterId, { fields: Object.keys(input), versionNo, source, sourceRef });
      }
    });
    return this.getCharacter(characterId);
  }

  listCharacterVersions(characterId: string): Record<string, unknown>[] {
    const rows = this.db.all(
      `SELECT version.*, user.display_name AS actor_display_name, user.username AS actor_username
       FROM character_versions version LEFT JOIN users user ON user.id = version.created_by_user_id
       WHERE version.character_id = ? ORDER BY version.version_no DESC`,
      characterId
    );
    if (!rows.length) {
      this.getCharacter(characterId);
      return [];
    }
    return rows.map((row) => ({
      id: requiredString(row, "id"),
      workId: optionalString(row, "work_id"),
      characterId: requiredString(row, "character_id"),
      versionNo: numberValue(row, "version_no"),
      snapshot: json(requiredString(row, "snapshot_json"), {}),
      source: requiredString(row, "source"),
      sourceRef: optionalString(row, "source_ref"),
      changeNote: requiredString(row, "change_note"),
      createdAt: requiredString(row, "created_at"),
      actor: optionalString(row, "actor_display_name") ?? optionalString(row, "actor_username") ?? "历史数据"
    }));
  }

  listCharacterVersionsPage(characterId: string, pagination: Pagination): PaginatedResult<Record<string, unknown>> {
    const page = paginationSql(pagination);
    const rows = this.db.all(
      `SELECT version.*, user.display_name AS actor_display_name, user.username AS actor_username
       FROM character_versions version LEFT JOIN users user ON user.id = version.created_by_user_id
       WHERE version.character_id = ? ORDER BY version.version_no DESC${page.sql}`,
      characterId,
      ...page.params
    );
    if (!rows.length && pagination.page === 1) this.getCharacter(characterId);
    return paginated(rows.map((row) => ({
      id: requiredString(row, "id"),
      workId: optionalString(row, "work_id"),
      characterId: requiredString(row, "character_id"),
      versionNo: numberValue(row, "version_no"),
      snapshot: json(requiredString(row, "snapshot_json"), {}),
      source: requiredString(row, "source"),
      sourceRef: optionalString(row, "source_ref"),
      changeNote: requiredString(row, "change_note"),
      createdAt: requiredString(row, "created_at"),
      actor: optionalString(row, "actor_display_name") ?? optionalString(row, "actor_username") ?? "历史数据"
    })), pagination);
  }

  restoreCharacter(characterId: string, versionNo: number, expectedVersionNo?: number): Record<string, unknown> {
    const version = this.db.get("SELECT * FROM character_versions WHERE character_id = ? AND version_no = ?", characterId, versionNo);
    if (!version) throw notFound("人物版本");
    const snapshot = json<CharacterSnapshot>(requiredString(version, "snapshot_json"), {} as CharacterSnapshot);
    if (!snapshot.name) throw new AppError(500, "CHARACTER_VERSION_INVALID", "人物版本快照无效");
    const existing = this.db.get("SELECT id FROM characters WHERE id = ?", characterId);
    if (!existing) {
      this.assertExpectedRevision("character", characterId, expectedVersionNo, "人物", this.currentCharacterVersionNo(characterId));
      return this.recreateCharacterFromVersion(characterId, version, snapshot, versionNo);
    }
    return this.updateCharacter(
      characterId,
      { ...snapshot, gender: snapshot.gender ?? "unknown", isDead: snapshot.isDead ?? false, code: snapshot.code ?? "" },
      "restore",
      requiredString(version, "id"),
      `恢复至 v${versionNo}`,
      expectedVersionNo
    );
  }

  private recreateCharacterFromVersion(
    characterId: string,
    version: Row,
    snapshot: CharacterSnapshot,
    versionNo: number
  ): Record<string, unknown> {
    const workId = requiredString(version, "work_id");
    this.getWork(workId);
    const names = this.prepareCharacterNames(snapshot.name, snapshot.aliases ?? []);
    const raceId = snapshot.raceId ?? null;
    const race = raceId ? this.assertRaceInWork(workId, raceId) : null;
    const species = race ? String(race.name) : (snapshot.species ?? "");
    this.assertCharacterNamesAvailable(workId, names.entries);
    if (snapshot.firstChapterId) this.assertChapterInWork(snapshot.firstChapterId, workId);
    const organizationIds = [...new Set(snapshot.organizationIds ?? [])];
    this.assertOrganizationsInWork(workId, organizationIds);
    const timestamp = now();
    const nextVersionNo = numberValue(
      this.db.get("SELECT COALESCE(MAX(version_no), 0) AS version_no FROM character_versions WHERE character_id = ?", characterId) ?? {},
      "version_no"
    ) + 1;
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO characters (id, work_id, name, code, gender, aliases_json, species, race_id, attributes_json, profile_json, current_state_json,
         is_dead, locked_fields_json, first_chapter_id, version_no, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        characterId,
        workId,
        names.name,
        snapshot.code ?? "",
        snapshot.gender ?? "unknown",
        JSON.stringify(names.aliases),
        species,
        raceId,
        JSON.stringify(snapshot.attributes ?? {}),
        JSON.stringify(snapshot.profile ?? {}),
        JSON.stringify(snapshot.currentState ?? {}),
        snapshot.isDead ? 1 : 0,
        JSON.stringify(snapshot.lockedFields ?? []),
        snapshot.firstChapterId ?? null,
        nextVersionNo,
        timestamp,
        timestamp
      );
      this.insertCharacterNames(workId, characterId, names.entries);
      this.replaceCharacterOrganizations(characterId, organizationIds);
      this.insertCharacterVersion(characterId, nextVersionNo, "restore", requiredString(version, "id"), `恢复至 v${versionNo}`, timestamp, workId);
      this.audit(workId, "character.restored", "character", characterId, { versionNo: nextVersionNo, fromVersion: versionNo });
    });
    return this.getCharacter(characterId);
  }

  deleteCharacter(characterId: string, expectedVersionNo?: number): void {
    const current = this.getCharacter(characterId);
    this.assertExpectedRevision("character", characterId, expectedVersionNo, "人物", Number(current.versionNo));
    const timestamp = now();
    const versionNo = Number(current.versionNo) + 1;
    const workId = String(current.workId);
    const timelineEvents = this.listTimelineEvents(workId).filter(
      (event) => (event.participantIds as string[]).includes(characterId)
    );
    const relationships = this.listRelationships(workId).filter(
      (relationship) => relationship.fromCharacterId === characterId || relationship.toCharacterId === characterId
    );
    this.db.transaction(() => {
      const lockedCurrent = this.getCharacter(characterId);
      this.assertExpectedRevision("character", characterId, expectedVersionNo, "人物", Number(lockedCurrent.versionNo));
      for (const event of timelineEvents) {
        this.updateTimelineEvent(String(event.id), {
          participantIds: (event.participantIds as string[]).filter((participantId) => participantId !== characterId)
        }, "manual", characterId, `删除角色“${String(current.name)}”后移除参与者引用`);
      }
      for (const relationship of relationships) this.deleteRelationship(String(relationship.id));
      const sectionIds = this.db.all("SELECT id FROM character_profile_sections WHERE character_id = ?", characterId)
        .map((row) => requiredString(row, "id"));
      for (const sectionId of sectionIds) {
        this.db.run("DELETE FROM attachment_references WHERE entity_type = 'character-section' AND entity_id = ?", sectionId);
      }
      this.db.run("UPDATE characters SET version_no = ?, updated_at = ? WHERE id = ?", versionNo, timestamp, characterId);
      this.insertCharacterVersion(characterId, versionNo, "delete", null, "删除人物", timestamp);
      this.db.run("DELETE FROM characters WHERE id = ?", characterId);
      this.audit(workId, "character.deleted", "character", characterId, { versionNo });
    });
  }

  private mapCharacter(row: Row, includeProfileSections = true, includeRaceMarkdown = true): Record<string, unknown> {
    const indexedAliases = this.db.all(
      "SELECT display_name FROM character_names WHERE character_id = ? AND kind = 'alias' ORDER BY sort_order",
      requiredString(row, "id")
    ).map((item) => requiredString(item, "display_name"));
    const organizations = this.db.all(
      `SELECT o.id, o.name, o.is_dissolved, m.role, m.note
       FROM character_organization_memberships m
       JOIN organizations o ON o.id = m.organization_id
       WHERE m.character_id = ? ORDER BY o.name`,
      requiredString(row, "id")
    ).map((item) => ({
      organizationId: requiredString(item, "id"),
      name: requiredString(item, "name"),
      isDissolved: booleanValue(item, "is_dissolved"),
      role: requiredString(item, "role"),
      note: requiredString(item, "note")
    }));
    const raceId = optionalString(row, "race_id");
    const race = raceId ? this.getRace(raceId, includeRaceMarkdown) : undefined;
    const species = race ? String(race.name) : requiredString(row, "species");
    const profile = json<Record<string, unknown>>(requiredString(row, "profile_json"), {});
    if (!includeProfileSections) delete profile.sections;
    const characterId = requiredString(row, "id");
    const profileSectionCount = Number(this.db.get(
      "SELECT COUNT(*) AS count FROM character_profile_sections WHERE character_id = ?",
      characterId
    )?.count ?? 0);
    const markdownSections = includeProfileSections
      ? this.db.all(
        "SELECT * FROM character_profile_sections WHERE character_id = ? ORDER BY sort_order, created_at",
        characterId
      ).map((section) => this.mapCharacterProfileSection(section))
      : [];
    if (markdownSections.length > 0) {
      profile.sections = markdownSections.map((section) => ({
        id: section.id,
        sectionType: section.sectionType,
        title: section.title,
        content: section.contentMarkdown,
        contentMarkdown: section.contentMarkdown,
        summary: section.summary,
        sortOrder: section.sortOrder,
        versionNo: section.versionNo
      }));
    }
    const avatar = this.db.get("SELECT sha256 FROM character_avatars WHERE character_id = ?", characterId);
    const avatarSha256 = optionalString(avatar ?? {}, "sha256");
    return {
      id: characterId,
      workId: requiredString(row, "work_id"),
      name: requiredString(row, "name"),
      code: requiredString(row, "code"),
      gender: characterGender(row.gender),
      aliases: indexedAliases.length > 0 ? indexedAliases : json(requiredString(row, "aliases_json"), []),
      raceId: race ? String(race.id) : null,
      race: race ? {
        id: String(race.id),
        name: species,
        isExtinct: race.isExtinct,
        lineage: race.lineage,
        effectiveSettings: race.effectiveSettings
      } : null,
      species,
      organizationIds: organizations.map((organization) => organization.organizationId),
      organizations,
      attributes: json(requiredString(row, "attributes_json"), {}),
      profile,
      profileSectionCount,
      currentState: json(requiredString(row, "current_state_json"), {}),
      isDead: booleanValue(row, "is_dead"),
      isFavorite: this.mapEntityFavorite(row),
      isPinned: this.mapEntityPin(row),
      avatarUrl: avatarSha256
        ? `/api/characters/${encodeURIComponent(characterId)}/avatar?v=${encodeURIComponent(avatarSha256)}`
        : null,
      lockedFields: json(requiredString(row, "locked_fields_json"), []),
      firstChapterId: optionalString(row, "first_chapter_id"),
      mergedIntoCharacterId: optionalString(row, "merged_into_character_id"),
      mergedAt: optionalString(row, "merged_at"),
      versionNo: numberValue(row, "version_no"),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at")
    };
  }

  resolveCharacterReference(workId: string, value: string): string | null {
    const normalizedName = normalizeCharacterName(value);
    if (!normalizedName) return null;
    const row = this.db.get(
      "SELECT character_id FROM character_names WHERE work_id = ? AND normalized_name = ?",
      workId,
      normalizedName
    );
    return row ? requiredString(row, "character_id") : null;
  }

  mergeCharacters(input: {
    reviewId: string | null;
    targetCharacterId: string;
    sourceCharacterId: string;
    expectedTargetVersionNo: number;
    expectedSourceVersionNo: number;
  }): Record<string, unknown> {
    if (input.targetCharacterId === input.sourceCharacterId) {
      throw new AppError(400, "CHARACTER_MERGE_SELF", "不能把角色合并到自身");
    }
    const review = input.reviewId ? this.getReviewItem(input.reviewId) : null;
    if (review) {
      if (review.itemType !== "character-duplicate" || review.status !== "pending") {
        throw new AppError(409, "CHARACTER_REVIEW_DECIDED", "该角色查重项已经处理");
      }
      const reviewCharacterIds = (review.entityRefs as unknown[]).flatMap((reference) => {
        if (!reference || typeof reference !== "object" || Array.isArray(reference)) return [];
        const characterId = (reference as Record<string, unknown>).id;
        return typeof characterId === "string" ? [characterId] : [];
      });
      if (!reviewCharacterIds.includes(input.targetCharacterId) || !reviewCharacterIds.includes(input.sourceCharacterId)) {
        throw new AppError(400, "CHARACTER_REVIEW_MISMATCH", "待合并角色与审核项不一致");
      }
    }
    const target = this.getCharacter(input.targetCharacterId);
    const source = this.getCharacter(input.sourceCharacterId);
    if (target.workId !== source.workId || (review && target.workId !== review.workId)) {
      throw new AppError(400, "CHARACTER_WORK_MISMATCH", "待合并角色不属于同一作品");
    }
    if (target.mergedIntoCharacterId || source.mergedIntoCharacterId) {
      throw new AppError(409, "CHARACTER_ALREADY_MERGED", "待合并角色中已有角色被合并");
    }
    if (Number(target.versionNo) !== input.expectedTargetVersionNo || Number(source.versionNo) !== input.expectedSourceVersionNo) {
      throw new AppError(409, "CHARACTER_VERSION_CHANGED", "角色已发生变化，请刷新后重试");
    }

    const workId = String(target.workId);
    const targetId = String(target.id);
    const sourceId = String(source.id);
    const mergeId = id("characterMerge");
    const timestamp = now();
    const sourceRelationships = this.listRelationships(workId).filter(
      (relationship) => relationship.fromCharacterId === sourceId || relationship.toCharacterId === sourceId
    );
    const timelineEvents = this.listTimelineEvents(workId).filter(
      (event) => (event.participantIds as string[]).includes(sourceId)
    );
    const sourceMemberships = this.db.all(
      "SELECT * FROM character_organization_memberships WHERE character_id = ? ORDER BY organization_id",
      sourceId
    );
    const referenceSnapshot = { relationships: sourceRelationships, timelineEvents, memberships: sourceMemberships };

    this.db.transaction(() => {
      const lockedTarget = this.getCharacter(targetId);
      const lockedSource = this.getCharacter(sourceId);
      this.assertExpectedRevision("character", targetId, input.expectedTargetVersionNo, "目标角色", Number(lockedTarget.versionNo));
      this.assertExpectedRevision("character", sourceId, input.expectedSourceVersionNo, "来源角色", Number(lockedSource.versionNo));
      this.db.run("DELETE FROM character_names WHERE character_id = ?", sourceId);
      const aliases = [...(target.aliases as string[]), String(source.name), ...(source.aliases as string[])];
      const uniqueAliases = [...new Map(aliases
        .map((alias) => alias.normalize("NFKC").trim().replace(/\s+/gu, " "))
        .filter(Boolean)
        .filter((alias) => normalizeCharacterName(alias) !== normalizeCharacterName(String(target.name)))
        .map((alias) => [normalizeCharacterName(alias), alias])).values()];
      this.updateCharacter(targetId, {
        code: String(target.code) || String(source.code),
        aliases: uniqueAliases,
        raceId: (target.raceId as string | null) ?? (source.raceId as string | null),
        organizationIds: [...new Set([...(target.organizationIds as string[]), ...(source.organizationIds as string[])])],
        attributes: { ...(source.attributes as Record<string, unknown>), ...(target.attributes as Record<string, unknown>) },
        profile: { ...(source.profile as Record<string, unknown>), ...(target.profile as Record<string, unknown>) },
        currentState: { ...(source.currentState as Record<string, unknown>), ...(target.currentState as Record<string, unknown>) },
        lockedFields: [...new Set([...(target.lockedFields as string[]), ...(source.lockedFields as string[])])],
        firstChapterId: (target.firstChapterId as string | null) ?? (source.firstChapterId as string | null)
      }, "merge", mergeId, `合并角色“${String(source.name)}”`, input.expectedTargetVersionNo);

      for (const event of timelineEvents) {
        const participantIds = [...new Set((event.participantIds as string[]).map(
          (characterId) => characterId === sourceId ? targetId : characterId
        ))];
        this.updateTimelineEvent(String(event.id), { participantIds }, "merge", mergeId, `合并角色“${String(source.name)}”`);
      }

      for (const relationship of sourceRelationships) {
        let fromCharacterId = relationship.fromCharacterId === sourceId ? targetId : String(relationship.fromCharacterId);
        let toCharacterId = relationship.toCharacterId === sourceId ? targetId : String(relationship.toCharacterId);
        if (fromCharacterId === toCharacterId) {
          this.deleteRelationship(String(relationship.id));
          continue;
        }
        if (!relationship.directed && fromCharacterId.localeCompare(toCharacterId) > 0) {
          [fromCharacterId, toCharacterId] = [toCharacterId, fromCharacterId];
        }
        const duplicate = this.listRelationships(workId).find((candidate) => candidate.id !== relationship.id
          && candidate.fromCharacterId === fromCharacterId
          && candidate.toCharacterId === toCharacterId
          && Boolean(candidate.directed) === Boolean(relationship.directed)
          && candidate.category === relationship.category
          && normalizeCharacterName(String(candidate.subtype)) === normalizeCharacterName(String(relationship.subtype))
          && candidate.confirmationStatus !== "rejected");
        if (duplicate) {
          const keywords = [...new Set([...(duplicate.keywords as string[]), ...(relationship.keywords as string[])])];
          const evidence = [...new Map([...(duplicate.evidence as unknown[]), ...(relationship.evidence as unknown[])]
            .map((item) => [JSON.stringify(item), item])).values()];
          this.updateRelationship(String(duplicate.id), {
            keywords,
            evidence,
            confidence: Math.max(Number(duplicate.confidence), Number(relationship.confidence)),
            locked: Boolean(duplicate.locked) || Boolean(relationship.locked),
            confirmationStatus: duplicate.confirmationStatus === "confirmed" || relationship.confirmationStatus === "confirmed"
              ? "confirmed"
              : String(duplicate.confirmationStatus)
          }, "merge", mergeId, `合并角色“${String(source.name)}”的重复关系`);
          this.deleteRelationship(String(relationship.id));
        } else {
          this.updateRelationship(String(relationship.id), { fromCharacterId, toCharacterId }, "merge", mergeId, `迁移角色“${String(source.name)}”的关系`);
        }
      }

      this.db.run("DELETE FROM character_organization_memberships WHERE character_id = ?", sourceId);
      this.db.run("UPDATE character_profile_sections SET character_id = ?, updated_at = ? WHERE character_id = ?", targetId, timestamp, sourceId);
      this.db.run("UPDATE character_profile_section_versions SET character_id = ? WHERE character_id = ?", targetId, sourceId);
      this.db.run("UPDATE character_profile_section_search SET character_id = ? WHERE character_id = ?", targetId, sourceId);
      const sourceVersionNo = Number(source.versionNo) + 1;
      this.db.run(
        "UPDATE characters SET merged_into_character_id = ?, merged_at = ?, version_no = ?, updated_at = ? WHERE id = ?",
        targetId,
        timestamp,
        sourceVersionNo,
        timestamp,
        sourceId
      );
      this.insertCharacterVersion(sourceId, sourceVersionNo, "merge", mergeId, `合并至角色“${String(target.name)}”`, timestamp);
      this.db.run(
        `INSERT INTO character_merges (id, work_id, source_character_id, target_character_id, review_id,
         source_snapshot_json, target_snapshot_json, reference_snapshot_json, created_at, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        mergeId,
        workId,
        sourceId,
        targetId,
        input.reviewId,
        JSON.stringify(source),
        JSON.stringify(target),
        JSON.stringify(referenceSnapshot),
        timestamp,
        currentRequestActor()?.userId ?? null
      );
      if (input.reviewId) {
        this.db.run(
          "UPDATE review_items SET status = 'fixed', resolution_note = ?, updated_at = ? WHERE id = ?",
          `已将“${String(source.name)}”合并到“${String(target.name)}”`,
          timestamp,
          input.reviewId
        );
      }
      this.audit(workId, "character.merged", "character", targetId, {
        mergeId,
        sourceCharacterId: sourceId,
        reviewId: input.reviewId
      });
    });
    return {
      mergeId,
      target: this.getCharacter(targetId),
      source: this.getCharacter(sourceId),
      review: input.reviewId ? this.getReviewItem(input.reviewId) : null
    };
  }

  resolveCharacterDuplicateReview(reviewId: string): Record<string, unknown> {
    const review = this.getReviewItem(reviewId);
    if (review.itemType !== "character-duplicate" || review.status !== "pending") {
      throw new AppError(409, "CHARACTER_REVIEW_DECIDED", "该角色查重项已经处理");
    }
    return this.updateReviewItem(reviewId, {
      status: "exception",
      resolutionNote: "作者确认是不同角色"
    });
  }

  private prepareCharacterNames(name: string, aliases: string[]): {
    name: string;
    aliases: string[];
    entries: Array<{ normalizedName: string; displayName: string; kind: "primary" | "alias"; sortOrder: number }>;
  } {
    const primary = name.normalize("NFKC").trim().replace(/\s+/gu, " ");
    if (!primary) throw new AppError(400, "CHARACTER_NAME_REQUIRED", "角色标准名不能为空");
    const cleanedAliases = aliases.map((alias) => alias.normalize("NFKC").trim().replace(/\s+/gu, " ")).filter(Boolean);
    const entries = [
      { normalizedName: normalizeCharacterName(primary), displayName: primary, kind: "primary" as const, sortOrder: 0 },
      ...cleanedAliases.map((alias, index) => ({ normalizedName: normalizeCharacterName(alias), displayName: alias, kind: "alias" as const, sortOrder: index + 1 }))
    ];
    const seen = new Map<string, string>();
    for (const entry of entries) {
      const existing = seen.get(entry.normalizedName);
      if (existing) {
        throw new AppError(409, "CHARACTER_NAME_CONFLICT", `角色名或别名重复：${existing} / ${entry.displayName}`, {
          normalizedName: entry.normalizedName
        });
      }
      seen.set(entry.normalizedName, entry.displayName);
    }
    return { name: primary, aliases: cleanedAliases, entries };
  }

  private assertCharacterNamesAvailable(
    workId: string,
    entries: Array<{ normalizedName: string; displayName: string }>,
    excludeCharacterId?: string
  ): void {
    for (const entry of entries) {
      const row = this.db.get(
        `SELECT character_id, display_name FROM character_names
         WHERE work_id = ? AND normalized_name = ?${excludeCharacterId ? " AND character_id <> ?" : ""}`,
        ...([workId, entry.normalizedName, ...(excludeCharacterId ? [excludeCharacterId] : [])])
      );
      if (row) {
        throw new AppError(409, "CHARACTER_NAME_CONFLICT", `角色名或别名“${entry.displayName}”已被使用`, {
          conflictingCharacterId: requiredString(row, "character_id"),
          conflictingName: requiredString(row, "display_name")
        });
      }
    }
  }

  private insertCharacterNames(
    workId: string,
    characterId: string,
    entries: Array<{ normalizedName: string; displayName: string; kind: "primary" | "alias"; sortOrder: number }>
  ): void {
    for (const entry of entries) {
      this.db.run(
        `INSERT INTO character_names (work_id, normalized_name, character_id, display_name, kind, sort_order)
         VALUES (?, ?, ?, ?, ?, ?)`,
        workId,
        entry.normalizedName,
        characterId,
        entry.displayName,
        entry.kind,
        entry.sortOrder
      );
    }
  }

  createTimelineTrack(workId: string, input: TimelineTrackInput, source = "create", sourceRef: string | null = null): Record<string, unknown> {
    this.getWork(workId);
    return this.insertTimelineTrackWithId(workId, id("timeline-track"), input, source, sourceRef);
  }

  private insertTimelineTrackWithId(
    workId: string,
    trackId: string,
    input: TimelineTrackInput,
    source = "create",
    sourceRef: string | null = null,
    changeNote = ""
  ): Record<string, unknown> {
    const timestamp = now();
    const fallbackOrder = Number(this.db.get("SELECT COALESCE(MAX(sort_order), -1) + 1 AS value FROM timeline_tracks WHERE work_id = ?", workId)?.value ?? 0);
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO timeline_tracks (id, work_id, name, description, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        trackId,
        workId,
        input.name,
        input.description ?? "",
        input.sortOrder ?? fallbackOrder,
        timestamp,
        timestamp
      );
      this.recordEntityVersion("timeline-track", trackId, source, sourceRef, changeNote || "建立独立时间轴", timestamp);
      this.audit(workId, source === "restore" ? "timeline-track.restored" : "timeline-track.created", "timeline-track", trackId, { source, sourceRef });
    });
    return this.getTimelineTrack(trackId);
  }

  listTimelineTracks(workId: string): Record<string, unknown>[] {
    this.getWork(workId);
    return this.db.all("SELECT * FROM timeline_tracks WHERE work_id = ? ORDER BY sort_order, created_at", workId).map((row) => this.mapTimelineTrack(row));
  }

  listTimelineTracksPage(workId: string, pagination: Pagination): PaginatedResult<Record<string, unknown>> {
    this.getWork(workId);
    const page = paginationSql(pagination);
    const rows = this.db.all(`SELECT * FROM timeline_tracks WHERE work_id = ? ORDER BY sort_order, created_at${page.sql}`, workId, ...page.params);
    return paginated(rows.map((row) => this.mapTimelineTrack(row)), pagination);
  }

  getTimelineTrack(trackId: string): Record<string, unknown> {
    const row = this.db.get("SELECT * FROM timeline_tracks WHERE id = ?", trackId);
    if (!row) throw notFound("独立时间轴");
    return this.mapTimelineTrack(row);
  }

  updateTimelineTrack(
    trackId: string,
    input: Partial<TimelineTrackInput>,
    source = "manual",
    sourceRef: string | null = null,
    changeNote = "",
    expectedVersionNo?: number
  ): Record<string, unknown> {
    const current = this.getTimelineTrack(trackId);
    this.db.transaction(() => {
      this.assertExpectedVersion("timeline-track", trackId, expectedVersionNo, "时间轴");
      this.db.run(
        "UPDATE timeline_tracks SET name = ?, description = ?, sort_order = ?, updated_at = ? WHERE id = ?",
        input.name ?? String(current.name),
        input.description ?? String(current.description),
        input.sortOrder ?? Number(current.sortOrder),
        now(),
        trackId
      );
      this.recordEntityVersion("timeline-track", trackId, source, sourceRef, changeNote || "更新时间轴");
      this.audit(String(current.workId), "timeline-track.updated", "timeline-track", trackId, { fields: Object.keys(input), source, sourceRef });
    });
    return this.getTimelineTrack(trackId);
  }

  deleteTimelineTrack(trackId: string, expectedVersionNo?: number): void {
    const current = this.getTimelineTrack(trackId);
    this.db.transaction(() => {
      this.assertExpectedVersion("timeline-track", trackId, expectedVersionNo, "时间轴");
      this.recordEntityVersion("timeline-track", trackId, "delete", null, "删除时间轴");
      this.db.run("DELETE FROM timeline_tracks WHERE id = ?", trackId);
      this.audit(String(current.workId), "timeline-track.deleted", "timeline-track", trackId);
    });
  }

  createTimelineEvent(workId: string, input: TimelineInput, source = "create", sourceRef: string | null = null): Record<string, unknown> {
    this.getWork(workId);
    if (input.trackId) {
      const track = this.getTimelineTrack(input.trackId);
      if (track.workId !== workId) throw new AppError(400, "TIMELINE_TRACK_WORK_MISMATCH", "独立时间轴不属于当前作品");
    }
    return this.insertTimelineEventWithId(workId, id("event"), input, source, sourceRef);
  }

  private insertTimelineEventWithId(
    workId: string,
    eventId: string,
    input: TimelineInput,
    source = "create",
    sourceRef: string | null = null,
    changeNote = ""
  ): Record<string, unknown> {
    if (input.trackId) {
      const track = this.getTimelineTrack(input.trackId);
      if (track.workId !== workId) throw new AppError(400, "TIMELINE_TRACK_WORK_MISMATCH", "独立时间轴不属于当前作品");
    }
    const timestamp = now();
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO timeline_events (id, work_id, track_id, name, description, event_type, time_label, time_sort, chapter_ids_json,
         participant_ids_json, location, causes_json, impact_scope, evidence_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        eventId,
        workId,
        input.trackId ?? null,
        input.name,
        input.description ?? "",
        input.eventType ?? "other",
        input.timeLabel ?? "时间待定",
        input.timeSort ?? null,
        JSON.stringify(input.chapterIds ?? []),
        JSON.stringify(input.participantIds ?? []),
        input.location ?? "",
        JSON.stringify(input.causes ?? []),
        input.impactScope ?? "personal",
        JSON.stringify(input.evidence ?? []),
        input.status ?? "candidate",
        timestamp,
        timestamp
      );
      this.recordEntityVersion(
        "timeline-event",
        eventId,
        source,
        sourceRef,
        changeNote || (source === "analysis" ? "AI 提取时间事件" : "建立时间事件"),
        timestamp
      );
      this.audit(workId, source === "restore" ? "timeline.restored" : "timeline.created", "timeline-event", eventId, { source, sourceRef });
    });
    return this.getTimelineEvent(eventId);
  }

  listTimelineEvents(workId: string): Record<string, unknown>[] {
    this.getWork(workId);
    return this.db
      .all("SELECT * FROM timeline_events WHERE work_id = ? ORDER BY time_sort IS NULL, time_sort, created_at", workId)
      .map((row) => this.mapTimelineEvent(row));
  }

  listTimelineEventsPage(workId: string, pagination: Pagination): PaginatedResult<Record<string, unknown>> {
    this.getWork(workId);
    const page = paginationSql(pagination);
    const rows = this.db.all(
      `SELECT * FROM timeline_events WHERE work_id = ? ORDER BY time_sort IS NULL, time_sort, created_at${page.sql}`,
      workId,
      ...page.params
    );
    return paginated(rows.map((row) => this.mapTimelineEvent(row)), pagination);
  }

  getTimelineEvent(eventId: string): Record<string, unknown> {
    const row = this.db.get("SELECT * FROM timeline_events WHERE id = ?", eventId);
    if (!row) throw notFound("时间线事件");
    return this.mapTimelineEvent(row);
  }

  updateTimelineEvent(
    eventId: string,
    input: Partial<TimelineInput>,
    source = "manual",
    sourceRef: string | null = null,
    changeNote = "",
    expectedVersionNo?: number
  ): Record<string, unknown> {
    const current = this.getTimelineEvent(eventId);
    if (input.trackId) {
      const track = this.getTimelineTrack(input.trackId);
      if (track.workId !== current.workId) throw new AppError(400, "TIMELINE_TRACK_WORK_MISMATCH", "独立时间轴不属于当前作品");
    }
    this.db.transaction(() => {
      this.assertExpectedVersion("timeline-event", eventId, expectedVersionNo, "时间事件");
      this.db.run(
        `UPDATE timeline_events SET track_id = ?, name = ?, description = ?, event_type = ?, time_label = ?, time_sort = ?,
         chapter_ids_json = ?, participant_ids_json = ?, location = ?, causes_json = ?, impact_scope = ?, evidence_json = ?,
         status = ?, updated_at = ? WHERE id = ?`,
        input.trackId === undefined ? (current.trackId as string | null) : input.trackId,
        input.name ?? String(current.name),
        input.description ?? String(current.description),
        input.eventType ?? String(current.eventType),
        input.timeLabel ?? String(current.timeLabel),
        input.timeSort === undefined ? (current.timeSort as number | null) : input.timeSort,
        JSON.stringify(input.chapterIds ?? current.chapterIds),
        JSON.stringify(input.participantIds ?? current.participantIds),
        input.location ?? String(current.location),
        JSON.stringify(input.causes ?? current.causes),
        input.impactScope ?? String(current.impactScope),
        JSON.stringify(input.evidence ?? current.evidence),
        input.status ?? String(current.status),
        now(),
        eventId
      );
      this.recordEntityVersion("timeline-event", eventId, source, sourceRef, changeNote || "更新时间事件");
      this.audit(String(current.workId), "timeline.updated", "timeline-event", eventId, { fields: Object.keys(input), source, sourceRef });
    });
    return this.getTimelineEvent(eventId);
  }

  deleteTimelineEvent(eventId: string, expectedVersionNo?: number): void {
    const current = this.getTimelineEvent(eventId);
    this.db.transaction(() => {
      this.assertExpectedVersion("timeline-event", eventId, expectedVersionNo, "时间事件");
      this.recordEntityVersion("timeline-event", eventId, "delete", null, "删除时间事件");
      this.db.run("DELETE FROM timeline_events WHERE id = ?", eventId);
      this.audit(String(current.workId), "timeline.deleted", "timeline-event", eventId);
    });
  }

  mergeTimelineEvents(
    workId: string,
    eventIds: string[],
    input: { name: string; description?: string; timeLabel?: string; timeSort?: number | null },
    expectedVersionNos?: Record<string, number>
  ): Record<string, unknown> {
    this.getWork(workId);
    const uniqueIds = [...new Set(eventIds)];
    if (uniqueIds.length < 2) throw new AppError(400, "EVENTS_REQUIRED", "合并时间事件至少需要选择两项");
    const events = uniqueIds.map((eventId) => this.getTimelineEvent(eventId));
    if (events.some((event) => event.workId !== workId)) throw new AppError(400, "EVENT_WORK_MISMATCH", "时间事件不属于当前作品");
    const union = (key: string): unknown[] => {
      const values = events.flatMap((event) => Array.isArray(event[key]) ? event[key] as unknown[] : []);
      return [...new Map(values.map((value) => [JSON.stringify(value), value])).values()];
    };
    const knownSorts = events.map((event) => event.timeSort).filter((value): value is number => typeof value === "number");
    return this.db.transaction(() => {
      for (const event of events) {
        this.assertExpectedVersion("timeline-event", String(event.id), expectedVersionNos?.[String(event.id)], "时间事件", Number(event.versionNo));
      }
      const merged = this.createTimelineEvent(workId, {
        name: input.name,
        trackId: events.every((event) => event.trackId === events[0]?.trackId) ? (events[0]?.trackId as string | null) : null,
        description: input.description ?? events.map((event) => String(event.description)).filter(Boolean).join("\n"),
        eventType: String(events[0]?.eventType ?? "other"),
        timeLabel: input.timeLabel ?? String(events[0]?.timeLabel ?? "时间待定"),
        timeSort: input.timeSort === undefined ? (knownSorts.length ? Math.min(...knownSorts) : null) : input.timeSort,
        chapterIds: union("chapterIds").filter((value): value is string => typeof value === "string"),
        participantIds: union("participantIds").filter((value): value is string => typeof value === "string"),
        location: [...new Set(events.map((event) => String(event.location)).filter(Boolean))].join(" / "),
        causes: union("causes").filter((value): value is string => typeof value === "string"),
        impactScope: String(events[0]?.impactScope ?? "personal"),
        evidence: union("evidence"),
        status: events.every((event) => event.status === "confirmed") ? "confirmed" : "pending"
      }, "merge", uniqueIds.join(","));
      for (const eventId of uniqueIds) {
        this.recordEntityVersion("timeline-event", eventId, "delete", null, "删除时间事件");
        this.db.run("DELETE FROM timeline_events WHERE id = ?", eventId);
      }
      this.audit(workId, "timeline.merged", "timeline-event", String(merged.id), { sourceEventIds: uniqueIds });
      return merged;
    });
  }

  splitTimelineEvent(
    eventId: string,
    parts: Array<{ name: string; description?: string; timeLabel?: string; timeSort?: number | null }>,
    expectedVersionNo?: number
  ): Record<string, unknown>[] {
    const source = this.getTimelineEvent(eventId);
    this.assertExpectedVersion("timeline-event", eventId, expectedVersionNo, "时间事件", Number(source.versionNo));
    if (parts.length < 2) throw new AppError(400, "EVENT_PARTS_REQUIRED", "拆分时间事件至少需要两项");
    return this.db.transaction(() => {
      const lockedSource = this.getTimelineEvent(eventId);
      this.assertExpectedVersion("timeline-event", eventId, expectedVersionNo, "时间事件", Number(lockedSource.versionNo));
      const created = parts.map((part, index) => this.createTimelineEvent(String(source.workId), {
        name: part.name,
        trackId: source.trackId as string | null,
        description: part.description ?? String(source.description),
        eventType: String(source.eventType),
        timeLabel: part.timeLabel ?? String(source.timeLabel),
        timeSort: part.timeSort === undefined
          ? (typeof source.timeSort === "number" ? source.timeSort + index / 100 : null)
          : part.timeSort,
        chapterIds: source.chapterIds as string[],
        participantIds: source.participantIds as string[],
        location: String(source.location),
        causes: source.causes as string[],
        impactScope: String(source.impactScope),
        evidence: source.evidence as unknown[],
        status: String(source.status)
      }, "split", eventId));
      this.recordEntityVersion("timeline-event", eventId, "delete", null, "删除时间事件");
      this.db.run("DELETE FROM timeline_events WHERE id = ?", eventId);
      this.audit(String(source.workId), "timeline.split", "timeline-event", eventId, { createdEventIds: created.map((event) => event.id) });
      return created;
    });
  }

  private mapTimelineEvent(row: Row): Record<string, unknown> {
    return {
      id: requiredString(row, "id"),
      workId: requiredString(row, "work_id"),
      trackId: row.track_id === null ? null : requiredString(row, "track_id"),
      name: requiredString(row, "name"),
      description: requiredString(row, "description"),
      eventType: requiredString(row, "event_type"),
      timeLabel: requiredString(row, "time_label"),
      timeSort: row.time_sort === null ? null : numberValue(row, "time_sort"),
      chapterIds: json(requiredString(row, "chapter_ids_json"), []),
      participantIds: json(requiredString(row, "participant_ids_json"), []),
      location: requiredString(row, "location"),
      causes: json(requiredString(row, "causes_json"), []),
      impactScope: requiredString(row, "impact_scope"),
      evidence: json(requiredString(row, "evidence_json"), []),
      status: requiredString(row, "status"),
      versionNo: this.currentEntityVersionNo("timeline-event", requiredString(row, "id")),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at")
    };
  }

  private mapTimelineTrack(row: Row): Record<string, unknown> {
    return {
      id: requiredString(row, "id"),
      workId: requiredString(row, "work_id"),
      name: requiredString(row, "name"),
      description: requiredString(row, "description"),
      sortOrder: numberValue(row, "sort_order"),
      versionNo: this.currentEntityVersionNo("timeline-track", requiredString(row, "id")),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at")
    };
  }

  createRelationship(workId: string, input: RelationshipInput, source = "create", sourceRef: string | null = null): Record<string, unknown> {
    this.getWork(workId);
    return this.insertRelationshipWithId(workId, id("relationship"), input, source, sourceRef);
  }

  private insertRelationshipWithId(
    workId: string,
    relationshipId: string,
    input: RelationshipInput,
    source = "create",
    sourceRef: string | null = null,
    changeNote = ""
  ): Record<string, unknown> {
    let fromCharacterId = input.fromCharacterId;
    let toCharacterId = input.toCharacterId;
    if (fromCharacterId === toCharacterId) throw new AppError(400, "SELF_RELATIONSHIP", "人物关系不能指向自身");
    const from = this.getCharacter(fromCharacterId);
    const to = this.getCharacter(toCharacterId);
    if (from.workId !== workId || to.workId !== workId) throw new AppError(400, "CHARACTER_WORK_MISMATCH", "关系人物不属于当前作品");
    if (from.mergedIntoCharacterId || to.mergedIntoCharacterId) throw new AppError(409, "CHARACTER_ALREADY_MERGED", "已合并角色不能继续被引用");
    if (!input.directed && fromCharacterId.localeCompare(toCharacterId) > 0) [fromCharacterId, toCharacterId] = [toCharacterId, fromCharacterId];
    this.assertRelationshipUnique(workId, fromCharacterId, toCharacterId, input.category, input.subtype ?? "", Boolean(input.directed));
    const timestamp = now();
    const keywords = this.normalizeRelationshipKeywords(input.keywords ?? []);
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO relationships (id, work_id, from_character_id, to_character_id, category, subtype, keywords_json, directed,
         current_status, time_range_json, confidence, evidence_json, confirmation_status, locked, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        relationshipId,
        workId,
        fromCharacterId,
        toCharacterId,
        input.category,
        input.subtype ?? "",
        JSON.stringify(keywords),
        input.directed ? 1 : 0,
        input.currentStatus ?? "active",
        JSON.stringify(input.timeRange ?? {}),
        input.confidence ?? 0.5,
        JSON.stringify(input.evidence ?? []),
        input.confirmationStatus ?? "pending",
        input.locked ? 1 : 0,
        timestamp,
        timestamp
      );
      this.recordEntityVersion(
        "relationship",
        relationshipId,
        source,
        sourceRef,
        changeNote || (source === "analysis" ? "AI 提取人物关系" : "建立人物关系"),
        timestamp
      );
      this.audit(workId, source === "restore" ? "relationship.restored" : "relationship.created", "relationship", relationshipId, { source, sourceRef });
    });
    return this.getRelationship(relationshipId);
  }

  listRelationships(workId: string, minimumConfidence = 0): Record<string, unknown>[] {
    this.getWork(workId);
    return this.db
      .all("SELECT * FROM relationships WHERE work_id = ? AND confidence >= ? ORDER BY confidence DESC, created_at", workId, minimumConfidence)
      .map((row) => this.mapRelationship(row));
  }

  listRelationshipsPage(workId: string, pagination: Pagination, minimumConfidence = 0): PaginatedResult<Record<string, unknown>> {
    this.getWork(workId);
    const page = paginationSql(pagination);
    const rows = this.db.all(
      `SELECT * FROM relationships WHERE work_id = ? AND confidence >= ? ORDER BY confidence DESC, created_at${page.sql}`,
      workId,
      minimumConfidence,
      ...page.params
    );
    return paginated(rows.map((row) => this.mapRelationship(row)), pagination);
  }

  getRelationship(relationshipId: string): Record<string, unknown> {
    const row = this.db.get("SELECT * FROM relationships WHERE id = ?", relationshipId);
    if (!row) throw notFound("人物关系");
    return this.mapRelationship(row);
  }

  updateRelationship(
    relationshipId: string,
    input: Partial<RelationshipInput>,
    source = "manual",
    sourceRef: string | null = null,
    changeNote = "",
    expectedVersionNo?: number
  ): Record<string, unknown> {
    const current = this.getRelationship(relationshipId);
    let fromCharacterId = input.fromCharacterId ?? String(current.fromCharacterId);
    let toCharacterId = input.toCharacterId ?? String(current.toCharacterId);
    if (fromCharacterId === toCharacterId) throw new AppError(400, "SELF_RELATIONSHIP", "人物关系不能指向自身");
    const from = this.getCharacter(fromCharacterId);
    const to = this.getCharacter(toCharacterId);
    if (from.workId !== current.workId || to.workId !== current.workId) throw new AppError(400, "CHARACTER_WORK_MISMATCH", "关系人物不属于当前作品");
    if (from.mergedIntoCharacterId || to.mergedIntoCharacterId) throw new AppError(409, "CHARACTER_ALREADY_MERGED", "已合并角色不能继续被引用");
    const directed = input.directed ?? Boolean(current.directed);
    if (!directed && fromCharacterId.localeCompare(toCharacterId) > 0) [fromCharacterId, toCharacterId] = [toCharacterId, fromCharacterId];
    this.assertRelationshipUnique(
      String(current.workId),
      fromCharacterId,
      toCharacterId,
      input.category ?? String(current.category),
      input.subtype ?? String(current.subtype),
      directed,
      relationshipId
    );
    this.db.transaction(() => {
      this.assertExpectedVersion("relationship", relationshipId, expectedVersionNo, "人物关系");
      this.db.run(
        `UPDATE relationships SET from_character_id = ?, to_character_id = ?, category = ?, subtype = ?, keywords_json = ?, directed = ?,
         current_status = ?, time_range_json = ?, confidence = ?, evidence_json = ?, confirmation_status = ?, locked = ?, updated_at = ?
         WHERE id = ?`,
        fromCharacterId,
        toCharacterId,
        input.category ?? String(current.category),
        input.subtype ?? String(current.subtype),
        JSON.stringify(this.normalizeRelationshipKeywords(input.keywords ?? current.keywords as string[])),
        directed ? 1 : 0,
        input.currentStatus ?? String(current.currentStatus),
        JSON.stringify(input.timeRange ?? current.timeRange),
        input.confidence ?? Number(current.confidence),
        JSON.stringify(input.evidence ?? current.evidence),
        input.confirmationStatus ?? String(current.confirmationStatus),
        (input.locked ?? Boolean(current.locked)) ? 1 : 0,
        now(),
        relationshipId
      );
      this.recordEntityVersion("relationship", relationshipId, source, sourceRef, changeNote || "更新人物关系");
      this.audit(String(current.workId), "relationship.updated", "relationship", relationshipId, { fields: Object.keys(input), source, sourceRef });
    });
    return this.getRelationship(relationshipId);
  }

  deleteRelationship(relationshipId: string, expectedVersionNo?: number): void {
    const current = this.getRelationship(relationshipId);
    this.db.transaction(() => {
      this.assertExpectedVersion("relationship", relationshipId, expectedVersionNo, "人物关系");
      this.recordEntityVersion("relationship", relationshipId, "delete", null, "删除人物关系");
      this.db.run("DELETE FROM relationships WHERE id = ?", relationshipId);
      this.audit(String(current.workId), "relationship.deleted", "relationship", relationshipId);
    });
  }

  private mapRelationship(row: Row): Record<string, unknown> {
    return {
      id: requiredString(row, "id"),
      workId: requiredString(row, "work_id"),
      fromCharacterId: requiredString(row, "from_character_id"),
      toCharacterId: requiredString(row, "to_character_id"),
      category: requiredString(row, "category"),
      subtype: requiredString(row, "subtype"),
      keywords: json(requiredString(row, "keywords_json"), []),
      directed: booleanValue(row, "directed"),
      currentStatus: requiredString(row, "current_status"),
      timeRange: json(requiredString(row, "time_range_json"), {}),
      confidence: numberValue(row, "confidence"),
      evidence: json(requiredString(row, "evidence_json"), []),
      confirmationStatus: requiredString(row, "confirmation_status"),
      locked: booleanValue(row, "locked"),
      versionNo: this.currentEntityVersionNo("relationship", requiredString(row, "id")),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at")
    };
  }

  private normalizeRelationshipKeywords(keywords: string[]): string[] {
    const values = keywords.map((keyword) => keyword.normalize("NFKC").trim().replace(/\s+/gu, " ")).filter(Boolean);
    return [...new Map(values.map((keyword) => [keyword.toLocaleLowerCase("zh-CN"), keyword])).values()].slice(0, 30);
  }

  private assertRelationshipUnique(
    workId: string,
    fromCharacterId: string,
    toCharacterId: string,
    category: string,
    subtype: string,
    directed: boolean,
    excludeRelationshipId?: string
  ): void {
    const normalizedSubtype = subtype.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
    const duplicate = this.listRelationships(workId).find((relationship) => {
      if (excludeRelationshipId && relationship.id === excludeRelationshipId) return false;
      const same = relationship.fromCharacterId === fromCharacterId && relationship.toCharacterId === toCharacterId;
      const reverse = !directed && !relationship.directed
        && relationship.fromCharacterId === toCharacterId && relationship.toCharacterId === fromCharacterId;
      return (same || reverse)
        && Boolean(relationship.directed) === directed
        && relationship.category === category
        && String(relationship.subtype).normalize("NFKC").trim().toLocaleLowerCase("zh-CN") === normalizedSubtype
        && relationship.confirmationStatus !== "rejected";
    });
    if (duplicate) throw new AppError(409, "RELATIONSHIP_CONFLICT", "相同人物、类型与方向的关系已经存在", { relationshipId: duplicate.id });
  }

  createReviewItem(workId: string, input: ReviewInput): Record<string, unknown> {
    this.getWork(workId);
    const reviewId = id("review");
    const timestamp = now();
    const result = this.db.run(
      `INSERT OR IGNORE INTO review_items (id, work_id, item_type, dedupe_key, severity, title, description, entity_refs_json, evidence_json,
       suggestion, status, resolution_note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      reviewId,
      workId,
      input.itemType,
      input.dedupeKey ?? "",
      input.severity ?? "medium",
      input.title,
      input.description ?? "",
      JSON.stringify(input.entityRefs ?? []),
      JSON.stringify(input.evidence ?? []),
      input.suggestion ?? "",
      input.status ?? "pending",
      input.resolutionNote ?? "",
      timestamp,
      timestamp
    );
    if (result.changes === 0 && input.dedupeKey) {
      const existing = this.db.get(
        "SELECT * FROM review_items WHERE work_id = ? AND item_type = ? AND dedupe_key = ?",
        workId,
        input.itemType,
        input.dedupeKey
      );
      if (existing) return this.mapReviewItem(existing);
    }
    return this.getReviewItem(reviewId);
  }

  listReviewItems(workId: string, status?: string): Record<string, unknown>[] {
    this.getWork(workId);
    const rows = status
      ? this.db.all("SELECT * FROM review_items WHERE work_id = ? AND status = ? ORDER BY created_at DESC", workId, status)
      : this.db.all("SELECT * FROM review_items WHERE work_id = ? ORDER BY created_at DESC", workId);
    return rows.map((row) => this.mapReviewItem(row));
  }

  listReviewItemsPage(workId: string, pagination: Pagination, status?: string): PaginatedResult<Record<string, unknown>> {
    this.getWork(workId);
    const page = paginationSql(pagination);
    const rows = status
      ? this.db.all(`SELECT * FROM review_items WHERE work_id = ? AND status = ? ORDER BY created_at DESC${page.sql}`, workId, status, ...page.params)
      : this.db.all(`SELECT * FROM review_items WHERE work_id = ? ORDER BY created_at DESC${page.sql}`, workId, ...page.params);
    return paginated(rows.map((row) => this.mapReviewItem(row)), pagination);
  }

  getReviewItem(reviewId: string): Record<string, unknown> {
    const row = this.db.get("SELECT * FROM review_items WHERE id = ?", reviewId);
    if (!row) throw notFound("审核项");
    return this.mapReviewItem(row);
  }

  updateReviewItem(reviewId: string, input: Partial<ReviewInput>): Record<string, unknown> {
    const current = this.getReviewItem(reviewId);
    this.db.run(
      `UPDATE review_items SET item_type = ?, severity = ?, title = ?, description = ?, entity_refs_json = ?,
       evidence_json = ?, suggestion = ?, status = ?, resolution_note = ?, updated_at = ? WHERE id = ?`,
      input.itemType ?? String(current.itemType),
      input.severity ?? String(current.severity),
      input.title ?? String(current.title),
      input.description ?? String(current.description),
      JSON.stringify(input.entityRefs ?? current.entityRefs),
      JSON.stringify(input.evidence ?? current.evidence),
      input.suggestion ?? String(current.suggestion),
      input.status ?? String(current.status),
      input.resolutionNote ?? String(current.resolutionNote),
      now(),
      reviewId
    );
    this.audit(String(current.workId), "review.updated", "review", reviewId, { status: input.status });
    return this.getReviewItem(reviewId);
  }

  private mapReviewItem(row: Row): Record<string, unknown> {
    return {
      id: requiredString(row, "id"),
      workId: requiredString(row, "work_id"),
      itemType: requiredString(row, "item_type"),
      severity: requiredString(row, "severity"),
      title: requiredString(row, "title"),
      description: requiredString(row, "description"),
      entityRefs: json(requiredString(row, "entity_refs_json"), []),
      evidence: json(requiredString(row, "evidence_json"), []),
      suggestion: requiredString(row, "suggestion"),
      status: requiredString(row, "status"),
      resolutionNote: requiredString(row, "resolution_note"),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at")
    };
  }

  createContinuationGuard(input: {
    suggestionId: string;
    callId?: string | null;
    chapterVersion: number;
    content: string;
    status: "clear" | "warning" | "failed";
    issues?: unknown[];
    contextRefs?: Record<string, unknown>;
    failure?: string | null;
  }): Record<string, unknown> {
    const suggestion = this.db.get("SELECT work_id FROM ai_suggestions WHERE id = ?", input.suggestionId);
    if (!suggestion) throw notFound("AI 建议");
    const guardId = id("guard");
    const contentHash = createHash("sha256").update(input.content).digest("hex");
    this.db.run(
      `INSERT INTO continuation_guard_runs (id, suggestion_id, call_id, chapter_version, content_hash,
       status, issues_json, context_refs_json, failure, created_at, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      guardId,
      input.suggestionId,
      input.callId ?? null,
      input.chapterVersion,
      contentHash,
      input.status,
      JSON.stringify(input.issues ?? []),
      JSON.stringify(input.contextRefs ?? {}),
      input.failure ?? null,
      now(),
      currentRequestActor()?.userId ?? null
    );
    this.audit(requiredString(suggestion, "work_id"), "continuation.guard.created", "continuation-guard", guardId, {
      suggestionId: input.suggestionId,
      status: input.status,
      issueCount: input.issues?.length ?? 0
    });
    return this.getContinuationGuard(guardId);
  }

  getContinuationGuard(guardId: string): Record<string, unknown> {
    const row = this.db.get("SELECT * FROM continuation_guard_runs WHERE id = ?", guardId);
    if (!row) throw notFound("续写一致性检查");
    return this.mapContinuationGuard(row);
  }

  listContinuationGuards(suggestionId: string): Record<string, unknown>[] {
    const suggestion = this.db.get("SELECT id FROM ai_suggestions WHERE id = ?", suggestionId);
    if (!suggestion) throw notFound("AI 建议");
    return this.db.all(
      "SELECT * FROM continuation_guard_runs WHERE suggestion_id = ? ORDER BY created_at DESC",
      suggestionId
    ).map((row) => this.mapContinuationGuard(row));
  }

  listContinuationGuardsPage(suggestionId: string, pagination: Pagination): PaginatedResult<Record<string, unknown>> {
    const suggestion = this.db.get("SELECT id FROM ai_suggestions WHERE id = ?", suggestionId);
    if (!suggestion) throw notFound("AI 建议");
    const page = paginationSql(pagination);
    const rows = this.db.all(
      `SELECT * FROM continuation_guard_runs WHERE suggestion_id = ? ORDER BY created_at DESC${page.sql}`,
      suggestionId,
      ...page.params
    );
    return paginated(rows.map((row) => this.mapContinuationGuard(row)), pagination);
  }

  getLatestContinuationGuard(suggestionId: string): Record<string, unknown> | null {
    const row = this.db.get(
      "SELECT * FROM continuation_guard_runs WHERE suggestion_id = ? ORDER BY created_at DESC LIMIT 1",
      suggestionId
    );
    return row ? this.mapContinuationGuard(row) : null;
  }

  createAiConversation(workId: string, title = "新对话", taskType: AiConversationTaskType | null = null): Record<string, unknown> {
    this.getWork(workId);
    const conversationId = id("conversation");
    const timestamp = now();
    const agentTools = normalizeWorkAgentTools(this.getWorkAiSettings(workId).agentTools);
    this.db.transaction(() => {
      this.db.run(
        "INSERT INTO ai_conversations (id, work_id, task_type, title, agent_tools_json, created_at, updated_at, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        conversationId,
        workId,
        taskType,
        title.trim() || "新对话",
        JSON.stringify(agentTools),
        timestamp,
        timestamp,
        currentRequestActor()?.userId ?? null
      );
      this.syncAiHistorySearchShortTermsForSource("conversation", conversationId);
    });
    return this.getAiConversation(conversationId);
  }

  listAiConversations(workId: string, userId?: string): Record<string, unknown>[] {
    this.getWork(workId);
    return this.db.all(
      `SELECT conversation.*,
        (SELECT COUNT(*) FROM ai_conversation_messages message WHERE message.conversation_id = conversation.id) AS message_count,
        COALESCE((SELECT content FROM ai_conversation_messages message WHERE message.conversation_id = conversation.id ORDER BY message.created_at DESC, message.rowid DESC LIMIT 1), '') AS preview
       FROM ai_conversations conversation
       WHERE conversation.work_id = ?
         AND (? IS NULL OR conversation.created_by_user_id = ?)
       ORDER BY conversation.is_favorite DESC, conversation.updated_at DESC, conversation.created_at DESC
       LIMIT 100`,
      workId,
      userId ?? null,
      userId ?? null
    ).map((row) => this.mapAiConversation(row));
  }

  listAiConversationsPage(workId: string, pagination: Pagination, userId?: string): PaginatedResult<Record<string, unknown>> {
    this.getWork(workId);
    const page = paginationSql(pagination);
    const rows = this.db.all(
      `SELECT conversation.*,
        (SELECT COUNT(*) FROM ai_conversation_messages message WHERE message.conversation_id = conversation.id) AS message_count,
        COALESCE((SELECT content FROM ai_conversation_messages message WHERE message.conversation_id = conversation.id ORDER BY message.created_at DESC, message.rowid DESC LIMIT 1), '') AS preview
       FROM ai_conversations conversation
       WHERE conversation.work_id = ?
         AND (? IS NULL OR conversation.created_by_user_id = ?)
       ORDER BY conversation.is_favorite DESC, conversation.updated_at DESC, conversation.created_at DESC${page.sql}`,
      workId,
      userId ?? null,
      userId ?? null,
      ...page.params
    );
    return paginated(rows.map((row) => this.mapAiConversation(row)), pagination);
  }

  assertAiConversationOwner(conversationId: string, userId: string): void {
    const conversation = this.db.get("SELECT created_by_user_id FROM ai_conversations WHERE id = ?", conversationId);
    if (!conversation) throw notFound("AI 对话");
    if (optionalString(conversation, "created_by_user_id") !== userId) {
      throw new AppError(403, "AI_CONVERSATION_ACCESS_DENIED", "你只能访问自己创建的 AI 对话");
    }
  }

  listAdminAiConversationsPage(
    pagination: Pagination,
    filters: AdminAiConversationFilters = {}
  ): PaginatedResult<Record<string, unknown>> {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (filters.workId) {
      where.push("conversation.work_id = ?");
      params.push(filters.workId);
    }
    if (filters.userId) {
      where.push("conversation.created_by_user_id = ?");
      params.push(filters.userId);
    }
    const normalizedQuery = filters.query?.normalize("NFKC").trim() ?? "";
    if (normalizedQuery) {
      const pattern = `%${escapeSqlLikePattern(normalizedQuery)}%`;
      where.push(`(
        conversation.title LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR work.title LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR creator.username LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR creator.display_name LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR EXISTS (
          SELECT 1 FROM ai_conversation_messages searched_message
          WHERE searched_message.conversation_id = conversation.id
            AND searched_message.content LIKE ? ESCAPE '\\' COLLATE NOCASE
        )
      )`);
      params.push(pattern, pattern, pattern, pattern, pattern);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const page = paginationSql(pagination);
    const rows = this.db.all(
      `SELECT conversation.*,
        work.title AS work_title,
        work.deleted_at AS work_deleted_at,
        creator.username AS creator_username,
        creator.display_name AS creator_display_name,
        creator.role AS creator_role,
        creator.status AS creator_status,
        (SELECT COUNT(*) FROM ai_conversation_messages message WHERE message.conversation_id = conversation.id) AS message_count,
        COALESCE((SELECT content FROM ai_conversation_messages message WHERE message.conversation_id = conversation.id ORDER BY message.created_at DESC, message.rowid DESC LIMIT 1), '') AS preview
       FROM ai_conversations conversation
       JOIN works work ON work.id = conversation.work_id
       LEFT JOIN users creator ON creator.id = conversation.created_by_user_id
       ${whereSql}
       ORDER BY conversation.updated_at DESC, conversation.created_at DESC${page.sql}`,
      ...params,
      ...page.params
    );
    return paginated(rows.map((row) => ({
      ...this.mapAiConversation(row),
      work: {
        id: requiredString(row, "work_id"),
        title: requiredString(row, "work_title"),
        deleted: Boolean(optionalString(row, "work_deleted_at"))
      },
      creator: optionalString(row, "created_by_user_id") ? {
        userId: requiredString(row, "created_by_user_id"),
        username: requiredString(row, "creator_username"),
        displayName: requiredString(row, "creator_display_name"),
        role: requiredString(row, "creator_role"),
        status: requiredString(row, "creator_status")
      } : null
    })), pagination);
  }

  getAiConversationSummary(conversationId: string): Record<string, unknown> {
    const row = this.db.get(
      `SELECT conversation.*,
        (SELECT COUNT(*) FROM ai_conversation_messages message WHERE message.conversation_id = conversation.id) AS message_count,
        COALESCE((SELECT content FROM ai_conversation_messages message WHERE message.conversation_id = conversation.id ORDER BY message.created_at DESC, message.rowid DESC LIMIT 1), '') AS preview
       FROM ai_conversations conversation
       WHERE conversation.id = ?`,
      conversationId
    );
    if (!row) throw notFound("AI 对话");
    return this.mapAiConversation(row);
  }

  getAiConversation(conversationId: string): Record<string, unknown> {
    const row = this.db.get("SELECT * FROM ai_conversations WHERE id = ?", conversationId);
    if (!row) throw notFound("AI 对话");
    const messages = this.db.all(
      "SELECT * FROM ai_conversation_messages WHERE conversation_id = ? ORDER BY created_at, rowid",
      conversationId
    ).map((message) => this.mapAiConversationMessage(message));
    return { ...this.mapAiConversation(row), messageCount: messages.length, messages };
  }

  getAiConversationPage(conversationId: string, pagination: Pagination, focusMessageId?: string): Record<string, unknown> {
    const row = this.db.get("SELECT * FROM ai_conversations WHERE id = ?", conversationId);
    if (!row) throw notFound("AI 对话");
    const countRow = this.db.get("SELECT COUNT(*) AS count FROM ai_conversation_messages WHERE conversation_id = ?", conversationId);
    let effectivePagination = pagination;
    if (focusMessageId) {
      const focused = this.db.get(
        "SELECT rowid, created_at FROM ai_conversation_messages WHERE conversation_id = ? AND id = ?",
        conversationId,
        focusMessageId
      );
      if (focused) {
        const newerCount = this.db.get(
          `SELECT COUNT(*) AS count FROM ai_conversation_messages
           WHERE conversation_id = ?
             AND (created_at > ? OR (created_at = ? AND rowid > ?))`,
          conversationId,
          String(focused.created_at ?? ""),
          String(focused.created_at ?? ""),
          Number(focused.rowid ?? 0)
        );
        const focusPage = Math.floor(Number(newerCount?.count ?? 0) / pagination.limit) + 1;
        effectivePagination = {
          ...pagination,
          page: focusPage,
          offset: (focusPage - 1) * pagination.limit
        };
      }
    }
    const page = paginationSql(effectivePagination);
    const rows = this.db.all(
      `SELECT * FROM ai_conversation_messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC${page.sql}`,
      conversationId,
      ...page.params
    );
    const messagesPage = paginated(rows.map((message) => this.mapAiConversationMessage(message)), effectivePagination);
    messagesPage.items.reverse();
    return {
      ...this.mapAiConversation(row),
      messageCount: Number(countRow?.count ?? 0),
      messages: messagesPage.items,
      messagesPage
    };
  }

  getAiConversationContext(conversationId: string, workId: string, excludeMessageId?: string): AiConversationContext {
    const conversation = this.db.get("SELECT * FROM ai_conversations WHERE id = ?", conversationId);
    if (!conversation) throw notFound("AI 对话");
    if (requiredString(conversation, "work_id") !== workId) throw new AppError(400, "CONVERSATION_WORK_MISMATCH", "AI 对话不属于当前作品");
    const countRow = this.db.get(
      "SELECT COUNT(*) AS count FROM ai_conversation_messages WHERE conversation_id = ?",
      conversationId
    );
    const totalMessageCount = numberValue(countRow ?? {}, "count");
    const compactedMessageCount = Math.min(totalMessageCount, Math.max(0, numberValue(conversation, "compacted_message_count")));
    const tailMessageCount = totalMessageCount - compactedMessageCount;
    let rows: Row[] = [];
    if (tailMessageCount > 0 && compactedMessageCount === 0) {
      rows = this.db.all(
        `SELECT id, role, content, metadata_json FROM ai_conversation_messages
         WHERE conversation_id = ? ORDER BY created_at, rowid LIMIT ?`,
        conversationId,
        tailMessageCount
      );
    } else if (tailMessageCount > 0) {
      const boundary = this.db.get(
        `SELECT created_at, rowid FROM ai_conversation_messages
         WHERE conversation_id = ? ORDER BY created_at, rowid LIMIT 1 OFFSET ?`,
        conversationId,
        compactedMessageCount - 1
      );
      if (boundary) {
        rows = this.db.all(
          `SELECT id, role, content, metadata_json FROM ai_conversation_messages
           WHERE conversation_id = ?
             AND (created_at > ? OR (created_at = ? AND rowid > ?))
           ORDER BY created_at, rowid LIMIT ?`,
          conversationId,
          requiredString(boundary, "created_at"),
          requiredString(boundary, "created_at"),
          numberValue(boundary, "rowid"),
          tailMessageCount
        );
      }
    }
    return {
      workId,
      roleplayCharacterId: optionalString(conversation, "roleplay_character_id"),
      roleplayUserCharacterId: optionalString(conversation, "roleplay_user_character_id"),
      summary: requiredString(conversation, "compacted_summary"),
      compactedMessageCount,
      totalMessageCount,
      warningPending: Boolean(optionalString(conversation, "context_warning_at")),
      injectedEntities: parseAiInjectedEntities(optionalString(conversation, "injected_entities_json") ?? EMPTY_AI_INJECTED_ENTITIES),
      scenePin: normalizeRoleplayScenePin(json(optionalString(conversation, "scene_pin_json") ?? "{}", {})),
      messages: rows.filter((message) => requiredString(message, "id") !== excludeMessageId)
        .map((message) => ({
          id: requiredString(message, "id"),
          role: requiredString(message, "role") === "assistant" ? "assistant" : "user",
          content: requiredString(message, "content"),
          metadata: json<Record<string, unknown>>(requiredString(message, "metadata_json"), {})
        }))
    };
  }

  getAiConversationLockedModelId(conversationId: string, workId: string): string | null {
    const conversation = this.db.get("SELECT work_id FROM ai_conversations WHERE id = ?", conversationId);
    if (!conversation) throw notFound("AI 对话");
    if (requiredString(conversation, "work_id") !== workId) throw new AppError(400, "CONVERSATION_WORK_MISMATCH", "AI 对话不属于当前作品");
    return this.aiConversationLockedModelId(conversationId);
  }

  getAiConversationHasImageAttachments(conversationId: string, workId: string): boolean {
    const conversation = this.db.get("SELECT work_id FROM ai_conversations WHERE id = ?", conversationId);
    if (!conversation) throw notFound("AI 对话");
    if (requiredString(conversation, "work_id") !== workId) throw new AppError(400, "CONVERSATION_WORK_MISMATCH", "AI 对话不属于当前作品");
    return this.aiConversationHasImageAttachments(conversationId);
  }

  private aiConversationLockedModelId(conversationId: string): string | null {
    const messages = this.db.all(
      `SELECT metadata_json FROM ai_conversation_messages
       WHERE conversation_id = ? AND role = 'user'
       ORDER BY created_at, rowid`,
      conversationId
    );
    for (const message of messages) {
      const metadata = json<Record<string, unknown>>(requiredString(message, "metadata_json"), {});
      if (typeof metadata.modelId === "string" && metadata.modelId.trim()) return metadata.modelId.trim();
    }
    return null;
  }

  private aiConversationHasImageAttachments(conversationId: string): boolean {
    const messages = this.db.all(
      `SELECT metadata_json FROM ai_conversation_messages
       WHERE conversation_id = ? AND role = 'user'
       ORDER BY created_at, rowid`,
      conversationId
    );
    return messages.some((message) => {
      const metadata = json<Record<string, unknown>>(requiredString(message, "metadata_json"), {});
      return Array.isArray(metadata.chatImageAttachmentIds)
        && metadata.chatImageAttachmentIds.some((attachmentId) => typeof attachmentId === "string" && attachmentId.trim().length > 0);
    });
  }

  getAiConversationInjectedEntities(conversationId: string, workId: string): AiInjectedEntities {
    const conversation = this.db.get("SELECT work_id, injected_entities_json FROM ai_conversations WHERE id = ?", conversationId);
    if (!conversation) throw notFound("AI 对话");
    if (requiredString(conversation, "work_id") !== workId) throw new AppError(400, "CONVERSATION_WORK_MISMATCH", "AI 对话不属于当前作品");
    return parseAiInjectedEntities(optionalString(conversation, "injected_entities_json") ?? EMPTY_AI_INJECTED_ENTITIES);
  }

  mergeAiConversationInjectedEntities(conversationId: string, workId: string, extra: Partial<AiInjectedEntities>): AiInjectedEntities {
    const conversation = this.db.get("SELECT work_id, injected_entities_json FROM ai_conversations WHERE id = ?", conversationId);
    if (!conversation) throw notFound("AI 对话");
    if (requiredString(conversation, "work_id") !== workId) throw new AppError(400, "CONVERSATION_WORK_MISMATCH", "AI 对话不属于当前作品");
    const merged = mergeAiInjectedEntities(
      parseAiInjectedEntities(optionalString(conversation, "injected_entities_json") ?? EMPTY_AI_INJECTED_ENTITIES),
      extra
    );
    this.db.run(
      "UPDATE ai_conversations SET injected_entities_json = ?, updated_at = ? WHERE id = ?",
      JSON.stringify(merged),
      now(),
      conversationId
    );
    return merged;
  }

  /** 对话首轮写入 system 时钟文案；已有值则原样返回，禁止后续覆盖。 */
  ensureAiConversationSystemClock(conversationId: string, workId: string, candidate: string): string {
    const conversation = this.db.get("SELECT work_id, system_clock_text FROM ai_conversations WHERE id = ?", conversationId);
    if (!conversation) throw notFound("AI 对话");
    if (requiredString(conversation, "work_id") !== workId) throw new AppError(400, "CONVERSATION_WORK_MISMATCH", "AI 对话不属于当前作品");
    const existing = (optionalString(conversation, "system_clock_text") ?? "").trim();
    if (existing) return existing;
    const clock = candidate.trim();
    if (!clock) return "";
    this.db.run(
      "UPDATE ai_conversations SET system_clock_text = ? WHERE id = ? AND TRIM(system_clock_text) = ''",
      clock,
      conversationId
    );
    const refreshed = this.db.get("SELECT system_clock_text FROM ai_conversations WHERE id = ?", conversationId);
    return (optionalString(refreshed ?? {}, "system_clock_text") ?? clock).trim() || clock;
  }

  setAiConversationScenePin(conversationId: string, workId: string, pin: unknown): RoleplayScenePin {
    const conversation = this.db.get("SELECT work_id FROM ai_conversations WHERE id = ?", conversationId);
    if (!conversation) throw notFound("AI 对话");
    if (requiredString(conversation, "work_id") !== workId) throw new AppError(400, "CONVERSATION_WORK_MISMATCH", "AI 对话不属于当前作品");
    const normalized = normalizeRoleplayScenePin(pin);
    this.db.run(
      "UPDATE ai_conversations SET scene_pin_json = ?, updated_at = ? WHERE id = ?",
      JSON.stringify(normalized),
      now(),
      conversationId
    );
    return normalized;
  }

  listCharacterNameEntries(workId: string): Array<{ characterId: string; normalizedName: string; displayName: string; kind: "primary" | "alias" }> {
    this.getWork(workId);
    return this.db.all(
      `SELECT character_id, normalized_name, display_name, kind FROM character_names
       WHERE work_id = ?
         AND character_id NOT IN (SELECT id FROM characters WHERE work_id = ? AND merged_into_character_id IS NOT NULL)
       ORDER BY LENGTH(normalized_name) DESC, sort_order ASC`,
      workId,
      workId
    ).map((row) => ({
      characterId: requiredString(row, "character_id"),
      normalizedName: requiredString(row, "normalized_name"),
      displayName: requiredString(row, "display_name"),
      kind: requiredString(row, "kind") === "alias" ? "alias" as const : "primary" as const
    }));
  }

  getAiConversationTitleContext(conversationId: string, workId: string): AiConversationTitleContext {
    const conversation = this.db.get("SELECT title, work_id FROM ai_conversations WHERE id = ?", conversationId);
    if (!conversation) throw notFound("AI 对话");
    if (requiredString(conversation, "work_id") !== workId) throw new AppError(400, "CONVERSATION_WORK_MISMATCH", "AI 对话不属于当前作品");
    const messages = this.db.all(
      "SELECT role, content FROM ai_conversation_messages WHERE conversation_id = ? ORDER BY created_at, rowid",
      conversationId
    ).map((message) => ({
      role: requiredString(message, "role") === "assistant" ? "assistant" as const : "user" as const,
      content: requiredString(message, "content")
    }));
    return { title: requiredString(conversation, "title"), messages };
  }

  setAiConversationContextWarning(conversationId: string, pending: boolean): void {
    const conversation = this.db.get("SELECT id FROM ai_conversations WHERE id = ?", conversationId);
    if (!conversation) throw notFound("AI 对话");
    this.db.run("UPDATE ai_conversations SET context_warning_at = ? WHERE id = ?", pending ? now() : null, conversationId);
  }

  saveAiConversationCompaction(conversationId: string, summary: string, compactedMessageCount: number): Record<string, unknown> {
    const conversation = this.db.get("SELECT id FROM ai_conversations WHERE id = ?", conversationId);
    if (!conversation) throw notFound("AI 对话");
    this.db.transaction(() => {
      this.db.run(
        "UPDATE ai_conversations SET compacted_summary = ?, compacted_message_count = ?, context_warning_at = NULL, updated_at = ? WHERE id = ?",
        summary,
        Math.max(0, compactedMessageCount),
        now(),
        conversationId
      );
      this.syncAiHistorySearchShortTermsForSource("conversation", conversationId);
    });
    return this.getAiConversation(conversationId);
  }

  setAiConversationTitle(conversationId: string, title: string): Record<string, unknown> {
    const conversation = this.db.get("SELECT id FROM ai_conversations WHERE id = ?", conversationId);
    if (!conversation) throw notFound("AI 对话");
    const normalizedTitle = title.replace(/\s+/gu, " ").trim().slice(0, 200) || "新对话";
    this.db.transaction(() => {
      this.db.run("UPDATE ai_conversations SET title = ?, updated_at = ? WHERE id = ?", normalizedTitle, now(), conversationId);
      this.syncAiHistorySearchShortTermsForSource("conversation", conversationId);
    });
    return this.getAiConversation(conversationId);
  }

  setAiConversationFavorite(conversationId: string, isFavorite: boolean): Record<string, unknown> {
    const conversation = this.db.get("SELECT id, work_id, is_favorite FROM ai_conversations WHERE id = ?", conversationId);
    if (!conversation) throw notFound("AI 对话");
    const workId = requiredString(conversation, "work_id");
    const previousFavorite = booleanValue(conversation, "is_favorite");
    if (previousFavorite === isFavorite) return this.getAiConversationSummary(conversationId);
    this.db.transaction(() => {
      this.db.run("UPDATE ai_conversations SET is_favorite = ? WHERE id = ?", isFavorite ? 1 : 0, conversationId);
      this.audit(workId, "ai-conversation.favorite-updated", "ai-conversation", conversationId, {
        previousFavorite,
        isFavorite
      });
    });
    return this.getAiConversationSummary(conversationId);
  }

  deleteAiConversation(conversationId: string): void {
    const conversation = this.db.get("SELECT id, work_id, is_favorite FROM ai_conversations WHERE id = ?", conversationId);
    if (!conversation) throw notFound("AI 对话");
    if (booleanValue(conversation, "is_favorite")) {
      throw new AppError(409, "AI_CONVERSATION_FAVORITED", "收藏的对话不能清理，请先取消收藏");
    }
    const workId = requiredString(conversation, "work_id");
    this.db.transaction(() => {
      this.db.run("DELETE FROM ai_conversations WHERE id = ?", conversationId);
      this.audit(workId, "ai-conversation.deleted", "ai-conversation", conversationId, {});
    });
  }

  setAiConversationRoleplayCharacter(
    conversationId: string,
    characterId: string | null,
    userCharacterId?: string | null
  ): Record<string, unknown> {
    const conversation = this.db.get("SELECT * FROM ai_conversations WHERE id = ?", conversationId);
    if (!conversation) throw notFound("AI 对话");
    const workId = requiredString(conversation, "work_id");
    const previousCharacterId = optionalString(conversation, "roleplay_character_id");
    const previousUserCharacterId = optionalString(conversation, "roleplay_user_character_id");
    if (!characterId && userCharacterId) {
      throw new AppError(400, "ROLEPLAY_USER_CHARACTER_REQUIRES_AI", "请先选择 AI 扮演的角色");
    }
    const nextUserCharacterId = !characterId
      ? null
      : userCharacterId === undefined
        ? previousCharacterId === characterId ? previousUserCharacterId : null
        : userCharacterId;
    if (characterId && characterId === nextUserCharacterId) {
      throw new AppError(400, "ROLEPLAY_CHARACTER_SAME_AS_USER", "AI 扮演角色与用户扮演角色不能相同");
    }
    if (previousCharacterId === characterId && previousUserCharacterId === nextUserCharacterId) {
      return this.getAiConversationSummary(conversationId);
    }
    const messageCount = Number(this.db.get(
      "SELECT COUNT(*) AS count FROM ai_conversation_messages WHERE conversation_id = ?",
      conversationId
    )?.count ?? 0);
    if (messageCount > 0) {
      throw new AppError(
        409,
        previousCharacterId ? "ROLEPLAY_CHARACTER_LOCKED" : "ROLEPLAY_CONVERSATION_STARTED",
        previousCharacterId ? "角色扮演对话开始后不能退出模式或更换角色卡" : "当前对话已经开始，不能中途切换为角色扮演"
      );
    }
    if (characterId) {
      const character = this.getCharacter(characterId);
      if (String(character.workId) !== workId) {
        throw new AppError(400, "ROLEPLAY_CHARACTER_WORK_MISMATCH", "角色卡不属于当前作品");
      }
      if (character.mergedIntoCharacterId) {
        throw new AppError(409, "ROLEPLAY_CHARACTER_MERGED", "已合并角色不能用于角色扮演");
      }
    }
    if (nextUserCharacterId) {
      const userCharacter = this.getCharacter(nextUserCharacterId);
      if (String(userCharacter.workId) !== workId) {
        throw new AppError(400, "ROLEPLAY_USER_CHARACTER_WORK_MISMATCH", "用户扮演的角色不属于当前作品");
      }
      if (userCharacter.mergedIntoCharacterId) {
        throw new AppError(409, "ROLEPLAY_USER_CHARACTER_MERGED", "已合并角色不能用于关系扮演");
      }
    }
    this.db.transaction(() => {
      this.db.run(
        "UPDATE ai_conversations SET roleplay_character_id = ?, roleplay_user_character_id = ?, task_type = CASE WHEN ? IS NOT NULL THEN 'roleplay' ELSE task_type END, updated_at = ? WHERE id = ?",
        characterId,
        nextUserCharacterId,
        characterId,
        now(),
        conversationId
      );
      this.audit(workId, "ai-conversation.roleplay-updated", "ai-conversation", conversationId, {
        previousCharacterId,
        characterId,
        previousUserCharacterId,
        userCharacterId: nextUserCharacterId
      });
    });
    return this.getAiConversationSummary(conversationId);
  }

  setAiConversationTaskType(conversationId: string, taskType: AiConversationTaskType): Record<string, unknown> {
    const conversation = this.db.get("SELECT * FROM ai_conversations WHERE id = ?", conversationId);
    if (!conversation) throw notFound("AI 对话");
    const workId = requiredString(conversation, "work_id");
    const previousCharacterId = optionalString(conversation, "roleplay_character_id");
    const previousTaskType = optionalString(conversation, "task_type") ?? (previousCharacterId ? "roleplay" : "chat");
    if (previousTaskType === taskType) return this.getAiConversationSummary(conversationId);
    const messageCount = Number(this.db.get(
      "SELECT COUNT(*) AS count FROM ai_conversation_messages WHERE conversation_id = ?",
      conversationId
    )?.count ?? 0);
    if (messageCount > 0) {
      throw new AppError(409, "AI_CONVERSATION_TASK_LOCKED", "对话开始后不能切换任务类型");
    }
    this.db.transaction(() => {
      this.db.run(
        "UPDATE ai_conversations SET task_type = ?, roleplay_character_id = CASE WHEN ? = 'roleplay' THEN roleplay_character_id ELSE NULL END, roleplay_user_character_id = CASE WHEN ? = 'roleplay' THEN roleplay_user_character_id ELSE NULL END, updated_at = ? WHERE id = ?",
        taskType,
        taskType,
        taskType,
        now(),
        conversationId
      );
      this.audit(workId, "ai-conversation.task-type-updated", "ai-conversation", conversationId, {
        previousTaskType,
        taskType
      });
    });
    return this.getAiConversationSummary(conversationId);
  }

  setAiConversationContextScope(conversationId: string, scope: ContextScope): Record<string, unknown> {
    const conversation = this.db.get("SELECT * FROM ai_conversations WHERE id = ?", conversationId);
    if (!conversation) throw notFound("AI 对话");
    const workId = requiredString(conversation, "work_id");
    const assertWork = (record: Record<string, unknown>, code: string, label: string): void => {
      if (String(record.workId) !== workId) throw new AppError(400, code, `${label}不属于当前作品`);
    };
    if (scope.chapterId) assertWork(this.getChapter(scope.chapterId), "CHAPTER_WORK_MISMATCH", "章节");
    if (scope.volumeId) assertWork(this.getVolume(scope.volumeId), "VOLUME_WORK_MISMATCH", "卷");
    for (const chapterId of scope.chapterIds ?? []) assertWork(this.getChapter(chapterId), "CHAPTER_WORK_MISMATCH", "章节");
    for (const characterId of scope.characterIds ?? []) assertWork(this.getCharacter(characterId), "CHARACTER_WORK_MISMATCH", "角色");
    for (const settingId of scope.settingIds ?? []) assertWork(this.getSetting(settingId), "SETTING_WORK_MISMATCH", "设定");
    const previousScope = json<ContextScope>(optionalString(conversation, "context_scope_json") ?? "", { type: "none" });
    const serializedScope = JSON.stringify(scope);
    if (JSON.stringify(previousScope) === serializedScope) return this.getAiConversationSummary(conversationId);
    const messageCount = Number(this.db.get(
      "SELECT COUNT(*) AS count FROM ai_conversation_messages WHERE conversation_id = ?",
      conversationId
    )?.count ?? 0);
    if (messageCount > 0) {
      throw new AppError(409, "AI_CONVERSATION_CONTEXT_LOCKED", "对话开始后不能切换上下文引用");
    }
    this.db.transaction(() => {
      this.db.run(
        "UPDATE ai_conversations SET context_scope_json = ?, updated_at = ? WHERE id = ?",
        serializedScope,
        now(),
        conversationId
      );
      this.audit(workId, "ai-conversation.context-scope-updated", "ai-conversation", conversationId, {
        previousScope,
        scope
      });
    });
    return this.getAiConversationSummary(conversationId);
  }

  addAiConversationMessage(conversationId: string, input: AiConversationMessageInput): Record<string, unknown> {
    const conversation = this.db.get("SELECT * FROM ai_conversations WHERE id = ?", conversationId);
    if (!conversation) throw notFound("AI 对话");
    const requestId = input.requestId?.trim() || null;
    const persistInterruption = (message: Row): Row => {
      if (input.role !== "assistant" || input.metadata?.interrupted !== true || requiredString(message, "role") !== "assistant") {
        return message;
      }
      const currentMetadata = json<Record<string, unknown>>(requiredString(message, "metadata_json"), {});
      const nextMetadata = { ...currentMetadata, ...input.metadata, interrupted: true };
      if (JSON.stringify(currentMetadata) === JSON.stringify(nextMetadata)) return message;
      this.db.transaction(() => {
        this.db.run(
          "UPDATE ai_conversation_messages SET metadata_json = ? WHERE id = ?",
          JSON.stringify(nextMetadata),
          requiredString(message, "id")
        );
        this.db.run("UPDATE ai_conversations SET updated_at = ? WHERE id = ?", now(), conversationId);
      });
      return this.db.get("SELECT * FROM ai_conversation_messages WHERE id = ?", requiredString(message, "id")) ?? message;
    };
    if (requestId) {
      const existing = this.db.get(
        "SELECT * FROM ai_conversation_messages WHERE conversation_id = ? AND request_id = ?",
        conversationId,
        requestId
      );
      if (existing) return this.mapAiConversationMessage(persistInterruption(existing));
    }
    const messageId = id("message");
    const timestamp = now();
    const previousTitle = requiredString(conversation, "title");
    const title = previousTitle === "新对话" && input.role === "user"
      ? defaultAiConversationTitle(input.content)
      : previousTitle;
    this.db.transaction(() => {
      this.db.run(
        "INSERT INTO ai_conversation_messages (id, conversation_id, role, content, citations_json, metadata_json, request_id, created_at, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(conversation_id, request_id) WHERE request_id IS NOT NULL DO NOTHING",
        messageId,
        conversationId,
        input.role,
        input.content,
        JSON.stringify(input.citations ?? []),
        JSON.stringify(input.metadata ?? {}),
        requestId,
        timestamp,
        currentRequestActor()?.userId ?? null
      );
      const inserted = this.db.get("SELECT id FROM ai_conversation_messages WHERE id = ?", messageId);
      if (inserted) {
        this.db.run("UPDATE ai_conversations SET title = ?, updated_at = ? WHERE id = ?", title, timestamp, conversationId);
        if (title !== previousTitle) this.syncAiHistorySearchShortTermsForSource("conversation", conversationId);
        this.syncAiHistorySearchShortTermsForSource("message", messageId);
      }
    });
    const message = requestId
      ? this.db.get("SELECT * FROM ai_conversation_messages WHERE conversation_id = ? AND request_id = ?", conversationId, requestId)
      : this.db.get("SELECT * FROM ai_conversation_messages WHERE id = ?", messageId);
    if (!message) throw notFound("AI 对话消息");
    return this.mapAiConversationMessage(persistInterruption(message));
  }

  upsertAiConversationAssistantMessage(
    conversationId: string,
    requestId: string,
    content: string,
    metadata: AiConversationMessageInput["metadata"] = {},
    syncSearchIndex = false
  ): Record<string, unknown> {
    const normalizedRequestId = requestId.trim();
    if (!normalizedRequestId) throw new AppError(400, "AI_MESSAGE_REQUEST_ID_REQUIRED", "AI 助手消息缺少请求标识");
    const existing = this.db.get(
      "SELECT * FROM ai_conversation_messages WHERE conversation_id = ? AND request_id = ?",
      conversationId,
      normalizedRequestId
    );
    if (!existing) {
      return this.addAiConversationMessage(conversationId, {
        role: "assistant",
        content,
        requestId: normalizedRequestId,
        metadata
      });
    }
    if (requiredString(existing, "role") !== "assistant") {
      throw new AppError(409, "AI_MESSAGE_ROLE_MISMATCH", "请求标识已用于用户消息");
    }
    const currentMetadata = json<Record<string, unknown>>(requiredString(existing, "metadata_json"), {});
    const nextMetadata = { ...currentMetadata, ...metadata };
    const contentChanged = requiredString(existing, "content") !== content;
    const metadataChanged = JSON.stringify(currentMetadata) !== JSON.stringify(nextMetadata);
    if (!contentChanged && !metadataChanged) {
      if (syncSearchIndex) this.syncAiHistorySearchShortTermsForSource("message", requiredString(existing, "id"));
      return this.mapAiConversationMessage(existing);
    }
    const timestamp = now();
    this.db.transaction(() => {
      this.db.run(
        "UPDATE ai_conversation_messages SET content = ?, metadata_json = ? WHERE id = ?",
        content,
        JSON.stringify(nextMetadata),
        requiredString(existing, "id")
      );
      this.db.run("UPDATE ai_conversations SET updated_at = ? WHERE id = ?", timestamp, conversationId);
      if (syncSearchIndex) this.syncAiHistorySearchShortTermsForSource("message", requiredString(existing, "id"));
    });
    const updated = this.db.get("SELECT * FROM ai_conversation_messages WHERE id = ?", requiredString(existing, "id"));
    if (!updated) throw notFound("AI 对话消息");
    return this.mapAiConversationMessage(updated);
  }

  beginAiConversationStreamRequest(
    input: BeginAiConversationStreamRequestInput,
    referenceTime = new Date()
  ): BeginAiConversationStreamRequestResult {
    const timestamp = referenceTime.toISOString();
    const leaseExpiresAt = new Date(referenceTime.getTime() + AI_CONVERSATION_STREAM_REQUEST_LEASE_MS).toISOString();
    return this.db.transaction(() => {
      const conversation = this.db.get("SELECT * FROM ai_conversations WHERE id = ?", input.conversationId);
      if (!conversation) throw notFound("AI 对话");
      if (requiredString(conversation, "work_id") !== input.workId) {
        throw new AppError(400, "CONVERSATION_WORK_MISMATCH", "AI 对话不属于当前作品");
      }
      let existing = this.db.get(
        `SELECT * FROM ai_conversation_stream_requests
         WHERE actor_scope = ? AND work_id = ? AND idempotency_key = ?`,
        input.actorScope,
        input.workId,
        input.idempotencyKey
      );
      if (existing) {
        if (requiredString(existing, "status") === "in_progress"
          && String(existing.lease_expires_at ?? "") <= timestamp) {
          this.expireAiConversationStreamLease(input.conversationId, timestamp);
          existing = this.db.get("SELECT * FROM ai_conversation_stream_requests WHERE id = ?", requiredString(existing, "id"));
          if (!existing) throw notFound("AI 对话请求");
        }
        if (requiredString(existing, "conversation_id") !== input.conversationId
          || requiredString(existing, "request_hash") !== input.requestHash) {
          throw new AppError(409, "IDEMPOTENCY_KEY_REUSED", "该请求标识已用于另一项 AI 对话请求");
        }
        const request = this.mapAiConversationStreamRequest(existing);
        return {
          disposition: request.status === "in_progress" ? "in_progress" : "terminal",
          request,
          userMessage: this.aiConversationMessageOrNull(request.userMessageId),
          assistantMessage: this.aiConversationMessageOrNull(request.assistantMessageId)
        };
      }
      this.expireAiConversationStreamLease(input.conversationId, timestamp);
      const active = this.db.get(
        "SELECT id FROM ai_conversation_stream_requests WHERE conversation_id = ? AND status = 'in_progress'",
        input.conversationId
      );
      if (active) {
        throw new AppError(409, "AI_CONVERSATION_RESPONSE_IN_PROGRESS", "当前对话仍在生成回复，请等待完成或取消后再发送");
      }
      const requestId = id("chat_request");
      const existingMessage = input.userMessage.existingMessageId
        ? this.db.get(
          `SELECT * FROM ai_conversation_messages
           WHERE id = ? AND conversation_id = ? AND role = 'user'`,
          input.userMessage.existingMessageId,
          input.conversationId
        )
        : undefined;
      if (input.userMessage.existingMessageId && !existingMessage) {
        throw new AppError(400, "AI_STREAM_USER_MESSAGE_MISMATCH", "当前用户消息不属于目标 AI 对话");
      }
      const messageId = existingMessage ? requiredString(existingMessage, "id") : id("message");
      const previousTitle = requiredString(conversation, "title");
      const title = !existingMessage && previousTitle === "新对话"
        ? defaultAiConversationTitle(input.userMessage.content)
        : previousTitle;
      this.db.run(
        `INSERT INTO ai_conversation_stream_requests
           (id, work_id, conversation_id, actor_scope, idempotency_key, request_hash, status,
            lease_expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'in_progress', ?, ?, ?)`,
        requestId,
        input.workId,
        input.conversationId,
        input.actorScope,
        input.idempotencyKey,
        input.requestHash,
        leaseExpiresAt,
        timestamp,
        timestamp
      );
      if (!existingMessage) {
        this.db.run(
          `INSERT INTO ai_conversation_messages
             (id, conversation_id, role, content, citations_json, metadata_json, request_id, created_at, created_by_user_id)
           VALUES (?, ?, 'user', ?, ?, ?, ?, ?, ?)`,
          messageId,
          input.conversationId,
          input.userMessage.content,
          JSON.stringify(input.userMessage.citations ?? []),
          JSON.stringify(input.userMessage.metadata ?? {}),
          `stream:${requestId}:user`,
          timestamp,
          currentRequestActor()?.userId ?? null
        );
      }
      this.db.run("UPDATE ai_conversation_stream_requests SET user_message_id = ? WHERE id = ?", messageId, requestId);
      if (!existingMessage) {
        this.db.run("UPDATE ai_conversations SET title = ?, updated_at = ? WHERE id = ?", title, timestamp, input.conversationId);
        if (title !== previousTitle) this.syncAiHistorySearchShortTermsForSource("conversation", input.conversationId);
        this.syncAiHistorySearchShortTermsForSource("message", messageId);
      }
      const created = this.db.get("SELECT * FROM ai_conversation_stream_requests WHERE id = ?", requestId);
      if (!created) throw notFound("AI 对话请求");
      return {
        disposition: "started",
        request: this.mapAiConversationStreamRequest(created),
        userMessage: this.aiConversationMessageOrNull(messageId),
        assistantMessage: null
      };
    });
  }

  findAiConversationStreamRequest(
    actorScope: string,
    workId: string,
    idempotencyKey: string
  ): AiConversationStreamRequest | null {
    const request = this.db.get(
      `SELECT * FROM ai_conversation_stream_requests
       WHERE actor_scope = ? AND work_id = ? AND idempotency_key = ?`,
      actorScope,
      workId,
      idempotencyKey
    );
    return request ? this.mapAiConversationStreamRequest(request) : null;
  }

  assertAiConversationStreamAvailable(conversationId: string, referenceTime = new Date()): void {
    const timestamp = referenceTime.toISOString();
    this.db.transaction(() => {
      this.expireAiConversationStreamLease(conversationId, timestamp);
      const active = this.db.get(
        "SELECT id FROM ai_conversation_stream_requests WHERE conversation_id = ? AND status = 'in_progress'",
        conversationId
      );
      if (active) {
        throw new AppError(409, "AI_CONVERSATION_RESPONSE_IN_PROGRESS", "当前对话仍在生成回复，请等待完成或取消后再发送");
      }
    });
  }

  touchAiConversationStreamRequest(requestId: string, referenceTime = new Date()): boolean {
    const timestamp = referenceTime.toISOString();
    const leaseExpiresAt = new Date(referenceTime.getTime() + AI_CONVERSATION_STREAM_REQUEST_LEASE_MS).toISOString();
    return this.db.run(
      `UPDATE ai_conversation_stream_requests SET lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND status = 'in_progress'`,
      leaseExpiresAt,
      timestamp,
      requestId
    ).changes === 1;
  }

  cancelActiveAiConversationStreamRequests(referenceTime = new Date()): number {
    const timestamp = referenceTime.toISOString();
    return this.db.run(
      `UPDATE ai_conversation_stream_requests
       SET status = 'cancelled', terminal_reason = 'runtime_shutdown', lease_expires_at = NULL,
           updated_at = ?, completed_at = ?
       WHERE status = 'in_progress'`,
      timestamp,
      timestamp
    ).changes;
  }

  finishAiConversationStreamRequest(
    requestId: string,
    status: Exclude<AiConversationStreamRequestStatus, "in_progress">,
    terminalReason: string,
    assistantMessageId?: string,
    referenceTime = new Date()
  ): AiConversationStreamRequest {
    const timestamp = referenceTime.toISOString();
    return this.db.transaction(() => {
      const request = this.db.get("SELECT * FROM ai_conversation_stream_requests WHERE id = ?", requestId);
      if (!request) throw notFound("AI 对话请求");
      if (assistantMessageId) {
        const assistant = this.db.get(
          `SELECT id FROM ai_conversation_messages
           WHERE id = ? AND conversation_id = ? AND role = 'assistant'`,
          assistantMessageId,
          requiredString(request, "conversation_id")
        );
        if (!assistant) throw new AppError(400, "AI_STREAM_ASSISTANT_MISMATCH", "AI 回复消息不属于当前对话请求");
      }
      const resolvedAssistantMessageId = assistantMessageId ?? (() => {
        const userMessageId = optionalString(request, "user_message_id");
        if (!userMessageId) return null;
        const assistant = this.db.get(
          `SELECT id FROM ai_conversation_messages
           WHERE conversation_id = ? AND role = 'assistant' AND request_id = ?`,
          requiredString(request, "conversation_id"),
          `assistant:${userMessageId}`
        );
        return assistant ? requiredString(assistant, "id") : null;
      })();
      this.db.run(
        `UPDATE ai_conversation_stream_requests
         SET status = ?, terminal_reason = ?, assistant_message_id = COALESCE(assistant_message_id, ?),
             lease_expires_at = NULL, updated_at = ?, completed_at = ?
         WHERE id = ? AND status = 'in_progress'`,
        status,
        terminalReason.slice(0, 500),
        resolvedAssistantMessageId,
        timestamp,
        timestamp,
        requestId
      );
      const completed = this.db.get("SELECT * FROM ai_conversation_stream_requests WHERE id = ?", requestId);
      if (!completed) throw notFound("AI 对话请求");
      return this.mapAiConversationStreamRequest(completed);
    });
  }

  forkAiConversation(conversationId: string, messageId: string, requestedTitle?: string, requestId?: string): Record<string, unknown> {
    const conversation = this.db.get("SELECT * FROM ai_conversations WHERE id = ?", conversationId);
    if (!conversation) throw notFound("AI 对话");
    const normalizedRequestId = requestId?.trim() || null;
    if (normalizedRequestId) {
      const existingFork = this.db.get(
        "SELECT source_message_id, conversation_id FROM ai_conversation_forks WHERE source_conversation_id = ? AND request_id = ?",
        conversationId,
        normalizedRequestId
      );
      if (existingFork) {
        if (requiredString(existingFork, "source_message_id") !== messageId) {
          throw new AppError(409, "IDEMPOTENCY_KEY_REUSED", "该续写请求标识已用于另一条历史消息");
        }
        return this.getAiConversation(requiredString(existingFork, "conversation_id"));
      }
    }
    const messages = this.db.all(
      "SELECT * FROM ai_conversation_messages WHERE conversation_id = ? ORDER BY created_at, rowid",
      conversationId
    );
    const targetIndex = messages.findIndex((message) => requiredString(message, "id") === messageId);
    if (targetIndex < 0) throw notFound("AI 对话消息");
    const forkId = id("conversation");
    const timestamp = now();
    const workId = requiredString(conversation, "work_id");
    const sourceTitle = requiredString(conversation, "title");
    const sourceHasImageAttachments = this.aiConversationHasImageAttachments(conversationId);
    const sourceLockedModelId = sourceHasImageAttachments ? this.aiConversationLockedModelId(conversationId) : null;
    const title = requestedTitle?.trim() || `${sourceTitle} · 分支`;
    const sourceCompactedCount = Math.max(0, numberValue(conversation, "compacted_message_count"));
    const forkCompactedCount = targetIndex + 1 >= sourceCompactedCount ? Math.min(sourceCompactedCount, targetIndex + 1) : 0;
    const forkSummary = forkCompactedCount ? requiredString(conversation, "compacted_summary") : "";
    const injectedEntitiesJson = optionalString(conversation, "injected_entities_json")
      ?? JSON.stringify(EMPTY_AI_INJECTED_ENTITIES);
    const systemClockText = optionalString(conversation, "system_clock_text") ?? "";
    const scenePinJson = optionalString(conversation, "scene_pin_json") ?? "{}";
    this.db.transaction(() => {
      this.db.run(
        "INSERT INTO ai_conversations (id, work_id, roleplay_character_id, roleplay_user_character_id, task_type, context_scope_json, title, compacted_summary, compacted_message_count, agent_tools_json, injected_entities_json, system_clock_text, scene_pin_json, created_at, updated_at, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        forkId,
        workId,
        optionalString(conversation, "roleplay_character_id"),
        optionalString(conversation, "roleplay_user_character_id"),
        optionalString(conversation, "task_type"),
        optionalString(conversation, "context_scope_json"),
        title.slice(0, 200),
        forkSummary,
        forkCompactedCount,
        conversation.agent_tools_json == null
          ? JSON.stringify(normalizeWorkAgentTools(this.getWorkAiSettings(workId).agentTools))
          : String(conversation.agent_tools_json),
        injectedEntitiesJson,
        systemClockText,
        scenePinJson,
        timestamp,
        timestamp,
        currentRequestActor()?.userId ?? null
      );
      for (const message of messages.slice(0, targetIndex + 1)) {
        const role = requiredString(message, "role");
        const inheritedMetadata = json<Record<string, unknown>>(requiredString(message, "metadata_json"), {});
        if (role === "user") {
          if (sourceHasImageAttachments && sourceLockedModelId && typeof inheritedMetadata.modelId !== "string") {
            inheritedMetadata.modelId = sourceLockedModelId;
          } else if (!sourceHasImageAttachments) {
            delete inheritedMetadata.modelId;
          }
        }
        this.db.run(
          "INSERT INTO ai_conversation_messages (id, conversation_id, role, content, citations_json, metadata_json, request_id, created_at, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          id("message"),
          forkId,
          role,
          requiredString(message, "content"),
          requiredString(message, "citations_json"),
          JSON.stringify(inheritedMetadata),
          optionalString(message, "request_id"),
          requiredString(message, "created_at"),
          currentRequestActor()?.userId ?? null
        );
      }
      if (normalizedRequestId) {
        this.db.run(
          "INSERT INTO ai_conversation_forks (source_conversation_id, source_message_id, request_id, conversation_id, created_at) VALUES (?, ?, ?, ?, ?)",
          conversationId,
          messageId,
          normalizedRequestId,
          forkId,
          timestamp
        );
      }
      this.syncAiHistorySearchShortTermsForConversation(forkId);
      this.audit(workId, "ai-conversation.forked", "ai-conversation", forkId, {
        sourceConversationId: conversationId,
        sourceMessageId: messageId,
        messageCount: targetIndex + 1
      });
    });
    return this.getAiConversation(forkId);
  }

  private syncAiHistorySearchShortTermsForSource(sourceType: "conversation" | "message", sourceId: string): void {
    const row = this.db.get(
      "SELECT id, title, content, search_content FROM ai_history_search WHERE source_type = ? AND source_id = ?",
      sourceType,
      sourceId
    );
    if (!row) return;
    const searchId = numberValue(row, "id");
    const searchContent = sourceType === "message"
      ? normalizeDocumentSearchText(String(row.content ?? ""))
      : normalizeDocumentSearchText(`${String(row.title ?? "")}\n${String(row.content ?? "")}`);
    if (String(row.search_content ?? "") !== searchContent) {
      this.db.run("UPDATE ai_history_search SET search_content = ? WHERE id = ?", searchContent, searchId);
    }
    this.db.run("DELETE FROM ai_history_search_short_terms WHERE search_id = ?", searchId);
    for (const term of documentShortSearchTerms(searchContent)) {
      this.db.run("INSERT INTO ai_history_search_short_terms (search_id, term) VALUES (?, ?)", searchId, term);
    }
  }

  private syncAiHistorySearchShortTermsForConversation(conversationId: string): void {
    const rows = this.db.all<{ source_type: string; source_id: string }>(
      "SELECT source_type, source_id FROM ai_history_search WHERE conversation_id = ?",
      conversationId
    );
    for (const row of rows) {
      const sourceType = row.source_type === "message" ? "message" : "conversation";
      this.syncAiHistorySearchShortTermsForSource(sourceType, String(row.source_id));
    }
  }

  private mapAiConversation(row: Row): Record<string, unknown> {
    const roleplayCharacterId = optionalString(row, "roleplay_character_id");
    const roleplayUserCharacterId = optionalString(row, "roleplay_user_character_id");
    const conversationId = requiredString(row, "id");
    const lockedModelId = this.aiConversationLockedModelId(conversationId);
    const hasImageAttachments = this.aiConversationHasImageAttachments(conversationId);
    const roleplayCharacter = roleplayCharacterId
      ? this.db.get("SELECT id, name, code FROM characters WHERE id = ? AND work_id = ?", roleplayCharacterId, requiredString(row, "work_id"))
      : undefined;
    const roleplayUserCharacter = roleplayCharacterId && roleplayUserCharacterId
      ? this.db.get("SELECT id, name, code FROM characters WHERE id = ? AND work_id = ?", roleplayUserCharacterId, requiredString(row, "work_id"))
      : undefined;
    return {
      id: requiredString(row, "id"),
      workId: requiredString(row, "work_id"),
      title: requiredString(row, "title"),
      isFavorite: booleanValue(row, "is_favorite"),
      messageCount: numberValue(row, "message_count"),
      preview: roleplayUserTurnDisplayText(requiredString(row, "preview")),
      compactedMessageCount: numberValue(row, "compacted_message_count"),
      hasCompactedSummary: Boolean(requiredString(row, "compacted_summary")),
      contextWarningPending: Boolean(optionalString(row, "context_warning_at")),
      taskType: optionalString(row, "task_type") ?? (roleplayCharacterId ? "roleplay" : "chat"),
      ...(lockedModelId ? { modelId: lockedModelId } : {}),
      ...(hasImageAttachments ? { hasImageAttachments: true, modelLockedByImage: true } : {}),
      contextScope: json<ContextScope>(optionalString(row, "context_scope_json") ?? "", { type: "none" }),
      scenePin: normalizeRoleplayScenePin(json(optionalString(row, "scene_pin_json") ?? "{}", {})),
      roleplayCharacter: roleplayCharacter ? {
        id: requiredString(roleplayCharacter, "id"),
        name: requiredString(roleplayCharacter, "name"),
        code: requiredString(roleplayCharacter, "code")
      } : null,
      roleplayUserCharacter: roleplayUserCharacter ? {
        id: requiredString(roleplayUserCharacter, "id"),
        name: requiredString(roleplayUserCharacter, "name"),
        code: requiredString(roleplayUserCharacter, "code")
      } : null,
      agentTools: row.agent_tools_json == null || row.agent_tools_json === undefined
        ? null
        : normalizeWorkAgentTools(row.agent_tools_json),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at")
    };
  }

  private aiConversationMessageOrNull(messageId: string | null): Record<string, unknown> | null {
    if (!messageId) return null;
    const message = this.db.get("SELECT * FROM ai_conversation_messages WHERE id = ?", messageId);
    return message ? this.mapAiConversationMessage(message) : null;
  }

  private expireAiConversationStreamLease(conversationId: string, timestamp: string): void {
    const expired = this.db.get(
      `SELECT * FROM ai_conversation_stream_requests
       WHERE conversation_id = ? AND status = 'in_progress' AND lease_expires_at <= ?`,
      conversationId,
      timestamp
    );
    if (!expired) return;
    const userMessageId = optionalString(expired, "user_message_id");
    const assistant = userMessageId
      ? this.db.get(
        `SELECT id FROM ai_conversation_messages
         WHERE conversation_id = ? AND role = 'assistant' AND request_id = ?`,
        conversationId,
        `assistant:${userMessageId}`
      )
      : undefined;
    this.db.run(
      `UPDATE ai_conversation_stream_requests
       SET status = ?, terminal_reason = ?, assistant_message_id = ?, lease_expires_at = NULL,
           updated_at = ?, completed_at = ?
       WHERE id = ? AND status = 'in_progress'`,
      assistant ? "completed" : "abandoned",
      assistant ? "recovered_completed_response" : "lease_expired",
      assistant ? requiredString(assistant, "id") : null,
      timestamp,
      timestamp,
      requiredString(expired, "id")
    );
  }

  private mapAiConversationStreamRequest(row: Row): AiConversationStreamRequest {
    return {
      id: requiredString(row, "id"),
      workId: requiredString(row, "work_id"),
      conversationId: requiredString(row, "conversation_id"),
      actorScope: requiredString(row, "actor_scope"),
      idempotencyKey: requiredString(row, "idempotency_key"),
      requestHash: requiredString(row, "request_hash"),
      status: requiredString(row, "status") as AiConversationStreamRequestStatus,
      terminalReason: optionalString(row, "terminal_reason"),
      userMessageId: optionalString(row, "user_message_id"),
      assistantMessageId: optionalString(row, "assistant_message_id"),
      leaseExpiresAt: optionalString(row, "lease_expires_at"),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at"),
      completedAt: optionalString(row, "completed_at")
    };
  }

  /** 锁定本对话可用工具集；已锁定则保持不变，避免中途改作品设置破坏 prompt cache。 */
  ensureAiConversationAgentTools(conversationId: string, workId: string): WorkAgentToolId[] {
    const conversation = this.db.get("SELECT id, work_id, agent_tools_json FROM ai_conversations WHERE id = ?", conversationId);
    if (!conversation) throw notFound("AI 对话");
    if (requiredString(conversation, "work_id") !== workId) {
      throw new AppError(400, "CONVERSATION_WORK_MISMATCH", "AI 对话不属于当前作品");
    }
    if (conversation.agent_tools_json != null && conversation.agent_tools_json !== undefined) {
      return normalizeWorkAgentTools(conversation.agent_tools_json);
    }
    const agentTools = normalizeWorkAgentTools(this.getWorkAiSettings(workId).agentTools);
    this.db.run(
      "UPDATE ai_conversations SET agent_tools_json = ?, updated_at = ? WHERE id = ? AND agent_tools_json IS NULL",
      JSON.stringify(agentTools),
      now(),
      conversationId
    );
    const locked = this.db.get("SELECT agent_tools_json FROM ai_conversations WHERE id = ?", conversationId);
    return normalizeWorkAgentTools(locked?.agent_tools_json ?? agentTools);
  }

  private mapAiConversationMessage(row: Row): Record<string, unknown> {
    return {
      id: requiredString(row, "id"),
      conversationId: requiredString(row, "conversation_id"),
      role: requiredString(row, "role"),
      content: requiredString(row, "content"),
      citations: json(requiredString(row, "citations_json"), []),
      metadata: json(requiredString(row, "metadata_json"), {}),
      requestId: optionalString(row, "request_id"),
      createdAt: requiredString(row, "created_at")
    };
  }

  hashContent(content: string): string {
    return createHash("sha256").update(content).digest("hex");
  }

  private relationshipRosterSourceVersions(workId: string): Record<string, number | string> {
    const versions: Record<string, number | string> = {};
    for (const row of this.db.all(
      "SELECT id, version_no FROM characters WHERE work_id = ? AND merged_into_character_id IS NULL",
      workId
    )) {
      versions[`character:${requiredString(row, "id")}`] = numberValue(row, "version_no");
    }
    this.appendVersionedEntitySourceVersions(versions, workId, "race", "races");
    this.appendVersionedEntitySourceVersions(versions, workId, "organization", "organizations");
    this.appendVersionedEntitySourceVersions(versions, workId, "relationship", "relationships");
    return versions;
  }

  private appendVersionedEntitySourceVersions(
    versions: Record<string, number | string>,
    workId: string,
    entityType: VersionedEntityType,
    table: "settings" | "races" | "organizations" | "timeline_tracks" | "timeline_events" | "relationships" | "foreshadows"
  ): void {
    const rows = this.db.all(
      `SELECT entity.id, COALESCE(MAX(version.version_no), 0) AS version_no
       FROM ${table} entity
       LEFT JOIN entity_versions version
         ON version.work_id = entity.work_id AND version.entity_type = ? AND version.entity_id = entity.id
       WHERE entity.work_id = ?
       GROUP BY entity.id`,
      entityType,
      workId
    );
    for (const row of rows) {
      versions[`${entityType}:${requiredString(row, "id")}`] = numberValue(row, "version_no");
    }
  }

  private relationshipSettingsSourceVersions(workId: string): Record<string, number | string> {
    const versions = this.relationshipRosterSourceVersions(workId);
    const work = this.db.get("SELECT version_no FROM works WHERE id = ? AND deleted_at IS NULL", workId);
    if (!work) throw notFound("作品");
    versions[`work:${workId}`] = numberValue(work, "version_no");
    this.appendVersionedEntitySourceVersions(versions, workId, "setting", "settings");
    for (const row of this.db.all(
      `SELECT section.id, section.version_no
       FROM character_profile_sections section
       JOIN characters character ON character.id = section.character_id
       WHERE section.work_id = ? AND character.merged_into_character_id IS NULL`,
      workId
    )) {
      versions[`character-section:${requiredString(row, "id")}`] = numberValue(row, "version_no");
    }
    this.appendVersionedEntitySourceVersions(versions, workId, "timeline-track", "timeline_tracks");
    this.appendVersionedEntitySourceVersions(versions, workId, "timeline-event", "timeline_events");
    for (const row of this.db.all(
      `SELECT chapter.id, chapter.version_no AS chapter_version_no,
         COALESCE(MAX(version.version_no), 0) AS outline_version_no
       FROM chapter_outlines outline
       JOIN chapters chapter ON chapter.id = outline.chapter_id
       LEFT JOIN entity_versions version
         ON version.work_id = chapter.work_id
         AND version.entity_type = 'chapter-outline'
         AND version.entity_id = chapter.id
       WHERE chapter.work_id = ? AND chapter.deleted_at IS NULL
       GROUP BY chapter.id, chapter.version_no`,
      workId
    )) {
      const chapterId = requiredString(row, "id");
      versions[`chapter-meta:${chapterId}`] = numberValue(row, "chapter_version_no");
      versions[`chapter-outline:${chapterId}`] = numberValue(row, "outline_version_no");
    }
    this.appendVersionedEntitySourceVersions(versions, workId, "foreshadow", "foreshadows");
    for (const row of this.db.all("SELECT id, updated_at FROM review_items WHERE work_id = ?", workId)) {
      versions[`review:${requiredString(row, "id")}`] = requiredString(row, "updated_at");
    }
    return versions;
  }

  private analysisTaskSourceVersions(workId: string, scope: Record<string, unknown>): Record<string, number | string> {
    const sourceVersions: Record<string, number | string> = {};
    const selectedChapterIds = [
      ...(typeof scope.chapterId === "string" ? [scope.chapterId] : []),
      ...(Array.isArray(scope.chapterIds) ? scope.chapterIds.filter((value): value is string => typeof value === "string") : [])
    ];
    for (const chapterId of [...new Set(selectedChapterIds)]) {
      const chapter = this.db.get(
        "SELECT work_id, version_no, chapter_type FROM chapters WHERE id = ? AND deleted_at IS NULL",
        chapterId
      );
      if (!chapter) throw notFound("章节");
      if (requiredString(chapter, "work_id") !== workId) throw new AppError(400, "CHAPTER_WORK_MISMATCH", "章节不属于当前作品");
      if (requiredString(chapter, "chapter_type") === "作者的话") continue;
      sourceVersions[chapterId] = numberValue(chapter, "version_no");
    }
    if (scope.type === "book" || scope.type === "volume") {
      const selectedVolumeIds = [
        ...(typeof scope.volumeId === "string" ? [scope.volumeId] : []),
        ...(Array.isArray(scope.volumeIds) ? scope.volumeIds.filter((value): value is string => typeof value === "string") : [])
      ];
      const selectedVolumeIdSet = new Set(selectedVolumeIds);
      if (scope.type === "volume") {
        if (selectedVolumeIdSet.size === 0) throw notFound("卷");
        const volumePlaceholders = [...selectedVolumeIdSet].map(() => "?").join(", ");
        const volumes = this.db.all(
          `SELECT id FROM volumes WHERE work_id = ? AND deleted_at IS NULL AND id IN (${volumePlaceholders})`,
          workId,
          ...selectedVolumeIdSet
        );
        if (volumes.length !== selectedVolumeIdSet.size) throw notFound("卷");
      }
      const volumeFilter = scope.type === "volume"
        ? `AND chapter.volume_id IN (${[...selectedVolumeIdSet].map(() => "?").join(", ")})`
        : "";
      const chapterRows = this.db.all(
        `SELECT chapter.id, chapter.version_no
         FROM chapters chapter
         JOIN volumes volume ON volume.id = chapter.volume_id
         WHERE chapter.work_id = ? AND chapter.deleted_at IS NULL AND volume.deleted_at IS NULL
           AND chapter.chapter_type <> '作者的话'
           ${volumeFilter}`,
        workId,
        ...(scope.type === "volume" ? [...selectedVolumeIdSet] : [])
      );
      for (const chapter of chapterRows) {
        sourceVersions[requiredString(chapter, "id")] = numberValue(chapter, "version_no");
      }
    }
    if (scope.previewRelationshipChanges === true) {
      Object.assign(sourceVersions, this.relationshipRosterSourceVersions(workId));
    }
    if (scope.type === "settings" || (scope.includeAllSettings === true && scope.previewRelationshipChanges === true)) {
      Object.assign(sourceVersions, this.relationshipSettingsSourceVersions(workId));
    }
    return sourceVersions;
  }

  private mapContinuationGuard(row: Row): Record<string, unknown> {
    return {
      id: requiredString(row, "id"),
      suggestionId: requiredString(row, "suggestion_id"),
      callId: optionalString(row, "call_id"),
      chapterVersion: numberValue(row, "chapter_version"),
      contentHash: requiredString(row, "content_hash"),
      status: requiredString(row, "status"),
      issues: json(requiredString(row, "issues_json"), []),
      contextRefs: json(requiredString(row, "context_refs_json"), {}),
      failure: optionalString(row, "failure"),
      createdAt: requiredString(row, "created_at")
    };
  }

  createTask(workId: string, input: {
    taskType: string;
    scope?: Record<string, unknown>;
    modelId?: string;
    rerunOfTaskId?: string;
  }): Record<string, unknown> {
    this.getWork(workId);
    const taskId = id("task");
    const timestamp = now();
    const scope = { ...(input.scope ?? { type: "book" }) };
    const targetCharacters: Array<{ id: string; name: string }> = [];
    if (Array.isArray(scope.characterIds)) {
      for (const characterId of scope.characterIds) {
        if (typeof characterId !== "string") throw new AppError(400, "CHARACTER_REQUIRED", "被分析角色标识无效");
        const character = this.db.get("SELECT work_id, name FROM characters WHERE id = ?", characterId);
        if (!character) throw notFound("角色");
        if (requiredString(character, "work_id") !== workId) throw new AppError(400, "CHARACTER_WORK_MISMATCH", "被分析角色不属于当前作品");
        targetCharacters.push({ id: characterId, name: requiredString(character, "name") });
      }
      if (targetCharacters.length > 0) scope.targetCharacters = targetCharacters;
    }
    const sourceVersions = this.analysisTaskSourceVersions(workId, scope);
    const actor = currentRequestActor();
    this.db.run(
      `INSERT INTO analysis_tasks (id, work_id, model_id, task_type, scope_json, status, source_versions_json, created_at, updated_at, created_by_user_id, created_via_api_key)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      taskId,
      workId,
      input.modelId ?? null,
      input.taskType,
      JSON.stringify(scope),
      JSON.stringify(sourceVersions),
      timestamp,
      timestamp,
      actor?.userId ?? null,
      actor?.authentication === "api-key" ? 1 : 0
    );
    this.audit(workId, "task.created", "analysis-task", taskId, {
      taskType: input.taskType,
      scope,
      modelId: input.modelId ?? null,
      ...(input.rerunOfTaskId ? { rerunOfTaskId: input.rerunOfTaskId } : {})
    });
    this.notifyAnalysisTaskQueued(workId);
    return this.getTask(taskId);
  }

  listTaskSummariesPage(workId: string, pagination: Pagination): PaginatedResult<Record<string, unknown>> & {
    stats: { total: number; pendingCount: number; runningCount: number; runningProgress: number };
  } {
    this.getWork(workId);
    const statsRow = this.db.get(
      `SELECT COUNT(*) AS total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running_count,
        AVG(CASE WHEN status = 'running' THEN progress ELSE NULL END) AS running_progress
       FROM analysis_tasks WHERE work_id = ?`,
      workId
    ) ?? {};
    const total = numberValue(statsRow, "total");
    const page = paginationSql(pagination);
    const rows = this.db.all(
      `SELECT task.id, task.model_id, task.task_type, task.scope_json, task.status, task.progress,
        task.attempt_count, task.next_attempt_at, task.last_attempt_at, task.created_at, task.updated_at,
        model.display_name AS model_display_name, model.model_id AS model_api_id
       FROM analysis_tasks task
       LEFT JOIN models model ON model.id = task.model_id
       WHERE task.work_id = ? ORDER BY task.created_at DESC, task.id DESC${page.sql}`,
      workId,
      ...page.params
    );
    const chapterSummaries = new Map(this.db.all(
      `SELECT chapter.id, chapter.title, volume.title AS volume_title
       FROM chapters chapter JOIN volumes volume ON volume.id = chapter.volume_id
       WHERE chapter.work_id = ? AND chapter.deleted_at IS NULL`,
      workId
    ).map((row) => [
      requiredString(row, "id"),
      `${requiredString(row, "volume_title")} · ${requiredString(row, "title")}`
    ] as const));
    const volumeTitles = new Map(this.db.all(
      "SELECT id, title FROM volumes WHERE work_id = ?",
      workId
    ).map((row) => [requiredString(row, "id"), requiredString(row, "title")] as const));
    const characterNames = this.taskCharacterNames(workId, rows.map((row) =>
      json<Record<string, unknown>>(requiredString(row, "scope_json"), {})
    ));
    return {
      ...paginated(rows.map((row) => this.mapTaskSummary(workId, row, chapterSummaries, volumeTitles, characterNames)), pagination, total),
      stats: {
        total,
        pendingCount: numberValue(statsRow, "pending_count"),
        runningCount: numberValue(statsRow, "running_count"),
        runningProgress: numberValue(statsRow, "running_progress")
      }
    };
  }

  getTask(taskId: string): Record<string, unknown> {
    return this.mapTask(this.getTaskRow(taskId));
  }

  getTaskWorkId(taskId: string): string {
    const row = this.db.get("SELECT work_id FROM analysis_tasks WHERE id = ?", taskId);
    if (!row) throw notFound("分析任务");
    return requiredString(row, "work_id");
  }

  countRunningTasks(workId: string): number {
    const row = this.db.get(
      "SELECT COUNT(*) AS value FROM analysis_tasks WHERE work_id = ? AND status = 'running'",
      workId
    );
    return numberValue(row ?? {}, "value");
  }

  listAutoRunWorkIds(): string[] {
    return this.db.all(
      `SELECT settings.work_id FROM work_ai_settings settings
       JOIN works work ON work.id = settings.work_id
       WHERE settings.auto_run_enabled = 1 AND work.deleted_at IS NULL
       ORDER BY settings.work_id`
    ).map((row) => requiredString(row, "work_id"));
  }

  claimPendingTask(taskId: string, runningLimit?: number): Record<string, unknown> | null {
    return this.db.transaction(() => {
      const current = this.getTask(taskId);
      if (current.status !== "pending") return null;
      if (current.nextAttemptAt && String(current.nextAttemptAt) > now()) return null;
      if (runningLimit !== undefined && this.countRunningTasks(String(current.workId)) >= runningLimit) return null;
      const timestamp = now();
      const claimed = this.db.run(
        `UPDATE analysis_tasks
         SET status = 'running', progress = 5, attempt_count = attempt_count + 1,
             next_attempt_at = NULL, last_attempt_at = ?, updated_at = ?
         WHERE id = ? AND status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`,
        timestamp,
        timestamp,
        taskId,
        timestamp
      );
      return claimed.changes === 1 ? this.getTask(taskId) : null;
    });
  }

  listOldestPendingTaskIds(workId: string, limit: number): string[] {
    if (limit <= 0) return [];
    return this.db.all(
      `SELECT id FROM analysis_tasks WHERE work_id = ? AND status = 'pending'
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY created_at ASC, id ASC LIMIT ?`,
      workId,
      now(),
      limit
    ).map((row) => requiredString(row, "id"));
  }

  nextPendingTaskAttemptAt(workId: string): string | null {
    const row = this.db.get(
      `SELECT MIN(next_attempt_at) AS value FROM analysis_tasks
       WHERE work_id = ? AND status = 'pending' AND next_attempt_at IS NOT NULL`,
      workId
    );
    return row?.value === null || row?.value === undefined ? null : String(row.value);
  }

  countAutoRunAttemptsToday(workId: string): number {
    const row = this.db.get(
      `SELECT COUNT(*) AS value FROM analysis_tasks
       WHERE work_id = ? AND last_attempt_at >= strftime('%Y-%m-%dT00:00:00.000Z', 'now')`,
      workId
    );
    return numberValue(row ?? {}, "value");
  }

  rescheduleTask(taskId: string, failure: Record<string, unknown>, nextAttemptAt: string): Record<string, unknown> {
    const current = this.getTask(taskId);
    if (current.status !== "running") return current;
    const failures = Array.isArray(current.failures) ? [...current.failures, failure].slice(-10) : [failure];
    this.db.run(
      `UPDATE analysis_tasks
       SET status = 'pending', progress = 0, failure_json = ?, next_attempt_at = ?, updated_at = ?
       WHERE id = ? AND status = 'running'`,
      JSON.stringify(failures),
      nextAttemptAt,
      now(),
      taskId
    );
    this.audit(String(current.workId), "task.retry-scheduled", "analysis-task", taskId, {
      attemptCount: current.attemptCount,
      nextAttemptAt
    });
    return this.getTask(taskId);
  }

  countPendingTasks(workId: string): number {
    const row = this.db.get(
      "SELECT COUNT(*) AS value FROM analysis_tasks WHERE work_id = ? AND status = 'pending'",
      workId
    );
    return numberValue(row ?? {}, "value");
  }

  isTaskSourceCurrent(taskId: string): boolean {
    const task = this.getTask(taskId);
    const scope = task.scope as Record<string, unknown>;
    const expected = task.sourceVersions as Record<string, number | string>;
    let current: Record<string, number | string>;
    try {
      current = this.analysisTaskSourceVersions(String(task.workId), scope);
    } catch {
      return false;
    }
    const expectedIds = Object.keys(expected).sort();
    const currentIds = Object.keys(current).sort();
    return expectedIds.length === currentIds.length
      && expectedIds.every((chapterId, index) => chapterId === currentIds[index] && expected[chapterId] === current[chapterId]);
  }

  refreshTaskSourceVersions(taskId: string): void {
    const task = this.getTask(taskId);
    const scope = task.scope as Record<string, unknown>;
    if (scope.type !== "settings" && !(scope.includeAllSettings === true && scope.previewRelationshipChanges === true)) return;
    this.db.run(
      "UPDATE analysis_tasks SET source_versions_json = ?, updated_at = ? WHERE id = ?",
      JSON.stringify(this.analysisTaskSourceVersions(String(task.workId), scope)),
      now(),
      taskId
    );
  }

  cancelTask(taskId: string): Record<string, unknown> {
    const current = this.getTask(taskId);
    if (current.status === "cancelled") return current;
    if (current.status !== "pending" && current.status !== "running") {
      throw new AppError(409, "TASK_NOT_CANCELLABLE", "只有待执行或执行中的任务可以取消");
    }
    this.db.run(
      "UPDATE analysis_tasks SET status = 'cancelled', updated_at = ? WHERE id = ?",
      now(),
      taskId
    );
    this.audit(String(current.workId), "task.cancelled", "analysis-task", taskId, { previousStatus: current.status });
    return this.getTask(taskId);
  }

  updateTask(taskId: string, input: { status: string; progress?: number; result?: unknown; failures?: unknown[] }): Record<string, unknown> {
    const current = this.getTask(taskId);
    const terminal = ["completed", "partial", "failed", "review", "expired", "cancelled"];
    if (terminal.includes(String(current.status)) && input.status !== current.status) {
      throw new AppError(409, "INVALID_TASK_TRANSITION", "终态任务不能再变更状态");
    }
    this.db.run(
      "UPDATE analysis_tasks SET status = ?, progress = ?, result_json = ?, failure_json = ?, updated_at = ? WHERE id = ?",
      input.status,
      input.progress ?? Number(current.progress),
      JSON.stringify(input.result ?? current.result),
      JSON.stringify(input.failures ?? current.failures),
      now(),
      taskId
    );
    return this.getTask(taskId);
  }

  getTaskStoredResult(taskId: string): Record<string, unknown> {
    const row = this.getTaskRow(taskId, "result_json");
    return json<Record<string, unknown>>(requiredString(row, "result_json"), {});
  }

  getTaskResultPayload(taskId: string): Record<string, unknown> {
    const row = this.getTaskRow(taskId, "id, work_id, task_type, scope_json, result_json");
    return {
      id: requiredString(row, "id"),
      workId: requiredString(row, "work_id"),
      taskType: requiredString(row, "task_type"),
      scope: json<Record<string, unknown>>(requiredString(row, "scope_json"), {}),
      result: this.taskResultForClient(json<Record<string, unknown>>(requiredString(row, "result_json"), {}))
    };
  }

  getTaskDetail(taskId: string): Record<string, unknown> {
    const row = this.getTaskRow(taskId);
    const task = this.mapTask(row);
    const { result: _result, ...detail } = task;
    const storedResultJson = requiredString(row, "result_json").trim();
    const hasResult = storedResultJson !== "" && storedResultJson !== "{}" && storedResultJson !== "null";
    return {
      ...detail,
      hasResult,
      resultSummary: this.buildTaskResultSummary(task, hasResult)
    };
  }

  private getTaskRow(taskId: string, columns = "*"): Row {
    const row = this.db.get(`SELECT ${columns} FROM analysis_tasks WHERE id = ?`, taskId);
    if (!row) throw notFound("分析任务");
    return row;
  }

  private taskResultObjects(value: unknown): Record<string, unknown>[] {
    return Array.isArray(value)
      ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
      : [];
  }

  private taskResultEvidence(value: unknown): Record<string, unknown>[] {
    return this.taskResultObjects(value).map((item) => {
      const chapterId = String(item.chapterId ?? "");
      const chapterTitle = String(item.chapterTitle ?? "");
      const settingId = String(item.settingId ?? "");
      const settingTitle = String(item.settingTitle ?? "");
      const sourceType = item.contextType === "setting" || settingId || settingTitle
        ? "setting"
        : chapterId || chapterTitle
          ? "chapter"
          : "";
      const sourceId = sourceType === "chapter" ? chapterId : sourceType === "setting" ? settingId : "";
      const sourceTitle = sourceType === "chapter" ? chapterTitle : sourceType === "setting" ? settingTitle : "";
      return {
        ...(chapterId ? { chapterId } : {}),
        ...(chapterTitle ? { chapterTitle } : {}),
        ...(settingId ? { settingId } : {}),
        ...(settingTitle ? { settingTitle } : {}),
        ...(sourceType ? { sourceType } : {}),
        ...(sourceId ? { sourceId } : {}),
        ...(sourceTitle ? { sourceTitle } : {}),
        quote: String(item.quote ?? ""),
        supports: String(item.supports ?? item.conclusion ?? "")
      };
    }).filter((item) => item.sourceId || item.sourceTitle || item.quote || item.supports).slice(0, 5);
  }

  private taskResultItem(value: unknown, fallbackTitle: string): Record<string, unknown> {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return { title: String(value) };
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return { title: fallbackTitle };
    const item = value as Record<string, unknown>;
    const firstText = (keys: string[]): string => {
      for (const key of keys) {
        if (typeof item[key] === "string" && String(item[key]).trim()) return String(item[key]).trim();
      }
      return "";
    };
    const title = firstText(["title", "name", "question", "canonicalName", "conclusion", "summary"]) || fallbackTitle;
    const subtitle = firstText(["category", "eventType", "itemType", "role", "type"]);
    const description = firstText(["description", "content", "conclusion", "reason", "identity", "suggestion", "supports"]);
    const tags = [item.tags, item.aliases, item.keywords, item.contradictions]
      .flatMap((candidate) => Array.isArray(candidate) ? candidate : [])
      .filter((candidate): candidate is string => typeof candidate === "string" && Boolean(candidate.trim()))
      .map((candidate) => candidate.trim())
      .slice(0, 20);
    const detailFields: Array<[string, string]> = [
      ["严重程度", "severity"],
      ["发生时间", "timeLabel"],
      ["地点", "location"],
      ["影响范围", "impactScope"],
      ["当前状态", "currentStatus"],
      ["确认状态", "confirmationStatus"],
      ["处理状态", "status"],
      ["种族", "species"],
      ["身份", "identity"],
      ["修改建议", "suggestion"],
      ["原文引文", "quote"]
    ];
    const statusLabels: Record<string, string> = {
      active: "持续中",
      ongoing: "持续中",
      ended: "已结束",
      historical: "历史关系",
      pending: "待确认",
      confirmed: "已确认",
      rejected: "已否决",
      candidate: "候选",
      fixed: "已修复",
      ignored: "已忽略"
    };
    const valueLabels: Record<string, string> = {
      high: "高",
      medium: "中",
      low: "低",
      "character-duplicate": "角色重复",
      "setting-conflict": "设定冲突",
      consistency: "一致性问题",
      conflict: "冲突",
      other: "其他"
    };
    const details = detailFields.flatMap(([label, key]) => {
      const candidate = item[key];
      if (typeof candidate !== "string" || !candidate.trim()) return [];
      const value = ["currentStatus", "confirmationStatus", "status"].includes(key)
        ? statusLabels[candidate.trim()] ?? candidate.trim()
        : valueLabels[candidate.trim()] ?? candidate.trim();
      return [{ label, value }];
    });
    if (typeof item.confidence === "number") {
      details.push({ label: "置信度", value: `${Math.round(item.confidence * 100)}%` });
    }
    return {
      title,
      subtitle: valueLabels[subtitle] ?? subtitle,
      description,
      tags,
      details,
      evidence: this.taskResultEvidence(item.evidence)
    };
  }

  private taskCharacterReferenceSummary(workId: string, reference: string): { name: string; summary: string } | null {
    const separator = reference.lastIndexOf("@");
    if (separator <= 0) return null;
    const characterId = reference.slice(0, separator);
    const versionNo = Number(reference.slice(separator + 1));
    if (!Number.isInteger(versionNo) || versionNo <= 0) return null;
    const version = this.db.get(
      "SELECT work_id, snapshot_json FROM character_versions WHERE character_id = ? AND version_no = ?",
      characterId,
      versionNo
    );
    let character: Record<string, unknown> | null = null;
    if (version && optionalString(version, "work_id") === workId) {
      character = json<Record<string, unknown>>(requiredString(version, "snapshot_json"), {});
    } else {
      try {
        const current = this.getCharacter(characterId);
        if (current.workId === workId) character = current;
      } catch {
        return null;
      }
    }
    if (!character) return null;
    const name = typeof character.name === "string" && character.name.trim() ? character.name.trim() : "分析时角色";
    const aliases = Array.isArray(character.aliases)
      ? character.aliases.filter((alias): alias is string => typeof alias === "string" && Boolean(alias.trim())).map((alias) => alias.trim())
      : [];
    const attributes = character.attributes && typeof character.attributes === "object" && !Array.isArray(character.attributes)
      ? character.attributes as Record<string, unknown>
      : {};
    const identity = typeof attributes.identity === "string" ? attributes.identity.trim() : "";
    const species = typeof character.species === "string" ? character.species.trim() : "";
    const basics = [
      aliases.length ? `别名：${aliases.join("、")}` : "",
      identity ? `身份：${identity}` : "",
      species ? `种族：${species}` : ""
    ].filter(Boolean);
    return { name, summary: basics.length ? `${name}（${basics.join("；")}）` : name };
  }

  private taskSkippedIdentityCandidate(value: unknown, fallbackTitle: string, workId: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return this.taskResultItem(value, fallbackTitle);
    const item = value as Record<string, unknown>;
    const references = typeof item.pair === "string" ? item.pair.split("|") : [];
    if (references.length !== 2) return this.taskResultItem(value, fallbackTitle);
    const left = this.taskCharacterReferenceSummary(workId, references[0] ?? "");
    const right = this.taskCharacterReferenceSummary(workId, references[1] ?? "");
    if (!left || !right) return this.taskResultItem(value, fallbackTitle);
    const reason = typeof item.reason === "string" && item.reason.trim() ? item.reason.trim() : "分析信息不足";
    return {
      title: `${left.name} ↔ ${right.name}`,
      subtitle: "未生成查重建议",
      description: `AI 未生成可提交审核的角色查重建议：${reason}`,
      tags: [],
      details: [
        { label: "候选角色一", value: left.summary },
        { label: "候选角色二", value: right.summary },
        { label: "未生成原因", value: reason }
      ],
      evidence: []
    };
  }

  private buildTaskResultSummary(task: Record<string, unknown>, hasResult: boolean): Record<string, unknown> {
    const taskType = String(task.taskType);
    const workId = String(task.workId);
    const result = task.result && typeof task.result === "object" && !Array.isArray(task.result)
      ? task.result as Record<string, unknown>
      : {};
    const labelByType: Record<string, string> = {
      "chapter-analysis": "章节理解",
      "character-extraction": "全书角色抽取",
      "character-summary": "全书角色抽取",
      "character-identity-audit": "AI 角色查重",
      "timeline-analysis": "时间轴与事件抽取",
      "relationship-analysis": "人物关系分析",
      "worldview-analysis": "世界观分析",
      "setting-extraction": "设定抽取",
      "consistency-check": "一致性校对",
      "book-analysis": "全书综合分析",
      structure: "结构分析",
      "report-update": "报告更新"
    };
    const analysisLabel = labelByType[taskType] ?? "AI 分析";
    const taskStorage = {
      label: "完整任务结果",
      entity: "AI 分析记录",
      key: "analysis-record",
      count: hasResult ? 1 : 0,
      note: "完整返回 JSON 保存在本次 AI 分析记录中，可按需查看。"
    };
    const productStorageTargets = (targets: Record<string, unknown>[]): Record<string, unknown>[] => targets.map((target) => ({
      label: String(target.label ?? target.entity ?? "分析结果"),
      location: `当前作品 · ${String(target.entity ?? "AI 分析记录")}`,
      count: Number(target.count ?? 0),
      ...(typeof target.note === "string" && target.note.trim() ? { note: target.note.trim() } : {})
    }));
    if (!hasResult) {
      return {
        title: `${analysisLabel}结果`,
        analysisContent: `${analysisLabel}；范围：${String(task.scopeSummary ?? "未指定")}`,
        summary: "任务尚未产生分析结果。",
        metrics: [],
        storageTargets: productStorageTargets([taskStorage]),
        sections: []
      };
    }
    const metric = (label: string, value: unknown): Record<string, unknown> => ({ label, value: Number(value ?? 0) });
    const section = (title: string, values: unknown, emptyMessage: string): Record<string, unknown> => {
      const source = Array.isArray(values) ? values : [];
      return {
        title,
        totalCount: source.length,
        items: source.slice(0, 100).map((item, index) => this.taskResultItem(item, `${title} ${index + 1}`)),
        emptyMessage
      };
    };
    const idList = (value: unknown): string[] => Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
    const resultFieldLabels: Record<string, string> = {
      sourceChapterCount: "分析章节",
      sourceChunkCount: "分析分段",
      eventCount: "时间轴事件",
      resumable: "可继续处理",
      completedChunkCount: "已完成分段",
      chunkResults: "分段结果",
      consolidationResults: "汇总结果",
      semanticReviewResults: "语义复核结果",
      relationships: "审核关系",
      confirmed: "已确认",
      pending: "待确认",
      characters: "角色档案",
      timelineEvents: "时间轴事件",
      foreshadows: "伏笔",
      races: "种族",
      organizations: "组织",
      removedForeshadows: "已移除伏笔",
      correctedRaceClassification: "种族分类修正",
      timelineTypoFixed: "时间轴错字修正",
      ianAliasAdded: "补充角色别名",
      fixedRelationships: "修正人物关系",
      semanticCorrections: "关系语义修正",
      mergedCanonicalIds: "合并规范关系",
      mergedCharacterId: "合并后角色",
      removedDuplicateCharacterId: "移除重复角色",
      settingIds: "设定",
      settings: "设定",
      raceIds: "种族",
      organizationIds: "组织",
      timelineEventIds: "时间轴事件",
      eventIds: "时间轴事件",
      foreshadowIds: "伏笔",
      correctedCharacterIds: "修正角色",
      removedDuplicateCharacterIds: "移除重复角色"
    };
    const resultFieldLabel = (key: string): string => resultFieldLabels[key] ?? key;
    const resultRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    const genericMetrics = (source: Record<string, unknown>): Record<string, unknown>[] => {
      const ignored = new Set(["content", "bookSummary", "callId", "callIds", "summarySettingId", "summarySuggestionId"]);
      const values: Record<string, unknown>[] = [];
      const labels = new Set<string>();
      const append = (key: string, value: unknown): void => {
        if (ignored.has(key) || key.endsWith("Id")) return;
        const label = resultFieldLabel(key);
        if (labels.has(label)) return;
        let displayValue: unknown;
        if (typeof value === "number") displayValue = value;
        else if (typeof value === "boolean") displayValue = value ? "是" : "否";
        else if (typeof value === "string" && value.trim() && value.length <= 100) displayValue = value.trim();
        else if (Array.isArray(value) && key !== "callIds") displayValue = value.length;
        else return;
        labels.add(label);
        values.push({ label, value: displayValue });
      };
      for (const [key, value] of Object.entries(source)) {
        if (key === "counts") {
          for (const [countKey, countValue] of Object.entries(resultRecord(value))) append(countKey, countValue);
        } else append(key, value);
      }
      return values.slice(0, 12);
    };
    const genericSections = (source: Record<string, unknown>): Record<string, unknown>[] => Object.entries(source).flatMap(([key, value]) => {
      if (!Array.isArray(value) || value.length === 0 || key === "callIds" || key === "fixedRelationships" || key.endsWith("Ids")) return [];
      return [section(resultFieldLabel(key), value, `没有可展示的${resultFieldLabel(key)}。`)];
    });
    const resolveIds = (
      ids: string[],
      getter: (entityId: string) => Record<string, unknown>
    ): Record<string, unknown>[] => ids.flatMap((entityId) => {
      try {
        const entity = getter(entityId);
        return entity.workId === workId ? [entity] : [];
      } catch { return []; }
    });
    const storageTargets: Record<string, unknown>[] = [taskStorage];
    const addStorageTarget = (target: Record<string, unknown>): void => {
      if (!storageTargets.some((item) => item.key === target.key)) storageTargets.unshift(target);
    };
    let summary = "分析已完成。";
    let metrics: Record<string, unknown>[] = [];
    let sections: Record<string, unknown>[] = [];
    let relationshipChangePreviewSummary: Record<string, unknown> | null = null;
    let characterExtractionPreviewSummary: Record<string, unknown> | null = null;

    if (taskType === "chapter-analysis") {
      let chapterTitle = String(result.chapterId ?? "指定章节");
      if (typeof result.chapterId === "string") {
        try { chapterTitle = String(this.getChapter(result.chapterId).title); } catch { /* 历史章节可能已删除 */ }
      }
      summary = typeof result.summary === "string" && result.summary.trim() ? result.summary.trim() : "章节理解已生成。";
      metrics = [
        metric("事件", Array.isArray(result.events) ? result.events.length : 0),
        metric("出场角色", Array.isArray(result.characters) ? result.characters.length : 0),
        metric("设定", Array.isArray(result.settings) ? result.settings.length : 0),
        metric("不确定项", Array.isArray(result.uncertainties) ? result.uncertainties.length : 0)
      ];
      storageTargets.unshift({
        label: "章节理解记录",
        entity: chapterTitle,
        key: "chapter-insight",
        count: result.insightId ? 1 : 0,
        note: `对应章节版本 v${Number(result.chapterVersion ?? 0)}。`
      });
      sections = [
        section("情节事件", result.events, "没有提取到明确事件。"),
        section("出场角色", result.characters, "没有提取到角色信息。"),
        section("章节设定", result.settings, "没有提取到设定信息。"),
        section("原文依据", result.evidence, "没有可展示的原文依据。"),
        section("不确定项", result.uncertainties, "没有标记不确定项。")
      ];
    } else if (taskType === "timeline-analysis") {
      const ids = idList(result.eventIds);
      const events = ids.flatMap((eventId) => {
        try {
          const event = this.getTimelineEvent(eventId);
          return event.workId === workId ? [event] : [];
        } catch { return []; }
      });
      const hasChunkMetrics = typeof result.coveredChapterCount === "number" || typeof result.batchCount === "number";
      summary = hasChunkMetrics
        ? `覆盖 ${Number(result.coveredChapterCount ?? 0)} 章正文，识别 ${Number(result.rawCandidateCount ?? events.length)} 个原始候选，写入 ${events.length} 个时间轴事件候选。`
        : `提取并写入 ${events.length} 个时间轴事件候选。`;
      metrics = [
        metric("写入事件", events.length),
        ...(hasChunkMetrics ? [
          metric("覆盖章节", result.coveredChapterCount),
          metric("正文分片", result.batchCount),
          metric("归并批次", result.aggregationBatchCount),
          metric("原始候选", result.rawCandidateCount)
        ] : []),
        metric("已不存在", Math.max(0, ids.length - events.length))
      ];
      storageTargets.unshift({ label: "时间轴候选", entity: "时间轴与事件", key: "timeline", count: events.length, note: "以候选状态写入，等待作者确认。" });
      sections = [section("事件候选", events, "没有形成可写入的时间轴事件。")];
    } else if (taskType === "worldview-analysis") {
      summary = typeof result.summary === "string" && result.summary.trim() ? result.summary.trim() : "世界观分析已完成。";
      metrics = [metric("世界观维度", result.dimensionCount), metric("冲突", Array.isArray(result.conflicts) ? result.conflicts.length : 0), metric("待确认问题", Array.isArray(result.uncertainties) ? result.uncertainties.length : 0), metric("覆盖章节", result.coveredChapterCount)];
      sections = [
        section("世界观结论", result.dimensions, "没有形成有证据支持的世界观结论。"),
        section("设定冲突", result.conflicts, "没有发现明确冲突。"),
        section("待确认问题", result.uncertainties, "没有标记待确认问题。")
      ];
    } else if (taskType === "setting-extraction") {
      const ids = idList(result.settingIds);
      const settings = ids.flatMap((settingId) => {
        try {
          const setting = this.getSetting(settingId);
          return setting.workId === workId ? [setting] : [];
        } catch { return []; }
      });
      summary = `识别 ${Number(result.rawCandidateCount ?? settings.length)} 个候选，写入 ${settings.length} 条设定。`;
      metrics = [metric("新建", result.createdCount), metric("更新", result.updatedCount), metric("跳过", Array.isArray(result.skipped) ? result.skipped.length : 0), metric("覆盖章节", result.coveredChapterCount)];
      storageTargets.unshift({ label: "设定候选", entity: "设定库", key: "settings", count: settings.length, note: "写入为待确认设定，不覆盖已确认或锁定内容。" });
      sections = [section("写入的设定", settings, "没有形成可写入的设定。"), section("未写入候选", result.skipped, "没有候选被跳过。")];
    } else if (taskType === "consistency-check" && !("reviewIds" in result)) {
      const relationshipCount = typeof result.relationships === "number" ? result.relationships : null;
      const confirmedCount = Number(result.confirmed ?? 0);
      const pendingCount = Number(result.pending ?? 0);
      const semanticCorrections = Array.isArray(result.semanticCorrections) ? result.semanticCorrections : [];
      const mergedRelationships = idList(result.mergedCanonicalIds);
      const fixedRelationships = idList(result.fixedRelationships);
      if (relationshipCount !== null) {
        summary = `审核 ${relationshipCount} 条人物关系，其中 ${confirmedCount} 条已确认、${pendingCount} 条待确认；完成 ${mergedRelationships.length} 组关系合并和 ${semanticCorrections.length} 项语义修正。`;
      } else {
        summary = "一致性校对已完成，以下是本次实际检查和修正的数据。";
      }
      metrics = genericMetrics(result);
      sections = genericSections(result);
      const relationshipChanges = mergedRelationships.length + fixedRelationships.length + semanticCorrections.length;
      if (relationshipChanges > 0) {
        addStorageTarget({
          label: "人物关系修正",
          entity: "人物关系库",
          key: "relationships",
          count: relationshipChanges,
          note: "数量按任务记录的合并、修正和语义校正项统计。"
        });
      }
      if (typeof result.mergedCharacterId === "string" || typeof result.removedDuplicateCharacterId === "string" || typeof result.ianAliasAdded === "string") {
        addStorageTarget({ label: "角色档案修正", entity: "角色库", key: "characters", count: 1, note: "包含角色合并、重复档案清理或别名补充。" });
      }
      if (result.timelineTypoFixed === true) {
        addStorageTarget({ label: "时间轴修正", entity: "时间轴与事件", key: "timeline", count: 1, note: "任务记录已修正时间轴文本。" });
      }
      if (typeof result.removedForeshadows === "number" && result.removedForeshadows > 0) {
        addStorageTarget({ label: "伏笔清理", entity: "伏笔库", key: "foreshadows", count: result.removedForeshadows, note: "任务记录已移除重复或无效伏笔。" });
      }
      if (result.correctedRaceClassification === true) {
        addStorageTarget({ label: "种族分类修正", entity: "种族库", key: "races", count: 1, note: "任务记录已修正种族分类。" });
      }
    } else if (taskType === "consistency-check" || taskType === "character-identity-audit") {
      const ids = idList(result.reviewIds);
      const reviews = ids.flatMap((reviewId) => {
        try {
          const review = this.getReviewItem(reviewId);
          return review.workId === workId ? [review] : [];
        } catch { return []; }
      });
      summary = taskType === "character-identity-audit"
        ? `检查 ${Number(result.characterCount ?? 0)} 个角色档案，生成 ${reviews.length} 条查重建议。`
        : `发现并写入 ${reviews.length} 条一致性审核事项。`;
      metrics = taskType === "character-identity-audit"
        ? [metric("角色档案", result.characterCount), metric("疑似重复", reviews.length), metric("跳过", Array.isArray(result.skipped) ? result.skipped.length : 0), metric("工具调用", result.toolCallCount)]
        : [metric("审核事项", reviews.length), metric("已不存在", Math.max(0, ids.length - reviews.length))];
      storageTargets.unshift({ label: "审核建议", entity: "审核中心", key: "reviews", count: reviews.length, note: "只生成待处理建议，不会自动修正文或合并角色。" });
      const skipped = Array.isArray(result.skipped) ? result.skipped : [];
      sections = [
        section(taskType === "character-identity-audit" ? "角色查重建议" : "一致性问题", reviews, "没有发现需要审核的问题。"),
        ...(taskType === "character-identity-audit" ? [{
          title: "未生成建议的候选",
          totalCount: skipped.length,
          items: skipped.slice(0, 100).map((item, index) => this.taskSkippedIdentityCandidate(item, `未生成建议的候选 ${index + 1}`, workId)),
          emptyMessage: "没有候选被跳过。"
        }] : [])
      ];
    } else if (taskType === "character-extraction" || taskType === "character-summary") {
      const extractedCandidates = this.taskResultObjects(result.characterCandidates);
      const application = result.characterApplication && typeof result.characterApplication === "object"
        && !Array.isArray(result.characterApplication)
        ? result.characterApplication as Record<string, unknown>
        : null;
      const ids = idList(result.characterIds);
      const characters = ids.flatMap((characterId) => {
        try {
          const character = this.getCharacter(characterId);
          if (character.workId !== workId) return [];
          const attributes = character.attributes && typeof character.attributes === "object" && !Array.isArray(character.attributes)
            ? character.attributes as Record<string, unknown>
            : {};
          const profile = character.profile && typeof character.profile === "object" && !Array.isArray(character.profile)
            ? character.profile as Record<string, unknown>
            : {};
          return [{
            ...character,
            identity: String(attributes.identity ?? ""),
            description: String(profile.summary ?? "")
          }];
        } catch { return []; }
      });
      const verification = result.verification && typeof result.verification === "object" && !Array.isArray(result.verification)
        ? result.verification as Record<string, unknown>
        : {};
      if (extractedCandidates.length > 0 || application) {
        const applicationStatus = application?.status === "applied" ? "applied" : "pending";
        const candidateItems = extractedCandidates.map((candidate) => ({
          name: String(candidate.name ?? "未命名角色"),
          aliases: Array.isArray(candidate.aliases) ? candidate.aliases.map(String) : [],
          identity: String(candidate.identity ?? ""),
          species: String(candidate.species ?? ""),
          evidence: candidate.firstEvidence ? [candidate.firstEvidence] : []
        }));
        const appliedItems = this.taskResultObjects(application?.items).map((item) => ({
          title: String(item.characterName ?? item.candidateId ?? "角色候选"),
          subtitle: item.status === "created" ? "已新建档案"
            : item.status === "merged" ? "已合并可靠信息"
              : item.status === "unchanged" ? "已有档案保持不变"
                : "已跳过",
          description: Array.isArray(item.conflicts) ? item.conflicts.map(String).join("；") : ""
        }));
        const totalCount = Number(application?.totalCount ?? result.candidateCount ?? extractedCandidates.length);
        const createdCount = Number(application?.createdCount ?? 0);
        const mergedCount = Number(application?.mergedCount ?? 0);
        const unchangedCount = Number(application?.unchangedCount ?? 0);
        const skippedCount = Number(application?.skippedCount ?? 0);
        characterExtractionPreviewSummary = {
          status: applicationStatus,
          totalCount,
          createdCount,
          mergedCount,
          unchangedCount,
          skippedCount,
          ...(typeof application?.generatedAt === "string" ? { generatedAt: application.generatedAt } : {}),
          ...(typeof application?.appliedAt === "string" ? { appliedAt: application.appliedAt } : {})
        };
        summary = applicationStatus === "applied"
          ? `已处理 ${totalCount} 个角色候选：新建 ${createdCount} 个、合并 ${mergedCount} 个、保持不变 ${unchangedCount} 个、跳过 ${skippedCount} 个。`
          : `识别 ${totalCount} 个角色候选，角色库尚未修改；请预览、勾选并确认新建或合并策略。`;
        metrics = [
          metric(applicationStatus === "applied" ? "新建角色" : "待确认", applicationStatus === "applied" ? createdCount : totalCount),
          metric("合并", mergedCount),
          metric("跳过", applicationStatus === "applied" ? skippedCount : Array.isArray(result.skipped) ? result.skipped.length : 0),
          metric("身份复核", verification.pairCount)
        ];
        storageTargets.unshift({
          label: "角色档案",
          entity: "角色库",
          key: "characters",
          count: characters.length,
          note: applicationStatus === "applied"
            ? "仅写入用户确认的新建或合并项；冲突字段保留原档案。"
            : "当前仅保存结构化预览，角色库尚未修改。"
        });
        sections = [
          section(applicationStatus === "applied" ? "抽取的角色候选" : "待确认角色候选", candidateItems, "没有形成可应用的角色候选。"),
          ...(applicationStatus === "applied" ? [section("应用结果", appliedItems, "没有角色候选被应用。")] : []),
          section("抽取阶段跳过的候选", result.skipped, "抽取阶段没有候选被跳过。")
        ];
      } else {
        summary = `识别 ${Number(result.candidateCount ?? characters.length)} 个角色候选，保存 ${characters.length} 个角色档案。`;
        metrics = [metric("保存角色", characters.length), metric("跳过", Array.isArray(result.skipped) ? result.skipped.length : 0), metric("覆盖章节", result.coveredChapterCount), metric("身份复核", verification.pairCount)];
        storageTargets.unshift({ label: "角色档案", entity: "角色库", key: "characters", count: characters.length, note: "该历史任务在生成结果时直接写入角色档案。" });
        sections = [section("保存的角色", characters, "没有形成可保存的角色档案。"), section("未写入候选", result.skipped, "没有候选被跳过。")];
      }
    } else if (taskType === "book-analysis") {
      const timelineIds = [...new Set([...idList(result.eventIds), ...idList(result.timelineEventIds)])];
      const settingIds = [...new Set([
        ...idList(result.settingIds),
        ...(typeof result.summarySettingId === "string" ? [result.summarySettingId] : [])
      ])];
      const raceIds = idList(result.raceIds);
      const organizationIds = idList(result.organizationIds);
      const foreshadowIds = idList(result.foreshadowIds);
      const correctedCharacterIds = idList(result.correctedCharacterIds);
      const removedDuplicateCharacterIds = idList(result.removedDuplicateCharacterIds);
      const timelineEvents = resolveIds(timelineIds, (entityId) => this.getTimelineEvent(entityId));
      const settings = resolveIds(settingIds, (entityId) => this.getSetting(entityId));
      const races = resolveIds(raceIds, (entityId) => this.getRace(entityId, false));
      const organizations = resolveIds(organizationIds, (entityId) => this.getOrganization(entityId));
      const foreshadows = resolveIds(foreshadowIds, (entityId) => this.getForeshadow(entityId));
      const correctedCharacters = resolveIds(correctedCharacterIds, (entityId) => this.getCharacter(entityId));
      const bookSummary = resultRecord(result.bookSummary);
      const oneSentence = typeof bookSummary.oneSentence === "string" ? bookSummary.oneSentence.trim() : "";
      const content = typeof result.content === "string" ? result.content.trim() : "";
      if (oneSentence) summary = oneSentence;
      else if (timelineIds.length > 0) {
        summary = `分析 ${Number(result.sourceChapterCount ?? 0)} 章正文，重建并记录 ${timelineIds.length} 个时间轴事件；当前作品中仍可查看 ${timelineEvents.length} 个。`;
      } else if (correctedCharacterIds.length > 0 || removedDuplicateCharacterIds.length > 0) {
        summary = `核验人物档案后修正 ${correctedCharacterIds.length} 个角色，并移除 ${removedDuplicateCharacterIds.length} 个重复角色档案。`;
      } else if (Array.isArray(result.chunkResults)) {
        summary = `已完成 ${Number(result.completedChunkCount ?? result.chunkResults.length)}/${Number(result.sourceChunkCount ?? result.chunkResults.length)} 个正文分段的阶段分析${result.resumable === true ? "，当前结果可继续处理" : ""}。`;
      } else if (content) summary = content;
      else summary = "全书综合分析已完成，以下展示任务记录的统计、结论和写入数据。";
      metrics = genericMetrics(result);
      if (timelineIds.length > 0) {
        addStorageTarget({ label: "时间轴事件", entity: "时间轴与事件", key: "timeline", count: timelineIds.length, note: `任务记录 ${timelineIds.length} 个事件，当前仍可查看 ${timelineEvents.length} 个。` });
      }
      if (settingIds.length > 0) {
        addStorageTarget({ label: "世界设定", entity: "设定库", key: "settings", count: settingIds.length, note: `任务记录 ${settingIds.length} 个设定，当前仍可查看 ${settings.length} 个。` });
      }
      if (raceIds.length > 0) {
        addStorageTarget({ label: "种族资料", entity: "种族库", key: "races", count: raceIds.length, note: `任务记录 ${raceIds.length} 个种族，当前仍可查看 ${races.length} 个。` });
      }
      if (organizationIds.length > 0) {
        addStorageTarget({ label: "组织资料", entity: "组织库", key: "organizations", count: organizationIds.length, note: `任务记录 ${organizationIds.length} 个组织，当前仍可查看 ${organizations.length} 个。` });
      }
      if (foreshadowIds.length > 0) {
        addStorageTarget({ label: "伏笔资料", entity: "伏笔库", key: "foreshadows", count: foreshadowIds.length, note: `任务记录 ${foreshadowIds.length} 个伏笔，当前仍可查看 ${foreshadows.length} 个。` });
      }
      if (typeof result.summarySuggestionId === "string") {
        addStorageTarget({ label: "全书分析建议", entity: "AI 建议", key: "suggestions", count: 1, note: "保存全书概要对应的分析建议。" });
      }
      if (correctedCharacterIds.length > 0 || removedDuplicateCharacterIds.length > 0) {
        addStorageTarget({
          label: "角色档案核验",
          entity: "角色库",
          key: "characters",
          count: correctedCharacterIds.length + removedDuplicateCharacterIds.length,
          note: `修正 ${correctedCharacterIds.length} 个角色，移除 ${removedDuplicateCharacterIds.length} 个重复档案；当前可读取 ${correctedCharacters.length} 个修正后角色。`
        });
      }
      sections = [];
      if (Object.keys(bookSummary).length > 0) {
        const overviewDetails = [
          ["剧情概要", bookSummary.synopsis],
          ["当前故事状态", bookSummary.endingState]
        ].flatMap(([label, value]) => typeof value === "string" && value.trim() ? [{ label, value: value.trim() }] : []);
        sections.push({
          title: "全书概要",
          totalCount: 1,
          items: [{
            title: String(bookSummary.title ?? "全书概要"),
            description: oneSentence,
            details: overviewDetails,
            tags: Array.isArray(bookSummary.themes) ? bookSummary.themes.map(String).slice(0, 20) : [],
            evidence: []
          }],
          emptyMessage: "没有可展示的全书概要。"
        });
        const volumeSummaries = this.taskResultObjects(bookSummary.volumeSummaries).map((item) => ({
          title: String(item.volumeTitle ?? item.title ?? "未命名分卷"),
          description: String(item.summary ?? ""),
          tags: Array.isArray(item.turningPoints) ? item.turningPoints.map(String).slice(0, 20) : []
        }));
        sections.push(
          section("分卷摘要", volumeSummaries, "没有可展示的分卷摘要。"),
          section("主要故事线", bookSummary.mainArcs, "没有可展示的主要故事线。"),
          section("未解决问题", bookSummary.unresolvedQuestions, "没有标记未解决问题。"),
          section("原文依据", bookSummary.evidence, "没有可展示的原文依据。")
        );
      }
      if (timelineIds.length > 0) sections.push(section("写入的时间轴事件", timelineEvents, "任务记录的时间轴事件当前均已不存在。"));
      if (settingIds.length > 0) sections.push(section("写入的设定", settings, "任务记录的设定当前均已不存在。"));
      if (raceIds.length > 0) sections.push(section("写入的种族", races, "任务记录的种族当前均已不存在。"));
      if (organizationIds.length > 0) sections.push(section("写入的组织", organizations, "任务记录的组织当前均已不存在。"));
      if (foreshadowIds.length > 0) sections.push(section("写入的伏笔", foreshadows, "任务记录的伏笔当前均已不存在。"));
      if (correctedCharacterIds.length > 0) sections.push(section("修正后的角色", correctedCharacters, "任务记录的修正角色当前均已不存在。"));
      if (Array.isArray(result.evidence)) sections.push(section("核验依据", result.evidence, "没有可展示的核验依据。"));
    } else if (taskType === "relationship-analysis") {
      const relationshipIds = idList(result.relationshipIds);
      const missingRelationshipIds = idList(result.missingRelationshipIds);
      const changePreview = result.relationshipChangePreview && typeof result.relationshipChangePreview === "object"
        && !Array.isArray(result.relationshipChangePreview)
        ? result.relationshipChangePreview as Record<string, unknown>
        : null;
      const previewStatus = String(changePreview?.status ?? "");
      if (changePreview) {
        relationshipChangePreviewSummary = {
          status: previewStatus,
          totalCount: Number(changePreview.totalCount ?? 0),
          createdCount: Number(changePreview.createdCount ?? 0),
          updatedCount: Number(changePreview.updatedCount ?? 0),
          deletedCount: Number(changePreview.deletedCount ?? 0),
          ...(typeof changePreview.generatedAt === "string" ? { generatedAt: changePreview.generatedAt } : {}),
          ...(typeof changePreview.appliedAt === "string" ? { appliedAt: changePreview.appliedAt } : {}),
          ...(typeof changePreview.discardedAt === "string" ? { discardedAt: changePreview.discardedAt } : {})
        };
      }
      const relationships = this.taskResultObjects(result.relationshipResults).map((relationship) => {
        const actionLabels: Record<string, string> = previewStatus === "pending"
          ? { created: "将新建", updated: "将更新", deleted: "将删除", unchanged: "将保留原记录" }
          : previewStatus === "discarded"
          ? { created: "已放弃新建", updated: "已放弃更新", deleted: "已放弃删除", unchanged: "已保留原记录" }
          : { created: "已新建", updated: "已更新", deleted: "已删除", unchanged: "已保留原记录" };
        const categoryLabels: Record<string, string> = { family: "亲属", social: "社交", emotional: "情感", conflict: "冲突", uncertain: "未确定" };
        const statusLabels: Record<string, string> = { active: "持续中", ongoing: "持续中", ended: "已结束", historical: "历史关系" };
        const confirmationLabels: Record<string, string> = { pending: "待确认", confirmed: "已确认", rejected: "已否决" };
        const fromName = String(relationship.fromCharacterName ?? relationship.fromCharacterId ?? "未知人物");
        const toName = String(relationship.toCharacterName ?? relationship.toCharacterId ?? "未知人物");
        const keywords = Array.isArray(relationship.keywords) ? relationship.keywords.map(String) : [];
        return {
          title: `${fromName} ${relationship.directed ? "→" : "↔"} ${toName}`,
          subtitle: `${categoryLabels[String(relationship.category)] ?? String(relationship.category ?? "其他关系")} / ${String(relationship.subtype ?? "未细分")} · ${actionLabels[String(relationship.action)] ?? "已处理"}`,
          description: [String(relationship.subtype ?? ""), keywords.join("、")].filter(Boolean).join("；"),
          tags: keywords,
          details: [
            { label: "当前状态", value: statusLabels[String(relationship.currentStatus)] ?? String(relationship.currentStatus ?? "未说明") },
            { label: "置信度", value: `${Math.round(Number(relationship.confidence ?? 0) * 100)}%` },
            { label: "确认状态", value: confirmationLabels[String(relationship.confirmationStatus)] ?? String(relationship.confirmationStatus ?? "待确认") }
          ],
          evidence: this.taskResultEvidence(relationship.evidence)
        };
      });
      const analysisTarget = result.analysisTarget && typeof result.analysisTarget === "object" && !Array.isArray(result.analysisTarget)
        ? result.analysisTarget as Record<string, unknown>
        : {};
      const targetNames = Array.isArray(analysisTarget.characterNames) ? analysisTarget.characterNames.map(String) : [];
      const targetSummary = analysisTarget.mode === "targeted-characters" && targetNames.length
        ? `重点分析 ${targetNames.join("、")} 与其他已建档人物之间的关系`
        : "分析范围内已建档人物之间的长期关系";
      const sourceSelection = result.sourceSelection && typeof result.sourceSelection === "object" && !Array.isArray(result.sourceSelection)
        ? result.sourceSelection as Record<string, unknown>
        : null;
      summary = previewStatus === "pending"
        ? `${targetSummary}，生成 ${Number(changePreview?.totalCount ?? 0)} 项待确认变更，尚未写入人物关系库。`
        : previewStatus === "discarded"
        ? `${targetSummary}，本次 ${Number(changePreview?.totalCount ?? 0)} 项关系变更已放弃，人物关系库未被修改。`
        : missingRelationshipIds.length > 0
        ? `${targetSummary}。任务结果记录 ${relationshipIds.length} 条关系，当前作品中保留 ${relationships.length} 条可展示关系，另有 ${missingRelationshipIds.length} 条已删除或合并。`
        : `${targetSummary}，共形成 ${relationships.length} 条可展示结果。`;
      if (sourceSelection) {
        summary += ` 来源筛选命中 ${Number(sourceSelection.exactSourceCount ?? 0)} 个精确来源，确认 ${Number(sourceSelection.confirmedSourceCount ?? 0)} 个疑似来源。`;
      }
      const actionMetrics = [
        ["新建", result.createdCount],
        ["更新", result.updatedCount],
        ["删除", result.deletedCount],
        ["保留", result.unchangedCount]
      ].flatMap(([label, value]) => typeof value === "number" ? [metric(String(label), value)] : []);
      metrics = [
        ...actionMetrics,
        metric("任务记录", relationshipIds.length || relationships.length),
        metric(previewStatus === "pending" ? "待确认变更" : "当前可展示", relationships.length),
        metric("已删除或合并", missingRelationshipIds.length),
        metric("跳过", Array.isArray(result.skipped) ? result.skipped.length : 0),
        ...(sourceSelection ? [
          metric("精确来源", Number(sourceSelection.exactSourceCount ?? 0)),
          metric("模糊候选", Number(sourceSelection.fuzzyCandidateCount ?? 0)),
          metric("确认来源", Number(sourceSelection.confirmedSourceCount ?? 0)),
          metric("排除", Number(sourceSelection.rejectedSourceCount ?? 0)),
          metric("不确定", Number(sourceSelection.uncertainSourceCount ?? 0))
        ] : [])
      ];
      storageTargets.unshift({
        label: "人物关系",
        entity: "人物关系库",
        key: "relationships",
        count: previewStatus === "pending" ? 0 : relationshipIds.length || relationships.length,
        note: previewStatus === "pending"
          ? `有 ${Number(changePreview?.totalCount ?? 0)} 项待确认变更，点击确认应用前不会写入或删除人物关系。`
          : previewStatus === "discarded"
          ? "本次待确认变更已放弃，人物关系库未被修改。"
          : `任务记录 ${relationshipIds.length || relationships.length} 条关系，当前可读取 ${relationships.length} 条；关系候选需由作者确认。`
      });
      const variantReviewIds = sourceSelection && Array.isArray(sourceSelection.reviewIds) ? sourceSelection.reviewIds.map(String) : [];
      if (variantReviewIds.length > 0) storageTargets.unshift({
        label: "疑似人物名错字",
        entity: "审核中心",
        key: "reviews",
        count: variantReviewIds.length,
        note: "仅生成待处理审核项，不会修改正文或人物别名。"
      });
      sections = [
        {
          title: previewStatus === "pending" ? "待确认的关系变更" : previewStatus === "discarded" ? "已放弃的关系变更" : "分析出的关系",
          totalCount: relationships.length,
          items: relationships.slice(0, 100),
          emptyMessage: previewStatus === "pending" ? "本次没有需要应用的关系变更。" : "没有形成可展示的人物关系。"
        },
        section("未写入候选", result.skipped, "没有候选被跳过。")
      ];
    } else {
      summary = typeof result.content === "string" && result.content.trim() ? result.content.trim() : "分析已完成，未生成可结构化展示的结论。";
      metrics = [];
      sections = [];
    }

    return {
      title: `${analysisLabel}结果`,
      analysisContent: `${analysisLabel}；范围：${String(task.scopeSummary ?? "未指定")}`,
      summary,
      metrics,
      storageTargets: productStorageTargets(storageTargets),
      sections,
      ...(relationshipChangePreviewSummary ? { relationshipChangePreview: relationshipChangePreviewSummary } : {}),
      ...(characterExtractionPreviewSummary ? { characterExtractionPreview: characterExtractionPreviewSummary } : {})
    };
  }

  private taskResultForClient(result: Record<string, unknown>): Record<string, unknown> {
    const sanitize = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(sanitize);
      if (!value || typeof value !== "object") return value;
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !["storageTarget", "database", "table", "taskResultTable"].includes(key))
        .map(([key, nestedValue]) => [key, sanitize(nestedValue)]));
    };
    return sanitize(result) as Record<string, unknown>;
  }

  private enrichRelationshipTaskResult(
    workId: string,
    taskType: string,
    scope: Record<string, unknown>,
    result: Record<string, unknown>
  ): Record<string, unknown> {
    if (taskType !== "relationship-analysis") return result;
    const relationshipIds = Array.isArray(result.relationshipIds)
      ? result.relationshipIds.filter((value): value is string => typeof value === "string")
      : [];
    let relationshipResults = Array.isArray(result.relationshipResults) ? result.relationshipResults : null;
    let missingRelationshipIds: string[] = [];
    if (relationshipResults === null && relationshipIds.length > 0) {
      const requestedIds = new Set(relationshipIds);
      const rows = this.db.all(
        `SELECT relationship.*, source.name AS from_character_name, target.name AS to_character_name
         FROM relationships relationship
         JOIN characters source ON source.id = relationship.from_character_id
         JOIN characters target ON target.id = relationship.to_character_id
         WHERE relationship.work_id = ?`,
        workId
      ).filter((row) => requestedIds.has(requiredString(row, "id")));
      const foundIds = new Set(rows.map((row) => requiredString(row, "id")));
      missingRelationshipIds = relationshipIds.filter((relationshipId) => !foundIds.has(relationshipId));
      relationshipResults = rows.map((row) => {
        const evidence = json<Array<Record<string, unknown>>>(requiredString(row, "evidence_json"), []);
        return {
          relationshipId: requiredString(row, "id"),
          action: "created",
          snapshotSource: "current-record",
          fromCharacterId: requiredString(row, "from_character_id"),
          fromCharacterName: requiredString(row, "from_character_name"),
          toCharacterId: requiredString(row, "to_character_id"),
          toCharacterName: requiredString(row, "to_character_name"),
          category: requiredString(row, "category"),
          subtype: requiredString(row, "subtype"),
          keywords: json(requiredString(row, "keywords_json"), []),
          directed: booleanValue(row, "directed"),
          currentStatus: requiredString(row, "current_status"),
          timeRange: json(requiredString(row, "time_range_json"), {}),
          confidence: numberValue(row, "confidence"),
          confirmationStatus: requiredString(row, "confirmation_status"),
          evidenceCount: evidence.length,
          evidence: this.taskResultEvidence(evidence).slice(0, 3),
          evidenceTruncated: evidence.length > 3
        };
      });
    }
    const targetCharacters = Array.isArray(scope.targetCharacters)
      ? scope.targetCharacters.filter((item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === "object" && !Array.isArray(item))
      : [];
    return this.taskResultForClient({
      ...result,
      ...(relationshipResults === null ? {} : { relationshipResults }),
      ...(missingRelationshipIds.length > 0 ? { missingRelationshipIds } : {}),
      analysisTarget: result.analysisTarget ?? {
        mode: targetCharacters.length > 0 ? "targeted-characters" : "all-relationships",
        scopeType: String(scope.type ?? "book"),
        characterIds: targetCharacters.map((character) => String(character.id ?? "")).filter(Boolean),
        characterNames: targetCharacters.map((character) => String(character.name ?? "")).filter(Boolean),
        coveredChapterCount: Number(result.coveredChapterCount ?? 0),
        includeAllSettings: scope.includeAllSettings === true,
        preFilterRelationshipSources: targetCharacters.length > 0 && scope.preFilterRelationshipSources !== false
      },
    });
  }

  private mapTask(row: Row): Record<string, unknown> {
    const workId = requiredString(row, "work_id");
    const taskType = requiredString(row, "task_type");
    const scope = json<Record<string, unknown>>(requiredString(row, "scope_json"), {});
    const characterNames = this.taskCharacterNames(workId, [scope]);
    const taskResult = this.enrichRelationshipTaskResult(
      workId,
      taskType,
      scope,
      json<Record<string, unknown>>(requiredString(row, "result_json"), {})
    );
    return {
      id: requiredString(row, "id"),
      workId,
      model: this.analysisTaskModel(row),
      taskType,
      scope,
      scopeSummary: this.taskScopeSummary(workId, scope, characterNames),
      scopeSummaryWithoutCharacterNames: this.taskScopeSummary(workId, scope, new Map(), false),
      scopeTarget: this.taskScopeTarget(workId, scope),
      scopeDetails: this.taskScopeDetails(workId, scope),
      status: requiredString(row, "status"),
      progress: numberValue(row, "progress"),
      result: taskResult,
      failures: json(requiredString(row, "failure_json"), []),
      sourceVersions: json(requiredString(row, "source_versions_json"), {}),
      attemptCount: numberValue(row, "attempt_count"),
      nextAttemptAt: row.next_attempt_at === null || row.next_attempt_at === undefined ? null : String(row.next_attempt_at),
      lastAttemptAt: row.last_attempt_at === null || row.last_attempt_at === undefined ? null : String(row.last_attempt_at),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at")
    };
  }

  private mapTaskSummary(
    workId: string,
    row: Row,
    chapterSummaries: Map<string, string>,
    volumeTitles: Map<string, string>,
    characterNames: Map<string, string>
  ): Record<string, unknown> {
    const scope = json<Record<string, unknown>>(requiredString(row, "scope_json"), {});
    return {
      id: requiredString(row, "id"),
      model: this.analysisTaskModel(row),
      taskType: requiredString(row, "task_type"),
      scopeSummary: this.taskScopeSummaryFromMaps(scope, chapterSummaries, volumeTitles, characterNames),
      scopeSummaryWithoutCharacterNames: this.taskScopeSummaryFromMaps(scope, chapterSummaries, volumeTitles, new Map(), false),
      scopeTarget: this.taskScopeTargetFromMaps(workId, scope, chapterSummaries),
      status: requiredString(row, "status"),
      progress: numberValue(row, "progress"),
      attemptCount: numberValue(row, "attempt_count"),
      nextAttemptAt: row.next_attempt_at === null || row.next_attempt_at === undefined ? null : String(row.next_attempt_at),
      lastAttemptAt: row.last_attempt_at === null || row.last_attempt_at === undefined ? null : String(row.last_attempt_at),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at")
    };
  }

  private analysisTaskModel(row: Row): Record<string, unknown> | null {
    const modelId = optionalString(row, "model_id");
    if (!modelId) return null;
    const model = row.model_display_name !== undefined
      ? row
      : this.db.get("SELECT display_name AS model_display_name, model_id AS model_api_id FROM models WHERE id = ?", modelId);
    if (!model) return { id: modelId, displayName: "模型已删除", modelId: "", deleted: true };
    return {
      id: modelId,
      displayName: requiredString(model, "model_display_name"),
      modelId: requiredString(model, "model_api_id")
    };
  }

  private taskScopeSummaryFromMaps(
    scope: Record<string, unknown>,
    chapterSummaries: Map<string, string>,
    volumeTitles: Map<string, string>,
    characterNames: Map<string, string>,
    includeCharacterNames = true
  ): string {
    const targetedSuffix = this.taskTargetedSuffix(scope, characterNames, includeCharacterNames);
    const chapterSettingsLabel = scope.includeAllSettings === true ? " + 设定集" : "";
    if (Array.isArray(scope.chapterIds) && scope.chapterIds.length > 0) {
      const labels = scope.chapterIds
        .filter((chapterId): chapterId is string => typeof chapterId === "string")
        .map((chapterId) => chapterSummaries.get(chapterId) ?? "章节已删除");
      const preview = labels.slice(0, 3).join("、");
      return `指定章节${chapterSettingsLabel}（${labels.length}）：${preview}${labels.length > 3 ? "……" : ""}${targetedSuffix}`;
    }
    if (typeof scope.chapterId === "string") return `${chapterSummaries.get(scope.chapterId) ?? "章节已删除"}${chapterSettingsLabel}${targetedSuffix}`;
    if (Array.isArray(scope.volumeIds) && scope.volumeIds.length > 0) {
      const labels = scope.volumeIds
        .filter((volumeId): volumeId is string => typeof volumeId === "string")
        .map((volumeId) => volumeTitles.get(volumeId) ? `分卷 · ${volumeTitles.get(volumeId)}` : "分卷已删除");
      const preview = labels.slice(0, 3).join("、");
      return `指定分卷（${labels.length}）：${preview}${labels.length > 3 ? "……" : ""}${targetedSuffix}`;
    }
    if (scope.type === "volume" && typeof scope.volumeId === "string") {
      const title = volumeTitles.get(scope.volumeId);
      return `${title ? `分卷 · ${title}` : "分卷已删除"}${targetedSuffix}`;
    }
    if (scope.type === "settings") return `仅设定集${targetedSuffix}`;
    if (scope.type === "book" || Object.keys(scope).length === 0) return `${scope.includeAllSettings === true ? "全书 + 设定集" : "全书"}${targetedSuffix}`;
    if (scope.type === "selection" && typeof scope.selection === "string" && scope.selection.trim()) {
      const selection = scope.selection.trim().replace(/\s+/gu, " ");
      return `选定内容：${selection.slice(0, 80)}${selection.length > 80 ? "……" : ""}${targetedSuffix}`;
    }
    if (scope.type === "none") return `无上下文${targetedSuffix}`;
    return "未指定范围";
  }

  private taskScopeSummary(
    workId: string,
    scope: Record<string, unknown>,
    characterNames: Map<string, string>,
    includeCharacterNames = true
  ): string {
    const targetedSuffix = this.taskTargetedSuffix(scope, characterNames, includeCharacterNames);
    const chapterSettingsLabel = scope.includeAllSettings === true ? " + 设定集" : "";
    if (Array.isArray(scope.chapterIds) && scope.chapterIds.length > 0) {
      const labels = scope.chapterIds.map((chapterId) => {
        const chapter = this.db.get(
          `SELECT chapter.title AS title, volume.title AS volume_title
           FROM chapters chapter
           JOIN volumes volume ON volume.id = chapter.volume_id
           WHERE chapter.id = ? AND chapter.work_id = ? AND chapter.deleted_at IS NULL`,
          chapterId,
          workId
        );
        return chapter ? `${requiredString(chapter, "volume_title")} · ${requiredString(chapter, "title")}` : "章节已删除";
      });
      const preview = labels.slice(0, 3).join("、");
      return `指定章节${chapterSettingsLabel}（${labels.length}）：${preview}${labels.length > 3 ? "……" : ""}${targetedSuffix}`;
    }
    if (typeof scope.chapterId === "string") {
      const chapter = this.db.get(
        `SELECT chapter.title AS title, volume.title AS volume_title
         FROM chapters chapter
         JOIN volumes volume ON volume.id = chapter.volume_id
         WHERE chapter.id = ? AND chapter.work_id = ? AND chapter.deleted_at IS NULL`,
        scope.chapterId,
        workId
      );
      if (!chapter) return `章节已删除${chapterSettingsLabel}${targetedSuffix}`;
      const title = requiredString(chapter, "title");
      const volumeTitle = requiredString(chapter, "volume_title");
      return `${volumeTitle} · ${title}${chapterSettingsLabel}${targetedSuffix}`;
    }
    if (Array.isArray(scope.volumeIds) && scope.volumeIds.length > 0) {
      const labels = scope.volumeIds.map((volumeId) => {
        const volume = this.db.get("SELECT title FROM volumes WHERE id = ? AND work_id = ?", volumeId, workId);
        return volume ? `分卷 · ${requiredString(volume, "title")}` : "分卷已删除";
      });
      const preview = labels.slice(0, 3).join("、");
      return `指定分卷（${labels.length}）：${preview}${labels.length > 3 ? "……" : ""}${targetedSuffix}`;
    }
    if (scope.type === "volume" && typeof scope.volumeId === "string") {
      const volume = this.db.get("SELECT title FROM volumes WHERE id = ? AND work_id = ?", scope.volumeId, workId);
      return `${volume ? `分卷 · ${requiredString(volume, "title")}` : "分卷已删除"}${targetedSuffix}`;
    }
    if (scope.type === "settings") return `仅设定集${targetedSuffix}`;
    if (scope.type === "book" || Object.keys(scope).length === 0) return `${scope.includeAllSettings === true ? "全书 + 设定集" : "全书"}${targetedSuffix}`;
    if (scope.type === "selection" && typeof scope.selection === "string" && scope.selection.trim()) {
      const selection = scope.selection.trim().replace(/\s+/gu, " ");
      return `选定内容：${selection.slice(0, 80)}${selection.length > 80 ? "……" : ""}${targetedSuffix}`;
    }
    if (scope.type === "none") return `无上下文${targetedSuffix}`;
    return "未指定范围";
  }

  private taskCharacterNames(workId: string, scopes: Record<string, unknown>[]): Map<string, string> {
    const characterIds = [...new Set(scopes.flatMap((scope) => {
      const snapshotNames = this.taskCharacterSnapshotNames(scope);
      return Array.isArray(scope.characterIds)
        ? scope.characterIds.filter((characterId): characterId is string =>
          typeof characterId === "string" && !snapshotNames.has(characterId))
        : [];
    }))];
    const characterNames = new Map<string, string>();
    for (let offset = 0; offset < characterIds.length; offset += 400) {
      const batch = characterIds.slice(offset, offset + 400);
      const placeholders = batch.map(() => "?").join(", ");
      for (const row of this.db.all(
        `SELECT id, name FROM characters WHERE work_id = ? AND id IN (${placeholders})`,
        workId,
        ...batch
      )) {
        characterNames.set(requiredString(row, "id"), requiredString(row, "name"));
      }
    }
    return characterNames;
  }

  private taskTargetedSuffix(
    scope: Record<string, unknown>,
    characterNames: Map<string, string>,
    includeCharacterNames = true
  ): string {
    const characterIds = Array.isArray(scope.characterIds)
      ? scope.characterIds.filter((characterId): characterId is string => typeof characterId === "string")
      : [];
    if (characterIds.length === 0) return "";
    const overwriteSuffix = scope.replaceExistingRelationships === true ? " · 覆盖已有关系" : "";
    const preFilterSuffix = scope.preFilterRelationshipSources === false ? " · 未前置过滤" : "";
    const sourcePreviewSuffix = Array.isArray(scope.relationshipSourceRefs)
      ? ` · 已预检 ${scope.relationshipSourceRefs.length} 条来源`
      : "";
    if (!includeCharacterNames) return ` · 定向 ${characterIds.length} 人${preFilterSuffix}${sourcePreviewSuffix}${overwriteSuffix}`;
    const snapshotNames = this.taskCharacterSnapshotNames(scope);
    const names = characterIds.map((characterId) => snapshotNames.get(characterId) ?? characterNames.get(characterId) ?? "已删除角色");
    return ` · 定向 ${characterIds.length} 人：${names.join("、")}${preFilterSuffix}${sourcePreviewSuffix}${overwriteSuffix}`;
  }

  private taskScopeTargetFromMaps(
    workId: string,
    scope: Record<string, unknown>,
    chapterSummaries: Map<string, string>
  ): Record<string, string> | null {
    const characterIds = Array.isArray(scope.characterIds)
      ? scope.characterIds.filter((characterId): characterId is string => typeof characterId === "string")
      : [];
    if (characterIds.length === 1 && typeof scope.chapterId !== "string") {
      const characterId = characterIds[0];
      if (!characterId) return null;
      const character = this.db.get("SELECT name FROM characters WHERE id = ? AND work_id = ?", characterId, workId);
      return character ? { type: "character", id: characterId, label: requiredString(character, "name") } : null;
    }
    if (characterIds.length === 0 && typeof scope.chapterId === "string") {
      const label = chapterSummaries.get(scope.chapterId);
      return label ? { type: "chapter", id: scope.chapterId, label } : null;
    }
    return null;
  }

  private taskScopeTarget(
    workId: string,
    scope: Record<string, unknown>
  ): Record<string, string> | null {
    const characterIds = Array.isArray(scope.characterIds)
      ? scope.characterIds.filter((characterId): characterId is string => typeof characterId === "string")
      : [];
    if (characterIds.length === 1 && typeof scope.chapterId !== "string") {
      const characterId = characterIds[0];
      if (!characterId) return null;
      const character = this.db.get("SELECT name FROM characters WHERE id = ? AND work_id = ?", characterId, workId);
      return character ? { type: "character", id: characterId, label: requiredString(character, "name") } : null;
    }
    if (characterIds.length !== 0 || typeof scope.chapterId !== "string") return null;
    const chapter = this.db.get(
      `SELECT chapter.title AS title, volume.title AS volume_title
       FROM chapters chapter
       JOIN volumes volume ON volume.id = chapter.volume_id
       WHERE chapter.id = ? AND chapter.work_id = ? AND chapter.deleted_at IS NULL`,
      scope.chapterId,
      workId
    );
    if (!chapter) return null;
    return {
      type: "chapter",
      id: scope.chapterId,
      label: `${requiredString(chapter, "volume_title")} · ${requiredString(chapter, "title")}`
    };
  }

  private taskCharacterSnapshotNames(scope: Record<string, unknown>): Map<string, string> {
    const snapshotNames = new Map<string, string>();
    if (Array.isArray(scope.targetCharacters)) {
      for (const item of scope.targetCharacters) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const target = item as Record<string, unknown>;
        if (typeof target.id === "string" && typeof target.name === "string" && target.name.trim()) {
          snapshotNames.set(target.id, target.name);
        }
      }
    }
    return snapshotNames;
  }

  private taskScopeDetails(workId: string, scope: Record<string, unknown>): Record<string, unknown>[] {
    if (Array.isArray(scope.chapterIds) && scope.chapterIds.length > 0) {
      return scope.chapterIds.map((chapterId) => {
        const chapter = this.db.get(
          `SELECT chapter.id AS id, chapter.title AS title, chapter.version_no AS version_no,
                  volume.id AS volume_id, volume.title AS volume_title
           FROM chapters chapter
           JOIN volumes volume ON volume.id = chapter.volume_id
           WHERE chapter.id = ? AND chapter.work_id = ? AND chapter.deleted_at IS NULL`,
          chapterId,
          workId
        );
        if (!chapter) return { type: "chapter", chapterId, missing: true };
        return {
          type: "chapter",
          chapterId: requiredString(chapter, "id"),
          title: requiredString(chapter, "title"),
          versionNo: numberValue(chapter, "version_no"),
          volumeId: requiredString(chapter, "volume_id"),
          volumeTitle: requiredString(chapter, "volume_title")
        };
      });
    }
    if (typeof scope.chapterId === "string") {
      const chapter = this.db.get(
        `SELECT chapter.id AS id, chapter.title AS title, chapter.version_no AS version_no,
                volume.id AS volume_id, volume.title AS volume_title
         FROM chapters chapter
         JOIN volumes volume ON volume.id = chapter.volume_id
         WHERE chapter.id = ? AND chapter.work_id = ? AND chapter.deleted_at IS NULL`,
        scope.chapterId,
        workId
      );
      if (!chapter) return [{ type: "chapter", chapterId: scope.chapterId, missing: true }];
      return [{
        type: "chapter",
        chapterId: requiredString(chapter, "id"),
        title: requiredString(chapter, "title"),
        versionNo: numberValue(chapter, "version_no"),
        volumeId: requiredString(chapter, "volume_id"),
        volumeTitle: requiredString(chapter, "volume_title")
      }];
    }
    if (Array.isArray(scope.volumeIds) && scope.volumeIds.length > 0) {
      return scope.volumeIds.map((volumeId) => {
        const volume = this.db.get("SELECT id, title FROM volumes WHERE id = ? AND work_id = ?", volumeId, workId);
        if (!volume) return { type: "volume", volumeId, missing: true };
        const chapters = this.db.all(
          "SELECT id, title, version_no FROM chapters WHERE volume_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at",
          volumeId
        );
        return {
          type: "volume",
          volumeId: requiredString(volume, "id"),
          title: requiredString(volume, "title"),
          chapters: chapters.map((item) => ({
            chapterId: requiredString(item, "id"),
            title: requiredString(item, "title"),
            versionNo: numberValue(item, "version_no")
          }))
        };
      });
    }
    if (scope.type === "volume" && typeof scope.volumeId === "string") {
      const volume = this.db.get("SELECT id, title FROM volumes WHERE id = ? AND work_id = ?", scope.volumeId, workId);
      if (!volume) return [{ type: "volume", volumeId: scope.volumeId, missing: true }];
      const chapters = this.db.all(
        "SELECT id, title, version_no FROM chapters WHERE volume_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at",
        scope.volumeId
      );
      return [{
        type: "volume",
        volumeId: requiredString(volume, "id"),
        title: requiredString(volume, "title"),
        chapters: chapters.map((item) => ({
          chapterId: requiredString(item, "id"),
          title: requiredString(item, "title"),
          versionNo: numberValue(item, "version_no")
        }))
      }];
    }
    if (scope.type === "book" || Object.keys(scope).length === 0) {
      return [{ type: "book", title: "全书" }];
    }
    if (scope.type === "settings") {
      return [{ type: "settings", title: "仅设定集" }];
    }
    if (scope.type === "settings-catalog") {
      return [{ type: "settings-catalog", title: "设定库" }];
    }
    if (scope.type === "selection" && typeof scope.selection === "string") {
      return [{ type: "selection", selection: scope.selection }];
    }
    if (scope.type === "none") return [{ type: "none" }];
    return [{ type: "unknown", scope }];
  }

  search(workId: string, query: string, requestedTypes?: ReadonlySet<HybridSearchType>): Record<string, unknown>[] {
    this.getWork(workId);
    const normalizedQuery = normalizeWorkSearchQuery(query);
    if (!normalizedQuery) return [];
    const pattern = `%${escapeSqlLikePattern(normalizedQuery)}%`;
    const accepts = (type: HybridSearchType): boolean => !requestedTypes || requestedTypes.has(type);
    const chapters = accepts("chapter")
      ? this.db.all(
        "SELECT id, title, content, volume_id FROM chapters WHERE work_id = ? AND deleted_at IS NULL AND (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\') LIMIT 50",
        workId,
        pattern,
        pattern
      )
      : [];
    const races = accepts("race")
      ? this.listRaces(workId).filter((race) => {
        const lineage = race.lineage as Array<{ name: string }>;
        const effectiveSettings = race.effectiveSettings as Array<{ value: string; sourceRaceName: string }>;
        return [
          race.name,
          race.description,
          ...(race.settings as string[]),
          ...lineage.map((item) => item.name),
          ...effectiveSettings.flatMap((item) => [item.value, item.sourceRaceName])
        ].join("\n").toLocaleLowerCase("zh-CN").includes(normalizedQuery);
      }).slice(0, 50)
      : [];
    const settings = accepts("setting")
      ? this.db.all(
        "SELECT id, title, content, category FROM settings WHERE work_id = ? AND (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\') LIMIT 50",
        workId,
        pattern,
        pattern
      )
      : [];
    const characters = accepts("character") ? this.db.all(
      `WITH RECURSIVE character_race_lineage(character_id, race_id, parent_race_id, name, path) AS (
         SELECT character.id, race.id, race.parent_race_id, race.name, race.name
         FROM characters character JOIN races race ON race.id = character.race_id
         WHERE character.work_id = ?
         UNION ALL
         SELECT lineage.character_id, parent.id, parent.parent_race_id, parent.name, parent.name || ' / ' || lineage.path
         FROM character_race_lineage lineage JOIN races parent ON parent.id = lineage.parent_race_id
       ), character_race_paths AS (
         SELECT character_id, path FROM character_race_lineage WHERE parent_race_id IS NULL
       )
       SELECT character.id, character.name, character.aliases_json, character.species, character.gender, character.is_dead,
              COALESCE(path.path, character.species) AS race_path
       FROM characters character LEFT JOIN character_race_paths path ON path.character_id = character.id
       WHERE character.work_id = ? AND character.merged_into_character_id IS NULL AND (
         character.name LIKE ? ESCAPE '\\' OR character.aliases_json LIKE ? ESCAPE '\\' OR character.species LIKE ? ESCAPE '\\'
         OR EXISTS (SELECT 1 FROM character_race_lineage lineage WHERE lineage.character_id = character.id AND lineage.name LIKE ? ESCAPE '\\')
       ) LIMIT 50`,
      workId,
      workId,
      pattern,
      pattern,
      pattern,
      pattern
    ) : [];
    const organizations = accepts("organization")
      ? this.db.all(
        "SELECT id, name, description, is_dissolved, settings_json FROM organizations WHERE work_id = ? AND (name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR settings_json LIKE ? ESCAPE '\\') LIMIT 50",
        workId,
        pattern,
        pattern,
        pattern
      )
      : [];
    const characterSections = accepts("character") ? this.searchCharacterProfileSections(workId, normalizedQuery, 30) : [];
    const snippet = (content: string): string => {
      const index = content.toLocaleLowerCase().indexOf(normalizedQuery);
      const start = Math.max(0, index - 40);
      return content.slice(start, start + 120);
    };
    return [
      ...characters.map((row) => ({
        type: "character",
        id: requiredString(row, "id"),
        title: requiredString(row, "name"),
        snippet: [requiredString(row, "race_path"), ...json<string[]>(requiredString(row, "aliases_json"), [])].filter(Boolean).join("、"),
        racePath: requiredString(row, "race_path"),
        gender: requiredString(row, "gender"),
        isDead: booleanValue(row, "is_dead")
      })),
      ...characterSections.map((section) => ({
        type: "character",
        id: String(section.characterId),
        sectionId: String(section.id),
        title: `${String(section.characterName)} / ${String(section.title)}`,
        snippet: snippet(String(section.contentMarkdown)),
        sectionType: String(section.sectionType),
        gender: String(section.gender),
        isDead: Boolean(section.isDead)
      })),
      ...settings.map((row) => ({ type: "setting", id: requiredString(row, "id"), title: requiredString(row, "title"), snippet: snippet(requiredString(row, "content")), category: requiredString(row, "category") })),
      ...races.map((race) => {
        const lineage = race.lineage as Array<{ id: string; name: string }>;
        const effectiveSettings = race.effectiveSettings as Array<{ value: string; sourceRaceId: string; sourceRaceName: string; inherited: boolean }>;
        return {
          type: "race",
          id: String(race.id),
          title: String(race.name),
          snippet: snippet(`${lineage.map((item) => item.name).join(" / ")}\n${String(race.description)}\n${effectiveSettings.map((item) => `${item.sourceRaceName}：${item.value}`).join("\n")}`),
          isExtinct: Boolean(race.isExtinct),
          lineage,
          effectiveSettings
        };
      }),
      ...organizations.map((row) => ({ type: "organization", id: requiredString(row, "id"), title: requiredString(row, "name"), snippet: snippet(`${requiredString(row, "description")}\n${json<string[]>(requiredString(row, "settings_json"), []).join("\n")}`), isDissolved: booleanValue(row, "is_dissolved") })),
      ...chapters.map((row) => ({ type: "chapter", id: requiredString(row, "id"), title: requiredString(row, "title"), snippet: snippet(requiredString(row, "content")), volumeId: requiredString(row, "volume_id") }))
    ];
  }

  exportWork(workId: string): Record<string, unknown> {
    const tree = this.getWorkTree(workId);
    return {
      schemaVersion: 8,
      exportedAt: now(),
      work: tree,
      drafts: this.listDrafts(workId, undefined, true),
      settings: this.listSettings(workId),
      characters: this.listCharacters(workId, true, true),
      races: this.listRaces(workId),
      organizations: this.listOrganizations(workId),
      timelineTracks: this.listTimelineTracks(workId),
      timeline: this.listTimelineEvents(workId),
      relationships: this.listRelationships(workId),
      outlines: this.listChapterOutlines(workId),
      foreshadows: this.listForeshadows(workId),
      reviews: this.listReviewItems(workId)
    };
  }

  exportText(workId: string, format: "txt" | "markdown"): string {
    const tree = this.getWorkTree(workId);
    const volumes = tree.volumes as Record<string, unknown>[];
    const lines: string[] = [];
    for (const volume of volumes) {
      lines.push(format === "markdown" ? `# ${String(volume.title)}` : String(volume.title), "");
      for (const chapter of volume.chapters as Record<string, unknown>[]) {
        lines.push(format === "markdown" ? `## ${String(chapter.title)}` : String(chapter.title), "", String(chapter.content), "");
      }
    }
    return lines.join("\n").trimEnd() + "\n";
  }

  async exportDocx(workId: string): Promise<Buffer> {
    const tree = this.getWorkTree(workId);
    const cover = this.findWorkCover(workId);
    const volumes = (tree.volumes as Record<string, unknown>[]).map((volume) => ({
      title: String(volume.title),
      chapters: (volume.chapters as Record<string, unknown>[]).map((chapter) => ({
        title: String(chapter.title),
        content: String(chapter.content ?? "")
      }))
    }));
    return exportWorkDocx({
      title: String(tree.title),
      volumes,
      cover: cover ? { mimeType: cover.mimeType, content: cover.content } : null
    });
  }

  async exportEpub(workId: string, volumeId?: string): Promise<{ title: string; archive: Awaited<ReturnType<typeof createEpubArchive>> }> {
    const work = this.getWork(workId);
    const allVolumeRows = this.db.all(
      "SELECT id, title FROM volumes WHERE work_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at",
      workId
    );
    const selectedVolume = volumeId ? allVolumeRows.find((volume) => requiredString(volume, "id") === volumeId) : undefined;
    if (volumeId && !selectedVolume) throw notFound("分卷");
    const sourceVolumeRows = selectedVolume ? [selectedVolume] : allVolumeRows;
    const chapterRows = volumeId
      ? this.db.all(
        `SELECT id, volume_id, title, version_no FROM chapters
         WHERE work_id = ? AND volume_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at`,
        workId,
        volumeId
      )
      : this.db.all(
        `SELECT id, volume_id, title, version_no FROM chapters
         WHERE work_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at`,
        workId
      );
    const chaptersByVolume = new Map<string, Row[]>();
    for (const chapter of chapterRows) {
      const chapterVolumeId = requiredString(chapter, "volume_id");
      const chapters = chaptersByVolume.get(chapterVolumeId) ?? [];
      chapters.push(chapter);
      chaptersByVolume.set(chapterVolumeId, chapters);
    }
    const title = selectedVolume ? `${String(work.title)} - ${requiredString(selectedVolume, "title")}` : String(work.title);
    const cover = this.findWorkCover(workId);
    const archive = await createEpubArchive({
      title,
      author: String(work.author ?? ""),
      description: String(work.description ?? ""),
      language: String(work.language ?? "zh-CN"),
      volumes: sourceVolumeRows.map((volume) => ({
        title: requiredString(volume, "title"),
        chapters: (chaptersByVolume.get(requiredString(volume, "id")) ?? []).map((chapter) => ({
          title: requiredString(chapter, "title"),
          content: () => {
            const chapterId = requiredString(chapter, "id");
            const versionNo = numberValue(chapter, "version_no");
            const current = this.db.get(
              "SELECT content FROM chapters WHERE id = ? AND work_id = ? AND version_no = ? AND deleted_at IS NULL",
              chapterId,
              workId,
              versionNo
            );
            if (current) return requiredString(current, "content");
            const historical = this.db.get(
              "SELECT content FROM chapter_versions WHERE chapter_id = ? AND work_id = ? AND version_no = ?",
              chapterId,
              workId,
              versionNo
            );
            if (!historical) throw new AppError(409, "EPUB_EXPORT_SOURCE_CHANGED", "导出过程中章节版本已不可用，请重新导出");
            return requiredString(historical, "content");
          }
        }))
      })),
      cover: cover ? { mimeType: cover.mimeType, content: cover.content } : null
    });
    return { title, archive };
  }

  async exportVolumeEpub(volumeId: string): Promise<{ title: string; archive: Awaited<ReturnType<typeof createEpubArchive>> }> {
    const volume = this.getVolume(volumeId);
    return this.exportEpub(String(volume.workId), volumeId);
  }

  listAuditLogs(workId: string): Record<string, unknown>[] {
    this.getWork(workId);
    return this.db.all(
      `SELECT log.*, user.display_name AS actor_display_name, user.username AS actor_username
       FROM audit_logs log LEFT JOIN users user ON user.id = log.user_id
       WHERE log.work_id = ? ORDER BY log.created_at DESC LIMIT 200`,
      workId
    ).map((row) => ({
      id: requiredString(row, "id"),
      action: requiredString(row, "action"),
      entityType: requiredString(row, "entity_type"),
      entityId: optionalString(row, "entity_id"),
      actor: optionalString(row, "actor_display_name") ?? optionalString(row, "actor_username") ?? requiredString(row, "actor"),
      userId: optionalString(row, "user_id"),
      detail: json(requiredString(row, "detail_json"), {}),
      createdAt: requiredString(row, "created_at")
    }));
  }

  listAuditLogsPage(workId: string, pagination: Pagination): PaginatedResult<Record<string, unknown>> {
    this.getWork(workId);
    const page = paginationSql(pagination);
    const rows = this.db.all(
      `SELECT log.*, user.display_name AS actor_display_name, user.username AS actor_username
       FROM audit_logs log LEFT JOIN users user ON user.id = log.user_id
       WHERE log.work_id = ? ORDER BY log.created_at DESC${page.sql}`,
      workId,
      ...page.params
    );
    return paginated(rows.map((row) => ({
      id: requiredString(row, "id"),
      action: requiredString(row, "action"),
      entityType: requiredString(row, "entity_type"),
      entityId: optionalString(row, "entity_id"),
      actor: optionalString(row, "actor_display_name") ?? optionalString(row, "actor_username") ?? requiredString(row, "actor"),
      userId: optionalString(row, "user_id"),
      detail: json(requiredString(row, "detail_json"), {}),
      createdAt: requiredString(row, "created_at")
    })), pagination);
  }

  getWritingProgress(workId: string, days = 30): Record<string, unknown> {
    const work = this.getWork(workId);
    const goal = this.db.get("SELECT * FROM writing_goals WHERE work_id = ?", workId);
    const dailyGoal = goal ? numberValue(goal, "daily_goal") : 1000;
    const targetTotal = goal ? numberValue(goal, "target_total") : 100000;
    const calendar = buildWritingCalendar(new Date(), days);
    const versions = this.db.all(
      `SELECT chapter_id, content, source, created_at FROM chapter_versions
       WHERE work_id = ? AND created_at < ? ORDER BY created_at, version_no, id`,
      workId,
      calendar.endExclusive
    );
    const chapterWords = new Map<string, number>();
    const events = new Map<string, Row[]>();
    for (const version of versions) {
      const day = writingDateKey(new Date(requiredString(version, "created_at")), calendar.timeZone);
      if (day < calendar.startKey) {
        chapterWords.set(requiredString(version, "chapter_id"), requiredString(version, "source") === "delete" ? 0 : countWords(requiredString(version, "content")));
      } else {
        const dayEvents = events.get(day) ?? [];
        dayEvents.push(version);
        events.set(day, dayEvents);
      }
    }
    let previousTotal = [...chapterWords.values()].reduce((sum, value) => sum + value, 0);
    const trend: Record<string, unknown>[] = [];
    for (const day of calendar.dateKeys) {
      for (const version of events.get(day) ?? []) {
        chapterWords.set(requiredString(version, "chapter_id"), requiredString(version, "source") === "delete" ? 0 : countWords(requiredString(version, "content")));
      }
      const words = [...chapterWords.values()].reduce((sum, value) => sum + value, 0);
      trend.push({ date: day, words, delta: words - previousTotal });
      previousTotal = words;
    }
    const todayProgress = Number((trend.at(-1) as Record<string, unknown> | undefined)?.delta ?? 0);
    return {
      goal: {
        dailyGoal,
        targetTotal,
        deadline: goal ? optionalString(goal, "deadline") : null,
        updatedAt: goal ? requiredString(goal, "updated_at") : null
      },
      currentWords: Number(work.wordCount ?? 0),
      todayWords: Math.max(0, todayProgress),
      dailyCompletion: dailyGoal > 0 ? Math.min(1, Math.max(0, todayProgress) / dailyGoal) : 0,
      totalCompletion: targetTotal > 0 ? Math.min(1, Number(work.wordCount ?? 0) / targetTotal) : 0,
      trend
    };
  }

  updateWritingGoal(workId: string, input: { dailyGoal: number; targetTotal: number; deadline: string | null }): Record<string, unknown> {
    this.getWork(workId);
    const timestamp = now();
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO writing_goals (work_id, daily_goal, target_total, deadline, created_at, updated_at, updated_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(work_id) DO UPDATE SET daily_goal = excluded.daily_goal, target_total = excluded.target_total,
         deadline = excluded.deadline, updated_at = excluded.updated_at, updated_by_user_id = excluded.updated_by_user_id`,
        workId,
        input.dailyGoal,
        input.targetTotal,
        input.deadline,
        timestamp,
        timestamp,
        currentRequestActor()?.userId ?? null
      );
      this.audit(workId, "work.writing_goal.updated", "work", workId, input);
    });
    return this.getWritingProgress(workId);
  }
}
