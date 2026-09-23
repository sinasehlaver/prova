import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeTestApp } from "./test-helpers.mjs";
import { COOKIE } from "./lib/auth.mjs";
import { ensureMonth, feeFor, nextMonth, setFee } from "./lib/billing.mjs";
import { currentMonth } from "./lib/tz.mjs";

const H = 3600_000;
const t = await makeTestApp();
after(() => t.close());

const fx = (n) => readFileSync(new URL(`../fixtures/receipts/${n}`, import.meta.url));
const M = currentMonth();
const NEXT = nextMonth(M);
const FAR = Array.from({ length: 13 }).reduce((m) => nextMonth(m), M); // current + 13 = one past the browse cap
const day = (n) => Math.ceil((Date.now() + 2 * H) / H) * H + n * 24 * H;
const J = async (r) => r.json();
const mk = async (name) => { // fresh member (own sub charge, no bookings)
  const u = await J(await t.fetch("/api/users", { method: "POST", as: t.admin, body: { name } }));
  return (await t.db.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [u.id] })).rows[0];
};
const bill = async (as, month = M) => J(await t.fetch(`/api/billing?month=${month}`, { as }));
const body = (file) => (file == null ? undefined : typeof file === "string" ? fx(file) : file);
/** Admin records a payment for `u` (raw PDF body, optional). The self-serve member upload is switched off. */
const record = (u, { month = M, charges, amount, file = null, name = typeof file === "string" ? file : undefined, note, fromCredit, as = t.admin } = {}) =>
  fetch(`${t.base}/api/admin/users/${u.id}/receipts?month=${month}&amount_try=${amount}${fromCredit ? "&from_credit=1" : ""}` +
    `${charges ? `&charges=${charges.join(",")}` : ""}${name ? `&filename=${name}` : ""}${note ? `&note=${encodeURIComponent(note)}` : ""}`, {
    method: "POST", headers: { "content-type": "application/pdf", cookie: `${COOKIE}=${as.invite_token}` }, body: body(file),
  });
/** Admin aid: parse a dekont without storing anything. */
const parse = (file, expected = 0, as = t.admin) =>
  fetch(`${t.base}/api/admin/receipts/parse?expected_try=${expected}`, {
    method: "POST", headers: { "content-type": "application/pdf", cookie: `${COOKIE}=${as.invite_token}` }, body: body(file),
  });
const sub = (b) => b.items.find((i) => i.kind === "subscription");
const admin = (path, opts = {}) => t.fetch("/api/admin" + path, { as: t.admin, ...opts });

test("ensureMonth: idempotent, snapshot, active + joined_month only", async () => {
  const u = await mk("Idem");
  await ensureMonth(t.db, u, M); await ensureMonth(t.db, u, M); await ensureMonth(t.db, u, M);
  const n = (await t.db.execute({ sql: "SELECT COUNT(*) n FROM charges WHERE user_id = ? AND kind = 'subscription'", args: [u.id] })).rows[0].n;
  assert.equal(n, 1);
  await ensureMonth(t.db, u, "2000-01"); // before joined_month
  await ensureMonth(t.db, { ...u, id: 9999, active: 0 }, M); // inactive
  assert.equal((await t.db.execute({ sql: "SELECT COUNT(*) n FROM charges WHERE user_id IN (?, 9999)", args: [u.id] })).rows[0].n, 1);
  assert.equal((await bill(u)).items.length, 1);
});

test("charge snapshot survives a fee change; fees apply from a future month only", async () => {
  const u = await mk("Snap");
  const before = sub(await bill(u));
  assert.equal(before.amount_try, 1500);
  await assert.rejects(setFee(t.db, { effectiveFrom: M, subscriptionTry: 9, bookingTry: 9 }), /gelecek/);
  const r = await admin("/fees", { method: "POST", body: { effective_from: NEXT, subscription_try: 2000, booking_try: 600 } });
  assert.equal(r.status, 201);
  assert.equal((await feeFor(t.db, M)).subscription_try, 1500);
  assert.equal((await feeFor(t.db, NEXT)).subscription_try, 2000);
  assert.equal(sub(await bill(u)).amount_try, 1500); // untouched
  await ensureMonth(t.db, u, NEXT);
  const next = (await t.db.execute({ sql: "SELECT amount_try FROM charges WHERE user_id = ? AND month = ?", args: [u.id, NEXT] })).rows[0];
  assert.equal(next.amount_try, 2000);
  assert.equal((await admin("/fees", { method: "POST", body: { effective_from: M, subscription_try: 1, booking_try: 1 } })).status, 400);
  assert.equal((await admin("/fees", { method: "POST", body: { effective_from: NEXT, subscription_try: 1.5, booking_try: 1 } })).status, 400);
  assert.equal((await t.fetch("/api/admin/fees", { as: t.member })).status, 403);
  // put the fee back so later tests see 500 for a booking in the current month; NEXT row edited in place (same effective_from)
  await admin("/fees", { method: "POST", body: { effective_from: NEXT, subscription_try: 1500, booking_try: 500 } });
  assert.equal((await t.db.execute({ sql: "SELECT COUNT(*) n FROM fees WHERE effective_from = ?", args: [NEXT] })).rows[0].n, 1);
});

test("booking charge: ONE charge on the booker = people x fee, voided on cancel, kalan sums unpaid", async () => {
  const a = await mk("Bir"), b = await mk("Iki");
  const res = await t.fetch("/api/reservations", { method: "POST", as: a, body: { start_ms: day(1), hours: 2, people: 3 } });
  assert.equal(res.status, 201);
  const { id } = await J(res);
  const rows = (await t.db.execute({ sql: "SELECT * FROM charges WHERE reservation_id = ?", args: [id] })).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user_id, a.id);
  assert.equal(rows[0].kind, "booking");
  assert.equal(rows[0].amount_try, 3 * 500);
  assert.equal(rows[0].voided_at, null);
  const month = rows[0].month;
  const va = await bill(a, month);
  const it = va.items.find((i) => i.kind === "booking");
  assert.equal(it.reservation.people, 3);
  assert.equal(va.kalan, va.items.reduce((s, i) => s + (i.status === "unpaid" ? i.amount_try : 0), 0));
  assert.equal(va.kalan, (month === M ? 1500 : 0) + 1500);
  assert.equal((await bill(b, month)).items.filter((i) => i.kind === "booking").length, 0); // nobody else is billed
  assert.equal((await t.fetch(`/api/reservations/${id}`, { method: "DELETE", as: a })).status, 200);
  const va2 = await bill(a, month);
  assert.equal(va2.items.find((i) => i.kind === "booking").status, "voided");
  assert.equal(va2.kalan, month === M ? 1500 : 0);
  // a PAID booking charge survives the cancel
  const r2 = await J(await t.fetch("/api/reservations", { method: "POST", as: a, body: { start_ms: day(3), hours: 1 } }));
  const rcpt = (await t.db.execute({ sql: "INSERT INTO receipts (user_id, month, sha256, status, uploaded_at) VALUES (?,?,?,?,?)", args: [a.id, month, "x" + r2.id, "ok", 1] })).lastInsertRowid;
  await t.db.execute({ sql: "UPDATE charges SET paid_receipt_id = ?, paid_by = 'admin' WHERE reservation_id = ?", args: [rcpt, r2.id] });
  assert.equal((await t.fetch(`/api/reservations/${r2.id}`, { method: "DELETE", as: a })).status, 200);
  assert.equal((await t.db.execute({ sql: "SELECT voided_at FROM charges WHERE reservation_id = ?", args: [r2.id] })).rows[0].voided_at, null);
});

test("failed reservation (overlap) leaves no charges behind", async () => {
  const a = await mk("Roll");
  const s = day(3);
  assert.equal((await t.fetch("/api/reservations", { method: "POST", as: a, body: { start_ms: s, hours: 1 } })).status, 201);
  const before = (await t.db.execute("SELECT COUNT(*) n FROM charges")).rows[0].n;
  assert.equal((await t.fetch("/api/reservations", { method: "POST", as: t.member, body: { start_ms: s, hours: 1 } })).status, 409);
  assert.equal((await t.db.execute("SELECT COUNT(*) n FROM charges")).rows[0].n, before);
});

// Member uploads a dekont with no charges/amount, own session, raw PDF body. Body is a synthetic (not fixture) PDF -
// unique content each call, so its sha256 never collides with a fixture-based receipt some OTHER test stores; the
// content doesn't matter here since the member picks no amount/charges and the admin types the amount by hand.
let uploadSeq = 0;
const fakePdf = () => Buffer.from(`%PDF-1.4\n%member-upload-test-${Date.now()}-${uploadSeq++}\n`, "latin1");
const upload = (u) =>
  fetch(`${t.base}/api/billing/receipts`, { method: "POST", headers: { "content-type": "application/pdf", cookie: `${COOKIE}=${u.invite_token}` }, body: fakePdf() });

test("member self-serve upload (re-enabled, admin-approval-only): PENDING, non-allocating; admin approve/reject decide", async () => {
  const u = await mk("Yukle");
  assert.equal((await t.fetch(`/api/billing/receipts`, { method: "POST" })).status, 401); // anon
  const bad = await fetch(`${t.base}/api/billing/receipts`, {
    method: "POST", headers: { "content-type": "application/pdf", cookie: `${COOKIE}=${u.invite_token}` }, body: Buffer.from("not a pdf"),
  });
  assert.equal(bad.status, 400);

  // a real dekont lands as 'pending': stored, but nothing allocated, nothing owed changes
  const before = await bill(u);
  const up = await upload(u);
  assert.equal(up.status, 201);
  const out = await J(up);
  assert.equal(out.status, "pending");
  assert.equal(out.applied_try, null);
  const v = await bill(u);
  assert.equal(v.kalan, before.kalan);
  assert.equal(v.receipts.length, 1);
  assert.equal(v.receipts[0].status, "pending");
  assert.match(v.receipts[0].message, /bekliyor/);

  // admin sees it via the status filter
  const list = await J(await admin(`/receipts?status=pending&user_id=${u.id}`));
  assert.equal(list.length, 1);
  assert.equal(list[0].id, out.id);

  // reject: -> mismatch, no allocation, reason shown; member can't approve/reject their own
  assert.equal((await t.fetch(`/api/admin/receipts/${out.id}/reject`, { method: "POST", as: u })).status, 403);
  const rj = await J(await admin(`/receipts/${out.id}/reject`, { method: "POST", body: { note: "Okunamıyor" } }));
  assert.equal(rj.status, "mismatch");
  assert.match(rj.message, /Okunamıyor/);
  assert.equal((await bill(u)).kalan, before.kalan);

  // approve on a fresh pending upload: the admin types the amount, same allocation as recordPayment - but on THIS row
  const up2 = await upload(u);
  const out2 = await J(up2);
  assert.equal((await admin(`/receipts/${out2.id}/approve`, { method: "POST", body: {} })).status, 400); // no amount yet
  const ap = await J(await admin(`/receipts/${out2.id}/approve`, { method: "POST", body: { amount_try: 1500, note: "Kontrol edildi" } }));
  assert.equal(ap.status, "ok");
  assert.equal(ap.applied_try, 1500);
  assert.match(ap.message, /Kontrol edildi/);
  const v2 = await bill(u);
  assert.equal(sub(v2).status, "paid");
  assert.equal(sub(v2).paid_by, "admin");
  assert.equal(v2.kalan, 0);
  // the pdf is still viewable under the member's own upload
  assert.equal((await t.fetch(`/api/receipts/${out2.id}/pdf`, { as: u })).status, 200);
});

test("admin records a payment: exact amount ticks the selected charges (paid_by admin), pdf stored + viewable", async () => {
  const u = await mk("Okey");
  const b = await bill(u);
  const r = await record(u, { charges: [sub(b).id], amount: 1500, file: "enpara-1500.pdf" });
  assert.equal(r.status, 201);
  const out = await J(r);
  assert.equal(out.status, "ok");
  assert.equal(out.duplicate, false);
  assert.equal(out.applied_try, 1500);
  assert.equal(out.remaining_try, 0);
  assert.equal((await t.fetch(`/api/admin/users/${u.id}/receipts?amount_try=100`, { method: "POST", as: u })).status, 403); // members can't
  const b2 = await bill(u);
  assert.equal(sub(b2).status, "paid");
  assert.equal(sub(b2).paid_by, "admin");
  assert.equal(b2.kalan, 0);
  assert.equal(b2.receipts.length, 1);
  assert.equal(b2.receipts[0].charges.length, 1);
  const row = (await t.db.execute({ sql: "SELECT * FROM receipts WHERE id = ?", args: [out.id] })).rows[0];
  assert.equal(row.sha256.length, 64);
  assert.equal(row.bank_ref, "FST2609031234567");
  assert.equal(row.expected_try, 1500);
  const pdf = await t.fetch(`/api/receipts/${out.id}/pdf`, { as: u });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get("content-type"), "application/pdf");
  assert.equal((await pdf.arrayBuffer()).byteLength, fx("enpara-1500.pdf").length);
  assert.equal((await record(u, { amount: 1500, file: "isbank-1500.pdf" })).status, 400); // nothing left to pay
});

test("underpayment: part-payment counts, kalan shown; top-up over the rest = credit; reject/approve move the credit", async () => {
  const u = await mk("Eksik");
  const paid = await J(await record(u, { amount: 1000, file: "enpara-1000-mismatch.pdf" })); // 1.000 of 1.500
  assert.equal(paid.status, "ok");
  assert.equal(paid.applied_try, 1000);
  assert.equal(paid.remaining_try, 500);
  assert.match(paid.message, /1\.000,00 TL ödemene sayıldı\. Kalan: 500,00 TL/);
  let v = await bill(u);
  assert.equal(v.kalan, 500);
  assert.equal(v.paid, 1000);
  assert.equal(v.total, 1500);
  assert.equal(sub(v).status, "unpaid"); // only fully covered charges turn paid
  assert.equal(sub(v).paid_try, 1000);
  assert.equal(sub(v).remaining_try, 500);
  assert.equal(sub(v).flag, null);
  assert.equal(v.credit.balance_try, 0);
  assert.equal(v.receipts[0].remaining_try, 500);
  assert.equal(v.receipts[0].message, paid.message);
  assert.equal(v.receipts[0].charges[0].applied_try, 1000);

  // pays 1.500 for the remaining 500 -> charge paid, 1.000 surplus = credit the community owes
  const top = await J(await record(u, { amount: 1500, file: "papara-1500.pdf" }));
  assert.equal(top.status, "ok");
  assert.equal(top.expected_try, 500);
  assert.equal(top.overpaid_try, 1000);
  assert.match(top.message, /topluluk sana 1\.000,00 TL borçlu/);
  v = await bill(u);
  assert.equal(sub(v).status, "paid");
  assert.equal(v.kalan, 0);
  assert.equal(v.credit.balance_try, 1000);
  const seen = await J(await admin(`/users/${u.id}/billing`)); // visible to admin too
  assert.equal(seen.credit.balance_try, 1000);

  // reject the top-up: its surplus stops counting, the part-payment stays -> 500 kalan again
  await admin(`/receipts/${top.id}/reject`, { method: "POST", body: { note: "Yanlış" } });
  v = await bill(u);
  assert.equal(sub(v).status, "unpaid");
  assert.equal(v.kalan, 500);
  assert.equal(v.credit.balance_try, 0);
  // rejecting the FIRST (part) receipt: nothing left covered
  await admin(`/receipts/${paid.id}/reject`, { method: "POST", body: {} });
  assert.equal((await bill(u)).kalan, 1500);
  await admin(`/receipts/${paid.id}/approve`, { method: "POST", body: {} }); // approve = counts in full
  v = await bill(u);
  assert.equal(sub(v).status, "paid");
  assert.equal(sub(v).paid_by, "admin");
  assert.equal(v.credit.balance_try, 0);
  // approve the surplus receipt again: covers the 0 still outstanding, its 1.000 overpayment is back
  await admin(`/receipts/${top.id}/approve`, { method: "POST", body: {} });
  assert.equal((await bill(u)).credit.balance_try, 1000);

  // admin settles by hand: partial, then the rest; guards
  assert.equal((await t.fetch(`/api/admin/users/${u.id}/credit/settle`, { method: "POST", as: u, body: {} })).status, 403);
  assert.equal((await admin(`/users/${u.id}/credit/settle`, { method: "POST", body: { amount_try: 1001 } })).status, 400);
  assert.equal((await admin(`/users/${u.id}/credit/settle`, { method: "POST", body: { amount_try: 1.5 } })).status, 400);
  const part = await J(await admin(`/users/${u.id}/credit/settle`, { method: "POST", body: { amount_try: 400, note: "IBAN'a iade" } }));
  assert.equal(part.settled_try, 400);
  assert.equal(part.credit.balance_try, 600);
  assert.equal(part.credit.settlements[0].note, "IBAN'a iade");
  const rest = await J(await admin(`/users/${u.id}/credit/settle`, { method: "POST", body: {} })); // omitted = all
  assert.equal(rest.settled_try, 600);
  assert.equal(rest.credit.balance_try, 0);
  assert.equal(rest.credit.settlements.length, 2);
  assert.equal((await admin(`/users/${u.id}/credit/settle`, { method: "POST", body: {} })).status, 409);
  assert.equal((await bill(u)).credit.balance_try, 0);
});

test("overpayment: surplus pays the month's other unpaid items first (oldest first); the parse suggestion is floored", async () => {
  const u = await mk("Fazla");
  await admin(`/users/${u.id}/charges`, { method: "POST", body: { month: M, amount_try: 500, note: "Anahtar" } });
  const b = await bill(u);
  const adj = b.items.find((i) => i.kind === "adjustment");
  assert.equal(b.kalan, 2000);
  const sug = await J(await parse("enpara-1500-50-kurus.pdf", 500));
  assert.equal(sug.found_try, 1500.5);
  assert.equal(sug.suggest_try, 1500); // 1.500,50 -> 1.500: sub-lira is never credited
  // 1.500 TL recorded against the 500 item only: 500 to it, 1.000 spills onto the subscription
  const out = await J(await record(u, { charges: [adj.id], amount: sug.suggest_try, file: "enpara-1500-50-kurus.pdf" }));
  assert.equal(out.status, "ok");
  assert.equal(out.expected_try, 500);
  assert.equal(out.overpaid_try, 0);
  assert.equal(out.applied_try, 1500);
  const v = await bill(u);
  assert.equal(v.items.find((i) => i.id === adj.id).status, "paid");
  assert.equal(sub(v).status, "unpaid");
  assert.equal(sub(v).paid_try, 1000);
  assert.equal(v.kalan, 500);
  assert.equal(v.credit.balance_try, 0);
  assert.equal(v.receipts[0].charges.length, 2);
  // the admin card shows what was HANDED OVER and which items were the admin's pick vs. where the surplus went
  const rc = v.receipts[0];
  assert.equal(rc.paid_try, 1500);
  assert.equal(rc.spill_try, 1000);
  assert.equal(rc.has_pdf, true);
  assert.deepEqual(rc.charges.map((c) => [c.id, c.selected, c.applied_try]), [[adj.id, true, 500], [sub(v).id, false, 1000]]);
});

test("reported case: fee waived, 200 extra picked, 500 paid in cash -> card says 500 paid, 300 owed back, no PDF", async () => {
  const u = await mk("Sina2");
  await admin(`/charges/${sub(await bill(u)).id}/waive`, { method: "POST", body: {} });
  await admin(`/users/${u.id}/charges`, { method: "POST", body: { month: M, amount_try: 200, note: "bozuk mikrofon" } });
  const mic = (await bill(u)).items.find((i) => i.kind === "adjustment");
  const out = await J(await record(u, { charges: [mic.id], amount: 500 }));
  assert.equal(out.expected_try, 200);
  assert.equal(out.paid_try, 500);
  assert.equal(out.applied_try, 200);
  assert.equal(out.spill_try, 0);
  assert.equal(out.overpaid_try, 300);
  assert.equal(out.has_pdf, false);
  assert.deepEqual(out.charges.map((c) => [c.id, c.selected]), [[mic.id, true]]);
  assert.equal((await bill(u)).credit.balance_try, 300);
});

test("markSelected: picked rows come first; a 0 row (money ran out) is still picked; spill only after expected", async () => {
  const { markSelected } = await import("./lib/payments.mjs");
  const sel = (rows, exp) => markSelected(rows.map((applied_try) => ({ applied_try })), exp).map((c) => c.selected);
  assert.deepEqual(sel([500, 1000], 500), [true, false]); // 500 picked, 1.000 spilled
  assert.deepEqual(sel([300, 0], 800), [true, true]); // under-payment: second pick got nothing
  assert.deepEqual(sel([200, 300], 500), [true, true]); // exact
  assert.deepEqual(sel([200, 300, 50], 500), [true, true, false]);
});

test("part-payment on a charge that is then waived becomes credit", async () => {
  const u = await mk("Muaf2");
  // a part-payment inserted by hand (exact same rows the upload writes) keeps this test independent of the fixture files
  const rid = Number((await t.db.execute({
    sql: "INSERT INTO receipts (user_id, month, sha256, status, expected_try, applied_try, uploaded_at) VALUES (?,?,?,?,?,?,?)", args: [u.id, M, "hand-part-" + u.id, "ok", 1500, 700, 1],
  })).lastInsertRowid);
  const s = sub(await bill(u));
  await t.db.execute({ sql: "INSERT INTO receipt_charges (receipt_id, charge_id, applied_try) VALUES (?,?,?)", args: [rid, s.id, 700] });
  let v = await bill(u);
  assert.equal(v.kalan, 800);
  assert.equal(v.credit.balance_try, 0);
  await admin(`/charges/${s.id}/waive`, { method: "POST", body: {} });
  v = await bill(u);
  assert.equal(v.kalan, 0);
  assert.equal(v.credit.balance_try, 700); // the community owes back what was paid toward a waived charge
  await admin(`/charges/${s.id}/waive`, { method: "POST", body: { waived: false } });
  assert.equal((await bill(u)).credit.balance_try, 0);
});

test("parse is a suggestion only: nothing is stored, nothing is decided", async () => {
  const a = await mk("Mm");
  // two candidate amounts on the dekont = ambiguous; the parser says so, the admin still types the number
  const mm = await J(await parse("enpara-two-amounts.pdf", 1500));
  assert.equal(mm.status, "mismatch");
  assert.equal(mm.message, "PDF'te 1.000,00 TL, 800,00 TL bulundu, beklenen 1.500,00 TL");
  assert.deepEqual(mm.amounts, [1000, 800]);
  assert.equal(mm.suggest_try, 1000);
  assert.equal(mm.duplicate, false);

  const un = await J(await parse("scanned-no-text.pdf", 1500));
  assert.equal(un.status, "unreadable");
  assert.equal(un.suggest_try, null);

  // "Okey" already paid with enpara-1500.pdf: re-filing it is flagged, and so is the same bank ref in other bytes
  const dup = await J(await parse("enpara-1500.pdf", 1500));
  assert.equal(dup.status, "duplicate");
  assert.equal(dup.duplicate, true);
  const changed = Buffer.concat([fx("enpara-1500.pdf"), Buffer.from("\n% tweak\n")]);
  assert.equal((await J(await parse(changed, 1500))).duplicate, true);

  const va = await bill(a); // three parses later: still nothing on the member's month
  assert.equal(va.kalan, 1500);
  assert.equal(va.receipts.length, 0);

  assert.equal((await parse(Buffer.from("hello"), 1500)).status, 400); // not a PDF
  assert.equal((await parse(Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(5.5 * 1024 * 1024)]), 1500)).status, 413);
  assert.equal((await record(a, { amount: 1500, file: Buffer.from("hello") })).status, 400);

  // the admin can record a flagged dekont anyway - it is stored under a suffixed hash and the warning comes back
  const rec = await J(await record(a, { amount: 1500, file: "enpara-1500.pdf" }));
  assert.equal(rec.duplicate, true);
  assert.equal((await bill(a)).kalan, 0);
  assert.match((await t.db.execute({ sql: "SELECT sha256 FROM receipts WHERE id = ?", args: [rec.id] })).rows[0].sha256, /#\d+$/);
});

test("manual record with no PDF (cash); overpayment still becomes credit; guards", async () => {
  const u = await mk("Nakit");
  const out = await J(await record(u, { amount: 2000, note: "Nakit ödendi" }));
  assert.equal(out.status, "ok");
  assert.equal(out.filename, null);
  assert.equal(out.applied_try, 1500);
  assert.equal(out.overpaid_try, 500);
  assert.equal(out.paid_try, 2000);
  assert.equal(out.has_pdf, false); // the UI hides "PDF'i göster" instead of embedding a 404
  assert.match(out.message, /Nakit ödendi/);
  const v = await bill(u);
  assert.equal(sub(v).status, "paid");
  assert.equal(sub(v).paid_by, "admin");
  assert.equal(v.kalan, 0);
  assert.equal(v.credit.balance_try, 500);
  assert.equal((await t.fetch(`/api/receipts/${out.id}/pdf`, { as: u })).status, 404); // nothing to show

  // extra debt is still an adjustment, forgiving one is still a waive: no new money state was invented
  await admin(`/users/${u.id}/charges`, { method: "POST", body: { month: M, amount_try: 300, note: "Anahtar" } });
  assert.equal((await bill(u)).kalan, 300);

  for (const amount of [0, -100, 1.5, undefined]) assert.equal((await record(u, { amount })).status, 400);
  assert.equal((await record(u, { amount: 100, month: NEXT })).status, 400);
  assert.equal((await record(u, { amount: 100, month: "bad" })).status, 400);
  assert.equal((await record(u, { amount: 100, charges: [999999] })).status, 400);
  assert.equal((await t.fetch("/api/admin/users/999999/receipts?amount_try=100", { method: "POST", as: t.admin })).status, 404);
});

test("members never see others' billing; admin sees any", async () => {
  const a = await mk("Priv1"), b = await mk("Priv2");
  await record(a, { amount: 1500, file: "ziraat-1500.pdf" });
  const ra = (await bill(a)).receipts[0];
  assert.equal((await t.fetch(`/api/admin/users/${a.id}/billing`, { as: b })).status, 403);
  assert.equal((await t.fetch("/api/admin/receipts", { as: b })).status, 403);
  assert.equal((await t.fetch(`/api/admin/users/${a.id}/reservations`, { as: b })).status, 403);
  assert.equal((await t.fetch(`/api/receipts/${ra.id}/pdf`, { as: b })).status, 404);
  assert.equal((await t.fetch(`/api/receipts/${ra.id}/pdf`)).status, 401);
  assert.equal((await t.fetch(`/api/receipts/${ra.id}/pdf`, { as: t.admin })).status, 200);
  const spoof = await J(await t.fetch(`/api/billing?month=${M}&user_id=${a.id}`, { as: b })); // ignored
  assert.equal(sub(spoof).status, "unpaid");
  assert.equal(spoof.receipts.length, 0);
  assert.equal((await t.fetch("/api/billing", { as: b })).status, 200);
  assert.equal((await t.fetch(`/api/billing?month=${NEXT}`, { as: b })).status, 200); // future months browsable (to current + 12)
  assert.equal((await t.fetch(`/api/billing?month=${FAR}`, { as: b })).status, 400);
  assert.equal((await t.fetch("/api/billing")).status, 401);
  const seen = await J(await admin(`/users/${a.id}/billing`));
  assert.equal(sub(seen).status, "paid");
  const rs = await J(await admin(`/users/${a.id}/receipts`));
  assert.equal(rs.length, 1);
  assert.equal((await admin(`/users/999999/billing`)).status, 404);
  assert.ok(Array.isArray(await J(await admin(`/users/${a.id}/reservations`))));
});

test("admin undo: reject un-ticks a recorded payment, approve puts it back in full; filters", async () => {
  const u = await mk("Ovr");
  const rec = await J(await record(u, { charges: [sub(await bill(u)).id], amount: 1500, file: "isbank-1500.pdf" }));
  assert.equal(rec.status, "ok");
  const list = await J(await admin(`/receipts?month=${M}&user_id=${u.id}&status=ok`));
  assert.equal(list.length, 1);
  assert.equal(list[0].expected_try, 1500);
  assert.equal(list[0].found_try, 1500); // parsed, informational
  assert.equal(list[0].overpaid_try, 0);
  assert.equal(list[0].user_name, "Ovr");
  assert.equal((await J(await admin(`/receipts?status=unreadable&user_id=${u.id}`))).length, 0);
  assert.equal((await admin("/receipts?status=nope")).status, 400);
  assert.equal((await t.fetch(`/api/admin/receipts/${rec.id}/approve`, { method: "POST", as: u })).status, 403);

  const rj = await J(await admin(`/receipts/${rec.id}/reject`, { method: "POST", body: { note: "Yanlış hesap" } }));
  assert.equal(rj.status, "mismatch");
  assert.match(rj.message, /Yanlış hesap/);
  const v = await bill(u);
  assert.equal(sub(v).status, "unpaid");
  assert.equal(v.kalan, 1500);
  assert.equal(sub(v).flag, null); // admin-rejected: no "!" flag, message lives on the receipt
  assert.equal((await J(await admin(`/receipts?status=mismatch&user_id=${u.id}`))).length, 1);

  const ap = await J(await admin(`/receipts/${rec.id}/approve`, { method: "POST", body: {} }));
  assert.equal(ap.status, "ok");
  const v2 = await bill(u);
  assert.equal(sub(v2).status, "paid");
  assert.equal(sub(v2).paid_by, "admin");
  assert.equal(v2.kalan, 0);
  assert.equal((await admin("/receipts/99999/approve", { method: "POST", body: {} })).status, 404);
});

test("waive + adjustment: kalan follows; paid can't be waived", async () => {
  const u = await mk("Waiv");
  const s = sub(await bill(u));
  assert.equal((await admin(`/charges/${s.id}/waive`, { method: "POST", body: {} })).status, 200);
  let v = await bill(u);
  assert.equal(sub(v).status, "waived");
  assert.equal(v.kalan, 0);
  assert.equal((await record(u, { amount: 1500, file: "enpara-1500.pdf" })).status, 400); // nothing to pay
  await admin(`/charges/${s.id}/waive`, { method: "POST", body: { waived: false } });
  assert.equal(sub(await bill(u)).status, "unpaid");

  assert.equal((await admin(`/users/${u.id}/charges`, { method: "POST", body: { month: M, amount_try: 250, note: "Anahtar kopyası" } })).status, 201);
  v = await bill(u);
  const adj = v.items.find((i) => i.kind === "adjustment");
  assert.equal(adj.note, "Anahtar kopyası");
  assert.equal(v.kalan, 1750);
  for (const body of [{ month: M, amount_try: -5, note: "x" }, { month: M, amount_try: 5, note: " " }, { month: "bad", amount_try: 5, note: "x" }, { month: M, amount_try: 1.5, note: "x" }])
    assert.equal((await admin(`/users/${u.id}/charges`, { method: "POST", body })).status, 400);
  assert.equal((await t.fetch(`/api/admin/users/${u.id}/charges`, { method: "POST", as: u, body: { month: M, amount_try: 5, note: "x" } })).status, 403);

  await record(u, { charges: [s.id], amount: 1500, file: "isbank-1500.pdf" });
  assert.equal((await admin(`/charges/${s.id}/waive`, { method: "POST", body: {} })).status, 409);
  assert.equal((await admin(`/charges/999999/waive`, { method: "POST", body: {} })).status, 404);
});

test("settings: validation, recipient check toggle", async () => {
  assert.equal((await admin("/settings", { method: "PUT", body: { iban: "TR12", holder: "" } })).status, 400);
  assert.equal((await admin("/settings", { method: "PUT", body: { iban: "", holder: "", requireRecipient: true } })).status, 400);
  const ok = await admin("/settings", { method: "PUT", body: { iban: "tr00 0000 0000 0000 0000 0000 00", holder: "Başka Kişi", requireRecipient: true } });
  assert.equal(ok.status, 200);
  assert.equal((await J(ok)).iban, "TR" + "0".repeat(24));
  const u = await mk("Rcp");
  // the recipient check now only shapes the PARSE suggestion - it can no longer approve or block anything by itself
  const out = await J(await parse("yapikredi-1500-en.pdf", 1500));
  assert.equal(out.status, "mismatch");
  assert.match(out.message, /alıcı/);
  // toggle off -> the same file now reads as a match
  await admin("/settings", { method: "PUT", body: { iban: "", holder: "", requireRecipient: false } });
  assert.equal((await J(await parse("yapikredi-1500-en.pdf", 1500))).status, "ok");
  assert.equal((await bill(u)).receipts.length, 0); // parsing stored nothing
  assert.equal((await t.fetch("/api/admin/settings", { as: t.member })).status, 403);
  const pay = await bill(u);
  assert.deepEqual(pay.pay_to, { iban: "", holder: "" });
});

test("admin overview: every member, their outstanding and the grand total (default = current month, everyone)", async () => {
  const ov = async (month) => J(await admin("/billing/overview" + (month ? `?month=${month}` : "")));
  const u = await mk("Borç Aysel");
  const base = (await ov()).users.find((x) => x.id === u.id);
  const b = await bill(u);
  assert.equal(base.outstanding_try, b.kalan); // same invariant as monthView's kalan
  assert.equal(base.debt_try, b.kalan);
  assert.ok(base.outstanding_try > 0);

  // defaults: no query params = current month, and EVERY active member is listed (not just the ones who owe)
  let o = await ov();
  assert.equal(o.month, M);
  assert.equal(o.total_outstanding_try, o.users.reduce((s, x) => s + x.outstanding_try, 0));
  assert.equal(o.total_debt_try, o.users.reduce((s, x) => s + x.debt_try, 0));
  assert.ok(o.total_outstanding_try >= o.users.find((x) => x.id === u.id).outstanding_try);
  assert.equal(o.owing_count, o.users.filter((x) => x.debt_try > 0).length);
  // the bootstrap admin (lowest id, from seed - t.boot) is an observer account, not a real member: hidden from the
  // overview and its totals (same as GET /users) and never gets a charge. A real admin (t.admin) IS listed + billed.
  assert.ok(!o.users.some((x) => x.id === t.boot.id), "bootstrap admin must not appear in the overview");
  assert.ok(o.users.some((x) => x.id === t.admin.id), "a real (non-bootstrap) admin is a billable member");
  assert.equal((await t.db.execute({ sql: "SELECT COUNT(*) n FROM charges WHERE user_id = ?", args: [t.boot.id] })).rows[0].n, 0);
  const active = (await t.db.execute({ sql: "SELECT id FROM users WHERE active = 1 AND id <> ?", args: [t.boot.id] })).rows;
  for (const a of active) assert.ok(o.users.some((x) => x.id === a.id), `user ${a.id} missing from the overview`);
  assert.ok(o.months.includes(M));

  // part-payment shrinks the member's outstanding by exactly what was applied
  const s = sub(b);
  await record(u, { charges: [s.id], amount: 500 });
  o = await ov();
  assert.equal(o.users.find((x) => x.id === u.id).outstanding_try, base.outstanding_try - 500);

  // an older unpaid month carries over: debt_try counts it, the selected month's outstanding does not
  const prev = `${+M.slice(0, 4) - 1}-${M.slice(5)}`;
  await admin(`/users/${u.id}/charges`, { method: "POST", body: { month: prev, amount_try: 300, note: "Eski borç" } });
  o = await ov();
  const row = o.users.find((x) => x.id === u.id);
  assert.equal(row.outstanding_try, base.outstanding_try - 500);
  assert.equal(row.debt_try, base.outstanding_try - 500 + 300);
  assert.equal((await ov(prev)).users.find((x) => x.id === u.id).outstanding_try, 300);

  // waived / voided charges are not owed
  await admin(`/charges/${s.id}/waive`, { method: "POST", body: { waived: true } });
  o = await ov();
  assert.equal(o.users.find((x) => x.id === u.id).outstanding_try, (await bill(u)).kalan);

  // guards
  assert.equal((await admin("/billing/overview?month=bad")).status, 400);
  assert.equal((await admin(`/billing/overview?month=${NEXT}`)).status, 200);
  assert.equal((await admin(`/billing/overview?month=${FAR}`)).status, 400);
  assert.equal((await t.fetch("/api/admin/billing/overview", { as: t.member })).status, 403);
});

test("admin per-user reservations: people + the booking charge's SNAPSHOT amount, cancelled ones keep their charge too", async () => {
  const a = await mk("Rez");
  const r1 = await J(await t.fetch("/api/reservations", { method: "POST", as: a, body: { start_ms: day(5), hours: 1, people: 2 } }));
  const r2 = await J(await t.fetch("/api/reservations", { method: "POST", as: a, body: { start_ms: day(6), hours: 1, people: 4 } }));
  assert.equal((await t.fetch(`/api/reservations/${r2.id}`, { method: "DELETE", as: a })).status, 200);

  const res = await J(await admin(`/users/${a.id}/reservations`));
  const row1 = res.find((r) => r.id === r1.id), row2 = res.find((r) => r.id === r2.id);
  assert.equal(row1.people, 2);
  assert.equal(row1.charge_try, 2 * 500); // per-person booking fee snapshot
  assert.equal(row1.cancelled_at, null);
  assert.equal(row2.people, 4);
  assert.equal(row2.charge_try, 4 * 500); // a cancelled reservation's charge is voided, not deleted - snapshot survives
  assert.ok(row2.cancelled_at);
});

test("future months: browsable to current + 12, planned rent is display-only (no charge row), past the cap = 400", async () => {
  const u = await mk("Gelecek");
  const b = await bill(u, NEXT);
  assert.equal(b.month, NEXT);
  assert.equal(b.future, true);
  assert.ok(b.months.includes(NEXT) && !b.months.includes(FAR));
  const planned = b.items.find((i) => i.kind === "subscription");
  assert.deepEqual([planned.id, planned.key, planned.status, planned.amount_try], [null, `sub:${NEXT}`, "upcoming", 1500]);
  assert.equal(b.projected_try, 1500);
  assert.equal(b.kalan, 0); // kalan = real charges only
  assert.equal(b.credit_cover, null); // no credit
  const n = async (m) => (await t.db.execute({ sql: "SELECT COUNT(*) n FROM charges WHERE user_id = ? AND month = ?", args: [u.id, m] })).rows[0].n;
  assert.equal(await n(NEXT), 0); // a READ never materialises a future month
  assert.equal((await J(await admin(`/users/${u.id}/billing?month=${NEXT}`))).projected_try, 1500);
  assert.equal((await admin(`/users/${u.id}/billing?month=${FAR}`)).status, 400);
  // the current month offers next month's planned rent as an "other month" item for the payment composer
  assert.ok((await bill(u)).other_open.some((i) => i.key === `sub:${NEXT}`));
});

test("one payment covers items across months: this month's extra + next month's rent (prepay materialises it)", async () => {
  const u = await mk("Çokay");
  await admin(`/charges/${sub(await bill(u)).id}/waive`, { method: "POST", body: {} });
  await admin(`/users/${u.id}/charges`, { method: "POST", body: { month: M, amount_try: 200, note: "kablo" } });
  const mic = (await bill(u)).items.find((i) => i.kind === "adjustment");
  const other = await mk("Başkası");
  assert.equal((await record(u, { charges: [sub(await bill(other)).id], amount: 100 })).status, 400); // not their charge
  assert.equal((await record(u, { charges: [`sub:${M}`], amount: 100 })).status, 400); // current month isn't "planned"
  assert.equal((await record(u, { charges: [`sub:${FAR}`], amount: 100 })).status, 400); // past the cap
  assert.equal((await record(u, { charges: ["abc"], amount: 100 })).status, 400);
  const out = await J(await record(u, { charges: [mic.id, `sub:${NEXT}`], amount: 1700 }));
  assert.equal(out.expected_try, 1700);
  assert.equal(out.applied_try, 1700);
  assert.equal(out.overpaid_try, 0);
  assert.deepEqual(out.charges.map((c) => [c.month, c.selected]), [[M, true], [NEXT, true]]);
  const nb = await bill(u, NEXT);
  assert.equal(sub(nb).status, "paid");
  assert.equal(nb.projected_try, 0);
  assert.ok(nb.receipts.some((r) => r.id === out.id)); // the receipt shows on the month it covers too
  assert.equal((await bill(u)).credit.balance_try, 0);
  assert.equal((await record(u, { charges: [`sub:${NEXT}`], amount: 100 })).status, 400); // already a charge (and paid)
  // undo gives it back: next month's rent is unpaid again (the charge itself stays, with its snapshot)
  await admin(`/receipts/${out.id}/reject`, { method: "POST", body: { note: "yanlış" } });
  assert.equal(sub(await bill(u, NEXT)).status, "unpaid");
});

test("credit looks forward (display-only) and can pay a future month's rent explicitly (from_credit), undo restores it", async () => {
  const u = await mk("Alacaklı");
  await admin(`/charges/${sub(await bill(u)).id}/waive`, { method: "POST", body: {} });
  await admin(`/users/${u.id}/charges`, { method: "POST", body: { month: M, amount_try: 200, note: "pedal" } });
  const pedal = (await bill(u)).items.find((i) => i.kind === "adjustment");
  await record(u, { charges: [pedal.id], amount: 1900 }); // 1700 surplus -> credit
  assert.equal((await bill(u)).credit.balance_try, 1700);
  const N2 = nextMonth(NEXT);
  let c1 = (await bill(u, NEXT)).credit_cover, c2 = (await bill(u, N2)).credit_cover;
  assert.deepEqual([c1.need_try, c1.covered_try], [1500, 1500]); // next month's rent fully covered by the credit
  assert.deepEqual([c2.prior_try, c2.available_try, c2.covered_try], [1500, 200, 200]); // what's left after next month
  assert.equal((await bill(u)).credit.balance_try, 1700); // nothing was applied by looking
  assert.equal((await t.db.execute({ sql: "SELECT COUNT(*) n FROM charges WHERE user_id = ? AND month = ?", args: [u.id, NEXT] })).rows[0].n, 0);

  assert.equal((await record(u, { month: NEXT, charges: [`sub:${NEXT}`], amount: 1800, fromCredit: true })).status, 400); // > credit
  assert.equal((await record(u, { month: NEXT, charges: [`sub:${NEXT}`], amount: 1500, fromCredit: true, file: "ziraat-1500.pdf" })).status, 400); // no PDF
  const out = await J(await record(u, { month: NEXT, charges: [`sub:${NEXT}`], amount: 1500, fromCredit: true }));
  assert.equal(out.from_credit, true);
  assert.equal(out.applied_try, 1500);
  assert.equal(out.overpaid_try, 0);
  assert.equal(sub(await bill(u, NEXT)).status, "paid");
  assert.equal((await bill(u)).credit.balance_try, 200);
  c2 = (await bill(u, N2)).credit_cover;
  assert.deepEqual([c2.prior_try, c2.covered_try], [0, 200]);
  await admin(`/receipts/${out.id}/reject`, { method: "POST", body: { note: "geri al" } });
  assert.equal((await bill(u)).credit.balance_try, 1700);
  assert.equal(sub(await bill(u, NEXT)).status, "unpaid");
  await admin(`/receipts/${out.id}/approve`, { method: "POST", body: {} }); // redo: consumes the credit again
  assert.equal((await bill(u)).credit.balance_try, 200);
  assert.equal(sub(await bill(u, NEXT)).status, "paid");
});
