import type { z } from "zod";
import type { Frequency, RecurringExpense } from "@prisma/client";
import { prisma } from "../db";
import { logger } from "../lib/logger";
import {
  addInterval,
  formatZonedDate,
  loadUser,
  money,
  normalizeCategory,
  normalizeCurrency,
  normalizeEmail,
  NotFoundError,
  parseDateInput,
  toMinor,
  ValidationError,
} from "../lib";
import type { addRecurringExpenseSchema, cancelRecurringSchema } from "../types";
import { createExpense, planShares } from "./expense-service";

function describe(r: RecurringExpense, tz: string) {
  return {
    id: r.id,
    description: r.description,
    category: r.category,
    ...money(r.amount, r.currency),
    frequency: r.frequency.toLowerCase(),
    startDate: formatZonedDate(r.startDate, tz),
    endDate: r.endDate ? formatZonedDate(r.endDate, tz) : null,
    nextDate: r.active ? formatZonedDate(r.nextDate, tz) : null,
    occurrencesCreated: r.occurrencesCreated,
    splitWith: r.splitWith,
    groupId: r.groupId,
    active: r.active,
  };
}

export async function addRecurringExpense(args: z.infer<typeof addRecurringExpenseSchema>, currentUserId: string) {
  const me = await loadUser(currentUserId);
  const amount = toMinor(args.amount);
  const currency = normalizeCurrency(args.currency, me.defaultCurrency);
  const category = normalizeCategory(args.category);
  const start = parseDateInput(args.startDate ?? "today", me.timezone, "midday");
  const end = args.endDate ? parseDateInput(args.endDate, me.timezone, "end") : null;
  if (end && end < start) throw new ValidationError("endDate must be after startDate.");

  const splitWith = (args.splitWith ?? []).map((e) => (e.trim().toLowerCase() === "me" ? "me" : normalizeEmail(e)));
  // Validate the split up front so a bad email or non-member fails now, not on the first occurrence.
  await planShares(me, amount, { splitWith }, args.groupId);

  const created = await prisma.recurringExpense.create({
    data: {
      ownerId: me.id,
      amount,
      currency,
      category,
      description: args.description,
      frequency: args.frequency.toUpperCase() as Frequency,
      startDate: start,
      endDate: end,
      nextDate: start,
      groupId: args.groupId,
      splitWith,
    },
  });
  const backfilled = await materializeRecurring(me.id);
  const fresh = await prisma.recurringExpense.findUniqueOrThrow({ where: { id: created.id } });
  return {
    message:
      backfilled > 0
        ? `Recurring expense created. ${backfilled} past occurrence(s) were added.`
        : "Recurring expense created.",
    recurring: describe(fresh, me.timezone),
  };
}

export async function listRecurringExpenses(currentUserId: string) {
  const me = await loadUser(currentUserId);
  const rows = await prisma.recurringExpense.findMany({
    where: { ownerId: me.id },
    orderBy: [{ active: "desc" }, { nextDate: "asc" }],
  });
  return rows.map((r) => describe(r, me.timezone));
}

export async function cancelRecurringExpense(args: z.infer<typeof cancelRecurringSchema>, currentUserId: string) {
  const { count } = await prisma.recurringExpense.updateMany({
    where: { id: args.id, ownerId: currentUserId, active: true },
    data: { active: false },
  });
  if (count === 0) throw new NotFoundError("No active recurring expense with that id.");
  return { message: "Recurring expense cancelled. Past occurrences are kept." };
}

/**
 * Creates every occurrence that has come due. Each occurrence is claimed with a
 * compare-and-set on occurrencesCreated, so concurrent calls never duplicate one.
 */
export async function materializeRecurring(userId: string, now = new Date(), maxPerRun = 60): Promise<number> {
  const due = await prisma.recurringExpense.findMany({
    where: { ownerId: userId, active: true, nextDate: { lte: now } },
  });
  if (due.length === 0) return 0;
  const me = await loadUser(userId);

  let created = 0;
  for (const r of due) {
    let occurrences = r.occurrencesCreated;
    let next = r.nextDate;
    while (next <= now && (!r.endDate || next <= r.endDate) && created < maxPerRun) {
      let plan;
      try {
        plan = await planShares(me, r.amount, { splitWith: r.splitWith }, r.groupId);
      } catch (err) {
        logger.warn("recurring expense disabled: split no longer valid", { recurringId: r.id, err });
        await prisma.recurringExpense.update({ where: { id: r.id }, data: { active: false } });
        break;
      }
      const after = addInterval(r.startDate, r.frequency, occurrences + 1, me.timezone);
      const claimed = await prisma.$transaction(async (tx) => {
        const { count } = await tx.recurringExpense.updateMany({
          where: { id: r.id, occurrencesCreated: occurrences, active: true },
          data: { occurrencesCreated: occurrences + 1, nextDate: after, active: !r.endDate || after <= r.endDate },
        });
        if (count === 0) return false;
        await createExpense(
          userId,
          {
            amount: r.amount,
            currency: r.currency,
            category: r.category,
            description: r.description,
            date: next,
            groupId: r.groupId,
            splitType: plan.splitType,
            shares: plan.shares,
            recurringExpenseId: r.id,
          },
          tx,
        );
        return true;
      });
      if (!claimed) break;
      occurrences++;
      next = after;
      created++;
    }
  }
  return created;
}

const MATERIALIZE_EVERY_MS = 5 * 60 * 1000;
const lastRun = new Map<string, number>();

/** Called before tools run; does the (cheap) due-check at most every few minutes per user. */
export async function maybeMaterializeRecurring(userId: string) {
  const last = lastRun.get(userId) ?? 0;
  if (Date.now() - last < MATERIALIZE_EVERY_MS) return;
  lastRun.set(userId, Date.now());
  try {
    const n = await materializeRecurring(userId);
    if (n > 0) logger.info("recurring expenses created", { userId, count: n });
  } catch (err) {
    logger.error("recurring materialization failed", { userId, err });
  }
}
