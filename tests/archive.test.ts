import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { deflateRawSync } from 'node:zlib'
import crc32 from 'crc-32'
import { parseBadging, parseSignature } from '../src/main/metadata'
import { ImportTasks } from '../src/main/tasks'
import { Workspaces } from '../src/main/workspaces'
import { inspectArchive, previewEntry, validateEntryPath } from '../src/main/zip'
import type { TaskEvent } from '../src/shared/api'

function minimalManifest() {
  const xml = Buffer.alloc(8 + 44 + 36 + 24)
  const chunk = (offset: number, kind: number, header: number, size: number) => {
    xml.writeUInt16LE(kind, offset)
    xml.writeUInt16LE(header, offset + 2)
    xml.writeUInt32LE(size, offset + 4)
  }
  chunk(0, 3, 8, xml.length)
  chunk(8, 1, 28, 44)
  xml.writeUInt32LE(1, 16)
  xml.writeUInt32LE(0x100, 24)
  xml.writeUInt32LE(32, 28)
  Buffer.from([8, 8, ...Buffer.from('manifest'), 0]).copy(xml, 40)
  chunk(52, 0x102, 16, 36)
  chunk(88, 0x103, 16, 24)
  return xml
}

type ZipInput = { name: string; data: Buffer; deflate?: boolean; crc?: number }
const manifest = { name: 'AndroidManifest.xml', data: minimalManifest() }
function zip(entries: ZipInput[]) {
  const locals: Buffer[] = []
  const directory: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const raw = entry.deflate ? deflateRawSync(entry.data) : entry.data
    const checksum = entry.crc ?? crc32.buf(entry.data) >>> 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(entry.deflate ? 8 : 0, 8)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(raw.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, raw)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50)
    local.copy(central, 6, 4, 30)
    central.writeUInt32LE(offset, 42)
    directory.push(central, name)
    offset += local.length + name.length + raw.length
  }
  const central = Buffer.concat(directory)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, central, end])
}
async function temp<T>(act: (dir: string) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), 'apkflux-test-'))
  try { return await act(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}

test('indexes compressed ZIP resources, counts multidex and lists ABIs', async () => temp(async (dir) => {
  const file = join(dir, 'sample.apk')
  const names = ['classes.dex', 'classes2.dex', 'classes10.dex', 'lib/arm64-v8a/libsample.so']
  await writeFile(file, zip([manifest, ...names.map((name) => ({ name, data: Buffer.from([0, 1]) })),
    { name: 'assets/note.txt', data: Buffer.from('real local content'), deflate: true }]))
  const result = await inspectArchive(file)
  assert.equal(result.dexCount, 3)
  assert.deepEqual(result.architectures, ['arm64-v8a'])
  const note = result.entries.find((entry) => entry.path === 'assets/note.txt')!
  assert.deepEqual(await previewEntry(file, note), { format: 'text', value: 'real local content' })
}))

test('rejects invalid paths, archives without a manifest and damaged CRC', async () => temp(async (dir) => {
  for (const path of ['/x', 'a\\b', 'folder/../relative', 'NUL.txt', 'a/c:alternate', 'a/ending.']) {
    assert.throws(() => validateEntryPath(path), /不安全/)
  }
  const file = join(dir, 'sample.apk')
  await writeFile(file, zip([]))
  await assert.rejects(inspectArchive(file), /未找到 AndroidManifest/)
  await writeFile(file, zip([{ ...manifest, data: manifest.data.subarray(0, 8) }]))
  await assert.rejects(inspectArchive(file), /二进制清单/)
  await writeFile(file, zip([manifest, { name: 'assets/file.txt', data: Buffer.from('bad CRC'), crc: 1 }]))
  await assert.rejects(inspectArchive(file), /校验失败/)
}))

test('preserves case-sensitive ZIP paths and rejects exact duplicates and file-directory conflicts', async () => temp(async (dir) => {
  const file = join(dir, 'sample.apk')
  const resources = [
    { name: 'assets/Readme.txt', data: Buffer.from('upper') },
    { name: 'assets/readme.txt', data: Buffer.from('lower') },
    { name: 'Assets/readme.txt', data: Buffer.from('upper directory') },
  ]
  await writeFile(file, zip([manifest, ...resources]))
  const { entries } = await inspectArchive(file)
  for (const resource of resources) {
    const entry = entries.find((candidate) => candidate.path === resource.name)
    assert.ok(entry)
    assert.deepEqual(await previewEntry(file, entry), { format: 'text', value: resource.data.toString() })
  }
  const fileAndChild = { name: 'assets', data: Buffer.alloc(0) }
  for (const conflicting of [[resources[0], resources[0]], [fileAndChild, resources[0]], [resources[0], fileAndChild]]) {
    await writeFile(file, zip([manifest, ...conflicting]))
    await assert.rejects(inspectArchive(file), /冲突/)
  }
}))

test('parses old and current Android SDK outputs without assuming unsigned means missing tools', () => {
  const output = "package: name='dev.apkflux.fixture' versionCode='42' versionName='1.2.3'\n"
    + "sdkVersion:'23'\ntargetSdkVersion:'35'\napplication-label:'Test App'\n"
    + "application-icon-240:'res/drawable/adaptive.xml'\napplication-icon-160:'res/drawable/icon.png'\n"
  const { metadata, iconPaths } = parseBadging(output)
  assert.deepEqual(metadata, { packageName: 'dev.apkflux.fixture', label: 'Test App', versionCode: '42', versionName: '1.2.3', minSdk: '23', targetSdk: '35' })
  assert.equal(parseBadging(output.replace('sdkVersion:', 'minSdkVersion:')).metadata.minSdk, '23')
  assert.deepEqual(iconPaths, ['res/drawable/icon.png'])
  const fp = 'a'.repeat(64)
  const signed = `Verified using v3 scheme (APK Signature Scheme v3): true\nV3.0 Signer: certificate SHA-256 digest: ${fp}`
  assert.deepEqual(parseSignature(0, signed), { status: 'verified', schemes: ['v3'], fingerprints: [fp] })
  assert.equal(parseSignature(0, signed.replace('V3.0 Signer:', 'Signer #1')).fingerprints[0], fp)
  assert.equal(parseSignature(1, 'DOES NOT VERIFY').status, 'unverified')
  assert.equal(parseSignature(1, 'java not running').status, 'unavailable')
})

test('workspace retains its own snapshot, leaves source intact and cleans cancelled imports', async () => temp(async (dir) => {
  const file = join(dir, 'sample.apk')
  const bytes = zip([manifest])
  await writeFile(file, bytes)
  const root = join(dir, 'workspaces')
  const tools = { run: async () => null }
  const workspaces = new Workspaces(root, tools)
  await workspaces.init()
  const events: TaskEvent[] = []
  const tasks = new ImportTasks((event) => events.push(event))
  await assert.rejects(tasks.run('cancelled.apk', (task) => {
    tasks.cancel()
    return workspaces.import(file, task)
  }))
  assert.equal(events.at(-1)?.status, 'cancelled')
  assert.deepEqual(await readdir(root), [])
  const record = await tasks.run('sample.apk', (task) => workspaces.import(file, task))
  assert.equal(record.id, createHash('sha256').update(bytes).digest('hex'))
  assert.equal(record.signature.status, 'unavailable')
  assert.deepEqual(await readFile(file), bytes)
  assert.deepEqual(await readFile(join(root, record.id, 'source.apk')), bytes)
  assert.equal(events.at(-1)?.status, 'done')
  await rm(file)
  const restarted = new Workspaces(root, tools)
  await restarted.init()
  assert.equal(restarted.recent()[0]?.id, record.id)
  assert.equal((await restarted.open(record.id)).entries[0]?.path, 'AndroidManifest.xml')
}))
