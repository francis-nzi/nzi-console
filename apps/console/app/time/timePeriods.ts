import { utcDay } from "@nzi/contracts";

/**
 * The Time screen's periods, as London days (`YYYY-MM-DD`), computed from "today" as the server resolved it — so the
 * screen never judges a period by the viewer's clock. Pure string-and-UTC arithmetic: no time zone enters.
 */
export type PeriodKey = "week" | "month" | "last-month" | "quarter" | "custom";
export type Period = { from: string; to: string };

const parse = (day: string) => new Date(`${day}T00:00:00Z`);
// Every Date here is built against a UTC anchor, so its UTC day is the day meant.
const format = (date: Date) => utcDay(date);
export const addDays = (day: string, days: number) => { const date = parse(day); date.setUTCDate(date.getUTCDate() + days); return format(date); };

/** Monday to Sunday containing the day. */
export function weekOf(day: string): Period {
  const offset = (parse(day).getUTCDay() + 6) % 7;
  const from = addDays(day, -offset);
  return { from, to: addDays(from, 6) };
}

/** The calendar month containing the day. */
export function monthOf(day: string): Period {
  const date = parse(day);
  const from = format(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)));
  const to = format(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)));
  return { from, to };
}

/** The calendar month before the one containing the day. */
export const lastMonthOf = (day: string): Period => monthOf(addDays(monthOf(day).from, -1));

/** The calendar quarter (Jan–Mar, Apr–Jun, Jul–Sep, Oct–Dec) containing the day. */
export function quarterOf(day: string): Period {
  const date = parse(day);
  const first = Math.floor(date.getUTCMonth() / 3) * 3;
  return { from: format(new Date(Date.UTC(date.getUTCFullYear(), first, 1))), to: format(new Date(Date.UTC(date.getUTCFullYear(), first + 3, 0))) };
}

export function periodFor(key: PeriodKey, today: string, custom: Period): Period {
  if (key === "week") return weekOf(today);
  if (key === "month") return monthOf(today);
  if (key === "last-month") return lastMonthOf(today);
  if (key === "quarter") return quarterOf(today);
  return custom;
}

const DAY_LABEL = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const DAY_YEAR_LABEL = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
/** "3 Aug" — a day in a list. */
export const shortDay = (day: string) => DAY_LABEL.format(parse(day));
/** "1 Aug – 31 Aug 2026". */
export const periodLabel = (period: Period) => `${DAY_LABEL.format(parse(period.from))} – ${DAY_YEAR_LABEL.format(parse(period.to))}`;

/** Hours for display, to the quarter as entered: 90 minutes → "1.5", 45 → "0.75", 0 → "0". */
export const hoursLabel = (minutes: number) => String(Math.round((minutes / 60) * 100) / 100);
