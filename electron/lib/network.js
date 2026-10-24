'use strict';

const net = require('node:net');
const os = require('node:os');

function listInterfaces() {
  const interfaces = os.networkInterfaces();
  const result = [];
  const seen = new Set();

  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses || []) {
      const family = address.family === 'IPv4' || address.family === 4 ? 'IPv4' : String(address.family);
      if (family !== 'IPv4') continue;
      if (seen.has(address.address)) continue;

      seen.add(address.address);
      result.push({
        name,
        address: address.address,
        netmask: address.netmask || '',
        mac: address.mac || '',
        internal: Boolean(address.internal),
      });
    }
  }

  result.sort((a, b) => {
    if (a.internal !== b.internal) return a.internal ? 1 : -1;
    return a.name.localeCompare(b.name, 'zh-CN') || a.address.localeCompare(b.address);
  });

  return result;
}

function findInterface(address) {
  return listInterfaces().find((item) => item.address === address) || null;
}

function errorMessage(error) {
  if (!error) return '连接失败';
  switch (error.code) {
    case 'ECONNREFUSED':
      return '连接被拒绝';
    case 'ETIMEDOUT':
      return '连接超时';
    case 'ENETUNREACH':
      return '网络不可达';
    case 'EHOSTUNREACH':
      return '主机不可达';
    case 'EADDRNOTAVAIL':
      return '本机地址不可用';
    case 'EACCES':
      return '权限不足';
    default:
      return error.message || '连接失败';
  }
}

function probeTcp(host, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    let socket;

    const finish = (ok, error) => {
      if (settled) return;
      settled = true;
      const latencyMs = Date.now() - startedAt;

      if (socket) {
        socket.removeAllListeners();
        socket.destroy();
      }

      resolve({
        ok,
        latencyMs,
        host,
        port,
        code: error && error.code ? error.code : null,
        error: ok ? null : errorMessage(error),
      });
    };

    try {
      socket = net.createConnection({ host, port });
    } catch (error) {
      finish(false, error);
      return;
    }

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => {
      const error = new Error('连接超时');
      error.code = 'ETIMEDOUT';
      finish(false, error);
    });
    socket.once('error', (error) => finish(false, error));
  });
}

module.exports = {
  listInterfaces,
  findInterface,
  probeTcp,
  errorMessage,
};
