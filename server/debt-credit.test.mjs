// ADR 0001 (docs/adr/0001-debt-and-credit-rules.md) block 1: paid cancel -> alacak, "Kalanı sil" vs "Tamamını iptal et",
// two credit-settlement kinds.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeTestApp } from "./test-helpers.mjs";
import { COOKIE } from "./lib/auth.mjs";
import { createDeletionRequest, resolveRequest } from "./lib/deletion-requests.mjs";
import { monthOf } from "./lib/tz.mjs";

const H = 3600_000;
const t = await makeTestApp();
after(() => t.close());

const at10 = (ms) => Math.floor((ms + 3 * H) / (24 * H)) * 24 * H - 3 * H + 10 * H;
const day = (n) => at10(Date.now() + (n + 1) * 24 * H);
const J = async (r) => r.json();
const mk = async (name) => {
  const u = await J(await t.fetch("/api/users", { method: "POST", as: t.admin, body: { name } }));
  return (await t.db.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [u.id] })).rows[0];
};
const admin = (path, opts = {}) => t.fetch("/api/admin" + path, { as: t.admin, ...opts });
const view = async (u, month) => J(await admin(`/users/${u.id}/billing?month=${month}`));
const credit = async (u, month) => (await view(u, month)).credit.balance_try;
const pay = (u, month, charges, amount) =>
  fetch(`${t.base}/api/admin/users/${u.id}/receipts?month=${month}&charges=${charges.join(",")}&amount_try=${amount}`, {
    method: "POST", headers: { "content-type": "application/pdf", cookie: `${COOKIE}=${t.admin.invite_token}` },
  });
/** Member books `people` on day n; returns { id, month, charge } (charge = the booking item). */
const book = async (u, n, people = 2) => {
  const start = day(n);
  const r = await J(await t.fetch("/api/reservations", { method: "POST", as: u, body: { start_ms: start, hours: 1, people } }));
  const month = monthOf(start);
  const charge = (await view(u, month)).items.find((i) => i.reservation?.id === r.id);
  return { id: r.id, start, month, charge };
};

test("cancel: a fully paid booking is voided and its money becomes alacak", async () => {
  const u = await mk("Paid Cancel");
  const b = await book(u, 3);
  assert.ok(b.charge.amount_try > 0);
  assert.equal((await pay(u, b.month, [b.charge.id], b.charge.amount_try)).status, 201);
  assert.equal(await credit(u, b.month), 0);
  assert.equal((await t.fetch(`/api/reservations/${b.id}`, { method: "DELETE", as: u })).status, 200);
  const v = await view(u, b.month);
  assert.equal(v.items.find((i) => i.id === b.charge.id).status, "voided");
  assert.equal(v.credit.balance_try, b.charge.amount_try);
});

test("cancel: a part-paid booking -> only the paid part becomes alacak, nothing left owed", async () => {
  const u = await mk("Part Cancel");
  const b = await book(u, 4);
  const part = b.charge.amount_try / 2;
  assert.equal((await pay(u, b.month, [b.charge.id], part)).status, 201);
  assert.equal((await t.fetch(`/api/reservations/${b.id}`, { method: "DELETE", as: u })).status, 200);
  const v = await view(u, b.month);
  assert.equal(v.credit.balance_try, part);
  assert.equal(v.items.find((i) => i.id === b.charge.id).remaining_try, 0);
});

test("deletion-request approval voids a paid booking too", async () => {
  const u = await mk("Del Req");
  const b = await book(u, 5);
  assert.equal((await pay(u, b.month, [b.charge.id], b.charge.amount_try)).status, 201);
  const later = b.start + 2 * H; // pretend the booking is in the past
  const reqId = await createDeletionRequest(t.db, u, b.id, "yanlışlıkla", later);
  await resolveRequest(t.db, t.admin, reqId, true, later);
  assert.equal(await credit(u, b.month), b.charge.amount_try);
});

test("waive a part-paid charge: 'rest' keeps the payment (no alacak), 'all' turns it into alacak; unwaive resets", async () => {
  const u = await mk("Waive Modes");
  const b = await book(u, 6);
  const part = b.charge.amount_try / 2;
  assert.equal((await pay(u, b.month, [b.charge.id], part)).status, 201);
  const waive = (body) => admin(`/charges/${b.charge.id}/waive`, { method: "POST", body });

  assert.equal((await waive({ waived: true, mode: "bogus" })).status, 400);
  assert.equal((await waive({ waived: true, mode: "rest" })).status, 200);
  let v = await view(u, b.month);
  let it = v.items.find((i) => i.id === b.charge.id);
  assert.equal(it.status, "waived");
  assert.equal(it.waive_kind, "rest");
  assert.equal(it.paid_try, part);
  assert.equal(v.credit.balance_try, 0);

  assert.equal((await waive({ waived: false })).status, 200);
  v = await view(u, b.month);
  it = v.items.find((i) => i.id === b.charge.id);
  assert.equal(it.status, "unpaid");
  assert.equal(it.remaining_try, b.charge.amount_try - part);

  assert.equal((await waive({ waived: true, mode: "all" })).status, 200);
  v = await view(u, b.month);
  assert.equal(v.items.find((i) => i.id === b.charge.id).waive_kind, null);
  assert.equal(v.credit.balance_try, part);
  // members can't waive
  assert.equal((await t.fetch(`/api/admin/charges/${b.charge.id}/waive`, { method: "POST", as: u, body: { waived: false } })).status, 403);
});

test("waive 'rest' on an unpaid charge is a plain waive", async () => {
  const u = await mk("Waive Unpaid");
  const b = await book(u, 7);
  assert.equal((await admin(`/charges/${b.charge.id}/waive`, { method: "POST", body: { waived: true, mode: "rest" } })).status, 200);
  assert.equal((await view(u, b.month)).items.find((i) => i.id === b.charge.id).waive_kind, null);
});

test("settle credit: refund (default) and forfeit kinds, shown in the history; bad kind 400; member 403", async () => {
  const u = await mk("Settle Kinds");
  const b = await book(u, 8);
  assert.equal((await pay(u, b.month, [b.charge.id], b.charge.amount_try)).status, 201);
  assert.equal((await t.fetch(`/api/reservations/${b.id}`, { method: "DELETE", as: u })).status, 200);
  const total = await credit(u, b.month);
  const settle = (body, as = t.admin) => t.fetch(`/api/admin/users/${u.id}/credit/settle`, { method: "POST", as, body });

  assert.equal((await settle({ amount_try: 100, kind: "gift" })).status, 400);
  assert.equal((await settle({ amount_try: 100 }, u)).status, 403);
  assert.equal((await settle({ amount_try: 100, note: "IBAN" })).status, 200);
  const r = await J(await settle({ kind: "forfeit", note: "hatalı rezervasyon" }));
  assert.equal(r.settled_try, total - 100);
  assert.equal(r.credit.balance_try, 0);
  assert.deepEqual(r.credit.settlements.map((s) => s.kind), ["forfeit", "refund"]);
});

// ---- block 2: "Alacaktan öde" (#4)
const mine = async (u) => J(await t.fetch("/api/billing", { as: u }));
/** member with alacak (a paid, then cancelled booking) and open debt (own unpaid aidat + optional extra charge) */
const withCreditAndDebt = async (name, extra = 0) => {
  const u = await mk(name);
  const b = await book(u, 9);
  assert.equal((await pay(u, b.month, [b.charge.id], b.charge.amount_try)).status, 201);
  assert.equal((await t.fetch(`/api/reservations/${b.id}`, { method: "DELETE", as: u })).status, 200);
  if (extra) assert.equal((await admin(`/users/${u.id}/charges`, { method: "POST", body: { month: (await mine(u)).month, amount_try: extra, note: "anahtar" } })).status, 201);
  return u;
};

test("admin Alacaktan öde: spends min(alacak, debt) oldest first; overview carries credit_try; 409 when nothing to do", async () => {
  const u = await withCreditAndDebt("Credit Pay Admin", 5000);
  const before = await mine(u);
  const credit0 = before.credit.balance_try, debt0 = before.debt_try;
  assert.ok(credit0 > 0 && debt0 > 0);
  const row = (await J(await admin(`/billing/overview?month=${before.month}`))).users.find((x) => x.id === u.id);
  assert.equal(row.credit_try, credit0);

  const r = await J(await admin(`/users/${u.id}/credit/pay`, { method: "POST" }));
  const spent = Math.min(credit0, debt0);
  assert.equal(r.paid_try, spent);
  const after = await mine(u);
  assert.equal(after.credit.balance_try, credit0 - spent);
  assert.equal(after.debt_try, debt0 - spent);
  const rc = after.receipts.find((x) => x.from_credit);
  assert.ok(rc, "a from-credit receipt lands in the döküm");
  assert.match(rc.message, /^Yönetici alacaktan mahsup etti/);
  // credit < debt here (5000 extra), so the alacak is gone and a second press is a 409
  assert.equal(after.credit.balance_try, 0);
  assert.equal((await admin(`/users/${u.id}/credit/pay`, { method: "POST" })).status, 409);
});

test("member Alacaktan öde on own page: member-voice note, min(alacak, debt) spent; undo = admin delete", async () => {
  const u = await withCreditAndDebt("Credit Pay Member");
  const { credit: { balance_try: credit0 }, debt_try: debt0 } = await mine(u);
  const r = await J(await t.fetch("/api/billing/credit/pay", { method: "POST", as: u }));
  assert.equal(r.paid_try, Math.min(credit0, debt0));
  const after = await mine(u);
  assert.equal(after.debt_try, debt0 - r.paid_try);
  const rc = after.receipts.find((x) => x.from_credit);
  assert.match(rc.message, /^Üye alacağından ödedi/);
  // the member can't delete it; the admin can, which restores credit + debt
  assert.equal((await t.fetch(`/api/billing/receipts/${rc.id}`, { method: "DELETE", as: u })).status, 409);
  assert.equal((await admin(`/receipts/${rc.id}`, { method: "DELETE" })).status, 200);
  const undone = await mine(u);
  assert.equal(undone.credit.balance_try, credit0);
  assert.equal(undone.debt_try, debt0);
});

test("member Alacaktan öde: no alacak -> 409, anon -> 401", async () => {
  const u = await mk("No Credit");
  assert.equal((await t.fetch("/api/billing/credit/pay", { method: "POST", as: u })).status, 409);
  assert.equal((await fetch(`${t.base}/api/billing/credit/pay`, { method: "POST" })).status, 401);
});

// ---- block 4: spent alacak taken back -> "Harcanan alacak" debt item (#8)
/** member whose alacak (from a paid, then cancelled booking) was spent with Alacaktan öde; returns the original receipt */
const spentCredit = async (name) => {
  const u = await withCreditAndDebt(name, 5000);
  const credit0 = (await mine(u)).credit.balance_try;
  assert.equal((await admin(`/users/${u.id}/credit/pay`, { method: "POST" })).status, 200);
  const before = await mine(u);
  assert.equal(before.credit.balance_try, 0);
  const orig = await origReceipt(u);
  return { u, credit0, debt0: before.debt_try, orig };
};
/** the booking's real payment (may sit in another month than the current one) */
const origReceipt = async (u) => (await J(await admin(`/receipts?user_id=${u.id}`))).find((x) => !x.from_credit && x.status === "ok");
const spentItem = async (u) => (await view(u, monthOf(Date.now()))).items.find((i) => i.kind === "adjustment" && /^Harcanan alacak/.test(i.note ?? ""));

test("delete a payment whose alacak was spent: alacak stays 0, a 'Harcanan alacak' item carries the debt; waive clears it", async () => {
  const { u, credit0, debt0, orig } = await spentCredit("Spent Delete");
  assert.equal((await admin(`/receipts/${orig.id}`, { method: "DELETE" })).status, 200);
  const after = await mine(u);
  assert.equal(after.credit.balance_try, 0, "never negative");
  assert.equal(after.debt_try, debt0 + credit0, "the spent amount counts as debt");
  const it = await spentItem(u);
  assert.equal(it.amount_try, credit0);
  assert.equal(it.note, "Harcanan alacak (ödeme silindi)");
  assert.equal(it.status, "unpaid");
  const ov = (await J(await admin(`/billing/overview?month=${after.month}`))).users.find((x) => x.id === u.id);
  assert.equal(ov.debt_try, debt0 + credit0);
  // waive ("Tamamını iptal et") forgives it: debt drops, alacak stays 0
  assert.equal((await admin(`/charges/${it.id}/waive`, { method: "POST", body: { waived: true } })).status, 200);
  const w = await mine(u);
  assert.equal(w.debt_try, debt0);
  assert.equal(w.credit.balance_try, 0);
});

test("reject an approved payment whose alacak was spent -> 'Harcanan alacak (ödeme geri alındı)', payable like any item", async () => {
  const { u, credit0, orig } = await spentCredit("Spent Reject");
  assert.equal((await admin(`/receipts/${orig.id}/reject`, { method: "POST", body: { note: "yanlış" } })).status, 200);
  const it = await spentItem(u);
  assert.equal(it.note, "Harcanan alacak (ödeme geri alındı)");
  assert.equal(it.amount_try, credit0);
  assert.equal((await mine(u)).credit.balance_try, 0);
  assert.equal((await pay(u, it.month, [it.id], it.amount_try)).status, 201);
  assert.equal((await spentItem(u)).status, "paid");
  assert.equal((await mine(u)).credit.balance_try, 0, "paying it doesn't create alacak");
});

test("delete a payment whose alacak was NOT spent: no 'Harcanan alacak' item", async () => {
  const u = await withCreditAndDebt("Unspent Delete");
  const orig = await origReceipt(u);
  assert.equal((await admin(`/receipts/${orig.id}`, { method: "DELETE" })).status, 200);
  assert.equal(await spentItem(u), undefined);
  assert.equal((await mine(u)).credit.balance_try, 0);
});

test("unwaive a part-paid item whose alacak was spent -> 'Harcanan alacak'", async () => {
  const u = await mk("Spent Unwaive");
  const m = monthOf(Date.now());
  const add = async (amount_try, note) => J(await admin(`/users/${u.id}/charges`, { method: "POST", body: { month: m, amount_try, note } }));
  const a = await add(1000, "anahtar");
  const aid = a.id ?? (await view(u, m)).items.find((i) => i.note === "anahtar").id;
  assert.equal((await pay(u, m, [aid], 400)).status, 201);
  assert.equal((await admin(`/charges/${aid}/waive`, { method: "POST", body: { waived: true, mode: "all" } })).status, 200);
  assert.equal(await credit(u, m), 400);
  assert.equal((await admin(`/users/${u.id}/credit/pay`, { method: "POST" })).status, 200); // spends it on the open aidat
  assert.equal(await credit(u, m), 0);
  assert.equal((await admin(`/charges/${aid}/waive`, { method: "POST", body: { waived: false } })).status, 200);
  const it = (await view(u, m)).items.find((i) => i.note === "Harcanan alacak");
  assert.equal(it?.amount_try, 400);
  assert.equal(await credit(u, m), 0);
});

// ---- block 6 (ADR 0001 #11): editing a paid booking
const editBooking = (u, b, people, start = b.start) =>
  t.fetch(`/api/reservations/${b.id}`, { method: "PATCH", as: u, body: { start_ms: start, hours: 1, people } });
const itemOf = async (u, month, chargeId) => (await view(u, month)).items.find((i) => i.id === chargeId);

test("paid booking, fewer people: the paid difference becomes alacak, the item stays paid", async () => {
  const u = await mk("Edit Down");
  const b = await book(u, 34, 3);
  const per = b.charge.amount_try / 3;
  assert.equal((await pay(u, b.month, [b.charge.id], b.charge.amount_try)).status, 201);
  const r = await editBooking(u, b, 2);
  assert.equal(r.status, 200);
  assert.deepEqual(await J(r), { ok: true, debt_try: 0, credit_try: per });
  const it = await itemOf(u, b.month, b.charge.id);
  assert.deepEqual([it.amount_try, it.status], [2 * per, "paid"]);
  assert.equal(await credit(u, b.month), per);
});

test("paid booking, more people: the same item is unpaid again for the difference", async () => {
  const u = await mk("Edit Up");
  const b = await book(u, 35, 2);
  const per = b.charge.amount_try / 2;
  assert.equal((await pay(u, b.month, [b.charge.id], b.charge.amount_try)).status, 201);
  const r = await editBooking(u, b, 3);
  assert.equal(r.status, 200);
  assert.deepEqual(await J(r), { ok: true, debt_try: per, credit_try: 0 });
  const it = await itemOf(u, b.month, b.charge.id);
  assert.deepEqual([it.amount_try, it.status, it.covered_try], [3 * per, "unpaid", 2 * per]);
  assert.equal(await credit(u, b.month), 0);
  // back down to 2: fully covered again -> paid, nothing owed back
  assert.deepEqual(await J(await editBooking(u, b, 2)), { ok: true, debt_try: -per, credit_try: 0 });
  assert.equal((await itemOf(u, b.month, b.charge.id)).status, "paid");
});

test("paid booking edited to 0 people: voided, all paid money -> alacak; part-paid, cheaper but still short stays unpaid", async () => {
  const u = await mk("Edit Zero");
  const b = await book(u, 36, 2);
  assert.equal((await pay(u, b.month, [b.charge.id], b.charge.amount_try)).status, 201);
  assert.deepEqual(await J(await editBooking(u, b, 0)), { ok: true, debt_try: 0, credit_try: b.charge.amount_try });
  assert.equal((await itemOf(u, b.month, b.charge.id)).status, "voided");
  assert.equal(await credit(u, b.month), b.charge.amount_try);

  const p = await mk("Edit Part");
  const c = await book(p, 37, 4);
  const per = c.charge.amount_try / 4;
  assert.equal((await pay(p, c.month, [c.charge.id], per)).status, 201); // 1 of 4 paid
  assert.deepEqual(await J(await editBooking(p, c, 2)), { ok: true, debt_try: -2 * per, credit_try: 0 });
  const it = await itemOf(p, c.month, c.charge.id);
  assert.deepEqual([it.amount_try, it.status, it.covered_try], [2 * per, "unpaid", per]);
});

test("unpaid booking edit: no money diff reported; another member can't edit it", async () => {
  const u = await mk("Edit Unpaid"), o = await mk("Edit Other");
  const b = await book(u, 38, 2);
  assert.deepEqual(await J(await editBooking(u, b, 3)), { ok: true, debt_try: 0, credit_try: 0 });
  assert.equal((await itemOf(u, b.month, b.charge.id)).amount_try, b.charge.amount_try / 2 * 3);
  assert.equal((await editBooking(o, b, 1)).status, 403);
});
