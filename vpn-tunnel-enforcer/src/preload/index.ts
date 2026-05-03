import { contextBridge, ipcRenderer } from 'electron'

export interface ElectronAPI {
  detectHapp: () => Promise<any>
  getPublicIp: () => Promise<{ ip: string | null; isLeak: boolean; vpnIp: string | null }>
  startTun: (proxyAddr: string, proxyType?: 'socks5' | 'http') => Promise<{ success: boolean; error?: string; warning?: string | null; vpnIp?: string | null }>
  stopTun: () => Promise<{ success: boolean; error?: string }>
  getTunStatus: () => Promise<{ running: boolean; proxyAddr: string | null; proxyType: 'socks5' | 'http' | null; pid: number | null; warning?: string | null }>
  applyAutoconfig: (targets: string[], proxyAddr: string) => Promise<Record<string, boolean>>
  rollbackAutoconfig: (targets: string[]) => Promise<Record<string, boolean>>
  getAutoconfigStatus: () => Promise<any[]>
  getSettings: () => Promise<any>
  saveSettings: (settings: any) => Promise<any>
  setLoginItem: (openAtLogin: boolean) => Promise<any>
  runLeakCheck: (options?: { proxyAddr?: string; proxyType?: 'socks5' | 'http' }) => Promise<any>
  runStoreRepair: (action: string) => Promise<any>
  runStoreDiagnostics: () => Promise<any>
  runSystemDiagnostics: () => Promise<any>
  getRoutingPlan: () => Promise<any>
  runAutoPilot: () => Promise<any>
  logRenderer: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => Promise<any>
  getFullLogs: () => Promise<any>
  clearAppLog: () => Promise<any>
  applyTunNetworkBaseline: () => Promise<any>
  rollbackTunNetworkBaseline: () => Promise<any>
  getLocationPrivacy: () => Promise<any>
  applyLocationPrivacy: () => Promise<any>
  rollbackLocationPrivacy: () => Promise<any>
  openTunLogFolder: () => Promise<string>
  openLogFolder: () => Promise<string>
  onIpChanged: (callback: (data: { ip: string; isLeak: boolean }) => void) => () => void
  onTunStatusChanged: (callback: (status: string) => void) => () => void
}

contextBridge.exposeInMainWorld('electronAPI', {
  detectHapp: () => ipcRenderer.invoke('detect-happ'),
  getPublicIp: () => ipcRenderer.invoke('get-public-ip'),
  startTun: (proxyAddr: string, proxyType?: 'socks5' | 'http') => ipcRenderer.invoke('start-tun', proxyAddr, proxyType),
  stopTun: () => ipcRenderer.invoke('stop-tun'),
  getTunStatus: () => ipcRenderer.invoke('get-tun-status'),
  applyAutoconfig: (targets: string[], proxyAddr: string) => ipcRenderer.invoke('apply-autoconfig', targets, proxyAddr),
  rollbackAutoconfig: (targets: string[]) => ipcRenderer.invoke('rollback-autoconfig', targets),
  getAutoconfigStatus: () => ipcRenderer.invoke('get-autoconfig-status'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings: any) => ipcRenderer.invoke('save-settings', settings),
  setLoginItem: (openAtLogin: boolean) => ipcRenderer.invoke('set-login-item', openAtLogin),
  runLeakCheck: (options?: { proxyAddr?: string; proxyType?: 'socks5' | 'http' }) => ipcRenderer.invoke('run-leak-check', options),
  runStoreRepair: (action: string) => ipcRenderer.invoke('run-store-repair', action),
  runStoreDiagnostics: () => ipcRenderer.invoke('run-store-diagnostics'),
  runSystemDiagnostics: () => ipcRenderer.invoke('run-system-diagnostics'),
  getRoutingPlan: () => ipcRenderer.invoke('get-routing-plan'),
  runAutoPilot: () => ipcRenderer.invoke('run-auto-pilot'),
  logRenderer: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => ipcRenderer.invoke('renderer-log', level, message),
  getFullLogs: () => ipcRenderer.invoke('get-full-logs'),
  clearAppLog: () => ipcRenderer.invoke('clear-app-log'),
  applyTunNetworkBaseline: () => ipcRenderer.invoke('apply-tun-network-baseline'),
  rollbackTunNetworkBaseline: () => ipcRenderer.invoke('rollback-tun-network-baseline'),
  getLocationPrivacy: () => ipcRenderer.invoke('get-location-privacy'),
  applyLocationPrivacy: () => ipcRenderer.invoke('apply-location-privacy'),
  rollbackLocationPrivacy: () => ipcRenderer.invoke('rollback-location-privacy'),
  openTunLogFolder: () => ipcRenderer.invoke('open-tun-log-folder'),
  openLogFolder: () => ipcRenderer.invoke('open-log-folder'),
  onIpChanged: (callback: (data: { ip: string; isLeak: boolean }) => void) => {
    const handler = (_event: any, data: { ip: string; isLeak: boolean }) => callback(data)
    ipcRenderer.on('ip-changed', handler)
    return () => ipcRenderer.removeListener('ip-changed', handler)
  },
  onTunStatusChanged: (callback: (status: string) => void) => {
    const handler = (_event: any, status: string) => callback(status)
    ipcRenderer.on('tun-status-changed', handler)
    return () => ipcRenderer.removeListener('tun-status-changed', handler)
  }
})
