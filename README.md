# dsh-blubby（小咕噜）

一只穿着蓝鲸连体衣的小女孩，作为 dsh web 界面的桌面宠物。她根据你在对话里的实时状态变换动作——游泳、疑惑、办公、吃饱、挨扇，全程用**透明背景分段关键帧动画**驱动。

> 素材方案：AI 生成的视频抽关键帧 → rembg 抠图成透明 PNG → 压缩为 240×240 webp 序列帧，按段（初始 / 进入过渡 / doing / 还原过渡）组织，前端按段引用播放。**不用原始 mp4、不做 spritesheet 图集。**

## 特性

- 🐋 **5 个状态**，每个状态按四段拆解（初始静止 → 进入过渡 → doing → 还原过渡）：
  | 状态 | 触发 | 播放方式 |
  |---|---|---|
  | 游泳 (idle) | 无操作 | 完整循环（initial→enter→doing×3→exit），朝游动方向镜像 |
  | 疑惑 (waiting) | 鼠标 hover / 等待模型响应 | 播完过渡后**保持歪头静止**，不循环 |
  | 办公 (running) | 模型思考 / 调工具 / 整理回复 | **只循环 doing（敲键盘）段**，不反复进出 |
  | 吃饱 (done) | 回合完成 | 一次性：张嘴时 CSS 画的鱼食掉进嘴里 |
  | 挨扇 (failed) | 报错 / 中断 / 超限 | 一次性播完回 idle |
- 🖱️ **可拖拽**：按住小咕噜拖到窗口任意位置，拖拽时跟随鼠标、按拖动方向转向
- 🧭 **朝向跟随**：素材统一朝右，往左游/拖时 CSS 镜像（`scaleX(-1)`）
- 🎣 **鱼食纯前端绘制**：done 张嘴帧时用 CSS 画小鱼掉落进嘴，不用素材
- 🌍 **全局浮层**：宠物是 host 全局的（无会话维度），直接挂 `document.body` 的独立 React root，任何页面都在
- 📡 **事件驱动**：订阅官方 session 事件（`turn/start`、`assistant/chunk`、`tool/call`、`turn/end`…）投影成动画状态，浏览器 2 秒轮询拉取

## 架构

参照 dsh-pet 的插件架构**重写**（不魔改、不 fork），代码全部独立，MIT 协议：

```
src/
├── index.ts            host 半区入口：BlubbyService + /api/blubby/* 路由注册
├── state.ts            纯函数状态机：活动阶段 → 轨道映射
├── event-projection.ts 官方 SessionEvent → 视觉阶段投影（纯函数）
├── routes.ts           /api/blubby/state + /blubby/segments.json + /blubby/frames/*.webp 静态路由
└── client/
    ├── index.ts        浏览器半区：body 浮层 + 2s 轮询 + segments.json 加载
    └── BlubbyEntry.tsx 分段序列帧播放器 + 拖拽 + 朝向镜像 + 鱼食交互
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

### API

| 端点 | 说明 |
|---|---|
| `GET /api/blubby/state` | 当前状态 `{ track, phase, bubble, sessionActive, stateStartedAt }` |
| `GET /blubby/segments.json` | 分段清单：`frameMs` / `size` / 每状态四段帧名数组 |
| `GET /blubby/frames/<file>.webp` | 透明关键帧（白名单：`<状态>_<段>_<NN>.webp` 严格正则） |

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

浏览器打开 dsh web，小咕噜会出现在页面下方游泳。

## 开发

```bash
pnpm build    # tsc 类型 + tsdown 打包（lib/index.js + lib/client.js）
pnpm typecheck
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
