'use strict';
// Optional real-browser test. Requires Playwright in .research/browser/node_modules.
// Uses only the isolated localhost test server and generated credentials.
const { chromium } = require('../.research/browser/node_modules/playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
    const state = path.resolve(__dirname, '../.research/jellyfin-smoke');
    const credentials = JSON.parse(fs.readFileSync(path.join(state, 'credentials.json'), 'utf8'));
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto('http://127.0.0.1:18096/web/index.html', { waitUntil: 'networkidle' });
        await page.locator('#txtManualName').fill(credentials.username);
        await page.locator('#txtManualPassword').fill(credentials.password);
        await page.getByRole('button', { name: 'Войти', exact: true }).click();
        await page.waitForFunction(() => window.ApiClient && window.ApiClient.getCurrentUserId() && window.__kinopoiskRatingsLoaded, null, { timeout: 20000 });
        assert.equal(await page.locator('.kpr-launch').count(), 0, 'No floating КП button');
        console.log('PASS: real Jellyfin login has no floating КП button');
        // The playback API smoke leaves a pending movie for the administrator.
        await page.getByRole('heading', { name: 'Как вам фильм?', exact: true }).waitFor({ timeout: 20000 });
        await page.getByRole('button', { name: 'Подключение Кинопоиска', exact: true }).click();
        await page.locator('#kinopoiskRatingsConfigurationPage').waitFor();
        await page.getByText('Кинопоиск ещё не подключён.', { exact: true }).waitFor();
        assert.equal(await page.locator('#kpr-config-cookie').getAttribute('type'), 'password');
        assert.equal(await page.locator('.kpr-panel').count(), 0, 'No automatic popup on settings page');
        await page.screenshot({ path: path.join(state, 'connection.png') });
        console.log('PASS: rating dialog opens native plugin settings');
        await page.getByRole('button', { name: 'Подключить', exact: true }).click();
        await page.getByText('Вставьте Cookie своей сессии.', { exact: true }).waitFor();
        console.log('PASS: empty credentials rejected');
        assert.deepEqual(errors, [], 'Browser runtime errors');
        console.log('PASS: all real browser checks');
    } finally { await browser.close(); }
})().catch(error => { console.error('FAIL:', error.message); process.exitCode = 1; });
