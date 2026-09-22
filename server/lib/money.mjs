// Money = integer whole TRY in every *_try column. Kuruş only appears when comparing parsed receipt amounts.
export const fmtTRY = (n) =>
  new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY", maximumFractionDigits: 2 }).format(n);
export const toKurus = (tryAmount) => Math.round(tryAmount * 100);
