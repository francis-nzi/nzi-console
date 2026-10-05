import type { TimePeriod } from "@nzi/contracts";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const real = (day: string) => DAY.test(day) && new Date(`${day}T00:00:00Z`).toISOString().startsWith(day);
/** The longest period a Time read takes — a little over a year, so a custom range can span one. */
export const MAX_PERIOD_DAYS = 400;

/** `from` and `to` (London days, inclusive) from a Time read's query, or a message saying what is wrong. */
export function timePeriodFrom(url: URL): { period: TimePeriod } | { error: string } {
  const from = url.searchParams.get("from") ?? "", to = url.searchParams.get("to") ?? "";
  if (!real(from) || !real(to) || from > to) return { error: "Give the period as from and to days, from first." };
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  if (days > MAX_PERIOD_DAYS) return { error: `A period is at most ${MAX_PERIOD_DAYS} days.` };
  return { period: { from, to } };
}
