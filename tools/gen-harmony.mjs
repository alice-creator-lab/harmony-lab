/**
 * gen-harmony.mjs — 由 index.html 的曲目資料合成一段「和音聲部」WAV，
 * 用作假麥克風輸入，驗證評分流程。
 *   node tools/gen-harmony.mjs <songId> <lineIdx> <leadSec> <out.wav>
 */
import { readFileSync, writeFileSync } from 'node:fs';

const HERE = new URL('..', import.meta.url).pathname;
const html = readFileSync(HERE + 'index.html', 'utf8');
const SONGS = eval(html.match(/const SONGS = (\[[\s\S]*?\n\];)/)[1].replace(/;$/, ''));

const [songId, lineArg, leadArg, outArg, partArg] = process.argv.slice(2);
const PART = partArg === 'mel' ? 'mel' : 'har';
const song = SONGS.find(s => s.id === songId) || SONGS[0];
const lineIdx = Number(lineArg ?? 0);
const lead = Number(leadArg ?? 0);
const out = outArg || '/tmp/harmony.wav';

const SCALE = {major:[0,2,4,5,7,9,11], minor:[0,2,3,5,7,8,10]};

function degToNote(tok, tonic, mode) {
  const [dp, bp] = tok.split('/');
  const beats = parseFloat(bp);
  if (dp === '0' || dp === 'r') return {rest: true, beats};
  let s = dp, alt = 0;
  if (s[0] === '#') { alt = 1; s = s.slice(1); }
  else if (s[0] === 'b') { alt = -1; s = s.slice(1); }
  let oct = 0;
  while (s.endsWith("'")) { oct++; s = s.slice(0, -1); }
  while (s.endsWith(',')) { oct--; s = s.slice(0, -1); }
  const idx = parseInt(s, 10) - 1;
  return {idx, alt, oct, beats, midi: tonic + 12 * oct + SCALE[mode][idx] + alt};
}

/* 只取和音聲部（正是使用者要唱的那條線） */
const ln = song.lines[lineIdx];
const spec = ln.har || song.har;
const beatSec = 60 / song.tempo;
const notes = [];
let t = 0;
for (const tk of ln.deg.trim().split(/\s+/)) {
  const n = degToNote(tk, song.tonic, song.mode);
  if (!n.rest) {
    let pos = n.idx + spec.dir * spec.step;
    const octShift = Math.floor(pos / 7);
    const hIdx = pos - 7 * octShift;
    notes.push({
      start: t * beatSec,
      dur: n.beats * beatSec,
      midi: PART === 'mel' ? n.midi : song.tonic + 12 * (n.oct + octShift) + SCALE[song.mode][hIdx] + n.alt,
    });
  }
  t += n.beats;
}
const total = t * beatSec;

const SR = 44100;
const tail = 0.5;
const n = Math.floor((lead + total + tail) * SR);
const buf = new Float32Array(n);

for (const nt of notes) {
  const hz = 440 * Math.pow(2, (nt.midi - 69) / 12);
  const n0 = Math.floor((lead + nt.start) * SR);
  const n1 = Math.min(n, Math.floor((lead + nt.start + nt.dur * 0.94) * SR));
  let ph = 0;
  for (let i = n0; i < n1; i++) {
    const tt = (i - n0) / SR;
    const vib = tt > 0.15 ? 1 + (20 / 1200) * Math.sin(2 * Math.PI * 5 * tt) : 1;
    ph += (hz * vib) / SR;
    let s = 0;
    for (let h = 1; h <= 8; h++) s += Math.sin(2 * Math.PI * h * ph) / h;
    const atk = Math.min(1, tt / 0.04);
    const rel = Math.min(1, (n1 - i) / (0.12 * SR));
    buf[i] += s * 0.22 * atk * rel;
  }
}
for (let i = 0; i < n; i++) buf[i] += (Math.random() * 2 - 1) * 0.0015;

/* 寫成 16 位元單聲道 WAV */
const data = Buffer.alloc(n * 2);
for (let i = 0; i < n; i++) {
  const v = Math.max(-1, Math.min(1, buf[i]));
  data.writeInt16LE(Math.round(v * 32767), i * 2);
}
const head = Buffer.alloc(44);
head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8);
head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20);
head.writeUInt16LE(1, 22); head.writeUInt32LE(SR, 24); head.writeUInt32LE(SR * 2, 28);
head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
head.write('data', 36); head.writeUInt32LE(data.length, 40);
writeFileSync(out, Buffer.concat([head, data]));

console.log(JSON.stringify({
  song: song.title, line: lineIdx + 1, lead, notes: notes.length,
  songDur: +total.toFixed(3), file: out, bytes: n * 2 + 44,
  targets: notes.map(x => ({start: +x.start.toFixed(2), midi: x.midi})),
}));
