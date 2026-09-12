import { renderMarkdownParts } from "./markdown.js?v=20260912-stream-render-v2";

// 保留末尾两个块，等待列表、引用和表格的后续行确定语义后再冻结前缀。
export function createMarkdownStreamState() {
  let previous = "";
  let committed = 0;
  return {
    update(value) {
      const source = String(value ?? "").replace(/\r\n?/gu, "\n");
      const reset = !source.startsWith(previous);
      if (reset) committed = 0;
      const parts = renderMarkdownParts(source.slice(committed));
      const stableCount = Math.max(0, parts.length - 2);
      if (stableCount) committed += parts[stableCount - 1].end;
      previous = source;
      return { reset, parts, stableCount };
    }
  };
}

// 每个节点都是可让出主线程的边界，长列表和表格也不会作为一个大块集中挂载。
function* patchMarkdownNode(current, next, parent) {
  if (!current || current.nodeType !== next.nodeType || current.nodeName !== next.nodeName) {
    const replacement = next.cloneNode(false);
    if (current) current.replaceWith(replacement);
    else parent.append(replacement);
    current = replacement;
  }
  if (current.nodeType === 3) {
    if (current.data === next.data) return current;
    if (next.data.startsWith(current.data)) current.appendData(next.data.slice(current.data.length));
    else if (current.data !== next.data) current.data = next.data;
    yield;
    return current;
  }
  if (current.nodeType !== 1) return current;
  for (const attribute of [...current.attributes]) {
    if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
  }
  for (const attribute of next.attributes) {
    if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
  }
  yield;
  const children = [...current.childNodes];
  const nextChildren = [...next.childNodes];
  for (const [index, child] of nextChildren.entries()) yield* patchMarkdownNode(children[index], child, current);
  for (const child of children.slice(nextChildren.length)) { child.remove(); yield; }
  return current;
}

export function createStreamingMarkdownRenderer(host, {
  enqueue = (callback) => requestAnimationFrame(callback),
  onRender = () => {},
  now = () => performance.now(),
  budgetMs = 3,
  nodeBudget = 120
} = {}) {
  const state = createMarkdownStreamState();
  let tail = [];
  let requestedValue = null;
  let appliedValue = null;
  let work = null;
  let queued = false;
  function* apply(value) {
    const update = state.update(value);
    if (update.reset) {
      for (const child of [...host.childNodes]) { child.remove(); yield; }
      tail = [];
    }
    const next = [];
    for (const [index, part] of update.parts.entries()) {
      const previous = tail[index];
      if (previous?.html === part.html) { next.push(previous); continue; }
      const template = host.ownerDocument.createElement("template");
      template.innerHTML = part.html;
      const node = yield* patchMarkdownNode(previous?.node, template.content.firstChild, host);
      next.push({ html: part.html, node });
    }
    for (const item of tail.slice(next.length)) { item.node.remove(); yield; }
    tail = next.slice(update.stableCount);
    appliedValue = value;
  }
  const drain = () => {
    queued = false;
    const started = now();
    if (!work && requestedValue !== appliedValue) work = apply(requestedValue);
    let nodes = 0;
    while (work && nodes < nodeBudget && now() - started < budgetMs) {
      if (work.next().done) { work = null; break; }
      nodes += 1;
    }
    onRender();
    if (work || requestedValue !== appliedValue) schedule();
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    enqueue(drain);
  };
  return (value) => {
    const normalized = String(value ?? "");
    if (normalized === requestedValue) return false;
    requestedValue = normalized;
    schedule();
    return true;
  };
}
