import { extname } from 'node:path'
import type { EntryPreview } from '../shared/api'

export const PREVIEW_MAX_BYTES = 2 * 1024 * 1024
export const binaryPreview: EntryPreview = { format: 'binary', value: '该文件是二进制文件，或超过 2 MiB 的预览上限。' }

const mimeByExtension: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
}
export const rasterMime = (path: string) => mimeByExtension[extname(path).toLowerCase()]
export const rasterPath = (path: string) => Boolean(rasterMime(path))
export const imageDataUrl = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString('base64')}`

export function previewBytes(path: string, bytes: Buffer | null): EntryPreview {
  if (!bytes) return binaryPreview
  const mime = rasterMime(path)
  if (mime) return { format: 'image', value: imageDataUrl(mime, bytes) }
  try {
    const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (!value.includes('\0')) return { format: 'text', value }
  } catch { /* Invalid UTF-8 is handled as binary. */ }
  return binaryPreview
}
