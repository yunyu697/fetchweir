// 生成发布清单签名用的 Ed25519 密钥对（一次性操作）。
// 用法：node tools/New-FwSigningKey.mjs [--print]
//
// 默认把私钥写进 .secrets/update-signing.pem（已被 .gitignore 覆盖），
// 只在终端输出公钥与文件路径，避免私钥进入日志/终端历史。
// --print 才会把私钥打印到 stdout，仅在明确需要时使用。
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = process.cwd();
const keyPath = join(root, '.secrets', 'update-signing.pem');
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });

mkdirSync(dirname(keyPath), { recursive: true });
writeFileSync(keyPath, pem, { mode: 0o600 });

console.log('公钥（写入 src-tauri/src/update.rs 的 RELEASE_PUBKEY_B64）:');
console.log(raw);
console.log(`\n私钥已写入：${keyPath}（已被 .gitignore 覆盖，勿提交、勿贴进日志）`);

if (process.argv.includes('--print')) {
  console.log('\n== 私钥内容（FW_SIGNING_KEY）==');
  console.log(pem);
}
