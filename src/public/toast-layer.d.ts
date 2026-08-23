export function resolveToastRegionHost<TDialog extends { open?: boolean }, TFallback>(
  dialogs: ReadonlyArray<TDialog | null | undefined> | null | undefined,
  fallbackHost?: TFallback | null
): TDialog | TFallback | null;
