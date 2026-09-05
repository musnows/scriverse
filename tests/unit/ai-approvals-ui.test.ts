import { describe, expect, it } from "vitest";
import { approvalQuestionMarkup, approvalSettingsMarkup, WRITE_TOOL_LABELS } from "../../src/public/ai-approvals-ui.js";
const esc = (value: unknown): string => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

describe("approval UI input and permission boundaries", () => {
  it("escapes model questions and options and offers one recommended single choice", () => {
    const html = approvalQuestionMarkup({ question: '<img src=x onerror="alert(1)">', options: ["Recommended <script>", "Alternative"] }, esc);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html.match(/（最推荐）/gu)).toHaveLength(1);
    expect(html.match(/type="radio"/gu)).toHaveLength(3);
    expect(html.match(/ checked/gu)).toHaveLength(1);
    expect(html).not.toContain('type="checkbox"');
    expect(html).toContain('maxlength="2000" rows="3" disabled');
  });
  it("defaults every tool off and locks settings for users without AI settings write access", () => {
    const html = approvalSettingsMarkup({ enabled: [], maxOperations: 5 }, false, esc);
    expect(html.match(/type="checkbox"/gu)).toHaveLength(10);
    expect(html).not.toContain("checked");
    expect(html.match(/disabled/gu)).toHaveLength(11);
    for (const label of Object.values(WRITE_TOOL_LABELS)) expect(html).toContain(label);
  });
  it("reflects only the separately enabled tools", () => {
    const html = approvalSettingsMarkup({ enabled: ["settings", "AskUserQuestions"], maxOperations: 20 }, true, esc);
    expect(html.match(/checked/gu)).toHaveLength(2);
    expect(html).not.toContain("disabled");
    expect(html).toContain("20 项操作");
  });
});
