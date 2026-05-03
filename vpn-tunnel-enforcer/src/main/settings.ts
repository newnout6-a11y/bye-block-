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
  autoNetworkBaseline: true
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
    autoNetworkBaseline: merged.autoNetworkBaseline !== false
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
