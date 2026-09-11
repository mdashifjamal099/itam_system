// Runs once per Vitest test file (setupFiles). Loads .env.test into
// process.env for THIS process — the test files themselves, which talk to
// Postgres directly (Priority 1) or to the spawned test server (Priority 2-4).
// The spawned `next dev` process loads .env.test independently via Next's own
// env loader (NODE_ENV=test); this only covers the Vitest process's own env.
process.loadEnvFile(".env.test");
