const usageDateKeyPattern = /^(\d{4})-(\d{2})-(\d{2})$/u;

function usageDateFromKey(value) {
  const match = usageDateKeyPattern.exec(String(value));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return year >= 1_000 && date.toISOString().slice(0, 10) === String(value) ? date : null;
}

function usageDateKey(date) {
  return date.toISOString().slice(0, 10);
}

export function formatTokenCount(value) {
  const count = Math.max(0, Math.round(Number(value) || 0));
  if (count < 10_000) return count.toLocaleString("zh-CN");
  if (count >= 100_000_000) return `${(count / 100_000_000).toFixed(2)}亿`;
  return new Intl.NumberFormat("zh-CN", {
    notation: "compact",
    compactDisplay: "short",
    maximumFractionDigits: 1
  }).format(count);
}

export function formatCacheHitRate(value) {
  if (value === null || value === undefined || value === "") return "暂无数据";
  const rate = Number(value);
  return Number.isFinite(rate) ? `${rate.toFixed(1).replace(/\.0$/u, "")}%` : "暂无数据";
}

export function formatEstimatedCost(value) {
  if (value === null || value === undefined || value === "") return "暂无价格";
  const cost = Number(value);
  if (!Number.isFinite(cost) || cost < 0) return "暂无价格";
  const maximumFractionDigits = cost < 0.01 ? 6 : cost < 1 ? 4 : 2;
  return `$${cost.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits
  })}`;
}

export function usageCalendarYears(daily) {
  return [...new Set((Array.isArray(daily) ? daily : [])
    .filter((item) => usageDateFromKey(item?.date) && Math.max(0, Number(item?.totalTokens) || 0) > 0)
    .map((item) => Number(String(item.date).slice(0, 4))))]
    .sort((left, right) => right - left);
}

export function buildUsageCalendar(daily, year, todayDateKey) {
  const selectedYear = Number.isInteger(Number(year)) ? Number(year) : usageCalendarYears(daily)[0];
  if (!selectedYear || selectedYear < 1_000 || selectedYear > 9_999) {
    return { cells: [], months: [], weekCount: 0, year: null };
  }
  const firstDay = new Date(Date.UTC(selectedYear, 0, 1));
  const lastDay = new Date(Date.UTC(selectedYear, 11, 31));
  const start = new Date(firstDay);
  start.setUTCDate(start.getUTCDate() - start.getUTCDay());
  const end = new Date(lastDay);
  end.setUTCDate(end.getUTCDate() + (6 - end.getUTCDay()));
  const weekCount = Math.floor((end.getTime() - start.getTime()) / (7 * 24 * 60 * 60_000)) + 1;
  const normalizedTodayKey = usageDateFromKey(todayDateKey) ? String(todayDateKey) : null;
  const usageByDate = new Map((Array.isArray(daily) ? daily : [])
    .filter((item) => usageDateFromKey(item?.date)?.getUTCFullYear() === selectedYear)
    .map((item) => [String(item.date), Math.max(0, Number(item.totalTokens) || 0)]));
  const visibleValues = [];
  const cells = [];
  for (let index = 0; index < weekCount * 7; index += 1) {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + index);
    const dateKey = usageDateKey(date);
    const outsideYear = date.getUTCFullYear() !== selectedYear;
    const totalTokens = outsideYear ? 0 : usageByDate.get(dateKey) ?? 0;
    const future = !outsideYear && normalizedTodayKey !== null && dateKey > normalizedTodayKey;
    if (!outsideYear && !future && totalTokens > 0) visibleValues.push(totalTokens);
    cells.push({
      date: dateKey,
      totalTokens,
      outsideYear,
      future,
      week: Math.floor(index / 7),
      weekday: index % 7,
      level: 0
    });
  }
  const maximum = Math.max(0, ...visibleValues);
  for (const cell of cells) {
    cell.level = cell.outsideYear || cell.future || cell.totalTokens <= 0 || maximum <= 0
      ? 0
      : Math.max(1, Math.min(4, Math.ceil(Math.sqrt(cell.totalTokens / maximum) * 4)));
  }
  const months = Array.from({ length: 12 }, (_, month) => ({
    week: Math.floor((Date.UTC(selectedYear, month, 1) - start.getTime()) / (7 * 24 * 60 * 60_000)),
    label: `${month + 1}月`
  }));
  return { cells, months, weekCount, year: selectedYear };
}
