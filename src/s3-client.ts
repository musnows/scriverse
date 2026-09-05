import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { S3Client, HeadObjectCommand, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { HttpResponse, type HttpRequest } from "@smithy/protocol-http";
import { assertSafeAiEndpoint, fetchSafeAiEndpoint } from "./security.js";
import { publicS3Target, type S3Target } from "./s3-backup-settings.js";
import { logger, type Logger } from "./logger.js";

export type S3Credentials = { accessKeyId: string; secretAccessKey: string };
export type S3Object = { key: string; modifiedAt?: Date };
export type S3StorageClient = {
  exists: (key: string) => Promise<boolean>;
  upload: (key: string, path: string, contentType: string) => Promise<void>;
  list: (prefix: string) => Promise<S3Object[]>;
  delete: (key: string) => Promise<void>;
  close: () => void;
};

export function redactS3Text(value: string, credentials: S3Credentials): string {
  let result = value;
  for (const secret of [credentials.accessKeyId, credentials.secretAccessKey]) {
    const variants = [secret, encodeURIComponent(secret), secret.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"), JSON.stringify(secret).slice(1, -1)];
    for (const variant of variants) if (variant) result = result.split(variant).join("[REDACTED]");
  }
  return result;
}

export function redactS3Value(value: unknown, credentials: S3Credentials): unknown {
  if (typeof value === "string") return redactS3Text(value, credentials);
  if (Array.isArray(value)) return value.map((item) => redactS3Value(item, credentials));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactS3Value(item, credentials)]));
  return value;
}

function responseHeaders(headers: Headers): Record<string, string> {
  const values: Record<string, string> = {};
  headers.forEach((value, key) => { values[key] = value; });
  return values;
}

export function logS3ResponseFailure(log: Logger, target: S3Target, credentials: S3Credentials, details: {
  method: string; url: string; status: number; headers: Record<string, string>; body: string;
}): void {
  const failureId = randomUUID();
  const scrub = (value: unknown): unknown => redactS3Value(value, credentials);
  log.error("s3.backup.request_failed", { failureId, target: scrub(publicS3Target(target)), method: details.method,
    url: redactS3Text(details.url, credentials), status: details.status, headers: scrub(details.headers) });
  const body = redactS3Text(details.body, credentials);
  // 分段写出全部响应，避免通用日志器的单字段长度限制截断服务端诊断信息。
  const parts = Math.max(1, Math.ceil(body.length / 3000));
  for (let part = 0; part < parts; part += 1) {
    log.error("s3.backup.response_body", { failureId, targetId: target.id, part: part + 1, parts, body: body.slice(part * 3000, (part + 1) * 3000) });
  }
}

export function createS3StorageClient(target: S3Target, credentials: S3Credentials, options: {
  fetchImpl?: typeof fetch; allowPrivateEndpoints?: boolean; signal?: AbortSignal; log?: Logger;
} = {}): S3StorageClient {
  const log = options.log ?? logger;
  const client = new S3Client({
    endpoint: target.endpoint, region: target.region, credentials, forcePathStyle: target.forcePathStyle,
    maxAttempts: 1, requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler: {
      handle: async (request: HttpRequest) => {
        const url = new URL(`${request.protocol}//${request.hostname}${request.port ? `:${request.port}` : ""}${request.path}`);
        for (const [key, value] of Object.entries(request.query ?? {})) {
          for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, item ?? "");
        }
        const observeFetch: typeof fetch = async (input, init) => {
          const response = await (options.fetchImpl ?? fetch)(input, init);
          if (!response.ok && !(request.method === "HEAD" && response.status === 404)) {
            logS3ResponseFailure(log, target, credentials, { method: request.method, url: url.toString(), status: response.status,
              headers: responseHeaders(response.headers), body: await response.clone().text() });
          }
          return response;
        };
        const timeout = AbortSignal.timeout(90_000);
        const init: RequestInit & { duplex: "half" } = {
          method: request.method, headers: request.headers, body: request.body as BodyInit,
          duplex: "half", signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout
        };
        const response = await fetchSafeAiEndpoint(observeFetch, url.toString(), init,
          (value) => assertSafeAiEndpoint(value, options.allowPrivateEndpoints ?? false), 0);
        return { response: new HttpResponse({ statusCode: response.status, headers: responseHeaders(response.headers), body: new Uint8Array(await response.arrayBuffer()) }) };
      }
    }
  });
  return {
    async exists(key) {
      try {
        await client.send(new HeadObjectCommand({ Bucket: target.bucket, Key: key }));
        return true;
      } catch (error) {
        if (error && typeof error === "object" && "$metadata" in error && (error.$metadata as { httpStatusCode?: number }).httpStatusCode === 404) return false;
        throw error;
      }
    },
    async upload(key, path, contentType) {
      const contentLength = (await stat(path)).size;
      const body = createReadStream(path);
      try {
        await client.send(new PutObjectCommand({ Bucket: target.bucket, Key: key, Body: body, ContentLength: contentLength, ContentType: contentType, IfNoneMatch: "*" }));
      } finally {
        body.destroy();
      }
    },
    async list(prefix) {
      const objects: S3Object[] = [];
      let token: string | undefined;
      const seenTokens = new Set<string>();
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket: target.bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 }));
        for (const object of page.Contents ?? []) if (object.Key) objects.push({ key: object.Key, modifiedAt: object.LastModified });
        if (!page.IsTruncated) break;
        if (!page.NextContinuationToken || seenTokens.has(page.NextContinuationToken)) throw new Error("S3 listing returned an invalid continuation token");
        token = page.NextContinuationToken;
        seenTokens.add(token);
      } while (token);
      return objects;
    },
    async delete(key) { await client.send(new DeleteObjectCommand({ Bucket: target.bucket, Key: key })); },
    close() { client.destroy(); }
  };
}
