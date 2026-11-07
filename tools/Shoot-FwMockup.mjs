// 设计稿分屏截图：把 docs/ui-mockup-v1.html 的每个视图单独出图，
// 作为界面还原并排比对的基准（左设计稿 / 右实现）。
// 用法：node tools/Shoot-FwMockup.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = process.env.FW_EDGE_PATH
  || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = path.join(ROOT, 'docs', 'ui-shots');
const PAGE = path.join(ROOT, 'docs', 'ui-mockup-v1.html');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const port = 9800 + Math.floor(Math.random() * 40);
const profile = path.join(process.env.TEMP || '.', `fw-mockup-${port}`);
const browser = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--window-size=1440,900',
  '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank',
], { stdio: 'ignore' });

async function waitFor(fn, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    await sleep(150);
  }
  throw new Error('等待无头浏览器超时');
}

async function main() {
  await waitFor(async () => {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`);
    return r.ok ? r.json() : null;
  });
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
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
  await send('Page.navigate', { url: 'file:///' + PAGE.replace(/\\/g, '/').replace(/ /g, '%20') });

  const shots = [
    ['mockup-main', 1280, 800, 'closeDetail(); showView("main")'],
    ['mockup-detail', 1280, 800, 'closeDetail(); openDetail(document.querySelector(".task"))'],
    ['mockup-video', 1280, 800, 'closeDetail(); showView("video")'],
    ['mockup-sniff', 1280, 800, 'closeDetail(); showView("sniff")'],
    ['mockup-settings', 1280, 800, 'closeDetail(); showView("settings")'],
    ['mockup-min', 900, 620, 'closeDetail(); showView("main")'],
  ];

  for (const [name, w, h, expr] of shots) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await send('Runtime.evaluate', { expression: expr, awaitPromise: true });
    await sleep(450);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(shot.data, 'base64'));
    console.log(`${name}.png ${w}x${h}`);
  }
  ws.close();
}

main()
  .catch((e) => { console.error('失败:', e.message); process.exitCode = 1; })
  .finally(() => process.exit());
