# 参与开发

欢迎提交问题报告和小范围 Pull Request。项目目前仅支持 Windows。

1. 安装 Node.js 24、npm、Rust stable（MSVC）、Microsoft C++ Build Tools 的“使用 C++ 的桌面开发”工作负载及 WebView2，参见 [Tauri Windows 前置条件](https://v2.tauri.app/start/prerequisites/)。
2. 运行 `npm ci`，再运行 `npm run tauri:dev`。
3. 提交前运行 `npm test`、`npm run build` 和 `cargo test --locked --manifest-path src-tauri/Cargo.toml`。

浏览器界面预览可使用 `npm run build`，再运行 `npm run preview -- --host 127.0.0.1`；浏览器模式不支持后台 API 翻译。Windows 安装包构建见 [发布流程](docs/RELEASING.md)。

测试优先覆盖数据完整性、译文复用、任务恢复、阅读顺序和坐标定位。普通测试不应调用付费 API。真实 PDF 测试见 [测试说明](docs/TESTING.md)。

请说明改动原因、验证方式和限制。修改存储或文本块标识时，必须考虑已有译文、人工修改和升级迁移；不能通过清空用户数据库修复问题。

不要提交 API Key、`.env`、本机路径、日志、用户数据库或无分发授权的论文 PDF。用于排版回归的公开问题报告可提供论文出处、页码和最小复现；私有文件请先脱敏。贡献代码按项目 MIT 许可证提供。
