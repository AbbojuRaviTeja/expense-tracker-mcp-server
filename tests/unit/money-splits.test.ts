import { describe, expect, it } from "vitest";
import { allocate, toMinor } from "../../lib/money";
import { computeShares, rescaleShares } from "../../lib/splits";

const sum = (xs: { amount: number }[]) => xs.reduce((a, x) => a + x.amount, 0);

describe("money", () => {
  it("converts rupees to paise without float drift", () => {
    expect(toMinor(0.29)).toBe(29);
    expect(toMinor(1234.56)).toBe(123456);
    expect(() => toMinor(1.005)).toThrow(/2 decimal/);
  });

  it("allocate never loses a paisa", () => {
    expect(allocate(10000, [1, 1, 1])).toEqual([3334, 3333, 3333]);
    expect(allocate(100, [1, 1, 1, 1, 1, 1, 1])).toEqual([15, 15, 14, 14, 14, 14, 14]);
    for (let total = 1; total < 500; total += 37) {
      expect(allocate(total, [3, 1, 2]).reduce((a, b) => a + b, 0)).toBe(total);
    }
  });
});

describe("computeShares", () => {
  it("equal: ₹100 three ways is 33.34 + 33.33 + 33.33, payer absorbs the extra paisa", () => {
    const s = computeShares(10000, { type: "EQUAL", userIds: ["payer", "b", "c"] });
    expect(s).toEqual([
      { userId: "payer", amount: 3334 },
      { userId: "b", amount: 3333 },
      { userId: "c", amount: 3333 },
    ]);
  });

  it("equal: duplicates are collapsed", () => {
    expect(computeShares(900, { type: "EQUAL", userIds: ["a", "b", "b"] })).toHaveLength(2);
  });

  it("exact: must add up to the total", () => {
    expect(() =>
      computeShares(1000, { type: "EXACT", entries: [{ userId: "a", amount: 600 }, { userId: "b", amount: 300 }] }),
    ).toThrow(/add up to 9.00/);
    const ok = computeShares(1000, { type: "EXACT", entries: [{ userId: "a", amount: 700 }, { userId: "b", amount: 300 }] });
    expect(sum(ok)).toBe(1000);
  });

  it("percentage: must total 100 and rounds exactly", () => {
    expect(() =>
      computeShares(1000, { type: "PERCENTAGE", entries: [{ userId: "a", percent: 50 }, { userId: "b", percent: 40 }] }),
    ).toThrow(/100%/);
    const s = computeShares(1001, {
      type: "PERCENTAGE",
      entries: [{ userId: "a", percent: 33.3 }, { userId: "b", percent: 33.3 }, { userId: "c", percent: 33.4 }],
    });
    expect(sum(s)).toBe(1001);
  });

  it("shares: 2:1 split", () => {
    const s = computeShares(3000, { type: "SHARES", entries: [{ userId: "a", shares: 2 }, { userId: "b", shares: 1 }] });
    expect(s).toEqual([{ userId: "a", amount: 2000 }, { userId: "b", amount: 1000 }]);
  });

  it("itemized: tax and tip are shared in proportion to what each person ordered", () => {
    // a: 300 pizza, b: 100 soda, shared 200 starter. Items = 600, bill = 660 (10% tax/tip).
    const s = computeShares(66000, {
      type: "ITEMIZED",
      items: [
        { amount: 30000, userIds: ["a"] },
        { amount: 10000, userIds: ["b"] },
        { amount: 20000, userIds: ["a", "b"] },
      ],
    });
    expect(s).toEqual([
      { userId: "a", amount: 44000 }, // 400 + 40
      { userId: "b", amount: 22000 }, // 200 + 20
    ]);
  });

  it("itemized: items cannot exceed the bill", () => {
    expect(() => computeShares(500, { type: "ITEMIZED", items: [{ amount: 600, userIds: ["a"] }] })).toThrow(/more than/);
  });

  it("rescaleShares keeps proportions and the exact total", () => {
    const s = rescaleShares([{ userId: "a", amount: 300 }, { userId: "b", amount: 300 }, { userId: "c", amount: 300 }], 1200);
    expect(s.map((x) => x.amount)).toEqual([400, 400, 400]);
    expect(sum(rescaleShares(s, 1001))).toBe(1001);
  });
});
