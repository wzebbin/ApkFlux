import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { markCacheUsed, pruneDecodedCaches, pruneNativeCaches } from '../src/main/cache'

test('expires only regenerable caches and protects saved edits, recent caches and symlinks', async () => {
  const base = await mkdtemp(join(tmpdir(), 'apkflux-cache-test-'))
  const day = 24 * 60 * 60 * 1000
  const now = Date.now()
  const stale = new Date(now - 35 * day)
  const dirty = 'a'.repeat(64)
  const clean = 'b'.repeat(64)
  const decoded = join(base, 'decoded')
  const native = join(base, 'native')
  const saved = join(decoded, dirty, 'edits', 'edit.json')
  const original = join(base, 'source.apk')
  const recent = join(decoded, clean, 'java', 'index.json')
  const outside = join(base, 'outside', 'index.json')
  const remove = [
    join(decoded, dirty, 'java', 'index.json'),
    join(decoded, clean, 'android', 'index.json'),
    join(decoded, clean, 'manifest-preview.xml'),
    join(native, dirty, 'c'.repeat(64), '12.2', 'index.json'),
  ]
  const keep = [saved, original, recent, outside, join(decoded, dirty, 'android', 'index.json'),
    join(native, 'ghidra-home', 'preferences'), join(native, dirty, 'c'.repeat(64), 'notes', 'index.json')]
  try {
    for (const path of [...remove, ...keep]) {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, path)
      await utimes(path, stale, stale)
    }
    await symlink(dirname(outside), join(decoded, 'd'.repeat(64)), 'dir')
    await markCacheUsed(recent)
    await pruneDecodedCaches(decoded, now)
    await pruneNativeCaches(native, now)
    for (const path of remove) await assert.rejects(stat(path), { code: 'ENOENT' })
    for (const path of keep) assert.equal(await readFile(path, 'utf8'), path)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
