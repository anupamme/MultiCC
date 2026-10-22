# 第三方组件

## mihomo（Clash Meta）

- 文件：`bin/darwin-arm64/mihomo.gz`（gzip 压缩的 macOS arm64 内核，解压后约 54MB）
- 版本：v1.19.33（2026-10-21 构建，`Mihomo Meta v1.19.33 darwin arm64 with go1.26.10`）
- 来源：<https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.33>
- 下载地址：<https://github.com/MetaCubeX/mihomo/releases/download/v1.19.33/mihomo-darwin-arm64-v1.19.33.gz>
- sha256（.gz 原文件）：`060b64b0f2c9a310831db0fe4adb2878de67bfa606c311813c1f13966aa504b6`
- 许可证：GPL-3.0（全文见上游仓库 <https://github.com/MetaCubeX/mihomo/blob/Alpha/LICENSE>）
- 源码：<https://github.com/MetaCubeX/mihomo>（tag `v1.19.33`）

插件只在需要「订阅节点」出口时启动这个二进制，参数为
`mihomo -d <身份目录> -f <生成配置>`；它作为独立进程运行，插件不修改其代码。
首次使用时插件会把 `.gz` 解压到
`~/.multicc/plugins-data/chrome-proxy-launcher/runtime/mihomo` 并复用。

按 GPL-3.0，重新分发本二进制时需随附许可证与源码获取方式；若需要完整源码，
请从上面的上游 tag 获取，或联系上游项目。

### 其他平台

插件按 `bin/<平台>-<架构>/` 查找内核（见 `plugins/README.md`）。要在其他平台
自带内核，把对应官方 release（darwin-amd64 / linux-amd64 / linux-arm64 /
windows-amd64 等）的二进制或 `.gz` 放到该目录即可；没有自带时插件会回退到
系统里的 `mihomo` / `clash`。
