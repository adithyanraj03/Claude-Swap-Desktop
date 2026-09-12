'use strict';
/**
 * Popover UI. State arrives pushed from the main process; everything here is
 * presentation plus the confirm-then-switch flow.
 *
 * Countdowns are recomputed locally from each window's `resetsAt` every second
 * rather than re-read from the CLI — same rule claude-swap applies when it
 * renders, and it keeps the clock honest between polls without extra API calls.
 */

const $ = (selector) => document.querySelector(selector);
const app = $('#app');
const listEl = $('#list');

let state = null;
let confirmTarget; // account object, or null for "most headroom"
let tickNodes = []; // live countdown spans rebuilt on every render
let toastTimer = null;
let settingsSignature = '';

/* ------------------------------ formatting ------------------------------ */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "3d 14h" / "1h 40m" / "12m" — the CLI's own countdown shape. */
function countdown(resetsAt) {
  const seconds = Math.max(0, Math.floor((new Date(resetsAt).getTime() - Date.now()) / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** "15:50" when it resets today, otherwise "Sep 16 02:30". */
function clockOf(resetsAt) {
  const at = new Date(resetsAt);
  const now = new Date();
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  if (at.toDateString() === now.toDateString()) return time;
  return `${MONTHS[at.getMonth()]} ${at.getDate()} ${time}`;
}

function ago(timestamp) {
  if (!timestamp) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

function bandOf(pct) {
  if (!Number.isFinite(pct)) return 'band-ok';
  if (pct >= 85) return 'band-high';
  if (pct >= 60) return 'band-warn';
  return 'band-ok';
}

const STATUS_TEXT = {
  token_expired: 'Token expired — Claude Code refreshes it automatically.',
  api_key: 'API-key account: no subscription quota to report.',
  keychain_unavailable: 'Credential store unreadable right now.',
  relogin_required: 'Re-login needed — run cswap login for this account.',
  foreign_credential: 'Live credential belongs to another account; switching repairs it.',
  no_credentials: 'No stored credentials for this slot.',
  unavailable: 'Usage unavailable.',
};

/* -------------------------------- helpers ------------------------------- */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function label(account) {
  return account.alias || account.email || `Account ${account.number}`;
}

/* --------------------------------- render -------------------------------- */

function render() {
  if (!state) return;
  applySettings();
  renderAbout();
  renderHeader();
  renderBanner();
  renderList();
  renderStamp();
}

function renderHeader() {
  const active = state.accounts.find((a) => a.active);
  const subtitle = $('#subtitle');
  if (state.error) subtitle.textContent = 'Cannot reach cswap';
  else if (active) subtitle.textContent = `Account ${active.number} · ${label(active)}`;
  else if (state.accounts.length) subtitle.textContent = `${state.accounts.length} accounts · none active`;
  else subtitle.textContent = 'No managed accounts';

  const locked = state.settings.locked;
  $('#btn-refresh').classList.toggle('spin', Boolean(state.loading || state.switching != null));
  $('#btn-pin').classList.toggle('on', !state.settings.hideOnBlur);
  $('#btn-lock').classList.toggle('on', locked);
  $('#btn-lock').title = locked ? 'Switching is locked — click to unlock' : 'Lock switching';
  $('#btn-best').disabled = state.accounts.length < 2 || state.switching != null || locked;
}

function renderBanner() {
  const banner = $('#banner');
  if (!state.error) {
    banner.hidden = true;
    return;
  }
  banner.replaceChildren(el('b', null, state.error.message));
  if (state.error.detail) banner.appendChild(el('span', null, state.error.detail));
  banner.hidden = false;
}

/** One 5h/7d row: label, meter, percentage, then the reset legend beneath. */
function metricRow(name, window, isWeekly) {
  const rows = document.createDocumentFragment();
  const pct = Number(window.pct) || 0;

  const metric = el('div', `metric ${bandOf(pct)}`);
  metric.appendChild(el('span', 'lbl', name));
  const meter = el('div', 'meter');
  const fill = el('span', 'fill');
  fill.style.setProperty('--p', `${Math.min(100, Math.max(0, pct))}%`);
  meter.appendChild(fill);
  // Where a steady burn rate would have put you by now.
  if (isWeekly && Number.isFinite(window.expectedPct)) {
    const pace = el('i', 'pace');
    pace.style.left = `${Math.min(100, Math.max(0, window.expectedPct))}%`;
    pace.title = `Expected ${Math.round(window.expectedPct)}% at this point in the window`;
    meter.appendChild(pace);
  }
  metric.appendChild(meter);
  metric.appendChild(el('span', 'pct', `${Math.round(pct)}%`));
  rows.appendChild(metric);

  const legend = el('div', 'legend');
  const left = el('span', null, '—');
  if (window.resetsAt) {
    left.textContent = `resets in ${countdown(window.resetsAt)}`;
    tickNodes.push({ node: left, resetsAt: window.resetsAt });
  } else if (window.countdown) {
    left.textContent = `resets in ${window.countdown}`;
  }
  legend.appendChild(left);

  const right = el('span', null, '');
  if (isWeekly && window.aheadOfPace) {
    right.className = 'ahead';
    right.textContent = 'ahead of pace';
    right.title = 'Burning faster than an even spread across the week';
  } else if (window.resetsAt) {
    right.textContent = clockOf(window.resetsAt);
  } else if (window.clock) {
    right.textContent = window.clock;
  }
  legend.appendChild(right);
  rows.appendChild(legend);
  return rows;
}

function accountCard(account) {
  const switching = state.switching != null;
  const isTarget = state.switching === account.number;

  const locked = state.settings.locked;
  const card = el('button', 'card');
  card.type = 'button';
  card.setAttribute('role', 'listitem');
  if (account.active) card.classList.add('active');
  if (locked && !account.active) card.classList.add('locked');
  if (switching && !isTarget) card.classList.add('busy');
  card.dataset.number = String(account.number);

  const head = el('div', 'card-head');
  head.appendChild(el('span', 'dot'));
  head.appendChild(el('span', 'email', label(account)));
  if (isTarget) head.appendChild(el('span', 'tag', 'Switching'));
  else if (account.active) head.appendChild(el('span', 'tag', 'Active'));
  else if (account.disabled) head.appendChild(el('span', 'tag mute', 'Disabled'));
  card.appendChild(head);

  const parts = [`Account ${account.number}`];
  if (account.alias && account.email) parts.push(account.email);
  if (account.organizationName && !account.organizationName.startsWith(account.email)) {
    parts.push(account.organizationName);
  }
  card.appendChild(el('div', 'sub', parts.join(' · ')));

  const usage = account.usage || account.lastGoodUsage || null;
  if (usage && (usage.fiveHour || usage.sevenDay)) {
    if (usage.fiveHour) card.appendChild(metricRow('5h', usage.fiveHour, false));
    if (usage.sevenDay) card.appendChild(metricRow('7d', usage.sevenDay, true));
    if (!account.usage && account.lastGoodFetchedAt) {
      const note = el('div', 'state-note', `Last good reading · ${ago(Date.parse(account.lastGoodFetchedAt))}`);
      card.appendChild(note);
    }
  } else {
    card.appendChild(el('div', 'state-note', STATUS_TEXT[account.usageStatus] || 'Usage unavailable.'));
  }

  card.addEventListener('click', () => {
    if (account.active) {
      toast(`Already on ${label(account)}`);
      return;
    }
    if (state.settings.locked) {
      toast('Locked — open the padlock to switch');
      flashLock();
      return;
    }
    askSwitch(account);
  });
  return card;
}

function renderList() {
  tickNodes = [];
  if (!state.accounts.length) {
    const empty = el('div', 'empty');
    empty.appendChild(
      el('div', null, state.error ? 'No account data.' : 'No accounts are managed yet.')
    );
    const hint = el('div', null, 'Run ');
    hint.appendChild(el('code', null, 'cswap add'));
    hint.append(' in a terminal to register the account you are signed in as.');
    empty.appendChild(hint);
    listEl.replaceChildren(empty);
    return;
  }
  const frag = document.createDocumentFragment();
  for (const account of state.accounts) frag.appendChild(accountCard(account));
  listEl.replaceChildren(frag);
}

function renderStamp() {
  const every =
    state.settings.pollSeconds < 60
      ? `${state.settings.pollSeconds}s`
      : `${state.settings.pollSeconds / 60}m`;
  $('#stamp').textContent = `Updated ${ago(state.lastUpdated)} · auto every ${every}`;
}

/* ------------------------------- settings -------------------------------- */

function applySettings() {
  const s = state.settings;
  const theme = s.theme === 'system' ? (state.meta.darkSystem ? 'dark' : 'light') : s.theme;
  app.dataset.theme = theme;
  // "Solid" means solid: fully opaque, so the popover stays readable even where
  // the Windows backdrop material is unavailable.
  document.documentElement.style.setProperty('--tint', s.material === 'none' ? '1' : String(s.tint));
  // Hand-sized windows stop fitting to content and let the grid take the slack.
  document.body.classList.toggle('sized', Boolean(s.size));
  document.body.classList.toggle('autofit', !s.size);

  // Only rewrite the controls when the values actually moved, so a slider the
  // user is dragging is never yanked back by an echoing state push.
  const signature = JSON.stringify(s);
  if (signature === settingsSignature) return;
  settingsSignature = signature;

  for (const button of document.querySelectorAll('#seg-material button')) {
    button.classList.toggle('on', button.dataset.value === s.material);
  }
  for (const button of document.querySelectorAll('#seg-theme button')) {
    button.classList.toggle('on', button.dataset.value === s.theme);
  }
  setRange('#rng-opacity', Math.round(s.opacity * 100), '#val-opacity', (v) => `${v}%`);
  setRange('#rng-tint', Math.round(s.tint * 100), '#val-tint', (v) => `${v}%`);
  $('#rng-tint').disabled = s.material === 'none';
  $('#chk-launch').checked = s.launchAtLogin;
  $('#chk-ontop').checked = s.alwaysOnTop;
  $('#chk-blur').checked = s.hideOnBlur;
  $('#chk-lock').checked = s.locked;
  $('#chk-confirm').checked = s.confirmSwitch;
  $('#chk-warn').checked = s.warnRunningSessions;
  $('#chk-accent').checked = s.accentUsage;
  $('#sel-poll').value = String(s.pollSeconds);
}

/** Kept out of the settings-signature guard: `meta` fills in asynchronously. */
function renderAbout() {
  const meta = state.meta;
  $('#about-text').textContent = [
    `Claude Swap ${meta.appVersion} · Electron ${meta.electron}`,
    'Adithya N Raj · adithyanraj03@gmail.com',
    meta.cswapVersion || 'cswap version unknown',
    meta.cswapPath || 'cswap not found on PATH',
  ].join('\n');
}

function setRange(selector, value, valueSelector, format) {
  const input = $(selector);
  if (document.activeElement !== input) input.value = String(value);
  $(valueSelector).textContent = format(value);
}

let settingsQueue = null;
/** Coalesce rapid changes (slider drags) into one write per frame-ish. */
function pushSettings(patch) {
  settingsQueue = { ...(settingsQueue || {}), ...patch };
  clearTimeout(pushSettings.timer);
  pushSettings.timer = setTimeout(() => {
    const payload = settingsQueue;
    settingsQueue = null;
    window.api.setSettings(payload);
  }, 70);
}

/* ------------------------------- switching ------------------------------- */

async function askSwitch(account) {
  if (!state.settings.confirmSwitch) {
    doSwitch(account);
    return;
  }
  confirmTarget = account;
  const active = state.accounts.find((a) => a.active);
  $('#confirm-from').textContent = active ? `${active.number} · ${label(active)}` : 'current login';
  $('#confirm-to').textContent = account ? `${account.number} · ${label(account)}` : 'most headroom';

  const note = $('#confirm-note');
  note.className = 'sheet-note';
  note.textContent = 'Your current login is backed up first, so nothing is lost.';
  $('#confirm').hidden = false;
  $('#confirm-go').focus();

  if (state.settings.warnRunningSessions) {
    const live = await window.api.runningSessions();
    if (live.length && !$('#confirm').hidden) {
      note.className = 'sheet-note warn';
      note.textContent =
        `${live.length} Claude Code session${live.length === 1 ? '' : 's'} running. ` +
        'The switch replaces the stored login — restart them to pick it up.';
    }
  }
}

async function doSwitch(account) {
  $('#confirm').hidden = true;
  const outcome = account
    ? await window.api.switchTo(account.number)
    : await window.api.switchBest();
  if (!outcome.ok) {
    toast(outcome.error.message, true);
    return;
  }
  const result = outcome.result || {};
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  toast(warnings.length ? `${result.message} · ${warnings[0]}` : result.message || 'Switched');
}

/** Point at the padlock when a click was refused because of it. */
function flashLock() {
  const button = $('#btn-lock');
  button.classList.remove('nudge');
  void button.offsetWidth;
  button.classList.add('nudge');
}

function toast(text, bad) {
  const node = $('#toast');
  node.textContent = text;
  node.classList.toggle('bad', Boolean(bad));
  node.hidden = false;
  // Restart the entrance animation on a repeat toast.
  node.style.animation = 'none';
  void node.offsetWidth;
  node.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 3600);
}

/* --------------------------------- wiring -------------------------------- */

function setView(view) {
  app.dataset.view = view;
  $('#btn-settings').classList.toggle('on', view === 'settings');
}

function wire() {
  $('#btn-refresh').addEventListener('click', () => window.api.refresh());
  $('#btn-close').addEventListener('click', () => window.api.hide());
  $('#btn-settings').addEventListener('click', () =>
    setView(app.dataset.view === 'settings' ? 'list' : 'settings')
  );
  $('#btn-pin').addEventListener('click', () =>
    pushSettings({ hideOnBlur: !state.settings.hideOnBlur })
  );
  $('#btn-best').addEventListener('click', () => askSwitch(null));

  $('#confirm-cancel').addEventListener('click', () => {
    $('#confirm').hidden = true;
  });
  $('#confirm-go').addEventListener('click', () => doSwitch(confirmTarget));
  $('#confirm').addEventListener('click', (event) => {
    if (event.target === $('#confirm')) $('#confirm').hidden = true;
  });

  $('#seg-material').addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (button) pushSettings({ material: button.dataset.value });
  });
  $('#seg-theme').addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (button) pushSettings({ theme: button.dataset.value });
  });

  $('#rng-opacity').addEventListener('input', (event) => {
    $('#val-opacity').textContent = `${event.target.value}%`;
    pushSettings({ opacity: Number(event.target.value) / 100 });
  });
  $('#rng-tint').addEventListener('input', (event) => {
    const value = Number(event.target.value);
    $('#val-tint').textContent = `${value}%`;
    // Apply locally at once; the persisted write follows debounced.
    if (state.settings.material !== 'none') {
      document.documentElement.style.setProperty('--tint', String(value / 100));
    }
    pushSettings({ tint: value / 100 });
  });
  $('#sel-poll').addEventListener('change', (event) =>
    pushSettings({ pollSeconds: Number(event.target.value) })
  );

  const checks = {
    '#chk-launch': 'launchAtLogin',
    '#chk-ontop': 'alwaysOnTop',
    '#chk-blur': 'hideOnBlur',
    '#chk-lock': 'locked',
    '#chk-confirm': 'confirmSwitch',
    '#chk-warn': 'warnRunningSessions',
    '#chk-accent': 'accentUsage',
  };
  for (const [selector, key] of Object.entries(checks)) {
    $(selector).addEventListener('change', (event) => pushSettings({ [key]: event.target.checked }));
  }

  $('#btn-lock').addEventListener('click', () =>
    pushSettings({ locked: !state.settings.locked })
  );

  $('#btn-tui').addEventListener('click', () => window.api.openTui());
  $('#btn-reset-size').addEventListener('click', () => window.api.resetSize());
  $('#btn-quit').addEventListener('click', () => window.api.quit());

  wireGrip();

  // Specular highlight follows the pointer across whichever card it is over.
  listEl.addEventListener('mousemove', (event) => {
    const card = event.target.closest('.card');
    if (!card) return;
    const rect = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${event.clientX - rect.left}px`);
    card.style.setProperty('--my', `${event.clientY - rect.top}px`);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!$('#confirm').hidden) $('#confirm').hidden = true;
    else if (app.dataset.view === 'settings') setView('list');
    else window.api.hide();
  });
}

/**
 * Corner grip. Screen coordinates and innerWidth/Height are both CSS pixels, so
 * the delta maps straight onto the window size; the main process anchors the
 * bottom-right corner and clamps to the display.
 */
function wireGrip() {
  const grip = $('#grip');
  let origin = null;

  grip.addEventListener('pointerdown', (event) => {
    origin = {
      x: event.screenX,
      y: event.screenY,
      width: window.innerWidth,
      height: window.innerHeight,
    };
    grip.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  grip.addEventListener('pointermove', (event) => {
    if (!origin) return;
    // The grip is the top-left corner: dragging up and left grows the window.
    window.api.resizeAnchored(
      origin.width - (event.screenX - origin.x),
      origin.height - (event.screenY - origin.y)
    );
  });

  const end = (event) => {
    if (!origin) return;
    origin = null;
    try {
      grip.releasePointerCapture(event.pointerId);
    } catch {
      /* pointer already released */
    }
    window.api.resizeCommit();
  };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
  grip.addEventListener('dblclick', () => window.api.resetSize());
}

/* --------------------------------- ticks --------------------------------- */

function tick() {
  if (document.hidden || !state) return;
  for (const entry of tickNodes) {
    entry.node.textContent = `resets in ${countdown(entry.resetsAt)}`;
  }
  renderStamp();
}

/* -------------------------------- lifecycle ------------------------------- */

function fit() {
  if (!state || state.settings.size) return; // hand-sized: the user owns it
  window.api.resize($('#frame').offsetHeight);
}

function boot() {
  wire();

  window.api.onState((next) => {
    state = next;
    render();
  });

  window.api.onShown(() => {
    setView('list');
    listEl.scrollTop = 0;
    document.body.classList.remove('idle');
    render();
  });

  document.addEventListener('visibilitychange', () => {
    document.body.classList.toggle('idle', document.hidden);
  });

  // Any layout change (list grew, view switched, banner appeared) re-fits the
  // window, so the popover is always exactly as tall as its content.
  new ResizeObserver(fit).observe($('#frame'));

  setInterval(tick, 1000);

  window.api.getState().then((initial) => {
    state = initial;
    render();
    fit();
  });
}

boot();
