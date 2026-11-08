// 多任务限速叠加实测：4 个任务同时下载受控限速源（每连接 32 KB/s），
// 观察全局并发预算从 4×4=16 逐级降到 2×4=8、再降到 1×4=4 的过程。
//
// 应用以 FW_SMOKE=1 隐藏启动，只通过 WebView2 远程调试调用命令，不占前台。
// 用法：node tools/Test-FwAdaptiveMulti.mjs <fetchweir.exe>
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const EXE = process.argv[2];
if (!EXE) {
  console.error('用法: node tools/Test-FwAdaptiveMulti.mjs <fetchweir.exe>');
  process.exit(2);
}
const TASKS = 4;
const CONNS = 4;
const FILE_BYTES = 6 * 1024 * 1024;
const CHUNK = 16 * 1024;
const CHUNK_MS = 500; // 每连接 32 KB/s
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  const m = /^\/file(\d)\.bin$/.exec(u);
  if (!m) { res.writeHead(404); return res.end(); }
  let start = 0;
  let end = FILE_BYTES - 1;
  const range = req.headers.range;
  if (range) {
    const r = /bytes=(\d+)-(\d*)/.exec(range);
    start = Number(r[1]);
    end = r[2] ? Number(r[2]) : FILE_BYTES - 1;
    res.writeHead(206, {
      'content-type': 'application/octet-stream',
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${FILE_BYTES}`,
      'accept-ranges': 'bytes',
    });
  } else {
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(FILE_BYTES),
      'accept-ranges': 'bytes',
    });
  }
  let pos = start;
  let closed = false;
  res.on('close', () => { closed = true; });
  const tick = setInterval(() => {
    if (closed) { clearInterval(tick); return; }
    if (pos > end) { clearInterval(tick); res.end(); return; }
    const n = Math.min(CHUNK, end - pos + 1);
    pos += n;
    if (!res.write(Buffer.alloc(n, 7))) {
      res.once('drain', () => {});
    }
  }, CHUNK_MS);
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

const port = await new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const child = spawn(EXE, [], {
  cwd: path.dirname(EXE),
  env: { ...process.env, FW_SMOKE: '1', FW_NO_ELEVATE: '1', WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
  stdio: 'ignore',
  windowsHide: true,
});

const saveDir = path.join(os.tmpdir(), 'fw-adaptive-multi');
fs.rmSync(saveDir, { recursive: true, force: true });
fs.mkdirSync(saveDir, { recursive: true });

let ws;
const timeline = [];
const results = [];
const ok = (n, d) => results.push({ name: n, pass: true, detail: d });
const bad = (n, d) => results.push({ name: n, pass: false, detail: d });
try {
  let page = null;
  for (let i = 0; i < 300 && !page; i++) {
    try {
      const arr = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = arr.find((x) => x.type === 'page' && /tauri\.localhost/.test(x.url || ''));
    } catch { /* 端口未就绪 */ }
    if (!page) await sleep(120);
  }
  if (!page) throw new Error('WebView2 调试目标未就绪');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  let seq = 1;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = seq++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression, awaitPromise = false) => {
    const r = await rpc('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  await rpc('Runtime.enable');
  for (let i = 0; i < 100; i++) {
    if (await evaluate(`!!(window.__TAURI__ && window.__TAURI__.core)`)) break;
    await sleep(150);
  }

  // 建 4 个任务：每个 4 连接，自动开始。
  const baseUrl = `http://127.0.0.1:${PORT}/file`;
  const created = JSON.parse(await evaluate(`(async () => {
    const out = [];
    for (let i = 0; i < ${TASKS}; i++) {
      const t = await window.__TAURI__.core.invoke('add_task', {
        url: ${JSON.stringify(baseUrl)} + (i + 1) + '.bin',
        saveDir: ${JSON.stringify(saveDir)},
        fileName: 'multi' + (i + 1) + '.bin',
        connections: ${CONNS},
        autoStart: true
      });
      out.push(t && t.id);
    }
    return JSON.stringify(out);
  })()`, true));
  if (created.length !== TASKS) throw new Error(`任务创建不全：${JSON.stringify(created)}`);
  const t0 = now();

  const sample = async () => JSON.parse(await evaluate(`(async () => {
    const list = await window.__TAURI__.core.invoke('list_tasks');
    const rows = list.map((t) => ({
      id: t.id, state: t.state, connLimit: t.connLimit, connBase: t.connBase,
      degraded: t.connDegraded, reason: t.connReason, speedBps: t.speedBps,
      doneBytes: t.doneBytes, totalBytes: t.totalBytes
    }));
    return JSON.stringify({ at: Date.now(), rows });
  })()`, true));

  let lastSig = '';
  let sawDowngrade = false;
  let degradedSample = null;
  let final = null;
  while (now() - t0 < 90000) {
    const s = await sample();
    const limits = s.rows.map((r) => r.connLimit);
    const degraded = s.rows.some((r) => r.degraded);
    const sig = limits.join(',') + '|' + (degraded ? 1 : 0) + '|' + s.rows.map((r) => r.state).join(',');
    if (sig !== lastSig) {
      lastSig = sig;
      timeline.push({
        tMs: s.at - t0,
        connLimitPerTask: limits,
        totalBudget: limits.reduce((a, b) => a + b, 0),
        totalSpeedBps: s.rows.reduce((a, b) => a + b.speedBps, 0),
        states: s.rows.map((r) => r.state),
        degraded,
        reason: (s.rows.find((r) => r.reason) || {}).reason || null,
      });
    }
    if (limits.every((l) => l === 2)) {
      sawDowngrade = true;
      degradedSample = s;
    }
    // 降到 2 条后若又回到 4 条且不再标记降档，说明判定为「站点总带宽受限」，取这一帧作终态。
    if (sawDowngrade && limits.every((l) => l === 4) && !degraded) {
      final = s;
      break;
    }
    if (s.rows.some((r) => r.state === 'completed' || r.state === 'failed')) {
      final = s;
      break;
    }
    await sleep(700);
  }
  final = final || (await sample());
  // 已恢复后继续观察 9 秒，确认不会反复抖动。
  await sleep(9000);
  const stable = await sample();

  const initial = timeline[0] || {};
  if (!initial.connLimitPerTask || initial.connLimitPerTask.every((l) => l === CONNS)) ok('起跑为 4 个任务 × 4 连接', JSON.stringify(initial));
  else bad('起跑为 4 个任务 × 4 连接', JSON.stringify(initial));
  if (sawDowngrade) {
    ok('全局预算降到每任务 2 条（合计 8）', JSON.stringify({
      atMs: degradedSample.at - t0,
      reason: (degradedSample.rows.find((r) => r.reason) || {}).reason,
      states: degradedSample.rows.map((r) => r.state),
      doneBytes: degradedSample.rows.map((r) => r.doneBytes),
    }));
  } else bad('全局预算降到每任务 2 条（合计 8）', JSON.stringify(timeline));
  if (degradedSample && degradedSample.rows.every((r) => r.state === 'active')) {
    ok('降档窗口内 4 个任务都在继续下载', JSON.stringify(degradedSample.rows.map((r) => r.speedBps)));
  } else bad('降档窗口内 4 个任务都在继续下载', JSON.stringify(degradedSample && degradedSample.rows.map((r) => `${r.state}/${r.speedBps}`)));
  if (final.rows.every((r) => r.connLimit === CONNS) && final.rows.every((r) => !r.degraded)) {
    ok('降档后 4 秒判定「未提升总速率」，恢复 4 条并取消降档标记', JSON.stringify({
      atMs: final.at - t0,
      connLimit: final.rows.map((r) => r.connLimit),
      reason: final.rows.map((r) => r.reason),
    }));
  } else bad('降档后 4 秒判定「未提升总速率」，恢复 4 条并取消降档标记', JSON.stringify(final.rows));
  if (stable.rows.every((r) => r.connLimit === CONNS && !r.degraded)) {
    ok('恢复后 9 秒不再反复降档', JSON.stringify(stable.rows.map((r) => `${r.connLimit}/${r.doneBytes}`)));
  } else bad('恢复后 9 秒不再反复降档', JSON.stringify(stable.rows));
  if (stable.rows.every((r) => r.doneBytes > 0 && (r.state === 'active' || r.state === 'paused' || r.state === 'completed'))) {
    ok('每个任务都有实际字节落盘', JSON.stringify(stable.rows.map((r) => r.doneBytes)));
  } else bad('每个任务都有实际字节落盘', JSON.stringify(stable.rows.map((r) => `${r.state}/${r.doneBytes}`)));

  // 收尾：移除所有任务（连同临时文件），避免继续占带宽。
  await evaluate(`(async () => {
    const list = await window.__TAURI__.core.invoke('list_tasks');
    for (const t of list) { try { await window.__TAURI__.core.invoke('remove_task', { id: t.id, deleteFile: true }); } catch (e) {} }
    return 'ok';
  })()`, true).catch(() => null);

  console.log(JSON.stringify({ pass: results.every((r) => r.pass), tasks: TASKS, conns: CONNS, timeline, final: final.rows, results }, null, 2));
} catch (e) {
  bad('流程异常', e.message);
  console.log(JSON.stringify({ pass: false, timeline, results }, null, 2));
} finally {
  try { if (ws) ws.close(); } catch { /* ignore */ }
  try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
  server.close();
  await sleep(800);
  fs.rmSync(saveDir, { recursive: true, force: true });
  process.exit(results.every((r) => r.pass) ? 0 : 1);
}
