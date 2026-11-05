/**
 * tone-test.mjs — 量測合成音色：峰值、頻譜重心、4 kHz 以上能量佔比。
 *   node tools/tone-test.mjs <port> <url>
 */
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';

const [portArg, url] = process.argv.slice(2);
const PORT = Number(portArg || 9861);
const CHROME = `${homedir()}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`;

const child = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/tone-${Date.now()}`, 'about:blank'], {stdio: 'ignore'});
const hardStop = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} process.exit(2); }, 120000);
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

await send('Page.enable'); await send('Runtime.enable'); await send('Page.bringToFront');
await send('Page.navigate', {url});
await sleep(1500);

for (const [song, line, label] of [[0, 0, '舊站台 第1句'], [3, 3, '天台看星 第4句'], [4, 0, '旺角黃昏 第1句']]) {
  const r = await evalJs(`window.__lab.renderOffline(${song}, ${line}).then(o => JSON.stringify(o))`);
  console.log(label, r);
}
ws.close();
process.exit(0);
