import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    globalSetup: ["./tests/global-setup.ts"],
    setupFiles: ["./tests/helpers/setup-env.ts"],
    // Tests share one Postgres database and, for Priority 2-4, one spawned
    // server. Running files in parallel would make cross-tenant assertions
    // (cron routes report counts across ALL orgs) flaky and hard to reason
    // about. Sequential is slower but deterministic — the right trade for a
    // suite this size.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    include: ["tests/**/*.test.ts"],
  },
});
