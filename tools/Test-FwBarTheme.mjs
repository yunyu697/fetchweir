// 真实浏览器验证：扩展悬浮条跟随应用颜色主题。
// 应用侧通过 WebView2 远程调试真实点击主题/配色按钮（不是直接改文件），
// 浏览器侧用 CDP 穿透 closed shadow DOM 读取悬浮条的计算样式并截图。
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXE = process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'target', 'debug', 'fetchweir.exe');
const EDGE = process.env.FW_EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const DATA = path.join(process.env.APPDATA || process.env.LOCALAPPDATA || os.homedir(), 'Fetchweir');
const SHOTS = path.join(ROOT, 'docs', 'ui-shots');
const EXT_ID = 'fjngndhalbkfkfcfhleflcgkicknkele';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (name, detail) => results.push({ name, pass: true, detail });
const bad = (name, detail) => results.push({ name, pass: false, detail });
fs.mkdirSync(SHOTS, { recursive: true });

const TOKENS = {
  bg: '--panel', bg2: '--panel-2', bg3: '--panel-3', line: '--line',
  fg: '--fg', fg2: '--fg-2', fg3: '--fg-3', accent: '--accent',
  accentSolid: '--accent-solid', accentSolid2: '--accent-solid-2', accentFg: '--accent-fg',
};

const PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>悬浮条主题验证</title>
<style>body{background:#0f1117;color:#e8ecf5;font:15px system-ui;margin:0;padding:32px}
.box{max-width:720px;margin:0 auto}h1{font-size:20px}video{width:100%;border-radius:12px;background:#000}</style></head>
<body><div class="box"><h1>悬浮条主题验证页</h1>
<video id="v" src="/movie.mp4" controls preload="auto" autoplay muted></video>
<p>这一页有视频，应当出现悬浮条。</p></div>
<script>document.getElementById('v').play().catch(()=>{});</script></body></html>`;

const PLAIN = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>无媒体页</title></head>
<body style="background:#fff;color:#111;font:16px system-ui;padding:40px"><h1>没有视频的页面</h1>
<p>这里不应该出现悬浮条。</p></body></html>`;

const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/' ) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(PAGE); }
  if (u === '/plain') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(PLAIN); }
  if (u === '/movie.mp4') {
    const buf = Buffer.alloc(64 * 1024, 1);
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      const start = m ? Number(m[1]) : 0;
      const end = m && m[2] ? Number(m[2]) : buf.length - 1;
      res.writeHead(206, {
        'content-type': 'video/mp4', 'content-length': String(end - start + 1),
        'content-range': `bytes ${start}-${end}/${buf.length}`, 'accept-ranges': 'bytes',
      });
      return res.end(buf.subarray(start, end + 1));
    }
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(buf.length), 'accept-ranges': 'bytes' });
    return res.end(buf);
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PAGE_URL = `http://127.0.0.1:${server.address().port}/`;
const PLAIN_URL = `${PAGE_URL}plain`;

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}

async function waitCdp(port, label, tries = 160) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (r.ok) return await r.json();
    } catch { /* 还没起来 */ }
    await sleep(150);
  }
  throw new Error(`${label} CDP 未就绪（端口 ${port}）`);
}

async function connect(target, isPage = true) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let seq = 1;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = seq++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} 超时`)); }, 15000);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
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
  if (isPage) await send('Page.enable');
  await send('Runtime.enable');
  return { send, close: () => ws.close() };
}

async function attachPage(port, hint) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = list.find((t) => t.type === 'page' && hint && t.url.startsWith(hint))
    || list.find((t) => t.type === 'page');
  if (!target) throw new Error(`找不到页面目标：${list.map((t) => `${t.type}:${t.url}`).join(' | ')}`);
  return connect(target);
}

async function attachApp(port) {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const target = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'));
      if (target) return await connect(target);
    } catch { /* 还没起来 */ }
    await sleep(150);
  }
  throw new Error('应用 WebView2 调试目标未就绪');
}

async function evalIn(conn, expression, awaitPromise = false) {
  const out = await conn.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (out.exceptionDetails) {
    throw new Error(out.exceptionDetails.exception && out.exceptionDetails.exception.description || out.exceptionDetails.text);
  }
  return out.result.value;
}

async function serviceWorkerEval(port, expr) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const sw = list.find((t) => t.type === 'service_worker' && t.url.includes(EXT_ID));
  if (!sw) throw new Error('service worker 目标不存在：' + list.map((t) => `${t.type}:${t.url}`).join(' | '));
  const conn = await connect(sw, false);
  try {
    return await evalIn(conn, expr, true);
  } finally {
    conn.close();
  }
}

async function pushMedia(port, items) {
  const expr = `(async () => {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.sendMessage(t.id, { type: 'fw:media', items: ${JSON.stringify(items)} });
    return t.id;
  })()`;
  let last = '';
  for (let i = 0; i < 40; i++) {
    let out = null;
    try {
      out = await serviceWorkerEval(port, expr);
    } catch (e) {
      last = e && e.message || String(e);
    }
    if (out != null) return out;
    await sleep(200);
  }
  throw new Error(`扩展后台未就绪：${last}`);
}

function walk(node, pred, out = []) {
  if (!node) return out;
  if (pred(node)) out.push(node);
  for (const c of node.children || []) walk(c, pred, out);
  for (const s of node.shadowRoots || []) walk(s, pred, out);
  return out;
}

function attr(node, name) {
  const a = node.attributes || [];
  for (let i = 0; i < a.length; i += 2) if (a[i] === name) return a[i + 1];
  return null;
}

async function readBar(page) {
  const doc = await page.send('DOM.getDocument', { depth: -1, pierce: true });
  const host = walk(doc.root, (n) => attr(n, 'id') === 'fetchweir-bar-host')[0];
  if (!host) return null;
  const panel = walk(host, (n) => (attr(n, 'class') || '').split(/\s+/).includes('panel'))[0];
  if (!panel) return null;
  const byClass = (cls) => walk(host, (n) => (attr(n, 'class') || '').split(/\s+/).includes(cls));
  const title = byClass('title')[0];
  const b = title ? walk(title, (n) => n.nodeName === 'B')[0] : null;
  const span = title ? walk(title, (n) => n.nodeName === 'SPAN')[0] : null;
  const rows = byClass('row');
  const gets = byClass('get');
  const styles = {};
  const styleOf = async (node, key) => {
    if (!node) return;
    const cs = await page.send('CSS.getComputedStyleForNode', { nodeId: node.nodeId });
    const map = Object.fromEntries(cs.computedStyle.map((s) => [s.name, s.value]));
    styles[key] = { color: map.color, background: map['background-color'] };
  };
  await page.send('CSS.enable');
  await styleOf(panel, 'panel');
  await styleOf(b, 'title');
  await styleOf(span, 'subtitle');
  await styleOf(rows[0], 'row');
  await styleOf(byClass('sub')[0], 'rowSub');
  await styleOf(byClass('name')[0], 'rowName');
  await styleOf(byClass('hint')[0], 'hint');
  await styleOf(gets[0], 'get');
  await styleOf(gets[1], 'getDisabled');
  await styleOf(byClass('ico')[0], 'ico');
  const display = await evalIn(page, `(() => {
    const h = document.getElementById('fetchweir-bar-host');
    return h ? getComputedStyle(h).display : null;
  })()`);
  return { display, rows: rows.length, style: styles };
}

/* ---------- 颜色与对比度 ---------- */
function parseColor(v) {
  if (!v) return null;
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/i.exec(v);
  if (!m) return null;
  return { r: +m[1], g: +m[2], b: +m[3], a: m[4] == null ? 1 : +m[4] };
}
function hexToRgb(hex) {
  const h = hex.replace('#', '').trim();
  if (h.length === 3) return { r: parseInt(h[0] + h[0], 16), g: parseInt(h[1] + h[1], 16), b: parseInt(h[2] + h[2], 16), a: 1 };
  if (h.length < 6) return null;
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
}
const lum = (c) => {
  const f = (x) => { const s = x / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
};
function contrast(fg, bg) {
  if (!fg || !bg) return null;
  const a = lum(fg), b = lum(bg);
  return +(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2));
}
function rgbText(c) { return `rgb(${c.r}, ${c.g}, ${c.b})`; }

async function appTokens(app) {
  return evalIn(app, `(() => {
    const cs = getComputedStyle(document.documentElement);
    const names = ${JSON.stringify(TOKENS)};
    const out = { theme: document.documentElement.dataset.theme, color: document.documentElement.dataset.color };
    for (const [k, n] of Object.entries(names)) out[k] = cs.getPropertyValue(n).trim();
    return out;
  })()`);
}

async function clickTheme(app, color, theme) {
  const applied = await evalIn(app, `(() => {
    const c = document.querySelector('[data-color-set="${color}"]');
    const t = document.querySelector('[data-theme-set="${theme}"]');
    if (!c || !t) return { ok: false, why: '按钮不存在' };
    t.click(); c.click();
    return { ok: true, theme: document.documentElement.dataset.theme, color: document.documentElement.dataset.color };
  })()`);
  if (!applied.ok) throw new Error(`应用内切换主题失败：${applied.why}`);
  // 等前端 60ms 合并 + 宿主 700ms 轮询 + 广播落到悬浮条
  const token = await appTokens(app);
  const want = hexToRgb(token.bg2);
  let last = null;
  for (let i = 0; i < 60; i++) {
    const bar = await readBar(barPage);
    last = bar;
    const rowBg = bar && bar.style.row && parseColor(bar.style.row.background);
    if (rowBg && want && Math.abs(rowBg.r - want.r) + Math.abs(rowBg.g - want.g) + Math.abs(rowBg.b - want.b) === 0) {
      // 刚命中时上一次读取可能横跨换色瞬间，等一帧再取一次一致的快照。
      await sleep(150);
      return { token, bar: await readBar(barPage) };
    }
    await sleep(150);
  }
  let file = null;
  try { file = JSON.parse(fs.readFileSync(path.join(DATA, 'bar-theme.json'), 'utf8')); } catch { /* ignore */ }
  const pageHost = await evalIn(barPage, `(() => {
    const h = document.getElementById('fetchweir-bar-host');
    return h ? { present: true, display: getComputedStyle(h).display } : { present: false };
  })()`).catch((e) => ({ error: e.message }));
  throw new Error(`悬浮条未在 9s 内跟随 ${theme}/${color}；token=${JSON.stringify(token)}；file=${JSON.stringify(file)}；host=${JSON.stringify(pageHost)}；bar=${JSON.stringify(last)}`);
}

/* ---------- 启动应用 ---------- */
function setSettings(patch) {
  const file = path.join(DATA, 'settings.json');
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 首次 */ }
  fs.writeFileSync(file, JSON.stringify({ ...cur, ...patch }, null, 2));
}

let app = null;
let edge = null;
let barPage = null;
let appConn = null;
const appPort = await freePort();
const port = await freePort();

try {
  setSettings({ sniffTier: 'B', theme: 'dark', colorTheme: 'violet' });
  const appArgs = { ...process.env, FW_SMOKE: '1', WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${appPort}` };
  app = spawn(EXE, [], { env: appArgs, stdio: 'ignore', windowsHide: true });
  appConn = await attachApp(appPort);
  // 等设置加载完成（颜色卡片出现 on）
  for (let i = 0; i < 80; i++) {
    const ready = await evalIn(appConn, `!!document.querySelector('[data-color-set].on')`);
    if (ready) break;
    await sleep(150);
  }

  const profile = path.join(process.env.TEMP || '.', `fw-bar-theme-${Date.now()}`);
  edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    `--remote-debugging-port=${port}`, '--window-size=1280,800', PAGE_URL,
  ], { stdio: 'ignore', windowsHide: true });
  await waitCdp(port, 'Edge');
  barPage = await attachPage(port, PAGE_URL);
  await barPage.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(2500);

  // 手动下发两条候选：一条普通视频、一条 DRM（用于核对禁用按钮对比度）
  const pushed = await pushMedia(port, [
    { url: 'http://127.0.0.1/media/episode-01.mp4', kind: 'video', mime: 'video/mp4', size: 734003200 },
    { url: 'http://127.0.0.1/media/protected-show.mp4', kind: 'video', mime: 'video/mp4', size: 0, drmSuspect: true },
  ]);
  if (pushed == null) throw new Error('扩展后台未就绪，无法下发候选');
  await sleep(1200);

  const combos = [
    ['dark', 'violet'], ['light', 'violet'],
    ['dark', 'azure'], ['light', 'azure'],
    ['dark', 'emerald'], ['light', 'emerald'],
    ['dark', 'amber'], ['light', 'amber'],
  ];

  for (const [theme, color] of combos) {
    const { token, bar } = await clickTheme(appConn, color, theme);
    const shot = await barPage.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(SHOTS, `extension-bar-theme-${theme}-${color}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));

    const panel = parseColor(bar.style.panel.background);
    const row = parseColor(bar.style.row.background);
    const btn = parseColor(bar.style.get.background);
    const titleFg = parseColor(bar.style.title.color);
    const subFg = parseColor(bar.style.rowSub.color);
    const beats = {
      panel: panel && token.bg && rgbText(panel) === rgbText(hexToRgb(token.bg)),
      row: row && token.bg2 && rgbText(row) === rgbText(hexToRgb(token.bg2)),
      button: btn && token.accentSolid && rgbText(btn) === rgbText(hexToRgb(token.accentSolid)),
      title: titleFg && token.fg && rgbText(titleFg) === rgbText(hexToRgb(token.fg)),
      sub: subFg && token.fg2 && rgbText(subFg) === rgbText(hexToRgb(token.fg2)),
    };
    // 悬浮条颜色 / 所在底色
    const pairs = [
      ['标题', bar.style.title.color, bar.style.panel.background, 4.5],
      ['标题栏站点名', bar.style.subtitle.color, bar.style.panel.background, 4.5],
      ['资源名', bar.style.rowName.color, bar.style.row.background, 4.5],
      ['资源副信息', bar.style.rowSub.color, bar.style.row.background, 4.5],
      ['底部提示', bar.style.hint.color, bar.style.panel.background, 4.5],
      ['主按钮', bar.style.get.color, bar.style.get.background, 4.5],
      ['类型徽标', bar.style.ico.color, bar.style.ico.background, 4.5],
      ['禁用按钮（豁免项，仅要求可读）', bar.style.getDisabled.color, bar.style.getDisabled.background, 3.0],
    ].map(([name, fg, bg, need]) => {
      const ratio = contrast(parseColor(fg), parseColor(bg));
      return { name, ratio, need, pass: ratio != null && ratio >= need };
    });

    const themeOk = Object.values(beats).every(Boolean);
    if (themeOk) ok(`${theme}/${color}：悬浮条使用应用 token`, beats);
    else bad(`${theme}/${color}：悬浮条未使用应用 token`, { beats, token, panel: bar.style.panel, row: bar.style.row });
    const low = pairs.filter((p) => !p.pass);
    if (low.length === 0) ok(`${theme}/${color}：对比度`, pairs);
    else bad(`${theme}/${color}：对比度不足`, low);
  }

  // 换主题不刷新页面：记录 timeOrigin，切主题后必须不变
  await evalIn(appConn, `document.querySelector('[data-theme-set="dark"]').click(); document.querySelector('[data-color-set="violet"]').click(); true`);
  await sleep(2200);
  const before = {
    timeOrigin: await evalIn(barPage, 'performance.timeOrigin'),
    nav: await evalIn(barPage, `performance.getEntriesByType('navigation').length`),
    href: await evalIn(barPage, 'location.href'),
    button: (await readBar(barPage)).style.get.background,
  };
  const { bar: liveBar } = await clickTheme(appConn, 'azure', 'light');
  const after = {
    timeOrigin: await evalIn(barPage, 'performance.timeOrigin'),
    nav: await evalIn(barPage, `performance.getEntriesByType('navigation').length`),
    href: await evalIn(barPage, 'location.href'),
    button: liveBar.style.get.background,
  };
  const liveShot = await barPage.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOTS, 'extension-bar-theme-live-update.png'), Buffer.from(liveShot.data, 'base64'));
  const noReload = before.timeOrigin === after.timeOrigin && before.nav === after.nav && before.href === after.href;
  const changed = before.button !== after.button;
  if (noReload && changed) ok('应用换主题后悬浮条实时更新（未刷新页面）', { before, after });
  else bad('应用换主题后悬浮条实时更新（未刷新页面）', { before, after, noReload, changed });

  // 非视频页不出条
  const plainList = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const plainTarget = plainList.find((t) => t.type === 'page' && t.url.startsWith(PLAIN_URL));
  const plainPage = plainTarget ? await connect(plainTarget) : null;
  if (!plainPage) {
    await barPage.send('Page.navigate', { url: PLAIN_URL });
    await sleep(2500);
  } else {
    await sleep(2000);
  }
  const plainBar = await evalIn(plainPage || barPage, `(() => {
    const h = document.getElementById('fetchweir-bar-host');
    return h ? { present: true, display: getComputedStyle(h).display } : { present: false, display: null };
  })()`);
  if (!plainBar.present || plainBar.display === 'none') ok('非视频页不出悬浮条', plainBar);
  else bad('非视频页误显示悬浮条', plainBar);
  if (plainPage) plainPage.close();

  // 中性回退：没有应用在跑、也没有缓存主题时，首帧就应是深灰中性，不浅底浅字
  try { fs.renameSync(path.join(DATA, 'bar-theme.json'), path.join(DATA, 'bar-theme.json.bak')); } catch { /* 可能不存在 */ }
  for (const p of [edge]) { if (p && p.exitCode === null) { try { spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ } } }
  await sleep(1200);

  const profile2 = path.join(process.env.TEMP || '.', `fw-bar-neutral-${Date.now()}`);
  const port2 = await freePort();
  const edge2 = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile2}`,
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    `--remote-debugging-port=${port2}`, '--window-size=1280,800', PAGE_URL,
  ], { stdio: 'ignore', windowsHide: true });
  try {
    await waitCdp(port2, 'Edge(neutral)');
    const page2 = await attachPage(port2, PAGE_URL);
    await page2.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(2000);
    const pushed2 = await pushMedia(port2, [
      { url: 'http://127.0.0.1/media/episode-01.mp4', kind: 'video', mime: 'video/mp4', size: 1024 },
    ]);
    if (pushed2 == null) throw new Error('中性回退：扩展后台未就绪');
    await sleep(1800);
    const neutralBar = await readBar(page2);
    const neutralShot = await page2.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, 'extension-bar-theme-neutral.png'), Buffer.from(neutralShot.data, 'base64'));
    const panel = parseColor(neutralBar.style.panel.background);
    const title = parseColor(neutralBar.style.title.color);
    const neutralOk = panel && rgbText(panel) === 'rgb(30, 30, 35)' && title && rgbText(title) === 'rgb(242, 242, 244)';
    const neutralPairs = [
      ['标题', neutralBar.style.title.color, neutralBar.style.panel.background, 4.5],
      ['副信息', neutralBar.style.rowSub.color, neutralBar.style.row.background, 4.5],
      ['主按钮', neutralBar.style.get.color, neutralBar.style.get.background, 4.5],
    ].map(([name, fg, bg, need]) => ({ name, ratio: contrast(parseColor(fg), parseColor(bg)), need }));
    if (neutralOk && neutralPairs.every((p) => p.ratio >= p.need)) ok('中性回退（无应用时）', { panel: neutralBar.style.panel.background, pairs: neutralPairs });
    else bad('中性回退不符预期', { panel: neutralBar.style.panel.background, pairs: neutralPairs });
    page2.close();
  } finally {
    if (edge2.exitCode === null) { try { spawn('taskkill', ['/PID', String(edge2.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ } }
    try { fs.renameSync(path.join(DATA, 'bar-theme.json.bak'), path.join(DATA, 'bar-theme.json')); } catch { /* ignore */ }
  }

} catch (e) {
  bad('验证脚本异常', e && e.stack || String(e));
} finally {
  server.close();
  if (barPage) barPage.close();
  if (appConn) appConn.close();
  for (const p of [edge, app]) {
    if (!p || p.exitCode !== null) continue;
    try { spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
  }
  await sleep(800);
}

const failed = results.filter((r) => !r.pass);
const payload = { pass: failed.length === 0, results };
fs.writeFileSync(path.join(SHOTS, 'extension-bar-theme-result.json'), JSON.stringify(payload, null, 2));
console.log(JSON.stringify(payload, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
