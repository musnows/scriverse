const STREAMING_CHARACTERS_PER_FRAME = 1;
const FINISHING_CHARACTERS_PER_FRAME = 2;
const FINISHING_ACCELERATION = 0.9;
const MAX_STREAMING_CHARACTERS_PER_FRAME = 12;
const MAX_FINISHING_CHARACTERS_PER_FRAME = 24;
const STREAMING_FRAME_RATE = 60;
const DEFAULT_STREAMING_CHARACTERS_PER_SECOND = STREAMING_CHARACTERS_PER_FRAME * STREAMING_FRAME_RATE;
const MIN_STREAMING_CHARACTERS_PER_SECOND = DEFAULT_STREAMING_CHARACTERS_PER_SECOND;
const MAX_STREAMING_CHARACTERS_PER_SECOND = MAX_STREAMING_CHARACTERS_PER_FRAME * STREAMING_FRAME_RATE;
const SPEED_SAMPLE_MAX_GAP_MS = 1_000;
const SPEED_SMOOTHING = 0.25;

function clampCharactersPerSecond(value) {
  const speed = Number(value);
  if (!Number.isFinite(speed)) return DEFAULT_STREAMING_CHARACTERS_PER_SECOND;
  return Math.min(MAX_STREAMING_CHARACTERS_PER_SECOND, Math.max(MIN_STREAMING_CHARACTERS_PER_SECOND, speed));
}

function currentTime() {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

export function createStreamTypewriterSpeedController({
  now = currentTime,
  initialCharactersPerSecond = DEFAULT_STREAMING_CHARACTERS_PER_SECOND
} = {}) {
  let charactersPerSecond = clampCharactersPerSecond(initialCharactersPerSecond);
  let lastObservedAt = null;

  const update = (observedCharactersPerSecond) => {
    const observed = clampCharactersPerSecond(observedCharactersPerSecond);
    charactersPerSecond = clampCharactersPerSecond(
      charactersPerSecond + (observed - charactersPerSecond) * SPEED_SMOOTHING
    );
  };

  return {
    observe(characterCount) {
      const characters = Math.max(0, Math.floor(Number(characterCount) || 0));
      if (characters === 0) return;
      const observedAt = Number(now());
      if (Number.isFinite(observedAt) && lastObservedAt !== null) {
        const elapsed = observedAt - lastObservedAt;
        if (elapsed > 0 && elapsed <= SPEED_SAMPLE_MAX_GAP_MS) {
          update(characters / elapsed * 1_000);
        }
      }
      if (Number.isFinite(observedAt)) lastObservedAt = observedAt;

      // 单次收到的大块内容也需要让同一条流的后续轮次继承当前的追赶速度。
      const backlogSpeed = Math.ceil(characters / 30) * STREAMING_FRAME_RATE;
      if (backlogSpeed > charactersPerSecond) charactersPerSecond = Math.min(MAX_STREAMING_CHARACTERS_PER_SECOND, backlogSpeed);
    },
    charactersPerSecond() {
      return charactersPerSecond;
    }
  };
}

export function streamTypewriterBatchSize(pendingCharacters, finishing = false, charactersPerSecond = DEFAULT_STREAMING_CHARACTERS_PER_SECOND) {
  const pending = Math.max(0, Math.floor(Number(pendingCharacters) || 0));
  if (pending === 0) return 0;
  const minimum = finishing ? FINISHING_CHARACTERS_PER_FRAME : STREAMING_CHARACTERS_PER_FRAME;
  const maximum = finishing ? MAX_FINISHING_CHARACTERS_PER_FRAME : MAX_STREAMING_CHARACTERS_PER_FRAME;
  const speedBased = Math.ceil(clampCharactersPerSecond(charactersPerSecond) / STREAMING_FRAME_RATE);
  const adaptive = finishing
    ? Math.max(Math.ceil(Math.sqrt(pending) * FINISHING_ACCELERATION), speedBased)
    : Math.max(Math.ceil(pending / 30), speedBased);
  return Math.min(pending, maximum, Math.max(minimum, adaptive));
}

export function createStreamTypewriter({
  onRender,
  scheduleFrame = (callback) => window.requestAnimationFrame(callback),
  cancelFrame = (handle) => window.cancelAnimationFrame(handle),
  reducedMotion = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true,
  speedController = null,
  shouldAnimate = () => true,
  visibilitySource = typeof document === "undefined" ? null : document
}) {
  if (typeof onRender !== "function") throw new TypeError("onRender must be a function");

  let visibleText = "";
  let visibleCharacterCount = 0;
  let pendingCharacters = [];
  let pendingOffset = 0;
  const pendingCount = () => pendingCharacters.length - pendingOffset;
  const takePending = (count) => {
    const characters = pendingCharacters.slice(pendingOffset, pendingOffset + count);
    visibleText += characters.join("");
    visibleCharacterCount += characters.length;
    pendingOffset += characters.length;
    if (pendingOffset === pendingCharacters.length) { pendingCharacters = []; pendingOffset = 0; }
  };
  const idleResolvers = [];
  let scheduledFrame = null;
  let finishing = false;
  let listeningForVisibility = false;

  const snapshot = () => visibleText;
  const visibilityChanged = () => {
    if (pendingCount()) typewriter.reveal();
  };
  const resolveIdle = () => {
    if (pendingCount() || scheduledFrame !== null) return;
    if (listeningForVisibility) {
      visibilitySource.removeEventListener("visibilitychange", visibilityChanged);
      listeningForVisibility = false;
    }
    const value = snapshot();
    for (const resolve of idleResolvers.splice(0)) resolve(value);
  };
  const render = () => {
    onRender(snapshot(), {
      visibleCharacters: visibleCharacterCount,
      pendingCharacters: pendingCount()
    });
  };
  const schedule = () => {
    if (visibilitySource?.visibilityState === "hidden" || !shouldAnimate()) {
      typewriter.reveal();
      return;
    }
    if (scheduledFrame !== null || pendingCount() === 0) return;
    if (visibilitySource && !listeningForVisibility) {
      visibilitySource.addEventListener("visibilitychange", visibilityChanged);
      listeningForVisibility = true;
    }
    scheduledFrame = scheduleFrame(() => {
      scheduledFrame = null;
      const batchSize = reducedMotion || !shouldAnimate()
        ? pendingCount()
        : streamTypewriterBatchSize(
          pendingCount(),
          finishing,
          speedController?.charactersPerSecond?.()
        );
      const catchUp = pendingCount() > 4096 ? Math.min(2048, Math.ceil(pendingCount() / 8)) : batchSize;
      takePending(Math.max(batchSize, catchUp));
      render();
      if (pendingCount()) schedule();
      else resolveIdle();
    });
  };

  const typewriter = {
    append(value) {
      const characters = Array.from(String(value ?? ""));
      if (!characters.length) return;
      speedController?.observe?.(characters.length);
      for (const character of characters) pendingCharacters.push(character);
      schedule();
    },
    replace(value) {
      if (scheduledFrame !== null) {
        cancelFrame(scheduledFrame);
        scheduledFrame = null;
      }
      visibleText = String(value ?? "");
      visibleCharacterCount = Array.from(visibleText).length;
      pendingCharacters = [];
      pendingOffset = 0;
      finishing = false;
      render();
      resolveIdle();
      return snapshot();
    },
    finish() {
      if (!pendingCount() && scheduledFrame === null) return Promise.resolve(snapshot());
      finishing = true;
      const completed = new Promise((resolve) => idleResolvers.push(resolve));
      schedule();
      return completed;
    },
    reveal() {
      if (scheduledFrame !== null) {
        cancelFrame(scheduledFrame);
        scheduledFrame = null;
      }
      takePending(pendingCount());
      finishing = false;
      render();
      resolveIdle();
      return snapshot();
    }
  };
  return typewriter;
}
