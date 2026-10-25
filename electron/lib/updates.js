'use strict';

const REPOSITORY_URL = 'https://github.com/miralexand/PortPilot';
const RELEASES_URL = `${REPOSITORY_URL}/releases`;
const LATEST_RELEASE_API = 'https://api.github.com/repos/miralexand/PortPilot/releases/latest';

function parseVersion(value) {
  const match = String(value || '')
    .trim()
    .match(/(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?/);

  if (!match) return null;

  return {
    version: `${match[1]}.${match[2]}.${match[3]}`,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function normalizeVersion(value) {
  const parsed = parseVersion(value);
  return parsed ? parsed.version : String(value || '').trim().replace(/^v/i, '');
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return 0;

  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }

  return 0;
}

function resolveReleaseUrl(value) {
  const url = String(value || '');
  return url.startsWith(`${RELEASES_URL}/`) ? url : RELEASES_URL;
}

async function checkForUpdates({
  currentVersion,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    return { ok: false, error: '当前环境不支持网络请求' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const version = normalizeVersion(currentVersion);

  try {
    const response = await fetchImpl(LATEST_RELEASE_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `PortPilot/${version || 'unknown'}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: controller.signal,
    });

    if (response.status === 404) {
      return {
        ok: true,
        currentVersion: version,
        latestVersion: null,
        hasUpdate: false,
        noRelease: true,
        releaseUrl: RELEASES_URL,
        repositoryUrl: REPOSITORY_URL,
      };
    }

    if (!response.ok) {
      throw new Error(`更新服务返回 HTTP ${response.status}`);
    }

    const release = await response.json();
    const latestVersion = normalizeVersion(release.tag_name || release.name);
    if (!parseVersion(latestVersion)) {
      throw new Error('无法识别最新版本号');
    }

    return {
      ok: true,
      currentVersion: version,
      latestVersion,
      hasUpdate: compareVersions(latestVersion, version) > 0,
      releaseUrl: resolveReleaseUrl(release.html_url),
      publishedAt: release.published_at || null,
      repositoryUrl: REPOSITORY_URL,
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      return { ok: false, error: '检查更新超时，请检查网络后重试' };
    }
    return { ok: false, error: error.message || '检查更新失败' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  REPOSITORY_URL,
  RELEASES_URL,
  LATEST_RELEASE_API,
  parseVersion,
  normalizeVersion,
  compareVersions,
  resolveReleaseUrl,
  checkForUpdates,
};
