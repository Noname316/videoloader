/**
 * Прописывает длительность во фрагментированный MP4.
 *
 * И mux.js, и CDN пишут в init-сегмент длительность «неизвестна» (0 или 0xFFFFFFFF):
 * для потока это нормально, но у сохранённого файла часть плееров (например,
 * «Кино и ТВ» в Windows) тогда не показывает длительность и плохо перематывает.
 * Обёртка считает длительность треков по фрагментам (moof → traf → tfdt + trun)
 * и в конце перезаписывает поля duration в mvhd/tkhd/mdhd init-сегмента.
 * Размер init-сегмента не меняется, поэтому патч пишется поверх начала файла.
 */

/**
 * @param {Uint8Array} buf
 * @param {number} start
 * @param {number} end
 * @returns {Generator<{type: string, start: number, end: number, body: number}>}
 */
export function* boxes(buf, start = 0, end = buf.byteLength) {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let pos = start;
    while (pos + 8 <= end) {
        let size = view.getUint32(pos);
        const type = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]);
        let body = pos + 8;
        if (size === 1) {
            if (pos + 16 > end) return;
            size = Number(view.getBigUint64(pos + 8));
            body = pos + 16;
        } else if (size === 0) {
            size = end - pos;
        }
        if (size < 8 || pos + size > end) return;
        yield { type, start: pos, end: pos + size, body };
        pos += size;
    }
}

export function child(buf, parent, type) {
    for (const b of boxes(buf, parent.body, parent.end)) if (b.type === type) return b;
    return null;
}

/** Обёртка над FileWriter, которая в close() дописывает длительность в init-сегмент. */
export class Mp4DurationFixer {
    /** @param {import('./output.js').FileWriter} out - Должен поддерживать writeAt (иначе патч пропускается). */
    constructor(out) {
        this.out = out;
        this.offset = 0;
        /** @type {?{bytes: Uint8Array, offset: number}} */
        this.init = null;
        /** @type {Map<number, {start: number, end: number}>} trackId → диапазон времени (в единицах трека) */
        this.tracks = new Map();
    }

    async write(chunk) {
        try {
            this._scan(chunk);
        } catch { /* не MP4 или нестандартная структура — просто пишем как есть */ }
        await this.out.write(chunk);
        this.offset += chunk.byteLength;
    }

    async close() {
        if (this.init && this.out.writeAt && this.tracks.size) {
            const patched = this._patch(this.init.bytes);
            if (patched) await this.out.writeAt(this.init.offset, patched);
        }
        await this.out.close();
    }

    abort() {
        return this.out.abort();
    }

    /** @returns {Map<number, number>} trackId → длительность в единицах трека */
    durations() {
        return new Map([...this.tracks].map(([id, t]) => [id, Math.max(0, t.end - t.start)]));
    }

    _scan(buf) {
        const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        for (const box of boxes(buf)) {
            if (box.type === 'moov' && !this.init) {
                // Копия только до конца moov: патчим её и пишем поверх.
                this.init = { bytes: buf.slice(0, box.end), offset: this.offset };
            } else if (box.type === 'moof') {
                for (const traf of boxes(buf, box.body, box.end)) {
                    if (traf.type !== 'traf') continue;
                    const tfhd = child(buf, traf, 'tfhd');
                    const tfdt = child(buf, traf, 'tfdt');
                    if (!tfhd) continue;
                    const tfhdFlags = view.getUint32(tfhd.body) & 0xffffff;
                    const trackId = view.getUint32(tfhd.body + 4);
                    // default-sample-duration в tfhd (если есть): пропускаем base-data-offset и sample-description-index.
                    let p = tfhd.body + 8;
                    if (tfhdFlags & 0x1) p += 8;
                    if (tfhdFlags & 0x2) p += 4;
                    const defaultDuration = tfhdFlags & 0x8 ? view.getUint32(p) : 0;

                    let base = 0;
                    if (tfdt) {
                        const v = buf[tfdt.body];
                        base = v === 1 ? Number(view.getBigUint64(tfdt.body + 4)) : view.getUint32(tfdt.body + 4);
                    }
                    let total = 0;
                    for (const trun of boxes(buf, traf.body, traf.end)) {
                        if (trun.type !== 'trun') continue;
                        const flags = view.getUint32(trun.body) & 0xffffff;
                        const count = view.getUint32(trun.body + 4);
                        let q = trun.body + 8;
                        if (flags & 0x1) q += 4;
                        if (flags & 0x4) q += 4;
                        const per = ((flags & 0x100) ? 4 : 0) + ((flags & 0x200) ? 4 : 0) + ((flags & 0x400) ? 4 : 0) + ((flags & 0x800) ? 4 : 0);
                        for (let i = 0; i < count; i++, q += per) total += (flags & 0x100) ? view.getUint32(q) : defaultDuration;
                    }
                    const t = this.tracks.get(trackId) || { start: base, end: base };
                    t.start = Math.min(t.start, base);
                    t.end = Math.max(t.end, base + total);
                    this.tracks.set(trackId, t);
                }
            }
        }
    }

    _patch(init) {
        const buf = init.slice();
        const view = new DataView(buf.buffer);
        const moov = [...boxes(buf)].find(b => b.type === 'moov');
        if (!moov) return null;
        const mvhd = child(buf, moov, 'mvhd');
        if (!mvhd) return null;

        // Поле duration: в версии 0 — 32 бита, в версии 1 — 64.
        const setDuration = (pos, version, value) => {
            if (version === 1) view.setBigUint64(pos, BigInt(Math.round(value)));
            else view.setUint32(pos, Math.min(0xfffffffe, Math.round(value)));
        };
        const mvhdV = buf[mvhd.body];
        const movieScale = view.getUint32(mvhd.body + (mvhdV === 1 ? 20 : 12));
        const durations = this.durations();
        let movieDuration = 0;

        for (const trak of boxes(buf, moov.body, moov.end)) {
            if (trak.type !== 'trak') continue;
            const tkhd = child(buf, trak, 'tkhd');
            const mdia = child(buf, trak, 'mdia');
            const mdhd = mdia && child(buf, mdia, 'mdhd');
            if (!tkhd || !mdhd) continue;
            const tkhdV = buf[tkhd.body];
            const trackId = view.getUint32(tkhd.body + (tkhdV === 1 ? 20 : 12));
            const mdhdV = buf[mdhd.body];
            const scale = view.getUint32(mdhd.body + (mdhdV === 1 ? 20 : 12));
            const d = durations.get(trackId);
            if (!d || !scale) continue;
            setDuration(mdhd.body + (mdhdV === 1 ? 24 : 16), mdhdV, d);
            const inMovie = (d / scale) * movieScale;
            setDuration(tkhd.body + (tkhdV === 1 ? 28 : 20), tkhdV, inMovie);
            movieDuration = Math.max(movieDuration, inMovie);
        }
        if (!movieDuration) return null;
        setDuration(mvhd.body + (mvhdV === 1 ? 24 : 16), mvhdV, movieDuration);
        return buf;
    }
}
