import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const application = readFileSync("src/public/app.js", "utf8");
const source = application.slice(application.indexOf("async function applyAcceptedWritingSuggestion("), application.indexOf("function attachWritingSuggestion("));
const saved = { id: "chapter-a", workId: "work-a", title: "Chapter A", content: "Accepted A", versionNo: 2 };

function fixture(chapterId = "chapter-a") {
  const state = { work: { id: "work-a" }, chapter: { ...saved, id: chapterId, content: "Original", versionNo: 1 }, dirty: false };
  const title = { value: chapterId === "chapter-a" ? "Chapter A" : "Chapter B" };
  const content = { value: "Original" };
  const actions = { innerHTML: "" };
  const api = vi.fn(async (path: string) => path.endsWith("/accept") ? { chapter: saved } : { id: "work-a" });
  const cancelChapterAutoSave = vi.fn();
  const context = { state, api, chapterSaveInFlight: null, chapterSaveGuardInFlight: null, lastSavedChapterSnapshot: null, $: (selector: string) => selector === "#chapter-title" ? title : content, resetChapterDraftLineIds: vi.fn(), scheduleChapterLineNumbers: vi.fn(), updateChapterStats: vi.fn(), renderTree: vi.fn(), toast: vi.fn(), cancelChapterAutoSave };
  const accept = runInNewContext(`${source}\napplyAcceptedWritingSuggestion`, context) as (message: unknown, suggestion: unknown) => Promise<void>;
  const run = () => accept({ querySelector: () => actions }, { id: "suggestion", workId: "work-a", chapterId: "chapter-a" });
  return { state, title, content, api, context, cancelChapterAutoSave, run };
}

describe("采纳建议时保护当前正文编辑器", () => {
  it("更新相同章节的完整编辑器快照并取消旧自动保存", async () => {
    const f = fixture();
    await f.run();
    expect(f.state.chapter).toEqual(saved);
    expect(f.title.value).toBe("Chapter A");
    expect(f.content.value).toBe("Accepted A");
    expect(f.cancelChapterAutoSave).toHaveBeenCalledOnce();
  });

  it("采纳其他章节建议时保留当前章节、草稿和自动保存", async () => {
    const f = fixture("chapter-b");
    f.state.dirty = true;
    f.content.value = "Unsaved B";
    await f.run();
    expect(f.state.chapter.id).toBe("chapter-b");
    expect(f.content.value).toBe("Unsaved B");
    expect(f.title.value).toBe("Chapter B");
    expect(f.state.dirty).toBe(true);
    expect(f.cancelChapterAutoSave).not.toHaveBeenCalled();
  });

  it("当前章节有草稿时在请求发送前拒绝采纳", async () => {
    const f = fixture();
    f.state.dirty = true;
    await expect(f.run()).rejects.toThrow("未保存修改");
    expect(f.api).not.toHaveBeenCalled();
  });

  it("等待响应时新输入的草稿不会被覆盖", async () => {
    const f = fixture();
    f.api.mockImplementation(async (path: string) => {
      if (path.endsWith("/accept")) {
        f.state.dirty = true;
        f.content.value = "Typed while waiting";
        return { chapter: saved };
      }
      return { id: "work-a" };
    });
    await f.run();
    expect(f.content.value).toBe("Typed while waiting");
    expect(f.state.chapter.versionNo).toBe(1);
    expect(f.cancelChapterAutoSave).not.toHaveBeenCalled();
  });

  it("请求过程中切换作品后不会更新新作品或请求错误作品的目录", async () => {
    const f = fixture();
    f.api.mockImplementation(async () => {
      f.state.work = { id: "work-b" };
      f.state.chapter = { ...saved, id: "chapter-b", workId: "work-b" };
      return { chapter: saved };
    });
    await f.run();
    expect(f.state.work.id).toBe("work-b");
    expect(f.state.chapter.id).toBe("chapter-b");
    expect(f.api).toHaveBeenCalledTimes(1);
    expect(f.context.renderTree).not.toHaveBeenCalled();
  });
});
