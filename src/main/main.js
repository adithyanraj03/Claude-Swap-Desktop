'use strict';
/**
 * Claude Swap — tray companion for the claude-swap CLI.
 *
 * Lives in the notification area: left-click opens a glass popover anchored to
 * the tray icon, right-click gives the full menu. Everything it shows comes
 * from `cswap list --json`; switching goes through `cswap switch <n> --json`.
 */
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  screen,
  nativeTheme,
  nativeImage,
  dialog,
  shell,
  powerMonitor,
} = require('electron');
const path = require('path');
const { spawn } = require('child_process');

const cswap = require('./cswap');
const sessions = require('./sessions');
const { Settings } = require('./settings');
const { buildTrayImage } = require('./tray-icon');

const DEFAULT_WIDTH = 392;
const MIN_WIDTH = 330;
const MAX_WIDTH = 1500;
const MIN_HEIGHT = 220;
const MAX_HEIGHT = 900;
const TRAY_GAP = 10;

let tray = null;
let win = null;
let settings = null;
let pollTimer = null;
let refreshing = false;
let quitting = false;
let lastTrayKey = '';
let cswapVersion = null;
let placing = false; // suppress our own geometry events
let movedTo = null; // where the user dragged it, for this run only

const state = {
  accounts: [],
  activeAccountNumber: null,
  loading: false,
  switching: null, // account number currently being switched to
  error: null,
  lastUpdated: null,
};

/* --------------------------- state plumbing ---------------------------- */

function activeAccount() {
  return state.accounts.find((a) => a.active) || null;
}

/** Five-hour usage percentage, falling back to the last good measurement. */
function fiveHourPct(account) {
  const usage = account && (account.usage || account.lastGoodUsage);
  const pct = usage && usage.fiveHour && usage.fiveHour.pct;
  return Number.isFinite(pct) ? pct : null;
}

function publicState() {
  return {
    accounts: state.accounts,
    activeAccountNumber: state.activeAccountNumber,
    loading: state.loading,
    switching: state.switching,
    error: state.error,
    lastUpdated: state.lastUpdated,
    settings: settings.all,
    meta: {
      appVersion: app.getVersion(),
      electron: process.versions.electron,
      cswapPath: cswap.resolveExe(settings.get('cswapPath')) || '',
      cswapVersion,
      darkSystem: nativeTheme.shouldUseDarkColors,
    },
  };
}

function pushState() {
  if (win && !win.isDestroyed()) win.webContents.send('state', publicState());
}

/* ------------------------------- tray ---------------------------------- */

function updateTray() {
  if (!tray) return;
  const active = activeAccount();
  const pct = fiveHourPct(active);
  const slot = active ? active.number : null;
  const busy = state.loading || state.switching != null;
  const colored = settings.get('accentUsage');
  const dark = nativeTheme.shouldUseDarkColors;

  // Re-rendering five PNGs is cheap but not free — only redraw on real change.
  const key = [pct, slot, busy, colored, dark, state.error ? 1 : 0].join('|');
  if (key !== lastTrayKey) {
    lastTrayKey = key;
    tray.setImage(buildTrayImage({ pct, slot, dark, busy, colored }));
  }

  const lines = ['Claude Swap'];
  if (state.error) {
    lines.push(state.error.message);
  } else if (active) {
    const usage = active.usage || active.lastGoodUsage || {};
    const five = usage.fiveHour ? `5h ${Math.round(usage.fiveHour.pct)}%` : '5h —';
    const seven = usage.sevenDay ? `7d ${Math.round(usage.sevenDay.pct)}%` : '7d —';
    lines.push(`${active.number} · ${active.alias || active.email}`, `${five}   ${seven}`);
  } else {
    lines.push('No active account');
  }
  tray.setToolTip(lines.join('\n'));
}

/** Short label for a menu row: "2 · someone@example.com — 5h 27%". */
function accountLabel(account) {
  const usage = account.usage || account.lastGoodUsage;
  const bits = [`${account.number} · ${account.alias || account.email}`];
  if (usage && usage.fiveHour) bits.push(`5h ${Math.round(usage.fiveHour.pct)}%`);
  else if (account.usageStatus && account.usageStatus !== 'ok')
    bits.push(account.usageStatus.replace(/_/g, ' '));
  if (account.disabled) bits.push('disabled');
  return bits.join('  —  ');
}

function buildMenu() {
  const active = activeAccount();
  const has = state.accounts.length > 0;
  const locked = Boolean(settings.get('locked'));

  const switchItems = state.accounts.map((account) => ({
    label: accountLabel(account),
    type: 'checkbox',
    checked: Boolean(account.active),
    enabled: !account.active && state.switching == null && !locked,
    click: () => requestSwitchFromMenu(account),
  }));

  const appearance = (key, value, label) => ({
    label,
    type: 'radio',
    checked: settings.get(key) === value,
    click: () => {
      settings.set({ [key]: value });
      applyAppearance();
      pushState();
      updateMenu();
    },
  });

  const toggle = (key, label, after) => ({
    label,
    type: 'checkbox',
    checked: Boolean(settings.get(key)),
    click: (item) => {
      settings.set({ [key]: item.checked });
      if (after) after();
      pushState();
    },
  });

  return Menu.buildFromTemplate([
    {
      label: active ? `Active: ${active.alias || active.email}` : 'No active account',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: locked ? 'Switch to  (locked)' : 'Switch to',
      enabled: has,
      submenu: switchItems.length ? switchItems : [{ label: 'No accounts', enabled: false }],
    },
    {
      label: 'Switch to most headroom',
      enabled: state.accounts.length > 1 && state.switching == null && !locked,
      click: () => requestSwitchFromMenu(null),
    },
    {
      label: 'Lock switching',
      type: 'checkbox',
      checked: locked,
      click: (item) => {
        settings.set({ locked: item.checked });
        pushState();
        updateMenu();
      },
    },
    { type: 'separator' },
    { label: 'Open dashboard', click: () => showPopover() },
    {
      label: state.loading ? 'Refreshing…' : 'Refresh now',
      enabled: !state.loading,
      click: () => refresh(),
    },
    { label: 'Open cswap TUI in a terminal', click: () => openTui() },
    { type: 'separator' },
    {
      label: 'Settings',
      submenu: [
        toggle('launchAtLogin', 'Start at login', applyLoginItem),
        toggle('alwaysOnTop', 'Always on top', applyAppearance),
        toggle('hideOnBlur', 'Hide when it loses focus'),
        toggle('confirmSwitch', 'Confirm before switching'),
        toggle('warnRunningSessions', 'Warn if Claude Code is running'),
        toggle('locked', 'Lock switching', updateMenu),
        toggle('accentUsage', 'Colour the tray icon by usage', () => {
          lastTrayKey = '';
          updateTray();
        }),
        { type: 'separator' },
        {
          label: 'Backdrop',
          submenu: [
            appearance('material', 'acrylic', 'Acrylic (blurred)'),
            appearance('material', 'mica', 'Mica (desktop tint)'),
            appearance('material', 'none', 'Solid'),
          ],
        },
        {
          label: 'Window opacity',
          submenu: [1, 0.97, 0.93, 0.88, 0.8, 0.7, 0.6].map((value) =>
            appearance('opacity', value, `${Math.round(value * 100)}%`)
          ),
        },
        {
          label: 'Refresh every',
          submenu: [30, 60, 120, 300, 600].map((value) =>
            appearance('pollSeconds', value, value < 60 ? `${value} seconds` : `${value / 60} minutes`)
          ),
        },
        { type: 'separator' },
        {
          label: 'Reset window size',
          enabled: Boolean(settings.get('size')),
          click: () => resetSize(),
        },
        {
          label: 'Snap back to tray icon',
          enabled: Boolean(movedTo),
          click: () => {
            movedTo = null;
            positionNearTray();
            updateMenu();
          },
        },
      ],
    },
    { type: 'separator' },
    { label: `Claude Swap ${app.getVersion()} — Adithya N Raj`, enabled: false },
    { label: 'Quit', click: () => quit() },
  ]);
}

function updateMenu() {
  if (tray) tray.setContextMenu(buildMenu());
}

/* ------------------------------ window --------------------------------- */

function createWindow() {
  const saved = settings.get('size');
  win = new BrowserWindow({
    width: saved ? saved.width : DEFAULT_WIDTH,
    height: saved ? saved.height : 420,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    maxWidth: MAX_WIDTH,
    maxHeight: MAX_HEIGHT,
    show: false,
    frame: false,
    // `transparent` must stay false for backgroundMaterial to take effect on
    // Windows 11; the zero-alpha backgroundColor is what lets it show through.
    transparent: false,
    backgroundColor: '#00000000',
    backgroundMaterial: settings.get('material'),
    // Resizable: the card grid reflows into more columns as it widens.
    resizable: true,
    movable: true, // drag it by the header; see movedTo below
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: settings.get('alwaysOnTop'),
    roundedCorners: true,
    hasShadow: true,
    icon: path.join(__dirname, '..', '..', 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.setMenu(null);

  win.on('blur', () => {
    if (!settings.get('hideOnBlur')) return;
    if (win.webContents.isDevToolsOpened()) return;
    hidePopover();
  });

  // The window outlives its "close": this is a tray app.
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    hidePopover();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Dragged by hand: stay there instead of snapping back to the tray on every
  // open. Deliberately not persisted — a restart returns to the tray icon.
  win.on('moved', () => {
    if (placing || win.isDestroyed() || !win.isVisible()) return;
    const [x, y] = win.getPosition();
    movedTo = { x, y };
    updateMenu();
  });

  // A hand-resize switches the popover out of fit-to-content mode for good
  // (until Reset window size), so the renderer lets the grid take the slack.
  win.on('resized', () => {
    if (placing || win.isDestroyed()) return;
    const { width, height } = win.getBounds();
    settings.set({ size: { width, height } });
    pushState();
    updateMenu();
  });

  applyAppearance();
}

function applyAppearance() {
  if (!win || win.isDestroyed()) return;
  const s = settings.all;
  try {
    win.setBackgroundMaterial(s.material);
  } catch {
    /* older Windows: material simply isn't available */
  }
  win.setOpacity(s.opacity);
  win.setAlwaysOnTop(Boolean(s.alwaysOnTop));
}

/**
 * Anchor the popover to the tray icon: above it on a bottom taskbar, below it
 * on a top one, clamped into the work area. Falls back to the corner nearest
 * the cursor when the icon is hidden in the overflow flyout (zero bounds).
 */
function positionNearTray() {
  if (!win || win.isDestroyed()) return;
  const size = win.getBounds();

  // Somewhere the user put it by hand wins over the tray anchor.
  if (movedTo) {
    const work = screen.getDisplayNearestPoint(movedTo).workArea;
    placing = true;
    win.setPosition(
      Math.min(Math.max(movedTo.x, work.x), work.x + work.width - size.width),
      Math.min(Math.max(movedTo.y, work.y), work.y + work.height - size.height),
      false
    );
    setImmediate(() => {
      placing = false;
    });
    return;
  }

  const trayBounds = tray ? tray.getBounds() : null;
  const hasTray = trayBounds && trayBounds.width > 0 && trayBounds.height > 0;
  const point = hasTray
    ? { x: trayBounds.x, y: trayBounds.y }
    : screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  const work = display.workArea;

  let x;
  let y;
  if (hasTray) {
    x = Math.round(trayBounds.x + trayBounds.width / 2 - size.width / 2);
    const trayIsTop = trayBounds.y + trayBounds.height / 2 < work.y + work.height / 2;
    y = trayIsTop
      ? Math.round(trayBounds.y + trayBounds.height + TRAY_GAP)
      : Math.round(trayBounds.y - size.height - TRAY_GAP);
  } else {
    x = work.x + work.width - size.width - TRAY_GAP;
    y = work.y + work.height - size.height - TRAY_GAP;
  }

  x = Math.min(Math.max(x, work.x + TRAY_GAP), work.x + work.width - size.width - TRAY_GAP);
  y = Math.min(Math.max(y, work.y + TRAY_GAP), work.y + work.height - size.height - TRAY_GAP);
  placing = true;
  win.setPosition(x, y, false);
  setImmediate(() => {
    placing = false;
  });
}

/** The work area of whichever display the popover lives on. */
function currentWorkArea() {
  const bounds = tray && tray.getBounds().width ? tray.getBounds() : null;
  return screen.getDisplayNearestPoint(bounds || screen.getCursorScreenPoint()).workArea;
}

/** Apply a size, clamped to the display, and remember it as hand-set. */
function applySize(width, height, { anchorBottomRight = false } = {}) {
  if (!win || win.isDestroyed()) return;
  const work = currentWorkArea();
  const w = Math.round(
    Math.min(Math.min(MAX_WIDTH, work.width - TRAY_GAP * 2), Math.max(MIN_WIDTH, width))
  );
  const h = Math.round(
    Math.min(Math.min(MAX_HEIGHT, work.height - TRAY_GAP * 2), Math.max(MIN_HEIGHT, height))
  );
  const b = win.getBounds();
  placing = true;
  if (anchorBottomRight) {
    // The grip sits top-left and the popover hugs the tray corner, so growing
    // it has to push out into the free space rather than off the screen edge.
    const right = b.x + b.width;
    const bottom = b.y + b.height;
    win.setBounds({
      x: Math.max(work.x, right - w),
      y: Math.max(work.y, bottom - h),
      width: w,
      height: h,
    });
  } else {
    win.setSize(w, h, false);
  }
  setImmediate(() => {
    placing = false;
  });
}

/** Forget the hand-set size and go back to fitting the content. */
function resetSize() {
  settings.set({ size: null });
  applySize(DEFAULT_WIDTH, MIN_HEIGHT);
  pushState();
  if (win && win.isVisible()) positionNearTray();
  updateMenu();
}

function showPopover() {
  if (!win || win.isDestroyed()) return;
  positionNearTray();
  win.show();
  win.focus();
  win.webContents.send('shown');
  refresh();
  reschedulePoll();
}

function hidePopover() {
  if (win && !win.isDestroyed() && win.isVisible()) {
    win.hide();
    reschedulePoll();
  }
}

function togglePopover() {
  if (win && win.isVisible()) hidePopover();
  else showPopover();
}

/* ------------------------------ polling -------------------------------- */

function reschedulePoll() {
  clearTimeout(pollTimer);
  const visible = Boolean(win && win.isVisible());
  const seconds = visible ? settings.get('pollSeconds') : settings.get('idlePollSeconds');
  pollTimer = setTimeout(() => {
    refresh().finally(reschedulePoll);
  }, Math.max(15, seconds) * 1000);
}

/**
 * Pull the account list. Failures keep the previous data on screen behind an
 * error banner — a stale reading beats an empty window.
 */
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  state.loading = true;
  pushState();
  updateTray();
  try {
    const payload = await cswap.list({ exePath: settings.get('cswapPath') });
    state.accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
    state.activeAccountNumber = payload.activeAccountNumber ?? null;
    state.error = null;
    state.lastUpdated = Date.now();
  } catch (err) {
    state.error = { message: err.message || String(err), detail: err.detail || '' };
  } finally {
    state.loading = false;
    refreshing = false;
    pushState();
    updateTray();
    updateMenu();
  }
}

/* ------------------------------ switching ------------------------------ */

/** Run a switch and refresh. `target` null means "best headroom". */
async function performSwitch(target) {
  if (settings.get('locked')) {
    return {
      ok: false,
      error: {
        message: 'Switching is locked',
        detail: 'Open the padlock in the popover (or the tray menu) to allow switching.',
      },
    };
  }
  state.switching = target == null ? -1 : target;
  pushState();
  updateTray();
  updateMenu();
  try {
    const opts = { exePath: settings.get('cswapPath') };
    const result =
      target == null ? await cswap.switchStrategy('best', opts) : await cswap.switchTo(target, opts);
    state.switching = null;
    await refresh();
    return { ok: true, result };
  } catch (err) {
    state.switching = null;
    pushState();
    updateTray();
    updateMenu();
    return { ok: false, error: { message: err.message || String(err), detail: err.detail || '' } };
  }
}

/** Count of live interactive Claude Code sessions, or 0 when the check is off. */
function liveSessionCount() {
  if (!settings.get('warnRunningSessions')) return 0;
  try {
    return sessions.runningInteractive().length;
  } catch {
    return 0;
  }
}

/** The tray menu confirms with a native dialog; the popover does it inline. */
async function requestSwitchFromMenu(account) {
  if (settings.get('locked')) return;
  const name = account ? `Account ${account.number} (${account.alias || account.email})` : 'the account with the most headroom';
  if (settings.get('confirmSwitch')) {
    const live = liveSessionCount();
    const detailLines = [];
    if (live > 0) {
      detailLines.push(
        `${live} Claude Code session${live === 1 ? ' is' : 's are'} running. ` +
          'Switching replaces the stored login; restart them to pick it up.'
      );
    }
    const { response } = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Switch', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Claude Swap',
      message: `Switch to ${name}?`,
      detail: detailLines.join('\n') || undefined,
      icon: nativeImage.createFromPath(path.join(__dirname, '..', '..', 'build', 'icon.ico')),
    });
    if (response !== 0) return;
  }
  const outcome = await performSwitch(account ? account.number : null);
  if (!outcome.ok) {
    dialog.showMessageBox({
      type: 'error',
      title: 'Claude Swap',
      message: 'Switch failed',
      detail: [outcome.error.message, outcome.error.detail].filter(Boolean).join('\n\n'),
    });
  }
}

/* --------------------------- login item, TUI --------------------------- */

/** The argv shape the login-item entry uses, in dev and packaged alike. */
function loginItemOptions() {
  const opts = { path: process.execPath, args: ['--hidden'] };
  if (!app.isPackaged) opts.args = [app.getAppPath(), '--hidden'];
  return opts;
}

function applyLoginItem() {
  const opts = loginItemOptions();
  app.setLoginItemSettings({ ...opts, openAtLogin: Boolean(settings.get('launchAtLogin')) });
}

/** The OS is the source of truth — the user may have removed the entry. */
function syncLoginItem() {
  try {
    const actual = app.getLoginItemSettings(loginItemOptions()).openAtLogin;
    if (actual !== settings.get('launchAtLogin')) settings.set({ launchAtLogin: actual });
  } catch {
    /* not fatal */
  }
}

function openTui() {
  const exe = cswap.resolveExe(settings.get('cswapPath'));
  if (!exe) {
    dialog.showMessageBox({
      type: 'error',
      title: 'Claude Swap',
      message: 'cswap not found',
      detail: 'Install claude-swap, or point at it from Settings.',
    });
    return;
  }
  // `start` needs an explicit (possibly empty) title before a quoted command.
  const command = `start "Claude Swap" cmd /k ""${exe}" tui"`;
  try {
    const child = spawn(command, { shell: true, detached: true, stdio: 'ignore' });
    child.unref();
  } catch (err) {
    dialog.showMessageBox({
      type: 'error',
      title: 'Claude Swap',
      message: 'Could not open a terminal',
      detail: String(err && err.message),
    });
  }
}

/**
 * Dev only: `electron . --shot <file> [--view settings|confirm]` renders the
 * popover, writes a composited PNG and exits. Never present in a packaged
 * build (tools/ is not shipped), hence the guarded require.
 */
function maybeCaptureForDev() {
  const index = process.argv.indexOf('--shot');
  if (index === -1) return;
  const out = process.argv[index + 1];
  const viewIndex = process.argv.indexOf('--view');
  const view = viewIndex === -1 ? null : process.argv[viewIndex + 1];
  const delay = Number(process.argv[process.argv.indexOf('--delay') + 1]) || 2600;

  // Surface renderer errors that would otherwise fail silently.
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') {
      console.error(`[renderer:${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`);
    }
  });
  win.webContents.on('preload-error', (_e, file, error) =>
    console.error('[preload]', file, error && error.message)
  );

  setTimeout(async () => {
    try {
      if (view) {
        await win.webContents.executeJavaScript(
          view === 'confirm'
            ? "document.querySelector('.card:not(.active)').click(); 'ok'"
            : `document.querySelector('#btn-settings').click(); 'ok'`
        );
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
      const capture = require('../../tools/capture');
      const info = await capture(win, out, settings.get('opacity'));
      console.log(`[shot] ${info.out} ${info.width}x${info.height}`);
    } catch (err) {
      console.error('[shot] failed:', err && err.message);
    }
    quit();
  }, delay);
}

function quit() {
  quitting = true;
  clearTimeout(pollTimer);
  if (tray) tray.destroy();
  app.quit();
}

/* -------------------------------- IPC ---------------------------------- */

function registerIpc() {
  ipcMain.handle('get-state', () => publicState());
  ipcMain.handle('refresh', async () => {
    await refresh();
    return publicState();
  });
  ipcMain.handle('switch', (_event, target) => performSwitch(Number(target)));
  ipcMain.handle('switch-best', () => performSwitch(null));
  ipcMain.handle('running-sessions', () => {
    try {
      return sessions.runningInteractive();
    } catch {
      return [];
    }
  });
  ipcMain.handle('set-settings', (_event, patch) => {
    const before = settings.all;
    const next = settings.set(patch || {});
    applyAppearance();
    if (next.launchAtLogin !== before.launchAtLogin) applyLoginItem();
    if (next.accentUsage !== before.accentUsage) {
      lastTrayKey = '';
      updateTray();
    }
    if (next.pollSeconds !== before.pollSeconds || next.idlePollSeconds !== before.idlePollSeconds) {
      reschedulePoll();
    }
    updateMenu();
    pushState();
    return next;
  });
  ipcMain.handle('open-tui', () => {
    openTui();
    return true;
  });
  ipcMain.handle('open-external', (_event, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
    return true;
  });

  ipcMain.on('hide', () => hidePopover());
  ipcMain.on('quit', () => quit());
  // Fit-to-content height. Ignored once the user has sized the window by hand.
  ipcMain.on('resize', (_event, height) => {
    if (!win || win.isDestroyed() || settings.get('size')) return;
    const ceiling = Math.min(MAX_HEIGHT, currentWorkArea().height - TRAY_GAP * 4);
    const target = Math.min(ceiling, Math.max(MIN_HEIGHT, Math.round(height)));
    const current = win.getBounds();
    if (Math.abs(current.height - target) < 2) return;
    placing = true;
    win.setSize(current.width, target, false);
    setImmediate(() => {
      placing = false;
    });
    if (win.isVisible()) positionNearTray();
  });

  // Live drag of the corner grip; the bottom-right corner stays put.
  ipcMain.on('resize-anchored', (_event, width, height) => {
    applySize(width, height, { anchorBottomRight: true });
  });

  ipcMain.on('resize-commit', () => {
    if (!win || win.isDestroyed()) return;
    const { width, height } = win.getBounds();
    settings.set({ size: { width, height } });
    pushState();
    updateMenu();
  });

  ipcMain.on('reset-size', () => resetSize());
}

/* ------------------------------- startup ------------------------------- */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showPopover());

  app.setAppUserModelId('com.adithya.claudeswap');
  // A tray app has no windows most of the time; that must not end the process.
  app.on('window-all-closed', () => {});

  app.whenReady().then(() => {
    settings = new Settings(path.join(app.getPath('userData'), 'settings.json'));
    syncLoginItem();

    registerIpc();
    createWindow();

    tray = new Tray(buildTrayImage({ pct: null, slot: null, dark: nativeTheme.shouldUseDarkColors }));
    tray.setToolTip('Claude Swap');
    tray.on('click', () => togglePopover());
    tray.on('double-click', () => showPopover());
    updateMenu();

    nativeTheme.on('updated', () => {
      lastTrayKey = '';
      updateTray();
      pushState();
    });
    powerMonitor.on('resume', () => refresh());

    cswap.version({ exePath: settings.get('cswapPath') }).then((v) => {
      cswapVersion = v;
      pushState();
    });

    refresh().finally(reschedulePoll);

    // Launched by hand → show the popover. Launched by the login item → stay quiet.
    if (!process.argv.includes('--hidden')) {
      win.once('ready-to-show', () => showPopover());
    }

    maybeCaptureForDev();
  });

  app.on('before-quit', () => {
    quitting = true;
  });
}
