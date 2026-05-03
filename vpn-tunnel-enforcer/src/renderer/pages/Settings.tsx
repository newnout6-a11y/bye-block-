import { useAppStore } from '../store'
import { FolderOpen, Loader2, Save } from 'lucide-react'
import { useState } from 'react'

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

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h2 className="text-2xl font-bold text-gray-100">Настройки</h2>
        <p className="text-sm text-gray-400 mt-1">Конфигурация VPN Tunnel Enforcer</p>
      </div>

      {/* Manual proxy override */}
      <div className="card space-y-4">
        <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">Настройка прокси</h3>
        <div>
          <label className="block text-xs text-gray-400 mb-1.5">Ручной адрес прокси (переопределяет автоопределение)</label>
          <input
            type="text"
            value={settings.proxyOverride}
            onChange={e => updateSettings({ proxyOverride: e.target.value })}
            placeholder="напр. 127.0.0.1:2080"
            className="w-full bg-surface border border-surface-lighter/50 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-accent/50 transition-colors"
          />
          <p className="text-xs text-gray-600 mt-1">Оставьте пустым для автоопределения прокси Happ</p>
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
      </div>

      {/* IP monitoring */}
      <div className="card space-y-4">
        <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">Мониторинг IP</h3>
        <div>
          <label className="block text-xs text-gray-400 mb-1.5">Интервал проверки (секунды)</label>
          <input
            type="number"
            value={settings.checkInterval / 1000}
            onChange={e => updateSettings({ checkInterval: Math.max(5, parseInt(e.target.value) || 30) * 1000 })}
            min={5}
            max={300}
            className="w-32 bg-surface border border-surface-lighter/50 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-accent/50 transition-colors"
          />
        </div>
      </div>

      {/* System */}
      <div className="card space-y-4">
        <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">Система</h3>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-gray-200">Автозапуск с Windows</p>
            <p className="text-xs text-gray-500">Запускать при входе в систему</p>
          </div>
          <button
            onClick={() => updateSettings({ autoStart: !settings.autoStart })}
            className={`w-10 h-6 rounded-full transition-colors duration-200 ${
              settings.autoStart ? 'bg-accent' : 'bg-gray-600'
            }`}
          >
            <div className={`w-4 h-4 bg-white rounded-full mt-1 transition-transform duration-200 ${
              settings.autoStart ? 'translate-x-5' : 'translate-x-1'
            }`} />
          </button>
        </div>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-gray-200">Автопилот маршрута</p>
            <p className="text-xs text-gray-500">Сам выбирает: внешний VPN, приложения или один Hard TUN</p>
          </div>
          <button
            onClick={() => updateSettings({ autoPilotEnabled: !settings.autoPilotEnabled })}
            className={`w-10 h-6 rounded-full transition-colors duration-200 ${
              settings.autoPilotEnabled ? 'bg-accent' : 'bg-gray-600'
            }`}
          >
            <div className={`w-4 h-4 bg-white rounded-full mt-1 transition-transform duration-200 ${
              settings.autoPilotEnabled ? 'translate-x-5' : 'translate-x-1'
            }`} />
          </button>
        </div>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-gray-200">Сворачивать в трей при закрытии</p>
            <p className="text-xs text-gray-500">Продолжать работу в фоне</p>
          </div>
          <button
            onClick={() => updateSettings({ minimizeToTray: !settings.minimizeToTray })}
            className={`w-10 h-6 rounded-full transition-colors duration-200 ${
              settings.minimizeToTray ? 'bg-accent' : 'bg-gray-600'
            }`}
          >
            <div className={`w-4 h-4 bg-white rounded-full mt-1 transition-transform duration-200 ${
              settings.minimizeToTray ? 'translate-x-5' : 'translate-x-1'
            }`} />
          </button>
        </div>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-gray-200">Авто baseline сети для TUN</p>
            <p className="text-xs text-gray-500">Перед Hard mode сбрасывать WinHTTP/User/PAC/env proxy с backup</p>
          </div>
          <button
            onClick={() => updateSettings({ autoNetworkBaseline: !settings.autoNetworkBaseline })}
            className={`w-10 h-6 rounded-full transition-colors duration-200 ${
              settings.autoNetworkBaseline ? 'bg-accent' : 'bg-gray-600'
            }`}
          >
            <div className={`w-4 h-4 bg-white rounded-full mt-1 transition-transform duration-200 ${
              settings.autoNetworkBaseline ? 'translate-x-5' : 'translate-x-1'
            }`} />
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <button onClick={handleSave} disabled={saving} className="btn-primary flex items-center gap-2 disabled:opacity-50">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {saved ? 'Сохранено!' : saving ? 'Сохранение...' : 'Сохранить и применить'}
        </button>
        <button onClick={handleOpenLogs} disabled={openingLogs} className="btn-secondary flex items-center gap-2 disabled:opacity-50">
          {openingLogs ? <Loader2 className="w-4 h-4 animate-spin" /> : <FolderOpen className="w-4 h-4" />}
          Логи TUN
        </button>
      </div>
    </div>
  )
}
