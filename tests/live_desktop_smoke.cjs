'use strict';
// Actual JMP 1.12.0 + native MPV in the isolated Linux/Xvfb container.
const { DesktopCdp } = require('./desktop_cdp.cjs');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

(async () => {
    const state = path.resolve(__dirname, '../.research/jellyfin-smoke');
    const auth = JSON.parse(fs.readFileSync(path.join(state, 'auth.json'), 'utf8'));
    const item = JSON.parse(fs.readFileSync(path.join(state, 'item.json'), 'utf8'));
    const base = 'http://127.0.0.1:18096';
    async function api(route, method = 'GET', body) {
        const response = await fetch(base + route, { method, headers: { 'X-Emby-Token': auth.accessToken, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
        assert(response.ok, 'Local setup API failed: ' + response.status);
        return response.status === 204 ? null : response.json();
    }
    const credentials = { username: 'kp-desktop-' + crypto.randomBytes(4).toString('hex'), password: crypto.randomBytes(24).toString('base64url') };
    const user = await api('/Users/New', 'POST', { Name: credentials.username, Password: credentials.password });
    await api('/Users/' + user.Id + '/Policy', 'POST', { ...user.Policy, IsAdministrator: true });
    fs.writeFileSync(path.join(state, 'desktop-credentials.json'), JSON.stringify(credentials), { mode: 0o600 });
    const cdp = await DesktopCdp.connect();
    try {
        await cdp.wait("!!document.querySelector('#txtManualName')");
        await cdp.evaluate(`document.querySelector('#txtManualName').value=${JSON.stringify(credentials.username)};document.querySelector('#txtManualPassword').value=${JSON.stringify(credentials.password)};document.querySelector('#txtManualPassword').closest('form').querySelector('[type=submit]').click();`);
        await cdp.wait(`window.ApiClient && window.ApiClient.getCurrentUserId() === ${JSON.stringify(user.Id)} && /home/.test(location.hash)`, 30000);
        const native = await cdp.evaluate("({native:!!window.NativeShell,loaded:!!window.__kinopoiskRatingsLoaded,launcher:!!document.querySelector('.kpr-launch'),agent:navigator.userAgent})");
        assert(native.native && native.loaded && !native.launcher);
        assert(native.agent.includes('JellyfinMediaPlayer') || native.agent.includes('Jellyfin Media Player'));
        console.log('PASS: actual JMP login loads plugin; no floating button');
        await cdp.evaluate("location.hash='/configurationpage?name=KinopoiskRatings'");
        await cdp.wait("document.querySelector('#kpr-connection-status') && document.querySelector('#kpr-connection-status').textContent==='Кинопоиск ещё не подключён.'");
        fs.writeFileSync(path.join(state, 'desktop-settings.png'), Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
        console.log('PASS: native plugin settings work inside JMP');
        await cdp.evaluate(`location.hash='/details?id=${item.itemId}&serverId=${auth.serverId}'`);
        await cdp.wait("Array.from(document.querySelectorAll('.btnPlay')).some(b=>b.offsetParent!==null)");
        await cdp.evaluate("Array.from(document.querySelectorAll('.btnPlay')).find(b=>b.offsetParent!==null).click()");
        let observedPlayback = false;
        for (let attempt = 0; attempt < 40; attempt++) {
            const sessions = await api('/Sessions');
            if (sessions.some(s => s.UserId === user.Id && s.NowPlayingItem && s.NowPlayingItem.Id === item.itemId)) { observedPlayback = true; break; }
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        assert(observedPlayback, 'Desktop playback did not start');
        assert.equal(await cdp.evaluate("Array.from(document.querySelectorAll('video')).some(v=>!v.paused)"), false, 'Expected native MPV, not HTML video');
        assert.equal(await cdp.evaluate("!!document.querySelector('.kpr-panel')"), false, 'Popup interrupted native playback');
        console.log('PASS: native desktop playback started, no popup during playback');
        await cdp.wait("document.querySelector('#kpr-title') && document.querySelector('#kpr-title').textContent==='Как вам фильм?'", 60000);
        const sessions = await api('/Sessions');
        assert.equal(sessions.some(s => s.UserId === user.Id && s.NowPlayingItem), false, 'Popup before playback stopped');
        fs.writeFileSync(path.join(state, 'desktop-after-playback.png'), Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
        console.log('PASS: automatic rating window appeared after native MPV playback');
        await cdp.evaluate("document.querySelector('button[aria-label=\"8 из 10\"]').click()");
        await cdp.wait("document.querySelector('.kpr-message') && document.querySelector('.kpr-message').textContent==='Подключите аккаунт Кинопоиска.'");
        console.log('PASS: desktop rejects submission without linked Kinopoisk account');
    } finally { cdp.close(); }
})().catch(error => { console.error('FAIL:', error.message); process.exitCode = 1; });
