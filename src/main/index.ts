import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { channels, type AnalysisReport, type DecodeKind, type Reply, type ToolName, type ToolStatus } from '../shared/api'
import { Analyzer, renderReport } from './analysis'
import { Updates } from './updates'
import { NativeAnalyzer } from './native'
import { Decoder } from './decode'
import { Builder } from './build'
import { errorMessage, ImportTasks } from './tasks'
import { toolNames, Tools } from './tools'
import { Workspaces } from './workspaces'
import { isNativeLibrary } from '../shared/native-library'

let window: BrowserWindow | null = null
let stopping = false
let closeIntent: 'window' | 'app' | 'update' | undefined
let canClose = false
let closeGuardReady = false
const shutdown = new AbortController()
let probe: Promise<ToolStatus[]> | undefined
const targetFile = join(__dirname, '../renderer/index.html')
const dev = !app.isPackaged ? process.env.APKFLUX_DEV_URL : undefined
const targetUrl = dev ? new URL(dev).href : pathToFileURL(targetFile).href
const tasks = new ImportTasks((event) => { if (window && !window.isDestroyed()) window.webContents.send(channels.task, event) })

function requestClose(intent: 'window' | 'app' | 'update') {
  if (!window) return
  if (closeIntent) {
    if (intent !== 'window' && closeIntent !== 'update') closeIntent = intent
    return
  }
  closeIntent = intent
  window.webContents.send(channels.closeRequest)
}

function registerIpc(workspaces: Workspaces, tools: Tools, decoder: Decoder, builder: Builder, analyzer: Analyzer, updates: Updates,
    native: NativeAnalyzer) {
  function handle<T>(channel: string, action: (...params: unknown[]) => Promise<T> | T) {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<Reply<T>> => {
      try {
        if (stopping) throw new Error('ApkFlux 正在退出。')
        const frame = event.senderFrame
        if (event.sender !== window?.webContents || !frame || frame !== event.sender.mainFrame || frame.url !== targetUrl) {
          throw new Error('不受信任的 IPC 来源。')
        }
        return { ok: true, data: await action(...args) }
      } catch (error) { return { ok: false, error: errorMessage(error) } }
    })
  }
  function string(value: unknown, max: number) {
    if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\0')) throw new Error('无效的请求参数。')
    return value
  }
  function toolName(value: unknown) {
    if (typeof value !== 'string' || !toolNames.includes(value as ToolName)) throw new Error('未知工具。')
    return value as ToolName
  }
  function decodeKind(value: unknown): DecodeKind {
    if (value !== 'java' && value !== 'android') throw new Error('未知的反编译视图。')
    return value
  }
  const load = (path: string) => tasks.run(basename(path), (task) => workspaces.import(path, task))
  let dialogOpen = false
  let keystore: string | null = null
  let apkOutput: string | null = null
  let lastReport: AnalysisReport | undefined
  async function pick(options: Electron.OpenDialogOptions) {
    if (!window || dialogOpen) return null
    dialogOpen = true
    try {
      const result = await dialog.showOpenDialog(window, options)
      return result.canceled ? null : result.filePaths[0] ?? null
    } finally { dialogOpen = false }
  }
  handle(channels.select, async () => {
    const path = await pick({ properties: ['openFile'], filters: [{ name: 'Android APK', extensions: ['apk'] }] })
    return path ? load(path) : null
  })
  handle(channels.drop, (path) => load(string(path, 32768)))
  handle(channels.recent, () => workspaces.recent())
  handle(channels.open, (id) => workspaces.open(string(id, 64)))
  handle(channels.preview, (id, path) => workspaces.preview(string(id, 64), string(path, 1024)))
  handle(channels.decoded, (id) => {
    const project = string(id, 64)
    workspaces.snapshot(project)
    return decoder.list(project)
  })
  handle(channels.decode, (id, source) => {
    const project = string(id, 64)
    const apk = workspaces.snapshot(project)
    const kind = decodeKind(source)
    return tasks.run(kind === 'java' ? '反编译 Java' : '解码 Smali 和资源', (task) => decoder.run(project, kind, apk, task),
      kind === 'java' ? '反编译' : '解码', { workspaceId: project, kind })
  })
  handle(channels.previewDecoded, (id, source, path) => {
    const project = string(id, 64)
    workspaces.snapshot(project)
    return decoder.preview(project, decodeKind(source), string(path, 1024))
  })
  handle(channels.previewManifest, (id) => {
    const project = string(id, 64)
    const apk = workspaces.snapshot(project)
    return tasks.run('解码 AndroidManifest.xml', (task) => decoder.previewManifest(project, apk, task), '清单')
  })
  handle(channels.openEdit, (id, path) => {
    const project = string(id, 64)
    workspaces.snapshot(project)
    return decoder.openEdit(project, string(path, 1024))
  })
  handle(channels.saveEdit, (id, path, value) => {
    const project = string(id, 64)
    workspaces.snapshot(project)
    if (typeof value !== 'string' || value.length > 3 * 1024 * 1024) throw new Error('工作副本内容超过大小限制。')
    return decoder.saveEdit(project, string(path, 1024), value)
  })
  handle(channels.pickImage, async (id, path) => {
    const project = string(id, 64)
    workspaces.snapshot(project)
    const entry = string(path, 1024)
    const extension = entry.split('.').at(-1)?.toLowerCase() ?? ''
    if (!['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(extension)) throw new Error('不支持替换此图片格式。')
    const selected = await pick({ title: '选择替换图片', properties: ['openFile'], filters: [{ name: '图片', extensions: [extension] }] })
    return selected ? decoder.pickReplacement(project, entry, selected) : null
  })
  handle(channels.confirmEdit, async (path) => {
    const entry = string(path, 1024)
    const name = entry.split('/').at(-1)
    if (!window) return 'cancel'
    const result = await dialog.showMessageBox(window, {
      type: 'warning', title: '未保存的修改', message: `保存对 ${name} 的修改？`,
      detail: `${entry}\n保存会更新此工作区中的文件副本。`,
      buttons: ['保存', '放弃修改', '取消'], defaultId: 0, cancelId: 2, noLink: true,
    })
    return (['save', 'discard', 'cancel'] as const)[result.response] ?? 'cancel'
  })
  handle(channels.closeDecision, (allow) => {
    if (!closeIntent || typeof allow !== 'boolean') return
    const intent = closeIntent
    closeIntent = undefined
    if (!allow) return
    canClose = true
    setImmediate(() => {
      if (intent === 'update') updates.install()
      else if (intent === 'app') app.quit()
      else window?.close()
    })
  })
  handle(channels.chooseKeystore, async () => {
    keystore = await pick({ title: '选择签名密钥库', properties: ['openFile'], filters: [{ name: 'Keystore', extensions: ['jks', 'keystore', 'p12', 'pfx'] }] })
    return keystore
  })
  handle(channels.chooseApkOutput, async () => {
    if (!window) return null
    const result = await dialog.showSaveDialog(window, {
      title: '选择新 APK 的输出位置', defaultPath: 'ApkFlux-signed.apk',
      filters: [{ name: 'APK', extensions: ['apk'] }],
    })
    apkOutput = result.canceled ? null : result.filePath ?? null
    return apkOutput
  })
  handle(channels.buildHistory, (id) => {
    const project = string(id, 64)
    workspaces.snapshot(project)
    return builder.history(project)
  })
  handle(channels.buildApk, (id, raw) => {
    const project = string(id, 64)
    const apk = workspaces.snapshot(project)
    if (!keystore || !apkOutput) throw new Error('请先选择密钥库和新的 APK 输出位置。')
    if (!raw || typeof raw !== 'object') throw new Error('签名参数无效。')
    const input = raw as Record<string, unknown>
    const settings = {
      alias: string(input.alias, 200), storePassword: string(input.storePassword, 1024),
      keyPassword: input.keyPassword === '' ? '' : string(input.keyPassword, 1024),
    }
    const key = keystore
    const dest = apkOutput
    return tasks.run('构建并签名 APK', (task) => builder.build(project, apk, key, dest, settings, task), '构建')
  })
  handle(channels.devices, () => builder.devices())
  handle(channels.installBuild, (id, record, serial) => {
    const project = string(id, 64)
    workspaces.snapshot(project)
    const buildId = string(record, 36)
    const device = string(serial, 200)
    return tasks.run('安装已签名的 APK', (task) => builder.install(project, buildId, device, task), 'ADB')
  })
  handle(channels.analyze, async (id, baseline) => {
    const current = await workspaces.open(string(id, 64))
    const old = baseline === undefined || baseline === '' ? null : await workspaces.open(string(baseline, 64))
    if (old?.id === current.id) throw new Error('请选择另一个 APK 作为对比基准。')
    const report = await tasks.run('本地分析 APK', (task) => analyzer.run(current, workspaces.snapshot(current.id),
      old ? { project: old, apk: workspaces.snapshot(old.id) } : null, task), '分析')
    lastReport = report
    return report
  })
  async function nativeEntry(id: unknown, path: unknown) {
    const project = await workspaces.open(string(id, 64))
    const requested = string(path, 1024)
    const entry = isNativeLibrary(requested) && project.entries.find((item) => item.path === requested)
    if (!entry) throw new Error('该 SO 不在已验证的 APK 索引中。')
    return { id: project.id, entry }
  }
  handle(channels.analyzeNative, async (rawId, path) => {
    const { id, entry } = await nativeEntry(rawId, path)
    return tasks.run('分析 SO 函数', (task) => native.analyze(id, workspaces.snapshot(id), entry, task), 'Ghidra')
  })
  handle(channels.nativeCode, async (rawId, path, address) => {
    const { id, entry } = await nativeEntry(rawId, path)
    const functionAddress = string(address, 16)
    return tasks.run('读取函数反汇编和伪代码', (task) => native.code(id, entry, functionAddress, task), 'Ghidra')
  })
  handle(channels.exportAnalysis, async (format) => {
    if (!lastReport || !window) throw new Error('请先生成分析报告。')
    if (format !== 'html' && format !== 'json' && format !== 'csv') throw new Error('不支持此报告格式。')
    const report = lastReport
    const result = await dialog.showSaveDialog(window, {
      title: '导出分析报告', defaultPath: `ApkFlux-report.${format}`, filters: [{ name: '分析报告', extensions: [format] }],
    })
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, renderReport(report, format), { flag: 'wx', mode: 0o600 })
    return result.filePath
  })
  handle(channels.updateState, () => updates.current())
  handle(channels.openReleases, () => shell.openExternal('https://github.com/wzebbin/ApkFlux/releases/latest'))
  handle(channels.checkUpdate, () => updates.check())
  handle(channels.downloadUpdate, () => updates.download())
  handle(channels.applyUpdate, () => {
    if (updates.current().status !== 'ready') throw new Error('没有可安装的更新。')
    requestClose('update')
  })
  handle(channels.manageDevice, async (id, serial, action) => {
    const project = await workspaces.open(string(id, 64))
    if (!project.packageName || !window) throw new Error('未能读取当前 APK 的包名。')
    const device = string(serial, 200)
    if (action !== 'launch' && action !== 'uninstall') throw new Error('未知的设备操作。')
    if (action === 'uninstall') {
      const choice = await dialog.showMessageBox(window, {
        type: 'warning', title: '卸载 Android 应用', message: `从设备 ${device} 卸载 ${project.packageName}？`,
        detail: '卸载会移除该设备上此应用的数据。',
        buttons: ['卸载', '取消'], defaultId: 1, cancelId: 1, noLink: true,
      })
      if (choice.response !== 0) return
    }
    await tasks.run(action === 'launch' ? '启动应用' : '卸载应用', (task) => builder.manage(project.packageName!, device, action, task), 'ADB')
  })
  handle(channels.searchDecoded, (id, source, query) => {
    const project = string(id, 64)
    workspaces.snapshot(project)
    return decoder.search(project, decodeKind(source), string(query, 200))
  })
  handle(channels.searchWorkspace, async (id, query) => {
    const project = string(id, 64)
    const term = string(query, 200)
    const workspace = await workspaces.open(project)
    return decoder.searchWorkspace(project, workspace.entries, term)
  })
  handle(channels.exportJava, async (id) => {
    const project = string(id, 64)
    workspaces.snapshot(project)
    const directory = await pick({ title: '选择 Java 导出目录', properties: ['openDirectory', 'createDirectory'] })
    return directory ? tasks.run('导出 Java 文件', (task) => decoder.exportJava(project, directory, task), '导出') : null
  })
  handle(channels.copyHash, async (id) => {
    const workspace = await workspaces.open(string(id, 64))
    clipboard.writeText(workspace.id)
  })
  handle(channels.cancel, (taskId) => tasks.cancel(taskId === undefined ? undefined : string(taskId, 36)))
  async function listTools() {
    const statuses = []
    for (const name of toolNames) {
      if (shutdown.signal.aborted) break
      statuses.push(await tools.status(name, shutdown.signal).catch(() => ({ name, path: null, source: null, version: null })))
    }
    return statuses
  }
  handle(channels.tools, () => probe ??= listTools().finally(() => { probe = undefined }))
  handle(channels.chooseTool, async (name) => {
    const tool = toolName(name)
    const path = await pick(tool === 'ghidra' ? { title: '选择 Ghidra 安装目录', properties: ['openDirectory'] }
      : { title: `选择 ${tool}`, properties: ['openFile'] })
    if (path) await tools.configure(tool, path)
    return Boolean(path)
  })
  handle(channels.resetTool, (name) => tools.configure(toolName(name)))
}

async function createWindow() {
  const view = new BrowserWindow({
    width: 1440, height: 920, minWidth: 960, minHeight: 680,
    title: 'ApkFlux', show: false, backgroundColor: '#181a1f',
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 17, y: 21 },
    } as const : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  })
  window = view
  closeGuardReady = false
  canClose = false
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  view.webContents.on('will-navigate', (event) => event.preventDefault())
  view.webContents.on('will-redirect', (event) => event.preventDefault())
  view.webContents.session.setPermissionRequestHandler((_content, _permission, callback) => callback(false))
  view.webContents.session.setPermissionCheckHandler(() => false)
  view.on('close', (event) => {
    if (canClose || !closeGuardReady || view.webContents.isCrashed()) return
    event.preventDefault()
    requestClose('window')
  })
  view.on('closed', () => { window = null; closeIntent = undefined; closeGuardReady = false })
  view.webContents.on('did-finish-load', () => { closeGuardReady = true })
  view.once('ready-to-show', () => view.show())
  await (dev ? view.loadURL(targetUrl) : view.loadFile(targetFile))
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore()
    window?.focus()
  })
  void app.whenReady().then(async () => {
    app.setName('ApkFlux')
    const base = app.getPath('userData')
    await mkdir(base, { recursive: true })
    const tools = new Tools(join(base, 'tools.json'), join(process.resourcesPath, 'tools', `${process.platform}-${process.arch}`))
    await tools.init()
    const workspaces = new Workspaces(join(base, 'workspaces'), tools)
    await workspaces.init()
    const decoder = new Decoder(join(base, 'decompiled-v1'), tools)
    await decoder.init()
    const builder = new Builder(join(base, 'builds'), decoder, tools)
    await builder.init()
    const native = new NativeAnalyzer(join(base, 'native-v1'), tools)
    await native.init()
    registerIpc(workspaces, tools, decoder, builder, new Analyzer(tools, decoder), new Updates(), native)
    const menu: MenuItemConstructorOptions[] = [
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
      { label: '文件', submenu: [{ label: '导入 APK…', accelerator: 'CmdOrCtrl+O', click: () => window?.webContents.send(channels.openRequest) }, { role: 'close' }] },
      { label: '编辑', role: 'editMenu' },
      { label: '视图', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
      { label: '窗口', role: 'windowMenu' },
    ]
    Menu.setApplicationMenu(Menu.buildFromTemplate(menu))
    app.on('activate', () => { if (!window) void createWindow().catch(console.error) })
    await createWindow()
  }).catch((error: unknown) => { dialog.showErrorBox('ApkFlux 启动失败', errorMessage(error)); app.quit() })
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
  app.on('before-quit', (event) => {
    if (stopping) return
    event.preventDefault()
    if (window && !canClose && closeGuardReady && !window.webContents.isCrashed()) {
      requestClose('app')
      return
    }
    canClose = true
    stopping = true
    tasks.cancel()
    shutdown.abort()
    const deadline = setTimeout(() => app.quit(), 2500)
    void Promise.allSettled([tasks.settled(), probe]).then(() => {
      clearTimeout(deadline)
      app.quit()
    })
  })
}
