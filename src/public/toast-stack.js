export function createToastStack(region, { onEmpty = () => {} } = {}) {
  const document = region.ownerDocument;
  const element = document.createElement("div");
  element.className = "toast-stack";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "ghost-button toast-stack-toggle";
  toggle.setAttribute("aria-controls", "notification-toast-list");
  const label = document.createElement("span");
  toggle.append(label);
  const list = document.createElement("div");
  list.id = "notification-toast-list";
  list.className = "toast-stack-items";
  element.append(toggle, list);
  const entries = new Map();
  let expanded = false;

  function pause(entry) {
    if (entry.timer === null) return;
    clearTimeout(entry.timer);
    entry.timer = null;
    entry.remaining = Math.max(0, entry.remaining - (Date.now() - entry.startedAt));
  }

  function resume(toast, entry) {
    if (entry.timer !== null) return;
    entry.startedAt = Date.now();
    entry.timer = setTimeout(() => dismiss(toast), entry.remaining);
  }

  function sync() {
    const count = entries.size;
    if (count < 2) expanded = false;
    element.dataset.expanded = String(expanded);
    element.dataset.stacked = String(count > 1);
    toggle.hidden = count < 2;
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.setAttribute("aria-label", `${expanded ? "收起" : "展开"} ${count} 条通知`);
    label.textContent = expanded ? `收起通知（${count}）` : `${count} 条通知 · 点击展开`;
    [...entries].forEach(([toast, entry], index) => {
      const depth = count - index - 1;
      toast.style.setProperty("--toast-depth", String(Math.min(depth, 2)));
      toast.classList.toggle("toast-stack-overflow", depth > 2);
      toast.inert = !expanded && depth > 0;
      toast.tabIndex = expanded || count === 1 ? 0 : -1;
      if (expanded) pause(entry);
      else resume(toast, entry);
    });
  }

  function setExpanded(value) {
    expanded = value;
    sync();
    toggle.focus({ preventScroll: true });
  }

  toggle.addEventListener("click", () => setExpanded(!expanded));
  element.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !expanded) return;
    event.preventDefault();
    event.stopPropagation();
    setExpanded(false);
  });

  function dismiss(toast) {
    const entry = entries.get(toast);
    if (!entry) return false;
    const restoreFocus = document.activeElement === toast || document.activeElement === toggle;
    pause(entry);
    entries.delete(toast);
    toast.remove();
    sync();
    if (!entries.size) {
      element.remove();
      onEmpty();
    } else if (restoreFocus) {
      const target = toggle.hidden ? list.lastElementChild : toggle;
      target?.focus({ preventScroll: true });
    }
    return true;
  }

  return {
    element,
    add(toast) {
      entries.set(toast, { timer: null, remaining: 3600, startedAt: 0 });
      toast.addEventListener("click", () => {
        if (entries.size > 1 && !expanded) setExpanded(true);
        else dismiss(toast);
      });
      toast.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        toast.click();
      });
      list.append(toast);
      if (element.parentElement !== region) region.append(element);
      sync();
    },
    dismiss,
    clear() {
      for (const toast of entries.keys()) dismiss(toast);
    }
  };
}
