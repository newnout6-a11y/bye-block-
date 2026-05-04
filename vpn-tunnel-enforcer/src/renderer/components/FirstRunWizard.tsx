import { useEffect, useState } from 'react'
import { ArrowRight, CheckCircle2, Lock, Loader2, RefreshCw, Search, Shield, ShieldCheck, X } from 'lucide-react'
import { useAppStore } from '../store'

/**
 * 4-step modal that shows on first launch (and any time
 * settings.firstRunComplete is false). The whole point is to make the first
 * 30 seconds of using the app totally obvious.
 *
 * Steps:
 *   1. "Hi, here's what this app does"
 *   2. Search for Happ proxy → if not found, allow manual entry
 *   3. Show what kill-switch does and let the user opt out (default ON)
 *   4. "All set — turn on protection"
 *
 * This component does NOT mutate firstRunComplete itself; it accepts
 * onComplete and onSkip handlers from the parent which are responsible for
 * persisting the setting.
 */

interface Props {
  onComplete: () => void
  onSkip: () => void
}

type Step = 'intro' | 'proxy' | 'killswitch' | 'ready'

export function FirstRunWizard({ onComplete, onSkip }: Props) {
  const proxy = useAppStore((s) => s.proxy)
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const setProxy = useAppStore((s) => s.setProxy)
  const addLog = useAppStore((s) => s.addLog)

  const [step, setStep] = useState<Step>('intro')
  const [detecting, setDetecting] = useState(false)
  const [manualAddr, setManualAddr] = useState(settings.proxyOverride || '')
  const [manualType, setManualType] = useState<'socks5' | 'http'>(settings.proxyType)
  const [manualError, setManualError] = useState<string | null>(null)

  // Auto-trigger detection when entering the proxy step.
  useEffect(() => {
    if (step !== 'proxy') return
    if (proxy) return
    if (settings.proxyOverride) return
    void detect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  async function detect() {
    setDetecting(true)
    try {
      const result = await window.electronAPI.detectHapp()
      if (result) {
        setProxy(result)
        addLog('info', `Прокси найден: ${result.host}:${result.port} (${result.type})`)
      } else {
        addLog('warn', 'Прокси не найден автоматически.')
      }
    } catch (err: any) {
      addLog('error', `Ошибка поиска прокси: ${err.message}`)
    } finally {
      setDetecting(false)
    }
  }

  function applyManual() {
    setManualError(null)
    const raw = manualAddr.trim()
    const sep = raw.lastIndexOf(':')
    if (sep <= 0 || sep === raw.length - 1) {
      setManualError('Формат: host:port (например, 127.0.0.1:2080)')
      return
    }
    const host = raw.slice(0, sep).trim()
    const port = parseInt(raw.slice(sep + 1), 10)
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
      setManualError('Порт должен быть числом от 1 до 65535')
      return
    }
    updateSettings({ proxyOverride: raw, proxyType: manualType })
    setProxy({ host, port, type: manualType, verified: true, publicIpViaProxy: null })
    addLog('info', `Использую ручной прокси: ${host}:${port} (${manualType})`)
  }

  const hasProxy = Boolean(proxy)

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-xl bg-surface rounded-2xl border border-surface-lighter/40 shadow-2xl">
        {/* Header */}
        <div className="px-6 py-4 border-b border-surface-lighter/30 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Shield className="w-5 h-5 text-accent" />
            <h2 className="text-base font-bold text-gray-100">Первый запуск</h2>
          </div>
          <button
            onClick={onSkip}
            className="text-gray-500 hover:text-gray-300 transition-colors"
            aria-label="Пропустить"
            title="Пропустить"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Step indicator */}
        <div className="px-6 pt-4">
          <div className="flex items-center gap-2">
            {(['intro', 'proxy', 'killswitch', 'ready'] as Step[]).map((s, i) => {
              const idx = (['intro', 'proxy', 'killswitch', 'ready'] as Step[]).indexOf(step)
              const done = i < idx
              const active = i === idx
              return (
                <div key={s} className="flex items-center gap-2 flex-1">
                  <div
                    className={`flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold transition-colors ${
                      done
                        ? 'bg-success/20 text-success'
                        : active
                          ? 'bg-accent/20 text-accent'
                          : 'bg-surface-lighter/30 text-gray-500'
                    }`}
                  >
                    {done ? <CheckCircle2 className="w-4 h-4" /> : i + 1}
                  </div>
                  {i < 3 && (
                    <div
                      className={`flex-1 h-0.5 rounded-full ${
                        done ? 'bg-success/40' : 'bg-surface-lighter/30'
                      }`}
                    />
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {/* Step body */}
        <div className="px-6 py-6 min-h-[280px]">
          {step === 'intro' && (
            <div className="space-y-4">
              <h3 className="text-xl font-bold text-gray-100">Что делает это приложение?</h3>
              <p className="text-sm text-gray-300 leading-relaxed">
                Заворачиваем <span className="text-accent font-semibold">весь</span> ваш интернет в VPN —
                не только браузер, но и любые приложения, обновления, фоновые сервисы Windows. DNS-запросы
                тоже идут через VPN, чтобы провайдер не видел, какие сайты вы открываете.
              </p>
              <ul className="space-y-2 text-sm text-gray-400">
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="w-4 h-4 text-success flex-shrink-0 mt-0.5" />
                  Один TUN-интерфейс на всю систему — никаких настроек в каждой программе.
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="w-4 h-4 text-success flex-shrink-0 mt-0.5" />
                  Файрвол kill-switch — если VPN упадёт, трафик не утечёт через обычное подключение.
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="w-4 h-4 text-success flex-shrink-0 mt-0.5" />
                  Локальная сеть (принтер, NAS, роутер) продолжает работать.
                </li>
              </ul>
            </div>
          )}

          {step === 'proxy' && (
            <div className="space-y-4">
              <h3 className="text-xl font-bold text-gray-100">Шаг 1. Найдём ваш VPN-клиент</h3>
              <p className="text-sm text-gray-400 leading-relaxed">
                Приложение работает поверх Happ или другого SOCKS5/HTTP-прокси. Запустите Happ и нажмите
                «Найти». Если у вас другой клиент — введите адрес вручную.
              </p>

              {hasProxy ? (
                <div className="rounded-lg border border-success/40 bg-success/10 p-4 space-y-1">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-success" />
                    <span className="text-sm font-semibold text-success">Прокси найден</span>
                  </div>
                  <p className="text-sm text-gray-200 font-mono">
                    {proxy?.host}:{proxy?.port} ({proxy?.type.toUpperCase()})
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  <button
                    onClick={detect}
                    disabled={detecting}
                    className="w-full flex items-center justify-center gap-2 rounded-lg border border-accent/40 bg-accent/10 px-4 py-3 text-sm font-semibold text-accent hover:bg-accent/20 transition-colors disabled:opacity-50"
                  >
                    {detecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                    {detecting ? 'Ищем…' : 'Поискать прокси автоматически'}
                  </button>

                  <div className="text-xs text-gray-500 text-center">или введите вручную</div>

                  <div className="space-y-2">
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={manualAddr}
                        onChange={(e) => {
                          setManualAddr(e.target.value)
                          setManualError(null)
                        }}
                        placeholder="127.0.0.1:2080"
                        className="flex-1 bg-surface-light border border-surface-lighter/50 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-accent/50"
                      />
                      <select
                        value={manualType}
                        onChange={(e) => setManualType(e.target.value === 'http' ? 'http' : 'socks5')}
                        className="bg-surface-light border border-surface-lighter/50 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-accent/50"
                      >
                        <option value="socks5">SOCKS5</option>
                        <option value="http">HTTP</option>
                      </select>
                    </div>
                    {manualError && <p className="text-xs text-danger">{manualError}</p>}
                    <button
                      onClick={applyManual}
                      disabled={!manualAddr.trim()}
                      className="w-full px-4 py-2 rounded-lg bg-accent/10 text-accent text-sm font-semibold border border-accent/30 hover:bg-accent/20 transition-colors disabled:opacity-50"
                    >
                      Использовать этот адрес
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {step === 'killswitch' && (
            <div className="space-y-4">
              <h3 className="text-xl font-bold text-gray-100">Шаг 2. Защита от утечки</h3>
              <p className="text-sm text-gray-400 leading-relaxed">
                Kill-switch блокирует трафик через файрвол Windows, если sing-box неожиданно упадёт.
                Без него ваш реальный IP может «утечь» наружу. Рекомендуем оставить включённым.
              </p>

              <label className="flex items-start gap-3 rounded-lg border border-surface-lighter/40 bg-surface-light p-4 cursor-pointer hover:border-accent/40 transition-colors">
                <input
                  type="checkbox"
                  checked={settings.firewallKillSwitch}
                  onChange={(e) => updateSettings({ firewallKillSwitch: e.target.checked })}
                  className="mt-1 w-4 h-4 accent-accent"
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <Lock className="w-4 h-4 text-success" />
                    <span className="text-sm font-semibold text-gray-200">
                      Включить файрвол kill-switch (рекомендуется)
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 mt-1 leading-relaxed">
                    Перед стартом TUN ставит правила Windows Firewall. Если sing-box упадёт, трафик
                    останется заблокирован, пока вы не перезапустите защиту или не снимите блокировку
                    вручную.
                  </p>
                </div>
              </label>

              <label className="flex items-start gap-3 rounded-lg border border-surface-lighter/40 bg-surface-light p-4 cursor-pointer hover:border-accent/40 transition-colors">
                <input
                  type="checkbox"
                  checked={settings.autoRestartOnCrash}
                  onChange={(e) => updateSettings({ autoRestartOnCrash: e.target.checked })}
                  className="mt-1 w-4 h-4 accent-accent"
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <RefreshCw className="w-4 h-4 text-accent" />
                    <span className="text-sm font-semibold text-gray-200">Авто-перезапуск sing-box при крахе</span>
                  </div>
                  <p className="text-xs text-gray-500 mt-1 leading-relaxed">
                    Если sing-box внезапно упадёт, попробуем перезапустить его до 3 раз с паузой. Это лечит
                    большинство случаев временных сбоев.
                  </p>
                </div>
              </label>
            </div>
          )}

          {step === 'ready' && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-full bg-success/20 flex items-center justify-center">
                  <ShieldCheck className="w-7 h-7 text-success" />
                </div>
                <div>
                  <h3 className="text-xl font-bold text-gray-100">Всё готово</h3>
                  <p className="text-sm text-gray-400">Можно включать защиту.</p>
                </div>
              </div>

              <div className="rounded-lg border border-surface-lighter/40 bg-surface-light p-4 space-y-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-gray-500">Прокси</span>
                  <span className="font-mono text-gray-200">
                    {proxy ? `${proxy.host}:${proxy.port}` : 'не задан'}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-500">Тип</span>
                  <span className="text-gray-200">{(proxy?.type || 'socks5').toUpperCase()}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-500">Файрвол kill-switch</span>
                  <span className={settings.firewallKillSwitch ? 'text-success' : 'text-gray-400'}>
                    {settings.firewallKillSwitch ? 'Включён' : 'Выключен'}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-500">Авто-перезапуск</span>
                  <span className={settings.autoRestartOnCrash ? 'text-success' : 'text-gray-400'}>
                    {settings.autoRestartOnCrash ? 'Включён' : 'Выключен'}
                  </span>
                </div>
              </div>

              <p className="text-xs text-gray-500 leading-relaxed">
                Эти и другие параметры можно поменять в Настройках. Если что-то понадобится продвинутое
                (отдельные приложения, диагностика Microsoft Store, ручной откат настроек прокси) —
                включите «Расширенный режим» в Настройках.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-surface-lighter/30 flex items-center justify-between">
          <button
            onClick={() => {
              const order: Step[] = ['intro', 'proxy', 'killswitch', 'ready']
              const idx = order.indexOf(step)
              if (idx > 0) setStep(order[idx - 1])
            }}
            disabled={step === 'intro'}
            className="text-sm text-gray-400 hover:text-gray-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            ← Назад
          </button>

          <div className="flex items-center gap-2">
            <button
              onClick={onSkip}
              className="text-sm text-gray-500 hover:text-gray-300 px-3 py-2 transition-colors"
            >
              Пропустить
            </button>
            {step !== 'ready' ? (
              <button
                onClick={() => {
                  const order: Step[] = ['intro', 'proxy', 'killswitch', 'ready']
                  const idx = order.indexOf(step)
                  // Don't let the user proceed past "proxy" without a proxy.
                  if (step === 'proxy' && !hasProxy) {
                    addLog('warn', 'Сначала задайте прокси (автоматически или вручную).')
                    return
                  }
                  if (idx < order.length - 1) setStep(order[idx + 1])
                }}
                className="px-4 py-2 rounded-lg bg-accent text-white text-sm font-semibold hover:bg-accent/90 transition-colors flex items-center gap-1.5"
              >
                Дальше <ArrowRight className="w-4 h-4" />
              </button>
            ) : (
              <button
                onClick={onComplete}
                className="px-4 py-2 rounded-lg bg-success text-black text-sm font-bold hover:bg-success/90 transition-colors flex items-center gap-1.5"
              >
                Готово <CheckCircle2 className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
