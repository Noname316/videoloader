/**
 * Темп запросов к CDN: ограничение параллельных запросов и минимальная пауза
 * между стартами запросов. При ответах «слишком часто» темп снижается, после
 * серии успешных запросов — понемногу возвращается к заданному.
 */

import { abortError } from './util.js';

const SPEED_UP_AFTER = 40;
const MAX_DELAY_MS = 15000;

export class Pacer {
    /**
     * @param {{concurrency: number, delayMs: number}} opts - Заданный (максимальный) темп.
     */
    constructor({ concurrency, delayMs }) {
        this.maxConcurrency = Math.max(1, concurrency | 0);
        this.baseDelayMs = Math.max(0, delayMs | 0);
        this.concurrency = this.maxConcurrency;
        this.delayMs = this.baseDelayMs;
        this.active = 0;
        this.paused = false;
        this.nextStartAt = 0;
        this.successStreak = 0;
        /** @type {Array<() => void>} */
        this._waiters = [];
        this._timer = null;
    }

    /**
     * Ждёт разрешения начать запрос. После запроса обязательно вызвать release().
     * @param {AbortSignal} [signal]
     * @returns {Promise<void>}
     */
    async acquire(signal) {
        for (;;) {
            if (signal?.aborted) throw abortError();
            const wait = this._waitTime();
            if (wait === 0) {
                this.active++;
                this.nextStartAt = Date.now() + this.delayMs;
                return;
            }
            await this._sleepUntilWake(wait, signal);
        }
    }

    /** Запрос завершён. */
    release() {
        this.active = Math.max(0, this.active - 1);
        this._wake();
    }

    /** Успешный ответ: после серии успехов темп растёт обратно к заданному. */
    success() {
        if (++this.successStreak < SPEED_UP_AFTER) return;
        this.successStreak = 0;
        if (this.delayMs > this.baseDelayMs) this.delayMs = Math.max(this.baseDelayMs, Math.round(this.delayMs * 0.75));
        else if (this.concurrency < this.maxConcurrency) this.concurrency++;
    }

    /** Сервер просит помедленнее: вдвое меньше потоков и вдвое больше пауза. */
    slowDown() {
        this.successStreak = 0;
        this.concurrency = Math.max(1, Math.floor(this.concurrency / 2));
        this.delayMs = Math.min(MAX_DELAY_MS, Math.max(500, this.delayMs * 2));
    }

    pause() {
        this.paused = true;
    }

    resume() {
        this.paused = false;
        this._wake();
    }

    /** @returns {string} Текущий темп для отладочной панели. */
    describe() {
        return `${this.active}/${this.concurrency} потоков, пауза ${this.delayMs} мс`;
    }

    _waitTime() {
        if (this.paused || this.active >= this.concurrency) return Infinity;
        return Math.max(0, this.nextStartAt - Date.now());
    }

    _sleepUntilWake(ms, signal) {
        return new Promise((resolve, reject) => {
            let timer = null;
            const cleanup = () => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
                const i = this._waiters.indexOf(done);
                if (i >= 0) this._waiters.splice(i, 1);
            };
            const done = () => {
                cleanup();
                resolve();
            };
            const onAbort = () => {
                cleanup();
                reject(abortError());
            };
            this._waiters.push(done);
            if (Number.isFinite(ms)) timer = setTimeout(done, ms);
            signal?.addEventListener('abort', onAbort, { once: true });
        });
    }

    _wake() {
        for (const w of [...this._waiters]) w();
    }
}
