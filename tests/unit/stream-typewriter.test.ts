import { afterEach, describe, expect, it, vi } from "vitest";
import { createStreamTypewriter, createStreamTypewriterSpeedController, streamTypewriterBatchSize } from "../../src/public/stream-typewriter.js";
// @ts-expect-error 浏览器端 Markdown 模块没有单独的类型声明，测试仅调用纯函数导出。
import { renderMarkdown } from "../../src/public/markdown.js";

function manualFrames() {
  const callbacks: Array<() => void> = [];
  return {
    schedule(callback: () => void) {
      callbacks.push(callback);
      return callback;
    },
    cancel(callback: () => void) {
      const index = callbacks.indexOf(callback);
      if (index >= 0) callbacks.splice(index, 1);
    },
    runNext() {
      callbacks.shift()?.();
    },
    runAll(limit = 200) {
      let count = 0;
      while (callbacks.length && count < limit) {
        callbacks.shift()?.();
        count += 1;
      }
      return count;
    }
  };
}

class PageVisibility extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";

  changeTo(state: DocumentVisibilityState) {
    this.visibilityState = state;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

describe("流式打字机", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("consumes inactive conversation data without scheduling animation frames", async () => {
    const frames = manualFrames();
    let rendered = "";
    const writer = createStreamTypewriter({ onRender: (text) => { rendered = text; }, shouldAnimate: () => false, scheduleFrame: frames.schedule, cancelFrame: frames.cancel });
    writer.append("hidden conversation");
    expect(frames.runAll()).toBe(0);
    await expect(writer.finish()).resolves.toBe("hidden conversation");
    expect(rendered).toBe("hidden conversation");
  });

  it("handles large Unicode chunks without argument limits or prolonged animation backlog", async () => {
    const frames = manualFrames();
    const source = "𠮷字".repeat(100_000);
    const writer = createStreamTypewriter({ onRender: () => {}, scheduleFrame: frames.schedule, cancelFrame: frames.cancel, reducedMotion: false });
    writer.append(source);
    const completed = writer.finish();
    expect(frames.runAll(1000)).toBeLessThan(1000);
    await expect(completed).resolves.toBe(source);
    expect(writer.replace(source)).toBe(source);
    writer.append(source);
    expect(writer.reveal()).toBe(source + source);
  });

  it("renders background chunks and finishes without animation frames", async () => {
    const frames = manualFrames();
    const visibility = new PageVisibility();
    visibility.changeTo("hidden");
    vi.stubGlobal("document", visibility);
    const renders: string[] = [];
    const typewriter = createStreamTypewriter({
      onRender: (text) => renders.push(text),
      scheduleFrame: frames.schedule,
      cancelFrame: frames.cancel
    });

    typewriter.append("后台收到");
    expect(renders.at(-1)).toBe("后台收到");
    typewriter.append("𠮷的回复");
    expect(renders.at(-1)).toBe("后台收到𠮷的回复");
    await expect(typewriter.finish()).resolves.toBe("后台收到𠮷的回复");
    expect(frames.runAll()).toBe(0);
  });

  it("flushes pending thinking and text when hidden, without replaying on return", async () => {
    const frames = manualFrames();
    const visibility = new PageVisibility();
    const renders: string[][] = [[], []];
    const writers = renders.map((output) => createStreamTypewriter({
      onRender: (text) => output.push(text),
      scheduleFrame: frames.schedule,
      cancelFrame: frames.cancel,
      reducedMotion: false,
      visibilitySource: visibility
    }));
    writers[0]!.append("思考".repeat(500));
    writers[1]!.append("正文".repeat(500));
    frames.runNext();
    expect(renders[0]!.at(-1)?.length).toBeLessThan(1_000);
    const completed = Promise.all(writers.map((writer) => writer.finish()));
    visibility.changeTo("hidden");
    await expect(completed).resolves.toEqual(["思考".repeat(500), "正文".repeat(500)]);
    expect(frames.runAll()).toBe(0);

    const renderCounts = renders.map((output) => output.length);
    visibility.changeTo("visible");
    expect(frames.runAll()).toBe(0);
    expect(renders.map((output) => output.length)).toEqual(renderCounts);
    writers[1]!.append("继续输出");
    frames.runNext();
    expect(renders[1]!.at(-1)).toBe("正文".repeat(500) + "继");
    const final = writers[1]!.finish();
    frames.runAll();
    await expect(final).resolves.toBe("正文".repeat(500) + "继续输出");
  });

  it.each(["append", "finish"])("handles hidden state before its visibility event (%s)", async (action) => {
    const frames = manualFrames();
    const visibility = new PageVisibility();
    let rendered = "";
    const writer = createStreamTypewriter({
      onRender: (text) => { rendered = text; },
      scheduleFrame: frames.schedule,
      cancelFrame: frames.cancel,
      visibilitySource: visibility
    });
    writer.append("先前积压");
    visibility.visibilityState = "hidden";
    if (action === "append") writer.append("后台追加");
    const completed = writer.finish();
    expect(rendered).toBe(action === "append" ? "先前积压后台追加" : "先前积压");
    await expect(completed).resolves.toBe(rendered);
    expect(frames.runAll()).toBe(0);
  });

  it.each(["finish", "replace", "reveal"])("releases visibility listeners after settling (%s)", async (action) => {
    const frames = manualFrames();
    const visibility = new PageVisibility();
    const add = vi.spyOn(visibility, "addEventListener");
    const remove = vi.spyOn(visibility, "removeEventListener");
    const render = vi.fn();
    const writer = createStreamTypewriter({
      onRender: render,
      scheduleFrame: frames.schedule,
      cancelFrame: frames.cancel,
      visibilitySource: visibility
    });
    for (let round = 0; round < 3; round += 1) {
      writer.append("本轮");
      writer.append("输出");
      expect(add).toHaveBeenCalledTimes(round + 1);
      if (action === "finish") {
        const completed = writer.finish();
        frames.runAll();
        await completed;
      } else if (action === "replace") writer.replace("替换文本");
      else writer.reveal();
      expect(remove).toHaveBeenCalledTimes(round + 1);
    }
    const renderCount = render.mock.calls.length;
    visibility.changeTo("hidden");
    visibility.changeTo("visible");
    expect(render).toHaveBeenCalledTimes(renderCount);
    expect(frames.runAll()).toBe(0);
  });

  it("逐帧显示收到的 Unicode 字符并在完成时返回全文", async () => {
    const frames = manualFrames();
    const renders: string[] = [];
    const typewriter = createStreamTypewriter({
      onRender: (text) => renders.push(text),
      scheduleFrame: frames.schedule,
      cancelFrame: frames.cancel,
      reducedMotion: false
    });

    typewriter.append("你好");
    typewriter.append("，A");
    frames.runNext();
    expect(renders).toEqual(["你"]);

    const completed = typewriter.finish();
    expect(frames.runAll()).toBe(2);
    await expect(completed).resolves.toBe("你好，A");
    expect(renders.at(-1)).toBe("你好，A");
  });

  it("在减少动态效果时单帧显示完整内容", async () => {
    const frames = manualFrames();
    const renders: string[] = [];
    const typewriter = createStreamTypewriter({
      onRender: (text) => renders.push(text),
      scheduleFrame: frames.schedule,
      cancelFrame: frames.cancel,
      reducedMotion: true
    });

    typewriter.append("完整回复");
    const completed = typewriter.finish();
    expect(frames.runAll()).toBe(1);
    await expect(completed).resolves.toBe("完整回复");
    expect(renders).toEqual(["完整回复"]);
  });

  it("中断时立即显露所有已收到的字符并取消待处理帧", () => {
    const frames = manualFrames();
    const renders: string[] = [];
    const typewriter = createStreamTypewriter({
      onRender: (text) => renders.push(text),
      scheduleFrame: frames.schedule,
      cancelFrame: frames.cancel,
      reducedMotion: false
    });

    typewriter.append("部分回复");
    expect(typewriter.reveal()).toBe("部分回复");
    expect(frames.runAll()).toBe(0);
    expect(renders).toEqual(["部分回复"]);
  });

  it("可以把尚未归类的正文替换为最终正文", () => {
    const frames = manualFrames();
    const renders: string[] = [];
    const typewriter = createStreamTypewriter({
      onRender: (text) => renders.push(text),
      scheduleFrame: frames.schedule,
      cancelFrame: frames.cancel,
      reducedMotion: false
    });

    typewriter.append("工具前的中间输出");
    expect(typewriter.replace("最终回答")).toBe("最终回答");
    expect(frames.runAll()).toBe(0);
    expect(renders).toEqual(["最终回答"]);
  });

  it("限制生成和收尾阶段每帧显示的字符数", () => {
    expect(streamTypewriterBatchSize(0)).toBe(0);
    expect(streamTypewriterBatchSize(4)).toBe(1);
    expect(streamTypewriterBatchSize(180)).toBe(6);
    expect(streamTypewriterBatchSize(180, true)).toBe(13);
    expect(streamTypewriterBatchSize(5_000)).toBe(12);
    expect(streamTypewriterBatchSize(5_000, true)).toBe(24);
  });

  it("根据共享流速让后续轮次继承较快的显示速度", () => {
    let currentTime = 0;
    const speedController = createStreamTypewriterSpeedController({ now: () => currentTime });
    speedController.observe(180);

    expect(speedController.charactersPerSecond()).toBe(360);
    expect(streamTypewriterBatchSize(12, false, speedController.charactersPerSecond())).toBe(6);

    currentTime = 100;
    speedController.observe(60);
    expect(speedController.charactersPerSecond()).toBeGreaterThan(60);
    expect(streamTypewriterBatchSize(12, false, speedController.charactersPerSecond())).toBeGreaterThan(1);
  });

  it("跨轮次空档保留已观测到的追赶速度", () => {
    let currentTime = 0;
    const speedController = createStreamTypewriterSpeedController({ now: () => currentTime });
    speedController.observe(180);
    currentTime = 5_000;
    speedController.observe(3);

    expect(speedController.charactersPerSecond()).toBe(360);
    expect(streamTypewriterBatchSize(12, false, speedController.charactersPerSecond())).toBe(6);
  });

  it("两个独立轮次的打字机共享追赶速度", () => {
    const firstFrames = manualFrames();
    const secondFrames = manualFrames();
    const speedController = createStreamTypewriterSpeedController({ now: () => 0 });
    const firstRenders: string[] = [];
    const secondRenders: string[] = [];
    const firstTypewriter = createStreamTypewriter({
      onRender: (text) => firstRenders.push(text),
      scheduleFrame: firstFrames.schedule,
      cancelFrame: firstFrames.cancel,
      reducedMotion: false,
      speedController
    });
    const secondTypewriter = createStreamTypewriter({
      onRender: (text) => secondRenders.push(text),
      scheduleFrame: secondFrames.schedule,
      cancelFrame: secondFrames.cancel,
      reducedMotion: false,
      speedController
    });

    firstTypewriter.append("字".repeat(180));
    firstFrames.runNext();
    secondTypewriter.append("第二轮思考内容");
    secondFrames.runNext();

    expect(firstRenders[0]).toHaveLength(6);
    expect(secondRenders[0]).toHaveLength(6);
  });

  it("大量文本积压时按积压量平滑加速", async () => {
    const frames = manualFrames();
    const lengths: number[] = [];
    const typewriter = createStreamTypewriter({
      onRender: (text) => lengths.push(Array.from(text).length),
      scheduleFrame: frames.schedule,
      cancelFrame: frames.cancel,
      reducedMotion: false
    });

    typewriter.append("字".repeat(180));
    frames.runNext();
    expect(lengths).toEqual([6]);

    const completed = typewriter.finish();
    expect(frames.runAll()).toBeLessThan(30);
    await expect(completed).resolves.toBe("字".repeat(180));
    expect(lengths.every((length, index) => index === 0 || length - (lengths[index - 1] ?? 0) <= 24)).toBe(true);
  });

  it("逐帧解析复杂 Markdown 并在完成时渲染为真实表格", async () => {
    const frames = manualFrames();
    const renderedFrames: string[] = [];
    const markdown = [
      "### 航行状态",
      "",
      "| 舰船 | 状态 | 备注 |",
      "| :--- | :---: | ---: |",
      "| 远航号 | **跃迁完成** | `冷却 12h` |",
      "| 归潮号 | 检修中 | 引擎\\|护盾 |",
      "",
      "- 表格后列表仍然可用",
      "",
      "```txt",
      "航线已锁定",
      "```"
    ].join("\n");
    const typewriter = createStreamTypewriter({
      onRender: (text) => renderedFrames.push(renderMarkdown(text)),
      scheduleFrame: frames.schedule,
      cancelFrame: frames.cancel,
      reducedMotion: false
    });

    typewriter.append(markdown.slice(0, 42));
    frames.runNext();
    typewriter.append(markdown.slice(42));
    const completed = typewriter.finish();
    frames.runAll();

    await expect(completed).resolves.toBe(markdown);
    expect(renderedFrames.length).toBeGreaterThan(2);
    expect(renderedFrames.some((html) => !html.includes("<table>"))).toBe(true);
    expect(renderedFrames.some((html) => html.includes("<table>"))).toBe(true);
    expect(renderedFrames.at(-1)).toContain('<div class="markdown-table-scroll" role="region" aria-label="Markdown 表格" tabindex="0">');
    expect(renderedFrames.at(-1)).toContain("<thead><tr>");
    expect(renderedFrames.at(-1)).toContain('<tbody><tr><td class="markdown-align-left">远航号</td>');
    expect(renderedFrames.at(-1)).toContain('<td class="markdown-align-center"><strong>跃迁完成</strong></td>');
    expect(renderedFrames.at(-1)).toContain('<td class="markdown-align-right"><code>冷却 12h</code></td>');
    expect(renderedFrames.at(-1)).toContain('<td class="markdown-align-right">引擎|护盾</td>');
    expect(renderedFrames.at(-1)).toContain("<ul><li");
    expect(renderedFrames.at(-1)).toContain('<pre><code class="language-txt">航线已锁定</code></pre>');
  });
});
