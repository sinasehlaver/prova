// In-process write mutex. libSQL file txs each get their own connection; serialising every write path avoids
// SQLITE_BUSY between concurrent requests. Never nest serial() inside serial() (deadlock).
// ponytail: single server process assumed. Multi-instance -> rely on the tx alone + retry.
let chain = Promise.resolve();
export const serial = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };
