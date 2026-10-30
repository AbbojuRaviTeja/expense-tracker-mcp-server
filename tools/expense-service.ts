import type { Prisma, SplitType } from "@prisma/client";
import { prisma } from "../db";
import {
  computeShares,
  ForbiddenError,
  NotFoundError,
  normalizeEmail,
  resolveParticipants,
  toMinor,
  ValidationError,
  type Share,
  type SplitSpec,
  type UserContext,
} from "../lib";

export interface SplitInput {
  splitType?: "equal" | "exact" | "percentage" | "shares" | "itemized";
  splitWith?: string[];
  includeMe?: boolean;
  splits?: { email: string; amount?: number; percent?: number; shares?: number }[];
  items?: { description?: string; amount: number; sharedBy: string[] }[];
}

export const personSelect = { id: true, name: true, email: true } as const;

export const expenseInclude = {
  payer: { select: personSelect },
  group: { select: { id: true, name: true } },
  splits: { include: { user: { select: personSelect } }, orderBy: [{ amount: "desc" }, { id: "asc" }] },
} satisfies Prisma.ExpenseInclude;

export function hasSplitInput(input: SplitInput): boolean {
  return (
    input.splitType !== undefined ||
    input.splitWith !== undefined ||
    input.includeMe !== undefined ||
    input.splits !== undefined ||
    input.items !== undefined
  );
}

function inferSplitType(input: SplitInput): NonNullable<SplitInput["splitType"]> {
  if (input.splitType) return input.splitType;
  if (input.items?.length) return "itemized";
  const first = input.splits?.[0];
  if (first?.percent !== undefined) return "percentage";
  if (first?.shares !== undefined) return "shares";
  if (first?.amount !== undefined) return "exact";
  return "equal";
}

function assertUniqueEmails(me: UserContext, emails: string[]) {
  const normalized = emails.map((e) => (e.trim().toLowerCase() === "me" ? me.email : normalizeEmail(e)));
  if (new Set(normalized).size !== normalized.length) {
    throw new ValidationError("Each person can only appear once in `splits`.");
  }
}

export interface SharePlan {
  splitType: SplitType;
  shares: Share[];
  invitedEmails: string[];
}

/**
 * Validates the split request and turns it into exact integer shares.
 * The payer is always placed first so they absorb any leftover paisa.
 */
export async function planShares(
  me: UserContext,
  total: number,
  input: SplitInput,
  groupId?: string | null,
): Promise<SharePlan> {
  const type = inferSplitType(input);
  let groupMemberIds: Set<string> | undefined;

  if (groupId) {
    const members = await prisma.groupMember.findMany({ where: { groupId }, select: { userId: true } });
    groupMemberIds = new Set(members.map((m) => m.userId));
    if (!groupMemberIds.has(me.id)) throw new NotFoundError("Group not found, or you are not a member of it.");
  }

  const invitedEmails: string[] = [];
  const resolve = async (emails: string[]) => {
    const people = await resolveParticipants(me, emails);
    for (const p of people) if (p.created) invitedEmails.push(p.email);
    return people;
  };
  const meFirst = <T extends { userId: string }>(rows: T[]) =>
    [...rows].sort((a, b) => Number(b.userId === me.id) - Number(a.userId === me.id));

  let spec: SplitSpec;
  let splitType: SplitType;

  switch (type) {
    case "equal": {
      let ids: string[];
      if (input.splitWith && input.splitWith.length > 0) {
        ids = (await resolve(input.splitWith)).map((p) => p.id);
      } else if (groupMemberIds) {
        ids = [...groupMemberIds];
      } else {
        ids = [];
      }
      const others = ids.filter((id) => id !== me.id);
      const includeMe = input.includeMe ?? true;
      const participants = includeMe ? [me.id, ...others] : others;
      if (participants.length === 0) {
        throw new ValidationError("Nobody to split with: add people to splitWith, or keep includeMe true.");
      }
      spec = { type: "EQUAL", userIds: participants };
      splitType = "EQUAL";
      break;
    }
    case "exact":
    case "percentage":
    case "shares": {
      const rows = input.splits ?? [];
      if (rows.length === 0) throw new ValidationError(`A ${type} split needs per-person values in \`splits\`.`);
      assertUniqueEmails(me, rows.map((r) => r.email));
      const people = await resolve(rows.map((r) => r.email));
      const entries = rows.map((r, i) => ({ row: r, userId: people[i].id }));

      if (type === "exact") {
        if (entries.some((e) => e.row.amount === undefined)) throw new ValidationError("Every exact split entry needs an amount.");
        spec = { type: "EXACT", entries: meFirst(entries.map((e) => ({ userId: e.userId, amount: toMinor(e.row.amount!) }))) };
        splitType = "EXACT";
      } else if (type === "percentage") {
        if (entries.some((e) => e.row.percent === undefined)) throw new ValidationError("Every percentage split entry needs a percent.");
        spec = { type: "PERCENTAGE", entries: meFirst(entries.map((e) => ({ userId: e.userId, percent: e.row.percent! }))) };
        splitType = "PERCENTAGE";
      } else {
        if (entries.some((e) => e.row.shares === undefined)) throw new ValidationError("Every shares split entry needs a number of shares.");
        spec = { type: "SHARES", entries: meFirst(entries.map((e) => ({ userId: e.userId, shares: e.row.shares! }))) };
        splitType = "SHARES";
      }
      break;
    }
    case "itemized": {
      const items = input.items ?? [];
      if (items.length === 0) throw new ValidationError("An itemized split needs `items`.");
      const allEmails = items.flatMap((it) => it.sharedBy);
      const people = await resolve(allEmails);
      const idByEmail = new Map(people.map((p) => [p.email, p.id]));
      const idFor = (e: string) => idByEmail.get(e.trim().toLowerCase() === "me" ? me.email : normalizeEmail(e))!;
      spec = {
        type: "ITEMIZED",
        items: items.map((it) => ({ amount: toMinor(it.amount), userIds: it.sharedBy.map(idFor) })),
      };
      splitType = "ITEMIZED";
      break;
    }
  }

  const shares = computeShares(total, spec);

  if (groupMemberIds) {
    const outsiders = shares.filter((s) => !groupMemberIds!.has(s.userId)).map((s) => s.userId);
    if (outsiders.length > 0) {
      const users = await prisma.user.findMany({ where: { id: { in: outsiders } }, select: { email: true } });
      throw new ValidationError(
        `${users.map((u) => u.email).join(", ")} ${users.length === 1 ? "is" : "are"} not in this group. Add them with add-group-member first.`,
      );
    }
  }

  return { splitType, shares, invitedEmails };
}

/** Makes sure everyone you share an expense with shows up in your friends list. */
export async function ensureFriendships(meId: string, otherIds: string[]) {
  const others = [...new Set(otherIds.filter((id) => id !== meId))];
  if (others.length === 0) return;
  const existing = await prisma.friendship.findMany({
    where: {
      OR: [
        { requesterId: meId, addresseeId: { in: others } },
        { addresseeId: meId, requesterId: { in: others } },
      ],
    },
    select: { requesterId: true, addresseeId: true },
  });
  const known = new Set(existing.map((f) => (f.requesterId === meId ? f.addresseeId : f.requesterId)));
  const missing = others.filter((id) => !known.has(id));
  if (missing.length > 0) {
    await prisma.friendship.createMany({
      data: missing.map((addresseeId) => ({ requesterId: meId, addresseeId })),
      skipDuplicates: true,
    });
  }
}

export interface NewExpense {
  amount: number;
  currency: string;
  category: string;
  description?: string | null;
  date: Date;
  groupId?: string | null;
  splitType: SplitType;
  shares: Share[];
  recurringExpenseId?: string;
}

export async function createExpense(
  payerId: string,
  data: NewExpense,
  db: Prisma.TransactionClient | typeof prisma = prisma,
) {
  return db.expense.create({
    data: {
      amount: data.amount,
      currency: data.currency,
      category: data.category,
      description: data.description ?? null,
      date: data.date,
      splitType: data.splitType,
      payerId,
      groupId: data.groupId ?? null,
      recurringExpenseId: data.recurringExpenseId,
      splits: { create: data.shares.map((s) => ({ userId: s.userId, amount: s.amount })) },
    },
    include: expenseInclude,
  });
}

/** Loads an expense the current user is allowed to change (only the payer may). */
export async function loadOwnExpense(id: string, meId: string) {
  const expense = await prisma.expense.findUnique({ where: { id }, include: expenseInclude });
  if (!expense) throw new NotFoundError("Expense not found.");
  if (expense.payerId !== meId) {
    const involved = expense.splits.some((s) => s.userId === meId);
    if (!involved) throw new NotFoundError("Expense not found.");
    throw new ForbiddenError("Only the person who paid for this expense can change or delete it.");
  }
  return expense;
}
