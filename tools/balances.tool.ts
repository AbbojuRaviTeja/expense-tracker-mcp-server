import type { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { sendEmail } from "../lib/notify";
import {
  assertGroupMember,
  findUserByEmail,
  formatMoney,
  formatZonedDate,
  fromMinor,
  loadUser,
  money,
  normalizeCurrency,
  NotFoundError,
  page,
  pairwiseBalances,
  resolveDateRange,
  toMinor,
  ValidationError,
} from "../lib";
import type {
  getBalancesSchema,
  getSplitHistorySchema,
  respondToPaymentSchema,
  sendReminderSchema,
  settleUpSchema,
} from "../types";
import { expenseInclude, personSelect } from "./expense-service";
import { personalLedger } from "./ledger";

/** What everyone owes you and what you owe everyone, per currency. */
export async function getBalances(args: z.infer<typeof getBalancesSchema>, currentUserId: string) {
  const me = await loadUser(currentUserId);
  const friend = args.friendEmail ? await findUserByEmail(args.friendEmail) : undefined;
  const ledger = await personalLedger(me.id, { friendId: friend?.id });
  const balances = pairwiseBalances(me.id, ledger.splits, ledger.settlements);

  const ids = [...balances.keys()];
  const people = new Map(
    (await prisma.user.findMany({ where: { id: { in: ids } }, select: personSelect })).map((u) => [u.id, u]),
  );

  const totals = new Map<string, { owedToYou: number; youOwe: number }>();
  const rows = [];
  for (const [otherId, byCurrency] of balances) {
    const items = [];
    for (const [currency, amount] of byCurrency) {
      if (amount === 0) continue;
      const t = totals.get(currency) ?? { owedToYou: 0, youOwe: 0 };
      if (amount > 0) t.owedToYou += amount;
      else t.youOwe += -amount;
      totals.set(currency, t);
      items.push({ ...money(Math.abs(amount), currency), direction: amount > 0 ? "owes you" : "you owe" });
    }
    if (items.length > 0) rows.push({ person: people.get(otherId), balances: items });
  }

  const pending = await prisma.settlement.count({ where: { payeeId: me.id, status: "PENDING" } });
  return {
    summary: [...totals].map(([currency, t]) => ({
      currency,
      owedToYou: fromMinor(t.owedToYou),
      youOwe: fromMinor(t.youOwe),
      net: fromMinor(t.owedToYou - t.youOwe),
      display: `You are owed ${formatMoney(t.owedToYou, currency)} and owe ${formatMoney(t.youOwe, currency)}`,
    })),
    people: rows,
    ...(rows.length === 0 && { message: friend ? `You and ${friend.email} are settled up.` : "You are all settled up." }),
    ...(pending > 0 && { paymentsAwaitingYourConfirmation: pending }),
  };
}

/** Shared expenses and payments between you and others, newest first. */
export async function getSplitHistory(args: z.infer<typeof getSplitHistorySchema>, currentUserId: string) {
  const me = await loadUser(currentUserId);
  const friend = args.friendEmail ? await findUserByEmail(args.friendEmail) : undefined;
  if (args.groupId) await assertGroupMember(args.groupId, me.id);
  const range = resolveDateRange(args.period, args.startDate, args.endDate, me.timezone);
  const dateFilter = range.gte || range.lte ? { gte: range.gte, lte: range.lte } : undefined;

  const shared: Prisma.ExpenseWhereInput = friend
    ? {
        OR: [
          { payerId: me.id, splits: { some: { userId: friend.id } } },
          { payerId: friend.id, splits: { some: { userId: me.id } } },
        ],
      }
    : {
        OR: [
          { payerId: me.id, splits: { some: { userId: { not: me.id } } } },
          { payerId: { not: me.id }, splits: { some: { userId: me.id } } },
        ],
      };
  const where: Prisma.ExpenseWhereInput = {
    AND: [shared, args.groupId ? { groupId: args.groupId } : {}, { date: dateFilter }],
  };

  const settlementWhere: Prisma.SettlementWhereInput = {
    ...(args.groupId && { groupId: args.groupId }),
    ...(dateFilter && { createdAt: dateFilter }),
    OR: friend
      ? [
          { payerId: me.id, payeeId: friend.id },
          { payerId: friend.id, payeeId: me.id },
        ]
      : [{ payerId: me.id }, { payeeId: me.id }],
  };

  const [total, expenses, payments] = await Promise.all([
    prisma.expense.count({ where }),
    prisma.expense.findMany({ where, include: expenseInclude, orderBy: { date: "desc" }, skip: args.offset, take: args.limit }),
    prisma.settlement.findMany({
      where: settlementWhere,
      include: { payer: { select: personSelect }, payee: { select: personSelect } },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);

  const items = expenses.map((e) => {
    const myShare = e.splits.find((s) => s.userId === me.id)?.amount ?? 0;
    const youPaid = e.payerId === me.id;
    const effect = youPaid ? e.amount - myShare : -myShare;
    return {
      id: e.id,
      date: formatZonedDate(e.date, me.timezone),
      description: e.description,
      category: e.category,
      total: money(e.amount, e.currency),
      paidBy: youPaid ? "you" : e.payer.name ?? e.payer.email,
      yourShare: fromMinor(myShare),
      effect: youPaid
        ? `you lent ${formatMoney(effect, e.currency)}`
        : `you borrowed ${formatMoney(-effect, e.currency)}`,
      group: e.group?.name ?? null,
    };
  });

  return {
    expenses: page(items, total, args.limit, args.offset),
    payments: payments.map((p) => ({
      id: p.id,
      date: formatZonedDate(p.createdAt, me.timezone),
      from: p.payerId === me.id ? "you" : p.payer.name ?? p.payer.email,
      to: p.payeeId === me.id ? "you" : p.payee.name ?? p.payee.email,
      ...money(p.amount, p.currency),
      status: p.status.toLowerCase(),
      note: p.note,
    })),
  };
}

/**
 * Records a real-money payment between you and a friend.
 * - If they owed you, you are confirming you received it: recorded as confirmed.
 * - If you owed them, it stays pending until they confirm with respond-to-payment.
 */
export async function settleUp(args: z.infer<typeof settleUpSchema>, currentUserId: string) {
  const me = await loadUser(currentUserId);
  const friend = await findUserByEmail(args.friendEmail);
  if (friend.id === me.id) throw new ValidationError("You cannot settle up with yourself.");
  if (args.groupId) {
    await assertGroupMember(args.groupId, me.id);
    await assertGroupMember(args.groupId, friend.id).catch(() => {
      throw new ValidationError(`${friend.email} is not a member of this group.`);
    });
  }

  const ledger = await personalLedger(me.id, { friendId: friend.id, groupId: args.groupId });
  const byCurrency = pairwiseBalances(me.id, ledger.splits, ledger.settlements).get(friend.id) ?? new Map<string, number>();
  const open = [...byCurrency].filter(([, v]) => v !== 0);

  let currency: string;
  if (args.currency) currency = normalizeCurrency(args.currency, me.defaultCurrency);
  else if (open.length === 1) currency = open[0][0];
  else if (open.length === 0) return { message: `You and ${friend.name ?? friend.email} are already settled up.` };
  else {
    throw new ValidationError(
      `You have balances in ${open.map(([c]) => c).join(", ")} with ${friend.email}. Say which currency to settle.`,
    );
  }

  const balance = byCurrency.get(currency) ?? 0;
  if (balance === 0) return { message: `You and ${friend.name ?? friend.email} are settled up in ${currency}.` };

  const theyOweMe = balance > 0;
  let outstanding = Math.abs(balance);
  if (!theyOweMe) {
    const pending = await prisma.settlement.aggregate({
      _sum: { amount: true },
      where: { payerId: me.id, payeeId: friend.id, currency, status: "PENDING", ...(args.groupId && { groupId: args.groupId }) },
    });
    outstanding -= pending._sum.amount ?? 0;
    if (outstanding <= 0) {
      return { message: `You already recorded payments covering this. Waiting for ${friend.email} to confirm them.` };
    }
  }

  const amount = args.amount !== undefined ? toMinor(args.amount) : outstanding;
  if (amount > outstanding) {
    throw new ValidationError(
      `That is more than the outstanding ${formatMoney(outstanding, currency)}. Record at most that amount.`,
    );
  }

  const settlement = await prisma.settlement.create({
    data: {
      payerId: theyOweMe ? friend.id : me.id,
      payeeId: theyOweMe ? me.id : friend.id,
      amount,
      currency,
      groupId: args.groupId,
      note: args.note,
      recordedById: me.id,
      status: theyOweMe ? "CONFIRMED" : "PENDING",
      confirmedAt: theyOweMe ? new Date() : null,
    },
  });

  if (!theyOweMe) {
    void sendEmail(
      friend.email,
      `${me.name ?? me.email} says they paid you ${formatMoney(amount, currency)}`,
      `${me.name ?? me.email} recorded a payment of ${formatMoney(amount, currency)} to you. ` +
        `Ask your AI assistant to "confirm my pending payments" to accept it.`,
    );
  }

  const remaining = outstanding - amount;
  return {
    paymentId: settlement.id,
    status: settlement.status.toLowerCase(),
    message: theyOweMe
      ? `Recorded that ${friend.name ?? friend.email} paid you ${formatMoney(amount, currency)}.`
      : `Recorded your payment of ${formatMoney(amount, currency)} to ${friend.name ?? friend.email}. It counts once they confirm it.`,
    remainingBalance: money(remaining, currency),
  };
}

export async function listPendingPayments(currentUserId: string) {
  const include = { payer: { select: personSelect }, payee: { select: personSelect } } as const;
  const [toConfirm, waiting] = await Promise.all([
    prisma.settlement.findMany({ where: { payeeId: currentUserId, status: "PENDING" }, include, orderBy: { createdAt: "asc" } }),
    prisma.settlement.findMany({ where: { payerId: currentUserId, status: "PENDING" }, include, orderBy: { createdAt: "asc" } }),
  ]);
  const shape = (p: (typeof toConfirm)[number]) => ({
    paymentId: p.id,
    from: p.payer,
    to: p.payee,
    ...money(p.amount, p.currency),
    note: p.note,
    recordedAt: p.createdAt,
  });
  return {
    awaitingYourConfirmation: toConfirm.map(shape),
    awaitingOthers: waiting.map(shape),
  };
}

/** Only the person who received the money can confirm or reject a pending payment. */
export async function respondToPayment(args: z.infer<typeof respondToPaymentSchema>, currentUserId: string) {
  const confirm = args.action === "confirm";
  const { count } = await prisma.settlement.updateMany({
    where: { id: args.paymentId, payeeId: currentUserId, status: "PENDING" },
    data: { status: confirm ? "CONFIRMED" : "REJECTED", confirmedAt: confirm ? new Date() : null },
  });
  if (count === 0) throw new NotFoundError("No pending payment to you with that id.");
  return { message: confirm ? "Payment confirmed. Balances updated." : "Payment rejected." };
}

const REMINDER_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const lastReminder = new Map<string, number>();

export async function sendReminder(args: z.infer<typeof sendReminderSchema>, currentUserId: string) {
  const me = await loadUser(currentUserId);
  const friend = await findUserByEmail(args.friendEmail);
  const ledger = await personalLedger(me.id, { friendId: friend.id });
  const owed = [...(pairwiseBalances(me.id, ledger.splits, ledger.settlements).get(friend.id) ?? new Map<string, number>())]
    .filter(([, v]) => v > 0);
  if (owed.length === 0) return { message: `${friend.email} does not owe you anything.` };

  const key = `${me.id}:${friend.id}`;
  const last = lastReminder.get(key);
  if (last && Date.now() - last < REMINDER_COOLDOWN_MS) {
    return { message: `You already reminded ${friend.email} recently. Try again later.` };
  }

  const amounts = owed.map(([c, v]) => formatMoney(v, c)).join(" and ");
  const result = await sendEmail(
    friend.email,
    `Reminder: you owe ${me.name ?? me.email} ${amounts}`,
    `Hi! This is a friendly reminder that you owe ${me.name ?? me.email} ${amounts} on Expense Tracker.`,
  );
  if (result.sent) lastReminder.set(key, Date.now());
  return { message: result.sent ? `Reminder sent to ${friend.email} for ${amounts}.` : `Could not send: ${result.reason}`, owed: amounts };
}
