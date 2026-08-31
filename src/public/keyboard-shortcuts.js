export function isGlobalSearchShortcut(event) {
  if (!event || String(event.key ?? "").toLowerCase() !== "f") return false;
  return (Boolean(event.metaKey) || Boolean(event.ctrlKey)) && !event.altKey && !event.shiftKey;
}

export function isSaveShortcut(event, platform) {
  if (!event || String(event.key ?? "").toLowerCase() !== "s") return false;
  const isMac = /^mac/iu.test(String(platform ?? ""));
  const primaryModifier = isMac
    ? Boolean(event.metaKey) && !event.ctrlKey
    : Boolean(event.ctrlKey) && !event.metaKey;
  return primaryModifier && !event.altKey && !event.shiftKey;
}
