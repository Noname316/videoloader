/**
 * DASH (.mpd): разбор манифеста и список кусков для загрузки.
 *
 * В DASH видео и звук обычно лежат отдельными дорожками (fMP4). Загрузчик
 * берёт одну видеодорожку (по качеству) и одну звуковую, строит общий список
 * кусков, упорядоченный по времени, и общий init-сегмент (mp4-merge.js) —
 * дальше их качает тот же загрузчик, что и HLS, и пишет в один MP4.
 *
 * Куски описываются тремя способами, все поддерживаются:
 *   - SegmentBase — дорожка одним файлом, границы кусков в индексе sidx
 *     (так у VK/Одноклассников);
 *   - SegmentTemplate — адреса по шаблону ($Number$, $Time$), с SegmentTimeline или без;
 *   - SegmentList — явный список адресов.
 *
 * Куски файла запрашиваются заголовком Range; если CDN его не принимает,
 * загрузчик переходит на параметр адреса bytes=… (так делает плеер VK).
 */

import { mergeInits, parseSidx } from './mp4-merge.js';

const kids = (el, name) => (el ? [...el.children].filter(c => c.localName === name) : []);
const kid = (el, name) => kids(el, name)[0] || null;
const num = (v, fallback = 0) => (v == null || v === '' || !Number.isFinite(Number(v)) ? fallback : Number(v));

/** «PT1H2M3.5S» → секунды. */
export function parseDuration(s) {
    const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(s || '');
    if (!m) return 0;
    return num(m[1]) * 86400 + num(m[2]) * 3600 + num(m[3]) * 60 + num(m[4]);
}

function baseOf(el, parentBase) {
    const b = kid(el, 'BaseURL');
    return b ? new URL(b.textContent.trim(), parentBase).href : parentBase;
}

/** Описание кусков дорожки; атрибуты наследуются Period → AdaptationSet → Representation. */
function segmentInfo(levels) {
    let kind = null;
    const attrs = {};
    let timeline = null;
    let init = null;
    let list = null;
    for (const el of levels) {
        for (const name of ['SegmentBase', 'SegmentTemplate', 'SegmentList']) {
            const s = kid(el, name);
            if (!s) continue;
            kind = name;
            for (const a of s.attributes) attrs[a.name] = a.value;
            const tl = kid(s, 'SegmentTimeline');
            if (tl) timeline = kids(tl, 'S').map(e => ({ t: e.getAttribute('t'), d: num(e.getAttribute('d')), r: num(e.getAttribute('r')) }));
            const ini = kid(s, 'Initialization');
            if (ini) init = { sourceURL: ini.getAttribute('sourceURL'), range: ini.getAttribute('range') };
            const urls = kids(s, 'SegmentURL');
            if (urls.length) list = urls.map(u => ({ media: u.getAttribute('media'), mediaRange: u.getAttribute('mediaRange') }));
        }
    }
    return kind && { kind, attrs, timeline, init, list };
}

/**
 * @typedef {object} DashRep
 * @property {string} id
 * @property {number} bandwidth
 * @property {number} width
 * @property {number} height
 * @property {string} mimeType
 * @property {string} baseUrl
 * @property {?object} seg
 */

/**
 * @param {string} text
 * @param {string} mpdUrl
 * @returns {{duration: number, video: DashRep[], audio: DashRep[], drm: boolean, live: boolean, periods: number, otherFormats: boolean}}
 */
export function parseMpd(text, mpdUrl) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const mpd = doc.documentElement;
    if (!mpd || mpd.localName !== 'MPD') throw new Error('ответ не является DASH-манифестом');
    const periods = kids(mpd, 'Period');
    if (!periods.length) throw new Error('в манифесте нет Period');
    const period = periods[0];
    const periodBase = baseOf(period, baseOf(mpd, mpdUrl));

    const out = {
        duration: parseDuration(mpd.getAttribute('mediaPresentationDuration')) || parseDuration(period.getAttribute('duration')),
        video: [],
        audio: [],
        drm: false,
        live: mpd.getAttribute('type') === 'dynamic',
        periods: periods.length,
        otherFormats: false
    };
    for (const as of kids(period, 'AdaptationSet')) {
        const asBase = baseOf(as, periodBase);
        if (kids(as, 'ContentProtection').length) out.drm = true;
        for (const rep of kids(as, 'Representation')) {
            if (kids(rep, 'ContentProtection').length) out.drm = true;
            const get = name => rep.getAttribute(name) ?? as.getAttribute(name);
            const mimeType = get('mimeType') || '';
            const type = as.getAttribute('contentType') || mimeType.split('/')[0];
            if (type !== 'video' && type !== 'audio') continue;
            // WebM-дорожки (как у YouTube) в MP4 не склеить.
            if (mimeType && !/mp4/.test(mimeType)) {
                out.otherFormats = true;
                continue;
            }
            out[type].push({
                id: rep.getAttribute('id') || '',
                bandwidth: num(get('bandwidth')),
                width: num(get('width')),
                height: num(get('height')),
                mimeType,
                baseUrl: baseOf(rep, asBase),
                seg: segmentInfo([period, as, rep])
            });
        }
    }
    return out;
}

/** Почему этот манифест не скачать (или null, если можно). */
export function unsupportedReason(mpd) {
    if (mpd.live) return 'это трансляция, а не запись';
    if (mpd.drm) return 'видео защищено DRM — скачать нельзя';
    if (mpd.periods > 1) return 'манифест из нескольких частей (Period) пока не поддерживается';
    if (!mpd.video.length) return mpd.otherFormats ? 'дорожки в формате WebM — пока не поддерживаются' : 'в манифесте нет видеодорожки';
    return null;
}

/** Видео — лучшее не выше maxHeight (или самое низкое), звук — с наибольшим битрейтом. */
export function pickRepresentations(mpd, maxHeight = Infinity) {
    const videos = [...mpd.video].sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
    const video = videos.find(v => !v.height || v.height <= maxHeight) || videos[videos.length - 1];
    const audio = [...mpd.audio].sort((a, b) => b.bandwidth - a.bandwidth)[0] || null;
    return { video, audio };
}

function parseRange(s) {
    const m = /^(\d+)-(\d+)$/.exec(s || '');
    return m ? { offset: Number(m[1]), length: Number(m[2]) - Number(m[1]) + 1 } : null;
}

/** Подстановка в шаблон адреса: $RepresentationID$, $Number%05d$, $Time$, $Bandwidth$, $$. */
function fillTemplate(template, vars) {
    return template.replace(/\$(\w*)(?:%0(\d+)d)?\$/g, (all, name, width) => {
        if (!name) return '$';
        if (!(name in vars)) return all;
        const v = String(vars[name]);
        return width ? v.padStart(Number(width), '0') : v;
    });
}

/**
 * Запрос куска файла. Сначала — заголовком Range; если CDN отвечает ошибкой
 * или отдаёт файл целиком, — параметром адреса bytes=a-b. Выбранный способ
 * запоминается: по нему же потом строятся адреса кусков для загрузки.
 * @param {(url: string, headers?: Record<string, string>) => Promise<Response>} fetchRaw
 */
function makeRanger(fetchRaw) {
    let style = null;
    const viaQuery = (url, r) => `${url}${url.includes('?') ? '&' : '?'}bytes=${r.offset}-${r.offset + r.length - 1}`;
    const bytes = async res => new Uint8Array(await res.arrayBuffer());

    return {
        async fetch(url, r) {
            if (style !== 'query') {
                const res = await fetchRaw(url, { Range: `bytes=${r.offset}-${r.offset + r.length - 1}` });
                const len = Number(res.headers.get('content-length'));
                if (res.status === 206 || (res.ok && len === r.length)) {
                    style = 'header';
                    return bytes(res);
                }
                await res.body?.cancel().catch(() => {});
                if (style === 'header') throw new Error(`кусок дорожки: HTTP ${res.status}`);
            }
            const res = await fetchRaw(viaQuery(url, r));
            if (!res.ok) throw new Error(`кусок дорожки: HTTP ${res.status}`);
            const data = await bytes(res);
            if (data.byteLength !== r.length) throw new Error('сервер не отдаёт файл по частям');
            style = 'query';
            return data;
        },
        /** Адрес и диапазон куска для загрузчика — тем способом, который сработал. */
        segment(url, r) {
            return style === 'query' ? { url: viaQuery(url, r), byterange: null } : { url, byterange: r };
        }
    };
}

/**
 * Init-сегмент и куски одной дорожки.
 * @returns {Promise<{init: Uint8Array, segments: Array<{url: string, byterange: ?object, start: number, duration: number}>}>}
 */
async function trackSegments(rep, duration, ranger, fetchWhole) {
    const seg = rep.seg || { kind: 'SegmentBase', attrs: {}, init: null };
    const vars = { RepresentationID: rep.id, Bandwidth: rep.bandwidth };
    const timescale = num(seg.attrs.timescale, 1);
    const pto = num(seg.attrs.presentationTimeOffset);

    if (seg.kind === 'SegmentBase') {
        const index = parseRange(seg.attrs.indexRange);
        if (!index) throw new Error('в дорожке нет индекса кусков (indexRange)');
        let initRange = parseRange(seg.init?.range) || (index.offset > 0 ? { offset: 0, length: index.offset } : null);
        let init;
        let indexBytes;
        if (seg.init?.sourceURL) {
            init = await fetchWhole(new URL(seg.init.sourceURL, rep.baseUrl).href);
            initRange = null;
        }
        if (initRange && initRange.offset + initRange.length === index.offset) {
            // Init и индекс обычно идут подряд — одним запросом.
            const both = await ranger.fetch(rep.baseUrl, { offset: initRange.offset, length: initRange.length + index.length });
            init = both.subarray(0, initRange.length);
            indexBytes = both.subarray(initRange.length);
        } else {
            if (initRange) init = await ranger.fetch(rep.baseUrl, initRange);
            indexBytes = await ranger.fetch(rep.baseUrl, index);
        }
        if (!init) throw new Error('в дорожке нет init-сегмента');
        const segments = parseSidx(indexBytes, index.offset).map(s => ({
            ...ranger.segment(rep.baseUrl, { offset: s.offset, length: s.length }), start: s.start, duration: s.duration
        }));
        return { init, segments };
    }

    if (seg.kind === 'SegmentTemplate') {
        if (!seg.attrs.media) throw new Error('в шаблоне дорожки нет адреса кусков (media)');
        const init = seg.attrs.initialization
            ? await fetchWhole(new URL(fillTemplate(seg.attrs.initialization, vars), rep.baseUrl).href)
            : null;
        if (!init) throw new Error('в шаблоне дорожки нет init-сегмента');
        const media = (number, time) => new URL(fillTemplate(seg.attrs.media, { ...vars, Number: number, Time: time }), rep.baseUrl).href;
        const startNumber = num(seg.attrs.startNumber, 1);
        const segments = [];
        if (seg.timeline) {
            let t = 0;
            let n = startNumber;
            for (const s of seg.timeline) {
                if (s.t != null) t = num(s.t);
                // r = -1 — повторять до конца видео.
                const repeat = s.r < 0 ? Math.ceil((duration * timescale - (t - pto)) / s.d) - 1 : s.r;
                for (let k = 0; k <= repeat; k++, n++, t += s.d) {
                    segments.push({ url: media(n, t), byterange: null, start: (t - pto) / timescale, duration: s.d / timescale });
                }
            }
        } else {
            const d = num(seg.attrs.duration);
            if (!d || !duration) throw new Error('в шаблоне дорожки нет длительности кусков');
            const count = Math.ceil((duration * timescale) / d);
            for (let i = 0; i < count; i++) {
                segments.push({ url: media(startNumber + i, i * d), byterange: null, start: (i * d) / timescale, duration: d / timescale });
            }
        }
        return { init, segments };
    }

    // SegmentList
    let init;
    if (seg.init?.sourceURL) init = await fetchWhole(new URL(seg.init.sourceURL, rep.baseUrl).href);
    else if (parseRange(seg.init?.range)) init = await ranger.fetch(rep.baseUrl, parseRange(seg.init.range));
    if (!init) throw new Error('в списке кусков дорожки нет init-сегмента');
    const d = num(seg.attrs.duration) / timescale;
    const segments = [];
    for (const [i, s] of (seg.list || []).entries()) {
        const url = s.media ? new URL(s.media, rep.baseUrl).href : rep.baseUrl;
        const r = parseRange(s.mediaRange);
        segments.push({ ...(r ? ranger.segment(url, r) : { url, byterange: null }), start: i * d, duration: d });
    }
    if (!segments.length) throw new Error('список кусков дорожки пуст');
    return { init, segments };
}

/**
 * Загружает манифест и готовит «плейлист» для загрузчика (hls-download.js):
 * куски обеих дорожек по времени и общий init-сегмент.
 * @param {string} url
 * @param {{fetchRaw: (url: string, headers?: Record<string, string>) => Promise<Response>, maxHeight?: number}} o
 */
export async function loadDashPlaylist(url, { fetchRaw, maxHeight = Infinity }) {
    const fetchWhole = async u => {
        const res = await fetchRaw(u);
        if (!res.ok) throw new Error(`дорожка: HTTP ${res.status}`);
        return new Uint8Array(await res.arrayBuffer());
    };
    const res = await fetchRaw(url);
    if (!res.ok) throw new Error(`манифест: HTTP ${res.status}`);
    const mpd = parseMpd(await res.text(), url);
    const reason = unsupportedReason(mpd);
    if (reason) throw new Error(reason);

    const { video, audio } = pickRepresentations(mpd, maxHeight);
    const ranger = makeRanger(fetchRaw);
    const tracks = [];
    for (const rep of [video, audio].filter(Boolean)) tracks.push(await trackSegments(rep, mpd.duration, ranger, fetchWhole));

    const segments = tracks
        .flatMap((t, i) => t.segments.map(s => ({ ...s, track: i + 1 })))
        .sort((a, b) => a.start - b.start || a.track - b.track)
        .map((s, index) => ({ index, url: s.url, byterange: s.byterange, duration: s.duration, key: null, sequence: index, track: s.track }));
    const videoDuration = tracks[0].segments.reduce((sum, s) => sum + s.duration, 0);
    return {
        url,
        segments,
        init: null,
        initData: mergeInits(tracks.map(t => t.init)),
        container: 'fmp4',
        duration: mpd.duration || videoDuration,
        resolution: video.width && video.height ? `${video.width}x${video.height}` : null,
        quality: video.height,
        hasAudio: Boolean(audio)
    };
}
