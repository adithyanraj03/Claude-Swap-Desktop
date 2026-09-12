'use strict';
/** Persisted app settings — a small JSON file in userData, written atomically. */
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  // Appearance
  material: 'acrylic', // 'acrylic' | 'mica' | 'none'  (Windows 11 backdrop)
  opacity: 0.97, // whole-window opacity, 0.45 - 1
  tint: 0.55, // strength of the glass tint painted over the backdrop, 0 - 1
  theme: 'dark', // 'dark' | 'light' | 'system'
  accentUsage: true, // colour the tray ring / bars by remaining quota

  // Behaviour
  pollSeconds: 60, // refresh cadence while the popover is open
  idlePollSeconds: 300, // refresh cadence while it is hidden (tray tooltip)
  hideOnBlur: true,
  alwaysOnTop: true,
  confirmSwitch: true,
  warnRunningSessions: true,
  launchAtLogin: false,
  locked: true, // guard: a stray click must not switch the account
  size: null, // {width, height} once resized by hand; null = fit to content

  // Integration
  cswapPath: '', // override; empty = auto-detect on PATH
};

class Settings {
  constructor(file) {
    this.file = file;
    this.values = { ...DEFAULTS };
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const key of Object.keys(DEFAULTS)) {
        if (Object.prototype.hasOwnProperty.call(raw, key)) this.values[key] = raw[key];
      }
    } catch {
      /* first run, or an unreadable file — defaults stand */
    }
    this.coerce();
  }

  /** Keep values inside their documented ranges even if the file was hand-edited. */
  coerce() {
    const v = this.values;
    const num = (x, lo, hi, dflt) => {
      const n = Number(x);
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
    };
    const oneOf = (x, allowed, dflt) => (allowed.includes(x) ? x : dflt);
    v.material = oneOf(v.material, ['acrylic', 'mica', 'none'], DEFAULTS.material);
    v.theme = oneOf(v.theme, ['dark', 'light', 'system'], DEFAULTS.theme);
    v.opacity = num(v.opacity, 0.45, 1, DEFAULTS.opacity);
    v.tint = num(v.tint, 0, 1, DEFAULTS.tint);
    v.pollSeconds = num(v.pollSeconds, 15, 3600, DEFAULTS.pollSeconds);
    v.idlePollSeconds = num(v.idlePollSeconds, 60, 7200, DEFAULTS.idlePollSeconds);
    for (const key of [
      'accentUsage',
      'hideOnBlur',
      'alwaysOnTop',
      'confirmSwitch',
      'warnRunningSessions',
      'launchAtLogin',
      'locked',
    ]) {
      v[key] = Boolean(v[key]);
    }
    v.cswapPath = typeof v.cswapPath === 'string' ? v.cswapPath : '';
    // A hand-set window size, or null for fit-to-content. Bounded here so a
    // corrupt file cannot produce an unusable window.
    const size = v.size;
    v.size =
      size && Number.isFinite(Number(size.width)) && Number.isFinite(Number(size.height))
        ? {
            width: num(size.width, 330, 1500, 392),
            height: num(size.height, 220, 900, 420),
          }
        : null;
  }

  get all() {
    return { ...this.values };
  }

  get(key) {
    return this.values[key];
  }

  /** Merge a patch, clamp it, persist, and return the new state. */
  set(patch) {
    Object.assign(this.values, patch || {});
    this.coerce();
    this.save();
    return this.all;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.values, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[settings] save failed:', err && err.message);
    }
  }
}

module.exports = { Settings, DEFAULTS };
