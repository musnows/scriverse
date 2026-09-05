export type WorkPermissionModule = "prose" | "drafts" | "settings" | "characters" | "races" | "organizations" | "timeline" | "relationships" | "outlines" | "reviews" | "ai-chat" | "ai-analysis" | "ai-settings";
export type WorkUiModule = "approvals" | "editor" | "drafts" | "settings" | "characters" | "races" | "organizations" | "timeline" | "comments" | "relationships" | "outlines" | "reviews" | "tasks" | "ai-settings";
export type WorkModuleAccess = "none" | "read" | "write";
export type WorkModulePermissions = Record<WorkPermissionModule, WorkModuleAccess>;
export type WorkPermissionAware = { accessRole?: string | null; modulePermissions?: WorkModulePermissions };

export const WORK_PERMISSION_MODULES: readonly Readonly<{ id: WorkPermissionModule; uiModule: WorkUiModule | null; label: string }>[];
export function emptyModulePermissions(): WorkModulePermissions;
export function normalizeModulePermissions(value: unknown, accessRole?: string): WorkModulePermissions;
export function permissionModuleForUiModule(uiModule: string): WorkPermissionModule;
export function moduleAccess(work: WorkPermissionAware | null | undefined, moduleId: string): WorkModuleAccess;
export function canReadPermissionModule(work: WorkPermissionAware | null | undefined, moduleId: string): boolean;
export function canWritePermissionModule(work: WorkPermissionAware | null | undefined, moduleId: string): boolean;
export function canReadUiModule(work: WorkPermissionAware | null | undefined, uiModule: string): boolean;
export function canWriteUiModule(work: WorkPermissionAware | null | undefined, uiModule: string): boolean;
export function firstReadableUiModule(work: WorkPermissionAware | null | undefined): WorkUiModule | null;
export function permissionSummary(value: unknown): string;
