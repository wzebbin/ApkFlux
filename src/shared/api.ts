export type ApkEntry = { path: string; bytes: number; packedBytes: number }
export type ApkMetadata = {
  packageName: string
  label: string | null
  versionName: string | null
  versionCode: string | null
  minSdk: string | null
  targetSdk: string | null
}
export type Signature = {
  status: 'verified' | 'unverified' | 'unavailable'
  schemes: string[]
  fingerprints: string[]
}
export type WorkspaceSummary = {
  id: string
  name: string
  importedAt: string
  bytes: number
  label: string | null
  packageName: string | null
}
export type Workspace = WorkspaceSummary & {
  metadata: ApkMetadata | null
  signature: Signature
  dexCount: number
  architectures: string[]
  entries: ApkEntry[]
  iconPath: string | null
  warnings: string[]
}
export type EntryPreview = { format: 'text' | 'image' | 'binary'; value: string }
export type EditableFile = { format: 'text' | 'image'; original: string; saved: string }
export type EditDecision = 'cancel' | 'discard' | 'save'
export type BuildSettings = { alias: string; storePassword: string; keyPassword: string }
export type BuildRecord = { id: string; path: string; at: number; fingerprints: string[] }
export type NativeFunction = { name: string; address: string }
export type NativeLibrary = { functions: NativeFunction[]; language: string; engine: string; limited: boolean; timedOut: boolean }
export type NativeCode = { disassembly: string; pseudocode: string | null; pseudocodeError: string | null; instructionsLimited: boolean }
export type AndroidDevice = { serial: string; status: string; model: string | null }
export type AnalysisChange = { path: string; kind: 'added' | 'removed' | 'modified'; scope: 'archive' | DecodeKind }
export type PermissionItem = { name: string; category: string; purpose: string }
export type ApkAnalysis = {
  id: string; name: string; permissions: PermissionItem[] | null; warnings: string[]
  sdks: { name: string; evidence: string; confidence: 'high' | 'medium' }[]
  addresses: { value: string; kind: 'url' | 'websocket' | 'domain' | 'ip' | 'path'; path: string }[]
  libraries: { path: string; abi: string; architecture: string | null; bits: number | null; exports: string[]; strings: string[] }[]
}
export type AnalysisReport = {
  current: ApkAnalysis; baseline: ApkAnalysis | null; changes: AnalysisChange[]
  permissionChanges: { added: string[]; removed: string[] } | null
  sdkChanges: { added: string[]; removed: string[] } | null; notes: string[]
  coverage?: Record<DecodeKind, { baseline: boolean; current: boolean }>
}
export type ReportFormat = 'json' | 'html' | 'csv'
export type UpdateState = { status: 'unconfigured' | 'idle' | 'checking' | 'available' | 'current' | 'downloading' | 'ready' | 'failed'; version: string | null }
export type DecodeKind = 'java' | 'android'
export type FileSource = 'archive' | DecodeKind
export type DecodedFile = { path: string; bytes: number }
export type DecodeResult = { files: DecodedFile[]; warning: string | null }
export type SourceMatch = { path: string; line: number; text: string }
export type SourceSearch = { matches: SourceMatch[]; limited: boolean }
export type WorkspaceSearchHit = { source: FileSource; path: string; line?: number; text?: string }
export type WorkspaceSearch = { hits: WorkspaceSearchHit[]; missing: DecodeKind[]; limited: boolean }
export type ToolName = 'java' | 'aapt2' | 'apksigner' | 'zipalign' | 'adb' | 'jadx' | 'apktool' | 'ghidra'
export type ToolStatus = { name: ToolName; path: string | null; source: 'custom' | 'bundled' | 'sdk' | 'path' | null; version: string | null }
export type TaskStatus = 'running' | 'done' | 'failed' | 'cancelled'
export type TaskEvent = {
  id: string
  status: TaskStatus
  stage: string
  message: string
  at: number
  decode?: { workspaceId: string; kind: DecodeKind }
}
export type Reply<T> = { ok: true; data: T } | { ok: false; error: string }
export interface DesktopApi {
  selectApk(): Promise<Reply<Workspace | null>>
  dropApk(file: File): Promise<Reply<Workspace>>
  recent(): Promise<Reply<WorkspaceSummary[]>>
  open(id: string): Promise<Reply<Workspace>>
  preview(id: string, path: string): Promise<Reply<EntryPreview>>
  decoded(id: string): Promise<Reply<Record<DecodeKind, DecodeResult | null>>>
  decode(id: string, kind: DecodeKind): Promise<Reply<DecodeResult>>
  previewDecoded(id: string, kind: DecodeKind, path: string): Promise<Reply<EntryPreview>>
  previewManifest(id: string): Promise<Reply<EntryPreview>>
  searchDecoded(id: string, kind: DecodeKind, query: string): Promise<Reply<SourceSearch>>
  searchWorkspace(id: string, query: string): Promise<Reply<WorkspaceSearch>>
  exportJava(id: string): Promise<Reply<string | null>>
  openEdit(id: string, path: string): Promise<Reply<EditableFile | null>>
  saveEdit(id: string, path: string, value: string): Promise<Reply<void>>
  pickImage(id: string, path: string): Promise<Reply<string | null>>
  confirmEdit(path: string): Promise<Reply<EditDecision>>
  closeDecision(allow: boolean): Promise<Reply<void>>
  chooseKeystore(): Promise<Reply<string | null>>
  chooseApkOutput(): Promise<Reply<string | null>>
  buildApk(id: string, settings: BuildSettings): Promise<Reply<BuildRecord>>
  buildHistory(id: string): Promise<Reply<BuildRecord[]>>
  devices(): Promise<Reply<AndroidDevice[]>>
  installBuild(id: string, buildId: string, serial: string): Promise<Reply<void>>
  analyze(id: string, baseline?: string): Promise<Reply<AnalysisReport>>
  exportAnalysis(format: ReportFormat): Promise<Reply<string | null>>
  analyzeNative(id: string, path: string): Promise<Reply<NativeLibrary>>
  nativeCode(id: string, path: string, address: string): Promise<Reply<NativeCode>>
  updateState(): Promise<Reply<UpdateState>>
  checkUpdate(): Promise<Reply<UpdateState>>
  downloadUpdate(): Promise<Reply<UpdateState>>
  applyUpdate(): Promise<Reply<void>>
  manageDevice(id: string, serial: string, action: 'launch' | 'uninstall'): Promise<Reply<void>>
  tools(): Promise<Reply<ToolStatus[]>>
  chooseTool(name: ToolName): Promise<Reply<boolean>>
  resetTool(name: ToolName): Promise<Reply<void>>
  copyHash(id: string): Promise<Reply<void>>
  cancel(taskId?: string): Promise<Reply<void>>
  onTask(listener: (event: TaskEvent) => void): () => void
  onOpenRequest(listener: () => void): () => void
  onCloseRequest(listener: () => void): () => void
}
export const channels = {
  select: 'apk:select', drop: 'apk:drop', recent: 'apk:recent', open: 'apk:open',
  preview: 'apk:preview', tools: 'tools:list', chooseTool: 'tools:choose', resetTool: 'tools:reset',
  decoded: 'decode:index', decode: 'decode:run', previewDecoded: 'decode:preview', previewManifest: 'decode:manifest',
  searchDecoded: 'decode:search', searchWorkspace: 'workspace:search', exportJava: 'decode:export-java',
  openEdit: 'edit:open', saveEdit: 'edit:save', pickImage: 'edit:pick-image',
  confirmEdit: 'edit:confirm', closeDecision: 'ui:close-decision', closeRequest: 'ui:close-request',
  chooseKeystore: 'build:keystore', chooseApkOutput: 'build:destination', buildApk: 'build:run',
  buildHistory: 'build:history', devices: 'adb:devices', installBuild: 'adb:install',
  analyze: 'analysis:run', exportAnalysis: 'analysis:export',
  analyzeNative: 'native:analyze', nativeCode: 'native:code',
  updateState: 'update:state', checkUpdate: 'update:check', downloadUpdate: 'update:download', applyUpdate: 'update:apply',
  manageDevice: 'adb:manage',
  copyHash: 'workspace:copy-hash', cancel: 'task:cancel', task: 'task:event', openRequest: 'ui:open-request',
} as const
