import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { _electron as electron } from 'playwright-core'

test('desktop opens, imports a signed APK, renders Monaco, handles drops and remembers its workspace', { timeout: 90_000 }, async () => {
  const fixture = resolve(process.env.APKFLUX_TEST_APK || 'test-output/sample.apk')
  const input = await readFile(fixture)
  const sha = createHash('sha256').update(input).digest('hex')
  const dir = await mkdtemp(join(tmpdir(), 'apkflux-desktop-'))
  const profile = join(dir, 'profile')
  const legacyAi = join(profile, 'ai.json')
  let app
  const pageProblems = []
  const launch = async () => {
    app = await electron.launch({
      args: [...(process.env.APKFLUX_TEST_ELECTRON ? [] : ['.']), `--user-data-dir=${profile}`],
      ...(process.env.APKFLUX_TEST_ELECTRON ? { executablePath: process.env.APKFLUX_TEST_ELECTRON } : {}),
    })
    const page = await app.firstWindow()
    page.on('pageerror', (error) => pageProblems.push(error.message))
    page.on('console', (msg) => { if (msg.type() === 'error') pageProblems.push(msg.text()) })
    return page
  }
  try {
    await mkdir(profile)
    await writeFile(legacyAi, 'legacy settings fixture')
    let page = await launch()
    await page.getByRole('heading', { name: '打开你的第一个 APK' }).waitFor()
    assert.deepEqual(await page.evaluate(() => Object.keys(window.apkflux).filter(key => /ai$/i.test(key) || key === 'aiSettings')), [])
    if (process.env.APKFLUX_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.APKFLUX_SCREENSHOT_DIR, 'welcome.png') })
    const preferences = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences())
    assert.equal(preferences.contextIsolation, true)
    assert.equal(preferences.nodeIntegration, false)
    assert.equal(preferences.sandbox, true)

    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, fixture)
    await page.getByRole('button', { name: '导入 APK', exact: true }).click()
    await page.getByRole('heading', { name: 'ApkFlux Fixture' }).waitFor()
    const nav = page.getByRole('navigation', { name: '工作区导航' })
    assert.deepEqual((await nav.getByRole('button').allTextContents()).map(label => label.trim()), ['文件', 'APK 分析', '构建与签名'])
    const inspector = page.locator('#apk-inspector')
    await inspector.waitFor({ state: 'hidden' })
    await page.locator('#workbench-output').waitFor({ state: 'hidden' })
    await nav.getByRole('button', { name: '构建与签名' }).click()
    await page.getByRole('button', { name: '解码 Smali / 资源', exact: true }).waitFor()
    await nav.getByRole('button', { name: '文件', exact: true }).click()
    await page.getByRole('button', { name: 'APK 信息', exact: true }).click()
    await page.getByText('已验证', { exact: true }).waitFor()
    await page.locator('.app-avatar img').waitFor()
    assert.equal(await page.locator('.app-avatar img').evaluate((img) => img.naturalWidth), 32)
    await page.getByText(sha, { exact: true }).waitFor()
    await page.getByRole('button', { name: '复制 SHA-256' }).waitFor()
    assert.equal(await page.locator('.details dd').allTextContents().then((v) => v.slice(0, 5).join('|')), 'dev.apkflux.fixture|1.2.3|42|23|35')
    assert.match(await page.locator('.fingerprint code').first().textContent(), /^[a-f0-9]{64}$/)
    await page.getByText('证书 1 SHA-256', { exact: true }).waitFor()
    assert.equal(await page.getByText('DEX 数量', { exact: true }).locator('..').locator('dd').textContent(), '1')

    await page.getByPlaceholder('筛选文件路径').fill('notes.txt')
    await page.getByText('assets/notes.txt', { exact: true }).click()
    assert.equal(await page.locator('.editor-tab.is-active .file-source-badge').textContent(), '原始 APK')
    await page.locator('.monaco-editor:visible').waitFor()
    await page.getByText('This is a real file preview.', { exact: false }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'AI 辅助', exact: true }).count(), 0)
    if (process.env.APKFLUX_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.APKFLUX_SCREENSHOT_DIR, 'imported.png') })

    await page.getByRole('button', { name: '关闭 APK 信息' }).click()
    async function resize(width) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size, 700), width)
      await page.waitForFunction((size) => innerWidth === size, width)
    }
    await resize(960)
    await inspector.waitFor({ state: 'hidden' })
    const editorWidth = async () => (await page.locator('.center').boundingBox()).width
    const compactWidth = await editorWidth()
    assert.ok(compactWidth >= 690)
    if (process.env.APKFLUX_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.APKFLUX_SCREENSHOT_DIR, 'compact.png'), scale: 'css' })
    await page.getByRole('button', { name: 'APK 信息', exact: true }).click()
    await inspector.waitFor()
    assert.equal(await editorWidth(), compactWidth)
    await page.getByRole('button', { name: '关闭 APK 信息' }).click()
    await inspector.waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const updateState = await page.evaluate(() => window.apkflux.updateState())
    if (updateState.ok && updateState.data.status === 'unconfigured') {
      await app.evaluate(({ shell }) => {
        const original = shell.openExternal
        shell.openExternal = async (url) => {
          global.apkfluxTestReleaseUrl = url
          shell.openExternal = original
        }
      })
      await page.getByRole('button', { name: '查看 GitHub 发布', exact: true }).click()
      assert.equal(await app.evaluate(() => global.apkfluxTestReleaseUrl), 'https://github.com/wzebbin/ApkFlux/releases/latest')
    }
    await page.getByLabel('Language').selectOption('en')
    await page.getByRole('button', { name: 'Back to workbench', exact: true }).click()
    await page.getByRole('button', { name: 'Original APK view' }).waitFor()
    assert.equal(await page.locator('.source-switch button').evaluateAll(buttons => buttons.every(button => button.scrollWidth <= button.clientWidth)), true)
    await page.getByRole('button', { name: 'Preferences', exact: true }).click()
    await page.getByLabel('Language').selectOption('zh')
    await page.getByLabel('Theme').selectOption('light')
    await page.getByRole('button', { name: '返回工作台', exact: true }).click()
    await resize(1440)

    await page.getByRole('button', { name: '日志', exact: true }).click()
    await page.getByText('验证 APK 签名并读取证书指纹。', { exact: true }).waitFor()
    const cdp = await page.context().newCDPSession(page)
    async function drop(path) {
      const drag = { items: [], files: [path], dragOperationsMask: 1 }
      for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, x: 500, y: 175, data: drag })
    }
    const second = join(dir, 'same content.apk')
    await cp(fixture, second)
    await drop(second)
    await page.getByText('相同 SHA-256 的 APK 已存在，复用工作区。', { exact: true }).waitFor()
    const invalid = join(dir, 'invalid.apk')
    await writeFile(invalid, 'This is not an APK file. Invalid local archive.')
    await drop(invalid)
    await page.locator('.error-banner').waitFor()
    assert.match(await page.locator('.error-banner').textContent(), /ZIP|central directory/i)
    assert.deepEqual(await readFile(fixture), input)

    await app.close()
    page = await launch()
    await page.locator('html.light').waitFor({ state: 'attached' })
    assert.equal(await readFile(legacyAi, 'utf8'), 'legacy settings fixture')
    await page.getByRole('button', { name: /ApkFlux Fixture/ }).click()
    await page.getByRole('heading', { name: 'ApkFlux Fixture' }).waitFor()
    await page.getByRole('button', { name: 'APK 信息', exact: true }).click()
    await page.getByText(sha, { exact: true }).waitFor()
    const large = process.env.APKFLUX_TEST_LARGE_APK
    if (large) {
      const path = resolve(large)
      assert.ok((await stat(path)).size >= 100 * 1024 * 1024)
      const rendersWhileImporting = page.evaluate(() => new Promise((done) => {
        let running = false
        let renders = 0
        const track = () => {
          if (running) { renders++; requestAnimationFrame(track) }
        }
        const unsubscribe = window.apkflux.onTask((event) => {
          if (!running && event.status === 'running') { running = true; requestAnimationFrame(track) }
          else if (event.status !== 'running') { running = false; unsubscribe(); done(renders) }
        })
      }))
      await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, path)
      const started = performance.now()
      await page.getByRole('button', { name: '导入 APK', exact: true }).click()
      const frames = await rendersWhileImporting
      assert.ok(frames >= 3, 'renderer should continue drawing during a large import')
      await page.getByPlaceholder('筛选文件路径').fill('padding.bin')
      await page.getByText('assets/padding.bin', { exact: true }).waitFor()
      const importedMiB = ((await stat(path)).size / 2 ** 20).toFixed(1)
      console.log(`Large APK baseline: ${importedMiB} MiB, ${frames} rendered frames during import, ${Math.round(performance.now() - started)} ms to selectable file tree`)
    }
    assert.deepEqual(pageProblems, [])
  } finally {
    if (app) await app.close().catch(() => {})
    await rm(dir, { recursive: true, force: true })
  }
})
