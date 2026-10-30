import type { z } from "zod";
import { prisma } from "../db";
import { getDefaults } from "../lib/config";
import { sendEmail } from "../lib/notify";
import { loadUser, money, normalizeEmail, pairwiseBalances, ValidationError } from "../lib";
import type { addFriendSchema } from "../types";
import { personalLedger } from "./ledger";

export async function addFriend(args: z.infer<typeof addFriendSchema>, currentUserId: string) {
  const me = await loadUser(currentUserId);
  const email = normalizeEmail(args.email);
  if (email === me.email) throw new ValidationError("You cannot add yourself as a friend.");

  const defaults = getDefaults();
  const existingUser = await prisma.user.findUnique({ where: { email } });
  const friend =
    existingUser ??
    (await prisma.user.create({
      data: { email, status: "INVITED", timezone: defaults.timezone, defaultCurrency: defaults.currency },
    }));

  const existing = await prisma.friendship.findFirst({
    where: {
      OR: [
        { requesterId: me.id, addresseeId: friend.id },
        { requesterId: friend.id, addresseeId: me.id },
      ],
    },
  });
  if (existing) {
    return { message: `${friend.name ?? email} is already your friend.`, friend: { id: friend.id, name: friend.name, email } };
  }

  await prisma.friendship.create({ data: { requesterId: me.id, addresseeId: friend.id } });

  let invite: { sent: boolean; reason?: string } | undefined;
  if (friend.status === "INVITED" && args.sendInvite) {
    invite = await sendEmail(
      email,
      `${me.name ?? me.email} added you on Expense Tracker`,
      `${me.name ?? me.email} wants to split expenses with you.\n\n` +
        `Connect the Expense Tracker MCP server to your AI assistant and sign in with Google as ${email} ` +
        `to see what you share.\n\n${process.env.BASE_URL ?? ""}`,
    );
  }

  return {
    message:
      friend.status === "INVITED"
        ? `${email} has not joined yet. Their shares will be waiting for them when they sign in.`
        : `${friend.name ?? email} added as a friend.`,
    friend: { id: friend.id, name: friend.name, email, status: friend.status },
    ...(invite && { inviteEmail: invite }),
  };
}

export async function listFriends(currentUserId: string) {
  const me = await loadUser(currentUserId);
  const [friendships, ledger] = await Promise.all([
    prisma.friendship.findMany({
      where: { OR: [{ requesterId: me.id }, { addresseeId: me.id }] },
      include: {
        requester: { select: { id: true, name: true, email: true, status: true } },
        addressee: { select: { id: true, name: true, email: true, status: true } },
      },
    }),
    personalLedger(me.id),
  ]);
  const balances = pairwiseBalances(me.id, ledger.splits, ledger.settlements);

  return friendships
    .map((f) => (f.requesterId === me.id ? f.addressee : f.requester))
    .sort((a, b) => (a.name ?? a.email).localeCompare(b.name ?? b.email))
    .map((friend) => ({
      ...friend,
      balances: [...(balances.get(friend.id) ?? new Map<string, number>())]
        .filter(([, v]) => v !== 0)
        .map(([currency, v]) => ({
          ...money(Math.abs(v), currency),
          direction: v > 0 ? "owes you" : "you owe",
        })),
    }));
}
