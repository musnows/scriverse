const mentionPattern = /mention:\/\/(character|user)\/([A-Za-z0-9_.:-]{1,200})/gu;

function array(value) {
  return Array.isArray(value) ? value : [];
}

function value(record, key, fallback = "") {
  return record && typeof record === "object" && !Array.isArray(record) && record[key] !== undefined
    ? record[key]
    : fallback;
}

function requestId() {
  return `im-${crypto.randomUUID()}`;
}

function imAvatarInitial(item, kind) {
  const label = kind === "user"
    ? item?.displayName || item?.username || "人"
    : item?.name || "角";
  return Array.from(String(label))[0] ?? (kind === "user" ? "人" : "角");
}

function bindImAvatarFallbacks(root) {
  root.querySelectorAll("[data-im-avatar-image]").forEach((image) => {
    image.addEventListener("error", () => image.remove(), { once: true });
  });
}

export function serializeImComposer(root) {
  const visit = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? "";
    if (!(node instanceof HTMLElement)) return "";
    if (node.dataset.imMentionUri) return node.dataset.imMentionUri;
    if (node.tagName === "BR") return "\n";
    const content = [...node.childNodes].map(visit).join("");
    return node !== root && ["DIV", "P"].includes(node.tagName) ? `${content}\n` : content;
  };
  return visit(root).replace(/\u00a0/gu, " ").trim();
}

export function normalizeImComposerHeight(value, maximumHeight, minimumHeight = 64) {
  const maximum = Math.max(minimumHeight, Number(maximumHeight) || minimumHeight);
  return Math.min(maximum, Math.max(minimumHeight, Number(value) || minimumHeight));
}

export function normalizeImConversationWidth(value, maximumWidth, minimumWidth = 72, defaultWidth = 300) {
  const maximum = Math.max(minimumWidth, Number(maximumWidth) || minimumWidth);
  const requested = Number.isFinite(Number(value)) ? Number(value) : defaultWidth;
  return Math.min(maximum, Math.max(minimumWidth, requested));
}

export function resolveImConversationWidth(preferredWidth, viewportWidth, maximumWidth) {
  return Number(viewportWidth) <= 620 ? 72 : normalizeImConversationWidth(preferredWidth, maximumWidth);
}

export function shouldMarkImConversationRead(opened, visibilityState) {
  return opened === true && visibilityState !== "hidden";
}

export function shouldRefreshImConversationListForEvent(type) {
  return ["conversation", "message", "chain"].includes(String(type));
}

export function findImMentionQuery(text, caretOffset = String(text).length) {
  const source = String(text);
  const offset = Math.max(0, Math.min(source.length, Number(caretOffset) || 0));
  const match = source.slice(0, offset).match(/@([^@\s]*)$/u);
  return match ? { query: match[1], startOffset: offset - match[0].length, endOffset: offset } : null;
}

export function shouldFollowImFeed(scrollHeight, scrollTop, clientHeight, force = false) {
  return force === true || Number(scrollHeight) - Number(scrollTop) - Number(clientHeight) < 80;
}

export function mergeImMessagePages(previousMessages, ...nextPages) {
  const byId = new Map();
  for (const message of [...array(previousMessages), ...nextPages.flatMap(array)]) {
    const key = String(message?.id || `sequence:${Number(message?.sequence)}`);
    byId.set(key, message);
  }
  return [...byId.values()].sort((left, right) => Number(left.sequence) - Number(right.sequence));
}

export function imMessageSequenceBounds(messages) {
  const sequences = array(messages).map((message) => Number(message?.sequence)).filter(Number.isFinite);
  return sequences.length ? { minimum: Math.min(...sequences), maximum: Math.max(...sequences) } : null;
}

export function hasImMessageSequenceGap(previousMessages, nextMessages) {
  const previous = imMessageSequenceBounds(previousMessages);
  const next = imMessageSequenceBounds(nextMessages);
  return Boolean(previous && next && previous.maximum + 1 < next.minimum);
}

export async function collectImMessageGap(previousMessages, nextMessages, loadPage) {
  const gapMessages = [];
  const nextBounds = imMessageSequenceBounds(nextMessages);
  let cursor = imMessageSequenceBounds(previousMessages)?.maximum ?? 0;
  while (nextBounds && cursor + 1 < nextBounds.minimum) {
    const page = await loadPage(cursor);
    const messages = array(page?.messages);
    const pageBounds = imMessageSequenceBounds(messages);
    if (!pageBounds || pageBounds.maximum <= cursor) throw new Error("IM 历史消息补齐失败，请重试");
    gapMessages.push(...messages);
    cursor = pageBounds.maximum;
    if (page?.hasMoreMessagesAfter !== true && cursor + 1 < nextBounds.minimum) {
      throw new Error("IM 历史消息存在缺口，请重新打开会话");
    }
  }
  return gapMessages;
}

export function createImWorkspace({ api, esc, renderMarkdown, toast, confirmToast, state, showShelf }) {
  const workspace = document.querySelector("#im-view");
  const listHost = document.querySelector("#im-conversation-list");
  const feed = document.querySelector("#im-message-feed");
  const composer = document.querySelector("#im-composer");
  const composerResize = document.querySelector("#im-composer-resize");
  const conversationsPanel = workspace.querySelector(".im-conversations");
  const conversationsResize = document.querySelector("#im-conversations-resize");
  const mentionMenu = document.querySelector("#im-mention-menu");
  const unreadBadge = document.querySelector("#im-unread-count");
  let conversations = [];
  let current = null;
  let works = [];
  let createCharacters = [];
  const createSelectedCharacters = new Map();
  let createSearchTimer = null;
  let createSearchRequest = 0;
  let memberAddKind = null;
  let memberAddCandidates = [];
  let memberAddSelectedId = "";
  let memberAddSearchTimer = null;
  let memberAddRequest = 0;
  let conversationListRequest = 0;
  const conversationSummaryRequests = new Map();
  let conversationRequest = 0;
  let diagnosticsRequest = 0;
  let requestedConversationId = null;
  let users = [];
  let models = [];
  let settings = null;
  let eventSource = null;
  const provisionalReplies = new Map();
  let mentionOptions = [];
  let mentionIndex = -1;
  let mentionCaretState = null;
  let opened = false;
  let composerHeight = 68;
  let conversationsWidth = 300;
  let preferredConversationsWidth = 300;

  const conversationsWidthStorageKey = "scriverse.im.conversations-width.v1";
  const conversationsMaximumWidth = () => Math.max(72, Math.min(420, window.innerWidth - (window.innerWidth > 980 ? 680 : 360)));

  function applyConversationsWidth(width, persist = false) {
    conversationsWidth = resolveImConversationWidth(width, window.innerWidth, conversationsMaximumWidth());
    if (window.innerWidth > 620) preferredConversationsWidth = conversationsWidth;
    workspace.style.setProperty("--im-conversations-width", `${conversationsWidth}px`);
    conversationsPanel.classList.toggle("is-compact", conversationsWidth <= 180);
    conversationsResize.setAttribute("aria-valuemax", String(conversationsMaximumWidth()));
    conversationsResize.setAttribute("aria-valuenow", String(Math.round(conversationsWidth)));
    if (persist && window.innerWidth > 620) {
      try { localStorage.setItem(conversationsWidthStorageKey, String(Math.round(preferredConversationsWidth))); } catch { /* 浏览器禁用存储时仅保留当前布局。 */ }
    }
  }

  function setupConversationsResize() {
    let resize = null;
    try { preferredConversationsWidth = Number(localStorage.getItem(conversationsWidthStorageKey)) || preferredConversationsWidth; } catch { /* 浏览器禁用存储时使用默认宽度。 */ }
    conversationsWidth = preferredConversationsWidth;
    conversationsResize.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || window.innerWidth <= 620) return;
      resize = { pointerId: event.pointerId, startX: event.clientX, startWidth: conversationsWidth };
      conversationsResize.setPointerCapture(event.pointerId);
      document.body.classList.add("is-im-conversations-resizing");
    });
    conversationsResize.addEventListener("pointermove", (event) => {
      if (!resize || event.pointerId !== resize.pointerId) return;
      applyConversationsWidth(resize.startWidth + event.clientX - resize.startX);
    });
    const finish = (event) => {
      if (!resize || event.pointerId !== resize.pointerId) return;
      resize = null;
      document.body.classList.remove("is-im-conversations-resizing");
      applyConversationsWidth(conversationsWidth, true);
    };
    conversationsResize.addEventListener("pointerup", finish);
    conversationsResize.addEventListener("pointercancel", finish);
    conversationsResize.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || window.innerWidth <= 620) return;
      event.preventDefault();
      if (event.key === "Home") applyConversationsWidth(72, true);
      else if (event.key === "End") applyConversationsWidth(conversationsMaximumWidth(), true);
      else applyConversationsWidth(conversationsWidth + (event.key === "ArrowRight" ? 16 : -16), true);
    });
    window.addEventListener("resize", () => applyConversationsWidth(preferredConversationsWidth));
    applyConversationsWidth(preferredConversationsWidth);
  }

  const composerMaximumHeight = () => Math.max(64, Math.min(420, window.innerHeight - 280));

  function applyComposerHeight(height) {
    composerHeight = normalizeImComposerHeight(height, composerMaximumHeight());
    composer.style.height = `${composerHeight}px`;
    composerResize.setAttribute("aria-valuemax", String(composerMaximumHeight()));
    composerResize.setAttribute("aria-valuenow", String(Math.round(composerHeight)));
  }

  function setupComposerResize() {
    let resize = null;
    composerResize.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      resize = { pointerId: event.pointerId, startY: event.clientY, startHeight: composerHeight };
      composerResize.setPointerCapture(event.pointerId);
      document.body.classList.add("is-im-composer-resizing");
    });
    composerResize.addEventListener("pointermove", (event) => {
      if (!resize || event.pointerId !== resize.pointerId) return;
      applyComposerHeight(resize.startHeight + resize.startY - event.clientY);
    });
    const finish = (event) => {
      if (!resize || event.pointerId !== resize.pointerId) return;
      resize = null;
      document.body.classList.remove("is-im-composer-resizing");
    };
    composerResize.addEventListener("pointerup", finish);
    composerResize.addEventListener("pointercancel", finish);
    composerResize.addEventListener("keydown", (event) => {
      if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      if (event.key === "Home") applyComposerHeight(64);
      else if (event.key === "End") applyComposerHeight(composerMaximumHeight());
      else applyComposerHeight(composerHeight + (event.key === "ArrowUp" ? 24 : -24));
    });
    window.addEventListener("resize", () => applyComposerHeight(composerHeight));
    applyComposerHeight(composerHeight);
  }

  const hideMainViews = () => {
    [
      "shelf-view", "platform-ai-view", "platform-usage-view", "work-audit-view", "settings-hub-view",
      "welcome-view", "editor-view", "module-view", "members-view", "admin-ai-conversations-view"
    ].forEach((id) => document.querySelector(`#${id}`)?.classList.add("hidden"));
  };

  const currentUserId = () => state.user?.userId ?? "";

  function imAvatarHtml(item, kind, extraClass = "") {
    const avatarClass = kind === "user" ? "user-avatar" : "character-avatar";
    const fallbackClass = kind === "user" ? "user-avatar-fallback" : "character-avatar-fallback";
    const image = item?.avatarUrl
      ? `<img src="${esc(item.avatarUrl)}" alt="" loading="lazy" decoding="async" data-im-avatar-image>`
      : "";
    return `<span class="${avatarClass}${extraClass ? ` ${esc(extraClass)}` : ""}" aria-hidden="true"><span class="${fallbackClass}">${esc(imAvatarInitial(item, kind))}</span>${image}</span>`;
  }

  function renderUnread() {
    const count = conversations.reduce((total, item) => total + Number(item.unreadCount || 0), 0);
    unreadBadge.textContent = count > 99 ? "99+" : String(count);
    unreadBadge.classList.toggle("hidden", count === 0);
    document.querySelector("#im-open-button")?.setAttribute("aria-label", count ? `打开 IM，${count} 条未读` : "打开 IM");
  }

  async function refreshConversations() {
    const request = ++conversationListRequest;
    const nextConversations = array(await api("/api/im/conversations"));
    if (request !== conversationListRequest) return;
    conversations = nextConversations;
    renderUnread();
    renderConversationList();
  }

  function upsertConversationSummary(summary) {
    const index = conversations.findIndex((conversation) => conversation.id === summary.id);
    if (index >= 0) conversations[index] = summary;
    else conversations.push(summary);
    conversations.sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
    renderUnread();
    renderConversationList();
  }

  async function refreshConversationSummary(conversationId) {
    const request = (conversationSummaryRequests.get(conversationId) || 0) + 1;
    conversationSummaryRequests.set(conversationId, request);
    const summary = await api(`/api/im/conversations/${encodeURIComponent(conversationId)}/summary`);
    if (conversationSummaryRequests.get(conversationId) !== request) return;
    upsertConversationSummary(summary);
  }

  function conversationSubtitle(item) {
    if (item.status === "disbanded") return "已解散 · 历史只读";
    if (item.active === false) return "已退出 · 历史只读";
    if (item.kind === "direct") return "角色单聊";
    return item.replyMode === "proactive" ? `主动交流 · 阈值 ${item.responseThreshold}` : "Mention 模式";
  }

  function conversationAvatarHtml(item) {
    if (item.kind === "direct") {
      const character = array(item.avatarCharacters)[0];
      return character
        ? imAvatarHtml(character, "character", "im-conversation-single-avatar")
        : '<span class="im-conversation-avatar" aria-hidden="true">角</span>';
    }
    const members = array(item.avatarMembers).slice(0, 9);
    const gridSize = members.length <= 4 ? 4 : 9;
    const cells = [
      ...members.map((member) => imAvatarHtml(member, member.kind === "user" ? "user" : "character", "im-group-avatar-cell")),
      ...Array.from({ length: Math.max(0, gridSize - members.length) }, () => '<span class="im-group-avatar-empty"></span>')
    ];
    return `<span class="im-group-avatar-grid" data-grid-size="${gridSize}" aria-hidden="true">${cells.join("")}</span>`;
  }

  function renderConversationList() {
    listHost.innerHTML = conversations.length
      ? conversations.map((item) => `<button class="im-conversation-item${current?.id === item.id ? " is-active" : ""}" type="button" data-im-conversation="${esc(item.id)}" aria-label="${esc(`${item.title}，${conversationSubtitle(item)}`)}" title="${esc(item.title)}">
          ${conversationAvatarHtml(item)}
          <span><strong>${esc(item.title)}</strong><small>${esc(conversationSubtitle(item))}</small></span>
          ${item.mentionUnreadCount ? `<b class="im-mention-unread">@${Number(item.mentionUnreadCount)}</b>` : item.unreadCount ? `<b class="im-item-unread">${Number(item.unreadCount)}</b>` : ""}
        </button>`).join("")
      : '<p class="im-empty">还没有 IM 会话。点击“新建会话”，先选书籍，再选择一个或多个角色。</p>';
    bindImAvatarFallbacks(listHost);
  }

  function mentionLabel(mention) {
    const snapshot = value(mention, "snapshot", {});
    return mention.kind === "user"
      ? snapshot.displayName || snapshot.username || mention.id
      : snapshot.name || mention.id;
  }

  function messageHtml(message) {
    let source = String(message.content ?? "");
    const tokens = [];
    const mentions = array(message.mentions);
    const consumedMentions = new Set();
    source = source.replace(mentionPattern, (raw, kind, id) => {
      const mentionIndex = mentions.findIndex((mention, index) => !consumedMentions.has(index) && mention.kind === kind && mention.id === id);
      if (mentionIndex < 0) return raw;
      const mention = mentions[mentionIndex];
      consumedMentions.add(mentionIndex);
      const token = `IMMENTION${String(message.id).replace(/[^A-Za-z0-9]/gu, "")}TOKEN${mentionIndex}END`;
      tokens.push({ token, mention });
      return token;
    });
    let html = renderMarkdown(source);
    for (const token of tokens) {
      html = html.replaceAll(
        token.token,
        `<span class="im-inline-mention" data-im-rendered-mention="${esc(token.mention.kind)}:${esc(token.mention.id)}">@${esc(mentionLabel(token.mention))}</span>`
      );
    }
    return html;
  }

  function upsertProvisionalReply(payload) {
    const turnId = String(payload?.turnId || payload?.id || "");
    if (!turnId) return null;
    const previous = provisionalReplies.get(turnId) || {};
    const eventCharacter = value(payload, "character", {});
    const characterId = String(payload?.characterId || eventCharacter.characterId || previous.characterId || "");
    const character = activeCharacters().find((item) => item.characterId === characterId);
    const eventError = value(payload, "error", {});
    const next = {
      ...previous,
      turnId,
      chainId: String(payload?.chainId || previous.chainId || ""),
      characterId,
      name: eventCharacter.name || character?.name || previous.name || "角色",
      avatarUrl: eventCharacter.avatarUrl || character?.avatarUrl || previous.avatarUrl || null,
      status: String(payload?.status || previous.status || "pending"),
      error: eventError.message || payload?.failure || previous.error || "",
      content: payload?.content !== undefined ? String(payload.content) : previous.content || ""
    };
    provisionalReplies.set(turnId, next);
    return next;
  }

  function syncProvisionalReplies() {
    const previous = new Map(provisionalReplies);
    const streaming = new Map(array(current?.streamingReplies).map((reply) => [String(reply.turnId || ""), reply]));
    provisionalReplies.clear();
    for (const turn of array(current?.activeChain?.turns)) {
      if (!['pending', 'running', 'failed', 'skipped'].includes(String(turn.status))) continue;
      const retained = previous.get(String(turn.id));
      const snapshot = streaming.get(String(turn.id));
      const next = upsertProvisionalReply({ ...turn, ...snapshot, turnId: turn.id });
      if (next && !snapshot?.content && retained?.content) next.content = retained.content;
    }
  }

  function provisionalReplyBodyHtml(reply) {
    const failed = ["failed", "skipped"].includes(reply.status);
    const pendingCopy = reply.status === "pending" ? "等待角色开始回答…" : "正在组织回答…";
    const content = reply.content ? renderMarkdown(reply.content) : failed ? "" : `<p class="im-provisional-placeholder">${pendingCopy}</p>`;
    const failure = failed ? `<p class="im-provisional-error">${esc(reply.error || "角色回答生成失败")}</p>` : "";
    return `${content}${failure}`;
  }

  function syncGeneratingSummary() {
    const count = [...provisionalReplies.values()].filter((reply) => ["pending", "running"].includes(reply.status)).length;
    const summary = feed.querySelector(".im-generating-summary");
    if (summary && count > 0) summary.textContent = `${count} 个角色正在生成回答`;
    else if (summary) summary.remove();
    return count;
  }

  function updateProvisionalReplyElement(reply) {
    const article = [...feed.querySelectorAll("[data-im-provisional-turn]")]
      .find((item) => item.dataset.imProvisionalTurn === reply.turnId);
    if (!article) {
      renderMessages();
      return;
    }
    const follow = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
    const failed = ["failed", "skipped"].includes(reply.status);
    const statusLabel = reply.status === "pending" ? "等待生成" : reply.status === "running" ? "正在生成" : reply.status === "skipped" ? "未生成" : "生成失败";
    article.classList.toggle("is-failed", failed);
    article.dataset.imProvisionalStatus = reply.status;
    article.querySelector(".im-provisional-status").textContent = statusLabel;
    article.querySelector(".im-message-body").innerHTML = provisionalReplyBodyHtml(reply);
    syncGeneratingSummary();
    if (follow) feed.scrollTop = feed.scrollHeight;
  }

  function renderMessages({ scrollToBottom = false } = {}) {
    const follow = shouldFollowImFeed(feed.scrollHeight, feed.scrollTop, feed.clientHeight, scrollToBottom);
    const previousTop = feed.scrollTop;
    const messages = array(current?.messages);
    const provisional = [...provisionalReplies.values()];
    if (!messages.length && !provisional.length) {
      feed.innerHTML = '<p class="im-feed-empty">从一条消息开始。角色单聊会直接回复；群聊按当前回复模式调度 AI。</p>';
      return;
    }
    const loadOlder = current?.hasMoreMessages
      ? '<button class="im-load-older" type="button" data-im-load-older>加载更早消息</button>'
      : "";
    const generatingCount = provisional.filter((reply) => ['pending', 'running'].includes(reply.status)).length;
    const generatingSummary = generatingCount
      ? `<div class="im-generating-summary" role="status">${generatingCount} 个角色正在生成回答</div>`
      : "";
    const provisionalHtml = provisional.map((reply) => {
      const failed = ['failed', 'skipped'].includes(reply.status);
      const statusLabel = reply.status === "pending" ? "等待生成" : reply.status === "running" ? "正在生成" : reply.status === "skipped" ? "未生成" : "生成失败";
      return `<article class="im-message is-character is-provisional${failed ? " is-failed" : ""}" data-im-provisional-turn="${esc(reply.turnId)}" data-im-provisional-status="${esc(reply.status)}">
        <header>${imAvatarHtml(reply, "character", "im-message-avatar")}<strong>${esc(reply.name || "角色")}</strong><span class="im-provisional-status">${statusLabel}</span></header>
        <div class="im-message-body message-body">${provisionalReplyBodyHtml(reply)}</div>
      </article>`;
    }).join("");
    feed.innerHTML = loadOlder + messages.map((message) => {
      const sender = value(message, "sender", {});
      const model = value(message, "metadata", {});
      const announcement = model.type === "announcement";
      const label = announcement ? "旁白" : sender.name || sender.displayName || (message.senderKind === "system" ? "系统" : "成员");
      const own = message.senderUserId === currentUserId();
      const avatar = announcement || message.senderKind === "system"
        ? ""
        : imAvatarHtml(sender, message.senderKind === "character" ? "character" : "user", "im-message-avatar");
      return `<article class="im-message is-${esc(message.senderKind)}${announcement ? " is-announcement" : ""}${own ? " is-own" : ""}" data-im-message="${esc(message.id)}">
        <header>${avatar}<strong>${esc(label)}</strong><time>${esc(new Date(message.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }))}</time></header>
        <div class="im-message-body message-body">${messageHtml(message)}</div>
        ${message.senderKind === "character" ? `<details class="im-model-details"><summary>调用详情</summary><span>${esc(model.modelDisplayName || model.modelId || "未知模型")} · ${model.modelStage === "fallback" ? "fallback" : "主模型"} · ${Number(model.attemptCount || 1)} 次请求 · ${Number(model.durationMs || 0)} ms</span></details>` : ""}
      </article>`;
    }).join("") + generatingSummary + provisionalHtml;
    bindImAvatarFallbacks(feed);
    feed.scrollTop = follow ? feed.scrollHeight : previousTop;
  }

  async function loadOlderMessages() {
    const conversationId = current?.id;
    const oldestSequence = Math.min(...array(current?.messages).map((message) => Number(message.sequence)).filter(Number.isFinite));
    if (!conversationId || !Number.isFinite(oldestSequence) || !current?.hasMoreMessages) return;
    const button = feed.querySelector("[data-im-load-older]");
    if (button) button.disabled = true;
    const previousHeight = feed.scrollHeight;
    const previousTop = feed.scrollTop;
    try {
      const page = await api(`/api/im/conversations/${encodeURIComponent(conversationId)}?beforeSequence=${encodeURIComponent(oldestSequence)}`);
      if (current?.id !== conversationId) return;
      const messagesById = new Map([
        ...array(page.messages),
        ...array(current.messages)
      ].map((message) => [message.id, message]));
      current.messages = [...messagesById.values()].sort((left, right) => Number(left.sequence) - Number(right.sequence));
      current.hasMoreMessages = page.hasMoreMessages === true;
      renderMessages();
      feed.scrollTop = previousTop + Math.max(0, feed.scrollHeight - previousHeight);
    } catch (error) {
      if (button) button.disabled = false;
      toast(error.message, "error");
    }
  }

  function activeHumans() {
    return array(current?.participants?.humans).filter((item) => !item.leftAt);
  }

  function activeCharacters() {
    return array(current?.participants?.characters).filter((item) => !item.leftAt && item.status === "active");
  }

  function syncComposer() {
    const writable = current?.active === true && current?.status === "active" && activeCharacters().length > 0;
    const canAnnounce = writable && current?.kind === "group" && current?.ownerUserId === currentUserId();
    composer.contentEditable = String(writable);
    composer.setAttribute("aria-disabled", String(!writable));
    document.querySelector("#im-send").disabled = !writable;
    document.querySelector("#im-announcement-button").classList.toggle("hidden", !canAnnounce);
    document.querySelector("#im-announcement-button").disabled = !canAnnounce;
    document.querySelector("#im-stop").classList.toggle("hidden", !["queued", "running"].includes(current?.activeChain?.status));
    document.querySelector("#im-retry").classList.toggle("hidden", !["waiting_config", "failed", "interrupted"].includes(current?.activeChain?.status));
  }

  function renderDetails() {
    const host = document.querySelector("#im-details-content");
    if (!current) {
      host.innerHTML = '<p class="im-empty">选择会话后查看成员与设置。</p>';
      return;
    }
    const owner = current.ownerUserId === currentUserId();
    const canManageMembers = owner && current.kind === "group" && current.active === true;
    const addButton = (kind, label) => canManageMembers
      ? `<button class="im-member-add-button" type="button" data-im-open-member-add="${kind}" aria-label="${label}" title="${label}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg></button>`
      : "";
    const editableHumanMembers = canManageMembers && activeHumans().some((item) => item.userId !== currentUserId());
    const editableCharacterMembers = canManageMembers && activeCharacters().length > 1;
    const editButton = (kind, label, enabled) => enabled
      ? `<button class="im-member-edit-button" type="button" data-im-toggle-member-edit="${kind}" aria-label="${label}" aria-pressed="false" title="${label}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"></path><path d="m16.5 3.5 1.4-1.4a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4L16.5 3.5Z"></path></svg></button>`
      : "";
    const memberActions = (kind, addLabel, editLabel, editable) => `<span class="im-member-section-actions">${editButton(kind, editLabel, editable)}${addButton(kind, addLabel)}</span>`;
    const humanRows = activeHumans().map((item) => `<li><span class="im-member-identity">${imAvatarHtml(item, "user", "im-member-avatar")}<span>${esc(item.displayName)} <small>@${esc(item.username)}</small>${item.role === "owner" ? " · 群主" : ""}</span></span>${canManageMembers && item.userId !== currentUserId() ? `<button class="im-button im-button-danger-quiet" type="button" data-im-remove-human="${esc(item.userId)}" aria-label="移除 ${esc(item.displayName)}" hidden>移除</button>` : ""}</li>`).join("");
    const characterRows = activeCharacters().map((item) => `<li><span class="im-member-identity">${imAvatarHtml(item, "character", "im-member-avatar")}<span>${esc(item.name)} <small>${esc(item.workTitle)}</small></span></span>${editableCharacterMembers ? `<button class="im-button im-button-danger-quiet" type="button" data-im-remove-character="${esc(item.characterId)}" aria-label="移除 ${esc(item.name)}" hidden>移除</button>` : ""}</li>`).join("");
    host.innerHTML = `<section><div class="im-member-section-heading"><h3>AI 角色</h3>${memberActions("character", "添加 AI 角色", "编辑 AI 角色", editableCharacterMembers)}</div><ul class="im-member-list" data-im-member-list="character">${characterRows}</ul></section>
      <section><div class="im-member-section-heading"><h3>人类成员</h3>${memberActions("human", "添加人类成员", "编辑人类成员", editableHumanMembers)}</div><ul class="im-member-list" data-im-member-list="human">${humanRows}</ul></section>
      ${current.kind === "group" && owner ? `<section class="im-owner-settings"><h3>群设置</h3>
        <label>群名称<input id="im-detail-title" maxlength="80" value="${esc(current.title)}"></label>
        <label>回复模式<select id="im-detail-mode"><option value="mention" ${current.replyMode === "mention" ? "selected" : ""}>Mention 模式</option><option value="proactive" ${current.replyMode === "proactive" ? "selected" : ""}>主动交流</option></select></label>
        <label>主动阈值 <output id="im-detail-threshold-output">${Number(current.responseThreshold)}</output><input id="im-detail-threshold" type="range" min="0" max="100" value="${Number(current.responseThreshold)}"></label>
        <label>链路上限<input id="im-detail-limit" type="number" min="1" max="100" value="${Number(current.maxAiMessages)}"></label>
        <button id="im-save-group-settings" class="primary-button" type="button">保存群设置</button>
      </section>` : ""}
      ${owner && current.kind === "group" ? '<section><h3>主动判断诊断</h3><div id="im-diagnostics"><p class="im-empty">尚无诊断记录。</p></div></section>' : ""}
      ${current.kind === "group" && owner ? `<section class="im-owner-actions"><h3>群主操作</h3><label>转让给<select id="im-transfer-select"><option value="">选择成员</option>${activeHumans().filter((item) => item.userId !== currentUserId()).map((item) => `<option value="${esc(item.userId)}">${esc(item.displayName)}</option>`).join("")}</select></label><div class="im-owner-action-buttons"><button id="im-transfer" class="im-button im-button-secondary" type="button">转让群主</button><button id="im-disband" class="danger-button" type="button">解散群聊</button></div></section>` : ""}
      ${current.kind === "group" && !owner && current.active ? '<button id="im-leave" class="danger-button" type="button">退出群聊</button>' : ""}`;
    bindImAvatarFallbacks(host);
    bindDetailActions(owner);
    if (owner && current.kind === "group") void loadDiagnostics();
  }

  async function loadDiagnostics() {
    const conversationId = current?.id;
    const request = ++diagnosticsRequest;
    if (!conversationId) return;
    try {
      const result = await api(`/api/im/conversations/${encodeURIComponent(conversationId)}/diagnostics`);
      if (request !== diagnosticsRequest || current?.id !== conversationId) return;
      const host = document.querySelector("#im-diagnostics");
      if (!host) return;
      host.innerHTML = array(result.turns).filter((turn) => turn.kind === "judge").length
        ? array(result.turns).filter((turn) => turn.kind === "judge").map((turn) => `<div class="im-diagnostic-row"><span>${esc(turn.characterName)}</span><strong>${turn.score ?? "失败"}</strong><small>${turn.selected ? "已发言" : turn.status}</small></div>`).join("")
        : '<p class="im-empty">尚无主动判断记录。</p>';
    } catch (error) {
      if (request !== diagnosticsRequest || current?.id !== conversationId) return;
      toast(error.message, "error");
    }
  }

  function bindDetailActions(owner) {
    const threshold = document.querySelector("#im-detail-threshold");
    threshold?.addEventListener("input", () => { document.querySelector("#im-detail-threshold-output").textContent = threshold.value; });
    document.querySelector("#im-save-group-settings")?.addEventListener("click", async () => {
      await api(`/api/im/conversations/${encodeURIComponent(current.id)}`, { method: "PATCH", body: {
        title: document.querySelector("#im-detail-title").value.trim(),
        replyMode: document.querySelector("#im-detail-mode").value,
        responseThreshold: Number(document.querySelector("#im-detail-threshold").value),
        maxAiMessages: Number(document.querySelector("#im-detail-limit").value)
      } });
      await openConversation(current.id);
    });
    document.querySelectorAll("[data-im-open-member-add]").forEach((button) => button.addEventListener("click", () => openMemberAddDialog(button.dataset.imOpenMemberAdd)));
    document.querySelectorAll("[data-im-toggle-member-edit]").forEach((button) => button.addEventListener("click", () => {
      const editing = button.getAttribute("aria-pressed") !== "true";
      button.setAttribute("aria-pressed", String(editing));
      const list = document.querySelector(`[data-im-member-list="${button.dataset.imToggleMemberEdit}"]`);
      list?.querySelectorAll("[data-im-remove-human], [data-im-remove-character]").forEach((removeButton) => { removeButton.hidden = !editing; });
    }));
    document.querySelectorAll("[data-im-remove-human]").forEach((button) => button.addEventListener("click", async () => {
      await api(`/api/im/conversations/${encodeURIComponent(current.id)}/humans/${encodeURIComponent(button.dataset.imRemoveHuman)}`, { method: "DELETE", body: {} });
      await openConversation(current.id);
    }));
    document.querySelectorAll("[data-im-remove-character]").forEach((button) => button.addEventListener("click", async () => {
      await api(`/api/im/conversations/${encodeURIComponent(current.id)}/characters/${encodeURIComponent(button.dataset.imRemoveCharacter)}`, { method: "DELETE", body: {} });
      await openConversation(current.id);
    }));
    document.querySelector("#im-transfer")?.addEventListener("click", async () => {
      const userId = document.querySelector("#im-transfer-select").value;
      if (!userId) return;
      const nextOwner = activeHumans().find((item) => item.userId === userId);
      const conversationId = current.id;
      const conversationTitle = current.title;
      if (!await confirmToast(
        `确认把群聊“${conversationTitle}”的群主转让给“${nextOwner?.displayName || nextOwner?.username || "所选成员"}”吗？转让后你将失去群主专属操作权限。`,
        { title: "转让群主", confirmLabel: "确认转让" }
      )) return;
      await api(`/api/im/conversations/${encodeURIComponent(conversationId)}/transfer`, { method: "POST", body: { userId } });
      if (current?.id === conversationId) await openConversation(conversationId);
      else await refreshConversations();
      toast("群主已转让", "success");
    });
    document.querySelector("#im-disband")?.addEventListener("click", async () => {
      const conversationId = current.id;
      const conversationTitle = current.title;
      if (!await confirmToast(
        `确认解散群聊“${conversationTitle}”吗？解散后所有成员只能查看各自可见的历史，群聊不能恢复。`,
        { title: "解散群聊", confirmLabel: "确认解散" }
      )) return;
      await api(`/api/im/conversations/${encodeURIComponent(conversationId)}/disband`, { method: "POST", body: {} });
      if (current?.id === conversationId) await openConversation(conversationId);
      else await refreshConversations();
      toast("群聊已解散", "success");
    });
    document.querySelector("#im-leave")?.addEventListener("click", async () => {
      await api(`/api/im/conversations/${encodeURIComponent(current.id)}/leave`, { method: "POST", body: {} });
      await openConversation(current.id);
    });
    if (!owner) return;
  }

  function renderConversation(scrollToBottom = false) {
    document.querySelector("#im-chat-title").textContent = current?.title || "选择会话";
    document.querySelector("#im-chat-subtitle").textContent = current ? conversationSubtitle(current) : "角色单聊或混合群聊";
    document.querySelector("#im-details-toggle").disabled = !current;
    renderMessages({ scrollToBottom });
    renderDetails();
    syncComposer();
  }

  async function openConversation(conversationId, userInitiated = false) {
    if (userInitiated) requestedConversationId = conversationId;
    else if (requestedConversationId && requestedConversationId !== conversationId) return;
    const request = ++conversationRequest;
    let nextConversation;
    try {
      nextConversation = await api(`/api/im/conversations/${encodeURIComponent(conversationId)}`);
    } catch (error) {
      if (userInitiated && requestedConversationId === conversationId) requestedConversationId = null;
      throw error;
    }
    if (request !== conversationRequest || (requestedConversationId && requestedConversationId !== conversationId)) return;
    const previousConversation = current?.id === conversationId ? current : null;
    const conversationChanged = !previousConversation;
    if (previousConversation) {
      const gapMessages = await collectImMessageGap(previousConversation.messages, nextConversation.messages, async (cursor) => {
        const page = await api(`/api/im/conversations/${encodeURIComponent(conversationId)}?afterSequence=${encodeURIComponent(cursor)}`);
        if (request !== conversationRequest || (requestedConversationId && requestedConversationId !== conversationId)) {
          throw new Error("IM 会话请求已失效");
        }
        return page;
      });
      if (request !== conversationRequest || (requestedConversationId && requestedConversationId !== conversationId)) return;
      nextConversation.messages = mergeImMessagePages(previousConversation.messages, gapMessages, nextConversation.messages);
      nextConversation.hasMoreMessages = previousConversation.hasMoreMessages === true;
    }
    current = nextConversation;
    if (requestedConversationId === conversationId) requestedConversationId = null;
    workspace.classList.add("has-conversation");
    syncProvisionalReplies();
    renderConversationList();
    renderConversation(conversationChanged);
    if (current.active && current.latestSequence > 0 && shouldMarkImConversationRead(opened, document.visibilityState)) {
      if (request !== conversationRequest) return;
      const summary = await api(`/api/im/conversations/${encodeURIComponent(conversationId)}/read`, { method: "POST", body: { sequence: current.latestSequence } });
      if (request !== conversationRequest) return;
      upsertConversationSummary(summary);
    }
  }

  async function loadCatalogs() {
    [works, users, models, settings] = await Promise.all([
      api("/api/im/works"),
      api("/api/users/directory?q="),
      api("/api/im/models"),
      api("/api/im/settings")
    ]);
  }

  function openSettings() {
    const dialog = document.querySelector("#im-settings-dialog");
    document.querySelector("#im-setting-name").value = settings.preferredName || state.user?.displayName || "";
    document.querySelector("#im-setting-pronouns").value = settings.pronouns || "";
    document.querySelector("#im-setting-identity").value = settings.identitySummary || "";
    document.querySelector("#im-setting-notes").value = settings.additionalNotes || "";
    const modelOptions = (selectedId, placeholder) => {
      const unavailable = selectedId && !models.some((model) => model.id === selectedId)
        ? `<option value="${esc(selectedId)}" selected>当前模型暂不可用 · ${esc(selectedId)}</option>`
        : "";
      return `<option value="">${placeholder}</option>${unavailable}${models.map((model) => `<option value="${esc(model.id)}" ${selectedId === model.id ? "selected" : ""}>${esc(model.displayName)} · ${esc(model.providerName)}</option>`).join("")}`;
    };
    document.querySelector("#im-setting-primary").innerHTML = modelOptions(settings.primaryModelId, "选择主模型");
    document.querySelector("#im-setting-fallback").innerHTML = modelOptions(settings.fallbackModelId, "选择 fallback 模型");
    document.querySelector("#im-setting-retries").value = String(settings.retryCount || 3);
    dialog.showModal();
  }

  function openAnnouncementDialog() {
    if (current?.kind !== "group" || current?.ownerUserId !== currentUserId() || current?.active !== true) return;
    const dialog = document.querySelector("#im-announcement-dialog");
    document.querySelector("#im-announcement-form").reset();
    dialog.showModal();
    document.querySelector("#im-announcement-content").focus();
  }

  function characterPreferenceBadges(item) {
    return [
      item.isPinned ? '<b class="im-character-preference is-pinned">置顶</b>' : "",
      item.isFavorite ? '<b class="im-character-preference is-favorite">已收藏</b>' : ""
    ].filter(Boolean).join("");
  }

  function renderMemberAddOptions() {
    const host = document.querySelector("#im-member-add-options");
    const emptyText = memberAddKind === "character" ? "没有可添加的角色。" : "没有匹配的可添加用户。";
    host.setAttribute("aria-label", memberAddKind === "character" ? "可添加 AI 角色" : "可添加人类成员");
    host.innerHTML = memberAddCandidates.length
      ? memberAddCandidates.map((item) => {
          const candidateId = memberAddKind === "character" ? item.id : item.userId;
          const selected = candidateId === memberAddSelectedId;
          const detail = memberAddKind === "character"
            ? `${characterPreferenceBadges(item)}${item.code ? `<em>${esc(item.code)}</em>` : ""}<span>${esc(item.workTitle)}</span>`
            : `<span>@${esc(item.username)}</span>`;
          return `<button class="im-member-picker-option" type="button" role="option" aria-selected="${selected}" data-im-member-add-candidate="${esc(candidateId)}">${imAvatarHtml(item, memberAddKind === "character" ? "character" : "user", "im-member-picker-avatar")}<span><strong>${esc(memberAddKind === "character" ? item.name : item.displayName)}</strong><small>${detail}</small></span></button>`;
        }).join("")
      : `<p class="im-empty">${emptyText}</p>`;
    bindImAvatarFallbacks(host);
    const submit = document.querySelector("#im-member-add-submit");
    submit.disabled = !memberAddSelectedId;
    submit.textContent = memberAddKind === "character" ? "添加角色" : "添加用户";
  }

  async function loadMemberAddCharacters() {
    const workId = document.querySelector("#im-member-add-work").value;
    const search = document.querySelector("#im-member-add-character-search");
    const requestGeneration = ++memberAddRequest;
    if (!workId) {
      memberAddCandidates = [];
      memberAddSelectedId = "";
      search.disabled = true;
      document.querySelector("#im-member-add-options").innerHTML = '<p class="im-empty">选择书籍后显示可添加角色。</p>';
      document.querySelector("#im-member-add-submit").disabled = true;
      return;
    }
    search.disabled = false;
    const query = search.value.trim();
    const activeCharacterIds = new Set(activeCharacters().map((item) => item.characterId));
    const candidates = array(await api(`/api/im/characters?workId=${encodeURIComponent(workId)}&q=${encodeURIComponent(query)}`))
      .filter((item) => !activeCharacterIds.has(item.id));
    if (requestGeneration !== memberAddRequest) return;
    memberAddCandidates = candidates;
    if (!candidates.some((item) => item.id === memberAddSelectedId)) memberAddSelectedId = "";
    renderMemberAddOptions();
  }

  async function loadMemberAddHumans() {
    const requestGeneration = ++memberAddRequest;
    const query = document.querySelector("#im-member-add-human-search").value.trim();
    const activeHumanIds = new Set(activeHumans().map((item) => item.userId));
    const candidates = array(await api(`/api/users/directory?q=${encodeURIComponent(query)}`))
      .filter((item) => item.userId !== currentUserId() && !activeHumanIds.has(item.userId));
    if (requestGeneration !== memberAddRequest) return;
    memberAddCandidates = candidates;
    if (!candidates.some((item) => item.userId === memberAddSelectedId)) memberAddSelectedId = "";
    renderMemberAddOptions();
  }

  function openMemberAddDialog(kind) {
    if (!current?.active || current.kind !== "group" || current.ownerUserId !== currentUserId()) return;
    memberAddKind = kind === "human" ? "human" : "character";
    memberAddCandidates = [];
    memberAddSelectedId = "";
    memberAddRequest += 1;
    if (memberAddSearchTimer !== null) window.clearTimeout(memberAddSearchTimer);
    memberAddSearchTimer = null;
    const dialog = document.querySelector("#im-member-add-dialog");
    document.querySelector("#im-member-add-form").reset();
    const characterMode = memberAddKind === "character";
    document.querySelector("#im-member-add-eyebrow").textContent = characterMode ? "AI 角色" : "人类成员";
    document.querySelector("#im-member-add-title").textContent = characterMode ? "添加 AI 角色" : "添加人类成员";
    document.querySelector("#im-member-add-guidance").textContent = characterMode
      ? "先选择书籍，再按名字搜索一个要加入群聊的角色。置顶和收藏角色优先显示。"
      : "按用户名或显示名称搜索一个要加入群聊的人类用户。";
    document.querySelector("#im-member-add-character-fields").classList.toggle("hidden", !characterMode);
    document.querySelector("#im-member-add-human-fields").classList.toggle("hidden", characterMode);
    document.querySelector("#im-member-add-submit").textContent = characterMode ? "添加角色" : "添加用户";
    document.querySelector("#im-member-add-submit").disabled = true;
    if (characterMode) {
      const workSelect = document.querySelector("#im-member-add-work");
      workSelect.innerHTML = '<option value="">请选择书籍</option>' + works.map((work) => `<option value="${esc(work.id)}">${esc(work.title)} · ${Number(work.characterCount)} 个角色</option>`).join("");
      document.querySelector("#im-member-add-character-search").disabled = true;
      document.querySelector("#im-member-add-options").innerHTML = '<p class="im-empty">选择书籍后显示可添加角色。</p>';
    } else {
      document.querySelector("#im-member-add-options").innerHTML = '<p class="im-empty">正在读取可添加用户…</p>';
    }
    dialog.showModal();
    if (characterMode) document.querySelector("#im-member-add-work").focus();
    else {
      document.querySelector("#im-member-add-human-search").focus();
      void loadMemberAddHumans().catch((error) => toast(error.message, "error"));
    }
  }

  function renderCreateCharacterOptions() {
    const host = document.querySelector("#im-group-character-options");
    host.innerHTML = createCharacters.length
      ? createCharacters.map((item) => `<label class="im-character-option"><input type="checkbox" value="${esc(item.id)}" ${createSelectedCharacters.has(item.id) ? "checked" : ""}>${imAvatarHtml(item, "character", "im-option-avatar")}<span><strong>${esc(item.name)}</strong><small>${characterPreferenceBadges(item)}${item.code ? `<em>${esc(item.code)}</em>` : ""}</small></span></label>`).join("")
      : '<p class="im-empty">没有匹配的角色。</p>';
    bindImAvatarFallbacks(host);
  }

  function renderCreateSelectedCharacters() {
    const host = document.querySelector("#im-create-selected");
    const selected = [...createSelectedCharacters.values()];
    host.classList.toggle("hidden", selected.length === 0);
    host.innerHTML = selected.length
      ? `<div><strong>已选角色</strong><small>${selected.length} / 10</small></div><div>${selected.map((item) => `<button type="button" data-im-remove-selected="${esc(item.id)}" aria-label="移除角色 ${esc(item.name)}（${esc(item.workTitle)}）">${imAvatarHtml(item, "character", "im-selected-avatar")}<span>${esc(item.name)}</span><small>${esc(item.workTitle)}</small><b aria-hidden="true">×</b></button>`).join("")}</div>`
      : "";
    bindImAvatarFallbacks(host);
  }

  function syncCreateSelection() {
    const selected = [...createSelectedCharacters.values()];
    const count = selected.length;
    const hasWork = Boolean(document.querySelector("#im-create-work").value);
    const groupMode = count >= 2;
    const groupSection = document.querySelector("#im-create-group-settings");
    const humanSection = document.querySelector("#im-create-human-section");
    const title = document.querySelector("#im-create-group-title");
    const submit = document.querySelector("#im-create-submit");
    groupSection.classList.toggle("hidden", !groupMode);
    humanSection.classList.toggle("hidden", !groupMode);
    groupSection.querySelectorAll("input, select").forEach((control) => { control.disabled = !groupMode; });
    humanSection.querySelectorAll("input").forEach((control) => { control.disabled = !groupMode; });
    renderCreateSelectedCharacters();
    title.required = groupMode;
    if (groupMode && !title.value.trim()) title.value = selected.slice(0, 3).map((item) => item.name).join("、").slice(0, 80);
    submit.disabled = count === 0 || !hasWork;
    submit.textContent = !hasWork ? "请先选择书籍" : count === 0 ? "请选择角色" : count === 1 ? "创建单聊" : `创建群聊（${count} 个角色）`;
    document.querySelector("#im-create-guidance").textContent = !hasWork
      ? "请先选择一本书，再选择要开始会话的角色。"
      : count === 0
        ? "请选择角色。置顶和收藏的角色会优先显示。"
        : count === 1
          ? `将创建与“${selected[0].name}”的单聊。`
          : `将创建包含 ${count} 个角色的群聊，可继续添加人类成员。`;
  }

  async function loadCreateCharacters() {
    const workId = document.querySelector("#im-create-work").value;
    const search = document.querySelector("#im-create-search");
    const requestId = ++createSearchRequest;
    if (!workId) {
      createCharacters = [];
      search.disabled = true;
      document.querySelector("#im-group-character-options").innerHTML = '<p class="im-empty">选择书籍后显示角色。</p>';
      return;
    }
    search.disabled = false;
    const query = search.value.trim();
    const nextCharacters = array(await api(`/api/im/characters?workId=${encodeURIComponent(workId)}&q=${encodeURIComponent(query)}`));
    if (requestId !== createSearchRequest) return;
    createCharacters = nextCharacters;
    renderCreateCharacterOptions();
  }

  function openConversationDialog() {
    const dialog = document.querySelector("#im-group-dialog");
    document.querySelector("#im-group-form").reset();
    if (createSearchTimer !== null) window.clearTimeout(createSearchTimer);
    createSearchTimer = null;
    createSearchRequest += 1;
    createSelectedCharacters.clear();
    createCharacters = [];
    const workSelect = document.querySelector("#im-create-work");
    workSelect.innerHTML = '<option value="">请选择书籍</option>' + works.map((work) => `<option value="${esc(work.id)}">${esc(work.title)} · ${Number(work.characterCount)} 个角色</option>`).join("");
    const search = document.querySelector("#im-create-search");
    search.value = "";
    search.disabled = true;
    document.querySelector("#im-group-character-options").innerHTML = '<p class="im-empty">选择书籍后显示角色。</p>';
    document.querySelector("#im-group-human-options").innerHTML = users.filter((item) => item.userId !== currentUserId()).map((item) => `<label><input type="checkbox" name="humanUserId" value="${esc(item.userId)}"><span><strong>${esc(item.displayName)}</strong><small>@${esc(item.username)}</small></span></label>`).join("") || '<p class="im-empty">没有可添加的其他用户。</p>';
    syncCreateSelection();
    dialog.showModal();
  }

  function composerCaret() {
    const selection = document.getSelection();
    let anchor = selection?.anchorNode ?? null;
    let offset = selection?.anchorOffset ?? 0;
    if (anchor === composer) {
      anchor = composer.childNodes[Math.max(0, offset - 1)] ?? composer.lastChild;
      offset = anchor?.nodeType === Node.TEXT_NODE ? anchor.nodeValue?.length ?? 0 : 0;
    }
    if ((!anchor || anchor.nodeType !== Node.TEXT_NODE || !composer.contains(anchor)) && document.activeElement === composer) {
      const walker = document.createTreeWalker(composer, NodeFilter.SHOW_TEXT);
      let candidate = walker.nextNode();
      while (candidate) {
        anchor = candidate;
        candidate = walker.nextNode();
      }
      offset = anchor?.nodeType === Node.TEXT_NODE ? anchor.nodeValue?.length ?? 0 : 0;
    }
    return anchor?.nodeType === Node.TEXT_NODE && composer.contains(anchor) ? { selection, anchor, offset } : null;
  }

  function updateMentionMenu() {
    const caret = composerCaret();
    const match = caret ? findImMentionQuery(caret.anchor.nodeValue ?? "", caret.offset) : null;
    if (!caret || !match) {
      closeMentionMenu();
      return;
    }
    const query = match.query.toLocaleLowerCase("zh-CN");
    mentionCaretState = {
      anchor: caret.anchor,
      startOffset: match.startOffset,
      endOffset: match.endOffset
    };
    mentionOptions = [
      ...activeCharacters().map((item) => ({ ...item, kind: "character", id: item.characterId, label: item.name, detail: item.workTitle })),
      ...activeHumans().map((item) => ({ ...item, kind: "user", id: item.userId, label: item.displayName, detail: `@${item.username}` }))
    ].filter((item) => item.label.toLocaleLowerCase("zh-CN").includes(query)).slice(0, 12);
    mentionIndex = mentionOptions.length ? 0 : -1;
    mentionMenu.innerHTML = mentionOptions.length
      ? mentionOptions.map((item, index) => `<button type="button" role="option" aria-selected="${index === mentionIndex}" data-im-mention-index="${index}">${imAvatarHtml(item, item.kind, "im-mention-avatar")}<span><strong>${esc(item.label)}</strong><em>${item.kind === "character" ? "角色" : "用户"} · ${esc(item.detail)}</em></span></button>`).join("")
      : '<p class="im-empty">没有匹配的群成员</p>';
    bindImAvatarFallbacks(mentionMenu);
    mentionMenu.classList.remove("hidden");
    composer.setAttribute("aria-expanded", "true");
  }

  function closeMentionMenu() {
    mentionMenu.classList.add("hidden");
    composer.setAttribute("aria-expanded", "false");
    mentionOptions = [];
    mentionIndex = -1;
  }

  function selectMention(index) {
    const item = mentionOptions[index];
    const caret = mentionCaretState;
    if (!item || !caret || caret.anchor.nodeType !== Node.TEXT_NODE || !composer.contains(caret.anchor)) return;
    const text = caret.anchor.nodeValue ?? "";
    if (caret.startOffset < 0 || caret.endOffset > text.length || !findImMentionQuery(text, caret.endOffset)) return;
    const chip = document.createElement("span");
    chip.className = "im-composer-mention";
    chip.contentEditable = "false";
    chip.dataset.imMentionUri = `mention://${item.kind}/${item.id}`;
    chip.textContent = `@${item.label}`;
    const tail = document.createTextNode(" ");
    const range = document.createRange();
    range.setStart(caret.anchor, caret.startOffset);
    range.setEnd(caret.anchor, caret.endOffset);
    range.deleteContents();
    range.insertNode(chip);
    chip.after(tail);
    range.setStart(tail, 1);
    range.collapse(true);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    mentionCaretState = null;
    closeMentionMenu();
    composer.focus();
  }

  async function send() {
    if (!current?.active) return;
    const conversationId = current.id;
    const content = serializeImComposer(composer);
    if (!content) return;
    composer.replaceChildren();
    closeMentionMenu();
    provisionalReplies.clear();
    try {
      const result = await api(`/api/im/conversations/${encodeURIComponent(conversationId)}/messages`, {
        method: "POST",
        body: { content, requestId: requestId() }
      });
      if (current?.id !== conversationId) {
        await refreshConversationSummary(conversationId);
        return;
      }
      const existing = array(current.messages).some((message) => message.id === result.message.id);
      if (!existing) current.messages.push(result.message);
      current.activeChain = result.chain;
      renderConversation(true);
      await openConversation(current.id);
      await refreshConversationSummary(conversationId);
      if (result.chain?.status === "waiting_config") toast("消息已发送；请配置主模型和 fallback 后重试 AI 链路", "warning");
    } catch (error) {
      if (current?.id === conversationId) composer.textContent = content;
      toast(error.message, "error");
    }
  }

  async function handleRealtime(event) {
    const envelope = JSON.parse(event.data);
    const eventConversationId = envelope.conversationId;
    if (!opened) {
      if (shouldRefreshImConversationListForEvent(envelope.type)) await refreshConversationSummary(eventConversationId);
      return;
    }
    if (envelope.type === "turn" && current?.id === eventConversationId && envelope.payload.kind === "reply") {
      const status = String(envelope.payload.status || "");
      const turnId = String(envelope.payload.turnId || "");
      if (status === "completed" || status === "cancelled") {
        provisionalReplies.delete(turnId);
        feed.querySelector(`[data-im-provisional-turn="${turnId}"]`)?.remove();
        syncGeneratingSummary();
      } else {
        const provisional = upsertProvisionalReply(envelope.payload);
        if (provisional) updateProvisionalReplyElement(provisional);
      }
      return;
    }
    if (envelope.type === "delta" && current?.id === eventConversationId) {
      const provisional = upsertProvisionalReply({ ...envelope.payload, status: "running" });
      if (provisional) provisional.content += envelope.payload.delta || "";
      if (provisional) updateProvisionalReplyElement(provisional);
      return;
    }
    if (envelope.type === "reset" && current?.id === eventConversationId) {
      for (const reply of provisionalReplies.values()) {
        if (reply.chainId !== String(envelope.payload.chainId || "")) continue;
        if (envelope.payload.turnId && reply.turnId !== envelope.payload.turnId) continue;
        if (envelope.payload.characterId && reply.characterId !== envelope.payload.characterId) continue;
        reply.content = "";
        reply.status = "running";
        updateProvisionalReplyElement(reply);
      }
      return;
    }
    if (current?.id === eventConversationId) await openConversation(eventConversationId);
    else if (shouldRefreshImConversationListForEvent(envelope.type)) await refreshConversationSummary(eventConversationId);
  }

  function connectEvents() {
    eventSource?.close();
    eventSource = new EventSource("/api/im/events");
    eventSource.addEventListener("ready", () => {
      void Promise.all([
        refreshConversations(),
        opened && current ? openConversation(current.id) : Promise.resolve()
      ]).catch(() => undefined);
    });
    for (const type of ["conversation", "message", "chain", "turn", "delta", "reset"]) {
      eventSource.addEventListener(type, (event) => void handleRealtime(event).catch(() => undefined));
    }
  }

  async function open() {
    opened = true;
    hideMainViews();
    document.querySelector("#app").classList.add("shelf-mode", "im-mode");
    workspace.classList.remove("hidden");
    document.querySelector("#work-meta").textContent = "IM";
    document.querySelector("#top-search-button").disabled = true;
    document.title = "IM · 叙界";
    window.history.replaceState(null, "", "#view=im");
    await Promise.all([loadCatalogs(), refreshConversations()]);
    if (current) await openConversation(current.id);
    else renderConversation();
  }

  function close() {
    opened = false;
    conversationRequest += 1;
    requestedConversationId = null;
    workspace.classList.add("hidden");
    workspace.classList.remove("has-conversation");
    document.querySelector("#app").classList.remove("im-mode");
    provisionalReplies.clear();
    closeMentionMenu();
  }

  function bind() {
    setupConversationsResize();
    setupComposerResize();
    document.querySelector("#im-open-button").addEventListener("click", () => void open().catch((error) => toast(error.message, "error")));
    document.querySelector("#im-settings-button").addEventListener("click", openSettings);
    document.querySelector("#im-announcement-button").addEventListener("click", openAnnouncementDialog);
    document.querySelector("#im-new-conversation").addEventListener("click", openConversationDialog);
    document.querySelector("#im-create-work").addEventListener("change", () => {
      createCharacters = [];
      document.querySelector("#im-create-search").value = "";
      document.querySelector("#im-group-character-options").innerHTML = document.querySelector("#im-create-work").value
        ? '<p class="im-empty">正在载入角色…</p>'
        : '<p class="im-empty">选择书籍后显示角色。</p>';
      syncCreateSelection();
      void loadCreateCharacters().catch((error) => toast(error.message, "error"));
    });
    document.addEventListener("visibilitychange", () => {
      if (!current || !shouldMarkImConversationRead(opened, document.visibilityState) || !current.active || current.latestSequence <= 0) return;
      void api(`/api/im/conversations/${encodeURIComponent(current.id)}/read`, { method: "POST", body: { sequence: current.latestSequence } })
        .then(upsertConversationSummary)
        .catch(() => undefined);
    });
    document.querySelector("#im-create-search").addEventListener("input", () => {
      if (createSearchTimer !== null) window.clearTimeout(createSearchTimer);
      createSearchTimer = window.setTimeout(() => {
        createSearchTimer = null;
        void loadCreateCharacters().catch((error) => toast(error.message, "error"));
      }, 160);
    });
    document.querySelector("#im-group-character-options").addEventListener("change", (event) => {
      const checkbox = event.target.closest('input[type="checkbox"]');
      if (!checkbox) return;
      const item = createCharacters.find((character) => character.id === checkbox.value);
      if (!item) return;
      if (checkbox.checked && createSelectedCharacters.size >= 10) {
        checkbox.checked = false;
        toast("一个群聊最多选择 10 个 AI 角色", "warning");
        return;
      }
      if (checkbox.checked) createSelectedCharacters.set(item.id, item);
      else createSelectedCharacters.delete(item.id);
      syncCreateSelection();
    });
    document.querySelector("#im-create-selected").addEventListener("click", (event) => {
      const button = event.target.closest("[data-im-remove-selected]");
      if (!button) return;
      createSelectedCharacters.delete(button.dataset.imRemoveSelected);
      renderCreateCharacterOptions();
      syncCreateSelection();
    });
    document.querySelector("#im-member-add-work").addEventListener("change", () => {
      memberAddCandidates = [];
      memberAddSelectedId = "";
      document.querySelector("#im-member-add-character-search").value = "";
      document.querySelector("#im-member-add-options").innerHTML = document.querySelector("#im-member-add-work").value
        ? '<p class="im-empty">正在读取可添加角色…</p>'
        : '<p class="im-empty">选择书籍后显示可添加角色。</p>';
      document.querySelector("#im-member-add-submit").disabled = true;
      void loadMemberAddCharacters().catch((error) => toast(error.message, "error"));
    });
    document.querySelector("#im-member-add-character-search").addEventListener("input", () => {
      if (memberAddSearchTimer !== null) window.clearTimeout(memberAddSearchTimer);
      memberAddSearchTimer = window.setTimeout(() => {
        memberAddSearchTimer = null;
        void loadMemberAddCharacters().catch((error) => toast(error.message, "error"));
      }, 160);
    });
    document.querySelector("#im-member-add-human-search").addEventListener("input", () => {
      if (memberAddSearchTimer !== null) window.clearTimeout(memberAddSearchTimer);
      memberAddSearchTimer = window.setTimeout(() => {
        memberAddSearchTimer = null;
        void loadMemberAddHumans().catch((error) => toast(error.message, "error"));
      }, 160);
    });
    document.querySelector("#im-member-add-options").addEventListener("click", (event) => {
      const button = event.target.closest("[data-im-member-add-candidate]");
      if (!button) return;
      memberAddSelectedId = button.dataset.imMemberAddCandidate;
      renderMemberAddOptions();
    });
    listHost.addEventListener("click", (event) => {
      const button = event.target.closest("[data-im-conversation]");
      if (button) void openConversation(button.dataset.imConversation, true).catch((error) => toast(error.message, "error"));
    });
    feed.addEventListener("click", (event) => {
      if (event.target.closest("[data-im-load-older]")) void loadOlderMessages();
    });
    document.querySelector("#im-send").addEventListener("click", () => void send());
    document.querySelector("#im-stop").addEventListener("click", async () => {
      await api(`/api/im/conversations/${encodeURIComponent(current.id)}/stop`, { method: "POST", body: {} });
      provisionalReplies.clear();
      await openConversation(current.id);
    });
    document.querySelector("#im-retry").addEventListener("click", async (event) => {
      if (!current?.activeChain?.id) return;
      const button = event.currentTarget;
      if (button.disabled) return;
      button.disabled = true;
      try {
        await api(`/api/im/conversations/${encodeURIComponent(current.id)}/chains/${encodeURIComponent(current.activeChain.id)}/retry`, { method: "POST", body: {} });
        await openConversation(current.id);
      } finally {
        button.disabled = false;
      }
    });
    document.querySelector("#im-details-toggle").addEventListener("click", () => document.querySelector("#im-details").classList.toggle("is-open"));
    document.querySelector("#im-details-close").addEventListener("click", () => document.querySelector("#im-details").classList.remove("is-open"));
    document.querySelector("#im-mobile-back").addEventListener("click", () => {
      conversationRequest += 1;
      requestedConversationId = null;
      current = null;
      workspace.classList.remove("has-conversation");
      provisionalReplies.clear();
      renderConversationList();
      renderConversation();
    });
    composer.addEventListener("input", updateMentionMenu);
    composer.addEventListener("paste", (event) => {
      event.preventDefault();
      document.execCommand("insertText", false, event.clipboardData?.getData("text/plain") ?? "");
    });
    composer.addEventListener("keydown", (event) => {
      if (!mentionMenu.classList.contains("hidden")) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          mentionIndex = (mentionIndex + (event.key === "ArrowDown" ? 1 : -1) + mentionOptions.length) % mentionOptions.length;
          mentionMenu.querySelectorAll("[role=option]").forEach((item, index) => item.setAttribute("aria-selected", String(index === mentionIndex)));
          return;
        }
        if (event.key === "Enter" && mentionIndex >= 0) {
          event.preventDefault();
          selectMention(mentionIndex);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          closeMentionMenu();
          return;
        }
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void send();
      }
    });
    mentionMenu.addEventListener("pointerdown", (event) => event.preventDefault());
    mentionMenu.addEventListener("click", (event) => {
      const button = event.target.closest("[data-im-mention-index]");
      if (button) selectMention(Number(button.dataset.imMentionIndex));
    });
    document.querySelector("#im-settings-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      settings = await api("/api/im/settings", { method: "PATCH", body: {
        preferredName: String(form.get("preferredName") || "").trim(),
        pronouns: String(form.get("pronouns") || "").trim(),
        identitySummary: String(form.get("identitySummary") || "").trim(),
        additionalNotes: String(form.get("additionalNotes") || "").trim(),
        primaryModelId: String(form.get("primaryModelId") || "") || null,
        fallbackModelId: String(form.get("fallbackModelId") || "") || null,
        retryCount: Number(form.get("retryCount"))
      } });
      document.querySelector("#im-settings-dialog").close();
      toast("IM 身份与模型设置已保存", "success");
      if (current?.activeChain?.status === "waiting_config") await openConversation(current.id);
    });
    document.querySelector("#im-announcement-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const submit = form.querySelector('button[type="submit"]');
      const content = document.querySelector("#im-announcement-content").value.trim();
      if (!content || !current?.id || submit.disabled) return;
      const conversationId = current.id;
      submit.disabled = true;
      try {
        await api(`/api/im/conversations/${encodeURIComponent(conversationId)}/announcements`, {
          method: "POST",
          body: { content, requestId: requestId() }
        });
        document.querySelector("#im-announcement-dialog").close();
        if (current?.id === conversationId) await openConversation(conversationId);
        toast("旁白公告已发布", "success");
      } catch (error) {
        toast(error.message, "error");
      } finally {
        submit.disabled = false;
      }
    });
    document.querySelector("#im-member-add-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!memberAddSelectedId || !current?.id) return;
      const submit = document.querySelector("#im-member-add-submit");
      if (submit.disabled) return;
      const conversationId = current.id;
      const selectedId = memberAddSelectedId;
      submit.disabled = true;
      try {
        const path = memberAddKind === "character" ? "characters" : "humans";
        const body = memberAddKind === "character" ? { characterId: selectedId } : { userId: selectedId };
        await api(`/api/im/conversations/${encodeURIComponent(conversationId)}/${path}`, { method: "POST", body });
        document.querySelector("#im-member-add-dialog").close();
        if (current?.id === conversationId) await openConversation(conversationId);
        toast(memberAddKind === "character" ? "角色已加入群聊" : "用户已加入群聊", "success");
      } catch (error) {
        toast(error.message, "error");
      } finally {
        submit.disabled = false;
      }
    });
    document.querySelector("#im-group-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const characterIds = [...createSelectedCharacters.keys()];
      if (!characterIds.length) return;
      const conversation = characterIds.length === 1
        ? await api("/api/im/conversations/direct", { method: "POST", body: { characterId: characterIds[0] } })
        : await api("/api/im/conversations/group", { method: "POST", body: {
            title: String(form.get("title") || "").trim(),
            characterIds,
            humanUserIds: form.getAll("humanUserId").map(String),
            replyMode: String(form.get("replyMode") || "mention"),
            responseThreshold: Number(form.get("responseThreshold") || 60),
            maxAiMessages: Number(form.get("maxAiMessages") || 20)
          } });
      document.querySelector("#im-group-dialog").close();
      await refreshConversations();
      await openConversation(conversation.id);
    });
    document.querySelectorAll("[data-im-dialog-close]").forEach((button) => button.addEventListener("click", () => button.closest("dialog")?.close()));
  }

  async function start() {
    bind();
    await refreshConversations();
    connectEvents();
  }

  return { start, open, close, refreshUnread: refreshConversations, get opened() { return opened; } };
}
