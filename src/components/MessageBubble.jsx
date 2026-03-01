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
import DevEvalModal from "./DevEvalModal"

// ════════════════════════════════════════════════════════════
// GLOBAL MEDIA DOWNLOAD LOADING STATE
// Tracks which msgIds are currently being downloaded
// Updated via IPC events: media:download:start / media:download:error / media:updated
// ════════════════════════════════════════════════════════════
const _dlLoading = new Set()
const _dlListeners = new Set()

function notifyDlListeners() {
  for (const fn of _dlListeners) fn()
}

// Bootstrap IPC listeners once
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

function useIsDownloading(msgId) {
  const [dl, setDl] = useState(() => _dlLoading.has(msgId))
  useEffect(() => {
    const fn = () => setDl(_dlLoading.has(msgId))
    _dlListeners.add(fn)
    return () => _dlListeners.delete(fn)
  }, [msgId])
  return dl
}

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
  // [INSTANT-THUMB] Embedded base64 thumbnail — renders immediately without download
  const thumbnailSrc = msg.media_thumbnail_b64 || null
  return { src, thumbnailSrc, err, setErr }
}

// ════════════════════════════════════════════════════════════
// SMALL HELPERS
// ════════════════════════════════════════════════════════════

/**
 * fmtPhone — convert any JID or raw string to human-readable phone/name.
 * NEVER returns @lid suffix, raw JID format, or LID numeric IDs to the UI.
 *
 * Priority:
 *   1. @s.whatsapp.net / @c.us → "+number"
 *   2. @lid → try to detect LID numeric (not a real phone) → show "~lid" hint
 *   3. Group JID → "" (shouldn't appear as sender)
 *   4. Plain string without @ → return as-is if name, or +number if digits
 *
 * Note: LID numeric IDs are typically 15-digit numbers starting with high values
 *       (like 108491511492861) — these are NOT real phone numbers.
 *       Real phone numbers are 7-15 digits, with country code starting 1-9.
 */
function fmtPhone(raw) {
  if (!raw) return "?"
  if (raw === "__me__") return "Kamu"
  if (raw === "__self__") return "Kamu"

  const atIdx = raw.lastIndexOf("@")
  if (atIdx === -1) {
    // No @, treat as phone/name directly
    return /^\d{6,}$/.test(raw) ? `+${raw}` : raw
  }

  const user   = raw.slice(0, atIdx).split(":")[0]  // strip device suffix
  const server = raw.slice(atIdx + 1)

  // Group JIDs should never appear as sender display
  if (server === "g.us" || server === "newsletter") return ""

  // @lid server — this is a privacy-masked ID, NOT a phone number
  // Even if user part is numeric, show a masked form to avoid confusion
  if (server === "lid") {
    const numericPart = user.replace(/\D/g, "")
    // LID numbers are very long (>12 digits) and NOT real phone numbers
    // Show last 6 digits with tilde prefix so devs know it's unresolved
    if (numericPart.length > 12) return `~${numericPart.slice(-6)}`
    if (numericPart.length >= 6) return `~${numericPart.slice(-6)}`
    return `~${user.slice(0, 10)}`
  }

  // Numeric user → real phone number
  if (/^\d{6,}$/.test(user)) return `+${user}`

  // Fallback: just return user part (no @)
  return user || "?"
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

// DownloadingPulse — active download indicator with animated download arrow
function DownloadingPulse({ label = "Mengunduh..." }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
      <div style={{ position: "relative", width: 44, height: 44 }}>
        {/* Outer pulsing ring */}
        <div style={{
          position: "absolute", inset: 0, borderRadius: "50%",
          border: "2px solid var(--green)",
          animation: "dl-pulse-ring 1.4s ease-out infinite",
          opacity: 0.6,
        }} />
        {/* Inner circle */}
        <div style={{
          position: "absolute", inset: 4, borderRadius: "50%",
          background: "rgba(37,211,102,0.18)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--green)" strokeWidth="2.5" strokeLinecap="round">
            <path d="M12 3v12M7 14l5 5 5-5" style={{ animation: "dl-arrow-bounce 1s ease infinite" }} />
            <path d="M5 19h14" />
          </svg>
        </div>
        {/* Spinning arc */}
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
const QuotedMsg = memo(function QuotedMsg({ body, sender, senderName, type, hasMedia, mimetype, onClick, quotedFromMe }) {
  if (!sender && !senderName && !body && !hasMedia && !quotedFromMe) return null
  const mediaIcon = (() => {
    if (!hasMedia) return null
    if (mimetype?.startsWith("image")) return <HiPhoto size={12} />
    if (mimetype?.startsWith("video")) return <HiVideoCamera size={12} />
    if (mimetype?.startsWith("audio")) return <HiMusicalNote size={12} />
    if (mimetype?.includes("pdf")) return <HiDocument size={12} />
    return <HiArchiveBox size={12} />
  })()

  // [FIX-LID] Display name resolution — NEVER show raw @lid or JID
  // Priority: 1) explicit senderName from DB contacts  2) fmtPhone(sender JID)  3) "Kamu"
  let displaySender = null
  if (sender === "__me__" || sender === "__self__" || quotedFromMe) {
    displaySender = "Kamu"
  } else if (senderName && !senderName.includes("@")) {
    // DB-resolved contact name — most reliable, use directly
    displaySender = senderName
  } else if (sender) {
    if (!sender.includes("@")) {
      displaySender = /^\d{6,}$/.test(sender) ? `+${sender}` : sender
    } else {
      displaySender = fmtPhone(sender)
    }
    // Final safety: strip any remaining @ (should never happen after fmtPhone)
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
  const { src, thumbnailSrc, err, setErr } = useMediaSrc(msg)
  const { openMedia } = useAppStore()
  const [loaded, setLoaded] = useState(false)
  const isDownloading = useIsDownloading(msg.id)
  const handleClick = useCallback(() => {
    if (!src) return
    if (onMediaClick) onMediaClick(msg, src, "image")
    else openMedia([{ src, type: "image", caption: msg.body || "", msgId: msg.id, filename: msg.media_filename }], 0)
  }, [src, msg, onMediaClick, openMedia])

  // No full src yet — show thumbnail (instant) or loading spinner
  if (!src || err) {
    return (
      <div style={{ lineHeight: 0, borderRadius: 8, overflow: "hidden", background: "rgba(255,255,255,0.06)", minHeight: 120 }}>
        {err ? <MediaErrorPlaceholder /> : thumbnailSrc ? (
          // [INSTANT-THUMB] data: URI renders immediately, blurred as placeholder
          <div style={{ position: "relative", minHeight: 120 }}>
            <img src={thumbnailSrc} alt="" draggable={false}
              style={{ display: "block", maxWidth: "100%", maxHeight: 320, width: "100%", objectFit: "cover", filter: "blur(8px)", transform: "scale(1.05)", userSelect: "none" }} />
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
              {isDownloading
                ? <DownloadingPulse />
                : <div className="spinner spinner-sm" style={{ borderTopColor: "var(--green)", borderColor: "rgba(37,211,102,.2)" }} />}
            </div>
          </div>
        ) : (
          <div style={{ minHeight: 120, display: "flex", alignItems: "center", justifyContent: "center" }}>
            {isDownloading ? <DownloadingPulse /> : <MediaLoadingSpinner />}
          </div>
        )}
        {msg.body && <div className="media-caption" style={{ padding: "6px 10px 8px", fontSize: 13 }}><RichText text={msg.body} /></div>}
      </div>
    )
  }

  return (
    <>
      <div style={{ lineHeight: 0, borderRadius: msg.body ? "8px 8px 0 0" : 8, overflow: "hidden", position: "relative" }}>
        {!loaded && thumbnailSrc && (
          // Show blurred thumbnail while full image loads
          <img src={thumbnailSrc} alt="" draggable={false} aria-hidden
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", filter: "blur(8px)", transform: "scale(1.05)", userSelect: "none", pointerEvents: "none" }} />
        )}
        {!loaded && !thumbnailSrc && (
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
  const { src, thumbnailSrc, err, setErr } = useMediaSrc(msg)
  const { openMedia } = useAppStore()
  const isGif = toBool(msg.is_gif)
  const isDownloading = useIsDownloading(msg.id)
  const [thumbLoaded, setThumbLoaded] = useState(false)
  const handleClick = useCallback(() => {
    if (!src || isGif) return
    if (onMediaClick) onMediaClick(msg, src, "video")
    else openMedia([{ src, type: "video", caption: msg.body || "", msgId: msg.id, filename: msg.media_filename }], 0)
  }, [src, msg, isGif, onMediaClick, openMedia])

  if (!src || err) {
    return (
      <div className="media-video">
        <div className="media-video-thumb" style={{ cursor: "default", minHeight: 120, position: "relative", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, overflow: "hidden", borderRadius: 8 }}>
          {thumbnailSrc && !err && (
            // [INSTANT-THUMB] Show blurred video thumbnail immediately
            <img src={thumbnailSrc} alt="" draggable={false} aria-hidden
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", filter: "blur(10px)", transform: "scale(1.08)", userSelect: "none", pointerEvents: "none" }} />
          )}
          <div style={{ position: "relative", zIndex: 1 }}>
            {err ? <MediaErrorPlaceholder label={isGif ? "Gagal memuat GIF" : "Gagal memuat video"} />
              : isDownloading ? <DownloadingPulse label={isGif ? "Mengunduh GIF..." : "Mengunduh video..."} />
              : <MediaLoadingSpinner label={isGif ? "Mengunduh GIF..." : "Mengunduh video..."} />}
          </div>
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
  const { src, thumbnailSrc, err, setErr } = useMediaSrc(msg)
  const [imgFailed, setImgFailed] = useState(false)
  const [videoFailed, setVideoFailed] = useState(false)
  const isDownloading = useIsDownloading(msg.id)
  const prevSrcRef = useRef(src)
  if (prevSrcRef.current !== src) { prevSrcRef.current = src; setImgFailed(false); setVideoFailed(false) }
  const stickerStyle = { width: 150, height: 150, objectFit: "contain", display: "block", borderRadius: 4 }

  if (!src && !thumbnailSrc) {
    return (
      <div style={{ width: 150, height: 150, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 6, background: "rgba(255,255,255,0.04)", borderRadius: 12 }}>
        {isDownloading ? <DownloadingPulse label="Mengunduh stiker..." /> : <MediaLoadingSpinner label="Mengunduh stiker..." />}
      </div>
    )
  }
  // [INSTANT-THUMB] If sticker has embedded webp/jpeg thumbnail, render it directly
  // as a blurred placeholder. Animated webp stickers often have a thumbnail too.
  if (!src && thumbnailSrc) {
    const isThumbWebp = thumbnailSrc.includes('image/webp')
    // Render thumbnail directly — for webp try <video> loop for animation fallback
    if (isThumbWebp) {
      return <img src={thumbnailSrc} alt="Stiker" style={{ ...stickerStyle, filter: "blur(2px)" }} />
    }
    return <img src={thumbnailSrc} alt="Stiker" style={{ ...stickerStyle, filter: "blur(2px)" }} />
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
// ════════════════════════════════════════════════════════════
// RAW MESSAGE VIEWER MODAL
// ════════════════════════════════════════════════════════════
// RAW MESSAGE VIEWER — Shows PURE Baileys proto object
// ════════════════════════════════════════════════════════════
// Reconstruct format persis seperti output smsg() di bot WA:
//   { key, messageTimestamp, pushName, message, mtype, msg,
//     body, text, isCmd, cmd, args, quoted, mentionedJid,
//     chatId, fromMe, isGroup, senderId, participant, ... }
//
// Source: fetch db:messages:raw → message_json (stored Baileys proto)
//         + SQLite row fields (key, pushName, timestamp, etc.)
// ════════════════════════════════════════════════════════════

// ── smsg-style reconstructor ────────────────────────────────
// Input: SQLite row (all columns) + parsed message_json (Baileys proto)
// Output: object matching the sample JSON files exactly
function buildSmsgStyle(row, msgJson) {
  if (!row) return null

  const msgType  = row.message_type || "conversation"
  const isGroup  = !!(row.remote_jid || "").endsWith("@g.us")
  const fromMe   = row.from_me === 1
  const chatJid  = row.remote_jid || ""
  const sender   = isGroup
    ? (row.participant || row.sender_jid || "")
    : (fromMe ? row.remote_jid : row.remote_jid)

  // Re-extract body from the Baileys message proto (like smsg does)
  let body = row.body || ""
  let msgContent = msgJson || {}

  // If message_json is the full Baileys proto (has nested message content),
  // extract the inner message content object for the "msg" field
  let innerMsg = msgContent
  if (msgContent[msgType]) {
    innerMsg = msgContent[msgType]
  } else {
    // Try to find the inner content key
    const keys = Object.keys(msgContent).filter(k =>
      k !== "messageContextInfo" && k !== "senderKeyDistributionMessage"
    )
    if (keys.length > 0) innerMsg = msgContent[keys[0]]
  }

  // Parse text/body from inner message
  const msgBody = body ||
    innerMsg?.text ||
    innerMsg?.caption ||
    innerMsg?.conversation ||
    ""

  // Reconstruct "key" object (Baileys WAMessageKey)
  const key = {
    remoteJid: chatJid,
    fromMe: !!fromMe,
    id: row.id,
    ...(isGroup && row.participant ? { participant: row.participant } : {}),
  }

  // Build args like smsg() does: split body by space, first = cmd
  const bodyTrim = msgBody.trim()
  const isCmd = false  // we don't know prefix here — keep false like bot does when not matched
  const parts = bodyTrim.split(/\s+/)
  const cmd = parts[0] || ""
  const args = parts.slice(1)

  // ── Reconstruct quoted message info ────────────────────────
  let quoted = null
  if (row.context_stanza_id) {
    const quotedMsg = row.context_quoted_message || null
    let quotedParsed = null
    try { quotedParsed = typeof quotedMsg === "string" ? JSON.parse(quotedMsg) : quotedMsg } catch {}
    quoted = {
      key: {
        remoteJid: chatJid,
        fromMe: row.context_participant
          ? (row.context_participant === row.remote_jid)
          : false,
        id: row.context_stanza_id,
        ...(isGroup && row.context_participant ? { participant: row.context_participant } : {}),
      },
      message: quotedParsed,
    }
  }

  // ── mentioned JIDs ──────────────────────────────────────────
  let mentionedJid = []
  try {
    const raw = row.context_mentioned_jids || row.mentioned_jids || "[]"
    mentionedJid = typeof raw === "string" ? JSON.parse(raw) : (Array.isArray(raw) ? raw : [])
  } catch {}

  // ── Final smsg-style object ─────────────────────────────────
  // Field order matches the sample JSON files (output__1_.json etc.)
  return {
    key,
    messageTimestamp: row.message_timestamp || 0,
    pushName: row.push_name || null,
    broadcast: !!(row.broadcast),
    message: msgJson || null,       // ← FULL Baileys WAMessage proto, unmodified

    // ── smsg enrichment fields ──────────────────────────────
    id: row.id,
    isBaileys: !!(row.id && row.id.startsWith("BAE5") && row.id.length === 16),
    chatId: chatJid,
    chatLid: "",
    fromMe: !!fromMe,
    from: chatJid,
    isBroadcast: !!(row.broadcast),
    isStatusBroadcast: chatJid === "status@broadcast",
    isNewsletter: chatJid.endsWith("@newsletter"),
    isGroup,
    isUser: !isGroup && !chatJid.endsWith("@newsletter"),
    senderId: sender,
    participant: row.participant || null,
    mtype: msgType,
    msg: innerMsg,                  // ← inner message content (like smsg m.msg)
    quoted,
    body: msgBody,
    mentionedJid,
    text: msgBody,
    isCmd,
    cmd,
    args,

    // ── Status ──────────────────────────────────────────────
    status: row.status,
    starred: !!(row.starred),
    is_history_sync: !!(row.is_history_sync),
  }
}

// ── JSON syntax colorizer (token-based, no deps) ────────────
// Applied to the <pre> via dangerouslySetInnerHTML so we get nice coloring
function colorizeJson(text) {
  if (!text || text.length > 80000) return escHtml(text)

  // Escape HTML first, then apply color spans
  const escaped = escHtml(text)

  return escaped
    // JSON string values → green
    .replace(/(: )(&quot;)((?:[^&]|&(?!quot;))*?)(&quot;)/g,
      '$1<span class="rv-s">$2$3$4</span>')
    // JSON keys → blue
    .replace(/^(\s*)(&quot;)([\w$\- .@]+)(&quot;)(\s*:)/gm,
      '$1<span class="rv-k">$2$3$4</span>$5')
    // Numbers → orange
    .replace(/(:\s*)(-?\d+\.?\d*(?:e[+-]?\d+)?)/g,
      '$1<span class="rv-n">$2</span>')
    // Booleans + null → purple
    .replace(/(:\s*)(true|false|null)/g,
      '$1<span class="rv-b">$2</span>')
}
function escHtml(s) {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

// ── Tab selector ─────────────────────────────────────────────
const RV_TABS = [
  { id: "smsg",  label: "smsg()",  icon: "⚡", title: "Format smsg() seperti output bot — key, message, mtype, msg, body, dll." },
  { id: "raw",   label: "Baileys", icon: "🔧", title: "Raw Baileys WAMessage proto — isi message_json dari DB" },
  { id: "store", label: "Store",   icon: "📦", title: "Object WaPlus store — hasil parsing & normalisasi untuk UI" },
]

function RawViewerModal({ msg, onClose }) {
  const [tab,    setTab]    = useState("smsg")
  const [fetched, setFetched] = useState(null)   // { row, msgJson } or null
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)
  const [copied,  setCopied]  = useState(false)
  const preRef = useRef(null)

  // ── Fetch full raw data from DB on mount ──────────────────
  useEffect(() => {
    let cancelled = false
    async function fetchRaw() {
      try {
        if (!window.api?.dbMessageRaw) {
          // Fallback if IPC not available
          setFetched({ row: null, msgJson: null })
          setLoading(false)
          return
        }
        const res = await window.api.dbMessageRaw({ id: msg.id })
        if (cancelled) return
        if (!res?.ok) {
          setError(res?.error || "Message tidak ditemukan di DB")
          setLoading(false)
          return
        }
        const row = res.data
        // Parse message_json → full Baileys WAMessage proto
        let msgJson = null
        try {
          const raw = row._message_json_parsed || row.message_json
          msgJson = typeof raw === "string" ? JSON.parse(raw) : raw
        } catch {}
        setFetched({ row, msgJson })
      } catch (e) {
        if (!cancelled) setError(e.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    fetchRaw()
    return () => { cancelled = true }
  }, [msg.id])

  // ── Close on Escape ───────────────────────────────────────
  useEffect(() => {
    const fn = e => { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", fn)
    return () => document.removeEventListener("keydown", fn)
  }, [onClose])

  // ── Build display object based on active tab ──────────────
  const displayObj = useMemo(() => {
    if (tab === "smsg") {
      if (!fetched) return null
      return buildSmsgStyle(fetched.row, fetched.msgJson)
    }
    if (tab === "raw") {
      return fetched?.msgJson || null
    }
    // tab === "store" — WaPlus parsed/normalized object
    const storeObj = { ...msg }
    // Parse any JSON string fields
    for (const k of ["mentioned_jids","poll_options","contacts_json","call_participants"]) {
      try { if (typeof storeObj[k] === "string") storeObj[k] = JSON.parse(storeObj[k]) } catch {}
    }
    // Truncate huge thumbnails
    if (storeObj.media_thumbnail_b64?.length > 200) {
      storeObj.media_thumbnail_b64 = storeObj.media_thumbnail_b64.slice(0, 80)
        + `… [${storeObj.media_thumbnail_b64.length} chars total]`
    }
    return storeObj
  }, [tab, fetched, msg])

  const rawText = useMemo(() => {
    if (!displayObj) return loading ? "Loading…" : (error ? `Error: ${error}` : "null")
    try { return JSON.stringify(displayObj, null, 2) }
    catch (e) {
      // Handle circular refs
      const seen = new WeakSet()
      return JSON.stringify(displayObj, (k, v) => {
        if (typeof v === "object" && v !== null) {
          if (seen.has(v)) return "[Circular]"
          seen.add(v)
        }
        return v
      }, 2)
    }
  }, [displayObj, loading, error])

  const handleCopy = () => {
    navigator.clipboard?.writeText(rawText).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 2000)
    })
  }

  const handleSave = () => {
    const blob = new Blob([rawText], { type: "application/json" })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement("a")
    a.href     = url
    a.download = `msg-${tab}-${msg.id?.slice(0, 12) || "raw"}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const tabMeta = RV_TABS.find(t => t.id === tab)
  const lineCount = rawText.split("\n").length

  return (
    <div
      className="rawviewer-backdrop"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
      role="dialog" aria-modal="true" aria-label="Raw Message"
    >
      <div className="rawviewer-modal">

        {/* ── Header ───────────────────────────────────────── */}
        <div className="rawviewer-header">
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: "rgba(37,211,102,0.12)", border: "1px solid rgba(37,211,102,0.3)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--green)", flexShrink: 0 }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
              </svg>
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-1)", lineHeight: 1 }}>Raw Message</div>
              <div style={{ fontSize: 10.5, color: "var(--text-3)", marginTop: 3, fontFamily: "monospace",
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 380 }}>
                {msg.id || "?"} · {msg.msg_type || "?"} · {msg.chat_jid || "?"}
              </div>
            </div>
          </div>
          <button className="rawviewer-close" onClick={onClose} aria-label="Close">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* ── Tab bar ──────────────────────────────────────── */}
        <div className="rv-tabs" role="tablist">
          {RV_TABS.map(t => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`rv-tab${tab === t.id ? " active" : ""}`}
              onClick={() => { setTab(t.id); setCopied(false) }}
              title={t.title}
            >
              <span className="rv-tab-icon">{t.icon}</span>
              {t.label}
              {tab === t.id && t.id !== "store" && loading && (
                <span className="rv-tab-spinner" />
              )}
            </button>
          ))}
          {/* Status tag */}
          {!loading && tab !== "store" && (
            <span className={`rv-status-tag${!displayObj ? " err" : ""}`}>
              {!displayObj ? (error ? "not found" : "empty") : "ok"}
            </span>
          )}
        </div>

        {/* ── Toolbar ──────────────────────────────────────── */}
        <div className="rawviewer-toolbar">
          <div style={{ fontSize: 11, color: "var(--text-3)", fontFamily: "monospace", display: "flex", alignItems: "center", gap: 8 }}>
            {loading ? (
              <><span className="spinner spinner-sm" style={{ borderTopColor: "var(--green)", borderColor: "rgba(37,211,102,.2)" }} /> Fetching…</>
            ) : (
              <>{lineCount} lines · {rawText.length.toLocaleString()} chars · <span style={{ color: "var(--text-2)" }}>{tabMeta?.title}</span></>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className={`rawviewer-btn${copied ? " success" : ""}`}
              onClick={handleCopy}
              disabled={loading || !displayObj}
              title="Copy JSON ke clipboard"
            >
              {copied ? (
                <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg> Copied!</>
              ) : (
                <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy</>
              )}
            </button>
            <button
              className="rawviewer-btn"
              onClick={handleSave}
              disabled={loading || !displayObj}
              title="Simpan sebagai file .json"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
              Save .json
            </button>
          </div>
        </div>

        {/* ── Code area ────────────────────────────────────── */}
        <div className="rawviewer-code-wrap">
          {loading ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center",
              height: 200, gap: 10, color: "var(--text-3)", fontSize: 13 }}>
              <span className="spinner" style={{ borderTopColor: "var(--green)", borderColor: "rgba(37,211,102,.2)" }} />
              Memuat data dari database…
            </div>
          ) : error && !displayObj ? (
            <div style={{ padding: "24px 28px" }}>
              <div style={{ fontSize: 12, color: "#ef5350", fontFamily: "monospace",
                background: "rgba(239,83,80,0.08)", border: "1px solid rgba(239,83,80,0.2)",
                borderRadius: 8, padding: "12px 16px" }}>
                ⚠ {error}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 10 }}>
                message_json mungkin tidak disimpan untuk tipe ini, atau pesan belum ada di DB.
              </div>
            </div>
          ) : (
            <pre
              ref={preRef}
              className="rawviewer-code rv-code-colored"
              dangerouslySetInnerHTML={{ __html: colorizeJson(rawText) }}
            />
          )}
        </div>

      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════
// CONTEXT MENU — WhatsApp-style with icons + Raw View
// ════════════════════════════════════════════════════════════
function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null)
  useEffect(() => {
    const close = e => {
      if (ref.current && !ref.current.contains(e.target)) onClose()
    }
    // Close on outside mousedown, right-click, or Escape
    const onKey = e => { if (e.key === "Escape") onClose() }
    document.addEventListener("mousedown", close, true)
    document.addEventListener("contextmenu", close, true)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", close, true)
      document.removeEventListener("contextmenu", close, true)
      document.removeEventListener("keydown", onKey)
    }
  }, [onClose])

  // Smart positioning — flip direction if near viewport edge
  useEffect(() => {
    if (!ref.current) return
    const el = ref.current
    const rect = el.getBoundingClientRect()
    const vw = window.innerWidth, vh = window.innerHeight
    if (rect.right > vw - 8)  el.style.left = `${x - rect.width}px`
    if (rect.bottom > vh - 8) el.style.top  = `${y - rect.height}px`
  })

  return (
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      aria-label="Opsi pesan"
      style={{ left: x, top: y }}
      onContextMenu={e => e.preventDefault()}
    >
      {items.map((item, i) => {
        if (item === "divider") return <div key={i} className="ctx-menu-divider" role="separator" />
        const cls = [
          "ctx-menu-item",
          item.danger ? "danger" : "",
          item.raw    ? "raw"    : "",
          item.muted  ? "muted"  : "",
        ].filter(Boolean).join(" ")
        return (
          <div
            key={i}
            className={cls}
            role="menuitem"
            tabIndex={0}
            onMouseDown={e => { e.preventDefault(); e.stopPropagation(); item.action(); onClose() }}
            onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { item.action(); onClose() } }}
          >
            <span className="ctx-item-icon" aria-hidden="true">{item.icon}</span>
            <span className="ctx-item-label">{item.label}</span>
            {item.badge && <span className="ctx-item-badge">{item.badge}</span>}
            {item.hint  && <span className="ctx-item-hint">{item.hint}</span>}
          </div>
        )
      })}
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

  // ── [FIX-LID] Same resolution logic as MessageBubble senderDisplay ──
  const albumSenderDisplay = (() => {
    if (!isGroup) return null
    if (first.sender_name && !first.sender_name.includes("@")) return first.sender_name
    const jidRaw = first.sender_jid || ""
    const isLid  = jidRaw.endsWith("@lid")
    const user   = jidRaw.includes("@") ? jidRaw.split("@")[0].split(":")[0] : jidRaw
    if (/^\d{6,}$/.test(user)) return `+${user}`
    if (isLid) {
      const num = user.replace(/\D/g, "")
      return `~${num.length > 6 ? num.slice(-6) : num}`
    }
    if (first.sender_name?.includes("@")) {
      const u = first.sender_name.split("@")[0].split(":")[0]
      if (/^\d{6,}$/.test(u)) return `+${u}`
    }
    return first.sender_name || user || null
  })()
  const senderInitial = (albumSenderDisplay || "?")[0].toUpperCase()
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
        {!isMe && isGroup && albumSenderDisplay && <div className="msg-sender-name">{albumSenderDisplay}</div>}
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

  // ── [FIX-LID] Resolve group sender display name
  // Priority: saved name → push_name → phone from JID → partial fallback
  // NEVER show raw @lid JID or weird numeric IDs in UI
  const senderDisplay = (() => {
    if (!isGroup) return msg.sender_name || null

    // 1. Best case: we have a real contact name or pushname
    if (msg.sender_name && !msg.sender_name.includes("@")) {
      return msg.sender_name
    }

    // 2. Derive from sender_jid — at this point jid should already be resolved
    //    by DB query (clid join) to @s.whatsapp.net if it was @lid
    const jidRaw = msg.sender_jid || ""
    const isLid  = jidRaw.endsWith("@lid")
    const user   = jidRaw.includes("@")
      ? jidRaw.split("@")[0].split(":")[0]
      : jidRaw

    // Pure phone number (unsaved contact) → show as +phone
    if (/^\d{6,}$/.test(user)) return `+${user}`

    // Still a raw @lid (shouldn't happen after DB fix, but safety fallback)
    if (isLid) {
      const numericPart = user.replace(/\D/g, "")
      if (numericPart.length >= 6) return `+${numericPart}`
      return msg.sender_name || `~${user.slice(0, 10)}`
    }

    // sender_name with @ is a leaked JID — try to extract phone
    if (msg.sender_name?.includes("@")) {
      const u = msg.sender_name.split("@")[0].split(":")[0]
      if (/^\d{6,}$/.test(u)) return `+${u}`
    }

    return msg.sender_name || user || "?"
  })()
  const senderInitial = (senderDisplay || msg.sender_jid || "?")[0].toUpperCase()
  const [highlighted, setHighlighted] = useState(false)
  const [swiping, setSwiping] = useState(false)
  const [ctxMenu, setCtxMenu] = useState(null)
  const [rawViewer,  setRawViewer]  = useState(false)
  const [devEvalOpen, setDevEvalOpen] = useState(false)
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

  // ── WhatsApp-style context menu — matches screenshot exactly ──────────────
  // Icons: SVG Heroicons/Lucide matching WA's own iconography
  const isStarred  = toBool(msg.starred)
  const hasBodyTxt = !!(msg.body || t === "conversation" || t === "extendedTextMessage")
  const hasDownloadedMedia = toBool(msg.has_media) && !!msg.media_saved_path

  const ctxItems = [
    // ── Reply ───────────────────────────────────────────────
    {
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="9 17 4 12 9 7"/>
          <path d="M20 18v-2a4 4 0 0 0-4-4H4"/>
        </svg>
      ),
      label: "Reply",
      action: handleReply,
    },

    // ── Copy (text only) ────────────────────────────────────
    ...(hasBodyTxt ? [{
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <rect x="9" y="9" width="13" height="13" rx="2"/>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>
      ),
      label: "Copy",
      action: () => navigator.clipboard?.writeText(msg.body || getPreviewText()),
    }] : []),

    // ── React ───────────────────────────────────────────────
    {
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="12" r="10"/>
          <path d="M8 14s1.5 2 4 2 4-2 4-2"/>
          <line x1="9" y1="9" x2="9.01" y2="9" strokeWidth="3"/>
          <line x1="15" y1="9" x2="15.01" y2="9" strokeWidth="3"/>
        </svg>
      ),
      label: "React",
      action: () => {
        // TODO: open emoji picker — placeholder shows toast for now
        console.log("[WaPlus] React picker: not yet implemented")
      },
    },

    // ── Forward ─────────────────────────────────────────────
    {
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <polyline points="15 17 20 12 15 7"/>
          <path d="M4 18v-2a4 4 0 0 1 4-4h12"/>
        </svg>
      ),
      label: "Forward",
      action: () => window.api?.forwardMessage?.({ id: msg.id, chatJid: msg.chat_jid }),
    },

    // ── Pin ─────────────────────────────────────────────────
    {
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <line x1="12" y1="17" x2="12" y2="22"/>
          <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/>
        </svg>
      ),
      label: "Pin",
      action: () => window.api?.pinMessage?.({ id: msg.id, chatJid: msg.chat_jid }),
    },

    // ── Star / Unstar ───────────────────────────────────────
    {
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24"
          fill={isStarred ? "currentColor" : "none"}
          stroke="currentColor" strokeWidth="2" strokeLinecap="round"
          style={{ color: isStarred ? "#f59e0b" : undefined }}>
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
        </svg>
      ),
      label: isStarred ? "Unstar" : "Star",
      action: () => window.api?.starMessage?.({ id: msg.id, chatJid: msg.chat_jid, star: !isStarred }),
    },

    "divider",

    // ── View Quoted (conditional) ────────────────────────────
    ...(hasQuoted && onScrollToMsg ? [{
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <polyline points="9 14 4 9 9 4"/>
          <path d="M20 20v-7a4 4 0 0 0-4-4H4"/>
        </svg>
      ),
      label: "View Quoted",
      action: () => onScrollToMsg(msg.quoted_id),
    }] : []),

    // ── Save Media (conditional) ─────────────────────────────
    ...(hasDownloadedMedia ? [{
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
      ),
      label: "Save Media",
      action: () => window.api?.saveFile?.({ path: msg.media_saved_path }),
    }] : []),

    "divider",

    // ── View Raw JSON ────────────────────────────────────────
    {
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="16" y1="13" x2="8" y2="13"/>
          <line x1="16" y1="17" x2="8" y2="17"/>
          <polyline points="10 9 9 9 8 9"/>
        </svg>
      ),
      label: "View Raw JSON",
      raw: true,
      hint: "JSON",
      action: () => setRawViewer(true),
    },

    // ── Dev Eval — Baileys Sandbox ───────────────────────────
    {
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <polyline points="16 18 22 12 16 6"/>
          <polyline points="8 6 2 12 8 18"/>
        </svg>
      ),
      label: "Dev Eval",
      raw: true,
      hint: "JS",
      action: () => setDevEvalOpen(true),
    },

    "divider",

    // ── Report ─────────────────────────────────────────────
    {
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/>
          <line x1="4" y1="22" x2="4" y2="15"/>
        </svg>
      ),
      label: "Report",
      danger: true,
      action: () => window.api?.reportMessage?.({ id: msg.id, chatJid: msg.chat_jid }),
    },

    // ── Delete ──────────────────────────────────────────────
    {
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
          <line x1="10" y1="11" x2="10" y2="17"/>
          <line x1="14" y1="11" x2="14" y2="17"/>
        </svg>
      ),
      label: "Delete",
      danger: true,
      action: () => window.api?.deleteMessage?.({ id: msg.id, chatJid: msg.chat_jid }),
    },
  ]

  // Reaction float display
  if (isReaction) {
    const emoji = msg.body || msg.reaction_emoji || "❤️"
    return (
      <div ref={wrapRef} style={{ display: "flex", justifyContent: isMe ? "flex-end" : "flex-start", padding: "1px 14px", userSelect: "none" }} onContextMenu={onContextMenu}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: isMe ? "flex-end" : "flex-start", gap: 2 }}>
          {!isMe && isGroup && senderDisplay && <div style={{ fontSize: 11, color: "var(--text-3)", paddingLeft: 2 }}>{senderDisplay}</div>}
          <div title={`Reaksi • ${senderDisplay || (isMe ? "Kamu" : "Mereka")}`}
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
        {ctxMenu && <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={ctxItems} onClose={() => setCtxMenu(null)} />}
        {rawViewer  && <RawViewerModal msg={msg} onClose={() => setRawViewer(false)} />}
      {devEvalOpen && <DevEvalModal  msg={msg} onClose={() => setDevEvalOpen(false)} />}
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
      {rawViewer  && <RawViewerModal msg={msg} onClose={() => setRawViewer(false)} />}
      {devEvalOpen && <DevEvalModal  msg={msg} onClose={() => setDevEvalOpen(false)} />}

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
                <QuotedMsg body={msg.quoted_body} sender={msg.quoted_sender} senderName={msg.quoted_sender_name} type={msg.quoted_type} hasMedia={toBool(msg.quoted_has_media)} mimetype={msg.quoted_mimetype}
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
