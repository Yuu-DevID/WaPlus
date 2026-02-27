// src/components/ChatWindow.jsx
// ═══════════════════════════════════════════════════════════════════════════
// PRODUCTION GRADE v3 — AuroraChat Chat Window
//
// FIXES:
// [FIX-1] Chat isolation — clear messages + cancel stale on JID change
// [FIX-2] Auto-refresh — poll every 3s + event-driven refresh on
//         "db:chats:updated" and "db:messages:new" for active chat
// [FIX-3] IPC normalization — from_me/is_group always stored as 0/1
// [FIX-4] Cross-chat contamination guard — ignore IPC events from other JIDs
// [FIX-5] setActiveJid in store — enables store-level auto-refresh
// ═══════════════════════════════════════════════════════════════════════════

import { useEffect, useRef, useState, useCallback } from "react"
import { useChatStore } from "../store/chat"
import { useAppStore } from "../store/app"
import { format, isToday, isYesterday } from "date-fns"
import MessageBubble from "./MessageBubble"
import MessageInput from "./MessageInput"

// ── Helpers ───────────────────────────────────────────────────────────────────
const toBool = (v) => v === 1 || v === true
const toInt  = (v) => (v === 1 || v === true ? 1 : 0)

const COLORS = ["#1a5c3e","#1565c0","#6a1b9a","#b71c1c","#e65100",
                "#2e7d32","#00695c","#4527a0","#00838f","#ad1457"]
function getColor(s) {
  if (!s) return COLORS[0]
  let h = 0
  for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h)
  return COLORS[Math.abs(h) % COLORS.length]
}
function initials(n) {
  if (!n) return "?"
  return n.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join("").toUpperCase()
}

// ── Avatar ────────────────────────────────────────────────────────────────────
const picCache = new Map()
const fetching = new Set()

function Avatar({ jid, name, size = 38 }) {
  const [url, setUrl] = useState(() => picCache.has(jid) ? picCache.get(jid) : null)
  const [err, setErr] = useState(false)

  useEffect(() => {
    if (!jid || url || fetching.has(jid) || err) return
    if (picCache.has(jid)) { setUrl(picCache.get(jid)); return }
    fetching.add(jid)
    window.api?.getProfilePic?.({ jid })
      .then(r => { const u = r?.url || null; picCache.set(jid, u); setUrl(u) })
      .catch(() => picCache.set(jid, null))
      .finally(() => fetching.delete(jid))
  }, [jid])

  return (
    <div
      className="chat-header-avatar"
      style={{ width: size, height: size, background: getColor(jid || name) }}
    >
      {url && !err && <img src={url} alt={name} onError={() => setErr(true)} />}
      {(!url || err) && initials(name)}
    </div>
  )
}

// ── Icons ─────────────────────────────────────────────────────────────────────
function SearchIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}
function PhoneIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.61 3.53 2 2 0 0 1 3.55 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.69a16 16 0 0 0 6.29 6.29l.9-.9a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  )
}
function DotsIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" />
    </svg>
  )
}

// ── Date separator ────────────────────────────────────────────────────────────
function DateSep({ date }) {
  const d = new Date(date * 1000)
  let label = format(d, "dd MMMM yyyy")
  if (isToday(d)) label = "Hari Ini"
  else if (isYesterday(d)) label = "Kemarin"
  return <div className="date-sep"><div className="date-sep-label">{label}</div></div>
}

// Group messages by date for date separators
function groupByDate(messages) {
  const groups = []
  let lastDate = null
  for (const msg of messages) {
    const d = msg.timestamp ? new Date(msg.timestamp * 1000).toDateString() : null
    if (d && d !== lastDate) {
      groups.push({ type: "date", key: "date-" + msg.timestamp, ts: msg.timestamp })
      lastDate = d
    }
    groups.push({ type: "msg", key: msg.id || String(msg.timestamp), msg })
  }
  return groups
}

function SkeletonBubble({ isMe }) {
  return (
    <div style={{
      display: "flex", flexDirection: "column",
      alignItems: isMe ? "flex-end" : "flex-start",
      padding: "4px 14px"
    }}>
      <div className="skel" style={{
        width: isMe ? 180 : 220, height: 40,
        borderRadius: isMe ? "16px 4px 16px 16px" : "4px 16px 16px 16px"
      }} />
    </div>
  )
}

function formatPhone(raw) {
  if (!raw || !/^\d{6,}$/.test(raw)) return raw || "Unknown"
  const m = raw.match(/^(\d{1,3})(\d{3})(\d{1,4})(\d*)$/)
  if (!m) return `+${raw}`
  const [, cc, a, b, rest] = m
  return rest ? `+${cc} ${a}-${b}-${rest}` : `+${cc} ${a}-${b}`
}

// ════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ════════════════════════════════════════════════════════════

export default function ChatWindow({ jid }) {
  const {
    messages, loadMessages, refreshActiveChat,
    chats, appendMessage, setActiveJid,
    contacts,
  } = useChatStore()
  const { setRightPanel } = useAppStore()

  const [loading, setLoading] = useState(true)
  const bottomRef  = useRef(null)
  const areaRef    = useRef(null)
  const prevJidRef = useRef(null)

  // Resolve chat info
  const chat = chats.find(c => c.jid === jid)
  const rawName = chat?.name || ""
  const name = (rawName && !/^\d{6,}$/.test(rawName.trim()))
    ? rawName
    : formatPhone((jid || "").split("@")[0])

  const msgs = messages[jid] || []
  const isGroup = (jid || "").endsWith("@g.us")

  // ── [FIX-1 + FIX-5] On JID change: clear old, load new, register active ──
  useEffect(() => {
    if (!jid) return
    prevJidRef.current = jid

    // Tell store which chat is active (enables store-level auto-refresh)
    setActiveJid(jid)

    setLoading(true)
    loadMessages(jid).finally(() => {
      // Only clear loading if we're still on this same JID
      if (prevJidRef.current === jid) setLoading(false)
    })

    return () => {
      // On unmount or JID change — deregister active
      // (setActiveJid(null) is NOT called here to avoid flicker;
      //  next mount with new JID will overwrite)
    }
  }, [jid])

  // ── [FIX-2] Auto-refresh: event-driven ──────────────────────────────────
  // Primary: listen to IPC events for this specific chat
  useEffect(() => {
    if (!jid || !window.api) return
    const subs = []

    // ── Source 1: messages:new from Baileys client.js ──────────────────────
    if (window.api.onMessagesNew) {
      subs.push(window.api.onMessagesNew(data => {
        // [FIX-4] Only handle events for THIS chat
        if (data.jid !== jid) return
        if (data.isHistorySync) return

        const msgId = data.key?.id
        if (!msgId) return

        appendMessage(jid, {
          id:               msgId,
          chat_jid:         jid,
          body:             data.body || "",
          msg_type:         data.msgType || "conversation",
          timestamp:        data.timestamp || Math.floor(Date.now() / 1000),
          from_me:          toInt(data.isMe),
          status:           data.status ?? 0,
          sender_name:      data.pushname || "",
          is_group:         toInt(isGroup),
          mimetype:
            data.message?.imageMessage?.mimetype  ||
            data.message?.videoMessage?.mimetype  ||
            data.message?.stickerMessage?.mimetype||
            data.message?.audioMessage?.mimetype  ||
            null,
          duration:         data.message?.audioMessage?.seconds || null,
          media_saved_path: null,
          media_url:
            data.message?.imageMessage?.url ||
            data.message?.videoMessage?.url ||
            data.message?.stickerMessage?.url ||
            null,
          // Reply info from Baileys
          quoted_id:     data.quoted?.key?.id || null,
          quoted_body:   data.quoted?.body    || null,
          quoted_sender: data.quoted?.participant || data.quoted?.remoteJid || null,
          quoted_type:   data.quoted?.type    || null,
        })
      }))
    }

    // ── Source 2: db:messages:new from main.js ─────────────────────────────
    if (window.api.onNewMessage) {
      subs.push(window.api.onNewMessage(data => {
        // [FIX-4] Only handle events for THIS chat
        if (data.chat_jid !== jid) return
        const m = data.message
        if (!m?.id) return

        appendMessage(jid, {
          id:               m.id,
          chat_jid:         jid,
          body:             m.body             || "",
          msg_type:         m.msg_type         || "conversation",
          timestamp:        m.timestamp        || Math.floor(Date.now() / 1000),
          from_me:          m.from_me          ?? 0,
          status:           m.status           ?? 0,
          sender_name:      m.sender_name      || "",
          is_group:         toInt(isGroup),
          mimetype:         m.mimetype         || null,
          duration:         m.duration         || null,
          media_saved_path: m.media_saved_path || null,
          media_url:        m.media_url        || null,
        })
      }))
    }

    // ── Source 3: db:chats:updated → silent refresh of message list ────────
    // This catches: status updates, edits, reactions, etc. that don't
    // emit a "new message" event but still change the DB
    if (window.api.onChatsUpdated) {
      subs.push(window.api.onChatsUpdated(() => {
        refreshActiveChat()
      }))
    }

    // ── Source 4: media:updated → update specific message media path ───────
    if (window.api.onMediaUpdated) {
      subs.push(window.api.onMediaUpdated(data => {
        if (data.chat_jid !== jid) return
        useChatStore.getState().updateMessageMedia(data)
      }))
    }

    return () => subs.forEach(fn => typeof fn === "function" && fn())
  }, [jid, isGroup])

  // ── [FIX-2] Auto-refresh: poll-based fallback every 4s ──────────────────
  // Belt-and-suspenders: catches any messages that slipped through IPC events
  useEffect(() => {
    if (!jid) return
    const interval = setInterval(() => {
      // Only poll if not currently doing a full load
      if (!useChatStore.getState().messagesLoading) {
        refreshActiveChat()
      }
    }, 4000)
    return () => clearInterval(interval)
  }, [jid])

  // ── Auto-scroll when new messages arrive ─────────────────────────────────
  const prevMsgCountRef = useRef(0)
  useEffect(() => {
    if (loading) return
    if (msgs.length > prevMsgCountRef.current) {
      // Only auto-scroll if user is near bottom (within 200px)
      const area = areaRef.current
      if (area) {
        const distFromBottom = area.scrollHeight - area.scrollTop - area.clientHeight
        if (distFromBottom < 200) {
          setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 60)
        }
      }
    }
    prevMsgCountRef.current = msgs.length
  }, [msgs.length, loading])

  // Initial scroll to bottom when chat loads
  useEffect(() => {
    if (!loading && msgs.length > 0) {
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "auto" }), 80)
    }
  }, [loading])

  const grouped = groupByDate(msgs)

  // ════════════════════════════════════════════════════════════
  // RENDER
  // ════════════════════════════════════════════════════════════

  return (
    <div className="chat-window">
      {/* ── Header ── */}
      <div className="chat-header">
        <Avatar jid={jid} name={name} />
        <div
          className="chat-header-info"
          style={{ cursor: "pointer" }}
          onClick={() => setRightPanel("contact")}
        >
          <div className="chat-header-name">{name}</div>
          <div className="chat-header-status">
            {isGroup
              ? `${chat?.participant_count || "beberapa"} anggota`
              : "online"
            }
          </div>
        </div>
        <div className="chat-header-actions">
          <button className="header-btn" title="Cari"><SearchIcon /></button>
          <button className="header-btn" title="Telepon"><PhoneIcon /></button>
          <button className="header-btn" title="Lebih"><DotsIcon /></button>
        </div>
      </div>

      {/* ── Messages area ── */}
      <div className="msg-area" ref={areaRef}>
        {loading ? (
          Array.from({ length: 8 }).map((_, i) => (
            <SkeletonBubble key={i} isMe={i % 3 === 0} />
          ))
        ) : msgs.length === 0 ? (
          <div style={{
            display: "flex", flexDirection: "column", alignItems: "center",
            justifyContent: "center", height: "100%", gap: 10, color: "var(--text-3)",
          }}>
            <div style={{ fontSize: 42 }}>💬</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-2)" }}>
              Belum ada pesan
            </div>
            <div style={{ fontSize: 11 }}>Mulai percakapan di bawah</div>
          </div>
        ) : (
          grouped.map(item => {
            if (item.type === "date") {
              return <DateSep key={item.key} date={item.ts} />
            }
            return <MessageBubble key={item.key} msg={item.msg} />
          })
        )}
        <div ref={bottomRef} />
      </div>

      {/* ── Input ── */}
      <MessageInput chatJid={jid} />
    </div>
  )
}