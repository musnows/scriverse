import { describe, expect, it } from "vitest";
// @ts-expect-error 浏览器端模块没有单独的类型声明，测试仅调用纯函数导出。
import { AI_PROMPT_QUEUE_LIMIT, aiPromptQueuePreview, canSendQueuedPromptAsSteer, createAiPromptQueue, queuedPromptSteerContent } from "../../src/public/ai-prompt-queue.js";

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

  it("执行中可以把排队条目发送为引导，空闲时不能", () => {
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
});
