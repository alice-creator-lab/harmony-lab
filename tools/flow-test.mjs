/**
 * flow-test.mjs — 介面與播放流程檢查（不需假麥克風）：
 * 手機尺寸排版、示範播放的音訊節點生命週期、全曲不可評分。
 *   node tools/flow-test.mjs <port> <url> <shot.png>
 */
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { writeFileSync } from 'node:fs';

const [portArg, url, shot] = process.argv.slice(2);
const PORT = Number(portArg || 9851);
const CHROME = `${homedir()}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`;

const child = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--autoplay-policy=no-user-gesture-required',
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/flow-${Date.now()}`, 'about:blank',
], {stdio: 'ignore'});
const hardStop = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} process.exit(2); }, 180000);
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
await send('Emulation.setUserAgentOverride', {userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'});
await send('Page.bringToFront');
await send('Page.navigate', {url});
await sleep(1500);

const layout = await evalJs(`JSON.stringify({
  scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth,
  canvasW: document.getElementById('roll').clientWidth,
  btnTop: Math.round(document.getElementById('btnSing').getBoundingClientRect().top),
  rollTop: Math.round(document.getElementById('roll').getBoundingClientRect().top),
  btnInView: document.getElementById('btnSing').getBoundingClientRect().bottom <= window.innerHeight,
  lyHidden: getComputedStyle(document.getElementById('lyric')).display !== 'none'
})`);
console.log('LAYOUT', layout);

/* 示範播放：開始後應有排程與發聲節點，播完全部歸零 */
await evalJs(`document.getElementById('btnListen').click(); 'go'`);
await sleep(900);
const during = await evalJs(`JSON.stringify({audio: window.__lab.audio(), phase: window.__lab.state().phase, playing: window.__lab.state().playing})`);
console.log('DURING', during);
let waited = 0, st = null;
while (waited < 20000) {
  await sleep(400); waited += 400;
  st = await evalJs(`JSON.stringify({audio: window.__lab.audio(), phase: window.__lab.state().phase, playing: window.__lab.state().playing})`);
  if (!JSON.parse(st).playing) break;
}
console.log('AFTER', st, 'waited', waited);

/* 全曲不可評分，單句可以 */
await evalJs(`document.querySelectorAll('#lineChips .chip')[0].click(); 'ok'`);
await sleep(150);
const allSong = await evalJs(`JSON.stringify({disabled: document.getElementById('btnSing').disabled, notes: window.__lab.state().notes})`);
await evalJs(`document.querySelectorAll('#lineChips .chip')[2].click(); 'ok'`);
await sleep(150);
const oneLine = await evalJs(`JSON.stringify({disabled: document.getElementById('btnSing').disabled, notes: window.__lab.state().notes})`);
console.log('ALLSONG', allSong);
console.log('ONELINE', oneLine);

/* 容差滑桿 */
await evalJs(`const r=document.getElementById('tolRange'); r.value='80'; r.dispatchEvent(new Event('input')); 'ok'`);
const tol = await evalJs(`JSON.stringify({tol: window.__lab.state().tol, label: document.getElementById('tolVal').textContent})`);
console.log('TOL', tol);

/* 匯入自訂曲目：用 textarea 不可得，直接經 localStorage 驗證正規化 */
const imp = await evalJs(`(() => {
  const raw = {id:'mine', title:'我的練習', tempo:80, tonic:'G', har:{step:2,dir:1},
    lines:[{deg:'3/1 5/1 6/1 5/1 3/2 1/2', lyr:'測試歌詞', chords:['C','G']}]};
  localStorage.setItem('hl-custom', JSON.stringify([raw]));
  location.href = location.pathname + '?count=0&nosw=1&r=' + Math.random();
  return 'reload';
})()`);
console.log('IMPORT', imp);
await sleep(1600);
const afterImport = await evalJs(`JSON.stringify({songs: document.querySelectorAll('#songChips .chip').length, lastTitle: [...document.querySelectorAll('#songChips .chip')].pop().textContent})`);
console.log('AFTER_IMPORT', afterImport);
await evalJs(`[...document.querySelectorAll('#songChips .chip')].pop().click(); 'ok'`);
await sleep(300);
const custom = await evalJs(`JSON.stringify({state: window.__lab.state(), level: document.getElementById('songLevel').textContent, key: document.getElementById('songKey').textContent, notes: window.__lab.state().notes})`);
console.log('CUSTOM', custom);
await evalJs(`localStorage.removeItem('hl-custom'); 'ok'`);

if (shot) {
  const ss = await send('Page.captureScreenshot', {format: 'png', captureBeyondViewport: true});
  writeFileSync(shot, Buffer.from(ss.result.data, 'base64'));
  console.log('SHOT', shot);
}
ws.close();
process.exit(0);
