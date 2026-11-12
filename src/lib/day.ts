export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export function startOfDay(at: number, daysAhead = 0): number {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + daysAhead).getTime();
}

export function startOfMonth(at: number, monthsAhead = 0): number {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth() + monthsAhead, 1).getTime();
}
