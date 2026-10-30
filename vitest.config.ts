import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    // Integration tests share one database, so files must not run in parallel.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
