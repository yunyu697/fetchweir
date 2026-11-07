// 生成发布清单签名用的 Ed25519 密钥对。
//
// 发布密钥是固定的：本仓库只认一把私钥（.secrets/update-signing.pem），
// 它对应的公钥已编译进客户端（RELEASE_PUBKEY_B64）。已有私钥时默认拒绝执行，
// 避免"顺手再生成一把"导致旧客户端全部验签失败。
//
// 用法：node tools/New-FwSigningKey.mjs [--force]
//   默认把私钥写进 .secrets/update-signing.pem（已被 .gitignore 覆盖），
//   只在终端输出公钥与文件路径，避免私钥进入日志/终端历史。
//   --force 才会覆盖已有私钥（换钥），且必须同时替换内置公钥并重新发版。
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = process.cwd();
const keyPath = join(root, '.secrets', 'update-signing.pem');
const force = process.argv.includes('--force');

if (existsSync(keyPath) && !force) {
  console.error(
    [
      `已存在固定发布私钥：${keyPath}`,
      '发布密钥不随发版流程更换，本脚本不会覆盖它。',
      '若确需换钥：先确认已发布带新公钥的客户端版本，再执行 --force，',
      '并同步替换 src-tauri/src/update.rs 的 RELEASE_PUBKEY_B64。详见 docs/更新机制.md。',
    ].join('\n')
  );
  process.exit(3);
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });

mkdirSync(dirname(keyPath), { recursive: true });
writeFileSync(keyPath, pem, { mode: 0o600 });

if (force) {
  console.warn('已按 --force 覆盖旧私钥：必须替换内置公钥并重新发布客户端，否则旧私钥签出的清单会被新客户端拒绝。');
}
console.log('公钥（写入 src-tauri/src/update.rs 的 RELEASE_PUBKEY_B64）:');
console.log(raw);
console.log(`\n私钥已写入：${keyPath}（已被 .gitignore 覆盖，勿提交、勿贴进日志）`);
