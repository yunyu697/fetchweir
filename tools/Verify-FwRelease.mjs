// 校验一次 Release：清单签名能否被客户端内置公钥验过，以及清单里的资产名/大小/SHA256
// 与 Release 上真实下载到的文件是否一致。
// 用法：node tools/Verify-FwRelease.mjs v1.0.6 [outDir]
// 资产用 gh release download 走 GitHub API 端点，避开 releases/download 直链 504。
import { createHash, createPublicKey, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const TAG = process.argv[2] || 'v1.0.6';
const OUT = process.argv[3] || path.join('D:', 'fw-accept', `release-check-${TAG}`);
const REPO = 'yunyu697/fetchweir';
const GH = 'C:\\Program Files\\GitHub CLI\\gh.exe';
// 与 src-tauri/src/update.rs 的 RELEASE_PUBKEY_B64 一致：客户端唯一信任锚点。
const PUBKEY_B64 = 'Tk+FpZg8tSODE6zqT1t/PT6iDX+KfSRMNFOewh33yLE=';

fs.mkdirSync(OUT, { recursive: true });
const results = [];
const step = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const gh = (...args) => execFileSync(GH, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// 1) 拉取清单、签名与全部安装包
try {
  gh('release', 'download', TAG, '--repo', REPO, '--pattern', 'latest.json*', '--dir', OUT, '--clobber');
} catch (e) {
  step('下载 latest.json / latest.json.sig', false, String(e.stderr || e.message).slice(0, 300));
}
const manifestPath = path.join(OUT, 'latest.json');
const sigPath = path.join(OUT, 'latest.json.sig');
step('清单与签名文件已下载', fs.existsSync(manifestPath) && fs.existsSync(sigPath), OUT);

const raw = fs.readFileSync(manifestPath);
const sig = Buffer.from(fs.readFileSync(sigPath, 'utf8').trim(), 'base64');

// 2) Ed25519 验签：raw 32 字节公钥包成 SPKI DER 后交给 crypto.verify
const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(PUBKEY_B64, 'base64')]);
const pub = createPublicKey({ key: der, format: 'der', type: 'spki' });
step('清单签名通过内置公钥校验', verify(null, raw, pub, sig), `${raw.length} 字节清单 / ${sig.length} 字节签名`);

// 3) 清单元数据
const manifest = JSON.parse(raw.toString('utf8'));
step('清单版本与 tag 一致', manifest.version === TAG.replace(/^v/, ''), `manifest=${manifest.version} tag=${TAG}`);

// 4) 逐个资产下载并比对 size / sha256 / URL
for (const a of manifest.assets) {
  let file = path.join(OUT, a.name);
  if (!fs.existsSync(file)) {
    try {
      gh('release', 'download', TAG, '--repo', REPO, '--pattern', a.name, '--dir', OUT, '--clobber');
    } catch (e) {
      step(`资产可下载：${a.name}`, false, String(e.stderr || e.message).slice(0, 300));
      continue;
    }
  }
  file = path.join(OUT, a.name);
  const bytes = fs.readFileSync(file);
  const sha = createHash('sha256').update(bytes).digest('hex');
  step(
    `资产与清单一致：${a.name}`,
    bytes.length === a.size && sha === a.sha256,
    `size ${bytes.length}/${a.size}，sha256 ${sha === a.sha256 ? '一致' : `${sha} ≠ ${a.sha256}`}`
  );
  step(
    `资产 URL 指向 ${TAG}：${a.name}`,
    a.url.includes(`/releases/download/${TAG}/`),
    a.url
  );
}

const failed = results.filter((r) => !r.pass);
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ tag: TAG, results }, null, 2));
console.log(`\n${failed.length === 0 ? '全部通过' : `${failed.length} 项失败`}，结果：${path.join(OUT, 'result.json')}`);
process.exitCode = failed.length === 0 ? 0 : 1;
