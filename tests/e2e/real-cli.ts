import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import JSZip from "jszip";
import type { CliResourceType } from "../../src/cli-contract.js";

type SessionCredentials = {
  cookie: string;
  csrfToken: string;
  user: { userId: string; username: string; displayName: string; role: "admin" | "user" };
};

type CliResult = {
  status: number;
  stdout: string;
  stderr: string;
};

const dataParent = join(process.cwd(), ".data");
mkdirSync(dataParent, { recursive: true });
const root = mkdtempSync(join(dataParent, "e2e-cli-"));
const databasePath = join(root, "novel.db");
const configPath = join(root, "cli-config.json");
const cliPath = join(process.cwd(), "dist", "cli.js");
const fixturePath = join(process.cwd(), "tests", "e2e", "cli-server-fixture.ts");
const tsxPath = join(process.cwd(), "node_modules", ".bin", "tsx");
let server: ChildProcessWithoutNullStreams | null = null;
let baseUrl = "";
let serverStderr = "";
let fileIndex = 0;

function checked(name: string, detail: string): void {
  console.log(`[cli-e2e] ${name}: ${detail}`);
}

function cli(args: string[], input?: string, expectedStatus = 0): CliResult {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    input,
    maxBuffer: 20 * 1024 * 1024,
    env: {
      ...process.env,
      SCRIVERSE_CONFIG: configPath,
      SCRIVERSE_API_KEY: ""
    }
  });
  if (result.error) throw result.error;
  const status = result.status ?? 1;
  if (status !== expectedStatus) {
    throw new Error(`CLI ${args.join(" ")} exited ${status}, expected ${expectedStatus}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return { status, stdout: result.stdout, stderr: result.stderr };
}

function cliJson(args: string[], input?: string): unknown {
  const result = cli(args, input);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

function cliJsonWithHttpWarning(args: string[], input?: string): unknown {
  const result = cli(args, input);
  const payload = JSON.parse(result.stderr) as { warning?: Record<string, unknown> };
  assert.equal(payload.warning?.code, "CLI_SERVER_HTTP_WARNING");
  assert.equal(payload.warning?.server, baseUrl);
  return JSON.parse(result.stdout);
}

function cliError(args: string[], expectedCode: string): Record<string, unknown> {
  const result = cli(args, undefined, 1);
  const payload = JSON.parse(result.stderr) as { error?: Record<string, unknown> };
  assert.equal(payload.error?.code, expectedCode);
  return payload.error ?? {};
}

function jsonFile(name: string, value: Record<string, unknown>): string {
  const path = join(root, `${String(++fileIndex).padStart(2, "0")}-${name}.json`);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

function textFile(name: string, value: string): string {
  const path = join(root, `${String(++fileIndex).padStart(2, "0")}-${name}.txt`);
  writeFileSync(path, value);
  return path;
}

async function e2eFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Connection", "close");
  const method = init.method ?? "GET";
  for (let attempt = 0; attempt < (method === "GET" ? 2 : 1); attempt += 1) {
    try {
      return await fetch(url, { ...init, headers });
    } catch (error) {
      if (attempt === 0 && method === "GET") continue;
      throw new Error(
        `E2E request failed: ${method} ${url}; serverExit=${String(server?.exitCode)}; serverStderr=${serverStderr}`,
        { cause: error }
      );
    }
  }
  throw new Error(`E2E request failed: ${method} ${url}`);
}

async function responseData(response: Response): Promise<unknown> {
  const text = await response.text();
  const payload = text ? JSON.parse(text) as { data?: unknown; error?: { code?: string; message?: string } } : {};
  if (!response.ok) throw new Error(`${payload.error?.code ?? response.status}: ${payload.error?.message ?? text}`);
  return payload.data;
}

async function register(username: string): Promise<SessionCredentials> {
  const captcha = await responseData(await e2eFetch(`${baseUrl}/api/auth/captcha`)) as { captchaId: string; answer: string };
  const response = await e2eFetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username,
      password: "secure-password-123",
      passwordConfirmation: "secure-password-123",
      setupToken: "cli-e2e-setup-token-with-at-least-32-characters",
      captchaId: captcha.captchaId,
      captchaAnswer: captcha.answer
    })
  });
  const data = await responseData(response) as { csrfToken: string; user: SessionCredentials["user"] };
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie);
  return { cookie: setCookie.split(";")[0] ?? "", csrfToken: data.csrfToken, user: data.user };
}

async function sessionRequest(
  credentials: SessionCredentials,
  path: string,
  method: "GET" | "POST" | "PATCH" = "GET",
  body?: Record<string, unknown>
): Promise<unknown> {
  const response = await e2eFetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Cookie: credentials.cookie,
      ...(method === "GET" ? {} : { "X-CSRF-Token": credentials.csrfToken }),
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return responseData(response);
}

async function resetApiKey(credentials: SessionCredentials): Promise<string> {
  const data = await sessionRequest(credentials, "/api/auth/api-key/reset", "POST", {}) as { apiKey: string };
  assert.match(data.apiKey, /^scrv_/u);
  return data.apiKey;
}

function createResource(type: CliResourceType, scopeId: string, body: Record<string, unknown>): Record<string, unknown> {
  return cliJson(["resource", "create", type, scopeId, "--input", jsonFile(`${type}-create`, body)]) as Record<string, unknown>;
}

function listResource(type: CliResourceType, workId: string): unknown[] {
  return cliJson(["resource", "list", type, workId]) as unknown[];
}

function getResource(type: CliResourceType, id: string): Record<string, unknown> | null {
  return cliJson(["resource", "get", type, id]) as Record<string, unknown> | null;
}

function updateResource(type: CliResourceType, id: string, body: Record<string, unknown>, changeNote?: string): Record<string, unknown> {
  return cliJson([
    "resource", "update", type, id,
    "--input", jsonFile(`${type}-update`, body),
    ...(changeNote ? ["--change-note", changeNote] : [])
  ]) as Record<string, unknown>;
}

function historyResource(type: Exclude<CliResourceType, "volume">, id: string): Array<Record<string, unknown>> {
  return cliJson(["resource", "history", type, id]) as Array<Record<string, unknown>>;
}

function restoreResource(type: Exclude<CliResourceType, "volume">, id: string, version = 1): Record<string, unknown> {
  return cliJson(["resource", "restore", type, id, "--version", String(version)]) as Record<string, unknown>;
}

async function startServer(): Promise<void> {
  server = spawn(tsxPath, [fixturePath], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: "test", CLI_E2E_DATABASE_PATH: databasePath },
    stdio: ["pipe", "pipe", "pipe"]
  });
  server.stderr.on("data", (chunk: Buffer) => {
    serverStderr += chunk.toString("utf8");
  });
  const lines = createInterface({ input: server.stdout });
  baseUrl = await new Promise<string>((resolveUrl, rejectUrl) => {
    const timer = setTimeout(() => rejectUrl(new Error(`CLI E2E server startup timed out\n${serverStderr}`)), 10_000);
    lines.once("line", (line) => {
      clearTimeout(timer);
      try {
        const payload = JSON.parse(line) as { baseUrl?: string };
        if (!payload.baseUrl) throw new Error("missing baseUrl");
        resolveUrl(payload.baseUrl);
      } catch {
        rejectUrl(new Error(`CLI E2E server returned invalid startup output: ${line}`));
      }
    });
    server!.once("exit", (code) => {
      clearTimeout(timer);
      rejectUrl(new Error(`CLI E2E server exited during startup with ${code}\n${serverStderr}`));
    });
  });
  lines.close();
}

async function stopServer(): Promise<void> {
  if (!server) return;
  if (server.exitCode === null) {
    const stopped = new Promise<void>((resolveStop) => server!.once("exit", () => resolveStop()));
    server.kill("SIGTERM");
    await stopped;
  }
  server = null;
}

async function run(): Promise<void> {
  await startServer();
  const health = await responseData(await e2eFetch(`${baseUrl}/api/health`)) as { status: string };
  assert.equal(health.status, "ok");

  const help = cli(["--help"]);
  assert.match(help.stdout, /Scriverse CLI/u);
  assert.doesNotMatch(help.stdout, /用户管理|供应商管理/u);
  assert.deepEqual(cliJson(["auth", "status"]), { authenticated: false, defaultServer: null, configPath });
  assert.deepEqual(cliJsonWithHttpWarning(["connect", baseUrl]), { defaultServer: baseUrl, authenticated: false, configPath });
  assert.deepEqual(cliJson(["auth", "status"]), { authenticated: false, server: baseUrl, defaultServer: baseUrl, configPath });
  const schemaList = cliJson(["schema", "list"]) as { prohibited: string[]; resources: unknown[] };
  assert.ok(schemaList.prohibited.includes("用户管理"));
  assert.equal(schemaList.resources.length, 12);
  assert.equal((cliJson(["schema", "show", "work"]) as { type: string }).type, "work");
  for (const type of [
    "volume", "chapter", "draft", "setting", "character", "race", "organization",
    "timeline-track", "timeline-event", "relationship", "foreshadow", "chapter-outline"
  ] as CliResourceType[]) {
    assert.equal((cliJson(["schema", "show", type]) as { type: string }).type, type);
  }
  cliError(["users", "list"], "CLI_COMMAND_UNKNOWN");
  checked("offline-commands", "help, auth status, schema list/show and forbidden command handling passed before login");

  const admin = await register("cli_admin");
  const writer = await register("cli_writer");
  const writerWork = await sessionRequest(writer, "/api/works", "POST", { title: "作者隔离作品" }) as Record<string, unknown>;
  const adminKey = await resetApiKey(admin);
  const writerKey = await resetApiKey(writer);
  const keyPath = textFile("admin-api-key", `${adminKey}\n`);
  chmodSync(keyPath, 0o600);

  const login = cliJsonWithHttpWarning(["auth", "login", "--api-key-file", keyPath]) as {
    authenticated: boolean;
    user: { userId: string };
  };
  assert.equal(login.authenticated, true);
  assert.equal(login.user.userId, admin.user.userId);
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  const status = cliJson(["auth", "status"]) as { authenticated: boolean; user: { username: string } };
  assert.equal(status.authenticated, true);
  assert.equal(status.user.username, "cli_admin");
  checked("authentication", "compiled CLI validated the API key, persisted a 0600 config and revalidated status");

  const work = cliJson(["work", "create", "--input", jsonFile("work-create", {
    title: "CLI 长篇测试",
    author: "CLI",
    description: "初始简介",
    tags: ["e2e"]
  })]) as Record<string, unknown>;
  const workId = String(work.id);
  const updatedWork = cliJson(["work", "update", workId, "--input", jsonFile("work-update", {
    description: "由 CLI 更新的简介",
    tags: ["e2e", "cli"]
  })]) as Record<string, unknown>;
  assert.equal(updatedWork.description, "由 CLI 更新的简介");
  const works = cliJson(["work", "list"]) as Array<Record<string, unknown>>;
  assert.deepEqual(works.map((item) => item.id), [workId]);
  assert.equal((cliJson(["work", "get", workId]) as Record<string, unknown>).id, workId);
  checked("work-commands", "work create, update, list and get passed with admin API key restricted to owned works");

  const aiConversation = await sessionRequest(admin, `/api/works/${workId}/ai-conversations`, "POST", { title: "初始对话标题" }) as Record<string, unknown>;
  const aiConversationId = String(aiConversation.id);
  const renamedConversation = cliJson(["ai", "rename", aiConversationId, "--title", "CLI 重命名后的对话"]) as Record<string, unknown>;
  assert.equal(renamedConversation.title, "CLI 重命名后的对话");
  const conversationDetail = await sessionRequest(admin, `/api/ai-conversations/${aiConversationId}`) as Record<string, unknown>;
  assert.equal(conversationDetail.title, "CLI 重命名后的对话");
  const emptyQuestions = cliJson(["ai", "questions", "list", workId]) as { questions: unknown[] };
  assert.equal(emptyQuestions.questions.length, 0);
  checked("ai-commands", "ai rename and questions list passed against the real server");

  const volume = createResource("volume", workId, {
    title: "第一卷",
    kind: "main",
    description: "初始分卷",
    storyOrder: 3
  });
  const volumeId = String(volume.id);
  assert.ok(listResource("volume", workId).some((item) => (item as Record<string, unknown>).id === volumeId));
  assert.equal(getResource("volume", volumeId)?.id, volumeId);
  assert.equal(Number(volume.storyOrder), 3);
  const updatedVolume = updateResource("volume", volumeId, { description: "更新后的分卷", keywords: ["启程"], storyOrder: 5 });
  assert.equal(updatedVolume.description, "更新后的分卷");
  assert.equal(Number(updatedVolume.storyOrder), 5);

  const chapter = cliJson([
    "resource", "create", "chapter", workId, "--input", "-"
  ], JSON.stringify({
    volumeId,
    title: "第一章 抵达",
    content: "林舟抵达北港。",
    chapterType: "正文"
  })) as Record<string, unknown>;
  const chapterId = String(chapter.id);
  assert.ok(listResource("chapter", workId).some((item) => (item as Record<string, unknown>).id === chapterId));
  assert.equal(getResource("chapter", chapterId)?.content, "林舟抵达北港。");
  const chapterContentPath = textFile("chapter-content", "林舟抵达北港。\n\n潮声盖过了远处的警报。");
  const updatedChapter = cliJson([
    "resource", "update", "chapter", chapterId,
    "--input", jsonFile("chapter-update", { title: "第一章 潮声" }),
    "--field-file", `content=${chapterContentPath}`,
    "--change-note", "重写开场并补充警报"
  ]) as Record<string, unknown>;
  assert.equal(updatedChapter.versionNo, 2);
  assert.equal(updatedChapter.content, "林舟抵达北港。\n\n潮声盖过了远处的警报。");
  assert.equal(historyResource("chapter", chapterId)[0]?.changeNote, "重写开场并补充警报");

  const draft = createResource("draft", workId, {
    draftType: "prose",
    title: "北港雨夜备选开场",
    content: "雨水沿着舷窗向上流动。"
  });
  const draftId = String(draft.id);
  assert.ok(listResource("draft", workId).some((item) => (item as Record<string, unknown>).id === draftId));
  assert.equal(getResource("draft", draftId)?.draftType, "prose");
  updateResource("draft", draftId, { content: "雨水沿着舷窗向上流动，港口警报却沉入海雾。" }, "强化开场悬念");
  assert.equal(historyResource("draft", draftId)[0]?.changeNote, "强化开场悬念");

  const writingGoal = cliJson(["writing", "goal", workId, "--input", jsonFile("writing-goal", {
    dailyGoal: 2000,
    targetTotal: 120000,
    deadline: "2026-12-31"
  })]) as Record<string, unknown>;
  assert.equal((writingGoal.goal as Record<string, unknown>).dailyGoal, 2000);
  assert.equal((writingGoal.goal as Record<string, unknown>).targetTotal, 120000);
  assert.equal((writingGoal.goal as Record<string, unknown>).deadline, "2026-12-31");
  const writingProgress = cliJson(["writing", "progress", workId]) as Record<string, unknown>;
  assert.ok(Number(writingProgress.currentWords) > 0);

  const annotation = cliJson(["annotation", "create", chapterId, "--input", jsonFile("annotation-create", {
    kind: "todo",
    startLine: 1,
    endLine: 2,
    note: "补充抵达与警报之间的动作"
  })]) as Record<string, unknown>;
  const annotationId = String(annotation.id);
  assert.ok((cliJson(["annotation", "list", chapterId]) as Array<Record<string, unknown>>).some((item) => item.id === annotationId));
  const resolvedAnnotation = cliJson(["annotation", "update", annotationId, "--input", jsonFile("annotation-update", {
    status: "resolved",
    expectedVersionNo: 1
  })]) as Record<string, unknown>;
  assert.equal(resolvedAnnotation.status, "resolved");
  assert.equal(cliJson(["annotation", "delete", annotationId, "--expected-version", "2"]), null);
  assert.deepEqual(cliJson(["annotation", "list", chapterId]), []);

  const secondVolume = createResource("volume", workId, { title: "第二卷", kind: "main" });
  const movedChapter = cliJson(["chapter", "move", chapterId, "--input", jsonFile("chapter-move", {
    volumeId: secondVolume.id,
    sortOrder: 0,
    expectedVersionNo: 2
  })]) as Record<string, unknown>;
  assert.equal(movedChapter.volumeId, secondVolume.id);
  assert.equal(movedChapter.versionNo, 3);
  const batchResult = cliJson(["chapter", "batch", workId, "--input", jsonFile("chapter-batch", {
    chapters: [{ id: chapterId, expectedVersionNo: 3 }],
    action: { type: "setAnalysisExclusion", excludedFromAnalysis: true }
  })]) as Record<string, unknown>;
  assert.deepEqual(batchResult, { processed: 1, action: "setAnalysisExclusion" });
  assert.equal(getResource("chapter", chapterId)?.excludedFromAnalysis, true);
  checked("recent-authoring-commands", "writing goals, annotations, chapter move and batch management passed through the compiled CLI");

  const setting = createResource("setting", workId, {
    title: "北港",
    category: "地点",
    content: "北港是潮汐航线枢纽。",
    status: "confirmed"
  });
  const settingId = String(setting.id);
  assert.ok(listResource("setting", workId).some((item) => (item as Record<string, unknown>).id === settingId));
  assert.equal(getResource("setting", settingId)?.title, "北港");
  updateResource("setting", settingId, { content: "北港同时是议会贸易枢纽。" }, "补充政治职能");
  assert.equal(historyResource("setting", settingId)[0]?.changeNote, "补充政治职能");

  const race = createResource("race", workId, {
    name: "潮裔",
    description: "适应盐雾环境。",
    settings: ["夜视较强"]
  });
  const raceId = String(race.id);
  assert.ok(listResource("race", workId).some((item) => (item as Record<string, unknown>).id === raceId));
  assert.equal(getResource("race", raceId)?.name, "潮裔");

  const characterA = createResource("character", workId, {
    name: "林舟",
    aliases: ["阿舟"],
    profile: { motivation: "寻找姐姐" },
    currentState: { location: "北港" }
  });
  const characterAId = String(characterA.id);
  const characterB = createResource("character", workId, {
    name: "顾潮",
    profile: { motivation: "维持议会秩序" }
  });
  const characterBId = String(characterB.id);
  assert.ok(listResource("character", workId).some((item) => (item as Record<string, unknown>).id === characterAId));
  assert.equal(getResource("character", characterAId)?.name, "林舟");
  updateResource("character", characterAId, { currentState: { location: "北港议会", condition: "受伤" } }, "同步章节结尾状态");
  assert.equal(historyResource("character", characterAId)[0]?.changeNote, "同步章节结尾状态");
  updateResource("race", raceId, { settings: ["夜视较强", "需要周期性盐浴"], memberIds: [characterAId] }, "补充生理限制与成员");
  assert.equal(historyResource("race", raceId)[0]?.changeNote, "补充生理限制与成员");

  const organization = createResource("organization", workId, {
    name: "北港议会",
    description: "控制航线许可。",
    settings: ["七席轮值制"],
    memberIds: [characterAId]
  });
  const organizationId = String(organization.id);
  assert.ok(listResource("organization", workId).some((item) => (item as Record<string, unknown>).id === organizationId));
  assert.equal(getResource("organization", organizationId)?.name, "北港议会");
  updateResource("organization", organizationId, { memberIds: [characterAId, characterBId] }, "加入顾潮");
  assert.equal(historyResource("organization", organizationId)[0]?.changeNote, "加入顾潮");

  const track = createResource("timeline-track", workId, {
    name: "议会危机线",
    description: "记录北港议会冲突。",
    sortOrder: 0
  });
  const trackId = String(track.id);
  assert.ok(listResource("timeline-track", workId).some((item) => (item as Record<string, unknown>).id === trackId));
  assert.equal(getResource("timeline-track", trackId)?.name, "议会危机线");
  updateResource("timeline-track", trackId, { description: "记录政变前后的议会冲突。" }, "扩大时间范围");
  assert.equal(historyResource("timeline-track", trackId)[0]?.changeNote, "扩大时间范围");

  const event = createResource("timeline-event", workId, {
    name: "潮门关闭",
    trackId,
    description: "北港关闭潮门。",
    timeLabel: "雨季第一日",
    chapterIds: [chapterId],
    participantIds: [characterAId, characterBId],
    impactScope: "regional",
    status: "confirmed"
  });
  const eventId = String(event.id);
  assert.ok(listResource("timeline-event", workId).some((item) => (item as Record<string, unknown>).id === eventId));
  assert.equal(getResource("timeline-event", eventId)?.name, "潮门关闭");
  updateResource("timeline-event", eventId, { causes: ["议会封锁令", "外海舰队逼近"] }, "补充事件因果");
  assert.equal(historyResource("timeline-event", eventId)[0]?.changeNote, "补充事件因果");

  const relationship = createResource("relationship", workId, {
    fromCharacterId: characterAId,
    toCharacterId: characterBId,
    category: "conflict",
    subtype: "政治对手",
    keywords: ["互相试探"],
    confidence: 0.8,
    confirmationStatus: "confirmed"
  });
  const relationshipId = String(relationship.id);
  assert.ok(listResource("relationship", workId).some((item) => (item as Record<string, unknown>).id === relationshipId));
  assert.equal(getResource("relationship", relationshipId)?.category, "conflict");
  updateResource("relationship", relationshipId, { currentStatus: "暂时结盟", confidence: 0.95 }, "同步谈判结果");
  assert.equal(historyResource("relationship", relationshipId)[0]?.changeNote, "同步谈判结果");

  const foreshadow = createResource("foreshadow", workId, {
    title: "旧船票",
    description: "背面编号指向失踪名单。",
    status: "planted",
    importance: "high",
    occurrences: [{ chapterId, role: "setup", note: "在行李夹层出现" }]
  });
  const foreshadowId = String(foreshadow.id);
  assert.ok(listResource("foreshadow", workId).some((item) => (item as Record<string, unknown>).id === foreshadowId));
  assert.equal(getResource("foreshadow", foreshadowId)?.title, "旧船票");
  updateResource("foreshadow", foreshadowId, { status: "resolved", resolutionNote: "编号属于失踪的姐姐。" }, "记录伏笔回收");
  assert.equal(historyResource("foreshadow", foreshadowId)[0]?.changeNote, "记录伏笔回收");

  const outline = createResource("chapter-outline", chapterId, {
    goal: "进入北港议会",
    conflict: "身份审查发现伪造船票",
    turningPoint: "议长认出编号",
    status: "ready"
  });
  assert.equal(outline.chapterId, chapterId);
  assert.ok(listResource("chapter-outline", workId).some((item) => (item as Record<string, unknown>).chapterId === chapterId));
  assert.equal(getResource("chapter-outline", chapterId)?.goal, "进入北港议会");
  updateResource("chapter-outline", chapterId, { turningPoint: "议长私下放行并索要情报" }, "强化主动选择");
  assert.equal(historyResource("chapter-outline", chapterId)[0]?.changeNote, "强化主动选择");
  checked("resource-editing", "all 12 resource types passed list/get/create/update and all versioned types recorded change notes");

  const manuscriptJson = cliJson(["manuscript", "get", workId, "--format", "json"]) as Record<string, unknown>;
  assert.equal(manuscriptJson.id, workId);
  const manuscriptArchivePath = join(root, "manuscript.zip");
  const manuscriptExport = cliJson(["manuscript", "get", workId, "--format", "markdown", "--output", manuscriptArchivePath]) as Record<string, unknown>;
  assert.equal(manuscriptExport.contentType, "application/zip");
  const manuscriptArchive = await JSZip.loadAsync(readFileSync(manuscriptArchivePath));
  const manuscriptMarkdown = await manuscriptArchive.file(`novel-${workId}.md`)?.async("string") ?? "";
  assert.match(manuscriptMarkdown, /# 第一卷/u);
  assert.match(manuscriptMarkdown, /## 第一章 潮声/u);
  const manuscriptText = cli(["manuscript", "get", workId, "--format", "txt"]).stdout;
  assert.match(manuscriptText, /潮声盖过了远处的警报/u);
  const search = cliJson(["search", workId, "--query", "警报"]) as Array<Record<string, unknown>>;
  assert.ok(search.some((item) => item.type === "chapter" && item.id === chapterId));
  const audit = cliJson(["audit", workId]) as Array<Record<string, unknown>>;
  assert.ok(audit.some((item) => item.action === "chapter.saved" && item.actor === "cli_admin"));
  checked("read-commands", "manuscript json/markdown ZIP/txt, search and audit commands returned expected data");

  for (const [type, id] of [
    ["chapter", chapterId],
    ["draft", draftId],
    ["setting", settingId],
    ["character", characterAId],
    ["race", raceId],
    ["organization", organizationId],
    ["timeline-track", trackId],
    ["timeline-event", eventId],
    ["relationship", relationshipId],
    ["foreshadow", foreshadowId],
    ["chapter-outline", chapterId]
  ] as Array<[Exclude<CliResourceType, "volume">, string]>) {
    const restored = restoreResource(type, id);
    assert.ok(Number(restored.versionNo) >= 3);
    const history = historyResource(type, id);
    assert.equal(history[0]?.source, "restore");
  }
  checked("history-restore", "chapter, character and nine generic versioned resources restored through CLI with actor attribution intact");

  const foreignWorkResponse = await e2eFetch(`${baseUrl}/api/works/${String(writerWork.id)}`, {
    headers: { Authorization: `Bearer ${adminKey}` }
  });
  assert.equal(foreignWorkResponse.status, 403);
  const platformResponse = await e2eFetch(`${baseUrl}/api/platform/ai/providers`, {
    headers: { Authorization: `Bearer ${adminKey}` }
  });
  assert.equal(platformResponse.status, 403);
  const deleteResponse = await e2eFetch(`${baseUrl}/api/chapters/${chapterId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${adminKey}` }
  });
  assert.equal(deleteResponse.status, 403);
  checked("server-scope", "raw API key calls could not access another user work, platform management or direct chapter deletion");

  assert.deepEqual(cliJson(["auth", "logout"]), { authenticated: false, server: baseUrl, defaultServer: baseUrl, configPath });
  cliError(["work", "list"], "CLI_LOGIN_REQUIRED");
  const writerKeyPath = textFile("writer-api-key", writerKey);
  cliJsonWithHttpWarning(["auth", "login", "--api-key-file", writerKeyPath]);
  const writerWorks = cliJson(["work", "list"]) as Array<Record<string, unknown>>;
  assert.deepEqual(writerWorks.map((item) => item.id), [writerWork.id]);
  cliError(["work", "get", workId], "WORK_ACCESS_DENIED");
  cliError(["ai", "rename", aiConversationId, "--title", "越权重命名"], "WORK_ACCESS_DENIED");
  await resetApiKey(writer);
  cliError(["auth", "status"], "API_KEY_INVALID");
  assert.deepEqual(cliJson(["auth", "logout"]), { authenticated: false, server: baseUrl, defaultServer: baseUrl, configPath });
  checked("identity-isolation", "logout blocked data commands, writer key saw only writer data, and key rotation invalidated the saved login");

  await stopServer();
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const chapterVersion = database.prepare(
    "SELECT change_note, created_by_user_id FROM chapter_versions WHERE chapter_id = ? ORDER BY version_no DESC LIMIT 1"
  ).get(chapterId) as { change_note?: unknown; created_by_user_id?: unknown } | undefined;
  assert.equal(chapterVersion?.created_by_user_id, admin.user.userId);
  assert.match(String(chapterVersion?.change_note), /恢复至 v1/u);
  const entityActors = database.prepare(
    "SELECT DISTINCT created_by_user_id FROM entity_versions WHERE work_id = ? AND source IN ('manual', 'restore')"
  ).all(workId);
  assert.deepEqual(entityActors.map((row) => String(row.created_by_user_id)), [admin.user.userId]);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  const finalCounts = {
    works: Number((database.prepare("SELECT COUNT(*) AS count FROM works WHERE COALESCE(is_internal, 0) = 0").get() as { count?: unknown } | undefined)?.count ?? 0),
    chapters: Number((database.prepare("SELECT COUNT(*) AS count FROM chapters").get() as { count?: unknown } | undefined)?.count ?? 0),
    chapterVersions: Number((database.prepare("SELECT COUNT(*) AS count FROM chapter_versions").get() as { count?: unknown } | undefined)?.count ?? 0),
    entityVersions: Number((database.prepare("SELECT COUNT(*) AS count FROM entity_versions").get() as { count?: unknown } | undefined)?.count ?? 0)
  };
  database.close();
  assert.deepEqual(finalCounts, { works: 2, chapters: 1, chapterVersions: 4, entityVersions: 34 });
  checked("complete", `all CLI commands passed against isolated server; counts=${JSON.stringify(finalCounts)}`);
}

try {
  await run();
} finally {
  await stopServer();
  rmSync(root, { recursive: true, force: true });
}
