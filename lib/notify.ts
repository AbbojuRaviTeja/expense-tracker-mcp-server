import { logger } from "./logger";

export interface EmailResult {
  sent: boolean;
  reason?: string;
}

/**
 * Sends a plain-text email through Resend when RESEND_API_KEY and EMAIL_FROM are
 * configured. Without them it reports that email is disabled instead of failing.
 */
export async function sendEmail(to: string, subject: string, text: string): Promise<EmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) {
    return { sent: false, reason: "Email is not configured on this server (set RESEND_API_KEY and EMAIL_FROM)." };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      logger.warn("email send failed", { status: res.status, to });
      return { sent: false, reason: `Email provider returned HTTP ${res.status}.` };
    }
    return { sent: true };
  } catch (err) {
    logger.warn("email send error", { err, to });
    return { sent: false, reason: "Could not reach the email provider." };
  }
}
