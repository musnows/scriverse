export const WORK_PERMISSION_MODULES = Object.freeze([
  { id: "prose", uiModule: "editor", label: "正文" },
  { id: "drafts", uiModule: "drafts", label: "想法" },
  { id: "settings", uiModule: "settings", label: "设定库" },
  { id: "characters", uiModule: "characters", label: "角色" },
  { id: "races", uiModule: "races", label: "种族" },
  { id: "organizations", uiModule: "organizations", label: "组织" },
  { id: "timeline", uiModule: "timeline", label: "时间轴" },
  { id: "relationships", uiModule: "relationships", label: "关系" },
  { id: "outlines", uiModule: "outlines", label: "大纲/伏笔" },
  { id: "reviews", uiModule: "reviews", label: "审核" },
  { id: "ai-chat", uiModule: "approvals", label: "AI 对话" },
  { id: "ai-analysis", uiModule: "tasks", label: "AI 分析" },
  { id: "ai-settings", uiModule: "ai-settings", label: "AI 设置" }
]);

const permissionModuleByUiModule = new Map(
  WORK_PERMISSION_MODULES.filter((item) => item.uiModule).map((item) => [item.uiModule, item.id])
);
const validAccess = new Set(["none", "read", "write"]);

function migrateLegacyModulePermissions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const migrated = { ...value };
  if (!validAccess.has(migrated.drafts)) {
    const prose = validAccess.has(migrated.prose) ? migrated.prose : "none";
    const settings = validAccess.has(migrated.settings) ? migrated.settings : "none";
    migrated.drafts = prose === "write" && settings === "write"
      ? "write"
      : prose === "none" || settings === "none" ? "none" : "read";
  }
  const legacyAi = validAccess.has(migrated.ai) ? migrated.ai : null;
  if (!validAccess.has(migrated["ai-chat"]) && legacyAi) migrated["ai-chat"] = legacyAi;
  if (!validAccess.has(migrated["ai-analysis"]) && validAccess.has(migrated.ai)) {
    migrated["ai-analysis"] = migrated.ai;
  }
  return migrated;
}

export function emptyModulePermissions() {
  return Object.fromEntries(WORK_PERMISSION_MODULES.map((item) => [item.id, "none"]));
}

export function normalizeModulePermissions(value, accessRole = "viewer") {
  const migrated = migrateLegacyModulePermissions(value);
  if (migrated && typeof migrated === "object" && !Array.isArray(migrated)
    && WORK_PERMISSION_MODULES.every((item) => validAccess.has(migrated[item.id]))) {
    return Object.fromEntries(WORK_PERMISSION_MODULES.map((item) => [item.id, migrated[item.id]]));
  }
  const fallback = emptyModulePermissions();
  for (const item of WORK_PERMISSION_MODULES) {
    fallback[item.id] = accessRole === "editor" || accessRole === "admin" || accessRole === "owner"
      ? "write"
      : accessRole === "viewer" || accessRole === "settings-editor" ? "read" : "none";
  }
  if (accessRole === "settings-editor") {
    fallback.prose = "read";
    fallback.reviews = "read";
    fallback["ai-chat"] = "read";
    fallback["ai-analysis"] = "read";
    fallback["ai-settings"] = "read";
  }
  return fallback;
}

export function permissionModuleForUiModule(uiModule) {
  return permissionModuleByUiModule.get(String(uiModule)) ?? "prose";
}

export function moduleAccess(work, moduleId) {
  if (!work) return "none";
  const permissions = normalizeModulePermissions(work.modulePermissions, work.accessRole);
  return permissions[moduleId] ?? "none";
}

export function canReadPermissionModule(work, moduleId) {
  const access = moduleAccess(work, moduleId);
  return access === "read" || access === "write";
}

export function canWritePermissionModule(work, moduleId) {
  return moduleAccess(work, moduleId) === "write";
}

export function canReadUiModule(work, uiModule) {
  return canReadPermissionModule(work, permissionModuleForUiModule(uiModule));
}

export function canWriteUiModule(work, uiModule) {
  return canWritePermissionModule(work, permissionModuleForUiModule(uiModule));
}

export function firstReadableUiModule(work) {
  return WORK_PERMISSION_MODULES.find((item) => item.uiModule && canReadUiModule(work, item.uiModule))?.uiModule ?? null;
}

export function permissionSummary(value) {
  const permissions = normalizeModulePermissions(value, "custom");
  const writable = WORK_PERMISSION_MODULES.filter((item) => permissions[item.id] === "write").map((item) => item.label);
  const readable = WORK_PERMISSION_MODULES.filter((item) => permissions[item.id] === "read").map((item) => item.label);
  const parts = [];
  if (writable.length) parts.push(`可编辑：${writable.join("、")}`);
  if (readable.length) parts.push(`只读：${readable.join("、")}`);
  if (!parts.length) parts.push("未授权任何模块");
  return parts.join("；");
}
