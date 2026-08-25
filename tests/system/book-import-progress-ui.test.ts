import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("书籍导入进度提示", () => {
  it("为两条书籍导入路径显示不可关闭的常驻上传与处理进度", async () => {
    const root = process.cwd();
    const [page, application, styles] = await Promise.all([
      readFile(join(root, "src/public/index.html"), "utf8"),
      readFile(join(root, "src/public/app.js"), "utf8"),
      readFile(join(root, "src/public/styles.css"), "utf8")
    ]);
    const progressToastStart = application.indexOf("function createImportProgressToast(fileName)");
    const progressToastEnd = application.indexOf("function restoreToastFocus", progressToastStart);
    const progressToastSource = application.slice(progressToastStart, progressToastEnd);

    expect(page).toContain('id="import-progress-region"');
    expect(page.match(/feature=book-import-progress-v1/gu)).toHaveLength(2);
    expect(application).toContain('request.upload.addEventListener("load", () => onProgress(100))');
    expect(application).toContain('uploadWithProgress(\n      `/api/works/${state.work.id}/import`');
    expect(application).toContain('uploadWithProgress(\n      "/api/works/import"');
    expect(application.match(/createImportProgressToast\(file\.name\)/gu)).toHaveLength(2);
    expect(application.match(/importProgress\.close\(\)/gu)).toHaveLength(4);
    expect(progressToastSource).toContain("上传完成，正在解析并写入作品…");
    expect(progressToastSource).not.toContain('addEventListener("click"');
    expect(styles).toContain(".import-progress-toast");
    expect(styles).toContain("cursor: progress");
  });
});
