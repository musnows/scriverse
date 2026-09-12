import { describe, expect, it } from "vitest";
// @ts-expect-error 浏览器调度纯函数不提供独立类型声明。
import { createAiRenderScheduler } from "../../src/public/ai-render-scheduler.js";

describe("AI rendering scheduler", () => {
  it("coalesces hidden updates and renders the latest state when shown", () => {
    const frames: Array<() => void> = [];
    const rendered: string[] = [];
    let visible = false;
    let connected = true;
    const scheduler = createAiRenderScheduler({
      isVisible: () => visible, isConnected: () => connected,
      schedule: (callback: () => void) => { frames.push(callback); return callback; }, now: () => 100
    });
    for (let index = 0; index < 100; index += 1) scheduler.enqueue("message", () => rendered.push(String(index)));
    expect(frames).toHaveLength(0);
    visible = true;
    scheduler.refresh();
    frames.shift()?.();
    expect(rendered).toEqual(["99"]);
    scheduler.enqueue("message", () => rendered.push("removed"));
    connected = false;
    scheduler.refresh();
    frames.shift()?.();
    expect(rendered).toEqual(["99"]);
  });

  it("yields between costly updates and respects the render interval", () => {
    const frames: Array<() => void> = [];
    const rendered: number[] = [];
    let time = 0;
    const scheduler = createAiRenderScheduler({isVisible: () => true, now: () => time, schedule: (callback: () => void) => { frames.push(callback); return callback; }});
    for (let index = 0; index < 3; index += 1) scheduler.enqueue(index, () => { rendered.push(index); time += 5; });
    frames.shift()?.();
    expect(rendered).toEqual([0]);
    frames.shift()?.();
    expect(rendered).toEqual([0]);
    time = 32;
    frames.shift()?.();
    expect(rendered).toEqual([0,1]);
    time = 64;
    frames.shift()?.();
    expect(rendered).toEqual([0,1,2]);
    expect(frames).toHaveLength(0);
  });
});
