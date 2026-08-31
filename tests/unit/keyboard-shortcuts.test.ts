import { describe, expect, it } from "vitest";
import { isGlobalSearchShortcut, isSaveShortcut } from "../../src/public/keyboard-shortcuts.js";

describe("全局键盘快捷键", () => {
  it("识别 macOS 与 Windows/Linux 的全文检索快捷键", () => {
    expect(isGlobalSearchShortcut({ key: "f", metaKey: true })).toBe(true);
    expect(isGlobalSearchShortcut({ key: "F", ctrlKey: true })).toBe(true);
    expect(isGlobalSearchShortcut({ key: "f", metaKey: true, ctrlKey: true })).toBe(true);
  });

  it("忽略包含其他修饰键或不匹配的按键", () => {
    expect(isGlobalSearchShortcut({ key: "f" })).toBe(false);
    expect(isGlobalSearchShortcut({ key: "f", ctrlKey: true, shiftKey: true })).toBe(false);
    expect(isGlobalSearchShortcut({ key: "f", metaKey: true, altKey: true })).toBe(false);
    expect(isGlobalSearchShortcut({ key: "k", metaKey: true })).toBe(false);
  });

  it("macOS 只识别 Command+S", () => {
    expect(isSaveShortcut({ key: "s", metaKey: true }, "MacIntel")).toBe(true);
    expect(isSaveShortcut({ key: "S", metaKey: true }, "macOS")).toBe(true);
    expect(isSaveShortcut({ key: "s", ctrlKey: true }, "MacIntel")).toBe(false);
    expect(isSaveShortcut({ key: "s", metaKey: true, ctrlKey: true }, "MacIntel")).toBe(false);
  });

  it("Windows 与 Linux 只识别 Ctrl+S", () => {
    expect(isSaveShortcut({ key: "s", ctrlKey: true }, "Win32")).toBe(true);
    expect(isSaveShortcut({ key: "S", ctrlKey: true }, "Linux x86_64")).toBe(true);
    expect(isSaveShortcut({ key: "s", metaKey: true }, "Win32")).toBe(false);
    expect(isSaveShortcut({ key: "s", metaKey: true, ctrlKey: true }, "Linux x86_64")).toBe(false);
  });

  it("忽略包含其他修饰键或不匹配的保存按键", () => {
    expect(isSaveShortcut({ key: "s" }, "Win32")).toBe(false);
    expect(isSaveShortcut({ key: "s", ctrlKey: true, shiftKey: true }, "Win32")).toBe(false);
    expect(isSaveShortcut({ key: "s", metaKey: true, altKey: true }, "MacIntel")).toBe(false);
    expect(isSaveShortcut({ key: "f", metaKey: true }, "MacIntel")).toBe(false);
    expect(isSaveShortcut(null, "MacIntel")).toBe(false);
  });
});
