// AI 可写工具与持久化审批工作流的前端组件：
// 审批卡片（对话内）、完整修改明细、AskUserQuestions 回答框与审批中心列表。
// 所有内容均以服务端返回为准渲染；本模块不直接发起请求。

export const INTERACTIVE_AI_TOOL_NAMES = {
  propose_write_plan: "提交写入审批",
  ask_user_question: "向作者提问"
};

export const INTERACTIVE_AI_TOOL_DESCRIPTIONS = {
  propose_write_plan: "AI 只提交修改计划：系统按当前数据库生成字段级明细，作者确认后才会原子执行；任何情况下都不能删除条目或改写正文。",
  ask_user_question: "一次提问恰好一个问题，附带 2-6 个预设选项；作者未回答前 AI 必须等待，不能编造答案。"
};

/** 作品设置页的 AI 可写工具开关清单：与 ai-write-plans.ts 的常量保持一致。 */
export const AI_WRITE_TOOLS_META = [
  { id: "settings", label: "世界设定", description: "允许 AI 创建或编辑世界设定词条（不能删除）。" },
  { id: "characters", label: "角色", description: "允许 AI 创建或编辑角色条目（不能删除）。" },
  { id: "races", label: "种族", description: "允许 AI 创建或编辑种族设定（不能删除）。" },
  { id: "organizations", label: "组织", description: "允许 AI 创建或编辑组织设定（不能删除组织）。" },
  { id: "timeline", label: "时间线", description: "允许 AI 创建或编辑时间轴轨道与事件（不能删除）。" },
  { id: "relationships", label: "人物关系", description: "允许 AI 创建或编辑人物关系（不能删除）。" },
  { id: "outlines", label: "大纲/伏笔", description: "允许 AI 编辑章节大纲与创建或编辑伏笔（不能删除）。" },
  { id: "annotations", label: "正文评论/待办", description: "允许 AI 在正文指定位置添加评论或待办批注，不改动正文本身。" },
  { id: "analysis_tasks", label: "分析任务", description: "允许 AI 触发既有类型的分析任务进入现有队列。" },
  { id: "ask_user_questions", label: "用户提问", description: "允许 AI 通过 AskUserQuestions 向你提出单选问题。" }
];

const PLAN_STATUS_LABELS = {
  pending: "待确认",
  rejected: "已拒绝",
  expired: "已过期",
  invalidated: "已失效",
  executing: "执行中",
  executed: "执行成功",
  failed: "执行失败"
};

const QUESTION_STATUS_LABELS = {
  pending: "待回答",
  answered: "已回答",
  rejected: "已拒绝",
  expired: "已过期"
};

export function aiPlanStatusLabel(status) {
  return PLAN_STATUS_LABELS[String(status)] ?? String(status);
}

export function aiQuestionStatusLabel(status) {
  return QUESTION_STATUS_LABELS[String(status)] ?? String(status);
}

/** 状态徽章色调：CSS 里按 data-tone 展示统一配色。 */
export function statusTone(status) {
  switch (String(status)) {
    case "pending": return "pending";
    case "executing": return "running";
    case "executed":
    case "answered": return "success";
    case "rejected":
    case "invalidated":
    case "failed": return "danger";
    default: return "muted";
  }
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).format(date);
}

// ---------------------------------------------------------------------------
// 工具调用载荷解析
// ---------------------------------------------------------------------------

/**
 * 解析 propose_write_plan / ask_user_question 的工具结果为卡片模型。
 * 失败结果形如 { ok:false, error:{code,message} }；成功计划含 plan 摘要与最近计划列表。
 */
export function parseInteractiveToolPayload(toolCall) {
  const name = String(toolCall?.name ?? "");
  if (name !== "propose_write_plan" && name !== "ask_user_question") return null;
  const raw = toolCall?.result;
  let result = raw;
  if (typeof raw === "string") {
    try { result = JSON.parse(raw); } catch { result = null; }
  }
  const ok = result?.ok === true && toolCall?.status !== "failed";
  const error = result?.error ?? null;
  if (name === "propose_write_plan") {
    return {
      kind: "plan",
      ok,
      name,
      calledAt: toolCall?.calledAt ?? "",
      plan: ok ? result.plan ?? null : null,
      recentPlans: Array.isArray(result?.recentPlans) ? result.recentPlans : [],
      message: typeof result?.message === "string" ? result.message : "",
      error
    };
  }
  const options = Array.isArray(toolCall?.arguments?.options) ? toolCall.arguments.options : [];
  return {
    kind: "question",
    ok,
    name,
    calledAt: toolCall?.calledAt ?? "",
    question: ok ? result.question ?? null : null,
    argumentOptions: options.map((option) => String(option)),
    message: typeof result?.message === "string" ? result.message : "",
    error
  };
}

/**
 * 会话内的最新审批详情缓存：确认/撤销之后写回，避免卡片在重渲染时回退到提交时刻的快照。
 */
const livePlanDetails = new Map();

export function cacheAiWritePlanDetail(detail) {
  if (detail?.id) livePlanDetails.set(String(detail.id), detail);
}

export function cachedAiWritePlanDetail(planId) {
  return livePlanDetails.get(String(planId)) ?? null;
}

/** 用户提问的实时状态缓存：提交回答/拒绝后写回。 */
const liveQuestionViews = new Map();

export function cacheAiQuestionView(question) {
  if (question?.id) liveQuestionViews.set(String(question.id), question);
}

function cachedAiQuestionView(questionId) {
  return liveQuestionViews.get(String(questionId)) ?? null;
}

/**
 * 判断交互式工具调用当前是否会渲染出可操作的待处理卡片；
 * 历史消息据此自动展开"思考与执行过程"，避免待确认/待回答入口被折叠隐藏。
 */
export function isInteractiveToolPending(toolCall) {
  const model = parseInteractiveToolPayload(toolCall);
  if (!model?.ok) return false;
  if (model.kind === "plan") {
    const detail = model.plan?.id ? cachedAiWritePlanDetail(model.plan.id) : null;
    return (detail?.status ?? model.plan?.status ?? "") === "pending";
  }
  const question = model.question?.id ? cachedAiQuestionView(model.question.id) : null;
  return ((question ?? model.question)?.status ?? "") === "pending";
}

// ---------------------------------------------------------------------------
// 对话内交互卡片
// ---------------------------------------------------------------------------

function cardShell(kind, title, toolName) {
  const card = document.createElement("section");
  card.className = `ai-interactive-card ai-${kind}-card`;
  card.dataset.interactiveTool = toolName;
  const head = document.createElement("div");
  head.className = "ai-interactive-card-head";
  const label = document.createElement("strong");
  label.textContent = title;
  head.append(label);
  card.append(head);
  return card;
}

function metaRow(entries) {
  const dl = document.createElement("dl");
  dl.className = "ai-interactive-meta";
  for (const [term, definition] of entries) {
    const item = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = definition;
    item.append(dt, dd);
    dl.append(item);
  }
  return dl;
}

function statusBadge(text, tone) {
  const badge = document.createElement("span");
  badge.className = "ai-status-chip";
  badge.dataset.tone = tone;
  badge.textContent = text;
  return badge;
}

function actionButton(labelText, className, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = labelText;
  button.addEventListener("click", onClick);
  return button;
}

function buildPlanCard(model, actions) {
  // 优先使用缓存中的最新详情（用户刚刚确认/撤销过），否则回退到工具结果摘要。
  const liveDetail = model.plan ? cachedAiWritePlanDetail(model.plan.id) : null;
  const status = liveDetail?.status ?? model.plan?.status ?? "";
  const statusLabel = liveDetail?.statusLabel ?? aiPlanStatusLabel(status);
  const summary = liveDetail?.aiSummary ?? model.plan?.aiSummary ?? "";
  const operationCount = liveDetail?.operationCount ?? model.plan?.operationCount ?? 0;
  const card = cardShell("write-plan", `${INTERACTIVE_AI_TOOL_NAMES.propose_write_plan}`, model.name);
  const head = card.querySelector(".ai-interactive-card-head");
  head.append(statusBadge(statusLabel || "待确认", statusTone(status)));

  if (summary) {
    const body = document.createElement("p");
    body.className = "ai-interactive-summary";
    body.textContent = summary;
    card.append(body);
  }

  const targets = liveDetail?.operations?.map((operation) => operation.title)
    ?? (Array.isArray(model.plan?.targets) ? model.plan.targets : []);
  const moduleLabels = liveDetail?.moduleLabels ?? model.plan?.moduleLabels;
  const items = [["操作对象", targets.length > 0 ? targets.join("、") : `${operationCount} 个操作`]];
  if (Array.isArray(moduleLabels) && moduleLabels.length > 0) {
    items.push(["涉及模块", moduleLabels.join("、")]);
  }
  if (status === "executed") items.push(["执行时间", formatDateTime(liveDetail?.executedAt)]);
  if (status === "rejected") items.push(["处理时间", formatDateTime(liveDetail?.decidedAt)]);
  card.append(metaRow(items));

  if (liveDetail?.invalidReason) {
    const reason = document.createElement("p");
    reason.className = "ai-interactive-warn";
    reason.textContent = `失效原因：${liveDetail.invalidReason}`;
    card.append(reason);
  } else if (liveDetail?.failureMessage) {
    const failure = document.createElement("p");
    failure.className = "ai-interactive-warn";
    failure.textContent = `失败原因：${liveDetail.failureMessage}`;
    card.append(failure);
  }

  const actionsBar = document.createElement("div");
  actionsBar.className = "ai-interactive-actions";
  const planId = model.plan?.id ?? liveDetail?.id ?? "";
  actionsBar.append(actionButton("完整修改明细", "ghost-button ai-card-action", () => actions.openPlanDetail(planId)));
  if (status === "pending") {
    actionsBar.append(
      actionButton("拒绝", "ghost-button ai-card-danger", () => actions.rejectPlan(planId)),
      actionButton("确认执行", "primary-button ai-card-primary", () => actions.confirmPlan(planId))
    );
  } else if (status === "executed") {
    actionsBar.append(actionButton("查看执行结果与撤销", "ghost-button ai-card-action", () => actions.openPlanDetail(planId)));
  }
  card.append(actionsBar);

  const note = document.createElement("p");
  note.className = "ai-interactive-note";
  note.textContent = status === "pending"
    ? "确认后系统会重新校验权限、开关与目标版本，全部通过才原子执行；拒绝或过期都不会产生任何写入。"
    : (model.message || "详情与审计记录见 AI 操作审批中心。");
  card.append(note);
  return card;
}

function buildQuestionCard(model, actions) {
  // 回答/拒绝后缓存里有更新状态时优先展示。
  const question = cachedAiQuestionView(model.question?.id) ?? model.question;
  const status = question?.status ?? "";
  const statusLabel = question ? (question.statusLabel ?? aiQuestionStatusLabel(status)) : "";
  const card = cardShell("question", `${INTERACTIVE_AI_TOOL_NAMES.ask_user_question}`, model.name);
  const head = card.querySelector(".ai-interactive-card-head");
  if (statusLabel) head.append(statusBadge(statusLabel, statusTone(status)));

  if (question?.question) {
    const body = document.createElement("p");
    body.className = "ai-interactive-summary";
    body.textContent = question.question;
    card.append(body);
  }

  const options = question?.options?.length
    ? question.options.map((option) => option.label)
    : model.argumentOptions;
  if (options.length > 0) {
    const list = document.createElement("ol");
    list.className = "ai-question-option-preview";
    for (const [index, option] of options.entries()) {
      const item = document.createElement("li");
      item.textContent = option;
      if (index === 0) item.classList.add("is-recommended");
      list.append(item);
    }
    card.append(list);
  }

  const expiresAt = question?.expiresAt;
  if (expiresAt) {
    card.append(metaRow([["有效期至", formatDateTime(expiresAt)]]));
  }

  const actionsBar = document.createElement("div");
  actionsBar.className = "ai-interactive-actions";
  if (question && status === "pending") {
    actionsBar.append(
      actionButton("暂不回答", "ghost-button ai-card-danger", () => actions.rejectQuestion(question.id)),
      actionButton("回答问题", "primary-button ai-card-primary", () => actions.openQuestionDialog(question.id))
    );
  } else if (question) {
    actionsBar.append(actionButton("查看回答状态", "ghost-button ai-card-action", () => actions.openApprovalCenter()));
  }
  card.append(actionsBar);

  const note = document.createElement("p");
  note.className = "ai-interactive-note";
  note.textContent = model.ok
    ? "选择一个预设选项或填写自定义回答；不做选择时该问题会过期，AI 不允许自行假定答案。"
    : "本次提问未能创建。";
  card.append(note);
  return card;
}

function buildFailureCard(model) {
  const card = cardShell("interactive-failure", `${INTERACTIVE_AI_TOOL_NAMES[model.name] ?? model.name}`, model.name);
  const head = card.querySelector(".ai-interactive-card-head");
  head.append(statusBadge("调用失败", "danger"));
  const body = document.createElement("p");
  body.className = "ai-interactive-summary";
  body.textContent = String(model.error?.message ?? "可写工具调用失败，未产生任何写入或提问。");
  card.append(body);
  const note = document.createElement("p");
  note.className = "ai-interactive-note";
  note.textContent = "失败的工具调用不会写入任何数据；AI 需要根据错误信息调整后再重新发起。";
  card.append(note);
  return card;
}

/**
 * 为交互式可写工具构建消息流内的操作卡片；非交互式工具返回 null。
 */
export function createInteractiveToolCard(toolCall, actions) {
  const model = parseInteractiveToolPayload(toolCall);
  if (!model) return null;
  try {
    if (!model.ok) return buildFailureCard(model);
    if (model.kind === "plan" && model.plan) return buildPlanCard(model, actions);
    if (model.kind === "question" && model.question) return buildQuestionCard(model, actions);
    return buildFailureCard({ ...model, ok: false, error: model.error ?? { code: "UNKNOWN", message: "工具结果缺少必要数据。" } });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 完整修改明细（审批详情弹窗主体）
// ---------------------------------------------------------------------------

function diffPreviewBlock(preview, className) {
  if (!preview) return "";
  return `<pre class="diff-preview ${className}">${esc(preview)}</pre>`;
}

function fieldDiffRows(operation) {
  if (!operation.fields?.length) return "";
  return `<table class="ai-field-diff-table"><thead><tr><th>字段</th><th>修改前</th><th>修改后</th></tr></thead><tbody>${operation.fields.map((field) => `
    <tr class="${field.changed ? "is-changed" : ""}">
      <td><strong>${esc(field.label)}</strong>${field.addedLines || field.removedLines ? `<small>新增 ${field.addedLines} 行 / 删除 ${field.removedLines} 行</small>` : ""}</td>
      <td>${field.before === null || field.before === undefined || field.before === "" ? '<span class="diff-empty">空</span>' : `<div class="diff-value">${esc(field.before)}</div>${diffPreviewBlock(field.previewBefore, "diff-remove")}`}</td>
      <td>${field.after === null || field.after === undefined || field.after === "" ? '<span class="diff-empty">空</span>' : `<div class="diff-value">${esc(field.after)}</div>${diffPreviewBlock(field.previewAfter, "diff-add")}`}</td>
    </tr>`).join("")}</tbody></table>`;
}

function operationSection(operation) {
  const headingBits = [`#${operation.seq} ${operation.opTypeLabel}`, operation.moduleLabel];
  if (operation.targetVersionNo !== null && operation.targetVersionNo !== undefined) {
    headingBits.push(`当前版本 v${operation.targetVersionNo}`);
  }
  const modules = operation.requiredModuleLabels?.length
    ? `<div class="ai-op-required">所需模块权限：${operation.requiredModuleLabels.map((label) => `<span>${esc(label)}</span>`).join("")}</div>`
    : "";
  const annotation = operation.annotation
    ? `<div class="ai-op-annotation"><div><span>类型</span><strong>${esc(operation.annotation.kindLabel)}</strong></div><div><span>位置</span><strong>第 ${operation.annotation.startLine}-${operation.annotation.endLine} 行</strong></div>${operation.annotation.quote ? `<blockquote class="ai-op-quote">${esc(operation.annotation.quote)}</blockquote>` : ""}<p class="ai-op-note">${esc(operation.annotation.note)}</p></div>`
    : "";
  const task = operation.task
    ? `<div class="ai-op-task"><div><span>任务类型</span><strong>${esc(operation.task.taskTypeLabel)}</strong></div><div><span>分析范围</span><strong>${esc(operation.task.scopeSummary)}</strong></div>${operation.task.modelId ? `<div><span>指定模型</span><code>${esc(operation.task.modelId)}</code></div>` : ""}</div>`
    : "";
  const result = operation.result
    ? `<div class="ai-op-result"><strong>执行结果</strong><p>${esc(operation.result.summary)}</p><small>版本号：${operation.result.versionNo ?? "-"} · 操作者与审计记录见本页底部。</small></div>`
    : "";
  const audits = operation.auditRecords?.length
    ? `<ul class="ai-op-audits">${operation.auditRecords.map((record) => `<li><strong>${esc(record.actor)}</strong><span>${esc(record.action)} · ${esc(formatDateTime(record.createdAt))}</span></li>`).join("")}</ul>`
    : "";
  return `<section class="ai-operation-item${operation.restricted ? " is-restricted" : ""}">
    <header><h4>${headingBits.map((bit) => esc(bit)).join(" · ")}</h4>${operation.restricted ? '<span class="ai-status-chip" data-tone="muted">无权查看内容</span>' : ""}</header>
    <h5>${esc(operation.title)}</h5>
    ${annotation}${task}${fieldDiffRows(operation)}${result}${audits}${modules}
  </section>`;
}

/** 审批详情弹窗主体：操作列表由服务端固化生成，前端只做呈现。 */
export function renderWritePlanDetailMarkup(detail) {
  const overallTone = statusTone(detail.status);
  const headerMeta = [];
  if (detail.kindLabel) headerMeta.push(detail.kindLabel);
  if (detail.operationCount) headerMeta.push(`${detail.operationCount} 个操作`);
  if (detail.createdAt) headerMeta.push(`发起于 ${formatDateTime(detail.createdAt)}`);
  if (detail.decidedAt) headerMeta.push(`处理于 ${formatDateTime(detail.decidedAt)}`);
  const banner = detail.status === "invalidated" && detail.invalidReason
    ? `<p class="ai-plan-banner is-invalidated">${esc(detail.invalidReason)}</p>`
    : detail.status === "failed" && detail.failureMessage
      ? `<p class="ai-plan-banner is-failed">${esc(detail.failureMessage)}</p>`
      : "";
  const operations = (detail.operations ?? []).map((operation) => operationSection(operation)).join("");
  const footerBits = [];
  if (detail.sourcePlanId) footerBits.push(`来源审批：${detail.sourcePlanId}`);
  if (detail.initiatorUserId) footerBits.push(`发起人 ID：${detail.initiatorUserId}`);
  if (detail.decidedByName || detail.decidedByUserId) footerBits.push(`操作者：${detail.decidedByName || detail.decidedByUserId}`);
  footerBits.push("每次确认都会写入审计日志");
  return `
    <div class="ai-plan-detail-head">
      <span class="ai-status-chip" data-tone="${overallTone}">${esc(aiPlanStatusLabel(detail.status))}</span>
      <span class="eyebrow">${headerMeta.map((item) => esc(item)).join(" · ")}</span>
    </div>
    <h3 class="ai-plan-summary-title">AI 简述</h3>
    <p class="ai-plan-summary-text">${esc(detail.aiSummary)}</p>
    ${banner}
    <div class="ai-operation-list">${operations || '<p class="usage-measurement-note">没有可展示的操作记录。</p>'}</div>
    <p class="usage-measurement-note ai-plan-audit-note">${footerBits.map((item) => esc(item)).join(" · ")}</p>`;
}

/** 审批中心列表行。 */
export function renderApprovalCenterRows(plans, questions = []) {
  if (!plans.length && !questions.length) {
    return '<p class="usage-measurement-note ai-approval-empty">还没有审批或提问记录。AI 提交交互后会出现在这里。</p>';
  }
  const planRows = plans.map((plan) => `
    <li>
      <button type="button" class="ai-approval-row" data-plan-id="${esc(plan.id)}">
        <span class="ai-status-chip" data-tone="${statusTone(plan.status)}">${esc(plan.statusLabel)}</span>
        <span class="ai-approval-row-main">
          <strong>${plan.kind === "undo" ? "撤销审批" : "写入审批"} · ${esc(plan.aiSummary)}</strong>
          <small>${esc((plan.moduleLabels ?? []).join("、")) || "—"} · ${Number(plan.operationCount)} 个操作 · ${esc(formatDateTime(plan.createdAt))}</small>
        </span>
        <span class="ai-approval-row-open" aria-hidden="true">查看</span>
      </button>
    </li>`).join("");
  const questionRows = questions.map((question) => `
    <li>
      <button type="button" class="ai-approval-row" data-question-id="${esc(question.id)}">
        <span class="ai-status-chip" data-tone="${statusTone(question.status)}">${esc(question.statusLabel)}</span>
        <span class="ai-approval-row-main">
          <strong>AI 提问 · ${esc(question.question)}</strong>
          <small>${question.answerText ? `回答：${esc(question.answerText)} · ` : ""}${esc(formatDateTime(question.createdAt))}</small>
        </span>
        <span class="ai-approval-row-open">查看</span>
      </button>
    </li>`).join("");
  return `<ul class="ai-approval-list">${planRows}${questionRows}</ul>`;
}

export { esc as aiEsc, formatDateTime as aiFormatDateTime };
