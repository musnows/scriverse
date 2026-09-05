export function s3TargetPayload(target) {
  const { hasCredentials, nextRunAt, ...configuration } = target;
  return configuration;
}

export function s3DisplayRoot(prefix) {
  const directory = String(prefix ?? "").trim().split("/").filter(Boolean).join("/");
  return `/${directory ? `${directory}/` : ""}scriverse`;
}

export function createS3BackupUi({ api, toast, esc, openDialog, getUser, returnToSettings }) {
  const $ = (selector) => document.querySelector(selector);
  const dialog = $("#s3-backup-dialog");
  let configuration = null;
  let status = { running: null, events: [] };
  let timer = null;
  let polling = false;
  let pollFailed = false;
  let saving = false;
  let generation = 0;
  let seen = new Set();
  let activeUserId = null;
  let renderedCards = "";

  function rememberEvents() {
    try { sessionStorage.setItem(`scriverse.s3-events.${activeUserId}`, JSON.stringify([...seen].slice(-100))); } catch { /* 浏览器禁用会话存储时仍在当前页面去重。 */ }
  }

  function render() {
    if (!configuration || !dialog.open) return;
    const running = status.running;
    $("#s3-backup-timezone").textContent = `每日定时按服务器时区 ${configuration.timeZone} 执行；服务运行时生效。多个已启用目标依次同步。`;
    $("#s3-backup-run").disabled = saving || Boolean(running) || !configuration.targets.some((target) => target.enabled);
    $("#s3-backup-add").disabled = saving || Boolean(running) || configuration.targets.length >= 20;
    $("#s3-backup-summary").textContent = pollFailed ? "备份状态读取失败，请检查连接后重试。"
      : running ? `正在备份：${configuration.targets.find((target) => target.id === running.currentTargetId)?.name ?? "准备数据库快照"}`
        : `已启用 ${configuration.targets.filter((target) => target.enabled).length} / ${configuration.targets.length} 个目标`;
    const cards = configuration.targets.length ? configuration.targets.map((target) => {
      const result = [...status.events].reverse().find((event) => event.targetId === target.id);
      const root = s3DisplayRoot(target.prefix);
      return `<article class="record-card provider-card s3-backup-card" data-s3-card="${esc(target.id)}">
        <div class="provider-card-meta"><small>${target.includeImages ? "数据库与图片" : "仅数据库"}</small><span class="provider-status-badge ${target.enabled ? "is-enabled" : "is-disabled"}">${target.enabled ? "已启用" : "已停用"}</span></div>
        <h3>${esc(target.name)}</h3><p class="s3-backup-location">${esc(target.endpoint)}<br>桶：${esc(target.bucket)}<br>目录：${esc(root)}</p>
        <p class="s3-backup-schedule">${target.scheduleEnabled ? `每日 ${esc(target.scheduleTime)}` : "仅手动备份"} · 保留 ${target.retentionCount} 个数据库快照</p>
        ${target.nextRunAt ? `<p>下次定时：${esc(new Date(target.nextRunAt).toLocaleString("zh-CN"))}</p>` : ""}
        ${result ? `<p class="s3-backup-result ${result.status === "error" ? "is-error" : ""}">${esc(new Date(result.completedAt).toLocaleString("zh-CN"))}<br>${esc(result.message)}</p>` : "<p class=\"s3-backup-result\">尚未执行备份</p>"}
        <div class="card-actions"><button type="button" data-s3-edit="${esc(target.id)}" ${running || saving ? "disabled" : ""}>编辑配置</button><button type="button" data-s3-toggle="${esc(target.id)}" ${running || saving ? "disabled" : ""}>${target.enabled ? "停用" : "启用"}</button><button type="button" data-s3-remove="${esc(target.id)}" ${running || saving ? "disabled" : ""}>移除配置</button></div>
      </article>`;
    }).join("") : `<div class="empty-state"><h3>尚未配置备份目标</h3><p>添加 Amazon S3 或兼容服务，将整个系统的数据库与图片保存到你的存储桶。</p></div>`;
    if (cards !== renderedCards) {
      const focused = document.activeElement;
      const action = ["data-s3-edit", "data-s3-toggle", "data-s3-remove"].find((attribute) => focused?.hasAttribute(attribute));
      const id = action ? focused.getAttribute(action) : null;
      $("#s3-backup-targets").innerHTML = cards;
      renderedCards = cards;
      if (action && id) $("#s3-backup-targets").querySelector(`[${action}="${CSS.escape(id)}"]`)?.focus();
    }
  }

  async function poll() {
    if (getUser()?.role !== "admin" || polling) return;
    polling = true;
    const currentGeneration = generation;
    try {
      const next = await api("/api/platform/s3-backup/status");
      if (currentGeneration !== generation) return;
      const completed = status.running && !next.running;
      status = next;
      pollFailed = false;
      for (const event of next.events) {
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        if (event.status === "error" || event.trigger === "manual") toast(`${event.trigger === "scheduled" ? "定时备份" : "手动备份"} · ${event.targetName}：${event.message}`, event.status === "error" ? "error" : "info");
      }
      rememberEvents();
      if (completed && dialog.open) configuration = await api("/api/platform/s3-backup");
      render();
    } catch (error) {
      if (currentGeneration !== generation) return;
      if (!pollFailed) toast(`无法读取 S3 备份状态：${error.message}`, "error");
      pollFailed = true;
      render();
    } finally {
      polling = false;
      if (activeUserId && getUser()?.role === "admin") {
        clearTimeout(timer);
        timer = setTimeout(poll, currentGeneration !== generation ? 0 : status.running ? 1500 : 10_000);
      }
    }
  }

  async function reload() {
    configuration = await api("/api/platform/s3-backup");
    await poll();
    render();
  }

  async function saveTargets(targets) {
    if (saving) return;
    saving = true;
    try {
      configuration = await api("/api/platform/s3-backup", { method: "PUT", body: { revision: configuration.revision, targets: targets.map(s3TargetPayload) } });
      toast("备份配置已保存");
    } finally { saving = false; render(); }
  }

  function edit(target) {
    const value = target ?? { id: crypto.randomUUID(), name: "", endpoint: "", region: "us-east-1", bucket: "", prefix: "", enabled: true,
      forcePathStyle: true, includeImages: true, scheduleEnabled: true, scheduleTime: "03:00", retentionCount: 7 };
    const input = (name, label, type = "text", attributes = "") => `<label>${label}<input name="${name}" type="${type}" value="${esc(value[name] ?? "")}" ${attributes}></label>`;
    const checkbox = (name, label) => `<label class="checkbox-field"><input type="checkbox" name="${name}" ${value[name] ? "checked" : ""}>${label}</label>`;
    openDialog(target ? "编辑备份目标" : "添加备份目标", `<div class="s3-target-fields">
      ${input("name", "目标名称", "text", 'required maxlength="100" placeholder="例如：家庭存储"')}
      ${input("endpoint", "S3 服务地址", "url", 'required maxlength="2048" placeholder="https://s3.example.com"')}
      ${input("bucket", "存储桶", "text", 'required minlength="3" maxlength="63"')}
      ${input("region", "区域（Region）", "text", 'required maxlength="64"')}
      <label>访问密钥（AK）<input name="accessKeyId" type="password" autocomplete="new-password" maxlength="256" ${target ? 'placeholder="已保存；留空保留"' : 'required'}></label>
      <label>秘密密钥（SK）<input name="secretAccessKey" type="password" autocomplete="new-password" maxlength="512" ${target ? 'placeholder="已保存；留空保留"' : 'required'}></label>
      ${input("prefix", "桶内子目录（可选）", "text", 'maxlength="500" placeholder="留空使用桶根目录"')}
      ${input("retentionCount", "数据库快照保留个数", "number", 'required min="1" max="1000" step="1"')}
      <p class="form-field-note s3-path-preview">目标目录：<span id="s3-target-path">${esc(s3DisplayRoot(value.prefix))}</span>/db 与 /img</p>
      ${checkbox("enabled", "启用此备份目标")}${checkbox("includeImages", "同时备份图片")}
      ${checkbox("scheduleEnabled", "启用每日定时备份")}${input("scheduleTime", "每日触发时间", "time", 'required')}
      ${checkbox("forcePathStyle", "使用路径式访问（兼容服务常用）")}
      <p class="form-field-note">定时使用服务器时区 ${esc(configuration.timeZone)}。留存清理只删除本功能创建的旧数据库快照，图片始终保留。编辑凭据时需同时填写 AK 和 SK。</p>
    </div>`, async (form) => {
      const updated = { ...s3TargetPayload(value), name: String(form.get("name")), endpoint: String(form.get("endpoint")),
        region: String(form.get("region")), bucket: String(form.get("bucket")), prefix: String(form.get("prefix")),
        retentionCount: Number(form.get("retentionCount")), scheduleTime: String(form.get("scheduleTime") ?? value.scheduleTime),
        accessKeyId: String(form.get("accessKeyId")), secretAccessKey: String(form.get("secretAccessKey")),
        enabled: form.has("enabled"), includeImages: form.has("includeImages"), scheduleEnabled: form.has("scheduleEnabled"), forcePathStyle: form.has("forcePathStyle") };
      await saveTargets(target ? configuration.targets.map((item) => item.id === target.id ? updated : item) : [...configuration.targets, updated]);
    }, "系统备份", { wide: true, submitLabel: "保存目标" });
    $("#dialog-fields [name=prefix]").addEventListener("input", (event) => { $("#s3-target-path").textContent = s3DisplayRoot(event.target.value); });
    const time = $("#dialog-fields [name=scheduleTime]");
    const scheduled = $("#dialog-fields [name=scheduleEnabled]");
    const updateTime = () => { time.disabled = !scheduled.checked; time.required = scheduled.checked; };
    scheduled.addEventListener("change", updateTime);
    updateTime();
  }

  $("#s3-backup-button").addEventListener("click", async () => {
    if (getUser()?.role !== "admin") return;
    dialog.showModal();
    $("#s3-backup-summary").textContent = "正在加载备份配置…";
    try { await reload(); } catch (error) { toast(`备份配置加载失败：${error.message}`, "error"); }
  });
  $("#s3-backup-close").addEventListener("click", () => dialog.close());
  $("#s3-backup-return").addEventListener("click", () => returnToSettings("#s3-backup-button", "#s3-backup-dialog").catch((error) => toast(error.message, "error")));
  $("#s3-backup-add").addEventListener("click", () => edit());
  $("#s3-backup-refresh").addEventListener("click", () => reload().catch((error) => toast(error.message, "error")));
  $("#s3-backup-run").addEventListener("click", async () => {
    $("#s3-backup-run").disabled = true;
    try {
      status.running = await api("/api/platform/s3-backup/run", { method: "POST", body: {} });
      toast("已开始备份，将依次同步所有已启用目标");
      render();
      await poll();
    } catch (error) { toast(error.message, "error"); render(); }
  });
  $("#s3-backup-targets").addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button || saving || status.running) return;
    const id = button.dataset.s3Edit ?? button.dataset.s3Toggle ?? button.dataset.s3Remove;
    const target = configuration.targets.find((item) => item.id === id);
    if (!target) return;
    if (button.dataset.s3Edit) { edit(target); return; }
    if (button.dataset.s3Remove) {
      openDialog("移除备份配置", `<p>移除“${esc(target.name)}”的本地配置。远端数据库快照和图片仍保留。</p>`,
        () => saveTargets(configuration.targets.filter((item) => item.id !== id)), "系统备份", { submitLabel: "移除配置" });
      return;
    }
    button.disabled = true;
    try { await saveTargets(configuration.targets.map((item) => item.id === id ? { ...item, enabled: !item.enabled } : item)); }
    catch (error) { toast(error.message, "error"); render(); }
  });
  return {
    setUser(user) {
      if (activeUserId === user?.userId && user?.role === "admin") return;
      generation += 1;
      clearTimeout(timer);
      activeUserId = user?.role === "admin" ? user.userId : null;
      configuration = null;
      status = { running: null, events: [] };
      seen = new Set();
      if (!activeUserId) { dialog.close(); return; }
      try { seen = new Set(JSON.parse(sessionStorage.getItem(`scriverse.s3-events.${activeUserId}`) ?? "[]")); } catch { /* 无效的本地记录不会阻断备份通知。 */ }
      void poll();
    }
  };
}
