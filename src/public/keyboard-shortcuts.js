export function isGlobalSearchShortcut(event) {
  if (!event || String(event.key ?? "").toLowerCase() !== "f") return false;
  return (Boolean(event.metaKey) || Boolean(event.ctrlKey)) && !event.altKey && !event.shiftKey;
}

export function isSaveShortcut(event) {
  if (!event || String(event.key ?? "").toLowerCase() !== "s") return false;
  return (Boolean(event.metaKey) || Boolean(event.ctrlKey)) && !event.altKey && !event.shiftKey;
}
