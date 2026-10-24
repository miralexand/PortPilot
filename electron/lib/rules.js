'use strict';

const { randomUUID } = require('node:crypto');
const net = require('node:net');

function isIPv4(value) {
  return net.isIP(String(value || '').trim()) === 4;
}

function parsePort(value) {
  if (value === '' || value === null || value === undefined) return null;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function validateRule(draft, options = {}) {
  const rules = Array.isArray(options.rules) ? options.rules : [];
  const interfaces = Array.isArray(options.interfaces) ? options.interfaces : [];
  const errors = {};

  const enabled = draft && draft.enabled !== false;
  const id = draft && draft.id ? String(draft.id) : randomUUID();
  const name = String((draft && draft.name) || '').trim();

  if (name.length > 80) {
    errors.name = '规则名称不能超过 80 个字符';
  }

  const localIp = String((draft && draft.localIp) || '').trim();
  const localInterface = interfaces.find((item) => item.address === localIp) || null;

  if (!isIPv4(localIp)) {
    errors.localIp = '请选择有效的本机 IPv4 地址';
  } else if (enabled && interfaces.length > 0 && !localInterface) {
    errors.localIp = '该网卡地址已不存在，请刷新网卡后重新选择';
  }

  const localPort = parsePort(draft && draft.localPort);
  if (!localPort) {
    errors.localPort = '本机端口必须是 1-65535 之间的整数';
  }

  const targetMode = draft && draft.targetMode === 'localNic' ? 'localNic' : 'remote';
  const targetIp = String((draft && draft.targetIp) || '').trim();
  const targetInterface = interfaces.find((item) => item.address === targetIp) || null;

  if (!isIPv4(targetIp)) {
    errors.targetIp =
      targetMode === 'localNic' ? '请选择本机另一块网卡的有效 IPv4 地址' : '请输入有效的 IPv4 地址';
  } else if (targetIp === '0.0.0.0') {
    errors.targetIp = '目标地址不能是 0.0.0.0';
  } else if (targetMode === 'localNic') {
    if (targetInterface && localInterface && targetInterface.name === localInterface.name) {
      errors.targetIp = '源网卡与目标网卡不能相同';
    } else if (enabled && interfaces.length > 0 && !targetInterface) {
      errors.targetIp = '目标地址必须是本机另一块网卡的 IPv4 地址';
    }
  }

  const targetPort = parsePort(draft && draft.targetPort);
  if (!targetPort) {
    errors.targetPort = '目标端口必须是 1-65535 之间的整数';
  }

  if (enabled && localIp && localPort) {
    const duplicate = rules.find(
      (rule) =>
        rule.id !== id &&
        rule.enabled &&
        rule.localIp === localIp &&
        Number(rule.localPort) === localPort
    );

    if (duplicate) {
      errors.localPort = `本机 ${localIp}:${localPort} 已被规则「${duplicate.name}」占用`;
    }
  }

  const rule = {
    id,
    name:
      name ||
      `${localIp || '本机'}:${localPort || '?'} → ${targetIp || '目标地址'}:${targetPort || '?'}`,
    localIp,
    localPort,
    localInterface: (localInterface && localInterface.name) || String((draft && draft.localInterface) || ''),
    targetMode,
    targetIp,
    targetInterface:
      targetMode === 'localNic'
        ? (targetInterface && targetInterface.name) || String((draft && draft.targetInterface) || '')
        : '',
    targetPort,
    enabled,
  };

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    rule,
  };
}

function sanitizeRuleRecord(record) {
  if (!record || typeof record !== 'object') return null;

  const id = typeof record.id === 'string' && record.id ? record.id : randomUUID();
  const localPort = parsePort(record.localPort);
  const targetPort = parsePort(record.targetPort);

  return {
    id,
    name: String(record.name || '').trim().slice(0, 80) || '未命名规则',
    localIp: String(record.localIp || '').trim(),
    localPort: localPort || 0,
    localInterface: String(record.localInterface || ''),
    targetMode: record.targetMode === 'localNic' ? 'localNic' : 'remote',
    targetIp: String(record.targetIp || '').trim(),
    targetInterface: record.targetMode === 'localNic' ? String(record.targetInterface || '') : '',
    targetPort: targetPort || 0,
    enabled: Boolean(record.enabled),
    createdAt: Number(record.createdAt) || Date.now(),
    updatedAt: Number(record.updatedAt) || Date.now(),
  };
}

module.exports = {
  isIPv4,
  parsePort,
  validateRule,
  sanitizeRuleRecord,
};
