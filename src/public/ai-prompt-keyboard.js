export function shouldSendAiPrompt(event) {
  return event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing;
}

export function shouldActivateAiSendControl(event) {
  return event.key === "Enter" && !event.shiftKey && !event.altKey && !event.isComposing;
}
