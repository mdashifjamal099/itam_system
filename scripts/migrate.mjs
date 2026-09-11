import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
const { Client } = pg;

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "db");

// Migrations run DDL, CREATE ROLE and GRANT. They must use the DIRECT (unpooled)
// Neon endpoint: PgBouncer in transaction mode cannot carry session state such
// as the itam.app_password setting across statements, and some DDL is rejected
// outright through the pooler.
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;

if (!url) {
  console.error("Set DATABASE_URL_UNPOOLED (preferred) or DATABASE_URL. See .env.example.");
  process.exit(1);
}
if (url.includes("-pooler.")) {
  console.warn("WARNING: migrating through the pooled endpoint. Use the direct URL instead.");
}

const appPassword = process.env.APP_DB_PASSWORD ?? "";
const appRole = process.env.APP_DB_ROLE ?? "itam_app";
if (!appPassword) {
  console.warn(
    `APP_DB_PASSWORD not set — skipping creation of the ${appRole} role.\n` +
      "The append-only guarantee depends on the app NOT connecting as the table owner.",
  );
}

// A single Client (not Pool) so every statement lands on one session, which the
// itam.app_password setting and the migration ordering both require.
const client = new Client(url);
await client.connect();

try {
  if (process.argv.includes("--reset")) {
    console.log("Dropping schema public ...");
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
  }

  if (appPassword) {
    await client.query("SELECT set_config('itam.app_password', $1, false)", [appPassword]);
    await client.query("SELECT set_config('itam.app_role', $1, false)", [appRole]);
  }

  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    const text = await readFile(join(dir, file), "utf8");
    process.stdout.write(`Applying ${file} ... `);
    // node-postgres simple query protocol: multi-statement files run as one
    // implicit transaction, so a failure mid-file rolls the whole file back.
    await client.query(text);
    console.log("ok");
  }

  console.log("\nMigrations complete.");
} catch (err) {
  console.error("\nMigration failed:", err.message);
  if (err.position) console.error("  at character offset", err.position);
  process.exitCode = 1;
} finally {
  await client.end();
}
