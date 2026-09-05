import { describe, expect, it } from "vitest";
// @ts-expect-error 浏览器模块不生成 TypeScript 声明。
import { s3DisplayRoot, s3TargetPayload } from "../../src/public/s3-backup-ui.js";

describe("S3 backup UI values", () => {
  it("shows root and normalized nested object paths", () => {
    expect(s3DisplayRoot("")).toBe("/scriverse");
    expect(s3DisplayRoot("/家庭//小说/")).toBe("/家庭/小说/scriverse");
  });
  it("keeps editable values while excluding server-only fields", () => {
    expect(s3TargetPayload({ id: "target", includeImages: false, enabled: true, hasCredentials: true, nextRunAt: "2026-09-06" }))
      .toEqual({ id: "target", includeImages: false, enabled: true });
  });
});
