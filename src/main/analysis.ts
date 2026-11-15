import { isIP } from 'node:net'
import type { AnalysisChange, AnalysisReport, ApkAnalysis, PermissionItem, ReportFormat, Workspace } from '../shared/api'
import type { Decoder } from './decode'
import type { TaskContext } from './tasks'
import type { Tools } from './tools'
import { scanArchive } from './zip'
import { isNativeLibrary } from '../shared/native-library'

const MiB = 1024 * 1024
const sdkRules = [
  ['Firebase', 'com/google/firebase/', 'high'], ['Google Play services', 'com/google/android/gms/', 'high'],
  ['OkHttp', 'okhttp3/', 'high'], ['Okio', 'okio/', 'high'], ['Retrofit', 'retrofit2/', 'high'],
  ['Glide', 'com/bumptech/glide/', 'high'], ['React Native', 'com/facebook/react/', 'high'],
  ['Sentry', 'io/sentry/', 'high'], ['Flutter', 'libflutter.so', 'high'], ['Tencent MMKV', 'com/tencent/mmkv/', 'high'],
  ['Google Gson', 'com/google/gson/', 'high'], ['AndroidX', 'androidx/', 'medium'],
] as const
const machines: Record<number, string> = { 3: 'x86', 40: 'ARM', 62: 'x86-64', 183: 'AArch64', 243: 'RISC-V' }
const permissionGroups: [RegExp, string, string][] = [
  [/^(ACCESS_(FINE|COARSE|BACKGROUND)_LOCATION)$/, '位置', '读取设备位置。'],
  [/^(CAMERA)$/, '相机', '访问设备相机。'],
  [/^(RECORD_AUDIO)$/, '麦克风', '录制音频。'],
  [/^(READ|WRITE)_(CONTACTS|CALL_LOG)$|^GET_ACCOUNTS$/, '联系人与通话', '读取或修改联系人、账号或通话记录。'],
  [/^(SEND|READ|RECEIVE)_SMS$/, '短信', '发送、接收或读取短信。'],
  [/^INTERNET$|^(ACCESS|CHANGE)_(NETWORK|WIFI)_STATE$/, '网络', '连接网络或访问网络状态。'],
  [/^(READ|WRITE)_(EXTERNAL_STORAGE|MEDIA_.+)$|^MANAGE_EXTERNAL_STORAGE$/, '文件与媒体', '读取或管理存储中的文件或媒体。'],
  [/^BLUETOOTH|^NFC$|^NEARBY_WIFI_DEVICES$/, '附近设备', '发现或连接附近设备。'],
  [/^POST_NOTIFICATIONS$/, '通知', '发送系统通知。'],
  [/^(REQUEST_INSTALL_PACKAGES|SYSTEM_ALERT_WINDOW|QUERY_ALL_PACKAGES)$/, '特殊访问', '申请特定 Android 平台能力。'],
]

function permission(name: string): PermissionItem {
  const prefix = 'android.permission.'
  const match = name.startsWith(prefix) && permissionGroups.find(([pattern]) => pattern.test(name.slice(prefix.length)))
  if (match) return { name, category: match[1], purpose: match[2] }
  return { name, category: name.startsWith(prefix) ? '其他系统权限' : '应用自定义', purpose: '具体权限行为取决于 Android 版本或声明方。' }
}

export function analyzeElf(path: string, data: Buffer): ApkAnalysis['libraries'][number] {
  const item: ApkAnalysis['libraries'][number] = {
    path, abi: path.split('/')[1], architecture: null, bits: null, exports: [], strings: [],
  }
  if (data.length < 52 || data.readUInt32BE(0) !== 0x7f454c46 || ![1, 2].includes(data[4]) || ![1, 2].includes(data[5])) return item
  const is64 = data[4] === 2
  const little = data[5] === 1
  if (is64 && data.length < 64) return item
  const short = (offset: number) => little ? data.readUInt16LE(offset) : data.readUInt16BE(offset)
  const int = (offset: number) => little ? data.readUInt32LE(offset) : data.readUInt32BE(offset)
  const word = (offset: number) => !is64 ? int(offset) : Number(little ? data.readBigUInt64LE(offset) : data.readBigUInt64BE(offset))
  const valid = (offset: number, size: number) => Number.isSafeInteger(offset) && Number.isSafeInteger(size) && offset >= 0 && size >= 0 && offset <= data.length - size
  const machine = short(18)
  item.architecture = machines[machine] || `ELF machine ${machine}`
  item.bits = is64 ? 64 : 32
  for (const match of data.toString('latin1').matchAll(/[\x20-\x7e]{8,}/g)) {
    if (/[a-zA-Z]{3}/.test(match[0])) item.strings.push(match[0].slice(0, 180))
    if (item.strings.length >= 32) break
  }
  const base = word(is64 ? 40 : 32)
  const step = short(is64 ? 58 : 46)
  const count = short(is64 ? 60 : 48)
  if (step < (is64 ? 64 : 40) || !valid(base, step * count)) return item
  for (let section = 0; section < count; section++) {
    const at = base + section * step
    if (int(at + 4) !== 11) continue
    const offset = word(at + (is64 ? 24 : 16))
    const size = word(at + (is64 ? 32 : 20))
    const link = int(at + (is64 ? 40 : 24))
    const entrySize = word(at + (is64 ? 56 : 36))
    if (link >= count || entrySize < (is64 ? 24 : 16) || !valid(offset, size)) continue
    const table = base + link * step
    const strings = word(table + (is64 ? 24 : 16))
    const stringSize = word(table + (is64 ? 32 : 20))
    if (!valid(strings, stringSize)) continue
    for (let pos = offset; pos + entrySize <= offset + size; pos += entrySize) {
      const flagsAt = pos + (is64 ? 4 : 12)
      const bind = data[flagsAt] >> 4
      const visibility = data[flagsAt + 1] & 3
      if ((bind !== 1 && bind !== 2) || visibility === 1 || visibility === 2 || short(flagsAt + 2) === 0) continue
      const nameOffset = int(pos)
      if (nameOffset >= stringSize) continue
      const start = strings + nameOffset
      const end = data.indexOf(0, start)
      if (end > start && end < strings + stringSize && end - start <= 180) item.exports.push(data.toString('utf8', start, end))
      if (item.exports.length >= 200) return item
    }
  }
  return item
}

type Inventory = { analysis: ApkAnalysis; hashes: Map<string, string> }

export class Analyzer {
  constructor(private tools: Tools, private decoder: Decoder) {}

  private async inspect(project: Workspace, apk: string, task: TaskContext): Promise<Inventory> {
    const analysis: ApkAnalysis = { id: project.id, name: project.name, permissions: null, sdks: [], addresses: [], libraries: [], warnings: [] }
    const hashes = new Map<string, string>()
    const knownSdk = new Set<string>()
    const addressKeys = new Set<string>()
    let budget = 96 * MiB
    let truncated = false
    task.log('静态分析', `分析 ${project.name}。`)
    await scanArchive(apk, task.signal, (name, size) => {
      const so = isNativeLibrary(name)
      if (!so && !/\.(dex|js|txt|html|json|properties|xml)$/i.test(name)) return 0
      const retained = Math.min(so ? 16 * MiB : name.endsWith('.dex') ? 20 * MiB : MiB, budget, size)
      budget -= retained
      if (retained < size) truncated = true
      return retained
    }, (path, digest, bytes) => {
      hashes.set(path, digest)
      if (isNativeLibrary(path)) analysis.libraries.push(analyzeElf(path, bytes))
      const content = bytes.toString('latin1')
      for (const [name, marker, confidence] of sdkRules) {
        if (knownSdk.has(name) || (!path.includes(marker) && (!path.endsWith('.dex') || !content.includes(marker)))) continue
        knownSdk.add(name)
        analysis.sdks.push({ name, evidence: `${path} · ${marker}`, confidence })
      }
      const add = (value: string, kind: ApkAnalysis['addresses'][number]['kind']) => {
        if (analysis.addresses.length >= 300 || addressKeys.has(value)) return
        addressKeys.add(value)
        analysis.addresses.push({ value, kind, path })
      }
      if (analysis.addresses.length < 300) {
        for (const match of content.matchAll(/\b(?:https?|wss?):\/\/[^\s"'<>\\\x00-\x1f\x7f-\xff]{3,350}/gi)) {
          if (analysis.addresses.length >= 300) break
          try {
            const url = new URL(match[0].replace(/[),.;]+$/, ''))
            const host = url.hostname.replace(/^\[|\]$/g, '')
            if (!host.includes('.') && !isIP(host) && host !== 'localhost') continue
            add(url.href, url.protocol.startsWith('ws') ? 'websocket' : 'url')
            add(host, isIP(host) ? 'ip' : 'domain')
          } catch { /* a string may resemble a URL without being one */ }
        }
        for (const match of content.matchAll(/(?:^|[\x00"'\s])(\/(?:api|v[1-9]\d?|graphql)\/[a-z\d/_?=.%&-]{2,160})/gi)) {
          if (analysis.addresses.length >= 300) break
          add(match[1], 'path')
        }
        for (const match of content.matchAll(/(?:^|[\x00"'\s])((?:\d{1,3}\.){3}\d{1,3})(?=$|[\x00"'\s])/g)) {
          if (analysis.addresses.length >= 300) break
          if (isIP(match[1])) add(match[1], 'ip')
        }
        for (const match of content.matchAll(/(?:^|[\x00"'\s])((?:[a-z\d][a-z\d-]{0,61}\.)+(?:com|net|org|io|cn|dev|app|edu))(?=$|[\x00"'\s])/gi)) {
          if (analysis.addresses.length >= 300) break
          add(match[1].toLowerCase(), 'domain')
        }
      }
    })
    if (truncated || analysis.addresses.length >= 300) analysis.warnings.push('字符串及 ELF 分析采用有上限的静态采样。')
    const output = await this.tools.run('aapt2', ['dump', 'permissions', apk], task.signal).catch(() => null)
    task.signal.throwIfAborted()
    if (output?.code === 0) {
      analysis.permissions = [...new Set([...output.stdout.matchAll(/^uses-permission(?:-sdk-\d+)?: name='([^']+)'/gm)].map((match) => match[1]))]
        .sort().map(permission)
    } else analysis.warnings.push('aapt2 未能读取权限清单。')
    return { analysis, hashes }
  }

  async run(current: Workspace, apk: string, baseline: { project: Workspace; apk: string } | null, task: TaskContext): Promise<AnalysisReport> {
    const target = await this.inspect(current, apk, task)
    const report: AnalysisReport = { current: target.analysis, baseline: null, changes: [], permissionChanges: null, sdkChanges: null, notes: [] }
    if (!baseline) return report
    const before = await this.inspect(baseline.project, baseline.apk, task)
    report.baseline = before.analysis
    report.changes = fileChanges(before.hashes, target.hashes, 'archive')
    const coverage = { java: { baseline: false, current: false }, android: { baseline: false, current: false } }
    report.coverage = coverage
    for (const kind of ['java', 'android'] as const) {
      const oldFiles = await this.decoder.fileHashes(baseline.project.id, kind, task.signal)
      const newFiles = await this.decoder.fileHashes(current.id, kind, task.signal)
      coverage[kind] = { baseline: oldFiles !== null, current: newFiles !== null }
      if (oldFiles && newFiles) report.changes = report.changes.concat(fileChanges(oldFiles, newFiles, kind))
      else report.notes.push(`${kind === 'java' ? 'Java' : 'Smali / 资源'}未参与对比，尚未生成结果：${[!oldFiles && '基准 APK', !newFiles && '当前 APK'].filter(Boolean).join('、')}。`)
    }
    if (before.analysis.permissions && target.analysis.permissions) {
      report.permissionChanges = nameChanges(before.analysis.permissions, target.analysis.permissions)
    }
    report.sdkChanges = nameChanges(before.analysis.sdks, target.analysis.sdks)
    return report
  }
}

function nameChanges(before: { name: string }[], after: { name: string }[]) {
  const beforeNames = new Set(before.map((item) => item.name))
  const afterNames = new Set(after.map((item) => item.name))
  return { added: [...afterNames].filter((name) => !beforeNames.has(name)), removed: [...beforeNames].filter((name) => !afterNames.has(name)) }
}

export function fileChanges(before: Map<string, string>, after: Map<string, string>, scope: AnalysisChange['scope']): AnalysisChange[] {
  const rows: AnalysisChange[] = []
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const old = before.get(path)
    const next = after.get(path)
    if (old !== next) rows.push({ path, scope, kind: old === undefined ? 'added' : next === undefined ? 'removed' : 'modified' })
  }
  return rows
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char)

export function renderReport(report: AnalysisReport, format: ReportFormat) {
  if (format === 'json') return JSON.stringify(report, null, 2)
  const rows: string[][] = [['APK', '类别', '条目', '说明']]
  for (const analysis of [report.baseline, report.current]) {
    if (!analysis) continue
    rows.push(...(analysis.permissions ?? []).map((item) => [analysis.name, '权限', item.name, `${item.category} · ${item.purpose}`]))
    rows.push(...analysis.sdks.map((item) => [analysis.name, 'SDK', item.name, `${item.confidence} · ${item.evidence}`]))
    rows.push(...analysis.addresses.map((item) => [analysis.name, item.kind, item.value, item.path]))
    rows.push(...analysis.libraries.map((item) => [analysis.name, 'ELF', item.path, JSON.stringify(item)]))
    rows.push(...analysis.warnings.map((warning) => [analysis.name, '提示', warning, '']))
  }
  for (const item of report.changes) rows.push([report.current.name, item.scope, item.path, item.kind])
  rows.push(...report.notes.map((note) => [report.current.name, '提示', note, '']))
  if (report.permissionChanges) {
    rows.push(...report.permissionChanges.added.map((name) => [report.current.name, '权限新增', name, '']))
    rows.push(...report.permissionChanges.removed.map((name) => [report.current.name, '权限移除', name, '']))
  }
  if (report.sdkChanges) {
    rows.push(...report.sdkChanges.added.map((name) => [report.current.name, 'SDK 新增', name, '']))
    rows.push(...report.sdkChanges.removed.map((name) => [report.current.name, 'SDK 移除', name, '']))
  }
  if (format === 'csv') {
    return '\ufeff' + rows.map((row) => row.map((cell) => '"' + (/^[\r\n\t]|^\s*[=+\-@]/.test(cell) ? "'" : '') + cell.replaceAll('"', '""') + '"').join(',')).join('\r\n')
  }
  return '<!doctype html><meta charset="utf-8"><title>ApkFlux 分析报告</title>' +
    '<style>body{font:14px system-ui}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:.55em;overflow-wrap:anywhere}</style>' +
    '<h1>ApkFlux 分析报告</h1><table>' + rows.map((row, i) => {
      const tag = i ? 'td' : 'th'
      return '<tr>' + row.map((cell) => `<${tag}>${escapeHtml(cell)}</${tag}>`).join('') + '</tr>'
    }).join('') + '</table>'
}
