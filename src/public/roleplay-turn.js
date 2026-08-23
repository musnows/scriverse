const SCENE_DIRECTION_TAG = "scene_direction";
const USER_MESSAGE_TAG = "user_message";
const SCENE_PIN_LOCATION_MAX = 200;
const SCENE_PIN_PRESENT_MAX = 500;
const SCENE_PIN_TIME_MAX = 200;

function escapeXmlText(text) {
  return String(text ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;");
}

function unescapeXmlText(text) {
  return String(text ?? "").replaceAll("&lt;", "<").replaceAll("&amp;", "&");
}

function wrapRegion(tag, body, escape = true) {
  const trimmed = String(body ?? "").trim();
  if (!trimmed) return "";
  const content = escape ? escapeXmlText(trimmed) : trimmed;
  return `<${tag}>\n${content}\n</${tag}>`;
}

function unwrapRegion(content, tag) {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  if (!content.startsWith(open)) return null;
  const closeIndex = content.indexOf(close, open.length);
  if (closeIndex < 0) return null;
  const inner = content.slice(open.length, closeIndex).replace(/^\n/u, "").replace(/\n$/u, "");
  const rest = content.slice(closeIndex + close.length).trim();
  return { inner, rest };
}

export function emptyRoleplayScenePin() {
  return { location: "", present: "", timeLabel: "" };
}

export function normalizeRoleplayScenePin(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const clip = (raw, maximum) => (typeof raw === "string" ? raw.trim().slice(0, maximum) : "");
  return {
    location: clip(source.location, SCENE_PIN_LOCATION_MAX),
    present: clip(source.present, SCENE_PIN_PRESENT_MAX),
    timeLabel: clip(source.timeLabel, SCENE_PIN_TIME_MAX)
  };
}

export function roleplayScenePinHasContent(pin) {
  const normalized = normalizeRoleplayScenePin(pin);
  return Boolean(normalized.location || normalized.present || normalized.timeLabel);
}

export function formatRoleplayScenePinText(pin) {
  const normalized = normalizeRoleplayScenePin(pin);
  const lines = [];
  if (normalized.location) lines.push(`地点：${normalized.location}`);
  if (normalized.present) lines.push(`在场：${normalized.present}`);
  if (normalized.timeLabel) lines.push(`故事时间：${normalized.timeLabel}`);
  return lines.join("\n");
}

export function composeRoleplayCurrentUserTurn(sceneDirection, userMessage) {
  return [
    wrapRegion(SCENE_DIRECTION_TAG, sceneDirection, true),
    wrapRegion(USER_MESSAGE_TAG, userMessage, false)
  ].filter(Boolean).join("\n\n");
}

export function composeRoleplayStoredUserContent(sceneDirection, userMessage) {
  const scene = wrapRegion(SCENE_DIRECTION_TAG, sceneDirection, true);
  if (!scene) return String(userMessage ?? "");
  const user = wrapRegion(USER_MESSAGE_TAG, userMessage, false);
  return [scene, user].filter(Boolean).join("\n\n");
}

export function parseRoleplayUserTurn(content) {
  const original = String(content ?? "");
  const trimmed = original.trim();
  const scene = unwrapRegion(trimmed, SCENE_DIRECTION_TAG);
  if (!scene) {
    return { sceneDirection: "", userMessage: original, hasMarkup: false };
  }
  const user = unwrapRegion(scene.rest, USER_MESSAGE_TAG);
  return {
    sceneDirection: unescapeXmlText(scene.inner),
    userMessage: user ? user.inner : scene.rest,
    hasMarkup: true
  };
}

export function roleplayUserTurnDisplayText(content) {
  const parsed = parseRoleplayUserTurn(content);
  if (!parsed.hasMarkup) return content;
  return [parsed.sceneDirection, parsed.userMessage].filter(Boolean).join("\n");
}

export function roleplayUserTurnTitleSource(content) {
  const parsed = parseRoleplayUserTurn(content);
  if (!parsed.hasMarkup) return content;
  return parsed.userMessage || parsed.sceneDirection;
}
