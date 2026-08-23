import { createHash } from "node:crypto";
import { currentRequestContext } from "./request-context.js";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";
export type LogFields = Record<string, unknown>;

export type LogRecord = {
  ts: string;
  level: Exclude<LogLevel, "silent">;
  svc: string;
  event: string;
  requestId?: string;
  actorRef?: string;
  authentication?: "session" | "desktop-session" | "api-key";
  [key: string]: unknown;
};

export type Logger = {
  debug: (event: string, fields?: LogFields) => void;
  info: (event: string, fields?: LogFields) => void;
  warn: (event: string, fields?: LogFields) => void;
  error: (event: string, fields?: LogFields) => void;
};

type LoggerOptions = {
  level?: LogLevel;
  service?: string;
  write?: (level: Exclude<LogLevel, "silent">, record: LogRecord) => void;
  now?: () => Date;
};

const levelPriority: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100
};

const sensitiveField = /^(?:authorization|cookie|setcookie|password|passwordconfirmation|currentpassword|newpassword|secret|mastersecret|token|csrftoken|captchaanswer|apikey|accesskeyid|secretaccesskey|credential|session|sessionid|username|displayname|email|account|userid|encryptedkey|keyiv|keytag)$/iu;
const sensitiveFieldPart = /(?:password|passwd|secret|authorization|cookie|csrf|captchaanswer|apikey|accesskey|accesstoken|refreshtoken|sessiontoken|encryptedkey)/iu;

function scrubString(value: string): string {
  return value
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_\-.]+/giu, (match) => `${match.split(/\s/u)[0]} [REDACTED]`)
    .replace(/\bscrv_[A-Za-z0-9_-]+\b/gu, "scrv_[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "sk-[REDACTED]")
    .replace(/([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)=)[^&\s]+/giu, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1[REDACTED]@")
    .replace(/("(?:password|secret|token|api[_-]?key|authorization)"\s*:\s*")[^"]*(")/giu, "$1[REDACTED]$2");
}

function sanitizeValue(value: unknown, key = "", depth = 0, seen = new WeakSet<object>()): unknown {
  const normalizedKey = key.replace(/[^a-z0-9]/giu, "");
  if (sensitiveField.test(normalizedKey) || sensitiveFieldPart.test(normalizedKey)) return "[REDACTED]";
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return scrubString(value).slice(0, 4_000);
  if (value instanceof Error) return sanitizeError(value);
  if (Buffer.isBuffer(value)) return { type: "Buffer", byteLength: value.byteLength };
  if (depth >= 6) return "[TRUNCATED]";
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeValue(item, "", depth + 1, seen));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 100).map(
    ([entryKey, entryValue]) => [entryKey, sanitizeValue(entryValue, entryKey, depth + 1, seen)]
  ));
}

export function sanitizeLogFields(fields: LogFields): LogFields {
  return sanitizeValue(fields) as LogFields;
}

export function sanitizeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { message: scrubString(String(error)).slice(0, 4_000) };
  const candidate = error as Error & { code?: unknown; status?: unknown };
  return {
    name: error.name,
    message: scrubString(error.message).slice(0, 4_000),
    ...(candidate.code === undefined ? {} : { code: sanitizeValue(candidate.code, "code") }),
    ...(candidate.status === undefined ? {} : { status: sanitizeValue(candidate.status, "status") }),
    ...(error.stack ? { stack: scrubString(error.stack).slice(0, 12_000) } : {})
  };
}

export function accountReference(userId: string): string {
  return `account:${createHash("sha256").update(userId).digest("hex").slice(0, 12)}`;
}

export function resolveLogLevel(environment: NodeJS.ProcessEnv = process.env): LogLevel {
  const configured = environment.LOG_LEVEL?.trim().toLocaleLowerCase();
  if (configured === "debug" || configured === "info" || configured === "warn" || configured === "error" || configured === "silent") return configured;
  return environment.NODE_ENV === "test" ? "silent" : "info";
}

function defaultWrite(_level: Exclude<LogLevel, "silent">, record: LogRecord): void {
  // 服务和 CLI 共用日志器，统一写入 stderr，避免污染 CLI 的机器可读 stdout。
  console.error(JSON.stringify(record));
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const configuredLevel = options.level ?? resolveLogLevel();
  const service = options.service ?? "scriverse";
  const write = options.write ?? defaultWrite;
  const now = options.now ?? (() => new Date());
  const emit = (level: Exclude<LogLevel, "silent">, event: string, fields: LogFields = {}): void => {
    if (levelPriority[level] < levelPriority[configuredLevel]) return;
    const context = currentRequestContext();
    const record: LogRecord = {
      ts: now().toISOString(),
      level,
      svc: service,
      ...sanitizeLogFields(fields),
      event,
      ...(context?.requestId ? { requestId: context.requestId } : {}),
      ...(context?.actor ? {
        actorRef: accountReference(context.actor.userId),
        ...(context.actor.authentication ? { authentication: context.actor.authentication } : {})
      } : {})
    };
    try {
      write(level, record);
    } catch {
      // 日志输出失败不能中断业务请求。
    }
  };
  return {
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields)
  };
}

export const logger = createLogger();
