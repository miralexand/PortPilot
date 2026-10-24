'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const { HaproxyManager } = require('../electron/lib/haproxy');
const { listInterfaces } = require('../electron/lib/network');

const logs = [];

function listen(server, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
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

function connectAndEcho(host, port, message) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('客户端等待回显超时'));
    }, 5000);

    socket.once('connect', () => socket.write(message));
    socket.once('data', (chunk) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(chunk.toString('utf8'));
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function runScenario(options) {
  const { label, sourceHost, targetHost, targetMode } = options;
  const echoServer = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.pipe(socket);
  });

  const echoPort = await listen(echoServer, targetHost);
  const frontendPort = await reservePort(sourceHost);
  const dataDir = path.join(
    __dirname,
    '.tmp',
    `e2e-${Date.now()}-${label.replace(/[^a-z0-9]+/gi, '-')}`
  );
  fs.mkdirSync(dataDir, { recursive: true });

  const manager = new HaproxyManager({
    executablePath: path.join(__dirname, '..', 'resources', 'haproxy', 'haproxy.exe'),
    dataDir,
  });

  manager.on('log', (entry) => {
    logs.push(`[${label}] [${entry.level}] ${entry.source}: ${entry.message}`);
  });

  const rule = {
    id: `e2e-${label.replace(/[^a-z0-9]+/gi, '')}`,
    name: `E2E ${label}`,
    localIp: sourceHost,
    localPort: frontendPort,
    targetMode,
    targetIp: targetHost,
    targetPort: echoPort,
    enabled: true,
  };

  try {
    console.log(`${label}: ${sourceHost}:${frontendPort} -> ${targetHost}:${echoPort}`);
    await manager.start([rule]);

    const message = `portpilot-echo-${label}-${Date.now()}`;
    const echoed = await connectAndEcho(sourceHost, frontendPort, message);
    assert.equal(echoed, message);

    const status = manager.getStatus();
    assert.equal(status.state, 'running');
    assert.equal(status.activeRules, 1);
  } finally {
    await manager.stop();
    await closeServer(echoServer);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function main() {
  await runScenario({
    label: 'Loopback',
    sourceHost: '127.0.0.1',
    targetHost: '127.0.0.1',
    targetMode: 'remote',
  });

  const candidates = [];
  for (const item of listInterfaces()) {
    if (item.internal) continue;
    if (item.address.startsWith('169.254.')) continue;
    if (candidates.some((entry) => entry.name === item.name)) continue;
    candidates.push(item);
  }

  if (candidates.length >= 2) {
    await runScenario({
      label: 'Local NIC',
      sourceHost: candidates[0].address,
      targetHost: candidates[1].address,
      targetMode: 'localNic',
    });
    console.log(
      `Local NIC scenario: ${candidates[0].name} ${candidates[0].address} -> ${candidates[1].name} ${candidates[1].address}`
    );
  } else {
    console.log('SKIP Local NIC scenario: fewer than two usable NICs detected.');
  }

  if (process.env.PORTPILOT_DEBUG_LOGS === '1') {
    console.log(logs.join('\n'));
  }

  console.log('E2E PASS: TCP forwarding through HAProxy works.');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  if (logs.length > 0) {
    console.error('--- HAProxy logs ---');
    console.error(logs.join('\n'));
  }
  process.exitCode = 1;
});
