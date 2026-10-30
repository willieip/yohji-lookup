import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:8766';
const artifacts = new URL('../test-artifacts/', import.meta.url);
const catalog = JSON.parse(await readFile(new URL('../data/catalog.json', import.meta.url), 'utf8'));
const fixture = catalog.records.find((record) => record.code === 'HA-P30-900') || catalog.records.find((record) => record.variantCodes?.length);
assert(fixture, 'A source-backed example is required.');
const exactCode = fixture.variantCodes[0];
let server;
let browser;

try {
  if (!process.env.TEST_BASE_URL) {
    server = spawn('python3', ['-m', 'http.server', '8766', '--bind', '127.0.0.1'], { cwd: new URL('../', import.meta.url), stdio: 'ignore' });
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      try { if ((await fetch(base)).ok) { ready = true; break; } } catch {}
      await delay(100);
    }
    assert(ready, 'The local server should start.');
  }
  await mkdir(artifacts, { recursive: true });
  browser = await chromium.launch({ headless: true, executablePath: process.env.TEST_BROWSER_PATH || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const contextOptions = { viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce', timezoneId: 'America/New_York', ignoreHTTPSErrors: process.env.TEST_IGNORE_HTTPS_ERRORS === '1' };
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(base);
  await page.waitForFunction(() => !document.getElementById('catalog-filter').disabled);
  assert.equal(await page.locator('.product-card').count(), 12);
  assert.match(await page.locator('#catalog-total').textContent(), /source records/);
  assert.equal(await page.locator('#code-input').inputValue(), '');
  assert.equal((await page.locator('h1').innerText()).replaceAll('\u00a0', ' '), 'Yohji Yamamoto Serial Lookup');
  assert.equal(await page.locator('#reference-title').innerText(), 'Reference Chart');
  assert.equal(await page.locator('#catalog').getAttribute('open'), null);
  await page.locator('#catalog-title').click();
  await page.locator('.product-image img').first().waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('#catalog-grid img')].slice(0, 4).every((img) => img.complete), null, { timeout: 15000 });
  await page.screenshot({ path: new URL('desktop.png', artifacts).pathname, fullPage: true });

  async function lookup(code) {
    await page.locator('#code-input').fill(code);
    await page.locator('#code-input').press('Enter');
  }
  await lookup(exactCode.toLowerCase().replaceAll('-', '–'));
  assert.equal(await page.locator('#code-input').inputValue(), exactCode);
  assert.equal(await page.locator('#result-kicker').textContent(), 'Exact recorded code');
  assert.match(await page.locator('.result-card').first().innerText(), new RegExp(fixture.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(new URL(page.url()).searchParams.get('code'), exactCode);
  assert.equal(await page.locator('.result-source-link').first().getAttribute('href'), fixture.sourceUrl);
  await page.locator('#catalog-title').click();
  await page.screenshot({ path: new URL('match.png', artifacts).pathname, fullPage: true });
  await page.locator('#catalog-title').click();
  await lookup(`${fixture.code}-99-99`);
  assert.equal(await page.locator('#result-kicker').textContent(), 'Variant unconfirmed');
  assert.equal(await page.locator('.match-badge:not(.unconfirmed)').count(), 0);
  await lookup(fixture.code);
  assert.equal(await page.locator('#result-kicker').textContent(), 'Product code match');
  await lookup('ZZ-Z99-999');
  assert.equal(await page.locator('#result-kicker').textContent(), 'Not in this index');
  assert.equal(await page.locator('#search-links a').count(), 5);
  await lookup('HCC');
  assert.equal(await page.locator('#result-kicker').textContent(), 'Label clues only');
  assert.equal(await page.locator('.result-card').count(), 0);
  assert.equal(await page.locator('#code-clues').getAttribute('open'), '');
  await lookup('<img src=x onerror=alert(1)>');
  assert.equal(await page.locator('#code-input').getAttribute('aria-invalid'), 'true');
  assert.equal(await page.locator('#results').isVisible(), false);
  assert.equal(new URL(page.url()).searchParams.has('code'), false);
  await page.locator('.history-button').filter({ hasText: fixture.code }).first().click();
  assert.equal(await page.locator('#results').isVisible(), true);

  await page.locator('#catalog-filter').fill('KURO TRACK');
  assert(await page.locator('.product-card').count() > 0);
  assert.match(await page.locator('#catalog-grid').innerText(), /KURO TRACK/);
  await page.locator('#catalog-filter').fill('no-matching-garment-9382');
  assert.equal(await page.locator('.product-card').count(), 0);
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.locator('#brand-filter').selectOption(fixture.brand);
  assert((await page.locator('.card-brand').allInnerTexts()).every((brand) => brand === fixture.brand));
  await page.locator('#next-page').click();
  assert.match(await page.locator('#page-label').innerText(), /Page 2 of/);
  await page.locator('#previous-page').click();
  assert.match(await page.locator('#page-label').innerText(), /Page 1 of/);

  const mobile = await context.newPage();
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto(`${base}/?code=${encodeURIComponent(exactCode)}`);
  await mobile.waitForFunction(() => document.getElementById('result-kicker').textContent === 'Exact recorded code');
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'No mobile horizontal overflow.');
  await mobile.screenshot({ path: new URL('mobile.png', artifacts).pathname, fullPage: true });
  await mobile.setViewportSize({ width: 320, height: 740 });
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'No narrow-screen horizontal overflow.');

  const corrupt = await browser.newContext(contextOptions);
  await corrupt.addInitScript(() => {
    localStorage.setItem('yohjiLookupHistory.v2', '{broken');
    localStorage.setItem('yohjiHistory', JSON.stringify([{ serial: '<img src=x onerror=alert(1)>' }, { serial: 'HA-P30-900', season: 'made-up year' }]));
  });
  const corruptPage = await corrupt.newPage();
  await corruptPage.goto(base);
  await corruptPage.waitForFunction(() => !document.getElementById('catalog-filter').disabled);
  assert.equal(await corruptPage.locator('#history-list img').count(), 0);
  assert.equal(await corruptPage.locator('.history-button').count(), 1);

  const offline = await browser.newContext(contextOptions);
  let block = true;
  await offline.route('**/data/catalog.json', (route) => block ? route.abort() : route.continue());
  const offlinePage = await offline.newPage();
  await offlinePage.goto(`${base}/?code=${encodeURIComponent(exactCode)}`);
  await offlinePage.waitForFunction(() => document.getElementById('result-kicker').textContent === 'Catalog unavailable');
  assert.doesNotMatch(await offlinePage.locator('#result-title').innerText(), /No record/);
  block = false;
  await offlinePage.getByRole('button', { name: 'Retry loading the catalog', exact: true }).click();
  await offlinePage.waitForFunction(() => document.getElementById('result-kicker').textContent === 'Exact recorded code');
  assert.deepEqual(pageErrors, []);
  console.log(`Browser checks passed: ${catalog.records.length} source records; exact, base, variant, absent, partial, invalid, history, filters, pagination, mobile, and failed-load recovery.`);
} finally {
  await browser?.close();
  server?.kill();
}
