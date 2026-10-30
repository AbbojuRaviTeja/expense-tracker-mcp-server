import type { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import {
  assertGroupMember,
  formatExpense,
  formatZonedDate,
  fromMinor,
  loadUser,
  money,
  normalizeCategory,
  normalizeCurrency,
  page,
  parseDateInput,
  rescaleShares,
  resolveDateRange,
  toMinor,
  type DateRange,
} from "../lib";
import type {
  addExpenseSchema,
  deleteExpenseSchema,
  exportExpensesSchema,
  getExpensesByCategorySchema,
  getSummarySchema,
  importExpensesSchema,
  listExpensesSchema,
  updateExpenseSchema,
} from "../types";
import { budgetAlertsFor } from "./budgets.tool";
import {
  createExpense,
  ensureFriendships,
  expenseInclude,
  hasSplitInput,
  loadOwnExpense,
  planShares,
} from "./expense-service";

function dateWhere(range: DateRange): Prisma.DateTimeFilter | undefined {
  return range.gte || range.lte ? { ...(range.gte && { gte: range.gte }), ...(range.lte && { lte: range.lte }) } : undefined;
}

function involving(userId: string): Prisma.ExpenseWhereInput {
  return { OR: [{ payerId: userId }, { splits: { some: { userId } } }] };
}

export async function addExpense(args: z.infer<typeof addExpenseSchema>, currentUserId: string) {
  const me = await loadUser(currentUserId);
  const amount = toMinor(args.amount);
  const currency = normalizeCurrency(args.currency, me.defaultCurrency);
  const category = normalizeCategory(args.category);
  const date = args.date ? parseDateInput(args.date, me.timezone, "midday") : new Date();

  const plan = await planShares(me, amount, args, args.groupId);
  const expense = await createExpense(me.id, {
    amount,
    currency,
    category,
    description: args.description,
    date,
    groupId: args.groupId,
    splitType: plan.splitType,
    shares: plan.shares,
  });
  if (!args.groupId) await ensureFriendships(me.id, plan.shares.map((s) => s.userId));

  const budgetAlerts = await budgetAlertsFor(me.id, me.timezone, category, currency, date);
  return {
    message: "Expense added.",
    expense: formatExpense(expense, me.timezone, me.id),
    ...(plan.invitedEmails.length > 0 && {
      newlyInvited: plan.invitedEmails,
      note: "These people have not joined yet. Their shares will be waiting for them when they sign in.",
    }),
    ...(budgetAlerts.length > 0 && { budgetAlerts }),
  };
}

export async function listExpenses(args: z.infer<typeof listExpensesSchema>, currentUserId: string) {
  const me = await loadUser(currentUserId);
  const range = resolveDateRange(args.period, args.startDate, args.endDate, me.timezone);
  if (args.groupId) await assertGroupMember(args.groupId, me.id);

  const where: Prisma.ExpenseWhereInput = {
    AND: [
      args.scope === "paid_by_me" ? { payerId: me.id } : args.groupId ? {} : involving(me.id),
      args.category ? { category: normalizeCategory(args.category) } : {},
      args.groupId ? { groupId: args.groupId } : {},
      { date: dateWhere(range) },
    ],
  };
  const [total, rows] = await Promise.all([
    prisma.expense.count({ where }),
    prisma.expense.findMany({
      where,
      include: expenseInclude,
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      skip: args.offset,
      take: args.limit,
    }),
  ]);
  return page(rows.map((e) => formatExpense(e, me.timezone, me.id)), total, args.limit, args.offset);
}

export async function updateExpense(args: z.infer<typeof updateExpenseSchema>, currentUserId: string) {
  const me = await loadUser(currentUserId);
  const existing = await loadOwnExpense(args.id, me.id);

  const newTotal = args.amount !== undefined ? toMinor(args.amount) : existing.amount;
  let replacement: { splitType: Prisma.ExpenseUpdateInput["splitType"]; shares: { userId: string; amount: number }[] } | undefined;
  if (hasSplitInput(args)) {
    const plan = await planShares(me, newTotal, args, existing.groupId);
    replacement = { splitType: plan.splitType, shares: plan.shares };
  } else if (newTotal !== existing.amount) {
    const ordered = [...existing.splits].sort((a, b) => Number(b.userId === me.id) - Number(a.userId === me.id));
    replacement = { splitType: existing.splitType, shares: rescaleShares(ordered, newTotal) };
  }

  const updated = await prisma.$transaction(async (tx) => {
    if (replacement) {
      await tx.expenseSplit.deleteMany({ where: { expenseId: existing.id } });
      await tx.expenseSplit.createMany({
        data: replacement.shares.map((s) => ({ expenseId: existing.id, userId: s.userId, amount: s.amount })),
      });
    }
    return tx.expense.update({
      where: { id: existing.id },
      data: {
        amount: newTotal,
        ...(args.currency && { currency: normalizeCurrency(args.currency, existing.currency) }),
        ...(args.category && { category: normalizeCategory(args.category) }),
        ...(args.description !== undefined && { description: args.description }),
        ...(args.date && { date: parseDateInput(args.date, me.timezone, "midday") }),
        ...(replacement && { splitType: replacement.splitType }),
      },
      include: expenseInclude,
    });
  });
  if (replacement && !existing.groupId) await ensureFriendships(me.id, replacement.shares.map((s) => s.userId));

  return {
    message: replacement ? "Expense updated and shares recalculated." : "Expense updated.",
    expense: formatExpense(updated, me.timezone, me.id),
  };
}

export async function deleteExpense(args: z.infer<typeof deleteExpenseSchema>, currentUserId: string) {
  const me = await loadUser(currentUserId);
  const existing = await loadOwnExpense(args.id, me.id);
  await prisma.expense.delete({ where: { id: existing.id } });
  return { message: "Expense deleted.", expense: formatExpense(existing, me.timezone, me.id) };
}

/**
 * Spending by category. Personal view counts only YOUR share of each expense,
 * so a ₹3000 dinner split three ways adds ₹1000 to your food total.
 * With groupId it shows the whole group's spending instead.
 */
export async function getSummary(args: z.infer<typeof getSummarySchema>, currentUserId: string) {
  const me = await loadUser(currentUserId);
  const range = resolveDateRange(args.period, args.startDate, args.endDate, me.timezone);

  let rows: { category: string; currency: string; amount: number }[];
  if (args.groupId) {
    await assertGroupMember(args.groupId, me.id);
    const expenses = await prisma.expense.findMany({
      where: { groupId: args.groupId, date: dateWhere(range) },
      select: { category: true, currency: true, amount: true },
    });
    rows = expenses;
  } else {
    const splits = await prisma.expenseSplit.findMany({
      where: { userId: me.id, expense: { date: dateWhere(range) } },
      select: { amount: true, expense: { select: { category: true, currency: true } } },
    });
    rows = splits.map((s) => ({ category: s.expense.category, currency: s.expense.currency, amount: s.amount }));
  }

  const byCurrency = new Map<string, Map<string, { total: number; count: number }>>();
  for (const r of rows) {
    let cats = byCurrency.get(r.currency);
    if (!cats) byCurrency.set(r.currency, (cats = new Map()));
    const c = cats.get(r.category) ?? { total: 0, count: 0 };
    c.total += r.amount;
    c.count += 1;
    cats.set(r.category, c);
  }

  return {
    basis: args.groupId ? "Whole group's spending" : "Your share of each expense",
    from: range.gte ? formatZonedDate(range.gte, me.timezone) : null,
    to: range.lte ? formatZonedDate(range.lte, me.timezone) : null,
    currencies: [...byCurrency].map(([currency, cats]) => {
      const total = [...cats.values()].reduce((a, c) => a + c.total, 0);
      return {
        currency,
        total: money(total, currency),
        categories: [...cats]
          .sort((a, b) => b[1].total - a[1].total)
          .map(([category, c]) => ({
            category,
            total: fromMinor(c.total),
            count: c.count,
            percent: total > 0 ? Math.round((c.total / total) * 1000) / 10 : 0,
          })),
      };
    }),
  };
}

export async function getExpensesByCategory(args: z.infer<typeof getExpensesByCategorySchema>, currentUserId: string) {
  const me = await loadUser(currentUserId);
  const range = resolveDateRange(args.period, args.startDate, args.endDate, me.timezone);
  const category = normalizeCategory(args.category);
  const where: Prisma.ExpenseWhereInput = { AND: [involving(me.id), { category }, { date: dateWhere(range) }] };

  const [total, rows, myShare] = await Promise.all([
    prisma.expense.count({ where }),
    prisma.expense.findMany({ where, include: expenseInclude, orderBy: { date: "desc" }, skip: args.offset, take: args.limit }),
    prisma.expenseSplit.groupBy({
      by: ["userId"],
      _sum: { amount: true },
      where: { userId: me.id, expense: { category, date: dateWhere(range) } },
    }),
  ]);
  return {
    category,
    yourShareTotal: fromMinor(myShare[0]?._sum.amount ?? 0),
    ...page(rows.map((e) => formatExpense(e, me.timezone, me.id)), total, args.limit, args.offset),
  };
}

export async function importExpenses(args: z.infer<typeof importExpensesSchema>, currentUserId: string) {
  const me = await loadUser(currentUserId);
  const rows = args.expenses.map((r) => ({
    amount: toMinor(r.amount),
    currency: normalizeCurrency(r.currency, me.defaultCurrency),
    category: normalizeCategory(r.category),
    description: r.description?.trim() || null,
    date: parseDateInput(r.date, me.timezone, "midday"),
  }));
  const keyOf = (r: { amount: number; currency: string; category: string; description: string | null; date: Date }) =>
    [formatZonedDate(r.date, me.timezone), r.amount, r.currency, r.category, (r.description ?? "").toLowerCase()].join("|");

  const seen = new Set<string>();
  if (args.skipDuplicates) {
    const times = rows.map((r) => r.date.getTime());
    const existing = await prisma.expense.findMany({
      where: {
        payerId: me.id,
        date: { gte: new Date(Math.min(...times) - 86_400_000), lte: new Date(Math.max(...times) + 86_400_000) },
      },
      select: { amount: true, currency: true, category: true, description: true, date: true },
    });
    for (const e of existing) seen.add(keyOf(e));
  }

  const toCreate: typeof rows = [];
  let skipped = 0;
  for (const r of rows) {
    const key = keyOf(r);
    if (args.skipDuplicates && seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);
    toCreate.push(r);
  }

  if (toCreate.length > 0) {
    await prisma.$transaction(async (tx) => {
      const created = await tx.expense.createManyAndReturn({
        data: toCreate.map((r) => ({ ...r, payerId: me.id, splitType: "EQUAL" as const })),
        select: { id: true, amount: true },
      });
      await tx.expenseSplit.createMany({
        data: created.map((e) => ({ expenseId: e.id, userId: me.id, amount: e.amount })),
      });
    });
  }
  return { message: `Imported ${toCreate.length} expense(s), skipped ${skipped} duplicate(s).`, imported: toCreate.length, skipped };
}

const CSV_LIMIT = 5000;

function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export async function exportExpensesCsv(args: z.infer<typeof exportExpensesSchema>, currentUserId: string) {
  const me = await loadUser(currentUserId);
  const range = resolveDateRange(args.period, args.startDate, args.endDate, me.timezone);
  const rows = await prisma.expense.findMany({
    where: { AND: [involving(me.id), { date: dateWhere(range) }] },
    include: expenseInclude,
    orderBy: { date: "asc" },
    take: CSV_LIMIT + 1,
  });
  const truncated = rows.length > CSV_LIMIT;
  const header = ["date", "description", "category", "currency", "total", "paid_by", "your_share", "group", "split_type", "id"];
  const lines = rows.slice(0, CSV_LIMIT).map((e) =>
    [
      formatZonedDate(e.date, me.timezone),
      e.description,
      e.category,
      e.currency,
      fromMinor(e.amount).toFixed(2),
      e.payer.email,
      fromMinor(e.splits.find((s) => s.userId === me.id)?.amount ?? 0).toFixed(2),
      e.group?.name,
      e.splitType.toLowerCase(),
      e.id,
    ]
      .map(csvCell)
      .join(","),
  );
  return [header.join(","), ...lines].join("\n") + (truncated ? `\n# truncated at ${CSV_LIMIT} rows, narrow the date range` : "");
}
