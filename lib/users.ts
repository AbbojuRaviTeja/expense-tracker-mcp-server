import { prisma } from "../db";
import { getDefaults } from "./config";
import { NotFoundError, ValidationError } from "./errors";

export interface UserContext {
  id: string;
  email: string;
  name: string | null;
  timezone: string;
  defaultCurrency: string;
}

export async function loadUser(userId: string): Promise<UserContext> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, timezone: true, defaultCurrency: true },
  });
  if (!user) throw new NotFoundError("Your user profile could not be found. Please sign in again.");
  return user;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Resolves emails (or "me") to user ids, creating INVITED placeholders for people
 * who have not signed up yet. Returns ids in input order with duplicates removed.
 */
export async function resolveParticipants(me: UserContext, emails: string[]): Promise<{ id: string; email: string; created: boolean }[]> {
  const seen = new Set<string>();
  const result: { id: string; email: string; created: boolean }[] = [];
  const defaults = getDefaults();

  for (const raw of emails) {
    const email = raw.trim().toLowerCase() === "me" ? me.email : normalizeEmail(raw);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new ValidationError(`"${raw}" is not a valid email address.`);
    }
    if (seen.has(email)) continue;
    seen.add(email);

    if (email === me.email) {
      result.push({ id: me.id, email, created: false });
      continue;
    }
    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) {
      result.push({ id: existing.id, email, created: false });
      continue;
    }
    const user = await prisma.user.upsert({
      where: { email },
      update: {},
      create: { email, status: "INVITED", timezone: defaults.timezone, defaultCurrency: defaults.currency },
      select: { id: true },
    });
    result.push({ id: user.id, email, created: true });
  }
  return result;
}

export async function findUserByEmail(email: string) {
  const user = await prisma.user.findUnique({ where: { email: normalizeEmail(email) } });
  if (!user) throw new NotFoundError(`No user found with email ${email}.`);
  return user;
}

export async function assertGroupMember(groupId: string, userId: string) {
  const membership = await prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId, userId } },
  });
  if (!membership) throw new NotFoundError("Group not found, or you are not a member of it.");
}
