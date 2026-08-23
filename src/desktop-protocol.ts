import { APP_VERSION } from "./version.js";

export const DESKTOP_PRODUCT_ID = "scriverse";
export const DESKTOP_MINIMUM_VERSION = "0.0.1";
export const DESKTOP_SHELL_PROTOCOL = Object.freeze({ min: 1, max: 1 });
export const DESKTOP_SYNC_PROTOCOL = Object.freeze({
  min: 1,
  max: 1,
  entityTypes: Object.freeze(["chapter", "setting"] as const),
  maxMutationBytes: 2_500_000
});

export function desktopCompatibilityMetadata(): {
  product: typeof DESKTOP_PRODUCT_ID;
  serverVersion: string;
  webAssetVersion: string;
  shellProtocol: typeof DESKTOP_SHELL_PROTOCOL;
  minimumDesktopVersion: typeof DESKTOP_MINIMUM_VERSION;
  syncProtocol: typeof DESKTOP_SYNC_PROTOCOL;
} {
  return {
    product: DESKTOP_PRODUCT_ID,
    serverVersion: APP_VERSION,
    webAssetVersion: APP_VERSION,
    shellProtocol: DESKTOP_SHELL_PROTOCOL,
    minimumDesktopVersion: DESKTOP_MINIMUM_VERSION,
    syncProtocol: DESKTOP_SYNC_PROTOCOL
  };
}
