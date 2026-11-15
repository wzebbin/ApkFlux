import { lstat, readdir, rm, utimes } from 'node:fs/promises'
import { join } from 'node:path'

const day = 24 * 60 * 60 * 1000
const hashName = /^[0-9a-f]{64}$/
const engineVersion = /^\d+(?:\.\d+)+$/

async function children(path: string) {
  try {
    if (!(await lstat(path)).isDirectory()) return []
    return await readdir(path, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function isExpired(path: string, cutoff: number) {
  try {
    const record = await lstat(path)
    return record.isFile() && record.mtimeMs < cutoff
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function hasEdits(folder: string) {
  const path = join(folder, 'edits')
  try {
    if (!(await lstat(path)).isDirectory()) return true
    return (await readdir(path)).length > 0
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export async function markCacheUsed(path: string) {
  // Refresh at most daily. A cache with an unwritable timestamp remains usable.
  try {
    const now = new Date()
    if (await isExpired(path, now.getTime() - day)) await utimes(path, now, now)
  } catch { /* access tracking is optional */ }
}

export async function pruneDecodedCaches(root: string, now = Date.now()) {
  const cutoff = now - 30 * day
  for (const project of await children(root)) {
    if (!project.isDirectory() || !hashName.test(project.name)) continue
    const folder = join(root, project.name)
    for (const item of await children(folder)) {
      const path = join(folder, item.name)
      if (item.name === 'manifest-preview.xml' && item.isFile() && await isExpired(path, cutoff)) {
        await rm(path, { force: true })
      }
      if (!item.isDirectory() || (item.name !== 'java' && item.name !== 'android')) continue
      if (item.name === 'android' && await hasEdits(folder)) continue
      if (await isExpired(join(path, 'index.json'), cutoff)) await rm(path, { recursive: true, force: true })
    }
  }
}

export async function pruneNativeCaches(root: string, now = Date.now()) {
  const cutoff = now - 30 * day
  for (const project of await children(root)) {
    if (!project.isDirectory() || !hashName.test(project.name)) continue
    const folder = join(root, project.name)
    for (const library of await children(folder)) {
      if (!library.isDirectory() || !hashName.test(library.name)) continue
      const libraryDir = join(folder, library.name)
      for (const version of await children(libraryDir)) {
        if (!version.isDirectory() || !engineVersion.test(version.name)) continue
        const cache = join(libraryDir, version.name)
        if (await isExpired(join(cache, 'index.json'), cutoff)) await rm(cache, { recursive: true, force: true })
      }
    }
  }
}
