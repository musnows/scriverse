import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime, createWork } from "../helpers.js";

describe("资料收藏 API", () => {
  let runtime: Runtime;

  beforeEach(() => {
    runtime = createTestRuntime();
  });
  afterEach(() => runtime.close());

  it("收藏组织、设定档案和想法后在完整列表与分页列表置顶，并可取消收藏", async () => {
    const work = await createWork(runtime);
    const workId = String(work.id);
    const ordinaryDraft = await request(runtime.app)
      .post(`/api/works/${workId}/drafts`)
      .send({ draftType: "prose", title: "一号想法", content: "先写这一条" })
      .expect(201);
    const favoriteDraft = await request(runtime.app)
      .post(`/api/works/${workId}/drafts`)
      .send({ draftType: "prose", title: "周末想法", content: "稍后再写" })
      .expect(201);
    runtime.database.run("UPDATE drafts SET updated_at = ? WHERE id = ?", "2026-01-02T00:00:00.000Z", ordinaryDraft.body.data.id);
    runtime.database.run("UPDATE drafts SET updated_at = ? WHERE id = ?", "2026-01-01T00:00:00.000Z", favoriteDraft.body.data.id);

    const ordinarySetting = await request(runtime.app)
      .post(`/api/works/${workId}/settings`)
      .send({ title: "一号设定", category: "地点", content: "普通地点" })
      .expect(201);
    const favoriteSetting = await request(runtime.app)
      .post(`/api/works/${workId}/settings`)
      .send({ title: "周边设定", category: "地点", content: "收藏地点" })
      .expect(201);
    const ordinaryOrganization = await request(runtime.app)
      .post(`/api/works/${workId}/organizations`)
      .send({ name: "一号组织" })
      .expect(201);
    const favoriteOrganization = await request(runtime.app)
      .post(`/api/works/${workId}/organizations`)
      .send({ name: "周边组织" })
      .expect(201);

    const cases = [
      {
        type: "draft",
        ordinaryId: String(ordinaryDraft.body.data.id),
        favorite: favoriteDraft.body.data,
        favoriteEndpoint: `/api/drafts/${String(favoriteDraft.body.data.id)}/favorite`,
        listEndpoint: `/api/works/${workId}/drafts`
      },
      {
        type: "setting",
        ordinaryId: String(ordinarySetting.body.data.id),
        favorite: favoriteSetting.body.data,
        favoriteEndpoint: `/api/settings/${String(favoriteSetting.body.data.id)}/favorite`,
        listEndpoint: `/api/works/${workId}/settings`
      },
      {
        type: "organization",
        ordinaryId: String(ordinaryOrganization.body.data.id),
        favorite: favoriteOrganization.body.data,
        favoriteEndpoint: `/api/organizations/${String(favoriteOrganization.body.data.id)}/favorite`,
        listEndpoint: `/api/works/${workId}/organizations`
      }
    ];

    for (const favoriteCase of cases) {
      expect(favoriteCase.favorite.isFavorite).toBe(false);
      const updated = await request(runtime.app)
        .patch(favoriteCase.favoriteEndpoint)
        .send({ isFavorite: true })
        .expect(200);
      expect(updated.body.data).toMatchObject({
        id: favoriteCase.favorite.id,
        isFavorite: true,
        versionNo: favoriteCase.favorite.versionNo
      });

      const fullList = await request(runtime.app).get(favoriteCase.listEndpoint).expect(200);
      expect(fullList.body.data.map((item: { id: string }) => item.id)).toEqual([
        String(favoriteCase.favorite.id),
        favoriteCase.ordinaryId
      ]);
      const firstPage = await request(runtime.app).get(`${favoriteCase.listEndpoint}?page=1&limit=1`).expect(200);
      expect(firstPage.body.data.items).toEqual([
        expect.objectContaining({ id: favoriteCase.favorite.id, isFavorite: true })
      ]);

      await request(runtime.app)
        .patch(favoriteCase.favoriteEndpoint)
        .send({ isFavorite: false })
        .expect(200);
      const restoredOrder = await request(runtime.app).get(favoriteCase.listEndpoint).expect(200);
      expect(restoredOrder.body.data.map((item: { id: string }) => item.id)).toEqual([
        favoriteCase.ordinaryId,
        String(favoriteCase.favorite.id)
      ]);

      const favoriteAudits = runtime.store.listAuditLogs(workId).filter((entry) => entry.action === `${favoriteCase.type}.favorite-updated`);
      expect(favoriteAudits).toHaveLength(2);
      expect(favoriteAudits).toEqual(expect.arrayContaining([
        expect.objectContaining({ entityId: favoriteCase.favorite.id, detail: { previousFavorite: true, isFavorite: false } }),
        expect.objectContaining({ entityId: favoriteCase.favorite.id, detail: { previousFavorite: false, isFavorite: true } })
      ]));
    }
  });

  it("严格校验收藏状态输入且不为种族提供收藏接口", async () => {
    const work = await createWork(runtime);
    const workId = String(work.id);
    const draft = await request(runtime.app)
      .post(`/api/works/${workId}/drafts`)
      .send({ draftType: "prose", title: "临时想法", content: "" })
      .expect(201);
    const setting = await request(runtime.app)
      .post(`/api/works/${workId}/settings`)
      .send({ title: "临时设定", category: "规则", content: "待确认规则" })
      .expect(201);
    const organization = await request(runtime.app)
      .post(`/api/works/${workId}/organizations`)
      .send({ name: "临时组织" })
      .expect(201);
    const favoriteEndpoints = [
      `/api/drafts/${String(draft.body.data.id)}/favorite`,
      `/api/settings/${String(setting.body.data.id)}/favorite`,
      `/api/organizations/${String(organization.body.data.id)}/favorite`
    ];

    for (const endpoint of favoriteEndpoints) {
      await request(runtime.app).patch(endpoint).send({ isFavorite: "yes" }).expect(400);
      await request(runtime.app).patch(endpoint).send({ isFavorite: true, unexpected: true }).expect(400);
    }

    const race = await request(runtime.app)
      .post(`/api/works/${workId}/races`)
      .send({ name: "不收藏的种族" })
      .expect(201);
    expect(race.body.data).not.toHaveProperty("isFavorite");
    await request(runtime.app)
      .patch(`/api/races/${String(race.body.data.id)}/favorite`)
      .send({ isFavorite: true })
      .expect(404);
  });
});
