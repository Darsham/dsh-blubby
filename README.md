# dsh-blubby（小咕噜）

一只穿着蓝鲸连体衣的小女孩，作为 dsh web 界面的桌面宠物。她根据你在对话里的实时状态变换动作——游泳、疑惑、办公、吃饱、挨扇，全程用**原始 mp4 视频**驱动，流畅度与素材完全一致。

> 动画源直接使用原视频（60fps），**不抽帧、不抠图、不做图集**——这是本项目素材方案的铁律。

## 特性

- 🐋 **5 个状态**，每个状态一个 mp4 视频：
  | 状态 | 触发 | 视频 |
  |---|---|---|
  | 游泳 (idle) | 无操作 | `完整游泳.mp4` |
  | 疑惑 (waiting) | 鼠标 hover / 等待模型响应 | `疑惑脸.mp4` |
  | 办公 (running) | 模型思考 / 调工具 / 整理回复 | `办公.mp4` |
  | 吃饱 (done) | 回合完成 | `吃饱.mp4` |
  | 挨扇 (failed) | 报错 / 中断 / 超限 | `挨扇了.mp4` |
- 🎥 **直接播原视频**：`<video>` 元素播放 `/blubby/<track>.mp4`，60fps 原汁原味
- 🖱️ **本地交互**：鼠标悬停切疑惑脸；idle 时在下半屏随机游动；办公时停靠右下角工位
- 🌍 **全局浮层**：宠物是 host 全局的（无会话维度），直接挂 `document.body` 的独立 React root，任何页面都在
- 📡 **事件驱动**：订阅官方 session 事件（`turn/start`、`assistant/chunk`、`tool/call`、`turn/end`…）投影成动画状态，浏览器 2 秒轮询拉取

## 架构

参照 dsh-pet 的插件架构**重写**（不魔改、不 fork），代码全部独立，MIT 协议：

```
src/
├── index.ts            host 半区入口：BlubbyService + /api/blubby/* 路由注册
├── state.ts            纯函数状态机：活动阶段 → 视频轨道映射
├── event-projection.ts 官方 SessionEvent → 视觉阶段投影（纯函数）
├── routes.ts           /api/blubby/state + /blubby/*.mp4 静态资源路由
└── client/
    ├── index.ts        浏览器半区：body 浮层 + 2s 轮询 + 壁纸注入
    └── BlubbyEntry.tsx <video> 播放器 + 游动/hover/鱼食交互
assets/blubby/          5 个 mp4 视频素材（idle/waiting/running/done/failed）
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
| `GET /blubby/<file>.mp4` | 视频素材（白名单：5 个轨道） |

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

浏览器打开 dsh web，小咕噜会出现在页面右下角游泳。

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

## 素材

视频素材为 960×960、60fps 的 mp4（米白底），由即梦 AI 生成，位于 `assets/blubby/`。素材目前**保留米白底**直接播放——未来若需要透明背景，再另做处理（当前不做任何背景移除）。

## License

MIT © Darsham
