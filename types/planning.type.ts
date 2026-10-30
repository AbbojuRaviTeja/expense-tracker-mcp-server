import { z } from "zod";
import { amountSchema, categorySchema, currencySchema, dateInput, emailOrMeSchema, idSchema } from "./common.type";

export const setBudgetSchema = z.object({
  category: categorySchema.optional().describe("Category to limit. Omit for an overall budget across all categories."),
  amount: amountSchema.describe("Spending limit for the period"),
  currency: currencySchema.optional(),
  period: z.enum(["weekly", "monthly"]).default("monthly"),
});

export const deleteBudgetSchema = z.object({ id: idSchema });

export const addRecurringExpenseSchema = z.object({
  amount: amountSchema,
  currency: currencySchema.optional(),
  category: categorySchema,
  description: z.string().max(200).optional(),
  frequency: z.enum(["daily", "weekly", "monthly", "yearly"]),
  startDate: dateInput("First occurrence. Defaults to today. Past dates are back-filled.").optional(),
  endDate: dateInput("Last possible occurrence (optional).").optional(),
  splitWith: z.array(emailOrMeSchema).max(50).optional().describe("Split each occurrence equally with these people"),
  groupId: idSchema.optional().describe("Split each occurrence equally among this group's members"),
});

export const cancelRecurringSchema = z.object({ id: idSchema });

export const updateSettingsSchema = z.object({
  timezone: z.string().optional().describe('IANA time zone such as "Asia/Kolkata" or "America/New_York"'),
  defaultCurrency: currencySchema.optional(),
  name: z.string().trim().min(1).max(80).optional(),
});
