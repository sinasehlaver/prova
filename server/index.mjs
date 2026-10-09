import { openDb, migrate } from "./lib/db.mjs";
import { seed } from "./seed.mjs";
import { createApp } from "./app.mjs";

const db = openDb();
await migrate(db);
const adminToken = await seed(db, { demo: process.env.SEED_DEMO === "1", adminToken: process.env.ADMIN_INVITE_TOKEN, adminName: process.env.ADMIN_NAME || undefined });
const port = Number(process.env.PORT || 4600);
// HOST=127.0.0.1 (set by start.sh) keeps local dev off the LAN; default 0.0.0.0 is what Render needs.
createApp({ db }).listen(port, process.env.HOST || "0.0.0.0", () => {
  console.log(`prova listening on http://127.0.0.1:${port}`);
  // Render sets RENDER_EXTERNAL_URL; PUBLIC_URL overrides (custom domain). Only printed on the boot that seeds the admin.
  const origin = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://127.0.0.1:${port}`).replace(/\/$/, "");
  if (adminToken) console.log(`First boot — admin login link: ${origin}/i/${adminToken}  (regenerate from Members page)`);
});
