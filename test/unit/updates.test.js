'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RELEASES_URL,
  normalizeVersion,
  compareVersions,
  resolveReleaseUrl,
  checkForUpdates,
} = require('../../electron/lib/updates');

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test('normalizes release tags', () => {
  assert.equal(normalizeVersion('v0.0.3'), '0.0.3');
  assert.equal(normalizeVersion('release-1.2.3'), '1.2.3');
  assert.equal(normalizeVersion('1.2.3-beta.1'), '1.2.3');
  assert.equal(normalizeVersion(''), '');
});

test('compares numeric versions', () => {
  assert.equal(compareVersions('0.0.3', '0.0.2'), 1);
  assert.equal(compareVersions('0.0.2', '0.0.3'), -1);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('v1.10.0', '1.9.9'), 1);
});

test('only accepts release links from the project repository', () => {
  assert.equal(
    resolveReleaseUrl('https://github.com/miralexand/PortPilot/releases/tag/v0.0.3'),
    'https://github.com/miralexand/PortPilot/releases/tag/v0.0.3'
  );
  assert.equal(resolveReleaseUrl('https://example.com/evil'), RELEASES_URL);
});

test('detects a newer GitHub release', async () => {
  let request;

  const result = await checkForUpdates({
    currentVersion: '0.0.2',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response({
        tag_name: 'v0.0.3',
        html_url: 'https://github.com/miralexand/PortPilot/releases/tag/v0.0.3',
        published_at: '2026-10-25T00:00:00Z',
      });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.hasUpdate, true);
  assert.equal(result.currentVersion, '0.0.2');
  assert.equal(result.latestVersion, '0.0.3');
  assert.equal(request.options.headers['User-Agent'], 'PortPilot/0.0.2');
});

test('reports when the current version is up to date', async () => {
  const result = await checkForUpdates({
    currentVersion: '0.0.3',
    fetchImpl: async () => response({ tag_name: 'v0.0.3' }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.hasUpdate, false);
  assert.equal(result.latestVersion, '0.0.3');
});

test('handles a repository without published releases', async () => {
  const result = await checkForUpdates({
    currentVersion: '0.0.2',
    fetchImpl: async () => response({}, 404),
  });

  assert.equal(result.ok, true);
  assert.equal(result.noRelease, true);
  assert.equal(result.latestVersion, null);
  assert.equal(result.releaseUrl, RELEASES_URL);
});

test('rejects an unrecognized release tag', async () => {
  const result = await checkForUpdates({
    currentVersion: '0.0.2',
    fetchImpl: async () => response({ tag_name: 'nightly' }),
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /版本号/);
});

test('returns an error when the update service is unreachable', async () => {
  const result = await checkForUpdates({
    currentVersion: '0.0.2',
    fetchImpl: async () => {
      throw new Error('network down');
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'network down');
});
