import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("角色别名标签", () => {
  it("在角色卡片的别名胶囊前展示字段名", async () => {
    const publicPath = join(process.cwd(), "src/public");
    const [application, styles] = await Promise.all([
      readFile(join(publicPath, "app.js"), "utf8"),
      readFile(join(publicPath, "styles.css"), "utf8")
    ]);

    expect(application).toContain('class="character-aliases"><b>别名</b>');
    expect(styles).toContain(".character-aliases b { margin-right: 2px;");
  });

  it("在角色编辑器中使用可换行的别名气泡并保留键盘删除交互", async () => {
    const publicPath = join(process.cwd(), "src/public");
    const [application, styles, page] = await Promise.all([
      readFile(join(publicPath, "app.js"), "utf8"),
      readFile(join(publicPath, "styles.css"), "utf8"),
      readFile(join(publicPath, "index.html"), "utf8")
    ]);

    expect(application).toContain('field("aliases", "别名", "keyword-chips", item?.aliases ?? [])');
    expect(application).toContain('bindRelationshipKeywordControls($("#character-editor-fields"));');
    expect(application).toContain("commitRelationshipKeywordInputs(form);");
    expect(application).toContain('form.getAll("aliases")');
    expect(application).toContain("[data-keyword-chip-remove]");
    expect(application).toContain('data-name="${esc(name)}" data-remove-label="${esc(chipLabel)}"');
    expect(styles).toContain(".keyword-chip-field { min-width: 0; }");
    expect(styles).toContain(".keyword-chip-editor { display: flex; flex-wrap: wrap;");
    expect(styles).toContain("min-width: min(140px, 100%);");
    expect(styles).toContain("max-width: 100%; box-sizing: border-box; min-height: 28px;");
    expect(styles).toContain(".keyword-chip > span { min-width: 0; overflow-wrap: anywhere; }");
    expect(styles).toContain(".keyword-chip:hover button, .keyword-chip:focus-within button");
    expect(page).toMatch(/app\.js[^"]+feature=character-alias-chips-v2/u);
  });
});
