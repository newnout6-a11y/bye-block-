/**
 * Thin wrapper around Electron's Notification class.
 *
 * Behaviour:
 *  - Respects the user's `desktopNotifications` setting. When off, every call
 *    is a no-op.
 *  - If the platform doesn't support notifications (some headless envs), we
 *    just log and move on instead of crashing.
 *  - Coalesces duplicate notifications fired within 1.5s. sing-box can
 *    rapid-fire crash/restart cycles and we don't want to spam the user with
 *    five identical toasts.
 */
import { Notification } from 'electron'
import { logEvent } from './appLogger'
import { settingsStore } from './settings'

export type NotificationLevel = 'info' | 'warn' | 'error'

interface PendingKey {
  title: string
  body: string
  ts: number
}

let lastNotification: PendingKey | null = null
const COALESCE_MS = 1500

export function notify(level: NotificationLevel, title: string, body: string): void {
  try {
    const settings = settingsStore.get()
    if (!settings.desktopNotifications) return

    // Drop duplicates fired right after each other.
    const now = Date.now()
    if (
      lastNotification &&
      lastNotification.title === title &&
      lastNotification.body === body &&
      now - lastNotification.ts < COALESCE_MS
    ) {
      return
    }
    lastNotification = { title, body, ts: now }

    if (!Notification.isSupported()) {
      logEvent('debug', 'notify', 'platform does not support notifications', { level, title })
      return
    }

    const n = new Notification({
      title,
      body,
      // Electron picks the right urgency icon per platform.
      urgency: level === 'error' ? 'critical' : level === 'warn' ? 'normal' : 'low',
      silent: level === 'info'
    })
    n.show()
  } catch (err) {
    logEvent('warn', 'notify', 'failed to show notification', { err: (err as Error)?.message, level, title })
  }
}
