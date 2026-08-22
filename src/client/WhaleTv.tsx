/**
 * WhaleTv — 蓝色大肥鱼的「随身小电视」。
 *
 * 只支持 B 站：player.bilibili.com 官方嵌入播放器允许第三方 iframe 嵌入
 * （无 frame 限制头）。本组件做的事：粘贴 B 站视频链接 → 自动抠出 BV 号 →
 * 拼官方嵌入地址 → iframe 播放。
 *
 * 形态：fixed 悬浮窗（默认左下角），标题栏可拖动，记住最近 3 条链接。
 * 通过 createPortal 挂到 document.body，独立于宠物浮层，zIndex 更高。
 *
 * 另有「广告模式」：窗口换个假推广弹窗皮肤钉在右下角（白边框 + 假头条/脚条），
 * 视频照播，远看就是一条没关掉的输入法广告。注意画中画小窗是系统级浮层，
 * 浏览器页面遮不住它，所以不做镂空方案。
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

/** 广告模式：视频区尺寸档位（16:9），决定整个假广告框的大小。 */
const AD_VIDEO_SIZES = [
  { w: 400, h: 225 },
  { w: 480, h: 270 },
  { w: 560, h: 315 },
  { w: 640, h: 360 },
]
/** 广告模式边框厚度：头条 / 脚条。 */
const AD_HEAD = 30
const AD_FOOT = 26

/** localStorage 键：最近看过的视频链接、广告模式尺寸档位。 */
const RECENT_KEY = 'dshBlubbyTvRecent'
const RECENT_MAX = 3
const AD_SIZE_KEY = 'dshBlubbyTvAdSize'

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

/** 读取广告模式尺寸档位（越界/损坏则回到最小档）。 */
function loadAdSize(): number {
  try {
    const raw = localStorage.getItem(AD_SIZE_KEY)
    const idx = raw === null ? 0 : Number(raw)
    return Number.isInteger(idx) && idx >= 0 && idx < AD_VIDEO_SIZES.length ? idx : 0
  } catch {
    return 0
  }
}

/** 写入广告模式尺寸档位。 */
function saveAdSize(idx: number): void {
  try {
    localStorage.setItem(AD_SIZE_KEY, String(idx))
  } catch {
    // localStorage 不可用（隐私模式等）：仅本次会话内有效，不阻塞使用。
  }
}

/**
 * 广告模式：把正在播的视频包进一圈假推广弹窗皮里，钉死屏幕右下角。
 *
 * 头条上的「✕」和脚条上的「不再提示」都真的关掉小电视（保持伪装自洽），
 * 退出广告模式回到普通窗口的入口是「双击头条」。
 * @param embed - 正在播放的嵌入地址；null = 还没开播（视频区显示占位）。
 * @param videoSize - 视频区尺寸档位。
 * @param onCycleSize - 在尺寸档位之间切换。
 * @param onExit - 退回普通小电视窗口。
 * @param onClose - 关闭整个小电视。
 */
function AdFrame({
  embed,
  videoSize,
  onCycleSize,
  onExit,
  onClose,
}: {
  embed: string | null
  videoSize: { w: number; h: number }
  onCycleSize: () => void
  onExit: () => void
  onClose: () => void
}): React.ReactElement {
  /** 边框条公共样式：白底。 */
  const bar = {
    background: 'linear-gradient(180deg, #fdfefe, #f2f6fb)',
    display: 'flex',
    alignItems: 'center',
    boxSizing: 'border-box',
  } as const
  /** 头条上的小图标按钮。 */
  const iconBtn = {
    width: 18,
    height: 18,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 3,
    color: '#8b95a6',
    fontSize: 11,
    cursor: 'pointer',
  } as const

  return (
    <div
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        right: 0,
        bottom: 0,
        zIndex: 2147483001, // 与正常模式同档：比宠物浮层(2147483000)高一档
        width: videoSize.w + 2, // +2 是左右外边框
        boxSizing: 'border-box',
        border: '1px solid #c7d2e0',
        borderRadius: '4px 4px 0 0',
        overflow: 'hidden',
        color: '#5a6577',
        fontFamily: '"Microsoft YaHei", system-ui, sans-serif',
        fontSize: 12,
        userSelect: 'none',
        boxShadow: '0 -2px 14px rgba(0,0,0,0.22)',
      }}
    >
      {/* 头条：假推广弹窗标题 —— 双击这里退出广告模式（故意不挂 title，免得把伪装说漏） */}
      <div
        onDoubleClick={onExit}
        style={{
          ...bar,
          height: AD_HEAD,
          justifyContent: 'space-between',
          padding: '0 4px 0 8px',
          borderBottom: '1px solid #e2e9f3',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span
            style={{
              width: 15,
              height: 15,
              flexShrink: 0,
              borderRadius: 3,
              background: 'linear-gradient(135deg, #55a0ff, #2f6fe4)',
              color: '#fff',
              fontSize: 9,
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            推
          </span>
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: '#3c4757',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            输入法 · 每日精选推荐
          </span>
          <span
            style={{
              flexShrink: 0,
              padding: '0 4px',
              borderRadius: 2,
              border: '1px solid #d5dce7',
              color: '#a3adbc',
              fontSize: 10,
              lineHeight: '14px',
            }}
          >
            广告
          </span>
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
          {/* 尺寸切换：最小档显示「放大」，否则显示「缩小」（点了都是下一档） */}
          <span onClick={onCycleSize} title="调整窗口大小" style={iconBtn}>
            {videoSize.w === AD_VIDEO_SIZES[0]!.w ? '⤢' : '⤡'}
          </span>
          <span onClick={onClose} title="关闭" style={{ ...iconBtn, fontSize: 12 }}>
            ✕
          </span>
        </span>
      </div>

      {/* 视频区：已开播 → iframe 照播；未开播 → 黑屏占位 */}
      {embed !== null ? (
        <iframe
          key={embed}
          src={embed}
          title="小电视播放器"
          style={{
            display: 'block',
            width: videoSize.w,
            height: videoSize.h,
            border: 'none',
            background: '#000',
          }}
          allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
          allowFullScreen
        />
      ) : (
        <div
          style={{
            width: videoSize.w,
            height: videoSize.h,
            background: '#0b0d12',
            color: '#5a6577',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 12,
          }}
        >
          先贴个 B 站链接开播，再切广告皮肤
        </div>
      )}

      {/* 脚条：假免责声明 + 假「不再提示」（点了就是真关掉） */}
      <div
        style={{
          ...bar,
          height: AD_FOOT,
          justifyContent: 'space-between',
          padding: '0 8px',
          borderTop: '1px solid #e2e9f3',
          fontSize: 11,
          color: '#9aa4b3',
        }}
      >
        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          内容由第三方提供，不代表本软件立场
        </span>
        <span onClick={onClose} style={{ flexShrink: 0, marginLeft: 8, color: '#7f8b9c', cursor: 'pointer' }}>
          不再提示
        </span>
      </div>
    </div>
  )
}

/**
 * 小电视悬浮窗。自包含：输入框 + 播放 + 最近记录 + 拖动 + 广告模式 + 关闭。
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
  // 广告模式：窗口换假广告皮钉右下角，视频照播；尺寸档位记在 localStorage。
  const [adMode, setAdMode] = useState(false)
  const [adSizeIdx, setAdSizeIdx] = useState<number>(loadAdSize)

  /** 循环切下一档视频区尺寸。 */
  const cycleAdSize = (): void => {
    const next = (adSizeIdx + 1) % AD_VIDEO_SIZES.length
    setAdSizeIdx(next)
    saveAdSize(next)
  }

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

  // 广告模式：整个窗口换成假广告皮，视频照播（iframe 同地址重挂，接着播）。
  if (adMode) {
    return createPortal(
      <AdFrame
        embed={playing?.embed ?? null}
        videoSize={AD_VIDEO_SIZES[adSizeIdx] ?? AD_VIDEO_SIZES[0]!}
        onCycleSize={cycleAdSize}
        onExit={() => setAdMode(false)}
        onClose={onClose}
      />,
      document.body,
    )
  }

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
        <button
          type="button"
          onClick={() => setAdMode(true)}
          title="换成假广告弹窗皮肤钉在右下角，视频照播（在假广告里双击头条可退回）"
          style={{
            height: 30,
            padding: '0 14px',
            borderRadius: 8,
            border: '1px solid rgba(75,214,200,0.55)',
            background: 'rgba(75,214,200,0.14)',
            color: '#4bd6c8',
            fontSize: 12,
            fontWeight: 700,
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          📢 伪装广告
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
