/**
 * mic-test.mjs — 用 Chrome 假音效裝置把「和音聲部」餵入麥克風，跑完整評分流程。
 *   node tools/mic-test.mjs <wav> <port> <url> <shot.png>
 */
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { writeFileSync } from 'node:fs';

const [wav, portArg, url, shot] = process.argv.slice(2);
const PORT = Number(portArg || 9841);
const SONG = Number(process.env.SONG || 0);
const LINE = Number(process.env.LINE || 0);
const SPEED = Number(process.env.SPEED || 1);
const CHROME = `${homedir()}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`;

const child = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--autoplay-policy=no-user-gesture-required',
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  `--use-file-for-fake-audio-capture=${wav}`,
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=/tmp/mictest-${Date.now()}`,
  '--window-size=390,844',
  'about:blank',
], {stdio: 'ignore'});
const hardStop = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} process.exit(2); }, 180000);
const cleanup = () => { clearTimeout(hardStop); try { child.kill('SIGKILL'); } catch {} };
process.on('exit', cleanup);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function pageWs() {
  for (let i = 0; i < 150; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch {}
    await sleep(100);
  }
  throw new Error('no page target');
}

const ws = new WebSocket(await pageWs());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => {
  const mid = ++id;
  ws.send(JSON.stringify({id: mid, method, params}));
  return new Promise(r => pending.set(mid, r));
};
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true, userGesture: true});
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
  return r.result?.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {width: 390, height: 844, deviceScaleFactor: 3, mobile: true});
await send('Emulation.setUserAgentOverride', {userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'});
await send('Page.bringToFront');
await send('Page.navigate', {url});
await sleep(1400);

const boot = await evalJs(`JSON.stringify({
  title: document.title,
  songs: document.querySelectorAll('#songChips .chip').length,
  lines: document.querySelectorAll('#lineChips .chip').length,
  canvasW: document.getElementById('roll').clientWidth,
  canvasH: document.getElementById('roll').clientHeight,
  state: window.__lab.state(),
  scrollW: document.documentElement.scrollWidth,
  innerW: window.innerWidth
})`);
console.log('BOOT', boot);

/* 依環境變數選曲目、句子與速度（句子 index 0 是全曲，故 +1） */
await evalJs(`document.querySelectorAll('#songChips .chip')[${SONG}].click(); 'ok'`);
await sleep(150);
await evalJs(`document.querySelectorAll('#lineChips .chip')[${LINE + 1}].click(); 'ok'`);
await sleep(150);
if (SPEED !== 1) {
  await evalJs(`[...document.querySelectorAll('#speedChips .chip')].find(b=>b.textContent.includes('${SPEED}')).click(); 'ok'`);
  await sleep(150);
}
await sleep(200);

const clicked = await evalJs(`document.getElementById('btnSing').click(); 'clicked'`);
console.log('CLICK', clicked);

let phase = '', waited = 0;
while (waited < 24000) {
  await sleep(300); waited += 300;
  phase = await evalJs(`window.__lab.state().phase`);
  if (phase === '完成') break;
}
console.log('PHASE', phase, 'after', waited, 'ms');

const res = await evalJs(`(() => {
  const r = window.__lab.result();
  const tr = window.__lab.track();
  if (!r) return JSON.stringify({error: 'no result', track: tr.length});
  return JSON.stringify({
    hits: r.hits, total: r.total, mean: r.mean === null ? null : +r.mean.toFixed(1),
    spread: r.spread === null ? null : +r.spread.toFixed(1),
    rows: r.rows.map(x => ({midi: x.midi, state: x.state, cents: x.cents === null ? null : Math.round(x.cents)})),
    trackN: tr.length,
    trackFirst: tr.slice(0, 3),
    trackLast: tr.slice(-2),
    uiText: document.getElementById('resultBox').innerText.replace(/\\n+/g, ' | ').slice(0, 300),
    audio: window.__lab.audio()
  });
})()`);
console.log('RESULT', res);

if (shot) {
  const ss = await send('Page.captureScreenshot', {format: 'png', captureBeyondViewport: true});
  writeFileSync(shot, Buffer.from(ss.result.data, 'base64'));
  console.log('SHOT', shot);
}

ws.close();
cleanup();
process.exit(0);
