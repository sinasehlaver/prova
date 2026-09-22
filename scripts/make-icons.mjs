// Regenerate PNG icons from web/public/icon*.svg via headless Chrome (no npm deps). Run: node scripts/make-icons.mjs
// macOS/Linux dev box with Chrome only (uses the workspace's ../.claude/scripts/browser.mjs). PNGs are committed, so deploys never need this.
import { readFileSync, writeFileSync } from "node:fs";
import { launch } from "../../.claude/scripts/browser.mjs";

const pub = new URL("../web/public/", import.meta.url);
const OUT = [["icon.svg", "icon-192.png", 192], ["icon.svg", "icon-512.png", 512], ["icon-maskable.svg", "icon-maskable-512.png", 512], ["icon-maskable.svg", "apple-touch-icon.png", 180]];
const { browser, page } = await launch();
for (const [src, out, size] of OUT) {
  await page.setViewportSize({ width: size, height: size });
  const svg = readFileSync(new URL(src, pub), "utf8").replace(/width="512" height="512"/, `width="${size}" height="${size}"`);
  await page.setContent(`<body style="margin:0;background:transparent">${svg}</body>`);
  writeFileSync(new URL(out, pub), await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }));
  console.log("wrote", out);
}
await browser.close();
