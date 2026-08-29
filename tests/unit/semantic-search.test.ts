import { describe, expect, it } from "vitest";
import {
  cosineSimilarity,
  fuseSemanticSearchResults,
  parseEmbeddingResponse,
  parseRerankCompletion,
  rankSemanticVectors,
  semanticConfigurationFingerprint,
  splitSemanticDocument
} from "../../src/semantic-search.js";

describe("语义检索纯函数", () => {
  it("按原文段落边界分片并保留可定位行号与偏移", () => {
    const content = "第一段第一行。\n第一段第二行。\n\n第二段。\n\n第三段。";
    const chunks = splitSemanticDocument({
      sourceType: "chapter",
      sourceId: "chapter-1",
      sourceVersion: "3",
      sourceTitle: "第一章",
      content
    }, 200);
    expect(chunks).toEqual([expect.objectContaining({
      chunkOrder: 0,
      startLine: 1,
      endLine: 6,
      startOffset: 0,
      endOffset: content.length,
      content
    })]);

    const split = splitSemanticDocument({
      sourceType: "setting",
      sourceId: "setting-1",
      sourceVersion: "1",
      sourceTitle: "北港",
      content: `${"甲".repeat(220)}\n\n${"乙".repeat(220)}`
    }, 200);
    expect(split).toHaveLength(4);
    expect(split.map((chunk) => chunk.chunkOrder)).toEqual([0, 1, 2, 3]);
    expect(split.every((chunk) => chunk.content.length <= 200)).toBe(true);
  });

  it("配置指纹区分端点、模型、维度与分片规则", () => {
    const base = {
      providerId: "provider-1",
      baseUrl: "https://embedding.test/v1",
      modelRecordId: "model-1",
      modelId: "embedding-v1",
      vectorDimension: 1024
    };
    expect(semanticConfigurationFingerprint(base)).toHaveLength(64);
    expect(semanticConfigurationFingerprint(base)).toBe(semanticConfigurationFingerprint({ ...base }));
    expect(semanticConfigurationFingerprint(base)).not.toBe(semanticConfigurationFingerprint({ ...base, vectorDimension: 768 }));
    expect(semanticConfigurationFingerprint(base)).not.toBe(semanticConfigurationFingerprint({ ...base, baseUrl: "https://other.test/v1" }));
  });

  it("严格校验 embedding 数量、索引、维度、有限数值和零向量", () => {
    expect(parseEmbeddingResponse({
      data: [
        { index: 1, embedding: [0, 1] },
        { index: 0, embedding: [1, 0] }
      ],
      usage: { prompt_tokens: 2 }
    }, 2, 2)).toEqual({ vectors: [[1, 0], [0, 1]], usage: { prompt_tokens: 2 } });
    expect(() => parseEmbeddingResponse({ data: [{ embedding: [1] }] }, 1, 2)).toThrow("dimension");
    expect(() => parseEmbeddingResponse({ data: [{ embedding: [Number.NaN, 1] }] }, 1, 2)).toThrow("non-finite");
    expect(() => parseEmbeddingResponse({ data: [{ embedding: [0, 0] }] }, 1, 2)).toThrow("zero-length");
  });

  it("按 cosine 相关性排序并稳定处理无效向量", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(rankSemanticVectors([1, 0], [
      { id: "b", sourceType: "setting", sourceId: "b", sourceVersion: "1", sourceTitle: "B", startLine: 1, endLine: 1, content: "B", vector: [0, 1] },
      { id: "a", sourceType: "setting", sourceId: "a", sourceVersion: "1", sourceTitle: "A", startLine: 1, endLine: 1, content: "A", vector: [1, 0] }
    ], 2).map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("解析 LM Studio reranker 的 yes/no 结果", () => {
    expect(parseRerankCompletion({ choices: [{ text: "yes" }] })).toBe(1);
    expect(parseRerankCompletion({ choices: [{ message: { content: "No" } }] })).toBe(0);
    expect(() => parseRerankCompletion({ choices: [{ text: "unknown" }] })).toThrow("yes or no");
  });

  it("以 RRF 融合既有通道与 semantic 通道并保持来源标记", () => {
    const results = fuseSemanticSearchResults([
      { type: "setting", id: "setting-1", title: "北港", snippet: "关键词结果", matchKinds: ["exact"] }
    ], [
      { type: "setting", id: "setting-1", title: "北港", snippet: "语义结果", matchKinds: ["semantic"], semanticScore: 0.9 },
      { type: "chapter", id: "chapter-1", title: "第一章", snippet: "正文结果", matchKinds: ["semantic"], semanticScore: 0.8 }
    ], 1, 10);
    expect(results[0]).toMatchObject({
      type: "setting",
      id: "setting-1",
      snippet: "语义结果",
      matchKinds: ["exact", "semantic"]
    });
    expect(results[1]).toMatchObject({ type: "chapter", id: "chapter-1", matchKinds: ["semantic"] });
  });
});
