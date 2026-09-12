'use strict';
/**
 * Which Claude Code instances are running right now.
 *
 * Claude Code drops a PID file per session in ~/.claude/sessions/{pid}.json;
 * reading those is the same mechanism claude-swap's own process detection uses.
 * We surface the count in the switch confirmation, because swapping credentials
 * under a live session is the one thing worth a second look before clicking.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0); // signal 0: existence check only
    return true;
  } catch (err) {
    return err && err.code === 'EPERM'; // exists, owned by someone else
  }
}

/** Live sessions, newest first. Never throws — an empty list is a fine answer. */
function running() {
  const dir = path.join(claudeHome(), 'sessions');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (!isAlive(data.pid)) continue;
      out.push({
        pid: data.pid,
        cwd: data.cwd || '',
        kind: data.kind || 'interactive',
        entrypoint: data.entrypoint || 'cli',
        status: data.status || null,
        name: data.name || '',
        startedAt: data.startedAt || 0,
      });
    } catch {
      /* half-written or stale file — skip it */
    }
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

/** Just the interactive ones — background/daemon workers are not user-visible. */
function runningInteractive() {
  return running().filter((s) => s.kind === 'interactive');
}

module.exports = { running, runningInteractive };
