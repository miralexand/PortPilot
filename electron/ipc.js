'use strict';

const fs = require('node:fs');
const { clipboard, net, shell } = require('electron');

const { generateConfig } = require('./lib/config');
const { listInterfaces, probeTcp } = require('./lib/network');
const { validateRule } = require('./lib/rules');
const { checkForUpdates, REPOSITORY_URL, RELEASES_URL } = require('./lib/updates');

async function openExternalUrl(url, fallbackMessage) {
  try {
    await shell.openExternal(url);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message || fallbackMessage };
  }
}

function registerIpcHandlers(context) {
  const {
    ipcMain,
    app,
    dataDir,
    store,
    manager,
    buildState,
    broadcastState,
    applyRules,
    quitApp,
    syncLoginItem,
  } = context;

  ipcMain.handle('app:get-state', () => ({
    ...buildState(),
    logs: manager.getLogs(),
  }));

  ipcMain.handle('network:get-interfaces', () => listInterfaces());

  ipcMain.handle('rules:save', async (_event, draft) => {
    const rules = store.getRules();
    const validation = validateRule(draft, { rules, interfaces: listInterfaces() });

    if (!validation.ok) {
      return { ok: false, errors: validation.errors, state: buildState() };
    }

    const saved = store.upsertRule(validation.rule);
    broadcastState();

    let restartError = null;
    if (manager.getStatus().state === 'running') {
      try {
        await applyRules();
      } catch (error) {
        restartError = error.message;
      }
    }

    return {
      ok: true,
      rule: saved,
      state: buildState(),
      restartError,
    };
  });

  ipcMain.handle('rules:delete', async (_event, id) => {
    const rule = store.getRule(String(id || ''));
    if (!rule) {
      return { ok: false, error: '规则不存在或已被删除', state: buildState() };
    }

    store.deleteRule(rule.id);
    broadcastState();

    let restartError = null;
    if (manager.getStatus().state === 'running') {
      try {
        await applyRules();
      } catch (error) {
        restartError = error.message;
      }
    }

    return { ok: true, state: buildState(), restartError };
  });

  ipcMain.handle('rules:set-enabled', async (_event, id, enabled) => {
    const rule = store.getRule(String(id || ''));
    if (!rule) {
      return { ok: false, error: '规则不存在或已被删除', state: buildState() };
    }

    const draft = { ...rule, enabled: Boolean(enabled) };
    const validation = validateRule(draft, {
      rules: store.getRules(),
      interfaces: listInterfaces(),
    });

    if (!validation.ok) {
      return { ok: false, errors: validation.errors, state: buildState() };
    }

    const saved = store.upsertRule(validation.rule);
    broadcastState();

    let restartError = null;
    if (manager.getStatus().state === 'running') {
      try {
        await applyRules();
      } catch (error) {
        restartError = error.message;
      }
    }

    return { ok: true, rule: saved, state: buildState(), restartError };
  });

  ipcMain.handle('service:start', async () => {
    try {
      const result = await manager.start(store.getRules());
      broadcastState();
      if (result && result.started === false) {
        return { ok: false, error: '没有启用的转发规则', state: buildState() };
      }
      return { ok: true, state: buildState() };
    } catch (error) {
      broadcastState();
      return { ok: false, error: error.message, state: buildState() };
    }
  });

  ipcMain.handle('service:stop', async () => {
    try {
      await manager.stop();
      broadcastState();
      return { ok: true, state: buildState() };
    } catch (error) {
      broadcastState();
      return { ok: false, error: error.message, state: buildState() };
    }
  });

  ipcMain.handle('service:restart', async () => {
    try {
      const result = await manager.restart(store.getRules());
      broadcastState();
      if (result && result.started === false) {
        return { ok: false, error: '没有启用的转发规则', state: buildState() };
      }
      return { ok: true, state: buildState() };
    } catch (error) {
      broadcastState();
      return { ok: false, error: error.message, state: buildState() };
    }
  });

  ipcMain.handle('service:test-rule', async (_event, id) => {
    const rule = store.getRule(String(id || ''));
    if (!rule) {
      return { ok: false, error: '规则不存在或已被删除' };
    }

    const [frontend, target] = await Promise.all([
      probeTcp(rule.localIp, Number(rule.localPort), 2500),
      probeTcp(rule.targetIp, Number(rule.targetPort), 3000),
    ]);

    return { ok: true, frontend, target };
  });

  ipcMain.handle('logs:get', () => manager.getLogs());

  ipcMain.handle('logs:clear', () => {
    manager.clearLogs();
    return { ok: true };
  });

  ipcMain.handle('settings:update', (_event, patch) => {
    const settings = store.updateSettings(patch);
    if (syncLoginItem) syncLoginItem(settings.launchAtLogin);
    broadcastState();
    return { ok: true, settings, state: buildState() };
  });

  ipcMain.handle('config:get', () => ({
    text: generateConfig(store.getRules(), { includeTimestamp: true }),
    path: manager.configPath,
  }));

  ipcMain.handle('app:copy-text', (_event, text) => {
    clipboard.writeText(String(text || ''));
    return { ok: true };
  });

  ipcMain.handle('app:open-data-dir', async () => {
    const error = await shell.openPath(dataDir);
    return { ok: !error, error: error || null };
  });

  ipcMain.handle('app:show-config-file', async () => {
    if (fs.existsSync(manager.configPath)) {
      shell.showItemInFolder(manager.configPath);
      return { ok: true };
    }

    const error = await shell.openPath(dataDir);
    return { ok: !error, error: error || null };
  });

  ipcMain.handle('app:open-haproxy-dir', async () => {
    const error = await shell.openPath(manager.runtimeDir);
    return { ok: !error, error: error || null };
  });

  ipcMain.handle('app:check-updates', () =>
    checkForUpdates({
      currentVersion: app.getVersion(),
      fetchImpl: (url, options) => net.fetch(url, options),
    })
  );

  ipcMain.handle('app:open-repository', () =>
    openExternalUrl(REPOSITORY_URL, '无法打开仓库地址')
  );

  ipcMain.handle('app:open-releases', () =>
    openExternalUrl(RELEASES_URL, '无法打开下载页面')
  );

  ipcMain.handle('app:quit', () => {
    quitApp();
    return { ok: true };
  });

  ipcMain.handle('app:get-version', () => app.getVersion());
}

module.exports = { registerIpcHandlers };
