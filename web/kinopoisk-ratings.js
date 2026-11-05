(function (root) {
    'use strict';

    // Deliberately ES2017: Jellyfin Media Player 1.12 uses Qt WebEngine.
    function eligible(items) {
        return (Array.isArray(items) ? items : []).filter(function (item) {
            return item && item.id && item.status !== 'sent' && item.status !== 'dismissed';
        });
    }
    function headerValue(value) { return String(value || '').replace(/["\\\r\n]/g, ''); }
    function makeContext(api) {
        if (!api || typeof api.accessToken !== 'function' || typeof api.getCurrentUserId !== 'function') return null;
        var token = api.accessToken(), user = api.getCurrentUserId();
        if (!token || !user) return null;
        var url = api.getUrl('KinopoiskRatings/');
        return {
            key: url + '\n' + user + '\n' + token,
            url: url.replace(/\/?$/, '/'), token: token,
            device: typeof api.deviceId === 'function' ? api.deviceId() : ''
        };
    }
    function confirmedSent(result) { return !!result && result.status === 'sent'; }
    var helpers = { eligible: eligible, headerValue: headerValue, makeContext: makeContext, confirmedSent: confirmedSent };
    if (typeof module !== 'undefined' && module.exports) module.exports = helpers;
    if (!root.document || root.__kinopoiskRatingsLoaded) return;
    root.__kinopoiskRatingsLoaded = true;

    var document = root.document, context = null, modal = null;
    var generation = 0, polling = false, shown = Object.create(null), busy = false;

    function element(tag, text, className) {
        var node = document.createElement(tag);
        if (text !== undefined) node.textContent = text;
        if (className) node.className = className;
        return node;
    }
    function button(text, handler, className) {
        var node = element('button', text, className || 'kpr-button');
        node.type = 'button'; node.addEventListener('click', handler); return node;
    }
    function currentKey() { var value = makeContext(root.ApiClient); return value ? value.key : null; }
    function refreshIdentity() {
        var next = makeContext(root.ApiClient);
        if ((context && context.key) !== (next && next.key)) {
            context = next; generation += 1; shown = Object.create(null); polling = false;
            close(true);
        }
        return context;
    }
    async function request(path, method, data) {
        var captured = refreshIdentity();
        if (!captured) throw new Error('Войдите в Jellyfin.');
        var headers = {
            'X-Emby-Token': captured.token,
            'X-Emby-Authorization': 'MediaBrowser Client="Kinopoisk Ratings", Device="Web", DeviceId="' + headerValue(captured.device) + '", Version="0.3.1", Token="' + headerValue(captured.token) + '"'
        };
        var options = { method: method || 'GET', headers: headers, credentials: 'same-origin', cache: 'no-store' };
        if (data !== undefined) { headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(data); }
        var controller = typeof root.AbortController === 'function' ? new root.AbortController() : null;
        if (controller) options.signal = controller.signal;
        var timeout = root.setTimeout(function () { if (controller) controller.abort(); }, 25000);
        var response, text;
        try {
            response = await root.fetch(captured.url + path, options);
            text = await response.text();
        } catch (error) {
            if (error.name === 'AbortError') throw new Error('Сервер не ответил вовремя. Проверьте статус оценки в списке перед повторной отправкой.');
            throw error;
        } finally { root.clearTimeout(timeout); }
        if (currentKey() !== captured.key) { refreshIdentity(); throw new Error('Пользователь Jellyfin изменился.'); }
        var payload = null;
        try { payload = text ? JSON.parse(text) : null; } catch (_) { /* Server/proxy may return HTML. */ }
        if (!response.ok) {
            var message = payload && (payload.message || payload.error || payload.title);
            throw new Error(typeof message === 'string' ? message : 'Ошибка сервера (' + response.status + '). Повторите позже.');
        }
        return payload;
    }
    function close(force) {
        if (busy && !force) return;
        if (modal) {
            var previous = modal.previous;
            modal.overlay.remove(); document.removeEventListener('keydown', keydown, true);
            modal = null; busy = false;
            if (previous && document.contains(previous)) previous.focus();
        }
    }
    function keydown(event) {
        if (!modal) return;
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(false); }
        if (event.key !== 'Tab') return;
        var nodes = Array.prototype.slice.call(modal.panel.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href]'));
        nodes = nodes.filter(function (node) { return !node.hidden && node.offsetParent !== null; });
        if (!nodes.length) { event.preventDefault(); modal.panel.focus(); return; }
        var first = nodes[0], last = nodes[nodes.length - 1];
        if (event.shiftKey && (document.activeElement === first || !modal.panel.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !modal.panel.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    }
    function open(title) {
        if (!refreshIdentity()) return null;
        close(true);
        var overlay = element('div', undefined, 'kpr-overlay'), panel = element('section', undefined, 'kpr-panel');
        panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-labelledby', 'kpr-title'); panel.tabIndex = -1;
        var heading = element('h2', title); heading.id = 'kpr-title';
        var dismiss = button('Закрыть', function () { close(false); }, 'kpr-button kpr-close');
        var content = element('div'), message = element('p', '', 'kpr-message');
        message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
        panel.appendChild(dismiss); panel.appendChild(heading); panel.appendChild(content); panel.appendChild(message); overlay.appendChild(panel);
        modal = { overlay: overlay, panel: panel, content: content, message: message, previous: document.activeElement, generation: generation };
        document.body.appendChild(overlay); document.addEventListener('keydown', keydown, true); dismiss.focus();
        return modal;
    }
    function live(view) { return modal === view && view.generation === generation && context && context.key === currentKey(); }
    async function action(view, work) {
        if (busy || !live(view)) return;
        busy = true; view.panel.setAttribute('aria-busy', 'true');
        var controls = view.panel.querySelectorAll('button, input, textarea');
        Array.prototype.forEach.call(controls, function (node) { node.disabled = true; });
        view.message.textContent = 'Подождите…';
        try { await work(); }
        catch (error) { if (live(view)) view.message.textContent = error.message || 'Не удалось выполнить запрос.'; }
        finally {
            if (live(view)) {
                busy = false; view.panel.removeAttribute('aria-busy');
                Array.prototype.forEach.call(controls, function (node) { node.disabled = false; });
            }
        }
    }
    function settings() {
        close(true);
        root.location.hash = '/configurationpage?name=KinopoiskRatings';
    }
    function rating(item) {
        var view = open('Как вам ' + (item.kind === 'series' ? 'сериал' : 'фильм') + '?'); if (!view) return;
        shown[item.id] = true;
        view.content.appendChild(element('h3', item.title || 'Без названия'));
        if (item.kind === 'series') view.content.appendChild(element('p', 'Оценка относится ко всему сериалу.'));
        var link = element('a', 'Открыть на Кинопоиске');
        if (/^\d+$/.test(String(item.kinopoiskId))) {
            link.href = 'https://www.kinopoisk.ru/film/' + item.kinopoiskId + '/'; link.target = '_blank'; link.rel = 'noopener noreferrer'; view.content.appendChild(link);
        }
        var group = element('div', undefined, 'kpr-scores'); group.setAttribute('role', 'group'); group.setAttribute('aria-label', 'Оценка от 1 до 10');
        for (var score = 1; score <= 10; score += 1) (function (value) {
            var scoreButton = button(String(value), function () {
                action(view, async function () {
                    var result = await request('queue/' + encodeURIComponent(item.id) + '/rate', 'POST', { rating: value });
                    if (!confirmedSent(result)) throw new Error('Кинопоиск не подтвердил отправку. Оценку можно повторить из списка.');
                    if (live(view)) {
                        view.content.textContent = '';
                        view.content.appendChild(element('p', 'Оценка ' + value + ' из 10 отправлена в Кинопоиск.'));
                        view.content.appendChild(button('Готово', function () { close(false); }));
                        view.message.textContent = '';
                    }
                });
            });
            scoreButton.setAttribute('aria-label', value + ' из 10'); group.appendChild(scoreButton);
        })(score);
        view.content.appendChild(group);
        view.content.appendChild(button('Позже', function () { dismiss(true); }));
        view.content.appendChild(button('Не предлагать', function () { dismiss(false); }));
        view.content.appendChild(button('Подключение Кинопоиска', settings));
        if (item.error) view.message.textContent = item.error;
        function dismiss(defer) { action(view, async function () {
            await request('queue/' + encodeURIComponent(item.id) + '/dismiss', 'POST', { defer: defer }); if (live(view)) close(true);
        }); }
    }
    async function poll() {
        if (!refreshIdentity() || polling || modal || document.hidden ||
            (root.location && /configurationpage.*KinopoiskRatings/i.test(root.location.hash))) return;
        polling = true; var epoch = generation;
        try {
            var playback = await request('playback-active');
            if (!playback || playback.active !== false || epoch !== generation) return;
            var items = eligible(await request('queue'));
            if (epoch !== generation || modal || document.hidden) return;
            var item = items.filter(function (entry) { return !shown[entry.id]; })[0];
            if (item) {
                // Re-check after queue fetch so a newly started episode is not interrupted.
                playback = await request('playback-active');
                if (playback && playback.active === false && epoch === generation && !modal) rating(item);
            }
        } catch (_) { /* Background network failures must not interrupt playback. */ }
        finally { if (epoch === generation) polling = false; }
    }
    function start() {
        var style = element('style');
        style.textContent = '.kpr-overlay{position:fixed;inset:0;top:0;right:0;bottom:0;left:0;z-index:100000;background:rgba(0,0,0,.76);display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box}.kpr-panel{font:16px/1.5 sans-serif;background:#24242b;color:#fff;border:1px solid #62626e;border-radius:16px;max-width:580px;width:100%;max-height:85vh;overflow:auto;padding:24px;box-shadow:0 20px 80px #000;box-sizing:border-box}.kpr-panel h2{font-size:24px;margin:12px 0}.kpr-panel h3{font-size:21px;overflow-wrap:break-word}.kpr-panel p{line-height:1.5}.kpr-panel a{color:#8dcaff}.kpr-button{font:inherit;padding:10px 13px;margin:5px 6px 5px 0;background:#393944;color:#fff;border:1px solid #747480;border-radius:8px;cursor:pointer}.kpr-button:hover{background:#505060}.kpr-button:focus,.kpr-panel input:focus{outline:3px solid #ff9d45;outline-offset:2px}.kpr-button:disabled{opacity:.55;cursor:wait}.kpr-close{float:right;font-size:13px}.kpr-scores{display:flex;flex-wrap:wrap;margin:20px 0}.kpr-scores button{min-width:45px;font-weight:bold}.kpr-item{display:block;width:100%;text-align:left;overflow-wrap:break-word}.kpr-panel label{display:block;margin-top:15px}.kpr-panel input{display:block;width:100%;box-sizing:border-box;padding:12px;margin:8px 0;background:#18181f;color:#fff;border:1px solid #888;border-radius:6px}.kpr-message{color:#ffd5ad;white-space:pre-wrap;overflow-wrap:break-word}.kpr-message:empty{display:none}';
        document.head.appendChild(style);
        refreshIdentity(); poll();
        document.addEventListener('visibilitychange', poll);
        if (root.addEventListener) root.addEventListener('focus', poll);
        root.setInterval(refreshIdentity, 1000); root.setInterval(poll, 10000);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})(typeof window !== 'undefined' ? window : globalThis);
