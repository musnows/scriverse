/** 打开的模态对话框会让文档其余部分 inert；Toast 必须挂到最顶层对话框内才能接收点击。 */
export function resolveToastRegionHost(dialogs, fallbackHost) {
  const openDialogs = (Array.isArray(dialogs) ? dialogs : []).filter((dialog) => Boolean(dialog?.open));
  return openDialogs.at(-1) ?? fallbackHost ?? null;
}
