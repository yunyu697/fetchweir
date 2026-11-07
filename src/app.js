/* Fetchweir 前端：命令绑定、任务列表、详情弹窗与设置 */
(() => {
  'use strict';

  const IS_TAURI = !!(window.__TAURI__ && window.__TAURI__.core);
  const invoke = IS_TAURI ? window.__TAURI__.core.invoke : null;
  const isDemo = !IS_TAURI && /[?&]demo/.test(location.search);

  const $ = (id) => document.getElementById(id);
  const state = {
    tasks: new Map(),
    filter: 'all',
    selectedId: null,
    detailId: null,
    settings: null,
    info: { version: '—', platform: '—', downloadDir: '', dataDir: '' },
    update: null,
  };

  /* ---------- 格式化 ---------- */
  const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
  function fmtBytes(n) {
    if (!n || n <= 0) return '—';
    let v = n, i = 0;
    while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i += 1; }
    return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${UNITS[i]}`;
  }
  function fmtSpeed(n) { return n > 0 ? `${fmtBytes(n)}/s` : '—'; }
  function fmtEta(t) {
    if (t.state === 'completed') return '已完成';
    if (!t.totalBytes || !t.speedBps) return '—';
    const left = t.totalBytes - t.doneBytes;
    if (left <= 0) return '完成中';
    const sec = Math.round(left / t.speedBps);
    if (sec < 60) return `${sec} 秒`;
    if (sec < 3600) return `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
    return `${Math.floor(sec / 3600)} 小时 ${Math.floor((sec % 3600) / 60)} 分`;
  }
  function fmtTime(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  const STATE_TEXT = { queued: '排队中', active: '下载中', paused: '已暂停', completed: '已完成', failed: '失败' };

  function hostOf(url) {
    try { return new URL(url).hostname; } catch { return ''; }
  }
  function extOf(name) {
    const m = /\.([a-z0-9]{1,5})(?:$|\?)/i.exec(name || '');
    return m ? m[1].toUpperCase() : 'FILE';
  }

  /* ---------- 提示 ---------- */
  function toast(message, kind = 'err') {
    const el = document.createElement('div');
    el.className = `toast${kind === 'ok' ? ' ok' : ''}`;
    el.textContent = message;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }

  /* ---------- 渲染 ---------- */
  function filtered() {
    const all = [...state.tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
    if (state.filter === 'active') return all.filter((t) => t.state === 'active' || t.state === 'queued');
    if (state.filter === 'done') return all.filter((t) => t.state === 'completed');
    return all;
  }

  function actionButtons(t) {
    const mk = (label, cls, fn, title) => {
      const b = document.createElement('button');
      b.className = `btn sm ${cls}`;
      b.textContent = label;
      if (title) b.title = title;
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
      b.addEventListener('dblclick', (e) => e.stopPropagation());
      return b;
    };

    if (t.state === 'active' || t.state === 'queued') {
      return [mk('暂停', '', () => doPause(t.id)), mk('取消', 'ghost', () => doRemove(t.id, true))];
    }
    if (t.state === 'paused') {
      return [mk('开始', 'primary', () => doResume(t.id)), mk('取消', 'ghost', () => doRemove(t.id, true))];
    }
    if (t.state === 'failed') {
      return [mk('重试', 'primary', () => doResume(t.id)), mk('取消', 'ghost', () => doRemove(t.id, true))];
    }
    return [
      mk('打开', 'ok', () => doOpen(t.savePath)),
      mk('打开文件夹', '', () => doReveal(t.savePath)),
      mk('移除', 'ghost', () => doRemove(t.id, false)),
    ];
  }

  function buildRow(t) {
    const row = document.createElement('div');
    row.className = 'task';
    row.dataset.id = t.id;
    if (state.selectedId === t.id) row.classList.add('selected');

    const name = document.createElement('div');
    name.className = 'name';
    const ico = document.createElement('div');
    ico.className = 'file-ico' + (t.state === 'completed' ? ' ok' : t.state === 'failed' ? ' err' : t.state === 'active' ? ' active' : '');
    ico.textContent = extOf(t.fileName);
    const col = document.createElement('div');
    col.className = 'name-col';
    const line = document.createElement('div');
    line.className = 'name-line';
    const text = document.createElement('span');
    text.className = 'name-text';
    text.textContent = t.fileName;
    const pill = document.createElement('span');
    pill.className = `state-pill ${t.state}`;
    pill.textContent = STATE_TEXT[t.state] || t.state;
    line.append(text, pill);
    const sub = document.createElement('div');
    sub.className = 'name-sub';
    sub.textContent = `${hostOf(t.url)} · ${t.connections} 段`;
    col.append(line, sub);
    name.append(ico, col);

    const size = document.createElement('div');
    size.className = 'size';
    size.textContent = fmtBytes(t.totalBytes);

    const pcell = document.createElement('div');
    pcell.className = 'progress-cell';
    const track = document.createElement('div');
    track.className = 'track';
    const fill = document.createElement('div');
    fill.className = 'fill' + (t.state === 'completed' ? ' ok' : t.state === 'failed' ? ' err' : '');
    track.appendChild(fill);
    const pct = document.createElement('div');
    pct.className = 'pct';
    const pctLeft = document.createElement('span');
    const pctRight = document.createElement('span');
    pct.append(pctLeft, pctRight);
    pcell.append(track, pct);

    const speed = document.createElement('div');
    speed.className = 'speed';
    const actions = document.createElement('div');
    actions.className = 'actions';
    actionButtons(t).forEach((b) => actions.appendChild(b));

    row.append(name, size, pcell, speed, actions);
    row.addEventListener('mousedown', () => select(t.id));
    row.addEventListener('dblclick', (e) => {
      if (e.target.closest('button')) return;
      openDetail(t.id);
    });
    paintRow(row, t);
    return row;
  }

  function paintRow(row, t) {
    const pct = t.totalBytes > 0 ? Math.min(100, (t.doneBytes / t.totalBytes) * 100) : 0;
    const fill = row.querySelector('.fill');
    if (fill) fill.style.width = `${pct.toFixed(1)}%`;
    const [pctLeft, pctRight] = row.querySelectorAll('.pct span');
    if (pctLeft) pctLeft.textContent = t.totalBytes > 0 ? `${pct.toFixed(1)}%` : fmtBytes(t.doneBytes);
    if (pctRight) pctRight.textContent = fmtEta(t);
    const speed = row.querySelector('.speed');
    if (speed) speed.innerHTML = t.state === 'active' ? `<b>${fmtSpeed(t.speedBps)}</b>` : '—';
    const size = row.querySelector('.size');
    if (size) size.textContent = fmtBytes(t.totalBytes);
    const pill = row.querySelector('.state-pill');
    if (pill) { pill.className = `state-pill ${t.state}`; pill.textContent = STATE_TEXT[t.state] || t.state; }
    const ico = row.querySelector('.file-ico');
    if (ico) ico.className = 'file-ico' + (t.state === 'completed' ? ' ok' : t.state === 'failed' ? ' err' : t.state === 'active' ? ' active' : '');
  }

  function renderList() {
    const list = $('taskList');
    const items = filtered();
    list.textContent = '';
    items.forEach((t) => list.appendChild(buildRow(t)));
    $('emptyState').hidden = items.length > 0;
    $('listTitle').textContent = state.filter === 'active' ? '正在下载' : state.filter === 'done' ? '已完成' : '全部任务';
    renderStats();
  }

  function renderStats() {
    const all = [...state.tasks.values()];
    const active = all.filter((t) => t.state === 'active');
    const done = all.filter((t) => t.state === 'completed');
    const speed = active.reduce((s, t) => s + (t.speedBps || 0), 0);
    $('countAll').textContent = String(all.length);
    $('countActive').textContent = String(active.length);
    $('countDone').textContent = String(done.length);
    $('sideSpeed').textContent = fmtSpeed(speed);
    $('statusSpeed').textContent = fmtSpeed(speed);
    $('sideActive').textContent = `${active.length} 个任务下载中`;
    $('statusText').textContent = active.length ? `正在下载 ${active.length} 个任务` : (all.length ? '空闲' : '就绪');
    const limit = state.settings ? state.settings.globalLimitBps : 0;
    $('sideLimit').textContent = limit > 0 ? `限速 ${fmtBytes(limit)}/s` : '不限速';
    const degree = Math.min(100, (speed / (60 * 1024 * 1024)) * 100);
    $('sideLoad').style.width = `${degree.toFixed(0)}%`;
  }

  function upsert(t, structural = true) {
    state.tasks.set(t.id, t);
    if (structural) renderList();
    else {
      const row = document.querySelector(`.task[data-id="${t.id}"]`);
      if (row) paintRow(row, t);
      renderStats();
    }
    if (state.detailId === t.id) paintDetail(t);
  }

  /* ---------- 操作 ---------- */
  function select(id) {
    state.selectedId = id;
    document.querySelectorAll('.task').forEach((r) => r.classList.toggle('selected', Number(r.dataset.id) === id));
  }

  async function doPause(id) {
    try { await invoke('pause_task', { id }); } catch (e) { toast(String(e)); }
  }
  async function doResume(id) {
    try { await invoke('resume_task', { id }); } catch (e) { toast(String(e)); }
  }
  async function doRemove(id, deleteFile) {
    try { await invoke('remove_task', { id, deleteFile }); } catch (e) { toast(String(e)); }
  }
  async function doOpen(path) {
    try { await invoke('open_path', { path }); } catch (e) { toast(String(e)); }
  }
  async function doReveal(path) {
    try { await invoke('reveal_path', { path }); } catch (e) { toast(String(e)); }
  }

  async function addTask() {
    const url = $('urlInput').value.trim();
    if (!url) { toast('请先输入下载链接'); return; }
    const dir = $('dirInput').value.trim();
    const connRaw = $('connInput').value.trim();
    const connections = connRaw ? Math.max(1, Math.min(16, Number(connRaw))) : null;
    try {
      const dto = await invoke('add_task', {
        url,
        saveDir: dir || null,
        connections,
        autoStart: true,
      });
      upsert(dto);
      $('urlInput').value = '';
    } catch (e) {
      toast(String(e));
    }
  }

  /* ---------- 详情 ---------- */
  function openDetail(id) {
    const t = state.tasks.get(id);
    if (!t) return;
    state.detailId = id;
    select(id);
    paintDetail(t);
    $('detailOverlay').hidden = false;
    $('detailClose').focus();
  }
  function closeDetail() {
    $('detailOverlay').hidden = true;
    state.detailId = null;
  }
  function paintDetail(t) {
    $('detailTitle').textContent = t.fileName;
    $('detailState').textContent = `${STATE_TEXT[t.state] || t.state}${t.error ? ' · ' + t.error : ''}`;
    $('detailUrl').textContent = t.url;
    $('detailPath').textContent = t.savePath;
    $('detailSize').textContent = fmtBytes(t.totalBytes);
    $('detailDone').textContent = `${fmtBytes(t.doneBytes)}（${t.totalBytes ? ((t.doneBytes / t.totalBytes) * 100).toFixed(1) : 0}%）`;
    $('detailConns').textContent = `${t.connections} 段 · ${t.supportsRanges ? '服务端支持 Range' : '单连接直连'}`;
    $('detailCreated').textContent = fmtTime(t.createdAt);
    $('detailErrRow').hidden = !t.error;
    $('detailErr').textContent = t.error || '';

    const acts = $('detailActions');
    acts.textContent = '';
    if (t.state === 'active' || t.state === 'queued') {
      acts.appendChild(makeBtn('暂停', '', () => doPause(t.id)));
    }
    if (t.state === 'paused' || t.state === 'failed') {
      acts.appendChild(makeBtn('开始', 'primary', () => doResume(t.id)));
    }
    if (t.state === 'completed') {
      acts.appendChild(makeBtn('打开', 'ok', () => doOpen(t.savePath)));
      acts.appendChild(makeBtn('打开文件夹', '', () => doReveal(t.savePath)));
    }
    acts.appendChild(makeBtn('关闭', 'ghost', closeDetail));
  }
  function makeBtn(label, cls, fn) {
    const b = document.createElement('button');
    b.className = `btn ${cls}`;
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  }

  /* ---------- 设置与主题 ---------- */
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
    document.querySelectorAll('#segTheme button').forEach((b) => {
      b.classList.toggle('on', b.dataset.themeVal === (theme === 'light' ? 'light' : 'dark'));
    });
  }

  function renderSettings() {
    const s = state.settings;
    if (!s) return;
    $('setDir').value = s.downloadDir || '';
    $('setConns').value = String(s.connections ?? 8);
    $('setLimit').value = String(Math.round((s.globalLimitBps || 0) / 1024));
    $('setUpdateRepo').value = s.updateRepo || 'yunyu697/fetchweir';
    $('setUpdateToken').value = s.updateToken || '';
    $('setHomepage').value = s.homepage || '';
    applyTheme(s.theme);
  }

  /* ---------- 更新器 ---------- */
  const UPDATE_STAGE_TEXT = {
    checking: '正在检查…',
    upToDate: '已是最新',
    updateAvailable: '发现新版本',
    downloading: '正在下载更新包',
    downloaded: '已下载完成',
    installing: '正在安装',
    failed: '更新失败',
  };

  function renderUpdate(u) {
    if (!u) return;
    state.update = u;
    const hasLatest = !!u.latestVersion;
    const failedCheck = u.stage === 'failed' && !hasLatest;

    $('updatePanel').hidden = !hasLatest;
    $('updateHint').classList.toggle('err-color', failedCheck);
    let hint;
    if (failedCheck) hint = u.message || '检查更新失败';
    else if (u.stage === 'upToDate' && hasLatest) hint = `已是最新（v${u.latestVersion}）`;
    else hint = UPDATE_STAGE_TEXT[u.stage] || '';
    $('updateHint').textContent = hint;

    if (hasLatest) {
      $('updateVersion').textContent = `v${u.latestVersion}`;
      $('updateDate').textContent = u.publishedAt ? fmtTime(Date.parse(u.publishedAt)) : '';
      $('updateNotes').textContent = u.notes || '';
    }

    // 镜像下拉：只在选项集合或选中项变化时重建，避免高频进度事件打断展开状态。
    const sig = `${(u.mirrors || []).map((m) => m.id).join(',')}|${u.mirror}`;
    const sel = $('updateMirror');
    if (sel.dataset.sig !== sig) {
      sel.textContent = '';
      (u.mirrors || []).forEach((m) => {
        const o = document.createElement('option');
        o.value = m.id;
        o.textContent = m.label;
        sel.appendChild(o);
      });
      sel.value = u.mirror;
      sel.dataset.sig = sig;
    }

    const busy = u.stage === 'downloading' || u.stage === 'installing';
    const canInstall = !!u.canInstall && !busy;
    $('updateMainActions').hidden = canInstall;
    $('updateDoneActions').hidden = !canInstall;
    $('btnCheckUpdate').disabled = busy || u.stage === 'checking';
    $('btnUpdateNow').disabled = busy;
    $('btnDownloadOnly').disabled = busy;
    $('btnInstall').disabled = busy;
    $('updateMirror').disabled = busy;
    $('btnCancelUpdate').hidden = u.stage !== 'downloading';

    const showProgress = u.stage === 'downloading' || (u.downloaded > 0 && !canInstall);
    $('updateProgressWrap').hidden = !showProgress;
    if (showProgress) {
      const pct = Math.max(0, Math.min(100, u.progress || 0));
      $('updateFill').style.width = `${pct.toFixed(1)}%`;
      $('updateStatusText').textContent = u.stage === 'downloading'
        ? `正在下载 · ${pct.toFixed(0)}%`
        : `已下载 ${fmtBytes(u.downloaded)}，可继续`;
      $('updateBytes').textContent = u.total ? `${fmtBytes(u.downloaded)} / ${fmtBytes(u.total)}` : fmtBytes(u.downloaded);
    }

    const showMsg = !!u.message && u.stage !== 'downloading';
    $('updateMsg').hidden = !showMsg;
    $('updateMsg').textContent = showMsg ? u.message : '';
    $('updateMsg').classList.toggle('err', u.stage === 'failed');
  }

  async function checkUpdate() {
    if (!IS_TAURI) return;
    try {
      renderUpdate(await invoke('check_update'));
    } catch (e) {
      toast(String(e));
    }
  }

  async function startUpdate(mode) {
    if (!IS_TAURI) return;
    try {
      renderUpdate(await invoke('download_update', { mode }));
    } catch (e) {
      toast(String(e));
    }
  }

  async function saveSettings() {
    if (!state.settings) return;
    const next = {
      downloadDir: $('setDir').value.trim() || state.settings.downloadDir,
      connections: Math.max(1, Math.min(16, Number($('setConns').value) || 8)),
      globalLimitBps: Math.max(0, Number($('setLimit').value) || 0) * 1024,
      theme: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
      updateRepo: $('setUpdateRepo').value.trim() || 'yunyu697/fetchweir',
      updateToken: $('setUpdateToken').value.trim(),
      updateMirror: state.settings.updateMirror || 'github',
      homepage: $('setHomepage').value.trim() || 'https://github.com/yunyu697/fetchweir',
    };
    try {
      await invoke('save_settings', { settings: next });
      state.settings = next;
      renderSettings();
      renderStats();
      toast('设置已保存', 'ok');
    } catch (e) {
      toast(String(e));
    }
  }

  /* ---------- 视图切换 ---------- */
  function showView(name, filter) {
    state.filter = filter || state.filter;
    const downloads = name === 'downloads';
    $('view-downloads').hidden = !downloads;
    $('view-settings').hidden = downloads;
    document.querySelectorAll('.sb').forEach((el) => {
      const matchNav = el.dataset.nav === name;
      const matchFilter = name !== 'downloads' || el.dataset.filter === state.filter;
      el.classList.toggle('active', matchNav && matchFilter);
    });
    if (downloads) renderList();
  }

  /* ---------- 事件绑定 ---------- */
  function bind() {
    $('btnMinimize').addEventListener('click', async () => {
      if (IS_TAURI) await window.__TAURI__.window.getCurrentWindow().minimize();
    });
    $('btnMaximize').addEventListener('click', async () => {
      if (IS_TAURI) await window.__TAURI__.window.getCurrentWindow().toggleMaximize();
    });
    $('btnClose').addEventListener('click', async () => {
      if (IS_TAURI) await window.__TAURI__.window.getCurrentWindow().close();
    });

    document.querySelectorAll('.sb').forEach((el) => {
      el.addEventListener('click', () => {
        if (el.dataset.nav === 'settings') showView('settings');
        else showView('downloads', el.dataset.filter);
      });
    });

    $('btnAdd').addEventListener('click', addTask);
    $('urlInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') addTask(); });
    $('btnAddOptions').addEventListener('click', () => {
      const bar = $('advancedBar');
      bar.hidden = !bar.hidden;
    });
    $('btnOpenFolder').addEventListener('click', () => {
      const dir = (state.settings && state.settings.downloadDir) || state.info.downloadDir;
      if (dir) doReveal(dir);
    });
    $('btnSaveSettings').addEventListener('click', saveSettings);
    $('btnCheckUpdate').addEventListener('click', checkUpdate);
    $('btnOpenHome').addEventListener('click', async () => {
      if (!IS_TAURI) return;
      try { await invoke('open_homepage'); } catch (e) { toast(String(e)); }
    });
    $('btnUpdateNow').addEventListener('click', () => startUpdate('install'));
    $('btnDownloadOnly').addEventListener('click', () => startUpdate('only'));
    $('btnCancelUpdate').addEventListener('click', async () => {
      if (!IS_TAURI) return;
      try { renderUpdate(await invoke('cancel_update')); } catch (e) { toast(String(e)); }
    });
    $('btnInstall').addEventListener('click', async () => {
      if (!IS_TAURI) return;
      try { renderUpdate(await invoke('install_update')); } catch (e) { toast(String(e)); }
    });
    $('btnOpenDownloads').addEventListener('click', () => {
      const dir = state.update && state.update.downloadDir;
      if (dir) doReveal(dir);
    });
    $('updateMirror').addEventListener('change', async () => {
      if (!IS_TAURI) return;
      try {
        renderUpdate(await invoke('set_update_mirror', { mirror: $('updateMirror').value }));
      } catch (e) { toast(String(e)); }
    });
    $('btnRevealDir').addEventListener('click', () => {
      const dir = $('setDir').value.trim();
      if (dir) doReveal(dir);
    });
    document.querySelectorAll('#segTheme button').forEach((b) => {
      b.addEventListener('click', () => {
        applyTheme(b.dataset.themeVal);
        $('setConns').dispatchEvent(new Event('change'));
      });
    });

    $('detailClose').addEventListener('click', closeDetail);
    $('detailOverlay').addEventListener('mousedown', (e) => {
      if (e.target === $('detailOverlay')) closeDetail();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('detailOverlay').hidden) closeDetail();
    });
  }

  /* ---------- 启动 ---------- */
  async function boot() {
    bind();
    if (IS_TAURI) {
      try {
        state.info = await invoke('app_info');
        state.settings = await invoke('get_settings');
        renderSettings();
        state.update = await invoke('update_status');
        renderUpdate(state.update);
        const version = `v${state.info.version}`;
        $('versionPill').textContent = version;
        $('statusVersion').textContent = version;
        $('setVersion').textContent = version;
        $('setDataDir').textContent = state.info.dataDir;
        $('sidePlatform').textContent = state.info.platform;

        (await invoke('list_tasks')).forEach((t) => state.tasks.set(t.id, t));
        renderList();

        await window.__TAURI__.event.listen('fw://task', (e) => upsert(e.payload));
        await window.__TAURI__.event.listen('fw://removed', (e) => {
          state.tasks.delete(e.payload.id);
          if (state.detailId === e.payload.id) closeDetail();
          renderList();
        });
        await window.__TAURI__.event.listen('fw://progress', (e) => {
          e.payload.items.forEach((p) => {
            const t = state.tasks.get(p.id);
            if (!t) return;
            t.doneBytes = p.doneBytes;
            t.totalBytes = p.totalBytes || t.totalBytes;
            t.speedBps = p.speedBps;
            upsert(t, false);
          });
        });
        await window.__TAURI__.event.listen('fw://update', (e) => renderUpdate(e.payload));

        await invoke('ui_ready');
      } catch (e) {
        toast(`初始化失败：${e}`);
      }
      return;
    }

    // 非 Tauri：仅用于离屏渲染校验（?demo）
    if (isDemo) {
      const demo = [
        { id: 1, url: 'https://mirrors.example.com/ubuntu-24.04.iso', fileName: 'ubuntu-24.04-desktop-amd64.iso', savePath: 'C:/Downloads/ubuntu.iso', totalBytes: 4.7e9, doneBytes: 2.1e9, speedBps: 18.6e6, state: 'active', connections: 8, supportsRanges: true, createdAt: Date.now() - 600000 },
        { id: 2, url: 'https://cdn.example.com/video.mp4', fileName: 'conference-2026-keynote.mp4', savePath: 'C:/Downloads/keynote.mp4', totalBytes: 1.2e9, doneBytes: 3.4e8, speedBps: 0, state: 'paused', connections: 6, supportsRanges: true, createdAt: Date.now() - 3600000 },
        { id: 3, url: 'https://example.com/tools.zip', fileName: 'fetchweir-1.0.0.zip', savePath: 'C:/Downloads/fetchweir-1.0.0.zip', totalBytes: 24e6, doneBytes: 24e6, speedBps: 0, state: 'completed', connections: 4, supportsRanges: true, createdAt: Date.now() - 86400000 },
      ];
      demo.forEach((t) => state.tasks.set(t.id, t));
      state.settings = {
        downloadDir: 'C:/Users/Public/Downloads',
        connections: 8,
        globalLimitBps: 0,
        theme: 'dark',
        updateRepo: 'yunyu697/fetchweir',
        updateToken: '',
        updateMirror: 'ghfast',
        homepage: 'https://github.com/yunyu697/fetchweir',
      };
      state.update = {
        stage: 'updateAvailable',
        currentVersion: '1.0.0-alpha2',
        latestVersion: '1.0.0-alpha3',
        notes: '本次更新：\n· 修复暂停后立即继续时偶发的文件名回退\n· 新增下载完成后的校验提示\n· 提高多任务并发时的进度合并频率稳定性',
        publishedAt: '2026-11-06T09:12:00Z',
        assetName: 'Fetchweir_1.0.0-alpha3_x64-setup.exe',
        assetSize: 1.4e6,
        mirrors: [
          { id: 'github', label: 'GitHub 直连' },
          { id: 'ghfast', label: '加速镜像 ghfast.top' },
          { id: 'ghproxy', label: '加速镜像 gh-proxy.com' },
        ],
        mirror: 'ghfast',
        progress: 0,
        downloaded: 0,
        total: 1.4e6,
        path: null,
        message: null,
        canInstall: false,
        downloadDir: 'C:/Users/Tyler/Downloads',
      };
      renderSettings();
      renderUpdate(state.update);
      $('versionPill').textContent = 'v1.0.0-alpha1';
      $('statusVersion').textContent = 'v1.0.0-alpha1';
      $('setVersion').textContent = 'v1.0.0-alpha1';
      $('setDataDir').textContent = 'C:/Users/Tyler/AppData/Local/Fetchweir';
      $('sidePlatform').textContent = 'windows';
      renderList();
      // 离屏校验用：?demo&detail=1 打开详情，?demo&view=settings 切到设置
      if (/[?&]detail/.test(location.search)) openDetail(1);
      if (/[?&]view=settings/.test(location.search)) showView('settings');
      // 演示进度动画
      setInterval(() => {
        const t = state.tasks.get(1);
        if (!t || t.state !== 'active') return;
        t.doneBytes = Math.min(t.totalBytes, t.doneBytes + 22e6);
        t.speedBps = 17e6 + Math.random() * 4e6;
        upsert(t, false);
      }, 1000);
    }
  }

  boot();
})();
