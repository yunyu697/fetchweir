// 离屏驱动真实桌面应用的「检查更新」整套 GUI 流程：
// 点击「检查更新」→ 发现新版本 → 下载 → 校验 → 界面状态流转，逐阶段截图。
//
// 只通过 WebView2 的远程调试端口操作页面（不注入真实键鼠、不抢前台），
// 应用以 FW_SMOKE=1 隐藏窗口启动。更新源由 FETCHWEIR_UPDATE_BASE 指向，
// 默认由调用方传入一个真实 Release 的资产目录。
//
// 用法：node tools/Test-FwUpdateGui.mjs <fetchweir.exe> <updateBaseUrl>
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXE = process.argv[2];
const BASE = (process.argv[3] || '').replace(/\/+$/, '');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'docs', 'ui-shots');
if (!EXE || !BASE) {
  console.error('用法: node tools/Test-FwUpdateGui.mjs <fetchweir.exe> <updateBaseUrl>');
  process.exit(2);
}
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

async function waitTarget(port, deadline) {
  while (now() < deadline) {
    try {
      const arr = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = arr.find((x) => x.type === 'page' && /tauri\.localhost/.test(x.url || ''));
      if (page) return page;
    } catch { /* 端口还没起来 */ }
    await sleep(100);
  }
  throw new Error('等待 WebView2 调试目标超时');
}

function rpc(ws, id, method, params) {
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== id) return;
      ws.removeEventListener('message', onMsg);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(ws, id, expression, awaitPromise = false) {
  const r = await rpc(ws, id, 'Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(`${d.exception?.description || d.text || 'evaluate failed'}`);
  }
  return r.result.value;
}

// 页面与 __TAURI__ 都要就绪后才能调用命令；端口打开 ≠ 前端 boot 完成。
async function waitTauri(ws, deadline) {
  while (Date.now() < deadline) {
    try {
      const ready = await evaluate(ws, 991001, `!!(window.__TAURI__ && window.__TAURI__.core) && document.readyState !== 'loading'`);
      if (ready) return;
    } catch { /* 导航中 */ }
    await sleep(120);
  }
  throw new Error('等待 __TAURI__ 就绪超时');
}

const port = await freePort();
const env = {
  ...process.env,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
  FETCHWEIR_UPDATE_BASE: BASE,
  FW_NO_ELEVATE: '1',
  FW_SMOKE: '1',
};
const child = spawn(EXE, [], { cwd: path.dirname(EXE), env, stdio: 'ignore', windowsHide: true });
const pid = child.pid;
const stages = [];
const results = [];
const ok = (n, d) => results.push({ name: n, pass: true, detail: d });
const bad = (n, d) => results.push({ name: n, pass: false, detail: d });
let downloadedPath = null;

let ws;
try {
  const page = await waitTarget(port, now() + 60000);
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  let id = 1;
  await rpc(ws, id++, 'Runtime.enable', {});
  await rpc(ws, id++, 'Page.enable', {});
  const errors = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
    }
  });

  // 窗口在 FW_SMOKE=1 下是隐藏的，先确认渲染进程仍在出帧（否则截图会全黑）。
  await waitTauri(ws, now() + 30000);
  const shot = async (name) => {
    // 截图前把更新卡片滚到可视区中间，保证每张图都能直接看到状态行。
    await evaluate(ws, id++, `(() => {
      const c = document.getElementById('updateCard');
      if (c) c.scrollIntoView({ block: 'center' });
      return 'ok';
    })()`);
    await sleep(200);
    const r = await rpc(ws, id++, 'Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(r.data, 'base64');
    const file = path.join(SHOTS, `update-gui-${name}.png`);
    fs.writeFileSync(file, buf);
    return { file, bytes: buf.length };
  };
  const snap = async () => {
    const raw = await evaluate(ws, id++, `(async () => {
      const dto = await window.__TAURI__.core.invoke('update_status');
      return JSON.stringify({
        dto,
        hint: document.getElementById('updateHint').textContent,
        panelHidden: document.getElementById('updatePanel').hidden,
        badgeHidden: document.getElementById('updateVerified').hidden,
        progressWidth: document.getElementById('updateFill').style.width,
        msg: document.getElementById('updateMsg').hidden ? null : document.getElementById('updateMsg').textContent,
        view: document.querySelector('.sb.on') ? document.querySelector('.sb.on').id : null,
      });
    })()`, true);
    return JSON.parse(raw);
  };

  // 更新卡片在设置页。boot() 末尾还会按 URL 参数 setView 一次，
  // 早于 boot 完成点击会被覆盖，所以点完要确认视图真的切过去了，没切就重点。
  let switched = false;
  for (let i = 0; i < 30 && !switched; i++) {
    await evaluate(ws, id++, `document.getElementById('navSettings').click(); 'ok'`);
    await sleep(250);
    switched = await evaluate(ws, id++, `!document.getElementById('viewSettings').hidden`);
  }
  await sleep(400);
  const start = await snap();
  const cardVisible = await evaluate(ws, id++, `(() => {
    const c = document.getElementById('updateCard');
    return c ? c.getBoundingClientRect().height > 0 : false;
  })()`);
  stages.push({ stage: 'idle', hint: start.hint, at: now() });
  const idleShot = await shot('1-idle');
  if (cardVisible && start.dto && start.dto.stage === 'idle') ok('进入设置页：更新卡片可见、初始 stage=idle', JSON.stringify({ hint: start.hint, shot: idleShot.bytes }));
  else bad('进入设置页：更新卡片可见、初始 stage=idle', JSON.stringify({ cardVisible, hint: start.hint, dto: start.dto }));

  // 点击「检查更新」。
  const tCheck = now();
  await evaluate(ws, id++, `document.getElementById('btnCheckUpdate').click(); 'ok'`);
  let found = null;
  let sawChecking = false;
  while (now() - tCheck < 90000) {
    const s = await snap();
    if (s.dto && s.dto.stage === 'checking') {
      if (!sawChecking) {
        sawChecking = true;
        stages.push({ stage: 'checking', hint: s.hint, at: now() });
        await shot('2-checking');
      }
    }
    if (s.dto && ['updateAvailable', 'upToDate', 'failed'].includes(s.dto.stage)) { found = s; break; }
    await sleep(120);
  }
  if (!found) throw new Error('检查更新在 90 秒内没有进入终态');
  stages.push({ stage: found.dto.stage, hint: found.hint, latest: found.dto.latestVersion, verified: found.dto.verified, at: now() });
  const availShot = await shot('3-' + found.dto.stage);
  if (found.dto.stage === 'updateAvailable' && found.dto.latestVersion) {
    ok('发现新版本', JSON.stringify({
      current: found.dto.currentVersion,
      latest: found.dto.latestVersion,
      verified: found.dto.verified,
      sha256: found.dto.sha256,
      asset: found.dto.assetName,
      size: found.dto.assetSize,
      panelHidden: found.panelHidden,
      badgeHidden: found.badgeHidden,
      hint: found.hint,
      checkMs: now() - tCheck,
      shot: availShot.bytes,
    }));
    if (found.panelHidden === false && found.badgeHidden === false && found.dto.verified) ok('界面展开详情并显示「签名已校验」', found.hint);
    else bad('界面展开详情并显示「签名已校验」', JSON.stringify({ panelHidden: found.panelHidden, badgeHidden: found.badgeHidden, verified: found.dto.verified }));
  } else {
    throw new Error(`未进入 updateAvailable（stage=${found.dto.stage}，hint=${found.hint}）`);
  }

  // 点击「仅下载」，观察 downloading → downloaded 的进度与状态流转。
  const tDl = now();
  await evaluate(ws, id++, `document.getElementById('btnDownloadOnly').click(); 'ok'`);
  let midShot = null;
  let done = null;
  let peak = 0;
  while (now() - tDl < 180000) {
    const s = await snap();
    const p = Number(s.dto && s.dto.progress) || 0;
    if (s.dto && s.dto.stage === 'downloading') {
      peak = Math.max(peak, p);
      if (!midShot) {
        midShot = await shot('4-downloading');
        stages.push({ stage: 'downloading', progress: p, downloaded: s.dto.downloaded, total: s.dto.total, at: now() });
      }
    }
    if (s.dto && ['downloaded', 'failed'].includes(s.dto.stage)) { done = s; break; }
    await sleep(100);
  }
  if (!done) throw new Error('下载在 180 秒内没有进入终态');
  stages.push({ stage: done.dto.stage, progress: done.dto.progress, path: done.dto.path, canInstall: done.dto.canInstall, at: now() });
  const doneShot = await shot('5-' + done.dto.stage);
  if (done.dto.stage !== 'downloaded') {
    throw new Error(`下载失败：${done.dto.message || done.hint}`);
  }
  downloadedPath = done.dto.path;
  ok('下载完成并进入 downloaded', JSON.stringify({
    progress: done.dto.progress,
    canInstall: done.dto.canInstall,
    path: done.dto.path,
    downloadMs: now() - tDl,
    peakProgress: peak,
    shot: doneShot.bytes,
  }));
  let installBtnVisible = false;
  for (let i = 0; i < 20 && !installBtnVisible; i++) {
    installBtnVisible = await evaluate(ws, id++, `(() => {
      const b = document.getElementById('btnInstallUpdate');
      return !b.hidden && b.getBoundingClientRect().height > 0;
    })()`);
    if (!installBtnVisible) await sleep(150);
  }
  if (installBtnVisible && done.dto.canInstall) ok('界面出现「安装并重启」', done.hint);
  else bad('界面出现「安装并重启」', JSON.stringify({ installBtnVisible, canInstall: done.dto.canInstall }));

  // 独立核对文件哈希：不依赖应用自己的校验结果。
  if (downloadedPath && fs.existsSync(downloadedPath)) {
    const hash = createHash('sha256').update(fs.readFileSync(downloadedPath)).digest('hex');
    const size = fs.statSync(downloadedPath).size;
    const want = (done.dto.sha256 || '').toLowerCase();
    if (want && hash === want) ok('落盘文件 SHA256 与清单一致', JSON.stringify({ size, sha256: hash }));
    else bad('落盘文件 SHA256 与清单一致', JSON.stringify({ size, sha256: hash, manifestSha256: done.dto.sha256 }));
  } else {
    bad('落盘文件存在', String(downloadedPath));
  }

  if (errors.length === 0) ok('页面无未捕获异常', '0');
  else bad('页面无未捕获异常', errors.slice(0, 3).join(' | '));
} catch (e) {
  bad('流程异常', e.message);
  try {
    if (ws) {
      const r = await rpc(ws, 9999, 'Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(SHOTS, 'update-gui-9-error.png'), Buffer.from(r.data, 'base64'));
    }
  } catch { /* ignore */ }
} finally {
  try { if (ws) ws.close(); } catch { /* ignore */ }
  try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
  await sleep(800);
  // 清理本轮下载到系统下载目录的测试包，避免在用户机器上留 25MB 垃圾。
  if (downloadedPath && fs.existsSync(downloadedPath) && /Fetchweir_.*setup.*\.exe$/i.test(downloadedPath)) {
    try { fs.unlinkSync(downloadedPath); } catch { /* ignore */ }
  }
}

const failed = results.filter((r) => !r.pass);
console.log(JSON.stringify({ updateBase: BASE, stages, results, pass: failed.length === 0, shots: SHOTS }, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
