import { afterEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime } from "../helpers.js";

describe("story_index 目录读取", () => {
  let runtime: Runtime | null = null;

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
  });

  it("只读取当前页目录字段和当前页摘要，不加载长篇正文", () => {
    runtime = createTestRuntime();
    const work = runtime.store.createWork({ title: "长篇目录", author: "测试作者" });
    const firstVolume = runtime.store.createVolume(String(work.id), { title: "第一卷" });
    const secondVolume = runtime.store.createVolume(String(work.id), { title: "第二卷" });
    const hugeContent = "正文内容".repeat(100_000);
    const chapters = [
      runtime.store.createChapter(String(work.id), { volumeId: String(firstVolume.id), title: "第一章", content: hugeContent }),
      runtime.store.createChapter(String(work.id), { volumeId: String(firstVolume.id), title: "第二章", content: hugeContent }),
      runtime.store.createChapter(String(work.id), { volumeId: String(secondVolume.id), title: "第三章", content: hugeContent }),
      runtime.store.createChapter(String(work.id), { volumeId: String(secondVolume.id), title: "第四章", content: hugeContent })
    ];
    const timestamp = new Date().toISOString();
    for (const [index, chapter] of chapters.entries()) {
      runtime.database.run(
        `INSERT INTO chapter_insights (
           id, chapter_id, chapter_version, summary, events_json, characters_json,
           settings_json, evidence_json, uncertainties_json, status, created_at
         ) VALUES (?, ?, ?, ?, '[]', '[]', '[]', '[]', '[]', 'review', ?)`,
        `story-index-insight-${index}`,
        String(chapter.id),
        Number(chapter.versionNo),
        `第 ${index + 1} 章摘要`,
        timestamp
      );
    }
    const allSpy = vi.spyOn(runtime.database, "all");

    const page = runtime.store.getStoryIndexChapterPage(String(work.id), 1, 2);

    expect(page).toEqual({
      totalChapters: 4,
      latestChaptersByStructure: [
        {
          id: chapters[3]?.id,
          title: "第四章",
          versionNo: 1,
          storyOrder: {
            volume: { volumeId: secondVolume.id, volumeTitle: "第二卷", directoryOrder: 1, storyOrder: 1 },
            chapter: { order: 1, type: "正文", isLatestByStructure: true }
          },
          summary: "第 4 章摘要"
        }
      ],
      chapters: [
        {
          id: chapters[1]?.id,
          title: "第二章",
          versionNo: 1,
          summary: "第 2 章摘要",
          storyOrder: {
            volume: { volumeId: firstVolume.id, volumeTitle: "第一卷", directoryOrder: 0, storyOrder: 0 },
            chapter: { order: 1, type: "正文", isLatestByStructure: false }
          }
        },
        {
          id: chapters[2]?.id,
          title: "第三章",
          versionNo: 1,
          summary: "第 3 章摘要",
          storyOrder: {
            volume: { volumeId: secondVolume.id, volumeTitle: "第二卷", directoryOrder: 1, storyOrder: 1 },
            chapter: { order: 0, type: "正文", isLatestByStructure: false }
          }
        }
      ]
    });
    expect(JSON.stringify(page)).not.toContain("正文内容");

    const chapterPageCall = allSpy.mock.calls.find(([sql]) => String(sql).includes("SELECT chapter.id, chapter.title"));
    expect(chapterPageCall).toBeDefined();
    expect(String(chapterPageCall?.[0])).not.toMatch(/chapter\.content|SELECT\s+\*/iu);
    expect(chapterPageCall?.slice(1)).toEqual([work.id, 2, 1]);

    const insightCall = allSpy.mock.calls.find(([sql]) => String(sql).includes("SELECT insight.chapter_id, insight.summary"));
    expect(insightCall?.slice(1)).toEqual([work.id, chapters[1]?.id, chapters[2]?.id, chapters[3]?.id]);
    expect(insightCall?.slice(1)).not.toContain(chapters[0]?.id);
  });

  it("供 AI 查询时排除作者的话章节并保持分页总数一致", () => {
    runtime = createTestRuntime();
    const work = runtime.store.createWork({ title: "作者的话目录", author: "测试作者" });
    const volume = runtime.store.createVolume(String(work.id), { title: "第一卷" });
    runtime.store.createChapter(String(work.id), {
      volumeId: String(volume.id),
      title: "作者的话",
      chapterType: "作者的话",
      content: "作者注释不应提供给 AI。"
    });
    const chapter = runtime.store.createChapter(String(work.id), {
      volumeId: String(volume.id),
      title: "第一章",
      content: "正文目录项。"
    });

    const page = runtime.store.getStoryIndexChapterPage(String(work.id), 0, 20, { excludeAuthorNotes: true });

    expect(page.totalChapters).toBe(1);
    expect(page.latestChaptersByStructure).toEqual([
      expect.objectContaining({ id: chapter.id, title: "第一章" })
    ]);
    expect(page.chapters).toEqual([
      expect.objectContaining({ id: chapter.id, title: "第一章" })
    ]);
    expect(JSON.stringify(page)).not.toContain("作者的话");
  });

  it("按独立分卷剧情顺序分页并完整返回可比较时间线信息", () => {
    runtime = createTestRuntime();
    const work = runtime.store.createWork({ title: "倒叙目录" });
    const directoryFirst = runtime.store.createVolume(String(work.id), { title: "回忆卷", storyOrder: 8 });
    const directorySecond = runtime.store.createVolume(String(work.id), { title: "序幕卷", storyOrder: 1 });
    const laterChapter = runtime.store.createChapter(String(work.id), {
      volumeId: String(directoryFirst.id),
      title: "重返港口",
      content: "较晚剧情。"
    });
    const earlierChapter = runtime.store.createChapter(String(work.id), {
      volumeId: String(directorySecond.id),
      title: "初次离港",
      content: "较早剧情。"
    });
    const track = runtime.store.createTimelineTrack(String(work.id), { name: "主线" });
    runtime.store.createTimelineEvent(String(work.id), {
      name: "离港",
      trackId: String(track.id),
      timeLabel: "第 1 日",
      timeSort: 1,
      chapterIds: [String(earlierChapter.id)],
      status: "confirmed"
    });
    runtime.store.createTimelineEvent(String(work.id), {
      name: "返港",
      trackId: String(track.id),
      timeLabel: "第 9 日",
      timeSort: 9,
      chapterIds: [String(laterChapter.id)],
      status: "confirmed"
    });
    runtime.store.createTimelineEvent(String(work.id), {
      name: "候选事件",
      trackId: String(track.id),
      timeLabel: "待定",
      timeSort: 99,
      chapterIds: [String(laterChapter.id)],
      status: "candidate"
    });

    const page = runtime.store.getStoryIndexChapterPage(String(work.id), 0, 20, {
      excludeAuthorNotes: true,
      includeTimeline: true
    });

    expect(page.chapters.map((chapter) => chapter.id)).toEqual([earlierChapter.id, laterChapter.id]);
    expect(page.chapters[0]?.storyOrder).toMatchObject({
      volume: { volumeId: directorySecond.id, directoryOrder: 1, storyOrder: 1 },
      chapter: { order: 0, isLatestByStructure: false },
      confirmedTimelineEvents: [{ name: "离港", timeSort: 1, trackId: track.id, trackName: "主线" }]
    });
    expect(page.chapters[1]?.storyOrder).toMatchObject({
      volume: { volumeId: directoryFirst.id, directoryOrder: 0, storyOrder: 8 },
      chapter: { order: 0, isLatestByStructure: true },
      confirmedTimelineEvents: [{ name: "返港", timeSort: 9, trackId: track.id, trackName: "主线" }]
    });
    expect(page.latestChaptersByStructure).toEqual([
      expect.objectContaining({ id: laterChapter.id, title: "重返港口" })
    ]);
    expect(JSON.stringify(page)).not.toContain("候选事件");
  });

  it("首页不足以覆盖全书时仍独立返回结构最新章节", () => {
    runtime = createTestRuntime();
    const work = runtime.store.createWork({ title: "长篇分页目录" });
    const volume = runtime.store.createVolume(String(work.id), { title: "第一卷" });
    const store = runtime.store;
    const chapters = Array.from({ length: 21 }, (_, index) => store.createChapter(String(work.id), {
      volumeId: String(volume.id),
      title: `第 ${index + 1} 章`,
      content: `正文 ${index + 1}`
    }));

    const page = runtime.store.getStoryIndexChapterPage(String(work.id), 0, 20, { excludeAuthorNotes: true });

    expect(page.totalChapters).toBe(21);
    expect(page.chapters).toHaveLength(20);
    expect(page.chapters.at(-1)?.id).toBe(chapters[19]?.id);
    expect(page.latestChaptersByStructure).toEqual([
      expect.objectContaining({
        id: chapters[20]?.id,
        storyOrder: expect.objectContaining({ chapter: expect.objectContaining({ isLatestByStructure: true }) })
      })
    ]);
  });

  it("最小工具结果预算下优先分页返回结构最新章节", async () => {
    runtime = createTestRuntime();
    const work = runtime.store.createWork({ title: "小预算目录" });
    const volume = runtime.store.createVolume(String(work.id), { title: "第一卷" });
    const chapter = runtime.store.createChapter(String(work.id), {
      volumeId: String(volume.id),
      title: "最新章",
      content: "正文"
    });
    const internalAi = runtime.ai as unknown as {
      executeAgentTool: (
        workId: string,
        toolCall: Record<string, unknown>,
        maximumResultChars?: number
      ) => Promise<{ result: Record<string, unknown> }>;
    };

    const execution = await internalAi.executeAgentTool(String(work.id), {
      id: "small-budget-index",
      type: "function",
      function: { name: "story_index", arguments: {} }
    }, 1_000);

    expect(JSON.stringify(execution.result).length).toBeLessThanOrEqual(1_000);
    expect(execution.result).toMatchObject({
      ok: true,
      data: { latestChaptersByStructure: [expect.objectContaining({ id: chapter.id })] },
      pagination: { nextCursor: expect.any(Number), maxChars: 1_000 }
    });
  });

  it("区分章节翻页与结果分片，并兼容旧 offset 输入", async () => {
    runtime = createTestRuntime();
    const work = runtime.store.createWork({ title: "双层分页目录" });
    const volume = runtime.store.createVolume(String(work.id), { title: "第一卷" });
    const chapters = ["第一章", "第二章"].map((title) => runtime!.store.createChapter(String(work.id), {
      volumeId: String(volume.id),
      title,
      content: `${title}正文`
    }));
    type StoryIndexExecution = {
      arguments: Record<string, unknown>;
      result: {
        data: {
          chapterOffset: number;
          chapters: Array<{ id?: unknown }>;
          nextChapterOffset: number | null;
          continuationRule: string;
        };
        pagination: { cursor: number; nextCursor: number | null; maxChars: number };
      };
    };
    const internalAi = runtime.ai as unknown as {
      executeAgentTool: (
        workId: string,
        toolCall: Record<string, unknown>,
        maximumResultChars?: number
      ) => Promise<StoryIndexExecution>;
    };
    const readPage = (chapterOffset: number, cursor = 0, maximumResultChars = 1_000): Promise<StoryIndexExecution> => internalAi.executeAgentTool(String(work.id), {
      id: `index-${chapterOffset}-${cursor}`,
      type: "function",
      function: { name: "story_index", arguments: { chapterOffset, limit: 1, ...(cursor > 0 ? { cursor } : {}) } }
    }, maximumResultChars);

    const firstChapterIds: unknown[] = [];
    let cursor = 0;
    let finalFirstPage: StoryIndexExecution | null = null;
    for (let pageCount = 0; pageCount < 10; pageCount += 1) {
      const execution = await readPage(0, cursor, cursor === 0 ? 1_000 : 10_000);
      expect(execution.arguments).toMatchObject({ chapterOffset: 0, limit: 1 });
      expect(execution.result.data.chapterOffset).toBe(0);
      firstChapterIds.push(...execution.result.data.chapters.map((chapter) => chapter.id));
      const nextCursor = execution.result.pagination.nextCursor;
      if (nextCursor === null) {
        finalFirstPage = execution;
        break;
      }
      expect(execution.result.data.nextChapterOffset).toBeNull();
      expect(execution.result.data.continuationRule).toContain("pagination.nextCursor");
      expect(nextCursor).toBeGreaterThan(100_000);
      expect(nextCursor).toBeGreaterThan(cursor);
      cursor = nextCursor;
    }

    expect(firstChapterIds).toEqual([chapters[0]?.id]);
    expect(finalFirstPage?.result.data).toMatchObject({
      nextChapterOffset: 1,
      continuationRule: expect.stringContaining("把 cursor 重置为 0")
    });

    const secondChapterIds: unknown[] = [];
    cursor = 0;
    for (let pageCount = 0; pageCount < 10; pageCount += 1) {
      const execution = await readPage(1, cursor, cursor === 0 ? 1_000 : 10_000);
      secondChapterIds.push(...execution.result.data.chapters.map((chapter) => chapter.id));
      const nextCursor = execution.result.pagination.nextCursor;
      if (nextCursor === null) break;
      expect(nextCursor).toBeGreaterThan(100_000);
      expect(nextCursor).toBeGreaterThan(cursor);
      cursor = nextCursor;
    }
    expect(secondChapterIds).toEqual([chapters[1]?.id]);

    const legacyExecution = await internalAi.executeAgentTool(String(work.id), {
      id: "legacy-index-offset",
      type: "function",
      function: { name: "story_index", arguments: { offset: 1, limit: 1 } }
    });
    expect(legacyExecution.arguments).toEqual({ chapterOffset: 1, limit: 1 });
    expect(legacyExecution.result.data.chapterOffset).toBe(1);
  });
});
