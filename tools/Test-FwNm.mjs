// 离屏验证：扩展 → Native Messaging 宿主 → 主进程 回环链路。
// 不启动任何可见窗口（应用以 FW_SMOKE=1 隐藏运行），不下发真实键鼠事件。
// 用法：node tools/Test-FwNm.mjs <fetchweir.exe>
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const EXE = process.argv[2];
if (!EXE || !fs.existsSync(EXE)) {
  console.error('用法: node tools/Test-FwNm.mjs <fetchweir.exe>');
  process.exit(2);
}
const DATA = path.join(process.env.LOCALAPPDATA || os.homedir(), 'Fetchweir');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (name, detail) => results.push({ name, pass: true, detail });
const bad = (name, detail) => results.push({ name, pass: false, detail });

const HLS_CLEAR = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXTINF:6,
seg0.ts
#EXT-X-ENDLIST
`;
const HLS_DRM = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key",KEYFORMAT="com.apple.streamingkeydelivery"
#EXT-X-TARGETDURATION:6
#EXTINF:6,
seg0.ts
#EXT-X-ENDLIST
`;

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/clear.m3u8')) {
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
    res.end(HLS_CLEAR);
    return;
  }
  if (req.url.startsWith('/drm.m3u8')) {
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
    res.end(HLS_DRM);
    return;
  }
  if (req.url.startsWith('/file.bin')) {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '1024' });
    res.end(Buffer.alloc(1024));
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

/* ---------- NM 帧 ---------- */
function writeFrame(stream, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  const len = Buffer.alloc(4);
  len.writeUInt32LE(buf.length, 0);
  stream.write(len);
  stream.write(buf);
}
function reader(stream) {
  let buf = Buffer.alloc(0);
  const waiters = [];
  stream.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const n = buf.readUInt32LE(0);
      if (buf.length < 4 + n) break;
      const payload = buf.subarray(4, 4 + n).toString('utf8');
      buf = buf.subarray(4 + n);
      const w = waiters.shift();
      if (w) w(JSON.parse(payload));
    }
  });
  return () => new Promise((resolve, reject) => {
    waiters.push(resolve);
    setTimeout(() => reject(new Error('等待宿主应答超时')), 8000);
  });
}

/* ---------- 启动应用（隐藏窗口） ---------- */
for (const f of ['nm-endpoint.json', 'sniff-probe.json', 'nm-inbox.jsonl']) {
  try { fs.unlinkSync(path.join(DATA, f)); } catch { /* 不存在 */ }
}
const app = spawn(EXE, [], {
  env: { ...process.env, FW_SMOKE: '1', FW_SNIFF_PROBE: '1' },
  stdio: 'ignore',
  windowsHide: true,
});

async function endpoint() {
  const file = path.join(DATA, 'nm-endpoint.json');
  for (let i = 0; i < 120; i++) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (j.port > 0 && j.token) {
        const okTcp = await new Promise((resolve) => {
          const s = net.connect(j.port, '127.0.0.1', () => { s.end(); resolve(true); });
          s.on('error', () => resolve(false));
        });
        if (okTcp) return j;
      }
    } catch { /* 还没写好 */ }
    await sleep(150);
  }
  throw new Error('主进程未在超时内写出可连接的 nm-endpoint.json');
}

let host = null;
try {
  const ep = await endpoint();
  ok('回环端点', `127.0.0.1:${ep.port}，pid=${ep.pid}，版本=${ep.version}`);

  const reg = path.join(DATA, 'nm-register.log');
  const lines = fs.existsSync(reg) ? fs.readFileSync(reg, 'utf8').trim().split('\n') : [];
  // 失败行也以 registry 开头，必须排除，否则失败会被记成通过。
  const registry = lines.filter((l) => l.startsWith('registry ') && !l.includes('失败')).length;
  const manifests = lines.filter((l) => l.startsWith('manifest ')).length;
  if (manifests >= 2) ok('宿主清单写入', `${manifests} 个清单文件`);
  else bad('宿主清单写入', JSON.stringify(lines));
  if (process.platform === 'win32') {
    if (registry >= 6) ok('Windows 注册表注册', `${registry} 个键`);
    else bad('Windows 注册表注册', `${registry} 个键，日志=${JSON.stringify(lines)}`);
  } else {
    // 非 Windows 没有注册表概念：检查用户目录清单可读
    const home = os.homedir();
    const edge = path.join(home, 'Library/Application Support/Microsoft Edge/NativeMessagingHosts');
    const linux = path.join(home, '.config/microsoft-edge/NativeMessagingHosts');
    const dir = fs.existsSync(edge) ? edge : linux;
    if (fs.existsSync(path.join(dir, 'dev.fetchweir.nmh.json'))) ok('用户目录清单', path.join(dir, 'dev.fetchweir.nmh.json'));
    else bad('用户目录清单', path.join(dir, 'dev.fetchweir.nmh.json'));
  }

  host = spawn(EXE, ['--nm-host'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const next = reader(host.stdout);

  writeFrame(host.stdin, { type: 'hello' });
  const hello = await next();
  const version = JSON.parse(fs.readFileSync(new URL('../version.json', import.meta.url), 'utf8')).version;
  if (hello.ok && hello.version === version) ok('宿主握手', `version=${hello.version} tier=${hello.tier}`);
  else bad('宿主握手', JSON.stringify(hello));

  writeFrame(host.stdin, {
    type: 'sniff',
    item: {
      url: `${base}/clear.m3u8?token=abc&utm_source=spam`, pageUrl: `${base}/page`,
      pageTitle: '测试页', browser: 'edge', kind: 'hls', mime: 'application/vnd.apple.mpegurl',
      size: 0, ranges: true, drmSuspect: false, at: Date.now(),
    },
  });
  const r1 = await next();
  if (r1.ok) ok('嗅探消息入栈', `total=${r1.total}`);
  else bad('嗅探消息入栈', JSON.stringify(r1));

  writeFrame(host.stdin, {
    type: 'sniff',
    item: { url: `${base}/clear.m3u8?utm_source=spam&token=abc`, kind: 'hls', mime: 'application/vnd.apple.mpegurl', at: Date.now() },
  });
  const r2 = await next();
  if (r2.ok && r2.total === r1.total) ok('canonical 去重', `重复上报后 total 仍为 ${r2.total}`);
  else bad('canonical 去重', JSON.stringify(r2));

  writeFrame(host.stdin, {
    type: 'sniff',
    item: {
      url: `${base}/drm.m3u8`, pageUrl: `${base}/page`, kind: 'hls',
      mime: 'application/vnd.apple.mpegurl', drmSuspect: false, at: Date.now(),
    },
  });
  await next();
  let probe = [];
  for (let i = 0; i < 20; i++) {
    await sleep(200);
    try { probe = JSON.parse(fs.readFileSync(path.join(DATA, 'sniff-probe.json'), 'utf8')); } catch { /* ignore */ }
    const drm = probe.find((x) => x.url.includes('drm.m3u8'));
    if (drm && drm.protected) break;
  }
  const drm = probe.find((x) => x.url.includes('drm.m3u8'));
  if (drm && drm.protected) ok('DRM 清单判定', drm.note || 'protected=true');
  else bad('DRM 清单判定', JSON.stringify(drm || probe));

  const clear = probe.find((x) => x.url.includes('clear.m3u8'));
  if (clear && !clear.protected) ok('普通清单不误判', 'protected=false');
  else bad('普通清单不误判', JSON.stringify(clear));

  writeFrame(host.stdin, { type: 'add', item: { url: `${base}/file.bin`, referer: `${base}/`, cookie: 'sid=test', ua: 'probe' } });
  const add = await next();
  if (add.ok && add.task && add.task.state) ok('浏览器任务入队', `任务 #${add.task.id} state=${add.task.state}`);
  else bad('浏览器任务入队', JSON.stringify(add));

  writeFrame(host.stdin, { type: 'nope' });
  const unk = await next();
  if (!unk.ok && unk.error) ok('未知消息拒绝', unk.error);
  else bad('未知消息拒绝', JSON.stringify(unk));
} catch (e) {
  bad('链路异常', e.message);
} finally {
  try { if (host) host.kill(); } catch { /* ignore */ }
  try { app.kill(); } catch { /* ignore */ }
  server.close();
}

const failed = results.filter((r) => !r.pass);
console.log(JSON.stringify({ results, pass: failed.length === 0 }, null, 2));
process.exitCode = failed.length === 0 ? 0 : 1;
