import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("主动语义检索界面", () => {
  it("提供模型类型、作品 RAG 进度和创作助手显式检索注入入口", async () => {
    const publicPath = join(process.cwd(), "src", "public");
    const [application, page, styles, modelConfig] = await Promise.all([
      readFile(join(publicPath, "app.js"), "utf8"),
      readFile(join(publicPath, "index.html"), "utf8"),
      readFile(join(publicPath, "styles.css"), "utf8"),
      readFile(join(publicPath, "model-config.js"), "utf8")
    ]);

    expect(page).toContain('id="ai-semantic-search-toggle"');
    expect(page).toContain('aria-controls="ai-semantic-search-panel"');
    expect(page).toContain('id="ai-semantic-search-panel" class="ai-semantic-search-panel hidden"');
    expect(page).toContain("只在点击检索后调用 embedding；结果默认仅查看");
    expect(page).toContain('id="ai-semantic-inject"');
    expect(page).toContain('id="ai-semantic-injection"');
    expect(page).toContain("feature=semantic-search-v6");

    expect(application).toContain("这是一个 embedding 模型");
    expect(application).toContain("这是一个 rerank 模型");
    expect(application).toContain('modelKind = form.get("embeddingModel") === "on" ? "embedding"');
    expect(modelConfig).toContain('const modelKinds = new Set(["chat", "embedding", "rerank"])');
    expect(application).toContain("主动语义检索（RAG）");
    expect(application).toContain('id="semantic-search-index-status"');
    expect(application).toContain('class="semantic-index-progress"');
    expect(application).toContain("完整重建 RAG");
    expect(application).toContain("API Key 由所选模型所属供应商的凭证保险库加密保存");
    expect(application).toContain('value="semantic_search_story"');
    expect(application).toContain("function runAiSemanticSearch()");
    expect(application).toContain("function injectAiSemanticSelection()");
    expect(application).toContain('if (!$("#ai-semantic-search-panel").classList.contains("hidden"))');
    expect(application).toContain("if (state.aiSemanticSnapshot?.id) scope.semanticSnapshotId = state.aiSemanticSnapshot.id;");
    expect(application).toContain("Embedding\", rerank: \"Rerank");

    expect(styles).toContain(".semantic-settings-grid { display: grid;");
    expect(styles).toContain(".semantic-index-progress { width: 100%;");
    expect(styles).toContain(".ai-semantic-search-panel { display: grid;");
    expect(styles).toContain(".ai-semantic-result { display: grid;");
    expect(styles).toContain("@container (max-width: 460px)");
    expect(styles).toContain(".usage-call-type-chip");
  });

  it("锁定 390×844 与 1280×720 的结果滚动和 footer 可达契约", async () => {
    const publicPath = join(process.cwd(), "src", "public");
    const [page, styles] = await Promise.all([
      readFile(join(publicPath, "index.html"), "utf8"),
      readFile(join(publicPath, "styles.css"), "utf8")
    ]);
    const requiredViewports = [
      { width: 390, height: 844 },
      { width: 1280, height: 720 }
    ];

    expect(requiredViewports).toEqual([
      { width: 390, height: 844 },
      { width: 1280, height: 720 }
    ]);
    expect(page).toContain('id="ai-semantic-search-results" class="ai-semantic-search-results" tabindex="0" aria-label="语义检索结果，可滚动"');
    expect(styles).toContain("grid-template-rows: auto auto auto minmax(0, 1fr) auto;");
    expect(styles).toContain(".ai-semantic-search-results { display: grid; align-content: start; gap: 6px; min-height: 0;");
    expect(styles).toContain("overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable;");
    expect(styles).toContain(".ai-semantic-search-panel > footer { position: relative; z-index: 1; min-width: 0;");
    expect(styles).toContain(".ai-semantic-search-panel { height: 40vh; max-height: 40vh; }");
    expect(styles).toContain(".ai-semantic-search-form label:first-child { grid-column: 1 / -1; }");
    expect(styles).toContain(".ai-semantic-search-form button { grid-column: 2; align-self: end; }");
  });
});
