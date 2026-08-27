import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { createRuntime } from "../../src/app.js";

type JsonObject = Record<string, unknown>;
type ToolMessage = { role?: string; tool_call_id?: string; content?: string };
type CompletionBody = {
  messages?: ToolMessage[];
  tools?: Array<{ function?: { name?: string } }>;
  tool_choice?: string;
};

const checks: Array<{ feature: string; detail: string }> = [];
let chapterIds: string[] = [];
let otherWorkChapterId = "";
let characterSectionId = "";
let matrixVerified = false;
let failureFeedbackVerified = false;
let multiTurnVerified = false;
let compactRequestVerified = false;
let compactFollowupVerified = false;
let mockFailure: Error | null = null;

function checked(feature: string, detail: string): void {
  checks.push({ feature, detail });
  console.log(`[e2e-ai] ${feature}: ${detail}`);
}

function object(value: unknown): JsonObject {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as JsonObject;
}

function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

async function readRequest(incoming: IncomingMessage): Promise<CompletionBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as CompletionBody;
}

function completion(outgoing: ServerResponse, message: JsonObject): void {
  outgoing.writeHead(200, { "Content-Type": "application/json" });
  outgoing.end(JSON.stringify({ choices: [{ message }], usage: { completion_tokens: 24 } }));
}

function toolCalls(outgoing: ServerResponse, calls: Array<{ id: string; name: string; arguments: unknown }>): void {
  completion(outgoing, {
    content: null,
    tool_calls: calls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments }
    }))
  });
}

function toolResults(body: CompletionBody): Map<string, JsonObject> {
  return new Map((body.messages ?? [])
    .filter((message) => message.role === "tool")
    .map((message) => [String(message.tool_call_id), object(JSON.parse(message.content ?? "{}") as unknown)]));
}

const mockAi = createServer(async (incoming, outgoing) => {
  try {
    if (incoming.url === "/v1/models") {
      outgoing.writeHead(200, { "Content-Type": "application/json" });
      outgoing.end(JSON.stringify({ data: [{ id: "e2e-agent-model" }] }));
      return;
    }
    if (incoming.url !== "/v1/chat/completions" || incoming.method !== "POST") {
      outgoing.writeHead(404).end();
      return;
    }
    const body = await readRequest(incoming);
    const messages = body.messages ?? [];
    const joined = messages.map((message) => message.content ?? "").join("\n");
    const results = toolResults(body);
    if (joined.includes("E2E_TOOL_MATRIX")) {
      if (results.size === 0) {
        assert.deepEqual(body.tools?.map((tool) => tool.function?.name), ["story_index", "read_chapters", "grep", "search_story_entities", "read_character_sections", "search_drafts"]);
        toolCalls(outgoing, [
          { id: "index-default", name: "story_index", arguments: {} },
          { id: "index-boundary", name: "story_index", arguments: JSON.stringify({ offset: 1, limit: 50 }) },
          { id: "chapter-summary", name: "read_chapters", arguments: { chapterIds: [chapterIds[0]], include: "summary" } },
          { id: "chapter-content", name: "read_chapters", arguments: { chapterIds: chapterIds.slice(0, 2), include: "content" } },
          { id: "chapter-both", name: "read_chapters", arguments: { chapterIds, include: "both" } },
          { id: "chapter-errors", name: "read_chapters", arguments: { chapterIds: [chapterIds[0], "missing-chapter", otherWorkChapterId] } },
          { id: "knowledge-default", name: "search_story_entities", arguments: { query: "跃迁" } },
          { id: "knowledge-all", name: "search_story_entities", arguments: { query: "跃迁", categories: ["setting", "character", "race", "organization", "timeline", "relationship", "outline", "foreshadow"] } },
          { id: "character-section", name: "read_character_sections", arguments: { sectionIds: [characterSectionId], include: "both" } }
        ]);
        return;
      }
      assert.equal(results.size, 9);
      assert.deepEqual(object(object(results.get("index-default")).data).offset, 0);
      assert.equal(array(object(object(results.get("index-boundary")).data).chapters).length, 2);
      const summaryChapter = object(array(object(object(results.get("chapter-summary")).data).chapters)[0]);
      assert.ok("summary" in summaryChapter);
      assert.ok(!("content" in summaryChapter));
      const contentChapter = object(array(object(object(results.get("chapter-content")).data).chapters)[0]);
      assert.ok("content" in contentChapter);
      assert.ok(!("summary" in contentChapter));
      const bothChapters = array(object(object(results.get("chapter-both")).data).chapters).map(object);
      assert.equal(bothChapters.length, 3);
      assert.ok(bothChapters.every((chapter) => "summary" in chapter && "content" in chapter));
      const errorChapters = array(object(object(results.get("chapter-errors")).data).chapters).map(object);
      assert.equal(object(errorChapters[1]?.error).message, "The requested chapter was not found.");
      assert.equal(object(errorChapters[2]?.error).message, "The requested chapter belongs to a different work.");
      assert.deepEqual(object(results.get("knowledge-default")).ok, true);
      assert.equal(object(object(results.get("knowledge-default")).data).matchMode, "hybrid_exact_phonetic");
      const defaultMatches = array(object(object(results.get("knowledge-default")).data).matches).map(object);
      assert.equal(defaultMatches.some((item) => String(item.type) === "setting" && String(item.title).includes("跃迁")), true);
      assert.equal(array(object(object(results.get("knowledge-all")).data).matches).length >= 1, true);
      assert.equal(object(object(results.get("knowledge-all")).data).matchMode, "hybrid_exact_phonetic");
      const characterSection = object(array(object(object(results.get("character-section")).data).sections)[0]);
      assert.equal(characterSection.characterName, "哥斯拉");
      assert.match(String(characterSection.contentMarkdown), /守护地球生态/u);
      matrixVerified = true;
      completion(outgoing, { content: "模型已读取并正确处理全部九组工具结果。" });
      return;
    }
    if (joined.includes("E2E_TOOL_ERRORS")) {
      if (results.size === 0) {
        toolCalls(outgoing, [
          { id: "bad-json", name: "story_index", arguments: "{" },
          { id: "bad-index", name: "story_index", arguments: { limit: 0, extra: true } },
          { id: "bad-read", name: "read_chapters", arguments: { chapterIds: [], include: "invalid" } },
          { id: "bad-query", name: "search_story_entities", arguments: { query: "", categories: ["unknown"] } },
          { id: "unknown", name: "write_chapter", arguments: {} }
        ]);
        return;
      }
      assert.equal(results.size, 5);
      for (const result of results.values()) {
        assert.equal(result.ok, false);
        const error = object(result.error);
        assert.match(String(error.code), /^[A-Z_]+$/u);
        assert.match(String(error.message), /Invalid|not available/u);
      }
      failureFeedbackVerified = true;
      completion(outgoing, { content: "模型已收到并正确处理英文工具错误。" });
      return;
    }
    if (joined.includes("E2E_MULTI_TURN")) {
      if (results.size === 0) {
        toolCalls(outgoing, [{ id: "multi-index", name: "story_index", arguments: { limit: 1 } }]);
        return;
      }
      if (results.has("multi-read")) {
        const readData = object(object(results.get("multi-read")).data);
        assert.match(String(object(array(readData.chapters)[0]).content), /林舟启动跃迁/u);
        multiTurnVerified = true;
        completion(outgoing, { content: "已先定位章节，再根据正文确认林舟启动了跃迁。" });
        return;
      }
      if (results.has("multi-index")) {
        const indexData = object(object(results.get("multi-index")).data);
        const firstChapter = object(array(indexData.chapters)[0]);
        assert.equal(firstChapter.id, chapterIds[0]);
        toolCalls(outgoing, [{ id: "multi-read", name: "read_chapters", arguments: { chapterIds: [String(firstChapter.id)], include: "content" } }]);
        return;
      }
      throw new Error("Expected multi-turn tool results were not found.");
    }
    if (joined.includes("结构化中文长期记忆")) {
      assert.equal(body.tools, undefined);
      compactRequestVerified = true;
      completion(outgoing, { content: '<json>{"authorGoals":[],"confirmedDecisions":[],"storyFacts":[{"text":"最近仍在确认燃料状态","sourceMessageIds":[]}],"constraints":[{"text":"必须遵守跃迁冷却规则","sourceMessageIds":[]}],"unresolvedQuestions":[],"importantReferences":[]}</json>' });
      return;
    }
    if (joined.includes("E2E_AFTER_COMPACT")) {
      assert.match(joined, /较早对话的上下文压缩摘要/u);
      assert.match(joined, /遵守跃迁冷却规则/u);
      assert.doesNotMatch(joined, /旧作者要求/u);
      assert.equal(joined.match(/E2E_AFTER_COMPACT/gu)?.length, 1);
      compactFollowupVerified = true;
      completion(outgoing, { content: "已基于长期记忆和最近对话继续回答。" });
      return;
    }
    completion(outgoing, { content: "E2E 默认响应。" });
  } catch (error) {
    mockFailure = error instanceof Error ? error : new Error(String(error));
    outgoing.writeHead(500, { "Content-Type": "application/json" });
    outgoing.end(JSON.stringify({ error: mockFailure.message }));
  }
});

const dataRoot = join(process.cwd(), ".data");
await mkdir(dataRoot, { recursive: true });
const isolatedDirectory = await mkdtemp(join(dataRoot, "e2e-ai-agent-tools-"));
let runtime: ReturnType<typeof createRuntime> | null = null;
let appServer: ReturnType<ReturnType<typeof createRuntime>["app"]["listen"]> | null = null;

try {
  mockAi.listen(0, "127.0.0.1");
  await once(mockAi, "listening");
  const mockAddress = mockAi.address();
  assert.ok(mockAddress && typeof mockAddress !== "string");
  runtime = createRuntime({
    databasePath: join(isolatedDirectory, "novel.db"),
    masterSecret: "e2e-agent-tools-master-secret-at-least-32-characters",
    disableUserAuth: true,
    security: { allowPrivateAiEndpoints: true, enforceSameOrigin: false, apiRateLimit: 10_000 }
  });
  appServer = runtime.app.listen(0, "127.0.0.1");
  await once(appServer, "listening");
  const address = appServer.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  async function api<T = JsonObject>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${baseUrl}/api${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    });
    const payload = await response.json() as JsonObject;
    if (!response.ok) throw new Error(`${method} ${path} failed with ${response.status}: ${JSON.stringify(payload)}`);
    return (payload.data ?? payload) as T;
  }

  const health = await api<JsonObject>("GET", "/health");
  assert.equal(health.status, "ok");
  const page = await fetch(baseUrl).then((response) => response.text());
  const application = await fetch(`${baseUrl}/app.js`).then((response) => response.text());
  assert.match(page, /id="ai-tool-call-dialog"/u);
  assert.match(page, /id="ai-context-warning"/u);
  assert.match(application, /调用了 \$\{name\} 工具/u);
  assert.match(application, /eventName === "context"/u);
  assert.match(application, /eventName === "user_message"/u);
  checked("ui-assets", "tool detail dialog and context compaction controls are served by the real app");

  const work = await api<JsonObject>("POST", "/works", { title: "AI 工具 E2E" });
  const workId = String(work.id);
  const volume = await api<JsonObject>("POST", `/works/${workId}/volumes`, { title: "第一卷" });
  for (const [index, content] of ["林舟启动跃迁。", "飞船进入冷却阶段。", "北港记录了返回信标。"].entries()) {
    const chapter = await api<JsonObject>("POST", `/works/${workId}/chapters`, {
      volumeId: String(volume.id),
      title: `第${index + 1}章`,
      content
    });
    chapterIds.push(String(chapter.id));
  }
  await api("POST", `/works/${workId}/settings`, { title: "跃迁冷却", category: "世界规则", content: "跃迁后必须冷却十二小时。", locked: true, status: "confirmed" });
  const character = await api<JsonObject>("POST", `/works/${workId}/characters`, { name: "哥斯拉" });
  const characterSection = await api<JsonObject>("POST", `/characters/${String(character.id)}/sections`, {
    sectionType: "background",
    title: "背景故事",
    summary: "哥斯拉的远古经历",
    contentMarkdown: "## 远古时期\n\n哥斯拉守护地球生态。"
  });
  characterSectionId = String(characterSection.id);
  const otherWork = await api<JsonObject>("POST", "/works", { title: "隔离作品" });
  const otherVolume = await api<JsonObject>("POST", `/works/${String(otherWork.id)}/volumes`, { title: "外卷" });
  const otherChapter = await api<JsonObject>("POST", `/works/${String(otherWork.id)}/chapters`, { volumeId: String(otherVolume.id), title: "外章", content: "不得越权读取。" });
  otherWorkChapterId = String(otherChapter.id);

  const provider = await api<JsonObject>("POST", `/works/${workId}/providers`, {
    name: "E2E Agent Provider",
    baseUrl: `http://127.0.0.1:${mockAddress.port}/v1`,
    apiKey: "sk-e2e-agent-tools",
    status: "enabled",
    rpmLimit: 1_000
  });
  await api("POST", `/providers/${String(provider.id)}/test`, {});
  const model = await api<JsonObject>("POST", `/providers/${String(provider.id)}/models`, {
    displayName: "E2E Agent Model",
    modelId: "e2e-agent-model",
    contextWindow: 32_768,
    preset: { max_tokens: 4_096 }
  });
  const modelId = String(model.id);
  await api("PATCH", `/works/${workId}/ai-settings`, {
    agentTools: ["story_index", "read_chapters", "grep", "search_story_entities", "read_character_sections", "search_drafts"]
  });

  const matrix = await api<JsonObject>("POST", `/works/${workId}/suggestions`, {
    taskType: "chat",
    instruction: "E2E_TOOL_MATRIX",
    scope: { type: "chapter", chapterId: chapterIds[0] },
    modelId
  });
  assert.equal(matrix.content, "模型已读取并正确处理全部九组工具结果。");
  assert.equal(array(matrix.toolCalls).length, 9);
  assert.equal(matrixVerified, true);
  checked("tool-arguments", "all optional/default/boundary parameter combinations reached the model as structured results");

  const failed = await api<JsonObject>("POST", `/works/${workId}/suggestions`, {
    taskType: "chat",
    instruction: "E2E_TOOL_ERRORS",
    scope: { type: "chapter", chapterId: chapterIds[0] },
    modelId
  });
  assert.equal(failed.content, "模型已收到并正确处理英文工具错误。");
  assert.equal(array(failed.toolCalls).every((call) => object(call).status === "failed"), true);
  assert.equal(failureFeedbackVerified, true);
  checked("tool-errors", "invalid JSON, invalid schemas, unavailable tools, missing chapters, and cross-work reads return model-readable English errors");

  const streamResponse = await fetch(`${baseUrl}/api/works/${workId}/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ instruction: "E2E_MULTI_TURN", scope: { type: "chapter", chapterId: chapterIds[0] }, modelId })
  });
  assert.equal(streamResponse.status, 200);
  const streamText = await streamResponse.text();
  assert.equal((streamText.match(/event: tool_call/gu) ?? []).length, 2);
  assert.match(streamText, /"name":"story_index"/u);
  assert.match(streamText, /"name":"read_chapters"/u);
  assert.match(streamText, /event: delta\ndata: \{"delta":"已先定位章节，再根据正文确认林舟启动了跃迁。"\}/u);
  assert.match(streamText, /event: complete/u);
  assert.equal(multiTurnVerified, true);
  const completePayload = object(JSON.parse(streamText.match(/event: complete\ndata: ([^\n]+)/u)?.[1] ?? "{}") as unknown);
  assert.equal(array(completePayload.toolCalls).length, 2);
  const conversation = await api<JsonObject>("POST", `/works/${workId}/ai-conversations`, {});
  await api("POST", `/ai-conversations/${String(conversation.id)}/messages`, {
    role: "assistant",
    content: "已先定位章节，再根据正文确认林舟启动了跃迁。",
    metadata: { modelDisplayName: "E2E Agent Model", outputTokens: 24, toolCalls: completePayload.toolCalls }
  });
  const persisted = await api<JsonObject>("GET", `/ai-conversations/${String(conversation.id)}`);
  const persistedMessage = object(array(persisted.messages)[0]);
  assert.equal(array(object(persistedMessage.metadata).toolCalls).length, 2);
  checked("multi-turn-sse", "the model consumed one tool result before choosing the next tool, while SSE and history retained both details");

  const maximumThreshold = await api<JsonObject>("PATCH", `/works/${workId}/ai-settings`, { contextCompactThreshold: 90 });
  assert.equal(maximumThreshold.contextCompactThreshold, 90);
  const maximumToolCalls = await api<JsonObject>("PATCH", `/works/${workId}/ai-settings`, { agentToolCallLimit: 80 });
  assert.equal(maximumToolCalls.agentToolCallLimit, 80);
  const rejectedThreshold = await fetch(`${baseUrl}/api/works/${workId}/ai-settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contextCompactThreshold: 91 })
  });
  assert.equal(rejectedThreshold.status, 400);
  const rejectedToolCalls = await fetch(`${baseUrl}/api/works/${workId}/ai-settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentToolCallLimit: 81 })
  });
  assert.equal(rejectedToolCalls.status, 400);
  const rejectedToolCallsPayload = object(await rejectedToolCalls.json());
  assert.equal(object(rejectedToolCallsPayload.error).message, "Agent 工具调用上限不能超过 80 次");
  const rejectedLowToolCalls = await fetch(`${baseUrl}/api/works/${workId}/ai-settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentToolCallLimit: 4 })
  });
  assert.equal(rejectedLowToolCalls.status, 400);
  const rejectedMultiplier = await fetch(`${baseUrl}/api/works/${workId}/ai-settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentToolCallGlobalMultiplier: 0 })
  });
  assert.equal(rejectedMultiplier.status, 400);
  const rejectedHighMultiplier = await fetch(`${baseUrl}/api/works/${workId}/ai-settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentToolCallGlobalMultiplier: 7 })
  });
  assert.equal(rejectedHighMultiplier.status, 400);
  const minimumMultiplier = await api<JsonObject>("PATCH", `/works/${workId}/ai-settings`, { agentToolCallGlobalMultiplier: 1 });
  assert.equal(minimumMultiplier.agentToolCallGlobalMultiplier, 1);
  const maximumMultiplier = await api<JsonObject>("PATCH", `/works/${workId}/ai-settings`, { agentToolCallGlobalMultiplier: 6 });
  assert.equal(maximumMultiplier.agentToolCallGlobalMultiplier, 6);
  await api("PATCH", `/works/${workId}/ai-settings`, { contextCompactThreshold: 50 });
  await api("PATCH", `/works/${workId}/ai-settings`, { agentToolCallLimit: 12, agentToolCallGlobalMultiplier: 3 });
  const compactConversation = await api<JsonObject>("POST", `/works/${workId}/ai-conversations`, { title: "压缩 E2E" });
  const conversationId = String(compactConversation.id);
  for (const [role, content] of [
    ["user", `旧作者要求：${"必须遵守跃迁冷却规则。".repeat(800)}`],
    ["assistant", `旧助手回答：${"飞船仍在北港附近。".repeat(800)}`],
    ["user", "最近问题：燃料状态如何？"],
    ["assistant", "最近回答：正文未明确燃料余量。"]
  ] as const) {
    await api("POST", `/ai-conversations/${conversationId}/messages`, { role, content });
  }
  const prepareBody = { modelId, scope: { type: "chapter", chapterId: chapterIds[0] }, instruction: "继续回答。" };
  const warned = await api<JsonObject>("POST", `/ai-conversations/${conversationId}/context/prepare`, prepareBody);
  assert.equal(warned.action, "warn");
  const contextUsage = object(warned.usage);
  assert.equal(contextUsage.compactRecommended, true);
  assert.equal(Number(contextUsage.usagePercent) >= 50, true);
  assert.equal(contextUsage.contextWarningPending, true);
  const ignored = await api<JsonObject>("POST", `/ai-conversations/${conversationId}/context/prepare`, {
    ...prepareBody,
    ignoreContextWarning: true
  });
  assert.equal(ignored.action, "ready");
  assert.equal(ignored.reason, "warning_ignored");
  const compacted = await api<JsonObject>("POST", `/ai-conversations/${conversationId}/compact`, {
    modelId,
    scope: prepareBody.scope
  });
  assert.equal(compacted.changed, true);
  assert.equal(compacted.compactedMessageCount, 2);
  assert.equal(compactRequestVerified, true);
  const current = await api<JsonObject>("POST", `/ai-conversations/${conversationId}/messages`, { role: "user", content: "E2E_AFTER_COMPACT" });
  const followup = await fetch(`${baseUrl}/api/works/${workId}/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ instruction: "E2E_AFTER_COMPACT", scope: { type: "chapter", chapterId: chapterIds[0] }, modelId, conversationId, currentMessageId: current.id })
  });
  assert.equal(followup.status, 200);
  assert.match(await followup.text(), /已基于长期记忆和最近对话继续回答/u);
  assert.equal(compactFollowupVerified, true);
  checked("context-compact", "threshold 90 is accepted, 91 is rejected, the first overage warns, and the ignored warning triggers compaction before the next prompt");

  if (mockFailure) throw mockFailure;
  console.log(JSON.stringify({ ok: true, checks }, null, 2));
} finally {
  if (appServer) {
    appServer.closeAllConnections();
    appServer.close();
    await once(appServer, "close");
  }
  await runtime?.close();
  mockAi.close();
  if (mockAi.listening) await once(mockAi, "close");
  await rm(isolatedDirectory, { recursive: true, force: true });
}
