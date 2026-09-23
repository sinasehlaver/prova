// Browser check, driven by scripts/verify.sh (sets PROVA_URL, PROVA_TOKEN, PROVA_SHOTS). Never run directly.
import { launch } from "../../.claude/scripts/browser.mjs";

const BASE = process.env.PROVA_URL;
const TOKEN = process.env.PROVA_TOKEN;
const SHOTS = process.env.PROVA_SHOTS;
let ctx;
try { ctx = await launch(); } catch (e) { console.warn("SKIP browser check:", e.message); process.exit(0); }
const { browser, page, errors } = ctx;
const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };

try {
  await page.setViewportSize({ width: 390, height: 844 });
  // logged out: login landing + invalid-link notice
  await page.goto(`${BASE}/?davet=gecersiz`, { waitUntil: "networkidle" });
  await page.waitForSelector(".login-card");
  if (!(await page.textContent(".notice")).includes("geçersiz")) fail("invalid-link notice missing");
  await page.screenshot({ path: `${SHOTS}/login.png` });
  // self-signup: the login screen offers "Hesap oluştur"; a new account lands on the "Onay bekleniyor" screen, not the app
  await page.click(".login-card .link");
  await page.fill(".signup-form .field input >> nth=0", "Tarayıcı Deneme");
  await page.fill('.signup-form input[type="email"]', `tarayici-${Date.now()}@example.com`);
  await page.fill('.signup-form input[type="password"]', "deneme12345");
  await page.click(".signup-form .btn.primary");
  await page.waitForFunction(() => document.querySelector(".login-card h1")?.textContent === "Onay bekleniyor");
  if (await page.$(".tabbar")) fail("pending account must not see the app");
  await page.screenshot({ path: `${SHOTS}/pending.png` });
  await page.click(".login-actions .btn.ghost"); // Çıkış yap -> back to the login screen
  await page.waitForSelector(".login-card .link");

  // bootstrap (observer) admin: calendar is read-only - no "Rezervasyon yap", an explanatory note, free hours not clickable
  await page.goto(`${BASE}/i/${process.env.PROVA_BOOT_TOKEN}`, { waitUntil: "networkidle" });
  await page.waitForSelector(".observer-note");
  if (await page.$(".cal .page-head .btn.primary")) fail("bootstrap admin must not see the 'Rezervasyon yap' button");
  if (await page.$("button.slot")) fail("bootstrap admin's free hours must not be clickable");
  await page.screenshot({ path: `${SHOTS}/calendar-observer.png` });

  // invite link (a REAL admin, created by verify.sh) -> logged in, tab bar incl. Admin
  await page.goto(`${BASE}/i/${TOKEN}`, { waitUntil: "networkidle" });
  await page.waitForSelector(".tabbar");
  const tabs = await page.$$eval(".tab", (e) => e.map((x) => x.textContent));
  if (tabs.join("|") !== "Takvim|Ödemelerim|Uyarılar|Yönetim") fail("tabs: " + tabs);

  // top-bar name -> profile sheet (name/phone form, role, joined month, logout); hash always names the rendered tab
  await page.click(".who-btn");
  await page.waitForSelector(".sheet .profile-facts");
  if (!(await page.textContent(".sheet .profile-facts")).includes("Yönetici")) fail("profile should show the admin role");
  if (!(await page.$(".sheet .btn.danger"))) fail("profile is missing the logout button");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".sheet"));
  if (new URL(page.url()).hash !== "#calendar") fail("hash should follow the rendered tab: " + page.url());

  // Takvim: day strip + slot list, book via the sheet (first free future slot; tomorrow 12:00 so it is always future), see it, cancel it
  await page.waitForSelector(".strip-day");
  await page.click(".strip-day >> nth=1");
  await page.click(".slot:not([disabled]) >> nth=4"); // 12:00
  await page.waitForSelector(".sheet");
  await page.fill(".sheet input", "verify prova");
  await page.click('.stepper button[aria-label="Bir kişi artır"]'); // people 1 -> 2
  if ((await page.textContent(".stepper output")).trim() !== "2") fail("people stepper did not reach 2");
  await page.screenshot({ path: `${SHOTS}/calendar-sheet.png` });
  await page.click(".sheet .btn.primary");
  await page.waitForSelector(".res.mine");
  await page.waitForSelector(".sheet", { state: "detached" });
  await page.screenshot({ path: `${SHOTS}/calendar.png` });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForSelector(".cal-week");
  await page.screenshot({ path: `${SHOTS}/calendar-week.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForSelector(".strip-day");
  await page.click(".strip-day >> nth=1");
  await page.click(".res.mine");
  await page.click(".sheet .btn.danger");
  await page.click(".sheet .btn.danger");
  await page.waitForFunction(() => !document.querySelector(".res.mine"));

  // Gün / Hafta toggle: choice is remembered (localStorage prova.calview); the 390px week grid must not overflow
  await page.click('.view-toggle [role=radio]:has-text("Hafta")');
  await page.waitForSelector(".cal-week");
  if ((await page.evaluate(() => localStorage.getItem("prova.calview"))) !== "week") fail("calendar view choice not remembered");
  if ((await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) > 1) fail("week view overflows at 390px");
  await page.click('.view-toggle [role=radio]:has-text("Gün")');
  await page.waitForSelector(".cal-day");
  await page.evaluate(() => localStorage.removeItem("prova.calview"));

  // Hard gate: an admin cancelling ANOTHER member's booking. A member books via API (session = regenerated invite token),
  // the admin's browser then needs the danger dialog: reason + typed first name before the button arms.
  const members = await page.evaluate(() => fetch("/api/members").then((r) => r.json()));
  const other = members.find((m) => m.name === "Ali Yılmaz"); // seeded demo member (not the pending signup / API-smoke ones)
  if (!other) fail("seeded member Ali Yılmaz not found");
  const otherTok = await page.evaluate((id) => fetch(`/api/users/${id}/regenerate-invite`, { method: "POST" }).then((r) => r.json()), other.id);
  if (!otherTok.invite_token) fail("regenerate-invite did not return a token (verify.mjs needs it)");
  const H = 3600_000, D = 24 * H;
  const start = Math.floor((Date.now() + 3 * H) / D) * D - 3 * H + 6 * D + 15 * H; // day +6, 15:00 Istanbul
  const made = await fetch(`${BASE}/api/reservations`, {
    method: "POST", headers: { "content-type": "application/json", cookie: `prova_session=${otherTok.invite_token}` },
    body: JSON.stringify({ start_ms: start, hours: 1 }),
  });
  if (made.status !== 201) fail("member booking for the gate check: " + made.status);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".strip-day");
  await page.click(".strip-day >> nth=6");
  await page.click(".res:not(.mine)");
  await page.click(".sheet .btn.danger"); // "Yönetici olarak iptal et…" opens the gate, it does not cancel
  await page.waitForSelector(".danger-zone");
  const go = page.locator(".danger-zone .btn.danger.solid");
  if (!(await go.isDisabled())) fail("danger button must start disabled");
  await page.fill(".danger-zone .field >> nth=1 >> input", "oda bakıma alınacak");
  if (!(await go.isDisabled())) fail("danger button must stay disabled without the typed name");
  await page.fill(".danger-zone .field >> nth=0 >> input", other.name.split(" ")[0].toUpperCase());
  if (await go.isDisabled()) fail("danger button should arm after reason + typed name");
  await page.screenshot({ path: `${SHOTS}/calendar-danger.png` });
  await go.click();
  await page.waitForFunction(() => !document.querySelector(".res"));

  // Soft hold: Ali opens the booking sheet on day +3 18:00 (API hold) -> the admin's calendar shows "Rezerve ediliyor", not a bookable slot
  const memberHdr = { "content-type": "application/json", cookie: `prova_session=${otherTok.invite_token}` };
  const heldStart = Math.floor((Date.now() + 3 * H) / D) * D - 3 * H + 3 * D + 18 * H;
  const heldRes = await fetch(`${BASE}/api/holds`, { method: "POST", headers: memberHdr, body: JSON.stringify({ start_ms: heldStart, hours: 2 }) });
  if (heldRes.status !== 200) fail("member hold: " + heldRes.status);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".strip-day");
  await page.click(".strip-day >> nth=3");
  await page.waitForSelector(".held");
  if (!(await page.textContent(".held")).includes("Rezerve ediliyor")) fail("held slot label");
  if (!(await page.textContent(".held")).includes("Ali Yılmaz seçiyor")) fail("held slot should name who is choosing");
  await page.screenshot({ path: `${SHOTS}/calendar-held.png` });
  await fetch(`${BASE}/api/holds`, { method: "DELETE", headers: memberHdr });

  // Uyarılar: raise a kind -> compact icon-only badge (amber) next to the brand heading, shown on every tab ->
  // tap it -> detail sheet (icon + text + resolve) -> resolve there
  await page.click(".tab:has-text('Uyarılar')");
  await page.waitForSelector(".kind-btn");
  await page.locator(".kind-btn", { hasText: "Galoş yok" }).click();
  await page.waitForSelector(".alert-badge.warn");
  await page.waitForSelector(".kind-btn.open");
  await page.waitForSelector(".hist");
  await page.screenshot({ path: `${SHOTS}/alerts.png`, fullPage: true });
  await page.click(".tab:has-text('Takvim')");
  await page.waitForSelector(".alert-badge");
  await page.screenshot({ path: `${SHOTS}/alerts-badge.png` });
  await page.click(".alert-badge");
  await page.waitForSelector(".sheet .alert-detail");
  await page.screenshot({ path: `${SHOTS}/alerts-detail.png` });
  await page.click(".sheet .btn.good");
  await page.waitForFunction(() => !document.querySelector(".alert-badge"));

  // Members: list, create
  await page.click(".tab:has-text('Yönetim')");
  await page.waitForSelector(".member");
  // the pending browser signup is listed first with Onayla / Reddet; approve it (no invite-link copy button anywhere)
  await page.waitForSelector(".member.pending");
  if (await page.$(".member >> text=Bağlantıyı kopyala")) fail("copy-link button should be gone");
  await page.locator(".member.pending", { hasText: "Tarayıcı Deneme" }).getByText("Onayla").click();
  await page.waitForFunction(() => !document.querySelector(".member.pending"));
  await page.waitForFunction(() => document.querySelectorAll(".member").length === 6);
  if ((await page.$$eval(".member", (e) => e.length)) !== 6) fail("expected 6 members (4 seeded + 1 API smoke + 1 approved signup)");
  await page.click(".page-head .btn.primary");
  await page.fill(".form .field input >> nth=0", "Verify Kişi");
  await page.click(".form .btn.primary");
  await page.waitForFunction(() => document.querySelectorAll(".member").length === 7);
  await page.screenshot({ path: `${SHOTS}/members.png`, fullPage: true });
  await page.waitForSelector(".kind-row");
  if ((await page.$$eval(".kind-row", (e) => e.length)) < 10) fail("alert kinds admin list");

  // Ödemelerim: items are read-only (no selection), but a self-serve dekont upload is back (admin-approval-only,
  // re-enabled 2026-09-22) - it must land as a pending, non-allocating receipt, not touch the kalan.
  await page.click(".tab:has-text('Ödemelerim')");
  await page.waitForSelector(".bill-item");
  if (!(await page.textContent(".kalan-amount")).includes("1.500")) fail("kalan card should show 1.500 TL before paying");
  if (await page.$(".bill-item input[type=checkbox]")) fail("member items must not be selectable any more");
  if (!(await page.$(".howto input[type=file]"))) fail("member self-serve dekont upload should be available again");
  if (!(await page.$(".howto"))) fail("member page should explain how to pay");
  await page.setInputFiles(".howto input[type=file]", new URL("../fixtures/receipts/papara-1500.pdf", import.meta.url).pathname);
  await page.waitForSelector(".toast.show:has-text('yönetici onayını bekliyor')");
  await page.waitForSelector(".rcpt .pill:has-text('Onay bekliyor')");
  if (!(await page.textContent(".kalan-amount")).includes("1.500")) fail("a pending upload must not touch the kalan");
  await page.screenshot({ path: `${SHOTS}/billing.png`, fullPage: true });

  // Admin: Üyeler -> Yönetici -> Ödemeler. The just-uploaded dekont shows up as a pending card first - reject it
  // (no allocation, just exercises the review UI) - then record the real payment by hand as before.
  await page.click(".tab:has-text('Yönetim')");
  await page.click(".subtabs button:has-text('Üyeler')");
  await page.locator(".member").filter({ has: page.locator(".member-name", { hasText: "Yönetici" }) }).getByText("Ödemeler", { exact: true }).click();
  await page.waitForSelector(".pay-form");
  await page.waitForSelector(".a-rcpt .pill:has-text('Onay bekliyor')");
  // the pending upload is itself a DRAFT payment card (items multi-select + amount + its PDF + reject)
  await page.waitForSelector(".a-rcpt.draft:has-text('Onay bekliyor') .pay-pick input[type=checkbox]");
  await page.fill(".a-rcpt:has-text('Onay bekliyor') .field input", "Yanlış üye adına yüklenmiş");
  await page.click(".a-rcpt:has-text('Onay bekliyor') .btn.danger");
  await page.waitForSelector(".a-rcpt .pill:has-text('Onay bekliyor')", { state: "detached" });
  await page.waitForSelector(".a-rcpt.void"); // rejected = muted history card
  await page.screenshot({ path: `${SHOTS}/admin-pending-rejected.png`, fullPage: true });
  // per-user page order (2026-09-23): "Ek ücret ekle" before "Ödeme kaydet"; the item list above is NOT a selector
  const order = await page.evaluate(() => {
    const adj = document.querySelector(".adj-form"), pay = document.querySelector(".pay-form:not(.a-rcpt)");
    return adj && pay ? !!(adj.compareDocumentPosition(pay) & Node.DOCUMENT_POSITION_FOLLOWING) : null;
  });
  if (order !== true) fail("'Ek ücret ekle' must come before 'Ödeme kaydet' on the per-user page");
  if (await page.$(".bill-list input[type=checkbox]")) fail("the item list above the payment form must not be selectable any more");
  // DRAFT: nothing selected yet -> submit disabled; pick the subscription in the form's own multi-select
  const payForm = ".pay-form:not(.a-rcpt)";
  if (!(await page.$(`${payForm}.draft .pill.draft`))) fail("payment form should read as an unsaved draft");
  if (!(await page.locator(`${payForm} .btn.primary`).isDisabled())) fail("'Ödemeyi onayla' must stay disabled until an item is selected");
  await page.click(`${payForm} .pay-pick .bill-item[data-kind=subscription] input`);
  // prefilled with the selected total (no PDF amount reading any more); the summary shows the result live
  await page.waitForFunction((f) => document.querySelector(`${f} .pay-amount`)?.value === "1500", payForm);
  if (!(await page.textContent(`${payForm} .pay-sum`)).includes("Tam ödendi")) fail("draft summary should say 'Tam ödendi' for an exact amount");
  await page.fill(`${payForm} .pay-amount`, "2000");
  if (!(await page.textContent(`${payForm} .pay-sum`)).includes("Topluluk üyeye borçlu")) fail("draft summary should show the credit for an overpayment");
  await page.fill(`${payForm} .pay-amount`, "1500");
  if (await page.$(`${payForm} .pdf-name`)) fail("no PDF picked yet: no file name / show-PDF button");
  await page.setInputFiles(`${payForm} input[type=file]`, new URL("../fixtures/receipts/enpara-1500.pdf", import.meta.url).pathname);
  await page.waitForSelector(`${payForm} .pay-pdf button:has-text("PDF'i göster")`);
  // multi-month (2026-09-23): the composer also offers other months' open items, incl. next month's planned rent
  if (!(await page.$(`${payForm} .pay-away + .pay-pick .bill-item.upcoming[data-kind=subscription]`))) fail("payment form should offer next month's planned rent under 'Diğer aylar'");
  await page.screenshot({ path: `${SHOTS}/admin-user.png`, fullPage: true });
  await page.click(`${payForm} .btn.primary`);
  await page.waitForSelector(".kalan.clear");
  if ((await page.$$eval(".pill.ok", (e) => e.length)) < 1) fail("recorded item should show a ✓ pill");
  // SAVED: read-only card, only the selected item, the amount actually paid, and the PDF toggle (it has one)
  await page.waitForSelector(".a-rcpt.saved .pill.ok:has-text('Kaydedildi')");
  const saved = await page.textContent(".a-rcpt.saved");
  if (!saved.includes("Aylık aidat") || !saved.includes("Ödenen tutar") || !saved.includes("1.500")) fail("saved card should list the covered item and the paid amount");
  if (await page.$(".a-rcpt.saved input[type=checkbox], .a-rcpt.saved .pay-amount")) fail("saved card must be read-only");
  if (!(await page.$(".a-rcpt.saved button:has-text(\"PDF'i göster\")"))) fail("saved card with a dekont should offer 'PDF'i göster'");
  if ((await page.textContent("main, body")).includes("Dekontta bulunan")) fail("'Dekontta bulunan' must not be shown any more");
  await page.screenshot({ path: `${SHOTS}/admin-user-paid.png`, fullPage: true });

  // the member sees the result on their own (read-only) page
  await page.click(".tab:has-text('Ödemelerim')");
  await page.waitForSelector(".kalan.clear");
  await page.screenshot({ path: `${SHOTS}/billing-paid.png`, fullPage: true });
  // future months are browsable (to current + 12): next month shows a display-only planned rent, not "nothing to pay"
  await page.click(".mnav .icon-btn[aria-label='Sonraki ay']");
  await page.waitForSelector(".mnav .pill.future");
  await page.waitForSelector(".bill-item.upcoming[data-kind=subscription]");
  if (await page.$(".kalan.clear")) fail("a future month with a planned rent must not read as 'nothing to pay'");
  if (!(await page.textContent(".kalan-sub")).includes("Planlanan aidat")) fail("future month should show the planned rent in the kalan card");
  await page.screenshot({ path: `${SHOTS}/billing-future.png`, fullPage: true });
  await page.click(".mnav .icon-btn[aria-label='Önceki ay']");
  await page.waitForSelector(".kalan.clear");

  // Admin: receipts (4 cards this month: API smoke's Smoke Üye pending-upload + hand-recorded part-payment, and this
  // browser run's Yönetici rejected-upload + the payment just saved), inline PDF embed, fees, settings
  await page.click(".tab:has-text('Yönetim')");
  await page.click(".subtabs button:has-text('Ödemeler')");
  // default view = current month + EVERYONE: the overview lists every member with their outstanding and a grand total
  await page.waitForSelector(".owe-list .owe-row");
  if ((await page.$$eval(".owe-list .owe-row", (e) => e.length)) < 2) fail("overview should list every member, not one");
  if (!(await page.textContent(".owe-sum"))) fail("overview totals missing");
  if (!(await page.textContent(".owe-total")).includes("₺")) fail("overview total row should show a sum");
  await page.screenshot({ path: `${SHOTS}/admin-overview.png`, fullPage: true });
  await page.waitForSelector(".a-rcpt");
  // the pending card fetches its member's items first (skeleton until then), so wait for the count to settle
  await page.waitForFunction(() => document.querySelectorAll(".a-rcpt").length === 4, null, { timeout: 5000 }).catch(() => {});
  if ((await page.$$eval(".a-rcpt", (e) => e.length)) !== 4) fail("expected 4 receipts in admin list");
  // a row drills into the same per-user detail as Üyeler, then back
  await page.click(".owe-list .owe-row >> nth=0");
  await page.waitForSelector(".pay-form, .bill-list");
  await page.click(".detail-head .icon-btn");
  await page.waitForSelector(".owe-list .owe-row");
  await page.click(".a-rcpt >> nth=0 >> text=PDF'i göster");
  await page.waitForSelector("embed.embed");
  await page.screenshot({ path: `${SHOTS}/admin-receipts.png`, fullPage: true });
  await page.click(".subtabs button:has-text('Ücretler')");
  await page.waitForSelector(".fee-now");
  await page.screenshot({ path: `${SHOTS}/admin-fees.png`, fullPage: true });
  await page.click(".subtabs button:has-text('Ekonomi')");
  await page.waitForSelector(".eco-chart svg[role=img]");
  await page.waitForSelector(".eco-sug .eco-headline");
  if ((await page.$$eval(".eco-col", (e) => e.length)) !== 6) fail("economics chart should have 6 months");
  if (!(await page.textContent(".eco-chart svg desc")).includes("gider")) fail("chart desc missing");
  await page.waitForSelector(".eco-list .eco-row");
  await page.screenshot({ path: `${SHOTS}/admin-economics.png`, fullPage: true });
  await page.click(".eco-chart .eco-head .btn");
  await page.waitForSelector(".eco-table");
  await page.click(".eco-chart .eco-head .btn");
  await page.click(".eco-sug .btn.primary"); // Uygula (gelecek aydan) -> next month's fee row
  await page.waitForSelector(".toast.show");
  await page.screenshot({ path: `${SHOTS}/admin-economics-applied.png`, fullPage: true });
  await page.click(".subtabs button:has-text('Ayarlar')");
  await page.waitForSelector("form.form input[type=checkbox]");

  // Export card (Ayarlar): both downloads are attachments
  await page.click(".tab:has-text('Yönetim')");
  await page.click(".subtabs button:has-text('Ayarlar')");
  await page.waitForSelector(".export a.btn");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click(".export a.btn.primary")]);
  if (!/^prova-yedek-\d{4}-\d{2}-\d{2}\.json$/.test(dl.suggestedFilename())) fail("export filename: " + dl.suggestedFilename());
  const [dl2] = await Promise.all([page.waitForEvent("download"), page.click(".export a.btn:not(.primary)")]);
  if (!dl2.suggestedFilename().endsWith(".csv")) fail("csv export filename: " + dl2.suggestedFilename());

  // 390px: the Admin sub-tab bar must not clip a label (was: "Ayarlar" cut off)
  const clip = await page.$eval(".subtabs", (el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
  if (clip.sw > clip.cw + 1) fail(`admin sub-tabs overflow at 390px (${clip.sw} > ${clip.cw})`);

  // Cold-start splash + error/retry states (slow /api/me, failing lists), then restore
  await page.route("**/api/me", async (route) => { await new Promise((r) => setTimeout(r, 900)); route.continue(); });
  await page.goto(`${BASE}/`, { waitUntil: "commit" });
  await page.waitForSelector(".boot");
  if (!(await page.textContent(".boot")).includes("Oda uyanıyor")) fail("cold-start splash text");
  await page.screenshot({ path: `${SHOTS}/boot.png` });
  await page.waitForSelector(".tabbar");
  await page.unroute("**/api/me");
  await page.route("**/api/alerts/kinds", (r) => r.abort());
  await page.click(".tab:has-text('Uyarılar')");
  await page.waitForSelector(".state-card[role=alert]");
  await page.screenshot({ path: `${SHOTS}/alerts-error.png` });
  await page.unroute("**/api/alerts/kinds");
  await page.click(".state-card .btn");
  await page.waitForSelector(".kind-btn");
  await page.route("**/api/me", (r) => r.fulfill({ status: 503, contentType: "text/html", body: "<html>waking</html>" }));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".state-card[role=alert]"); // 503 is NOT "logged out"
  if (await page.$(".login-card")) fail("a 503 on /api/me must not show the login screen");
  await page.unroute("**/api/me");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".tabbar");

  // Themed sweep: every tab x {dark, light} x {390, 1280}; no horizontal page overflow anywhere. Screenshots -> PROVA_SHOTS/sweep-*.png
  const pages = [["Takvim", null], ["Ödemelerim", null], ["Uyarılar", null], ["Yönetim", "Üyeler"], ["Yönetim", "Ödemeler"], ["Yönetim", "Ücretler"], ["Yönetim", "Ekonomi"], ["Yönetim", "Ayarlar"]];
  for (const theme of ["dark", "light"]) {
    await page.evaluate((t) => { document.documentElement.setAttribute("data-theme", t); localStorage.setItem("prova.theme", t); }, theme);
    for (const [w, h] of [[390, 844], [1280, 900]]) {
      await page.setViewportSize({ width: w, height: h });
      for (const [tab, sub] of pages) {
        await page.click(`.tab:has-text('${tab}')`);
        if (sub) await page.click(`.subtabs button:has-text('${sub}')`);
        await page.waitForTimeout(350);
        const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        if (over > 1) fail(`horizontal overflow ${over}px: ${tab}/${sub || ""} ${theme} ${w}px`);
        await page.screenshot({ path: `${SHOTS}/sweep-${theme}-${w}-${(sub || tab).toLowerCase().replace(/[^a-z]/g, "")}.png`, fullPage: true });
      }
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });

  // theme toggle flips data-theme
  await page.click(".icon-btn");
  const t1 = await page.getAttribute("html", "data-theme");
  await page.click(".icon-btn");
  if (t1 === (await page.getAttribute("html", "data-theme"))) fail("theme toggle no-op");

  // the logged-out /api/me 401 is expected
  const bad = (errors || []).filter((e) => !/401|503|ERR_FAILED/.test(e)); // 401 = logged-out probe; 503/ERR_FAILED = the injected failures above
  if (bad.length) fail("console errors: " + bad.join("; "));
  console.log(`browser ok, screenshots: ${SHOTS}/{login,calendar,calendar-week,calendar-sheet,members}.png`);
} catch (e) { fail(e.message); }
await browser.close();
