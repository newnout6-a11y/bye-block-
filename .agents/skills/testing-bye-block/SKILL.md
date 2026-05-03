---
name: testing-bye-block
description: Test the VPN Tunnel Enforcer (Electron app under vpn-tunnel-enforcer/) on Linux even though the production runtime is Windows-only. Use when verifying changes to TUN routing, the system-network baseline, the watchdog/kill-switch, sing-box config generation, or the soft-mode (setx) autoconfig.
---

# Testing bye-block- (VPN Tunnel Enforcer)

This app routes Windows traffic through a SOCKS5/HTTP proxy via sing-box + wintun. Most of its main process spawns Windows-only binaries (`reg`, `netsh`, `setx`, `sing-box.exe`, wintun). On Linux we can still test:

- The renderer UI (Settings/Apps copy, default toggle states, `electron-store` IPC) by launching the real Electron app under xvfb.
- The pure functions in `src/main/tunController.ts` and `src/main/systemNetwork.ts` by bundling them with esbuild and stubbing `electron`, `sudo-prompt`, `child_process`, `./admin`, and `./appLogger`.

## Devin Secrets Needed

None for the Linux-side tests. Real Windows verification requires the user's Windows machine; no secrets need to be passed to Devin for that.

## Where things live

- App root: `vpn-tunnel-enforcer/`
- Main entry: `vpn-tunnel-enforcer/src/main/index.ts`
- Renderer entry: `vpn-tunnel-enforcer/src/renderer/App.tsx`
- Settings store (electron-store): `vpn-tunnel-enforcer/src/main/settings.ts`
- Runtime settings JSON on Linux: `~/.config/vpn-tunnel-enforcer/settings.json`
- Baseline marker file at runtime: `<userData>/network-backups/latest-tun-network-baseline.json`

## Linux UI smoke (real Electron)

1. Kill any leftover dev server: `pkill -f 'electron-vite|electron/dist/electron'`.
2. To test "fresh install" defaults, delete the settings JSON: `rm -f ~/.config/vpn-tunnel-enforcer/settings.json`.
3. Start the dev app on the user-visible desktop (NOT a separate xvfb display, because we want screen recording to capture it):
   ```bash
   cd vpn-tunnel-enforcer && DISPLAY=:0 npm run dev > /tmp/electron-dev.log 2>&1 &
   sleep 12
   ```
4. Maximize the window: `wmctrl -r 'VPN Туннель' -b add,maximized_vert,maximized_horz`. (`apt-get install -y wmctrl` if missing.)
5. The renderer expects `window.electronAPI` from the preload. Don't try to view the vite dev server directly in plain Chrome — IPC calls will fail. Always interact through the actual Electron window.
6. Check the IPC log in `/tmp/electron-dev.log` for `get-settings finished` to confirm the renderer is talking to the main process.

The Electron renderer renders identically on Linux to Windows for layout/copy purposes — what may differ is anything dependent on Windows API state (autoconfig statuses always show "applied: false" because `reg query` returns nothing). For verifying UI copy, default toggle states, and warning banners, Linux is sufficient.

## Pure-function harness for Windows-only main-process code

`src/main/tunController.ts` and `src/main/systemNetwork.ts` import `electron`, `sudo-prompt`, and use `child_process.exec` to call Windows-only commands. To run them on Linux:

1. Outside the repo (don't commit), create stubs:
   - `electron-stub.mjs` — exports `app.getPath('userData')` returning a deterministic temp dir from `process.env.VPNTE_TEST_USERDATA`.
   - `sudo-prompt-stub.mjs` — exports `exec` as a no-op.
   - `child-process-stub.mjs` — exports `exec(cmd, opts, cb)` that returns `(null, '', '')`.
   - `admin-stub.mjs` — exports `execElevated` and `isProcessElevated` as no-op resolves.
   - `applogger-stub.mjs` — exports `logEvent` as a no-op.

2. esbuild's CLI `--alias` does NOT accept relative paths like `./admin`. Use the JS API with a custom `onResolve` plugin instead. Example:

   ```js
   import { build } from 'esbuild'
   const stubMap = { electron: '...', 'sudo-prompt': '...', child_process: '...',
                     './admin': '...', './appLogger': '...' }
   const aliasPlugin = { name: 'alias', setup(b) {
     b.onResolve({ filter: /^.*$/ }, args => stubMap[args.path]
       ? { path: stubMap[args.path] } : undefined)
   }}
   await build({ entryPoints: ['entry.ts'], bundle: true, platform: 'node',
                 format: 'esm', target: 'node20', outfile: 'bundle.js',
                 external: ['electron-store'], plugins: [aliasPlugin] })
   ```

3. Several functions are platform-gated with `if (process.platform !== 'win32') return ...`. On Linux you must spoof platform BEFORE importing the bundle:

   ```js
   Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
   const mod = await import('./bundle.js')
   ```

4. With this setup you can assert on:
   - `generateSingboxConfig(...).dns.servers` — must have exactly 2 entries with tags `dns-remote` and `dns-backup` and `detour: 'proxy-out'`. A regression that re-introduces `dns-local` (DNS leak path) would fail length===2.
   - `generateSingboxConfig(...).route.final === 'proxy-out'` and `inbounds[0].strict_route === true` (kill-switch precondition).
   - `isBaselineApplied()` lifecycle: write a synthetic JSON to `<userData>/network-backups/latest-tun-network-baseline.json`, expect `true`; call `rollbackTunNetworkBaselineIfApplied('test')`, expect `success:true` AND that the marker file is gone AND that `isBaselineApplied()` returns `false`. A regression that forgets to clear the marker after rollback would fail this.

## Things only Windows can verify

When reporting results, mark these as **untested** explicitly. Source-only review is not enough for the user to trust the fix:

- Real `reg import` of the HKCU\Internet Settings backup on TUN stop / app exit.
- Real `setx HTTP_PROXY/HTTPS_PROXY` rollback at app exit (verify via a fresh `cmd`).
- Crash-recovery on startup: stale marker file present + `vpnte-sing-box.exe` not running → app rolls baseline back automatically. Look for log line `stale baseline detected on startup ... rolling back`.
- Watchdog firing under live traffic: kill the upstream Happ proxy while Hard mode is active; status should flip to `proxy-down` and TUN should KEEP capturing traffic (kill-switch). The pre-PR behavior was to tear down the TUN, leaving an open path through the physical adapter.

A short Windows-side checklist to share with the user:
1. Toggle "Авто baseline" → ON → start TUN → stop TUN → `reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable` and `set HTTP_PROXY` should match pre-Hard values.
2. With "Авто baseline" + Hard mode active, force-kill via Task Manager. Restart — Logs page should show stale-baseline rollback.
3. Apps → "Переменные окружения" → Apply, close app, open new `cmd`, `set HTTP_PROXY` should be empty.
4. With Hard mode active, kill upstream proxy → TUN status flips to `proxy-down`, new HTTP fails closed (no leak).

## Common gotchas

- `npm run dev` starts BOTH the vite dev server (port 5173) and Electron. Don't open the vite URL in plain Chrome — the renderer's IPC will throw because there is no `window.electronAPI`.
- The settings JSON is written to `~/.config/vpn-tunnel-enforcer/settings.json` on Linux. Wipe it before each test if you want to verify defaults.
- `electron-vite dev` rebuilds main + preload on file save and respawns Electron — don't fight that, just kill the whole `electron-vite` process group when done.
- Avoid `xdotool key super+Up` to maximize — it tiles instead. Use `wmctrl -r '<title>' -b add,maximized_vert,maximized_horz`.
- Many of the watchdog / autoconfig functions return early on non-Windows. If your harness assertion looks like it didn't do anything, double-check that you spoofed `process.platform` AND aliased `child_process` BEFORE importing the bundle.
