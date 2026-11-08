// 1.0.4 → 1.0.5 升级前后状态采集：设置、任务、下载目录、下载文件。
// 两个阶段都以 FW_SMOKE=1 离屏运行，只经 WebView2 调试端口调用命令。
// 用法：node tools/Accept-Fw105-Upgrade.mjs <mode:prepare|verify> <fetchweir.exe> <outDir>
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const [, , MODE, EXE, OUT_ARG] = process.argv;
if (!MODE || !EXE) {
  console.error('用法: node tools/Accept-Fw105-Upgrade.mjs <prepare|verify> <fetchweir.exe> [outDir]');
  process.exit(2);
}
const OUT = OUT_ARG || path.join('D:', 'fw-accept', 'block-b');
const SHOTS = path.join(OUT, 'shots');
const DOWNLOADS = path.join(OUT, 'downloads');
const DATA = path.join(process.env.APPDATA || os.homedir(), 'Fetchweir');
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(DOWNLOADS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const step = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

// ---- 下载源 ----
const FILE_SIZE = 3 * 1024 * 1024;
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/upgrade.bin') {
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      const start = m ? Number(m[1]) : 0;
      const end = m && m[2] ? Number(m[2]) : FILE_SIZE - 1;
      res.writeHead(206, {
        'content-type': 'application/octet-stream',
        'content-length': String(end - start + 1),
        'content-range': `bytes ${start}-${end}/${FILE_SIZE}`,
        'accept-ranges': 'bytes',
      });
      return res.end(Buffer.alloc(end - start + 1, 0x33));
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(FILE_SIZE), 'accept-ranges': 'bytes' });
    return res.end(Buffer.alloc(FILE_SIZE, 0x33));
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}

const port = await freePort();
const child = spawn(EXE, [], {
  cwd: path.dirname(EXE),
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`, FW_SMOKE: '1', FW_NO_ELEVATE: '1' },
  stdio: 'ignore',
  windowsHide: true,
});

let ws;
let id = 1;
const rpc = (method, params = {}) => new Promise((resolve, reject) => {
  const myId = id++;
  const onMsg = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id !== myId) return;
    ws.removeEventListener('message', onMsg);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  };
  ws.addEventListener('message', onMsg);
  ws.send(JSON.stringify({ id: myId, method, params }));
});
const evaluate = async (expression, awaitPromise = false) => {
  const r = await rpc('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const invoke = async (cmd, args) => JSON.parse(await evaluate(
  `(async () => JSON.stringify(await window.__TAURI__.core.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args || {})})))()`, true));
const shot = async (name) => {
  const r = await rpc('Page.captureScreenshot', { format: 'png' });
  const file = path.join(SHOTS, `${MODE}-${name}.png`);
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  return file;
};

try {
  const deadline = Date.now() + 60000;
  let page = null;
  while (Date.now() < deadline && !page) {
    try {
      const arr = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = arr.find((x) => x.type === 'page' && /tauri\.localhost/.test(x.url || ''));
    } catch { /* 等待端口 */ }
    if (!page) await sleep(120);
  }
  if (!page) throw new Error('等待调试目标超时');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  await rpc('Runtime.enable');
  await rpc('Page.enable');
  await rpc('Emulation.setDeviceMetricsOverride', { width: 1180, height: 760, deviceScaleFactor: 1, mobile: false });
  let ready = false;
  for (let i = 0; i < 200 && !ready; i++) {
    try { ready = await evaluate(`!!(window.__TAURI__ && window.__TAURI__.core)`); } catch { /* booting */ }
    if (!ready) await sleep(120);
  }
  if (!ready) throw new Error('前端未就绪');

  const info = await invoke('install_info');
  const version = (await invoke('update_status')).currentVersion;

  if (MODE === 'prepare') {
    const s = await invoke('get_settings');
    const next = {
      ...s,
      connections: 12,
      theme: 'light',
      accent: '#22AA88',
      sniffTier: 'A',
      density: 'compact',
      closeToTray: false,
      downloadDir: DOWNLOADS,
    };
    await invoke('save_settings', { settings: next });
    const target = path.join(DOWNLOADS, 'upgrade.bin');
    await invoke('add_task', { url: BASE + '/upgrade.bin', saveDir: DOWNLOADS, fileName: null, connections: 4, autoStart: true });
    let ok = false;
    for (let i = 0; i < 300; i++) {
      await sleep(120);
      if (fs.existsSync(target) && fs.statSync(target).size === FILE_SIZE) { ok = true; break; }
    }
    const tasks = await invoke('list_tasks');
    const saved = JSON.parse(fs.readFileSync(path.join(DATA, 'settings.json'), 'utf8'));
    await evaluate(`document.getElementById('navSettings').click(); 'ok'`);
    await sleep(500);
    const s1 = await shot('settings-before');
    fs.writeFileSync(path.join(OUT, 'state-before.json'), JSON.stringify({
      version, info, tasks, saved, settingsFileStat: fs.statSync(path.join(DATA, 'settings.json')), downloaded: fs.existsSync(target), size: fs.existsSync(target) ? fs.statSync(target).size : 0,
    }, null, 2));
    step(`准备态（${version}）：设置已改、任务已建、文件已下完`, ok && tasks.length === 1 && saved.connections === 12 && saved.theme === 'light',
      JSON.stringify({ version, tasks: tasks.length, connections: saved.connections, theme: saved.theme, accent: saved.accent, sniffTier: saved.sniffTier, downloadDir: saved.downloadDir, fileSize: fs.existsSync(target) ? fs.statSync(target).size : 0, shot: path.basename(s1) }));
  } else {
    const s = await invoke('get_settings');
    const tasks = await invoke('list_tasks');
    const target = path.join(DOWNLOADS, 'upgrade.bin');
    const saved = fs.existsSync(path.join(DATA, 'settings.json')) ? JSON.parse(fs.readFileSync(path.join(DATA, 'settings.json'), 'utf8')) : null;
    const info2 = await invoke('install_info');
    await evaluate(`document.getElementById('navSettings').click(); 'ok'`);
    await sleep(500);
    const s2 = await shot('settings-after');
    const state = {
      version, info: info2, settings: s, saved, tasks,
      downloaded: fs.existsSync(target), size: fs.existsSync(target) ? fs.statSync(target).size : 0,
    };
    fs.writeFileSync(path.join(OUT, 'state-after.json'), JSON.stringify(state, null, 2));
    const settingOk = s.connections === 12 && s.theme === 'light' && s.accent === '#22AA88' && s.sniffTier === 'A' && s.density === 'compact' && s.closeToTray === false && s.downloadDir === DOWNLOADS;
    step(`升级后（${version}）：设置全部保留`, settingOk,
      JSON.stringify({ connections: s.connections, theme: s.theme, accent: s.accent, sniffTier: s.sniffTier, density: s.density, closeToTray: s.closeToTray, downloadDir: s.downloadDir, shot: path.basename(s2) }));
    step('升级后：已下载文件仍在', state.downloaded && state.size === FILE_SIZE, `${target} = ${state.size}`);
    step('升级后：任务列表', tasks.length === 0, `内存任务数 ${tasks.length}（应用不持久化任务列表，重启/升级即清空）`);
    step('升级后：安装范围仍识别为当前用户', info2.scope === 'perUser' && info2.installDir.toLowerCase().includes('fetchweir-acceptb'),
      JSON.stringify({ scope: info2.scope, installDir: info2.installDir }));
  }
} catch (e) {
  step('执行中断', false, e.message);
} finally {
  try { child.kill(); } catch { /* ignore */ }
  server.close();
  await sleep(500);
  fs.writeFileSync(path.join(OUT, `result-${MODE}.json`), JSON.stringify(results, null, 2));
  process.exitCode = results.every((r) => r.pass) ? 0 : 1;
}
