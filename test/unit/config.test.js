'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { generateConfig, formatBind } = require('../../electron/lib/config');

const rules = [
  {
    id: 'rule-one',
    name: 'ERP 数据库\n# 注释注入',
    localIp: '192.168.6.23',
    localPort: 8080,
    targetIp: '10.10.20.30',
    targetPort: 3306,
    enabled: true,
  },
  {
    id: 'rule-two',
    name: '已停用规则',
    localIp: '192.168.6.23',
    localPort: 9090,
    targetIp: '10.10.20.31',
    targetPort: 5432,
    enabled: false,
  },
];

test('generates TCP frontends and backends only for enabled rules', () => {
  const config = generateConfig(rules, { includeTimestamp: false });

  assert.match(config, /^global$/m);
  assert.match(config, /^\s+mode tcp$/m);
  assert.match(config, /frontend fe_ruleone/);
  assert.match(config, /bind 192\.168\.6\.23:8080/);
  assert.match(config, /default_backend be_ruleone/);
  assert.match(config, /server target 10\.10\.20\.30:3306/);
  assert.match(config, /# Rule: ERP 数据库\s+注释注入/);
  assert.doesNotMatch(config, /9090/);
  assert.doesNotMatch(config, /rule-two/);
  assert.doesNotMatch(config, /Generated at/);
});

test('formats IPv6 bind addresses with brackets', () => {
  assert.equal(formatBind('::1', 8443), '[::1]:8443');
  const config = generateConfig(
    [
      {
        id: 'ipv6',
        name: 'IPv6',
        localIp: '::1',
        localPort: 8443,
        targetIp: '10.1.1.1',
        targetPort: 443,
        enabled: true,
      },
    ],
    { includeTimestamp: false }
  );
  assert.match(config, /bind \[::1\]:8443/);
});

test('returns a valid minimal config when no rules are enabled', () => {
  const config = generateConfig([{ ...rules[1], enabled: false }], { includeTimestamp: false });
  assert.match(config, /# No enabled rules\./);
  assert.doesNotMatch(config, /frontend /);
  assert.doesNotMatch(config, /backend /);
});
