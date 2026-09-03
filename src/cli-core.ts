import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { cliResourceDefinitions, cliResourceTypes, cliWorkDefinition, type CliResourceType } from "./cli-contract.js";
import { HYBRID_SEARCH_TYPES } from "./hybrid-search.js";
import { AI_USER_QUESTION_STATUSES } from "./ai-write-plans.js";
import type { LocalServerOptions } from "./server-runtime.js";

type OutputStream = { write(chunk: string): unknown };
type InputStream = NodeJS.ReadableStream & AsyncIterable<Buffer | string>;

type CliDependencies = {
  fetchImpl?: typeof fetch;
  serveImpl?: (options: LocalServerOptions) => Promise<{ url: string; port: number; dataDirectory: string; databasePath: string }>;
  stdin?: InputStream;
  stdout?: OutputStream;
  stderr?: OutputStream;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  homeDirectory?: string;
};

type ParsedArguments = {
  positionals: string[];
  options: Map<string, string[]>;
};

type CliUser = {
  userId: string;
  username: string;
  displayName: string;
  role: "admin" | "user";
};

type CliServerCredentials = {
  apiKey: string;
  apiKeyPrefix: string | null;
  user: CliUser;
};

type CliConfig = {
  version: 2;
  defaultServer: string | null;
  servers: Record<string, CliServerCredentials>;
};

type CliRequestConfig = CliServerCredentials & {
  server: string;
};

type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: Record<string, unknown>;
  text?: boolean;
};

const booleanOptions = new Set(["compact", "help"]);
const maximumInputBytes = 2_500_000;

export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}

export function parseCliArguments(args: string[]): ParsedArguments {
  const positionals: string[] = [];
  const options = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const equalsIndex = argument.indexOf("=");
    const name = argument.slice(2, equalsIndex >= 0 ? equalsIndex : undefined);
    if (!name) throw new CliError("CLI_ARGUMENT_INVALID", "选项名称不能为空");
    let value = "true";
    if (equalsIndex >= 0) {
      value = argument.slice(equalsIndex + 1);
    } else if (!booleanOptions.has(name)) {
      const candidate = args[index + 1];
      if (candidate === undefined || candidate.startsWith("--")) {
        throw new CliError("CLI_OPTION_VALUE_REQUIRED", `选项 --${name} 缺少值`);
      }
      value = candidate;
      index += 1;
    }
    const values = options.get(name) ?? [];
    values.push(value);
    options.set(name, values);
  }
  return { positionals, options };
}

function option(parsed: ParsedArguments, name: string): string | undefined {
  return parsed.options.get(name)?.at(-1);
}

function optionValues(parsed: ParsedArguments, name: string): string[] {
  return parsed.options.get(name) ?? [];
}

function assertAllowedOptions(parsed: ParsedArguments, allowed: string[]): void {
  const allowedSet = new Set(["config", "compact", "help", "server", ...allowed]);
  for (const name of parsed.options.keys()) {
    if (!allowedSet.has(name)) throw new CliError("CLI_OPTION_UNKNOWN", `当前命令不支持 --${name}`);
  }
}

function requiredPosition(positionals: string[], index: number, label: string): string {
  const value = positionals[index];
  if (!value) throw new CliError("CLI_ARGUMENT_REQUIRED", `缺少 ${label}`);
  return value;
}

function assertPositionCount(positionals: string[], expected: number): void {
  if (positionals.length > expected) {
    throw new CliError("CLI_ARGUMENT_UNEXPECTED", `存在多余参数：${positionals.slice(expected).join(" ")}`);
  }
}

function emitJson(stream: OutputStream, value: unknown, compact: boolean): void {
  stream.write(`${JSON.stringify(value, null, compact ? 0 : 2)}\n`);
}

function emitText(stream: OutputStream, value: string): void {
  stream.write(value.endsWith("\n") ? value : `${value}\n`);
}

function emitHttpServerWarning(stream: OutputStream, server: string, compact: boolean): void {
  if (new URL(server).protocol !== "http:") return;
  emitJson(stream, {
    warning: {
      code: "CLI_SERVER_HTTP_WARNING",
      message: "当前服务端使用 HTTP，API Key 和业务数据将以明文传输；请仅在可信局域网中使用，公网访问请配置 HTTPS",
      server
    }
  }, compact);
}

function configPath(parsed: ParsedArguments, dependencies: Required<Pick<CliDependencies, "env" | "cwd" | "homeDirectory">>): string {
  const configured = option(parsed, "config") ?? dependencies.env.SCRIVERSE_CONFIG;
  if (configured) return isAbsolute(configured) ? configured : resolve(dependencies.cwd, configured);
  const base = dependencies.env.XDG_CONFIG_HOME?.trim() || join(dependencies.homeDirectory, ".config");
  return join(base, "scriverse", "cli.json");
}

function normalizeServer(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError("CLI_SERVER_INVALID", "服务端地址不是有效 URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new CliError("CLI_SERVER_INVALID", "服务端地址必须是无内嵌凭据的 HTTP 或 HTTPS 地址");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new CliError("CLI_SERVER_INVALID", "服务端地址不能包含路径，请只填写协议、主机和端口");
  }
  return url.origin;
}

function emptyConfig(): CliConfig {
  return { version: 2, defaultServer: null, servers: {} };
}

function validUser(value: unknown): value is CliUser {
  if (!value || typeof value !== "object") return false;
  const user = value as Partial<CliUser>;
  return typeof user.userId === "string"
    && typeof user.username === "string"
    && typeof user.displayName === "string"
    && (user.role === "admin" || user.role === "user");
}

function validCredentials(value: unknown): value is CliServerCredentials {
  if (!value || typeof value !== "object") return false;
  const credentials = value as Partial<CliServerCredentials>;
  return typeof credentials.apiKey === "string"
    && (typeof credentials.apiKeyPrefix === "string" || credentials.apiKeyPrefix === null)
    && validUser(credentials.user);
}

function readConfig(path: string): CliConfig {
  if (!existsSync(path)) throw new CliError("CLI_LOGIN_REQUIRED", "请先执行 auth login");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new CliError("CLI_CONFIG_INVALID", `CLI 配置文件无法读取：${path}`);
  }
  if (!parsed || typeof parsed !== "object") throw new CliError("CLI_CONFIG_INVALID", "CLI 配置内容无效");
  const value = parsed as Record<string, unknown>;
  const legacyServer = typeof value.server === "string" ? value.server : null;
  if (value.version === 1 && legacyServer && validCredentials(value)) {
    const server = normalizeServer(legacyServer);
    return {
      version: 2,
      defaultServer: server,
      servers: {
        [server]: {
          apiKey: value.apiKey,
          apiKeyPrefix: value.apiKeyPrefix,
          user: value.user
        }
      }
    };
  }
  if (value.version !== 2 || (value.defaultServer !== null && typeof value.defaultServer !== "string") || !value.servers || typeof value.servers !== "object" || Array.isArray(value.servers)) {
    throw new CliError("CLI_CONFIG_INVALID", "CLI 配置字段不完整，请重新登录");
  }
  const defaultServer = value.defaultServer === null ? null : normalizeServer(value.defaultServer);
  const servers: Record<string, CliServerCredentials> = {};
  for (const [serverValue, credentials] of Object.entries(value.servers)) {
    if (!validCredentials(credentials)) throw new CliError("CLI_CONFIG_INVALID", "CLI 服务器凭据字段不完整，请重新登录");
    servers[normalizeServer(serverValue)] = credentials;
  }
  return { version: 2, defaultServer, servers };
}

function readOptionalConfig(path: string): CliConfig {
  return existsSync(path) ? readConfig(path) : emptyConfig();
}

function writeConfig(path: string, config: CliConfig): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function readBoundedFile(path: string, cwd: string): string {
  const resolved = isAbsolute(path) ? path : resolve(cwd, path);
  const content = readFileSync(resolved);
  if (content.byteLength > maximumInputBytes) throw new CliError("CLI_INPUT_TOO_LARGE", `输入文件超过 ${maximumInputBytes} 字节限制`);
  return content.toString("utf8");
}

async function readBoundedStdin(stdin: InputStream): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.byteLength;
    if (length > maximumInputBytes) throw new CliError("CLI_INPUT_TOO_LARGE", `标准输入超过 ${maximumInputBytes} 字节限制`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJsonObject(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CliError("CLI_INPUT_INVALID", "编辑输入不是有效的 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError("CLI_INPUT_INVALID", "编辑输入必须是 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}

async function editInput(parsed: ParsedArguments, dependencies: Required<Pick<CliDependencies, "stdin" | "cwd">>, allowChangeNote: boolean): Promise<Record<string, unknown>> {
  const inputPath = option(parsed, "input");
  const fieldFiles = optionValues(parsed, "field-file");
  if (!inputPath && !fieldFiles.length) {
    throw new CliError("CLI_INPUT_REQUIRED", "请使用 --input <json-file|->，或至少提供一个 --field-file field=path");
  }
  const input = inputPath
    ? parseJsonObject(inputPath === "-" ? await readBoundedStdin(dependencies.stdin) : readBoundedFile(inputPath, dependencies.cwd))
    : {};
  for (const binding of fieldFiles) {
    const separator = binding.indexOf("=");
    const field = separator > 0 ? binding.slice(0, separator) : "";
    const path = separator > 0 ? binding.slice(separator + 1) : "";
    if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(field) || !path) {
      throw new CliError("CLI_FIELD_FILE_INVALID", "--field-file 必须使用 field=path 格式");
    }
    input[field] = readBoundedFile(path, dependencies.cwd);
  }
  const note = option(parsed, "change-note");
  if (note !== undefined) {
    if (!allowChangeNote) throw new CliError("CLI_CHANGE_NOTE_UNSUPPORTED", "当前资源不支持版本说明");
    input.changeNote = note;
  }
  return input;
}

function selectedServer(parsed: ParsedArguments, config: CliConfig): string {
  const configured = option(parsed, "server");
  if (configured) return normalizeServer(configured);
  if (config.defaultServer) return config.defaultServer;
  throw new CliError("CLI_SERVER_REQUIRED", "请先执行 connect <url>，或使用 --server 指定服务器");
}

function requestConfig(parsed: ParsedArguments, path: string): CliRequestConfig {
  const config = readConfig(path);
  const server = selectedServer(parsed, config);
  const credentials = config.servers[server];
  if (!credentials) throw new CliError("CLI_LOGIN_REQUIRED", `请先对 ${server} 执行 auth login`);
  return { server, ...credentials };
}

async function apiRequest(fetchImpl: typeof fetch, config: CliRequestConfig, path: string, options: RequestOptions = {}): Promise<unknown> {
  const response = await apiResponse(fetchImpl, config, path, options);
  const text = await response.text();
  if (options.text) return text;
  if (!text) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new CliError("CLI_RESPONSE_INVALID", "服务端返回了无效 JSON");
  }
  if (payload && typeof payload === "object" && "data" in payload) return (payload as { data: unknown }).data;
  return payload;
}

async function apiResponse(fetchImpl: typeof fetch, config: CliRequestConfig, path: string, options: RequestOptions = {}): Promise<Response> {
  const response = await fetchImpl(`${config.server}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Accept: options.text ? "text/plain" : "application/json",
      Authorization: `Bearer ${config.apiKey}`,
      ...(options.body ? { "Content-Type": "application/json" } : {})
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {})
  }).catch((error: unknown) => {
    throw new CliError("CLI_NETWORK_ERROR", error instanceof Error ? error.message : "无法连接服务端");
  });
  if (!response.ok) {
    const text = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    const remote = payload && typeof payload === "object" && "error" in payload
      ? (payload as { error?: { code?: unknown; message?: unknown; details?: unknown } }).error
      : undefined;
    throw new CliError(
      typeof remote?.code === "string" ? remote.code : `HTTP_${response.status}`,
      typeof remote?.message === "string" ? remote.message : `服务端请求失败，状态码 ${response.status}`,
      remote?.details
    );
  }
  return response;
}

async function downloadToFile(fetchImpl: typeof fetch, config: CliRequestConfig, path: string, outputPath: string, cwd: string): Promise<{ outputPath: string; bytes: number; contentType: string | null }> {
  const resolvedPath = isAbsolute(outputPath) ? outputPath : resolve(cwd, outputPath);
  if (existsSync(resolvedPath)) throw new CliError("CLI_OUTPUT_EXISTS", `输出文件已存在：${resolvedPath}`);
  const response = await apiResponse(fetchImpl, config, path);
  if (!response.body) throw new CliError("CLI_RESPONSE_INVALID", "服务端没有返回导出文件内容");
  let bytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      callback(null, chunk);
    }
  });
  try {
    await pipeline(Readable.from(response.body as unknown as AsyncIterable<Uint8Array>), counter, createWriteStream(resolvedPath, { flags: "wx" }));
  } catch (error) {
    throw new CliError("CLI_DOWNLOAD_FAILED", `导出文件写入失败：${error instanceof Error ? error.message : "未知错误"}`, { outputPath: resolvedPath });
  }
  return { outputPath: resolvedPath, bytes, contentType: response.headers.get("content-type") };
}

function resourceType(value: string): CliResourceType {
  if ((cliResourceTypes as readonly string[]).includes(value)) return value as CliResourceType;
  throw new CliError("CLI_RESOURCE_UNKNOWN", `未知资源类型：${value}`);
}

function encoded(value: string): string {
  return encodeURIComponent(value);
}

function resourceListPath(type: CliResourceType, workId: string): string {
  const suffix: Record<Exclude<CliResourceType, "volume" | "chapter" | "chapter-outline">, string> = {
    draft: "drafts",
    setting: "settings",
    character: "characters",
    race: "races",
    organization: "organizations",
    "timeline-track": "timeline-tracks",
    "timeline-event": "timeline",
    relationship: "relationships",
    foreshadow: "foreshadows"
  };
  if (type === "volume" || type === "chapter") return `/api/works/${encoded(workId)}`;
  if (type === "chapter-outline") return `/api/works/${encoded(workId)}/outlines`;
  return `/api/works/${encoded(workId)}/${suffix[type]}${type === "foreshadow" ? "?status=all" : ""}`;
}

function resourceGetPath(type: CliResourceType, id: string): string {
  const prefix: Record<Exclude<CliResourceType, "chapter-outline">, string> = {
    volume: "volumes",
    chapter: "chapters",
    draft: "drafts",
    setting: "settings",
    character: "characters",
    race: "races",
    organization: "organizations",
    "timeline-track": "timeline-tracks",
    "timeline-event": "timeline",
    relationship: "relationships",
    foreshadow: "foreshadows"
  };
  if (type === "chapter-outline") return `/api/chapters/${encoded(id)}/outline`;
  return `/api/${prefix[type]}/${encoded(id)}`;
}

function resourceCreatePath(type: CliResourceType, scopeId: string): { path: string; method: "POST" | "PUT" } {
  if (type === "chapter-outline") return { path: `/api/chapters/${encoded(scopeId)}/outline`, method: "PUT" };
  const suffix: Record<Exclude<CliResourceType, "chapter-outline">, string> = {
    volume: "volumes",
    chapter: "chapters",
    draft: "drafts",
    setting: "settings",
    character: "characters",
    race: "races",
    organization: "organizations",
    "timeline-track": "timeline-tracks",
    "timeline-event": "timeline",
    relationship: "relationships",
    foreshadow: "foreshadows"
  };
  return { path: `/api/works/${encoded(scopeId)}/${suffix[type]}`, method: "POST" };
}

function resourceUpdatePath(type: CliResourceType, id: string): { path: string; method: "PATCH" | "PUT" } {
  if (type === "chapter-outline") return { path: `/api/chapters/${encoded(id)}/outline`, method: "PUT" };
  return { path: resourceGetPath(type, id), method: "PATCH" };
}

function resourceHistoryPath(type: CliResourceType, id: string): string {
  if (type === "chapter") return `/api/chapters/${encoded(id)}/versions`;
  if (type === "character") return `/api/characters/${encoded(id)}/versions`;
  return `/api/entity-versions/${encoded(type)}/${encoded(id)}`;
}

function resourceRestorePath(type: CliResourceType, id: string): string {
  if (type === "chapter") return `/api/chapters/${encoded(id)}/restore`;
  if (type === "character") return `/api/characters/${encoded(id)}/restore`;
  return `/api/entity-versions/${encoded(type)}/${encoded(id)}/restore`;
}

function summarizeTreeList(type: "volume" | "chapter", tree: unknown): unknown[] {
  if (!tree || typeof tree !== "object" || !Array.isArray((tree as { volumes?: unknown }).volumes)) return [];
  const volumes = (tree as { volumes: Array<Record<string, unknown>> }).volumes;
  if (type === "volume") {
    return volumes.map(({ chapters, ...volume }) => ({ ...volume, chapterCount: Array.isArray(chapters) ? chapters.length : 0 }));
  }
  return volumes.flatMap((volume) => {
    const chapters = Array.isArray(volume.chapters) ? volume.chapters as Array<Record<string, unknown>> : [];
    return chapters.map((chapter) => ({
      id: chapter.id,
      workId: chapter.workId,
      volumeId: volume.id,
      volumeTitle: volume.title,
      title: chapter.title,
      chapterType: chapter.chapterType,
      sortOrder: chapter.sortOrder,
      wordCount: chapter.wordCount,
      versionNo: chapter.versionNo,
      analysisStatus: chapter.analysisStatus,
      updatedAt: chapter.updatedAt
    }));
  });
}

function helpText(): string {
  return `Scriverse CLI

本地服务：
  scriverse serve [--host <host>] [--port <port>] [--data-dir <path>]

默认服务器：
  scriverse connect <url>
  scriverse connect

认证：
  scriverse auth login [--server <url>] [--api-key <key> | --api-key-file <path>]
  scriverse auth status [--server <url>]
  scriverse auth logout [--server <url>]

查询：
  scriverse work list
  scriverse work get <workId>
  scriverse work history <workId>
  scriverse work restore <workId> --version <number>
  scriverse manuscript get <workId> [--format json|markdown|txt|docx|epub] [--output <path>]
  scriverse search <workId> --query <text> [--type <type>] [--limit <number>]
  scriverse audit <workId>
  scriverse writing progress <workId>
  scriverse annotation list <chapterId>
  scriverse annotation list-work <workId>

编辑：
  scriverse work create --input <json-file|->
  scriverse work update <workId> --input <json-file|->
  scriverse resource list <type> <workId>
  scriverse resource get <type> <id>
  scriverse resource create <type> <workId|chapterId> --input <json-file|->
  scriverse resource update <type> <id> --input <json-file|-> [--change-note <text>]
  scriverse resource history <type> <id>
  scriverse resource restore <type> <id> --version <number>
  scriverse writing goal <workId> --input <json-file|->
  scriverse chapter move <chapterId> --input <json-file|->
  scriverse chapter batch <workId> --input <json-file|->
  scriverse annotation create <chapterId> --input <json-file|->
  scriverse annotation update <annotationId> --input <json-file|->
  scriverse annotation delete <annotationId> [--expected-version <number>]

AI 对话与提问：
  scriverse ai rename <conversationId> --title <text>
  scriverse ai questions list <workId> [--status pending|answered|rejected|expired] [--conversation-id <id>] [--limit <number>]
  scriverse ai questions get <workId> <questionId>
  scriverse ai questions answer <workId> <questionId> --input <json-file|->
  scriverse ai questions reject <workId> <questionId>

AI 编辑辅助：
  scriverse schema list
  scriverse schema show <type>
  --field-file content=chapter.txt 可把长文本写入 JSON 字段
  ai questions answer 的 --input 支持单项 {selectedOption, customAnswer} 或批量 {answers: [...最多 5 项]}
  跨作品 IM 仅限网页或桌面交互式会话使用，不通过 CLI 开放

全局选项：
  --config <path>  指定登录配置文件
  --server <url>   仅为当前子命令覆盖默认服务器
  --compact        输出单行 JSON
`;
}

function schemaList(): Record<string, unknown> {
  return {
    output: "除 manuscript 的 markdown/txt/docx/epub 外，所有成功结果都输出 JSON；错误输出到 stderr 并返回非零状态码。",
    input: {
      json: "create/update 使用 --input file.json 或 --input - 从标准输入读取 JSON 对象",
      longText: "使用可重复的 --field-file field=path 注入长文本字段",
      history: "版本化资源更新时使用 --change-note 说明修改原因"
    },
    commands: {
      writing: ["progress", "goal"],
      chapter: ["move", "batch"],
      annotation: ["list", "list-work", "create", "update", "delete"],
      manuscript: ["get"],
      ai: ["rename", "questions"]
    },
    prohibited: ["用户管理", "作品成员管理", "系统管理", "AI 供应商与模型管理", "永久删除及作品、分卷、知识实体删除", "任意 HTTP 请求", "跨作品 IM（仅限交互式会话）"],
    resources: cliResourceTypes.map((type) => ({
      type,
      description: cliResourceDefinitions[type].description,
      scopeArgument: cliResourceDefinitions[type].scopeArgument,
      actions: cliResourceDefinitions[type].actions
    })),
    work: cliWorkDefinition
  };
}

async function execute(parsed: ParsedArguments, dependencies: Required<CliDependencies>): Promise<void> {
  const compact = option(parsed, "compact") === "true";
  const [group, action] = parsed.positionals;
  if (!group || group === "help" || option(parsed, "help") === "true") {
    assertAllowedOptions(parsed, []);
    emitText(dependencies.stdout, helpText());
    return;
  }

  const path = configPath(parsed, dependencies);
  if (group === "serve") {
    assertAllowedOptions(parsed, ["host", "port", "data-dir", "database-path"]);
    assertPositionCount(parsed.positionals, 1);
    const host = (option(parsed, "host") ?? dependencies.env.HOST ?? "127.0.0.1").trim();
    if (!host) throw new CliError("CLI_HOST_INVALID", "监听地址不能为空");
    const port = Number(option(parsed, "port") ?? dependencies.env.PORT ?? 13210);
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      throw new CliError("CLI_PORT_INVALID", "端口必须是 1 到 65535 之间的整数");
    }
    const dataDirectoryValue = option(parsed, "data-dir") ?? dependencies.env.DATA_DIR ?? join(dependencies.cwd, ".data");
    const dataDirectory = isAbsolute(dataDirectoryValue) ? dataDirectoryValue : resolve(dependencies.cwd, dataDirectoryValue);
    const databasePathValue = option(parsed, "database-path") ?? dependencies.env.DATABASE_PATH ?? join(dataDirectory, "novel.db");
    const databasePath = isAbsolute(databasePathValue) ? databasePathValue : resolve(dependencies.cwd, databasePathValue);
    const result = await dependencies.serveImpl({ host, port, dataDirectory, databasePath, env: dependencies.env });
    emitJson(dependencies.stdout, {
      running: true,
      url: result.url,
      port: result.port,
      dataDirectory: result.dataDirectory,
      databasePath: result.databasePath
    }, compact);
    return;
  }

  if (group === "connect") {
    assertAllowedOptions(parsed, []);
    assertPositionCount(parsed.positionals, 2);
    const config = readOptionalConfig(path);
    const requested = parsed.positionals[1];
    if (requested) {
      const server = normalizeServer(requested);
      const shouldWarn = server !== config.defaultServer;
      config.defaultServer = server;
      writeConfig(path, config);
      if (shouldWarn) emitHttpServerWarning(dependencies.stderr, server, compact);
    }
    emitJson(dependencies.stdout, {
      defaultServer: config.defaultServer,
      authenticated: config.defaultServer ? Boolean(config.servers[config.defaultServer]) : false,
      configPath: path
    }, compact);
    return;
  }

  if (group === "auth") {
    if (action === "login") {
      assertAllowedOptions(parsed, ["server", "api-key", "api-key-file"]);
      assertPositionCount(parsed.positionals, 2);
      const existing = readOptionalConfig(path);
      const server = selectedServer(parsed, existing);
      const directKey = option(parsed, "api-key");
      const keyFile = option(parsed, "api-key-file");
      const environmentKey = dependencies.env.SCRIVERSE_API_KEY?.trim();
      const supplied = [directKey, keyFile ? readBoundedFile(keyFile, dependencies.cwd).trim() : undefined, environmentKey].filter((value): value is string => Boolean(value));
      if (supplied.length !== 1) {
        throw new CliError("CLI_API_KEY_REQUIRED", "请通过 --api-key、--api-key-file 或 SCRIVERSE_API_KEY 三者之一提供 API Key");
      }
      const apiKey = supplied[0]!;
      emitHttpServerWarning(dependencies.stderr, server, compact);
      const temporary: CliRequestConfig = {
        server,
        apiKey,
        apiKeyPrefix: null,
        user: { userId: "", username: "", displayName: "", role: "user" }
      };
      const session = await apiRequest(dependencies.fetchImpl, temporary, "/api/cli/session") as {
        user?: CliUser;
        apiKeyPrefix?: string | null;
      };
      if (!session.user?.userId) throw new CliError("CLI_RESPONSE_INVALID", "服务端没有返回有效用户信息");
      existing.defaultServer ??= server;
      existing.servers[server] = {
        apiKey,
        apiKeyPrefix: session.apiKeyPrefix ?? null,
        user: session.user
      };
      writeConfig(path, existing);
      emitJson(dependencies.stdout, { authenticated: true, server, user: session.user, apiKeyPrefix: session.apiKeyPrefix ?? null, configPath: path }, compact);
      return;
    }
    if (action === "status") {
      assertAllowedOptions(parsed, []);
      assertPositionCount(parsed.positionals, 2);
      if (!existsSync(path)) {
        emitJson(dependencies.stdout, { authenticated: false, defaultServer: null, configPath: path }, compact);
        return;
      }
      const config = readConfig(path);
      const server = selectedServer(parsed, config);
      const credentials = config.servers[server];
      if (!credentials) {
        emitJson(dependencies.stdout, { authenticated: false, server, defaultServer: config.defaultServer, configPath: path }, compact);
        return;
      }
      const session = await apiRequest(dependencies.fetchImpl, { server, ...credentials }, "/api/cli/session");
      emitJson(dependencies.stdout, { ...(session as Record<string, unknown>), server, defaultServer: config.defaultServer, configPath: path }, compact);
      return;
    }
    if (action === "logout") {
      assertAllowedOptions(parsed, []);
      assertPositionCount(parsed.positionals, 2);
      if (!existsSync(path)) {
        emitJson(dependencies.stdout, { authenticated: false, defaultServer: null, configPath: path }, compact);
        return;
      }
      const config = readConfig(path);
      const server = selectedServer(parsed, config);
      delete config.servers[server];
      writeConfig(path, config);
      emitJson(dependencies.stdout, { authenticated: false, server, defaultServer: config.defaultServer, configPath: path }, compact);
      return;
    }
    throw new CliError("CLI_COMMAND_UNKNOWN", "未知 auth 命令");
  }

  if (group === "schema") {
    if (action === "list") {
      assertAllowedOptions(parsed, []);
      assertPositionCount(parsed.positionals, 2);
      emitJson(dependencies.stdout, schemaList(), compact);
      return;
    }
    if (action === "show") {
      assertAllowedOptions(parsed, []);
      const requestedType = requiredPosition(parsed.positionals, 2, "resource type");
      assertPositionCount(parsed.positionals, 3);
      if (requestedType === "work") {
        emitJson(dependencies.stdout, { type: "work", ...cliWorkDefinition }, compact);
        return;
      }
      const type = resourceType(requestedType);
      emitJson(dependencies.stdout, { type, ...cliResourceDefinitions[type] }, compact);
      return;
    }
    throw new CliError("CLI_COMMAND_UNKNOWN", "未知 schema 命令");
  }

  if (!["work", "manuscript", "search", "audit", "resource", "writing", "chapter", "annotation", "ai"].includes(group)) {
    throw new CliError("CLI_COMMAND_UNKNOWN", "未知命令；使用 --help 查看可用命令");
  }
  const config = requestConfig(parsed, path);
  if (group === "work") {
    if (action === "list") {
      assertAllowedOptions(parsed, []);
      assertPositionCount(parsed.positionals, 2);
      emitJson(dependencies.stdout, await apiRequest(dependencies.fetchImpl, config, "/api/works"), compact);
      return;
    }
    if (action === "get") {
      assertAllowedOptions(parsed, []);
      const workId = requiredPosition(parsed.positionals, 2, "workId");
      assertPositionCount(parsed.positionals, 3);
      emitJson(dependencies.stdout, await apiRequest(dependencies.fetchImpl, config, `/api/works/${encoded(workId)}`), compact);
      return;
    }
    if (action === "create") {
      assertAllowedOptions(parsed, ["input", "field-file"]);
      assertPositionCount(parsed.positionals, 2);
      const body = await editInput(parsed, dependencies, false);
      emitJson(dependencies.stdout, await apiRequest(dependencies.fetchImpl, config, "/api/works", { method: "POST", body }), compact);
      return;
    }
    if (action === "update") {
      assertAllowedOptions(parsed, ["input", "field-file"]);
      const workId = requiredPosition(parsed.positionals, 2, "workId");
      assertPositionCount(parsed.positionals, 3);
      const body = await editInput(parsed, dependencies, false);
      emitJson(dependencies.stdout, await apiRequest(dependencies.fetchImpl, config, `/api/works/${encoded(workId)}`, { method: "PATCH", body }), compact);
      return;
    }
    if (action === "history") {
      assertAllowedOptions(parsed, []);
      const workId = requiredPosition(parsed.positionals, 2, "workId");
      assertPositionCount(parsed.positionals, 3);
      emitJson(dependencies.stdout, await apiRequest(dependencies.fetchImpl, config, `/api/entity-versions/work/${encoded(workId)}`), compact);
      return;
    }
    if (action === "restore") {
      assertAllowedOptions(parsed, ["version", "expected-version"]);
      const workId = requiredPosition(parsed.positionals, 2, "workId");
      assertPositionCount(parsed.positionals, 3);
      const version = Number(option(parsed, "version"));
      if (!Number.isInteger(version) || version <= 0) throw new CliError("CLI_VERSION_INVALID", "请使用 --version 提供正整数版本号");
      const expectedVersion = option(parsed, "expected-version");
      const expectedVersionNo = expectedVersion === undefined ? undefined : Number(expectedVersion);
      if (expectedVersionNo !== undefined && (!Number.isInteger(expectedVersionNo) || expectedVersionNo <= 0)) {
        throw new CliError("CLI_VERSION_INVALID", "请使用 --expected-version 提供正整数版本号");
      }
      emitJson(dependencies.stdout, await apiRequest(dependencies.fetchImpl, config, `/api/entity-versions/work/${encoded(workId)}/restore`, {
        method: "POST",
        body: { versionNo: version, ...(expectedVersionNo === undefined ? {} : { expectedVersionNo }) }
      }), compact);
      return;
    }
    throw new CliError("CLI_COMMAND_UNKNOWN", "未知 work 命令");
  }

  if (group === "manuscript" && action === "get") {
    assertAllowedOptions(parsed, ["format", "output"]);
    const workId = requiredPosition(parsed.positionals, 2, "workId");
    assertPositionCount(parsed.positionals, 3);
    const format = option(parsed, "format") ?? "json";
    if (!["json", "markdown", "txt", "docx", "epub"].includes(format)) throw new CliError("CLI_FORMAT_INVALID", "format 必须是 json、markdown、txt、docx 或 epub");
    if (format === "json") {
      if (option(parsed, "output")) throw new CliError("CLI_OUTPUT_UNSUPPORTED", "JSON 格式直接输出到标准输出，不支持 --output");
      emitJson(dependencies.stdout, await apiRequest(dependencies.fetchImpl, config, `/api/works/${encoded(workId)}`), compact);
    } else if (format === "markdown" || format === "docx" || format === "epub") {
      const defaultOutput = format === "docx" ? `novel-${workId}.docx` : format === "epub" ? `novel-${workId}.epub` : `novel-${workId}.zip`;
      const outputPath = option(parsed, "output") ?? defaultOutput;
      emitJson(dependencies.stdout, {
        format,
        ...(await downloadToFile(dependencies.fetchImpl, config, `/api/works/${encoded(workId)}/export?format=${format}`, outputPath, dependencies.cwd))
      }, compact);
    } else if (option(parsed, "output")) {
      emitJson(dependencies.stdout, {
        format,
        ...(await downloadToFile(dependencies.fetchImpl, config, `/api/works/${encoded(workId)}/export?format=${format}`, option(parsed, "output")!, dependencies.cwd))
      }, compact);
    } else {
      emitText(dependencies.stdout, String(await apiRequest(dependencies.fetchImpl, config, `/api/works/${encoded(workId)}/export?format=${format}`, { text: true })));
    }
    return;
  }

  if (group === "search") {
    assertAllowedOptions(parsed, ["query", "type", "limit"]);
    const workId = requiredPosition(parsed.positionals, 1, "workId");
    assertPositionCount(parsed.positionals, 2);
    const query = option(parsed, "query")?.trim();
    if (!query) throw new CliError("CLI_QUERY_REQUIRED", "请使用 --query 提供搜索词");
    const type = option(parsed, "type")?.trim();
    if (type && !HYBRID_SEARCH_TYPES.includes(type as typeof HYBRID_SEARCH_TYPES[number])) {
      throw new CliError("CLI_SEARCH_TYPE_INVALID", `type 必须是 ${HYBRID_SEARCH_TYPES.join("、")} 之一`);
    }
    const rawLimit = option(parsed, "limit");
    const limit = rawLimit === undefined ? undefined : Number(rawLimit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
      throw new CliError("CLI_SEARCH_LIMIT_INVALID", "limit 必须是 1 到 100 之间的整数");
    }
    const parameters = new URLSearchParams({ q: query });
    if (type) parameters.set("type", type);
    if (limit !== undefined) parameters.set("limit", String(limit));
    emitJson(dependencies.stdout, await apiRequest(dependencies.fetchImpl, config, `/api/works/${encoded(workId)}/search?${parameters}`), compact);
    return;
  }

  if (group === "audit") {
    assertAllowedOptions(parsed, []);
    const workId = requiredPosition(parsed.positionals, 1, "workId");
    assertPositionCount(parsed.positionals, 2);
    emitJson(dependencies.stdout, await apiRequest(dependencies.fetchImpl, config, `/api/works/${encoded(workId)}/audit-logs`), compact);
    return;
  }

  if (group === "writing") {
    const workId = requiredPosition(parsed.positionals, 2, "workId");
    assertPositionCount(parsed.positionals, 3);
    if (action === "progress") {
      assertAllowedOptions(parsed, []);
      emitJson(dependencies.stdout, await apiRequest(dependencies.fetchImpl, config, `/api/works/${encoded(workId)}/writing-progress`), compact);
      return;
    }
    if (action === "goal") {
      assertAllowedOptions(parsed, ["input", "field-file"]);
      const body = await editInput(parsed, dependencies, false);
      emitJson(dependencies.stdout, await apiRequest(dependencies.fetchImpl, config, `/api/works/${encoded(workId)}/writing-goal`, { method: "PUT", body }), compact);
      return;
    }
    throw new CliError("CLI_COMMAND_UNKNOWN", "未知 writing 命令");
  }

  if (group === "chapter") {
    const id = requiredPosition(parsed.positionals, 2, action === "batch" ? "workId" : "chapterId");
    assertPositionCount(parsed.positionals, 3);
    if (action === "move") {
      assertAllowedOptions(parsed, ["input", "field-file"]);
      const body = await editInput(parsed, dependencies, false);
      emitJson(dependencies.stdout, await apiRequest(dependencies.fetchImpl, config, `/api/chapters/${encoded(id)}/move`, { method: "POST", body }), compact);
      return;
    }
    if (action === "batch") {
      assertAllowedOptions(parsed, ["input", "field-file"]);
      const body = await editInput(parsed, dependencies, false);
      emitJson(dependencies.stdout, await apiRequest(dependencies.fetchImpl, config, `/api/works/${encoded(id)}/chapters/batch`, { method: "POST", body }), compact);
      return;
    }
    throw new CliError("CLI_COMMAND_UNKNOWN", "未知 chapter 命令");
  }

  if (group === "annotation") {
    const id = requiredPosition(parsed.positionals, 2, action === "list-work" ? "workId" : (action === "list" || action === "create" ? "chapterId" : "annotationId"));
    assertPositionCount(parsed.positionals, 3);
    if (action === "list") {
      assertAllowedOptions(parsed, []);
      emitJson(dependencies.stdout, await apiRequest(dependencies.fetchImpl, config, `/api/chapters/${encoded(id)}/annotations`), compact);
      return;
    }
    if (action === "list-work") {
      assertAllowedOptions(parsed, []);
      emitJson(dependencies.stdout, await apiRequest(dependencies.fetchImpl, config, `/api/works/${encoded(id)}/chapter-annotations`), compact);
      return;
    }
    if (action === "create") {
      assertAllowedOptions(parsed, ["input", "field-file"]);
      const body = await editInput(parsed, dependencies, false);
      emitJson(dependencies.stdout, await apiRequest(dependencies.fetchImpl, config, `/api/chapters/${encoded(id)}/annotations`, { method: "POST", body }), compact);
      return;
    }
    if (action === "update") {
      assertAllowedOptions(parsed, ["input", "field-file"]);
      const body = await editInput(parsed, dependencies, false);
      emitJson(dependencies.stdout, await apiRequest(dependencies.fetchImpl, config, `/api/chapter-annotations/${encoded(id)}`, { method: "PATCH", body }), compact);
      return;
    }
    if (action === "delete") {
      assertAllowedOptions(parsed, ["expected-version"]);
      const expectedVersion = option(parsed, "expected-version");
      const expectedVersionNo = expectedVersion === undefined ? undefined : Number(expectedVersion);
      if (expectedVersionNo !== undefined && (!Number.isInteger(expectedVersionNo) || expectedVersionNo <= 0)) {
        throw new CliError("CLI_VERSION_INVALID", "请使用 --expected-version 提供正整数版本号");
      }
      emitJson(dependencies.stdout, await apiRequest(dependencies.fetchImpl, config, `/api/chapter-annotations/${encoded(id)}`, {
        method: "DELETE",
        body: expectedVersionNo === undefined ? {} : { expectedVersionNo }
      }), compact);
      return;
    }
    throw new CliError("CLI_COMMAND_UNKNOWN", "未知 annotation 命令");
  }

  if (group === "ai") {
    if (action === "rename") {
      assertAllowedOptions(parsed, ["title"]);
      const conversationId = requiredPosition(parsed.positionals, 2, "conversationId");
      assertPositionCount(parsed.positionals, 3);
      const title = option(parsed, "title")?.trim() ?? "";
      if (!title) throw new CliError("CLI_TITLE_REQUIRED", "请使用 --title 提供新标题");
      if (title.length > 200) throw new CliError("CLI_TITLE_INVALID", "标题不能超过 200 字");
      emitJson(dependencies.stdout, await apiRequest(dependencies.fetchImpl, config, `/api/ai-conversations/${encoded(conversationId)}/title`, {
        method: "PATCH",
        body: { title }
      }), compact);
      return;
    }
    if (action === "questions") {
      const subaction = requiredPosition(parsed.positionals, 2, "questions 子命令");
      if (subaction === "list") {
        assertAllowedOptions(parsed, ["status", "conversation-id", "limit"]);
        const workId = requiredPosition(parsed.positionals, 3, "workId");
        assertPositionCount(parsed.positionals, 4);
        const status = option(parsed, "status")?.trim();
        if (status && !AI_USER_QUESTION_STATUSES.includes(status as never)) {
          throw new CliError("CLI_QUESTION_STATUS_INVALID", `status 必须是 ${AI_USER_QUESTION_STATUSES.join("、")} 之一`);
        }
        const conversationId = option(parsed, "conversation-id")?.trim();
        if (conversationId !== undefined && !conversationId) {
          throw new CliError("CLI_CONVERSATION_ID_INVALID", "--conversation-id 不能为空");
        }
        const rawLimit = option(parsed, "limit");
        const limit = rawLimit === undefined ? undefined : Number(rawLimit);
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) {
          throw new CliError("CLI_QUESTION_LIMIT_INVALID", "limit 必须是 1 到 200 之间的整数");
        }
        const parameters = new URLSearchParams();
        if (conversationId) parameters.set("conversationId", conversationId);
        if (status) parameters.set("status", status);
        if (limit !== undefined) parameters.set("limit", String(limit));
        const query = parameters.size > 0 ? `?${parameters}` : "";
        emitJson(dependencies.stdout, await apiRequest(dependencies.fetchImpl, config, `/api/works/${encoded(workId)}/ai/questions${query}`), compact);
        return;
      }
      if (subaction === "get") {
        assertAllowedOptions(parsed, []);
        const workId = requiredPosition(parsed.positionals, 3, "workId");
        const questionId = requiredPosition(parsed.positionals, 4, "questionId");
        assertPositionCount(parsed.positionals, 5);
        emitJson(dependencies.stdout, await apiRequest(dependencies.fetchImpl, config, `/api/works/${encoded(workId)}/ai/questions/${encoded(questionId)}`), compact);
        return;
      }
      if (subaction === "answer") {
        assertAllowedOptions(parsed, ["input", "field-file"]);
        const workId = requiredPosition(parsed.positionals, 3, "workId");
        const questionId = requiredPosition(parsed.positionals, 4, "questionId");
        assertPositionCount(parsed.positionals, 5);
        const body = await editInput(parsed, dependencies, false);
        emitJson(dependencies.stdout, await apiRequest(dependencies.fetchImpl, config, `/api/works/${encoded(workId)}/ai/questions/${encoded(questionId)}/answer`, {
          method: "POST",
          body
        }), compact);
        return;
      }
      if (subaction === "reject") {
        assertAllowedOptions(parsed, []);
        const workId = requiredPosition(parsed.positionals, 3, "workId");
        const questionId = requiredPosition(parsed.positionals, 4, "questionId");
        assertPositionCount(parsed.positionals, 5);
        emitJson(dependencies.stdout, await apiRequest(dependencies.fetchImpl, config, `/api/works/${encoded(workId)}/ai/questions/${encoded(questionId)}/reject`, {
          method: "POST",
          body: {}
        }), compact);
        return;
      }
      throw new CliError("CLI_COMMAND_UNKNOWN", "未知 ai questions 子命令");
    }
    throw new CliError("CLI_COMMAND_UNKNOWN", "未知 ai 命令");
  }

  if (group === "resource") {
    const type = resourceType(requiredPosition(parsed.positionals, 2, "resource type"));
    const id = requiredPosition(parsed.positionals, 3, action === "list" ? "workId" : (action === "create" ? cliResourceDefinitions[type].scopeArgument : "resource id"));
    assertPositionCount(parsed.positionals, 4);
    if (!cliResourceDefinitions[type].actions.includes(action as never)) {
      throw new CliError("CLI_ACTION_UNSUPPORTED", `${type} 不支持 ${action}`);
    }
    if (action === "list") {
      assertAllowedOptions(parsed, []);
      const result = await apiRequest(dependencies.fetchImpl, config, resourceListPath(type, id));
      emitJson(dependencies.stdout, type === "volume" || type === "chapter" ? summarizeTreeList(type, result) : result, compact);
      return;
    }
    if (action === "get") {
      assertAllowedOptions(parsed, []);
      emitJson(dependencies.stdout, await apiRequest(dependencies.fetchImpl, config, resourceGetPath(type, id)), compact);
      return;
    }
    if (action === "create") {
      assertAllowedOptions(parsed, ["input", "field-file"]);
      const body = await editInput(parsed, dependencies, false);
      const endpoint = resourceCreatePath(type, id);
      emitJson(dependencies.stdout, await apiRequest(dependencies.fetchImpl, config, endpoint.path, { method: endpoint.method, body }), compact);
      return;
    }
    if (action === "update") {
      assertAllowedOptions(parsed, ["input", "field-file", "change-note"]);
      const body = await editInput(parsed, dependencies, type !== "volume");
      const endpoint = resourceUpdatePath(type, id);
      emitJson(dependencies.stdout, await apiRequest(dependencies.fetchImpl, config, endpoint.path, { method: endpoint.method, body }), compact);
      return;
    }
    if (action === "history") {
      assertAllowedOptions(parsed, []);
      emitJson(dependencies.stdout, await apiRequest(dependencies.fetchImpl, config, resourceHistoryPath(type, id)), compact);
      return;
    }
    if (action === "restore") {
      assertAllowedOptions(parsed, ["version", "expected-version"]);
      const version = Number(option(parsed, "version"));
      if (!Number.isInteger(version) || version <= 0) throw new CliError("CLI_VERSION_INVALID", "请使用 --version 提供正整数版本号");
      const expectedVersion = option(parsed, "expected-version");
      const expectedVersionNo = expectedVersion === undefined ? undefined : Number(expectedVersion);
      if (expectedVersionNo !== undefined && (!Number.isInteger(expectedVersionNo) || expectedVersionNo <= 0)) {
        throw new CliError("CLI_VERSION_INVALID", "请使用 --expected-version 提供正整数版本号");
      }
      emitJson(dependencies.stdout, await apiRequest(dependencies.fetchImpl, config, resourceRestorePath(type, id), {
        method: "POST",
        body: { versionNo: version, ...(expectedVersionNo === undefined ? {} : { expectedVersionNo }) }
      }), compact);
      return;
    }
    throw new CliError("CLI_COMMAND_UNKNOWN", "未知 resource 命令");
  }

  throw new CliError("CLI_COMMAND_UNKNOWN", "未知命令；使用 --help 查看可用命令");
}

export async function runCli(args: string[], inputDependencies: CliDependencies = {}): Promise<number> {
  const dependencies: Required<CliDependencies> = {
    fetchImpl: inputDependencies.fetchImpl ?? fetch,
    serveImpl: inputDependencies.serveImpl ?? (async (options) => {
      const { installServerShutdownHandlers, startLocalServer } = await import("./server-runtime.js");
      const running = await startLocalServer(options);
      installServerShutdownHandlers(running);
      return running;
    }),
    stdin: inputDependencies.stdin ?? process.stdin,
    stdout: inputDependencies.stdout ?? process.stdout,
    stderr: inputDependencies.stderr ?? process.stderr,
    env: inputDependencies.env ?? process.env,
    cwd: inputDependencies.cwd ?? process.cwd(),
    homeDirectory: inputDependencies.homeDirectory ?? homedir()
  };
  try {
    await execute(parseCliArguments(args), dependencies);
    return 0;
  } catch (error) {
    const compact = args.includes("--compact");
    if (error instanceof CliError) {
      emitJson(dependencies.stderr, { error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } }, compact);
    } else {
      emitJson(dependencies.stderr, { error: { code: "CLI_INTERNAL_ERROR", message: error instanceof Error ? error.message : "CLI 内部错误" } }, compact);
    }
    return 1;
  }
}
