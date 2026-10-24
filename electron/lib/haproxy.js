'use strict';

const { EventEmitter } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { generateConfig } = require('./config');
const { probeTcp } = require('./network');

const MAX_LOGS = 1000;
const MAX_RESTARTS = 3;
const START_TIMEOUT_MS = 10000;

function stripAnsi(value) {
  return String(value || '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class HaproxyManager extends EventEmitter {
  constructor(options) {
    super();
    this.executablePath = options.executablePath;
    this.dataDir = options.dataDir;
    this.configPath = path.join(this.dataDir, 'haproxy.cfg');
    this.runtimeDir = path.dirname(this.executablePath);

    this.child = null;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    this.currentRules = [];
    this.desiredRunning = false;
    this.expectedExit = false;
    this.starting = false;
    this.startFailureMessage = '';
    this.restartAttempts = 0;
    this.restartTimer = null;
    this.stableTimer = null;
    this.queue = Promise.resolve();

    this.version = null;
    this.versionError = null;
    this.logs = [];
    this.logSequence = 0;

    this.status = {
      state: 'stopped',
      pid: null,
      startedAt: null,
      message: '',
      updatedAt: Date.now(),
    };
  }

  getRuntimeInfo() {
    return {
      version: this.version,
      versionError: this.versionError,
      executablePath: this.executablePath,
      executableExists: fs.existsSync(this.executablePath),
      configPath: this.configPath,
      runtimeDir: this.runtimeDir,
    };
  }

  getStatus() {
    const running = this.status.state === 'running' && this.status.startedAt;
    return {
      ...this.status,
      pid: this.child ? this.child.pid : this.status.pid,
      version: this.version,
      activeRules: this.currentRules.filter((rule) => rule.enabled).length,
      uptimeMs: running ? Date.now() - this.status.startedAt : 0,
    };
  }

  getLogs() {
    return this.logs.map((entry) => ({ ...entry }));
  }

  clearLogs() {
    this.logs = [];
  }

  log(level, message, source = 'app') {
    const clean = stripAnsi(message).trim();
    if (!clean) return;

    const entry = {
      id: ++this.logSequence,
      ts: Date.now(),
      level,
      source,
      message: clean,
    };

    this.logs.push(entry);
    if (this.logs.length > MAX_LOGS) {
      this.logs.splice(0, this.logs.length - MAX_LOGS);
    }

    this.emit('log', { ...entry });
  }

  _setStatus(patch) {
    this.status = {
      ...this.status,
      ...patch,
      updatedAt: Date.now(),
    };
    this.emit('status', this.getStatus());
  }

  detectVersion() {
    this.version = null;
    this.versionError = null;

    if (!fs.existsSync(this.executablePath)) {
      this.versionError = '未找到 HAProxy 可执行文件';
      return this.getRuntimeInfo();
    }

    const result = spawnSync(this.executablePath, ['-v'], {
      cwd: this.runtimeDir,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 8000,
    });

    if (result.error) {
      this.versionError =
        result.error.code === 'ENOENT'
          ? '未找到 HAProxy 可执行文件'
          : `无法运行 HAProxy：${result.error.message}`;
      return this.getRuntimeInfo();
    }

    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    const match = output.match(/HAProxy version\s+([^\s]+)/i);
    if (match) {
      this.version = match[1];
    } else {
      this.versionError = `无法识别 HAProxy 版本（退出码 ${result.status}）`;
    }

    return this.getRuntimeInfo();
  }

  start(rules, options = {}) {
    return this._enqueue(() => this._start(rules, options));
  }

  stop(options = {}) {
    return this._enqueue(() => this._stop(options));
  }

  restart(rules) {
    return this._enqueue(async () => {
      await this._stop({ silent: true });
      return this._start(rules, { reason: 'restart' });
    });
  }

  _enqueue(task) {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  async _start(rules, options = {}) {
    const reason = options.reason || 'manual';

    await this._stop({ silent: true });
    this.currentRules = (Array.isArray(rules) ? rules : []).map((rule) => ({ ...rule }));

    const enabledRules = this.currentRules.filter((rule) => rule.enabled);
    if (!this.versionError && !this.version) {
      this.detectVersion();
    }

    if (!fs.existsSync(this.executablePath)) {
      const message = '未找到 HAProxy 可执行文件，请重新安装 PortPilot';
      this._setStatus({ state: 'error', pid: null, startedAt: null, message });
      this.log('error', message, 'service');
      throw new Error(message);
    }

    if (this.versionError) {
      const message = this.versionError;
      this._setStatus({ state: 'error', pid: null, startedAt: null, message });
      this.log('error', message, 'service');
      throw new Error(message);
    }

    if (enabledRules.length === 0) {
      this.desiredRunning = false;
      this._setStatus({
        state: 'stopped',
        pid: null,
        startedAt: null,
        message: '没有启用的转发规则',
      });
      return { ok: true, started: false };
    }

    this.desiredRunning = true;
    this.starting = true;
    this.startFailureMessage = '';
    this._setStatus({
      state: 'starting',
      pid: null,
      startedAt: null,
      message: reason === 'auto' ? '正在自动重启 HAProxy…' : '正在启动 HAProxy…',
    });

    try {
      this._writeAndCheckConfig(this.currentRules);
    } catch (error) {
      this.starting = false;
      this.desiredRunning = false;
      this._setStatus({
        state: 'error',
        pid: null,
        startedAt: null,
        message: error.message,
      });
      this.log('error', error.message, 'service');
      throw error;
    }

    let child;
    try {
      child = spawn(this.executablePath, ['-f', this.configPath], {
        cwd: this.runtimeDir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.starting = false;
      this.desiredRunning = false;
      const message = `无法启动 HAProxy：${error.message}`;
      this._setStatus({ state: 'error', pid: null, startedAt: null, message });
      this.log('error', message, 'service');
      throw new Error(message);
    }

    this.child = child;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    this._setStatus({
      state: 'starting',
      pid: child.pid || null,
      startedAt: null,
      message: '等待 HAProxy 监听端口…',
    });
    this.log('info', `HAProxy 进程已创建（PID ${child.pid || '未知'}）`, 'service');

    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => this._consumeOutput('stdout', chunk));
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => this._consumeOutput('stderr', chunk));
    }

    child.once('error', (error) => {
      this.startFailureMessage = `HAProxy 进程错误：${error.message}`;
      this.log('error', this.startFailureMessage, 'service');
      if (!child.pid) this._handleExit(child, null, null);
    });

    child.once('exit', (code, signal) => {
      this._handleExit(child, code, signal);
    });

    try {
      await this._waitForReady(enabledRules, START_TIMEOUT_MS);
    } catch (error) {
      this.starting = false;
      this.desiredRunning = false;
      await this._killChild();
      const message = this.startFailureMessage || error.message;
      this._setStatus({
        state: 'error',
        pid: null,
        startedAt: null,
        message,
      });
      this.log('error', message, 'service');
      throw new Error(message);
    }

    this.starting = false;
    this._setStatus({
      state: 'running',
      pid: child.pid || null,
      startedAt: Date.now(),
      message: '',
    });
    this.log('info', `HAProxy 已启动，${enabledRules.length} 条规则正在转发`, 'service');
    this._scheduleStableReset();
    return { ok: true, started: true };
  }

  async _stop(options = {}) {
    const silent = Boolean(options.silent);
    this.desiredRunning = false;
    this._clearRestartTimer();
    this._clearStableTimer();

    if (!this.child) {
      this._setStatus({
        state: 'stopped',
        pid: null,
        startedAt: null,
        message: '',
      });
      if (!silent) this.log('info', '转发服务已停止', 'service');
      return { ok: true };
    }

    if (!silent) this.log('info', '正在停止 HAProxy…', 'service');
    await this._killChild();
    this._setStatus({
      state: 'stopped',
      pid: null,
      startedAt: null,
      message: '',
    });
    if (!silent) this.log('info', '转发服务已停止', 'service');
    return { ok: true };
  }

  async _killChild() {
    const child = this.child;
    if (!child || child.exitCode !== null) {
      this.child = null;
      return;
    }

    this.expectedExit = true;
    this.starting = false;

    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };

      const timer = setTimeout(() => {
        try {
          spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            timeout: 5000,
          });
        } catch {
          finish();
        }
        finish();
      }, 2500);

      child.once('exit', finish);
      try {
        child.kill();
      } catch {
        finish();
      }
    });

    if (this.child === child) {
      this.child = null;
    }
  }

  _handleExit(child, code, signal) {
    if (this.child !== child) return;

    this._flushOutput();
    this.child = null;

    const wasExpected = this.expectedExit;
    this.expectedExit = false;
    this._clearStableTimer();

    if (wasExpected) {
      return;
    }

    if (this.starting) {
      this.startFailureMessage = `HAProxy 启动后立即退出（退出码 ${code ?? signal ?? '未知'}）`;
      this._setStatus({
        state: 'error',
        pid: null,
        startedAt: null,
        message: this.startFailureMessage,
      });
      return;
    }

    if (!this.desiredRunning) {
      this._setStatus({
        state: 'stopped',
        pid: null,
        startedAt: null,
        message: '',
      });
      return;
    }

    const exitText = code !== null && code !== undefined ? `退出码 ${code}` : `信号 ${signal || '未知'}`;
    this.log('error', `HAProxy 意外退出（${exitText}）`, 'service');

    if (this.restartAttempts >= MAX_RESTARTS) {
      this._setStatus({
        state: 'error',
        pid: null,
        startedAt: null,
        message: 'HAProxy 连续异常退出，已停止自动重启',
      });
      return;
    }

    this._scheduleRestart();
  }

  _scheduleRestart() {
    this.restartAttempts += 1;
    const waitMs = Math.min(1000 * 2 ** (this.restartAttempts - 1), 15000);

    this._setStatus({
      state: 'restarting',
      pid: null,
      startedAt: null,
      message: `HAProxy 异常退出，${Math.round(waitMs / 1000)} 秒后自动重启（${this.restartAttempts}/${MAX_RESTARTS}）`,
    });
    this.log('warn', this.status.message, 'service');

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start(this.currentRules, { reason: 'auto' }).catch((error) => {
        this.log('error', `自动重启失败：${error.message}`, 'service');
      });
    }, waitMs);
  }

  _scheduleStableReset() {
    this._clearStableTimer();
    this.stableTimer = setTimeout(() => {
      this.stableTimer = null;
      this.restartAttempts = 0;
    }, 15000);
  }

  _clearRestartTimer() {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  _clearStableTimer() {
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
  }

  _writeAndCheckConfig(rules) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const text = generateConfig(rules, { includeTimestamp: true });
    fs.writeFileSync(this.configPath, text, 'utf8');

    const result = spawnSync(this.executablePath, ['-c', '-f', this.configPath], {
      cwd: this.runtimeDir,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 15000,
    });

    if (result.error) {
      throw new Error(`HAProxy 配置校验无法执行：${result.error.message}`);
    }

    if (result.status !== 0) {
      const output = `${result.stdout || ''}\n${result.stderr || ''}`;
      const detail = this._extractConfigError(output);
      for (const line of this._outputLines(output)) {
        this.log('error', line, 'haproxy');
      }
      throw new Error(detail || `HAProxy 配置校验失败（退出码 ${result.status}）`);
    }

    this.log('info', 'HAProxy 配置校验通过', 'service');
  }

  _extractConfigError(output) {
    const lines = this._outputLines(output);
    const important = lines.filter((line) =>
      /\[(ALERT|ERROR)\]|cannot bind|failed to|fatal|unable to|invalid/i.test(line)
    );
    const selected = important.length > 0 ? important : lines.slice(-3);
    const cleaned = selected.map((line) => line.replace(/^\[\w+\]\s*(\(\d+\)\s*)?:?\s*/i, '').trim());
    const message = cleaned.join('；');
    return message.length > 500 ? `${message.slice(0, 497)}...` : message;
  }

  _outputLines(output) {
    return stripAnsi(output)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  _consumeOutput(stream, chunk) {
    const key = stream === 'stdout' ? 'stdoutBuffer' : 'stderrBuffer';
    const text = `${this[key]}${chunk}`;
    const parts = text.split('\n');
    this[key] = parts.pop() || '';

    for (const part of parts) {
      this._logHaproxyLine(part);
    }
  }

  _logHaproxyLine(line) {
    const clean = stripAnsi(line).replace(/\r$/, '').trim();
    if (!clean) return;

    let level = 'info';
    if (/\[(ALERT|ERROR)\]/i.test(clean)) level = 'error';
    else if (/\[WARNING\]/i.test(clean)) level = 'warn';

    this.log(level, clean, 'haproxy');
  }

  _flushOutput() {
    if (this.stdoutBuffer.trim()) this._logHaproxyLine(this.stdoutBuffer);
    if (this.stderrBuffer.trim()) this._logHaproxyLine(this.stderrBuffer);
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
  }

  async _waitForReady(rules, timeoutMs) {
    const endpoints = [];
    const seen = new Set();

    for (const rule of rules) {
      const key = `${rule.localIp}:${rule.localPort}`;
      if (seen.has(key)) continue;
      seen.add(key);
      endpoints.push({ host: rule.localIp, port: rule.localPort });
    }

    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (!this.child || this.child.exitCode !== null) {
        throw new Error(this.startFailureMessage || 'HAProxy 启动后立即退出，请查看日志');
      }

      const results = await Promise.all(
        endpoints.map((endpoint) => probeTcp(endpoint.host, endpoint.port, 500))
      );

      if (results.every((result) => result.ok)) {
        await delay(250);
        if (!this.child || this.child.exitCode !== null) {
          throw new Error(this.startFailureMessage || 'HAProxy 启动后立即退出，请查看日志');
        }
        return;
      }

      await delay(150);
    }

    throw new Error('HAProxy 启动超时，请检查本机端口是否已被占用');
  }
}

module.exports = {
  HaproxyManager,
  MAX_LOGS,
};
