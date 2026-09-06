export function countProseWords(text) {
  const value = String(text ?? "");
  const chinese = value.match(/[\p{Script=Han}]/gu)?.length ?? 0;
  const withoutChinese = value.replace(/[\p{Script=Han}]/gu, " ");
  const latin = withoutChinese.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  return chinese + latin;
}
