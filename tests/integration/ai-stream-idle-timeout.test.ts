import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";
import { AppError } from "../../src/errors.js";

function openAiDelta(content: string, finishReason?: string): string {
  return `data: ${JSON.stringify({
    choices: [{
      delta: { content },
      ...(finishReason ? { finish_reason: finishReason } : {})
    }]
  })}\n\n`;
}

describe("交互式 AI 流事件空闲超时", () => {
  let runtime: Runtime;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  let workId: string;
  let modelId: string;
  let retryDelays: number[];

  beforeEach(async () => {
    retryDelays = [];
    fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "stream-model" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "连接成功" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "stream-timeout-test-secret-at-least-32-characters",
      disableUserAuth: true,
      fetchImpl: fetchMock,
      serveUi: false,
      aiStreamHeartbeatIntervalMs: 10,
      aiRetrySleep: async (delayMs) => { retryDelays.push(delayMs); }
    });
    const defaultSettings = await request(runtime.app).get("/api/platform/ai/settings").expect(200);
    expect(defaultSettings.body.data.streamIdleTimeoutSeconds).toBe(90);
    await request(runtime.app).patch("/api/platform/ai/settings").send({ streamIdleTimeoutSeconds: 30 }).expect(200);
    const work = await request(runtime.app).post("/api/works").send({ title: "流超时测试" }).expect(201);
    workId = work.body.data.id;
    const provider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
      name: "流测试供应商",
      baseUrl: "https://stream-timeout.test/v1",
      apiKey: "sk-sensitive-test-value",
      status: "enabled"
    }).expect(201);
    await request(runtime.app).post(`/api/providers/${provider.body.data.id}/test`).send({}).expect(200);
    const model = await request(runtime.app).post(`/api/providers/${provider.body.data.id}/models`).send({
      displayName: "流测试模型",
      modelId: "stream-model"
    }).expect(201);
    modelId = model.body.data.id;
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ agentTools: [] }).expect(200);
    fetchMock.mockClear();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await runtime.close();
  });

  it("平台 AI 设置拒绝低于 30 秒的流事件空闲超时", async () => {
    const response = await request(runtime.app).patch("/api/platform/ai/settings")
      .send({ streamIdleTimeoutSeconds: 29 })
      .expect(400);

    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    const settings = await request(runtime.app).get("/api/platform/ai/settings").expect(200);
    expect(settings.body.data.streamIdleTimeoutSeconds).toBe(30);
  });

  it("上游流暂时静默时持续向客户端发送 SSE 心跳", async () => {
    const encoder = new TextEncoder();
    fetchMock.mockImplementation(async (_input, init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const timer = setTimeout(() => {
          controller.enqueue(encoder.encode(openAiDelta("心跳后完成", "stop")));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }, 75);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          controller.error(init.signal?.reason);
        }, { once: true });
      }
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } }));

    const streamed = await request(runtime.app)
      .post(`/api/works/${workId}/chat/stream`)
      .send({ instruction: "等待心跳后完成", scope: { type: "none" }, modelId })
      .expect(200);

    expect(streamed.text).toContain(": heartbeat\n\n");
    expect(streamed.text).toContain("event: complete");
    expect(streamed.text).toContain("心跳后完成");
  });

  it("每 5 秒收到事件时持续超过 60 秒仍正常完成", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async (_input, init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (let index = 1; index <= 13; index += 1) {
          setTimeout(() => {
            const final = index === 13;
            controller.enqueue(encoder.encode(openAiDelta(String(index), final ? "stop" : undefined)));
            if (final) {
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            }
          }, index * 5_000);
        }
        init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
      }
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } }));

    const generatedPromise = runtime.ai.createStreamingChat({
      workId,
      instruction: "持续生成超过一分钟",
      scope: { type: "none" },
      modelId,
      maxAttempts: 1
    }, () => undefined);

    await vi.advanceTimersByTimeAsync(65_001);
    const generated = await generatedPromise;

    expect(generated.content).toBe("12345678910111213");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(runtime.database.get("SELECT status FROM ai_calls ORDER BY created_at DESC LIMIT 1"))
      .toEqual({ status: "completed" });
  });

  it("慢首事件与接近上限的事件间停顿后仍可恢复", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async (_input, init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        setTimeout(() => controller.enqueue(encoder.encode(openAiDelta("首事件"))), 29_000);
        setTimeout(() => {
          controller.enqueue(encoder.encode(openAiDelta("已恢复", "stop")));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }, 58_000);
        init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
      }
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } }));

    const generatedPromise = runtime.ai.createStreamingChat({
      workId,
      instruction: "等待慢首事件后继续",
      scope: { type: "none" },
      modelId,
      maxAttempts: 1
    }, () => undefined);

    await vi.advanceTimersByTimeAsync(58_001);

    await expect(generatedPromise).resolves.toMatchObject({ content: "首事件已恢复" });
  });

  it("首个事件等待超过 30 秒时返回明确的首事件超时", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async (_input, init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
      }
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } }));

    let failure: unknown;
    const generatedPromise = runtime.ai.createStreamingChat({
      workId,
      instruction: "等待首个事件",
      scope: { type: "none" },
      modelId,
      maxAttempts: 1
    }, () => undefined).catch((error: unknown) => {
      failure = error;
    });

    await vi.advanceTimersByTimeAsync(30_001);
    await generatedPromise;

    expect(failure).toBeInstanceOf(AppError);
    expect(failure).toMatchObject({
      status: 504,
      code: "AI_STREAM_IDLE_TIMEOUT",
      details: { phase: "first_event", idleTimeoutSeconds: 30 }
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("事件间空闲超时时保留已输出内容并只刷新一次脱敏尾部", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async (_input, init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(openAiDelta("已收到 sk-sensitive-")));
        init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
      }
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    const deltas: string[] = [];
    let failure: unknown;
    const generatedPromise = runtime.ai.createStreamingChat({
      workId,
      instruction: "等待后续事件",
      scope: { type: "none" },
      modelId,
      maxAttempts: 1
    }, (delta) => deltas.push(delta)).catch((error: unknown) => {
      failure = error;
    });

    await vi.advanceTimersByTimeAsync(30_001);
    await generatedPromise;

    expect(deltas.join("")).toBe("已收到 sk-s*****");
    expect(deltas.join("")).not.toContain("sk-sensitive-");
    expect(deltas.join("").match(/sk-s\*{5}/gu)).toHaveLength(1);
    expect(failure).toMatchObject({
      status: 504,
      code: "AI_STREAM_IDLE_TIMEOUT",
      details: { phase: "between_events", idleTimeoutSeconds: 30 }
    });
    expect(runtime.database.get("SELECT status, failure, output_chars FROM ai_calls ORDER BY created_at DESC LIMIT 1"))
      .toMatchObject({
        status: "failed",
        failure: expect.stringContaining("30 秒无新事件"),
        output_chars: "已收到 sk-s*****".length
      });
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM ai_suggestions"))
      .toEqual({ count: 0 });
  });

  it("缺少正常结束标记的上游断流与网络错误使用不同错误码", async () => {
    const encoder = new TextEncoder();
    fetchMock.mockImplementationOnce(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(openAiDelta("断流前内容")));
        controller.close();
      }
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    const closedDeltas: string[] = [];

    await expect(runtime.ai.createStreamingChat({
      workId,
      instruction: "测试上游断流",
      scope: { type: "none" },
      modelId,
      maxAttempts: 1
    }, (delta) => closedDeltas.push(delta))).rejects.toMatchObject({
      status: 502,
      code: "AI_STREAM_UPSTREAM_CLOSED"
    });
    expect(closedDeltas.join("")).toBe("断流前内容");

    fetchMock.mockImplementationOnce(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(openAiDelta("网络错误前内容")));
        setTimeout(() => controller.error(new TypeError("socket reset")), 5);
      }
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    const networkDeltas: string[] = [];

    await expect(runtime.ai.createStreamingChat({
      workId,
      instruction: "测试网络错误",
      scope: { type: "none" },
      modelId,
      maxAttempts: 1
    }, (delta) => networkDeltas.push(delta))).rejects.toMatchObject({
      status: 502,
      code: "AI_STREAM_NETWORK_ERROR"
    });
    expect(networkDeltas.join("")).toBe("网络错误前内容");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(retryDelays).toEqual([]);
  });

  it("首个流事件前的网络连接失败复用 502 重试链路", async () => {
    const encoder = new TextEncoder();
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new TypeError("connection reset"));
      }
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(openAiDelta("重连成功", "stop")));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    const deltas: string[] = [];

    await expect(runtime.ai.createStreamingChat({
      workId,
      instruction: "流连接失败后重试",
      scope: { type: "none" },
      modelId,
      maxAttempts: 1
    }, (delta) => deltas.push(delta))).resolves.toMatchObject({ content: "重连成功" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(retryDelays).toEqual([500]);
    expect(deltas.join("")).toBe("重连成功");
  });

  it("请求方取消时停止等待且不改写为超时", async () => {
    let streamStarted: (() => void) | null = null;
    const started = new Promise<void>((resolve) => { streamStarted = resolve; });
    fetchMock.mockImplementation(async (_input, init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        streamStarted?.();
        init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
      }
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    const controller = new AbortController();
    const generatedPromise = runtime.ai.createStreamingChat({
      workId,
      instruction: "取消流式请求",
      scope: { type: "none" },
      modelId,
      maxAttempts: 1,
      signal: controller.signal
    }, () => undefined);

    await started;
    controller.abort(new Error("用户已取消"));

    await expect(generatedPromise).rejects.toMatchObject({
      status: 499,
      code: "AI_STREAM_REQUEST_CANCELLED"
    });
  });

  it("非流式请求取消时保留通用 AI 调用失败语义", async () => {
    let requestStarted: (() => void) | null = null;
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    fetchMock.mockImplementation(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      requestStarted?.();
      init?.signal?.addEventListener("abort", () => {
        reject(init.signal?.reason ?? new Error("非流式调用已取消"));
      }, { once: true });
    }));
    const controller = new AbortController();
    const generatedPromise = runtime.ai.generate({
      workId,
      taskType: "chat",
      instruction: "取消非流式请求",
      scope: { type: "none" },
      modelId,
      maxAttempts: 1,
      signal: controller.signal
    });

    await started;
    controller.abort(new Error("非流式调用已取消"));

    await expect(generatedPromise).rejects.toMatchObject({
      status: 502,
      code: "AI_CALL_FAILED",
      details: { failure: "非流式调用已取消" }
    });
  });
});
