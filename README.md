# Paperlight

Windows 本地论文库与中英双栏翻译阅读器。**0.1.6 为 MIT 开源预览版**，面向英文原生 PDF，仍在完善复杂排版与数据管理。

## 功能

- PDF / 文件夹导入、SHA-256 去重，保留原文件。
- 自定义论文显示名称、标签、星标和阅读页码恢复。
- 左侧连续 PDF、右侧可编辑中文译文；点击文本块定位并高亮原文。
- 当前页、全文和单块翻译；复用已保存译文，保护人工修改。
- 全文最多两个并发请求，可暂停并在重开后手动继续。
- PDF.js 文本与坐标提取，常见双栏支持和提取诊断。
- Rust 后台请求，API Key 保存在 Windows 凭据管理器。

## 下载与使用

在仓库 **Releases** 选择 Windows x64 **Pre-release**。本地尚未上传时文件位于 `outputs/release-0.1.6/`。

| 文件 | 用途 |
| --- | --- |
| `Paperlight-0.1.6-windows-x64-setup.exe` | Windows 安装包 |
| `Paperlight-0.1.6-windows-x64-portable.zip` | 解压运行 Paperlight.exe |
| `Paperlight-0.1.6-source.zip` | 干净源码快照 |
| `SHA256SUMS.txt` | 下载文件校验值 |

1. 安装或解压后启动，需要 Windows x64 和 Microsoft Edge WebView2 Runtime。
2. 导入英文原生 PDF。左侧铅笔按钮可修改显示名称和标签。
3. 在“翻译设置”配置 Base URL、模型名、API Key，再点击翻译按钮。
4. 缺失块可单独翻译，自动译文可单块重译，人工编辑在离开文本框后保存。

程序未代码签名，Windows 可能显示未知发布者。请从项目 Releases 下载并核对校验值，不需要关闭系统安全功能。

## 隐私、数据与费用

- PDF、提取文本、译文、人工修改与任务进度存于本机 **WebView IndexedDB**，目前尚未使用 SQLite。
- 默认数据根目录为 `%LOCALAPPDATA%\dev.paperlight.reader\`。免安装版也使用应用数据目录，资料不会随 exe 一起移动。
- 原始文件保留，修改显示名称不会重命名原 PDF。
- 已有译文与阅读可离线使用。新翻译会向所选 API 地址发送所需原文、论文标题和页码；漏数字补译还会发送该块上一版译文与缺失数字。
- 后端使用聊天补全 JSON 协议并发送 `thinking.type=disabled`，并非兼容所有供应商。默认配置为 `https://api.deepseek.com` / `deepseek-flash`；模型可用性与价格请以供应商官方文档为准。
- 记录可取得的实际 token usage，尚无完整逐次计费账本和费用估算。超时、失败、补译和重试均可能产生费用。
- 暂无应用内一致性备份/恢复。请保留原 PDF，重要人工译文另行保存，不要清理应用 WebView 目录。安装、升级和回滚尚未完整验证。

## 已知限制

不支持 OCR、云同步、账户、团队协作、Word 引文插件或中文 PDF 精确排版导出。尚无全文搜索、收藏夹、回收站和术语表。

公式、复杂表格和低质量正文会跳过或仅翻译图注。分栏、参考文献和跨页处理仍采用启发式规则；数字、ID 和 JSON 校验不能保证翻译准确。测试通过不意味着所有 PDF 均受支持。

解析规则升级若改变分块，旧译文及人工修改会归档并可在页末查看，新分块需主动重译。

## 从源码运行

准备 Node.js 24、npm、Rust stable（MSVC）、Microsoft C++ Build Tools 的“使用 C++ 的桌面开发”工作负载以及 WebView2。参见 [Tauri Windows 前置条件](https://v2.tauri.app/start/prerequisites/)。

```powershell
npm ci
npm test
npm run tauri:dev
```

浏览器预览不支持后台 API 翻译：

```powershell
npm run build
npm run preview -- --host 127.0.0.1
```

Windows 发布构建：

```powershell
npm run build
cargo test --locked --manifest-path src-tauri/Cargo.toml
npm run notices
npm run tauri:build -- --bundles nsis
powershell -ExecutionPolicy Bypass -File scripts/package-release.ps1
```

打包脚本从当前 Git 提交导出源码，请先提交发布变更。构建需下载 npm、Cargo、NSIS 依赖，不依赖开发者本机工具链或代理。普通测试无需密钥，不调用付费 API。真实 PDF 未随仓库分发，缺失样本的用例会跳过，见 [测试说明](docs/TESTING.md)。

## 项目结构与参与

- `src/`：React 界面、PDF 解析、IndexedDB、翻译编排与测试。
- `src-tauri/`：桌面外壳、Windows 凭据与 HTTP 请求。
- `scripts/`：许可文本生成和发布打包。
- `.github/`：Windows CI、问题和 PR 模板。

见 [贡献指南](CONTRIBUTING.md)、[安全说明](SECURITY.md)、[更新记录](CHANGELOG.md)、[路线图](docs/ROADMAP.md) 和 [发布流程](docs/RELEASING.md)。

项目代码使用 [MIT](LICENSE)。第三方依赖使用各自许可证，见 [第三方说明](THIRD_PARTY_NOTICES.md)。论文和用户译文不属于代码许可证授权范围。
