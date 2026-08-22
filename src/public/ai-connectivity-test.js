const objectLabels = Object.freeze({ provider: "供应商", model: "模型" });

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function objectLabel(objectType) {
  return objectLabels[objectType] ?? "AI 配置";
}

function retryTimeText(retryAt) {
  if (typeof retryAt !== "string" || !retryAt) return "";
  const date = new Date(retryAt);
  if (!Number.isFinite(date.getTime())) return "";
  return `，可于 ${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })} 再次测试`;
}

function remainingSeconds(value, fallback) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : fallback;
}

export function connectivityTestResultToast(result, objectType) {
  const source = record(result);
  const cooldown = record(source.cooldown);
  const label = objectLabel(objectType);
  if (cooldown.reason === "configuration_changed") {
    const outcome = source.ok === false && typeof source.error === "string"
      ? `旧配置测试失败：${source.error}；`
      : "旧配置测试已完成；";
    return {
      message: `${label}${outcome}配置已在测试期间更新，旧结果不会锁定新配置，现在可以重新测试`,
      type: "warning"
    };
  }
  if (source.ok === true) {
    const imageNotice = objectType === "model" && source.multimodalTested === true ? "，图片请求已验证" : "";
    const privateHint = source.privateNetworkAllowed === true
      ? "；当前地址指向本机或内网，已允许连接，请确认该地址可信"
      : "";
    return {
      message: `${label}连接测试成功${imageNotice}${privateHint}；接下来 2 分钟内不能再次测试${retryTimeText(cooldown.retryAt)}`,
      type: privateHint ? "warning" : "info"
    };
  }
  const failure = typeof source.error === "string" && source.error ? source.error : "未知错误";
  return {
    message: `${label}连接测试失败：${failure}；10 秒后可以重试${retryTimeText(cooldown.retryAt)}`,
    type: "error"
  };
}

export function connectivityTestErrorToast(error, objectType) {
  const source = record(error);
  const details = record(source.details);
  const label = objectLabel(objectType);
  if (details.reason === "in_progress") {
    const seconds = remainingSeconds(details.retryAfterSeconds, 1);
    return {
      message: `${label}已有连接测试正在进行，请等待约 ${seconds} 秒${retryTimeText(details.retryAt)}`,
      type: "warning"
    };
  }
  if (details.reason === "success_cooldown") {
    const seconds = remainingSeconds(details.retryAfterSeconds, 120);
    return {
      message: `${label}仍在成功冷却中，剩余 ${seconds} 秒${retryTimeText(details.retryAt)}`,
      type: "warning"
    };
  }
  if (details.reason === "failure_cooldown") {
    const seconds = remainingSeconds(details.retryAfterSeconds, 10);
    return {
      message: `${label}仍在失败冷却中，剩余 ${seconds} 秒${retryTimeText(details.retryAt)}`,
      type: "warning"
    };
  }
  const message = typeof source.message === "string" && source.message ? source.message : "请求失败";
  return { message: `${label}连接测试失败：${message}`, type: "error" };
}

export function connectivityConfigurationSavedToast(objectType) {
  const label = objectLabel(objectType);
  return `${label}配置已保存，旧连接测试冷却已清除，现在可以重新测试`;
}
