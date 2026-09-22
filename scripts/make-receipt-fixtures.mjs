// Builds SYNTHETIC text-layer "dekont" PDFs into fixtures/receipts/. Wording mimics typical TR bank receipts; none are real.
// Usage: node scripts/make-receipt-fixtures.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("../fixtures/receipts/", import.meta.url));
// Non-WinAnsi chars -> single bytes 128.. via a /Differences encoding (glyph names pdf.js maps back to Unicode).
const EXTRA = [["Ş", "Scedilla"], ["ş", "scedilla"], ["Ğ", "Gbreve"], ["ğ", "gbreve"], ["İ", "Idotaccent"], ["ı", "dotlessi"],
  ["₺", "uni20BA"], ["Ç", "Ccedilla"], ["ç", "ccedilla"], ["Ö", "Odieresis"], ["ö", "odieresis"], ["Ü", "Udieresis"], ["ü", "udieresis"]];
const CODE = new Map(EXTRA.map(([ch], i) => [ch, 128 + i]));

const esc = (line) => Buffer.from([...line].map((c) => CODE.get(c) ?? c.charCodeAt(0)))
  .toString("latin1").replace(/[\\()]/g, "\\$&");

function pdf(lines) {
  const content = lines.length
    ? `BT /F1 12 Tf 14 TL 50 780 Td\n${lines.map((l) => `(${esc(l)}) Tj T*`).join("\n")}\nET`
    : "0.8 g 50 500 400 250 re f"; // no text layer = "scanned" stand-in
  const diffs = EXTRA.map(([, n], i) => (i ? "" : "128 ") + `/${n}`).join(" ");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [${diffs}] >> >>`,
  ];
  let out = "%PDF-1.4\n"; const offs = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(out, "latin1")); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const IBAN = "TR33 0006 1005 1978 6457 8413 26";
const files = {
  "papara-1500.pdf": ["Papara", "Para Transferi Dekontu", "Gönderen: AYŞE YILMAZ", "Alıcı: PROVA ODA TOPLULUĞU", `IBAN: ${IBAN}`,
    "Tarih: 03.09.2026 14:32:07", "İşlem No: 8842913375", "₺1.500,00", "Komisyon: ₺0,00"],
  "enpara-1500.pdf": ["Enpara.com", "FAST Gönderimi Dekontu", "Gönderen Hesap: Ayşe Yılmaz", "Alıcı Adı: Prova Oda Topluluğu",
    `Alıcı IBAN: ${IBAN}`, "İşlem Tarihi: 03/09/2026", "Tutar 1.500,00 TL", "Referans No: FST2609031234567", "Kalan Bakiye 12.340,50 TL"],
  "ziraat-1500.pdf": ["T.C. ZİRAAT BANKASI A.Ş.", "MOBİL BANKACILIK - EFT / FAST DEKONTU", "ALICI ADI SOYADI : PROVA ODA TOPLULUĞU",
    `ALICI IBAN : ${IBAN}`, "İŞLEM TUTARI : 1500,00 TL", "İŞLEM TARİHİ : 03.09.2026", "SORGU NO : 20260903FST00981234", "MASRAF : 0,00 TL"],
  "isbank-1500.pdf": ["TÜRKİYE İŞ BANKASI A.Ş.", "İşCep Para Transferi Dekontu", "Alıcı Ünvanı : PROVA ODA TOPLULUĞU", `Alıcı Hesap : ${IBAN}`,
    "Gönderilen Tutar : TRY 1.500,00", "Dekont No : 5590127", "İşlem Tarihi : 3 Eylül 2026 14:35"],
  "yapikredi-1500-en.pdf": ["Yapı Kredi Mobile Receipt", "Transfer Amount: 1,500.00 TRY", "Beneficiary: PROVA ODA TOPLULUGU", "Transaction ID: YK-77120934",
    "Date: 2026-09-03"],
  "enpara-1000-mismatch.pdf": ["Enpara.com", "FAST Gönderimi Dekontu", "Alıcı Adı: Prova Oda Topluluğu", `Alıcı IBAN: ${IBAN}`,
    "Tutar 1.000,00 TL", "Referans No: FST2609039999999"],
  // amount edge cases for the under/over payment logic (server/billing.test.mjs)
  "enpara-1500-50-kurus.pdf": ["Enpara.com", "FAST Gönderimi Dekontu", "Alıcı Adı: Prova Oda Topluluğu", `Alıcı IBAN: ${IBAN}`,
    "Tutar 1.500,50 TL", "Referans No: FST2609035550050"],
  "enpara-two-amounts.pdf": ["Enpara.com", "FAST Gönderimi Dekontu", "Alıcı Adı: Prova Oda Topluluğu", `Alıcı IBAN: ${IBAN}`,
    "Tutar 1.000,00 TL", "Tutar 800,00 TL", "Referans No: FST2609036660800"],
  "scanned-no-text.pdf": [],
};

mkdirSync(OUT, { recursive: true });
for (const [name, lines] of Object.entries(files)) writeFileSync(OUT + name, pdf(lines));
console.log(`wrote ${Object.keys(files).length} fixtures to ${OUT}`);
