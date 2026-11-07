// 端到端验收：真实 Chromium 加载扩展 → 浮动条出现 → 点击「在 Fetchweir 中打开」→ 桌面端窗口被唤起。
// 用法：node tools/Test-FwExtActivate.mjs <Fetchweir.exe>
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
const DATA = path.join(process.env.APPDATA || os.homedir(), 'Fetchweir');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (n, d) => results.push({ name: n, pass: true, detail: d });
const bad = (n, d) => results.push({ name: n, pass: false, detail: d });

const MP4 = Buffer.alloc(4096, 1);
const PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>扩展唤起验证</title></head>
<body style="background:#0f1117;color:#e8ecf5;font:15px system-ui;padding:32px">
<h1>扩展唤起验证页</h1><video src="/movie.mp4" autoplay muted></video></body></html>`;
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(PAGE); }
  if (u === '/movie.mp4') {
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(MP4.length), 'accept-ranges': 'bytes' });
    return res.end(MP4);
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PAGE_URL = `http://127.0.0.1:${server.address().port}/`;

function ps(script) {
  return execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 30000 }).trim();
}
const WIN_HEAD = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class FW {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
`;
function winHandle(pid) {
  return ps(`${WIN_HEAD}
$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
if (-not $p) { '0' } else { $p.MainWindowHandle.ToString() }`);
}
function winState(pid) {
  const raw = ps(`${WIN_HEAD}
$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
if (-not $p) { '{"ok":false}' ; exit }
$h = $p.MainWindowHandle
if ($h -eq 0) { '{"ok":false,"why":"no-handle"}'; exit }
$fg = [FW]::GetForegroundWindow()
'{"ok":true,"hwnd":' + $h.ToString() + ',"iconic":' + [FW]::IsIconic($h).ToString().ToLower() + ',"visible":' + [FW]::IsWindowVisible($h).ToString().ToLower() + ',"foreground":' + ($fg -eq $h).ToString().ToLower() + '}'`);
  return JSON.parse(raw);
}
function minimize(pid) {
  return ps(`${WIN_HEAD}
$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
if ($p -and $p.MainWindowHandle -ne 0) { [FW]::ShowWindow($p.MainWindowHandle, 6) | Out-Null; 'ok' } else { 'no' }`);
}
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function waitEndpoint(pid) {
  for (let i = 0; i < 150; i++) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(DATA, 'nm-endpoint.json'), 'utf8'));
      if (j.port > 0 && j.pid === pid) {
        const good = await new Promise((resolve) => {
          const s = net.connect(j.port, '127.0.0.1', () => { s.end(); resolve(true); });
          s.on('error', () => resolve(false));
        });
        if (good) return j;
      }
    } catch { /* 未就绪 */ }
    await sleep(120);
  }
  throw new Error('主进程 NM 端点未就绪');
}

async function cdp(port) {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const t = list.find((x) => x.type === 'page' && x.url.startsWith(PAGE_URL));
      if (t) {
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        const pending = new Map();
        let seq = 1;
        await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
        ws.addEventListener('message', (ev) => {
          const m = JSON.parse(ev.data);
          if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
        });
        const send = (method, params = {}) => new Promise((resolve, reject) => {
          const id = seq++;
          pending.set(id, { resolve, reject });
          ws.send(JSON.stringify({ id, method, params }));
        });
        return { send, close: () => ws.close() };
      }
    } catch { /* 未就绪 */ }
    await sleep(150);
  }
  throw new Error('浏览器 CDP 未就绪');
}

// 浮动条在 closed shadow root 里：用 CDP DOM 树（pierce）找到按钮并取坐标，再用真实鼠标事件点击。
async function clickBarOpen(page) {
  await page.send('DOM.enable');
  const doc = await page.send('DOM.getDocument', { depth: -1, pierce: true });
  const targets = [];
  const walk = (n) => {
    if (!n) return;
    if (n.nodeName === 'BUTTON') targets.push(n);
    (n.children || []).forEach(walk);
    (n.shadowRoots || []).forEach(walk);
    if (n.contentDocument) walk(n.contentDocument);
  };
  walk(doc.root);
  const want = targets.find((b) => (b.children || []).some((c) => (c.nodeValue || '').includes('在 Fetchweir 中打开')));
  if (!want) throw new Error(`未找到浮动条按钮（共 ${targets.length} 个按钮）`);
  const box = await page.send('DOM.getBoxModel', { backendNodeId: want.backendNodeId });
  const q = box.model.border;
  const x = (q[0] + q[2] + q[4] + q[6]) / 4;
  const y = (q[1] + q[3] + q[5] + q[7]) / 4;
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  return { x: Math.round(x), y: Math.round(y), buttons: targets.length };
}

const app = spawn(EXE, [], { env: { ...process.env, FW_SMOKE: '1', FW_SNIFF_PROBE: '1' }, stdio: 'ignore', windowsHide: true });
let edge = null;
try {
  await waitEndpoint(app.pid);
  for (let i = 0; i < 60 && winHandle(app.pid) === '0'; i++) await sleep(200);
  const hwnd = winHandle(app.pid);
  if (hwnd !== '0') ok('桌面端窗口已创建', `hwnd=${hwnd}`);
  else bad('桌面端窗口已创建', '未取到主窗口句柄');

  const profile = path.join(process.env.TEMP || '.', `fw-act-${Date.now()}`);
  const port = await freePort();
  const logFile = path.join(process.env.TEMP || '.', 'fw-act-edge.log');
  const fd = fs.openSync(logFile, 'w');
  edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    `--remote-debugging-port=${port}`, '--window-size=1280,800', PAGE_URL,
  ], { stdio: ['ignore', fd, fd], windowsHide: true });

  const page = await cdp(port);
  await sleep(3500);
  // 触发一次媒体请求，让扩展自然命中
  await page.send('Runtime.evaluate', { returnByValue: true, expression: "fetch('/movie.mp4?act=' + Date.now()); 0" });
  await sleep(1800);
  const bar = (await page.send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => { const h = document.getElementById('fetchweir-bar-host'); return { host: !!h, display: h ? getComputedStyle(h).display : null }; })()`,
  })).result.value;
  if (bar && bar.host && bar.display !== 'none') ok('浮动条出现', JSON.stringify(bar));
  else bad('浮动条出现', JSON.stringify(bar));

  const min = minimize(app.pid);
  await sleep(700);
  const before = winState(app.pid);
  if (before.ok && before.iconic) ok('点击前窗口已最小化', JSON.stringify(before));
  else bad('点击前窗口已最小化', `${min} ${JSON.stringify(before)}`);

  const clickAt = await clickBarOpen(page);
  await sleep(1800);
  const after = winState(app.pid);
  if (after.ok && !after.iconic && after.visible) ok('点击浮动条唤起应用', `click@${clickAt.x},${clickAt.y} ${JSON.stringify(after)}`);
  else bad('点击浮动条唤起应用', `${JSON.stringify(clickAt)} ${JSON.stringify(after)}`);
  if (after.ok && after.foreground) ok('窗口回到前台', JSON.stringify(after));
  else bad('窗口回到前台', JSON.stringify(after));
  page.close();
} catch (e) {
  bad('执行异常', e.message);
} finally {
  try { if (edge) execFileSync('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
  try { execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
  server.close();
}

const passed = results.filter((r) => r.pass).length;
console.log(JSON.stringify({ passed, total: results.length, results }, null, 2));
const outDir = path.join(ROOT, 'docs', 'evidence');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'ext-activate.json'), JSON.stringify({ passed, total: results.length, results }, null, 2));
process.exit(passed === results.length ? 0 : 1);
