import { CheckCircle2, Loader2, Search, Server, XCircle } from 'lucide-react'
import { useAppStore } from '../store'

export function ProxyCard() {
  const proxy = useAppStore(s => s.proxy)
  const settings = useAppStore(s => s.settings)
  const detecting = useAppStore(s => s.detecting)
  const setProxy = useAppStore(s => s.setProxy)
  const setDetecting = useAppStore(s => s.setDetecting)
  const addLog = useAppStore(s => s.addLog)

  const handleRedetect = async () => {
    if (settings.proxyOverride.trim()) {
      addLog('warn', 'Включен ручной proxy. Чтобы снова искать автоматически, очистите ручной адрес в настройках.')
      return
    }
    setDetecting(true)
    addLog('info', 'Ищу локальный proxy у VPN-клиентов...')
    try {
      const result = await window.electronAPI.detectHapp()
      if (result) {
        setProxy(result)
        addLog('info', `Локальный proxy найден: ${result.host}:${result.port} (${result.type})`)
      } else {
        addLog('warn', 'Локальный proxy не найден. В VPN-клиенте нужен режим Proxy, а не только TUN.')
      }
    } catch (err: any) {
      addLog('error', `Ошибка поиска proxy: ${err.message}`)
    } finally {
      setDetecting(false)
    }
  }

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Server className="w-4 h-4 text-accent" />
          <h3 className="text-sm font-semibold text-gray-300">Локальный proxy</h3>
        </div>
        <button
          onClick={handleRedetect}
          disabled={detecting}
          className="flex items-center gap-1.5 text-xs text-accent hover:text-accent/80 disabled:opacity-50 transition-colors"
        >
          {detecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
          {detecting ? 'Ищу...' : 'Найти'}
        </button>
      </div>

      {proxy ? (
        <div className="space-y-2">
          {settings.proxyOverride.trim() && (
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-400">Источник</span>
              <span className="text-sm text-accent">Ручная настройка</span>
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-400">Адрес</span>
            <span className="text-sm font-mono text-gray-200">{proxy.host}:{proxy.port}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-400">Тип</span>
            <span className="text-sm text-gray-200 uppercase">{proxy.type}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-400">Порт отвечает</span>
            {proxy.verified ? (
              <span className="flex items-center gap-1 text-success text-sm"><CheckCircle2 className="w-3.5 h-3.5" /> Да</span>
            ) : (
              <span className="flex items-center gap-1 text-warning text-sm"><XCircle className="w-3.5 h-3.5" /> Нет</span>
            )}
          </div>
          {proxy.publicIpViaProxy && (
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-400">IP через proxy</span>
              <span className="text-sm font-mono text-success">{proxy.publicIpViaProxy}</span>
            </div>
          )}
        </div>
      ) : (
        <div className="text-center py-4">
          {!detecting ? (
            <>
              <XCircle className="w-8 h-8 text-gray-600 mx-auto mb-2" />
              <p className="text-sm text-gray-500">Proxy не найден</p>
              <p className="text-xs text-gray-600 mt-1">Запустите VPN-клиент в режиме Proxy или задайте адрес вручную.</p>
            </>
          ) : (
            <>
              <Loader2 className="w-8 h-8 text-accent mx-auto mb-2 animate-spin" />
              <p className="text-sm text-gray-400">Сканирую локальные порты...</p>
            </>
          )}
        </div>
      )}
    </div>
  )
}
