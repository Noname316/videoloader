// Сквозная проверка в настоящем Chrome.
//
// Локальный сервер изображает сайт с плеером: страница на localhost запрашивает
// мастер-плейлист и один вариант (как hls.js), плейлисты и сегменты отдаются
// с 127.0.0.1 и только с Referer этой страницы — так проверяется, что расширение
// повторяет заголовки плеера. Сегменты проксируются из публичного тестового
// потока test-streams.mux.dev (MPEG-TS), поток обрезается до нескольких сегментов.
//
// Затем попап (открытый обычной вкладкой с ?tabId=) должен показать одну строку
// с выбором качества, дважды скачать поток в «Загрузки/VideoLoader» (второй файл —
// с «(1)» в имени) и через «Открыть папку» показать последнее видео.
//
// Потом страница переключается на DASH (tests/dash-fixture.mjs): видео одним файлом
// с индексом sidx, причём «CDN» не принимает заголовок Range и отдаёт куски только
// по параметру bytes= (как у VK/Одноклассников), звук — кусками по шаблону. Расширение
// должно показать одну строку (без кусков), скачать и склеить видео со звуком в MP4.
// Готовые файлы проверяются воспроизведением в Chrome: длительность, кадр, звук.
//
// Запуск: node tests/e2e.mjs [--browser chrome|firefox] [--headful] [--segments 4] [--screenshot popup.png]
// Нужны: puppeteer-core (npm i puppeteer-core или PUPPETEER_PATH) и Chrome (CHROME_PATH)
// или Firefox (FIREFOX_PATH). Для Firefox тест сначала собирает dist/firefox (tests/build.mjs)
// и управляет браузером через Marionette (tests/marionette.mjs), а не через puppeteer.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { buildDashFixture } from './dash-fixture.mjs';
import { launchFirefox } from './marionette.mjs';

const { values: args } = parseArgs({
    options: {
        browser: { type: 'string', default: 'chrome' },
        headful: { type: 'boolean', default: false },
        segments: { type: 'string', default: '4' },
        puppeteer: { type: 'string', default: process.env.PUPPETEER_PATH || 'puppeteer-core' },
        keep: { type: 'boolean', default: false },
        screenshot: { type: 'string', default: '' }
    }
});

const REMOTE = 'https://test-streams.mux.dev/x36xhzz/';
const SEGMENTS = Number(args.segments);
const puppeteerPath = fs.existsSync(args.puppeteer) ? pathToFileURL(path.resolve(args.puppeteer, 'lib/esm/puppeteer/puppeteer-core.js')).href : args.puppeteer;
const { default: puppeteer } = await import(puppeteerPath);
const FIREFOX = args.browser === 'firefox';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (FIREFOX) execFileSync(process.execPath, [path.join(root, 'tests/build.mjs')], { stdio: 'inherit' });
const extPath = FIREFOX ? path.join(root, 'dist/firefox') : root;
const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const firefox = process.env.FIREFOX_PATH || 'C:/Program Files/Mozilla Firefox/firefox.exe';
/** Firefox даёт расширению случайный UUID адресов moz-extension:// — задаём свой. */
const FIREFOX_ID = 'videoloader@noname316';
const FIREFOX_UUID = '5c1d7e2a-0b0e-4f6d-9a51-3f0c1e2d4b60';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'videoloader-e2e-'));
const profile = path.join(tmp, 'profile');
const downloads = path.join(tmp, 'downloads');
fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
fs.mkdirSync(downloads);
fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({
    download: { default_directory: downloads, prompt_for_download: false }
}));

const dash = await buildDashFixture({
    remote: REMOTE,
    segments: SEGMENTS,
    variants: [
        { path: 'url_2/193039199_mp4_h264_aac_ld_7.m3u8', width: 320, height: 184, bandwidth: 246440 },
        { path: 'url_4/193039199_mp4_h264_aac_7.m3u8', width: 512, height: 288, bandwidth: 460560 }
    ]
});
/** Файлы для проверки воспроизведения: /check/<имя>. */
const checkFiles = new Map();

// --- Сервер -------------------------------------------------------------------------
let port = 0;
const stats = { rejected: 0, segments: 0, rangeHeaderRejected: 0, rangeQuery: 0 };
const pageUrl = () => `http://localhost:${port}/page.html`;
const media = () => `http://127.0.0.1:${port}`;

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, media());
    const cors = { 'Access-Control-Allow-Origin': '*' };
    try {
        if (url.pathname === '/page.html') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<!doctype html><title>Тестовое видео</title><p>player</p><script>
                fetch('${media()}/hls/master.m3u8').then(r => r.text())
                    .then(() => fetch('${media()}/hls/v/url_2/193039199_mp4_h264_aac_ld_7.m3u8'))
                    .then(() => { document.body.dataset.ready = '1'; });
            </script>`);
            return;
        }
        if (url.pathname === '/dash.html') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<!doctype html><title>Тестовый DASH</title><p>player</p><script>
                fetch('${media()}/dash/manifest.mpd').then(r => r.text()).then(() => { document.body.dataset.ready = '1'; });
            </script>`);
            return;
        }
        if (url.pathname === '/check.html') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<!doctype html><video src="/check/${url.searchParams.get('f')}" muted playsinline></video>`);
            return;
        }
        if (url.pathname.startsWith('/check/')) {
            // Без ответов 206 Chrome не перематывает.
            const body = checkFiles.get(decodeURIComponent(url.pathname.slice(7)));
            const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
            if (m) {
                const from = Number(m[1]);
                const to = m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
                res.writeHead(206, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${from}-${to}/${body.length}` });
                res.end(body.subarray(from, to + 1));
            } else {
                res.writeHead(200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' });
                res.end(body);
            }
            return;
        }
        // Кросс-доменный Referer по умолчанию — только origin страницы.
        if (!req.headers.referer?.startsWith(`http://localhost:${port}/`)) {
            stats.rejected++;
            res.writeHead(403, cors);
            res.end('referer required');
            return;
        }
        if (url.pathname === '/hls/master.m3u8') {
            const text = await (await fetch(`${REMOTE}x36xhzz.m3u8`)).text();
            // Оставляем два лёгких варианта: 184p и 288p.
            const lines = text.split('\n');
            const out = ['#EXTM3U'];
            for (let i = 0; i < lines.length; i++) {
                if (/RESOLUTION=(320x184|512x288)/.test(lines[i])) out.push(lines[i], `v/${lines[i + 1].trim()}`);
            }
            res.writeHead(200, { ...cors, 'Content-Type': 'application/vnd.apple.mpegurl' });
            res.end(out.join('\n') + '\n');
            return;
        }
        if (url.pathname.startsWith('/hls/v/')) {
            const remote = REMOTE + url.pathname.slice('/hls/v/'.length);
            const text = await (await fetch(remote)).text();
            const out = [];
            let segs = 0;
            for (const line of text.split('\n')) {
                if (/^#EXT-X-ENDLIST/.test(line)) continue;
                if (line && !line.startsWith('#')) {
                    if (segs++ >= SEGMENTS) break;
                    out.push(`${media()}/seg?u=${encodeURIComponent(new URL(line.trim(), remote).href)}`);
                } else if (!(segs >= SEGMENTS && line.startsWith('#EXTINF'))) {
                    out.push(line);
                }
            }
            if (out[out.length - 1]?.startsWith('#EXTINF')) out.pop();
            out.push('#EXT-X-ENDLIST');
            res.writeHead(200, { ...cors, 'Content-Type': 'application/vnd.apple.mpegurl' });
            res.end(out.join('\n') + '\n');
            return;
        }
        if (url.pathname === '/dash/manifest.mpd') {
            res.writeHead(200, { ...cors, 'Content-Type': 'application/dash+xml' });
            res.end(dash.mpd);
            return;
        }
        if (url.pathname.startsWith('/dash/')) {
            const name = url.pathname.slice('/dash/'.length);
            const body = dash.files.get(name);
            if (!body) throw new Error(`нет файла ${name}`);
            if (!name.startsWith('audio/')) {
                // Как CDN Одноклассников: Range не принимает, куски — только через bytes=.
                if (req.headers.range) {
                    stats.rangeHeaderRejected++;
                    res.writeHead(400, cors);
                    res.end('no');
                    return;
                }
                const m = /^(\d+)-(\d+)$/.exec(url.searchParams.get('bytes') || '');
                if (m) {
                    stats.rangeQuery++;
                    res.writeHead(200, { ...cors, 'Content-Type': 'video/mp4' });
                    res.end(body.subarray(Number(m[1]), Number(m[2]) + 1));
                    return;
                }
            }
            res.writeHead(200, { ...cors, 'Content-Type': name.startsWith('audio/') ? 'audio/mp4' : 'video/mp4' });
            res.end(body);
            return;
        }
        if (url.pathname === '/seg') {
            const remote = url.searchParams.get('u');
            if (!remote?.startsWith(REMOTE)) throw new Error('bad segment');
            const body = Buffer.from(await (await fetch(remote)).arrayBuffer());
            stats.segments++;
            res.writeHead(200, { ...cors, 'Content-Type': 'video/mp2t' });
            res.end(body);
            return;
        }
        res.writeHead(404, cors);
        res.end();
    } catch (e) {
        res.writeHead(500, cors);
        res.end(String(e));
    }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
port = server.address().port;
// localhost должен попадать на тот же сервер и по IPv6.
const server6 = http.createServer((req, res) => server.emit('request', req, res));
await new Promise(r => server6.listen(port, '::1', r).on('error', () => r()));

// --- Браузер ------------------------------------------------------------------------
const browser = FIREFOX
    ? await launchFirefox({
        executablePath: firefox,
        headless: !args.headful,
        prefs: {
            'browser.download.dir': downloads,
            'browser.download.folderList': 2,
            'browser.download.useDownloadDir': true,
            'browser.download.alwaysOpenPanel': false,
            'media.autoplay.default': 0,
            // Вкладки теста открываются в фоне, а там Firefox видео не декодирует.
            'media.suspend-background-video.enabled': false,
            'media.block-autoplay-until-in-foreground': false,
            'extensions.webextensions.uuids': JSON.stringify({ [FIREFOX_ID]: FIREFOX_UUID })
        }
    })
    : await puppeteer.launch({
        executablePath: chrome,
        headless: !args.headful,
        userDataDir: profile,
        pipe: true,
        enableExtensions: true,
        args: ['--no-first-run', '--no-default-browser-check']
    });

let failed = false;
try {
    const extId = await browser.installExtension(extPath);
    console.log(`${FIREFOX ? 'Firefox' : 'Chrome'}, extension id:`, extId);
    const extBase = FIREFOX ? `moz-extension://${FIREFOX_UUID}` : `chrome-extension://${extId}`;
    // Где выполнять вызовы API расширения: в Chrome — service worker фона, в Firefox
    // (фон — страница, к ней не подключиться) — отдельная вкладка со страницей расширения.
    let worker;
    if (FIREFOX) {
        worker = await browser.openExtensionPage(`${extBase}/popup.html?tabId=0`);
    } else {
        worker = await (await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().includes(extId))).worker();
    }

    const page = await browser.newPage();
    await page.goto(pageUrl());
    await page.waitForSelector('body[data-ready="1"]', { timeout: 30000 });
    const tabId = await worker.evaluate(async () => (await (globalThis.browser ?? chrome).tabs.query({ url: 'http://localhost/*' }))[0]?.id);
    const found = await worker.evaluate(async id => (await (globalThis.browser ?? chrome).storage.session.get(`tab:${id}`))[`tab:${id}`], tabId);
    console.log('найдено фоном:', found?.map(m => `${m.kind} ${m.url} referer=${m.headers.Referer}`));
    if (found?.length !== 2) throw new Error('фон должен был найти 2 плейлиста (мастер и вариант)');

    let popup;
    if (FIREFOX) {
        popup = await browser.openExtensionPage(`${extBase}/popup.html?tabId=${tabId}`);
    } else {
        popup = await browser.newPage();
        popup.on('console', m => console.log('  popup:', m.text()));
        popup.on('pageerror', e => console.log('POPUP ERROR', e.message));
        await popup.goto(`${extBase}/popup.html?tabId=${tabId}`);
    }
    await popup.waitForSelector('#media .card select', { timeout: 30000 });
    const cards = await popup.$$eval('#media .card', els => els.map(e => e.innerText.replace(/\n/g, ' | ')));
    console.log('карточки:', cards);
    if (cards.length !== 1) throw new Error(`ожидалась одна карточка (вариант скрыт), а их ${cards.length}`);
    const options = await popup.$$eval('#media select option', os => os.map(o => o.textContent));
    console.log('качество:', options);

    /**
     * Нажимает «Скачать» и ждёт, пока новая (верхняя) карточка загрузки закончится.
     * Сначала ждёт, пока пропадёт карточка прошлой загрузки: истории в попапе нет.
     */
    const download = async quality => {
        const hideStarted = Date.now();
        await popup.waitForSelector('#jobsSection.hidden', { timeout: 15000 });
        if (Date.now() - hideStarted > 100) console.log(`  карточка прошлой загрузки пропала через ${((Date.now() - hideStarted) / 1000).toFixed(1)} с`);
        const before = await popup.$$eval('#jobs .card', els => els.length);
        await popup.select('#media select', quality);
        // После нажатия кнопка полторы секунды показывает «Добавлено» и не нажимается.
        await popup.waitForSelector('#media .card button:not(:disabled)');
        await popup.click('#media .card button');
        const started = Date.now();
        let last = '';
        for (;;) {
            const status = await popup.$$eval('#jobs .card', (els, n) => els.length > n ? els[0].innerText.replace(/\n/g, ' | ') : '', before);
            if (status !== last) console.log(`  [${((Date.now() - started) / 1000).toFixed(1)} с] ${status}`);
            last = status;
            if (/Готово|Ошибка|Остановлено/.test(status)) break;
            if (Date.now() - started > 180000) throw new Error('загрузка не закончилась за 3 минуты');
            await new Promise(r => setTimeout(r, 300));
        }
        if (!/Готово/.test(last)) throw new Error(`загрузка не удалась: ${last}`);
        return last;
    };
    /** Воспроизводит файл в Chrome: длительность, размер кадра, декодирован ли звук, перемотка. */
    const playCheck = async (name, buf) => {
        checkFiles.set(name, buf);
        const p = await browser.newPage();
        await p.goto(`http://localhost:${port}/check.html?f=${encodeURIComponent(name)}`);
        const r = await p.evaluate(async () => {
            const v = document.querySelector('video');
            await new Promise((resolve, reject) => {
                if (v.readyState >= 1) resolve();
                v.onloadedmetadata = resolve;
                v.onerror = () => reject(new Error(`ошибка воспроизведения ${v.error?.code}: ${v.error?.message}`));
            });
            await v.play();
            await new Promise(r => setTimeout(r, 1500));
            v.currentTime = v.duration * 0.6;
            await new Promise(r => { v.onseeked = r; });
            await new Promise(r => setTimeout(r, 1000));
            return {
                duration: v.duration, width: v.videoWidth, height: v.videoHeight,
                audioBytes: v.webkitAudioDecodedByteCount ?? (v.mozHasAudio ? 1 : 0), time: v.currentTime,
                // Есть ли вообще декодер H.264 (у безголового Firefox его может не быть).
                h264: v.canPlayType('video/mp4; codecs="avc1.42E01E"')
            };
        });
        await p.close();
        console.log(`воспроизведение ${name}: ${r.duration.toFixed(1)} с, ${r.width}x${r.height}, звук ${r.audioBytes > 1 ? `${r.audioBytes} Б` : (r.audioBytes ? "есть" : "нет")}, после перемотки ${r.time.toFixed(1)} с${r.width ? '' : `, H.264: «${r.h264}»`}`);
        if (!r.width || !r.audioBytes) throw new Error(`${name}: нет изображения или звука`);
        if (r.time < r.duration * 0.5) throw new Error(`${name}: перемотка не сработала`);
        return r;
    };
    const checkMp4 = (name, buf) => {
        const top = boxTypes(buf);
        console.log(`файл: ${name}, ${buf.length} байт, боксы: ${[...new Set(top)].join(' ')}`);
        if (!top.includes('moov') || !top.includes('moof')) throw new Error(`${name} не похож на фрагментированный MP4`);
    };

    // «Открыть папку» на самом деле открыла бы Проводник — подменяем вызовы и записываем их.
    const stubOpenFolder = async () => {
        const stubbed = await popup.evaluate(() => {
            window.__opened = [];
            const downloads = (globalThis.browser ?? chrome).downloads;
            Object.defineProperty(downloads, 'show', { value: id => window.__opened.push(['show', id]), configurable: true });
            Object.defineProperty(downloads, 'showDefaultFolder', { value: () => window.__opened.push(['default']), configurable: true });
            return String(downloads.show).includes('__opened') && String(downloads.showDefaultFolder).includes('__opened');
        });
        // Иначе кнопка по-настоящему откроет Проводник.
        if (!stubbed) throw new Error('не удалось подменить downloads.show — проверка «Открыть папку» пропущена бы небезопасно');
    };
    const clickOpenFolder = async () => {
        await popup.click('#openFolderBtn');
        await popup.waitForFunction(() => window.__opened.length > 0);
        return popup.evaluate(() => window.__opened.pop());
    };

    // 1. Папка — «Загрузки/VideoLoader»; пока видео нет, кнопка открывает «Загрузки».
    const folderName = await popup.$eval('#folderName', el => el.textContent);
    console.log('папка в попапе:', folderName);
    if (folderName !== 'Загрузки/VideoLoader') throw new Error('попап должен показывать «Загрузки/VideoLoader»');
    await stubOpenFolder();
    const before = await clickOpenFolder();
    console.log('«Открыть папку» без загрузок:', before);
    if (before[0] !== 'default') throw new Error('без загрузок должна открываться папка «Загрузки»');

    // 2. Дважды одно и то же: второй файл должен получить имя «… (1).mp4», а не затереть первый
    // (Firefox пишет «…(1).mp4» без пробела).
    const SECOND = / ?\(1\)\.mp4$/;
    await download('184');
    if (args.screenshot) {
        await popup.setViewport({ width: 380, height: 400 });
        await popup.screenshot({ path: args.screenshot, fullPage: true });
    }
    await download('184');
    // Сразу, пока готовая карточка не пропала (она видна несколько секунд).
    const topTitle = await popup.$eval('#jobs .card .card-title', el => el.textContent);
    if (!SECOND.test(topTitle)) throw new Error(`карточка должна показывать итоговое имя, а там «${topTitle}»`);
    const sub = path.join(downloads, 'VideoLoader');
    const files = fs.existsSync(sub) ? fs.readdirSync(sub).sort() : [];
    console.log('в Загрузки/VideoLoader:', files);
    if (files.length !== 2 || !files.some(f => SECOND.test(f))) throw new Error('ожидались два файла, второй — с «(1)»');
    for (const f of files) checkMp4(f, fs.readFileSync(path.join(sub, f)));
    await playCheck('hls.mp4', fs.readFileSync(path.join(sub, files[0])));
    if (fs.readdirSync(downloads).length !== 1) throw new Error('в корне «Загрузок» не должно быть файлов');

    // 3. Теперь «Открыть папку» показывает последнее видео — то есть открывает его папку.
    const lastId = await worker.evaluate(async () => (await (globalThis.browser ?? chrome).downloads.search({ orderBy: ['-startTime'], limit: 1 }))[0].id);
    const after = await clickOpenFolder();
    console.log('«Открыть папку» после загрузок:', after, 'последняя загрузка:', lastId);
    if (after[0] !== 'show' || after[1] !== lastId) throw new Error('кнопка должна показать последнее сохранённое видео');

    // 4. Ошибка не пропадает сама — только по «Убрать».
    await worker.evaluate(async () => {
        const api = globalThis.browser ?? chrome;
        const { jobs = {} } = await api.storage.session.get('jobs');
        jobs.failed = { id: 'failed', title: 'Сломанное видео', status: 'error', note: 'плейлист недоступен (HTTP 403)', startedAt: Date.now(), finishedAt: Date.now() - 60000 };
        await api.storage.session.set({ jobs });
    });
    await popup.waitForFunction(() => /Сломанное видео/.test(document.getElementById('jobs').innerText));
    const errorCard = await popup.$eval('#jobs .card', el => el.innerText.replace(/\n/g, ' | '));
    console.log('карточка ошибки:', errorCard);
    if (!/Ошибка: плейлист недоступен/.test(errorCard) || !/Убрать/.test(errorCard)) throw new Error('у ошибки должны быть текст и кнопка «Убрать»');
    await popup.click('#jobs .card button');
    await popup.waitForSelector('#jobsSection.hidden', { timeout: 5000 });
    console.log('после «Убрать»: раздел загрузок скрыт');

    // 5. DASH: одна строка вместо кусков, видео и звук склеены в один MP4.
    await page.goto(`http://localhost:${port}/dash.html`);
    await page.waitForSelector('body[data-ready="1"]', { timeout: 30000 });
    await popup.waitForFunction(() => document.querySelector('#media .card .badge')?.textContent === 'DASH' && document.querySelector('#media .card select'), { timeout: 30000 });
    const dashCards = await popup.$$eval('#media .card', els => els.map(e => e.innerText.replace(/\n/g, ' | ')));
    console.log('карточки DASH:', dashCards);
    if (dashCards.length !== 1) throw new Error(`ожидалась одна карточка DASH, а их ${dashCards.length}`);
    if (args.screenshot) await popup.screenshot({ path: args.screenshot.replace(/\.png$/, '-dash.png'), fullPage: true });
    await download('288');
    const dashFile = fs.readdirSync(sub).find(f => f.startsWith('Тестовый DASH'));
    if (!dashFile) throw new Error('файл DASH не сохранился');
    const dashBuf = fs.readFileSync(path.join(sub, dashFile));
    checkMp4(dashFile, dashBuf);
    const traks = dashBuf.subarray(0, 4096).toString('latin1').split('trak').length - 1;
    if (traks !== 2) throw new Error(`в moov должно быть 2 дорожки (видео и звук), а их ${traks}`);
    const played = await playCheck('dash.mp4', dashBuf);
    if (played.height !== 288) throw new Error(`выбрано качество ${played.height}p вместо 288p`);
    if (Math.abs(played.duration - dash.duration) > 1.5) throw new Error(`длительность ${played.duration} вместо ${dash.duration}`);
    console.log(`DASH: Range отклонён ${stats.rangeHeaderRejected} раз, кусков через bytes= ${stats.rangeQuery}`);
    if (!stats.rangeQuery) throw new Error('загрузчик не перешёл на параметр bytes=');

    console.log(`сервер: сегментов отдано ${stats.segments}, отказов без Referer ${stats.rejected}`);
    if (stats.rejected) throw new Error('часть запросов ушла без Referer страницы');
    console.log('OK');
} catch (e) {
    failed = true;
    console.error('FAIL:', e.stack || e.message);
} finally {
    await browser.close();
    server.close();
    server6.close();
    if (!args.keep) fs.rmSync(tmp, { recursive: true, force: true });
    else console.log('временная папка:', tmp);
}
process.exit(failed ? 1 : 0);

/** Типы боксов MP4 верхнего уровня. */
function boxTypes(buf) {
    const top = [];
    for (let pos = 0; pos + 8 <= buf.length;) {
        const size = buf.readUInt32BE(pos);
        top.push(buf.toString('latin1', pos + 4, pos + 8));
        if (size < 8) break;
        pos += size;
    }
    return top;
}
