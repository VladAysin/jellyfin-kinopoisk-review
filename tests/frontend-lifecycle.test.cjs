'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

// Minimal DOM harness: exercise the real async UI against mocked server responses.
function environment(responder, hash = '') {
    let document;
    class Node {
        constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.events = {}; this.text = ''; this.hidden = false; }
        appendChild(node) { node.parent = this; this.children.push(node); return node; }
        set textContent(text) { this.text = text; this.children = []; }
        get textContent() { return this.text + this.children.map(node => node.textContent).join(''); }
        setAttribute(name, value) { this.attributes[name] = value; }
        removeAttribute(name) { delete this.attributes[name]; }
        addEventListener(name, handler) { this.events[name] = handler; }
        remove() { this.parent.children = this.parent.children.filter(node => node !== this); }
        focus() { document.activeElement = this; }
        contains(node) { return this === node || this.children.some(child => child.contains(node)); }
        querySelectorAll(selector) {
            const nodes = this.children.flatMap(node => [node, ...node.querySelectorAll('*')]);
            if (selector === '*') return nodes;
            return nodes.filter(node => ['button','input','textarea'].includes(node.tagName));
        }
    }
    document = {
        head: new Node('head'), body: new Node('body'), readyState: 'complete', hidden: false,
        createElement: tag => new Node(tag),
        contains: node => document.body.contains(node),
        addEventListener() {}, removeEventListener() {}
    };
    const state = { user:'u1', token:'token1' }, intervals = [], requests = [];
    const root = {
        document, location: { hash }, setTimeout, clearTimeout, AbortController,
        setInterval: (fn, time) => intervals.push({fn,time}),
        ApiClient: { accessToken:()=>state.token, getCurrentUserId:()=>state.user, deviceId:()=> 'dev', getUrl: route => 'https://test/jellyfin/' + route },
        fetch: async (url, options) => {
            const route = url.split('KinopoiskRatings/')[1]; requests.push({route,options});
            const value = await responder(route, options);
            return { ok:true, status:200, text:async()=>JSON.stringify(value) };
        }
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../web/kinopoisk-ratings.js'), 'utf8'), {window:root});
    const all = () => document.body.querySelectorAll('*');
    return {state,document,intervals,requests,all,button:text=>all().find(node=>node.tagName==='button' && node.textContent===text)};
}
async function flush() { for(let i=0;i<10;i++) await new Promise(resolve=>setImmediate(resolve)); }

test('native settings page is not interrupted by automatic rating prompts', async () => {
    const env = environment(() => { throw new Error('Unexpected polling on settings'); }, '#/configurationpage?name=KinopoiskRatings');
    await flush();
    assert.equal(env.requests.length, 0);
    assert.equal(env.all().some(node => node.attributes.role === 'dialog'), false);
    assert.equal(env.button('КП'), undefined);
});

test('active playback suppresses automatic dialogs and even queue requests', async () => {
    const env = environment(() => ({active:true})); await flush();
    assert.equal(env.button('КП'),undefined);
    assert.equal(env.requests.length,1);
    assert.equal(env.requests[0].route,'playback-active');
    assert.equal(env.all().some(node => node.attributes.role === 'dialog'), false);
});

test('title is plain text, success requires backend confirmation, logout removes dialog', async () => {
    const hostileTitle = '<img src=x onerror=alert(1)>';
    const env = environment(route => route === 'playback-active' ? {active:false} : route === 'queue' ? [{id:'1',title:hostileTitle,status:'pending',kinopoiskId:'123'}] : {status:'sent'});
    await flush();
    assert.equal(env.all().find(node => node.tagName === 'h3').textContent,hostileTitle);
    assert.equal(env.all().some(node=>node.tagName==='img'),false);
    env.button('8').events.click(); await flush();
    assert.match(env.document.body.textContent,/Оценка 8 из 10 отправлена/);
    const submission = env.requests.find(entry=>entry.route.endsWith('/rate'));
    assert.equal(JSON.parse(submission.options.body).rating,8);
    assert.match(submission.options.headers['X-Emby-Authorization'],/DeviceId="dev"/);
    env.state.token = ''; env.state.user = '';
    env.intervals.find(entry=>entry.time===1000).fn();
    assert.equal(env.all().some(node=>node.attributes.role==='dialog'),false);
    assert.equal(env.button('КП'),undefined);
});

test('queue response for previous user cannot open a dialog after account switch', async () => {
    let resolveQueue;
    const env = environment(route => route === 'playback-active' ? {active:false} : new Promise(resolve=>{resolveQueue=resolve;}));
    await flush();
    env.state.user='u2'; env.state.token='token2';
    resolveQueue([{id:'private',title:'Private user one title',status:'pending'}]); await flush();
    assert.equal(env.document.body.textContent.includes('Private user one title'),false);
    assert.equal(env.all().some(node=>node.attributes.role==='dialog'),false);
});
