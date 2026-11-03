/**
 * Общие мелкие функции.
 */

/** API расширения: chrome в Chromium, browser в Firefox. */
export const ext = globalThis.browser ?? globalThis.chrome;

/**
 * Пауза, которую можно прервать сигналом отмены.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
export function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(abortError());
        const timer = setTimeout(done, ms);
        function done() {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }
        function onAbort() {
            clearTimeout(timer);
            reject(abortError());
        }
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/** @returns {DOMException} Ошибка отмены в стандартном виде. */
export function abortError() {
    return new DOMException('Загрузка остановлена', 'AbortError');
}

/** @param {unknown} e @returns {boolean} Это отмена пользователем? */
export function isAbort(e) {
    return e?.name === 'AbortError';
}

/**
 * Убирает символы, недопустимые в именах файлов Windows.
 * @param {string} name
 * @param {string} [fallback='video']
 * @returns {string}
 */
export function sanitizeFileName(name, fallback = 'video') {
    const clean = String(name ?? '')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_') // eslint-disable-line no-control-regex
        .replace(/\s+/g, ' ')
        .replace(/[. ]+$/, '')
        .trim()
        .slice(0, 150);
    return clean || fallback;
}

/** @param {number} bytes @returns {string} «12.3 МБ». */
export function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 Б';
    const units = ['Б', 'КБ', 'МБ', 'ГБ'];
    let i = 0;
    let v = bytes;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** @param {number} sec @returns {string} «1:02:03» или «2:03». */
export function formatDuration(sec) {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}
