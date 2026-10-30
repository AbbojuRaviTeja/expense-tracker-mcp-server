import { describe, expect, it } from "vitest";
import { addInterval, parseDateInput, resolveDateRange } from "../../lib/dates";

const iso = (d?: Date) => d?.toISOString();

describe("resolveDateRange", () => {
  it("returns an empty range with no inputs", () => {
    expect(resolveDateRange()).toEqual({});
  });

  it("this_week on a Sunday is the week ending today, not next week", () => {
    const sunday = new Date("2026-11-01T10:00:00Z");
    const r = resolveDateRange("this_week", undefined, undefined, "UTC", sunday);
    expect(iso(r.gte)).toBe("2026-10-26T00:00:00.000Z");
    expect(iso(r.lte)).toBe("2026-11-01T23:59:59.999Z");
  });

  it("last_week on a Sunday is the previous Monday-Sunday", () => {
    const sunday = new Date("2026-11-01T10:00:00Z");
    const r = resolveDateRange("last_week", undefined, undefined, "UTC", sunday);
    expect(iso(r.gte)).toBe("2026-10-19T00:00:00.000Z");
    expect(iso(r.lte)).toBe("2026-10-25T23:59:59.999Z");
  });

  it("this_week on a Monday starts today", () => {
    const monday = new Date("2026-10-26T08:00:00Z");
    const r = resolveDateRange("this_week", undefined, undefined, "UTC", monday);
    expect(iso(r.gte)).toBe("2026-10-26T00:00:00.000Z");
  });

  it("uses the user's time zone for month boundaries (India, UTC+5:30)", () => {
    // 1 Nov 2026 01:00 in India is still 31 Oct in UTC.
    const now = new Date("2026-10-31T19:30:00Z");
    const r = resolveDateRange("this_month", undefined, undefined, "Asia/Kolkata", now);
    expect(iso(r.gte)).toBe("2026-10-31T18:30:00.000Z"); // 1 Nov 00:00 IST
    expect(iso(r.lte)).toBe("2026-11-30T18:29:59.999Z"); // 30 Nov 23:59:59.999 IST
  });

  it("handles last_month across a year boundary", () => {
    const r = resolveDateRange("last_month", undefined, undefined, "UTC", new Date("2026-01-15T00:00:00Z"));
    expect(iso(r.gte)).toBe("2025-12-01T00:00:00.000Z");
    expect(iso(r.lte)).toBe("2025-12-31T23:59:59.999Z");
  });

  it("handles DST in New York", () => {
    // DST ends 1 Nov 2026 in the US; the whole of November is EST (UTC-5).
    const r = resolveDateRange("this_month", undefined, undefined, "America/New_York", new Date("2026-11-15T12:00:00Z"));
    expect(iso(r.gte)).toBe("2026-11-01T04:00:00.000Z"); // still EDT at midnight
    expect(iso(r.lte)).toBe("2026-12-01T04:59:59.999Z");
  });

  it("explicit date-only bounds cover the whole end day", () => {
    const r = resolveDateRange(undefined, "2026-10-01", "2026-10-31", "Asia/Kolkata");
    expect(iso(r.gte)).toBe("2026-09-30T18:30:00.000Z");
    expect(iso(r.lte)).toBe("2026-10-31T18:29:59.999Z");
  });

  it("rejects start after end", () => {
    expect(() => resolveDateRange(undefined, "2026-10-10", "2026-10-01")).toThrow(/on or before/);
  });
});

describe("parseDateInput", () => {
  const now = new Date("2026-10-30T10:00:00Z");

  it("accepts a plain date (what an AI usually sends)", () => {
    expect(iso(parseDateInput("2026-10-30", "Asia/Kolkata", "midday"))).toBe("2026-10-30T06:30:00.000Z");
  });

  it("accepts offsets other than Z", () => {
    expect(iso(parseDateInput("2026-10-30T09:00:00+05:30", "UTC"))).toBe("2026-10-30T03:30:00.000Z");
  });

  it("treats a date-time without offset as the user's local time", () => {
    expect(iso(parseDateInput("2026-10-30T14:00", "Asia/Kolkata"))).toBe("2026-10-30T08:30:00.000Z");
  });

  it("understands today and yesterday", () => {
    expect(iso(parseDateInput("yesterday", "UTC", "start", now))).toBe("2026-10-29T00:00:00.000Z");
  });

  it("rejects impossible dates and garbage", () => {
    expect(() => parseDateInput("2026-02-30", "UTC")).toThrow(/real calendar date/);
    expect(() => parseDateInput("next tuesday-ish", "UTC")).toThrow(/Could not understand/);
  });
});

describe("addInterval", () => {
  it("clamps month ends and keeps the original day afterwards", () => {
    const start = new Date("2026-01-31T12:00:00Z");
    expect(iso(addInterval(start, "MONTHLY", 1, "UTC"))).toBe("2026-02-28T12:00:00.000Z");
    expect(iso(addInterval(start, "MONTHLY", 2, "UTC"))).toBe("2026-03-31T12:00:00.000Z");
  });

  it("adds weeks and years", () => {
    const start = new Date("2024-02-29T12:00:00Z");
    expect(iso(addInterval(start, "WEEKLY", 2, "UTC"))).toBe("2024-03-14T12:00:00.000Z");
    expect(iso(addInterval(start, "YEARLY", 1, "UTC"))).toBe("2025-02-28T12:00:00.000Z");
  });
});
