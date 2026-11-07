// 用 CI secret 里的 Ed25519 私钥给 latest.json 签名，产出 base64 签名文件 latest.json.sig。
// 用法：node tools/Sign-FwManifest.mjs --in latest.json --out latest.json.sig
// 私钥由环境变量提供（默认 FW_SIGNING_KEY，内容是 PKCS#8 PEM）。
import { readFileSync, writeFileSync } from 'node:fs';
import { createPrivateKey, sign } from 'node:crypto';

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
const data = readFileSync(inPath);
const signature = sign(null, data, key);
writeFileSync(outPath, `${signature.toString('base64')}\n`, 'utf8');
console.log(`已签名 ${inPath} -> ${outPath}（${data.length} 字节）`);
