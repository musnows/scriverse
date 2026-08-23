import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime, createWork } from "../helpers.js";

describe("角色收藏 API", () => {
  let runtime: Runtime;

  beforeEach(() => {
    runtime = createTestRuntime();
  });
  afterEach(() => runtime.close());

  it("收藏角色后在完整列表和分页列表置顶，并可取消收藏", async () => {
    const work = await createWork(runtime);
    const workId = String(work.id);
    const ordinary = await request(runtime.app)
      .post(`/api/works/${workId}/characters`)
      .send({ name: "一号角色" })
      .expect(201);
    const favoriteCandidate = await request(runtime.app)
      .post(`/api/works/${workId}/characters`)
      .send({ name: "周岚" })
      .expect(201);
    const favoriteId = String(favoriteCandidate.body.data.id);
    const initialVersionNo = Number(favoriteCandidate.body.data.versionNo);

    expect(ordinary.body.data.isFavorite).toBe(false);
    expect(favoriteCandidate.body.data.isFavorite).toBe(false);
    const updated = await request(runtime.app)
      .patch(`/api/characters/${favoriteId}/favorite`)
      .send({ isFavorite: true })
      .expect(200);
    expect(updated.body.data).toMatchObject({ id: favoriteId, isFavorite: true, versionNo: initialVersionNo });

    const fullList = await request(runtime.app).get(`/api/works/${workId}/characters`).expect(200);
    expect(fullList.body.data.map((item: { id: string }) => item.id)).toEqual([
      favoriteId,
      String(ordinary.body.data.id)
    ]);
    const firstPage = await request(runtime.app).get(`/api/works/${workId}/characters?page=1&limit=1`).expect(200);
    const secondPage = await request(runtime.app).get(`/api/works/${workId}/characters?page=2&limit=1`).expect(200);
    expect(firstPage.body.data.items).toEqual([expect.objectContaining({ id: favoriteId, isFavorite: true })]);
    expect(secondPage.body.data.items).toEqual([expect.objectContaining({ id: ordinary.body.data.id, isFavorite: false })]);

    await request(runtime.app)
      .patch(`/api/characters/${favoriteId}/favorite`)
      .send({ isFavorite: false })
      .expect(200);
    const restoredOrder = await request(runtime.app).get(`/api/works/${workId}/characters`).expect(200);
    expect(restoredOrder.body.data.map((item: { id: string }) => item.id)).toEqual([
      String(ordinary.body.data.id),
      favoriteId
    ]);
    const favoriteAudits = runtime.store.listAuditLogs(workId).filter((entry) => entry.action === "character.favorite-updated");
    expect(favoriteAudits).toHaveLength(2);
    expect(favoriteAudits).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityId: favoriteId, detail: { previousFavorite: true, isFavorite: false } }),
      expect.objectContaining({ entityId: favoriteId, detail: { previousFavorite: false, isFavorite: true } })
    ]));
  });

  it("严格校验收藏状态输入", async () => {
    const work = await createWork(runtime);
    const character = await request(runtime.app)
      .post(`/api/works/${String(work.id)}/characters`)
      .send({ name: "林舟" })
      .expect(201);
    const endpoint = `/api/characters/${String(character.body.data.id)}/favorite`;

    await request(runtime.app).patch(endpoint).send({ isFavorite: "yes" }).expect(400);
    await request(runtime.app).patch(endpoint).send({ isFavorite: true, unexpected: true }).expect(400);
    expect(runtime.store.getCharacter(String(character.body.data.id)).isFavorite).toBe(false);
  });
});
