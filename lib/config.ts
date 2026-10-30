import "dotenv/config";
import { z } from "zod";
import { isValidTimeZone } from "./dates";

const configSchema = z.object({
  DATABASE_URL: z.string({ error: "is required" }).min(1, "is required"),
  GOOGLE_CLIENT_ID: z.string({ error: "is required" }).min(1, "is required"),
  GOOGLE_CLIENT_SECRET: z.string({ error: "is required" }).min(1, "is required"),
  BASE_URL: z.url({ error: "must be a full URL, e.g. http://localhost:8000" }),
  PORT: z.coerce.number().int().positive().default(8000),
  DEFAULT_TIMEZONE: z
    .string()
    .default("UTC")
    .refine(isValidTimeZone, "DEFAULT_TIMEZONE must be an IANA time zone like Asia/Kolkata"),
  DEFAULT_CURRENCY: z
    .string()
    .regex(/^[A-Za-z]{3}$/, "DEFAULT_CURRENCY must be a 3-letter ISO code")
    .default("INR")
    .transform((c) => c.toUpperCase()),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(60),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
});

export type AppConfig = z.infer<typeof configSchema>;

let cached: AppConfig | undefined;

/** Validates the environment once and fails fast with every problem listed. */
export function getConfig(): AppConfig {
  if (cached) return cached;
  const parsed = configSchema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid server configuration:\n${problems}`);
  }
  cached = parsed.data;
  return cached;
}

/** Settings that have safe defaults and are needed outside the server entry point. */
export function getDefaults() {
  const tz = process.env.DEFAULT_TIMEZONE;
  const currency = process.env.DEFAULT_CURRENCY;
  return {
    timezone: tz && isValidTimeZone(tz) ? tz : "UTC",
    currency: currency && /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : "INR",
  };
}
