/* Fetchweir 内容脚本：浮动下载条（closed Shadow DOM）+ 页面媒体元素补充信号
   三档：A 自动出条（任意帧上报、顶层渲染）/ B 仅顶层按网络信号出条 / C 不出条只用徽标 */
(() => {
  'use strict';
  if (window.top !== window) {
    // 子帧：只上报 DOM 里直接可见的媒体元素；是否采信由后台按档位决定。
    reportDomMedia();
    return;
  }
  if (window.__fetchweirBar) return;
  window.__fetchweirBar = true;

  const HOST_ID = 'fetchweir-bar-host';
  let tier = 'B';
  let items = [];
  let dismissed = false;
  let host = null;
  let shadow = null;
  let panel = null;
  let observer = null;
  let timer = null;
  let barTheme = null;
  let themeSettled = false;

  /* 颜色只来自应用下发的 token；扩展不维护调色板。
     每个变量都带中性回退（深灰底 + 明确前景），应用没跑或通道失败时也不会浅底浅字。 */
  const THEME_VARS = {
    bg: '--fw-bg', bg2: '--fw-bg2', bg3: '--fw-bg3',
    line: '--fw-line', fg: '--fw-fg', fg2: '--fw-fg2', fg3: '--fw-fg3',
    accent: '--fw-accent', accentSolid: '--fw-accent-solid',
    accentSolid2: '--fw-accent-solid2', accentFg: '--fw-accent-fg',
  };

  const CSS = `
:host { all: initial; }
.panel {
  position: fixed; right: 18px; bottom: 18px; width: 320px; max-width: calc(100vw - 24px);
  background: var(--fw-bg, #1E1E23); color: var(--fw-fg, #F2F2F4);
  border: 1px solid var(--fw-line, #3A3A43);
  border-radius: 14px; box-shadow: 0 18px 48px -12px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.03) inset;
  font: 500 13px/1.45 system-ui, -apple-system, "Segoe UI", "Noto Sans SC", sans-serif;
  overflow: hidden; pointer-events: auto; animation: in .22s cubic-bezier(.2,.9,.3,1);
}
@keyframes in { from { opacity: 0; transform: translateY(10px) scale(.98); } }
.head { display: flex; align-items: center; gap: 9px; padding: 11px 12px 9px; }
.mark { width: 22px; height: 22px; border-radius: 7px; flex: none; display: grid; place-items: center;
  background: linear-gradient(150deg, var(--fw-accent-solid, #4B5563), var(--fw-accent-solid2, #374151)); }
.mark svg { width: 13px; height: 13px; stroke: var(--fw-accent-fg, #FFFFFF); }
.title { flex: 1; min-width: 0; }
.title b { display: block; font-size: 12.5px; font-weight: 650; letter-spacing: .2px; }
.title span { display: block; font-size: 11px; color: var(--fw-fg-2, #C2C2CA); margin-top: 1px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.close { width: 22px; height: 22px; border: 0; border-radius: 6px; background: transparent;
  color: var(--fw-fg-2, #C2C2CA); cursor: pointer; display: grid; place-items: center; }
.close:hover { background: var(--fw-bg3, #2E2E36); color: var(--fw-fg, #F2F2F4); }
.list { padding: 0 8px 8px; max-height: 210px; overflow: auto; display: grid; gap: 6px; }
.row { display: flex; align-items: center; gap: 8px; padding: 8px; border-radius: 9px;
  background: var(--fw-bg2, #26262C); border: 1px solid var(--fw-line, #3A3A43); }
.row .ico { width: 26px; height: 26px; border-radius: 7px; flex: none; display: grid; place-items: center;
  font-size: 9px; font-weight: 700; letter-spacing: .3px;
  background: var(--fw-accent-solid, #4B5563); color: var(--fw-accent-fg, #FFFFFF); }
.row .meta { flex: 1; min-width: 0; }
.row .name { font-size: 12px; font-weight: 550; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row .sub { font-size: 10.5px; color: var(--fw-fg-2, #C2C2CA); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row .get { border: 0; border-radius: 6px; padding: 5px 9px; font-size: 11px; font-weight: 600;
  background: var(--fw-accent-solid, #4B5563); color: var(--fw-accent-fg, #FFFFFF); cursor: pointer; }
.row .get:hover:not(:disabled) { background: var(--fw-accent-solid2, #374151); }
.row .get:disabled { background: var(--fw-bg3, #2E2E36); color: var(--fw-fg-2, #C2C2CA); cursor: not-allowed; }
.foot { display: flex; align-items: center; gap: 8px; padding: 9px 12px 11px; border-top: 1px solid var(--fw-line, #3A3A43); }
.foot .hint { flex: 1; font-size: 10.5px; color: var(--fw-fg-2, #C2C2CA); }
.foot button { border: 1px solid var(--fw-line, #3A3A43); background: transparent; color: var(--fw-fg, #F2F2F4);
  border-radius: 6px; padding: 5px 9px; font-size: 11px; cursor: pointer; }
.foot button:hover { background: var(--fw-bg3, #2E2E36); }
button:focus-visible { outline: 2px solid var(--fw-accent, #A9B4C4); outline-offset: 2px; }
`;

  function svgIcon() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', '#fff');
    svg.setAttribute('stroke-width', '2.2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', 'M12 4v9M8.5 9.5 12 13l3.5-3.5M5 18h14');
    svg.appendChild(p);
    return svg;
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function hostOf(u) { try { return new URL(u).hostname; } catch { return ''; } }
  function pathName(u) {
    try {
      const p = new URL(u).pathname.split('/').filter(Boolean).pop() || '';
      return decodeURIComponent(p) || hostOf(u);
    } catch { return u.slice(0, 40); }
  }
  function fmtBytes(n) {
    if (!n || n <= 0) return '大小未知';
    const u = ['B', 'KB', 'MB', 'GB'];
    let v = n, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
    return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
  }
  const KIND_TEXT = { video: '视频', audio: '音频', hls: 'HLS 清单', dash: 'DASH 清单' };

  /* 应用下发的 token 直接写成宿主元素的行内自定义属性，透过 Shadow DOM 继承。
     不写死任何一套配色；收到新主题时只改属性，不重建面板，也不做颜色过渡。 */
  function applyBarTheme(t) {
    if (!t || typeof t !== 'object' || !t.palette || typeof t.palette !== 'object') return false;
    barTheme = { theme: t.theme === 'light' ? 'light' : 'dark', color: t.color || '', palette: { ...t.palette } };
    if (!host) return true;
    for (const [key, cssVar] of Object.entries(THEME_VARS)) {
      const v = t.palette[key];
      if (typeof v === 'string' && v) host.style.setProperty(cssVar, v);
      else host.style.removeProperty(cssVar);
    }
    host.dataset.fwTheme = barTheme.theme;
    return true;
  }

  function build() {
    if (host) return;
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;display:block;';
    shadow = host.attachShadow({ mode: 'closed' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      shadow.adoptedStyleSheets = [sheet];
    } catch {
      const st = document.createElement('style');
      st.textContent = CSS;
      shadow.appendChild(st);
    }
    panel = el('div', 'panel');
    shadow.appendChild(panel);
    document.documentElement.appendChild(host);
    if (barTheme) applyBarTheme(barTheme);
    watch();
  }

  function render() {
    if (!panel) return;
    // 首帧等主题先就绪：拿到就按应用配色画，拿不到（700ms）才用中性回退，避免先闪一套再换。
    if (!themeSettled) {
      host.style.display = 'none';
      themeReady.then(render);
      return;
    }
    while (panel.firstChild) panel.removeChild(panel.firstChild);
    const media = items.filter((x) => ['video', 'audio', 'hls', 'dash'].includes(x.kind));
    const show = tier !== 'C' && !dismissed && media.length > 0;
    host.style.display = show ? 'block' : 'none';
    if (!show) return;

    const head = el('div', 'head');
    const mk = el('div', 'mark');
    mk.appendChild(svgIcon());
    const t = el('div', 'title');
    t.appendChild(el('b', null, `Fetchweir · ${media.length} 个可下载资源`));
    t.appendChild(el('span', null, location.hostname || '本页'));
    const close = el('button', 'close', '×');
    close.title = '本页不再显示';
    close.addEventListener('click', () => { dismissed = true; render(); });
    head.append(mk, t, close);

    const list = el('div', 'list');
    media.slice(0, 4).forEach((item) => {
      const row = el('div', 'row');
      const ico = el('div', 'ico', (KIND_TEXT[item.kind] || '媒体').slice(0, 2));
      const meta = el('div', 'meta');
      meta.appendChild(el('div', 'name', pathName(item.url)));
      const bits = [hostOf(item.url), KIND_TEXT[item.kind] || '媒体', fmtBytes(item.size)];
      if (item.drmSuspect) bits.push('受保护');
      meta.appendChild(el('div', 'sub', bits.filter(Boolean).join(' · ')));
      const get = el('button', 'get', item.drmSuspect ? '不可下载' : '下载');
      get.disabled = !!item.drmSuspect;
      if (item.drmSuspect) get.title = '检测到 DRM/受保护流，按产品边界不提供下载';
      get.addEventListener('click', () => {
        chrome.runtime.sendMessage({
          type: 'fw:add',
          item: {
            url: item.url,
            pageUrl: location.href,
            referer: item.referer || location.href,
            cookie: item.cookie || '',
            ua: item.ua || navigator.userAgent,
            kind: item.kind,
            at: Date.now(),
          },
        });
        get.textContent = '已发送';
        setTimeout(() => { get.textContent = '下载'; }, 1600);
      });
      row.append(ico, meta, get);
      list.appendChild(row);
    });

    const foot = el('div', 'foot');
    foot.appendChild(el('div', 'hint', '工具栏徽标始终显示本页数量'));
    const open = el('button', null, '在 Fetchweir 中打开');
    open.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'fw:activate' }));
    foot.appendChild(open);
    panel.append(head, list, foot);
  }

  /* 自愈：站点 JS 删掉宿主时重新挂回 */
  function watch() {
    if (observer) return;
    observer = new MutationObserver(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        if (!host || !document.documentElement.contains(host)) {
          const keep = shadow;
          host = null; shadow = null; panel = null;
          build();
          if (keep && panel) render();
        }
      }, 200);
    });
    observer.observe(document.documentElement, { childList: true });
  }

  document.addEventListener('fullscreenchange', () => {
    const fs = document.fullscreenElement;
    build();
    if (!fs) { render(); return; }
    // 全屏时只有全屏子树会渲染：能塞进去就塞，塞不进就退化为徽标。
    try {
      if (fs.appendChild && !fs.contains(host)) {
        fs.appendChild(host);
        host.style.position = 'fixed';
      }
    } catch { host.style.display = 'none'; }
    render();
  }, true);

  /* DOM 媒体元素补充信号（blob: 说明是 MSE，真实地址只能靠网络层） */
  function collectDomMedia() {
    const out = [];
    const nodes = document.querySelectorAll('video, audio, source');
    for (const n of nodes) {
      const src = n.currentSrc || n.src || n.getAttribute('src') || '';
      if (!src || !/^https?:/.test(src)) continue;
      const tag = n.tagName.toLowerCase();
      out.push({ url: src, mime: tag === 'audio' ? 'audio/mpeg' : 'video/mp4', tag });
      if (out.length >= 8) break;
    }
    return out;
  }

  function reportDomMedia() {
    const list = collectDomMedia();
    if (!list.length) return;
    chrome.runtime.sendMessage({
      type: 'fw:hello',
      items: list,
      title: document.title,
    }).catch(() => {});
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'fw:media') {
      build();
      items = Array.isArray(msg.items) ? msg.items : items;
      dismissed = false;
      render();
      return;
    }
    if (msg.type === 'fw:config') {
      if ('ABC'.includes(msg.tier)) tier = msg.tier;
      render();
      return;
    }
    if (msg.type === 'fw:theme') {
      // 应用改主题后由后台广播；只替换 CSS 变量，面板不重建、页面不刷新。
      applyBarTheme(msg.theme);
    }
  });

  // 主题握手：向后台要当前缓存的 token；700ms 内没拿到就按中性回退画，避免闪变。
  const themeReady = new Promise((resolve) => {
    const timer = setTimeout(() => { themeSettled = true; resolve(); }, 700);
    chrome.runtime.sendMessage({ type: 'fw:theme' })
      .then((res) => { if (res && res.theme) applyBarTheme(res.theme); })
      .catch(() => {})
      .finally(() => { themeSettled = true; clearTimeout(timer); resolve(); });
  });

  // 首次握手：拿到档位与既有候选，并上报 DOM 媒体
  chrome.runtime.sendMessage({ type: 'fw:hello', items: collectDomMedia(), title: document.title })
    .then((res) => {
      if (res && res.theme) applyBarTheme(res.theme);
      if (res && 'ABC'.includes(res.tier)) tier = res.tier;
    })
    .catch(() => {});
  setTimeout(reportDomMedia, 2500);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) reportDomMedia(); });
})();
