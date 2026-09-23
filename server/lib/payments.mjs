// Receipt (dekont) flow on top of billing: store a member's dekont and tick the charges it pays.
//
// AUTOMATIC verification is (and stays) off. Payments are decided by an admin, either way they reach the system:
//  - admin-initiated: `recordPayment` stores a PDF (optional) and applies the amount the ADMIN typed.
//  - member-initiated (re-enabled 2026-09-22, admin-approval-only): `submitReceipt` stores the member's PDF as a
//    status='pending' row - no amount, no charge, no effect on any balance until an admin reviews it. `reviewReceipt`
//    turns a pending row into 'ok' (approve: the admin types the amount, same allocation as recordPayment) or
//    'mismatch' (reject: no allocation, a reason is shown to the member).
// The parser (lib/receipt.mjs) is kept, but only as an aid - `parseReceipt` is a read-only "does this PDF match?"
// suggestion that stores nothing and decides nothing; `submitReceipt` also only uses it to capture text/amounts for
// later reference. Under/over payment, part-payments and credit all go through the same allocation, so monthView /
// creditBalance keep their invariants; only the source of the number changed (parser -> admin, always).
import { randomUUID } from "node:crypto";
import { verifyReceipt, fmtAmount } from "./receipt.mjs";
import { COVERED_SQL, ensureMonthRaw, fail, isMonth, maxMonth, projectedSub } from "./billing.mjs";
import { creditBalance } from "./credits.mjs";
import { serial } from "./serial.mjs";
import { currentMonth } from "./tz.mjs";

export const MAX_PDF = 5 * 1024 * 1024;
/** admin_note prefix of a "paid from existing credit" receipt (overpaid_try < 0 is the real marker). */
export const CREDIT_NOTE = "Yönetici alacaktan mahsup etti";

export async function getSettings(db) {
  const s = Object.fromEntries((await db.execute("SELECT key, value FROM settings")).rows.map((r) => [r.key, r.value]));
  return { iban: s.community_iban || "", holder: s.community_holder || "", requireRecipient: s.receipt_require_recipient === "1" };
}

/** Turkish status line derived from stored fields (no message column). Under/over payment text comes from applied/overpaid. */
export function receiptMessage(r) {
  if (r.status === "pending") return "Yönetici incelemesini bekliyor.";
  const amounts = JSON.parse(r.amounts_json || "[]");
  const exp = r.expected_try, applied = r.applied_try ?? exp, over = r.overpaid_try ?? 0;
  const under = r.status === "ok" && applied < exp;
  const tail = under
    ? `Beklenen ${fmtAmount(exp)} TL için ${fmtAmount(applied)} TL ödemene sayıldı. Kalan: ${fmtAmount(exp - applied)} TL.`
    : r.status === "ok" && over > 0
      ? `Dekonttan ${fmtAmount(over)} TL artan tutar alacağın olarak kaydedildi: topluluk sana ${fmtAmount(over)} TL borçlu.`
      : "";
  if (r.admin_note != null) {
    if (r.status !== "ok") return `Yönetici reddetti: ${r.admin_note}`;
    const note = r.admin_note || "Yönetici onayladı"; // notes the admin wrote themselves get the "Yönetici onayladı:" prefix
    return [note.startsWith("Yönetici") ? note : `Yönetici onayladı: ${note}`, tail].filter(Boolean).join(" ");
  }
  if (r.status === "ok") return tail && under ? tail : [`${fmtAmount(exp)} TL doğrulandı.`, tail].filter(Boolean).join(" ");
  if (r.status === "duplicate") return "Bu dekont daha önce yüklenmiş.";
  if (r.status === "unreadable") return "PDF'ten tutar okunamadı, yönetici onayı bekleniyor.";
  if (amounts.some((a) => Math.round(a * 100) === Math.round(exp * 100))) return "Tutar doğru ama alıcı IBAN/isim dekontta bulunamadı.";
  return `PDF'te ${amounts.slice(0, 3).map((a) => `${fmtAmount(a)} TL`).join(", ")} bulundu, beklenen ${fmtAmount(exp)} TL`;
}

const COLS = "id, user_id, month, filename, sha256, amounts_json, bank_ref, status, expected_try, found_try, uploaded_at, admin_note, applied_try, overpaid_try";

/**
 * Which of a receipt's receipt_charges rows were the admin's SELECTED items vs. surplus that spilled onto the month's
 * other unpaid items. Not stored - derived from allocateRaw's write order (rowid): it inserts every picked charge
 * first (a 0 row too when the money ran out), and only reaches the "others" once every picked charge got its full
 * need, i.e. once the running applied sum == expected_try (= outstanding of the picked charges). So a row is
 * "selected" iff the applied sum BEFORE it is still < expected_try. Pure; rows must be in rowid order.
 */
export function markSelected(rows, expectedTry) {
  let acc = 0;
  return rows.map((c) => {
    const selected = expectedTry == null || acc < expectedTry;
    acc += Number(c.applied_try ?? 0);
    return { ...c, selected };
  });
}

/**
 * Receipts (no BLOB/text) with their covered charges + message. filter: {userId, month, status}.
 * paid_try = what was actually handed over (applied + overpaid - allocateRaw spends all of it, so the two add up);
 * spill_try = the part of it that went to non-selected items of the month; has_pdf = a dekont is attached (cash = no).
 */
export async function listReceipts(db, { id, userId, month, status, limit = 200 } = {}) {
  const where = [], args = [];
  if (id) { where.push("r.id = ?"); args.push(id); }
  if (userId) { where.push("r.user_id = ?"); args.push(userId); }
  // a month's receipts = recorded in it OR covering one of its charges (a payment may cover other months' items)
  if (month) {
    where.push("(r.month = ? OR EXISTS (SELECT 1 FROM receipt_charges xrc JOIN charges xc ON xc.id = xrc.charge_id WHERE xrc.receipt_id = r.id AND xc.month = ?))");
    args.push(month, month);
  }
  if (status) { where.push("r.status = ?"); args.push(status); }
  const rows = (await db.execute({
    sql: `SELECT ${COLS.split(", ").map((c) => "r." + c).join(", ")}, (r.pdf IS NOT NULL) AS has_pdf, u.name AS user_name
          FROM receipts r JOIN users u ON u.id = r.user_id ${where.length ? "WHERE " + where.join(" AND ") : ""}
          ORDER BY r.uploaded_at DESC, r.id DESC LIMIT ?`,
    args: [...args, limit],
  })).rows;
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const ch = (await db.execute({
    sql: `SELECT rc.receipt_id, rc.applied_try AS rc_applied, c.id, c.month, c.kind, c.amount_try, c.note, c.paid_receipt_id, c.voided_at, c.waived_at
          FROM receipt_charges rc JOIN charges c ON c.id = rc.charge_id WHERE rc.receipt_id IN (${ids.map(() => "?").join(",")}) ORDER BY rc.rowid`,
    args: ids,
  })).rows;
  return rows.map((r) => {
    const ok = r.status === "ok";
    const applied = ok ? r.applied_try ?? r.expected_try : null;
    const charges = markSelected(
      ch.filter((c) => c.receipt_id === r.id).map(({ id, month, kind, amount_try, note, rc_applied }) => ({ id, month, kind, amount_try, note, applied_try: rc_applied })),
      r.expected_try,
    );
    const fromCredit = ok && (r.overpaid_try ?? 0) < 0; // paid out of existing credit, no new money (see recordPayment)
    return {
      id: r.id, user_id: r.user_id, user_name: r.user_name, month: r.month, filename: r.filename, status: r.status,
      expected_try: r.expected_try, found_try: r.found_try, amounts: JSON.parse(r.amounts_json || "[]"), bank_ref: r.bank_ref,
      uploaded_at: r.uploaded_at, admin_note: r.admin_note, message: receiptMessage(r), has_pdf: !!r.has_pdf,
      applied_try: applied, overpaid_try: ok ? Math.max(0, r.overpaid_try ?? 0) : 0, from_credit: fromCredit,
      paid_try: ok ? applied + Math.max(0, r.overpaid_try ?? 0) : null,
      spill_try: ok ? charges.filter((c) => !c.selected).reduce((s, c) => s + Number(c.applied_try ?? 0), 0) : 0,
      remaining_try: ok ? Math.max(0, r.expected_try - applied) : 0,
      charges,
    };
  });
}

/** Unpaid charges of user+month with what is still owed on each, oldest first. Takes a db OR a tx; never locks. */
async function outstandingRaw(tx, userId, month) {
  return (await tx.execute({
    sql: `SELECT c.id, c.month, c.amount_try, ${COVERED_SQL} AS covered FROM charges c
          WHERE c.user_id = ? AND c.month = ? AND c.paid_receipt_id IS NULL AND c.voided_at IS NULL AND c.waived_at IS NULL ORDER BY c.id`,
    args: [userId, month],
  })).rows.map((c) => ({ id: c.id, month: c.month, amount_try: c.amount_try, need: Math.max(0, c.amount_try - Number(c.covered)) }));
}

/** `charges` query/body value -> tokens: charge ids (numbers) and `sub:YYYY-MM` (prepay a future month's planned rent). */
export function parseTokens(v) {
  const list = (Array.isArray(v) ? v : String(v).split(",")).map((x) => String(x).trim());
  if (!list.length || list.some((t) => !/^\d+$/.test(t) && !/^sub:\d{4}-(0[1-9]|1[0-2])$/.test(t))) throw fail(400, "Geçersiz kalem seçimi");
  return list.map((t) => (/^\d+$/.test(t) ? Number(t) : t));
}

/**
 * What a payment covers. tokens null = every unpaid item of `month` (old behaviour). Else the picked ids may belong to
 * ANY month of the user (a payment is no longer boxed into its own month - 2026-09-23), and `sub:YYYY-MM` picks a
 * future month's planned rent that isn't a charge yet (materialised INSIDE the payment tx by `materialiseRaw`; `id` is
 * null until then). Picked = oldest month first. `others` (where a surplus spills) stays the receipt month's other
 * unpaid items - a surplus is never silently pushed into other months; the admin picks those explicitly.
 */
async function pickRaw(db, user, month, tokens) {
  const unpaid = await outstandingRaw(db, user.id, month);
  if (!tokens) return { picked: unpaid.filter((c) => c.need > 0), others: [] };
  const ids = tokens.filter((t) => typeof t === "number");
  const subs = tokens.filter((t) => typeof t === "string").map((t) => t.slice(4));
  if (new Set(ids).size !== ids.length || new Set(subs).size !== subs.length) throw fail(400, "Geçersiz kalem seçimi");
  const bad = () => fail(400, "Seçilen kalemlerden biri geçersiz ya da zaten ödenmiş");
  const picked = [];
  if (ids.length) {
    const rows = (await db.execute({
      sql: `SELECT c.id, c.month, c.amount_try, ${COVERED_SQL} AS covered FROM charges c
            WHERE c.user_id = ? AND c.id IN (${ids.map(() => "?").join(",")})
              AND c.paid_receipt_id IS NULL AND c.voided_at IS NULL AND c.waived_at IS NULL`,
      args: [user.id, ...ids],
    })).rows.map((c) => ({ id: c.id, month: c.month, amount_try: c.amount_try, need: Math.max(0, c.amount_try - Number(c.covered)) }));
    if (rows.length !== ids.length || rows.some((c) => c.need <= 0 || c.month > maxMonth())) throw bad();
    picked.push(...rows);
  }
  for (const m of subs) {
    const p = await projectedSub(db, user, m);
    if (!p) throw bad(); // not a future browsable month, inactive member, rent already a charge (send its id), or fee 0
    picked.push({ id: null, sub: m, month: m, amount_try: p.amount_try, need: p.amount_try });
  }
  picked.sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : (a.id ?? Infinity) - (b.id ?? Infinity)));
  const pickedIds = new Set(picked.map((c) => c.id));
  return { picked, others: unpaid.filter((u) => u.need > 0 && !pickedIds.has(u.id)) };
}

/** Tx-only: turn picked `sub:` rents into real subscription charges (fee snapshot = today's fee for that month). */
async function materialiseRaw(tx, user, picked) {
  for (const c of picked) {
    if (!c.sub) continue;
    await ensureMonthRaw(tx, user, c.sub);
    const row = (await tx.execute({ sql: "SELECT id, amount_try FROM charges WHERE user_id = ? AND month = ? AND kind = 'subscription'", args: [user.id, c.sub] })).rows[0];
    if (!row || row.amount_try !== c.amount_try) throw fail(409, "Planlanan kira değişti, sayfayı yenile");
    c.id = row.id;
  }
}

/**
 * Tx-only: spread `paidTry` whole lira over `picked` (oldest first), then over the month's `others` (oldest first).
 * Writes the receipt_charges rows and ticks every charge that ends up FULLY covered with `paidBy` ('auto'|'admin').
 * Returns { applied, over } - over = the surplus nothing could be applied to = credit the community owes.
 */
async function allocateRaw(tx, receiptId, { picked, others = [], paidTry, paidBy }) {
  let left = paidTry, applied = 0;
  const full = [];
  const give = async (c, amount) => {
    left -= amount; applied += amount;
    if (amount === c.need) full.push(c.id);
    await tx.execute({ sql: "INSERT INTO receipt_charges (receipt_id, charge_id, applied_try) VALUES (?,?,?)", args: [receiptId, c.id, amount] });
  };
  for (const c of picked) await give(c, Math.min(left, c.need));
  for (const c of others) {
    if (left <= 0) break;
    if (c.need > 0) await give(c, Math.min(left, c.need));
  }
  if (full.length)
    await tx.execute({
      sql: `UPDATE charges SET paid_receipt_id = ?, paid_by = ? WHERE id IN (${full.map(() => "?").join(",")})`,
      args: [receiptId, paidBy, ...full],
    });
  return { applied, over: Math.max(0, left) };
}

const okKeys = async (db) => {
  const rows = (await db.execute("SELECT sha256, bank_ref FROM receipts WHERE status = 'ok'")).rows;
  return { hashes: rows.map((r) => r.sha256), bankRefs: rows.map((r) => r.bank_ref).filter(Boolean) };
};

/**
 * Admin aid only: "does this PDF match?" - parses the dekont and checks it against the already-counted ones.
 * Stores NOTHING and decides nothing; the returned amount is a suggestion the admin confirms or overrides.
 */
export async function parseReceipt(db, { buffer, expectedTry = 0 }) {
  if (!buffer?.length || buffer.subarray(0, 5).toString("latin1") !== "%PDF-") throw fail(400, "Lütfen dekontu PDF olarak yükle");
  const cfg = await getSettings(db);
  const v = await verifyReceipt({
    buffer, expectedTry, existing: await okKeys(db),
    ...(cfg.requireRecipient ? { iban: cfg.iban || undefined, holderName: cfg.holder || undefined } : {}),
  });
  // suggest the amount actually on the dekont, in whole TRY (sub-lira is never credited)
  const suggest = v.found == null ? null : Math.floor(v.found * 100 + 1e-6) / 100;
  return {
    status: v.status, message: v.message, amounts: v.foundAmounts, found_try: v.found ?? null,
    suggest_try: suggest == null ? null : Math.floor(suggest), bank_ref: v.bankRef, duplicate: v.status === "duplicate",
  };
}

/**
 * Member self-serve upload (admin-approval-only): stores the PDF as status='pending' with NO amount and NO charge
 * selection - it is invisible to every money calculation (COVERED_SQL / monthView / outstandingOverview all key off
 * status='ok'; a pending row has no receipt_charges rows to begin with) until an admin reviews it via reviewReceipt.
 * verifyReceipt is called purely to capture text/amounts/bank_ref for later reference - never to decide anything.
 */
export const submitReceipt = (db, user, { buffer, filename = null, now = Date.now() }) => serial(async () => {
  if (!buffer?.length || buffer.subarray(0, 5).toString("latin1") !== "%PDF-") throw fail(400, "Lütfen dekontu PDF olarak yükle");
  let v = null;
  try { v = await verifyReceipt({ buffer, expectedTry: 0 }); } catch { /* best-effort metadata only, never blocks the upload */ }
  let sha = `manual-${randomUUID()}`;
  if (v?.sha256) {
    const dup = (await db.execute({ sql: "SELECT id FROM receipts WHERE sha256 = ?1 OR sha256 LIKE ?1 || '#%'", args: [v.sha256] })).rows.length > 0;
    sha = dup ? `${v.sha256}#${now}` : v.sha256; // sha256 is UNIQUE: a re-filed dekont keeps its own row under a suffixed hash
  }
  const { lastInsertRowid } = await db.execute({
    sql: `INSERT INTO receipts (user_id, month, filename, pdf, sha256, text, amounts_json, bank_ref, status, expected_try, found_try, uploaded_at)
          VALUES (?,?,?,?,?,?,?,?, 'pending', NULL, ?, ?)`,
    args: [user.id, currentMonth(), String(filename ?? "").slice(0, 120) || null, buffer, sha,
      v ? v.text.slice(0, 20000) : null, JSON.stringify(v?.foundAmounts ?? []), v?.bankRef ?? null, v?.found ?? null, now],
  });
  return Number(lastInsertRowid);
});

/**
 * Admin records a payment by hand (or approves a member's own upload - see below). `paidTry` is the ADMIN's number -
 * the PDF, when given, is stored as evidence and parsed for metadata only (amounts / bank ref, never a decision).
 * chargeIds null = all of the month's unpaid items. expected = what is still OUTSTANDING on those charges.
 * The amount is then allocated exactly like before: oldest charge first, a charge turns paid only once fully
 * covered (part-payment shows as kalan), and a surplus pays the month's other unpaid items before what is left
 * becomes credit (receipts.overpaid_try -> creditBalance). Result: `{ receipt, duplicate }`.
 */
//
// fromCredit (2026-09-23): NO new money - the member's existing credit (creditBalance) pays the picked items. Stored as
// an ordinary ok receipt (no PDF, no spill onto other items) whose overpaid_try is NEGATIVE (= -applied): creditBalance
// sums overpaid_try of ok receipts, so the credit shrinks by exactly what was applied, and an undo (reject -> mismatch)
// gives back both the coverage and the credit in one step. No new table, no parallel ledger.
export const recordPayment = (db, user, { month, chargeIds = null, paidTry, buffer = null, filename = null, note = null, fromCredit = false, now = Date.now() }) => serial(async () => {
  if (!isMonth(month)) throw fail(400, "Geçersiz ay");
  if (!Number.isInteger(paidTry) || paidTry <= 0) throw fail(400, "Tutar pozitif tam sayı olmalı");
  const pdf = buffer?.length ? buffer : null;
  if (pdf && pdf.subarray(0, 5).toString("latin1") !== "%PDF-") throw fail(400, "Lütfen dekontu PDF olarak yükle");
  if (fromCredit) {
    if (pdf) throw fail(400, "Alacaktan ödemeye dekont eklenmez");
    if (paidTry > await creditBalance(db, user.id)) throw fail(400, "Tutar mevcut alacaktan fazla olamaz");
  }
  if (month <= currentMonth()) await ensureMonthRaw(db, user, month); // a future month is only materialised by an explicit sub: pick
  const { picked, others } = await pickRaw(db, user, month, chargeIds);
  if (!picked.length) throw fail(400, "Bu ay ödenecek kalem yok");
  const expected = picked.reduce((s, c) => s + c.need, 0);

  // no `existing` here: a duplicate must not short-circuit the parse - the admin is warned and decides
  const v = pdf ? await verifyReceipt({ buffer: pdf, expectedTry: expected }) : null;
  const dup = v
    ? (await db.execute({
        sql: "SELECT id FROM receipts WHERE sha256 = ?1 OR sha256 LIKE ?1 || '#%' OR (?2 IS NOT NULL AND bank_ref = ?2 AND status = 'ok')",
        args: [v.sha256, v.bankRef],
      })).rows.length > 0
    : false;
  // sha256 is UNIQUE: a re-filed dekont is kept under a suffixed hash (the `duplicate` warning goes to the admin)
  const sha = v ? (dup ? `${v.sha256}#${now}` : v.sha256) : `manual-${randomUUID()}`;
  const adminNote = String(note ?? "").trim().slice(0, 300);

  const tx = await db.transaction("write");
  try {
    const { lastInsertRowid } = await tx.execute({
      sql: `INSERT INTO receipts (user_id, month, filename, pdf, sha256, text, amounts_json, bank_ref, status, expected_try, found_try, uploaded_at, admin_note, applied_try, overpaid_try)
            VALUES (?,?,?,?,?,?,?,?, 'ok', ?,?,?,?,?,?)`,
      args: [user.id, month, String(filename ?? "").slice(0, 120) || null, pdf, sha, v ? v.text.slice(0, 20000) : null,
        JSON.stringify(v?.foundAmounts ?? []), v?.bankRef ?? null, expected, v?.found ?? null, now,
        `${fromCredit ? CREDIT_NOTE : "Yönetici kaydetti"}${adminNote ? `: ${adminNote}` : ""}`, 0, 0],
    });
    const id = Number(lastInsertRowid);
    await materialiseRaw(tx, user, picked);
    const { applied, over } = await allocateRaw(tx, id, { picked, others: fromCredit ? [] : others, paidTry, paidBy: "admin" });
    // from credit: the unspent rest simply stays credit (not consumed); what was applied is taken off the balance
    await tx.execute({ sql: "UPDATE receipts SET applied_try = ?, overpaid_try = ? WHERE id = ?", args: [applied, fromCredit ? -applied : over, id] });
    await tx.commit();
    return { id, duplicate: dup };
  } catch (e) {
    await tx.rollback().catch(() => {});
    throw e;
  } finally {
    tx.close();
  }
});

/**
 * Admin: approve or reject.
 * approve on a NON-ok receipt = "counts in full": every still-unpaid charge of it is paid (paid_by 'admin'), applied = what was outstanding.
 *   On an already-ok receipt (e.g. a part-payment) it only records the note - use waive to forgive a remainder.
 * reject un-ticks (ok -> mismatch); its part-payments and overpayment stop counting (status no longer 'ok'), and charges another
 *   auto-verified receipt had completed thanks to them go back to unpaid if no longer fully covered.
 *
 * A 'pending' receipt (member self-serve upload, not yet reviewed) is a different shape: it has no charges picked and
 * no amount yet, so it can't reuse the "NON-ok -> tick its own receipt_charges" path above (there are none). Reject
 * is simple (-> 'mismatch', no allocation, same as any other rejected receipt). Approve needs `extra.paidTry` (the
 * amount the admin read off the dekont) and optionally `extra.chargeIds` / `extra.month` (default: the receipt's own
 * upload month, then every unpaid item of it) - from there it is EXACTLY recordPayment's allocation, just written
 * into this row instead of inserting a new one (the member's own upload stays the paid record).
 */
export const reviewReceipt = (db, id, action, note, extra = {}, now = Date.now()) => serial(async () => {
  const r = (await db.execute({ sql: "SELECT * FROM receipts WHERE id = ?", args: [id] })).rows[0];
  if (!r) throw fail(404, "Dekont bulunamadı");
  const text = String(note ?? "").trim().slice(0, 300);
  if (action !== "approve" && action !== "reject") throw fail(400, "Geçersiz işlem");

  if (r.status === "pending") {
    if (action === "reject") {
      await db.execute({ sql: "UPDATE receipts SET status = 'mismatch', admin_note = ? WHERE id = ?", args: [text || "Reddedildi", id] });
      return;
    }
    const month = isMonth(extra.month) ? extra.month : r.month;
    if (!Number.isInteger(extra.paidTry) || extra.paidTry <= 0) throw fail(400, "Tutar pozitif tam sayı olmalı");
    const user = (await db.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [r.user_id] })).rows[0];
    if (!user) throw fail(404, "Üye bulunamadı");
    if (month <= currentMonth()) await ensureMonthRaw(db, user, month);
    const { picked, others } = await pickRaw(db, user, month, extra.chargeIds);
    if (!picked.length) throw fail(400, "Bu ay ödenecek kalem yok");
    const expected = picked.reduce((s, c) => s + c.need, 0);
    const tx = await db.transaction("write");
    try {
      await tx.execute({ sql: "UPDATE receipts SET month = ?, status = 'ok', expected_try = ?, admin_note = ? WHERE id = ?", args: [month, expected, text || "Yönetici onayladı", id] });
      await materialiseRaw(tx, user, picked);
      const { applied, over } = await allocateRaw(tx, id, { picked, others, paidTry: extra.paidTry, paidBy: "admin" });
      await tx.execute({ sql: "UPDATE receipts SET applied_try = ?, overpaid_try = ? WHERE id = ?", args: [applied, over, id] });
      await tx.commit();
    } catch (e) {
      await tx.rollback().catch(() => {});
      throw e;
    } finally {
      tx.close();
    }
    return;
  }

  const tx = await db.transaction("write");
  try {
    if (action === "approve") {
      if (r.status !== "ok") {
        const cs = (await tx.execute({
          sql: `SELECT c.id, c.amount_try, ${COVERED_SQL} AS covered FROM receipt_charges rc JOIN charges c ON c.id = rc.charge_id
                WHERE rc.receipt_id = ? AND c.paid_receipt_id IS NULL AND c.voided_at IS NULL AND c.waived_at IS NULL ORDER BY c.id`,
          args: [id],
        })).rows; // receipt still not ok here, so its own old allocations are not in `covered`
        let total = 0;
        for (const c of cs) {
          const need = Math.max(0, c.amount_try - Number(c.covered));
          total += need;
          await tx.execute({ sql: "UPDATE receipt_charges SET applied_try = ? WHERE receipt_id = ? AND charge_id = ?", args: [need, id, c.id] });
          await tx.execute({ sql: "UPDATE charges SET paid_receipt_id = ?, paid_by = 'admin' WHERE id = ?", args: [id, c.id] });
        }
        // a re-approved "from credit" receipt consumes credit = what it applies now (keeps coverage and credit in step)
        await tx.execute({
          sql: "UPDATE receipts SET status = 'ok', applied_try = ?1, overpaid_try = CASE WHEN overpaid_try < 0 THEN -?1 ELSE overpaid_try END, admin_note = ?2 WHERE id = ?3",
          args: [total, text || "Yönetici onayladı", id],
        });
      } else await tx.execute({ sql: "UPDATE receipts SET admin_note = ? WHERE id = ?", args: [text || "Yönetici onayladı", id] });
    } else {
      await tx.execute({ sql: "UPDATE receipts SET status = CASE status WHEN 'ok' THEN 'mismatch' ELSE status END, admin_note = ? WHERE id = ?", args: [text || "Reddedildi", id] });
      await tx.execute({ sql: "UPDATE charges SET paid_receipt_id = NULL, paid_by = NULL WHERE paid_receipt_id = ?", args: [id] });
      // charges of this receipt that a LATER receipt had "completed" thanks to this one may no longer be fully covered
      // (coverage, not paid_by, is the guard: a charge an admin approved in full keeps its own applied_try and survives)
      const cs = (await tx.execute({
        sql: `SELECT c.id, c.amount_try, ${COVERED_SQL} AS covered FROM receipt_charges rc JOIN charges c ON c.id = rc.charge_id
              WHERE rc.receipt_id = ? AND c.paid_receipt_id IS NOT NULL`,
        args: [id],
      })).rows;
      for (const c of cs) if (Number(c.covered) < c.amount_try) await tx.execute({ sql: "UPDATE charges SET paid_receipt_id = NULL, paid_by = NULL WHERE id = ?", args: [c.id] });
    }
    await tx.commit();
  } catch (e) {
    await tx.rollback().catch(() => {});
    throw e;
  } finally {
    tx.close();
  }
});
