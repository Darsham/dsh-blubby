/**
 * BlubbyEntry — the floating 小咕噜. One React root on document.body,
 * driven by the host snapshot polled every 2s. The pet plays segmented
 * keyframe sequences (transparent webp, no mp4): each state is split into
 * initial → enter → doing (loopable) → exit segments so the doing phase
 * can be repeated to extend the animation duration.
 * Local interactions that never touch the host:
 *   - mouse hover → 疑惑脸 (waiting track)
 *   - idle swimming → the pet wanders the lower half of the viewport
 *   - running (办公) → the pet parks at a fixed desk spot (bottom-right)
 *   - done (吃饱) → a fish-snack drops from the top into the pet's mouth
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
    loopable: boolean
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

/** Tracks that settle back to idle after a one-shot play. */
function isOneShot(track: BlubbyTrack): boolean {
  return track === 'done' || track === 'failed'
}

/** How many times the doing segment repeats before the exit segment. */
const DOING_REPEAT = 3

/** The bottom-right desk spot the pet parks at while 办公. */
const DESK_RIGHT = 32
const DESK_BOTTOM = 96

/** Pet rendered size (source frames are 240x240; scale to a desktop pet). */
const PET_SIZE = 220

/** Random wander target within the lower half of the viewport. */
function wanderTarget(): { right: number; bottom: number } {
  const right = 24 + Math.random() * Math.min(320, window.innerWidth * 0.3)
  const bottom = 48 + Math.random() * Math.min(180, window.innerHeight * 0.22)
  return { right, bottom }
}

/**
 * Build the flat frame playlist for a track:
 * initial → enter → doing × DOING_REPEAT → exit.
 * One-shot tracks (done/failed) end the playlist at the last exit frame;
 * looping tracks cycle the whole playlist forever.
 */
function buildPlaylist(track: BlubbyTrack, segments: BlubbySegments | null): string[] | null {
  if (!segments) return null
  const state = segments.states[track]
  if (!state) return null
  const seg = state.segments
  return [
    ...seg.initial,
    ...seg.enter,
    ...seg.doing,
    ...seg.doing,
    ...seg.doing,
    ...seg.exit,
  ]
}

/**
 * The floating pet body. Pure presentational: reads the snapshot, plays the
 * right segmented sequence, and handles local interactions (hover, wander,
 * fish snack).
 */
export function BlubbyEntry({ snapshot, transportFailed, segments }: BlubbyInjected): ReturnType<typeof createPortal> {
  const hostTrack: BlubbyTrack = snapshot?.track ?? 'idle'
  // Local override: hover shows 疑惑脸 regardless of host activity.
  const [hovered, setHovered] = useState(false)
  // Local override: one-shot done/failed already played out client-side
  // while the host still reports the track (poll lag); settle locally.
  const [settledIdle, setSettledIdle] = useState(false)
  // Wander position for idle swimming.
  const [pos, setPos] = useState(() => wanderTarget())
  const wanderTimer = useRef<number | undefined>(undefined)

  const track: BlubbyTrack = hovered ? 'waiting' : settledIdle ? 'idle' : hostTrack

  // Idle swimming: wander the lower half every few seconds.
  useEffect(() => {
    if (track === 'idle') {
      const move = (): void => {
        setPos(wanderTarget())
        wanderTimer.current = window.setTimeout(move, 3500)
      }
      wanderTimer.current = window.setTimeout(move, 2500)
      return () => {
        if (wanderTimer.current !== undefined) window.clearTimeout(wanderTimer.current)
      }
    }
    if (wanderTimer.current !== undefined) {
      window.clearTimeout(wanderTimer.current)
      wanderTimer.current = undefined
    }
    // 办公/完成: park at the desk spot.
    if (track === 'running' || track === 'done') setPos({ right: DESK_RIGHT, bottom: DESK_BOTTOM })
  }, [track])

  // Reset the local settled flag when the host reports a fresh one-shot.
  useEffect(() => {
    if (hostTrack !== 'done' && hostTrack !== 'failed') setSettledIdle(false)
  }, [hostTrack])

  // ---- segmented frame player ----
  const playlist = useMemo(() => buildPlaylist(track, segments), [track, segments])
  const [frameIdx, setFrameIdx] = useState(0)
  const frameMs = segments?.frameMs ?? 125

  // Restart the playlist whenever the track changes.
  useEffect(() => {
    setFrameIdx(0)
  }, [track, segments])

  // Advance the playlist on a fixed rhythm; one-shot tracks stop at the end.
  useEffect(() => {
    if (!playlist) return
    const timer = window.setInterval(() => {
      setFrameIdx((idx) => {
        const next = idx + 1
        if (next < playlist.length) return next
        if (isOneShot(track)) return idx // hold the last exit frame
        return 0 // looping track: cycle the whole playlist
      })
    }, frameMs)
    return () => window.clearInterval(timer)
  }, [playlist, track, frameMs])

  // One-shot finished (we're holding the final frame): settle locally.
  useEffect(() => {
    if (isOneShot(track) && playlist && frameIdx === playlist.length - 1) {
      setSettledIdle(true)
    }
  }, [track, playlist, frameIdx])

  const frameUrl = playlist ? `/blubby/frames/${playlist[frameIdx]}` : null
  const bubble = !hovered ? snapshot?.bubble : undefined

  const float = (
    <div
      style={{
        position: 'fixed',
        right: pos.right,
        bottom: pos.bottom,
        zIndex: 2147483000,
        width: PET_SIZE,
        height: PET_SIZE,
        pointerEvents: 'auto',
        cursor: 'grab',
        transition: 'right 1.2s ease-in-out, bottom 1.2s ease-in-out',
        userSelect: 'none',
      }}
      onMouseEnter={() => setHovered(true)}
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
          // 透明 webp 关键帧直接叠加，无底色混合
          background: 'transparent',
        }}
      />
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
