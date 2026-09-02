import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

describe("工作台模块图预加载", () => {
  let runtime: Runtime;

  beforeAll(() => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "ui-module-preload-system-test-secret",
      disableUserAuth: true,
      serveUi: true
    });
  });

  afterAll(() => runtime.close());

  it("在首屏 head 中并行发现入口和全部直接依赖", async () => {
    const page = await request(runtime.app).get("/").expect(200);
    const preloadHrefs = [...page.text.matchAll(/<link rel="modulepreload" href="([^"]+)" fetchpriority="low">/gu)]
      .map((match) => match[1]);

    expect(preloadHrefs).toHaveLength(64);
    expect(preloadHrefs[0]).toContain("/app.js?v=");
    expect(preloadHrefs).toContain("/reading-preview.js?v=20260813-reader-theme-v2");
    expect(preloadHrefs).toContain("/avatar-crop.js?v=20260725-avatar-crop");
    expect(preloadHrefs).toContain("/ai-interactive.js?v=20260829-question-tool-result-v5");
    expect(preloadHrefs).toContain("/ai-skill-menu.js?v=20260830-ai-skill-slash-menu-v1");
    expect(preloadHrefs).toContain("/chapter-line-id-tracker.js?v=20260829-live-annotation-anchors-v1");
    expect(preloadHrefs).toContain("/chapter-editor-behavior.js?v=20260828-centered-scroll-v1");
    expect(preloadHrefs).toContain("/im.js?v=20260902-global-im-v64");
    expect(page.text.indexOf('rel="modulepreload"')).toBeLessThan(page.text.indexOf("</head>"));
  });
});
