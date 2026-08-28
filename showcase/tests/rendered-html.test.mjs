import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { shouldRenderGalaxyLabel } from "../app/galaxy-visibility.js";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request("http://localhost", { headers: { accept: "text/html" } }), {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  }, { waitUntil() {}, passThroughOnException() {} });
}

test("服务端渲染叙界介绍页", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>叙界 Scriverse/);
  assert.match(html, /让宏大的故事/);
  assert.match(html, /人物关系/);
  assert.match(html, /银河图/);
  assert.match(html, /AI 创作助手/);
  assert.match(html, /批量筛选与移动/);
  assert.match(html, /每日写作进度/);
  assert.match(html, /章节回收站/);
  assert.match(html, /Markdown ZIP/);
  assert.match(html, /并发对话与关系扮演/);
  assert.match(html, /我和作者各自扮演的角色|AI 和作者各自扮演的角色/);
  assert.match(html, /沉浸式阅读与 EPUB/);
  assert.match(html, /正文行评论与待办/);
  assert.match(html, /加密 S3 系统备份/);
  assert.match(html, /S3 系统备份/);
  assert.match(html, /href="https:\/\/showcase\.scriverse\.top\/"[^>]*>在线体验/);
  assert.match(html, /href="https:\/\/llm-racing\.scriverse\.top\/\?utm_source=scriverse"/);
  assert.match(html, /aria-label="查看模型排行榜"/);
  assert.match(html, /class="[^"]*header-leaderboard[^"]*"/);
  assert.match(html, /href="https:\/\/github\.com\/musnows\/Scriverse"/);
  assert.match(html, /href="https:\/\/github\.com\/musnows\/scriverse-desktop"/);
  assert.match(html, /href="https:\/\/github\.com\/musnows\/scriverse-app"/);
  assert.match(html, /当前正式版[\s\S]{0,24}v0\.1\.9/);
  assert.match(html, /scriverse-desktop-darwin-arm64-0\.1\.9\.dmg/);
  assert.match(html, /scriverse-desktop-darwin-x64-0\.1\.9\.dmg/);
  assert.match(html, /scriverse-desktop-win32-x64-0\.1\.9-Setup\.exe/);
  assert.match(html, /scriverse-desktop-win32-arm64-0\.1\.9-Setup\.exe/);
  assert.match(html, /scriverse-desktop_0\.1\.9_amd64\.deb/);
  assert.match(html, /scriverse-desktop_0\.1\.9_arm64\.deb/);
  assert.match(html, /<img[^>]+src="\/favicon\.svg"[^>]*alt=""/);
  assert.match(html, /aria-label="在 GitHub 查看源代码"/);
  assert.match(html, /class="[^"]*header-icon-link[^"]*"/);
  assert.match(html, /data-scroll-target="workspace"[^>]*>进入叙界世界/);
  assert.doesNotMatch(html, /打开演示站/);
  assert.doesNotMatch(html, /href="\/demo"/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/);
});

test("页内导航不写入 URL 哈希锚点", async () => {
  const response = await render();
  const html = await response.text();
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.doesNotMatch(html, /href="#(?:top|workspace|abilities|relationships|galaxy)"/);
  assert.match(html, /data-scroll-target="workspace"/);
  assert.match(html, /data-scroll-target="relationships"/);
  assert.doesNotMatch(css, /html\s*\{\s*scroll-behavior:\s*smooth/);
});

test("关系节点的交互锚点与可见圆点保持重合", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const nodeRule = css.match(/\.relation-node \{([^}]+)\}/)?.[1] ?? "";
  const dotRule = css.match(/\.relation-node i \{([^}]+)\}/)?.[1] ?? "";

  assert.match(nodeRule, /width:\s*var\(--node-size\)/);
  assert.match(nodeRule, /height:\s*var\(--node-size\)/);
  assert.match(nodeRule, /padding:\s*0/);
  assert.doesNotMatch(nodeRule, /transition:[^;}]*\b(?:left|top)\b/);
  assert.match(dotRule, /width:\s*100%/);
  assert.match(dotRule, /height:\s*100%/);
});

test("银河图关闭名称后不再显示选中或关联角色名称", () => {
  assert.equal(shouldRenderGalaxyLabel(true), true);
  assert.equal(shouldRenderGalaxyLabel(false), false);
});
