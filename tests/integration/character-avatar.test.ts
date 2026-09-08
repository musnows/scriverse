import { existsSync, statSync } from "node:fs";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createTestRuntime, createWork } from "../helpers.js";
import type { Runtime } from "../../src/app.js";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2z94AAAAASUVORK5CYII=",
  "base64"
);
const onePixelGif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
const maximumCharacterAvatarBytes = 2 * 1024 * 1024;

function gifOfSize(size: number): Buffer {
  return Buffer.concat([onePixelGif.subarray(0, -1), Buffer.alloc(size - onePixelGif.length), onePixelGif.subarray(-1)]);
}

describe("角色头像 API", () => {
  let runtime: Runtime;

  afterEach(async () => {
    await runtime.close();
  });

  it("将头像图片保存到磁盘并返回可读取的角色头像地址", async () => {
    runtime = createTestRuntime();
    const work = await createWork(runtime);
    const character = runtime.store.createCharacter(String(work.id), { name: "林舟" });

    const uploaded = await request(runtime.app)
      .put(`/api/characters/${String(character.id)}/avatar`)
      .attach("file", onePixelPng, { filename: "avatar.png", contentType: "image/png" })
      .expect(200);
    const avatarUrl = String(uploaded.body.data.avatarUrl);
    expect(avatarUrl).toMatch(new RegExp(`^/api/characters/${String(character.id)}/avatar\\?v=[a-f0-9]{64}$`, "u"));

    const columns = runtime.database.all<{ name: string }>("PRAGMA table_info(character_avatars)").map((row) => row.name);
    expect(columns).not.toContain("content");
    const metadata = runtime.database.get<{ storage_key: string; byte_length: number }>(
      "SELECT storage_key, byte_length FROM character_avatars WHERE character_id = ?",
      String(character.id)
    );
    expect(metadata).toBeDefined();
    const storedPath = runtime.characterAvatarStorage.path(String(metadata?.storage_key));
    expect(existsSync(storedPath)).toBe(true);
    expect(statSync(storedPath).size).toBe(Number(metadata?.byte_length));

    const content = await request(runtime.app)
      .get(avatarUrl)
      .expect(200);
    expect(content.headers["content-type"]).toMatch(/^image\/(png|webp)(?:;|$)/u);
    expect(content.body.byteLength).toBe(Number(metadata?.byte_length));

    const removed = await request(runtime.app)
      .delete(`/api/characters/${String(character.id)}/avatar`)
      .expect(200);
    expect(removed.body.data.avatarUrl).toBeNull();
    expect(existsSync(storedPath)).toBe(false);
    expect(runtime.database.get("SELECT character_id FROM character_avatars WHERE character_id = ?", String(character.id))).toBeUndefined();
  });

  it("拒绝 GIF 角色头像", async () => {
    runtime = createTestRuntime();
    const work = await createWork(runtime);
    const character = runtime.store.createCharacter(String(work.id), { name: "GIF角色" });

    const response = await request(runtime.app)
      .put(`/api/characters/${String(character.id)}/avatar`)
      .attach("file", onePixelGif, { filename: "avatar.gif", contentType: "image/gif" })
      .expect(415);
    expect(response.body.error).toEqual({
      code: "UNSUPPORTED_ATTACHMENT",
      message: "角色头像仅支持 PNG、JPEG 和 WebP 图片"
    });
    expect(runtime.database.get("SELECT character_id FROM character_avatars WHERE character_id = ?", String(character.id))).toBeUndefined();
  });

  it("拒绝超过 2 MB 的角色头像", async () => {
    runtime = createTestRuntime();
    const work = await createWork(runtime);
    const character = runtime.store.createCharacter(String(work.id), { name: "超限角色" });

    const response = await request(runtime.app)
      .put(`/api/characters/${String(character.id)}/avatar`)
      .attach("file", gifOfSize(maximumCharacterAvatarBytes + 1), { filename: "large.gif", contentType: "image/gif" })
      .expect(413);
    expect(response.body.error.code).toBe("CHARACTER_AVATAR_TOO_LARGE");
    expect(runtime.database.get("SELECT character_id FROM character_avatars WHERE character_id = ?", String(character.id))).toBeUndefined();
  });

  it("允许跨角色和作品复用头像，移除一个引用不会删除其他角色的文件", async () => {
    runtime = createTestRuntime();
    const work = await createWork(runtime);
    const otherWork = await createWork(runtime, "共享头像的另一部作品");
    const first = runtime.store.createCharacter(String(work.id), { name: "First" });
    const second = runtime.store.createCharacter(String(otherWork.id), { name: "Second" });
    for (const character of [first, second]) {
      await request(runtime.app).put(`/api/characters/${character.id}/avatar`).attach("file", onePixelPng, { filename: "shared.png", contentType: "image/png" }).expect(200);
    }
    const firstAvatar = runtime.store.getCharacterAvatar(String(first.id));
    expect(firstAvatar).not.toBeNull();
    const storageKey = firstAvatar!.storageKey;
    expect(runtime.store.getCharacterAvatar(String(second.id))?.storageKey).toBe(storageKey);
    await request(runtime.app).delete(`/api/characters/${first.id}/avatar`).expect(200);
    expect(existsSync(runtime.characterAvatarStorage.path(storageKey))).toBe(true);
    const content = await request(runtime.app).get(`/api/characters/${second.id}/avatar`).expect(200);
    expect(content.body).toEqual(onePixelPng);
    await request(runtime.app).delete(`/api/characters/${second.id}/avatar`).expect(200);
    expect(existsSync(runtime.characterAvatarStorage.path(storageKey))).toBe(false);
  });

  it("彻底删除作品时清理角色头像文件", async () => {
    runtime = createTestRuntime();
    const work = await createWork(runtime);
    const character = runtime.store.createCharacter(String(work.id), { name: "回收站角色" });
    const uploaded = await request(runtime.app)
      .put(`/api/characters/${String(character.id)}/avatar`)
      .attach("file", onePixelPng, { filename: "avatar.png", contentType: "image/png" })
      .expect(200);
    const storageKey = String(runtime.database.get("SELECT storage_key FROM character_avatars WHERE character_id = ?", String(character.id))?.storage_key);
    const storedPath = runtime.characterAvatarStorage.path(storageKey);
    expect(existsSync(storedPath)).toBe(true);
    expect(uploaded.body.data.avatarUrl).toContain(`/api/characters/${String(character.id)}/avatar`);

    await request(runtime.app).delete(`/api/works/${String(work.id)}`).expect(204);
    expect(existsSync(storedPath)).toBe(true);
    const recycleBin = await request(runtime.app).get("/api/recycle-bin/works").expect(200);
    const deletedWork = recycleBin.body.data.works.find((item: { id: string }) => item.id === String(work.id));
    await request(runtime.app)
      .delete(`/api/recycle-bin/works/${String(work.id)}/permanent`)
      .send({ expectedVersionNo: deletedWork.versionNo })
      .expect(204);
    expect(existsSync(storedPath)).toBe(false);
  });
});
