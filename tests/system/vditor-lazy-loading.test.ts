import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Vditor 延迟加载", () => {
  it("不把 Markdown 编辑器资源放入工作台首屏关键路径", async () => {
    const [page, application] = await Promise.all([
      readFile(join(process.cwd(), "src/public/index.html"), "utf8"),
      readFile(join(process.cwd(), "src/public/app.js"), "utf8")
    ]);

    expect(page).not.toContain('/vendor/vditor/dist/index.css?v=3.11.2');
    expect(page).not.toContain('/vendor/vditor/dist/js/icons/ant.js?v=3.11.2');
    expect(page).not.toContain('/vendor/vditor/dist/index.min.js?v=3.11.2');
    expect(application).toContain('async function loadVditorResources()');
    expect(application).toContain('loadVditorScript("vditorMainScript", "/vendor/vditor/dist/index.min.js?v=3.11.2")');
    expect(application).toContain('if ($("#dialog-fields").querySelector("[data-vditor-editor]") && !(await loadVditorResources())) return;');
    expect(application).toContain('async function openSettingEditor(item = null, { readOnly = false } = {})');
    expect(application).toContain('if (!(await loadVditorResources())) return;');
  });
});
