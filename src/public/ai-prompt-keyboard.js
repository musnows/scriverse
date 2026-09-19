export function shouldSendAiPrompt(event) {
  return event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing;
}

export function shouldSteerAiPrompt(event) {
  return event.key === "Enter" && !event.shiftKey && !event.altKey && !event.isComposing && (event.ctrlKey || event.metaKey);
}
