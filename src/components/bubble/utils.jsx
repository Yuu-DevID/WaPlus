// src/components/bubble/utils.jsx
// ═══════════════════════════════════════════════════════════════════════════
// Shared utilities, hooks, dan helper components untuk semua bubble types.
// ═══════════════════════════════════════════════════════════════════════════

import { useState, useEffect, useRef, memo, useMemo } from "react"
import { format } from "date-fns"
import { prefetchChat } from "../../hooks/useMediaPrefetch"
import { useAppStore } from "../../store/app"
import { HiArrowDownTray, HiExclamationTriangle, HiPhoto, HiVideoCamera, HiMusicalNote, HiDocument, HiArchiveBox, HiForward } from "./icons"

// ════════════════════════════════════════════════════════════
// GLOBAL MEDIA DOWNLOAD LOADING STATE
// Tracks which msgIds are currently being downloaded.
// Updated via IPC events: media:download:start / media:download:error / media:updated
// ════════════════════════════════════════════════════════════
export const _dlLoading = new Set()
const _dlListeners = new Set()

function notifyDlListeners() {
  for (const fn of _dlListeners) fn()
}

if (typeof window !== "undefined") {
  window.api?.onMediaDownloadStart?.((e) => {
    if (e?.msgId) { _dlLoading.add(e.msgId); notifyDlListeners() }
  })
  window.api?.onMediaDownloadError?.((e) => {
    if (e?.msgId) { _dlLoading.delete(e.msgId); notifyDlListeners() }
  })
  window.api?.onMediaUpdated?.((e) => {
    if (e?.msgId) { _dlLoading.delete(e.msgId); notifyDlListeners() }
  })
}

export function useIsDownloading(msgId) {
  const [dl, setDl] = useState(() => _dlLoading.has(msgId))
  useEffect(() => {
    const fn = () => setDl(_dlLoading.has(msgId))
    _dlListeners.add(fn)
    return () => _dlListeners.delete(fn)
  }, [msgId])
  return dl
}

// ════════════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════════════
export const NO_PAD_TYPES = new Set([
  "imageMessage", "videoMessage", "stickerMessage",
  "viewOnceMessage", "viewOnceMessageV2",
])
export const SPEED_STEPS = [1, 1.5, 2]

// ════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ════════════════════════════════════════════════════════════
export const toBool = (v) => v === 1 || v === true

/**
 * fmtPhone — convert JID ke human-readable phone/name.
 * TIDAK pernah return raw @lid, JID format, atau numeric LID ID ke UI.
 */
export function fmtPhone(raw) {
  if (!raw) return "?"
  if (raw === "__me__" || raw === "__self__") return "Kamu"
  const atIdx = raw.lastIndexOf("@")
  if (atIdx === -1) return /^\d{6,}$/.test(raw) ? `+${raw}` : raw
  const user   = raw.slice(0, atIdx).split(":")[0]
  const server = raw.slice(atIdx + 1)
  if (server === "g.us" || server === "newsletter") return ""
  if (server === "lid") {
    const numericPart = user.replace(/\D/g, "")
    if (numericPart.length > 12) return `~${numericPart.slice(-6)}`
    if (numericPart.length >= 6) return `~${numericPart.slice(-6)}`
    return `~${user.slice(0, 10)}`
  }
  if (/^\d{6,}$/.test(user)) return `+${user}`
  return user || "?"
}

export function fmtTime(s) {
  if (!s || !isFinite(s)) return "0:00"
  const m = Math.floor(s / 60), sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, "0")}`
}

// ════════════════════════════════════════════════════════════
// MEDIA PATH → file:// URL CONVERTER
// ════════════════════════════════════════════════════════════
export function pathToFileUrl(rawPath) {
  if (!rawPath) return null
  if (rawPath.startsWith("file://")) {
    if (rawPath.includes("%3A") || rawPath.includes("%3a")) {
      try {
        const decoded = decodeURIComponent(rawPath.replace(/^file:\/\/\/?/, ""))
        return pathToFileUrl(decoded)
      } catch (_) {}
    }
    return rawPath
  }
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
  const withSlash = p.startsWith("/") ? p : `/${p}`
  const encoded = withSlash
    .split("/")
    .map((seg, i) => (i === 0 ? seg : encodeURIComponent(seg)))
    .join("/")
  return `file://${encoded}`
}

export function useMediaSrc(msg) {
  const rawPath = msg.media_saved_path || null
  const [verifiedSrc, setVerifiedSrc] = useState(() => rawPath ? pathToFileUrl(rawPath) : null)
  const [err, setErr] = useState(false)
  const prevRaw = useRef(rawPath)
  const checked = useRef(false)

  if (prevRaw.current !== rawPath) {
    prevRaw.current = rawPath
    const newSrc = rawPath ? pathToFileUrl(rawPath) : null
    setVerifiedSrc(newSrc)
    if (err) setErr(false)
    checked.current = false
  }

  useEffect(() => {
    if (!rawPath || checked.current) return
    if (!window.api?.fsExists) return
    checked.current = true
    window.api.fsExists({ rawPath })
      .then(exists => {
        if (!exists) {
          // [FIX-MISSING-FILE] File path in DB but file is gone (moved, deleted, external drive).
          // 1. Clear src so bubble switches to download-trigger mode (shows thumbnail + spinner)
          // 2. Trigger a re-download via mediaTriggerDownload so file comes back automatically
          setVerifiedSrc(null)
          const msgId = msg?.id
          if (msgId && window.api?.mediaTriggerDownload) {
            window.api.mediaTriggerDownload({ msgId }).catch(() => {})
          } else if (msg?.chat_jid) {
            // Fallback: re-prefetch the chat if no direct trigger available
            prefetchChat(msg.chat_jid, 30, true)
          }
        }
      })
      .catch(() => {})
  }, [rawPath])

  const src = verifiedSrc || msg.media_url || null
  const thumbnailSrc = msg.media_thumbnail_b64 || null
  return { src, thumbnailSrc, err, setErr }
}

// ════════════════════════════════════════════════════════════
// SHARED UI ATOMS
// ════════════════════════════════════════════════════════════

/** Loading spinner inside media area */
export function MediaLoadingSpinner({ label = "Mengunduh..." }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, minHeight: 80, padding: 16 }}>
      <div style={{ position: "relative", width: 40, height: 40 }}>
        <svg viewBox="0 0 40 40" width="40" height="40" style={{ transform: "rotate(-90deg)" }}>
          <circle cx="20" cy="20" r="16" fill="none" stroke="rgba(37,211,102,0.15)" strokeWidth="3.5" />
          <circle cx="20" cy="20" r="16" fill="none" stroke="var(--green)" strokeWidth="3.5" strokeLinecap="round"
            strokeDasharray="100.5" strokeDashoffset="25"
            style={{ animation: "spin-progress 1.2s linear infinite" }}
          />
        </svg>
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <HiArrowDownTray size={14} />
        </div>
      </div>
      <span style={{ fontSize: 11, color: "var(--text-3)" }}>{label}</span>
    </div>
  )
}

/** Active download indicator with animated ring */
export function DownloadingPulse({ label = "Mengunduh..." }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
      <div style={{ position: "relative", width: 44, height: 44 }}>
        <div style={{ position: "absolute", inset: 0, borderRadius: "50%", border: "2px solid var(--green)", animation: "dl-pulse-ring 1.4s ease-out infinite", opacity: 0.6 }} />
        <div style={{ position: "absolute", inset: 4, borderRadius: "50%", background: "rgba(37,211,102,0.18)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--green)" strokeWidth="2.5" strokeLinecap="round">
            <path d="M12 3v12M7 14l5 5 5-5" style={{ animation: "dl-arrow-bounce 1s ease infinite" }} />
            <path d="M5 19h14" />
          </svg>
        </div>
        <svg viewBox="0 0 44 44" width="44" height="44" style={{ position: "absolute", inset: 0, animation: "spin 1.5s linear infinite" }}>
          <circle cx="22" cy="22" r="20" fill="none" stroke="var(--green)" strokeWidth="2" strokeLinecap="round" strokeDasharray="31 95" />
        </svg>
      </div>
      <span style={{ fontSize: 10, color: "var(--green)", fontWeight: 500, letterSpacing: 0.3 }}>{label}</span>
      <style>{`
        @keyframes dl-pulse-ring { 0%{transform:scale(1);opacity:.6} 80%,100%{transform:scale(1.4);opacity:0} }
        @keyframes dl-arrow-bounce { 0%,100%{transform:translateY(0)} 50%{transform:translateY(3px)} }
      `}</style>
    </div>
  )
}

export function MediaErrorPlaceholder({ label = "Gagal memuat konten media" }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, minHeight: 80, padding: 16 }}>
      <div style={{ color: "#ef4444", opacity: 0.8 }}><HiExclamationTriangle size={28} /></div>
      <span style={{ fontSize: 11, color: "var(--text-3)", textAlign: "center" }}>{label}</span>
    </div>
  )
}

/** Message status ticks */
export const Ticks = memo(function Ticks({ status }) {
  const s = Number(status)
  if (s === 0) return <span className="tick tick-pending" aria-label="Pending" style={{ fontSize: 10 }}>⏱</span>
  if (s === 1) return <span className="tick tick-sent" aria-label="Sent">✓</span>
  if (s === 2) return <span className="tick tick-delivered" aria-label="Delivered">✓✓</span>
  return <span className="tick tick-read" aria-label="Read">✓✓</span>
})

export const BubbleTime = memo(function BubbleTime({ ts }) {
  if (!ts) return null
  return <span className="bubble-time">{format(new Date(ts * 1000), "HH:mm")}</span>
})

/** Forwarded message badge */
export function ForwardBadge({ score }) {
  if (!score) return null
  return (
    <div className="forward-badge">
      <HiForward size={12} />
      <span>{score >= 5 ? "Sering diteruskan" : "Diteruskan"}</span>
    </div>
  )
}

/** Reaction overlay grouped by emoji */
export const ReactionOverlay = memo(function ReactionOverlay({ reactions }) {
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

/** Quoted/replied-to message preview */
export const QuotedMsg = memo(function QuotedMsg({ body, sender, senderName, type, hasMedia, mimetype, onClick, quotedFromMe }) {
  if (!sender && !senderName && !body && !hasMedia && !quotedFromMe) return null

  const mediaIcon = (() => {
    if (!hasMedia) return null
    if (mimetype?.startsWith("image")) return <HiPhoto size={12} />
    if (mimetype?.startsWith("video")) return <HiVideoCamera size={12} />
    if (mimetype?.startsWith("audio")) return <HiMusicalNote size={12} />
    if (mimetype?.includes("pdf"))    return <HiDocument size={12} />
    return <HiArchiveBox size={12} />
  })()

  let displaySender = null
  if (sender === "__me__" || sender === "__self__" || quotedFromMe) {
    displaySender = "Kamu"
  } else if (senderName && !senderName.includes("@")) {
    displaySender = senderName
  } else if (sender) {
    if (!sender.includes("@")) {
      displaySender = /^\d{6,}$/.test(sender) ? `+${sender}` : sender
    } else {
      displaySender = fmtPhone(sender)
    }
    if (displaySender?.includes("@")) {
      const u = displaySender.split("@")[0].split(":")[0]
      displaySender = /^\d{6,}$/.test(u) ? `+${u}` : u || null
    }
  }

  return (
    <div className="quoted" onClick={onClick} role={onClick ? "button" : undefined} tabIndex={onClick ? 0 : undefined} style={onClick ? { cursor: "pointer" } : undefined}>
      {displaySender && <div className="quoted-sender">{displaySender}</div>}
      <div className="quoted-text" style={{ display: "flex", alignItems: "center", gap: 4 }}>
        {mediaIcon}{body || (hasMedia ? "Pesan media" : "Pesan")}
      </div>
    </div>
  )
})

// ════════════════════════════════════════════════════════════
// RICH TEXT RENDERER
// ════════════════════════════════════════════════════════════
const RICH_RE = new RegExp(
  "(" +
  "```[\\s\\S]+?```" +
  "|" +
  "`[^`\\n]+`" +
  "|" +
  "\\*[^*\\n]+\\*" +
  "|" +
  "_[^_\\n]+_" +
  "|" +
  "~[^~\\n]+~" +
  ")" +
  "|" +
  "(" +
  "https?:\\/\\/[^\\s<>\"')\\]]+|www\\.[^\\s<>\"')\\]]+\\.[^\\s<>\"')\\]]+" +
  ")",
  "gi"
)

function linkifyText(text) {
  if (!text) return null
  const segments = []
  let key = 0, lastIdx = 0
  RICH_RE.lastIndex = 0
  let m
  while ((m = RICH_RE.exec(text)) !== null) {
    if (m.index > lastIdx) segments.push(text.slice(lastIdx, m.index))
    const token = m[0]
    if (m[1]) {
      if (token.startsWith("```")) segments.push(<code key={key++} className="bubble-code-block">{token.slice(3, -3)}</code>)
      else if (token.startsWith("`")) segments.push(<code key={key++} className="bubble-code-inline">{token.slice(1, -1)}</code>)
      else if (token.startsWith("*")) segments.push(<strong key={key++}>{token.slice(1, -1)}</strong>)
      else if (token.startsWith("_")) segments.push(<em key={key++}>{token.slice(1, -1)}</em>)
      else if (token.startsWith("~")) segments.push(<s key={key++}>{token.slice(1, -1)}</s>)
    } else if (m[2]) {
      let href = token
      if (!href.startsWith("http")) href = "https://" + href
      href = href.replace(/[.,;:!?)\]]+$/, "")
      const display = href.replace(/^https?:\/\//, "").replace(/\/$/, "")
      segments.push(
        <a key={key++} href={href}
          onClick={e => { e.preventDefault(); e.stopPropagation(); window.api?.openExternal?.(href) ?? window.open(href, "_blank") }}
          title={href} className="bubble-link">
          {display}
        </a>
      )
    }
    lastIdx = m.index + token.length
  }
  if (lastIdx < text.length) segments.push(text.slice(lastIdx))
  if (!segments.length) return text
  if (segments.length === 1 && typeof segments[0] === "string") return segments[0]
  return segments
}

export const RichText = memo(function RichText({ text, className, style }) {
  if (!text) return null
  const lines = text.split("\n")
  return (
    <span className={className} style={style}>
      {lines.map((line, i) => (
        <span key={i}>{linkifyText(line)}{i < lines.length - 1 && <br />}</span>
      ))}
    </span>
  )
})