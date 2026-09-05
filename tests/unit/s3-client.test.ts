import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createLogger, type LogRecord } from "../../src/logger.js";
import { createS3StorageClient, logS3ResponseFailure, redactS3Text, redactS3Value } from "../../src/s3-client.js";
import type { S3Target } from "../../src/s3-backup-settings.js";

const credentials = { accessKeyId: "test-access-key", secretAccessKey: "test-secret-key" };
const target: S3Target = {
  id: "372ca2db-8fd4-4f37-9911-39567f716e6e", name: "Local S3", endpoint: "http://localhost:19091",
  region: "us-east-1", bucket: "backups", prefix: "folder", forcePathStyle: true,
  enabled: true, includeImages: true, scheduleEnabled: true, scheduleTime: "03:00", retentionCount: 7,
  nextRunAt: null, credentials: { encrypted: "encrypted", iv: "iv", tag: "tag" }
};

describe("S3 signed transport", () => {
  it("signs uploads and follows every list page before deletion", async () => {
    const fixture = join(process.cwd(), ".data", "s3-client-tests");
    mkdirSync(fixture, { recursive: true });
    writeFileSync(join(fixture, "snapshot.db"), "SQLite test payload");
    const requests: { method: string; url: URL; headers: Headers }[] = [];
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      requests.push({ method: init?.method ?? "GET", url, headers });
      expect(init?.redirect).toBe("manual");
      expect(headers.get("authorization")).toContain("AWS4-HMAC-SHA256 Credential=test-access-key/");
      expect(headers.get("authorization")).toContain("/us-east-1/s3/aws4_request");
      if (init?.method === "HEAD") return new Response(null, { status: 404 });
      if (init?.method === "GET") {
        const second = url.searchParams.has("continuation-token");
        return new Response(`<ListBucketResult><IsTruncated>${!second}</IsTruncated>${second ? "" : "<NextContinuationToken>page+two/==</NextContinuationToken>"}<Contents><Key>folder/scriverse/db/${second ? "two" : "one"}.db</Key><LastModified>2026-09-05T00:00:00.000Z</LastModified></Contents></ListBucketResult>`, { status: 200, headers: { "content-type": "application/xml" } });
      }
      return new Response(null, { status: init?.method === "DELETE" ? 204 : 200 });
    });
    const client = createS3StorageClient(target, credentials, { fetchImpl, allowPrivateEndpoints: true });
    try {
      expect(await client.exists("folder/scriverse/img/image.png")).toBe(false);
      await client.upload("folder/scriverse/db/snapshot.db", join(fixture, "snapshot.db"), "application/vnd.sqlite3");
      expect((await client.list("folder/scriverse/db/")).map((item) => item.key)).toEqual(["folder/scriverse/db/one.db", "folder/scriverse/db/two.db"]);
      await client.delete("folder/scriverse/db/one.db");
      expect(requests.map((item) => item.method)).toEqual(["HEAD", "PUT", "GET", "GET", "DELETE"]);
      expect(requests[1]!.headers.get("if-none-match")).toBe("*");
      expect(requests[3]!.url.searchParams.get("continuation-token")).toBe("page+two/==");
    } finally { client.close(); }
  });

  it("logs the complete server response and configuration without either credential", async () => {
    const records: LogRecord[] = [];
    const log = createLogger({ level: "error", write: (_level, record) => { records.push(record); } });
    const body = `<Error><Code>AccessDenied</Code><Message>${"diagnostic ".repeat(900)}${credentials.accessKeyId} ${credentials.secretAccessKey}</Message><RequestId>request-123</RequestId></Error>`;
    const client = createS3StorageClient(target, credentials, { allowPrivateEndpoints: true, log,
      fetchImpl: async () => new Response(body, { status: 403, headers: { "x-amz-request-id": "request-123", "content-type": "application/xml" } }) });
    try { await expect(client.list("folder/scriverse/db/")).rejects.toThrow(); } finally { client.close(); }
    expect(records[0]).toMatchObject({ event: "s3.backup.request_failed", status: 403, target: { name: target.name, endpoint: target.endpoint, bucket: target.bucket, prefix: target.prefix, scheduleTime: target.scheduleTime, retentionCount: target.retentionCount } });
    expect(records.filter((record) => record.event === "s3.backup.response_body").map((record) => record.body).join("")).toBe(redactS3Text(body, credentials));
    expect(JSON.stringify(records)).not.toContain(credentials.accessKeyId);
    expect(JSON.stringify(records)).not.toContain(credentials.secretAccessKey);
    expect(JSON.stringify(records)).not.toContain('"encrypted"');
  });

  it("does not misinterpret denied requests as missing images and blocks redirects and metadata endpoints", async () => {
    const denied = createS3StorageClient(target, credentials, { allowPrivateEndpoints: true, fetchImpl: async () => new Response(null, { status: 403 }) });
    try { await expect(denied.exists("img/one.png")).rejects.toThrow(); } finally { denied.close(); }
    const fetchImpl = vi.fn(async () => new Response(null, { status: 301, headers: { location: "http://127.0.0.1:19092" } }));
    const redirect = createS3StorageClient(target, credentials, { allowPrivateEndpoints: true, fetchImpl });
    try { await expect(redirect.list("db/")).rejects.toThrow(); } finally { redirect.close(); }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    fetchImpl.mockClear();
    for (const endpoint of ["http://169.254.169.254", "http://localhost:19091"]) {
      const blocked = createS3StorageClient({ ...target, endpoint }, credentials, { fetchImpl });
      try { await expect(blocked.list("db/")).rejects.toThrow(); } finally { blocked.close(); }
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("redacts escaped secrets without corrupting structured configuration", () => {
    const special = { accessKeyId: 'a"k', secretAccessKey: 'a&<>"/+' };
    expect(redactS3Value({ name: special.accessKeyId, bucket: "bucket" }, special)).toEqual({ name: "[REDACTED]", bucket: "bucket" });
    const records: LogRecord[] = [];
    logS3ResponseFailure(createLogger({ level: "error", write: (_level, record) => { records.push(record); } }), target, special,
      { method: "GET", url: target.endpoint, status: 400, headers: {}, body: `a&amp;&lt;&gt;&quot;/+ ${encodeURIComponent(special.secretAccessKey)}` });
    expect(records[1]?.body).toBe("[REDACTED] [REDACTED]");
  });
});
