'use strict';

const { Menu, Tray, nativeImage } = require('electron');

const STATE_LABELS = {
  stopped: '已停止',
  starting: '正在启动',
  running: '运行中',
  restarting: '正在重启',
  error: '运行异常',
};

function createTray(options) {
  const { manager, store, iconPath, showWindow, quitApp } = options;

  const image = nativeImage.createFromPath(iconPath);
  const tray = new Tray(image.isEmpty() ? nativeImage.createFromPath(options.fallbackIconPath) : image);
  let noticeShown = false;

  function activeCount() {
    return store.getRules().filter((rule) => rule.enabled).length;
  }

  function refresh() {
    const status = manager.getStatus();
    const label = STATE_LABELS[status.state] || status.state;
    const count = status.state === 'running' ? status.activeRules : activeCount();
    const summary = `${label} · ${count} 条规则`;

    tray.setToolTip(`PortPilot · ${summary}`);

    const running = status.state === 'running';
    const transitioning = status.state === 'starting' || status.state === 'restarting';
    const enabledRules = activeCount();

    const menu = Menu.buildFromTemplate([
      { label: 'PortPilot', enabled: false },
      { label: `状态：${label}`, enabled: false },
      { label: `已启用规则：${enabledRules}`, enabled: false },
      { type: 'separator' },
      { label: '打开控制台', click: () => showWindow() },
      {
        label: running ? '停止转发' : transitioning ? '启动中…' : '启动转发',
        enabled: !transitioning && (running || enabledRules > 0),
        click: async () => {
          try {
            if (running) {
              await manager.stop();
            } else {
              await manager.start(store.getRules());
            }
          } catch (error) {
            if (store.getSettings().showNotifications) {
              tray.displayBalloon({
                title: 'PortPilot',
                content: error.message,
                iconType: 'error',
              });
            }
          }
          refresh();
        },
      },
      {
        label: '重启 HAProxy',
        enabled: running,
        click: async () => {
          try {
            await manager.restart(store.getRules());
          } catch (error) {
            if (store.getSettings().showNotifications) {
              tray.displayBalloon({
                title: 'PortPilot',
                content: error.message,
                iconType: 'error',
              });
            }
          }
          refresh();
        },
      },
      { type: 'separator' },
      { label: '退出 PortPilot', click: () => quitApp() },
    ]);

    tray.setContextMenu(menu);
  }

  function showTrayNotice() {
    if (noticeShown) return;
    noticeShown = true;
    if (!store.getSettings().showNotifications) return;
    try {
      tray.displayBalloon({
        title: 'PortPilot 仍在运行',
        content: '窗口已最小化到系统托盘，转发服务不受影响。',
        iconType: 'info',
      });
    } catch {
      return;
    }
  }

  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());

  refresh();

  return {
    tray,
    refresh,
    showTrayNotice,
    destroy() {
      tray.destroy();
    },
  };
}

module.exports = { createTray };
