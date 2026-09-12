import { describe, expect, it } from "vitest";
// @ts-expect-error 浏览器纯函数模块不提供独立类型声明。
import { createMarkdownStreamState } from "../../src/public/stream-markdown.js";
// @ts-expect-error 浏览器 Markdown 模块不提供独立类型声明。
import { renderMarkdown } from "../../src/public/markdown.js";

function verifyPrefixes(source: string, size = 1) {
  const state = createMarkdownStreamState();
  let committed: string[] = [];
  for (let end = 0; end <= source.length + size; end += size) {
    const text = source.slice(0, end);
    const update = state.update(text);
    if (update.reset) committed = [];
    const parts = update.parts.map((part: { html: string }) => part.html);
    expect(committed.join("") + parts.join(""), `prefix ${end}: ${text}`).toBe(renderMarkdown(text));
    committed.push(...parts.slice(0, update.stableCount));
  }
}

describe("incremental streaming Markdown", () => {
  it("preserves every partial prefix across ambiguous block boundaries", () => {
    const blocks = ["paragraph\nsecond line", "# Heading", "---", "1. one\n\n2. two", "- one\n\n- two", "> quote\n\n> continued", "| a | b |\n| --- | --- |\n| 1 | 2 |", "```js\nconst answer = 42;\n```", "<script>alert(1)</script>\n\n[unsafe](javascript:x)"];
    for (const first of blocks) for (const second of blocks) verifyPrefixes(`intro\n\n${first}\n\n${second}\n\nend\n\n# final`);
  });

  it("handles replacement, Unicode and CRLF streams", () => {
    verifyPrefixes("# 标题\r\n\r\n你好𠮷\r\n\r\n> 引用\r\n\r\n> 下一行\r\n\r\n结尾");
    const state = createMarkdownStreamState();
    state.update("first\n\nsecond\n\nthird\n\nfourth");
    const replaced = state.update("replacement");
    expect(replaced.reset).toBe(true);
    expect(replaced.parts.map((part: { html: string }) => part.html).join("")).toBe(renderMarkdown("replacement"));
  });

  it("does not parse already committed long history again", () => {
    const state = createMarkdownStreamState();
    const source = "## Heading\n\nLong **formatted** text.\n\n".repeat(3000);
    state.update(source);
    const next = state.update(source + "new text");
    expect(next.parts.length).toBeLessThanOrEqual(3);
    expect(next.parts.map((part: { html: string }) => part.html).join("").length).toBeLessThan(500);
  });
});
