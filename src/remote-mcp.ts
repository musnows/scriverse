import { createHash } from "node:crypto";
import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type FetchLike,
  type Transport
} from "@modelcontextprotocol/client";
import { z } from "zod";
import type { CredentialVault } from "./credential-vault.js";
import type { Database, Row } from "./database.js";
import { AppError } from "./errors.js";
import { logger } from "./logger.js";
import { fetchSafeAiEndpoint } from "./security.js";
import { APP_VERSION } from "./version.js";

export const MCP_SECRET_MASK = "********";

const MAXIMUM_MCP_SERVERS = 20;
const MAXIMUM_MCP_HEADERS = 64;
const MAXIMUM_MCP_TOOLS = 200;
const MAXIMUM_MCP_TOOLS_PER_SERVER = 100;
const MAXIMUM_MCP_TOOL_PAGES = 20;
const MAXIMUM_MCP_CONFIG_CHARS = 256_000;
const MAXIMUM_MCP_TOOL_SCHEMA_CHARS = 64_000;
const MCP_CONNECT_TIMEOUT_MS = 12_000;
const MCP_TOOL_CALL_TIMEOUT_MS = 60_000;

const forbiddenLocalServerFields = ["command", "args", "env", "cwd"] as const;
const forbiddenHeaderNames = new Set([
  "accept",
  "connection",
  "content-length",
  "content-type",
  "host",
  "mcp-protocol-version",
  "mcp-session-id",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

const mcpTransportSchema = z.enum(["auto", "sse", "streamable-http", "streamableHttp", "stream-http", "http"]);
const mcpServerSchema = z.object({
  url: z.string().trim().min(1).max(2_048),
  type: mcpTransportSchema.optional(),
  transport: mcpTransportSchema.optional(),
  headers: z.record(z.string().min(1).max(200), z.string().max(4_096)).optional()
}).strict();
const mcpConfigurationSchema = z.object({
  mcpServers: z.record(z.string().trim().min(1).max(100), mcpServerSchema)
}).strict();

const mcpToolCatalogEntrySchema = z.object({
  serverName: z.string().min(1).max(100),
  serverToolName: z.string().min(1).max(300),
  modelToolName: z.string().min(1).max(64),
  description: z.string().max(4_000),
  inputSchema: z.record(z.string(), z.unknown()),
  transport: z.enum(["sse", "streamable-http"]),
  serverVersion: z.string().max(300)
}).strict();
const mcpToolCatalogSchema = z.array(mcpToolCatalogEntrySchema).max(MAXIMUM_MCP_TOOLS);

type McpTransport = "auto" | "sse" | "streamable-http";

export type RemoteMcpServerConfiguration = {
  url: string;
  transport: McpTransport;
  headers: Record<string, string>;
};

export type RemoteMcpConfiguration = {
  mcpServers: Record<string, RemoteMcpServerConfiguration>;
};

export type RemoteMcpToolCatalogEntry = z.infer<typeof mcpToolCatalogEntrySchema>;

export type PreparedRemoteMcpSettings = {
  configuration: RemoteMcpConfiguration;
  catalog: RemoteMcpToolCatalogEntry[];
};

export type RemoteMcpInvocation = {
  catalog: RemoteMcpToolCatalogEntry;
  result: CallToolResult;
};

type RemoteMcpSettingsRow = Row & {
  config_encrypted: string;
  config_iv: string;
  config_tag: string;
  tool_catalog_json: string;
  updated_at: string;
};

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function normalizedTransport(value: string | undefined): McpTransport {
  if (!value || value === "auto") return "auto";
  return value === "sse" ? "sse" : "streamable-http";
}

function isSensitiveHeader(name: string): boolean {
  const normalized = name.toLocaleLowerCase("en-US");
  return normalized === "authorization"
    || normalized === "proxy-authorization"
    || normalized === "cookie"
    || normalized.includes("token")
    || normalized.includes("secret")
    || /(?:^|[-_])api[-_]?key$/u.test(normalized)
    || /(?:^|[-_])key$/u.test(normalized);
}

function configurationForStorage(configuration: RemoteMcpConfiguration): Record<string, unknown> {
  return {
    mcpServers: Object.fromEntries(Object.entries(configuration.mcpServers).map(([serverName, server]) => [
      serverName,
      {
        ...(server.transport === "auto" ? {} : { type: server.transport }),
        url: server.url,
        ...(Object.keys(server.headers).length > 0 ? { headers: server.headers } : {})
      }
    ]))
  };
}

function redactedConfiguration(configuration: RemoteMcpConfiguration): Record<string, unknown> {
  return {
    mcpServers: Object.fromEntries(Object.entries(configuration.mcpServers).map(([serverName, server]) => [
      serverName,
      {
        ...(server.transport === "auto" ? {} : { type: server.transport }),
        url: server.url,
        ...(Object.keys(server.headers).length > 0
          ? {
              headers: Object.fromEntries(Object.entries(server.headers).map(([name, value]) => [
                name,
                isSensitiveHeader(name) && value ? MCP_SECRET_MASK : value
              ]))
            }
          : {})
      }
    ]))
  };
}

function configurationIssueMessage(error: z.ZodError): string {
  return error.issues
    .slice(0, 6)
    .map((issue) => `${issue.path.join(".") || "配置"}：${issue.message}`)
    .join("；");
}

export function parseRemoteMcpConfiguration(
  input: unknown,
  previous?: RemoteMcpConfiguration,
  allowLiteralSecretMask = false
): RemoteMcpConfiguration {
  const root = recordValue(input);
  const rawServers = recordValue(root?.mcpServers);
  if (rawServers) {
    for (const [serverName, rawServer] of Object.entries(rawServers)) {
      const server = recordValue(rawServer);
      if (!server) continue;
      const localField = forbiddenLocalServerFields.find((field) => Object.hasOwn(server, field));
      if (localField) {
        throw new AppError(
          400,
          "MCP_LOCAL_TRANSPORT_FORBIDDEN",
          `MCP Server“${serverName}”包含本地 ${localField} 配置；叙界只支持远程 SSE 或 Streamable HTTP MCP Server`
        );
      }
    }
  }
  const parsed = mcpConfigurationSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError(
      400,
      "MCP_CONFIG_INVALID",
      `MCP 配置不符合 mcpServers 规范：${configurationIssueMessage(parsed.error)}`
    );
  }
  const entries = Object.entries(parsed.data.mcpServers);
  if (entries.length > MAXIMUM_MCP_SERVERS) {
    throw new AppError(400, "MCP_SERVER_LIMIT_EXCEEDED", `每部作品最多配置 ${MAXIMUM_MCP_SERVERS} 个 MCP Server`);
  }
  const normalizedServers: Record<string, RemoteMcpServerConfiguration> = {};
  for (const [serverName, server] of entries) {
    if (server.type && server.transport && normalizedTransport(server.type) !== normalizedTransport(server.transport)) {
      throw new AppError(400, "MCP_TRANSPORT_CONFLICT", `MCP Server“${serverName}”的 type 与 transport 配置冲突`);
    }
    let endpoint: URL;
    try {
      endpoint = new URL(server.url);
    } catch {
      throw new AppError(400, "MCP_SERVER_URL_INVALID", `MCP Server“${serverName}”的 url 不是有效地址`);
    }
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
      throw new AppError(400, "MCP_REMOTE_TRANSPORT_REQUIRED", `MCP Server“${serverName}”必须使用无内嵌凭据的 HTTP(S) 远程地址`);
    }
    const headers = server.headers ?? {};
    if (Object.keys(headers).length > MAXIMUM_MCP_HEADERS) {
      throw new AppError(400, "MCP_HEADER_LIMIT_EXCEEDED", `MCP Server“${serverName}”的 header 数量不能超过 ${MAXIMUM_MCP_HEADERS}`);
    }
    const normalizedHeaderNames = new Set<string>();
    const resolvedHeaders: Record<string, string> = {};
    for (const [name, configuredValue] of Object.entries(headers)) {
      const normalizedName = name.toLocaleLowerCase("en-US");
      if (normalizedHeaderNames.has(normalizedName)) {
        throw new AppError(400, "MCP_HEADER_DUPLICATED", `MCP Server“${serverName}”包含重复 header“${name}”`);
      }
      normalizedHeaderNames.add(normalizedName);
      if (forbiddenHeaderNames.has(normalizedName)) {
        throw new AppError(400, "MCP_HEADER_FORBIDDEN", `MCP Server“${serverName}”不能覆盖协议 header“${name}”`);
      }
      try {
        new Headers([[name, configuredValue]]);
      } catch {
        throw new AppError(400, "MCP_HEADER_INVALID", `MCP Server“${serverName}”的 header“${name}”无效`);
      }
      if (configuredValue === MCP_SECRET_MASK && isSensitiveHeader(name) && !allowLiteralSecretMask) {
        const previousHeader = Object.entries(previous?.mcpServers[serverName]?.headers ?? {})
          .find(([candidate]) => candidate.toLocaleLowerCase("en-US") === normalizedName);
        if (!previousHeader) {
          throw new AppError(400, "MCP_SECRET_REQUIRED", `MCP Server“${serverName}”的敏感 header“${name}”需要填写真实值`);
        }
        resolvedHeaders[name] = previousHeader[1];
      } else {
        resolvedHeaders[name] = configuredValue;
      }
    }
    normalizedServers[serverName] = {
      url: endpoint.toString(),
      transport: normalizedTransport(server.type ?? server.transport),
      headers: resolvedHeaders
    };
  }
  const configuration = { mcpServers: normalizedServers };
  if (JSON.stringify(configurationForStorage(configuration)).length > MAXIMUM_MCP_CONFIG_CHARS) {
    throw new AppError(400, "MCP_CONFIG_TOO_LARGE", "MCP 配置内容过大");
  }
  return configuration;
}

function modelToolName(serverName: string, toolName: string): string {
  const suffix = toolName
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9_-]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 35) || "tool";
  const digest = createHash("sha256").update(`${serverName}\0${toolName}`).digest("hex").slice(0, 12);
  return `mcp_${digest}_${suffix}`.slice(0, 64);
}

function safeErrorMessage(error: unknown, server: RemoteMcpServerConfiguration): string {
  let message = error instanceof Error ? error.message : "连接失败";
  if (/origin does not match|cross[- ]origin/iu.test(message)) {
    return "MCP Server 尝试把消息端点指向其他来源，已阻止连接";
  }
  for (const value of Object.values(server.headers)) {
    if (value) message = message.split(value).join(MCP_SECRET_MASK);
  }
  return message.replace(/[\r\n]+/gu, " ").slice(0, 300) || "连接失败";
}

function normalizedInputSchema(serverName: string, toolName: string, value: unknown): Record<string, unknown> {
  const schema = recordValue(value);
  if (!schema || schema.type !== "object") {
    throw new AppError(
      400,
      "MCP_TOOL_SCHEMA_INVALID",
      `MCP Server“${serverName}”的工具“${toolName}”没有有效的 object inputSchema`
    );
  }
  if (JSON.stringify(schema).length > MAXIMUM_MCP_TOOL_SCHEMA_CHARS) {
    throw new AppError(400, "MCP_TOOL_SCHEMA_TOO_LARGE", `MCP Server“${serverName}”的工具“${toolName}”输入规范过大`);
  }
  return schema;
}

function parseCatalog(value: unknown): RemoteMcpToolCatalogEntry[] {
  const parsed = mcpToolCatalogSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

function parseStoredCatalog(value: string): RemoteMcpToolCatalogEntry[] {
  try {
    return parseCatalog(JSON.parse(value) as unknown);
  } catch {
    return [];
  }
}

export class RemoteMcpManager {
  constructor(
    private readonly database: Database,
    private readonly vault: CredentialVault,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly validateOutboundUrl?: (url: string) => Promise<readonly { address: string; family: 4 | 6 }[] | void>
  ) {}

  private settingsRow(workId: string): RemoteMcpSettingsRow | undefined {
    return this.database.get<RemoteMcpSettingsRow>("SELECT * FROM work_mcp_settings WHERE work_id = ?", workId);
  }

  private decryptConfiguration(row: RemoteMcpSettingsRow): RemoteMcpConfiguration {
    try {
      const plaintext = this.vault.decrypt({
        encrypted: row.config_encrypted,
        iv: row.config_iv,
        tag: row.config_tag
      });
      return parseRemoteMcpConfiguration(JSON.parse(plaintext) as unknown, undefined, true);
    } catch (error) {
      logger.error("mcp.configuration.decrypt_failed", {
        error: error instanceof Error ? error.name : "UnknownError"
      });
      throw new AppError(500, "MCP_CONFIG_UNREADABLE", "当前作品的 MCP 配置无法读取，请重新保存配置");
    }
  }

  private loadConfiguration(workId: string): RemoteMcpConfiguration {
    const row = this.settingsRow(workId);
    return row ? this.decryptConfiguration(row) : { mcpServers: {} };
  }

  getSettings(workId: string): Record<string, unknown> {
    const row = this.settingsRow(workId);
    if (!row) {
      return {
        config: { mcpServers: {} },
        servers: [],
        totalToolCount: 0,
        updatedAt: null
      };
    }
    const configuration = this.decryptConfiguration(row);
    const catalog = parseStoredCatalog(row.tool_catalog_json);
    return {
      config: redactedConfiguration(configuration),
      servers: Object.entries(configuration.mcpServers).map(([serverName, server]) => {
        const tools = catalog.filter((tool) => tool.serverName === serverName);
        return {
          name: serverName,
          url: server.url,
          configuredTransport: server.transport,
          transport: tools[0]?.transport ?? server.transport,
          toolCount: tools.length,
          serverVersion: tools[0]?.serverVersion ?? ""
        };
      }),
      totalToolCount: catalog.length,
      updatedAt: row.updated_at
    };
  }

  private secureFetch(server: RemoteMcpServerConfiguration): FetchLike {
    return async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (new URL(url).origin !== new URL(server.url).origin) {
        throw new AppError(502, "MCP_CROSS_ORIGIN_REQUEST_BLOCKED", "MCP Server 尝试把请求或认证信息发送到其他来源，已阻止连接");
      }
      const headers = new Headers();
      new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
      Object.entries(server.headers).forEach(([name, value]) => headers.set(name, value));
      const method = init?.method ?? "GET";
      const requestInit: RequestInit = {
        ...init,
        method,
        headers,
        body: ["GET", "HEAD"].includes(method.toUpperCase()) ? undefined : init?.body
      };
      return fetchSafeAiEndpoint(this.fetchImpl, url, requestInit, this.validateOutboundUrl);
    };
  }

  private async connect(
    server: RemoteMcpServerConfiguration,
    preferredTransport?: Exclude<McpTransport, "auto">,
    signal?: AbortSignal
  ): Promise<{ client: Client; transport: Exclude<McpTransport, "auto"> }> {
    const candidates: Array<Exclude<McpTransport, "auto">> = preferredTransport
      ? [preferredTransport]
      : server.transport === "auto"
        ? ["streamable-http", "sse"]
        : [server.transport];
    let lastError: unknown;
    for (const transportType of candidates) {
      const client = new Client(
        { name: "scriverse", version: APP_VERSION },
        { versionNegotiation: { mode: "auto" } }
      );
      const secureFetch = this.secureFetch(server);
      const requestInit: RequestInit = { headers: server.headers };
      const transport: Transport = transportType === "sse"
        ? new SSEClientTransport(new URL(server.url), {
            fetch: secureFetch,
            eventSourceInit: { fetch: secureFetch },
            requestInit
          })
        : new StreamableHTTPClientTransport(new URL(server.url), {
            fetch: secureFetch,
            requestInit,
            reconnectionOptions: {
              initialReconnectionDelay: 250,
              maxReconnectionDelay: 1_000,
              reconnectionDelayGrowFactor: 1.5,
              maxRetries: 1
            }
          });
      try {
        await client.connect(transport, { timeout: MCP_CONNECT_TIMEOUT_MS, signal });
        return { client, transport: transportType };
      } catch (error) {
        lastError = error;
        await client.close().catch(() => undefined);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("MCP connection failed");
  }

  private async discoverServerTools(
    serverName: string,
    server: RemoteMcpServerConfiguration
  ): Promise<RemoteMcpToolCatalogEntry[]> {
    if (this.validateOutboundUrl) {
      try {
        await this.validateOutboundUrl(server.url);
      } catch (error) {
        throw new AppError(
          400,
          "MCP_SERVER_ENDPOINT_UNSAFE",
          `MCP Server“${serverName}”地址不安全：${safeErrorMessage(error, server)}`
        );
      }
    }
    let connected: Awaited<ReturnType<RemoteMcpManager["connect"]>>;
    try {
      connected = await this.connect(server);
    } catch (error) {
      throw new AppError(
        400,
        "MCP_SERVER_UNREACHABLE",
        `MCP Server“${serverName}”无法连接或未通过 MCP 协议校验：${safeErrorMessage(error, server)}`
      );
    }
    try {
      const tools: RemoteMcpToolCatalogEntry[] = [];
      let cursor: string | undefined;
      let pageCount = 0;
      do {
        pageCount += 1;
        if (pageCount > MAXIMUM_MCP_TOOL_PAGES) {
          throw new AppError(400, "MCP_TOOL_PAGE_LIMIT_EXCEEDED", `MCP Server“${serverName}”返回了过多工具分页`);
        }
        const page = await connected.client.listTools(cursor ? { cursor } : undefined, { timeout: MCP_CONNECT_TIMEOUT_MS });
        for (const tool of page.tools) {
          if (!tool.name || tool.name.length > 300) {
            throw new AppError(400, "MCP_TOOL_NAME_INVALID", `MCP Server“${serverName}”返回了无效工具名称`);
          }
          if (tools.length >= MAXIMUM_MCP_TOOLS_PER_SERVER) {
            throw new AppError(400, "MCP_TOOL_LIMIT_EXCEEDED", `MCP Server“${serverName}”最多可暴露 ${MAXIMUM_MCP_TOOLS_PER_SERVER} 个工具`);
          }
          tools.push({
            serverName,
            serverToolName: tool.name,
            modelToolName: modelToolName(serverName, tool.name),
            description: String(tool.description ?? "").slice(0, 4_000),
            inputSchema: normalizedInputSchema(serverName, tool.name, tool.inputSchema),
            transport: connected.transport,
            serverVersion: [connected.client.getServerVersion()?.name, connected.client.getServerVersion()?.version]
              .filter(Boolean)
              .join(" ")
              .slice(0, 300)
          });
        }
        cursor = page.nextCursor;
      } while (cursor);
      if (tools.length === 0) {
        throw new AppError(400, "MCP_SERVER_NO_TOOLS", `MCP Server“${serverName}”连接成功，但没有提供可调用工具`);
      }
      return tools;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        400,
        "MCP_SERVER_TOOL_DISCOVERY_FAILED",
        `MCP Server“${serverName}”无法读取工具列表：${safeErrorMessage(error, server)}`
      );
    } finally {
      await connected.client.close().catch(() => undefined);
    }
  }

  async prepareSettings(workId: string, input: unknown): Promise<PreparedRemoteMcpSettings> {
    const previous = this.settingsRow(workId) ? this.loadConfiguration(workId) : undefined;
    const configuration = parseRemoteMcpConfiguration(input, previous);
    const catalog: RemoteMcpToolCatalogEntry[] = [];
    for (const [serverName, server] of Object.entries(configuration.mcpServers)) {
      const discovered = await this.discoverServerTools(serverName, server);
      if (catalog.length + discovered.length > MAXIMUM_MCP_TOOLS) {
        throw new AppError(400, "MCP_TOOL_LIMIT_EXCEEDED", `每部作品最多可暴露 ${MAXIMUM_MCP_TOOLS} 个远程 MCP 工具`);
      }
      catalog.push(...discovered);
    }
    return { configuration, catalog };
  }

  persistSettings(workId: string, prepared: PreparedRemoteMcpSettings, updatedAt: string): void {
    if (Object.keys(prepared.configuration.mcpServers).length === 0) {
      this.database.run("DELETE FROM work_mcp_settings WHERE work_id = ?", workId);
      return;
    }
    const encrypted = this.vault.encrypt(JSON.stringify(configurationForStorage(prepared.configuration)));
    this.database.run(
      `INSERT INTO work_mcp_settings (
         work_id, config_encrypted, config_iv, config_tag, tool_catalog_json, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(work_id) DO UPDATE SET
         config_encrypted = excluded.config_encrypted,
         config_iv = excluded.config_iv,
         config_tag = excluded.config_tag,
         tool_catalog_json = excluded.tool_catalog_json,
         updated_at = excluded.updated_at`,
      workId,
      encrypted.encrypted,
      encrypted.iv,
      encrypted.tag,
      JSON.stringify(prepared.catalog),
      updatedAt
    );
  }

  getAgentToolDefinitions(workId: string): Record<string, unknown>[] {
    const row = this.settingsRow(workId);
    if (!row) return [];
    const catalog = parseStoredCatalog(row.tool_catalog_json);
    return catalog.map((tool) => ({
      type: "function",
      function: {
        name: tool.modelToolName,
        description: [
          `远程 MCP Server“${tool.serverName}”的工具“${tool.serverToolName}”。`,
          tool.description
        ].filter(Boolean).join(" ").slice(0, 4_000),
        parameters: tool.inputSchema
      }
    }));
  }

  getAgentToolNames(workId: string): string[] {
    return this.getAgentToolDefinitions(workId).flatMap((definition) => {
      const fn = recordValue(definition.function);
      return typeof fn?.name === "string" ? [fn.name] : [];
    });
  }

  async callTool(
    workId: string,
    modelToolNameValue: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<RemoteMcpInvocation> {
    const row = this.settingsRow(workId);
    if (!row) throw new AppError(409, "MCP_TOOL_NOT_CONFIGURED", "当前作品没有配置远程 MCP 工具");
    const catalog = parseStoredCatalog(row.tool_catalog_json);
    const tool = catalog.find((item) => item.modelToolName === modelToolNameValue);
    if (!tool) throw new AppError(409, "MCP_TOOL_NOT_CONFIGURED", "远程 MCP 工具已经不可用，请重新打开对话");
    const configuration = this.decryptConfiguration(row);
    const server = configuration.mcpServers[tool.serverName];
    if (!server) throw new AppError(409, "MCP_SERVER_NOT_CONFIGURED", "远程 MCP Server 已从作品配置中移除");
    let connected: Awaited<ReturnType<RemoteMcpManager["connect"]>>;
    try {
      connected = await this.connect(server, tool.transport, signal);
    } catch (error) {
      throw new AppError(
        502,
        "MCP_SERVER_UNREACHABLE",
        `MCP Server“${tool.serverName}”无法连接：${safeErrorMessage(error, server)}`
      );
    }
    try {
      const result = await connected.client.callTool(
        { name: tool.serverToolName, arguments: args },
        { timeout: MCP_TOOL_CALL_TIMEOUT_MS, signal }
      );
      return { catalog: tool, result };
    } catch (error) {
      throw new AppError(
        502,
        "MCP_TOOL_CALL_FAILED",
        `MCP 工具“${tool.serverName}/${tool.serverToolName}”调用失败：${safeErrorMessage(error, server)}`
      );
    } finally {
      await connected.client.close().catch(() => undefined);
    }
  }
}
