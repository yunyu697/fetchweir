// 升级后任务与设置仍在：启动已安装版本，确认 list_tasks 里能读到升级前的任务记录。
// 用法：node tools/Test-FwUpgradeData.mjs <installed-exe> [outDir]
// 前置：%APPDATA%\Fetchweir\tasks.json 里已有一条 completed 记录（安装前写好的）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const EXE = process.argv[2];
const OUT = process.argv[3] || path.join('D:', 'fw-accept', 'upgrade-data');
if (!EXE) {
  console.error('用法: node tools/Test-FwUpgradeData.mjs <installed-exe> [outDir]');
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
const DATA = path.join(process.env.APPDATA || os.homedir(), 'Fetchweir');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const step = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

const port = await freePort();
const child = spawn(EXE, [], {
  cwd: path.dirname(EXE),
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    FW_SMOKE: '1',
    FW_NO_ELEVATE: '1',
  },
  stdio: 'ignore',
  windowsHide: true,
});

let ws;
try {
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
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
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
  const evaluate = async (expression, awaitPromise = false) => {
    const r = await rpc('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  for (let i = 0; i < 200; i++) {
    try { if (await evaluate(`!!(window.__TAURI__ && window.__TAURI__.core)`)) break; } catch { /* booting */ }
    await sleep(120);
  }
  const list = JSON.parse(await evaluate(
    `(async () => JSON.stringify(await window.__TAURI__.core.invoke('list_tasks')))()`, true));
  const completed = list.filter((t) => t.state === 'completed');
  const withFile = completed.filter((t) => t.savePath && fs.existsSync(t.savePath));
  step('升级后任务记录仍在', list.length > 0, `共 ${list.length} 条`);
  step('已完成记录与成品文件都在', completed.length > 0 && withFile.length === completed.length,
    JSON.stringify({ completed: completed.length, fileExists: withFile.length, sample: withFile[0] && withFile[0].savePath }));
  const settings = path.join(DATA, 'settings.json');
  step('设置文件仍在', fs.existsSync(settings), settings);
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ exe: EXE, tasks: list, results }, null, 2));
} catch (e) {
  step('流程异常', false, e.message);
} finally {
  try { if (ws) ws.close(); } catch { /* ignore */ }
  try { child.kill(); } catch { /* ignore */ }
  await sleep(400);
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${failed.length === 0 ? '全部通过' : `${failed.length} 项失败`}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}
