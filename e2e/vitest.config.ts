import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Run tests serially — they share a live DynamoDB table
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Load .env.e2e for test credentials if present
    env: {},
    include: ["e2e/tests/**/*.test.ts"],
    reporter: "verbose",
  },
});
