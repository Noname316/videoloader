/**
 * Запись скачанного видео во временную папку (OPFS расширения).
 *
 *   - DirectoryTarget пишет файл потоком, память не растёт;
 *   - fMP4-сегменты склеиваются как есть: init + фрагменты = готовый .mp4;
 *   - MPEG-TS либо пишется как .ts, либо после загрузки перепаковывается
 *     в MP4 библиотекой mux.js (без перекодирования).
 */

import { sanitizeFileName } from './util.js';

/**
 * @typedef {object} FileWriter
 * @property {(chunk: Uint8Array) => Promise<void>} write - Дописать в конец.
 * @property {(position: number, data: Uint8Array) => Promise<void>} [writeAt] - Перезаписать уже записанные байты.
 * @property {() => Promise<void>} close
 * @property {() => Promise<void>} abort
 */

export class DirectoryTarget {
    /** @param {FileSystemDirectoryHandle} handle @param {string} [path] */
    constructor(handle, path) {
        this.handle = handle;
        this.path = path || handle.name;
    }

    describe() {
        return this.path;
    }

    /** @param {string} name @returns {Promise<DirectoryTarget>} */
    async subfolder(name) {
        const safe = sanitizeFileName(name, 'video');
        const handle = await this.handle.getDirectoryHandle(safe, { create: true });
        return new DirectoryTarget(handle, `${this.path}/${safe}`);
    }

    /** @param {string} name @returns {Promise<boolean>} */
    async exists(name) {
        try {
            const file = await (await this.handle.getFileHandle(name)).getFile();
            return file.size > 0;
        } catch {
            return false;
        }
    }

    /**
     * Файл пишется во временный файл браузера и появляется под своим именем
     * только после close() — недокачанных файлов в папке не остаётся.
     * @param {string} name
     * @returns {Promise<FileWriter>}
     */
    async createFile(name) {
        const fileHandle = await this.handle.getFileHandle(name, { create: true });
        const writable = await fileHandle.createWritable({ keepExistingData: false });
        let bytes = 0;
        return {
            async write(chunk) {
                await writable.write(chunk);
                bytes += chunk.byteLength;
            },
            async writeAt(position, data) {
                await writable.write({ type: 'write', position, data });
            },
            async close() {
                await writable.close();
            },
            abort: async () => {
                try {
                    await writable.abort();
                } catch { /* уже закрыт */ }
                // Пустой файл, созданный getFileHandle, тоже убираем.
                if (!bytes) await this.handle.removeEntry(name).catch(() => {});
            }
        };
    }
}

/**
 * Обёртка над FileWriter, перепаковывающая MPEG-TS в фрагментированный MP4.
 * Каждый TS-сегмент — отдельный фрагмент; init-сегмент пишется один раз.
 */
export class TsToMp4Writer {
    /** @param {FileWriter} out */
    constructor(out) {
        const muxjs = globalThis.muxjs;
        if (!muxjs?.mp4?.Transmuxer) throw new Error('Библиотека mux.js не загружена');
        this.out = out;
        /** @type {Uint8Array[]} */
        this.pending = [];
        this.transmuxer = new muxjs.mp4.Transmuxer({ remux: true });
        this.transmuxer.on('data', seg => {
            if (!this.pending.length && seg.initSegment?.byteLength) this.pending.push(seg.initSegment);
            if (seg.data?.byteLength) this.pending.push(seg.data);
        });
    }

    /**
     * Сегменты только накапливаются в mux.js, перепаковка — одним проходом в close().
     * Сброс после каждого сегмента давал бы рывки: сегменты часто начинаются не с
     * ключевого кадра, и mux.js на стыках дублирует или растягивает кадры.
     * Цена — в памяти держится всё видео (для 720p это ~150–400 МБ на 20 минут).
     * @param {Uint8Array} chunk - Целый TS-сегмент.
     */
    async write(chunk) {
        this.transmuxer.push(chunk);
    }

    async close() {
        this.transmuxer.flush();
        const parts = this.pending.splice(0);
        if (!parts.length) throw new Error('mux.js не смог разобрать TS-поток — попробуйте формат TS');
        for (const p of parts) await this.out.write(p);
        await this.out.close();
    }

    abort() {
        return this.out.abort();
    }
}
