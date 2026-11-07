// 用 CI secret 里的 Ed25519 私钥给 latest.json 签名，产出 base64 签名文件 latest.json.sig。
// 用法：node tools/Sign-FwManifest.mjs --in latest.json --out latest.json.sig
// 私钥由环境变量提供（默认 FW_SIGNING_KEY，内容是 PKCS#8 PEM）。
//
// 硬保护：发布密钥是固定的。签名前会用私钥推导出公钥，与
// src-tauri/src/update.rs 的 RELEASE_PUBKEY_B64 比对；不一致直接失败。
// 本脚本不会生成新密钥，也不会改写内置公钥——换钥必须走文档里的发版流程。
import { readFileSync, writeFileSync } from 'node:fs';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const inPath = arg('in', 'latest.json');
const outPath = arg('out', `${inPath}.sig`);
const envName = arg('key-env', 'FW_SIGNING_KEY');
const pem = process.env[envName];
if (!pem || !pem.trim()) {
  console.error(`缺少签名私钥：请设置环境变量 ${envName}`);
  process.exit(2);
}

const key = createPrivateKey(pem);

// 内置公钥是客户端的唯一信任锚点；签出的清单必须能被它验过。
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const updateRs = join(repoRoot, 'src-tauri', 'src', 'update.rs');
const builtin = /const\s+RELEASE_PUBKEY_B64\s*:\s*&str\s*=\s*"([^"]+)"/.exec(
  readFileSync(updateRs, 'utf8')
);
if (!builtin) {
  console.error(`无法从 ${updateRs} 读取 RELEASE_PUBKEY_B64，已拒绝签名。`);
  process.exit(3);
}
const derived = createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
if (derived !== builtin[1]) {
  console.error(
    [
      '签名私钥与客户端内置公钥不一致，已拒绝签名。',
      `  内置公钥（src-tauri/src/update.rs）：${builtin[1]}`,
      `  私钥推导出的公钥：${derived}`,
      '',
      '发布密钥是固定的，本脚本不会重新生成密钥。',
      '换钥只能：先替换 RELEASE_PUBKEY_B64 → 发布一个带新公钥的版本 → 之后才用新私钥签清单；',
      '旧版本客户端内置的是旧公钥，对新钥签的清单必然验签失败。详见 docs/更新机制.md。',
    ].join('\n')
  );
  process.exit(3);
}

const data = readFileSync(inPath);
const signature = sign(null, data, key);
writeFileSync(outPath, `${signature.toString('base64')}\n`, 'utf8');
console.log(`已签名 ${inPath} -> ${outPath}（${data.length} 字节）`);
