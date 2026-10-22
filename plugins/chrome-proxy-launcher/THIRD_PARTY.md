# 第三方组件

## meow（mihomo 的 Rust 重实现）

- 文件：`bin/darwin-arm64/meow.gz`（gzip 压缩的 macOS arm64 内核，解压后约 9MB）
- 版本：v0.26.1（2026-10-21 发布，`meow 0.26.1`）
- 来源：<https://github.com/meow-rs/meow-rs/releases/tag/v0.26.1>
- 下载地址：<https://github.com/meow-rs/meow-rs/releases/download/v0.26.1/meow-v0.26.1-aarch64-apple-darwin.tar.gz>
- sha256（上游 tar.gz 原包）：`1fbc19f54a51469dab03253ede4d4186e19517ccfb8a76f00657cc32f543d5ae`
- 许可证：**MIT**（见上游仓库 <https://github.com/meow-rs/meow-rs/blob/main/LICENSE>）
- 源码：<https://github.com/meow-rs/meow-rs>（tag `v0.26.1`）

插件只在需要「订阅节点」出口时启动这个二进制，参数为
`meow -d <身份目录> -f <生成的配置绝对路径>`；它作为独立进程运行，插件不修改其代码。
首次使用时插件会把 `.gz` 解压到
`~/.multicc/plugins-data/chrome-proxy-launcher/runtime/meow` 并复用。

本文件里的 `.gz` 是从上游 tar.gz 中取出的单文件重新压缩的，内容与上游
`meow-v0.26.1-aarch64-apple-darwin/meow` 一致。

### 更新内核

从 <https://github.com/meow-rs/meow-rs/releases> 下载对应平台的文件，
解压出 `meow` 后执行：

```sh
gzip -9 -c meow > plugins/chrome-proxy-launcher/bin/<平台>-<架构>/meow.gz
```

重启插件页（首次启动会自动重新解压）。

### 其他平台

插件按 `bin/<平台>-<架构>/` 查找内核（见 `plugins/README.md`）。其他平台把
官方 release 的单文件压缩成 `meow.gz` 放到对应目录即可（未压缩的 `meow`
也可以直接放）。
