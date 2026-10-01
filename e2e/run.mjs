// End-to-end check: renders at several sizes and drives touch gestures through CDP.
// Usage: node e2e/run.mjs <outDir> [url]   (expects `npm run preview` on :4173)
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const out = process.argv[2] ?? 'e2e/out';
const url = process.argv[3] ?? 'http://localhost:4173/';
mkdirSync(out, { recursive: true });
const executablePath = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ executablePath, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const logs = [];
let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures++;
};

async function open(name, viewport, opts = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: opts.dpr ?? 1, hasTouch: !!opts.touch, isMobile: !!opts.touch, colorScheme: opts.dark ? 'dark' : 'light' });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('ERR_CERT') && logs.push(`[${name}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[${name}] pageerror: ${e.message}`));
  await page.goto(url);
  await page.waitForSelector('.cand', { timeout: 30000 });
  await page.waitForTimeout(1200);
  return { ctx, page };
}

for (const [name, vp, opts] of [
  ['desktop-light', { width: 1440, height: 900 }, {}],
  ['desktop-dark', { width: 1440, height: 900 }, { dark: true }],
  ['tablet', { width: 900, height: 1100 }, { touch: true }],
  ['phone', { width: 390, height: 844 }, { touch: true, dpr: 2 }],
]) {
  const { ctx, page } = await open(name, vp, opts);
  await page.screenshot({ path: `${out}/${name}.png` });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check(!overflow, `${name}: no horizontal page scroll`);
  await ctx.close();
}

// ---- touch gestures on a phone
{
  const { ctx, page } = await open('gestures', { width: 390, height: 844 }, { touch: true, dpr: 2 });
  const cdp = await ctx.newCDPSession(page);
  const box = await page.locator('.viewer-canvas').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const cam = () => page.evaluate(() => window.__caseblanketViewer.cameraState());
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
  const settle = () => page.waitForTimeout(700);

  const before = await cam();
  await touch('touchStart', [[cx - 60, cy]]);
  for (let i = 1; i <= 10; i++) await touch('touchMove', [[cx - 60 + i * 12, cy + i * 3]]);
  await touch('touchEnd', []);
  await settle();
  const afterRotate = await cam();
  const moved = Math.hypot(...afterRotate.position.map((v, i) => v - before.position[i]));
  check(moved > 20 && Math.abs(afterRotate.distance - before.distance) < 5, `one-finger drag rotates (camera moved ${moved.toFixed(0)} mm, distance kept)`);

  await touch('touchStart', [[cx - 30, cy], [cx + 30, cy]]);
  for (let i = 1; i <= 10; i++) await touch('touchMove', [[cx - 30 - i * 8, cy], [cx + 30 + i * 8, cy]]);
  await touch('touchEnd', []);
  await settle();
  const afterPinch = await cam();
  check(afterPinch.distance < afterRotate.distance * 0.8, `pinch out zooms in (${afterRotate.distance.toFixed(0)} → ${afterPinch.distance.toFixed(0)} mm)`);

  await touch('touchStart', [[cx - 20, cy - 20], [cx + 20, cy - 20]]);
  for (let i = 1; i <= 10; i++) await touch('touchMove', [[cx - 20 + i * 6, cy - 20 + i * 6], [cx + 20 + i * 6, cy - 20 + i * 6]]);
  await touch('touchEnd', []);
  await settle();
  const afterPan = await cam();
  const panned = Math.hypot(...afterPan.target.map((v, i) => v - afterPinch.target[i]));
  check(panned > 5, `two-finger drag pans (target moved ${panned.toFixed(0)} mm)`);

  // Software GL in CI can take longer than a finger between taps; test the gesture, not the machine.
  await page.evaluate(() => (window.__caseblanketViewer.doubleTapWindow = 1500));
  for (let k = 0; k < 2; k++) {
    await touch('touchStart', [[cx, cy]]);
    await touch('touchEnd', []);
  }
  await page.waitForTimeout(1200);
  const afterReset = await cam();
  check(Math.hypot(...afterReset.target) < 1, `double-tap resets the view (target ${afterReset.target.map((v) => v.toFixed(1)).join(', ')})`);
  await page.screenshot({ path: `${out}/gestures.png` });
  await ctx.close();
}

// ---- controls change the design
{
  const { ctx, page } = await open('controls', { width: 1440, height: 900 }, {});
  const thickness = async () => Number((await page.locator('.kv dd').first().innerText()).replace(/[^\d.]/g, ''));
  const t0 = await thickness();
  await page.getByRole('tab', { name: 'Tune' }).click();
  await page.locator('#pri-air').fill('1');
  await page.waitForTimeout(2500);
  await page.waitForSelector('.solving', { state: 'detached', timeout: 20000 });
  const t1 = await thickness();
  check(t1 >= t0, `airflow priority 100% does not make the case thinner (${t0} → ${t1} mm)`);
  await page.locator('#edge-r').fill('30');
  await page.waitForTimeout(2500);
  await page.waitForSelector('.solving', { state: 'detached', timeout: 20000 });
  await page.screenshot({ path: `${out}/controls-rounded.png` });
  await page.getByRole('tab', { name: 'Parts' }).click();
  await page.locator('#gpu-preset').selectOption({ label: 'MSI RTX 4090 SUPRIM LIQUID X' });
  await page.waitForTimeout(2500);
  await page.waitForSelector('.solving', { state: 'detached', timeout: 20000 });
  const eyebrow = await page.locator('.eyebrow').first().innerText();
  check(eyebrow.length > 0, `design updates after changing the GPU (${eyebrow})`);
  await page.screenshot({ path: `${out}/controls-4090.png` });
  await page.getByRole('radio', { name: 'In the board slot' }).click();
  await page.waitForTimeout(2500);
  await page.waitForSelector('.solving', { state: 'detached', timeout: 20000 });
  const slotEyebrow = await page.locator('.eyebrow').first().innerText();
  check(/direct slot/i.test(slotEyebrow), `GPU "in the board slot" gives a direct-slot design (${slotEyebrow})`);
  await page.screenshot({ path: `${out}/gpu-in-slot.png` });
  await ctx.close();
}

// ---- online catalogue flow (served from a local fixture so the test needs no network)
{
  const { ctx, page } = await open('catalogue', { width: 1440, height: 900 }, {});
  const fixture = new URL('./fixtures/video-card.json', import.meta.url);
  await page.route('**/pc-part-dataset/**/video-card.json', (route) => route.fulfill({ path: fixture.pathname, contentType: 'application/json' }));
  await page.getByRole('button', { name: 'Search online' }).first().click();
  await page.locator('#catalog-query').fill('suprim liquid 5090');
  await page.locator('.catalog-list button').first().click();
  await page.waitForTimeout(2500);
  const name = await page.locator('#gpu-preset').inputValue().catch(() => '');
  const flagged = await page.locator('.field.flagged').count();
  check(flagged >= 2, `catalogue pick flags the dimensions it could not supply (${flagged} flagged)`);
  const badge = await page.locator('.section').first().locator('.badge').innerText();
  check(/catalogue/i.test(badge), `GPU source badge reads "${badge}" (library select: "${name}")`);
  await page.screenshot({ path: `${out}/catalogue.png` });
  await ctx.close();
}

// ---- shrinkwrap, airflow simulation and printable export
{
  const { ctx, page } = await open('sim', { width: 1440, height: 900 }, {});
  await page.waitForSelector('.solving', { state: 'detached', timeout: 30000 });
  await page.waitForTimeout(1500);
  const shellShown = await page.evaluate(() => window.__caseblanketViewer.flow !== undefined);
  check(shellShown, 'viewer exposes the flow layer');
  await page.getByRole('button', { name: 'Simulate airflow' }).click();
  await page.waitForSelector('.sim-table', { timeout: 30000 });
  await page.waitForTimeout(2000);
  const active = await page.evaluate(() => window.__caseblanketViewer.flow.active);
  check(active, 'simulated airflow particles animate in the 3D view');
  await page.screenshot({ path: `${out}/sim.png` });
  await page.getByRole('button', { name: 'Stop' }).click().catch(() => {});
  await page.getByRole('button', { name: 'Export' }).click();
  await page.getByRole('menuitem', { name: /3D-printable pieces/ }).click();
  const dl = page.waitForEvent('download', { timeout: 120000 });
  await page.getByRole('button', { name: 'Build and download' }).click();
  const file = await dl;
  check(/\.zip$/.test(file.suggestedFilename()), `3D-printable export downloads ${file.suggestedFilename()}`);
  await ctx.close();
}

await browser.close();
if (logs.length) console.log('Console errors:\n' + logs.join('\n'));
check(logs.length === 0, 'no console errors');
process.exit(failures ? 1 : 0);
