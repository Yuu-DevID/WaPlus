// src/components/MessageBubble.jsx — FIXED v5
// ═══════════════════════════════════════════════════════════════════════════
// FIXES v5:
// [F1] Album message layout — grid 2 cols seperti WhatsApp (gambar 1)
// [F6] Ganti emoji loading dgn animasi spinner/progress
// [F7] Ganti emoji dgn Heroicons SVG di seluruh komponen
// ═══════════════════════════════════════════════════════════════════════════

import { format } from "date-fns"
import { useState, useRef, useCallback, useEffect, useMemo, memo } from "react"
import { prefetchChat } from "../hooks/useMediaPrefetch"
import { useAppStore } from "../store/app"

// ════════════════════════════════════════════════════════════
// MODULE-LEVEL CONSTANTS
// ════════════════════════════════════════════════════════════
const NO_PAD_TYPES = new Set([
  "imageMessage", "videoMessage", "stickerMessage",
  "viewOnceMessage", "viewOnceMessageV2",
])
const SPEED_STEPS = [1, 1.5, 2]

// ────────────── HEROICONS SVG Components ──────────────────────────────────
const HiDocument = ({ size = 20 }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
  </svg>
)
const HiPhoto = ({ size = 20 }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />
  </svg>
)
const HiVideoCamera = ({ size = 20 }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" />
  </svg>
)
const HiMusicalNote = ({ size = 13 }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
  </svg>
)
const HiMicrophone = ({ size = 13 }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <line x1="12" y1="19" x2="12" y2="23" />
    <line x1="8" y1="23" x2="16" y2="23" />
  </svg>
)
const HiMapPin = ({ size = 20 }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
    <path d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0Z" />
  </svg>
)
const HiUser = ({ size = 20 }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" />
  </svg>
)
const HiUserGroup = ({ size = 20 }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0 1 12 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 0 1 6 18.719m12 0a5.971 5.971 0 0 0-.941-3.197m0 0A5.995 5.995 0 0 0 12 12.75a5.995 5.995 0 0 0-5.058 2.772m0 0a3 3 0 0 0-4.681 2.72 8.986 8.986 0 0 0 3.74.477m.94-3.197a5.971 5.971 0 0 0-.94 3.197M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-13.5 0a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z" />
  </svg>
)
const HiSpeakerWave = ({ size = 20 }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M19.114 5.636a9 9 0 0 1 0 12.728M16.463 8.288a5.25 5.25 0 0 1 0 7.424M6.75 8.25l4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z" />
  </svg>
)
const HiPhone = ({ size = 20 }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 0 0 2.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 0 1-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 0 0-1.091-.852H4.5A2.25 2.25 0 0 0 2.25 4.5v2.25Z" />
  </svg>
)
const HiVideoRecording = ({ size = 20 }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M12 18.75H4.5a2.25 2.25 0 0 1-2.25-2.25V9m12.841 9.091L16.5 19.5m-1.409-1.409c.407-.407.659-.97.659-1.591v-9a2.25 2.25 0 0 0-2.25-2.25h-9c-.621 0-1.184.252-1.591.659m12.182 12.182L2.909 5.909M1.5 4.5l1.409 1.409" />
  </svg>
)
const HiChartBar = ({ size = 20 }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z" />
  </svg>
)
const HiShoppingCart = ({ size = 20 }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2.25 3h1.386c.51 0 .955.343 1.087.835l.383 1.437M7.5 14.25a3 3 0 0 0-3 3h15.75m-12.75-3h11.218c1.121-2.3 2.1-4.684 2.924-7.138a60.114 60.114 0 0 0-16.536-1.84M7.5 14.25 5.106 5.272M6 20.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm12.75 0a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z" />
  </svg>
)
const HiCreditCard = ({ size = 20 }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 0 0 2.25-2.25V6.75A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25v10.5A2.25 2.25 0 0 0 4.5 19.5Z" />
  </svg>
)
const HiCalendar = ({ size = 20 }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5" />
  </svg>
)
const HiMegaphone = ({ size = 20 }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10.34 15.84c-.688-.06-1.386-.09-2.09-.09H7.5a4.5 4.5 0 1 1 0-9h.75c.704 0 1.402-.03 2.09-.09m0 9.18c.253.962.584 1.892.985 2.783.247.55.06 1.21-.463 1.511l-.657.38c-.551.318-1.26.117-1.527-.461a20.845 20.845 0 0 1-1.44-4.282m3.102.069a18.03 18.03 0 0 1-.59-4.59c0-1.586.205-3.124.59-4.59m0 9.18a23.848 23.848 0 0 1 8.835 2.535M10.34 6.66a23.847 23.847 0 0 1 8.835-2.535m0 0A23.74 23.74 0 0 1 18.795 3m.38 1.125a23.91 23.91 0 0 1 1.014 5.395m-1.014 8.855c-.118.38-.245.754-.38 1.125m.38-1.125a23.91 23.91 0 0 0 1.014-5.395m0-3.46c.495.413.811 1.035.811 1.73 0 .695-.316 1.317-.811 1.73m0-3.46a24.347 24.347 0 0 1 0 3.46" />
  </svg>
)
const HiArchiveBox = ({ size = 20 }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="m20.25 7.5-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m8.25 3v6.75m0 0-3-3m3 3 3-3M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" />
  </svg>
)
const HiShoppingBag = ({ size = 20 }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M15.75 10.5V6a3.75 3.75 0 1 0-7.5 0v4.5m11.356-1.993 1.263 12c.07.665-.45 1.243-1.119 1.243H4.25a1.125 1.125 0 0 1-1.12-1.243l1.264-12A1.125 1.125 0 0 1 5.513 7.5h12.974c.576 0 1.059.435 1.119 1.007ZM8.625 10.5a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm7.5 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />
  </svg>
)
const HiEye = ({ size = 20 }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
    <path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
  </svg>
)
const HiExclamationTriangle = ({ size = 14 }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
  </svg>
)
const HiArrowDownTray = ({ size = 20 }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
  </svg>
)
const HiPlayCircle = ({ size = 22 }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
    <path d="M15.91 11.672a.375.375 0 0 1 0 .656l-5.603 3.113a.375.375 0 0 1-.557-.328V8.887c0-.286.307-.466.557-.327l5.603 3.112Z" />
  </svg>
)
const HiForward = ({ size = 14 }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m15 15 6-6-6-6" />
    <path d="M9 18H7a6 6 0 0 1 0-12h8" />
  </svg>
)

// ─── DOC ICONS mapping to heroicons ──────────────────────────────────────────
function DocTypeIcon({ ext }) {
  const color = {
    PDF: "#ef4444", DOCX: "#3b82f6", DOC: "#3b82f6",
    XLSX: "#22c55e", XLS: "#22c55e",
    PPTX: "#f97316", PPT: "#f97316",
    ZIP: "#a78bfa", RAR: "#a78bfa",
    APK: "#06b6d4", MP4: "#ec4899",
    PNG: "#8b5cf6", JPG: "#8b5cf6", JPEG: "#8b5cf6", WEBP: "#8b5cf6",
    MP3: "#14b8a6", OGG: "#14b8a6", AAC: "#14b8a6",
  }[ext] || "#94a3b8"
  return (
    <div style={{
      width: 44, height: 44, borderRadius: 10,
      background: color + "22", border: `1.5px solid ${color}55`,
      display: "flex", alignItems: "center", justifyContent: "center",
      flexShrink: 0, color,
    }}>
      <HiDocument size={22} />
    </div>
  )
}

// ════════════════════════════════════════════════════════════
// RICH TEXT
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

const toBool = (v) => v === 1 || v === true

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
      segments.push(<a key={key++} href={href} onClick={e => { e.preventDefault(); e.stopPropagation(); window.api?.openExternal?.(href) ?? window.open(href, "_blank") }} title={href} className="bubble-link">{display}</a>)
    }
    lastIdx = m.index + token.length
  }
  if (lastIdx < text.length) segments.push(text.slice(lastIdx))
  if (!segments.length) return text
  if (segments.length === 1 && typeof segments[0] === "string") return segments[0]
  return segments
}

const RichText = memo(function RichText({ text, className, style }) {
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

// ════════════════════════════════════════════════════════════
// MEDIA PATH UTILITIES
// ════════════════════════════════════════════════════════════
function pathToFileUrl(rawPath) {
  if (!rawPath) return null
  if (rawPath.startsWith("file://")) {
    if (rawPath.includes("%3A") || rawPath.includes("%3a")) {
      try { const decoded = decodeURIComponent(rawPath.replace(/^file:\/\/\/?/, "")); return pathToFileUrl(decoded) } catch (_) { }
    }
    return rawPath
  }
  let p = rawPath.replace(/\\/g, "/")
  const winDrive = /^([A-Za-z]):\//
  if (winDrive.test(p)) {
    const encoded = p.replace(winDrive, (_, letter) => `/${letter.toUpperCase()}:/`).split("/").map((seg, i) => { if (i === 0) return seg; if (/^[A-Za-z]:$/.test(seg)) return seg; return encodeURIComponent(seg) }).join("/")
    return `file://${encoded}`
  }
  const withSlash = p.startsWith("/") ? p : `/${p}`
  const encoded = withSlash.split("/").map((seg, i) => (i === 0 ? seg : encodeURIComponent(seg))).join("/")
  return `file://${encoded}`
}

function useMediaSrc(msg) {
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
    window.api.fsExists({ rawPath }).then(exists => { if (!exists) { setVerifiedSrc(null); if (msg.chat_jid) prefetchChat(msg.chat_jid, 30, true) } }).catch(() => { })
  }, [rawPath])
  const src = verifiedSrc || msg.media_url || null
  return { src, err, setErr }
}

// ════════════════════════════════════════════════════════════
// SMALL HELPERS
// ════════════════════════════════════════════════════════════
function fmtPhone(raw) {
  if (!raw) return "?"
  const n = raw.includes("@") ? raw.split("@")[0] : raw
  if (!/^\d{6,}$/.test(n)) return raw
  return `+${n}`
}
function fmtTime(s) {
  if (!s || !isFinite(s)) return "0:00"
  const m = Math.floor(s / 60), sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, "0")}`
}

// ─── [F7] Heroicon Reply Icon ─────────────────────────────────────────────────
function ReplyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 17 4 12 9 7" />
      <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
    </svg>
  )
}
function PlayIcon() {
  return <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><polygon points="6,4 20,12 6,20" /></svg>
}
function PauseIcon() {
  return <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><rect x="5" y="4" width="4" height="16" rx="1" /><rect x="15" y="4" width="4" height="16" rx="1" /></svg>
}

// ─── Loading Spinner (mengganti emoji) ────────────────────────────────────────
function MediaLoadingSpinner({ label = "Mengunduh..." }) {
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

function MediaErrorPlaceholder({ label = "Gagal memuat konten media" }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, minHeight: 80, padding: 16 }}>
      <div style={{ color: "#ef4444", opacity: 0.8 }}><HiExclamationTriangle size={28} /></div>
      <span style={{ fontSize: 11, color: "var(--text-3)", textAlign: "center" }}>{label}</span>
    </div>
  )
}

// ─── Ticks ────────────────────────────────────────────────────────────────────
const Ticks = memo(function Ticks({ status }) {
  const s = Number(status)
  if (s === 0) return <span className="tick tick-pending" aria-label="Pending" style={{ fontSize: 10 }}>⏱</span>
  if (s === 1) return <span className="tick tick-sent" aria-label="Sent">✓</span>
  if (s === 2) return <span className="tick tick-delivered" aria-label="Delivered">✓✓</span>
  return <span className="tick tick-read" aria-label="Read">✓✓</span>
})
const BubbleTime = memo(function BubbleTime({ ts }) {
  if (!ts) return null
  return <span className="bubble-time">{format(new Date(ts * 1000), "HH:mm")}</span>
})

// ─── Quoted message ───────────────────────────────────────────────────────────
const QuotedMsg = memo(function QuotedMsg({ body, sender, type, hasMedia, mimetype, onClick, quotedFromMe }) {
  if (!sender && !body && !hasMedia && !quotedFromMe) return null
  const mediaIcon = (() => {
    if (!hasMedia) return null
    if (mimetype?.startsWith("image")) return <HiPhoto size={12} />
    if (mimetype?.startsWith("video")) return <HiVideoCamera size={12} />
    if (mimetype?.startsWith("audio")) return <HiMusicalNote size={12} />
    if (mimetype?.includes("pdf")) return <HiDocument size={12} />
    return <HiArchiveBox size={12} />
  })()
  let displaySender = sender === "__me__" || quotedFromMe ? "Kamu" : sender ? (sender.includes("@") ? fmtPhone(sender) : sender) : null
  return (
    <div className="quoted" onClick={onClick} role={onClick ? "button" : undefined} tabIndex={onClick ? 0 : undefined} style={onClick ? { cursor: "pointer" } : undefined}>
      {displaySender && <div className="quoted-sender">{displaySender}</div>}
      <div className="quoted-text" style={{ display: "flex", alignItems: "center", gap: 4 }}>
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
      <HiForward size={12} />
      <span>{score >= 5 ? "Sering diteruskan" : "Diteruskan"}</span>
    </div>
  )
}

// ════════════════════════════════════════════════════════════
// [F1] ALBUM BUBBLE — Grid 2-column layout like WhatsApp
// ════════════════════════════════════════════════════════════
function AlbumBubble({ msgs, onMediaClick, openMedia }) {
  const MAX_VISIBLE = 4
  const visible = msgs.slice(0, MAX_VISIBLE)
  const overflow = msgs.length - MAX_VISIBLE

  const pathToSrc = (raw) => {
    if (!raw) return null
    if (raw.startsWith("file://")) return raw
    let p = raw.replace(/\\/g, "/")
    if (/^[A-Za-z]:\//.test(p)) return `file://${p.split("/").map((s, i) => i === 0 ? s : encodeURIComponent(s)).join("/")}`
    const w = p.startsWith("/") ? p : `/${p}`
    return `file://${w.split("/").map((s, i) => i === 0 ? s : encodeURIComponent(s)).join("/")}`
  }

  // [FIX-6] If no media downloaded yet — show WhatsApp-style compact download badge
  const anyDownloaded = msgs.some(m => m.media_saved_path || m.media_url)
  if (!anyDownloaded) {
    const totalSize = msgs.reduce((s, m) => s + (m.media_filesize || 0), 0)
    const sizeLabel = totalSize > 0
      ? (totalSize > 1024 * 1024 ? `${(totalSize / 1024 / 1024).toFixed(1)} MB` : `${Math.round(totalSize / 1024)} kB`)
      : null
    return (
      <div style={{ position: "relative", width: "100%", minHeight: 160, background: "rgba(0,0,0,0.3)", borderRadius: 8, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 2, position: "absolute", inset: 0, opacity: 0.15, filter: "blur(3px)", pointerEvents: "none" }}>
          {visible.map((_, i) => <div key={i} style={{ background: "rgba(255,255,255,0.1)" }} />)}
        </div>
        <div style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
          <div style={{ width: 56, height: 56, borderRadius: "50%", background: "rgba(0,0,0,0.6)", border: "2px solid rgba(255,255,255,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <HiArrowDownTray size={24} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
            {sizeLabel && <span style={{ color: "#fff", fontSize: 13, fontWeight: 600 }}>{sizeLabel}</span>}
            <span style={{ color: "rgba(255,255,255,0.75)", fontSize: 12 }}>{msgs.length} foto</span>
          </div>
        </div>
      </div>
    )
  }

  const handleClick = (msg, idx) => {
    const items = msgs.map(m => ({
      src: pathToSrc(m.media_saved_path) || m.media_url,
      type: m.msg_type === "videoMessage" ? "video" : "image",
      caption: m.body || "",
      msgId: m.id,
      filename: m.media_filename,
    }))
    if (onMediaClick) {
      onMediaClick(msg, items[idx]?.src, items[idx]?.type)
    } else {
      openMedia(items, idx)
    }
  }

  return (
    <div className="album-grid" style={{
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: 2,
      borderRadius: 8,
      overflow: "hidden",
      position: "relative",
    }}>
      {visible.map((msg, idx) => {
        const src = pathToSrc(msg.media_saved_path) || msg.media_url
        const isVideo = msg.msg_type === "videoMessage"
        const isLast = idx === MAX_VISIBLE - 1 && overflow > 0
        return (
          <div key={msg.id || idx} style={{
            position: "relative", lineHeight: 0, cursor: "pointer", overflow: "hidden",
            ...(msgs.length === 3 && idx === 2 ? { gridColumn: "1 / -1" } : {})
          }} onClick={() => handleClick(msg, idx)}>
            {src ? (
              isVideo ? (
                <video src={src + "#t=0.5"} preload="metadata" muted draggable={false} style={{ width: "100%", height: 140, objectFit: "cover", display: "block", pointerEvents: "none" }} />
              ) : (
                <img src={src} alt="" draggable={false} style={{ width: "100%", height: 140, objectFit: "cover", display: "block", userSelect: "none" }} />
              )
            ) : (
              <div style={{ width: "100%", height: 140, background: "rgba(255,255,255,0.05)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <div style={{ width: 24, height: 24, border: "2px solid rgba(37,211,102,.4)", borderTopColor: "var(--green)", borderRadius: "50%", animation: "spin-progress 1s linear infinite" }} />
              </div>
            )}
            {isVideo && !isLast && (
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.3)" }}>
                <div style={{ width: 36, height: 36, borderRadius: "50%", background: "rgba(0,0,0,0.6)", border: "1.5px solid rgba(255,255,255,0.5)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="white"><polygon points="8,5 20,12 8,19" /></svg>
                </div>
              </div>
            )}
            {isLast && (
              <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 4 }}>
                <span style={{ color: "#fff", fontSize: 26, fontWeight: 700 }}>+{overflow + 1}</span>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── Image bubble ─────────────────────────────────────────────────────────────
function ImageBubble({ msg, onMediaClick }) {
  const { src, err, setErr } = useMediaSrc(msg)
  const { openMedia } = useAppStore()
  const [loaded, setLoaded] = useState(false)
  const handleClick = useCallback(() => {
    if (!src) return
    if (onMediaClick) onMediaClick(msg, src, "image")
    else openMedia([{ src, type: "image", caption: msg.body || "", msgId: msg.id, filename: msg.media_filename }], 0)
  }, [src, msg, onMediaClick, openMedia])

  if (!src || err) {
    return (
      <div style={{ lineHeight: 0, borderRadius: 8, overflow: "hidden", background: "rgba(255,255,255,0.06)", minHeight: 120 }}>
        {err ? <MediaErrorPlaceholder /> : <MediaLoadingSpinner />}
        {msg.body && <div className="media-caption" style={{ padding: "6px 10px 8px", fontSize: 13 }}><RichText text={msg.body} /></div>}
      </div>
    )
  }

  return (
    <>
      <div style={{ lineHeight: 0, borderRadius: msg.body ? "8px 8px 0 0" : 8, overflow: "hidden", position: "relative" }}>
        {!loaded && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(255,255,255,0.04)", minHeight: 80 }}>
            <div className="spinner spinner-sm" style={{ borderTopColor: "var(--green)", borderColor: "rgba(37,211,102,.2)" }} />
          </div>
        )}
        <img src={src} alt={msg.body || "Foto"} onLoad={() => setLoaded(true)} onError={() => setErr(true)} onClick={handleClick}
          draggable={false}
          style={{ display: "block", maxWidth: "100%", maxHeight: 320, width: "100%", objectFit: "cover", cursor: "zoom-in", opacity: loaded ? 1 : 0, transition: "opacity 0.2s", verticalAlign: "bottom", userSelect: "none" }} />
      </div>
      {msg.body && <div className="media-caption" style={{ padding: "6px 10px 8px", fontSize: 13 }}><RichText text={msg.body} /></div>}
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
    if (onMediaClick) onMediaClick(msg, src, "video")
    else openMedia([{ src, type: "video", caption: msg.body || "", msgId: msg.id, filename: msg.media_filename }], 0)
  }, [src, msg, isGif, onMediaClick, openMedia])

  if (!src || err) {
    return (
      <div className="media-video">
        <div className="media-video-thumb" style={{ cursor: "default", minHeight: 120, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8 }}>
          {err ? <MediaErrorPlaceholder label={isGif ? "Gagal memuat GIF" : "Gagal memuat video"} /> : <MediaLoadingSpinner label={isGif ? "Mengunduh GIF..." : "Mengunduh video..."} />}
        </div>
      </div>
    )
  }

  if (isGif) {
    return (
      <div className="media-img">
        <video src={src} autoPlay loop muted playsInline onError={() => setErr(true)} style={{ maxWidth: "100%", maxHeight: 280, borderRadius: 8, display: "block" }} />
        <div className="gif-badge">GIF</div>
        {msg.body && <div className="media-caption"><RichText text={msg.body} /></div>}
      </div>
    )
  }

  return (
    <div className="media-video" onClick={handleClick} style={{ cursor: "pointer", position: "relative", borderRadius: 8, overflow: "hidden" }} title="Klik untuk putar">
      <video src={src + "#t=0.5"} preload="metadata" muted onLoadedData={() => setThumbLoaded(true)} onError={() => setErr(true)} style={{ maxWidth: "100%", maxHeight: 280, display: "block", borderRadius: 8, width: "100%" }} />
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.25)", borderRadius: 8 }}
        onMouseEnter={e => e.currentTarget.style.background = "rgba(0,0,0,0.4)"}
        onMouseLeave={e => e.currentTarget.style.background = "rgba(0,0,0,0.25)"}>
        <div style={{ width: 52, height: 52, borderRadius: "50%", background: "rgba(0,0,0,0.6)", border: "2px solid rgba(255,255,255,0.4)", display: "flex", alignItems: "center", justifyContent: "center", backdropFilter: "blur(4px)" }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="white"><polygon points="8,5 20,12 8,19" /></svg>
        </div>
      </div>
      {msg.body && <div className="media-caption" onClick={e => e.stopPropagation()}><RichText text={msg.body} /></div>}
    </div>
  )
}

// ════════════════════════════════════════════════════════════
// AUDIO PLAYER
// ════════════════════════════════════════════════════════════
const _audioRegistry = { current: null }
const _waveformCache = new Map()

function seedWaveform(id, bars = 40) {
  if (_waveformCache.has(id)) return _waveformCache.get(id)
  const str = id || "x"
  let h = 0
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0
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
  const waveform = useMemo(() => seedWaveform(msgId), [msgId])
  const audioRef = useRef(null)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [duration, setDuration] = useState(msg.media_duration || msg.duration || 0)
  const [speedIdx, setSpeedIdx] = useState(0)
  const [loadState, setLoadState] = useState("idle")
  const scrubRef = useRef(null)
  const rafRef = useRef(null)
  const speed = SPEED_STEPS[speedIdx]

  useEffect(() => {
    if (!src) return
    const audio = new Audio()
    audio.preload = "metadata"
    audio.src = src
    audioRef.current = audio
    setLoadState("loading")
    const onMeta = () => { setDuration(audio.duration); setLoadState("ready") }
    const onError = () => setLoadState("error")
    const onEnded = () => { setPlaying(false); setProgress(0); setElapsed(0); audio.currentTime = 0; if (rafRef.current) cancelAnimationFrame(rafRef.current) }
    audio.addEventListener("loadedmetadata", onMeta)
    audio.addEventListener("error", onError)
    audio.addEventListener("ended", onEnded)
    const cleanup = () => { audio.pause(); audio.removeEventListener("loadedmetadata", onMeta); audio.removeEventListener("error", onError); audio.removeEventListener("ended", onEnded); audio.src = ""; if (rafRef.current) cancelAnimationFrame(rafRef.current) }
    audio._cleanupFn = cleanup
    return () => { if (_audioRegistry.current === audio) _audioRegistry.current = null; cleanup() }
  }, [src])
  useEffect(() => { if (audioRef.current) audioRef.current.playbackRate = speed }, [speed])

  const startRaf = useCallback(() => {
    const tick = () => { const a = audioRef.current; if (!a) return; setProgress(a.currentTime / (a.duration || 1)); setElapsed(a.currentTime); rafRef.current = requestAnimationFrame(tick) }
    rafRef.current = requestAnimationFrame(tick)
  }, [])
  const stopRaf = useCallback(() => { if (rafRef.current) cancelAnimationFrame(rafRef.current); rafRef.current = null }, [])

  const togglePlay = useCallback(() => {
    const audio = audioRef.current
    if (!audio || loadState === "error") return
    if (_audioRegistry.current && _audioRegistry.current !== audio) { _audioRegistry.current.pause(); _audioRegistry.current._setPlaying?.(false); _audioRegistry.current._stopRaf?.() }
    _audioRegistry.current = audio; audio._setPlaying = setPlaying; audio._stopRaf = stopRaf
    if (playing) { audio.pause(); stopRaf(); setPlaying(false) }
    else { audio.playbackRate = speed; audio.play().then(() => { setPlaying(true); startRaf() }).catch(() => setLoadState("error")) }
  }, [playing, loadState, speed, startRaf, stopRaf])

  const handleScrub = useCallback(e => {
    const audio = audioRef.current; if (!audio?.duration) return
    const bar = scrubRef.current; if (!bar) return
    const rect = bar.getBoundingClientRect()
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    audio.currentTime = frac * audio.duration; setProgress(frac); setElapsed(audio.currentTime)
  }, [])

  const cycleSpeed = useCallback(e => { e.stopPropagation(); setSpeedIdx(i => (i + 1) % SPEED_STEPS.length) }, [])
  const isLoading = !src || loadState === "loading" || loadState === "idle"
  const isError = loadState === "error"
  const displayDur = duration ? fmtTime(playing ? elapsed : duration) : fmtTime(elapsed || 0)

  return (
    <div className={`audio-player${playing ? " audio-playing" : ""}${isError ? " audio-error" : ""}`}>
      <button className="audio-btn-play" onClick={togglePlay} disabled={isError} aria-label={playing ? "Jeda" : "Putar"} title={isLoading ? "Mengunduh..." : isError ? "Gagal memuat audio" : playing ? "Jeda" : "Putar"}>
        {isLoading ? <div className="audio-spinner" /> : isError ? <HiExclamationTriangle size={14} /> : playing ? <PauseIcon /> : <PlayIcon />}
      </button>
      <div className="audio-track-area">
        <div ref={scrubRef} className="audio-waveform" onClick={handleScrub} role="slider" aria-label="Posisi audio" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
          {waveform.map((h, i) => {
            const barProgress = i / waveform.length
            const filled = barProgress <= progress
            const isActive = Math.abs(barProgress - progress) < 0.04
            return (
              <div key={i} className="audio-bar-seg" style={{
                height: `${Math.round(h * 100)}%`,
                background: filled ? (isActive ? "var(--green)" : "var(--green-dim)") : "rgba(255,255,255,0.12)",
                transform: isActive && playing ? "scaleY(1.3)" : "scaleY(1)",
              }} />
            )
          })}
        </div>
        <div className="audio-info-row">
          <span className="audio-type-badge">
            {isPtt ? <HiMicrophone size={13} /> : <HiMusicalNote size={13} />}
            <span>{isPtt ? "Pesan Suara" : "Audio"}</span>
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="audio-time">{displayDur}</span>
            {!isLoading && !isError && (
              <button className="audio-speed-btn" onClick={cycleSpeed} title="Ubah kecepatan" aria-label={`Kecepatan ${speed}x`}>{speed}×</button>
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
  const ext = msg.mimetype ? msg.mimetype.split("/")[1]?.split(";")[0]?.toUpperCase() : "FILE"
  return (
    <div className="media-doc">
      <DocTypeIcon ext={ext} />
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
  const [imgFailed, setImgFailed] = useState(false)
  const [videoFailed, setVideoFailed] = useState(false)
  const prevSrcRef = useRef(src)
  if (prevSrcRef.current !== src) { prevSrcRef.current = src; setImgFailed(false); setVideoFailed(false) }
  const stickerStyle = { width: 150, height: 150, objectFit: "contain", display: "block", borderRadius: 4 }

  if (!src) {
    return (
      <div style={{ width: 150, height: 150, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 6, background: "rgba(255,255,255,0.04)", borderRadius: 12 }}>
        <MediaLoadingSpinner label="Mengunduh stiker..." />
      </div>
    )
  }
  if (imgFailed && videoFailed) {
    return (
      <div style={{ width: 150, height: 150, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 6, background: "rgba(255,255,255,0.04)", borderRadius: 12 }}>
        <MediaErrorPlaceholder label="Gagal memuat stiker" />
      </div>
    )
  }
  if (imgFailed) return <video src={src} autoPlay loop muted playsInline onError={() => setVideoFailed(true)} style={stickerStyle} />
  return <img src={src} alt="Stiker" onError={() => setImgFailed(true)} style={stickerStyle} />
}

// ─── View once bubble ─────────────────────────────────────────────────────────
function ViewOnceBubble({ msg }) {
  const isVideo = msg.mimetype?.startsWith("video")
  return (
    <div className="viewonce-wrap">
      <div className="viewonce-eye" style={{ color: "var(--text-2)" }}><HiEye size={24} /></div>
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
        <div style={{ color: "var(--green)" }}><HiChartBar size={20} /></div>
        <div>
          <div className="poll-title">{msg.body || "Polling"}</div>
          <div className="poll-sub">Pilih salah satu opsi</div>
        </div>
      </div>
      {opts.length > 0 ? opts.map((o, i) => {
        const pct = total > 0 ? Math.round(((o.votes || 0) / total) * 100) : 0
        return (
          <div key={i} className="poll-option">
            <div className="poll-option-top"><span className="poll-option-name">{o.name || o}</span><span className="poll-option-pct">{pct}%</span></div>
            <div className="poll-bar"><div className="poll-bar-fill" style={{ width: `${pct}%` }} /></div>
          </div>
        )
      }) : <div className="poll-sub">Buka di HP untuk melihat opsi</div>}
      {total > 0 && <div className="poll-total">{total} suara</div>}
    </div>
  )
}

// ─── Location bubble ──────────────────────────────────────────────────────────
function LocationBubble({ msg }) {
  const lat = msg.location_lat, lng = msg.location_lng
  const name = msg.location_name || msg.location_address || msg.body || "Lokasi"
  const isLive = msg.msg_type === "liveLocationMessage"
  const mapsUrl = (lat && lng) ? `https://www.google.com/maps?q=${lat},${lng}` : null
  const handleClick = useCallback(() => { if (mapsUrl) window.open(mapsUrl, "_blank") }, [mapsUrl])
  return (
    <div className="media-location" onClick={handleClick} role={mapsUrl ? "link" : undefined} tabIndex={mapsUrl ? 0 : undefined} style={{ cursor: mapsUrl ? "pointer" : "default" }}>
      <div className="location-map">
        {lat && lng ? (
          <img src={`https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=15&size=200x100&markers=${lat},${lng}`} alt="Peta" style={{ width: "100%", height: 80, objectFit: "cover", borderRadius: 6 }} onError={e => { e.target.style.display = "none" }} />
        ) : (
          <div style={{ color: "var(--text-3)" }}><HiMapPin size={32} /></div>
        )}
      </div>
      <div className="location-label">
        {isLive && <span style={{ fontSize: 10, color: "var(--accent)" }}>● LIVE  </span>}
        {name}
      </div>
      {lat && lng && <div style={{ fontSize: 10, color: "var(--text-3)" }}>{lat.toFixed(5)}, {lng.toFixed(5)}</div>}
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
        <div className="contact-icon" style={{ color: "var(--text-2)" }}><HiUser size={24} /></div>
        <div><div className="contact-name">{msg.body || "Kontak"}</div><div className="contact-sub">Kontak WhatsApp</div></div>
      </div>
    )
  }
  return (
    <div className="contact-msg-list">
      {contacts.map((c, i) => (
        <div key={i} className="contact-msg">
          <div className="contact-icon" style={{ color: "var(--text-2)" }}><HiUser size={24} /></div>
          <div>
            <div className="contact-name">{c.displayName || "Kontak"}</div>
            <div className="contact-sub">{c.vcard?.match(/TEL[^:]*:([^\n]+)/)?.[1]?.trim() || "Kontak WhatsApp"}</div>
          </div>
        </div>
      ))}
      {isArray && contacts.length > 1 && <div className="contact-count">{contacts.length} kontak</div>}
    </div>
  )
}

// ─── Group invite bubble ──────────────────────────────────────────────────────
function GroupInviteBubble({ msg }) {
  return (
    <div className="invite-msg">
      <div className="invite-icon" style={{ color: "var(--green)" }}><HiUserGroup size={24} /></div>
      <div><div className="invite-title">Undangan Grup</div><div className="invite-sub">{msg.body || "Bergabung ke grup"}</div></div>
    </div>
  )
}

// ─── Interactive / Buttons bubbles ────────────────────────────────────────────
function ButtonsBubble({ msg }) {
  return (
    <div className="buttons-bubble">
      <div className="bubble-text">{msg.body || ""}</div>
      <div className="buttons-hint" style={{ display: "flex", alignItems: "center", gap: 5 }}>
        <HiSpeakerWave size={14} />Pesan dengan tombol — buka di HP
      </div>
    </div>
  )
}
function InteractiveResponseBubble({ msg }) {
  return <div className="bubble-text" style={{ fontStyle: "italic", color: "var(--text-2)" }}>↩ {msg.body || "Memilih opsi"}</div>
}

// ─── Commerce bubbles ─────────────────────────────────────────────────────────
function OrderBubble({ msg }) {
  return (
    <div className="media-doc">
      <div className="doc-icon" style={{ color: "var(--green)" }}><HiShoppingCart size={22} /></div>
      <div><div className="doc-name">{msg.body || "Pesanan"}</div><div className="doc-ext">Pesanan WhatsApp</div></div>
    </div>
  )
}
function PaymentBubble({ msg }) {
  return (
    <div className="media-doc">
      <div className="doc-icon" style={{ color: "var(--green)" }}><HiCreditCard size={22} /></div>
      <div><div className="doc-name">{msg.body || "Pembayaran"}</div><div className="doc-ext">WhatsApp Pay</div></div>
    </div>
  )
}
function CallLogBubble({ msg }) {
  const isVideo = msg.body?.includes("Video") || msg.mimetype?.includes("video")
  return (
    <div className="call-log">
      <span style={{ color: "var(--text-2)" }}>{isVideo ? <HiVideoRecording size={16} /> : <HiPhone size={16} />}</span>
      <span>{msg.body || (isVideo ? "Panggilan Video" : "Panggilan Suara")}</span>
    </div>
  )
}
function EventBubble({ msg }) {
  return (
    <div className="media-doc">
      <div className="doc-icon" style={{ color: "var(--text-2)" }}><HiCalendar size={22} /></div>
      <div><div className="doc-name">{msg.body || "Acara"}</div><div className="doc-ext">Acara WhatsApp</div></div>
    </div>
  )
}
function NewsletterBubble({ msg }) {
  return (
    <div className="invite-msg">
      <div className="invite-icon" style={{ color: "var(--green)" }}><HiMegaphone size={24} /></div>
      <div><div className="invite-title">Undangan Newsletter</div><div className="invite-sub">{msg.body || "Bergabung ke channel"}</div></div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════
// MAIN CONTENT RENDERER
// ════════════════════════════════════════════════════════════
function renderContent(msg, opts = {}) {
  const t = msg.msg_type || "conversation"
  if (toBool(msg.is_view_once) || t === "viewOnceMessage" || t === "viewOnceMessageV2") return <ViewOnceBubble msg={msg} />
  // [F1] Album rendered by parent
  if (msg._isAlbumPart) return null

  switch (t) {
    case "conversation":
    case "extendedTextMessage":
      return <div className="bubble-text"><RichText text={msg.body || ""} /></div>
    case "imageMessage": return <ImageBubble msg={msg} onMediaClick={opts?.onMediaClick} />
    case "videoMessage": return <VideoBubble msg={msg} onMediaClick={opts?.onMediaClick} />
    case "audioMessage":
    case "pttMessage": return <AudioBubble msg={msg} />
    case "documentMessage": return <DocBubble msg={msg} />
    case "stickerMessage": return <StickerBubble msg={msg} />
    case "locationMessage":
    case "liveLocationMessage": return <LocationBubble msg={msg} />
    case "contactMessage":
    case "contactsArrayMessage": return <ContactBubble msg={msg} />
    case "pollCreationMessage": return <PollBubble msg={msg} />
    case "pollUpdateMessage": return <div className="bubble-text" style={{ fontStyle: "italic", color: "var(--text-2)", display: "flex", alignItems: "center", gap: 5 }}><HiChartBar size={14} /> Vote diperbarui</div>
    case "reactionMessage": return null
    case "groupInviteMessage": return <GroupInviteBubble msg={msg} />
    case "buttonsMessage":
    case "listMessage":
    case "templateMessage":
    case "interactiveMessage": return <ButtonsBubble msg={msg} />
    case "buttonsResponseMessage":
    case "listResponseMessage":
    case "templateButtonReplyMessage":
    case "interactiveResponseMessage": return <InteractiveResponseBubble msg={msg} />
    case "orderMessage": return <OrderBubble msg={msg} />
    case "productMessage": return (
      <div className="media-doc">
        <div className="doc-icon" style={{ color: "var(--text-2)" }}><HiShoppingBag size={22} /></div>
        <div><div className="doc-name">{msg.body || "Produk"}</div><div className="doc-ext">Produk WhatsApp</div></div>
      </div>
    )
    case "paymentMessage":
    case "requestPaymentMessage":
    case "sendPaymentMessage": return <PaymentBubble msg={msg} />
    case "callLogMessage": return <CallLogBubble msg={msg} />
    case "eventMessage": return <EventBubble msg={msg} />
    case "newsletterAdminInviteMessage": return <NewsletterBubble msg={msg} />
    case "protocol":
    case "ephemeral":
    case "messageContextInfo":
    case "unknown": return null
    default: {
      if (msg.body) return <div className="bubble-text"><RichText text={msg.body} /></div>
      return <div className="bubble-unsupported" style={{ display: "flex", alignItems: "center", gap: 5, color: "var(--text-3)", fontSize: 12 }}><HiArchiveBox size={14} />{t}</div>
    }
  }
}

// ════════════════════════════════════════════════════════════
// CONTEXT MENU
// ════════════════════════════════════════════════════════════
function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null)
  useEffect(() => {
    const close = e => { if (ref.current && !ref.current.contains(e.target)) onClose() }
    document.addEventListener("mousedown", close)
    document.addEventListener("contextmenu", close)
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("contextmenu", close) }
  }, [onClose])
  const style = { left: Math.min(x, window.innerWidth - 180), top: Math.min(y, window.innerHeight - items.length * 38 - 20) }
  return (
    <div ref={ref} className="ctx-menu" role="menu" style={{ position: "fixed", ...style }}>
      {items.map((item, i) =>
        item === "divider" ? (
          <div key={i} className="ctx-menu-divider" role="separator" />
        ) : (
          <div key={i} className={`ctx-menu-item${item.danger ? " danger" : ""}`} role="menuitem" tabIndex={0}
            onMouseDown={e => { e.stopPropagation(); item.action(); onClose() }}
            onKeyDown={e => { if (e.key === "Enter") { item.action(); onClose() } }}>
            {item.icon && <span style={{ fontSize: 15, display: "flex", alignItems: "center" }} aria-hidden="true">{item.icon}</span>}
            {item.label}
          </div>
        )
      )}
    </div>
  )
}

// ════════════════════════════════════════════════════════════
// ALBUM BUBBLE WRAPPER — groups consecutive image/video msgs
// ════════════════════════════════════════════════════════════
// This component wraps AlbumBubble + footer time/ticks for albums
function AlbumBubbleWrapper({ msgs, isMe, isGroup, onMediaClick, openMedia, onReply }) {
  const first = msgs[0]
  const isForwarded = toBool(first.is_forwarded)
  const [highlighted, setHighlighted] = useState(false)
  const [swiping, setSwiping] = useState(false)
  const wrapRef = useRef(null)
  const swipeStartX = useRef(null)
  const swipeTriggered = useRef(false)
  const mouseStartX = useRef(null)
  const mouseDown = useRef(false)

  useEffect(() => {
    if (!wrapRef.current) return
    const el = wrapRef.current
    const handler = () => { setHighlighted(true); setTimeout(() => setHighlighted(false), 1800) }
    el.addEventListener("msg-highlight", handler)
    return () => el.removeEventListener("msg-highlight", handler)
  }, [])

  const handleReply = useCallback(() => { if (onReply) onReply(first) }, [first, onReply])
  const onTouchStart = useCallback(e => { swipeStartX.current = e.touches[0].clientX; swipeTriggered.current = false }, [])
  const onTouchMove = useCallback(e => {
    if (swipeStartX.current === null) return
    const dx = e.touches[0].clientX - swipeStartX.current
    if ((isMe ? dx < -40 : dx > 40) && !swipeTriggered.current) { swipeTriggered.current = true; setSwiping(true); handleReply(); setTimeout(() => setSwiping(false), 400) }
  }, [isMe, handleReply])
  const onTouchEnd = useCallback(() => { swipeStartX.current = null }, [])
  const onMouseDown = useCallback(e => { if (e.button !== 0) return; mouseStartX.current = e.clientX; mouseDown.current = true; swipeTriggered.current = false }, [])
  const onMouseMove = useCallback(e => {
    if (!mouseDown.current || mouseStartX.current === null) return
    const dx = e.clientX - mouseStartX.current
    if ((isMe ? dx < -50 : dx > 50) && !swipeTriggered.current) { swipeTriggered.current = true; setSwiping(true); handleReply(); setTimeout(() => setSwiping(false), 400) }
  }, [isMe, handleReply])
  const onMouseUp = useCallback(() => { mouseDown.current = false; mouseStartX.current = null }, [])

  const senderInitial = (first.sender_name || first.sender_jid || "?")[0].toUpperCase()
  const caption = msgs.map(m => m.body).filter(Boolean).join(" · ")
  return (
    <div ref={wrapRef} className={`msg-row-wrap ${isMe ? "me" : "them"}${swiping ? " swiping" : ""}`}
      style={{ position: "relative", display: "flex", alignItems: "center" }}
      onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
      onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp} onMouseLeave={onMouseUp}>

      <button className="reply-btn" title="Balas" aria-label="Balas pesan" onMouseDown={e => { e.stopPropagation(); handleReply() }}>
        <ReplyIcon />
      </button>

      <div className={`msg-row${isMe ? " me" : " them"}${highlighted ? " highlighted" : ""}`} style={{ flex: 1, minWidth: 0 }}>
        {!isMe && isGroup && first.sender_name && <div className="msg-sender-name">{first.sender_name}</div>}
        <div className={`msg-inner${isMe ? " me" : ""}`}>
          {!isMe && isGroup && (
            <div className="msg-mini-avatar" aria-hidden="true" style={{ background: "#1565c0", flexShrink: 0 }}>
              {senderInitial}
            </div>
          )}
          <div className="bubble-wrap" style={{ position: "relative" }}>
            <div className={`bubble no-pad${isMe ? " me" : ""}${highlighted ? " highlighted" : ""}`} style={{ position: "relative", padding: 0, overflow: "hidden" }}>
              {isForwarded && <div style={{ padding: "4px 10px 0" }}><ForwardBadge score={first.forwarding_score} /></div>}
              <AlbumBubble msgs={msgs} onMediaClick={onMediaClick} openMedia={openMedia} />
              {caption && <div className="media-caption" style={{ padding: "4px 10px 6px", fontSize: 13 }}><RichText text={caption} /></div>}
              <div style={{ position: "absolute", bottom: 6, right: 8, background: "rgba(0,0,0,0.55)", backdropFilter: "blur(4px)", borderRadius: 8, padding: "1px 6px", display: "flex", alignItems: "center", gap: 3, pointerEvents: "none" }}>
                <BubbleTime ts={first.timestamp} />
                {isMe && <Ticks status={first.status} />}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════
// MAIN COMPONENT — exported + also exports AlbumBubbleWrapper
// ════════════════════════════════════════════════════════════
export { AlbumBubbleWrapper }

export default function MessageBubble({ msg, onReply, onScrollToMsg, onMediaClick }) {
  const isMe = toBool(msg.from_me)
  const isGroup = toBool(msg.is_group)
  const isForwarded = toBool(msg.is_forwarded)
  const t = msg.msg_type || "conversation"
  const isReaction = t === "reactionMessage"
  const isSticker = t === "stickerMessage"
  const hasNoPad = NO_PAD_TYPES.has(t)
  const hasQuoted = !!(msg.quoted_id || msg.quoted_body || msg.quoted_sender)

  // [FIX-7] For group messages, prefer phone number from JID over sender_name
  const senderDisplay = (() => {
    if (!isGroup) return msg.sender_name
    const jidRaw = msg.sender_jid || ""
    const user = jidRaw.includes("@") ? jidRaw.split("@")[0].split(":")[0] : ""
    if (/^\d{6,}$/.test(user)) return `+${user}`
    return msg.sender_name || user || "?"
  })()
  const senderInitial = (senderDisplay || msg.sender_jid || "?")[0].toUpperCase()
  const [highlighted, setHighlighted] = useState(false)
  const [swiping, setSwiping] = useState(false)
  const [ctxMenu, setCtxMenu] = useState(null)
  const swipeStartX = useRef(null)
  const swipeTriggered = useRef(false)
  const wrapRef = useRef(null)
  const mouseStartX = useRef(null)
  const mouseDown = useRef(false)

  const handleReply = useCallback(() => { if (onReply) onReply(msg) }, [msg, onReply])
  const onTouchStart = useCallback(e => { swipeStartX.current = e.touches[0].clientX; swipeTriggered.current = false }, [])
  const onTouchMove = useCallback(e => {
    if (swipeStartX.current === null) return
    const dx = e.touches[0].clientX - swipeStartX.current
    if ((isMe ? dx < -40 : dx > 40) && !swipeTriggered.current) { swipeTriggered.current = true; setSwiping(true); handleReply(); setTimeout(() => setSwiping(false), 400) }
  }, [isMe, handleReply])
  const onTouchEnd = useCallback(() => { swipeStartX.current = null }, [])
  const onMouseDown = useCallback(e => { if (e.button !== 0) return; mouseStartX.current = e.clientX; mouseDown.current = true; swipeTriggered.current = false }, [])
  const onMouseMove = useCallback(e => {
    if (!mouseDown.current || mouseStartX.current === null) return
    const dx = e.clientX - mouseStartX.current
    if ((isMe ? dx < -50 : dx > 50) && !swipeTriggered.current) { swipeTriggered.current = true; setSwiping(true); handleReply(); setTimeout(() => setSwiping(false), 400) }
  }, [isMe, handleReply])
  const onMouseUp = useCallback(() => { mouseDown.current = false; mouseStartX.current = null }, [])
  const onContextMenu = useCallback(e => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY }) }, [])

  useEffect(() => {
    if (!wrapRef.current) return
    const el = wrapRef.current
    const handler = () => { setHighlighted(true); setTimeout(() => setHighlighted(false), 1800) }
    el.addEventListener("msg-highlight", handler)
    return () => el.removeEventListener("msg-highlight", handler)
  }, [])

  const bubbleClass = ["bubble", isMe ? "me" : null, (isReaction || isSticker) ? "sticker" : null, hasNoPad ? "no-pad" : null].filter(Boolean).join(" ")
  const content = renderContent(msg, { onMediaClick })
  if (content === null) return null

  const getPreviewText = () => {
    if (t === "imageMessage") return "Foto"
    if (t === "videoMessage") return "Video"
    if (t === "audioMessage" || t === "pttMessage") return "Audio"
    if (t === "stickerMessage") return "Stiker"
    if (t === "documentMessage") return msg.media_filename || "Dokumen"
    return msg.body || "Pesan"
  }

  const ctxItems = [
    { icon: <ReplyIcon />, label: "Balas", action: handleReply },
    "divider",
    { icon: "📋", label: "Salin", action: () => navigator.clipboard?.writeText(msg.body || getPreviewText()) },
    ...(hasQuoted && onScrollToMsg ? [{ icon: "⬆", label: "Lihat pesan dikutip", action: () => onScrollToMsg(msg.quoted_id) }] : []),
  ]

  // Reaction float display
  if (isReaction) {
    const emoji = msg.body || msg.reaction_emoji || "❤️"
    return (
      <div ref={wrapRef} style={{ display: "flex", justifyContent: isMe ? "flex-end" : "flex-start", padding: "1px 14px", userSelect: "none" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: isMe ? "flex-end" : "flex-start", gap: 2 }}>
          {!isMe && isGroup && msg.sender_name && <div style={{ fontSize: 11, color: "var(--text-3)", paddingLeft: 2 }}>{msg.sender_name}</div>}
          <div title={`Reaksi • ${msg.sender_name || (isMe ? "Kamu" : "Mereka")}`}
            style={{ fontSize: 28, lineHeight: 1, cursor: "default", filter: "drop-shadow(0 1px 3px rgba(0,0,0,0.4))", transition: "transform 0.12s" }}
            onMouseEnter={e => { e.currentTarget.style.transform = "scale(1.18)" }}
            onMouseLeave={e => { e.currentTarget.style.transform = "scale(1)" }}>
            {emoji}
          </div>
          <div style={{ fontSize: 10, color: "var(--text-3)", lineHeight: 1 }}>
            {msg.timestamp ? new Date(msg.timestamp * 1000).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" }) : ""}
            {isMe && <span style={{ marginLeft: 3, opacity: 0.7 }}>{Number(msg.status) >= 3 ? "✓✓" : "✓"}</span>}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div ref={wrapRef} className={`msg-row-wrap ${isMe ? "me" : "them"}${swiping ? " swiping" : ""}`}
      style={{ position: "relative", display: "flex", alignItems: "center" }}
      onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
      onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp} onMouseLeave={onMouseUp}>

      <button className="reply-btn" title="Balas" aria-label="Balas pesan" onMouseDown={e => { e.stopPropagation(); handleReply() }}>
        <ReplyIcon />
      </button>

      {ctxMenu && <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={ctxItems} onClose={() => setCtxMenu(null)} />}

      <div className={`msg-row${isMe ? " me" : " them"}${highlighted ? " highlighted" : ""}`} onContextMenu={onContextMenu} style={{ flex: 1, minWidth: 0 }}>
        {!isMe && isGroup && senderDisplay && <div className="msg-sender-name">{senderDisplay}</div>}
        <div className={`msg-inner${isMe ? " me" : ""}`}>
          {!isMe && isGroup && (
            <div className="msg-mini-avatar" aria-hidden="true" style={{ background: "#1565c0", flexShrink: 0 }}>
              {senderInitial}
            </div>
          )}
          <div className="bubble-wrap" style={{ position: "relative" }}>
            <div className={bubbleClass} style={{ position: "relative" }}>
              {isForwarded && <ForwardBadge score={msg.forwarding_score} />}
              {hasQuoted && (
                <QuotedMsg body={msg.quoted_body} sender={msg.quoted_sender} type={msg.quoted_type} hasMedia={toBool(msg.quoted_has_media)} mimetype={msg.quoted_mimetype}
                  onClick={() => onScrollToMsg && msg.quoted_id && onScrollToMsg(msg.quoted_id)}
                  quotedFromMe={msg.quoted_sender === "__me__"} />
              )}
              {content}
              {!isReaction && !isSticker && (() => {
                const isImgVideo = t === "imageMessage" || t === "videoMessage"
                if (isImgVideo && !msg.body) {
                  return (
                    <div style={{ position: "absolute", bottom: 6, right: 8, background: "rgba(0,0,0,0.55)", backdropFilter: "blur(4px)", borderRadius: 8, padding: "1px 6px", display: "flex", alignItems: "center", gap: 3, pointerEvents: "none" }}>
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
            {msg.reactions && <ReactionOverlay reactions={msg.reactions} />}
          </div>
        </div>
      </div>
    </div>
  )
}
