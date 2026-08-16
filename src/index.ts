/**
 * dsh-blubby host half — one Service per profile. Subscribes the official
 * session vocabulary, projects it into the 5-track blubby animation contract
 * and exposes /api/blubby/* JSON endpoints plus the /blubby/* asset prefix
 * (the raw mp4 videos the browser half plays).
 * @module dsh-blubby
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import {
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

  constructor(ctx: Context, config: BlubbyConfig = {}) {
    super(ctx, 'blubby')
    this.machine = new BlubbyStateMachine()
    this.enabled = config.enabled ?? true
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
          // 动画状态跟踪最近一次事件；统计在全局 stats 上跨会话累计。
          const transition = projectOfficialEvent(event, this.stats)
          if (transition === undefined) return
          this.applyActivity(session, transition.input)
        }),
        this.ctx.on('session/disposed', (session: Session) => {
          if (session !== this.displaySession) return
          this.displaySession = undefined
          this.machine.onSessionDisposed()
        }),
      ]
      return () => { for (const dispose of disposers) dispose() }
    })()
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
    return {
      track: snapshot.track,
      ...(snapshot.bubble === undefined ? {} : { bubble: snapshot.bubble }),
      phase: snapshot.phase,
      sessionActive: snapshot.sessionActive,
      stateStartedAt: snapshot.stateStartedAt,
      ...(snapshot.tokens === undefined ? {} : { tokens: snapshot.tokens }),
      // 养成统计：全局累计，跨会话保留（会话 dispose 不清空）。
      satiety: s.satiety,
      food: s.food,
      efficiency: s.efficiency,
      cost: s.cost,
      stats: {
        llmMs: s.llmMs,
        toolMs: s.toolMs,
        ttftMs: s.ttftMs,
        ttftSteps: s.ttftSteps,
        tokensPerSec: s.tokensPerSec,
      },
    }
  }
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
