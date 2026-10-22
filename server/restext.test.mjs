import { test } from "node:test";
import assert from "node:assert/strict";
import { reservationText } from "../web/src/resText.js";

const s = Date.parse("2026-11-04T18:00:00+03:00"), e = Date.parse("2026-11-04T22:00:00+03:00");
test("reservationText formats Istanbul date, hours, note and +N", () => {
  assert.equal(reservationText({ start_ms: s, end_ms: e, note: "Grup", people: 2 }), "4 Kasım Çarşamba 18.00 - 22.00 Grup +2");
  assert.equal(reservationText({ start_ms: s, end_ms: e, note: "", people: 0 }), "4 Kasım Çarşamba 18.00 - 22.00");
});
