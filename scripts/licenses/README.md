# 补充许可证来源

部分上游 crate 未在发布包根目录携带许可证。生成脚本对以下固定版本补充官方文件；升级依赖时须重新核对。

- alloc-stdlib 0.2.4：[上游 LICENSE](https://github.com/dropbox/rust-alloc-no-stdlib/blob/ae42d22078b98549e987d2f03d12df7b984fde47/LICENSE)。
- defmt-parser 1.0.0：[上游 MIT](https://github.com/knurling-rs/defmt/blob/4a8cdb44891ed57b8ff5a023b6bec7137c48708f/LICENSE-MIT)。
- unic 0.9.0 系列：[上游 MIT](https://github.com/open-i18n/rust-unic/blob/5878605364af97a3358368a6eaef02104af2e016/LICENSE-MIT)。
- webview2-com 0.38.2 / macros 0.8.1 / sys 0.38.2：[上游 MIT](https://github.com/wravery/webview2-rs/blob/b74dc5e2b394044bea5191052868ce7a106c202c/LICENSE)。
- selectors 0.36.1：[Mozilla MPL-2.0 全文](https://www.mozilla.org/media/MPL/2.0/index.txt)。未修改源码位于 [对应上游提交](https://github.com/servo/stylo/tree/635e1a19d02960588a00e189bd4bd5bdb150ec3d/selectors)，生成通知也包含其源码获取链接。
- @napi-rs/canvas 平台包：使用同次安装的父包 LICENSE。

对于双许可项，上述补充选择 MIT。其余依赖直接使用已安装包中的许可文件。此目录的上游文件保持原文，适用各自许可证。
