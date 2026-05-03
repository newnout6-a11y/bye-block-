import { Tray, Menu, nativeImage, BrowserWindow, app, type NativeImage } from 'electron'

function createTrayIcon(color: 'green' | 'red' | 'gray'): NativeImage {
  const size = 16
  const canvas = `data:image/svg+xml,${encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color === 'green' ? '#22c55e' : color === 'red' ? '#ef4444' : '#888888'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
    </svg>
  `)}`
  return nativeImage.createFromDataURL(canvas)
}

export function createTray(mainWindow: BrowserWindow): Tray {
  const tray = new Tray(createTrayIcon('gray'))

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'VPN Tunnel Enforcer',
      enabled: false
    },
    { type: 'separator' },
    {
      label: 'Показать окно',
      click: () => {
        mainWindow.show()
        mainWindow.focus()
      }
    },
    {
      label: 'Выход',
      click: () => {
        mainWindow.removeAllListeners('close')
        mainWindow.close()
        app.quit()
      }
    }
  ])

  tray.setToolTip('VPN Tunnel Enforcer')
  tray.setContextMenu(contextMenu)

  tray.on('double-click', () => {
    mainWindow.show()
    mainWindow.focus()
  })

  return tray
}

export function updateTrayIcon(tray: Tray, status: 'protected' | 'leak' | 'off') {
  const colorMap = { protected: 'green', leak: 'red', off: 'gray' } as const
  tray.setImage(createTrayIcon(colorMap[status]))

  const tipMap = {
    protected: 'VPN Tunnel Enforcer — Защищено',
    leak: 'VPN Tunnel Enforcer — УТЕЧКА IP!',
    off: 'VPN Tunnel Enforcer — Выключено'
  }
  tray.setToolTip(tipMap[status])
}
