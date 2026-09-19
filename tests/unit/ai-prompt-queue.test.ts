import { describe, expect, it } from "vitest";
// @ts-expect-error 浏览器端模块没有单独的类型声明，测试仅调用纯函数导出。
import { AI_PROMPT_QUEUE_LIMIT, aiPromptQueueDragPayload, aiPromptQueuePreview, canSendQueuedPromptAsSteer, createAiPromptQueue, moveQueuedPromptItem, moveQueuedPromptItemByOffset, parseAiPromptQueueDragPayload, queuedPromptEditContent, queuedPromptEditPatch, queuedPromptSteerContent } from "../../src/public/ai-prompt-queue.js";

describe("AI Prompt 排队", () => {
  it("把执行中的 Prompt 排到队尾，且没有打断当前执行的接口", () => {
    const queue = createAiPromptQueue();
    const first = queue.enqueue("tab-a", { text: "先写港口" });
    const second = queue.enqueue("tab-a", { text: "再写冷却" });
    expect(queue.list("tab-a").map((item: { text: string }) => item.text)).toEqual(["先写港口", "再写冷却"]);
    expect(queue.takeNext("tab-a")).toEqual(first);
    expect(queue.list("tab-a")).toEqual([second]);
    expect(queue).not.toHaveProperty("interrupt");
    expect(queue).not.toHaveProperty("promoteNow");
    expect(typeof queue.enqueue).toBe("function");
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("执行中可以把排队条目立即引导，空闲时不能", () => {
    const queue = createAiPromptQueue();
    const item = queue.enqueue("tab-a", { text: "改成沈星视角" });
    expect(canSendQueuedPromptAsSteer(item, true)).toBe(true);
    expect(canSendQueuedPromptAsSteer(item, false)).toBe(false);
    expect(canSendQueuedPromptAsSteer(null, true)).toBe(false);
    expect(aiPromptQueuePreview("改成沈星视角并压缩旁白", 8)).toBe("改成沈星视角并…");
    expect(aiPromptQueuePreview("短句", 8)).toBe("短句");
    expect(queuedPromptSteerContent(item)).toBe("改成沈星视角");
  });

  it("空队列、超限和按页签隔离", () => {
    const queue = createAiPromptQueue();
    expect(queue.takeNext("tab-a")).toBeNull();
    expect(queue.count("tab-a")).toBe(0);
    expect(() => queue.enqueue("tab-a", { text: "   " })).toThrow(/不能为空/u);
    queue.enqueue("tab-a", { text: "A" });
    queue.enqueue("tab-b", { text: "B" });
    expect(queue.remove("tab-a", "missing")).toBeNull();
    expect(queue.list("tab-b")[0]?.text).toBe("B");
    for (let index = 1; index < AI_PROMPT_QUEUE_LIMIT; index += 1) {
      queue.enqueue("tab-a", { text: `item-${index}` });
    }
    expect(() => queue.enqueue("tab-a", { text: "overflow" })).toThrow(/最多排队/u);
    expect(queue.clear("tab-a")).toHaveLength(AI_PROMPT_QUEUE_LIMIT);
    expect(queue.count("tab-a")).toBe(0);
    expect(queue.count("tab-b")).toBe(1);
  });

  it("发送失败时可以把条目放回队首", () => {
    const queue = createAiPromptQueue();
    const first = queue.enqueue("tab-a", { text: "先写港口" });
    queue.enqueue("tab-a", { text: "再写冷却" });
    expect(queue.takeNext("tab-a")).toEqual(first);
    expect(queue.list("tab-a").map((item: { text: string }) => item.text)).toEqual(["再写冷却"]);
    queue.restore("tab-a", first, 0);
    expect(queue.list("tab-a").map((item: { text: string }) => item.text)).toEqual(["先写港口", "再写冷却"]);
  });

  it("拖拽或快捷键可以调整尚未发送的排队顺序", () => {
    const queue = createAiPromptQueue();
    const first = queue.enqueue("tab-a", { text: "先写港口" });
    const second = queue.enqueue("tab-a", { text: "再写冷却" });
    const third = queue.enqueue("tab-a", { text: "最后写灯塔" });
    expect(moveQueuedPromptItem(queue.list("tab-a"), third.id, first.id, false).map((item: { text: string }) => item.text)).toEqual(["最后写灯塔", "先写港口", "再写冷却"]);
    expect(moveQueuedPromptItem(queue.list("tab-a"), first.id, third.id, true).map((item: { text: string }) => item.text)).toEqual(["再写冷却", "最后写灯塔", "先写港口"]);
    expect(moveQueuedPromptItem(queue.list("tab-a"), first.id, first.id, true)).toEqual(queue.list("tab-a"));
    expect(moveQueuedPromptItemByOffset(queue.list("tab-a"), first.id, 1).map((item: { text: string }) => item.text)).toEqual(["再写冷却", "先写港口", "最后写灯塔"]);
    expect(moveQueuedPromptItemByOffset(queue.list("tab-a"), first.id, -1)).toEqual(queue.list("tab-a"));
    queue.move("tab-a", third.id, first.id, false);
    expect(queue.list("tab-a").map((item: { text: string }) => item.text)).toEqual(["最后写灯塔", "先写港口", "再写冷却"]);
    queue.moveByOffset("tab-a", first.id, 1);
    expect(queue.list("tab-a").map((item: { text: string }) => item.text)).toEqual(["最后写灯塔", "再写冷却", "先写港口"]);
    expect(parseAiPromptQueueDragPayload(aiPromptQueueDragPayload(second.id))).toBe(second.id);
    expect(parseAiPromptQueueDragPayload("chapter-1")).toBeNull();
  });

  it("尚未发出的排队内容可以就地改写", () => {
    const queue = createAiPromptQueue();
    const item = queue.enqueue("tab-a", { text: "改成沈星视角", markup: "改成沈星视角" });
    expect(queuedPromptEditContent(item)).toBe("改成沈星视角");
    expect(queuedPromptEditPatch(item, "改成林舟视角")).toEqual({ text: "改成林舟视角", markup: "改成林舟视角" });
    const updated = queue.update("tab-a", item.id, queuedPromptEditPatch(item, "改成林舟视角"));
    expect(updated?.text).toBe("改成林舟视角");
    expect(updated?.id).toBe(item.id);
    expect(queue.list("tab-a")[0]?.text).toBe("改成林舟视角");
    expect(() => queue.update("tab-a", item.id, { text: "   ", markup: "" })).toThrow(/不能为空/u);
    expect(queue.update("tab-a", "missing", { text: "不存在" })).toBeNull();
    const sceneOnly = queue.enqueue("tab-a", { sceneDirection: "港口起雾" });
    expect(queuedPromptEditContent(sceneOnly)).toBe("港口起雾");
    expect(queuedPromptEditPatch(sceneOnly, "灯塔亮起")).toEqual({ sceneDirection: "灯塔亮起" });
    expect(queue.update("tab-a", sceneOnly.id, queuedPromptEditPatch(sceneOnly, "灯塔亮起"))?.sceneDirection).toBe("灯塔亮起");
  });
});
