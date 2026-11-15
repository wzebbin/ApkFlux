import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, rename, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, extname, isAbsolute, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { ToolName, ToolStatus } from '../shared/api'

export const toolNames: ToolName[] = ['java', 'aapt2', 'apksigner', 'zipalign', 'adb', 'jadx', 'apktool', 'ghidra']
type Source = NonNullable<ToolStatus['source']>
type Tool = { path: string; source: Source; command: string; prefix: string[] }
type Result = { code: number; stdout: string; stderr: string }
type RunOptions = { cwd: string; env?: NodeJS.ProcessEnv; onOutput: (line: string) => void }
const windows = process.platform === 'win32'
function executablePaths(name: string) {
  const paths = (process.env.PATH || '').split(delimiter)
  if (!windows) paths.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin')
  return paths.filter(isAbsolute).map(dir => join(dir, name))
}
const versionArgs: Record<ToolName, string[]> = {
  java: ['-version'], aapt2: ['version'], apksigner: ['version'], zipalign: ['-h'],
  adb: ['version'], jadx: ['--version'], apktool: ['--version'], ghidra: [],
}

async function usable(path: string, checkExecutable = true) {
  try {
    if (!(await stat(path)).isFile()) return false
    await access(path, checkExecutable && !windows ? constants.X_OK : constants.R_OK)
    return true
  } catch { return false }
}

function runProcess(tool: Tool, args: string[], signal?: AbortSignal, timeoutMs = 15_000, options?: RunOptions): Promise<Result> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const group = Boolean(options && !windows)
    const child = spawn(tool.command, [...tool.prefix, ...args], {
      shell: false, windowsHide: true, detached: group, stdio: ['ignore', 'pipe', 'pipe'],
      cwd: options?.cwd, env: options?.env ? { ...process.env, ...options.env } : undefined,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let size = 0
    let failure: Error | undefined
    let force: NodeJS.Timeout | undefined
    const kill = (kind: NodeJS.Signals) => {
      if (!group || !child.pid) { child.kill(kind); return }
      try { process.kill(-child.pid, kind) } catch { child.kill(kind) }
    }
    const stop = (error: Error) => {
      if (failure) return
      failure = error
      kill('SIGTERM')
      force = setTimeout(() => kill('SIGKILL'), 800)
      force.unref()
    }
    const abort = () => stop(signal?.reason instanceof Error ? signal.reason : new Error('工具调用已取消。'))
    const timer = setTimeout(() => stop(new Error('工具运行超时。')), timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    let lastProgress = 0
    const reporter = (chunks: Buffer[]) => {
      const decoder = new StringDecoder('utf8')
      let pending = ''
      const emit = (line: string) => {
        line = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim()
        if (!line) return
        if (/\bprogress:/i.test(line)) {
          const now = Date.now()
          if (now - lastProgress < 500) return
          lastProgress = now
        }
        options?.onOutput(line.slice(0, 500))
      }
      return {
        add(data: Buffer) {
          size += data.length
          if (size > 4 * 1024 * 1024) { stop(new Error('工具输出超过 4 MiB 上限。')); return }
          chunks.push(data)
          if (!options) return
          const lines = (pending + decoder.write(data)).split(/[\r\n]+/)
          pending = lines.pop() ?? ''
          for (const line of lines) emit(line)
        },
        end() { if (options) emit(pending + decoder.end()) },
      }
    }
    const out = reporter(stdout)
    const err = reporter(stderr)
    child.stdout.on('data', out.add)
    child.stderr.on('data', err.add)
    child.on('error', (error) => { failure ??= error })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (force) {
        clearTimeout(force)
        if (group) kill('SIGKILL')
      }
      signal?.removeEventListener('abort', abort)
      out.end()
      err.end()
      if (failure || code === null) reject(failure ?? new Error('工具进程意外退出。'))
      else resolve({ code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() })
    })
  })
}

export class Tools {
  private custom: Partial<Record<ToolName, string>> = {}
  private editing = false

  constructor(private settings: string, private bundled: string) {}

  async init() {
    try {
      const obj = JSON.parse(await readFile(this.settings, 'utf8')) as Record<string, unknown>
      for (const name of toolNames) if (typeof obj[name] === 'string' && isAbsolute(obj[name])) this.custom[name] = obj[name]
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  async configure(name: ToolName, path?: string) {
    if (this.editing) throw new Error('工具设置正在更新，请稍后再试。')
    this.editing = true
    try {
      const next = { ...this.custom }
      if (path) {
        if (name === 'ghidra') {
          if (!isAbsolute(path) || !await this.ghidraFiles(path)) throw new Error('请选择解压后包含 Ghidra 和 support 的安装目录。')
        } else if (!isAbsolute(path) || !(await this.command(name, path, 'custom'))) {
          throw new Error('所选路径不是可直接运行的工具。Windows 批处理请改选对应 JAR。')
        }
        next[name] = path
      } else delete next[name]
      const temp = this.settings + '.tmp'
      await writeFile(temp, JSON.stringify(next, null, 2), { mode: 0o600 })
      await rename(temp, this.settings)
      this.custom = next
    } finally { this.editing = false }
  }

  private async ghidraFiles(path: string) {
    const jar = join(path, 'Ghidra', 'Framework', 'Utility', 'lib', 'Utility.jar')
    const properties = await readFile(join(path, 'Ghidra', 'application.properties'), 'utf8').catch(() => '')
    const version = /^application\.version=(\d+(?:\.\d+)*)\s*$/m.exec(properties)?.[1]
    if (!version || !await usable(jar, false)) return null
    const min = Number(/^application\.java\.min=(\d+)\s*$/m.exec(properties)?.[1] ?? '21')
    const max = /^application\.java\.max=(\d+)\s*$/m.exec(properties)?.[1]
    return { jar, version, min, max: max ? Number(max) : Infinity }
  }

  private async ghidraJdk(min: number, max: number, signal?: AbortSignal) {
    const executable = windows ? 'java.exe' : 'java'
    const compiler = windows ? 'javac.exe' : 'javac'
    const configured = await this.resolve('java').catch(() => null)
    const candidates = [
      ...[process.env.GHIDRA_JAVA_HOME, process.env.JAVA_HOME].flatMap((home) => home && isAbsolute(home) ? [join(home, 'bin', executable)] : []),
      ...(configured ? [configured.command] : []),
      ...(process.platform === 'darwin' ? ['/opt/homebrew/opt/openjdk/bin/java', '/usr/local/opt/openjdk/bin/java'] : []),
      ...executablePaths(executable),
    ]
    for (const path of new Set(candidates)) {
      signal?.throwIfAborted()
      if (!await usable(join(dirname(path), compiler)) || !await usable(path)) continue
      const actual = await runProcess({ path, command: path, source: 'path', prefix: [] }, ['-version'], signal, 5000).catch(() => null)
      const version = Number(/version "(\d+)\b/.exec((actual?.stdout ?? '') + (actual?.stderr ?? ''))?.[1])
      if (actual?.code === 0 && version >= min && version <= max) return path
    }
    return null
  }

  async ghidra(signal?: AbortSignal) {
    const configured = this.custom.ghidra
    const env = process.env.GHIDRA_HOME
    const candidates: [string, Source][] = configured ? [[configured, 'custom']]
      : [...(env && isAbsolute(env) ? [[env, 'path'] as [string, Source]] : []), [join(this.bundled, 'ghidra'), 'bundled']]
    for (const [path, source] of candidates) {
      const files = await this.ghidraFiles(path)
      if (!files) {
        if (source === 'custom') throw new Error('找不到已配置的 Ghidra，请重新选择安装目录。')
        continue
      }
      const java = await this.ghidraJdk(files.min, files.max, signal)
      return { path, source, ...files, java }
    }
    return null
  }

  async runGhidra(install: NonNullable<Awaited<ReturnType<Tools['ghidra']>>>, home: string, args: string[],
      signal: AbortSignal, timeoutMs: number, options: RunOptions) {
    if (!install.java) throw new Error(`Ghidra ${install.version} 需要兼容的 JDK ${install.min} 或更高版本。请在外部工具中配置 Java。`)
    const prefix = ['-Xmx2g', '-Xshare:off', '-XX:ParallelGCThreads=2', '-Djava.awt.headless=true',
      '-Djava.system.class.loader=ghidra.GhidraClassLoader', '-Dfile.encoding=UTF-8',
      '-Djavax.xml.accessExternalDTD=', '-Djavax.xml.accessExternalSchema=', '-Djavax.xml.accessExternalStylesheet=',
      '--enable-native-access=ALL-UNNAMED', `-Duser.home=${home}`, `-Djava.io.tmpdir=${options.cwd}`, '-cp', install.jar,
      'ghidra.Ghidra', 'ghidra.app.util.headless.AnalyzeHeadless']
    return runProcess({ path: install.path, source: install.source, command: install.java, prefix }, args, signal, timeoutMs, options)
  }

  private async command(name: ToolName, path: string, source: Source): Promise<Tool | null> {
    const ext = extname(path).toLowerCase()
    if (ext === '.jar') {
      if (!['apksigner', 'apktool', 'jadx'].includes(name) || !(await usable(path, false))) return null
      const java = await this.resolve('java')
      if (!java) return null
      // The standalone JADX JAR starts the GUI by default.
      const prefix = name === 'jadx'
        ? ['-Xmx2g', '--enable-native-access=ALL-UNNAMED', '-cp', path, 'jadx.cli.JadxCLI']
        : [name === 'apksigner' ? '-Xmx512m' : '-Xmx2g', '-jar', path]
      return { path, source, command: java.command, prefix }
    }
    if (windows && ext !== '.exe' && ext !== '.com') return null
    return await usable(path) ? { path, source, command: path, prefix: [] } : null
  }

  private async sdkCandidates(name: ToolName) {
    const bundledSdk = join(this.bundled, 'sdk')
    const roots = [...new Set([
      bundledSdk,
      process.env.ANDROID_SDK_ROOT, process.env.ANDROID_HOME,
      process.platform === 'darwin' ? join(homedir(), 'Library', 'Android', 'sdk')
        : windows ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Android', 'Sdk')
          : join(homedir(), 'Android', 'Sdk'),
    ].filter((root): root is string => Boolean(root && isAbsolute(root))))]
    const paths: [string, Source][] = []
    for (const root of roots) {
      const source = root === bundledSdk ? 'bundled' : 'sdk'
      if (name === 'adb') paths.push([join(root, 'platform-tools', windows ? 'adb.exe' : 'adb'), source])
      if (!['apksigner', 'aapt2', 'zipalign'].includes(name)) continue
      const dir = join(root, 'build-tools')
      const versions = await readdir(dir).catch(() => [])
      versions.sort((a, b) => Number(/^[\d.]+$/.test(b)) - Number(/^[\d.]+$/.test(a)) || b.localeCompare(a, 'en', { numeric: true }))
      for (const version of versions) {
        if (name === 'apksigner') {
          paths.push([join(dir, version, 'lib', 'apksigner.jar'), source])
          if (!windows) paths.push([join(dir, version, name), source])
        } else paths.push([join(dir, version, name + (windows ? '.exe' : '')), source])
      }
    }
    return paths
  }

  async resolve(name: ToolName): Promise<Tool | null> {
    const custom = this.custom[name]
    if (custom) {
      const tool = await this.command(name, custom, 'custom')
      if (!tool) throw new Error(`无法运行已配置的 ${name}；请在工具面板重置或重新选择。`)
      return tool
    }
    const executable = name + (windows ? '.exe' : '')
    const candidates: [string, Source][] = [[join(this.bundled, executable), 'bundled'], [join(this.bundled, name + '.jar'), 'bundled']]
    if (name === 'java') candidates.push([join(this.bundled, 'runtime', 'bin', executable), 'bundled'])
    if (name === 'java' && process.env.JAVA_HOME && isAbsolute(process.env.JAVA_HOME)) candidates.push([join(process.env.JAVA_HOME, 'bin', executable), 'sdk'])
    candidates.push(...await this.sdkCandidates(name))
    for (const path of executablePaths(executable)) candidates.push([path, 'path'])
    for (const [path, source] of candidates) {
      const tool = await this.command(name, path, source)
      if (tool) return tool
    }
    return null
  }

  async run(name: ToolName, args: string[], signal?: AbortSignal, timeoutMs?: number, options?: RunOptions) {
    const tool = await this.resolve(name)
    return tool ? runProcess(tool, args, signal, timeoutMs, options) : null
  }

  async status(name: ToolName, signal?: AbortSignal): Promise<ToolStatus> {
    if (name === 'ghidra') {
      const install = await this.ghidra(signal)
      return { name, path: install?.path ?? null, source: install?.source ?? null, version: install?.java ? install.version : null }
    }
    const tool = await this.resolve(name)
    if (!tool) return { name, path: null, source: null, version: null }
    const result = await runProcess(tool, versionArgs[name], signal, 5000).catch(() => null)
    const zipVersion = /build-tools[/\\]([^/\\]+)[/\\]zipalign/i.exec(tool.path)?.[1]
    const lines = result && (result.stdout + '\n' + result.stderr).split(/\r?\n/).map((v) => v.trim()).filter(Boolean)
    const version = name === 'zipalign' && zipVersion ? `Build Tools ${basename(zipVersion)}`
      : lines && (result.code === 0 || name === 'zipalign') ? lines[0]?.slice(0, 200) || null : null
    return { name, path: tool.path, source: tool.source, version }
  }
}
