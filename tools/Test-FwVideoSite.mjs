// 真实站点视频链路实测：界面解析 → 选择格式 → 加入下载 → 解析器进度 → ffprobe 核对成品。
//
// 应用以 FW_SMOKE=1 隐藏启动，只通过 WebView2 远程调试操作；下载目录用临时目录，不污染 Downloads。
// 用法：node tools/Test-FwVideoSite.mjs <fetchweir.exe> <视频页 URL> [formatId|auto] [标签]
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXE = process.argv[2];
const PAGE = process.argv[3];
const WANT = process.argv[4] || 'auto';
const LABEL = process.argv[5] || 'site';
if (!EXE || !PAGE) {
  console.error('用法: node tools/Test-FwVideoSite.mjs <fetchweir.exe> <url> [formatId|auto] [label]');
  process.exit(2);
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'docs', 'ui-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const saveDir = path.join(os.tmpdir(), 'fw-video-e2e', LABEL);
fs.rmSync(saveDir, { recursive: true, force: true });
fs.mkdirSync(saveDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
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

/* 直接跑解析器拿完整格式矩阵，用来核对界面/后端 DTO 是否与真实可下格式一一对应。 */
function ytdlpMatrix(url) {
  const exe = path.join(path.dirname(EXE), process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  const out = execFileSync(exe, ['-J', '--no-playlist', '--no-warnings', '--skip-download', url], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const j = JSON.parse(out);
  const entry = Array.isArray(j.entries) && j.entries.length ? j.entries[0] : j;
  return { entry, formats: (entry.formats || []).filter((f) => f.format_id) };
}

function ffprobeOf(file) {
  let exe = process.env.FFPROBE || '';
  if (!exe) {
    try {
      exe = execFileSync('where', ['ffprobe'], { encoding: 'utf8' }).split(/\r?\n/).find((l) => l.trim()) || '';
    } catch { /* 不在 PATH */ }
  }
  if (!exe) return { error: '未找到 ffprobe' };
  const out = execFileSync(exe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const j = JSON.parse(out);
  const v = j.streams.find((s) => s.codec_type === 'video') || {};
  const a = j.streams.find((s) => s.codec_type === 'audio') || {};
  return {
    format: j.format.format_name,
    size: Number(j.format.size),
    duration: Number(j.format.duration),
    bitrate: Number(j.format.bit_rate),
    video: { codec: v.codec_name, profile: v.profile, width: v.width, height: v.height, fps: v.r_frame_rate, br: Number(v.bit_rate) || null },
    audio: { codec: a.codec_name, channels: a.channels, sampleRate: a.sample_rate, br: Number(a.bit_rate) || null },
  };
}

let ws;
const result = { page: PAGE, label: LABEL, formats: [], picked: null, jobEvents: [], file: null, probe: null, checks: [] };
const ok = (n, d) => result.checks.push({ name: n, pass: true, detail: d });
const bad = (n, d) => result.checks.push({ name: n, pass: false, detail: d });
try {
  let page = null;
  for (let i = 0; i < 300 && !page; i++) {
    try {
      const arr = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = arr.find((x) => x.type === 'page' && /tauri\.localhost/.test(x.url || ''));
    } catch { /* */ }
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
  await rpc('Page.enable');
  for (let i = 0; i < 120; i++) {
    if (await evaluate(`!!(window.__TAURI__ && window.__TAURI__.core)`)) break;
    await sleep(150);
  }
  const shot = async (name) => {
    await rpc('Page.captureScreenshot', { format: 'png' }).then((r) => {
      fs.writeFileSync(path.join(SHOTS, `video-${LABEL}-${name}.png`), Buffer.from(r.data, 'base64'));
    });
  };

  // 设置页那行工具状态来自后端真实探测，这里顺带核对一次。
  result.tools = JSON.parse(await evaluate(`(async () => JSON.stringify(await window.__TAURI__.core.invoke('video_tools')))()`, true));
  if (result.tools && result.tools.ytdlp) ok('后端找到 yt-dlp', result.tools.ytdlp);
  else bad('后端找到 yt-dlp', JSON.stringify(result.tools));
  if (result.tools && result.tools.ffmpeg) ok('后端找到 ffmpeg', result.tools.ffmpeg);
  else bad('后端找到 ffmpeg', JSON.stringify(result.tools));

  // 打开「视频解析」工具页（navVideoTool），并确认它真的可见——不能对着隐藏 DOM 操作。
  let visible = false;
  for (let i = 0; i < 20; i++) {
    await evaluate(`document.getElementById('navVideoTool').click(); 'ok'`);
    await sleep(250);
    visible = await evaluate(`(() => {
      const v = document.getElementById('viewVideo');
      const u = document.getElementById('videoUrl');
      return !v.hidden && !!u && u.offsetParent !== null;
    })()`);
    if (visible) break;
  }
  if (!visible) throw new Error('视频解析工具页没有打开（viewVideo 仍隐藏）');
  ok('视频解析工具页可见', 'viewVideo 显示，URL 输入框可交互');
  await shot('0-page');
  await evaluate(`(() => {
    const i = document.getElementById('videoUrl');
    i.value = ${JSON.stringify(PAGE)};
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return 'ok';
  })()`);
  let info = null;
  const tProbe = now();
  for (let i = 0; i < 700; i++) {
    info = JSON.parse(await evaluate(`(async () => {
      const rows = document.querySelectorAll('#fmtBody tr[data-fmt]').length;
      const empty = document.getElementById('vidEmpty');
      const txt = empty.hidden ? '' : empty.textContent.trim();
      if (rows) return JSON.stringify({ rows });
      if (/解析失败|请输入/.test(txt)) return JSON.stringify({ error: txt });
      return JSON.stringify({
        rows: 0, empty: txt.slice(0, 120),
        grid: !document.getElementById('vidGrid').hidden,
        tabs: document.getElementById('tabNVideo').textContent + '/' + document.getElementById('tabNAudio').textContent,
        body: (document.getElementById('fmtBody').innerText || '').slice(0, 120)
      });
    })()`, true));
    if (info && info.rows) break;
    if (info && info.error) break;
    await sleep(200);
  }
  if (!info || !info.rows) throw new Error(`界面解析未产出格式行：${JSON.stringify(info)}（${now() - tProbe}ms）`);
  const rowsExpr = `JSON.stringify(Array.from(document.querySelectorAll('#fmtBody tr[data-fmt]')).map((tr) => ({ id: tr.dataset.fmt, text: tr.innerText.replace(/\\s+/g, ' ').trim(), off: tr.classList.contains('off') })))`;
  let rows = JSON.parse(await evaluate(rowsExpr));
  result.formats = rows;
  result.tabs = JSON.parse(await evaluate(`JSON.stringify({
    video: document.getElementById('tabNVideo').textContent,
    audio: document.getElementById('tabNAudio').textContent
  })`));
  ok('界面解析出格式行', `${rows.length} 行，标签计数 ${JSON.stringify(result.tabs)}，用时 ${now() - tProbe}ms`);
  // 指定的是音频档时，切到「音频」标签再取一次行。
  if (WANT !== 'auto' && !rows.some((r) => r.id === WANT)) {
    await evaluate(`(() => { const b = document.querySelector('#fmtTabs button[data-tab="audio"]'); if (b) b.click(); return 'ok'; })()`);
    await sleep(400);
    const audioRows = JSON.parse(await evaluate(rowsExpr));
    result.audioFormats = audioRows;
    rows = rows.concat(audioRows);
  }

  // 格式真实性核对：后端 DTO（界面渲染的数据源）与解析器 -J 的原始矩阵逐档对照。
  try {
    const dto = JSON.parse(await evaluate(`(async () => JSON.stringify(await window.__TAURI__.core.invoke('probe_video', { url: ${JSON.stringify(PAGE)} })))()`, true));
    const raw = ytdlpMatrix(PAGE);
    const byId = new Map(raw.formats.map((f) => [f.format_id, f]));
    const idsDto = dto.formats.map((f) => f.formatId);
    const missing = [...byId.keys()].filter((k) => !idsDto.includes(k));
    const extra = idsDto.filter((k) => !byId.has(k));
    const diff = [];
    for (const f of dto.formats) {
      const r = byId.get(f.formatId);
      if (!r) continue;
      const str = (v) => (v == null ? '' : String(v));
      const want = {
        width: r.width || 0, height: r.height || 0, ext: str(r.ext),
        vcodec: str(r.vcodec), acodec: str(r.acodec), tbr: r.tbr || 0,
        size: Math.max(r.filesize || 0, r.filesize_approx || 0),
        fps: r.fps || 0, protocol: str(r.protocol),
      };
      const d = {};
      const num = (k) => Math.abs((Number(want[k]) || 0) - (Number(f[k]) || 0)) <= (k === 'tbr' || k === 'fps' ? 0.01 : 0);
      const eq = (k) => String(want[k]) === String(f[k]);
      for (const k of ['width', 'height', 'tbr', 'size', 'fps']) if (!num(k)) d[k] = { ytdlp: want[k], ui: f[k] };
      for (const k of ['ext', 'vcodec', 'acodec', 'protocol']) if (!eq(k)) d[k] = { ytdlp: want[k], ui: f[k] };
      const wantMux = !!r.vcodec && r.vcodec !== 'none' && (!r.acodec || r.acodec === 'none');
      if (!!f.needsMux !== wantMux) d.needsMux = { ytdlp: wantMux, ui: f.needsMux };
      if (Object.keys(d).length) diff.push({ id: f.formatId, diff: d });
    }
    const tabTotal = Number(result.tabs.video) + Number(result.tabs.audio);
    result.matrix = {
      uiCount: dto.formats.length, ytdlpCount: raw.formats.length, tabTotal,
      missing, extra, diff,
      title: { ui: dto.title, ytdlp: raw.entry.title || '' },
      duration: { ui: dto.duration, ytdlp: raw.entry.duration || 0 },
      drmOnly: dto.drmOnly,
    };
    const clean = !missing.length && !extra.length && !diff.length && tabTotal === raw.formats.length;
    if (clean) ok('格式矩阵与解析器逐档一致', `${dto.formats.length} 档：分辨率/编码/码率/体积/协议/是否需合并全部对上；标题与时长一致`);
    else bad('格式矩阵与解析器逐档一致', JSON.stringify(result.matrix));
  } catch (e) {
    bad('格式矩阵与解析器逐档一致', e.message);
  }

  // auto：取分辨率最高的一档，同分辨率优先 H.264（兼容性最好）。
  const score = (r) => {
    const m = /^(\d+)×(\d+)/.exec(r.text);
    return (m ? Number(m[2]) : 0) * 10 + (r.text.includes('H.264') ? 1 : 0);
  };
  const pick = WANT === 'auto'
    ? rows.filter((r) => !r.off).sort((a, b) => score(b) - score(a))[0].id
    : WANT;
  const row = rows.find((r) => r.id === pick);
  if (!row) throw new Error(`界面里没有 formatId=${pick}`);
  if (row.off) throw new Error(`界面把 ${pick} 标记为不可下载：${row.text}`);
  await evaluate(`(() => { const tr = document.querySelector('#fmtBody tr[data-fmt="${pick}"]'); tr.click(); return 'ok'; })()`);
  await sleep(400);
  const picked = JSON.parse(await evaluate(`JSON.stringify({
    hint: document.getElementById('fmtHint').textContent,
    video: document.getElementById('outVideo').textContent,
    audio: document.getElementById('outAudio').textContent,
    total: document.getElementById('outTotal').textContent,
    compat: document.getElementById('vidCompat').innerText.replace(/\\s+/g, ' ').trim(),
    btnDisabled: document.getElementById('btnVideoDownload').disabled
  })`));
  result.picked = Object.assign({ formatId: pick, row: row.text }, picked);
  if (!picked.btnDisabled) ok('选中格式后「加入下载」可用', JSON.stringify(picked));
  else bad('选中格式后「加入下载」可用', JSON.stringify(picked));
  await shot('1-format');

  // 用同一页面的监听收集解析器事件，再以命令方式发起下载（目录指向临时目录）。
  await evaluate(`(async () => {
    window.__fwEvents = [];
    await window.__TAURI__.event.listen('fw://video', (e) => window.__fwEvents.push(e.payload));
    return 'ok';
  })()`, true);
  const started = JSON.parse(await evaluate(`(async () => {
    const r = await window.__TAURI__.core.invoke('add_video_task', {
      url: ${JSON.stringify(PAGE)}, formatId: ${JSON.stringify(pick)}, saveDir: ${JSON.stringify(saveDir)}
    });
    return JSON.stringify(r);
  })()`, true));
  result.started = started;
  const tDl = now();
  let done = null;
  let midShot = false;
  if (started.mode === 'direct') {
    // 直链格式走自家分段引擎，进度在任务列表里，不在 fw://video。
    const id = started.task.id;
    while (now() - tDl < 900000) {
      const t = JSON.parse(await evaluate(`(async () => {
        const l = await window.__TAURI__.core.invoke('list_tasks');
        return JSON.stringify(l.find((x) => x.id === ${id}) || null);
      })()`, true));
      if (t) {
        result.task = t;
        if (t.state === 'completed' || t.state === 'failed') {
          done = { stage: t.state === 'completed' ? 'done' : 'failed', path: t.savePath, message: t.error || '' };
          break;
        }
      }
      await sleep(500);
    }
  } else {
    while (now() - tDl < 900000) {
      const evs = JSON.parse(await evaluate(`JSON.stringify(window.__fwEvents || [])`));
      if (evs.length) result.jobEvents = evs.slice(-40);
      const last = evs[evs.length - 1];
      if (last && last.stage === 'running' && !midShot && (last.percent || 0) > 15) {
        midShot = true;
        await shot('2-downloading');
      }
      if (last && (last.stage === 'done' || last.stage === 'failed')) { done = last; break; }
      await sleep(500);
    }
  }
  if (!done) throw new Error('下载 15 分钟未结束');
  if (done.stage !== 'done') throw new Error(`下载失败（${started.mode}）：${done.message}`);
  ok('下载完成', JSON.stringify({ mode: started.mode, ms: now() - tDl, path: done.path }));
  const file = done.path;
  result.file = file;
  if (file && fs.existsSync(file)) {
    const st = fs.statSync(file);
    if (st.size > 0) ok('成品文件已落盘', `${file} · ${st.size} 字节`);
    else bad('成品文件已落盘', '文件为空');
    const pr = ffprobeOf(file);
    result.probe = pr;
    const audioOnly = !!(result.picked && result.picked.video === '—');
    if (audioOnly) {
      if (pr.audio && pr.audio.codec) ok('ffprobe 读到音频轨（纯音频档）', JSON.stringify(pr.audio));
      else bad('ffprobe 读到音频轨（纯音频档）', JSON.stringify(pr));
      if (pr.video && pr.video.width) bad('纯音频档不应含视频轨', JSON.stringify(pr.video));
      else ok('纯音频档不含视频轨', '按预期');
    } else if (pr.video && pr.video.width) {
      ok('ffprobe 读到视频轨', JSON.stringify(pr.video));
      if (pr.audio && pr.audio.codec) ok('ffprobe 读到音频轨（已合并）', JSON.stringify(pr.audio));
      else bad('ffprobe 读到音频轨（已合并）', JSON.stringify(pr.audio));
    } else bad('ffprobe 读到视频轨', JSON.stringify(pr));
  } else bad('成品文件已落盘', String(file));
} catch (e) {
  bad('流程异常', e.message);
  try { if (ws) await rpc(9999, 'Page.captureScreenshot', { format: 'png' }).then((r) => fs.writeFileSync(path.join(SHOTS, `video-${LABEL}-9-error.png`), Buffer.from(r.data, 'base64'))); } catch { /* */ }
} finally {
  try { if (ws) ws.close(); } catch { /* */ }
  try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* */ }
  await sleep(600);
  const body = JSON.stringify(Object.assign({}, result, { pass: result.checks.every((c) => c.pass) }), null, 2);
  fs.mkdirSync(path.join(ROOT, 'docs', 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'docs', 'evidence', `video-${LABEL}.json`), body);
  console.log(body);
  process.exit(result.checks.every((c) => c.pass) ? 0 : 1);
}
