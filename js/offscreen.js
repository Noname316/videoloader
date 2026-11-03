/**
 * Offscreen-документ: здесь идут сами загрузки. Попап может закрыться в любой
 * момент, а этот документ живёт, пока его не закроет фон.
 *
 * HLS и DASH качаются по сегментам, обычный файл — одним запросом. Файл пишется
 * во временную папку OPFS, после загрузки фон сохраняет его в «Загрузки/VideoLoader»
 * по blob-ссылке, затем временный файл удаляется. О ходе загрузки документ
 * сообщает фону, а тот кладёт состояние в storage.session.
 */

import { loadDashPlaylist } from './dash.js';
import { downloadHls } from './hls-download.js';
import { retagFragment } from './mp4-merge.js';
import { Pacer } from './pacer.js';
import { DirectoryTarget, TsToMp4Writer } from './output.js';
import { Mp4DurationFixer } from './mp4-fix.js';
import { ruleDomain, setRequestHeaders } from './net-rules.js';
import { ext, isAbort, sanitizeFileName } from './util.js';

const TEMP_DIR = 'jobs';
const PROGRESS_EVERY_MS = 500;
const SPEED_WINDOW_MS = 5000;
const FILE_EXT = /\.(mp4|m4v|webm|mkv|mov|flv|ogv)$/i;

/** @type {Map<string, AbortController>} */
const controllers = new Map();

/** Временная папка; остатки прошлых запусков удаляются. */
const tempDir = (async () => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(TEMP_DIR, { recursive: true }).catch(() => {});
    return root.getDirectoryHandle(TEMP_DIR, { create: true });
})();

ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.target !== 'offscreen') return false;
    if (msg.type === 'start') {
        run(msg);
        sendResponse({ ok: true });
    } else if (msg.type === 'cancel') {
        const controller = controllers.get(msg.id);
        controller?.abort();
        sendResponse({ ok: Boolean(controller) });
    }
    return false;
});

function report(id, patch) {
    return ext.runtime.sendMessage({ type: 'job', id, patch }).catch(() => {});
}

/**
 * Прогресс не чаще раза в PROGRESS_EVERY_MS, со скоростью за последние секунды.
 * @param {string} id
 */
function progressReporter(id) {
    let last = 0;
    let timer = null;
    let pending = null;
    const samples = [];
    const flush = () => {
        clearTimeout(timer);
        timer = null;
        if (!pending) return;
        last = Date.now();
        report(id, pending);
        pending = null;
    };
    const update = patch => {
        const now = Date.now();
        if (patch.bytes != null) {
            samples.push([now, patch.bytes]);
            while (samples.length > 2 && now - samples[0][0] > SPEED_WINDOW_MS) samples.shift();
            const [t0, b0] = samples[0];
            patch.speed = now > t0 ? ((patch.bytes - b0) / (now - t0)) * 1000 : 0;
        }
        pending = { ...pending, ...patch };
        const wait = last + PROGRESS_EVERY_MS - now;
        if (wait <= 0) flush();
        else timer ??= setTimeout(flush, wait);
    };
    update.flush = flush;
    return update;
}

/**
 * @param {{job: {id: string, title: string}, media: {kind: string, url: string, size: ?number, headers: Record<string, ?string>},
 *   maxHeight: ?number, keepTs: boolean}} msg
 */
async function run({ job, media, maxHeight, keepTs }) {
    const controller = new AbortController();
    controllers.set(job.id, controller);
    const { signal } = controller;
    const progress = progressReporter(job.id);
    const base = sanitizeFileName(job.title);
    let dir = null;
    let tempName = null;

    const log = (text, level = 'info') => {
        (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)('[VideoLoader]', text);
        if (level === 'warn') progress({ note: text });
    };
    /** Открывает временный файл; имя для «Загрузок» — по названию вкладки. */
    const open = async extension => {
        tempName = `${job.id}.${extension}`;
        await report(job.id, { fileName: `${base}.${extension}` });
        return new DirectoryTarget(dir).createFile(tempName);
    };

    try {
        dir = await tempDir;
        const stream = media.kind === 'hls' || media.kind === 'dash';
        await report(job.id, { status: 'running', note: stream ? 'Читаю плейлист…' : 'Подключаюсь…' });
        if (stream) await downloadStream(media, { maxHeight, keepTs, signal, log, open, progress });
        else await downloadFile(media, { signal, open, progress });
        progress.flush();

        await report(job.id, { status: 'saving', note: 'Сохраняю в «Загрузки»…' });
        const file = await (await dir.getFileHandle(tempName)).getFile();
        const url = URL.createObjectURL(file);
        let res;
        try {
            res = await ext.runtime.sendMessage({ type: 'save', url, fileName: `${base}.${tempName.split('.').pop()}` });
        } finally {
            URL.revokeObjectURL(url);
        }
        if (res?.error) throw new Error(res.error);
        await report(job.id, { status: 'done', note: '', bytes: file.size, downloadId: res.downloadId, savedAs: res.savedAs, finishedAt: Date.now() });
    } catch (e) {
        progress.flush();
        const aborted = isAbort(e) || signal.aborted;
        if (!aborted) log(e.message, 'error');
        await report(job.id, aborted ? { status: 'cancelled', note: 'Остановлено' } : { status: 'error', note: e.message });
    } finally {
        controllers.delete(job.id);
        if (tempName) await dir?.removeEntry(tempName).catch(() => {});
    }
}

/**
 * HLS и DASH: сегменты по порядку в один файл; MPEG-TS перепаковывается в MP4,
 * дорожки видео и звука DASH склеиваются в один MP4 (dash.js, mp4-merge.js).
 */
async function downloadStream(media, { maxHeight, keepTs, signal, log, open, progress }) {
    const headed = new Set([ruleDomain(media.url)]);
    /** Сегменты, ключи и дорожки часто лежат на другом CDN — им нужны те же заголовки. */
    const ensureHeaders = async url => {
        const domain = ruleDomain(url);
        if (headed.has(domain)) return;
        headed.add(domain);
        await setRequestHeaders(domain, media.headers);
    };
    // Варианты мастер-плейлиста бывают на другом домене (попап их уже видел).
    for (const domain of media.domains || []) {
        if (headed.has(domain)) continue;
        headed.add(domain);
        await setRequestHeaders(domain, media.headers);
    }
    let remux = false;
    let sequence = 0;
    const dash = media.kind === 'dash' && {
        loadPlaylist: () => loadDashPlaylist(media.url, {
            maxHeight: maxHeight || Infinity,
            fetchRaw: async (url, headers = {}) => {
                await ensureHeaders(url);
                return fetch(url, { headers, signal, credentials: 'include', cache: 'no-store' });
            }
        }),
        transformSegment: (segment, data) => retagFragment(data, segment.track, () => ++sequence)
    };
    await downloadHls({
        ...dash,
        resolve: async () => ({ variants: [{ quality: maxHeight || 0, urls: [media.url] }], headers: media.headers }),
        maxHeight: maxHeight || Infinity,
        pacer: new Pacer({ concurrency: 4, delayMs: 0 }),
        segmentsPerLink: 0,
        policy: { maxResolves: 3, cooldownsMs: [15000, 60000] },
        signal,
        log,
        openOutput: async ({ container }) => {
            remux = container === 'ts' && !keepTs;
            const file = await open(container === 'ts' && keepTs ? 'ts' : 'mp4');
            const mp4 = new Mp4DurationFixer(file);
            return remux ? new TsToMp4Writer(mp4) : mp4;
        },
        onPlaylist: async playlist => {
            const urls = [playlist.init?.url, ...playlist.segments.flatMap(s => [s.url, s.key?.url])];
            for (const url of urls) if (url) await ensureHeaders(url);
        },
        onProgress: ({ done, total, bytes }) => progress({
            done, total, bytes, note: done === total && remux ? 'Перепаковываю в MP4…' : ''
        }),
        onWait: (ms, reason) => progress({ note: `${reason}, пауза ${Math.round(ms / 1000)} с` })
    });
}

/** Обычный файл: поток ответа пишется на диск по мере загрузки. */
async function downloadFile(media, { signal, open, progress }) {
    await setRequestHeaders(ruleDomain(media.url), media.headers);
    const res = await fetch(media.url, { signal, credentials: 'include', cache: 'no-store' });
    if (!res.ok) throw new Error(`сервер ответил HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || media.size || 0;
    const writer = await open(fileExtension(media.url, res.headers.get('content-type') || ''));
    let bytes = 0;
    try {
        const reader = res.body.getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            await writer.write(value);
            bytes += value.byteLength;
            progress({ done: bytes, total, bytes, note: '' });
        }
        await writer.close();
    } catch (e) {
        await writer.abort();
        throw e;
    }
}

function fileExtension(url, contentType) {
    const m = FILE_EXT.exec(new URL(url).pathname);
    if (m) return m[1].toLowerCase();
    const sub = /^video\/(?:x-)?([a-z0-9]+)/i.exec(contentType)?.[1]?.toLowerCase();
    return { webm: 'webm', matroska: 'mkv', quicktime: 'mov', flv: 'flv', ogg: 'ogv' }[sub] || 'mp4';
}
