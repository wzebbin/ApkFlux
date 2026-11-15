import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { mkdir, mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import crc32 from 'crc-32'

const sdk = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME
  || (process.platform === 'darwin' ? join(homedir(), 'Library', 'Android', 'sdk')
    : process.platform === 'win32' ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Android', 'Sdk')
      : join(homedir(), 'Android', 'Sdk'))
const versions = async (dir, pattern) => (await readdir(join(sdk, dir))).filter((name) => pattern.test(name)).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
const [buildTools] = await versions('build-tools', /^\d+(\.\d+)+$/)
const [platform] = await versions('platforms', /^android-\d+$/)
if (!buildTools || !platform) throw new Error('请先安装 Android SDK Platform 和 Build Tools。')
const win = process.platform === 'win32'
const toolDir = join(sdk, 'build-tools', buildTools)
const androidJar = join(sdk, 'platforms', platform, 'android.jar')
const tool = (name) => join(toolDir, name + (win ? '.exe' : ''))
const jdk = (name) => process.env.JAVA_HOME && isAbsolute(process.env.JAVA_HOME) ? join(process.env.JAVA_HOME, 'bin', name + (win ? '.exe' : '')) : name
const output = resolve(process.argv[2] || 'test-output/sample.apk')
await mkdir(resolve(output, '..'), { recursive: true })
const paddingMiB = Number(process.env.APKFLUX_FIXTURE_PADDING_MIB || 0)
if (!Number.isInteger(paddingMiB) || paddingMiB < 0 || paddingMiB > 256) throw new Error('测试素材大小须在 0–256 MiB。')
const textFiles = Number(process.env.APKFLUX_FIXTURE_TEXT_FILES || 0)
if (!Number.isInteger(textFiles) || textFiles < 0 || textFiles > 128) throw new Error('测试文本数量须在 0–128。')
const dir = await mkdtemp(join(tmpdir(), 'apkflux-fixture-'))
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' })

function chunk(name, data) {
  const payload = Buffer.concat([Buffer.from(name), data])
  const size = Buffer.alloc(4)
  size.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32.buf(payload) >>> 0)
  return Buffer.concat([size, payload, crc])
}
const header = Buffer.from([0,0,0,32, 0,0,0,32, 8,6,0,0,0])
const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: 32 }, () => [42, 156, 134, 255]).flat())])
const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
  chunk('IDAT', deflateSync(Buffer.concat(Array(32).fill(row)))), chunk('IEND', Buffer.alloc(0))])
try {
  await mkdir(join(dir, 'res', 'drawable'), { recursive: true })
  await mkdir(join(dir, 'assets'))
  await mkdir(join(dir, 'dex'))
  if (paddingMiB) {
    const file = await open(join(dir, 'assets', 'padding.bin'), 'wx')
    try {
      for (let i = 0; i < paddingMiB; i++) await file.writeFile(randomBytes(1024 * 1024))
    } finally { await file.close() }
  }
  await writeFile(join(dir, 'res', 'drawable', 'icon.png'), png)
  await writeFile(join(dir, 'assets', 'notes.txt'), 'ApkFlux APK fixture\nThis is a real file preview.\n')
  if (textFiles) {
    const folder = join(dir, 'assets', 'stress')
    await mkdir(folder)
    for (let file = 0; file < textFiles; file++) {
      const content = Array.from({ length: 2000 }, (_, line) => `File ${file} · line ${line} · APK workbench editor stress fixture\n`).join('')
      await writeFile(join(folder, `file-${file}.txt`), content)
    }
  }
  await writeFile(join(dir, 'AndroidManifest.xml'), `<manifest xmlns:android="http://schemas.android.com/apk/res/android"
      package="dev.apkflux.fixture" android:versionCode="42" android:versionName="1.2.3">
    <uses-sdk android:minSdkVersion="23" android:targetSdkVersion="35"/>
    <application android:label="ApkFlux Fixture" android:icon="@drawable/icon">
      <activity android:name=".FixtureActivity" android:exported="true">
        <intent-filter>
          <action android:name="android.intent.action.MAIN"/>
          <category android:name="android.intent.category.LAUNCHER"/>
        </intent-filter>
      </activity>
    </application>
  </manifest>`)
  await writeFile(join(dir, 'Fixture.java'), 'package dev.apkflux.fixture; public class Fixture { public static int answer() { return 42; } }')
  await writeFile(join(dir, 'FixtureActivity.java'), 'package dev.apkflux.fixture; public class FixtureActivity extends android.app.Activity {}')
  run(jdk('javac'), ['--release', '8', '-classpath', androidJar, '-d', dir, join(dir, 'Fixture.java'), join(dir, 'FixtureActivity.java')])
  run(jdk('java'), ['-cp', join(toolDir, 'lib', 'd8.jar'), 'com.android.tools.r8.D8', '--lib', androidJar, '--min-api', '23', '--output',
    join(dir, 'dex'), ...['Fixture', 'FixtureActivity'].map((name) => join(dir, 'dev', 'apkflux', 'fixture', name + '.class'))])
  run(tool('aapt2'), ['compile', '--dir', join(dir, 'res'), '-o', join(dir, 'compiled.zip')])
  run(tool('aapt2'), ['link', '-I', androidJar, '--manifest', join(dir, 'AndroidManifest.xml'),
    '-A', join(dir, 'assets'), '-0', 'bin', '-o', join(dir, 'unsigned.apk'), join(dir, 'compiled.zip')])
  run(jdk('jar'), ['--update', '--file', join(dir, 'unsigned.apk'), '-C', join(dir, 'dex'), 'classes.dex'])
  run(tool('zipalign'), ['-f', '4', join(dir, 'unsigned.apk'), join(dir, 'aligned.apk')])
  // Ephemeral key for the generated test APK only.
  run(jdk('keytool'), ['-genkeypair', '-keystore', join(dir, 'test.p12'), '-storepass', 'fixture-only', '-alias', 'fixture',
    '-keyalg', 'RSA', '-keysize', '2048', '-validity', '3650', '-dname', 'CN=ApkFlux Test', '-noprompt'])
  run(jdk('java'), ['-jar', join(toolDir, 'lib', 'apksigner.jar'), 'sign', '--ks', join(dir, 'test.p12'),
    '--ks-pass', 'pass:fixture-only', '--out', output, join(dir, 'aligned.apk')])
  console.log(output)
} finally { await rm(dir, { recursive: true, force: true }) }
