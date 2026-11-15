# 外部工具

在「设置 → 外部工具」中查看探测结果，选择自定义路径，或用「重置」恢复自动探测。顺序是自定义、应用内置、已安装 SDK、系统 PATH。配置保存在本地应用数据中的 `tools.json`。

Apple Silicon 1.0.1 发布包内置 JADX、Apktool、ARM64 Java 运行时、AAPT2、zipalign、apksigner 和 ADB。Ghidra 继续使用本地安装。1.0.0 和源码开发模式使用本机工具，可按下列步骤配置。

- 安装 Android Studio 的 SDK Manager 或 [Android SDK 命令行工具](https://developer.android.com/tools)。完整 APK 元数据通过 [aapt2 dump badging](https://developer.android.com/tools/aapt2) 解析；证书指纹和签名方案由 [apksigner verify](https://developer.android.com/tools/apksigner) 读取。
- 设置 `ANDROID_HOME`（也兼容 `ANDROID_SDK_ROOT`）。默认还会扫描 macOS 的 `~/Library/Android/sdk`。按版本从新到旧查找 Build Tools；ADB 从 Platform Tools 查询。
- Java 可通过工具面板、`JAVA_HOME` 或 PATH 配置。若从 macOS Finder 启动时找不到 shell 中配置的 JDK，可在应用内选择 JDK 的 `bin/java`。
- 第三阶段在 [JADX 1.5.6](https://github.com/skylot/jadx/releases) 和 [Apktool 3.0.3](https://github.com/iBotPeaches/Apktool/releases/tag/v3.0.3) 上验收。建议用 JDK 21。JADX 读取 DEX 并生成 Java；Apktool 解码 Smali、清单和资源。构建使用 SDK Build Tools 中的 zipalign 和 apksigner。ADB 来自 Platform Tools，用于列出设备、安装已签名的构建、启动和卸载所选应用。

如果签名验证工具缺失，会显示「无法验证」；工具判定验证失败时会单独显示「未通过验证」。当前只验证 APK 本身，不读取单独分发的 v4 `.idsig` 文件。图标从 APK 内已有的 PNG、JPEG、GIF 或 WebP 读取，不渲染 XML 矢量或自适应图标。


## Ghidra

从 [Ghidra 官方发布页](https://github.com/NationalSecurityAgency/ghidra/releases/tag/Ghidra_12.2_build) 解压 Ghidra 12.2，在「SO / Ghidra」选择包含 `Ghidra/` 和 `support/` 的安装目录，也可设置 `GHIDRA_HOME`。Ghidra 12.2 需要 JDK 25 或更高。可以设置 `GHIDRA_JAVA_HOME`、`JAVA_HOME`，或在外部工具面板选择兼容的 Java。macOS 也会查找 Homebrew OpenJDK。

macOS 上需要构建 Ghidra 原生组件。准备 Xcode Command Line Tools 和兼容的 JDK，然后在解压目录的 `support/gradle` 下运行 `./gradlew buildNatives`。本机已在 Apple Silicon 上编译并验收。[Ghidra 官方安装与原生组件文档](https://github.com/NationalSecurityAgency/ghidra/blob/Ghidra_12.2_build/GhidraDocs/GettingStarted.md)
