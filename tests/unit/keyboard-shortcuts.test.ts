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

  it("识别 macOS 与 Windows/Linux 的保存快捷键", () => {
    expect(isSaveShortcut({ key: "s", metaKey: true })).toBe(true);
    expect(isSaveShortcut({ key: "S", ctrlKey: true })).toBe(true);
    expect(isSaveShortcut({ key: "s", metaKey: true, ctrlKey: true })).toBe(true);
  });

  it("忽略包含其他修饰键或不匹配的保存按键", () => {
    expect(isSaveShortcut({ key: "s" })).toBe(false);
    expect(isSaveShortcut({ key: "s", ctrlKey: true, shiftKey: true })).toBe(false);
    expect(isSaveShortcut({ key: "s", metaKey: true, altKey: true })).toBe(false);
    expect(isSaveShortcut({ key: "f", metaKey: true })).toBe(false);
    expect(isSaveShortcut(null)).toBe(false);
  });
});
