/**
 * hum-test.mjs — 用假音效裝置餵一段旋律，驗證「哼唱扒譜」的辨識結果。
 *   node tools/hum-test.mjs <wav> <port> <url>
 */
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';

const [wav, portArg, url] = process.argv.slice(2);
const PORT = Number(portArg || 9871);
const CHROME = `${homedir()}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`;

const child = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  `--use-file-for-fake-audio-capture=${wav}`,
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/hum-${Date.now()}`, 'about:blank'], {stdio: 'ignore'});
const hardStop = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} process.exit(2); }, 150000);
process.on('exit', () => { clearTimeout(hardStop); try { child.kill('SIGKILL'); } catch {} });

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
let id = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => { const mid = ++id; ws.send(JSON.stringify({id: mid, method, params})); return new Promise(r => pending.set(mid, r)); };
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true, userGesture: true});
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
  return r.result?.result?.value;
};

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {width: 390, height: 844, deviceScaleFactor: 3, mobile: true});
await send('Page.bringToFront');
await send('Page.navigate', {url});
await sleep(1500);

if (process.env.KEY) {
  await evalJs(`[...document.querySelectorAll('#humKeyChips .chip')].find(b=>b.textContent==='${process.env.KEY}').click(); 'ok'`);
  await sleep(150);
}
if (process.env.HAR) {
  await evalJs(`[...document.querySelectorAll('#humHarChips .chip')].find(b=>b.textContent==='${process.env.HAR}').click(); 'ok'`);
  await sleep(150);
}
await evalJs(`document.getElementById('btnHum').click(); 'go'`);
let waited = 0, res = null;
while (waited < 20000) {
  await sleep(400); waited += 400;
  const txt = await evalJs(`document.getElementById('humOut').textContent`);
  if (txt && (txt.includes('辨識到') || txt.includes('沒有辨識到'))) { res = txt; break; }
}
console.log('HUM_UI', JSON.stringify(res));
const data = await evalJs(`(() => { const r = window.__lab.humResult();
  const tr = window.__lab.track();
  return JSON.stringify(r ? {count: r.count, preview: r.preview, tokens: r.tokens,
    first: tr.slice(0, 3), last: tr.slice(-2), n: tr.length} : null); })()`);
console.log('HUM_DATA', data);

/* 儲存並確認曲目加入 */
await evalJs(`document.getElementById('humTitle').value = '測試哼唱'; document.getElementById('btnHumSave').click(); 'ok'`);
await sleep(400);
const after = await evalJs(`JSON.stringify({songs: document.querySelectorAll('#songChips .chip').length,
  last: [...document.querySelectorAll('#songChips .chip')].pop().textContent,
  title: document.getElementById('songTitle').textContent,
  key: document.getElementById('songKey').textContent,
  notes: window.__lab.state().notes})`);
console.log('AFTER_SAVE', after);
ws.close();
process.exit(0);
