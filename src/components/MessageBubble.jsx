// src/components/MessageBubble.jsx
// ═══════════════════════════════════════════════════════════════════════════
// PRODUCTION GRADE v3 — AuroraChat Message Bubble
//
// FIXES:
// [FIX-1] toBool() — SQLite 0/1 → boolean everywhere. {0 && <X/>} = "0" bug.
// [FIX-2] QuotedMsg sender — was showing raw JID "628xxx@s.whatsapp.net",
//         now shows clean display name (resolved upstream in chat.js store).
// [FIX-3] msg-row layout — ALL conditional renders use toBool().
//         No stray text nodes. msg-row flexbox alignment is clean.
// [FIX-4] Quoted bubble — added left accent bar + proper styling so it
//         doesn't visually break the bubble layout.
// [FIX-5] from_me detection — reliable, uses toBool(msg.from_me).
// ═══════════════════════════════════════════════════════════════════════════

import { format } from "date-fns"
import { useState, useRef, useCallback, useEffect } from "react"
import { prefetchChat } from "../hooks/useMediaPrefetch"

// ─── Reply Icon SVG ───────────────────────────────────────────────────────────
function ReplyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 17 4 12 9 7"/>
      <path d="M20 18v-2a4 4 0 0 0-4-4H4"/>
    </svg>
  )
}

// ════════════════════════════════════════════════════════════
// [FIX-1] toBool — normalize SQLite 0/1 → JS boolean
// CRITICAL: Never use {sqliteInt && <JSX/>} — renders "0" as text
// ════════════════════════════════════════════════════════════
const toBool = (v) => v === 1 || v === true

// ─── Media path → loadable URL ───────────────────────────────────────────────
// Handles: file:// prefixed paths, Unix /absolute, Windows D:\absolute\path
function getMediaSrc(msg) {
  const p = msg.media_saved_path
  if (p) return pathToFileUrl(p)
  if (msg.media_url) return msg.media_url
  return null
}

function pathToFileUrl(rawPath) {
  if (!rawPath) return null
  // Already a file:// URL
  if (rawPath.startsWith("file://")) {
    // Guard against legacy broken encoding: D%3A → D: (old normalizeMediaPath bug)
    // If the path contains %3A (encoded colon) right after a drive letter, decode and re-encode correctly
    if (rawPath.includes("%3A") || rawPath.includes("%3a")) {
      try {
        // Decode entire URL, then re-run through pathToFileUrl as a raw path
        const decoded = decodeURIComponent(rawPath.replace(/^file:\/\/\/?/, ""))
        return pathToFileUrl(decoded)
      } catch (_) {}
    }
    return rawPath
  }
  // Normalize backslashes (Windows)
  let p = rawPath.replace(/\\/g, "/")
  // Windows drive letter: "D:/..." → "file:///D:/..."
  // We must NOT encode the colon in "D:" — only encode path segments
  const winDrive = /^([A-Za-z]):\//
  if (winDrive.test(p)) {
    // e.g. "D:/path/to file/img.webp" → "file:///D:/path/to%20file/img.webp"
    const encoded = p.replace(winDrive, (_, letter) => `/${letter.toUpperCase()}:/`)
      .split("/")
      .map((seg, i) => {
        // First segment after split("D:/") is empty or drive — don't encode
        if (i === 0) return seg
        // Preserve drive-colon segment "D:"
        if (/^[A-Za-z]:$/.test(seg)) return seg
        return encodeURIComponent(seg)
      })
      .join("/")
    return `file://${encoded}`
  }
  // Unix absolute path
  const withSlash = p.startsWith("/") ? p : `/${p}`
  const encoded = withSlash.split("/").map((seg, i) => i === 0 ? seg : encodeURIComponent(seg)).join("/")
  return `file://${encoded}`
}

// ─── useMediaSrc — reactive media source with existence check ────────────────
// 1. Shows src IMMEDIATELY (optimistic) from stored path — no flicker on open
// 2. Resets error state when path changes (media:updated fires after download)
// 3. Async existence check: if file is gone (deleted / session change), clears
//    src so bubble shows "downloading..." and prefetch can re-trigger.
function useMediaSrc(msg) {
  const rawPath = msg.media_saved_path || null
  // Start optimistic: show path immediately, verify async
  const [verifiedSrc, setVerifiedSrc] = useState(() => rawPath ? pathToFileUrl(rawPath) : null)
  const [err, setErr] = useState(false)
  const prevRaw = useRef(rawPath)
  const checkRef = useRef(false)  // prevent double-check on strict mode

  // When rawPath changes (media:updated arrives), accept immediately + reset error
  if (prevRaw.current !== rawPath) {
    prevRaw.current = rawPath
    const newSrc = rawPath ? pathToFileUrl(rawPath) : null
    setVerifiedSrc(newSrc)
    if (err) setErr(false)
    checkRef.current = false  // allow re-check for new path
  }

  // Async existence verification — only when we have a path and haven't checked yet
  useEffect(() => {
    if (!rawPath || checkRef.current) return
    if (!window.api?.fsExists) return  // IPC not available (unit tests / dev)
    checkRef.current = true

    window.api.fsExists({ rawPath }).then(exists => {
      if (!exists) {
        // File is gone — clear src (shows "downloading...") and re-trigger download
        setVerifiedSrc(null)
        if (msg.chat_jid) prefetchChat(msg.chat_jid, 30, true)
      }
      // If exists: already showing correct src, nothing to do
    }).catch(() => {
      // IPC error — keep showing current optimistic src
    })
  }, [rawPath]) // eslint-disable-line react-hooks/exhaustive-deps

  // Fallback to media_url if no local file
  const src = verifiedSrc || (msg.media_url || null)
  return { src, err, setErr }
}

// ─── Format phone number ──────────────────────────────────────────────────────
function fmtPhone(raw) {
  if (!raw) return "?"
  // Strip @domain if still present
  const n = raw.includes("@") ? raw.split("@")[0] : raw
  if (!/^\d{6,}$/.test(n)) return raw
  return `+${n}`
}

// ─── Tick indicators ──────────────────────────────────────────────────────────
function Ticks({ status }) {
  const s = Number(status)
  if (s === 0) return <span style={{ fontSize: 10, color: "var(--text-3)", marginLeft: 2 }}>⏱</span>
  if (s === 1) return <span className="tick-sent" style={{ marginLeft: 2 }}>✓</span>
  if (s === 2) return <span className="tick-sent" style={{ marginLeft: 2 }}>✓✓</span>
  return <span className="tick-read" style={{ marginLeft: 2 }}>✓✓</span>
}

function BubbleTime({ ts }) {
  if (!ts) return null
  return (
    <span className="bubble-time">
      {format(new Date(ts * 1000), "HH:mm")}
    </span>
  )
}

// ─── [FIX-2] Quoted/reply preview ────────────────────────────────────────────
// sender is now already resolved to display name by chat.js store
function QuotedMsg({ body, sender, type, hasMedia, mimetype, onClick, quotedFromMe }) {
  // Don't render if both sender and body are empty/null
  if (!sender && !body && !hasMedia && !quotedFromMe) return null

  const mediaIcon = (() => {
    if (!hasMedia) return null
    if (mimetype?.startsWith("image")) return "🖼️ "
    if (mimetype?.startsWith("video")) return "🎬 "
    if (mimetype?.startsWith("audio")) return "🎵 "
    if (mimetype?.includes("pdf"))     return "📕 "
    return "📎 "
  })()

  // [FIX-OWN] sender is null when resolveQuotedSender detected it was our own JID
  // quotedFromMe = true means the quoted message was sent by us
  let displaySender
  if (quotedFromMe || sender === null) {
    displaySender = "Kamu"
  } else if (sender) {
    // Already resolved by chat.js — but strip if it still has @
    displaySender = sender.includes("@") ? fmtPhone(sender) : sender
  } else {
    displaySender = null
  }

  return (
    <div
      className="quoted"
      onClick={onClick}
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
}

// ─── Reaction overlay ─────────────────────────────────────────────────────────
function ReactionOverlay({ reactions }) {
  if (!reactions?.length) return null
  const grouped = {}
  for (const r of reactions) grouped[r.text] = (grouped[r.text] || 0) + 1
  return (
    <div className="reaction-row">
      {Object.entries(grouped).map(([e, n]) => (
        <div key={e} className="reaction-chip">
          <span>{e}</span>
          {n > 1 && <span className="reaction-chip-count">{n}</span>}
        </div>
      ))}
    </div>
  )
}

// ─── Forward badge ────────────────────────────────────────────────────────────
function ForwardBadge({ score }) {
  if (!score) return null
  return (
    <div className="forward-badge">
      <span>↪</span>
      <span>{score >= 5 ? "Sering diteruskan" : "Diteruskan"}</span>
    </div>
  )
}

// ─── Image bubble ─────────────────────────────────────────────────────────────
function ImageBubble({ msg }) {
  const { src, err, setErr } = useMediaSrc(msg)

  if (!src || err) {
    return (
      <div className="media-img">
        <div className="media-img-thumb" style={{
          display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center",
          gap: 4, minHeight: 100,
        }}>
          <span style={{ fontSize: 38 }}>🖼️</span>
          <span style={{ fontSize: 10, color: "var(--text-3)" }}>
            {src ? "Gagal memuat" : "Mengunduh..."}
          </span>
        </div>
        {msg.body && <div className="media-caption">{msg.body}</div>}
      </div>
    )
  }

  return (
    <div className="media-img">
      <img
        src={src}
        alt={msg.body || "Foto"}
        onError={() => setErr(true)}
        style={{
          maxWidth: "100%", maxHeight: 300,
          borderRadius: 8, display: "block",
          objectFit: "cover", cursor: "pointer",
        }}
      />
      {msg.body && <div className="media-caption">{msg.body}</div>}
    </div>
  )
}

// ─── Video bubble ─────────────────────────────────────────────────────────────
function VideoBubble({ msg }) {
  const { src, err, setErr } = useMediaSrc(msg)
  const isGif = toBool(msg.is_gif)

  if (!src || err) {
    return (
      <div className="media-video">
        <div className="media-video-thumb">
          <div className="play-btn">{isGif ? "GIF" : "▶️"}</div>
          <span style={{ fontSize: 12, color: "var(--text-3)" }}>
            {msg.body || (isGif ? "GIF" : "Video")}
          </span>
        </div>
      </div>
    )
  }

  if (isGif) {
    return (
      <div className="media-img">
        <video
          src={src} autoPlay loop muted playsInline
          onError={() => setErr(true)}
          style={{ maxWidth: "100%", maxHeight: 280, borderRadius: 8, display: "block" }}
        />
        <div className="gif-badge">GIF</div>
        {msg.body && <div className="media-caption">{msg.body}</div>}
      </div>
    )
  }

  return (
    <div className="media-video">
      <video
        src={src} controls preload="metadata"
        onError={() => setErr(true)}
        style={{ maxWidth: "100%", maxHeight: 280, borderRadius: 8, display: "block" }}
      />
      {msg.body && <div className="media-caption">{msg.body}</div>}
    </div>
  )
}

// ─── Audio / PTT bubble ───────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════
// AUDIO PLAYER — Real playback with waveform, scrub, speed
// ════════════════════════════════════════════════════════════

// ── Global singleton: only one audio plays at a time ────────
// Uses a module-level ref so any AudioBubble can stop others.
const _audioRegistry = { current: null }

// ── Deterministic waveform from message id ───────────────────
// WhatsApp doesn't expose waveform data via Baileys, so we
// generate a stable-looking waveform seeded from the message id.
// Same message always shows the same bars (deterministic, no flicker).
function seedWaveform(id, bars = 40) {
  const str = id || "x"
  let h = 0
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0
  }
  const heights = []
  for (let i = 0; i < bars; i++) {
    // LCG: fast, good distribution
    h = (Math.imul(1664525, h) + 1013904223) | 0
    // Shape: taller in the middle, quieter at ends (natural voice envelope)
    const pos = i / bars
    const envelope = 1 - Math.pow((pos - 0.5) * 2, 4)
    const raw = ((h >>> 0) / 0xFFFFFFFF)   // 0..1
    heights.push(0.12 + raw * 0.88 * envelope)
  }
  return heights
}

function fmtTime(s) {
  if (!s || !isFinite(s)) return "0:00"
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, "0")}`
}

const SPEED_STEPS = [1, 1.5, 2]

function AudioBubble({ msg }) {
  const { src }   = useMediaSrc(msg)
  const isPtt     = toBool(msg.is_ptt) || msg.msg_type === "pttMessage"
  const msgId     = msg.id || msg.message_id || ""
  const waveform  = useRef(seedWaveform(msgId)).current

  const audioRef  = useRef(null)
  const [playing,    setPlaying]    = useState(false)
  const [progress,   setProgress]   = useState(0)       // 0..1
  const [elapsed,    setElapsed]    = useState(0)        // seconds
  const [duration,   setDuration]   = useState(msg.media_duration || msg.duration || 0)
  const [speedIdx,   setSpeedIdx]   = useState(0)        // index into SPEED_STEPS
  const [loadState,  setLoadState]  = useState("idle")   // idle|loading|ready|error
  const scrubRef  = useRef(null)
  const rafRef    = useRef(null)

  const speed = SPEED_STEPS[speedIdx]

  // ── Create / manage <audio> element ──────────────────────
  useEffect(() => {
    if (!src) return
    const audio = new Audio()
    audio.preload = "metadata"
    audio.src = src
    audioRef.current = audio
    setLoadState("loading")

    audio.addEventListener("loadedmetadata", () => {
      setDuration(audio.duration)
      setLoadState("ready")
    })
    audio.addEventListener("error", () => {
      setLoadState("error")
    })
    audio.addEventListener("ended", () => {
      setPlaying(false)
      setProgress(0)
      setElapsed(0)
      audio.currentTime = 0
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    })

    // Register for singleton management
    const cleanup = () => {
      audio.pause()
      audio.src = ""
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
    audio._cleanupFn = cleanup

    return () => {
      if (_audioRegistry.current === audio) _audioRegistry.current = null
      cleanup()
    }
  }, [src])

  // ── Apply speed changes ───────────────────────────────────
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = speed
  }, [speed])

  // ── RAF loop for progress ─────────────────────────────────
  const startRaf = useCallback(() => {
    const tick = () => {
      const audio = audioRef.current
      if (!audio) return
      const t = audio.currentTime
      const d = audio.duration || 1
      setProgress(t / d)
      setElapsed(t)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [])

  const stopRaf = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
  }, [])

  // ── Play / Pause ──────────────────────────────────────────
  const togglePlay = useCallback(() => {
    const audio = audioRef.current
    if (!audio || loadState === "error") return

    // Stop any other playing audio (singleton)
    if (_audioRegistry.current && _audioRegistry.current !== audio) {
      _audioRegistry.current.pause()
      _audioRegistry.current._setPlaying?.(false)
      // Stop their RAF via a custom signal
      _audioRegistry.current._stopRaf?.()
    }
    _audioRegistry.current = audio
    // Expose control hooks for singleton stop
    audio._setPlaying = setPlaying
    audio._stopRaf = stopRaf

    if (playing) {
      audio.pause()
      stopRaf()
      setPlaying(false)
    } else {
      audio.playbackRate = speed
      audio.play().then(() => {
        setPlaying(true)
        startRaf()
      }).catch(() => {
        setLoadState("error")
      })
    }
  }, [playing, loadState, speed, startRaf, stopRaf])

  // ── Scrub bar click / drag ────────────────────────────────
  const handleScrub = useCallback((e) => {
    const audio = audioRef.current
    if (!audio || !audio.duration) return
    const bar = scrubRef.current
    if (!bar) return
    const rect = bar.getBoundingClientRect()
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    audio.currentTime = frac * audio.duration
    setProgress(frac)
    setElapsed(audio.currentTime)
  }, [])

  // ── Speed cycle ───────────────────────────────────────────
  const cycleSpeed = useCallback((e) => {
    e.stopPropagation()
    setSpeedIdx(i => (i + 1) % SPEED_STEPS.length)
  }, [])

  // ── Render helpers ────────────────────────────────────────
  const isLoading = !src || loadState === "loading" || loadState === "idle"
  const isError   = loadState === "error"
  const displayDur = duration ? fmtTime(playing ? elapsed : duration) : fmtTime(elapsed || 0)

  // Play/pause icon — SVG for crispness
  const PlayIcon = () => (
    <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
      <polygon points="6,4 20,12 6,20" />
    </svg>
  )
  const PauseIcon = () => (
    <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
      <rect x="5" y="4" width="4" height="16" rx="1"/>
      <rect x="15" y="4" width="4" height="16" rx="1"/>
    </svg>
  )
  const MicIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="13" height="13"
      strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="2" width="6" height="11" rx="3"/>
      <path d="M5 10a7 7 0 0 0 14 0"/>
      <line x1="12" y1="19" x2="12" y2="23"/>
      <line x1="8" y1="23" x2="16" y2="23"/>
    </svg>
  )
  const MusicIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="13" height="13"
      strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18V5l12-2v13"/>
      <circle cx="6" cy="18" r="3"/>
      <circle cx="18" cy="16" r="3"/>
    </svg>
  )

  return (
    <div className={`audio-player${playing ? " audio-playing" : ""}${isError ? " audio-error" : ""}`}>

      {/* Play/Pause button */}
      <button
        className="audio-btn-play"
        onClick={togglePlay}
        disabled={isError}
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

      {/* Track area */}
      <div className="audio-track-area">

        {/* Waveform bars + scrub overlay */}
        <div
          ref={scrubRef}
          className="audio-waveform"
          onClick={handleScrub}
          title="Klik untuk loncat ke posisi"
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
                    ? isActive
                      ? "var(--green)"
                      : "var(--green-dim)"
                    : "rgba(255,255,255,0.12)",
                  transform: isActive && playing ? "scaleY(1.3)" : "scaleY(1)",
                }}
              />
            )
          })}
        </div>

        {/* Bottom row: type label + time + speed */}
        <div className="audio-info-row">
          <span className="audio-type-badge">
            {isPtt ? <MicIcon /> : <MusicIcon />}
            <span>{isPtt ? "Pesan Suara" : "Audio"}</span>
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="audio-time">{displayDur}</span>
            {!isLoading && !isError && (
              <button className="audio-speed-btn" onClick={cycleSpeed} title="Ubah kecepatan">
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
const DOC_ICONS = {
  PDF: "📕", DOCX: "📘", DOC: "📘", XLSX: "📗", XLS: "📗",
  PPTX: "📙", PPT: "📙", ZIP: "🗜️", RAR: "🗜️", TXT: "📃",
  APK: "📱", MP4: "🎬", PNG: "🖼️", JPG: "🖼️", MP3: "🎵",
  OGG: "🎵", AAC: "🎵", CSV: "📊",
}

function DocBubble({ msg }) {
  const mimetype = msg.mimetype
  const filename = msg.media_filename || msg.body || "Dokumen"
  const ext = mimetype
    ? mimetype.split("/")[1]?.split(";")[0]?.toUpperCase()
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
// Stickers are WebP (static or animated). Electron/Chromium handles animated
// WebP natively via <img>. We try <img> first; if it fails (e.g. corrupt file
// or CORS on remote URL), fall back to <video autoPlay loop muted>.
// useMediaSrc() auto-resets `err` when media:updated fires a new path.
function StickerBubble({ msg }) {
  const { src, err, setErr } = useMediaSrc(msg)
  const [imgFailed, setImgFailed] = useState(false)
  const [videoFailed, setVideoFailed] = useState(false)
  const isAnimated = toBool(msg.is_animated)

  // Reset fallback states when src changes (new download arrived)
  const prevSrcRef = useRef(src)
  if (prevSrcRef.current !== src) {
    prevSrcRef.current = src
    setImgFailed(false)
    setVideoFailed(false)
  }

  // No source yet — still downloading
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
        <div className="spinner spinner-sm" style={{ borderTopColor: "var(--green)", borderColor: "rgba(37,211,102,.2)" }} />
      </div>
    )
  }

  // Both img and video failed — show error with retry hint
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

  const stickerStyle = {
    width: 150, height: 150,
    objectFit: "contain", display: "block",
    borderRadius: 4,
  }

  // If img failed (e.g. video/webm sticker), try video element
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

  // Default: <img> — Electron Chromium renders animated WebP natively
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
          const pct = total > 0 ? Math.round((o.votes || 0) / total * 100) : 0
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

  return (
    <div
      className="media-location"
      onClick={() => mapsUrl && window.open(mapsUrl, "_blank")}
      style={{ cursor: mapsUrl ? "pointer" : "default" }}
    >
      <div className="location-map">
        {lat && lng ? (
          <img
            src={`https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=15&size=200x100&markers=${lat},${lng}`}
            alt="Peta"
            style={{ width: "100%", height: 80, objectFit: "cover", borderRadius: 6 }}
            onError={e => { e.target.style.display = "none" }}
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

// ─── Buttons/Interactive bubble ───────────────────────────────────────────────
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

// ─── Call log bubble ─────────────────────────────────────────────────────────
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

function renderContent(msg) {
  const t = msg.msg_type || "conversation"

  // ViewOnce check — both type string and integer flag
  if (toBool(msg.is_view_once) || t === "viewOnceMessage" || t === "viewOnceMessageV2") {
    return <ViewOnceBubble msg={msg} />
  }

  switch (t) {
    case "conversation":
    case "extendedTextMessage":
      return <div className="bubble-text">{msg.body || ""}</div>

    case "imageMessage":    return <ImageBubble msg={msg} />
    case "videoMessage":    return <VideoBubble msg={msg} />
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
      return (
        <div style={{ fontSize: 32, padding: "2px 4px", lineHeight: 1 }}>
          {msg.body || msg.reaction_emoji || "❤️"}
        </div>
      )

    case "groupInviteMessage":     return <GroupInviteBubble msg={msg} />

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

    case "orderMessage":           return <OrderBubble msg={msg} />

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

    case "callLogMessage":              return <CallLogBubble msg={msg} />
    case "eventMessage":                return <EventBubble msg={msg} />
    case "newsletterAdminInviteMessage": return <NewsletterBubble msg={msg} />

    // System messages — render nothing, parent will skip
    case "protocol":
    case "ephemeral":
    case "messageContextInfo":
    case "unknown":
      return null

    default: {
      if (msg.body) return <div className="bubble-text">{msg.body}</div>
      const LABELS = {
        call: "📞 Panggilan", payment: "💳 Pembayaran",
        order: "🛒 Pesanan", product: "🛍 Produk",
        event: "📅 Acara", buttons: "🔘 Tombol",
        list: "📋 Daftar", interactive: "💬 Interaktif",
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

  // Ensure menu doesn't go off-screen
  const style = {
    left: Math.min(x, window.innerWidth - 180),
    top: Math.min(y, window.innerHeight - items.length * 38 - 20),
  }

  return (
    <div ref={ref} className="ctx-menu" style={{ position: "fixed", ...style }}>
      {items.map((item, i) =>
        item === "divider" ? (
          <div key={i} className="ctx-menu-divider" />
        ) : (
          <div
            key={i}
            className={`ctx-menu-item${item.danger ? " danger" : ""}`}
            onMouseDown={(e) => { e.stopPropagation(); item.action(); onClose() }}
          >
            {item.icon && <span style={{ fontSize: 15 }}>{item.icon}</span>}
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

export default function MessageBubble({ msg, onReply, onScrollToMsg }) {
  // ── [FIX-1+FIX-5] Normalize ALL SQLite integer booleans ──────────────────
  const isMe        = toBool(msg.from_me)
  const isGroup     = toBool(msg.is_group)
  const isForwarded = toBool(msg.is_forwarded)

  const t          = msg.msg_type || "conversation"
  const isReaction = t === "reactionMessage"
  const isSticker  = t === "stickerMessage"

  // No-padding types (media rendered flush to bubble edge)
  const NO_PAD_TYPES = new Set([
    "imageMessage", "videoMessage", "stickerMessage",
    "viewOnceMessage", "viewOnceMessageV2",
  ])
  const hasNoPad = NO_PAD_TYPES.has(t)

  const bubbleClass = [
    "bubble",
    isMe ? "me" : null,
    (isReaction || isSticker) ? "sticker" : null,
    hasNoPad ? "no-pad" : null,
  ].filter(Boolean).join(" ")

  const content = renderContent(msg)

  // System messages render nothing
  if (content === null) return null

  // [FIX-4] Quoted message — check all possible fields
  const hasQuoted = !!(msg.quoted_id || msg.quoted_body || msg.quoted_sender)

  // [FIX-3] Null-safe sender initial
  const senderInitial = (msg.sender_name || msg.sender_jid || "?")[0].toUpperCase()

  // ── Reply via swipe state ──────────────────────────────────────────────
  const [swiping, setSwiping] = useState(false)
  const [highlighted, setHighlighted] = useState(false)
  const swipeStartX = useRef(null)
  const swipeTriggered = useRef(false)
  const wrapRef = useRef(null)

  // ── Context menu state ─────────────────────────────────────────────────
  const [ctxMenu, setCtxMenu] = useState(null) // { x, y }

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
    // Swipe right = positive dx (for both me and them)
    // For "me" messages: swipe left (dx < -40)
    // For "them" messages: swipe right (dx > 40)
    const threshold = 40
    const triggered = isMe ? dx < -threshold : dx > threshold
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

  // Mouse drag for swipe simulation on desktop
  const mouseStartX = useRef(null)
  const mouseDown = useRef(false)

  const onMouseDown = useCallback((e) => {
    if (e.button !== 0) return
    mouseStartX.current = e.clientX
    mouseDown.current = true
    swipeTriggered.current = false
  }, [])

  const onMouseMove = useCallback((e) => {
    if (!mouseDown.current || mouseStartX.current === null) return
    const dx = e.clientX - mouseStartX.current
    const threshold = 50
    const triggered = isMe ? dx < -threshold : dx > threshold
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

  // Right-click context menu
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
      icon: "📋", label: "Salin", action: () => {
        const text = msg.body || getPreviewText()
        navigator.clipboard?.writeText(text)
      }
    },
    ...(hasQuoted && onScrollToMsg ? [{
      icon: "⬆", label: "Lihat pesan dikutip",
      action: () => onScrollToMsg(msg.quoted_id)
    }] : []),
  ]

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
      {!isReaction && (
        <button
          className="reply-btn"
          title="Balas"
          onMouseDown={(e) => { e.stopPropagation(); handleReply() }}
        >
          <ReplyIcon />
        </button>
      )}

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
        className={"msg-row" + (isMe ? " me" : " them") + (highlighted ? " highlighted" : "")}
        onContextMenu={onContextMenu}
        style={{ flex: 1, minWidth: 0 }}
      >
        {/* Sender name — group chats only, opponent only */}
        {!isMe && isGroup && msg.sender_name && (
          <div className="msg-sender-name">{msg.sender_name}</div>
        )}

        {/* Inner row: [avatar?] [bubble] */}
        <div className={"msg-inner" + (isMe ? " me" : "")}>

          {/* Group mini-avatar — opponent only */}
          {!isMe && isGroup && (
            <div className="msg-mini-avatar" style={{ background: "#1565c0", flexShrink: 0 }}>
              {senderInitial}
            </div>
          )}

          {/* Bubble wrapper */}
          <div className="bubble-wrap">
            <div className={bubbleClass}>

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
                  quotedFromMe={
                    // quoted_sender is null when resolveQuotedSender detected own JID
                    msg.quoted_sender === null && !!(msg.quoted_id || msg.quoted_body)
                  }
                />
              )}

              {/* Main message content */}
              {content}

              {/* Footer: timestamp + delivery ticks */}
              {!isReaction && !isSticker && (
                <div className={"bubble-footer" + (isMe ? " me" : "")}>
                  <BubbleTime ts={msg.timestamp} />
                  {isMe && <Ticks status={msg.status} />}
                </div>
              )}
            </div>

            {/* Emoji reactions overlay */}
            {msg.reactions && <ReactionOverlay reactions={msg.reactions} />}
          </div>
        </div>
      </div>
    </div>
  )
}