import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  addExpense,
  createGroup,
  getBalances,
  getGroupBalances,
  getSplitHistory,
  listFriends,
  listPendingPayments,
  respondToPayment,
  settleUp,
} from "../../tools";
import { hasDb, makeUser, resetDb } from "./helpers";

describe.skipIf(!hasDb)("balances and payments (real Postgres)", () => {
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

  it("nets balances across expenses in both directions", async () => {
    await addExpense({ amount: 900, category: "food", splitWith: [bob.email] }, alice.id); // bob owes 450
    await addExpense({ amount: 200, category: "taxi", splitWith: [alice.email] }, bob.id); // alice owes 100

    const b = await getBalances({ friendEmail: bob.email }, alice.id);
    expect(b.summary).toEqual([
      expect.objectContaining({ currency: "INR", owedToYou: 350, youOwe: 0, net: 350 }),
    ]);
    const friends = await listFriends(alice.id);
    expect(friends[0]).toMatchObject({ email: bob.email, balances: [expect.objectContaining({ amount: 350, direction: "owes you" })] });
  });

  it("a stranger cannot settle someone else's debt", async () => {
    await addExpense({ amount: 900, category: "food", splitWith: [bob.email] }, alice.id);
    const res = await settleUp({ friendEmail: bob.email }, carol.id);
    expect(res.message).toMatch(/already settled up/);
    const b = await getBalances({ friendEmail: bob.email }, alice.id);
    expect(b.summary[0].owedToYou).toBe(450);
  });

  it("creditor-recorded payments confirm immediately; partial payments and overpayment checks", async () => {
    await addExpense({ amount: 900, category: "food", splitWith: [bob.email] }, alice.id);

    await expect(settleUp({ friendEmail: bob.email, amount: 500 }, alice.id)).rejects.toThrow(/more than the outstanding/);
    const partial = await settleUp({ friendEmail: bob.email, amount: 200 }, alice.id);
    expect(partial).toMatchObject({ status: "confirmed", remainingBalance: expect.objectContaining({ amount: 250 }) });

    const b = await getBalances({ friendEmail: bob.email }, alice.id);
    expect(b.summary[0].owedToYou).toBe(250);
  });

  it("debtor-recorded payments wait for the creditor, and only the creditor can confirm", async () => {
    await addExpense({ amount: 900, category: "food", splitWith: [bob.email] }, alice.id);

    const paid = await settleUp({ friendEmail: alice.email }, bob.id);
    expect(paid).toMatchObject({ status: "pending" });
    expect((await getBalances({ friendEmail: bob.email }, alice.id)).summary[0].owedToYou).toBe(450);

    // Recording again does not double count: the pending payment already covers it.
    expect((await settleUp({ friendEmail: alice.email }, bob.id)).message).toMatch(/Waiting for/);

    await expect(respondToPayment({ paymentId: paid.paymentId!, action: "confirm" }, bob.id)).rejects.toThrow(/No pending payment/);
    await expect(respondToPayment({ paymentId: paid.paymentId!, action: "confirm" }, carol.id)).rejects.toThrow(/No pending payment/);

    const pending = await listPendingPayments(alice.id);
    expect(pending.awaitingYourConfirmation).toHaveLength(1);

    await respondToPayment({ paymentId: paid.paymentId!, action: "confirm" }, alice.id);
    const after = await getBalances({ friendEmail: bob.email }, alice.id);
    expect(after.message).toMatch(/settled up/);

    const history = await getSplitHistory({ friendEmail: bob.email, limit: 50, offset: 0 }, alice.id);
    expect(history.expenses.items[0].effect).toBe("you lent INR 450.00");
    expect(history.payments[0]).toMatchObject({ from: "Bob", to: "you", status: "confirmed" });
  });

  it("group balances suggest the fewest payments", async () => {
    const { group } = await createGroup({ name: "Trip", memberEmails: [bob.email, carol.email] }, alice.id);
    await addExpense({ amount: 300, category: "hotel", groupId: group.id }, alice.id);
    await addExpense({ amount: 150, category: "food", groupId: group.id, splitWith: [carol.email] }, bob.id);

    const res = await getGroupBalances({ groupId: group.id }, bob.id);
    expect(res.suggestedPayments).toEqual([
      expect.objectContaining({ from: "Carol", to: "Alice", amount: 175 }),
      expect.objectContaining({ from: "you", to: "Alice", amount: 25 }),
    ]);
    await expect(getGroupBalances({ groupId: group.id }, (await makeUser("Eve")).id)).rejects.toThrow(/not a member/);
  });
});
