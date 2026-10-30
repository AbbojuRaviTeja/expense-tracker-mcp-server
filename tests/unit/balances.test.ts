import { describe, expect, it } from "vitest";
import { netPositions, pairwiseBalances, simplifyDebts } from "../../lib/balances";

describe("balances", () => {
  // A paid 300 for A, B, C. B paid 150 for B and C.
  const splits = [
    { userId: "A", amount: 100, payerId: "A", currency: "INR" },
    { userId: "B", amount: 100, payerId: "A", currency: "INR" },
    { userId: "C", amount: 100, payerId: "A", currency: "INR" },
    { userId: "B", amount: 75, payerId: "B", currency: "INR" },
    { userId: "C", amount: 75, payerId: "B", currency: "INR" },
  ];

  it("net positions sum to zero", () => {
    const net = netPositions(splits, []).get("INR")!;
    expect(net.get("A")).toBe(200);
    expect(net.get("B")).toBe(-25);
    expect(net.get("C")).toBe(-175);
    expect([...net.values()].reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("simplifies to the fewest transfers", () => {
    const transfers = simplifyDebts(netPositions(splits, []));
    expect(transfers).toEqual([
      { from: "C", to: "A", amount: 175, currency: "INR" },
      { from: "B", to: "A", amount: 25, currency: "INR" },
    ]);
  });

  it("confirmed payments reduce what is owed", () => {
    const net = netPositions(splits, [{ payerId: "C", payeeId: "A", amount: 175, currency: "INR" }]);
    expect(simplifyDebts(net)).toEqual([{ from: "B", to: "A", amount: 25, currency: "INR" }]);
  });

  it("pairwise balance from A's point of view", () => {
    const b = pairwiseBalances("A", splits, [{ payerId: "B", payeeId: "A", amount: 40, currency: "INR" }]);
    expect(b.get("B")?.get("INR")).toBe(60);
    expect(b.get("C")?.get("INR")).toBe(100);
  });

  it("keeps currencies separate", () => {
    const net = netPositions(
      [
        { userId: "B", amount: 500, payerId: "A", currency: "INR" },
        { userId: "A", amount: 10, payerId: "B", currency: "USD" },
      ],
      [],
    );
    expect(simplifyDebts(net)).toEqual([
      { from: "B", to: "A", amount: 500, currency: "INR" },
      { from: "A", to: "B", amount: 10, currency: "USD" },
    ]);
  });
});
