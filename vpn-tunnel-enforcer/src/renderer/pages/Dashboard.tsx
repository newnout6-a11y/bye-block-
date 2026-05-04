import { HeroStatus } from '../components/HeroStatus'
import { DiagnosticsCard } from '../components/DiagnosticsCard'
import { useAppStore } from '../store'
import { CheckCircle2, Info, Loader2, Lock, Radar, ShieldOff, TriangleAlert } from 'lucide-react'
import { useState } from 'react'

export function Dashboard() {
  const tunRunning = useAppStore(s => s.tunRunning)
  const proxy = useAppStore(s => s.proxy)
  const settings = useAppStore(s => s.settings)
  const routingHealth = useAppStore(s => s.routingHealth)
  const leakChecks = useAppStore(s => s.leakChecks)
  const setLeakChecks = useAppStore(s => s.setLeakChecks)
  const firewallKillSwitchActive = useAppStore(s => s.firewallKillSwitchActive)
  const setFirewallKillSwitchActive = useAppStore(s => s.setFirewallKillSwitchActive)
  const isLeak = useAppStore(s => s.isLeak)
  const addLog = useAppStore(s => s.addLog)
  const [checking, setChecking] = useState(false)
  const [disengaging, setDisengaging] = useState(false)

  // Show the kill-switch banner when sing-box is no longer running but the
  // firewall rules are still in place. While TUN is up the kill-switch is
  // "happily engaged" — no need to scare the user.
  const showKillSwitchBanner = firewallKillSwitchActive && !tunRunning

  const handleDisengageKillSwitch = async () => {
    setDisengaging(true)
    try {
      const result = await window.electronAPI.disableFirewallKillSwitch()
      if (result.success) {
        setFirewallKillSwitchActive(false)
        addLog('warn', `Файрвол kill-switch снят вручную: ${result.message}`)
      } else {
        addLog('error', `Не удалось снять kill-switch: ${result.message}`)
      }
    } catch (err: any) {
      addLog('error', `Ошибка снятия kill-switch: ${err.message}`)
    } finally {
      setDisengaging(false)
    }
  }

  const runDiagnostics = async () => {
    const proxyAddr = settings.proxyOverride.trim() || (proxy ? `${proxy.host}:${proxy.port}` : '')
    setChecking(true)
    addLog('info', 'Проверяем маршрут — куда сейчас идёт трафик…')
    try {
      const result = await window.electronAPI.runLeakCheck({
        proxyAddr: proxyAddr || undefined,
        proxyType: settings.proxyOverride.trim() ? settings.proxyType : proxy?.type ?? settings.proxyType
      })
      setLeakChecks(result)
      const message =
        result.summary === 'ok'
          ? 'Утечек не найдено — всё через VPN.'
          : result.summary === 'fail'
            ? 'Найдена критичная проблема маршрутизации.'
            : 'Есть предупреждения, посмотрите детали ниже.'
      addLog(result.summary === 'fail' ? 'error' : result.summary === 'warn' ? 'warn' : 'info', `Проверка маршрута: ${message}`)
    } catch (err: any) {
      addLog('error', `Проверка не выполнена: ${err.message}`)
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
      {/* The hero status block: badge + headline + primary CTA. Replaces the old
          ModeSwitch / IpCard / ProxyCard combo so a fresh user sees one obvious
          "what's the state and what should I do" surface. */}
      <HeroStatus />

      {/* Leak warning banner — kept separate from the hero so it stays loud. */}
      {isLeak && (
        <div className="bg-danger/15 border border-danger/40 rounded-lg p-4 flex items-center gap-3">
          <ShieldOff className="w-6 h-6 text-danger flex-shrink-0" />
          <div>
            <p className="text-sm font-bold text-danger">Виден ваш реальный IP</p>
            <p className="text-xs text-danger/80">
              Включите защиту или проверьте VPN-клиент. Если защита уже включена — возможно, VPN-сервер не работает.
            </p>
          </div>
        </div>
      )}

      {/* Firewall kill-switch banner: TUN is down but firewall rules still block all
          outbound traffic on physical adapters. The user has to either restart TUN
          or accept the leak window and click Снять. */}
      {showKillSwitchBanner && (
        <div className="bg-warning/15 border border-warning/40 rounded-lg p-4 flex items-start gap-3">
          <Lock className="w-6 h-6 text-warning flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-bold text-warning">VPN отключён, файрвол блокирует трафик</p>
            <p className="text-xs text-warning/90 mt-1">
              sing-box не работает, но правила Windows Firewall защищают от утечки IP. Включите защиту заново
              чтобы вернуть интернет через VPN, либо снимите блокировку вручную (тогда трафик пойдёт мимо VPN).
            </p>
            <button
              onClick={handleDisengageKillSwitch}
              disabled={disengaging}
              className="btn-secondary mt-2 text-xs flex items-center gap-2 disabled:opacity-50"
            >
              {disengaging ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldOff className="w-3.5 h-3.5" />}
              Снять блокировку вручную
            </button>
          </div>
        </div>
      )}

      {/* Quick health/leak check — kept on the main page because it's the only
          surface that tells the user "I actually verified your IP is hidden". */}
      <div className="card space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">Проверка маршрута</h3>
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

      {/* The "if anything goes wrong, click here" surface. Active leak self-test
          + one-click send-logs ZIP. This is what the user reaches for instead
          of asking us "почему не работает". */}
      <DiagnosticsCard />
    </div>
  )
}
