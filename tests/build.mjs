// Сборка пакетов расширения:
//   dist/chrome/   — Chrome, Edge, Opera, Яндекс (manifest.json, MV3, offscreen-документ);
//   dist/firefox/  — Firefox (manifest.firefox.json → manifest.json, MV2, фоновая страница);
//   dist/videoloader-<версия>-chrome.zip и -firefox.zip — архивы для магазинов.
// Запуск: node tests/build.mjs (или npm run build).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

/** Общие файлы обоих пакетов (папки — целиком). */
const COMMON = ['background.js', 'popup.html', 'popup.css', 'js', 'lib', 'icons'];
const TARGETS = {
    chrome: { manifest: 'manifest.json', extra: ['offscreen.html'] },
    firefox: { manifest: 'manifest.firefox.json', extra: ['background.html'] }
};

function listFiles(rel) {
    const abs = path.join(root, rel);
    if (fs.statSync(abs).isFile()) return [rel];
    return fs.readdirSync(abs).flatMap(name => listFiles(path.join(rel, name)));
}

// --- ZIP (deflate, без внешних зависимостей) --------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});

function crc32(buf) {
    let crc = 0xffffffff;
    for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

/** @param {Array<{name: string, data: Buffer}>} entries */
function zip(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const { name, data } of entries) {
        const nameBuf = Buffer.from(name, 'utf8');
        const packed = zlib.deflateRawSync(data, { level: 9 });
        const crc = crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6); // имена в UTF-8
        local.writeUInt16LE(8, 8); // deflate
        local.writeUInt32LE(0, 10); // время и дата — нули: сборка воспроизводима
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(packed.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);
        locals.push(local, nameBuf, packed);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(8, 10);
        central.writeUInt32LE(0, 12);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(packed.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, nameBuf);
        offset += local.length + nameBuf.length + packed.length;
    }
    const centralSize = centrals.reduce((n, b) => n + b.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, ...centrals, end]);
}

// --- Сборка ---------------------------------------------------------------------------

fs.rmSync(dist, { recursive: true, force: true });
for (const [target, { manifest, extra }] of Object.entries(TARGETS)) {
    const out = path.join(dist, target);
    const files = [...COMMON, ...extra].flatMap(listFiles).sort();
    const entries = [{ name: 'manifest.json', data: fs.readFileSync(path.join(root, manifest)) }];
    for (const rel of files) entries.push({ name: rel.split(path.sep).join('/'), data: fs.readFileSync(path.join(root, rel)) });

    for (const { name, data } of entries) {
        fs.mkdirSync(path.dirname(path.join(out, name)), { recursive: true });
        fs.writeFileSync(path.join(out, name), data);
    }
    const { version } = JSON.parse(entries[0].data);
    const archive = path.join(dist, `videoloader-${version}-${target}.zip`);
    fs.writeFileSync(archive, zip(entries));
    console.log(`${target}: ${entries.length} файлов → ${path.relative(root, out)}, ${path.relative(root, archive)} (${Math.round(fs.statSync(archive).size / 1024)} КБ)`);
}
