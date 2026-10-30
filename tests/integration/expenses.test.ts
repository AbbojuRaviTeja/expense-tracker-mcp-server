import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  addExpense,
  createGroup,
  deleteExpense,
  exportExpensesCsv,
  getExpensesByCategory,
  getSummary,
  importExpenses,
  listExpenses,
  updateExpense,
} from "../../tools";
import { hasDb, makeUser, prisma, resetDb } from "./helpers";

const listDefaults = { scope: "involved" as const, limit: 50, offset: 0 };

describe.skipIf(!hasDb)("expenses (real Postgres)", () => {
  let alice: Awaited<ReturnType<typeof makeUser>>;
  let bob: Awaited<ReturnType<typeof makeUser>>;
  let carol: Awaited<ReturnType<typeof makeUser>>;

  beforeEach(async () => {
    await resetDb();
    [alice, bob, carol] = [await makeUser("Alice"), await makeUser("Bob"), await makeUser("Carol")];
  });
  afterAll(async () => {
    if (hasDb) await resetDb();
  });

  it("equal split stores exact paise and every share adds up to the total", async () => {
    const res = await addExpense(
      { amount: 100, category: "Food", date: "2026-10-30", splitWith: [bob.email, carol.email] },
      alice.id,
    );
    expect(res.expense.shares!.map((s) => s.amount)).toEqual([33.34, 33.33, 33.33]);
    const rows = await prisma.expenseSplit.findMany({ where: { expenseId: res.expense.id } });
    expect(rows.reduce((a, r) => a + r.amount, 0)).toBe(10000);
    expect(res.expense.category).toBe("food");
  });

  it("summary counts only your share, and includes expenses a friend paid for you", async () => {
    await addExpense({ amount: 3000, category: "food", date: "2026-10-10", splitWith: [bob.email, carol.email] }, alice.id);
    await addExpense({ amount: 600, category: "Taxi", date: "2026-10-11", splitWith: [alice.email] }, bob.id);

    const mine = await getSummary({ startDate: "2026-10-01", endDate: "2026-10-31" }, alice.id);
    const inr = mine.currencies.find((c) => c.currency === "INR")!;
    expect(inr.categories).toEqual([
      { category: "food", total: 1000, count: 1, percent: 76.9 },
      { category: "taxi", total: 300, count: 1, percent: 23.1 },
    ]);
  });

  it("splitting with yourself or duplicate emails does not double-charge anyone", async () => {
    const res = await addExpense(
      { amount: 90, category: "fun", splitWith: [alice.email, bob.email, bob.email.toUpperCase(), "me"] },
      alice.id,
    );
    expect(res.expense.shares).toHaveLength(2);
    expect(res.expense.shares!.map((s) => s.amount)).toEqual([45, 45]);
  });

  it("exact, percentage and itemized splits", async () => {
    const exact = await addExpense(
      { amount: 1000, category: "rent", splitType: "exact", splits: [{ email: "me", amount: 700 }, { email: bob.email, amount: 300 }] },
      alice.id,
    );
    expect(exact.expense.shares!.map((s) => s.amount)).toEqual([700, 300]);

    await expect(
      addExpense(
        { amount: 1000, category: "rent", splitType: "percentage", splits: [{ email: "me", percent: 50 }, { email: bob.email, percent: 40 }] },
        alice.id,
      ),
    ).rejects.toThrow(/100%/);

    const receipt = await addExpense(
      {
        amount: 660,
        category: "restaurant",
        splitType: "itemized",
        items: [
          { description: "pizza", amount: 300, sharedBy: ["me"] },
          { description: "soda", amount: 100, sharedBy: [bob.email] },
          { description: "starter", amount: 200, sharedBy: ["me", bob.email] },
        ],
      },
      alice.id,
    );
    expect(receipt.expense.splitType).toBe("ITEMIZED");
    expect(receipt.expense.shares!.map((s) => s.amount)).toEqual([440, 220]);
  });

  it("group expenses: auto-split among members, and non-members are blocked", async () => {
    const { group } = await createGroup({ name: "Goa", memberEmails: [bob.email, alice.email] }, alice.id);
    expect(group.members).toHaveLength(2); // own email in the list no longer crashes

    const res = await addExpense({ amount: 500, category: "hotel", groupId: group.id }, alice.id);
    expect(res.expense.shares).toHaveLength(2);

    await expect(addExpense({ amount: 10, category: "x", groupId: group.id }, carol.id)).rejects.toThrow(/not a member/);
    await expect(
      addExpense({ amount: 10, category: "x", groupId: group.id, splitWith: [carol.email] }, alice.id),
    ).rejects.toThrow(/not in this group/);
  });

  it("updating the amount rescales shares; only the payer can edit or delete", async () => {
    const { expense } = await addExpense({ amount: 900, category: "food", splitWith: [bob.email, carol.email] }, alice.id);
    const updated = await updateExpense({ id: expense.id, amount: 1200 }, alice.id);
    expect(updated.expense.shares!.map((s) => s.amount)).toEqual([400, 400, 400]);

    await expect(updateExpense({ id: expense.id, amount: 1 }, bob.id)).rejects.toThrow(/Only the person who paid/);
    await expect(deleteExpense({ id: expense.id }, bob.id)).rejects.toThrow(/Only the person who paid/);
    await expect(deleteExpense({ id: expense.id }, (await makeUser("Mallory")).id)).rejects.toThrow(/not found/);

    await deleteExpense({ id: expense.id }, alice.id);
    expect(await prisma.expenseSplit.count({ where: { expenseId: expense.id } })).toBe(0);
  });

  it("lists involved expenses with paging and finds categories case-insensitively", async () => {
    for (let i = 1; i <= 3; i++) await addExpense({ amount: i * 10, category: "Coffee", date: `2026-10-0${i}` }, alice.id);
    await addExpense({ amount: 50, category: "snacks", splitWith: [alice.email] }, bob.id);

    const page1 = await listExpenses({ ...listDefaults, limit: 2 }, alice.id);
    expect(page1.total).toBe(4);
    expect(page1.items).toHaveLength(2);
    expect(page1.nextOffset).toBe(2);

    const coffee = await getExpensesByCategory({ category: "COFFEE", limit: 50, offset: 0 }, alice.id);
    expect(coffee.total).toBe(3);
    expect(coffee.yourShareTotal).toBe(60);
  });

  it("imports in bulk, skips duplicates, and exports safe CSV", async () => {
    const rows = [
      { amount: 120, category: "groceries", description: "=HYPERLINK(evil)", date: "2026-10-01" },
      { amount: 80, category: "fuel", date: "2026-10-02" },
    ];
    expect((await importExpenses({ expenses: rows, skipDuplicates: true }, alice.id)).imported).toBe(2);
    const again = await importExpenses({ expenses: rows, skipDuplicates: true }, alice.id);
    expect(again).toMatchObject({ imported: 0, skipped: 2 });

    const csv = await exportExpensesCsv({ startDate: "2026-10-01", endDate: "2026-10-31" }, alice.id);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("date,description,category,currency,total,paid_by,your_share,group,split_type,id");
    expect(lines).toHaveLength(3);
    expect(csv).toContain("'=HYPERLINK(evil)");
  });
});
