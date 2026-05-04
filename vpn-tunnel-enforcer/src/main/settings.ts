import { app } from 'electron'
import Store from 'electron-store'
import { execElevated } from './admin'

export interface AppSettings {
  routingMode: 'compatible'
  proxyOverride: string
  proxyType: 'socks5' | 'http'
  checkInterval: number
  autoStart: boolean
  autoPilotEnabled: boolean
  minimizeToTray: boolean
  locationPrivacyEnabled: boolean
  autoNetworkBaseline: boolean
  firewallKillSwitch: boolean
  // When false, the renderer hides every advanced/destructive option:
  // Maintenance page, Apps autoconfig page, autoNetworkBaseline toggle,
  // proxyOverride field, mode picker. Default is false so a fresh user only
  // sees the big "вкл./выкл. защиты" hero on Dashboard.
  advancedMode: boolean
  // Flips to true after the first-run wizard completes (or the user dismisses
  // it). Until then the wizard overlay is shown.
  firstRunComplete: boolean
  // Автоперезапуск sing-box при крахе (PR #6 фича). On by default — most
  // "упал" cases (transient AV interference, OOM) recover with one retry
  // before we hand the user a banner.
  autoRestartOnCrash: boolean
  // Show Windows toast notifications on state changes (TUN up/down, leak,
  // kill-switch engaged). On by default.
  desktopNotifications: boolean
  // Hard adapter lockdown: while TUN is up, disable IPv6 + force IPv4 DNS to
  // the TUN resolver on every physical (Wired/Wireless) adapter. Catches
  // leaks the firewall kill-switch alone misses (DNS-over-HTTPS bypassing
  // NRPT, IPv6 default-route preference, etc.). On by default — it's
  // invasive but reverted on stop, and without it real-world users still see
  // their original ISP IP in some apps.
  strictAdapterLockdown: boolean
}

const defaults: AppSettings = {
  routingMode: 'compatible',
  proxyOverride: '',
  proxyType: 'socks5',
  checkInterval: 30000,
  autoStart: false,
  autoPilotEnabled: true,
  minimizeToTray: true,
  locationPrivacyEnabled: false,
  // Off by default — wiping HKCU\Internet Settings + WinHTTP + env proxies is destructive
  // and not actually required for TUN to capture traffic at the routing layer. Users who
  // need to fix UWP/Store traffic capture can opt in via Settings → "Auto baseline".
  autoNetworkBaseline: false,
  // On by default — this is the only thing that turns "all traffic should go through VPN"
  // from a routing convention into a real guarantee. Without it, sing-box dying for any
  // reason (crash, OOM, killed by AV) instantly drops traffic onto the physical adapter.
  firewallKillSwitch: true,
  advancedMode: false,
  firstRunComplete: false,
  autoRestartOnCrash: true,
  desktopNotifications: true,
  strictAdapterLockdown: true
}

const store = new Store<{ settings: AppSettings }>({
  name: 'settings',
  defaults: { settings: defaults }
})

function normalizeSettings(input: Partial<AppSettings> | undefined): AppSettings {
  const merged = { ...defaults, ...(input ?? {}) }
  return {
    routingMode: 'compatible',
    proxyOverride: typeof merged.proxyOverride === 'string' ? merged.proxyOverride.trim() : '',
    proxyType: merged.proxyType === 'http' ? 'http' : 'socks5',
    checkInterval: Math.min(300000, Math.max(5000, Number(merged.checkInterval) || defaults.checkInterval)),
    autoStart: Boolean(merged.autoStart),
    autoPilotEnabled: merged.autoPilotEnabled !== false,
    minimizeToTray: Boolean(merged.minimizeToTray),
    locationPrivacyEnabled: Boolean(merged.locationPrivacyEnabled),
    autoNetworkBaseline: Boolean(merged.autoNetworkBaseline),
    firewallKillSwitch: merged.firewallKillSwitch !== false,
    advancedMode: Boolean(merged.advancedMode),
    firstRunComplete: Boolean(merged.firstRunComplete),
    autoRestartOnCrash: merged.autoRestartOnCrash !== false,
    desktopNotifications: merged.desktopNotifications !== false,
    strictAdapterLockdown: merged.strictAdapterLockdown !== false
  }
}

function applyLoginItem(autoStart: boolean) {
  if (process.platform === 'win32' && app.isPackaged) {
    const taskName = 'VPN Tunnel Enforcer'
    const exe = `\\"${process.execPath.replace(/"/g, '\\"')}\\"`
    app.setLoginItemSettings({ openAtLogin: false })

    const command = autoStart
      ? `schtasks /Create /TN "${taskName}" /SC ONLOGON /RL HIGHEST /TR "${exe}" /F`
      : `schtasks /Delete /TN "${taskName}" /F`

    execElevated(command, { timeout: 15000 }).catch(() => undefined)
    return
  }

  app.setLoginItemSettings({
    openAtLogin: autoStart,
    path: process.execPath,
    args: []
  })
}

export const settingsStore = {
  get(): AppSettings {
    return normalizeSettings(store.get('settings'))
  },

  save(partial: Partial<AppSettings>): AppSettings {
    const settings = normalizeSettings({ ...normalizeSettings(store.get('settings')), ...partial })
    store.set('settings', settings)
    applyLoginItem(settings.autoStart)
    return settings
  },

  setLoginItem(openAtLogin: boolean): AppSettings {
    const settings = normalizeSettings({ ...normalizeSettings(store.get('settings')), autoStart: openAtLogin })
    store.set('settings', settings)
    applyLoginItem(settings.autoStart)
    return settings
  },

  syncLoginItem() {
    applyLoginItem(this.get().autoStart)
  }
}
