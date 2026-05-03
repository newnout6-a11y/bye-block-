import { app } from 'electron'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { exec as execCb } from 'child_process'
import { promisify } from 'util'
import { execElevated } from './admin'

const exec = promisify(execCb)

export interface SystemNetworkResult {
  success: boolean
  message: string
  details?: string
}

interface NetworkBackupManifest {
  createdAt: number
  internetSettingsBackup: string | null
  environmentBackup: string | null
  hklmConnectionsBackup: string | null
}

const INTERNET_SETTINGS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
const USER_ENVIRONMENT = 'HKCU\\Environment'
const HKLM_CONNECTIONS = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\\Connections'

const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy'
]

function backupDir() {
  return join(app.getPath('userData'), 'network-backups')
}

function manifestPath() {
  return join(backupDir(), 'latest-tun-network-baseline.json')
}

function timestamp() {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

function encodedPowerShell(script: string) {
  const prelude =
    '$OutputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new();' +
    '[Console]::InputEncoding=[System.Text.UTF8Encoding]::new();'
  return Buffer.from(prelude + script, 'utf16le').toString('base64')
}

async function ps(script: string, elevated = false, timeout = 30000) {
  const command = `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodedPowerShell(script)}`
  if (elevated) return execElevated(command, { timeout, maxBuffer: 1024 * 1024 * 4 })
  return exec(command, {
    windowsHide: true,
    timeout,
    maxBuffer: 1024 * 1024 * 4,
    encoding: 'utf8'
  })
}

async function exportKey(key: string, file: string, elevated = false): Promise<string | null> {
  try {
    if (elevated) await execElevated(`reg export "${key}" "${file}" /y`, { timeout: 15000 })
    else await exec(`reg export "${key}" "${file}" /y`, { windowsHide: true, timeout: 15000 })
    return file
  } catch {
    return null
  }
}

async function createBackup(): Promise<NetworkBackupManifest> {
  await mkdir(backupDir(), { recursive: true })
  const stamp = timestamp()
  const manifest: NetworkBackupManifest = {
    createdAt: Date.now(),
    internetSettingsBackup: await exportKey(INTERNET_SETTINGS, join(backupDir(), `hkcu-internet-settings-${stamp}.reg`)),
    environmentBackup: await exportKey(USER_ENVIRONMENT, join(backupDir(), `hkcu-environment-${stamp}.reg`)),
    hklmConnectionsBackup: await exportKey(HKLM_CONNECTIONS, join(backupDir(), `hklm-connections-${stamp}.reg`), true)
  }
  await writeFile(manifestPath(), JSON.stringify(manifest, null, 2), 'utf-8')
  return manifest
}

async function readManifest(): Promise<NetworkBackupManifest | null> {
  try {
    return JSON.parse(await readFile(manifestPath(), 'utf-8')) as NetworkBackupManifest
  } catch {
    return null
  }
}

function clearCurrentProcessProxyEnv() {
  for (const key of PROXY_ENV_KEYS) {
    delete process.env[key]
  }
}

async function notifyWinInetSettingsChanged() {
  await ps(`
$sig='[DllImport("wininet.dll", SetLastError=true)] public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);'
$type=Add-Type -MemberDefinition $sig -Name WinInet -Namespace Native -PassThru
$null=$type::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)
$null=$type::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)
`, false, 10000).catch(() => undefined)
}

export async function applyTunNetworkBaseline(): Promise<SystemNetworkResult> {
  if (process.platform !== 'win32') {
    return { success: false, message: 'Сетевой baseline доступен только на Windows' }
  }

  try {
    const manifest = await createBackup()
    await ps(`
netsh winhttp reset proxy | Out-Null
$internet='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
New-Item -Path $internet -Force | Out-Null
Set-ItemProperty -Path $internet -Name ProxyEnable -Type DWord -Value 0
Remove-ItemProperty -Path $internet -Name ProxyServer -ErrorAction SilentlyContinue
Remove-ItemProperty -Path $internet -Name AutoConfigURL -ErrorAction SilentlyContinue
Set-ItemProperty -Path $internet -Name AutoDetect -Type DWord -Value 0
$envKey='HKCU:\\Environment'
New-Item -Path $envKey -Force | Out-Null
@('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy') |
  ForEach-Object {
    Remove-ItemProperty -Path $envKey -Name $_ -ErrorAction SilentlyContinue
    [Environment]::SetEnvironmentVariable($_, $null, 'User')
  }
`, true, 30000)
    clearCurrentProcessProxyEnv()
    await notifyWinInetSettingsChanged()
    return {
      success: true,
      message: 'Сеть нормализована для TUN',
      details:
        'WinHTTP proxy сброшен, WinINet/User proxy и PAC отключены, env proxy удалены. ' +
        `Backup: ${manifestPath()}`
    }
  } catch (err: any) {
    return {
      success: false,
      message: err.message || String(err),
      details: err.stderr || err.stdout
    }
  }
}

export async function rollbackTunNetworkBaseline(): Promise<SystemNetworkResult> {
  if (process.platform !== 'win32') {
    return { success: false, message: 'Rollback доступен только на Windows' }
  }

  const manifest = await readManifest()
  if (!manifest) {
    return { success: false, message: 'Backup сетевых настроек не найден' }
  }

  try {
    if (manifest.internetSettingsBackup) {
      await exec(`reg import "${manifest.internetSettingsBackup}"`, { windowsHide: true, timeout: 15000 })
    }
    if (manifest.environmentBackup) {
      await exec(`reg import "${manifest.environmentBackup}"`, { windowsHide: true, timeout: 15000 })
    }
    if (manifest.hklmConnectionsBackup) {
      await execElevated(`reg import "${manifest.hklmConnectionsBackup}"`, { timeout: 15000 })
    }
    await notifyWinInetSettingsChanged()
    return {
      success: true,
      message: 'Сетевые настройки восстановлены из backup',
      details: `Backup created at: ${new Date(manifest.createdAt).toLocaleString()}`
    }
  } catch (err: any) {
    return {
      success: false,
      message: err.message || String(err),
      details: err.stderr || err.stdout
    }
  }
}
