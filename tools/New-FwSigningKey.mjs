// 生成发布清单签名用的 Ed25519 密钥对（一次性操作）。
// 用法：node tools/New-FwSigningKey.mjs
// 输出：
//   1) 公钥 -> 写入 src-tauri/src/update.rs 的 RELEASE_PUBKEY_B64
//   2) 私钥 -> 只存进 GitHub Actions secret FW_SIGNING_KEY，绝不提交
import { generateKeyPairSync } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });

console.log('== 公钥（写入 src-tauri/src/update.rs 的 RELEASE_PUBKEY_B64）==');
console.log(raw);
console.log('\n== 私钥（放进 CI secret FW_SIGNING_KEY，勿提交）==');
console.log(pem);
