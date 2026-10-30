import { z } from "zod";
import {
  amountSchema,
  categorySchema,
  currencySchema,
  dateFilterShape,
  dateInput,
  dateInputSchema,
  emailOrMeSchema,
  idSchema,
  paginationShape,
} from "./common.type";

export const splitTypeSchema = z
  .enum(["equal", "exact", "percentage", "shares", "itemized"])
  .describe(
    "How to divide the cost. equal: everyone in splitWith (plus you unless includeMe=false) pays the same. " +
      "exact / percentage / shares: give each person's value in `splits`. " +
      "itemized: list bill items in `items`; tax/tip (total minus items) is shared in proportion to what each person ordered.",
  );

export const splitInputShape = {
  splitType: splitTypeSchema.optional(),
  splitWith: z
    .array(emailOrMeSchema)
    .max(50)
    .optional()
    .describe("For equal splits: people to share with. If omitted and groupId is set, all group members share it."),
  includeMe: z
    .boolean()
    .optional()
    .describe("For equal splits: whether you also take a share (default true). Set false if you paid only on behalf of others."),
  splits: z
    .array(
      z.object({
        email: emailOrMeSchema,
        amount: amountSchema.optional().describe("For exact splits: this person's amount"),
        percent: z.number().positive().max(100).optional().describe("For percentage splits: this person's percent"),
        shares: z.number().positive().max(1000).optional().describe("For shares splits: this person's number of shares"),
      }),
    )
    .max(50)
    .optional()
    .describe('Per-person values for exact, percentage or shares splits. Include "me" if you have a share.'),
  items: z
    .array(
      z.object({
        description: z.string().max(100).optional(),
        amount: amountSchema,
        sharedBy: z.array(emailOrMeSchema).min(1).max(50).describe('Who shares this item ("me" for yourself)'),
      }),
    )
    .max(100)
    .optional()
    .describe("For itemized splits, e.g. read from a receipt photo."),
};

export const addExpenseSchema = z.object({
  amount: amountSchema.describe("Total amount paid, including tax and tip"),
  currency: currencySchema.optional(),
  category: categorySchema,
  description: z.string().max(200).optional(),
  date: dateInput("When it happened. Defaults to now.").optional(),
  groupId: idSchema.optional().describe("Group this expense belongs to (you must be a member)"),
  ...splitInputShape,
});

export const listExpensesSchema = z.object({
  ...dateFilterShape,
  category: categorySchema.optional(),
  groupId: idSchema.optional(),
  scope: z
    .enum(["involved", "paid_by_me"])
    .default("involved")
    .describe("involved: every expense you paid for or have a share in (default). paid_by_me: only ones you paid."),
  ...paginationShape,
});

export const updateExpenseSchema = z.object({
  id: idSchema,
  amount: amountSchema.optional().describe("New total. Existing shares are rescaled proportionally unless you also pass a new split."),
  currency: currencySchema.optional(),
  category: categorySchema.optional(),
  description: z.string().max(200).optional(),
  date: dateInputSchema.optional(),
  ...splitInputShape,
});

export const deleteExpenseSchema = z.object({ id: idSchema });

export const getSummarySchema = z.object({
  ...dateFilterShape,
  groupId: idSchema.optional(),
});

export const getExpensesByCategorySchema = z.object({
  category: categorySchema,
  ...dateFilterShape,
  ...paginationShape,
});

export const importExpensesSchema = z.object({
  expenses: z
    .array(
      z.object({
        amount: amountSchema,
        currency: currencySchema.optional(),
        category: categorySchema,
        description: z.string().max(200).optional(),
        date: dateInputSchema,
      }),
    )
    .min(1)
    .max(500)
    .describe("Personal expenses to import, e.g. parsed from a bank statement, CSV file or UPI/bank SMS messages."),
  skipDuplicates: z
    .boolean()
    .default(true)
    .describe("Skip rows matching an existing expense with the same day, amount, currency, category and description."),
});

export const exportExpensesSchema = z.object({
  ...dateFilterShape,
});
