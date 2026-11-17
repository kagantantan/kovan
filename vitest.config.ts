import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["sunucu/test/**/*.test.ts"],
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 60_000,
    pool: "forks",
  },
});
