import { decodeJwt } from "jose";
import { prisma } from "../db";
import { AppError } from "./errors";
import { getDefaults } from "./config";

/**
 * The session FastMCP hands to tools. It is built server-side from tokens the
 * OAuth proxy obtained directly from Google, never from client-supplied data.
 */
export interface GoogleSession {
  email?: string;
  idToken?: string;
  claims?: Record<string, unknown>;
}

export interface Identity {
  googleId: string;
  email: string;
  name?: string;
}

export function identityFromSession(session: GoogleSession): Identity {
  let claims: Record<string, unknown> | undefined = session.claims;
  if ((!claims || !claims.sub) && session.idToken) {
    try {
      claims = { ...decodeJwt(session.idToken), ...claims };
    } catch {
      throw new AppError("Your login session is invalid. Please sign in again.");
    }
  }

  const email = (session.email ?? (claims?.email as string | undefined))?.toLowerCase();
  const googleId = claims?.sub as string | undefined;
  if (!email || !googleId) {
    throw new AppError("Your login session is missing your Google identity. Please sign in again.");
  }
  // An unverified Google email must not be able to claim someone's invited placeholder.
  if (claims?.email_verified === false || claims?.email_verified === "false") {
    throw new AppError("Your Google email address is not verified. Verify it with Google and sign in again.");
  }
  return { googleId, email, name: (claims?.name as string | undefined) ?? undefined };
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { userId: string; expires: number }>();

/**
 * Finds or creates the database user for a Google identity. If someone was
 * invited by email before they signed up, their placeholder is activated so
 * expenses already shared with them appear immediately.
 */
export async function resolveUser(session: GoogleSession) {
  const identity = identityFromSession(session);

  const byGoogleId = await prisma.user.findUnique({ where: { googleId: identity.googleId } });
  if (byGoogleId) return byGoogleId;

  const defaults = getDefaults();
  return prisma.user.upsert({
    where: { email: identity.email },
    update: { googleId: identity.googleId, name: identity.name, status: "ACTIVE" },
    create: {
      googleId: identity.googleId,
      email: identity.email,
      name: identity.name,
      status: "ACTIVE",
      timezone: defaults.timezone,
      defaultCurrency: defaults.currency,
    },
  });
}

/** Same as resolveUser but cached briefly, since every tool call needs it. */
export async function resolveUserId(session: GoogleSession): Promise<string> {
  const { googleId } = identityFromSession(session);
  const hit = cache.get(googleId);
  if (hit && hit.expires > Date.now()) return hit.userId;
  const user = await resolveUser(session);
  cache.set(googleId, { userId: user.id, expires: Date.now() + CACHE_TTL_MS });
  return user.id;
}
