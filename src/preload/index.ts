import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { channels, type DesktopApi, type TaskEvent } from '../shared/api'

const api: DesktopApi = {
  selectApk: () => ipcRenderer.invoke(channels.select),
  dropApk: async (file) => {
    const path = webUtils.getPathForFile(file)
    return path ? ipcRenderer.invoke(channels.drop, path) : { ok: false, error: '请拖入本机上的 APK 文件。' }
  },
  recent: () => ipcRenderer.invoke(channels.recent),
  open: (id) => ipcRenderer.invoke(channels.open, id),
  preview: (id, path) => ipcRenderer.invoke(channels.preview, id, path),
  decoded: (id) => ipcRenderer.invoke(channels.decoded, id),
  decode: (id, kind) => ipcRenderer.invoke(channels.decode, id, kind),
  previewDecoded: (id, kind, path) => ipcRenderer.invoke(channels.previewDecoded, id, kind, path),
  previewManifest: (id) => ipcRenderer.invoke(channels.previewManifest, id),
  searchDecoded: (id, kind, query) => ipcRenderer.invoke(channels.searchDecoded, id, kind, query),
  searchWorkspace: (id, query) => ipcRenderer.invoke(channels.searchWorkspace, id, query),
  exportJava: (id) => ipcRenderer.invoke(channels.exportJava, id),
  openEdit: (id, path) => ipcRenderer.invoke(channels.openEdit, id, path),
  saveEdit: (id, path, value) => ipcRenderer.invoke(channels.saveEdit, id, path, value),
  pickImage: (id, path) => ipcRenderer.invoke(channels.pickImage, id, path),
  confirmEdit: (path) => ipcRenderer.invoke(channels.confirmEdit, path),
  closeDecision: (allow) => ipcRenderer.invoke(channels.closeDecision, allow),
  chooseKeystore: () => ipcRenderer.invoke(channels.chooseKeystore),
  chooseApkOutput: () => ipcRenderer.invoke(channels.chooseApkOutput),
  buildApk: (id, settings) => ipcRenderer.invoke(channels.buildApk, id, settings),
  buildHistory: (id) => ipcRenderer.invoke(channels.buildHistory, id),
  devices: () => ipcRenderer.invoke(channels.devices),
  installBuild: (id, buildId, serial) => ipcRenderer.invoke(channels.installBuild, id, buildId, serial),
  analyze: (id, baseline) => ipcRenderer.invoke(channels.analyze, id, baseline),
  exportAnalysis: (format) => ipcRenderer.invoke(channels.exportAnalysis, format),
  analyzeNative: (id, path) => ipcRenderer.invoke(channels.analyzeNative, id, path),
  nativeCode: (id, path, address) => ipcRenderer.invoke(channels.nativeCode, id, path, address),
  updateState: () => ipcRenderer.invoke(channels.updateState),
  openReleases: () => ipcRenderer.invoke(channels.openReleases),
  checkUpdate: () => ipcRenderer.invoke(channels.checkUpdate),
  downloadUpdate: () => ipcRenderer.invoke(channels.downloadUpdate),
  applyUpdate: () => ipcRenderer.invoke(channels.applyUpdate),
  manageDevice: (id, serial, action) => ipcRenderer.invoke(channels.manageDevice, id, serial, action),
  tools: () => ipcRenderer.invoke(channels.tools),
  chooseTool: (name) => ipcRenderer.invoke(channels.chooseTool, name),
  resetTool: (name) => ipcRenderer.invoke(channels.resetTool, name),
  copyHash: (id) => ipcRenderer.invoke(channels.copyHash, id),
  cancel: (taskId) => ipcRenderer.invoke(channels.cancel, taskId),
  onTask: (listener) => {
    const receive = (_event: IpcRendererEvent, value: TaskEvent) => listener(value)
    ipcRenderer.on(channels.task, receive)
    return () => { ipcRenderer.removeListener(channels.task, receive) }
  },
  onOpenRequest: (listener) => {
    const receive = () => listener()
    ipcRenderer.on(channels.openRequest, receive)
    return () => { ipcRenderer.removeListener(channels.openRequest, receive) }
  },
  onCloseRequest: (listener) => {
    const receive = () => listener()
    ipcRenderer.on(channels.closeRequest, receive)
    return () => { ipcRenderer.removeListener(channels.closeRequest, receive) }
  },
}
contextBridge.exposeInMainWorld('apkflux', api)
