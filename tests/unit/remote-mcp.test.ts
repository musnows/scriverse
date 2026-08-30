import { describe, expect, it } from "vitest";
import { MCP_SECRET_MASK, parseRemoteMcpConfiguration } from "../../src/remote-mcp.js";

describe("parseRemoteMcpConfiguration", () => {
  it("接受 SSE、Streamable HTTP 与自动探测的远程 mcpServers 配置", () => {
    const configuration = parseRemoteMcpConfiguration({
      mcpServers: {
        auto: { url: "https://mcp.example.com/mcp" },
        events: { type: "sse", url: "https://mcp.example.com/sse" },
        modern: {
          transport: "streamableHttp",
          url: "https://mcp.example.com/mcp?tenant=novel",
          headers: { Authorization: "Bearer secret", "X-Workspace": "novel" }
        }
      }
    });

    expect(configuration.mcpServers.auto!.transport).toBe("auto");
    expect(configuration.mcpServers.events!.transport).toBe("sse");
    expect(configuration.mcpServers.modern).toMatchObject({
      transport: "streamable-http",
      headers: { Authorization: "Bearer secret", "X-Workspace": "novel" }
    });
  });

  it("明确拒绝任何本地 stdio 或本地地址格式", () => {
    expect(() => parseRemoteMcpConfiguration({
      mcpServers: { local: { command: "node", args: ["server.js"] } }
    })).toThrow(expect.objectContaining({ code: "MCP_LOCAL_TRANSPORT_FORBIDDEN" }));
    expect(() => parseRemoteMcpConfiguration({
      mcpServers: { local: { url: "file:///opt/server.js" } }
    })).toThrow(expect.objectContaining({ code: "MCP_REMOTE_TRANSPORT_REQUIRED" }));
  });

  it("拒绝覆盖协议 header 和相互冲突的传输类型", () => {
    expect(() => parseRemoteMcpConfiguration({
      mcpServers: {
        bad: {
          url: "https://mcp.example.com/mcp",
          headers: { "Mcp-Session-Id": "forged" }
        }
      }
    })).toThrow(expect.objectContaining({ code: "MCP_HEADER_FORBIDDEN" }));
    expect(() => parseRemoteMcpConfiguration({
      mcpServers: {
        bad: {
          url: "https://mcp.example.com/mcp",
          type: "sse",
          transport: "http"
        }
      }
    })).toThrow(expect.objectContaining({ code: "MCP_TRANSPORT_CONFLICT" }));
  });

  it("只允许已有敏感 header 使用页面掩码保留原值", () => {
    const previous = parseRemoteMcpConfiguration({
      mcpServers: {
        remote: {
          url: "https://mcp.example.com/mcp",
          headers: { Authorization: "Bearer original", "X-Workspace": "old" }
        }
      }
    });
    const next = parseRemoteMcpConfiguration({
      mcpServers: {
        remote: {
          url: "https://mcp.example.com/mcp",
          headers: { Authorization: MCP_SECRET_MASK, "X-Workspace": "new" }
        }
      }
    }, previous);

    expect(next.mcpServers.remote!.headers).toEqual({ Authorization: "Bearer original", "X-Workspace": "new" });
    expect(() => parseRemoteMcpConfiguration({
      mcpServers: {
        remote: {
          url: "https://mcp.example.com/mcp",
          headers: { Authorization: MCP_SECRET_MASK }
        }
      }
    })).toThrow(expect.objectContaining({ code: "MCP_SECRET_REQUIRED" }));
    expect(parseRemoteMcpConfiguration({
      mcpServers: {
        remote: {
          url: "https://mcp.example.com/mcp",
          headers: { Authorization: MCP_SECRET_MASK }
        }
      }
    }, undefined, true).mcpServers.remote!.headers.Authorization).toBe(MCP_SECRET_MASK);
  });
});
