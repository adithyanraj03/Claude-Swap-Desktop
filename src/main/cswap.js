'use strict';
/**
 * Thin bridge onto the `cswap` CLI.
 *
 * Everything the UI shows comes from `cswap list --json` (schema v1), and every
 * switch goes through `cswap switch <n> --json`. JSON mode is guaranteed
 * non-interactive by the CLI, so these are safe to drive headlessly.
 *
 * Polling cadence is deliberately not our problem: claude-swap keeps a shared
 * usage store with a 180s serve-TTL and per-account `nextPollAt`, so repeated
 * `list` calls read cache instead of hammering the quota endpoint (which has a
 * hard ~28-30 requests/hour budget per identity).
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const EXE_NAMES = ['cswap.exe', 'claude-swap.exe', 'cswap.cmd', 'cswap.bat', 'cswap'];

/** Well-known install locations, checked after PATH. */
function fallbackDirs() {
  const home = os.homedir();
  return [
    path.join(home, '.local', 'bin'),
    path.join(home, 'AppData', 'Roaming', 'uv', 'tools', 'claude-swap', 'Scripts'),
    path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Scripts'),
    path.join(home, '.cargo', 'bin'),
  ];
}

let cachedExe = null;

/** Locate the CLI. `override` (from settings) always wins when it exists. */
function resolveExe(override) {
  if (override && fs.existsSync(override)) return override;
  if (cachedExe && fs.existsSync(cachedExe)) return cachedExe;
  const dirs = [...(process.env.PATH || '').split(path.delimiter), ...fallbackDirs()];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of EXE_NAMES) {
      const candidate = path.join(dir, name);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          cachedExe = candidate;
          return candidate;
        }
      } catch {
        /* unreadable PATH entry — skip */
      }
    }
  }
  return null;
}

/**
 * The CLI prints only JSON to stdout in --json mode, but be forgiving about a
 * stray banner line (e.g. an upgrade notice) by slicing to the outermost braces.
 */
function extractJson(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through to brace slicing */
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}

class CswapError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'CswapError';
    this.detail = detail || '';
  }
}

/** Run the CLI and resolve its parsed JSON payload. */
function run(args, { exePath, timeout = 60000 } = {}) {
  const exe = resolveExe(exePath);
  if (!exe) {
    return Promise.reject(
      new CswapError(
        'cswap not found',
        'Install claude-swap, or set its path in Settings. Looked on PATH and in ~/.local/bin.'
      )
    );
  }
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(exe, args, {
        windowsHide: true, // no console flash on every poll
        env: {
          ...process.env,
          NO_COLOR: '1',
          CLICOLOR: '0',
          TERM: 'dumb',
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
        },
      });
    } catch (err) {
      reject(new CswapError('Could not start cswap', String(err && err.message)));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      done(reject, new CswapError('cswap timed out', `No response after ${timeout / 1000}s.`));
    }, timeout);

    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (err) =>
      done(reject, new CswapError('Could not start cswap', String(err && err.message)))
    );
    child.on('close', (code) => {
      const payload = extractJson(stdout) || extractJson(stderr);
      // A handled CLI failure still emits a structured envelope; prefer its message.
      if (payload && payload.error) {
        done(reject, new CswapError(payload.error.message || 'cswap failed', payload.error.type));
        return;
      }
      if (payload) {
        done(resolve, payload);
        return;
      }
      done(
        reject,
        new CswapError(
          code === 0 ? 'cswap returned no JSON' : `cswap exited with code ${code}`,
          (stderr || stdout).trim().split('\n').slice(0, 4).join('\n')
        )
      );
    });
  });
}

/**
 * `list` is the only call the poller makes. In-flight calls are shared so an
 * interval tick landing on top of a manual refresh spawns one process, not two.
 */
let inflightList = null;

function list(opts = {}) {
  if (inflightList) return inflightList;
  inflightList = run(['list', '--json'], opts).finally(() => {
    inflightList = null;
  });
  return inflightList;
}

function switchTo(target, opts = {}) {
  return run(['switch', String(target), '--json'], { timeout: 120000, ...opts });
}

/** Bare `switch --strategy best|next-available` — pick a target by headroom. */
function switchStrategy(strategy, opts = {}) {
  return run(['switch', '--strategy', strategy, '--json'], { timeout: 120000, ...opts });
}

function status(opts = {}) {
  return run(['status', '--json'], opts);
}

function version(opts = {}) {
  const exe = resolveExe(opts.exePath);
  if (!exe) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = spawn(exe, ['--version'], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      out += d.toString('utf8');
    });
    child.on('error', () => resolve(null));
    child.on('close', () => resolve(out.trim() || null));
    setTimeout(() => resolve(out.trim() || null), 8000);
  });
}

module.exports = {
  CswapError,
  resolveExe,
  list,
  switchTo,
  switchStrategy,
  status,
  version,
  run,
};
