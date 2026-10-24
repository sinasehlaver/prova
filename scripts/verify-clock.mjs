// Preloaded by scripts/verify.sh (node --import): pins the day-15 status clock to day 10 of the real month,
// same as server/test-helpers.mjs, so a member created by the smoke/browser check is billed this month whatever today is.
import { clock } from "../server/lib/status.mjs";
import { OFFSET_MS, currentMonth } from "../server/lib/tz.mjs";

const [y, m] = currentMonth().split("-").map(Number);
const at = Date.UTC(y, m - 1, 10, 10) - OFFSET_MS;
clock.now = () => at;
