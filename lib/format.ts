import { formatZonedDate } from "./dates";
import { formatMoney, fromMinor } from "./money";

interface PersonLike {
  id: string;
  email: string;
  name: string | null;
}

export function person(u: PersonLike) {
  return { id: u.id, name: u.name, email: u.email };
}

export function money(minor: number, currency: string) {
  return { amount: fromMinor(minor), currency, display: formatMoney(minor, currency) };
}

interface ExpenseLike {
  id: string;
  amount: number;
  currency: string;
  category: string;
  description: string | null;
  date: Date;
  splitType: string;
  groupId: string | null;
  payerId: string;
  payer?: PersonLike;
  group?: { id: string; name: string } | null;
  splits?: { userId: string; amount: number; user?: PersonLike }[];
}

/** Expense as returned to the AI: major-unit amounts and dates in the user's zone. */
export function formatExpense(e: ExpenseLike, tz: string, viewerId?: string) {
  const myShare = viewerId ? e.splits?.find((s) => s.userId === viewerId)?.amount : undefined;
  return {
    id: e.id,
    date: formatZonedDate(e.date, tz),
    category: e.category,
    description: e.description,
    total: fromMinor(e.amount),
    currency: e.currency,
    display: formatMoney(e.amount, e.currency),
    splitType: e.splitType,
    paidBy: e.payer ? person(e.payer) : { id: e.payerId },
    group: e.group ? { id: e.group.id, name: e.group.name } : e.groupId ? { id: e.groupId } : null,
    ...(myShare !== undefined ? { myShare: fromMinor(myShare) } : {}),
    shares: e.splits?.map((s) => ({
      ...(s.user ? person(s.user) : { id: s.userId }),
      amount: fromMinor(s.amount),
    })),
  };
}

export const MAX_PAGE_SIZE = 200;

export function page<T>(items: T[], total: number, limit: number, offset: number) {
  return {
    items,
    total,
    limit,
    offset,
    hasMore: offset + items.length < total,
    ...(offset + items.length < total ? { nextOffset: offset + items.length } : {}),
  };
}
