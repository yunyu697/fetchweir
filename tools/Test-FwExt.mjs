// 扩展离线校验：MV3 清单字段、扩展 ID 可预测性、脚本语法、图标尺寸。
// 不打开浏览器、不占前台。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
const results = [];
const ok = (name, detail) => results.push({ name, pass: true, detail });
const bad = (name, detail) => results.push({ name, pass: false, detail });

/* 扩展 ID：SHA-256(SPKI DER) 前 16 字节按 0-f → a-p 映射 */
const der = Buffer.from(manifest.key, 'base64');
const hash = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
const derived = hash.replace(/[0-9a-f]/g, (m) => String.fromCharCode(97 + parseInt(m, 16)));
const nmRs = fs.readFileSync(path.join(ROOT, 'src-tauri', 'src', 'nm.rs'), 'utf8');
const declared = /EXTENSION_ID: &str = "([^"]+)"/.exec(nmRs);
if (declared && declared[1] === derived) ok('扩展 ID 可预测', derived);
else bad('扩展 ID 可预测', `manifest 推导=${derived} nm.rs=${declared ? declared[1] : '缺失'}`);

if (manifest.manifest_version === 3) ok('MV3 清单', 'manifest_version=3');
else bad('MV3 清单', String(manifest.manifest_version));

const needed = ['webRequest', 'nativeMessaging', 'storage', 'tabs', 'scripting', 'contextMenus'];
const missing = needed.filter((p) => !(manifest.permissions || []).includes(p));
if (!missing.length) ok('权限齐备', needed.join(', '));
else bad('权限齐备', `缺少 ${missing.join(', ')}`);

for (const file of ['background.js', 'content.js']) {
  try {
    execFileSync(process.execPath, ['--check', path.join(EXT, file)], { stdio: 'pipe' });
    ok(`语法检查 ${file}`, 'node --check 通过');
  } catch (e) {
    bad(`语法检查 ${file}`, String(e.stderr || e.message).slice(0, 300));
  }
}

const html = fs.readFileSync(path.join(EXT, '..', 'src-tauri', 'src', 'nm.rs'), 'utf8');
if (/HOST_NAME: &str = "dev\.fetchweir\.nmh"/.test(html)) ok('宿主名一致', 'dev.fetchweir.nmh');
else bad('宿主名一致', '未找到 HOST_NAME');

/* PNG IHDR 宽度校验 */
const sizes = { 16: '16.png', 32: '32.png', 48: '48.png', 128: '128.png' };
for (const [size, file] of Object.entries(sizes)) {
  const p = path.join(EXT, 'icons', file);
  if (!fs.existsSync(p)) { bad(`图标 ${size}px`, '文件缺失'); continue; }
  const buf = fs.readFileSync(p);
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  if (w === Number(size) && h === Number(size)) ok(`图标 ${size}px`, `${w}×${h}`);
  else bad(`图标 ${size}px`, `${w}×${h}`);
}

const content = fs.readFileSync(path.join(EXT, 'content.js'), 'utf8');
if (content.includes("attachShadow({ mode: 'closed' })") && content.includes('adoptedStyleSheets')) {
  ok('浮动条隔离', 'closed Shadow DOM + adoptedStyleSheets');
} else bad('浮动条隔离', '未使用 closed Shadow DOM / adoptedStyleSheets');

if (!/innerHTML\s*=/.test(content)) ok('Trusted Types 友好', '内容脚本不使用 innerHTML');
else bad('Trusted Types 友好', '内容脚本仍在用 innerHTML');

const failed = results.filter((r) => !r.pass);
console.log(JSON.stringify({ results, pass: failed.length === 0 }, null, 2));
process.exitCode = failed.length === 0 ? 0 : 1;
