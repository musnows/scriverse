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

export function createImWorkspace({ api, esc, renderMarkdown, toast, state, showShelf }) {
  const workspace = document.querySelector("#im-view");
  const listHost = document.querySelector("#im-conversation-list");
  const feed = document.querySelector("#im-message-feed");
  const composer = document.querySelector("#im-composer");
  const mentionMenu = document.querySelector("#im-mention-menu");
  const unreadBadge = document.querySelector("#im-unread-count");
  let conversations = [];
  let current = null;
  let characters = [];
  let users = [];
  let models = [];
  let settings = null;
  let eventSource = null;
  let provisional = null;
  let mentionOptions = [];
  let mentionIndex = -1;
  let mentionCaretState = null;
  let opened = false;

  const hideMainViews = () => {
    [
      "shelf-view", "platform-ai-view", "platform-usage-view", "work-audit-view", "settings-hub-view",
      "welcome-view", "editor-view", "module-view", "members-view", "admin-ai-conversations-view"
    ].forEach((id) => document.querySelector(`#${id}`)?.classList.add("hidden"));
  };

  const currentUserId = () => state.user?.userId ?? "";

  function renderUnread() {
    const count = conversations.reduce((total, item) => total + Number(item.unreadCount || 0), 0);
    unreadBadge.textContent = count > 99 ? "99+" : String(count);
    unreadBadge.classList.toggle("hidden", count === 0);
    document.querySelector("#im-open-button")?.setAttribute("aria-label", count ? `打开 IM，${count} 条未读` : "打开 IM");
  }

  async function refreshConversations() {
    conversations = array(await api("/api/im/conversations"));
    renderUnread();
    renderConversationList();
  }

  function conversationSubtitle(item) {
    if (item.status === "disbanded") return "已解散 · 历史只读";
    if (item.active === false) return "已退出 · 历史只读";
    if (item.kind === "direct") return "角色单聊";
    return item.replyMode === "proactive" ? `主动交流 · 阈值 ${item.responseThreshold}` : "Mention 模式";
  }

  function renderConversationList() {
    listHost.innerHTML = conversations.length
      ? conversations.map((item) => `<button class="im-conversation-item${current?.id === item.id ? " is-active" : ""}" type="button" data-im-conversation="${esc(item.id)}">
          <span class="im-conversation-avatar" aria-hidden="true">${item.kind === "group" ? "群" : "角"}</span>
          <span><strong>${esc(item.title)}</strong><small>${esc(conversationSubtitle(item))}</small></span>
          ${item.mentionUnreadCount ? `<b class="im-mention-unread">@${Number(item.mentionUnreadCount)}</b>` : item.unreadCount ? `<b class="im-item-unread">${Number(item.unreadCount)}</b>` : ""}
        </button>`).join("")
      : '<p class="im-empty">还没有 IM 会话。选择一个角色单聊，或创建包含 AI 角色的群聊。</p>';
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
    let index = 0;
    source = source.replace(mentionPattern, (raw) => {
      const mention = array(message.mentions)[index];
      if (!mention) return raw;
      const token = `IMMENTION${String(message.id).replace(/[^A-Za-z0-9]/gu, "")}TOKEN${index}END`;
      tokens.push({ token, mention });
      index += 1;
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

  function renderMessages() {
    const messages = array(current?.messages);
    if (!messages.length && !provisional) {
      feed.innerHTML = '<p class="im-feed-empty">从一条消息开始。角色单聊会直接回复；群聊按当前回复模式调度 AI。</p>';
      return;
    }
    feed.innerHTML = messages.map((message) => {
      const sender = value(message, "sender", {});
      const label = sender.name || sender.displayName || (message.senderKind === "system" ? "系统" : "成员");
      const own = message.senderUserId === currentUserId();
      const model = value(message, "metadata", {});
      return `<article class="im-message is-${esc(message.senderKind)}${own ? " is-own" : ""}" data-im-message="${esc(message.id)}">
        <header><strong>${esc(label)}</strong><time>${esc(new Date(message.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }))}</time></header>
        <div class="im-message-body message-body">${messageHtml(message)}</div>
        ${message.senderKind === "character" ? `<details class="im-model-details"><summary>调用详情</summary><span>${esc(model.modelDisplayName || model.modelId || "未知模型")} · ${model.modelStage === "fallback" ? "fallback" : "主模型"} · ${Number(model.attemptCount || 1)} 次请求 · ${Number(model.durationMs || 0)} ms</span></details>` : ""}
      </article>`;
    }).join("") + (provisional ? `<article class="im-message is-character is-provisional"><header><strong>${esc(provisional.name || "角色")}</strong><span>正在输入</span></header><div class="im-message-body message-body">${renderMarkdown(provisional.content || "等待响应…")}</div></article>` : "");
    feed.scrollTop = feed.scrollHeight;
  }

  function activeHumans() {
    return array(current?.participants?.humans).filter((item) => !item.leftAt);
  }

  function activeCharacters() {
    return array(current?.participants?.characters).filter((item) => !item.leftAt && item.status === "active");
  }

  function syncComposer() {
    const writable = current?.active === true && current?.status === "active";
    composer.contentEditable = String(writable);
    composer.setAttribute("aria-disabled", String(!writable));
    document.querySelector("#im-send").disabled = !writable;
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
    const humanRows = activeHumans().map((item) => `<li><span>${esc(item.displayName)} <small>@${esc(item.username)}</small>${item.role === "owner" ? " · 群主" : ""}</span>${owner && item.userId !== currentUserId() ? `<button class="im-button im-button-danger-quiet" type="button" data-im-remove-human="${esc(item.userId)}" aria-label="移除 ${esc(item.displayName)}">移除</button>` : ""}</li>`).join("");
    const characterRows = activeCharacters().map((item) => `<li><span>${esc(item.name)} <small>${esc(item.workTitle)}</small></span>${owner && current.kind === "group" && activeCharacters().length > 1 ? `<button class="im-button im-button-danger-quiet" type="button" data-im-remove-character="${esc(item.characterId)}" aria-label="移除 ${esc(item.name)}">移除</button>` : ""}</li>`).join("");
    host.innerHTML = `<section><h3>AI 角色</h3><ul class="im-member-list">${characterRows}</ul></section>
      <section><h3>人类成员</h3><ul class="im-member-list">${humanRows}</ul></section>
      ${current.kind === "group" && owner ? `<section class="im-owner-settings"><h3>群设置</h3>
        <label>群名称<input id="im-detail-title" maxlength="80" value="${esc(current.title)}"></label>
        <label>回复模式<select id="im-detail-mode"><option value="mention" ${current.replyMode === "mention" ? "selected" : ""}>Mention 模式</option><option value="proactive" ${current.replyMode === "proactive" ? "selected" : ""}>主动交流</option></select></label>
        <label>主动阈值 <output id="im-detail-threshold-output">${Number(current.responseThreshold)}</output><input id="im-detail-threshold" type="range" min="0" max="100" value="${Number(current.responseThreshold)}"></label>
        <label>链路上限<input id="im-detail-limit" type="number" min="1" max="100" value="${Number(current.maxAiMessages)}"></label>
        <button id="im-save-group-settings" class="primary-button" type="button">保存群设置</button>
      </section>
      <section><h3>添加成员</h3><label>AI 角色<select id="im-add-character-select"><option value="">选择角色</option>${characters.filter((item) => !activeCharacters().some((currentItem) => currentItem.characterId === item.id)).map((item) => `<option value="${esc(item.id)}">${esc(item.name)} · ${esc(item.workTitle)}</option>`).join("")}</select></label><button id="im-add-character" class="im-button im-button-positive" type="button">添加角色</button>
      <label>人类用户<select id="im-add-human-select"><option value="">选择用户</option>${users.filter((item) => !activeHumans().some((currentItem) => currentItem.userId === item.userId) && item.userId !== currentUserId()).map((item) => `<option value="${esc(item.userId)}">${esc(item.displayName)} · @${esc(item.username)}</option>`).join("")}</select></label><button id="im-add-human" class="im-button im-button-positive" type="button">添加用户</button></section>
      <section><h3>群主操作</h3><label>转让给<select id="im-transfer-select"><option value="">选择成员</option>${activeHumans().filter((item) => item.userId !== currentUserId()).map((item) => `<option value="${esc(item.userId)}">${esc(item.displayName)}</option>`).join("")}</select></label><button id="im-transfer" class="im-button im-button-secondary" type="button">转让群主</button><button id="im-disband" class="danger-button" type="button">解散群聊</button></section>` : ""}
      ${current.kind === "group" && !owner && current.active ? '<button id="im-leave" class="danger-button" type="button">退出群聊</button>' : ""}
      ${owner && current.kind === "group" ? '<section><h3>主动判断诊断</h3><div id="im-diagnostics"><p class="im-empty">尚无诊断记录。</p></div></section>' : ""}`;
    bindDetailActions(owner);
    if (owner && current.kind === "group") void loadDiagnostics();
  }

  async function loadDiagnostics() {
    try {
      const result = await api(`/api/im/conversations/${encodeURIComponent(current.id)}/diagnostics`);
      const host = document.querySelector("#im-diagnostics");
      if (!host) return;
      host.innerHTML = array(result.turns).filter((turn) => turn.kind === "judge").length
        ? array(result.turns).filter((turn) => turn.kind === "judge").map((turn) => `<div class="im-diagnostic-row"><span>${esc(turn.characterName)}</span><strong>${turn.score ?? "失败"}</strong><small>${turn.selected ? "已发言" : turn.status}</small></div>`).join("")
        : '<p class="im-empty">尚无主动判断记录。</p>';
    } catch (error) {
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
    document.querySelector("#im-add-character")?.addEventListener("click", async () => {
      const characterId = document.querySelector("#im-add-character-select").value;
      if (!characterId) return;
      await api(`/api/im/conversations/${encodeURIComponent(current.id)}/characters`, { method: "POST", body: { characterId } });
      await openConversation(current.id);
    });
    document.querySelector("#im-add-human")?.addEventListener("click", async () => {
      const userId = document.querySelector("#im-add-human-select").value;
      if (!userId) return;
      await api(`/api/im/conversations/${encodeURIComponent(current.id)}/humans`, { method: "POST", body: { userId } });
      await openConversation(current.id);
    });
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
      await api(`/api/im/conversations/${encodeURIComponent(current.id)}/transfer`, { method: "POST", body: { userId } });
      await openConversation(current.id);
    });
    document.querySelector("#im-disband")?.addEventListener("click", async () => {
      if (!window.confirm("解散后所有成员只能查看各自可见的历史，确认继续？")) return;
      await api(`/api/im/conversations/${encodeURIComponent(current.id)}/disband`, { method: "POST", body: {} });
      await openConversation(current.id);
    });
    document.querySelector("#im-leave")?.addEventListener("click", async () => {
      await api(`/api/im/conversations/${encodeURIComponent(current.id)}/leave`, { method: "POST", body: {} });
      await openConversation(current.id);
    });
    if (!owner) return;
  }

  function renderConversation() {
    document.querySelector("#im-chat-title").textContent = current?.title || "选择会话";
    document.querySelector("#im-chat-subtitle").textContent = current ? conversationSubtitle(current) : "角色单聊或混合群聊";
    document.querySelector("#im-details-toggle").disabled = !current;
    renderMessages();
    renderDetails();
    syncComposer();
  }

  async function openConversation(conversationId) {
    current = await api(`/api/im/conversations/${encodeURIComponent(conversationId)}`);
    workspace.classList.add("has-conversation");
    provisional = null;
    renderConversationList();
    renderConversation();
    if (current.active && current.latestSequence > 0) {
      await api(`/api/im/conversations/${encodeURIComponent(conversationId)}/read`, { method: "POST", body: { sequence: current.latestSequence } });
      await refreshConversations();
    }
  }

  async function loadCatalogs() {
    [characters, users, models, settings] = await Promise.all([
      api("/api/im/characters"),
      api("/api/users/directory?q="),
      api("/api/im/models"),
      api("/api/im/settings")
    ]);
    document.querySelector("#im-direct-character").innerHTML = '<option value="">选择角色</option>' + characters.map((item) => `<option value="${esc(item.id)}">${esc(item.name)} · ${esc(item.workTitle)}</option>`).join("");
  }

  function openSettings() {
    const dialog = document.querySelector("#im-settings-dialog");
    document.querySelector("#im-setting-name").value = settings.preferredName || state.user?.displayName || "";
    document.querySelector("#im-setting-pronouns").value = settings.pronouns || "";
    document.querySelector("#im-setting-identity").value = settings.identitySummary || "";
    document.querySelector("#im-setting-notes").value = settings.additionalNotes || "";
    document.querySelector("#im-setting-primary").innerHTML = '<option value="">选择主模型</option>' + models.map((model) => `<option value="${esc(model.id)}" ${settings.primaryModelId === model.id ? "selected" : ""}>${esc(model.displayName)} · ${esc(model.providerName)}</option>`).join("");
    document.querySelector("#im-setting-fallback").innerHTML = '<option value="">选择 fallback 模型</option>' + models.map((model) => `<option value="${esc(model.id)}" ${settings.fallbackModelId === model.id ? "selected" : ""}>${esc(model.displayName)} · ${esc(model.providerName)}</option>`).join("");
    document.querySelector("#im-setting-retries").value = String(settings.retryCount || 3);
    dialog.showModal();
  }

  function openGroupDialog() {
    const dialog = document.querySelector("#im-group-dialog");
    document.querySelector("#im-group-form").reset();
    document.querySelector("#im-group-character-options").innerHTML = characters.map((item) => `<label><input type="checkbox" name="characterId" value="${esc(item.id)}"><span><strong>${esc(item.name)}</strong><small>${esc(item.workTitle)}</small></span></label>`).join("") || '<p class="im-empty">没有同时具备角色读取和 AI 对话写入权限的角色。</p>';
    document.querySelector("#im-group-human-options").innerHTML = users.filter((item) => item.userId !== currentUserId()).map((item) => `<label><input type="checkbox" name="humanUserId" value="${esc(item.userId)}"><span><strong>${esc(item.displayName)}</strong><small>@${esc(item.username)}</small></span></label>`).join("") || '<p class="im-empty">没有可添加的其他用户。</p>';
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
    const text = composer.innerText ?? composer.textContent ?? "";
    const match = text.match(/@([^@\s]*)$/u);
    if (!match) {
      closeMentionMenu();
      return;
    }
    const query = match[1].toLocaleLowerCase("zh-CN");
    const caret = composerCaret();
    if (caret) mentionCaretState = { anchor: caret.anchor, offset: caret.offset };
    mentionOptions = [
      ...activeCharacters().map((item) => ({ kind: "character", id: item.characterId, label: item.name, detail: item.workTitle })),
      ...activeHumans().map((item) => ({ kind: "user", id: item.userId, label: item.displayName, detail: `@${item.username}` }))
    ].filter((item) => item.label.toLocaleLowerCase("zh-CN").includes(query)).slice(0, 12);
    mentionIndex = mentionOptions.length ? 0 : -1;
    mentionMenu.innerHTML = mentionOptions.length
      ? mentionOptions.map((item, index) => `<button type="button" role="option" aria-selected="${index === mentionIndex}" data-im-mention-index="${index}"><small>${item.kind === "character" ? "角色" : "用户"}</small><span><strong>${esc(item.label)}</strong><em>${esc(item.detail)}</em></span></button>`).join("")
      : '<p class="im-empty">没有匹配的群成员</p>';
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
    if (!item) return;
    const existingChips = [...composer.querySelectorAll("[data-im-mention-uri]")];
    const lastChip = existingChips.at(-1) ?? null;
    const tailNodes = lastChip
      ? [...composer.childNodes].slice([...composer.childNodes].indexOf(lastChip) + 1)
      : [...composer.childNodes];
    const tailText = tailNodes.map((node) => node.textContent ?? "").join("");
    const match = tailText.match(/@([^@\s]*)$/u);
    if (!match) return;
    const prefix = tailText.slice(0, tailText.length - match[0].length);
    for (const node of tailNodes) node.remove();
    if (prefix) composer.append(document.createTextNode(prefix));
    const chip = document.createElement("span");
    chip.className = "im-composer-mention";
    chip.contentEditable = "false";
    chip.dataset.imMentionUri = `mention://${item.kind}/${item.id}`;
    chip.textContent = `@${item.label}`;
    const tail = document.createTextNode(" ");
    composer.append(chip, tail);
    const range = document.createRange();
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
    const content = serializeImComposer(composer);
    if (!content) return;
    composer.replaceChildren();
    closeMentionMenu();
    try {
      const result = await api(`/api/im/conversations/${encodeURIComponent(current.id)}/messages`, {
        method: "POST",
        body: { content, requestId: requestId() }
      });
      const existing = array(current.messages).some((message) => message.id === result.message.id);
      if (!existing) current.messages.push(result.message);
      current.activeChain = result.chain;
      renderConversation();
      await refreshConversations();
      if (result.chain?.status === "waiting_config") toast("消息已发送；请配置主模型和 fallback 后重试 AI 链路", "warning");
    } catch (error) {
      composer.textContent = content;
      toast(error.message, "error");
    }
  }

  async function handleRealtime(event) {
    const envelope = JSON.parse(event.data);
    const eventConversationId = envelope.conversationId;
    if (envelope.type === "delta" && current?.id === eventConversationId) {
      provisional ??= { content: "", name: activeCharacters().find((item) => item.characterId === envelope.payload.characterId)?.name || "角色" };
      provisional.content += envelope.payload.delta || "";
      renderMessages();
      return;
    }
    if (envelope.type === "reset" && current?.id === eventConversationId) {
      provisional = null;
      renderMessages();
      return;
    }
    if (current?.id === eventConversationId) await openConversation(eventConversationId);
    else await refreshConversations();
  }

  function connectEvents() {
    eventSource?.close();
    eventSource = new EventSource("/api/im/events");
    eventSource.addEventListener("ready", () => {
      void (current ? openConversation(current.id) : refreshConversations()).catch(() => undefined);
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
    workspace.classList.add("hidden");
    workspace.classList.remove("has-conversation");
    document.querySelector("#app").classList.remove("im-mode");
    provisional = null;
    closeMentionMenu();
  }

  function bind() {
    document.querySelector("#im-open-button").addEventListener("click", () => void open().catch((error) => toast(error.message, "error")));
    document.querySelector("#im-settings-button").addEventListener("click", openSettings);
    document.querySelector("#im-new-group").addEventListener("click", openGroupDialog);
    document.querySelector("#im-direct-character").addEventListener("change", async (event) => {
      if (!event.target.value) return;
      const conversation = await api("/api/im/conversations/direct", { method: "POST", body: { characterId: event.target.value } });
      event.target.value = "";
      await refreshConversations();
      await openConversation(conversation.id);
    });
    listHost.addEventListener("click", (event) => {
      const button = event.target.closest("[data-im-conversation]");
      if (button) void openConversation(button.dataset.imConversation).catch((error) => toast(error.message, "error"));
    });
    document.querySelector("#im-send").addEventListener("click", () => void send());
    document.querySelector("#im-stop").addEventListener("click", async () => {
      await api(`/api/im/conversations/${encodeURIComponent(current.id)}/stop`, { method: "POST", body: {} });
      provisional = null;
      await openConversation(current.id);
    });
    document.querySelector("#im-retry").addEventListener("click", async () => {
      if (!current?.activeChain?.id) return;
      await api(`/api/im/conversations/${encodeURIComponent(current.id)}/chains/${encodeURIComponent(current.activeChain.id)}/retry`, { method: "POST", body: {} });
      await openConversation(current.id);
    });
    document.querySelector("#im-details-toggle").addEventListener("click", () => document.querySelector("#im-details").classList.toggle("is-open"));
    document.querySelector("#im-details-close").addEventListener("click", () => document.querySelector("#im-details").classList.remove("is-open"));
    document.querySelector("#im-mobile-back").addEventListener("click", () => {
      current = null;
      workspace.classList.remove("has-conversation");
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
    document.querySelector("#im-group-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const conversation = await api("/api/im/conversations/group", { method: "POST", body: {
        title: String(form.get("title") || "").trim(),
        characterIds: form.getAll("characterId").map(String),
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
