// Тестовый DASH для e2e: из HLS-потока (MPEG-TS) mux.js делает отдельные дорожки
// fMP4 видео и звука, из них собирается DASH, устроенный как у VK/Одноклассников:
//   - видео: каждое качество одним файлом (SegmentBase + индекс sidx);
//   - звук: кусками по шаблону (SegmentTemplate + SegmentTimeline).
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function loadMux() {
    if (globalThis.muxjs) return;
    globalThis.window ??= globalThis;
    const code = fs.readFileSync(path.join(here, '../lib/mux.min.js'), 'utf8');
    vm.runInThisContext(`(function (exports, module, define) {\n${code}\n})()`, { filename: 'mux.min.js' });
}

/** TS-сегменты → { video: {init, frags[]}, audio: {init, frags[]} } (фрагмент на сегмент). */
function transmux(tsSegments) {
    loadMux();
    const t = new globalThis.muxjs.mp4.Transmuxer({ remux: false });
    const out = { video: { init: null, frags: [] }, audio: { init: null, frags: [] } };
    t.on('data', seg => {
        const track = out[seg.type];
        if (!track) return;
        track.init ??= Buffer.from(seg.initSegment);
        track.frags.push(Buffer.from(seg.data));
    });
    for (const ts of tsSegments) {
        t.push(new Uint8Array(ts));
        t.flush();
    }
    return out;
}

function u32(v) {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(v >>> 0);
    return b;
}

/** sidx v0: ссылки на фрагменты по порядку, сразу после самого sidx. */
function sidx(sizes, durations, timescale) {
    const refs = sizes.map((size, i) => Buffer.concat([u32(size), u32(durations[i]), u32(0x90000000)]));
    const body = Buffer.concat([
        u32(0), u32(1), u32(timescale), u32(0), u32(0),
        Buffer.from([0, 0, sizes.length >> 8, sizes.length & 0xff]), ...refs
    ]);
    return Buffer.concat([u32(8 + body.length), Buffer.from('sidx'), body]);
}

/**
 * @param {{remote: string, variants: Array<{path: string, width: number, height: number, bandwidth: number}>, segments: number}} o
 * @returns {Promise<{files: Map<string, Buffer>, mpd: string, duration: number}>} files — пути относительно манифеста
 */
export async function buildDashFixture({ remote, variants, segments }) {
    const files = new Map();
    const videoReps = [];
    let audio = null;
    let durations = [];

    for (const v of variants) {
        const playlistUrl = remote + v.path;
        const lines = (await (await fetch(playlistUrl)).text()).split('\n');
        const segs = [];
        const extinf = [];
        for (const line of lines) {
            if (line.startsWith('#EXTINF:')) extinf.push(parseFloat(line.slice(8)));
            else if (line.trim() && !line.startsWith('#') && segs.length < segments) segs.push(new URL(line.trim(), playlistUrl).href);
        }
        const ts = await Promise.all(segs.map(async u => Buffer.from(await (await fetch(u)).arrayBuffer())));
        const tracks = transmux(ts);
        durations = extinf.slice(0, segs.length);

        const index = sidx(tracks.video.frags.map(f => f.length), durations.map(d => Math.round(d * 90000)), 90000);
        const name = `v${v.height}.mp4`;
        files.set(name, Buffer.concat([tracks.video.init, index, ...tracks.video.frags]));
        videoReps.push({ ...v, name, initEnd: tracks.video.init.length - 1, indexEnd: tracks.video.init.length + index.length - 1 });
        audio ??= tracks.audio;
    }

    files.set('audio/init.mp4', audio.init);
    audio.frags.forEach((f, i) => files.set(`audio/seg-${String(i + 1).padStart(3, '0')}.m4s`, f));
    const duration = durations.reduce((a, b) => a + b, 0);
    const timeline = durations.map((d, i) => `<S${i ? '' : ' t="0"'} d="${Math.round(d * 1000)}"/>`).join('');

    const mpd = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT${duration.toFixed(3)}S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
${videoReps.map(v => `      <Representation id="v${v.height}" bandwidth="${v.bandwidth}" width="${v.width}" height="${v.height}" codecs="avc1.42000d">
        <BaseURL>${v.name}</BaseURL>
        <SegmentBase indexRange="${v.initEnd + 1}-${v.indexEnd}"><Initialization range="0-${v.initEnd}"/></SegmentBase>
      </Representation>`).join('\n')}
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="ja">
      <SegmentTemplate timescale="1000" startNumber="1" initialization="audio/init.mp4" media="audio/seg-$Number%03d$.m4s">
        <SegmentTimeline>${timeline}</SegmentTimeline>
      </SegmentTemplate>
      <Representation id="a1" bandwidth="64000" codecs="mp4a.40.5"/>
    </AdaptationSet>
  </Period>
</MPD>
`;
    return { files, mpd, duration };
}
