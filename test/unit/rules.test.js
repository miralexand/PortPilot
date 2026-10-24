'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateRule, sanitizeRuleRecord, parsePort } = require('../../electron/lib/rules');

const interfaces = [
  { name: 'WLAN', address: '192.168.6.23', internal: false },
  { name: 'Ethernet', address: '10.0.0.5', internal: false },
  { name: 'Loopback', address: '127.0.0.1', internal: true },
];

const baseRule = {
  name: '数据库通道',
  localIp: '192.168.6.23',
  localPort: 8080,
  targetIp: '10.10.20.30',
  targetPort: 3306,
  enabled: true,
};

test('accepts a valid forwarding rule', () => {
  const result = validateRule(baseRule, { rules: [], interfaces });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, {});
  assert.equal(result.rule.localInterface, 'WLAN');
  assert.equal(result.rule.localPort, 8080);
  assert.equal(result.rule.targetPort, 3306);
});

test('accepts any valid remote IPv4 target', () => {
  for (const targetIp of ['10.0.0.8', '192.168.50.20', '8.8.8.8']) {
    const result = validateRule({ ...baseRule, targetIp }, { rules: [], interfaces });
    assert.equal(result.ok, true, targetIp);
  }
});

test('rejects invalid or unspecified remote targets', () => {
  const invalid = validateRule({ ...baseRule, targetIp: '300.1.1.1' }, { rules: [], interfaces });
  assert.equal(invalid.ok, false);
  const unspecified = validateRule({ ...baseRule, targetIp: '0.0.0.0' }, { rules: [], interfaces });
  assert.equal(unspecified.ok, false);
});

test('rejects invalid ports', () => {
  assert.equal(parsePort('0'), null);
  assert.equal(parsePort('65536'), null);
  assert.equal(parsePort('8080'), 8080);
  const result = validateRule({ ...baseRule, localPort: 70000 }, { rules: [], interfaces });
  assert.equal(result.ok, false);
  assert.ok(result.errors.localPort);
});

test('rejects duplicate enabled local bind addresses', () => {
  const existing = {
    ...baseRule,
    id: 'existing',
    name: '已有规则',
    enabled: true,
  };
  const result = validateRule(baseRule, { rules: [existing], interfaces });
  assert.equal(result.ok, false);
  assert.match(result.errors.localPort, /已有规则/);
});

test('allows the same address for the rule being edited', () => {
  const existing = { ...baseRule, id: 'same-id', enabled: true };
  const result = validateRule({ ...baseRule, id: 'same-id' }, { rules: [existing], interfaces });
  assert.equal(result.ok, true);
});

test('allows disabled rules with an address that is not currently present', () => {
  const result = validateRule(
    { ...baseRule, localIp: '192.168.99.99', enabled: false },
    { rules: [], interfaces }
  );
  assert.equal(result.ok, true);
});

test('rejects enabled rules whose local address is missing', () => {
  const result = validateRule(
    { ...baseRule, localIp: '192.168.99.99', enabled: true },
    { rules: [], interfaces }
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.localIp, /不存在/);
});

test('generates a fallback name when none is provided', () => {
  const result = validateRule({ ...baseRule, name: '   ' }, { rules: [], interfaces });
  assert.equal(result.ok, true);
  assert.match(result.rule.name, /192\.168\.6\.23:8080/);
  assert.match(result.rule.name, /10\.10\.20\.30:3306/);
});

test('accepts a local target hosted on another NIC', () => {
  const result = validateRule(
    { ...baseRule, targetMode: 'localNic', targetIp: '10.0.0.5' },
    { rules: [], interfaces }
  );
  assert.equal(result.ok, true);
  assert.equal(result.rule.targetMode, 'localNic');
  assert.equal(result.rule.targetInterface, 'Ethernet');
});

test('rejects a local target hosted on the source NIC', () => {
  const result = validateRule(
    { ...baseRule, targetMode: 'localNic', targetIp: '192.168.6.23' },
    { rules: [], interfaces }
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.targetIp, /不能相同/);
});

test('requires an existing local target when the rule is enabled', () => {
  const result = validateRule(
    { ...baseRule, targetMode: 'localNic', targetIp: '10.9.9.9' },
    { rules: [], interfaces }
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.targetIp, /另一块网卡/);
});

test('allows a disabled local target that is not currently present', () => {
  const result = validateRule(
    { ...baseRule, targetMode: 'localNic', targetIp: '10.9.9.9', enabled: false },
    { rules: [], interfaces }
  );
  assert.equal(result.ok, true);
});

test('sanitizes stored rules', () => {
  const rule = sanitizeRuleRecord({
    id: 'abc',
    name: '  Test  ',
    localIp: '192.168.6.23',
    localPort: '8080',
    targetIp: '10.1.1.1',
    targetPort: '80',
    enabled: 1,
  });
  assert.equal(rule.name, 'Test');
  assert.equal(rule.localPort, 8080);
  assert.equal(rule.targetPort, 80);
  assert.equal(rule.targetMode, 'remote');
  assert.equal(rule.enabled, true);
});
