import { ValidationError } from "./errors";

/** "  Food  &  Drinks " -> "food & drinks", so the same category is never counted twice. */
export function normalizeCategory(raw: string): string {
  const value = raw.trim().replace(/\s+/g, " ").toLowerCase();
  if (!value) throw new ValidationError("Category cannot be empty.");
  if (value.length > 50) throw new ValidationError("Category must be 50 characters or fewer.");
  if (value === "*") throw new ValidationError('"*" is reserved; use it only for overall budgets.');
  return value;
}
