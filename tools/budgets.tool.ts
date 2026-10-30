import type { z } from "zod";
import type { Budget, BudgetPeriod } from "@prisma/client";
import { prisma } from "../db";
import {
  formatMoney,
  formatZonedDate,
  loadUser,
  money,
  normalizeCategory,
  normalizeCurrency,
  NotFoundError,
  resolveDateRange,
  toMinor,
  type DateRange,
} from "../lib";
import type { deleteBudgetSchema, setBudgetSchema } from "../types";

export const OVERALL_BUDGET = "*";
const WARNING_PERCENT = 80;

function currentRange(period: BudgetPeriod, tz: string, now = new Date()): Required<DateRange> {
  return resolveDateRange(period === "WEEKLY" ? "this_week" : "this_month", undefined, undefined, tz, now) as Required<DateRange>;
}

async function spentFor(userId: string, budget: Pick<Budget, "category" | "currency">, range: Required<DateRange>) {
  const agg = await prisma.expenseSplit.aggregate({
    _sum: { amount: true },
    where: {
      userId,
      expense: {
        currency: budget.currency,
        date: { gte: range.gte, lte: range.lte },
        ...(budget.category !== OVERALL_BUDGET ? { category: budget.category } : {}),
      },
    },
  });
  return agg._sum.amount ?? 0;
}

function describe(budget: Budget, spent: number, range: Required<DateRange>, tz: string) {
  const percentUsed = Math.round((spent / budget.amount) * 1000) / 10;
  const status = spent > budget.amount ? "exceeded" : percentUsed >= WARNING_PERCENT ? "warning" : "ok";
  return {
    id: budget.id,
    category: budget.category === OVERALL_BUDGET ? "overall" : budget.category,
    period: budget.period.toLowerCase(),
    periodStart: formatZonedDate(range.gte, tz),
    periodEnd: formatZonedDate(range.lte, tz),
    limit: money(budget.amount, budget.currency),
    spent: money(spent, budget.currency),
    remaining: money(Math.max(0, budget.amount - spent), budget.currency),
    percentUsed,
    status,
  };
}

export async function setBudget(args: z.infer<typeof setBudgetSchema>, currentUserId: string) {
  const me = await loadUser(currentUserId);
  const category = args.category ? normalizeCategory(args.category) : OVERALL_BUDGET;
  const currency = normalizeCurrency(args.currency, me.defaultCurrency);
  const period = args.period.toUpperCase() as BudgetPeriod;
  const amount = toMinor(args.amount);

  const budget = await prisma.budget.upsert({
    where: { userId_category_period_currency: { userId: me.id, category, period, currency } },
    update: { amount },
    create: { userId: me.id, category, period, currency, amount },
  });
  const range = currentRange(budget.period, me.timezone);
  return { message: "Budget saved.", budget: describe(budget, await spentFor(me.id, budget, range), range, me.timezone) };
}

export async function getBudgetStatus(currentUserId: string) {
  const me = await loadUser(currentUserId);
  const budgets = await prisma.budget.findMany({ where: { userId: me.id }, orderBy: [{ period: "asc" }, { category: "asc" }] });
  if (budgets.length === 0) return { message: "You have no budgets yet. Create one with set-budget.", budgets: [] };
  const result = [];
  for (const b of budgets) {
    const range = currentRange(b.period, me.timezone);
    result.push(describe(b, await spentFor(me.id, b, range), range, me.timezone));
  }
  return { budgets: result };
}

export async function deleteBudget(args: z.infer<typeof deleteBudgetSchema>, currentUserId: string) {
  const { count } = await prisma.budget.deleteMany({ where: { id: args.id, userId: currentUserId } });
  if (count === 0) throw new NotFoundError("Budget not found.");
  return { message: "Budget deleted." };
}

/** Warnings to attach to an add-expense response when a budget is at 80% or more. */
export async function budgetAlertsFor(
  userId: string,
  tz: string,
  category: string,
  currency: string,
  expenseDate: Date,
): Promise<string[]> {
  const budgets = await prisma.budget.findMany({
    where: { userId, currency, category: { in: [category, OVERALL_BUDGET] } },
  });
  const alerts: string[] = [];
  for (const b of budgets) {
    const range = currentRange(b.period, tz);
    if (expenseDate < range.gte || expenseDate > range.lte) continue;
    const spent = await spentFor(userId, b, range);
    const d = describe(b, spent, range, tz);
    if (d.status === "ok") continue;
    const label = b.category === OVERALL_BUDGET ? `overall ${d.period}` : `${d.period} ${b.category}`;
    alerts.push(
      d.status === "exceeded"
        ? `Over budget: your ${label} budget is ${formatMoney(b.amount, b.currency)} and you have spent ${formatMoney(spent, b.currency)} (${d.percentUsed}%).`
        : `Heads up: you have used ${d.percentUsed}% of your ${label} budget (${formatMoney(spent, b.currency)} of ${formatMoney(b.amount, b.currency)}).`,
    );
  }
  return alerts;
}
