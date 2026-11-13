// Cookie 来源离屏验证：应用以 FW_SMOKE=1 隐藏运行，只通过 WebView2 CDP 操作界面。
// 覆盖：默认来源复现人机校验并展示引导、原始错误收进详情、设置保存并落到 settings.json、
//      浏览器 profile 确实传给 yt-dlp、cookies.txt 缺失时提示并回退为不使用。
// 用法：node tools/Test-FwCookie.mjs [exe]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXE = process.argv[2] || path.join('D:', 'fw-build', 'fetchweir', 'debug', 'fetchweir.exe');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'docs', 'ui-shots');
const SETTINGS = path.join(process.env.APPDATA || os.homedir(), 'Fetchweir', 'settings.json');
const VIDEO = 'https://www.youtube.com/watch?v=-yqNI2GfXMQ';
const MISSING_COOKIES = path.join(process.env.TEMP || '.', 'fw-cookies-not-exist.txt');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (name, detail) => results.push({ name, pass: true, detail });
const bad = (name, detail) => results.push({ name, pass: false, detail });
const check = (name, pass, detail) => (pass ? ok(name, detail) : bad(name, detail));

fs.mkdirSync(SHOTS, { recursive: true });
if (fs.existsSync(MISSING_COOKIES)) fs.rmSync(MISSING_COOKIES);

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}

async function attachApp(port) {
  for (let i = 0; i < 120; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const target = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'));
      if (target) return await connect(target);
    } catch { /* 还没起来 */ }
    await sleep(200);
  }
  throw new Error('应用 WebView2 调试目标未就绪');
}

async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let seq = 1;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = seq++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} 超时`)); }, 20000);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
  });
  await send('Page.enable');
  await send('Runtime.enable');
  return { send, close: () => ws.close() };
}

async function evalIn(conn, expression, awaitPromise = false) {
  const out = await conn.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (out.exceptionDetails) {
    throw new Error(out.exceptionDetails.exception && out.exceptionDetails.exception.description || out.exceptionDetails.text);
  }
  return out.result.value;
}

async function shot(conn, name) {
  const out = await conn.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(SHOTS, name);
  fs.writeFileSync(file, Buffer.from(out.data, 'base64'));
  return file;
}

async function waitFor(conn, expr, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      if (await evalIn(conn, expr)) return true;
    } catch { /* 页面切换中 */ }
    await sleep(250);
  }
  throw new Error(`等待超时：${label}`);
}

const originalSettings = fs.existsSync(SETTINGS) ? fs.readFileSync(SETTINGS) : null;
const before = originalSettings ? JSON.parse(originalSettings.toString('utf8')) : {};

let app = null;
let conn = null;
try {
  const port = await freePort();
  app = spawn(EXE, [], {
    env: { ...process.env, FW_SMOKE: '1', FW_NO_ELEVATE: '1', WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
    stdio: 'ignore',
    windowsHide: true,
  });
  conn = await attachApp(port);
  await waitFor(conn, `!!document.querySelector('#videoUrl')`, 30000, '设置加载');

  /* 1) 默认「不使用」：同一条视频应复现原始错误，界面给引导而非 stderr */
  await evalIn(conn, `document.querySelector('.sb[data-nav="video"]').click(); true`);
  await waitFor(conn, `!document.querySelector('.view[data-view="video"]').hidden`, 5000, '视频页');
  await evalIn(conn, `(() => { const el = document.querySelector('#videoUrl'); el.value = ${JSON.stringify(VIDEO)}; return true; })()`);
  await evalIn(conn, `document.querySelector('#btnProbe').click(); true`);
  await waitFor(conn, `!document.querySelector('#vidAuthHint').hidden || !document.querySelector('#vidEmpty').hidden && document.querySelector('#vidEmpty').textContent.includes('解析失败')`, 120000, '默认解析结果');

  const auth = await evalIn(conn, `(() => ({
    hint: !document.querySelector('#vidAuthHint').hidden,
    text: document.querySelector('#vidAuthText').textContent,
    raw: document.querySelector('#vidAuthRaw').textContent,
    emptyHidden: document.querySelector('#vidEmpty').hidden,
    toast: document.querySelector('#toast').textContent,
    topHidden: document.querySelector('#vidTop').hidden,
  }))()`);
  const pngAuth = await shot(conn, 'cookie-auth-guidance.png');
  check('默认来源复现人机校验并显示引导', auth.hint && auth.text.includes('验证登录状态'), `${auth.text.slice(0, 80)}（${pngAuth}）`);
  const rawAscii = String(auth.raw || '').replace(/[’‘]/g, "'");
  check('原始错误收进详情而不是直接展示', rawAscii.includes("Sign in to confirm you're not a bot") && auth.emptyHidden && auth.topHidden, rawAscii.split('\n')[0].slice(0, 90));
  check('引导提示可操作（前往设置按钮）', await evalIn(conn, `!!document.querySelector('#btnAuthGoSettings') && !document.querySelector('#btnAuthGoSettings').hidden`), '#btnAuthGoSettings');

  /* 2) 设置：cookies.txt 缺失时保存路径、明确提示并回退 */
  await evalIn(conn, `document.querySelector('.sb[data-nav="settings"]').click(); true`);
  await waitFor(conn, `!document.querySelector('.view[data-view="settings"]').hidden`, 5000, '设置页');
  await evalIn(conn, `(() => {
    const sel = document.querySelector('#cookieSourceSel');
    sel.value = 'file'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    const f = document.querySelector('#cookieFileInput');
    f.value = ${JSON.stringify(MISSING_COOKIES)}; f.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(1800);
  const saved = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  const fileUi = await evalIn(conn, `({
    tag: document.querySelector('#cookieTag').textContent,
    hint: document.querySelector('#cookieHint').textContent,
    fileRow: !document.querySelector('#rowCookieFile').hidden,
  })`);
  const pngFile = await shot(conn, 'cookie-settings-file-missing.png');
  check('cookies.txt 路径保存到设置', saved.cookieSource === 'file' && saved.cookieFile === MISSING_COOKIES, `cookieSource=${saved.cookieSource} file=${saved.cookieFile}`);
  check('文件缺失时界面明确提示并回退', fileUi.tag === '回退为不使用' && fileUi.hint.includes('不存在') && fileUi.fileRow, `${fileUi.tag} · ${fileUi.hint.slice(0, 70)}（${pngFile}）`);

  /* 3) 浏览器 profile 确实传给 yt-dlp：故意给不存在的 profile，错误里应出现该名字 */
  await evalIn(conn, `(() => {
    const sel = document.querySelector('#cookieSourceSel');
    sel.value = 'browser'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    const b = document.querySelector('#cookieBrowserSel');
    b.value = 'firefox'; b.dispatchEvent(new Event('change', { bubbles: true }));
    const p = document.querySelector('#cookieProfileInput');
    p.value = 'NoSuchProfileFwTest'; p.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(1800);
  const savedBrowser = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  await evalIn(conn, `document.querySelector('.sb[data-nav="video"]').click(); true`);
  await evalIn(conn, `document.querySelector('#btnProbe').click(); true`);
  await waitFor(conn, `!document.querySelector('#vidEmpty').hidden && document.querySelector('#vidEmpty').textContent.includes('解析失败')`, 120000, 'profile 错误');
  const profileErr = await evalIn(conn, `document.querySelector('#vidEmpty').textContent`);
  const pngProfile = await shot(conn, 'cookie-browser-profile-error.png');
  check('浏览器与 profile 保存到设置', savedBrowser.cookieSource === 'browser' && savedBrowser.cookieBrowser === 'firefox' && savedBrowser.cookieProfile === 'NoSuchProfileFwTest', `${savedBrowser.cookieBrowser}:${savedBrowser.cookieProfile}`);
  check('profile 确实传给了 yt-dlp', profileErr.includes('NoSuchProfileFwTest'), profileErr.slice(0, 120) + `（${pngProfile}）`);

  /* 4) cookies.txt 缺失时仍可解析：回退为不使用并提示（用可直接解析的直链 mp4 验证） */
  await evalIn(conn, `document.querySelector('.sb[data-nav="settings"]').click(); true`);
  await evalIn(conn, `(() => {
    const sel = document.querySelector('#cookieSourceSel');
    sel.value = 'file'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(900);
  await evalIn(conn, `document.querySelector('.sb[data-nav="video"]').click(); true`);
  await evalIn(conn, `(() => { const el = document.querySelector('#videoUrl'); el.value = 'https://www.w3schools.com/html/mov_bbb.mp4'; return true; })()`);
  await evalIn(conn, `document.querySelector('#btnProbe').click(); true`);
  await waitFor(conn, `!document.querySelector('#vidTop').hidden || (!document.querySelector('#vidEmpty').hidden && document.querySelector('#vidEmpty').textContent.includes('解析失败'))`, 120000, '直链解析');
  const fallback = await evalIn(conn, `({
    toast: document.querySelector('#toast').textContent,
    top: !document.querySelector('#vidTop').hidden,
    empty: document.querySelector('#vidEmpty').hidden ? '' : document.querySelector('#vidEmpty').textContent,
  })`);
  const pngFallback = await shot(conn, 'cookie-fallback-direct.mp4.png');
  check('文件缺失时解析回退为不使用并提示', fallback.top && fallback.toast.includes('回退'), `toast=${fallback.toast.slice(0, 90)} top=${fallback.top}（${pngFallback}）`);
} catch (err) {
  bad('验证脚本执行', err && err.message || String(err));
} finally {
  if (conn) { try { conn.close(); } catch { /* ignore */ } }
  if (app) { try { app.kill(); } catch { /* ignore */ } }
  await sleep(800);
  // 还原设置，避免测试改动留在用户数据里
  if (originalSettings) fs.writeFileSync(SETTINGS, originalSettings);
  else if (fs.existsSync(SETTINGS)) fs.rmSync(SETTINGS);

  const failed = results.filter((r) => !r.pass);
  const out = path.join(SHOTS, 'cookie-result.json');
  fs.writeFileSync(out, JSON.stringify({ when: new Date().toISOString(), exe: EXE, beforeVideoPreferred: before.videoPreferred, results }, null, 2));
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name} — ${r.detail || ''}`);
  console.log(`\n${failed.length ? `${failed.length} 项失败` : '全部通过'}，结果：${out}`);
  process.exitCode = failed.length ? 1 : 0;
}
