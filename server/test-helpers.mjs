// Later-phase tests: `const t = await makeTestApp(); ... await t.close()`.
//   t.fetch(path, { as: t.admin | t.member | null, method, body })  -> Response (as = user row w/ invite_token -> sends cookie)
//   t.db  (fresh in-memory-style temp file DB, migrated + seeded demo)  t.admin / t.member / t.member2  (user rows)
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, migrate } from "./lib/db.mjs";
import { seed } from "./seed.mjs";
import { createApp } from "./app.mjs";
import { COOKIE } from "./lib/auth.mjs";

export async function makeTestApp() {
  const dir = mkdtempSync(join(tmpdir(), "prova-test-"));
  const db = openDb("file:" + join(dir, "t.db"));
  await migrate(db);
  await seed(db, { demo: true });
  const users = (await db.execute("SELECT * FROM users ORDER BY id")).rows;
  const server = createApp({ db }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const fetchAs = (path, { as = null, method = "GET", body, headers = {} } = {}) =>
    fetch(base + path, {
      method,
      redirect: "manual",
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(as ? { cookie: `${COOKIE}=${as.invite_token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    db, base, fetch: fetchAs,
    admin: users[0], member: users[1], member2: users[2],
    close: async () => { server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}
