// 真实浏览器（Chromium 内核，headless=new）验证扩展探测与浮动条三档。
// 全程无头：不抢前台，不注入真实键鼠。
// 前置：应用已完成 nm 宿主注册；本脚本会临时改写 settings.json 的 sniffTier。
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXE = process.argv[2];
const EDGE = process.env.FW_EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
// 数据目录：设置存漫游目录（%APPDATA%\Fetchweir），与「仅当前用户」安装目录（%LOCALAPPDATA%）分开。
const DATA = path.join(process.env.APPDATA || process.env.LOCALAPPDATA || os.homedir(), 'Fetchweir');
const SHOTS = path.join(ROOT, 'docs', 'ui-shots');
const EXT_ID = 'fjngndhalbkfkfcfhleflcgkicknkele';
const HITS = [];
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (n, d) => results.push({ name: n, pass: true, detail: d });
const bad = (n, d) => results.push({ name: n, pass: false, detail: d });
const progress = (msg) => {
  try { fs.appendFileSync(path.join(process.env.TEMP || '.', 'fw-browser-progress.log'), `${new Date().toISOString()} ${msg}\n`); } catch { /* ignore */ }
};

const PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>Fetchweir 探测验证页</title>
<style>body{background:#0f1117;color:#e8ecf5;font:15px system-ui;margin:0;padding:32px}
.box{max-width:720px;margin:0 auto}h1{font-size:20px}video{width:100%;border-radius:12px;background:#000}</style></head>
<body><div class="box"><h1>Fetchweir 探测验证页</h1>
<video id="v" src="/movie.mp4" controls preload="auto" autoplay muted></video>
<p id="s">正在加载媒体…</p></div>
<script>
const v = document.getElementById('v');
v.play().catch(()=>{});
fetch('/api/stream.m3u8').then(r=>r.text()).then(t=>{
  document.getElementById('s').textContent = '清单长度 ' + t.length;
});
</script></body></html>`;

const MP4 = Buffer.alloc(4096, 1);
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  HITS.push(`${req.method} ${u}${req.headers.range ? ' range=' + req.headers.range : ''}`);
  if (u === '/' || u === '/page') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(PAGE);
  }
  if (u === '/movie.mp4') {
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      const start = m ? Number(m[1]) : 0;
      const end = m && m[2] ? Number(m[2]) : MP4.length - 1;
      res.writeHead(206, {
        'content-type': 'video/mp4',
        'content-length': String(end - start + 1),
        'content-range': `bytes ${start}-${end}/${MP4.length}`,
        'accept-ranges': 'bytes',
      });
      return res.end(MP4.subarray(start, end + 1));
    }
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(MP4.length), 'accept-ranges': 'bytes' });
    return res.end(MP4);
  }
  if (u === '/api/stream.m3u8') {
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
    return res.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:4,\nseg.ts\n#EXT-X-ENDLIST\n');
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PAGE_URL = `http://127.0.0.1:${server.address().port}/`;

function setTier(tier) {
  const file = path.join(DATA, 'settings.json');
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 首次运行 */ }
  cur.sniffTier = tier;
  cur.sniffTtlHours = 24;
  fs.writeFileSync(file, JSON.stringify(cur, null, 2));
}

async function waitEndpoint(exePid) {
  let last = null;
  for (let i = 0; i < 150; i++) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(DATA, 'nm-endpoint.json'), 'utf8'));
      last = j;
      // 端点必须属于本次启动的进程，否则说明有残留实例抢占了端点文件
      if (j.port > 0 && j.pid === exePid) {
        const good = await new Promise((resolve) => {
          const s = net.connect(j.port, '127.0.0.1', () => { s.end(); resolve(true); });
          s.on('error', () => resolve(false));
        });
        if (good) return j;
      }
    } catch { /* 还没就绪 */ }
    await sleep(120);
  }
  throw new Error(`主进程未就绪（端点 pid=${last && last.pid}，期望 ${exePid}）`);
}

function readSniff() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, 'sniff-probe.json'), 'utf8')); } catch { return []; }
}

async function cdp(port, urlPrefix) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = list.find((t) => t.type === 'page' && t.url.startsWith(urlPrefix))
    || list.find((t) => t.type === 'page');
  if (!target) throw new Error('找不到页面目标：' + list.map((t) => `${t.type}:${t.url}`).join(' | '));
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let seq = 1;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = seq++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} 超时`)); }, 8000);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
  });
  await send('Page.enable');
  await send('Runtime.enable');
  return { send, close: () => ws.close() };
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} 超时 ${ms}ms`)), ms)),
  ]);
}

async function serviceWorkerEval(port, expr, ms = 6000) {
  const list = await withTimeout(fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()), 5000, 'json/list');
  const sw = list.find((t) => t.type === 'service_worker' && t.url.includes(EXT_ID));
  if (!sw) return null;
  const ws = new WebSocket(sw.webSocketDebuggerUrl);
  return await withTimeout(new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('service worker 求值超时')), 4000);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
    });
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === 1) {
        clearTimeout(timer);
        // 有异常时没有 result，把异常文本带回来，避免诊断静默丢失
        if (m.result && m.result.exceptionDetails) {
          resolve({ exceptionDetails: m.result.exceptionDetails });
        } else {
          resolve(m.result);
        }
      }
    });
    ws.addEventListener('error', (e) => { clearTimeout(timer); reject(new Error('ws error ' + (e && e.message || ''))); });
  }), ms, 'sw eval').finally(() => { try { ws.close(); } catch { /* ignore */ } });
}

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

async function waitCdp(port, logFile) {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return await r.json();
    } catch { /* 还没起来 */ }
    await sleep(150);
  }
  let tail = '';
  try { tail = fs.readFileSync(logFile, 'utf8').slice(-800); } catch { /* ignore */ }
  throw new Error(`浏览器 CDP 未就绪（端口 ${port}）${tail ? '：' + tail.replace(/\s+/g, ' ') : ''}`);
}

async function runTier(tier, runIdx) {
  setTier(tier);
  HITS.length = 0;
  try { fs.unlinkSync(path.join(DATA, 'sniff-probe.json')); } catch { /* ignore */ }
  const app = spawn(EXE, [], { env: { ...process.env, FW_SMOKE: '1', FW_SNIFF_PROBE: '1' }, stdio: 'ignore', windowsHide: true });
  progress(`tier ${tier}: app pid ${app.pid}`);
  await waitEndpoint(app.pid);
  progress(`tier ${tier}: endpoint ok`);

  const profile = path.join(process.env.TEMP || '.', `fw-ext-${tier}-${Date.now()}`);
  const port = await freePort();
  const logFile = path.join(process.env.TEMP || '.', `fw-edge-${tier}.log`);
  const logFd = fs.openSync(logFile, 'w');
  const msedge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    `--remote-debugging-port=${port}`, '--window-size=1280,800', PAGE_URL,
  ], { stdio: ['ignore', logFd, logFd], windowsHide: true });

  let shot = null;
  try {
    await waitCdp(port, logFile);
    progress(`tier ${tier}: cdp ${port} ready`);
    const page = await cdp(port, PAGE_URL);
    progress(`tier ${tier}: page attached`);
    await sleep(3000);
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

    const diag = await serviceWorkerEval(port, `(() => ({
      webReq: typeof chrome.webRequest === 'object' && chrome.webRequest.onHeadersReceived.hasListeners(),
      origin: self.location.origin,
    }))()`).catch((e) => ({ error: e.message }));
    const diagValue = diag && diag.result ? diag.result.value : null;
    progress(`tier ${tier}: sw=${JSON.stringify(diagValue)}`);

    // MV3 后台可能晚于首屏请求启动，此时首屏请求不会被观察到；
    // 在扩展确认就绪后再制造两条媒体请求，测量的是"就绪后"的命中能力。
    await page.send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        fetch('/api/stream.m3u8?after=' + Date.now());
        fetch('/movie.mp4?after=' + Date.now());
        return 0;
      })()`,
    });
    await sleep(1800);

    shot = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, `extension-bar-${tier}.png`), Buffer.from(shot.data, 'base64'));
    const natural = (await page.send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const h = document.getElementById('fetchweir-bar-host');
        return { host: !!h, display: h ? getComputedStyle(h).display : null };
      })()`,
    })).result.value;
    page.close();
    progress(`tier ${tier}: natural bar=${JSON.stringify(natural)}`);

    const badge = await serviceWorkerEval(port, `(async () => {
      const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
      const txt = await chrome.action.getBadgeText({tabId: tab ? tab.id : -1});
      return {tabId: tab ? tab.id : -1, badge: txt};
    })()`).catch(() => null);
    const badgeText = badge && badge.result && badge.result.value ? badge.result.value.badge : null;

    // 手动下发一条候选，只用于截取"命中后的浮动条外观"，结论仍以自然命中为准
    await serviceWorkerEval(port, `(async () => {
      const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.tabs.sendMessage(t.id, { type: 'fw:media', items: [{ url: 'http://127.0.0.1/fake.mp4', kind: 'video', mime: 'video/mp4', size: 1024 }] });
      return 'sent';
    })()`).catch(() => null);
    await sleep(600);
    let manualBar = null;
    try {
      const page2 = await cdp(port, PAGE_URL);
      const afterManual = await page2.send('Runtime.evaluate', {
        returnByValue: true,
        expression: `(() => {
          const h = document.getElementById('fetchweir-bar-host');
          return h ? { display: getComputedStyle(h).display } : null;
        })()`,
      });
      manualBar = afterManual.result.value;
      if (tier !== 'C') {
        const shot2 = await page2.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(SHOTS, `extension-bar-${tier}-hit.png`), Buffer.from(shot2.data, 'base64'));
      }
      page2.close();
    } catch (e) {
      manualBar = { error: e.message };
    }

    const items = readSniff();
    const media = items.filter((x) => x.url.includes('/movie.mp4'));
    const hls = items.filter((x) => x.url.includes('stream.m3u8'));
    const status = await serviceWorkerEval(port, `(async () => {
      try {
        const p = chrome.runtime.connectNative('dev.fetchweir.nmh');
        const item = {
          url: 'http://127.0.0.1/native-probe.mp4', pageUrl: 'http://127.0.0.1/',
          pageTitle: 'native probe', browser: 'Edge', kind: 'video', mime: 'video/mp4',
          size: 4096, ranges: true, drmSuspect: false, note: '', disposition: '',
          cookie: '', referer: '', ua: 'ua', tabId: 1, source: 'probe', at: Date.now(), hits: 1,
        };
        const outcome = await new Promise((resolve) => {
          p.onMessage.addListener((m) => { resolve('msg:' + JSON.stringify(m)); });
          p.onDisconnect.addListener(() => {
            resolve('disconnect:' + ((chrome.runtime.lastError && chrome.runtime.lastError.message) || 'no-error'));
          });
          p.postMessage({ type: 'sniff', item });
          setTimeout(() => resolve('no-reply'), 4000);
        });
        return outcome;
      } catch (e) { return 'throw:' + (e && e.message ? e.message : String(e)); }
    })()`, 9000).catch(() => null);
    const statusValue = status ? (status.result ? status.result.value : status.exceptionDetails) : null;
    await sleep(1200);
    const nativeItem = readSniff().filter((x) => x.url.includes('native-probe'));
    let hostLines = [];
    try {
      const out = execFileSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"name='fetchweir.exe'\" | Select-Object -ExpandProperty CommandLine"], { encoding: 'utf8', timeout: 20000 });
      hostLines = out.split(/\r?\n/).filter(Boolean);
    } catch (e) { hostLines = ['查询失败 ' + e.message]; }
    progress(`tier ${tier}: native probe received=${nativeItem.length} status=${JSON.stringify(statusValue)}`);
    progress(`tier ${tier}: fetchweir 进程 ${hostLines.join(' || ') || '无'}`);
    const detail = JSON.stringify({ natural, badge: badgeText, media: media.length, hls: hls.length, diag: diagValue, manual: manualBar, status: statusValue, nativeProbe: nativeItem.length, hits: HITS });

    if (media.length >= 1 && hls.length >= 1) ok(`档位 ${tier}：网络层嗅探`, detail);
    else bad(`档位 ${tier}：网络层嗅探`, detail);

    if (tier === 'A' || tier === 'B') {
      if (natural && natural.host && natural.display !== 'none') ok(`档位 ${tier}：浮动条命中`, detail);
      else bad(`档位 ${tier}：浮动条命中`, detail);
      if (badgeText && badgeText !== '') ok(`档位 ${tier}：徽标计数`, `badge=${badgeText}`);
      else bad(`档位 ${tier}：徽标计数`, detail);
    } else {
      if (!natural || !natural.host || natural.display === 'none') ok('档位 C：不出条', detail);
      else bad('档位 C：不出条', detail);
      if (badgeText && badgeText !== '') ok('档位 C：徽标仍计数', `badge=${badgeText}`);
      else bad('档位 C：徽标仍计数', detail);
    }
  } catch (e) {
    bad(`档位 ${tier} 异常`, e.message);
  } finally {
    // 浏览器会拉起 --nm-host 子进程，必须整树结束，否则残留宿主会占着端点。
    for (const p of [msedge, app]) {
      if (!p || p.exitCode !== null) continue;
      try { spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
    }
    try { fs.closeSync(logFd); } catch { /* ignore */ }
    await sleep(800);
  }
}

try {
  fs.writeFileSync(path.join(process.env.TEMP || '.', 'fw-browser-progress.log'), '');
} catch { /* ignore */ }
const TIERS = (process.env.FW_TIERS || 'ABC').split('').filter((c) => 'ABC'.includes(c));
try {
  for (let i = 0; i < TIERS.length; i++) {
    progress(`start tier ${TIERS[i]}`);
    await runTier(TIERS[i], i);
    progress(`done tier ${TIERS[i]}`);
  }
} finally {
  server.close();
  setTier('B');
}

progress('all tiers done');

const failed = results.filter((r) => !r.pass);
console.log(JSON.stringify({ results, pass: failed.length === 0, shots: SHOTS }, null, 2));
// 有残留句柄（taskkill 子进程、HTTP keep-alive）时 node 不会自动退出，显式收尾。
process.exit(failed.length === 0 ? 0 : 1);
