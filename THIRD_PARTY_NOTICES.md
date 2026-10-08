# 第三方组件

Paperlight 自有代码采用 MIT。依赖保持各自许可证，例如 React（MIT）、PDF.js（Apache-2.0）、Tauri（MIT OR Apache-2.0）。项目许可证不替代第三方许可证，也不授权分发用户导入的论文。

运行 `npm ci` 并安装 Rust 依赖后，执行 `npm run notices`，从本机安装的依赖生成 `THIRD_PARTY_NOTICES.txt`。文件包含 npm 运行时依赖与当前 Windows Cargo 依赖图（含构建依赖）的许可证声明和可发现的许可证文件。发布时随安装包和便携包分发。

依赖变更后应重新生成并检查缺失项。WebView2 是独立安装的 Microsoft 运行时，使用其自身许可条款。
