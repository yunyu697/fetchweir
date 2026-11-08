// 1.0.5 新用户端到端验收（离屏）：首次启动 → 添加任务 → 视频解析 → 检查更新。
// 应用以 FW_SMOKE=1 隐藏运行，只通过 WebView2 远程调试端口操作页面，不抢前台。
// 用法：node tools/Accept-Fw105-Clean.mjs <fetchweir.exe> [outDir]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXE = process.argv[2];
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[3] || path.join('D:', 'fw-accept', 'block-a');
const SHOTS = path.join(OUT, 'shots');
const DOWNLOADS = path.join(OUT, 'downloads');
const DATA = path.join(process.env.APPDATA || os.homedir(), 'Fetchweir');
if (!EXE) {
  console.error('用法: node tools/Accept-Fw105-Clean.mjs <fetchweir.exe> [outDir]');
  process.exit(2);
}
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(DOWNLOADS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const step = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};
const log = [];

// ---- 本地下载源：8MB 文件，支持 Range；另配一条 HLS 供视频解析 ----
const FILE_SIZE = 8 * 1024 * 1024;
const CLEAR_HLS = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg0.ts\n#EXT-X-ENDLIST\n';
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/sample.bin') {
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
      return res.end(Buffer.alloc(end - start + 1, 0x5a));
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(FILE_SIZE), 'accept-ranges': 'bytes' });
    return res.end(Buffer.alloc(FILE_SIZE, 0x5a));
  }
  if (u === '/clear.m3u8') {
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
    return res.end(CLEAR_HLS);
  }
  if (u === '/seg0.ts') {
    res.writeHead(200, { 'content-type': 'video/mp2t' });
    return res.end(Buffer.alloc(2048, 0x47));
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
const env = {
  ...process.env,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
  FW_SMOKE: '1',
  FW_NO_ELEVATE: '1',
};
const launchedAt = Date.now();
const child = spawn(EXE, [], { cwd: path.dirname(EXE), env, stdio: 'ignore', windowsHide: true });
const pid = child.pid;

let ws;
let id = 1;
const rpc = (method, params = {}) => new Promise((resolve, reject) => {
  const myId = id++;
  const onMsg = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id !== myId) return;
    ws.removeEventListener('message', onMsg);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  };
  ws.addEventListener('message', onMsg);
  ws.send(JSON.stringify({ id: myId, method, params }));
});
const evaluate = async (expression, awaitPromise = false) => {
  const r = await rpc('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const shot = async (name) => {
  const r = await rpc('Page.captureScreenshot', { format: 'png' });
  const file = path.join(SHOTS, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  return file;
};

async function waitTarget(deadline) {
  while (Date.now() < deadline) {
    try {
      const arr = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = arr.find((x) => x.type === 'page' && /tauri\.localhost/.test(x.url || ''));
      if (page) return page;
    } catch { /* 端口未就绪 */ }
    await sleep(100);
  }
  throw new Error('等待 WebView2 调试目标超时');
}

try {
  const page = await waitTarget(Date.now() + 60000);
  log.push(`调试目标就绪 ${Date.now() - launchedAt}ms：${page.url}`);
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  await rpc('Runtime.enable');
  await rpc('Page.enable');
  await rpc('Emulation.setDeviceMetricsOverride', { width: 1180, height: 760, deviceScaleFactor: 1, mobile: false });

  const pageErrors = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
  });

  // ---- 1. 首次启动 ----
  let ready = false;
  for (let i = 0; i < 200 && !ready; i++) {
    try { ready = await evaluate(`!!(window.__TAURI__ && window.__TAURI__.core) && document.readyState !== 'loading'`); } catch { /* 导航中 */ }
    if (!ready) await sleep(120);
  }
  const bootMs = Date.now() - launchedAt;
  if (!ready) throw new Error('前端未在 30 秒内就绪');
  const boot = JSON.parse(await evaluate(`(async () => {
    const tasks = await window.__TAURI__.core.invoke('list_tasks');
    const info = await window.__TAURI__.core.invoke('install_info');
    return JSON.stringify({
      tasks: tasks.length,
      scope: info.scope,
      installDir: info.installDir,
      dataDir: info.dataDir,
      title: document.title,
      emptyHidden: document.getElementById('emptyState').hidden,
      version: (await window.__TAURI__.core.invoke('app_version').catch(() => null)),
    });
  })()`, true));
  const settingsFile = path.join(DATA, 'settings.json');
  const settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : null;
  const nmLog = fs.existsSync(path.join(DATA, 'nm-register.log')) ? fs.readFileSync(path.join(DATA, 'nm-register.log'), 'utf8').trim() : '';
  const extensionOk = fs.existsSync(path.join(path.dirname(EXE), 'extension', 'manifest.json'));
  const shot1 = await shot('01-first-run');
  step('首次启动：前端就绪、任务为空、安装范围识别', boot.tasks === 0 && boot.scope === 'perUser',
    JSON.stringify({ bootMs, scope: boot.scope, installDir: boot.installDir, dataDir: boot.dataDir, title: boot.title, version: boot.version, shot: path.basename(shot1) }));
  step('首次启动：默认设置落盘', !!settings && settings.connections === 8 && settings.sniffTier === 'B' && settings.autostart === false,
    JSON.stringify(settings && { connections: settings.connections, sniffTier: settings.sniffTier, autostart: settings.autostart, theme: settings.theme, downloadDir: settings.downloadDir }));
  step('首次启动：扩展资源随包落地', extensionOk, extensionOk ? path.dirname(EXE) + '\\extension\\manifest.json' : '缺少 extension/manifest.json');
  step('首次启动：浏览器 Native Messaging 注册', /Chrome|Edge/.test(nmLog) || fs.existsSync(path.join(DATA, 'nm', 'dev.fetchweir.nmh.json')),
    nmLog || '(无 nm-register.log)');

  // ---- 2. 添加一个任务 ----
  const target = path.join(DOWNLOADS, 'sample.bin');
  await evaluate(`(() => {
    document.getElementById('btnNew').click();
    document.getElementById('urlInput').value = ${JSON.stringify(BASE + '/sample.bin')};
    document.getElementById('dirInput').value = ${JSON.stringify(DOWNLOADS)};
    document.getElementById('connInput').value = '4';
    document.getElementById('btnAdd').click();
    return 'ok';
  })()`);
  let taskSeen = false;
  let done = false;
  const tAdd = Date.now();
  for (let i = 0; i < 300; i++) {
    await sleep(120);
    if (!taskSeen) {
      taskSeen = await evaluate(`document.querySelectorAll('#taskList .task').length > 0`);
    }
    if (fs.existsSync(target) && fs.statSync(target).size === FILE_SIZE) { done = true; break; }
    const failed = await evaluate(`document.getElementById('taskList').textContent.includes('需处理')`);
    if (failed) break;
  }
  const shot2 = await shot('02-task-added');
  const rows = await evaluate(`document.getElementById('taskList').textContent.replace(/\\s+/g,' ').trim()`);
  step('添加任务：列表出现任务并完成下载', taskSeen && done,
    JSON.stringify({ taskAddMs: Date.now() - tAdd, file: fs.existsSync(target) ? fs.statSync(target).size : null, rows: rows.slice(0, 120), shot: path.basename(shot2) }));

  // ---- 3. 视频解析 ----
  await evaluate(`document.getElementById('navVideoTool').click(); 'ok'`);
  await sleep(400);
  await evaluate(`(() => {
    document.getElementById('videoUrl').value = ${JSON.stringify(BASE + '/clear.m3u8')};
    document.getElementById('btnProbe').click();
    return 'ok';
  })()`);
  let parsed = false;
  const tProbe = Date.now();
  for (let i = 0; i < 400; i++) {
    await sleep(150);
    parsed = await evaluate(`(() => {
      const top = document.getElementById('vidTop');
      return !!top && !top.hidden;
    })()`);
    if (parsed) break;
    const err = await evaluate(`document.getElementById('vidEmpty').textContent`);
    if (/失败|不支持|错误/.test(err)) { log.push('视频解析失败提示：' + err); break; }
  }
  const shot3 = await shot('03-video-parsed');
  const vid = JSON.parse(await evaluate(`JSON.stringify({
    title: document.getElementById('vidTitle').textContent,
    meta: document.getElementById('vidMeta').textContent,
    formats: document.querySelectorAll('#fmtBody tr').length,
    hint: document.getElementById('fmtHint').textContent,
  })`));
  step('视频解析：HLS 链接解析出格式', parsed && vid.formats > 0,
    JSON.stringify({ probeMs: Date.now() - tProbe, title: vid.title, meta: vid.meta, formats: vid.formats, hint: vid.hint, shot: path.basename(shot3) }));

  // ---- 4. 检查更新 ----
  await evaluate(`document.getElementById('navSettings').click(); 'ok'`);
  await sleep(600);
  const tUp = Date.now();
  await evaluate(`document.getElementById('btnCheckUpdate').click(); 'ok'`);
  let upd = null;
  for (let i = 0; i < 600; i++) {
    await sleep(200);
    const raw = await evaluate(`(async () => JSON.stringify(await window.__TAURI__.core.invoke('update_status')))()`, true);
    const dto = JSON.parse(raw);
    if (['upToDate', 'updateAvailable', 'failed', 'downloaded'].includes(dto.stage)) { upd = dto; break; }
  }
  const shot4 = await shot('04-update-check');
  const hint = await evaluate(`document.getElementById('updateHint').textContent`);
  step('检查更新：已安装 1.0.5 判定为最新', !!upd && upd.stage === 'upToDate',
    JSON.stringify({ stage: upd && upd.stage, current: upd && upd.currentVersion, latest: upd && upd.latestVersion, verified: upd && upd.verified, hint, checkMs: Date.now() - tUp, shot: path.basename(shot4) }));

  step('运行期无前端异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} catch (e) {
  step('执行中断', false, e.message);
} finally {
  try { child.kill(); } catch { /* ignore */ }
  server.close();
  await sleep(600);
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ exe: EXE, pid, log, results }, null, 2));
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${failed.length === 0 ? '全部通过' : failed.length + ' 项失败'}，结果：${path.join(OUT, 'result.json')}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}
