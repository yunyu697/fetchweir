// 离屏 UI 校验：启动无头 Edge，收集控制台错误并截图。
// 用法：node tools/Verify-FwUI.mjs <fileUrl> <out.png> [width] [height]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EDGE = process.env.FW_EDGE_PATH
  || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const url = process.argv[2];
const out = process.argv[3];
const width = Number(process.argv[4] || 1180);
const height = Number(process.argv[5] || 760);
if (!url || !out) {
  console.error('用法: node tools/Verify-FwUI.mjs <fileUrl> <out.png> [width] [height]');
  process.exit(2);
}

const port = 9400 + Math.floor(Math.random() * 40);
const profile = path.join(process.env.TEMP || '.', `fw-verify-${port}`);
const browser = spawn(EDGE, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--window-size=' + width + ',' + height,
  '--remote-debugging-port=' + port,
  '--user-data-dir=' + profile,
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    await sleep(150);
  }
  throw new Error('等待超时');
}

async function main() {
  const version = await waitFor(async () => {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`);
    return r.ok ? r.json() : null;
  });
  const browserWs = version.webSocketDebuggerUrl;

  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);

  const errors = [];
  let seq = 1;
  const pending = new Map();

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = seq++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push('exception: ' + (d.exception?.description || d.text));
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push('console.error: ' + msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      errors.push('log: ' + msg.params.entry.text + ' ' + (msg.params.entry.url || ''));
    }
  });

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  await sleep(1400);

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));

  // 额外导出关键布局信息，用于检测溢出
  const metrics = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
      rows: document.querySelectorAll('.task').length,
      emptyHidden: document.getElementById('emptyState').hidden,
      overflow: document.body.scrollWidth > document.documentElement.clientWidth
    })`,
    returnByValue: true,
  });

  ws.close();
  console.log(JSON.stringify({
    png: out,
    bytes: fs.statSync(out).size,
    metrics: JSON.parse(metrics.result.value),
    errors,
  }, null, 2));

  if (errors.length) process.exitCode = 1;
  void browserWs;
}

main().catch((e) => {
  console.error('验证失败:', e.message);
  process.exitCode = 1;
}).finally(() => {
  setTimeout(() => browser.kill(), 300);
});
