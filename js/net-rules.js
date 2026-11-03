/**
 * Подстановка заголовков (Referer, Origin) в запросы расширения к CDN видео.
 * fetch() не даёт выставить эти заголовки вручную, а CDN часто их проверяют.
 *
 * Правила declarativeNetRequest ставит фон расширения (в offscreen-документе
 * этого API нет), здесь — только запрос к нему.
 */

import { ext } from './util.js';

/**
 * @param {string} domain - Домен запроса (поддомены тоже подходят).
 * @param {Record<string, ?string>} headers - Значение null — убрать заголовок.
 * @returns {Promise<void>}
 */
export async function setRequestHeaders(domain, headers) {
    const res = await ext.runtime.sendMessage({ type: 'set-headers', domain, headers });
    if (res?.error) throw new Error(`не удалось подставить заголовки: ${res.error}`);
}

/**
 * Домен второго уровня для правила: «edge-12.cdn.example.com» → «example.com»,
 * чтобы одно правило покрывало все зеркала CDN.
 * @param {string} url
 * @returns {string}
 */
export function ruleDomain(url) {
    const host = new URL(url).hostname;
    if (/^[\d.]+$|^\[/.test(host)) return host.replace(/^\[|\]$/g, '');
    const parts = host.split('.');
    return parts.length > 2 ? parts.slice(-2).join('.') : host;
}
