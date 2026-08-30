import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { Agent } from "undici";
import { AppError } from "./errors.js";
import { logger } from "./logger.js";
import { parseBooleanEnvironmentValue } from "./utils.js";

export type BasicAuthOptions = {
  username: string;
  password: string;
  realm?: string;
  failureLimit?: number;
  failureWindowMs?: number;
};

export type RuntimeSecurityOptions = {
  auth?: BasicAuthOptions;
  trustProxy?: boolean | number;
  apiRateLimit?: number;
  apiRateWindowMs?: number;
  enforceSameOrigin?: boolean;
  allowPrivateAiEndpoints?: boolean;
  allowRegistration?: boolean;
  setupToken?: string;
};

export const PRIVATE_AI_ENDPOINTS_ENV = "APP_ALLOW_PRIVATE_AI_ENDPOINTS";

type RateEntry = { count: number; resetAt: number };
const maximumRateEntries = 10_000;

/**
 * Express 默认路由大小写不敏感，但 request.path 保留原始大小写。
 * 安全中间件统一用小写路径做匹配，避免 /API/... 一类变体绕过鉴权与限速。
 */
export function normalizeApiPath(pathname: string): string {
  return pathname.toLocaleLowerCase("en-US");
}

/** 强制保持大小写不敏感路由，并拒绝后续改成大小写敏感。 */
export function enforceCaseInsensitiveRouting(app: { set: (setting: string, value?: unknown) => unknown }): void {
  app.set("case sensitive routing", false);
  const originalSet = app.set.bind(app) as {
    (setting: string): unknown;
    (setting: string, value: unknown): unknown;
  };
  app.set = function lockedCaseInsensitiveRouting(setting: string, value?: unknown) {
    // Express 用单参数 app.set(name) 读取配置；不能把它改写成写入。
    if (arguments.length < 2) return originalSet(setting);
    if (String(setting).toLocaleLowerCase("en-US") === "case sensitive routing") {
      if (value) {
        throw new Error("Case-sensitive routing is disabled; API security matches paths case-insensitively");
      }
      return originalSet(setting, false);
    }
    return originalSet(setting, value);
  } as typeof app.set;
}

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();
const constantTimeEqual = (left: string, right: string): boolean => timingSafeEqual(digest(left), digest(right));

export function verifySetupToken(expected: string | undefined, provided: string | undefined): boolean {
  return Boolean(expected && provided) && constantTimeEqual(expected ?? "", provided ?? "");
}

function requestKey(request: Request): string {
  const peer = request.socket.remoteAddress || "unknown";
  const trustProxy = request.app?.get?.("trust proxy");
  const trustsForwarded = trustProxy === true
    || (typeof trustProxy === "number" && trustProxy > 0)
    || (Array.isArray(trustProxy) && trustProxy.length > 0)
    || (typeof trustProxy === "string" && trustProxy !== "false" && trustProxy.length > 0);
  // 未启用 trust proxy 时忽略 X-Forwarded-For，始终按直连对端计限速。
  if (!trustsForwarded) return peer;
  return request.ip || peer;
}

/** 禁止 trust proxy=true（信任整条转发链）；至少收敛为单跳。 */
export function resolveTrustProxySetting(trustProxy: boolean | number | undefined): boolean | number | undefined {
  if (trustProxy === undefined) return undefined;
  if (trustProxy === true) return 1;
  return trustProxy;
}

function consumeRate(entries: Map<string, RateEntry>, key: string, limit: number, windowMs: number, entryLimit = maximumRateEntries): { allowed: boolean; retryAfter: number } {
  const currentTime = Date.now();
  const existing = entries.get(key);
  const entry = !existing || existing.resetAt <= currentTime ? { count: 0, resetAt: currentTime + windowMs } : existing;
  entry.count += 1;
  if (!existing && entries.size >= entryLimit) {
    for (const [candidate, value] of entries) if (value.resetAt <= currentTime) entries.delete(candidate);
    while (entries.size >= entryLimit) {
      const oldest = entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }
  entries.set(key, entry);
  return { allowed: entry.count <= limit, retryAfter: Math.max(1, Math.ceil((entry.resetAt - currentTime) / 1000)) };
}

function unauthorized(response: Response, realm: string): void {
  response.setHeader("WWW-Authenticate", `Basic realm="${realm.replace(/["\\]/gu, "")}", charset="UTF-8"`);
  response.setHeader("Cache-Control", "no-store");
  response.status(401).json({ error: { code: "AUTH_REQUIRED", message: "需要管理员身份验证" } });
}

function parseBasicCredentials(header: string | undefined): { username: string; password: string } | null {
  if (!header?.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return null;
    return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
  } catch {
    return null;
  }
}

export function createBasicAuthMiddleware(options: BasicAuthOptions): RequestHandler {
  const realm = options.realm ?? "Scriverse";
  const failureLimit = options.failureLimit ?? 10;
  const failureWindowMs = options.failureWindowMs ?? 15 * 60_000;
  const failures = new Map<string, RateEntry>();
  return (request, response, next) => {
    if (normalizeApiPath(request.path) === "/api/health") return next();
    const key = requestKey(request);
    const credentials = parseBasicCredentials(request.get("authorization"));
    const valid = credentials
      && constantTimeEqual(credentials.username, options.username)
      && constantTimeEqual(credentials.password, options.password);
    if (valid) {
      failures.delete(key);
      logger.debug("security.deployment_auth.succeeded");
      return next();
    }
    const rate = consumeRate(failures, key, failureLimit, failureWindowMs);
    if (!rate.allowed) {
      logger.warn("security.request.blocked", { control: "deployment_auth_rate_limit", retryAfterSeconds: rate.retryAfter });
      response.setHeader("Retry-After", String(rate.retryAfter));
      response.status(429).json({ error: { code: "AUTH_RATE_LIMITED", message: "身份验证失败次数过多，请稍后重试" } });
      return;
    }
    logger.warn("security.request.blocked", { control: "deployment_auth", reason: credentials ? "invalid_credentials" : "missing_credentials" });
    unauthorized(response, realm);
  };
}

export function createSecurityHeadersMiddleware(): RequestHandler {
  return (request, response, next) => {
    response.setHeader("Content-Security-Policy", "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data: blob:; manifest-src 'self'; media-src 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self'");
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    response.setHeader("Referrer-Policy", "same-origin");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("X-Permitted-Cross-Domain-Policies", "none");
    response.setHeader("Cache-Control", normalizeApiPath(request.path).startsWith("/api/") ? "no-store" : "private, no-cache");
    response.vary("Authorization");
    if (request.secure) response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    next();
  };
}

export function createSameOriginMiddleware(): RequestHandler {
  return (request, response, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return next();
    if (request.get("sec-fetch-site") === "cross-site") {
      logger.warn("security.request.blocked", { control: "same_origin", reason: "cross_site_fetch" });
      response.status(403).json({ error: { code: "CROSS_ORIGIN_WRITE_BLOCKED", message: "已拒绝跨站写请求" } });
      return;
    }
    const origin = request.get("origin");
    if (!origin) return next();
    const host = request.get("host");
    let expectedOrigin = "";
    try {
      expectedOrigin = new URL(`${request.protocol}://${host}`).origin;
    } catch {
      logger.warn("security.request.blocked", { control: "same_origin", reason: "invalid_host" });
      response.status(400).json({ error: { code: "INVALID_HOST", message: "请求主机信息无效" } });
      return;
    }
    if (origin !== expectedOrigin) {
      logger.warn("security.request.blocked", { control: "same_origin", reason: "origin_mismatch" });
      response.status(403).json({ error: { code: "CROSS_ORIGIN_WRITE_BLOCKED", message: "已拒绝跨站写请求" } });
      return;
    }
    next();
  };
}

export function createApiRateLimitMiddleware(limit = 600, windowMs = 60_000, entryLimit = maximumRateEntries): RequestHandler {
  const entries = new Map<string, RateEntry>();
  return (request, response, next) => {
    const path = normalizeApiPath(request.path);
    if (!path.startsWith("/api/") || path === "/api/health") return next();
    const rate = consumeRate(entries, requestKey(request), limit, windowMs, entryLimit);
    if (rate.allowed) return next();
    logger.warn("security.request.blocked", { control: "api_rate_limit", retryAfterSeconds: rate.retryAfter });
    response.setHeader("Retry-After", String(rate.retryAfter));
    response.status(429).json({ error: { code: "API_RATE_LIMITED", message: "请求过于频繁，请稍后重试" } });
  };
}

export function createAuthenticationRateLimitMiddleware(limit = 10, windowMs = 15 * 60_000): RequestHandler {
  const entries = new Map<string, RateEntry>();
  return (request, response, next) => {
    const path = normalizeApiPath(request.path);
    const authenticationWrite = request.method === "POST"
      && ["/api/auth/login", "/api/auth/register", "/api/desktop/auth/login"].includes(path);
    if (!authenticationWrite) return next();
    const rate = consumeRate(entries, `${requestKey(request)}:${path}`, limit, windowMs);
    if (rate.allowed) return next();
    logger.warn("security.request.blocked", { control: "authentication_rate_limit", retryAfterSeconds: rate.retryAfter });
    response.setHeader("Retry-After", String(rate.retryAfter));
    response.status(429).json({ error: { code: "AUTH_RATE_LIMITED", message: "登录或注册尝试过于频繁，请稍后重试" } });
  };
}

export function createUploadRateLimitMiddleware(limit = 30, windowMs = 10 * 60_000, entryLimit = maximumRateEntries): RequestHandler {
  const entries = new Map<string, RateEntry>();
  return (request, response, next) => {
    const path = normalizeApiPath(request.path);
    const uploadWrite = (request.method === "POST" || request.method === "PUT") && (
      path === "/api/auth/avatar"
      || path === "/api/works/import"
      || /^\/api\/works\/[^/]+\/(?:import|cover|attachments)$/u.test(path)
    );
    if (!uploadWrite) return next();
    const actorKey = request.authUser?.userId ?? requestKey(request);
    const rate = consumeRate(entries, actorKey, limit, windowMs, entryLimit);
    if (rate.allowed) return next();
    logger.warn("security.request.blocked", { control: "upload_rate_limit", retryAfterSeconds: rate.retryAfter });
    response.setHeader("Retry-After", String(rate.retryAfter));
    response.status(429).json({ error: { code: "UPLOAD_RATE_LIMITED", message: "文件上传过于频繁，请稍后重试" } });
  };
}

export function createCaptchaRateLimitMiddleware(limit = 20, windowMs = 60_000, entryLimit = maximumRateEntries): RequestHandler {
  const entries = new Map<string, RateEntry>();
  return (request, response, next) => {
    if (request.method !== "GET" || normalizeApiPath(request.path) !== "/api/auth/captcha") return next();
    const rate = consumeRate(entries, requestKey(request), limit, windowMs, entryLimit);
    if (rate.allowed) return next();
    logger.warn("security.request.blocked", { control: "captcha_rate_limit", retryAfterSeconds: rate.retryAfter });
    response.setHeader("Retry-After", String(rate.retryAfter));
    response.status(429).json({ error: { code: "CAPTCHA_RATE_LIMITED", message: "验证码请求过于频繁，请稍后重试" } });
  };
}

type ExpensiveApiKind = "ai" | "export" | "search";

function expensiveApiKind(method: string, path: string): ExpensiveApiKind | null {
  if (method === "GET" && (
    /^\/api\/works\/[^/]+\/export$/u.test(path)
    || /^\/api\/volumes\/[^/]+\/export$/u.test(path)
    || /^\/api\/ai-conversations\/[^/]+\/export$/u.test(path)
  )) return "export";
  if (method === "GET" && /^\/api\/works\/[^/]+\/search$/u.test(path)) return "search";
  if (method === "PUT" && /^\/api\/works\/[^/]+\/ai-settings\/mcp-servers$/u.test(path)) return "ai";
  if (method !== "POST") return null;
  if (
    /^\/api\/works\/[^/]+\/(?:suggestions|chat\/stream|tasks)(?:\/|$)/u.test(path)
    || /^\/api\/works\/[^/]+\/semantic-search$/u.test(path)
    || /^\/api\/works\/[^/]+\/ai-settings\/semantic-search-index\/(?:sync|rebuild)$/u.test(path)
    || /^\/api\/suggestions\/[^/]+\/guard$/u.test(path)
    || /^\/api\/ai-conversations\/[^/]+\/(?:compact|context\/prepare)$/u.test(path)
    || /^\/api\/tasks\/[^/]+\/(?:run|rerun|cancel|relationship-changes\/apply|character-extraction\/apply)$/u.test(path)
    || /^\/api\/(?:providers|models)\/[^/]+\/test$/u.test(path)
    || /^\/api\/providers\/[^/]+\/models\/import$/u.test(path)
  ) {
    return "ai";
  }
  return null;
}

const expensiveApiLimits: Record<ExpensiveApiKind, number> = {
  ai: 30,
  export: 10,
  search: 60
};

export function createExpensiveApiRateLimitMiddleware(windowMs = 60_000, entryLimit = maximumRateEntries): RequestHandler {
  const entries = new Map<string, RateEntry>();
  return (request, response, next) => {
    const kind = expensiveApiKind(request.method, normalizeApiPath(request.path));
    if (!kind) return next();
    const actorKey = request.authUser?.userId ?? requestKey(request);
    const rate = consumeRate(entries, `${kind}:${actorKey}`, expensiveApiLimits[kind], windowMs, entryLimit);
    if (rate.allowed) return next();
    logger.warn("security.request.blocked", { control: "expensive_api_rate_limit", kind, retryAfterSeconds: rate.retryAfter });
    response.setHeader("Retry-After", String(rate.retryAfter));
    response.status(429).json({ error: { code: "EXPENSIVE_API_RATE_LIMITED", message: "该操作请求过于频繁，请稍后重试" } });
  };
}

function parseIpv4(address: string): number[] | null {
  if (isIP(address) !== 4) return null;
  return address.split(".").map(Number);
}

function parseIpv6(address: string): number[] | null {
  const normalized = address.replace(/^\[|\]$/gu, "").toLocaleLowerCase("en-US");
  if (isIP(normalized) !== 6) return null;
  const ipv4Tail = normalized.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
  const source = ipv4Tail
    ? normalized.slice(0, -ipv4Tail.length) + (() => {
        const octets = parseIpv4(ipv4Tail);
        if (!octets) return "";
        return `${((octets[0] ?? 0) << 8 | (octets[1] ?? 0)).toString(16)}:${((octets[2] ?? 0) << 8 | (octets[3] ?? 0)).toString(16)}`;
      })()
    : normalized;
  const halves = source.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  const groups = halves.length === 2 ? [...left, ...Array.from({ length: missing }, () => "0"), ...right] : left;
  if ((halves.length === 2 && missing < 1) || groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/u.test(group))) return null;
  return groups.map((group) => Number.parseInt(group, 16));
}

function embeddedIpv4(address: number[]): string {
  const high = address[6] ?? 0;
  const low = address[7] ?? 0;
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

function unsafeIpKind(address: string): "private" | "blocked" | null {
  const ipv4 = parseIpv4(address);
  if (ipv4) {
    const a = ipv4[0] ?? -1;
    const b = ipv4[1] ?? -1;
    const c = ipv4[2] ?? -1;
    if (a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private";
    if (
      a === 0
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 192 && b === 0 && (c === 0 || c === 2))
      || (a === 192 && b === 88 && c === 99)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113)
      || a >= 224
    ) return "blocked";
    return null;
  }
  const ipv6 = parseIpv6(address);
  if (!ipv6) return "blocked";
  const firstFiveZero = ipv6.slice(0, 5).every((value) => value === 0);
  if (firstFiveZero && ipv6[5] === 0xffff) return unsafeIpKind(embeddedIpv4(ipv6));
  const firstSixZero = ipv6.slice(0, 6).every((value) => value === 0);
  if (firstSixZero) {
    if (ipv6[6] === 0 && ipv6[7] === 1) return "private";
    return "blocked";
  }
  const nat64WellKnown = ipv6[0] === 0x0064
    && ipv6[1] === 0xff9b
    && ipv6.slice(2, 6).every((value) => value === 0);
  if (nat64WellKnown) return unsafeIpKind(embeddedIpv4(ipv6));
  const first = ipv6[0] ?? 0;
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfec0) return "private";
  const globallyRoutable = (first & 0xe000) === 0x2000;
  const ietfSpecial = first === 0x2001 && ((ipv6[1] ?? 0) & 0xfe00) === 0;
  const sixToFour = first === 0x2002;
  const documentation = first === 0x3fff && ((ipv6[1] ?? 0) & 0xf000) === 0;
  return globallyRoutable && !ietfSpecial && !sixToFour && !documentation ? null : "blocked";
}

type SafeAiEndpointAddress = { address: string; family: 4 | 6 };
type SafeAiEndpointValidator = (url: string) => Promise<readonly SafeAiEndpointAddress[] | void>;

const pinnedAiAddresses = new Map<string, SafeAiEndpointAddress[]>();
const maximumPinnedAiHosts = 1_000;
const pinnedAiAgent = new Agent({
  connect: {
    lookup: (hostname, _options, callback) => {
      const addresses = pinnedAiAddresses.get(hostname.toLocaleLowerCase());
      if (!addresses?.length) {
        callback(new Error("AI endpoint was not resolved by the SSRF validator"), []);
        return;
      }
      callback(null, addresses);
    }
  }
});

function normalizedUrlHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/gu, "").toLocaleLowerCase("en-US");
}

function rememberPinnedAiAddresses(hostname: string, addresses: SafeAiEndpointAddress[]): void {
  const key = hostname.toLocaleLowerCase();
  if (!pinnedAiAddresses.has(key) && pinnedAiAddresses.size >= maximumPinnedAiHosts) {
    const oldest = pinnedAiAddresses.keys().next().value;
    if (oldest) pinnedAiAddresses.delete(oldest);
  }
  pinnedAiAddresses.delete(key);
  pinnedAiAddresses.set(key, addresses);
}

async function lookupEndpointAddresses(hostname: string): Promise<SafeAiEndpointAddress[]> {
  if (isIP(hostname)) return [{ address: hostname, family: isIP(hostname) as 4 | 6 }];
  return (await lookup(hostname, { all: true, verbatim: true }).catch(() => [])).map(({ address, family }) => ({
    address,
    family: family as 4 | 6
  }));
}

export async function aiEndpointUsesPrivateNetwork(value: string): Promise<boolean> {
  try {
    const hostname = normalizedUrlHostname(new URL(value));
    const addresses = await lookupEndpointAddresses(hostname);
    return addresses.some(({ address }) => unsafeIpKind(address) === "private");
  } catch {
    return false;
  }
}

export async function assertSafeAiEndpoint(value: string, allowPrivateNetwork = false): Promise<SafeAiEndpointAddress[]> {
  const endpoint = new URL(value);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new AppError(400, "UNSAFE_PROVIDER_ENDPOINT", "AI 供应商地址必须是无内嵌凭据的 HTTP 或 HTTPS 地址");
  }
  const hostname = normalizedUrlHostname(endpoint);
  const addresses = await lookupEndpointAddresses(hostname);
  if (!addresses.length) throw new AppError(400, "UNSAFE_PROVIDER_ENDPOINT", "AI 供应商域名无法解析");
  for (const { address } of addresses) {
    const kind = unsafeIpKind(address);
    if (kind === "blocked" || (kind === "private" && !allowPrivateNetwork)) {
      logger.warn("security.ai_endpoint.blocked", { hostname, addressKind: kind });
      throw new AppError(400, "UNSAFE_PROVIDER_ENDPOINT", "AI 供应商地址指向受保护的本机、内网或链路本地网络");
    }
  }
  if (endpoint.protocol === "http:" && addresses.some(({ address }) => unsafeIpKind(address) !== "private")) {
    throw new AppError(400, "INSECURE_PROVIDER_ENDPOINT", "公网 AI 供应商地址必须使用 HTTPS");
  }
  return addresses;
}

export async function assertSafeS3Endpoint(value: string, allowPrivateNetwork = false): Promise<SafeAiEndpointAddress[]> {
  const endpoint = new URL(value);
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new AppError(400, "UNSAFE_S3_ENDPOINT", "S3 服务地址必须是无内嵌凭据的 HTTP 或 HTTPS 地址");
  }
  const hostname = normalizedUrlHostname(endpoint);
  const addresses: SafeAiEndpointAddress[] = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) as 4 | 6 }]
    : (await lookup(hostname, { all: true, verbatim: true }).catch(() => [])).map(({ address, family }) => ({
      address,
      family: family as 4 | 6
    }));
  if (!addresses.length) throw new AppError(400, "UNSAFE_S3_ENDPOINT", "S3 服务域名无法解析");
  for (const { address } of addresses) {
    const kind = unsafeIpKind(address);
    if (kind === "blocked" || (kind === "private" && !allowPrivateNetwork)) {
      logger.warn("security.s3_endpoint.blocked", { hostname, addressKind: kind });
      throw new AppError(400, "UNSAFE_S3_ENDPOINT", "S3 服务地址指向受保护的本机、内网或链路本地网络");
    }
  }
  if (endpoint.protocol === "http:" && addresses.some(({ address }) => unsafeIpKind(address) !== "private")) {
    throw new AppError(400, "INSECURE_S3_ENDPOINT", "公网 S3 服务地址必须使用 HTTPS");
  }
  return addresses;
}

const redirectStatuses = new Set([301, 302, 303, 307, 308]);

/**
 * 出站 AI 请求：禁止浏览器式自动跟随重定向。
 * 每一跳都重新做 SSRF 校验；只允许同源跳转，避免密钥或请求正文泄露到其他目标。
 */
export async function fetchSafeAiEndpoint(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  validateOutboundUrl?: SafeAiEndpointValidator,
  maxRedirects = 5
): Promise<Awaited<ReturnType<typeof fetch>>> {
  let currentUrl = url;
  const baseHeaders = new Headers(init.headers);
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const currentEndpoint = new URL(currentUrl);
    const currentHostname = normalizedUrlHostname(currentEndpoint);
    logger.debug("ai.outbound_request.validating", { hostname: currentHostname, hop });
    const validatedAddresses = await validateOutboundUrl?.(currentUrl);
    const requestInit: RequestInit & { dispatcher?: Agent } = {
      ...init,
      headers: baseHeaders,
      redirect: "manual" as const,
      ...(Array.isArray(validatedAddresses) && validatedAddresses.length
        ? (rememberPinnedAiAddresses(currentHostname, validatedAddresses), { dispatcher: pinnedAiAgent })
        : {})
    };
    const response = await fetchImpl(currentUrl, requestInit);
    logger.debug("ai.outbound_request.response", { hostname: currentHostname, hop, status: response.status });
    if (!redirectStatuses.has(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) {
      throw new AppError(502, "PROVIDER_REDIRECT_INVALID", "AI 供应商返回了无效的重定向响应");
    }
    let nextUrl: URL;
    try {
      nextUrl = new URL(location, currentUrl);
    } catch {
      throw new AppError(502, "PROVIDER_REDIRECT_INVALID", "AI 供应商返回了无效的重定向地址");
    }
    if (nextUrl.origin !== new URL(currentUrl).origin) {
      throw new AppError(502, "PROVIDER_REDIRECT_CROSS_ORIGIN", "AI 供应商返回了不安全的跨域重定向");
    }
    if (response.status === 303) {
      init = { ...init, method: "GET", body: undefined };
    }
    currentUrl = nextUrl.toString();
  }
  throw new AppError(502, "PROVIDER_REDIRECT_LIMIT", "AI 供应商重定向次数过多");
}

export function isPrivateAiEndpointsExplicitlyEnabled(environment: NodeJS.ProcessEnv): boolean {
  return parseBooleanEnvironmentValue(environment[PRIVATE_AI_ENDPOINTS_ENV]) === true;
}

/** 仅在环境变量被显式开启时写入启动警告；开发环境默认放行不会触发。 */
export function warnIfPrivateAiEndpointsEnabled(environment: NodeJS.ProcessEnv): void {
  if (!isPrivateAiEndpointsExplicitlyEnabled(environment)) return;
  logger.warn("security.private_ai_endpoints.enabled", {
    env: PRIVATE_AI_ENDPOINTS_ENV,
    message: "Private and loopback AI provider endpoints are allowed. This weakens SSRF protection and can expose credentials to local or internal services. Enable it only when you must reach a trusted local model."
  });
}

export function resolveRuntimeSecurity(environment: NodeJS.ProcessEnv, requireAuthentication = false): RuntimeSecurityOptions {
  const production = environment.NODE_ENV === "production";
  const username = environment.APP_AUTH_USERNAME?.trim() ?? "";
  const password = environment.APP_AUTH_PASSWORD ?? "";
  if (Boolean(username) !== Boolean(password)) throw new Error("APP_AUTH_USERNAME 与 APP_AUTH_PASSWORD 必须同时配置");
  if (requireAuthentication && (!username || !password)) throw new Error("当前部署策略要求配置 APP_AUTH_USERNAME 与 APP_AUTH_PASSWORD");
  if (password && password.length < 12) throw new Error("APP_AUTH_PASSWORD 至少需要 12 个字符");
  const trustProxyValue = environment.APP_TRUST_PROXY?.trim() ?? "";
  const trustProxy = trustProxyValue === "true" ? true : /^\d+$/u.test(trustProxyValue) ? Number(trustProxyValue) : false;
  if (typeof trustProxy === "number" && (trustProxy < 0 || trustProxy > 10)) throw new Error("APP_TRUST_PROXY 只能是 true 或 0-10 的整数");
  const allowRegistration = parseBooleanEnvironmentValue(environment.APP_ALLOW_REGISTRATION) ?? false;
  const setupToken = environment.APP_SETUP_TOKEN ?? "";
  if (allowRegistration && setupToken.length < 32) throw new Error("开放注册时 APP_SETUP_TOKEN 至少需要 32 个字符");
  return {
    ...(username ? { auth: { username, password } } : {}),
    trustProxy,
    enforceSameOrigin: true,
    allowPrivateAiEndpoints: parseBooleanEnvironmentValue(environment[PRIVATE_AI_ENDPOINTS_ENV]) ?? !production,
    allowRegistration,
    ...(setupToken ? { setupToken } : {})
  };
}

export function isDevelopmentAuthBypassEnabled(environment: NodeJS.ProcessEnv, containerRuntime = detectContainerRuntime(environment)): boolean {
  return environment.NODE_ENV === "development"
    && (parseBooleanEnvironmentValue(environment.APP_DEV_SKIP_AUTH) ?? false)
    && !containerRuntime;
}

function detectContainerRuntime(environment: NodeJS.ProcessEnv): boolean {
  return environment.SCRIVERSE_RUNTIME === "container"
    || existsSync("/.dockerenv")
    || existsSync("/run/.containerenv");
}
