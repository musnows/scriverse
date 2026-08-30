import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

describe("远程 MCP 设置界面", () => {
  let runtime: Runtime | null = null;

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
  });

  it("提供标准 mcpServers JSON 编辑、限制说明与保存前验证反馈", async () => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "test-master-secret-with-at-least-32-characters",
      disableUserAuth: true,
      serveUi: true
    });
    const page = await request(runtime.app).get("/").expect(200);
    const application = await request(runtime.app).get("/app.js?v=remote-mcp").expect(200);
    const styles = await request(runtime.app).get("/styles.css?v=remote-mcp").expect(200);

    expect(page.text).toContain("feature=remote-mcp-v1");
    expect(application.text).toContain("远程 MCP 工具");
    expect(application.text).toContain("标准的 <code>mcpServers</code> JSON 配置");
    expect(application.text).toContain("仅支持远程 MCP 工具（SSE / Streamable HTTP）");
    expect(application.text).toContain("不支持会执行本地命令的 stdio 配置");
    expect(application.text).toContain("MCP 配置不是合法 JSON");
    expect(application.text).toContain("/ai-settings/mcp-servers");
    expect(styles.text).toContain(".remote-mcp-config-field textarea");
  });
});
