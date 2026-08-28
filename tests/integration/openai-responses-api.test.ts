import { randomBytes } from "node:crypto";
import request from "supertest";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime } from "../helpers.js";

describe("OpenAI Responses 与 Anthropic 多模态请求层", () => {
  let runtime: Runtime;
  let workId: string;
  let chapterId: string;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(async () => {
    fetchMock = vi.fn<typeof fetch>();
    runtime = createTestRuntime(fetchMock);
    const work = await request(runtime.app).post("/api/works").send({ title: "协议请求测试作品" }).expect(201);
    workId = String(work.body.data.id);
    const volume = await request(runtime.app).post(`/api/works/${workId}/volumes`).send({ title: "第一卷" }).expect(201);
    const chapter = await request(runtime.app).post(`/api/works/${workId}/chapters`).send({
      volumeId: String(volume.body.data.id),
      title: "第一章",
      content: "一张图片记录了北港的航线。"
    }).expect(201);
    chapterId = String(chapter.body.data.id);
  });

  afterEach(async () => {
    await runtime.close();
  });

  it("由后端返回供应商协议选项及其能力", async () => {
    const response = await request(runtime.app).get("/api/platform/ai/protocols").expect(200);
    expect(response.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({
        value: "openai-responses",
        label: "OpenAI Responses",
        defaultBaseUrl: "https://api.openai.com/v1",
        credentialKind: "api-key",
        supportsMultimodal: true,
        supportsMaxCompletionTokens: false
      }),
      expect.objectContaining({
        value: "anthropic-messages",
        supportsMultimodal: true
      }),
      expect.objectContaining({
        value: "google-vertex",
        credentialKind: "service-account-json"
      })
    ]));
  });

  it("Anthropic Messages 模型连接测试发送官方图片块并允许多模态配置", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "claude-vision" }] }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as {
        model?: string;
        max_tokens?: number;
        messages?: Array<{ content?: unknown }>;
      };
      expect(body.model).toBe("claude-vision");
      expect(body.max_tokens).toBe(10);
      const content = body.messages?.[0]?.content;
      expect(content).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "text" }),
        expect.objectContaining({ type: "image", source: expect.objectContaining({ type: "base64", media_type: "image/png" }) })
      ]));
      return new Response(JSON.stringify({
        content: [{ type: "text", text: "图片连接成功" }],
        stop_reason: "end_turn"
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const provider = await request(runtime.app).post("/api/platform/ai/providers").send({
      name: "Anthropic 图片服务",
      protocol: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-anthropic-vision-test",
      status: "enabled"
    }).expect(201);
    const model = await request(runtime.app).post(`/api/providers/${provider.body.data.id}/models`).send({
      displayName: "Claude Vision",
      modelId: "claude-vision",
      multimodalEnabled: true
    }).expect(201);
    expect(model.body.data.multimodalEnabled).toBe(true);

    const result = await request(runtime.app).post(`/api/models/${model.body.data.id}/test`).send({}).expect(200);
    expect(result.body.data, JSON.stringify(result.body.data)).toMatchObject({ ok: true, multimodalTested: true });
    expect(new Headers(fetchMock.mock.calls.at(-1)?.[1]?.headers).get("x-api-key")).toBe("sk-anthropic-vision-test");
  });

  it("Anthropic Messages 聊天请求把真实图片作为 base64 image block 发送", async () => {
    let generationSeen = false;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "claude-chat-vision" }] }), { status: 200 });
      const body = JSON.parse(String(init?.body)) as {
        max_tokens?: number;
        messages?: Array<{ role?: string; content?: unknown }>;
      };
      if (body.max_tokens === 10) {
        return new Response(JSON.stringify({ content: [{ type: "text", text: "图片连接成功" }], stop_reason: "end_turn" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      const userMessage = body.messages?.find((message) => message.role === "user" && Array.isArray(message.content));
      const userContent = Array.isArray(userMessage?.content)
        ? userMessage.content as Array<{ type?: string; text?: string; source?: Record<string, unknown> }>
        : [];
      expect(userContent[0]).toEqual({
        type: "image",
        source: expect.objectContaining({ type: "base64", media_type: "image/png" })
      });
      expect(userContent.filter((block) => block.type === "text").map((block) => block.text).join("\n"))
        .toContain("请描述这张图片");
      generationSeen = true;
      return new Response(JSON.stringify({
        content: [{ type: "text", text: "我看到了图片中的深色背景和白色文字。" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 20, output_tokens: 8 }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2z94AAAAASUVORK5CYII=", "base64");
    const uploaded = await request(runtime.app)
      .post(`/api/works/${workId}/attachments?module=ai-chat`)
      .attach("file", png, { filename: "聊天图片.png", contentType: "image/png" })
      .expect(201);
    const provider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
      name: "Anthropic 聊天图片服务",
      protocol: "anthropic-messages",
      baseUrl: "https://anthropic-chat-image.test",
      apiKey: "sk-anthropic-chat-image-test",
      status: "enabled"
    }).expect(201);
    const model = await request(runtime.app).post(`/api/providers/${provider.body.data.id}/models`).send({
      displayName: "Anthropic 聊天图片模型",
      modelId: "claude-chat-vision",
      multimodalEnabled: true
    }).expect(201);
    await request(runtime.app).post(`/api/providers/${provider.body.data.id}/test`).send({}).expect(200);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ agentTools: [] }).expect(200);

    const stream = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "请描述这张图片",
      scope: { type: "none" },
      modelId: model.body.data.id,
      imageAttachmentIds: [uploaded.body.data.id]
    }).expect(200);
    expect(stream.text).toContain("我看到了图片中的深色背景和白色文字");
    expect(generationSeen).toBe(true);
  });

  it("OpenAI Responses 发送 input_image、reasoning.effort，并解析流式思考与正文", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "gpt-5" }] }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as {
        input?: Array<Record<string, unknown>>;
        max_output_tokens?: number;
        reasoning?: { effort?: string };
        stream?: boolean;
      };
      expect(body.max_output_tokens).toBeGreaterThan(0);
      expect(body.reasoning).toEqual({ effort: "high" });
      if (body.max_output_tokens === 10) {
        const inputItems = body.input ?? [];
        const userMessage = inputItems.find((item) => item.role === "user");
        expect(userMessage).toMatchObject({
          content: expect.arrayContaining([
            { type: "input_text", text: "请识别这张测试图片，并回复“图片连接成功”。" },
            { type: "input_image", image_url: expect.stringMatching(/^data:image\/png;base64,/u), detail: "low" }
          ])
        });
        return new Response(JSON.stringify({
          status: "completed",
          output: [
            { type: "reasoning", summary: [{ type: "summary_text", text: "先确认图片内容。" }] },
            { type: "message", role: "assistant", content: [{ type: "output_text", text: "图片连接成功" }] }
          ],
          usage: { input_tokens: 20, output_tokens: 8 }
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (body.stream) {
        return new Response([
          'data: {"type":"response.reasoning_summary_text.delta","delta":"先确认。"}',
          'data: {"type":"response.output_text.delta","delta":"Responses 流式回复"}',
          'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":12,"output_tokens":6}}}'
        ].join("\n\n") + "\n\n", {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        });
      }
      return new Response(JSON.stringify({
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "普通回复" }] }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const provider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
      name: "OpenAI Responses 服务",
      protocol: "openai-responses",
      baseUrl: "https://api.openai.com",
      apiKey: "sk-responses-test",
      status: "enabled"
    }).expect(201);
    const model = await request(runtime.app).post(`/api/providers/${provider.body.data.id}/models`).send({
      displayName: "GPT Responses Vision",
      modelId: "gpt-5",
      thinkingEffort: "high",
      multimodalEnabled: true
    }).expect(201);
    const modelTest = await request(runtime.app).post(`/api/models/${model.body.data.id}/test`).send({}).expect(200);
    expect(modelTest.body.data).toMatchObject({ ok: true, multimodalTested: true });

    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ agentTools: [] }).expect(200);
    const stream = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "概括图片测试结果。",
      scope: { type: "chapter", chapterId },
      modelId: model.body.data.id
    }).expect(200);
    expect(stream.headers["content-type"]).toMatch(/text\/event-stream/u);
    expect(stream.text).toContain("Responses 流式回复");
    expect(stream.text).toContain('"type":"thinking"');
    expect(stream.text).toContain("先确认。");
  });

  it("聊天附件通过上传 ID 进入 OpenAI Responses 图片块，并拒绝非多模态模型", async () => {
    let imageRequestSeen = false;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "gpt-5-chat-vision" }] }), { status: 200 });
      const body = JSON.parse(String(init?.body)) as {
        input?: Array<Record<string, unknown>>;
        tools?: Array<{ name?: string }>;
        max_output_tokens?: number;
        stream?: boolean;
      };
      if (body.max_output_tokens === 10) {
        return new Response(JSON.stringify({
          status: "completed",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "连接成功" }] }]
        }), { status: 200 });
      }
      const userMessage = body.input?.find((item) => item.role === "user"
        && Array.isArray(item.content)
        && (item.content as Array<Record<string, unknown>>).some((part) => part.type === "input_image"));
      const imagePart = (userMessage?.content as Array<Record<string, unknown>> | undefined)
        ?.find((part) => part.type === "input_image");
      expect(imagePart?.image_url).toMatch(/^data:image\/(?:png|webp);base64,/u);
      expect(body.tools?.some((tool) => tool.name === "image")).toBe(true);
      expect(JSON.stringify(body.input)).toContain("本轮作者消息已经直接附带原生图片内容");
      imageRequestSeen = true;
      if (!body.stream) throw new Error("聊天请求必须使用流式模式");
      return new Response([
        'data: {"type":"response.output_text.delta","delta":"已收到图片。"}',
        'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":18,"output_tokens":5}}}'
      ].join("\n\n") + "\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } });
    });

    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2z94AAAAASUVORK5CYII=", "base64");
    const uploaded = await request(runtime.app)
      .post(`/api/works/${workId}/attachments?module=ai-chat`)
      .attach("file", png, { filename: "聊天图片.png", contentType: "image/png" })
      .expect(201);
    const attachmentId = String(uploaded.body.data.id);
    const provider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
      name: "聊天图片 Responses 服务",
      protocol: "openai-responses",
      baseUrl: "https://responses-chat-image.test/v1",
      apiKey: "sk-responses-chat-image-test",
      status: "enabled"
    }).expect(201);
    const model = await request(runtime.app).post(`/api/providers/${provider.body.data.id}/models`).send({
      displayName: "聊天图片模型",
      modelId: "gpt-5-chat-vision",
      multimodalEnabled: true
    }).expect(201);
    const modelId = String(model.body.data.id);
    await request(runtime.app).post(`/api/providers/${provider.body.data.id}/test`).send({}).expect(200);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ agentTools: ["image"] }).expect(200);

    const stream = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "请描述这张图片。",
      scope: { type: "none" },
      modelId,
      imageAttachmentIds: [attachmentId]
    }).expect(200);
    expect(stream.text).toContain("已收到图片");
    expect(stream.text).toContain(attachmentId);
    expect(imageRequestSeen).toBe(true);

    const textModel = await request(runtime.app).post(`/api/providers/${provider.body.data.id}/models`).send({
      displayName: "文本模型",
      modelId: "gpt-5-chat-text",
      multimodalEnabled: false
    }).expect(201);
    const rejected = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "请描述这张图片。",
      scope: { type: "none" },
      modelId: textModel.body.data.id,
      imageAttachmentIds: [attachmentId]
    }).expect(400);
    expect(rejected.body.error).toMatchObject({ code: "MODEL_NOT_MULTIMODAL" });
  });

  it("多轮聊天会重新把历史图片放回 OpenAI Responses 请求", async () => {
    const imageCounts: number[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "gpt-5-history-vision" }] }), { status: 200 });
      const body = JSON.parse(String(init?.body)) as {
        input?: Array<Record<string, unknown>>;
        max_output_tokens?: number;
        stream?: boolean;
      };
      if (body.max_output_tokens === 10) {
        return new Response(JSON.stringify({
          status: "completed",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "连接成功" }] }]
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const imageCount = (body.input ?? [])
        .flatMap((item) => Array.isArray(item.content) ? item.content : [])
        .filter((part) => (part as Record<string, unknown>).type === "input_image").length;
      imageCounts.push(imageCount);
      expect(body.stream).toBe(true);
      return new Response([
        'data: {"type":"response.output_text.delta","delta":"我能看到这张图片。"}',
        'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":18,"output_tokens":5}}}'
      ].join("\n\n") + "\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } });
    });

    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2z94AAAAASUVORK5CYII=", "base64");
    const uploaded = await request(runtime.app)
      .post(`/api/works/${workId}/attachments?module=ai-chat`)
      .attach("file", png, { filename: "历史图片.png", contentType: "image/png" })
      .expect(201);
    const provider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
      name: "Responses 历史图片服务",
      protocol: "openai-responses",
      baseUrl: "https://responses-history-image.test/v1",
      apiKey: "sk-responses-history-image-test",
      status: "enabled"
    }).expect(201);
    const model = await request(runtime.app).post(`/api/providers/${provider.body.data.id}/models`).send({
      displayName: "Responses 历史图片模型",
      modelId: "gpt-5-history-vision",
      multimodalEnabled: true
    }).expect(201);
    await request(runtime.app).post(`/api/providers/${provider.body.data.id}/test`).send({}).expect(200);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ agentTools: [] }).expect(200);

    const first = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "请看这张图片",
      scope: { type: "none" },
      modelId: model.body.data.id,
      imageAttachmentIds: [uploaded.body.data.id]
    }).expect(200);
    const firstComplete = JSON.parse(first.text.match(/event: complete\ndata: ([^\n]+)/u)?.[1] ?? "{}");
    const conversationId = String(firstComplete.conversationId);
    expect(conversationId).not.toBe("");

    const second = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "上一张图片里写了什么？",
      scope: { type: "none" },
      modelId: model.body.data.id,
      conversationId
    }).expect(200);
    expect(second.text).toContain("我能看到这张图片");
    expect(imageCounts).toEqual([1, 1]);
  });

  it("多模态聊天首轮不按图片 base64 估算上下文，并用服务端 usage 更新上下文", async () => {
    let imageRequestSeen = false;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "gpt-5-context-vision" }] }), { status: 200 });
      const body = JSON.parse(String(init?.body)) as {
        input?: Array<Record<string, unknown>>;
        max_output_tokens?: number;
        stream?: boolean;
      };
      if (body.max_output_tokens === 10) {
        return new Response(JSON.stringify({
          status: "completed",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "连接成功" }] }]
        }), { status: 200 });
      }
      const imagePart = (body.input ?? [])
        .flatMap((item) => Array.isArray(item.content) ? item.content : [])
        .find((part) => (part as Record<string, unknown>).type === "input_image") as Record<string, unknown> | undefined;
      expect(imagePart?.image_url).toMatch(/^data:image\/jpeg;base64,/u);
      expect(String(imagePart?.image_url).length).toBeGreaterThan(200_000);
      expect(body.stream).toBe(true);
      imageRequestSeen = true;
      return new Response([
        'data: {"type":"response.output_text.delta","delta":"已按服务端上下文处理。"}',
        'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":4321,"output_tokens":7}}}'
      ].join("\n\n") + "\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } });
    });

    const pixels = randomBytes(512 * 512 * 3);
    const jpeg = await sharp(pixels, { raw: { width: 512, height: 512, channels: 3 } })
      .jpeg({ quality: 100, chromaSubsampling: "4:4:4" })
      .toBuffer();
    const uploaded = await request(runtime.app)
      .post(`/api/works/${workId}/attachments?module=ai-chat`)
      .attach("file", jpeg, { filename: "上下文计量.jpg", contentType: "image/jpeg" })
      .expect(201);
    const provider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
      name: "Responses 上下文计量服务",
      protocol: "openai-responses",
      baseUrl: "https://responses-context.test/v1",
      apiKey: "sk-responses-context-test",
      status: "enabled"
    }).expect(201);
    const model = await request(runtime.app).post(`/api/providers/${provider.body.data.id}/models`).send({
      displayName: "Responses 上下文计量模型",
      modelId: "gpt-5-context-vision",
      multimodalEnabled: true
    }).expect(201);
    const modelId = String(model.body.data.id);
    await request(runtime.app).patch(`/api/models/${modelId}`).send({ contextWindow: 32_768 }).expect(200);
    await request(runtime.app).post(`/api/providers/${provider.body.data.id}/test`).send({}).expect(200);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({ agentTools: [] }).expect(200);

    const stream = await request(runtime.app).post(`/api/works/${workId}/chat/stream`).send({
      instruction: "请读取图片并概括。",
      scope: { type: "none" },
      modelId,
      imageAttachmentIds: [String(uploaded.body.data.id)]
    }).expect(200);
    const completeData = stream.text.match(/event: complete\ndata: ([^\n]+)/u)?.[1];
    const complete = JSON.parse(completeData ?? "{}") as {
      contextUsage?: {
        inputTokens?: number;
        outputTokens?: number;
        usagePercent?: number;
        contextUsageSource?: string;
        tokenDistribution?: { outputTokens?: number };
      };
    };
    expect(imageRequestSeen).toBe(true);
    expect(complete.contextUsage).toMatchObject({
      inputTokens: 4_321,
      outputTokens: 7,
      usagePercent: 13,
      contextUsageSource: "reported",
      tokenDistribution: { outputTokens: 7 }
    });
  });

  it("聊天图片附件只接受 PNG、JPG、JPEG", async () => {
    const png = await sharp({
      create: { width: 2, height: 2, channels: 3, background: { r: 32, g: 96, b: 160 } }
    }).png().toBuffer();
    const jpeg = await sharp(png).jpeg().toBuffer();
    for (const [filename, content, contentType] of [
      ["聊天图片.png", png, "image/png"],
      ["聊天图片.jpg", jpeg, "image/jpeg"]
    ] as const) {
      const uploaded = await request(runtime.app)
        .post(`/api/works/${workId}/attachments?module=ai-chat`)
        .attach("file", content, { filename, contentType })
        .expect(201);
      expect(uploaded.body.data).toMatchObject({ originalMimeType: contentType, storedMimeType: contentType });
    }

    const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
    const webp = await sharp(png).webp().toBuffer();
    for (const [filename, content, contentType] of [
      ["聊天图片.gif", gif, "image/gif"],
      ["聊天图片.webp", webp, "image/webp"]
    ] as const) {
      const rejected = await request(runtime.app)
        .post(`/api/works/${workId}/attachments?module=ai-chat`)
        .attach("file", content, { filename, contentType })
        .expect(415);
      expect(rejected.body.error).toEqual({
        code: "UNSUPPORTED_ATTACHMENT",
        message: "AI 对话图片附件仅支持 PNG、JPG、JPEG 图片"
      });
    }
  });

  it("聊天图片上传使用独立的 5 MB 默认上限", async () => {
    const rejected = await request(runtime.app)
      .post(`/api/works/${workId}/attachments?module=ai-chat`)
      .attach("file", Buffer.alloc(5 * 1024 * 1024 + 1), { filename: "超大聊天图片.png", contentType: "image/png" })
      .expect(413);
    expect(rejected.body.error).toEqual({
      code: "ATTACHMENT_TOO_LARGE",
      message: "图片附件不能超过 5 MB"
    });
  });

  it("OpenAI Responses 的 image 工具发送附件图片并保留工具调用上下文", async () => {
    let requestedAttachmentId = "";
    let generationCount = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "gpt-5-vision" }] }), { status: 200 });
      const body = JSON.parse(String(init?.body)) as {
        input?: Array<Record<string, unknown>>;
        tools?: Array<Record<string, unknown>>;
        max_output_tokens?: number;
      };
      const inputItems = body.input ?? [];
      const hasImage = inputItems.some((item) => Array.isArray(item.content)
        && (item.content as Array<Record<string, unknown>>).some((part) => part.type === "input_image"));
      if (body.max_output_tokens === 10) {
        expect(hasImage).toBe(false);
        return new Response(JSON.stringify({
          status: "completed",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "连接成功" }] }]
        }), { status: 200 });
      }
      if (hasImage) {
        const imagePart = inputItems.flatMap((item) => Array.isArray(item.content) ? item.content : [])
          .find((part) => (part as Record<string, unknown>).type === "input_image") as Record<string, unknown> | undefined;
        expect(imagePart?.image_url).toMatch(/^data:image\/png;base64,/u);
        expect(inputItems.some((item) => item.type === "function_call_output")).toBe(true);
        expect(JSON.stringify(inputItems)).toContain("native_multimodal");
        return new Response(JSON.stringify({
          status: "completed",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "图片显示一座蓝色行星。" }] }]
        }), { status: 200 });
      }
      expect(body.tools?.some((tool) => tool.name === "image")).toBe(true);
      generationCount += 1;
      if (generationCount === 1) {
        return new Response(JSON.stringify({
          status: "completed",
          output: [{
            type: "function_call",
            call_id: "responses-image-call",
            name: "image",
            arguments: JSON.stringify({ attachmentId: requestedAttachmentId })
          }]
        }), { status: 200 });
      }
      expect(inputItems.some((item) => item.type === "function_call_output")).toBe(true);
      return new Response(JSON.stringify({
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "已读取设定图片。" }] }]
      }), { status: 200 });
    });

    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2z94AAAAASUVORK5CYII=", "base64");
    const uploaded = await request(runtime.app)
      .post(`/api/works/${workId}/attachments?module=settings`)
      .attach("file", png, { filename: "Responses 星图.png", contentType: "image/png" })
      .expect(201);
    requestedAttachmentId = String(uploaded.body.data.id);
    await request(runtime.app).post(`/api/works/${workId}/settings`).send({
      title: "Responses 星图",
      category: "地图",
      content: `![星图](attachment://${requestedAttachmentId})`
    }).expect(201);

    const provider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
      name: "Responses 图片服务",
      protocol: "openai-responses",
      baseUrl: "https://responses-image.test/v1",
      apiKey: "sk-responses-image-test",
      status: "enabled"
    }).expect(201);
    const model = await request(runtime.app).post(`/api/providers/${provider.body.data.id}/models`).send({
      displayName: "Responses 图片模型",
      modelId: "gpt-5-vision",
      thinkingEffort: "high",
      multimodalEnabled: true,
      imageToolDefault: true
    }).expect(201);
    const modelId = String(model.body.data.id);
    await request(runtime.app).post(`/api/providers/${provider.body.data.id}/test`).send({}).expect(200);
    await request(runtime.app).patch(`/api/works/${workId}/ai-settings`).send({
      agentTools: ["image"],
      imageToolModelId: modelId
    }).expect(200);

    const result = await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "chat",
      instruction: "读取 Responses 星图。",
      scope: { type: "none" },
      modelId
    }).expect(201);
    expect(result.body.data.content).toContain("图片显示一座蓝色行星");
    expect(result.body.data.toolCalls).toEqual([expect.objectContaining({
      name: "image",
      status: "completed",
      result: { ok: true, data: expect.objectContaining({ delivery: "native_multimodal" }) }
    })]);
  });
});
