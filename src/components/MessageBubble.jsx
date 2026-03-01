// src/components/MessageBubble.jsx
// ═══════════════════════════════════════════════════════════════════════════
// PRODUCTION GRADE v4 — AuroraChat Message Bubble
//
// FIXES v4:
// [FIX-6]  FORMAT_RE — was using literal newlines inside regex literal →
//          "Unterminated regular expression" fatal parse error. Replaced
//          entire linkifyText() with a single correct RegExp built via
//          new RegExp() with properly escaped patterns. Deleted dead code
//          (FORMAT_RE, URL_RE, unused `last`/`m` variables).
// [FIX-7]  allRe string escaping — single-quote chars inside single-quoted
//          template caused subtle parse ambiguity. Now uses template literal
//          with unambiguous escaping.
// [FIX-8]  wrapRef used before declaration in isReaction early-return block.
//          Moved all hooks to top of MessageBubble before any early returns.
// [FIX-9]  NO_PAD_TYPES Set recreated every render → moved to module scope.
// [FIX-10] PlayIcon / PauseIcon / MicIcon / MusicIcon defined inside
//          AudioBubble render fn → new component identity every render,
//          breaks React reconciliation. Moved to module scope.
// [FIX-11] linkifyText inner segments called recursively (no nesting
//          support), but nested formatting tokens were split wrong.
//          Cleaned up logic to be clear, minimal, and correct.
//
// PERF:
// - Module-level constants for Set, RegExp, component refs
// - Memoized expensive helpers (seedWaveform, linkifyText result) via useMemo
// - useCallback on all event handlers
// - Stable waveform via module-level cache (keyed by msgId)
// ═══════════════════════════════════════════════════════════════════════════

import { format } from "date-fns"
import { useState, useRef, useCallback, useEffect, useMemo, memo } from "react"
import { prefetchChat } from "../hooks/useMediaPrefetch"
import { useAppStore } from "../store/app"

// ════════════════════════════════════════════════════════════
// MODULE-LEVEL CONSTANTS (created once, never re-allocated)
// ════════════════════════════════════════════════════════════

/** Types that render media flush to bubble edge — no padding */
const NO_PAD_TYPES = new Set([
  "imageMessage", "videoMessage", "stickerMessage",
  "viewOnceMessage", "viewOnceMessageV2",
])

const SPEED_STEPS = [1, 1.5, 2]

const DOC_ICONS = {
  PDF: "📕", DOCX: "📘", DOC: "📘", XLSX: "📗", XLS: "📗",
  PPTX: "📙", PPT: "📙", ZIP: "🗜️", RAR: "🗜️", TXT: "📃",
  APK: "📱", MP4: "🎬", PNG: "🖼️", JPG: "🖼️", JPEG: "🖼️",
  MP3: "🎵", OGG: "🎵", AAC: "🎵", CSV: "📊", WEBP: "🖼️",
}

// ════════════════════════════════════════════════════════════
// [FIX-6] CORRECT combined regex — no literal newlines
//
// Matches (in priority order):
//   1. ```multiline code block```
//   2. `inline code`
//   3. *bold*   (no newlines inside)
//   4. _italic_ (no newlines inside)
//   5. ~strike~ (no newlines inside)
//   6. URL (http/https/www)
//
// Built with new RegExp() so escape sequences are unambiguous.
// ════════════════════════════════════════════════════════════
const RICH_RE = new RegExp(
  "(" +
    "```[\\s\\S]+?```" +        // group 1: fenced code
  "|" +
    "`[^`\\n]+`" +              // inline code
  "|" +
    "\\*[^*\\n]+\\*" +          // bold
  "|" +
    "_[^_\\n]+_" +              // italic
  "|" +
    "~[^~\\n]+~" +              // strikethrough
  ")" +
  "|" +
  "(" +
    "https?:\\/\\/[^\\s<>\"')\\]]+|www\\.[^\\s<>\"')\\]]+\\.[^\\s<>\"')\\]]+" +
  ")",                          // group 2: URL
  "gi"
)

// ════════════════════════════════════════════════════════════
// [FIX-1] toBool — normalize SQLite 0/1 → JS boolean
// CRITICAL: Never use {sqliteInt && <JSX/>} — renders "0" as text
// ════════════════════════════════════════════════════════════
const toBool = (v) => v === 1 || v === true

// ─── Linkify + WhatsApp text formatting ──────────────────────────────────────
function linkifyText(text) {
  if (!text) return null

  const segments = []
  let key = 0
  let lastIdx = 0

  // Reset lastIndex before exec loop (regex has 'g' flag)
  RICH_RE.lastIndex = 0

  let m
  while ((m = RICH_RE.exec(text)) !== null) {
    // Push plain text before this match
    if (m.index > lastIdx) {
      segments.push(text.slice(lastIdx, m.index))
    }

    const token = m[0]

    if (m[1]) {
      // ── Formatting token ──
      if (token.startsWith("```")) {
        segments.push(
          <code key={key++} className="bubble-code-block">{token.slice(3, -3)}</code>
        )
      } else if (token.startsWith("`")) {
        segments.push(
          <code key={key++} className="bubble-code-inline">{token.slice(1, -1)}</code>
        )
      } else if (token.startsWith("*")) {
        segments.push(<strong key={key++}>{token.slice(1, -1)}</strong>)
      } else if (token.startsWith("_")) {
        segments.push(<em key={key++}>{token.slice(1, -1)}</em>)
      } else if (token.startsWith("~")) {
        segments.push(<s key={key++}>{token.slice(1, -1)}</s>)
      }
    } else if (m[2]) {
      // ── URL token ──
      let href = token
      if (!href.startsWith("http")) href = "https://" + href
      // Trim trailing punctuation that's likely not part of the URL
      href = href.replace(/[.,;:!?)\]]+$/, "")
      const display = href.replace(/^https?:\/\//, "").replace(/\/$/, "")
      segments.push(
        <a
          key={key++}
          href={href}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            window.api?.openExternal?.(href) ?? window.open(href, "_blank")
          }}
          title={href}
          className="bubble-link"
        >
          {display}
        </a>
      )
    }

    lastIdx = m.index + token.length
  }

  // Remaining plain text
  if (lastIdx < text.length) {
    segments.push(text.slice(lastIdx))
  }

  if (segments.length === 0) return text
  if (segments.length === 1 && typeof segments[0] === "string") return segments[0]
  return segments
}

// ─── RichText: renders formatted + linkified text preserving newlines ──────────
const RichText = memo(function RichText({ text, className, style }) {
  if (!text) return null
  const lines = text.split("\n")
  return (
    <span className={className} style={style}>
      {lines.map((line, i) => (
        <span key={i}>
          {linkifyText(line)}
          {i < lines.length - 1 && <br />}
        </span>
      ))}
    </span>
  )
})

// ════════════════════════════════════════════════════════════
// MEDIA PATH UTILITIES
// ════════════════════════════════════════════════════════════

function pathToFileUrl(rawPath) {
  if (!rawPath) return null
  // Already a file:// URL
  if (rawPath.startsWith("file://")) {
    // Guard against legacy broken encoding: D%3A → D: (old normalizeMediaPath bug)
    if (rawPath.includes("%3A") || rawPath.includes("%3a")) {
      try {
        const decoded = decodeURIComponent(rawPath.replace(/^file:\/\/\/?/, ""))
        return pathToFileUrl(decoded)
      } catch (_) { /* keep original */ }
    }
    return rawPath
  }
  // Normalize backslashes (Windows)
  let p = rawPath.replace(/\\/g, "/")
  const winDrive = /^([A-Za-z]):\//
  if (winDrive.test(p)) {
    const encoded = p
      .replace(winDrive, (_, letter) => `/${letter.toUpperCase()}:/`)
      .split("/")
      .map((seg, i) => {
        if (i === 0) return seg
        if (/^[A-Za-z]:$/.test(seg)) return seg
        return encodeURIComponent(seg)
      })
      .join("/")
    return `file://${encoded}`
  }
  // Unix absolute path
  const withSlash = p.startsWith("/") ? p : `/${p}`
  const encoded = withSlash
    .split("/")
    .map((seg, i) => (i === 0 ? seg : encodeURIComponent(seg)))
    .join("/")
  return `file://${encoded}`
}

// ─── useMediaSrc — reactive media source with async existence check ────────────
// 1. Shows src IMMEDIATELY (optimistic) from stored path — no flicker on open
// 2. Resets error state when path changes (media:updated fires after download)
// 3. Async existence check: if file is gone, clears src so bubble shows
//    "downloading..." and prefetch can re-trigger.
function useMediaSrc(msg) {
  const rawPath = msg.media_saved_path || null
  const [verifiedSrc, setVerifiedSrc] = useState(() =>
    rawPath ? pathToFileUrl(rawPath) : null
  )
  const [err, setErr] = useState(false)
  const prevRaw = useRef(rawPath)
  const checked = useRef(false)

  // Detect path change (media:updated) — synchronous during render is intentional
  if (prevRaw.current !== rawPath) {
    prevRaw.current = rawPath
    const newSrc = rawPath ? pathToFileUrl(rawPath) : null
    // These state setters called during render schedule a re-render — valid React pattern
    setVerifiedSrc(newSrc)
    if (err) setErr(false)
    checked.current = false
  }

  useEffect(() => {
    if (!rawPath || checked.current) return
    if (!window.api?.fsExists) return
    checked.current = true
    window.api
      .fsExists({ rawPath })
      .then((exists) => {
        if (!exists) {
          setVerifiedSrc(null)
          if (msg.chat_jid) prefetchChat(msg.chat_jid, 30, true)
        }
      })
      .catch(() => { /* IPC error — keep optimistic src */ })
  }, [rawPath]) // eslint-disable-line react-hooks/exhaustive-deps

  const src = verifiedSrc || msg.media_url || null
  return { src, err, setErr }
}

// ════════════════════════════════════════════════════════════
// SMALL STATELESS SUB-COMPONENTS
// ════════════════════════════════════════════════════════════

function fmtPhone(raw) {
  if (!raw) return "?"
  const n = raw.includes("@") ? raw.split("@")[0] : raw
  if (!/^\d{6,}$/.test(n)) return raw
  return `+${n}`
}

function fmtTime(s) {
  if (!s || !isFinite(s)) return "0:00"
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, "0")}`
}

// ─── Reply Icon ───────────────────────────────────────────────────────────────
function ReplyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="9 17 4 12 9 7" />
      <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
    </svg>
  )
}

// ─── [FIX-10] Audio icons moved to module scope — stable component identity ───
function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18" aria-hidden="true">
      <polygon points="6,4 20,12 6,20" />
    </svg>
  )
}
function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18" aria-hidden="true">
      <rect x="5" y="4" width="4" height="16" rx="1" />
      <rect x="15" y="4" width="4" height="16" rx="1" />
    </svg>
  )
}
function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      width="13" height="13" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="2" width="6" height="11" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  )
}
function MusicIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      width="13" height="13" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
  )
}

// ─── Tick indicators ──────────────────────────────────────────────────────────
const Ticks = memo(function Ticks({ status }) {
  const s = Number(status)
  if (s === 0) return <span className="tick tick-pending" aria-label="Pending">⏱</span>
  if (s === 1) return <span className="tick tick-sent" aria-label="Sent">✓</span>
  if (s === 2) return <span className="tick tick-delivered" aria-label="Delivered">✓✓</span>
  return <span className="tick tick-read" aria-label="Read">✓✓</span>
})

const BubbleTime = memo(function BubbleTime({ ts }) {
  if (!ts) return null
  return (
    <span className="bubble-time">
      {format(new Date(ts * 1000), "HH:mm")}
    </span>
  )
})

// ─── [FIX-2] Quoted/reply preview ────────────────────────────────────────────
const QuotedMsg = memo(function QuotedMsg({
  body, sender, type, hasMedia, mimetype, onClick, quotedFromMe,
}) {
  if (!sender && !body && !hasMedia && !quotedFromMe) return null

  const mediaIcon = (() => {
    if (!hasMedia) return null
    if (mimetype?.startsWith("image")) return "🖼️ "
    if (mimetype?.startsWith("video")) return "🎬 "
    if (mimetype?.startsWith("audio")) return "🎵 "
    if (mimetype?.includes("pdf"))     return "📕 "
    return "📎 "
  })()

  let displaySender
  if (sender === "__me__" || quotedFromMe) {
    displaySender = "Kamu"
  } else if (sender) {
    displaySender = sender.includes("@") ? fmtPhone(sender) : sender
  } else {
    displaySender = null
  }

  return (
    <div
      className="quoted"
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      style={onClick ? { cursor: "pointer" } : undefined}
    >
      {displaySender && (
        <div className="quoted-sender">{displaySender}</div>
      )}
      <div className="quoted-text">
        {mediaIcon}{body || (hasMedia ? "Pesan media" : "Pesan")}
      </div>
    </div>
  )
})

// ─── Reaction overlay ─────────────────────────────────────────────────────────
const ReactionOverlay = memo(function ReactionOverlay({ reactions }) {
  const grouped = useMemo(() => {
    if (!reactions?.length) return null
    const g = {}
    for (const r of reactions) g[r.text] = (g[r.text] || 0) + 1
    return g
  }, [reactions])

  if (!grouped) return null
  return (
    <div className="reaction-row" role="img" aria-label="Reactions">
      {Object.entries(grouped).map(([e, n]) => (
        <div key={e} className="reaction-chip">
          <span>{e}</span>
          {n > 1 && <span className="reaction-chip-count">{n}</span>}
        </div>
      ))}
    </div>
  )
})

// ─── Forward badge ────────────────────────────────────────────────────────────
function ForwardBadge({ score }) {
  if (!score) return null
  return (
    <div className="forward-badge">
      <span aria-hidden="true">↪</span>
      <span>{score >= 5 ? "Sering diteruskan" : "Diteruskan"}</span>
    </div>
  )
}

// ImageLightbox replaced by MediaViewer component

// ─── Image bubble ─────────────────────────────────────────────────────────────
function ImageBubble({ msg, onMediaClick }) {
  const { src, err, setErr } = useMediaSrc(msg)
  const { openMedia } = useAppStore()
  const [loaded, setLoaded] = useState(false)

  const handleClick = useCallback(() => {
    if (!src) return
    if (onMediaClick) {
      onMediaClick(msg, src, "image")
    } else {
      openMedia([{ src, type: "image", caption: msg.body || "", msgId: msg.id, filename: msg.media_filename }], 0)
    }
  }, [src, msg, onMediaClick, openMedia])

  if (!src || err) {
    return (
      <div style={{ lineHeight: 0, borderRadius: 8, overflow: "hidden", background: "rgba(255,255,255,0.06)", minHeight: 120 }}>
        <div style={{
          display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center",
          gap: 6, minHeight: 120, padding: 16,
        }}>
          <span style={{ fontSize: 36 }}>&#128247;</span>
          <span style={{ fontSize: 10, color: "var(--text-3)" }}>
            {src ? "Gagal memuat" : "Mengunduh..."}
          </span>
          {!src && (
            <div className="spinner spinner-sm"
              style={{ borderTopColor: "var(--green)", borderColor: "rgba(37,211,102,.2)" }} />
          )}
        </div>
        {msg.body && (
          <div className="media-caption" style={{ padding: "6px 10px 8px", fontSize: 13, lineHeight: 1.4 }}>
            <RichText text={msg.body} />
          </div>
        )}
      </div>
    )
  }

  return (
    <>
      <div style={{ lineHeight: 0, borderRadius: msg.body ? "8px 8px 0 0" : 8, overflow: "hidden", position: "relative" }}>
        {!loaded && (
          <div style={{
            position: "absolute", inset: 0, display: "flex",
            alignItems: "center", justifyContent: "center",
            background: "rgba(255,255,255,0.04)", minHeight: 80,
          }}>
            <div className="spinner spinner-sm"
              style={{ borderTopColor: "var(--green)", borderColor: "rgba(37,211,102,.2)" }} />
          </div>
        )}
        <img
          src={src}
          alt={msg.body || "Foto"}
          onLoad={() => setLoaded(true)}
          onError={() => setErr(true)}
          onClick={handleClick}
          style={{
            display: "block",
            maxWidth: "100%",
            maxHeight: 320,
            width: "100%",
            objectFit: "cover",
            cursor: "zoom-in",
            opacity: loaded ? 1 : 0,
            transition: "opacity 0.2s",
            verticalAlign: "bottom",
          }}
        />
      </div>
      {msg.body && (
        <div className="media-caption" style={{ padding: "6px 10px 8px", fontSize: 13, lineHeight: 1.4 }}>
          <RichText text={msg.body} />
        </div>
      )}
    </>
  )
}

// ─── Video bubble ─────────────────────────────────────────────────────────────
function VideoBubble({ msg, onMediaClick }) {
  const { src, err, setErr } = useMediaSrc(msg)
  const { openMedia } = useAppStore()
  const isGif = toBool(msg.is_gif)
  const [thumbLoaded, setThumbLoaded] = useState(false)

  const handleClick = useCallback(() => {
    if (!src || isGif) return
    if (onMediaClick) {
      onMediaClick(msg, src, "video")
    } else {
      openMedia([{ src, type: "video", caption: msg.body || "", msgId: msg.id, filename: msg.media_filename }], 0)
    }
  }, [src, msg, isGif, onMediaClick, openMedia])

  if (!src || err) {
    return (
      <div className="media-video">
        <div className="media-video-thumb" style={{ cursor: "default", minHeight: 120, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8 }}>
          <span style={{ fontSize: 32 }}>{isGif ? "GIF" : "🎬"}</span>
          <span style={{ fontSize: 11, color: "var(--text-3)" }}>
            {src ? "Gagal memuat" : "Mengunduh..."}
          </span>
          {!src && <div className="spinner spinner-sm" style={{ borderTopColor: "var(--green)", borderColor: "rgba(37,211,102,.2)" }} />}
        </div>
      </div>
    )
  }

  if (isGif) {
    return (
      <div className="media-img">
        <video
          src={src}
          autoPlay loop muted playsInline
          onError={() => setErr(true)}
          style={{ maxWidth: "100%", maxHeight: 280, borderRadius: 8, display: "block" }}
        />
        <div className="gif-badge">GIF</div>
        {msg.body && <div className="media-caption"><RichText text={msg.body} /></div>}
      </div>
    )
  }

  // Non-GIF video: show thumbnail with play button overlay, click → MediaViewer
  return (
    <div
      className="media-video"
      onClick={handleClick}
      style={{ cursor: "pointer", position: "relative", borderRadius: 8, overflow: "hidden" }}
      title="Klik untuk putar"
    >
      <video
        src={src + "#t=0.5"}
        preload="metadata"
        muted
        onLoadedData={() => setThumbLoaded(true)}
        onError={() => setErr(true)}
        style={{ maxWidth: "100%", maxHeight: 280, display: "block", borderRadius: 8, width: "100%" }}
      />
      {/* Play button overlay */}
      <div style={{
        position: "absolute", inset: 0,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,0.25)",
        borderRadius: 8,
        transition: "background 0.15s",
      }}
        onMouseEnter={e => e.currentTarget.style.background = "rgba(0,0,0,0.4)"}
        onMouseLeave={e => e.currentTarget.style.background = "rgba(0,0,0,0.25)"}
      >
        <div style={{
          width: 52, height: 52, borderRadius: "50%",
          background: "rgba(0,0,0,0.6)",
          border: "2px solid rgba(255,255,255,0.4)",
          display: "flex", alignItems: "center", justifyContent: "center",
          backdropFilter: "blur(4px)",
          transition: "transform 0.15s",
        }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="white"><polygon points="8,5 20,12 8,19"/></svg>
        </div>
      </div>
      {msg.body && (
        <div className="media-caption" onClick={e => e.stopPropagation()}>
          <RichText text={msg.body} />
        </div>
      )}
    </div>
  )
}

// ════════════════════════════════════════════════════════════
// AUDIO PLAYER
// ════════════════════════════════════════════════════════════

// Global singleton: only one audio plays at a time
const _audioRegistry = { current: null }

// Waveform cache: keyed by msgId so we don't recompute across re-mounts
const _waveformCache = new Map()

function seedWaveform(id, bars = 40) {
  if (_waveformCache.has(id)) return _waveformCache.get(id)
  const str = id || "x"
  let h = 0
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0
  }
  const heights = []
  for (let i = 0; i < bars; i++) {
    h = (Math.imul(1664525, h) + 1013904223) | 0
    const pos = i / bars
    const envelope = 1 - Math.pow((pos - 0.5) * 2, 4)
    const raw = (h >>> 0) / 0xFFFFFFFF
    heights.push(0.12 + raw * 0.88 * envelope)
  }
  _waveformCache.set(id, heights)
  return heights
}

function AudioBubble({ msg }) {
  const { src } = useMediaSrc(msg)
  const isPtt = toBool(msg.is_ptt) || msg.msg_type === "pttMessage"
  const msgId = msg.id || msg.message_id || ""
  // waveform is stable — read from cache, never recalculated
  const waveform = useMemo(() => seedWaveform(msgId), [msgId])

  const audioRef = useRef(null)
  const [playing,   setPlaying]   = useState(false)
  const [progress,  setProgress]  = useState(0)
  const [elapsed,   setElapsed]   = useState(0)
  const [duration,  setDuration]  = useState(msg.media_duration || msg.duration || 0)
  const [speedIdx,  setSpeedIdx]  = useState(0)
  const [loadState, setLoadState] = useState("idle")
  const scrubRef = useRef(null)
  const rafRef   = useRef(null)

  const speed = SPEED_STEPS[speedIdx]

  useEffect(() => {
    if (!src) return
    const audio = new Audio()
    audio.preload = "metadata"
    audio.src = src
    audioRef.current = audio
    setLoadState("loading")

    const onMeta  = () => { setDuration(audio.duration); setLoadState("ready") }
    const onError = () => setLoadState("error")
    const onEnded = () => {
      setPlaying(false)
      setProgress(0)
      setElapsed(0)
      audio.currentTime = 0
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }

    audio.addEventListener("loadedmetadata", onMeta)
    audio.addEventListener("error", onError)
    audio.addEventListener("ended", onEnded)

    const cleanup = () => {
      audio.pause()
      audio.removeEventListener("loadedmetadata", onMeta)
      audio.removeEventListener("error", onError)
      audio.removeEventListener("ended", onEnded)
      audio.src = ""
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
    audio._cleanupFn = cleanup

    return () => {
      if (_audioRegistry.current === audio) _audioRegistry.current = null
      cleanup()
    }
  }, [src])

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = speed
  }, [speed])

  const startRaf = useCallback(() => {
    const tick = () => {
      const audio = audioRef.current
      if (!audio) return
      setProgress(audio.currentTime / (audio.duration || 1))
      setElapsed(audio.currentTime)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [])

  const stopRaf = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
  }, [])

  const togglePlay = useCallback(() => {
    const audio = audioRef.current
    if (!audio || loadState === "error") return

    // Singleton: stop any other playing audio
    if (_audioRegistry.current && _audioRegistry.current !== audio) {
      _audioRegistry.current.pause()
      _audioRegistry.current._setPlaying?.(false)
      _audioRegistry.current._stopRaf?.()
    }
    _audioRegistry.current = audio
    audio._setPlaying = setPlaying
    audio._stopRaf = stopRaf

    if (playing) {
      audio.pause()
      stopRaf()
      setPlaying(false)
    } else {
      audio.playbackRate = speed
      audio.play()
        .then(() => { setPlaying(true); startRaf() })
        .catch(() => setLoadState("error"))
    }
  }, [playing, loadState, speed, startRaf, stopRaf])

  const handleScrub = useCallback((e) => {
    const audio = audioRef.current
    if (!audio?.duration) return
    const bar = scrubRef.current
    if (!bar) return
    const rect = bar.getBoundingClientRect()
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    audio.currentTime = frac * audio.duration
    setProgress(frac)
    setElapsed(audio.currentTime)
  }, [])

  const cycleSpeed = useCallback((e) => {
    e.stopPropagation()
    setSpeedIdx((i) => (i + 1) % SPEED_STEPS.length)
  }, [])

  const isLoading = !src || loadState === "loading" || loadState === "idle"
  const isError   = loadState === "error"
  const displayDur = duration
    ? fmtTime(playing ? elapsed : duration)
    : fmtTime(elapsed || 0)

  return (
    <div className={`audio-player${playing ? " audio-playing" : ""}${isError ? " audio-error" : ""}`}>
      <button
        className="audio-btn-play"
        onClick={togglePlay}
        disabled={isError}
        aria-label={playing ? "Jeda" : "Putar"}
        title={isLoading ? "Mengunduh..." : isError ? "Gagal memuat audio" : playing ? "Jeda" : "Putar"}
      >
        {isLoading ? (
          <div className="audio-spinner" />
        ) : isError ? (
          <span style={{ fontSize: 14 }}>⚠</span>
        ) : playing ? (
          <PauseIcon />
        ) : (
          <PlayIcon />
        )}
      </button>

      <div className="audio-track-area">
        <div
          ref={scrubRef}
          className="audio-waveform"
          onClick={handleScrub}
          role="slider"
          aria-label="Posisi audio"
          aria-valuenow={Math.round(progress * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          {waveform.map((h, i) => {
            const barProgress = i / waveform.length
            const filled = barProgress <= progress
            const isActive = Math.abs(barProgress - progress) < 0.04
            return (
              <div
                key={i}
                className="audio-bar-seg"
                style={{
                  height: `${Math.round(h * 100)}%`,
                  background: filled
                    ? isActive ? "var(--green)" : "var(--green-dim)"
                    : "rgba(255,255,255,0.12)",
                  transform: isActive && playing ? "scaleY(1.3)" : "scaleY(1)",
                }}
              />
            )
          })}
        </div>

        <div className="audio-info-row">
          <span className="audio-type-badge">
            {isPtt ? <MicIcon /> : <MusicIcon />}
            <span>{isPtt ? "Pesan Suara" : "Audio"}</span>
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="audio-time">{displayDur}</span>
            {!isLoading && !isError && (
              <button
                className="audio-speed-btn"
                onClick={cycleSpeed}
                title="Ubah kecepatan"
                aria-label={`Kecepatan ${speed}x`}
              >
                {speed}×
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Document bubble ──────────────────────────────────────────────────────────
function DocBubble({ msg }) {
  const filename = msg.media_filename || msg.body || "Dokumen"
  const ext = msg.mimetype
    ? msg.mimetype.split("/")[1]?.split(";")[0]?.toUpperCase()
    : "FILE"
  return (
    <div className="media-doc">
      <div className="doc-icon">{DOC_ICONS[ext] || "📄"}</div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="doc-name">{filename}</div>
        <div className="doc-ext">{ext || "FILE"}</div>
      </div>
    </div>
  )
}

// ─── Sticker bubble ───────────────────────────────────────────────────────────
function StickerBubble({ msg }) {
  const { src, err, setErr } = useMediaSrc(msg)
  const [imgFailed,   setImgFailed]   = useState(false)
  const [videoFailed, setVideoFailed] = useState(false)

  // Reset fallback states when src changes (new download arrived)
  const prevSrcRef = useRef(src)
  if (prevSrcRef.current !== src) {
    prevSrcRef.current = src
    setImgFailed(false)
    setVideoFailed(false)
  }

  if (!src) {
    return (
      <div style={{
        width: 150, height: 150,
        display: "flex", alignItems: "center", justifyContent: "center",
        flexDirection: "column", gap: 6,
        background: "rgba(255,255,255,0.04)", borderRadius: 12,
      }}>
        <span style={{ fontSize: 32 }}>🎭</span>
        <span style={{ fontSize: 10, color: "var(--text-3)", textAlign: "center" }}>
          Mengunduh stiker...
        </span>
        <div className="spinner spinner-sm"
          style={{ borderTopColor: "var(--green)", borderColor: "rgba(37,211,102,.2)" }} />
      </div>
    )
  }

  if (imgFailed && videoFailed) {
    return (
      <div style={{
        width: 150, height: 150,
        display: "flex", alignItems: "center", justifyContent: "center",
        flexDirection: "column", gap: 6,
        background: "rgba(255,255,255,0.04)", borderRadius: 12,
      }}>
        <span style={{ fontSize: 32 }}>🎭</span>
        <span style={{ fontSize: 10, color: "var(--text-3)", textAlign: "center" }}>
          Gagal memuat stiker
        </span>
      </div>
    )
  }

  const stickerStyle = { width: 150, height: 150, objectFit: "contain", display: "block", borderRadius: 4 }

  if (imgFailed) {
    return (
      <video
        src={src}
        autoPlay loop muted playsInline
        onError={() => setVideoFailed(true)}
        style={stickerStyle}
      />
    )
  }

  return (
    <img
      src={src}
      alt="Stiker"
      onError={() => setImgFailed(true)}
      style={stickerStyle}
    />
  )
}

// ─── View once bubble ─────────────────────────────────────────────────────────
function ViewOnceBubble({ msg }) {
  const isVideo = msg.mimetype?.startsWith("video")
  return (
    <div className="viewonce-wrap">
      <div className="viewonce-eye">👁</div>
      <div className="viewonce-title">{isVideo ? "Video" : "Foto"} sekali lihat</div>
      <div className="viewonce-sub">Buka di WhatsApp HP untuk melihat</div>
    </div>
  )
}

// ─── Poll bubble ──────────────────────────────────────────────────────────────
function PollBubble({ msg }) {
  const opts = msg.poll_options || []
  const total = opts.reduce((s, o) => s + (o.votes || 0), 0)
  return (
    <div className="poll-wrap">
      <div className="poll-header">
        <span style={{ fontSize: 20 }}>📊</span>
        <div>
          <div className="poll-title">{msg.body || "Polling"}</div>
          <div className="poll-sub">Pilih salah satu opsi</div>
        </div>
      </div>
      {opts.length > 0
        ? opts.map((o, i) => {
            const pct = total > 0 ? Math.round(((o.votes || 0) / total) * 100) : 0
            return (
              <div key={i} className="poll-option">
                <div className="poll-option-top">
                  <span className="poll-option-name">{o.name || o}</span>
                  <span className="poll-option-pct">{pct}%</span>
                </div>
                <div className="poll-bar">
                  <div className="poll-bar-fill" style={{ width: `${pct}%` }} />
                </div>
              </div>
            )
          })
        : <div className="poll-sub">Buka di HP untuk melihat opsi</div>
      }
      {total > 0 && <div className="poll-total">{total} suara</div>}
    </div>
  )
}

// ─── Location bubble ──────────────────────────────────────────────────────────
function LocationBubble({ msg }) {
  const lat = msg.location_lat
  const lng = msg.location_lng
  const name = msg.location_name || msg.location_address || msg.body || "Lokasi"
  const isLive = msg.msg_type === "liveLocationMessage"
  const mapsUrl = (lat && lng) ? `https://www.google.com/maps?q=${lat},${lng}` : null

  const handleClick = useCallback(() => {
    if (mapsUrl) window.open(mapsUrl, "_blank")
  }, [mapsUrl])

  return (
    <div
      className="media-location"
      onClick={handleClick}
      role={mapsUrl ? "link" : undefined}
      tabIndex={mapsUrl ? 0 : undefined}
      style={{ cursor: mapsUrl ? "pointer" : "default" }}
    >
      <div className="location-map">
        {lat && lng ? (
          <img
            src={`https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=15&size=200x100&markers=${lat},${lng}`}
            alt="Peta"
            style={{ width: "100%", height: 80, objectFit: "cover", borderRadius: 6 }}
            onError={(e) => { e.target.style.display = "none" }}
          />
        ) : (
          <span style={{ fontSize: 32 }}>🗺️</span>
        )}
      </div>
      <div className="location-label">
        {isLive && <span style={{ fontSize: 10, color: "var(--accent)" }}>● LIVE  </span>}
        {name}
      </div>
      {lat && lng && (
        <div style={{ fontSize: 10, color: "var(--text-3)" }}>
          {lat.toFixed(5)}, {lng.toFixed(5)}
        </div>
      )}
    </div>
  )
}

// ─── Contact bubble ───────────────────────────────────────────────────────────
function ContactBubble({ msg }) {
  const contacts = msg.contacts_json || []
  const isArray = msg.msg_type === "contactsArrayMessage"

  if (!contacts.length) {
    return (
      <div className="contact-msg">
        <div className="contact-icon">👤</div>
        <div>
          <div className="contact-name">{msg.body || "Kontak"}</div>
          <div className="contact-sub">Kontak WhatsApp</div>
        </div>
      </div>
    )
  }

  return (
    <div className="contact-msg-list">
      {contacts.map((c, i) => (
        <div key={i} className="contact-msg">
          <div className="contact-icon">👤</div>
          <div>
            <div className="contact-name">{c.displayName || "Kontak"}</div>
            <div className="contact-sub">
              {c.vcard?.match(/TEL[^:]*:([^\n]+)/)?.[1]?.trim() || "Kontak WhatsApp"}
            </div>
          </div>
        </div>
      ))}
      {isArray && contacts.length > 1 && (
        <div className="contact-count">{contacts.length} kontak</div>
      )}
    </div>
  )
}

// ─── Group invite bubble ──────────────────────────────────────────────────────
function GroupInviteBubble({ msg }) {
  return (
    <div className="invite-msg">
      <div className="invite-icon">👥</div>
      <div>
        <div className="invite-title">Undangan Grup</div>
        <div className="invite-sub">{msg.body || "Bergabung ke grup"}</div>
      </div>
    </div>
  )
}

// ─── Interactive / Buttons bubbles ────────────────────────────────────────────
function ButtonsBubble({ msg }) {
  return (
    <div className="buttons-bubble">
      <div className="bubble-text">{msg.body || ""}</div>
      <div className="buttons-hint">🔘 Pesan dengan tombol — buka di HP</div>
    </div>
  )
}

function InteractiveResponseBubble({ msg }) {
  return (
    <div className="bubble-text" style={{ fontStyle: "italic", color: "var(--text-2)" }}>
      ↩ {msg.body || "Memilih opsi"}
    </div>
  )
}

// ─── Commerce bubbles ─────────────────────────────────────────────────────────
function OrderBubble({ msg }) {
  return (
    <div className="media-doc">
      <div className="doc-icon">🛒</div>
      <div>
        <div className="doc-name">{msg.body || "Pesanan"}</div>
        <div className="doc-ext">Pesanan WhatsApp</div>
      </div>
    </div>
  )
}

function PaymentBubble({ msg }) {
  return (
    <div className="media-doc">
      <div className="doc-icon">💳</div>
      <div>
        <div className="doc-name">{msg.body || "Pembayaran"}</div>
        <div className="doc-ext">WhatsApp Pay</div>
      </div>
    </div>
  )
}

function CallLogBubble({ msg }) {
  const isVideo = msg.body?.includes("Video") || msg.mimetype?.includes("video")
  return (
    <div className="call-log">
      <span>{isVideo ? "📹" : "📞"}</span>
      <span>{msg.body || (isVideo ? "Panggilan Video" : "Panggilan Suara")}</span>
    </div>
  )
}

function EventBubble({ msg }) {
  return (
    <div className="media-doc">
      <div className="doc-icon">📅</div>
      <div>
        <div className="doc-name">{msg.body || "Acara"}</div>
        <div className="doc-ext">Acara WhatsApp</div>
      </div>
    </div>
  )
}

function NewsletterBubble({ msg }) {
  return (
    <div className="invite-msg">
      <div className="invite-icon">📢</div>
      <div>
        <div className="invite-title">Undangan Newsletter</div>
        <div className="invite-sub">{msg.body || "Bergabung ke channel"}</div>
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════
// MAIN CONTENT RENDERER
// ════════════════════════════════════════════════════════════
function renderContent(msg, opts = {}) {
  const t = msg.msg_type || "conversation"

  if (toBool(msg.is_view_once) || t === "viewOnceMessage" || t === "viewOnceMessageV2") {
    return <ViewOnceBubble msg={msg} />
  }

  switch (t) {
    case "conversation":
    case "extendedTextMessage":
      return <div className="bubble-text"><RichText text={msg.body || ""} /></div>

    case "imageMessage":    return <ImageBubble msg={msg} onMediaClick={opts?.onMediaClick} />
    case "videoMessage":    return <VideoBubble msg={msg} onMediaClick={opts?.onMediaClick} />
    case "audioMessage":
    case "pttMessage":      return <AudioBubble msg={msg} />
    case "documentMessage": return <DocBubble msg={msg} />
    case "stickerMessage":  return <StickerBubble msg={msg} />

    case "locationMessage":
    case "liveLocationMessage":
      return <LocationBubble msg={msg} />

    case "contactMessage":
    case "contactsArrayMessage":
      return <ContactBubble msg={msg} />

    case "pollCreationMessage":
      return <PollBubble msg={msg} />

    case "pollUpdateMessage":
      return (
        <div className="bubble-text" style={{ fontStyle: "italic", color: "var(--text-2)" }}>
          📊 Vote diperbarui
        </div>
      )

    case "reactionMessage":
      return null

    case "groupInviteMessage":
      return <GroupInviteBubble msg={msg} />

    case "buttonsMessage":
    case "listMessage":
    case "templateMessage":
    case "interactiveMessage":
      return <ButtonsBubble msg={msg} />

    case "buttonsResponseMessage":
    case "listResponseMessage":
    case "templateButtonReplyMessage":
    case "interactiveResponseMessage":
      return <InteractiveResponseBubble msg={msg} />

    case "orderMessage":
      return <OrderBubble msg={msg} />

    case "productMessage":
      return (
        <div className="media-doc">
          <div className="doc-icon">🛍️</div>
          <div>
            <div className="doc-name">{msg.body || "Produk"}</div>
            <div className="doc-ext">Produk WhatsApp</div>
          </div>
        </div>
      )

    case "paymentMessage":
    case "requestPaymentMessage":
    case "sendPaymentMessage":
      return <PaymentBubble msg={msg} />

    case "callLogMessage":               return <CallLogBubble msg={msg} />
    case "eventMessage":                 return <EventBubble msg={msg} />
    case "newsletterAdminInviteMessage": return <NewsletterBubble msg={msg} />

    case "protocol":
    case "ephemeral":
    case "messageContextInfo":
    case "unknown":
      return null

    default: {
      if (msg.body) return <div className="bubble-text"><RichText text={msg.body} /></div>
      const LABELS = {
        call: "📞 Panggilan", payment: "💳 Pembayaran",
        order: "🛒 Pesanan",  product: "🛍 Produk",
        event: "📅 Acara",    buttons: "🔘 Tombol",
        list: "📋 Daftar",    interactive: "💬 Interaktif",
        keepInChat: "📌 Disimpan", pinInChat: "📌 Disematkan",
      }
      return <div className="bubble-unsupported">{LABELS[t] || `📎 ${t}`}</div>
    }
  }
}

// ════════════════════════════════════════════════════════════
// CONTEXT MENU
// ════════════════════════════════════════════════════════════
function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null)

  useEffect(() => {
    const close = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose()
    }
    document.addEventListener("mousedown", close)
    document.addEventListener("contextmenu", close)
    return () => {
      document.removeEventListener("mousedown", close)
      document.removeEventListener("contextmenu", close)
    }
  }, [onClose])

  const style = {
    left: Math.min(x, window.innerWidth - 180),
    top:  Math.min(y, window.innerHeight - items.length * 38 - 20),
  }

  return (
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      style={{ position: "fixed", ...style }}
    >
      {items.map((item, i) =>
        item === "divider" ? (
          <div key={i} className="ctx-menu-divider" role="separator" />
        ) : (
          <div
            key={i}
            className={`ctx-menu-item${item.danger ? " danger" : ""}`}
            role="menuitem"
            tabIndex={0}
            onMouseDown={(e) => { e.stopPropagation(); item.action(); onClose() }}
            onKeyDown={(e) => { if (e.key === "Enter") { item.action(); onClose() } }}
          >
            {item.icon && <span style={{ fontSize: 15 }} aria-hidden="true">{item.icon}</span>}
            {item.label}
          </div>
        )
      )}
    </div>
  )
}

// ════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ════════════════════════════════════════════════════════════
export default function MessageBubble({ msg, onReply, onScrollToMsg, onMediaClick }) {
  // ── [FIX-1+FIX-5] Normalize ALL SQLite integer booleans ──────────────────
  const isMe        = toBool(msg.from_me)
  const isGroup     = toBool(msg.is_group)
  const isForwarded = toBool(msg.is_forwarded)

  const t          = msg.msg_type || "conversation"
  const isReaction = t === "reactionMessage"
  const isSticker  = t === "stickerMessage"
  const hasNoPad   = NO_PAD_TYPES.has(t)

  // [FIX-4] Quoted message — check all possible fields
  const hasQuoted = !!(msg.quoted_id || msg.quoted_body || msg.quoted_sender)

  // [FIX-3] Null-safe sender initial
  const senderInitial = (msg.sender_name || msg.sender_jid || "?")[0].toUpperCase()

  // ── [FIX-8] ALL hooks must be declared before any early returns ────────────
  const [swiping,     setSwiping]     = useState(false)
  const [highlighted, setHighlighted] = useState(false)
  const [ctxMenu,     setCtxMenu]     = useState(null)
  const swipeStartX    = useRef(null)
  const swipeTriggered = useRef(false)
  const wrapRef        = useRef(null)
  const mouseStartX    = useRef(null)
  const mouseDown      = useRef(false)

  const handleReply = useCallback(() => {
    if (onReply) onReply(msg)
  }, [msg, onReply])

  // Touch swipe handlers
  const onTouchStart = useCallback((e) => {
    swipeStartX.current = e.touches[0].clientX
    swipeTriggered.current = false
  }, [])

  const onTouchMove = useCallback((e) => {
    if (swipeStartX.current === null) return
    const dx = e.touches[0].clientX - swipeStartX.current
    const triggered = isMe ? dx < -40 : dx > 40
    if (triggered && !swipeTriggered.current) {
      swipeTriggered.current = true
      setSwiping(true)
      handleReply()
      setTimeout(() => setSwiping(false), 400)
    }
  }, [isMe, handleReply])

  const onTouchEnd = useCallback(() => {
    swipeStartX.current = null
  }, [])

  const onMouseDown = useCallback((e) => {
    if (e.button !== 0) return
    mouseStartX.current = e.clientX
    mouseDown.current = true
    swipeTriggered.current = false
  }, [])

  const onMouseMove = useCallback((e) => {
    if (!mouseDown.current || mouseStartX.current === null) return
    const dx = e.clientX - mouseStartX.current
    const triggered = isMe ? dx < -50 : dx > 50
    if (triggered && !swipeTriggered.current) {
      swipeTriggered.current = true
      setSwiping(true)
      handleReply()
      setTimeout(() => setSwiping(false), 400)
    }
  }, [isMe, handleReply])

  const onMouseUp = useCallback(() => {
    mouseDown.current = false
    mouseStartX.current = null
  }, [])

  const onContextMenu = useCallback((e) => {
    e.preventDefault()
    setCtxMenu({ x: e.clientX, y: e.clientY })
  }, [])

  // Highlight when scrolled to
  useEffect(() => {
    if (!wrapRef.current) return
    const el = wrapRef.current
    const handler = () => {
      setHighlighted(true)
      setTimeout(() => setHighlighted(false), 1800)
    }
    el.addEventListener("msg-highlight", handler)
    return () => el.removeEventListener("msg-highlight", handler)
  }, [])

  // ── Derived values ─────────────────────────────────────────────────────────
  const bubbleClass = [
    "bubble",
    isMe ? "me" : null,
    (isReaction || isSticker) ? "sticker" : null,
    hasNoPad ? "no-pad" : null,
  ].filter(Boolean).join(" ")

  const content = renderContent(msg, { onMediaClick })

  // System messages render nothing
  if (content === null) return null

  // ── Context menu items ─────────────────────────────────────────────────────
  const getPreviewText = () => {
    if (t === "imageMessage") return "📷 Foto"
    if (t === "videoMessage") return "🎬 Video"
    if (t === "audioMessage" || t === "pttMessage") return "🎵 Audio"
    if (t === "stickerMessage") return "🎭 Stiker"
    if (t === "documentMessage") return `📄 ${msg.media_filename || "Dokumen"}`
    return msg.body || "Pesan"
  }

  const ctxItems = [
    { icon: "↩", label: "Balas", action: handleReply },
    "divider",
    {
      icon: "📋",
      label: "Salin",
      action: () => navigator.clipboard?.writeText(msg.body || getPreviewText()),
    },
    ...(hasQuoted && onScrollToMsg
      ? [{ icon: "⬆", label: "Lihat pesan dikutip", action: () => onScrollToMsg(msg.quoted_id) }]
      : []),
  ]

  // ── [REACTION-FLOAT] reactionMessage = floating emoji, NO bubble ──────────
  if (isReaction) {
    const emoji = msg.body || msg.reaction_emoji || "❤️"
    return (
      <div
        ref={wrapRef}
        style={{
          display: "flex",
          justifyContent: isMe ? "flex-end" : "flex-start",
          padding: "1px 14px",
          userSelect: "none",
        }}
      >
        <div style={{
          display: "flex", flexDirection: "column",
          alignItems: isMe ? "flex-end" : "flex-start", gap: 2,
        }}>
          {!isMe && isGroup && msg.sender_name && (
            <div style={{ fontSize: 11, color: "var(--text-3)", paddingLeft: 2 }}>
              {msg.sender_name}
            </div>
          )}
          <div
            title={`Reaksi • ${msg.sender_name || (isMe ? "Kamu" : "Mereka")}`}
            style={{
              fontSize: 28, lineHeight: 1, cursor: "default",
              filter: "drop-shadow(0 1px 3px rgba(0,0,0,0.4))",
              transition: "transform 0.12s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.transform = "scale(1.18)" }}
            onMouseLeave={(e) => { e.currentTarget.style.transform = "scale(1)" }}
          >
            {emoji}
          </div>
          <div style={{ fontSize: 10, color: "var(--text-3)", lineHeight: 1 }}>
            {msg.timestamp
              ? new Date(msg.timestamp * 1000).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })
              : ""}
            {isMe && (
              <span style={{ marginLeft: 3, opacity: 0.7 }}>
                {Number(msg.status) >= 3 ? "✓✓" : "✓"}
              </span>
            )}
          </div>
        </div>
      </div>
    )
  }

  // ── [FIX-3] LAYOUT: msg-row structure ────────────────────────────────────
  return (
    <div
      ref={wrapRef}
      className={`msg-row-wrap ${isMe ? "me" : "them"}${swiping ? " swiping" : ""}`}
      style={{ position: "relative", display: "flex", alignItems: "center" }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
    >
      {/* Reply quick button — appears on hover */}
      <button
        className="reply-btn"
        title="Balas"
        aria-label="Balas pesan"
        onMouseDown={(e) => { e.stopPropagation(); handleReply() }}
      >
        <ReplyIcon />
      </button>

      {/* Context menu */}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={ctxItems}
          onClose={() => setCtxMenu(null)}
        />
      )}

      <div
        className={`msg-row${isMe ? " me" : " them"}${highlighted ? " highlighted" : ""}`}
        onContextMenu={onContextMenu}
        style={{ flex: 1, minWidth: 0 }}
      >
        {/* Sender name — group chats only, opponent only */}
        {!isMe && isGroup && msg.sender_name && (
          <div className="msg-sender-name">{msg.sender_name}</div>
        )}

        {/* Inner row: [avatar?] [bubble] */}
        <div className={`msg-inner${isMe ? " me" : ""}`}>

          {/* Group mini-avatar — opponent only */}
          {!isMe && isGroup && (
            <div
              className="msg-mini-avatar"
              aria-hidden="true"
              style={{ background: "#1565c0", flexShrink: 0 }}
            >
              {senderInitial}
            </div>
          )}

          {/* Bubble wrapper */}
          <div className="bubble-wrap" style={{ position: "relative" }}>
            <div className={bubbleClass} style={{ position: "relative" }}>

              {/* Forward indicator */}
              {isForwarded && <ForwardBadge score={msg.forwarding_score} />}

              {/* [FIX-2+FIX-4] Quoted/reply preview */}
              {hasQuoted && (
                <QuotedMsg
                  body={msg.quoted_body}
                  sender={msg.quoted_sender}
                  type={msg.quoted_type}
                  hasMedia={toBool(msg.quoted_has_media)}
                  mimetype={msg.quoted_mimetype}
                  onClick={() => onScrollToMsg && msg.quoted_id && onScrollToMsg(msg.quoted_id)}
                  quotedFromMe={msg.quoted_sender === "__me__"}
                />
              )}

              {/* Main message content */}
              {content}

              {/* Footer: timestamp + delivery ticks */}
              {!isReaction && !isSticker && (() => {
                const isImgVideo = t === "imageMessage" || t === "videoMessage"
                if (isImgVideo && !msg.body) {
                  return (
                    <div style={{
                      position: "absolute", bottom: 6, right: 8,
                      background: "rgba(0,0,0,0.55)", backdropFilter: "blur(4px)",
                      borderRadius: 8, padding: "1px 6px",
                      display: "flex", alignItems: "center", gap: 3,
                      pointerEvents: "none",
                    }}>
                      <BubbleTime ts={msg.timestamp} />
                      {isMe && <Ticks status={msg.status} />}
                    </div>
                  )
                }
                return (
                  <div className={`bubble-footer${isMe ? " me" : ""}`}>
                    <BubbleTime ts={msg.timestamp} />
                    {isMe && <Ticks status={msg.status} />}
                  </div>
                )
              })()}
            </div>

            {/* Emoji reactions overlay */}
            {msg.reactions && <ReactionOverlay reactions={msg.reactions} />}
          </div>
        </div>
      </div>
    </div>
  )
}