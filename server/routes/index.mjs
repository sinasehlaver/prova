// THE registry. Later phases: add a file in this folder exporting `default (ctx) => express.Router()`
// (ctx = { db }) and add ONE line to ROUTES. Routers get /api mounted; use requireAuth/requireAdmin from ../lib/auth.mjs.
import me from "./me.mjs";
import users from "./users.mjs";
import reservations from "./reservations.mjs";

import alerts from "./alerts.mjs";

import billing from "./billing.mjs";

import economics from "./economics.mjs";

import exportRoute from "./export.mjs";

const ROUTES = [me, users, reservations, alerts, billing, economics, exportRoute];

export const registerRoutes = (app, ctx) => ROUTES.forEach((r) => app.use("/api", r(ctx)));
