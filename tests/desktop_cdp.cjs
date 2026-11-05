'use strict';
// Minimal DevTools transport for Qt WebEngine, which lacks Playwright context APIs.
class DesktopCdp {
    constructor(socket) {
        this.socket = socket; this.nextId = 1; this.pending = new Map(); this.events = [];
        socket.addEventListener('message', event => {
            const message = JSON.parse(event.data);
            if (message.id) {
                const pending = this.pending.get(message.id); if (!pending) return;
                this.pending.delete(message.id); clearTimeout(pending.timer);
                if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
            } else this.events.push(message);
        });
    }
    static async connect() {
        const pages = await (await fetch('http://127.0.0.1:18097/json/list')).json();
        const page = pages.find(x => x.type === 'page');
        if (!page) throw new Error('No test desktop page found');
        const socket = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
        const cdp = new DesktopCdp(socket);
        await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
        return cdp;
    }
    send(method, params = {}) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 30000);
            this.pending.set(id, { resolve, reject, timer });
            this.socket.send(JSON.stringify({ id, method, params }));
        });
    }
    async evaluate(expression) {
        const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
        if (result.exceptionDetails) throw new Error('Desktop evaluation failed: ' + (result.exceptionDetails.exception?.description || result.exceptionDetails.text));
        return result.result?.value;
    }
    async wait(expression, timeout = 30000) {
        const end = Date.now() + timeout;
        while (Date.now() < end) {
            try { if (await this.evaluate(expression)) return; } catch (_) { /* Navigation replaces execution context. */ }
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        throw new Error('Desktop condition timed out: ' + expression);
    }
    close() { this.socket.close(); }
}
module.exports = { DesktopCdp };
