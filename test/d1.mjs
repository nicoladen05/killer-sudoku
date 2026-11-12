// A tiny stand-in for Cloudflare D1 on Node's built-in SQLite, so the API's SQL
// runs for real in tests. Covers only what the functions use.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";

export function testDb() {
  const raw = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) raw.exec(readFileSync(new URL(f, dir), "utf8"));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => raw.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: raw.prepare(sql).all(...args) }),
    run: async () => stmt(sql, args).runSync(),
    runSync: () => ({ meta: { changes: Number(raw.prepare(sql).run(...args).changes) } }),
  });
  return {
    raw,
    prepare: (sql) => stmt(sql),
    async batch(list) {
      raw.exec("BEGIN");
      try {
        const out = list.map((s) => s.runSync());
        raw.exec("COMMIT");
        return out;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

/** Call a Pages Function handler with a JSON body; returns [status, body]. */
export async function call(handler, env, method, body, ip = "1.2.3.4") {
  const request = new Request("https://example.test/api", {
    method,
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify(body),
  });
  const res = await handler({ request, env });
  return [res.status, await res.json()];
}
