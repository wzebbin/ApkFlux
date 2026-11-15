# ApkFlux

ApkFlux 是本地运行的 Android APK 工作台。当前版本 `1.0.0` 面向 Apple Silicon macOS，支持导入、反编译、工作副本编辑、重建签名和本地版本对比。

[项目官网](https://wzebbin.github.io/ApkFlux/) · [GitHub Releases](https://github.com/wzebbin/ApkFlux/releases)

## 安装

从 [GitHub Releases](https://github.com/wzebbin/ApkFlux/releases/latest) 下载 Apple Silicon DMG 和 SHA-256 校验文件。打开 DMG，将 ApkFlux 拖到「应用程序」。发布版使用临时签名，首次打开时 macOS 可能提示开发者无法验证。请参阅 [Apple 的说明](https://support.apple.com/zh-cn/102445)。后续版本可在「设置 → 应用更新」打开 GitHub 发布页，下载 DMG 手动替换。

## 从源码启动

准备 Node.js 22.12+（推荐 Node.js 24 LTS）和 npm：

```sh
npm ci
npm run dev
```

已构建的版本可以用 `npm run build` 后执行 `npm start`。首次启动开发版时，Electron 可能需要下载本机运行时；可提前运行 `npm exec -- install-electron`。

从标题栏、快捷键 ⌘O 或文件拖放导入一个 APK。左侧可按文件路径筛选，中央用 Monaco 只读预览 UTF-8 文本，也可查看常见位图。打开「APK 信息」可查看元数据、DEX 数量、`lib/<ABI>/` 中的架构、签名及 SHA-256。底部状态栏显示任务状态并提供取消入口，点击「日志」可查看任务详情。

完整元数据和签名验证依赖 [Android SDK Build Tools](https://developer.android.com/tools/releases/build-tools) 中的 `aapt2`、`apksigner`，以及适配 SDK 的 JDK。工作台会自动寻找，也可在「设置 → 外部工具」指定路径。缺少这些工具时仍能查看 APK 内容、大小、SHA-256、DEX 和 ABI，并会明确标出未取得的信息。工具补齐后重新导入同一 APK 可补全字段。请参阅[外部工具](docs/tools.md)。

导入后，在「文件」页左侧切换「原始 APK」「反编译 Java」和「Smali / 资源」。首次打开反编译视图时，可在该视图中启动对应的工具。打开文件时，编辑器标签会显示文件来源。导入后即可在 APK 文件树点击 `AndroidManifest.xml`，或点击「查看清单」打开只读预览。完成 Smali / 资源解码后，同一入口可打开可编辑的工作副本。Java 和原始 APK 条目以只读方式打开。解码后的 Smali、清单和文本资源可在 Monaco 中编辑。反编译视图支持按路径筛选或搜索文件内容，Java 结果可导出到所选目录。反编译使用后台任务，底部显示日志，也可取消。结果按 APK 的 SHA-256 缓存，重开历史工作区即可继续查看。

常规源码构建使用本机的 JADX 和 Apktool，可通过「外部工具」选择。GitHub 发布包使用外部工具，运行 JADX 和 Apktool 需要本机 JDK。详见[外部工具](docs/tools.md)。

资源管理器右上角的「全局搜索」同时查询原始 APK 和已生成视图的路径，以及 Java、Smali 和解码资源中的文本。尚未生成的视图会在搜索结果中单独提示。点击命中项会打开对应来源的标签并定位到文件树或匹配行。

- 在解码文件中使用「保存文件」或快捷键 ⌘S / Ctrl+S。差异视图以解码原件为基准，关闭文件、切换 APK 或退出时可以保存、放弃修改或取消。
- 从「构建与签名」选择密钥库和新输出文件。ApkFlux 将已保存的工作副本编译、对齐并验签。ADB 设备操作针对所选设备。
- 从「APK 分析」选择另一个已导入 APK，即可比较文件内容哈希、权限及 SDK。已生成的两份 Java 和 Smali 缓存也可比较。报告支持 JSON、HTML 和 CSV。
- 从「APK 分析 → SO / Ghidra」选择 APK 中的 SO，第一次需选择本地 Ghidra 安装目录。分析后可按函数名或地址筛选，并查看反汇编和 C 风格伪代码。
- 设置中可以切换界面语言和主题。

导入会在 Electron 的应用数据目录内保存经过校验的副本。相同 SHA-256 复用已有工作区，原始 APK 保持不变。APK 及解析结果留在本机。启动时清理超过 30 天未使用的可重建结果，保留原始 APK、导入快照、已保存编辑及其 Apktool 解码基础，以及构建产物。

## 验证

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run fixture
npm run test:desktop
npm run test:decode
npm run test:edit
npm run test:stress
```

`npm run fixture` 需要 Android SDK Platform、Build Tools 和 JDK，并在 `test-output/` 生成可复现验收流程所需的真实签名 APK（每次都会重新生成测试证书）。桌面测试需要图形会话。参阅[构建与验收](docs/build.md)。

[架构](docs/architecture.md) · [开发计划](docs/development-plan.md) · [进度](docs/progress.md) · [变更记录](docs/changelog.md)
