import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const application = readFileSync("src/public/app.js", "utf8");
const source = application.slice(application.indexOf("function setSettingEditorCategory("), application.indexOf("async function openSettingEditor("));

function fixture() {
  type Option = { value: string; textContent: string; dataset: Record<string, string>; remove: () => void };
  let selected = "";
  const options: Option[] = [];
  const createOption = (value = ""): Option => {
    const option: Option = { value, textContent: value, dataset: {}, remove: () => { options.splice(options.indexOf(option), 1); } };
    return option;
  };
  options.push(createOption("世界规则"), createOption("科技与物品"));
  const select = {
    options,
    get value() { return selected; },
    set value(value: string) { selected = options.some(option => option.value === value) ? value : ""; },
    querySelectorAll: () => options.filter(option => option.dataset.customCategory),
    append: (option: Option) => { options.push(option); }
  };
  const setCategory = runInNewContext(`${source}\nsetSettingEditorCategory`, { $: () => select, document: { createElement: () => createOption() } }) as (category?: string) => void;
  return { select, setCategory };
}

describe("设定编辑器自定义分类", () => {
  it("已有自定义分类保持选中且特殊字符只作为文本处理", () => {
    const { select, setCategory } = fixture();
    const category = '自定义 <img src=x onerror="alert(1)">';
    setCategory(category);
    expect(select.value).toBe(category);
    expect(select.options.at(-1)?.textContent).toBe(category);
    expect(select.options.at(-1)?.dataset.customCategory).toBe("true");
  });

  it("切换实体后清理旧自定义选项并保留默认分类", () => {
    const { select, setCategory } = fixture();
    setCategory("星球");
    setCategory("纪元");
    expect(select.value).toBe("纪元");
    expect(select.options.map(option => option.value)).toEqual(["世界规则", "科技与物品", "纪元"]);
    setCategory();
    expect(select.value).toBe("世界规则");
    expect(select.options.map(option => option.value)).toEqual(["世界规则", "科技与物品"]);
  });
});
