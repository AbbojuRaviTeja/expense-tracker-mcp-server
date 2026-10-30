import type { z } from "zod";
import { prisma } from "../db";
import { isValidTimeZone, normalizeCurrency, ValidationError } from "../lib";
import type { updateSettingsSchema } from "../types";

const profileSelect = {
  id: true,
  email: true,
  name: true,
  status: true,
  timezone: true,
  defaultCurrency: true,
  createdAt: true,
} as const;

export async function getMyProfile(currentUserId: string) {
  const [user, counts] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: currentUserId }, select: profileSelect }),
    prisma.user.findUniqueOrThrow({
      where: { id: currentUserId },
      select: { _count: { select: { expenses: true, groupMemberships: true, budgets: true } } },
    }),
  ]);
  return {
    profile: user,
    stats: {
      expensesPaid: counts._count.expenses,
      groups: counts._count.groupMemberships,
      budgets: counts._count.budgets,
    },
    tip:
      user.timezone === "UTC"
        ? 'Your time zone is UTC. Set it with update-my-settings (e.g. "Asia/Kolkata") so "this month" matches your calendar.'
        : undefined,
  };
}

export async function updateMySettings(args: z.infer<typeof updateSettingsSchema>, currentUserId: string) {
  if (args.timezone && !isValidTimeZone(args.timezone)) {
    throw new ValidationError(`"${args.timezone}" is not a valid IANA time zone, e.g. "Asia/Kolkata".`);
  }
  const user = await prisma.user.update({
    where: { id: currentUserId },
    data: {
      ...(args.timezone && { timezone: args.timezone }),
      ...(args.defaultCurrency && { defaultCurrency: normalizeCurrency(args.defaultCurrency, "INR") }),
      ...(args.name && { name: args.name }),
    },
    select: profileSelect,
  });
  return { message: "Settings updated.", profile: user };
}
