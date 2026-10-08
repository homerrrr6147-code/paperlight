# 测试说明

## 自动验证

```powershell
npm ci
npm test
npm run build
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

前端测试覆盖 IndexedDB 保存、人工修改保护、缓存、文本块校验与 PDF 阅读顺序。Rust 普通测试不进行真实付费翻译；标记为 ignored 的真实服务测试须自行阅读代码并明确决定是否运行。

部分真实论文回归使用以下本机文件，缺失时跳过相应测试：

- `work/samples/deep-residual-learning.pdf`
- `work/samples/cru.pdf`
- `work/samples/user/09_BERT.pdf`
- `work/samples/user/10_Vision_Transformer_ViT.pdf`
- `work/samples/user/RigL.pdf`

这些 PDF 不随源码发布。没有样本的 CI 通过不代表真实 PDF 排版验证通过，也不能说明所有论文均受支持。

## 发布前人工验证

在独立 Windows 用户或测试机安装，检查启动、导入、重开、页码恢复、译文复用、双栏定位和人工修改保护。配置自己的 Key 后再检查当前页、全文、暂停与失败继续；这会产生供应商费用。不要把 API Key 写入测试脚本。

升级前后及卸载后的数据保留、缺少 WebView2 时的安装体验，需要独立验证。构建成功不能替代这些检查。
