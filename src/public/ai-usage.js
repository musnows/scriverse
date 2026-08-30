function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfLocalDay(value) {
  const date = value instanceof Date ? new Date(value) : new Date(String(value));
  date.setHours(0, 0, 0, 0);
  return date;
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

export function buildUsageCalendar(daily, today = new Date(), weekCount = 53) {
  const normalizedToday = startOfLocalDay(today);
  const start = new Date(normalizedToday);
  start.setDate(start.getDate() - start.getDay() - (Math.max(1, weekCount) - 1) * 7);
  const usageByDate = new Map((Array.isArray(daily) ? daily : []).map((item) => [
    String(item.date),
    Math.max(0, Number(item.totalTokens) || 0)
  ]));
  const visibleValues = [];
  const cells = [];
  for (let index = 0; index < Math.max(1, weekCount) * 7; index += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const dateKey = localDateKey(date);
    const totalTokens = usageByDate.get(dateKey) ?? 0;
    const future = date > normalizedToday;
    if (!future && totalTokens > 0) visibleValues.push(totalTokens);
    cells.push({
      date: dateKey,
      totalTokens,
      future,
      week: Math.floor(index / 7),
      weekday: index % 7,
      level: 0
    });
  }
  const maximum = Math.max(0, ...visibleValues);
  for (const cell of cells) {
    cell.level = cell.future || cell.totalTokens <= 0 || maximum <= 0
      ? 0
      : Math.max(1, Math.min(4, Math.ceil(Math.sqrt(cell.totalTokens / maximum) * 4)));
  }
  const months = [];
  for (let week = 0; week < Math.max(1, weekCount); week += 1) {
    const firstDay = cells[week * 7];
    const date = startOfLocalDay(`${firstDay.date}T00:00:00`);
    const previous = week > 0 ? startOfLocalDay(`${cells[(week - 1) * 7].date}T00:00:00`) : null;
    if (week === 0 || previous?.getMonth() !== date.getMonth()) {
      months.push({
        week,
        label: new Intl.DateTimeFormat("zh-CN", { month: "short" }).format(date)
      });
    }
  }
  return { cells, months, weekCount: Math.max(1, weekCount) };
}
