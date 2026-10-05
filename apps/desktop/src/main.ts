import { app, BrowserWindow, Menu, shell } from 'electron'
const WEB_ORIGIN = process.env.PRODUCT_WEB_URL ?? 'http://localhost:3000'

// A native window background cannot resolve a CSS custom property, so this one literal is
// deliberate and documented. The check:theme-tokens gate scopes to apps/web, where CSS applies.
const WINDOW_BG = '#09090b'

/**
 * The desktop shell deliberately does not reimplement the UI — it loads the web app and
 * adds what a browser cannot: a native menu, external links in the real browser, and
 * single-instance locking.
 */
function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Odometry Scope',
    backgroundColor: WINDOW_BG,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })

  void window.loadURL(WEB_ORIGIN)

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  return window
}

function buildMenu(window: BrowserWindow): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => window.reload() },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [existing] = BrowserWindow.getAllWindows()
    if (existing) {
      if (existing.isMinimized()) existing.restore()
      existing.focus()
    }
  })

  void app.whenReady().then(() => {
    const window = createWindow()
    buildMenu(window)
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) buildMenu(createWindow())
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

export { createWindow, buildMenu, WEB_ORIGIN }
