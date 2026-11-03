/**
 * Offscreen-документ (Chrome): здесь идут загрузки (js/downloader.js). Попап
 * может закрыться в любой момент, а этот документ живёт, пока его не закроет фон.
 * Команды приходят от фона сообщениями с target: 'offscreen'.
 */

import { createDownloader } from './downloader.js';
import { ext } from './util.js';

const downloader = createDownloader(msg => ext.runtime.sendMessage(msg));

ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.target !== 'offscreen') return false;
    if (msg.type === 'start') {
        downloader.start(msg);
        sendResponse({ ok: true });
    } else if (msg.type === 'cancel') {
        sendResponse({ ok: downloader.cancel(msg.id) });
    }
    return false;
});
