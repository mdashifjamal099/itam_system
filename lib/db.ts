import { neon } from "@neondatabase/serverless";
import pg from "pg";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local.");
}

const isLocal = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);

/**
 * @neondatabase/serverless talks Neon's HTTP/WebSocket protocol only — it
 * cannot reach a plain TCP Postgres, which is what the local Docker container
 * (docker-compose.yml) is. This shim reproduces just enough of its tagged-
 * template + `.transaction()` surface on top of `pg` so lib/tenant.ts works
 * unmodified against either backend. It exists ONLY for local development;
 * against a real DATABASE_URL (Neon) the actual `neon()` driver is used.
 */
function createLocalSql() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  function toPositional(strings: TemplateStringsArray, values: unknown[]) {
    let text = strings[0];
    const params: unknown[] = [];
    values.forEach((v, i) => {
      params.push(v);
      text += `$${params.length}${strings[i + 1]}`;
    });
    return { text, params };
  }

  // Lazy + thenable, like the real driver: `await sql\`...\`` executes it
  // standalone, while `sql.transaction([...])` runs the same descriptor on a
  // single connection instead.
  function tag(strings: TemplateStringsArray, ...values: unknown[]) {
    const { text, params } = toPositional(strings, values);
    return {
      __text: text,
      __params: params,
      then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
        pool.query(text, params).then((r) => resolve(r.rows), reject);
      },
    };
  }

  tag.transaction = async (
    queries: { __text: string; __params: unknown[] }[],
  ): Promise<unknown[][]> => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const results: unknown[][] = [];
      for (const q of queries) {
        const r = await client.query(q.__text, q.__params);
        results.push(r.rows);
      }
      await client.query("COMMIT");
      return results;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  };

  return tag;
}

// Cast to the Neon type: both shapes are only ever used via tagged-template
// calls and `.transaction()`, which the local shim implements identically.
export const sql = (
  isLocal ? createLocalSql() : neon(process.env.DATABASE_URL)
) as ReturnType<typeof neon<false, false>>;
