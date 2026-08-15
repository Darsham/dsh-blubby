/**
 * blubby state machine — pure, clock-injected. Maps official DSH session
 * activity onto the 5-track video animation contract:
 *   idle    → 完整游泳（下半屏随机游）
 *   waiting → 疑惑脸（鼠标 hover 时本地切，也用于等待模型响应）
 *   running → 办公（模型思考/用工具/整理回复）
 *   done    → 吃饱（任务完成，投鱼食）
 *   failed  → 挨扇了（报错）
 * The machine is deliberately dumb: it holds the last input phase and the
 * animation decision. Everything here is a pure function of (input, nowMs);
 * persistence and RPC live in the service.
 * @module dsh-blubby/state
 */

/** Activity phases understood by the blubby host. */
export type BlubbyPhase = 'idle' | 'waiting' | 'thinking' | 'tool' | 'review' | 'done' | 'failed'

/** The 5-track video animation contract (assets/blubby/*.mp4). */
export type BlubbyTrack = 'idle' | 'waiting' | 'running' | 'done' | 'failed'

/** One input snapshot consumed by the machine. */
export interface BlubbyStateInput {
  /** Current activity phase of the active session. */
  phase: BlubbyPhase
  /** Human-readable status line (plain text). */
  line?: string
}

/** Animation decision plus the copy the pet should show. */
export interface BlubbyStateSnapshot {
  /** Which video track to play. */
  track: BlubbyTrack
  /** Optional status bubble copy (line or phrase), shown while active. */
  bubble?: string
  /** Wall-clock ms this state started (client can sync loops). */
  stateStartedAt: number
  /** Raw phase, for debugging and client-side rendering decisions. */
  phase: BlubbyPhase
  /** True when there is an active session (pet mounted). */
  sessionActive: boolean
}

/**
 * Map one activity phase onto the video track:
 * - thinking/tool/review → running (办公)
 * - waiting → waiting (疑惑脸)
 * - done → done (吃饱, 一次性)
 * - failed → failed (挨扇, 一次性)
 * - idle → idle (游泳)
 */
export function trackForPhase(phase: BlubbyPhase): BlubbyTrack {
  switch (phase) {
    case 'thinking': return 'running'
    case 'tool': return 'running'
    case 'review': return 'running'
    case 'waiting': return 'waiting'
    case 'done': return 'done'
    case 'failed': return 'failed'
    case 'idle': return 'idle'
  }
}

/**
 * BlubbyStateMachine — one instance per host process. Holds only the latest
 * input snapshot; no storage, no side effects.
 */
export class BlubbyStateMachine {
  private phase: BlubbyPhase = 'idle'
  private line: string | undefined
  private sessionActive = false
  private enteredAt: number | undefined

  constructor(
    private readonly now: () => number = Date.now,
  ) {}

  /** Consume one projected activity update. */
  onActivityStatus(input: BlubbyStateInput): void {
    this.phase = input.phase
    this.line = input.line
    this.enteredAt = this.now()
  }

  /** A session became the active one (or a fresh session started). */
  onSessionActive(): void {
    this.sessionActive = true
  }

  /** The active session was disposed (or none left). */
  onSessionDisposed(): void {
    this.sessionActive = false
    this.phase = 'idle'
    this.line = undefined
    this.enteredAt = undefined
  }

  /**
   * Render the current animation decision. One-shot tracks (done/failed)
   * settle back to idle once their video has played out — the host cannot
   * know the video length, so the machine times them out after a fixed
   * window matching the asset durations (done ≈ 4.1s, failed ≈ 7.1s).
   */
  render(): BlubbyStateSnapshot {
    const nowMs = this.now()
    let track = trackForPhase(this.phase)
    if ((this.phase === 'done' || this.phase === 'failed') && this.enteredAt !== undefined) {
      const elapsed = nowMs - this.enteredAt
      const settleMs = this.phase === 'done' ? DONE_SETTLE_MS : FAILED_SETTLE_MS
      if (elapsed >= settleMs) {
        this.phase = 'idle'
        this.line = undefined
        track = 'idle'
      }
    }
    return {
      track,
      ...(this.line === undefined ? {} : { bubble: this.line }),
      stateStartedAt: nowMs,
      phase: this.phase,
      sessionActive: this.sessionActive,
    }
  }
}

/** How long the done (吃饱) track plays before settling back to idle (ms). */
export const DONE_SETTLE_MS = 4500
/** How long the failed (挨扇) track plays before settling back to idle (ms). */
export const FAILED_SETTLE_MS = 7500
