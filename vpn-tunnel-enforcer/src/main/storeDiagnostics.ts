import { exec as execCb, execFile as execFileCb } from 'child_process'
import { Socket } from 'net'
import { promisify } from 'util'
import { getLocationPrivacyStatus } from './locationPrivacy'
import { isProcessElevated } from './admin'

const exec = promisify(execCb)
const execFile = promisify(execFileCb)

type DiagnosticStatus = 'ok' | 'warn' | 'fail' | 'info'

export interface StoreDiagnosticItem {
  id: string
  label: string
  status: DiagnosticStatus
  value: string
  details?: string
}

export interface StoreDiagnosticResult {
  ranAt: number
  summary: DiagnosticStatus
  items: StoreDiagnosticItem[]
}

const MAX_BUFFER = 1024 * 1024 * 4

function encodedPowerShell(script: string) {
  const prelude =
    '$OutputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new();' +
    '[Console]::InputEncoding=[System.Text.UTF8Encoding]::new();'
  return Buffer.from(prelude + script, 'utf16le').toString('base64')
}

async function ps(script: string, timeout = 15000): Promise<string> {
  const { stdout, stderr } = await exec(
    `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodedPowerShell(script)}`,
    {
      windowsHide: true,
      timeout,
      maxBuffer: MAX_BUFFER,
      encoding: 'utf8'
    }
  )
  return (stdout || stderr || '').trim()
}

function parseJson<T = any>(raw: string): T | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed) as T
  } catch {
    return null
  }
}

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

function combineStatus(items: StoreDiagnosticItem[]): DiagnosticStatus {
  if (items.some(i => i.status === 'fail')) return 'fail'
  if (items.some(i => i.status === 'warn')) return 'warn'
  return 'ok'
}

function shortError(err: any): string {
  const stderr = typeof err?.stderr === 'string' ? err.stderr.trim() : ''
  const stdout = typeof err?.stdout === 'string' ? err.stdout.trim() : ''
  const message = err?.message || String(err)
  return stderr || stdout || message
}

interface ProxyEndpoint {
  source: string
  host: string
  port: number
  raw: string
}

function probeTcp(host: string, port: number, timeout = 1200): Promise<boolean> {
  return new Promise(resolve => {
    const socket = new Socket()
    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      socket.destroy()
      resolve(ok)
    }

    socket.setTimeout(timeout)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    socket.connect(port, host)
  })
}

function extractProxyEndpoints(source: string, raw: string | null | undefined): ProxyEndpoint[] {
  if (!raw) return []
  const endpoints: ProxyEndpoint[] = []
  const rx = /(?:(?:https?|socks5?|socks):\/\/)?(\[[0-9a-fA-F:]+\]|localhost|(?:\d{1,3}\.){3}\d{1,3}|[a-zA-Z0-9.-]+):(\d{2,5})/g
  for (const match of raw.matchAll(rx)) {
    const host = match[1].replace(/^\[|\]$/g, '')
    const port = Number(match[2])
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) continue
    endpoints.push({ source, host, port, raw })
  }
  return endpoints
}

async function getProxyEndpointHealth(): Promise<StoreDiagnosticItem> {
  const endpoints: ProxyEndpoint[] = []

  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
    endpoints.push(...extractProxyEndpoints(`env:${name}`, process.env[name]))
  }

  try {
    const { stdout, stderr } = await exec('netsh winhttp show proxy', {
      windowsHide: true,
      timeout: 8000,
      maxBuffer: MAX_BUFFER,
      encoding: 'utf8'
    })
    endpoints.push(...extractProxyEndpoints('WinHTTP', stdout || stderr))
  } catch {
    // The separate WinHTTP row reports the command error.
  }

  try {
    const raw = await ps(`
$p=Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction Stop;
[pscustomobject]@{
  ProxyEnable=$p.ProxyEnable;
  ProxyServer=$p.ProxyServer;
  AutoConfigURL=$p.AutoConfigURL
} | ConvertTo-Json -Compress
`)
    const data = parseJson<any>(raw)
    if (Number(data?.ProxyEnable) === 1) endpoints.push(...extractProxyEndpoints('User proxy', data?.ProxyServer))
    endpoints.push(...extractProxyEndpoints('User PAC', data?.AutoConfigURL))
  } catch {
    // The separate user proxy row reports the registry error.
  }

  const unique = new Map<string, ProxyEndpoint>()
  for (const endpoint of endpoints) {
    unique.set(`${endpoint.source}:${endpoint.host}:${endpoint.port}`, endpoint)
  }
  const rows = [...unique.values()]

  if (rows.length === 0) {
    return {
      id: 'proxy-endpoints',
      label: 'Proxy endpoints',
      status: 'info',
      value: 'Не настроены',
      details: 'WinHTTP/User/env proxy endpoints не найдены'
    }
  }

  const probes = await Promise.all(rows.map(async endpoint => ({
    ...endpoint,
    alive: await probeTcp(endpoint.host, endpoint.port)
  })))

  const closed = probes.filter(row => !row.alive)
  const criticalClosed = closed.filter(row => row.source === 'WinHTTP' || row.source === 'User proxy')
  const distinctPorts = [...new Set(probes.map(row => `${row.host}:${row.port}`))]
  const status: DiagnosticStatus =
    criticalClosed.length > 0 ? 'fail' : closed.length > 0 || distinctPorts.length > 1 ? 'warn' : 'ok'

  return {
    id: 'proxy-endpoints',
    label: 'Proxy endpoints',
    status,
    value: `${probes.filter(row => row.alive).length}/${probes.length} TCP open`,
    details: [
      probes.map(row => `${row.source}=${row.host}:${row.port} ${row.alive ? 'open' : 'closed'}`).join(' | '),
      distinctPorts.length > 1
        ? `Разные proxy endpoints: ${distinctPorts.join(', ')}. Store может использовать WinHTTP/User proxy, а не тот порт, через который проверяется браузер.`
        : ''
    ].filter(Boolean).join(' | ')
  }
}

async function getElevationStatus(): Promise<StoreDiagnosticItem> {
  const elevated = await isProcessElevated()
  return {
    id: 'admin',
    label: 'Admin mode',
    status: elevated ? 'ok' : 'warn',
    value: elevated ? 'Elevated' : 'Not elevated',
    details: elevated
      ? 'Приложение запущено с правами администратора; отдельные admin-команды не должны просить UAC повторно.'
      : 'Для TUN, WinHTTP и registry repair нужен elevated запуск.'
  }
}

async function getStorePackages(): Promise<StoreDiagnosticItem> {
  try {
    const raw = await ps(`
$names=@('Microsoft.WindowsStore','Microsoft.StorePurchaseApp','Microsoft.Services.Store.Engagement','Microsoft.XboxIdentityProvider');
$names | ForEach-Object {
  $p=Get-AppxPackage -Name $_ -ErrorAction SilentlyContinue | Select-Object -First 1;
  if ($p) {
    [pscustomobject]@{
      Name=$p.Name;
      Version=$p.Version.ToString();
      Status=$p.Status.ToString();
      PackageFullName=$p.PackageFullName;
      InstallLocation=$p.InstallLocation
    }
  } else {
    [pscustomobject]@{ Name=$_; Missing=$true }
  }
} | ConvertTo-Json -Compress
`)
    const rows = asArray<any>(parseJson(raw))
    const store = rows.find(row => row.Name === 'Microsoft.WindowsStore')
    const missing = rows.filter(row => row.Missing).map(row => row.Name)
    if (!store || store.Missing) {
      return {
        id: 'store-packages',
        label: 'Store packages',
        status: 'fail',
        value: 'Microsoft.WindowsStore не найден',
        details: raw || 'Get-AppxPackage вернул пустой ответ'
      }
    }

    const badStatus = rows.filter(row => !row.Missing && row.Status && row.Status !== 'Ok').map(row => `${row.Name}: ${row.Status}`)
    return {
      id: 'store-packages',
      label: 'Store packages',
      status: badStatus.length > 0 ? 'warn' : 'ok',
      value: `${store.Version}${store.Status ? ` (${store.Status})` : ''}`,
      details: [
        `PackageFullName: ${store.PackageFullName}`,
        missing.length > 0 ? `Отсутствуют optional-пакеты: ${missing.join(', ')}` : '',
        badStatus.length > 0 ? `Нестандартный статус: ${badStatus.join('; ')}` : '',
        `InstallLocation: ${store.InstallLocation || 'not set'}`
      ].filter(Boolean).join(' | ')
    }
  } catch (err: any) {
    return {
      id: 'store-packages',
      label: 'Store packages',
      status: 'fail',
      value: 'Не удалось проверить',
      details: shortError(err)
    }
  }
}

async function getStoreServices(): Promise<StoreDiagnosticItem> {
  try {
    const raw = await ps(`
$names=@('BITS','DoSvc','InstallService','ClipSVC','AppXSvc','LicenseManager','wuauserv','WinHttpAutoProxySvc');
$names | ForEach-Object {
  $s=Get-Service -Name $_ -ErrorAction SilentlyContinue;
  if ($s) {
    [pscustomobject]@{
      Name=$s.Name;
      DisplayName=$s.DisplayName;
      Status=$s.Status.ToString();
      StartType=$s.StartType.ToString()
    }
  } else {
    [pscustomobject]@{ Name=$_; Missing=$true }
  }
} | ConvertTo-Json -Compress
`)
    const rows = asArray<any>(parseJson(raw))
    const disabled = rows.filter(row => row.StartType === 'Disabled').map(row => row.Name)
    const missing = rows.filter(row => row.Missing).map(row => row.Name)
    const stoppedImportant = rows
      .filter(row => ['BITS', 'DoSvc', 'InstallService', 'ClipSVC', 'AppXSvc', 'LicenseManager', 'wuauserv'].includes(row.Name))
      .filter(row => row.Status && row.Status !== 'Running')
      .map(row => `${row.Name}:${row.Status}/${row.StartType}`)

    return {
      id: 'store-services',
      label: 'Store services',
      status: disabled.length > 0 ? 'fail' : missing.length > 0 ? 'warn' : 'ok',
      value: disabled.length > 0 ? `Disabled: ${disabled.join(', ')}` : 'Проверены',
      details: [
        rows.filter(row => !row.Missing).map(row => `${row.Name}:${row.Status}/${row.StartType}`).join(' | '),
        missing.length > 0 ? `Не найдены: ${missing.join(', ')}` : '',
        stoppedImportant.length > 0 ? `Остановлены/trigger-start: ${stoppedImportant.join(', ')}` : ''
      ].filter(Boolean).join(' | ')
    }
  } catch (err: any) {
    return {
      id: 'store-services',
      label: 'Store services',
      status: 'warn',
      value: 'Не удалось проверить',
      details: shortError(err)
    }
  }
}

async function getWinHttpProxy(): Promise<StoreDiagnosticItem> {
  try {
    const raw = await exec('netsh winhttp show proxy', {
      windowsHide: true,
      timeout: 8000,
      maxBuffer: MAX_BUFFER,
      encoding: 'utf8'
    })
    const text = (raw.stdout || raw.stderr || '').trim().replace(/\s+/g, ' ')
    return {
      id: 'winhttp-proxy',
      label: 'WinHTTP proxy',
      status: 'info',
      value: /direct access|прямой доступ|без прокси/i.test(text) ? 'Direct' : 'Proxy configured',
      details: text || 'Пустой ответ netsh'
    }
  } catch (err: any) {
    return {
      id: 'winhttp-proxy',
      label: 'WinHTTP proxy',
      status: 'warn',
      value: 'Ошибка netsh',
      details: shortError(err)
    }
  }
}

async function getUserProxy(): Promise<StoreDiagnosticItem> {
  try {
    const raw = await ps(`
$p=Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction Stop;
[pscustomobject]@{
  ProxyEnable=$p.ProxyEnable;
  ProxyServer=$p.ProxyServer;
  AutoConfigURL=$p.AutoConfigURL;
  AutoDetect=$p.AutoDetect
} | ConvertTo-Json -Compress
`)
    const data = parseJson<any>(raw)
    const enabled = Number(data?.ProxyEnable) === 1
    const hasPac = Boolean(data?.AutoConfigURL)
    return {
      id: 'user-proxy',
      label: 'User proxy/PAC',
      status: enabled || hasPac ? 'warn' : 'ok',
      value: enabled ? String(data?.ProxyServer || 'enabled') : hasPac ? 'PAC configured' : 'Не включён',
      details: `ProxyEnable=${data?.ProxyEnable ?? 'not set'} | ProxyServer=${data?.ProxyServer || 'not set'} | AutoConfigURL=${data?.AutoConfigURL || 'not set'} | AutoDetect=${data?.AutoDetect ?? 'not set'}`
    }
  } catch (err: any) {
    return {
      id: 'user-proxy',
      label: 'User proxy/PAC',
      status: 'warn',
      value: 'Не удалось проверить',
      details: shortError(err)
    }
  }
}

async function getRegionInfo(): Promise<StoreDiagnosticItem> {
  try {
    const raw = await ps(`
$home=Get-WinHomeLocation;
$culture=Get-Culture;
$ui=Get-UICulture;
$tz=Get-TimeZone;
$region=[System.Globalization.RegionInfo]::CurrentRegion;
[pscustomobject]@{
  HomeLocation=$home.HomeLocation;
  GeoId=$home.GeoId;
  Culture=$culture.Name;
  UICulture=$ui.Name;
  Region=$region.Name;
  TimeZone=$tz.Id
} | ConvertTo-Json -Compress
`)
    const data = parseJson<any>(raw)
    return {
      id: 'region',
      label: 'Регион Windows',
      status: 'info',
      value: `${data?.HomeLocation || data?.Region || 'unknown'} / ${data?.Culture || 'unknown'}`,
      details: `GeoId=${data?.GeoId ?? 'unknown'} | UICulture=${data?.UICulture ?? 'unknown'} | Region=${data?.Region ?? 'unknown'} | TimeZone=${data?.TimeZone ?? 'unknown'}`
    }
  } catch (err: any) {
    return {
      id: 'region',
      label: 'Регион Windows',
      status: 'warn',
      value: 'Не удалось проверить',
      details: shortError(err)
    }
  }
}

async function getLocationPrivacy(): Promise<StoreDiagnosticItem> {
  try {
    const status = await getLocationPrivacyStatus()
    return {
      id: 'location-privacy',
      label: 'Location privacy',
      status: status.applied ? 'ok' : 'warn',
      value: status.applied ? 'Ограничено' : 'Разрешено системой',
      details: status.details.join(' | ')
    }
  } catch (err: any) {
    return {
      id: 'location-privacy',
      label: 'Location privacy',
      status: 'warn',
      value: 'Не удалось проверить',
      details: shortError(err)
    }
  }
}

async function curlEndpoint(id: string, label: string, url: string): Promise<StoreDiagnosticItem> {
  try {
    const { stdout, stderr } = await execFile(
      'curl.exe',
      ['--noproxy', '*', '-4', '-L', '-sS', '-o', 'NUL', '--max-time', '12', '-w', '%{http_code}|%{remote_ip}|%{time_total}|%{errormsg}', url],
      {
        windowsHide: true,
        timeout: 15000,
        maxBuffer: MAX_BUFFER,
        encoding: 'utf8',
        env: {
          ...process.env,
          HTTP_PROXY: '',
          HTTPS_PROXY: '',
          ALL_PROXY: '',
          http_proxy: '',
          https_proxy: '',
          all_proxy: ''
        }
      }
    )
    const [codeRaw, remoteIp, timeRaw, curlError] = stdout.trim().split('|')
    const code = Number(codeRaw)
    const reachable = Boolean(remoteIp) || code > 0
    const status: DiagnosticStatus = reachable ? (code >= 500 ? 'warn' : 'ok') : 'fail'
    return {
      id,
      label,
      status,
      value: reachable ? `HTTP ${code || 'n/a'} ${remoteIp || ''}`.trim() : 'Нет соединения',
      details: `url=${url} | time=${timeRaw || 'n/a'}s${curlError ? ` | curl=${curlError}` : ''}${stderr ? ` | stderr=${stderr.trim()}` : ''}`
    }
  } catch (err: any) {
    return {
      id,
      label,
      status: 'fail',
      value: 'Нет соединения',
      details: `${url} | ${shortError(err)}`
    }
  }
}

async function getEndpointChecks(): Promise<StoreDiagnosticItem[]> {
  const endpoints = [
    ['endpoint-storeedge', 'Store edge', 'https://storeedgefd.dsx.mp.microsoft.com'] as const,
    ['endpoint-catalog', 'Display catalog', 'https://displaycatalog.mp.microsoft.com'] as const,
    ['endpoint-purchase', 'Purchase API', 'https://purchase.mp.microsoft.com'] as const,
    ['endpoint-login', 'Microsoft login', 'https://login.live.com'] as const,
    ['endpoint-images', 'Store images', 'https://store-images.s-microsoft.com'] as const,
    ['endpoint-delivery', 'Delivery API', 'http://dl.delivery.mp.microsoft.com'] as const,
    ['endpoint-connecttest', 'MSFT connect test', 'http://www.msftconnecttest.com/connecttest.txt'] as const
  ]
  return Promise.all(endpoints.map(([id, label, url]) => curlEndpoint(id, label, url)))
}

async function getEventLogSummary(logName: string, id: string, label: string): Promise<StoreDiagnosticItem> {
  try {
    const raw = await ps(`
$events=Get-WinEvent -LogName '${logName.replace(/'/g, "''")}' -MaxEvents 20 -ErrorAction Stop |
  Where-Object { $_.LevelDisplayName -eq 'Error' -or $_.LevelDisplayName -eq 'Warning' } |
  Select-Object -First 8 TimeCreated,Id,LevelDisplayName,ProviderName,Message;
$events | ConvertTo-Json -Compress
`, 12000)
    const rows = asArray<any>(parseJson(raw))
    if (rows.length === 0) {
      return { id, label, status: 'ok', value: 'Нет свежих Error/Warning', details: logName }
    }
    const details = rows.map(row => {
      const message = String(row.Message || '').replace(/\s+/g, ' ').slice(0, 220)
      return `${row.TimeCreated || ''} #${row.Id} ${row.LevelDisplayName}: ${message}`
    }).join(' | ')
    return {
      id,
      label,
      status: 'warn',
      value: `${rows.length} Error/Warning`,
      details
    }
  } catch (err: any) {
    return {
      id,
      label,
      status: 'info',
      value: 'Журнал недоступен/пуст',
      details: `${logName}: ${shortError(err)}`
    }
  }
}

async function getCacheSummary(): Promise<StoreDiagnosticItem> {
  try {
    const raw = await ps(`
$base=Join-Path $env:LOCALAPPDATA 'Packages\\Microsoft.WindowsStore_8wekyb3d8bbwe';
$names=@('LocalCache','AC','TempState','Settings');
$names | ForEach-Object {
  $path=Join-Path $base $_;
  if (Test-Path -LiteralPath $path) {
    $items=Get-ChildItem -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue;
    $size=($items | Measure-Object -Property Length -Sum).Sum;
    [pscustomobject]@{ Name=$_; Exists=$true; Count=@($items).Count; SizeBytes=[int64]($size -as [int64]); Path=$path }
  } else {
    [pscustomobject]@{ Name=$_; Exists=$false; Count=0; SizeBytes=0; Path=$path }
  }
} | ConvertTo-Json -Compress
`, 15000)
    const rows = asArray<any>(parseJson(raw))
    const missing = rows.filter(row => !row.Exists).map(row => row.Name)
    const localCache = rows.find(row => row.Name === 'LocalCache')
    return {
      id: 'store-cache',
      label: 'Store cache',
      status: missing.includes('LocalCache') ? 'warn' : 'info',
      value: localCache?.Exists ? `${localCache.Count} files, ${Math.round((Number(localCache.SizeBytes) || 0) / 1024)} KB` : 'LocalCache отсутствует',
      details: rows.map(row => `${row.Name}:${row.Exists ? `${row.Count} files/${Math.round((Number(row.SizeBytes) || 0) / 1024)} KB` : 'missing'}`).join(' | ')
    }
  } catch (err: any) {
    return {
      id: 'store-cache',
      label: 'Store cache',
      status: 'info',
      value: 'Не удалось посчитать',
      details: shortError(err)
    }
  }
}

async function getLoopbackExemptions(): Promise<StoreDiagnosticItem> {
  try {
    const { stdout, stderr } = await exec('cmd /d /c chcp 65001>nul & CheckNetIsolation.exe LoopbackExempt -s', {
      windowsHide: true,
      timeout: 8000,
      maxBuffer: MAX_BUFFER,
      encoding: 'utf8'
    })
    const rawText = (stdout || stderr || '').trim().replace(/\s+/g, ' ')
    const textLooksBroken = /�|����|᫨|몠|����/.test(rawText)
    const text = textLooksBroken
      ? 'Команда выполнена. Windows вернула локализованный OEM-текст, поэтому подробный список скрыт.'
      : rawText
    return {
      id: 'loopback-exempt',
      label: 'UWP loopback',
      status: 'ok',
      value: text ? 'Список прочитан' : 'Пусто',
      details: text || 'LoopbackExempt пуст или недоступен'
    }
  } catch (err: any) {
    return {
      id: 'loopback-exempt',
      label: 'UWP loopback',
      status: 'info',
      value: 'Недоступно',
      details: shortError(err)
    }
  }
}

async function getPublicIpForStorePath(): Promise<StoreDiagnosticItem> {
  try {
    const { stdout, stderr } = await execFile(
      'curl.exe',
      ['--noproxy', '*', '-4', '-sS', '--max-time', '10', 'https://api.ipify.org'],
      {
        windowsHide: true,
        timeout: 12000,
        maxBuffer: MAX_BUFFER,
        encoding: 'utf8',
        env: {
          ...process.env,
          HTTP_PROXY: '',
          HTTPS_PROXY: '',
          ALL_PROXY: '',
          http_proxy: '',
          https_proxy: '',
          all_proxy: ''
        }
      }
    )
    const ip = stdout.trim()
    return {
      id: 'store-path-ipv4',
      label: 'IPv4 через WinINet/curl',
      status: /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? 'ok' : 'warn',
      value: ip || 'Нет ответа',
      details: stderr?.trim() || 'curl.exe -4 https://api.ipify.org'
    }
  } catch (err: any) {
    return {
      id: 'store-path-ipv4',
      label: 'IPv4 через WinINet/curl',
      status: 'fail',
      value: 'Нет ответа',
      details: shortError(err)
    }
  }
}

export async function runStoreDiagnostics(): Promise<StoreDiagnosticResult> {
  if (process.platform !== 'win32') {
    const items: StoreDiagnosticItem[] = [{
      id: 'platform',
      label: 'Платформа',
      status: 'fail',
      value: process.platform,
      details: 'Microsoft Store diagnostics доступны только на Windows'
    }]
    return { ranAt: Date.now(), summary: 'fail', items }
  }

  const firstWave = await Promise.all([
    getElevationStatus(),
    getStorePackages(),
    getStoreServices(),
    getWinHttpProxy(),
    getUserProxy(),
    getProxyEndpointHealth(),
    getRegionInfo(),
    getLocationPrivacy(),
    getPublicIpForStorePath()
  ])

  const [endpoints, eventStore, eventAppxServer, eventWindowsUpdate, cache, loopback] = await Promise.all([
    getEndpointChecks(),
    getEventLogSummary('Microsoft-Windows-Store/Operational', 'event-store', 'Store event log'),
    getEventLogSummary('Microsoft-Windows-AppXDeploymentServer/Operational', 'event-appx-server', 'AppX event log'),
    getEventLogSummary('Microsoft-Windows-WindowsUpdateClient/Operational', 'event-wu', 'Windows Update log'),
    getCacheSummary(),
    getLoopbackExemptions()
  ])

  const items = [
    ...firstWave,
    ...endpoints,
    eventStore,
    eventAppxServer,
    eventWindowsUpdate,
    cache,
    loopback
  ]

  return {
    ranAt: Date.now(),
    summary: combineStatus(items),
    items
  }
}
