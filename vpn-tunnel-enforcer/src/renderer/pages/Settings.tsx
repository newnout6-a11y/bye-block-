import { useAppStore } from '../store'
import { Bell, FolderOpen, Loader2, Lock, RefreshCw, Save, Settings2, ShieldCheck, Wand2 } from 'lucide-react'
import { ReactNode, useState } from 'react'

interface ToggleRowProps {
  title: ReactNode
  description: ReactNode
  checked: boolean
  onChange: (next: boolean) => void
  icon?: ReactNode
}

function ToggleRow({ title, description, checked, onChange, icon }: ToggleRowProps) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex-1">
        <p className="text-sm text-gray-200 flex items-center gap-2">
          {icon}
          {title}
        </p>
        <p className="text-xs text-gray-500 mt-1 leading-relaxed">{description}</p>
      </div>
      <button
        onClick={() => onChange(!checked)}
        className={`flex-shrink-0 w-10 h-6 rounded-full transition-colors duration-200 ${
          checked ? 'bg-accent' : 'bg-gray-600'
        }`}
        aria-pressed={checked}
      >
        <div
          className={`w-4 h-4 bg-white rounded-full mt-1 transition-transform duration-200 ${
            checked ? 'translate-x-5' : 'translate-x-1'
          }`}
        />
      </button>
    </div>
  )
}

export function Settings() {
  const settings = useAppStore(s => s.settings)
  const updateSettings = useAppStore(s => s.updateSettings)
  const setSettings = useAppStore(s => s.setSettings)
  const setProxy = useAppStore(s => s.setProxy)
  const addLog = useAppStore(s => s.addLog)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [openingLogs, setOpeningLogs] = useState(false)

  const handleSave = async () => {
    setSaving(true)
    try {
      const result = await window.electronAPI.saveSettings(settings)
      setSettings(result)
      const override = result.proxyOverride.trim()
      if (override) {
        const separator = override.lastIndexOf(':')
        const host = override.slice(0, separator).trim()
        const port = parseInt(override.slice(separator + 1), 10)
        if (separator > 0 && host && Number.isInteger(port)) {
          setProxy({ host, port, type: result.proxyType, verified: true, publicIpViaProxy: null })
        }
      }
      setSaved(true)
      addLog('info', 'Настройки сохранены и применены')
      setTimeout(() => setSaved(false), 2000)
    } catch (err: any) {
      addLog('error', `Не удалось сохранить настройки: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }

  const handleOpenLogs = async () => {
    setOpeningLogs(true)
    try {
      const folder = await window.electronAPI.openTunLogFolder()
      addLog('info', `Открыта папка логов: ${folder}`)
    } catch (err: any) {
      addLog('error', `Не удалось открыть папку логов: ${err.message}`)
    } finally {
      setOpeningLogs(false)
    }
  }

  const handleResetWizard = async () => {
    try {
      const result = await window.electronAPI.saveSettings({ firstRunComplete: false })
      setSettings(result)
      addLog('info', 'Мастер первого запуска будет показан при следующем открытии главной.')
    } catch (err: any) {
      addLog('error', `Не удалось сбросить мастер: ${err.message}`)
    }
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h2 className="text-2xl font-bold text-gray-100">Настройки</h2>
        <p className="text-sm text-gray-400 mt-1">Главные параметры защиты и поведения приложения</p>
      </div>

      {/* Section: Защита — самые важные параметры безопасности. */}
      <div className="card space-y-5">
        <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-success" />
          Защита
        </h3>

        <ToggleRow
          icon={<Lock className="w-4 h-4 text-success" />}
          title={<>Файрвол kill-switch <span className="text-success">(рекомендуется)</span></>}
          description={
            <>
              Если sing-box упадёт или будет убит, правила Windows Firewall не дадут трафику утечь
              мимо VPN. sing-box и локальная сеть (принтеры, NAS) разрешены явно. Снимается при
              штатной остановке защиты или закрытии приложения.
            </>
          }
          checked={settings.firewallKillSwitch}
          onChange={(next) => updateSettings({ firewallKillSwitch: next })}
        />

        <ToggleRow
          icon={<RefreshCw className="w-4 h-4 text-accent" />}
          title="Авто-перезапуск sing-box при крахе"
          description="Если процесс sing-box внезапно упадёт, попробуем перезапустить до 3 раз с экспоненциальной паузой. Большинство случаев временных сбоев лечатся именно этим."
          checked={settings.autoRestartOnCrash}
          onChange={(next) => updateSettings({ autoRestartOnCrash: next })}
        />

        <ToggleRow
          icon={<Bell className="w-4 h-4 text-accent" />}
          title="Уведомления Windows"
          description="Показывать toast при включении защиты, падении sing-box, утечке IP. Удобно если приложение свернуто в трей."
          checked={settings.desktopNotifications}
          onChange={(next) => updateSettings({ desktopNotifications: next })}
        />
      </div>

      {/* Section: Поведение приложения */}
      <div className="card space-y-5">
        <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">Поведение</h3>

        <ToggleRow
          title="Автозапуск с Windows"
          description="Запускать приложение при входе в систему."
          checked={settings.autoStart}
          onChange={(next) => updateSettings({ autoStart: next })}
        />

        <ToggleRow
          title="Сворачивать в трей при закрытии"
          description="Кнопка X сворачивает в трей вместо выхода. Защита продолжает работать в фоне."
          checked={settings.minimizeToTray}
          onChange={(next) => updateSettings({ minimizeToTray: next })}
        />

        <ToggleRow
          title="Автопилот маршрута"
          description="При запуске сам решает: оставить как есть (если уже работает внешний VPN) или включить TUN. Если выключен — придётся запускать защиту вручную."
          checked={settings.autoPilotEnabled}
          onChange={(next) => updateSettings({ autoPilotEnabled: next })}
        />
      </div>

      {/* Section: Расширенный режим */}
      <div className="card space-y-5">
        <ToggleRow
          icon={<Settings2 className="w-4 h-4 text-warning" />}
          title={<>Расширенный режим <span className="text-warning">(для опытных)</span></>}
          description="Открывает страницы Приложения и Диагностика, разрешает менять ручной адрес прокси и потенциально опасные параметры (сброс системных proxy-настроек, починка Microsoft Store)."
          checked={settings.advancedMode}
          onChange={(next) => updateSettings({ advancedMode: next })}
        />

        <ToggleRow
          icon={<Wand2 className="w-4 h-4 text-accent" />}
          title="Показывать мастер первого запуска"
          description="Снимите галочку чтобы скрыть мастер. Включите чтобы запустить его снова при следующем открытии."
          checked={!settings.firstRunComplete}
          onChange={(next) => {
            if (next) {
              void handleResetWizard()
            } else {
              updateSettings({ firstRunComplete: true })
            }
          }}
        />
      </div>

      {/* Section: Расширенные параметры — видны только если advancedMode включён */}
      {settings.advancedMode && (
        <div className="card space-y-5 border-warning/30">
          <h3 className="text-sm font-semibold uppercase tracking-wider flex items-center gap-2 text-warning">
            <Settings2 className="w-4 h-4" />
            Расширенные параметры
          </h3>

          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Ручной адрес прокси</label>
            <input
              type="text"
              value={settings.proxyOverride}
              onChange={e => updateSettings({ proxyOverride: e.target.value })}
              placeholder="например, 127.0.0.1:2080"
              className="w-full bg-surface border border-surface-lighter/50 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-accent/50 transition-colors"
            />
            <p className="text-xs text-gray-600 mt-1">
              Переопределяет автоопределение Happ. Оставьте пустым для автопоиска.
            </p>
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Тип прокси для ручного адреса</label>
            <select
              value={settings.proxyType}
              onChange={e => updateSettings({ proxyType: e.target.value === 'http' ? 'http' : 'socks5' })}
              className="w-40 bg-surface border border-surface-lighter/50 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-accent/50 transition-colors"
            >
              <option value="socks5">SOCKS5</option>
              <option value="http">HTTP</option>
            </select>
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Интервал проверки IP (секунды)</label>
            <input
              type="number"
              value={settings.checkInterval / 1000}
              onChange={e => updateSettings({ checkInterval: Math.max(5, parseInt(e.target.value) || 30) * 1000 })}
              min={5}
              max={300}
              className="w-32 bg-surface border border-surface-lighter/50 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-accent/50 transition-colors"
            />
          </div>

          <ToggleRow
            title={<>Авто baseline сети для TUN <span className="text-warning">(агрессивно)</span></>}
            description={
              <>
                Перед Hard mode сбрасывает WinHTTP/User/PAC/env proxy с резервной копией. По умолчанию
                выключено: TUN ловит трафик и без этого. Откатывается автоматически при остановке защиты,
                выходе из приложения и при крахе. Полезно только если есть проблемы с UWP/Microsoft Store.
              </>
            }
            checked={settings.autoNetworkBaseline}
            onChange={(next) => updateSettings({ autoNetworkBaseline: next })}
          />
        </div>
      )}

      <div className="flex flex-wrap gap-3">
        <button onClick={handleSave} disabled={saving} className="btn-primary flex items-center gap-2 disabled:opacity-50">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {saved ? 'Сохранено!' : saving ? 'Сохранение...' : 'Сохранить и применить'}
        </button>
        <button onClick={handleOpenLogs} disabled={openingLogs} className="btn-secondary flex items-center gap-2 disabled:opacity-50">
          {openingLogs ? <Loader2 className="w-4 h-4 animate-spin" /> : <FolderOpen className="w-4 h-4" />}
          Открыть папку логов
        </button>
      </div>
    </div>
  )
}
