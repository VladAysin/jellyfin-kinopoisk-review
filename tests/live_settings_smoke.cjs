'use strict';
// Native plugin page must work even when injected automatic-rating UI is absent.
const { chromium } = require('../.research/browser/node_modules/playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
    const state = path.resolve(__dirname, '../.research/jellyfin-smoke');
    const credentials = JSON.parse(fs.readFileSync(path.join(state, 'credentials.json'), 'utf8'));
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.stack || error.message));
        await page.route('**/KinopoiskRatings/client.js*', route => route.abort());
        await page.goto('http://127.0.0.1:18096/web/index.html', { waitUntil: 'networkidle' });
        await page.locator('#txtManualName').fill(credentials.username);
        await page.locator('#txtManualPassword').fill(credentials.password);
        await page.getByRole('button', { name: 'Войти', exact: true }).click();
        await page.waitForFunction(() => window.ApiClient && window.ApiClient.getCurrentUserId());
        await page.waitForURL(/\/home(?:[?&]|$)/);
        await page.waitForLoadState('networkidle');
        // Full navigation avoids Jellyfin home carousel teardown during hash routing.
        await page.goto('about:blank');
        await page.goto('http://127.0.0.1:18096/web/index.html#/dashboard/plugins');
        await page.locator('a[href*="/dashboard/plugins/ff10e970"]').click();
        await page.getByRole('link', { name: 'Параметры', exact: true }).click();
        const view = page.locator('#kinopoiskRatingsConfigurationPage');
        await view.waitFor({ state: 'visible', timeout: 20000 });
        await view.getByText('Кинопоиск ещё не подключён.', { exact: true }).waitFor();
        await page.waitForFunction(name => document.querySelector('#kpr-current-user').textContent.includes(name), credentials.username);
        assert.equal(await view.locator('#kpr-config-cookie').getAttribute('type'), 'password');
        assert.equal(await view.locator('#kpr-config-cookie').inputValue(), '');
        assert.equal(await page.evaluate(() => !!window.__kinopoiskRatingsLoaded), false);
        console.log('PASS: plugin card → Параметры opens native settings independently of automatic UI injection');
        await view.getByRole('button', { name: 'Подключить', exact: true }).click();
        await view.getByText('Вставьте Cookie своей сессии.', { exact: true }).waitFor();
        assert.equal(await view.locator('#kpr-config-cookie').getAttribute('maxlength'), null);
        await view.locator('#kpr-config-cookie').fill('Session_id=do-not-echo\u2026');
        await view.getByRole('button', { name: 'Подключить', exact: true }).click();
        await view.locator('#kpr-config-message').filter({ hasText: 'U+2026' }).waitFor();
        assert.equal((await view.locator('#kpr-config-message').innerText()).includes('do-not-echo'), false);
        assert.equal(await view.locator('#kpr-config-cookie').inputValue(), '');
        console.log('PASS: malformed Cookie reports character code without exposing its value');
        await view.getByRole('button', { name: 'Обновить список', exact: true }).click();
        await view.locator('#kpr-config-message').filter({ hasText: 'Подождите' }).waitFor({ state: 'hidden' });
        assert.equal(await view.locator('#kpr-config-queue').innerText() === '', false);
        console.log('PASS: empty Cookie rejected, queue loaded and refreshed on native plugin page');
        await page.screenshot({ path: path.join(state, 'plugin-settings.png'), fullPage: true });
        assert.deepEqual(errors, [], 'Native settings runtime errors');
        console.log('PASS: all native plugin settings checks');
    } finally { await browser.close(); }
})().catch(error => { console.error('FAIL:', error.message); process.exitCode = 1; });
