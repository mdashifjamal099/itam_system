import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Runs once before the whole suite:
 *   1. Reset + migrate the isolated `itam_test` database (never the dev one —
 *      DATABASE_URL_UNPOOLED in .env.test points at a different database name
 *      on the same local Postgres instance).
 *   2. Spawn a real `next dev` server on TEST_PORT against that database, for
 *      the API/E2E tests to hit over real HTTP.
 *
 * Teardown kills the server. The test database is left in place (fast re-runs);
 * `--reset` on the next run wipes it again before migrating.
 */
export default async function globalSetup() {
  const root = process.cwd();
  const envFile = join(root, ".env.test");
  if (!existsSync(envFile)) {
    throw new Error(".env.test is missing — required so tests never touch dev data.");
  }

  console.log("\n[global-setup] resetting and migrating itam_test ...");
  execSync(`node --env-file=.env.test scripts/migrate.mjs --reset`, {
    cwd: root,
    stdio: "inherit",
  });

  const port = process.env.TEST_PORT ?? "3100";
  console.log(`[global-setup] starting test server on port ${port} ...`);

  const server = spawn("npx", ["next", "dev", "-p", port], {
    cwd: root,
    shell: true,
    env: { ...process.env, NODE_ENV: "test", NEXT_DIST_DIR: ".next-test" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let serverOutput = "";
  server.stdout?.on("data", (d) => {
    const str = d.toString();
    serverOutput += str;
    process.stdout.write(str);
  });
  server.stderr?.on("data", (d) => {
    const str = d.toString();
    serverOutput += str;
    process.stderr.write(str);
  });

  const baseUrl = `http://localhost:${port}`;
  await waitForServer(baseUrl, server, () => serverOutput);

  console.log("[global-setup] test server ready at", baseUrl);

  return async () => {
    console.log("\n[global-teardown] stopping test server ...");
    await killProcessTree(server);
  };
}

async function waitForServer(
  url: string,
  proc: ChildProcess,
  getOutput: () => string,
  timeoutMs = 45_000,
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (proc.exitCode !== null) {
      throw new Error(`Test server exited early (code ${proc.exitCode}):\n${getOutput()}`);
    }
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Test server did not become ready within ${timeoutMs}ms:\n${getOutput()}`);
}

async function killProcessTree(proc: ChildProcess) {
  if (proc.pid == null) return;
  if (process.platform === "win32") {
    try {
      execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: "ignore" });
    } catch {
      // already gone
    }
  } else {
    proc.kill("SIGTERM");
  }
}
