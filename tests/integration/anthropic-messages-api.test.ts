import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime } from "../helpers.js";

describe("Anthropic Messages 供应商", () => {
  let runtime: Runtime;
  let workId: string;
  let chapterId: string;
  let providerId: string;
  let modelId: string;
  let completionCount: number;
  let streaming = false;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(async () => {
    completionCount = 0;
    fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer longcat-test-key");
      expect(headers.get("x-api-key")).toBe("longcat-test-key");
      expect(headers.get("anthropic-version")).toBe("2023-06-01");

      if (url === "https://api.longcat.chat/anthropic/v1/models") {
        return new Response(JSON.stringify({ error: { message: "not found" } }), { status: 404 });
      }
      if (url === "https://api.longcat.chat/v1/models") {
        return new Response(JSON.stringify({ data: [{ id: "LongCat-2.0" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      expect(url).toBe("https://api.longcat.chat/anthropic/v1/messages");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.model).toBe("LongCat-2.0");
      expect(body.messages).toBeInstanceOf(Array);
      if (body.max_tokens === 10) {
        expect(body.messages).toHaveLength(1);
        return new Response(JSON.stringify({
          id: "msg_probe",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "连接成功" }],
          stop_reason: "end_turn"
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      expect(body.system).toEqual(expect.stringContaining("小说作者的创作协作助手"));
      expect(body.thinking).toEqual({ type: "enabled" });
      expect((body.messages as Array<{ role: string }>).some((message) => message.role === "system")).toBe(false);

      if (streaming) {
        expect(body.stream).toBe(true);
        expect(body).not.toHaveProperty("stream_options");
        return new Response([
          'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":20,"cache_read_input_tokens":10}}}',
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"先检查上下文。"}}',
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
          'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"LongCat"}}',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" 流式响应"}}',
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":6}}',
          'event: message_stop\ndata: {"type":"message_stop"}'
        ].join("\n\n"), { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }

      completionCount += 1;
      if (completionCount === 1) {
        expect(body.tools).toEqual(expect.arrayContaining([
          expect.objectContaining({
            name: "story_index",
            input_schema: expect.objectContaining({ type: "object" })
          })
        ]));
        expect(body.tool_choice).toEqual({ type: "auto" });
        return new Response(JSON.stringify({
          id: "msg_longcat_tool",
          type: "message",
          role: "assistant",
          content: [
            { type: "thinking", thinking: "需要读取作品目录。", signature: "longcat-signed-thinking" },
            { type: "text", text: "我先读取目录。" },
            { type: "tool_use", id: "toolu_longcat", name: "story_index", input: { limit: 1 } }
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 40, output_tokens: 12 }
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      const messages = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
      const assistant = messages.find((message) => message.role === "assistant");
      expect(assistant?.content).toEqual(expect.arrayContaining([
        { type: "thinking", thinking: "需要读取作品目录。", signature: "longcat-signed-thinking" },
        { type: "tool_use", id: "toolu_longcat", name: "story_index", input: { limit: 1 } }
      ]));
      const toolResult = messages.find((message) => message.role === "user" && message.content.some((block) => block.type === "tool_result"));
      expect(toolResult?.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_longcat" });
      return new Response(JSON.stringify({
        id: "msg_longcat_final",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "LongCat 已读取目录。", thinking: "工具结果足够回答。" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 80, output_tokens: 9 }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    runtime = createTestRuntime(fetchMock);
    const work = await request(runtime.app).post("/api/works").send({ title: "Anthropic 测试作品" }).expect(201);
    workId = work.body.data.id;
    const volume = await request(runtime.app).post(`/api/works/${workId}/volumes`).send({ title: "第一卷" }).expect(201);
    const chapter = await request(runtime.app).post(`/api/works/${workId}/chapters`).send({
      volumeId: volume.body.data.id,
      title: "第一章",
      content: "林舟抵达北港。"
    }).expect(201);
    chapterId = chapter.body.data.id;

    const provider = await request(runtime.app).post("/api/platform/ai/providers").send({
      name: "LongCat Messages",
      protocol: "anthropic-messages",
      baseUrl: "https://api.longcat.chat/anthropic",
      apiKey: "longcat-test-key",
      status: "enabled"
    }).expect(201);
    providerId = provider.body.data.id;
    expect(provider.body.data).toMatchObject({
      protocol: "anthropic-messages",
      baseUrl: "https://api.longcat.chat/anthropic",
      maxTokensParameter: "max_tokens"
    });
    const model = await request(runtime.app).post(`/api/providers/${providerId}/models`).send({
      displayName: "LongCat 2.0",
      modelId: "LongCat-2.0"
    }).expect(201);
    modelId = model.body.data.id;
    const tested = await request(runtime.app).post(`/api/providers/${providerId}/test`).send({}).expect(200);
    expect(tested.body.data).toMatchObject({ ok: true, availableModels: ["LongCat-2.0"] });
  });

  afterEach(async () => {
    await runtime.close();
  });

  it("通过 LongCat Messages 格式完成工具调用与普通响应", async () => {
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ agentTools: ["story_index"] }).expect(200);
    const suggestion = await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "读取目录后回答。",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(201);
    expect(suggestion.body.data).toMatchObject({
      content: "LongCat 已读取目录。",
      outputTokens: 9,
      toolCalls: [expect.objectContaining({ id: "toolu_longcat", name: "story_index", status: "completed" })]
    });
    expect(suggestion.body.data.processSteps).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "thinking", content: "需要读取作品目录。" }),
      expect.objectContaining({ type: "intermediate", content: "我先读取目录。" }),
      expect.objectContaining({ type: "thinking", content: "工具结果足够回答。" })
    ]));
    expect(completionCount).toBe(2);
    const usage = await request(runtime.app).get(`/api/works/${workId}/ai-settings/usage`).expect(200);
    expect(usage.body.data.summary).toMatchObject({
      totalTokens: 141,
      inputTokens: 120,
      outputTokens: 21,
      requestCount: 1,
      estimatedRequestCount: 0
    });
  });

  it("回答挂起提问时把作者回答作为原 Anthropic tool_result 继续同一消息", async () => {
    await request(runtime.app).put(`/api/works/${workId}/ai/tools`).send({
      tools: { ask_user_questions: true, settings: true }
    }).expect(200);
    const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    const conversationId = String(conversation.body.data.id);
    let questionCompletionCount = 0;
    const questionRequestBodies: Array<{
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
      tools?: Array<{ name?: string }>;
    }> = [];
    fetchMock.mockImplementation(async (_input, init) => {
      questionCompletionCount += 1;
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
        tools?: Array<{ name?: string }>;
      };
      questionRequestBodies.push(body);
      if (questionCompletionCount === 1) {
        return new Response([
          'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":20}}}',
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_question","name":"ask_user_question","input":{"question":"采用哪个方向？","options":["甲","乙"]}}}',
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":8}}',
          'event: message_stop\ndata: {"type":"message_stop"}'
        ].join("\n\n"), { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }

      return new Response([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":30}}}',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"已按回答继续。"}}',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":6}}',
        'event: message_stop\ndata: {"type":"message_stop"}'
      ].join("\n\n"), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    });

    await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "先询问再继续",
      scope: { type: "chapter", chapterId },
      modelId,
      conversationId
    }).expect(200);
    const questions = await request(runtime.app).get(`/api/works/${workId}/ai/questions?conversationId=${conversationId}`).expect(200);
    const questionId = String(questions.body.data.questions[0].id);
    const suspendedAssistant = runtime.database.get<{ metadata_json: string }>(
      "SELECT metadata_json FROM ai_conversation_messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1",
      conversationId
    );
    expect(JSON.parse(String(suspendedAssistant?.metadata_json ?? "{}"))).not.toHaveProperty("anthropicContent");

    const answered = await request(runtime.app).post(`/api/works/${workId}/ai/questions/${questionId}/answer`)
      .send({ selectedOption: 0 })
      .expect(200);
    expect(answered.body.data).toMatchObject({ status: "answered", resumeState: "completed", selectedOptionLabel: "甲" });
    expect(questionCompletionCount).toBe(2);
    expect(questionRequestBodies[0]?.tools?.some((tool) => tool.name === "ask_user_question")).toBe(true);
    const resumedBody = questionRequestBodies[1];
    expect(resumedBody).toBeDefined();
    const assistantIndex = resumedBody?.messages.findIndex((message) => (
      message.role === "assistant" && message.content.some((block) => block.type === "tool_use" && block.id === "toolu_question")
    )) ?? -1;
    expect(assistantIndex).toBeGreaterThanOrEqual(0);
    const toolResultMessage = resumedBody?.messages[assistantIndex + 1];
    expect(toolResultMessage?.role).toBe("user");
    expect(toolResultMessage?.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_question" });
    expect(String(toolResultMessage?.content[0]?.content ?? "")).toContain('"selectedOptionLabel":"甲"');
    const completedMessages = runtime.database.all<{ role: string; content: string; metadata_json: string }>(
      "SELECT role, content, metadata_json FROM ai_conversation_messages WHERE conversation_id = ? ORDER BY created_at, rowid",
      conversationId
    );
    expect(completedMessages).toHaveLength(2);
    expect(completedMessages[1]).toMatchObject({ role: "assistant", content: "已按回答继续。" });
    const completedMetadata = JSON.parse(String(completedMessages[1]?.metadata_json ?? "{}"));
    expect(completedMetadata.toolCalls).toMatchObject([
      { id: "toolu_question", name: "ask_user_question", result: { question: { status: "answered", answerText: "甲" } } }
    ]);
    expect(completedMetadata.anthropicContent).toEqual([
      { type: "text", text: "已按回答继续。" }
    ]);
  });

  it("模型连通性测试通过 Anthropic output_config 透传自动思考强度", async () => {
    const updated = await request(runtime.app).patch(`/api/models/${modelId}`).send({ thinkingEffort: "auto" }).expect(200);
    expect(updated.body.data.thinkingEffort).toBe("auto");

    const tested = await request(runtime.app).post(`/api/models/${modelId}/test`).send({}).expect(200);
    expect(tested.body.data.ok).toBe(true);
    const completionCall = fetchMock.mock.calls.findLast(([input]) => String(input) === "https://api.longcat.chat/anthropic/v1/messages");
    expect(completionCall).toBeDefined();
    const body = JSON.parse(String(completionCall?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      max_tokens: 10,
      thinking: { type: "enabled" },
      output_config: { effort: "auto" }
    });
  });

  it("Anthropic Messages 拒绝切换 max_completion_tokens", async () => {
    const response = await request(runtime.app).patch(`/api/providers/${providerId}`).send({
      maxTokensParameter: "max_completion_tokens"
    }).expect(400);
    expect(response.body.error).toMatchObject({ code: "INVALID_MAX_TOKENS_PARAMETER" });
    const provider = await request(runtime.app).get(`/api/providers/${providerId}`).expect(200);
    expect(provider.body.data.maxTokensParameter).toBe("max_tokens");
  });

  it("Anthropic 工具参数在 content_block_stop 前只拼接，收齐后才执行并继续流式回答", async () => {
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ agentTools: ["story_index"] }).expect(200);
    let releaseToolBlock = (): void => undefined;
    const toolBlockGate = new Promise<void>((resolve) => {
      releaseToolBlock = resolve;
    });
    let firstRoundFinished = false;
    let streamedCompletionCount = 0;
    fetchMock.mockImplementation(async (_input, init) => {
      streamedCompletionCount += 1;
      const body = JSON.parse(String(init?.body)) as {
        stream?: boolean;
        tools?: Array<{ name?: string }>;
        messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
      };
      expect(body.stream).toBe(true);
      expect(body.tools?.some((tool) => tool.name === "story_index")).toBe(true);
      if (streamedCompletionCount === 1) {
        return new Response(new ReadableStream<Uint8Array>({
          async start(controller) {
            const encoder = new TextEncoder();
            const send = (payload: Record<string, unknown>): void => {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
            };
            send({ type: "message_start", message: { usage: { input_tokens: 20 } } });
            send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
            send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "我先读取目录。" } });
            send({ type: "content_block_stop", index: 0 });
            send({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_stream", name: "story_index", input: {} } });
            send({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"lim' } });
            await toolBlockGate;
            send({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'it":1}' } });
            send({ type: "content_block_stop", index: 1 });
            send({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } });
            send({ type: "message_stop" });
            firstRoundFinished = true;
            controller.close();
          }
        }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      const assistant = body.messages.find((message) => message.role === "assistant");
      expect(assistant?.content).toEqual(expect.arrayContaining([
        { type: "tool_use", id: "toolu_stream", name: "story_index", input: { limit: 1 } }
      ]));
      const toolResult = body.messages.find((message) => (
        message.role === "user" && message.content.some((block) => block.type === "tool_result")
      ));
      expect(toolResult?.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_stream" });
      return new Response([
        { type: "message_start", message: { usage: { input_tokens: 30 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "已读取" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "目录。" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } },
        { type: "message_stop" }
      ].map((payload) => `data: ${JSON.stringify(payload)}`).join("\n\n") + "\n\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      });
    });

    const deltas: string[] = [];
    const toolEvents: Array<{ arguments: unknown }> = [];
    const generatedPromise = runtime.ai.createStreamingChat({
      workId,
      instruction: "读取目录后回答。",
      scope: { type: "chapter", chapterId },
      modelId,
      onToolCall: (toolCall) => toolEvents.push({ arguments: toolCall.arguments })
    }, (delta) => deltas.push(delta));
    const safetyRelease = setTimeout(releaseToolBlock, 1_000);
    for (let index = 0; index < 100 && deltas.length === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(deltas).toEqual(["我先读取目录。"]);
    expect(toolEvents).toHaveLength(0);
    expect(firstRoundFinished).toBe(false);
    releaseToolBlock();
    clearTimeout(safetyRelease);

    const generated = await generatedPromise;
    expect(deltas).toEqual(["我先读取目录。", "已读取", "目录。"]);
    expect(generated.content).toBe("已读取目录。");
    expect(generated.toolCalls).toEqual([
      expect.objectContaining({ id: "toolu_stream", name: "story_index", arguments: { chapterOffset: 0, limit: 1 }, status: "completed" })
    ]);
    expect(toolEvents).toEqual([{ arguments: { chapterOffset: 0, limit: 1 } }]);
    expect(streamedCompletionCount).toBe(2);
  });

  it("解析 LongCat Messages SSE 的思考、正文与用量", async () => {
    streaming = true;
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ agentTools: [] }).expect(200);
    const response = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "进行流式测试。",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(200).expect("Content-Type", /text\/event-stream/u);
    expect(response.text).toContain('event: delta\ndata: {"delta":"LongCat"}');
    expect(response.text).toContain('event: delta\ndata: {"delta":" 流式响应"}');
    expect(response.text).toContain('"type":"thinking","round":1,"content":"先检查上下文。"');
    expect(response.text).toContain('"outputTokens":6,"cacheHitPercent":33.3');
    const suggestions = await request(runtime.app).get(`/api/works/${workId}/suggestions`).expect(200);
    expect(suggestions.body.data[0].content).toBe("LongCat 流式响应");
    const usage = await request(runtime.app).get(`/api/works/${workId}/ai-settings/usage`).expect(200);
    expect(usage.body.data.summary).toMatchObject({
      totalTokens: 36,
      inputTokens: 30,
      outputTokens: 6,
      cachedInputTokens: 10,
      directInputTokens: 20,
      cacheReadInputTokens: 10,
      cacheWriteInputTokens: 0,
      cacheEligibleInputTokens: 30,
      cacheHitRate: 33.3
    });
  });

  it("流式收集 tool_use 参数、执行工具并继续输出正文", async () => {
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ agentTools: ["story_index"] }).expect(200);
    let streamRound = 0;
    fetchMock.mockImplementation(async (input, init) => {
      expect(String(input)).toBe("https://api.longcat.chat/anthropic/v1/messages");
      const body = JSON.parse(String(init?.body)) as {
        stream?: boolean;
        tools?: Array<{ name?: string }>;
        tool_choice?: Record<string, unknown>;
        messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
      };
      expect(body.stream).toBe(true);
      expect(body.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "story_index" })]));
      expect(body.tool_choice).toEqual({ type: "auto" });
      streamRound += 1;
      if (streamRound === 1) {
        return new Response([
          'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":30}}}',
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"先读取目录。"}}',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"stream-signature"}}',
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
          'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_stream","name":"story_index","input":{}}}',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"lim"}}',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"it\\":1}"}}',
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":8}}',
          'event: message_stop\ndata: {"type":"message_stop"}'
        ].join("\n\n"), { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }

      const assistant = body.messages.find((message) => message.role === "assistant");
      expect(assistant?.content).toEqual(expect.arrayContaining([
        { type: "thinking", thinking: "先读取目录。", signature: "stream-signature" },
        { type: "tool_use", id: "toolu_stream", name: "story_index", input: { limit: 1 } }
      ]));
      const toolResult = body.messages.find((message) => message.role === "user"
        && message.content.some((block) => block.type === "tool_result"));
      expect(toolResult?.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_stream" });
      return new Response([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":50}}}',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"已读取"}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"目录。"}}',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
        'event: message_stop\ndata: {"type":"message_stop"}'
      ].join("\n\n"), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    });

    const response = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "读取目录后回答。",
      scope: { type: "chapter", chapterId },
      modelId
    }).expect(200).expect("Content-Type", /text\/event-stream/u);

    expect(streamRound).toBe(2);
    expect(response.text).toContain('event: tool_call');
    expect(response.text).toContain('"id":"toolu_stream","name":"story_index"');
    expect(response.text).toContain('event: delta\ndata: {"delta":"已读取"}');
    expect(response.text).toContain('event: delta\ndata: {"delta":"目录。"}');
    expect(response.text.indexOf("event: tool_call")).toBeLessThan(response.text.indexOf('"delta":"已读取"'));
    const suggestions = await request(runtime.app).get(`/api/works/${workId}/suggestions`).expect(200);
    expect(suggestions.body.data[0].content).toBe("已读取目录。");
  });
});
