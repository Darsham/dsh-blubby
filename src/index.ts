/**
 * dsh-blubby host half — one Service per profile. Subscribes the official
 * session vocabulary, projects it into the 5-track blubby animation contract
 * and exposes /api/blubby/* JSON endpoints plus the /blubby/* asset prefix
 * (the raw mp4 videos the browser half plays).
 * @module dsh-blubby
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import {
  DEFAULT_CONTEXT_WINDOW,
  PRICE_CACHE_HIT_LEGACY,
  PRICE_CACHE_HIT_OFF,
  PRICE_CACHE_HIT_PEAK,
  PRICE_OUTPUT_LEGACY,
  PRICE_OUTPUT_OFF,
  PRICE_OUTPUT_PEAK,
  PRICE_UNCACHED_LEGACY,
  PRICE_UNCACHED_OFF,
  PRICE_UNCACHED_PEAK,
  emptyProjectionRuntime,
  isPeakHour,
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
import { blubbyAssetsDir, blubbyPackageRoot, makeBlubbyRoutes } from './routes.ts'

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

/** dsh-token-meter 的 tokenUsage 投影 view（整段日志累计四桶，与
 * StatsLine 的 useProjection('tokenUsage') 同源；官方口径的命中率分子/分母）。 */
export interface OfficialTokenUsageProjection {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
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
  /** 累计花费（元，峰谷分档：高峰时段 / 空闲时段）。 */
  cost: number
  /** 高峰时段累计花费（元）。 */
  peakCost: number
  /** 空闲时段累计花费（元）。 */
  offPeakCost: number
  /** 涨价前一口价口径的累计花费（元，对比用）。 */
  legacyCost: number
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
  /**
   * 余额预警阈值（元）。预估剩余余额（官方余额 − 本地精确累计成本）低于
   * 此值时自动停止当前任务（等效用户按停止键）并提示；0 或负值 = 关闭。
   * 默认 0.2（用户拍板 2026-08-21）。
   */
  balanceAlertThreshold?: number
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
  /** 当前显示会话 id（null = 无会话）；前端用它判断切项目数据是否已刷新到位。 */
  sessionId: string | null
  /** 养成统计（有活动会话时给出）：饱腹度/口粮/效率/花费/性能。 */
  satiety?: BlubbySessionStats['satiety']
  food?: BlubbySessionStats['food']
  efficiency?: BlubbySessionStats['efficiency']
  cost?: BlubbySessionStats['cost']
  /** 高峰时段累计花费（元，本地事件时间戳分档）。 */
  peakCost?: number
  /** 空闲时段累计花费（元，本地事件时间戳分档）。 */
  offPeakCost?: number
  /** 涨价前一口价口径累计花费（元，对比用）。 */
  legacyCost?: number
  /** DeepSeek 账户实时余额（元）；null = 未配置 key / 查询失败。 */
  balance?: number | null
  /** 预估剩余余额（元）= 官方余额 − 尚未落账的本地精确成本（官方结算有
   * 分钟级延迟）；null = 官方余额不可用（此时预警不触发）。 */
  estimatedBalance?: number | null
  /** 余额预警阈值（元）；0/负值 = 预警关闭。 */
  balanceAlertThreshold: number
  /** 余额预警已触发（预估剩余低于阈值并自动停止了任务）。 */
  balanceAlertTriggered: boolean
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
    turns: 0, steps: 0, cost: 0, peakCost: 0, offPeakCost: 0, legacyCost: 0,
    totalTokens: 0, chatTokens: 0, toolTokens: 0, systemTokens: 0,
  }
  /** 最近一次 request/context 的真实上下文窗口（默认 1M）。 */
  private contextWindow = DEFAULT_CONTEXT_WINDOW
  /** git 快照缓存与刷新守卫。 */
  private git: BlubbyGitView | null = null
  private gitAt = 0
  private gitFetching = false
  /** git 缓存所属 cwd：切换项目（cwd 变）强制立即刷新，不走 30s 懒刷新窗口。 */
  private gitCwd: string | undefined
  /** DeepSeek 余额缓存（元）；null = 未配置 key 或查询失败。 */
  private balanceCache: number | null = null
  private balanceFetching = false
  /** 本地精确累计花费（元，单调不减）：按会话记「已计入」快照做增量累加，
   * 因此切会话 / 峰谷价重算 / 会话归档都不会让总额回退。 */
  private spentTotal = 0
  /** 每个会话已计入 spentTotal 的花费（元），保证同一会话不被重复累加。 */
  private readonly sessionSpent = new Map<string, number>()
  /** 官方余额中「已落账」的累计扣费（元）：由官方余额每次下降的幅度累加
   * 而来。官方结算有分钟级延迟，本地花费里尚未落账的部分 =
   * spentTotal − landedCost，这部分要从官方余额里额外扣掉才是真实余额。 */
  private landedCost = 0
  /** 余额预警阈值（元）；0/负值 = 关闭。 */
  private balanceAlertThreshold: number
  /** 预警已触发（自动停止过任务）；余额回升到阈值之上后复位。 */
  private balanceAlertTriggered = false

  constructor(ctx: Context, config: BlubbyConfig = {}) {
    super(ctx, 'blubby')
    this.machine = new BlubbyStateMachine()
    this.enabled = config.enabled ?? true
    this.balanceAlertThreshold = config.balanceAlertThreshold ?? 0.2
    // 官方统计服务（sessionProjections / tokenMeter）是可选增强：服务不可用
    // 时宠物照常跑，只是统计面退化为空。与官方 token-meter 自身一致用动态注入。
    // 类型：官方包的类型增强未引入（结构类型策略），这里断言到本地最小面。
    ctx.inject(['sessionProjections', 'tokenMeter'], (injected) => {
      const official = injected as unknown as NonNullable<typeof this.official>
      this.official = official
    })
    this.syncActivity()
    // 启动时查一次官方余额（此后仅用户发消息开始任务时再查，无轮询）。
    this.refreshBalance(true)
  }

  /** Whether the blubby service consumes session activity while enabled. */
  isEnabled(): boolean {
    return this.enabled
  }

  /** RPC: current pet state snapshot. */
  async state(): Promise<BlubbyStateView> {
    return this.view()
  }

  /** RPC: DeepSeek 账户余额（元）；null = 未配置 key / 查询失败。 */
  async balance(): Promise<number | null> {
    return this.refreshBalance(true)
  }

  /** 运行时调整余额预警阈值（元）；0/负值 = 关闭。 */
  setBalanceAlertThreshold(threshold: number): void {
    this.balanceAlertThreshold = threshold > 0 ? threshold : 0
    // 阈值调高可能立即命中预警；调低/关闭则解除触发标记。
    if (this.balanceAlertThreshold <= 0) {
      this.balanceAlertTriggered = false
    } else {
      this.checkBalanceAlert(undefined)
    }
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
          // 用户输入框发消息开始任务 → 立即查一次官方余额（事件驱动，
          // 不做定时轮询）。source.kind === 'user' = 直接人类输入；
          // plugin/inject/cron 等合成消息不触发查询。
          if (event.type === 'user/message' && event.data.source?.kind === 'user') {
            this.refreshBalance(true)
          }
          // 每次 LLM 调用结算后检查余额预警（assistant/message = 一次精确
          // 结算完成）；其他事件不触发检查。
          if (event.type === 'assistant/message') {
            this.checkBalanceAlert(session)
          }
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

  /**
   * 前端通知「当前会话已切换」（dsh web 会话列表 current 变化）：立即
   * 把显示面切到新会话并强制刷新 git（切项目后 cwd 变化，不等 30s 懒
   * 刷新窗口）。sessionId 为 undefined = 回到无会话页（显示归档累计）。
   */
  setCurrentSession(sessionId: string | undefined): void {
    if (sessionId === undefined) {
      this.displaySession = undefined
      this.machine.onSessionDisposed()
      this.gitCwd = undefined
      this.gitAt = 0
      this.git = null
      return
    }
    const session = this.ctx.sessions?.get(sessionId as Session['header']['id'])
    if (session === undefined) return
    this.displaySession = session
    this.machine.onSessionActive()
    // 强制刷新 git：cwd 变化 → refreshGit 跳过 30s 窗口立即执行。
    this.gitCwd = undefined
    this.gitAt = 0
  }

  /** 把一次会话的官方口径快照累加进全局归档。 */
  private archiveSession(session: Session): void {
    const official = this.official
    if (official === undefined) return
    // 会话销毁前将其最终花费锁入余额预估的单调总额（否则切走后
    // 这段花费就不再参与未落账量计算）。
    this.accrueSessionSpend(session)
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
    const usage = this.readTokenUsage(session)
    if (usage !== null) {
      // 官方累计投影口径（与 StatsLine 同源）：四桶 + 命中率分母。
      // 峰谷分档：归档时间点在高峰时段内的整段会话花费计高峰档。
      const peak = isPeakHour()
      const { cost: billed, legacyCost: legacyBilled } = billFromUsage(usage, peak)
      this.archived.cost += billed
      if (peak) this.archived.peakCost += billed
      else this.archived.offPeakCost += billed
      // 涨价前一口价重算（对比用）。
      this.archived.legacyCost += legacyBilled
      const { chat, tool } = this.foodFromNodes(session, tm)
      const billedInput = usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
      this.archived.chatTokens += chat
      this.archived.toolTokens += tool
      this.archived.systemTokens += Math.max(0, billedInput - chat - tool)
    } else {
      // 无 provider usage 锚点（估算口径）：花费按总量×未命中价近似，峰谷分档。
      const peak = isPeakHour()
      const { cost: billed, legacyCost: legacyBilled } = billFromTokens(tm.totalTokens, peak)
      this.archived.cost += billed
      if (peak) this.archived.peakCost += billed
      else this.archived.offPeakCost += billed
      // 估算口径下涨价前重算：总量 × 旧未命中价（1.00）。
      this.archived.legacyCost += legacyBilled
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

  /** 官方 tokenUsage 投影（整段会话日志的累计四桶，与对话框底部 StatsLine 的
   * useProjection('tokenUsage') 同源同口径）；缺失时返回 null。 */
  private readTokenUsage(session: Session): OfficialTokenUsageProjection | null {
    const official = this.official
    if (official === undefined) return null
    const values = official.sessionProjections.snapshot(session).values
    const u = values.tokenUsage as OfficialTokenUsageProjection | undefined
    if (u === undefined || typeof u !== 'object') return null
    if (typeof u.uncachedInputTokens !== 'number'
      || typeof u.outputTokens !== 'number'
      || typeof u.cacheReadTokens !== 'number'
      || typeof u.cacheWriteTokens !== 'number') return null
    return u
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
      if (Date.now() - this.gitAt > GIT_REFRESH_MS * 2) {
        this.git = null
        this.gitCwd = undefined
      }
      return
    }
    if (this.gitFetching) return
    const cwd = session.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') return
    // 同 cwd 才走 30s 懒刷新窗口；切项目（cwd 变化，setCurrentSession
    // 置空 gitCwd）立即刷新，不等窗口过期。
    const cwdChanged = cwd !== this.gitCwd
    if (!cwdChanged && Date.now() - this.gitAt < GIT_REFRESH_MS) return
    this.gitCwd = cwd
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

  /** DeepSeek 余额：事件驱动查询。force=false 只读缓存不查官方；
   * force=true（用户发消息开始任务时）立即查一次官方。失败保留上次值，
   * 不做定时轮询。 */
  private refreshBalance(force = false): number | null {
    if (!force) return this.balanceCache
    if (this.balanceFetching) return this.balanceCache
    this.balanceFetching = true
    const key = loadDeepSeekKey()
    if (key === null) {
      this.balanceFetching = false
      return null
    }
    fetchDeepSeekBalance(key).then((value) => {
      this.reconcileBalance(value)
      this.balanceFetching = false
    }, () => {
      // 网络/API 失败：保留上次值，下次任务开始时再查。
      this.balanceFetching = false
    })
    return this.balanceCache
  }

  /**
   * 用一次官方余额读数对账。官方余额滞后于本地按次结算（分钟级
   * 延迟），所以不能在每次刷新时把「已花费」基线重置为当前累计——那等于
   * 把延迟窗口内已经产生、但官方还没扣的花费整段抹掉，预估余额凭空回弹。
   *
   * 改为两条账并行：
   *   - spentTotal：本地精确累计花费（单调不减）
   *   - landedCost：官方余额已经体现的扣费（官方余额每次下降的幅度累加）
   * 预估余额 = 官方余额 − (spentTotal − landedCost)。官方值持平（扣费未落账）
   * 时未落账部分继续变大，预估照旧下降；官方值落账下降时未落账部分等额
   * 缩小，预估保持连续，不会跳变、也不会重复扣。
   * @param value - 官方 /user/balance 返回的余额（元）。
   */
  private reconcileBalance(value: number): void {
    const spent = this.accrueSpend()
    const previous = this.balanceCache
    if (previous === null) {
      // 首个读数：无往期官方值可对比，把此前的本地花费视为已落账（启动
      // 时 spent 为 0，基线就是 0）。
      this.landedCost = spent
    } else if (value < previous) {
      // 官方余额下降 = 这一部分扣费已落账；上限收敛到本地累计（下降幅度
      // 超出本地口径通常是同一 key 在其他地方的用量，此时以官方值为准）。
      this.landedCost = Math.min(spent, this.landedCost + (previous - value))
    }
    // 官方值持平 = 扣费还没落账（landedCost 不动，未落账部分继续生效）；
    // 上升 = 充值，未落账部分照旧从新余额里扣。
    this.balanceCache = value
    // 预警复位以预估余额为准（官方原值偏乐观，会提前解除预警）。
    const estimated = this.estimatedBalance()
    if (this.balanceAlertThreshold > 0 && estimated !== null && estimated >= this.balanceAlertThreshold) {
      this.balanceAlertTriggered = false
    }
  }

  /** 把所有在世会话的最新花费差额计入 spentTotal，并返回单调累计总额（元）。
   * 余额是账户级的：子代理会话 / 其他项目的并行会话同样在花钱，只看当前
   * 显示的那一个会漏账（前端 2s 一次轮询，会话数量级很小，开销可忽略）。 */
  private accrueSpend(): number {
    const live = this.ctx.sessions?.list()
    if (live === undefined) {
      const active = this.displaySession
      if (active !== undefined) this.accrueSessionSpend(active)
      return this.spentTotal
    }
    for (const session of live) this.accrueSessionSpend(session)
    return this.spentTotal
  }

  /** 单会话增量入账：只累加「比上次读到的更多」的部分。同一段用量在峰谷
   * 价切换后重算金额会变小，取增量（不减）避免累计总额回退。 */
  private accrueSessionSpend(session: Session): void {
    const cost = this.sessionCost(session)
    if (cost === null) return
    const id = session.header.id as string
    const counted = this.sessionSpent.get(id) ?? 0
    if (cost <= counted) return
    this.spentTotal += cost - counted
    this.sessionSpent.set(id, cost)
  }

  /** 单个会话的当前累计花费（元，峰谷分档）：官方 tokenUsage 四桶优先，
   * 无 usage 锚点时退化为 tokenMeter 总量 × 未命中价估算；官方服务不可用
   * 返回 null（不参与余额预估，此时预估 = 官方余额）。 */
  private sessionCost(session: Session): number | null {
    const official = this.official
    if (official === undefined) return null
    const peak = isPeakHour()
    const usage = this.readTokenUsage(session)
    if (usage !== null) return billFromUsage(usage, peak).cost
    return billFromTokens(official.tokenMeter.measure(session).totalTokens, peak).cost
  }

  /** 预估剩余余额（元）= 官方余额 − 尚未落账的本地精确花费；
   * null = 官方余额不可用（预警不触发）。 */
  private estimatedBalance(): number | null {
    if (this.balanceCache === null) return null
    const pending = Math.max(0, this.accrueSpend() - this.landedCost)
    return Math.max(0, this.balanceCache - pending)
  }

  /**
   * 余额预警检查：预估剩余低于阈值 → 自动停止当前任务（等效用户按停止
   * 键）+ 置预警标记。阈值 0/负值或官方余额不可用时不触发；一次任务
   * 停止后直到余额回升到阈值之上才复位（防止连环误停）。
   */
  private checkBalanceAlert(session: Session | undefined): void {
    const threshold = this.balanceAlertThreshold
    if (threshold <= 0 || this.balanceAlertTriggered) return
    const estimated = this.estimatedBalance()
    if (estimated === null || estimated >= threshold) return
    this.balanceAlertTriggered = true
    // 等效用户按停止键：调 host 的 agent 注册表 cancel。dsh-agent 已把
    // ctx.agents 声明为必选（AgentRegistry），这里不重复 declare module，
    // 用本地最小面断言访问。
    const agents = (this.ctx as unknown as {
      agents?: { get(sessionId: Session['header']['id']): { cancel(cause: { kind: 'hook'; reason: string }): void } | undefined }
    }).agents
    const agent = session !== undefined ? agents?.get(session.header.id) : undefined
    agent?.cancel({ kind: 'hook', reason: 'blubby: 余额即将耗尽，已自动停止任务' })
    if (this.displaySession !== undefined) {
      this.machine.onActivityStatus({ phase: 'failed', line: '余额即将耗尽，已停止任务' })
    }
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
    let legacyCost = this.archived.legacyCost

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
        const usage = this.readTokenUsage(active)
        if (usage !== null) {
          // 官方累计投影（StatsLine 同源）——整个会话日志的累计四桶，不是最近
          // 一次请求。缓存命中率 = cacheRead / (uncached+cacheRead+cacheWrite)。
          const billedInput = usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
          const billed = billFromUsage(usage, isPeakHour())
          cost += billed.cost
          // 涨价前一口价重算（对比用）。
          legacyCost += billed.legacyCost
          // 官方 cacheHitPercent：分母为 0 时 null（不显示），不硬给 100。
          efficiency = billedInput > 0
            ? Math.round((usage.cacheReadTokens / billedInput) * 100)
            : null
          const { chat, tool } = this.foodFromNodes(active, tm)
          food = {
            chatTokens: this.archived.chatTokens + chat,
            toolTokens: this.archived.toolTokens + tool,
            systemTokens: this.archived.systemTokens + Math.max(0, billedInput - chat - tool),
          }
        } else {
          // 无 provider usage 锚点（估算口径）：花费按总量×未命中价近似。
          const billed = billFromTokens(tm.totalTokens, isPeakHour())
          cost += billed.cost
          // 估算口径下涨价前重算：总量 × 旧未命中价（1.00）。
          legacyCost += billed.legacyCost
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
        legacyCost += s.legacyCost ?? 0
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
      // 当前显示会话 id（前端用它判断切项目后的数据是否已刷新到位）。
      sessionId: this.displaySession?.header.id ?? null,
      // 养成统计：官方口径（sessionStats + tokenMeter）+ 会话归档累计。
      satiety,
      food,
      efficiency,
      cost,
      // 峰谷分档累计（本地事件时间戳口径）。
      peakCost: this.archived.peakCost,
      offPeakCost: this.archived.offPeakCost,
      // 涨价前一口价口径累计（对比用）。
      legacyCost,
      // DeepSeek 余额缓存（事件驱动：启动 + 用户发消息开始任务时查询）。
      balance: this.refreshBalance(),
      // 预估剩余余额 + 预警状态（前端渲染警示）。
      estimatedBalance: this.estimatedBalance(),
      balanceAlertThreshold: this.balanceAlertThreshold,
      balanceAlertTriggered: this.balanceAlertTriggered,
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

/**
 * 官方 tokenUsage 四桶累计 → 花费（元）：当前峰谷分档 + 涨价前一口价对比口径。
 * @param usage - 官方累计四桶（未命中输入 / 输出 / 缓存读 / 缓存写）。
 * @param peak - 是否高峰时段定价。
 */
function billFromUsage(usage: OfficialTokenUsageProjection, peak: boolean): { cost: number; legacyCost: number } {
  const uncached = usage.uncachedInputTokens + usage.cacheWriteTokens
  return {
    cost: usage.cacheReadTokens * (peak ? PRICE_CACHE_HIT_PEAK : PRICE_CACHE_HIT_OFF) / 1e6
      + uncached * (peak ? PRICE_UNCACHED_PEAK : PRICE_UNCACHED_OFF) / 1e6
      + usage.outputTokens * (peak ? PRICE_OUTPUT_PEAK : PRICE_OUTPUT_OFF) / 1e6,
    legacyCost: usage.cacheReadTokens * PRICE_CACHE_HIT_LEGACY / 1e6
      + uncached * PRICE_UNCACHED_LEGACY / 1e6
      + usage.outputTokens * PRICE_OUTPUT_LEGACY / 1e6,
  }
}

/**
 * 无 provider usage 锚点时的估算口径：总量 × 未命中价。
 * @param totalTokens - tokenMeter 量出的上下文总 token 数。
 * @param peak - 是否高峰时段定价。
 */
function billFromTokens(totalTokens: number, peak: boolean): { cost: number; legacyCost: number } {
  return {
    cost: totalTokens * (peak ? PRICE_UNCACHED_PEAK : PRICE_UNCACHED_OFF) / 1e6,
    legacyCost: totalTokens * PRICE_UNCACHED_LEGACY / 1e6,
  }
}

/** Plugin name (the cordis roster id). */
export const name = 'blubby'

/** Required host services: webServer（API/静态路由）; sessions（SessionStore，
 * current-session 切换需按 id 解析服务端 Session 对象）。 */
export const inject = ['webServer', 'sessions']

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

/* ------------------------------------------------------------------ *
 * DeepSeek 余额查询（官方 /user/balance）。
 * Key 来源（按优先级）：环境变量 DEEPSEEK_API_KEY → 插件根目录 .env。
 * ------------------------------------------------------------------ */

/** 读取 DeepSeek API key；找不到返回 null。 */
function loadDeepSeekKey(): string | null {
  const env = process.env.DEEPSEEK_API_KEY
  if (typeof env === 'string' && env.trim() !== '') return env.trim()
  try {
    const envFile = join(blubbyPackageRoot(import.meta.url), '.env')
    if (!existsSync(envFile)) return null
    const text = readFileSync(envFile, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*DEEPSEEK_API_KEY\s*=\s*(.+?)\s*$/.exec(line)
      if (m !== null && m[1] !== undefined) {
        const value = m[1].trim().replace(/^["']|["']$/g, '')
        return value === '' ? null : value
      }
    }
  } catch {
    return null
  }
  return null
}

/** 查询 DeepSeek 账户余额（元）；失败抛异常由调用方处理。 */
function fetchDeepSeekBalance(apiKey: string): Promise<number> {
  return fetch('https://api.deepseek.com/user/balance', {
    headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  }).then((response) => {
    if (!response.ok) throw new Error(`balance http ${response.status}`)
    return response.json() as Promise<{
      is_available?: boolean
      balance_infos?: { currency?: string; total_balance?: string }[]
    }>
  }).then((data) => {
    for (const info of data.balance_infos ?? []) {
      if (info.currency === 'CNY' && info.total_balance !== undefined) {
        const value = Number(info.total_balance)
        if (Number.isFinite(value)) return value
      }
    }
    const first = data.balance_infos?.[0]
    if (first !== undefined && first.total_balance !== undefined) {
      const value = Number(first.total_balance)
      if (Number.isFinite(value)) return value
    }
    throw new Error('balance 字段缺失')
  })
}
