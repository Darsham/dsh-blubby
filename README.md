# dsh-blubby（蓝色大肥鱼）

一只穿着蓝鲸连体衣的小女孩，作为 dsh web 界面的桌面宠物。她根据你在对话里的实时状态变换动作——游泳、疑惑、办公、吃饱、挨扇——同时头顶常驻一条数据条，实时显示本轮花费、DeepSeek 余额、缓存命中率和工作目录 git 状态。全程用**透明背景分段关键帧动画**驱动，不用原始 mp4、不做 spritesheet 图集。

> 素材方案：AI 生成的视频抽关键帧 → rembg 抠图成透明 PNG → 压缩为 240×240 webp 序列帧，按段（初始 / 进入过渡 / doing / 还原过渡）组织，前端按段引用播放。

## 特性

### 🐋 动画

| 状态 | 触发 | 播放方式 |
|---|---|---|
| 游泳 (idle) | 无操作 | 完整循环（initial→enter→doing×3→exit），朝游动方向镜像 |
| 疑惑 (waiting) | 鼠标 hover / 等待模型响应 | 播完过渡后**保持歪头静止**，不循环 |
| 办公 (running) | 模型思考 / 调工具 / 整理回复 | **只循环 doing（敲键盘）段**，不反复进出 |
| 吃饱 (done) | 回合完成 | 一次性：张嘴时 CSS 画的鱼食掉进嘴里 |
| 挨扇 (failed) | 报错 / 中断 / 超限 | 一次性播完回 idle |

- 🖱️ **可拖拽**：按住蓝色大肥鱼拖到窗口任意位置，拖拽时跟随鼠标、按拖动方向转向
- 🧭 **朝向跟随**：素材统一朝右，往左游/拖时 CSS 镜像（`scaleX(-1)`）
- 🎣 **鱼食纯前端绘制**：done 张嘴帧时用 CSS 画小鱼掉落进嘴，按本轮输出 token 数喂 1~5 颗
- 🌍 **全局浮层**：宠物是 host 全局的（无会话维度），直接挂 `document.body` 的独立 React root，任何页面都在（新会话首页也可见）
- 📡 **事件驱动**：订阅官方 session 事件（`turn/start`、`assistant/chunk`、`tool/call`、`turn/end`…）投影成动画状态，浏览器 2 秒轮询拉取

### 💰 数据面板（本次运行统计）

点一下宠物弹出面板，常驻条展示核心几项：

| 指标 | 口径 |
|---|---|
| 💰 花费 | 按官方峰谷定价分档累计（元），高峰 / 空闲分开显示 |
| 🕰 涨价前约 | 同一用量按涨价前一口价（2026-08-16 及之前）重算，用于对比"峰谷价省了多少" |
| 💳 DeepSeek 余额 | 官方 `/user/balance` 接口实时查询（60s 懒刷新），**低于 10 元变红**，未配置 key / 查询失败显示 `--` |
| ⚡ 工作效率 | 缓存命中率（cacheRead / 全部计费输入），无输入时 `--` |
| 🍖 饱腹度 | 本次输入占上下文窗口的百分比，>85% 触发"好撑"特效；面板里展开为 系统提示词/工具/对话消息 三种口粮 token |
| 🛠 git 状态 | 当前工作目录分支 + 未提交文件数（●N），有冲突变红 |
| ⏱ 性能 | LLM 耗时 / 工具耗时 / 首 token 延迟 / 吞吐 tok/s |

## 架构

参照 dsh-pet 的插件架构**重写**（不魔改、不 fork），代码全部独立，MIT 协议：

```
src/
├── index.ts            host 半区入口：BlubbyService（状态机 + 会话统计 + 余额查询）+ /api/blubby/* 路由注册
├── state.ts            纯函数状态机：活动阶段 → 轨道映射
├── event-projection.ts 官方 SessionEvent → 视觉阶段投影（纯函数）+ 峰谷/旧价常量 + 花费分档统计
├── routes.ts           /api/blubby/* JSON 路由 + /blubby/* 静态资产路由（帧名白名单正则）
└── client/
    ├── index.ts        浏览器半区：body 浮层 + 2s 轮询 + segments.json 加载
    └── BlubbyEntry.tsx 分段序列帧播放器 + 拖拽 + 朝向镜像 + 鱼食 + 常驻数据条 + 统计面板
assets/blubby/
├── segments.json       分段清单（frameMs / size / 每状态四段帧名）
└── frames/             172 张 240×240 透明 webp（`<状态>_<段>_<NN>.webp`）
cordis.patch.yml        bundle 补丁：把 blubby 插入 web 插件名册
```

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

- **峰谷分档**：DeepSeek 官方 2026-08-17 00:00 起执行峰谷定价——高峰时段 9:00–12:00、14:00–18:00（本地时间），空闲时段价格为高峰的一半。分档按**本地事件时间戳**（`isPeakHour`）累计，官方未公开消费明细 API（仅 `/user/balance`）。
- **当前模型 deepseek-v4-flash 价格（元/百万 tokens）**：

| 计费项 | 高峰 | 空闲 | 涨价前（2026-08-16 及之前） |
|---|---|---|---|
| 缓存命中输入 | 0.10 | 0.05 | 0.02 |
| 未命中输入 | 3.00 | 1.50 | 1.00 |
| 输出 | 9.00 | 4.50 | 2.00 |

- **数据源与官方同源**：花费/效率/token 全部来自 host 官方服务（session-stats 投影 + token-meter），与输入框底部 StatsLine / ContextMeter 同一数据源，不自算累计；会话归档后跨会话保留（服务级累计）。

### API

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/blubby/state` | GET | 当前状态 + 全部统计：`{ track, phase, bubble, sessionActive, sessionId, satiety, food, efficiency, cost, peakCost, offPeakCost, legacyCost, balance, stats, git, hidden }` |
| `/api/blubby/balance` | GET | DeepSeek 实时余额（懒刷新，60s 节奏） |
| `/api/blubby/set-visible` | POST | 显示/隐藏宠物（body `{ visible: boolean }`） |
| `/api/blubby/current-session` | POST | 前端会话切换通知，立即刷新显示面（body `{ sessionId: string }`） |
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

## 安装

前置：dsh CLI（pnpm ≥ 11）。

```bash
# 1. 构建
pnpm install
pnpm build

# 2. 装进 dsh profile（link 模式，开发热更）
pnpm dsh plugin --profile web add link:<本仓库路径>

# 3. 重启 dsh web
pnpm dsh web
```

浏览器打开 dsh web，蓝色大肥鱼会出现在页面下方游泳。

## 开发

```bash
pnpm build       # tsc 类型 + tsdown 打包（lib/index.js + lib/client.js）
pnpm typecheck   # tsc 严格类型检查
```

改完代码 `pnpm build` 后重启 dsh 即可生效（link 模式直接引用本仓库产物）。

### 依赖说明

- 必须使用 `@deepseek-ai/*@0.1.0-rc.6` 链路（`@deepseek-ai/dsh-client-runtime` 等），rc.6 完整可装
- 依赖 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-session`（事件类型）、`@deepseek-ai/dsh-host-webserver`（路由）
- client 半区 externals 走 loader 模块表（react / react-dom / cordis 等平台模块）

## 素材管线（可复现）

原始 AI 视频（960×960 60fps，即梦生成）在 `G:\即梦素材\大肥鲸鱼\`。管线：

1. **抽关键帧**：`ffmpeg -i <视频>.mp4 -vf "fps=8,mpdecimate=hi=64*32:lo=64*32:frac=0.1" -q:v 2 f_%03d.png`（fps=8 足够平滑；场景检测 select 在本环境不可用）
2. **抠图**：rembg 2.0.78（u2net，`~/.u2net/u2net.onnx` 缓存），逐帧输出透明 PNG
3. **分段**：按动作语义把每状态帧号切成 四段（初始/enter/doing/exit），doing 为可循环的主体段
4. **压缩入库**：Pillow 缩到 240×240 → webp（quality 85），按 `<状态>_<段>_<NN>.webp` 命名，生成 `segments.json`

> 素材统一朝右；向左游/拖时前端 `scaleX(-1)` 镜像，无需翻转素材。

## License

MIT © Darsham
