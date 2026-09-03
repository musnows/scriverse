import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";
import { decryptObject, isEncryptedEnvelope } from "../../src/backup-encryption.js";
import { createLogger, type LogRecord } from "../../src/logger.js";
import type { S3BackupConnection, S3ListedObject, S3ObjectClient } from "../../src/s3-backup.js";

type StoredObject = {
  body: Buffer;
  contentType: string;
  metadata?: Record<string, string>;
  lastModified: Date;
};

class FakeS3Client implements S3ObjectClient {
  readonly objects = new Map<string, StoredObject>();
  readonly events: string[] = [];
  readonly deletedKeys: string[] = [];
  closed = false;
  failure: Error | null = null;
  failureKeyIncludes: string | null = null;
  onObjectExists: ((key: string) => void) | null = null;

  async objectExists(_bucket: string, key: string): Promise<boolean> {
    this.events.push(`head:${key}`);
    this.onObjectExists?.(key);
    return this.objects.has(key);
  }

  async putObject(input: { bucket: string; key: string; body: Buffer; contentType: string; metadata?: Record<string, string> }): Promise<void> {
    this.events.push(`put:${input.key}`);
    if (this.failure && (!this.failureKeyIncludes || input.key.includes(this.failureKeyIncludes))) throw this.failure;
    this.objects.set(input.key, {
      body: Buffer.from(input.body),
      contentType: input.contentType,
      metadata: input.metadata,
      lastModified: new Date("2026-08-04T03:04:05.678Z")
    });
  }

  async listObjects(_bucket: string, prefix: string): Promise<S3ListedObject[]> {
    this.events.push(`list:${prefix}`);
    return [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, lastModified: value.lastModified }));
  }

  async deleteObjects(_bucket: string, keys: string[]): Promise<void> {
    this.events.push(`delete:${keys.join(",")}`);
    for (const key of keys) {
      this.deletedKeys.push(key);
      this.objects.delete(key);
    }
  }

  close(): void {
    this.closed = true;
  }
}

function testRuntime(options: {
  clientFactory: (connection: S3BackupConnection) => S3ObjectClient;
  databasePath?: string;
  loggerRecords?: LogRecord[];
  requestTimeoutMs?: number;
}): Runtime {
  return createRuntime({
    databasePath: options.databasePath ?? ":memory:",
    masterSecret: "s3-execution-test-master-secret-with-enough-length",
    disableUserAuth: true,
    serveUi: false,
    backupOptions: {
      clientFactory: options.clientFactory,
      snapshotDatabase: () => Buffer.from("consistent-database-snapshot"),
      requestTimeoutMs: options.requestTimeoutMs,
      now: () => new Date("2026-08-04T03:04:05.678Z"),
      logger: createLogger({
        level: "debug",
        now: () => new Date("2026-08-04T03:04:05.678Z"),
        write: (_level, record) => options.loggerRecords?.push(record)
      })
    }
  });
}

describe("S3 数据库与图片备份执行", () => {
  const runtimes: Runtime[] = [];
  const roots: string[] = [];

  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) await runtime.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("上传时间戳数据库、跳过已有图片并只清理最老数据库", async () => {
    const client = new FakeS3Client();
    const runtime = testRuntime({ clientFactory: () => client });
    runtimes.push(runtime);
    const work = runtime.store.createWork({ title: "备份测试作品" });
    const cover = Buffer.from("cover-image-content");
    runtime.store.setWorkCover(String(work.id), "image/png", cover);
    const avatarUser = runtime.auth.register({ username: "backup_avatar", password: "backup-avatar-password" }).session.user;
    const avatar = Buffer.from("avatar-image-content");
    runtime.auth.setAvatar(avatarUser.userId, { mimeType: "image/png", content: avatar, width: 1, height: 1 });
    const historicalCharacterAvatar = Buffer.from("historical-character-avatar-content");
    const historicalCharacterAvatarHash = createHash("sha256").update(historicalCharacterAvatar).digest("hex");
    const historicalCharacterAvatarStorageKey = `${historicalCharacterAvatarHash.slice(0, 2)}/${historicalCharacterAvatarHash}.png`;
    runtime.database.run(
      `INSERT INTO im_conversations (
         id, kind, owner_user_id, title, reply_mode, response_threshold, max_ai_messages, created_at, updated_at
       ) VALUES ('im-backup-avatar-history', 'group', ?, '历史头像备份群', 'mention', 60, 20, ?, ?)`,
      avatarUser.userId,
      "2026-08-04T00:00:00.000Z",
      "2026-08-04T00:00:00.000Z"
    );
    runtime.database.run(
      `INSERT INTO im_avatar_versions (
         conversation_id, participant_kind, participant_id, sha256, mime_type, byte_length,
         storage_key, content, width, height, created_at
       ) VALUES ('im-backup-avatar-history', 'character', 'historical-character', ?, 'image/png', ?, ?, NULL, 1, 1, ?)`,
      historicalCharacterAvatarHash,
      historicalCharacterAvatar.byteLength,
      historicalCharacterAvatarStorageKey,
      "2026-08-04T00:00:00.000Z"
    );
    runtime.characterAvatarStorage.read = async (key) => {
      expect(key).toBe(historicalCharacterAvatarStorageKey);
      return historicalCharacterAvatar;
    };

    const attachment = Buffer.from("attachment-image-content");
    const attachmentHash = createHash("sha256").update(attachment).digest("hex");
    const storageKey = `${attachmentHash.slice(0, 2)}/${attachmentHash}.png`;
    runtime.database.run(
      `INSERT INTO attachments (
        id, work_id, original_name, original_mime_type, stored_mime_type, original_byte_length, stored_byte_length,
        original_sha256, stored_sha256, storage_key, width, height, page_count, animated, created_at, created_by_user_id
      ) VALUES ('attachment-backup', ?, 'image.png', 'image/png', 'image/png', ?, ?, ?, ?, ?, 1, 1, 1, 0, ?, NULL)`,
      String(work.id),
      attachment.byteLength,
      attachment.byteLength,
      attachmentHash,
      attachmentHash,
      storageKey,
      "2026-08-04T00:00:00.000Z"
    );
    runtime.attachmentStorage.read = async (key) => {
      expect(key).toBe(storageKey);
      return attachment;
    };

    const rootPrefix = "nightly/scriverse";
    const attachmentObjectKey = `${rootPrefix}/img/${storageKey}`;
    client.objects.set(attachmentObjectKey, {
      body: attachment,
      contentType: "image/png",
      lastModified: new Date("2026-08-01T00:00:00.000Z")
    });
    const avatarHash = createHash("sha256").update(avatar).digest("hex");
    const avatarObjectKey = `${rootPrefix}/img/${avatarHash.slice(0, 2)}/${avatarHash}.png`;
    client.objects.set(avatarObjectKey, {
      body: avatar,
      contentType: "image/png",
      lastModified: new Date("2026-08-01T00:00:00.000Z")
    });
    client.objects.set(`${rootPrefix}/db/scriverse-20260801T000000000Z-a0d00001.db`, {
      body: Buffer.from("old-1"), contentType: "application/vnd.sqlite3", lastModified: new Date("2026-08-01T00:00:00.000Z")
    });
    client.objects.set(`${rootPrefix}/db/scriverse-20260802T000000000Z-a0d00002.db`, {
      body: Buffer.from("old-2"), contentType: "application/vnd.sqlite3", lastModified: new Date("2026-08-02T00:00:00.000Z")
    });
    client.objects.set(`${rootPrefix}/db/manual.db`, {
      body: Buffer.from("manual"), contentType: "application/vnd.sqlite3", lastModified: new Date("2026-08-01T00:00:00.000Z")
    });
    client.objects.set(`${rootPrefix}/db/archive/scriverse-20260801T000000000Z-a0d00003.db`, {
      body: Buffer.from("nested"), contentType: "application/vnd.sqlite3", lastModified: new Date("2026-08-01T00:00:00.000Z")
    });

    const target = runtime.backups.createTarget({
      name: "夜间归档",
      endpoint: "https://s3.example.com",
      bucket: "backup-bucket",
      basePath: "nightly",
      accessKeyId: "access-private",
      secretAccessKey: "secret-private",
      enabled: true,
      backupImages: true,
      retentionCount: 2
    });
    const allSpy = vi.spyOn(runtime.database, "all");
    const getSpy = vi.spyOn(runtime.database, "get");
    const run = await runtime.backups.runTarget(target.id, "manual");

    expect(run).toMatchObject({
      status: "succeeded",
      imagesUploaded: 2,
      imagesSkipped: 2,
      databasesDeleted: 1,
      errorMessage: null
    });
    expect(run.databaseKey).toMatch(/^nightly\/scriverse\/db\/scriverse-20260804T030405678Z-[a-f0-9]{8}\.db$/u);
    expect(client.objects.get(String(run.databaseKey))).toMatchObject({
      body: Buffer.from("consistent-database-snapshot"),
      contentType: "application/vnd.sqlite3"
    });
    expect(client.objects.get(`${rootPrefix}/master.key`)?.body.toString()).toBe("s3-execution-test-master-secret-with-enough-length");
    const coverHash = createHash("sha256").update(cover).digest("hex");
    expect(client.objects.get(`${rootPrefix}/img/${coverHash.slice(0, 2)}/${coverHash}.png`)?.body).toEqual(cover);
    expect(client.objects.get(`${rootPrefix}/img/character-avatars/${historicalCharacterAvatarStorageKey}`)?.body)
      .toEqual(historicalCharacterAvatar);
    const databaseImageMetadataQueries = allSpy.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => sql.includes("work_covers") || sql.includes("user_avatars"));
    expect(databaseImageMetadataQueries).toHaveLength(2);
    expect(databaseImageMetadataQueries.every((sql) => !/\bcontent\b/iu.test(sql))).toBe(true);
    const databaseImageContentQueries = getSpy.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => /\bcontent\b/iu.test(sql) && (sql.includes("work_covers") || sql.includes("user_avatars")));
    expect(databaseImageContentQueries).toHaveLength(1);
    expect(databaseImageContentQueries[0]).toContain("work_covers");
    expect(client.deletedKeys).toEqual([`${rootPrefix}/db/scriverse-20260801T000000000Z-a0d00001.db`]);
    expect(client.objects.has(`${rootPrefix}/db/manual.db`)).toBe(true);
    expect(client.objects.has(`${rootPrefix}/db/archive/scriverse-20260801T000000000Z-a0d00003.db`)).toBe(true);
    expect(client.deletedKeys.every((key) => !key.includes("/img/"))).toBe(true);
    expect(client.closed).toBe(true);
    expect(runtime.database.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("图片远端未命中后按主键读取，并在源记录被删除时明确失败", async () => {
    const client = new FakeS3Client();
    const runtime = testRuntime({ clientFactory: () => client });
    runtimes.push(runtime);
    const work = runtime.store.createWork({ title: "备份删除竞态" });
    const cover = Buffer.from("cover-before-delete");
    runtime.store.setWorkCover(String(work.id), "image/png", cover);
    const coverHash = createHash("sha256").update(cover).digest("hex");
    const objectKey = `scriverse/img/${coverHash.slice(0, 2)}/${coverHash}.png`;
    client.onObjectExists = (key) => {
      if (key !== objectKey) return;
      client.onObjectExists = null;
      runtime.database.run("DELETE FROM work_covers WHERE work_id = ?", String(work.id));
    };
    const target = runtime.backups.createTarget({
      name: "删除竞态目标",
      endpoint: "https://delete-race.example.com",
      bucket: "backup-bucket",
      accessKeyId: "access-delete-race",
      secretAccessKey: "secret-delete-race",
      enabled: true,
      backupImages: true
    });

    const run = await runtime.backups.runTarget(target.id, "manual");

    expect(run).toMatchObject({
      status: "failed",
      imagesUploaded: 0,
      imagesSkipped: 0,
      errorMessage: "待备份作品封面在上传前已被删除，请重新执行备份"
    });
    expect(client.events).not.toContain(`put:${objectKey}`);
  });

  it("图片远端未命中后拒绝上传已替换或校验不一致的内容", async () => {
    for (const scenario of ["replaced", "corrupted"] as const) {
      const client = new FakeS3Client();
      const runtime = testRuntime({ clientFactory: () => client });
      runtimes.push(runtime);
      const work = runtime.store.createWork({ title: `备份内容校验-${scenario}` });
      const cover = Buffer.from("cover-original");
      runtime.store.setWorkCover(String(work.id), "image/png", cover);
      const coverHash = createHash("sha256").update(cover).digest("hex");
      const objectKey = `scriverse/img/${coverHash.slice(0, 2)}/${coverHash}.png`;
      client.onObjectExists = (key) => {
        if (key !== objectKey) return;
        client.onObjectExists = null;
        const nextContent = Buffer.from(scenario === "replaced" ? "cover-replaced" : "cover-tampered");
        if (scenario === "replaced") {
          runtime.database.run(
            "UPDATE work_covers SET content = ?, byte_length = ?, sha256 = ? WHERE work_id = ?",
            nextContent,
            nextContent.byteLength,
            createHash("sha256").update(nextContent).digest("hex"),
            String(work.id)
          );
          return;
        }
        runtime.database.run("UPDATE work_covers SET content = ? WHERE work_id = ?", nextContent, String(work.id));
      };
      const target = runtime.backups.createTarget({
        name: `校验目标-${scenario}`,
        endpoint: `https://${scenario}.example.com`,
        bucket: "backup-bucket",
        accessKeyId: `access-${scenario}`,
        secretAccessKey: `secret-${scenario}`,
        enabled: true,
        backupImages: true
      });

      const run = await runtime.backups.runTarget(target.id, "manual");

      expect(run).toMatchObject({
        status: "failed",
        imagesUploaded: 0,
        imagesSkipped: 0,
        errorMessage: scenario === "replaced"
          ? "待备份作品封面在上传前已被替换，请重新执行备份"
          : "待备份作品封面内容校验失败，请检查数据库完整性"
      });
      expect(client.events).not.toContain(`put:${objectKey}`);
    }
  });

  it("图片上传在客户端重试后仍失败时不增加上传计数", async () => {
    const client = new FakeS3Client();
    client.failure = new Error("image upload failed after retries");
    client.failureKeyIncludes = "/img/";
    const runtime = testRuntime({ clientFactory: () => client });
    runtimes.push(runtime);
    const work = runtime.store.createWork({ title: "图片上传失败" });
    const cover = Buffer.from("failed-image-content");
    runtime.store.setWorkCover(String(work.id), "image/png", cover);
    const target = runtime.backups.createTarget({
      name: "图片失败目标",
      endpoint: "https://image-failure.example.com",
      bucket: "backup-bucket",
      accessKeyId: "access-image-failure",
      secretAccessKey: "secret-image-failure",
      enabled: true,
      backupImages: true
    });

    const run = await runtime.backups.runTarget(target.id, "manual");

    expect(run).toMatchObject({
      status: "failed",
      imagesUploaded: 0,
      imagesSkipped: 0,
      errorMessage: "image upload failed after retries"
    });
    expect(client.events.filter((event) => event.includes("put:scriverse/img/"))).toHaveLength(1);
  });

  it("图片开关关闭时只上传数据库", async () => {
    const client = new FakeS3Client();
    const runtime = testRuntime({ clientFactory: () => client });
    runtimes.push(runtime);
    const target = runtime.backups.createTarget({
      name: "仅数据库",
      endpoint: "https://s3.example.com",
      bucket: "backup-bucket",
      accessKeyId: "access-private",
      secretAccessKey: "secret-private",
      enabled: true,
      backupImages: false
    });

    const run = await runtime.backups.runTarget(target.id, "scheduled");

    expect(run).toMatchObject({ status: "succeeded", imagesUploaded: 0, imagesSkipped: 0 });
    expect(client.events.some((event) => event.startsWith("head:"))).toBe(false);
    expect([...client.objects.keys()]).toEqual([`${target.rootPrefix}/master.key`, run.databaseKey]);
  });

  it("使用校验时解析的地址连接 S3，避免 SDK 再次 DNS 解析", async () => {
    const receivedHosts: string[] = [];
    const server = createServer((request, response) => {
      receivedHosts.push(request.headers.host ?? "");
      request.resume();
      request.on("end", () => {
        if (request.method === "GET") {
          response.setHeader("Content-Type", "application/xml");
          response.end('<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>backup-bucket</Name><Prefix>scriverse/db/</Prefix><KeyCount>0</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>');
          return;
        }
        response.statusCode = 200;
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试 S3 服务未监听 TCP 端口");
    try {
      const endpoint = `http://s3-rebinding.invalid:${address.port}`;
      const runtime = createRuntime({
        databasePath: ":memory:",
        masterSecret: "s3-pinning-test-master-secret-with-enough-length",
        disableUserAuth: true,
        serveUi: false,
        backupOptions: {
          snapshotDatabase: () => Buffer.from("pinned-database-snapshot"),
          requestTimeoutMs: 2_000,
          validateEndpoint: async (candidate) => {
            expect(candidate).toBe(endpoint);
            return [{ address: "127.0.0.1", family: 4 }];
          }
        }
      });
      runtimes.push(runtime);
      const target = runtime.backups.createTarget({
        name: "DNS 固定目标",
        endpoint,
        bucket: "backup-bucket",
        accessKeyId: "access-pinned",
        secretAccessKey: "secret-pinned",
        forcePathStyle: false,
        enabled: true,
        backupImages: false
      });

      const run = await runtime.backups.runTarget(target.id, "manual");

      expect(run.status).toBe("succeeded");
      expect(receivedHosts).toHaveLength(3);
      expect(receivedHosts.every((host) => host === `backup-bucket.s3-rebinding.invalid:${address.port}`)).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("确认前保持明文，确认后加密数据库、恢复密钥与图片，关闭后保留 KEK", async () => {
    const client = new FakeS3Client();
    const runtime = testRuntime({ clientFactory: () => client });
    runtimes.push(runtime);
    const work = runtime.store.createWork({ title: "加密备份测试作品" });
    const pendingCover = Buffer.from("pending-cover-content");
    runtime.store.setWorkCover(String(work.id), "image/png", pendingCover);
    const prepared = runtime.backups.setEncryptionEnabled(true);
    expect(prepared).toMatchObject({
      enabled: false,
      keyConfiguredAt: null,
      key: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      confirmationToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u)
    });
    const key = String(prepared.key);
    const target = runtime.backups.createTarget({
      name: "加密目标",
      endpoint: "https://encrypted.example.com",
      bucket: "backup-bucket",
      accessKeyId: "access-private",
      secretAccessKey: "secret-private",
      enabled: true,
      backupImages: true
    });

    const pendingRun = await runtime.backups.runTarget(target.id, "manual");
    expect(client.objects.get(String(pendingRun.databaseKey))).toMatchObject({
      body: Buffer.from("consistent-database-snapshot"),
      contentType: "application/vnd.sqlite3"
    });
    expect(client.objects.get(`${target.rootPrefix}/master.key`)?.body.toString())
      .toBe("s3-execution-test-master-secret-with-enough-length");
    const pendingCoverHash = createHash("sha256").update(pendingCover).digest("hex");
    expect(client.objects.get(`${target.rootPrefix}/img/${pendingCoverHash.slice(0, 2)}/${pendingCoverHash}.png`))
      .toMatchObject({ body: pendingCover, contentType: "image/png" });

    const enabled = runtime.backups.confirmEncryptionEnabled(String(prepared.confirmationToken));
    expect(enabled).toEqual({ enabled: true, keyConfiguredAt: expect.any(String) });
    const encryptedCover = Buffer.from("encrypted-cover-content");
    runtime.store.setWorkCover(String(work.id), "image/png", encryptedCover);
    const encryptedRun = await runtime.backups.runTarget(target.id, "manual");
    expect(encryptedRun.status).toBe("succeeded");
    const databaseObject = client.objects.get(String(encryptedRun.databaseKey));
    const masterKeyObject = client.objects.get(`${target.rootPrefix}/master.key`);
    const encryptedCoverHash = createHash("sha256").update(encryptedCover).digest("hex");
    const coverObject = client.objects.get(`${target.rootPrefix}/img/${encryptedCoverHash.slice(0, 2)}/${encryptedCoverHash}.png`);
    for (const object of [databaseObject, masterKeyObject, coverObject]) {
      expect(object?.contentType).toBe("application/octet-stream");
      expect(isEncryptedEnvelope(object?.body ?? Buffer.alloc(0))).toBe(true);
    }
    expect(decryptObject(databaseObject!.body, key)).toEqual(Buffer.from("consistent-database-snapshot"));
    expect(decryptObject(masterKeyObject!.body, key).toString()).toBe("s3-execution-test-master-secret-with-enough-length");
    expect(decryptObject(coverObject!.body, key)).toEqual(encryptedCover);
    expect(coverObject?.metadata).toEqual({ sha256: encryptedCoverHash });

    const disabled = runtime.backups.setEncryptionEnabled(false);
    expect(disabled).toEqual({ enabled: false, keyConfiguredAt: enabled.keyConfiguredAt });
    const plaintextCover = Buffer.from("plaintext-cover-content");
    runtime.store.setWorkCover(String(work.id), "image/png", plaintextCover);
    const plaintextRun = await runtime.backups.runTarget(target.id, "manual");
    const plaintextDatabaseObject = client.objects.get(String(plaintextRun.databaseKey));
    const plaintextCoverHash = createHash("sha256").update(plaintextCover).digest("hex");
    const plaintextCoverObject = client.objects.get(`${target.rootPrefix}/img/${plaintextCoverHash.slice(0, 2)}/${plaintextCoverHash}.png`);
    expect(plaintextDatabaseObject).toMatchObject({
      body: Buffer.from("consistent-database-snapshot"),
      contentType: "application/vnd.sqlite3"
    });
    expect(client.objects.get(`${target.rootPrefix}/master.key`)?.body.toString()).toBe("s3-execution-test-master-secret-with-enough-length");
    expect(plaintextCoverObject).toMatchObject({ body: plaintextCover, contentType: "image/png" });
    expect(runtime.backups.setEncryptionEnabled(true)).toEqual({ enabled: true, keyConfiguredAt: enabled.keyConfiguredAt });
  });

  it("单个目标失败后继续顺序执行其他目标，并完整记录脱敏配置及服务端结果", async () => {
    const records: LogRecord[] = [];
    const executionOrder: string[] = [];
    const clients = new Map<string, FakeS3Client>();
    const runtime = testRuntime({
      loggerRecords: records,
      clientFactory: (connection) => {
        executionOrder.push(connection.endpoint);
        const client = new FakeS3Client();
        if (connection.endpoint.includes("failed")) {
          const failure = new Error(`Access denied for ${connection.accessKeyId} and ${connection.secretAccessKey}`) as Error & Record<string, unknown>;
          failure.name = "AccessDenied";
          failure.Code = "AccessDenied";
          failure.RequestId = "request-123";
          failure.$metadata = { httpStatusCode: 403, requestId: "request-123", attempts: 3 };
          failure.$response = {
            statusCode: 403,
            statusMessage: "Forbidden",
            headers: { "x-amz-request-id": "request-123", authorization: "must-not-log" }
          };
          client.failure = failure;
        }
        clients.set(connection.endpoint, client);
        return client;
      }
    });
    runtimes.push(runtime);
    const preparedEncryption = runtime.backups.setEncryptionEnabled(true);
    const encryptionKey = String(preparedEncryption.key);
    runtime.backups.confirmEncryptionEnabled(String(preparedEncryption.confirmationToken));
    for (const [name, endpoint] of [
      ["第一个", "https://first.example.com"],
      ["失败目标", "https://failed.example.com"],
      ["第三个", "https://third.example.com"]
    ] as const) {
      runtime.backups.createTarget({
        name,
        endpoint,
        region: "test-region-1",
        bucket: "backup-bucket",
        basePath: "cluster-a",
        accessKeyId: `access-${name}`,
        secretAccessKey: `secret-${name}`,
        enabled: true,
        backupImages: false,
        scheduleTime: "03:04",
        retentionCount: 9
      });
    }

    const runs = await runtime.backups.runEnabledTargets("scheduled");

    expect(executionOrder).toEqual([
      "https://first.example.com",
      "https://failed.example.com",
      "https://third.example.com"
    ]);
    expect(runs.map((run) => run.status)).toEqual(["succeeded", "failed", "succeeded"]);
    expect(runs[1]?.serverResponse).toMatchObject({
      name: "AccessDenied",
      Code: "AccessDenied",
      RequestId: "request-123",
      $metadata: { httpStatusCode: 403, requestId: "request-123", attempts: 3 },
      httpResponse: { statusCode: 403, statusMessage: "Forbidden", headers: { "x-amz-request-id": "request-123", authorization: "[REDACTED]" } }
    });
    const failureLog = records.find((record) => record.event === "backup.s3_target.failed");
    expect(failureLog).toMatchObject({
      target: {
        name: "失败目标",
        endpoint: "https://failed.example.com",
        region: "test-region-1",
        bucket: "backup-bucket",
        basePath: "cluster-a",
        rootPrefix: "cluster-a/scriverse",
        backupImages: false,
        scheduleTime: "03:04",
        retentionCount: 9
      },
      serverResponse: {
        Code: "AccessDenied",
        RequestId: "request-123",
        httpResponse: { statusCode: 403 }
      }
    });
    const serialized = JSON.stringify({ runs, records });
    for (const secret of ["access-失败目标", "secret-失败目标", "must-not-log", encryptionKey]) {
      expect(serialized).not.toContain(secret);
    }
    expect(clients.get("https://failed.example.com")?.closed).toBe(true);
  });

  it("S3 请求超时后结束当前目标并关闭客户端", async () => {
    let closed = false;
    const hangingClient: S3ObjectClient = {
      objectExists: async () => false,
      putObject: async () => new Promise<void>(() => undefined),
      listObjects: async () => [],
      deleteObjects: async () => undefined,
      close: () => {
        closed = true;
      }
    };
    const runtime = testRuntime({ clientFactory: () => hangingClient, requestTimeoutMs: 10 });
    runtimes.push(runtime);
    const target = runtime.backups.createTarget({
      name: "超时目标",
      endpoint: "https://timeout.example.com",
      bucket: "backup-bucket",
      accessKeyId: "access-timeout",
      secretAccessKey: "secret-timeout",
      enabled: true,
      backupImages: false
    });

    const run = await runtime.backups.runTarget(target.id, "manual");

    expect(run.status).toBe("failed");
    expect(run.errorMessage).toContain("上传 CredentialVault 恢复密钥超时");
    expect(closed).toBe(true);
  });

  it("关闭运行时前限时等待执行中的备份完成并落盘最终状态", async () => {
    const root = mkdtempSync(join(tmpdir(), "scriverse-backup-shutdown-"));
    roots.push(root);
    const databasePath = join(root, "novel.db");
    let releaseUpload = (): void => {
      throw new Error("Upload gate was not initialized");
    };
    const uploadGate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    let notifyUploadStarted = (): void => {
      throw new Error("Upload start notifier was not initialized");
    };
    const uploadStarted = new Promise<void>((resolve) => {
      notifyUploadStarted = resolve;
    });
    let uploadCount = 0;
    const client: S3ObjectClient = {
      objectExists: async () => false,
      putObject: async () => {
        uploadCount += 1;
        if (uploadCount !== 1) return;
        notifyUploadStarted();
        await uploadGate;
      },
      listObjects: async () => [],
      deleteObjects: async () => undefined,
      close: () => undefined
    };
    const runtime = testRuntime({ databasePath, clientFactory: () => client });
    runtimes.push(runtime);
    const target = runtime.backups.createTarget({
      name: "关闭等待目标",
      endpoint: "https://shutdown.example.com",
      bucket: "backup-bucket",
      accessKeyId: "access-shutdown",
      secretAccessKey: "secret-shutdown",
      enabled: true,
      backupImages: false
    });
    runtime.backups.enqueueTargets([target.id], "manual");
    await uploadStarted;

    await expect(runtime.backups.waitForIdle(10)).rejects.toMatchObject({ code: "BACKUP_IDLE_TIMEOUT" });
    expect(runtime.backups.listRuns().items).toEqual([
      expect.objectContaining({ targetId: target.id, status: "running", finishedAt: null })
    ]);

    let closeSettled = false;
    const closePromise = runtime.close().finally(() => {
      closeSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closeSettled).toBe(false);
    expect(() => runtime.backups.enqueueTargets([target.id], "manual")).toThrow("S3 备份服务正在停止");

    releaseUpload();
    await closePromise;
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(database.prepare("SELECT COUNT(*) AS count FROM s3_backup_runs WHERE status = 'running'").get()).toEqual({ count: 0 });
      expect(database.prepare("SELECT status, finished_at FROM s3_backup_runs WHERE target_id = ?").get(target.id)).toMatchObject({
        status: "succeeded",
        finished_at: expect.any(String)
      });
    } finally {
      database.close();
    }
  });
});
