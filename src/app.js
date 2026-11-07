/* Fetchweir 前端逻辑：与 src/index.html 的 DOM 结构一一对应。
 * demo 模式（URL 带 ?demo，或非 Tauri 环境）使用内置数据，不调用任何后端命令。 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const el = (tag, cls, text) => {
    const d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text != null) d.textContent = text;
    return d;
  };

  const MB = 1024 * 1024;
  const GB = 1024 * MB;
  const IS_TAURI = !!(window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.event);
  const PARAMS = new URLSearchParams(location.search);
  const isDemo = PARAMS.has('demo') || !IS_TAURI;
  const invoke = (cmd, args) => {
    if (!IS_TAURI) return Promise.reject(new Error('当前不是桌面端环境'));
    return window.__TAURI__.core.invoke(cmd, args || {});
  };

  const STATE_TEXT = { active: '下载中', queued: '排队中', paused: '已暂停', completed: '已完成', failed: '需处理' };
  const STATE_CLASS = { active: 'dl', queued: 'wait', paused: 'pause', completed: 'ok', failed: 'err' };
  const KIND_TEXT = { video: '视频', audio: '音频', image: '图片', doc: '文档', archive: '压缩包', file: '其他' };

  const CHECK_SVG = '<svg width="9" height="9" viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="#fff" stroke-width="2.4"/></svg>';
  const ICON_SVG = {
    video: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M10 9l5 3-5 3z" fill="currentColor"/></svg>',
    audio: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M9 18V6l10-2v12" stroke="currentColor" stroke-width="1.5"/><circle cx="6.5" cy="18" r="2.4" stroke="currentColor" stroke-width="1.4"/><circle cx="16.5" cy="16" r="2.4" stroke="currentColor" stroke-width="1.4"/></svg>',
    image: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none"><rect x="4" y="5" width="16" height="14" rx="2" stroke="currentColor" stroke-width="1.4"/><circle cx="9" cy="10" r="1.5" fill="currentColor"/><path d="M5 17l5-5 4 4 2-2 3 3" stroke="currentColor" stroke-width="1.3"/></svg>',
    doc: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M7 3h7l4 4v14H7z" stroke="currentColor" stroke-width="1.4"/><path d="M14 3v5h5M10 12h5M10 16h5" stroke="currentColor" stroke-width="1.3"/></svg>',
    archive: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M5 4h14v16H5z" stroke="currentColor" stroke-width="1.4"/><path d="M11 4v3h2V4M11 8v3h2v-3M11 12v3h2v-3M10 18h4" stroke="currentColor" stroke-width="1.2"/></svg>',
    file: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M7 3h7l4 4v14H7z" stroke="currentColor" stroke-width="1.4"/><path d="M14 3v5h5" stroke="currentColor" stroke-width="1.3"/></svg>'
  };
  const THUMB_CLASS = { video: 'v', audio: 'a', image: 'i', doc: 'd', archive: 'd', file: '' };
  const ACT_ICON = {
    play: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M8 5l11 7-11 7z" fill="currentColor"/></svg>',
    pause: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M8 5v14M16 5v14" stroke="currentColor" stroke-width="2"/></svg>',
    cancel: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.9"/></svg>',
    retry: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M5 12a7 7 0 1 0 2-5M5 4v4h4" stroke="currentColor" stroke-width="1.7"/></svg>',
    open: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M14 4h6v6M20 4l-9 9" stroke="currentColor" stroke-width="1.7"/><path d="M10 5H5v14h14v-5" stroke="currentColor" stroke-width="1.6"/></svg>',
    folder: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" stroke="currentColor" stroke-width="1.5"/></svg>',
    more: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><circle cx="6" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="18" cy="12" r="1.4" fill="currentColor"/></svg>'
  };

  const state = {
    view: 'main',
    filter: 'all',
    kind: null,
    search: '',
    sortKey: 'added',
    sortDir: 'desc',
    tasks: new Map(),
    selected: new Set(),
    detailId: null,
    settings: null,
    info: null,
    update: null,
    sniff: [],
    sniffSel: new Set(),
    sniffNm: null,
    sniffChip: 'all',
    sniffHideDup: false,
    video: { info: null, tab: 'video', sel: null, job: null, url: '' },
    themePref: 'dark',
    memBytes: null,
    speedHistory: [],
    timers: {}
  };
  const rowsById = new Map();

  /* 进度事件由后端按 10Hz 合并推送，前端若逐条重排会持续抢占主线程。
   * 这里再合并一层：200ms 窗口内只重绘一次行内数字与统计卡。 */
  const paintQueue = { items: new Map(), timer: 0 };
  function scheduleProgressPaint(items) {
    items.forEach((p) => { if (p && p.id != null) paintQueue.items.set(p.id, p); });
    if (paintQueue.timer) return;
    paintQueue.timer = setTimeout(() => {
      paintQueue.timer = 0;
      const batch = Array.from(paintQueue.items.values());
      paintQueue.items.clear();
      batch.forEach((p) => {
        const t = state.tasks.get(p.id);
        if (t) paintRow(rowsById.get(String(t.id)), t);
      });
      renderStats();
      if (state.detailId != null && state.tasks.has(state.detailId)) paintDetail();
    }, 200);
  }

  /* ---------------- 格式化 ---------------- */
  const pctOf = (t) => {
    if (t.state === 'completed') return 100;
    if (!t.totalBytes) return 0;
    return Math.max(0, Math.min(100, (t.doneBytes / t.totalBytes) * 100));
  };
  const fmtBytes = (n) => {
    n = Number(n) || 0;
    if (n <= 0) return '—';
    if (n >= GB) return (n / GB).toFixed(2) + ' GB';
    if (n >= MB) return (n / MB).toFixed(1) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
    return n + ' B';
  };
  const fmtSpeed = (bps) => {
    bps = Number(bps) || 0;
    if (bps <= 0) return '—';
    return (bps / MB).toFixed(1) + ' MB/s';
  };
  const fmtEta = (t) => {
    if (t.state !== 'active' || !t.speedBps || !t.totalBytes) return '—';
    const left = Math.max(0, t.totalBytes - t.doneBytes) / t.speedBps;
    if (left <= 0) return '—';
    const s = Math.round(left);
    if (s >= 3600) return Math.floor(s / 3600) + ':' + String(Math.floor((s % 3600) / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  };
  const fmtClock = (ms) => {
    const d = new Date(ms || Date.now());
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
  };
  const fmtWhen = (ms) => {
    if (!ms) return '—';
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${fmtClock(ms).slice(0, 5)}`;
  };
  const fmtDuration = (sec) => {
    sec = Math.round(Number(sec) || 0);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return (h ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  };
  const hostOf = (raw) => {
    try { return new URL(raw).host; } catch (e) { return raw.split('/')[0] || '—'; }
  };
  const pathOf = (raw) => {
    try { return new URL(raw).pathname; } catch (e) { return raw.split('?')[0] || ''; }
  };
  const extOf = (nameOrUrl) => {
    const p = pathOf(nameOrUrl).split('/').pop() || nameOrUrl;
    const m = /\.([a-z0-9]{2,5})(?:$|\?)/i.exec(p) || /\.([a-z0-9]{2,5})$/i.exec(p);
    return m ? m[1].toLowerCase() : '';
  };
  const nameFromUrl = (raw) => {
    const seg = decodeURIComponent((pathOf(raw).split('/').pop() || '')).trim();
    return seg || 'download.bin';
  };
  const kindOfExt = (ext) => {
    if (['mp4', 'mkv', 'webm', 'mov', 'm4v', 'avi', 'ts', 'm3u8', 'mpd', 'flv', 'wmv'].includes(ext)) return 'video';
    if (['mp3', 'm4a', 'aac', 'opus', 'flac', 'wav', 'ogg', 'm4b'].includes(ext)) return 'audio';
    if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'svg', 'avif', 'heic'].includes(ext)) return 'image';
    if (['pdf', 'doc', 'docx', 'txt', 'md', 'epub', 'ppt', 'pptx', 'xls', 'xlsx', 'csv', 'rtf'].includes(ext)) return 'doc';
    if (['zip', 'rar', '7z', 'tar', 'gz', 'iso', 'dmg', 'exe', 'msi', 'apk', 'xz', 'bz2'].includes(ext)) return 'archive';
    return 'file';
  };
  const kindOf = (t) => kindOfExt(extOf(t.fileName || t.url || ''));

  const lighten = (hex, amt) => {
    const h = String(hex || '#6C8CFF').trim();
    const v = h.startsWith('#') ? h.slice(1) : h;
    if (v.length !== 6) return '#9A7BFF';
    const rgb = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16));
    const f = (x) => Math.round(x + (255 - x) * amt);
    return `rgb(${f(rgb[0])},${f(rgb[1])},${f(rgb[2])})`;
  };

  /* ---------------- 轻提示 ---------------- */
  let toastTimer = 0;
  function toast(msg, kind) {
    const node = $('toast');
    if (!node) return;
    node.textContent = msg;
    node.classList.toggle('err-color', kind === 'err');
    node.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('show'), 2400);
  }
  function setAreaError(container, text) {
    if (!container) return;
    clearAreaError(container);
    if (!text) return;
    const msg = el('div', 'dim err-color', text);
    msg.dataset.areaErr = '1';
    msg.style.padding = '6px 2px';
    msg.style.flexBasis = '100%';
    container.prepend(msg);
  }
  function clearAreaError(container) {
    if (!container) return;
    $$('[data-area-err]', container).forEach((n) => n.remove());
  }

  /* ---------------- demo 数据 ---------------- */
  const DEMO_SETTINGS = {
    downloadDir: 'C:\\Users\\Tyler\\Downloads',
    connections: 8,
    globalLimitBps: 0,
    theme: 'dark',
    updateRepo: 'yunyu697/fetchweir',
    updateToken: '',
    updateMirror: 'github',
    homepage: 'https://github.com/yunyu697/fetchweir',
    sniffTier: 'B',
    sniffTtlHours: 24,
    maxConnections: 16,
    accent: '#6C8CFF',
    density: 'comfortable',
    reduceMotion: false,
    closeToTray: true,
    autostart: false,
    runAsAdmin: false,
    connectTimeoutSec: 10,
    readTimeoutSec: 30,
    videoPreferred: 'compat'
  };

  function demoTasks() {
    const now = Date.now();
    return [
      { id: 1, url: 'https://cdn.media-cdn.net/hls/master.m3u8?token=9f2', fileName: 'Interstellar.2014.2160p.HDR.x265.mkv', savePath: 'C:\\Users\\Tyler\\Downloads\\Interstellar.2014.2160p.HDR.x265.mkv', totalBytes: 12.62 * GB, doneBytes: 9.84 * GB, speedBps: 28.4 * MB, state: 'active', error: null, createdAt: now - 3 * 60000, supportsRanges: true, connections: 8 },
      { id: 2, url: 'https://mirrors.example.net/ubuntu/24.04/ubuntu-24.04.3-desktop-amd64.iso', fileName: 'ubuntu-24.04.3-desktop-amd64.iso', savePath: 'C:\\Users\\Tyler\\Downloads\\ubuntu-24.04.3-desktop-amd64.iso', totalBytes: 4.72 * GB, doneBytes: 3.02 * GB, speedBps: 6.2 * MB, state: 'active', error: null, createdAt: now - 6 * 60000, supportsRanges: true, connections: 12 },
      { id: 3, url: 'https://video.example.com/files/engines-1080.mp4', fileName: 'How-Engines-Work-1080p.mp4', savePath: 'C:\\Users\\Tyler\\Downloads\\How-Engines-Work-1080p.mp4', totalBytes: 448 * MB, doneBytes: 184 * MB, speedBps: 4.1 * MB, state: 'active', error: null, createdAt: now - 10 * 60000, supportsRanges: true, connections: 1 },
      { id: 4, url: 'https://files.example.com/docs/2026-q4-architecture-review.pdf', fileName: '2026-Q4-architecture-review.pdf', savePath: 'C:\\Users\\Tyler\\Downloads\\2026-Q4-architecture-review.pdf', totalBytes: 12.8 * MB, doneBytes: 0, speedBps: 0, state: 'queued', error: null, createdAt: now - 14 * 60000, supportsRanges: true, connections: 4 },
      { id: 5, url: 'https://cdn.podcast.example.com/ep214/commentary-160k.webm', fileName: 'Podcast-Ep214-commentary-160k.webm', savePath: 'C:\\Users\\Tyler\\Downloads\\Podcast-Ep214-commentary-160k.webm', totalBytes: 94 * MB, doneBytes: 54.6 * MB, speedBps: 0, state: 'failed', error: '分片 #118 失败：HTTP 403（签名已过期，重试 3 次）', createdAt: now - 51 * 60000, supportsRanges: true, connections: 6 },
      { id: 6, url: 'https://audio.example.com/books/part-02.m4b', fileName: 'Audiobook-Vol1-Part-02.m4b', savePath: 'C:\\Users\\Tyler\\Downloads\\Audiobook-Vol1-Part-02.m4b', totalBytes: 640 * MB, doneBytes: 224 * MB, speedBps: 0, state: 'paused', error: null, createdAt: now - 2 * 3600000, supportsRanges: true, connections: 4 },
      { id: 7, url: 'https://cdn.example.com/keynote/2026-keynote-1080p.mp4', fileName: 'Keynote-2026-1080p-H264.mp4', savePath: 'C:\\Users\\Tyler\\Downloads\\Keynote-2026-1080p-H264.mp4', totalBytes: 1.28 * GB, doneBytes: 1.28 * GB, speedBps: 0, state: 'completed', error: null, createdAt: now - 3 * 3600000, supportsRanges: true, connections: 8 },
      { id: 8, url: 'https://img.example.com/gallery/original/photo-batch-42.webp', fileName: 'photo-batch-42-2048px.webp', savePath: 'C:\\Users\\Tyler\\Downloads\\photo-batch-42-2048px.webp', totalBytes: 238 * MB, doneBytes: 238 * MB, speedBps: 0, state: 'completed', error: null, createdAt: now - 26 * 3600000, supportsRanges: true, connections: 1 }
    ];
  }

  function demoSniff() {
    const now = Date.now();
    const page = 'https://video.example.com/watch/2026-autumn';
    const title = '2026 Autumn Recap · Example Video';
    const mk = (id, url, kind, mime, size, extra) => Object.assign({
      id, url, pageUrl: page, pageTitle: title, browser: 'chrome', kind, mime, size,
      ranges: true, drmSuspect: false, protected: false, note: null, disposition: 'attachment',
      cookie: '', referer: page, ua: 'Mozilla/5.0', tabId: 7, source: 'extension', at: now - 3 * 60000, hits: 1
    }, extra || {});
    return [
      mk('s1', 'https://cdn.example.com/hls/master.m3u8?token=abc', 'hls', 'application/vnd.apple.mpegurl', 800 * MB, { hits: 2, note: '主清单派生 3 个变体' }),
      mk('s2', 'https://cdn.example.com/hls/variant-720p.m3u8?token=abc', 'hls', 'application/vnd.apple.mpegurl', 410 * MB),
      mk('s3', 'https://cdn.example.com/hls/variant-480p.m3u8?token=abc', 'hls', 'application/vnd.apple.mpegurl', 185 * MB),
      mk('s4', 'https://cdn.example.com/media/recap/2026-autumn-4k.mp4', 'video', 'video/mp4', 1.19 * GB, { note: 'HEVC · 4K' }),
      mk('s5', 'https://cdn.example.com/media/bts-1080.webm', 'video', 'video/webm', 402 * MB),
      mk('s6', 'https://cdn.example.com/media/teaser.mp4', 'video', 'video/mp4', 96 * MB, { hits: 3 }),
      mk('s7', 'https://cdn.example.com/audio/soundtrack.m4a', 'audio', 'audio/mp4', 38 * MB),
      mk('s8', 'https://cdn.example.com/audio/commentary-160k.webm', 'audio', 'audio/webm', 47 * MB),
      mk('s9', 'https://img.example.com/gallery/full/dscf2041.jpg', 'image', 'image/jpeg', 8.2 * MB, { pageUrl: 'https://img.example.com/gallery' }),
      mk('s10', 'https://img.example.com/gallery/full/dscf2042.jpg', 'image', 'image/jpeg', 7.1 * MB, { pageUrl: 'https://img.example.com/gallery' }),
      mk('s11', 'https://files.example.com/docs/whitepaper.pdf', 'doc', 'application/pdf', 12.8 * MB, { pageUrl: 'https://files.example.com/docs' }),
      mk('s12', 'https://files.example.com/assets/samples.zip', 'archive', 'application/zip', 240 * MB, { pageUrl: 'https://files.example.com/assets' })
    ];
  }

  function demoVideo() {
    const mk = (o) => Object.assign({
      formatId: '', ext: 'mp4', width: 0, height: 0, fps: 0, vcodec: 'none', acodec: 'none',
      size: 0, tbr: 0, protocol: 'https', url: '', drm: false, drmReason: null, needsMux: false, recommended: false
    }, o);
    return {
      title: '2026 Autumn Recap · 4K HDR',
      duration: 754,
      uploader: 'Fetchweir Labs',
      thumbnail: '',
      webpageUrl: 'https://video.example.com/watch/2026-autumn',
      message: null,
      drmOnly: false,
      formats: [
        mk({ formatId: 'v1', ext: 'mp4', width: 3840, height: 2160, fps: 60, vcodec: 'av01.0.15M.10', acodec: 'opus', size: 3.18 * GB, tbr: 3580, url: 'https://cdn.example.com/media/recap-4k-av1.mp4', needsMux: true, drmReason: null }),
        mk({ formatId: 'v2', ext: 'webm', width: 2560, height: 1440, fps: 60, vcodec: 'vp09.00.51.08', acodec: 'opus', size: 1.86 * GB, tbr: 2100, url: 'https://cdn.example.com/media/recap-1440-vp9.webm' }),
        mk({ formatId: 'v3', ext: 'mp4', width: 1920, height: 1080, fps: 30, vcodec: 'avc1.640028', acodec: 'mp4a.40.2', size: 1.24 * GB, tbr: 1380, url: 'https://cdn.example.com/media/recap-1080-h264.mp4', recommended: true }),
        mk({ formatId: 'v4', ext: 'mp4', width: 1280, height: 720, fps: 30, vcodec: 'avc1.4d401f', acodec: 'mp4a.40.2', size: 578 * MB, tbr: 640, url: 'https://cdn.example.com/media/recap-720-h264.mp4' }),
        mk({ formatId: 'v5', ext: 'mp4', width: 854, height: 480, fps: 30, vcodec: 'avc1.4d401e', acodec: 'mp4a.40.2', size: 242 * MB, tbr: 268, url: 'https://cdn.example.com/media/recap-480-h264.mp4' }),
        mk({ formatId: 'a1', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', size: 39 * MB, tbr: 128, url: 'https://cdn.example.com/media/recap-audio.m4a' }),
        mk({ formatId: 'a2', ext: 'webm', vcodec: 'none', acodec: 'opus', size: 47 * MB, tbr: 160, url: 'https://cdn.example.com/media/recap-audio-opus.webm' }),
        mk({ formatId: 'drm1', ext: 'mp4', width: 1920, height: 1080, fps: 30, vcodec: 'avc1.640028', acodec: 'mp4a.40.2', size: 0, tbr: 0, url: '', drm: true, drmReason: 'Widevine 内容，按产品边界不下载' })
      ]
    };
  }

  const DEMO_UPDATE = {
    stage: 'updateAvailable',
    currentVersion: '1.0.0',
    latestVersion: '1.0.1',
    notes: '· 修复 HLS 分片重试时的连接泄漏\n· 嗅探页支持按域名过滤\n· 视频解析结果增加编码与体积提示\n· 更新镜像切换后立即生效',
    publishedAt: '2026-11-05T09:20:00Z',
    assetName: 'Fetchweir_1.0.1_x64-setup.exe',
    assetSize: 18.4 * MB,
    mirrors: [
      { id: 'github', label: 'GitHub 直连' },
      { id: 'ghfast', label: '加速镜像 ghfast.top' },
      { id: 'ghproxy', label: '加速镜像 gh-proxy.com' }
    ],
    mirror: 'github',
    progress: 0,
    downloaded: 0,
    total: 18.4 * MB,
    path: null,
    message: null,
    canInstall: false,
    downloadDir: 'C:\\Users\\Tyler\\Downloads'
  };

  const DEMO_NM = { hostName: 'com.fetchweir.sniff', extensionId: 'fetchweir-extension', endpointPort: 49873, registered: ['chrome', 'edge'], tier: 'B' };

  /* ---------------- 外观 ---------------- */
  const mqLight = window.matchMedia('(prefers-color-scheme: light)');
  function paintTheme(pref) {
    state.themePref = pref || state.themePref || 'dark';
    const resolved = state.themePref === 'system' ? (mqLight.matches ? 'light' : 'dark') : state.themePref;
    document.documentElement.dataset.theme = resolved;
    $$('[data-theme-set]').forEach((b) => b.classList.toggle('on', b.dataset.themeSet === state.themePref));
  }
  function applyAccent(hex) {
    const accent = /^#[0-9a-f]{6}$/i.test(hex || '') ? hex : '#6C8CFF';
    document.documentElement.style.setProperty('--accent', accent);
    document.documentElement.style.setProperty('--accent-2', lighten(accent, 0.22));
    $$('.sw-dot').forEach((d) => d.classList.toggle('on', d.dataset.accent.toLowerCase() === accent.toLowerCase()));
  }
  function applyVisuals(s) {
    if (!s) return;
    paintTheme(s.theme || 'dark');
    applyAccent(s.accent);
    document.documentElement.dataset.density = s.density === 'compact' ? 'compact' : 'comfortable';
    $$('[data-density-set]').forEach((b) => b.classList.toggle('on', b.dataset.densitySet === document.documentElement.dataset.density));
    document.documentElement.classList.toggle('reduce-motion', !!s.reduceMotion);
    const sw = $('swReduce');
    if (sw) { sw.classList.toggle('on', !!s.reduceMotion); sw.setAttribute('aria-checked', String(!!s.reduceMotion)); }
  }
  mqLight.addEventListener('change', () => { if (state.themePref === 'system') paintTheme('system'); });

  /* ---------------- 任务行 ---------------- */
  function tbtn(icon, title, act, cls) {
    const b = el('button', 'tbtn' + (cls ? ' ' + cls : ''));
    b.innerHTML = icon;
    b.title = title;
    b.dataset.act = act;
    return b;
  }
  function taskTags(t) {
    const tags = [];
    if (/\.(m3u8|mpd)(\?|$|#)/i.test(t.url || '') || /\.(m3u8|mpd)$/i.test(t.fileName || '')) tags.push(['HLS', 'hls']);
    if (/(youtube|youtu\.be|bilibili|vimeo)/i.test(t.url || '')) tags.push(['解析器', 'yt']);
    if (t.state === 'paused') tags.push(['断点已保存', '']);
    if (t.state === 'failed') tags.push(['需处理', 'protected']);
    return tags;
  }
  function makePill(st) {
    const pill = el('span', 'st ' + (STATE_CLASS[st] || 'wait'));
    pill.append(el('span', 'd'), document.createTextNode(STATE_TEXT[st] || st));
    return pill;
  }

  function buildRow(t) {
    const kind = kindOf(t);
    const row = el('div', 'task');
    row.dataset.id = String(t.id);
    row.dataset.status = t.state;
    row.dataset.kind = kind;
    row.dataset.added = String(t.createdAt || 0);
    row.dataset.bytes = String(t.totalBytes || 0);
    row.dataset.speed = String(t.speedBps || 0);

    const cbWrap = el('div', 't-cb');
    const cb = el('span', 'cb');
    cb.innerHTML = CHECK_SVG;
    cb.title = '选择任务';
    cbWrap.append(cb);

    const thumb = el('div', 'thumb' + (THUMB_CLASS[kind] ? ' ' + THUMB_CLASS[kind] : ''));
    thumb.innerHTML = ICON_SVG[kind];
    thumb.title = KIND_TEXT[kind] || '文件';

    const main = el('div', 't-main');
    const name = el('div', 't-name');
    name.append(document.createTextNode(t.fileName || nameFromUrl(t.url)));
    taskTags(t).forEach(([label, cls]) => name.append(el('span', 'tag' + (cls ? ' ' + cls : ''), label)));
    const sub = el('div', 't-sub');
    sub.append(el('span', '', hostOf(t.url)), el('span', 'sep'));
    const connText = t.supportsRanges ? `${t.connections || 1} 段` : '单连接';
    sub.append(el('span', '', connText), el('span', 'sep'), el('span', '', t.state === 'active' ? ('剩余 ' + fmtEta(t)) : (t.state === 'queued' ? '等待调度' : t.state === 'failed' ? '断点保留' : t.state === 'paused' ? '已释放连接' : '已落盘')));
    const nwSize = el('span', 'nw nw-size', '· ' + fmtBytes(t.totalBytes));
    const nwSpeed = el('span', 'nw nw-speed', '· ' + fmtSpeed(t.speedBps));
    sub.append(nwSize, nwSpeed);

    const barRow = el('div', 't-bar');
    const bar = el('div', 'bar');
    const fill = el('i');
    bar.append(fill);
    const pct = el('span', 'pct');
    barRow.append(bar, pct);
    main.append(name, sub, barRow);

    const size = el('div', 't-size');
    const sizeMain = el('b');
    const sizeSub = el('small');
    size.append(sizeMain, sizeSub);

    const speed = el('div', 't-speed');
    const speedMain = el('span');
    const speedSub = el('small');
    speed.append(speedMain, speedSub);

    const stCell = el('div');
    const pill = makePill(t.state);
    stCell.append(pill);

    const acts = el('div', 't-acts');
    if (t.state === 'completed') {
      acts.append(tbtn(ACT_ICON.open, '打开文件', 'open', 'ok'), tbtn(ACT_ICON.folder, '打开所在文件夹', 'folder', 'ok ghost'));
    } else if (t.state === 'active') {
      acts.append(tbtn(ACT_ICON.pause, '暂停', 'pause'), tbtn(ACT_ICON.cancel, '取消任务', 'remove', 'err'));
    } else if (t.state === 'failed') {
      acts.append(tbtn(ACT_ICON.retry, '重新解析并重试', 'resume'), tbtn(ACT_ICON.cancel, '移除任务', 'remove', 'err'));
    } else {
      acts.append(tbtn(ACT_ICON.play, '开始', 'resume'), tbtn(ACT_ICON.cancel, '取消任务', 'remove', 'err'));
    }

    const more = el('button', 'ico');
    more.innerHTML = ACT_ICON.more;
    more.title = '查看详情';
    more.style.width = '28px';
    more.style.height = '28px';
    more.dataset.act = 'detail';

    row.append(cbWrap, thumb, main, size, speed, stCell, acts, more);

    cbWrap.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSelection(t.id);
    });
    row.addEventListener('click', (e) => {
      if (e.target.closest('button, .t-cb, .cb')) return;
      selectOnly(t.id);
    });
    row.addEventListener('dblclick', (e) => {
      if (e.target.closest('button, .t-cb, .cb')) return;
      openDetail(t.id);
    });
    $$('[data-act]', row).forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (b.dataset.act === 'detail') openDetail(t.id);
      else taskAction(t, b.dataset.act);
    }));

    paintRow(row, t);
    return row;
  }

  function paintRow(row, t) {
    if (!row) return;
    const r = row.querySelector.bind(row);
    const pct = pctOf(t);
    const fill = r('.t-bar .bar i');
    const pctEl = r('.t-bar .pct');
    const sizeMain = r('.t-size b');
    const sizeSub = r('.t-size small');
    const speedMain = r('.t-speed span');
    const speedSub = r('.t-speed small');
    const pill = r('.st');
    const sub = r('.t-sub');
    if (!fill || !pctEl || !sizeMain || !speedMain || !pill) return;

    fill.style.width = pct + '%';
    fill.className = t.state === 'completed' ? 'done' : t.state === 'queued' ? 'wait' : '';
    fill.style.background = t.state === 'failed' ? 'var(--err)' : '';
    if (pctEl) pctEl.textContent = t.state === 'queued' ? '—' : Math.round(pct) + '%';

    if (t.state === 'completed') {
      sizeMain.textContent = fmtBytes(t.totalBytes);
      sizeSub.textContent = '已完成';
      speedMain.textContent = '—';
      speedSub.textContent = '已落盘';
    } else {
      sizeMain.textContent = fmtBytes(t.doneBytes);
      sizeSub.textContent = '/ ' + fmtBytes(t.totalBytes);
      speedMain.textContent = t.state === 'active' ? fmtSpeed(t.speedBps) : '—';
      speedSub.textContent = t.state === 'active' ? `${t.connections || 1} 连接` : t.state === 'queued' ? '等待额度' : t.state === 'failed' ? '断点保留' : '已暂停';
    }

    pill.className = 'st ' + (STATE_CLASS[t.state] || 'wait');
    pill.textContent = '';
    pill.append(el('span', 'd'), document.createTextNode(STATE_TEXT[t.state] || t.state));

    if (sub) {
      const connText = t.supportsRanges ? `${t.connections || 1} 段` : '单连接';
      const tail = t.state === 'active' ? ('剩余 ' + fmtEta(t)) : t.state === 'queued' ? '等待调度' : t.state === 'failed' ? '断点保留' : t.state === 'paused' ? '已释放连接' : '已落盘';
      const spans = $$('span', sub);
      if (spans[2]) spans[2].textContent = connText;
      if (spans[4]) spans[4].textContent = tail;
      if (spans[5]) spans[5].textContent = '· ' + fmtBytes(t.totalBytes);
      if (spans[6]) spans[6].textContent = '· ' + fmtSpeed(t.speedBps);
    }
  }

  /* ---------------- 列表 ---------------- */
  function kindFiltered() {
    let list = Array.from(state.tasks.values());
    if (state.kind) list = list.filter((t) => kindOf(t) === state.kind);
    if (state.search) {
      const q = state.search.toLowerCase();
      list = list.filter((t) => (t.fileName || '').toLowerCase().includes(q) || (t.url || '').toLowerCase().includes(q) || hostOf(t.url).toLowerCase().includes(q));
    }
    return list;
  }
  function statusFiltered(list) {
    if (state.filter === 'all') return list;
    if (['active', 'queued', 'paused', 'completed', 'failed'].includes(state.filter)) return list.filter((t) => t.state === state.filter);
    return list;
  }
  function sortList(list) {
    const dir = state.sortDir === 'asc' ? 1 : -1;
    const key = state.sortKey;
    const val = (t) => {
      if (key === 'size') return t.totalBytes || null;
      if (key === 'speed') return t.speedBps || null;
      if (key === 'eta') {
        if (t.state !== 'active' || !t.speedBps) return null;
        return (t.totalBytes - t.doneBytes) / t.speedBps;
      }
      return t.createdAt || null;
    };
    return list.slice().sort((a, b) => {
      const va = val(a), vb = val(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return (va - vb) * dir;
    });
  }
  function emptyHintText() {
    if (state.search) return '没有匹配当前搜索的任务，换个关键词，或清空搜索框。';
    if (state.kind) return `当前分类（${KIND_TEXT[state.kind]}）还没有任务。点击「新建下载」或到「资源嗅探」中挑选候选资源。`;
    if (state.filter !== 'all') return '当前筛选条件下没有任务，切换筛选或新建下载。';
    return '点击右上角「新建下载」添加链接，或到「资源嗅探」中挑选候选资源。';
  }
  function renderTasks() {
    const base = statusFiltered(kindFiltered());
    const list = sortList(base);
    $('taskList').textContent = '';
    rowsById.clear();
    state.selected.forEach((id) => { if (!state.tasks.has(id)) state.selected.delete(id); });
    list.forEach((t) => {
      const row = buildRow(t);
      rowsById.set(String(t.id), row);
      $('taskList').append(row);
    });
    $('emptyState').hidden = list.length > 0;
    $('emptyHint').textContent = emptyHintText();
    paintSelection();
    renderStats();
    paintSortUi();
    paintFilterUi();
    if (state.detailId != null && state.tasks.has(state.detailId)) paintDetail();
  }

  function paintSortUi() {
    const sel = $('sortKey');
    if (sel) sel.value = state.sortKey;
    const dir = $('sortDir');
    if (dir) {
      const ar = $('.ar', dir);
      if (ar) ar.textContent = state.sortDir === 'asc' ? '↑' : '↓';
      dir.title = state.sortDir === 'asc' ? '当前升序，点击切换为降序' : '当前降序，点击切换为升序';
    }
    $$('.list-head .hbtn').forEach((h) => {
      h.classList.toggle('on', h.dataset.sort === state.sortKey);
      const ar = h.querySelector('.ar');
      if (ar) ar.textContent = state.sortDir === 'asc' ? '↑' : '↓';
    });
  }

  function paintFilterUi() {
    $$('.chip[data-fchip]').forEach((c) => c.classList.toggle('on', c.dataset.fchip === state.filter && !state.kind));
    $$('.sb').forEach((s) => {
      if (s.dataset.nav !== 'main') return;
      let on = false;
      if (state.kind) on = s.dataset.kind === state.kind;
      else on = !s.dataset.kind && s.dataset.filter === state.filter;
      s.classList.toggle('active', on);
    });
  }

  /* 解析器版本探测要拉起 yt-dlp 子进程（首次 1-8 秒），
   * 放到首次进入视频页时再做，不拖慢冷启动。 */
  state.parserChecked = false;
  async function checkParserState() {
    if (state.parserChecked || isDemo) return;
    state.parserChecked = true;
    const ps = $('parserState');
    if (!ps) return;
    try {
      const vs = await invoke('video_status');
      ps.textContent = vs && vs.present ? ('已就绪' + (vs.version ? ' · ' + vs.version : '')) : '未找到解析器';
      ps.style.color = vs && vs.present ? 'var(--ok)' : 'var(--err)';
    } catch (err) {
      ps.textContent = '状态未知';
      ps.style.color = 'var(--err)';
    }
  }
  function setView(v) {
    state.view = v;
    if (v === 'video') checkParserState();
    // 扩展状态在启动时可能早于宿主注册完成，进设置页时重新取一次，避免显示过期状态。
    if (v === 'settings') loadExtensionInfo();
    $$('.view').forEach((s) => { s.hidden = s.dataset.view !== v; });
    $$('.sb').forEach((s) => { if (s.dataset.nav !== 'main') s.classList.toggle('active', s.dataset.nav === v); });
    const view = $(`.view[data-view="${v}"]`);
    if (view) view.scrollTop = 0;
    updateBulk();
  }

  /* ---------------- 统计 ---------------- */
  function setValue(id, value, unit) {
    const node = $(id);
    if (!node) return;
    node.textContent = '';
    node.append(document.createTextNode(String(value)));
    if (unit) node.append(el('span', '', unit));
  }
  function renderStats() {
    const all = Array.from(state.tasks.values());
    const active = all.filter((t) => t.state === 'active');
    const queued = all.filter((t) => t.state === 'queued');
    const completed = all.filter((t) => t.state === 'completed');
    const failed = all.filter((t) => t.state === 'failed');
    const paused = all.filter((t) => t.state === 'paused');
    const speed = active.reduce((a, t) => a + (t.speedBps || 0), 0);
    const conns = active.reduce((a, t) => a + (t.connections || 0), 0);
    const byKind = (k) => all.filter((t) => kindOf(t) === k).length;

    const count = (id, n) => { const n2 = $(id); if (n2) n2.textContent = String(n); };
    count('cntAll', all.length); count('cntActive', active.length); count('cntQueued', queued.length);
    count('cntDone', completed.length); count('cntFailed', failed.length);
    count('cntVideo', byKind('video')); count('cntAudio', byKind('audio')); count('cntImage', byKind('image'));
    count('cntDoc', byKind('doc')); count('cntArchive', byKind('archive'));

    const kindBase = kindFiltered();
    count('chipAll', kindBase.length);
    count('chipActive', kindBase.filter((t) => t.state === 'active').length);
    count('chipQueued', kindBase.filter((t) => t.state === 'queued').length);
    count('chipDone', kindBase.filter((t) => t.state === 'completed').length);
    count('chipFailed', kindBase.filter((t) => t.state === 'failed').length);

    const visible = statusFiltered(kindBase);
    const title = state.kind ? KIND_TEXT[state.kind] : ({ all: '全部任务', active: '下载中', queued: '排队中', completed: '已完成', failed: '失败' }[state.filter] || '全部任务');
    $('mainTitle').textContent = title;
    const parts = [`共 ${visible.length} 个任务`];
    if (active.length) parts.push(`${active.length} 个进行中`);
    if (queued.length) parts.push(`${queued.length} 个排队`);
    if (state.kind || state.search) parts.push('已应用筛选');
    $('mainSub').textContent = parts.join(' · ');

    setValue('statSpeed', (speed / MB).toFixed(1), ' MB/s');
    $('statSpeedSub').textContent = active.length ? `${active.length} 个任务正在下载` : '空闲中';
    setValue('statConns', conns, ' 条');
    $('statConnsSub').textContent = active.length ? `${active.length} 个任务 · 平均 ${Math.round(conns / active.length)} 条` : '无进行中的任务';
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const todayDone = completed.filter((t) => (t.createdAt || 0) >= dayStart.getTime()).length;
    setValue('statToday', todayDone, ' 个任务');
    $('statTodaySub').textContent = '本机下载记录';
    if (isDemo) {
      setValue('statMemory', '—', ' MB');
      $('statMemorySub').textContent = '演示模式无宿主进程';
    } else if (state.memBytes) {
      setValue('statMemory', (state.memBytes / MB).toFixed(1), ' MB');
      $('statMemorySub').textContent = '宿主进程工作集 · PSAPI';
    } else {
      setValue('statMemory', '—', ' MB');
      $('statMemorySub').textContent = '宿主进程工作集';
    }

    const settings = state.settings || DEMO_SETTINGS;
    const limit = settings.globalLimitBps || 0;
    $('limitVal').textContent = limit ? fmtSpeed(limit) : '不限速';
    $('limitFill').style.width = (limit ? Math.min(100, (speed / limit) * 100) : (speed ? 22 : 0)) + '%';
    $('limitFootLeft').textContent = '当前 ' + fmtSpeed(speed);
    $('limitFootRight').textContent = limit ? '上限 ' + fmtSpeed(limit) : '未设置上限';

    $('statusText').textContent = active.length ? `正在下载 ${active.length} 个任务` : (queued.length ? `排队 ${queued.length} 个任务` : '引擎就绪 · 本地模式');
    $('statusQueue').textContent = '队列 ' + queued.length;
    $('statusSpeed').textContent = (speed / MB).toFixed(1) + ' MB/s';

    state.speedHistory.push(speed / MB);
    if (state.speedHistory.length > 12) state.speedHistory.shift();
    const hist = state.speedHistory;
    const max = Math.max(6, ...hist);
    const pts = hist.map((v, i) => `${(i / Math.max(1, hist.length - 1)) * 120},${15 - Math.min(13, (v / max) * 12)}`).join(' ');
    $('sparkLine').setAttribute('points', pts);
  }

  /* ---------------- 选择与批量 ---------------- */
  function selectOnly(id) {
    state.selected.clear();
    state.selected.add(id);
    paintSelection();
  }
  function toggleSelection(id) {
    if (state.selected.has(id)) state.selected.delete(id);
    else state.selected.add(id);
    paintSelection();
  }
  function paintSelection() {
    rowsById.forEach((row, id) => {
      const on = state.selected.has(Number(id));
      row.classList.toggle('sel', on);
      const cb = row.querySelector('.t-cb .cb');
      if (cb) cb.classList.toggle('on', on);
    });
    updateBulk();
  }
  function selectedTasks() {
    return Array.from(state.selected).map((id) => state.tasks.get(id)).filter(Boolean);
  }
  function updateBulk() {
    const sel = selectedTasks();
    const n = sel.length;
    const done = sel.filter((t) => t.state === 'completed').length;
    const visibleRows = $$('.task', $('taskList'));
    const allOn = visibleRows.length > 0 && visibleRows.every((r) => state.selected.has(Number(r.dataset.id)));
    const someOn = visibleRows.some((r) => state.selected.has(Number(r.dataset.id)));
    const allCheck = $('selAll');
    if (allCheck) {
      allCheck.classList.toggle('on', allOn);
      allCheck.classList.toggle('half', !allOn && someOn);
    }
    $('taskBulk').hidden = !(n > 0 && state.view === 'main');
    $('mainArea').classList.toggle('has-sel', n > 0 && state.view === 'main');
    $('selN').textContent = String(n);
    $('selDone').textContent = `已完成 ${done}`;
    $('selHint').textContent = n === 0 ? '文件操作' : (done === n ? '所选均为已完成项，可直接打开' : '含进行中任务：可批量暂停或取消');
    $('bulkOpen').disabled = done !== n || n === 0;
    $('bulkFolder').disabled = done !== n || n === 0;
    $('bulkPause').disabled = n === 0 || done === n;
    $('bulkCancel').disabled = n === 0;
  }

  /* ---------------- 任务操作 ---------------- */
  async function taskAction(t, act) {
    if (!t) return;
    try {
      if (act === 'open') {
        if (isDemo) toast('演示模式：将用默认程序打开 ' + t.fileName);
        else { await invoke('open_path', { path: t.savePath }); toast('已打开：' + t.fileName); }
      } else if (act === 'folder') {
        if (isDemo) toast('演示模式：将定位到 ' + t.savePath);
        else { await invoke('reveal_path', { path: t.savePath }); toast('已打开所在文件夹'); }
      } else if (act === 'pause') {
        if (isDemo) { t.state = 'paused'; t.speedBps = 0; renderTasks(); toast('已暂停：' + t.fileName); }
        else { await invoke('pause_task', { id: t.id }); toast('已暂停：' + t.fileName); }
      } else if (act === 'resume') {
        if (isDemo) {
          const retry = t.state === 'failed';
          t.state = 'active'; t.speedBps = (4 + (t.id % 5) * 2.6) * MB;
          if (t.error) t.error = null;
          renderTasks();
          toast((retry ? '已重试：' : '已开始：') + t.fileName);
        } else { await invoke('resume_task', { id: t.id }); toast('已开始：' + t.fileName); }
      } else if (act === 'remove') {
        if (isDemo) {
          state.tasks.delete(t.id); state.selected.delete(t.id);
          if (state.detailId === t.id) closeDetail();
          renderTasks(); toast('已移除：' + t.fileName);
        } else {
          await invoke('remove_task', { id: t.id, deleteFile: false });
          toast('已移除：' + t.fileName);
        }
      }
    } catch (err) {
      const msg = (err && err.message) || String(err);
      toast('操作失败：' + msg, 'err');
      if (state.detailId === t.id) addLog('[错误] ' + msg, 'y');
    }
  }

  /* ---------------- 详情弹窗 ---------------- */
  function openDetail(id) {
    const t = state.tasks.get(id);
    if (!t) return;
    state.detailId = id;
    selectOnly(id);
    paintDetail();
    $('detailModal').hidden = false;
    $('app').classList.add('modal-open');
    const body = $('detailModal').querySelector('.modal-body');
    if (body) body.scrollTop = 0;
  }
  function closeDetail() {
    state.detailId = null;
    $('detailModal').hidden = true;
    $('app').classList.remove('modal-open');
  }

  function paintDetail() {
    const t = state.tasks.get(state.detailId);
    if (!t) { closeDetail(); return; }
    const kind = kindOf(t);
    const pct = pctOf(t);
    const settings = state.settings || DEMO_SETTINGS;
    $('detIcon').className = 'det-icon thumb' + (THUMB_CLASS[kind] ? ' ' + THUMB_CLASS[kind] : '');
    $('detIcon').innerHTML = ICON_SVG[kind];
    $('detName').textContent = t.fileName || nameFromUrl(t.url);
    $('modalSub').textContent = (STATE_TEXT[t.state] || '') + ' · Esc 或点击遮罩关闭';
    const pill = $('detStatus');
    pill.className = 'st ' + (STATE_CLASS[t.state] || 'wait');
    pill.textContent = '';
    pill.append(el('span', 'd'), document.createTextNode(STATE_TEXT[t.state] || t.state));
    const tags = $('detTags');
    tags.textContent = '';
    taskTags(t).forEach(([label, cls]) => tags.append(el('span', 'tag' + (cls ? ' ' + cls : ''), label)));
    $('detUrl').textContent = t.url || '—';

    const done = t.state === 'completed' ? (t.totalBytes || t.doneBytes) : t.doneBytes;
    $('heroSpeed').textContent = '';
    if (t.state === 'active') {
      $('heroSpeed').append(document.createTextNode((t.speedBps / MB).toFixed(1)), el('span', '', 'MB/s'));
    } else if (t.state === 'completed') {
      $('heroSpeed').append(document.createTextNode('100'), el('span', '', '%'));
    } else {
      $('heroSpeed').append(document.createTextNode('—'), el('span', '', ''));
    }
    const subs = {
      active: `分块 512 KB · 已用 ${t.connections || 1} 条连接 · 直接写入分段偏移`,
      queued: '等待连接额度 · 尚未写入磁盘',
      paused: '断点已保存 · 连接已释放，续传时按需重建',
      failed: '分片失败 · 断点保留 · 等待重试',
      completed: '全部分段完成 · 无临时分片合并'
    };
    $('heroSub').textContent = subs[t.state] || '—';
    $('mDone').textContent = fmtBytes(done);
    $('mTotal').textContent = fmtBytes(t.totalBytes);
    $('mEta').textContent = t.state === 'active' ? fmtEta(t) : '—';
    $('mVerify').textContent = t.state === 'completed' ? '未启用' : '—';
    $('mVerify').style.color = 'var(--fg-2)';
    $('heroFill').style.width = pct + '%';
    $('heroFill').style.background = t.state === 'failed' ? 'var(--err)' : '';
    $('heroPct').textContent = '已下载 ' + Math.round(pct) + '%';
    $('heroMax').textContent = `上限 ${settings.maxConnections || 16} 条`;
    $('segMeta').textContent = `${t.supportsRanges ? (t.connections || 1) + ' 段' : '单连接'} · 分块 512 KB`;

    /* 分段图：16 列按任务总进度依次填满，不伪造每段独立百分比 */
    const segBox = $('segmap');
    segBox.textContent = '';
    const total = t.state === 'completed' ? 1 : t.state === 'queued' ? 0 : pct / 100;
    for (let s = 0; s < 16; s++) {
      const col = el('div', 'seg');
      const frac = Math.max(0, Math.min(1, total * 16 - s));
      const filled = Math.floor(frac * 6);
      for (let i = 0; i < 6; i++) {
        const cell = el('i');
        if (i < filled) cell.className = 'f';
        else if (i === filled && t.state === 'active' && frac > 0) cell.className = 'a';
        col.append(cell);
      }
      segBox.append(col);
    }

    /* 连接明细：后端只上报任务总速率，这里不做分连接速率与进度造假 */
    const connBody = $('connBody');
    connBody.textContent = '';
    if (t.state === 'active') {
      const n = Math.max(1, Math.min(16, t.connections || 1));
      for (let i = 0; i < n; i++) {
        const row = el('div', 'conn-row');
        row.append(el('span', 'id', '#' + String(i + 1).padStart(2, '0')));
        const bar = el('div', 'bar');
        const fill = el('i');
        fill.style.width = Math.round(pct) + '%';
        bar.append(fill);
        row.append(bar, el('span', 'sp', '—'));
        connBody.append(row);
      }
      connBody.append(el('div', 'dim', '分连接速率与进度未上报，条形只表示任务总进度。'));
      $('connMeta').textContent = `${n} / ${settings.maxConnections || 16}`;
    } else {
      $('connMeta').textContent = t.state === 'completed' ? '已全部释放' : t.state === 'paused' ? '已释放' : t.state === 'failed' ? '已关闭' : '未建立';
      connBody.append(el('div', 'dim', {
        completed: '任务已完成 · 所有连接关闭，无残留句柄',
        paused: '任务已暂停 · 连接已释放，续传时按需重建',
        failed: '任务失败 · 连接已关闭，重试时重新协商 Range',
        queued: '尚未获得连接额度 · 调度器排队中'
      }[t.state] || '暂无连接信息。'));
    }

    $('kvWrite').textContent = t.supportsRanges ? '随机写 · 分段偏移' : '顺序写 · 单连接';
    $('kvBuffer').textContent = '4 KiB';
    $('kvSync').textContent = '未启用（后端无摘要接口）';
    $('kvGate').textContent = `${settings.maxConnections || 16} 条（单任务）`;
    $('kvSched').textContent = t.supportsRanges ? '自适应分段' : '单连接直下';
    const parts = (t.savePath || '').split(/[\\/]/);
    $('kvMedium').textContent = parts.length > 1 ? parts.slice(0, -1).join('\\') : (settings.downloadDir || '—');

    renderDetailActions(t);
    renderDetailLog(t);
  }

  function renderDetailActions(t) {
    const box = $('detActions');
    box.textContent = '';
    const add = (label, act, cls) => {
      const b = el('button', 'btn ' + (cls || ''), label);
      b.dataset.act = act;
      b.addEventListener('click', () => taskAction(t, act));
      box.append(b);
    };
    if (t.state === 'completed') {
      add('用默认程序打开', 'open', 'ok');
      add('打开所在文件夹', 'folder');
    } else if (t.state === 'paused' || t.state === 'queued') {
      add('开始', 'resume', 'primary');
      add('取消任务', 'remove');
    } else if (t.state === 'failed') {
      add('重试', 'resume', 'primary');
      add('移除', 'remove');
    } else {
      add('暂停', 'pause');
      add('打开文件夹', 'folder');
    }
  }

  function addLog(text, cls) {
    const line = el('div', 'ln');
    line.append(el('b', '', '[' + fmtClock(Date.now()) + '] '));
    line.append(el('span', cls || '', text));
    $('detLog').append(line);
  }

  function renderDetailLog(t) {
    const box = $('detLog');
    box.textContent = '';
    const created = t.createdAt || (Date.now() - 3600000);
    const line = (offset, label, detail, cls) => {
      const ln = el('div', 'ln');
      ln.append(el('b', '', '[' + fmtClock(created + offset) + '] '));
      ln.append(el('span', cls || '', `${label} · ${detail}`));
      box.append(ln);
    };
    line(0, '创建', `${t.supportsRanges ? (t.connections || 1) + ' 段' : '单连接'} · ${hostOf(t.url)}`);
    line(1200, '请求', t.supportsRanges ? 'Range 已确认 · 分段偏移写入' : '服务端未声明分段 · 顺序下载');
    if (t.state === 'active') {
      line(2400, '写入', `${fmtBytes(t.doneBytes)} 已落盘 · ${fmtSpeed(t.speedBps)}`, 'b');
      line(3600, '调度', `${t.connections || 1} 条连接 · 队列正常`);
    } else if (t.state === 'paused') {
      line(2400, '暂停', '断点已保存 · 连接已释放', 'y');
    } else if (t.state === 'failed') {
      line(2400, '失败', t.error || '未知错误', 'y');
      line(3000, '失败', '断点保留，可重试', 'y');
    } else if (t.state === 'completed') {
      line(2400, '完成', `${fmtBytes(t.totalBytes)} 已写入`, 'g');
    } else {
      line(2400, '排队', '等待调度额度', 'y');
    }
  }

  /* ---------------- 设置持久化 ---------------- */
  let saveTimer = 0;
  let savedTimer = 0;
  function markSaved(text, isErr) {
    const node = $('settingsSaveState');
    if (!node) return;
    node.textContent = text;
    node.classList.toggle('err-color', !!isErr);
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => {
      node.textContent = isDemo ? '演示模式 · 已自动保存' : '已自动保存';
      node.classList.remove('err-color');
    }, 2200);
  }
  function scheduleSave(delay) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persistSettings, delay == null ? 600 : delay);
  }
  function normalizeSettings(raw) {
    const s = Object.assign({}, raw);
    s.connections = Math.max(1, Math.min(32, Number(s.connections) || 8));
    s.maxConnections = Math.max(1, Math.min(16, Number(s.maxConnections) || 16));
    if (s.connections > s.maxConnections) s.connections = s.maxConnections;
    s.globalLimitBps = Math.max(0, Number(s.globalLimitBps) || 0);
    s.sniffTtlHours = Number(s.sniffTtlHours) || 0;
    s.connectTimeoutSec = Math.max(1, Number(s.connectTimeoutSec) || 10);
    s.readTimeoutSec = Math.max(1, Number(s.readTimeoutSec) || 30);
    s.density = s.density === 'compact' ? 'compact' : 'comfortable';
    s.theme = ['dark', 'light', 'system'].includes(s.theme) ? s.theme : 'dark';
    s.sniffTier = ['A', 'B', 'C'].includes(s.sniffTier) ? s.sniffTier : 'B';
    s.videoPreferred = ['compat', 'best', 'small'].includes(s.videoPreferred) ? s.videoPreferred : 'compat';
    return s;
  }
  async function persistSettings() {
    if (!state.settings) return;
    const next = normalizeSettings(state.settings);
    if (isDemo) {
      state.settings = next;
      markSaved('演示模式 · 已保存');
      return;
    }
    try {
      await invoke('save_settings', { settings: next });
      state.settings = next;
      markSaved('已自动保存');
    } catch (err) {
      markSaved('保存失败：' + ((err && err.message) || err), true);
      toast('设置保存失败：' + ((err && err.message) || err), 'err');
    }
  }

  function paintSwitch(id, on) {
    const sw = $(id);
    if (!sw) return;
    sw.classList.toggle('on', !!on);
    sw.setAttribute('aria-checked', String(!!on));
  }
  function bindSwitch(id, key, after) {
    const sw = $(id);
    if (!sw || sw.disabled) return;
    sw.addEventListener('click', () => {
      if (!state.settings) return;
      state.settings[key] = !state.settings[key];
      paintSwitch(id, state.settings[key]);
      if (after) after(state.settings[key]);
      scheduleSave(200);
    });
  }

  // 安装范围与提权状态都来自后端实测（进程令牌 + 可执行文件位置），不在前端推断。
  function renderInstallInfo() {
    const scopeTag = $('installScopeTag');
    if (!scopeTag) return;
    const paint = (info, elev) => {
      scopeTag.textContent = info.scopeLabel || '未知';
      const dir = $('installDirText');
      if (dir) {
        dir.textContent = info.installDir || '';
        dir.title = info.maintenance || '';
      }
      if (elev) {
        const tag = $('elevationTag');
        if (tag) tag.textContent = elev.elevationLabel || '普通权限';
        const note = $('uipiNote');
        if (note) note.hidden = !(elev.runAsAdmin || elev.elevated);
        const sw = $('swRunAsAdmin');
        if (sw && elev.platform !== 'windows') {
          sw.disabled = true;
          sw.title = '该选项仅在 Windows 生效';
        }
        // 已开启管理员模式但当前不是提权进程：给出一次显式重启入口，
        // 启动路径本身不再自动请求 UAC。
        const restart = $('adminRestart');
        if (restart) {
          restart.hidden = !(elev.platform === 'windows' && elev.runAsAdmin && !elev.elevated);
        }
      }
    };
    if (!IS_TAURI) {
      paint(
        { scopeLabel: '当前用户（用户目录）', installDir: '%LOCALAPPDATA%\\Fetchweir', maintenance: '演示数据：切换安装范围需要卸载后重装' },
        { platform: 'windows', elevationLabel: '普通权限', runAsAdmin: !!state.settings.runAsAdmin, elevated: false },
      );
      return;
    }
    Promise.all([invoke('install_info'), invoke('elevation_status')])
      .then(([info, elev]) => paint(info, elev))
      .catch(() => { scopeTag.textContent = '读取失败'; });
  }

  function renderSettings() {
    const s = state.settings;
    if (!s) return;
    $('setDir').value = s.downloadDir || '';
    $('segRange').value = String(s.connections);
    $('segOut').textContent = String(s.connections);
    $('connRange').value = String(s.maxConnections);
    $('connOut').textContent = String(s.maxConnections);
    $('limitRange').value = String(s.globalLimitBps ? Math.round(s.globalLimitBps / MB) : 0);
    updateLimitLabel();
    $('timeoutSel').value = `${s.connectTimeoutSec},${s.readTimeoutSec}`;
    $('ttlSel').value = String(s.sniffTtlHours);
    $('tierSel').value = s.sniffTier;
    $('sniffTier').value = s.sniffTier;
    $('videoPrefSel').value = s.videoPreferred;
    paintTheme(s.theme);
    applyAccent(s.accent);
    document.documentElement.dataset.density = s.density === 'compact' ? 'compact' : 'comfortable';
    $$('[data-density-set]').forEach((b) => b.classList.toggle('on', b.dataset.densitySet === document.documentElement.dataset.density));
    paintSwitch('swCloseTray', s.closeToTray);
    paintSwitch('swAutostart', s.autostart);
    paintSwitch('swRunAsAdmin', s.runAsAdmin);
    renderInstallInfo();
    paintSwitch('swReduce', s.reduceMotion);
    $('setUpdateRepo').value = s.updateRepo || '';
    $('setUpdateToken').value = s.updateToken || '';
    $('setHomepage').value = s.homepage || '';
    renderExtStatus();
    renderSniffStoreInfo();
    if (state.info) {
      $('setVersion').textContent = 'v' + state.info.version;
      $('statusVersion').textContent = 'v' + state.info.version;
    }
  }

  function updateLimitLabel() {
    const v = Number($('limitRange').value) || 0;
    $('limitOut').textContent = v ? v + ' MB/s' : '不限速';
    if (state.settings) state.settings.globalLimitBps = v * MB;
  }

  /* 扩展安装状态：文件是否随包落盘 + 宿主是否已写进浏览器 HKCU。 */
  state.extInfo = null;
  async function loadExtensionInfo() {
    try {
      state.extInfo = await invoke('extension_info');
    } catch (err) {
      state.extInfo = null;
    }
    renderExtensionInfo();
  }
  function renderExtensionInfo() {
    const tag = $('extStatusTag');
    const reg = $('extRegText');
    if (!tag || !reg) return;
    const info = state.extInfo;
    const nm = state.sniffNm || {};
    const connected = !!nm.endpointPort;
    const guide = $('extGuideStatus');
    const dirText = $('extDirText');
    if (!info) {
      tag.textContent = '未连接';
      tag.style.color = '';
      reg.textContent = '未注册浏览器';
      if (guide) guide.textContent = '无法读取扩展状态';
      return;
    }
    tag.textContent = !info.present ? '扩展文件缺失' : (connected ? '已连接' : '已随包提供');
    tag.style.color = !info.present ? 'var(--err)' : (connected ? 'var(--ok)' : '');
    reg.textContent = info.browsers.length ? `宿主已注册：${info.browsers.join('、')}` : '宿主未注册';
    if (guide) {
      guide.textContent = `扩展文件：${info.present ? '已随安装包提供' : '缺失'} · Native Messaging 宿主：${
        info.host_registered ? `${info.browsers.join('、')}（HKCU，无需管理员）` : '未注册'
      }`;
    }
    if (dirText) dirText.textContent = info.dir ? `扩展目录：${info.dir}` : '扩展目录 —';
  }

  function renderExtStatus() {
    const nm = state.sniffNm;
    const tag = $('extStatusTag');
    const reg = $('extRegText');
    if (!tag || !reg) return;
    if (state.extInfo) {
      renderExtensionInfo();
    } else if (!nm) {
      tag.textContent = '未连接';
      reg.textContent = '未注册浏览器';
    } else {
      tag.textContent = nm.endpointPort ? '桥接就绪' : '未连接';
      tag.style.color = nm.endpointPort ? 'var(--ok)' : '';
      const names = (nm.registered || []).filter(Boolean);
      reg.textContent = names.length ? `${names.length} 个浏览器已注册：${names.join('、')}` : '未注册浏览器';
    }
    const port = $('sniffPort');
    if (port) port.textContent = nm && nm.endpointPort ? String(nm.endpointPort) : '—';
    const ext = $('sniffExtState');
    if (ext) {
      ext.textContent = nm && nm.endpointPort ? '宿主已就绪' : '扩展未连接';
      ext.style.color = nm && nm.endpointPort ? 'var(--ok)' : '';
    }
  }
  function renderSniffStoreInfo() {
    const node = $('sniffStoreInfo');
    if (!node) return;
    const ttl = state.settings ? state.settings.sniffTtlHours : 24;
    const keep = ttl ? `${ttl} 小时` : '直到手动清除';
    node.textContent = `本机保存 ${state.sniff.length} 条候选记录 · 保留 ${keep}（仅内存）`;
  }

  async function setTier(value) {
    if (!state.settings) return;
    state.settings.sniffTier = value;
    $('tierSel').value = value;
    $('sniffTier').value = value;
    if (isDemo) { markSaved('演示模式 · 档位已切换'); return; }
    try {
      await invoke('set_sniff_tier', { tier: value });
      markSaved('已保存');
    } catch (err) {
      markSaved('档位保存失败：' + ((err && err.message) || err), true);
      toast('切换档位失败：' + ((err && err.message) || err), 'err');
    }
  }

  /* ---------------- 更新 ---------------- */
  const UPDATE_STAGE_TEXT = {
    idle: '尚未检查', checking: '正在检查更新…', upToDate: '已是最新版本',
    updateAvailable: '发现新版本', downloading: '正在下载更新包', downloaded: '更新包已下载',
    installing: '正在安装更新', failed: '更新失败'
  };
  function renderUpdate(u) {
    if (!u) return;
    state.update = u;
    const hasLatest = !!u.latestVersion;
    $('updatePanel').hidden = !hasLatest;
    const hint = $('updateHint');
    let hintText = UPDATE_STAGE_TEXT[u.stage] || u.stage || '尚未检查';
    if (u.stage === 'updateAvailable' && u.latestVersion) hintText = `发现新版本 v${u.latestVersion}`;
    if (u.stage === 'upToDate') hintText = '已是最新版本';
    if (u.stage === 'downloading') hintText = `正在下载 ${Math.round(u.progress || 0)}%`;
    hint.textContent = hintText;
    hint.classList.toggle('err-color', u.stage === 'failed');
    if (u.currentVersion) $('setVersion').textContent = 'v' + u.currentVersion;

    $('updateVer').textContent = hasLatest ? 'v' + u.latestVersion : '—';
    $('updateDate').textContent = u.publishedAt ? '发布于 ' + fmtWhen(Date.parse(u.publishedAt)) : '—';
    $('updateNotes').textContent = u.notes || '没有提供更新说明。';
    renderUpdateMirrors(u);

    const pct = Math.max(0, Math.min(100, Number(u.progress) || 0));
    $('updateFill').style.width = pct + '%';
    $('updateProgressText').textContent = u.stage === 'downloading' ? `正在下载 · ${Math.round(pct)}%` : u.canInstall ? '已下载 100%' : '—';
    $('updateSize').textContent = (u.total ? `${fmtBytes(u.downloaded)} / ${fmtBytes(u.total)}` : (u.assetSize ? fmtBytes(u.assetSize) : '—'));

    const busy = u.stage === 'downloading' || u.stage === 'installing';
    const canInstall = !!u.canInstall;
    $('btnUpdateNow').hidden = canInstall;
    $('btnDownloadOnly').hidden = canInstall;
    $('btnUpdateNow').disabled = busy || u.stage === 'checking';
    $('btnDownloadOnly').disabled = busy || u.stage === 'checking';
    $('btnCancelUpdate').hidden = u.stage !== 'downloading';
    $('btnInstallUpdate').hidden = !canInstall;
    $('btnInstallUpdate').disabled = busy;
    $('btnOpenDownloadDir').hidden = !canInstall;
    $('updateMirror').disabled = busy;

    const msg = $('updateMsg');
    if (u.message && u.stage !== 'downloading') {
      msg.hidden = false;
      msg.textContent = u.message;
      msg.classList.toggle('err', u.stage === 'failed');
    } else {
      msg.hidden = true;
      msg.textContent = '';
    }
  }
  function renderUpdateMirrors(u) {
    const sel = $('updateMirror');
    if (!sel) return;
    const list = u.mirrors || [];
    const sig = list.map((m) => m.id + ':' + m.label).join('|');
    if (sel.dataset.sig !== sig) {
      sel.textContent = '';
      list.forEach((m) => {
        const opt = el('option', '', m.label);
        opt.value = m.id;
        sel.append(opt);
      });
      sel.dataset.sig = sig;
    }
    sel.value = u.mirror || (list[0] && list[0].id) || 'github';
  }
  function demoCheckUpdate() {
    renderUpdate(Object.assign({}, state.update || DEMO_UPDATE, { stage: 'checking', message: null }));
    clearTimeout(state.timers.updateCheck);
    state.timers.updateCheck = setTimeout(() => {
      renderUpdate(Object.assign({}, DEMO_UPDATE, { progress: 0, downloaded: 0, canInstall: false, path: null, message: null }));
      toast('演示模式：发现新版本 v' + DEMO_UPDATE.latestVersion);
    }, 900);
  }
  function demoUpdateDownload(mode) {
    const base = state.update || DEMO_UPDATE;
    const total = base.total || base.assetSize || 18.4 * MB;
    let pct = Number(base.progress) || 0;
    clearInterval(state.timers.updateDownload);
    renderUpdate(Object.assign({}, base, { stage: 'downloading', total, progress: pct, downloaded: total * pct / 100, canInstall: false, path: null, message: '演示模式：正在模拟下载更新包' }));
    state.timers.updateDownload = setInterval(() => {
      pct = Math.min(100, pct + 5 + Math.random() * 8);
      const done = pct >= 100;
      const next = Object.assign({}, state.update, {
        stage: done ? 'downloaded' : 'downloading',
        progress: pct,
        downloaded: total * pct / 100,
        total,
        canInstall: done,
        path: done ? 'C:\\Users\\Tyler\\Downloads\\' + (state.update.assetName || 'update.exe') : null,
        message: done ? (mode === 'only' ? '演示模式：更新包已下载，未安装' : '演示模式：更新包已下载') : '演示模式：正在模拟下载更新包'
      });
      renderUpdate(next);
      if (done) {
        clearInterval(state.timers.updateDownload);
        toast('演示模式：更新包已下载');
      }
    }, 260);
  }

  /* ---------------- 视频下载 ---------------- */
  const VID_EMPTY_TEXT = '还没有解析结果。输入页面链接后点击「解析」，格式清单由本地解析器返回。';
  const codecName = (c) => {
    if (!c || c === 'none') return '—';
    if (c.startsWith('av01')) return 'AV1';
    if (c.startsWith('vp09') || c.startsWith('vp8')) return 'VP9';
    if (c.startsWith('hev1') || c.startsWith('hvc1')) return 'HEVC';
    if (c.startsWith('avc1') || c.startsWith('h264')) return 'H.264';
    if (c.startsWith('mp4a')) return 'AAC';
    if (c.startsWith('opus')) return 'OPUS';
    if (c.startsWith('vorbis')) return 'Vorbis';
    if (c.startsWith('flac')) return 'FLAC';
    return c.split('.')[0];
  };
  const fmtBitrate = (tbr) => tbr > 0 ? Math.round(tbr) + ' kbps' : '—';
  const isVideoFmt = (f) => f.vcodec && f.vcodec !== 'none';
  const hasAudioFmt = (f) => f.acodec && f.acodec !== 'none';

  function renderVideo() {
    const info = state.video.info;
    const empty = $('vidEmpty');
    if (!info) {
      empty.hidden = false;
      empty.textContent = VID_EMPTY_TEXT;
      $('vidTop').hidden = true;
      $('vidGrid').hidden = true;
      return;
    }
    empty.hidden = true;
    $('vidTop').hidden = false;
    $('vidGrid').hidden = false;
    $('vidEmpty').textContent = VID_EMPTY_TEXT;
    if (state.video.url) $('videoUrl').value = state.video.url;

    const videoFmts = info.formats.filter(isVideoFmt);
    const maxH = videoFmts.reduce((a, f) => Math.max(a, f.height || 0), 0);
    $('posterRes').textContent = maxH ? maxH + 'P' : '—';
    $('posterDur').textContent = info.duration ? fmtDuration(info.duration) : '—';
    $('vidTitle').textContent = info.title || '未命名视频';
    const meta = [];
    if (info.uploader) meta.push(info.uploader);
    if (info.duration) meta.push(fmtDuration(info.duration));
    meta.push(hostOf(info.webpageUrl || state.video.url));
    $('vidMeta').textContent = meta.join(' · ');

    const chips = $('vidChips');
    chips.textContent = '';
    chips.append(el('span', 'tag', `视频 ${videoFmts.length} 条`));
    chips.append(el('span', 'tag', `音频 ${info.formats.filter((f) => !isVideoFmt(f)).length} 条`));
    if (maxH >= 2160) chips.append(el('span', 'tag hls', '4K'));
    // 时长 / 协议 / DRM 都是解析器真实返回的字段，不在这里编造。
    if (info.duration) chips.append(el('span', 'tag', `时长 ${fmtDuration(info.duration)}`));
    const protos = [...new Set(info.formats.map((f) => f.protocol).filter(Boolean))];
    if (protos.length) chips.append(el('span', 'tag', `协议 ${protos.slice(0, 3).join('/')}`));
    const drmCount = info.formats.filter((f) => f.drm).length;
    if (drmCount) chips.append(el('span', 'tag protected', `DRM 受保护 ${drmCount} 条`));
    else if (info.formats.length) chips.append(el('span', 'tag ok', '无 DRM'));
    if (info.drmOnly) chips.append(el('span', 'tag protected', '仅 DRM 流'));
    if (info.message) chips.append(el('span', 'tag dup', '解析提示'));

    $('tabNVideo').textContent = String(videoFmts.length);
    $('tabNAudio').textContent = String(info.formats.filter((f) => !isVideoFmt(f)).length);
    $$('#fmtTabs button').forEach((b) => {
      if (b.dataset.tab) b.classList.toggle('on', b.dataset.tab === state.video.tab);
    });

    if (!state.video.sel || !info.formats.some((f) => f.formatId === state.video.sel)) {
      const pref = preferredFormat(info.formats);
      state.video.sel = pref ? pref.formatId : null;
    }
    renderFormats();
    updateOutput();
  }

  function preferredFormat(formats) {
    const avail = formats.filter((f) => !f.drm && !f.needsMux && isVideoFmt(f));
    if (!avail.length) {
      const audio = formats.filter((f) => !f.drm && !f.needsMux && hasAudioFmt(f) && !isVideoFmt(f));
      return audio[0] || null;
    }
    const pref = (state.settings && state.settings.videoPreferred) || 'compat';
    if (pref === 'best') return avail.slice().sort((a, b) => (b.height - a.height) || (b.size - a.size))[0];
    if (pref === 'small') return avail.slice().sort((a, b) => (a.size - b.size) || (a.height - b.height))[0];
    const compat = avail.filter((f) => /^(avc1|h264)/i.test(f.vcodec));
    const pick = compat.find((f) => f.height === 1080) || compat.find((f) => f.height >= 720) || compat[0] || avail[0];
    return pick;
  }

  function renderFormats() {
    const info = state.video.info;
    if (!info) return;
    const body = $('fmtBody');
    body.textContent = '';
    let rows = info.formats.slice();
    if (state.video.tab === 'video') rows = rows.filter(isVideoFmt).sort((a, b) => (b.height - a.height) || (b.fps - a.fps));
    else rows = rows.filter((f) => !isVideoFmt(f)).sort((a, b) => (b.size - a.size));
    if (!rows.length) {
      const tr = el('tr');
      const td = el('td', 'dim', state.video.tab === 'video' ? '解析器没有返回独立视频流。' : '解析器没有返回独立音频流。');
      td.colSpan = 8;
      tr.append(td);
      body.append(tr);
      return;
    }
    rows.forEach((f) => {
      const off = f.drm || f.needsMux;
      const tr = el('tr', (off ? 'off' : '') + (f.formatId === state.video.sel ? ' on' : ''));
      tr.dataset.fmt = f.formatId;
      tr.title = f.drm ? (f.drmReason || '受 DRM 保护') : f.needsMux ? '单流格式需要 ffmpeg 转封装，当前版本不可直接下载' : '';
      const tdRadio = el('td');
      const radio = el('span', 'radio' + (f.formatId === state.video.sel ? ' on' : ''));
      tdRadio.append(radio);

      const tdRes = el('td');
      if (isVideoFmt(f)) {
        const b = el('b', '', (f.width || '?') + '×' + (f.height || '?'));
        tdRes.append(b);
        if (f.height >= 2160) tdRes.append(document.createTextNode(' '), el('span', 'q-badge', '4K'));
      } else {
        tdRes.append(el('span', 'dim', '音频'));
      }

      const tdCodec = el('td', '', codecName(isVideoFmt(f) ? f.vcodec : f.acodec));
      const tdFps = el('td', '', f.fps ? Math.round(f.fps) : '—');
      const tdExt = el('td', '', (f.ext || '—').toUpperCase());
      const tdBtr = el('td', 'r', fmtBitrate(f.tbr));
      const tdSize = el('td', 'r', f.size ? fmtBytes(f.size) : '—');
      [tdRes, tdCodec, tdFps, tdExt, tdBtr, tdSize].forEach((td) => { td.style.whiteSpace = 'nowrap'; });
      const tdNote = el('td');
      if (f.recommended) tdNote.append(el('span', 'q-badge best', '推荐'));
      if (f.drm) tdNote.append(document.createTextNode(' '), el('span', 'q-badge warn', 'DRM 保护'));
      if (f.needsMux) tdNote.append(document.createTextNode(' '), el('span', 'q-badge warn', '需转封装'));
      if (!f.drm && !f.needsMux && !f.recommended) {
        if (isVideoFmt(f) && hasAudioFmt(f)) tdNote.append(el('span', 'q-badge', '含音轨'));
        else if (!isVideoFmt(f)) tdNote.append(el('span', 'q-badge', '仅音频'));
      }
      tr.append(tdRadio, tdRes, tdCodec, tdFps, tdExt, tdBtr, tdSize, tdNote);
      if (!off) {
        tr.addEventListener('click', () => {
          state.video.sel = f.formatId;
          renderFormats();
          updateOutput();
        });
      }
      body.append(tr);
    });
  }

  function updateOutput() {
    const info = state.video.info;
    const f = info && info.formats.find((x) => x.formatId === state.video.sel);
    const out = $('btnVideoDownload');
    if (!f) {
      $('outVideo').textContent = '—';
      $('outVSize').textContent = '—';
      $('outAudio').textContent = '—';
      $('outASize').textContent = '—';
      $('outTotal').textContent = '—';
      out.disabled = true;
      $('fmtHint').textContent = '选择一行可用格式后点击「加入下载」。';
      renderCompat(null);
      return;
    }
    const video = isVideoFmt(f);
    const blocked = f.drm || f.needsMux;
    $('outVideo').textContent = video ? `${(f.width || '?')}×${(f.height || '?')} · ${codecName(f.vcodec)} · ${f.fps ? Math.round(f.fps) + 'fps' : '—'}` : '—';
    $('outVSize').textContent = video ? fmtBytes(f.size) : '—';
    $('outAudio').textContent = video ? (hasAudioFmt(f) ? codecName(f.acodec) : '需另选音轨') : codecName(f.acodec);
    $('outASize').textContent = video ? (hasAudioFmt(f) ? '含于所选' : '—') : fmtBytes(f.size);
    $('outTotal').textContent = fmtBytes(f.size);
    out.disabled = blocked;
    $('fmtHint').textContent = blocked
      ? (f.drm ? '该格式受 DRM 保护，按产品边界不可下载。' : '该格式只有单条流，需要 ffmpeg 转封装，当前版本不可下载。')
      : `已选择 ${f.formatId} · ${(f.ext || '').toUpperCase()}`;
    renderCompat(f);
  }

  function renderCompat(f) {
    const box = $('vidCompat');
    box.textContent = '';
    const add = (text, cls) => box.append(el('span', 'cv' + (cls ? ' ' + cls : ''), text));
    if (!f) { add('未选择格式'); return; }
    if (f.drm) { add('DRM 受保护', 'no'); return; }
    if (f.needsMux) { add('需要转封装', 'no'); add('v1 不随包 ffmpeg', 'no'); return; }
    if (/^(avc1|h264)/i.test(f.vcodec)) add('H.264 · 通用兼容', 'ok');
    else if (isVideoFmt(f)) add(codecName(f.vcodec) + ' · 部分播放器需解码', 'no');
    if (hasAudioFmt(f)) add(codecName(f.acodec) + ' 音轨', 'ok');
    add((f.ext || '').toUpperCase() + ' 容器', '');
  }

  async function probeVideo() {
    const url = $('videoUrl').value.trim();
    const empty = $('vidEmpty');
    if (!/^https?:\/\//i.test(url)) {
      empty.hidden = false;
      empty.textContent = '请输入完整的 http(s) 页面链接后再点「解析」。';
      empty.classList.add('err-color');
      toast('链接不合法，需要 http(s) 地址', 'err');
      return;
    }
    empty.classList.remove('err-color');
    state.video.url = url;
    if (isDemo) {
      state.video.info = demoVideo();
      state.video.sel = null;
      renderVideo();
      toast('演示模式：已加载示例解析结果');
      return;
    }
    const btn = $('btnProbe');
    btn.disabled = true;
    btn.textContent = '解析中…';
    empty.hidden = false;
    empty.textContent = '正在调用本地解析器，最长等待 60 秒…';
    try {
      const info = await invoke('probe_video', { url });
      state.video.info = info;
      state.video.sel = null;
      empty.textContent = VID_EMPTY_TEXT;
      renderVideo();
      if (info.drmOnly) toast('该页面仅提供 DRM 保护流，按产品边界不下载', 'err');
    } catch (err) {
      const msg = (err && err.message) || String(err);
      empty.hidden = false;
      empty.textContent = '解析失败：' + msg;
      empty.classList.add('err-color');
      state.video.info = null;
      $('vidTop').hidden = true;
      $('vidGrid').hidden = true;
      toast('解析失败：' + msg, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = '解析';
    }
  }

  function paintVideoJob() {
    const job = state.video.job;
    if (!job) { $('videoJob').hidden = true; return; }
    $('videoJob').hidden = false;
    const stageText = { starting: '启动解析器…', running: '解析器下载中', done: '已完成', failed: '下载失败' }[job.stage] || job.stage;
    $('vjStage').textContent = job.message ? `${stageText} · ${job.message}` : stageText;
    const pct = Math.max(0, Math.min(100, Number(job.percent) || 0));
    $('vjPct').textContent = Math.round(pct) + '%';
    $('vjFill').style.width = pct + '%';
    $('vjFill').style.background = job.stage === 'failed' ? 'var(--err)' : '';
  }

  function demoVideoJob() {
    const job = { jobId: 9001, stage: 'starting', percent: 0, message: '正在启动解析器' };
    state.video.job = job;
    paintVideoJob();
    clearInterval(state.timers.videoJob);
    state.timers.videoJob = setInterval(() => {
      const pct = Math.min(100, (state.video.job.percent || 0) + 6 + Math.random() * 6);
      const done = pct >= 100;
      state.video.job = Object.assign({}, state.video.job, {
        stage: done ? 'done' : 'running',
        percent: pct,
        message: done ? '演示模式：已完成' : '演示模式：正在模拟解析器下载'
      });
      paintVideoJob();
      if (done) {
        clearInterval(state.timers.videoJob);
        toast('演示模式：视频下载完成');
      }
    }, 500);
  }

  function onVideoEvent(p) {
    if (!p) return;
    if (state.video.job && p.jobId && state.video.job.jobId && p.jobId !== state.video.job.jobId) return;
    state.video.job = Object.assign({}, state.video.job || {}, p);
    paintVideoJob();
    if (p.stage === 'done') toast('视频下载完成' + (p.path ? '：' + p.path : ''));
    if (p.stage === 'failed') toast('视频下载失败：' + (p.message || '解析器退出异常'), 'err');
  }

  async function addVideoTask() {
    const info = state.video.info;
    const f = info && info.formats.find((x) => x.formatId === state.video.sel);
    if (!f || f.drm || f.needsMux) return;
    if (isDemo) {
      demoVideoJob();
      toast('演示模式：已加入视频下载队列');
      return;
    }
    try {
      const res = await invoke('add_video_task', {
        url: state.video.url || info.webpageUrl,
        formatId: f.formatId,
        saveDir: (state.settings && state.settings.downloadDir) || null
      });
      if (res && res.mode === 'direct' && res.task) {
        upsertTask(res.task);
        setView('main');
        renderTasks();
        toast('已加入下载：' + res.task.fileName);
      } else {
        state.video.job = { jobId: res && res.jobId, stage: 'starting', percent: 0, message: '已交给解析器下载' };
        paintVideoJob();
        toast('已交给解析器下载');
      }
    } catch (err) {
      const msg = (err && err.message) || String(err);
      toast('加入下载失败：' + msg, 'err');
      setAreaError($('vidCompat'), '加入下载失败：' + msg);
    }
  }

  async function copySelectedLink() {
    const info = state.video.info;
    const f = info && info.formats.find((x) => x.formatId === state.video.sel);
    if (!f || !f.url) { toast('所选格式没有可用直链', 'err'); return; }
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(f.url);
      } else {
        const ta = el('textarea');
        ta.value = f.url;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.append(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      toast('直链已复制到剪贴板');
    } catch (err) {
      toast('复制失败：' + ((err && err.message) || err), 'err');
    }
  }

  /* ---------------- 资源嗅探 ---------------- */
  const SNIFF_BUCKET = { hls: 'stream', dash: 'stream', video: 'video', audio: 'audio', image: 'image', doc: 'doc', archive: 'doc', file: 'doc' };
  const SNIFF_GROUP = [
    { key: 'stream', label: '流媒体清单' },
    { key: 'video', label: '视频文件' },
    { key: 'audio', label: '音频' },
    { key: 'image', label: '图片' },
    { key: 'doc', label: '文档与文件' }
  ];
  const bucketOf = (item) => SNIFF_BUCKET[item.kind] || 'doc';
  const sniffExt = (item) => {
    const e = extOf(item.url || '');
    if (e) return e.toUpperCase();
    if (item.mime) return item.mime.split('/').pop().split(';')[0].toUpperCase();
    return (item.kind || 'FILE').toUpperCase();
  };
  const sniffName = (item) => {
    const n = nameFromUrl(item.url);
    return n || sniffExt(item) + ' 资源';
  };
  const sniffHost = (item) => hostOf(item.pageUrl || item.url);

  function renderSniff() {
    const all = state.sniff.slice().sort((a, b) => (b.at || 0) - (a.at || 0));
    const counts = { all: all.length, video: 0, audio: 0, stream: 0, image: 0, doc: 0 };
    all.forEach((i) => { counts[bucketOf(i)] = (counts[bucketOf(i)] || 0) + 1; });
    const setC = (id, n) => { const node = $(id); if (node) node.textContent = String(n); };
    setC('sChipAll', counts.all); setC('sChipVideo', counts.video); setC('sChipAudio', counts.audio);
    setC('sChipStream', counts.stream); setC('sChipImage', counts.image); setC('sChipDoc', counts.doc);
    const cntSniff = $('cntSniff');
    if (cntSniff) cntSniff.textContent = String(all.length);

    const latest = all[0];
    if (latest) {
      $('sniffUrl').textContent = latest.pageUrl || latest.url;
      $('sniffPageMeta').textContent = `${latest.browser || '浏览器'} · ${latest.pageTitle || '未命名页面'} · ${all.length} 项候选 · 捕获于 ${fmtClock(latest.at)}`;
    } else {
      $('sniffUrl').textContent = '尚未捕获';
      $('sniffPageMeta').textContent = '—';
    }
    renderSniffDomain(all);
    renderSniffExt(all);

    const kw = ($('sniffKw').value || '').trim().toLowerCase();
    const minSize = Number($('sniffMinSize').value) || 0;
    const domain = $('sniffDomain').value || '';
    const ext = ($('sniffExt').value || '').toLowerCase();
    const filtered = all.filter((item) => {
      if (state.sniffChip !== 'all' && bucketOf(item) !== state.sniffChip) return false;
      if (state.sniffHideDup && (item.hits || 0) > 1) return false;
      if (minSize && (item.size || 0) < minSize) return false;
      if (domain && sniffHost(item) !== domain) return false;
      if (ext && extOf(item.url) !== ext) return false;
      if (kw) {
        const hay = (item.url + ' ' + (item.pageUrl || '') + ' ' + (item.mime || '') + ' ' + sniffName(item)).toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });

    const box = $('sniffGroups');
    box.textContent = '';
    if (!filtered.length) {
      $('sniffEmpty').hidden = false;
      $('sniffEmpty').textContent = all.length ? '没有符合筛选条件的候选资源。切换筛选条件，或在浏览器里播放/滚动页面后再试。' : '还没有捕获到候选资源。确认浏览器扩展已注册，并打开「嗅探浮动条」后刷新页面。';
    } else {
      $('sniffEmpty').hidden = true;
      SNIFF_GROUP.forEach((g) => {
        const items = filtered.filter((i) => bucketOf(i) === g.key);
        if (!items.length) return;
        box.append(buildSniffGroup(g, items));
      });
    }
    $$('.chip[data-schip]').forEach((c) => c.classList.toggle('on', c.dataset.schip === state.sniffChip));
    updateSniffBulk();
    renderSniffStoreInfo();
  }

  function renderSniffDomain(all) {
    const sel = $('sniffDomain');
    if (!sel) return;
    const hosts = Array.from(new Set(all.map(sniffHost).filter((h) => h && h !== '—'))).sort();
    const sig = hosts.join('|');
    if (sel.dataset.sig !== sig) {
      const prev = sel.value;
      sel.textContent = '';
      const optAll = el('option', '', '全部域名');
      optAll.value = '';
      sel.append(optAll);
      hosts.forEach((h) => {
        const o = el('option', '', h);
        o.value = h;
        sel.append(o);
      });
      sel.dataset.sig = sig;
      sel.value = hosts.includes(prev) ? prev : '';
    }
  }

  function renderSniffExt(all) {
    const sel = $('sniffExt');
    if (!sel) return;
    const exts = Array.from(new Set(all.map((i) => extOf(i.url)).filter(Boolean))).sort();
    const sig = exts.join('|');
    if (sel.dataset.sig !== sig) {
      const prev = sel.value;
      sel.textContent = '';
      const optAll = el('option', '', '全部格式');
      optAll.value = '';
      sel.append(optAll);
      exts.forEach((x) => {
        const o = el('option', '', '.' + x);
        o.value = x;
        sel.append(o);
      });
      sel.dataset.sig = sig;
      sel.value = exts.includes(prev) ? prev : '';
    }
  }

  function buildSniffGroup(g, items) {
    const grp = el('div', 'grp');
    grp.dataset.kind = g.key;
    const head = el('div', 'grp-h');
    head.append(el('span', 't', g.label));
    const total = items.reduce((a, i) => a + (i.size || 0), 0);
    head.append(el('span', 'c', `${items.length} 项 · ${fmtBytes(total)}`));
    const acts = el('div', 'acts');
    const btn = el('button', 'btn sm ghost', '全选本组');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      items.filter((i) => !i.protected && !i.drmSuspect).forEach((i) => state.sniffSel.add(i.id));
      paintSniffSelection();
    });
    acts.append(btn);
    head.append(acts);
    grp.append(head);

    const body = el('div', 'grp-body');
    items.forEach((item) => body.append(buildSniffRow(item)));
    grp.append(body);
    return grp;
  }

  function buildSniffRow(item) {
    const off = !!(item.protected || item.drmSuspect);
    const row = el('div', 'sn' + (off ? ' off' : '') + (state.sniffSel.has(item.id) ? ' on' : ''));
    row.dataset.id = item.id;
    row.dataset.bytes = String(item.size || 0);
    const cb = el('span', 'cb' + (state.sniffSel.has(item.id) ? ' on' : ''));
    cb.innerHTML = CHECK_SVG;
    row.append(cb);

    const thumb = el('div', 'sn-thumb');
    const bucket = bucketOf(item);
    const grad = bucket === 'stream' || bucket === 'video' ? 'g1' : bucket === 'audio' ? 'g2' : bucket === 'image' ? 'g3' : '';
    if (grad) thumb.append(el('div', grad));
    const mini = item.kind === 'hls' || item.kind === 'dash' ? 'HLS' : bucket === 'video' ? '▶' : bucket === 'audio' ? '♪' : bucket === 'image' ? 'IMG' : sniffExt(item).slice(0, 3);
    thumb.append(el('span', 'mini', mini));
    row.append(thumb);

    const info = el('div');
    info.style.minWidth = '0';
    info.append(el('div', 'sn-name', sniffName(item)));
    info.append(el('div', 'sn-url', hostOf(item.url) + pathOf(item.url)));
    row.append(info);

    row.append(el('div', 'sn-size', item.size ? fmtBytes(item.size) : '—'));

    const badges = el('div', 'sn-badges');
    badges.append(el('span', 'tag' + (item.kind === 'hls' || item.kind === 'dash' ? ' hls' : ''), sniffExt(item)));
    if (item.kind === 'hls' || item.kind === 'dash') badges.append(el('span', 'tag hls', item.kind.toUpperCase()));
    if (item.protected) badges.append(el('span', 'tag protected', '受保护'));
    if (item.drmSuspect) badges.append(el('span', 'tag protected', '疑似 DRM'));
    if ((item.hits || 0) > 1) badges.append(el('span', 'dup', '疑似重复'));
    row.append(badges);

    row.append(el('div', 'sn-act', item.protected ? '受保护' : item.drmSuspect ? '疑似 DRM' : (item.kind === 'hls' || item.kind === 'dash') ? '清单' : '直链'));

    if (!off) {
      row.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        if (state.sniffSel.has(item.id)) state.sniffSel.delete(item.id);
        else state.sniffSel.add(item.id);
        paintSniffSelection();
      });
    } else {
      row.title = item.note || '受保护内容不可下载';
    }
    return row;
  }

  function paintSniffSelection() {
    $$('.sn', $('sniffGroups')).forEach((row) => {
      const on = state.sniffSel.has(row.dataset.id);
      row.classList.toggle('on', on);
      const cb = row.querySelector('.cb');
      if (cb) cb.classList.toggle('on', on);
    });
    updateSniffBulk();
  }

  function updateSniffBulk() {
    const items = state.sniff.filter((i) => state.sniffSel.has(i.id));
    const n = items.length;
    const total = items.reduce((a, i) => a + (i.size || 0), 0);
    $('sniffSelCount').textContent = String(n);
    $('sniffSelSize').textContent = n ? fmtBytes(total) : '0 B';
    $('btnSniffAdd').disabled = n === 0;
    $('btnSniffRemove').disabled = n === 0;
    $('btnSniffAdd').textContent = n ? `添加到下载（${n}）` : '添加到下载';
  }

  async function refreshSniff(showToast) {
    if (isDemo) {
      if (showToast) toast('演示模式：列表已是示例数据');
      renderSniff();
      return;
    }
    try {
      state.sniff = await invoke('list_sniff');
      renderSniff();
      if (showToast) toast('已刷新候选列表');
    } catch (err) {
      const msg = (err && err.message) || String(err);
      const panel = $('sniffGroups');
      const node = el('div', 'dim err-color', '读取嗅探记录失败：' + msg);
      node.dataset.areaErr = '1';
      panel.prepend(node);
      toast('读取嗅探记录失败：' + msg, 'err');
    }
  }

  async function loadSniffStatus() {
    if (isDemo) { state.sniffNm = DEMO_NM; renderExtStatus(); return; }
    try {
      state.sniffNm = await invoke('sniff_status');
      if (state.sniffNm && state.sniffNm.tier && state.settings && !state.settings.sniffTier) {
        state.settings.sniffTier = state.sniffNm.tier;
      }
      renderExtStatus();
    } catch (err) {
      const tag = $('extStatusTag');
      if (tag) tag.textContent = '状态未知';
    }
  }

  async function addSniffTasks() {
    const items = state.sniff.filter((i) => state.sniffSel.has(i.id));
    if (!items.length) return;
    if (isDemo) {
      let id = 1;
      state.tasks.forEach((t) => { id = Math.max(id, t.id + 1); });
      items.forEach((item) => {
        state.tasks.set(id, {
          id,
          url: item.url,
          fileName: sniffName(item),
          savePath: 'C:\\Users\\Tyler\\Downloads\\' + sniffName(item),
          totalBytes: item.size || 0,
          doneBytes: 0,
          speedBps: 0,
          state: 'queued',
          error: null,
          createdAt: Date.now(),
          supportsRanges: !!item.ranges,
          connections: 4
        });
        id++;
      });
      state.sniffSel.clear();
      renderTasks();
      renderSniff();
      toast(`演示模式：已加入 ${items.length} 项到下载队列`);
      return;
    }
    const saveDir = (state.settings && state.settings.downloadDir) || null;
    let ok = 0;
    const errors = [];
    for (const item of items) {
      try {
        const task = await invoke('add_sniff_task', { id: item.id, saveDir });
        // 批量添加期间不逐条整表重排，循环结束后统一渲染一次。
        upsertTask(task, true);
        ok++;
      } catch (err) {
        errors.push(sniffName(item) + '：' + ((err && err.message) || err));
      }
    }
    if (ok) renderTasks();
    state.sniffSel.clear();
    renderSniff();
    if (ok) toast(`已加入 ${ok} 项到下载队列`);
    if (errors.length) {
      toast(`${errors.length} 项未能加入：${errors[0]}`, 'err');
      setAreaError($('sniffGroups'), '部分候选未能加入：' + errors.join('；'));
    }
  }

  async function removeSniffItems() {
    const ids = Array.from(state.sniffSel);
    if (!ids.length) return;
    if (isDemo) {
      state.sniff = state.sniff.filter((i) => !state.sniffSel.has(i.id));
      state.sniffSel.clear();
      renderSniff();
      toast('演示模式：已移出 ' + ids.length + ' 条记录');
      return;
    }
    try {
      for (const id of ids) await invoke('remove_sniff', { id });
      state.sniffSel.clear();
      await refreshSniff(false);
      toast('已移出 ' + ids.length + ' 条记录');
    } catch (err) {
      toast('移出失败：' + ((err && err.message) || err), 'err');
    }
  }

  async function clearSniffItems() {
    if (isDemo) {
      state.sniff = [];
      state.sniffSel.clear();
      renderSniff();
      toast('演示模式：已清除嗅探记录');
      return;
    }
    try {
      await invoke('clear_sniff');
      state.sniff = [];
      state.sniffSel.clear();
      renderSniff();
      toast('已清除嗅探记录');
    } catch (err) {
      toast('清除失败：' + ((err && err.message) || err), 'err');
    }
  }

  /* ---------------- 新建下载 ---------------- */
  function upsertTask(t, batch) {
    if (!t || t.id == null) return;
    const prev = state.tasks.get(t.id);
    state.tasks.set(t.id, t);
    if (batch) return;
    // 状态变化会影响筛选/排序与统计，必须整表重排；仅进度变化只重绘本行。
    const structural = !prev || prev.state !== t.state;
    if (state.view !== 'main') { renderStats(); return; }
    if (structural) renderTasks();
    else {
      paintRow(rowsById.get(String(t.id)), t);
      renderStats();
    }
  }
  function openAddPanel() {
    $('addBar').hidden = false;
    clearAreaError($('addBar'));
    setTimeout(() => $('urlInput').focus(), 0);
  }
  function addError(msg) {
    setAreaError($('addBar'), msg);
    toast(msg, 'err');
  }
  async function pasteLink() {
    openAddPanel();
    const input = $('urlInput');
    if (isDemo) {
      if (!input.value) input.value = 'https://example.com/sample-archive.zip';
      toast('演示模式：已填入示例链接');
      return;
    }
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) { toast('剪贴板为空，请手动粘贴链接', 'err'); return; }
      input.value = text;
      toast('已从剪贴板粘贴');
    } catch (err) {
      toast('无法读取剪贴板，请手动粘贴链接', 'err');
    }
  }
  async function addDownload() {
    const url = $('urlInput').value.trim();
    if (!/^https?:\/\/[^\s]+/i.test(url)) { addError('请输入完整的 http(s) 下载链接'); return; }
    const maxConn = (state.settings && state.settings.maxConnections) || 16;
    const conn = Math.max(1, Math.min(maxConn, Number($('connInput').value) || 8));
    const saveDir = $('dirInput').value.trim() || (state.settings && state.settings.downloadDir) || null;
    if (isDemo) {
      let id = 1;
      state.tasks.forEach((t) => { id = Math.max(id, t.id + 1); });
      const name = nameFromUrl(url);
      state.tasks.set(id, {
        id, url, fileName: name,
        savePath: (saveDir || 'C:\\Users\\Tyler\\Downloads') + '\\' + name,
        totalBytes: (180 + id * 37) * MB, doneBytes: 0, speedBps: 0,
        state: 'queued', error: null, createdAt: Date.now(), supportsRanges: true, connections: conn
      });
      clearAreaError($('addBar'));
      $('urlInput').value = '';
      renderTasks();
      toast('演示模式：已加入下载队列：' + name);
      return;
    }
    try {
      const task = await invoke('add_task', { url, saveDir, fileName: null, connections: conn, autoStart: true });
      upsertTask(task);
      clearAreaError($('addBar'));
      $('urlInput').value = '';
      toast('已加入下载：' + (task && task.fileName ? task.fileName : nameFromUrl(url)));
    } catch (err) {
      addError('加入下载失败：' + ((err && err.message) || err));
    }
  }
  /* ---------------- 事件绑定 ---------------- */
  /* 自绘标题栏（decorations:false）没有系统拖拽区：
   * 给标题栏内除按钮外的所有元素补 data-tauri-drag-region，
   * 由 Tauri 注入脚本处理按下拖动与双击最大化。 */
  function setupTitlebarDrag() {
    const bar = document.querySelector('.titlebar');
    if (!bar) return;
    const mark = (node) => {
      if (!node || node.nodeType !== 1) return;
      if (node.closest('button')) return;
      node.setAttribute('data-tauri-drag-region', '');
      Array.from(node.children).forEach(mark);
    };
    mark(bar);
  }

  function bindUI() {
    setupTitlebarDrag();
    const on = (id, ev, fn) => { const node = $(id); if (node) node.addEventListener(ev, fn); };

    /* 窗口按钮 */
    on('btnMin', 'click', () => winCtl('min'));
    on('btnMax', 'click', () => winCtl('max'));
    on('btnClose', 'click', () => winCtl('close'));

    /* 侧栏导航 */
    $$('.sb[data-nav]').forEach((node) => {
      node.addEventListener('click', () => {
        const nav = node.dataset.nav;
        if (nav === 'main') {
          if (node.dataset.kind) { state.kind = node.dataset.kind; state.filter = 'all'; }
          else { state.kind = null; state.filter = node.dataset.filter || 'all'; }
          setView('main');
          renderTasks();
        } else {
          state.kind = null;
          state.filter = 'all';
          setView(nav);
          if (nav === 'sniff') { renderSniff(); loadSniffStatus(); }
          if (nav === 'video') {
            if (isDemo && !state.video.info) {
              state.video.info = demoVideo();
              state.video.url = state.video.info.webpageUrl;
              renderVideo();
            } else renderVideo();
          }
          if (nav === 'settings') renderSettings();
        }
      });
    });

    /* 过滤 chip */
    $$('.chip[data-fchip]').forEach((node) => {
      node.addEventListener('click', () => {
        state.filter = node.dataset.fchip;
        state.kind = null;
        setView('main');
        renderTasks();
      });
    });

    /* 搜索 */
    on('searchInput', 'input', (e) => {
      state.search = e.target.value.trim();
      renderTasks();
    });

    /* 排序 */
    on('sortKey', 'change', (e) => {
      state.sortKey = e.target.value;
      if (state.sortKey === 'eta') state.sortDir = 'asc';
      renderTasks();
    });
    on('sortDir', 'click', () => {
      state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      renderTasks();
    });
    $$('.list-head .hbtn').forEach((node) => {
      node.addEventListener('click', () => {
        const key = node.dataset.sort;
        if (state.sortKey === key) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
        else { state.sortKey = key; state.sortDir = key === 'eta' ? 'asc' : 'desc'; }
        renderTasks();
      });
    });

    /* 新建下载 */
    on('btnNew', 'click', () => {
      if ($('addBar').hidden) openAddPanel();
      else { $('addBar').hidden = true; clearAreaError($('addBar')); }
    });
    on('btnPaste', 'click', pasteLink);
    on('btnAddClose', 'click', () => {
      $('addBar').hidden = true;
      clearAreaError($('addBar'));
    });
    on('btnAdd', 'click', addDownload);
    on('urlInput', 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addDownload(); } });
    on('connInput', 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addDownload(); } });

    /* 批量按钮 */
    on('selAll', 'click', () => {
      const rows = $$('.task', $('taskList'));
      const allOn = rows.length > 0 && rows.every((r) => state.selected.has(Number(r.dataset.id)));
      if (allOn) state.selected.clear();
      else rows.forEach((r) => state.selected.add(Number(r.dataset.id)));
      paintSelection();
    });
    on('selDoneBtn', 'click', () => {
      $$('.task', $('taskList')).forEach((r) => {
        const t = state.tasks.get(Number(r.dataset.id));
        if (t && t.state === 'completed') state.selected.add(t.id);
        else if (t) state.selected.delete(t.id);
      });
      paintSelection();
    });
    on('btnStartAll', 'click', async () => {
      const targets = Array.from(state.tasks.values()).filter((t) => t.state !== 'completed' && t.state !== 'active');
      if (!targets.length) { toast('没有需要开始的任务'); return; }
      for (const t of targets) await taskAction(t, 'resume');
      toast(`已提交 ${targets.length} 个任务`);
    });
    on('btnPauseAll', 'click', async () => {
      const targets = Array.from(state.tasks.values()).filter((t) => t.state === 'active');
      if (!targets.length) { toast('没有正在下载的任务'); return; }
      for (const t of targets) await taskAction(t, 'pause');
      toast(`已暂停 ${targets.length} 个任务`);
    });
    on('bulkOpen', 'click', async () => {
      for (const t of selectedTasks()) if (t.state === 'completed') await taskAction(t, 'open');
    });
    on('bulkFolder', 'click', async () => {
      for (const t of selectedTasks()) if (t.state === 'completed') await taskAction(t, 'folder');
    });
    on('bulkPause', 'click', async () => {
      const targets = selectedTasks().filter((t) => t.state === 'active');
      if (!targets.length) { toast('所选任务中没有正在下载的任务'); return; }
      for (const t of targets) await taskAction(t, 'pause');
    });
    on('bulkCancel', 'click', async () => {
      const targets = selectedTasks().slice();
      for (const t of targets) await taskAction(t, 'remove');
    });
    on('bulkClear', 'click', () => {
      state.selected.clear();
      paintSelection();
    });

    /* 详情弹窗 */
    on('modalClose', 'click', closeDetail);
    on('detailModal', 'click', (e) => { if (e.target === $('detailModal')) closeDetail(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('detailModal').hidden) closeDetail();
    });

    /* 外观 */
    on('btnThemeQuick', 'click', () => {
      if (!state.settings) return;
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      state.settings.theme = next;
      paintTheme(next);
      scheduleSave(200);
    });
    $$('[data-theme-set]').forEach((node) => node.addEventListener('click', () => {
      if (!state.settings) return;
      state.settings.theme = node.dataset.themeSet;
      paintTheme(state.settings.theme);
      scheduleSave(200);
    }));
    $$('.sw-dot').forEach((node) => node.addEventListener('click', () => {
      if (!state.settings) return;
      state.settings.accent = node.dataset.accent;
      applyAccent(node.dataset.accent);
      scheduleSave(200);
    }));
    $$('[data-density-set]').forEach((node) => node.addEventListener('click', () => {
      if (!state.settings) return;
      state.settings.density = node.dataset.densitySet;
      document.documentElement.dataset.density = node.dataset.densitySet;
      $$('[data-density-set]').forEach((b) => b.classList.toggle('on', b === node));
      scheduleSave(200);
    }));
    bindSwitch('swReduce', 'reduceMotion', (v) => document.documentElement.classList.toggle('reduce-motion', v));
    bindSwitch('swCloseTray', 'closeToTray');

    // 自启动与提权需要落系统状态，不能用纯前端开关直接写设置。
    const swAutostart = $('swAutostart');
    if (swAutostart) {
      swAutostart.addEventListener('click', async () => {
        if (!state.settings) return;
        const next = !state.settings.autostart;
        swAutostart.disabled = true;
        try {
          if (IS_TAURI) await invoke('set_autostart', { enabled: next });
          state.settings.autostart = next;
          paintSwitch('swAutostart', next);
          toast(next ? '已注册开机自启动' : '已取消开机自启动');
        } catch (e) {
          toast('自启动设置失败：' + (e && e.message ? e.message : e), 'err');
        } finally {
          swAutostart.disabled = false;
        }
      });
    }
    const extManage = $('btnExtManage');
    if (extManage) {
      extManage.addEventListener('click', async () => {
        const guide = $('extGuide');
        if (!guide) return;
        const opening = guide.hidden;
        guide.hidden = !opening;
        if (opening) await loadExtensionInfo();
      });
    }
    const extOpen = $('btnExtOpen');
    if (extOpen) {
      extOpen.addEventListener('click', async () => {
        try {
          await invoke('open_extension_dir');
        } catch (e) {
          toast('打开扩展目录失败：' + (e && e.message ? e.message : e), 'err');
        }
      });
    }
    const extCopy = $('btnExtCopy');
    if (extCopy) {
      extCopy.addEventListener('click', async () => {
        const steps = [
          'Fetchweir 浏览器扩展安装步骤',
          '1. 在应用设置 →「嗅探与浏览器」点「打开扩展文件夹」，找到其中的 extension 目录。',
          '2. Chrome 打开 chrome://extensions（Edge 为 edge://extensions），右上角开启「开发者模式」。',
          '3. 点「加载已解压的扩展程序」，选择该 extension 文件夹。',
          '4. 打开任意网页，右下角出现 Fetchweir 浮动条即安装成功；点击浮动条可唤起应用。'
        ].join('\n');
        try {
          await navigator.clipboard.writeText(steps);
          toast('安装步骤已复制');
        } catch (e) {
          toast('复制失败，请手动按界面步骤操作', 'err');
        }
      });
    }
    const adminRestart = $('adminRestart');
    if (adminRestart) {
      adminRestart.addEventListener('click', async () => {
        adminRestart.disabled = true;
        try {
          const ok = await invoke('restart_elevated');
          if (!ok) {
            toast('未获得管理员权限，已保持普通权限运行', 'err');
            adminRestart.disabled = false;
          }
        } catch (e) {
          toast('提权重启失败：' + (e && e.message ? e.message : e), 'err');
          adminRestart.disabled = false;
        }
      });
    }
    const swAdmin = $('swRunAsAdmin');
    if (swAdmin) {
      swAdmin.addEventListener('click', async () => {
        if (!state.settings) return;
        const next = !state.settings.runAsAdmin;
        swAdmin.disabled = true;
        try {
          let relaunching = false;
          if (IS_TAURI) relaunching = await invoke('set_run_as_admin', { enabled: next });
          state.settings.runAsAdmin = next;
          paintSwitch('swRunAsAdmin', next);
          if (next && relaunching) toast('已请求管理员权限；在 UAC 中确认后应用会以提权重启');
          else toast(next ? '已开启：可点「以管理员身份重启」提权，正常启动不再弹权限框' : '已关闭：恢复普通权限启动');
        } catch (e) {
          toast('切换失败：' + (e && e.message ? e.message : e), 'err');
        } finally {
          swAdmin.disabled = false;
          renderInstallInfo();
        }
      });
    }

    /* 下载引擎设置 */
    on('setDir', 'input', () => { if (state.settings) { state.settings.downloadDir = $('setDir').value.trim(); scheduleSave(800); } });
    on('segRange', 'input', () => {
      if (!state.settings) return;
      const max = state.settings.maxConnections || 16;
      const v = Math.max(1, Math.min(max, Number($('segRange').value) || 8));
      state.settings.connections = v;
      $('segOut').textContent = String(v);
      scheduleSave(300);
    });
    on('connRange', 'input', () => {
      if (!state.settings) return;
      const v = Math.max(1, Number($('connRange').value) || 16);
      state.settings.maxConnections = v;
      if (state.settings.connections > v) { state.settings.connections = v; $('segRange').value = String(v); $('segOut').textContent = String(v); }
      $('connOut').textContent = String(v);
      scheduleSave(300);
    });
    on('limitRange', 'input', () => { updateLimitLabel(); scheduleSave(300); });
    on('timeoutSel', 'change', () => {
      if (!state.settings) return;
      const [c, r] = $('timeoutSel').value.split(',').map(Number);
      state.settings.connectTimeoutSec = c || 10;
      state.settings.readTimeoutSec = r || 30;
      scheduleSave(200);
    });
    on('btnOpenDir', 'click', async () => {
      const dir = (state.settings && state.settings.downloadDir) || '';
      if (!dir) { toast('尚未设置下载目录', 'err'); return; }
      if (isDemo) { toast('演示模式：将打开目录 ' + dir); return; }
      try { await invoke('reveal_path', { path: dir }); } catch (err) { toast('打开目录失败：' + ((err && err.message) || err), 'err'); }
    });

    /* 嗅探设置 */
    on('ttlSel', 'change', () => {
      if (!state.settings) return;
      state.settings.sniffTtlHours = Number($('ttlSel').value) || 0;
      renderSniffStoreInfo();
      scheduleSave(200);
    });
    on('tierSel', 'change', () => setTier($('tierSel').value));

    /* 视频设置 */
    on('videoPrefSel', 'change', () => {
      if (!state.settings) return;
      state.settings.videoPreferred = $('videoPrefSel').value;
      scheduleSave(200);
      if (state.video.info) {
        state.video.sel = null;
        renderVideo();
      }
    });

    /* 更新设置 */
    on('setUpdateRepo', 'input', () => { if (state.settings) { state.settings.updateRepo = $('setUpdateRepo').value.trim(); scheduleSave(800); } });
    on('setUpdateToken', 'input', () => { if (state.settings) { state.settings.updateToken = $('setUpdateToken').value.trim(); scheduleSave(800); } });
    on('setHomepage', 'input', () => { if (state.settings) { state.settings.homepage = $('setHomepage').value.trim(); scheduleSave(800); } });
    on('btnCheckUpdate', 'click', async () => {
      if (isDemo) { demoCheckUpdate(); return; }
      try {
        const u = await invoke('check_update');
        renderUpdate(u);
        if (u && u.stage === 'upToDate') toast('已是最新版本');
        else if (u && u.stage === 'failed') toast('检查更新失败：' + (u.message || ''), 'err');
      } catch (err) { toast('检查更新失败：' + ((err && err.message) || err), 'err'); }
    });
    on('btnUpdateNow', 'click', () => startUpdate('install'));
    on('btnDownloadOnly', 'click', () => startUpdate('only'));
    on('btnCancelUpdate', 'click', async () => {
      if (isDemo) {
        clearInterval(state.timers.updateDownload);
        renderUpdate(Object.assign({}, state.update, { stage: 'updateAvailable', progress: 0, downloaded: 0, canInstall: false, message: '演示模式：已取消下载' }));
        toast('演示模式：已取消更新下载');
        return;
      }
      try { await invoke('cancel_update'); toast('已取消更新下载'); }
      catch (err) { toast('取消失败：' + ((err && err.message) || err), 'err'); }
    });
    on('btnInstallUpdate', 'click', async () => {
      if (isDemo) { toast('演示模式：安装需在桌面端执行'); return; }
      try { await invoke('install_update'); }
      catch (err) { toast('安装失败：' + ((err && err.message) || err), 'err'); }
    });
    on('btnOpenDownloadDir', 'click', async () => {
      const u = state.update || {};
      const path = u.path || u.downloadDir;
      if (!path) { toast('更新包路径未知', 'err'); return; }
      if (isDemo) { toast('演示模式：将定位到 ' + path); return; }
      try { await invoke('reveal_path', { path }); } catch (err) { toast('打开失败：' + ((err && err.message) || err), 'err'); }
    });
    on('btnOpenHome', 'click', async () => {
      if (isDemo) { toast('演示模式：将打开项目主页'); return; }
      try { await invoke('open_homepage'); } catch (err) { toast('打开主页失败：' + ((err && err.message) || err), 'err'); }
    });
    on('updateMirror', 'change', async () => {
      const mirror = $('updateMirror').value;
      if (state.update) state.update.mirror = mirror;
      if (state.settings) state.settings.updateMirror = mirror;
      if (isDemo) { toast('演示模式：已切换镜像来源'); return; }
      try { await invoke('set_update_mirror', { mirror }); toast('已切换更新镜像'); }
      catch (err) { toast('切换镜像失败：' + ((err && err.message) || err), 'err'); }
    });

    /* 关于 / 数据 */
    on('btnClearSniff', 'click', clearSniffItems);
    on('btnExportSettings', 'click', async () => {
      if (isDemo) { toast('演示模式：不会写出真实配置文件'); return; }
      try {
        const path = await invoke('export_settings');
        const name = String(path || '').split(/[\\/]/).pop() || '配置文件';
        toast('已导出 ' + name + '（不含更新令牌）');
      } catch (err) { toast('导出配置失败：' + ((err && err.message) || err), 'err'); }
    });
    on('btnOpenData', 'click', async () => {
      if (isDemo) { toast('演示模式：数据目录 ' + ((state.info && state.info.dataDir) || 'C:\\Users\\Tyler\\AppData\\Roaming\\Fetchweir')); return; }
      try { await invoke('open_data_dir'); } catch (err) { toast('打开数据目录失败：' + ((err && err.message) || err), 'err'); }
    });
    on('btnResetSettings', 'click', async () => {
      if (isDemo) {
        state.settings = normalizeSettings(Object.assign({}, DEMO_SETTINGS));
        applyVisuals(state.settings);
        renderSettings();
        markSaved('演示模式 · 已恢复默认');
        toast('演示模式：设置已恢复默认');
        return;
      }
      try {
        const s = await invoke('reset_settings');
        state.settings = normalizeSettings(s);
        applyVisuals(state.settings);
        renderSettings();
        toast('已恢复默认设置');
      } catch (err) { toast('重置失败：' + ((err && err.message) || err), 'err'); }
    });

    /* 视频页 */
    on('btnProbe', 'click', probeVideo);
    on('videoUrl', 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); probeVideo(); } });
    on('btnCopyLink', 'click', copySelectedLink);
    on('btnAudioOnly', 'click', () => {
      state.video.tab = state.video.tab === 'audio' ? 'video' : 'audio';
      $$('#fmtTabs button').forEach((b) => { if (b.dataset.tab) b.classList.toggle('on', b.dataset.tab === state.video.tab); });
      renderFormats();
      toast(state.video.tab === 'audio' ? '已切换到音频轨' : '已切回视频轨');
    });
    on('btnVideoRedo', 'click', () => {
      if (!state.video.info) { toast('还没有可重新解析的结果', 'err'); return; }
      probeVideo();
    });
    on('btnVideoDownload', 'click', addVideoTask);
    $$('#fmtTabs button').forEach((node) => node.addEventListener('click', () => {
      if (!node.dataset.tab) return;
      state.video.tab = node.dataset.tab;
      $$('#fmtTabs button').forEach((b) => { if (b.dataset.tab) b.classList.toggle('on', b.dataset.tab === state.video.tab); });
      renderFormats();
    }));

    /* 嗅探页 */
    $$('.chip[data-schip]').forEach((node) => node.addEventListener('click', () => {
      state.sniffChip = node.dataset.schip;
      renderSniff();
    }));
    on('sniffKw', 'input', () => renderSniff());
    on('sniffMinSize', 'change', () => renderSniff());
    on('sniffExt', 'change', () => renderSniff());
    on('sniffDomain', 'change', () => renderSniff());
    on('sniffHideDup', 'click', () => {
      state.sniffHideDup = !state.sniffHideDup;
      $('sniffHideDup').classList.toggle('on', state.sniffHideDup);
      $('sniffHideDup').setAttribute('aria-pressed', String(state.sniffHideDup));
      renderSniff();
    });
    on('sniffTier', 'change', () => setTier($('sniffTier').value));
    on('btnSniffRefresh', 'click', async () => {
      await refreshSniff(true);
      if (!isDemo) await loadSniffStatus();
    });
    on('btnSniffClear', 'click', clearSniffItems);
    on('btnSniffSelClear', 'click', () => { state.sniffSel.clear(); paintSniffSelection(); });
    on('btnSniffRemove', 'click', removeSniffItems);
    on('btnSniffAdd', 'click', addSniffTasks);
  }

  async function startUpdate(mode) {
    if (isDemo) { demoUpdateDownload(mode); return; }
    try {
      const u = await invoke('download_update', { mode });
      if (u) renderUpdate(u);
      toast(mode === 'only' ? '开始下载更新包（下载后不自动安装）' : '开始下载并安装更新');
    } catch (err) {
      toast('下载更新失败：' + ((err && err.message) || err), 'err');
      const msg = $('updateMsg');
      msg.hidden = false;
      msg.textContent = '下载更新失败：' + ((err && err.message) || err);
      msg.classList.add('err');
    }
  }

  async function winCtl(kind) {
    if (isDemo) {
      toast(`演示模式：窗口${kind === 'close' ? '关闭' : kind === 'min' ? '最小化' : '最大化'}由桌面端接管`);
      return;
    }
    try {
      const win = window.__TAURI__.window.getCurrentWindow();
      if (kind === 'min') await win.minimize();
      else if (kind === 'max') await win.toggleMaximize();
      else await win.close();
    } catch (err) {
      toast('窗口操作失败：' + ((err && err.message) || err), 'err');
    }
  }

  /* ---------------- 事件订阅与轮询 ---------------- */
  async function listenEvents() {
    if (!IS_TAURI) return;
    const ev = window.__TAURI__.event;
    await ev.listen('fw://task', (e) => {
      const t = e.payload;
      if (t && t.id != null) upsertTask(t);
    });
    await ev.listen('fw://progress', (e) => {
      const items = (e.payload && e.payload.items) || [];
      let structural = false;
      items.forEach((p) => {
        const t = state.tasks.get(p.id);
        if (!t) return;
        if (p.state && p.state !== t.state) structural = true;
        t.doneBytes = p.doneBytes != null ? p.doneBytes : t.doneBytes;
        if (p.totalBytes) t.totalBytes = p.totalBytes;
        t.speedBps = p.speedBps || 0;
        if (p.state) t.state = p.state;
      });
      if (structural) renderTasks();
      else scheduleProgressPaint(items);
    });
    await ev.listen('fw://removed', (e) => {
      const p = e.payload || {};
      const ids = p.ids || (p.id != null ? [p.id] : []);
      ids.forEach((id) => {
        state.tasks.delete(id);
        state.selected.delete(id);
        if (state.detailId === id) closeDetail();
      });
      renderTasks();
    });
    await ev.listen('fw://sniff', (e) => {
      const p = e.payload || {};
      if (p.item) {
        const idx = state.sniff.findIndex((i) => i.id === p.item.id);
        if (idx >= 0) state.sniff[idx] = p.item;
        else state.sniff.push(p.item);
        renderSniff();
      }
    });
    await ev.listen('fw://update', (e) => { if (e.payload) renderUpdate(e.payload); });
    await ev.listen('fw://video', (e) => onVideoEvent(e.payload));
  }

  /* 轮询按“当前视图 + 是否真的需要”启停：
   * - 嗅探列表由 fw://sniff 事件驱动，不再每 2 秒整表重建；
   * - 引擎内存只在主界面采样；
   * - 更新状态只在检查/下载/安装进行中才轮询。 */
  let lastSniffStatusAt = 0;
  let lastMemSampleAt = 0;
  let lastUpdatePollAt = 0;
  let updatePolling = false;
  let memPolling = false;
  function updateBusy() {
    const stage = state.update && state.update.stage;
    return stage === 'checking' || stage === 'downloading' || stage === 'installing';
  }
  function startPolling() {
    setInterval(() => {
      if (document.hidden) return;
      const now = Date.now();
      if (state.view === 'sniff' && now - lastSniffStatusAt >= 5000) {
        lastSniffStatusAt = now;
        loadSniffStatus();
        renderSniffStoreInfo();
      }
      if (state.view === 'main' && !memPolling && now - lastMemSampleAt >= 5000) {
        lastMemSampleAt = now;
        memPolling = true;
        invoke('engine_memory')
          .then((bytes) => {
            state.memBytes = Number(bytes) || null;
            renderStats();
          })
          .catch(() => {})
          .finally(() => { memPolling = false; });
      }
      if (updateBusy() && !updatePolling && now - lastUpdatePollAt >= 1000) {
        lastUpdatePollAt = now;
        updatePolling = true;
        invoke('update_status')
          .then((u) => { if (u) renderUpdate(u); })
          .catch(() => {})
          .finally(() => { updatePolling = false; });
      }
    }, 250);
  }

  /* ---------------- 版本信息 ---------------- */
  function applyInfo(info) {
    if (!info) return;
    state.info = info;
    if (info.version) {
      $('setVersion').textContent = 'v' + info.version;
      $('statusVersion').textContent = 'v' + info.version;
    }
    const engine = $('engineText');
    if (engine) engine.textContent = isDemo ? '引擎就绪 · 演示模式' : '引擎就绪 · v' + (info.version || '?');
  }

  /* ---------------- demo 演示节奏 ---------------- */
  function startDemoTicker() {
    setInterval(() => {
      let structural = false;
      state.tasks.forEach((t) => {
        if (t.state !== 'active') return;
        t.doneBytes = Math.min(t.totalBytes, t.doneBytes + t.speedBps * 0.9);
        t.speedBps = Math.max(1.4 * MB, t.speedBps * (0.94 + Math.random() * 0.12));
        if (t.doneBytes >= t.totalBytes) { t.doneBytes = t.totalBytes; t.state = 'completed'; t.speedBps = 0; structural = true; }
      });
      if (structural) renderTasks();
      else {
        rowsById.forEach((row, id) => paintRow(row, state.tasks.get(Number(id))));
        renderStats();
        if (state.detailId != null) paintDetail();
      }
    }, 1000);
  }

  /* ---------------- 启动 ---------------- */
  async function boot() {
    bindUI();
    const view = ['main', 'video', 'sniff', 'settings'].includes(PARAMS.get('view')) ? PARAMS.get('view') : 'main';
    if (PARAMS.has('minw')) document.body.classList.add('minw-demo');
    if (PARAMS.has('dock')) setupDock();

    if (isDemo) {
      state.settings = normalizeSettings(Object.assign({}, DEMO_SETTINGS));
      // 截图用：?admin 让演示数据呈现「已开启管理员运行」的状态（含 UIPI 提示），
      // 只影响演示数据，不会调用后端，也不改变真实设置。
      if (PARAMS.has('admin')) state.settings.runAsAdmin = true;
      state.tasks = new Map(demoTasks().map((t) => [t.id, t]));
      state.sniff = demoSniff();
      state.sniffNm = DEMO_NM;
      state.update = Object.assign({}, DEMO_UPDATE);
      state.info = { version: '1.0.0', dataDir: 'C:\\Users\\Tyler\\AppData\\Roaming\\Fetchweir' };
      applyInfo(state.info);
      applyVisuals(state.settings);
      renderSettings();
      renderUpdate(state.update);
      renderTasks();
      renderSniff();
      if (view === 'video') {
        state.video.info = demoVideo();
        state.video.url = state.video.info.webpageUrl;
        renderVideo();
      } else {
        renderVideo();
      }
      setView(view);
      if (PARAMS.has('modal')) {
        const t = Array.from(state.tasks.values()).find((x) => x.state === 'active') || Array.from(state.tasks.values())[0];
        if (t) { setView('main'); openDetail(t.id); }
      }
      startDemoTicker();
      return;
    }

    performance.mark('fw:boot');
    try {
      const info = await invoke('app_info');
      applyInfo(info);
    } catch (err) { toast('读取应用信息失败：' + ((err && err.message) || err), 'err'); }
    try {
      const s = await invoke('get_settings');
      state.settings = normalizeSettings(s);
      applyVisuals(state.settings);
      renderSettings();
    } catch (err) { toast('读取设置失败：' + ((err && err.message) || err), 'err'); }
    try {
      const tasks = await invoke('list_tasks');
      state.tasks = new Map((tasks || []).map((t) => [t.id, t]));
      renderTasks();
    } catch (err) {
      toast('读取任务列表失败：' + ((err && err.message) || err), 'err');
      $('emptyState').hidden = false;
      $('emptyHint').textContent = '读取任务列表失败：' + ((err && err.message) || err);
    }
    try {
      const u = await invoke('update_status');
      if (u) renderUpdate(u);
    } catch (err) { /* 更新状态不可用时保持默认文案 */ }
    try {
      state.sniff = await invoke('list_sniff');
      renderSniff();
    } catch (err) { toast('读取嗅探记录失败：' + ((err && err.message) || err), 'err'); }
    loadSniffStatus();
    loadExtensionInfo().catch(() => {});
    setView(view);
    performance.mark('fw:data');
    listenEvents().catch((err) => toast('订阅事件失败：' + ((err && err.message) || err), 'err'));
    startPolling();
    performance.mark('fw:ready');
    invoke('ui_ready').catch(() => {});
    if (PARAMS.has('modal')) {
      const t = Array.from(state.tasks.values()).find((x) => x.state === 'active') || Array.from(state.tasks.values())[0];
      if (t) { setView('main'); openDetail(t.id); }
    }
  }

  function setupDock() {
    document.body.classList.add('vp-demo');
    $$('#vpDock [data-vp]').forEach((node) => node.addEventListener('click', () => {
      const v = node.dataset.vp;
      const frame = $('vpFrame');
      if (!frame) return;
      frame.style.width = v === 'auto' ? '100%' : v + 'px';
      frame.style.maxWidth = 'none';
      $$('#vpDock [data-vp]').forEach((b) => b.classList.toggle('on', b === node));
      const now = $('vpNow');
      if (now) now.textContent = v === 'auto' ? '自动' : v + 'px';
    }));
  }

  boot().catch((err) => {
    toast('界面初始化失败：' + ((err && err.message) || err), 'err');
  });
})();
