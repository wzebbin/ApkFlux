import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { extname, isAbsolute, join } from 'node:path'
import type { AndroidDevice, BuildRecord, BuildSettings } from '../shared/api'
import type { Decoder } from './decode'
import { parseSignature } from './metadata'
import type { TaskContext } from './tasks'
import type { Tools } from './tools'

export class Builder {
  constructor(private root: string, private decoder: Decoder, private tools: Tools) {}

  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    for (const item of await readdir(this.root, { withFileTypes: true })) {
      if (item.isDirectory() && item.name.startsWith('.build-')) await rm(join(this.root, item.name), { recursive: true, force: true })
    }
  }

  private location(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('无效的工作区标识。')
    return join(this.root, id)
  }

  async history(id: string): Promise<BuildRecord[]> {
    const root = this.location(id)
    const names = await readdir(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return []
    })
    const records: BuildRecord[] = []
    for (const file of names) {
      if (!/^[\da-f-]{36}\.json$/.test(file)) continue
      const record = JSON.parse(await readFile(join(root, file), 'utf8')) as BuildRecord
      records.push(record)
    }
    return records.sort((a, b) => b.at - a.at)
  }

  async build(id: string, apk: string, keystore: string, destination: string, settings: BuildSettings, task: TaskContext) {
    if (!isAbsolute(destination) || extname(destination).toLowerCase() !== '.apk') throw new Error('请选择新的 .apk 输出文件。')
    const temp = await mkdtemp(join(this.root, '.build-'))
    try {
      const unsigned = await this.decoder.buildUnsigned(id, apk, temp, task)
      const aligned = join(temp, 'aligned.apk')
      const signed = join(temp, 'signed.apk')
      task.log('对齐', '正在对齐新 APK。')
      const tools = this.tools
      const align = await tools.run('zipalign', ['-P', '16', '4', unsigned, aligned], task.signal, 90_000)
      if (!align || align.code !== 0) throw new Error('zipalign 对齐失败，请检查 SDK Build Tools。')
      task.log('签名', '正在为新 APK 签名。')
      const credentials = ['--ks-pass', 'env:APKFLUX_STORE_PASS']
      if (settings.keyPassword) credentials.push('--key-pass', 'env:APKFLUX_KEY_PASS')
      const sign = await tools.run('apksigner', ['sign', '--ks', keystore, '--ks-key-alias', settings.alias,
        ...credentials, '--v4-signing-enabled', 'false', '--out', signed, aligned], task.signal, 120_000, {
        cwd: temp, env: { APKFLUX_STORE_PASS: settings.storePassword, APKFLUX_KEY_PASS: settings.keyPassword },
        onOutput: () => {},
      })
      if (!sign || sign.code !== 0) throw new Error('apksigner 签名失败，请检查密钥库、别名和密码。')
      const verify = await tools.run('apksigner', ['verify', '--verbose', '--print-certs', signed], task.signal, 90_000)
      if (!verify) throw new Error('未找到 apksigner。')
      const signature = parseSignature(verify.code, verify.stdout + '\n' + verify.stderr)
      if (signature.status !== 'verified') throw new Error('新 APK 未通过签名验证。')
      task.log('验签', '签名验证通过。')
      const record = { id: randomUUID(), path: destination, at: Date.now(), fingerprints: signature.fingerprints }
      const folder = this.location(id)
      await mkdir(folder, { recursive: true, mode: 0o700 })
      task.signal.throwIfAborted()
      try { await copyFile(signed, destination, constants.COPYFILE_EXCL) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('输出文件已存在，请选择一个新文件名。')
        throw error
      }
      await writeFile(join(folder, record.id + '.json'), JSON.stringify(record), { mode: 0o600 })
      return record
    } finally { await rm(temp, { recursive: true, force: true }) }
  }

  async devices(): Promise<AndroidDevice[]> {
    const result = await this.tools.run('adb', ['devices', '-l'])
    if (!result || result.code !== 0) throw new Error('无法读取 ADB 设备列表，请检查平台工具。')
    return result.stdout.split(/\r?\n/).flatMap((line) => {
      const row = /^(\S+)\s+(device|unauthorized|offline|recovery|bootloader)(?:\s|$)/.exec(line)
      return row ? [{ serial: row[1], status: row[2], model: /\bmodel:(\S+)/.exec(line)?.[1] ?? null }] : []
    })
  }

  async install(id: string, buildId: string, serial: string, task: TaskContext) {
    const record = (await this.history(id)).find((item) => item.id === buildId)
    if (!record) throw new Error('找不到已验签的构建记录。')
    if (!(await this.devices()).some((item) => item.serial === serial && item.status === 'device')) throw new Error('该设备未连接或未授权。')
    const result = await this.tools.run('adb', ['-s', serial, 'install', '-r', record.path], task.signal, 120_000)
    if (!result || result.code !== 0 || !/\bSuccess\b/.test(result.stdout)) {
      throw new Error(`ADB 安装失败。${result?.stderr.trim().slice(0, 500) || ''}`)
    }
    task.log('ADB', '已安装到所选设备。')
  }

  async manage(pkg: string, serial: string, action: 'launch' | 'uninstall', task: TaskContext) {
    if (!/^[a-zA-Z_][\w]*(?:\.[a-zA-Z_][\w]*)+$/.test(pkg)) throw new Error('APK 包名无效。')
    if (!(await this.devices()).some((item) => item.serial === serial && item.status === 'device')) throw new Error('该设备未连接或未授权。')
    let args = ['uninstall', pkg]
    if (action === 'launch') {
      const resolved = await this.tools.run('adb', ['-s', serial, 'shell', 'cmd', 'package', 'resolve-activity', '--brief',
        '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', '-p', pkg], task.signal)
      const component = resolved?.stdout.split(/\r?\n/).map((line) => line.trim())
        .find((line) => line.startsWith(pkg + '/') && /^[\w.]+\/[\w.$]+$/.test(line))
      if (!component || resolved?.code !== 0) throw new Error('所选设备上未找到该应用的启动 Activity。')
      args = ['shell', 'am', 'start', '-n', component]
    }
    const response = await this.tools.run('adb', ['-s', serial, ...args], task.signal, 30_000)
    if (!response || response.code !== 0 || /(?:Error|Failure)\b/i.test(response.stdout + '\n' + response.stderr)) {
      throw new Error((response?.stderr || response?.stdout || 'ADB 操作失败。').trim().slice(0, 500))
    }
    task.log('ADB', action === 'launch' ? '已启动应用。' : '已卸载应用。')
  }
}
