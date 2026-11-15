import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, readFile, rm, stat, utimes } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { _electron as electron } from 'playwright-core'

async function digest(path) {
  const hash = createHash('sha256')
  for await (const data of createReadStream(path)) hash.update(data)
  return hash.digest('hex')
}

async function runDesktop(operation) {
  const profile = await mkdtemp(join(tmpdir(), 'apkflux-v1-desktop-'))
  const executablePath = process.env.APKFLUX_TEST_ELECTRON
  let app
  try {
    async function launch() {
      app = await electron.launch({ args: [...(executablePath ? [] : ['.']), `--user-data-dir=${profile}`], ...(executablePath ? { executablePath } : {}) })
      const page = await app.firstWindow()
      page.setDefaultTimeout(20000)
      return page
    }
    async function choose(path) {
      await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, path)
    }
    await operation({ profile, launch, choose, close: () => app.close() })
  } finally {
    await app?.close().catch(() => {})
    await rm(profile, { recursive: true, force: true })
  }
}

const button = (page, name) => page.getByRole('button', { name, exact: true })
const currentCode = page => page.locator('.file-editor:visible .monaco-editor .view-lines')

test('256 MiB APK and repeated 24-tab editing sessions on a packaged app', { timeout: 240_000 }, async () => {
  const fixture = resolve(process.env.APKFLUX_TEST_STRESS_APK || 'test-output/v1-stress.apk')
  const size = (await stat(fixture)).size
  assert.ok(size >= 256 * 2 ** 20)
  const original = await digest(fixture)
  await runDesktop(async ({ launch, choose, profile }) => {
    const page = await launch()
    await choose(fixture)
    const frames = page.evaluate(() => new Promise(resolve => {
      let count = 0
      let active = false
      const draw = () => { if (active) { count++; requestAnimationFrame(draw) } }
      const unsubscribe = window.apkflux.onTask(event => {
        if (event.status === 'running' && !active) { active = true; requestAnimationFrame(draw) }
        if (event.status !== 'running') { active = false; unsubscribe(); resolve(count) }
      })
    }))
    const started = performance.now()
    await button(page, '导入 APK').click()
    const filter = page.getByPlaceholder('筛选文件路径')
    await filter.waitFor()
    const imported = Math.round(performance.now() - started)
    const drawn = await frames
    assert.ok(drawn >= 3)
    const cdp = await page.context().newCDPSession(page)
    const heaps = []
    const switches = []
    for (let round = 0; round < 4; round++) {
      const first = (round % 2) * 24
      for (let index = first; index < first + 24; index++) {
        const path = `assets/stress/file-${index}.txt`
        await filter.fill(path)
        await page.locator('.tree-box').getByText(path, { exact: true }).click()
        await currentCode(page).filter({ hasText: `File ${index} · line 0` }).waitFor()
      }
      assert.equal(await page.locator('.tab-strip .editor-tab').count(), 24)
      for (const index of [first, first + 12, first + 23, first + 1, first + 18, first + 4]) {
        const start = performance.now()
        await page.locator('.tab-select').filter({ has: page.getByText(`file-${index}.txt`, { exact: true }) }).click()
        await currentCode(page).filter({ hasText: `File ${index} · line 0` }).waitFor()
        switches.push(performance.now() - start)
      }
      for (let n = 0; n < 24; n++) await button(page, '关闭文件').click()
      assert.equal(await page.locator('.file-editor').count(), 0)
      await cdp.send('HeapProfiler.collectGarbage')
      heaps.push((await cdp.send('Runtime.getHeapUsage')).usedSize / 2 ** 20)
    }
    switches.sort((a, b) => a - b)
    const p95 = switches[Math.ceil(switches.length * .95) - 1]
    assert.ok(p95 < 1500)
    assert.ok(heaps.at(-1) - heaps[1] < 20, 'heap growth after warm-up should stay below 20 MiB')
    assert.equal(await digest(join(profile, 'workspaces', original, 'source.apk')), original)
    console.log(JSON.stringify({ apkMiB: +(size / 2 ** 20).toFixed(2), importMs: imported, frames: drawn,
      tabRounds: 4, tabsPerRound: 24, switchP95Ms: Math.round(p95), reclaimedJsHeapMiB: heaps.map(value => +value.toFixed(2)) }))
  })
  assert.equal(await digest(fixture), original)
})

test('startup expires stale Java while the original APK and saved Android edits remain identical', { timeout: 120_000 }, async () => {
  const apk = resolve('test-output/sample.apk')
  const id = await digest(apk)
  await runDesktop(async ({ profile, launch, choose, close }) => {
    const cache = join(profile, 'decompiled-v1', id)
    const source = join(profile, 'workspaces', id, 'source.apk')
    const edit = join(cache, 'edits', createHash('sha256').update('AndroidManifest.xml').digest('hex') + '.json')
    let page = await launch()
    await choose(apk)
    await button(page, '导入 APK').click()
    await button(page, '反编译 Java 视图').click()
    await button(page, '开始反编译').click()
    await page.getByPlaceholder('筛选文件路径').waitFor({ timeout: 45000 })
    await button(page, 'Smali / 资源 视图').click()
    await button(page, '开始解码').click()
    await page.getByPlaceholder('筛选文件路径').waitFor({ timeout: 45000 })
    await button(page, '查看清单').click()
    await currentCode(page).filter({ hasText: '<manifest' }).waitFor()
    await page.locator('.file-editor:visible .view-line').first().click()
    await page.keyboard.press('Meta+ArrowUp')
    await page.keyboard.press('Meta+ArrowRight')
    await page.keyboard.insertText('\n<!-- CACHE_PRESERVES_SAVED_EDIT -->')
    await button(page, '保存文件').click()
    await page.locator('.tab-hint').getByText('已保存', { exact: true }).waitFor()
    const saved = await readFile(edit)
    assert.equal(await digest(source), id)
    await close()

    const old = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000)
    for (const engine of ['java', 'android']) await utimes(join(cache, engine, 'index.json'), old, old)
    page = await launch()
    await page.locator('.history-list button').first().click()
    await button(page, '查看清单').click()
    await currentCode(page).filter({ hasText: 'CACHE_PRESERVES_SAVED_EDIT' }).waitFor()
    await assert.rejects(stat(join(cache, 'java')), { code: 'ENOENT' })
    assert.ok((await stat(join(cache, 'android', 'index.json'))).isFile())
    assert.equal(await digest(source), id)
    assert.deepEqual(await readFile(edit), saved)
    await button(page, '反编译 Java 视图').click()
    await button(page, '开始反编译').click()
    await page.getByPlaceholder('筛选文件路径').waitFor({ timeout: 45000 })
    assert.ok((await stat(join(cache, 'java', 'index.json'))).isFile())
    assert.deepEqual(await readFile(edit), saved)
    console.log('Stale Java removed and regenerated; edited Android cache retained; original, snapshot and saved edit verified.')
  })
  assert.equal(await digest(apk), id)
})
