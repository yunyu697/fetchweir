// 批量嗅探下载实测：本地 HTTP 服务 + Native Messaging 端点注入 5 条嗅探项 + 界面批量入队。
//
// 覆盖：一次多选入队、并发上限（全局连接预算）、失败重试（503 两次后成功）、
// 部分失败（404）时的状态表达。应用以 FW_SMOKE=1 隐藏启动，只通过 WebView2 远程调试操作。
// 用法：node tools/Test-FwSniffBatch.mjs <fetchweir.exe>
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXE = process.argv[2];
if (!EXE) {
  console.error('用法: node tools/Test-FwSniffBatch.mjs <fetchweir.exe>');
  process.exit(2);
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'docs', 'ui-shots');
const EVID = path.join(ROOT, 'docs', 'evidence');
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(EVID, { recursive: true });
const saveDir = path.join(os.tmpdir(), 'fw-sniff-batch');
fs.rmSync(saveDir, { recursive: true, force: true });
fs.mkdirSync(saveDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

/* ---------------- 本地测试源 ---------------- */
// 8 个正常文件 + 1 个前两次 503 的 flaky + 1 个前三次 429 的 throttle + 1 个 404 的 missing。
// 429/503 合计 5 次命中，用来验证「10 秒内 3 次 429/503 全局砍半」。
const MB = 1024 * 1024;
const OKS = Array.from({ length: 8 }, (_, i) => `ok-${String.fromCharCode(97 + i)}.bin`);
const bodies = {
  ...Object.fromEntries(OKS.map((n, i) => [n, Buffer.alloc(8 * MB, 0x41 + i)])),
  'flaky.bin': Buffer.alloc(4 * MB, 0x44),
  'throttle.bin': Buffer.alloc(4 * MB, 0x45),
};
const expectSha = Object.fromEntries(Object.entries(bodies).map(([k, v]) => [k, crypto.createHash('sha256').update(v).digest('hex')]));
const TOTAL = OKS.length + 3;
const stats = { reqs: {}, r503: 0, r429: 0, r404: 0, active: 0, activePeak: 0, perActive: {}, perPeak: {}, perReq: {} };

const httpPort = await new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

async function pump(res, body, start, end) {
  let pos = start;
  while (pos <= end) {
    if (res.destroyed) return;
    const n = Math.min(16 * 1024, end - pos + 1);
    res.write(body.subarray(pos, pos + n));
    pos += n;
    await sleep(150); // 每连接 ~107 KB/s（高于 96 KB/s 的低速阈值，只让 429/503 触发砍半）
  }
  res.end();
}

const server = http.createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://x').pathname.replace(/^\//, ''));
  stats.reqs[name] = (stats.reqs[name] || 0) + 1;
  stats.perReq[name] = (stats.perReq[name] || 0) + 1;
  if (name === 'missing.bin') { stats.r404++; res.writeHead(404).end('not found'); return; }
  const body = bodies[name];
  if (!body) { stats.r404++; res.writeHead(404).end('not found'); return; }
  // 探测是第 1 个请求（不走 on_throttle），限流要落在分段请求上才验证得到预算降档。
  if (name === 'flaky.bin' && (stats.perReq[name] === 2 || stats.perReq[name] === 3)) {
    stats.r503++;
    res.writeHead(503, { 'Retry-After': '0' }).end('busy');
    return;
  }
  if (name === 'throttle.bin' && stats.perReq[name] >= 4 && stats.perReq[name] <= 6) {
    stats.r429++;
    res.writeHead(429, { 'Retry-After': '0' }).end('too many');
    return;
  }
  let start = 0;
  let end = body.length - 1;
  let status = 200;
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (m) {
    status = 206;
    if (m[1]) start = Number(m[1]);
    if (m[2]) end = Math.min(Number(m[2]), body.length - 1);
  }
  stats.active++;
  stats.activePeak = Math.max(stats.activePeak, stats.active);
  stats.perActive[name] = (stats.perActive[name] || 0) + 1;
  stats.perPeak[name] = Math.max(stats.perPeak[name] || 0, stats.perActive[name]);
  const done = () => {
    stats.active--;
    stats.perActive[name]--;
  };
  res.on('close', done);
  const headers = { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${body.length}`;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  pump(res, body, start, end);
});
await new Promise((r) => server.listen(httpPort, '127.0.0.1', r));

/* ---------------- 启动应用 ---------------- */
const cdpPort = await new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const child = spawn(EXE, [], {
  cwd: path.dirname(EXE),
  env: { ...process.env, FW_SMOKE: '1', FW_NO_ELEVATE: '1', WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}` },
  stdio: 'ignore',
  windowsHide: true,
});

let ws;
let ids = [];
let origSettings = null;
let invoke = null;
let uiSetDir = null;
const result = { labels: [], tasks: [], samples: [], server: null, checks: [], before: [], after: [] };
const ok = (n, d) => result.checks.push({ name: n, pass: true, detail: d });
const bad = (n, d) => result.checks.push({ name: n, pass: false, detail: d });

async function injectSniff(dataDir) {
  const epFile = path.join(dataDir, 'nm-endpoint.json');
  let ep = null;
  for (let i = 0; i < 200 && !ep; i++) {
    try { ep = JSON.parse(fs.readFileSync(epFile, 'utf8')); } catch { await sleep(150); }
  }
  if (!ep) throw new Error('nm-endpoint.json 未出现，扩展端点没起来');
  const sock = net.connect(ep.port, '127.0.0.1');
  await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
  sock.write(`AUTH ${ep.token}\n`);
  const replies = [];
  let buf = '';
  sock.on('data', (d) => { buf += d.toString('utf8'); let i; while ((i = buf.indexOf('\n')) >= 0) { replies.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const items = [
    ...OKS.map((n) => ({ url: `http://127.0.0.1:${httpPort}/${n}`, kind: 'file', mime: 'application/octet-stream', size: 8 * MB, ranges: true })),
    { url: `http://127.0.0.1:${httpPort}/flaky.bin`, kind: 'file', mime: 'application/octet-stream', size: 4 * MB, ranges: true },
    { url: `http://127.0.0.1:${httpPort}/throttle.bin`, kind: 'file', mime: 'application/octet-stream', size: 4 * MB, ranges: true },
    { url: `http://127.0.0.1:${httpPort}/missing.bin`, kind: 'file', mime: 'application/octet-stream', size: 1 * MB, ranges: true },
  ];
  for (const it of items) {
    sock.write(`${JSON.stringify({ type: 'sniff', item: { ...it, pageUrl: 'http://127.0.0.1/', pageTitle: '批量嗅探实测', browser: 'chrome', source: 'extension' } })}\n`);
    result.labels.push(it.url.split('/').pop());
  }
  for (let i = 0; i < 100 && replies.length < items.length; i++) await sleep(100);
  sock.end();
  const accepted = replies.filter((r) => r.ok).length;
  if (accepted !== items.length) throw new Error(`端点只接受了 ${accepted}/${items.length} 条嗅探项：${JSON.stringify(replies).slice(0, 300)}`);
  ok(`Native 端点收下 ${items.length} 条嗅探项`, JSON.stringify(replies));
}

try {
  let page = null;
  for (let i = 0; i < 300 && !page; i++) {
    try {
      const arr = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      page = arr.find((x) => x.type === 'page' && /tauri\.localhost/.test(x.url || ''));
    } catch { /* 还没起来 */ }
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
  invoke = async (cmd, args) => JSON.parse(await evaluate(`(async () => JSON.stringify(await window.__TAURI__.core.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args || {})})))()`, true));
  await rpc('Runtime.enable');
  await rpc('Page.enable');
  for (let i = 0; i < 120; i++) {
    if (await evaluate(`!!(window.__TAURI__ && window.__TAURI__.core)`)) break;
    await sleep(150);
  }
  const shot = async (name) => {
    const r = await rpc('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, `sniff-batch-${name}.png`), Buffer.from(r.data, 'base64'));
  };

  result.before = await invoke('list_tasks');
  const info = await invoke('app_info');
  // 走真实设置输入框切下载目录：前端 state.settings 与后端一起更新，
  // 否则前端入队时会把启动时缓存的旧目录显式传给后端（本轮第一次就踩到了）。
  uiSetDir = async (dir) => {
    await evaluate(`(() => { const i = document.getElementById('setDir'); i.value = ${JSON.stringify(dir)}; i.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`);
    for (let i = 0; i < 40; i++) {
      await sleep(150);
      const s = await invoke('get_settings');
      const got = s.downloadDir || '';
      if (got && path.resolve(got).toLowerCase() === path.resolve(dir).toLowerCase()) return got;
    }
    return (await invoke('get_settings')).downloadDir || '';
  };
  origSettings = await invoke('get_settings');
  const dl = await uiSetDir(saveDir);
  result.downloadDir = dl;
  if (dl && path.resolve(dl).toLowerCase() === path.resolve(saveDir).toLowerCase()) ok('下载目录已切到临时目录', dl);
  else bad('下载目录已切到临时目录', `${dl} != ${saveDir}`);
  await injectSniff(info.dataDir);

  // 打开嗅探页，等全部行出现。
  let visible = false;
  for (let i = 0; i < 20; i++) {
    await evaluate(`document.getElementById('navSniff').click(); 'ok'`);
    await sleep(250);
    visible = await evaluate(`(() => {
      const v = document.getElementById('viewSniff');
      return !v.hidden && document.querySelectorAll('#sniffGroups .sn').length >= ${TOTAL};
    })()`);
    if (visible) break;
  }
  if (!visible) throw new Error(`嗅探页没有出现 ${TOTAL} 行（viewSniff 隐藏或行数不足）`);
  ok(`嗅探页可见且列出 ${TOTAL} 项`, 'viewSniff 显示');

  // 逐行点选（等于用户多选），再点「加入下载」。
  await evaluate(`(() => { document.querySelectorAll('#sniffGroups .sn').forEach((r) => r.click()); return 'ok'; })()`);
  await sleep(300);
  const selText = await evaluate(`document.getElementById('sniffSelCount').textContent`);
  const addText = await evaluate(`document.getElementById('btnSniffAdd').textContent.trim()`);
  result.selection = { selText, addText };
  if (new RegExp(`\\b${TOTAL}\\b`).test(selText)) ok(`界面选中 ${TOTAL} 项`, `${selText} · 按钮「${addText}」`);
  else bad(`界面选中 ${TOTAL} 项`, selText);
  await shot('1-list');

  await evaluate(`document.getElementById('btnSniffAdd').click(); 'ok'`);

  // 等待全部新任务出现
  for (let i = 0; i < 80; i++) {
    const list = await invoke('list_tasks');
    const before = new Set(result.before.map((t) => t.id));
    ids = list.filter((t) => !before.has(t.id)).map((t) => t.id);
    if (ids.length >= TOTAL) break;
    await sleep(200);
  }
  if (ids.length !== TOTAL) throw new Error(`只入队 ${ids.length}/${TOTAL} 个任务`);
  ok(`一次多选入队 ${TOTAL} 个任务`, `id=${ids.join(',')}`);

  // 采样：并发数、每任务连接数、状态流转
  const t0 = now();
  let lastSig = '';
  let midShot = false;
  let final = [];
  while (now() - t0 < 180000) {
    const list = (await invoke('list_tasks')).filter((t) => ids.includes(t.id));
    final = list;
    const sig = list.map((t) => `${t.state}:${t.connLimit}`).join('|');
    if (sig !== lastSig) {
      lastSig = sig;
      result.samples.push({
        t: now() - t0,
        tasks: list.map((t) => ({ id: t.id, state: t.state, conns: t.connLimit, asked: t.connections, done: t.doneBytes, total: t.totalBytes, reason: t.connReason || null, error: t.error || null })),
      });
    }
    if (!midShot && list.some((t) => t.state === 'active')) {
      midShot = true;
      await evaluate(`document.getElementById('navAll').click(); 'ok'`);
      await sleep(400);
      await shot('2-active');
      await evaluate(`document.getElementById('navSniff').click(); 'ok'`);
    }
    if (list.length === TOTAL && list.every((t) => t.state === 'completed' || t.state === 'failed')) break;
    await sleep(250);
  }
  result.tasks = final;
  const terminal = final.length === TOTAL && final.every((t) => t.state === 'completed' || t.state === 'failed');
  if (terminal) ok(`${TOTAL} 个任务全部到达终态`, `${now() - t0}ms`);
  else bad(`${TOTAL} 个任务全部到达终态`, JSON.stringify(final.map((t) => [t.state, t.error])));

  const outside = final.filter((t) => !path.resolve(t.savePath || '').toLowerCase().startsWith(path.resolve(saveDir).toLowerCase()));
  if (!outside.length) ok('成品都落在设置里的下载目录', saveDir);
  else bad('成品都落在设置里的下载目录', JSON.stringify(outside.map((t) => t.savePath)));

  // 并发上限：任务数没有上限；预算上限是各任务设定之和，429/503 命中后才砍半。
  const peaks = result.samples.map((s) => s.tasks.filter((t) => t.state === 'active').length);
  const maxActive = peaks.length ? Math.max(...peaks) : 0;
  result.maxActive = maxActive;
  if (maxActive >= TOTAL) ok(`${TOTAL} 个任务同时下载（没有任务数上限）`, `活跃峰值 ${maxActive}`);
  else bad(`${TOTAL} 个任务同时下载（没有任务数上限）`, `活跃峰值 ${maxActive}`);

  const sums = result.samples.map((s) => s.tasks.filter((t) => t.state === 'active').reduce((a, t) => a + (t.conns || 0), 0));
  const maxSum = sums.length ? Math.max(...sums) : 0;
  result.maxConnSum = maxSum;
  result.baseConnSum = TOTAL * 8;
  result.server = stats;
  // 预算上限是各任务用户设定之和（每任务 8 条），起跑即满额；429/503 命中 3 次后砍半。
  const timeline = result.samples
    .map((s) => {
      const act = s.tasks.filter((t) => t.state === 'active');
      return { t: s.t, active: act.length, conns: act.reduce((a, t) => a + (t.conns || 0), 0), reason: act.map((t) => t.reason).find(Boolean) || null };
    })
    .filter((x) => x.conns > 0);
  result.connTimeline = timeline;
  const throttleStep = timeline.find((x) => x.reason && /429\/503/.test(x.reason));
  const halvedSum = throttleStep ? throttleStep.conns : null;
  result.throttleReason = throttleStep ? throttleStep.reason : null;
  result.halvedConnSum = halvedSum;
  if (stats.r429 >= 3 && stats.r503 >= 2 && halvedSum != null && halvedSum < maxSum && halvedSum <= Math.floor(result.baseConnSum / 2))
    ok('429/503 命中后全局并发自动砍半', `${throttleStep.t}ms：${throttleStep.reason}（起跑 ${maxSum} → ${halvedSum}）`);
  else bad('429/503 命中后全局并发自动砍半', JSON.stringify({ r429: stats.r429, r503: stats.r503, reason: throttleStep && throttleStep.reason, maxSum, halvedSum }));
  if (stats.activePeak <= result.baseConnSum + TOTAL) ok('服务端并发峰值不超用户设定总和', `峰值 ${stats.activePeak} ≤ ${result.baseConnSum} + 每任务 1 条探测`);
  else bad('服务端并发峰值不超用户设定总和', JSON.stringify({ activePeak: stats.activePeak, perPeak: stats.perPeak }));

  // 失败重试：flaky 前两次 503，之后应下载成功
  const flaky = final.find((t) => /flaky/.test(t.fileName || '') || /flaky/.test(t.url || ''));
  if (flaky && flaky.state === 'completed' && stats.r503 === 2) ok('503 两次后重试成功', `flaky 完成，服务端记录 503 × ${stats.r503}`);
  else bad('503 两次后重试成功', JSON.stringify({ flaky: flaky && { state: flaky.state, error: flaky.error }, r503: stats.r503 }));

  // 部分失败：missing 404 → 任务失败，界面显示需处理
  const missing = final.find((t) => /missing/.test(t.fileName || '') || /missing/.test(t.url || ''));
  if (missing && missing.state === 'failed' && /404/.test(missing.error || '')) ok('404 任务进入失败态并带原因', missing.error);
  else bad('404 任务进入失败态并带原因', JSON.stringify(missing && { state: missing.state, error: missing.error }));

  await evaluate(`document.getElementById('navAll').click(); 'ok'`);
  await sleep(500);
  const listText = await evaluate(`document.getElementById('taskList').innerText`);
  result.listHasError = /需处理/.test(listText);
  if (result.listHasError) ok('任务列表用「需处理」表达部分失败', '列表里出现需处理状态');
  else bad('任务列表用「需处理」表达部分失败', listText.slice(0, 200));
  await shot('3-done');

  // 成品校验：三个正常文件字节级一致
  const files = {};
  for (const [name, sha] of Object.entries(expectSha)) {
    const p = path.join(saveDir, name);
    if (!fs.existsSync(p)) { bad(`成品存在 ${name}`, '文件不存在'); continue; }
    const got = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    files[name] = { size: fs.statSync(p).size, sha256: got, expect: sha };
    if (got === sha) ok(`成品字节一致 ${name}`, `${files[name].size} 字节，sha256 与源一致`);
    else bad(`成品字节一致 ${name}`, JSON.stringify(files[name]));
  }
  result.files = files;
} catch (e) {
  bad('测试执行', e && e.message ? e.message : String(e));
} finally {
  // 清理：删任务与文件、清掉本轮嗅探项、还原下载目录。异常时也必须走完。
  if (ws && invoke) {
    for (const id of ids) { try { await invoke('remove_task', { id, deleteFile: true }); } catch { /* 已删 */ } }
    try {
      const items = await invoke('list_sniff');
      for (const it of items) { if (result.labels.some((l) => it.url.endsWith(`/${l}`))) { try { await invoke('remove_sniff', { id: it.id }); } catch { /* */ } } }
    } catch { /* 嗅探项已随任务清掉 */ }
    try {
      const left = (await invoke('list_tasks')).length;
      ok('清理完成', `剩余任务 ${left}，嗅探项已移除`);
    } catch { bad('清理完成', '无法读取任务列表'); }
    if (origSettings) {
      try {
        if (uiSetDir) await uiSetDir(origSettings.downloadDir);
        else await invoke('save_settings', { settings: origSettings });
        const back = await invoke('get_settings');
        const same = path.resolve(back.downloadDir).toLowerCase() === path.resolve(origSettings.downloadDir).toLowerCase();
        if (same) ok('下载目录已还原', back.downloadDir);
        else bad('下载目录已还原', `${back.downloadDir} != ${origSettings.downloadDir}`);
      } catch (e) { bad('下载目录已还原', e && e.message ? e.message : String(e)); }
    }
  }
  try { ws && ws.close(); } catch { /* */ }
  try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* */ }
  try { server.close(); } catch { /* */ }
  await sleep(600);
  const body = JSON.stringify(Object.assign({}, result, { pass: result.checks.every((c) => c.pass) }), null, 2);
  fs.writeFileSync(path.join(EVID, 'sniff-batch.json'), body);
  console.log(body);
}
