import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { _electron as electron } from 'playwright-core'

const external = Boolean(process.env.APKFLUX_TEST_APK)
const fixture = resolve(process.env.APKFLUX_TEST_APK || 'test-output/sample.apk')
const javaPath = process.env.APKFLUX_TEST_JAVA_PATH || 'dev/apkflux/fixture/Fixture.java'
const smaliPath = process.env.APKFLUX_TEST_SMALI_PATH || 'smali/dev/apkflux/fixture/Fixture.smali'
const resourcePath = process.env.APKFLUX_TEST_RESOURCE_PATH
const interesting = process.env.APKFLUX_TEST_CLASS || 'Fixture'
const manifestPackage = process.env.APKFLUX_TEST_PACKAGE || 'dev.apkflux.fixture'

test('decodes Java, Smali and manifest into the desktop editor, then reopens the cached results', { timeout: 180_000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'apkflux-decoding-desktop-'))
  const profile = join(temp, 'profile')
  const exportDir = join(temp, 'export')
  await mkdir(exportDir)
  let app
  const problems = []
  async function launch() {
    const executablePath = process.env.APKFLUX_TEST_ELECTRON
    app = await electron.launch({
      args: [...(executablePath ? [] : ['.']), `--user-data-dir=${profile}`],
      ...(executablePath ? { executablePath } : {}),
    })
    const page = await app.firstWindow()
    page.on('pageerror', (error) => problems.push(error.message))
    return page
  }
  async function choose(path) {
    await app.evaluate(({ dialog }, value) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [value] })
    }, path)
  }
  async function verifyPreview(page, pattern) {
    const editor = page.locator('.monaco-editor:visible .view-lines')
    await editor.waitFor()
    await page.waitForFunction((regex) => {
      const text = document.querySelector('.file-editor:not([style*="display: none"]) .monaco-editor .view-lines')?.textContent || ''
      return new RegExp(regex).test(text.replaceAll('\u00a0', ' '))
    }, pattern.source)
  }
  async function viewPath(page, path, pattern) {
    await page.getByPlaceholder('筛选文件路径').fill(path)
    await page.locator('.tree-box').getByText(path, { exact: true }).click()
    await verifyPreview(page, pattern)
    const located = page.locator('.tree-box .tree-active')
    await located.waitFor()
    assert.equal(await located.getAttribute('title'), path)
    assert.equal(await page.getByPlaceholder('筛选文件路径').inputValue(), '')
  }
  try {
    let page = await launch()
    for (const [tool, path] of [['jadx', process.env.APKFLUX_TEST_JADX], ['apktool', process.env.APKFLUX_TEST_APKTOOL]]) {
      if (!path) continue
      await choose(resolve(path))
      await page.getByRole('button', { name: '设置', exact: true }).click()
      const tools = page.getByRole('button', { name: '外部工具' })
      if (await tools.getAttribute('aria-expanded') === 'false') await tools.click()
      await page.locator('.tool-item').filter({ has: page.getByText(tool, { exact: true }) }).getByRole('button', { name: '选择路径' }).click()
      await page.locator('.tool-item').filter({ has: page.getByText(tool, { exact: true }) }).getByText(/手动配置/).waitFor()
      await page.getByRole('button', { name: '返回工作台', exact: true }).click()
    }
    await choose(fixture)
    await page.getByRole('button', { name: '导入 APK', exact: true }).click()
    const globalSearch = page.getByRole('button', { name: '全局搜索', exact: true })
    const globalQuery = page.getByRole('textbox', { name: '搜索整个 APK 工作区', exact: true })
    await globalSearch.click()
    await globalQuery.fill('AndroidManifest.xml')
    await globalQuery.press('Enter')
    await page.getByText(/尚未生成，未参与搜索/).waitFor()
    await page.locator('.source-results button').filter({ hasText: '原始 APK · AndroidManifest.xml' }).first().click()
    await verifyPreview(page, /<manifest\b/)
    await page.getByRole('button', { name: '反编译 Java 视图', exact: true }).click()
    const startJava = page.getByRole('button', { name: '开始反编译', exact: true })
    if (process.env.APKFLUX_TEST_CANCEL === '1') {
      await page.getByRole('button', { name: '日志', exact: true }).click()
      await startJava.click()
      await page.locator('.log-line').filter({ hasText: 'loading ...' }).waitFor()
      await page.getByRole('button', { name: '取消反编译', exact: true }).click()
      await page.locator('.source-empty').getByText('反编译已取消。', { exact: true }).waitFor()
      assert.equal(await page.getByPlaceholder('筛选文件路径').count(), 0)
      assert.equal((await readdir(join(profile, 'decompiled-v1'))).some(name => name.startsWith('.decode-')), false)
    }
    await startJava.click()
    await page.getByPlaceholder('筛选文件路径').waitFor({ timeout: 100_000 })
    await viewPath(page, javaPath, /package\s/)
    assert.equal(await page.locator('.editor-tab.is-active .file-source-badge').textContent(), '反编译 Java')
    if (javaPath.includes('/')) {
      await page.getByRole('button', { name: '折叠全部', exact: true }).click()
      await page.locator('.tree-box .tree-active').waitFor({ state: 'hidden' })
      await page.getByRole('button', { name: '展开全部', exact: true }).click()
      await page.locator('.tree-box .tree-active').waitFor()
    }
    await page.getByRole('button', { name: '原始 APK 视图', exact: true }).click()
    assert.equal(await page.locator('.editor-tab.is-active .file-source-badge').textContent(), '反编译 Java')
    await page.getByRole('button', { name: '反编译 Java 视图', exact: true }).click()
    if (external && process.env.APKFLUX_TEST_PARTIAL === '1') await page.getByText(/部分方法反编译失败/).waitFor()

    await page.getByRole('button', { name: '搜索代码内容' }).click()
    const search = page.getByPlaceholder('搜索文件内容，按 Enter')
    await search.fill(interesting)
    await search.press('Enter')
    const result = page.locator('.source-results button').filter({ hasText: `${interesting}.java:` }).first()
    await result.waitFor({ timeout: 25_000 })
    const matchPath = await result.getAttribute('title')
    await result.click()
    await verifyPreview(page, new RegExp(interesting))
    const located = page.locator('.tree-box .tree-active')
    await located.waitFor()
    assert.equal(await located.getAttribute('title'), matchPath)

    await choose(exportDir)
    await page.getByRole('button', { name: '导出 Java', exact: true }).click()
    await page.getByText(/已导出 Java 文件到/).waitFor({ timeout: 30_000 })
    const [folder] = await readdir(exportDir)
    assert.ok((await stat(join(exportDir, folder, javaPath))).isFile())

    await page.getByRole('button', { name: 'Smali / 资源 视图', exact: true }).click()
    await page.getByRole('button', { name: '开始解码', exact: true }).click()
    await page.getByPlaceholder('筛选文件路径').waitFor({ timeout: 100_000 })
    await viewPath(page, smaliPath, /\.class\s/)
    assert.equal(await page.locator('.editor-tab.is-active .file-source-badge').textContent(), 'Smali / 资源')
    if (process.env.APKFLUX_TEST_PRIMARY_SMALI) await viewPath(page, process.env.APKFLUX_TEST_PRIMARY_SMALI, /\.class\s/)
    if (resourcePath) await viewPath(page, resourcePath, /<resources/)
    await page.getByRole('button', { name: '查看清单', exact: true }).click()
    await verifyPreview(page, /<manifest\b/)
    assert.match(await page.locator('.monaco-editor:visible .view-lines').textContent(), new RegExp(manifestPackage.replaceAll('.', '\\.')))

    await globalSearch.click()
    await globalQuery.fill(interesting)
    await globalQuery.press('Enter')
    await page.locator('.source-results button').filter({ hasText: 'Smali / 资源' }).first().waitFor()
    const globalJavaHit = page.locator('.source-results button').filter({ hasText: /反编译 Java.*\.java:\d+/ }).first()
    const globalPath = await globalJavaHit.getAttribute('title')
    await globalJavaHit.click()
    await located.waitFor()
    assert.equal(await located.getAttribute('title'), globalPath)
    assert.equal(await page.locator('.editor-tab.is-active .file-source-badge').textContent(), '反编译 Java')

    await app.close()
    page = await launch()
    await page.locator('.history-list button').first().click()
    await page.getByRole('button', { name: '反编译 Java 视图', exact: true }).click()
    await viewPath(page, javaPath, /package\s/)
    await page.getByRole('button', { name: '查看清单', exact: true }).click()
    await verifyPreview(page, /<manifest\b/)
    assert.deepEqual(problems, [])
    assert.equal((await readdir(join(profile, 'decompiled-v1'))).some(name => name.startsWith('.decode-')), false)
  } catch (error) {
    if (app) {
      const page = await app.firstWindow().catch(() => null)
      if (page) {
        console.error(await page.locator('.error-banner').allTextContents())
        console.error((await page.locator('.log-line').allTextContents()).slice(-14).join('\n'))
      }
    }
    throw error
  } finally {
    if (app) await app.close().catch(() => {})
    await rm(temp, { recursive: true, force: true })
  }
})
