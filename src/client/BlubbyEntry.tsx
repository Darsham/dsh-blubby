/**
 * BlubbyEntry — the floating 小咕噜. One React root on document.body,
 * driven by the host snapshot polled every 2s. The pet plays segmented
 * keyframe sequences (transparent webp, no mp4): each state is split into
 * initial → enter → doing → exit segments, and the playback mode per track
 * decides what loops:
 *   - idle    (游泳): full playlist loop (initial→enter→doing×3→exit→…)
 *   - waiting (疑惑): play initial+enter once, then HOLD the歪头 doing frame
 *   - running (办公): loop ONLY the doing (敲键盘) segment — no 思考 transition
 *   - done    (吃饱): one-shot, fish snack drops into the open mouth (CSS-drawn)
 *   - failed  (挨扇): one-shot, settles back to idle
 * The pet faces the direction it swims: source frames face right, moving
 * left mirrors with scaleX(-1). It is draggable anywhere in the viewport.
 * @module dsh-blubby/client/BlubbyEntry
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { BlubbyStateView } from '../index.ts'
import type { BlubbyTrack } from '../state.ts'

/** Segment manifest shape (mirrors assets/blubby/segments.json). */
export interface BlubbySegments {
  frameMs: number
  size: number
  states: Record<BlubbyTrack, {
    segments: Record<'initial' | 'enter' | 'doing' | 'exit', string[]>
  }>
}

/** Props injected by the plugin apply body. */
export interface BlubbyInjected {
  /** Latest host snapshot; null before the first successful fetch. */
  snapshot: BlubbyStateView | null
  /** True when the last poll failed (show a sad placeholder). */
  transportFailed: boolean
  /** Segment manifest loaded from /blubby/segments.json. */
  segments: BlubbySegments | null
}

/** Playback mode per track. */
type PlayMode = 'loop-full' | 'loop-doing' | 'hold' | 'one-shot'

/** Which mode each track uses. */
const PLAY_MODES: Record<BlubbyTrack, PlayMode> = {
  idle: 'loop-full',     // 游泳：完整循环
  waiting: 'hold',       // 疑惑：保持歪头不动
  running: 'loop-doing', // 办公：只循环敲键盘
  done: 'one-shot',      // 吃饱：一次性
  failed: 'one-shot',    // 挨扇：一次性
}

/** How many times the doing segment repeats in loop-full / one-shot. */
const DOING_REPEAT = 3

/** The bottom-right desk spot the pet parks at while 办公. */
const DESK_RIGHT = 32
const DESK_BOTTOM = 96

/** Pet rendered size (source frames are 240x240; scale to a desktop pet). */
const PET_SIZE = 220

/** Fixed spawn position (bottom area, never random — the pet must not jump
 * before it starts swimming). */
function initialPos(): { left: number; top: number } {
  return {
    left: Math.max(8, window.innerWidth - PET_SIZE - DESK_RIGHT - 120),
    top: Math.max(Math.round(window.innerHeight * 0.6), window.innerHeight - PET_SIZE - DESK_BOTTOM),
  }
}

/** Horizontal step range per wander move (px). */
const WANDER_STEP_MIN = 120
const WANDER_STEP_MAX = 260
/** How long a swim direction is held before it may switch (ms). */
const SWIM_DIR_HOLD_MS = 10000
/** Chance to switch direction when the hold expires. */
const SWIM_DIR_SWITCH_CHANCE = 0.35

/**
 * Build the flat frame playlist for a track per its play mode:
 *   loop-full : initial → enter → doing×3 → exit (cycle forever)
 *   loop-doing: doing (cycle the doing segment only)
 *   hold      : initial → enter → doing[0] (stop on the歪头 frame)
 *   one-shot  : initial → enter → doing×3 → exit (play once, hold last)
 */
function buildPlaylist(track: BlubbyTrack, segments: BlubbySegments | null): string[] | null {
  if (!segments) return null
  const state = segments.states[track]
  if (!state) return null
  const seg = state.segments
  const doing = seg.doing
  const mode = PLAY_MODES[track]
  if (mode === 'loop-doing') return [...doing]
  const holdFrame = doing[0]
  if (mode === 'hold') return [...seg.initial, ...seg.enter, ...(holdFrame ? [holdFrame] : [])]
  const repeated: string[] = []
  for (let i = 0; i < DOING_REPEAT; i += 1) repeated.push(...doing)
  return [...seg.initial, ...seg.enter, ...repeated, ...seg.exit]
}

/**
 * The floating pet body. Pure presentational: reads the snapshot, plays the
 * right segmented sequence, and handles local interactions (drag, hover,
 * wander, fish snack).
 */
export function BlubbyEntry({ snapshot, transportFailed, segments }: BlubbyInjected): ReturnType<typeof createPortal> {
  const hostTrack: BlubbyTrack = snapshot?.track ?? 'idle'
  // Local override: hover shows 疑惑脸 regardless of host activity.
  const [hovered, setHovered] = useState(false)
  // Local override: one-shot done/failed already played out client-side
  // while the host still reports the track (poll lag); settle locally.
  const [settledIdle, setSettledIdle] = useState(false)
  // Wander position for idle swimming (left/top so dragging is direct).
  // Initial position is FIXED — never random, so the pet does not jump
  // before it starts swimming.
  const [pos, setPos] = useState(initialPos)
  const [dragging, setDragging] = useState(false)
  // Facing: source frames face right; mirror when moving/swimming left.
  const [facingLeft, setFacingLeft] = useState(false)
  // Fish snack drops (done state, CSS-drawn — no asset). Multiple snacks
  // when the turn consumed more output tokens.
  const [snacks, setSnacks] = useState<{ id: number; delayMs: number }[]>([])
  const dragRef = useRef<{ offsetX: number; offsetY: number } | null>(null)
  const lastPosRef = useRef(pos)
  const wanderTimer = useRef<number | undefined>(undefined)
  const dirTimer = useRef<number | undefined>(undefined)
  // Current swim direction: +1 right (source facing) / -1 left (mirrored).
  const swimDir = useRef<1 | -1>(1)

  const track: BlubbyTrack = hovered && !dragging ? 'waiting' : settledIdle ? 'idle' : hostTrack

  // ---- drag to anywhere ----
  const onPointerDown = (e: React.PointerEvent): void => {
    e.preventDefault()
    setDragging(true)
    setHovered(false)
    dragRef.current = { offsetX: e.clientX - pos.left, offsetY: e.clientY - pos.top }
  }
  useEffect(() => {
    if (!dragging) return
    const onMove = (e: PointerEvent): void => {
      const off = dragRef.current
      if (!off) return
      const left = e.clientX - off.offsetX
      const top = e.clientY - off.offsetY
      const maxLeft = window.innerWidth - PET_SIZE
      const maxTop = window.innerHeight - PET_SIZE
      const clamped = { left: Math.max(0, Math.min(maxLeft, left)), top: Math.max(0, Math.min(maxTop, top)) }
      setPos(clamped)
      // Face the drag direction.
      if (clamped.left < lastPosRef.current.left - 2) setFacingLeft(true)
      else if (clamped.left > lastPosRef.current.left + 2) setFacingLeft(false)
      lastPosRef.current = clamped
    }
    const onUp = (): void => {
      setDragging(false)
      dragRef.current = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [dragging])

  // Idle swimming: swim CONTINUOUSLY in the current direction, holding the
  // direction for SWIM_DIR_HOLD_MS before it may switch. Moving left mirrors
  // the pet (facingLeft). The position changes by a fixed step per move, so
  // the pet never teleports — only the direction can change.
  useEffect(() => {
    if (track !== 'idle' || dragging) {
      if (wanderTimer.current !== undefined) {
        window.clearTimeout(wanderTimer.current)
        wanderTimer.current = undefined
      }
      if (dirTimer.current !== undefined) {
        window.clearTimeout(dirTimer.current)
        dirTimer.current = undefined
      }
      // 办公/完成: park at the desk spot.
      if (track === 'running' || track === 'done') {
        const desk = {
          left: window.innerWidth - PET_SIZE - DESK_RIGHT,
          top: window.innerHeight - PET_SIZE - DESK_BOTTOM,
        }
        setPos(desk)
        lastPosRef.current = desk
      }
      return
    }

    const maxLeft = window.innerWidth - PET_SIZE - 8
    const minLeft = 8
    const maxTop = window.innerHeight - PET_SIZE - 8
    const minTop = Math.round(window.innerHeight * 0.55)

    const swim = (): void => {
      setPos((current) => {
        let dir = swimDir.current
        const step = WANDER_STEP_MIN + Math.random() * (WANDER_STEP_MAX - WANDER_STEP_MIN)
        let nextLeft = current.left + dir * step
        // Bounce off the edges: force direction back inward.
        if (nextLeft < minLeft) {
          nextLeft = minLeft + Math.random() * 60
          dir = 1
        } else if (nextLeft > maxLeft) {
          nextLeft = maxLeft - Math.random() * 60
          dir = -1
        }
        if (dir !== swimDir.current) swimDir.current = dir
        // Vertical: stay within the lower band, small jitter.
        const nextTop = Math.min(maxTop, Math.max(minTop, minTop + Math.random() * Math.min(140, window.innerHeight * 0.18)))
        setFacingLeft(dir === -1)
        lastPosRef.current = { left: nextLeft, top: nextTop }
        return { left: nextLeft, top: nextTop }
      })
      wanderTimer.current = window.setTimeout(swim, 3500)
    }

    const maybeSwitchDir = (): void => {
      // After the hold, maybe turn around (keeps the pet from zig-zagging).
      if (Math.random() < SWIM_DIR_SWITCH_CHANCE) {
        swimDir.current = (swimDir.current === 1 ? -1 : 1)
      }
      dirTimer.current = window.setTimeout(maybeSwitchDir, SWIM_DIR_HOLD_MS)
    }

    wanderTimer.current = window.setTimeout(swim, 2500)
    dirTimer.current = window.setTimeout(maybeSwitchDir, SWIM_DIR_HOLD_MS)
    return () => {
      if (wanderTimer.current !== undefined) window.clearTimeout(wanderTimer.current)
      if (dirTimer.current !== undefined) window.clearTimeout(dirTimer.current)
      wanderTimer.current = undefined
      dirTimer.current = undefined
    }
  }, [track, dragging])

  // Reset the local settled flag when the host reports a fresh one-shot.
  useEffect(() => {
    if (hostTrack !== 'done' && hostTrack !== 'failed') setSettledIdle(false)
  }, [hostTrack])

  // ---- segmented frame player ----
  const playlist = useMemo(() => buildPlaylist(track, segments), [track, segments])
  const [frameIdx, setFrameIdx] = useState(0)
  const frameMs = segments?.frameMs ?? 125

  // Preload the whole playlist so frame switches never flash white.
  useEffect(() => {
    if (!playlist) return
    for (const name of playlist) {
      const img = new Image()
      img.src = `/blubby/frames/${name}`
    }
  }, [playlist])

  // Restart the playlist whenever the track changes.
  useEffect(() => {
    setFrameIdx(0)
  }, [track, segments])

  // Advance the playlist on a fixed rhythm per play mode.
  useEffect(() => {
    if (!playlist) return
    const timer = window.setInterval(() => {
      setFrameIdx((idx) => {
        const next = idx + 1
        if (next < playlist.length) return next
        // End of playlist:
        if (track === 'waiting') return idx // hold the歪头 frame
        if (PLAY_MODES[track] === 'one-shot') return idx // hold last exit frame
        return 0 // loop-full / loop-doing: cycle
      })
    }, frameMs)
    return () => window.clearInterval(timer)
  }, [playlist, track, frameMs])

  // One-shot finished (we're holding the final frame): settle locally.
  useEffect(() => {
    if (PLAY_MODES[track] === 'one-shot' && playlist && frameIdx === playlist.length - 1) {
      setSettledIdle(true)
    }
  }, [track, playlist, frameIdx])

  // Fish snacks: when the done track plays the open-mouth frame, drop
  // CSS-drawn snacks from above into the mouth (~48% height, 50% width).
  // The count scales with the turn's output tokens (more tokens → more food).
  const frameUrl = playlist ? `/blubby/frames/${playlist[frameIdx]}` : null
  useEffect(() => {
    if (track !== 'done' || !playlist) return
    // The open-mouth frame is the 3rd frame of the enter segment: find its
    // index in the playlist (after initial).
    const enterStart = segments?.states.done.segments.initial.length ?? 5
    if (frameIdx === enterStart + 2 && snacks.length === 0) {
      const tokens = snapshot?.tokens ?? 0
      // 1 snack per 1500 output tokens, 1..5 total.
      const count = Math.min(5, Math.max(1, Math.ceil(tokens / 1500)))
      setSnacks(Array.from({ length: count }, (_, i) => ({ id: i, delayMs: i * 180 })))
    }
    if (frameIdx >= playlist.length - 3) setSnacks([]) // mouth closed again
  }, [track, frameIdx, playlist, segments, snacks, snapshot])

  const bubble = !hovered ? snapshot?.bubble : undefined

  const float = (
    <div
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        zIndex: 2147483000,
        width: PET_SIZE,
        height: PET_SIZE,
        pointerEvents: 'auto',
        cursor: dragging ? 'grabbing' : 'grab',
        // No position transition while dragging (must follow the mouse).
        transition: dragging ? 'none' : 'left 1.2s ease-in-out, top 1.2s ease-in-out',
        userSelect: 'none',
        touchAction: 'none',
      }}
      onPointerDown={onPointerDown}
      onMouseEnter={() => { if (!dragging) setHovered(true) }}
      onMouseLeave={() => setHovered(false)}
    >
      <img
        src={frameUrl ?? ''}
        alt="小咕噜"
        draggable={false}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          display: 'block',
          transform: facingLeft ? 'scaleX(-1)' : undefined,
          background: 'transparent',
        }}
      />
      {/* CSS-drawn fish snacks (done state), no asset — one per 1500 tokens */}
      {snacks.map((s) => (
        <div
          key={s.id}
          style={{
            position: 'absolute',
            left: '50%',
            top: '-14%',
            width: 30,
            height: 16,
            transform: 'translateX(-50%)',
            zIndex: -1,
            opacity: 0,
            animation: `dshBlubbySnackDrop 0.7s ease-in ${s.delayMs}ms forwards`,
          }}
        >
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'radial-gradient(circle at 30% 40%, #ffb347, #ff8c00)',
              borderRadius: '50% 50% 50% 50% / 60% 60% 40% 40%',
              boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
            }}
          />
          <div
            style={{
              position: 'absolute',
              right: -8,
              top: '50%',
              width: 12,
              height: 8,
              background: '#ff8c00',
              clipPath: 'polygon(0 0, 100% 50%, 0 100%)',
              transform: 'translateY(-50%)',
            }}
          />
        </div>
      ))}
      <style>{`
        @keyframes dshBlubbySnackDrop {
          from { top: -14%; transform: translateX(-50%) rotate(0deg); opacity: 1; }
          to   { top: 46%; transform: translateX(-50%) rotate(20deg); opacity: 1; }
        }
      `}</style>
      {bubble !== undefined && (
        <div
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 8px)',
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(20,20,30,0.85)',
            color: '#fff',
            fontSize: 12,
            lineHeight: '16px',
            padding: '4px 10px',
            borderRadius: 12,
            whiteSpace: 'nowrap',
            maxWidth: 200,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
          }}
        >
          {bubble}
        </div>
      )}
      {transportFailed && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 12,
            color: '#888',
            background: 'rgba(255,255,255,0.5)',
            borderRadius: 12,
          }}
        >
          😵 连不上了
        </div>
      )}
    </div>
  )

  return createPortal(float, document.body)
}
