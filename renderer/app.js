'use strict';

(() => {
  const api = window.portpilot;

  const ICON_PATHS = {
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    play: '<path d="m8 5 11 7-11 7Z"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    restart: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/>',
    activity: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
    arrowRight: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
    x: '<path d="M6 6l12 12"/><path d="M18 6 6 18"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    alert: '<path d="M12 4 3 20h18Z"/><path d="M12 9v5"/><path d="M12 17h.01"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
    code: '<path d="m8 9-4 3 4 3"/><path d="m16 9 4 3-4 3"/>',
    route: '<circle cx="6" cy="6" r="2.2"/><circle cx="18" cy="18" r="2.2"/><path d="M8.2 6H14a4 4 0 0 1 0 8H8"/><path d="m10 11-3 3 3 3"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5Z"/><path d="m3 13 9 5 9-5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    shield: '<path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6Z"/><path d="m9 12 2 2 4-4"/>',
  };

  const SERVICE_META = {
    running: { title: '转发服务运行中', dot: 'ok' },
    stopped: { title: '转发服务已停止', dot: '' },
    starting: { title: '正在启动转发服务', dot: 'pending' },
    restarting: { title: '正在重启 HAProxy', dot: 'pending' },
    error: { title: '转发服务异常', dot: 'bad' },
  };

  const state = {
    data: null,
    initialized: false,
    view: 'rules',
    logs: [],
    testResults: new Map(),
    confirmResolver: null,
    serviceBusy: false,
    logAutoScroll: true,
    checkingUpdate: false,
    updateStatus: null,
    lastConfigText: '',
    lastConfigPath: '',
  };

  function icon(name, className = '') {
    const path = ICON_PATHS[name] || '';
    return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  }

  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, (char) => {
      switch (char) {
        case '&':
          return '&amp;';
        case '<':
          return '&lt;';
        case '>':
          return '&gt;';
        case '"':
          return '&quot;';
        default:
          return '&#39;';
      }
    });
  }

  function formatDuration(ms) {
    const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;

    if (hours > 0) return `${hours} 小时 ${String(minutes).padStart(2, '0')} 分`;
    if (minutes > 0) return `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒`;
    return `${seconds} 秒`;
  }

  function formatClock(ts) {
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) return '--:--:--';
    return date.toLocaleTimeString('zh-CN', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function activeCount() {
    return (state.data?.rules || []).filter((rule) => rule.enabled).length;
  }

  function ruleById(id) {
    return (state.data?.rules || []).find((rule) => rule.id === id) || null;
  }

  function localAddressAvailable(rule) {
    return (state.data?.interfaces || []).some((item) => item.address === rule.localIp);
  }

  function currentUptime() {
    const service = state.data?.service;
    if (!service || service.state !== 'running') return 0;
    return Math.max(service.uptimeMs || 0, service.startedAt ? Date.now() - service.startedAt : 0);
  }

  function bootstrap() {
    bindEvents();

    if (!api) {
      showLoadingError('无法连接到 PortPilot 主进程，请重新启动应用。');
      return;
    }

    api.onStateChanged((next) => applyState(next));
    api.onLog((entry) => appendLog(entry));

    refreshState(false).then((ok) => {
      if (ok) hideLoading();
    });

    setInterval(tick, 1000);
    setInterval(() => {
      refreshState(true);
    }, 20000);
  }

  async function refreshState(silent) {
    try {
      const data = await api.getState();
      const firstLoad = !state.initialized;
      if (firstLoad) {
        state.logs = Array.isArray(data.logs) ? data.logs : [];
        state.initialized = true;
      }
      applyState(data);
      if (firstLoad) {
        renderLogs();
        hideLoading();
      }
      return true;
    } catch (error) {
      if (!silent) {
        showLoadingError(error.message || '读取应用状态失败');
      }
      return false;
    }
  }

  function applyState(data) {
    if (!data) return;
    const { logs, ...rest } = data;
    state.data = { ...(state.data || {}), ...rest };
    renderAll();
  }

  function bindEvents() {
    document.querySelector('.nav').addEventListener('click', (event) => {
      const button = event.target.closest('[data-view]');
      if (!button) return;
      switchView(button.dataset.view);
    });

    document.addEventListener('click', (event) => {
      const target = event.target.closest('[data-action]');
      if (!target) return;
      handleAction(target, event);
    });

    document.addEventListener('change', (event) => {
      const target = event.target;
      if (target.id === 'logAutoScroll') {
        state.logAutoScroll = target.checked;
        if (state.logAutoScroll) scrollLogsToBottom();
        return;
      }

      if (target.matches('[data-action="toggle-rule"]')) {
        toggleRule(target);
        return;
      }

      if (target.matches('[data-setting]')) {
        updateSetting(target);
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && document.getElementById('modalRoot').children.length > 0) {
        event.preventDefault();
        closeModal();
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
        if (document.getElementById('modalRoot').children.length === 0) {
          event.preventDefault();
          openRuleModal();
        }
      }
    });
  }

  function handleAction(target, event) {
    const action = target.dataset.action;
    const id = target.dataset.id || '';

    switch (action) {
      case 'add-rule':
        openRuleModal();
        break;
      case 'edit-rule': {
        const rule = ruleById(id);
        if (rule) openRuleModal(rule);
        break;
      }
      case 'delete-rule':
        deleteRule(id);
        break;
      case 'test-rule':
        testRule(id);
        break;
      case 'refresh-interfaces':
        refreshInterfaces();
        break;
      case 'refresh-interfaces-in-modal':
        refreshInterfacesInModal();
        break;
      case 'service-start':
        runServiceAction('start');
        break;
      case 'service-stop':
        runServiceAction('stop');
        break;
      case 'service-restart':
        runServiceAction('restart');
        break;
      case 'side-toggle':
        runServiceAction(state.data?.service?.state === 'running' ? 'stop' : 'start');
        break;
      case 'view-config':
        openConfigModal();
        break;
      case 'open-config':
        openPath(() => api.showConfigFile());
        break;
      case 'open-data-dir':
        openPath(() => api.openDataDir());
        break;
      case 'open-haproxy-dir':
        openPath(() => api.openHaproxyDir());
        break;
      case 'open-repository':
        openExternalLink(() => api.openRepository());
        break;
      case 'open-releases':
        openExternalLink(() => api.openReleases());
        break;
      case 'check-updates':
        runUpdateCheck();
        break;
      case 'copy-config':
        copyConfig();
        break;
      case 'clear-logs':
        clearLogs();
        break;
      case 'close-modal':
        closeModal();
        break;
      case 'confirm-cancel':
        closeModal();
        break;
      case 'confirm-accept': {
        const resolver = state.confirmResolver;
        state.confirmResolver = null;
        closeModal();
        if (resolver) resolver(true);
        break;
      }
      default:
        break;
    }

    if (action === 'add-rule' || action === 'edit-rule' || action === 'delete-rule') {
      event.preventDefault();
    }
  }

  function switchView(view) {
    state.view = view;
    document.querySelectorAll('.nav-item').forEach((item) => {
      item.classList.toggle('is-active', item.dataset.view === view);
    });
    document.querySelectorAll('.view').forEach((item) => {
      item.classList.toggle('is-active', item.id === `view-${view}`);
    });
    const main = document.getElementById('main');
    main.scrollTop = 0;
    if (view === 'logs') {
      requestAnimationFrame(() => {
        if (state.logAutoScroll) scrollLogsToBottom();
      });
    }
  }

  function renderAll() {
    if (!state.data) return;
    renderChrome();
    renderServiceBanner();
    renderStats();
    renderRules();
    renderServiceMini();
    renderSettings();
    tick();
  }

  function renderChrome() {
    const appInfo = state.data.app || {};
    const versionNode = document.getElementById('appVersion');
    if (versionNode) versionNode.textContent = `v${appInfo.version || '–'}`;

    const count = (state.data.rules || []).length;
    document.getElementById('navRuleCount').textContent = String(count);
    document.querySelectorAll('.nav-item').forEach((item) => {
      item.classList.toggle('is-active', item.dataset.view === state.view);
    });
  }

  function renderServiceBanner() {
    const container = document.getElementById('serviceBanner');
    const service = state.data.service || { state: 'stopped' };
    const info = SERVICE_META[service.state] || SERVICE_META.stopped;
    const enabled = activeCount();
    const haproxy = state.data.haproxy || {};
    const running = service.state === 'running';
    const transitioning = service.state === 'starting' || service.state === 'restarting';
    const busy = state.serviceBusy;

    let meta = `<span>HAProxy <b>${escapeHtml(haproxy.version || '未知')}</b></span>`;
    meta += `<span><b>${enabled}</b> 条规则已启用</span>`;

    if (running) {
      meta += `<span>已运行 <b data-uptime>${formatDuration(currentUptime())}</b></span>`;
    } else if (transitioning) {
      meta += '<span>正在应用配置…</span>';
    } else if (enabled === 0) {
      meta += '<span>请先启用至少一条规则</span>';
    } else {
      meta += '<span>转发服务未运行</span>';
    }

    let controls = '';

    if (transitioning) {
      controls = `<button class="btn btn-secondary" type="button" disabled>${icon('refresh', 'is-spinning')} 处理中…</button>`;
    } else if (running) {
      controls = `<button class="btn btn-ghost" type="button" data-action="service-restart" ${busy ? 'disabled' : ''}>${icon('restart')} 重启</button>`;
      controls += `<button class="btn btn-secondary" type="button" data-action="service-stop" ${busy ? 'disabled' : ''}>${icon('stop')} 停止</button>`;
    } else {
      const disabled = busy || enabled === 0;
      controls = `<button class="btn btn-primary" type="button" data-action="service-start" ${disabled ? 'disabled' : ''}>${icon('play')} ${service.state === 'error' ? '重试启动' : '启动转发'}</button>`;
    }

    const pidChip = running && service.pid ? `<span class="pid-chip">PID ${service.pid}</span>` : '';
    const message = service.message ? `<div class="service-message">${escapeHtml(service.message)}</div>` : '';

    container.innerHTML = `
      <div class="service-banner" data-state="${escapeHtml(service.state)}">
        <div class="service-main">
          <div class="status-orb"><span class="status-dot ${info.dot}"></span></div>
          <div class="service-copy">
            <div class="service-title-row">
              <h2>${info.title}</h2>
              ${pidChip}
            </div>
            <div class="service-meta">${meta}</div>
            ${message}
          </div>
        </div>
        <div class="service-actions">${controls}</div>
      </div>
    `;
  }

  function renderStats() {
    const rules = state.data.rules || [];
    const enabled = rules.filter((rule) => rule.enabled).length;
    const running = state.data.service?.state === 'running';
    const uptime = running ? formatDuration(currentUptime()) : '—';

    document.getElementById('statsGrid').innerHTML = `
      <div class="stat-card">
        <span class="stat-icon">${icon('layers')}</span>
        <span class="stat-copy">
          <strong>${rules.length}</strong>
          <span>条转发规则</span>
        </span>
      </div>
      <div class="stat-card">
        <span class="stat-icon">${icon('activity')}</span>
        <span class="stat-copy">
          <strong>${enabled}</strong>
          <span>${running ? '条规则正在转发' : '条规则已启用'}</span>
        </span>
      </div>
      <div class="stat-card">
        <span class="stat-icon">${icon('clock')}</span>
        <span class="stat-copy">
          <strong data-uptime>${uptime}</strong>
          <span>HAProxy 运行时长</span>
        </span>
      </div>
    `;
  }

  function renderRules() {
    const rules = state.data.rules || [];
    const enabled = rules.filter((rule) => rule.enabled).length;
    const list = document.getElementById('rulesList');

    document.getElementById('ruleSummary').textContent = `${rules.length} 条规则 · ${enabled} 条已启用`;

    if (rules.length === 0) {
      list.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">${icon('route')}</div>
          <h3>还没有转发规则</h3>
          <p>选择本机网卡和端口，填写目标 IP 地址即可创建第一条 TCP 转发规则。</p>
          <button class="btn btn-primary" type="button" data-action="add-rule">${icon('plus')} 添加第一条规则</button>
        </div>
      `;
      return;
    }

    list.innerHTML = rules.map(ruleCardMarkup).join('');
  }

  function ruleCardMarkup(rule) {
    const available = localAddressAvailable(rule);
    const running = state.data.service?.state === 'running';
    const localTarget = rule.targetMode === 'localNic';
    const targetSub = localTarget
      ? `本机 · ${escapeHtml(rule.targetInterface || '另一块网卡')}`
      : '远程地址';

    let pillClass = 'pill';
    let pillLabel = '已停用';

    if (rule.enabled) {
      if (!available) {
        pillClass = 'pill pill-danger';
        pillLabel = '地址不可用';
      } else if (running) {
        pillClass = 'pill pill-success';
        pillLabel = '转发中';
      } else {
        pillClass = 'pill pill-warning';
        pillLabel = '待启动';
      }
    }

    return `
      <article class="rule-card ${rule.enabled ? '' : 'is-disabled'}" data-rule-id="${escapeHtml(rule.id)}">
        <div class="rule-toggle">
          <label class="switch" title="${rule.enabled ? '停用规则' : '启用规则'}">
            <input type="checkbox" data-action="toggle-rule" data-id="${escapeHtml(rule.id)}" ${rule.enabled ? 'checked' : ''} />
            <span></span>
          </label>
        </div>
        <div class="rule-body">
          <div class="rule-title-row">
            <h3 title="${escapeHtml(rule.name)}">${escapeHtml(rule.name)}</h3>
            <span class="${pillClass}">${pillLabel}</span>
          </div>
          <div class="rule-route">
            <div class="endpoint">
              <span class="endpoint-label">对外监听</span>
              <span class="endpoint-main">${escapeHtml(rule.localIp)}<b>:${escapeHtml(rule.localPort)}</b></span>
              <span class="endpoint-sub">${escapeHtml(rule.localInterface || '未知网卡')}${available ? '' : ' · 地址已失效'}</span>
            </div>
            <div class="route-arrow">${icon('arrowRight')}</div>
            <div class="endpoint target">
              <span class="endpoint-label">转发目标</span>
              <span class="endpoint-main">${escapeHtml(rule.targetIp)}<b>:${escapeHtml(rule.targetPort)}</b></span>
              <span class="endpoint-sub">${targetSub}</span>
            </div>
          </div>
          ${testResultMarkup(rule)}
        </div>
        <div class="rule-actions">
          <button class="icon-btn" type="button" data-action="test-rule" data-id="${escapeHtml(rule.id)}" title="测试连通性" aria-label="测试连通性">${icon('activity')}</button>
          <button class="icon-btn" type="button" data-action="edit-rule" data-id="${escapeHtml(rule.id)}" title="编辑规则" aria-label="编辑规则">${icon('edit')}</button>
          <button class="icon-btn danger" type="button" data-action="delete-rule" data-id="${escapeHtml(rule.id)}" title="删除规则" aria-label="删除规则">${icon('trash')}</button>
        </div>
      </article>
    `;
  }

  function testResultMarkup(rule) {
    const result = state.testResults.get(rule.id);
    if (!result) return '';

    if (result.loading) {
      return `<div class="test-result"><span class="test-chip pending">正在测试本机端口与目标地址…</span></div>`;
    }

    if (result.error) {
      return `<div class="test-result"><span class="test-chip bad">${icon('alert')} ${escapeHtml(result.error)}</span></div>`;
    }

    const frontend = result.frontend || {};
    const target = result.target || {};

    return `
      <div class="test-result">
        <span class="test-chip ${frontend.ok ? 'ok' : 'bad'}">
          ${frontend.ok ? icon('check') : icon('alert')}
          本机端口 ${frontend.ok ? `可达 · ${frontend.latencyMs} ms` : `失败：${escapeHtml(frontend.error)}`}
        </span>
        <span class="test-chip ${target.ok ? 'ok' : 'bad'}">
          ${target.ok ? icon('check') : icon('alert')}
          目标地址 ${target.ok ? `可达 · ${target.latencyMs} ms` : `失败：${escapeHtml(target.error)}`}
        </span>
      </div>
    `;
  }

  function renderServiceMini() {
    const container = document.getElementById('serviceMini');
    if (!container) return;

    const service = state.data.service || { state: 'stopped' };
    const info = SERVICE_META[service.state] || SERVICE_META.stopped;
    const enabled = activeCount();
    const running = service.state === 'running';
    const transitioning = service.state === 'starting' || service.state === 'restarting';
    const disabled = state.serviceBusy || transitioning || (!running && enabled === 0);
    const actionLabel = running ? '停止' : service.state === 'error' ? '重试' : '启动';

    container.innerHTML = `
      <div class="service-mini-head">
        <span class="status-dot ${info.dot}"></span>
        <span>转发服务</span>
        <strong>${service.state === 'running' ? '运行中' : service.state === 'error' ? '异常' : service.state === 'stopped' ? '已停止' : '处理中'}</strong>
      </div>
      <div class="service-mini-meta">
        <span>${enabled} 条规则已启用</span>
        <button class="mini-action" type="button" data-action="side-toggle" ${disabled ? 'disabled' : ''}>${actionLabel}</button>
      </div>
    `;
  }

  function renderSettings() {
    const container = document.getElementById('settingsContent');
    if (!container) return;

    const settings = state.data.settings || {};
    const haproxy = state.data.haproxy || {};
    const paths = state.data.paths || {};
    const appInfo = state.data.app || {};

    container.innerHTML = `
      <div class="settings-grid">
        <section class="panel settings-panel">
          <h2>常规</h2>
          <p>控制应用启动方式与窗口行为。</p>
          <div class="setting-list">
            ${settingRow('autoStartService', '应用启动时自动运行转发', '打开 PortPilot 后自动启动 HAProxy。', settings.autoStartService)}
            ${settingRow('launchAtLogin', '开机自动启动 PortPilot', '登录 Windows 后自动运行应用。', settings.launchAtLogin)}
            ${settingRow('closeToTray', '关闭窗口时最小化到托盘', '关闭主窗口不会停止转发服务。', settings.closeToTray)}
            ${settingRow('showNotifications', '显示托盘通知', '在托盘气泡中提示启动结果和错误。', settings.showNotifications)}
          </div>
        </section>

        <section class="panel settings-panel">
          <h2>HAProxy 运行时</h2>
          <p>转发由内置 HAProxy 执行，配置会在应用规则时自动生成。</p>
          <dl class="info-list">
            <div class="info-row"><dt>HAProxy 版本</dt><dd>${escapeHtml(haproxy.version || haproxy.versionError || '未知')}</dd></div>
            <div class="info-row"><dt>可执行文件</dt><dd class="mono">${escapeHtml(haproxy.executablePath || '—')}</dd></div>
            <div class="info-row"><dt>配置文件</dt><dd class="mono">${escapeHtml(haproxy.configPath || paths.configPath || '—')}</dd></div>
            <div class="info-row"><dt>数据目录</dt><dd class="mono">${escapeHtml(paths.dataDir || '—')}</dd></div>
          </dl>
          <div class="button-row">
            <button class="btn btn-secondary btn-sm" type="button" data-action="view-config">${icon('code')} 查看配置</button>
            <button class="btn btn-ghost btn-sm" type="button" data-action="open-config">${icon('folder')} 定位配置</button>
            <button class="btn btn-ghost btn-sm" type="button" data-action="open-haproxy-dir">${icon('folder')} HAProxy 目录</button>
          </div>
        </section>

        <section class="panel settings-panel wide">
          <div class="about-head">
            <div>
              <h2>关于 PortPilot</h2>
              <p>PortPilot 是采用 GPL-2.0-only 许可证开源的 Windows TCP 转发管理工具。</p>
            </div>
            <span class="about-tag">HAProxy TCP 转发</span>
          </div>
          <div class="about-lines">
            <p><strong>PortPilot v${escapeHtml(appInfo.version || '1.0.0')}</strong></p>
            <p>规则可转发到任意 IPv4 地址，也可转发到本机另一块网卡的地址，请确认目标地址可信。</p>
            <p>应用退出时会自动停止 HAProxy；关闭窗口时默认仅最小化到系统托盘。</p>
            <p>首次监听网卡端口时，如 Windows 防火墙弹出提示，请允许 HAProxy 访问网络。</p>
          </div>
          <div class="about-links">
            <span>仓库</span>
            <button class="link-button" type="button" data-action="open-repository">https://github.com/miralexand/PortPilot</button>
            <span class="about-sep">·</span>
            <span>许可证 GPL-2.0-only</span>
          </div>
          <div class="button-row">
            <button class="btn btn-secondary btn-sm" type="button" data-action="check-updates" ${state.checkingUpdate ? 'disabled' : ''}>${icon('refresh', state.checkingUpdate ? 'is-spinning' : '')} ${state.checkingUpdate ? '正在检查…' : '检查更新'}</button>
            <button class="btn btn-ghost btn-sm" type="button" data-action="open-repository">${icon('code')} 打开仓库</button>
          </div>
          ${renderUpdateStatus()}
        </section>
      </div>
    `;
  }

  function renderUpdateStatus() {
    const status = state.updateStatus;
    if (!status) return '';

    const action = status.action === 'open-releases'
      ? '<button class="update-link" type="button" data-action="open-releases">前往下载</button>'
      : '';

    return `
      <div class="update-status update-status-${escapeHtml(status.type || 'info')}">
        <span>${escapeHtml(status.message || '')}</span>
        ${action}
      </div>
    `;
  }

  async function runUpdateCheck() {
    if (state.checkingUpdate) return;

    state.checkingUpdate = true;
    state.updateStatus = { type: 'info', message: '正在连接 GitHub 检查更新…' };
    renderSettings();

    try {
      const result = await api.checkForUpdates();
      if (!result || !result.ok) {
        state.updateStatus = { type: 'error', message: result?.error || '检查更新失败' };
      } else if (result.noRelease) {
        state.updateStatus = {
          type: 'info',
          message: `仓库尚未发布正式版本，当前为 v${result.currentVersion || '未知'}。`,
        };
      } else if (result.hasUpdate) {
        state.updateStatus = {
          type: 'success',
          message: `发现新版本 v${result.latestVersion}（当前 v${result.currentVersion}）。`,
          action: 'open-releases',
        };
      } else {
        state.updateStatus = {
          type: 'success',
          message: `当前已是最新版本 v${result.currentVersion}。`,
        };
      }
    } catch (error) {
      state.updateStatus = { type: 'error', message: error.message || '检查更新失败' };
    } finally {
      state.checkingUpdate = false;
      renderSettings();
    }
  }

  async function openExternalLink(action) {
    try {
      const result = await action();
      if (result && !result.ok) {
        toast(result.error || '无法打开链接', 'error');
      }
    } catch (error) {
      toast(error.message || '无法打开链接', 'error');
    }
  }

  function settingRow(key, title, description, checked) {
    return `
      <label class="setting-row">
        <span class="setting-copy">
          <strong>${escapeHtml(title)}</strong>
          <small>${escapeHtml(description)}</small>
        </span>
        <span class="switch switch-lg">
          <input type="checkbox" data-setting="${escapeHtml(key)}" ${checked ? 'checked' : ''} />
          <span></span>
        </span>
      </label>
    `;
  }

  async function runServiceAction(kind) {
    if (state.serviceBusy || !state.data) return;
    state.serviceBusy = true;
    renderServiceBanner();
    renderServiceMini();

    try {
      let result;
      let message;

      if (kind === 'start') {
        result = await api.startService();
        message = '转发服务已启动';
      } else if (kind === 'stop') {
        result = await api.stopService();
        message = '转发服务已停止';
      } else {
        result = await api.restartService();
        message = 'HAProxy 已重启';
      }

      if (result.state) applyState(result.state);

      if (!result.ok) {
        toast(result.error || '操作失败', 'error', 6000);
      } else {
        toast(message, 'success', 2600);
      }
    } catch (error) {
      toast(error.message || '操作失败', 'error', 6000);
      await refreshState(true);
    } finally {
      state.serviceBusy = false;
      if (state.data) {
        renderServiceBanner();
        renderServiceMini();
      }
    }
  }

  async function toggleRule(input) {
    const id = input.dataset.id;
    const enabled = input.checked;
    input.disabled = true;

    try {
      const result = await api.setRuleEnabled(id, enabled);
      if (!result.ok) {
        input.checked = !enabled;
        const error = result.errors ? Object.values(result.errors)[0] : result.error;
        toast(error || '无法更新规则', 'error', 6000);
        return;
      }

      applyState(result.state);
      if (result.restartError) {
        toast(`规则已保存，但应用失败：${result.restartError}`, 'error', 7000);
      } else {
        toast(enabled ? '规则已启用' : '规则已停用', 'success', 2200);
      }
    } catch (error) {
      input.checked = !enabled;
      toast(error.message || '无法更新规则', 'error', 6000);
    } finally {
      input.disabled = false;
    }
  }

  async function deleteRule(id) {
    const rule = ruleById(id);
    if (!rule) return;

    const confirmed = await confirmDialog({
      title: '删除转发规则',
      message: `确定删除「<strong>${escapeHtml(rule.name)}</strong>」吗？<br />本机 ${escapeHtml(rule.localIp)}:${escapeHtml(rule.localPort)} → ${escapeHtml(rule.targetIp)}:${escapeHtml(rule.targetPort)}`,
      confirmLabel: '删除规则',
    });

    if (!confirmed) return;

    try {
      const result = await api.deleteRule(id);
      if (!result.ok) {
        toast(result.error || '删除失败', 'error');
        return;
      }

      state.testResults.delete(id);
      applyState(result.state);
      if (result.restartError) {
        toast(`规则已删除，但 HAProxy 应用失败：${result.restartError}`, 'error', 7000);
      } else {
        toast('规则已删除', 'success', 2400);
      }
    } catch (error) {
      toast(error.message || '删除失败', 'error');
    }
  }

  async function testRule(id) {
    state.testResults.set(id, { loading: true });
    renderRules();

    try {
      const result = await api.testRule(id);
      if (!result.ok) {
        state.testResults.set(id, { error: result.error || '测试失败' });
      } else {
        state.testResults.set(id, result);
      }
    } catch (error) {
      state.testResults.set(id, { error: error.message || '测试失败' });
    }

    renderRules();
  }

  async function refreshInterfaces() {
    try {
      const interfaces = await api.getInterfaces();
      state.data.interfaces = interfaces;
      renderAll();
      toast('网卡列表已刷新', 'success', 2000);
    } catch (error) {
      toast(error.message || '刷新网卡失败', 'error');
    }
  }

  async function refreshInterfacesInModal() {
    const draft = readRuleForm();
    if (!draft) return;

    try {
      state.data.interfaces = await api.getInterfaces();
      openRuleModal(draft);
      toast('网卡列表已刷新', 'success', 2000);
    } catch (error) {
      toast(error.message || '刷新网卡失败', 'error');
    }
  }

  async function updateSetting(input) {
    const key = input.dataset.setting;
    const value = input.checked;
    input.disabled = true;

    try {
      const result = await api.updateSettings({ [key]: value });
      if (!result.ok) {
        input.checked = !value;
        toast(result.error || '设置保存失败', 'error');
        return;
      }

      applyState(result.state);
      toast('设置已保存', 'success', 1800);
    } catch (error) {
      input.checked = !value;
      toast(error.message || '设置保存失败', 'error');
    } finally {
      input.disabled = false;
    }
  }

  function openRuleModal(rule) {
    const draft = rule ? { ...rule } : { enabled: true };
    const isEdit = Boolean(draft.id);
    const interfaces = state.data?.interfaces || [];
    const preferred = interfaces.find((item) => !item.internal) || interfaces[0];
    const selected = draft.localIp || (preferred ? preferred.address : '');
    const selectedExists = interfaces.some((item) => item.address === selected);

    const options = interfaces
      .map(
        (item) =>
          `<option value="${escapeHtml(item.address)}" ${item.address === selected ? 'selected' : ''}>${escapeHtml(item.name)} — ${escapeHtml(item.address)}${item.internal ? '（Loopback）' : ''}</option>`
      )
      .join('');

    const missingOption =
      selected && !selectedExists
        ? `<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)}（当前不可用）</option>`
        : '';

    const enabled = draft.enabled !== false;
    const targetMode = draft.targetMode === 'localNic' ? 'localNic' : 'remote';
    const localPort = draft.localPort || '';
    const targetPort = draft.targetPort || '';

    openModal(
      `
        <div class="modal-header">
          <div>
            <p class="eyebrow">${isEdit ? 'EDIT RULE' : 'NEW RULE'}</p>
            <h2>${isEdit ? '编辑转发规则' : '添加转发规则'}</h2>
            <p>其他人通过源网卡地址和端口访问，由 HAProxy 转发到目标。</p>
          </div>
          <button class="icon-btn" type="button" data-action="close-modal" aria-label="关闭">${icon('x')}</button>
        </div>
        <form id="ruleForm" novalidate>
          <input type="hidden" name="id" value="${escapeHtml(draft.id || '')}" />
          <input type="hidden" name="targetMode" value="${targetMode}" />
          <div class="modal-body">
            <div class="form-grid">
              <div class="form-field full" data-field="name">
                <label for="ruleName">规则名称</label>
                <input id="ruleName" name="name" type="text" maxlength="80" placeholder="例如：数据库调试通道" value="${escapeHtml(draft.name || '')}" />
                <p class="field-hint">可选，留空会根据地址自动生成。</p>
                <p class="field-error" data-error="name"></p>
              </div>

              <div class="form-field full" data-field="localIp">
                <label for="ruleLocalIp">源网卡</label>
                <div class="select-with-action">
                  <select id="ruleLocalIp" name="localIp">
                    <option value="">请选择本机网卡地址</option>
                    ${options}
                    ${missingOption}
                  </select>
                  <button class="btn btn-ghost btn-sm" type="button" data-action="refresh-interfaces-in-modal">${icon('refresh')} 刷新</button>
                </div>
                <p class="field-hint">选择对外提供访问的本机网卡地址。</p>
                <p class="field-error" data-error="localIp"></p>
              </div>

              <div class="form-field" data-field="localPort">
                <label for="ruleLocalPort">监听端口</label>
                <input id="ruleLocalPort" name="localPort" type="number" min="1" max="65535" inputmode="numeric" placeholder="8080" value="${escapeHtml(localPort)}" />
                <p class="field-error" data-error="localPort"></p>
              </div>

              <div class="form-field switch-field" data-field="enabled">
                <span class="switch-field-label">
                  <strong>启用规则</strong>
                  <small>保存后立即生效</small>
                </span>
                <label class="switch">
                  <input type="checkbox" name="enabled" ${enabled ? 'checked' : ''} />
                  <span></span>
                </label>
              </div>

              <div class="form-field full" data-field="targetMode">
                <label>目标类型</label>
                <div class="segmented" role="group" aria-label="目标类型">
                  <button class="${targetMode === 'remote' ? 'is-active' : ''}" type="button" data-target-mode="remote">远程地址</button>
                  <button class="${targetMode === 'localNic' ? 'is-active' : ''}" type="button" data-target-mode="localNic">本机另一网卡</button>
                </div>
                <p class="field-hint">远程地址通过路由到达目标；本机另一网卡用于两块网卡之间的本机转发。</p>
              </div>

              <div class="form-field ${targetMode === 'localNic' ? 'is-hidden' : ''}" data-field="targetIp">
                <label for="ruleTargetIp">目标地址</label>
                <input id="ruleTargetIp" class="mono" name="targetIp" type="text" inputmode="decimal" placeholder="10.10.20.30" value="${targetMode === 'remote' ? escapeHtml(draft.targetIp || '') : ''}" />
                <p class="field-hint">请输入目标服务器的 IPv4 地址。</p>
                <p class="field-error" data-error="targetIp"></p>
              </div>

              <div class="form-field ${targetMode === 'localNic' ? '' : 'is-hidden'}" data-field="targetLocalIp">
                <label for="ruleTargetLocalIp">目标网卡</label>
                <select id="ruleTargetLocalIp" name="targetLocalIp">
                  <option value="">请选择另一块网卡</option>
                </select>
                <p class="field-hint">选择与源网卡不同的本机 IPv4 地址。</p>
                <p class="field-error" data-error="targetIp"></p>
              </div>

              <div class="form-field" data-field="targetPort">
                <label for="ruleTargetPort">目标端口</label>
                <input id="ruleTargetPort" name="targetPort" type="number" min="1" max="65535" inputmode="numeric" placeholder="3306" value="${escapeHtml(targetPort)}" />
                <p class="field-error" data-error="targetPort"></p>
              </div>

              <div class="form-field full">
                <div class="route-preview" id="routePreview">
                  <span class="preview-side">
                    <span class="preview-label">本机</span>
                    <span class="preview-value" id="previewLocal">等待填写</span>
                  </span>
                  <span class="preview-arrow">${icon('arrowRight')}</span>
                  <span class="preview-side">
                    <span class="preview-label" id="previewTargetLabel">${targetMode === 'localNic' ? '本机另一网卡' : '远程地址'}</span>
                    <span class="preview-value" id="previewTarget">等待填写</span>
                  </span>
                </div>
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-ghost" type="button" data-action="close-modal">取消</button>
            <button class="btn btn-primary" type="submit" id="ruleSaveBtn">${isEdit ? '保存修改' : '创建规则'}</button>
          </div>
        </form>
      `,
      { focus: 'input[name="name"]' }
    );

    const form = document.getElementById('ruleForm');
    form.addEventListener('input', (event) => {
      updateRulePreview();
      clearFieldError(event.target.name);
    });
    form.addEventListener('change', (event) => {
      if (event.target.name === 'localIp') {
        updateTargetLocalOptions(form);
        clearFieldError('targetIp');
      }
      updateRulePreview();
      clearFieldError(event.target.name);
    });
    form.addEventListener('click', (event) => {
      const modeButton = event.target.closest('[data-target-mode]');
      if (!modeButton) return;
      setTargetMode(modeButton.dataset.targetMode);
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      submitRuleForm();
    });

    updateTargetLocalOptions(form, targetMode === 'localNic' ? draft.targetIp : '');
    setTargetMode(targetMode);
  }

  function updateTargetLocalOptions(form, preset) {
    const select = form.elements.targetLocalIp;
    const current = preset === undefined ? select.value : preset;
    const interfaces = state.data?.interfaces || [];
    const source = interfaces.find((item) => item.address === form.elements.localIp.value);
    const candidates = interfaces.filter((item) => !source || item.name !== source.name);
    const currentExists = interfaces.some((item) => item.address === current);
    const currentIsCandidate = candidates.some((item) => item.address === current);
    let selected = '';

    if (current && currentIsCandidate) {
      selected = current;
    } else if (current && !currentExists) {
      selected = current;
    }

    const options = ['<option value="">请选择另一块网卡</option>'];

    for (const item of candidates) {
      const label = `${item.name} — ${item.address}${item.internal ? '（Loopback）' : ''}`;
      options.push(
        `<option value="${escapeHtml(item.address)}" ${item.address === selected ? 'selected' : ''}>${escapeHtml(label)}</option>`
      );
    }

    if (selected && !currentIsCandidate) {
      options.push(
        `<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)}（当前不可用）</option>`
      );
    }

    select.innerHTML = options.join('');
    select.value = selected;
  }

  function setTargetMode(mode) {
    const form = document.getElementById('ruleForm');
    if (!form) return;

    const nextMode = mode === 'localNic' ? 'localNic' : 'remote';
    form.elements.targetMode.value = nextMode;

    form.querySelectorAll('[data-target-mode]').forEach((button) => {
      button.classList.toggle('is-active', button.dataset.targetMode === nextMode);
    });

    form.querySelector('[data-field="targetIp"]').classList.toggle('is-hidden', nextMode !== 'remote');
    form.querySelector('[data-field="targetLocalIp"]').classList.toggle('is-hidden', nextMode !== 'localNic');

    if (nextMode === 'localNic' && !form.elements.targetLocalIp.value) {
      const firstCandidate = Array.from(form.elements.targetLocalIp.options).find((option) => option.value);
      if (firstCandidate) form.elements.targetLocalIp.value = firstCandidate.value;
    }

    clearFieldError('targetIp');
    updateRulePreview();
  }

  function readRuleForm() {
    const form = document.getElementById('ruleForm');
    if (!form) return null;

    const id = form.elements.id.value.trim();
    const targetMode = form.elements.targetMode.value === 'localNic' ? 'localNic' : 'remote';
    const targetIp =
      targetMode === 'localNic'
        ? form.elements.targetLocalIp.value.trim()
        : form.elements.targetIp.value.trim();

    return {
      id: id || undefined,
      name: form.elements.name.value.trim(),
      localIp: form.elements.localIp.value,
      localPort: form.elements.localPort.value.trim(),
      targetMode,
      targetIp,
      targetPort: form.elements.targetPort.value.trim(),
      enabled: form.elements.enabled.checked,
    };
  }

  function updateRulePreview() {
    const form = document.getElementById('ruleForm');
    if (!form) return;

    const targetMode = form.elements.targetMode.value === 'localNic' ? 'localNic' : 'remote';
    const localIp = form.elements.localIp.value || '本机地址';
    const localPort = form.elements.localPort.value.trim() || '端口';
    const targetIp =
      (targetMode === 'localNic'
        ? form.elements.targetLocalIp.value
        : form.elements.targetIp.value.trim()) || (targetMode === 'localNic' ? '目标网卡' : '目标地址');
    const targetPort = form.elements.targetPort.value.trim() || '端口';

    const localNode = document.getElementById('previewLocal');
    const targetNode = document.getElementById('previewTarget');
    const targetLabel = document.getElementById('previewTargetLabel');
    if (localNode) localNode.textContent = `${localIp}:${localPort}`;
    if (targetNode) targetNode.textContent = `${targetIp}:${targetPort}`;
    if (targetLabel) {
      targetLabel.textContent = targetMode === 'localNic' ? '本机另一网卡' : '远程地址';
    }
  }

  function clearFormErrors() {
    document.querySelectorAll('#ruleForm .form-field.has-error').forEach((field) => {
      field.classList.remove('has-error');
    });
    document.querySelectorAll('#ruleForm [data-error]').forEach((node) => {
      node.textContent = '';
    });
  }

  function clearFieldError(name) {
    if (!name) return;
    const names =
      name === 'targetIp' || name === 'targetLocalIp' ? ['targetIp', 'targetLocalIp'] : [name];

    for (const fieldName of names) {
      const field = document.querySelector(`#ruleForm [data-field="${fieldName}"]`);
      if (!field) continue;
      field.classList.remove('has-error');
      field.querySelectorAll('[data-error]').forEach((node) => {
        node.textContent = '';
      });
    }
  }

  function showFormErrors(errors) {
    clearFormErrors();
    const form = document.getElementById('ruleForm');
    let firstField = null;

    for (const [key, message] of Object.entries(errors || {})) {
      let fieldName = key;
      if (key === 'targetIp' && form && form.elements.targetMode.value === 'localNic') {
        fieldName = 'targetLocalIp';
      }

      const field = document.querySelector(`#ruleForm [data-field="${fieldName}"]`);
      if (!field) continue;
      field.classList.add('has-error');
      const errorNode = field.querySelector(`[data-error="${key}"]`) || field.querySelector('[data-error]');
      if (errorNode) errorNode.textContent = message;
      if (!firstField) firstField = field.querySelector('input, select');
    }

    if (firstField) firstField.focus();
  }

  async function submitRuleForm() {
    const draft = readRuleForm();
    if (!draft) return;

    const button = document.getElementById('ruleSaveBtn');
    const isEdit = Boolean(draft.id);
    button.disabled = true;
    button.textContent = '保存中…';

    try {
      const result = await api.saveRule(draft);
      if (!result.ok) {
        showFormErrors(result.errors);
        toast('请检查表单中的错误', 'error');
        return;
      }

      if (result.rule) state.testResults.delete(result.rule.id);
      closeModal();
      applyState(result.state);
      toast(isEdit ? '规则已更新' : '规则已创建', 'success', 2600);

      if (result.restartError) {
        toast(`规则已保存，但 HAProxy 应用失败：${result.restartError}`, 'error', 7000);
      }
    } catch (error) {
      toast(error.message || '保存失败', 'error');
    } finally {
      if (button.isConnected) {
        button.disabled = false;
        button.textContent = isEdit ? '保存修改' : '创建规则';
      }
    }
  }

  function openModal(content, options = {}) {
    const modalRoot = document.getElementById('modalRoot');
    const wide = options.wide ? ' modal-wide' : '';
    modalRoot.innerHTML = `
      <div class="modal-layer">
        <div class="modal-backdrop" data-action="close-modal"></div>
        <div class="modal-card${wide}" role="dialog" aria-modal="true" tabindex="-1">
          ${content}
        </div>
      </div>
    `;
    document.body.classList.add('modal-open');

    setTimeout(() => {
      const focusTarget = modalRoot.querySelector(options.focus || '.modal-card');
      if (focusTarget) focusTarget.focus();
    }, 30);
  }

  function closeModal() {
    const resolver = state.confirmResolver;
    state.confirmResolver = null;

    const modalRoot = document.getElementById('modalRoot');
    if (modalRoot) modalRoot.innerHTML = '';
    document.body.classList.remove('modal-open');

    if (resolver) resolver(false);
  }

  function confirmDialog(options) {
    return new Promise((resolve) => {
      state.confirmResolver = resolve;
      openModal(
        `
          <div class="modal-header">
            <div>
              <p class="eyebrow">CONFIRM</p>
              <h2>${escapeHtml(options.title || '确认操作')}</h2>
            </div>
            <button class="icon-btn" type="button" data-action="close-modal" aria-label="关闭">${icon('x')}</button>
          </div>
          <div class="modal-body">
            <p class="confirm-message">${options.message || ''}</p>
          </div>
          <div class="modal-footer">
            <button class="btn btn-ghost" type="button" data-action="confirm-cancel">取消</button>
            <button class="btn btn-danger" type="button" data-action="confirm-accept">${escapeHtml(options.confirmLabel || '确认')}</button>
          </div>
        `,
        { focus: '[data-action="confirm-accept"]' }
      );
    });
  }

  async function openConfigModal() {
    try {
      const result = await api.getConfig();
      state.lastConfigText = result.text;
      state.lastConfigPath = result.path;

      openModal(
        `
          <div class="modal-header">
            <div>
              <p class="eyebrow">HAPROXY CONFIG</p>
              <h2>当前生成的配置</h2>
              <p>每次启动或应用规则时，PortPilot 都会重新生成此文件。</p>
            </div>
            <button class="icon-btn" type="button" data-action="close-modal" aria-label="关闭">${icon('x')}</button>
          </div>
          <div class="modal-body">
            <div class="path-line">${escapeHtml(result.path)}</div>
            <pre class="code-block">${escapeHtml(result.text)}</pre>
          </div>
          <div class="modal-footer">
            <button class="btn btn-ghost" type="button" data-action="open-config">${icon('folder')} 定位文件</button>
            <button class="btn btn-secondary" type="button" data-action="copy-config">${icon('copy')} 复制配置</button>
            <button class="btn btn-primary" type="button" data-action="close-modal">关闭</button>
          </div>
        `,
        { wide: true, focus: '[data-action="copy-config"]' }
      );
    } catch (error) {
      toast(error.message || '读取配置失败', 'error');
    }
  }

  async function copyConfig() {
    if (!state.lastConfigText) return;
    try {
      await api.copyText(state.lastConfigText);
      toast('HAProxy 配置已复制', 'success', 2000);
    } catch (error) {
      toast(error.message || '复制失败', 'error');
    }
  }

  async function openPath(action) {
    try {
      const result = await action();
      if (result && !result.ok) {
        toast(result.error || '无法打开目录', 'error');
      }
    } catch (error) {
      toast(error.message || '无法打开目录', 'error');
    }
  }

  function renderLogs() {
    const logView = document.getElementById('logView');
    const countNode = document.getElementById('logCount');
    if (!logView) return;

    if (state.logs.length === 0) {
      logView.innerHTML = '<div class="log-empty">暂无日志。启动转发服务后，这里会显示 HAProxy 的运行输出。</div>';
    } else {
      logView.innerHTML = state.logs.map(logLineMarkup).join('');
    }

    if (countNode) countNode.textContent = `${state.logs.length} 条日志`;
    if (state.logAutoScroll) scrollLogsToBottom();
  }

  function appendLog(entry) {
    state.logs.push(entry);
    if (state.logs.length > 1000) state.logs.shift();

    const logView = document.getElementById('logView');
    const countNode = document.getElementById('logCount');
    if (!logView) return;

    const empty = logView.querySelector('.log-empty');
    if (empty) empty.remove();

    logView.insertAdjacentHTML('beforeend', logLineMarkup(entry));
    while (logView.children.length > 1000) {
      logView.firstElementChild.remove();
    }

    if (countNode) countNode.textContent = `${state.logs.length} 条日志`;
    if (state.logAutoScroll) scrollLogsToBottom();
  }

  function logLineMarkup(entry) {
    const level = entry.level || 'info';
    const badge = level === 'error' ? 'ERR' : level === 'warn' ? 'WARN' : 'INFO';
    return `
      <div class="log-line log-level-${escapeHtml(level)}">
        <span class="log-time">${formatClock(entry.ts)}</span>
        <span class="log-badge">${badge}</span>
        <span class="log-source">${escapeHtml(entry.source || 'app')}</span>
        <span class="log-message">${escapeHtml(entry.message || '')}</span>
      </div>
    `;
  }

  function scrollLogsToBottom() {
    const logView = document.getElementById('logView');
    if (logView) logView.scrollTop = logView.scrollHeight;
  }

  async function clearLogs() {
    try {
      await api.clearLogs();
      state.logs = [];
      renderLogs();
      toast('日志已清空', 'success', 2000);
    } catch (error) {
      toast(error.message || '清空日志失败', 'error');
    }
  }

  function tick() {
    const uptime = currentUptime();
    document.querySelectorAll('[data-uptime]').forEach((node) => {
      node.textContent = formatDuration(uptime);
    });
  }

  function toast(message, type = 'info', duration = 4200) {
    const root = document.getElementById('toastRoot');
    if (!root) return;

    const iconName = type === 'success' ? 'check' : type === 'error' ? 'alert' : type === 'warning' ? 'alert' : 'info';
    const element = document.createElement('div');
    element.className = `toast toast-${type}`;
    element.innerHTML = `
      <span class="toast-icon">${icon(iconName)}</span>
      <div class="toast-copy"></div>
      <button class="toast-close" type="button" aria-label="关闭通知">${icon('x')}</button>
    `;
    element.querySelector('.toast-copy').textContent = message;

    const dismiss = () => {
      if (element.classList.contains('is-leaving')) return;
      element.classList.add('is-leaving');
      setTimeout(() => element.remove(), 220);
    };

    element.querySelector('.toast-close').addEventListener('click', dismiss);
    root.appendChild(element);

    requestAnimationFrame(() => element.classList.add('is-visible'));
    if (duration > 0) setTimeout(dismiss, duration);
  }

  function hideLoading() {
    const loading = document.getElementById('appLoading');
    if (!loading) return;
    loading.classList.add('is-hidden');
    setTimeout(() => {
      if (loading.parentNode) loading.remove();
    }, 350);
  }

  function showLoadingError(message) {
    const loading = document.getElementById('appLoading');
    if (!loading) return;
    loading.innerHTML = `
      <div class="status-orb"><span class="status-dot bad"></span></div>
      <div>
        <strong>启动失败</strong>
        <span data-loading-error></span>
      </div>
    `;
    loading.querySelector('[data-loading-error]').textContent = message;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
