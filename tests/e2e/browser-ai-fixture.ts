import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { createRuntime } from "../../src/app.js";
import { resolveBetaVersionLabel } from "../../src/version.js";
import { runWithRequestActor } from "../../src/request-context.js";

type JsonObject = Record<string, unknown>;
type CompletionMessage = { role?: string; tool_call_id?: string; content?: string };

const port = Number(process.env.E2E_BROWSER_PORT ?? 13212);
const aiStreamIdleTimeoutMs = Number(process.env.E2E_AI_STREAM_IDLE_TIMEOUT_MS ?? 3_000);
const dataRoot = join(process.cwd(), ".data");
await mkdir(dataRoot, { recursive: true });
const isolatedDirectory = await mkdtemp(join(dataRoot, "e2e-browser-ai-"));
let chapterId = "";

async function readRequest(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonObject;
}

function sendCompletion(response: ServerResponse, message: JsonObject): void {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ choices: [{ message }], usage: { completion_tokens: 32 } }));
}

function sendToolCalls(
  response: ServerResponse,
  calls: Array<{ id: string; name: string; arguments: unknown }>,
  process: { content?: string | null; reasoningContent?: string } = {}
): void {
  sendCompletion(response, {
    content: process.content ?? null,
    ...(process.reasoningContent ? { reasoning_content: process.reasoningContent } : {}),
    tool_calls: calls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments }
    }))
  });
}

const mockAi = createServer(async (request, response) => {
  if (request.url === "/v1/models") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "browser-agent-model" }] }));
    return;
  }
  if (request.url !== "/v1/chat/completions" || request.method !== "POST") {
    response.writeHead(404).end();
    return;
  }
  const body = await readRequest(request);
  const messages = Array.isArray(body.messages) ? body.messages as CompletionMessage[] : [];
  const latestUserMessage = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
  const joined = messages.map((message) => message.content ?? "").join("\n");
  const toolMessages = messages.filter((message) => message.role === "tool");
  const batchQuestionResult = toolMessages.find((message) => message.tool_call_id === "browser-question-batch");
  if (batchQuestionResult) {
    const payload = JSON.parse(batchQuestionResult.content ?? "{}") as JsonObject;
    const result = payload.result as JsonObject;
    const answers = Array.isArray(result.answers) ? result.answers as JsonObject[] : [];
    sendCompletion(response, {
      content: `已同时收到 ${answers.length} 个回答并继续：${answers.map((answer) => String(answer.selectedOption ?? answer.answer ?? "")).join("、")}。`,
      reasoning_content: "批量提问的全部工具结果已经返回，可以继续完成原工作流。"
    });
    return;
  }
  if (messages[0]?.content?.includes("压缩已完成的 AI 工具调用上下文")) {
    sendCompletion(response, { content: "已压缩前一轮章节工具结果，保留了跃迁冷却证据。" });
    return;
  }
  if (joined.includes("结构化中文长期记忆")) {
    const sourceMessageIds = [...joined.matchAll(/^\[([^\]]+)\]/gmu)].map((match) => match[1]).filter(Boolean).slice(0, 2);
    sendCompletion(response, { content: `<json>{"authorGoals":[],"confirmedDecisions":[],"storyFacts":[{"text":"最近正在确认燃料状态","sourceMessageIds":${JSON.stringify(sourceMessageIds)}}],"constraints":[{"text":"必须遵守跃迁冷却规则","sourceMessageIds":${JSON.stringify(sourceMessageIds)}}],"unresolvedQuestions":[],"importantReferences":[]}</json>` });
    return;
  }
  if (latestUserMessage.includes("浏览器流空闲超时测试")) {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "已收到的部分回复会被保留。" } }] })}\n\n`);
    return;
  }
  if (latestUserMessage.includes("浏览器终止思考保留测试")) {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "这段思考应该在人工终止后继续显示。" } }] })}\n\n`);
    const keepAliveTimer = setInterval(() => {
      if (!response.destroyed && !response.writableEnded) response.write(": keepalive\n\n");
    }, 500);
    const finishTimer = setTimeout(() => {
      clearInterval(keepAliveTimer);
      if (response.destroyed || response.writableEnded) return;
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "不应等到这段正文出现。" }, finish_reason: "stop" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    }, 15_000);
    const stop = () => {
      clearInterval(keepAliveTimer);
      clearTimeout(finishTimer);
    };
    request.once("aborted", stop);
    response.once("close", stop);
    return;
  }
  if (latestUserMessage.includes("浏览器工具测试")) {
    if (toolMessages.length === 0) {
      sendToolCalls(response, [
        { id: "browser-index", name: "story_index", arguments: { chapterOffset: 0, limit: 1 } },
        { id: "browser-read", name: "read_chapters", arguments: { chapterIds: [chapterId], include: "both" } },
        { id: "browser-query", name: "search_story_entities", arguments: { query: "跃迁", categories: ["setting"] } }
      ]);
      return;
    }
    sendCompletion(response, { content: "模型已处理三个工具结果：目录、章节正文和跃迁设定均已确认。" });
    return;
  }
  if (latestUserMessage.includes("浏览器 Markdown 表格测试")) {
    sendCompletion(response, {
      content: [
        "### 航行状态",
        "",
        "| 舰船 | 状态 | 备注 |",
        "| :--- | :---: | ---: |",
        "| 远航号 | **跃迁完成** | `冷却 12h`，这是用于验证横向滚动与自动换行切换的超长备注内容 |",
        "| 归潮号 | 检修中 | 引擎\\|护盾 |",
        "",
        "- 表格后列表仍然可用",
        "",
        "```txt",
        "航线已锁定",
        "```"
      ].join("\n")
    });
    return;
  }
  if (latestUserMessage.includes("浏览器思考步骤测试")) {
    if (toolMessages.length === 0) {
      sendToolCalls(response, [
        { id: "browser-thinking-index", name: "story_index", arguments: { chapterOffset: 0, limit: 1 } }
      ], { content: "我先读取作品目录。", reasoningContent: "需要先确认作品结构和章节范围。" });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
    sendCompletion(response, { content: "最终结果：目录已经确认。", reasoning_content: "工具结果已经足够形成最终答案。" });
    return;
  }
  if (latestUserMessage.includes("浏览器批量提问工具测试")) {
    sendToolCalls(response, [{
      id: "browser-question-batch",
      name: "ask_user_question",
      arguments: { questions: [
        { question: "请选择故事的推进方向", options: ["调查旧港钟楼", "追踪北境舰队"] },
        { question: "请选择叙事视角", options: ["第三人称", "第一人称"] }
      ] }
    }], { reasoningContent: "需要一次确认两个相关创作决策。" });
    return;
  }
  if (latestUserMessage.includes("浏览器分层上下文测试")) {
    const hasEarlyEvidence = joined.includes("月蚀密钥藏在旧港钟楼");
    const hasVolumeCoverage = joined.includes("# 第一卷") && joined.includes("# 第二卷");
    const hasPlannerNotice = joined.includes("上下文规划");
    sendCompletion(response, {
      content: hasEarlyEvidence && hasVolumeCoverage && hasPlannerNotice
        ? "分层上下文验证通过：保留了跨卷概要，并召回了第一卷的月蚀密钥原文。"
        : "分层上下文验证失败：缺少早期证据、跨卷概要或规划标记。"
    });
    return;
  }
  if (latestUserMessage.includes("浏览器滚动测试")) {
    if (toolMessages.length === 0) {
      sendToolCalls(response, Array.from({ length: 8 }, (_, index) => ({
        id: `browser-scroll-${index}`,
        name: "story_index",
        arguments: { chapterOffset: index, limit: 1 }
      })));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
    sendCompletion(response, { content: `滚动测试完成。${"模型输出后应保持对话底部可见。".repeat(20)}` });
    return;
  }
  if (latestUserMessage.includes("浏览器切换竞态测试")) {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.flushHeaders();
    response.write('data: {"choices":[{"delta":{"content":"旧请求部分内容"}}]}\n\n');
    const finishTimer = setTimeout(() => {
      if (response.destroyed || response.writableEnded) return;
      response.write('data: {"choices":[{"delta":{"content":"不应进入新对话"},"finish_reason":"stop"}]}\n\n');
      response.end("data: [DONE]\n\n");
    }, 15_000);
    const stop = () => clearTimeout(finishTimer);
    request.once("aborted", stop);
    response.once("close", stop);
    return;
  }
  if (latestUserMessage.includes("浏览器网络失败测试")) {
    response.writeHead(503, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: "浏览器模拟上游不可用" } }));
    return;
  }
  if (latestUserMessage.includes("这是什么项目")) {
    const systemPrompt = messages.find((message) => message.role === "system")?.content ?? "";
    if (!systemPrompt.includes("预加载上下文为空或不足时，必须先调用工具主动查询")) {
      sendCompletion(response, { content: "当前没有上下文，无法判断项目内容。" });
      return;
    }
    if (toolMessages.length === 0) {
      sendToolCalls(response, [{ id: "browser-project-index", name: "story_index", arguments: {} }]);
      return;
    }
    const result = JSON.parse(toolMessages[0]?.content ?? "{}") as JsonObject;
    const data = result.data as JsonObject;
    const work = data.work as JsonObject;
    sendCompletion(response, { content: `这是《${String(work.title)}》，作者是 ${String(work.author)}，当前共有 ${String(work.chapterCount)} 章。` });
    return;
  }
  if (latestUserMessage.includes("浏览器工具失败测试")) {
    if (toolMessages.length === 0) {
      sendToolCalls(response, [
        { id: "browser-invalid", name: "search_story_entities", arguments: { query: "", categories: ["unknown"] } },
        { id: "browser-unknown", name: "write_chapter", arguments: {} }
      ]);
      return;
    }
    sendCompletion(response, { content: "模型已收到英文工具错误，并在不伪造结果的情况下继续回答。" });
    return;
  }
  if (latestUserMessage.includes("浏览器多轮工具测试")) {
    if (toolMessages.length === 0) {
      sendToolCalls(response, [{ id: "browser-multi-index", name: "story_index", arguments: { limit: 1 } }]);
      return;
    }
    if (toolMessages.length === 1) {
      const indexResult = JSON.parse(toolMessages[0]?.content ?? "{}") as JsonObject;
      const data = indexResult.data as JsonObject;
      const chapters = Array.isArray(data?.chapters) ? data.chapters as JsonObject[] : [];
      sendToolCalls(response, [{ id: "browser-multi-read", name: "read_chapters", arguments: { chapterIds: [String(chapters[0]?.id ?? chapterId)], include: "content" } }]);
      return;
    }
    sendCompletion(response, { content: "模型先查询目录，再读取对应章节，确认林舟启动了跃迁。" });
    return;
  }
  if (latestUserMessage.includes("浏览器工具上下文压缩测试")) {
    if (joined.includes("已压缩的工具调用上下文") && toolMessages.length > 0) {
      sendCompletion(response, { content: "工具上下文压缩后已继续完成回答。" });
      return;
    }
    if (toolMessages.length === 0) {
      sendToolCalls(response, [{ id: "browser-compact-read", name: "read_chapters", arguments: { chapterIds: [chapterId], include: "content" } }]);
      return;
    }
    sendToolCalls(response, [{ id: "browser-compact-index", name: "story_index", arguments: { chapterOffset: 0, limit: 1 } }]);
    return;
  }
  if (latestUserMessage.includes("浏览器压缩后测试")) {
    const hasStructuredMemory = joined.includes("较早对话的上下文压缩摘要")
      && joined.includes("必须遵守跃迁冷却规则")
      && joined.includes("来源：");
    sendCompletion(response, {
      content: hasStructuredMemory
        ? "长期记忆验证通过：结构化记忆保留了跃迁冷却规则及来源消息。"
        : "长期记忆验证失败：模型没有收到结构化记忆或来源消息。"
    });
    return;
  }
  sendCompletion(response, { content: "浏览器 E2E 默认响应。" });
});

mockAi.listen(0, "127.0.0.1");
await once(mockAi, "listening");
const mockAddress = mockAi.address();
if (!mockAddress || typeof mockAddress === "string") throw new Error("Mock AI server failed to start");

const runtime = createRuntime({
  databasePath: join(isolatedDirectory, "novel.db"),
  masterSecret: "browser-e2e-master-secret-at-least-32-characters",
  security: { allowPrivateAiEndpoints: true, enforceSameOrigin: false, apiRateLimit: 10_000 },
  aiStreamIdleTimeoutMs,
  aiChatTabLimit: Number(process.env.E2E_AI_CHAT_TAB_LIMIT ?? 5),
  betaVersionLabel: resolveBetaVersionLabel(process.env)
});
const registered = runtime.auth.register({ username: "browser-e2e", password: "BrowserE2E123!" });
const fixture = runWithRequestActor(registered.session.user, () => {
  const work = runtime.store.createWork({ title: "浏览器 AI E2E", author: "Codex" });
  const workId = String(work.id);
  const volume = runtime.store.createVolume(workId, { title: "第一卷" });
  const chapter = runtime.store.createChapter(workId, {
    volumeId: String(volume.id),
    title: "第一章 跃迁",
    content: `月蚀密钥藏在旧港钟楼。林舟启动了跃迁，飞船随后进入十二小时冷却。\n空格测试：半角 空格，全角　空格，Tab\t缩进。\n${"早期航行记录。".repeat(300)}`
  });
  chapterId = String(chapter.id);
  const lateVolume = runtime.store.createVolume(workId, { title: "第二卷" });
  const lateChapter = runtime.store.createChapter(workId, {
    volumeId: String(lateVolume.id),
    title: "第二章 北境追击",
    content: `舰队在北境追击敌人。${"后期战斗记录。".repeat(1_200)}`
  });
  const secondWork = runtime.store.createWork({ title: "浏览器 AI E2E 第二作品", author: "Codex" });
  const secondWorkId = String(secondWork.id);
  const secondVolume = runtime.store.createVolume(secondWorkId, { title: "第二作品卷" });
  const secondChapter = runtime.store.createChapter(secondWorkId, {
    volumeId: String(secondVolume.id),
    title: "第二作品章节",
    content: "第二作品正文不应收到第一部作品的流式回复。"
  });
  for (const [insightId, targetChapter, summary] of [
    ["browser-insight-early", chapter, "林舟在第一卷发现月蚀密钥并启动跃迁。"],
    ["browser-insight-late", lateChapter, "舰队在第二卷进入北境追击阶段。"]
  ] as const) {
    runtime.database.run(
      `INSERT INTO chapter_insights (id, chapter_id, chapter_version, summary, events_json, characters_json,
       settings_json, evidence_json, uncertainties_json, status, created_at) VALUES (?, ?, ?, ?, '[]', '[]', '[]', '[]', '[]', 'review', ?)`,
      insightId,
      String(targetChapter.id),
      Number(targetChapter.versionNo),
      summary,
      "2026-07-18T00:00:00.000Z"
    );
  }
  runtime.store.createSetting(workId, {
    title: "跃迁冷却",
    category: "世界规则",
    content: "跃迁后必须冷却十二小时。",
    locked: true,
    status: "confirmed"
  });
  const navigator = runtime.store.createCharacter(workId, { name: "林舟" });
  const observer = runtime.store.createCharacter(workId, { name: "沈星" });
  runtime.store.createRelationship(workId, {
    fromCharacterId: String(navigator.id),
    toCharacterId: String(observer.id),
    category: "social",
    subtype: "远航搭档",
    confirmationStatus: "confirmed"
  });
  const characterExtractionTask = runtime.store.createTask(workId, {
    taskType: "character-extraction",
    scope: { type: "book" }
  });
  runtime.store.updateTask(String(characterExtractionTask.id), {
    status: "completed",
    progress: 100,
    result: {
      characterIds: [],
      characterCandidates: [
        {
          candidateId: "candidate-1",
          name: "林舟",
          aliases: ["北港领航员"],
          species: "",
          identity: "远航号领航员",
          firstChapterId: String(chapter.id),
          firstEvidence: { chapterId: String(chapter.id), chapterTitle: String(chapter.title), quote: "林舟启动了跃迁" },
          stableCharacterId: String(navigator.id)
        },
        {
          candidateId: "candidate-2",
          name: "夏岚",
          aliases: ["小岚"],
          species: "",
          identity: "北港通讯员",
          firstChapterId: String(chapter.id),
          firstEvidence: { chapterId: String(chapter.id), chapterTitle: String(chapter.title), quote: "月蚀密钥藏在旧港钟楼" },
          stableCharacterId: null
        }
      ],
      candidateCount: 2,
      savedCount: 0,
      skipped: [{ name: "未命名候选", reason: "角色标准名为空，未进入入库预览" }],
      coveredChapterCount: 2,
      characterApplication: { status: "pending", totalCount: 2, generatedAt: new Date().toISOString() }
    }
  });
  const provider = runtime.ai.createProvider({
    name: "浏览器 E2E 模型",
    baseUrl: `http://127.0.0.1:${mockAddress.port}/v1`,
    apiKey: "sk-browser-e2e",
    status: "enabled",
    rpmLimit: 1_000
  });
  runtime.database.run("UPDATE providers SET connection_status = 'success' WHERE id = ?", String(provider.id));
  const model = runtime.ai.createModel(String(provider.id), {
    displayName: "浏览器 Agent 模型",
    modelId: "browser-agent-model",
    contextWindow: 4_096
  });
  const longContextModel = runtime.ai.createModel(String(provider.id), {
    displayName: "浏览器长上下文模型",
    modelId: "browser-agent-long-context-model",
    contextWindow: 128_000
  });
  runtime.ai.setTaskDefault(workId, "chat", String(model.id));
  runtime.ai.setTaskDefault(secondWorkId, "chat", String(model.id));
  runtime.store.updateWorkAiSettings(workId, { contextCompactThreshold: 50 });
  runtime.store.updateWorkAiSettings(secondWorkId, { contextCompactThreshold: 50 });
  return {
    workId,
    chapterId,
    secondWorkId,
    secondChapterId: String(secondChapter.id),
    modelId: String(model.id),
    longContextModelId: String(longContextModel.id),
    characterExtractionTaskId: String(characterExtractionTask.id)
  };
});

let compactConversationId = "";
const server = createServer((request, response) => {
  const requestUrl = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  if (requestUrl.pathname === "/__e2e/login" || requestUrl.pathname === "/__e2e/login-question-batch") {
    if (requestUrl.pathname === "/__e2e/login-question-batch") {
      runtime.database.run(
        `INSERT INTO work_ai_tool_settings (work_id, tools_json, updated_at, updated_by_user_id)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(work_id) DO UPDATE SET tools_json = excluded.tools_json,
           updated_at = excluded.updated_at, updated_by_user_id = excluded.updated_by_user_id`,
        fixture.workId,
        JSON.stringify({ ask_user_questions: true }),
        new Date().toISOString(),
        registered.session.user.userId
      );
      runtime.database.run("UPDATE models SET context_window = 128000 WHERE id = ?", fixture.modelId);
    }
    response.setHeader("Set-Cookie", `scriverse_session=${encodeURIComponent(registered.token)}; Path=/; HttpOnly; SameSite=Lax`);
    response.writeHead(302, { Location: `/#view=editor&work=${fixture.workId}&chapter=${fixture.chapterId}` });
    response.end();
    return;
  }
  if (requestUrl.pathname === "/__e2e/seed-compact") {
    if (!compactConversationId) {
      runWithRequestActor(registered.session.user, () => {
        const conversation = runtime.store.createAiConversation(fixture.workId, "上下文压缩浏览器 E2E");
        compactConversationId = String(conversation.id);
        runtime.store.addAiConversationMessage(compactConversationId, { role: "user", content: `旧作者要求：${"必须遵守跃迁冷却规则。".repeat(100)}` });
        runtime.store.addAiConversationMessage(compactConversationId, { role: "assistant", content: `旧助手回答：${"飞船仍在北港附近。".repeat(100)}` });
        runtime.store.addAiConversationMessage(compactConversationId, { role: "user", content: "最近问题：燃料状态如何？" });
        runtime.store.addAiConversationMessage(compactConversationId, { role: "assistant", content: "最近回答：正文未明确燃料余量。" });
      });
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ conversationId: compactConversationId }));
    return;
  }
  runtime.app(request, response);
});

server.listen(port, "127.0.0.1", () => {
  console.log(JSON.stringify({ ready: true, baseUrl: `http://127.0.0.1:${port}`, ...fixture }));
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  server.closeAllConnections();
  server.close();
  mockAi.closeAllConnections();
  mockAi.close();
  await runtime.close();
  await rm(isolatedDirectory, { recursive: true, force: true });
  process.exit(0);
}

process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
