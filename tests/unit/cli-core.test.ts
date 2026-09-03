import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cliResourceDefinitions, cliResourceTypes, cliWorkDefinition } from "../../src/cli-contract.js";
import { parseCliArguments, runCli } from "../../src/cli-core.js";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "scriverse-cli-"));
  roots.push(root);
  return root;
}

function outputCapture(): { stream: { write: (chunk: string) => void }; text: () => string } {
  let value = "";
  return {
    stream: { write: (chunk) => { value += chunk; } },
    text: () => value
  };
}

function jsonFile(root: string, name: string, value: Record<string, unknown>): string {
  const path = join(root, name);
  writeFileSync(path, `${JSON.stringify(value)}\n`);
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Scriverse CLI 核心", () => {
  it("解析重复选项、等号选项和位置参数", () => {
    const parsed = parseCliArguments([
      "resource", "update", "chapter", "chapter-1",
      "--input=-",
      "--field-file", "content=chapter.txt",
      "--field-file=title=title.txt",
      "--compact"
    ]);
    expect(parsed.positionals).toEqual(["resource", "update", "chapter", "chapter-1"]);
    expect(parsed.options.get("input")).toEqual(["-"]);
    expect(parsed.options.get("field-file")).toEqual(["content=chapter.txt", "title=title.txt"]);
    expect(parsed.options.get("compact")).toEqual(["true"]);
  });

  it("允许连接局域网 HTTP 服务端", async () => {
    const root = temporaryRoot();
    const path = join(root, "cli.json");
    const stdout = outputCapture();
    const stderr = outputCapture();

    expect(await runCli([
      "connect", "http://192.168.1.10:13210", "--config", path
    ], { stdout: stdout.stream, stderr: stderr.stream })).toBe(0);
    expect(JSON.parse(stdout.text())).toMatchObject({
      defaultServer: "http://192.168.1.10:13210",
      authenticated: false
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      defaultServer: "http://192.168.1.10:13210"
    });
    const warning = stderr.text();
    expect(JSON.parse(warning)).toMatchObject({
      warning: {
        code: "CLI_SERVER_HTTP_WARNING",
        server: "http://192.168.1.10:13210"
      }
    });

    expect(await runCli([
      "connect", "http://192.168.1.10:13210", "--config", path
    ], { stdout: outputCapture().stream, stderr: stderr.stream })).toBe(0);
    expect(stderr.text()).toBe(warning);
  });

  it("资源契约只开放受控读写动作且不包含删除", () => {
    expect(cliResourceTypes).toHaveLength(12);
    expect(cliWorkDefinition.actions).not.toContain("delete");
    expect(cliWorkDefinition.actions).toEqual(expect.arrayContaining(["history", "restore"]));
    for (const type of cliResourceTypes) {
      expect(cliResourceDefinitions[type].actions).not.toContain("delete");
      expect(cliResourceDefinitions[type].create.example).toBeTruthy();
      expect(cliResourceDefinitions[type].update.example).toBeTruthy();
    }
    expect(cliResourceDefinitions.race.create.properties.parentRaceId).toBe("父种族 ID 或 null");
    expect(cliResourceDefinitions.race.update.properties.parentRaceId).toBe("新父种族 ID 或 null");
    expect(cliResourceDefinitions.character.create.properties.gender).toContain("male | female | none | unknown");
    expect(cliResourceDefinitions.character.update.properties.gender).toContain("male | female | none | unknown");
    expect(cliResourceDefinitions.draft.create.required).toEqual(["draftType", "title"]);
    expect(cliResourceDefinitions.draft.create.properties.draftType).toBe("prose | setting");
    expect(cliResourceDefinitions.draft.create.properties.volumeId).toContain("分卷 ID");
    expect(cliResourceDefinitions.volume.create.properties.storyOrder).toContain("故事顺序");
    expect(cliResourceDefinitions.volume.update.properties.storyOrder).toContain("故事顺序");
    expect(cliResourceDefinitions.draft.actions).toEqual(["list", "get", "create", "update", "history", "restore"]);
  });

  it("登录仅在校验 API Key 后写入 0600 配置，并可查询与退出", async () => {
    const root = temporaryRoot();
    const path = join(root, "cli.json");
    const stdout = outputCapture();
    const stderr = outputCapture();
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer scrv_test_key");
      return new Response(JSON.stringify({
        data: {
          authenticated: true,
          apiKeyPrefix: "scrv_test",
          user: { userId: "user-1", username: "writer", displayName: "Writer", role: "user" }
        }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    expect(await runCli([
      "auth", "login", "--server", "http://127.0.0.1:13210", "--api-key", "scrv_test_key", "--config", path
    ], { fetchImpl, stdout: stdout.stream, stderr: stderr.stream })).toBe(0);
    const warning = stderr.text();
    expect(JSON.parse(warning)).toMatchObject({
      warning: {
        code: "CLI_SERVER_HTTP_WARNING",
        server: "http://127.0.0.1:13210"
      }
    });
    expect(JSON.parse(stdout.text())).toMatchObject({ authenticated: true, apiKeyPrefix: "scrv_test" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      version: 2,
      defaultServer: "http://127.0.0.1:13210",
      servers: {
        "http://127.0.0.1:13210": { apiKey: "scrv_test_key", user: { userId: "user-1" } }
      }
    });

    const statusOutput = outputCapture();
    expect(await runCli(["auth", "status", "--config", path], {
      fetchImpl,
      stdout: statusOutput.stream,
      stderr: stderr.stream
    })).toBe(0);
    expect(JSON.parse(statusOutput.text())).toMatchObject({ authenticated: true, server: "http://127.0.0.1:13210" });

    const logoutOutput = outputCapture();
    expect(await runCli(["auth", "logout", "--config", path], {
      stdout: logoutOutput.stream,
      stderr: stderr.stream
    })).toBe(0);
    expect(JSON.parse(logoutOutput.text())).toMatchObject({ authenticated: false });
    expect(stderr.text()).toBe(warning);
  });

  it("保存默认服务器，并允许子命令临时覆盖到已登录的其他服务器", async () => {
    const root = temporaryRoot();
    const path = join(root, "cli.json");
    const stderr = outputCapture();
    const connectOutput = outputCapture();

    expect(await runCli(["connect", "https://default.example.com", "--config", path], {
      stdout: connectOutput.stream,
      stderr: stderr.stream
    })).toBe(0);
    expect(JSON.parse(connectOutput.text())).toMatchObject({
      defaultServer: "https://default.example.com",
      authenticated: false
    });

    const loginOutput = outputCapture();
    const loginFetch = (async () => new Response(JSON.stringify({
      data: {
        authenticated: true,
        apiKeyPrefix: "scrv_ove",
        user: { userId: "user-2", username: "override", displayName: "Override", role: "user" }
      }
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    expect(await runCli([
      "auth", "login",
      "--server", "https://override.example.com",
      "--api-key", "scrv_override",
      "--config", path
    ], {
      fetchImpl: loginFetch,
      stdout: loginOutput.stream,
      stderr: stderr.stream
    })).toBe(0);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      defaultServer: "https://default.example.com",
      servers: { "https://override.example.com": { apiKey: "scrv_override" } }
    });

    writeFileSync(path, JSON.stringify({
      version: 2,
      defaultServer: "https://default.example.com",
      servers: {
        "https://default.example.com": {
          apiKey: "scrv_default",
          apiKeyPrefix: "scrv_def",
          user: { userId: "user-1", username: "default", displayName: "Default", role: "admin" }
        },
        "https://override.example.com": {
          apiKey: "scrv_override",
          apiKeyPrefix: "scrv_ove",
          user: { userId: "user-2", username: "override", displayName: "Override", role: "user" }
        }
      }
    }));
    const requestedUrls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrls.push(String(input));
      const server = String(input).startsWith("https://override.example.com") ? "override" : "default";
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer scrv_${server}`);
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    expect(await runCli(["work", "list", "--config", path], {
      fetchImpl,
      stdout: outputCapture().stream,
      stderr: stderr.stream
    })).toBe(0);
    expect(await runCli(["work", "list", "--server", "https://override.example.com", "--config", path], {
      fetchImpl,
      stdout: outputCapture().stream,
      stderr: stderr.stream
    })).toBe(0);
    expect(requestedUrls).toEqual([
      "https://default.example.com/api/works",
      "https://override.example.com/api/works"
    ]);
    expect(stderr.text()).toBe("");
  });

  it("解析 serve 选项并启动隔离的数据目录", async () => {
    const root = temporaryRoot();
    const stdout = outputCapture();
    const stderr = outputCapture();
    let received: Record<string, unknown> | null = null;

    expect(await runCli([
      "serve",
      "--host", "0.0.0.0",
      "--port", "14321",
      "--data-dir", "local-data"
    ], {
      cwd: root,
      env: {},
      stdout: stdout.stream,
      stderr: stderr.stream,
      serveImpl: async (options) => {
        received = options;
        return { url: "http://0.0.0.0:14321", port: 14321, dataDirectory: options.dataDirectory, databasePath: options.databasePath };
      }
    })).toBe(0);
    expect(received).toMatchObject({
      host: "0.0.0.0",
      port: 14321,
      dataDirectory: join(root, "local-data"),
      databasePath: join(root, "local-data", "novel.db")
    });
    expect(JSON.parse(stdout.text())).toMatchObject({ running: true, url: "http://0.0.0.0:14321" });
    expect(stderr.text()).toBe("");
  });

  it("通过字段文件和 changeNote 生成适合长正文的版本化编辑请求", async () => {
    const root = temporaryRoot();
    const path = join(root, "cli.json");
    const bodyPath = join(root, "patch.json");
    const contentPath = join(root, "chapter.txt");
    writeFileSync(path, JSON.stringify({
      version: 1,
      server: "http://127.0.0.1:13210",
      apiKey: "scrv_test_key",
      apiKeyPrefix: "scrv_test",
      user: { userId: "user-1", username: "writer", displayName: "Writer", role: "user" }
    }));
    writeFileSync(bodyPath, JSON.stringify({ title: "新标题" }));
    writeFileSync(contentPath, "第一段。\n\n第二段。");
    const stdout = outputCapture();
    const stderr = outputCapture();
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("http://127.0.0.1:13210/api/chapters/chapter-1");
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(String(init?.body))).toEqual({
        title: "新标题",
        content: "第一段。\n\n第二段。",
        changeNote: "重写章节节奏"
      });
      return new Response(JSON.stringify({ data: { id: "chapter-1", versionNo: 2 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as typeof fetch;

    expect(await runCli([
      "resource", "update", "chapter", "chapter-1",
      "--input", bodyPath,
      "--field-file", `content=${contentPath}`,
      "--change-note", "重写章节节奏",
      "--config", path
    ], { fetchImpl, stdout: stdout.stream, stderr: stderr.stream })).toBe(0);
    expect(stderr.text()).toBe("");
    expect(JSON.parse(stdout.text())).toEqual({ id: "chapter-1", versionNo: 2 });
  });

  it("把服务端 Markdown ZIP 导出流写入文件且拒绝覆盖", async () => {
    const root = temporaryRoot();
    const configPath = join(root, "cli.json");
    const outputPath = join(root, "novel.zip");
    writeFileSync(configPath, JSON.stringify({
      version: 2,
      defaultServer: "http://127.0.0.1:13210",
      servers: {
        "http://127.0.0.1:13210": {
          apiKey: "scrv_test_key",
          apiKeyPrefix: "scrv_test",
          user: { userId: "user-1", username: "writer", displayName: "Writer", role: "user" }
        }
      }
    }));
    const archive = Buffer.from("server-generated-zip");
    const fetchImpl = (async (input: string | URL | Request) => {
      expect(String(input)).toBe("http://127.0.0.1:13210/api/works/work-1/export?format=markdown");
      return new Response(archive, { status: 200, headers: { "Content-Type": "application/zip" } });
    }) as typeof fetch;
    const stdout = outputCapture();
    const stderr = outputCapture();

    expect(await runCli([
      "manuscript", "get", "work-1", "--format", "markdown", "--output", outputPath, "--config", configPath
    ], { fetchImpl, stdout: stdout.stream, stderr: stderr.stream })).toBe(0);
    expect(stderr.text()).toBe("");
    expect(JSON.parse(stdout.text())).toMatchObject({ format: "markdown", outputPath, bytes: archive.byteLength, contentType: "application/zip" });
    expect(readFileSync(outputPath)).toEqual(archive);

    const overwriteError = outputCapture();
    expect(await runCli([
      "manuscript", "get", "work-1", "--format", "markdown", "--output", outputPath, "--config", configPath
    ], { fetchImpl, stdout: outputCapture().stream, stderr: overwriteError.stream })).toBe(1);
    expect(JSON.parse(overwriteError.text())).toMatchObject({ error: { code: "CLI_OUTPUT_EXISTS" } });
  });

  it("把服务端 DOCX 导出流写入默认文件名", async () => {
    const root = temporaryRoot();
    const configPath = join(root, "cli.json");
    writeFileSync(configPath, JSON.stringify({
      version: 2,
      defaultServer: "http://127.0.0.1:13210",
      servers: {
        "http://127.0.0.1:13210": {
          apiKey: "scrv_test_key",
          apiKeyPrefix: "scrv_test",
          user: { userId: "user-1", username: "writer", displayName: "Writer", role: "user" }
        }
      }
    }));
    const document = Buffer.from("PK-docx-bytes");
    const fetchImpl = (async (input: string | URL | Request) => {
      expect(String(input)).toBe("http://127.0.0.1:13210/api/works/work-1/export?format=docx");
      return new Response(document, {
        status: 200,
        headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }
      });
    }) as typeof fetch;
    const stdout = outputCapture();
    const stderr = outputCapture();
    const defaultOutput = join(root, "novel-work-1.docx");

    expect(await runCli([
      "manuscript", "get", "work-1", "--format", "docx", "--config", configPath
    ], { fetchImpl, stdout: stdout.stream, stderr: stderr.stream, cwd: root })).toBe(0);
    expect(stderr.text()).toBe("");
    expect(JSON.parse(stdout.text())).toMatchObject({
      format: "docx",
      outputPath: defaultOutput,
      bytes: document.byteLength,
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    });
    expect(readFileSync(defaultOutput)).toEqual(document);
  });

  it("把服务端 EPUB 导出流写入默认文件名", async () => {
    const root = temporaryRoot();
    const configPath = join(root, "cli.json");
    writeFileSync(configPath, JSON.stringify({
      version: 2,
      defaultServer: "http://127.0.0.1:13210",
      servers: {
        "http://127.0.0.1:13210": {
          apiKey: "scrv_test_key",
          apiKeyPrefix: "scrv_test",
          user: { userId: "user-1", username: "writer", displayName: "Writer", role: "user" }
        }
      }
    }));
    const book = Buffer.from("PK-epub-bytes");
    const fetchImpl = (async (input: string | URL | Request) => {
      expect(String(input)).toBe("http://127.0.0.1:13210/api/works/work-1/export?format=epub");
      return new Response(book, { status: 200, headers: { "Content-Type": "application/epub+zip" } });
    }) as typeof fetch;
    const stdout = outputCapture();
    const stderr = outputCapture();
    const defaultOutput = join(root, "novel-work-1.epub");

    expect(await runCli([
      "manuscript", "get", "work-1", "--format", "epub", "--config", configPath
    ], { fetchImpl, stdout: stdout.stream, stderr: stderr.stream, cwd: root })).toBe(0);
    expect(stderr.text()).toBe("");
    expect(JSON.parse(stdout.text())).toMatchObject({
      format: "epub",
      outputPath: defaultOutput,
      bytes: book.byteLength,
      contentType: "application/epub+zip"
    });
    expect(readFileSync(defaultOutput)).toEqual(book);
  });

  it("支持写作目标、章节移动与批量管理命令", async () => {
    const root = temporaryRoot();
    const configPath = join(root, "cli.json");
    writeFileSync(configPath, JSON.stringify({
      version: 2,
      defaultServer: "http://127.0.0.1:13210",
      servers: {
        "http://127.0.0.1:13210": {
          apiKey: "scrv_test_key",
          apiKeyPrefix: "scrv_test",
          user: { userId: "user-1", username: "writer", displayName: "Writer", role: "user" }
        }
      }
    }));
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const run = (args: string[]) => runCli([...args, "--config", configPath], { fetchImpl, stdout: outputCapture().stream, stderr: outputCapture().stream });
    const goalPath = jsonFile(root, "goal.json", { dailyGoal: 2000, targetTotal: 120000, deadline: "2026-12-31" });
    const movePath = jsonFile(root, "move.json", { volumeId: "volume-2", sortOrder: 0, expectedVersionNo: 2 });
    const batchBody = { chapters: [{ id: "chapter-1", expectedVersionNo: 3 }], action: { type: "setAnalysisExclusion", excludedFromAnalysis: true } };
    const batchPath = jsonFile(root, "batch.json", batchBody);

    expect(await run(["writing", "progress", "work-1"])).toBe(0);
    expect(await run(["writing", "goal", "work-1", "--input", goalPath])).toBe(0);
    expect(await run(["chapter", "move", "chapter-1", "--input", movePath])).toBe(0);
    expect(await run(["chapter", "batch", "work-1", "--input", batchPath])).toBe(0);
    expect(calls).toEqual([
      { url: "http://127.0.0.1:13210/api/works/work-1/writing-progress", method: "GET", body: null },
      { url: "http://127.0.0.1:13210/api/works/work-1/writing-goal", method: "PUT", body: { dailyGoal: 2000, targetTotal: 120000, deadline: "2026-12-31" } },
      { url: "http://127.0.0.1:13210/api/chapters/chapter-1/move", method: "POST", body: { volumeId: "volume-2", sortOrder: 0, expectedVersionNo: 2 } },
      { url: "http://127.0.0.1:13210/api/works/work-1/chapters/batch", method: "POST", body: batchBody }
    ]);
  });

  it("支持正文批注的完整管理命令", async () => {
    const root = temporaryRoot();
    const configPath = join(root, "cli.json");
    writeFileSync(configPath, JSON.stringify({
      version: 2,
      defaultServer: "http://127.0.0.1:13210",
      servers: {
        "http://127.0.0.1:13210": {
          apiKey: "scrv_test_key",
          apiKeyPrefix: "scrv_test",
          user: { userId: "user-1", username: "writer", displayName: "Writer", role: "user" }
        }
      }
    }));
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ data: { id: "annotation-1" } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const run = (args: string[]) => runCli([...args, "--config", configPath], { fetchImpl, stdout: outputCapture().stream, stderr: outputCapture().stream });
    const createBody = { kind: "todo", startLine: 2, endLine: 3, note: "补充过渡" };
    const createPath = jsonFile(root, "annotation-create.json", createBody);
    const updatePath = jsonFile(root, "annotation-update.json", { status: "resolved", expectedVersionNo: 1 });

    expect(await run(["annotation", "list", "chapter-1"])).toBe(0);
    expect(await run(["annotation", "list-work", "work-1"])).toBe(0);
    expect(await run(["annotation", "create", "chapter-1", "--input", createPath])).toBe(0);
    expect(await run(["annotation", "update", "annotation-1", "--input", updatePath])).toBe(0);
    expect(await run(["annotation", "delete", "annotation-1", "--expected-version", "2"])).toBe(0);
    expect(calls).toEqual([
      { url: "http://127.0.0.1:13210/api/chapters/chapter-1/annotations", method: "GET", body: null },
      { url: "http://127.0.0.1:13210/api/works/work-1/chapter-annotations", method: "GET", body: null },
      { url: "http://127.0.0.1:13210/api/chapters/chapter-1/annotations", method: "POST", body: createBody },
      { url: "http://127.0.0.1:13210/api/chapter-annotations/annotation-1", method: "PATCH", body: { status: "resolved", expectedVersionNo: 1 } },
      { url: "http://127.0.0.1:13210/api/chapter-annotations/annotation-1", method: "DELETE", body: { expectedVersionNo: 2 } }
    ]);
  });

  it("为混合检索传递类型和数量筛选并校验边界", async () => {
    const root = temporaryRoot();
    const configPath = join(root, "cli.json");
    writeFileSync(configPath, JSON.stringify({
      version: 2,
      defaultServer: "http://127.0.0.1:13210",
      servers: {
        "http://127.0.0.1:13210": {
          apiKey: "scrv_test_key",
          apiKeyPrefix: "scrv_test",
          user: { userId: "user-1", username: "writer", displayName: "Writer", role: "user" }
        }
      }
    }));
    const fetchImpl = (async (input: string | URL | Request) => {
      expect(String(input)).toBe("http://127.0.0.1:13210/api/works/work-1/search?q=%E5%8C%97%E6%B8%AF&type=timeline-event&limit=12");
      return new Response(JSON.stringify({ data: [{ type: "timeline-event", id: "event-1" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as typeof fetch;
    const stdout = outputCapture();
    const stderr = outputCapture();
    expect(await runCli([
      "search", "work-1", "--query", "北港", "--type", "timeline-event", "--limit", "12", "--config", configPath
    ], { fetchImpl, stdout: stdout.stream, stderr: stderr.stream })).toBe(0);
    expect(JSON.parse(stdout.text())).toEqual([{ type: "timeline-event", id: "event-1" }]);

    const invalidType = outputCapture();
    expect(await runCli([
      "search", "work-1", "--query", "北港", "--type", "unknown", "--config", configPath
    ], { stdout: outputCapture().stream, stderr: invalidType.stream })).toBe(1);
    expect(JSON.parse(invalidType.text())).toMatchObject({ error: { code: "CLI_SEARCH_TYPE_INVALID" } });

    const invalidLimit = outputCapture();
    expect(await runCli([
      "search", "work-1", "--query", "北港", "--limit", "101", "--config", configPath
    ], { stdout: outputCapture().stream, stderr: invalidLimit.stream })).toBe(1);
    expect(JSON.parse(invalidLimit.text())).toMatchObject({ error: { code: "CLI_SEARCH_LIMIT_INVALID" } });
  });

  it("未登录的数据命令和未开放命令返回结构化错误", async () => {
    const root = temporaryRoot();
    const stdout = outputCapture();
    const stderr = outputCapture();
    expect(await runCli(["work", "list", "--config", join(root, "missing.json")], {
      stdout: stdout.stream,
      stderr: stderr.stream
    })).toBe(1);
    expect(JSON.parse(stderr.text())).toMatchObject({ error: { code: "CLI_LOGIN_REQUIRED" } });

    const unknownError = outputCapture();
    expect(await runCli(["users", "list"], { stdout: stdout.stream, stderr: unknownError.stream })).toBe(1);
    expect(JSON.parse(unknownError.text())).toMatchObject({ error: { code: "CLI_COMMAND_UNKNOWN" } });
  });

  it("支持 AI 对话重命名与批量提问的查看、回答和拒绝命令", async () => {
    const root = temporaryRoot();
    const configPath = join(root, "cli.json");
    writeFileSync(configPath, JSON.stringify({
      version: 2,
      defaultServer: "http://127.0.0.1:13210",
      servers: {
        "http://127.0.0.1:13210": {
          apiKey: "scrv_test_key",
          apiKeyPrefix: "scrv_test",
          user: { userId: "user-1", username: "writer", displayName: "Writer", role: "user" }
        }
      }
    }));
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const run = (args: string[]) => runCli([...args, "--config", configPath], { fetchImpl, stdout: outputCapture().stream, stderr: outputCapture().stream });
    const answerPath = jsonFile(root, "question-answer.json", {
      answers: [
        { selectedOption: 1, customAnswer: "补充背景：星港在雨季封锁航道" },
        { customAnswer: "沿用第三章的潮汐时间线" }
      ]
    });

    expect(await run(["ai", "rename", "conversation-1", "--title", "  星港谈判线  "])).toBe(0);
    expect(await run(["ai", "questions", "list", "work-1"])).toBe(0);
    expect(await run(["ai", "questions", "list", "work-1", "--status", "pending", "--conversation-id", "conversation-1", "--limit", "12"])).toBe(0);
    expect(await run(["ai", "questions", "get", "work-1", "question-1"])).toBe(0);
    expect(await run(["ai", "questions", "answer", "work-1", "question-1", "--input", answerPath])).toBe(0);
    expect(await run(["ai", "questions", "reject", "work-1", "question-1"])).toBe(0);
    expect(calls).toEqual([
      { url: "http://127.0.0.1:13210/api/ai-conversations/conversation-1/title", method: "PATCH", body: { title: "星港谈判线" } },
      { url: "http://127.0.0.1:13210/api/works/work-1/ai/questions", method: "GET", body: null },
      { url: "http://127.0.0.1:13210/api/works/work-1/ai/questions?conversationId=conversation-1&status=pending&limit=12", method: "GET", body: null },
      { url: "http://127.0.0.1:13210/api/works/work-1/ai/questions/question-1", method: "GET", body: null },
      {
        url: "http://127.0.0.1:13210/api/works/work-1/ai/questions/question-1/answer",
        method: "POST",
        body: {
          answers: [
            { selectedOption: 1, customAnswer: "补充背景：星港在雨季封锁航道" },
            { customAnswer: "沿用第三章的潮汐时间线" }
          ]
        }
      },
      { url: "http://127.0.0.1:13210/api/works/work-1/ai/questions/question-1/reject", method: "POST", body: {} }
    ]);

    const longTitle = outputCapture();
    expect(await runCli(["ai", "rename", "conversation-1", "--title", "标".repeat(201), "--config", configPath], {
      fetchImpl, stdout: longTitle.stream, stderr: longTitle.stream
    })).toBe(1);
    expect(JSON.parse(longTitle.text())).toMatchObject({ error: { code: "CLI_TITLE_INVALID" } });

    const invalidStatus = outputCapture();
    expect(await runCli(["ai", "questions", "list", "work-1", "--status", "closed", "--config", configPath], {
      fetchImpl, stdout: invalidStatus.stream, stderr: invalidStatus.stream
    })).toBe(1);
    expect(JSON.parse(invalidStatus.text())).toMatchObject({ error: { code: "CLI_QUESTION_STATUS_INVALID" } });

    const invalidLimit = outputCapture();
    expect(await runCli(["ai", "questions", "list", "work-1", "--limit", "0", "--config", configPath], {
      fetchImpl, stdout: invalidLimit.stream, stderr: invalidLimit.stream
    })).toBe(1);
    expect(JSON.parse(invalidLimit.text())).toMatchObject({ error: { code: "CLI_QUESTION_LIMIT_INVALID" } });
  });
});
