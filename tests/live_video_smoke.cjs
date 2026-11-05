'use strict';
// End-to-end browser playback against the isolated local Jellyfin, no Kinopoisk login.
const { chromium } = require('../.research/browser/node_modules/playwright');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

(async () => {
    const state = path.resolve(__dirname, '../.research/jellyfin-smoke');
    const auth = JSON.parse(fs.readFileSync(path.join(state, 'auth.json'), 'utf8'));
    const item = JSON.parse(fs.readFileSync(path.join(state, 'item.json'), 'utf8'));
    const base = 'http://127.0.0.1:18096';
    const credentials = { username: 'kp-video-' + crypto.randomBytes(4).toString('hex'), password: crypto.randomBytes(24).toString('base64url') };
    const created = await fetch(base + '/Users/New', {
        method: 'POST', headers: { 'X-Emby-Token': auth.accessToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ Name: credentials.username, Password: credentials.password })
    });
    assert.equal(created.status, 200, 'Create isolated video-test user');
    // A new user makes this run independent of earlier queue/dismissal state.
    fs.writeFileSync(path.join(state, 'video-credentials.json'), JSON.stringify(credentials), { mode: 0o600 });
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        await page.goto(base + '/web/index.html', { waitUntil: 'networkidle' });
        await page.locator('#txtManualName').fill(credentials.username);
        await page.locator('#txtManualPassword').fill(credentials.password);
        await page.getByRole('button', { name: 'Войти', exact: true }).click();
        await page.waitForURL(/\/home/, { timeout: 20000 });
        await page.waitForFunction(() => window.ApiClient && window.ApiClient.getCurrentUserId() && window.__kinopoiskRatingsLoaded, null, { timeout: 20000 });
        assert.equal(await page.locator('.kpr-launch').count(), 0, 'No floating button');
        await page.goto(base + '/web/index.html#/details?id=' + item.itemId + '&serverId=' + auth.serverId);
        const play = page.locator('.btnPlay:visible');
        await play.waitFor({ timeout: 20000 });
        const stopped = page.waitForResponse(response => response.url().includes('/Sessions/Playing/Stopped') && response.request().method() === 'POST', { timeout: 60000 });
        await play.click();
        await page.waitForFunction(() => Array.from(document.querySelectorAll('video')).some(v => v.currentTime > 1 && !v.paused), null, { timeout: 20000 });
        assert.equal(await page.locator('.kpr-panel').count(), 0, 'No rating dialog interrupts playback');
        console.log('PASS: real browser player decodes and plays the test MP4');
        const stoppedResponse = await stopped;
        assert.equal(stoppedResponse.status(), 204, 'Playback completion report');
        console.log('PASS: browser naturally finished video and reported completion');
        await page.getByRole('heading', { name: 'Как вам фильм?', exact: true }).waitFor({ timeout: 25000 });
        await page.screenshot({ path: path.join(state, 'after-playback.png') });
        console.log('PASS: automatic rating dialog appeared after real playback');
        await page.getByRole('button', { name: '8 из 10', exact: true }).click();
        await page.getByText('Подключите аккаунт Кинопоиска.', { exact: true }).waitFor();
        assert.equal(await page.getByText('Оценка 8 из 10 отправлена в Кинопоиск.', { exact: true }).count(), 0);
        console.log('PASS: sending without linked account is rejected, no false success');
    } finally { await browser.close(); }
})().catch(error => { console.error('FAIL:', error.message); process.exitCode = 1; });
