// Receipt (dekont) verifier: PDF -> text -> TRY amounts / bank ref -> compare with the expected sum. DB-free.
// Not security: catches honest mistakes (wrong amount, same dekont reused), not forgery.
import { createHash } from "node:crypto";
import { extractText as unpdfExtract, getDocumentProxy } from "unpdf";
import { toKurus } from "./money.mjs";

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

export async function extractText(buffer) {
  const pdf = await getDocumentProxy(new Uint8Array(buffer)); // copy: pdf.js detaches its input
  return (await unpdfExtract(pdf, { mergePages: true })).text;
}

// Same-length ASCII fold so labels match regardless of TR casing (İŞLEM/işlem, TUTARI/Tutarı). ₺ is kept.
const FOLD = { İ: "I", ı: "i", Ş: "S", ş: "s", Ğ: "G", ğ: "g", Ü: "U", ü: "u", Ö: "O", ö: "o", Ç: "C", ç: "c" };
const fold = (s) => s.replace(/[İıŞşĞğÜüÖöÇç]/g, (c) => FOLD[c]);

// "1.500,00" "1,500.00" "1500,5" "1.500" "1,500" -> number (TRY). Last separator is the decimal mark unless
// it is the only kind and followed by exactly 3 digits (then thousands: "1.500" = 1500, ambiguous "1,500" too).
function parseNum(s) {
  const seps = s.match(/[.,]/g) ?? [];
  if (!seps.length) return Number(s);
  const last = Math.max(s.lastIndexOf("."), s.lastIndexOf(","));
  const tail = s.slice(last + 1);
  const mixed = s.includes(".") && s.includes(",");
  const thousands = !mixed && (seps.length > 1 || tail.length === 3);
  if (thousands) return Number(s.replace(/[.,]/g, ""));
  return Number(s.slice(0, last).replace(/[.,]/g, "") + "." + tail);
}

const NUM = /(?<![\d.,])\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?(?![\d])|(?<![\d.,])\d+(?:[.,]\d{1,2})?(?![\d])/g;
const LABEL = /(?:tutar|miktar|toplam|odenen|gonderilen|bedel|amount|total)[^\d]{0,20}$/i;
const IGNORE = /(?:bakiye|komisyon|masraf|bsmv|limit|balance|fee)[^\d]{0,20}$/i;
const CUR_BEFORE = /(?:^|[^A-Za-z])(?:TRY|TL|₺)\s*$/i;
const CUR_AFTER = /^\s*(?:TRY|TL|₺)(?![A-Za-z])/i;

// All plausible TRY amounts (numbers, > 0, unique, in order of appearance). An amount must sit next to a currency
// marker (TL/TRY/₺) or a "Tutar/Miktar/…" label; if none qualifies, falls back to any number with 2 decimals.
// IBANs, dates, times and long digit runs (ref/account nos) are blanked first. Fee/balance lines are skipped.
export function parseAmounts(text) {
  const t = fold(text)
    .replace(/\bTR\d{2}(?:\s?[0-9A-Z]{4}){5}\s?[0-9A-Z]{2}\b/gi, " ")
    .replace(/\b\d{1,4}[./-]\d{1,2}[./-]\d{2,4}\b/g, " ")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")
    .replace(/\b\d{9,}\b/g, " ");
  const strict = [], loose = [];
  for (const m of t.matchAll(NUM)) {
    const v = parseNum(m[0]);
    if (!(v > 0) || IGNORE.test(t.slice(Math.max(0, m.index - 30), m.index))) continue;
    const before = t.slice(Math.max(0, m.index - 30), m.index);
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 6);
    if (CUR_BEFORE.test(before) || CUR_AFTER.test(after) || LABEL.test(before)) strict.push(v);
    else if (/[.,]\d{2}$/.test(m[0])) loose.push(v);
  }
  return [...new Set(strict.length ? strict : loose)];
}

// Bank reference / transaction number: "Referans No: X", "FAST REF NO: X" (Garanti), "Sorgu No", "Dekont No", "İşlem No", "Fiş No", "Transaction ID".
export function parseBankRef(text) {
  const re = /(?:referans|\bref|islem|dekont|sorgu|fis|transaction)\s*(?:no|numarasi|id|kodu)\.?\s*[:\-]?\s*([A-Za-z0-9-]{5,})/gi;
  for (const m of fold(text).matchAll(re)) if (/\d/.test(m[1])) return m[1].toUpperCase();
  return null;
}

export const fmtAmount = (n) =>
  new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

const norm = (s) => fold(s).toUpperCase().replace(/\s+/g, " ").trim();
const has = (set, v) => v != null && (set instanceof Set ? set.has(v) : [...(set ?? [])].includes(v));

// -> { status: 'ok'|'mismatch'|'unreadable'|'duplicate', diff?: {kind:'under'|'over', paidTry, deltaTry} (mismatch only), foundAmounts, expected, found, bankRef, sha256, text, message }
// expectedTry = whole TRY (may be fractional); compared to the kuruş. iban/holderName (optional): at least one must appear.
export async function verifyReceipt({ buffer, expectedTry, existing = {}, iban, holderName }) {
  const hash = sha256(buffer);
  const res = { status: "unreadable", foundAmounts: [], expected: expectedTry, found: null, bankRef: null, sha256: hash, text: "", message: "" };
  const done = (status, message) => Object.assign(res, { status, message });
  const expTxt = `${fmtAmount(expectedTry)} TL`;

  if (has(existing.hashes, hash)) return done("duplicate", "Bu dekont daha önce yüklenmiş.");
  try { res.text = await extractText(buffer); } catch { return done("unreadable", "PDF okunamadı, yönetici onayı bekleniyor."); }
  res.bankRef = parseBankRef(res.text);
  if (has(existing.bankRefs, res.bankRef)) return done("duplicate", `Bu dekont daha önce yüklenmiş (işlem no ${res.bankRef}).`);
  res.foundAmounts = parseAmounts(res.text);
  if (!res.foundAmounts.length) return done("unreadable", "PDF'ten tutar okunamadı, yönetici onayı bekleniyor.");

  const hit = res.foundAmounts.find((a) => toKurus(a) === toKurus(expectedTry));
  res.found = hit ?? res.foundAmounts[0];
  const recipientFails = () => {
    if (!iban && !holderName) return false;
    const flat = fold(res.text).toUpperCase().replace(/\s+/g, "");
    const ibanOk = iban && flat.includes(iban.replace(/\s+/g, "").toUpperCase());
    const nameOk = holderName && norm(res.text).includes(norm(holderName));
    return !ibanOk && !nameOk;
  };
  if (hit === undefined) {
    const list = res.foundAmounts.slice(0, 3).map((a) => `${fmtAmount(a)} TL`).join(", ");
    // Unambiguous (exactly ONE amount on the dekont, recipient fine): classify as under/over payment. Whole TRY, floored
    // (the sub-lira part of a payment is not credited); several candidate amounts stay a plain mismatch for the admin.
    if (res.foundAmounts.length === 1 && !recipientFails()) {
      const paidTry = Math.floor(toKurus(res.found) / 100);
      const wantTry = Math.ceil(toKurus(expectedTry) / 100);
      if (paidTry >= wantTry) res.diff = { kind: "over", paidTry, deltaTry: paidTry - wantTry };
      else if (paidTry >= 1) res.diff = { kind: "under", paidTry, deltaTry: wantTry - paidTry };
    }
    return done("mismatch", `PDF'te ${list} bulundu, beklenen ${expTxt}`);
  }
  if (recipientFails()) return done("mismatch", "Tutar doğru ama alıcı IBAN/isim dekontta bulunamadı.");
  return done("ok", `${expTxt} doğrulandı.`);
}
