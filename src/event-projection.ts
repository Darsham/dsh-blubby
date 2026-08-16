/**
 * Official session event projection — pure. Maps the durable DSH session
 * vocabulary onto the blubby visual phases, and folds the same event stream
 * into the session's feeding stats (口粮/花费/性能/饱腹度). Holds no state
 * of its own; callers keep a {@link ProjectionRuntime} per session and feed
 * events in arrival order.
 * @module dsh-blubby/event-projection
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { BlubbyStateInput } from './state.ts'

/**
 * DeepSeek 官方一口价（元 / 百万 tokens）——api-docs.deepseek.com
 * quick_start/pricing，2026-08-15 抓取。当前模型 deepseek-v4-flash：
 *   输入（缓存命中）0.02 / 输入（未命中）1 / 输出 2
 * ⚠️ 官方 2026-08-17 00:00 起改峰谷定价（空闲/高峰两档），用户拍板今天先
 * 按一口价，峰谷切换等通知。
 */
export const PRICE_CACHE_HIT = 0.02
export const PRICE_UNCACHED = 1
export const PRICE_OUTPUT = 2

/** 上下文窗口兜底（deepseek-v4-flash 官方 1M；request/context 会给真实值）。 */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000

/** 好撑阈值：饱腹度超过此百分比触发"好撑"特效（用户拍板 85）。 */
export const SATIETY_BURP_PERCENT = 85

/** 会话级养成统计（view() 直接读这份汇总）。 */
export interface BlubbySessionStats {
  /** 饱腹度：最近一次请求的输入占上下文窗口的百分比。 */
  satiety: { percent: number; usedTokens: number; contextWindow: number } | null
  /** 三种口粮（tokens，估算）：系统提示词 / 工具调用 / 对话消息。 */
  food: { systemTokens: number; toolTokens: number; chatTokens: number }
  /** 工作效率 = 缓存命中率（%），无输入时 null。 */
  efficiency: number | null
  /** 累计花费（元，一口价）。 */
  cost: number
  /** 累计 LLM 墙钟（ms，step/start → assistant/message）。 */
  llmMs: number
  /** 累计工具墙钟（ms，tool/call → tool/result）。 */
  toolMs: number
  /** 累计首 token 延迟（ms）。 */
  ttftMs: number
  /** 记录到首 token 的 step 数。 */
  ttftSteps: number
  /** 累计输出 tokens。 */
  outputTokens: number
  /** 吞吐（tok/s，输出/LLM 耗时），无 LLM 时长时 null。 */
  tokensPerSec: number | null
}

/** Per-session facts needed to project the official event stream. */
export interface ProjectionRuntime extends BlubbySessionStats {
  activeTools: Set<string>
  stepHadFailure: boolean
  /** Output tokens accumulated in the current turn (drives the fish snack). */
  turnTokens: number
  /** 累计输入分桶（计费用）：未缓存 / 缓存命中 / 缓存写入。 */
  uncachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** 最近一次请求的输入量（饱腹度分子）。 */
  lastBilledInput: number
  /** 最近一次请求的上下文窗口（饱腹度分母）。 */
  contextWindow: number
  /** 当前 step 的开始墙钟（LLM 耗时起点）。 */
  stepStartAt: number | undefined
  /** 当前 step 首个非空 chunk 墙钟（首 token 延迟）。 */
  firstChunkAt: number | undefined
  /** 口粮结算基线：step/start 时的累计值，assistant/message 时做增量。 */
  stepSettledChat: number
  stepSettledTool: number
  /** 工具开始墙钟（callId → 时间）。 */
  toolStartAt: Map<string, number>
}

/** One official event projection. */
export interface BlubbyActivityTransition {
  input: BlubbyStateInput
}

/** 粗略 token 估算：中文≈1 token/字、英文≈1 token/4 字符，混合取 2 字符。 */
function estTokens(text: string): number {
  if (!text) return 0
  return Math.max(1, Math.round(text.length / 2))
}

/** Fresh projection runtime for a newly seen session. */
export function emptyProjectionRuntime(): ProjectionRuntime {
  return {
    activeTools: new Set(),
    stepHadFailure: false,
    turnTokens: 0,
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    lastBilledInput: 0,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    stepStartAt: undefined,
    firstChunkAt: undefined,
    stepSettledChat: 0,
    stepSettledTool: 0,
    toolStartAt: new Map(),
    satiety: null,
    food: { systemTokens: 0, toolTokens: 0, chatTokens: 0 },
    efficiency: null,
    cost: 0,
    llmMs: 0,
    toolMs: 0,
    ttftMs: 0,
    ttftSteps: 0,
    outputTokens: 0,
    tokensPerSec: null,
  }
}

/** Keep tool names readable inside the compact status bubble. */
function displayToolName(name: string): string {
  const compact = name.replace(/\s+/g, ' ').trim() || '工具'
  return compact.length <= 24 ? compact : `${compact.slice(0, 21)}...`
}

/** 结算一次 assistant/message 的计费 + 口粮 + 性能统计。 */
function settleUsage(runtime: ProjectionRuntime, usage: {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
} | undefined): void {
  if (usage === undefined) return
  const uncached = usage.inputTokens ?? 0
  const cacheRead = usage.cacheReadTokens ?? 0
  const cacheWrite = usage.cacheWriteTokens ?? 0
  const output = usage.outputTokens ?? 0
  runtime.uncachedInputTokens = (runtime.uncachedInputTokens ?? 0) + uncached
  runtime.cacheReadTokens = (runtime.cacheReadTokens ?? 0) + cacheRead
  runtime.cacheWriteTokens = (runtime.cacheWriteTokens ?? 0) + cacheWrite
  runtime.outputTokens += output
  // 花费：一口价（元/百万 tokens）。
  runtime.cost += (
    cacheRead * PRICE_CACHE_HIT
    + (uncached + cacheWrite) * PRICE_UNCACHED
    + output * PRICE_OUTPUT
  ) / 1e6
  // 口粮结算：本 step 新增的对话/工具之外的输入归系统提示词（估算）。
  const stepChat = runtime.food.chatTokens - runtime.stepSettledChat
  const stepTool = runtime.food.toolTokens - runtime.stepSettledTool
  runtime.food.systemTokens += Math.max(0, uncached - stepChat - stepTool)
  // 饱腹度：最近一次请求的输入（含缓存命中）占上下文窗口。
  const billed = uncached + cacheRead + cacheWrite
  if (billed > 0) {
    runtime.lastBilledInput = billed
    const window = runtime.contextWindow > 0 ? runtime.contextWindow : DEFAULT_CONTEXT_WINDOW
    const percent = Math.min(100, Math.round(billed / window * 100))
    runtime.satiety = { percent, usedTokens: billed, contextWindow: window }
  }
  // 工作效率：缓存命中率（与 dsh UI StatsLine 同算法）。
  const total = (runtime.uncachedInputTokens ?? 0) + (runtime.cacheReadTokens ?? 0) + (runtime.cacheWriteTokens ?? 0)
  runtime.efficiency = total === 0 ? null : Math.round((runtime.cacheReadTokens ?? 0) / total * 100)
  // 性能：LLM 墙钟（step/start → 本次 assistant/message）、首 token、吞吐。
  // 每 step 只结算一次：结算后清掉计时器，防同一 step 多次 assistant/message
  // 重复累计整段时长。
  if (runtime.stepStartAt !== undefined) {
    if (runtime.firstChunkAt !== undefined) {
      runtime.ttftMs += Math.max(0, runtime.firstChunkAt - runtime.stepStartAt)
      runtime.ttftSteps += 1
    }
    runtime.llmMs += Math.max(0, Date.now() - runtime.stepStartAt)
    runtime.stepStartAt = undefined
    runtime.firstChunkAt = undefined
  }
  if (runtime.llmMs > 0) {
    runtime.tokensPerSec = Math.round(runtime.outputTokens / (runtime.llmMs / 1000))
  }
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
    case 'user/message':
      // 对话口粮：用户消息（含 agent.inject 的合成上下文）内容估算。
      runtime.food.chatTokens += estTokens(String((event.data as { content?: unknown }).content ?? ''))
      return { input: { phase: 'waiting', line: '收到你的话' } }
    case 'request/context': {
      // 上下文窗口（饱腹度分母）：取模型广告值。
      const ctx = event.data as { contextWindow?: number }
      if (typeof ctx.contextWindow === 'number' && ctx.contextWindow > 0) {
        runtime.contextWindow = ctx.contextWindow
      }
      return undefined
    }
    case 'step/start':
      runtime.activeTools.clear()
      runtime.stepHadFailure = false
      runtime.stepStartAt = Date.now()
      runtime.firstChunkAt = undefined
      runtime.stepSettledChat = runtime.food.chatTokens
      runtime.stepSettledTool = runtime.food.toolTokens
      // 不再进入 waiting「等待模型响应」：直接显示办公（打字）循环，与 Pwsh 阶段不区分。
      return { input: { phase: 'thinking', line: '开始处理' } }
    case 'assistant/chunk': {
      const { chunk } = event.data
      if (runtime.firstChunkAt === undefined) runtime.firstChunkAt = Date.now()
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
      settleUsage(runtime, usage)
      return { input: { phase: 'review', line: '整理回复中', tokens: runtime.turnTokens } }
    }
    case 'tool/call':
      runtime.activeTools.add(String(event.data.callId))
      runtime.toolStartAt.set(String(event.data.callId), Date.now())
      runtime.food.toolTokens += estTokens(event.data.arguments)
      return {
        input: {
          phase: 'tool',
          line: `正在使用 ${displayToolName(event.data.name)}`,
        },
      }
    case 'tool/result': {
      const block = event.data.message.content[0]
      runtime.activeTools.delete(String(event.data.message.source.callId))
      const startAt = runtime.toolStartAt.get(String(event.data.message.source.callId))
      if (startAt !== undefined) {
        runtime.toolMs += Math.max(0, Date.now() - startAt)
        runtime.toolStartAt.delete(String(event.data.message.source.callId))
      }
      // 工具口粮：结果内容估算（string 或 block[] 兼容）。
      const content = event.data.message.content
      if (typeof content === 'string') {
        runtime.food.toolTokens += estTokens(content)
      } else if (Array.isArray(content)) {
        for (const item of content) {
          if (item !== null && typeof item === 'object' && 'text' in item) {
            runtime.food.toolTokens += estTokens(String(item.text ?? ''))
          }
        }
      }
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
