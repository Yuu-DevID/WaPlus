// src/components/MessageBubble.jsx — v6 (refactored)
// ═══════════════════════════════════════════════════════════════════════════
// Main message bubble orchestrator. Sub-components dipecah ke bubble/ folder:
//
//   bubble/icons.jsx      — Semua SVG Heroicon components
//   bubble/utils.jsx      — Shared hooks, helpers, atom components (RichText,
//                           Ticks, BubbleTime, QuotedMsg, ReactionOverlay, dll)
//   bubble/MediaBubble.jsx — ImageBubble, VideoBubble, StickerBubble,
//                           ViewOnceBubble, AlbumBubble
//   bubble/AudioBubble.jsx — AudioBubble (PTT + audio player)
//   bubble/MiscBubble.jsx  — DocBubble, PollBubble, LocationBubble,
//                           ContactBubble, GroupInviteBubble, ButtonsBubble,
//                           OrderBubble, PaymentBubble, CallLogBubble, dll
//
// File ini: renderContent(), RawViewerModal, ContextMenu,
//           AlbumBubbleWrapper, MessageBubble (default export)
// ═══════════════════════════════════════════════════════════════════════════

import { useState, useRef, useCallback, useEffect, useMemo, memo } from "react"
import { useAppStore } from "../store/app"
import DevEvalModal from "./DevEvalModal"

// ── Sub-components ────────────────────────────────────────────────────────
import { ImageBubble, VideoBubble, StickerBubble, ViewOnceBubble, AlbumBubble } from "./bubble/MediaBubble"
import AudioBubble from "./bubble/AudioBubble"
import {
  DocBubble, PollBubble, LocationBubble, ContactBubble,
  GroupInviteBubble, ButtonsBubble, InteractiveResponseBubble,
  OrderBubble, ProductBubble, PaymentBubble, CallLogBubble,
  EventBubble, NewsletterBubble,
} from "./bubble/MiscBubble"
import {
  HiChartBar, HiArchiveBox, ReplyIcon,
} from "./bubble/icons"
import {
  toBool, fmtPhone, NO_PAD_TYPES,
  Ticks, BubbleTime, ForwardBadge, ReactionOverlay, QuotedMsg, RichText,
} from "./bubble/utils"


// ════════════════════════════════════════════════════════════
// MAIN CONTENT RENDERER
// Maps msg_type → correct bubble component
// ════════════════════════════════════════════════════════════
function renderContent(msg, opts = {}) {
  const t = msg.msg_type || "conversation"
  if (toBool(msg.is_view_once) || t === "viewOnceMessage" || t === "viewOnceMessageV2")
    return <ViewOnceBubble msg={msg} />
  if (msg._isAlbumPart) return null

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
    case "liveLocationMessage": return <LocationBubble msg={msg} />

    case "contactMessage":
    case "contactsArrayMessage": return <ContactBubble msg={msg} />

    case "pollCreationMessage": return <PollBubble msg={msg} />
    case "pollUpdateMessage":
      return (
        <div className="bubble-text" style={{ fontStyle: "italic", color: "var(--text-2)", display: "flex", alignItems: "center", gap: 5 }}>
          <HiChartBar size={14} /> Vote diperbarui
        </div>
      )

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

    case "orderMessage":   return <OrderBubble msg={msg} />
    case "productMessage": return <ProductBubble msg={msg} />

    case "paymentMessage":
    case "requestPaymentMessage":
    case "sendPaymentMessage": return <PaymentBubble msg={msg} />

    case "callLogMessage":   return <CallLogBubble msg={msg} />
    case "eventMessage":     return <EventBubble msg={msg} />
    case "newsletterAdminInviteMessage": return <NewsletterBubble msg={msg} />

    case "protocol":
    case "ephemeral":
    case "messageContextInfo":
    case "unknown": return null

    default:
      if (msg.body) return <div className="bubble-text"><RichText text={msg.body} /></div>
      return (
        <div className="bubble-unsupported" style={{ display: "flex", alignItems: "center", gap: 5, color: "var(--text-3)", fontSize: 12 }}>
          <HiArchiveBox size={14} />{t}
        </div>
      )
  }
}

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