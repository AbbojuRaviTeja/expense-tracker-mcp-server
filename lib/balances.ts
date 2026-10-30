export interface LedgerSplit {
  /** the person whose share this is */
  userId: string;
  amount: number;
  payerId: string;
  currency: string;
}

export interface LedgerSettlement {
  payerId: string;
  payeeId: string;
  amount: number;
  currency: string;
}

export interface Transfer {
  from: string;
  to: string;
  amount: number;
  currency: string;
}

/**
 * Net position of every user per currency.
 * Positive = the group owes them money, negative = they owe the group.
 */
export function netPositions(
  splits: LedgerSplit[],
  settlements: LedgerSettlement[],
): Map<string, Map<string, number>> {
  const net = new Map<string, Map<string, number>>();
  const add = (currency: string, userId: string, delta: number) => {
    let byUser = net.get(currency);
    if (!byUser) net.set(currency, (byUser = new Map()));
    byUser.set(userId, (byUser.get(userId) ?? 0) + delta);
  };

  for (const s of splits) {
    if (s.userId === s.payerId) continue;
    add(s.currency, s.payerId, s.amount);
    add(s.currency, s.userId, -s.amount);
  }
  for (const p of settlements) {
    add(p.currency, p.payerId, p.amount);
    add(p.currency, p.payeeId, -p.amount);
  }
  return net;
}

/**
 * Greedy debt simplification: repeatedly settles the largest debtor against the
 * largest creditor. Produces at most n-1 transfers per currency.
 */
export function simplifyDebts(net: Map<string, Map<string, number>>): Transfer[] {
  const transfers: Transfer[] = [];
  for (const [currency, byUser] of net) {
    const creditors = [...byUser].filter(([, v]) => v > 0).map(([id, v]) => ({ id, v }));
    const debtors = [...byUser].filter(([, v]) => v < 0).map(([id, v]) => ({ id, v: -v }));
    creditors.sort((a, b) => b.v - a.v || a.id.localeCompare(b.id));
    debtors.sort((a, b) => b.v - a.v || a.id.localeCompare(b.id));

    let i = 0;
    let j = 0;
    while (i < debtors.length && j < creditors.length) {
      const amount = Math.min(debtors[i].v, creditors[j].v);
      if (amount > 0) transfers.push({ from: debtors[i].id, to: creditors[j].id, amount, currency });
      debtors[i].v -= amount;
      creditors[j].v -= amount;
      if (debtors[i].v === 0) i++;
      if (creditors[j].v === 0) j++;
    }
  }
  return transfers;
}

/**
 * Pairwise balance between `me` and every other person, per currency.
 * Positive = they owe me, negative = I owe them.
 */
export function pairwiseBalances(
  me: string,
  splits: LedgerSplit[],
  settlements: LedgerSettlement[],
): Map<string, Map<string, number>> {
  const result = new Map<string, Map<string, number>>();
  const add = (other: string, currency: string, delta: number) => {
    let byCurrency = result.get(other);
    if (!byCurrency) result.set(other, (byCurrency = new Map()));
    byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + delta);
  };

  for (const s of splits) {
    if (s.userId === s.payerId) continue;
    if (s.payerId === me) add(s.userId, s.currency, s.amount);
    else if (s.userId === me) add(s.payerId, s.currency, -s.amount);
  }
  for (const p of settlements) {
    if (p.payerId === me) add(p.payeeId, p.currency, p.amount);
    else if (p.payeeId === me) add(p.payerId, p.currency, -p.amount);
  }
  return result;
}
