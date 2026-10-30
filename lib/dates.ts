import { ValidationError } from "./errors";

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatterCache.set(tz, f);
  }
  return f;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface ZonedParts {
  year: number;
  /** 0-based month, like Date#getMonth */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday */
  weekday: number;
}

/** Wall-clock parts of an instant as seen in the given time zone. */
export function zonedParts(date: Date, tz: string): ZonedParts {
  const parts: Record<string, string> = {};
  for (const p of formatterFor(tz).formatToParts(date)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month) - 1,
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS.indexOf(parts.weekday),
  };
}

function offsetMs(tz: string, instant: number): number {
  const p = zonedParts(new Date(instant), tz);
  const asUtc = Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second);
  return asUtc - (instant - (((instant % 1000) + 1000) % 1000));
}

/**
 * Converts a wall-clock time in `tz` to a UTC instant. Out-of-range values roll
 * over like Date.UTC (day 0 = last day of the previous month, month 12 = next January).
 */
export function zonedTimeToUtc(
  tz: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  ms = 0,
): Date {
  const guess = Date.UTC(year, month, day, hour, minute, second, ms);
  const first = guess - offsetMs(tz, guess);
  const second_ = guess - offsetMs(tz, first);
  return new Date(second_);
}

export function startOfZonedDay(tz: string, year: number, month: number, day: number): Date {
  return zonedTimeToUtc(tz, year, month, day);
}

/** YYYY-MM-DD of an instant in the given zone. */
export function formatZonedDate(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  return `${p.year}-${String(p.month + 1).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export const PERIODS = [
  "today",
  "yesterday",
  "this_week",
  "last_week",
  "last_7_days",
  "this_month",
  "last_month",
  "last_30_days",
  "this_year",
  "last_year",
] as const;
export type Period = (typeof PERIODS)[number];

export interface DateRange {
  gte?: Date;
  lte?: Date;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;

function checkCalendarDate(y: number, m: number, d: number, raw: string) {
  const probe = new Date(Date.UTC(y, m, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m || probe.getUTCDate() !== d) {
    throw new ValidationError(`"${raw}" is not a real calendar date.`);
  }
}

/**
 * Parses user-friendly date input in the user's time zone.
 *  - "today", "yesterday", "now"
 *  - "2026-10-30" (a calendar day in the user's zone)
 *  - "2026-10-30T14:30" (wall-clock time in the user's zone)
 *  - "2026-10-30T09:00:00Z" / "...+05:30" (exact instant)
 *
 * `boundary` decides which instant a calendar day maps to: its start, its end,
 * or midday (used for an expense's own date so small zone changes never move it to another day).
 */
export function parseDateInput(
  raw: string,
  tz: string,
  boundary: "start" | "end" | "midday" = "midday",
  now: Date = new Date(),
): Date {
  const input = raw.trim();
  const lower = input.toLowerCase();

  const dayToInstant = (y: number, m: number, d: number) => {
    if (boundary === "start") return zonedTimeToUtc(tz, y, m, d);
    if (boundary === "end") return new Date(zonedTimeToUtc(tz, y, m, d + 1).getTime() - 1);
    return zonedTimeToUtc(tz, y, m, d, 12);
  };

  if (lower === "now") return now;
  if (lower === "today" || lower === "yesterday") {
    const p = zonedParts(now, tz);
    return dayToInstant(p.year, p.month, p.day - (lower === "yesterday" ? 1 : 0));
  }

  let m = DATE_ONLY.exec(input);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
    checkCalendarDate(y, mo, d, raw);
    return dayToInstant(y, mo, d);
  }

  m = LOCAL_DATETIME.exec(input);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
    checkCalendarDate(y, mo, d, raw);
    return zonedTimeToUtc(tz, y, mo, d, Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
  }

  if (HAS_OFFSET.test(input)) {
    const parsed = new Date(input);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  throw new ValidationError(
    `Could not understand the date "${raw}". Use YYYY-MM-DD, an ISO 8601 date-time, "today" or "yesterday".`,
  );
}

/**
 * Resolves a named period or an explicit start/end into an inclusive UTC range,
 * using calendar boundaries in the user's time zone. Weeks start on Monday.
 */
export function resolveDateRange(
  period?: Period,
  startDate?: string,
  endDate?: string,
  tz = "UTC",
  now: Date = new Date(),
): DateRange {
  if (startDate || endDate) {
    const range: DateRange = {
      gte: startDate ? parseDateInput(startDate, tz, "start", now) : undefined,
      lte: endDate ? parseDateInput(endDate, tz, "end", now) : undefined,
    };
    if (range.gte && range.lte && range.gte > range.lte) {
      throw new ValidationError("startDate must be on or before endDate.");
    }
    return range;
  }

  if (!period) return {};

  const { year, month, day, weekday } = zonedParts(now, tz);
  const span = (y1: number, m1: number, d1: number, y2: number, m2: number, d2: number): DateRange => ({
    gte: zonedTimeToUtc(tz, y1, m1, d1),
    lte: new Date(zonedTimeToUtc(tz, y2, m2, d2).getTime() - 1),
  });
  const daysSinceMonday = (weekday + 6) % 7;

  switch (period) {
    case "today":
      return span(year, month, day, year, month, day + 1);
    case "yesterday":
      return span(year, month, day - 1, year, month, day);
    case "this_week":
      return span(year, month, day - daysSinceMonday, year, month, day - daysSinceMonday + 7);
    case "last_week":
      return span(year, month, day - daysSinceMonday - 7, year, month, day - daysSinceMonday);
    case "last_7_days":
      return span(year, month, day - 6, year, month, day + 1);
    case "this_month":
      return span(year, month, 1, year, month + 1, 1);
    case "last_month":
      return span(year, month - 1, 1, year, month, 1);
    case "last_30_days":
      return span(year, month, day - 29, year, month, day + 1);
    case "this_year":
      return span(year, 0, 1, year + 1, 0, 1);
    case "last_year":
      return span(year - 1, 0, 1, year, 0, 1);
    default:
      return {};
  }
}

/** Adds `count` calendar units to a date, clamping month-ends (Jan 31 + 1 month = Feb 28/29). */
export function addInterval(
  start: Date,
  frequency: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY",
  count: number,
  tz: string,
): Date {
  const p = zonedParts(start, tz);
  if (frequency === "DAILY" || frequency === "WEEKLY") {
    const days = frequency === "DAILY" ? count : count * 7;
    return zonedTimeToUtc(tz, p.year, p.month, p.day + days, p.hour, p.minute, p.second);
  }
  const months = frequency === "MONTHLY" ? count : count * 12;
  const targetMonthIndex = p.month + months;
  const targetYear = p.year + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return zonedTimeToUtc(tz, targetYear, targetMonth, Math.min(p.day, lastDay), p.hour, p.minute, p.second);
}
