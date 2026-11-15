import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AnalysisReport } from '../src/shared/api'
import { analyzeElf, fileChanges, renderReport } from '../src/main/analysis'

test('compares file contents by exact path and distinguishes new, removed and modified entries', () => {
  const before = new Map([['A.txt', 'one'], ['both.txt', 'old'], ['same.txt', 'same']])
  const after = new Map([['a.txt', 'new'], ['both.txt', 'new'], ['same.txt', 'same']])
  assert.deepEqual(fileChanges(before, after, 'archive'), [
    { path: 'A.txt', kind: 'removed', scope: 'archive' },
    { path: 'a.txt', kind: 'added', scope: 'archive' },
    { path: 'both.txt', kind: 'modified', scope: 'archive' },
  ])
})

test('reads an ELF64 AArch64 export and handles a truncated symbol section', () => {
  const bytes = Buffer.alloc(350)
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(bytes)
  bytes.writeUInt16LE(183, 18)
  bytes.writeBigUInt64LE(64n, 40)
  bytes.writeUInt16LE(64, 58)
  bytes.writeUInt16LE(3, 60)
  bytes.writeUInt32LE(11, 132)
  bytes.writeBigUInt64LE(256n, 152)
  bytes.writeBigUInt64LE(24n, 160)
  bytes.writeUInt32LE(2, 168)
  bytes.writeBigUInt64LE(24n, 184)
  bytes.writeUInt32LE(3, 196)
  bytes.writeBigUInt64LE(280n, 216)
  bytes.writeBigUInt64LE(20n, 224)
  bytes.writeUInt32LE(1, 256)
  bytes[260] = 0x12
  bytes.writeUInt16LE(1, 262)
  bytes.write('public_symbol', 281)
  const path = 'lib/arm64-v8a/libsample.so'
  assert.deepEqual(analyzeElf(path, bytes).exports, ['public_symbol'])
  assert.equal(analyzeElf(path, bytes).architecture, 'AArch64')
  assert.deepEqual(analyzeElf(path, bytes.subarray(0, 277)).exports, [])
})

test('escapes HTML markup and protects CSV formula cells when exporting APK-derived strings', () => {
  const report: AnalysisReport = {
    baseline: null, changes: [], permissionChanges: null, sdkChanges: null, notes: [],
    current: { id: 'x', name: '=1+1', permissions: null, warnings: [], sdks: [], libraries: [],
      addresses: [{ value: '<script>alert(1)</script>', kind: 'path', path: 'file' }] },
  }
  const html = renderReport(report, 'html')
  assert.ok(html.includes('&lt;script&gt;'))
  assert.doesNotMatch(html, /<script>/)
  assert.match(renderReport(report, 'csv'), /"'=1\+1"/)
  assert.deepEqual(JSON.parse(renderReport(report, 'json')), report)
})
