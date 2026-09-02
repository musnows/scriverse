import { describe, expect, it } from "vitest";
import { parsePageRoute, serializePageRoute } from "../../src/public/page-route.js";

describe("页面刷新路由", () => {
  it("往返保存作品模块与当前章节", () => {
    const moduleHash = serializePageRoute({ view: "module", workId: "work / 1", module: "races" });
    expect(parsePageRoute(moduleHash)).toEqual({ view: "module", workId: "work / 1", module: "races" });
    const draftsHash = serializePageRoute({ view: "module", workId: "work-1", module: "drafts" });
    expect(parsePageRoute(draftsHash)).toEqual({ view: "module", workId: "work-1", module: "drafts" });
    const commentsHash = serializePageRoute({ view: "module", workId: "work-1", module: "comments" });
    expect(parsePageRoute(commentsHash)).toEqual({ view: "module", workId: "work-1", module: "comments" });

    const editorHash = serializePageRoute({ view: "editor", workId: "work-1", chapterId: "chapter-18" });
    expect(parsePageRoute(editorHash)).toEqual({ view: "editor", workId: "work-1", chapterId: "chapter-18" });

    const readerHash = serializePageRoute({ view: "reader", workId: "work-1", chapterId: "chapter-18" });
    expect(parsePageRoute(readerHash)).toEqual({ view: "reader", workId: "work-1", chapterId: "chapter-18" });
  });

  it("保存设置页面及其返回位置", () => {
    const hash = serializePageRoute({
      view: "settings",
      workId: "work-1",
      returnView: "module",
      returnModule: "relationships"
    });
    expect(parsePageRoute(hash)).toEqual({
      view: "settings",
      workId: "work-1",
      returnView: "module",
      returnModule: "relationships"
    });
    const usageHash = serializePageRoute({
      view: "platform-usage",
      workId: "work-1",
      returnView: "shelf"
    });
    expect(parsePageRoute(usageHash)).toEqual({
      view: "platform-usage",
      workId: "work-1",
      returnView: "shelf"
    });
    const auditHash = serializePageRoute({
      view: "work-audit",
      workId: "work-1",
      returnView: "module",
      returnModule: "timeline"
    });
    expect(parsePageRoute(auditHash)).toEqual({
      view: "work-audit",
      workId: "work-1",
      returnView: "module",
      returnModule: "timeline"
    });
  });

  it("往返保存登录页路由", () => {
    expect(serializePageRoute({ view: "login" })).toBe("#view=login");
    expect(parsePageRoute("#view=login")).toEqual({ view: "login" });
  });

  it("往返保存全局 IM 工作区路由", () => {
    expect(serializePageRoute({ view: "im" })).toBe("#view=im");
    expect(parsePageRoute("#view=im")).toEqual({ view: "im" });
    const settingsHash = serializePageRoute({ view: "settings", workId: "work-1", returnView: "im" });
    expect(parsePageRoute(settingsHash)).toEqual({ view: "settings", workId: "work-1", returnView: "im" });
  });

  it("往返保存设定、角色、种族和组织全屏编辑页", () => {
    const settingHash = serializePageRoute({ view: "entity-editor", workId: "work-1", entity: "setting", entityId: "setting-2", entityMode: "read" });
    expect(parsePageRoute(settingHash)).toEqual({ view: "entity-editor", workId: "work-1", entity: "setting", entityId: "setting-2", entityMode: "read" });

    const characterHash = serializePageRoute({ view: "entity-editor", workId: "work-1", entity: "character" });
    expect(parsePageRoute(characterHash)).toEqual({ view: "entity-editor", workId: "work-1", entity: "character", entityId: null, entityMode: "edit" });

    for (const entity of ["race", "organization"]) {
      const hash = serializePageRoute({ view: "entity-editor", workId: "work-1", entity });
      expect(parsePageRoute(hash)).toEqual({ view: "entity-editor", workId: "work-1", entity, entityId: null, entityMode: "edit" });
    }
  });

  it("拒绝未知模块和不完整作品地址", () => {
    expect(parsePageRoute("#view=module&work=work-1&module=unknown")).toEqual({ view: "shelf" });
    expect(parsePageRoute("#view=editor&chapter=chapter-1")).toEqual({ view: "shelf" });
    expect(serializePageRoute({ view: "module", workId: "work-1", module: "unknown" })).toBe("#view=shelf");
    expect(parsePageRoute("#view=entity-editor&work=work-1&entity=unknown")).toEqual({ view: "shelf" });
    expect(parsePageRoute("#view=work-audit")).toEqual({ view: "shelf" });
    expect(serializePageRoute({ view: "work-audit" })).toBe("#view=shelf");
  });
});
