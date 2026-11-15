# ApkFlux V1.0 开发计划

V1.0 面向 Apple Silicon macOS，提供可验证的本地 APK 分析、编辑、构建和签名桌面流程。按以下里程碑交付：

| 里程碑 | 阶段 | 交付与验收 |
| --- | --- | --- |
| M1 | 1–2：初始化、导入与解析 | Electron/Vue 工作台；通过真实 APK 验证导入、包信息、文件预览、签名验证与历史复开。 |
| M2 | 3：反编译 | 集成 JADX 和 Apktool；Java、Smali、资源和解码后的 Manifest 可浏览与导出。具备后台任务、取消、日志、缓存和代码搜索。 |
| M3 | 4–5：编辑、构建、签名 | Java 反编译结果保持只读；支持编辑 Smali、Manifest、XML、文本和图片，保存状态与差异可见。按 Apktool → zipalign → apksigner → 验签构建到新文件，并在测试设备验收。 |
| M4 | 6：高级分析与对比 | 对比两个真实 APK 的文件、代码、资源、权限、SDK 和 SO；提取网络地址并分析 ELF；输出 HTML、JSON、CSV。 |
| M5 | 发布 | 验收 ADB、中英文、深浅主题、Apple Silicon 安装包、性能和更新。完成 macOS 签名、公证与升级验证。 |

每个阶段都执行必要的单元测试、TypeScript 类型检查和生产构建，并以真实样本验收，更新 README、进度与变更记录。Windows x64、Intel Mac 和 Linux 延后评估。AI 功能已从 0.5.1 移除。
