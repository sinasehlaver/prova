#!/usr/bin/env node
// Usage: node receipt-check.mjs dekont.pdf 1500 [--iban TR..] [--name "Ad Soyad"]
// Prints parsed amounts + verdict. Exit 0 = ok, 1 = mismatch/duplicate, 2 = unreadable, 64 = bad usage.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { verifyReceipt, fmtAmount } from "./server/lib/receipt.mjs";

const { values, positionals: [file, exp] } = parseArgs({ allowPositionals: true, options: { iban: { type: "string" }, name: { type: "string" } } });
const expectedTry = Number(String(exp ?? "").replace(",", "."));
if (!file || !(expectedTry > 0)) { console.error('usage: node receipt-check.mjs dekont.pdf <expectedTRY> [--iban TR..] [--name "Ad Soyad"]'); process.exit(64); }

const r = await verifyReceipt({ buffer: readFileSync(file), expectedTry, iban: values.iban, holderName: values.name });
console.log(`amounts : ${r.foundAmounts.map(fmtAmount).join(" | ") || "(none)"}`);
console.log(`bank ref: ${r.bankRef ?? "(none)"}`);
console.log(`sha256  : ${r.sha256}`);
console.log(`${r.status === "ok" ? "PASS" : "FAIL"} [${r.status}] ${r.message}`);
process.exit({ ok: 0, mismatch: 1, duplicate: 1, unreadable: 2 }[r.status]);
