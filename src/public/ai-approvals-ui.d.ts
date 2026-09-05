export const APPROVAL_STATUS_LABELS: Readonly<Record<string, string>>;
export const WRITE_TOOL_LABELS: Readonly<Record<string, string>>;
export function approvalQuestionMarkup(question: { question: string; options: string[] }, esc: (value: unknown) => string): string;
export function approvalSettingsMarkup(settings: { enabled: string[]; maxOperations: number }, editable: boolean, esc: (value: unknown) => string): string;
export function createAiApprovalUi(options: Record<string, unknown>): { render(): Promise<void>; open(id: string): Promise<void>; notify(id: string): Promise<void>; reset(): void; start(): void; bindSettings(host: Element, editable: boolean): Promise<void> };
