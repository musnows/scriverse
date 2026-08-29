export const PROVIDER_STATUSES = ["enabled", "disabled", "error"] as const;
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number];

export const DRAFT_SETTING_MODULES = [
  "settings",
  "characters",
  "races",
  "organizations",
  "timeline",
  "relationships",
  "outlines"
] as const;
export type DraftSettingModule = (typeof DRAFT_SETTING_MODULES)[number];

export const CHARACTER_GENDERS = ["male", "female", "none", "unknown"] as const;
export type CharacterGender = (typeof CHARACTER_GENDERS)[number];

export const TASK_TYPES = [
  "chat",
  "continue",
  "polish",
  "chapter-analysis",
  "book-analysis",
  "timeline-analysis",
  "relationship-analysis",
  "consistency-check"
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/** 创建任务 API 允许新建的分析任务类型（运行层已实现对应执行路径）。 */
export const CREATABLE_ANALYSIS_TASK_TYPES = [
  "chapter-analysis",
  "character-extraction",
  "character-summary",
  "character-identity-audit",
  "timeline-analysis",
  "relationship-analysis",
  "worldview-analysis",
  "setting-extraction",
  "consistency-check",
  "book-analysis"
] as const;
export type CreatableAnalysisTaskType = (typeof CREATABLE_ANALYSIS_TASK_TYPES)[number];

/** 仅可读取的历史分析任务类型：创建 API 不允许新建，运行层保留防御性拒绝。 */
export const HISTORICAL_ANALYSIS_TASK_TYPES = ["structure", "report-update"] as const;

/** 全量分析任务类型（可新建 + 历史）：单一来源，供运行层白名单与历史任务读取。 */
export const ANALYSIS_TASK_TYPES = [...CREATABLE_ANALYSIS_TASK_TYPES, ...HISTORICAL_ANALYSIS_TASK_TYPES] as const;
export type AnalysisTaskType = (typeof ANALYSIS_TASK_TYPES)[number];

export const ANALYSIS_STATUSES = [
  "pending",
  "running",
  "completed",
  "partial",
  "failed",
  "review",
  "expired",
  "cancelled"
] as const;
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];

export type ParsedChapter = {
  title: string;
  content: string;
  order: number;
  chapterType: "正文" | "设定" | "作者的话" | "其他";
};

export type ParsedVolume = {
  title: string;
  kind: "main" | "prequel" | "extra" | "epilogue" | "appendix";
  source: "explicit" | "default";
  order: number;
  chapters: ParsedChapter[];
};

export type ParsedNovel = {
  volumes: ParsedVolume[];
  warnings: string[];
  wordCount: number;
  paragraphCount: number;
};

export type AiMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ContextScope = {
  type: "none" | "selection" | "chapter" | "volume" | "book" | "settings" | "settings-catalog" | "entities";
  chapterId?: string;
  /** 分析任务可以一次选择多个章节；旧任务继续使用 chapterId。 */
  chapterIds?: string[];
  volumeId?: string;
  /** 分析任务可以一次选择多个分卷；旧任务继续使用 volumeId。 */
  volumeIds?: string[];
  selection?: string;
  /** 当前正文操作目标的选区起点；只在本轮 Skill 激活时使用，不作为会话固定上下文。 */
  selectionStart?: number;
  /** 当前正文操作目标的选区终点。 */
  selectionEnd?: number;
  /** 当前正文操作目标的章节版本。 */
  writingChapterVersion?: number;
  characterIds?: string[];
  /** 指令关键词命中的角色（轻量卡，不含档案 Markdown 全文）。 */
  mentionCharacterIds?: string[];
  settingIds?: string[];
  raceIds?: string[];
  organizationIds?: string[];
  /** 用户主动选择的语义检索结果快照；仅对携带该标识的当前请求生效。 */
  semanticSnapshotId?: string;
  includeBookSummary?: boolean;
  /** 正文范围内是否注入锁定设定、组织/种族简表等；缺省为 true。设定库范围忽略此字段。 */
  includeSettingInfo?: boolean;
  includeAllSettings?: boolean;
  additionalPrompt?: string;
  preFilterRelationshipSources?: boolean;
  previewRelationshipChanges?: boolean;
  relationshipSourceRefs?: Array<{ sourceType: string; sourceId: string; sourceVersion: string }>;
  /** 服务端创建任务时固化的来源筛选摘要；创建 API 不接收该内部字段。 */
  relationshipSourceSelectionSummary?: {
    policyVersion: number;
    indexGeneration: number;
    exactSourceCount: number;
    fuzzyCandidateCount: number;
    confirmedSourceCount: number;
    rejectedSourceCount: number;
    uncertainSourceCount: number;
    reviewIds: string[];
  };
  replaceExistingRelationships?: boolean;
  excludeRelationshipConstraints?: boolean;
  suppressAutomaticContext?: boolean;
};

export type AiInjectedEntities = {
  characters: string[];
  races: string[];
  organizations: string[];
};
