import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime } from "../helpers.js";

describe("作品和分卷版本锁", () => {
  let runtime: Runtime;

  beforeEach(() => { runtime = createTestRuntime(); });
  afterEach(() => runtime.close());

  it("保存作品元数据版本并拒绝过期写入", async () => {
    const created = await request(runtime.app).post("/api/works").send({ title: "初始标题", description: "初始简介" }).expect(201);
    const workId = created.body.data.id as string;
    expect(created.body.data.versionNo).toBe(1);
    expect(created.body.data).toMatchObject({ editorAutoIndentEnabled: false, editorTypewriterModeEnabled: false });

    const updated = await request(runtime.app)
      .patch(`/api/works/${workId}`)
      .send({
        title: "更新标题",
        editorAutoIndentEnabled: true,
        editorTypewriterModeEnabled: true,
        expectedVersionNo: 1,
        changeNote: "调整标题和正文编辑偏好"
      })
      .expect(200);
    expect(updated.body.data).toMatchObject({
      title: "更新标题",
      editorAutoIndentEnabled: true,
      editorTypewriterModeEnabled: true,
      versionNo: 2
    });

    const conflict = await request(runtime.app)
      .patch(`/api/works/${workId}`)
      .send({ description: "过期客户端覆盖", expectedVersionNo: 1 })
      .expect(409);
    expect(conflict.body.error).toMatchObject({ code: "VERSION_CONFLICT" });
    expect(conflict.body.error.details).toMatchObject({ expectedVersionNo: 1, currentVersionNo: 2 });

    const history = await request(runtime.app).get(`/api/entity-versions/work/${workId}`).expect(200);
    expect(history.body.data.map((item: { versionNo: number }) => item.versionNo)).toEqual([2, 1]);
    expect(history.body.data[0]).toMatchObject({
      changeNote: "调整标题和正文编辑偏好",
      snapshot: { title: "更新标题", editorAutoIndentEnabled: true, editorTypewriterModeEnabled: true }
    });

    const restored = await request(runtime.app)
      .post(`/api/entity-versions/work/${workId}/restore`)
      .send({ versionNo: 1, expectedVersionNo: 2 })
      .expect(200);
    expect(restored.body.data).toMatchObject({
      title: "初始标题",
      editorAutoIndentEnabled: false,
      editorTypewriterModeEnabled: false,
      versionNo: 3
    });
  });

  it("保存分卷元数据版本并支持按当前版本恢复", async () => {
    const work = await request(runtime.app).post("/api/works").send({ title: "分卷版本作品" }).expect(201);
    const workId = work.body.data.id as string;
    const volume = await request(runtime.app).post(`/api/works/${workId}/volumes`).send({ title: "第一卷", storyOrder: 7 }).expect(201);
    const volumeId = volume.body.data.id as string;
    expect(volume.body.data).toMatchObject({ storyOrder: 7, versionNo: 1 });

    const updated = await request(runtime.app)
      .patch(`/api/volumes/${volumeId}`)
      .send({ title: "第一卷 暗潮", storyOrder: 2, expectedVersionNo: 1 })
      .expect(200);
    expect(updated.body.data).toMatchObject({ title: "第一卷 暗潮", storyOrder: 2, versionNo: 2 });

    await request(runtime.app)
      .patch(`/api/volumes/${volumeId}`)
      .send({ description: "过期修改", expectedVersionNo: 1 })
      .expect(409);

    const history = await request(runtime.app).get(`/api/entity-versions/volume/${volumeId}`).expect(200);
    expect(history.body.data.map((item: { versionNo: number }) => item.versionNo)).toEqual([2, 1]);

    const restored = await request(runtime.app)
      .post(`/api/entity-versions/volume/${volumeId}/restore`)
      .send({ versionNo: 1, expectedVersionNo: 2 })
      .expect(200);
    expect(restored.body.data).toMatchObject({ title: "第一卷", storyOrder: 7, versionNo: 3 });
  });

  it("删除分卷后恢复时沿用连续版本号并继续校验锁", async () => {
    const work = await request(runtime.app).post("/api/works").send({ title: "分卷删除恢复" }).expect(201);
    const volume = await request(runtime.app).post(`/api/works/${work.body.data.id}/volumes`).send({ title: "待删除卷" }).expect(201);
    const volumeId = volume.body.data.id as string;

    const updated = await request(runtime.app)
      .patch(`/api/volumes/${volumeId}`)
      .send({ description: "删除前版本", expectedVersionNo: 1 })
      .expect(200);
    expect(updated.body.data.versionNo).toBe(2);
    await request(runtime.app).delete(`/api/volumes/${volumeId}`).send({ expectedVersionNo: 2 }).expect(204);

    await request(runtime.app)
      .post(`/api/volumes/${volumeId}/restore`)
      .send({ expectedVersionNo: 2 })
      .expect(409);
    const recycled = await request(runtime.app)
      .post(`/api/volumes/${volumeId}/restore`)
      .send({ expectedVersionNo: 3 })
      .expect(200);
    expect(recycled.body.data).toMatchObject({ id: volumeId, title: "待删除卷", versionNo: 4 });

    const restored = await request(runtime.app)
      .post(`/api/entity-versions/volume/${volumeId}/restore`)
      .send({ versionNo: 1, expectedVersionNo: 4 })
      .expect(200);
    expect(restored.body.data).toMatchObject({ id: volumeId, title: "待删除卷", versionNo: 5 });

    const changed = await request(runtime.app)
      .patch(`/api/volumes/${volumeId}`)
      .send({ title: "恢复后继续编辑", expectedVersionNo: 5 })
      .expect(200);
    expect(changed.body.data.versionNo).toBe(6);
  });
});
