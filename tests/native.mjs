import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { _electron as electron } from 'playwright-core'

const engine = process.env.APKFLUX_TEST_GHIDRA || process.env.GHIDRA_HOME
const apk = process.env.APKFLUX_TEST_APK
const library = process.env.APKFLUX_TEST_SO || 'lib/arm64-v8a/libun7zip.so'
const requestedFunction = process.env.APKFLUX_TEST_FUNCTION || '00106258'

async function hash(path) {
  const digest = createHash('sha256')
  for await (const data of createReadStream(path)) digest.update(data)
  return digest.digest('hex')
}

test('shows Ghidra assembly and C pseudocode from a real APK, and reopens the cached project', { timeout: 120_000 }, async () => {
  assert.ok(engine && apk, 'Set APKFLUX_TEST_GHIDRA to a built installation and APKFLUX_TEST_APK to the sample APK.')
  const original = await hash(apk)
  const profile = await mkdtemp(join(tmpdir(), 'apkflux-ghidra-test-'))
  const executablePath = process.env.APKFLUX_TEST_ELECTRON
  let app
  let page
  const errors = []
  const launch = async () => {
    app = await electron.launch({
      args: [...(executablePath ? [] : ['.']), `--user-data-dir=${profile}`],
      ...(executablePath ? { executablePath } : {}),
    })
    page = await app.firstWindow()
    page.on('pageerror', (error) => errors.push(error.message))
    page.setDefaultTimeout(20_000)
  }
  const pick = (path) => app.evaluate(({ dialog }, value) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [value] })
  }, resolve(path))
  async function openNative() {
    await page.getByRole('button', { name: 'APK 分析', exact: true }).click()
    await page.getByRole('button', { name: 'SO / Ghidra', exact: true }).click()
  }
  const analyze = async () => {
    await page.getByRole('combobox', { name: '选择 SO 文件' }).selectOption(library)
    await page.getByRole('button', { name: '分析 SO', exact: true }).click()
    const status = page.locator('.native-meta, .native-panel [role="alert"]').first()
    await status.waitFor({ timeout: 65_000 })
    assert.match(await status.textContent(), /Ghidra [\d.]+ · AARCH64/)
  }
  const inspect = async () => {
    await page.getByPlaceholder('查找函数或地址').fill(requestedFunction)
    await page.locator('.native-function-list button').filter({ hasText: requestedFunction }).first().click()
    const assembly = page.locator('[data-native-output="disassembly"]')
    await assembly.or(page.locator('.native-panel [role="alert"]')).first().waitFor({ timeout: 65_000 })
    assert.equal(await assembly.count(), 1)
    assert.match(await assembly.textContent(), /^[a-f0-9]{8,16}\s+[a-z]/im)
    await page.getByRole('button', { name: '伪代码', exact: true }).click()
    const c = page.locator('[data-native-output="pseudocode"]')
    await c.waitFor()
    assert.match(await c.textContent(), /\{[\s\S]+\breturn\b[\s\S]*\}/)
  }
  try {
    await launch()
    await pick(apk)
    await page.getByRole('button', { name: '导入 APK', exact: true }).click()
    await page.getByPlaceholder('筛选文件路径').fill(library)
    await page.locator('.tree-box').getByText(library, { exact: true }).click()
    await page.getByRole('button', { name: '用 Ghidra 查看', exact: true }).click()
    await pick(engine)
    await page.getByRole('button', { name: '选择 Ghidra 安装目录', exact: true }).click()
    await page.getByText('已保存 Ghidra 安装目录。', { exact: true }).waitFor()
    await analyze()
    await inspect()

    await app.close()
    await launch()
    await page.locator('.history-list button').first().click()
    await openNative()
    await analyze()
    await page.getByRole('button', { name: '日志', exact: true }).click()
    await page.getByText('已打开 SO 的 Ghidra 函数索引。', { exact: true }).waitFor()
    await inspect()
    assert.equal(await hash(apk), original)
    assert.deepEqual(errors, [])
  } catch (error) {
    if (page && !page.isClosed()) {
      console.error(await page.locator('.native-panel [role="alert"]').allTextContents())
      console.error((await page.locator('.log-line').allTextContents()).slice(-16).join('\n'))
    }
    throw error
  } finally {
    if (app) await app.close().catch(() => {})
    await rm(profile, { force: true, recursive: true })
  }
})
