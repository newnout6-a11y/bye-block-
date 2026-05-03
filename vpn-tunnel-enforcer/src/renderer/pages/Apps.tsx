import { useState } from 'react'
import { useAppStore } from '../store'
import { CheckCircle2, XCircle, Loader2, RotateCcw, Play } from 'lucide-react'

export function Apps() {
  const targets = useAppStore(s => s.autoconfigTargets)
  const targetLabels: Record<string, string> = {
    'android-studio': 'Android Studio',
    'gradle': 'Gradle',
    'env': 'Переменные окружения',
    'git': 'Git'
  }
  const toggleTarget = useAppStore(s => s.toggleTarget)
  const setAutoconfigTargets = useAppStore(s => s.setAutoconfigTargets)
  const addLog = useAppStore(s => s.addLog)
  const proxy = useAppStore(s => s.proxy)
  const settings = useAppStore(s => s.settings)
  const [applying, setApplying] = useState(false)
  const [rollingBack, setRollingBack] = useState(false)

  const proxyAddr = settings.proxyOverride.trim() || (proxy ? `${proxy.host}:${proxy.port}` : '')

  const handleApply = async () => {
    if (!proxyAddr) {
      addLog('error', 'Прокси не найдено. Невозможно применить настройки.')
      return
    }
    const enabledIds = targets.filter(t => t.enabled).map(t => t.id)
    if (enabledIds.length === 0) {
      addLog('warn', 'Ни одна цель не выбрана')
      return
    }

    setApplying(true)
    addLog('info', `Применение настроек: ${enabledIds.join(', ')}`)

    try {
      const results = await window.electronAPI.applyAutoconfig(enabledIds, proxyAddr)
      const updatedTargets = targets.map(t => ({
        ...t,
        applied: results[t.id] ?? t.applied
      }))
      setAutoconfigTargets(updatedTargets)

      const failed = Object.entries(results).filter(([, v]) => !v)
      if (failed.length > 0) {
        addLog('warn', `Не удалось применить: ${failed.map(([k]) => k).join(', ')}`)
      } else {
        addLog('info', 'Настройки успешно применены')
      }
    } catch (err: any) {
      addLog('error', `Ошибка применения: ${err.message}`)
    }

    setApplying(false)
  }

  const handleRollback = async () => {
    const appliedIds = targets.filter(t => t.applied).map(t => t.id)
    if (appliedIds.length === 0) {
      addLog('warn', 'Нечего откатывать')
      return
    }

    setRollingBack(true)
    addLog('info', `Откат: ${appliedIds.join(', ')}`)

    try {
      const results = await window.electronAPI.rollbackAutoconfig(appliedIds)
      const updatedTargets = targets.map(t => ({
        ...t,
        applied: results[t.id] === false ? false : t.applied
      }))
      setAutoconfigTargets(updatedTargets)
      addLog('info', 'Откат завершён')
    } catch (err: any) {
      addLog('error', `Ошибка отката: ${err.message}`)
    }

    setRollingBack(false)
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h2 className="text-2xl font-bold text-gray-100">Приложения</h2>
        <p className="text-sm text-gray-400 mt-1">Выберите, какие приложения направлять через прокси Happ (Мягкий режим)</p>
      </div>

      {!proxy && (
        <div className="bg-warning/15 border border-warning/40 rounded-lg p-4 text-sm text-warning">
          Прокси Happ не найдено. Включите прокси в настройках Happ и повторите поиск.
        </div>
      )}

      {/* Target list */}
      <div className="space-y-2">
        {targets.map(target => (
          <div key={target.id} className="card flex items-center justify-between">
            <div className="flex items-center gap-3">
              <button
                onClick={() => toggleTarget(target.id)}
                className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
                  target.enabled
                    ? 'bg-accent border-accent'
                    : 'border-gray-600 hover:border-gray-400'
                }`}
              >
                {target.enabled && <CheckCircle2 className="w-3.5 h-3.5 text-white" />}
              </button>
              <span className="text-sm font-medium text-gray-200">{targetLabels[target.id] || target.name}</span>
            </div>
            <div className="flex items-center gap-2">
              {target.applied ? (
                <span className="flex items-center gap-1 text-xs text-success">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Применено
                </span>
              ) : (
                <span className="flex items-center gap-1 text-xs text-gray-500">
                  <XCircle className="w-3.5 h-3.5" /> Не применено
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Action buttons */}
      <div className="flex gap-3">
        <button
          onClick={handleApply}
          disabled={applying || !proxyAddr}
          className="btn-primary flex items-center gap-2 disabled:opacity-50"
        >
          {applying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
          {applying ? 'Применение...' : 'Применить'}
        </button>
        <button
          onClick={handleRollback}
          disabled={rollingBack}
          className="btn-danger flex items-center gap-2 disabled:opacity-50"
        >
          {rollingBack ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
          {rollingBack ? 'Откат...' : 'Откатить'}
        </button>
      </div>
    </div>
  )
}
