import { prisma } from "./db";
import { getConfig } from "./lib/config";
import { logger } from "./lib/logger";
import { createServer } from "./server";

// Google OAuth setup: add {BASE_URL}/oauth/callback to the Authorized redirect URIs
// of your OAuth client in Google Cloud Console.
async function main() {
  const config = getConfig();
  const server = createServer(config);

  await server.start({
    transportType: "httpStream",
    httpStream: { port: config.PORT, host: "0.0.0.0", endpoint: "/mcp" },
  });
  logger.info("server started", { port: config.PORT, endpoint: "/mcp", health: "/health" });

  const shutdown = async (signal: string) => {
    logger.info("shutting down", { signal });
    try {
      await server.stop();
      await prisma.$disconnect();
    } finally {
      process.exit(0);
    }
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.error("failed to start", { err });
  process.exit(1);
});
