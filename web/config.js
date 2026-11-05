export default function (view) {
    'use strict';
    var message = view.querySelector('#kpr-config-message');
    var connection = view.querySelector('#kpr-connection-status');
    var userLabel = view.querySelector('#kpr-current-user');
    var input = view.querySelector('#kpr-config-cookie');
    var queue = view.querySelector('#kpr-config-queue');
    var busy = false, visible = false, epoch = 0;

    function identity() {
        var api = window.ApiClient;
        if (!api || !api.accessToken() || !api.getCurrentUserId()) return null;
        return { api: api, token: api.accessToken(), user: api.getCurrentUserId(), base: api.getUrl('KinopoiskRatings/') };
    }
    function sameIdentity(captured) {
        var current = identity();
        return current && current.user === captured.user && current.token === captured.token && current.base === captured.base;
    }
    function safeHeader(value) { return String(value || '').replace(/["\\\r\n]/g, ''); }
    async function request(path, method, body) {
        var captured = identity(), currentEpoch = epoch;
        if (!captured) throw new Error('Войдите в Jellyfin.');
        var device = typeof captured.api.deviceId === 'function' ? captured.api.deviceId() : '';
        var headers = {
            'X-Emby-Token': captured.token,
            'X-Emby-Authorization': 'MediaBrowser Client="Kinopoisk Ratings Settings", Device="Web", DeviceId="' + safeHeader(device) + '", Version="0.3.1", Token="' + safeHeader(captured.token) + '"'
        };
        var options = { method: method || 'GET', headers: headers, credentials: 'same-origin', cache: 'no-store' };
        if (body !== undefined) { headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(body); }
        var controller = typeof AbortController === 'function' ? new AbortController() : null;
        if (controller) options.signal = controller.signal;
        var timer = setTimeout(function () { if (controller) controller.abort(); }, 30000);
        var response;
        try { response = await fetch(captured.base.replace(/\/?$/, '/') + path, options); }
        catch (error) { throw new Error(error.name === 'AbortError' ? 'Сервер не ответил вовремя. Результат отправки не подтверждён.' : 'Не удалось связаться с сервером.'); }
        finally { clearTimeout(timer); }
        var payload = null;
        try { payload = await response.json(); } catch (_) { /* A proxy can return HTML. */ }
        if (!visible || currentEpoch !== epoch || !sameIdentity(captured)) throw new Error('Пользователь или страница изменились. Обновите страницу настроек.');
        if (!response.ok) {
            var detail = payload && (payload.error || payload.message);
            throw new Error(typeof detail === 'string' ? detail : 'Ошибка сервера (' + response.status + ').');
        }
        return payload;
    }
    function setBusy(value) {
        busy = value;
        view.setAttribute('aria-busy', String(value));
        Array.prototype.forEach.call(view.querySelectorAll('button, input, select'), function (node) { node.disabled = value; });
    }
    async function action(work) {
        if (busy || !visible) return;
        var currentEpoch = epoch;
        setBusy(true); message.textContent = 'Подождите…';
        try { await work(); }
        catch (error) { if (visible && epoch === currentEpoch) message.textContent = error.message; }
        finally { if (visible && epoch === currentEpoch) setBusy(false); }
    }
    function node(tag, text) {
        var value = document.createElement(tag);
        if (text !== undefined) value.textContent = text;
        return value;
    }
    function button(text, callback) {
        var value = node('button', text);
        value.type = 'button'; value.className = 'raised emby-button'; value.style.margin = '0.4em 0.5em 0.4em 0';
        value.addEventListener('click', callback);
        return value;
    }
    async function loadConnection() {
        var result = await request('connection');
        connection.textContent = result && result.connected === true ? 'Сессия Кинопоиска сохранена.' : 'Кинопоиск ещё не подключён.';
    }
    async function loadQueue() {
        var result = await request('queue');
        if (!Array.isArray(result)) throw new Error('Сервер вернул неожиданный список оценок.');
        queue.textContent = '';
        if (!result.length) { queue.appendChild(node('p', 'Нет фильмов и сериалов, ожидающих оценки.')); return; }
        result.forEach(function (item) {
            var section = node('section'); section.style.marginBottom = '2em';
            section.appendChild(node('h4', item.title || 'Без названия'));
            if (item.kind === 'series') section.appendChild(node('p', 'Оценка относится ко всему сериалу.'));
            if (item.error) section.appendChild(node('p', item.error));
            var select = node('select'); select.className = 'emby-select';
            select.setAttribute('aria-label', 'Оценка: ' + (item.title || 'Без названия'));
            for (var score = 1; score <= 10; score += 1) {
                var option = node('option', score + ' из 10'); option.value = String(score); select.appendChild(option);
            }
            select.value = String(item.rating >= 1 && item.rating <= 10 ? item.rating : 7);
            section.appendChild(select);
            section.appendChild(button('Отправить оценку', function () { action(async function () {
                var rating = Number(select.value);
                var sent = await request('queue/' + encodeURIComponent(item.id) + '/rate', 'POST', { rating: rating });
                if (!sent || sent.status !== 'sent') throw new Error('Кинопоиск не подтвердил отправку оценки.');
                await loadQueue(); message.textContent = 'Оценка отправлена в Кинопоиск.';
            }); }));
            section.appendChild(button('Позже', function () { dismiss(true); }));
            section.appendChild(button('Не предлагать', function () { dismiss(false); }));
            queue.appendChild(section);
            function dismiss(defer) { action(async function () {
                await request('queue/' + encodeURIComponent(item.id) + '/dismiss', 'POST', { defer: defer });
                await loadQueue(); message.textContent = defer ? 'Предложение отложено на сутки.' : 'Запись больше не будет предлагаться.';
            }); }
        });
    }
    view.querySelector('#kpr-connection-form').addEventListener('submit', function (event) {
        event.preventDefault();
        var cookie = input.value.trim(); input.value = '';
        if (!cookie) { message.textContent = 'Вставьте Cookie своей сессии.'; return; }
        if (cookie.length > 32768) { message.textContent = 'Cookie длиннее 32768 символов. Скопируйте значение только одного заголовка Cookie.'; return; }
        action(async function () {
            try {
                var result = await request('connection', 'PUT', { cookie: cookie });
                if (!result || result.connected !== true) throw new Error('Сервер не подтвердил подключение.');
                await loadConnection(); message.textContent = 'Кинопоиск подключён для текущего пользователя Jellyfin.';
            } finally { cookie = ''; }
        });
    });
    view.querySelector('#kpr-disconnect').addEventListener('click', function () { action(async function () {
        var result = await request('connection', 'DELETE');
        if (!result || result.connected !== false) throw new Error('Сервер не подтвердил отключение.');
        await loadConnection(); message.textContent = 'Сессия удалена из плагина.';
    }); });
    view.querySelector('#kpr-refresh-queue').addEventListener('click', function () { action(async function () {
        await loadQueue(); message.textContent = '';
    }); });
    view.addEventListener('viewshow', function () {
        visible = true; epoch += 1; setBusy(false); input.value = ''; queue.textContent = '';
        var current = identity();
        userLabel.textContent = current ? 'Текущий пользователь Jellyfin: ' + current.user : 'Войдите в Jellyfin.';
        if (current && typeof current.api.getCurrentUser === 'function') {
            current.api.getCurrentUser().then(function (user) {
                if (visible && sameIdentity(current)) userLabel.textContent = 'Текущий пользователь Jellyfin: ' + (user.Name || current.user);
            }).catch(function () { /* ID remains the fallback. */ });
        }
        action(async function () { await loadConnection(); await loadQueue(); message.textContent = ''; });
    });
    view.addEventListener('viewhide', function () { visible = false; epoch += 1; input.value = ''; queue.textContent = ''; message.textContent = ''; });
}
