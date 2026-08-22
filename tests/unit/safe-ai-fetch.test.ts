import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { AppError } from "../../src/errors.js";
import { aiEndpointUsesPrivateNetwork, assertSafeAiEndpoint, assertSafeS3Endpoint, fetchSafeAiEndpoint } from "../../src/security.js";

const safePublicAddress = { address: "93.184.216.34", family: 4 as const };
const validateTestEndpoint = async (candidate: string) => {
  if (new URL(candidate).hostname === "127.0.0.1") return assertSafeAiEndpoint(candidate, false);
  return [safePublicAddress];
};

describe("assertSafeAiEndpoint", () => {
  it("拒绝指向环回地址的供应商 URL", async () => {
    await expect(assertSafeAiEndpoint("http://127.0.0.1:8080/v1")).rejects.toMatchObject({
      code: "UNSAFE_PROVIDER_ENDPOINT"
    });
  });

  it("显式开放时允许本机地址并拒绝链路本地与保留网段", async () => {
    await expect(assertSafeAiEndpoint("http://127.0.0.1:8080/v1", true)).resolves.toEqual([
      { address: "127.0.0.1", family: 4 }
    ]);
    await expect(assertSafeAiEndpoint("https://198.18.0.1/v1", true)).rejects.toMatchObject({
      code: "UNSAFE_PROVIDER_ENDPOINT"
    });
    await expect(assertSafeAiEndpoint("http://169.254.169.254/latest/meta-data", true)).rejects.toMatchObject({
      code: "UNSAFE_PROVIDER_ENDPOINT"
    });
  });

  it("识别本机与内网供应商地址", async () => {
    await expect(aiEndpointUsesPrivateNetwork("http://127.0.0.1:11434/v1")).resolves.toBe(true);
    await expect(aiEndpointUsesPrivateNetwork("https://192.168.1.10/v1")).resolves.toBe(true);
    await expect(aiEndpointUsesPrivateNetwork("https://93.184.216.34/v1")).resolves.toBe(false);
    await expect(aiEndpointUsesPrivateNetwork("https://198.18.0.1/v1")).resolves.toBe(false);
  });

  it("拒绝 IPv4 映射、NAT64 与保留网段伪装的内网地址", async () => {
    await expect(assertSafeAiEndpoint("http://[::ffff:127.0.0.1]:8080/v1")).rejects.toMatchObject({
      code: "UNSAFE_PROVIDER_ENDPOINT"
    });
    await expect(assertSafeAiEndpoint("https://[64:ff9b::7f00:1]/v1")).rejects.toMatchObject({
      code: "UNSAFE_PROVIDER_ENDPOINT"
    });
    await expect(assertSafeAiEndpoint("https://198.18.0.1/v1")).rejects.toMatchObject({
      code: "UNSAFE_PROVIDER_ENDPOINT"
    });
  });

  it("允许公网 HTTPS 地址", async () => {
    await expect(assertSafeAiEndpoint("https://93.184.216.34/v1")).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ family: expect.any(Number) })
    ]));
  });

  it("允许公网 IPv6 与映射公网地址的 NAT64 端点", async () => {
    await expect(assertSafeAiEndpoint("https://[2606:4700:4700::1111]/v1")).resolves.toEqual([
      { address: "2606:4700:4700::1111", family: 6 }
    ]);
    await expect(assertSafeAiEndpoint("https://[64:ff9b::5db8:d822]/v1")).resolves.toEqual([
      { address: "64:ff9b::5db8:d822", family: 6 }
    ]);
  });

  it("拒绝公网 HTTP 地址传输供应商凭据", async () => {
    await expect(assertSafeAiEndpoint("http://93.184.216.34/v1", false)).rejects.toMatchObject({
      code: "INSECURE_PROVIDER_ENDPOINT"
    });
  });
});

describe("assertSafeS3Endpoint", () => {
  it("拒绝生产环境访问环回 S3 地址", async () => {
    await expect(assertSafeS3Endpoint("http://127.0.0.1:9000", false)).rejects.toMatchObject({
      code: "UNSAFE_S3_ENDPOINT"
    });
  });

  it("允许显式开放的私有 S3 地址并拒绝公网 HTTP", async () => {
    await expect(assertSafeS3Endpoint("http://127.0.0.1:9000", true)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ address: "127.0.0.1" })
    ]));
    await expect(assertSafeS3Endpoint("http://93.184.216.34", false)).rejects.toMatchObject({
      code: "INSECURE_S3_ENDPOINT"
    });
  });
});

describe("fetchSafeAiEndpoint", () => {
  it("不自动跟随重定向到内网地址", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes("evil.example")) {
        return new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1:9000/secret" }
        });
      }
      return new Response("should-not-reach", { status: 200 });
    }) as unknown as typeof fetch;

    await expect(
      fetchSafeAiEndpoint(
        fetchImpl,
        "https://evil.example/v1/models",
        { headers: { Authorization: "Bearer secret-key" } },
        validateTestEndpoint
      )
    ).rejects.toBeInstanceOf(AppError);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("同主机重定向时保留 Authorization 并继续请求", async () => {
    const seenAuth: Array<string | null> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seenAuth.push(headers.get("authorization"));
      if (String(url).endsWith("/start")) {
        return new Response(null, {
          status: 307,
          headers: { location: "/v1/models" }
        });
      }
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as unknown as typeof fetch;

    const response = await fetchSafeAiEndpoint(
      fetchImpl,
      "https://example.com/start",
      { headers: { Authorization: "Bearer secret-key" } },
      validateTestEndpoint
    );

    expect(response.status).toBe(200);
    expect(seenAuth).toEqual(["Bearer secret-key", "Bearer secret-key"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("拒绝携带多种凭据的跨主机重定向", async () => {
    const seenHeaders: Array<{ authorization: string | null; apiKey: string | null }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seenHeaders.push({ authorization: headers.get("authorization"), apiKey: headers.get("x-api-key") });
      if (String(url).includes("provider.example")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example/v1/models" }
        });
      }
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    await expect(fetchSafeAiEndpoint(
      fetchImpl,
      "https://provider.example/v1/models",
      { headers: { Authorization: "Bearer secret-key", "x-api-key": "secret-key" } },
      validateTestEndpoint
    )).rejects.toMatchObject({ code: "PROVIDER_REDIRECT_CROSS_ORIGIN" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(seenHeaders).toEqual([{ authorization: "Bearer secret-key", apiKey: "secret-key" }]);
  });

  it("使用通过校验的地址建立实际连接", async () => {
    const server = createServer((_request, response) => response.end("pinned"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器未监听端口");

    try {
      const response = await fetchSafeAiEndpoint(
        fetch,
        `http://localhost:${address.port}/models`,
        {},
        async () => [{ address: "127.0.0.1", family: 4 }]
      );
      expect(await response.text()).toBe("pinned");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
