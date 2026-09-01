export function serializeImComposer(root: HTMLElement): string;

export function normalizeImComposerHeight(value: number, maximumHeight: number, minimumHeight?: number): number;

export function normalizeImConversationWidth(value: number, maximumWidth: number, minimumWidth?: number, defaultWidth?: number): number;

export function resolveImConversationWidth(preferredWidth: number, viewportWidth: number, maximumWidth: number): number;

export function shouldMarkImConversationRead(opened: boolean, visibilityState: string): boolean;

export function createImWorkspace(options: Record<string, unknown>): {
  start(): Promise<void>;
  open(): Promise<void>;
  close(): void;
  refreshUnread(): Promise<void>;
  readonly opened: boolean;
};
