import { useEffect, useState } from 'react'
import { CheckCircle2, Loader2, Radar, RefreshCw, Shield, ShieldAlert, ShieldCheck, ShieldOff, TriangleAlert } from 'lucide-react'
import { useAppStore, type Mode } from '../store'

type PlanStatus = 'ready' | 'protected' | 'blocked' | 'broken'

interface RoutingPlanStep {
  label: string
  before: string
  after: string
  status: 'ok' | 'warn' | 'fail' | 'info'
}

interface RoutingPlan {
  status: PlanStatus
  recommendedMode: Mode
  title: string
  explanation: string
  before: string
  after: string
  canStartHard: boolean
  proxy: { host: string; port: number; type: 'socks5' | 'http'; verified: boolean } | null
  blockers: string[]
  steps: RoutingPlanStep[]
}

interface AutoPilotResult {
  summary: 'ok' | 'warn' | 'fail'
  mode: Mode
  title: string
  message: string
  changed: boolean
  steps: RoutingPlanStep[]
  plan: RoutingPlan
}

interface ProgressStep {
  label: string
  detail: string
  state: 'pending' | 'running' | 'done' | 'failed'
}

const progressTemplate: ProgressStep[] = [
  { label: 'Проверка текущего маршрута', detail: 'Смотрю, есть ли уже системный VPN/TUN.', state: 'pending' },
  { label: 'Проверка proxy', detail: 'Проверяю, есть ли живой локальный proxy-порт.', state: 'pending' },
  { label: 'Решение', detail: 'Выбираю безопасный режим без двойного туннеля.', state: 'pending' },
  { label: 'Применение', detail: 'Запускаю или останавливаю только то, что нужно.', state: 'pending' }
]

function cloneProgress() {
  return progressTemplate.map(step => ({ ...step }))
}

function statusClass(status?: PlanStatus | RoutingPlanStep['status']) {
  if (status === 'ready' || status === 'protected' || status === 'ok') return 'text-success'
  if (status === 'blocked' || status === 'warn') return 'text-warning'
  if (status === 'broken' || status === 'fail') return 'text-danger'
  return 'text-gray-400'
}

function planBadge(plan: RoutingPlan | null) {
  if (!plan) return 'Проверка не запускалась'
  if (plan.status === 'ready') return 'Можно включать'
  if (plan.status === 'protected') return 'VPN уже есть'
  if (plan.status === 'broken') return 'Конфликт туннелей'
  return 'Нужно действие'
}

function progressState(status: RoutingPlanStep['status']): ProgressStep['state'] {
  return status === 'fail' ? 'failed' : 'done'
}

export function ModeSwitch() {
  const mode = useAppStore(s => s.mode)
  const setMode = useAppStore(s => s.setMode)
  const tunRunning = useAppStore(s => s.tunRunning)
  const proxy = useAppStore(s => s.proxy)
  const settings = useAppStore(s => s.settings)
  const addLog = useAppStore(s => s.addLog)
  const setPublicIp = useAppStore(s => s.setPublicIp)
  const setVpnIp = useAppStore(s => s.setVpnIp)
  const setTunRunning = useAppStore(s => s.setTunRunning)
  const [plan, setPlan] = useState<RoutingPlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string>('Сначала нажмите “Проверить маршрут” или выберите режим. Приложение объяснит, что изменится.')
  const [progress, setProgress] = useState<ProgressStep[]>(cloneProgress())

  const getEffectiveProxy = (freshPlan?: RoutingPlan | null) => {
    if (freshPlan?.proxy) return freshPlan.proxy
    const override = settings.proxyOverride.trim()
    if (override) {
      const separator = override.lastIndexOf(':')
      const host = override.slice(0, separator).trim()
      const port = parseInt(override.slice(separator + 1), 10)
      if (separator > 0 && Number.isInteger(port) && port > 0 && port <= 65535) {
        return { host, port, type: settings.proxyType, verified: true }
      }
    }
    return proxy
  }

  const markStep = (index: number, state: ProgressStep['state'], detail?: string) => {
    setProgress(current => current.map((step, i) => (
      i === index ? { ...step, state, detail: detail ?? step.detail } : step
    )))
  }

  const refreshPlan = async () => {
    setBusy(true)
    setProgress(cloneProgress())
    markStep(0, 'running')
    setNotice('Проверяю систему: активные TUN/VPN, локальный proxy и текущий режим.')
    try {
      const result = await window.electronAPI.getRoutingPlan()
      setPlan(result)
      markStep(0, 'done')
      markStep(1, result.proxy ? 'done' : 'failed', result.proxy ? `Найден ${result.proxy.host}:${result.proxy.port}` : 'Живой proxy не найден.')
      markStep(2, result.canStartHard ? 'done' : result.status === 'protected' ? 'done' : 'failed', result.title)
      markStep(3, 'done', 'Пока ничего не менял, только показал безопасный план.')
      setNotice(`${result.before} ${result.after}`)
      if (result.recommendedMode === 'external') setMode('external')
      addLog(result.status === 'broken' ? 'error' : result.status === 'blocked' ? 'warn' : 'info', `План маршрута: ${result.title}`)
      return result as RoutingPlan
    } catch (err: any) {
      markStep(0, 'failed', err.message)
      setNotice(`Не удалось проверить маршрут: ${err.message}`)
      addLog('error', `Не удалось проверить маршрут: ${err.message}`)
      return null
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    refreshPlan()
  }, [])

  const stopHardMode = async () => {
    setProgress(cloneProgress())
    markStep(0, 'done', 'VPNTE-TUN сейчас включен.')
    markStep(1, 'done', 'Proxy не трогаю.')
    markStep(2, 'running', 'Останавливаю только туннель VPNTE.')
    setNotice('Было: VPNTE-TUN перехватывал системный интернет. Станет: VPNTE-TUN выключен, остальная сеть и внешний VPN останутся как есть.')
    const result = await window.electronAPI.stopTun()
    if (result.success) {
      markStep(2, 'done')
      markStep(3, 'done', 'Готово: системный TUN приложения остановлен.')
      setVpnIp(null)
      setMode('off')
      addLog('info', 'VPNTE-TUN остановлен. Системные proxy-настройки не тронуты.')
    } else {
      markStep(3, 'failed', result.error || 'Неизвестная ошибка')
      addLog('error', `Не удалось остановить VPNTE-TUN: ${result.error}`)
    }
    await refreshPlan()
  }

  const runAutoPilotFlow = async () => {
    if (busy) return
    setBusy(true)
    setProgress(cloneProgress())
    markStep(0, 'running', 'Автопилот сам смотрит, есть ли уже системный VPN/TUN.')
    markStep(1, 'pending', 'Если нужен proxy, автопилот сам найдет рабочий локальный порт.')
    markStep(2, 'pending', 'Режим будет выбран по фактической сети, а не по названию адаптера.')
    markStep(3, 'pending', 'Применятся только безопасные изменения.')
    setNotice('Автопилот проверяет сеть и сам выберет режим: внешний VPN, мягкий proxy или один системный TUN.')

    try {
      const result = await window.electronAPI.runAutoPilot() as AutoPilotResult
      setPlan(result.plan)
      setMode(result.mode)
      setTunRunning(result.mode === 'hard')
      if (result.mode !== 'hard') setVpnIp(null)

      const resultSteps = result.steps.length
        ? result.steps.map(step => ({
          label: step.label,
          detail: `Было: ${step.before} Станет: ${step.after}`,
          state: progressState(step.status)
        }))
        : cloneProgress().map(step => ({ ...step, state: result.summary === 'fail' ? 'failed' as const : 'done' as const }))
      setProgress(resultSteps)
      setNotice(`${result.title}. ${result.message}`)
      addLog(result.summary === 'fail' ? 'error' : result.summary === 'warn' ? 'warn' : 'info', `${result.title}: ${result.message}`)
    } catch (err: any) {
      markStep(0, 'failed', err.message || 'Автопилот завершился ошибкой.')
      setNotice(`Автопилот не смог применить маршрут: ${err.message || 'неизвестная ошибка'}`)
      addLog('error', `Автопилот не смог применить маршрут: ${err.message || 'неизвестная ошибка'}`)
    } finally {
      setBusy(false)
    }
  }

  const handleModeChange = async (newMode: Mode) => {
    if (busy || newMode === mode) return
    setBusy(true)

    try {
      if (newMode === 'off') {
        if (mode === 'hard' && tunRunning) await stopHardMode()
        else {
          setMode('off')
          setNotice('Было: приложение могло только наблюдать за маршрутом. Станет: VPNTE ничего не перенаправляет и не меняет.')
          addLog('info', 'Режим VPNTE выключен.')
        }
        return
      }

      if (newMode === 'soft') {
        if (mode === 'hard' && tunRunning) await stopHardMode()
        setMode('soft')
        setNotice('Было: системный маршрут не менялся. Станет: вы сможете выбрать приложения, которым будет прописан proxy. Второй TUN не создается.')
        addLog('info', 'Мягкий режим выбран: настройка отдельных приложений без системного TUN.')
        return
      }

      if (newMode === 'external') {
        if (mode === 'hard' && tunRunning) await stopHardMode()
        const freshPlan = await refreshPlan()
        setMode('external')
        setNotice(freshPlan?.after || 'Было: внешний VPN/TUN уже работает. Станет: VPNTE не создает второй туннель и только показывает состояние.')
        addLog('info', 'Выбран режим наблюдения за внешним VPN/TUN.')
        return
      }

      const freshPlan = await refreshPlan()
      if (!freshPlan) return
      markStep(2, 'running', 'Проверяю, можно ли безопасно включить Hard mode.')

      if (!freshPlan.canStartHard) {
        markStep(2, 'failed', freshPlan.title)
        markStep(3, 'failed', 'Запуск отменен до изменения маршрута.')
        setMode(freshPlan.recommendedMode)
        setNotice(`${freshPlan.explanation} ${freshPlan.before} ${freshPlan.after}`)
        addLog('warn', `Hard mode не включен: ${freshPlan.title}`)
        return
      }

      const effectiveProxy = getEffectiveProxy(freshPlan)
      const proxyAddr = effectiveProxy ? `${effectiveProxy.host}:${effectiveProxy.port}` : ''
      if (!effectiveProxy || !proxyAddr) {
        markStep(3, 'failed', 'Proxy не найден.')
        setNotice('Было: proxy не найден. Станет: ничего не меняю, чтобы не сломать интернет.')
        addLog('error', 'Proxy не найден. Hard mode не включен.')
        return
      }

      markStep(2, 'done', 'Конфликтующих туннелей нет.')
      markStep(3, 'running', `Запускаю VPNTE-TUN через ${proxyAddr}.`)
      setNotice(`Было: интернет шел обычным маршрутом, proxy работал на ${proxyAddr}. Станет: внешний интернет пойдет через один VPNTE-TUN, proxy-core будет исключен из туннеля.`)

      const result = await window.electronAPI.startTun(proxyAddr, effectiveProxy.type)
      if (result.success) {
        markStep(3, 'done', 'Hard mode включен.')
        setMode('hard')
        setVpnIp(result.vpnIp ?? null)
        if (result.vpnIp) setPublicIp(result.vpnIp, false)
        if (result.warning) addLog('warn', result.warning)
        addLog('info', 'Hard mode включен: системный TUN запущен.')
      } else {
        markStep(3, 'failed', result.error || 'Неизвестная ошибка')
        setNotice(`Hard mode не включен. Причина: ${result.error || 'неизвестная ошибка'}`)
        addLog('error', `Hard mode не включен: ${result.error}`)
      }
    } finally {
      setBusy(false)
    }
  }

  const modes: { id: Mode; label: string; icon: any; desc: string; disabled?: boolean }[] = [
    { id: 'off', label: 'Выкл.', icon: ShieldOff, desc: 'VPNTE ничего не меняет' },
    { id: 'soft', label: 'Приложения', icon: ShieldAlert, desc: 'Proxy только для выбранных программ' },
    { id: 'external', label: 'Уже есть VPN', icon: ShieldCheck, desc: 'Не создавать второй TUN' },
    { id: 'hard', label: 'Hard TUN', icon: Shield, desc: 'Один системный туннель', disabled: plan ? !plan.canStartHard : false }
  ]

  const completed = progress.filter(step => step.state === 'done').length
  const failed = progress.some(step => step.state === 'failed')
  const stepPercent = progress.length ? 100 / progress.length : 25
  const percent = failed ? Math.max(stepPercent, completed * stepPercent) : completed * stepPercent

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-surface-lighter/50 bg-surface-light p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Radar className="w-4 h-4 text-accent" />
              <h3 className="text-sm font-semibold text-gray-200">Умный определитель маршрута</h3>
            </div>
            <p className={`text-sm mt-1 ${statusClass(plan?.status)}`}>{plan ? plan.title : 'Маршрут еще не проверен'}</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={refreshPlan} disabled={busy} className="btn-secondary flex items-center gap-2 text-xs disabled:opacity-50">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              Проверить
            </button>
            <button onClick={runAutoPilotFlow} disabled={busy} className="btn-primary flex items-center gap-2 text-xs disabled:opacity-50">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Radar className="w-3.5 h-3.5" />}
              Автопилот
            </button>
          </div>
        </div>

        <div className="h-2 rounded-full bg-surface overflow-hidden">
          <div className={`h-full rounded-full transition-all duration-500 ${failed ? 'bg-danger' : 'bg-success'}`} style={{ width: `${percent}%` }} />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
          {progress.map(step => (
            <div key={step.label} className="rounded-md border border-surface-lighter/30 bg-surface/60 p-2 min-h-[82px]">
              <div className="flex items-center gap-1.5">
                {step.state === 'done' ? <CheckCircle2 className="w-3.5 h-3.5 text-success" /> : step.state === 'failed' ? <TriangleAlert className="w-3.5 h-3.5 text-danger" /> : step.state === 'running' ? <Loader2 className="w-3.5 h-3.5 text-accent animate-spin" /> : <span className="w-3.5 h-3.5 rounded-full border border-gray-600" />}
                <span className="text-xs font-semibold text-gray-300">{step.label}</span>
              </div>
              <p className="text-[11px] text-gray-500 mt-1 leading-snug">{step.detail}</p>
            </div>
          ))}
        </div>

        <div className="rounded-md border border-surface-lighter/30 bg-black/15 p-3">
          <p className="text-xs text-gray-400">
            <span className={`font-semibold ${statusClass(plan?.status)}`}>{planBadge(plan)}.</span> {notice}
          </p>
          {plan?.blockers.length ? (
            <div className="mt-2 space-y-1">
              {plan.blockers.map(blocker => (
                <p key={blocker} className="text-xs text-danger">Нужно исправить: {blocker}</p>
              ))}
            </div>
          ) : null}
        </div>

        {plan?.steps.length ? (
          <div className="space-y-2">
            {plan.steps.map(step => (
              <div key={step.label} className="rounded-md border border-surface-lighter/30 bg-surface/50 p-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium text-gray-200">{step.label}</p>
                  <span className={`text-xs font-semibold ${statusClass(step.status)}`}>{step.status.toUpperCase()}</span>
                </div>
                <p className="text-xs text-gray-500 mt-1">Было: {step.before}</p>
                <p className="text-xs text-gray-400 mt-1">Станет: {step.after}</p>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {modes.map(({ id, label, icon: Icon, desc, disabled }) => (
          <button
            key={id}
            onClick={() => handleModeChange(id)}
            disabled={busy || disabled}
            className={`flex flex-col items-center gap-2 p-4 rounded-lg border-2 transition-all duration-200 active:scale-95 disabled:opacity-45 disabled:cursor-not-allowed ${
              mode === id
                ? id === 'hard'
                  ? 'border-success bg-success/10 text-success'
                  : id === 'external'
                    ? 'border-warning bg-warning/10 text-warning'
                    : id === 'soft'
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-gray-600 bg-gray-600/10 text-gray-400'
                : 'border-surface-lighter/50 bg-surface-light text-gray-400 hover:border-gray-500'
            }`}
          >
            <Icon className="w-7 h-7" />
            <span className="text-sm font-bold">{label}</span>
            <span className="text-xs opacity-70 leading-tight">{desc}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
