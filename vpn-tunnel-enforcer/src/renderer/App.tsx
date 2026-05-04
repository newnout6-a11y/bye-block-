import { useEffect } from 'react'
import { useAppStore } from './store'
import { Sidebar } from './components/Sidebar'
import { Dashboard } from './pages/Dashboard'
import { Apps } from './pages/Apps'
import { Settings } from './pages/Settings'
import { Logs } from './pages/Logs'
import { Maintenance } from './pages/Maintenance'
import type { AppSettings, LeakCheckResult } from './store'

declare global {
  interface Window {
    electronAPI: {
      detectHapp: () => Promise<any>
      getPublicIp: () => Promise<{ ip: string | null; isLeak: boolean; vpnIp: string | null }>
      startTun: (proxyAddr: string, proxyType?: 'socks5' | 'http') => Promise<{ success: boolean; error?: string; warning?: string | null; vpnIp?: string | null }>
      stopTun: () => Promise<{ success: boolean; error?: string }>
      getTunStatus: () => Promise<{ running: boolean; proxyAddr: string | null; proxyType: 'socks5' | 'http' | null; pid: number | null; warning?: string | null }>
      applyAutoconfig: (targets: string[], proxyAddr: string, proxyType?: 'socks5' | 'http') => Promise<Record<string, boolean>>
      rollbackAutoconfig: (targets: string[]) => Promise<Record<string, boolean>>
      getAutoconfigStatus: () => Promise<any[]>
      getSettings: () => Promise<AppSettings>
      saveSettings: (settings: Partial<AppSettings>) => Promise<AppSettings>
      setLoginItem: (openAtLogin: boolean) => Promise<AppSettings>
      runLeakCheck: (options?: { proxyAddr?: string; proxyType?: 'socks5' | 'http' }) => Promise<LeakCheckResult>
      runStoreRepair: (action: string) => Promise<{ success: boolean; message: string; details?: string }>
      runStoreDiagnostics: () => Promise<any>
      runSystemDiagnostics: () => Promise<any>
      getRoutingPlan: () => Promise<any>
      runAutoPilot: () => Promise<any>
      logRenderer: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => Promise<any>
      getFullLogs: () => Promise<any>
      clearAppLog: () => Promise<any>
      applyTunNetworkBaseline: () => Promise<any>
      rollbackTunNetworkBaseline: () => Promise<any>
      disableFirewallKillSwitch: () => Promise<{ success: boolean; message: string }>
      getFirewallKillSwitchStatus: () => Promise<{ active: boolean }>
      getLocationPrivacy: () => Promise<any>
      applyLocationPrivacy: () => Promise<any>
      rollbackLocationPrivacy: () => Promise<any>
      openTunLogFolder: () => Promise<string>
      openLogFolder: () => Promise<string>
      onIpChanged: (callback: (data: { ip: string; isLeak: boolean }) => void) => () => void
      onTunStatusChanged: (callback: (status: string) => void) => () => void
    }
  }
}

type Page = 'dashboard' | 'apps' | 'maintenance' | 'settings' | 'logs'

import { useState } from 'react'

function proxyFromOverride(settings: AppSettings) {
  const raw = settings.proxyOverride.trim()
  const separator = raw.lastIndexOf(':')
  if (separator <= 0 || separator === raw.length - 1) return null
  const host = raw.slice(0, separator).trim()
  const port = parseInt(raw.slice(separator + 1), 10)
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return null
  return { host, port, type: settings.proxyType, verified: true, publicIpViaProxy: null }
}

export default function App() {
  const [page, setPage] = useState<Page>('dashboard')
  const addLog = useAppStore(s => s.addLog)

  // Listen for IPC events
  useEffect(() => {
    const unsubIp = window.electronAPI.onIpChanged(({ ip, isLeak }) => {
      useAppStore.getState().setPublicIp(ip, isLeak)
      if (isLeak) {
        addLog('error', `ОБНАРУЖЕНА УТЕЧКА IP! Текущий: ${ip}`)
      } else {
        addLog('info', `Публичный IP: ${ip}`)
      }
    })

    const unsubTun = window.electronAPI.onTunStatusChanged((status) => {
      const store = useAppStore.getState()
      // 'proxy-down' means TUN is still up but upstream proxy is unreachable — we keep
      // tunRunning=true so the kill-switch state is reflected (traffic blocked, not leaked).
      // 'killswitch-active' means sing-box died unexpectedly, TUN is gone, but the
      // firewall kill-switch is still blocking outbound traffic on the physical adapter.
      const tunUp = status === 'running' || status === 'proxy-down'
      store.setTunRunning(tunUp)
      if (!tunUp && store.mode === 'hard') store.setMode('off')
      if (status === 'proxy-down') {
        addLog('warn', 'Upstream proxy не отвечает — трафик заблокирован в TUN (kill-switch)')
      } else if (status === 'killswitch-active') {
        addLog('error', 'sing-box упал — файрвол kill-switch блокирует весь исходящий трафик')
      } else {
        addLog('info', `Статус TUN: ${status}`)
      }
      // Refresh kill-switch state after every TUN transition so the Dashboard
      // banner reflects reality without polling.
      window.electronAPI.getFirewallKillSwitchStatus()
        .then(({ active }) => store.setFirewallKillSwitchActive(active))
        .catch(() => undefined)
    })

    return () => {
      unsubIp()
      unsubTun()
    }
  }, [addLog])

  // Initial detection
  useEffect(() => {
    async function init() {
      const store = useAppStore.getState()
      store.setDetecting(true)

      let settings = store.settings
      try {
        settings = await window.electronAPI.getSettings()
        store.setSettings(settings)
      } catch (err: any) {
        addLog('warn', `Не удалось загрузить настройки: ${err.message}`)
      }

      const manualProxy = proxyFromOverride(settings)
      if (manualProxy) {
        store.setProxy(manualProxy)
        addLog('info', `Используется ручной прокси: ${manualProxy.host}:${manualProxy.port} (${manualProxy.type})`)
      } else {
        addLog('info', 'Поиск прокси Happ...')

        try {
          const proxy = await window.electronAPI.detectHapp()
          if (proxy) {
            store.setProxy(proxy)
            addLog('info', `Прокси Happ найдено: ${proxy.host}:${proxy.port} (${proxy.type})`)
          } else {
            addLog('warn', 'Прокси Happ не найдено автоматически')
          }
        } catch (err: any) {
          addLog('error', `Ошибка поиска: ${err.message}`)
        }
      }

      if (settings.autoPilotEnabled) {
        try {
          addLog('info', 'Автопилот маршрута включен: приложение само выберет безопасный режим.')
          const autoPilot = await window.electronAPI.runAutoPilot()
          store.setMode(autoPilot.mode)
          store.setTunRunning(autoPilot.mode === 'hard')
          if (autoPilot.mode !== 'hard') store.setVpnIp(null)
          addLog(
            autoPilot.summary === 'fail' ? 'error' : autoPilot.summary === 'warn' ? 'warn' : 'info',
            `${autoPilot.title}: ${autoPilot.message}`
          )
        } catch (err: any) {
          addLog('error', `Автопилот маршрута не сработал: ${err.message}`)
        }
      } else {
        try {
          const plan = await window.electronAPI.getRoutingPlan()
          if (plan.recommendedMode === 'external') store.setMode('external')
          addLog(plan.status === 'broken' || plan.status === 'blocked' ? 'warn' : 'info', `План маршрута: ${plan.title}`)
        } catch (err: any) {
          addLog('warn', `Не удалось построить план маршрута: ${err.message}`)
        }
      }

      try {
        const ipInfo = await window.electronAPI.getPublicIp()
        store.setPublicIp(ipInfo.ip, ipInfo.isLeak)
        if (ipInfo.ip) addLog('info', `Текущий публичный IP: ${ipInfo.ip}`)
      } catch (err: any) {
        addLog('error', `Ошибка проверки IP: ${err.message}`)
      }

      try {
        const tunStatus = await window.electronAPI.getTunStatus()
        store.setTunRunning(tunStatus.running)
        if (tunStatus.running) store.setMode('hard')
        else if (useAppStore.getState().mode === 'hard' && settings.autoPilotEnabled) store.setMode('off')
      } catch { /* */ }

      try {
        const ks = await window.electronAPI.getFirewallKillSwitchStatus()
        store.setFirewallKillSwitchActive(ks.active)
      } catch { /* */ }

      try {
        const targets = await window.electronAPI.getAutoconfigStatus()
        if (targets.length > 0) {
          const current = store.autoconfigTargets
          store.setAutoconfigTargets(current.map(t => {
            const found = targets.find((x: any) => x.id === t.id)
            return { ...t, applied: found?.applied ?? false }
          }))
        }
      } catch { /* */ }

      try {
        const privacy = await window.electronAPI.getLocationPrivacy()
        store.updateSettings({ locationPrivacyEnabled: Boolean(privacy?.applied) })
      } catch { /* */ }

      store.setDetecting(false)
    }
    init()
  }, [])

  const renderPage = () => {
    switch (page) {
      case 'dashboard': return <Dashboard />
      case 'apps': return <Apps />
      case 'maintenance': return <Maintenance />
      case 'settings': return <Settings />
      case 'logs': return <Logs />
    }
  }

  return (
    <div className="flex h-screen">
      <Sidebar currentPage={page} onNavigate={setPage} />
      <main className="flex-1 overflow-y-auto p-6">
        {renderPage()}
      </main>
    </div>
  )
}
