/* Fetchweir 扩展后台：观察型 webRequest 嗅探 + Native Messaging 桥接 + 徽标兜底 */
// MV3 下 webRequest 只能观察，不能阻断；这正是嗅探需要的部分。
// 采集到的候选按 canonical URL 去重，节流后打包送 Native Messaging 宿主。

const NM_HOST = 'dev.fetchweir.nmh';
const MAX_PER_TAB = 200;
const SEND_DELAY = 500;
const TRACK_PARAMS = new Set(['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid', 'ref', 'spm', '_t', 'from']);
const KEEP_PARAMS = new Set(['token', 'expires', 'sig', 'signature', 'key', 'auth', 'hdnts', 'md5', 'e']);

const now = () => Date.now();
const tabs = new Map();          // tabId -> Map(canonical -> item)
const headersByReq = new Map();  // requestId -> {cookie, referer, ua}
const queue = [];                // 待发送给宿主的消息
let port = null;
let portReady = false;
let lastError = '';
let tier = 'B';
let sendTimer = null;

/* ---------- 存储 ---------- */
async function loadConfig() {
  try {
    const cfg = await chrome.storage.local.get(['tier', 'autoCapture']);
    if (cfg.tier && 'ABC'.includes(cfg.tier)) tier = cfg.tier;
  } catch { /* ignore */ }
}
loadConfig();

/* ---------- 应用颜色主题：只缓存/转发，扩展不维护调色板 ---------- */
let barTheme = null;
const barThemeReady = chrome.storage.local.get('barTheme').then((v) => {
  const t = v && v.barTheme;
  if (t && t.palette && typeof t.palette === 'object') barTheme = t;
}).catch(() => {});

function absorbTheme(t) {
  if (!t || typeof t !== 'object' || !t.palette || typeof t.palette !== 'object') return;
  const next = { theme: t.theme === 'light' ? 'light' : 'dark', color: t.color || '', palette: t.palette };
  if (JSON.stringify(next) === JSON.stringify(barTheme)) return;
  barTheme = next;
  chrome.storage.local.set({ barTheme: next }).catch(() => {});
  broadcastTheme();
  // 徽标底色同样跟随应用强调色，换主题后已打开的标签页立即重刷。
  chrome.tabs.query({}, (list) => {
    for (const t of list) {
      if (t.id != null) updateBadge(t.id);
    }
  });
}

function broadcastTheme() {
  if (!barTheme) return;
  chrome.tabs.query({}, (list) => {
    for (const t of list) {
      if (t.id != null) chrome.tabs.sendMessage(t.id, { type: 'fw:theme', theme: barTheme }).catch(() => {});
    }
  });
}

/* ---------- canonical 去重键 ---------- */
function canonical(raw) {
  try {
    const u = new URL(raw);
    const out = new URLSearchParams();
    const keep = [];
    u.searchParams.forEach((v, k) => {
      if (TRACK_PARAMS.has(k.toLowerCase())) return;
      if (KEEP_PARAMS.has(k.toLowerCase()) || k.toLowerCase().startsWith('x-')) keep.push([k, v]);
    });
    keep.sort((a, b) => a[0].localeCompare(b[0]));
    keep.forEach(([k, v]) => out.append(k, v));
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return `${u.protocol}//${u.host.toLowerCase()}${path}${out.toString() ? '?' + out.toString() : ''}`;
  } catch {
    return raw;
  }
}

function extKind(url, mime) {
  const path = (() => { try { return new URL(url).pathname.toLowerCase(); } catch { return url.toLowerCase(); } })();
  const m = (mime || '').toLowerCase();
  if (m.includes('mpegurl') || path.endsWith('.m3u8')) return 'hls';
  if (m.includes('dash+xml') || path.endsWith('.mpd')) return 'dash';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('image/')) return 'image';
  if (/\.(mp4|m4v|webm|mkv|mov|flv|ts|m4s)$/.test(path) && !m.startsWith('text/')) return 'video';
  if (/\.(mp3|m4a|aac|flac|ogg|opus|wav)$/.test(path)) return 'audio';
  if (/\.(zip|rar|7z|tar|gz|bz2|xz|dmg|iso|msi|exe|apk|deb|rpm)$/.test(path)) return 'archive';
  if (/\.(pdf|doc|docx|xls|xlsx|ppt|pptx|epub|txt|csv|json|xml)$/.test(path)) return 'doc';
  if (m === 'application/pdf') return 'doc';
  if (m.includes('zip') || m.includes('octet-stream')) return 'archive';
  return null;
}

function headerMap(list) {
  const out = {};
  for (const h of list || []) out[h.name.toLowerCase()] = h.value || '';
  return out;
}

function suspectDrm(url, mime) {
  const m = (mime || '').toLowerCase();
  const u = (url || '').toLowerCase();
  if (m.includes('playready') || m.includes('widevine') || m.includes('fairplay')) return true;
  if (/\.(ism|ismc|ismv)\b/.test(u)) return true;
  return false;
}

/* ---------- Native Messaging ---------- */
function ensurePort() {
  if (portReady) return;
  try {
    port = chrome.runtime.connectNative(NM_HOST);
    portReady = true;
    lastError = '';
    port.onMessage.addListener((msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'config' && 'ABC'.includes(msg.tier)) {
        tier = msg.tier;
        chrome.storage.local.set({ tier }).catch(() => {});
        broadcastConfig();
      } else if (typeof msg.tier === 'string' && 'ABC'.includes(msg.tier) && msg.tier !== tier) {
        // 桌面端把档位随每次应答带回，这里跟随，保持两端一致。
        tier = msg.tier;
        chrome.storage.local.set({ tier }).catch(() => {});
        broadcastConfig();
      } else if (msg.type === 'theme') {
        // 宿主轮询到应用主题变化后主动推送。
        absorbTheme(msg);
      } else if (msg.barTheme) {
        // 应答里顺带的最新主题，保证首帧就能拿到。
        absorbTheme(msg.barTheme);
      }
    });
    port.onDisconnect.addListener(() => {
      portReady = false;
      port = null;
      lastError = (chrome.runtime.lastError && chrome.runtime.lastError.message) || '宿主已断开';
      setTimeout(ensurePort, 3000);
    });
    queue.splice(0).forEach((m) => post(m));
  } catch (e) {
    portReady = false;
    lastError = String(e && e.message ? e.message : e);
  }
}

function post(msg) {
  ensurePort();
  if (!portReady) {
    // 宿主未安装或应用未启动：保留最近 50 条，等端口恢复再发。
    if (queue.length < 50) queue.push(msg);
    return;
  }
  try { port.postMessage(msg); } catch { portReady = false; }
}

/* ---------- 采集 ---------- */
function record(tabId, item) {
  if (tabId == null || tabId < 0) return;
  let bag = tabs.get(tabId);
  if (!bag) { bag = new Map(); tabs.set(tabId, bag); }
  const key = canonical(item.url);
  const prev = bag.get(key);
  if (prev) {
    prev.hits += 1;
    prev.size = item.size || prev.size;
    prev.at = item.at;
    item = prev;
  } else {
    if (bag.size >= MAX_PER_TAB) bag.delete(bag.keys().next().value);
    item.hits = 1;
  }
  bag.set(key, item);
  updateBadge(tabId);
  scheduleSend();
  if (tier === 'A' || tier === 'B') broadcastTab(tabId);
}

function scheduleSend() {
  if (sendTimer) return;
  sendTimer = setTimeout(() => {
    sendTimer = null;
    let total = 0;
    for (const [tabId, bag] of tabs) {
      for (const item of bag.values()) {
        if (item.sent) continue;
        item.sent = true;
        post({ type: 'sniff', item: { ...item, tabId } });
        total += 1;
        if (total >= 80) return;
      }
    }
  }, SEND_DELAY);
}

function badgeColor() {
  const solid = barTheme && barTheme.palette && barTheme.palette.accentSolid;
  return typeof solid === 'string' && solid ? solid : '#4B5563';
}

function updateBadge(tabId) {
  const bag = tabs.get(tabId);
  const n = bag ? [...bag.values()].filter((x) => ['video', 'audio', 'hls', 'dash'].includes(x.kind)).length : 0;
  const text = n > 0 ? String(n) : '';
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: badgeColor() }).catch(() => {});
}

/* ---------- webRequest 监听（顶层注册，MV3 要求同步注册） ---------- */
const FILTER = { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame', 'object', 'xmlhttprequest', 'media', 'image', 'other'] };

chrome.webRequest.onSendHeaders.addListener(
  (d) => {
    const h = headerMap(d.requestHeaders);
    headersByReq.set(d.requestId, {
      cookie: h.cookie || '',
      referer: h.referer || '',
      ua: h['user-agent'] || '',
      origin: h.origin || '',
    });
    if (headersByReq.size > 4000) headersByReq.delete(headersByReq.keys().next().value);
  },
  FILTER,
  ['requestHeaders', 'extraHeaders']
);

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    const h = headerMap(d.responseHeaders);
    const mime = (h['content-type'] || '').split(';')[0].trim().toLowerCase();
    const size = Number(h['content-length'] || 0) || 0;
    const kind = extKind(d.url, mime);
    const disposition = (h['content-disposition'] || '').toLowerCase();
    const isAttachment = disposition.includes('attachment');
    if (!kind && !isAttachment) return;

    const who = headersByReq.get(d.requestId) || {};
    const item = {
      url: d.url,
      pageUrl: d.initiator || d.documentUrl || '',
      pageTitle: '',
      browser: (navigator.userAgentData && navigator.userAgentData.brands || []).map((b) => b.brand).join(' '),
      kind: kind || 'file',
      mime,
      size,
      ranges: (h['accept-ranges'] || '').toLowerCase().includes('bytes'),
      drmSuspect: suspectDrm(d.url, mime),
      disposition: isAttachment ? 'attachment' : (disposition.includes('inline') ? 'inline' : ''),
      cookie: who.cookie || '',
      referer: who.referer || '',
      ua: who.ua || '',
      at: now(),
    };

    if (isAttachment && d.type === 'main_frame') {
      // 静默接管：浏览器自身要下载的文件，交给 Fetchweir。
      post({ type: 'capture', item: { ...item, silent: true } });
      return;
    }
    if (!kind) return;
    record(d.tabId, item);
    headersByReq.delete(d.requestId);
  },
  FILTER,
  ['responseHeaders', 'extraHeaders']
);

chrome.webRequest.onCompleted.addListener(
  (d) => { headersByReq.delete(d.requestId); },
  FILTER
);
chrome.webRequest.onErrorOccurred.addListener(
  (d) => { headersByReq.delete(d.requestId); },
  FILTER
);

/* ---------- 与内容脚本 / 前端 ---------- */
function broadcastConfig() {
  chrome.tabs.query({}, (list) => {
    for (const t of list) {
      if (t.id != null) chrome.tabs.sendMessage(t.id, { type: 'fw:config', tier }).catch(() => {});
    }
  });
}

function broadcastTab(tabId) {
  const bag = tabs.get(tabId);
  const media = bag ? [...bag.values()].filter((x) => ['video', 'audio', 'hls', 'dash'].includes(x.kind)).slice(0, 12) : [];
  chrome.tabs.sendMessage(tabId, { type: 'fw:media', items: media }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'fw:hello') {
    // 档位 A 才把 DOM 媒体信号并入候选；B 只信顶层网络层，C 仅徽标。
    if (tier === 'A' && sender.tab && msg.items && msg.items.length) {
      for (const it of msg.items.slice(0, 8)) {
        const mime = it.mime || 'video/mp4';
        record(sender.tab.id, {
          url: it.url,
          pageUrl: sender.tab.url || '',
          pageTitle: msg.title || '',
          browser: 'chromium',
          kind: extKind(it.url, mime) || 'video',
          mime,
          size: 0,
          ranges: false,
          drmSuspect: false,
          disposition: '',
          cookie: '',
          referer: sender.tab.url || '',
          ua: '',
          source: 'dom',
          at: now(),
        });
      }
    }
    barThemeReady.then(
      () => reply({ tier, connected: portReady, error: lastError, theme: barTheme }),
      () => reply({ tier, connected: portReady, error: lastError, theme: barTheme })
    );
    ensurePort();
    return true;
  }
  if (msg.type === 'fw:theme') {
    barThemeReady.then(() => reply({ theme: barTheme }), () => reply({ theme: barTheme }));
    ensurePort();
    return true;
  }
  if (msg.type === 'fw:add') {
    post({ type: 'add', item: msg.item });
    reply({ ok: true });
    return true;
  }
  if (msg.type === 'fw:activate') {
    post({ type: 'activate' });
    reply({ ok: true });
    return true;
  }
  if (msg.type === 'fw:status') {
    ensurePort();
    reply({ tier, connected: portReady, error: lastError });
    return true;
  }
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => { tabs.delete(tabId); });
chrome.tabs.onActivated.addListener((info) => {
  updateBadge(info.tabId);
  ensurePort();
});
chrome.tabs.onUpdated.addListener((tabId, change, info) => {
  if (change.status === 'loading' && info.url) {
    tabs.delete(tabId);
    updateBadge(tabId);
  }
  if (change.status === 'complete') ensurePort();
});

/* 工具栏图标：无弹窗，点击即唤起桌面端 */
chrome.action.onClicked.addListener(() => {
  post({ type: 'activate' });
  ensurePort();
});

/* 右键菜单：链接/视频/图片/页面 */
function buildMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'fw-link', title: '用 Fetchweir 下载此链接', contexts: ['link'] });
    chrome.contextMenus.create({ id: 'fw-media', title: '用 Fetchweir 下载此媒体', contexts: ['video', 'audio'] });
    chrome.contextMenus.create({ id: 'fw-image', title: '用 Fetchweir 下载此图片', contexts: ['image'] });
    chrome.contextMenus.create({ id: 'fw-page', title: '在 Fetchweir 中查看本页资源', contexts: ['page'] });
  });
}
chrome.runtime.onInstalled.addListener(() => { buildMenus(); ensurePort(); });
chrome.runtime.onStartup.addListener(() => { buildMenus(); ensurePort(); });

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const url = info.linkUrl || info.srcUrl || '';
  if (info.menuItemId === 'fw-page') {
    post({ type: 'activate', tabId: tab ? tab.id : 0 });
    return;
  }
  if (!url) return;
  post({
    type: 'add',
    item: {
      url,
      pageUrl: tab ? tab.url || '' : '',
      referer: tab ? tab.url || '' : '',
      filename: '',
      at: now(),
    },
  });
});

/* 启动即尝试连接，失败会按 3 秒重试 */
ensurePort();
