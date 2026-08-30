export type AiUsageCalendarCell = {
  date: string;
  totalTokens: number;
  outsideYear: boolean;
  future: boolean;
  week: number;
  weekday: number;
  level: number;
};

export function formatTokenCount(value: unknown): string;
export function formatCacheHitRate(value: unknown): string;
export function formatEstimatedCost(value: unknown): string;
export function usageCalendarYears(daily: Array<{ date: string; totalTokens: number }> | unknown): number[];
export function buildUsageCalendar(
  daily: Array<{ date: string; totalTokens: number }> | unknown,
  year: number,
  todayDateKey?: string
): {
  cells: AiUsageCalendarCell[];
  months: Array<{ week: number; label: string }>;
  weekCount: number;
  year: number | null;
};
