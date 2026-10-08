# 发布流程

## 首次公开仓库

推荐创建空 GitHub 仓库，将审核后的 source.zip 解压并作为初始提交。当前本机开发历史不随源码压缩包发布；不要直接上传工作目录、论文样本或用户数据库。仓库地址确定后再补充项目主页链接。

## 构建

同步修改 package.json、package-lock.json、Cargo.toml、Cargo.lock、tauri.conf.json 和界面版本，并更新 CHANGELOG。运行 README 的测试后：

```powershell
npm run notices
npm run tauri:build -- --bundles nsis
# 提交已审核源码，再导出 HEAD
powershell -ExecutionPolicy Bypass -File scripts/package-release.ps1
```

本机使用非标准 Git 目录时，可传入 `-GitDirectory .paperlight-git`。脚本要求干净提交，防止压缩包源码与二进制版本不一致。输出为 `outputs/release-版本/`；安装包与便携包均包含许可证。便携包仍将资料库存入用户 AppData。

GitHub Actions 在 push / PR 时执行普通测试与前端构建；手动运行时额外生成 Windows 包和构建附件，不自动发布 GitHub Release。工作流首次上传后仍需在 GitHub 验证。参考官方 [checkout](https://github.com/actions/checkout)、[setup-node](https://github.com/actions/setup-node) 和 [upload-artifact](https://github.com/actions/upload-artifact) 文档。

## 上传

完成独立 Windows 安装与升级检查后，为对应提交创建 `v版本` 标签及 Pre-release，上传 setup.exe、portable.zip、source.zip、THIRD_PARTY_NOTICES.txt 和 SHA256SUMS.txt。说明未签名、已测试范围和已知限制。稳定版应等待数据迁移、备份恢复和更广泛样本验证。
