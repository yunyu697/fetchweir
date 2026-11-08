// 任务持久化验收：下载到一半强杀 → 重启恢复 → 续传完成 → 校验 SHA256。
// 同时采样 tasks.json 的 mtime，确认进度落盘是 1Hz 节流而不是每块都写。
// 应用以 FW_SMOKE=1 离屏运行，只经 WebView2 调试端口操作。
// 用法：node tools/Test-FwResume.mjs <fetchweir.exe> [outDir]
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const EXE = process.argv[2];
const OUT = process.argv[3] || path.join('D:', 'fw-accept', 'block-p');
const SHOTS = path.join(OUT, 'shots');
const DOWNLOADS = path.join(OUT, 'downloads');
const DATA = path.join(process.env.APPDATA || os.homedir(), 'Fetchweir');
const TASKS_FILE = path.join(DATA, 'tasks.json');
if (!EXE) {
  console.error('用法: node tools/Test-FwResume.mjs <fetchweir.exe> [outDir]');
  process.exit(2);
}
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(DOWNLOADS, { recursive: true });
for (const f of fs.readdirSync(DOWNLOADS)) fs.rmSync(path.join(DOWNLOADS, f), { recursive: true, force: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const step = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

// ---- 12MB 确定性内容 + 全局限速 1.2MB/s ----
const SIZE = 12 * 1024 * 1024;
const RATE = 1_200_000; // bytes/s
const CHUNK = 32 * 1024;
const SRC = Buffer.alloc(SIZE);
for (let i = 0; i < SIZE; i++) SRC[i] = (i * 31 + 7) & 0xff;
const SHA = createHash('sha256').update(SRC).digest('hex');

let tokens = 0;
let lastRefill = Date.now();
function take(bytes) {
  const now = Date.now();
  tokens = Math.min(RATE, tokens + ((now - lastRefill) * RATE) / 1000);
  lastRefill = now;
  tokens -= bytes;
  return tokens < 0 ? Math.ceil((-tokens / RATE) * 1000) : 0;
}

const server = http.createServer(async (req, res) => {
  const u = req.url.split('?')[0];
  if (u !== '/big.bin') { res.writeHead(404); return res.end(); }
  const range = req.headers.range;
  let start = 0;
  let end = SIZE - 1;
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    start = m ? Number(m[1]) : 0;
    end = m && m[2] ? Number(m[2]) : SIZE - 1;
    res.writeHead(206, {
      'content-type': 'application/octet-stream',
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${SIZE}`,
      'accept-ranges': 'bytes',
    });
  } else {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(SIZE), 'accept-ranges': 'bytes' });
  }
  for (let off = start; off <= end; off += CHUNK) {
    if (res.destroyed) return;
    const n = Math.min(CHUNK, end - off + 1);
    const wait = take(n);
    if (wait > 0) await sleep(wait);
    if (res.destroyed) return;
    if (!res.write(SRC.subarray(off, off + n))) {
      await new Promise((r) => { res.once('drain', r); res.once('close', r); });
    }
  }
  res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const URL = `http://127.0.0.1:${server.address().port}/big.bin`;

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}

async function launch() {
  const port = await freePort();
  const child = spawn(EXE, [], {
    cwd: path.dirname(EXE),
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`, FW_SMOKE: '1', FW_NO_ELEVATE: '1' },
    stdio: 'ignore',
    windowsHide: true,
  });
  let page = null;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline && !page) {
    try {
      const arr = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = arr.find((x) => x.type === 'page' && /tauri\.localhost/.test(x.url || ''));
    } catch { /* 等待 */ }
    if (!page) await sleep(120);
  }
  if (!page) throw new Error('等待调试目标超时');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  let seq = 1;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = seq++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await rpc('Runtime.enable');
  await rpc('Page.enable');
  await rpc('Emulation.setDeviceMetricsOverride', { width: 1180, height: 760, deviceScaleFactor: 1, mobile: false });
  const evaluate = async (expression, awaitPromise = false) => {
    const r = await rpc('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  for (let i = 0; i < 200; i++) {
    try { if (await evaluate(`!!(window.__TAURI__ && window.__TAURI__.core)`)) break; } catch { /* booting */ }
    await sleep(120);
  }
  const invoke = async (cmd, args) => JSON.parse(await evaluate(
    `(async () => JSON.stringify(await window.__TAURI__.core.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args || {})})))()`, true));
  const shot = async (name) => {
    const r = await rpc('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(r.data, 'base64'));
  };
  return { child, invoke, evaluate, shot, close: () => { try { child.kill(); } catch { /* ignore */ } } };
}

let app;
try {
  // ---------- 第一次运行：下载到约 40% 强杀 ----------
  app = await launch();
  const t0 = Date.now();
  const created = await app.invoke('add_task', {
    url: URL, saveDir: DOWNLOADS, fileName: null, connections: 4, autoStart: true,
  });
  const id = created.id;
  let progress = 0;
  let samples = [];
  let lastMtime = 0;
  // 到达 25% 后开始采样 3 秒，统计 tasks.json 的写入次数
  while (Date.now() - t0 < 60000) {
    await sleep(200);
    const tasks = await app.invoke('list_tasks');
    const t = tasks.find((x) => x.id === id);
    if (!t) throw new Error('任务消失');
    progress = t.doneBytes / Math.max(1, t.totalBytes);
    if (progress >= 0.25 && samples.length === 0) {
      for (let i = 0; i < 30; i++) {
        const m = fs.existsSync(TASKS_FILE) ? fs.statSync(TASKS_FILE).mtimeMs : 0;
        samples.push(m);
        await sleep(100);
      }
    }
    if (progress >= 0.4) break;
  }
  const writes = new Set(samples.filter((m) => m > 0)).size;
  step('下载中：进度可观测', progress >= 0.4, `done/total = ${(progress * 100).toFixed(1)}%`);
  step('落盘节流：3 秒内 tasks.json 写入次数', writes >= 1 && writes <= 4, `${writes} 次 / ${(samples.length / 10).toFixed(1)}s`);

  const beforeKill = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
  const persisted = beforeKill.tasks.find((t) => t.id === id);
  step('强杀前：tasks.json 已记录任务与分片进度', !!persisted && persisted.done > 0 && persisted.segments.some((s) => s.done > 0),
    JSON.stringify({ state: persisted && persisted.state, done: persisted && persisted.done, total: persisted && persisted.total, segments: persisted && persisted.segments.length }));

  app.child.kill();
  await sleep(1200);
  const partFile = persisted.partPath;
  step('强杀后：进程已退出，.part 留在磁盘', fs.existsSync(partFile) && fs.statSync(partFile).size === SIZE,
    `${path.basename(partFile)} = ${fs.statSync(partFile).size} 字节`);

  // ---------- 第二次启动：应恢复为暂停/可续传 ----------
  app = await launch();
  const restored = (await app.invoke('list_tasks')).find((t) => t.id === id);
  step('重启后：任务恢复且未标为失败', !!restored && restored.state === 'paused' && restored.doneBytes > 0 && restored.doneBytes < restored.totalBytes,
    JSON.stringify({ state: restored && restored.state, done: restored && restored.doneBytes, total: restored && restored.totalBytes, error: restored && restored.error }));
  await app.evaluate(`document.getElementById('navAll').click(); 'ok'`);
  await sleep(400);
  await app.shot('01-restored-paused');

  // ---------- 续传 ----------
  const tResume = Date.now();
  await app.invoke('resume_task', { id });
  let final = null;
  while (Date.now() - tResume < 120000) {
    await sleep(250);
    const t = (await app.invoke('list_tasks')).find((x) => x.id === id);
    if (!t) break;
    if (['completed', 'failed'].includes(t.state)) { final = t; break; }
  }
  const finalPath = path.join(DOWNLOADS, path.basename(restored.savePath));
  const got = fs.existsSync(finalPath) ? createHash('sha256').update(fs.readFileSync(finalPath)).digest('hex') : null;
  step('续传完成：状态 completed 且文件大小为 12MiB', !!final && final.state === 'completed' && fs.statSync(finalPath).size === SIZE,
    JSON.stringify({ state: final && final.state, size: fs.existsSync(finalPath) ? fs.statSync(finalPath).size : null, resumeMs: Date.now() - tResume }));
  step('续传结果 SHA256 与源一致', got === SHA, `${got} vs ${SHA}`);
  step('续传后 .part 已清理', !fs.existsSync(partFile), partFile);
  await app.shot('02-completed');

  // ---------- 第三次启动：已完成记录仍在 ----------
  app.close();
  await sleep(1000);
  app = await launch();
  const after = (await app.invoke('list_tasks')).find((t) => t.id === id);
  step('再次重启：已完成记录仍在', !!after && after.state === 'completed' && after.doneBytes === SIZE,
    JSON.stringify({ state: after && after.state, done: after && after.doneBytes, total: after && after.totalBytes }));
  await app.evaluate(`document.getElementById('navAll').click(); 'ok'`);
  await sleep(400);
  await app.shot('03-completed-after-restart');
} catch (e) {
  step('执行中断', false, e.message);
} finally {
  if (app) app.close();
  server.close();
  await sleep(400);
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ source: URL, size: SIZE, sha256: SHA, results }, null, 2));
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${failed.length === 0 ? '全部通过' : failed.length + ' 项失败'}，结果：${path.join(OUT, 'result.json')}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}
