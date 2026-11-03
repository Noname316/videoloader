/**
 * Склейка отдельных дорожек fMP4 (видео и звук из DASH) в один фрагментированный MP4.
 *
 * Init-сегменты дорожек объединяются в один moov: mvhd первой дорожки, все trak
 * и все trex, у каждой дорожки свой track_ID (1, 2…). Фрагменты (moof + mdat)
 * копируются как есть, в них меняются только track_ID в tfhd и номер в mfhd.
 * Смещения данных в trun отсчитываются от начала moof, поэтому байты mdat
 * трогать не нужно. Служебные боксы перед фрагментами (styp, sidx) убираются.
 */

import { boxes, child } from './mp4-fix.js';

/** Бокс: 4 байта размера, 4 байта типа, содержимое. */
function box(type, ...parts) {
    const size = 8 + parts.reduce((n, p) => n + p.byteLength, 0);
    const out = new Uint8Array(size);
    const view = new DataView(out.buffer);
    view.setUint32(0, size);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    let pos = 8;
    for (const p of parts) {
        out.set(p, pos);
        pos += p.byteLength;
    }
    return out;
}

const slice = (buf, b) => buf.slice(b.start, b.end);
const setUint32 = (buf, pos, value) => new DataView(buf.buffer, buf.byteOffset, buf.byteLength).setUint32(pos, value);

/**
 * @param {Uint8Array[]} inits - Init-сегменты дорожек (ftyp + moov), видео первым.
 * @returns {Uint8Array} ftyp + общий moov; дорожка i получает track_ID = i + 1.
 */
export function mergeInits(inits) {
    let ftyp = null;
    let mvhd = null;
    const traks = [];
    const trexes = [];

    inits.forEach((init, i) => {
        const trackId = i + 1;
        const top = [...boxes(init)];
        const moov = top.find(b => b.type === 'moov');
        if (!moov) throw new Error('в init-сегменте дорожки нет moov');
        const ftypBox = top.find(b => b.type === 'ftyp');
        if (!ftyp && ftypBox) ftyp = slice(init, ftypBox);
        mvhd ??= slice(init, child(init, moov, 'mvhd'));

        let found = 0;
        for (const b of boxes(init, moov.body, moov.end)) {
            if (b.type !== 'trak') continue;
            if (found++) throw new Error('в дорожке DASH больше одного трека — не поддерживается');
            const trak = slice(init, b);
            const tkhd = child(trak, { body: 8, end: trak.byteLength }, 'tkhd');
            setUint32(trak, tkhd.body + (trak[tkhd.body] === 1 ? 20 : 12), trackId);
            traks.push(trak);
        }
        if (!found) throw new Error('в init-сегменте дорожки нет trak');

        const mvex = child(init, moov, 'mvex');
        const trex = mvex && child(init, mvex, 'trex');
        if (!trex) throw new Error('дорожка не фрагментирована (нет mvex/trex)');
        const copy = slice(init, trex);
        setUint32(copy, 12, trackId);
        trexes.push(copy);
    });

    // next_track_ID — последнее поле mvhd.
    setUint32(mvhd, mvhd.byteLength - 4, inits.length + 1);
    const moov = box('moov', mvhd, ...traks, box('mvex', ...trexes));
    return ftyp ? concat([ftyp, moov]) : moov;
}

/**
 * Готовит кусок дорожки к записи в общий файл: оставляет только moof/mdat,
 * проставляет track_ID и сквозной номер фрагмента.
 * @param {Uint8Array} data - Подсегмент дорожки (moof + mdat, возможно с styp/sidx).
 * @param {number} trackId
 * @param {() => number} nextSequence - Номер для очередного mfhd.
 * @returns {Uint8Array}
 */
export function retagFragment(data, trackId, nextSequence) {
    const keep = [];
    for (const b of boxes(data)) {
        if (b.type === 'moof') {
            const mfhd = child(data, b, 'mfhd');
            if (mfhd) setUint32(data, mfhd.body + 4, nextSequence());
            for (const traf of boxes(data, b.body, b.end)) {
                if (traf.type !== 'traf') continue;
                const tfhd = child(data, traf, 'tfhd');
                if (tfhd) setUint32(data, tfhd.body + 4, trackId);
            }
            keep.push(data.subarray(b.start, b.end));
        } else if (b.type === 'mdat') {
            keep.push(data.subarray(b.start, b.end));
        }
    }
    if (!keep.length) throw new Error('в куске дорожки нет фрагментов moof/mdat');
    return keep.length === 1 ? keep[0] : concat(keep);
}

/**
 * Разбор sidx: байтовые диапазоны и длительности подсегментов.
 * @param {Uint8Array} data - Байты, в которых лежит бокс sidx.
 * @param {number} dataOffset - Смещение data от начала файла.
 * @returns {Array<{offset: number, length: number, start: number, duration: number}>} время — в секундах
 */
export function parseSidx(data, dataOffset) {
    const sidx = [...boxes(data)].find(b => b.type === 'sidx');
    if (!sidx) throw new Error('не найден индекс дорожки (sidx)');
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const version = data[sidx.body];
    let p = sidx.body + 8; // version/flags + reference_ID
    const timescale = view.getUint32(p);
    p += 4;
    let time;
    let firstOffset;
    if (version === 0) {
        time = view.getUint32(p);
        firstOffset = view.getUint32(p + 4);
        p += 8;
    } else {
        time = Number(view.getBigUint64(p));
        firstOffset = Number(view.getBigUint64(p + 8));
        p += 16;
    }
    const count = view.getUint16(p + 2);
    p += 4;
    let offset = dataOffset + sidx.end + firstOffset;
    const out = [];
    for (let i = 0; i < count; i++, p += 12) {
        const ref = view.getUint32(p);
        if (ref >>> 31) throw new Error('многоуровневый индекс sidx не поддерживается');
        const length = ref & 0x7fffffff;
        const duration = view.getUint32(p + 4);
        out.push({ offset, length, start: time / timescale, duration: duration / timescale });
        offset += length;
        time += duration;
    }
    return out;
}

function concat(parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let pos = 0;
    for (const p of parts) {
        out.set(p, pos);
        pos += p.byteLength;
    }
    return out;
}
