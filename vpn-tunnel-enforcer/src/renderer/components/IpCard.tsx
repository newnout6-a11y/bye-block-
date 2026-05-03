import { AlertTriangle, CheckCircle2, Globe, ShieldCheck } from 'lucide-react'
import { useAppStore } from '../store'

export function IpCard() {
  const publicIp = useAppStore(s => s.publicIp)
  const isLeak = useAppStore(s => s.isLeak)
  const mode = useAppStore(s => s.mode)

  const statusColor = () => {
    if (isLeak) return 'text-danger'
    if (mode === 'hard') return 'text-success'
    if (mode === 'external') return 'text-warning'
    if (mode === 'soft') return 'text-accent'
    return 'text-gray-500'
  }

  const statusIcon = () => {
    if (isLeak) return <AlertTriangle className="w-5 h-5 text-danger animate-pulse" />
    if (mode === 'hard') return <CheckCircle2 className="w-5 h-5 text-success" />
    if (mode === 'external') return <ShieldCheck className="w-5 h-5 text-warning" />
    return <Globe className="w-5 h-5 text-gray-500" />
  }

  const statusText = () => {
    if (isLeak) return 'Обнаружена утечка IP'
    if (mode === 'hard') return 'Интернет идет через VPNTE-TUN'
    if (mode === 'external') return 'Уже работает внешний VPN/TUN'
    if (mode === 'soft') return 'Proxy только для выбранных приложений'
    return 'VPNTE ничего не перенаправляет'
  }

  return (
    <div className="card flex items-center gap-4">
      <div className={`w-14 h-14 rounded-full flex items-center justify-center ${
        isLeak ? 'bg-danger/20' : mode === 'hard' ? 'bg-success/20' : mode === 'external' ? 'bg-warning/20' : 'bg-gray-600/20'
      }`}>
        {statusIcon()}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs text-gray-400 uppercase tracking-wider mb-1">Публичный IP</p>
        <p className={`text-xl font-mono font-bold truncate ${statusColor()}`}>
          {publicIp || 'пока неизвестен'}
        </p>
      </div>
      <div className="text-right max-w-[45%]">
        <p className={`text-sm font-semibold ${statusColor()}`}>{statusText()}</p>
      </div>
    </div>
  )
}
