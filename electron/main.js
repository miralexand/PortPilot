'use strict';

const path = require('node:path');
const { app, BrowserWindow, Menu, dialog, nativeImage, nativeTheme } = require('electron');

const { Store } = require('./lib/store');
const { HaproxyManager } = require('./lib/haproxy');
const { listInterfaces } = require('./lib/network');
const { registerIpcHandlers } = require('./ipc');
const { createTray } = require('./tray');

const APP_ID = 'com.portpilot.desktop';
const isDev = process.argv.includes('--dev');

app.setName('PortPilot');
app.setAppUserModelId(APP_ID);
nativeTheme.themeSource = 'light';

if (process.env.PORTPILOT_DATA_DIR) {
  app.setPath('userData', path.resolve(process.env.PORTPILOT_DATA_DIR));
}

let mainWindow = null;
let trayController = null;
let store = null;
let manager = null;
let isQuitting = false;
let quitInProgress = false;
let applyPromise = Promise.resolve();

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (app.isReady()) showWindow();
    else app.whenReady().then(showWindow);
  });

  app.whenReady().then(initialize).catch((error) => {
    dialog.showErrorBox('PortPilot 启动失败', error.stack || error.message);
    app.exit(1);
  });
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }

  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function quitApp() {
  isQuitting = true;
  app.quit();
}

function buildState() {
  return {
    app: {
      version: app.getVersion(),
      name: app.getName(),
      platform: process.platform,
      isPackaged: app.isPackaged,
    },
    rules: store.getRules(),
    settings: store.getSettings(),
    interfaces: listInterfaces(),
    service: manager.getStatus(),
    haproxy: manager.getRuntimeInfo(),
    paths: {
      dataDir: app.getPath('userData'),
      configPath: manager.configPath,
      haproxyPath: manager.executablePath,
      haproxyDir: manager.runtimeDir,
    },
  };
}

function broadcastState() {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('state:changed', buildState());
  }
  if (trayController) trayController.refresh();
}

function applyRules() {
  const run = applyPromise.then(async () => {
    if (manager.getStatus().state === 'running') {
      await manager.restart(store.getRules());
    }
    broadcastState();
  });

  applyPromise = run.catch(() => {});
  return run;
}

function syncLoginItem(enabled) {
  if (process.platform !== 'win32') return;
  if (process.env.PORTPILOT_DISABLE_LOGIN_ITEM === '1') return;

  const options = { openAtLogin: Boolean(enabled) };
  if (app.isPackaged) {
    options.path = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  } else {
    options.path = process.execPath;
    options.args = [app.getAppPath()];
  }

  try {
    app.setLoginItemSettings(options);
  } catch (error) {
    if (manager) manager.log('warn', `无法更新开机启动设置：${error.message}`, 'app');
  }
}

function createWindow() {
  const root = app.getAppPath();
  const iconPath = path.join(root, 'assets', 'icon.png');

  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 980,
    minHeight: 640,
    show: false,
    title: 'PortPilot',
    backgroundColor: '#f4f3ef',
    autoHideMenuBar: true,
    icon: nativeImage.createFromPath(iconPath),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(root, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  mainWindow.on('close', (event) => {
    if (isQuitting) return;

    if (store.getSettings().closeToTray) {
      event.preventDefault();
      mainWindow.hide();
      if (trayController) trayController.showTrayNotice();
      return;
    }

    isQuitting = true;
    app.quit();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
}

function buildApplicationMenu() {
  const viewMenu = [
    { role: 'reload', label: '重新加载' },
    { role: 'forceReload', label: '强制重新加载' },
  ];

  if (isDev) {
    viewMenu.push({ type: 'separator' });
    viewMenu.push({ role: 'toggleDevTools', label: '开发者工具' });
  }

  const template = [
    {
      label: '文件',
      submenu: [{ role: 'quit', label: '退出 PortPilot' }],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        ...viewMenu,
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'close', label: '关闭窗口' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function initialize() {
  app.setAppUserModelId(APP_ID);

  const dataDir = app.getPath('userData');
  const root = app.getAppPath();
  const haproxyPath = app.isPackaged
    ? path.join(process.resourcesPath, 'haproxy', 'haproxy.exe')
    : path.join(root, 'resources', 'haproxy', 'haproxy.exe');

  store = new Store(dataDir);
  manager = new HaproxyManager({ executablePath: haproxyPath, dataDir });
  manager.detectVersion();

  manager.on('status', () => {
    broadcastState();
  });

  manager.on('log', (entry) => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('log:appended', entry);
    }
  });

  registerIpcHandlers({
    ipcMain: require('electron').ipcMain,
    app,
    dataDir,
    store,
    manager,
    buildState,
    broadcastState,
    applyRules,
    quitApp,
    syncLoginItem,
  });

  buildApplicationMenu();
  createWindow();

  trayController = createTray({
    manager,
    store,
    iconPath: path.join(root, 'assets', 'tray.png'),
    fallbackIconPath: path.join(root, 'assets', 'icon.png'),
    showWindow,
    quitApp,
  });

  syncLoginItem(store.getSettings().launchAtLogin);

  const settings = store.getSettings();
  const rules = store.getRules();
  if (settings.autoStartService && rules.some((rule) => rule.enabled)) {
    manager.start(rules).catch((error) => {
      manager.log('error', `自动启动失败：${error.message}`, 'service');
    });
  }
}

app.on('window-all-closed', () => {
  if (isQuitting) app.quit();
});

app.on('activate', () => {
  showWindow();
});

app.on('before-quit', (event) => {
  if (quitInProgress) {
    event.preventDefault();
    return;
  }
  event.preventDefault();
  quitInProgress = true;
  isQuitting = true;

  const stopTask = manager ? manager.stop() : Promise.resolve();

  Promise.resolve(stopTask)
    .catch(() => {})
    .finally(() => {
      if (trayController) {
        trayController.destroy();
        trayController = null;
      }
      app.exit(0);
    });
});
