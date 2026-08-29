import { describe, expect, it } from "vitest";
import { extractStaticModuleImports, injectModulePreloads } from "../../src/ui-module-preload.js";

describe("工作台模块预加载", () => {
  it("提取单行和多行静态模块并去重", () => {
    const source = `import { first } from "/first.js?v=1";
import {
  second
} from "/second.js?v=2";
import { repeated } from "/first.js?v=1";
import external from "https://example.test/external.js";`;

    expect(extractStaticModuleImports(source)).toEqual([
      "/first.js?v=1",
      "/second.js?v=2"
    ]);
  });

  it("把入口与依赖作为同源 modulepreload 注入 head", () => {
    const page = `<html><head><title>叙界</title></head><body><script type="module" src="/app.js?v=1&feature=test"></script></body></html>`;
    const result = injectModulePreloads(page, ["/first.js?v=1&feature=test", "//invalid.test/module.js"]);

    expect(result).toContain('<link rel="modulepreload" href="/app.js?v=1&amp;feature=test" fetchpriority="low">');
    expect(result).toContain('<link rel="modulepreload" href="/first.js?v=1&amp;feature=test" fetchpriority="low">');
    expect(result).not.toContain("invalid.test");
    expect(result.indexOf('rel="modulepreload"')).toBeLessThan(result.indexOf("</head>"));
  });
});
