import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import type { LedgerSettlement, LedgerSplit } from "../lib";

export interface Ledger {
  splits: LedgerSplit[];
  settlements: LedgerSettlement[];
}

async function fetchLedger(
  splitWhere: Prisma.ExpenseSplitWhereInput,
  settlementWhere: Prisma.SettlementWhereInput,
): Promise<Ledger> {
  const [splits, settlements] = await Promise.all([
    prisma.expenseSplit.findMany({
      where: splitWhere,
      select: { userId: true, amount: true, expense: { select: { payerId: true, currency: true } } },
    }),
    prisma.settlement.findMany({
      where: { ...settlementWhere, status: "CONFIRMED" },
      select: { payerId: true, payeeId: true, amount: true, currency: true },
    }),
  ]);
  return {
    splits: splits.map((s) => ({ userId: s.userId, amount: s.amount, payerId: s.expense.payerId, currency: s.expense.currency })),
    settlements,
  };
}

/** Everything that affects what `meId` owes or is owed, optionally narrowed to one friend and/or group. */
export function personalLedger(meId: string, opts: { friendId?: string; groupId?: string } = {}) {
  const groupFilter = opts.groupId ? { groupId: opts.groupId } : {};
  const splitWhere: Prisma.ExpenseSplitWhereInput = opts.friendId
    ? {
        OR: [
          { userId: meId, expense: { payerId: opts.friendId, ...groupFilter } },
          { userId: opts.friendId, expense: { payerId: meId, ...groupFilter } },
        ],
      }
    : {
        OR: [
          { userId: meId, expense: { payerId: { not: meId }, ...groupFilter } },
          { userId: { not: meId }, expense: { payerId: meId, ...groupFilter } },
        ],
      };
  const settlementWhere: Prisma.SettlementWhereInput = {
    ...groupFilter,
    OR: opts.friendId
      ? [
          { payerId: meId, payeeId: opts.friendId },
          { payerId: opts.friendId, payeeId: meId },
        ]
      : [{ payerId: meId }, { payeeId: meId }],
  };
  return fetchLedger(splitWhere, settlementWhere);
}

export function groupLedger(groupId: string) {
  return fetchLedger({ expense: { groupId } }, { groupId });
}
