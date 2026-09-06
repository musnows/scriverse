import { describe, expect, it } from "vitest";
// @ts-expect-error 浏览器端模块没有单独的类型声明，测试仅调用纯函数导出。
import { aiQuestionDialogCanClose, normalizeAiQuestionItems, parseInteractiveToolPayload } from "../../src/public/ai-interactive.js";

describe("AI 提问工具前端载荷", () => {
  const questions = [
    {
      question: "元祖穆托的最终结局以哪个版本为准？",
      options: ["按回忆录改为\"休眠未死\"", "保留\"余震中死亡\"", "两者结合"]
    },
    {
      question: "这些修改如何落地？",
      options: ["创建待办批注", "只提供改写方案文本", "提交设定库更新计划"]
    },
    {
      question: "第一百八十七章行星哥斯拉的内心改写，你倾向哪种篇幅？",
      options: ["完整版", "精简版", "先不改这章"]
    }
  ];

  it("从字符串工具结果和批量参数中恢复完整问题内容", () => {
    const model = parseInteractiveToolPayload({
      name: "ask_user_question",
      status: "completed",
      arguments: JSON.stringify({ questions }),
      result: JSON.stringify({ ok: true, question: { id: "aiQ-render", status: "pending" } })
    });

    expect(model).toMatchObject({ kind: "question", ok: true });
    expect(model.question.questions).toEqual(questions);
    expect(normalizeAiQuestionItems(model.question)).toMatchObject([
      {
        question: questions[0]?.question,
        options: [
          { index: 0, label: questions[0]?.options[0], recommended: true },
          { index: 1, label: questions[0]?.options[1], recommended: false },
          { index: 2, label: questions[0]?.options[2], recommended: false }
        ]
      },
      { question: questions[1]?.question },
      { question: questions[2]?.question }
    ]);
  });

  it("保留 API 返回的选项编号与推荐状态", () => {
    expect(normalizeAiQuestionItems({
      questions: [{
        question: "选择方案",
        options: [{ index: 3, label: "方案甲", recommended: false }]
      }]
    })).toEqual([{
      index: 0,
      question: "选择方案",
      options: [{ index: 3, label: "方案甲", recommended: false }]
    }]);
  });

  it("只允许静默关闭已经处理的提问窗口", () => {
    expect(aiQuestionDialogCanClose(null)).toBe(false);
    expect(aiQuestionDialogCanClose({ status: "pending" })).toBe(false);
    expect(aiQuestionDialogCanClose({ status: "answered" })).toBe(true);
    expect(aiQuestionDialogCanClose({ status: "rejected" })).toBe(true);
    expect(aiQuestionDialogCanClose({ status: "expired" })).toBe(true);
  });
});
