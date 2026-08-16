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
  static inject: string[] = []

  private readonly machine: BlubbyStateMachine
  private enabled: boolean
  private disposeActivity: (() => void) | undefined
  /** Session whose most recent meaningful event currently drives the pet. */
  private displaySession: Session | undefined
  private readonly sessionActivity = new WeakMap<Session, ProjectionRuntime>()

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
          const runtime = this.activityRuntime(session)
          const transition = projectOfficialEvent(event, runtime)
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

  /** Return the projection state associated with one live session. */
  private activityRuntime(session: Session): ProjectionRuntime {
    let runtime = this.sessionActivity.get(session)
    if (runtime === undefined) {
      runtime = emptyProjectionRuntime()
      this.sessionActivity.set(session, runtime)
    }
    return runtime
  }

  /** Commit one activity as the host-global pet's most recent display state. */
  private applyActivity(session: Session, input: BlubbyStateInput): void {
    this.displaySession = session
    this.machine.onActivityStatus(input)
    this.machine.onSessionActive()
  }

  private view(): BlubbyStateView {
    const snapshot = this.machine.render()
    return {
      track: snapshot.track,
      ...(snapshot.bubble === undefined ? {} : { bubble: snapshot.bubble }),
      phase: snapshot.phase,
      sessionActive: snapshot.sessionActive,
      stateStartedAt: snapshot.stateStartedAt,
      ...(snapshot.tokens === undefined ? {} : { tokens: snapshot.tokens }),
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
