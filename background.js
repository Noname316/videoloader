/**
 * Фон расширения:
 *   - следит за запросами вкладок и запоминает найденные видео (HLS-плейлисты,
 *     DASH-манифесты и обычные файлы) вместе с заголовками Referer/Origin,
 *     с которыми их запросил плеер;
 *   - ставит правила declarativeNetRequest, чтобы запросы расширения к CDN шли
 *     с теми же заголовками (правила касаются только запросов самого расширения);
 *   - запускает загрузки в offscreen-документе: он живёт независимо от попапа,
 *     поэтому закрытие попапа загрузку не прерывает;
 *   - сохраняет готовый файл в «Загрузки» (в offscreen-документе нет downloads API).
 *
 * Состояние лежит в storage.session: попап читает его и следит за изменениями.
 *   tab:<id> — найденные на вкладке видео, новые первыми;
 *   jobs     — загрузки: id → состояние;
 *   rules    — домен → id правила заголовков.
 */

import { classifyMedia, headerValue, MIN_FILE_SIZE, responseSize } from './js/sniffer.js';
import { ruleDomain } from './js/net-rules.js';
import { sanitizeFileName } from './js/util.js';

const api = globalThis.chrome;
const TYPES = ['xmlhttprequest', 'media', 'other'];
const MAX_ITEMS = 40;
const OFFSCREEN_URL = 'offscreen.html';
/** Подпапка «Загрузок» — по названию расширения. */
const DOWNLOAD_FOLDER = sanitizeFileName(api.runtime.getManifest().name, 'VideoLoader');

/** Чтение-изменение-запись storage.session по очереди, без гонок. */
let chain = Promise.resolve();
function serial(fn) {
    const p = chain.then(fn);
    chain = p.catch(() => {});
    return p;
}

async function getSession(key, fallback) {
    return (await api.storage.session.get(key))[key] ?? fallback;
}

const tabKey = tabId => `tab:${tabId}`;

// --- Поиск видео в запросах ------------------------------------------------------

/** @type {Map<string, Record<string, ?string>>} requestId → заголовки запроса */
const requestHeaders = new Map();

api.webRequest.onSendHeaders.addListener(d => {
    if (d.tabId < 0) return;
    requestHeaders.set(d.requestId, {
        Referer: headerValue(d.requestHeaders, 'referer') || null,
        Origin: headerValue(d.requestHeaders, 'origin') || null
    });
    if (requestHeaders.size > 500) requestHeaders.delete(requestHeaders.keys().next().value);
}, { urls: ['<all_urls>'], types: TYPES }, ['requestHeaders', 'extraHeaders']);

api.webRequest.onResponseStarted.addListener(d => {
    if (d.tabId < 0) return;
    if (d.type === 'main_frame') {
        forgetTab(d.tabId);
        return;
    }
    const headers = requestHeaders.get(d.requestId);
    requestHeaders.delete(d.requestId);
    if (d.statusCode >= 400) return;

    const kind = classifyMedia(d.url, headerValue(d.responseHeaders, 'content-type'));
    if (!kind) return;
    const size = responseSize(d.responseHeaders);
    if (kind === 'file' && size != null && size < MIN_FILE_SIZE) return;

    addMedia(d.tabId, {
        url: d.url,
        kind,
        size,
        headers: headers || { Referer: d.initiator ? `${d.initiator}/` : null, Origin: null },
        time: Date.now()
    });
}, { urls: ['<all_urls>'], types: [...TYPES, 'main_frame'] }, ['responseHeaders']);

api.webRequest.onErrorOccurred.addListener(d => requestHeaders.delete(d.requestId), { urls: ['<all_urls>'], types: TYPES });

api.tabs.onRemoved.addListener(tabId => forgetTab(tabId));

function addMedia(tabId, item) {
    return serial(async () => {
        const key = tabKey(tabId);
        const list = await getSession(key, []);
        const existing = list.find(m => m.url === item.url);
        if (existing) {
            // Плееры перезапрашивают плейлист и файл по частям — обновляем только размер.
            if (!(item.size > (existing.size || 0))) return;
            existing.size = item.size;
        } else {
            list.unshift(item);
            list.length = Math.min(list.length, MAX_ITEMS);
        }
        await api.storage.session.set({ [key]: list });
        await setBadge(tabId, list.length);
    });
}

function forgetTab(tabId) {
    return serial(async () => {
        await api.storage.session.remove(tabKey(tabId));
        await setBadge(tabId, 0);
    });
}

async function setBadge(tabId, count) {
    await api.action.setBadgeText({ tabId, text: count ? String(count) : '' }).catch(() => {});
}

api.runtime.onInstalled.addListener(() => {
    api.action.setBadgeBackgroundColor({ color: '#28b35e' });
});

// --- Заголовки для запросов расширения ------------------------------------------------

/**
 * @param {string} domain
 * @param {Record<string, ?string>} headers - null — убрать заголовок (например, Origin
 *   расширения там, где плеер Origin не отправлял).
 */
function setHeaderRule(domain, headers) {
    return serial(async () => {
        const requestHeaders = Object.entries(headers || {}).map(([header, value]) =>
            value ? { header, operation: 'set', value } : { header, operation: 'remove' });
        if (!requestHeaders.length) return;

        const rules = await getSession('rules', {});
        let id = rules[domain];
        if (id == null) {
            id = Math.max(0, ...Object.values(rules)) + 1;
            rules[domain] = id;
            await api.storage.session.set({ rules });
        }
        await api.declarativeNetRequest.updateSessionRules({
            removeRuleIds: [id],
            addRules: [{
                id,
                priority: 1,
                action: { type: 'modifyHeaders', requestHeaders },
                condition: {
                    requestDomains: [domain],
                    initiatorDomains: [api.runtime.id],
                    resourceTypes: ['xmlhttprequest', 'media', 'other']
                }
            }]
        });
    });
}

// --- Загрузки -----------------------------------------------------------------------

/** Через сколько забывать готовые и остановленные загрузки (истории нет, ошибки — до «Убрать»). */
const FORGET_FINISHED_MS = 10000;

function updateJob(id, patch) {
    return serial(async () => {
        const jobs = await getSession('jobs', {});
        if (!jobs[id] && !patch.id) return;
        const now = Date.now();
        jobs[id] = { ...jobs[id], ...patch };
        if (['done', 'cancelled', 'error'].includes(patch.status)) jobs[id].finishedAt ??= now;
        for (const [jobId, job] of Object.entries(jobs)) {
            if ((job.status === 'done' || job.status === 'cancelled') && now - job.finishedAt > FORGET_FINISHED_MS) delete jobs[jobId];
        }
        await api.storage.session.set({ jobs });
    });
}

let creatingOffscreen = null;
async function ensureOffscreen() {
    if (await api.offscreen.hasDocument()) return;
    creatingOffscreen ??= api.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ['BLOBS'],
        justification: 'Загрузка видео по сегментам и сборка файла в фоне'
    }).finally(() => { creatingOffscreen = null; });
    await creatingOffscreen;
}

/**
 * @param {{media: object, title: string, maxHeight: ?number, keepTs: boolean}} msg
 * @returns {Promise<{id: string}>}
 */
async function startDownload({ media, title, maxHeight, keepTs }) {
    const id = crypto.randomUUID();
    const job = { id, title, status: 'queued', done: 0, total: 0, bytes: 0, speed: 0, note: '', startedAt: Date.now() };
    await updateJob(id, job);
    try {
        await setHeaderRule(ruleDomain(media.url), media.headers);
        await ensureOffscreen();
        const res = await api.runtime.sendMessage({ target: 'offscreen', type: 'start', job, media, maxHeight, keepTs });
        if (!res?.ok) throw new Error('фоновый загрузчик не ответил');
    } catch (e) {
        await updateJob(id, { status: 'error', note: e.message });
    }
    return { id };
}

async function cancelDownload(id) {
    let res = null;
    if (await api.offscreen.hasDocument()) {
        res = await api.runtime.sendMessage({ target: 'offscreen', type: 'cancel', id }).catch(() => null);
    }
    // Загрузчика уже нет (например, offscreen-документ закрылся) — просто помечаем.
    if (!res?.ok) await updateJob(id, { status: 'cancelled', note: 'Остановлено' });
}

/** Убрать загрузку из попапа (кнопка «Убрать» у ошибки). */
function dismissJob(id) {
    return serial(async () => {
        const jobs = await getSession('jobs', {});
        if (!jobs[id] || ['queued', 'running', 'saving'].includes(jobs[id].status)) return;
        delete jobs[id];
        await api.storage.session.set({ jobs });
    });
}

/**
 * Сохраняет blob-ссылку offscreen-документа в «Загрузки/VideoLoader» и ждёт
 * окончания записи. Занятое имя Chrome заменяет на «Название (1).mp4».
 */
async function saveFile({ url, fileName }) {
    const filename = `${DOWNLOAD_FOLDER}/${fileName}`;
    const downloadId = await api.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
    await new Promise((resolve, reject) => {
        const listener = delta => {
            if (delta.id !== downloadId || !delta.state) return;
            if (delta.state.current === 'complete') done();
            else if (delta.state.current === 'interrupted') done(new Error(`сохранение прервано: ${delta.error?.current || 'неизвестная ошибка'}`));
        };
        const done = err => {
            api.downloads.onChanged.removeListener(listener);
            if (err) reject(err);
            else resolve();
        };
        api.downloads.onChanged.addListener(listener);
    });
    const [item] = await api.downloads.search({ id: downloadId });
    return { downloadId, savedAs: item?.filename?.split(/[\\/]/).pop() || fileName };
}

const handlers = {
    download: startDownload,
    cancel: msg => cancelDownload(msg.id),
    dismiss: msg => dismissJob(msg.id),
    'set-headers': msg => setHeaderRule(msg.domain, msg.headers),
    job: msg => updateJob(msg.id, msg.patch),
    save: saveFile
};

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const handler = msg?.target ? null : handlers[msg?.type];
    if (!handler) return false;
    Promise.resolve(handler(msg)).then(
        result => sendResponse(result ?? { ok: true }),
        e => sendResponse({ error: e?.message || String(e) })
    );
    return true;
});
