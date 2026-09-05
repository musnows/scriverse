export const APPROVAL_STATUS_LABELS = Object.freeze({ pending: "待确认", rejected: "已拒绝", expired: "已过期", invalid: "已失效", executing: "执行中", succeeded: "执行成功", failed: "执行失败" });
export const WRITE_TOOL_LABELS = Object.freeze({ settings: "世界设定", characters: "角色", races: "种族", organizations: "组织", timeline: "时间线", relationships: "人物关系", outlines: "大纲/伏笔", annotations: "正文评论/待办", analysis: "分析任务", AskUserQuestions: "AskUserQuestions" });
const moduleLabels = { ...WRITE_TOOL_LABELS, prose: "正文评论/待办", "ai-analysis": "分析任务" };
const kindLabels = { create: "新增", edit: "编辑", annotation: "新增批注", analysis: "创建任务" };
const formatValue = (value) => value === null || value === undefined ? "（无）" : typeof value === "string" ? value || "（空）" : JSON.stringify(value, null, 2);

export function approvalQuestionMarkup(question, esc) {
  return `<form class="approval-question-form"><fieldset><legend>${esc(question.question)}</legend>
    ${question.options.map((option, index) => `<label class="approval-question-option"><input type="radio" name="approval-answer" value="${index}" ${index === 0 ? "checked" : ""}><span>${esc(option)}${index === 0 ? '<strong class="approval-recommended">（最推荐）</strong>' : ""}</span></label>`).join("")}
    <label class="approval-question-option"><input type="radio" name="approval-answer" value="custom"><span>自定义回答</span></label>
    <textarea class="approval-custom-answer" aria-label="自定义回答内容" placeholder="填写你的回答" maxlength="2000" rows="3" disabled></textarea>
    </fieldset><button class="primary-button" type="submit">提交回答</button></form>`;
}

export function approvalSettingsMarkup(settings, editable, esc) {
  const enabled = new Set(settings.enabled);
  return `<section class="config-section" id="ai-write-tool-settings"><div class="config-section-header"><div><h2>AI 可写工具与提问</h2><p>以下能力默认关闭。开启后，AI 仍需逐次请求你确认；修改计划可在审批中心查看，刷新或重启后继续处理。每份计划最多 ${esc(String(settings.maxOperations))} 项操作，有效期 24 小时。</p></div></div>
    <div class="ai-agent-tools approval-tool-settings">${Object.entries(WRITE_TOOL_LABELS).map(([tool, label]) => `<label><input name="ai-write-tool" type="checkbox" value="${esc(tool)}" ${enabled.has(tool) ? "checked" : ""} ${editable ? "" : "disabled"}><span><strong>${esc(label)}</strong><small>${tool === "AskUserQuestions" ? "单个问题，预置单选项或自定义回答。" : tool === "annotations" ? "仅添加评论和待办，不修改章节正文。" : tool === "analysis" ? "确认任务类型、模型和范围后加入任务队列。" : "可新建或编辑，不能删除词条。"}</small></span></label>`).join("")}</div>
    <div class="card-actions"><button id="save-ai-write-tools" class="ghost-button config-save-button" type="button" ${editable ? "" : "disabled"}>保存可写工具设置</button></div></section>`;
}

export function createAiApprovalUi({ api, esc, state, toast, raiseToastRegion, mountModuleCount, onChanged }) {
  let generation = 0;
  let pollTimer = null;
  let offset = 0;
  let statusFilter = "";
  let filterOpen = false;
  let listRequest = 0;
  let detailId = null;
  let detailStatus = null;
  let detailRequest = 0;
  let toastElement = null;
  const seen = new Set();
  const dialog = document.querySelector("#ai-approval-dialog");
  const content = document.querySelector("#ai-approval-detail");
  const endpoint = (workId, approvalId = "") => `/api/works/${encodeURIComponent(workId)}/ai-approvals${approvalId ? `/${encodeURIComponent(approvalId)}` : ""}`;
  const date = (value) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
  const targets = (approval) => approval.operations.map((operation) => `${moduleLabels[operation.module] || operation.module} · ${operation.targetName}`).join("；");
  const status = (approval) => `<span class="approval-status" data-status="${esc(approval.status)}">${esc(APPROVAL_STATUS_LABELS[approval.status] || approval.status)}</span>`;
  const clearToast = () => { toastElement?.remove(); toastElement = null; };
  dialog.querySelector(".dialog-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => { detailId = null; detailStatus = null; detailRequest += 1; });

  async function action(approval, actionName, button, body = {}) {
    const workId = state.work?.id;
    if (workId !== approval.workId) return;
    const currentGeneration = generation;
    button.disabled = true;
    try {
      const result = await api(`${endpoint(workId, approval.id)}/${actionName}`, { method: "POST", body });
      if (generation !== currentGeneration || state.work?.id !== workId) return;
      clearToast();
      if (actionName === "undo") {
        if (dialog.open) dialog.close();
        notifyRecord(result);
      } else {
        toast(result.status === "succeeded" ? (actionName === "answer" ? "回答已保存，可以继续当前 AI 对话" : "审批执行成功") : result.reason || APPROVAL_STATUS_LABELS[result.status], ["failed", "invalid"].includes(result.status) ? "error" : "info");
        if (detailId === approval.id && dialog.open) { renderDetail(result); dialog.querySelector(".dialog-close").focus(); }
        if (result.status === "succeeded" && actionName !== "answer") await onChanged();
      }
      if (state.module === "approvals") await render();
    } catch (error) {
      if (generation === currentGeneration) toast(error.message, "error");
    } finally { if (button.isConnected) button.disabled = false; }
  }

  function bindActions(host, approval) {
    host.querySelectorAll("[data-approval-action]").forEach((button) => button.addEventListener("click", () => {
      if (button.dataset.approvalAction === "details") void open(approval.id);
      else void action(approval, button.dataset.approvalAction, button);
    }));
    const form = host.querySelector(".approval-question-form");
    if (!form) return;
    const custom = form.querySelector("textarea");
    form.addEventListener("change", () => {
      custom.disabled = new FormData(form).get("approval-answer") !== "custom";
      custom.required = !custom.disabled;
      if (!custom.disabled) custom.focus();
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const choice = new FormData(form).get("approval-answer");
      const answer = choice === "custom" ? custom.value.trim() : approval.question.options[Number(choice)];
      if (!answer) return toast("请选择选项或填写回答", "error");
      void action(approval, "answer", form.querySelector('[type="submit"]'), { answer });
    });
  }

  function changesMarkup(changes) {
    return changes.map((change) => `<section class="approval-field"><h4>${esc(change.label)} <code>${esc(change.field)}</code></h4>
      <div class="approval-field-values"><div><small>修改前</small><pre>${esc(formatValue(change.before))}</pre></div><div><small>修改后</small><pre>${esc(formatValue(change.after))}</pre></div></div>
      <details class="approval-diff"><summary>查看字段 diff</summary><pre>${esc(change.diff)}</pre></details></section>`).join("");
  }

  function renderDetail(approval) {
    detailId = approval.id;
    detailStatus = `${approval.status}:${Boolean(approval.redacted)}`;
    document.querySelector("#ai-approval-title").textContent = approval.kind === "question" ? "回答 AI 提问" : approval.kind === "undo" ? "撤销审批详情" : "AI 修改计划详情";
    content.innerHTML = `<div class="approval-detail-meta">${status(approval)}<p>${esc(approval.summary)}</p><small>创建于 ${esc(date(approval.createdAt))} · 有效期至 ${esc(date(approval.expiresAt))}</small><small>发起用户：${esc(approval.initiatedByName || approval.initiatedBy)} · 对话归属用户：${esc(approval.conversationOwnerName || approval.conversationOwner)}</small></div>
      ${approval.reason ? `<p class="approval-reason" role="status">${esc(approval.reason)}</p>` : ""}
      ${approval.redacted ? '<p class="empty-state">当前权限不足，完整修改内容已隐藏。</p>' : approval.kind === "question" ? (approval.status === "pending" ? approvalQuestionMarkup(approval.question, esc) : `<section class="record-card"><h3>${esc(approval.question.question)}</h3><p>${approval.result?.answer ? `用户回答：${esc(approval.result.answer)}` : "没有获得用户回答。"}</p></section>`) : approval.operations.map((operation, index) => `<article class="approval-operation record-card"><header><span class="eyebrow">操作 ${index + 1} · ${esc(moduleLabels[operation.module] || operation.module)}</span><h3>${esc(kindLabels[operation.kind] || operation.kind)} · ${esc(operation.targetName)}</h3><small>${operation.kind === "create" ? "新增词条" : `目标版本 v${esc(String(operation.targetVersion))}`}${operation.targetId ? ` · ${esc(operation.targetId)}` : ""}</small></header>${changesMarkup(operation.changes)}${operation.effects.map((effect) => `<section class="approval-related"><h4>同时影响：${esc(moduleLabels[effect.module])} · ${esc(effect.targetName)}</h4>${changesMarkup(effect.changes)}</section>`).join("")}</article>`).join("")}
      ${approval.result?.operations ? `<section class="record-card approval-results"><h3>执行结果</h3>${approval.result.operations.map((result) => `<p>${esc(kindLabels[approval.operations[result.index]?.kind] || "操作")} · ${esc(result.targetName)} · ${result.versionNo ? `v${esc(String(result.versionNo))}` : "已加入队列"}<small>${esc(result.targetId)} · 操作者：${esc(approval.executedByName || result.actorId)}</small></p>`).join("")}</section>` : ""}
      ${approval.audit?.length ? `<details class="approval-audit"><summary>查看审计记录（${approval.audit.length}）</summary>${approval.audit.map((item) => `<p><code>${esc(item.action)}</code><small>${esc(date(item.createdAt))} · ${esc(item.actorId || "系统")} · ${esc(item.id)}</small></p>`).join("")}</details>` : ""}`;
    const footer = document.querySelector("#ai-approval-actions");
    footer.innerHTML = approval.status === "pending" && !approval.redacted
      ? `<span>请核对后再${approval.kind === "question" ? "回答" : "整体确认"}。</span><button class="ghost-button" type="button" data-approval-action="reject">${approval.kind === "question" ? "拒绝回答" : "整体拒绝"}</button>${approval.kind === "question" ? "" : '<button class="primary-button" type="button" data-approval-action="confirm">确认并执行整份计划</button>'}`
      : approval.canUndo ? '<span>撤销仅恢复词条编辑，保留新增词条、批注和任务。</span><button class="ghost-button" type="button" data-approval-action="undo">撤销本次审批</button>' : "";
    bindActions(content, approval);
    bindActions(footer, approval);
  }

  async function open(approvalId) {
    const workId = state.work?.id;
    if (!workId) return;
    const currentGeneration = generation;
    const request = ++detailRequest;
    try {
      const approval = await api(endpoint(workId, approvalId));
      if (generation !== currentGeneration || request !== detailRequest || state.work?.id !== workId) return;
      clearToast();
      renderDetail(approval);
      if (!dialog.open) dialog.showModal();
      content.scrollTop = 0;
    } catch (error) { if (generation === currentGeneration) toast(error.message, "error"); }
  }

  function notifyRecord(approval) {
    if (approval.status !== "pending" || approval.redacted || toastElement || seen.has(approval.id)) return;
    seen.add(approval.id);
    const element = document.createElement("section");
    element.className = "toast toast-confirmation approval-toast";
    element.dataset.approvalId = approval.id;
    element.setAttribute("role", "alertdialog");
    element.setAttribute("aria-label", approval.kind === "question" ? "AI 提问待回答" : "AI 操作待确认");
    element.innerHTML = `<div class="approval-toast-heading"><strong>${approval.kind === "question" ? "AI 提问待回答" : "AI 操作待确认"}</strong><button class="ghost-button" type="button" aria-label="稍后在审批中心处理">×</button></div><p>${esc(targets(approval) || "当前 AI 对话")}</p><p>${esc(approval.summary)}</p><div class="toast-confirmation-actions"><button class="ghost-button" type="button" data-approval-action="details">查看完整详情</button><button class="ghost-button" type="button" data-approval-action="reject">拒绝</button>${approval.kind === "question" ? '<button class="primary-button" type="button" data-approval-action="details">回答问题</button>' : '<button class="primary-button" type="button" data-approval-action="confirm">整体确认</button>'}</div>`;
    element.querySelector('[aria-label="稍后在审批中心处理"]').addEventListener("click", clearToast);
    bindActions(element, approval);
    document.querySelector("#toast-region").append(element);
    toastElement = element;
    raiseToastRegion();
  }

  async function notify(approvalId) {
    const workId = state.work?.id;
    const currentGeneration = generation;
    if (!workId) return;
    try {
      const approval = await api(endpoint(workId, approvalId));
      if (generation === currentGeneration) notifyRecord(approval);
    } catch (error) { if (generation === currentGeneration) toast(error.message, "error"); }
  }

  async function render() {
    const workId = state.work?.id;
    const currentGeneration = generation;
    const request = ++listRequest;
    const page = await api(`${endpoint(workId)}?offset=${offset}&limit=30${statusFilter ? `&status=${encodeURIComponent(statusFilter)}` : ""}`);
    if (generation !== currentGeneration || request !== listRequest || state.module !== "approvals") return;
    mountModuleCount(page.total);
    const header = document.querySelector("#module-header-actions");
    header.querySelectorAll('[data-module-header-action^="approval-"]').forEach((item) => item.remove());
    header.insertAdjacentHTML("beforeend", `<button class="module-filter-toggle" type="button" data-module-header-action="approval-filter" aria-label="筛选审批" aria-controls="approval-filter-panel" aria-expanded="${filterOpen}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16l-6.5 7.2v5.3l-3 1.5v-6.8L4 5Z"></path></svg></button><button class="ghost-button" type="button" data-module-header-action="approval-refresh">刷新</button>`);
    header.querySelector('[data-module-header-action="approval-filter"]').addEventListener("click", (event) => { filterOpen = !filterOpen; document.querySelector("#approval-filter-panel").classList.toggle("hidden", !filterOpen); event.currentTarget.setAttribute("aria-expanded", String(filterOpen)); });
    header.querySelector('[data-module-header-action="approval-refresh"]').addEventListener("click", () => void render().catch((error) => toast(error.message, "error")));
    const host = document.querySelector("#module-content");
    host.innerHTML = `<section id="approval-filter-panel" class="approval-filter-panel ${filterOpen ? "" : "hidden"}"><label>审批状态<select id="approval-status-filter"><option value="">全部状态</option>${Object.entries(APPROVAL_STATUS_LABELS).map(([value, label]) => `<option value="${value}" ${statusFilter === value ? "selected" : ""}>${label}</option>`).join("")}</select></label></section><div class="approval-list">${page.items.length ? page.items.map((approval) => `<article class="record-card approval-card">${status(approval)}<h3>${esc(approval.kind === "question" ? "AI 提问" : targets(approval) || "修改计划")}</h3><p>${esc(approval.summary)}</p><small>${esc(date(approval.createdAt))}${approval.operations.length ? ` · ${approval.operations.length} 项操作` : ""}</small>${approval.reason ? `<p class="approval-reason">${esc(approval.reason)}</p>` : ""}<div class="card-actions"><button class="ghost-button" type="button" data-open-approval="${esc(approval.id)}">${approval.kind === "question" && approval.status === "pending" ? "回答问题" : "查看完整详情"}</button></div></article>`).join("") : '<div class="empty-state"><b>暂无审批记录</b>AI 提出的修改计划和问题会保存在这里。</div>'}</div><nav class="approval-pagination" aria-label="审批分页"><button class="ghost-button" type="button" id="approval-previous" ${offset === 0 ? "disabled" : ""}>上一页</button><span>第 ${Math.floor(offset / 30) + 1} 页 · 共 ${page.total} 条</span><button class="ghost-button" type="button" id="approval-next" ${offset + 30 >= page.total ? "disabled" : ""}>下一页</button></nav>`;
    host.querySelector("#approval-status-filter").addEventListener("change", (event) => { statusFilter = event.target.value; offset = 0; void render().then(() => document.querySelector("#approval-status-filter")?.focus()).catch((error) => toast(error.message, "error")); });
    host.querySelectorAll("[data-open-approval]").forEach((button) => button.addEventListener("click", () => void open(button.dataset.openApproval)));
    host.querySelector("#approval-previous").addEventListener("click", () => { offset = Math.max(0, offset - 30); void render(); });
    host.querySelector("#approval-next").addEventListener("click", () => { offset += 30; void render(); });
  }

  async function poll(workId, currentGeneration) {
    if (generation !== currentGeneration || state.work?.id !== workId || !state.user) return;
    try {
      const page = await api(`${endpoint(workId)}?status=pending&limit=100`);
      if (generation !== currentGeneration || state.work?.id !== workId) return;
      if (toastElement && !page.items.some((item) => item.id === toastElement.dataset.approvalId && item.status === "pending")) clearToast();
      if (dialog.open && detailId) {
        const approval = await api(endpoint(workId, detailId));
        if (generation === currentGeneration && dialog.open && detailId === approval.id && detailStatus !== `${approval.status}:${Boolean(approval.redacted)}`) renderDetail(approval);
      }
      if (!dialog.open) for (const approval of page.items) notifyRecord(approval);
    } catch (error) {
      if ([401, 403].includes(error.status)) { clearToast(); if (dialog.open) dialog.close(); return; }
    }
    if (generation === currentGeneration) pollTimer = setTimeout(() => void poll(workId, currentGeneration), 8000);
  }

  function reset() {
    generation += 1;
    clearTimeout(pollTimer);
    pollTimer = null;
    seen.clear();
    clearToast();
    if (dialog.open) dialog.close();
    offset = 0; statusFilter = ""; filterOpen = false;
  }
  function start() { clearTimeout(pollTimer); if (state.work) void poll(state.work.id, generation); }
  async function bindSettings(host, editable) {
    const workId = state.work.id;
    const settings = await api(`/api/works/${encodeURIComponent(workId)}/ai-settings/write-tools`);
    if (state.work?.id !== workId || state.module !== "ai-settings") return;
    host.insertAdjacentHTML("afterbegin", approvalSettingsMarkup(settings, editable, esc));
    host.querySelector("#save-ai-write-tools").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        await api(`/api/works/${encodeURIComponent(workId)}/ai-settings/write-tools`, { method: "PATCH", body: { enabled: [...host.querySelectorAll('input[name="ai-write-tool"]:checked')].map((input) => input.value) } });
        toast("可写工具设置已保存");
      } catch (error) { toast(error.message, "error"); }
      finally { button.disabled = !editable; }
    });
  }
  return { render, open, notify, reset, start, bindSettings };
}
