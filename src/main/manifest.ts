const invalid = () => new Error('AndroidManifest.xml 不是有效的 Android 二进制清单。')

type Pool = { offset: number; end: number; header: number }
function isManifestName(data: Buffer, pool: Pool, index: number) {
  const { offset, end, header } = pool
  const count = data.readUInt32LE(offset + 8)
  const strings = offset + data.readUInt32LE(offset + 20)
  const flags = data.readUInt32LE(offset + 16)
  if (index >= count || offset + header + count * 4 > strings || strings > end) return false
  const start = strings + data.readUInt32LE(offset + header + index * 4)
  if (start >= end) return false
  // Both code-unit and byte counts of the ASCII root name fit in one byte.
  if (flags & 0x100) return start + 11 <= end && data[start] === 8 && data[start + 1] === 8 &&
    data.toString('ascii', start + 2, start + 10) === 'manifest' && data[start + 10] === 0
  return start + 20 <= end && data.readUInt16LE(start) === 8 &&
    data.toString('utf16le', start + 2, start + 18) === 'manifest' && data.readUInt16LE(start + 18) === 0
}

export function validateBinaryManifest(data: Buffer) {
  if (data.length < 8 || data.readUInt16LE(0) !== 3 || data.readUInt16LE(2) !== 8 || data.readUInt32LE(4) !== data.length) throw invalid()
  let pool: Pool | undefined
  let root = false
  const stack: number[] = []
  for (let offset = 8; offset < data.length;) {
    if (offset + 8 > data.length) throw invalid()
    const type = data.readUInt16LE(offset)
    const header = data.readUInt16LE(offset + 2)
    const size = data.readUInt32LE(offset + 4)
    const end = offset + size
    if (header < 8 || size < header || size % 4 !== 0 || end > data.length) throw invalid()
    if (type === 1) {
      if (pool || header < 28) throw invalid()
      pool = { offset, end, header }
    } else if (type === 0x102 || type === 0x103) {
      if (!pool || header < 16 || size < header + (type === 0x102 ? 20 : 8)) throw invalid()
      const name = data.readUInt32LE(offset + header + 4)
      if (name >= data.readUInt32LE(pool.offset + 8)) throw invalid()
      if (type === 0x102) {
        if (!stack.length) {
          if (root || !isManifestName(data, pool, name)) throw invalid()
          root = true
        }
        if (stack.length >= 128) throw invalid()
        stack.push(name)
      } else if (stack.pop() !== name) throw invalid()
    }
    offset = end
  }
  if (!root || stack.length) throw invalid()
}
