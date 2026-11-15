# 构建与验收

使用 Node.js >=22.12、npm，在项目目录执行：

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

`dist/` 包含 Electron 主进程、preload 和渲染器。开发用 `npm run dev`，运行生产构建用 `npm start`。开发模式下 Vue 界面支持热更新；修改主进程或 preload 后请重启 Electron。Monaco 大小会触发 Vite 产物提示，它会一直延迟到第一次打开文本时加载。

安装 Android SDK Platform、Build Tools 和 JDK 后运行 `npm run fixture`、`npm run test:desktop`。测试会用真实 SDK 生成含图标、DEX、资源和签名的 APK，并在临时应用数据目录内，通过 UI 验证导入、预览、拖放与历史复开。测试以受控结果代替原生文件选择器弹窗。可使用 `APKFLUX_SCREENSHOT_DIR` 指定截图目录、`APKFLUX_TEST_ELECTRON` 指向打包后的可执行文件。

在 macOS 或 Linux 上，可额外生成较大的签名 APK 并验证导入期间渲染器继续绘制：

```sh
APKFLUX_FIXTURE_PADDING_MIB=128 npm run fixture -- test-output/large.apk
APKFLUX_TEST_LARGE_APK=test-output/large.apk npm run test:desktop
```

V1.0 压测使用 256 MiB 签名测试 APK，包含 48 个长文本文件。重复四轮打开和关闭 24 个标签，并使用单独的工作区模拟缓存过期。

```sh
npm run fixture
APKFLUX_FIXTURE_PADDING_MIB=256 APKFLUX_FIXTURE_TEXT_FILES=48 npm run fixture -- test-output/v1-stress.apk
npm run build
npm run test:stress
```

设置 `APKFLUX_TEST_ELECTRON` 可使用 Apple Silicon 打包版复验。若工具未被自动探测，可通过 `APKFLUX_TEST_JADX` 和 `APKFLUX_TEST_APKTOOL` 指定路径。

反编译验收需要 JADX 1.5.6、Apktool 3.0.3 和 JDK。生成测试 APK 后运行 `npm run test:decode`。测试使用已探测的工具，或通过 `APKFLUX_TEST_JADX` 和 `APKFLUX_TEST_APKTOOL` 指定本地路径。针对其他 APK，可设置 `APKFLUX_TEST_APK`、`APKFLUX_TEST_JAVA_PATH`、`APKFLUX_TEST_SMALI_PATH`、`APKFLUX_TEST_CLASS` 和 `APKFLUX_TEST_PACKAGE` 验收指定的输出。测试用临时数据目录验证界面预览、内容搜索、导出和缓存恢复。

[electron-builder](https://www.electron.build/docs/cli/) 当前生成 Apple Silicon macOS 的 DMG：

```sh
npm run package:dir
npm run dist:mac
```

`npm run test:edit` 验证解码文件编辑、撤销与重做、差异及关闭保护。设置 `APKFLUX_TEST_BUILD=1` 可用临时签名密钥重建并比较两份 APK。测试夹具可配合隔离的 Android 模拟器，通过 `APKFLUX_TEST_INSTALL_TO` 指定设备序列号以使用安装、启动和卸载操作。

从 1.0.1 起，Apple Silicon 打包会在 `Contents/Resources/tools/darwin-arm64/` 装入已校验的 Temurin ARM64 JRE、JADX 和 Apktool，以及本机 SDK 中的 AAPT2、zipalign、apksigner 与 ADB。构建机需要通过 Android SDK Manager 安装 Build Tools 37.0.0 和 Platform Tools。可用 `ANDROID_SDK_ROOT` 或 `ANDROID_HOME` 指定 SDK。首次构建下载固定版本的 Java 和 JAR，随后复用 `.local-tools/vendor/` 缓存。详细版本、许可证和来源见[内置工具](bundled-tools.md)。

运行打包版桌面验收时，可设置 `APKFLUX_TEST_BUNDLED=1`，检查七个工具均来自应用资源目录，并能运行版本探测。

`npm run test:native` 验证真实 SO 的反汇编和伪代码。用 `APKFLUX_TEST_GHIDRA` 指定已编译原生组件的本地安装，`APKFLUX_TEST_APK` 指定 APK，`APKFLUX_TEST_SO` 和 `APKFLUX_TEST_FUNCTION` 可指定 AArch64 条目和函数地址。

## GitHub 发布

官网使用 GitHub Pages。仓库的 Pages 发布源设为 GitHub Actions 后，`main` 上的官网变更由 `pages.yml` 部署至 [ApkFlux 官网](https://wzebbin.github.io/ApkFlux/)。

安装包在 Apple Silicon Mac 上本地构建与验收。准备 Node.js 24 LTS，更新版本号和发布说明后执行：

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run dist:mac
version=$(node -p "require('./package.json').version")
(cd release && hdiutil verify "ApkFlux-$version-mac-arm64.dmg" &&
  shasum -a 256 "ApkFlux-$version-mac-arm64.dmg" > SHA256SUMS.txt)
```

挂载 DMG，确认应用版本及 arm64 架构，并验证安装和启动。将对应源码提交和版本标签推送到 GitHub，在 Releases 上传本地生成的 DMG 与 `SHA256SUMS.txt`，使用 `docs/github-release.md` 中的说明发布。公开发布后，同步更新 README 与官网的下载链接、公开版本号、文件大小及工具说明。Apple Silicon 免费分发使用临时签名，无 Apple 公证。用户从「设置 → 应用更新」进入 GitHub Releases 手动安装新版本。
