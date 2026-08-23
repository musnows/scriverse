import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import type { CredentialVault } from "./credential-vault.js";
import { Database, PLATFORM_AI_WORK_ID, type Row } from "./database.js";
import { AppError, notFound } from "./errors.js";
import { HYBRID_SEARCH_PERMISSION_MODULES, hybridSearchPermissionModule } from "./hybrid-search.js";
import { sanitizeRequestPath } from "./http-logging.js";
import { accountReference, logger } from "./logger.js";
import { paginated, paginationSql, type PaginatedResult, type Pagination } from "./pagination.js";
import { runWithRequestActor, type RequestActor } from "./request-context.js";
import { normalizeApiPath } from "./security.js";
import { escapeSqlLikePattern } from "./utils.js";
import {
  canReadWorkModule,
  canWriteWorkModule,
  chapterAnnotationPermissionModule,
  classifyWorkModulePermissions,
  fullWorkModulePermissions,
  settingsEditorModulePermissions,
  storedMembershipForPermissions,
  storedWorkModulePermissions,
  proseReplacementPermissionModules,
  workPermissionModuleLabels,
  workPermissionModules,
  type PublicWorkAccessRole,
  type WorkModulePermissions,
  type WorkPermissionModule
} from "./work-permissions.js";

export type AuthUser = RequestActor & {
  status: "active" | "disabled";
  createdAt: string;
  avatarUrl: string | null;
  onboardingCompleted: boolean;
};

export type UserAvatar = {
  mimeType: string;
  content: Buffer;
  byteLength: number;
  sha256: string;
  width: number;
  height: number;
  updatedAt: string;
};

export function relationshipAnalysisReadModules(scope: unknown): WorkPermissionModule[] {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return [];
  const value = scope as Record<string, unknown>;
  if (!Array.isArray(value.characterIds) || value.characterIds.length === 0) return [];
  const modules = new Set<WorkPermissionModule>(["characters"]);
  if (value.type !== "settings") modules.add("prose");
  if (value.type === "settings" || value.includeAllSettings === true) {
    for (const module of ["settings", "races", "organizations", "timeline", "relationships", "outlines", "reviews"] as const) {
      modules.add(module);
    }
  }
  return [...modules];
}

export type AuthSession = {
  id: string;
  user: AuthUser;
  csrfToken: string;
};

export type AuthApiKey = {
  user: AuthUser;
  prefix: string;
};

export type WorkAccessRole = "admin" | PublicWorkAccessRole;
export type AssignableWorkMemberRole = "editor" | "settings-editor" | "viewer";
export type WorkMemberPermissionInput = { role: AssignableWorkMemberRole } | { permissions: WorkModulePermissions };

export type ApiKeyStatus = {
  configured: boolean;
  prefix: string | null;
  createdAt: string | null;
  rotatedAt: string | null;
  lastUsedAt: string | null;
  copyable: boolean;
};

declare global {
  namespace Express {
    interface Request {
      authSession?: AuthSession;
      authUser?: AuthUser;
      authMethod?: "session" | "api-key";
      authApiKey?: AuthApiKey;
    }
  }
}

const sessionCookieName = "scriverse_session";
const sessionLifetimeMs = 30 * 24 * 60 * 60_000;
const apiKeyPrefix = "scrv_";
function membershipAccessRole(row: Row | undefined): PublicWorkAccessRole | null {
  const role = String(row?.role ?? "");
  if (role === "owner") return "owner";
  if (role !== "editor" && role !== "viewer") return null;
  return classifyWorkModulePermissions(storedWorkModulePermissions(role, row?.permissions_json));
}

function permissionsFromInput(input: WorkMemberPermissionInput): WorkModulePermissions {
  if ("permissions" in input) return input.permissions;
  if (input.role === "editor") return fullWorkModulePermissions();
  if (input.role === "settings-editor") return settingsEditorModulePermissions();
  return storedWorkModulePermissions("viewer", "{}");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeUsername(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
}

function parseCookies(header: string | undefined): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of header?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    try {
      result.set(name, decodeURIComponent(part.slice(separator + 1).trim()));
    } catch {
      // 无效 Cookie 不参与身份验证。
    }
  }
  return result;
}

function apiKeyCredential(request: Request): string | null {
  const direct = request.get("x-scriverse-api-key")?.trim();
  if (direct) return direct;
  const authorization = request.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  return authorization.slice(7).trim();
}

function mapUser(row: Row): AuthUser {
  const avatarSha256 = row.avatar_sha256 === null || row.avatar_sha256 === undefined
    ? null
    : String(row.avatar_sha256);
  return {
    userId: String(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    role: String(row.role) === "admin" ? "admin" : "user",
    status: String(row.status) === "disabled" ? "disabled" : "active",
    createdAt: String(row.created_at),
    avatarUrl: avatarSha256
      ? `/api/user-avatars/${encodeURIComponent(String(row.id))}?v=${encodeURIComponent(avatarSha256)}`
      : null,
    onboardingCompleted: row.onboarding_completed_at !== null && row.onboarding_completed_at !== undefined
  };
}

function passwordDigest(password: string, salt: string): string {
  return scryptSync(password, salt, 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("base64");
}

function workIdFromPath(database: Database, pathname: string): string | null {
  const decoded = pathname.split("/").map((part) => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
  const root = (decoded[1] ?? "").toLocaleLowerCase("en-US");
  const resource = (decoded[2] ?? "").toLocaleLowerCase("en-US");
  if (root !== "api") return null;
  if (resource === "works" && decoded[3] && decoded[3].toLocaleLowerCase("en-US") !== "import") return decoded[3];
  const tableByResource: Record<string, string> = {
    volumes: "volumes",
    chapters: "chapters",
    "chapter-annotations": "chapter_annotations",
    drafts: "drafts",
    settings: "settings",
    characters: "characters",
    "character-sections": "character_profile_sections",
    attachments: "attachments",
    races: "races",
    organizations: "organizations",
    "timeline-tracks": "timeline_tracks",
    timeline: "timeline_events",
    relationships: "relationships",
    foreshadows: "foreshadows",
    reviews: "review_items",
    tasks: "analysis_tasks",
    "ai-conversations": "ai_conversations",
    suggestions: "ai_suggestions"
  };
  const table = tableByResource[resource];
  if (table && decoded[3]) {
    const row = database.get<{ work_id: string }>(`SELECT work_id FROM ${table} WHERE id = ?`, decoded[3]);
    if (row) return row.work_id;
    if (table === "chapters") {
      const version = database.get<{ work_id: string }>(
        "SELECT work_id FROM chapter_versions WHERE chapter_id = ? LIMIT 1",
        decoded[3]
      );
      if (version) return version.work_id;
    }
    if (table === "characters") {
      const version = database.get<{ work_id: string }>(
        "SELECT work_id FROM character_versions WHERE character_id = ? LIMIT 1",
        decoded[3]
      );
      if (version) return version.work_id;
    }
    if (table === "character_profile_sections") {
      const version = database.get<{ work_id: string }>(
        "SELECT work_id FROM character_profile_section_versions WHERE section_id = ? LIMIT 1",
        decoded[3]
      );
      if (version) return version.work_id;
    }
    throw notFound("记录");
  }
  if (resource === "foreshadow-occurrences" && decoded[3]) {
    const row = database.get<{ work_id: string }>(
      `SELECT foreshadow.work_id FROM foreshadow_occurrences occurrence
       JOIN foreshadows foreshadow ON foreshadow.id = occurrence.foreshadow_id WHERE occurrence.id = ?`,
      decoded[3]
    );
    if (!row) throw notFound("伏笔出现点");
    return row.work_id;
  }
  if (resource === "entity-versions" && decoded[3] && decoded[4]) {
    const row = database.get<{ work_id: string }>(
      "SELECT work_id FROM entity_versions WHERE entity_type = ? AND entity_id = ? LIMIT 1",
      decoded[3].toLocaleLowerCase("en-US"),
      decoded[4]
    );
    if (!row) throw notFound("版本记录");
    return row.work_id;
  }
  return null;
}

function apiKeyCiphertext(row: Row | undefined): { encrypted: string; iv: string; tag: string } | null {
  const encrypted = String(row?.key_encrypted ?? "");
  const iv = String(row?.key_iv ?? "");
  const tag = String(row?.key_tag ?? "");
  if (!encrypted || !iv || !tag) return null;
  return { encrypted, iv, tag };
}

export class UserAuthService {
  constructor(
    private readonly database: Database,
    private readonly vault: CredentialVault
  ) {
    const revokedAt = new Date().toISOString();
    const result = this.database.run(
      "UPDATE user_sessions SET revoked_at = ? WHERE revoked_at IS NULL",
      revokedAt
    );
    if (result.changes > 0) {
      logger.info("auth.sessions.invalidated_on_startup", { count: result.changes });
    }
  }

  resolveWorkId(pathname: string): string | null {
    return workIdFromPath(this.database, pathname);
  }

  chapterAnnotationAccess(annotationId: string): { kind: "note" | "todo"; createdByUserId: string | null } {
    const row = this.database.get<{ kind: string; created_by_user_id: string | null }>(
      "SELECT kind, created_by_user_id FROM chapter_annotations WHERE id = ?",
      annotationId
    );
    if (!row) throw notFound("章节批注");
    return {
      kind: row.kind === "todo" ? "todo" : "note",
      createdByUserId: row.created_by_user_id ?? null
    };
  }

  hasUsers(): boolean {
    return Number(this.database.get("SELECT COUNT(*) AS count FROM users")?.count ?? 0) > 0;
  }

  private createSession(userId: string): { token: string; session: AuthSession } {
    const token = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(24).toString("base64url");
    const sessionId = randomUUID();
    const timestamp = new Date();
    this.database.run(
      `INSERT INTO user_sessions (id, user_id, token_hash, csrf_token, created_at, expires_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      sessionId,
      userId,
      sha256(token),
      csrfToken,
      timestamp.toISOString(),
      new Date(timestamp.getTime() + sessionLifetimeMs).toISOString(),
      timestamp.toISOString()
    );
    const user = this.getUser(userId);
    return { token, session: { id: sessionId, user, csrfToken } };
  }

  register(input: { username: string; password: string }): { token: string; session: AuthSession } {
    const normalizedUsername = normalizeUsername(input.username);
    const timestamp = new Date().toISOString();
    const userId = randomUUID();
    const salt = randomBytes(16).toString("base64url");
    return this.database.transaction(() => {
      const role = Number(this.database.get("SELECT COUNT(*) AS count FROM users")?.count ?? 0) === 0 ? "admin" : "user";
      this.database.run(
        `INSERT INTO users (id, username, normalized_username, display_name, password_hash, password_salt, role, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        userId,
        input.username.trim(),
        normalizedUsername,
        input.username.trim(),
        passwordDigest(input.password, salt),
        salt,
        role,
        timestamp,
        timestamp
      );
      this.database.run("DELETE FROM login_attempts WHERE normalized_username = ?", normalizedUsername);
      if (role === "admin") {
        this.database.run("UPDATE works SET owner_user_id = ? WHERE owner_user_id IS NULL AND id <> ?", userId, PLATFORM_AI_WORK_ID);
        this.database.run(
          `UPDATE ai_conversations SET created_by_user_id = ?
           WHERE created_by_user_id IS NULL
             AND work_id IN (SELECT id FROM works WHERE owner_user_id = ? AND id <> ?)`,
          userId,
          userId,
          PLATFORM_AI_WORK_ID
        );
        this.database.run(
          `INSERT OR IGNORE INTO work_memberships (work_id, user_id, role, invited_by_user_id, created_at)
           SELECT id, ?, 'owner', ?, ? FROM works WHERE owner_user_id = ? AND id <> ?`,
          userId,
          userId,
          timestamp,
          userId,
          PLATFORM_AI_WORK_ID
        );
      }
      return this.createSession(userId);
    });
  }

  login(username: string, password: string): { token: string; session: AuthSession } {
    const normalizedUsername = normalizeUsername(username);
    const timestamp = new Date();
    const row = this.database.get(
      "SELECT * FROM users WHERE normalized_username = ?",
      normalizedUsername
    );
    const fallbackSalt = "invalid-login-salt";
    const calculated = passwordDigest(password, String(row?.password_salt ?? fallbackSalt));
    const valid = row && safeEqual(calculated, String(row.password_hash));
    if (!valid) {
      logger.warn("auth.login.failed", { reason: "invalid_credentials" });
      throw new AppError(401, "INVALID_CREDENTIALS", "用户名或密码不正确");
    }
    const user = mapUser(row);
    if (user.status !== "active") {
      logger.warn("auth.login.failed", { reason: "account_disabled", actorRef: accountReference(user.userId) });
      throw new AppError(403, "ACCOUNT_DISABLED", "该账户已被停用");
    }
    return this.database.transaction(() => {
      const loginAt = timestamp.toISOString();
      this.database.run("DELETE FROM login_attempts WHERE normalized_username = ?", normalizedUsername);
      this.database.run("UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?", loginAt, loginAt, user.userId);
      return this.createSession(user.userId);
    });
  }

  authenticate(request: Request): AuthSession | null {
    const token = parseCookies(request.get("cookie")).get(sessionCookieName);
    if (!token) return null;
    const row = this.database.get(
      `SELECT session.id AS session_id, session.csrf_token, session.expires_at, session.revoked_at,
       user.* FROM user_sessions session JOIN users user ON user.id = session.user_id WHERE session.token_hash = ?`,
      sha256(token)
    );
    if (!row || row.revoked_at || String(row.expires_at) <= new Date().toISOString()) return null;
    const user = mapUser(row);
    if (user.status !== "active") return null;
    this.database.run("UPDATE user_sessions SET last_seen_at = ? WHERE id = ?", new Date().toISOString(), String(row.session_id));
    return { id: String(row.session_id), csrfToken: String(row.csrf_token), user };
  }

  authenticateApiKey(request: Request): AuthApiKey | null {
    const key = apiKeyCredential(request);
    if (!key || !key.startsWith(apiKeyPrefix) || key.length > 200) return null;
    const row = this.database.get(
      `SELECT api_key.key_prefix, user.* FROM user_api_keys api_key
       JOIN users user ON user.id = api_key.user_id WHERE api_key.key_hash = ?`,
      sha256(key)
    );
    if (!row) return null;
    const user = mapUser(row);
    if (user.status !== "active") return null;
    this.database.run("UPDATE user_api_keys SET last_used_at = ? WHERE user_id = ?", new Date().toISOString(), user.userId);
    return { user, prefix: String(row.key_prefix) };
  }

  hasApiKeyCredential(request: Request): boolean {
    return apiKeyCredential(request) !== null;
  }

  getApiKeyStatus(userId: string): ApiKeyStatus {
    this.getUser(userId);
    const row = this.database.get("SELECT * FROM user_api_keys WHERE user_id = ?", userId);
    if (!row) {
      return { configured: false, prefix: null, createdAt: null, rotatedAt: null, lastUsedAt: null, copyable: false };
    }
    return {
      configured: true,
      prefix: String(row.key_prefix),
      createdAt: String(row.created_at),
      rotatedAt: String(row.rotated_at),
      lastUsedAt: row.last_used_at === null ? null : String(row.last_used_at),
      copyable: apiKeyCiphertext(row) !== null
    };
  }

  resetApiKey(userId: string): ApiKeyStatus & { apiKey: string } {
    this.getUser(userId);
    const apiKey = `${apiKeyPrefix}${randomBytes(32).toString("base64url")}`;
    const prefix = apiKey.slice(0, 13);
    const timestamp = new Date().toISOString();
    const encrypted = this.vault.encrypt(apiKey);
    this.database.run(
      `INSERT INTO user_api_keys (user_id, key_hash, key_prefix, created_at, rotated_at, last_used_at, key_encrypted, key_iv, key_tag)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         key_hash = excluded.key_hash,
         key_prefix = excluded.key_prefix,
         rotated_at = excluded.rotated_at,
         last_used_at = NULL,
         key_encrypted = excluded.key_encrypted,
         key_iv = excluded.key_iv,
         key_tag = excluded.key_tag`,
      userId,
      sha256(apiKey),
      prefix,
      timestamp,
      timestamp,
      encrypted.encrypted,
      encrypted.iv,
      encrypted.tag
    );
    return { ...this.getApiKeyStatus(userId), apiKey };
  }

  revealApiKey(userId: string): { apiKey: string; prefix: string } {
    this.getUser(userId);
    const row = this.database.get("SELECT * FROM user_api_keys WHERE user_id = ?", userId);
    if (!row) throw new AppError(404, "API_KEY_NOT_CONFIGURED", "尚未生成 API Key");
    const ciphertext = apiKeyCiphertext(row);
    if (!ciphertext) throw new AppError(409, "API_KEY_NOT_RECOVERABLE", "当前 API Key 无法复制，请重置后再试");
    try {
      return { apiKey: this.vault.decrypt(ciphertext), prefix: String(row.key_prefix) };
    } catch {
      throw new AppError(409, "API_KEY_NOT_RECOVERABLE", "当前 API Key 无法复制，请重置后再试");
    }
  }

  revoke(sessionId: string): void {
    this.database.run("UPDATE user_sessions SET revoked_at = ? WHERE id = ?", new Date().toISOString(), sessionId);
  }

  getUser(userId: string): AuthUser {
    const row = this.database.get("SELECT * FROM users WHERE id = ?", userId);
    if (!row) throw notFound("用户");
    return mapUser(row);
  }

  listUsers(): AuthUser[] {
    return this.database.all("SELECT * FROM users ORDER BY created_at, username").map(mapUser);
  }

  listUsersPage(pagination: Pagination): PaginatedResult<AuthUser> {
    const page = paginationSql(pagination);
    const rows = this.database.all(`SELECT * FROM users ORDER BY created_at, username${page.sql}`, ...page.params);
    return paginated(rows.map(mapUser), pagination);
  }

  directory(query: string): Pick<AuthUser, "userId" | "username" | "displayName" | "avatarUrl">[] {
    const escapedQuery = escapeSqlLikePattern(query.trim().slice(0, 100));
    const pattern = `%${escapedQuery}%`;
    return this.database.all(
      `SELECT * FROM users WHERE status = 'active' AND (username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')
       ORDER BY username LIMIT 50`,
      pattern,
      pattern
    ).map((row) => {
      const user = mapUser(row);
      return { userId: user.userId, username: user.username, displayName: user.displayName, avatarUrl: user.avatarUrl };
    });
  }

  directoryPage(query: string, pagination: Pagination): PaginatedResult<Pick<AuthUser, "userId" | "username" | "displayName" | "avatarUrl">> {
    const escapedQuery = escapeSqlLikePattern(query.trim().slice(0, 100));
    const pattern = `%${escapedQuery}%`;
    const page = paginationSql(pagination);
    const rows = this.database.all(
      `SELECT * FROM users WHERE status = 'active' AND (username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')
       ORDER BY username${page.sql}`,
      pattern,
      pattern,
      ...page.params
    );
    return paginated(rows.map((row) => {
      const user = mapUser(row);
      return { userId: user.userId, username: user.username, displayName: user.displayName, avatarUrl: user.avatarUrl };
    }), pagination);
  }

  updateUser(actor: AuthUser, userId: string, input: { role?: "admin" | "user"; status?: "active" | "disabled" }): AuthUser {
    if (actor.role !== "admin") throw new AppError(403, "ADMIN_REQUIRED", "该操作仅限系统管理员");
    const current = this.getUser(userId);
    const nextRole = input.role ?? current.role;
    const nextStatus = input.status ?? current.status;
    if (actor.userId === userId && (nextRole !== "admin" || nextStatus !== "active")) {
      throw new AppError(409, "CANNOT_DISABLE_SELF", "不能停用自己或移除自己的管理员身份");
    }
    if (current.role === "admin" && current.status === "active" && (nextRole !== "admin" || nextStatus !== "active")) {
      const activeAdmins = Number(this.database.get("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND status = 'active'")?.count ?? 0);
      if (activeAdmins <= 1) throw new AppError(409, "LAST_ADMIN_REQUIRED", "系统至少需要保留一名可用管理员");
    }
    return this.database.transaction(() => {
      this.database.run("UPDATE users SET role = ?, status = ?, updated_at = ? WHERE id = ?", nextRole, nextStatus, new Date().toISOString(), userId);
      if (nextStatus === "disabled") {
        this.database.run(
          "UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
          new Date().toISOString(),
          userId
        );
      }
      return this.getUser(userId);
    });
  }

  updateProfile(userId: string, displayName: string): AuthUser {
    this.database.run("UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?", displayName.trim(), new Date().toISOString(), userId);
    return this.getUser(userId);
  }

  completeOnboarding(userId: string): AuthUser {
    this.getUser(userId);
    const timestamp = new Date().toISOString();
    this.database.run(
      "UPDATE users SET onboarding_completed_at = COALESCE(onboarding_completed_at, ?), updated_at = ? WHERE id = ?",
      timestamp,
      timestamp,
      userId
    );
    return this.getUser(userId);
  }

  setAvatar(userId: string, input: { mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif"; content: Buffer; width: number; height: number }): AuthUser {
    this.getUser(userId);
    const timestamp = new Date().toISOString();
    const digest = createHash("sha256").update(input.content).digest("hex");
    this.database.transaction(() => {
      this.database.run(
        `INSERT INTO user_avatars (user_id, mime_type, content, byte_length, sha256, width, height, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET mime_type = excluded.mime_type, content = excluded.content,
         byte_length = excluded.byte_length, sha256 = excluded.sha256, width = excluded.width,
         height = excluded.height, updated_at = excluded.updated_at`,
        userId,
        input.mimeType,
        input.content,
        input.content.byteLength,
        digest,
        input.width,
        input.height,
        timestamp
      );
      this.database.run("UPDATE users SET avatar_updated_at = ?, avatar_sha256 = ?, updated_at = ? WHERE id = ?", timestamp, digest, timestamp, userId);
    });
    return this.getUser(userId);
  }

  getAvatar(userId: string): UserAvatar {
    this.getUser(userId);
    const row = this.database.get("SELECT * FROM user_avatars WHERE user_id = ?", userId);
    if (!row) throw notFound("用户头像");
    return {
      mimeType: String(row.mime_type),
      content: Buffer.from(row.content as Uint8Array),
      byteLength: Number(row.byte_length),
      sha256: String(row.sha256),
      width: Number(row.width),
      height: Number(row.height),
      updatedAt: String(row.updated_at)
    };
  }

  deleteAvatar(userId: string): AuthUser {
    this.getUser(userId);
    this.database.transaction(() => {
      this.database.run("DELETE FROM user_avatars WHERE user_id = ?", userId);
      this.database.run("UPDATE users SET avatar_updated_at = NULL, avatar_sha256 = NULL, updated_at = ? WHERE id = ?", new Date().toISOString(), userId);
    });
    return this.getUser(userId);
  }

  changePassword(userId: string, sessionId: string, currentPassword: string, newPassword: string): void {
    const row = this.database.get("SELECT * FROM users WHERE id = ?", userId);
    if (!row) throw notFound("用户");
    const calculated = passwordDigest(currentPassword, String(row.password_salt));
    if (!safeEqual(calculated, String(row.password_hash))) throw new AppError(401, "INVALID_CURRENT_PASSWORD", "当前密码错误，请重新输入");
    const salt = randomBytes(16).toString("base64url");
    const timestamp = new Date().toISOString();
    this.database.transaction(() => {
      this.database.run("UPDATE users SET password_hash = ?, password_salt = ?, updated_at = ? WHERE id = ?", passwordDigest(newPassword, salt), salt, timestamp, userId);
      this.database.run("UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL", timestamp, userId, sessionId);
      this.database.run("DELETE FROM login_attempts WHERE normalized_username = ?", String(row.normalized_username));
    });
  }

  listMembers(workId: string): Record<string, unknown>[] {
    return this.database.all(
      `SELECT membership.role, membership.permissions_json, membership.created_at, user.id, user.username, user.display_name, user.status, user.avatar_sha256
       FROM work_memberships membership JOIN users user ON user.id = membership.user_id
       WHERE membership.work_id = ? ORDER BY CASE membership.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, user.username`,
      workId
    ).map((row) => {
      const permissions = storedWorkModulePermissions(String(row.role), row.permissions_json);
      return {
        userId: String(row.id), username: String(row.username), displayName: String(row.display_name),
        role: membershipAccessRole(row), permissions, status: String(row.status), createdAt: String(row.created_at),
        avatarUrl: row.avatar_sha256
          ? `/api/user-avatars/${encodeURIComponent(String(row.id))}?v=${encodeURIComponent(String(row.avatar_sha256))}`
        : null
      };
    });
  }

  listMembersPage(workId: string, pagination: Pagination): PaginatedResult<Record<string, unknown>> {
    const page = paginationSql(pagination);
    const rows = this.database.all(
      `SELECT membership.role, membership.permissions_json, membership.created_at, user.id, user.username, user.display_name, user.status, user.avatar_sha256
       FROM work_memberships membership JOIN users user ON user.id = membership.user_id
       WHERE membership.work_id = ? ORDER BY CASE membership.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, user.username${page.sql}`,
      workId,
      ...page.params
    );
    return paginated(rows.map((row) => {
      const permissions = storedWorkModulePermissions(String(row.role), row.permissions_json);
      return {
        userId: String(row.id), username: String(row.username), displayName: String(row.display_name),
        role: membershipAccessRole(row), permissions, status: String(row.status), createdAt: String(row.created_at),
        avatarUrl: row.avatar_sha256
          ? `/api/user-avatars/${encodeURIComponent(String(row.id))}?v=${encodeURIComponent(String(row.avatar_sha256))}`
        : null
      };
    }), pagination);
  }

  addMember(workId: string, userId: string, input: WorkMemberPermissionInput, invitedByUserId: string): Record<string, unknown>[] {
    const work = this.database.get("SELECT owner_user_id FROM works WHERE id = ?", workId);
    if (!work) throw notFound("作品");
    if (String(work.owner_user_id ?? "") === userId) throw new AppError(409, "OWNER_REQUIRED", "不能修改作品创建者权限");
    const user = this.getUser(userId);
    if (user.status !== "active") throw new AppError(409, "USER_DISABLED", "不能邀请已停用用户");
    const stored = storedMembershipForPermissions(permissionsFromInput(input));
    this.database.run(
      `INSERT INTO work_memberships (work_id, user_id, role, permissions_json, invited_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(work_id, user_id) DO UPDATE SET
       role = excluded.role, permissions_json = excluded.permissions_json, invited_by_user_id = excluded.invited_by_user_id`,
      workId,
      userId,
      stored.role,
      stored.permissionsJson,
      invitedByUserId,
      new Date().toISOString()
    );
    return this.listMembers(workId);
  }

  updateMemberPermissions(workId: string, userId: string, input: WorkMemberPermissionInput): Record<string, unknown>[] {
    const work = this.database.get("SELECT owner_user_id FROM works WHERE id = ?", workId);
    if (!work) throw notFound("作品");
    if (String(work.owner_user_id ?? "") === userId) throw new AppError(409, "OWNER_REQUIRED", "不能修改作品创建者权限");
    const stored = storedMembershipForPermissions(permissionsFromInput(input));
    const result = this.database.run(
      "UPDATE work_memberships SET role = ?, permissions_json = ? WHERE work_id = ? AND user_id = ? AND role <> 'owner'",
      stored.role,
      stored.permissionsJson,
      workId,
      userId
    );
    if (result.changes === 0) throw notFound("作品成员");
    return this.listMembers(workId);
  }

  removeMember(workId: string, userId: string): Record<string, unknown>[] {
    const work = this.database.get("SELECT owner_user_id FROM works WHERE id = ?", workId);
    if (!work) throw notFound("作品");
    if (String(work.owner_user_id ?? "") === userId) throw new AppError(409, "OWNER_REQUIRED", "不能移除作品创建者");
    this.database.run("DELETE FROM work_memberships WHERE work_id = ? AND user_id = ?", workId, userId);
    return this.listMembers(workId);
  }

  workRole(user: AuthUser, workId: string, allowAdminAccess = true): WorkAccessRole | null {
    if (allowAdminAccess && user.role === "admin") return "admin";
    const work = this.database.get("SELECT owner_user_id FROM works WHERE id = ? AND deleted_at IS NULL", workId);
    if (!work) throw notFound("作品");
    if (String(work.owner_user_id ?? "") === user.userId) return "owner";
    const membership = this.database.get("SELECT role, permissions_json FROM work_memberships WHERE work_id = ? AND user_id = ?", workId, user.userId);
    return membershipAccessRole(membership);
  }

  workModulePermissions(user: AuthUser, workId: string, allowAdminAccess = true): WorkModulePermissions | null {
    if (allowAdminAccess && user.role === "admin") return fullWorkModulePermissions();
    const work = this.database.get("SELECT owner_user_id FROM works WHERE id = ? AND deleted_at IS NULL", workId);
    if (!work) throw notFound("作品");
    if (String(work.owner_user_id ?? "") === user.userId) return fullWorkModulePermissions();
    const membership = this.database.get("SELECT role, permissions_json FROM work_memberships WHERE work_id = ? AND user_id = ?", workId, user.userId);
    if (!membership) return null;
    return storedWorkModulePermissions(String(membership.role), membership.permissions_json);
  }

  assertActiveWork(workId: string): void {
    if (!this.database.get("SELECT 1 AS present FROM works WHERE id = ? AND deleted_at IS NULL", workId)) throw notFound("作品");
  }

  assertDeletedWorkAccess(user: AuthUser, workId: string, allowAdminAccess = true): void {
    const work = this.database.get("SELECT owner_user_id FROM works WHERE id = ? AND deleted_at IS NOT NULL", workId);
    if (!work) throw notFound("回收站作品");
    if (allowAdminAccess && user.role === "admin") return;
    if (String(work.owner_user_id ?? "") !== user.userId) {
      throw new AppError(403, "WORK_OWNER_REQUIRED", "该操作仅限作品创建者或系统管理员");
    }
  }

  assertWorkAccess(
    user: AuthUser,
    workId: string,
    requirements: {
      read?: readonly WorkPermissionModule[];
      write?: readonly WorkPermissionModule[];
      anyRead?: readonly WorkPermissionModule[];
      anyWrite?: readonly WorkPermissionModule[];
    } = {},
    ownerOnly = false,
    allowAdminAccess = true
  ): void {
    if (workId === PLATFORM_AI_WORK_ID && (!allowAdminAccess || user.role !== "admin")) throw new AppError(403, "ADMIN_REQUIRED", "该操作仅限系统管理员");
    const role = this.workRole(user, workId, allowAdminAccess);
    if (!role) throw new AppError(403, "WORK_ACCESS_DENIED", "你没有访问这部作品的权限");
    if (ownerOnly && role !== "admin" && role !== "owner") throw new AppError(403, "WORK_OWNER_REQUIRED", "该操作仅限作品创建者或系统管理员");
    if (role === "admin" || role === "owner") return;
    const permissions = this.workModulePermissions(user, workId, allowAdminAccess);
    if (!permissions) throw new AppError(403, "WORK_ACCESS_DENIED", "你没有访问这部作品的权限");
    for (const module of requirements.read ?? []) {
      if (!canReadWorkModule(permissions, module)) {
        throw new AppError(403, "WORK_MODULE_READ_DENIED", `你没有读取“${workPermissionModuleLabels[module]}”模块的权限`);
      }
    }
    if ((requirements.anyRead?.length ?? 0) > 0 && !requirements.anyRead!.some((module) => canReadWorkModule(permissions, module))) {
      const labels = requirements.anyRead!.map((module) => workPermissionModuleLabels[module]).join("或");
      throw new AppError(403, "WORK_MODULE_READ_DENIED", `你没有读取“${labels}”模块的权限`);
    }
    for (const module of requirements.write ?? []) {
      if (canWriteWorkModule(permissions, module)) continue;
      if (role === "viewer") throw new AppError(403, "WORK_EDIT_DENIED", "你没有编辑这部作品的权限");
      if (role === "settings-editor") {
        throw new AppError(403, "WORK_PROSE_EDIT_DENIED", "你只能编辑已授权的设定资料，不能执行此操作");
      }
      throw new AppError(403, "WORK_MODULE_WRITE_DENIED", `你没有编辑“${workPermissionModuleLabels[module]}”模块的权限`);
    }
    if ((requirements.anyWrite?.length ?? 0) > 0 && !requirements.anyWrite!.some((module) => canWriteWorkModule(permissions, module))) {
      if (role === "viewer") throw new AppError(403, "WORK_EDIT_DENIED", "你没有编辑这部作品的权限");
      if (role === "settings-editor") {
        throw new AppError(403, "WORK_PROSE_EDIT_DENIED", "你只能编辑已授权的设定资料，不能执行此操作");
      }
      const labels = requirements.anyWrite!.map((module) => workPermissionModuleLabels[module]).join("或");
      throw new AppError(403, "WORK_MODULE_WRITE_DENIED", `你没有编辑“${labels}”模块的权限`);
    }
  }
}

export function setSessionCookie(response: Response, token: string, secure: boolean): void {
  response.cookie(sessionCookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: sessionLifetimeMs
  });
}

export function clearSessionCookie(response: Response, secure: boolean): void {
  response.clearCookie(sessionCookieName, { httpOnly: true, sameSite: "lax", secure, path: "/" });
}

export function createUserSessionMiddleware(
  auth: UserAuthService,
  disabledOrOptions: boolean | { disabled?: boolean; resolveBypassUser?: () => AuthUser | null } = false
): RequestHandler {
  const options = typeof disabledOrOptions === "boolean"
    ? { disabled: disabledOrOptions }
    : disabledOrOptions;
  return (request, response, next) => {
    if (options.disabled) {
      const bypassUser = options.resolveBypassUser?.() ?? null;
      if (bypassUser) {
        request.authUser = bypassUser;
        request.authMethod = "session";
        return runWithRequestActor({ ...bypassUser, authentication: "session" }, next);
      }
      return runWithRequestActor(null, next);
    }
    const apiKey = auth.authenticateApiKey(request);
    if (auth.hasApiKeyCredential(request) && !apiKey) {
      logger.warn("auth.request.rejected", { reason: "invalid_api_key", method: request.method, path: sanitizeRequestPath(request.path) });
      response.status(401).json({ error: { code: "API_KEY_INVALID", message: "API Key 无效或已失效" } });
      return;
    }
    const session = apiKey ? null : auth.authenticate(request);
    if (apiKey) {
      request.authApiKey = apiKey;
      request.authUser = apiKey.user;
      request.authMethod = "api-key";
    } else if (session) {
      request.authSession = session;
      request.authUser = session.user;
      request.authMethod = "session";
    }
    const path = normalizeApiPath(request.path);
    const isPublic = path === "/api/health"
      || path === "/api/auth/session"
      || (path === "/api/auth/register" && request.method === "POST")
      || (path === "/api/auth/login" && request.method === "POST")
      || !path.startsWith("/api/");
    if (!session && !apiKey && !isPublic) {
      logger.warn("auth.request.rejected", { reason: "authentication_required", method: request.method, path: sanitizeRequestPath(request.path) });
      response.status(401).json({ error: { code: "AUTH_REQUIRED", message: "请先登录" } });
      return;
    }
    if (session && !["GET", "HEAD", "OPTIONS"].includes(request.method) && path !== "/api/auth/login" && path !== "/api/auth/register") {
      const csrf = request.get("x-csrf-token") ?? "";
      if (!safeEqual(csrf, session.csrfToken)) {
        logger.warn("auth.request.rejected", { reason: "invalid_csrf", method: request.method, path: sanitizeRequestPath(request.path), actorRef: accountReference(session.user.userId) });
        response.status(403).json({ error: { code: "CSRF_TOKEN_INVALID", message: "请求校验失败，请刷新页面后重试" } });
        return;
      }
    }
    const user = apiKey?.user ?? session?.user ?? null;
    return runWithRequestActor(user ? { ...user, authentication: apiKey ? "api-key" : "session" } : null, () => {
      if (user) logger.debug("auth.request.authenticated", { authMethod: apiKey ? "api-key" : "session" });
      next();
    });
  };
}

const cliApiRules: Array<{ methods: string[]; path: RegExp }> = [
  { methods: ["GET"], path: /^\/api\/cli\/session$/u },
  { methods: ["GET", "POST"], path: /^\/api\/works$/u },
  { methods: ["GET", "PATCH"], path: /^\/api\/works\/[^/]+$/u },
  { methods: ["GET"], path: /^\/api\/works\/[^/]+\/(?:outlines|outline-board|foreshadows|drafts|settings|characters|races|organizations|timeline-tracks|timeline|relationships|chapter-annotations|search|export|audit-logs)$/u },
  { methods: ["GET"], path: /^\/api\/works\/[^/]+\/writing-progress$/u },
  { methods: ["PUT"], path: /^\/api\/works\/[^/]+\/writing-goal$/u },
  { methods: ["POST"], path: /^\/api\/works\/[^/]+\/(?:volumes|chapters|foreshadows|drafts|settings|characters|races|organizations|timeline-tracks|timeline|relationships)$/u },
  { methods: ["POST"], path: /^\/api\/works\/[^/]+\/chapters\/batch$/u },
  { methods: ["GET", "PATCH"], path: /^\/api\/volumes\/[^/]+$/u },
  { methods: ["GET"], path: /^\/api\/volumes\/[^/]+\/export$/u },
  { methods: ["GET", "PATCH"], path: /^\/api\/chapters\/[^/]+$/u },
  { methods: ["GET"], path: /^\/api\/chapters\/[^/]+\/(?:versions|outline)$/u },
  { methods: ["GET", "POST"], path: /^\/api\/chapters\/[^/]+\/annotations$/u },
  { methods: ["PATCH", "DELETE"], path: /^\/api\/chapter-annotations\/[^/]+$/u },
  { methods: ["POST"], path: /^\/api\/chapters\/[^/]+\/(?:restore|move)$/u },
  { methods: ["PUT"], path: /^\/api\/chapters\/[^/]+\/outline$/u },
  { methods: ["GET", "PATCH"], path: /^\/api\/(?:drafts|settings|characters|races|organizations|timeline-tracks|timeline|relationships|foreshadows)\/[^/]+$/u },
  { methods: ["GET"], path: /^\/api\/characters\/[^/]+\/versions$/u },
  { methods: ["POST"], path: /^\/api\/characters\/[^/]+\/restore$/u },
  { methods: ["GET"], path: /^\/api\/entity-versions\/[^/]+\/[^/]+$/u },
  { methods: ["POST"], path: /^\/api\/entity-versions\/[^/]+\/[^/]+\/restore$/u }
];

export function createCliApiScopeMiddleware(disabled = false): RequestHandler {
  return (request, response, next) => {
    if (disabled || request.authMethod !== "api-key") return next();
    const path = normalizeApiPath(request.path);
    if (cliApiRules.some((rule) => rule.methods.includes(request.method) && rule.path.test(path))) return next();
    logger.warn("auth.request.rejected", { reason: "cli_scope_denied", method: request.method, path: sanitizeRequestPath(request.path) });
    response.status(403).json({ error: { code: "CLI_SCOPE_DENIED", message: "API Key 不能访问用户管理、系统管理或未开放给 CLI 的接口" } });
  };
}

const contentPermissionModules = workPermissionModules.filter((module) => !["comments", "todos", "drafts", "reviews", "ai-chat", "ai-analysis", "ai-settings"].includes(module));
const aiInteractionModules = ["ai-chat", "ai-analysis"] as const satisfies readonly WorkPermissionModule[];
const attachmentModules = ["prose", "drafts", "settings", "characters", "races", "organizations"] as const satisfies readonly WorkPermissionModule[];

export function exportReadPermissionModules(format: unknown): WorkPermissionModule[] {
  return format === "json" || format === undefined
    ? ["drafts", ...contentPermissionModules, "reviews"]
    : ["prose"];
}

function requestedAttachmentModule(request: Request): WorkPermissionModule {
  const module = String(request.query.module ?? "settings");
  return attachmentModules.includes(module as typeof attachmentModules[number])
    ? module as typeof attachmentModules[number]
    : "settings";
}

const analysisTaskDirectReadModules: Record<string, readonly WorkPermissionModule[]> = {
  structure: ["prose"],
  "chapter-analysis": ["prose"],
  "character-extraction": ["prose", "characters", "races", "organizations"],
  "character-summary": ["prose", "characters", "races", "organizations"],
  "character-identity-audit": [...contentPermissionModules, "reviews"],
  "timeline-analysis": ["prose", "timeline", "characters"],
  "worldview-analysis": ["prose", "settings"],
  "setting-extraction": ["prose", "settings"],
  "consistency-check": [...contentPermissionModules, "reviews"],
  "book-analysis": ["prose"],
  "report-update": ["prose"]
};

export function analysisTaskReadModules(taskType: unknown, scope: unknown): WorkPermissionModule[] {
  const scopeValue = scope && typeof scope === "object" && !Array.isArray(scope)
    ? scope as Record<string, unknown>
    : { type: "book" };
  const modules = new Set<WorkPermissionModule>(scopeValue.type === "none" ? [] : contentPermissionModules);
  for (const module of analysisTaskDirectReadModules[String(taskType)] ?? []) modules.add(module);
  if (taskType === "relationship-analysis") {
    for (const module of relationshipAnalysisReadModules(scopeValue)) modules.add(module);
  }
  return [...modules];
}

type WorkAuthorizationRequirements = {
  read?: WorkPermissionModule[];
  write?: WorkPermissionModule[];
  anyRead?: WorkPermissionModule[];
  anyWrite?: WorkPermissionModule[];
  ownerOnly?: boolean;
};

function requestBodyRecord(request: Request): Record<string, unknown> {
  return request.body && typeof request.body === "object" && !Array.isArray(request.body)
    ? request.body as Record<string, unknown>
    : {};
}

function hasBodyField(request: Request, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(requestBodyRecord(request), field);
}

function aiContextReadModules(request: Request): WorkPermissionModule[] {
  const scope = requestBodyRecord(request).scope;
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return [];
  const scopeValue = scope as Record<string, unknown>;
  if (scopeValue.type !== "none") return [...contentPermissionModules];
  const modules = new Set<WorkPermissionModule>();
  const hasReferences = (field: string): boolean => Array.isArray(scopeValue[field]) && scopeValue[field].length > 0;
  if (hasReferences("chapterIds") || scopeValue.includeBookSummary === true) modules.add("prose");
  if (hasReferences("characterIds") || hasReferences("mentionCharacterIds")) modules.add("characters");
  if (hasReferences("settingIds")) modules.add("settings");
  if (hasReferences("raceIds")) modules.add("races");
  if (hasReferences("organizationIds")) modules.add("organizations");
  return [...modules];
}

function globalReplaceWriteModules(request: Request): WorkPermissionModule[] {
  const scope = requestBodyRecord(request).scope;
  if (scope === "prose") return ["prose"];
  if (scope === "settings") return ["settings"];
  if (scope === "prose-and-settings") return ["prose", "settings"];
  return [];
}

function workModuleRequirements(request: Request, write: boolean, annotationAccess?: { kind: "note" | "todo"; createdByUserId: string | null }): WorkAuthorizationRequirements {
  const pathname = normalizeApiPath(request.path);
  const direct = (module: WorkPermissionModule, extraWrite: WorkPermissionModule[] = []): WorkAuthorizationRequirements => (
    write ? { write: [module, ...extraWrite] } : { read: [module] }
  );
  if (/^\/api\/works\/[^/]+$/u.test(pathname)) return write ? { ownerOnly: true } : {};
  if (/^\/api\/works\/[^/]+\/cover$/u.test(pathname)) return write ? { ownerOnly: true } : {};
  if (/^\/api\/works\/[^/]+\/members(?:\/[^/]+)?$/u.test(pathname)) return { ownerOnly: true };
  if (/^\/api\/works\/[^/]+\/presence$/u.test(pathname)) return {};
  if (/^\/api\/works\/[^/]+\/audit-logs$/u.test(pathname)) return { ownerOnly: true };
  if (/^\/api\/works\/[^/]+\/(?:writing-progress|writing-goal)$/u.test(pathname)) return direct("prose");
  if (/^\/api\/works\/[^/]+\/chapter-annotations$/u.test(pathname)) return { anyRead: ["comments", "todos"] };
  if (/^\/api\/works\/[^/]+\/(?:deleted-chapters|recycle-bin)$/u.test(pathname)) return { write: ["prose"] };
  if (/^\/api\/works\/[^/]+\/chapters\/[^/]+\/foreshadow-reminders(?:\/[^/]+\/resolve)?$/u.test(pathname)) {
    return write ? { read: ["prose"], write: ["outlines"] } : { read: ["prose", "outlines"] };
  }
  if (/^\/api\/works\/[^/]+\/attachments$/u.test(pathname)) {
    return write ? direct(requestedAttachmentModule(request)) : { anyRead: [...attachmentModules] };
  }
  if (/^\/api\/attachments\/[^/]+(?:\/content)?$/u.test(pathname)) {
    return write ? { anyWrite: [...attachmentModules] } : { anyRead: [...attachmentModules] };
  }
  if (/^\/api\/works\/[^/]+\/models$/u.test(pathname)) return { anyRead: [...aiInteractionModules] };
  if (!write && /^\/api\/works\/[^/]+\/task-defaults(?:\/|$)/u.test(pathname)) {
    return { anyRead: [...aiInteractionModules] };
  }
  if (/^\/api\/works\/[^/]+\/file-versions\/[^/]+\/restore$/u.test(pathname)) {
    return write ? { write: [...proseReplacementPermissionModules] } : { read: ["prose"] };
  }
  if (write && /^\/api\/works\/[^/]+\/replace$/u.test(pathname)) {
    return { anyWrite: globalReplaceWriteModules(request) };
  }
  if (/^\/api\/chapters\/[^/]+\/outline$/u.test(pathname)) return direct("outlines");
  if (/^\/api\/chapters\/[^/]+\/annotation-counts$/u.test(pathname)) return { anyRead: ["comments", "todos"] };
  if (/^\/api\/chapters\/[^/]+\/annotations$/u.test(pathname)) {
    return write ? direct(chapterAnnotationPermissionModule(requestBodyRecord(request).kind)) : { anyRead: ["comments", "todos"] };
  }
  if (/^\/api\/chapter-annotations\/[^/]+$/u.test(pathname)) {
    return write && annotationAccess?.kind === "todo" ? direct("todos") : write ? direct("prose") : { anyRead: ["comments", "todos"] };
  }
  if (/^\/api\/entity-versions\/[^/]+\/[^/]+(?:\/restore)?$/u.test(pathname)) {
    const entityType = pathname.split("/")[3] ?? "";
    const moduleByEntityType: Record<string, WorkPermissionModule> = {
      volume: "prose",
      draft: "drafts",
      setting: "settings",
      race: "races",
      organization: "organizations",
      "timeline-track": "timeline",
      "timeline-event": "timeline",
      relationship: "relationships",
      "chapter-outline": "outlines",
      foreshadow: "outlines"
    };
    const module = moduleByEntityType[entityType];
    if (entityType === "work") return { ownerOnly: true };
    if (!module) return { ownerOnly: true };
    if (write && (entityType === "race" || entityType === "organization")) return direct(module, ["characters"]);
    return direct(module);
  }
  if (/^\/api\/(?:works\/[^/]+\/characters|characters\/[^/]+)(?:\/|$)/u.test(pathname)) {
    const extraWrite: WorkPermissionModule[] = [];
    if (write) {
      const mergeOrRestore = /^\/api\/characters\/[^/]+\/(?:merge|restore)$/u.test(pathname);
      const deleting = request.method === "DELETE" && /^\/api\/characters\/[^/]+$/u.test(pathname);
      if (mergeOrRestore || deleting || hasBodyField(request, "raceId") || hasBodyField(request, "species")) extraWrite.push("races");
      if (mergeOrRestore || deleting || hasBodyField(request, "organizationIds")) extraWrite.push("organizations");
      if (mergeOrRestore || deleting) extraWrite.push("timeline", "relationships");
    }
    return direct("characters", extraWrite);
  }
  if (/^\/api\/(?:works\/[^/]+\/races|races\/[^/]+)(?:\/|$)/u.test(pathname)) {
    const body = requestBodyRecord(request);
    const memberIds = Array.isArray(body.memberIds) ? body.memberIds : [];
    const createsMembers = request.method === "POST" && /^\/api\/works\/[^/]+\/races$/u.test(pathname) && memberIds.length > 0;
    const updatesMembers = request.method === "PATCH" && (hasBodyField(request, "memberIds") || hasBodyField(request, "name"));
    const replacesMembers = request.method === "DELETE" || /^\/api\/races\/[^/]+\/merge$/u.test(pathname);
    return direct("races", write && (createsMembers || updatesMembers || replacesMembers) ? ["characters"] : []);
  }
  if (/^\/api\/(?:works\/[^/]+\/organizations|organizations\/[^/]+)(?:\/|$)/u.test(pathname)) {
    const body = requestBodyRecord(request);
    const memberIds = Array.isArray(body.memberIds) ? body.memberIds : [];
    const createsMembers = request.method === "POST" && /^\/api\/works\/[^/]+\/organizations$/u.test(pathname) && memberIds.length > 0;
    const updatesMembers = request.method === "PATCH" && hasBodyField(request, "memberIds");
    const replacesMembers = request.method === "DELETE" || /^\/api\/organizations\/[^/]+\/merge$/u.test(pathname);
    return direct("organizations", write && (createsMembers || updatesMembers || replacesMembers) ? ["characters"] : []);
  }
  const rules: Array<[RegExp, WorkPermissionModule]> = [
    [/^\/api\/works\/[^/]+\/(?:file-versions|import|volumes|chapters|deleted-chapters)(?:\/|$)/u, "prose"],
    [/^\/api\/(?:volumes|chapters)\/[^/]+(?:\/|$)/u, "prose"],
    [/^\/api\/works\/[^/]+\/drafts(?:\/|$)/u, "drafts"],
    [/^\/api\/drafts\/[^/]+(?:\/|$)/u, "drafts"],
    [/^\/api\/works\/[^/]+\/settings(?:\/|$)/u, "settings"],
    [/^\/api\/settings\/[^/]+(?:\/|$)/u, "settings"],
    [/^\/api\/character-sections\/[^/]+(?:\/|$)/u, "characters"],
    [/^\/api\/works\/[^/]+\/(?:timeline-tracks|timeline)(?:\/|$)/u, "timeline"],
    [/^\/api\/(?:timeline-tracks|timeline)\/[^/]+(?:\/|$)/u, "timeline"],
    [/^\/api\/works\/[^/]+\/relationships(?:\/|$)/u, "relationships"],
    [/^\/api\/relationships\/[^/]+(?:\/|$)/u, "relationships"],
    [/^\/api\/works\/[^/]+\/(?:outlines|outline-board|foreshadows)(?:\/|$)/u, "outlines"],
    [/^\/api\/(?:foreshadows|foreshadow-occurrences)\/[^/]+(?:\/|$)/u, "outlines"],
    [/^\/api\/works\/[^/]+\/ai-settings(?:\/|$)/u, "ai-settings"],
    [/^\/api\/works\/[^/]+\/task-defaults(?:\/|$)/u, "ai-settings"]
  ];
  for (const [pattern, module] of rules) if (pattern.test(pathname)) return direct(module);

  if (write && /^\/api\/reviews\/[^/]+\/character-resolution$/u.test(pathname)) {
    const merging = requestBodyRecord(request).action === "merge";
    return merging
      ? { write: ["reviews", "characters", "races", "organizations", "timeline", "relationships"] }
      : { write: ["reviews"] };
  }
  if (/^\/api\/(?:works\/[^/]+\/reviews|reviews\/[^/]+)(?:\/|$)/u.test(pathname)) {
    return direct("reviews");
  }
  if (write && /^\/api\/works\/[^/]+\/tasks(?:\/(?:relationship-source-preview|context-preview))?\/?$/u.test(pathname)) {
    const body = requestBodyRecord(request);
    const sourceModules = pathname.includes("/relationship-source-preview")
      ? relationshipAnalysisReadModules(body.scope)
      : analysisTaskReadModules(body.taskType, body.scope);
    if (sourceModules.length > 0) {
      return { read: sourceModules, write: ["ai-analysis"] };
    }
  }
  if (write && /^\/api\/suggestions\/[^/]+\/guard$/u.test(pathname)) {
    return { read: ["prose"], anyWrite: [...aiInteractionModules] };
  }
  if (write && /^\/api\/suggestions\/[^/]+\/accept$/u.test(pathname)) {
    return { write: ["prose"], anyWrite: [...aiInteractionModules] };
  }
  if (/^\/api\/tasks\/[^/]+\/trace(?:\/calls\/[^/]+)?$/u.test(pathname)) {
    return { read: ["ai-analysis", ...contentPermissionModules] };
  }
  if (/^\/api\/tasks\/[^/]+\/character-extraction\/preview$/u.test(pathname)) {
    return { read: ["ai-analysis", "prose", "characters", "races"] };
  }
  if (write && /^\/api\/tasks\/[^/]+\/character-extraction\/apply$/u.test(pathname)) {
    return { read: ["prose", "characters"], write: ["ai-analysis", "characters", "races"] };
  }
  if (write && /^\/api\/tasks\/[^/]+\/relationship-changes\/apply$/u.test(pathname)) {
    return { write: ["ai-analysis", "relationships"] };
  }
  if (/^\/api\/(?:works\/[^/]+\/(?:tasks|ai-calls)|tasks\/[^/]+)(?:\/|$)/u.test(pathname)) {
    return write ? { write: ["ai-analysis"] } : { read: ["ai-analysis"] };
  }
  const conversationRoleplayWrite = /^\/api\/ai-conversations\/[^/]+\/roleplay$/u.test(pathname);
  if (write && conversationRoleplayWrite) {
    return { read: ["characters"], write: ["ai-chat"] };
  }
  const conversationHistoryWrite = /^\/api\/ai-conversations\/[^/]+\/(?:fork|context\/prepare|compact)$/u.test(pathname)
    || (/^\/api\/works\/[^/]+\/chat\/stream$/u.test(pathname) && typeof requestBodyRecord(request).conversationId === "string");
  if (write && conversationHistoryWrite) {
    return { read: ["prose", ...aiContextReadModules(request)], write: ["ai-chat"] };
  }
  if (/^\/api\/(?:works\/[^/]+\/(?:ai-conversations|chat)|ai-conversations\/[^/]+)(?:\/|$)/u.test(pathname)) {
    const contextRead = aiContextReadModules(request);
    return write ? { read: contextRead, write: ["ai-chat"] } : { read: ["ai-chat"] };
  }
  if (/^\/api\/(?:works\/[^/]+\/suggestions|suggestions\/[^/]+)(?:\/|$)/u.test(pathname)) {
    const contextRead = aiContextReadModules(request);
    return write
      ? { read: contextRead, anyWrite: [...aiInteractionModules] }
      : { anyRead: [...aiInteractionModules] };
  }
  if (/^\/api\/works\/[^/]+\/search$/u.test(pathname)) {
    const permissionModule = hybridSearchPermissionModule(request.query.type);
    return permissionModule
      ? { read: [permissionModule] }
      : { anyRead: [...HYBRID_SEARCH_PERMISSION_MODULES] };
  }
  if (/^\/api\/works\/[^/]+\/export$/u.test(pathname)) {
    return { read: exportReadPermissionModules(request.query.format) };
  }
  return { ownerOnly: true };
}

export function createWorkAuthorizationMiddleware(auth: UserAuthService, disabled = false): RequestHandler {
  return (request, _response, next) => {
    const path = normalizeApiPath(request.path);
    if (!path.startsWith("/api/") || path.startsWith("/api/auth/") || path === "/api/health") return next();
    const workId = auth.resolveWorkId(request.path);
    if (workId) auth.assertActiveWork(workId);
    if (disabled) return next();
    const user = request.authUser;
    if (!user) throw new AppError(401, "AUTH_REQUIRED", "请先登录");
    if (path.startsWith("/api/platform/") || path.startsWith("/api/providers/") || path.startsWith("/api/models/")) {
      if (user.role !== "admin") throw new AppError(403, "ADMIN_REQUIRED", "该操作仅限系统管理员");
      return next();
    }
    if (/^\/api\/works\/[^/]+\/providers/u.test(path)) {
      if (user.role !== "admin") throw new AppError(403, "ADMIN_REQUIRED", "该操作仅限系统管理员");
      return next();
    }
    if (path.startsWith("/api/users") && !path.startsWith("/api/users/directory")) {
      if (user.role !== "admin") throw new AppError(403, "ADMIN_REQUIRED", "该操作仅限系统管理员");
      return next();
    }
    if (!workId) return next();
    const write = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    const annotationMatch = request.path.match(/^\/api\/chapter-annotations\/([^/]+)$/iu);
    const annotationId = annotationMatch?.[1];
    const annotationAccess = annotationId
      ? auth.chapterAnnotationAccess(decodeURIComponent(annotationId))
      : undefined;
    if (write && annotationAccess?.kind === "todo") {
      const role = auth.workRole(user, workId, request.authMethod !== "api-key");
      const canManageAllTodos = role === "admin" || role === "owner";
      if (!canManageAllTodos && annotationAccess.createdByUserId !== user.userId) {
        throw new AppError(403, "WORK_MODULE_WRITE_DENIED", "你只能修改或删除自己创建的正文待办");
      }
    }
    const requirements = workModuleRequirements(request, write, annotationAccess);
    auth.assertWorkAccess(user, workId, requirements, requirements.ownerOnly === true, request.authMethod !== "api-key");
    next();
  };
}
