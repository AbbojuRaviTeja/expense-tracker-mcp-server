import { describe, expect, it } from "vitest";
import { redact } from "../../lib/logger";
import { RateLimiter } from "../../lib/rate-limit";
import { identityFromSession } from "../../lib/resolve-user";
import { normalizeCategory } from "../../lib/categories";

const fakeJwt = (payload: object) =>
  `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.c2ln`;

describe("log redaction", () => {
  it("removes tokens by key and JWT-looking strings anywhere", () => {
    const out = redact({
      accessToken: "ya29.secret",
      idToken: fakeJwt({ sub: "1" }),
      nested: { refresh_token: "r", note: `token is ${fakeJwt({ a: 1 })}` },
      headers: { authorization: "Bearer abc" },
      email: "a@b.com",
    }) as Record<string, any>;
    expect(out.accessToken).toBe("[redacted]");
    expect(out.idToken).toBe("[redacted]");
    expect(out.nested.refresh_token).toBe("[redacted]");
    expect(out.nested.note).toBe("token is [redacted-jwt]");
    expect(out.headers.authorization).toBe("[redacted]");
    expect(out.email).toBe("a@b.com");
  });
});

describe("rate limiter", () => {
  it("blocks after the limit within the window and recovers after it", () => {
    const rl = new RateLimiter(2, 1000);
    rl.check("u", 0);
    rl.check("u", 10);
    expect(() => rl.check("u", 20)).toThrow(/Too many requests/);
    expect(() => rl.check("other", 20)).not.toThrow();
    expect(() => rl.check("u", 1500)).not.toThrow();
  });
});

describe("identityFromSession", () => {
  it("reads identity from the id token", () => {
    const id = identityFromSession({ idToken: fakeJwt({ sub: "g1", email: "A@X.com", email_verified: true, name: "A" }) });
    expect(id).toEqual({ googleId: "g1", email: "a@x.com", name: "A" });
  });

  it("rejects unverified Google emails so they cannot claim an invited account", () => {
    expect(() => identityFromSession({ idToken: fakeJwt({ sub: "g1", email: "a@x.com", email_verified: false }) })).toThrow(
      /not verified/,
    );
  });

  it("rejects sessions without identity", () => {
    expect(() => identityFromSession({})).toThrow(/sign in again/);
  });
});

describe("normalizeCategory", () => {
  it("makes Food, food and ' FOOD ' the same category", () => {
    expect(normalizeCategory(" FOOD ")).toBe("food");
    expect(normalizeCategory("Eating   Out")).toBe("eating out");
  });
});
