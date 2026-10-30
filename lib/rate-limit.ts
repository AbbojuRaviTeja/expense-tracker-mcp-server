import { RateLimitError } from "./errors";

/** In-memory sliding-window limiter, keyed per user. Fine for a single instance. */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {
    const sweep = setInterval(() => this.sweep(), windowMs);
    sweep.unref?.();
  }

  check(key: string, now = Date.now()): void {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      const retryIn = Math.ceil((this.windowMs - (now - recent[0])) / 1000);
      throw new RateLimitError(`Too many requests. Please wait ${retryIn}s and try again.`);
    }
    recent.push(now);
    this.hits.set(key, recent);
  }

  private sweep(now = Date.now()) {
    for (const [key, times] of this.hits) {
      if (times.every((t) => now - t >= this.windowMs)) this.hits.delete(key);
    }
  }
}
