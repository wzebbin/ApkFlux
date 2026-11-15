import yauzl, { type Entry, type ZipFile } from 'yauzl'
import crc32 from 'crc-32'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import type { Readable } from 'node:stream'
import type { ApkEntry, EntryPreview } from '../shared/api'
import { isNativeLibrary, NATIVE_MAX_BYTES } from '../shared/native-library'
import { validateBinaryManifest } from './manifest'
import { binaryPreview, PREVIEW_MAX_BYTES, previewBytes } from './preview'

const MiB = 1024 * 1024
export const APK_MAX_BYTES = 1024 * MiB
const limits = { entries: 60_000, total: 4096 * MiB, individual: 512 * MiB, ratio: 1500 }
const manifestMax = 16 * MiB

export function validateEntryPath(name: string) {
  const parts = name.replace(/\/$/, '').split('/')
  if (name.length > 1024 || parts.length > 64 || parts.some((p) =>
    !p || p === '.' || p === '..' || p.length > 255 || /[\\:*?"<>|]/.test(p) ||
    [...p].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    /[. ]$/.test(p) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(p)
  )) throw new Error('APK 包含不安全的 ZIP 路径。')
}

const openZip = (path: string) => new Promise<ZipFile>((resolve, reject) => {
  yauzl.open(path, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true },
    (err, zip) => err || !zip ? reject(err ?? new Error('无法打开 ZIP。')) : resolve(zip))
})
// yauzl 3.4 exposes these fields; the v2 type declarations do not.
type LocalHeader = { fileName: Buffer; generalPurposeBitFlag: number; compressionMethod: number; fileDataStart: number }
type LocalZip = ZipFile & { readLocalFileHeader(entry: Entry, callback: (error: Error | null, header: LocalHeader) => void): void }
const readHeader = (zip: ZipFile, entry: Entry) => new Promise<LocalHeader>((resolve, reject) =>
  (zip as LocalZip).readLocalFileHeader(entry, (error, header) => error ? reject(error) : resolve(header)))

const openStream = (zip: ZipFile, entry: Entry) => new Promise<Readable>((resolve, reject) => {
  zip.openReadStream(entry, (err, stream) => err || !stream ? reject(err ?? new Error('无法读取 ZIP 条目。')) : resolve(stream))
})

async function visit(path: string, signal: AbortSignal | undefined, callback: (zip: ZipFile, entry: Entry) => Promise<boolean | void>) {
  signal?.throwIfAborted()
  const zip = await openZip(path)
  try {
    if (zip.entryCount > limits.entries) throw new Error('APK 内的文件数量超过限制。')
    signal?.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      zip.once('end', resolve)
      zip.on('error', reject)
      zip.on('entry', (entry: Entry) => {
        void (async () => {
          signal?.throwIfAborted()
          const stop = await callback(zip, entry)
          signal?.throwIfAborted()
          if (stop) resolve()
          else zip.readEntry()
        })().catch(reject)
      })
      zip.readEntry()
    })
  } finally {
    const closed = once(zip, 'close')
    zip.close()
    await closed
  }
}

async function readEntry(zip: ZipFile, entry: Entry, signal?: AbortSignal, keep = false) {
  signal?.throwIfAborted()
  const stream = await openStream(zip, entry)
  const abort = () => stream.destroy(new Error('读取已取消。'))
  signal?.addEventListener('abort', abort, { once: true })
  let bytes = 0
  let crc = 0
  const chunks: Buffer[] = []
  try {
    if (signal?.aborted) abort()
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      bytes += chunk.length
      if (bytes > entry.uncompressedSize) throw new Error('ZIP 条目超过声明的解压大小。')
      crc = crc32.buf(chunk, crc)
      if (keep) chunks.push(chunk)
    }
    if (bytes !== entry.uncompressedSize || (crc >>> 0) !== entry.crc32) throw new Error('APK 中的 ZIP 条目校验失败。')
    return keep ? Buffer.concat(chunks, bytes) : undefined
  } finally {
    signal?.removeEventListener('abort', abort)
    stream.destroy()
  }
}

export async function inspectArchive(path: string, signal?: AbortSignal) {
  const entries: ApkEntry[] = []
  // Archive entries are indexed and previewed by their exact names. Any
  // future extraction must check for collisions on the destination filesystem.
  const names = new Map<string, 'file' | 'implicit' | 'directory'>()
  const architectures = new Set<string>()
  let dexCount = 0
  let total = 0
  let nameBudget = 0
  const spans: { start: number; end: number }[] = []
  let manifest = false
  await visit(path, signal, async (zip, entry) => {
    const name = entry.fileName
    validateEntryPath(name)
    const directory = name.endsWith('/')
    const header = await readHeader(zip, entry)
    if (!header.fileName.equals((entry as Entry & { fileNameRaw: Buffer }).fileNameRaw) ||
        header.generalPurposeBitFlag !== entry.generalPurposeBitFlag || header.compressionMethod !== entry.compressionMethod) {
      throw new Error('ZIP 的局部文件头与中央目录不一致。')
    }
    spans.push({ start: entry.relativeOffsetOfLocalHeader, end: header.fileDataStart + entry.compressedSize })
    const parts = (directory ? name.slice(0, -1) : name).split('/')
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/')
      const kind = i < parts.length ? 'implicit' : directory ? 'directory' : 'file'
      const seen = names.get(prefix)
      if (seen && (seen === 'file' || kind === 'file' || (seen === 'directory' && kind === 'directory'))) {
        throw new Error('APK 中有重复或冲突的 ZIP 路径。')
      }
      if (!seen) {
        nameBudget += Buffer.byteLength(prefix)
        if (nameBudget > 16 * MiB) throw new Error('APK 的文件路径索引超过安全限制。')
      }
      if (!seen || seen === 'implicit') names.set(prefix, kind)
    }
    const mode = (entry.externalFileAttributes >>> 16) & 0xf000
    if ((mode !== 0 && mode !== (directory ? 0x4000 : 0x8000)) ||
        (entry.generalPurposeBitFlag & 1) || ![0, 8].includes(entry.compressionMethod)) {
      throw new Error('APK 中包含特殊、加密或不支持的 ZIP 条目。')
    }
    total += entry.uncompressedSize
    if (total > limits.total || entry.uncompressedSize > limits.individual ||
        (entry.uncompressedSize > MiB && entry.uncompressedSize / Math.max(1, entry.compressedSize) > limits.ratio)) {
      throw new Error('APK 解压大小或压缩比超过安全限制。')
    }
    if (directory) {
      if (entry.uncompressedSize !== 0) throw new Error('ZIP 目录条目包含数据。')
      return
    }
    const isManifest = name === 'AndroidManifest.xml'
    if (isManifest && (entry.uncompressedSize < 8 || entry.uncompressedSize > manifestMax)) throw new Error('APK 的清单大小无效。')
    const data = await readEntry(zip, entry, signal, isManifest)
    if (data) {
      validateBinaryManifest(data)
      manifest = true
    }
    if (/^classes(?:[2-9]|[1-9][0-9]+)?\.dex$/.test(name)) dexCount++
    const abi = /^lib\/([\w-]+)\/[^/]+\.so$/.exec(name)
    if (abi) architectures.add(abi[1])
    entries.push({ path: name, bytes: entry.uncompressedSize, packedBytes: entry.compressedSize })
  })
  spans.sort((a, b) => a.start - b.start)
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].start < spans[i - 1].end) throw new Error('APK 的 ZIP 条目相互重叠。')
  }
  if (!manifest) throw new Error('未找到 AndroidManifest.xml；该文件不是 APK。')
  entries.sort((a, b) => a.path.localeCompare(b.path, 'en'))
  return { entries, dexCount, architectures: [...architectures].sort() }
}


export async function scanArchive(path: string, signal: AbortSignal, sample: (name: string, size: number) => number,
    publish: (name: string, digest: string, bytes: Buffer) => void) {
  await visit(path, signal, async (zip, entry) => {
    if (entry.fileName.endsWith('/')) return
    const digest = createHash('sha256')
    const limit = sample(entry.fileName, entry.uncompressedSize)
    const buffers: Buffer[] = []
    let retained = 0
    const stream = await openStream(zip, entry)
    const abort = () => stream.destroy(new Error('APK 分析已取消。'))
    signal.addEventListener('abort', abort, { once: true })
    try {
      if (signal.aborted) abort()
      for await (const data of stream as AsyncIterable<Buffer>) {
        digest.update(data)
        if (retained < limit) {
          const prefix = data.subarray(0, limit - retained)
          retained += prefix.length
          buffers.push(prefix)
        }
      }
      publish(entry.fileName, digest.digest('hex'), Buffer.concat(buffers, retained))
    } finally {
      signal.removeEventListener('abort', abort)
      stream.destroy()
    }
  })
}

async function readValidatedEntry(archive: string, target: ApkEntry, signal: AbortSignal) {
  let data: Buffer | undefined
  await visit(archive, signal, async (zip, entry) => {
    if (entry.fileName !== target.path) return
    if (entry.uncompressedSize !== target.bytes) throw new Error('工作区中的 APK 快照已改变。')
    data = await readEntry(zip, entry, signal, true)
    return true
  })
  if (!data) throw new Error('APK 中找不到该条目。')
  return data
}

export async function previewEntry(archive: string, target: ApkEntry): Promise<EntryPreview> {
  if (target.bytes > PREVIEW_MAX_BYTES) return binaryPreview
  return previewBytes(target.path, await readValidatedEntry(archive, target, AbortSignal.timeout(10_000)))
}

export async function readNativeLibrary(archive: string, target: ApkEntry, signal: AbortSignal) {
  if (!isNativeLibrary(target.path) || target.bytes > NATIVE_MAX_BYTES) throw new Error('请选择 APK 内不超过 64 MiB 的 SO 文件。')
  const data = await readValidatedEntry(archive, target, signal)
  if (data.length < 52 || data.readUInt32BE(0) !== 0x7f454c46) throw new Error('所选 SO 不是可识别的 ELF 文件。')
  return data
}
