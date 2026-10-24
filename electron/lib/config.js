'use strict';

const net = require('node:net');

function formatBind(address, port) {
  return net.isIP(address) === 6 ? `[${address}]:${port}` : `${address}:${port}`;
}

function formatEndpoint(address, port) {
  return net.isIP(address) === 6 ? `[${address}]:${port}` : `${address}:${port}`;
}

function frontendName(rule) {
  const tag = String(rule.id || '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 24);
  return `fe_${tag || 'rule'}`;
}

function backendName(rule) {
  const tag = String(rule.id || '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 24);
  return `be_${tag || 'rule'}`;
}

function safeComment(value) {
  return String(value || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/#/g, '')
    .trim()
    .slice(0, 80);
}

function generateConfig(rules, options = {}) {
  const includeTimestamp = options.includeTimestamp !== false;
  const enabledRules = (Array.isArray(rules) ? rules : []).filter((rule) => rule && rule.enabled);
  const lines = [];

  lines.push('# PortPilot - generated HAProxy TCP forwarding configuration');
  if (includeTimestamp) {
    lines.push(`# Generated at: ${new Date().toISOString()}`);
  }
  lines.push('# This file is managed by PortPilot. Manual edits will be overwritten.');
  lines.push('');

  lines.push('global');
  lines.push('    log stdout format raw local0');
  lines.push('    maxconn 1024');
  lines.push('');

  lines.push('defaults');
  lines.push('    log global');
  lines.push('    mode tcp');
  lines.push('    option tcplog');
  lines.push('    option tcpka');
  lines.push('    retries 3');
  lines.push('    timeout connect 10s');
  lines.push('    timeout client 24h');
  lines.push('    timeout server 24h');
  lines.push('');

  if (enabledRules.length === 0) {
    lines.push('# No enabled rules.');
    lines.push('');
    return lines.join('\n');
  }

  for (const rule of enabledRules) {
    const label = safeComment(rule.name) || formatEndpoint(rule.localIp, rule.localPort);
    const fe = frontendName(rule);
    const be = backendName(rule);

    lines.push(`# Rule: ${label}`);
    lines.push(`frontend ${fe}`);
    lines.push(`    bind ${formatBind(rule.localIp, rule.localPort)}`);
    lines.push('    mode tcp');
    lines.push(`    default_backend ${be}`);
    lines.push('');

    lines.push(`backend ${be}`);
    lines.push('    mode tcp');
    lines.push(`    server target ${formatEndpoint(rule.targetIp, rule.targetPort)}`);
    lines.push('');
  }

  return lines.join('\n');
}

module.exports = {
  generateConfig,
  formatBind,
  formatEndpoint,
  frontendName,
  backendName,
};
