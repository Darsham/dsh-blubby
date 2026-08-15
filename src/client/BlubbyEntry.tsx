/**
 * BlubbyEntry — the floating 小咕噜. One React root on document.body,
 * driven by the host snapshot polled every 2s. The pet plays raw mp4
 * videos (no spritesheet): each track is one mp4 under /blubby/<track>.mp4.
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

/** Props injected by the plugin apply body. */
export interface BlubbyInjected {
  /** Latest host snapshot; null before the first successful fetch. */
  snapshot: BlubbyStateView | null
  /** True when the last poll failed (show a sad placeholder). */
  transportFailed: boolean
}

/** Asset URL for one track. */
function trackUrl(track: BlubbyTrack): string {
  return `/blubby/${track}.mp4`
}

/** Tracks that loop; one-shot tracks (done/failed) play once then settle. */
function loops(track: BlubbyTrack): boolean {
  return track === 'idle' || track === 'waiting' || track === 'running'
}

/** The bottom-right desk spot the pet parks at while 办公. */
const DESK_RIGHT = 32
const DESK_BOTTOM = 96

/** Pet rendered size (video is 960x960; scale down to a desktop pet). */
const PET_SIZE = 220

/** Random wander target within the lower half of the viewport. */
function wanderTarget(): { right: number; bottom: number } {
  const right = 24 + Math.random() * Math.min(320, window.innerWidth * 0.3)
  const bottom = 48 + Math.random() * Math.min(180, window.innerHeight * 0.22)
  return { right, bottom }
}

/**
 * The floating pet body. Pure presentational: reads the snapshot, plays the
 * right video, and handles local interactions (hover, wander, fish snack).
 */
export function BlubbyEntry({ snapshot, transportFailed }: BlubbyInjected): ReturnType<typeof createPortal> {
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

  const videoUrl = trackUrl(track)
  const videoKey = useMemo(() => videoUrl, [videoUrl])

  const onEnded = (): void => {
    // One-shot track finished: settle to idle locally (host settles on its
    // own timer; this just avoids waiting out the poll lag).
    if (!loops(track)) setSettledIdle(true)
  }

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
      <video
        key={videoKey}
        src={videoUrl}
        autoPlay
        muted
        playsInline
        loop={loops(track)}
        onEnded={onEnded}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          display: 'block',
          borderRadius: 12,
          // 米白底 mp4 直接播放；等透明素材后再去掉底色混合
          mixBlendMode: 'multiply',
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
