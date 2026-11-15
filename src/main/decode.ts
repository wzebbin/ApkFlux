import { constants, createReadStream } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, mkdtemp, open, opendir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import type { DecodedFile, DecodeKind, DecodeResult, EditableFile, EntryPreview, FileSource, SourceMatch, SourceSearch, WorkspaceSearch } from '../shared/api'
import type { TaskContext } from './tasks'
import type { Tools } from './tools'
import { markCacheUsed, pruneDecodedCaches } from './cache'
import { validateEntryPath } from './zip'
import { imageDataUrl, PREVIEW_MAX_BYTES, previewBytes, rasterMime, rasterPath } from './preview'

const MiB = 1024 * 1024
const decodeKinds = ['java', 'android'] as const
const isSmali = (name: string) => /^smali(?:_classes\d+)?$/.test(name)
const markup = (path: string) => /\.(java|smali|xml|json|txt|html|css)$/i.test(path)
const isManifestXml = (text: string) => /^(?:<\?xml[^>]*\?>\s*)?<manifest\b/.test(text.trimStart())

export class Decoder {
  private searchController?: AbortController
  private readonly indexes = new Map<string, Map<DecodeKind, DecodeResult>>()

  constructor(private root: string, private tools: Pick<Tools, 'run'>) {}

  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    for (const item of await readdir(this.root, { withFileTypes: true })) {
      if (item.isDirectory() && item.name.startsWith('.decode-')) await rm(join(this.root, item.name), { recursive: true, force: true })
    }
    await pruneDecodedCaches(this.root).catch(error => console.warn('解码缓存清理未完成', error))
  }

  private location(id: string, kind: DecodeKind) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('无效的工作区标识。')
    return join(this.root, id, kind)
  }

  private remember(id: string, kind: DecodeKind, result: DecodeResult) {
    let project = this.indexes.get(id)
    if (!project) {
      project = new Map()
      // Keep only a few decoded workspaces in memory. Disk indexes survive restarts.
      if (this.indexes.size >= 3) {
        const oldest = this.indexes.keys().next().value
        if (oldest) this.indexes.delete(oldest)
      }
      this.indexes.set(id, project)
    }
    project.set(kind, result)
  }

  async index(id: string, kind: DecodeKind): Promise<DecodeResult | null> {
    const path = join(this.location(id, kind), 'index.json')
    const cached = this.indexes.get(id)?.get(kind)
    if (cached) {
      await markCacheUsed(path)
      return cached
    }
    try {
      if ((await lstat(path)).size > 32 * MiB) throw new Error('反编译索引超过大小限制。')
      const result = JSON.parse(await readFile(path, 'utf8')) as DecodeResult
      if (!Array.isArray(result.files)) throw new Error('反编译缓存索引无效。')
      this.remember(id, kind, result)
      await markCacheUsed(path)
      return result
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async list(id: string): Promise<Record<DecodeKind, DecodeResult | null>> {
    const [java, android] = await Promise.all(decodeKinds.map((kind) => this.index(id, kind)))
    return { java, android }
  }

  async run(id: string, kind: DecodeKind, apk: string, task: TaskContext): Promise<DecodeResult> {
    const cached = await this.index(id, kind)
    if (cached) {
      task.log('缓存', '已打开当前 APK 的反编译缓存。')
      return cached
    }
    const temp = await mkdtemp(join(this.root, '.decode-'))
    const filesRoot = join(temp, 'files')
    const engine = kind === 'java' ? 'jadx' : 'apktool'
    const args = kind === 'java'
      ? ['--config', 'none', '--no-res', '-j', '4', '-ds', filesRoot, apk]
      : ['decode', '--no-assets', '-j', '4', '-p', join(temp, 'framework'), '-o', filesRoot, apk]
    try {
      task.log(engine, '正在运行反编译工具。')
      const result = await this.tools.run(engine, args, task.signal, 10 * 60_000, {
        cwd: temp,
        env: {
          JADX_CONFIG_DIR: join(temp, 'jadx-config'), JADX_CACHE_DIR: join(temp, 'jadx-cache'),
          JADX_TMP_DIR: join(temp, 'jadx-temp'), JADX_OPTS: '-Xmx2g',
        },
        onOutput: (line) => task.log(engine, line),
      })
      task.signal.throwIfAborted()
      if (!result) throw new Error(`未找到 ${engine}。请在「外部工具」中选择可执行文件或 JAR。`)
      const partial = kind === 'java' && result.code === 3 && /finished with errors/i.test(result.stdout + '\n' + result.stderr)
      if (result.code !== 0 && !partial) {
        const lines = stripVTControlCharacters(result.stderr || result.stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
        const detail = lines.find((line) => /error|exception|failed|fatal/i.test(line)) ?? (result.stderr ? lines[0] : undefined)
        throw new Error(`${engine} 退出（代码 ${result.code}）。${detail ? detail.slice(0, 300) : '详细原因见日志。'}`)
      }
      task.log('索引', '正在整理生成的文件。')
      if (!(await lstat(filesRoot)).isDirectory()) throw new Error('反编译工具未生成有效目录。')
      // List results through an allowlist. Apktool also copies binaries and original signatures.
      if (kind === 'android') {
        for (const name of await readdir(filesRoot)) {
          if (name !== 'AndroidManifest.xml' && name !== 'res' && !isSmali(name)) {
            await rm(join(filesRoot, name), { force: true, recursive: true })
          }
        }
      }
      const files = await collectFiles(filesRoot, kind, task.signal)
      let warning: string | null = null
      if (kind === 'java') {
        if (!files.length) throw new Error('JADX 未生成可浏览的 Java 文件。')
        if (partial) warning = 'JADX 报告部分方法反编译失败。已保留生成的 Java 文件，详情见日志。'
      } else {
        const manifest = files.find((file) => file.path === 'AndroidManifest.xml')
        if (!manifest) throw new Error('Apktool 未生成 AndroidManifest.xml。')
        const bytes = await boundedRead(join(filesRoot, manifest.path))
        if (!bytes || !isManifestXml(bytes.toString('utf8'))) {
          throw new Error('Apktool 未生成可读取的 XML 清单。')
        }
      }
      const record = { files, warning }
      await writeFile(join(temp, 'index.json'), JSON.stringify(record), { mode: 0o600 })
      for (const name of await readdir(temp)) {
        if (name !== 'files' && name !== 'index.json') await rm(join(temp, name), { force: true, recursive: true })
      }
      const dest = this.location(id, kind)
      await mkdir(dirname(dest), { recursive: true, mode: 0o700 })
      task.signal.throwIfAborted()
      await rename(temp, dest)
      this.remember(id, kind, record)
      return record
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  }

  private async rootOf(id: string, kind: DecodeKind) {
    return realpath(join(this.location(id, kind), 'files'))
  }

  async previewManifest(id: string, apk: string, task: TaskContext): Promise<EntryPreview> {
    const cache = join(dirname(this.location(id, 'android')), 'manifest-preview.xml')
    const saved = await boundedRead(cache).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return null
    })
    if (saved && isManifestXml(saved.toString('utf8'))) {
      await markCacheUsed(cache)
      return { format: 'text', value: saved.toString('utf8') }
    }

    const temp = await mkdtemp(join(this.root, '.decode-'))
    const output = join(temp, 'output')
    try {
      const result = await this.tools.run('apktool', ['decode', '--only-manifest', '--no-src', '--no-assets',
        '-p', join(temp, 'framework'), '-o', output, apk], task.signal, 60_000, {
        cwd: temp, onOutput: (line) => task.log('Apktool', line),
      })
      task.signal.throwIfAborted()
      if (!result) throw new Error('查看二进制 AndroidManifest.xml 需要 Apktool。请在「外部工具」中配置。')
      if (result.code !== 0) throw new Error('Apktool 未能解码清单，详情见日志。')
      const path = join(output, 'AndroidManifest.xml')
      const text = (await boundedRead(path))?.toString('utf8')
      if (!text || !isManifestXml(text)) throw new Error('Apktool 未生成可读取的 XML 清单。')
      await mkdir(dirname(cache), { recursive: true, mode: 0o700 })
      task.signal.throwIfAborted()
      await rename(path, cache)
      return { format: 'text', value: text }
    } finally { await rm(temp, { recursive: true, force: true }) }
  }

  async preview(id: string, kind: DecodeKind, path: string): Promise<EntryPreview> {
    validateEntryPath(path)
    if (!(await this.index(id, kind))?.files.some((entry) => entry.path === path)) throw new Error('该文件不在反编译索引中。')
    const bytes = await boundedRead(await indexedPath(await this.rootOf(id, kind), path))
    return previewBytes(path, bytes)
  }

  private editsDir(id: string) {
    return join(dirname(this.location(id, 'android')), 'edits')
  }

  private editPath(id: string, path: string) {
    return join(this.editsDir(id), createHash('sha256').update(path).digest('hex') + '.json')
  }

  async openEdit(id: string, path: string): Promise<EditableFile | null> {
    const resource = path.startsWith('res/')
    const text = path === 'AndroidManifest.xml' || path.endsWith('.smali') || (resource && /\.(xml|json|txt|html|css|csv|properties|js|md)$/i.test(path))
    const image = resource && rasterPath(path)
    if (!text && !image) return null
    const preview = await this.preview(id, 'android', path)
    if (preview.format === 'binary' || (image && preview.format !== 'image') || (text && preview.format !== 'text')) return null
    try {
      const saved = JSON.parse(await readFile(this.editPath(id, path), 'utf8')) as { path: string; value: string }
      if (saved.path !== path || typeof saved.value !== 'string') throw new Error('工作副本索引已损坏。')
      return { format: preview.format, original: preview.value, saved: saved.value }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return { format: preview.format, original: preview.value, saved: preview.value }
    }
  }

  async pickReplacement(id: string, path: string, source: string) {
    if ((await this.openEdit(id, path))?.format !== 'image') throw new Error('该文件不支持图片替换。')
    const bytes = await boundedRead(source)
    if (!bytes) throw new Error('请选择不超过 2 MiB 的图片。')
    return validateImage(path, bytes)
  }

  async saveEdit(id: string, path: string, value: string) {
    const edit = await this.openEdit(id, path)
    if (!edit) throw new Error('该文件不支持编辑。')
    if (edit.format === 'image') {
      const comma = value.indexOf(',')
      if (comma < 0 || validateImage(path, Buffer.from(value.slice(comma + 1), 'base64')) !== value) {
        throw new Error('替换图片的编码无效。')
      }
    } else if (Buffer.byteLength(value, 'utf8') > PREVIEW_MAX_BYTES || value.includes('\0')) {
      throw new Error('工作副本文本必须是 2 MiB 以内的 UTF-8。')
    }
    const destination = this.editPath(id, path)
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    const temp = destination + '.' + randomUUID() + '.tmp'
    try {
      await writeFile(temp, JSON.stringify({ path, value }), { flag: 'wx', mode: 0o600 })
      await rename(temp, destination)
    } finally { await rm(temp, { force: true }) }
  }

  async savedFiles(id: string) {
    const directory = this.editsDir(id)
    const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return []
    })
    const files = new Map<string, string>()
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
      const { path, value } = JSON.parse(await readFile(join(directory, name), 'utf8')) as { path: string; value: string }
      validateEntryPath(path)
      files.set(path, value)
    }
    return files
  }

  async buildUnsigned(id: string, apk: string, temp: string, task: TaskContext) {
    if (!(await this.index(id, 'android'))) throw new Error('请先解码 Smali / 资源。')
    const project = join(temp, 'project')
    const framework = join(temp, 'framework')
    const unsigned = join(temp, 'unsigned.apk')
    const run = async (args: string[]) => {
      const result = await this.tools.run('apktool', args, task.signal, 10 * 60_000, {
        cwd: temp, onOutput: (line) => task.log('Apktool', line),
      })
      if (!result) throw new Error('未找到 Apktool。')
      if (result.code !== 0) throw new Error(`Apktool 退出（代码 ${result.code}），详情见日志。`)
    }
    task.log('构建', '从原始快照生成临时构建目录。')
    await run(['decode', '-j', '4', '-p', framework, '-o', project, apk])
    const root = await realpath(project)
    const edits = await this.savedFiles(id)
    for (const [path, value] of edits) {
      task.signal.throwIfAborted()
      const file = await indexedPath(root, path)
      const content = rasterPath(path) ? Buffer.from(value.slice(value.indexOf(',') + 1), 'base64') : value
      await writeFile(file, content)
    }
    task.log('构建', `正在编译，已应用 ${edits.size} 项已保存的修改。`)
    await run(['build', '-j', '4', '-p', framework, '-o', unsigned, project])
    return unsigned
  }

  private beginSearch() {
    this.searchController?.abort()
    this.searchController = new AbortController()
    return this.searchController.signal
  }

  async search(id: string, kind: DecodeKind, term: string): Promise<SourceSearch> {
    const query = term.trim().toLowerCase()
    if (!query) return { matches: [], limited: false }
    return this.searchText(id, kind, query, this.beginSearch(), Date.now() + 20_000, 300)
  }

  async searchWorkspace(id: string, archive: readonly DecodedFile[], term: string): Promise<WorkspaceSearch> {
    const query = term.trim().toLowerCase()
    const result: WorkspaceSearch = { hits: [], missing: [], limited: false }
    if (!query) return result
    const signal = this.beginSearch()
    const deadline = Date.now() + 20_000
    const addPaths = (source: FileSource, files: readonly DecodedFile[]) => {
      const matching = files.filter(file => file.path.toLowerCase().includes(query))
      result.limited ||= matching.length > 50
      result.hits.push(...matching.slice(0, 50).map(({ path }) => ({ source, path })))
    }
    addPaths('archive', archive)
    const decoded = await Promise.all(decodeKinds.map(async (kind) => {
      const index = await this.index(id, kind)
      if (!index) return { kind, index }
      const text = await this.searchText(id, kind, query, signal, deadline, 100)
      return { kind, index, text }
    }))
    signal.throwIfAborted()
    for (const { kind, index, text } of decoded) {
      if (!index || !text) { result.missing.push(kind); continue }
      addPaths(kind, index.files)
      result.limited ||= text.limited
      result.hits.push(...text.matches.map(match => ({ source: kind, ...match })))
    }
    return result
  }

  private async searchText(id: string, kind: DecodeKind, query: string, signal: AbortSignal, deadline: number, limit: number): Promise<SourceSearch> {
    const index = await this.index(id, kind)
    if (!index) return { matches: [], limited: false }
    const root = await this.rootOf(id, kind)
    const matches: SourceMatch[] = []
    const edits = kind === 'android' ? await this.savedFiles(id) : new Map<string, string>()
    let checked = 0
    let limited = false
    for (const file of index.files) {
      signal.throwIfAborted()
      if (!markup(file.path)) continue
      if (file.bytes > PREVIEW_MAX_BYTES) { limited = true; continue }
      if (checked + file.bytes > 512 * MiB || Date.now() >= deadline) return { matches, limited: true }
      const saved = edits.get(file.path)
      const bytes = saved === undefined ? await boundedRead(await indexedPath(root, file.path)) : Buffer.from(saved)
      if (!bytes) { limited = true; continue }
      checked += bytes.length
      let line = 0
      for (const value of bytes.toString('utf8').split(/\r?\n/)) {
        line++
        const offset = value.toLowerCase().indexOf(query)
        if (offset < 0) continue
        matches.push({ path: file.path, line, text: value.slice(Math.max(0, offset - 45), offset + query.length + 80).trim() })
        if (matches.length >= limit) return { matches, limited: true }
      }
    }
    return { matches, limited }
  }

  async fileHashes(id: string, kind: DecodeKind, signal: AbortSignal) {
    const index = await this.index(id, kind)
    if (!index) return null
    const root = await this.rootOf(id, kind)
    const hashes = new Map<string, string>()
    for (const item of index.files) {
      signal.throwIfAborted()
      const digest = createHash('sha256')
      const path = await indexedPath(root, item.path)
      for await (const chunk of createReadStream(path, { signal })) digest.update(chunk)
      hashes.set(item.path, digest.digest('hex'))
    }
    return hashes
  }

  async exportJava(id: string, parent: string, task: TaskContext) {
    const index = await this.index(id, 'java')
    if (!index) throw new Error('请先生成 Java 文件。')
    const root = await this.rootOf(id, 'java')
    const destination = await mkdtemp(join(parent, 'ApkFlux-java-'))
    try {
      for (const file of index.files) {
        task.signal.throwIfAborted()
        const target = join(destination, file.path)
        await mkdir(dirname(target), { recursive: true })
        await copyFile(await indexedPath(root, file.path), target, constants.COPYFILE_EXCL)
      }
      return destination
    } catch (error) {
      await rm(destination, { recursive: true, force: true })
      throw error
    }
  }
}

function validateImage(path: string, data: Buffer) {
  const ext = path.split('.').at(-1)?.toLowerCase() ?? ''
  const header = data.subarray(0, 12)
  const valid = ext === 'png' ? header.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
    : ext === 'jpg' || ext === 'jpeg' ? header.subarray(0, 3).toString('hex') === 'ffd8ff'
      : ext === 'gif' ? /^GIF8[79]a$/.test(header.subarray(0, 6).toString('ascii'))
        : ext === 'webp' && header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP'
  const mime = rasterMime(path)
  if (!mime || !valid || data.length > PREVIEW_MAX_BYTES) throw new Error('图片内容必须与当前文件格式一致，且不超过 2 MiB。')
  return imageDataUrl(mime, data)
}

async function indexedPath(root: string, path: string) {
  validateEntryPath(path)
  const expected = join(root, path)
  const actual = await realpath(expected)
  const within = relative(root, actual)
  if (!within || within === '..' || within.startsWith('..' + sep) || isAbsolute(within) || actual !== expected) {
    throw new Error('生成文件位于索引目录以外或路径已改变。')
  }
  return actual
}

async function boundedRead(path: string) {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0))
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > PREVIEW_MAX_BYTES) return null
    const bytes = Buffer.alloc(info.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset !== info.size) throw new Error('生成文件在读取期间发生变化。')
    return bytes.subarray(0, offset)
  } finally { await file.close() }
}

async function collectFiles(root: string, kind: DecodeKind, signal: AbortSignal): Promise<DecodedFile[]> {
  const results: DecodedFile[] = []
  let totalBytes = 0
  let indexBytes = 0
  let visited = 0
  async function walk(prefix: string) {
    for await (const item of await opendir(join(root, prefix))) {
      signal.throwIfAborted()
      if (++visited > 150_000) throw new Error('生成文件数量超过限制。')
      const path = prefix ? `${prefix}/${item.name}` : item.name
      validateEntryPath(path)
      if (item.isDirectory()) {
        await walk(path)
        continue
      }
      if (!item.isFile()) throw new Error('反编译输出中包含不支持的文件类型。')
      const bytes = (await lstat(join(root, path))).size
      totalBytes += bytes
      indexBytes += Buffer.byteLength(path) + 40
      if (totalBytes > 2048 * MiB || indexBytes > 16 * MiB) throw new Error('反编译输出超过缓存大小限制。')
      if (kind === 'java' && !path.endsWith('.java')) continue
      if (kind === 'android' && path !== 'AndroidManifest.xml' && !path.startsWith('res/') &&
          !(isSmali(path.split('/')[0]) && path.endsWith('.smali'))) continue
      results.push({ path, bytes })
    }
  }
  await walk('')
  return results.sort((a, b) => a.path.localeCompare(b.path, 'en'))
}
