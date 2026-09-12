# Claude Swap — desktop tray app

A Windows 11 tray companion for [`claude-swap`](https://github.com/realiti4/claude-swap).
Left-click the tray icon for a glass popover showing every managed account's 5h/7d
quota; click an account to confirm and switch. Right-click for the full menu.

The CLI stays the source of truth — this app shells out to `cswap … --json` and
renders the result. Nothing about your accounts or credentials is stored here.

By Adithya N Raj · adithyanraj03@gmail.com

## Install

```powershell
npm install
npm run dist      # builds dist/Claude Swap-2.0.0-x64.exe (installer) + portable
```

Or run it straight from source:

```powershell
npm start
```

Requires `claude-swap` on `PATH` (or in `~/.local/bin`). Auto-detected at launch;
override the path in Settings if it lives somewhere unusual.

## What it does

**Tray icon** — a ring showing the active account's 5h usage, coloured green /
amber / red by headroom, with the slot number in the middle. It is redrawn on
every poll, so the taskbar alone tells you where you stand. Hover for a tooltip
with both windows.

**Popover** (left-click) — one card per account: email, slot, organisation, and a
meter for each of the 5h and 7d windows with a live countdown to reset. The 7d
meter carries a tick marking where an even burn rate would have put you by now,
and flags "ahead of pace" when you are over it. Click a non-active card to get a
confirmation sheet, then switch.

**Lock** — the padlock in the header guards against a stray click switching your
account. It is **on by default**: clicking a card while locked just says so and
nudges the padlock, and the tray menu's switch entries grey out. Open the padlock
to switch. Independent of "Confirm before switching", which is the second guard.

**Resizing** — drag any window edge, or the grip in the top-left corner (the
popover hugs the tray corner, so it grows up and to the left). The card grid
reflows as it widens: one column at the default width, two from about 560px,
three from about 830px. Settings go two-column past 620px. Height stops
fitting-to-content once you have sized it by hand; double-click the grip, or use
*Reset size* in Settings or the tray menu, to go back to automatic.

**Menu** (right-click) — switch to a specific account or to whichever has the most
headroom, refresh, open the dashboard, open the `cswap` TUI in a terminal, and
every setting below.

**Auto refresh** — every 60s while the popover is open, every 5 minutes while it is
hidden, plus on show, after any switch, and on wake from sleep. Countdowns tick
locally every second between polls.

## Settings

Reachable from the gear in the popover or the tray menu; stored in
`%APPDATA%\Claude Swap\settings.json`.

| Setting | Default | Notes |
| --- | --- | --- |
| Backdrop | Acrylic | Windows 11 material: Acrylic (blurs the desktop), Mica, or Solid |
| Window opacity | 97% | Whole-window transparency, 45–100% |
| Glass tint | 55% | How strongly the panel is tinted over the backdrop — drop it for more see-through |
| Theme | Dark | Dark, Light, or follow the system |
| Start at login | off | Registers the app to start hidden in the tray |
| Always on top | on | |
| Hide when it loses focus | on | Turn off, or hit the pin, to keep it open while you work |
| Lock switching | **on** | Blocks account switches until you open the padlock |
| Confirm before switching | on | |
| Warn if Claude Code is running | on | Counts live sessions from `~/.claude/sessions` and says so before switching |
| Colour the tray icon by usage | on | Off = monochrome ring |
| Refresh every | 1 minute | 30s – 10 minutes |
| Window size | fit to content | Set by dragging; *Reset size* returns to automatic |

## Rate limits

Anthropic's usage endpoint allows roughly 28–30 requests per hour per identity, and
`claude-swap` paces itself against that: it keeps a shared usage store with a 180s
serve-TTL and per-account `nextPollAt`. Because this app goes through the CLI, a
fast refresh interval re-reads that cache rather than the API — every surface (this
app, the TUI, `cswap auto`) shares one budget. Setting 30s here does not double your
API traffic.

## Layout

```
src/main/
  main.js        app lifecycle, tray, popover window, polling, IPC
  cswap.js       CLI bridge — spawn, JSON parse, error envelopes, in-flight dedupe
  tray-icon.js   the usage ring, re-rendered per poll at five scale factors
  sessions.js    live Claude Code session detection (~/.claude/sessions/*.json)
  settings.js    persisted settings with range clamping
  gfx.js         dependency-free PNG/ICO encoder + SDF rasteriser
  preload.js     context-isolated bridge
src/renderer/    popover UI (no framework, no runtime deps)
tools/
  gen-icons.js   regenerates build/icon.ico and build/icon.png
  capture.js     dev-only: composites a screenshot over a simulated acrylic desktop
```

Icons are generated from code, not checked in as art:

```powershell
npm run icons
```

## Dev

```powershell
npm start -- --shot out.png                    # render the popover to a PNG and exit
npm start -- --shot out.png --view settings    # ...on the settings page
npm start -- --shot out.png --view confirm     # ...with the confirm sheet open
npm start -- --hidden                          # start in the tray without showing
```

There are no runtime dependencies; `electron` and `electron-builder` are the only
devDependencies.
