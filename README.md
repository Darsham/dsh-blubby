# dsh-blubby（蓝色大肥鱼）

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

一只穿着蓝鲸连体衣的小女孩，是 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）web 界面的桌面宠物插件。她根据会话里的实时状态变换动作——游泳、疑惑、办公、吃饱、挨扇，头顶常驻一条数据条：本轮花费、DeepSeek 账户余额与预估余额、缓存命中率、工作目录 git 状态。余额快烧完时她还会**自动帮你停下手头的任务**。

- 🐋 **透明背景分段关键帧动画**：AI 视频抽关键帧 → rembg 抠图 → 240×240 webp 序列帧，不用原始 mp4、不做 spritesheet 图集
- 📡 **事件驱动**：订阅 host 官方 session 事件投影成动画状态，统计数据与官方 UI 完全同源
- 💰 **花费 / 余额全程可见**：峰谷分档计费、官方余额延迟对账、余额预警自动停任务
- 📺 **内置随身小电视**：贴个 B 站链接就能边写代码边看剧

---

## 🚀 在 deepseek-harness 中使用

dsh-blubby 是一个 cordis 双半区插件（host 半区 + 浏览器半区），通过 `cordis.patch.yml` 挂载进 dsh 的 web 插件名册。整个过程三步：构建 → 注册进 profile → 重启 dsh web。

### 前置条件

| 依赖 | 要求 |
|---|---|
| deepseek-harness（dsh CLI） | 已可用（`pnpm dsh web` 能跑起来） |
| Node.js | `^22.19.0 \|\| >=24.0.0` |
| pnpm | ≥ 11 |

### 1. 克隆并构建

```bash
git clone https://github.com/Darsham/dsh-blubby.git
cd dsh-blubby
pnpm install
pnpm build        # tsc 类型 + tsdown 打包（lib/index.js host 半区 + lib/client.js 浏览器半区）
```

### 2. 注册进 dsh profile

```bash
# 在 dsh CLI 可用处执行（link 模式：直接引用本仓库产物，改代码重新 build 即可热更）
pnpm dsh plugin --profile web add link:<本仓库绝对路径>
```

### 3.（可选）配置余额查询用的 API Key

余额 / 预估余额 / 余额预警功能需要读取 DeepSeek 官方 `/user/balance` 接口。key 按以下优先级查找：

1. 环境变量 `DEEPSEEK_API_KEY`
2. 本仓库根目录的 `.env` 文件：`DEEPSEEK_API_KEY=sk-...`

不配置也能用——只是余额相关的面板显示 `--`，预警不生效，动画和统计不受影响。key 只在 host 本机内存中使用，不随任何请求外发。

### 4. 启动 / 重启 dsh web

```bash
pnpm dsh web
```

浏览器打开 dsh web，蓝色大肥鱼会出现在页面下方游泳。点击宠物可弹出数据面板；面板上的 ✕ 可隐藏宠物（隐藏后出现召唤按钮）。

> 插件默认启用（`enabled: true`）。也可以在插件配置里关闭：`{ enabled: false }`。

---

## 特性

### 🐋 动画状态机

| 状态 | 触发 | 播放方式 |
|---|---|---|
| 游泳 (idle) | 无操作 | 完整循环（initial→enter→doing×3→exit），朝游动方向镜像 |
| 疑惑 (waiting) | 鼠标 hover / 等待模型响应 | 播完过渡后**保持歪头静止**，不循环 |
| 办公 (running) | 模型思考 / 调工具 / 整理回复 | **只循环 doing（敲键盘）段**，不反复进出 |
| 吃饱 (done) | 回合完成 | 一次性：张嘴时 CSS 画的鱼食掉进嘴里 |
| 挨扇 (failed) | 报错 / 中断 / 超限 / 余额预警 | 一次性播完回 idle |

- 🖱️ **可拖拽**：按住宠物拖到窗口任意位置，拖拽时跟随鼠标、按拖动方向转向
- 🧭 **朝向跟随**：素材统一朝右，往左游/拖时 CSS 镜像（`scaleX(-1)`）
- 🎣 **鱼食纯前端绘制**：done 张嘴帧时用 CSS 画小鱼掉落进嘴，按本轮输出 token 数喂 1~5 颗
- 🌍 **全局浮层**：宠物是 host 全局的（无会话维度），直接挂 `document.body` 的独立 React root，任何页面都在（新会话首页也可见）
- 👀 **隐藏/召唤**：面板 ✕ 隐藏后，页面上留一个召唤按钮，随时找回她

### 💰 数据面板

点一下宠物弹出面板，常驻条展示核心几项；统计跨会话持久（服务级累计），数据源与官方输入框底部的 StatsLine / ContextMeter 完全同源。

| 指标 | 口径 |
|---|---|
| 💰 花费 | 按官方峰谷定价分档累计（元），高峰 / 空闲分开显示 |
| 🕰 涨价前约 | 同一用量按涨价前一口价（2026-08-16 及之前）重算，用于对比"峰谷价省了多少" |
| 💳 DeepSeek 余额 | 官方 `/user/balance` 实时查询（事件驱动，见下节），**低于 10 元变红** |
| 🧮 预估剩余 | 对账后的实时余额估计（官方余额 − 尚未落账的本地精确花费） |
| ⚡ 工作效率 | 缓存命中率（cacheRead / 全部计费输入），无输入时 `--` |
| 🍖 饱腹度 | 本次输入占上下文窗口的百分比，>85% 触发"好撑"特效；面板展开为 系统提示词/工具/对话消息 三种口粮 token |
| 🛠 git 状态 | 当前工作目录分支 + 未提交文件数（●N），有冲突变红 |
| ⏱ 性能 | LLM 耗时 / 工具耗时 / 首 token 延迟 / 吞吐 tok/s |

### 🛡 余额预估与预警（自动停任务）

DeepSeek 官方余额的结算有分钟级延迟：你刚花掉的钱，官方接口可能 5 分钟后才体现。直接把官方读数当余额，会高估、甚至错过"余额即将耗尽"。blubby 的做法是**两条账对账**：

- `spentTotal`：本地按官方口径精确累计的花费（单调不减，含子代理等所有在世会话）
- `landedCost`：官方余额已经体现的扣费（官方余额每次下降的幅度累加而来）

```
预估余额 = 官方余额 − (spentTotal − landedCost)
          └──── 官方读数 ────┘   └── 还没落账的本地花费 ──┘
```

官方还没扣的钱，从官方读数里预先扣掉；官方落账后这部分自动抵消，预估全程连续，不跳变、不重复扣。充值（官方余额上升）和账外用量（同一 key 在别处花钱）也能正确处理。

在此基础上提供**余额预警**：

- 预估余额低于阈值 → **自动停止当前任务**（等效用户按停止键），宠物进入"挨扇"状态并提示
- 阈值默认 0.2 元；运行时可在面板里点击阈值数字直接改（0 或负值 = 关闭）
- 预警触发后进入保护态，直到预估余额回升到阈值之上才复位，防止连环误停
- 余额查询是**事件驱动**的：服务启动时查一次，此后每次你发消息开始任务时立即查一次，不做定时轮询

### 📺 随身小电视（B 站）

面板里的「📺 小电视」按钮召唤一个可拖动悬浮窗：粘贴 B 站视频播放页链接 → 自动抠出 BV 号 → 走 `player.bilibili.com` 官方嵌入播放器。窗口位置随手拖，最近看过的 3 条链接自动记忆。

---

## 架构

```
src/
├── index.ts            host 半区入口：BlubbyService（状态机 + 会话统计 + 余额对账 + 预警）+ /api/blubby/* 路由注册
├── state.ts            纯函数状态机：活动阶段 → 轨道映射
├── event-projection.ts 官方 SessionEvent → 视觉阶段投影（纯函数）+ 峰谷/旧价常量 + 花费分档统计
├── routes.ts           /api/blubby/* JSON 路由 + /blubby/* 静态资产路由（帧名白名单正则）
└── client/
    ├── index.ts        浏览器半区：body 浮层 + 2s 轮询（页面隐藏时暂停）+ segments.json 加载
    ├── BlubbyEntry.tsx 分段序列帧播放器 + 拖拽 + 朝向镜像 + 鱼食 + 常驻数据条 + 统计面板 + 阈值内联编辑
    └── WhaleTv.tsx     B站小电视悬浮窗（链接解析 + iframe 播放 + 拖动 + 最近记录）
assets/blubby/
├── segments.json       分段清单（frameMs / size / 每状态四段帧名）
└── frames/             172 张 240×240 透明 webp（`<状态>_<段>_<NN>.webp`）
cordis.patch.yml        bundle 补丁：把 blubby 插入 web 插件名册
```

host 半区依赖官方 `sessionProjections` / `tokenMeter` 服务（动态注入，不可用时退化为空统计面，宠物照常），统计数据与官方 UI 同源、不自算累计。

### 事件投影 → 状态机

```
turn/start ────────► waiting（疑惑）
step/start ────────► waiting
assistant/chunk ───► thinking → running（办公）   [reasoning-delta]
assistant/chunk ───► review  → running（办公）    [text-delta]
tool/call ─────────► tool    → running（办公）
tool/result ───────► failed / thinking
turn/end completed ► done（吃饱，4.5s 后回 idle）
turn/end failed    ► failed（挨扇，7.5s 后回 idle）
```

### 花费统计口径

- **峰谷分档**：DeepSeek 官方 2026-08-17 00:00 起执行峰谷定价——高峰时段 9:00–12:00、14:00–18:00（本地时间），空闲时段价格为高峰的一半。分档按**本地事件时间戳**累计；官方未公开消费明细 API（仅 `/user/balance`）。
- **当前模型 deepseek-v4-flash 价格（元/百万 tokens）**：

| 计费项 | 高峰 | 空闲 | 涨价前（2026-08-16 及之前） |
|---|---|---|---|
| 缓存命中输入 | 0.10 | 0.05 | 0.02 |
| 未命中输入 | 3.00 | 1.50 | 1.00 |
| 输出 | 9.00 | 4.50 | 2.00 |

### API

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/blubby/state` | GET | 当前状态 + 全部统计：`{ track, phase, bubble, sessionActive, sessionId, satiety, food, efficiency, cost, peakCost, offPeakCost, legacyCost, balance, estimatedBalance, balanceAlertThreshold, balanceAlertTriggered, stats, git, hidden }` |
| `/api/blubby/balance` | GET | 立即查一次官方余额并返回（强制刷新，不等事件） |
| `/api/blubby/set-visible` | POST | 显示/隐藏宠物（body `{ visible: boolean }`） |
| `/api/blubby/current-session` | POST | 前端会话切换通知，立即刷新显示面（body `{ sessionId: string }`） |
| `/api/blubby/alert-threshold` | POST | 运行时调整余额预警阈值（body `{ threshold: number }`，0/负值 = 关闭） |
| `/blubby/segments.json` | GET | 分段清单（`frameMs` / `size` / 每状态四段帧名数组，no-cache） |
| `/blubby/frames/<file>.webp` | GET | 透明关键帧（白名单：`<状态>_<段>_<NN>.webp` 严格正则） |

### 播放模式（client 端定义，不在 manifest 里）

| 轨道 | 模式 | 行为 |
|---|---|---|
| idle | `loop-full` | initial→enter→doing×3→exit 整条循环 |
| waiting | `hold` | initial→enter→歪头帧，停住不动 |
| running | `loop-doing` | 只循环 doing（敲键盘），无进出过渡 |
| done | `one-shot` | 一次性播完，张嘴帧触发鱼食，随后回 idle |
| failed | `one-shot` | 一次性播完回 idle |

## 配置

| 配置项 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 插件总开关（浏览器半区 + host 路由） |
| `balanceAlertThreshold` | `0.2` | 余额预警阈值（元）。预估余额低于此值自动停止当前任务；0 或负值 = 关闭。运行时也可通过面板或 `/api/blubby/alert-threshold` 调整 |

## 开发

```bash
pnpm build       # tsc 类型 + tsdown 打包（lib/index.js + lib/client.js）
pnpm typecheck   # tsc 严格类型检查
```

改完代码 `pnpm build` 后重启 dsh 即可生效（link 模式直接引用本仓库产物）。

- 依赖 `@deepseek-ai/*@0.1.0-rc.6` 链路（`cordis` / `dsh-session` / `dsh-host-webserver` / `dsh-client-runtime`）
- client 半区 externals 走 loader 模块表（react / react-dom / cordis 等平台模块由 shell 注入，不重复打包）

## 素材管线（可复现）

1. **抽关键帧**：`ffmpeg -i <视频>.mp4 -vf "fps=8,mpdecimate=hi=64*32:lo=64*32:frac=0.1" -q:v 2 f_%03d.png`（fps=8 足够平滑）
2. **抠图**：rembg（u2net）逐帧输出透明 PNG
3. **分段**：按动作语义把每状态帧号切成四段（初始 / enter / doing / exit），doing 为可循环的主体段
4. **压缩入库**：缩到 240×240 → webp（quality 85），按 `<状态>_<段>_<NN>.webp` 命名，生成 `segments.json`

> 素材统一朝右；向左游/拖时前端 `scaleX(-1)` 镜像，无需翻转素材。

## License

MIT © Darsham
