/**
 * @param {string} code
 * @param {string} message
 */
function streamTransportError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.status = 502;
  return error;
}

/** @param {boolean} completed */
export function assertAiStreamCompleted(completed) {
  if (completed) return;
  throw streamTransportError(
    "AI_STREAM_UPSTREAM_CLOSED",
    "AI 流在收到完成事件前已关闭，已保留已生成内容"
  );
}

/**
 * @param {ReadableStream<Uint8Array>} body
 * @param {(eventName: string, payload: unknown) => void | Promise<void>} onEvent
 */
export async function readAiEventStream(body, onEvent) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  const consume = async (eventText) => {
    let eventName = "message";
    const dataLines = [];
    for (const line of eventText.split(/\r?\n/)) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) return;
    const payload = JSON.parse(dataLines.join("\n"));
    await onEvent(eventName, payload);
    if (eventName === "complete") completed = true;
  };
  while (true) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch {
      throw streamTransportError(
        "AI_STREAM_NETWORK_ERROR",
        "AI 流连接中断，已保留已生成内容"
      );
    }
    buffer += decoder.decode(chunk.value, { stream: !chunk.done });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? "";
    for (const eventText of events) await consume(eventText);
    if (chunk.done) break;
  }
  if (buffer.trim()) await consume(buffer);
  return { completed };
}
