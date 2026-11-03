/**
 * Подстановка заголовков (Referer, Origin) в запросы расширения к CDN видео.
 * fetch() не даёт выставить эти заголовки вручную, а CDN часто их проверяют.
 *
 * Правила ставит фон расширения (в Chrome — declarativeNetRequest, в Firefox —
 * webRequest), здесь — только запрос к нему. Обычно запрос идёт сообщением;
 * когда загрузчик работает на самой фоновой странице (Firefox), фон передаёт
 * сюда прямой вызов через useHeadersTransport.
 */

import { ext } from './util.js';

let transport = msg => ext.runtime.sendMessage(msg);

/** @param {(msg: object) => Promise<any>} send */
export function useHeadersTransport(send) {
    transport = send;
}

/**
 * @param {string} domain - Домен запроса (поддомены тоже подходят).
 * @param {Record<string, ?string>} headers - Значение null — убрать заголовок.
 * @returns {Promise<void>}
 */
export async function setRequestHeaders(domain, headers) {
    const res = await transport({ type: 'set-headers', domain, headers });
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
