export function serializeImComposer(root: HTMLElement): string;

export function normalizeImComposerHeight(value: number, maximumHeight: number, minimumHeight?: number): number;

export function createImWorkspace(options: Record<string, unknown>): {
  start(): Promise<void>;
  open(): Promise<void>;
  close(): void;
  refreshUnread(): Promise<void>;
  readonly opened: boolean;
};
