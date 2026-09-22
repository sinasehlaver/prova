import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseAmounts, parseBankRef, verifyReceipt, sha256 } from "./lib/receipt.mjs";

const fx = (n) => readFileSync(new URL(`../fixtures/receipts/${n}`, import.meta.url));
const IBAN = "TR33 0006 1005 1978 6457 8413 26";

test("parseAmounts: formats", () => {
  const cases = [
    ["Tutar 1.500,00 TL", [1500]], ["1500,00 TL", [1500]], ["1500 TL", [1500]], ["TRY 1.500,00", [1500]],
    ["₺1.500", [1500]], ["₺ 1.500,50", [1500.5]], ["Amount: 1,500.00 TRY", [1500]], ["1.500 TL", [1500]],
    ["1,500 TL", [1500]], ["Tutar: 12.345,67", [12345.67]], ["750,5 TL", [750.5]], ["₺1.000.000,00", [1000000]],
  ];
  for (const [txt, want] of cases) assert.deepEqual(parseAmounts(txt), want, txt);
});

test("parseAmounts: ignores IBAN, dates, times, ref nos, fees, balance", () => {
  const txt = `IBAN ${IBAN}\nTarih 03.09.2026 14:32:07\nİşlem No: 8842913375\nHesap 1234567890123\nKomisyon: 0,00 TL\nKalan Bakiye 12.340,50 TL\nTutar 1.500,00 TL`;
  assert.deepEqual(parseAmounts(txt), [1500]);
});

test("parseAmounts: several amounts kept unique, in order; loose fallback; nothing", () => {
  assert.deepEqual(parseAmounts("1.000,00 TL ve 500,00 TL, tekrar 1.000,00 TL"), [1000, 500]);
  assert.deepEqual(parseAmounts("Toplam\n1.250,00"), [1250]);
  assert.deepEqual(parseAmounts("Kabul 3 kişi, kat 12"), []);
});

test("parseBankRef", () => {
  assert.equal(parseBankRef("Referans No: fst26090312"), "FST26090312");
  assert.equal(parseBankRef("SORGU NO : 2026FST0098"), "2026FST0098");
  assert.equal(parseBankRef("İşlem No: 8842913375"), "8842913375");
  // real Garanti "HESAPTAN FAST" layout (2026-09-21, numbers replaced): ref label is "FAST REF NO", not "Referans No"
  assert.equal(parseBankRef("FAST REF NO : 1234567890\nYÜZEN ODA\nSIRA NO : 2026-05-29-12.40.22.511320 TUTAR : - 14.000,00 TL"), "1234567890");
  assert.deepEqual(parseAmounts("MASRAF : 15,96 TL BSMV : 0,80 TL\nKOMİSYON TOPLAMI : 16,76 TL\nTUTAR : - 14.000,00 TL"), [14000]);
  assert.equal(parseBankRef("Dekont No : abc"), null); // too short / no digit
  assert.equal(parseBankRef("nothing here"), null);
});

test("verifyReceipt: ok for every bank fixture, kuruş-exact", async () => {
  for (const n of ["papara-1500", "enpara-1500", "ziraat-1500", "isbank-1500"]) {
    const r = await verifyReceipt({ buffer: fx(`${n}.pdf`), expectedTry: 1500, iban: IBAN });
    assert.equal(r.status, "ok", `${n}: ${r.message}`);
    assert.equal(r.found, 1500);
    assert.equal(r.sha256, sha256(fx(`${n}.pdf`)));
  }
  const en = await verifyReceipt({ buffer: fx("yapikredi-1500-en.pdf"), expectedTry: 1500, holderName: "Prova Oda Topluluğu" });
  assert.equal(en.status, "ok"); // English-format 1,500.00 + name-only recipient check (folded TR casing)
});

test("verifyReceipt: mismatch message, off-by-one kuruş", async () => {
  const r = await verifyReceipt({ buffer: fx("enpara-1000-mismatch.pdf"), expectedTry: 1500 });
  assert.equal(r.status, "mismatch");
  assert.equal(r.message, "PDF'te 1.000,00 TL bulundu, beklenen 1.500,00 TL");
  assert.deepEqual(r.foundAmounts, [1000]);
  assert.deepEqual(r.diff, { kind: "under", paidTry: 1000, deltaTry: 500 }); // one unambiguous amount -> under/over classification
  assert.deepEqual((await verifyReceipt({ buffer: fx("papara-1500.pdf"), expectedTry: 500 })).diff, { kind: "over", paidTry: 1500, deltaTry: 1000 });
  // 1.500,50 vs 1.500: over by less than a lira -> delta 0 (sub-lira part is not credited)
  assert.deepEqual((await verifyReceipt({ buffer: fx("enpara-1500-50-kurus.pdf"), expectedTry: 1500 })).diff, { kind: "over", paidTry: 1500, deltaTry: 0 });
  // several candidate amounts: no classification, plain mismatch
  const two = await verifyReceipt({ buffer: fx("enpara-two-amounts.pdf"), expectedTry: 1500 });
  assert.equal(two.status, "mismatch");
  assert.equal(two.diff, undefined);
  // wrong recipient + wrong amount: no classification either
  const badTo = await verifyReceipt({ buffer: fx("enpara-1000-mismatch.pdf"), expectedTry: 1500, iban: "TR00 0000 0000 0000 0000 0000 00" });
  assert.equal(badTo.diff, undefined);
  assert.equal((await verifyReceipt({ buffer: fx("enpara-1500.pdf"), expectedTry: 1500.01 })).status, "mismatch");
});

test("verifyReceipt: recipient check", async () => {
  const bad = await verifyReceipt({ buffer: fx("enpara-1500.pdf"), expectedTry: 1500, iban: "TR00 0000 0000 0000 0000 0000 00", holderName: "Başka Kişi" });
  assert.equal(bad.status, "mismatch");
  const nameOnly = await verifyReceipt({ buffer: fx("ziraat-1500.pdf"), expectedTry: 1500, iban: "TR00 0000 0000 0000 0000 0000 00", holderName: "prova oda topluluğu" });
  assert.equal(nameOnly.status, "ok"); // iban OR name
});

test("verifyReceipt: unreadable (no text layer / not a PDF)", async () => {
  const r = await verifyReceipt({ buffer: fx("scanned-no-text.pdf"), expectedTry: 1500 });
  assert.equal(r.status, "unreadable");
  assert.equal((await verifyReceipt({ buffer: Buffer.from("not a pdf"), expectedTry: 1500 })).status, "unreadable");
});

test("verifyReceipt: duplicate by sha256 and by bank ref", async () => {
  const buffer = fx("enpara-1500.pdf");
  const first = await verifyReceipt({ buffer, expectedTry: 1500 });
  const byHash = await verifyReceipt({ buffer, expectedTry: 1500, existing: { hashes: new Set([first.sha256]) } });
  assert.equal(byHash.status, "duplicate");
  const byRef = await verifyReceipt({ buffer, expectedTry: 1500, existing: { hashes: [], bankRefs: [first.bankRef] } });
  assert.equal(byRef.status, "duplicate");
  assert.equal((await verifyReceipt({ buffer, expectedTry: 1500, existing: { hashes: ["x"], bankRefs: ["y"] } })).status, "ok");
});
