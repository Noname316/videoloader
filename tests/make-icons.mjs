// Генерирует значки расширения icons/icon{16,32,48,128}.png (сейчас стоит вариант h, палитра green).
// Запуск: node tests/make-icons.mjs [вариант] [--color палитра] [--out папка]
// node tests/make-icons.mjs --preview <файл.png> — лист сравнения всех вариантов;
// node tests/make-icons.mjs [вариант] --palettes --preview <файл.png> — все палитры для варианта.
// Сменив палитру, поправьте --primary/--primary-dark в popup.css и цвет бейджа в background.js.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// --- PNG ----------------------------------------------------------------------

function crc32(buf) {
    let crc = 0xffffffff;
    for (const b of buf) {
        let c = (crc ^ b) & 0xff;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}

/** @param {number} w @param {number} h @param {Uint8Array} rgba */
function encodePng(w, h, rgba) {
    const raw = Buffer.alloc(h * (w * 4 + 1));
    for (let y = 0; y < h; y++) {
        raw[y * (w * 4 + 1)] = 0;
        rgba.subarray(y * w * 4, (y + 1) * w * 4).forEach((v, i) => { raw[y * (w * 4 + 1) + 1 + i] = v; });
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
    ]);
}

/** Рисует значок size×size: shade(u, v) → [r, g, b, a] в координатах 0…1, сглаживание 4×4. */
function render(size, shade) {
    const out = new Uint8Array(size * size * 4);
    const S = 4;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            let r = 0, g = 0, b = 0, a = 0;
            for (let sy = 0; sy < S; sy++) {
                for (let sx = 0; sx < S; sx++) {
                    const p = shade((x + (sx + 0.5) / S) / size, (y + (sy + 0.5) / S) / size, size);
                    r += p[0] * p[3]; g += p[1] * p[3]; b += p[2] * p[3]; a += p[3];
                }
            }
            const o = (y * size + x) * 4;
            out[o] = a ? Math.round(r / a) : 0;
            out[o + 1] = a ? Math.round(g / a) : 0;
            out[o + 2] = a ? Math.round(b / a) : 0;
            out[o + 3] = Math.round((a / (S * S)) * 255);
        }
    }
    return out;
}

// --- Фигуры -------------------------------------------------------------------

const rgb = hex => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), 1];
const mix = (c1, c2, t) => c1.map((v, i) => v + (c2[i] - v) * Math.min(1, Math.max(0, t)));
const NONE = [0, 0, 0, 0];

function inRoundRect(u, v, x0, y0, x1, y1, r) {
    if (u < x0 || u > x1 || v < y0 || v > y1) return false;
    const dx = Math.max(x0 + r - u, 0, u - (x1 - r));
    const dy = Math.max(y0 + r - v, 0, v - (y1 - r));
    return dx * dx + dy * dy <= r * r;
}

function inCircle(u, v, cx, cy, r) {
    return (u - cx) ** 2 + (v - cy) ** 2 <= r * r;
}

/** Точка внутри многоугольника (чётность пересечений). */
function inPolygon(u, v, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i];
        const [xj, yj] = pts[j];
        if ((yi > v) !== (yj > v) && u < ((xj - xi) * (v - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

/** Стрелка вниз с «полкой» (значок загрузки) в квадрате cx±s. */
function inDownload(u, v, cx, cy, s, { tray = true } = {}) {
    const stem = Math.abs(u - cx) < s * 0.17 && v > cy - s * 0.85 && v < cy + 0.1 * s;
    const head = inPolygon(u, v, [[cx - s * 0.55, cy - s * 0.1], [cx + s * 0.55, cy - s * 0.1], [cx, cy + s * 0.5]]);
    const bar = tray && inRoundRect(u, v, cx - s * 0.7, cy + s * 0.68, cx + s * 0.7, cy + s * 0.9, s * 0.1);
    return stem || head || bar;
}

/** Расстояние от точки до отрезка. */
function distToSegment(u, v, [x1, y1], [x2, y2]) {
    const dx = x2 - x1, dy = y2 - y1;
    const t = Math.max(0, Math.min(1, ((u - x1) * dx + (v - y1) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(u - (x1 + t * dx), v - (y1 + t * dy));
}

/** Точка на линии толщиной w (ломаная pts, концы скруглены)? */
function onStroke(u, v, pts, w) {
    for (let i = 1; i < pts.length; i++) if (distToSegment(u, v, pts[i - 1], pts[i]) <= w / 2) return true;
    return false;
}

/** Дуга эллипса как ломаная: углы в радианах, 0 — вправо, по часовой (ось v вниз). */
function arc(cx, cy, rx, ry, from, to, steps = 24) {
    return Array.from({ length: steps + 1 }, (_, i) => {
        const a = from + ((to - from) * i) / steps;
        return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
    });
}

/** Ширина букв в долях высоты. */
const LETTER_WIDTH = { H: 0.56, L: 0.44, S: 0.56 };

/**
 * Надпись из букв H, L, S линиями толщины w, высотой h, по центру cx, cy.
 * @param {string} text
 * @returns {Array<Array<[number, number]>>} ломаные
 */
function letterStrokes(text, cx, cy, h, w) {
    const gap = h * 0.2;
    const letters = [...text];
    const total = letters.reduce((sum, c) => sum + LETTER_WIDTH[c] * h, 0) + gap * (letters.length - 1);
    let x = cx - total / 2 + w / 2;
    const top = cy - h / 2 + w / 2, bottom = cy + h / 2 - w / 2, mid = (top + bottom) / 2;
    const strokes = [];
    for (const c of letters) {
        const width = LETTER_WIDTH[c] * h;
        if (c === 'H') {
            const right = x + width - w;
            strokes.push([[x, top], [x, bottom]], [[right, top], [right, bottom]], [[x, mid], [right, mid]]);
        } else if (c === 'L') {
            strokes.push([[x, top], [x, bottom], [x + width - w, bottom]]);
        } else if (c === 'S') {
            // Две дуги: верхняя против часовой (с правого края через верх влево и вниз
            // к середине), нижняя — по часовой от середины через правый край вниз и налево.
            const rx = (width - w) / 2, ry = (bottom - top) / 4, scx = x + rx;
            strokes.push(arc(scx, top + ry, rx, ry, -0.15 * Math.PI, -Math.PI * 1.5, 28).slice(0, -1)
                .concat(arc(scx, bottom - ry, rx, ry, -Math.PI / 2, Math.PI * 0.85, 28)));
        } else {
            throw new Error(`буква «${c}» не нарисована`);
        }
        x += width + gap;
    }
    return strokes;
}

/**
 * Штриховая линия по контуру скруглённого прямоугольника (центр cx, cy, полуразмеры a, b, радиус r).
 * Штрихи раскладываются по периметру поровну: dashes штук, доля штриха — fill.
 */
function onDashedFrame(u, v, cx, cy, a, b, r, w, dashes, fill = 0.6) {
    const px = u - cx, py = v - cy;
    const qx = Math.max(-a + r, Math.min(a - r, px)), qy = Math.max(-b + r, Math.min(b - r, py));
    if (Math.abs(Math.hypot(px - qx, py - qy) - r) > w / 2) return false;
    // Положение точки вдоль периметра (по часовой от левого конца верхней стороны).
    const ex = 2 * (a - r), ey = 2 * (b - r), quarter = (Math.PI * r) / 2;
    const ang = Math.atan2(py - qy, px - qx);
    let t;
    if (px >= -a + r && px <= a - r) t = py < 0 ? px + a - r : ex + quarter + ey + quarter + (a - r - px);
    else if (py >= -b + r && py <= b - r) t = px > 0 ? ex + quarter + (py + b - r) : 2 * ex + 3 * quarter + ey + (b - r - py);
    else if (px > 0 && py < 0) t = ex + (ang + Math.PI / 2) * r;
    else if (px > 0) t = ex + quarter + ey + ang * r;
    else if (py > 0) t = 2 * ex + 2 * quarter + ey + (ang - Math.PI / 2) * r;
    else t = 2 * ex + 3 * quarter + 2 * ey + (ang + Math.PI) * r;
    const period = (2 * ex + 2 * ey + 4 * quarter) / dashes;
    // Сдвиг на полштриха — чтобы штрихи сидели посередине сторон, а не начинались с угла.
    return ((t + period * (fill / 2)) % period) < period * fill;
}

// --- Варианты -----------------------------------------------------------------

/** Палитры: верх и низ градиента фона, акцент (он же --primary в popup.css). */
const PALETTES = {
    orange: { top: '#ffad33', bottom: '#f07400', accent: '#ff9100' },
    blue: { top: '#5aa9ff', bottom: '#1f66e0', accent: '#3b8bff' },
    teal: { top: '#34d6b8', bottom: '#0b9480', accent: '#17b39a' },
    violet: { top: '#a77bff', bottom: '#6236dc', accent: '#8a5cff' },
    red: { top: '#ff7a6b', bottom: '#d9362f', accent: '#f2554a' },
    green: { top: '#4fd67a', bottom: '#16964a', accent: '#28b35e' }
};
let ACCENT_TOP, ACCENT_BOTTOM, ACCENT;
function usePalette(name) {
    const p = PALETTES[name];
    if (!p) throw new Error(`нет палитры ${name}; есть: ${Object.keys(PALETTES).join(', ')}`);
    [ACCENT_TOP, ACCENT_BOTTOM, ACCENT] = [rgb(p.top), rgb(p.bottom), rgb(p.accent)];
}
const DARK_TOP = rgb('#3a3a3e');
const DARK_BOTTOM = rgb('#1b1b1d');
const WHITE = rgb('#ffffff');

const VARIANTS = {
    /** Зелёный круг градиентом с белой буквой «H». */
    h(u, v, size) {
        if (!inCircle(u, v, 0.5, 0.5, 0.47)) return NONE;
        // На маленьких размерах линии толще, иначе буква тает.
        const w = size < 32 ? 0.15 : size < 48 ? 0.13 : 0.11;
        // Шире обычной буквы: одна в круге, и просвет между стойками не должен пропадать на 16 px.
        const half = 0.21, top = 0.28 + w / 2, bottom = 0.72 - w / 2;
        const left = 0.5 - half + w / 2, right = 0.5 + half - w / 2;
        const strokes = [[[left, top], [left, bottom]], [[right, top], [right, bottom]], [[left, 0.5], [right, 0.5]]];
        if (strokes.some(s => onStroke(u, v, s, w))) return WHITE;
        return mix(ACCENT_TOP, ACCENT_BOTTOM, (u + v) / 2 * 1.3 - 0.15);
    },

    /** Белый круг с зелёными буквами «HL» градиентом, без рамки. */
    hl(u, v, size) {
        if (!inCircle(u, v, 0.5, 0.5, 0.47)) return NONE;
        const ink = mix(ACCENT_TOP, ACCENT_BOTTOM, (u + v) / 2 * 1.3 - 0.15);
        // На маленьких размерах линии толще, иначе буквы тают.
        const w = size < 32 ? 0.13 : size < 48 ? 0.11 : 0.095;
        if (letterStrokes('HL', 0.5, 0.5, 0.46, w).some(s => onStroke(u, v, s, w))) return ink;
        return WHITE;
    },

    /** Белый квадрат: зелёные буквы «HLS» в штриховой рамке, рамка и буквы — общим градиентом. */
    hls(u, v, size) {
        if (!inRoundRect(u, v, 0.03, 0.03, 0.97, 0.97, 0.2)) return NONE;
        // Диагональный градиент: светлее слева сверху, темнее справа снизу.
        const ink = mix(ACCENT_TOP, ACCENT_BOTTOM, (u + v) / 2 * 1.15 - 0.08);
        // На маленьких размерах линии толще, штрихов меньше — иначе всё сливается.
        const small = size < 32;
        const frameW = small ? 0.09 : size < 48 ? 0.07 : 0.05;
        const dashes = small ? 8 : size < 48 ? 12 : 16;
        if (onDashedFrame(u, v, 0.5, 0.5, 0.4, 0.4, 0.13, frameW, dashes)) return ink;
        const letterH = small ? 0.3 : 0.28;
        const letterW = small ? 0.085 : size < 48 ? 0.07 : 0.06;
        if (letterStrokes('HLS', 0.5, 0.5, letterH, letterW).some(s => onStroke(u, v, s, letterW))) return ink;
        return WHITE;
    },

    /** Цветной квадрат: белый экран с «плеем», под ним стрелка загрузки. */
    screen(u, v, size) {
        if (!inRoundRect(u, v, 0.03, 0.03, 0.97, 0.97, 0.22)) return NONE;
        const bg = mix(ACCENT_TOP, ACCENT_BOTTOM, v);
        if (size < 32) {
            if (inPolygon(u, v, [[0.3, 0.16], [0.3, 0.6], [0.72, 0.38]])) return WHITE;
            if (inRoundRect(u, v, 0.2, 0.72, 0.8, 0.84, 0.05)) return WHITE;
            return bg;
        }
        // Экран — белая рамка, внутри белый «плей».
        const outer = inRoundRect(u, v, 0.16, 0.16, 0.84, 0.6, 0.07);
        const inner = inRoundRect(u, v, 0.22, 0.22, 0.78, 0.54, 0.035);
        if (outer && !inner) return WHITE;
        if (inPolygon(u, v, [[0.43, 0.29], [0.43, 0.47], [0.59, 0.38]])) return WHITE;
        if (inner) return bg;
        if (inDownload(u, v, 0.5, 0.74, 0.16, { tray: false })) return WHITE;
        if (inRoundRect(u, v, 0.3, 0.86, 0.7, 0.9, 0.02)) return WHITE;
        return bg;
    },

    /** Цветной квадрат с белым «плеем» и тёмным кружком загрузки в углу. */
    corner(u, v, size) {
        if (!inRoundRect(u, v, 0.03, 0.03, 0.97, 0.97, 0.22)) return NONE;
        const bg = mix(ACCENT_TOP, ACCENT_BOTTOM, v);
        const bx = 0.7, by = 0.7, br = size >= 32 ? 0.24 : 0.27;
        if (inCircle(u, v, bx, by, br + 0.04)) {
            if (!inCircle(u, v, bx, by, br)) return bg;
            if (inDownload(u, v, bx, by - 0.01, br * 0.62)) return ACCENT;
            return mix(DARK_TOP, DARK_BOTTOM, (v - (by - br)) / (2 * br));
        }
        if (inPolygon(u, v, [[0.18, 0.14], [0.18, 0.62], [0.6, 0.38]])) return WHITE;
        return bg;
    },

    /** Белая стрелка загрузки, «хвост» которой — треугольник «плей». */
    arrow(u, v) {
        if (!inRoundRect(u, v, 0.03, 0.03, 0.97, 0.97, 0.22)) return NONE;
        const bg = mix(ACCENT_TOP, ACCENT_BOTTOM, v);
        if (inPolygon(u, v, [[0.36, 0.14], [0.36, 0.5], [0.66, 0.32]])) return WHITE;
        if (inPolygon(u, v, [[0.22, 0.56], [0.78, 0.56], [0.5, 0.78]])) return WHITE;
        if (inRoundRect(u, v, 0.22, 0.82, 0.78, 0.9, 0.04)) return WHITE;
        return bg;
    }
};

// --- Запуск -------------------------------------------------------------------

const SIZES = [16, 32, 48, 128];
const { values: opts, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        color: { type: 'string', default: 'green' },
        out: { type: 'string' },
        preview: { type: 'string' },
        palettes: { type: 'boolean', default: false }
    }
});
const variant = positionals[0] || 'h';
if (!VARIANTS[variant]) throw new Error(`нет варианта ${variant}; есть: ${Object.keys(VARIANTS).join(', ')}`);
usePalette(opts.color);

if (opts.preview) {
    // Лист сравнения: строка на вариант (или на палитру с --palettes),
    // значки 128/48/32/16 на тёмном и светлом фоне.
    const rows = opts.palettes ? Object.keys(PALETTES) : Object.keys(VARIANTS);
    const cell = 150, W = cell * 2 + 260, H = rows.length * cell;
    const sheet = new Uint8Array(W * H * 4);
    const fill = (x0, y0, w, h, c) => {
        for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) sheet.set(c, (y * W + x) * 4);
    };
    fill(0, 0, W / 2, H, [37, 37, 39, 255]);
    fill(W / 2, 0, W / 2, H, [240, 240, 240, 255]);
    const blit = (img, size, x0, y0) => {
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const s = (y * size + x) * 4, d = ((y0 + y) * W + x0 + x) * 4, a = img[s + 3] / 255;
                for (let i = 0; i < 3; i++) sheet[d + i] = Math.round(img[s + i] * a + sheet[d + i] * (1 - a));
            }
        }
    };
    rows.forEach((name, row) => {
        if (opts.palettes) usePalette(name);
        const shade = VARIANTS[opts.palettes ? variant : name];
        const y = row * cell + 11;
        for (const half of [0, W / 2]) {
            let x = half + 10;
            for (const size of [128, 48, 32, 16]) {
                blit(render(size, shade), size, x, y + (128 - size) / 2);
                x += size + 14;
            }
        }
    });
    fs.writeFileSync(opts.preview, encodePng(W, H, sheet));
    console.log(`${opts.palettes ? 'палитры' : 'варианты'} (сверху вниз): ${rows.join(', ')}`);
} else {
    const dir = opts.out || fileURLToPath(new URL('../icons/', import.meta.url));
    for (const size of SIZES) fs.writeFileSync(path.join(dir, `icon${size}.png`), encodePng(size, size, render(size, VARIANTS[variant])));
    console.log(`значки «${variant}», палитра ${opts.color}: записаны в ${dir}`);
}
