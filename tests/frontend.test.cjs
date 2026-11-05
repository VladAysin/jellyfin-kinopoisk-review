'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ui = require('../web/kinopoisk-ratings.js');

test('auth context preserves base path and changes on user, server or token switch', () => {
    const api = (user = 'u1', token = 'secret', base = 'https://media.test/jellyfin/') => ({
        accessToken: () => token, getCurrentUserId: () => user,
        getUrl: path => base + path, deviceId: () => 'desktop-1'
    });
    const context = ui.makeContext(api());
    assert.equal(context.url, 'https://media.test/jellyfin/KinopoiskRatings/');
    assert.equal(context.device, 'desktop-1');
    assert.notEqual(context.key, ui.makeContext(api('u2')).key);
    assert.notEqual(context.key, ui.makeContext(api('u1', 'new')).key);
    assert.notEqual(context.key, ui.makeContext(api('u1', 'secret', 'https://other/')).key);
    assert.equal(ui.makeContext(api('', 'secret')), null);
    assert.equal(ui.makeContext(api('u1', '')), null);
    assert.equal(ui.makeContext(null), null);
});

test('completed and dismissed items never become prompts; failures remain retryable', () => {
    assert.deepEqual(ui.eligible([
        {id:'1',status:'sent'}, {id:'2',status:'dismissed'},
        {id:'3',status:'failed'}, {id:'4',status:'pending'}, null, {title:'invalid'}
    ]).map(item => item.id), ['3','4']);
    assert.deepEqual(ui.eligible({error:'offline'}), []);
});

test('success UI requires explicit sent confirmation', () => {
    for (const value of [null, {}, {status:'pending'}, {status:'failed'}, {ok:true}]) {
        assert.equal(ui.confirmedSent(value), false);
    }
    assert.equal(ui.confirmedSent({status:'sent'}), true);
});

test('authorization header values cannot inject quotes or newlines', () => {
    assert.equal(ui.headerValue('desktop"\\\r\n, Token="other'), 'desktop, Token=other');
});
