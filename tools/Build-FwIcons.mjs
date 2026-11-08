// 图标构建：用无头 Edge 把 SVG 按精确像素渲染成 PNG，再合成 .ico / .icns。
// 全程离屏，不占前台。
// 用法：node tools/Build-FwIcons.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = process.env.FW_EDGE_PATH
  || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = path.join(ROOT, 'assets', 'icon');
const SRC = path.join(OUT, 'png');
const TAURI = path.join(ROOT, 'src-tauri', 'icons');
const EXT = path.join(ROOT, 'extension', 'icons');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 品牌源稿：亮色版用于程序图标（exe/安装包/快捷方式/托盘），亮暗两版供界面按主题取用。
const LIGHT = path.join(ROOT, 'src', 'assets', 'brand-light.svg');
const SMALL = path.join(ROOT, 'src', 'assets', 'brand-light-small.svg');

/** 渲染任务：小尺寸改用简化稿（加粗笔画），保证 16px 下仍有两个独立形状 */
function jobs() {
  const list = [];
  const small = new Set([16, 20, 24]);
  for (const size of [1024, 512, 310, 284, 256, 150, 142, 128, 107, 89, 71, 64, 50, 48, 44, 32, 30, 24, 20, 16]) {
    list.push({ svg: small.has(size) ? SMALL : LIGHT, size, out: `color-${size}.png` });
  }
  return list;
}

async function render() {
  fs.mkdirSync(SRC, { recursive: true });
  const port = 9500 + Math.floor(Math.random() * 40);
  const profile = path.join(process.env.TEMP || '.', `fw-icon-${port}`);
  const browser = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--window-size=1024,1024',
    '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: 'ignore' });

  const waitFor = async (fn, timeout = 15000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try { const v = await fn(); if (v) return v; } catch { /* retry */ }
      await sleep(150);
    }
    throw new Error('等待无头浏览器超时');
  };

  const version = await waitFor(async () => {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`);
    return r.ok ? r.json() : null;
  });
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let seq = 1;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = seq++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
  });
  await send('Page.enable');
  await send('Emulation.setScrollbarsHidden', { hidden: true });

  for (const job of jobs()) {
    const svg = fs.readFileSync(job.svg, 'utf8');
    const html = `<!doctype html><style>html,body{margin:0;padding:0;overflow:hidden;background:transparent}
      svg{display:block;width:100vw;height:100vh}</style>${svg}`;
    await send('Emulation.setDeviceMetricsOverride', {
      width: job.size, height: job.size, deviceScaleFactor: 1, mobile: false,
    });
    // 圆角外保持透明：Windows / macOS / Linux 都按桌面背景自然融合。
    await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    await send('Page.navigate', { url: 'data:text/html;base64,' + Buffer.from(html).toString('base64') });
    await sleep(120);
    const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
    fs.writeFileSync(path.join(SRC, job.out), Buffer.from(shot.data, 'base64'));
  }
  ws.close();
  setTimeout(() => browser.kill(), 200);
}

/* ---------- ICO ---------- */
function buildIco(sizes, outFile) {
  const pngs = sizes.map((s) => fs.readFileSync(path.join(SRC, `color-${s}.png`)));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  const entries = [];
  let offset = 6 + 16 * sizes.length;
  sizes.forEach((s, i) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(s >= 256 ? 0 : s, 0);
    e.writeUInt8(s >= 256 ? 0 : s, 1);
    e.writeUInt8(0, 2); e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(pngs[i].length, 8);
    e.writeUInt32LE(offset, 12);
    offset += pngs[i].length;
    entries.push(e);
  });
  fs.writeFileSync(outFile, Buffer.concat([header, ...entries, ...pngs]));
}

/* ---------- ICNS ---------- */
function buildIcns(outFile) {
  const parts = [
    ['ic11', 32], ['ic12', 64], ['ic07', 128], ['ic08', 256], ['ic13', 256], ['ic09', 512], ['ic10', 1024],
  ];
  const chunks = [];
  for (const [type, size] of parts) {
    const png = fs.readFileSync(path.join(SRC, `color-${size}.png`));
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(png.length + 8, 4);
    chunks.push(Buffer.concat([head, png]));
  }
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  fs.writeFileSync(outFile, Buffer.concat([head, body]));
}

/* ---------- 落盘 ---------- */
function copy(src, destDir, destName) {
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(path.join(SRC, src), path.join(destDir, destName));
}

function install() {
  fs.mkdirSync(TAURI, { recursive: true });
  fs.mkdirSync(EXT, { recursive: true });
  copy('color-512.png', TAURI, 'icon.png');
  copy('color-128.png', TAURI, '128x128.png');
  copy('color-256.png', TAURI, '128x128@2x.png');
  copy('color-32.png', TAURI, '32x32.png');
  buildIco([16, 20, 24, 32, 48, 64, 128, 256], path.join(TAURI, 'icon.ico'));
  buildIcns(path.join(TAURI, 'icon.icns'));
  for (const [name, size] of [
    ['Square30x30Logo.png', 30], ['Square44x44Logo.png', 44], ['Square71x71Logo.png', 71],
    ['Square89x89Logo.png', 89], ['Square107x107Logo.png', 107], ['Square142x142Logo.png', 142],
    ['Square150x150Logo.png', 150], ['Square284x284Logo.png', 284], ['Square310x310Logo.png', 310],
    ['StoreLogo.png', 50],
  ]) copy(`color-${size}.png`, TAURI, name);
  for (const size of [16, 32, 48, 128]) copy(`color-${size}.png`, EXT, `${size}.png`);
}

await render();
install();
const files = fs.readdirSync(TAURI).sort();
console.log(JSON.stringify({
  rendered: jobs().length,
  tauri: files.map((f) => `${f}:${fs.statSync(path.join(TAURI, f)).size}`),
  extension: fs.readdirSync(EXT).sort(),
}, null, 2));
