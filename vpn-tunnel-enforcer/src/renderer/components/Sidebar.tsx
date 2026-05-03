import { AlertTriangle, AppWindow, LayoutDashboard, ScrollText, Settings as SettingsIcon, Shield, ShieldCheck, ShieldOff, Wrench } from 'lucide-react'
import { useAppStore } from '../store'

interface SidebarProps {
  currentPage: string
  onNavigate: (page: 'dashboard' | 'apps' | 'maintenance' | 'settings' | 'logs') => void
}

const navItems = [
  { id: 'dashboard', label: 'Главная', icon: LayoutDashboard },
  { id: 'apps', label: 'Приложения', icon: AppWindow },
  { id: 'maintenance', label: 'Диагностика', icon: Wrench },
  { id: 'settings', label: 'Настройки', icon: SettingsIcon },
  { id: 'logs', label: 'Логи', icon: ScrollText }
] as const

export function Sidebar({ currentPage, onNavigate }: SidebarProps) {
  const mode = useAppStore(s => s.mode)
  const isLeak = useAppStore(s => s.isLeak)

  const statusIcon = () => {
    if (isLeak) return <AlertTriangle className="w-5 h-5 text-danger animate-pulse" />
    if (mode === 'hard') return <Shield className="w-5 h-5 text-success" />
    if (mode === 'external') return <ShieldCheck className="w-5 h-5 text-warning" />
    if (mode === 'soft') return <Shield className="w-5 h-5 text-accent" />
    return <ShieldOff className="w-5 h-5 text-gray-500" />
  }

  const statusText = () => {
    if (isLeak) return 'Утечка IP'
    if (mode === 'hard') return 'Hard TUN'
    if (mode === 'external') return 'Внешний VPN'
    if (mode === 'soft') return 'Приложения'
    return 'Выключено'
  }

  const statusColor = () => {
    if (isLeak) return 'text-danger'
    if (mode === 'hard') return 'text-success'
    if (mode === 'external') return 'text-warning'
    if (mode === 'soft') return 'text-accent'
    return 'text-gray-500'
  }

  return (
    <aside className="w-56 bg-surface-light border-r border-surface-lighter/50 flex flex-col">
      <div className="p-5 border-b border-surface-lighter/50">
        <div className="flex items-center gap-2.5">
          <Shield className="w-7 h-7 text-accent" />
          <div>
            <h1 className="text-sm font-bold text-gray-100 leading-tight">VPN Tunnel</h1>
            <p className="text-xs text-gray-400">умный маршрут</p>
          </div>
        </div>
      </div>

      <div className="px-5 py-4 border-b border-surface-lighter/30">
        <div className="flex items-center gap-2">
          {statusIcon()}
          <span className={`text-sm font-semibold ${statusColor()}`}>{statusText()}</span>
        </div>
      </div>

      <nav className="flex-1 p-3 space-y-1">
        {navItems.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => onNavigate(id as any)}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-150 ${
              currentPage === id
                ? 'bg-accent/15 text-accent'
                : 'text-gray-400 hover:text-gray-200 hover:bg-surface-lighter/50'
            }`}
          >
            <Icon className="w-4.5 h-4.5" />
            {label}
          </button>
        ))}
      </nav>

      <div className="p-4 border-t border-surface-lighter/30">
        <p className="text-xs text-gray-500 text-center">v1.0.0</p>
      </div>
    </aside>
  )
}
