// 从已编译的 exe 里读取真实 Windows 资源，作为图标落地的实测证据：
// 1) 枚举 RT_GROUP_ICON / RT_ICON，打印每档像素尺寸；
// 2) 把各档图标导出为 PNG（docs/ui-shots/exe-icon-*.png）；
// 3) 读取 RT_MANIFEST，确认清单里的 Common-Controls v6 依赖是否真的在。
// 用法：node tools/Inspect-FwExeIcon.mjs [exe路径]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = process.argv[2] || path.join('D:', 'fw-build', 'fetchweir', 'debug', 'fetchweir.exe');
const OUT = path.join(ROOT, 'docs', 'ui-shots');

const RT_ICON = 3;
const RT_GROUP_ICON = 14;
const RT_MANIFEST = 24;

const buf = fs.readFileSync(EXE);

function u16(off) { return buf.readUInt16LE(off); }
function u32(off) { return buf.readUInt32LE(off); }

const peOff = u32(0x3c);
if (buf.toString('ascii', peOff, peOff + 4) !== 'PE\0\0') {
  throw new Error('不是 PE 文件: ' + EXE);
}
const numSections = u16(peOff + 6);
const optSize = u16(peOff + 20);
const opt = peOff + 24;
const magic = u16(opt);
const dataDir = opt + (magic === 0x20b ? 112 : 96);
const rsrcRva = u32(dataDir + 2 * 8);
const rsrcSize = u32(dataDir + 2 * 8 + 4);
if (!rsrcRva) throw new Error('该 exe 没有资源节');

const sections = [];
for (let i = 0; i < numSections; i++) {
  const s = opt + optSize + i * 40;
  sections.push({
    name: buf.toString('ascii', s, s + 8).replace(/\0+$/, ''),
    va: u32(s + 12),
    raw: u32(s + 16),
    ptr: u32(s + 20),
  });
}
const resBase = rvaToOff(rsrcRva);
if (resBase < 0) throw new Error('资源节 RVA 无法映射到文件偏移');

function rvaToOff(rva) {
  for (const s of sections) {
    const span = Math.max(s.raw, u32(opt + optSize + sections.indexOf(s) * 40 + 8));
    if (rva >= s.va && rva < s.va + span) return s.ptr + (rva - s.va);
  }
  return -1;
}

/** 读取一个资源目录层，返回 [{ id, name, isDir, offset }] */
function readDir(dirOff) {
  const named = u16(dirOff + 12);
  const ids = u16(dirOff + 14);
  const out = [];
  for (let i = 0; i < named + ids; i++) {
    const e = dirOff + 16 + i * 8;
    const nameField = u32(e);
    const dataField = u32(e + 4);
    let name = nameField;
    if (nameField & 0x80000000) {
      const sOff = resBase + (nameField & 0x7fffffff);
      const len = u16(sOff);
      name = Buffer.from(buf.subarray(sOff + 2, sOff + 2 + len * 2)).toString('utf16le');
    }
    out.push({
      name,
      isDir: !!(dataField & 0x80000000),
      offset: resBase + (dataField & 0x7fffffff),
    });
  }
  return out;
}

function readDataEntry(off) {
  return { rva: u32(off), size: u32(off + 4) };
}

/** 资源树: 类型 -> 名称 -> 语言 -> 数据 */
const tree = new Map();
for (const typeEntry of readDir(resBase)) {
  const type = String(typeEntry.name);
  const names = new Map();
  if (typeEntry.isDir) {
    for (const nameEntry of readDir(typeEntry.offset)) {
      const langs = [];
      if (nameEntry.isDir) {
        for (const langEntry of readDir(nameEntry.offset)) {
          langs.push({ lang: langEntry.name, data: readDataEntry(langEntry.offset) });
        }
      }
      names.set(String(nameEntry.name), langs);
    }
  }
  tree.set(type, names);
}

function dataOf(type, name) {
  const langs = tree.get(String(type))?.get(String(name));
  return langs && langs.length ? langs[0].data : null;
}

function bytesOf(entry) {
  const off = rvaToOff(entry.rva);
  if (off < 0) throw new Error('资源 RVA 无法映射: ' + entry.rva);
  return buf.subarray(off, off + entry.size);
}

/** 从 GROUP_ICON 读出每档尺寸与对应的 RT_ICON 名称 */
function readGroup(name) {
  const entry = dataOf(RT_GROUP_ICON, name);
  if (!entry) return [];
  const g = bytesOf(entry);
  const count = g.readUInt16LE(4);
  const list = [];
  for (let i = 0; i < count; i++) {
    const off = 6 + i * 14;
    const w = g[off] === 0 ? 256 : g[off];
    const h = g[off + 1] === 0 ? 256 : g[off + 1];
    list.push({ w, h, bytes: g.readUInt32LE(off + 8), iconId: g.readUInt16LE(off + 12) });
  }
  return list;
}

const groups = tree.get(String(RT_GROUP_ICON)) || new Map();
const icons = tree.get(String(RT_ICON)) || new Map();
fs.mkdirSync(OUT, { recursive: true });

const report = {
  exe: EXE,
  bytes: fs.statSync(EXE).size,
  resourceTypes: [...tree.keys()].map((t) => ({
    type: t,
    count: tree.get(t).size,
  })),
  iconIeGroups: [],
  manifest: null,
};

const wanted = new Map([[16, null], [32, null], [48, null], [256, null]]);
for (const [name] of groups) {
  const list = readGroup(name);
  const pngs = [];
  for (const item of list) {
    const data = dataOf(RT_ICON, item.iconId);
    if (!data) continue;
    const bytes = bytesOf(data);
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
    pngs.push({ size: item.w, bytes: item.bytes, png: isPng });
    if (isPng && wanted.has(item.w)) {
      const file = path.join(OUT, `exe-icon-${item.w}.png`);
      fs.writeFileSync(file, bytes);
      wanted.set(item.w, file);
    }
  }
  report.iconIeGroups.push({ id: name, sizes: list.map((i) => `${i.w}x${i.h}`), allPng: pngs.every((p) => p.png) });
}

const manifestNames = tree.get(String(RT_MANIFEST)) || new Map();
let manifest = null;
for (const [name] of manifestNames) {
  const langs = manifestNames.get(name);
  if (langs && langs.length) { manifest = langs[0].data; break; }
}
if (manifest) {
  const off = rvaToOff(manifest.rva);
  const text = buf.toString('utf8', off, off + manifest.size);
  report.manifest = {
    present: true,
    resourceName: String((() => { for (const [n] of manifestNames) return n; return ''; })()),
    bytes: manifest.size,
    hasCommonControlsV6: /Microsoft\.Windows\.Common-Controls/i.test(text),
    hasPerMonitorDpi: /permonitorv2|dpiAware/i.test(text),
    head: text.replace(/\s+/g, ' ').slice(0, 620),
  };
}
report.exported = [...wanted.entries()].filter(([, v]) => v).map(([k, v]) => ({ size: k, file: path.relative(ROOT, v) }));

console.log(JSON.stringify(report, null, 2));
