import { AlertTriangle, AppWindow, LayoutDashboard, Lock, ScrollText, Settings as SettingsIcon, Shield, ShieldCheck, ShieldOff, Wrench } from 'lucide-react'
import { useAppStore } from '../store'

interface SidebarProps {
  currentPage: string
  onNavigate: (page: 'dashboard' | 'apps' | 'maintenance' | 'settings' | 'logs') => void
}

interface NavItem {
  id: 'dashboard' | 'apps' | 'maintenance' | 'settings' | 'logs'
  label: string
  icon: typeof LayoutDashboard
  advancedOnly?: boolean
}

const navItems: readonly NavItem[] = [
  { id: 'dashboard', label: 'Главная', icon: LayoutDashboard },
  { id: 'apps', label: 'Приложения', icon: AppWindow, advancedOnly: true },
  { id: 'maintenance', label: 'Диагностика', icon: Wrench, advancedOnly: true },
  { id: 'settings', label: 'Настройки', icon: SettingsIcon },
  { id: 'logs', label: 'Логи', icon: ScrollText }
] as const

export function Sidebar({ currentPage, onNavigate }: SidebarProps) {
  const tunRunning = useAppStore(s => s.tunRunning)
  const isLeak = useAppStore(s => s.isLeak)
  const settings = useAppStore(s => s.settings)
  const firewallKillSwitchActive = useAppStore(s => s.firewallKillSwitchActive)

  const visibleNav = navItems.filter(item => !item.advancedOnly || settings.advancedMode)

  // Sidebar status pill summarises the four states a user actually cares about:
  // protected, kill-switch engaged (sing-box died), leak detected, off.
  const status = (() => {
    if (isLeak) {
      return { icon: <AlertTriangle className="w-5 h-5 text-danger animate-pulse" />, label: 'Утечка IP', color: 'text-danger' }
    }
    if (firewallKillSwitchActive && !tunRunning) {
      return { icon: <Lock className="w-5 h-5 text-warning" />, label: 'Файрвол блокирует', color: 'text-warning' }
    }
    if (tunRunning) {
      return { icon: <ShieldCheck className="w-5 h-5 text-success" />, label: 'Защищён', color: 'text-success' }
    }
    return { icon: <ShieldOff className="w-5 h-5 text-gray-500" />, label: 'Защита выключена', color: 'text-gray-500' }
  })()

  return (
    <aside className="w-56 bg-surface-light border-r border-surface-lighter/50 flex flex-col">
      <div className="p-5 border-b border-surface-lighter/50">
        <div className="flex items-center gap-2.5">
          <Shield className="w-7 h-7 text-accent" />
          <div>
            <h1 className="text-sm font-bold text-gray-100 leading-tight">VPN Tunnel</h1>
            <p className="text-xs text-gray-400">весь трафик через VPN</p>
          </div>
        </div>
      </div>

      <div className="px-5 py-4 border-b border-surface-lighter/30">
        <div className="flex items-center gap-2">
          {status.icon}
          <span className={`text-sm font-semibold ${status.color}`}>{status.label}</span>
        </div>
      </div>

      <nav className="flex-1 p-3 space-y-1">
        {visibleNav.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => onNavigate(id)}
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

      <div className="p-4 border-t border-surface-lighter/30 space-y-1">
        {settings.advancedMode && (
          <p className="text-[10px] font-semibold uppercase tracking-wider text-warning text-center">
            Расширенный режим
          </p>
        )}
        <p className="text-xs text-gray-500 text-center">v1.0.0</p>
      </div>
    </aside>
  )
}
