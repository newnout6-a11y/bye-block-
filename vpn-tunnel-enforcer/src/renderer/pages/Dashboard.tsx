import { ModeSwitch } from '../components/ModeSwitch'
import { IpCard } from '../components/IpCard'
import { ProxyCard } from '../components/ProxyCard'
import { useAppStore } from '../store'
import { Activity, CheckCircle2, Info, Loader2, Radar, Shield, ShieldOff, TriangleAlert } from 'lucide-react'
import { useState } from 'react'

export function Dashboard() {
  const mode = useAppStore(s => s.mode)
  const tunRunning = useAppStore(s => s.tunRunning)
  const proxy = useAppStore(s => s.proxy)
  const settings = useAppStore(s => s.settings)
  const routingHealth = useAppStore(s => s.routingHealth)
  const leakChecks = useAppStore(s => s.leakChecks)
  const setLeakChecks = useAppStore(s => s.setLeakChecks)
  const addLog = useAppStore(s => s.addLog)
  const [checking, setChecking] = useState(false)

  const runDiagnostics = async () => {
    const proxyAddr = settings.proxyOverride.trim() || (proxy ? `${proxy.host}:${proxy.port}` : '')
    setChecking(true)
    addLog('info', 'Запуск диагностики маршрутизации...')
    try {
      const result = await window.electronAPI.runLeakCheck({
        proxyAddr: proxyAddr || undefined,
        proxyType: settings.proxyOverride.trim() ? settings.proxyType : proxy?.type ?? settings.proxyType
      })
      setLeakChecks(result)
      const message =
        result.summary === 'ok'
          ? 'Критичных утечек не найдено'
          : result.summary === 'fail'
            ? 'Есть критичная проблема маршрутизации'
            : 'Есть предупреждения, проверьте детали'
      addLog(result.summary === 'fail' ? 'error' : result.summary === 'warn' ? 'warn' : 'info', `Диагностика: ${message}`)
    } catch (err: any) {
      addLog('error', `Диагностика не выполнена: ${err.message}`)
    } finally {
      setChecking(false)
    }
  }

  const statusClass = (status: string) => {
    if (status === 'ok') return 'text-success'
    if (status === 'warn') return 'text-warning'
    if (status === 'fail') return 'text-danger'
    return 'text-gray-400'
  }

  const statusIcon = (status: string) => {
    if (status === 'ok') return <CheckCircle2 className="w-4 h-4 text-success" />
    if (status === 'fail') return <TriangleAlert className="w-4 h-4 text-danger" />
    if (status === 'warn') return <TriangleAlert className="w-4 h-4 text-warning" />
    return <Info className="w-4 h-4 text-gray-400" />
  }

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Header */}
      <div>
        <h2 className="text-2xl font-bold text-gray-100">Главная</h2>
        <p className="text-sm text-gray-400 mt-1">Управление защитой VPN-туннеля</p>
      </div>

      {/* Leak warning banner */}
      {useAppStore(s => s.isLeak) && (
        <div className="bg-danger/15 border border-danger/40 rounded-lg p-4 flex items-center gap-3">
          <ShieldOff className="w-6 h-6 text-danger flex-shrink-0" />
          <div>
            <p className="text-sm font-bold text-danger">Обнаружена утечка IP!</p>
            <p className="text-xs text-danger/80">Ваш реальный IP виден. Включите Жёсткий режим или проверьте VPN-подключение.</p>
          </div>
        </div>
      )}

      {/* Mode switcher */}
      <div>
        <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Режим защиты</h3>
        <ModeSwitch />
      </div>

      {/* Status cards */}
      <div className="grid grid-cols-1 gap-4">
        <IpCard />
        <ProxyCard />
      </div>

      <div className="card space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">Диагностика маршрута</h3>
            <p className={`text-sm mt-1 ${statusClass(routingHealth.summary)}`}>{routingHealth.message}</p>
          </div>
          <button onClick={runDiagnostics} disabled={checking} className="btn-secondary flex items-center gap-2 text-sm disabled:opacity-50">
            {checking ? <Loader2 className="w-4 h-4 animate-spin" /> : <Radar className="w-4 h-4" />}
            Проверить
          </button>
        </div>
        {leakChecks && (
          <div className="space-y-2">
            {leakChecks.items.map(item => (
              <div key={item.id} className="bg-surface/60 border border-surface-lighter/40 rounded-lg px-3 py-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    {statusIcon(item.status)}
                    <span className="text-sm text-gray-200">{item.label}</span>
                  </div>
                  <span className={`text-xs font-mono text-right ${statusClass(item.status)}`}>{item.value}</span>
                </div>
                {item.details && <p className="text-xs text-gray-500 mt-1 break-words">{item.details}</p>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Quick stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="card text-center">
          <Activity className="w-5 h-5 text-accent mx-auto mb-1" />
          <p className="text-xs text-gray-400">Режим</p>
          <p className="text-sm font-bold text-gray-200 capitalize">
            {mode === 'off' ? 'Выкл.' : mode === 'soft' ? 'Приложения' : mode === 'external' ? 'Внешний VPN' : 'Жёсткий'}
          </p>
        </div>
        <div className="card text-center">
          <Shield className={`w-5 h-5 mx-auto mb-1 ${tunRunning ? 'text-success' : 'text-gray-600'}`} />
          <p className="text-xs text-gray-400">TUN</p>
          <p className={`text-sm font-bold ${tunRunning ? 'text-success' : 'text-gray-500'}`}>
            {tunRunning ? 'Активен' : 'Неактивен'}
          </p>
        </div>
        <div className="card text-center">
          <ShieldOff className={`w-5 h-5 mx-auto mb-1 ${mode === 'off' ? 'text-warning' : 'text-gray-600'}`} />
          <p className="text-xs text-gray-400">Kill Switch</p>
          <p className={`text-sm font-bold ${mode === 'hard' ? 'text-success' : 'text-gray-500'}`}>
            {mode === 'hard' ? 'Вкл.' : 'Выкл.'}
          </p>
        </div>
      </div>
    </div>
  )
}
