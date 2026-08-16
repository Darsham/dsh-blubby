/**
 * dsh-blubby host half — one Service per profile. Subscribes the official
 * session vocabulary, projects it into the 5-track blubby animation contract
 * and exposes /api/blubby/* JSON endpoints plus the /blubby/* asset prefix
 * (the raw mp4 videos the browser half plays).
 * @module dsh-blubby
 */

import { execFile } from 'node:child_process'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import {
  DEFAULT_CONTEXT_WINDOW,
  PRICE_CACHE_HIT,
  PRICE_OUTPUT,
  PRICE_UNCACHED,
  emptyProjectionRuntime,
  projectOfficialEvent,
  type BlubbySessionStats,
  type ProjectionRuntime,
} from './event-projection.ts'
import {
  BlubbyStateMachine,
  type BlubbyPhase,
  type BlubbyStateInput,
  type BlubbyStateSnapshot,
} from './state.ts'
import { blubbyAssetsDir, makeBlubbyRoutes } from './routes.ts'

/* ------------------------------------------------------------------ *
 * 官方统计口径（结构类型，避免为两个只读面新增依赖）：
 *   - sessionStats 投影：ctx.sessionProjections.snapshot(session).values.sessionStats
 *   - tokenMeter.measure(session)：上下文压力 / token 计量
 * 两者都是 host 官方服务（web-app / base bundle 必载），与输入框底部
 * StatsLine / ContextMeter 完全同一数据源，杜绝自算累计的偏差。
 * ------------------------------------------------------------------ */

/** dsh-session-stats 投影的 view 形状。 */
export interface OfficialSessionStats {
  turns: number
  steps: number
  llmMs: number
  toolMs: number
  ttftMs: number
  ttftSteps: number
  decodeMs: number
  decodeTokens: number
}

/** dsh-token-meter 的 usage 锚点（DISJOINT 分桶，与 llm/types.ts 同源）。 */
export interface OfficialTokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** dsh-token-meter.measure() 返回形状（只读消费所需的最小面）。 */
export interface OfficialTokenMeasurement {
  totalTokens: number
  surfaceTokens: number
  baseline:
    | { kind: 'none' | 'estimated'; tokens: number; usage?: undefined }
    | { kind: 'usage'; tokens: number; usage: OfficialTokenUsage }
  nodes: readonly { seq: number; tokens: number }[]
}

/** 已归档会话的全局累计（服务级，跨会话保留）。 */
interface ArchivedStats {
  llmMs: number
  toolMs: number
  ttftMs: number
  ttftSteps: number
  decodeMs: number
  decodeTokens: number
  turns: number
  steps: number
  /** 累计花费（元，官方 usage 口径 × 一口价常量）。 */
  cost: number
  /** 累计上下文消耗 token（饱腹度累计口径）。 */
  totalTokens: number
  chatTokens: number
  toolTokens: number
  systemTokens: number
}

/** 当前工作目录的 git 快照（懒刷新缓存）。 */
export interface BlubbyGitView {
  root: string
  branch: string
  head: string
  dirtyFiles: number
  untrackedFiles: number
  conflicts: number
}

/** git 刷新节奏：Windows git.exe 冷启动 ~0.7s/次，不能太快。 */
const GIT_REFRESH_MS = 30_000

/** Plugin configuration. */
export interface BlubbyConfig {
  /** Master switch for the plugin (browser half + host routes). */
  enabled?: boolean
}

/** Snapshot returned by `blubby.state`. */
export interface BlubbyStateView {
  /** Which track to play. */
  track: BlubbyStateSnapshot['track']
  /** Optional status bubble copy, shown while active. */
  bubble?: string
  /** Raw activity phase, for debugging and client-side rendering decisions. */
  phase: BlubbyPhase
  /** True when there is an active session (pet mounted). */
  sessionActive: boolean
  /** Wall-clock ms this state started (client can sync loops). */
  stateStartedAt: number
  /** Output tokens accumulated in the current turn (fish snack reward). */
  tokens?: number
  /** 养成统计（有活动会话时给出）：饱腹度/口粮/效率/花费/性能。 */
  satiety?: BlubbySessionStats['satiety']
  food?: BlubbySessionStats['food']
  efficiency?: BlubbySessionStats['efficiency']
  cost?: BlubbySessionStats['cost']
  stats?: {
    llmMs: number
    toolMs: number
    ttftMs: number
    ttftSteps: number
    tokensPerSec: number | null
  }
  /** True when the user hid the pet (client renders a summon button instead). */
  hidden: boolean
  /** 当前工作目录 git 快照；null = 无仓库 / 尚未刷出。 */
  git?: BlubbyGitView | null
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    blubby: BlubbyService
  }
}

/**
 * Cordis service exposing the blubby RPC domain. Lazy: nothing is written on
 * reads; event listeners update only in-memory state.
 */
export class BlubbyService extends Service {
  private readonly machine: BlubbyStateMachine
  private enabled: boolean
  private disposeActivity: (() => void) | undefined
  /** Session whose most recent meaningful event currently drives the pet. */
  private displaySession: Session | undefined
  /** 全局累计统计（host 生命周期，跨会话保留，不随会话 dispose 清空）。 */
  private readonly stats: ProjectionRuntime = emptyProjectionRuntime()
  /** 官方统计服务引用（动态注入，web profile 必载；不可用时保持 undefined）。 */
  private official: {
    sessionProjections: { snapshot(session: Session): { values: Partial<Record<string, unknown>> } }
    tokenMeter: { measure(session: Session): OfficialTokenMeasurement }
  } | undefined
  /** 用户隐藏宠物（前端渲染召唤按钮）。 */
  private hidden = false
  /** 已归档会话的官方口径累计。 */
  private readonly archived: ArchivedStats = {
    llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0,
    turns: 0, steps: 0, cost: 0, totalTokens: 0, chatTokens: 0, toolTokens: 0, systemTokens: 0,
  }
  /** 最近一次 request/context 的真实上下文窗口（默认 1M）。 */
  private contextWindow = DEFAULT_CONTEXT_WINDOW
  /** git 快照缓存与刷新守卫。 */
  private git: BlubbyGitView | null = null
  private gitAt = 0
  private gitFetching = false

  constructor(ctx: Context, config: BlubbyConfig = {}) {
    super(ctx, 'blubby')
    this.machine = new BlubbyStateMachine()
    this.enabled = config.enabled ?? true
    // 官方统计服务（sessionProjections / tokenMeter）是可选增强：服务不可用
    // 时宠物照常跑，只是统计面退化为空。与官方 token-meter 自身一致用动态注入。
    // 类型：官方包的类型增强未引入（结构类型策略），这里断言到本地最小面。
    ctx.inject(['sessionProjections', 'tokenMeter'], (injected) => {
      const official = injected as unknown as NonNullable<typeof this.official>
      this.official = official
    })
    this.syncActivity()
  }

  /** Whether the blubby service consumes session activity while enabled. */
  isEnabled(): boolean {
    return this.enabled
  }

  /** RPC: current pet state snapshot. */
  async state(): Promise<BlubbyStateView> {
    return this.view()
  }

  /** Start or stop the session-activity listeners that drive the pet. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    this.syncActivity()
  }

  private syncActivity(): void {
    if (this.disposeActivity !== undefined) {
      this.disposeActivity()
      this.disposeActivity = undefined
    }
    if (!this.enabled) return
    this.disposeActivity = (() => {
      const disposers = [
        this.ctx.on('session/event', (session: Session, event: SessionEvent) => {
          // 动画状态跟踪最近一次事件；统计改为官方口径（view 时读取），
          // 这里只记录真实上下文窗口供饱腹度换算。
          if (event.type === 'request/context' && typeof event.data.contextWindow === 'number') {
            this.contextWindow = event.data.contextWindow
          }
          const transition = projectOfficialEvent(event, this.stats)
          if (transition === undefined) return
          this.applyActivity(session, transition.input)
        }),
        this.ctx.on('session/disposed', (session: Session) => {
          // 归档官方口径快照到全局累计（dispose 后 events 仍可读，官方
          // 服务按 durable tail 重放，口径与 UI 完全一致）。
          this.archiveSession(session)
          if (session !== this.displaySession) return
          this.displaySession = undefined
          this.machine.onSessionDisposed()
        }),
      ]
      return () => { for (const dispose of disposers) dispose() }
    })()
  }

  /** 用户隐藏/召唤宠物（前端召唤按钮调 setVisible(true)）。 */
  setVisible(visible: boolean): void {
    this.hidden = !visible
  }

  /** 把一次会话的官方口径快照累加进全局归档。 */
  private archiveSession(session: Session): void {
    const official = this.official
    if (official === undefined) return
    const ss = this.readSessionStats(session)
    this.archived.llmMs += ss.llmMs
    this.archived.toolMs += ss.toolMs
    this.archived.ttftMs += ss.ttftMs
    this.archived.ttftSteps += ss.ttftSteps
    this.archived.decodeMs += ss.decodeMs
    this.archived.decodeTokens += ss.decodeTokens
    this.archived.turns += ss.turns
    this.archived.steps += ss.steps
    const tm = official.tokenMeter.measure(session)
    this.archived.totalTokens += tm.totalTokens
    const base = tm.baseline
    if (base.kind === 'usage' && base.usage !== undefined) {
      const u = base.usage
      this.archived.cost += (u.cacheReadTokens ?? 0) * PRICE_CACHE_HIT / 1e6
        + ((u.inputTokens ?? 0) + (u.cacheWriteTokens ?? 0)) * PRICE_UNCACHED / 1e6
        + (u.outputTokens ?? 0) * PRICE_OUTPUT / 1e6
      const { chat, tool } = this.foodFromNodes(session, tm)
      const billed = (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0)
      this.archived.chatTokens += chat
      this.archived.toolTokens += tool
      this.archived.systemTokens += Math.max(0, billed - chat - tool)
    } else {
      this.archived.cost += tm.totalTokens * PRICE_UNCACHED / 1e6
      const { chat, tool } = this.foodFromNodes(session, tm)
      this.archived.chatTokens += chat
      this.archived.toolTokens += tool
      this.archived.systemTokens += Math.max(0, tm.totalTokens - chat - tool)
    }
  }

  /** 官方 sessionStats 投影（缺失时全 0）。 */
  private readSessionStats(session: Session): OfficialSessionStats {
    const official = this.official
    if (official === undefined) return emptySessionStats()
    const values = official.sessionProjections.snapshot(session).values
    const ss = values.sessionStats as OfficialSessionStats | undefined
    if (ss === undefined || typeof ss !== 'object') return emptySessionStats()
    return {
      turns: num(ss.turns), steps: num(ss.steps),
      llmMs: num(ss.llmMs), toolMs: num(ss.toolMs),
      ttftMs: num(ss.ttftMs), ttftSteps: num(ss.ttftSteps),
      decodeMs: num(ss.decodeMs), decodeTokens: num(ss.decodeTokens),
    }
  }

  /** 按官方 tokenMeter 的 surface 节点把对话/工具 token 分类。 */
  private foodFromNodes(session: Session, tm: OfficialTokenMeasurement): { chat: number; tool: number } {
    let chat = 0
    let tool = 0
    for (const node of tm.nodes) {
      const event = session.events[node.seq]
      if (event === undefined) continue
      if (event.type === 'user/message' || event.type === 'assistant/message') chat += node.tokens
      else if (event.type === 'tool/call' || event.type === 'tool/result') tool += node.tokens
    }
    return { chat, tool }
  }

  /** git 快照：懒刷新（30s 节奏），返回当前缓存；无活动会话或无仓库为 null。 */
  private refreshGit(session: Session | undefined): void {
    if (session === undefined) {
      if (Date.now() - this.gitAt > GIT_REFRESH_MS * 2) this.git = null
      return
    }
    if (this.gitFetching || Date.now() - this.gitAt < GIT_REFRESH_MS) return
    const cwd = session.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') return
    this.gitFetching = true
    const run = (argv: readonly string[]): Promise<string> => new Promise((resolve) => {
      execFile('git', [...argv], { cwd, timeout: 10_000, windowsHide: true }, (error, stdout) => {
        resolve(error === null ? stdout : '')
      })
    })
    void Promise.all([
      run(['rev-parse', '--abbrev-ref', 'HEAD']),
      run(['rev-parse', '--short', 'HEAD']),
      run(['status', '--porcelain']),
    ]).then(([branch, head, porcelain]) => {
      const lines = porcelain.split('\n').filter((line) => line.trim() !== '')
      let dirty = 0
      let untracked = 0
      let conflicts = 0
      for (const line of lines) {
        const xy = line.slice(0, 2)
        if (xy === '??') untracked += 1
        else if (xy.includes('U') || xy.includes('DD') || xy.includes('AA')) conflicts += 1
        else dirty += 1
      }
      const trimmedBranch = branch.trim()
      this.git = {
        root: cwd,
        branch: trimmedBranch === 'HEAD' ? '' : trimmedBranch,
        head: head.trim(),
        dirtyFiles: dirty,
        untrackedFiles: untracked,
        conflicts,
      }
      this.gitAt = Date.now()
      this.gitFetching = false
    }, () => {
      this.gitFetching = false
    })
  }

  /** Commit one activity as the host-global pet's most recent display state. */
  private applyActivity(session: Session, input: BlubbyStateInput): void {
    this.displaySession = session
    this.machine.onActivityStatus(input)
    this.machine.onSessionActive()
  }

  private view(): BlubbyStateView {
    const snapshot = this.machine.render()
    const s = this.stats
    const active = this.displaySession
    // git：懒刷新（有活动会话时触发，读缓存返回）。
    this.refreshGit(active)
    // 性能：归档累计 + 活动会话官方 sessionStats。
    const perf = {
      llmMs: this.archived.llmMs,
      toolMs: this.archived.toolMs,
      ttftMs: this.archived.ttftMs,
      ttftSteps: this.archived.ttftSteps,
      tokensPerSec: null as number | null,
    }
    let satiety: BlubbySessionStats['satiety'] = null
    let food: BlubbySessionStats['food'] = { systemTokens: 0, toolTokens: 0, chatTokens: 0 }
    let efficiency: number | null = null
    let cost = this.archived.cost

    if (active !== undefined) {
      const ss = this.readSessionStats(active)
      perf.llmMs += ss.llmMs
      perf.toolMs += ss.toolMs
      perf.ttftMs += ss.ttftMs
      perf.ttftSteps += ss.ttftSteps
      if (ss.decodeTokens > 0 && ss.llmMs > 0) {
        perf.tokensPerSec = Math.round((ss.decodeTokens / ss.llmMs) * 1000)
      }
      const official = this.official
      if (official !== undefined) {
        const tm = official.tokenMeter.measure(active)
        const window_ = this.contextWindow
        satiety = {
          usedTokens: tm.totalTokens,
          contextWindow: window_,
          percent: window_ > 0 ? Math.min(100, Math.round((tm.totalTokens / window_) * 100)) : 0,
        }
        const base = tm.baseline
        if (base.kind === 'usage' && base.usage !== undefined) {
          const u = base.usage
          const billed = (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0)
          cost += (u.cacheReadTokens ?? 0) * PRICE_CACHE_HIT / 1e6
            + ((u.inputTokens ?? 0) + (u.cacheWriteTokens ?? 0)) * PRICE_UNCACHED / 1e6
            + (u.outputTokens ?? 0) * PRICE_OUTPUT / 1e6
          efficiency = billed > 0 ? Math.round(((u.cacheReadTokens ?? 0) / billed) * 100) : 100
          const { chat, tool } = this.foodFromNodes(active, tm)
          food = {
            chatTokens: this.archived.chatTokens + chat,
            toolTokens: this.archived.toolTokens + tool,
            systemTokens: this.archived.systemTokens + Math.max(0, billed - chat - tool),
          }
        } else {
          // 无 provider usage 锚点（估算口径）：花费按总量×未命中价近似。
          cost += tm.totalTokens * PRICE_UNCACHED / 1e6
          efficiency = null
          const { chat, tool } = this.foodFromNodes(active, tm)
          food = {
            chatTokens: this.archived.chatTokens + chat,
            toolTokens: this.archived.toolTokens + tool,
            systemTokens: this.archived.systemTokens + Math.max(0, tm.totalTokens - chat - tool),
          }
        }
      } else {
        // 官方服务不可用：退化为旧累计口径。
        satiety = s.satiety
        food = s.food
        efficiency = s.efficiency
        cost += s.cost ?? 0
        perf.tokensPerSec = s.tokensPerSec ?? null
      }
    } else {
      // 无活动会话：显示归档累计（无会话时饱腹度 = 累计 token / 窗口）。
      satiety = {
        usedTokens: this.archived.totalTokens,
        contextWindow: this.contextWindow,
        percent: this.contextWindow > 0
          ? Math.min(100, Math.round((this.archived.totalTokens / this.contextWindow) * 100))
          : 0,
      }
      food = {
        systemTokens: this.archived.systemTokens,
        toolTokens: this.archived.toolTokens,
        chatTokens: this.archived.chatTokens,
      }
    }

    return {
      track: snapshot.track,
      ...(snapshot.bubble === undefined ? {} : { bubble: snapshot.bubble }),
      phase: snapshot.phase,
      sessionActive: snapshot.sessionActive,
      stateStartedAt: snapshot.stateStartedAt,
      ...(snapshot.tokens === undefined ? {} : { tokens: snapshot.tokens }),
      // 养成统计：官方口径（sessionStats + tokenMeter）+ 会话归档累计。
      satiety,
      food,
      efficiency,
      cost,
      stats: perf,
      hidden: this.hidden,
      git: this.git,
    }
  }
}

/** 全 0 的官方 sessionStats（服务未就绪/投影缺失时）。 */
function emptySessionStats(): OfficialSessionStats {
  return { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 }
}

/** 数值守卫：非有限数归 0。 */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Plugin name (the cordis roster id). */
export const name = 'blubby'

/** Required host services. */
export const inject = ['webServer']

/**
 * Plugin body: instantiate the pet service and register its API + asset
 * routes on the context. Route registration follows the profile's enabled
 * switch (the plugin row's `enabled` field).
 * @param ctx - host root context.
 * @param config - plugin configuration.
 */
export function apply(ctx: Context, config: BlubbyConfig = {}): void {
  const service = new BlubbyService(ctx, config)
  const routes = makeBlubbyRoutes({
    service,
    assetsDir: blubbyAssetsDir(import.meta.url),
  })
  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'blubby: routes')
}
