import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Runtime } from "../../src/app.js";
import { logger } from "../../src/logger.js";
import { createTestRuntime, seedChapter } from "../helpers.js";

describe("作品混合检索", () => {
  let runtime: Runtime | null = null;

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
    vi.restoreAllMocks();
  });

  it("统一检索正文和全部知识类型并返回正文行号", async () => {
    runtime = createTestRuntime();
    const seeded = await seedChapter(runtime, "序幕开启。\n\n潮汐棱镜在北港议会发光。\n仍在发光。");
    const workId = String(seeded.work.id);
    const chapterId = String(seeded.chapter.id);
    const firstCharacter = runtime.store.createCharacter(workId, {
      name: "林舟",
      profile: { secret: "潮汐棱镜的守护者" },
      firstChapterId: chapterId
    });
    const secondCharacter = runtime.store.createCharacter(workId, { name: "岑月", firstChapterId: chapterId });
    runtime.store.createSetting(workId, { title: "北港圣物", category: "道具", content: "潮汐棱镜用于导航。" });
    runtime.store.createRace(workId, { name: "潮汐族", description: "族群佩戴潮汐棱镜。" });
    runtime.store.createOrganization(workId, { name: "北港议会", description: "负责保管潮汐棱镜。" });
    const track = runtime.store.createTimelineTrack(workId, { name: "北港纪年", description: "以潮汐棱镜为纪年基准。" });
    runtime.store.createTimelineEvent(workId, {
      name: "棱镜点亮",
      trackId: String(track.id),
      description: "潮汐棱镜第一次发光。",
      chapterIds: [chapterId]
    });
    runtime.store.createRelationship(workId, {
      fromCharacterId: String(firstCharacter.id),
      toCharacterId: String(secondCharacter.id),
      category: "social",
      subtype: "盟友",
      keywords: ["潮汐棱镜"]
    });
    runtime.store.upsertChapterOutline(chapterId, { goal: "找到潮汐棱镜", conflict: "议会阻拦" });
    runtime.store.createForeshadow(workId, { title: "棱镜裂痕", description: "潮汐棱镜存在暗纹。" });
    const review = runtime.store.createReviewItem(workId, {
      itemType: "setting-conflict",
      title: "棱镜颜色冲突",
      description: "潮汐棱镜的颜色前后不一致。"
    });

    const response = await request(runtime.app)
      .get(`/api/works/${workId}/search`)
      .query({ q: "潮汐棱镜", limit: 100 })
      .expect(200);

    expect(new Set(response.body.data.map((item: { type: string }) => item.type))).toEqual(new Set([
      "chapter",
      "setting",
      "character",
      "race",
      "organization",
      "timeline-track",
      "timeline-event",
      "relationship",
      "chapter-outline",
      "foreshadow",
      "review"
    ]));
    expect(response.body.data.find((item: { type: string }) => item.type === "chapter")).toMatchObject({
      id: chapterId,
      startLine: 3,
      endLine: 4,
      matchKinds: expect.arrayContaining(["exact"])
    });
    await request(runtime.app).get(`/api/reviews/${review.id}`).expect(200).expect((reviewResponse) => {
      expect(reviewResponse.body.data).toMatchObject({ id: review.id, workId, title: "棱镜颜色冲突" });
    });
  });

  it("支持无空格拼音、类型筛选和增量更新", async () => {
    runtime = createTestRuntime();
    const seeded = await seedChapter(runtime, "林舟抵达北港议会。\n\n港口安静。 ");
    const workId = String(seeded.work.id);
    const setting = runtime.store.createSetting(workId, {
      title: "北港制度",
      category: "规则",
      content: "北港议会遵循旧章程。"
    });

    const phonetic = await request(runtime.app)
      .get(`/api/works/${workId}/search`)
      .query({ q: "beigang", limit: 100 })
      .expect(200);
    expect(phonetic.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "chapter", matchKinds: expect.arrayContaining(["phonetic"]) }),
      expect.objectContaining({ type: "setting", id: setting.id, matchKinds: expect.arrayContaining(["phonetic"]) })
    ]));

    const filtered = await request(runtime.app)
      .get(`/api/works/${workId}/search`)
      .query({ q: "北港", type: "setting", limit: 1 })
      .expect(200);
    expect(filtered.body.data).toHaveLength(1);
    expect(filtered.body.data[0]).toMatchObject({ type: "setting", id: setting.id });

    runtime.store.updateSetting(String(setting.id), { content: "新章程改用星港通行证。" });
    const updated = await request(runtime.app)
      .get(`/api/works/${workId}/search`)
      .query({ q: "星港通行证", type: "setting" })
      .expect(200);
    expect(updated.body.data).toEqual([expect.objectContaining({ id: setting.id, type: "setting" })]);
  });

  it("实体工具只检索请求的设定库类型，不扫描正文与对话历史", async () => {
    runtime = createTestRuntime();
    const seeded = await seedChapter(runtime, "正文包含实体工具性能标记，但实体工具不应扫描正文。");
    const workId = String(seeded.work.id);
    runtime.store.createSetting(workId, {
      title: "实体工具性能标记",
      category: "规则",
      content: "只返回设定库结果。"
    });
    const search = vi.spyOn(runtime.store, "search");
    const searchWork = vi.spyOn(runtime.ai, "searchWork");
    const internalAi = runtime.ai as unknown as {
      executeAgentTool: (
        candidateWorkId: string,
        toolCall: Record<string, unknown>
      ) => Promise<Record<string, unknown>>;
    };

    const execution = await internalAi.executeAgentTool(workId, {
      id: "entity-only-search",
      type: "function",
      function: {
        name: "search_story_entities",
        arguments: JSON.stringify({ query: "实体工具性能标记", categories: ["setting", "timeline"] })
      }
    });

    expect(execution.status).toBe("completed");
    expect(search).toHaveBeenCalledWith(
      workId,
      "实体工具性能标记",
      new Set(["setting", "timeline-track", "timeline-event"])
    );
    expect(search.mock.calls[0]?.[2]).not.toContain("chapter");
    expect(search.mock.calls[0]?.[2]).not.toContain("agent-history");
    expect(searchWork).toHaveBeenCalledWith(workId, "实体工具性能标记", {
      limit: 100,
      allowedTypes: ["setting", "timeline-track", "timeline-event"],
      includePhonetic: false
    });

    await internalAi.executeAgentTool(workId, {
      id: "entity-phonetic-search",
      type: "function",
      function: {
        name: "search_story_entities",
        arguments: JSON.stringify({ query: "实体工具性能标记", categories: ["setting"], includePhonetic: true })
      }
    });
    expect(searchWork).toHaveBeenLastCalledWith(workId, "实体工具性能标记", {
      limit: 100,
      allowedTypes: ["setting"],
      includePhonetic: true
    });
  });

  it("三条正文搜索路径复用版本化行号索引并对缺失索引执行有界自修复", async () => {
    runtime = createTestRuntime();
    const longPrefix = Array.from({ length: 2_000 }, (_, index) => `铺垫行 ${index + 1}`).join("\n");
    const content = `${longPrefix}\n\n潮汐棱镜第一次发光。\n仍在发光。\n\n北港灯塔。\n\n北港备用航线。`;
    const seeded = await seedChapter(runtime, content);
    const workId = String(seeded.work.id);
    const chapterId = String(seeded.chapter.id);
    const allSpy = vi.spyOn(runtime.store.db, "all");
    const getSpy = vi.spyOn(runtime.store.db, "get");

    const fullText = await request(runtime.app)
      .get(`/api/works/${workId}/search`)
      .query({ q: "潮汐棱镜", type: "chapter" })
      .expect(200);
    const shortText = await request(runtime.app)
      .get(`/api/works/${workId}/search`)
      .query({ q: "北港", type: "chapter" })
      .expect(200);
    const phonetic = await request(runtime.app)
      .get(`/api/works/${workId}/search`)
      .query({ q: "beigang", type: "chapter" })
      .expect(200);

    expect(fullText.body.data).toEqual([
      expect.objectContaining({ id: chapterId, startLine: 2_002, endLine: 2_003 })
    ]);
    expect(shortText.body.data).toEqual([
      expect.objectContaining({ id: chapterId, startLine: 2_005, endLine: 2_005 })
    ]);
    expect(phonetic.body.data).toEqual([
      expect.objectContaining({ id: chapterId, startLine: 2_005, endLine: 2_005, matchKinds: ["phonetic"] })
    ]);
    expect(shortText.body.data).toHaveLength(1);
    const observedSql = [...allSpy.mock.calls, ...getSpy.mock.calls].map(([sql]) => String(sql));
    expect(observedSql.some((sql) => sql.includes("chapter.content AS chapter_content"))).toBe(false);
    expect(observedSql.some((sql) => sql.includes("SELECT content, version_no FROM chapters"))).toBe(false);

    const targetParagraph = runtime.store.db.get<{ id: number }>(
      "SELECT id FROM chapter_paragraph_search WHERE chapter_id = ? AND content LIKE ?",
      chapterId,
      "%潮汐棱镜%"
    );
    expect(targetParagraph).toBeDefined();
    runtime.store.db.run("DELETE FROM chapter_paragraph_line_ranges WHERE paragraph_id = ?", Number(targetParagraph?.id));
    getSpy.mockClear();
    const repaired = await request(runtime.app)
      .get(`/api/works/${workId}/search`)
      .query({ q: "潮汐棱镜", type: "chapter" })
      .expect(200);
    expect(repaired.body.data).toEqual([
      expect.objectContaining({ id: chapterId, startLine: 2_002, endLine: 2_003 })
    ]);
    expect(getSpy.mock.calls.filter(([sql]) => String(sql).includes("SELECT content, version_no FROM chapters"))).toHaveLength(1);
    expect(runtime.store.db.get(
      "SELECT start_line, end_line FROM chapter_paragraph_line_ranges WHERE paragraph_id = ?",
      Number(targetParagraph?.id)
    )).toEqual({ start_line: 2_002, end_line: 2_003 });

    const secondVolume = runtime.store.createVolume(workId, { title: "第二卷" });
    const moved = runtime.store.moveChapter(chapterId, { volumeId: String(secondVolume.id), sortOrder: 0 });
    expect(runtime.store.db.get(
      `SELECT COUNT(*) AS count FROM chapter_paragraph_line_ranges line_range
       JOIN chapter_paragraph_search paragraph ON paragraph.id = line_range.paragraph_id
       WHERE paragraph.chapter_id = ? AND line_range.chapter_version <> ?`,
      chapterId,
      Number(moved.versionNo)
    )).toEqual({ count: 0 });

    runtime.store.db.run(
      "UPDATE chapters SET content = ?, version_no = version_no + 1 WHERE id = ?",
      "当前正文已经替换，不应命中旧索引。",
      chapterId
    );
    const stale = await request(runtime.app)
      .get(`/api/works/${workId}/search`)
      .query({ q: "潮汐棱镜", type: "chapter" })
      .expect(200);
    expect(stale.body.data).toEqual([]);
  });

  it("旧索引回退验证超过二十个候选并按章节复用正文解析", async () => {
    runtime = createTestRuntime();
    const seeded = await seedChapter(runtime, "超过上限验证正文。");
    const workId = String(seeded.work.id);
    const volumeId = String(seeded.volume.id);
    for (let index = 2; index <= 25; index += 1) {
      runtime.store.createChapter(workId, {
        volumeId,
        title: `第 ${index} 章`,
        content: "超过上限验证正文。"
      });
    }
    runtime.store.db.run(
      `UPDATE chapter_paragraph_line_ranges SET chapter_version = chapter_version + 1
       WHERE paragraph_id IN (SELECT id FROM chapter_paragraph_search WHERE work_id = ?)`,
      workId
    );
    const getSpy = vi.spyOn(runtime.store.db, "get");
    const infoSpy = vi.spyOn(logger, "info");

    const response = await request(runtime.app)
      .get(`/api/works/${workId}/search`)
      .query({ q: "超过上限验证", type: "chapter", limit: 50 })
      .expect(200);

    expect(response.body.data).toHaveLength(25);
    expect(response.body.data.every((item: { startLine?: number; endLine?: number }) => item.startLine === 1 && item.endLine === 1)).toBe(true);
    expect(getSpy.mock.calls.filter(([sql]) => String(sql).includes("SELECT content, version_no FROM chapters"))).toHaveLength(25);
    expect(runtime.store.db.get(
      `SELECT COUNT(*) AS count FROM chapter_paragraph_line_ranges line_range
       JOIN chapter_paragraph_search paragraph ON paragraph.id = line_range.paragraph_id
       JOIN chapters chapter ON chapter.id = paragraph.chapter_id
       WHERE paragraph.work_id = ? AND line_range.chapter_version <> chapter.version_no`,
      workId
    )).toEqual({ count: 0 });
    const fallbackLog = infoSpy.mock.calls.find(([event]) => event === "search.chapter_line_range_fallback");
    expect(fallbackLog?.[1]).toMatchObject({
      attemptedCandidates: 25,
      chapterLoads: 25,
      repairedCandidates: 25,
      paragraphContentMismatches: 0
    });
    expect(JSON.stringify(fallbackLog)).not.toContain("超过上限验证正文");
  });

  it("同章重复回退只读取正文一次并记录不含正文的失败计数", async () => {
    runtime = createTestRuntime();
    const seeded = await seedChapter(runtime, "缓存命中当前第一段。\n\n缓存命中当前第二段。");
    const workId = String(seeded.work.id);
    const chapterId = String(seeded.chapter.id);
    const paragraphs = runtime.store.db.all<{ id: number; paragraph_order: number }>(
      "SELECT id, paragraph_order FROM chapter_paragraph_search WHERE chapter_id = ? ORDER BY paragraph_order",
      chapterId
    );
    runtime.store.db.run(
      "UPDATE chapter_paragraph_search SET content = ?, search_content = ? WHERE id = ?",
      "缓存命中过期第一段。",
      "缓存命中过期第一段。",
      paragraphs[0]?.id ?? 0
    );
    runtime.store.db.run(
      `DELETE FROM chapter_paragraph_line_ranges
       WHERE paragraph_id IN (SELECT id FROM chapter_paragraph_search WHERE chapter_id = ?)`,
      chapterId
    );
    const getSpy = vi.spyOn(runtime.store.db, "get");
    const warnSpy = vi.spyOn(logger, "warn");

    const response = await request(runtime.app)
      .get(`/api/works/${workId}/search`)
      .query({ q: "缓存命中", type: "chapter" })
      .expect(200);

    expect(response.body.data).toEqual([
      expect.objectContaining({ id: chapterId, startLine: 3, endLine: 3, snippet: "缓存命中当前第二段。" })
    ]);
    expect(getSpy.mock.calls.filter(([sql]) => String(sql).includes("SELECT content, version_no FROM chapters"))).toHaveLength(1);
    expect(runtime.store.db.get(
      `SELECT COUNT(*) AS count FROM chapter_paragraph_line_ranges line_range
       JOIN chapter_paragraph_search paragraph ON paragraph.id = line_range.paragraph_id
       WHERE paragraph.chapter_id = ?`,
      chapterId
    )).toEqual({ count: 1 });
    const fallbackLog = warnSpy.mock.calls.find(([event]) => event === "search.chapter_line_range_fallback");
    expect(fallbackLog?.[1]).toMatchObject({
      chapterLoads: 1,
      repairedCandidates: 1,
      paragraphContentMismatches: expect.any(Number)
    });
    expect(Number(fallbackLog?.[1]?.paragraphContentMismatches)).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(fallbackLog)).not.toContain("缓存命中过期第一段");
    expect(JSON.stringify(fallbackLog)).not.toContain("缓存命中当前第二段");
  });

  it("通过增量全文索引检索 Agent history，并支持短词和标题更新", async () => {
    runtime = createTestRuntime();
    const seeded = await seedChapter(runtime, "正文记录了跃迁冷却规则，作者后来继续追问。 ");
    const workId = String(seeded.work.id);
    const conversation = runtime.store.createAiConversation(workId, "跃迁规则讨论");
    const userMessage = runtime.store.addAiConversationMessage(String(conversation.id), {
      role: "user",
      content: "请记住跃迁冷却规则。"
    });
    runtime.store.addAiConversationMessage(String(conversation.id), {
      role: "assistant",
      content: "已记录跃迁冷却规则，后续会继续遵守。"
    });

    const fullText = await request(runtime.app)
      .get(`/api/works/${workId}/search`)
      .query({ q: "跃迁冷却", limit: 100 })
      .expect(200);
    const historyResults = fullText.body.data.filter((item: { type: string }) => item.type === "agent-history");
    expect(historyResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: userMessage.id,
        type: "agent-history",
        conversationId: conversation.id,
        messageId: userMessage.id,
        matchKinds: expect.arrayContaining(["exact"])
      })
    ]));
    expect(fullText.body.data.some((item: { type: string }) => item.type === "chapter")).toBe(true);
    expect(runtime.store.db.get("SELECT COUNT(*) AS count FROM ai_history_search")?.count).toBe(3);
    expect(runtime.store.db.get("SELECT COUNT(*) AS count FROM ai_history_search_fts")?.count).toBe(3);

    const shortText = await request(runtime.app)
      .get(`/api/works/${workId}/search`)
      .query({ q: "跃迁", type: "agent-history" })
      .expect(200);
    expect(shortText.body.data.length).toBeGreaterThanOrEqual(2);
    expect(shortText.body.data.every((item: { type: string }) => item.type === "agent-history")).toBe(true);

    runtime.store.setAiConversationTitle(String(conversation.id), "星门校准讨论");
    const renamed = await request(runtime.app)
      .get(`/api/works/${workId}/search`)
      .query({ q: "星门校准", type: "agent-history" })
      .expect(200);
    expect(renamed.body.data).toEqual([
      expect.objectContaining({
        id: conversation.id,
        type: "agent-history",
        conversationId: conversation.id
      })
    ]);
  });

  it("从搜索结果打开超过首屏的历史消息时定位到对应分页", async () => {
    runtime = createTestRuntime();
    const seeded = await seedChapter(runtime);
    const workId = String(seeded.work.id);
    const conversation = runtime.store.createAiConversation(workId);
    const firstMessage = runtime.store.addAiConversationMessage(String(conversation.id), {
      role: "user",
      content: "超长历史定位标记"
    });
    for (let index = 0; index < 101; index += 1) {
      runtime.store.addAiConversationMessage(String(conversation.id), {
        role: index % 2 === 0 ? "assistant" : "user",
        content: `历史分页消息 ${index}`
      });
    }

    const search = await request(runtime.app)
      .get(`/api/works/${workId}/search`)
      .query({ q: "超长历史定位标记", type: "agent-history" })
      .expect(200);
    const result = search.body.data.find((item: { messageId?: string }) => item.messageId === firstMessage.id);
    expect(result).toMatchObject({ type: "agent-history", conversationId: conversation.id, messageId: firstMessage.id });

    const focusedPage = await request(runtime.app)
      .get(`/api/ai-conversations/${conversation.id}?page=1&limit=100&messageId=${encodeURIComponent(String(firstMessage.id))}`)
      .expect(200);
    expect(focusedPage.body.data.messagesPage.page).toBe(2);
    expect(focusedPage.body.data.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: firstMessage.id, content: "超长历史定位标记" })
    ]));
  });

  it("搜索和 Agent 实体工具不返回已合并角色", async () => {
    runtime = createTestRuntime();
    const seeded = await seedChapter(runtime, "马克博士曾经守护北港。马克·罗素接替了他。 ");
    const workId = String(seeded.work.id);
    const source = runtime.store.createCharacter(workId, { name: "马克博士", gender: "male", isDead: true });
    const target = runtime.store.createCharacter(workId, { name: "马克·罗素", gender: "female" });
    runtime.store.createCharacterProfileSection(String(source.id), {
      sectionType: "background",
      title: "旧身份",
      contentMarkdown: "马克博士曾经守护北港。"
    });
    runtime.store.mergeCharacters({
      reviewId: null,
      sourceCharacterId: String(source.id),
      targetCharacterId: String(target.id),
      expectedSourceVersionNo: Number(source.versionNo),
      expectedTargetVersionNo: Number(target.versionNo)
    });

    const metadataResults = runtime.store.search(workId, "马克博士");
    expect(metadataResults).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "character", id: source.id })
    ]));
    expect(metadataResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "character", id: target.id, title: "马克·罗素", gender: "female", isDead: false })
    ]));
    const sectionResults = runtime.store.searchCharacterProfileSections(workId, "旧身份");
    expect(sectionResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ characterId: target.id, characterName: "马克·罗素", gender: "female", isDead: false })
    ]));
    expect(sectionResults).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ characterId: source.id })
    ]));

    const response = await request(runtime.app)
      .get(`/api/works/${workId}/search`)
      .query({ q: "马克博士", type: "character", limit: 100 })
      .expect(200);
    expect(response.body.data).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "character", id: source.id })
    ]));
    expect(response.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "character", id: target.id, title: "马克·罗素" })
    ]));

    const internalAi = runtime.ai as unknown as {
      executeAgentTool: (
        candidateWorkId: string,
        toolCall: Record<string, unknown>,
        maximumResultChars?: number,
        roleplayCharacterId?: string | null,
        allowedToolIds?: ReadonlySet<string>
      ) => Promise<Record<string, unknown>>;
    };
    const execution = await internalAi.executeAgentTool(workId, {
      id: "search-merged-character",
      type: "function",
      function: {
        name: "search_story_entities",
        arguments: JSON.stringify({ query: "马克博士", categories: ["character"], limit: 30, cursor: 0 })
      }
    });
    const result = execution.result as Record<string, unknown>;
    const resultData = result.data as Record<string, unknown>;
    const matches = resultData.matches as Array<Record<string, unknown>>;
    expect(execution.status).toBe("completed");
    expect(matches).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "character", id: source.id })
    ]));
    expect(matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "character", id: target.id, title: "马克·罗素", gender: "female" })
    ]));

    const relationshipExecution = await internalAi.executeAgentTool(workId, {
      id: "recall-merged-character",
      type: "function",
      function: {
        name: "recall_relationship",
        arguments: JSON.stringify({ characters: [source.id], cursor: 0 })
      }
    }, 20_000, String(target.id), new Set(["recall_relationship"]));
    const relationshipResult = relationshipExecution.result as Record<string, unknown>;
    const relationshipData = relationshipResult.data as Record<string, unknown>;
    expect(relationshipExecution.status).toBe("completed");
    expect(relationshipData.unresolvedCharacters).toEqual([source.id]);
  });

  it("资料段落搜索复用角色联表状态且不逐段查询角色详情", async () => {
    runtime = createTestRuntime();
    const seeded = await seedChapter(runtime);
    const workId = String(seeded.work.id);
    const deadCharacter = runtime.store.createCharacter(workId, { name: "岑夜", gender: "male", isDead: true });
    const livingCharacter = runtime.store.createCharacter(workId, { name: "林昼", gender: "female" });
    const firstDeadSection = runtime.store.createCharacterProfileSection(String(deadCharacter.id), {
      sectionType: "background",
      title: "星轨密令上篇",
      contentMarkdown: "星轨密令刻在北港旧碑上。"
    });
    const secondDeadSection = runtime.store.createCharacterProfileSection(String(deadCharacter.id), {
      sectionType: "experience",
      title: "星轨密令下篇",
      contentMarkdown: "岑夜曾经守护星轨密令。"
    });
    const livingSection = runtime.store.createCharacterProfileSection(String(livingCharacter.id), {
      sectionType: "ability",
      title: "星轨密令解读",
      contentMarkdown: "林昼能够解读星轨密令。"
    });
    const databaseGet = vi.spyOn(runtime.store.db, "get");

    const fullTextSections = runtime.store.searchCharacterProfileSections(workId, "星轨密令");
    expect(fullTextSections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: firstDeadSection.id,
        characterId: deadCharacter.id,
        characterName: "岑夜",
        title: "星轨密令上篇",
        gender: "male",
        isDead: true
      }),
      expect.objectContaining({ id: secondDeadSection.id, characterId: deadCharacter.id, gender: "male", isDead: true }),
      expect.objectContaining({ id: livingSection.id, characterId: livingCharacter.id, gender: "female", isDead: false })
    ]));

    const fullTextResults = runtime.store.search(workId, "星轨密令")
      .filter((item) => typeof item.sectionId === "string");
    expect(fullTextResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sectionId: firstDeadSection.id,
        title: "岑夜 / 星轨密令上篇",
        snippet: expect.stringContaining("星轨密令"),
        gender: "male",
        isDead: true
      }),
      expect.objectContaining({ sectionId: secondDeadSection.id, gender: "male", isDead: true }),
      expect.objectContaining({ sectionId: livingSection.id, gender: "female", isDead: false })
    ]));

    const shortTermResults = runtime.store.search(workId, "星轨")
      .filter((item) => typeof item.sectionId === "string");
    expect(shortTermResults).toHaveLength(3);
    expect(databaseGet.mock.calls.filter(([sql]) => sql === "SELECT * FROM characters WHERE id = ?")).toHaveLength(0);
  });

  it("限制查询长度并按字面量搜索 LIKE 特殊字符", async () => {
    runtime = createTestRuntime();
    const seeded = await seedChapter(runtime);
    const workId = String(seeded.work.id);
    const backslash = runtime.store.createSetting(workId, { title: String.raw`路径 a\b`, category: "测试", content: "" });
    runtime.store.createSetting(workId, { title: "路径 ab", category: "测试", content: "" });
    const combined = runtime.store.createSetting(workId, { title: String.raw`组合 \%_`, category: "测试", content: "" });
    runtime.store.createSetting(workId, { title: String.raw`组合 \任意_`, category: "测试", content: "" });

    const literalBackslash = await request(runtime.app)
      .get(`/api/works/${workId}/search`)
      .query({ q: String.raw`a\b`, type: "setting" })
      .expect(200);
    expect(literalBackslash.body.data.map((item: { id: string }) => item.id)).toEqual([backslash.id]);

    const literalCombination = await request(runtime.app)
      .get(`/api/works/${workId}/search`)
      .query({ q: String.raw`\%_`, type: "setting" })
      .expect(200);
    expect(literalCombination.body.data.map((item: { id: string }) => item.id)).toEqual([combined.id]);

    await request(runtime.app)
      .get(`/api/works/${workId}/search`)
      .query({ q: "\n北港\n" })
      .expect(200);
    await request(runtime.app)
      .get(`/api/works/${workId}/search`)
      .query({ q: "界".repeat(100) })
      .expect(200);
    const overlong = await request(runtime.app)
      .get(`/api/works/${workId}/search`)
      .query({ q: "界".repeat(101) })
      .expect(400);
    expect(overlong.body.error.code).toBe("VALIDATION_ERROR");
    const empty = await request(runtime.app)
      .get(`/api/works/${workId}/search`)
      .query({ q: "\n \n" })
      .expect(400);
    expect(empty.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("拒绝未知类型和越界数量", async () => {
    runtime = createTestRuntime();
    const seeded = await seedChapter(runtime);
    const workId = String(seeded.work.id);
    await request(runtime.app).get(`/api/works/${workId}/search`).query({ q: "北港", type: "unknown" }).expect(400);
    await request(runtime.app).get(`/api/works/${workId}/search`).query({ q: "北港", limit: 101 }).expect(400);
  });
});
