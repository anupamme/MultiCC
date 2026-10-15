---
name: multicc-trigger
description: multicc 自带触发器技能。用于（1）按自然语言为当前会话登记/查看/删除「自动触发规则」——代码改动、定时、每轮结束；（2）当会话被 multicc 自动触发拉起时，按本技能的「开发保姆」流程检查 git 改动并提醒提交与测试。当用户说「改了 X 就提醒我」「每天 X 点提醒」「每轮结束帮我检查」「设个提交/测试提醒」「当开发保姆」，或当收到含「【multicc 自动触发】」字样的消息时使用。
---

# multicc-trigger

本技能由 multicc 随安装自动铺设到 `~/.claude/skills/`。它有两个用途。

运行环境由 multicc 注入以下环境变量（spawn 时给到当前会话）：
- `MULTICC_SESSION_ID` — 当前会话 id（你是谁）
- `MULTICC_BASE_URL` — multicc 本机 API 地址（默认 `http://127.0.0.1:3000`）
- `MULTICC_DIR_ID` — 当前会话所属目录 id

所有规则的「唤醒」（监听文件 / 到点 / 每轮结束后拉起一轮新对话）由 multicc 服务端常驻完成；本技能只负责**登记规则**和**被唤醒后干活**。

---

## 用途一：登记 / 管理触发规则

当用户用自然语言描述一个自动化意图时，把它翻译成一条规则，用随附的 `bin/mtrigger` 脚本写入。脚本会读上面的环境变量，HTTP 调用 multicc 本机 API（localhost 免鉴权）。

脚本路径：本技能目录下的 `bin/mtrigger`（用 Bash 调用，例如 `"$CLAUDE_SKILL_DIR"/bin/mtrigger ...`；若不确定路径，先 `ls` 本技能目录）。

### 命令

```bash
# 列出当前会话的所有规则
mtrigger list

# 代码改动触发：改了匹配 glob 的文件就触发（可多个 --paths）
mtrigger add --type file-change --paths 'src/**' --paths '**/*.py' \
  --debounce 3000 --cooldown 30000 \
  --prompt '检查改动，提醒我该提交或补测试的地方'

# 定时触发：标准 5 段 cron（分 时 日 月 周）
mtrigger add --type schedule --cron '0 18 * * *' \
  --prompt '汇总今天的改动，提醒收尾提交'

# 每轮对话结束后触发（防自循环：触发器自己发起的那轮不会再触发）
mtrigger add --type post-turn --cooldown 60000 \
  --prompt '本轮如有代码改动，提醒我提交与测试'

# 启用 / 停用 / 删除 / 立即测试
mtrigger enable  <id>
mtrigger disable <id>
mtrigger remove  <id>
mtrigger test    <id>
```

# 事件触发：任务状态变化时执行动作（见下方「事件触发」）
mtrigger add --type event --on task.attention --action notify
mtrigger add --type event --on task.achieved --action webhook \
  --url https://example.com/hook --secret MY_HOOK_SECRET

参数说明：
- `--prompt` 可省略；省略时触发会注入一段默认的「检查 git + 提醒提交/测试」指令。
- `--paths` 仅 `file-change` 用，至少一个 glob；支持 `*`（不含 `/`）、`**`（任意层）、`?`。相对会话 worktree 根目录匹配，已自动忽略 `.git/node_modules/.multicc-worktrees`。
- `--debounce`（ms，默认 3000）：短时间多次改动只触发一次。
- `--cooldown`（ms）：两次触发的最小间隔，防风暴。
- `--cron`：标准 5 段表达式；写之前可口算确认含义并向用户复述。

登记成功后，向用户复述这条规则（人话），并附上 `id`，方便日后删改。

---

## 事件触发（type=event）

规则 = 订阅哪些事件 + 可选过滤 + 一个动作。事件按任务状态（classify 字母）派生，`D` 的子状态可能**晚于 D 才出现**（自动细化或人工标记），所以有两层事件：

| 事件 | 含义 |
|---|---|
| `task.running` / `task.waiting_user` / `task.waiting_background` / `task.failed` | P / W / B / E；`failed` 带 `cancelled`（用户中止）与 `errorCategory` |
| `task.finished` | 进入 D（goalState 可能还没有） |
| `task.goal_resolved` | D 的 goalState 变化，`source` = classify / refine / manual |
| `task.achieved` / `task.needs_interaction` | goalState 变为 achieved / interact（同一任务段只触发一次） |
| `task.restarted`、`turn.completed`、`trigger.fired` | 新任务段、轮次完成、规则已执行 |

别名（只在匹配时展开）：`task.attention` = needs_interaction + waiting_user + failed；`task.done` = achieved + needs_interaction。也支持 `task.*`、`*`。

动作：`inject-prompt`（向会话注入提示；自己引起的那一轮不会再触发注入，冷却下限 10 秒）、`webhook`（可选 HMAC-SHA256 签名，密钥放保险箱用 `--secret` 引用；只允许公网地址，超时 5 秒、5xx 重试）、`notify`（走现有推送）。

`inject-prompt` 的注入目标有三种：默认注入到触发事件的会话；`--target <会话id>` 注入到指定会话；`--new-session` 每次触发新建一个会话再注入（`--dir <工作区id>`、`--cli <claude|codex|…>` 留空则沿用触发事件的会话，`--title` 默认用规则名称）。新建的会话自己完成时不会再触发同一类注入，不会无限滚雪球。

**传给下一个动作的固定信封**（用户不用定义变量，只写指令）：`sessionId`（来源会话，想看全文就用它读历史）、`event`、`goal`、`goalState`、`conclusion`（来源会话最后一条回复，截断到约 2000 字并脱敏）、`summary`、`error`（仅失败，只含类别）、`taskId`、`ts`。`inject-prompt` 会把这些拼成一段固定文本，指令放最后；`webhook` 默认只发 sessionId/goal/goalState 等，要带 `conclusion`/`summary` 必须在动作里设 `includeConclusion: true`（命令行加 `--include-conclusion`）。

全局规则（不绑会话）用 HTTP：`GET/POST /api/event-rules`、`PUT/DELETE /api/event-rules/:id`；`GET /api/events/catalog` 看事件清单，`GET /api/events/recent` 看最近事件与执行结果，`POST /api/events/test {type}` 空跑一个事件。

---

## 用途二：被自动触发拉起时（开发保姆流程）

当你收到的消息以「【multicc 自动触发】」开头，或角色设定让你当「开发保姆」时，按下面流程办，**只检查与提醒，不要擅自改代码、不要提交**（除非用户明确要求）：

1. 跑 `git status --short` 和 `git diff --stat` 看未提交改动。
2. 判断：
   - 有较多未提交改动 → 提醒「建议先提交，避免丢失」，并给一句拟好的 commit message 建议。
   - 改了源码但没动对应测试 → 提醒「这些改动建议补/跑测试」，指出可能相关的测试文件或命令。
   - 工作区干净 → 一句话说明「无需处理」即可，不要啰嗦。
3. 输出**简短**（几行），像同事顺口提醒，不要长篇报告。

保持克制：自动触发会反复发生，每次都长篇大论会很吵。
