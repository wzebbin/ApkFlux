import { defineStore } from 'pinia'
import { computed, onScopeDispose, ref, shallowRef } from 'vue'
import type { DecodeKind, DecodeResult, EditableFile, EntryPreview, FileSource, Reply, TaskEvent, ToolName, ToolStatus, Workspace, WorkspaceSummary } from '../shared/api'

type DecodeIssue = { status: 'failed' | 'cancelled'; message: string }
type FileTab = {
  id: number
  path: string
  source: FileSource
  location?: { line: number }
  preview?: EntryPreview
  edit: EditableFile | null
  draft: string
  loading: boolean
  saving: boolean
  comparing: boolean
  imageHistory: string[]
  imageCursor: number
}

const tabDirty = (tab: FileTab) => tab.edit !== null && tab.edit.saved !== tab.draft

function unwrap<T>(reply: Reply<T>): T {
  if (!reply.ok) throw new Error(reply.error)
  return reply.data
}
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

export const useWorkbench = defineStore('workbench', () => {
  const workspace = shallowRef<Workspace>()
  const recent = shallowRef<WorkspaceSummary[]>([])
  const tools = shallowRef<ToolStatus[]>([])
  const events = shallowRef<TaskEvent[]>([])
  const tabs = ref<FileTab[]>([])
  const activeTabId = ref<number>()
  const activeTab = computed(() => tabs.value.find(tab => tab.id === activeTabId.value))
  const activePath = computed(() => activeTab.value?.path ?? '')
  const activeSource = computed(() => activeTab.value?.source ?? 'archive')
  const dirty = computed(() => Boolean(activeTab.value && tabDirty(activeTab.value)))
  const hasUnsavedTabs = computed(() => tabs.value.some(tabDirty))
  const hasPendingEdits = computed(() => hasUnsavedTabs.value || tabs.value.some(tab => tab.saving))
  const decoded = shallowRef<Record<DecodeKind, DecodeResult | null>>({ java: null, android: null })
  const activeDecode = shallowRef<{ kind: DecodeKind; event?: TaskEvent; cancelling?: boolean }>()
  const decodeIssues = shallowRef<Partial<Record<DecodeKind, DecodeIssue>>>({})
  const icon = ref('')
  const error = ref('')
  const pending = ref(false)
  const loadingTools = ref(false)
  const notice = ref('')
  let generation = 0
  let nextTabId = 0
  const replacingWorkspace = ref(false)
  const running = computed(() => events.value.at(-1)?.status === 'running')

  const unsubscribe = window.apkflux.onTask((event) => {
    events.value = [...events.value.slice(-299), event]
    const active = activeDecode.value
    if (active && event.decode?.workspaceId === workspace.value?.id && event.decode?.kind === active.kind &&
        (!active.event || active.event.id === event.id)) activeDecode.value = { ...active, event }
  })
  onScopeDispose(unsubscribe)
  onScopeDispose(window.apkflux.onCloseRequest(() => {
    void confirmTabs(replacingWorkspace.value ? undefined : tabs.value).then((allow) => window.apkflux.closeDecision(allow))
  }))

  async function refreshRecent() {
    try { recent.value = unwrap(await window.apkflux.recent()) } catch (e) { error.value = errorText(e) }
  }

  async function activate(project: Workspace | null) {
    if (!project) return
    const request = ++generation
    workspace.value = project
    tabs.value = []
    activeTabId.value = undefined
    decoded.value = { java: null, android: null }
    decodeIssues.value = {}
    notice.value = ''
    icon.value = ''
    const [index, avatar] = await Promise.all([
      window.apkflux.decoded(project.id),
      project.iconPath ? window.apkflux.preview(project.id, project.iconPath) : undefined,
    ])
    if (request !== generation) return
    if (index.ok) decoded.value = index.data
    else error.value = index.error
    if (avatar?.ok && avatar.data.format === 'image') icon.value = avatar.data.value
  }

  async function importApk(file?: File) {
    if (pending.value || running.value) return
    pending.value = replacingWorkspace.value = true
    error.value = ''
    try {
      if (!await confirmTabs(tabs.value)) return
      await activate(unwrap(await (file ? window.apkflux.dropApk(file) : window.apkflux.selectApk())))
      await refreshRecent()
    } catch (e) { error.value = errorText(e) } finally { pending.value = replacingWorkspace.value = false }
  }

  async function reopen(id: string) {
    if (pending.value || running.value) return
    pending.value = replacingWorkspace.value = true
    error.value = ''
    try {
      if (await confirmTabs(tabs.value)) await activate(unwrap(await window.apkflux.open(id)))
    }
    catch (e) { error.value = errorText(e) } finally { pending.value = replacingWorkspace.value = false }
  }

  const isOpen = (tab: FileTab) => tabs.value.includes(tab)

  function selectTab(id: number) {
    if (tabs.value.some(tab => tab.id === id)) activeTabId.value = id
  }

  async function closeFile(id = activeTabId.value) {
    const tab = tabs.value.find(item => item.id === id)
    if (!tab || replacingWorkspace.value || !await confirmTabs([tab])) return
    const index = tabs.value.indexOf(tab)
    if (index < 0) return
    tabs.value.splice(index, 1)
    if (activeTabId.value === id) activeTabId.value = (tabs.value[index] ?? tabs.value[index - 1])?.id
  }

  async function showFile(path: string, source: FileSource = 'archive', line?: number, keepSource = false) {
    const project = workspace.value
    if (!project || replacingWorkspace.value || confirming) return false
    const manifest = source === 'archive' && path === 'AndroidManifest.xml'
    if (manifest && decoded.value.android && !keepSource) source = 'android'
    const existing = tabs.value.find(tab => tab.path === path && tab.source === source)
    if (existing) {
      selectTab(existing.id)
      if (line !== undefined) existing.location = { line }
      if (!existing.loading && !existing.preview) await loadFile(existing, project.id)
      return activeTabId.value === existing.id
    }

    const id = ++nextTabId
    tabs.value.push({
      id, path, source, location: line === undefined ? undefined : { line },
      edit: null, draft: '', loading: true, saving: false, comparing: false, imageHistory: [], imageCursor: 0,
    })
    selectTab(id)
    const tab = tabs.value[tabs.value.length - 1]
    await loadFile(tab, project.id)
    return activeTabId.value === id
  }

  async function loadFile(tab: FileTab, projectId: string) {
    tab.loading = true
    error.value = ''
    const { source, path } = tab
    try {
      const file = source === 'android' ? unwrap(await window.apkflux.openEdit(projectId, path)) : null
      const content = file ? { format: file.format, value: file.saved }
        : unwrap(await (source !== 'archive' ? window.apkflux.previewDecoded(projectId, source, path)
          : path === 'AndroidManifest.xml' ? window.apkflux.previewManifest(projectId) : window.apkflux.preview(projectId, path)))
      if (!isOpen(tab)) return
      tab.preview = content
      tab.edit = file
      tab.draft = file?.saved ?? ''
      if (file?.format === 'image') tab.imageHistory = [file.saved]
    } catch (e) {
      if (activeTabId.value === tab.id) error.value = errorText(e)
    } finally { tab.loading = false }
  }

  const saveRequests = new Map<number, Promise<boolean>>()
  function saveFile(id = activeTabId.value): Promise<boolean> {
    const tab = tabs.value.find(item => item.id === id)
    const project = workspace.value
    if (!tab || !project || !tab.edit || !tabDirty(tab)) return Promise.resolve(true)
    const pendingSave = saveRequests.get(tab.id)
    if (pendingSave) return pendingSave

    const file = tab.edit
    const value = tab.draft
    tab.saving = true
    error.value = ''
    const request = window.apkflux.saveEdit(project.id, tab.path, value).then((result) => {
      unwrap(result)
      tab.edit = { ...file, saved: value }
      return true
    }).catch((e) => { error.value = errorText(e); return false })
      .finally(() => { tab.saving = false; saveRequests.delete(tab.id) })
    saveRequests.set(tab.id, request)
    return request
  }

  let confirming = false
  async function confirmTabs(targets?: FileTab[]): Promise<boolean> {
    if (confirming || !targets) return false
    confirming = true
    try {
      for (const tab of [...targets]) {
        const writing = saveRequests.get(tab.id)
        if (writing && !await writing) return false
        if (!tabDirty(tab)) continue
        const decision = unwrap(await window.apkflux.confirmEdit(tab.path))
        if (decision === 'cancel') return false
        if (decision === 'save' && (!await saveFile(tab.id) || tabDirty(tab))) return false
      }
      return true
    } catch (e) { error.value = errorText(e); return false }
    finally { confirming = false }
  }

  async function replaceImage() {
    const project = workspace.value
    const tab = activeTab.value
    if (!project || replacingWorkspace.value || tab?.edit?.format !== 'image') return
    try {
      const value = unwrap(await window.apkflux.pickImage(project.id, tab.path))
      if (value !== null && !replacingWorkspace.value && isOpen(tab) && value !== tab.draft) {
        tab.imageHistory = [...tab.imageHistory.slice(0, tab.imageCursor + 1), value].slice(-8)
        tab.imageCursor = tab.imageHistory.length - 1
        tab.draft = value
      }
    } catch (e) { if (isOpen(tab)) error.value = errorText(e) }
  }
  function moveImageHistory(direction: -1 | 1) {
    const tab = activeTab.value
    if (!tab || replacingWorkspace.value) return
    const index = tab.imageCursor + direction
    if (index >= 0 && index < tab.imageHistory.length) {
      tab.imageCursor = index
      tab.draft = tab.imageHistory[index]
    }
  }

  async function decode(kind: DecodeKind) {
    const project = workspace.value
    if (!project || pending.value || running.value) return
    pending.value = true
    error.value = ''
    notice.value = ''
    activeDecode.value = { kind }
    decodeIssues.value = { ...decodeIssues.value, [kind]: undefined }
    try {
      const result = unwrap(await window.apkflux.decode(project.id, kind))
      if (workspace.value?.id === project.id) decoded.value = { ...decoded.value, [kind]: result }
    } catch (e) {
      if (workspace.value?.id === project.id) decodeIssues.value = { ...decodeIssues.value, [kind]: {
        status: activeDecode.value?.event?.status === 'cancelled' ? 'cancelled' : 'failed', message: errorText(e),
      } }
    } finally {
      activeDecode.value = undefined
      pending.value = false
    }
  }

  async function cancelDecode() {
    const active = activeDecode.value
    if (!active?.event || active.event.status !== 'running' || active.cancelling) return
    activeDecode.value = { ...active, cancelling: true }
    try { unwrap(await window.apkflux.cancel(active.event.id)) }
    catch (e) {
      if (activeDecode.value?.event?.id === active.event.id) {
        activeDecode.value = { ...activeDecode.value, cancelling: false }
        error.value = errorText(e)
      }
    }
  }

  async function exportJava() {
    const project = workspace.value
    if (!project || pending.value || running.value) return
    pending.value = true
    error.value = ''
    notice.value = ''
    try {
      const path = unwrap(await window.apkflux.exportJava(project.id))
      if (path) notice.value = `已导出 Java 文件到 ${path}`
    } catch (e) { error.value = errorText(e) } finally { pending.value = false }
  }

  async function refreshTools() {
    if (loadingTools.value) return
    loadingTools.value = true
    try { tools.value = unwrap(await window.apkflux.tools()) }
    catch (e) { error.value = errorText(e) } finally { loadingTools.value = false }
  }

  async function configureTool(name: ToolName, reset = false) {
    error.value = ''
    try {
      if (reset) unwrap(await window.apkflux.resetTool(name))
      else if (!unwrap(await window.apkflux.chooseTool(name))) return
      await refreshTools()
    } catch (e) { error.value = errorText(e) }
  }

  async function cancel() {
    try { unwrap(await window.apkflux.cancel()) } catch (e) { error.value = errorText(e) }
  }
  return { workspace, recent, tools, events, tabs, activeTab, activeTabId, activePath, activeSource, decoded, icon, error, notice, pending, running, loadingTools,
    dirty, hasUnsavedTabs, hasPendingEdits, replacingWorkspace, selectTab, saveFile, replaceImage, moveImageHistory,
    refreshRecent, importApk, reopen, showFile, closeFile, decode, activeDecode, decodeIssues, cancelDecode, exportJava, refreshTools, configureTool, cancel }
})
