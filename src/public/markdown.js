const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/gu, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "'": "&#39;",
  '"': "&quot;"
})[character]);

function safeLinkTarget(value) {
  const target = String(value ?? "").trim();
  if (/^(https?:|mailto:)/iu.test(target)) return target;
  if (/^(\/|#)/u.test(target) && !target.startsWith("//")) return target;
  return null;
}

function safeImageTarget(value) {
  const target = String(value ?? "").trim();
  const attachment = target.match(/^attachment:\/\/([A-Za-z0-9_-]{1,300})$/u);
  if (attachment) return `/api/attachments/${encodeURIComponent(attachment[1])}/content`;
  if (target.startsWith("/") && !target.startsWith("//")) return target;
  return null;
}

function replaceInlineCodeSpans(value, preserve) {
  const source = String(value ?? "");
  let output = "";
  let cursor = 0;
  while (cursor < source.length) {
    const openingStart = source.indexOf("`", cursor);
    if (openingStart < 0) {
      output += source.slice(cursor);
      break;
    }
    let openingEnd = openingStart + 1;
    while (source[openingEnd] === "`") openingEnd += 1;
    const delimiter = source.slice(openingStart, openingEnd);
    let closingStart = source.indexOf(delimiter, openingEnd);
    while (closingStart >= 0) {
      const touchesBacktickBefore = closingStart > 0 && source[closingStart - 1] === "`";
      const touchesBacktickAfter = source[closingStart + delimiter.length] === "`";
      if (!touchesBacktickBefore && !touchesBacktickAfter) break;
      closingStart = source.indexOf(delimiter, closingStart + 1);
    }
    output += source.slice(cursor, openingStart);
    if (closingStart < 0) {
      output += delimiter;
      cursor = openingEnd;
      continue;
    }
    let code = source.slice(openingEnd, closingStart).replace(/\s+/gu, " ");
    if (/^ .* $/u.test(code) && code.trim()) code = code.slice(1, -1);
    output += preserve(`<code>${escapeHtml(code)}</code>`);
    cursor = closingStart + delimiter.length;
  }
  return output;
}

function renderInlineMarkdown(value) {
  const tokens = [];
  const preserve = (html) => {
    const marker = `\uE000${tokens.length}\uE001`;
    tokens.push(html);
    return marker;
  };
  let source = String(value ?? "");
  source = replaceInlineCodeSpans(source, preserve);
  source = source.replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/gu, (_match, label, src) => {
    const target = safeImageTarget(src);
    if (!target) return `[外部图片已阻止：${label || "未命名图片"}]`;
    const caption = String(label ?? "").trim();
    return preserve(`<span class="markdown-image"><img src="${escapeHtml(target)}" alt="${escapeHtml(caption)}" loading="lazy" decoding="async">${caption ? `<small>${escapeHtml(caption)}</small>` : ""}</span>`);
  });
  source = source.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/gu, (_match, label, href) => {
    const target = safeLinkTarget(href);
    if (!target) return `${label}（${href}）`;
    const external = /^https?:/iu.test(target) ? ' target="_blank" rel="noopener noreferrer"' : "";
    return preserve(`<a href="${escapeHtml(target)}"${external}>${escapeHtml(label)}</a>`);
  });
  let html = escapeHtml(source);
  html = html.replace(/\*\*([^*\n]+)\*\*/gu, "<strong>$1</strong>");
  html = html.replace(/__([^_\n]+)__/gu, "<strong>$1</strong>");
  html = html.replace(/(^|[^*])\*([^*\n]+)\*/gu, "$1<em>$2</em>");
  html = html.replace(/~~([^~\n]+)~~/gu, "<del>$1</del>");
  tokens.forEach((token, index) => {
    html = html.replace(`\uE000${index}\uE001`, token);
  });
  return html;
}

function splitMarkdownTableRow(value) {
  const source = String(value ?? "").trim();
  if (!source.includes("|")) return null;
  const cells = [];
  let cell = "";
  let inCode = false;
  let separators = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\" && source[index + 1] === "|") {
      cell += "|";
      index += 1;
      continue;
    }
    if (character === "`") inCode = !inCode;
    if (character === "|" && !inCode) {
      cells.push(cell.trim());
      cell = "";
      separators += 1;
      continue;
    }
    cell += character;
  }
  cells.push(cell.trim());
  if (!separators) return null;
  if (source.startsWith("|")) cells.shift();
  if (source.endsWith("|") && cells.at(-1) === "") cells.pop();
  return cells;
}

function tableAlignments(cells) {
  if (!cells?.length || !cells.every((cell) => /^:?-{3,}:?$/u.test(cell))) return null;
  return cells.map((cell) => {
    if (cell.startsWith(":") && cell.endsWith(":")) return "center";
    if (cell.endsWith(":")) return "right";
    return "left";
  });
}

function renderMarkdownTable(headers, alignments, rows) {
  const renderCell = (tag, value, alignment) => {
    const interaction = tag === "th"
      ? ' data-markdown-table-header tabindex="0" aria-haspopup="menu" title="右键或按 Shift+F10 设置表格换行"'
      : "";
    return `<${tag} class="markdown-align-${alignment}"${interaction}>${renderInlineMarkdown(value)}</${tag}>`;
  };
  const header = headers.map((cell, index) => renderCell("th", cell, alignments[index])).join("");
  const body = rows.map((row) => {
    const cells = headers.map((_header, index) => renderCell("td", row[index] ?? "", alignments[index])).join("");
    return `<tr>${cells}</tr>`;
  }).join("");
  return `<div class="markdown-table-scroll" role="region" aria-label="Markdown 表格" tabindex="0"><table><thead><tr>${header}</tr></thead>${body ? `<tbody>${body}</tbody>` : ""}</table></div>`;
}

export function renderMarkdown(value) {
  const lines = String(value ?? "").replace(/\r\n?/gu, "\n").split("\n");
  const output = [];
  let paragraph = [];
  let list = null;
  let quote = null;
  let codeFence = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    output.push(`<p>${paragraph.map(renderInlineMarkdown).join("<br>")}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    output.push(`<${list.tag}>${list.items.map((item) => `<li class="markdown-depth-${item.depth}">${renderInlineMarkdown(item.text)}</li>`).join("")}</${list.tag}>`);
    list = null;
  };
  const flushQuote = () => {
    if (!quote) return;
    const content = quote.join("\n").trim();
    if (content) {
      const html = content.split(/\n\s*\n/gu)
        .map((part) => part.split("\n").map(renderInlineMarkdown).join("<br>"))
        .join("<br><br>");
      output.push(`<blockquote>${html}</blockquote>`);
    }
    quote = null;
  };
  const flushBlocks = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (codeFence) {
      if (/^\s*```/u.test(line)) {
        output.push(`<pre><code${codeFence.language ? ` class="language-${codeFence.language}"` : ""}>${escapeHtml(codeFence.lines.join("\n"))}</code></pre>`);
        codeFence = null;
      } else {
        codeFence.lines.push(line);
      }
      continue;
    }
    const fence = line.match(/^\s*```([\w-]*)\s*$/u);
    if (fence) {
      flushBlocks();
      codeFence = { language: fence[1].replace(/[^\w-]/gu, ""), lines: [] };
      continue;
    }
    const quoteLine = line.match(/^>\s?(.*)$/u);
    if (quoteLine) {
      flushParagraph();
      flushList();
      if (!quote) quote = [];
      quote.push(quoteLine[1]);
      continue;
    }
    if (!line.trim() && quote && /^>\s?/u.test(lines[lineIndex + 1] ?? "")) {
      quote.push("");
      continue;
    }
    flushQuote();
    if (!line.trim()) {
      // CommonMark 松散列表：同类型列表项之间的空行不结束列表，
      // 否则每个条目会各自生成 <ol>/<ul>，有序序号会全部显示为 1。
      if (list) {
        let nextIndex = lineIndex + 1;
        while (nextIndex < lines.length && !lines[nextIndex].trim()) nextIndex += 1;
        if (nextIndex < lines.length) {
          const nextListItem = lines[nextIndex].match(/^(\s*)([-+*]|\d+\.)\s+(.+)$/u);
          if (nextListItem) {
            const nextTag = /\d+\./u.test(nextListItem[2]) ? "ol" : "ul";
            if (nextTag === list.tag) {
              flushParagraph();
              continue;
            }
          }
        }
      }
      flushBlocks();
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/u);
    if (heading) {
      flushBlocks();
      const level = heading[1].length;
      output.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    if (/^\s*(---+|___+|\*\*\*+)\s*$/u.test(line)) {
      flushBlocks();
      output.push("<hr>");
      continue;
    }
    const tableHeaders = splitMarkdownTableRow(line);
    const alignments = tableAlignments(splitMarkdownTableRow(lines[lineIndex + 1]));
    if (tableHeaders && alignments && tableHeaders.length === alignments.length) {
      flushBlocks();
      const rows = [];
      lineIndex += 2;
      while (lineIndex < lines.length && lines[lineIndex].trim()) {
        const row = splitMarkdownTableRow(lines[lineIndex]);
        if (!row) break;
        rows.push(row);
        lineIndex += 1;
      }
      lineIndex -= 1;
      output.push(renderMarkdownTable(tableHeaders, alignments, rows));
      continue;
    }
    const listItem = line.match(/^(\s*)([-+*]|\d+\.)\s+(.+)$/u);
    if (listItem) {
      flushParagraph();
      const tag = /\d+\./u.test(listItem[2]) ? "ol" : "ul";
      if (list && list.tag !== tag) flushList();
      if (!list) list = { tag, items: [] };
      list.items.push({ depth: Math.min(3, Math.floor(listItem[1].length / 2)), text: listItem[3] });
      continue;
    }
    if (list) flushList();
    paragraph.push(line);
  }
  if (codeFence) output.push(`<pre><code${codeFence.language ? ` class="language-${codeFence.language}"` : ""}>${escapeHtml(codeFence.lines.join("\n"))}</code></pre>`);
  flushBlocks();
  return output.join("");
}
