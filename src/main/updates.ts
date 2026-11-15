import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import updater from 'electron-updater'
import type { UpdateState } from '../shared/api'

const { autoUpdater } = updater

export class Updates {
  private state: UpdateState = { status: 'unconfigured', version: null }

  constructor() {
    if (!app.isPackaged || !['darwin', 'win32'].includes(process.platform) ||
        !existsSync(join(process.resourcesPath, 'app-update.yml'))) return
    this.state = { status: 'idle', version: null }
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.on('update-available', (info) => { this.state = { status: 'available', version: info.version } })
    autoUpdater.on('update-not-available', () => { this.state = { status: 'current', version: app.getVersion() } })
    autoUpdater.on('update-downloaded', (info) => { this.state = { status: 'ready', version: info.version } })
    autoUpdater.on('error', () => { this.state = { ...this.state, status: 'failed' } })
  }

  current() { return this.state }

  async check() {
    if (['unconfigured', 'checking', 'downloading', 'ready'].includes(this.state.status)) return this.state
    this.state = { status: 'checking', version: null }
    try { await autoUpdater.checkForUpdates() }
    catch { this.state = { status: 'failed', version: null } }
    if (this.state.status === 'checking') this.state = { status: 'failed', version: null }
    return this.state
  }

  async download() {
    if (this.state.status !== 'available') return this.state
    this.state = { ...this.state, status: 'downloading' }
    try { await autoUpdater.downloadUpdate() }
    catch { this.state = { ...this.state, status: 'failed' } }
    return this.state
  }

  install() {
    if (this.state.status !== 'ready') throw new Error('没有可安装的更新。')
    autoUpdater.quitAndInstall()
  }
}
