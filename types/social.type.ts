import { z } from "zod";
import { amountSchema, currencySchema, dateFilterShape, idSchema, paginationShape } from "./common.type";

export const addFriendSchema = z.object({
  email: z.email(),
  sendInvite: z
    .boolean()
    .default(true)
    .describe("Email an invitation if they have not joined yet (only when email is configured on the server)"),
});

export const createGroupSchema = z.object({
  name: z.string().trim().min(1).max(80),
  memberEmails: z.array(z.email()).max(50).default([]).describe("Other members. You are added automatically."),
});

export const addGroupMemberSchema = z.object({
  groupId: idSchema,
  email: z.email(),
});

export const groupIdSchema = z.object({ groupId: idSchema });

export const getBalancesSchema = z.object({
  friendEmail: z.email().optional().describe("Only show the balance with this person"),
});

export const getSplitHistorySchema = z.object({
  friendEmail: z.email().optional(),
  groupId: idSchema.optional(),
  ...dateFilterShape,
  ...paginationShape,
});

export const settleUpSchema = z.object({
  friendEmail: z.email(),
  amount: amountSchema.optional().describe("Amount paid. Defaults to the full outstanding balance."),
  currency: currencySchema.optional().describe("Needed only if you have balances in more than one currency"),
  groupId: idSchema.optional().describe("Settle only the balance inside this group"),
  note: z.string().max(200).optional(),
});

export const respondToPaymentSchema = z.object({
  paymentId: idSchema,
  action: z.enum(["confirm", "reject"]),
});

export const sendReminderSchema = z.object({
  friendEmail: z.email(),
});
