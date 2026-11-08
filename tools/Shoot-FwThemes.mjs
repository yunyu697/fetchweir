// 颜色主题 × 明暗主题离屏截图：直接加载前端 demo 页面，按组合切换 data-color/data-theme 后截图。
// 用法：node tools/Shoot-FwThemes.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = process.env.FW_EDGE_PATH
  || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = path.join(ROOT, 'docs', 'ui-shots');
const PAGE = 'file:///' + path.join(ROOT, 'src', 'index.html').replace(/\\/g, '/') + '?demo';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const COLORS = ['violet', 'azure', 'emerald', 'amber'];
const MODES = ['dark', 'light'];

const port = 9900 + Math.floor(Math.random() * 40);
const profile = path.join(process.env.TEMP || '.', `fw-theme-${port}`);
const browser = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--window-size=1180,760', '--hide-scrollbars',
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
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(PAGE)}`, { method: 'PUT' })).json();
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
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 760, deviceScaleFactor: 1, mobile: false });

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(s.data, 'base64'));
  };

  await send('Page.navigate', { url: PAGE });
  await waitFor(async () => evaluate("document.querySelectorAll('.task').length > 0 && !!document.getElementById('colorGrid')"));

  const results = [];
  for (const mode of MODES) {
    for (const color of COLORS) {
      await evaluate(`(() => {
        document.documentElement.dataset.theme = '${mode}';
        document.documentElement.dataset.color = '${color}';
        document.querySelectorAll('[data-theme-set]').forEach((b) => b.classList.toggle('on', b.dataset.themeSet === '${mode}'));
        document.querySelectorAll('[data-color-set]').forEach((b) => b.classList.toggle('on', b.dataset.colorSet === '${color}'));
        return true;
      })()`);
      await sleep(180);
      await shot(`theme-${color}-${mode}.png`);
      results.push(`${color}-${mode}`);
    }
  }

  // 设置页外观区：进入设置 → 跳到外观，验证选择器本身
  await evaluate(`(() => {
    document.documentElement.dataset.theme = 'dark';
    document.documentElement.dataset.color = 'violet';
    document.getElementById('navSettings').click();
    document.querySelector('[data-jump="s6"]').click();
    return true;
  })()`);
  await sleep(450);
  const scrolled = await evaluate(`(() => {
    const sec = document.getElementById('s6');
    const view = sec && sec.closest('.view');
    if (!view || view.hidden) return false;
    sec.scrollIntoView({ block: 'start' });
    view.scrollBy(0, -12);
    return true;
  })()`);
  await sleep(250);
  await shot('settings-appearance-dark.png');
  await evaluate("document.documentElement.dataset.theme = 'light'");
  await sleep(200);
  await shot('settings-appearance-light.png');

  // 系统跟随：模拟系统浅色/深色，确认 data-theme 与 logo 实际切换
  const follow = await evaluate(`(async () => {
    const click = (sel) => document.querySelector(sel).click();
    click('[data-theme-set="system"]');
    return true;
  })()`);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await sleep(250);
  const sysLight = await evaluate(`({
    theme: document.documentElement.dataset.theme,
    lightLogo: getComputedStyle(document.querySelector('.brand-logo-light')).display,
    darkLogo: getComputedStyle(document.querySelector('.brand-logo-dark')).display
  })`);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(250);
  const sysDark = await evaluate(`({
    theme: document.documentElement.dataset.theme,
    lightLogo: getComputedStyle(document.querySelector('.brand-logo-light')).display,
    darkLogo: getComputedStyle(document.querySelector('.brand-logo-dark')).display
  })`);

  console.log(JSON.stringify({ shots: results, settingsScrolled: scrolled, follow, sysLight, sysDark }, null, 2));
  ws.close();
  setTimeout(() => browser.kill(), 200);
}

await main();
