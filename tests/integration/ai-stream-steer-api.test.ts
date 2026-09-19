import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AI_STEER_INSTRUCTION_HEADING } from "../../src/ai-stream-steer.js";
import { createTestRuntime } from "../helpers.js";
import type { Runtime } from "../../src/app.js";

function openAiDelta(content: string, finishReason?: string): string {
  return `data: ${JSON.stringify({
    choices: [{
      delta: { content },
      ...(finishReason ? { finish_reason: finishReason } : {})
    }]
  })}\n\n`;
}

describe("AI 执行流引导 API", () => {
  let runtime!: Runtime;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  let workId: string;
  let modelId: string;
  let generationCount: number;

  beforeEach(async () => {
    generationCount = 0;
    fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "mock-novel-model" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        stream?: boolean;
        max_tokens?: number;
        messages?: Array<{ role?: string; content?: string }>;
      };
      if (body.max_tokens === 10) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "连接成功" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      generationCount += 1;
      const round = generationCount;
      const joined = (body.messages ?? []).map((message) => String(message.content ?? "")).join("\n");
      if (round === 1) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode(openAiDelta("北港夜色")));
            const abort = (): void => {
              try {
                controller.error(init?.signal?.reason ?? new Error("aborted"));
              } catch {
                /* already closed */
              }
            };
            if (init?.signal?.aborted) abort();
            else init?.signal?.addEventListener("abort", abort, { once: true });
          }
        }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      expect(joined).toContain(AI_STEER_INSTRUCTION_HEADING);
      expect(joined).toContain("改成沈星视角");
      expect(joined).toContain("北港夜色");
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(openAiDelta("沈星站在甲板上", "stop")));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    });
    runtime = createTestRuntime(fetchMock);
    const work = await request(runtime.app).post("/api/works").send({ title: "引导测试作品" }).expect(201);
    workId = work.body.data.id;
    const provider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
      name: "本地兼容服务",
      baseUrl: "https://mock-ai.test/v1/chat/completions",
      apiKey: "sk-sensitive-test-value",
      status: "enabled"
    }).expect(201);
    const model = await request(runtime.app).post(`/api/providers/${provider.body.data.id}/models`).send({
      displayName: "小说模型",
      modelId: "mock-novel-model"
    }).expect(201);
    modelId = model.body.data.id;
    await request(runtime.app).post(`/api/providers/${provider.body.data.id}/test`).send({}).expect(200);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ agentTools: [] }).expect(200);
  });

  afterEach(async () => {
    await runtime?.close();
  });

  it("没有正在执行的回复时拒绝引导", async () => {
    const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    const idle = await request(runtime.app).post(`/api/ai-conversations/${conversation.body.data.id}/steer`).send({
      content: "改成沈星视角"
    }).expect(409);
    expect(idle.body.error).toMatchObject({ code: "AI_STEER_NO_ACTIVE_STREAM" });
    const empty = await request(runtime.app).post(`/api/ai-conversations/${conversation.body.data.id}/steer`).send({
      content: "   "
    }).expect(400);
    expect(empty.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("执行中接受引导并实时作用于当前流，且不会把当前回复打断成失败", async () => {
    const conversation = await request(runtime.app).post(`/api/works/${workId}/ai-conversations`).send({}).expect(201);
    const conversationId = String(conversation.body.data.id);
    const streamPromise = request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "继续写港口",
      scope: { type: "none" },
      modelId,
      conversationId
    }).expect(200).expect("Content-Type", /text\/event-stream/u).then((response) => response);
    await vi.waitFor(() => {
      expect(generationCount).toBe(1);
    }, { timeout: 5_000 });
    const concurrent = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "这是排队以外的第二轮，不能打断",
      scope: { type: "none" },
      modelId,
      conversationId
    }).expect(409);
    expect(concurrent.body.error).toMatchObject({ code: "AI_CONVERSATION_RESPONSE_IN_PROGRESS" });
    const steered = await request(runtime.app).post(`/api/ai-conversations/${conversationId}/steer`).send({
      content: "改成沈星视角"
    }).expect(202);
    expect(steered.body.data).toMatchObject({
      conversationId,
      content: "改成沈星视角",
      status: "pending"
    });
    expect(steered.body.data.id).toMatch(/^steer_/u);
    const streamed = await streamPromise;
    expect(streamed.text).toContain("event: steer");
    expect(streamed.text).toContain("改成沈星视角");
    expect(streamed.text).toContain('"kind":"steer"');
    expect(streamed.text).toContain("北港夜色");
    expect(streamed.text).toContain("沈星站在甲板上");
    expect(streamed.text).toContain("event: complete");
    expect(streamed.text).not.toContain("event: error");
    expect(generationCount).toBe(2);
    const saved = await request(runtime.app).get(`/api/ai-conversations/${conversationId}`).expect(200);
    const messages = saved.body.data.messages as Array<{ role: string; content: string; metadata?: { kind?: string } }>;
    expect(messages.some((message) => message.role === "user" && message.content === "改成沈星视角" && message.metadata?.kind === "steer")).toBe(true);
    expect(messages.map((message) => message.content).join("\n")).toContain("沈星站在甲板上");
  });
});
