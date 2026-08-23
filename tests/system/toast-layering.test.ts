import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("系统 Toast 图层", () => {
  it("通过 top layer 保持在模态弹窗和模糊遮罩上方", async () => {
    const publicPath = join(process.cwd(), "src", "public");
    const [page, application, styles] = await Promise.all([
      readFile(join(publicPath, "index.html"), "utf8"),
      readFile(join(publicPath, "app.js"), "utf8"),
      readFile(join(publicPath, "styles.css"), "utf8")
    ]);

    expect(page).toContain('id="toast-region"');
    expect(page).toContain('popover="manual"');
    expect(page).toContain("feature=toast-modal-host-v1");
    expect(application).toContain("function raiseToastRegion()");
    expect(application).toContain("function syncToastRegionHost()");
    expect(application).toContain("resolveToastRegionHost([...document.querySelectorAll(\"dialog[open]\")], document.body)");
    expect(application).toContain("/toast-layer.js?v=20260822-toast-modal-host-v1");
    expect(application).toContain("function dismissToastElement(element)");
    expect(application).toContain('element.addEventListener("click", () => dismissToastElement(element), { once: true })');
    expect(application).toContain("setTimeout(() => dismissToastElement(element), 3600)");
    expect(application).toContain('function persistentToast(message, type = "info")');
    expect(application).toContain('element.setAttribute("role", type === "error" ? "alert" : "status")');
    expect(application).toContain('element.setAttribute("aria-atomic", "true")');
    expect(application).toContain('element.setAttribute("role", "status")');
    expect(application).toContain('region.matches(":popover-open")');
    expect(application).toContain("region.showPopover()");
    expect(application).toContain('document.addEventListener("toggle"');
    expect(application).toContain("target instanceof HTMLDialogElement");
    expect(application).toContain("syncToastRegionHost()");
    expect(styles).toContain("z-index: 2147483647");
    expect(styles).toContain("pointer-events: none");
  });

  it("使用自定义 confirmToast，并覆盖浏览器 Popover 默认样式", async () => {
    const publicPath = join(process.cwd(), "src", "public");
    const [application, styles] = await Promise.all([
      readFile(join(publicPath, "app.js"), "utf8"),
      readFile(join(publicPath, "styles.css"), "utf8")
    ]);

    expect(application).not.toContain("window.confirm(");
    expect(application).toContain("function restoreToastFocus(previousFocus)");
    expect(application).toContain("const previousFocus = document.activeElement;");
    expect(application).toContain("previousFocus.isConnected");
    expect(application).toContain('previousFocus.matches(":disabled")');
    expect(application).toContain("document.activeElement === previousFocus");
    expect(application).toContain('body.setAttribute("tabindex", "-1")');
    expect(application).toContain("restoreToastFocus(previousFocus);");
    expect(application).toContain("function confirmToast(message");
    expect(application).toContain("region.append(element)");
    expect(application).toContain("raiseToastRegion()");
    expect(application).toContain("cancel.focus()");
    expect(application).toContain("function inputToast(message");
    expect(application).toContain("async function confirmDiscardChanges(");
    expect(application).toContain('title: "放弃未保存修改"');
    expect(application).toContain('role", "alertdialog"');
    expect(styles).toContain(".toast-region:popover-open");
    expect(styles).toContain(".toast-region::backdrop { display: none; }");
    expect(styles).toContain("background: var(--toast-bg)");
    expect(styles).toContain("pointer-events: auto");
    expect(styles).toContain(".toast:not(.toast-confirmation):not(.chapter-insight-toast)");
    const toastRegionStyles = styles.match(/\.toast-region,\s*\.toast-region:popover-open\s*\{([\s\S]*?)\n\}/u)?.[1] ?? "";
    expect(toastRegionStyles).toContain("pointer-events: auto");
    expect(styles).not.toContain(".toast-close");
    expect(styles).toContain(".toast-confirmation");
    expect(styles).toContain(".toast-input");
    expect(styles).toContain("white-space: pre-line");
  });

  it("明暗主题下均使用统一的深色 Toast 配色", async () => {
    const styles = await readFile(join(process.cwd(), "src", "public", "styles.css"), "utf8");
    const darkTheme = styles.match(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/u)?.[1] ?? "";

    expect(styles).toContain("--toast-bg: #25231f;");
    expect(styles).toContain("--toast-fg: #fffefa;");
    expect(styles).toContain("--toast-error-bg: #6e2e21;");
    expect(styles).toContain("--toast-error-fg: #fffefa;");
    expect(darkTheme).toContain("--toast-bg: #25231f;");
    expect(darkTheme).toContain("--toast-fg: #fffefa;");
    expect(darkTheme).toContain("--toast-error-bg: #6e2e21;");
    expect(darkTheme).toContain("--toast-error-fg: #fffefa;");
  });
});
