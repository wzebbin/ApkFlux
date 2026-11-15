ApkFlux 的 Apple Silicon macOS 免费发布版。导入 APK 后可浏览原始文件、反编译结果、编辑工作副本并重建验签。APK 和工作区数据保存在本机。

### 下载与安装

1. 下载下方 Apple Silicon DMG 和 `SHA256SUMS.txt`。可在下载目录运行 `shasum -a 256 -c SHA256SUMS.txt` 验证镜像。
2. 打开 DMG，将 ApkFlux 拖到「应用程序」。本版使用临时签名（ad-hoc），未经 Apple 公证，首次启动可能出现开发者无法验证的提示。请按 [Apple 的说明](https://support.apple.com/zh-cn/102445) 判断能否安全打开。
3. 反编译、验签、重建和 SO 分析所需的 JDK、JADX、Apktool、Android SDK 及 Ghidra 按需安装。安装后可在「设置 → 外部工具」配置。[外部工具配置](https://github.com/wzebbin/ApkFlux/blob/main/docs/tools.md)

后续版本从「设置 → 应用更新 → 查看 GitHub 发布」获取。退出应用后替换「应用程序」里的 ApkFlux，工作区数据保存在独立的应用数据目录。

[ApkFlux 官网](https://wzebbin.github.io/ApkFlux/)
