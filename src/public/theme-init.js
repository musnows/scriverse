(() => {
  let storedTheme = null;
  try { storedTheme = localStorage.getItem("scriverse-color-theme-v1"); } catch { /* 使用系统主题 */ }
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  const theme = storedTheme === "dark" || storedTheme === "light" ? storedTheme : prefersDark ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  // 登录页路由首帧直接显示登录卡片，避免出现"骨架屏 → 登录页"的跳变
  const routeParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const routeView = routeParams.get("view") ?? "";
  const routeWorkId = routeParams.get("work") ?? "";
  const routeChapterId = routeParams.get("chapter") ?? "";
  const prefetchData = (path, key) => fetch(path, { headers: { Accept: "application/json" }, priority: "high" })
    .then(async (response) => {
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message ?? "首屏预取失败");
      return { [key]: payload?.data };
    })
    .catch((error) => ({ error }));
  if (routeView === "reader" && routeChapterId && routeChapterId.length <= 200) {
    window.__scriverseReaderChapterPrefetch = {
      chapterId: routeChapterId,
      request: prefetchData(`/api/chapters/${encodeURIComponent(routeChapterId)}`, "chapter")
    };
  }
  if (routeView === "reader" && routeWorkId && routeWorkId.length <= 200) {
    window.__scriverseReaderWorksPrefetch = {
      request: prefetchData("/api/works?page=1&limit=30", "works")
    };
    window.__scriverseReaderWorkPrefetch = {
      workId: routeWorkId,
      request: prefetchData(`/api/works/${encodeURIComponent(routeWorkId)}?directory=volumes`, "work")
    };
  }
  if (routeView === "login") {
    document.documentElement.classList.add("login-route");
  } else {
    // 会话恢复期间按目标路由预显示对应视图的骨架屏
    const pendingView = ["editor", "module", "welcome", "reader"].includes(routeView) && routeParams.get("work")
      ? routeView
      : ["settings", "platform-ai", "platform-usage", "work-audit"].includes(routeView) ? routeView : "shelf";
    document.documentElement.dataset.pendingView = pendingView;
    if (["shelf", "settings", "platform-ai", "platform-usage", "work-audit"].includes(pendingView)) {
      document.documentElement.classList.add("pending-shelf-mode");
    }
  }
})();
