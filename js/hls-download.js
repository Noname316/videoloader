/**
 * Загрузка одного видео из HLS: плейлист → сегменты (с темпом и повторами) →
 * запись в файл строго по порядку. Модуль взят из AnimeLoader; добавлены хуки
 * onPlaylist (подстановка заголовков для доменов сегментов), loadPlaylist и
 * transformSegment (DASH: свой список кусков и склейка дорожек, см. dash.js).
 *
 * Ошибки CDN делятся на три вида:
 *   - временные (сеть, 5xx, 429) — повтор того же сегмента с паузой;
 *   - «ссылка устарела» (403/404/410) — плейлист запрашивается заново,
 *     загрузка продолжается с того же сегмента;
 *   - «слишком часто» (403 с пометкой блокировки) — темп снижается,
 *     загрузка ждёт окончания блокировки, затем продолжает.
 */

import { loadMediaPlaylist } from './playlist.js';
import { ruleDomain, setRequestHeaders } from './net-rules.js';
import { abortError, isAbort, sleep } from './util.js';

/** Сервер временно заблокировал загрузку из-за частых запросов. */
export class BlockedError extends Error {}
/** Ссылка на поток больше не действует. */
class LinkError extends Error {}
/** Ошибка, которую бесполезно повторять. */
class FatalError extends Error {}

const SEGMENT_RETRIES = 5;

/**
 * @typedef {object} DownloadOptions
 * @property {() => Promise<{variants: Array<{quality: number, urls: string[]}>, headers: Record<string, string>}>} resolve
 *   Получить (свежие) ссылки на серию.
 * @property {number} maxHeight - Желаемое качество (высота кадра), Infinity — максимальное.
 * @property {(info: {container: 'ts'|'fmp4', quality: number, resolution: ?string}) => Promise<import('./output.js').FileWriter>} openOutput
 *   Открыть файл, когда известен формат потока.
 * @property {import('./pacer.js').Pacer} pacer
 * @property {number} [segmentsPerLink] - Сколько сегментов качать по одной ссылке (0 — без ограничения).
 * @property {{maxResolves: number, cooldownsMs: number[]}} policy
 * @property {AbortSignal} signal
 * @property {(msg: string, level?: string) => void} log
 * @property {(p: {done: number, total: number, bytes: number}) => void} onProgress
 * @property {(ms: number, reason: string) => void} onWait - Начало вынужденной паузы (для обратного отсчёта).
 * @property {(playlist: import('./playlist.js').MediaPlaylist) => Promise<void>} [onPlaylist] - Плейлист загружен (до первого сегмента).
 * @property {() => Promise<object>} [loadPlaylist] - Свой «плейлист» вместо HLS (DASH): сегменты, initData, quality.
 * @property {(segment: object, data: Uint8Array) => Uint8Array} [transformSegment] - Преобразовать сегмент перед записью (по порядку).
 */

/**
 * @param {DownloadOptions} o
 * @returns {Promise<{bytes: number, segments: number, quality: number, container: string}>}
 */
export async function downloadHls(o) {
    const { pacer, signal, log } = o;
    let playlist = null;
    let writer = null;
    let quality = 0;
    let nextWrite = 0;
    let bytes = 0;
    let linkErrors = 0;
    let rotations = 0;
    let blocks = 0;
    let lastLinkErrorAt = -1;
    let initDone = false;
    /** @type {Map<number, Uint8Array>} */
    const buffered = new Map();
    const keyCache = new Map();

    try {
        for (;;) {
            if (signal.aborted) throw abortError();
            try {
                await prepare();
                if (await runWorkers() === 'rotate') {
                    rotations++;
                    continue;
                }
                break;
            } catch (e) {
                let err = e;
                if (err instanceof LinkError) {
                    // Ссылка «устарела» второй раз подряд без продвижения — похоже на блокировку.
                    if (lastLinkErrorAt === nextWrite) {
                        err = new BlockedError(`${err.message} сразу после обновления ссылки`);
                    } else {
                        if (++linkErrors >= o.policy.maxResolves) throw new Error(`${err.message}; ссылки обновлялись ${linkErrors} раз — сдаюсь`);
                        lastLinkErrorAt = nextWrite;
                        log(`${err.message} — запрашиваю новые ссылки`, 'warn');
                        continue;
                    }
                }
                if (err instanceof BlockedError) {
                    blocks++;
                    if (blocks > o.policy.cooldownsMs.length) throw new Error(`${err.message}; блокировка не снимается, загрузка серии прервана`);
                    pacer.slowDown();
                    const wait = o.policy.cooldownsMs[blocks - 1];
                    log(`${err.message}. Пауза ${Math.round(wait / 1000)} с, затем продолжу медленнее (${pacer.describe()})`, 'warn');
                    o.onWait(wait, 'Сервер ограничил скорость');
                    await sleep(wait, signal);
                    continue;
                }
                throw err;
            }
        }
        await writer.close();
        return { bytes, segments: playlist.segments.length, quality, container: playlist.container, rotations };
    } catch (e) {
        await writer?.abort().catch(() => {});
        throw e;
    }

    /** Получает ссылки и плейлист; при первом вызове открывает файл. */
    async function prepare() {
        let fresh;
        let freshQuality;
        if (o.loadPlaylist) {
            fresh = await o.loadPlaylist();
            freshQuality = fresh.quality || 0;
        } else {
            const src = await o.resolve();
            const variant = pickQuality(src.variants, o.maxHeight);
            fresh = await loadFromMirrors(variant.urls, src.headers, o.maxHeight, signal, log);
            freshQuality = variant.quality;
        }

        if (playlist) {
            if (fresh.segments.length !== playlist.segments.length)
                throw new FatalError('после обновления ссылки изменился состав серии — начните её заново');
            playlist = { ...playlist, segments: fresh.segments, init: fresh.init };
            log(`Новая ссылка, продолжаю с сегмента ${nextWrite + 1}`);
        } else {
            playlist = fresh;
            quality = freshQuality;
            log(`Поток: ${quality ? `${quality}p` : 'качество по плейлисту'}${fresh.resolution ? ` (${fresh.resolution})` : ''}, ` +
                `${fresh.segments.length} сегм., ${Math.round(fresh.duration / 60)} мин, ${fresh.container === 'fmp4' ? 'fMP4' : 'MPEG-TS'}`);
            writer = await o.openOutput({ container: fresh.container, quality, resolution: fresh.resolution });
        }
        await o.onPlaylist?.(fresh);

        if (playlist.init && !initDone) {
            const init = await fetchSegment({ url: playlist.init.url, byterange: playlist.init.byterange, key: null }, -1);
            await writer.write(init);
            bytes += init.byteLength;
            initDone = true;
        }
        // Готовый init-сегмент (DASH: общий для дорожек видео и звука).
        if (playlist.initData && !initDone) {
            await writer.write(playlist.initData);
            bytes += playlist.initData.byteLength;
            initDone = true;
        }
    }

    /**
     * Параллельная загрузка с записью по порядку.
     * @returns {Promise<'done'|'rotate'>} 'rotate' — исчерпан лимит сегментов на ссылку.
     */
    async function runWorkers() {
        const segments = playlist.segments;
        const total = segments.length;
        const local = new AbortController();
        const onAbort = () => local.abort();
        signal.addEventListener('abort', onAbort, { once: true });
        let nextFetch = nextWrite;
        let failure = null;
        let started = 0;
        let rotate = false;
        const budget = o.segmentsPerLink > 0 ? o.segmentsPerLink : Infinity;
        let writing = Promise.resolve();
        const maxAhead = pacer.maxConcurrency * 2 + 2;

        const flush = () => {
            writing = writing.then(async () => {
                while (buffered.has(nextWrite)) {
                    const raw = buffered.get(nextWrite);
                    buffered.delete(nextWrite);
                    // Здесь, а не после загрузки: преобразование видит куски строго по порядку.
                    const data = o.transformSegment ? o.transformSegment(segments[nextWrite], raw) : raw;
                    await writer.write(data);
                    bytes += data.byteLength;
                    nextWrite++;
                    o.onProgress({ done: nextWrite, total, bytes });
                }
            });
            return writing;
        };

        const worker = async () => {
            while (!failure) {
                while (nextFetch < total && buffered.has(nextFetch)) nextFetch++;
                if (nextFetch >= total) return;
                // Не убегать слишком далеко вперёд записи: память не резиновая.
                if (nextFetch - nextWrite > maxAhead) {
                    await sleep(100, local.signal);
                    continue;
                }
                if (started >= budget) {
                    rotate = true;
                    return;
                }
                started++;
                const seg = segments[nextFetch++];
                await pacer.acquire(local.signal);
                let data;
                try {
                    data = await fetchSegment(seg, seg.index, local.signal);
                } finally {
                    pacer.release();
                }
                buffered.set(seg.index, data);
                await flush();
            }
        };

        try {
            await Promise.all(Array.from({ length: pacer.maxConcurrency }, () => worker().catch(e => {
                if (!failure) failure = e;
                local.abort();
            })));
            await writing;
            if (signal.aborted) throw abortError();
            if (failure) throw failure;
            return rotate && nextWrite < total ? 'rotate' : 'done';
        } finally {
            signal.removeEventListener('abort', onAbort);
        }
    }

    /**
     * Скачивает один сегмент (или init) с повторами временных ошибок.
     * @returns {Promise<Uint8Array>}
     */
    async function fetchSegment(seg, index, sig = signal) {
        const label = index < 0 ? 'init-сегмент' : `сегмент ${index + 1}`;
        for (let attempt = 0; ; attempt++) {
            if (sig.aborted) throw abortError();
            let res;
            try {
                const headers = {};
                if (seg.byterange) headers.Range = `bytes=${seg.byterange.offset}-${seg.byterange.offset + seg.byterange.length - 1}`;
                res = await fetch(seg.url, { signal: sig, headers, credentials: 'include', cache: 'no-store' });
            } catch (e) {
                if (isAbort(e) || sig.aborted) throw abortError();
                if (attempt >= SEGMENT_RETRIES) throw new Error(`${label}: сеть недоступна (${e.message})`);
                log(`${label}: сетевая ошибка, повтор ${attempt + 1}/${SEGMENT_RETRIES}`, 'warn');
                await sleep(1000 * 2 ** attempt, sig);
                continue;
            }

            if (res.ok) {
                let data = new Uint8Array(await res.arrayBuffer());
                if (!data.byteLength) {
                    if (attempt >= SEGMENT_RETRIES) throw new Error(`${label}: сервер прислал пустой ответ`);
                    await sleep(1000 * 2 ** attempt, sig);
                    continue;
                }
                if (seg.key) data = await decrypt(data, seg);
                pacer.success();
                return data;
            }

            const reason = res.headers.get('x-vd') || '';
            const status = `HTTP ${res.status}${reason ? ` (${reason})` : ''}`;
            if (res.status === 403 && /origin/i.test(reason))
                throw new FatalError(`${label}: CDN отклонил запрос (${status}) — не подставился заголовок Origin`);
            if (res.status === 403 && /block|limit|ban/i.test(reason))
                throw new BlockedError(`${label}: ${status} — сервер заблокировал загрузку за слишком частые запросы`);
            if (res.status === 429) {
                pacer.slowDown();
                const retryAfter = Number(res.headers.get('retry-after')) || 0;
                if (attempt >= SEGMENT_RETRIES) throw new BlockedError(`${label}: ${status} — слишком много запросов`);
                log(`${label}: ${status}, замедляюсь (${pacer.describe()})`, 'warn');
                await sleep(Math.max(retryAfter * 1000, 3000 * 2 ** attempt), sig);
                continue;
            }
            if ([401, 403, 404, 410].includes(res.status)) throw new LinkError(`${label}: ${status}`);
            if (attempt >= SEGMENT_RETRIES) throw new Error(`${label}: ${status} после ${SEGMENT_RETRIES} повторов`);
            log(`${label}: ${status}, повтор ${attempt + 1}/${SEGMENT_RETRIES}`, 'warn');
            await sleep(1000 * 2 ** attempt, sig);
        }
    }

    /** AES-128 (CBC, PKCS7) через WebCrypto. */
    async function decrypt(data, seg) {
        let key = keyCache.get(seg.key.url);
        if (!key) {
            const res = await fetch(seg.key.url, { signal, credentials: 'include' });
            if (!res.ok) throw new LinkError(`ключ шифрования: HTTP ${res.status}`);
            const raw = await res.arrayBuffer();
            key = await crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']);
            keyCache.set(seg.key.url, key);
        }
        let iv = seg.key.iv;
        if (!iv) {
            iv = new Uint8Array(16);
            new DataView(iv.buffer).setUint32(12, seg.sequence);
        }
        return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, data));
    }
}

/**
 * Лучшее качество не выше желаемого (если такого нет — самое низкое из имеющихся).
 * @param {Array<{quality: number, urls: string[]}>} variants - По убыванию качества.
 * @param {number} maxHeight
 */
export function pickQuality(variants, maxHeight) {
    const sorted = [...variants].sort((a, b) => b.quality - a.quality);
    return sorted.find(v => v.quality <= maxHeight) || sorted[sorted.length - 1];
}

/** Загружает плейлист с первого рабочего зеркала. */
async function loadFromMirrors(urls, headers, maxHeight, signal, log) {
    let lastError;
    for (const url of urls) {
        if (headers && Object.keys(headers).length) await setRequestHeaders(ruleDomain(url), headers);
        try {
            return await loadMediaPlaylist(url, async u => {
                const res = await fetch(u, { signal, credentials: 'include', cache: 'no-store' });
                if (!res.ok) {
                    const reason = res.headers.get('x-vd');
                    const msg = `плейлист: HTTP ${res.status}${reason ? ` (${reason})` : ''}`;
                    if (res.status === 403 && /block|limit|ban/i.test(reason || '')) throw new BlockedError(msg);
                    throw new Error(msg);
                }
                return res.text();
            }, { maxHeight });
        } catch (e) {
            if (isAbort(e) || e instanceof BlockedError) throw e;
            lastError = e;
            if (urls.length > 1) log(`Зеркало ${new URL(url).hostname} не ответило: ${e.message}`, 'warn');
        }
    }
    throw lastError;
}
