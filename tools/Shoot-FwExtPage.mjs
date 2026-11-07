// 浏览器扩展工具栏外观的实测证据：
// 用无头 Chromium 加载 extension/ 目录，打开 chrome://extensions 截图。
// 这会渲染浏览器自带的扩展卡片（含 128px 图标），不是页面内伪造的预览图。
// 用法：node tools/Shoot-FwExtPage.mjs [out.png]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = process.env.FW_EDGE_PATH
  || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = process.argv[2] || path.join(ROOT, 'docs', 'ui-shots', 'extension-toolbar.png');
const EXT = path.join(ROOT, 'extension');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const port = 9700 + Math.floor(Math.random() * 40);
const profile = path.join(process.env.TEMP || '.', `fw-extpage-${port}`);

const browser = spawn(EDGE, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  `--load-extension=${EXT}`,
  `--disable-extensions-except=${EXT}`,
  '--window-size=1100,720',
  '--remote-debugging-port=' + port,
  '--user-data-dir=' + profile,
  'about:blank',
], { stdio: 'ignore' });

async function waitFor(fn, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    await sleep(150);
  }
  throw new Error('等待无头浏览器超时');
}

async function cdp(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('未找到页面目标');
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
  return { ws, send };
}

async function main() {
  await waitFor(async () => {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`);
    return r.ok ? r.json() : null;
  });

  let { ws, send } = await cdp(port);
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 720, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'chrome://extensions/' });
  await sleep(2200);

  const list = await send('Runtime.evaluate', {
    expression: `(() => {
      const items = [...document.querySelectorAll('extensions-item')];
      return JSON.stringify(items.map((el) => ({
        name: (el.shadowRoot?.querySelector('#name')?.textContent || '').trim(),
        enabled: el.shadowRoot?.querySelector('#enableToggle')?.checked ?? null,
      })));
    })()`,
    returnByValue: true,
  });

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log(JSON.stringify({ png: OUT, items: JSON.parse(list.result.value || '[]') }, null, 2));
  ws.close();
}

main()
  .catch((e) => { console.error('失败:', e.message); process.exitCode = 1; })
  .finally(() => process.exit());
