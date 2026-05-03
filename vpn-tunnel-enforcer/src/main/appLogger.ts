import { app, shell } from 'electron'
import { mkdir, open, readFile, stat, writeFile, appendFile } from 'fs/promises'
import { join } from 'path'

export type AppLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogFileSnapshot {
  name: string
  path: string
  exists: boolean
  size: number
  truncated: boolean
  content: string
}

const MAX_DETAIL_CHARS = 4000
const MAX_READ_BYTES = 1024 * 1024

let queue = Promise.resolve()

export function getLogDir(): string {
  return join(app.getPath('userData'), 'logs')
}

export function getAppLogPath(): string {
  return join(getLogDir(), 'app.log')
}

function getTunLogDir(): string {
  return join(app.getPath('userData'), 'tun-runtime')
}

function normalizeDetail(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack
    }
  }

  if (typeof value === 'string') {
    return value.length > MAX_DETAIL_CHARS ? `${value.slice(0, MAX_DETAIL_CHARS)}...<truncated>` : value
  }

  try {
    const raw = JSON.stringify(value)
    if (!raw) return value
    if (raw.length <= MAX_DETAIL_CHARS) return value
    return `${raw.slice(0, MAX_DETAIL_CHARS)}...<truncated>`
  } catch {
    return String(value)
  }
}

function formatLine(level: AppLogLevel, scope: string, message: string, details?: unknown): string {
  return JSON.stringify({
    ts: new Date().toISOString(),
    level,
    scope,
    message,
    details: details === undefined ? undefined : normalizeDetail(details)
  }) + '\n'
}

export function logEvent(level: AppLogLevel, scope: string, message: string, details?: unknown): void {
  const line = formatLine(level, scope, message, details)
  queue = queue
    .then(async () => {
      await mkdir(getLogDir(), { recursive: true })
      await appendFile(getAppLogPath(), line, 'utf8')
    })
    .catch(() => undefined)

  const consoleLine = `[${scope}] ${message}`
  if (level === 'error') console.error(consoleLine, details ?? '')
  else if (level === 'warn') console.warn(consoleLine, details ?? '')
  else console.log(consoleLine, details ?? '')
}

async function readTail(path: string, maxBytes = MAX_READ_BYTES): Promise<LogFileSnapshot> {
  try {
    const info = await stat(path)
    if (info.size <= maxBytes) {
      return {
        name: path.split(/[\\/]/).pop() || path,
        path,
        exists: true,
        size: info.size,
        truncated: false,
        content: await readFile(path, 'utf8')
      }
    }

    const handle = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(maxBytes)
      await handle.read(buffer, 0, maxBytes, Math.max(0, info.size - maxBytes))
      return {
        name: path.split(/[\\/]/).pop() || path,
        path,
        exists: true,
        size: info.size,
        truncated: true,
        content: buffer.toString('utf8')
      }
    } finally {
      await handle.close()
    }
  } catch {
    return {
      name: path.split(/[\\/]/).pop() || path,
      path,
      exists: false,
      size: 0,
      truncated: false,
      content: ''
    }
  }
}

export async function getFullLogs(): Promise<LogFileSnapshot[]> {
  const files = [
    getAppLogPath(),
    join(getTunLogDir(), 'sing-box.log'),
    join(getTunLogDir(), 'sing-box.prev.log'),
    join(getTunLogDir(), 'sing-box.json')
  ]
  return Promise.all(files.map(file => readTail(file)))
}

export async function clearAppLog(): Promise<void> {
  await mkdir(getLogDir(), { recursive: true })
  await writeFile(getAppLogPath(), '', 'utf8')
}

export async function openLogFolder(): Promise<string> {
  await mkdir(getLogDir(), { recursive: true })
  await shell.openPath(getLogDir())
  return getLogDir()
}
