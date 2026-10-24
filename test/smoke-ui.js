'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const packagedExe = process.env.PORTPILOT_EXE || '';
const electronExe = packagedExe || path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');

let appStdout = '';
let appStderr = '';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reservePort(host) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.once('error', reject);
    request.setTimeout(1500, () => request.destroy(new Error('HTTP timeout')));
  });
}

async function waitForDevTools(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      await delay(200);
    }
  }
  throw new Error('等待 Electron DevTools 调试端口超时');
}

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 0;
    this.pending = new Map();
    this.handlers = new Map();

    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }

      const handler = this.handlers.get(message.method);
      if (handler) handler(message.params);
    });
  }

  open() {
    return new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), {
        once: true,
      });
    });
  }

  on(method, handler) {
    this.handlers.set(method, handler);
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 命令超时：${method}`));
      }, 30000);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      this.socket.send(payload);
    });
  }

  close() {
    try {
      this.socket.close();
    } catch {
      return;
    }
  }
}

async function main() {
  assert.ok(fs.existsSync(electronExe), '未找到 Electron 可执行文件');

  const userDataDir = path.join(__dirname, '.tmp', `ui-${Date.now()}`);
  fs.mkdirSync(userDataDir, { recursive: true });

  const initialPort = await reservePort('127.0.0.1');
  const launchArgs = [
    `--remote-debugging-port=${initialPort}`,
    `--user-data-dir=${path.join(userDataDir, 'chromium')}`,
  ];
  if (!packagedExe) launchArgs.push('.');

  const child = spawn(electronExe, launchArgs, {
    cwd: root,
    env: {
      ...process.env,
      PORTPILOT_DATA_DIR: userDataDir,
      PORTPILOT_DISABLE_LOGIN_ITEM: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    appStdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    appStderr += chunk;
  });

  let client = null;
  const errors = [];

  try {
    const page = await waitForDevTools(initialPort, 30000);
    client = new CdpClient(page.webSocketDebuggerUrl);
    await client.open();

    client.on('Runtime.exceptionThrown', (params) => {
      const description = params.exceptionDetails?.exception?.description;
      errors.push(description || params.exceptionDetails?.text || '渲染进程异常');
    });
    client.on('Runtime.consoleAPICalled', (params) => {
      if (params.type !== 'error') return;
      const text = (params.args || [])
        .map((arg) => arg.value || arg.description || '')
        .join(' ')
        .trim();
      if (text) errors.push(text);
    });
    client.on('Log.entryAdded', (params) => {
      if (params.entry && params.entry.level === 'error') {
        errors.push(params.entry.text);
      }
    });

    await client.send('Runtime.enable');
    await client.send('Log.enable');
    await client.send('Page.enable');

    const loaded = new Promise((resolve) => client.on('Page.loadEventFired', resolve));
    await client.send('Page.reload', { ignoreCache: true });
    await Promise.race([loaded, delay(10000)]);

    const evaluate = async (expression) => {
      const result = await client.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      if (result.exceptionDetails) {
        const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
        throw new Error(`页面脚本执行失败：${detail}`);
      }
      return result.result.value;
    };

    const waitFor = async (expression, label, timeoutMs = 15000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          if (await evaluate(expression)) return;
        } catch {
          void 0;
        }
        await delay(150);
      }
      throw new Error(`等待超时：${label}`);
    };

    await waitFor(
      "Boolean(window.portpilot) && document.body.innerText.includes('TCP 转发规则') && !document.querySelector('.app-loading:not(.is-hidden)')",
      '界面初始化',
      15000
    );

    const initial = await evaluate('window.portpilot.getState()');
    assert.equal(initial.rules.length, 0, '测试数据目录中不应存在规则');
    assert.ok(initial.interfaces.length > 0, '应至少检测到一张网卡');
    assert.ok(
      initial.haproxy.version,
      `HAProxy 版本检测失败：${initial.haproxy.versionError || '未知原因'}`
    );

    const layout = await evaluate(
      "({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth, mainWidth: document.getElementById('main').clientWidth, mainScrollWidth: document.getElementById('main').scrollWidth })"
    );
    assert.ok(
      layout.scrollWidth <= layout.width + 1 && layout.mainScrollWidth <= layout.mainWidth + 1,
      `界面出现横向溢出：${JSON.stringify(layout)}`
    );

    const theme = await evaluate(
      "({ background: getComputedStyle(document.body).backgroundColor, color: getComputedStyle(document.body).color, panel: getComputedStyle(document.querySelector('.stat-card')).backgroundColor })"
    );
    assert.equal(theme.background, 'rgb(244, 243, 239)', '界面应使用明亮的北欧风背景');
    assert.equal(theme.color, 'rgb(34, 48, 47)', '界面应使用深色正文文字');

    const bodyText = await evaluate('document.body.innerText');
    assert.match(bodyText, /还没有转发规则/);

    const localInterface = initial.interfaces.find((item) => !item.internal) || initial.interfaces[0];
    const alternateInterface = initial.interfaces.find((item) => item.name !== localInterface.name);
    const localPort = await reservePort(localInterface.address);

    await evaluate("document.querySelector('[data-action=\"add-rule\"]').click()");
    await waitFor("Boolean(document.getElementById('ruleForm'))", '打开新建规则弹窗', 5000);

    const targetModeUi = await evaluate(`(() => {
      const form = document.getElementById('ruleForm');
      document.querySelector('[data-target-mode="localNic"]').click();
      const localSelect = form.elements.targetLocalIp;
      const localState = {
        mode: form.elements.targetMode.value,
        localHidden: document.querySelector('[data-field="targetLocalIp"]').classList.contains('is-hidden'),
        remoteHidden: document.querySelector('[data-field="targetIp"]').classList.contains('is-hidden'),
        label: document.getElementById('previewTargetLabel').textContent,
        optionCount: Array.from(localSelect.options).filter((option) => option.value).length
      };
      document.querySelector('[data-target-mode="remote"]').click();
      return {
        ...localState,
        restoredMode: form.elements.targetMode.value,
        restoredRemoteHidden: document.querySelector('[data-field="targetIp"]').classList.contains('is-hidden')
      };
    })()`);
    assert.equal(targetModeUi.mode, 'localNic');
    assert.equal(targetModeUi.localHidden, false);
    assert.equal(targetModeUi.remoteHidden, true);
    assert.match(targetModeUi.label, /本机另一网卡/);
    assert.equal(targetModeUi.restoredMode, 'remote');
    assert.equal(targetModeUi.restoredRemoteHidden, false);
    if (alternateInterface) {
      assert.ok(targetModeUi.optionCount > 0, '存在两块网卡时应能选择另一块网卡');
    }

    const formFilled = await evaluate(`(() => {
      const form = document.getElementById('ruleForm');
      if (!form) return false;
      form.elements.name.value = 'Smoke Test Rule';
      form.elements.localIp.value = ${JSON.stringify(localInterface.address)};
      form.elements.localPort.value = ${JSON.stringify(String(localPort))};
      form.elements.targetIp.value = '10.10.20.30';
      form.elements.targetPort.value = '3306';
      form.elements.enabled.checked = false;
      form.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    assert.equal(formFilled, true);

    const preview = await evaluate("document.getElementById('routePreview').innerText");
    assert.match(preview, new RegExp(String(localPort)));
    assert.match(preview, /10\.10\.20\.30:3306/);

    await evaluate("document.getElementById('ruleSaveBtn').click()");
    try {
      await waitFor(
        "!document.getElementById('ruleForm') && document.body.innerText.includes('Smoke Test Rule')",
        '通过界面创建规则',
        8000
      );
    } catch (error) {
      const diagnostic = await evaluate(`(() => ({
        modal: Boolean(document.getElementById('ruleForm')),
        errors: Array.from(document.querySelectorAll('#ruleForm .field-error')).map((node) => node.textContent).filter(Boolean),
        toasts: Array.from(document.querySelectorAll('.toast-copy')).map((node) => node.textContent),
        rules: document.body.innerText.includes('Smoke Test Rule')
      }))()`);
      throw new Error(`${error.message}\n${JSON.stringify(diagnostic)}`);
    }

    const afterSave = await evaluate('window.portpilot.getState()');
    assert.equal(afterSave.rules.length, 1);
    assert.equal(afterSave.rules[0].localPort, localPort);
    const ruleId = afterSave.rules[0].id;

    await evaluate("document.querySelector('[data-action=\"toggle-rule\"]').click()");
    await waitFor(
      `window.portpilot.getState().then((state) => state.rules.find((rule) => rule.id === ${JSON.stringify(ruleId)})?.enabled === true)`,
      '切换规则启用状态',
      8000
    );

    await evaluate("document.querySelector('[data-action=\"service-start\"]').click()");
    try {
      await waitFor(
        "window.portpilot.getState().then((state) => state.service.state === 'running')",
        '通过界面启动转发服务',
        20000
      );
    } catch (error) {
      const current = await evaluate('window.portpilot.getState()');
      throw new Error(
        `${error.message}\n${(current.logs || [])
          .slice(-15)
          .map((entry) => `[${entry.level}] ${entry.message}`)
          .join('\n')}`
      );
    }

    const running = await evaluate('window.portpilot.getState()');
    assert.equal(running.service.activeRules, 1);

    await evaluate("document.querySelector('[data-view=\"logs\"]').click()");
    await delay(400);
    const logInfo = await evaluate(
      "({ count: document.querySelectorAll('.log-line').length, text: document.getElementById('logView').innerText })"
    );
    assert.ok(logInfo.count > 0, '日志视图应显示运行日志');
    assert.match(logInfo.text, /HAProxy/);

    await evaluate("document.querySelector('[data-view=\"settings\"]').click()");
    await delay(250);
    const settingsText = await evaluate("document.getElementById('settingsContent').innerText");
    assert.match(settingsText, /应用启动时自动运行转发/);
    assert.match(settingsText, /HAProxy 运行时/);

    await evaluate("document.querySelector('[data-action=\"view-config\"]').click()");
    await waitFor("Boolean(document.querySelector('.code-block'))", '打开配置预览弹窗', 5000);
    const configText = await evaluate("document.querySelector('.code-block').innerText");
    assert.match(configText, /global/);
    assert.match(configText, /frontend fe_/);
    assert.match(configText, new RegExp(String(localPort)));
    await evaluate("document.querySelector('.modal-header [data-action=\"close-modal\"]').click()");

    await evaluate("document.querySelector('[data-view=\"rules\"]').click()");
    await delay(250);
    await evaluate("document.querySelector('[data-action=\"service-stop\"]').click()");
    await waitFor(
      "window.portpilot.getState().then((state) => state.service.state === 'stopped')",
      '通过界面停止转发服务',
      10000
    );

    await evaluate("document.querySelector('[data-action=\"delete-rule\"]').click()");
    await waitFor("Boolean(document.querySelector('[data-action=\"confirm-accept\"]'))", '打开删除确认框', 5000);
    const confirmText = await evaluate("document.querySelector('.confirm-message').innerText");
    assert.match(confirmText, /Smoke Test Rule/);
    await evaluate("document.querySelector('[data-action=\"confirm-accept\"]').click()");
    await waitFor(
      "window.portpilot.getState().then((state) => state.rules.length === 0 && state.service.state === 'stopped')",
      '通过界面删除规则',
      10000
    );

    await delay(300);
    const afterDeleteText = await evaluate('document.body.innerText');
    assert.match(afterDeleteText, /还没有转发规则/);

    if (alternateInterface) {
      const localTargetPort = await reservePort(localInterface.address);
      const localDraft = {
        name: 'Local NIC Target Rule',
        localIp: localInterface.address,
        localPort: localTargetPort,
        targetMode: 'localNic',
        targetIp: alternateInterface.address,
        targetPort: 443,
        enabled: false,
      };
      const localSaved = await evaluate(
        `window.portpilot.saveRule(${JSON.stringify(localDraft)})`
      );
      assert.equal(
        localSaved.ok,
        true,
        `保存本机另一网卡规则失败：${JSON.stringify(localSaved.errors || localSaved)}`
      );
      assert.equal(localSaved.rule.targetMode, 'localNic');
      assert.equal(localSaved.rule.targetInterface, alternateInterface.name);

      await delay(300);
      const localRuleText = await evaluate('document.body.innerText');
      assert.match(localRuleText, /本机 ·/);

      const localDeleted = await evaluate(
        `window.portpilot.deleteRule(${JSON.stringify(localSaved.rule.id)})`
      );
      assert.equal(localDeleted.ok, true);
      assert.equal(localDeleted.state.rules.length, 0);
    }

    const finalStatus = await evaluate('window.portpilot.getState()');
    assert.equal(finalStatus.rules.length, 0);

    assert.deepEqual(errors, [], `渲染进程出现错误：\n${errors.join('\n')}`);

    console.log('UI SMOKE PASS: renderer, IPC, modals, rule CRUD and HAProxy lifecycle work.');
  } finally {
    if (client) {
      try {
        await client.send('Runtime.evaluate', {
          expression: 'window.portpilot && window.portpilot.quit()',
          awaitPromise: false,
        });
      } catch {
        client.close();
      }
      client.close();
    }

    await delay(1500);
    if (child.exitCode === null) {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        child.kill('SIGKILL');
      }
    }

    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      appStderr += '\n无法清理测试数据目录';
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  if (appStderr.trim()) console.error(appStderr.trim());
  if (appStdout.trim()) console.error(appStdout.trim());
  process.exitCode = 1;
});
