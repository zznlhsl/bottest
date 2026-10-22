# pod — Cursor Cloud Agent 工具链

一套零依赖 Node CLI，用来操作 Cursor 的 **Cloud Agent / BackgroundComposer（"环境窗口"）**：
取票、看额度、开窗口、打模型、核账本、在本地项目里对话式干活。

```
D:\QQ\pod\
  pod.js     主 CLI（state / snap / token / windows / setup / fire / conv / ledger / watch / models）
  chat.js    对话式 REPL + git 桥（本地项目 ⇄ 云端窗口）
  server.js  Web 控制台（账本/多窗口监控，127.0.0.1:4567）
  clash.js   出口地区控制（FlyClash 命名管道，切美/欧节点）
  skills/    chat.js 的本地 skill（.md 文件，注入到每条消息开头）
```

> 旧的一次性脚本（70 个）已全部归档到 `D:\QQ\_work\archive\`，只作历史参考，不再使用。

---

## 1. 快速开始

```powershell
cd D:\QQ\pod

node clash.js region-us          # 1) 切美国出口（必需，否则高级模型 429 区域锁）
node pod.js token                # 2) 从指纹浏览器取号票 → D:\QQ\secrets\webacct_session.json
node pod.js state                # 3) 看账号/额度/免费次数/环境/账本（只读）
node pod.js windows              # 4) 看有哪些窗口、哪些免费、还剩几个位

node pod.js fire --bc bc-xxxx --models claude-opus-5-5-low,claude-opus-4-8   # 5) 开打（带止损）
node pod.js conv --bc bc-xxxx    # 6) 看真实回复 + 该窗口账本行
```

---

## 1.5 chat.js — 在本地项目里对话式干活（git 桥）

Cloud Agent 只能改 GitHub 上的代码，碰不到本地磁盘。`chat.js` 用一个 git 桥补上这段：
**工作区快照（含未提交改动，用临时 index，不碰你的暂存区）→ push 到 `pod/chat-*` 分支 →
在该分支上开窗 → agent 在 autoBranch 上干活 → `/pull` 拉回本地（diff 预览 → patch / merge）**。

```powershell
cd D:\myproj                      # 任意有 origin 远程的 git 项目（子目录也行）
node D:\QQ\pod\chat.js            # 快照 → 开窗 → REPL

node chat.js --bc bc-xxxx         # 重新接入某窗口（bridge 从 secrets/sessions/ 恢复）
node chat.js --repo URL           # 不动本地，直接在远端仓库上聊（同仓库的本地克隆可 /pull）
node chat.js --path D:\proj       # 指定项目目录
```

REPL 命令：

| 命令 | 作用 |
|---|---|
| 直接打字 | 作为任务消息发给云端 agent（当前模型） |
| `/model <id>` / `/models` | 切模型（白名单见 `pod.js models`）/ 看目录 |
| `/skill <name>` / `/skills` / `/skill off` | 把 `skills/*.md`（或项目里 `.pod/skills/*.md`）的内容拼进每条消息开头——纯注入，不依赖服务端 |
| `/status` / `/slots` | 窗口状态 / 剩余免费位（5 位/窗） |
| `/sync` | 重新拉对话，打印漏掉的新消息 |
| `/diff` / `/pull` | 看 agent 分支改动统计 / 拉回：`[d]iff [p]atch 进工作区 [m]erge [n]othing` |
| `/exit` | 退出（窗口保留，`--bc` 随时接回） |

守卫沿用 pod.js：setup 行计费直接中止（`--force` 覆盖）；每次回复后核账本，出现计费行红字报警。
发消息前自动等窗口 idle；回复靠轮询 `GetBackgroundComposerConversation` 增量打印（伪流式）。

> 注意：`--proxy` 由 pod.js 解析（默认 `127.0.0.1:7897`）；开窗前记得 `node clash.js region-us`。

---

## 2. 命令详解

### `pod.js token` — 取票

从 **CloakBrowser** 指纹环境里把登录态抠出来，写成 `D:\QQ\secrets\webacct_session.json`。

Chromium 运行时会**独占锁死** `Cookies` 数据库（`Copy-Item`、`cmd copy`、共享读、`node:sqlite` 直读全部失败），
所以流程是：**VSS 快照 → 从快照拷出 Cookies → DPAPI 解 master key → AES-256-GCM 解 cookie**。

关键细节：Chromium 在明文值前面塞了 **32 字节 `SHA256(domain)`**，必须切掉，否则拿到的值不能用。

```powershell
node pod.js token                                    # 默认环境 E:\CloakBrowser\profiles\谷歌登录\data
node pod.js token --profile "E:\CloakBrowser\profiles\discord\data"
node pod.js token --cookie WorkosCursorSessionToken  # cookie 名（默认就是它）
node pod.js token --device "\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy15"   # 复用已有快照
node pod.js token --db "$env:TEMP\pod_cookies.db"    # 直接给 cookies 库
```

产物：
| 文件 | 内容 |
|---|---|
| `D:\QQ\secrets\webacct_session.json` | `{jwt, userId, sessionToken}`，`pod.js` 全部命令读它 |
| `D:\QQ\secrets\access_token.txt` | 裸 JWT |
| `D:\QQ\secrets\cloak_cookies.json` | 该 profile 里 cursor.com 全部 cookie 明文 |

### `pod.js state` — 零成本体检

账号 / 套餐 / 周期额度 / 免费 setup 次数 / 环境列表 / 近 1 小时账本（带 `free` / `BILLED` 标记）。

**判断免费池的关键**：`IsNextSetupRunFree` 返回 `{"isPromotionEnabled":true}` 而不带 `remainingRuns`
→ **账号级免费池已耗尽，之后开的每个窗口都计费**（`pod.js state` 会黄字提示）。

### `pod.js windows` — 窗口盘点

列出近 4 小时的 composer，标 `FREE` / `BILLED`，按账本行数算「已用几个位 / 剩几个」。
> 一个窗口 = 1 条 setup 行 + N 条追问行，**免费追问上限 5 个位**。

### `pod.js setup --repo URL` — 开新窗口

```
POST /aiserver.v1.BackgroundComposerService/StartBackgroundComposerFromSnapshot
  source   = BACKGROUND_COMPOSER_SOURCE_ENVIRONMENT_SETUP_GLASS
  repoUrl  = <仓库>     baseBranch = <分支>
  requestedModels = [{modelId: 任意高级模型}]
→ 200 {bcId, modelDetails.modelName}
```
跑完会等 45s 并打印该窗口的 setup 行：`chargeable=false` → 免费窗口；`true` → 计费窗口。

**注意**：服务端会**改写模型**。请求 `claude-fable-5-1-thinking-max` / Opus，setup 那条实际常落成
`grok-4.7-high-fast`。这正常，不影响它是免费窗口。

### `pod.js fire --bc ID --models a,b,c` — 开打（带止损）

对已存在的窗口发追问，**每发之后轮询账本**：

- 出现行且 `chargeable=false` → 免费，继续
- 出现行且 `chargeable=true` → **立刻中止所有剩余发次**（`--no-guard` 可关，不建议）
- 窗口内无行 → 继续，但标记出来

```
POST /aiserver.v1.BackgroundComposerService/AddAsyncFollowupBackgroundComposer
  {bcId, followupMessage:{text,type:1,bubbleId,messageId}, requestedModel:{modelId}}
→ 200 {runId}
```

参数：`--tries 9`（每行最多轮询次数）`--poll 20000`（间隔 ms）。

### `pod.js conv --bc ID` — 验证真的跑了

`GetBackgroundComposerConversation` 拉完整对话 + 该窗口账本行。
每个追问都会收到我们发的 `Reply exactly ...`，**这是"确实执行了"的硬证据**，不是只看 200。

### `pod.js ledger` / `watch` / `models` / `snap`

- `ledger [--minutes 60] [--json]` — 账本裸数据
- `watch --bc ID [--minutes 10]` — 盯一个窗口的新行
- `models` — 模型 id 目录（免费 / 计费 / 不存在）
- `snap [--volume E:\]` — 单独建 VSS 快照

---

## 3. clash.js — 出口地区

FlyClash 这台的 mihomo **只开命名管道** `\\.\pipe\flycast-mihomo-service`，TCP 控制口（9090/9097）全是死的；
代理监听在 `127.0.0.1:7890`（HTTP/mixed）和 `7891`（SOCKS）。

```powershell
node clash.js list                          # 22 个组 + 当前选择 + US/EU 节点清单
node clash.js region-us                     # 所有有美国选项的组一起切到 US
node clash.js --switch "🇺🇸 United States | 01"
node clash.js exit                          # 出口国家 + api2 连通性（顺带验证票活着）
```

**为什么必须切**：直连（新加坡出口）打高级模型一律
`429 ERROR_UNSUPPORTED_REGION`（"This model provider is not supported in your region"）。
另外 `http2.connect` **不吃 `HTTPS_PROXY`**，所以 `pod.js` 自己走 HTTP CONNECT 隧道，
默认 `--proxy 127.0.0.1:7890`。

---

## 4. 免费窗口机制（实测结论）

| 事实 | 证据 |
|---|---|
| 一个仓库窗口 = **5 次免费追问** | UI 提示 "Free follow-ups used up."；账本每个窗口最多 5 条免费追问行 |
| 免费与否由**窗口创建时账号还有没有免费 setup 次数**决定 | 同一模型 `claude-opus-5-5-low`：免费窗口 `cents=0`；额度耗尽后开的窗口 `cents=35.28 / 41.12` |
| **新仓库不会重置**免费池 | 账号级池耗尽后，新仓库窗口的 setup 行本身就 `chargeable=true` |
| 旧号池子大小 | `IsNextSetupRunFree` 5 → 4 → 2 → 1 → 只剩 `isPromotionEnabled` |

**新号开局**：`remainingRuns: 3` → 可开 3 个免费窗口 = 15 个免费位。

### 免费窗口里的模型实测（cents=0 / chargeable=false）

| 请求的 id | 账本实际记录 |
|---|---|
| `claude-opus-5-5-low` | `claude-opus-5-5-low` |
| `claude-opus-5-5` | `claude-opus-5-5-medium` |
| `claude-opus-4-8` | `claude-opus-4-8-thinking-high` |
| `claude-4.6-opus-high-thinking` | `claude-4.6-opus-high-thinking` |
| `claude-4.5-opus-high` | `claude-4.5-opus-high` |
| `claude-sonnet-5-5` | `claude-sonnet-5-5-high` |
| `claude-haiku-5-5` | `claude-haiku-5-5-thinking-high` |
| `claude-fable-5-1-thinking-max` | 同名 |
| `claude-fable-5` | `claude-fable-5-thinking-high` |
| `gpt-5.6-sol-high` / `gpt-5.6-sol` | `gpt-5.6-sol-high` / `gpt-5.6-sol-medium` |
| `gpt-5.6-terra` | `gpt-5.6-terra-medium` |
**用 `-low` / 基础名，不要用 `-high` / `-max`。**

### 不存在的 id（404 `ERROR_BAD_MODEL_NAME`）

`claude-opus-5-5-1m-low`（UI 的 "1M" 是档位不是名字）、全部 `-1m-*`、`cursor-opus-*`、
`opus-5-5-low`、`composer-1`、`composer-2`、大小写/空格/下划线变体。
`opus-4.6` 只有 `claude-4.6-opus-high-thinking` 这一种写法。

---

## 5. 底层路由速查

| 用途 | 路由 |
|---|---|
| 账号 | `aiserver.v1.DashboardService/GetMe` |
| 套餐 | `.../GetPlanInfo` |
| 周期额度 | `.../GetCurrentPeriodUsage` |
| 免费 setup 次数 | `.../IsNextSetupRunFree` |
| 账本 | `.../GetFilteredUsageEvents` |
| 硬上限 | `.../GetHardLimit` |
| 开窗口 | `aiserver.v1.BackgroundComposerService/StartBackgroundComposerFromSnapshot` |
| 起 Pod | `.../CreateBackgroundComposerPod` |
| 追问 | `.../AddAsyncFollowupBackgroundComposer` |
| 窗口信息 | `.../GetBackgroundComposerInfo` |
| 对话内容 | `.../GetBackgroundComposerConversation` |
| 环境列表 | `.../ListEnvironments` |

请求头（伪装 Glass 客户端，缺一不可）：

```
authorization: Bearer <jwt>
content-type: application/json
connect-protocol-version: 1
x-cursor-client-type: glass
x-cursor-client-version: 3.20.10
x-cursor-client-commit: d6f462cdd0a6a6d1cff570daf980e671d0a63ded
x-cursor-checksum: <machineId/macMachineId 混淆值>
x-ghost-mode: false
```

---

## 6. 排错

| 现象 | 原因 / 处理 |
|---|---|
| `401 ERROR_NOT_LOGGED_IN` | 票被顶或不是网页号票 → 重跑 `pod.js token`；IDE 的 accessToken 不可用 |
| `429 ERROR_UNSUPPORTED_REGION` | 出口不对 → `node clash.js region-us` |
| `404 ERROR_BAD_MODEL_NAME` | 模型名错 → `pod.js models` |
| `400 repo URL is required` | setup 没带 `repoUrl` |
| `404 GitHub branch not found` | 分支错（很多仓库默认是 `master` 不是 `main`） |
| `404` 且是私有仓库 | 用当前号能访问的仓库 |
| `EACCES/EBUSY` 读 Cookies | 必须走 VSS 快照（`pod.js token` 已内置） |
| `remainingRuns` 消失 | 免费池耗尽，换号或等重置 |

---

## 7. 证据文件

`D:\QQ\evidence\` 下有各次实测的原始 JSON：`ex-campaign15.json`（15 发逐行）、
`ex-fire-*.json`、`ex-conv-*.json`、`ex-newaccount-state.json`、`ex-opus-billing.json`（计费对照）等。
