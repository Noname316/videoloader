/**
 * Разбор HLS-плейлистов (библиотека m3u8-parser из lib/).
 */

/**
 * @typedef {object} Segment
 * @property {number} index - Порядковый номер (0…).
 * @property {string} url
 * @property {number} duration - Секунды.
 * @property {?{offset: number, length: number}} byterange
 * @property {?{method: string, url: string, iv: ?Uint8Array}} key
 * @property {number} sequence - Media sequence number (для IV по умолчанию).
 */

/**
 * @typedef {object} MediaPlaylist
 * @property {string} url - Адрес медиаплейлиста.
 * @property {Segment[]} segments
 * @property {?{url: string, byterange: ?{offset: number, length: number}}} init - EXT-X-MAP (fMP4).
 * @property {'ts'|'fmp4'} container
 * @property {number} duration - Секунды.
 * @property {?string} resolution - «1920x1080», если известно.
 */

export function parse(text) {
    const lib = globalThis.m3u8Parser;
    if (!lib?.Parser) throw new Error('Библиотека m3u8-parser не загружена');
    if (!/^\s*#EXTM3U/.test(text)) throw new Error('ответ не является HLS-плейлистом');
    const parser = new lib.Parser();
    parser.push(text);
    parser.end();
    return parser.manifest;
}

function toByterange(br) {
    return br && Number.isFinite(br.length) ? { offset: br.offset || 0, length: br.length } : null;
}

function ivToBytes(iv) {
    if (!iv) return null;
    const out = new Uint8Array(16);
    const view = new DataView(out.buffer);
    for (let i = 0; i < 4; i++) view.setUint32(i * 4, iv[i] >>> 0);
    return out;
}

/**
 * Выбирает вариант из мастер-плейлиста: самый высокий, не выше maxHeight.
 * @param {Array<object>} playlists - manifest.playlists.
 * @param {number} [maxHeight=Infinity]
 * @returns {object}
 */
export function pickVariant(playlists, maxHeight = Infinity) {
    const height = p => p.attributes?.RESOLUTION?.height || 0;
    const bw = p => p.attributes?.BANDWIDTH || 0;
    const sorted = [...playlists].sort((a, b) => height(b) - height(a) || bw(b) - bw(a));
    return sorted.find(p => !height(p) || height(p) <= maxHeight) || sorted[sorted.length - 1];
}

/**
 * Загружает медиаплейлист (если по адресу мастер-плейлист — переходит к варианту).
 * @param {string} url
 * @param {(url: string) => Promise<string>} fetchText
 * @param {{maxHeight?: number}} [opts]
 * @returns {Promise<MediaPlaylist>}
 */
export async function loadMediaPlaylist(url, fetchText, { maxHeight = Infinity } = {}) {
    let manifest = parse(await fetchText(url));
    let resolution = null;

    for (let depth = 0; manifest.playlists?.length; depth++) {
        if (depth > 3) throw new Error('слишком глубокая вложенность плейлистов');
        if (manifest.mediaGroups?.AUDIO && Object.values(manifest.mediaGroups.AUDIO).some(g => Object.values(g).some(t => t.uri)))
            throw new Error('поток с отдельной аудиодорожкой пока не поддерживается');
        const variant = pickVariant(manifest.playlists, maxHeight);
        const r = variant.attributes?.RESOLUTION;
        if (r) resolution = `${r.width}x${r.height}`;
        url = new URL(variant.uri, url).href;
        manifest = parse(await fetchText(url));
    }

    const segs = manifest.segments || [];
    if (!segs.length) throw new Error('в плейлисте нет сегментов');
    if (!manifest.endList && manifest.playlistType !== 'VOD') throw new Error('это трансляция (плейлист без EXT-X-ENDLIST), а не запись');

    const firstSeq = manifest.mediaSequence || 0;
    let init = null;
    const segments = segs.map((s, index) => {
        if (s.map && !init) init = { url: new URL(s.map.uri, url).href, byterange: toByterange(s.map.byterange) };
        const method = s.key?.method;
        if (method && method !== 'NONE' && method !== 'AES-128')
            throw new Error(`шифрование ${method} не поддерживается`);
        return {
            index,
            url: new URL(s.uri, url).href,
            duration: s.duration || 0,
            byterange: toByterange(s.byterange),
            key: method === 'AES-128' ? { method, url: new URL(s.key.uri, url).href, iv: ivToBytes(s.key.iv) } : null,
            sequence: firstSeq + index
        };
    });

    const looksFmp4 = init || segments.some(s => /\.(m4s|mp4|m4v|cmfv)(\?|$)/i.test(s.url));
    return {
        url,
        segments,
        init,
        container: looksFmp4 ? 'fmp4' : 'ts',
        duration: segments.reduce((sum, s) => sum + s.duration, 0),
        resolution
    };
}
