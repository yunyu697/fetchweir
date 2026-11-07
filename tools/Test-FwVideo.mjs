// 离屏验证视频解析接线：yt-dlp sidecar 是否可用、普通 HLS 能否得到格式、DRM 是否被拒。
// 应用以 FW_SMOKE=1 隐藏运行，不占前台。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const EXE = process.argv[2];
const DATA = path.join(process.env.LOCALAPPDATA || os.homedir(), 'Fetchweir');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (n, d) => results.push({ name: n, pass: true, detail: d });
const bad = (n, d) => results.push({ name: n, pass: false, detail: d });

const CLEAR = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg0.ts\n#EXT-X-ENDLIST\n`;
const DRM = `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg0.ts\n#EXT-X-ENDLIST\n`;

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/clear.m3u8')) { res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }); return res.end(CLEAR); }
  if (req.url.startsWith('/drm.m3u8')) { res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }); return res.end(DRM); }
  if (req.url.startsWith('/seg0.ts')) { res.writeHead(200, { 'content-type': 'video/mp2t' }); return res.end(Buffer.alloc(512, 0x47)); }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

async function probeOnce(url) {
  try { fs.unlinkSync(path.join(DATA, 'video-probe.json')); } catch { /* ignore */ }
  const app = spawn(EXE, [], {
    env: { ...process.env, FW_SMOKE: '1', FW_VIDEO_PROBE: url },
    stdio: 'ignore', windowsHide: true,
  });
  let out = null;
  for (let i = 0; i < 200; i++) {
    await sleep(150);
    try {
      const raw = fs.readFileSync(path.join(DATA, 'video-probe.json'), 'utf8');
      if (raw.trim()) { out = JSON.parse(raw); break; }
    } catch { /* 还没写好 */ }
  }
  app.kill();
  await sleep(300);
  return out;
}

const clear = await probeOnce(`${base}/clear.m3u8`);
if (clear && Array.isArray(clear.formats) && clear.formats.length > 0) {
  const f = clear.formats[0];
  ok('解析器可用', `sidecar 解析出 ${clear.formats.length} 个格式；protocol=${f.protocol} drm=${f.drm}`);
} else {
  bad('解析器可用', JSON.stringify(clear));
}

const drm = await probeOnce(`${base}/drm.m3u8`);
if (drm && drm.error && /DRM/.test(drm.error)) ok('DRM 解析拒绝', drm.error);
else bad('DRM 解析拒绝', JSON.stringify(drm));

const statusApp = spawn(EXE, [], { env: { ...process.env, FW_SMOKE: '1' }, stdio: 'ignore', windowsHide: true });
await sleep(2500);
statusApp.kill();
const sidecar = path.join(path.dirname(EXE), process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
if (fs.existsSync(sidecar)) ok('sidecar 随包位置', sidecar);
else bad('sidecar 随包位置', `未在可执行文件旁找到：${sidecar}`);

server.close();
const failed = results.filter((r) => !r.pass);
console.log(JSON.stringify({ results, pass: failed.length === 0 }, null, 2));
process.exitCode = failed.length === 0 ? 0 : 1;
