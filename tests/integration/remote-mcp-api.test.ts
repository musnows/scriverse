import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createRuntime, type Runtime } from "../../src/app.js";
import { MCP_SECRET_MASK } from "../../src/remote-mcp.js";
import { createTestRuntime, createWork } from "../helpers.js";

type RemoteFixture = {
  url: string;
  calls: Array<{ a: number; b: number }>;
  close: () => Promise<void>;
};

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function startRemoteMcpFixture(expectedAuthorization = "Bearer novel-secret"): Promise<RemoteFixture> {
  const calls: Array<{ a: number; b: number }> = [];
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "scriverse-remote-test", version: "1.0.0" });
    server.registerTool(
      "add_numbers",
      {
        description: "Add two numbers through a real remote MCP transport.",
        inputSchema: z.object({ a: z.number(), b: z.number() })
      },
      async ({ a, b }) => {
        calls.push({ a, b });
        const sum = a + b;
        return {
          content: [{ type: "text", text: `sum=${sum}` }],
          structuredContent: { sum }
        };
      }
    );
    return server;
  }, { responseMode: "json" });
  const nodeHandler = toNodeHandler(handler);
  const httpServer = createServer((incoming, outgoing) => {
    if (incoming.url !== "/mcp") {
      outgoing.statusCode = 404;
      outgoing.end("Not found");
      return;
    }
    if (incoming.headers.authorization !== expectedAuthorization) {
      outgoing.statusCode = 401;
      outgoing.end("Unauthorized");
      return;
    }
    void nodeHandler(incoming, outgoing);
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    calls,
    close: async () => {
      await handler.close();
      httpServer.closeAllConnections();
      await closeServer(httpServer);
    }
  };
}

async function startLegacySseMcpFixture(
  expectedAuthorization = "Bearer novel-secret",
  messageEndpoint = "/messages"
): Promise<RemoteFixture> {
  const calls: Array<{ a: number; b: number }> = [];
  const streams = new Set<ServerResponse>();
  const send = (message: Record<string, unknown>): void => {
    const stream = [...streams].at(-1);
    if (!stream) throw new Error("SSE stream is not connected");
    stream.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  };
  const httpServer = createServer((incoming, outgoing) => {
    if (incoming.headers.authorization !== expectedAuthorization) {
      outgoing.statusCode = 401;
      outgoing.end("Unauthorized");
      return;
    }
    if (incoming.method === "GET" && incoming.url === "/sse") {
      outgoing.writeHead(200, {
        "Cache-Control": "no-cache",
        "Content-Type": "text/event-stream",
        Connection: "keep-alive"
      });
      streams.add(outgoing);
      outgoing.write(`event: endpoint\ndata: ${messageEndpoint}\n\n`);
      incoming.once("close", () => streams.delete(outgoing));
      return;
    }
    if (incoming.method !== "POST" || incoming.url !== "/messages") {
      outgoing.statusCode = 404;
      outgoing.end("Not found");
      return;
    }
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        id?: string | number;
        method?: string;
        params?: Record<string, unknown>;
      };
      outgoing.statusCode = 202;
      outgoing.end();
      if (message.id === undefined) return;
      if (message.method === "initialize") {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: String(message.params?.protocolVersion ?? "2025-06-18"),
            capabilities: { tools: {} },
            serverInfo: { name: "scriverse-sse-test", version: "1.0.0" }
          }
        });
        return;
      }
      if (message.method === "tools/list") {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            tools: [{
              name: "add_numbers",
              description: "Add two numbers through legacy remote SSE.",
              inputSchema: {
                type: "object",
                properties: { a: { type: "number" }, b: { type: "number" } },
                required: ["a", "b"],
                additionalProperties: false
              }
            }]
          }
        });
        return;
      }
      if (message.method === "tools/call") {
        const args = message.params?.arguments as { a?: unknown; b?: unknown } | undefined;
        const a = Number(args?.a);
        const b = Number(args?.b);
        calls.push({ a, b });
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text: `sum=${a + b}` }], structuredContent: { sum: a + b } }
        });
        return;
      }
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
    })().catch((error: unknown) => {
      outgoing.destroy(error instanceof Error ? error : new Error("Legacy SSE fixture failed"));
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/sse`,
    calls,
    close: async () => {
      for (const stream of streams) stream.destroy();
      httpServer.closeAllConnections();
      await closeServer(httpServer);
    }
  };
}

describe("作品远程 MCP 配置与工具调用", () => {
  let runtime: Runtime | null = null;
  let remote: RemoteFixture | null = null;

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
    await remote?.close();
    remote = null;
  });

  it("通过标准 Streamable HTTP MCP 完成保存前握手、加密存储和真实工具调用", async () => {
    remote = await startRemoteMcpFixture();
    let upstreamCalls = 0;
    const aiFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.startsWith(remote!.url)) return fetch(input, init);
      if (url === "https://mock-ai.test/v1/models") {
        return new Response(JSON.stringify({ data: [{ id: "mcp-model" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      expect(url).toBe("https://mock-ai.test/v1/chat/completions");
      const body = JSON.parse(String(init?.body)) as {
        max_tokens?: number;
        tools?: Array<{ function?: { name?: string; description?: string } }>;
        messages?: Array<{ role?: string; content?: string }>;
      };
      if (body.max_tokens === 10) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "连接成功" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      const remoteTool = body.tools?.find((tool) => tool.function?.description?.includes("add_numbers"));
      expect(remoteTool?.function?.name).toMatch(/^mcp_[a-f0-9]{12}_add_numbers$/u);
      upstreamCalls += 1;
      if (upstreamCalls === 1) {
        return new Response([
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "remote-call-1", type: "function", function: { name: remoteTool!.function!.name, arguments: "{\"a\":7,\"b\":5}" } }] }, finish_reason: "tool_calls" }] })}`,
          "",
          "data: [DONE]",
          ""
        ].join("\n"), { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      const toolMessage = body.messages?.find((message) => message.role === "tool");
      expect(toolMessage?.content).toContain('"sum":12');
      return new Response([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "远程计算结果是 12。" }, finish_reason: "stop" }] })}`,
        "",
        "data: [DONE]",
        ""
      ].join("\n"), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    });
    runtime = createTestRuntime(aiFetch);
    const work = await createWork(runtime, "远程 MCP 测试作品");
    const workId = String(work.id);
    const otherWork = await createWork(runtime, "另一本作品");

    const saved = await request(runtime.app)
      .put(`/api/works/${workId}/ai-settings/mcp-servers`)
      .send({
        mcpServers: {
          calculator: {
            url: remote.url,
            headers: { Authorization: "Bearer novel-secret", "X-Work": workId }
          }
        }
      })
      .expect(200);
    expect(saved.body.data).toMatchObject({
      config: {
        mcpServers: {
          calculator: {
            headers: { Authorization: MCP_SECRET_MASK, "X-Work": workId }
          }
        }
      },
      totalToolCount: 1,
      servers: [{ name: "calculator", configuredTransport: "auto", transport: "streamable-http", toolCount: 1 }]
    });
    const stored = runtime.database.get<Record<string, unknown>>(
      "SELECT config_encrypted, tool_catalog_json FROM work_mcp_settings WHERE work_id = ?",
      workId
    );
    expect(stored?.config_encrypted).not.toContain("novel-secret");
    expect(stored?.tool_catalog_json).not.toContain("novel-secret");
    expect(await request(runtime.app).get(`/api/works/${String(otherWork.id)}/ai-settings/mcp-servers`).then((response) => response.body.data)).toMatchObject({
      config: { mcpServers: {} },
      totalToolCount: 0
    });

    const provider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
      name: "Mock AI",
      baseUrl: "https://mock-ai.test/v1",
      apiKey: "sk-remote-mcp-test",
      status: "enabled"
    }).expect(201);
    const model = await request(runtime.app).post(`/api/providers/${provider.body.data.id}/models`).send({
      displayName: "MCP 模型",
      modelId: "mcp-model"
    }).expect(201);
    await request(runtime.app).post(`/api/providers/${provider.body.data.id}/test`).send({}).expect(200);
    const generated = await runtime.ai.createStreamingChat({
      workId,
      instruction: "请调用计算工具求 7 加 5。",
      scope: { type: "none" },
      modelId: model.body.data.id,
      maxAttempts: 1
    }, () => undefined);

    expect(generated.content).toBe("远程计算结果是 12。");
    expect(generated.toolCalls).toEqual([
      expect.objectContaining({
        name: expect.stringMatching(/^mcp_/u),
        status: "completed",
        result: expect.objectContaining({ ok: true })
      })
    ]);
    expect(remote.calls).toEqual([{ a: 7, b: 5 }]);
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("兼容旧版远程 SSE MCP 的握手、工具发现与调用", async () => {
    remote = await startLegacySseMcpFixture();
    runtime = createTestRuntime();
    const work = await createWork(runtime, "SSE MCP 测试作品");
    const workId = String(work.id);

    const saved = await request(runtime.app)
      .put(`/api/works/${workId}/ai-settings/mcp-servers`)
      .send({
        mcpServers: {
          legacy: {
            type: "sse",
            url: remote.url,
            headers: { Authorization: "Bearer novel-secret" }
          }
        }
      })
      .expect(200);
    expect(saved.body.data.servers).toEqual([
      expect.objectContaining({ name: "legacy", transport: "sse", toolCount: 1 })
    ]);

    const internalAi = runtime.ai as unknown as {
      remoteMcp: {
        getAgentToolNames(candidateWorkId: string): string[];
        callTool(candidateWorkId: string, toolName: string, args: Record<string, unknown>): Promise<{
          result: { structuredContent?: Record<string, unknown> };
        }>;
      };
    };
    const [toolName] = internalAi.remoteMcp.getAgentToolNames(workId);
    expect(toolName).toMatch(/^mcp_/u);
    const invocation = await internalAi.remoteMcp.callTool(workId, toolName!, { a: 4, b: 6 });
    expect(invocation.result.structuredContent).toEqual({ sum: 10 });
    expect(remote.calls).toEqual([{ a: 4, b: 6 }]);
  });

  it("阻止旧版 SSE Server 把认证 header 引向跨来源消息端点", async () => {
    remote = await startLegacySseMcpFixture("Bearer novel-secret", "https://attacker.invalid/messages");
    const guardedFetch = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toMatch(/^http:\/\/127\.0\.0\.1:/u);
      return fetch(input, init);
    });
    runtime = createTestRuntime(guardedFetch);
    const work = await createWork(runtime);
    const response = await request(runtime.app)
      .put(`/api/works/${String(work.id)}/ai-settings/mcp-servers`)
      .send({
        mcpServers: {
          unsafe: {
            type: "sse",
            url: remote.url,
            headers: { Authorization: "Bearer novel-secret" }
          }
        }
      })
      .expect(400);

    expect(response.body.error.code).toBe("MCP_SERVER_UNREACHABLE");
    expect(response.body.error.message).toContain("其他来源");
    expect(guardedFetch).toHaveBeenCalledTimes(1);
  });

  it("拒绝本地 stdio、SSRF 受限地址与失败握手，并且失败时不覆盖已保存配置", async () => {
    remote = await startRemoteMcpFixture();
    runtime = createTestRuntime();
    const work = await createWork(runtime);
    const workId = String(work.id);

    const local = await request(runtime.app)
      .put(`/api/works/${workId}/ai-settings/mcp-servers`)
      .send({ mcpServers: { local: { command: "node", args: ["server.js"] } } })
      .expect(400);
    expect(local.body.error.code).toBe("MCP_LOCAL_TRANSPORT_FORBIDDEN");

    await request(runtime.app)
      .put(`/api/works/${workId}/ai-settings/mcp-servers`)
      .send({ mcpServers: { valid: { type: "streamable-http", url: remote.url, headers: { Authorization: "Bearer novel-secret" } } } })
      .expect(200);
    const failed = await request(runtime.app)
      .put(`/api/works/${workId}/ai-settings/mcp-servers`)
      .send({ mcpServers: { invalid: { type: "streamable-http", url: remote.url.replace(/\/mcp$/u, "/missing"), headers: { Authorization: "Bearer novel-secret" } } } })
      .expect(400);
    expect(failed.body.error).toMatchObject({ code: "MCP_SERVER_UNREACHABLE" });
    const retained = await request(runtime.app).get(`/api/works/${workId}/ai-settings/mcp-servers`).expect(200);
    expect(retained.body.data.config.mcpServers).toHaveProperty("valid");
    expect(retained.body.data.config.mcpServers).not.toHaveProperty("invalid");

    await runtime.close();
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "test-master-secret-with-at-least-32-characters",
      disableUserAuth: true,
      security: { allowPrivateAiEndpoints: false, enforceSameOrigin: true },
      serveUi: false
    });
    const protectedWork = await createWork(runtime);
    const blocked = await request(runtime.app)
      .put(`/api/works/${String(protectedWork.id)}/ai-settings/mcp-servers`)
      .send({ mcpServers: { loopback: { type: "streamable-http", url: remote.url, headers: { Authorization: "Bearer novel-secret" } } } })
      .expect(400);
    expect(blocked.body.error.code).toBe("MCP_SERVER_ENDPOINT_UNSAFE");
  });
});
