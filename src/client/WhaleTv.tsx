/**
 * WhaleTv — 蓝色大肥鱼的「随身小电视」。
 *
 * 只支持 B 站：player.bilibili.com 官方嵌入播放器允许第三方 iframe 嵌入
 * （无 frame 限制头）。本组件做的事：粘贴 B 站视频链接 → 自动抠出 BV 号 →
 * 拼官方嵌入地址 → iframe 播放。
 *
 * 形态：fixed 悬浮窗（默认左下角），标题栏可拖动，记住最近 3 条链接。
 * 通过 createPortal 挂到 document.body，独立于宠物浮层，zIndex 更高。
 * @module dsh-blubby/client/WhaleTv
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/** 小电视窗口尺寸（宽固定，视频 16:9，头/脚条固定）。 */
const TV_W = 440
const TV_HEAD = 44
const TV_VIDEO = Math.round((TV_W * 9) / 16)
const TV_FOOT = 48
const TV_H = TV_HEAD + TV_VIDEO + TV_FOOT

/** 默认落点：屏幕左下角（宠物在右下角，互不遮挡）。 */
const DEFAULT_POS = { left: 24, bottom: 140 }

/** localStorage 键：最近看过的视频链接。 */
const RECENT_KEY = 'dshBlubbyTvRecent'
const RECENT_MAX = 3

/** 解析结果：embed 是官方嵌入播放器地址。 */
interface ParsedLink {
  embed: string
}

/**
 * 从用户粘贴的链接里抠出播放器地址。
 * B站：/video/BVxxxx 取 BV 号。
 * 认不出来返回 null（前端提示，不打扰后端）。
 */
function parseVideoLink(raw: string): ParsedLink | null {
  const url = raw.trim()
  if (!url) return null
  const bv = url.match(/\/video\/(BV[0-9A-Za-z]+)/)
  if (bv) {
    return {
      embed: `https://player.bilibili.com/player.html?bvid=${bv[1]}&danmaku=0&high_quality=1`,
    }
  }
  return null
}

/** 读取最近记录（损坏/缺失则空数组）。 */
function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    const arr: unknown = raw === null ? [] : JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX) : []
  } catch {
    return []
  }
}

/** 写入最近记录（新链接排最前）。 */
function saveRecent(link: string, prev: string[]): string[] {
  const next = [link, ...prev.filter((x) => x !== link)].slice(0, RECENT_MAX)
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    // localStorage 不可用（隐私模式等）：仅本次会话内有效，不阻塞使用。
  }
  return next
}

/**
 * 小电视悬浮窗。自包含：输入框 + 播放 + 最近记录 + 拖动 + 关闭。
 * @param onClose - 关闭回调（由父组件控制卸载）。
 */
export function WhaleTv({ onClose }: { onClose: () => void }): ReturnType<typeof createPortal> {
  const [url, setUrl] = useState('')
  const [playing, setPlaying] = useState<{ embed: string; source: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [recent, setRecent] = useState<string[]>(loadRecent)
  // 窗口位置（left 是左边距，bottom 是下边距）。
  const [pos, setPos] = useState(DEFAULT_POS)
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)

  /** 点击播放：解析 → 成功则开播 + 记入最近；失败则红字提示。 */
  const play = (raw: string): void => {
    const parsed = parseVideoLink(raw)
    if (parsed === null) {
      setError('没认出这个链接，要 B 站视频播放页链接（带 BV 号）')
      return
    }
    const source = raw.trim()
    setError(null)
    setPlaying({ embed: parsed.embed, source })
    setRecent((prev) => saveRecent(source, prev))
  }

  // 拖动：标题栏按下 → 记录偏移；window 级 move/up 拖动整个窗口。
  const onBarDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    dragRef.current = {
      dx: e.clientX - pos.left,
      dy: e.clientY - (window.innerHeight - pos.bottom),
    }
    setDragging(true)
  }

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: PointerEvent): void => {
      const ref = dragRef.current
      if (ref === null) return
      const left = Math.max(0, Math.min(window.innerWidth - TV_W, e.clientX - ref.dx))
      const bottom = Math.max(0, Math.min(window.innerHeight - TV_H, window.innerHeight - (e.clientY - ref.dy)))
      setPos({ left, bottom })
    }
    const onUp = (): void => {
      dragRef.current = null
      setDragging(false)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [dragging])

  return createPortal(
    <div
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        left: pos.left,
        bottom: pos.bottom,
        zIndex: 2147483001, // 比宠物浮层(2147483000)高一档，永远可点
        width: TV_W,
        background: 'rgba(12,14,22,0.96)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 14,
        boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
        color: '#e6ebf4',
        fontSize: 12,
        overflow: 'hidden',
        userSelect: 'none',
      }}
    >
      {/* 标题栏：拖动把手 + 关闭 */}
      <div
        onPointerDown={onBarDown}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          height: TV_HEAD,
          padding: '0 10px 0 14px',
          cursor: dragging ? 'grabbing' : 'grab',
          background: 'rgba(255,255,255,0.04)',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: '#4bd6c8' }}>📺</span> 小电视
        </span>
        <span
          onClick={onClose}
          style={{ opacity: 0.5, fontSize: 13, cursor: 'pointer', padding: '2px 6px' }}
          title="关闭小电视"
        >
          ✕
        </span>
      </div>

      {/* 视频区：已开播 → iframe；未开播 → 占位提示 */}
      <div
        style={{
          width: '100%',
          height: TV_VIDEO,
          background: '#000',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {playing !== null ? (
          <iframe
            key={playing.embed}
            src={playing.embed}
            title="小电视播放器"
            style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
            allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
            allowFullScreen
          />
        ) : (
          <div style={{ textAlign: 'center', opacity: 0.6, lineHeight: '22px' }}>
            <div style={{ fontSize: 26, marginBottom: 8 }}>🐋</div>
            <div>贴个视频链接就能看剧</div>
            <div style={{ fontSize: 11, opacity: 0.7 }}>支持 B 站</div>
          </div>
        )}
      </div>

      {/* 输入行：链接输入框 + 播放按钮 */}
      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          height: TV_FOOT,
          padding: '0 10px',
          borderTop: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') play(url)
          }}
          placeholder="粘贴 B 站链接，回车播放"
          style={{
            flex: 1,
            height: 30,
            padding: '0 10px',
            borderRadius: 8,
            border: '1px solid rgba(75,214,200,0.35)',
            background: 'rgba(255,255,255,0.06)',
            color: '#e6ebf4',
            fontSize: 12,
            outline: 'none',
          }}
        />
        <button
          type="button"
          onClick={() => play(url)}
          style={{
            height: 30,
            padding: '0 16px',
            borderRadius: 8,
            border: 'none',
            background: 'linear-gradient(135deg, #2fa8a0, #4bd6c8)',
            color: '#06121a',
            fontSize: 12,
            fontWeight: 700,
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          ▶ 播放
        </button>
      </div>

      {/* 最近记录 + 错误提示 */}
      {recent.length > 0 && (
        <div
          style={{
            display: 'flex',
            gap: 6,
            alignItems: 'center',
            padding: '0 10px 8px',
            flexWrap: 'wrap',
          }}
        >
          {recent.map((r) => (
            <span
              key={r}
              onClick={() => {
                setUrl(r)
                play(r)
              }}
              style={{
                padding: '2px 8px',
                borderRadius: 999,
                border: '1px solid rgba(255,255,255,0.14)',
                background: 'rgba(255,255,255,0.05)',
                color: '#9fb0cc',
                fontSize: 11,
                cursor: 'pointer',
                maxWidth: 180,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={r}
            >
              {r}
            </span>
          ))}
        </div>
      )}
      {error !== null && (
        <div style={{ padding: '0 10px 8px', color: '#ff8a8a', fontSize: 11 }}>⚠ {error}</div>
      )}
    </div>,
    document.body,
  )
}
