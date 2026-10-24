// Isolated browser regression: no production account or external API is used.
const assert = require('node:assert/strict');
const express = require('express');
const { chromium } = require('playwright');
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');
const inImage = existsSync('./web/index.html');
const { publicLegalBundle } = require(resolve(inImage ? './dist/legal/documents.js' : './apps/backend/dist/legal/documents.js'));

(async () => {
  const app = express();
  const web = resolve(inImage ? 'web' : 'apps/web/dist');
  app.use(express.static(web));
  app.get('*', (_req, res) => res.sendFile(resolve(web, 'index.html')));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((done) => server.once('listening', done));
  const browser = await chromium.launch({ headless: true, ...(process.env.UI_TEST_CHROME_CHANNEL ? { channel: process.env.UI_TEST_CHROME_CHANNEL } : {}), args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    let legalState = 'failed';
    let payload = null;
    await page.route('**/api/v1/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      let status = 200, body = {};
      if (path.endsWith('/auth/legal')) {
        if (legalState === 'failed') { await route.abort(); return; }
        body = legalState === 'incomplete' ? { ...publicLegalBundle(), documents: [] } : publicLegalBundle();
      } else if (path.endsWith('/onboarding/providers')) body = { email: true, google: false, github: false };
      else if (path.endsWith('/auth/register')) { payload = route.request().postDataJSON(); status = 400; body = { error: 'Test interception: no account created' }; }
      else { status = 401; body = { error: 'Not signed in' }; }
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/signin?mode=register`);
    await page.getByTestId('legal-load-error').waitFor();
    assert.equal(await page.getByTestId('auth-submit').isEnabled(), false);
    assert.equal(await page.getByTestId('accept-terms').isEnabled(), false);
    legalState = 'incomplete';
    await page.getByRole('button', { name: 'Reload legal documents' }).click();
    await page.getByTestId('legal-load-error').waitFor();
    assert.equal(await page.getByTestId('auth-submit').isEnabled(), false);
    legalState = 'valid';
    await page.getByRole('button', { name: 'Reload legal documents' }).click();
    await page.getByTestId('legal-review').waitFor();
    await page.getByText('Review required legal documents').click();
    for (const document of publicLegalBundle().documents.filter((doc) => doc.requiredForAcceptance)) {
      assert.equal(await page.getByTestId('legal-review').getByText(document.title, { exact: true }).isVisible(), true);
    }
    await page.getByLabel('First name').fill('Promotion');
    await page.getByLabel('Last name').fill('Test');
    await page.getByLabel('Email', { exact: false }).fill('promotion@example.invalid');
    await page.locator('#password').fill('LocalTestOnly42!');
    await page.locator('#confirm').fill('LocalTestOnly42!');
    await page.getByTestId('auth-submit').click();
    assert.equal(payload, null, 'Unchecked legal acceptance must not submit');
    await page.getByTestId('accept-terms').check();
    await page.getByTestId('auth-submit').click();
    await page.getByText('Test interception: no account created').waitFor();
    assert.equal(payload.legalAccepted, true);
    assert.equal(payload.legalVersion, publicLegalBundle().version);
    assert.equal(payload.client, 'web');
    console.log('PASS: legal load failure, incomplete bundle, retry, required document review, unchecked consent, exact signup version');
  } finally { await browser.close(); await new Promise((done) => server.close(done)); }
})().catch((error) => { console.error(error); process.exit(1); });
