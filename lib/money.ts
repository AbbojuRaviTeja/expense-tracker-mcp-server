import { ValidationError } from "./errors";

/** Converts a major-unit amount (e.g. rupees) to integer minor units (paise). */
export function toMinor(amount: number): number {
  if (!Number.isFinite(amount)) throw new ValidationError("Amount must be a finite number.");
  const minor = Math.round(amount * 100);
  if (Math.abs(amount * 100 - minor) > 1e-6) {
    throw new ValidationError(`Amount ${amount} has more than 2 decimal places.`);
  }
  return minor;
}

export function fromMinor(minor: number): number {
  return minor / 100;
}

export function formatMoney(minor: number, currency: string): string {
  const sign = minor < 0 ? "-" : "";
  return `${sign}${currency} ${(Math.abs(minor) / 100).toFixed(2)}`;
}

/**
 * Splits an integer total across weights using the largest-remainder method,
 * so the parts always add up to exactly the total. Ties go to the earlier index.
 */
export function allocate(total: number, weights: number[]): number[] {
  if (!Number.isInteger(total)) throw new Error("allocate() expects an integer total");
  if (weights.length === 0) throw new ValidationError("At least one participant is required.");
  if (weights.some((w) => !Number.isFinite(w) || w < 0)) {
    throw new ValidationError("Split weights must be zero or positive numbers.");
  }
  const weightSum = weights.reduce((a, b) => a + b, 0);
  if (weightSum <= 0) throw new ValidationError("Split weights must add up to more than zero.");

  const exact = weights.map((w) => (total * w) / weightSum);
  const parts = exact.map((x) => Math.floor(x));
  let remainder = total - parts.reduce((a, b) => a + b, 0);

  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; remainder > 0; k = (k + 1) % order.length, remainder--) {
    parts[order[k].i] += 1;
  }
  return parts;
}

export const currencySchemaDescription =
  "3-letter ISO currency code such as INR, USD, EUR. Defaults to your profile currency.";

export function normalizeCurrency(code: string | undefined, fallback: string): string {
  const value = (code ?? fallback).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(value)) {
    throw new ValidationError(`"${code}" is not a valid 3-letter currency code.`);
  }
  return value;
}
