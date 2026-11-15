import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ApkEntry, NativeCode, NativeLibrary } from '../shared/api'
import type { TaskContext } from './tasks'
import type { Tools } from './tools'
import { markCacheUsed, pruneNativeCaches } from './cache'
import { readNativeLibrary } from './zip'
import { isNativeLibrary } from '../shared/native-library'
import script from './ghidra/ApkFluxInspectNative.java'

const scriptName = 'ApkFluxInspectNative.java'
const project = 'ApkFlux'
const libraryName = 'library.so'
// Ghidra rejects project paths containing a component that starts with a dot.
const stagePrefix = 'native-stage-'
const addressPattern = /^[0-9a-f]{1,16}$/i
type Installation = NonNullable<Awaited<ReturnType<Tools['ghidra']>>>
type Index = Omit<NativeLibrary, 'engine'>

export class NativeAnalyzer {
  constructor(private root: string, private tools: Tools) {}

  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await mkdir(join(this.root, 'ghidra-home'), { mode: 0o700, recursive: true })
    for (const item of await readdir(this.root, { withFileTypes: true })) {
      if (item.isDirectory() && item.name.startsWith(stagePrefix)) await rm(join(this.root, item.name), { force: true, recursive: true })
    }
    await pruneNativeCaches(this.root).catch(error => console.warn('Ghidra 缓存清理未完成', error))
  }

  private location(id: string, entry: ApkEntry, installation: Installation) {
    if (!/^[a-f0-9]{64}$/.test(id) || !isNativeLibrary(entry.path)) throw new Error('无效的 SO 工作区条目。')
    const key = createHash('sha256').update(entry.path).digest('hex')
    return join(this.root, id, key, installation.version)
  }

  private async installation(signal: AbortSignal) {
    const installation = await this.tools.ghidra(signal)
    signal.throwIfAborted()
    if (!installation) throw new Error('请先选择本地 Ghidra 安装目录。')
    return installation
  }

  private async run(install: Installation, temp: string, folder: string, command: string[], scriptArgs: string[], task: TaskContext, timeout: number) {
    const scripts = join(temp, 'scripts')
    await mkdir(scripts, { mode: 0o700 })
    await writeFile(join(scripts, scriptName), script, { mode: 0o600 })
    const output = await this.tools.runGhidra(install, join(this.root, 'ghidra-home'), [
      folder, project, ...command,
      '-max-cpu', '4', '-scriptPath', scripts, '-postScript', scriptName, ...scriptArgs,
    ], task.signal, timeout, { cwd: temp, onOutput: (line) => task.log('Ghidra', line) })
    task.signal.throwIfAborted()
    if (output.code !== 0) throw new Error(`Ghidra 退出（代码 ${output.code}），详情见日志。`)
  }

  async analyze(id: string, archive: string, entry: ApkEntry, task: TaskContext): Promise<NativeLibrary> {
    const install = await this.installation(task.signal)
    const destination = this.location(id, entry, install)
    const cached = await readIndex(join(destination, 'index.json'))
    if (cached) {
      await markCacheUsed(join(destination, 'index.json'))
      task.log('缓存', '已打开 SO 的 Ghidra 函数索引。')
      return { ...cached, engine: install.version }
    }
    const temp = await mkdtemp(join(this.root, stagePrefix))
    const result = join(temp, 'result')
    try {
      task.log('Ghidra', `静态分析 ${entry.path}`)
      await mkdir(result, { mode: 0o700 })
      const binary = join(temp, libraryName)
      await writeFile(binary, await readNativeLibrary(archive, entry, task.signal), { mode: 0o600 })
      const indexFile = join(result, 'index.json')
      await this.run(install, temp, result, ['-import', binary, '-analysisTimeoutPerFile', '180'], [indexFile, 'index'], task, 300_000)
      const index = await readIndex(indexFile)
      if (!index || !(await lstat(join(result, project + '.gpr'))).isFile()) {
        throw new Error('Ghidra 未生成有效的函数索引，请查看日志。')
      }
      await mkdir(join(destination, '..'), { recursive: true, mode: 0o700 })
      task.signal.throwIfAborted()
      await rename(result, destination)
      return { ...index, engine: install.version }
    } finally { await rm(temp, { force: true, recursive: true }) }
  }

  async code(id: string, entry: ApkEntry, address: string, task: TaskContext): Promise<NativeCode> {
    if (!addressPattern.test(address)) throw new Error('无效的函数地址。')
    const install = await this.installation(task.signal)
    const folder = this.location(id, entry, install)
    const index = await readIndex(join(folder, 'index.json'))
    if (!index?.functions.some((item) => item.address === address)) throw new Error('该函数未在当前 SO 的 Ghidra 索引中。')
    await markCacheUsed(join(folder, 'index.json'))
    const cache = join(folder, `function-${address}.json`)
    const saved = await readJson(cache, 4 * 1024 * 1024)
    if (validCode(saved)) return saved

    const temp = await mkdtemp(join(this.root, stagePrefix))
    try {
      const output = join(temp, 'function.json')
      await this.run(install, temp, folder, ['-process', libraryName, '-readOnly', '-noanalysis'], [output, 'function', address], task, 90_000)
      const code = await readJson(output, 4 * 1024 * 1024)
      if (!validCode(code)) throw new Error('Ghidra 未生成有效的函数结果，请查看日志。')
      task.signal.throwIfAborted()
      if (code.pseudocode !== null) await rename(output, cache)
      return code
    } finally { await rm(temp, { force: true, recursive: true }) }
  }
}

async function readJson(path: string, max: number): Promise<unknown> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.size > max) throw new Error('Ghidra 输出文件超出限制或类型无效。')
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function readIndex(path: string): Promise<Index | null> {
  const entry = await readJson(path, 20 * 1024 * 1024) as Index | null
  if (!entry) return null
  if (!Array.isArray(entry.functions) || entry.functions.length > 20_000 || typeof entry.language !== 'string' ||
      typeof entry.limited !== 'boolean' || typeof entry.timedOut !== 'boolean' ||
      !entry.functions.every((item) => item && typeof item.name === 'string' && typeof item.address === 'string' && addressPattern.test(item.address))) {
    throw new Error('Ghidra 函数索引无效。')
  }
  return entry
}

function validCode(value: unknown): value is NativeCode {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<NativeCode>
  return typeof item.disassembly === 'string' && typeof item.instructionsLimited === 'boolean' &&
    (item.pseudocode === null || typeof item.pseudocode === 'string') &&
    (item.pseudocodeError === null || typeof item.pseudocodeError === 'string')
}
