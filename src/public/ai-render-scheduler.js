export function createAiRenderScheduler({ isVisible, isConnected = () => true, schedule = requestAnimationFrame, now = () => performance.now(), intervalMs = 32, budgetMs = 4 }) {
  const pending = new Map();
  let frame = null;
  let lastRendered = -Infinity;
  const refresh = () => {
    for (const target of pending.keys()) {
      if (!isConnected(target)) pending.delete(target);
    }
    if (frame !== null || ![...pending.keys()].some(isVisible)) return;
    frame = schedule(() => {
      frame = null;
      const started = now();
      if (started - lastRendered >= intervalMs) {
        for (const [target, render] of pending) {
          if (!isConnected(target)) { pending.delete(target); continue; }
          if (!isVisible(target)) continue;
          pending.delete(target);
          render();
          lastRendered = started;
          if (now() - started >= budgetMs) break;
        }
      }
      refresh();
    });
  };
  return {
    enqueue(target, render) { pending.set(target, render); refresh(); },
    refresh
  };
}
