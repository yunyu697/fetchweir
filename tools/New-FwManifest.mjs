// 生成本次发布用的 latest.json 清单（尚未签名；签名用 tools/Sign-FwManifest.mjs）。
// 用法：node tools/New-FwManifest.mjs [--version 1.0.4] [--repo yunyu697/fetchweir]
//        [--dist dist] [--out dist/latest.json] [--notes "一句话更新说明"]
//
// 只收录 dist/ 里真实存在的安装包，不虚构平台：
// 本轮只构建 Windows x64，清单里就只会有 windows/x86_64 两条资产。
// macOS 的 dmg 与 Linux 的 deb/AppImage 在本地未构建时不会出现在清单里，
// 客户端在这些平台会明确提示「没有适用于当前平台与架构的安装包」。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = arg('version', JSON.parse(readFileSync(join(repoRoot, 'version.json'), 'utf8')).version);
const repo = arg('repo', 'yunyu697/fetchweir');
const distDir = resolve(arg('dist', join(repoRoot, 'dist')));
const outPath = resolve(arg('out', join(distDir, 'latest.json')));
const notes = arg(
  'notes',
  `Fetchweir ${version}：设置页分组导航接线、版本比较修正、更新清单 Ed25519 验签。详见 Release 说明。`
);

// Windows 两种安装范围的产物；更新器会按当前安装范围选后缀匹配的包。
const windowsAssets = [
  `Fetchweir_${version}_x64-setup.exe`,
  `Fetchweir_${version}_x64-setup-allusers.exe`,
];

const assets = [];
for (const name of windowsAssets) {
  const path = join(distDir, name);
  if (!existsSync(path)) continue;
  const bytes = readFileSync(path);
  assets.push({
    platform: 'windows',
    arch: 'x86_64',
    name,
    url: `https://github.com/${repo}/releases/download/v${version}/${name}`,
    size: statSync(path).size,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}

if (assets.length === 0) {
  console.error(`dist 目录里没有找到 ${version} 的 Windows 安装包：${distDir}`);
  process.exit(1);
}

const manifest = {
  version,
  published_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  notes,
  min_system: {
    windows: 'Windows 10 1809 及以上',
    macos: '',
    linux: '',
  },
  assets,
};

writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`已生成 ${outPath}`);
for (const a of assets) {
  console.log(`  ${a.name}  ${a.size} 字节  sha256 ${a.sha256}`);
}
