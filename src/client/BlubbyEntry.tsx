/**
 * BlubbyEntry — the floating 小咕噜. One React root on document.body,
 * driven by the host snapshot polled every 2s. The pet plays segmented
 * keyframe sequences (transparent webp, no mp4): each state is split into
 * initial → enter → doing → exit segments, and the playback mode per track
 * decides what loops:
 *   - idle    (游泳): loop the doing (划水) segment forever — the pet swims
 *                      continuously, position moves only during doing frames
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
  idle: 'loop-doing',    // 游泳：一直游（只循环划水 doing，位置持续移动）
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

/** Step distance per doing frame (px) — constant speed in ANY direction
 * (left/right/up/down/diagonals all move the same distance per frame). */
const SWIM_STEP_PX = 3
/** Max vertical angle off horizontal (radians) — slight up/down drift. */
const SWIM_MAX_TILT = Math.PI / 7

/** A built playlist: flat frames plus the doing segment's index range
 * (the only frames during which the pet may move while swimming). */
export interface BlubbyPlaylist {
  frames: string[]
  /** First index of the doing segment (inclusive). */
  doingStart: number
  /** One past the last doing index (exclusive). */
  doingEnd: number
}

/**
 * Build the flat frame playlist for a track per its play mode:
 *   loop-full : initial → enter → doing×3 → exit (cycle forever)
 *   loop-doing: doing (cycle the doing segment only)
 *   hold      : initial → enter → doing[0] (stop on the歪头 frame)
 *   one-shot  : initial → enter → doing×3 → exit (play once, hold last)
 */
function buildPlaylist(track: BlubbyTrack, segments: BlubbySegments | null): BlubbyPlaylist | null {
  if (!segments) return null
  const state = segments.states[track]
  if (!state) return null
  const seg = state.segments
  const doing = seg.doing
  const mode = PLAY_MODES[track]
  if (mode === 'loop-doing') return { frames: [...doing], doingStart: 0, doingEnd: doing.length }
  const holdFrame = doing[0]
  if (mode === 'hold') {
    const frames = [...seg.initial, ...seg.enter, ...(holdFrame ? [holdFrame] : [])]
    return { frames, doingStart: -1, doingEnd: -1 } // no movement while holding
  }
  const repeated: string[] = []
  for (let i = 0; i < DOING_REPEAT; i += 1) repeated.push(...doing)
  const frames = [...seg.initial, ...seg.enter, ...repeated, ...seg.exit]
  return {
    frames,
    doingStart: seg.initial.length + seg.enter.length,
    doingEnd: seg.initial.length + seg.enter.length + repeated.length,
  }
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
  // True while the pet is actively swimming (doing frames move the position).
  const [swimming, setSwimming] = useState(false)
  // Facing: source frames face right; mirror when moving/swimming left.
  const [facingLeft, setFacingLeft] = useState(false)
  // Fish snack drops (done state, CSS-drawn — no asset). Multiple snacks
  // when the turn consumed more output tokens.
  const [snacks, setSnacks] = useState<{ id: number; delayMs: number }[]>([])
  const dragRef = useRef<{ offsetX: number; offsetY: number } | null>(null)
  const lastPosRef = useRef(pos)
  // Current swim direction as an angle in radians: 0 → right (source facing),
  // π → left (mirrored). Vertical tilt stays within ±SWIM_MAX_TILT.
  const swimAngle = useRef(0)

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

  // Park at the desk spot while 办公/完成 (and clear any swim timers).
  useEffect(() => {
    if (track === 'running' || track === 'done') {
      const desk = {
        left: window.innerWidth - PET_SIZE - DESK_RIGHT,
        top: window.innerHeight - PET_SIZE - DESK_BOTTOM,
      }
      setPos(desk)
      lastPosRef.current = desk
    }
  }, [track])

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
    for (const name of playlist.frames) {
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
        if (next < playlist.frames.length) return next
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
    if (PLAY_MODES[track] === 'one-shot' && playlist && frameIdx === playlist.frames.length - 1) {
      setSettledIdle(true)
    }
  }, [track, playlist, frameIdx])

  // ---- swimming movement: ONLY during the doing frames ----
  // Each doing frame moves the pet by SWIM_STEP_PX along swimAngle (constant
  // speed in any direction). initial/enter/exit frames (dive in/out) keep the
  // pet in place. Direction switches happen on SWIM_DIR_HOLD_MS.
  const minLeft = 8
  const maxLeft = () => window.innerWidth - PET_SIZE - 8
  const minTop = Math.round((typeof window !== 'undefined' ? window.innerHeight : 800) * 0.55)
  const maxTop = () => window.innerHeight - PET_SIZE - 8

  useEffect(() => {
    if (track !== 'idle' || dragging || !playlist) return
    const inDoing = frameIdx >= playlist.doingStart && frameIdx < playlist.doingEnd
    setSwimming(inDoing)
    if (!inDoing) return
    setPos((current) => {
      let angle = swimAngle.current
      let dx = Math.cos(angle) * SWIM_STEP_PX
      let dy = Math.sin(angle) * SWIM_STEP_PX
      let nextLeft = current.left + dx
      let nextTop = current.top + dy
      // Bounce off the edges: reflect the offending axis.
      if (nextLeft < minLeft) {
        nextLeft = minLeft
        angle = Math.PI - angle
      } else if (nextLeft > maxLeft()) {
        nextLeft = maxLeft()
        angle = Math.PI - angle
      }
      if (nextTop < minTop) {
        nextTop = minTop
        angle = -angle
      } else if (nextTop > maxTop()) {
        nextTop = maxTop()
        angle = -angle
      }
      swimAngle.current = angle
      setFacingLeft(Math.cos(angle) < -0.1)
      lastPosRef.current = { left: nextLeft, top: nextTop }
      return { left: nextLeft, top: nextTop }
    })
  }, [track, frameIdx, playlist, dragging])

  // Clear swimming flag when leaving idle (e.g. hover → waiting, working).
  useEffect(() => {
    if (track !== 'idle' || dragging) setSwimming(false)
  }, [track, dragging])

  // Fish snacks: when the done track plays the open-mouth frame, drop
  // CSS-drawn snacks from above into the mouth (~48% height, 50% width).
  // The count scales with the turn's output tokens (more tokens → more food).
  const frameUrl = playlist ? `/blubby/frames/${playlist.frames[frameIdx]}` : null
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
    if (frameIdx >= playlist.frames.length - 3) setSnacks([]) // mouth closed again
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
        // While swimming the position updates every frame (125ms): a short
        // linear transition keeps it smooth with no smear. Dragging and
        // park-moves use the long ease for a gentle glide.
        transition: dragging
          ? 'none'
          : swimming
            ? 'left 125ms linear, top 125ms linear'
            : 'left 1.2s ease-in-out, top 1.2s ease-in-out',
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
