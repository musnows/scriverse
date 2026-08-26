import { describe, expect, it } from "vitest";
// @ts-expect-error 浏览器端模块没有单独的类型声明，测试仅调用纯函数导出。
import { assertAiStreamCompleted, readAiEventStream } from "../../src/public/ai-stream-protocol.js";

describe("AI 客户端流协议", () => {
  it("忽略 SSE 心跳注释并继续消费业务事件", async () => {
    const body = new Response([
      ": heartbeat",
      "",
      "event: delta",
      'data: {"delta":"继续生成"}',
      "",
      ": heartbeat",
      "",
      "event: complete",
      "data: {}",
      ""
    ].join("\n")).body;
    expect(body).not.toBeNull();
    const events: Array<{ event: string; payload: unknown }> = [];

    const result = await readAiEventStream(body!, async (event: string, payload: unknown) => {
      events.push({ event, payload });
    });

    expect(events).toEqual([
      { event: "delta", payload: { delta: "继续生成" } },
      { event: "complete", payload: {} }
    ]);
    expect(() => assertAiStreamCompleted(result.completed)).not.toThrow();
  });
});
