type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEY = /token|secret|password|authorization|cookie|api[-_]?key|credential/i;
const JWT_LIKE = /\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g;
const BEARER = /\bBearer\s+[\w.~+/-]+=*/gi;

/** Removes anything that looks like a credential before it reaches the logs. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth limit]";
  if (typeof value === "string") return value.replace(JWT_LIKE, "[redacted-jwt]").replace(BEARER, "Bearer [redacted]");
  if (value instanceof Error) {
    return { name: value.name, message: redact(value.message, depth + 1), stack: value.stack?.split("\n").slice(0, 6).join("\n") };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function currentLevel(): Level {
  const l = process.env.LOG_LEVEL as Level | undefined;
  return l && l in LEVELS ? l : "info";
}

function write(level: Level, message: string, fields?: Record<string, unknown>) {
  if (LEVELS[level] < LEVELS[currentLevel()]) return;
  const line = JSON.stringify({
    time: new Date().toISOString(),
    level,
    msg: redact(message),
    ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
  });
  if (level === "error" || level === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => write("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write("error", msg, fields),
};

/** Adapter so FastMCP's own logs are structured and redacted too. */
export const fastmcpLogger = {
  debug: (...args: unknown[]) => write("debug", "fastmcp", { args }),
  info: (...args: unknown[]) => write("info", "fastmcp", { args }),
  log: (...args: unknown[]) => write("info", "fastmcp", { args }),
  warn: (...args: unknown[]) => write("warn", "fastmcp", { args }),
  error: (...args: unknown[]) => write("error", "fastmcp", { args }),
};
