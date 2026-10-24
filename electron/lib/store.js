'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { sanitizeRuleRecord } = require('./rules');

const DEFAULT_SETTINGS = Object.freeze({
  autoStartService: true,
  launchAtLogin: false,
  closeToTray: true,
  showNotifications: true,
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.rulesPath = path.join(dataDir, 'rules.json');
    this.settingsPath = path.join(dataDir, 'settings.json');
    this.rules = [];
    this.settings = { ...DEFAULT_SETTINGS };
    this._load();
  }

  _load() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.rules = this._readRules();
    this.settings = this._readSettings();
  }

  _readJson(filePath) {
    try {
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      try {
        const backup = `${filePath}.corrupt-${Date.now()}`;
        fs.copyFileSync(filePath, backup);
      } catch {
        return null;
      }
      return null;
    }
  }

  _readRules() {
    const data = this._readJson(this.rulesPath);
    if (!data) return [];
    const list = Array.isArray(data) ? data : Array.isArray(data.rules) ? data.rules : [];
    return list.map(sanitizeRuleRecord).filter(Boolean);
  }

  _readSettings() {
    const data = this._readJson(this.settingsPath);
    const settings = { ...DEFAULT_SETTINGS };
    if (data && typeof data === 'object') {
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (typeof data[key] === 'boolean') settings[key] = data[key];
      }
    }
    return settings;
  }

  _writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    try {
      fs.renameSync(tempPath, filePath);
    } catch {
      fs.rmSync(filePath, { force: true });
      fs.renameSync(tempPath, filePath);
    }
  }

  _saveRules() {
    this._writeJson(this.rulesPath, this.rules);
  }

  _saveSettings() {
    this._writeJson(this.settingsPath, this.settings);
  }

  getRules() {
    return clone(this.rules);
  }

  getRule(id) {
    const rule = this.rules.find((item) => item.id === id);
    return rule ? clone(rule) : null;
  }

  upsertRule(rule) {
    const now = Date.now();
    const index = this.rules.findIndex((item) => item.id === rule.id);
    const existing = index >= 0 ? this.rules[index] : null;

    const next = {
      ...rule,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };

    if (index >= 0) {
      this.rules[index] = next;
    } else {
      this.rules.push(next);
    }

    this._saveRules();
    return clone(next);
  }

  deleteRule(id) {
    const index = this.rules.findIndex((item) => item.id === id);
    if (index < 0) return false;
    this.rules.splice(index, 1);
    this._saveRules();
    return true;
  }

  getSettings() {
    return { ...this.settings };
  }

  updateSettings(patch) {
    if (patch && typeof patch === 'object') {
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (typeof patch[key] === 'boolean') {
          this.settings[key] = patch[key];
        }
      }
    }
    this._saveSettings();
    return this.getSettings();
  }
}

module.exports = {
  Store,
  DEFAULT_SETTINGS,
};
