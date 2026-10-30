import { allocate } from "./money";
import { ValidationError } from "./errors";

export type SplitSpec =
  | { type: "EQUAL"; userIds: string[] }
  | { type: "EXACT"; entries: { userId: string; amount: number }[] }
  | { type: "PERCENTAGE"; entries: { userId: string; percent: number }[] }
  | { type: "SHARES"; entries: { userId: string; shares: number }[] }
  | { type: "ITEMIZED"; items: { amount: number; userIds: string[] }[] };

export interface Share {
  userId: string;
  amount: number;
}

function dedupe(ids: string[]): string[] {
  return [...new Set(ids)];
}

function assertNoDuplicates(ids: string[]) {
  if (new Set(ids).size !== ids.length) {
    throw new ValidationError("Each person can only appear once in a split.");
  }
}

/**
 * Turns a split specification into exact integer shares that always sum to `total`.
 * Order matters for rounding: earlier participants absorb leftover minor units first,
 * so callers put the payer first.
 */
export function computeShares(total: number, spec: SplitSpec): Share[] {
  if (!Number.isInteger(total) || total <= 0) {
    throw new ValidationError("Expense total must be a positive amount.");
  }

  let shares: Share[];
  switch (spec.type) {
    case "EQUAL": {
      const ids = dedupe(spec.userIds);
      const parts = allocate(total, ids.map(() => 1));
      shares = ids.map((userId, i) => ({ userId, amount: parts[i] }));
      break;
    }
    case "EXACT": {
      assertNoDuplicates(spec.entries.map((e) => e.userId));
      const sum = spec.entries.reduce((a, e) => a + e.amount, 0);
      if (spec.entries.some((e) => !Number.isInteger(e.amount) || e.amount < 0)) {
        throw new ValidationError("Exact split amounts must be zero or positive.");
      }
      if (sum !== total) {
        throw new ValidationError(
          `Exact amounts add up to ${(sum / 100).toFixed(2)} but the expense total is ${(total / 100).toFixed(2)}.`,
        );
      }
      shares = spec.entries.map((e) => ({ userId: e.userId, amount: e.amount }));
      break;
    }
    case "PERCENTAGE": {
      assertNoDuplicates(spec.entries.map((e) => e.userId));
      const sum = spec.entries.reduce((a, e) => a + e.percent, 0);
      if (Math.abs(sum - 100) > 0.01) {
        throw new ValidationError(`Percentages add up to ${sum}%, they must add up to 100%.`);
      }
      const parts = allocate(total, spec.entries.map((e) => e.percent));
      shares = spec.entries.map((e, i) => ({ userId: e.userId, amount: parts[i] }));
      break;
    }
    case "SHARES": {
      assertNoDuplicates(spec.entries.map((e) => e.userId));
      const parts = allocate(total, spec.entries.map((e) => e.shares));
      shares = spec.entries.map((e, i) => ({ userId: e.userId, amount: parts[i] }));
      break;
    }
    case "ITEMIZED": {
      if (spec.items.length === 0) throw new ValidationError("Add at least one item.");
      const itemsTotal = spec.items.reduce((a, it) => a + it.amount, 0);
      if (itemsTotal > total) {
        throw new ValidationError(
          `Items add up to ${(itemsTotal / 100).toFixed(2)}, which is more than the bill total ${(total / 100).toFixed(2)}.`,
        );
      }
      const subtotals = new Map<string, number>();
      for (const item of spec.items) {
        const ids = dedupe(item.userIds);
        if (ids.length === 0) throw new ValidationError("Every item needs at least one person.");
        const parts = allocate(item.amount, ids.map(() => 1));
        ids.forEach((id, i) => subtotals.set(id, (subtotals.get(id) ?? 0) + parts[i]));
      }
      // Tax, tip and service charge (bill total minus items) is shared in proportion to what each person ordered.
      const ids = [...subtotals.keys()];
      const extra = total - itemsTotal;
      const extraParts =
        extra > 0 && itemsTotal > 0 ? allocate(extra, ids.map((id) => subtotals.get(id)!)) : ids.map(() => 0);
      shares = ids.map((userId, i) => ({ userId, amount: subtotals.get(userId)! + extraParts[i] }));
      break;
    }
  }

  return shares.filter((s) => s.amount > 0);
}

/** Rescales existing shares to a new total, keeping everyone's proportion. */
export function rescaleShares(shares: Share[], newTotal: number): Share[] {
  const parts = allocate(newTotal, shares.map((s) => s.amount));
  return shares.map((s, i) => ({ userId: s.userId, amount: parts[i] })).filter((s) => s.amount > 0);
}
