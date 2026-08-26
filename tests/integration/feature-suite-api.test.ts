import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../src/app.js";
import { chapterOutlineBoardForeshadowSortSql } from "../../src/store.js";
import { createTestRuntime } from "../helpers.js";

const validPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2z94AAAAASUVORK5CYII=",
  "base64"
);
const validJpeg = Buffer.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x07, 0x08, 0x00, 0x01, 0x00, 0x01, 0xff, 0xd9
]);
const validWebp = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x16, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
  0x56, 0x50, 0x38, 0x4c, 0x05, 0x00, 0x00, 0x00, 0x2f, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00
]);
const validGif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
const maximumStandardImageUploadBytes = 5 * 1024 * 1024;

function gifOfSize(size: number): Buffer {
  return Buffer.concat([validGif.subarray(0, -1), Buffer.alloc(size - validGif.length), validGif.subarray(-1)]);
}

function pngOfSize(size: number): Buffer {
  return Buffer.concat([validPng, Buffer.alloc(size - validPng.length)]);
}

async function seedWork(runtime: Runtime, title = "功能测试作品") {
  const work = await request(runtime.app).post("/api/works").send({ title }).expect(201);
  const volume = await request(runtime.app).post(`/api/works/${work.body.data.id}/volumes`).send({ title: "第一卷" }).expect(201);
  const first = await request(runtime.app).post(`/api/works/${work.body.data.id}/chapters`).send({
    volumeId: volume.body.data.id,
    title: "第一章 埋线",
    content: "林舟在北港见到沈星。沈星说：我们一直是朋友。"
  }).expect(201);
  const second = await request(runtime.app).post(`/api/works/${work.body.data.id}/chapters`).send({
    volumeId: volume.body.data.id,
    title: "第二章 转折",
    content: "林舟离开北港，旧约仍未兑现。"
  }).expect(201);
  const third = await request(runtime.app).post(`/api/works/${work.body.data.id}/chapters`).send({
    volumeId: volume.body.data.id,
    title: "第三章 回收",
    content: "沈星打开旧信。"
  }).expect(201);
  return { workId: work.body.data.id as string, volumeId: volume.body.data.id as string, chapters: [first.body.data, second.body.data, third.body.data] };
}

async function configureAi(runtime: Runtime, workId: string) {
  const provider = await request(runtime.app).post(`/api/works/${workId}/providers`).send({
    name: "功能测试模型",
    baseUrl: "https://feature-ai.test/v1",
    apiKey: "sk-feature-test",
    status: "enabled",
    concurrencyLimit: 10,
    rpmLimit: 10_000
  }).expect(201);
  runtime.database.run("UPDATE providers SET connection_status = 'success' WHERE id = ?", provider.body.data.id);
  const model = await request(runtime.app).post(`/api/providers/${provider.body.data.id}/models`).send({
    displayName: "功能模型",
    modelId: "feature-model"
  }).expect(201);
  return model.body.data.id as string;
}

async function applySuggestedCharacterCandidates(runtime: Runtime, taskId: string) {
  const preview = await request(runtime.app).get(`/api/tasks/${taskId}/character-extraction/preview`).expect(200);
  const selections = preview.body.data.items.map((item: {
    candidateId: string;
    suggestedAction: "create" | "merge" | "skip";
    matchCandidates: Array<{ characterId: string }>;
  }) => ({
    candidateId: item.candidateId,
    action: item.suggestedAction,
    ...(item.suggestedAction === "merge" ? { targetCharacterId: item.matchCandidates[0]?.characterId } : {})
  }));
  return request(runtime.app).post(`/api/tasks/${taskId}/character-extraction/apply`).send({
    previewToken: preview.body.data.previewToken,
    selections
  }).expect(200);
}

describe("书架、别名、大纲伏笔和一致性守卫 API", () => {
  let runtime: Runtime;

  beforeEach(() => { runtime = createTestRuntime(); });
  afterEach(() => runtime.close());

  it("列表接口只返回轻量摘要，不携带资料正文", async () => {
    const { workId } = await seedWork(runtime);
    const setting = await request(runtime.app).post(`/api/works/${workId}/settings`).send({
      title: "太阳爆发",
      category: "世界规则",
      content: "正文内容。".repeat(200)
    }).expect(201);
    const race = await request(runtime.app).post(`/api/works/${workId}/races`).send({
      name: "泰坦",
      settingsSections: [{ title: "体质", contentMarkdown: "体型巨大。".repeat(100) }]
    }).expect(201);
    const organization = await request(runtime.app).post(`/api/works/${workId}/organizations`).send({
      name: "北港守望会",
      settingsSections: [{ title: "章程", contentMarkdown: "成员必须守望。".repeat(100) }]
    }).expect(201);
    const character = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "哥斯拉", raceId: race.body.data.id }).expect(201);

    const [settings, races, organizations, characters] = await Promise.all([
      request(runtime.app).get(`/api/works/${workId}/settings`).expect(200),
      request(runtime.app).get(`/api/works/${workId}/races`).expect(200),
      request(runtime.app).get(`/api/works/${workId}/organizations`).expect(200),
      request(runtime.app).get(`/api/works/${workId}/characters`).expect(200)
    ]);
    expect(settings.body.data).toEqual([expect.objectContaining({ id: setting.body.data.id, contentPreview: expect.any(String) })]);
    expect(settings.body.data[0]).not.toHaveProperty("content");
    const settingContext = await request(runtime.app).get(`/api/works/${workId}/settings/context`).expect(200);
    expect(settingContext.body.data[0]).toHaveProperty("content");
    expect(races.body.data[0]).not.toHaveProperty("settingsSections");
    expect(races.body.data[0]).not.toHaveProperty("effectiveSettings");
    expect(organizations.body.data[0]).not.toHaveProperty("settingsSections");
    expect(characters.body.data.find((item: Record<string, unknown>) => item.id === character.body.data.id).race).not.toHaveProperty("effectiveSettings");
  });

  it("维护角色死亡、种族灭绝与组织解散标识并保留版本历史", async () => {
    const { workId } = await seedWork(runtime);
    const race = await request(runtime.app).post(`/api/works/${workId}/races`).send({ name: "潮裔" }).expect(201);
    const organization = await request(runtime.app).post(`/api/works/${workId}/organizations`).send({ name: "北港议会" }).expect(201);
    const character = await request(runtime.app).post(`/api/works/${workId}/characters`).send({
      name: "林舟",
      raceId: race.body.data.id,
      organizationIds: [organization.body.data.id]
    }).expect(201);

    expect(character.body.data).toMatchObject({
      isDead: false,
      race: { isExtinct: false },
      organizations: [{ isDissolved: false }]
    });
    expect(race.body.data.isExtinct).toBe(false);
    expect(organization.body.data.isDissolved).toBe(false);

    const [dead, extinct, dissolved] = await Promise.all([
      request(runtime.app).patch(`/api/characters/${character.body.data.id}`).send({ isDead: true, changeNote: "记录角色死亡" }).expect(200),
      request(runtime.app).patch(`/api/races/${race.body.data.id}`).send({ isExtinct: true, changeNote: "记录种族灭绝" }).expect(200),
      request(runtime.app).patch(`/api/organizations/${organization.body.data.id}`).send({ isDissolved: true, changeNote: "记录组织解散" }).expect(200)
    ]);
    expect(dead.body.data.isDead).toBe(true);
    expect(extinct.body.data.isExtinct).toBe(true);
    expect(dissolved.body.data.isDissolved).toBe(true);

    const refreshed = await request(runtime.app).get(`/api/characters/${character.body.data.id}`).expect(200);
    expect(refreshed.body.data).toMatchObject({
      isDead: true,
      race: { isExtinct: true },
      organizations: [{ isDissolved: true }]
    });
    const characterVersions = await request(runtime.app).get(`/api/characters/${character.body.data.id}/versions`).expect(200);
    expect(characterVersions.body.data[0]).toMatchObject({ changeNote: "记录角色死亡", snapshot: { isDead: true } });
    const raceVersions = await request(runtime.app).get(`/api/entity-versions/race/${race.body.data.id}`).expect(200);
    expect(raceVersions.body.data[0]).toMatchObject({ changeNote: "记录种族灭绝", snapshot: { isExtinct: true } });
    const organizationVersions = await request(runtime.app).get(`/api/entity-versions/organization/${organization.body.data.id}`).expect(200);
    expect(organizationVersions.body.data[0]).toMatchObject({ changeNote: "记录组织解散", snapshot: { isDissolved: true } });

    await request(runtime.app).patch(`/api/characters/${character.body.data.id}`).send({ isDead: "yes" }).expect(400);
    await request(runtime.app).patch(`/api/races/${race.body.data.id}`).send({ isExtinct: 1 }).expect(400);
    await request(runtime.app).patch(`/api/organizations/${organization.body.data.id}`).send({ isDissolved: null }).expect(400);
  });

  it("维护角色性别枚举、默认值与版本历史", async () => {
    const { workId } = await seedWork(runtime);
    const unspecified = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "未知角色" }).expect(201);
    expect(unspecified.body.data.gender).toBe("unknown");
    const maleCharacter = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "哥斯拉", gender: "male" }).expect(201);
    expect(maleCharacter.body.data.gender).toBe("male");

    const character = await request(runtime.app).post(`/api/works/${workId}/characters`).send({
      name: "魔斯拉",
      gender: "female"
    }).expect(201);
    expect(character.body.data.gender).toBe("female");

    const updated = await request(runtime.app).patch(`/api/characters/${character.body.data.id}`).send({
      gender: "none",
      changeNote: "调整性别设定"
    }).expect(200);
    expect(updated.body.data).toMatchObject({ gender: "none", versionNo: 2 });

    const versions = await request(runtime.app).get(`/api/characters/${character.body.data.id}/versions`).expect(200);
    expect(versions.body.data[0]).toMatchObject({ changeNote: "调整性别设定", snapshot: { gender: "none" } });
    expect(versions.body.data[1]).toMatchObject({ snapshot: { gender: "female" } });

    const restored = await request(runtime.app).post(`/api/characters/${character.body.data.id}/restore`).send({ versionNo: 1 }).expect(200);
    expect(restored.body.data).toMatchObject({ gender: "female", versionNo: 3 });

    await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "错误角色", gender: "other" }).expect(400);
    await request(runtime.app).patch(`/api/characters/${character.body.data.id}`).send({ gender: null }).expect(400);
  });

  it("在作品内统一约束主名和全部别名，并规范化无向关系", async () => {
    const { workId } = await seedWork(runtime);
    const first = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "魔斯拉", aliases: ["小魔", "Mothra"] }).expect(201);
    const duplicateAlias = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "小魔" }).expect(409);
    expect(duplicateAlias.body.error.code).toBe("CHARACTER_NAME_CONFLICT");
    await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "ｍｏｔｈｒａ" }).expect(409);
    const second = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "拉顿" }).expect(201);
    await request(runtime.app).patch(`/api/characters/${second.body.data.id}`).send({ aliases: [" 小魔 "] }).expect(409);
    const unchanged = await request(runtime.app).get(`/api/characters/${second.body.data.id}`).expect(200);
    expect(unchanged.body.data.aliases).toEqual([]);

    const relation = await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: second.body.data.id,
      toCharacterId: first.body.data.id,
      category: "social",
      subtype: "朋友",
      keywords: ["共同守望", "长期信任"],
      directed: false,
      confidence: 1
    }).expect(201);
    expect(relation.body.data.fromCharacterId.localeCompare(relation.body.data.toCharacterId)).toBeLessThan(0);
    expect(relation.body.data.keywords).toEqual(["共同守望", "长期信任"]);
    await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: first.body.data.id,
      toCharacterId: second.body.data.id,
      category: "social",
      subtype: "朋友",
      directed: false
    }).expect(409);

    await request(runtime.app).delete(`/api/characters/${first.body.data.id}`).expect(204);
    const released = await request(runtime.app).patch(`/api/characters/${second.body.data.id}`).send({ aliases: ["小魔"] }).expect(200);
    expect(released.body.data.aliases).toEqual(["小魔"]);

    const other = await request(runtime.app).post("/api/works").send({ title: "另一作品" }).expect(201);
    await request(runtime.app).post(`/api/works/${other.body.data.id}/characters`).send({ name: "小魔" }).expect(201);
  });

  it("维护世界内组织、设定清单与双向角色绑定", async () => {
    const { workId } = await seedWork(runtime);
    const first = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "林舟" }).expect(201);
    const second = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "沈星" }).expect(201);
    const organization = await request(runtime.app).post(`/api/works/${workId}/organizations`).send({
      name: "北港守望会",
      description: "守护航道与旧约的自治组织。",
      settings: ["成员以星图为信物", "重大决策需双席同意"],
      memberIds: [first.body.data.id]
    }).expect(201);
    expect(organization.body.data).toMatchObject({
      name: "北港守望会",
      settings: ["成员以星图为信物", "重大决策需双席同意"],
      memberIds: [first.body.data.id]
    });
    await request(runtime.app).post(`/api/works/${workId}/organizations`).send({ name: " 北港守望会 " }).expect(409);

    const firstCharacter = await request(runtime.app).get(`/api/characters/${first.body.data.id}`).expect(200);
    expect(firstCharacter.body.data.organizationIds).toEqual([organization.body.data.id]);
    const secondCharacter = await request(runtime.app).patch(`/api/characters/${second.body.data.id}`).send({
      organizationIds: [organization.body.data.id]
    }).expect(200);
    expect(secondCharacter.body.data.organizations[0].name).toBe("北港守望会");

    const replaced = await request(runtime.app).patch(`/api/organizations/${organization.body.data.id}`).send({
      memberIds: [second.body.data.id],
      settings: ["新章程已生效"]
    }).expect(200);
    expect(replaced.body.data.memberIds).toEqual([second.body.data.id]);
    expect(replaced.body.data.settings).toEqual(["新章程已生效"]);
    const firstAfter = await request(runtime.app).get(`/api/characters/${first.body.data.id}`).expect(200);
    expect(firstAfter.body.data.organizationIds).toEqual([]);

    const search = await request(runtime.app).get(`/api/works/${workId}/search?q=${encodeURIComponent("新章程")}`).expect(200);
    expect(search.body.data).toContainEqual(expect.objectContaining({ type: "organization", title: "北港守望会" }));
  });

  it("允许角色同时绑定多个组织且各组织独立维护成员", async () => {
    const { workId } = await seedWork(runtime);
    const character = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "双面间谍" }).expect(201);
    const first = await request(runtime.app).post(`/api/works/${workId}/organizations`).send({ name: "北港情报局" }).expect(201);
    const second = await request(runtime.app).post(`/api/works/${workId}/organizations`).send({ name: "深空同盟" }).expect(201);

    const joined = await request(runtime.app).patch(`/api/characters/${character.body.data.id}`).send({
      organizationIds: [first.body.data.id, second.body.data.id]
    }).expect(200);
    expect(new Set(joined.body.data.organizationIds)).toEqual(new Set([first.body.data.id, second.body.data.id]));
    expect(joined.body.data.organizations.map((item: { name: string }) => item.name).sort()).toEqual(["北港情报局", "深空同盟"].sort());

    await request(runtime.app).patch(`/api/organizations/${first.body.data.id}`).send({ memberIds: [] }).expect(200);
    const remaining = await request(runtime.app).get(`/api/characters/${character.body.data.id}`).expect(200);
    expect(remaining.body.data.organizationIds).toEqual([second.body.data.id]);
    expect(remaining.body.data.organizations).toEqual([expect.objectContaining({ name: "深空同盟" })]);
  });

  it("为设定库、种族和组织保存 Markdown 正文并保持旧设定数组兼容", async () => {
    const { workId } = await seedWork(runtime);
    const markdown = "## 共同规律\n\n- 只能在月光下显现\n- 不得跨越旧约边界";
    const setting = await request(runtime.app).post(`/api/works/${workId}/settings`).send({
      title: "月光规则",
      category: "世界规则",
      content: markdown
    }).expect(201);
    expect(setting.body.data.content).toBe(markdown);

    const race = await request(runtime.app).post(`/api/works/${workId}/races`).send({
      name: "月裔",
      settingsMarkdown: markdown
    }).expect(201);
    expect(race.body.data).toMatchObject({ settings: [markdown], settingsMarkdown: markdown });

    const organization = await request(runtime.app).post(`/api/works/${workId}/organizations`).send({
      name: "月下议会",
      settingsMarkdown: markdown
    }).expect(201);
    expect(organization.body.data).toMatchObject({ settings: [markdown], settingsMarkdown: markdown });

    const updatedRace = await request(runtime.app).patch(`/api/races/${race.body.data.id}`).send({
      settingsMarkdown: "### 更新后的共同规律\n\n已完成登记。"
    }).expect(200);
    expect(updatedRace.body.data.settingsMarkdown).toContain("更新后的共同规律");
    const updatedOrganization = await request(runtime.app).patch(`/api/organizations/${organization.body.data.id}`).send({
      settingsMarkdown: "### 更新后的组织章程\n\n全员需遵守。"
    }).expect(200);
    expect(updatedOrganization.body.data.settingsMarkdown).toContain("更新后的组织章程");
  });

  it("按标题分别保存种族和组织 Markdown 设定章节", async () => {
    const { workId } = await seedWork(runtime);
    const sections = [
      { title: "生理特征", contentMarkdown: "体型会随月相变化。", sortOrder: 0 },
      { title: "社会结构", contentMarkdown: "由长老会维护旧约。", sortOrder: 1 }
    ];
    const race = await request(runtime.app).post(`/api/works/${workId}/races`).send({
      name: "月裔章节版",
      settingsSections: sections
    }).expect(201);
    expect(race.body.data).toMatchObject({
      settings: ["体型会随月相变化。", "由长老会维护旧约。"],
      settingsSections: sections
    });

    const organization = await request(runtime.app).post(`/api/works/${workId}/organizations`).send({
      name: "月下议会章节版",
      settingsSections: sections
    }).expect(201);
    expect(organization.body.data.settingsSections).toEqual(sections.map((section) => ({ ...section, summary: "" })));

    const updated = await request(runtime.app).patch(`/api/organizations/${organization.body.data.id}`).send({
      settingsSections: [{ title: "新章程", contentMarkdown: "成员必须遵守月下议会的誓约。", sortOrder: 0 }]
    }).expect(200);
    expect(updated.body.data.settingsSections).toEqual([
      { title: "新章程", contentMarkdown: "成员必须遵守月下议会的誓约。", summary: "", sortOrder: 0 }
    ]);
  });

  it("允许旧版大体量种族和组织设定升级后继续保存", async () => {
    const { workId } = await seedWork(runtime);
    const legacySettings = Array.from({ length: 11 }, (_, index) => `## 旧设定 ${index + 1}\n\n${"旧".repeat(19_900)}`);
    const legacyLength = legacySettings.reduce((total, item) => total + item.length, 0);
    expect(legacyLength).toBeGreaterThan(200_000);

    const race = await request(runtime.app).post(`/api/works/${workId}/races`).send({
      name: "旧版大体量种族",
      settings: legacySettings
    }).expect(201);
    const organization = await request(runtime.app).post(`/api/works/${workId}/organizations`).send({
      name: "旧版大体量组织",
      settings: legacySettings
    }).expect(201);

    const loadedRace = await request(runtime.app).get(`/api/races/${race.body.data.id}`).expect(200);
    const updatedRace = await request(runtime.app).patch(`/api/races/${race.body.data.id}`).send({
      name: "升级后的大体量种族",
      settingsSections: loadedRace.body.data.settingsSections
    }).expect(200);
    expect(updatedRace.body.data.settings).toEqual(legacySettings);

    const loadedOrganization = await request(runtime.app).get(`/api/organizations/${organization.body.data.id}`).expect(200);
    const updatedOrganization = await request(runtime.app).patch(`/api/organizations/${organization.body.data.id}`).send({
      name: "升级后的大体量组织",
      settingsSections: loadedOrganization.body.data.settingsSections.map((section: Record<string, unknown>, index: number) => (
        index === 0 ? { ...section, summary: "升级后补充摘要" } : section
      ))
    }).expect(200);
    expect(updatedOrganization.body.data.settings).toEqual(legacySettings);
    expect(updatedOrganization.body.data.settingsSections[0].summary).toBe("升级后补充摘要");
  });

  it("先维护种族主数据，再由人物引用并与组织保持独立", async () => {
    const { workId } = await seedWork(runtime);
    const organization = await request(runtime.app).post(`/api/works/${workId}/organizations`).send({ name: "帝王组织" }).expect(201);
    const titanRace = await request(runtime.app).post(`/api/works/${workId}/races`).send({
      name: "泰坦族",
      description: "远古巨型生命",
      settings: ["可感知地球生态"]
    }).expect(201);
    const created = await request(runtime.app).post(`/api/works/${workId}/characters`).send({
      name: "魔斯拉",
      raceId: titanRace.body.data.id,
      organizationIds: [organization.body.data.id]
    }).expect(201);
    expect(created.body.data).toMatchObject({
      name: "魔斯拉",
      raceId: titanRace.body.data.id,
      species: "泰坦族",
      organizationIds: [organization.body.data.id]
    });

    const originalRace = await request(runtime.app).post(`/api/works/${workId}/races`).send({ name: "原生泰坦" }).expect(201);
    const updated = await request(runtime.app).patch(`/api/characters/${created.body.data.id}`).send({ raceId: originalRace.body.data.id }).expect(200);
    expect(updated.body.data.species).toBe("原生泰坦");
    expect(updated.body.data.organizations[0].name).toBe("帝王组织");
    await request(runtime.app).patch(`/api/characters/${created.body.data.id}`).send({ species: "未登记种族" }).expect(400);

    const races = await request(runtime.app).get(`/api/works/${workId}/races?includeContent=true`).expect(200);
    expect(races.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "泰坦族", settings: ["可感知地球生态"] }),
      expect.objectContaining({ name: "原生泰坦", memberIds: [created.body.data.id] })
    ]));

    const search = await request(runtime.app).get(`/api/works/${workId}/search?q=${encodeURIComponent("原生泰坦")}`).expect(200);
    expect(search.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "character", title: "魔斯拉", snippet: "原生泰坦" }),
      expect.objectContaining({ type: "race", title: "原生泰坦" })
    ]));
  });

  it("维护任意层级种族并按祖先顺序继承共同设定", async () => {
    const { workId } = await seedWork(runtime);
    const titan = await request(runtime.app).post(`/api/works/${workId}/races`).send({
      name: "泰坦",
      settings: ["体型巨大"]
    }).expect(201);
    const original = await request(runtime.app).post(`/api/works/${workId}/races`).send({
      name: "原生泰坦",
      parentRaceId: titan.body.data.id,
      settings: ["源自远古"]
    }).expect(201);
    const alpha = await request(runtime.app).post(`/api/works/${workId}/races`).send({
      name: "阿尔法泰坦",
      parentRaceId: original.body.data.id,
      settings: ["能够号令同族"]
    }).expect(201);

    expect(alpha.body.data).toMatchObject({
      parentRaceId: original.body.data.id,
      lineage: [
        { id: titan.body.data.id, name: "泰坦" },
        { id: original.body.data.id, name: "原生泰坦" },
        { id: alpha.body.data.id, name: "阿尔法泰坦" }
      ],
      effectiveSettings: [
        { value: "体型巨大", sourceRaceId: titan.body.data.id, sourceRaceName: "泰坦", inherited: true },
        { value: "源自远古", sourceRaceId: original.body.data.id, sourceRaceName: "原生泰坦", inherited: true },
        { value: "能够号令同族", sourceRaceId: alpha.body.data.id, sourceRaceName: "阿尔法泰坦", inherited: false }
      ]
    });

    const roots = await request(runtime.app).get(`/api/works/${workId}/races?scope=roots`).expect(200);
    expect(roots.body.data).toMatchObject({
      total: 3,
      items: [expect.objectContaining({ id: titan.body.data.id, parentRaceId: null, childCount: 1 })]
    });
    const descendants = await request(runtime.app).get(`/api/works/${workId}/races?scope=descendants`).expect(200);
    expect(descendants.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: original.body.data.id, parentRaceId: titan.body.data.id, childCount: 1 }),
      expect.objectContaining({ id: alpha.body.data.id, parentRaceId: original.body.data.id, childCount: 0 })
    ]));
    await request(runtime.app).get(`/api/works/${workId}/races?scope=roots&page=1`).expect(400);
    await request(runtime.app).get(`/api/works/${workId}/races?scope=invalid`).expect(400);

    const character = await request(runtime.app).post(`/api/works/${workId}/characters`).send({
      name: "哥斯拉",
      raceId: original.body.data.id
    }).expect(201);
    expect(character.body.data).toMatchObject({
      species: "原生泰坦",
      race: {
        id: original.body.data.id,
        lineage: [{ name: "泰坦" }, { name: "原生泰坦" }],
        effectiveSettings: [
          { value: "体型巨大", inherited: true },
          { value: "源自远古", inherited: false }
        ]
      }
    });

    await request(runtime.app).patch(`/api/races/${titan.body.data.id}`).send({ settings: ["维持生态平衡"] }).expect(200);
    const refreshed = await request(runtime.app).get(`/api/characters/${character.body.data.id}`).expect(200);
    expect(refreshed.body.data.race.effectiveSettings).toEqual([
      expect.objectContaining({ value: "维持生态平衡", sourceRaceName: "泰坦", inherited: true }),
      expect.objectContaining({ value: "源自远古", sourceRaceName: "原生泰坦", inherited: false })
    ]);

    const other = await request(runtime.app).post("/api/works").send({ title: "另一作品" }).expect(201);
    const human = await request(runtime.app).post(`/api/works/${other.body.data.id}/races`).send({ name: "人类" }).expect(201);
    const crossWork = await request(runtime.app).post(`/api/works/${workId}/races`).send({
      name: "错误子种族",
      parentRaceId: human.body.data.id
    }).expect(400);
    expect(crossWork.body.error.code).toBe("RACE_PARENT_WORK_MISMATCH");

    const cycle = await request(runtime.app).patch(`/api/races/${titan.body.data.id}`).send({
      parentRaceId: alpha.body.data.id
    }).expect(409);
    expect(cycle.body.error.code).toBe("RACE_HIERARCHY_CYCLE");
    const blockedDelete = await request(runtime.app).delete(`/api/races/${titan.body.data.id}`).expect(409);
    expect(blockedDelete.body.error.code).toBe("RACE_HAS_CHILDREN");

    const search = await request(runtime.app).get(`/api/works/${workId}/search?q=${encodeURIComponent("泰坦")}`).expect(200);
    expect(search.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "character", title: "哥斯拉", snippet: "泰坦 / 原生泰坦", racePath: "泰坦 / 原生泰坦" }),
      expect.objectContaining({
        type: "race",
        title: "原生泰坦",
        lineage: [{ id: titan.body.data.id, name: "泰坦" }, { id: original.body.data.id, name: "原生泰坦" }]
      })
    ]));
    const exported = await request(runtime.app).get(`/api/works/${workId}/export?format=json`).expect(200);
    expect(exported.body.data).toMatchObject({
      schemaVersion: 8,
      races: expect.arrayContaining([expect.objectContaining({ id: original.body.data.id, parentRaceId: titan.body.data.id })])
    });
  });

  it("删除包含多级种族树的作品时保留资料，彻底删除后完整级联清理", async () => {
    const work = await request(runtime.app).post("/api/works").send({ title: "待删除种族树作品" }).expect(201);
    const workId = String(work.body.data.id);
    const parent = await request(runtime.app).post(`/api/works/${workId}/races`).send({ name: "父种族" }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/races`).send({
      name: "子种族",
      parentRaceId: parent.body.data.id
    }).expect(201);
    const character = await request(runtime.app).post(`/api/works/${workId}/characters`).send({
      name: "待删除角色",
      raceId: parent.body.data.id
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/organizations`).send({
      name: "待删除组织",
      memberIds: [character.body.data.id]
    }).expect(201);
    const volume = await request(runtime.app).post(`/api/works/${workId}/volumes`).send({ title: "待删除卷" }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/chapters`).send({
      volumeId: volume.body.data.id,
      title: "待删除章",
      content: "用于触发关系索引队列。"
    }).expect(201);

    await request(runtime.app).delete(`/api/works/${workId}`).expect(204);
    await request(runtime.app).get(`/api/works/${workId}`).expect(404);
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM races WHERE work_id = ?", workId)?.count).toBe(2);
    await request(runtime.app)
      .delete(`/api/recycle-bin/works/${workId}/permanent`)
      .send({ expectedVersionNo: 2 })
      .expect(204);
    expect(runtime.database.get("SELECT COUNT(*) AS count FROM races WHERE work_id = ?", workId)?.count).toBe(0);
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("记录并恢复种族父级，且兼容缺少父级字段的旧快照", async () => {
    const { workId } = await seedWork(runtime);
    const titan = await request(runtime.app).post(`/api/works/${workId}/races`).send({ name: "泰坦" }).expect(201);
    const original = await request(runtime.app).post(`/api/works/${workId}/races`).send({
      name: "原生泰坦",
      parentRaceId: titan.body.data.id
    }).expect(201);

    await request(runtime.app).patch(`/api/races/${original.body.data.id}`).send({ parentRaceId: null }).expect(200);
    const versions = await request(runtime.app).get(`/api/entity-versions/race/${original.body.data.id}`).expect(200);
    expect(versions.body.data[0].snapshot.parentRaceId).toBeNull();
    expect(versions.body.data[1].snapshot.parentRaceId).toBe(titan.body.data.id);

    const restored = await request(runtime.app)
      .post(`/api/entity-versions/race/${original.body.data.id}/restore`)
      .send({ versionNo: 1 })
      .expect(200);
    expect(restored.body.data.parentRaceId).toBe(titan.body.data.id);

    const latest = await request(runtime.app).get(`/api/entity-versions/race/${original.body.data.id}`).expect(200);
    const legacySnapshot = { ...latest.body.data.at(-1).snapshot };
    delete legacySnapshot.parentRaceId;
    runtime.database.run(
      "UPDATE entity_versions SET snapshot_json = ? WHERE entity_type = 'race' AND entity_id = ? AND version_no = 1",
      JSON.stringify(legacySnapshot),
      original.body.data.id
    );
    await request(runtime.app).patch(`/api/races/${original.body.data.id}`).send({ parentRaceId: null }).expect(200);
    const legacyRestored = await request(runtime.app)
      .post(`/api/entity-versions/race/${original.body.data.id}/restore`)
      .send({ versionNo: 1 })
      .expect(200);
    expect(legacyRestored.body.data.parentRaceId).toBeNull();
  });

  it("为人物编辑保存完整版本历史并通过新版本回滚", async () => {
    const { workId } = await seedWork(runtime);
    const organization = await request(runtime.app).post(`/api/works/${workId}/organizations`).send({ name: "帝王组织" }).expect(201);
    const originalRace = await request(runtime.app).post(`/api/works/${workId}/races`).send({ name: "原生泰坦" }).expect(201);
    const evolvedRace = await request(runtime.app).post(`/api/works/${workId}/races`).send({ name: "进化泰坦" }).expect(201);
    const created = await request(runtime.app).post(`/api/works/${workId}/characters`).send({
      name: "哥斯拉",
      code: "MON-001",
      aliases: ["吾王"],
      raceId: originalRace.body.data.id,
      organizationIds: [organization.body.data.id],
      attributes: { identity: "星球意志", details: [{ label: "身高", value: "119米" }] },
      profile: { summary: "地球守护者", sections: [{ title: "能力", content: "原子吐息" }] },
      currentState: { location: "地球" },
      lockedFields: ["raceId", "location"]
    }).expect(201);
    expect(created.body.data).toMatchObject({ code: "MON-001", versionNo: 1 });

    await request(runtime.app).post(`/api/works/${workId}/characters`).send({
      name: "超长编号角色",
      code: "A".repeat(201)
    }).expect(400);

    const updated = await request(runtime.app).patch(`/api/characters/${created.body.data.id}`).send({
      name: "燃烧哥斯拉",
      code: "MON-002",
      raceId: evolvedRace.body.data.id,
      organizationIds: [],
      profile: { summary: "能量过载形态", sections: [{ title: "形态", content: "红莲状态" }] },
      changeNote: "补充红莲形态"
    }).expect(200);
    expect(updated.body.data).toMatchObject({ code: "MON-002", versionNo: 2 });

    await request(runtime.app).patch(`/api/characters/${created.body.data.id}`).send({ raceId: evolvedRace.body.data.id }).expect(200);
    const versions = await request(runtime.app).get(`/api/characters/${created.body.data.id}/versions`).expect(200);
    expect(versions.body.data).toHaveLength(2);
    expect(versions.body.data[0]).toMatchObject({ versionNo: 2, source: "manual", changeNote: "补充红莲形态" });
    expect(versions.body.data[0].snapshot).toMatchObject({ name: "燃烧哥斯拉", code: "MON-002", raceId: evolvedRace.body.data.id, species: "进化泰坦", organizationIds: [] });
    expect(versions.body.data[1].snapshot).toMatchObject({ name: "哥斯拉", code: "MON-001", raceId: originalRace.body.data.id, species: "原生泰坦", organizationIds: [organization.body.data.id] });

    const restored = await request(runtime.app).post(`/api/characters/${created.body.data.id}/restore`).send({ versionNo: 1 }).expect(200);
    expect(restored.body.data).toMatchObject({
      name: "哥斯拉",
      code: "MON-001",
      raceId: originalRace.body.data.id,
      species: "原生泰坦",
      organizationIds: [organization.body.data.id],
      versionNo: 3
    });
    const afterRestore = await request(runtime.app).get(`/api/characters/${created.body.data.id}/versions`).expect(200);
    expect(afterRestore.body.data[0]).toMatchObject({ versionNo: 3, source: "restore", changeNote: "恢复至 v1" });

    await request(runtime.app).patch(`/api/races/${originalRace.body.data.id}`).send({ name: "原初泰坦" }).expect(200);
    const afterRaceRename = await request(runtime.app).get(`/api/characters/${created.body.data.id}`).expect(200);
    expect(afterRaceRename.body.data).toMatchObject({ raceId: originalRace.body.data.id, species: "原初泰坦", versionNo: 4 });
    const versionsAfterRaceRename = await request(runtime.app).get(`/api/characters/${created.body.data.id}/versions`).expect(200);
    expect(versionsAfterRaceRename.body.data[0]).toMatchObject({ versionNo: 4, source: "race", changeNote: "种族更名为“原初泰坦”" });
  });

  it("回滚升级前人物版本时清空快照中缺失的编号", async () => {
    const { workId } = await seedWork(runtime);
    const created = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "旧档案角色" }).expect(201);
    const version = runtime.database.get("SELECT id, snapshot_json FROM character_versions WHERE character_id = ? AND version_no = 1", created.body.data.id);
    const snapshot = JSON.parse(String(version?.snapshot_json)) as Record<string, unknown>;
    delete snapshot.code;
    runtime.database.run("UPDATE character_versions SET snapshot_json = ? WHERE id = ?", JSON.stringify(snapshot), String(version?.id));

    const updated = await request(runtime.app).patch(`/api/characters/${created.body.data.id}`).send({ code: "EMP-099" }).expect(200);
    expect(updated.body.data.code).toBe("EMP-099");
    const restored = await request(runtime.app).post(`/api/characters/${created.body.data.id}/restore`).send({ versionNo: 1 }).expect(200);
    expect(restored.body.data.code).toBe("");
  });

  it("支持原子导入新建、上传替换和删除书籍封面", async () => {
    const before = await request(runtime.app).get("/api/works").expect(200);
    await request(runtime.app).post("/api/works/import").attach("file", Buffer.from("无效"), "bad.pdf").expect(415);
    const afterFailure = await request(runtime.app).get("/api/works").expect(200);
    expect(afterFailure.body.data).toHaveLength(before.body.data.length);

    const imported = await request(runtime.app).post("/api/works/import")
      .field("author", "测试作者")
      .attach("file", Buffer.from("第一章 开始\n故事开始。"), "导入书名.txt")
      .expect(201);
    const workId = imported.body.data.work.id;
    expect(imported.body.data.work).toMatchObject({ title: "导入书名", chapterCount: 1 });
    expect(imported.body.data).not.toHaveProperty("tree");
    expect(JSON.stringify(imported.body)).not.toContain("故事开始。");

    const uploaded = await request(runtime.app).put(`/api/works/${workId}/cover`).attach("file", validPng, "cover.png").expect(200);
    expect(uploaded.body.data.coverUrl).toContain(`/api/works/${workId}/cover?v=`);
    const cover = await request(runtime.app).get(`/api/works/${workId}/cover`).expect(200).expect("Content-Type", /image\/png/u);
    expect(cover.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(cover.body).toEqual(validPng);
    await request(runtime.app).put(`/api/works/${workId}/cover`).attach("file", validJpeg, "cover.jpg").expect(200);
    await request(runtime.app).get(`/api/works/${workId}/cover`).expect(200).expect("Content-Type", /image\/jpeg/u);
    await request(runtime.app).put(`/api/works/${workId}/cover`).attach("file", validWebp, "cover.webp").expect(200);
    await request(runtime.app).get(`/api/works/${workId}/cover`).expect(200).expect("Content-Type", /image\/webp/u);
    const gifCover = await request(runtime.app).put(`/api/works/${workId}/cover`).attach("file", validGif, "cover.gif").expect(415);
    expect(gifCover.body.error).toEqual({
      code: "UNSUPPORTED_COVER_FORMAT",
      message: "封面不支持 GIF 图片"
    });
    const oversizedPng = Buffer.from(validPng);
    oversizedPng.writeUInt32BE(5_000, 16);
    await request(runtime.app).put(`/api/works/${workId}/cover`).attach("file", oversizedPng, "oversized.png").expect(415);
    await request(runtime.app).put(`/api/works/${workId}/cover`).attach("file", validPng.subarray(0, 16), "truncated.png").expect(415);
    await request(runtime.app).put(`/api/works/${workId}/cover`).attach("file", Buffer.from("<svg></svg>"), "cover.svg").expect(415);
    const oversizedPngUpload = await request(runtime.app).put("/api/works/" + workId + "/cover")
      .attach("file", pngOfSize(maximumStandardImageUploadBytes + 1), "too-large.png")
      .expect(413);
    expect(oversizedPngUpload.body.error.code).toBe("IMAGE_TOO_LARGE");
    expect(oversizedPngUpload.body.error.message).toBe("封面图片不能超过 5 MB");
    const oversizedGifUpload = await request(runtime.app).put("/api/works/" + workId + "/cover")
      .attach("file", gifOfSize(maximumStandardImageUploadBytes + 1), "too-large.gif")
      .expect(413);
    expect(oversizedGifUpload.body.error.code).toBe("IMAGE_TOO_LARGE");
    expect(oversizedGifUpload.body.error.message).toBe("封面图片不能超过 5 MB");
    await request(runtime.app).delete(`/api/works/${workId}/cover`).expect(204);
    await request(runtime.app).get(`/api/works/${workId}/cover`).expect(404);
  });

  it("维护逐章大纲、伏笔关联、未回收与逾期状态", async () => {
    const { workId, chapters } = await seedWork(runtime);
    const outline = await request(runtime.app).put(`/api/chapters/${chapters[0].id}/outline`).send({
      goal: "建立旧友关系",
      conflict: "是否公开旧信",
      turningPoint: "发现信件被调包",
      status: "ready"
    }).expect(200);
    expect(outline.body.data).toMatchObject({ goal: "建立旧友关系", status: "ready" });

    const foreshadow = await request(runtime.app).post(`/api/works/${workId}/foreshadows`).send({
      title: "旧信的真正内容",
      description: "信件将在第三章揭示真相",
      importance: "high",
      status: "planted",
      plannedPayoffChapterId: chapters[1].id,
      occurrences: [{ chapterId: chapters[0].id, role: "setup", note: "首次出现旧信" }]
    }).expect(201);
    const unresolved = await request(runtime.app).get(`/api/works/${workId}/foreshadows?status=unresolved&currentChapterId=${chapters[2].id}`).expect(200);
    expect(unresolved.body.data[0]).toMatchObject({ unresolved: true, overdue: true });

    const resolved = await request(runtime.app).patch(`/api/foreshadows/${foreshadow.body.data.id}`).send({
      status: "resolved",
      resolutionNote: "第三章完成回收",
      plannedPayoffChapterId: chapters[2].id,
      occurrences: [
        { chapterId: chapters[0].id, role: "setup" },
        { chapterId: chapters[2].id, role: "payoff", note: "真相揭晓" }
      ]
    }).expect(200);
    expect(resolved.body.data).toMatchObject({ unresolved: false, resolutionNote: "第三章完成回收" });
    const otherWork = await seedWork(runtime, "跨作品章节");
    await request(runtime.app).post(`/api/foreshadows/${foreshadow.body.data.id}/occurrences`).send({
      chapterId: otherWork.chapters[0].id,
      role: "reminder"
    }).expect(400);
    const outlines = await request(runtime.app).get(`/api/works/${workId}/outlines`).expect(200);
    expect(outlines.body.data[0]).toMatchObject({ goal: "建立旧友关系", volumeTitle: "第一卷" });
    const exported = await request(runtime.app).get(`/api/works/${workId}/export?format=json`).expect(200);
    expect(exported.body.data).toMatchObject({ schemaVersion: 8, races: [] });
    expect(exported.body.data.foreshadows[0].occurrences).toHaveLength(2);
  });

  it("按分卷聚合全书大纲看板并只返回有界摘要", async () => {
    const { workId, chapters } = await seedWork(runtime, "大纲看板作品");
    const secondVolume = await request(runtime.app).post(`/api/works/${workId}/volumes`).send({ title: "第二卷" }).expect(201);
    const fourthChapter = await request(runtime.app).post(`/api/works/${workId}/chapters`).send({
      volumeId: secondVolume.body.data.id,
      title: "第四章 潮门",
      content: "这一段正文不应出现在只读看板响应中。"
    }).expect(201);
    const recycledChapter = await request(runtime.app).post(`/api/works/${workId}/chapters`).send({
      volumeId: secondVolume.body.data.id,
      title: "回收站章节",
      content: "已删除章节不应出现在看板中。"
    }).expect(201);
    await request(runtime.app).put(`/api/chapters/${recycledChapter.body.data.id}/outline`).send({
      goal: "已删除的大纲",
      status: "ready"
    }).expect(200);
    await request(runtime.app).delete(`/api/chapters/${recycledChapter.body.data.id}`).send({ expectedVersionNo: 1 }).expect(204);
    const emptyVolume = await request(runtime.app).post(`/api/works/${workId}/volumes`).send({ title: "空卷" }).expect(201);
    const longGoal = `寻找旧港真相${"长".repeat(700)}`;
    await request(runtime.app).put(`/api/chapters/${chapters[0].id}/outline`).send({
      goal: longGoal,
      conflict: "守望会拒绝开放档案",
      turningPoint: "旧信指向潮门",
      status: "ready"
    }).expect(200);
    await request(runtime.app).put(`/api/chapters/${fourthChapter.body.data.id}/outline`).send({
      goal: "进入潮门",
      status: "completed"
    }).expect(200);
    const unresolved = await request(runtime.app).post(`/api/works/${workId}/foreshadows`).send({
      title: "旧信坐标",
      status: "planted",
      importance: "high",
      plannedPayoffChapterId: fourthChapter.body.data.id,
      occurrences: [{ chapterId: chapters[0].id, role: "setup" }]
    }).expect(201);
    const resolved = await request(runtime.app).post(`/api/works/${workId}/foreshadows`).send({
      title: "铜钥匙",
      status: "resolved",
      occurrences: [{ chapterId: chapters[0].id, role: "payoff" }]
    }).expect(201);
    const beforeRead = {
      audits: runtime.database.get("SELECT COUNT(*) AS count FROM audit_logs")?.count,
      versions: runtime.database.get("SELECT COUNT(*) AS count FROM entity_versions")?.count
    };

    const response = await request(runtime.app).get(`/api/works/${workId}/outline-board`).expect(200);
    expect(response.body.data).toMatchObject({
      workId,
      page: 1,
      limit: 30,
      itemCount: 4,
      total: 4,
      pageCount: 1,
      hasMore: false,
      stats: { chapterCount: 4, outlinedChapterCount: 2, foreshadowCount: 2, unresolvedForeshadowCount: 1 }
    });
    expect(response.body.data.volumes.map((volume: Record<string, unknown>) => volume.title)).toEqual(["第一卷", "第二卷", "空卷"]);
    expect(response.body.data.volumes[2]).toMatchObject({ id: emptyVolume.body.data.id, chapters: [] });
    const firstChapter = response.body.data.volumes[0].chapters[0];
    expect(firstChapter.outline).toMatchObject({ status: "ready", truncated: true });
    expect(firstChapter.outline.goal).toHaveLength(600);
    expect(firstChapter.foreshadows).toEqual([
      expect.objectContaining({ id: unresolved.body.data.id, status: "planted", roles: ["setup"], plannedPayoff: false }),
      expect.objectContaining({ id: resolved.body.data.id, status: "resolved", roles: ["payoff"], plannedPayoff: false })
    ]);
    expect(response.body.data.volumes[1].chapters[0].foreshadows).toEqual([
      expect.objectContaining({ id: unresolved.body.data.id, roles: [], plannedPayoff: true })
    ]);
    expect(JSON.stringify(response.body.data)).not.toContain("回收站章节");
    expect(JSON.stringify(response.body.data)).not.toContain("这一段正文不应出现在只读看板响应中");

    const paged = await request(runtime.app).get(`/api/works/${workId}/outline-board?page=2&limit=1`).expect(200);
    expect(paged.body.data).toMatchObject({ page: 2, limit: 1, itemCount: 1, total: 4, pageCount: 4, hasMore: true, nextPage: 3 });
    expect(paged.body.data.volumes.flatMap((volume: { chapters: unknown[] }) => volume.chapters)).toHaveLength(1);

    const searched = await request(runtime.app).get(`/api/works/${workId}/outline-board?q=${encodeURIComponent("旧信坐标")}`).expect(200);
    expect(searched.body.data.total).toBe(2);
    expect(searched.body.data.volumes.flatMap((volume: { chapters: Array<{ id: string }> }) => volume.chapters).map((chapter: { id: string }) => chapter.id))
      .toEqual([chapters[0].id, fourthChapter.body.data.id]);

    const completed = await request(runtime.app)
      .get(`/api/works/${workId}/outline-board?volumeId=${secondVolume.body.data.id}&outlineStatus=completed&foreshadowStatus=unresolved`)
      .expect(200);
    expect(completed.body.data.total).toBe(1);
    expect(completed.body.data.volumes[0].chapters[0].id).toBe(fourthChapter.body.data.id);

    const empty = await request(runtime.app).get(`/api/works/${workId}/outline-board?volumeId=${emptyVolume.body.data.id}`).expect(200);
    expect(empty.body.data).toMatchObject({ total: 0, itemCount: 0 });
    expect(empty.body.data.volumes).toEqual([expect.objectContaining({ id: emptyVolume.body.data.id, chapterCount: 0, chapters: [] })]);

    await request(runtime.app).get(`/api/works/${workId}/outline-board?outlineStatus=unknown`).expect(400);
    await request(runtime.app).get(`/api/works/${workId}/outline-board?limit=101`).expect(400);
    const fullOutline = await request(runtime.app).get(`/api/chapters/${chapters[0].id}/outline`).expect(200);
    expect(fullOutline.body.data.goal).toBe(longGoal);
    expect({
      audits: runtime.database.get("SELECT COUNT(*) AS count FROM audit_logs")?.count,
      versions: runtime.database.get("SELECT COUNT(*) AS count FROM entity_versions")?.count
    }).toEqual(beforeRead);

    const sortedPayoffA = await request(runtime.app).post(`/api/works/${workId}/foreshadows`).send({
      title: "潮门密钥",
      status: "planned",
      plannedPayoffChapterId: chapters[2].id
    }).expect(201);
    const sortedPayoffB = await request(runtime.app).post(`/api/works/${workId}/foreshadows`).send({
      title: "港口暗号",
      status: "planted",
      plannedPayoffChapterId: chapters[2].id
    }).expect(201);
    const sorted = await request(runtime.app).get(`/api/works/${workId}/outline-board?sort=foreshadows`).expect(200);
    expect(sorted.body.data.volumes[0].chapters.map((chapter: { id: string }) => chapter.id)).toEqual([
      chapters[2].id,
      chapters[0].id,
      chapters[1].id
    ]);
    expect(sorted.body.data.volumes[0].chapters[0].foreshadows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: sortedPayoffA.body.data.id, roles: [], plannedPayoff: true }),
      expect.objectContaining({ id: sortedPayoffB.body.data.id, roles: [], plannedPayoff: true })
    ]));

    const otherWork = await seedWork(runtime, "隔离作品大纲");
    await request(runtime.app).put(`/api/chapters/${otherWork.chapters[0].id}/outline`).send({ goal: "CROSS_WORK_OUTLINE_SECRET" }).expect(200);
    const isolated = await request(runtime.app).get(`/api/works/${workId}/outline-board`).expect(200);
    expect(JSON.stringify(isolated.body.data)).not.toContain("CROSS_WORK_OUTLINE_SECRET");
    await request(runtime.app).get("/api/works/not-a-work/outline-board").expect(404);
  });

  it("按去重伏笔关联统计排序并保留作品、回收站、分页和章节树语义", async () => {
    const { workId, volumeId, chapters } = await seedWork(runtime, "伏笔排序语义 fixture");
    const fourthChapter = await request(runtime.app).post(`/api/works/${workId}/chapters`).send({
      volumeId,
      title: "第四章 并列",
      content: ""
    }).expect(201);

    const shared = await request(runtime.app).post(`/api/works/${workId}/foreshadows`).send({
      title: "同章多重关联",
      status: "planned",
      plannedPayoffChapterId: chapters[0].id,
      occurrences: [
        { chapterId: chapters[0].id, role: "setup" },
        { chapterId: chapters[0].id, role: "reminder" }
      ]
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/foreshadows`).send({
      title: "第一章已回收",
      status: "resolved",
      occurrences: [{ chapterId: chapters[0].id, role: "payoff" }]
    }).expect(201);
    for (const [index, association] of [
      { chapterId: chapters[1].id, status: "planned", plannedPayoff: false },
      { chapterId: chapters[1].id, status: "planted", plannedPayoff: true },
      { chapterId: chapters[2].id, status: "planned", plannedPayoff: false },
      { chapterId: chapters[2].id, status: "resolved", plannedPayoff: false },
      { chapterId: chapters[2].id, status: "abandoned", plannedPayoff: true },
      { chapterId: fourthChapter.body.data.id, status: "planted", plannedPayoff: false },
      { chapterId: fourthChapter.body.data.id, status: "resolved", plannedPayoff: true },
      { chapterId: fourthChapter.body.data.id, status: "abandoned", plannedPayoff: false }
    ].entries()) {
      await request(runtime.app).post(`/api/works/${workId}/foreshadows`).send({
        title: `排序伏笔 ${index + 1}`,
        status: association.status,
        ...(association.plannedPayoff
          ? { plannedPayoffChapterId: association.chapterId }
          : { occurrences: [{ chapterId: association.chapterId, role: "setup" }] })
      }).expect(201);
    }

    const recycledVolume = await request(runtime.app).post(`/api/works/${workId}/volumes`).send({ title: "回收卷" }).expect(201);
    const recycledChapter = await request(runtime.app).post(`/api/works/${workId}/chapters`).send({
      volumeId: recycledVolume.body.data.id,
      title: "回收卷章节",
      content: ""
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/foreshadows`).send({
      title: "回收卷高计数伏笔",
      status: "planned",
      plannedPayoffChapterId: recycledChapter.body.data.id
    }).expect(201);
    await request(runtime.app).delete(`/api/volumes/${recycledVolume.body.data.id}`).send({ expectedVersionNo: 1 }).expect(204);

    const otherWork = await seedWork(runtime, "其他作品排序 fixture");
    const timestamp = "2026-08-15T00:00:00.000Z";
    runtime.database.run(
      `INSERT INTO foreshadows
         (id, work_id, title, status, importance, planned_payoff_chapter_id, created_at, updated_at)
       VALUES (?, ?, ?, 'planned', 'high', ?, ?, ?)`,
      "cross-work-sort-foreshadow",
      otherWork.workId,
      "跨作品关联不得计数",
      chapters[0].id,
      timestamp,
      timestamp
    );

    const sorted = await request(runtime.app).get(`/api/works/${workId}/outline-board?sort=foreshadows`).expect(200);
    expect(sorted.body.data.volumes.flatMap((volume: { chapters: Array<{ id: string }> }) => volume.chapters)
      .map((chapter: { id: string }) => chapter.id)).toEqual([
      chapters[1].id,
      chapters[2].id,
      fourthChapter.body.data.id,
      chapters[0].id
    ]);
    expect(sorted.body.data.volumes[0].chapters[3].foreshadows.filter(
      (foreshadow: { id: string }) => foreshadow.id === shared.body.data.id
    )).toHaveLength(1);
    expect(JSON.stringify(sorted.body.data)).not.toContain("回收卷章节");
    expect(JSON.stringify(sorted.body.data)).not.toContain("跨作品关联不得计数");

    const secondPage = await request(runtime.app)
      .get(`/api/works/${workId}/outline-board?sort=foreshadows&page=2&limit=2`)
      .expect(200);
    expect(secondPage.body.data).toMatchObject({ page: 2, limit: 2, itemCount: 2, total: 4 });
    expect(secondPage.body.data.volumes.flatMap((volume: { chapters: Array<{ id: string }> }) => volume.chapters)
      .map((chapter: { id: string }) => chapter.id)).toEqual([
      fourthChapter.body.data.id,
      chapters[0].id
    ]);
  });

  it("对两千章和两万伏笔预聚合一次关联并保持排序查询有界", async () => {
    const work = await request(runtime.app).post("/api/works").send({ title: "伏笔排序性能 fixture" }).expect(201);
    const workId = String(work.body.data.id);
    const volume = await request(runtime.app).post(`/api/works/${workId}/volumes`).send({ title: "第一卷" }).expect(201);
    const volumeId = String(volume.body.data.id);
    const timestamp = "2026-08-15T00:00:00.000Z";
    const insertChapter = runtime.database.raw.prepare(
      `INSERT INTO chapters (id, work_id, volume_id, title, content, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', ?, ?, ?)`
    );
    const insertForeshadow = runtime.database.raw.prepare(
      `INSERT INTO foreshadows
         (id, work_id, title, status, importance, planned_payoff_chapter_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'medium', ?, ?, ?)`
    );
    const insertOccurrence = runtime.database.raw.prepare(
      `INSERT INTO foreshadow_occurrences
         (id, foreshadow_id, chapter_id, role, created_at, updated_at)
       VALUES (?, ?, ?, 'setup', ?, ?)`
    );
    runtime.database.transaction(() => {
      for (let index = 0; index < 2_000; index += 1) {
        insertChapter.run(
          `sort-perf-chapter-${index}`,
          workId,
          volumeId,
          `第 ${index + 1} 章`,
          index,
          timestamp,
          timestamp
        );
      }
      const statuses = ["planned", "planted", "resolved", "abandoned"] as const;
      for (let index = 0; index < 20_000; index += 1) {
        const foreshadowId = `sort-perf-foreshadow-${index}`;
        const payoffChapterId = `sort-perf-chapter-${index % 2_000}`;
        const occurrenceChapterId = index % 2 === 0
          ? payoffChapterId
          : `sort-perf-chapter-${(index * 17 + 1) % 2_000}`;
        insertForeshadow.run(
          foreshadowId,
          workId,
          `性能伏笔 ${index + 1}`,
          statuses[index % statuses.length]!,
          payoffChapterId,
          timestamp,
          timestamp
        );
        insertOccurrence.run(
          `sort-perf-occurrence-${index}`,
          foreshadowId,
          occurrenceChapterId,
          timestamp,
          timestamp
        );
      }
    });

    const plan = runtime.database.all(
      `EXPLAIN QUERY PLAN ${chapterOutlineBoardForeshadowSortSql.cte}
       SELECT chapter.id
       FROM chapters chapter
       JOIN volumes volume ON volume.id = chapter.volume_id AND volume.work_id = chapter.work_id
       LEFT JOIN chapter_outlines outline ON outline.chapter_id = chapter.id
       ${chapterOutlineBoardForeshadowSortSql.join}
       WHERE chapter.work_id = ? AND chapter.deleted_at IS NULL AND volume.deleted_at IS NULL
       ORDER BY volume.sort_order, volume.created_at, volume.id,
         ${chapterOutlineBoardForeshadowSortSql.order}, chapter.sort_order, chapter.created_at, chapter.id
       LIMIT ? OFFSET ?`,
      workId,
      workId,
      workId,
      31,
      0
    );
    const planDetails = plan.map((step) => String(step.detail));
    expect(planDetails.some((detail) => detail.includes("MATERIALIZE foreshadow_association_counts"))).toBe(true);
    expect(planDetails.some((detail) => detail.includes("CORRELATED"))).toBe(false);
    expect(planDetails.some((detail) => (
      detail.includes("SEARCH foreshadow USING INDEX idx_foreshadows_work_payoff_status (work_id=?)")
    ))).toBe(true);

    const startedAt = performance.now();
    const sorted = await request(runtime.app).get(`/api/works/${workId}/outline-board?sort=foreshadows`).expect(200);
    const elapsedMs = performance.now() - startedAt;
    expect(sorted.body.data).toMatchObject({ total: 2_000, itemCount: 30, hasMore: true });
    expect(sorted.body.data.stats).toMatchObject({ foreshadowCount: 20_000, unresolvedForeshadowCount: 10_000 });
    expect(elapsedMs).toBeLessThan(3_000);
  });

  it("对五千章大作品保持看板响应、查询耗时和当前页关联有界", async () => {
    const work = await request(runtime.app).post("/api/works").send({ title: "五千章看板 fixture" }).expect(201);
    const workId = String(work.body.data.id);
    const firstVolume = await request(runtime.app).post(`/api/works/${workId}/volumes`).send({ title: "第一卷" }).expect(201);
    const secondVolume = await request(runtime.app).post(`/api/works/${workId}/volumes`).send({ title: "第二卷" }).expect(201);
    const emptyVolume = await request(runtime.app).post(`/api/works/${workId}/volumes`).send({ title: "空卷" }).expect(201);
    const timestamp = "2026-08-13T00:00:00.000Z";
    const targetIndex = 4_320;
    const targetChapterId = `large-chapter-${targetIndex}`;

    runtime.database.transaction(() => {
      for (let index = 0; index < 5_000; index += 1) {
        const chapterId = `large-chapter-${index}`;
        runtime.database.run(
          `INSERT INTO chapters (id, work_id, volume_id, title, content, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          chapterId,
          workId,
          index < 2_500 ? firstVolume.body.data.id : secondVolume.body.data.id,
          index === targetIndex ? `第 ${index + 1} 章 UNIQUE_NEEDLE` : `第 ${index + 1} 章`,
          index === targetIndex ? "LARGE_BOARD_PROSE_SECRET" : "",
          index,
          timestamp,
          timestamp
        );
        if (index % 10 === 0) {
          runtime.database.run(
            `INSERT INTO chapter_outlines (chapter_id, goal, conflict, turning_point, notes, status, created_at, updated_at)
             VALUES (?, ?, '', '', '', ?, ?, ?)`,
            chapterId,
            index === targetIndex ? "找到 UNIQUE_NEEDLE 对应的旧信坐标" : `规划第 ${index + 1} 章`,
            index % 20 === 0 ? "ready" : "draft",
            timestamp,
            timestamp
          );
        }
      }
    });
    const foreshadow = await request(runtime.app).post(`/api/works/${workId}/foreshadows`).send({
      title: "五千章中的目标伏笔",
      status: "planted",
      plannedPayoffChapterId: targetChapterId,
      occurrences: [{ chapterId: targetChapterId, role: "reminder" }]
    }).expect(201);

    const startedAt = performance.now();
    const initial = await request(runtime.app).get(`/api/works/${workId}/outline-board`).expect(200);
    const elapsedMs = performance.now() - startedAt;
    const serialized = JSON.stringify(initial.body.data);
    expect(initial.body.data).toMatchObject({
      page: 1,
      limit: 30,
      itemCount: 30,
      total: 5_000,
      hasMore: true,
      nextPage: 2,
      stats: { chapterCount: 5_000, outlinedChapterCount: 500, foreshadowCount: 1, unresolvedForeshadowCount: 1 }
    });
    expect(initial.body.data.volumes.flatMap((volume: { chapters: unknown[] }) => volume.chapters)).toHaveLength(30);
    expect(initial.body.data.volumes).toContainEqual(expect.objectContaining({ id: emptyVolume.body.data.id, chapters: [] }));
    expect(Buffer.byteLength(serialized)).toBeLessThan(150_000);
    expect(serialized).not.toContain("LARGE_BOARD_PROSE_SECRET");
    expect(elapsedMs).toBeLessThan(3_000);

    const searchedAt = performance.now();
    const searched = await request(runtime.app).get(`/api/works/${workId}/outline-board?q=UNIQUE_NEEDLE`).expect(200);
    expect(performance.now() - searchedAt).toBeLessThan(3_000);
    expect(searched.body.data).toMatchObject({ total: 1, itemCount: 1 });
    expect(searched.body.data.volumes[0].chapters[0]).toMatchObject({
      id: targetChapterId,
      outline: { goal: "找到 UNIQUE_NEEDLE 对应的旧信坐标" },
      foreshadows: [expect.objectContaining({ id: foreshadow.body.data.id, roles: ["reminder"], plannedPayoff: true })]
    });

    const crossVolume = await request(runtime.app)
      .get(`/api/works/${workId}/outline-board?volumeId=${secondVolume.body.data.id}&outlineStatus=ready&page=2&limit=50`)
      .expect(200);
    expect(crossVolume.body.data).toMatchObject({ page: 2, limit: 50, itemCount: 50, total: 125 });
    expect(crossVolume.body.data.volumes.every((volume: { id: string }) => volume.id === secondVolume.body.data.id)).toBe(true);

    const unresolved = await request(runtime.app).get(`/api/works/${workId}/outline-board?foreshadowStatus=unresolved`).expect(200);
    expect(unresolved.body.data).toMatchObject({ total: 1, itemCount: 1 });
    expect(unresolved.body.data.volumes[0].chapters[0].id).toBe(targetChapterId);

    const fullOutline = await request(runtime.app).get(`/api/chapters/${targetChapterId}/outline`).expect(200);
    expect(fullOutline.body.data.goal).toBe("找到 UNIQUE_NEEDLE 对应的旧信坐标");
  });

  it("按当前章节返回伏笔提醒并通过现有版本与审计链标记回收", async () => {
    const { workId, chapters } = await seedWork(runtime);
    const reminder = await request(runtime.app).post(`/api/works/${workId}/foreshadows`).send({
      title: "旧信上的火漆",
      description: "火漆纹章指向失踪的议员。",
      importance: "high",
      status: "planted",
      occurrences: [
        { chapterId: chapters[0].id, role: "setup", note: "旧信首次出现" },
        { chapterId: chapters[1].id, role: "reminder", note: "再次看见破损火漆" }
      ]
    }).expect(201);
    const secondReminder = await request(runtime.app).post(`/api/works/${workId}/foreshadows`).send({
      title: "未兑现的旧约",
      status: "planned",
      occurrences: [{ chapterId: chapters[1].id, role: "reminder", note: "主角想起约定" }]
    }).expect(201);
    const payoff = await request(runtime.app).post(`/api/works/${workId}/foreshadows`).send({
      title: "密钥真相",
      status: "planted",
      occurrences: [{ chapterId: chapters[2].id, role: "payoff", note: "密钥开启档案室" }]
    }).expect(201);
    const setupOnly = await request(runtime.app).post(`/api/works/${workId}/foreshadows`).send({
      title: "仅在本章埋设",
      status: "planted",
      occurrences: [{ chapterId: chapters[1].id, role: "setup" }]
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/foreshadows`).send({
      title: "已经回收",
      status: "resolved",
      occurrences: [{ chapterId: chapters[1].id, role: "reminder" }]
    }).expect(201);

    const reminderChapter = await request(runtime.app)
      .get(`/api/works/${workId}/chapters/${chapters[1].id}/foreshadow-reminders`)
      .expect(200);
    expect(reminderChapter.body.data).toEqual([
      expect.objectContaining({
        foreshadowId: reminder.body.data.id,
        title: "旧信上的火漆",
        description: "火漆纹章指向失踪的议员。",
        role: "reminder",
        note: "再次看见破损火漆",
        importance: "high",
        status: "planted",
        versionNo: reminder.body.data.versionNo
      }),
      expect.objectContaining({ foreshadowId: secondReminder.body.data.id, role: "reminder" })
    ]);
    expect(reminderChapter.body.data[0]).not.toHaveProperty("occurrences");
    expect(reminderChapter.body.data[0]).not.toHaveProperty("resolutionNote");

    const payoffChapter = await request(runtime.app)
      .get(`/api/works/${workId}/chapters/${chapters[2].id}/foreshadow-reminders`)
      .expect(200);
    expect(payoffChapter.body.data).toEqual([
      expect.objectContaining({ foreshadowId: payoff.body.data.id, role: "payoff", note: "密钥开启档案室" })
    ]);
    await request(runtime.app)
      .get(`/api/works/${workId}/chapters/${chapters[0].id}/foreshadow-reminders`)
      .expect(200, { data: [] });

    const otherWork = await seedWork(runtime, "其他作品的章节");
    const crossWork = await request(runtime.app)
      .get(`/api/works/${workId}/chapters/${otherWork.chapters[0].id}/foreshadow-reminders`)
      .expect(400);
    expect(crossWork.body.error.code).toBe("CHAPTER_WORK_MISMATCH");

    const currentReminder = reminderChapter.body.data[0] as Record<string, unknown>;
    const resolved = await request(runtime.app)
      .post(`/api/works/${workId}/chapters/${chapters[1].id}/foreshadow-reminders/${reminder.body.data.id}/resolve`)
      .send({ expectedVersionNo: currentReminder.versionNo })
      .expect(200);
    expect(resolved.body.data).toMatchObject({
      foreshadowId: reminder.body.data.id,
      status: "resolved",
      versionNo: Number(currentReminder.versionNo) + 1
    });
    const remaining = await request(runtime.app)
      .get(`/api/works/${workId}/chapters/${chapters[1].id}/foreshadow-reminders`)
      .expect(200);
    expect(remaining.body.data).toEqual([
      expect.objectContaining({ foreshadowId: secondReminder.body.data.id })
    ]);

    const latestVersion = runtime.database.get(
      `SELECT source, source_ref, change_note, snapshot_json FROM entity_versions
       WHERE entity_type = 'foreshadow' AND entity_id = ? ORDER BY version_no DESC LIMIT 1`,
      reminder.body.data.id
    );
    expect(latestVersion).toMatchObject({
      source: "manual",
      source_ref: currentReminder.occurrenceId,
      change_note: "在编辑器标记伏笔已回收"
    });
    expect(JSON.parse(String(latestVersion?.snapshot_json))).toMatchObject({ status: "resolved" });
    const audit = runtime.database.get(
      "SELECT action, detail_json FROM audit_logs WHERE entity_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      reminder.body.data.id
    );
    expect(audit?.action).toBe("foreshadow.updated");
    expect(JSON.parse(String(audit?.detail_json))).toMatchObject({
      fields: ["status"],
      source: "manual",
      sourceRef: currentReminder.occurrenceId
    });

    const stale = await request(runtime.app)
      .post(`/api/works/${workId}/chapters/${chapters[1].id}/foreshadow-reminders/${secondReminder.body.data.id}/resolve`)
      .send({ expectedVersionNo: Number(secondReminder.body.data.versionNo) + 1 })
      .expect(409);
    expect(stale.body.error.code).toBe("VERSION_CONFLICT");
    await request(runtime.app)
      .post(`/api/works/${workId}/chapters/${chapters[1].id}/foreshadow-reminders/${setupOnly.body.data.id}/resolve`)
      .send({ expectedVersionNo: setupOnly.body.data.versionNo })
      .expect(404);
    expect(runtime.database.get("SELECT status FROM foreshadows WHERE id = ?", secondReminder.body.data.id)?.status).toBe("planned");
    expect(runtime.database.get("SELECT status FROM foreshadows WHERE id = ?", setupOnly.body.data.id)?.status).toBe("planted");
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });
});

describe("AI 分析目标导航 API", () => {
  let runtime: Runtime;

  beforeEach(() => { runtime = createTestRuntime(); });
  afterEach(() => runtime.close());

  it("仅为单一人物或指定章节返回可导航目标", async () => {
    const { workId, chapters } = await seedWork(runtime);
    const character = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "林舟" }).expect(201);
    const secondCharacter = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "沈星" }).expect(201);
    const modelId = await configureAi(runtime, workId);
    const characterTask = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "relationship-analysis",
      modelId,
      scope: { type: "book", characterIds: [character.body.data.id] }
    }).expect(201);
    expect(characterTask.body.data.scopeTarget).toEqual({
      type: "character",
      id: character.body.data.id,
      label: "林舟"
    });
    const chapterTask = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "chapter-analysis",
      modelId,
      scope: { type: "chapter", chapterId: chapters[0].id }
    }).expect(201);
    expect(chapterTask.body.data.scopeTarget).toEqual({
      type: "chapter",
      id: chapters[0].id,
      label: "第一卷 · 第一章 埋线"
    });
    const multipleCharacterTask = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "relationship-analysis",
      modelId,
      scope: { type: "book", characterIds: [character.body.data.id, secondCharacter.body.data.id] }
    }).expect(201);
    expect(multipleCharacterTask.body.data.scopeTarget).toBeNull();

    const taskPage = await request(runtime.app).get(`/api/works/${workId}/tasks?page=1&limit=30`).expect(200);
    expect(taskPage.body.data.items.find((item: { id: string }) => item.id === characterTask.body.data.id)?.scopeTarget).toEqual({
      type: "character",
      id: character.body.data.id,
      label: "林舟"
    });
    expect(taskPage.body.data.items.find((item: { id: string }) => item.id === chapterTask.body.data.id)?.scopeTarget).toEqual({
      type: "chapter",
      id: chapters[0].id,
      label: "第一卷 · 第一章 埋线"
    });
    expect(taskPage.body.data.items.find((item: { id: string }) => item.id === multipleCharacterTask.body.data.id)?.scopeTarget).toBeNull();
  });

  it("创建定向关系任务时只读取来源版本元数据", async () => {
    const { workId, chapters } = await seedWork(runtime);
    const character = await request(runtime.app).post(`/api/works/${workId}/characters`).send({
      name: "林舟",
      profile: { identity: "调查员", background: "长期人物档案".repeat(2_000) }
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "沈星" }).expect(201);
    const setting = await request(runtime.app).post(`/api/works/${workId}/settings`).send({
      title: "北港旧约",
      category: "人物关系",
      content: "林舟与沈星共同遵守北港旧约。".repeat(2_000)
    }).expect(201);
    const fullReadSpies = [
      vi.spyOn(runtime.store, "getWorkTree"),
      vi.spyOn(runtime.store, "getCharacter"),
      vi.spyOn(runtime.store, "listCharacters"),
      vi.spyOn(runtime.store, "listSettings"),
      vi.spyOn(runtime.store, "listRaces"),
      vi.spyOn(runtime.store, "listOrganizations"),
      vi.spyOn(runtime.store, "listRelationships")
    ];

    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "relationship-analysis",
      scope: {
        type: "book",
        includeAllSettings: true,
        characterIds: [character.body.data.id],
        preFilterRelationshipSources: true,
        previewRelationshipChanges: true,
        relationshipSourceRefs: [
          { sourceType: "chapter", sourceId: chapters[0].id, sourceVersion: String(chapters[0].versionNo) },
          { sourceType: "setting", sourceId: setting.body.data.id, sourceVersion: String(setting.body.data.versionNo) }
        ]
      }
    }).expect(201);

    expect(task.body.data).toMatchObject({
      status: "pending",
      scope: { targetCharacters: [{ id: character.body.data.id, name: "林舟" }] }
    });
    expect(task.body.data.sourceVersions).toMatchObject({
      [chapters[0].id]: chapters[0].versionNo,
      [`character:${character.body.data.id}`]: character.body.data.versionNo,
      [`setting:${setting.body.data.id}`]: setting.body.data.versionNo
    });
    for (const spy of fullReadSpies) expect(spy).not.toHaveBeenCalled();
  });
});

describe("续写守卫和全书关系 Map-Reduce", () => {
  let runtime: Runtime;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  afterEach(() => runtime.close());

  it("全书角色抽取先生成预览，确认后落库并过滤通用称谓", async () => {
    fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }>; max_tokens: number };
      const prompt = body.messages[1]?.content ?? "";
      expect(body.messages[0]?.content).toContain("人物规范化抽取器");
      const chapters = [...prompt.matchAll(/<CHAPTER id="([^"]+)" title="([^"]+)"[^>]*>/gu)];
      if (chapters.length > 1) {
        return new Response(JSON.stringify({ error: { code: "temporary_large_batch_failure" } }), { status: 503, headers: { "Content-Type": "application/json" } });
      }
      if (chapters.length === 1 && prompt.includes("背景记录") && !prompt.includes('fragment="')) {
        return new Response(JSON.stringify({ error: { code: "security_audit_fail" } }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      const chapter = chapters[0];
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([
        { canonicalName: "林舟", aliases: ["小舟", "舰长", "G"], identity: "调查员", firstEvidence: { chapterId: chapter?.[1], chapterTitle: chapter?.[2], quote: "林舟在北港见到沈星" } },
        { canonicalName: "沈星", aliases: ["沈博士", "博士"], identity: "通讯官", firstEvidence: { chapterId: chapter?.[1], chapterTitle: chapter?.[2], quote: "沈星说：我们一直是朋友" } }
      ]) } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    runtime = createTestRuntime(fetchMock);
    const { workId, chapters } = await seedWork(runtime);
    await request(runtime.app).patch(`/api/chapters/${chapters[0].id}`).send({
      content: `林舟在北港见到沈星。沈星说：我们一直是朋友。${"背景记录。".repeat(360)}`
    }).expect(200);
    const modelId = await configureAi(runtime, workId);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({ taskType: "character-extraction", scope: { type: "book" } }).expect(201);
    const result = await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId }).expect(200);
    expect(result.body.data.result).toMatchObject({
      savedCount: 0,
      candidateCount: 2,
      coveredChapterCount: 3,
      fallbackSegmentCount: 0,
      characterApplication: { status: "pending", totalCount: 2 }
    });
    const prompts = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).messages[1].content as string);
    expect(prompts.filter((prompt) => (prompt.match(/<CHAPTER id=/gu) ?? []).length > 1)).toHaveLength(4);
    expect(prompts.some((prompt) => prompt.includes('fragment="'))).toBe(true);
    const beforeApply = await request(runtime.app).get(`/api/works/${workId}/characters`).expect(200);
    expect(beforeApply.body.data).toEqual([]);
    const applied = await applySuggestedCharacterCandidates(runtime, task.body.data.id);
    expect(applied.body.data).toMatchObject({ createdCount: 2, mergedCount: 0 });
    const characters = await request(runtime.app).get(`/api/works/${workId}/characters`).expect(200);
    const byName = new Map(characters.body.data.map((character: { name: string }) => [character.name, character]));
    expect((byName.get("林舟") as { aliases: string[] }).aliases).toEqual(["小舟"]);
    expect((byName.get("沈星") as { aliases: string[] }).aliases).toEqual(["沈博士"]);
  });

  it("角色职称变体在预览前经 AI 确认同一人后形成单一候选", async () => {
    let verificationCalls = 0;
    fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content?: string }> };
      const prompt = body.messages[1]?.content ?? "";
      const chapters = [...prompt.matchAll(/<CHAPTER id="([^"]+)" title="([^"]+)"[^>]*>/gu)];
      if (prompt.includes("第二次身份确认")) {
        verificationCalls += 1;
        expect(prompt).toContain("candidate:0|candidate:1");
        return new Response(JSON.stringify({ choices: [{ message: { content: `<json>${JSON.stringify([{
          pairKey: "candidate:0|candidate:1",
          verdict: "same",
          confidence: 0.96,
          reason: "正文中的马克博士是马克的职称称呼，身份和行动连续。"
        }])}</json>` } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const chapter = chapters[0];
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([
        { canonicalName: "马克", aliases: [], identity: "帝王组织研究员", firstEvidence: { chapterId: chapter?.[1], chapterTitle: chapter?.[2], quote: "马克在实验室" } },
        { canonicalName: "马克博士", aliases: [], identity: "帝王组织研究员", firstEvidence: { chapterId: chapter?.[1], chapterTitle: chapter?.[2], quote: "马克博士说" } }
      ]) } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    runtime = createTestRuntime(fetchMock);
    const { workId, chapters } = await seedWork(runtime);
    await request(runtime.app).patch(`/api/chapters/${chapters[0].id}`).send({
      content: "马克在实验室记录数据。马克博士说：实验已经完成。"
    }).expect(200);
    const modelId = await configureAi(runtime, workId);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({ taskType: "character-extraction", scope: { type: "book" } }).expect(201);
    const result = await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId }).expect(200);
    expect(result.body.data.result).toMatchObject({
      savedCount: 0,
      candidateCount: 1,
      characterApplication: { status: "pending", totalCount: 1 },
      verification: { pairCount: 1, confirmedSameCount: 1, confirmedSeparateCount: 0, unresolvedCount: 0 }
    });
    expect(verificationCalls).toBe(1);
    const beforeApply = await request(runtime.app).get(`/api/works/${workId}/characters`).expect(200);
    expect(beforeApply.body.data).toEqual([]);
    await applySuggestedCharacterCandidates(runtime, task.body.data.id);
    const characters = await request(runtime.app).get(`/api/works/${workId}/characters`).expect(200);
    expect(characters.body.data).toHaveLength(1);
    expect(characters.body.data[0]).toMatchObject({ name: "马克", aliases: ["马克博士"] });
  });

  it("角色职称变体未通过二次确认时不落库", async () => {
    fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content?: string }> };
      const prompt = body.messages[1]?.content ?? "";
      if (prompt.includes("第二次身份确认")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: `<json>${JSON.stringify([{
          pairKey: "candidate:0|candidate:1",
          verdict: "uncertain",
          confidence: 0.55,
          reason: "原文不足以确认两种称呼是否属于同一人。"
        }])}</json>` } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const chapter = [...prompt.matchAll(/<CHAPTER id="([^"]+)" title="([^"]+)"[^>]*>/gu)][0];
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([
        { canonicalName: "马克", aliases: [], identity: "研究员", firstEvidence: { chapterId: chapter?.[1], chapterTitle: chapter?.[2], quote: "马克在实验室" } },
        { canonicalName: "马克博士", aliases: [], identity: "研究员", firstEvidence: { chapterId: chapter?.[1], chapterTitle: chapter?.[2], quote: "马克博士说" } }
      ]) } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    runtime = createTestRuntime(fetchMock);
    const { workId, chapters } = await seedWork(runtime);
    await request(runtime.app).patch(`/api/chapters/${chapters[0].id}`).send({
      content: "马克在实验室记录数据。马克博士说：实验已经完成。"
    }).expect(200);
    const modelId = await configureAi(runtime, workId);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({ taskType: "character-extraction", scope: { type: "book" } }).expect(201);
    const result = await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId }).expect(200);
    expect(result.body.data.result).toMatchObject({
      savedCount: 0,
      verification: { pairCount: 1, confirmedSameCount: 0, confirmedSeparateCount: 0, unresolvedCount: 1 }
    });
    expect(result.body.data.result.skipped[0].reason).toContain("二次确认未通过");
    const characters = await request(runtime.app).get(`/api/works/${workId}/characters`).expect(200);
    expect(characters.body.data).toEqual([]);
  });

  it("角色职称变体命中已有角色时经确认后仅在应用阶段更新原档案", async () => {
    fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content?: string }> };
      const prompt = body.messages[1]?.content ?? "";
      if (prompt.includes("第二次身份确认")) {
        const pairKey = prompt.match(/"pairKey":"([^"]+)"/u)?.[1] ?? "";
        return new Response(JSON.stringify({ choices: [{ message: { content: `<json>${JSON.stringify([{
          pairKey,
          verdict: "same",
          confidence: 0.94,
          reason: "带职称的称呼与已有角色的身份和原文证据一致。"
        }])}</json>` } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const chapter = [...prompt.matchAll(/<CHAPTER id="([^"]+)" title="([^"]+)"[^>]*>/gu)][0];
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([
        { canonicalName: "马克博士", aliases: [], identity: "帝王组织研究员", firstEvidence: { chapterId: chapter?.[1], chapterTitle: chapter?.[2], quote: "马克博士说" } }
      ]) } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    runtime = createTestRuntime(fetchMock);
    const { workId, chapters } = await seedWork(runtime);
    const existing = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "马克" }).expect(201);
    await request(runtime.app).patch(`/api/chapters/${chapters[0].id}`).send({ content: "马克博士说：实验已经完成。" }).expect(200);
    const modelId = await configureAi(runtime, workId);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({ taskType: "character-extraction", scope: { type: "book" } }).expect(201);
    const result = await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId }).expect(200);
    expect(result.body.data.result).toMatchObject({
      savedCount: 0,
      candidateCount: 1,
      characterApplication: { status: "pending", totalCount: 1 },
      verification: { pairCount: 1, confirmedSameCount: 1 }
    });
    const beforeApply = await request(runtime.app).get(`/api/works/${workId}/characters`).expect(200);
    expect(beforeApply.body.data).toHaveLength(1);
    expect(beforeApply.body.data[0]).toMatchObject({ id: existing.body.data.id, name: "马克", aliases: [] });
    const applied = await applySuggestedCharacterCandidates(runtime, task.body.data.id);
    expect(applied.body.data).toMatchObject({ createdCount: 0, mergedCount: 1 });
    const characters = await request(runtime.app).get(`/api/works/${workId}/characters`).expect(200);
    expect(characters.body.data).toHaveLength(1);
    expect(characters.body.data[0]).toMatchObject({ id: existing.body.data.id, name: "马克", aliases: ["马克博士"] });
  });

  it("取消运行中的分批任务后不会被后台结果改回完成状态", async () => {
    let requestStarted = false;
    fetchMock = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
      requestStarted = true;
      const signal = init?.signal;
      signal?.addEventListener("abort", () => reject(signal.reason ?? new DOMException("Aborted", "AbortError")), { once: true });
    }));
    runtime = createTestRuntime(fetchMock);
    const { workId } = await seedWork(runtime);
    const modelId = await configureAi(runtime, workId);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({ taskType: "character-extraction", scope: { type: "book" } }).expect(201);
    const running = request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId }).then((response) => response);
    for (let index = 0; index < 50 && !requestStarted; index += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(requestStarted).toBe(true);
    await request(runtime.app).post(`/api/tasks/${task.body.data.id}/cancel`).send({}).expect(200);
    const completedRequest = await running;
    expect(completedRequest.status).toBe(200);
    expect(completedRequest.body.data.status).toBe("cancelled");
    const after = await request(runtime.app).get(`/api/tasks/${task.body.data.id}`).expect(200);
    expect(after.body.data.status).toBe("cancelled");
    const characters = await request(runtime.app).get(`/api/works/${workId}/characters`).expect(200);
    expect(characters.body.data).toEqual([]);
    await request(runtime.app).post(`/api/tasks/${task.body.data.id}/cancel`).send({}).expect(200);
  });

  it("正文变化会使待执行全书任务过期，终态任务不能被改写为取消", async () => {
    runtime = createTestRuntime();
    const { workId, chapters } = await seedWork(runtime);
    const pending = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "book-analysis",
      scope: { type: "book" }
    }).expect(201);
    await request(runtime.app).patch(`/api/chapters/${chapters[0].id}`).send({ content: "林舟改写了北港见面。" }).expect(200);
    const expired = await request(runtime.app).get(`/api/tasks/${pending.body.data.id}`).expect(200);
    expect(expired.body.data.status).toBe("expired");
    const cancel = await request(runtime.app).post(`/api/tasks/${pending.body.data.id}/cancel`).send({}).expect(409);
    expect(cancel.body.error.code).toBe("TASK_NOT_CANCELLABLE");
  });

  it("按原配置重跑终态任务并刷新人物快照与来源版本", async () => {
    runtime = createTestRuntime();
    const { workId, chapters } = await seedWork(runtime);
    const modelId = await configureAi(runtime, workId);
    const providerId = String(runtime.database.get<Record<string, unknown>>(
      "SELECT provider_id FROM models WHERE id = ?",
      modelId
    )?.provider_id);
    const alternateModel = await request(runtime.app).post(`/api/providers/${providerId}/models`).send({
      displayName: "备用功能模型",
      modelId: "feature-model-fallback"
    }).expect(201);
    const character = await request(runtime.app).post(`/api/works/${workId}/characters`).send({
      name: "银月基多拉"
    }).expect(201);
    const original = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "relationship-analysis",
      modelId,
      scope: {
        type: "book",
        characterIds: [character.body.data.id],
        additionalPrompt: "只分析可靠证据",
        preFilterRelationshipSources: false,
        replaceExistingRelationships: true
      }
    }).expect(201);
    const pendingRerun = await request(runtime.app).post(`/api/tasks/${original.body.data.id}/rerun`).send({}).expect(409);
    expect(pendingRerun.body.error.code).toBe("TASK_NOT_RERUNNABLE");

    await request(runtime.app).patch(`/api/chapters/${chapters[0].id}`).send({
      content: "银月基多拉在北港上空现身。"
    }).expect(200);
    await request(runtime.app).patch(`/api/characters/${character.body.data.id}`).send({
      name: "月影基多拉"
    }).expect(200);
    const expired = await request(runtime.app).get(`/api/tasks/${original.body.data.id}`).expect(200);
    expect(expired.body.data.status).toBe("expired");

    const rerun = await request(runtime.app).post(`/api/tasks/${original.body.data.id}/rerun`).send({
      modelId: alternateModel.body.data.id
    }).expect(201);
    expect(rerun.body.data).toMatchObject({
      taskType: "relationship-analysis",
      status: "pending",
      progress: 0,
      rerunOfTaskId: original.body.data.id,
      model: { id: alternateModel.body.data.id },
      scope: {
        type: "book",
        characterIds: [character.body.data.id],
        targetCharacters: [{ id: character.body.data.id, name: "月影基多拉" }],
        additionalPrompt: "只分析可靠证据",
        preFilterRelationshipSources: false,
        replaceExistingRelationships: true
      }
    });
    expect(rerun.body.data.id).not.toBe(original.body.data.id);
    expect(rerun.body.data.sourceVersions[chapters[0].id]).toBe(2);
    const originalAfter = await request(runtime.app).get(`/api/tasks/${original.body.data.id}`).expect(200);
    expect(originalAfter.body.data.status).toBe("expired");
    const audit = runtime.database.get(
      "SELECT detail_json FROM audit_logs WHERE entity_id = ? AND action = 'task.created'",
      rerun.body.data.id
    );
    expect(JSON.parse(String(audit?.detail_json))).toMatchObject({ rerunOfTaskId: original.body.data.id });

    const invalidBody = await request(runtime.app).post(`/api/tasks/${original.body.data.id}/rerun`).send({
      unsupported: true
    }).expect(400);
    expect(invalidBody.body.error.code).toBe("VALIDATION_ERROR");
  });

  it.each(["structure", "report-update"])("拒绝重跑已经不支持的历史分析类型 %s", async (taskType) => {
    runtime = createTestRuntime();
    const work = runtime.store.createWork({ title: "历史分析重跑测试" });
    const original = runtime.store.createTask(String(work.id), {
      taskType,
      scope: { type: "book" }
    });
    runtime.store.updateTask(String(original.id), { status: "completed", progress: 100, result: {} });
    const beforeCount = runtime.database.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM analysis_tasks WHERE work_id = ?",
      String(work.id)
    )?.count;

    const response = await request(runtime.app).post(`/api/tasks/${original.id}/rerun`).send({}).expect(409);

    expect(response.body.error).toMatchObject({
      code: "TASK_NOT_RERUNNABLE",
      message: `任务类型“${taskType}”已经不支持重跑`
    });
    expect(runtime.database.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM analysis_tasks WHERE work_id = ?",
      String(work.id)
    )?.count).toBe(beforeCount);
  });

  it("重跑关系任务时重新筛选已经变化的预检来源", async () => {
    const userPrompts: string[] = [];
    fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      userPrompts.push(body.messages[1]?.content ?? "");
      return new Response(JSON.stringify({ choices: [{ message: { content: "[]" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    runtime = createTestRuntime(fetchMock);
    const { workId, chapters } = await seedWork(runtime);
    const modelId = await configureAi(runtime, workId);
    const target = await request(runtime.app).post(`/api/works/${workId}/characters`).send({
      name: "林舟"
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "沈星" }).expect(201);
    const original = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "relationship-analysis",
      modelId,
      scope: {
        type: "book",
        characterIds: [target.body.data.id],
        preFilterRelationshipSources: true,
        relationshipSourceRefs: [{
          sourceType: "chapter",
          sourceId: chapters[0].id,
          sourceVersion: String(chapters[0].versionNo)
        }]
      }
    }).expect(201);
    runtime.store.updateTask(original.body.data.id, { status: "completed", progress: 100, result: {} });
    await request(runtime.app).patch(`/api/chapters/${chapters[0].id}`).send({
      content: "林舟与沈星在北港重新订立盟约。"
    }).expect(200);

    const rerun = await request(runtime.app).post(`/api/tasks/${original.body.data.id}/rerun`).send({}).expect(201);
    expect(rerun.body.data.scope.relationshipSourceRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceType: "chapter",
        sourceId: chapters[0].id,
        sourceVersion: "2"
      })
    ]));
    expect(rerun.body.data.sourceVersions[chapters[0].id]).toBe(2);
    const completed = await request(runtime.app).post(`/api/tasks/${rerun.body.data.id}/run`).send({}).expect(200);
    expect(completed.body.data.status).toBe("review");
    expect(completed.body.data.result.sourcePreviewApplied).toBe(true);
    expect(userPrompts.join("\n")).toContain("林舟与沈星在北港重新订立盟约。");
  });

  it("续写前自动装载相关人物、大纲和伏笔，续写后返回冲突卡并绑定文本哈希", async () => {
    fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }>; max_tokens: number };
      const prompt = body.messages[1]?.content ?? "";
      expect(body.max_tokens).toBe(32_000);
      if (prompt.includes("检查下面的续写候选")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([{
          type: "location", severity: "high", title: "地点冲突", description: "林舟仍在北港", candidateQuote: "抵达主星", sourceRefs: ["currentState.location"], suggestion: "保留在北港"
        }]) } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "林舟瞬间抵达主星。" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    runtime = createTestRuntime(fetchMock);
    const { workId, chapters } = await seedWork(runtime);
    const lin = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "林舟", gender: "male", aliases: ["阿舟"], currentState: { location: "北港" } }).expect(201);
    const shen = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "沈星" }).expect(201);
    const relationship = await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: lin.body.data.id,
      toCharacterId: shen.body.data.id,
      category: "social",
      subtype: "旧友",
      keywords: ["长期信任", "失联重逢"],
      confirmationStatus: "confirmed"
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/settings`).send({ title: "瞬移限制", category: "世界规则", content: "任何人都不能瞬间移动。", locked: true }).expect(201);
    await request(runtime.app).put(`/api/chapters/${chapters[0].id}/outline`).send({ goal: "准备离港", conflict: "引擎损坏", turningPoint: "收到旧信" }).expect(200);
    await request(runtime.app).post(`/api/works/${workId}/foreshadows`).send({ title: "旧信", status: "planted", occurrences: [{ chapterId: chapters[0].id, role: "setup" }] }).expect(201);
    const modelId = await configureAi(runtime, workId);
    const suggestion = await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "continue",
      instruction: "让阿舟继续行动",
      scope: { type: "chapter", chapterId: chapters[0].id },
      modelId
    }).expect(201);
    expect(suggestion.body.data.guard).toMatchObject({ status: "warning", chapterVersion: 1 });
    expect(suggestion.body.data.guard.issues[0]).toMatchObject({ type: "location", severity: "high" });
    const prompts = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).messages[1].content as string);
    expect(prompts.every((prompt) => prompt.includes("任何人都不能瞬间移动"))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes("当前位置") || prompt.includes('"location":"北港"'))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes("当前章大纲") && prompt.includes("旧信"))).toBe(true);
    expect(prompts.every((prompt) => /(?:林舟 — 沈星|沈星 — 林舟)/u.test(prompt) && prompt.includes("长期信任、失联重逢"))).toBe(true);
    const stale = await request(runtime.app).post(`/api/suggestions/${suggestion.body.data.id}/accept`).send({ content: "作者改过的候选" }).expect(409);
    expect(stale.body.error.code).toBe("GUARD_STALE");
    await request(runtime.app).post(`/api/suggestions/${suggestion.body.data.id}/guard`).send({ content: "作者改过的候选" }).expect(201);
    const character = (await request(runtime.app).get(`/api/works/${workId}/characters`).expect(200)).body.data[0];
    await request(runtime.app).patch(`/api/characters/${character.id}`).send({ currentState: { location: "主星" } }).expect(200);
    const knowledgeStale = await request(runtime.app).post(`/api/suggestions/${suggestion.body.data.id}/accept`).send({ content: "作者改过的候选" }).expect(409);
    expect(knowledgeStale.body.error.code).toBe("GUARD_STALE");
    await request(runtime.app).post(`/api/suggestions/${suggestion.body.data.id}/guard`).send({ content: "作者改过的候选" }).expect(201);
    await request(runtime.app).patch(`/api/characters/${character.id}`).send({ gender: "female" }).expect(200);
    const genderStale = await request(runtime.app).post(`/api/suggestions/${suggestion.body.data.id}/accept`).send({ content: "作者改过的候选" }).expect(409);
    expect(genderStale.body.error.code).toBe("GUARD_STALE");
    await request(runtime.app).post(`/api/suggestions/${suggestion.body.data.id}/guard`).send({ content: "作者改过的候选" }).expect(201);
    await request(runtime.app).patch(`/api/relationships/${relationship.body.data.id}`).send({ keywords: ["共同守望", "重新建立信任"] }).expect(200);
    const relationshipStale = await request(runtime.app).post(`/api/suggestions/${suggestion.body.data.id}/accept`).send({ content: "作者改过的候选" }).expect(409);
    expect(relationshipStale.body.error.code).toBe("GUARD_STALE");
    await request(runtime.app).post(`/api/suggestions/${suggestion.body.data.id}/guard`).send({ content: "作者改过的候选" }).expect(201);
    const accepted = await request(runtime.app).post(`/api/suggestions/${suggestion.body.data.id}/accept`).send({ content: "作者改过的候选" }).expect(200);
    expect(accepted.body.data.chapter.content).toContain("作者改过的候选");
  });

  it("守卫模型返回非法结果时保留续写建议并明确标记检查失败", async () => {
    fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      const prompt = body.messages[1]?.content ?? "";
      const content = prompt.includes("检查下面的续写候选") ? "not-json" : "林舟继续检查旧信。";
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    runtime = createTestRuntime(fetchMock);
    const { workId, chapters } = await seedWork(runtime);
    const modelId = await configureAi(runtime, workId);
    const suggestion = await request(runtime.app).post(`/api/works/${workId}/suggestions`).send({
      taskType: "continue",
      instruction: "继续检查",
      scope: { type: "chapter", chapterId: chapters[0].id },
      modelId
    }).expect(201);
    expect(suggestion.body.data.guard.status).toBe("failed");
    expect(suggestion.body.data.guard.failure).toContain("有效 JSON");
    const blocked = await request(runtime.app).post(`/api/suggestions/${suggestion.body.data.id}/accept`).send({}).expect(409);
    expect(blocked.body.error.code).toBe("GUARD_FAILED");
    const unchanged = await request(runtime.app).get(`/api/chapters/${chapters[0].id}`).expect(200);
    expect(unchanged.body.data.versionNo).toBe(1);
  });

  it("分块分析全书、验证引文并丢弃无原文依据的关系", async () => {
    let chapterIds: string[] = [];
    fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }>; max_tokens: number };
      const prompt = body.messages[1]?.content ?? "";
      expect(prompt).toContain("单次见面、同场出现");
      expect(prompt).toContain("梦境、假设或替代人生");
      const matches = [...prompt.matchAll(/<CHAPTER id="([^"]+)"/gu)];
      chapterIds = matches.flatMap((match) => match[1] ? [match[1]] : []);
      if (matches.length > 1) {
        return new Response(JSON.stringify({ error: { code: "temporary_large_batch_failure" } }), { status: 503, headers: { "Content-Type": "application/json" } });
      }
      const markedContent = prompt.match(/<CHAPTER\b[^>]*>([\s\S]*?)<\/CHAPTER>/u)?.[1] ?? "";
      if (prompt.includes("上游策略拒绝片段")) {
        return new Response(JSON.stringify({ error: { code: "security_audit_fail" } }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      if (prompt.includes("我们一直是朋友") && markedContent.length > 200) {
        return new Response(JSON.stringify({ error: { code: "security_audit_fail" } }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      if (!prompt.includes("我们一直是朋友")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "[]" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([
        { fromCharacterId: "林舟", toCharacterId: "沈星", category: "social", subtype: "朋友", keywords: ["长期信任", "共同守望"], directed: false, currentStatus: "active", confidence: 0.9, timeRange: {}, evidence: [{ chapterId: chapterIds[0], chapterTitle: "第一章 埋线", quote: "我们一直是朋友", contextType: "current", supports: "直接说明" }] },
        { fromCharacterId: "林舟", toCharacterId: "沈星", category: "uncertain", subtype: "未知", directed: false, currentStatus: "unknown", confidence: 0.8, timeRange: {}, evidence: [{ chapterId: chapterIds[0], chapterTitle: "第一章 埋线", quote: "原文中不存在的句子", contextType: "current", supports: "无" }] }
      ]) } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    runtime = createTestRuntime(fetchMock);
    const { workId, chapters } = await seedWork(runtime);
    await request(runtime.app).patch(`/api/chapters/${chapters[0].id}`).send({
      content: `林舟在北港见到沈星。沈星说：我们一直是朋友。${"航行背景。".repeat(360)}上游策略拒绝片段。`
    }).expect(200);
    await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "林舟" }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "沈星" }).expect(201);
    const modelId = await configureAi(runtime, workId);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({ taskType: "relationship-analysis", scope: { type: "book" } }).expect(201);
    expect(Object.keys(task.body.data.sourceVersions)).toHaveLength(3);
    const result = await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId }).expect(200);
    expect(result.body.data.result).toMatchObject({
      candidateCount: 1,
      createdCount: 1,
      updatedCount: 0,
      unchangedCount: 0,
      rawCandidateCount: 2,
      coveredChapterCount: 3,
      fallbackSegmentCount: 0,
      analysisTarget: {
        mode: "all-relationships",
        scopeType: "book",
        coveredChapterCount: 3
      },
      relationshipResults: [{
        action: "created",
        category: "social",
        subtype: "朋友",
        keywords: ["长期信任", "共同守望"],
        currentStatus: "active",
        evidenceCount: 1,
        evidence: [{
          chapterTitle: "第一章 埋线",
          quote: "我们一直是朋友"
        }]
      }]
    });
    expect([
      result.body.data.result.relationshipResults[0].fromCharacterName,
      result.body.data.result.relationshipResults[0].toCharacterName
    ].sort()).toEqual(["林舟", "沈星"].sort());
    expect(result.body.data.result.policyOmittedSegmentCount).toBeGreaterThan(0);
    const prompts = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).messages[1].content as string);
    expect(prompts.filter((prompt) => (prompt.match(/<CHAPTER id=/gu) ?? []).length > 1)).toHaveLength(4);
    expect(prompts.some((prompt) => prompt.includes('fragment="'))).toBe(true);
    const fragmentLengths = prompts
      .filter((prompt) => prompt.includes('fragment="'))
      .map((prompt) => prompt.match(/<CHAPTER\b[^>]*>([\s\S]*?)<\/CHAPTER>/u)?.[1]?.trim().length ?? 0);
    expect(fragmentLengths.some((length) => length > 200)).toBe(true);
    expect(fragmentLengths.some((length) => length > 0 && length <= 200)).toBe(true);
    expect(result.body.data.result.skipped.some((item: { reason: string }) => item.reason.includes("证据引文"))).toBe(true);
    const relationships = await request(runtime.app).get(`/api/works/${workId}/relationships`).expect(200);
    expect(relationships.body.data).toHaveLength(1);
    expect(relationships.body.data[0]).toMatchObject({ subtype: "朋友", keywords: ["长期信任", "共同守望"], confirmationStatus: "pending" });
    runtime.database.run(
      "UPDATE analysis_tasks SET result_json = ? WHERE id = ?",
      JSON.stringify({ relationshipIds: [relationships.body.data[0].id], candidateCount: 1, coveredChapterCount: 3 }),
      task.body.data.id
    );
    const historicalTask = await request(runtime.app).get(`/api/tasks/${task.body.data.id}`).expect(200);
    expect(historicalTask.body.data.result).toMatchObject({
      relationshipResults: [{
        relationshipId: relationships.body.data[0].id,
        snapshotSource: "current-record",
        subtype: "朋友"
      }]
    });
    expect(historicalTask.body.data.result).not.toHaveProperty("storageTarget");
    expect([
      historicalTask.body.data.result.relationshipResults[0].fromCharacterName,
      historicalTask.body.data.result.relationshipResults[0].toCharacterName
    ].sort()).toEqual(["林舟", "沈星"].sort());
  });

  it("关系分析可将所有设定和额外提示加入每个抽取批次", async () => {
    const systemPrompts: string[] = [];
    const userPrompts: string[] = [];
    fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
      systemPrompts.push(body.messages[0]?.content ?? "");
      userPrompts.push(body.messages[1]?.content ?? "");
      return new Response(JSON.stringify({ choices: [{ message: { content: "[]" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    runtime = createTestRuntime(fetchMock);
    const { workId } = await seedWork(runtime);
    await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "林舟" }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "沈星" }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/settings`).send({
      title: "未锁定王位规则", category: "社会制度", content: "摄政者退位后仍保留导师身份。", locked: false
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/settings`).send({
      title: "锁定继承规则", category: "社会制度", content: "王位只能由正式继承人承接。", locked: true
    }).expect(201);
    const modelId = await configureAi(runtime, workId);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "relationship-analysis",
      scope: {
        type: "book",
        includeAllSettings: true,
        additionalPrompt: "重点检查退位者与继承人的师承变化。"
      }
    }).expect(201);
    expect(task.body.data.scopeSummary).toBe("全书 + 设定集");
    await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId }).expect(200);
    expect(userPrompts.length).toBeGreaterThan(0);
    const settingPrompts = userPrompts.filter((prompt) => prompt.includes("<SETTING"));
    expect(settingPrompts.length).toBeGreaterThan(0);
    expect(settingPrompts.some((prompt) => prompt.includes("摄政者退位后仍保留导师身份"))).toBe(true);
    expect(settingPrompts.some((prompt) => prompt.includes("王位只能由正式继承人承接"))).toBe(true);
    expect(userPrompts.filter((prompt) => prompt.includes("<CHAPTER")).every((prompt) => !prompt.includes("摄政者退位后仍保留导师身份"))).toBe(true);
    expect(systemPrompts.every((prompt) => prompt.includes("作者追加的关系分析提示") && prompt.includes("重点检查退位者与继承人的师承变化"))).toBe(true);
  });

  it("指定章节关系分析可同时纳入设定集", async () => {
    const userPrompts: string[] = [];
    fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      userPrompts.push(body.messages[1]?.content ?? "");
      return new Response(JSON.stringify({ choices: [{ message: { content: "[]" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    runtime = createTestRuntime(fetchMock);
    const { workId, chapters } = await seedWork(runtime);
    await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "林舟" }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "沈星" }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/settings`).send({
      title: "北港盟约",
      category: "人物关系",
      content: "林舟与沈星共同遵守北港盟约。",
      locked: false
    }).expect(201);
    const modelId = await configureAi(runtime, workId);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "relationship-analysis",
      scope: {
        type: "chapter",
        chapterId: chapters[0].id,
        chapterIds: [chapters[0].id],
        includeAllSettings: true
      }
    }).expect(201);
    expect(task.body.data.scopeSummary).toBe("指定章节 + 设定集（1）：第一卷 · 第一章 埋线");

    const result = await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId }).expect(200);
    expect(result.body.data.result).toMatchObject({ coveredChapterCount: 1 });
    expect(result.body.data.result.coveredSettingCount).toBeGreaterThan(0);
    const sent = userPrompts.join("\n");
    expect(sent).toContain("林舟在北港见到沈星");
    expect(sent).toContain("林舟与沈星共同遵守北港盟约");
    expect(sent).not.toContain("林舟离开北港，旧约仍未兑现");
    expect(sent).not.toContain("沈星打开旧信");
  });

  it("可仅根据设定集分析人物关系且不要求章节", async () => {
    let linId = "";
    let shenId = "";
    let settingId = "";
    const userPrompts: string[] = [];
    fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      userPrompts.push(body.messages[1]?.content ?? "");
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([{
        fromCharacterId: linId,
        toCharacterId: shenId,
        category: "social",
        subtype: "朋友",
        keywords: ["自幼相识", "长期信任"],
        directed: false,
        currentStatus: "active",
        confidence: 0.94,
        timeRange: {},
        evidence: [{
          settingId,
          settingTitle: "北港旧友",
          quote: "林舟与沈星自幼相识，是彼此最信任的朋友。",
          supports: "设定明确说明两人是长期朋友"
        }]
      }]) } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    runtime = createTestRuntime(fetchMock);
    const work = await request(runtime.app).post("/api/works").send({ title: "仅设定集关系分析" }).expect(201);
    const workId = work.body.data.id as string;
    const lin = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "林舟" }).expect(201);
    const shen = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "沈星" }).expect(201);
    linId = lin.body.data.id as string;
    shenId = shen.body.data.id as string;
    const setting = await request(runtime.app).post(`/api/works/${workId}/settings`).send({
      title: "北港旧友",
      category: "人物关系",
      content: "林舟与沈星自幼相识，是彼此最信任的朋友。",
      locked: false
    }).expect(201);
    settingId = setting.body.data.id as string;
    const modelId = await configureAi(runtime, workId);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "relationship-analysis",
      scope: { type: "settings" }
    }).expect(201);
    expect(task.body.data.scopeSummary).toBe("仅设定集");
    expect(task.body.data.sourceVersions).toMatchObject({
      [`work:${workId}`]: 1,
      [`setting:${settingId}`]: 1,
      [`character:${linId}`]: 1,
      [`character:${shenId}`]: 1
    });
    const result = await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId }).expect(200);
    expect(result.body.data.result).toMatchObject({
      candidateCount: 1,
      coveredChapterCount: 0,
      coveredSettingCount: 4
    });
    expect(userPrompts).toHaveLength(1);
    expect(userPrompts[0]).toContain(`<SETTING id="${settingId}" title="北港旧友">`);
    expect(userPrompts[0]).not.toContain("<CHAPTER");
    const relationships = await request(runtime.app).get(`/api/works/${workId}/relationships`).expect(200);
    expect(relationships.body.data).toHaveLength(1);
    expect(relationships.body.data[0]).toMatchObject({
      subtype: "朋友",
      evidence: [{ settingId, settingTitle: "北港旧友", quote: "林舟与沈星自幼相识，是彼此最信任的朋友。" }]
    });
  });

  it("仅设定集任务在其他设定数据变化后过期", async () => {
    runtime = createTestRuntime();
    const work = await request(runtime.app).post("/api/works").send({ title: "设定新鲜度" }).expect(201);
    const workId = String(work.body.data.id);
    const organization = await request(runtime.app).post(`/api/works/${workId}/organizations`).send({
      name: "守望会",
      description: "负责旧港航线。"
    }).expect(201);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "relationship-analysis",
      scope: { type: "settings" }
    }).expect(201);
    expect(task.body.data.sourceVersions).toMatchObject({
      [`work:${workId}`]: 1,
      [`organization:${String(organization.body.data.id)}`]: 1
    });

    await request(runtime.app).patch(`/api/organizations/${organization.body.data.id}`).send({
      description: "改为负责深空航线。"
    }).expect(200);
    const expired = await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({}).expect(200);
    expect(expired.body.data.status).toBe("expired");
  });

  it("选择角色后先收集跨章节证据再进行全局关系归纳", async () => {
    let linId = "";
    let shenId = "";
    const systemPrompts: string[] = [];
    const userPrompts: string[] = [];
    fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      const systemPrompt = body.messages[0]?.content ?? "";
      const userPrompt = body.messages[1]?.content ?? "";
      systemPrompts.push(systemPrompt);
      userPrompts.push(userPrompt);
      if (userPrompt.includes("小说人物关系全局归纳器")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([{
          fromCharacterId: linId,
          toCharacterId: shenId,
          category: "social",
          subtype: "朋友",
          keywords: ["长期信任", "失联重逢"],
          directed: false,
          currentStatus: "active",
          confidence: 0.92,
          timeRange: { stages: ["北港重逢"] },
          evidence: [{ chapterId: userPrompt.match(/"chapterId":"([^"]+)"/u)?.[1], chapterTitle: "第一章 埋线", quote: "我们一直是朋友", contextType: "current", supports: "原文直接说明长期关系" }]
        }]) } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (userPrompt.includes("<SETTING")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "[]" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const chapterId = userPrompt.match(/<CHAPTER id="([^"]+)"/u)?.[1] ?? "";
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([{
        targetCharacterId: linId,
        relatedCharacterId: shenId,
        observation: "沈星直接说明两人一直是朋友",
        possibleCategory: "social",
        possibleSubtype: "朋友",
        directionHint: "undirected",
        timeHint: "current",
        chapterId,
        chapterTitle: "第一章 埋线",
        quote: "我们一直是朋友",
        contextType: "current"
      }]) } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    runtime = createTestRuntime(fetchMock);
    const { workId } = await seedWork(runtime);
    const lin = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "林舟", profile: { identity: "调查员" } }).expect(201);
    const shen = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "沈星" }).expect(201);
    const qiao = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "乔安" }).expect(201);
    const ye = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "叶宁" }).expect(201);
    linId = lin.body.data.id as string;
    shenId = shen.body.data.id as string;
    const unrelated = await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: qiao.body.data.id,
      toCharacterId: ye.body.data.id,
      category: "social",
      subtype: "盟友",
      confirmationStatus: "confirmed"
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/settings`).send({
      title: "未锁定北港旧约", category: "社会制度", content: "北港旧约只认可长期互信。", locked: false
    }).expect(201);
    const modelId = await configureAi(runtime, workId);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "relationship-analysis",
      scope: {
        type: "book",
        includeAllSettings: true,
        characterIds: [linId, shenId],
        additionalPrompt: "重点检查失联前后的关系连续性。"
      }
    }).expect(201);
    expect(task.body.data.scopeSummary).toBe("全书 + 设定集 · 定向 2 人：林舟、沈星 · 已预检 5 条来源");
    expect(task.body.data.scope.targetCharacters).toEqual([{ id: linId, name: "林舟" }, { id: shenId, name: "沈星" }]);
    const result = await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId }).expect(200);
    await request(runtime.app).patch(`/api/characters/${linId}`).send({ name: "林舟（调查员）" }).expect(200);
    const taskPage = await request(runtime.app).get(`/api/works/${workId}/tasks?page=1&limit=30`).expect(200);
    expect(taskPage.body.data.items.find((item: { id: string }) => item.id === task.body.data.id)?.scopeSummary)
      .toBe("全书 + 设定集 · 定向 2 人：林舟、沈星 · 已预检 5 条来源");
    expect(result.body.data.result).toMatchObject({
      candidateCount: 1,
      targetedCharacterIds: [linId, shenId],
      targetedEvidenceCount: 1,
      aggregationBatchCount: 1,
      replacedRelationshipCount: 0
    });
    expect(userPrompts).toHaveLength(3);
    expect(userPrompts[0]).toContain("定向人物关系证据收集器");
    expect(userPrompts.some((prompt) => prompt.includes("小说人物关系全局归纳器"))).toBe(true);
    expect(userPrompts.some((prompt) => prompt.includes("沈星直接说明两人一直是朋友"))).toBe(true);
    expect(userPrompts.every((prompt) => !prompt.includes("北港旧约只认可长期互信"))).toBe(true);
    expect(userPrompts.every((prompt) => prompt.includes("林舟"))).toBe(true);
    expect(userPrompts.some((prompt) => prompt.includes("调查员"))).toBe(true);
    expect(systemPrompts.every((prompt) => prompt.includes("重点检查失联前后的关系连续性"))).toBe(true);
    const relationships = await request(runtime.app).get(`/api/works/${workId}/relationships`).expect(200);
    expect(relationships.body.data.some((relationship: { id: string }) => relationship.id === unrelated.body.data.id)).toBe(true);
    expect(relationships.body.data.some((relationship: { fromCharacterId: string; toCharacterId: string; subtype: string }) =>
      new Set([relationship.fromCharacterId, relationship.toCharacterId]).has(linId) && relationship.subtype === "朋友"
    )).toBe(true);
  });

  it("定向人物关系分析只发送命中人物名称或别名的章节与设定", async () => {
    const userPrompts: string[] = [];
    fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      userPrompts.push(body.messages[1]?.content ?? "");
      return new Response(JSON.stringify({ choices: [{ message: { content: "[]" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    runtime = createTestRuntime(fetchMock);
    const { workId, chapters } = await seedWork(runtime);
    await request(runtime.app).patch(`/api/chapters/${chapters[0].id}`).send({
      content: "阿宁在旧港查看完整航海日志。"
    }).expect(200);
    await request(runtime.app).patch(`/api/chapters/${chapters[1].id}`).send({
      content: "这是一章完全无关的正文，不应发送。"
    }).expect(200);
    await request(runtime.app).patch(`/api/chapters/${chapters[2].id}`).send({
      content: "另一章也没有目标人物，不应发送。"
    }).expect(200);
    const target = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "纪宁", aliases: ["阿宁"] }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "顾川" }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/settings`).send({
      title: "旧港盟约",
      category: "人物关系",
      content: "阿宁与顾川在旧港订立了长期守望盟约。"
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/settings`).send({
      title: "无关天文规则",
      category: "世界规则",
      content: "双月每隔百年重合一次，不含目标人物。",
      locked: true
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/characters`).send({
      name: "旁观者",
      attributes: { identity: "绝密旁观者自动注入标记" },
      lockedFields: ["identity"]
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/organizations`).send({
      name: "守望会",
      description: "负责旧港航线。",
      memberIds: [target.body.data.id]
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/organizations`).send({
      name: "星图局",
      description: "无关组织自动注入标记。"
    }).expect(201);
    const modelId = await configureAi(runtime, workId);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "relationship-analysis",
      scope: { type: "book", includeAllSettings: true, characterIds: [target.body.data.id] }
    }).expect(201);
    const result = await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId }).expect(200);
    expect(result.body.data.result).toMatchObject({
      coveredChapterCount: 1,
      targetedCharacterIds: [target.body.data.id],
      preFilterRelationshipSources: true,
      analysisTarget: { preFilterRelationshipSources: true }
    });
    const sent = userPrompts.join("\n");
    expect(sent).toContain("阿宁在旧港查看完整航海日志。");
    expect(sent).not.toContain("这是一章完全无关的正文，不应发送。");
    expect(sent).not.toContain("另一章也没有目标人物，不应发送。");
    expect(sent).toContain("阿宁与顾川在旧港订立了长期守望盟约。");
    expect(sent).not.toContain("双月每隔百年重合一次，不含目标人物。");
    expect(sent).not.toContain("绝密旁观者自动注入标记");
    expect(sent).not.toContain("无关组织自动注入标记");
    expect(sent).toContain('title="组织设定：守望会"');
  });

  it("预检人物关系来源并按用户保留的来源创建任务", async () => {
    const userPrompts: string[] = [];
    fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      userPrompts.push(body.messages[1]?.content ?? "");
      return new Response(JSON.stringify({ choices: [{ message: { content: "[]" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    runtime = createTestRuntime(fetchMock);
    const { workId, chapters } = await seedWork(runtime);
    await request(runtime.app).patch(`/api/chapters/${chapters[0].id}`).send({
      content: "阿宁在旧港查看完整航海日志。"
    }).expect(200);
    await request(runtime.app).patch(`/api/chapters/${chapters[1].id}`).send({
      content: "这是一章完全无关的正文。"
    }).expect(200);
    const target = await request(runtime.app).post(`/api/works/${workId}/characters`).send({
      name: "纪宁",
      aliases: ["阿宁"]
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "顾川" }).expect(201);
    const setting = await request(runtime.app).post(`/api/works/${workId}/settings`).send({
      title: "旧港盟约",
      category: "人物关系",
      content: "阿宁与顾川订立了长期守望盟约。"
    }).expect(201);
    const modelId = await configureAi(runtime, workId);
    const scope = {
      type: "book",
      includeAllSettings: true,
      characterIds: [target.body.data.id],
      preFilterRelationshipSources: true
    };

    const preview = await request(runtime.app)
      .post(`/api/works/${workId}/tasks/relationship-source-preview`)
      .send({ scope, modelId })
      .expect(200);
    expect(preview.body.data).toMatchObject({
      preFilterRelationshipSources: true,
      chapterCount: 1,
      sourceCount: expect.any(Number),
      totalCharacters: expect.any(Number),
      estimatedBatchCount: expect.any(Number)
    });
    expect(preview.body.data.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceType: "chapter",
        sourceId: chapters[0].id,
        title: chapters[0].title,
        matchType: "exact"
      }),
      expect.objectContaining({
        sourceType: "setting",
        sourceId: setting.body.data.id,
        title: "旧港盟约",
        matchType: "exact"
      })
    ]));
    expect(preview.body.data.sources).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceType: "chapter", sourceId: chapters[1].id })
    ]));

    const previewedChapter = preview.body.data.sources.find((source: { sourceType: string }) => source.sourceType === "chapter");
    const previewedSetting = preview.body.data.sources.find((source: { sourceType: string }) => source.sourceType === "setting");
    const chapterRef = {
      sourceType: previewedChapter.sourceType,
      sourceId: previewedChapter.sourceId,
      sourceVersion: previewedChapter.version
    };
    const settingRef = {
      sourceType: previewedSetting.sourceType,
      sourceId: previewedSetting.sourceId,
      sourceVersion: previewedSetting.version
    };
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "relationship-analysis",
      modelId,
      scope: { ...scope, relationshipSourceRefs: [chapterRef] }
    }).expect(201);
    expect(task.body.data.scopeSummary).toContain("已预检 1 条来源");
    const result = await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({}).expect(200);
    expect(result.body.data.result).toMatchObject({
      sourcePreviewApplied: true,
      coveredChapterCount: 1,
      coveredSettingCount: 0
    });
    const sent = userPrompts.join("\n");
    expect(sent).toContain("阿宁在旧港查看完整航海日志。");
    expect(sent).not.toContain("阿宁与顾川订立了长期守望盟约。");
    expect(sent).not.toContain("这是一章完全无关的正文。");

    const queuedTask = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "relationship-analysis",
      modelId,
      scope: { ...scope, additionalPrompt: "验证排队期间的来源版本变化", relationshipSourceRefs: [settingRef] }
    }).expect(201);
    expect(queuedTask.body.data.status).toBe("pending");
    await request(runtime.app).patch(`/api/settings/${setting.body.data.id}`).send({
      content: "阿宁与顾川在预检后修改了盟约。"
    }).expect(200);
    const staleRun = await request(runtime.app).post(`/api/tasks/${queuedTask.body.data.id}/run`).send({}).expect(409);
    expect(staleRun.body.error).toMatchObject({ code: "RELATIONSHIP_SOURCE_PREVIEW_STALE" });

    await request(runtime.app).patch(`/api/chapters/${chapters[0].id}`).send({
      content: "阿宁在预检后改写了航海日志。"
    }).expect(200);
    const staleTask = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "relationship-analysis",
      modelId,
      scope: { ...scope, relationshipSourceRefs: [chapterRef] }
    }).expect(409);
    expect(staleTask.body.error).toMatchObject({ code: "RELATIONSHIP_SOURCE_PREVIEW_STALE" });
  });

  it("关闭前置过滤时定向人物关系分析发送范围内全部章节和设定", async () => {
    const userPrompts: string[] = [];
    fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      userPrompts.push(body.messages[1]?.content ?? "");
      return new Response(JSON.stringify({ choices: [{ message: { content: "[]" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    runtime = createTestRuntime(fetchMock);
    const { workId, chapters } = await seedWork(runtime);
    await request(runtime.app).patch(`/api/chapters/${chapters[0].id}`).send({
      content: "阿宁在旧港查看完整航海日志。"
    }).expect(200);
    await request(runtime.app).patch(`/api/chapters/${chapters[1].id}`).send({
      content: "无关正文甲也必须发送。"
    }).expect(200);
    await request(runtime.app).patch(`/api/chapters/${chapters[2].id}`).send({
      content: "无关正文乙也必须发送。"
    }).expect(200);
    const target = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "纪宁", aliases: ["阿宁"] }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "顾川" }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/settings`).send({
      title: "旧港盟约",
      category: "人物关系",
      content: "阿宁与顾川在旧港订立了长期守望盟约。"
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/settings`).send({
      title: "无关天文规则",
      category: "世界规则",
      content: "无关设定也必须发送。"
    }).expect(201);
    const modelId = await configureAi(runtime, workId);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "relationship-analysis",
      scope: {
        type: "book",
        includeAllSettings: true,
        characterIds: [target.body.data.id],
        preFilterRelationshipSources: false
      }
    }).expect(201);
    expect(task.body.data.scopeSummary).toBe("全书 + 设定集 · 定向 1 人：纪宁 · 未前置过滤");

    const result = await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId }).expect(200);
    expect(result.body.data.result).toMatchObject({
      coveredChapterCount: 3,
      targetedCharacterIds: [target.body.data.id],
      preFilterRelationshipSources: false,
      analysisTarget: { preFilterRelationshipSources: false }
    });
    expect(result.body.data.result.sourceSelection).toBeUndefined();
    const sent = userPrompts.join("\n");
    expect(sent).toContain("阿宁在旧港查看完整航海日志。");
    expect(sent).toContain("无关正文甲也必须发送。");
    expect(sent).toContain("无关正文乙也必须发送。");
    expect(sent).toContain("阿宁与顾川在旧港订立了长期守望盟约。");
    expect(sent).toContain("无关设定也必须发送。");
    expect(sent).not.toContain("人物名称变体确认器");
  });

  it("拉丁字母别名只参与精确来源匹配", async () => {
    runtime = createTestRuntime();
    const { workId } = await seedWork(runtime);
    const target = await request(runtime.app).post(`/api/works/${workId}/characters`).send({
      name: "雅典娜",
      aliases: ["Athena", "Mega"]
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "赫拉" }).expect(201);
    const setting = await request(runtime.app).post(`/api/works/${workId}/settings`).send({
      title: "人工智能记录",
      category: "人物",
      content: "Athena 负责管理空间站。"
    }).expect(201);
    const aiInternals = runtime.ai as unknown as {
      relationshipFuzzyIndexMatches: (...args: unknown[]) => Set<string>;
      ensureRelationshipSearchIndex: (targetWorkId: string) => Promise<number>;
      localRelationshipSourceSelection: (
        targetWorkId: string,
        scope: Record<string, unknown>,
        characters: Record<string, unknown>[],
        selectedCharacterIds: Set<string>,
        generation: number
      ) => Promise<{ exactKeys: string[] }>;
    };
    const originalFuzzyIndexMatches = aiInternals.relationshipFuzzyIndexMatches.bind(aiInternals);
    const fuzzyReferences: string[] = [];
    aiInternals.relationshipFuzzyIndexMatches = (...args: unknown[]) => {
      fuzzyReferences.push(String(args[1]));
      return originalFuzzyIndexMatches(...args);
    };

    const generation = await aiInternals.ensureRelationshipSearchIndex(workId);
    const selection = await aiInternals.localRelationshipSourceSelection(
      workId,
      { type: "book", includeAllSettings: true, characterIds: [target.body.data.id] },
      runtime.store.listCharacters(workId),
      new Set([String(target.body.data.id)]),
      generation
    );

    expect(fuzzyReferences).toEqual(["雅典娜"]);
    expect(selection.exactKeys).toContain(`setting:${setting.body.data.id}`);
  });

  it("来源候选超限时在创建前拒绝并让历史任务彻底失败", async () => {
    fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "[]" } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    runtime = createTestRuntime(fetchMock);
    const { workId } = await seedWork(runtime);
    const target = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "魔斯拉" }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "拉顿" }).expect(201);
    const modelId = await configureAi(runtime, workId);
    (runtime.ai as unknown as { relationshipFuzzyIndexMatches: () => Set<string> }).relationshipFuzzyIndexMatches = () =>
      new Set(Array.from({ length: 201 }, (_, index) => `setting:diagnostic_${index}`));

    const rejected = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "relationship-analysis",
      scope: { type: "book", includeAllSettings: true, characterIds: [target.body.data.id] },
      modelId
    }).expect(409);
    expect(rejected.body.error).toMatchObject({
      code: "RELATIONSHIP_MATCH_CANDIDATES_EXCEEDED",
      details: {
        characterId: target.body.data.id,
        reason: "candidate-sources",
        candidateCount: 201,
        maximum: 200,
        identityAnchorCount: 0
      }
    });
    const tasks = await request(runtime.app).get(`/api/works/${workId}/tasks`).expect(200);
    expect(tasks.body.data.items).toEqual([]);

    const legacyTask = runtime.store.createTask(workId, {
      taskType: "relationship-analysis",
      scope: { type: "book", includeAllSettings: true, characterIds: [target.body.data.id] },
      modelId
    });
    const failed = await request(runtime.app).post(`/api/tasks/${legacyTask.id}/run`).send({}).expect(409);
    expect(failed.body.error.code).toBe("RELATIONSHIP_MATCH_CANDIDATES_EXCEEDED");
    const detail = await request(runtime.app).get(`/api/tasks/${legacyTask.id}/detail`).expect(200);
    expect(detail.body.data.status).toBe("failed");
    expect(detail.body.data.failures).toEqual([expect.objectContaining({
      code: "RELATIONSHIP_MATCH_CANDIDATES_EXCEEDED",
      message: "“魔斯拉”的拼音疑似来源仍然过多；请取消勾选“分析前按人物名称和拼音过滤来源”后重新预览",
      details: expect.objectContaining({
        characterId: target.body.data.id,
        targetName: "魔斯拉",
        reference: "魔斯拉",
        reason: "candidate-sources",
        candidateCount: 201,
        identityAnchorCount: 0
      })
    })]);

    const repaired = await request(runtime.app).patch(`/api/characters/${target.body.data.id}`).send({
      aliases: ["摩斯拉"],
      code: "TITAN-M01",
      attributes: { identity: "生态守护泰坦" },
      expectedVersionNo: target.body.data.versionNo,
      changeNote: "修复人物关系来源匹配"
    }).expect(200);
    expect(repaired.body.data).toMatchObject({
      aliases: ["摩斯拉"],
      code: "TITAN-M01",
      attributes: { identity: "生态守护泰坦" }
    });

    const retry = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "relationship-analysis",
      scope: { type: "book", includeAllSettings: true, characterIds: [target.body.data.id] },
      modelId
    }).expect(201);
    expect(retry.body.data.scope.relationshipSourceRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceType: "character", sourceId: target.body.data.id })
    ]));
    const completed = await request(runtime.app).post(`/api/tasks/${retry.body.data.id}/run`).send({}).expect(200);
    expect(completed.body.data.result).toMatchObject({
      preFilterRelationshipSources: true,
      sourcePreviewApplied: true
    });
  });

  it("通过拼音疑似写法确认来源并并发安全地去重审核项", async () => {
    const userPrompts: string[] = [];
    fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      const prompt = body.messages[1]?.content ?? "";
      userPrompts.push(prompt);
      if (prompt.includes("人物名称变体确认器")) {
        const keys = [...prompt.matchAll(/"key":"([^"]+)"/gu)].map((match) => match[1]);
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(keys.map((key) => ({
          key,
          verdict: "same",
          confidence: 0.96,
          reason: "片段中的行为和对手关系与目标人物一致"
        }))) } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "[]" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    runtime = createTestRuntime(fetchMock);
    const { workId, chapters } = await seedWork(runtime);
    await request(runtime.app).patch(`/api/chapters/${chapters[0].id}`).send({
      content: "摩斯拉在旧港独自追踪拉顿留下的痕迹。"
    }).expect(200);
    await request(runtime.app).patch(`/api/chapters/${chapters[1].id}`).send({
      content: "这段正文没有任何目标人物，不应作为全文发送。"
    }).expect(200);
    const target = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "魔斯拉" }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "拉顿" }).expect(201);
    const modelId = await configureAi(runtime, workId);
    const aiInternals = runtime.ai as unknown as {
      relationshipFuzzyIndexMatches: (...args: unknown[]) => Set<string>;
      ensureRelationshipSearchIndex: (targetWorkId: string) => Promise<number>;
      localRelationshipSourceSelection: (
        targetWorkId: string,
        scope: Record<string, unknown>,
        characters: Record<string, unknown>[],
        selectedCharacterIds: Set<string>,
        generation: number
      ) => Promise<Record<string, unknown>>;
    };
    const originalFuzzyIndexMatches = aiInternals.relationshipFuzzyIndexMatches.bind(aiInternals);
    let fuzzyIndexSelectionCount = 0;
    aiInternals.relationshipFuzzyIndexMatches = (...args: unknown[]) => {
      fuzzyIndexSelectionCount += 1;
      return originalFuzzyIndexMatches(...args);
    };
    const generation = await aiInternals.ensureRelationshipSearchIndex(workId);
    await Promise.all(Array.from({ length: 10 }, () => aiInternals.localRelationshipSourceSelection(
      workId,
      { type: "book", characterIds: [target.body.data.id] },
      runtime.store.listCharacters(workId),
      new Set([String(target.body.data.id)]),
      generation
    )));
    expect(fuzzyIndexSelectionCount).toBe(1);
    const runTask = async () => {
      const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
        taskType: "relationship-analysis",
        scope: { type: "book", characterIds: [target.body.data.id] },
        modelId
      }).expect(201);
      return request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId }).expect(200);
    };
    const [first, second] = await Promise.all([runTask(), runTask()]);
    expect(first.body.data.result.sourceSelection).toMatchObject({
      exactSourceCount: 0,
      confirmedSourceCount: 1,
      rejectedSourceCount: 0,
      uncertainSourceCount: 0
    });
    expect(first.body.data.result.sourceSelection.fuzzyCandidateCount).toBeGreaterThan(0);
    expect(first.body.data.result.sourceSelection.reviewIds).toHaveLength(1);
    expect(second.body.data.result.sourceSelection.reviewIds).toEqual(first.body.data.result.sourceSelection.reviewIds);
    const reviews = await request(runtime.app).get(`/api/works/${workId}/reviews`).expect(200);
    const variants = reviews.body.data.filter((item: { itemType: string }) => item.itemType === "character-name-variant");
    expect(variants).toHaveLength(1);
    expect(variants[0]).toMatchObject({ title: "疑似人物名错字：摩斯拉 → 魔斯拉" });
    expect(variants[0].evidence[0]).toMatchObject({ sourceTitle: chapters[0].title, observed: "摩斯拉" });
    const fullSourcePrompts = userPrompts.filter((prompt) => prompt.includes("定向人物关系证据收集器"));
    expect(fullSourcePrompts.some((prompt) => prompt.includes("摩斯拉在旧港独自追踪拉顿留下的痕迹。"))).toBe(true);
    expect(userPrompts.every((prompt) => !prompt.includes("这段正文没有任何目标人物，不应作为全文发送。"))).toBe(true);

    const promptCount = userPrompts.length;
    const repeatedTask = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "relationship-analysis",
      scope: { type: "book", characterIds: [target.body.data.id] },
      modelId
    }).expect(201);
    const verificationCountBeforeRun = userPrompts.filter((prompt) => prompt.includes("人物名称变体确认器")).length;
    await request(runtime.app).post(`/api/tasks/${repeatedTask.body.data.id}/run`).send({}).expect(200);
    expect(userPrompts.filter((prompt) => prompt.includes("人物名称变体确认器"))).toHaveLength(verificationCountBeforeRun);
    const repeatedTaskPrompts = userPrompts.slice(promptCount);
    expect(repeatedTaskPrompts.every((prompt) => !prompt.includes("审核项：疑似人物名错字"))).toBe(true);
  });

  it("疑似写法确认结果不完整时在创建前失败且不写入任务和审核项", async () => {
    fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "[]" } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    runtime = createTestRuntime(fetchMock);
    const { workId, chapters } = await seedWork(runtime);
    await request(runtime.app).patch(`/api/chapters/${chapters[0].id}`).send({
      content: "摩斯拉在旧港追踪拉顿。"
    }).expect(200);
    const target = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "魔斯拉" }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "拉顿" }).expect(201);
    const modelId = await configureAi(runtime, workId);
    const failed = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "relationship-analysis",
      scope: { type: "book", characterIds: [target.body.data.id] },
      modelId
    }).expect(502);
    expect(failed.body.error.code).toBe("RELATIONSHIP_VARIANT_VERIFICATION_FAILED");
    const tasks = await request(runtime.app).get(`/api/works/${workId}/tasks`).expect(200);
    expect(tasks.body.data.items.filter((item: { taskType: string }) => item.taskType === "relationship-analysis")).toEqual([]);
    const relationships = await request(runtime.app).get(`/api/works/${workId}/relationships`).expect(200);
    expect(relationships.body.data).toEqual([]);
    const reviews = await request(runtime.app).get(`/api/works/${workId}/reviews`).expect(200);
    expect(reviews.body.data.filter((item: { itemType: string }) => item.itemType === "character-name-variant")).toEqual([]);
  });

  it("两字人物疑似写法只召回同时命中身份锚点的来源", async () => {
    const userPrompts: string[] = [];
    fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      const prompt = body.messages[1]?.content ?? "";
      userPrompts.push(prompt);
      if (prompt.includes("人物名称变体确认器")) {
        const keys = [...prompt.matchAll(/"key":"([^"]+)"/gu)].map((match) => match[1]);
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(keys.map((key) => ({
          key,
          verdict: "same",
          confidence: 0.9,
          reason: "人物代码与目标档案一致"
        }))) } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "[]" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    runtime = createTestRuntime(fetchMock);
    const { workId, chapters } = await seedWork(runtime);
    await request(runtime.app).patch(`/api/chapters/${chapters[0].id}`).send({
      content: "临舟在旧港独自查看潮汐，这里没有身份资料。"
    }).expect(200);
    await request(runtime.app).patch(`/api/chapters/${chapters[1].id}`).send({
      content: "临舟驾驶编号 A17 的调查艇进入深空。"
    }).expect(200);
    const target = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "林舟", code: "A17" }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "沈星" }).expect(201);
    const modelId = await configureAi(runtime, workId);
    (runtime.ai as unknown as { relationshipFuzzyIndexMatches: () => Set<string> }).relationshipFuzzyIndexMatches = () => {
      throw new Error("两字名称不应先经过可能截断身份锚点的普通模糊索引查询");
    };
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "relationship-analysis",
      scope: { type: "book", characterIds: [target.body.data.id] },
      modelId
    }).expect(201);
    const result = await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId }).expect(200);
    expect(result.body.data.result).toMatchObject({ coveredChapterCount: 1 });
    expect(result.body.data.result.sourceSelection.confirmedSourceCount).toBe(1);
    expect(userPrompts.some((prompt) => prompt.includes("临舟驾驶编号 A17 的调查艇进入深空。"))).toBe(true);
    expect(userPrompts.every((prompt) => !prompt.includes("临舟在旧港独自查看潮汐，这里没有身份资料。"))).toBe(true);
  });

  it("仅在发送给 AI 时合并正文和设定中的连续空行", async () => {
    const userPrompts: string[] = [];
    fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      userPrompts.push(body.messages[1]?.content ?? "");
      return new Response(JSON.stringify({ choices: [{ message: { content: "[]" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    runtime = createTestRuntime(fetchMock);
    const { workId, chapters } = await seedWork(runtime);
    const chapterContent = "林舟进入旧港。\n\n\n \n沈星随后抵达。";
    await request(runtime.app).patch(`/api/chapters/${chapters[0].id}`).send({ content: chapterContent }).expect(200);
    const settingContent = "林舟负责守望。\n\n\n\n沈星负责导航。";
    const setting = await request(runtime.app).post(`/api/works/${workId}/settings`).send({
      title: "旧港职责",
      category: "人物关系",
      content: settingContent
    }).expect(201);
    runtime.database.run("UPDATE settings SET content = ? WHERE id = ?", settingContent, setting.body.data.id);
    await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "林舟" }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "沈星" }).expect(201);
    const modelId = await configureAi(runtime, workId);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "relationship-analysis",
      scope: { type: "book", includeAllSettings: true }
    }).expect(201);
    await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId }).expect(200);
    const sent = userPrompts.join("\n");
    expect(sent).toContain("林舟进入旧港。\n\n沈星随后抵达。");
    expect(sent).not.toContain("林舟进入旧港。\n\n\n");
    expect(sent).toContain("林舟负责守望。\\n\\n沈星负责导航。");
    expect(sent).not.toContain("林舟负责守望。\\n\\n\\n");
    const storedChapter = await request(runtime.app).get(`/api/chapters/${chapters[0].id}`).expect(200);
    const storedSetting = await request(runtime.app).get(`/api/settings/${setting.body.data.id}`).expect(200);
    expect(storedChapter.body.data.content).toBe(chapterContent);
    expect(storedSetting.body.data.content).toBe(settingContent);
  });

  it("未勾选覆盖时保留已有关系且只追加不存在的关系", async () => {
    let chapterId = "";
    let linId = "";
    let shenId = "";
    let qiaoId = "";
    fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([{
      fromCharacterId: linId,
      toCharacterId: shenId,
      category: "social",
      subtype: "朋友",
      keywords: ["模型新关键词"],
      directed: false,
      currentStatus: "模型新状态",
      confidence: 0.98,
      timeRange: {},
      evidence: [{ chapterId, quote: "林舟和沈星一直是朋友", supports: "明确朋友关系" }]
    }, {
      fromCharacterId: linId,
      toCharacterId: qiaoId,
      category: "social",
      subtype: "盟友",
      keywords: ["正式结盟", "共同守望"],
      directed: false,
      currentStatus: "active",
      confidence: 0.92,
      timeRange: {},
      evidence: [{ chapterId, quote: "林舟与乔安正式结盟", supports: "明确联盟关系" }]
    }]) } }] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    runtime = createTestRuntime(fetchMock);
    const { workId, chapters } = await seedWork(runtime);
    chapterId = String(chapters[0].id);
    await request(runtime.app).patch(`/api/chapters/${chapterId}`).send({
      content: "林舟和沈星一直是朋友。林舟与乔安正式结盟。"
    }).expect(200);
    const lin = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "林舟" }).expect(201);
    const shen = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "沈星" }).expect(201);
    const qiao = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "乔安" }).expect(201);
    const ye = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "叶宁" }).expect(201);
    linId = lin.body.data.id as string;
    shenId = shen.body.data.id as string;
    qiaoId = qiao.body.data.id as string;
    const existingFriend = await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: linId,
      toCharacterId: shenId,
      category: "social",
      subtype: "朋友",
      keywords: ["作者原关键词"],
      directed: false,
      currentStatus: "作者原状态",
      confidence: 0.7,
      confirmationStatus: "pending"
    }).expect(201);
    const unrelatedPending = await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: qiaoId,
      toCharacterId: ye.body.data.id,
      category: "conflict",
      subtype: "竞争者",
      directed: false,
      confirmationStatus: "pending"
    }).expect(201);
    const modelId = await configureAi(runtime, workId);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "relationship-analysis",
      scope: { type: "book" }
    }).expect(201);
    const result = await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId }).expect(200);
    expect(result.body.data.result.candidateCount).toBe(1);
    expect(result.body.data.result.skipped.some((item: { reason: string }) => item.reason.includes("追加模式不更新"))).toBe(true);
    const relationships = await request(runtime.app).get(`/api/works/${workId}/relationships`).expect(200);
    expect(relationships.body.data).toHaveLength(3);
    expect(relationships.body.data.find((item: { id: string }) => item.id === existingFriend.body.data.id)).toMatchObject({
      keywords: ["作者原关键词"],
      currentStatus: "作者原状态",
      confidence: 0.7,
      evidence: [],
      versionNo: 1
    });
    expect(relationships.body.data.some((item: { id: string }) => item.id === unrelatedPending.body.data.id)).toBe(true);
    expect(relationships.body.data.some((item: { fromCharacterId: string; toCharacterId: string; subtype: string }) =>
      new Set([item.fromCharacterId, item.toCharacterId]).has(linId)
      && new Set([item.fromCharacterId, item.toCharacterId]).has(qiaoId)
      && item.subtype === "盟友"
    )).toBe(true);
  });

  it("覆盖定向角色关系并在归纳失败时保留全部旧关系", async () => {
    let linId = "";
    let shenId = "";
    let failAggregation = false;
    fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      const prompt = body.messages[1]?.content ?? "";
      if (prompt.includes("小说人物关系全局归纳器")) {
        if (failAggregation) {
          return new Response(JSON.stringify({ error: { code: "aggregation_failed" } }), { status: 503, headers: { "Content-Type": "application/json" } });
        }
        const chapterId = prompt.match(/"chapterId":"([^"]+)"/u)?.[1] ?? "";
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([{
          fromCharacterId: linId,
          toCharacterId: shenId,
          category: "social",
          subtype: "朋友",
          keywords: ["长期信任", "北港重逢"],
          directed: false,
          currentStatus: "active",
          confidence: 0.91,
          timeRange: {},
          evidence: [{ chapterId, chapterTitle: "第一章 埋线", quote: "我们一直是朋友", contextType: "current", supports: "原文直接说明" }]
        }]) } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const chapterId = prompt.match(/<CHAPTER id="([^"]+)"/u)?.[1] ?? "";
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([{
        targetCharacterId: linId,
        relatedCharacterId: shenId,
        observation: "两人是长期朋友",
        possibleCategory: "social",
        possibleSubtype: "朋友",
        chapterId,
        chapterTitle: "第一章 埋线",
        quote: "我们一直是朋友",
        contextType: "current"
      }]) } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    runtime = createTestRuntime(fetchMock);
    const { workId } = await seedWork(runtime);
    const lin = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "林舟" }).expect(201);
    const shen = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "沈星" }).expect(201);
    const qiao = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "乔安" }).expect(201);
    const ye = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "叶宁" }).expect(201);
    linId = lin.body.data.id as string;
    shenId = shen.body.data.id as string;
    const lockedOld = await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: linId, toCharacterId: shenId, category: "social", subtype: "旧识", confirmationStatus: "confirmed", locked: true
    }).expect(201);
    const pendingOld = await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: linId, toCharacterId: qiao.body.data.id, category: "conflict", subtype: "竞争者", confirmationStatus: "pending"
    }).expect(201);
    const unrelated = await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: shenId, toCharacterId: ye.body.data.id, category: "social", subtype: "同事", confirmationStatus: "confirmed"
    }).expect(201);
    const modelId = await configureAi(runtime, workId);
    const createTask = () => request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "relationship-analysis",
      scope: { type: "book", characterIds: [linId], replaceExistingRelationships: true }
    });
    const task = await createTask().expect(201);
    expect(task.body.data.scopeSummary).toBe("全书 · 定向 1 人：林舟 · 已预检 2 条来源 · 覆盖已有关系");
    const result = await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId }).expect(200);
    expect(result.body.data.result.replacedRelationshipCount).toBe(2);
    const replaced = await request(runtime.app).get(`/api/works/${workId}/relationships`).expect(200);
    expect(replaced.body.data.some((relationship: { id: string }) => relationship.id === lockedOld.body.data.id || relationship.id === pendingOld.body.data.id)).toBe(false);
    expect(replaced.body.data.some((relationship: { id: string }) => relationship.id === unrelated.body.data.id)).toBe(true);
    const currentTargetRelationships = replaced.body.data.filter((relationship: { fromCharacterId: string; toCharacterId: string }) =>
      relationship.fromCharacterId === linId || relationship.toCharacterId === linId
    );
    expect(currentTargetRelationships).toHaveLength(1);
    expect(currentTargetRelationships[0]).toMatchObject({ subtype: "朋友", confirmationStatus: "pending", locked: false });

    failAggregation = true;
    const failureTask = await createTask().expect(201);
    await request(runtime.app).post(`/api/tasks/${failureTask.body.data.id}/run`).send({ modelId }).expect(502);
    const afterFailure = await request(runtime.app).get(`/api/works/${workId}/relationships`).expect(200);
    expect(afterFailure.body.data).toEqual(replaced.body.data);

    failAggregation = false;
    const previewTask = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "relationship-analysis",
      scope: {
        type: "book",
        characterIds: [linId],
        replaceExistingRelationships: true,
        previewRelationshipChanges: true
      }
    }).expect(201);
    const previewResult = await request(runtime.app).post(`/api/tasks/${previewTask.body.data.id}/run`).send({ modelId }).expect(200);
    expect(previewResult.body.data.result).toMatchObject({
      relationshipIds: [],
      createdCount: 1,
      updatedCount: 0,
      deletedCount: 1,
      relationshipChangePreview: {
        status: "pending",
        totalCount: 2,
        createdCount: 1,
        updatedCount: 0,
        deletedCount: 1
      }
    });
    expect(previewResult.body.data.result.relationshipResults.map((item: { action: string }) => item.action).sort())
      .toEqual(["created", "deleted"]);
    const beforeApply = await request(runtime.app).get(`/api/works/${workId}/relationships`).expect(200);
    expect(beforeApply.body.data).toEqual(replaced.body.data);
    const previewDetail = await request(runtime.app).get(`/api/tasks/${previewTask.body.data.id}/detail`).expect(200);
    expect(previewDetail.body.data.resultSummary).toMatchObject({
      relationshipChangePreview: { status: "pending", totalCount: 2, createdCount: 1, deletedCount: 1 }
    });
    expect(previewDetail.body.data.resultSummary.summary).toContain("尚未写入人物关系库");

    const applied = await request(runtime.app).post(`/api/tasks/${previewTask.body.data.id}/relationship-changes/apply`).send({}).expect(200);
    expect(applied.body.data.result.relationshipChangePreview.status).toBe("applied");
    expect(applied.body.data.result.relationshipIds).toHaveLength(1);
    const afterApply = await request(runtime.app).get(`/api/works/${workId}/relationships`).expect(200);
    const appliedTargetRelationships = afterApply.body.data.filter((relationship: { fromCharacterId: string; toCharacterId: string }) =>
      relationship.fromCharacterId === linId || relationship.toCharacterId === linId
    );
    expect(appliedTargetRelationships).toHaveLength(1);
    expect(appliedTargetRelationships[0]).toMatchObject({ subtype: "朋友", confirmationStatus: "pending" });
    expect(appliedTargetRelationships[0].id).not.toBe(currentTargetRelationships[0].id);
    const repeatedApply = await request(runtime.app).post(`/api/tasks/${previewTask.body.data.id}/relationship-changes/apply`).send({}).expect(409);
    expect(repeatedApply.body.error.code).toBe("RELATIONSHIP_PREVIEW_NOT_PENDING");

    const staleTask = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "relationship-analysis",
      scope: {
        type: "book",
        characterIds: [linId],
        replaceExistingRelationships: true,
        previewRelationshipChanges: true
      }
    }).expect(201);
    await request(runtime.app).post(`/api/tasks/${staleTask.body.data.id}/run`).send({ modelId }).expect(200);
    const manuallyUpdated = await request(runtime.app).patch(`/api/relationships/${appliedTargetRelationships[0].id}`).send({
      currentStatus: "作者刚刚修改"
    }).expect(200);
    const staleApply = await request(runtime.app).post(`/api/tasks/${staleTask.body.data.id}/relationship-changes/apply`).send({}).expect(409);
    expect(staleApply.body.error.code).toBe("RELATIONSHIP_PREVIEW_SOURCE_CHANGED");
    const afterStaleApply = await request(runtime.app).get(`/api/relationships/${appliedTargetRelationships[0].id}`).expect(200);
    expect(afterStaleApply.body.data).toMatchObject({
      currentStatus: "作者刚刚修改",
      versionNo: manuallyUpdated.body.data.versionNo
    });
    const discarded = await request(runtime.app).post(`/api/tasks/${staleTask.body.data.id}/relationship-changes/discard`).send({}).expect(200);
    expect(discarded.body.data.result.relationshipChangePreview.status).toBe("discarded");
    const applyDiscarded = await request(runtime.app).post(`/api/tasks/${staleTask.body.data.id}/relationship-changes/apply`).send({}).expect(409);
    expect(applyDiscarded.body.error.code).toBe("RELATIONSHIP_PREVIEW_NOT_PENDING");

    const rosterPreviewTask = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "relationship-analysis",
      scope: {
        type: "book",
        characterIds: [linId],
        replaceExistingRelationships: true,
        previewRelationshipChanges: true
      }
    }).expect(201);
    await request(runtime.app).post(`/api/tasks/${rosterPreviewTask.body.data.id}/run`).send({ modelId }).expect(200);
    await request(runtime.app).patch(`/api/characters/${linId}`).send({ aliases: ["小舟"] }).expect(200);
    const staleRosterApply = await request(runtime.app)
      .post(`/api/tasks/${rosterPreviewTask.body.data.id}/relationship-changes/apply`)
      .send({})
      .expect(409);
    expect(staleRosterApply.body.error.code).toBe("RELATIONSHIP_PREVIEW_SOURCE_CHANGED");

    const setting = await request(runtime.app).post(`/api/works/${workId}/settings`).send({
      title: "林舟关系补充",
      category: "人物关系",
      content: "林舟与沈星曾长期并肩行动。"
    }).expect(201);
    const settingsPreviewTask = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "relationship-analysis",
      scope: {
        type: "book",
        includeAllSettings: true,
        characterIds: [linId],
        replaceExistingRelationships: true,
        previewRelationshipChanges: true,
        additionalPrompt: "验证设定来源过期保护"
      }
    }).expect(201);
    await request(runtime.app).post(`/api/tasks/${settingsPreviewTask.body.data.id}/run`).send({ modelId }).expect(200);
    await request(runtime.app).patch(`/api/settings/${setting.body.data.id}`).send({
      content: "林舟与沈星的关系设定已由作者修改。"
    }).expect(200);
    const staleSettingsApply = await request(runtime.app)
      .post(`/api/tasks/${settingsPreviewTask.body.data.id}/relationship-changes/apply`)
      .send({})
      .expect(409);
    expect(staleSettingsApply.body.error.code).toBe("RELATIONSHIP_PREVIEW_SOURCE_CHANGED");
  });

  it("拒绝不适用于当前任务或缺少角色前提的关系分析选项", async () => {
    runtime = createTestRuntime(vi.fn<typeof fetch>());
    const { workId } = await seedWork(runtime);
    await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "timeline-analysis",
      scope: { type: "book", includeAllSettings: true }
    }).expect(400);
    await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "timeline-analysis",
      scope: { type: "book", additionalPrompt: "不应被接受" }
    }).expect(400);
    await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "relationship-analysis",
      scope: { type: "book", replaceExistingRelationships: true }
    }).expect(400);
    await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "relationship-analysis",
      scope: { type: "book", preFilterRelationshipSources: false }
    }).expect(400);
    await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "timeline-analysis",
      scope: { type: "book", characterIds: ["character_not_allowed"] }
    }).expect(400);
    await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "timeline-analysis",
      scope: { type: "book", preFilterRelationshipSources: false }
    }).expect(400);
    await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "timeline-analysis",
      scope: { type: "book", previewRelationshipChanges: true }
    }).expect(400);
  });

  it("已有强关系时忽略同人物对的弱语义重复边", async () => {
    let firstChapterId = "";
    fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([{
      fromCharacterId: "林舟",
      toCharacterId: "沈星",
      category: "emotional",
      subtype: "亲密羁绊",
      directed: false,
      currentStatus: "active",
      confidence: 0.9,
      timeRange: {},
      evidence: [{ chapterId: firstChapterId, chapterTitle: "第一章 埋线", quote: "我们一直是朋友", contextType: "current", supports: "两人关系亲密" }]
    }, {
      fromCharacterId: "林舟",
      toCharacterId: "沈星",
      category: "social",
      subtype: "朋友",
      directed: false,
      currentStatus: "active",
      confidence: 0.9,
      timeRange: {},
      evidence: [{ chapterId: firstChapterId, chapterTitle: "第一章 埋线", quote: "我们一直是朋友", contextType: "current", supports: "两人是朋友" }]
    }, {
      fromCharacterId: "林舟",
      toCharacterId: "沈星",
      category: "conflict",
      subtype: "战时敌对",
      directed: false,
      currentStatus: "active",
      confidence: 0.9,
      timeRange: {},
      evidence: [{ chapterId: firstChapterId, chapterTitle: "第一章 埋线", quote: "我们一直是朋友", contextType: "historical", supports: "曾在单场战斗中对抗" }]
    }]) } }] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    runtime = createTestRuntime(fetchMock);
    const { workId, chapters } = await seedWork(runtime);
    firstChapterId = chapters[0].id as string;
    const first = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "林舟" }).expect(201);
    const second = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "沈星" }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: first.body.data.id,
      toCharacterId: second.body.data.id,
      category: "emotional",
      subtype: "伴侣",
      directed: false,
      confidence: 0.95
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: first.body.data.id,
      toCharacterId: second.body.data.id,
      category: "conflict",
      subtype: "宿敌",
      directed: false,
      confidence: 0.95
    }).expect(201);
    const modelId = await configureAi(runtime, workId);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "relationship-analysis",
      scope: { type: "chapter", chapterId: firstChapterId }
    }).expect(201);
    const result = await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId }).expect(200);
    expect(result.body.data.result.candidateCount).toBe(0);
    expect(result.body.data.result.skipped.some((item: { reason: string }) => item.reason.includes("已有伴侣关系"))).toBe(true);
    expect(result.body.data.result.skipped.some((item: { reason: string }) => item.reason.includes("已有宿敌关系") && item.reason.includes("战时敌对"))).toBe(true);
    const relationships = await request(runtime.app).get(`/api/works/${workId}/relationships`).expect(200);
    expect(relationships.body.data).toHaveLength(2);
    expect(relationships.body.data.map((item: { subtype: string }) => item.subtype).sort()).toEqual(["伴侣", "宿敌"]);
  });

  it("已有亲属监护或更强同级关系时忽略弱重复边", async () => {
    let chapterId = "";
    fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([
      { fromCharacterId: "林舟", toCharacterId: "沈星", category: "social", subtype: "同事", directed: false, currentStatus: "active", confidence: 0.9, timeRange: {}, evidence: [{ chapterId, quote: "林舟说：沈星是我的同事", supports: "明确同事" }] },
      { fromCharacterId: "林舟", toCharacterId: "沈星", category: "emotional", subtype: "亲密羁绊", directed: false, currentStatus: "active", confidence: 0.9, timeRange: {}, evidence: [{ chapterId, quote: "林舟说：沈星是我的同事", supports: "关系亲密" }] },
      { fromCharacterId: "乔安", toCharacterId: "叶宁", category: "social", subtype: "朋友", directed: false, currentStatus: "active", confidence: 0.9, timeRange: {}, evidence: [{ chapterId, quote: "乔安说：叶宁是我的朋友", supports: "明确朋友" }] },
      { fromCharacterId: "罗川", toCharacterId: "苏澜", category: "social", subtype: "朋友", directed: false, currentStatus: "active", confidence: 0.9, timeRange: {}, evidence: [{ chapterId, quote: "罗川说：苏澜是我最好的朋友", supports: "明确朋友" }] },
      { fromCharacterId: "罗川", toCharacterId: "苏澜", category: "emotional", subtype: "亲密羁绊", directed: false, currentStatus: "active", confidence: 0.9, timeRange: {}, evidence: [{ chapterId, quote: "罗川说：苏澜是我最好的朋友", supports: "关系亲密" }] }
    ]) } }] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    runtime = createTestRuntime(fetchMock);
    const { workId, chapters } = await seedWork(runtime);
    chapterId = String(chapters[0].id);
    await request(runtime.app).patch(`/api/chapters/${chapterId}`).send({
      content: "林舟说：沈星是我的同事。乔安说：叶宁是我的朋友。罗川说：苏澜是我最好的朋友。"
    }).expect(200);
    const characters = new Map<string, string>();
    for (const name of ["林舟", "沈星", "乔安", "叶宁", "罗川", "苏澜"]) {
      const character = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name }).expect(201);
      characters.set(name, character.body.data.id as string);
    }
    await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: characters.get("林舟"), toCharacterId: characters.get("沈星"), category: "family", subtype: "手足", directed: false
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: characters.get("乔安"), toCharacterId: characters.get("叶宁"), category: "social", subtype: "盟友", directed: false
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: characters.get("罗川"), toCharacterId: characters.get("苏澜"), category: "social", subtype: "姐弟般挚友与监护", directed: true
    }).expect(201);
    const modelId = await configureAi(runtime, workId);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "relationship-analysis",
      scope: { type: "chapter", chapterId }
    }).expect(201);
    const result = await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId }).expect(200);
    expect(result.body.data.result.candidateCount).toBe(0);
    const reasons = result.body.data.result.skipped.map((item: { reason: string }) => item.reason).join("\n");
    expect(reasons).toContain("已有亲属或监护关系");
    expect(reasons).toContain("已有更强的同级社会关系");
    const relationships = await request(runtime.app).get(`/api/works/${workId}/relationships`).expect(200);
    expect(relationships.body.data).toHaveLength(3);
  });

  it("拒绝用单次任务或转发消息推断长期社会关系", async () => {
    let chapterId = "";
    fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      const prompt = body.messages[1]?.content ?? "";
      expect(prompt).toContain("共同执行一次任务、同属一个组织");
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([
        { fromCharacterId: "林舟", toCharacterId: "沈星", category: "social", subtype: "同事", directed: false, currentStatus: "active", confidence: 0.9, timeRange: {}, evidence: [{ chapterId, quote: "林舟和沈星共同执行了一次任务", supports: "共同任务" }] },
        { fromCharacterId: "乔安", toCharacterId: "罗川", category: "social", subtype: "盟友", directed: false, currentStatus: "active", confidence: 0.9, timeRange: {}, evidence: [{ chapterId, quote: "乔安把叶宁的消息转告给罗川", supports: "转发消息" }] },
        { fromCharacterId: "苏澜", toCharacterId: "叶宁", category: "social", subtype: "朋友", directed: false, currentStatus: "active", confidence: 0.9, timeRange: {}, evidence: [{ chapterId, quote: "苏澜对叶宁说：我们一直是朋友", supports: "直接说明" }] }
      ]) } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    runtime = createTestRuntime(fetchMock);
    const { workId, chapters } = await seedWork(runtime);
    chapterId = String(chapters[0].id);
    await request(runtime.app).patch(`/api/chapters/${chapterId}`).send({
      content: "林舟和沈星共同执行了一次任务。乔安把叶宁的消息转告给罗川。苏澜对叶宁说：我们一直是朋友。"
    }).expect(200);
    for (const name of ["林舟", "沈星", "乔安", "罗川", "苏澜", "叶宁"]) {
      await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name }).expect(201);
    }
    const modelId = await configureAi(runtime, workId);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "relationship-analysis",
      scope: { type: "chapter", chapterId }
    }).expect(201);
    const result = await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId }).expect(200);
    expect(result.body.data.result.candidateCount).toBe(1);
    const reasons = result.body.data.result.skipped.map((item: { reason: string }) => item.reason).join("\n");
    expect(reasons).toContain("“同事”缺少明确身份或跨章长期互动证据");
    expect(reasons).toContain("“盟友”缺少明确身份或跨章长期互动证据");
    const relationships = await request(runtime.app).get(`/api/works/${workId}/relationships`).expect(200);
    expect(relationships.body.data).toHaveLength(1);
    expect(relationships.body.data[0]).toMatchObject({ subtype: "朋友" });
  });

  it("先合并跨分块证据再判断长期社会关系", async () => {
    fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      const prompt = body.messages[1]?.content ?? "";
      const candidates: Array<Record<string, unknown>> = [];
      const first = prompt.match(/<CHAPTER id="([^"]+)"[^>]*>[^<]*林舟替沈星挡下攻击/gu)?.[0]?.match(/id="([^"]+)"/u)?.[1];
      const second = prompt.match(/<CHAPTER id="([^"]+)"[^>]*>[^<]*沈星撤离时护住林舟/gu)?.[0]?.match(/id="([^"]+)"/u)?.[1];
      if (first) candidates.push({
        fromCharacterId: "林舟", toCharacterId: "沈星", category: "social", subtype: "旧友", directed: false,
        currentStatus: "active", confidence: 0.9, timeRange: {}, evidence: [{ chapterId: first, quote: "林舟替沈星挡下攻击", supports: "一次保护" }]
      });
      if (second) candidates.push({
        fromCharacterId: "林舟", toCharacterId: "沈星", category: "social", subtype: "朋友", directed: false,
        currentStatus: "active", confidence: 0.9, timeRange: {}, evidence: [{ chapterId: second, quote: "沈星撤离时护住林舟", supports: "再次保护" }]
      });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(candidates) } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    runtime = createTestRuntime(fetchMock);
    const { workId, chapters } = await seedWork(runtime);
    await request(runtime.app).patch(`/api/chapters/${chapters[0].id}`).send({
      content: `林舟替沈星挡下攻击。${"第一处背景。".repeat(1400)}`
    }).expect(200);
    await request(runtime.app).patch(`/api/chapters/${chapters[1].id}`).send({
      content: `沈星撤离时护住林舟。${"第二处背景。".repeat(1400)}`
    }).expect(200);
    await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "林舟" }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "沈星" }).expect(201);
    const modelId = await configureAi(runtime, workId);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "relationship-analysis",
      scope: { type: "book" }
    }).expect(201);
    const result = await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId }).expect(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.body.data.result).toMatchObject({ candidateCount: 1, rawCandidateCount: 2 });
    const relationships = await request(runtime.app).get(`/api/works/${workId}/relationships`).expect(200);
    expect(relationships.body.data).toHaveLength(1);
    expect(relationships.body.data[0]).toMatchObject({ subtype: "朋友" });
    expect(relationships.body.data[0].evidence).toHaveLength(2);
  });

  it("历史已结束的强关系不抑制当前关系阶段", async () => {
    let chapterId = "";
    fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([
      { fromCharacterId: "林舟", toCharacterId: "沈星", category: "social", subtype: "朋友", directed: false, currentStatus: "active", confidence: 0.9, timeRange: {}, evidence: [{ chapterId, quote: "林舟和沈星现在是朋友", supports: "当前朋友" }] },
      { fromCharacterId: "乔安", toCharacterId: "叶宁", category: "social", subtype: "朋友", directed: false, currentStatus: "active", confidence: 0.9, timeRange: {}, evidence: [{ chapterId, quote: "乔安和叶宁现在是朋友", supports: "当前朋友" }] },
      { fromCharacterId: "罗川", toCharacterId: "苏澜", category: "social", subtype: "朋友", directed: false, currentStatus: "active", confidence: 0.9, timeRange: {}, evidence: [{ chapterId, quote: "罗川和苏澜现在是朋友", supports: "当前朋友" }] }
    ]) } }] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    runtime = createTestRuntime(fetchMock);
    const { workId, chapters } = await seedWork(runtime);
    chapterId = String(chapters[0].id);
    await request(runtime.app).patch(`/api/chapters/${chapterId}`).send({
      content: "林舟和沈星现在是朋友。乔安和叶宁现在是朋友。罗川和苏澜现在是朋友。"
    }).expect(200);
    const characters = new Map<string, string>();
    for (const name of ["林舟", "沈星", "乔安", "叶宁", "罗川", "苏澜"]) {
      const character = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name }).expect(201);
      characters.set(name, character.body.data.id as string);
    }
    await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: characters.get("林舟"), toCharacterId: characters.get("沈星"), category: "social", subtype: "盟友", directed: false, currentStatus: "ended"
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: characters.get("乔安"), toCharacterId: characters.get("叶宁"), category: "family", subtype: "手足", directed: false, currentStatus: "historical"
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: characters.get("罗川"), toCharacterId: characters.get("苏澜"), category: "emotional", subtype: "伴侣", directed: false, currentStatus: "关系已结束"
    }).expect(201);
    const modelId = await configureAi(runtime, workId);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({ taskType: "relationship-analysis", scope: { type: "chapter", chapterId } }).expect(201);
    const result = await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId }).expect(200);
    expect(result.body.data.result.candidateCount).toBe(3);
    const relationships = await request(runtime.app).get(`/api/works/${workId}/relationships`).expect(200);
    expect(relationships.body.data).toHaveLength(6);
    expect(relationships.body.data.filter((item: { subtype: string }) => item.subtype === "朋友")).toHaveLength(3);
  });

  it("生命周期抑制双向隔离且否定状态不误判", async () => {
    let chapterId = "";
    fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([
      { fromCharacterId: "林舟", toCharacterId: "沈星", category: "social", subtype: "朋友", directed: false, currentStatus: "ended", confidence: 0.9, timeRange: {}, evidence: [{ chapterId, quote: "林舟和沈星曾经是朋友", supports: "历史朋友" }] },
      { fromCharacterId: "乔安", toCharacterId: "叶宁", category: "social", subtype: "朋友", directed: false, currentStatus: "active", confidence: 0.9, timeRange: {}, evidence: [{ chapterId, quote: "乔安和叶宁现在是朋友", supports: "当前朋友" }] },
      { fromCharacterId: "罗川", toCharacterId: "苏澜", category: "social", subtype: "朋友", directed: false, currentStatus: "active", confidence: 0.9, timeRange: {}, evidence: [{ chapterId, quote: "罗川和苏澜现在是朋友", supports: "当前朋友" }] },
      { fromCharacterId: "赵寻", toCharacterId: "吴桐", category: "social", subtype: "朋友", directed: false, currentStatus: "active", confidence: 0.9, timeRange: {}, evidence: [{ chapterId, quote: "赵寻和吴桐现在是朋友", supports: "当前朋友" }] }
    ]) } }] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    runtime = createTestRuntime(fetchMock);
    const { workId, chapters } = await seedWork(runtime);
    chapterId = String(chapters[0].id);
    await request(runtime.app).patch(`/api/chapters/${chapterId}`).send({ content: "林舟和沈星曾经是朋友。乔安和叶宁现在是朋友。罗川和苏澜现在是朋友。赵寻和吴桐现在是朋友。" }).expect(200);
    const characters = new Map<string, string>();
    for (const name of ["林舟", "沈星", "乔安", "叶宁", "罗川", "苏澜", "赵寻", "吴桐"]) {
      const character = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name }).expect(201);
      characters.set(name, character.body.data.id as string);
    }
    await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: characters.get("林舟"), toCharacterId: characters.get("沈星"), category: "social", subtype: "盟友", directed: false, currentStatus: "active"
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: characters.get("乔安"), toCharacterId: characters.get("叶宁"), category: "social", subtype: "盟友", directed: false, currentStatus: "尚未终止"
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: characters.get("罗川"), toCharacterId: characters.get("苏澜"), category: "social", subtype: "盟友", directed: false, currentStatus: "尚未死亡"
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: characters.get("赵寻"), toCharacterId: characters.get("吴桐"), category: "social", subtype: "盟友", directed: false, currentStatus: "not ended"
    }).expect(201);
    const modelId = await configureAi(runtime, workId);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({ taskType: "relationship-analysis", scope: { type: "chapter", chapterId } }).expect(201);
    const result = await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId }).expect(200);
    expect(result.body.data.result.candidateCount).toBe(1);
    expect(result.body.data.result.skipped.map((item: { reason: string }) => item.reason).join("\n"))
      .toContain("已有更强的同级社会关系");
    const relationships = await request(runtime.app).get(`/api/works/${workId}/relationships`).expect(200);
    expect(relationships.body.data).toHaveLength(5);
    expect(relationships.body.data.filter((item: { subtype: string }) => item.subtype === "朋友")).toHaveLength(1);
  });

  it("显式结束状态优先于当前或持续修饰词", async () => {
    let chapterId = "";
    fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([
      { fromCharacterId: "林舟", toCharacterId: "沈星", category: "social", subtype: "朋友", directed: false, currentStatus: "active", confidence: 0.9, timeRange: {}, evidence: [{ chapterId, quote: "林舟和沈星现在是朋友", supports: "当前朋友" }] },
      { fromCharacterId: "乔安", toCharacterId: "叶宁", category: "social", subtype: "朋友", directed: false, currentStatus: "active", confidence: 0.9, timeRange: {}, evidence: [{ chapterId, quote: "乔安和叶宁现在是朋友", supports: "当前朋友" }] }
    ]) } }] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    runtime = createTestRuntime(fetchMock);
    const { workId, chapters } = await seedWork(runtime);
    chapterId = String(chapters[0].id);
    await request(runtime.app).patch(`/api/chapters/${chapterId}`).send({ content: "林舟和沈星现在是朋友。乔安和叶宁现在是朋友。" }).expect(200);
    const characters = new Map<string, string>();
    for (const name of ["林舟", "沈星", "乔安", "叶宁"]) {
      const character = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name }).expect(201);
      characters.set(name, character.body.data.id as string);
    }
    await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: characters.get("林舟"), toCharacterId: characters.get("沈星"), category: "social", subtype: "盟友", directed: false, currentStatus: "当前已结束"
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: characters.get("乔安"), toCharacterId: characters.get("叶宁"), category: "social", subtype: "盟友", directed: false, currentStatus: "持续至死亡"
    }).expect(201);
    const modelId = await configureAi(runtime, workId);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({ taskType: "relationship-analysis", scope: { type: "chapter", chapterId } }).expect(201);
    const result = await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId }).expect(200);
    expect(result.body.data.result.candidateCount).toBe(2);
    const relationships = await request(runtime.app).get(`/api/works/${workId}/relationships`).expect(200);
    expect(relationships.body.data).toHaveLength(4);
    expect(relationships.body.data.filter((item: { subtype: string }) => item.subtype === "朋友")).toHaveLength(2);
  });

  it("追加模式把新强关系新增为独立边并保留已有弱关系", async () => {
    let chapterId = "";
    fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([{
      fromCharacterId: "林舟", toCharacterId: "沈星", category: "social", subtype: "盟友", directed: false,
      currentStatus: "active", confidence: 0.95, timeRange: {}, keywords: ["正式结盟", "共同守望"],
      evidence: [{ chapterId, quote: "林舟和沈星成为盟友", supports: "正式联盟" }]
    }]) } }] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    runtime = createTestRuntime(fetchMock);
    const { workId, chapters } = await seedWork(runtime);
    chapterId = String(chapters[0].id);
    await request(runtime.app).patch(`/api/chapters/${chapterId}`).send({ content: "林舟和沈星成为盟友。" }).expect(200);
    const first = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "林舟" }).expect(201);
    const second = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "沈星" }).expect(201);
    const weaker = await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: first.body.data.id, toCharacterId: second.body.data.id, category: "social", subtype: "朋友",
      keywords: ["旧有信任"], directed: false, currentStatus: "active", confirmationStatus: "pending"
    }).expect(201);
    const modelId = await configureAi(runtime, workId);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({ taskType: "relationship-analysis", scope: { type: "chapter", chapterId } }).expect(201);
    const result = await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId }).expect(200);
    expect(result.body.data.result).toMatchObject({
      createdCount: 1,
      updatedCount: 0,
      unchangedCount: 0,
      relationshipResults: [{
        action: "created",
        subtype: "盟友",
        keywords: ["正式结盟", "共同守望"]
      }]
    });
    expect(result.body.data.result.relationshipResults[0].relationshipId).not.toBe(weaker.body.data.id);
    expect([
      result.body.data.result.relationshipResults[0].fromCharacterName,
      result.body.data.result.relationshipResults[0].toCharacterName
    ].sort()).toEqual(["林舟", "沈星"].sort());
    const relationships = await request(runtime.app).get(`/api/works/${workId}/relationships`).expect(200);
    expect(relationships.body.data).toHaveLength(2);
    expect(relationships.body.data.find((item: { id: string }) => item.id === weaker.body.data.id)).toMatchObject({
      subtype: "朋友",
      confidence: 0.5,
      keywords: ["旧有信任"],
      versionNo: 1
    });
    expect(relationships.body.data.find((item: { subtype: string }) => item.subtype === "盟友")).toMatchObject({
      confidence: 0.95,
      keywords: ["正式结盟", "共同守望"]
    });
  });

  it("同义社会关系不能绕过长期证据且明示结盟可通过", async () => {
    let chapterId = "";
    fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([
      { fromCharacterId: "林舟", toCharacterId: "沈星", category: "social", subtype: "旧友", directed: false, currentStatus: "active", confidence: 0.9, timeRange: {}, evidence: [{ chapterId, quote: "林舟和沈星共同执行了一次任务", supports: "一次协作" }] },
      { fromCharacterId: "乔安", toCharacterId: "叶宁", category: "social", subtype: "盟友", directed: false, currentStatus: "active", confidence: 0.9, timeRange: {}, evidence: [{ chapterId, quote: "乔安与叶宁正式结盟", supports: "明示结盟" }] }
    ]) } }] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    runtime = createTestRuntime(fetchMock);
    const { workId, chapters } = await seedWork(runtime);
    chapterId = String(chapters[0].id);
    await request(runtime.app).patch(`/api/chapters/${chapterId}`).send({ content: "林舟和沈星共同执行了一次任务。乔安与叶宁正式结盟。" }).expect(200);
    for (const name of ["林舟", "沈星", "乔安", "叶宁"]) {
      await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name }).expect(201);
    }
    const modelId = await configureAi(runtime, workId);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({ taskType: "relationship-analysis", scope: { type: "chapter", chapterId } }).expect(201);
    const result = await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId }).expect(200);
    expect(result.body.data.result.candidateCount).toBe(1);
    expect(result.body.data.result.skipped.map((item: { reason: string }) => item.reason).join("\n"))
      .toContain("“朋友”缺少明确身份或跨章长期互动证据");
    const relationships = await request(runtime.app).get(`/api/works/${workId}/relationships`).expect(200);
    expect(relationships.body.data).toHaveLength(1);
    expect(relationships.body.data[0]).toMatchObject({ subtype: "盟友" });
  });

  it("追加模式遇到已有强边时不合并证据也不清理弱边", async () => {
    let chapterId = "";
    fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([{
      fromCharacterId: "林舟", toCharacterId: "沈星", category: "social", subtype: "盟友", directed: false,
      currentStatus: "active", confidence: 0.97, timeRange: {}, keywords: ["共同守望"],
      evidence: [{ chapterId, quote: "林舟和沈星仍是盟友", supports: "持续联盟" }]
    }]) } }] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    runtime = createTestRuntime(fetchMock);
    const { workId, chapters } = await seedWork(runtime);
    chapterId = String(chapters[0].id);
    await request(runtime.app).patch(`/api/chapters/${chapterId}`).send({ content: "林舟和沈星仍是盟友。" }).expect(200);
    const first = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "林舟" }).expect(201);
    const second = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "沈星" }).expect(201);
    const weaker = await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: first.body.data.id, toCharacterId: second.body.data.id, category: "social", subtype: "朋友",
      directed: false, currentStatus: "active", confirmationStatus: "pending"
    }).expect(201);
    const stronger = await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: first.body.data.id, toCharacterId: second.body.data.id, category: "social", subtype: "盟友",
      directed: false, currentStatus: "active", confirmationStatus: "pending"
    }).expect(201);
    const modelId = await configureAi(runtime, workId);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({ taskType: "relationship-analysis", scope: { type: "chapter", chapterId } }).expect(201);
    const result = await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId }).expect(200);
    expect(result.body.data).toMatchObject({ status: "review" });
    expect(result.body.data.result.candidateCount).toBe(0);
    const relationships = await request(runtime.app).get(`/api/works/${workId}/relationships`).expect(200);
    expect(relationships.body.data).toHaveLength(2);
    expect(relationships.body.data.find((item: { id: string }) => item.id === stronger.body.data.id)).toMatchObject({
      subtype: "盟友",
      confidence: 0.5,
      evidence: [],
      versionNo: 1
    });
    expect(relationships.body.data.find((item: { id: string }) => item.id === weaker.body.data.id)).toMatchObject({
      subtype: "朋友",
      versionNo: 1
    });
  });

  it("拒绝礼称君臣和救援血亲，并把单场宿敌降级为战时敌对", async () => {
    let chapterId = "";
    fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      const prompt = body.messages[1]?.content ?? "";
      expect(prompt).toContain("血亲关系必须有明确亲属称谓");
      expect(prompt).toContain("严格核对对话说话人");
      expect(prompt).toContain("集合身份、分身或内部意识不能当作额外人物扩散关系");
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([
        { fromCharacterId: "林舟", toCharacterId: "沈星", category: "family", subtype: "叔侄", directed: true, currentStatus: "active", confidence: 0.9, timeRange: {}, evidence: [{ chapterId, quote: "有两个幼崽走丢了", supports: "救援幼崽" }] },
        { fromCharacterId: "林舟", toCharacterId: "沈星", category: "social", subtype: "君臣", directed: true, currentStatus: "active", confidence: 0.9, timeRange: {}, evidence: [{ chapterId, quote: "君王估计也会过来", supports: "表现敬畏" }] },
        { fromCharacterId: "林舟", toCharacterId: "沈星", category: "conflict", subtype: "宿敌", directed: false, currentStatus: "active", confidence: 0.9, timeRange: {}, evidence: [{ chapterId, quote: "双方开始战斗", supports: "本场战斗直接对抗" }] }
      ]) } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    runtime = createTestRuntime(fetchMock);
    const { workId, chapters } = await seedWork(runtime);
    chapterId = String(chapters[0].id);
    await request(runtime.app).patch(`/api/chapters/${chapterId}`).send({
      content: "有两个幼崽走丢了。君王估计也会过来。双方开始战斗。"
    }).expect(200);
    await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "林舟" }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "沈星" }).expect(201);
    const modelId = await configureAi(runtime, workId);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "relationship-analysis",
      scope: { type: "chapter", chapterId }
    }).expect(201);
    const result = await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId }).expect(200);
    expect(result.body.data.result.candidateCount).toBe(1);
    expect(result.body.data.result.skipped.map((item: { reason: string }) => item.reason).join("\n")).toContain("血亲关系缺少明确亲属称谓");
    expect(result.body.data.result.skipped.map((item: { reason: string }) => item.reason).join("\n")).toContain("君臣关系缺少权力身份");
    const relationships = await request(runtime.app).get(`/api/works/${workId}/relationships`).expect(200);
    expect(relationships.body.data).toHaveLength(1);
    expect(relationships.body.data[0]).toMatchObject({ category: "conflict", subtype: "战时敌对", directed: false });
  });

  it("自动关系分析跳过作者的话章节", async () => {
    const prompts: string[] = [];
    fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      prompts.push(body.messages[1]?.content ?? "");
      return new Response(JSON.stringify({ choices: [{ message: { content: "[]" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    runtime = createTestRuntime(fetchMock);
    const { workId, volumeId } = await seedWork(runtime);
    await request(runtime.app).post(`/api/works/${workId}/chapters`).send({
      volumeId,
      title: "后记",
      chapterType: "作者的话",
      content: "作者现实中的朋友关系绝不能进入小说人物图。"
    }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "林舟" }).expect(201);
    await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "沈星" }).expect(201);
    const modelId = await configureAi(runtime, workId);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({
      taskType: "relationship-analysis",
      scope: { type: "book" }
    }).expect(201);
    await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId }).expect(200);
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.every((prompt) => !prompt.includes("作者现实中的朋友关系"))).toBe(true);
  });

  it("关系分块全部失败时保留既有候选且任务进入 partial", async () => {
    fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: "unavailable" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    }));
    runtime = createTestRuntime(fetchMock);
    const { workId } = await seedWork(runtime);
    const first = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "林舟" }).expect(201);
    const second = await request(runtime.app).post(`/api/works/${workId}/characters`).send({ name: "沈星" }).expect(201);
    const existing = await request(runtime.app).post(`/api/works/${workId}/relationships`).send({
      fromCharacterId: first.body.data.id,
      toCharacterId: second.body.data.id,
      category: "social",
      subtype: "待核旧友",
      confirmationStatus: "pending"
    }).expect(201);
    const modelId = await configureAi(runtime, workId);
    const task = await request(runtime.app).post(`/api/works/${workId}/tasks`).send({ taskType: "relationship-analysis", scope: { type: "book" } }).expect(201);
    const failed = await request(runtime.app).post(`/api/tasks/${task.body.data.id}/run`).send({ modelId }).expect(502);
    expect(failed.body.error.code).toBe("RELATIONSHIP_ANALYSIS_INCOMPLETE");
    const afterTask = await request(runtime.app).get(`/api/tasks/${task.body.data.id}`).expect(200);
    expect(afterTask.body.data.status).toBe("partial");
    const relationships = await request(runtime.app).get(`/api/works/${workId}/relationships`).expect(200);
    expect(relationships.body.data.some((relationship: { id: string }) => relationship.id === existing.body.data.id)).toBe(true);
  }, 20_000);
});
