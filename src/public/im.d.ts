export function serializeImComposer(root: HTMLElement): string;

export function normalizeImComposerHeight(value: number, maximumHeight: number, minimumHeight?: number): number;

export function normalizeImConversationWidth(value: number, maximumWidth: number, minimumWidth?: number, defaultWidth?: number): number;

export function resolveImConversationWidth(preferredWidth: number, viewportWidth: number, maximumWidth: number): number;

export function shouldMarkImConversationRead(opened: boolean, visibilityState: string): boolean;

export function shouldRefreshImConversationListForEvent(type: string): boolean;

export function findImMentionQuery(text: string, caretOffset?: number): {
  query: string;
  startOffset: number;
  endOffset: number;
} | null;

export function shouldFollowImFeed(scrollHeight: number, scrollTop: number, clientHeight: number, force?: boolean): boolean;

export function mergeImMessagePages(
  previousMessages: Array<Record<string, unknown>>,
  ...nextPages: Array<Array<Record<string, unknown>>>
): Array<Record<string, unknown>>;

export function imMessageSequenceBounds(messages: Array<Record<string, unknown>>): {
  minimum: number;
  maximum: number;
} | null;

export function hasImMessageSequenceGap(
  previousMessages: Array<Record<string, unknown>>,
  nextMessages: Array<Record<string, unknown>>
): boolean;

export function createImWorkspace(options: Record<string, unknown>): {
  start(): Promise<void>;
  open(): Promise<void>;
  close(): void;
  refreshUnread(): Promise<void>;
  readonly opened: boolean;
};
