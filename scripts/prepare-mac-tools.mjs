import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('Use an Apple Silicon Mac and an arm64 Node.js to prepare the macOS tools.')
}

const vendor = resolve('.local-tools/vendor')
const destination = resolve('.local-tools/mac-arm64')
const sdk = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME || join(homedir(), 'Library', 'Android', 'sdk')
const buildVersion = '37.0.0'
const buildTools = join(sdk, 'build-tools', buildVersion)
const platformTools = join(sdk, 'platform-tools')
const runtime = {
  file: 'OpenJDK25U-jre_aarch64_mac_hotspot_25.0.5_8.tar.gz',
  url: 'https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.5%2B8/OpenJDK25U-jre_aarch64_mac_hotspot_25.0.5_8.tar.gz',
  sha256: '72ebd76b502c849e88dea39afae51baf5f82f2b5b1b6389c28ea707b20451bce',
}
const jadx = {
  file: 'jadx-1.5.6.zip',
  url: 'https://github.com/skylot/jadx/releases/download/v1.5.6/jadx-1.5.6.zip',
  sha256: '545ea2be9c242511bc145755cf4bda2485ade42966e096f8b4d3da2a230e8974',
}
const apktool = {
  file: 'apktool_3.0.3.jar',
  url: 'https://github.com/iBotPeaches/Apktool/releases/download/v3.0.3/apktool_3.0.3.jar',
  sha256: 'dbf930b076c6b9be08d57c449cacefc3bdd6b71ebd59b3066fc0e1f5b14f9423',
}

async function matches(path, expected) {
  try {
    const hash = createHash('sha256')
    for await (const data of createReadStream(path)) hash.update(data)
    return hash.digest('hex') === expected
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function verifiedArchive(asset) {
  const path = join(vendor, asset.file)
  if (await matches(path, asset.sha256)) return path
  const temporary = join(stage, asset.file)
  execFileSync('curl', ['--fail', '--silent', '--show-error', '--location', '--retry', '2',
    '--proto', '=https', '--max-time', '180', '--output', temporary, asset.url], { stdio: 'inherit' })
  if (!await matches(temporary, asset.sha256)) throw new Error(`SHA-256 mismatch: ${asset.file}`)
  await rename(temporary, path)
  return path
}

const sdkFiles = [
  [buildTools, 'aapt2'],
  [buildTools, 'zipalign'],
  [buildTools, 'lib/apksigner.jar'],
  [buildTools, 'lib64/libc++.dylib'],
  [buildTools, 'source.properties'],
  [buildTools, 'NOTICE.txt'],
  [platformTools, 'adb'],
  [platformTools, 'source.properties'],
  [platformTools, 'NOTICE.txt'],
]
for (const [folder, name] of sdkFiles) {
  const path = join(folder, name)
  if (!await stat(path).then(info => info.isFile(), () => false)) {
    throw new Error(`缺少 ${path}。请用 Android SDK Manager 安装 Build Tools ${buildVersion} 和 Platform Tools。`)
  }
}
for (const path of [join(buildTools, 'aapt2'), join(buildTools, 'zipalign'), join(buildTools, 'lib64/libc++.dylib'), join(platformTools, 'adb')]) {
  execFileSync('lipo', ['-verify_arch', 'arm64', path])
}

await mkdir(vendor, { recursive: true })
const stage = await mkdtemp(resolve('.local-tools/.mac-tools-'))
const payload = join(stage, 'payload')
try {
  await mkdir(payload)
  const javaHome = join(payload, 'runtime')
  await mkdir(javaHome)
  const javaArchive = await verifiedArchive(runtime)
  execFileSync('tar', ['-xzf', javaArchive, '--strip-components', '3', '-C', javaHome, 'jdk-25.0.5+8-jre/Contents/Home'])
  execFileSync('lipo', ['-verify_arch', 'arm64', join(javaHome, 'bin', 'java')])

  const jadxArchive = await verifiedArchive(jadx)
  for (const [member, file] of [['lib/jadx-1.5.6-all.jar', 'jadx.jar'], ['LICENSE', 'JADX-LICENSE.txt']]) {
    await writeFile(join(payload, file), execFileSync('unzip', ['-p', jadxArchive, member], { maxBuffer: 100 * 1024 * 1024 }))
  }
  await cp(await verifiedArchive(apktool), join(payload, 'apktool.jar'))
  await writeFile(join(payload, 'Apktool-LICENSE.txt'), execFileSync('unzip', ['-p', join(payload, 'apktool.jar'), 'LICENSE']))

  for (const [folder, name] of sdkFiles) {
    const prefix = folder === buildTools ? join('build-tools', buildVersion) : 'platform-tools'
    const to = join(payload, 'sdk', prefix, name)
    await mkdir(dirname(to), { recursive: true })
    await cp(join(folder, name), to)
  }
  await cp('docs/bundled-tools.md', join(payload, 'THIRD-PARTY.md'))
  await rm(destination, { recursive: true, force: true })
  await rename(payload, destination)
  console.log(`已准备 Apple Silicon 内置工具：${destination}`)
} finally {
  await rm(stage, { recursive: true, force: true })
}
