function normalizedId(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

export function createAiRequestAbortError(message = "AI 请求已取消") {
  const error = new Error(message);
  error.name = "AbortError";
  error.code = "AI_REQUEST_CANCELLED";
  return error;
}

export function isAiRequestCancellation(error, request = null) {
  if (request?.signal?.aborted) return true;
  return error?.name === "AbortError" || error?.code === "AI_REQUEST_CANCELLED";
}

export function aiRequestTargetsState(request, current) {
  if (!request || normalizedId(current?.workId) !== request.workId) return false;
  return request.conversationId === null
    || normalizedId(current?.conversationId) === request.conversationId;
}

export function createAiRequestManager() {
  let generation = 0;
  const activeRequests = new Map();

  const requestKey = (input) => normalizedId(input?.tabId) ?? "default";

  const snapshot = (input, controller, requestGeneration) => Object.freeze({
    generation: requestGeneration,
    tabId: requestKey(input),
    workId: normalizedId(input.workId),
    conversationId: normalizedId(input.conversationId),
    userMessageId: normalizedId(input.userMessageId),
    signal: controller.signal
  });

  const isCurrent = (request) => Boolean(
    request
    && activeRequests.has(request.tabId)
    && !activeRequests.get(request.tabId).controller.signal.aborted
    && activeRequests.get(request.tabId).snapshot.generation === request.generation
    && activeRequests.get(request.tabId).controller.signal === request.signal
  );

  const cancel = (reason = "AI 请求已取消", tabId = "default") => {
    const key = requestKey({ tabId });
    const current = activeRequests.get(key);
    if (!current) return false;
    activeRequests.delete(key);
    current.controller.abort(createAiRequestAbortError(reason));
    current.resolveFinished();
    return true;
  };

  const cancelAll = (reason = "AI 请求已取消") => {
    const requests = [...activeRequests.values()];
    activeRequests.clear();
    for (const current of requests) {
      current.controller.abort(createAiRequestAbortError(reason));
      current.resolveFinished();
    }
    return requests.length;
  };

  const begin = (input) => {
    const key = requestKey(input);
    cancel("新的 AI 请求已开始", key);
    const controller = new AbortController();
    generation += 1;
    const request = snapshot(input, controller, generation);
    if (!request.workId) throw new Error("AI 请求必须绑定作品");
    let resolveFinished;
    const finished = new Promise((resolve) => { resolveFinished = resolve; });
    activeRequests.set(key, { controller, snapshot: request, finished, resolveFinished });
    return request;
  };

  const bind = (request, patch) => {
    if (!isCurrent(request)) throw createAiRequestAbortError("AI 请求已失效");
    const conversationId = Object.hasOwn(patch, "conversationId")
      ? normalizedId(patch.conversationId)
      : request.conversationId;
    const userMessageId = Object.hasOwn(patch, "userMessageId")
      ? normalizedId(patch.userMessageId)
      : request.userMessageId;
    if (request.conversationId && conversationId !== request.conversationId) {
      throw new Error("AI 请求不能改绑到其他对话");
    }
    if (request.userMessageId && userMessageId !== request.userMessageId) {
      throw new Error("AI 请求不能改绑到其他用户消息");
    }
    const current = activeRequests.get(request.tabId);
    const next = snapshot({
      tabId: request.tabId,
      workId: request.workId,
      conversationId,
      userMessageId
    }, current.controller, request.generation);
    current.snapshot = next;
    return next;
  };

  const finish = (request) => {
    if (!isCurrent(request)) return false;
    activeRequests.get(request.tabId).resolveFinished();
    activeRequests.delete(request.tabId);
    return true;
  };

  return {
    begin,
    bind,
    cancel,
    cancelAll,
    finish,
    whenIdle: (tabId) => activeRequests.get(requestKey({ tabId }))?.finished ?? Promise.resolve(),
    hasActive: (tabId = null) => tabId === null
      ? activeRequests.size > 0
      : activeRequests.has(requestKey({ tabId })),
    isCurrent
  };
}
