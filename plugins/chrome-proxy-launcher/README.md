# Chrome 隔离出口启动器（chrome-proxy-launcher）

MultiCC 第一个插件。给每个「身份」绑定：

- **一份完全隔离的 Chrome profile** —— 独立 `--user-data-dir`，cookie、登录态、
  扩展、缓存互不串号；
- **一个强制出口** —— `--proxy-server` 指到本地 VPN 客户端的不同端口（Clash /
  sing-box / v2ray 的多端口分流）或任意 http/socks5 代理；socks5 还会配
  `--host-resolver-rules` 把 DNS 解析一并压进代理，防止本地 DNS 泄漏访问了
  哪些域名。

一键启动，一键停止；「测出口」直接显示这个身份当前的外网 IP，肉眼验证分流。

## 为什么 launch 前要检查代理

Chrome 在代理失效时会**静默直连**——这正是多出口场景里最危险的失败方式
（以为走美区 IP，实际裸奔）。所以插件在启动前先做一次 TCP 可达检查
（150ms 级），代理不通就拒绝启动并说明原因。想强制启动可在 `run` 的
input 里传 `"checkProxy": false`（UI 不提供这个开关，属于明知故犯位）。

## 使用

入口：Air 侧栏「**资料与插件 → 插件 → Chrome 隔离出口启动器 → 打开**」。

1. 「探测本机代理端口」—— 扫常见本地出口（Clash 7897/7890/7891、v2ray
   10808/10809、通用 1080/8080…），点结果自动填端口；
2. 填身份名（如「美区店铺」）→ 保存；
3. 「测出口」确认这个身份的外网 IP；「启动浏览器」开一个隔离实例；
   「停止」结束该身份的实例。

## 数据落盘

全部在 `~/.multicc/plugins-data/chrome-proxy-launcher/`：

- `profiles.json` —— 身份清单（原子写）
- `run/<id>.pid` —— 运行中的实例 pid
- `chrome-profiles/<id>/` —— 每个身份的 Chrome user-data-dir（删除身份时
  **保留**，cookie 等敏感数据不自动清理，需手动删）

## 构建

```bash
cd plugins/chrome-proxy-launcher
cargo build --release
mkdir -p bin/darwin-arm64 && cp target/release/chrome-proxy-launcher bin/darwin-arm64/
```

其他平台把产物放进 `bin/<platform>-<arch>/`（命名见 plugins/README.md），
通道会优先取当前平台的目录。

`bin/darwin-arm64/chrome-proxy-launcher` 已随仓库提交（约 0.5MB），开箱即用；
其他平台需要本机构建。

## 命令参考（stdin JSON → stdout JSON）

| 命令 | input | 说明 |
| --- | --- | --- |
| `detect` | – | 找浏览器 + 探测本机常见代理端口 |
| `list` | – | 身份清单（含 running/pid） |
| `save` | `{id?, name, proxy:{scheme,host,port}, note?, chromePath?}` | 新建 / 更新 |
| `remove` | `{id}` | 删除（运行中先停；磁盘 profile 保留） |
| `launch` | `{id, url?, checkProxy?=true}` | 启动隔离实例 |
| `stop` | `{id}` | 停止实例 |
| `probe` | `{id}` 或 `{proxy:{…}}` | 经该出口取外网 IP + 延迟 |

代理类型支持 `http` / `https` / `socks5`（无认证；本地 VPN 客户端端口均为
无认证）。带用户名密码的远程代理暂不支持——Chrome 的 `--proxy-server` 不认
内联凭据，需要本地转发（后续可在插件里加）。
