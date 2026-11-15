import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { _electron as electron } from 'playwright-core'

const apk = resolve(process.env.APKFLUX_TEST_APK || 'test-output/sample.apk')
const smali = process.env.APKFLUX_TEST_SMALI_PATH || 'smali/dev/apkflux/fixture/Fixture.smali'
const strings = process.env.APKFLUX_TEST_RESOURCE_PATH
const image = process.env.APKFLUX_TEST_IMAGE_PATH

test('edits decoded files, saves, compares, protects unsaved work and preserves the source APK', { timeout: 120_000 }, async () => {
  const hash = async () => createHash('sha256').update(await readFile(apk)).digest('hex')
  const original = await hash()
  const temp = await mkdtemp(join(tmpdir(), 'apkflux-edit-'))
  const profile = join(temp, 'profile')
  let app
  let page
  async function launch() {
    const executablePath = process.env.APKFLUX_TEST_ELECTRON
    app = await electron.launch({ args: [...(executablePath ? [] : ['.']), `--user-data-dir=${profile}`], ...(executablePath ? { executablePath } : {}) })
    page = await app.firstWindow()
    page.setDefaultTimeout(12_000)
  }
  async function choose(path) {
    await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }) }, path)
  }
  async function chooseOutput(path) {
    await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }) }, path)
  }
  async function decision(response) {
    await app.evaluate(({ dialog }, value) => {
      global.lastEditPrompt = null
      dialog.showMessageBox = async (_window, options) => {
        global.lastEditPrompt = options
        return { response: value, checkboxChecked: false }
      }
    }, response)
  }
  async function openPath(path) {
    if (path === 'AndroidManifest.xml') {
      await page.getByRole('button', { name: '查看清单', exact: true }).click()
    } else {
      await page.getByRole('button', { name: 'Smali / 资源 视图', exact: true }).click()
      await page.getByPlaceholder('筛选文件路径').fill(path)
      await page.locator('.tree-box').getByText(path, { exact: true }).click()
    }
    await page.locator('[aria-label="文件编辑"]').waitFor()
  }
  async function append(marker) {
    await page.locator('.monaco-editor:visible .view-line').first().click()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home')
    if (marker.includes('APKFLUX_TEST_MANIFEST')) await page.keyboard.press('ArrowDown')
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End')
    await page.keyboard.insertText((marker.startsWith('<!--') ? '\n' : ' ') + marker)
    await page.getByText('● 未保存', { exact: true }).waitFor()
  }
  const text = (marker) => page.locator('.monaco-editor:visible .view-lines').filter({ hasText: marker })
  const save = () => page.getByRole('button', { name: '保存文件' }).click()
  try {
    await launch()
    await choose(apk)
    await page.getByRole('button', { name: '导入 APK', exact: true }).click()
    await page.getByPlaceholder('筛选文件路径').fill('AndroidManifest.xml')
    await page.locator('.tree-box').getByText('AndroidManifest.xml', { exact: true }).click()
    await text('<manifest').waitFor()
    await page.locator('.tab-hint').getByText('只读预览').waitFor()
    assert.equal(await page.locator('.editor-tab.is-active .file-source-badge').textContent(), '原始 APK')
    await page.getByRole('button', { name: '关闭文件' }).click()
    await page.getByRole('button', { name: '查看清单', exact: true }).click()
    await text('<manifest').waitFor()
    await page.getByRole('button', { name: 'Smali / 资源 视图', exact: true }).click()
    await page.getByRole('button', { name: '开始解码', exact: true }).click()
    await page.getByPlaceholder('筛选文件路径').waitFor()
    await openPath(smali)
    await append('# APKFLUX_TEST_EDIT')
    await text('APKFLUX_TEST_EDIT').waitFor()
    for (let attempt = 0; attempt < 8 && await page.getByText('● 未保存', { exact: true }).isVisible(); attempt++) {
      await page.getByRole('button', { name: '撤销', exact: true }).click()
      await page.waitForTimeout(40)
    }
    await page.getByText('已保存', { exact: true }).waitFor()
    for (let attempt = 0; attempt < 8 && !await text('APKFLUX_TEST_EDIT').isVisible(); attempt++) {
      await page.getByRole('button', { name: '重做', exact: true }).click()
      await page.waitForTimeout(40)
    }
    await text('APKFLUX_TEST_EDIT').waitFor()
    await page.getByRole('button', { name: '查看差异' }).click()
    const before = page.locator('.diff-editor:visible .original .view-lines')
    const after = page.locator('.diff-editor:visible .modified .view-lines')
    await after.filter({ hasText: 'APKFLUX_TEST_EDIT' }).waitFor()
    assert.doesNotMatch(await before.textContent(), /APKFLUX_TEST_EDIT/)
    await page.getByRole('button', { name: '返回编辑' }).click()
    await save()
    await page.getByText('已保存', { exact: true }).waitFor()
    await page.getByRole('button', { name: '关闭文件' }).click()
    await openPath(smali)
    await text('APKFLUX_TEST_EDIT').waitFor()

    if (strings) {
      await openPath(strings)
      await append('<!-- APKFLUX_TEST_RESOURCE -->')
      await save()
      await page.getByText('已保存', { exact: true }).waitFor()
    }
    if (image) {
      await openPath(image)
      const replacement = join(temp, 'replacement.png')
      await writeFile(replacement, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR4nGOco+rxnwEJMCFziBMAAIW6AhDKwAe9AAAAAElFTkSuQmCC', 'base64'))
      await choose(replacement)
      await page.getByRole('button', { name: '替换图片…' }).click()
      await page.getByText('● 未保存', { exact: true }).waitFor()
      await page.getByRole('button', { name: '撤销' }).click()
      await page.getByText('已保存', { exact: true }).waitFor()
      await page.getByRole('button', { name: '重做' }).click()
      await page.getByRole('button', { name: '查看差异' }).click()
      assert.deepEqual(await page.locator('.image-diff img').evaluateAll((images) => Promise.all(images.map(async (item) => {
        await item.decode()
        return item.naturalWidth > 0
      }))), [true, true])
      const pair = await page.locator('.image-diff img').evaluateAll((images) => images.map((item) => item.src))
      assert.equal(pair.length, 2)
      assert.notEqual(pair[0], pair[1])
      await save()
    }

    await openPath('AndroidManifest.xml')
    const editorView = page.locator('.file-view .monaco-editor:visible')
    async function draftAndScroll(marker) {
      await editorView.locator('.view-line').first().click()
      await page.keyboard.press('ControlOrMeta+A')
      await page.keyboard.insertText(Array.from({ length: 160 }, (_, i) => `<!-- ${marker}_${i} -->`).join('\n'))
      await page.getByText('● 未保存', { exact: true }).waitFor()
      const scrollbar = editorView.locator('.editor-scrollable > .scrollbar.vertical')
      const track = await scrollbar.boundingBox()
      const thumb = await scrollbar.locator('.slider').boundingBox()
      assert.ok(track && thumb && thumb.height < track.height)
      const x = thumb.x + thumb.width / 2
      await page.mouse.move(x, thumb.y + thumb.height / 2)
      await page.mouse.down()
      await page.mouse.move(x, track.y + track.height / 2, { steps: 8 })
      await page.mouse.up()
      await editorView.locator('.view-line').filter({ hasText: `${marker}_80 ` }).waitFor()
    }
    const scrollPosition = (marker) => editorView.evaluate((element, prefix) => {
      const viewport = element.querySelector('.editor-scrollable').getBoundingClientRect()
      const visible = [...element.querySelectorAll('.view-line')]
        .map(row => ({ line: row.textContent, offset: row.getBoundingClientRect().top - viewport.top }))
        .filter(row => row.offset >= 0 && row.offset < viewport.height && row.line.includes(prefix))
        .sort((first, second) => first.offset - second.offset)[0]
      return visible ? { line: visible.line, offset: Math.round(visible.offset) } : null
    }, marker)
    async function verifyScroll(marker, expected) {
      await editorView.locator('.view-line').filter({ hasText: `${marker}_80 ` }).waitFor()
      assert.deepEqual(await scrollPosition(marker), expected)
    }
    const manifestTab = page.locator('.editor-tab').filter({ hasText: 'AndroidManifest.xml' }).filter({ hasText: 'Smali / 资源' })
    const smaliName = smali.split('/').at(-1)
    const smaliTab = page.locator('.editor-tab').filter({ has: page.locator('.tab-name', { hasText: smaliName }) })
    await draftAndScroll('APKFLUX_NAV')
    const beforeNavigation = await scrollPosition('APKFLUX_NAV')
    assert.match(beforeNavigation?.line || '', /APKFLUX_NAV_\d+/)
    await openPath(smali)
    await draftAndScroll('APKFLUX_SECOND')
    const secondPosition = await scrollPosition('APKFLUX_SECOND')
    assert.match(secondPosition?.line || '', /APKFLUX_SECOND_\d+/)
    await manifestTab.locator('.tab-select').click()
    await verifyScroll('APKFLUX_NAV', beforeNavigation)
    await smaliTab.locator('.tab-select').click()
    await verifyScroll('APKFLUX_SECOND', secondPosition)
    await manifestTab.locator('.tab-select').click()
    assert.equal(await page.locator('.tab-dirty-dot').count(), 2)
    const closeSmali = smaliTab.getByRole('button', { name: `关闭 ${smaliName}`, exact: true })
    await decision(2)
    await closeSmali.click()
    const smaliPrompt = await app.evaluate(async () => {
      for (let retry = 0; !global.lastEditPrompt && retry < 20; retry++) await new Promise(resolve => setTimeout(resolve, 50))
      return global.lastEditPrompt
    })
    assert.ok(smaliPrompt?.message.includes(smaliName))
    await smaliTab.waitFor()
    assert.equal(await manifestTab.locator('.tab-select').getAttribute('aria-pressed'), 'true')
    await decision(1)
    await closeSmali.click()
    await smaliTab.waitFor({ state: 'hidden' })
    await decision(2)
    await page.getByRole('button', { name: 'APK 分析', exact: true }).click()
    await page.getByRole('heading', { name: '分析与版本对比', exact: true }).waitFor()
    await page.getByRole('button', { name: '生成报告', exact: true }).click()
    await page.getByRole('navigation', { name: '分析分类' }).waitFor()
    await page.getByRole('button', { name: '文件', exact: true }).click()
    await editorView.waitFor()
    assert.equal(await page.locator('.editor-tab.is-active .tab-name').textContent(), 'AndroidManifest.xml')
    assert.equal(await page.locator('.editor-tab.is-active .file-source-badge').textContent(), 'Smali / 资源')
    await page.getByText('● 未保存', { exact: true }).waitFor()
    await verifyScroll('APKFLUX_NAV', beforeNavigation)
    assert.equal(await app.evaluate(() => global.lastEditPrompt), null)
    await decision(1)
    await page.getByRole('button', { name: '关闭文件', exact: true }).click()
    await manifestTab.waitFor({ state: 'hidden' })
    await openPath('AndroidManifest.xml')

    await append('<!-- APKFLUX_TEST_MANIFEST -->\n    <uses-permission android:name="dev.apkflux.test.permission.MARKER" />')
    await decision(2)
    await page.getByRole('button', { name: '关闭文件' }).click()
    await text('APKFLUX_TEST_MANIFEST').waitFor()
    await decision(2)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await page.getByText('● 未保存', { exact: true }).waitFor()
    for (let attempt = 0; attempt < 20; attempt++) {
      if (await app.evaluate(() => global.lastEditPrompt)) break
      await page.waitForTimeout(50)
    }
    const prompt = await app.evaluate(() => global.lastEditPrompt)
    assert.equal(prompt?.title, '未保存的修改')
    await decision(0)
    await app.close()

    await launch()
    await page.locator('.history-list button').first().click()
    await openPath('AndroidManifest.xml')
    await text('APKFLUX_TEST_MANIFEST').waitFor()
    await openPath(smali)
    await text('APKFLUX_TEST_EDIT').waitFor()
    if (strings) {
      await openPath(strings)
      await text('APKFLUX_TEST_RESOURCE').waitFor()
    }
    if (process.env.APKFLUX_TEST_BUILD === '1') {
      if (process.env.APKFLUX_TEST_INSTALL_TO) {
        await openPath(smali)
        const file = await page.evaluate(async (path) => {
          const recent = await window.apkflux.recent()
          return window.apkflux.openEdit(recent.data[0].id, path).then(result => result.data.saved)
        }, smali)
        const changed = file.replace('0x2a', '0x2b')
        assert.notEqual(changed, file)
        await page.locator('.monaco-editor:visible .view-line').first().click()
        await page.keyboard.press('ControlOrMeta+A')
        await page.keyboard.insertText(changed)
        await save()
        await page.getByText('已保存', { exact: true }).waitFor()
        await page.getByRole('button', { name: '反编译 Java 视图', exact: true }).click()
        await page.getByRole('button', { name: '开始反编译', exact: true }).click()
        await page.getByPlaceholder('筛选文件路径').waitFor()
      }
      const keystore = join(temp, 'test.p12')
      const output = join(temp, 'rebuilt.apk')
      execFileSync('keytool', ['-genkeypair', '-keystore', keystore, '-storetype', 'PKCS12', '-alias', 'fixture',
        '-storepass', 'fixture-only', '-keyalg', 'RSA', '-keysize', '2048', '-dname', 'CN=ApkFlux Test', '-noprompt'], { stdio: 'ignore' })
      await page.getByRole('button', { name: '构建与签名', exact: true }).click()
      await choose(keystore)
      await page.getByRole('button', { name: '选择密钥库' }).click()
      await page.getByLabel('密钥别名').fill('fixture')
      await page.getByLabel('密钥库密码').fill('fixture-only')
      await chooseOutput(output)
      await page.getByRole('button', { name: '选择输出位置' }).click()
      await page.getByRole('button', { name: '构建并签名' }).click()
      await page.getByText('已构建并通过签名验证。', { exact: true }).waitFor({ timeout: 90_000 })
      assert.ok((await readFile(output)).length > 0)
      assert.ok((await page.locator('.workflow-history').textContent()).includes('rebuilt.apk'))
      if (process.env.APKFLUX_TEST_INSTALL_TO) {
        const serial = process.env.APKFLUX_TEST_INSTALL_TO
        assert.equal(process.env.APKFLUX_TEST_APK, undefined, 'Only use the generated fixture for device tests')
        await page.getByRole('button', { name: '日志', exact: true }).click()
        await page.getByRole('button', { name: '刷新 ADB 设备' }).click()
        await page.getByLabel('ADB 设备').selectOption(serial)
        await page.getByRole('button', { name: '安装到设备' }).click()
        await page.locator('.workflow-panel .success-banner').getByText('已安装到所选设备。', { exact: true }).waitFor()
        assert.match(execFileSync('adb', ['-s', serial, 'shell', 'pm', 'path', 'dev.apkflux.fixture'], { encoding: 'utf8' }), /package:/)
        await page.getByRole('button', { name: '启动当前应用' }).click()
        await page.locator('.log-line').getByText('已启动应用。', { exact: true }).waitFor()
        await decision(0)
        await page.getByRole('button', { name: '卸载当前应用' }).click()
        await page.locator('.log-line').getByText('已卸载应用。', { exact: true }).waitFor()
        assert.doesNotMatch(execFileSync('adb', ['-s', serial, 'shell', 'pm', 'list', 'packages', 'dev.apkflux.fixture'], { encoding: 'utf8' }), /dev\.apkflux\.fixture/)
      }
      if (process.env.APKFLUX_TEST_BUILD_OUTPUT) {
        const { copyFile } = await import('node:fs/promises')
        await copyFile(output, process.env.APKFLUX_TEST_BUILD_OUTPUT)
      }
      const sourceId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('window.apkflux.recent().then(r => r.data[0].id)'))
      await choose(output)
      await page.getByRole('button', { name: '导入 APK', exact: true }).click()
      await page.locator('.statusbar').getByText('rebuilt.apk', { exact: true }).waitFor()
      if (process.env.APKFLUX_TEST_INSTALL_TO) {
        await page.getByRole('button', { name: '反编译 Java 视图', exact: true }).click()
        await page.getByRole('button', { name: '开始反编译', exact: true }).click()
        await page.getByPlaceholder('筛选文件路径').waitFor()
      }
      await page.getByRole('button', { name: 'Smali / 资源 视图', exact: true }).click()
      await page.getByRole('button', { name: '开始解码', exact: true }).click()
      await page.getByPlaceholder('筛选文件路径').waitFor()
      await page.getByRole('button', { name: 'APK 分析', exact: true }).click()
      await page.getByLabel('对比基准').selectOption(sourceId)
      await page.getByRole('button', { name: '生成报告' }).click()
      await page.getByPlaceholder('筛选变化路径').waitFor({ timeout: 60_000 })
      await page.getByPlaceholder('筛选变化路径').fill('AndroidManifest.xml')
      await page.getByText('修改 · archive · AndroidManifest.xml', { exact: true }).waitFor()
      await page.getByText('权限新增 1 项，移除 0 项。', { exact: true }).waitFor()
      const decodedManifest = page.locator('.workflow-history li').filter({ hasText: '修改 · android · AndroidManifest.xml' })
      await decodedManifest.getByRole('button', { name: '查看变化' }).click()
      await page.locator('.diff-editor:visible .modified .view-lines').filter({ hasText: 'dev.apkflux.test.permission.MARKER' }).waitFor()
      if (image) {
        await page.getByLabel('变化类型').selectOption('resources')
        await page.getByPlaceholder('筛选变化路径').fill(image)
        await page.getByText(`修改 · android · ${image}`, { exact: true }).waitFor()
        await page.getByLabel('变化类型').selectOption('all')
        await page.getByPlaceholder('筛选变化路径').fill('AndroidManifest.xml')
      }
      if (process.env.APKFLUX_TEST_INSTALL_TO) {
        await page.getByPlaceholder('筛选变化路径').fill('Fixture.java')
        const java = page.locator('.workflow-history li').filter({ hasText: '修改 · java · dev/apkflux/fixture/Fixture.java' })
        await java.getByRole('button', { name: '查看变化' }).click()
        await page.locator('.diff-editor:visible .original .view-lines').filter({ hasText: '42' }).waitFor()
        await page.locator('.diff-editor:visible .modified .view-lines').filter({ hasText: '43' }).waitFor()
      }
      for (const format of ['JSON', 'HTML', 'CSV']) {
        const report = join(temp, 'report.' + format.toLowerCase())
        await chooseOutput(report)
        await page.getByRole('button', { name: '导出 ' + format }).click()
        await page.getByText('已导出到 ' + report, { exact: true }).waitFor()
        assert.match(await readFile(report, 'utf8'), /AndroidManifest\.xml/)
      }
    }
    assert.equal(await hash(), original)
  } catch (error) {
    if (page && !page.isClosed()) {
      console.error(await page.locator('.error-banner').allTextContents())
      console.error(await page.locator('.decode-issue').allTextContents())
      console.error(await page.locator('.tab-hint').allTextContents())
      console.error((await page.locator('.monaco-editor:visible .view-lines').first().textContent().catch(() => '') || '').slice(0, 250))
      console.error((await page.locator('.log-line').allTextContents()).slice(-10).join('\n'))
    }
    throw error
  } finally {
    if (app) {
      await decision(1).catch(() => {})
      await app.close().catch(() => {})
    }
    await rm(temp, { recursive: true, force: true })
  }
})
