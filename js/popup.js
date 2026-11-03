/**
 * Попап: видео, найденные на текущей вкладке, и ход загрузок.
 *
 * Найденные HLS-плейлисты и DASH-манифесты попап сам читает: так видно
 * длительность и варианты качества, а варианты мастер-плейлиста, которые плеер
 * тоже успел запросить, не показываются отдельными строками. Сама загрузка идёт
 * в фоне, попап только отправляет команду и показывает состояние из storage.session.
 */

import { parseMpd, pickRepresentations, unsupportedReason } from './dash.js';
import { loadMediaPlaylist, parse } from './playlist.js';
import { ruleDomain, setRequestHeaders } from './net-rules.js';
import { ext, formatBytes, formatDuration, sanitizeFileName } from './util.js';

const $ = id => document.getElementById(id);

/** Подпапка «Загрузок», куда фон сохраняет видео (то же правило, что в background.js). */
const DOWNLOAD_FOLDER = sanitizeFileName(ext.runtime.getManifest().name, 'VideoLoader');

const ACTIVE = ['queued', 'running', 'saving'];
/** Потоки, которые попап читает сам (HLS-плейлист, DASH-манифест). */
const STREAMS = ['hls', 'dash'];
/** Сколько ещё показывать готовую или остановленную загрузку. */
const RECENT_MS = 4000;
/** Сколько последних плейлистов проверять (на страницах с рекламой их бывает много). */
const MAX_INSPECT = 15;

const state = {
    tab: null,
    /** @type {Array<{url: string, kind: string, size: ?number, headers: object}>} */
    items: [],
    /** @type {Map<string, object>} url → результат проверки плейлиста */
    info: new Map(),
    /** @type {Map<string, number>} url → выбранное качество */
    choice: new Map(),
    mediaSignature: ''
};

async function init() {
    // ?tabId= — для тестов, когда попап открыт обычной вкладкой.
    const forcedTab = Number(new URLSearchParams(location.search).get('tabId'));
    state.tab = forcedTab
        ? await ext.tabs.get(forcedTab)
        : (await ext.tabs.query({ active: true, currentWindow: true }))[0];
    try {
        $('pageHost').textContent = new URL(state.tab.url).hostname;
    } catch { /* адрес вкладки недоступен */ }

    const key = `tab:${state.tab?.id}`;
    const data = await ext.storage.session.get([key, 'jobs']);
    setItems(data[key] || []);
    renderJobs(data.jobs || {});

    const { keepTs = false } = await ext.storage.local.get('keepTs');
    $('keepTs').checked = keepTs;
    $('keepTs').addEventListener('change', () => ext.storage.local.set({ keepTs: $('keepTs').checked }));
    $('folderName').textContent = `Загрузки/${DOWNLOAD_FOLDER}`;
    $('openFolderBtn').addEventListener('click', openFolder);

    ext.storage.onChanged.addListener((changes, area) => {
        if (area !== 'session') return;
        if (changes[key]) setItems(changes[key].newValue || []);
        if (changes.jobs) renderJobs(changes.jobs.newValue || {});
    });
}

/**
 * Открыть произвольную папку downloads API не умеет, только «показать файл в
 * папке». Поэтому показываем последнее сохранённое видео — откроется
 * «Загрузки/VideoLoader». Если таких файлов ещё нет — просто «Загрузки».
 */
async function openFolder() {
    const sep = '[\\\\/]';
    const name = DOWNLOAD_FOLDER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const [item] = await ext.downloads.search({
        filenameRegex: `${sep}${name}${sep}[^\\\\/]+$`,
        exists: true,
        state: 'complete',
        orderBy: ['-startTime'],
        limit: 1
    });
    if (item) ext.downloads.show(item.id);
    else ext.downloads.showDefaultFolder();
}

// --- Найденные видео ----------------------------------------------------------------

function setItems(items) {
    state.items = items;
    items.filter(i => STREAMS.includes(i.kind)).slice(0, MAX_INSPECT).forEach(inspect);
    renderMedia();
}

function inspect(item) {
    if (state.info.has(item.url)) return;
    state.info.set(item.url, { pending: true });
    (item.kind === 'dash' ? inspectDash(item) : inspectHls(item))
        .catch(e => ({ error: e.message }))
        .then(info => {
            state.info.set(item.url, info);
            renderMedia();
        });
}

/** Читает плейлист: длительность, варианты качества, поддерживается ли поток. */
async function inspectHls(item) {
    const domains = new Set();
    const cache = new Map();
    const fetchText = url => {
        if (!cache.has(url)) cache.set(url, fetchPlaylist(url, item.headers, domains));
        return cache.get(url);
    };

    const manifest = parse(await fetchText(item.url));
    const variants = [];
    const variantUrls = [];
    for (const p of manifest.playlists || []) {
        variantUrls.push(new URL(p.uri, item.url).href);
        const height = p.attributes?.RESOLUTION?.height || 0;
        if (height && !variants.some(v => v.height === height)) variants.push({ height });
    }
    variants.sort((a, b) => b.height - a.height);

    // Проверяет и лучший вариант: трансляции, отдельные аудиодорожки и
    // неподдерживаемое шифрование отсеиваются здесь, а не посреди загрузки.
    const best = await loadMediaPlaylist(item.url, fetchText);
    return { variants, variantUrls, duration: best.duration, resolution: best.resolution, domains: [...domains] };
}

/** Читает DASH-манифест: длительность, качества, есть ли звук, можно ли скачать. */
async function inspectDash(item) {
    const domains = new Set();
    const mpd = parseMpd(await fetchPlaylist(item.url, item.headers, domains), item.url);
    const reason = unsupportedReason(mpd);
    if (reason) throw new Error(reason);
    const heights = [...new Set(mpd.video.map(v => v.height).filter(Boolean))].sort((a, b) => b - a);
    const { video } = pickRepresentations(mpd);
    return {
        variants: heights.map(height => ({ height })),
        variantUrls: [],
        duration: mpd.duration,
        resolution: video.width && video.height ? `${video.width}x${video.height}` : null,
        noAudio: !mpd.audio.length,
        domains: [...domains]
    };
}

async function fetchPlaylist(url, headers, domains) {
    const domain = ruleDomain(url);
    if (!domains.has(domain)) {
        domains.add(domain);
        await setRequestHeaders(domain, headers);
    }
    const res = await fetch(url, { credentials: 'include', cache: 'no-store' });
    if (!res.ok) throw new Error(`плейлист недоступен (HTTP ${res.status}) — обновите страницу`);
    return res.text();
}

function renderMedia() {
    const hidden = new Set([...state.info.values()].flatMap(i => i.variantUrls || []));
    const visible = state.items.filter(i => !hidden.has(i.url));

    // Не перерисовывать без нужды: иначе закроется открытый список качества.
    const signature = JSON.stringify(visible.map(i => [i.url, i.size, state.info.get(i.url)]));
    if (signature === state.mediaSignature) return;
    state.mediaSignature = signature;

    $('media').replaceChildren(...visible.map(mediaCard));
    const pending = visible.some(i => state.info.get(i.url)?.pending);
    $('loading').classList.toggle('hidden', !pending);
    $('empty').classList.toggle('hidden', visible.length > 0);
}

function mediaCard(item) {
    const info = state.info.get(item.url);
    const card = el('div', 'card');
    const row = el('div', 'card-row');
    const main = el('div', 'card-main');
    const title = el('div', 'card-title');
    const sub = el('div', 'card-sub');
    sub.textContent = shortUrl(item.url);
    sub.title = item.url;
    main.append(title, sub);

    const button = el('button');
    button.type = 'button';
    button.textContent = 'Скачать';
    let select = null;

    if (STREAMS.includes(item.kind)) {
        row.append(badge(item.kind.toUpperCase()), main);
        if (info?.pending) {
            title.textContent = 'Поток';
            sub.textContent = 'проверяю…';
        } else if (info?.error) {
            title.textContent = 'Поток';
            sub.textContent = info.error;
            sub.className = 'card-sub error';
            button.disabled = true;
        } else if (info) {
            const quality = info.variants.length ? '' : info.resolution || '';
            title.textContent = [formatDuration(info.duration), quality, info.noAudio ? 'без звука' : ''].filter(Boolean).join(' · ');
            if (info.variants.length > 1) {
                select = el('select');
                select.title = 'Качество';
                select.append(...info.variants.map(v => new Option(`${v.height}p`, String(v.height))));
                select.value = String(state.choice.get(item.url) ?? info.variants[0].height);
                select.addEventListener('change', () => state.choice.set(item.url, Number(select.value)));
                row.append(select);
            } else if (info.variants.length === 1) {
                title.textContent += ` · ${info.variants[0].height}p`;
            }
        } else {
            title.textContent = 'Поток';
        }
    } else {
        const extension = /\.([a-z0-9]{2,4})$/i.exec(new URL(item.url).pathname)?.[1]?.toUpperCase() || 'ФАЙЛ';
        row.append(badge(extension), main);
        title.textContent = item.size ? formatBytes(item.size) : 'Видеофайл';
    }

    button.addEventListener('click', () => startDownload(item, info, select, button));
    row.append(button);
    card.append(row);
    return card;
}

async function startDownload(item, info, select, button) {
    const height = select ? Number(select.value) : info?.variants?.[0]?.height || null;
    // Название — на момент нажатия: вкладка могла перейти на другую страницу.
    const tab = state.tab ? await ext.tabs.get(state.tab.id).catch(() => state.tab) : null;
    const name = tab?.title || new URL(item.url).hostname;
    button.disabled = true;
    button.textContent = 'Запускаю…';
    try {
        await ext.runtime.sendMessage({
            type: 'download',
            media: { kind: item.kind, url: item.url, size: item.size, headers: item.headers, domains: info?.domains || [] },
            title: height ? `${name} [${height}p]` : name,
            maxHeight: select ? height : null,
            keepTs: $('keepTs').checked
        });
        button.textContent = 'Добавлено';
    } finally {
        setTimeout(() => {
            button.disabled = false;
            button.textContent = 'Скачать';
        }, 1500);
    }
}

// --- Загрузки -----------------------------------------------------------------------

/** @type {Map<string, {root: HTMLElement, title: HTMLElement, bar: HTMLProgressElement, sub: HTMLElement, button: HTMLButtonElement}>} */
const jobCards = new Map();

let lastJobs = {};
let hideTimer = null;

/**
 * Показываются только текущие загрузки и ошибки (пока их не уберут). Готовые
 * и остановленные — ещё RECENT_MS, потом пропадают: истории в попапе нет,
 * сами файлы — в папке («Открыть папку»).
 * Карточки обновляются на месте: перерисовка дважды в секунду съедала бы клики.
 */
function renderJobs(jobs = lastJobs) {
    lastJobs = jobs;
    const now = Date.now();
    const visible = job => ACTIVE.includes(job.status) || job.status === 'error' || now - (job.finishedAt || 0) < RECENT_MS;
    const list = Object.values(jobs).filter(visible).sort((a, b) => b.startedAt - a.startedAt);
    const shown = new Set(list.map(j => j.id));
    for (const [id, card] of jobCards) {
        if (shown.has(id)) continue;
        card.root.remove();
        jobCards.delete(id);
    }
    clearTimeout(hideTimer);
    const fading = list.filter(j => j.status === 'done' || j.status === 'cancelled');
    if (fading.length) hideTimer = setTimeout(() => renderJobs(), Math.max(100, Math.min(...fading.map(j => j.finishedAt + RECENT_MS - now))));
    for (const job of list) {
        if (!jobCards.has(job.id)) jobCards.set(job.id, createJobCard());
        updateJobCard(jobCards.get(job.id), job);
    }
    const box = $('jobs');
    const order = list.map(j => jobCards.get(j.id).root);
    if (order.some((node, i) => box.children[i] !== node)) box.replaceChildren(...order);

    $('jobsSection').classList.toggle('hidden', !list.length);
    $('jobsHint').classList.toggle('hidden', !list.some(j => ACTIVE.includes(j.status)));
}

function createJobCard() {
    const root = el('div', 'card');
    const row = el('div', 'card-row');
    const main = el('div', 'card-main');
    const title = el('div', 'card-title');
    const bar = el('progress');
    bar.max = 100;
    const sub = el('div', 'card-sub');
    const button = el('button', 'secondary');
    button.type = 'button';
    main.append(title, bar, sub);
    row.append(main, button);
    root.append(row);
    return { root, title, bar, sub, button };
}

function updateJobCard(card, job) {
    const active = ACTIVE.includes(job.status);
    card.title.textContent = job.savedAs || job.fileName || job.title;
    card.title.title = card.title.textContent;
    card.bar.classList.toggle('hidden', !active);
    card.bar.value = job.status === 'saving' ? 100 : job.total ? Math.floor((job.done / job.total) * 100) : 0;

    const [text, kind] = jobStatus(job);
    card.sub.textContent = text;
    card.sub.className = `card-sub ${kind}`;

    if (active) {
        card.button.textContent = 'Стоп';
        card.button.disabled = job.status === 'saving';
        card.button.onclick = () => ext.runtime.sendMessage({ type: 'cancel', id: job.id });
    } else if (job.status === 'error') {
        card.button.textContent = 'Убрать';
        card.button.disabled = false;
        card.button.onclick = () => ext.runtime.sendMessage({ type: 'dismiss', id: job.id });
    }
    card.button.classList.toggle('hidden', !active && job.status !== 'error');
}

/** @returns {[string, string]} текст и класс строки состояния */
function jobStatus(job) {
    switch (job.status) {
        case 'queued':
            return ['Запускаю…', ''];
        case 'running': {
            if (!job.total) return [job.note || 'Подключаюсь…', ''];
            const parts = [`${Math.floor((job.done / job.total) * 100)}%`, formatBytes(job.bytes)];
            if (job.speed > 0) parts.push(`${formatBytes(job.speed)}/с`);
            return [`${parts.join(' · ')}${job.note ? ` — ${job.note}` : ''}`, /пауза|повтор|ошибк|замедл/i.test(job.note) ? 'warn' : ''];
        }
        case 'saving':
            return [job.note || 'Сохраняю…', ''];
        case 'done':
            return [`Готово · ${formatBytes(job.bytes)}`, 'ok'];
        case 'error':
            return [`Ошибка: ${job.note}`, 'error'];
        default:
            return ['Остановлено', ''];
    }
}

// --- Мелочи -------------------------------------------------------------------------

function el(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
}

function badge(text) {
    const node = el('span', 'badge');
    node.textContent = text;
    return node;
}

/** «cdn.example.com/…/master.m3u8» */
function shortUrl(url) {
    try {
        const u = new URL(url);
        const name = u.pathname.split('/').filter(Boolean).pop() || '';
        return `${u.hostname}/${u.pathname.split('/').length > 2 ? '…/' : ''}${name}`;
    } catch {
        return url;
    }
}

init().catch(e => {
    $('empty').textContent = `Ошибка попапа: ${e.message}`;
    $('empty').classList.remove('hidden');
});
