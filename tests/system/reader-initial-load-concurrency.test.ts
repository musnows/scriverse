import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("阅读深链首屏请求并发", () => {
  it("会话恢复后并行加载作品列表、作品目录和目标章节", async () => {
    const application = await readFile(join(process.cwd(), "src/public/app.js"), "utf8");
    const initialization = application.slice(
      application.indexOf("async function initializePage()"),
      application.indexOf("function showShelf()")
    );

    expect(initialization).toContain("const [worksPage, requestedWorkDetail] = await Promise.all([");
    expect(initialization).toContain("const earlyReaderChapterRequest = window.__scriverseReaderChapterPrefetch;");
    expect(initialization).toContain("const earlyReaderWorksRequest = window.__scriverseReaderWorksPrefetch;");
    expect(initialization).toContain("const earlyReaderWorkRequest = window.__scriverseReaderWorkPrefetch;");
    expect(initialization).toContain("earlyReaderChapterRequest?.chapterId === route.chapterId");
    expect(initialization).toContain('api(`/api/chapters/${encodeURIComponent(route.chapterId)}`)');
    expect(initialization).toContain("initialWorkDetail = requestedWorkDetail;");
    expect(initialization).toContain("initialReaderChapterRequest = null;");
  });

  it("在模块图加载前由 head 脚本启动目标章节预取", async () => {
    const themeInit = await readFile(join(process.cwd(), "src/public/theme-init.js"), "utf8");

    expect(themeInit).toContain('if (routeView === "reader" && routeChapterId && routeChapterId.length <= 200)');
    expect(themeInit).toContain('prefetchData("/api/works?page=1&limit=30", "works")');
    expect(themeInit).toContain('prefetchData(`/api/works/${encodeURIComponent(routeWorkId)}?directory=volumes`, "work")');
    expect(themeInit).toContain("window.__scriverseReaderChapterPrefetch = {");
    expect(themeInit).toContain('prefetchData(`/api/chapters/${encodeURIComponent(routeChapterId)}`, "chapter")');
    expect(themeInit).toContain('.catch((error) => ({ error }))');
  });

  it("复用首屏请求并并行加载全部分卷目录", async () => {
    const application = await readFile(join(process.cwd(), "src/public/app.js"), "utf8");
    const workLoading = application.slice(
      application.indexOf("async function selectWork(workId, preferredChapterId = null)"),
      application.indexOf("function mergeChapterDirectoryEntry(")
    );
    const chapterLoading = application.slice(
      application.indexOf("async function loadReadingChapter("),
      application.indexOf("async function navigateReadingChapter(")
    );

    expect(workLoading).toContain("const prefetchedWork = initialWorkDetail?.id === workId ? initialWorkDetail : null;");
    expect(workLoading).toContain("const batch = volumeIds.slice(index, index + readingVolumeDirectoryConcurrency);");
    expect(workLoading).toContain("await Promise.all(batch.map(async (volumeId) => {");
    expect(chapterLoading).toContain("const prefetchedResult = initialRequest ? await initialRequest : null;");
    expect(chapterLoading).toContain('prefetchedResult?.chapter ?? await api(`/api/chapters/${encodeURIComponent(target.id)}`');
  });
});
