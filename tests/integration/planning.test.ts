import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  addExpense,
  addFriend,
  addRecurringExpense,
  cancelRecurringExpense,
  deleteBudget,
  getBudgetStatus,
  materializeRecurring,
  setBudget,
  updateMySettings,
} from "../../tools";
import { resolveUser } from "../../lib/resolve-user";
import { hasDb, makeUser, prisma, resetDb } from "./helpers";

const fakeJwt = (payload: object) =>
  `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.c2ln`;

describe.skipIf(!hasDb)("budgets, recurring, settings, sign-in (real Postgres)", () => {
  let alice: Awaited<ReturnType<typeof makeUser>>;
  let bob: Awaited<ReturnType<typeof makeUser>>;

  beforeEach(async () => {
    await resetDb();
    [alice, bob] = [await makeUser("Alice"), await makeUser("Bob")];
  });
  afterAll(async () => {
    if (hasDb) await resetDb();
  });

  it("budget alerts fire at 80% and when exceeded", async () => {
    await setBudget({ category: "Food", amount: 1000, period: "monthly" }, alice.id);
    const first = await addExpense({ amount: 850, category: "food" }, alice.id);
    expect(first.budgetAlerts?.[0]).toMatch(/used 85% of your monthly food budget/);

    const second = await addExpense({ amount: 300, category: "food" }, alice.id);
    expect(second.budgetAlerts?.[0]).toMatch(/Over budget/);

    const status = await getBudgetStatus(alice.id);
    expect(status.budgets[0]).toMatchObject({ category: "food", status: "exceeded", percentUsed: 115 });

    await expect(deleteBudget({ id: status.budgets[0].id }, bob.id)).rejects.toThrow(/not found/);
    await deleteBudget({ id: status.budgets[0].id }, alice.id);
  });

  it("budgets count only your share of a split expense", async () => {
    await setBudget({ amount: 1000, period: "monthly" }, alice.id); // overall
    const res = await addExpense({ amount: 1600, category: "food", splitWith: [bob.email] }, alice.id);
    expect(res.budgetAlerts?.[0]).toMatch(/80% of your overall monthly budget/);
  });

  it("recurring expenses back-fill, clamp month ends, and never duplicate under concurrency", async () => {
    const created = await addRecurringExpense(
      { amount: 15000, category: "rent", frequency: "monthly", startDate: "2099-01-31", splitWith: [bob.email] },
      alice.id,
    );
    expect(created.recurring.occurrencesCreated).toBe(0);

    const now = new Date("2099-04-15T00:00:00Z");
    const [a, b] = await Promise.all([materializeRecurring(alice.id, now), materializeRecurring(alice.id, now)]);
    expect(a + b).toBe(3);

    const rows = await prisma.expense.findMany({ where: { recurringExpenseId: created.recurring.id }, orderBy: { date: "asc" } });
    expect(rows.map((r) => r.date.toISOString().slice(0, 10))).toEqual(["2099-01-31", "2099-02-28", "2099-03-31"]);
    expect(await prisma.expenseSplit.count({ where: { expenseId: rows[0].id } })).toBe(2);

    await cancelRecurringExpense({ id: created.recurring.id }, alice.id);
    expect(await materializeRecurring(alice.id, new Date("2099-12-31T00:00:00Z"))).toBe(0);
  });

  it("validates time zones in settings", async () => {
    await expect(updateMySettings({ timezone: "Mars/Olympus" }, alice.id)).rejects.toThrow(/not a valid IANA/);
    const res = await updateMySettings({ timezone: "America/New_York", defaultCurrency: "usd" }, alice.id);
    expect(res.profile).toMatchObject({ timezone: "America/New_York", defaultCurrency: "USD" });
  });

  it("an invited friend's account is activated when they sign in with Google", async () => {
    await addFriend({ email: "newbie@test.dev", sendInvite: true }, alice.id);
    await addExpense({ amount: 100, category: "food", splitWith: ["newbie@test.dev"] }, alice.id);

    const user = await resolveUser({
      idToken: fakeJwt({ sub: "google-newbie", email: "newbie@test.dev", email_verified: true, name: "Newbie" }),
    });
    expect(user).toMatchObject({ status: "ACTIVE", name: "Newbie" });
    expect(await prisma.expenseSplit.count({ where: { userId: user.id } })).toBe(1);
  });
});
