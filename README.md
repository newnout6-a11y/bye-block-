# VPN Tunnel Enforcer

Force all traffic through VPN Happ — Hard (TUN) or Soft (Autoconfig) mode with IP leak monitoring.

## Features

- **Hard mode (TUN)** — Creates virtual TUN interface via sing-box + Wintun, sends external IPv4/IPv6 + DNS through Happ proxy while keeping localhost/LAN direct.
- **Soft mode (Autoconfig)** — Automatically patches Android Studio, Gradle, Git, and environment variables with proxy settings.
- **Leak diagnostics** — Checks public IPv4/IPv6, proxy reachability, DNS settings, active TUN/VPN adapters, and sing-box log summary.
- **Auto-detect local VPN proxy** — Reads Happ configs, Windows proxy settings, env proxy variables, and live loopback listeners from common VPN/proxy cores.
- **TUN network baseline** — Backs up and resets stale WinHTTP, WinINet/PAC, and env proxy settings so Store/UWP traffic is captured by TUN instead of a dead local proxy.
- **System tray** — Minimizes to tray, icon color changes on status.
- **Microsoft Store repair** — WSReset, Store package reset/re-register, LocalCache backup, Region settings shortcut.
- **Location privacy toggles** — Backs up registry and disables Windows Location API access; rollback restores the latest backup.

## Prerequisites

- Windows 10/11 x64
- [Node.js](https://nodejs.org/) 18+
- A VPN/proxy client with a local HTTP or SOCKS5 listener. Happ is supported, but detection is not hardcoded to Happ only.

## Setup

```bash
cd vpn-tunnel-enforcer
npm install
```

### Download binaries

Before building, download these into `vpn-tunnel-enforcer/resources/`:

1. **sing-box.exe** from https://github.com/SagerNet/sing-box/releases
2. **wintun.dll** from https://www.wintun.net/

## Development

```bash
cd vpn-tunnel-enforcer
npm run dev
```

Opens the Electron app with hot-reload for the renderer.

## Build .exe installer

```bash
cd vpn-tunnel-enforcer
npm run dist:win
```

Output: `dist/VPN-Tunnel-Enforcer-Setup-1.0.0.exe`

Portable build is still available:

```bash
cd vpn-tunnel-enforcer
npm run dist:portable
```

## How it works

### Hard mode
1. Detects Happ's local SOCKS5/HTTP proxy (e.g. `127.0.0.1:2080`) or uses the manual proxy from Settings
2. Generates `sing-box.json` config with TUN inbound → proxy outbound
3. Applies the TUN network baseline by default: `netsh winhttp reset proxy`, disables HKCU WinINet proxy/PAC, removes HKCU env proxy variables, then broadcasts WinINet setting changes. A backup is saved under app user data.
4. Launches `sing-box.exe` with admin rights. Packaged builds request administrator at app startup, so individual admin actions do not need separate prompts.
5. Wintun creates virtual adapter, Windows routes external traffic through it
6. DNS is hijacked into sing-box and sent through the proxy; localhost/private LAN stays direct

### Soft mode
1. Patches Android Studio `other.xml` and `idea.properties`
2. Patches `gradle.properties` with `systemProp.http.proxy*`
3. Sets `HTTP_PROXY`/`HTTPS_PROXY` via `setx`
4. Sets `git config --global http.proxy`
5. All patches are reversible via "Rollback" button (backup files saved)

## Tech stack

- Electron 30 + React 18 + Vite (electron-vite)
- TailwindCSS + custom dark theme
- zustand for state
- lucide-react icons
- sing-box + Wintun for TUN
- sudo-prompt for UAC elevation

## License

MIT
