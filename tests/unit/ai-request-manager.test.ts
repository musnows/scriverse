import { describe, expect, it } from "vitest";
// @ts-expect-error 浏览器端模块没有单独的类型声明，测试仅调用纯函数导出。
import { aiRequestTargetsState, createAiRequestAbortError, createAiRequestManager, isAiRequestCancellation } from "../../src/public/ai-request-manager.js";

describe("AI 请求生命周期", () => {
  it.each(["finish", "cancel", "cancelAll"])("waits for the original request before a question continuation (%s)", async (action) => {
    const manager = createAiRequestManager();
    const request = manager.begin({ tabId: "tab-a", workId: "work-a" });
    let settled = false;
    const idle = manager.whenIdle("tab-a").then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await manager.whenIdle("tab-b");
    expect(manager.isCurrent(request)).toBe(true);
    if (action === "finish") manager.finish(request);
    else if (action === "cancel") manager.cancel("Cancelled", "tab-a");
    else manager.cancelAll("Cancelled");
    await idle;
    expect(settled).toBe(true);
    expect(manager.hasActive("tab-a")).toBe(false);
  });

  it("为连续请求分配递增代次并取消旧请求", () => {
    const manager = createAiRequestManager();
    const first = manager.begin({ workId: "work-a", conversationId: "conversation-a" });
    const second = manager.begin({ workId: "work-a", conversationId: "conversation-b" });

    expect(first.generation).toBe(1);
    expect(second.generation).toBe(2);
    expect(first.signal.aborted).toBe(true);
    expect(isAiRequestCancellation(first.signal.reason, first)).toBe(true);
    expect(manager.isCurrent(first)).toBe(false);
    expect(manager.isCurrent(second)).toBe(true);
  });

  it("用不可变快照绑定服务端返回的对话和用户消息", () => {
    const manager = createAiRequestManager();
    const started = manager.begin({ workId: "work-a" });
    const conversationBound = manager.bind(started, { conversationId: "conversation-a" });
    const messageBound = manager.bind(conversationBound, { userMessageId: "message-a" });

    expect(Object.isFrozen(started)).toBe(true);
    expect(Object.isFrozen(conversationBound)).toBe(true);
    expect(Object.isFrozen(messageBound)).toBe(true);
    expect(started).toMatchObject({ conversationId: null, userMessageId: null });
    expect(conversationBound).toMatchObject({ conversationId: "conversation-a", userMessageId: null });
    expect(messageBound).toMatchObject({ conversationId: "conversation-a", userMessageId: "message-a" });
    expect(messageBound.signal).toBe(started.signal);
    expect(manager.isCurrent(messageBound)).toBe(true);
  });

  it("拒绝让失效代次重新绑定或结束当前请求", () => {
    const manager = createAiRequestManager();
    const stale = manager.begin({ workId: "work-a", conversationId: "conversation-a" });
    const current = manager.begin({ workId: "work-a", conversationId: "conversation-b" });

    expect(() => manager.bind(stale, { userMessageId: "message-a" })).toThrow(/请求已失效/u);
    expect(manager.finish(stale)).toBe(false);
    expect(manager.isCurrent(current)).toBe(true);
    expect(manager.finish(current)).toBe(true);
    expect(manager.hasActive()).toBe(false);
  });

  it("同时校验作品和已绑定对话，未绑定对话只校验作品", () => {
    const manager = createAiRequestManager();
    const unbound = manager.begin({ workId: "work-a" });

    expect(aiRequestTargetsState(unbound, { workId: "work-a", conversationId: "conversation-new" })).toBe(true);
    expect(aiRequestTargetsState(unbound, { workId: "work-b", conversationId: null })).toBe(false);

    const bound = manager.bind(unbound, { conversationId: "conversation-a" });
    expect(aiRequestTargetsState(bound, { workId: "work-a", conversationId: "conversation-a" })).toBe(true);
    expect(aiRequestTargetsState(bound, { workId: "work-a", conversationId: "conversation-b" })).toBe(false);
  });

  it("区分主动取消和普通网络异常", () => {
    const manager = createAiRequestManager();
    const request = manager.begin({ workId: "work-a" });
    const cancellation = createAiRequestAbortError("切换作品");

    expect(isAiRequestCancellation(cancellation, request)).toBe(true);
    expect(isAiRequestCancellation(new TypeError("network failed"), request)).toBe(false);
    expect(manager.cancel("切换作品")).toBe(true);
    expect(request.signal.aborted).toBe(true);
    expect(manager.cancel("重复取消")).toBe(false);
  });

  it("允许不同页签的请求并发且互不取消", () => {
    const manager = createAiRequestManager();
    const first = manager.begin({ tabId: "tab-a", workId: "work-a", conversationId: "conversation-a" });
    const second = manager.begin({ tabId: "tab-b", workId: "work-a", conversationId: "conversation-b" });

    expect(manager.isCurrent(first)).toBe(true);
    expect(manager.isCurrent(second)).toBe(true);
    expect(manager.hasActive("tab-a")).toBe(true);
    expect(manager.hasActive("tab-b")).toBe(true);
    expect(first.signal.aborted).toBe(false);
    expect(second.signal.aborted).toBe(false);

    expect(manager.cancel("关闭页签", "tab-a")).toBe(true);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    expect(manager.isCurrent(second)).toBe(true);
  });

  it("可以一次取消作品下的全部页签请求", () => {
    const manager = createAiRequestManager();
    const first = manager.begin({ tabId: "tab-a", workId: "work-a" });
    const second = manager.begin({ tabId: "tab-b", workId: "work-a" });

    expect(manager.cancelAll("切换作品")).toBe(2);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(manager.hasActive()).toBe(false);
  });
});
