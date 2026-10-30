import { z } from "zod";
import { PERIODS } from "../lib/dates";

const twoDecimals = (n: number) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;

export const amountSchema = z
  .number()
  .positive()
  .max(1_000_000_000)
  .refine(twoDecimals, "Amounts can have at most 2 decimal places")
  .describe("Amount in normal currency units, e.g. 249.50 for ₹249.50");

export const currencySchema = z
  .string()
  .regex(/^[A-Za-z]{3}$/, "Use a 3-letter ISO currency code")
  .describe("3-letter ISO currency code such as INR, USD, EUR. Defaults to your profile currency.");

export const categorySchema = z
  .string()
  .min(1)
  .max(50)
  .describe('Spending category, e.g. "food", "travel", "rent". Matching is case-insensitive.');

const DATE_FORMATS = 'Accepts "2026-10-30", an ISO 8601 date-time, "today" or "yesterday", in your time zone.';

export const dateInputSchema = z.string().min(1).describe(DATE_FORMATS);

/** A date field with its own meaning, keeping the accepted-format guidance the AI needs. */
export const dateInput = (meaning: string) => z.string().min(1).describe(`${meaning} ${DATE_FORMATS}`);

export const periodSchema = z
  .enum(PERIODS)
  .describe("Named period in your time zone. Weeks start on Monday. Ignored if startDate/endDate are given.");

export const emailOrMeSchema = z.string().min(1).describe('Email address of a person, or "me" for yourself');

export const dateFilterShape = {
  period: periodSchema.optional(),
  startDate: dateInput("Inclusive start day.").optional(),
  endDate: dateInput("Inclusive end day.").optional(),
};

export const paginationShape = {
  limit: z.number().int().min(1).max(200).default(50).describe("Max rows to return (1-200, default 50)"),
  offset: z.number().int().min(0).default(0).describe("Rows to skip, for paging. Use nextOffset from the previous call."),
};

export const idSchema = z.string().min(1);
