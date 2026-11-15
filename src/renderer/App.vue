<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElButton, ElInput, ElTreeV2 } from 'element-plus'
import { version } from '../../package.json'
import appIcon from '../../build/icon.png'
import type { FileSource, SourceSearch } from '../shared/api'
import { isNativeLibrary } from '../shared/native-library'
import Glyph from './UiGlyph.vue'
import BuildPanel from './BuildPanel.vue'
import AnalysisPanel from './AnalysisPanel.vue'
import NativePanel from './NativePanel.vue'
import PreferencesPanel from './PreferencesPanel.vue'
import WorkspaceSearch from './WorkspaceSearch.vue'
import { usePreferences } from './preferences'
import { useWorkbench } from './state'

const CodePreview = defineAsyncComponent(() => import('./CodePreview.vue'))
const codeEditors = ref<{ tabId?: number; history(command: 'undo' | 'redo'): void; replace(): void }[]>([])
const tabStrip = ref<HTMLElement>()
const store = useWorkbench()
const codeEditor = computed(() => codeEditors.value.find(editor => editor.tabId === store.activeTabId))
const { text: t } = usePreferences()
const recentMenu = ref<HTMLDetailsElement>()
const toolsOpen = ref(false)
const logTab = ref<'tasks' | 'logs'>('tasks')
const logOpen = ref(false)
const inspectorOpen = ref(false)
const dragDepth = ref(0)
type WorkspaceView = 'editor' | 'build' | 'analysis' | 'preferences' | 'native'
const workspaceView = ref<WorkspaceView>('editor')
const nativePath = ref('')
function openNative(path = '') {
  nativePath.value = path
  workspaceView.value = 'native'
}
const analysisOpened = ref(false)
watch(workspaceView, view => { if (view === 'analysis') analysisOpened.value = true }, { flush: 'sync' })
const filter = ref('')
const fileSource = ref<FileSource>('archive')
const sourceLabelByKind = computed(() => ({
  archive: t('原始 APK', 'Original APK'),
  java: t('反编译 Java', 'Decompiled Java'),
  android: t('Smali / 资源', 'Smali / Resources'),
}))
const decodedSources = [
  { kind: 'java', glyph: 'code' },
  { kind: 'android', glyph: 'folder' },
] as const
const decodePrompt = computed(() => fileSource.value === 'java' ? {
  heading: t('Java 文件尚未生成', 'No Java files yet'),
  description: t('用 JADX 生成可浏览的 Java 源码。', 'Generate browsable Java source with JADX.'),
  action: t('开始反编译', 'Start decompiling'),
  busy: t('正在反编译…', 'Decompiling…'),
  failed: t('Java 反编译失败', 'Java decompilation failed'),
  cancel: t('取消反编译', 'Cancel decompilation'),
  glyph: 'code',
} : {
  heading: t('Smali / 资源尚未解码', 'Smali and resources await decoding'),
  description: t('用 Apktool 生成可编辑的 Smali、清单和资源。', 'Decode editable Smali, the manifest and resources with Apktool.'),
  action: t('开始解码', 'Start decoding'),
  busy: t('正在解码…', 'Decoding…'),
  failed: t('Smali / 资源解码失败', 'Smali and resource decoding failed'),
  cancel: t('取消解码', 'Cancel decoding'),
  glyph: 'folder',
})
const sourceDecode = computed(() => store.activeDecode?.kind === fileSource.value ? store.activeDecode : undefined)
const sourceDecodeIssue = computed(() => fileSource.value === 'archive' ? undefined : store.decodeIssues[fileSource.value])
const decodeStep = computed(() => {
  const event = sourceDecode.value?.event
  if (sourceDecode.value?.cancelling) return t('正在停止工具并清理临时文件…', 'Stopping the tool and cleaning up…')
  switch (event?.stage) {
    case 'jadx': return t('运行 JADX，生成 Java 源码', 'Running JADX to generate Java source')
    case 'apktool': return t('运行 Apktool，解码 Smali 和资源', 'Running Apktool to decode Smali and resources')
    case '索引': return t('整理生成的文件', 'Indexing generated files')
    case '缓存': return t('读取已有结果', 'Loading cached results')
    case '完成': case '结束': return t('等待工作区更新', 'Updating the workspace')
    default: return t('准备工具和输入文件', 'Preparing tools and input files')
  }
})
const decodeDetail = computed(() => {
  const event = sourceDecode.value?.event
  if (!sourceDecode.value?.cancelling && event?.status === 'running' && (event.stage === 'jadx' || event.stage === 'apktool') &&
      event.message !== '正在运行反编译工具。') return event.message
  return undefined
})
const settingsLabel = computed(() => workspaceView.value === 'preferences' ? t('返回工作台', 'Back to workbench') : t('设置', 'Preferences'))
const analysisActive = computed(() => workspaceView.value === 'analysis' || workspaceView.value === 'native')
const fileName = (path: string) => path.split('/').at(-1) ?? path
watch(() => store.activeTabId, () => {
  tabStrip.value?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}, { flush: 'post' })
let previousView: WorkspaceView = 'editor'
function openSettings() {
  if (workspaceView.value === 'preferences') workspaceView.value = previousView
  else {
    previousView = workspaceView.value
    workspaceView.value = 'preferences'
  }
}
function reopen(id: string) {
  if (recentMenu.value) recentMenu.value.open = false
  void store.reopen(id)
}
function toggleTools() {
  toolsOpen.value = !toolsOpen.value
  if (toolsOpen.value && !store.tools.length) void store.refreshTools()
}
const globalSearchOpen = ref(false)
const contentMode = ref(false)
const searching = ref(false)
const searchResult = ref<SourceSearch>()
let searchGeneration = 0
const treeBox = ref<HTMLElement>()
const fileTree = ref<InstanceType<typeof ElTreeV2>>()
const treeHeight = ref(240)
const emptyExpansions = () => ({ archive: [], java: [], android: [] }) as Record<FileSource, string[]>
const expandedBySource = ref(emptyExpansions())
const expandedFolders = computed(() => expandedBySource.value[fileSource.value])
const logBox = ref<HTMLElement>()
const isMac = /Mac/i.test(navigator.userAgent)
const shortcut = isMac ? '⌘ O' : 'Ctrl O'
const formatBytes = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`
const shortDate = (value: string) => new Date(value).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
const time = (value: number) => new Date(value).toLocaleTimeString('zh-CN', { hour12: false })
const displayName = computed(() => store.workspace?.label || store.workspace?.name)
const lastTask = computed(() => store.events.at(-1))
const taskLabel = computed(() => ({ running: t('正在运行', 'Running'), done: t('已完成', 'Done'), failed: t('失败', 'Failed'), cancelled: t('已取消', 'Cancelled') }))
const signatureLabel = computed(() => ({ verified: t('已验证', 'Verified'), unverified: t('未通过验证', 'Not verified'), unavailable: t('无法验证', 'Unavailable') }))
const sourceLabel = { custom: '手动配置', bundled: '内置', sdk: '系统 SDK', path: '系统 PATH' }
const zipEntries = computed(() => store.workspace?.entries ?? [])
const sourceEntries = computed(() => fileSource.value === 'archive' ? zipEntries.value : store.decoded[fileSource.value]?.files ?? [])
const sourceResult = computed(() => fileSource.value === 'archive' ? null : store.decoded[fileSource.value])
const overview = computed<[string, string | null | undefined][]>(() => {
  const workspace = store.workspace
  return [
    [t('包名', 'Package'), workspace?.packageName],
    [t('版本名称', 'Version name'), workspace?.metadata?.versionName],
    [t('版本代码', 'Version code'), workspace?.metadata?.versionCode],
    [t('最低 SDK', 'Min SDK'), workspace?.metadata?.minSdk],
    [t('目标 SDK', 'Target SDK'), workspace?.metadata?.targetSdk],
    [t('APK 大小', 'APK size'), workspace && formatBytes(workspace.bytes)],
    [t('DEX 数量', 'DEX count'), workspace && String(workspace.dexCount)],
    [t('CPU 架构', 'CPU architecture'), workspace?.architectures.join(', ')],
  ]
})

type TreeNode = { id: string; label: string; children?: TreeNode[]; leaf: boolean }
const treeData = computed(() => {
  const roots: TreeNode[] = []
  const dirs = new Map<string, TreeNode[]>()
  for (const entry of sourceEntries.value) {
    const pieces = entry.path.split('/')
    let current = roots
    let path = ''
    for (const name of pieces.slice(0, -1)) {
      path += name + '/'
      let children = dirs.get(path)
      if (!children) {
        children = []
        dirs.set(path, children)
        current.push({ id: path, label: name, children, leaf: false })
      }
      current = children
    }
    current.push({ id: entry.path, label: pieces.at(-1) ?? entry.path, leaf: true })
  }
  return { roots, folders: [...dirs.keys()] }
})
const matches = computed(() => {
  const query = filter.value.toLowerCase().trim()
  if (!query) return null
  return sourceEntries.value.filter((entry) => entry.path.toLowerCase().includes(query))
    .map((entry) => ({ id: entry.path, label: entry.path, leaf: true }))
})
function openWorkspaceFile(path: string, source: FileSource, line?: number, keepSource = false) {
  workspaceView.value = 'editor'
  return store.showFile(path, source, line, keepSource)
}
async function revealSearchResult(path: string, line?: number, requestedSource?: FileSource) {
  const request = searchGeneration
  const opened = await openWorkspaceFile(path, requestedSource ?? fileSource.value, line, requestedSource !== undefined)
  if (!opened || request !== searchGeneration || workspaceView.value !== 'editor' || store.activePath !== path) return

  const source = store.activeSource
  const parents = new Set(expandedBySource.value[source])
  for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1)) parents.add(path.slice(0, i + 1))
  expandedBySource.value[source] = [...parents]
  selectSource(source)
  await nextTick()
  if (source === fileSource.value && !contentMode.value && !matches.value) fileTree.value?.scrollToNode(path)
}
function selectTree(node: Record<string, unknown>) {
  if (!node.leaf || typeof node.id !== 'string') return
  if (matches.value) void revealSearchResult(node.id)
  else void openWorkspaceFile(node.id, fileSource.value)
}
function setFolderExpanded(node: Record<string, unknown>, expanded: boolean) {
  const path = node.id
  if (typeof path !== 'string') return
  const current = expandedFolders.value
  expandedBySource.value[fileSource.value] = expanded ? [...new Set([...current, path])] : current.filter(key => !key.startsWith(path))
}
async function setAllFolders(expanded: boolean) {
  const source = fileSource.value
  const folders = treeData.value.folders
  expandedBySource.value[source] = expanded ? folders : []
  await nextTick()
  if (source !== fileSource.value || contentMode.value || matches.value) return
  if (expanded && store.activeSource === source && store.activePath) fileTree.value?.scrollToNode(store.activePath)
  if (!expanded) fileTree.value?.scrollTo(0)
}
function selectSource(source: FileSource) {
  fileSource.value = source
  globalSearchOpen.value = false
  contentMode.value = false
  filter.value = ''
  clearSearch()
}
function clearSearch() {
  searchGeneration++
  searching.value = false
  searchResult.value = undefined
}
watch(filter, clearSearch, { flush: 'sync' })
function openManifest() {
  if (store.decoded.android) selectSource('android')
  openWorkspaceFile('AndroidManifest.xml', store.decoded.android ? 'android' : 'archive')
}
async function searchContents() {
  const project = store.workspace
  const source = fileSource.value
  const query = filter.value.trim()
  if (!project || source === 'archive' || !query) return
  const request = ++searchGeneration
  searching.value = true
  store.error = ''
  try {
    const reply = await window.apkflux.searchDecoded(project.id, source, query)
    if (request !== searchGeneration) return
    if (reply.ok) searchResult.value = reply.data
    else store.error = reply.error
  } finally { if (request === searchGeneration) searching.value = false }
}
const observer = new ResizeObserver(([entry]) => {
  if (entry && entry.contentRect.height > 0) treeHeight.value = Math.floor(entry.contentRect.height)
})
watch(treeBox, (current, previous) => {
  if (previous) observer.unobserve(previous)
  if (current) observer.observe(current)
})
watch(() => store.workspace, () => {
  if (recentMenu.value) recentMenu.value.open = false
  workspaceView.value = 'editor'
  analysisOpened.value = false
  expandedBySource.value = emptyExpansions()
  selectSource('archive')
})
watch([lastTask, logTab, logOpen], () => {
  if (logOpen.value && logTab.value === 'logs' && logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight
}, { flush: 'post' })

function enter(event: DragEvent) {
  if (event.dataTransfer?.types.includes('Files')) dragDepth.value++
}
function leave() { dragDepth.value = Math.max(0, dragDepth.value - 1) }
function drop(event: DragEvent) {
  dragDepth.value = 0
  const files = event.dataTransfer?.files
  if (!files?.length) return
  if (files.length !== 1) { store.error = '请一次导入一个 APK 文件。'; return }
  void store.importApk(files[0])
}
async function copyHash() {
  if (!store.workspace) return
  try {
    const result = await window.apkflux.copyHash(store.workspace.id)
    if (!result.ok) store.error = result.error
  } catch { store.error = '无法复制，请手动选择 SHA-256。' }
}
let unlisten: (() => void) | undefined
onMounted(() => {
  void store.refreshRecent()
  unlisten = window.apkflux.onOpenRequest(() => { void store.importApk() })
})
onBeforeUnmount(() => { observer.disconnect(); unlisten?.() })
</script>

<template>
  <div class="desktop" @dragenter.prevent="enter" @dragleave.prevent="leave" @dragover.prevent @drop.prevent="drop">
    <header class="topbar" :class="{ 'mac-titlebar': isMac }">
      <div class="wordmark"><img class="brand-icon" :src="appIcon" width="29" height="29" alt=""><span>ApkFlux</span></div>
      <span class="header-divider" aria-hidden="true"></span>
      <span class="header-caption" :title="displayName">{{ displayName || t('APK 工作台', 'APK Workbench') }}</span>
      <div class="header-right">
        <ElButton type="primary" class="open-button" :disabled="store.pending || store.running" @click="store.importApk()"><Glyph name="open" :size="16" /> {{ t('导入 APK', 'Open APK') }}</ElButton>
        <details v-if="store.workspace && store.recent.length" ref="recentMenu" class="recent-menu">
          <summary class="icon-button header-settings" :title="t('最近打开', 'Recently opened')" :aria-label="t('最近打开', 'Recently opened')">
            <Glyph name="clock" :size="17" />
          </summary>
          <div class="history-list">
            <button v-for="item in store.recent" :key="item.id" :disabled="store.pending || store.running" :title="item.name" @click="reopen(item.id)">
              <Glyph name="brand" :size="16" /><span>{{ item.label || item.name }}</span><small>{{ shortDate(item.importedAt) }}</small>
            </button>
          </div>
        </details>
        <button class="icon-button header-settings" :class="{ selected: workspaceView === 'preferences' }"
          :title="settingsLabel" :aria-label="settingsLabel" :aria-pressed="workspaceView === 'preferences'"
          @click="openSettings()"><Glyph name="settings" :size="18" /></button>
      </div>
    </header>

    <div class="workspace-bar">
      <nav class="workspace-nav" :aria-label="t('工作区导航', 'Workspace navigation')">
        <button :aria-pressed="workspaceView === 'editor'" :class="{ 'has-unsaved': workspaceView !== 'editor' && store.hasUnsavedTabs }"
          :aria-description="workspaceView !== 'editor' && store.hasUnsavedTabs ? t('有未保存的修改', 'Unsaved changes') : undefined" @click="workspaceView = 'editor'">
          <Glyph name="files" :size="16" />{{ t('文件', 'Files') }}
        </button>
        <button :aria-pressed="analysisActive" :disabled="!store.workspace" @click="workspaceView = 'analysis'"><Glyph name="analysis" :size="16" />{{ t('APK 分析', 'APK Analysis') }}</button>
        <button :aria-pressed="workspaceView === 'build'" :disabled="!store.workspace" @click="workspaceView = 'build'"><Glyph name="build" :size="16" />{{ t('构建与签名', 'Build and sign') }}</button>
      </nav>
      <button v-if="store.workspace" class="inspector-toggle" :aria-expanded="inspectorOpen" aria-controls="apk-inspector"
        @click="inspectorOpen = !inspectorOpen"><Glyph name="info" :size="16" />{{ t('APK 信息', 'APK details') }}</button>
    </div>

    <main class="workbench" :class="{ 'with-files': workspaceView === 'editor' }">
      <aside v-show="workspaceView === 'editor'" class="sidebar">
        <div class="pane-title">{{ t('资源管理器', 'Explorer') }}
          <button v-if="store.workspace" class="search-mode" :aria-pressed="globalSearchOpen"
            @click="globalSearchOpen = !globalSearchOpen; clearSearch()">
            <Glyph name="search" :size="13" /> {{ t('全局搜索', 'Workspace search') }}
          </button>
        </div>
        <template v-if="store.workspace">
          <nav class="source-switch" :aria-label="t('文件来源', 'File sources')">
            <button :aria-pressed="fileSource === 'archive'" :aria-label="t('原始 APK 视图', 'Original APK view')" @click="selectSource('archive')">
              <Glyph name="brand" :size="15" /> <span>{{ sourceLabelByKind.archive }}</span>
            </button>
            <div class="source-group" role="group" aria-labelledby="decoded-sources-title">
              <p id="decoded-sources-title">{{ t('反编译与解码', 'Decompile and decode') }}</p>
              <button v-for="{ kind, glyph } in decodedSources" :key="kind" :aria-pressed="fileSource === kind"
                :aria-label="t(sourceLabelByKind[kind] + ' 视图', sourceLabelByKind[kind] + ' view')" @click="selectSource(kind)">
                <Glyph :name="glyph" :size="15" /> <span>{{ sourceLabelByKind[kind] }}</span>
              </button>
            </div>
          </nav>
          <div class="source-meta">
            <span v-if="fileSource === 'archive' || sourceResult">{{ t(`${sourceEntries.length.toLocaleString()} 个文件`, `${sourceEntries.length.toLocaleString()} files`) }}</span>
            <button v-if="fileSource === 'java' && sourceResult" type="button" :disabled="store.pending || store.running" @click="store.exportJava()">{{ t('导出 Java', 'Export Java') }}</button>
            <button type="button" :disabled="store.pending || store.running" @click="openManifest()">{{ t('查看清单', 'Open manifest') }}</button>
          </div>
          <WorkspaceSearch v-if="globalSearchOpen" :workspace-id="store.workspace.id" :labels="sourceLabelByKind"
            @open="revealSearchResult($event.path, $event.line, $event.source)" />
          <section v-else-if="fileSource !== 'archive' && !sourceResult" class="source-empty" aria-labelledby="source-empty-title">
            <div class="source-empty-icon"><Glyph :name="decodePrompt.glyph" :size="17" /></div>
            <template v-if="sourceDecode">
              <h2 id="source-empty-title">{{ decodePrompt.busy }}</h2>
              <div class="decode-step" role="status">
                <span>{{ t('当前步骤', 'Current step') }}</span>
                <strong>{{ decodeStep }}</strong>
              </div>
              <p v-if="decodeDetail" class="decode-detail" :title="decodeDetail">{{ decodeDetail }}</p>
              <ElButton size="small" :disabled="sourceDecode.event?.status !== 'running' || sourceDecode.cancelling" @click="store.cancelDecode()">
                {{ sourceDecode.cancelling ? t('正在取消…', 'Cancelling…') : decodePrompt.cancel }}
              </ElButton>
            </template>
            <template v-else>
              <h2 id="source-empty-title">
                {{ sourceDecodeIssue?.status === 'failed' ? decodePrompt.failed : sourceDecodeIssue ? t('任务已取消', 'Task cancelled') : decodePrompt.heading }}
              </h2>
              <p v-if="sourceDecodeIssue" class="decode-issue" :class="sourceDecodeIssue.status" :role="sourceDecodeIssue.status === 'failed' ? 'alert' : 'status'">{{ sourceDecodeIssue.message }}</p>
              <p v-else>{{ decodePrompt.description }}</p>
              <ElButton size="small" type="primary" :disabled="store.pending || store.running" @click="store.decode(fileSource)">
                {{ sourceDecodeIssue?.status === 'failed' ? t('重试', 'Retry') : decodePrompt.action }}
              </ElButton>
            </template>
          </section>
          <template v-else>
            <p v-if="sourceResult?.warning" class="source-warning">{{ sourceResult.warning }}</p>
            <div class="tree-search">
              <ElInput v-model="filter" clearable :maxlength="contentMode ? 200 : undefined"
                :placeholder="contentMode ? t('搜索文件内容，按 Enter', 'Search contents, press Enter') : t('筛选文件路径', 'Filter file paths')"
                :aria-label="contentMode ? t('搜索文件内容', 'Search file contents') : t('筛选文件路径', 'Filter file paths')" @keydown.enter="contentMode && searchContents()">
                <template #prefix><Glyph name="search" :size="15" /></template>
              </ElInput>
              <div v-if="fileSource !== 'archive' || treeData.folders.length" class="tree-search-actions">
                <button v-if="fileSource !== 'archive'" class="search-mode" type="button"
                  @click="contentMode = !contentMode; filter = ''; clearSearch()">{{ contentMode ? t('切换到路径筛选', 'Filter by path') : t('搜索代码内容', 'Search file contents') }}</button>
                <div v-if="!contentMode && !matches && treeData.folders.length" class="tree-folder-actions">
                  <button class="icon-button" :title="t('展开全部', 'Expand all')" :aria-label="t('展开全部', 'Expand all')"
                    :disabled="expandedFolders.length === treeData.folders.length" @click="setAllFolders(true)"><Glyph name="expand-tree" :size="15" /></button>
                  <button class="icon-button" :title="t('折叠全部', 'Collapse all')" :aria-label="t('折叠全部', 'Collapse all')"
                    :disabled="!expandedFolders.length" @click="setAllFolders(false)"><Glyph name="collapse-tree" :size="15" /></button>
                </div>
              </div>
            </div>
            <div v-if="contentMode" class="source-results">
              <p v-if="searching" class="side-empty">正在搜索内容…</p>
              <template v-else-if="searchResult">
                <p v-if="searchResult.limited" class="source-warning">仅显示搜索限额内的结果。</p>
                <p v-if="!searchResult.matches.length" class="side-empty">没有匹配的内容。</p>
                <button v-for="match in searchResult.matches" :key="match.path + ':' + match.line" type="button"
                    :title="match.path" @click="revealSearchResult(match.path, match.line)">
                  <strong>{{ match.path.split('/').at(-1) }}:{{ match.line }}</strong>
                  <small>{{ match.text }}</small>
                </button>
              </template>
            </div>
            <div v-else ref="treeBox" class="tree-box">
              <ElTreeV2 v-if="(!matches || matches.length) && sourceEntries.length" ref="fileTree" :key="fileSource + (matches ? ':matches' : ':tree')" :data="matches ?? treeData.roots"
                :height="treeHeight" :item-size="28" :indent="13" :default-expanded-keys="expandedFolders"
                :props="{ value: 'id', label: 'label', children: 'children' }" :current-node-key="store.activeSource === fileSource ? store.activePath : ''"
                @node-click="selectTree" @node-expand="setFolderExpanded($event, true)" @node-collapse="setFolderExpanded($event, false)">
                <template #default="{ data, node }">
                  <span class="tree-label" :class="{ 'tree-directory': !data.leaf, 'tree-active': data.leaf && store.activeSource === fileSource && store.activePath === data.id }"
                    :title="data.id" :aria-current="data.leaf && store.activeSource === fileSource && store.activePath === data.id ? 'true' : undefined">
                    <Glyph :name="data.leaf ? 'file' : node.expanded ? 'open' : 'folder'" :size="14" :class="data.leaf ? 'entry-glyph' : 'dir-glyph'" />
                    <span class="tree-label-text">{{ data.label }}</span>
                  </span>
                </template>
              </ElTreeV2>
              <p v-else class="side-empty">没有匹配的文件。</p>
            </div>
          </template>
        </template>
        <p v-else class="side-empty">{{ t('导入 APK 后，这里会显示包内的文件和资源。', 'Open an APK to browse its files.') }}</p>
        <template v-if="!store.workspace">
          <div class="section-label"><Glyph name="clock" :size="15" /> {{ t('最近导入', 'Recent imports') }}</div>
          <div v-if="store.recent.length" class="history-list">
            <button v-for="item in store.recent" :key="item.id" :disabled="store.pending || store.running" :title="item.name" @click="reopen(item.id)">
              <Glyph name="brand" :size="16" /><span>{{ item.label || item.name }}</span><small>{{ shortDate(item.importedAt) }}</small>
            </button>
          </div>
          <p v-else class="side-empty">{{ t('暂无本地导入记录。', 'No recent imports.') }}</p>
        </template>
      </aside>

      <section class="center">
        <div v-if="store.error" class="error-banner" role="alert"><Glyph name="info" :size="17" /> <span>{{ store.error }}</span><button class="icon-button" aria-label="关闭提示" @click="store.error = ''"><Glyph name="close" :size="15" /></button></div>
        <div v-if="store.notice" class="success-banner" role="status"><span>{{ store.notice }}</span><button class="icon-button" aria-label="关闭结果" @click="store.notice = ''"><Glyph name="close" :size="15" /></button></div>
        <AnalysisPanel v-if="store.workspace && analysisOpened" v-show="workspaceView === 'analysis'" :key="store.workspace.id"
          :id="store.workspace.id" :projects="store.recent" :running="store.running" @open-native="openNative" />
        <PreferencesPanel v-if="workspaceView === 'preferences'">
          <div class="tool-settings">
            <ElButton :aria-expanded="toolsOpen" @click="toggleTools()">{{ t('外部工具', 'External tools') }}</ElButton>
            <div v-if="toolsOpen" class="tools-list">
              <ElButton size="small" :disabled="store.loadingTools" @click="store.refreshTools()">{{ t('重新检测', 'Rescan tools') }}</ElButton>
              <p v-if="store.loadingTools">{{ t('正在检测工具…', 'Detecting tools…') }}</p>
              <article v-for="tool in store.tools" :key="tool.name" class="tool-item">
                <div><strong>{{ tool.name }}</strong><span :class="{ detected: tool.version }">{{ tool.error && tool.source === 'custom' ? t('手动配置不可用', 'Custom configuration unavailable') : tool.version ? t('可用', 'Available') : tool.path ? t('未确认版本', 'Version unconfirmed') : t('未检测到', 'Not found') }}</span></div>
                <p v-if="tool.version">{{ tool.version }}</p><p v-if="tool.path" :title="tool.path">{{ tool.source ? sourceLabel[tool.source] : '' }} · {{ tool.path }}</p>
                <ElButton size="small" @click="store.configureTool(tool.name)">选择路径</ElButton>
                <p v-if="tool.error">{{ tool.error }}</p>
                <ElButton v-if="tool.source === 'custom'" size="small" text @click="store.configureTool(tool.name, true)">重置</ElButton>
              </article>
            </div>
          </div>
        </PreferencesPanel>
        <template v-else-if="store.workspace">
          <NativePanel v-if="workspaceView === 'native'" :workspace="store.workspace" :initial-path="nativePath" :running="store.running" />
          <template v-else-if="workspaceView === 'build'">
            <section v-if="store.hasPendingEdits || !store.decoded.android" class="workflow-panel">
              <h2>{{ t('构建与签名', 'Build and sign') }}</h2>
              <template v-if="store.hasPendingEdits">
                <p>{{ t('请先保存当前文件的修改，再构建工作副本。', 'Save your current file before building the working copy.') }}</p>
                <ElButton @click="workspaceView = 'editor'">{{ t('返回文件', 'Back to files') }}</ElButton>
              </template>
              <template v-else>
                <p>{{ t('构建前需要解码 Smali 和资源。', 'Decode Smali and resources before building.') }}</p>
                <p v-if="store.decodeIssues.android" role="status">{{ store.decodeIssues.android.message }}</p>
                <ElButton :disabled="store.pending || store.running" @click="store.decode('android')">{{ t('解码 Smali / 资源', 'Decode Smali / resources') }}</ElButton>
              </template>
            </section>
            <BuildPanel v-else :id="store.workspace.id" :running="store.running" />
          </template>
        </template>
        <div v-show="workspaceView === 'editor'" class="file-view">
          <div class="editor-tabs">
            <div v-if="store.tabs.length" ref="tabStrip" class="tab-strip" role="group" :aria-label="t('打开的文件', 'Open files')">
              <div v-for="tab in store.tabs" :key="tab.id" class="editor-tab" :class="{ 'is-active': tab.id === store.activeTabId }">
                <button class="tab-select" :aria-pressed="tab.id === store.activeTabId"
                  :aria-description="tab.edit && tab.edit.saved !== tab.draft ? t('未保存', 'Unsaved') : undefined" @click="store.selectTab(tab.id)">
                  <Glyph name="file" :size="14" />
                  <span class="tab-name" :title="tab.path">{{ fileName(tab.path) }}</span>
                  <span class="file-source-badge" :title="t('文件来源', 'File source')">{{ sourceLabelByKind[tab.source] }}</span>
                  <i v-if="tab.edit && tab.edit.saved !== tab.draft" class="tab-dirty-dot" :title="t('未保存', 'Unsaved')" aria-hidden="true"></i>
                </button>
                <button class="icon-button tab-close" :title="t(`关闭 ${fileName(tab.path)}`, `Close ${fileName(tab.path)}`)"
                  :aria-label="tab.id === store.activeTabId ? t('关闭文件', 'Close file') : t(`关闭 ${fileName(tab.path)}`, `Close ${fileName(tab.path)}`)"
                  :disabled="store.replacingWorkspace" @click="store.closeFile(tab.id)"><Glyph name="close" :size="13" /></button>
              </div>
            </div>
            <div v-else class="editor-tab overview-tab">
              <Glyph name="brand" :size="15" />
              <span class="tab-name">{{ store.workspace ? t('工作区概览', 'Workspace overview') : t('开始使用', 'Get started') }}</span>
            </div>
            <span v-if="store.activeTab" class="tab-hint" :class="{ 'is-dirty': store.dirty }">{{ store.replacingWorkspace ? t('正在切换工作区…', 'Switching workspace…') : store.activeTab.edit ? (store.dirty ? t('● 未保存', '● Unsaved') : t('已保存', 'Saved')) : t('只读预览', 'Read-only') }}</span>
          </div>
          <div v-if="!store.workspace" class="welcome">
            <div class="welcome-inner">
              <div class="cube-art" aria-hidden="true"><div class="cube-aura"></div>
                <svg viewBox="0 0 240 134" fill="none" width="240" height="134">
                  <defs><linearGradient id="cube-line" x1="70" y1="16" x2="168" y2="115" gradientUnits="userSpaceOnUse"><stop stop-color="#98F6D8"/><stop offset="1" stop-color="#6785EC"/></linearGradient><linearGradient id="cube-face" x1="119" y1="10" x2="119" y2="118" gradientUnits="userSpaceOnUse"><stop stop-color="#559F9A" stop-opacity=".23"/><stop offset="1" stop-color="#36537F" stop-opacity=".09"/></linearGradient></defs>
                  <path d="M120 4 199 48v45l-79 38-79-38V48L120 4Z M41 48l79 42 79-42M120 90v41" stroke="#526782" stroke-opacity=".28" stroke-dasharray="4 5"/>
                  <path d="M120 19 165 44v48l-45 24-45-24V44l45-25Z" fill="url(#cube-face)" stroke="url(#cube-line)" stroke-width="1.5"/>
                  <path d="m75 44 45 25 45-25m-45 25v47M97 31l45 25v21" stroke="url(#cube-line)" stroke-width="1.4"/>
                  <path d="M52 32h8m-4-4v8m124 67h8m-4-4v8m-11-84h5m-2.5-2.5v5" stroke="#88DCCC" stroke-opacity=".7"/>
                  <circle cx="65" cy="106" r="2" fill="#79A3F4"/><circle cx="181" cy="63" r="2" fill="#7CF0C6"/>
                </svg>
              </div>
              <div class="eyebrow"><span></span> ANDROID PACKAGE WORKBENCH</div>
              <h1>{{ t('打开你的第一个 APK', 'Open your first APK') }}</h1>
              <p>{{ t('查看应用信息、签名与包内文件。所有解析都在本机完成。', 'Browse metadata, signatures and files locally.') }}</p>
              <button class="dropzone" :disabled="store.pending || store.running" @click="store.importApk()">
                <span class="drop-icon"><Glyph name="upload" :size="20" /></span>
                <span><strong>{{ store.running ? t('正在导入 APK…', 'Opening APK…') : t('拖入 APK 文件，或点击选择', 'Drop an APK or click to browse') }}</strong><small>{{ t('支持 .apk 文件 · 最大 1 GiB', '.apk files up to 1 GiB') }}</small></span>
                <kbd>{{ shortcut }}</kbd>
              </button>
              <div class="welcome-note"><Glyph name="shield" :size="15" /> {{ t('导入会创建本地副本，原始 APK 保持不变。', 'Import creates a local workspace copy.') }}</div>
            </div>
          </div>

          <template v-else-if="store.activeTab">
            <div class="file-context">
              <div class="breadcrumb"><Glyph name="folder" :size="15" /> {{ sourceLabelByKind[store.activeSource] }} <Glyph name="chevron" :size="12" /> <span :title="store.activePath">{{ store.activePath }}</span></div>
              <div v-if="store.activeSource === 'archive' && isNativeLibrary(store.activePath)" class="file-actions">
                <ElButton size="small" @click="openNative(store.activePath)">{{ t('用 Ghidra 查看', 'Open in Ghidra') }}</ElButton>
              </div>
              <div v-else-if="store.activeTab.edit" class="file-actions" aria-label="文件编辑">
                <ElButton size="small" type="primary" :disabled="store.replacingWorkspace || !store.dirty || store.activeTab.saving" @click="store.saveFile()">{{ t('保存文件', 'Save file') }}</ElButton>
                <template v-if="store.activeTab.edit.format === 'text'">
                  <ElButton size="small" :disabled="store.replacingWorkspace || store.activeTab.comparing" @click="codeEditor?.history('undo')">{{ t('撤销', 'Undo') }}</ElButton>
                  <ElButton size="small" :disabled="store.replacingWorkspace || store.activeTab.comparing" @click="codeEditor?.history('redo')">{{ t('重做', 'Redo') }}</ElButton>
                  <ElButton size="small" :disabled="store.replacingWorkspace || store.activeTab.comparing" @click="codeEditor?.replace()">{{ t('查找与替换', 'Find and replace') }}</ElButton>
                </template>
                <template v-else>
                  <ElButton size="small" :disabled="store.replacingWorkspace || store.activeTab.saving" @click="store.replaceImage()">{{ t('替换图片…', 'Replace image…') }}</ElButton>
                  <ElButton size="small" :disabled="store.replacingWorkspace || store.activeTab.imageCursor === 0" @click="store.moveImageHistory(-1)">{{ t('撤销', 'Undo') }}</ElButton>
                  <ElButton size="small" :disabled="store.replacingWorkspace || store.activeTab.imageCursor >= store.activeTab.imageHistory.length - 1" @click="store.moveImageHistory(1)">{{ t('重做', 'Redo') }}</ElButton>
                </template>
                <ElButton size="small" @click="store.activeTab.comparing = !store.activeTab.comparing">{{ store.activeTab.comparing ? t('返回编辑', 'Back to editor') : t('查看差异', 'View changes') }}</ElButton>
              </div>
            </div>
            <div v-for="tab in store.tabs" v-show="tab.id === store.activeTabId" :key="tab.id" class="file-editor">
              <div v-if="tab.comparing" class="comparison-labels"><span>{{ t('解码原件', 'Decoded original') }}</span><span>{{ t('当前工作副本', 'Working copy') }}</span></div>
              <div v-if="tab.loading" class="preview-message">正在读取文件…</div>
              <CodePreview v-else-if="tab.preview?.format === 'text'" ref="codeEditors" :tab-id="tab.id" :path="tab.path" :value="tab.preview.value" :location="tab.location"
                :visible="workspaceView === 'editor' && tab.id === store.activeTabId" :original="tab.edit?.original" :draft="tab.draft" :read-only="store.replacingWorkspace"
                :comparing="tab.comparing" @change="tab.draft = $event" @save="store.saveFile(tab.id)" />
              <div v-else-if="tab.preview?.format === 'image'" class="image-preview" :class="{ 'image-diff': tab.comparing }">
                <img v-if="tab.comparing && tab.edit" :src="tab.edit.original" :alt="t('解码原件', 'Decoded original')" />
                <img :src="tab.edit ? tab.draft : tab.preview.value" :alt="tab.path" />
              </div>
              <div v-else class="preview-message"><Glyph name="file" :size="26" />{{ tab.preview?.value || '无法预览文件。' }}</div>
            </div>
          </template>

          <div v-else class="overview">
            <div class="eyebrow"><span></span> APK OVERVIEW</div>
            <h1>{{ displayName }}</h1>
            <p>{{ store.workspace.packageName || store.workspace.name }}</p>
            <div class="metrics">
              <div><small>包内文件</small><strong>{{ zipEntries.length.toLocaleString() }}</strong></div>
              <div><small>{{ t('APK 大小', 'APK size') }}</small><strong>{{ formatBytes(store.workspace.bytes) }}</strong></div>
              <div><small>DEX 文件</small><strong>{{ store.workspace.dexCount }}</strong></div>
            </div>
            <p class="overview-tip"><Glyph name="files" :size="17" /> 从左侧文件树选择条目，在此查看内容。</p>
            <ul v-if="store.workspace.warnings.length" class="warnings"><li v-for="warning in store.workspace.warnings" :key="warning">{{ warning }}</li></ul>
          </div>
        </div>
      </section>

      <aside v-show="inspectorOpen" id="apk-inspector" class="inspector" :aria-label="t('APK 信息', 'APK details')">
        <div class="pane-title">{{ t('APK 信息', 'APK details') }}
          <button class="icon-button" :aria-label="t('关闭 APK 信息', 'Close APK details')" @click="inspectorOpen = false"><Glyph name="close" :size="15" /></button>
        </div>
        <div class="inspector-body">
          <template v-if="store.workspace">
            <div class="app-card">
              <span class="app-avatar"><img v-if="store.icon" :src="store.icon" alt="" /><Glyph v-else name="brand" :size="21" /></span>
              <div>
                <strong :title="displayName">{{ displayName }}</strong>
                <small v-if="store.workspace.label && store.workspace.label !== store.workspace.name" :title="store.workspace.name">{{ store.workspace.name }}</small>
              </div>
            </div>
            <section class="inspector-section" aria-labelledby="apk-metadata-title">
              <h2 id="apk-metadata-title" class="inspector-heading">{{ t('基本信息', 'Metadata') }}</h2>
              <dl class="details"><div v-for="[name, value] in overview" :key="name"><dt>{{ name }}</dt><dd>{{ value || '—' }}</dd></div></dl>
            </section>
            <section class="inspector-section" aria-labelledby="apk-signature-title">
              <h2 id="apk-signature-title" class="inspector-heading">{{ t('签名与校验', 'Signature and integrity') }}</h2>
              <div class="signature" :class="store.workspace.signature.status">
                <Glyph name="shield" :size="16" />
                <strong>{{ signatureLabel[store.workspace.signature.status] }}</strong>
                <small v-if="store.workspace.signature.schemes.length">{{ store.workspace.signature.schemes.join(' · ') }}</small>
              </div>
              <div class="fingerprints">
                <div v-for="(fp, i) in store.workspace.signature.fingerprints" :key="fp" class="fingerprint">
                  <div class="fingerprint-label">{{ t(`证书 ${i + 1} SHA-256`, `Certificate ${i + 1} SHA-256`) }}</div>
                  <code>{{ fp }}</code>
                </div>
                <div class="fingerprint">
                  <div class="fingerprint-label">APK SHA-256
                    <button class="icon-button" :title="t('复制 SHA-256', 'Copy SHA-256')" :aria-label="t('复制 SHA-256', 'Copy SHA-256')" @click="copyHash"><Glyph name="copy" :size="14" /></button>
                  </div>
                  <code>{{ store.workspace.id }}</code>
                </div>
              </div>
            </section>
          </template>
          <p v-else class="inspector-empty">{{ t('导入 APK 后查看应用信息、签名和校验值。', 'Open an APK to view its metadata, signature and checksum.') }}</p>
        </div>
      </aside>
    </main>

    <section class="bottom" :aria-label="t('任务与日志', 'Tasks and logs')">
      <div v-show="logOpen" id="workbench-output" class="bottom-output">
        <div v-if="logTab === 'logs' && store.events.length" class="log-columns" aria-hidden="true">
          <span>{{ t('时间', 'Time') }}</span><span>{{ t('阶段', 'Stage') }}</span><span>{{ t('消息', 'Message') }}</span>
        </div>
        <div ref="logBox" class="log-body" :class="{ 'log-history': logTab === 'logs' }" aria-live="polite">
          <template v-if="logTab === 'logs' && store.events.length">
            <div v-for="(event, i) in store.events" :key="i" class="log-line">
              <time>{{ time(event.at) }}</time><strong class="log-stage">{{ event.stage }}</strong><span>{{ event.message }}</span>
            </div>
          </template>
          <div v-else-if="lastTask" class="task-line">
            <span class="task-state" :class="lastTask.status"><i></i>{{ taskLabel[lastTask.status] }}</span>
            <span class="task-message">{{ lastTask.message }}</span><time>{{ time(lastTask.at) }}</time>
          </div>
          <p v-else class="idle-log">{{ logTab === 'logs' ? t('暂无日志', 'No logs yet') : t('暂无运行任务', 'No running tasks') }}</p>
        </div>
      </div>
      <footer class="bottom-header statusbar">
        <div class="bottom-tabs" role="group" :aria-label="t('输出视图', 'Output view')">
          <button :aria-pressed="logTab === 'tasks' && logOpen" @click="logTab = 'tasks'; logOpen = true"><Glyph name="checklist" :size="15" /> {{ t('任务', 'Tasks') }}</button>
          <button :aria-pressed="logTab === 'logs' && logOpen" @click="logTab = 'logs'; logOpen = true"><Glyph name="terminal" :size="15" /> {{ t('日志', 'Logs') }}</button>
        </div>
        <span v-if="!logOpen && lastTask" class="task-summary" role="status" :title="lastTask.message">
          <i :class="lastTask.status"></i>{{ store.running ? lastTask.message : taskLabel[lastTask.status] }}
        </span>
        <span class="bottom-spacer"></span>
        <button v-if="store.running" class="cancel" @click="store.cancel()">{{ t('取消任务', 'Cancel task') }}</button>
        <button class="icon-button bottom-toggle" :title="logOpen ? t('收起面板', 'Collapse panel') : t('展开面板', 'Expand panel')"
          :aria-label="logOpen ? t('收起面板', 'Collapse panel') : t('展开面板', 'Expand panel')" :aria-expanded="logOpen" aria-controls="workbench-output"
          @click="logOpen = !logOpen"><Glyph name="down" :size="15" /></button>
        <span v-if="store.workspace" class="status-apk" :title="store.workspace.name">{{ store.workspace.name }}</span>
        <span class="status-right">{{ t('本地处理', 'Local processing') }} <b>v{{ version }}</b></span>
      </footer>
    </section>
    <div v-if="dragDepth > 0" class="drag-overlay"><span><Glyph name="upload" :size="30" /> 松开以导入 APK</span></div>
  </div>
</template>
