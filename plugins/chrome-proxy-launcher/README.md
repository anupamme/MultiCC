# Chrome 隔离出口启动器（chrome-proxy-launcher）

MultiCC 第一个插件。给每个「身份」绑定：

- **一份完全隔离的 Chrome profile** —— 独立 `--user-data-dir`，cookie、登录态、
  扩展、缓存互不串号；
- **一个强制出口** —— `--proxy-server` 指到本地 VPN 客户端的不同端口（Clash /
  sing-box / v2ray 的多端口分流）或任意 http/socks5 代理；socks5 还会配
  `--host-resolver-rules` 把 DNS 解析一并压进代理，防止本地 DNS 泄漏访问了
  哪些域名。也可以直接绑**订阅里的某个节点**（vmess / trojan / ss / vless 等，
  由身份专属 meow 内核承接）。

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

## 订阅节点与跳板链

「出口类型」选**订阅节点**后：

1. 在下面的「订阅管理」粘贴 Clash 订阅链接（v2rayN/Clash 通用格式；JSON、
   YAML、base64 包裹都认）→「添加订阅」，节点名会被缓存下来；已有订阅点
   「编辑」可改名或换地址（只改名不会重新拉取，token 失效也能改），
   「刷新」按原地址重新拉一次；
2. 身份里选一个节点。启动时插件会为这个身份生成一份**只含该节点**的配置，
   用插件自带的 meow 内核跑一个独立实例（随机端口、只听 127.0.0.1），Chrome 指向它；
3. 家宽 / 住宅代理的常见链路是「先有跳板才连得上」。勾上
   「经这个节点跳板，再到上游住宅代理」并填上游地址即可：

```
Chrome → 本地中继 → meow(跳板节点) → 上游住宅代理(可带账号密码) → 目标站
```

这条链由**插件自己的中继**串起来（内核只负责跳板节点）：中继先经跳板内核的
socks5 连到上游代理，再在上游上开隧道。这样凭据、失败报错、生命周期都在插件
手里，不依赖内核的 `dialer-proxy` 行为；上游不通时会明确拒绝启动，而不是
静默直连。

内核**随插件自带**：`bin/<平台>-<架构>/meow.gz`（本仓库带 darwin-arm64，
meow v0.26.1，MIT，许可与校验值见 `THIRD_PARTY.md`）。首次使用时自动解压到
`plugins-data/.../runtime/meow` 并复用，**不需要另装 Clash 或 mihomo**。其他
平台把官方 release 的单文件压缩成 `meow.gz` 放进对应 `bin/<平台>-<架构>/` 即可。

订阅原文与解析结果都只留在本机；订阅 URL 通常含 token，**不要提交进仓库**。

## 数据落盘

全部在 `~/.multicc/plugins-data/chrome-proxy-launcher/`：

- `profiles.json` —— 身份清单（原子写）
- `subscriptions.json` + `subscriptions/<id>.yaml` —— 订阅清单与拉取到的配置原文
- `run/<id>.pid` —— 运行中的实例 pid
- `run/<id>.core.pid` / `run/<id>.core.json` —— 订阅出口的 meow 内核
- `run/<id>.relay.json` —— 本地中继的 pid 与端口（有中继时才有）
- `runtime/meow` —— 从插件自带 `meow.gz` 解压出来的内核（可随时删除，会自动重建）
- `core/<id>/` —— 每个身份的内核工作目录（`config.yaml`、`core.log`）
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

`bin/darwin-arm64/chrome-proxy-launcher` 已随仓库提交（约 2.4MB，外加 5MB 的
`meow.gz`），开箱即用；其他平台需要本机构建。

## 命令参考（stdin JSON → stdout JSON）

| 命令 | input | 说明 |
| --- | --- | --- |
| `detect` | – | 找浏览器 + 插件自带的 meow 内核 + 探测本机常见代理端口 |
| `list` | – | 身份清单（含 running/pid）+ 订阅清单 |
| `save` | `{id?, name, egressType:"direct"\|"subscription", proxy:{…}` 或 `subscription:{id,node,via?}, note?, chromePath?}` | 新建 / 更新 |
| `remove` | `{id}` | 删除（运行中先停；磁盘 profile 保留） |
| `launch` | `{id, url?, checkProxy?=true}` | 启动隔离实例 |
| `stop` | `{id}` | 停止实例（连带收割本地中继 / 内核） |
| `probe` | `{id}` 或 `{proxy:{…}}` 或 `{subscription:{…}}` | 经该出口取外网 IP + 延迟 |
| `egress` | `{id, check?=false}` | 确保该身份的出口**现在**可用，返回标准代理 URL（`proxyUrl`）。订阅出口会复用/拉起内核，带凭据出口会复用/拉起中继；幂等，可被外部程序按需调用 |
| `egress-stop` | `{id}` | 收割该身份的内核与中继（不动 Chrome），出口配置变化时插件自己也会调 |
| `subscription-save` | `{id?, name?, url}` | 拉取并保存订阅（刷新节点缓存） |
| `subscription-refresh` | `{id}` | 重新拉取订阅 |
| `subscription-remove` | `{id}` | 删除订阅（仍被身份引用时拒绝） |
| `relay` | `{id, proxy:{…}, hop?:{…}}` | 内部命令：launch 自动拉起的本地中继；带 `hop`（socks5）时经跳板连上游，不单独使用 |

代理类型支持 `http` / `https` / `socks5`，可选用户名密码。注意两处边界：

- **`https`（TLS 到代理）只支持无账号密码**：直接交给 Chrome 原生处理；
  带账号密码会拒绝启动（插件内中继没有做 TLS 到代理），测出口对 https
  代理也不可用。需要认证请用 `http` 或 `socks5`。
- **跳板目前只支持「订阅节点」**：想让本机 Clash / 普通 VPN 的端口当跳板
  （再到家宽代理）暂未提供入口。

**带账号密码的代理**：Chrome 的 `--proxy-server` 带不了代理凭据（只认无认证
代理），所以只要身份里填了账号，launch 会先在本机起一个中继进程：

```
Chrome --proxy-server=http://127.0.0.1:<随机端口>  →  中继  →  真实上游
                                        (http Basic / socks5 RFC1929 认证)
```

凭据只存在于插件进程中，从不进入 Chrome 的命令行。中继端口随机、只听
127.0.0.1，stop / remove 时一并收割；兜底是连续 30 分钟无流量自杀。中继状态
写在 `~/.multicc/plugins-data/chrome-proxy-launcher/run/<id>.relay.json`。
上面「订阅节点 + 上游住宅代理」的跳板链复用的也是这个中继，只是多传一个
`hop`（跳板内核的 socks5 端口）。

带凭据的身份在 launch 前会做一次**认证探测**（而不是仅 TCP 可达）：凭据错了
直接拒绝启动，不会让 Chrome 挂在一个永远 407 的中继上。

## 给 Claude 账号当专用出口

同一个身份除了给 Chrome 用，也可以给**某一个 Claude 官方账号**当专用出口
（MultiCC 侧「线路 → 官方账号 → 编辑 → 专用出口」）：每个账号绑一个不同的
身份，各账号的请求就从不同的 IP 出去。

调用方（MultiCC 的 `/claude-egress/<providerId>` 转发器）拿的是一条标准代理
URL，由它自己在 http 层把上游请求接到这条出口上。`egress` 只负责「把出口准备好」
—— 内核/中继已在跑就复用，不在跑就拉起；返回的 `kind` 说明用的是哪一段：

| kind | proxyUrl | 何时 |
| --- | --- | --- |
| `direct` | `<scheme>://host:port` | 无凭据直连代理（本机 Clash / VPN 端口） |
| `core` | `http://127.0.0.1:<内核端口>` | 订阅节点，无上游 |
| `relay` | `http://127.0.0.1:<中继端口>` | 带凭据直连，或订阅节点 + 上游住宅代理 |

要在 UI 之外核对这个身份此刻的出口 IP，加 `"check": true`，返回里会带 `exitIp`
（多一次外网探测，默认不做）。不想让它继续常驻就调 `egress-stop`。

出口配置（代理地址/订阅节点/上游）一改，插件会立刻收割旧内核与中继：内核没有
空闲退出，不收割的话下一个请求会继续走旧出口 —— 改了却换不了 IP 是最坏的结果。
订阅「刷新」同样会收割引用它的身份的内核。

