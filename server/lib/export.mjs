// Admin backup export: every money record as JSON (+ a flat charges CSV). Secrets never leave: users.invite_token is
// omitted (it is the session cookie). Receipt PDFs are BLOBs -> excluded unless includePdf (base64, can be big).
const rows = async (db, sql) => (await db.execute(sql)).rows.map((r) => ({ ...r }));

export async function buildExport(db, { includePdf = false } = {}) {
  const [users, fees, reservations, attendees, charges, receiptCharges, costs, costTemplates, settings, alertKinds, alerts, creditSettlements, reservationAudit] = await Promise.all([
    rows(db, "SELECT id, name, phone, role, active, status, joined_month, created_at FROM users ORDER BY id"),
    rows(db, "SELECT * FROM fees ORDER BY effective_from, id"),
    rows(db, "SELECT * FROM reservations ORDER BY start_ms, id"),
    rows(db, "SELECT * FROM reservation_attendees ORDER BY reservation_id, user_id"),
    rows(db, "SELECT * FROM charges ORDER BY month, id"),
    rows(db, "SELECT * FROM receipt_charges ORDER BY receipt_id, charge_id"),
    rows(db, "SELECT * FROM costs ORDER BY month, id"),
    rows(db, "SELECT * FROM cost_templates ORDER BY category"),
    rows(db, "SELECT key, value FROM settings ORDER BY key"),
    rows(db, "SELECT * FROM alert_kinds ORDER BY sort, id"),
    rows(db, "SELECT * FROM alerts ORDER BY id"),
    rows(db, "SELECT * FROM credit_settlements ORDER BY id"),
    rows(db, "SELECT * FROM reservation_audit ORDER BY id"), // slot_holds are ephemeral: deliberately not exported
  ]);
  // metadata only: no pdf blob / extracted text (text can hold IBANs and names from the dekont)
  const receipts = (await rows(db, `SELECT id, user_id, month, filename, sha256, amounts_json, bank_ref, status, expected_try, found_try, uploaded_at, admin_note, applied_try, overpaid_try${includePdf ? ", pdf" : ""} FROM receipts ORDER BY id`))
    .map(({ pdf, ...r }) => (includePdf ? { ...r, pdf_base64: pdf ? Buffer.from(pdf).toString("base64") : null } : r));
  return {
    exported_at: new Date().toISOString(), version: 1, includes_pdf: includePdf, currency: "TRY (whole lira)",
    users, fees, reservations, reservation_attendees: attendees, charges, receipts, receipt_charges: receiptCharges,
    costs, cost_templates: costTemplates, settings, alert_kinds: alertKinds, alerts, credit_settlements: creditSettlements,
    reservation_audit: reservationAudit,
  };
}

const cell = (v) => {
  const s = v == null ? "" : String(v);
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Flat charges sheet joined with payer + receipt metadata. `;`-separated + BOM = opens cleanly in Turkish-locale Excel. */
export function chargesCsv(data) {
  const user = new Map(data.users.map((u) => [u.id, u.name]));
  const receipt = new Map(data.receipts.map((r) => [r.id, r]));
  // part-payments: what ok receipts already applied to a still-unpaid charge
  const part = new Map();
  for (const rc of data.receipt_charges ?? []) if (receipt.get(rc.receipt_id)?.status === "ok" && rc.applied_try) part.set(rc.charge_id, (part.get(rc.charge_id) ?? 0) + rc.applied_try);
  const head = ["charge_id", "ay", "uye", "tur", "tutar_try", "durum", "aciklama", "odeme_yontemi", "dekont_id", "dekont_durumu", "dekont_yuklenme", "banka_ref", "kismi_odenen_try"];
  const lines = data.charges.map((c) => {
    const r = c.paid_receipt_id != null ? receipt.get(c.paid_receipt_id) : null;
    const status = c.voided_at ? "iptal" : c.waived_at ? "muaf" : c.paid_receipt_id != null || c.paid_by ? "odendi" : "odenmedi";
    return [c.id, c.month, user.get(c.user_id), c.kind, c.amount_try, status, c.note, c.paid_by, c.paid_receipt_id, r?.status, r ? new Date(r.uploaded_at).toISOString() : "", r?.bank_ref, status === "odenmedi" ? part.get(c.id) : ""].map(cell).join(";");
  });
  return "﻿" + [head.join(";"), ...lines].join("\r\n") + "\r\n";
}
