import type { z } from "zod";
import { prisma } from "../db";
import {
  assertGroupMember,
  loadUser,
  money,
  netPositions,
  resolveParticipants,
  simplifyDebts,
} from "../lib";
import type { addGroupMemberSchema, createGroupSchema, groupIdSchema } from "../types";
import { personSelect } from "./expense-service";
import { groupLedger } from "./ledger";

export async function createGroup(args: z.infer<typeof createGroupSchema>, currentUserId: string) {
  const me = await loadUser(currentUserId);
  const others = (await resolveParticipants(me, args.memberEmails)).filter((p) => p.id !== me.id);

  const group = await prisma.group.create({
    data: {
      name: args.name,
      createdById: me.id,
      members: { create: [{ userId: me.id }, ...others.map((p) => ({ userId: p.id }))] },
    },
    include: { members: { include: { user: { select: personSelect } } } },
  });
  return {
    message: `Group "${group.name}" created with ${group.members.length} member(s).`,
    group: { id: group.id, name: group.name, members: group.members.map((m) => m.user) },
    ...(others.some((p) => p.created) && { newlyInvited: others.filter((p) => p.created).map((p) => p.email) }),
  };
}

export async function listGroups(currentUserId: string) {
  const groups = await prisma.group.findMany({
    where: { members: { some: { userId: currentUserId } } },
    include: {
      members: { include: { user: { select: personSelect } } },
      _count: { select: { expenses: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    createdAt: g.createdAt,
    expenseCount: g._count.expenses,
    members: g.members.map((m) => m.user),
  }));
}

export async function addGroupMember(args: z.infer<typeof addGroupMemberSchema>, currentUserId: string) {
  const me = await loadUser(currentUserId);
  await assertGroupMember(args.groupId, me.id);
  const [person] = await resolveParticipants(me, [args.email]);

  const existing = await prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId: args.groupId, userId: person.id } },
  });
  if (existing) return { message: `${person.email} is already in this group.` };

  await prisma.groupMember.create({ data: { groupId: args.groupId, userId: person.id } });
  return {
    message: person.created
      ? `${person.email} was invited and added to the group.`
      : `${person.email} added to the group.`,
  };
}

/** Each member's net position in the group, plus the fewest payments that would settle everyone. */
export async function getGroupBalances(args: z.infer<typeof groupIdSchema>, currentUserId: string) {
  await assertGroupMember(args.groupId, currentUserId);
  const [group, ledger] = await Promise.all([
    prisma.group.findUniqueOrThrow({
      where: { id: args.groupId },
      include: { members: { include: { user: { select: personSelect } } } },
    }),
    groupLedger(args.groupId),
  ]);

  const net = netPositions(ledger.splits, ledger.settlements);
  const transfers = simplifyDebts(net);

  const people = new Map(group.members.map((m) => [m.user.id, m.user]));
  const missing = [...new Set([...transfers.flatMap((t) => [t.from, t.to])])].filter((id) => !people.has(id));
  if (missing.length > 0) {
    for (const u of await prisma.user.findMany({ where: { id: { in: missing } }, select: personSelect })) people.set(u.id, u);
  }
  const label = (id: string) => (id === currentUserId ? "you" : people.get(id)?.name ?? people.get(id)?.email ?? id);

  return {
    group: { id: group.id, name: group.name },
    members: group.members.map((m) => ({
      ...m.user,
      balances: [...net]
        .map(([currency, byUser]) => ({ currency, net: byUser.get(m.user.id) ?? 0 }))
        .filter((b) => b.net !== 0)
        .map((b) => ({ ...money(Math.abs(b.net), b.currency), direction: b.net > 0 ? "is owed" : "owes" })),
    })),
    suggestedPayments: transfers.map((t) => ({
      from: label(t.from),
      to: label(t.to),
      ...money(t.amount, t.currency),
    })),
    note:
      transfers.length === 0
        ? "Everyone in this group is settled up."
        : "suggestedPayments is the smallest set of payments that settles the whole group.",
  };
}
