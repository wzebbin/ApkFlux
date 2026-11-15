import { createHash } from 'node:crypto'
import { createWriteStream, constants } from 'node:fs'
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Signature, Workspace, WorkspaceSummary } from '../shared/api'
import { parseBadging, parseSignature } from './metadata'
import { errorMessage, type TaskContext } from './tasks'
import type { Tools } from './tools'
import { APK_MAX_BYTES, inspectArchive, previewEntry, validateEntryPath } from './zip'

const idPattern = /^[a-f0-9]{64}$/
const archiveName = 'source.apk'
const summary = ({ id, name, importedAt, bytes, label, packageName }: Workspace): WorkspaceSummary =>
  ({ id, name, importedAt, bytes, label, packageName })

export class Workspaces {
  private projects = new Map<string, WorkspaceSummary>()
  private active?: Workspace
  private previews = new Set<Promise<unknown>>()

  constructor(private root: string, private tools: Pick<Tools, 'run'>) {}

  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.import-')) await rm(join(this.root, entry.name), { recursive: true, force: true })
      if (!idPattern.test(entry.name)) continue
      try {
        const record = JSON.parse(await readFile(join(this.root, entry.name, 'summary.json'), 'utf8')) as WorkspaceSummary
        if (record.id === entry.name && typeof record.importedAt === 'string') this.projects.set(record.id, record)
      } catch { /* incomplete or damaged history entry */ }
    }
  }

  recent() { return [...this.projects.values()].sort((a, b) => b.importedAt.localeCompare(a.importedAt)) }

  async open(id: string) {
    this.requireProject(id)
    if (this.active?.id === id) return this.active
    const record = JSON.parse(await readFile(join(this.root, id, 'workspace.json'), 'utf8')) as Workspace
    if (record.id !== id || !Array.isArray(record.entries)) throw new Error('工作区索引已损坏。')
    this.active = record
    return record
  }

  private requireProject(id: string) {
    if (!idPattern.test(id) || !this.projects.has(id)) throw new Error('找不到该本地工作区。')
  }

  snapshot(id: string) {
    this.requireProject(id)
    return join(this.root, id, archiveName)
  }

  async preview(id: string, path: string) {
    validateEntryPath(path)
    if (this.previews.size >= 4) throw new Error('文件预览繁忙，请稍后重试。')
    const run = (async () => {
      const project = await this.open(id)
      const entry = project.entries.find((item) => item.path === path)
      if (!entry) throw new Error('该文件不在已验证的 APK 索引中。')
      return previewEntry(this.snapshot(id), entry)
    })()
    this.previews.add(run)
    try { return await run } finally { this.previews.delete(run) }
  }

  async import(source: string, task: TaskContext): Promise<Workspace> {
    if (!isAbsolute(source) || extname(source).toLowerCase() !== '.apk') throw new Error('请选择本地 .apk 文件。')
    const signal = AbortSignal.any([task.signal, AbortSignal.timeout(10 * 60 * 1000)])
    const temp = await mkdtemp(join(this.root, '.import-'))
    const archive = join(temp, archiveName)
    try {
      task.log('校验', '复制 APK 快照并计算 SHA-256。')
      const input = await open(source, constants.O_RDONLY | (constants.O_NONBLOCK || 0) | (constants.O_NOFOLLOW || 0))
      let bytes = 0
      const hash = createHash('sha256')
      try {
        const initial = await input.stat()
        if (!initial.isFile() || initial.size < 22 || initial.size > APK_MAX_BYTES) throw new Error('APK 必须是 22 字节至 1 GiB 的普通文件。')
        const measure = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            bytes += chunk.length
            if (bytes > APK_MAX_BYTES) callback(new Error('APK 文件超过 1 GiB。'))
            else { hash.update(chunk); callback(null, chunk) }
          },
        })
        await pipeline(input.createReadStream({ autoClose: false }), measure, createWriteStream(archive, { flags: 'wx', mode: 0o600 }), { signal })
        const after = await input.stat()
        if (bytes !== initial.size || after.mtimeMs !== initial.mtimeMs || after.ctimeMs !== initial.ctimeMs) throw new Error('源文件在导入期间发生变化。')
      } finally { await input.close() }

      const id = hash.digest('hex')
      let previous: Workspace | undefined
      if (this.projects.has(id)) {
        previous = await this.open(id)
        if (previous.warnings.length === 0) {
          task.log('缓存', '相同 SHA-256 的 APK 已存在，复用工作区。')
          return previous
        }
      }

      task.log('校验', '检查 ZIP 路径、解压限制及条目 CRC。')
      const inventory = await inspectArchive(archive, signal).catch((error: unknown) => {
        signal.throwIfAborted()
        throw new Error(`APK 校验失败：${errorMessage(error)}`)
      })
      const warnings: string[] = []
      let metadata = null
      let iconPath: string | null = null
      task.log('解析', '读取 Android 清单、应用信息及图标位置。')
      const badging = await this.tools.run('aapt2', ['dump', 'badging', archive], signal).catch((error: unknown) => {
        signal.throwIfAborted()
        warnings.push(`无法运行 aapt2：${errorMessage(error)}`)
        return null
      })
      if (!badging) {
        if (!warnings.length) warnings.push('未找到 aapt2；包名、版本、SDK 和图标不可用。')
      } else {
        if (badging.code !== 0) throw new Error('aapt2 无法读取 Android 清单；请检查 APK 或更新 SDK Build Tools。')
        const parsed = parseBadging(badging.stdout)
        metadata = parsed.metadata
        iconPath = parsed.iconPaths.find((path) => inventory.entries.some((entry) => entry.path === path && entry.bytes <= 2 * 1024 * 1024)) ?? null
      }

      task.log('签名', '验证 APK 签名并读取证书指纹。')
      let signature: Signature = { status: 'unavailable', schemes: [], fingerprints: [] }
      try {
        const result = await this.tools.run('apksigner', ['verify', '--verbose', '--print-certs', archive], signal, 45_000)
        if (result) signature = parseSignature(result.code, result.stdout + '\n' + result.stderr)
        if (signature.status === 'unavailable') warnings.push(result ? 'apksigner 未能确定签名状态。' : '未找到 apksigner；未验证签名。')
      } catch (error) {
        signal.throwIfAborted()
        warnings.push(`无法验证签名：${errorMessage(error)}`)
      }
      signal.throwIfAborted()
      const record: Workspace = {
        id, name: previous?.name ?? basename(source), importedAt: previous?.importedAt ?? new Date().toISOString(), bytes,
        label: metadata?.label ?? null, packageName: metadata?.packageName ?? null,
        ...inventory, metadata, signature, iconPath, warnings,
      }
      await writeFile(join(temp, 'workspace.json'), JSON.stringify(record), { mode: 0o600 })
      await writeFile(join(temp, 'summary.json'), JSON.stringify(summary(record)), { mode: 0o600 })
      signal.throwIfAborted()
      if (previous) {
        // Upgrade metadata when tools become available; the snapshot is identical.
        await rename(join(temp, 'workspace.json'), join(this.root, id, 'workspace.json'))
        await rename(join(temp, 'summary.json'), join(this.root, id, 'summary.json'))
      } else {
        await rename(temp, join(this.root, id))
      }
      this.projects.set(id, summary(record))
      this.active = record
      return record
    } finally { await rm(temp, { recursive: true, force: true }) }
  }
}
