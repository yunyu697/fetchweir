// 性能量化探针：冷启动、空闲 CPU/内存、点击响应、主线程长任务。
// 用法：node tools/Measure-FwPerf.mjs --exe <Fetchweir.exe> --label before [--load]
// 依赖 WebView2 远程调试端口（脚本自动设置 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS）。
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes('--' + name);

const exe = path.resolve(arg('exe', ''));
const label = arg('label', 'run');
const port = Number(arg('port', '9351'));
if (!exe || !fs.existsSync(exe)) {
  console.error('缺少 --exe 或文件不存在：' + exe);
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

/* ---------- 进程树采样（CPU 秒 / 工作集） ---------- */
function sampleTree(rootPid) {
  const ps = `
$root = ${rootPid}
$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name
$ids = New-Object System.Collections.Generic.List[int]
$ids.Add($root)
$changed = $true
while ($changed) {
  $changed = $false
  foreach ($p in $all) {
    if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)) {
      $ids.Add([int]$p.ProcessId); $changed = $true
    }
  }
}
$out = @()
foreach ($id in $ids) {
  $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($proc) {
    $out += [pscustomobject]@{
      id = $id
      name = $proc.ProcessName
      cpu = $proc.TotalProcessorTime.TotalSeconds
      ws = $proc.WorkingSet64
      threads = $proc.Threads.Count
    }
  }
}
$out | ConvertTo-Json -Compress
`;
  try {
    const raw = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8',
      timeout: 30000
    }).trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (e) {
    return [];
  }
}
const sumBy = (rows, key) => rows.reduce((a, r) => a + (Number(r[key]) || 0), 0);

/* ---------- 可选：本地限速下载源，制造真实进度事件 ---------- */
function startLocalSource(sizeMb = 48, mbps = 8) {
  const total = sizeMb * 1024 * 1024;
  const chunk = 64 * 1024;
  const perTick = Math.max(1, Math.round((mbps * 1024 * 1024) / 1000 / chunk));
  const buf = Buffer.alloc(chunk, 0x61);
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/big.bin')) {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(total),
        'Accept-Ranges': 'bytes'
      });
      let sent = 0;
      const timer = setInterval(() => {
        for (let i = 0; i < perTick && sent < total; i++) {
          const n = Math.min(chunk, total - sent);
          res.write(n === chunk ? buf : buf.subarray(0, n));
          sent += n;
        }
        if (sent >= total) { clearInterval(timer); res.end(); }
      }, 20);
      req.on('close', () => clearInterval(timer));
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/* ---------- CDP ---------- */
async function waitTarget(pid, deadline) {
  while (now() < deadline) {
    try {
      const arr = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = arr.find((x) => x.type === 'page' && /tauri\.localhost/.test(x.url || ''));
      if (page) return page;
    } catch { /* 端口未就绪 */ }
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
  const r = await rpc(ws, id, 'Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'evaluate failed');
  return r.result.value;
}

const dataDir = path.join(process.env.APPDATA || os.homedir(), 'Fetchweir');
const readyFile = path.join(dataDir, 'ui-ready.txt');

if (fs.existsSync(readyFile)) fs.unlinkSync(readyFile);
const src = flag('load') ? await startLocalSource() : null;

const env = {
  ...process.env,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
  FW_NO_ELEVATE: '1'
};
const t0 = now();
const child = spawn(exe, [], { cwd: path.dirname(exe), env, detached: false, stdio: 'ignore' });
const pid = child.pid;

let ws;
try {
  const page = await waitTarget(pid, t0 + 60000);
  const tTarget = now();
  const tConnect0 = now();
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  const tConnect = now();
  let id = 1;
  await rpc(ws, id++, 'Runtime.enable', {});
  await rpc(ws, id++, 'Performance.enable', {});

  // 长任务观察器要在测量窗口前挂上。
  await evaluate(ws, id++, `
    self.__fwLt = [];
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) self.__fwLt.push({ t: e.startTime, d: e.duration });
      }).observe({ entryTypes: ['longtask'] });
    } catch (e) {}
    'ok'
  `);

  // 冷启动：进程启动 → ui-ready.txt 落盘（boot 中所有 invoke 完成）
  let tReady = null;
  while (now() < t0 + 60000) {
    if (fs.existsSync(readyFile)) {
      const txt = fs.readFileSync(readyFile, 'utf8').trim();
      const stamp = Number((txt.split(/\s+/)[1] || '0'));
      if (stamp > 0) { tReady = stamp; break; }
    }
    await sleep(50);
  }
  const domReady = await evaluate(ws, id++, `JSON.stringify({
    ready: document.readyState,
    rows: document.querySelectorAll('#taskList .row').length,
    nav: document.querySelectorAll('.sb').length
  })`);

  let loadInfo = null;
  if (src) {
    const url = `http://127.0.0.1:${src.port}/big.bin?${Date.now()}`;
    loadInfo = await evaluate(ws, id++, `(async () => {
      const dir = ${JSON.stringify(path.join(os.tmpdir(), 'fw-perf-dl'))};
      try {
        const t = await window.__TAURI__.core.invoke('add_task', {
          url: ${JSON.stringify(url)}, saveDir: dir, fileName: 'perf-load.bin',
          connections: 8, autoStart: true
        });
        return JSON.stringify({ ok: true, id: t && t.id });
      } catch (e) { return JSON.stringify({ ok: false, err: String(e && e.message || e) }); }
    })()`, true);
    await sleep(2500);
  }

  // 点击响应：逐项切换导航，测同步处理耗时与下一帧延迟。
  const clickExpr = `(async () => {
    const ids = ['navMain', 'navVideo', 'navSniff', 'navSettings'];
    const out = [];
    for (let round = 0; round < 5; round++) {
      for (const nid of ids) {
        const node = document.getElementById(nid);
        if (!node) continue;
        const t1 = performance.now();
        node.click();
        const t2 = performance.now();
        const frame = await new Promise((r) => requestAnimationFrame(() => r(performance.now())));
        out.push({ id: nid, handler: +(t2 - t1).toFixed(2), frame: +(frame - t1).toFixed(2) });
      }
    }
    return JSON.stringify(out);
  })()`;
  const clicks = JSON.parse(await evaluate(ws, id++, clickExpr, true) || '[]');

  // 空闲/负载采样窗口
  const sample1 = sampleTree(pid);
  const ltStart = await evaluate(ws, id++, 'performance.now()');
  const s1 = now();
  await sleep(12000);
  const s2 = now();
  const ltEnd = await evaluate(ws, id++, 'performance.now()');
  const sample2 = sampleTree(pid);
  const lt = JSON.parse(await evaluate(ws, id++, 'JSON.stringify(self.__fwLt || [])') || '[]')
    .filter((e) => e.t >= ltStart && e.t <= ltEnd);

  const cores = os.cpus().length;
  const cpu1 = sumBy(sample1, 'cpu');
  const cpu2 = sumBy(sample2, 'cpu');
  const cpuPct = (cpu2 - cpu1) / ((s2 - s1) / 1000) / cores * 100;
  const memMb = sumBy(sample2, 'ws') / 1024 / 1024;
  const procs = sample2.map((p) => p.name).reduce((a, n) => (a[n] = (a[n] || 0) + 1, a), {});

  const handlerAvg = clicks.length ? clicks.reduce((a, c) => a + c.handler, 0) / clicks.length : 0;
  const handlerMax = clicks.length ? Math.max(...clicks.map((c) => c.handler)) : 0;
  const frameAvg = clicks.length ? clicks.reduce((a, c) => a + c.frame, 0) / clicks.length : 0;
  const frameMax = clicks.length ? Math.max(...clicks.map((c) => c.frame)) : 0;

  const result = {
    label,
    exe,
    at: new Date().toISOString(),
    load: !!src,
    coldStartMs: tReady ? tReady - t0 : null,
    targetMs: tTarget - t0,
    connectMs: tConnect - tConnect0,
    domReady: JSON.parse(domReady || '{}'),
    loadInfo: loadInfo ? JSON.parse(loadInfo) : null,
    click: {
      samples: clicks.length,
      handlerAvgMs: +handlerAvg.toFixed(2),
      handlerMaxMs: +handlerMax.toFixed(2),
      frameAvgMs: +frameAvg.toFixed(1),
      frameMaxMs: +frameMax.toFixed(1)
    },
    idleWindowSec: +((s2 - s1) / 1000).toFixed(1),
    cpuPct: +cpuPct.toFixed(2),
    memMb: +memMb.toFixed(1),
    processCount: sample2.length,
    processNames: procs,
    longTasks: {
      count: lt.length,
      totalMs: +lt.reduce((a, e) => a + e.d, 0).toFixed(1),
      maxMs: +(lt.length ? Math.max(...lt.map((e) => e.d)) : 0).toFixed(1)
    }
  };
  const outDir = path.join(process.cwd(), 'docs', 'perf');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${label}.json`);
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  console.log('WROTE ' + outFile);
} finally {
  try { if (ws) ws.close(); } catch { /* ignore */ }
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
  if (src) src.server.close();
}
