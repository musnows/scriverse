import { describe, expect, it } from "vitest";
import { resolveToastRegionHost } from "../../src/public/toast-layer.js";

describe("Toast 图层宿主", () => {
  const body = { id: "body" };

  it("没有打开的对话框时使用回退宿主", () => {
    expect(resolveToastRegionHost([], body)).toBe(body);
    expect(resolveToastRegionHost([{ open: false }], body)).toBe(body);
    expect(resolveToastRegionHost(undefined, body)).toBe(body);
  });

  it("多个打开的对话框时挂到最顶层", () => {
    const first = { open: true, id: "first" };
    const second = { open: true, id: "second" };
    expect(resolveToastRegionHost([first], body)).toBe(first);
    expect(resolveToastRegionHost([first, { open: false }, second], body)).toBe(second);
  });

  it("缺少回退宿主且没有打开的对话框时返回空", () => {
    expect(resolveToastRegionHost([], null)).toBeNull();
  });
});
