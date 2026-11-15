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

设置 `APKFLUX_TEST_ELECTRON` 可使用 Apple Silicon 打包版复验。

反编译验收需要 JADX 1.5.6、Apktool 3.0.3 和 JDK。生成测试 APK 后运行 `npm run test:decode`。测试使用已探测的工具，或通过 `APKFLUX_TEST_JADX` 和 `APKFLUX_TEST_APKTOOL` 指定本地路径。针对其他 APK，可设置 `APKFLUX_TEST_APK`、`APKFLUX_TEST_JAVA_PATH`、`APKFLUX_TEST_SMALI_PATH`、`APKFLUX_TEST_CLASS` 和 `APKFLUX_TEST_PACKAGE` 验收指定的输出。测试用临时数据目录验证界面预览、内容搜索、导出和缓存恢复。

[electron-builder](https://www.electron.build/docs/cli/) 当前生成 Apple Silicon macOS 的 DMG 和 ZIP：

```sh
npm run package:dir
npm run dist:mac
```

`npm run test:edit` 验证解码文件编辑、撤销与重做、差异及关闭保护。设置 `APKFLUX_TEST_BUILD=1` 可用临时签名密钥重建并比较两份 APK。测试夹具可配合隔离的 Android 模拟器，通过 `APKFLUX_TEST_INSTALL_TO` 指定设备序列号以使用安装、启动和卸载操作。

常规打包使用外部工具。本地离线验收包通过 electron-builder 的 `extraResources` 将工具 JAR 放进 `tools/<platform>-<arch>/`。JDK 和 Android SDK 保持由本机配置。可参考[外部工具](tools.md)。

更新检查、下载和安装使用 [electron-updater](https://www.electron.build/docs/features/auto-update/)。正式分发时，通过 electron-builder 的 `publish` 设置注入更新源，签名并生成安装包与更新元数据。将元数据和产物发布到配置的服务后，才能从旧签名版本验收更新。无更新源的本地验收包会在设置页显示状态。本地 macOS 包使用临时开发签名。请在正式发布前复核 [Electron 支持周期](https://releases.electronjs.org/schedule)。


`npm run test:native` 验证真实 SO 的反汇编和伪代码。用 `APKFLUX_TEST_GHIDRA` 指定已编译原生组件的本地安装，`APKFLUX_TEST_APK` 指定 APK，`APKFLUX_TEST_SO` 和 `APKFLUX_TEST_FUNCTION` 可指定 AArch64 条目和函数地址。

## V1.0 发布验收

0.5.2 是 Apple Silicon macOS 本地验收版本。用干净账户安装，逐项检查导入、工具探测、双语与主题、反编译、搜索、编辑、构建签名和卸载。Ghidra 单独记录可用的 Java、引擎版本和目标主机。记录原始 APK 哈希、工具版本及安装包哈希，使用自有夹具复验大 APK 和取消后的清理。

比较内置 JADX、Apktool 加外部 JDK 的当前打包方式，与独立带 JRE 的安装体积、许可证和首次启动体验。发布前记录所需的 JDK、Android SDK 和 Ghidra 安装方式。正式包需要 macOS 分发签名、公证和可访问的更新源。完成一次已签名旧版本的检查、下载、重启安装，并复核工作区缓存、已保存副本和工具配置在升级后可读。

## GitHub 发布

官网使用 GitHub Pages。仓库的 Pages 发布源设为 GitHub Actions 后，`main` 上的官网变更由 `pages.yml` 部署至 [ApkFlux 官网](https://wzebbin.github.io/ApkFlux/)。

在 GitHub 的 `macos-release` 环境里设置 `CSC_LINK`、`CSC_KEY_PASSWORD`、`APPLE_API_KEY_BASE64`、`APPLE_API_KEY_ID` 和 `APPLE_API_ISSUER`。证书为带私钥的 Developer ID Application PKCS#12，公证密钥为 App Store Connect API 私钥。推送与项目版本一致的 `vX.Y.Z` 标签后，工作流在 arm64 runner 上生成签名、公证的 DMG 和 ZIP，并附上 `latest-mac.yml` 更新元数据。复核 GitHub Release 草稿和产物后再发布。
