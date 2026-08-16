/**
 * Official session event projection — pure. Maps the durable DSH session
 * vocabulary onto the blubby visual phases. Holds no state of its own;
 * callers keep a {@link ProjectionRuntime} per session and feed events in
 * arrival order.
 * @module dsh-blubby/event-projection
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { BlubbyStateInput } from './state.ts'

/** Per-session facts needed to project the official event stream. */
export interface ProjectionRuntime {
  activeTools: Set<string>
  stepHadFailure: boolean
  /** Output tokens accumulated in the current turn (drives the fish snack). */
  turnTokens: number
}

/** One official event projection. */
export interface BlubbyActivityTransition {
  input: BlubbyStateInput
}

/** Fresh projection runtime for a newly seen session. */
export function emptyProjectionRuntime(): ProjectionRuntime {
  return { activeTools: new Set(), stepHadFailure: false, turnTokens: 0 }
}

/** Keep tool names readable inside the compact status bubble. */
function displayToolName(name: string): string {
  const compact = name.replace(/\s+/g, ' ').trim() || '工具'
  return compact.length <= 24 ? compact : `${compact.slice(0, 21)}...`
}

/**
 * Project the durable DSH session vocabulary into the blubby visual phases.
 * Unknown and log-only events do not disturb the last meaningful activity.
 */
export function projectOfficialEvent(
  event: SessionEvent,
  runtime: ProjectionRuntime,
): BlubbyActivityTransition | undefined {
  switch (event.type) {
    case 'turn/start':
      runtime.activeTools.clear()
      runtime.stepHadFailure = false
      runtime.turnTokens = 0
      return { input: { phase: 'waiting', line: '准备开始', tokens: 0 } }
    case 'step/start':
      runtime.activeTools.clear()
      runtime.stepHadFailure = false
      return { input: { phase: 'waiting', line: '等待模型响应' } }
    case 'assistant/chunk': {
      const { chunk } = event.data
      if (chunk.type === 'reasoning-delta' && chunk.text.length > 0) {
        return { input: { phase: 'thinking', line: '正在思考' } }
      }
      if (chunk.type === 'text-delta' && chunk.text.length > 0) {
        return { input: { phase: 'review', line: '整理回复中' } }
      }
      return undefined
    }
    case 'assistant/message': {
      // Accumulate output tokens for the current turn (fish snack reward).
      const usage = event.data.usage
      if (usage !== undefined && Number.isFinite(usage.outputTokens) && usage.outputTokens > 0) {
        runtime.turnTokens += usage.outputTokens
      }
      return { input: { phase: 'review', line: '整理回复中', tokens: runtime.turnTokens } }
    }
    case 'tool/call':
      runtime.activeTools.add(String(event.data.callId))
      return {
        input: {
          phase: 'tool',
          line: `正在使用 ${displayToolName(event.data.name)}`,
        },
      }
    case 'tool/result': {
      const block = event.data.message.content[0]
      runtime.activeTools.delete(String(event.data.message.source.callId))
      runtime.stepHadFailure ||= event.data.error !== undefined || block.isError === true
      if (runtime.activeTools.size > 0) {
        return {
          input: {
            phase: 'tool',
            line: `还有 ${runtime.activeTools.size} 个工具运行中`,
          },
        }
      }
      return runtime.stepHadFailure
        ? { input: { phase: 'failed', line: '工具执行失败' } }
        : { input: { phase: 'thinking', line: '处理工具结果' } }
    }
    case 'turn/end': {
      runtime.activeTools.clear()
      switch (event.data.reason.kind) {
        case 'completed':
          return { input: { phase: 'done', line: '完成啦' } }
        case 'error':
          return { input: { phase: 'failed', line: '执行失败' } }
        case 'max-tokens':
          return { input: { phase: 'failed', line: '达到输出上限' } }
        case 'interrupted':
          return { input: { phase: 'failed', line: '执行意外中断' } }
        case 'blocked':
          return { input: { phase: 'waiting', line: '等待继续' } }
        case 'aborted':
          return { input: { phase: 'idle', line: '已停止' } }
        default:
          return { input: { phase: 'idle' } }
      }
    }
    default:
      return undefined
  }
}
