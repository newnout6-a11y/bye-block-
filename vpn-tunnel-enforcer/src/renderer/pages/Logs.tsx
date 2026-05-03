import { useEffect, useState } from 'react'
import { useAppStore } from '../store'
import { AlertCircle, AlertTriangle, FolderOpen, Info, Loader2, RefreshCw, Trash2 } from 'lucide-react'

interface LogFileSnapshot {
  name: string
  path: string
  exists: boolean
  size: number
  truncated: boolean
  content: string
}

export function Logs() {
  const logs = useAppStore(s => s.logs)
  const clearLogs = useAppStore(s => s.clearLogs)
  const addLog = useAppStore(s => s.addLog)
  const [files, setFiles] = useState<LogFileSnapshot[]>([])
  const [loading, setLoading] = useState(false)
  const [opening, setOpening] = useState(false)

  const levelIcon = (level: string) => {
    switch (level) {
      case 'error': return <AlertCircle className="w-3.5 h-3.5 text-danger" />
      case 'warn': return <AlertTriangle className="w-3.5 h-3.5 text-warning" />
      default: return <Info className="w-3.5 h-3.5 text-accent" />
    }
  }

  const levelColor = (level: string) => {
    switch (level) {
      case 'error': return 'text-danger'
      case 'warn': return 'text-warning'
      default: return 'text-gray-400'
    }
  }

  const formatTime = (ts: number) => {
    const d = new Date(ts)
    return d.toLocaleTimeString('ru-RU', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

  const refreshLogs = async () => {
    setLoading(true)
    try {
      const result = await window.electronAPI.getFullLogs()
      setFiles(result)
    } catch (err: any) {
      addLog('error', `Failed to read full logs: ${err.message}`)
    } finally {
      setLoading(false)
    }
  }

  const openLogFolder = async () => {
    setOpening(true)
    try {
      const folder = await window.electronAPI.openLogFolder()
      addLog('info', `Opened log folder: ${folder}`)
    } catch (err: any) {
      addLog('error', `Failed to open log folder: ${err.message}`)
    } finally {
      setOpening(false)
    }
  }

  const clearAllLogs = async () => {
    clearLogs()
    try {
      await window.electronAPI.clearAppLog()
      await refreshLogs()
    } catch (err: any) {
      addLog('error', `Failed to clear app log: ${err.message}`)
    }
  }

  useEffect(() => {
    refreshLogs()
  }, [])

  return (
    <div className="space-y-4 max-w-5xl">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold text-gray-100">Logs</h2>
          <p className="text-sm text-gray-400 mt-1">Renderer events, app log, sing-box log and generated TUN config</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={refreshLogs} disabled={loading} className="btn-secondary flex items-center gap-2 text-xs disabled:opacity-50">
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Refresh
          </button>
          <button onClick={openLogFolder} disabled={opening} className="btn-secondary flex items-center gap-2 text-xs disabled:opacity-50">
            {opening ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FolderOpen className="w-3.5 h-3.5" />}
            Folder
          </button>
          <button onClick={clearAllLogs} className="btn-secondary flex items-center gap-2 text-xs">
            <Trash2 className="w-3.5 h-3.5" />
            Clear
          </button>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="flex items-center justify-between px-1 pb-3">
          <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">Live UI log</h3>
          <span className="text-xs text-gray-500">{logs.length} entries</span>
        </div>
        <div className="max-h-[260px] overflow-y-auto space-y-0">
          {logs.length === 0 ? (
            <div className="text-center py-8 text-gray-600 text-sm">No entries yet</div>
          ) : (
            logs.map((log, i) => (
              <div key={i} className="flex items-start gap-2 px-4 py-2 border-b border-surface-lighter/20 last:border-0 hover:bg-surface-lighter/20 transition-colors">
                <span className="text-xs text-gray-600 font-mono mt-0.5 w-16 flex-shrink-0">{formatTime(log.timestamp)}</span>
                {levelIcon(log.level)}
                <span className={`text-xs break-words ${levelColor(log.level)}`}>{log.message}</span>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="space-y-3">
        {files.map(file => (
          <div key={file.path} className="card space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-gray-200">{file.name}</h3>
                <p className="text-xs text-gray-500 break-all">{file.path}</p>
              </div>
              <span className={`text-xs font-mono ${file.exists ? 'text-gray-400' : 'text-warning'}`}>
                {file.exists ? `${Math.round(file.size / 1024)} KB${file.truncated ? ' tail' : ''}` : 'missing'}
              </span>
            </div>
            <pre className="max-h-[360px] overflow-auto rounded-md bg-black/30 border border-surface-lighter/30 p-3 text-xs text-gray-300 whitespace-pre-wrap break-words">
              {file.exists ? file.content || '(empty)' : '(not created yet)'}
            </pre>
          </div>
        ))}
      </div>
    </div>
  )
}
