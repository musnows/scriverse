import request from "supertest";
import JSZip from "jszip";
import { buffer } from "node:stream/consumers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../src/app.js";
import { chapterAnnotationLineHashes } from "../../src/chapter-annotation-anchor.js";
import { createTestRuntime } from "../helpers.js";

describe("作品、导入和章节版本 API", () => {
  let runtime: Runtime;

  beforeEach(() => { runtime = createTestRuntime(); });
  afterEach(() => runtime.close());

  it("完成作品创建、TXT 导入、保存、增量失效和版本恢复", async () => {
    const created = await request(runtime.app).post("/api/works").send({ title: "星际纪元", author: "M" }).expect(201);
    const workId = created.body.data.id;
    const imported = await request(runtime.app)
      .post(`/api/works/${workId}/import`)
      .attach("file", Buffer.from("第一卷 启航\n第一章 信号\n林舟收到信号。\n第二章 离港\n飞船离开北港。\n第二卷 深空\n第三章 遭遇\n警报响起。"), "novel.txt")
      .expect(201);

    expect(imported.body.data.tree.volumes).toHaveLength(2);
    const chapter = imported.body.data.tree.volumes[0].chapters[0];
    expect(chapter.versionNo).toBe(1);
    expect(chapter).not.toHaveProperty("content");
    expect(JSON.stringify(imported.body)).not.toContain("林舟收到信号。");

    vi.useFakeTimers();
    try {
      const saved = await request(runtime.app)
        .patch(`/api/chapters/${chapter.id}`)
        .send({ content: "林舟收到来自深空的信号。" })
        .expect(200);
      expect(saved.body.data).toMatchObject({ versionNo: 2, analysisStatus: "expired" });

      await request(runtime.app)
        .patch(`/api/chapters/${chapter.id}`)
        .send({ content: "林舟收到来自深空的求救信号。", source: "auto" })
        .expect(200);

      const versions = await request(runtime.app).get(`/api/chapters/${chapter.id}/versions`).expect(200);
      expect(versions.body.data.map((item: { versionNo: number }) => item.versionNo)).toEqual([3, 2, 1]);
      expect(versions.body.data[0].source).toBe("auto");

      expect((await request(runtime.app).get(`/api/works/${workId}/tasks`).expect(200)).body.data.items).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(120_000);

      const tasks = await request(runtime.app).get(`/api/works/${workId}/tasks`).expect(200);
      expect(tasks.body.data.items).toHaveLength(1);
      expect(tasks.body.data.items[0]).toMatchObject({ status: "pending" });
      expect(tasks.body.data.items[0]).not.toHaveProperty("sourceVersions");
      const task = await request(runtime.app).get(`/api/tasks/${tasks.body.data.items[0].id}`).expect(200);
      expect(task.body.data).toMatchObject({ status: "pending", sourceVersions: { [chapter.id]: 3 } });
    } finally {
      vi.useRealTimers();
    }

    const restored = await request(runtime.app).post(`/api/chapters/${chapter.id}/restore`).send({ versionNo: 1 }).expect(200);
    expect(restored.body.data).toMatchObject({ content: "林舟收到信号。", versionNo: 4 });
  });

  it("无卷标题导入维持默认卷，并拒绝不支持文件", async () => {
    const created = await request(runtime.app).post("/api/works").send({ title: "无卷作品" }).expect(201);
    const workId = created.body.data.id;
    const imported = await request(runtime.app)
      .post(`/api/works/${workId}/import`)
      .attach("file", Buffer.from("第一章 开始\n正文。\n第二章 继续\n后续。"), "novel.txt")
      .expect(201);
    expect(imported.body.data.tree.volumes).toHaveLength(1);
    expect(imported.body.data.tree.volumes[0]).toMatchObject({ title: "正文", source: "default" });
    expect(imported.body.data.tree.volumes[0].chapters[0]).not.toHaveProperty("content");
    expect(imported.body.data.warnings[0]).toContain("默认卷");

    await request(runtime.app)
      .post(`/api/works/${workId}/import`)
      .attach("file", Buffer.from("invalid"), "novel.pdf")
      .expect(415);
  });

  it("按选择追加或覆盖已有作品正文", async () => {
    const created = await request(runtime.app).post("/api/works").send({ title: "导入方式作品" }).expect(201);
    const workId = created.body.data.id;
    const initial = await request(runtime.app)
      .post(`/api/works/${workId}/import`)
      .field("mode", "overwrite")
      .field("expectedVersionNo", "1")
      .attach("file", Buffer.from("第一卷 旧篇\n第一章 旧章\n旧正文。"), "old.txt")
      .expect(201);
    expect(initial.body.data.tree.versionNo).toBe(2);
    const oldChapterId = initial.body.data.firstImportedChapterId;

    const appended = await request(runtime.app)
      .post(`/api/works/${workId}/import`)
      .field("mode", "append")
      .field("expectedVersionNo", "2")
      .attach("file", Buffer.from("第二卷 新篇\n第二章 新章\n新正文。"), "append.txt")
      .expect(201);
    expect(appended.body.data).toMatchObject({ mode: "append" });
    expect(appended.body.data.tree.versionNo).toBe(3);
    expect(appended.body.data.tree.volumes.map((volume: { title: string }) => volume.title)).toEqual(["第一卷 旧篇", "第二卷 新篇"]);
    await request(runtime.app).get(`/api/chapters/${oldChapterId}`).expect(200);
    const appendedChapter = await request(runtime.app).get(`/api/chapters/${appended.body.data.firstImportedChapterId}`).expect(200);
    expect(appendedChapter.body.data.content).toBe("新正文。");

    const overwritten = await request(runtime.app)
      .post(`/api/works/${workId}/import`)
      .field("mode", "overwrite")
      .field("expectedVersionNo", "3")
      .attach("file", Buffer.from("第三卷 终篇\n第三章 终章\n最终正文。"), "overwrite.txt")
      .expect(201);
    expect(overwritten.body.data).toMatchObject({ mode: "overwrite" });
    expect(overwritten.body.data.tree.versionNo).toBe(4);
    expect(overwritten.body.data.tree.volumes.map((volume: { title: string }) => volume.title)).toEqual(["第三卷 终篇"]);
    await request(runtime.app).get(`/api/chapters/${oldChapterId}`).expect(404);

    await request(runtime.app)
      .post(`/api/works/${workId}/import`)
      .field("mode", "append")
      .field("expectedVersionNo", "3")
      .attach("file", Buffer.from("第四卷 过期导入\n第四章 不应写入\n正文。"), "stale.txt")
      .expect(409);
    const unchanged = await request(runtime.app).get(`/api/works/${workId}`).expect(200);
    expect(unchanged.body.data.volumes.map((volume: { title: string }) => volume.title)).toEqual(["第三卷 终篇"]);
  });

  it("拒绝未知的已有作品导入方式", async () => {
    const created = await request(runtime.app).post("/api/works").send({ title: "导入方式校验" }).expect(201);
    await request(runtime.app)
      .post(`/api/works/${created.body.data.id}/import`)
      .field("mode", "merge")
      .attach("file", Buffer.from("第一章 无效导入\n正文。"), "invalid-mode.txt")
      .expect(400);
    const unchanged = await request(runtime.app).get(`/api/works/${created.body.data.id}`).expect(200);
    expect(unchanged.body.data.volumes).toHaveLength(0);
  });

  it("拒绝伪装成 DOCX 的普通文件，且不创建或覆盖作品", async () => {
    const before = await request(runtime.app).get("/api/works").expect(200);
    const createResponse = await request(runtime.app)
      .post("/api/works/import")
      .attach("file", Buffer.from("普通文本改成了 docx 后缀"), "fake.docx")
      .expect(415);
    expect(createResponse.body.error.code).toBe("INVALID_DOCX_FILE");
    const after = await request(runtime.app).get("/api/works").expect(200);
    expect(after.body.data).toHaveLength(before.body.data.length);

    const disguisedZip = new JSZip();
    disguisedZip.file("[Content_Types].xml", "普通内容");
    disguisedZip.file("_rels/.rels", "普通内容");
    disguisedZip.file("word/document.xml", "普通内容");
    const disguisedResponse = await request(runtime.app)
      .post("/api/works/import")
      .attach("file", await disguisedZip.generateAsync({ type: "nodebuffer" }), "disguised.docx")
      .expect(415);
    expect(disguisedResponse.body.error.code).toBe("INVALID_DOCX_FILE");

    const work = await request(runtime.app).post("/api/works").send({ title: "不可覆盖作品" }).expect(201);
    const importResponse = await request(runtime.app)
      .post(`/api/works/${work.body.data.id}/import`)
      .attach("file", Buffer.from("这同样不是 DOCX"), "fake.docx")
      .expect(415);
    expect(importResponse.body.error.code).toBe("INVALID_DOCX_FILE");
    const unchanged = await request(runtime.app).get(`/api/works/${work.body.data.id}`).expect(200);
    expect(unchanged.body.data.volumes).toHaveLength(0);
  });

  it("拒绝非 UTF-8 编码的 TXT，且不创建或覆盖作品", async () => {
    const gbkText = Buffer.from([0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2]);
    const before = await request(runtime.app).get("/api/works").expect(200);
    const createResponse = await request(runtime.app)
      .post("/api/works/import")
      .attach("file", gbkText, "gbk.txt")
      .expect(415);
    expect(createResponse.body.error.code).toBe("INVALID_TEXT_ENCODING");
    const after = await request(runtime.app).get("/api/works").expect(200);
    expect(after.body.data).toHaveLength(before.body.data.length);

    const work = await request(runtime.app).post("/api/works").send({ title: "UTF-8 作品" }).expect(201);
    const importResponse = await request(runtime.app)
      .post(`/api/works/${work.body.data.id}/import`)
      .attach("file", gbkText, "gbk.txt")
      .expect(415);
    expect(importResponse.body.error.code).toBe("INVALID_TEXT_ENCODING");
    const unchanged = await request(runtime.app).get(`/api/works/${work.body.data.id}`).expect(200);
    expect(unchanged.body.data.volumes).toHaveLength(0);
  });

  it("创建和保存章节时保留用户输入的连续空行", async () => {
    const work = await request(runtime.app).post("/api/works").send({ title: "空行规则作品" }).expect(201);
    const volume = await request(runtime.app).post(`/api/works/${work.body.data.id}/volumes`).send({ title: "正文" }).expect(201);
    const chapter = await request(runtime.app).post(`/api/works/${work.body.data.id}/chapters`).send({
      volumeId: volume.body.data.id,
      title: "第一章",
      content: "\n\n第一段。\n\n\n\n第二段。\n\n"
    }).expect(201);
    expect(chapter.body.data.content).toBe("\n\n第一段。\n\n\n\n第二段。\n\n");

    const saved = await request(runtime.app).patch(`/api/chapters/${chapter.body.data.id}`).send({
      content: "第一段。\n　\n\t\n\n第二段。"
    }).expect(200);
    expect(saved.body.data.content).toBe("第一段。\n　\n\t\n\n第二段。");
  });

  it("创建章节时章节、版本基线与审计在同一事务中提交", async () => {
    const work = await request(runtime.app).post("/api/works").send({ title: "章节事务作品" }).expect(201);
    const workId = work.body.data.id as string;
    const volume = await request(runtime.app).post(`/api/works/${workId}/volumes`).send({ title: "正文" }).expect(201);
    const chapter = await request(runtime.app).post(`/api/works/${workId}/chapters`).send({
      volumeId: volume.body.data.id,
      title: "第一章",
      content: "事务正文。"
    }).expect(201);
    const chapterId = chapter.body.data.id as string;
    expect(chapter.body.data.versionNo).toBe(1);
    expect(runtime.database.get(
      "SELECT version_no, source FROM chapter_versions WHERE chapter_id = ? AND version_no = 1",
      chapterId
    )).toMatchObject({ version_no: 1, source: "manual" });
    expect(runtime.database.get(
      "SELECT action FROM audit_logs WHERE work_id = ? AND entity_id = ? AND action = 'chapter.created'",
      workId,
      chapterId
    )).toEqual({ action: "chapter.created" });
  });

  it("创建章节中途失败时回滚章节与版本写入", () => {
    const work = runtime.store.createWork({ title: "章节回滚作品" });
    const volume = runtime.store.createVolume(String(work.id), { title: "卷一" });
    const originalAudit = runtime.store.audit.bind(runtime.store);
    runtime.store.audit = () => {
      throw new Error("forced audit failure");
    };
    try {
      expect(() => runtime.store.createChapter(String(work.id), {
        volumeId: String(volume.id),
        title: "失败章",
        content: "不应保留"
      })).toThrow(/forced audit failure/u);
    } finally {
      runtime.store.audit = originalAudit;
    }
    expect(runtime.database.get(
      "SELECT COUNT(*) AS count FROM chapters WHERE work_id = ?",
      String(work.id)
    )).toEqual({ count: 0 });
    expect(runtime.database.get(
      "SELECT COUNT(*) AS count FROM chapter_versions WHERE work_id = ?",
      String(work.id)
    )).toEqual({ count: 0 });
  });

  it("作品目录不返回章节正文并按章节加载正文", async () => {
    const work = await request(runtime.app).post("/api/works").send({ title: "按需加载作品" }).expect(201);
    const workId = work.body.data.id;
    const volume = await request(runtime.app).post(`/api/works/${workId}/volumes`).send({ title: "正文" }).expect(201);
    const chapter = await request(runtime.app).post(`/api/works/${workId}/chapters`).send({
      volumeId: volume.body.data.id,
      title: "第一章",
      content: "这段正文只能通过章节接口返回。"
    }).expect(201);

    const directory = await request(runtime.app).get(`/api/works/${workId}`).expect(200);
    expect(directory.body.data.volumes[0].chapters[0]).toMatchObject({
      id: chapter.body.data.id,
      title: "第一章",
      wordCount: 14
    });
    expect(directory.body.data.volumes[0].chapters[0]).not.toHaveProperty("content");
    expect(JSON.stringify(directory.body)).not.toContain("这段正文只能通过章节接口返回。");

    const loadedChapter = await request(runtime.app).get(`/api/chapters/${chapter.body.data.id}`).expect(200);
    expect(loadedChapter.body.data.content).toBe("这段正文只能通过章节接口返回。");
  });

  it("分页作品目录不会把下一页探测记录计入分卷", async () => {
    const work = await request(runtime.app).post("/api/works").send({ title: "分页目录作品" }).expect(201);
    const text = Array.from({ length: 101 }, (_, index) => `第${index + 1}章 章节${index + 1}\n正文${index + 1}`).join("\n");
    await request(runtime.app)
      .post(`/api/works/${work.body.data.id}/import`)
      .attach("file", Buffer.from(text), "分页目录.txt")
      .expect(201);

    const firstPage = await request(runtime.app).get(`/api/works/${work.body.data.id}?page=1&limit=100`).expect(200);
    expect(firstPage.body.data.directoryPage).toMatchObject({ hasMore: true, nextPage: 2 });
    expect(firstPage.body.data.volumes[0].chapters).toHaveLength(100);

    const secondPage = await request(runtime.app).get(`/api/works/${work.body.data.id}?page=2&limit=100`).expect(200);
    expect(secondPage.body.data.directoryPage).toMatchObject({ hasMore: false, nextPage: null });
    expect(secondPage.body.data.volumes[0].chapters).toHaveLength(1);
  });

  it("先返回分卷元数据，再按分卷分页加载章节目录", async () => {
    const work = await request(runtime.app).post("/api/works").send({ title: "分卷懒加载作品" }).expect(201);
    const workId = work.body.data.id;
    const text = Array.from({ length: 101 }, (_, index) => `第${index + 1}章 章节${index + 1}\n正文`).join("\n");
    await request(runtime.app).post(`/api/works/${workId}/import`).attach("file", Buffer.from(`第一卷\n${text}`), "懒加载.txt").expect(201);

    const volumeDirectory = await request(runtime.app).get(`/api/works/${workId}?directory=volumes`).expect(200);
    expect(volumeDirectory.body.data.volumes[0]).toMatchObject({ title: "第一卷", chapterCount: 101, chapters: [] });
    const volumeId = volumeDirectory.body.data.volumes[0].id;

    const firstPage = await request(runtime.app).get(`/api/volumes/${volumeId}/chapters?page=1&limit=100`).expect(200);
    expect(firstPage.body.data).toMatchObject({ hasMore: true, nextPage: 2 });
    expect(firstPage.body.data.items).toHaveLength(100);
    expect(firstPage.body.data.items[0]).not.toHaveProperty("content");

    const secondPage = await request(runtime.app).get(`/api/volumes/${volumeId}/chapters?page=2&limit=100`).expect(200);
    expect(secondPage.body.data).toMatchObject({ hasMore: false, nextPage: null });
    expect(secondPage.body.data.items).toHaveLength(1);
  });

  it("从 DOCX 正文中提取并解析卷章", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
        <Default Extension="xml" ContentType="application/xml"/>
        <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
      </Types>`);
    zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
      </Relationships>`);
    zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
        <w:p><w:r><w:t>第一卷 星港</w:t></w:r></w:p>
        <w:p><w:r><w:t>第一章 抵达</w:t></w:r></w:p>
        <w:p><w:r><w:t>林舟抵达星港。</w:t></w:r></w:p>
        <w:sectPr/></w:body></w:document>`);
    zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`);
    const docx = await zip.generateAsync({ type: "nodebuffer" });
    const created = await request(runtime.app).post("/api/works").send({ title: "DOCX 作品" }).expect(201);
    const imported = await request(runtime.app)
      .post(`/api/works/${created.body.data.id}/import`)
      .attach("file", docx, "novel.docx")
      .expect(201);

    expect(imported.body.data.tree.volumes[0]).toMatchObject({ title: "第一卷 星港", source: "explicit" });
    const chapter = imported.body.data.tree.volumes[0].chapters[0];
    expect(chapter).toMatchObject({ title: "第一章 抵达" });
    expect(chapter).not.toHaveProperty("content");
    expect(JSON.stringify(imported.body)).not.toContain("林舟抵达星港。");
    const loadedChapter = await request(runtime.app).get(`/api/chapters/${chapter.id}`).expect(200);
    expect(loadedChapter.body.data.content).toBe("林舟抵达星港。");
  });

  it("正确解码 multipart 中文文件名并应用含前传提示", async () => {
    const created = await request(runtime.app).post("/api/works").send({ title: "含前传作品" }).expect(201);
    const imported = await request(runtime.app)
      .post(`/api/works/${created.body.data.id}/import`)
      .attach("file", Buffer.from("第一章 旧日\n前传正文。\n第一卷 归来\n第一章 新章\n主线正文。"), "作品（含前传）.txt")
      .expect(201);

    expect(imported.body.data.tree.volumes[0]).toMatchObject({ title: "前传", kind: "prequel" });
    expect(imported.body.data.warnings).toContain("根据文件名将首个未分卷内容识别为前传");
    const fileVersions = await request(runtime.app).get(`/api/works/${created.body.data.id}/file-versions`).expect(200);
    expect(fileVersions.body.data[0].fileName).toBe("作品（含前传）.txt");
  });

  it("软删除非空分卷，并继续拒绝跨作品移动", async () => {
    const first = await request(runtime.app).post("/api/works").send({ title: "A" }).expect(201);
    const second = await request(runtime.app).post("/api/works").send({ title: "B" }).expect(201);
    const firstVolume = await request(runtime.app).post(`/api/works/${first.body.data.id}/volumes`).send({ title: "第一卷" }).expect(201);
    const secondVolume = await request(runtime.app).post(`/api/works/${second.body.data.id}/volumes`).send({ title: "第二卷" }).expect(201);
    const chapter = await request(runtime.app).post(`/api/works/${first.body.data.id}/chapters`).send({ volumeId: firstVolume.body.data.id, title: "第一章" }).expect(201);

    await request(runtime.app).delete(`/api/volumes/${firstVolume.body.data.id}`).expect(204);
    expect((await request(runtime.app).get(`/api/works/${first.body.data.id}`).expect(200)).body.data.volumes).toEqual([]);
    await request(runtime.app).post(`/api/volumes/${firstVolume.body.data.id}/restore`).send({ expectedVersionNo: 2 }).expect(200);
    await request(runtime.app).post(`/api/chapters/${chapter.body.data.id}/move`).send({ volumeId: secondVolume.body.data.id, sortOrder: 0 }).expect(400);
  });

  it("为正文行创建带版本记录的批注与待办", async () => {
    const work = await request(runtime.app).post("/api/works").send({ title: "正文批注作品" }).expect(201);
    const volume = await request(runtime.app).post(`/api/works/${work.body.data.id}/volumes`).send({ title: "第一卷" }).expect(201);
    const chapter = await request(runtime.app).post(`/api/works/${work.body.data.id}/chapters`).send({
      volumeId: volume.body.data.id,
      title: "第一章",
      content: "第一行正文\n第二行正文\n第三行正文"
    }).expect(201);

    const created = await request(runtime.app).post(`/api/chapters/${chapter.body.data.id}/annotations`).send({
      kind: "todo",
      startLine: 2,
      endLine: 3,
      note: "补充两行之间的过渡"
    }).expect(201);
    expect(created.body.data).toMatchObject({
      kind: "todo",
      quote: "第二行正文\n第三行正文",
      note: "补充两行之间的过渡",
      status: "open",
      versionNo: 1
    });

    const comment = await request(runtime.app).post(`/api/chapters/${chapter.body.data.id}/annotations`).send({
      kind: "note",
      startLine: 1,
      endLine: 2,
      note: "补充人物动机"
    }).expect(201);
    const counts = await request(runtime.app).get(`/api/chapters/${chapter.body.data.id}/annotation-counts`).expect(200);
    expect(counts.body.data).toEqual([
      { line: 1, count: 1 },
      { line: 2, count: 2 },
      { line: 3, count: 1 }
    ]);
    expect(JSON.stringify(counts.body.data)).not.toContain("补充人物动机");
    const secondLine = await request(runtime.app).get(`/api/chapters/${chapter.body.data.id}/annotations?line=2`).expect(200);
    expect(secondLine.body.data.map((item: { id: string }) => item.id)).toEqual([comment.body.data.id, created.body.data.id]);

    const resolved = await request(runtime.app).patch(`/api/chapter-annotations/${created.body.data.id}`).send({
      status: "resolved",
      expectedVersionNo: 1
    }).expect(200);
    expect(resolved.body.data).toMatchObject({ status: "resolved", versionNo: 2 });
    expect((await request(runtime.app).get(`/api/chapters/${chapter.body.data.id}/annotation-counts`).expect(200)).body.data)
      .toEqual([
        { line: 1, count: 1 },
        { line: 2, count: 1 }
      ]);

    const conflict = await request(runtime.app).patch(`/api/chapter-annotations/${created.body.data.id}`).send({
      note: "冲突修改",
      expectedVersionNo: 1
    }).expect(409);
    expect(conflict.body.error.code).toBe("VERSION_CONFLICT");

    await request(runtime.app).delete(`/api/chapter-annotations/${created.body.data.id}`).send({ expectedVersionNo: 2 }).expect(204);
    await request(runtime.app).delete(`/api/chapter-annotations/${comment.body.data.id}`).send({ expectedVersionNo: 1 }).expect(204);
    const annotations = await request(runtime.app).get(`/api/chapters/${chapter.body.data.id}/annotations`).expect(200);
    expect(annotations.body.data).toEqual([]);
    expect(runtime.database.all("SELECT version_no, source FROM chapter_annotation_versions WHERE annotation_id = ? ORDER BY version_no", created.body.data.id)).toEqual([
      { version_no: 1, source: "create" },
      { version_no: 2, source: "update" },
      { version_no: 3, source: "delete" }
    ]);
  });

  it("编辑正文后将评论重新锚定到对应原文行", async () => {
    const work = await request(runtime.app).post("/api/works").send({ title: "评论锚点作品" }).expect(201);
    const volume = await request(runtime.app).post(`/api/works/${work.body.data.id}/volumes`).send({ title: "第一卷" }).expect(201);
    const chapter = await request(runtime.app).post(`/api/works/${work.body.data.id}/chapters`).send({
      volumeId: volume.body.data.id,
      title: "第一章",
      content: "第一行\n第二行\n评论目标行\n最后一行"
    }).expect(201);
    const annotation = await request(runtime.app).post(`/api/chapters/${chapter.body.data.id}/annotations`).send({
      kind: "note",
      startLine: 3,
      endLine: 3,
      note: "跟随这一行"
    }).expect(201);
    const originalLineHashes = chapterAnnotationLineHashes("评论目标行");
    expect(JSON.parse(String(runtime.database.get(
      "SELECT line_hashes_json FROM chapter_annotations WHERE id = ?",
      annotation.body.data.id
    )?.line_hashes_json))).toEqual(originalLineHashes);

    await request(runtime.app).patch(`/api/chapters/${chapter.body.data.id}`).send({
      content: "新增一行\n新增二行\n第一行\n第二行\n评论目标行\n最后一行",
      expectedVersionNo: 1
    }).expect(200);
    const moved = await request(runtime.app).get(`/api/chapters/${chapter.body.data.id}/annotations`).expect(200);
    expect(moved.body.data[0]).toMatchObject({
      id: annotation.body.data.id,
      startLine: 5,
      endLine: 5,
      quote: "评论目标行",
      versionNo: 2
    });
    expect((await request(runtime.app).get(`/api/chapters/${chapter.body.data.id}/annotation-counts`).expect(200)).body.data)
      .toEqual([{ line: 5, count: 1 }]);
    expect(JSON.parse(String(runtime.database.get(
      "SELECT line_hashes_json FROM chapter_annotations WHERE id = ?",
      annotation.body.data.id
    )?.line_hashes_json))).toEqual(originalLineHashes);
    expect(JSON.parse(String(runtime.database.get(
      "SELECT detail_json FROM audit_logs WHERE entity_id = ? ORDER BY created_at DESC LIMIT 1",
      annotation.body.data.id
    )?.detail_json))).toMatchObject({ anchorStrategy: "hash", reason: "reanchor" });

    await request(runtime.app).patch(`/api/chapters/${chapter.body.data.id}`).send({
      content: "新增一行\n新增二行\n第一行\n第二行\n修改后的目标行\n最后一行",
      expectedVersionNo: 2
    }).expect(200);
    const edited = await request(runtime.app).get(`/api/chapters/${chapter.body.data.id}/annotations`).expect(200);
    expect(edited.body.data[0]).toMatchObject({ startLine: 5, endLine: 5, quote: "修改后的目标行", versionNo: 3 });
    const editedLineHashes = chapterAnnotationLineHashes("修改后的目标行");
    expect(JSON.parse(String(runtime.database.get(
      "SELECT line_hashes_json FROM chapter_annotations WHERE id = ?",
      annotation.body.data.id
    )?.line_hashes_json))).toEqual(editedLineHashes);
    expect(editedLineHashes).not.toEqual(originalLineHashes);
    expect(JSON.parse(String(runtime.database.get(
      "SELECT detail_json FROM audit_logs WHERE entity_id = ? ORDER BY created_at DESC LIMIT 1",
      annotation.body.data.id
    )?.detail_json))).toMatchObject({ anchorStrategy: "line-id", reason: "reanchor" });
    expect(runtime.database.all(
      "SELECT version_no, source FROM chapter_annotation_versions WHERE annotation_id = ? ORDER BY version_no",
      annotation.body.data.id
    )).toEqual([
      { version_no: 1, source: "create" },
      { version_no: 2, source: "reanchor" },
      { version_no: 3, source: "reanchor" }
    ]);
    expect(runtime.database.get(
      "SELECT action FROM audit_logs WHERE entity_id = ? ORDER BY created_at DESC LIMIT 1",
      annotation.body.data.id
    )).toEqual({ action: "chapter.annotation.updated" });
    const latestSnapshot = JSON.parse(String(runtime.database.get(
      "SELECT snapshot_json FROM chapter_annotation_versions WHERE annotation_id = ? ORDER BY version_no DESC LIMIT 1",
      annotation.body.data.id
    )?.snapshot_json));
    expect(latestSnapshot).toMatchObject({ quote: "修改后的目标行", lineHashes: editedLineHashes });
  });

  it("使用稳定行身份区分并持续跟踪两条完全相同的正文", async () => {
    const work = await request(runtime.app).post("/api/works").send({ title: "重复正文评论作品" }).expect(201);
    const volume = await request(runtime.app).post(`/api/works/${work.body.data.id}/volumes`).send({ title: "第一卷" }).expect(201);
    const chapter = await request(runtime.app).post(`/api/works/${work.body.data.id}/chapters`).send({
      volumeId: volume.body.data.id,
      title: "第一章",
      content: "相同正文\n中间正文\n相同正文"
    }).expect(201);
    const originalLineIds = chapter.body.data.lineIds as string[];
    expect(originalLineIds).toHaveLength(3);
    expect(new Set(originalLineIds).size).toBe(3);
    const firstAnnotation = await request(runtime.app).post(`/api/chapters/${chapter.body.data.id}/annotations`).send({
      kind: "note",
      startLine: 1,
      endLine: 1,
      note: "绑定第一条重复正文"
    }).expect(201);
    const secondAnnotation = await request(runtime.app).post(`/api/chapters/${chapter.body.data.id}/annotations`).send({
      kind: "note",
      startLine: 3,
      endLine: 3,
      note: "绑定第二条重复正文"
    }).expect(201);

    await request(runtime.app).patch(`/api/chapters/${chapter.body.data.id}`).send({
      content: "修改后的第一行\n中间正文\n相同正文",
      lineIds: originalLineIds,
      expectedVersionNo: 1
    }).expect(200);
    const edited = await request(runtime.app).get(`/api/chapters/${chapter.body.data.id}/annotations`).expect(200);
    expect(edited.body.data.find((item: { id: string }) => item.id === firstAnnotation.body.data.id))
      .toMatchObject({ startLine: 1, quote: "修改后的第一行", versionNo: 2 });
    expect(edited.body.data.find((item: { id: string }) => item.id === secondAnnotation.body.data.id))
      .toMatchObject({ startLine: 3, quote: "相同正文", versionNo: 1 });
    expect(JSON.parse(String(runtime.database.get(
      "SELECT detail_json FROM audit_logs WHERE entity_id = ? ORDER BY rowid DESC LIMIT 1",
      firstAnnotation.body.data.id
    )?.detail_json))).toMatchObject({ anchorStrategy: "line-id" });

    const invalidLineIds = await request(runtime.app).patch(`/api/chapters/${chapter.body.data.id}`).send({
      content: "错误新增\n修改后的第一行\n中间正文\n相同正文",
      lineIds: [null, originalLineIds[2], originalLineIds[1], originalLineIds[0]],
      expectedVersionNo: 2
    }).expect(400);
    expect(invalidLineIds.body.error.code).toBe("CHAPTER_LINE_IDS_INVALID");

    await request(runtime.app).patch(`/api/chapters/${chapter.body.data.id}`).send({
      content: "新增正文\n修改后的第一行\n中间正文\n相同正文",
      lineIds: [null, ...originalLineIds],
      expectedVersionNo: 2
    }).expect(200);
    const moved = await request(runtime.app).get(`/api/chapters/${chapter.body.data.id}/annotations`).expect(200);
    expect(moved.body.data.find((item: { id: string }) => item.id === firstAnnotation.body.data.id))
      .toMatchObject({ startLine: 2, quote: "修改后的第一行", versionNo: 3 });
    expect(moved.body.data.find((item: { id: string }) => item.id === secondAnnotation.body.data.id))
      .toMatchObject({ startLine: 4, quote: "相同正文", versionNo: 2 });
    const savedChapter = await request(runtime.app).get(`/api/chapters/${chapter.body.data.id}`).expect(200);
    expect(savedChapter.body.data.lineIds.slice(1)).toEqual(originalLineIds);
    expect(savedChapter.body.data.lineIds[0]).not.toBeNull();
    expect(new Set(savedChapter.body.data.lineIds).size).toBe(4);
  });

  it("按作品与正文顺序分页列出所有章节评论", async () => {
    const work = await request(runtime.app).post("/api/works").send({ title: "评论汇总作品" }).expect(201);
    const volume = await request(runtime.app).post(`/api/works/${work.body.data.id}/volumes`).send({ title: "第一卷" }).expect(201);
    const firstChapter = await request(runtime.app).post(`/api/works/${work.body.data.id}/chapters`).send({
      volumeId: volume.body.data.id,
      title: "第一章",
      content: "第一章首行\n第一章次行"
    }).expect(201);
    const secondChapter = await request(runtime.app).post(`/api/works/${work.body.data.id}/chapters`).send({
      volumeId: volume.body.data.id,
      title: "第二章",
      content: "第二章首行\n第二章次行"
    }).expect(201);
    const resolved = await request(runtime.app).post(`/api/chapters/${firstChapter.body.data.id}/annotations`).send({
      kind: "note",
      startLine: 1,
      endLine: 1,
      note: "第一章评论"
    }).expect(201);
    await request(runtime.app).patch(`/api/chapter-annotations/${resolved.body.data.id}`).send({
      status: "resolved",
      expectedVersionNo: 1
    }).expect(200);
    await request(runtime.app).post(`/api/chapters/${secondChapter.body.data.id}/annotations`).send({
      kind: "todo",
      startLine: 2,
      endLine: 2,
      note: "第二章待办"
    }).expect(201);

    const page = await request(runtime.app)
      .get(`/api/works/${work.body.data.id}/chapter-annotations?page=1&limit=1`)
      .expect(200);
    expect(page.body.data).toMatchObject({ page: 1, limit: 1, hasMore: true, nextPage: 2, total: 2 });
    expect(page.body.data.items[0]).toMatchObject({
      chapterId: secondChapter.body.data.id,
      volumeTitle: "第一卷",
      chapterTitle: "第二章",
      status: "open",
      note: "第二章待办"
    });

    const all = await request(runtime.app).get(`/api/works/${work.body.data.id}/chapter-annotations`).expect(200);
    expect(all.body.data.map((item: { chapterTitle: string; status: string }) => [item.chapterTitle, item.status])).toEqual([
      ["第二章", "open"],
      ["第一章", "resolved"]
    ]);

    await request(runtime.app).delete(`/api/chapters/${secondChapter.body.data.id}`).send({ expectedVersionNo: 1 }).expect(204);
    const active = await request(runtime.app).get(`/api/works/${work.body.data.id}/chapter-annotations`).expect(200);
    expect(active.body.data).toEqual([expect.objectContaining({ chapterTitle: "第一章", status: "resolved" })]);
  });

  it("按章节或关键词筛选评论并将已完成待办排在末尾", async () => {
    const work = await request(runtime.app).post("/api/works").send({ title: "评论筛选作品" }).expect(201);
    const volume = await request(runtime.app).post(`/api/works/${work.body.data.id}/volumes`).send({ title: "第一卷" }).expect(201);
    const firstChapter = await request(runtime.app).post(`/api/works/${work.body.data.id}/chapters`).send({
      volumeId: volume.body.data.id,
      title: "第一章",
      content: "龙纹出现在门上"
    }).expect(201);
    const secondChapter = await request(runtime.app).post(`/api/works/${work.body.data.id}/chapters`).send({
      volumeId: volume.body.data.id,
      title: "第二章",
      content: "战斗仍需补充"
    }).expect(201);
    const note = await request(runtime.app).post(`/api/chapters/${firstChapter.body.data.id}/annotations`).send({
      kind: "note",
      startLine: 1,
      endLine: 1,
      note: "核对龙纹伏笔"
    }).expect(201);
    const completedTodo = await request(runtime.app).post(`/api/chapters/${firstChapter.body.data.id}/annotations`).send({
      kind: "todo",
      startLine: 1,
      endLine: 1,
      note: "已处理的措辞"
    }).expect(201);
    await request(runtime.app).patch(`/api/chapter-annotations/${completedTodo.body.data.id}`).send({
      status: "resolved",
      expectedVersionNo: 1
    }).expect(200);
    const openTodo = await request(runtime.app).post(`/api/chapters/${secondChapter.body.data.id}/annotations`).send({
      kind: "todo",
      startLine: 1,
      endLine: 1,
      note: "补写战斗动作"
    }).expect(201);

    const all = await request(runtime.app)
      .get(`/api/works/${work.body.data.id}/chapter-annotations?page=1&limit=30`)
      .expect(200);
    expect(all.body.data.items.map((item: { id: string }) => item.id)).toEqual([
      note.body.data.id,
      openTodo.body.data.id,
      completedTodo.body.data.id
    ]);
    expect(all.body.data.chapterOptions).toEqual([
      { id: firstChapter.body.data.id, title: "第一章", volumeTitle: "第一卷" },
      { id: secondChapter.body.data.id, title: "第二章", volumeTitle: "第一卷" }
    ]);

    const chapterFiltered = await request(runtime.app)
      .get(`/api/works/${work.body.data.id}/chapter-annotations?page=1&limit=30&chapterId=${firstChapter.body.data.id}`)
      .expect(200);
    expect(chapterFiltered.body.data).toMatchObject({ total: 2 });
    expect(chapterFiltered.body.data.items.every((item: { chapterId: string }) => item.chapterId === firstChapter.body.data.id)).toBe(true);

    const noteFiltered = await request(runtime.app)
      .get(`/api/works/${work.body.data.id}/chapter-annotations?page=1&limit=30&q=${encodeURIComponent("核对龙纹伏笔")}`)
      .expect(200);
    expect(noteFiltered.body.data.items.map((item: { id: string }) => item.id)).toEqual([note.body.data.id]);

    const quoteFiltered = await request(runtime.app)
      .get(`/api/works/${work.body.data.id}/chapter-annotations?page=1&limit=30&q=${encodeURIComponent("战斗仍需补充")}`)
      .expect(200);
    expect(quoteFiltered.body.data.items.map((item: { id: string }) => item.id)).toEqual([openTodo.body.data.id]);

    const literalWildcard = await request(runtime.app)
      .get(`/api/works/${work.body.data.id}/chapter-annotations?page=1&limit=30&q=${encodeURIComponent("%")}`)
      .expect(200);
    expect(literalWildcard.body.data).toMatchObject({ total: 0, items: [] });

    await request(runtime.app)
      .get(`/api/works/${work.body.data.id}/chapter-annotations?page=1&limit=30&q=${"超".repeat(101)}`)
      .expect(400);
  });

  it("保存写作目标并从正文版本重建字数趋势", async () => {
    const work = await request(runtime.app).post("/api/works").send({ title: "写作目标作品" }).expect(201);
    const volume = await request(runtime.app).post(`/api/works/${work.body.data.id}/volumes`).send({ title: "第一卷" }).expect(201);
    const chapter = await request(runtime.app).post(`/api/works/${work.body.data.id}/chapters`).send({
      volumeId: volume.body.data.id,
      title: "第一章",
      content: "一二三四"
    }).expect(201);

    const savedGoal = await request(runtime.app).put(`/api/works/${work.body.data.id}/writing-goal`).send({
      dailyGoal: 2000,
      targetTotal: 120000,
      deadline: "2026-12-31"
    }).expect(200);
    expect(savedGoal.body.data.goal).toMatchObject({ dailyGoal: 2000, targetTotal: 120000, deadline: "2026-12-31" });
    expect(savedGoal.body.data).toMatchObject({ currentWords: 4, todayWords: 4 });
    expect(savedGoal.body.data.trend).toHaveLength(30);
    expect(savedGoal.body.data.trend.at(-1)).toMatchObject({ words: 4, delta: 4 });

    await request(runtime.app).delete(`/api/chapters/${chapter.body.data.id}`).send({ expectedVersionNo: 1 }).expect(204);
    const afterDelete = await request(runtime.app).get(`/api/works/${work.body.data.id}/writing-progress`).expect(200);
    expect(afterDelete.body.data).toMatchObject({ currentWords: 0, todayWords: 0 });
    expect(afterDelete.body.data.trend.at(-1)).toMatchObject({ words: 0, delta: 0 });

    await request(runtime.app).post(`/api/chapters/${chapter.body.data.id}/restore`).send({ versionNo: 1, expectedVersionNo: 2 }).expect(200);
    const afterRestore = await request(runtime.app).get(`/api/works/${work.body.data.id}/writing-progress`).expect(200);
    expect(afterRestore.body.data).toMatchObject({ currentWords: 4, todayWords: 4 });
    expect(afterRestore.body.data.trend.at(-1)).toMatchObject({ words: 4, delta: 4 });
  });

  it("在单个事务中批量管理章节", async () => {
    const work = await request(runtime.app).post("/api/works").send({ title: "批量章节作品" }).expect(201);
    const firstVolume = await request(runtime.app).post(`/api/works/${work.body.data.id}/volumes`).send({ title: "第一卷" }).expect(201);
    const secondVolume = await request(runtime.app).post(`/api/works/${work.body.data.id}/volumes`).send({ title: "第二卷" }).expect(201);
    const first = await request(runtime.app).post(`/api/works/${work.body.data.id}/chapters`).send({ volumeId: firstVolume.body.data.id, title: "第一章", content: "第一章正文" }).expect(201);
    const second = await request(runtime.app).post(`/api/works/${work.body.data.id}/chapters`).send({ volumeId: firstVolume.body.data.id, title: "第二章", content: "第二章正文" }).expect(201);
    const selected = [first, second].map((chapter) => ({ id: chapter.body.data.id, expectedVersionNo: 1 }));

    await request(runtime.app).post(`/api/works/${work.body.data.id}/chapters/batch`).send({
      chapters: selected,
      action: { type: "move", volumeId: secondVolume.body.data.id }
    }).expect(200, { data: { processed: 2, action: "move" } });

    const movedTree = await request(runtime.app).get(`/api/works/${work.body.data.id}`).expect(200);
    expect(movedTree.body.data.volumes[1].chapters.map((chapter: { title: string; versionNo: number }) => [chapter.title, chapter.versionNo])).toEqual([
      ["第一章", 2],
      ["第二章", 2]
    ]);

    const movedSelection = selected.map((chapter) => ({ ...chapter, expectedVersionNo: 2 }));
    await request(runtime.app).post(`/api/works/${work.body.data.id}/chapters/batch`).send({
      chapters: movedSelection,
      action: { type: "setType", chapterType: "设定" }
    }).expect(200);
    const typedSelection = selected.map((chapter) => ({ ...chapter, expectedVersionNo: 3 }));
    await request(runtime.app).post(`/api/works/${work.body.data.id}/chapters/batch`).send({
      chapters: typedSelection,
      action: { type: "setAnalysisExclusion", excludedFromAnalysis: true }
    }).expect(200);

    const updated = await request(runtime.app).get(`/api/chapters/${first.body.data.id}`).expect(200);
    expect(updated.body.data).toMatchObject({ chapterType: "设定", excludedFromAnalysis: true, versionNo: 3 });

    const conflict = await request(runtime.app).post(`/api/works/${work.body.data.id}/chapters/batch`).send({
      chapters: [{ id: first.body.data.id, expectedVersionNo: 3 }, { id: second.body.data.id, expectedVersionNo: 99 }],
      action: { type: "delete" }
    }).expect(409);
    expect(conflict.body.error.code).toBe("VERSION_CONFLICT");
    await request(runtime.app).get(`/api/chapters/${first.body.data.id}`).expect(200);

    await request(runtime.app).post(`/api/works/${work.body.data.id}/chapters/batch`).send({
      chapters: typedSelection,
      action: { type: "delete" }
    }).expect(200, { data: { processed: 2, action: "delete" } });
    await request(runtime.app).get(`/api/chapters/${first.body.data.id}`).expect(404);
    const versions = await request(runtime.app).get(`/api/chapters/${first.body.data.id}/versions`).expect(200);
    expect(versions.body.data[0]).toMatchObject({ versionNo: 4, content: "第一章正文", source: "delete" });
    expect(runtime.database.get(
      "SELECT COUNT(*) AS count FROM analysis_tasks WHERE work_id = ? AND status = 'pending'",
      work.body.data.id
    )).toEqual({ count: 0 });
    expect(runtime.database.get(
      "SELECT COUNT(*) AS count FROM chapter_paragraph_search WHERE chapter_id IN (?, ?)",
      first.body.data.id,
      second.body.data.id
    )).toEqual({ count: 0 });
  });

  it("规范化同卷排序并支持章节跨卷移动", async () => {
    const work = await request(runtime.app).post("/api/works").send({ title: "章节排序作品" }).expect(201);
    const firstVolume = await request(runtime.app).post(`/api/works/${work.body.data.id}/volumes`).send({ title: "第一卷" }).expect(201);
    const secondVolume = await request(runtime.app).post(`/api/works/${work.body.data.id}/volumes`).send({ title: "第二卷" }).expect(201);
    const firstChapter = await request(runtime.app).post(`/api/works/${work.body.data.id}/chapters`).send({ volumeId: firstVolume.body.data.id, title: "第一章" }).expect(201);
    const secondChapter = await request(runtime.app).post(`/api/works/${work.body.data.id}/chapters`).send({ volumeId: firstVolume.body.data.id, title: "第二章" }).expect(201);
    const thirdChapter = await request(runtime.app).post(`/api/works/${work.body.data.id}/chapters`).send({ volumeId: firstVolume.body.data.id, title: "第三章", content: "第三章正文" }).expect(201);
    const fourthChapter = await request(runtime.app).post(`/api/works/${work.body.data.id}/chapters`).send({ volumeId: secondVolume.body.data.id, title: "第四章" }).expect(201);

    const reordered = await request(runtime.app)
      .post(`/api/chapters/${thirdChapter.body.data.id}/move`)
      .send({ volumeId: firstVolume.body.data.id, sortOrder: 0, expectedVersionNo: 1 })
      .expect(200);
    expect(reordered.body.data).toMatchObject({ sortOrder: 0, versionNo: 2, content: "第三章正文" });

    let tree = await request(runtime.app).get(`/api/works/${work.body.data.id}`).expect(200);
    expect(tree.body.data.volumes[0].chapters.map((chapter: { id: string; sortOrder: number }) => [chapter.id, chapter.sortOrder])).toEqual([
      [thirdChapter.body.data.id, 0],
      [firstChapter.body.data.id, 1],
      [secondChapter.body.data.id, 2]
    ]);

    const moved = await request(runtime.app)
      .post(`/api/chapters/${thirdChapter.body.data.id}/move`)
      .send({ volumeId: secondVolume.body.data.id, sortOrder: 1, expectedVersionNo: 2 })
      .expect(200);
    expect(moved.body.data).toMatchObject({ volumeId: secondVolume.body.data.id, sortOrder: 1, versionNo: 3 });

    tree = await request(runtime.app).get(`/api/works/${work.body.data.id}`).expect(200);
    expect(tree.body.data.volumes[0].chapters.map((chapter: { id: string; sortOrder: number }) => [chapter.id, chapter.sortOrder])).toEqual([
      [firstChapter.body.data.id, 0],
      [secondChapter.body.data.id, 1]
    ]);
    expect(tree.body.data.volumes[1].chapters.map((chapter: { id: string; sortOrder: number }) => [chapter.id, chapter.sortOrder])).toEqual([
      [fourthChapter.body.data.id, 0],
      [thirdChapter.body.data.id, 1]
    ]);

    const versions = await request(runtime.app).get(`/api/chapters/${thirdChapter.body.data.id}/versions`).expect(200);
    expect(versions.body.data.slice(0, 2).map((version: { versionNo: number; changeNote: string }) => [version.versionNo, version.changeNote])).toEqual([
      [3, "移动章节分卷"],
      [2, "调整章节顺序"]
    ]);
  });

  it("分卷恢复后仍保留此前独立删除的章节", async () => {
    const work = await request(runtime.app).post("/api/works").send({ title: "分卷删除保护" }).expect(201);
    const volume = await request(runtime.app).post(`/api/works/${work.body.data.id}/volumes`).send({ title: "第一卷" }).expect(201);
    const chapter = await request(runtime.app).post(`/api/works/${work.body.data.id}/chapters`).send({
      volumeId: volume.body.data.id,
      title: "仍需恢复的章节",
      content: "这段正文不能被分卷删除级联清理。"
    }).expect(201);

    const deleted = await request(runtime.app)
      .delete(`/api/chapters/${chapter.body.data.id}`)
      .send({ expectedVersionNo: 1 })
      .expect(204);
    expect(deleted.body).toEqual({});

    await request(runtime.app)
      .delete(`/api/volumes/${volume.body.data.id}`)
      .send({ expectedVersionNo: 1 })
      .expect(204);
    const recycleBin = await request(runtime.app).get(`/api/works/${work.body.data.id}/recycle-bin`).expect(200);
    expect(recycleBin.body.data.volumes).toEqual([expect.objectContaining({ id: volume.body.data.id, chapterCount: 1, versionNo: 2 })]);
    expect(recycleBin.body.data.chapters).toEqual([]);
    await request(runtime.app).post(`/api/volumes/${volume.body.data.id}/restore`).send({ expectedVersionNo: 2 }).expect(200);
    expect((await request(runtime.app).get(`/api/works/${work.body.data.id}/deleted-chapters`).expect(200)).body.data)
      .toEqual([expect.objectContaining({ id: chapter.body.data.id, versionNo: 2 })]);

    const restored = await request(runtime.app)
      .post(`/api/chapters/${chapter.body.data.id}/restore`)
      .send({ versionNo: 1, expectedVersionNo: 2 })
      .expect(200);
    expect(restored.body.data).toMatchObject({
      title: "仍需恢复的章节",
      content: "这段正文不能被分卷删除级联清理。",
      volumeId: volume.body.data.id
    });
  });

  it("彻底删除回收站章节及关联资料后可彻底删除分卷", async () => {
    const work = await request(runtime.app).post("/api/works").send({ title: "回收站清理" }).expect(201);
    const workId = work.body.data.id;
    const volume = await request(runtime.app).post(`/api/works/${workId}/volumes`).send({ title: "待删除卷" }).expect(201);
    const volumeId = volume.body.data.id;
    const chapter = await request(runtime.app).post(`/api/works/${workId}/chapters`).send({
      volumeId,
      title: "待彻底删除章节",
      content: "第一行正文。\n第二行正文。"
    }).expect(201);
    const chapterId = chapter.body.data.id;
    const annotation = await request(runtime.app).post(`/api/chapters/${chapterId}/annotations`).send({
      kind: "note",
      startLine: 1,
      endLine: 1,
      note: "待清理批注"
    }).expect(201);
    await request(runtime.app).put(`/api/chapters/${chapterId}/outline`).send({ goal: "待清理大纲" }).expect(200);

    const activePurge = await request(runtime.app)
      .delete(`/api/chapters/${chapterId}/permanent`)
      .send({ expectedVersionNo: 1 })
      .expect(409);
    expect(activePurge.body.error).toMatchObject({
      code: "CHAPTER_NOT_IN_RECYCLE_BIN",
      message: "仅回收站中的章节可以彻底删除"
    });

    await request(runtime.app).delete(`/api/chapters/${chapterId}`).send({ expectedVersionNo: 1 }).expect(204);
    await request(runtime.app).delete(`/api/chapters/${chapterId}/permanent`).send({ expectedVersionNo: 1 }).expect(409);
    await request(runtime.app).delete(`/api/chapters/${chapterId}/permanent`).send({ expectedVersionNo: 2 }).expect(204);

    expect(runtime.database.get("SELECT id FROM chapters WHERE id = ?", chapterId)).toBeUndefined();
    expect(runtime.database.all("SELECT id FROM chapter_versions WHERE chapter_id = ?", chapterId)).toEqual([]);
    expect(runtime.database.all("SELECT id FROM chapter_annotations WHERE chapter_id = ?", chapterId)).toEqual([]);
    expect(runtime.database.all("SELECT id FROM chapter_annotation_versions WHERE annotation_id = ?", annotation.body.data.id)).toEqual([]);
    expect(runtime.database.get("SELECT chapter_id FROM chapter_outlines WHERE chapter_id = ?", chapterId)).toBeUndefined();
    expect(runtime.database.all("SELECT id FROM entity_versions WHERE entity_type = 'chapter-outline' AND entity_id = ?", chapterId)).toEqual([]);
    expect(runtime.database.get("SELECT action FROM audit_logs WHERE entity_id = ? AND action = 'chapter.purged'", chapterId)).toMatchObject({ action: "chapter.purged" });
    expect((await request(runtime.app).get(`/api/works/${workId}/deleted-chapters`).expect(200)).body.data).toEqual([]);

    await request(runtime.app).delete(`/api/volumes/${volumeId}`).send({ expectedVersionNo: 1 }).expect(204);
    expect(runtime.database.get("SELECT id, deleted_at FROM volumes WHERE id = ?", volumeId)).toMatchObject({ id: volumeId, deleted_at: expect.any(String) });
    await request(runtime.app).delete(`/api/volumes/${volumeId}/permanent`).send({ expectedVersionNo: 2 }).expect(204);
    expect(runtime.database.get("SELECT id FROM volumes WHERE id = ?", volumeId)).toBeUndefined();
  });

  it("创建和编辑带简介及关键词的分卷", async () => {
    const work = await request(runtime.app).post("/api/works").send({ title: "分卷设定作品" }).expect(201);
    const volume = await request(runtime.app).post(`/api/works/${work.body.data.id}/volumes`).send({
      title: "第二卷 暗潮",
      kind: "main",
      description: "双面间谍进入敌方组织。",
      keywords: ["谍战", "身份危机", "谍战"],
      storyOrder: 9
    }).expect(201);
    expect(volume.body.data).toMatchObject({
      description: "双面间谍进入敌方组织。",
      keywords: ["谍战", "身份危机"],
      storyOrder: 9
    });

    const updated = await request(runtime.app).patch(`/api/volumes/${volume.body.data.id}`).send({
      description: "间谍身份开始暴露。",
      keywords: ["身份暴露", "阵营冲突"],
      storyOrder: 3
    }).expect(200);
    expect(updated.body.data).toMatchObject({
      description: "间谍身份开始暴露。",
      keywords: ["身份暴露", "阵营冲突"],
      storyOrder: 3
    });
    const tree = await request(runtime.app).get(`/api/works/${work.body.data.id}`).expect(200);
    expect(tree.body.data.volumes[0]).toMatchObject({ description: "间谍身份开始暴露。", keywords: ["身份暴露", "阵营冲突"], storyOrder: 3 });
  });

  it("支持四种章节类型且只修改类型时仍记录新版本", async () => {
    const work = await request(runtime.app).post("/api/works").send({ title: "章节类型作品" }).expect(201);
    const volume = await request(runtime.app).post(`/api/works/${work.body.data.id}/volumes`).send({ title: "正文" }).expect(201);
    const chapter = await request(runtime.app).post(`/api/works/${work.body.data.id}/chapters`).send({
      volumeId: volume.body.data.id,
      title: "资料章",
      content: "世界观资料。",
      chapterType: "设定"
    }).expect(201);
    expect(chapter.body.data).toMatchObject({ chapterType: "设定", versionNo: 1 });

    const marked = await request(runtime.app).patch(`/api/chapters/${chapter.body.data.id}`).send({ chapterType: "作者的话" }).expect(200);
    expect(marked.body.data).toMatchObject({ chapterType: "作者的话", versionNo: 2, analysisStatus: "expired" });
    const versions = await request(runtime.app).get(`/api/chapters/${chapter.body.data.id}/versions`).expect(200);
    expect(versions.body.data[0]).toMatchObject({ versionNo: 2, chapterType: "作者的话", source: "manual" });
    await request(runtime.app).patch(`/api/chapters/${chapter.body.data.id}`).send({ chapterType: "无效类型" }).expect(400);

    const exported = await request(runtime.app).get(`/api/works/${work.body.data.id}/export?format=json`).expect(200);
    expect(exported.body.data.work.volumes[0].chapters[0]).toMatchObject({ chapterType: "作者的话" });
  });

  it("将 Markdown 正文压缩为 ZIP 下载", async () => {
    const work = await request(runtime.app).post("/api/works").send({ title: "压缩导出作品" }).expect(201);
    const workId = work.body.data.id;
    const volume = await request(runtime.app).post(`/api/works/${workId}/volumes`).send({ title: "第一卷" }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/chapters`).send({
      volumeId: volume.body.data.id,
      title: "第一章 启航",
      content: "飞船驶离北港。"
    }).expect(201);

    const exported = await request(runtime.app)
      .get(`/api/works/${workId}/export?format=markdown`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
        response.on("error", callback);
      })
      .expect("Content-Type", /application\/zip/u)
      .expect("Content-Disposition", `attachment; filename=novel-${workId}.zip`)
      .expect(200);
    expect(Buffer.isBuffer(exported.body)).toBe(true);
    const archive = await JSZip.loadAsync(exported.body as Buffer);
    const markdownName = `novel-${workId}.md`;
    expect(Object.keys(archive.files)).toEqual([markdownName]);
    await expect(archive.file(markdownName)?.async("string")).resolves.toContain("# 第一卷\n\n## 第一章 启航\n\n飞船驶离北港。");
  });

  it("将正文导出为 DOCX，有封面时嵌入首页", async () => {
    const validPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2z94AAAAASUVORK5CYII=",
      "base64"
    );
    const work = await request(runtime.app).post("/api/works").send({ title: "DOCX 导出作品" }).expect(201);
    const workId = work.body.data.id;
    const volume = await request(runtime.app).post(`/api/works/${workId}/volumes`).send({ title: "第一卷" }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/chapters`).send({
      volumeId: volume.body.data.id,
      title: "第一章 启航",
      content: "飞船驶离北港。"
    }).expect(201);

    const withoutCover = await request(runtime.app)
      .get(`/api/works/${workId}/export?format=docx`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
        response.on("error", callback);
      })
      .expect("Content-Type", /application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document/u)
      .expect("Content-Disposition", `attachment; filename=novel-${workId}.docx`)
      .expect(200);
    expect(Buffer.isBuffer(withoutCover.body)).toBe(true);
    const plainArchive = await JSZip.loadAsync(withoutCover.body as Buffer);
    const plainDocument = await plainArchive.file("word/document.xml")?.async("string");
    expect(plainDocument).toContain("DOCX 导出作品");
    expect(plainDocument).toContain("第一卷");
    expect(plainDocument).toContain("第一章 启航");
    expect(plainDocument).toContain("飞船驶离北港。");
    expect(Object.keys(plainArchive.files).some((name) => name.startsWith("word/media/"))).toBe(false);

    await request(runtime.app).put(`/api/works/${workId}/cover`).attach("file", validPng, "cover.png").expect(200);
    const withCover = await request(runtime.app)
      .get(`/api/works/${workId}/export?format=docx`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
        response.on("error", callback);
      })
      .expect(200);
    const coverArchive = await JSZip.loadAsync(withCover.body as Buffer);
    expect(Object.keys(coverArchive.files).some((name) => name.startsWith("word/media/"))).toBe(true);
    const coverDocument = await coverArchive.file("word/document.xml")?.async("string");
    expect(coverDocument).toMatch(/<a:blip\b/u);
  });

  it("将作品或单分卷导出为安全的 EPUB 3 文件", async () => {
    const validPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2z94AAAAASUVORK5CYII=",
      "base64"
    );
    const work = await request(runtime.app).post("/api/works").send({
      title: "../北港\r\n纪事 <终章>",
      author: "慕雪 & 合著者",
      description: "不包含内部资料的作品简介。",
      language: "zh-CN"
    }).expect(201);
    const workId = String(work.body.data.id);
    const firstVolume = await request(runtime.app).post(`/api/works/${workId}/volumes`).send({ title: "第一卷 & 潮声" }).expect(201);
    const firstChapter = await request(runtime.app).post(`/api/works/${workId}/chapters`).send({
      volumeId: firstVolume.body.data.id,
      title: "第一章 <启航>",
      content: "正文 <script>alert(1)</script>。\n\n```js\nconst value = 1 < 2;\n```"
    }).expect(201);
    const emptyVolume = await request(runtime.app).post(`/api/works/${workId}/volumes`).send({ title: "空分卷" }).expect(201);
    await request(runtime.app).put(`/api/works/${workId}/cover`).attach("file", validPng, "封面.png").expect(200);

    await request(runtime.app).head(`/api/works/${workId}/export?format=epub`).expect(204);
    await request(runtime.app).head(`/api/volumes/${firstVolume.body.data.id}/export?format=epub`).expect(204);
    await request(runtime.app).head(`/api/works/${workId}/export?format=docx`).expect(400);

    const exported = await request(runtime.app)
      .get(`/api/works/${workId}/export?format=epub`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
        response.on("error", callback);
      })
      .expect("Content-Type", /application\/epub\+zip/u)
      .expect(200);
    expect(exported.headers["content-disposition"]).toContain(`filename="novel-${workId}.epub"`);
    expect(exported.headers["content-disposition"]).toContain("filename*=UTF-8''");
    expect(exported.headers["content-disposition"]).not.toMatch(/[\r\n]/u);
    expect(exported.headers["cache-control"]).toBe("private, no-store");
    const archive = await JSZip.loadAsync(exported.body as Buffer);
    await expect(archive.file("mimetype")?.async("string")).resolves.toBe("application/epub+zip");
    const packageXml = await archive.file("OEBPS/package.opf")?.async("string");
    expect(packageXml).toContain('<package xmlns="http://www.idpf.org/2007/opf"');
    expect(packageXml).toContain('version="3.0"');
    expect(packageXml).toContain("慕雪 &amp; 合著者");
    expect(packageXml).toContain('properties="cover-image"');
    const chapterXhtml = await archive.file("OEBPS/text/chapter-001-001.xhtml")?.async("string");
    expect(chapterXhtml).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(chapterXhtml).not.toContain("<script>");
    await expect(archive.file("OEBPS/text/volume-002.xhtml")?.async("string")).resolves.toContain("空分卷");
    const serialized = await Promise.all(Object.values(archive.files).filter((file) => !file.dir).map((file) => file.async("string")));
    expect(serialized.join("\n")).not.toContain(workId);
    expect(serialized.join("\n")).not.toContain(String(firstChapter.body.data.id));

    const volumeExport = await request(runtime.app)
      .get(`/api/volumes/${firstVolume.body.data.id}/export?format=epub`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
        response.on("error", callback);
      })
      .expect("Content-Type", /application\/epub\+zip/u)
      .expect(200);
    const volumeArchive = await JSZip.loadAsync(volumeExport.body as Buffer);
    const volumeNav = await volumeArchive.file("OEBPS/nav.xhtml")?.async("string");
    expect(volumeNav).toContain("第一卷 &amp; 潮声");
    expect(volumeNav).not.toContain("空分卷");
    expect(volumeExport.headers["content-disposition"]).toContain(`filename="volume-${firstVolume.body.data.id}.epub"`);

    const emptyExport = await request(runtime.app)
      .get(`/api/volumes/${emptyVolume.body.data.id}/export`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
        response.on("error", callback);
      })
      .expect(200);
    const emptyArchive = await JSZip.loadAsync(emptyExport.body as Buffer);
    expect(Object.keys(emptyArchive.files).filter((name) => /chapter-\d/u.test(name))).toEqual([]);
    await request(runtime.app).get(`/api/volumes/${firstVolume.body.data.id}/export?format=docx`).expect(400);
  });

  it("大作品 EPUB 按章节读取正文并完整写出目录与元信息", async () => {
    const work = await request(runtime.app).post("/api/works").send({
      title: "长篇流式导出",
      author: "测试作者",
      description: "验证正文不会整本预载。"
    }).expect(201);
    const workId = String(work.body.data.id);
    const chapterCount = 24;
    const chapterIds: string[] = [];
    for (let volumeIndex = 0; volumeIndex < 3; volumeIndex += 1) {
      const volume = await request(runtime.app).post(`/api/works/${workId}/volumes`).send({
        title: `第${volumeIndex + 1}卷`
      }).expect(201);
      for (let chapterIndex = 0; chapterIndex < 8; chapterIndex += 1) {
        const sequence = volumeIndex * 8 + chapterIndex + 1;
        const chapter = await request(runtime.app).post(`/api/works/${workId}/chapters`).send({
          volumeId: volume.body.data.id,
          title: `第${sequence}章`,
          content: `章节标记-${sequence}\n${`第${sequence}章长正文 & <转义>。\n`.repeat(2_000)}`
        }).expect(201);
        chapterIds.push(String(chapter.body.data.id));
      }
    }

    const treeRead = vi.spyOn(runtime.store, "getWorkTree");
    const databaseRead = vi.spyOn(runtime.database, "get");
    const exported = await runtime.store.exportEpub(workId);
    const contentReadCount = (): number => databaseRead.mock.calls.filter(([sql]) =>
      String(sql).includes("SELECT content FROM chapters WHERE id = ?")
    ).length;
    expect(treeRead).not.toHaveBeenCalled();
    expect(contentReadCount()).toBe(0);
    await request(runtime.app).patch(`/api/chapters/${chapterIds[0]}`).send({ content: "导出开始后的新正文" }).expect(200);

    const archive = await JSZip.loadAsync(await buffer(exported.archive));
    expect(contentReadCount()).toBe(chapterCount);
    const packageXml = await archive.file("OEBPS/package.opf")?.async("string");
    expect(packageXml).toContain("<dc:title>长篇流式导出</dc:title>");
    expect(packageXml).toContain("<dc:creator>测试作者</dc:creator>");
    const navigation = await archive.file("OEBPS/nav.xhtml")?.async("string");
    expect(navigation).toContain("第1卷");
    expect(navigation).toContain("第3卷");
    for (let sequence = 1; sequence <= chapterCount; sequence += 1) {
      const volumeNumber = String(Math.ceil(sequence / 8)).padStart(3, "0");
      const chapterNumber = String(((sequence - 1) % 8) + 1).padStart(3, "0");
      const chapter = await archive.file(`OEBPS/text/chapter-${volumeNumber}-${chapterNumber}.xhtml`)?.async("string");
      expect(chapter).toContain(`章节标记-${sequence}`);
      expect(chapter).toContain(`第${sequence}章长正文 &amp; &lt;转义&gt;。`);
      expect(navigation).toContain(`第${sequence}章`);
    }
  });

  it("删除章节后可列出版本并恢复", async () => {
    const work = await request(runtime.app).post("/api/works").send({ title: "章节删除恢复" }).expect(201);
    const workId = work.body.data.id;
    const volume = await request(runtime.app).post(`/api/works/${workId}/volumes`).send({ title: "正文" }).expect(201);
    const chapter = await request(runtime.app).post(`/api/works/${workId}/chapters`).send({
      volumeId: volume.body.data.id,
      title: "第一章",
      content: "原始正文。"
    }).expect(201);
    const chapterId = chapter.body.data.id;
    expect(runtime.store.searchChapterParagraphs(workId, "原始正文")).toHaveLength(1);

    await request(runtime.app).delete(`/api/chapters/${chapterId}`).expect(204);
    await request(runtime.app).get(`/api/chapters/${chapterId}`).expect(404);
    expect(runtime.database.get("SELECT title, content, version_no, deleted_at FROM chapters WHERE id = ?", chapterId)).toMatchObject({
      title: "第一章",
      content: "原始正文。",
      version_no: 2
    });
    expect(runtime.database.get("SELECT deleted_at FROM chapters WHERE id = ?", chapterId)?.deleted_at).toEqual(expect.any(String));

    const directory = await request(runtime.app).get(`/api/works/${workId}`).expect(200);
    expect(directory.body.data.chapterCount).toBe(0);
    expect(directory.body.data.wordCount).toBe(0);
    expect(directory.body.data.volumes[0].chapters).toEqual([]);
    expect(runtime.store.searchChapterParagraphs(workId, "原始正文")).toEqual([]);
    expect((await request(runtime.app).get(`/api/works/${workId}/search?q=${encodeURIComponent("原始正文")}`).expect(200)).body.data).toEqual([]);

    const recycleBin = await request(runtime.app).get(`/api/works/${workId}/deleted-chapters`).expect(200);
    expect(recycleBin.body.data).toEqual([expect.objectContaining({
      id: chapterId,
      title: "第一章",
      volumeTitle: "正文",
      contentPreview: "原始正文。",
      wordCount: 4,
      versionNo: 2,
      deletedAt: expect.any(String)
    })]);
    const recycleBinPage = await request(runtime.app).get(`/api/works/${workId}/deleted-chapters?page=1&limit=10`).expect(200);
    expect(recycleBinPage.body.data).toMatchObject({ page: 1, limit: 10, hasMore: false, nextPage: null });
    expect(recycleBinPage.body.data.items[0].id).toBe(chapterId);

    const versions = await request(runtime.app).get(`/api/chapters/${chapterId}/versions`).expect(200);
    expect(versions.body.data[0]).toMatchObject({ versionNo: 2, source: "delete", title: "第一章", content: "原始正文。" });
    expect(versions.body.data.some((item: { versionNo: number }) => item.versionNo === 1)).toBe(true);

    const restored = await request(runtime.app).post(`/api/chapters/${chapterId}/restore`).send({ versionNo: 1 }).expect(200);
    expect(restored.body.data).toMatchObject({ id: chapterId, title: "第一章", content: "原始正文。", volumeId: volume.body.data.id });
    expect(restored.body.data.versionNo).toBeGreaterThan(2);
    expect(runtime.database.get("SELECT deleted_at FROM chapters WHERE id = ?", chapterId)?.deleted_at).toBeNull();
    expect((await request(runtime.app).get(`/api/works/${workId}`).expect(200)).body.data.chapterCount).toBe(1);
    expect((await request(runtime.app).get(`/api/works/${workId}/deleted-chapters`).expect(200)).body.data).toEqual([]);
  });

  it("可从文件版本快照恢复作品正文树", async () => {
    const created = await request(runtime.app).post("/api/works").send({ title: "文件版本恢复" }).expect(201);
    const workId = created.body.data.id;
    await request(runtime.app)
      .post(`/api/works/${workId}/import`)
      .attach("file", Buffer.from("第一卷 启航\n第一章 信号\n初版正文。"), "v1.txt")
      .expect(201);

    await request(runtime.app)
      .post(`/api/works/${workId}/import`)
      .attach("file", Buffer.from("第一卷 启航\n第一章 信号\n改写后的正文。"), "v2.txt")
      .expect(201);

    const directoryBefore = await request(runtime.app).get(`/api/works/${workId}`).expect(200);
    const chapterId = directoryBefore.body.data.volumes[0].chapters[0].id;
    const chapterBefore = await request(runtime.app).get(`/api/chapters/${chapterId}`).expect(200);
    expect(chapterBefore.body.data.content).toBe("改写后的正文。");

    const fileVersions = await request(runtime.app).get(`/api/works/${workId}/file-versions`).expect(200);
    const v2VersionId = fileVersions.body.data.find((item: { fileName: string }) => item.fileName === "v2.txt").id;
    const firstPage = await request(runtime.app).get(`/api/works/${workId}/file-versions?page=1&limit=1`).expect(200);
    expect(firstPage.body.data).toMatchObject({ page: 1, limit: 1, hasMore: true, nextPage: 2 });
    expect(firstPage.body.data.items[0].fileName).toBe("v2.txt");
    const secondPage = await request(runtime.app).get(`/api/works/${workId}/file-versions?page=2&limit=1`).expect(200);
    expect(secondPage.body.data.items[0].fileName).toBe("v1.txt");

    const restored = await request(runtime.app)
      .post(`/api/works/${workId}/file-versions/${v2VersionId}/restore`)
      .expect(200);
    expect(restored.body.data.restoredFrom).toBe(v2VersionId);
    const restoredChapter = restored.body.data.tree.volumes[0].chapters[0];
    expect(restoredChapter).not.toHaveProperty("content");
    expect(JSON.stringify(restored.body)).not.toContain("初版正文。");
    const restoredChapterDetails = await request(runtime.app).get(`/api/chapters/${restoredChapter.id}`).expect(200);
    expect(restoredChapterDetails.body.data.content).toBe("初版正文。");

    const fileVersionsAfter = await request(runtime.app).get(`/api/works/${workId}/file-versions`).expect(200);
    expect(fileVersionsAfter.body.data[0].fileType).toBe("snapshot");
    const restoredCurrent = await request(runtime.app)
      .post(`/api/works/${workId}/file-versions/${fileVersionsAfter.body.data[0].id}/restore`)
      .expect(200);
    const restoredCurrentChapterId = restoredCurrent.body.data.tree.volumes[0].chapters[0].id;
    const restoredCurrentChapter = await request(runtime.app).get(`/api/chapters/${restoredCurrentChapterId}`).expect(200);
    expect(restoredCurrentChapter.body.data.content).toBe("改写后的正文。");
  });

  it("拒绝损坏的文件版本快照且不改动当前正文", async () => {
    const created = await request(runtime.app).post("/api/works").send({ title: "损坏快照保护" }).expect(201);
    const workId = String(created.body.data.id);
    await request(runtime.app)
      .post(`/api/works/${workId}/import`)
      .attach("file", Buffer.from("第一章\n\n当前正文。"), "broken.txt")
      .expect(201);

    const directoryBefore = await request(runtime.app).get(`/api/works/${workId}`).expect(200);
    const chapterId = String(directoryBefore.body.data.volumes[0].chapters[0].id);
    const version = (await request(runtime.app).get(`/api/works/${workId}/file-versions`).expect(200)).body.data[0];
    const versionCountBefore = Number(runtime.database.get(
      "SELECT COUNT(*) AS count FROM file_versions WHERE work_id = ?",
      workId
    )?.count);
    runtime.database.run("UPDATE file_versions SET snapshot_json = ? WHERE id = ?", "{invalid", version.id);

    const failed = await request(runtime.app)
      .post(`/api/works/${workId}/file-versions/${version.id}/restore`)
      .expect(409);
    expect(failed.body.error.code).toBe("FILE_VERSION_INVALID");
    const directoryAfter = await request(runtime.app).get(`/api/works/${workId}`).expect(200);
    expect(directoryAfter.body.data.volumes[0].chapters[0].id).toBe(chapterId);
    const chapterAfter = await request(runtime.app).get(`/api/chapters/${chapterId}`).expect(200);
    expect(chapterAfter.body.data.content).toBe("当前正文。");
    expect(Number(runtime.database.get(
      "SELECT COUNT(*) AS count FROM file_versions WHERE work_id = ?",
      workId
    )?.count)).toBe(versionCountBefore);
  });

  it("兼容缺少卷简介和关键词的旧文件版本快照", async () => {
    const created = await request(runtime.app).post("/api/works").send({ title: "旧快照兼容" }).expect(201);
    const workId = String(created.body.data.id);
    const volume = await request(runtime.app).post(`/api/works/${workId}/volumes`).send({ title: "旧卷" }).expect(201);
    const chapter = await request(runtime.app).post(`/api/works/${workId}/chapters`).send({
      volumeId: volume.body.data.id,
      title: "旧章",
      content: "旧版正文。"
    }).expect(201);
    const snapshot = runtime.store.getWorkTree(workId) as { volumes: Array<Record<string, unknown>> };
    for (const legacyVolume of snapshot.volumes) {
      delete legacyVolume.description;
      delete legacyVolume.keywords;
      delete legacyVolume.storyOrder;
    }
    const fileVersionId = "file_legacy_snapshot";
    runtime.database.run(
      `INSERT INTO file_versions (id, work_id, file_name, file_type, word_count, paragraph_count, warnings_json, snapshot_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      fileVersionId,
      workId,
      "legacy.txt",
      "txt",
      0,
      0,
      "[]",
      JSON.stringify(snapshot),
      new Date().toISOString()
    );
    await request(runtime.app).patch(`/api/chapters/${chapter.body.data.id}`).send({ content: "当前正文。" }).expect(200);

    const restored = await request(runtime.app)
      .post(`/api/works/${workId}/file-versions/${fileVersionId}/restore`)
      .expect(200);
    const restoredChapterId = restored.body.data.tree.volumes[0].chapters[0].id;
    const restoredChapter = await request(runtime.app).get(`/api/chapters/${restoredChapterId}`).expect(200);
    expect(restoredChapter.body.data.content).toBe("旧版正文。");
    expect(restored.body.data.tree.volumes[0]).toMatchObject({ description: "", keywords: [], storyOrder: 0 });
  });
});
