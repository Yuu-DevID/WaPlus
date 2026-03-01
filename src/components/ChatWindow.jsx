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
import { useMediaPrefetch } from "../hooks/useMediaPrefetch"

// ── Helpers ───────────────────────────────────────────────────────────────────
const toBool = (v) => v === 1 || v === true

// Album detection: find consecutive image/video messages within 90s of each other
// Returns array of {src, type, caption, msgId, filename} items + index of clicked msg
function buildAlbumItems(msgs, clickedId) {
  const MEDIA_TYPES = new Set(["imageMessage", "videoMessage"])
  const ALBUM_WINDOW_S = 90

  // Find the clicked message and its timestamp
  const clickedIdx = msgs.findIndex(m => m.id === clickedId)
  if (clickedIdx === -1) return null

  const clicked = msgs[clickedIdx]
  if (!MEDIA_TYPES.has(clicked.msg_type)) return null
  if (!clicked.media_saved_path && !clicked.media_url) return null

  const refTs = clicked.timestamp || 0

  // Expand to adjacent messages within the time window and same from_me direction
  // (Albums in WA are from same sender, sent within a short window)
  const isFromSameAlbum = (m) => {
    if (!MEDIA_TYPES.has(m.msg_type)) return false
    if (!m.media_saved_path && !m.media_url) return false
    if (m.from_me !== clicked.from_me) return false
    const diff = Math.abs((m.timestamp || 0) - refTs)
    return diff <= ALBUM_WINDOW_S
  }

  // Find contiguous block around clicked
  let start = clickedIdx
  let end = clickedIdx

  // Expand backwards
  for (let i = clickedIdx - 1; i >= 0; i--) {
    if (isFromSameAlbum(msgs[i])) start = i
    else break
  }
  // Expand forwards
  for (let i = clickedIdx + 1; i < msgs.length; i++) {
    if (isFromSameAlbum(msgs[i])) end = i
    else break
  }

  const group = msgs.slice(start, end + 1)

  // Only treat as album if 2+ items
  if (group.length < 2) return null

  const pathToSrc = (raw) => {
    if (!raw) return null
    if (raw.startsWith("file://")) return raw
    let p = raw.replace(/\\/g, "/")
    if (/^[A-Za-z]:\//.test(p)) {
      const enc = p.split("/").map((s, i) => i === 0 ? s : encodeURIComponent(s)).join("/")
      return `file://${enc}`
    }
    const w = p.startsWith("/") ? p : `/${p}`
    return `file://${w.split("/").map((s, i) => i === 0 ? s : encodeURIComponent(s)).join("/")}`
  }

  const items = group.map(m => ({
    src: pathToSrc(m.media_saved_path) || m.media_url || null,
    type: m.msg_type === "videoMessage" ? "video" : "image",
    caption: m.body || "",
    msgId: m.id,
    filename: m.media_filename,
  }))

  const albumIndex = group.findIndex(m => m.id === clickedId)
  return { items, index: albumIndex }
}

function pathToSrc(raw) {
  if (!raw) return null
  if (raw.startsWith("file://")) return raw
  let p = raw.replace(/\\/g, "/")
  if (/^[A-Za-z]:\//.test(p)) {
    const enc = p.split("/").map((s, i) => i === 0 ? s : encodeURIComponent(s)).join("/")
    return `file://${enc}`
  }
  const w = p.startsWith("/") ? p : `/${p}`
  return `file://${w.split("/").map((s, i) => i === 0 ? s : encodeURIComponent(s)).join("/")}`
}
const toInt = (v) => (v === 1 || v === true ? 1 : 0)

// [FIX-MESSAGES] Normalize JID agar cocok dengan store key yang dipakai loadMessages()
// Mirror normalizeJid() di store/chat.js — mencegah messages[jid] miss
// saat prop masuk sebagai @c.us atau dengan :device suffix.
function normalizeJid(jid) {
  if (!jid || typeof jid !== "string") return ""
  const atIdx = jid.lastIndexOf("@")
  if (atIdx === -1) return jid
  let user = jid.slice(0, atIdx)
  let server = jid.slice(atIdx + 1)
  const colonIdx = user.indexOf(":")
  if (colonIdx !== -1) user = user.slice(0, colonIdx)
  if (server === "c.us") server = "s.whatsapp.net"
  return `${user}@${server}`
}

const COLORS = ["#1a5c3e", "#1565c0", "#6a1b9a", "#b71c1c", "#e65100",
  "#2e7d32", "#00695c", "#4527a0", "#00838f", "#ad1457"]
function getColor(s) {
  if (!s) return COLORS[0]
  let h = 0
  for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h)
  return COLORS[Math.abs(h) % COLORS.length]
}
function initials(n) {
  if (!n) return "?"
  const stripped = n.replace(/[\s\-+().]/g, "")
  if (/^\d{6,}$/.test(stripped)) return stripped.slice(-2)
  return n.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join("").toUpperCase()
}

/**
 * resolveDisplayName — converts JID + chat object into a human-readable name.
 * Never returns raw @lid / @s.whatsapp.net JIDs.
 *
 * Priority:
 *   Groups      : chat.name (subject) > chat.subject > "Grup"
 *   @lid DM     : chat.name > chat.last_sender_name > chat.push_name > "+number"
 *   Regular DM  : chat.name (phonebook/push_name) > "+number"
 */
function resolveDisplayName(jid, chat) {
  // Support legacy call with (jid, string) for backwards compat
  const savedName = typeof chat === "string" ? chat : (chat?.name || "")
  const chatObj = typeof chat === "object" && chat !== null ? chat : {}

  const atIdx = jid ? jid.lastIndexOf("@") : -1
  const server = atIdx !== -1 ? jid.slice(atIdx + 1) : ""
  const user = atIdx !== -1 ? jid.slice(0, atIdx) : (jid || "")
  const cleanUser = user.split(":")[0]
  const isLid = server === "lid"

  // Groups / newsletters
  if (server === "g.us" || server === "newsletter") {
    const n = savedName || chatObj.subject || ""
    return (n && !n.includes("@")) ? n : "Grup"
  }

  // Coba semua kandidat nama — skip yang mengandung "@" (raw JID)
  const candidates = [
    savedName,
    chatObj.last_sender_name,
    chatObj.push_name,
  ]
  for (const c of candidates) {
    if (c && typeof c === "string" && !c.includes("@") && c.trim()) {
      return c.trim()
    }
  }

  // Last resort: format number dari JID
  if (/^\d{6,}$/.test(cleanUser)) {
    // Untuk @lid, angkanya bukan phone number — label berbeda
    return isLid ? `~${cleanUser.slice(-8)}` : `+${cleanUser}`
  }

  return cleanUser || "Unknown"
}

// ── Avatar ────────────────────────────────────────────────────────────────────
const picCache = new Map()
const fetching = new Set()

function Avatar({ jid, name, size = 38 }) {
  const [url, setUrl] = useState(() => picCache.has(jid) ? picCache.get(jid) : undefined)
  const [err, setErr] = useState(false)

  useEffect(() => {
    if (!jid) return
    if (picCache.has(jid)) {
      const cached = picCache.get(jid)
      if (cached !== url) setUrl(cached)
      return
    }
    if (fetching.has(jid)) return
    fetching.add(jid)
    window.api?.getProfilePic?.({ jid })
      .then(r => { const u = r?.url || null; picCache.set(jid, u); setUrl(u) })
      .catch(() => picCache.set(jid, null))
      .finally(() => fetching.delete(jid))
  }, [jid])

  useEffect(() => { setErr(false) }, [url])

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
    contacts, updateReactions, prependMessages, loadReactions,
  } = useChatStore()
  const { toggleRightPanel, openMedia } = useAppStore()

  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)  // [FIX-SCROLL] loading older msgs
  const [hasMore, setHasMore] = useState(true)           // [FIX-SCROLL] more msgs to fetch
  const [replyTo, setReplyTo] = useState(null)   // [REPLY] message being replied to
  const [showScrollBtn, setShowScrollBtn] = useState(false) // scroll-to-bottom button
  const [unreadCount, setUnreadCount] = useState(0)          // unread badge count
  const bottomRef = useRef(null)
  const areaRef = useRef(null)
  const prevJidRef = useRef(null)
  // [REPLY] Map msgId → DOM element ref for scroll-to-message
  const msgRefsMap = useRef({})
  // [FIX-SCROLL] Track pagination offset per JID
  const offsetRef = useRef(0)

  // [FIX-MESSAGES] Lookup pakai normalized key — loadMessages() simpan di normalizeJid(jid)
  const normalizedJid = normalizeJid(jid)
  const msgs = messages[normalizedJid] || []
  const isGroup = (jid || "").endsWith("@g.us")

  // Resolve chat info
  // [FIX-MESSAGES] Normalize JID saat cari chat — @c.us vs @s.whatsapp.net bisa beda
  const chat = chats.find(c => normalizeJid(c.jid) === normalizedJid)
  // [FIX-LID] resolveDisplayName handles @lid, @s.whatsapp.net, unsaved contacts
  const name = resolveDisplayName(jid, chat || {})

  // ── Media click handler: detect album or open single ────────────────────
  const handleMediaClick = useCallback((msg, src, type) => {
    const album = buildAlbumItems(msgs, msg.id)
    if (album) {
      openMedia(album.items, album.index)
    } else {
      openMedia([{
        src: src || pathToSrc(msg.media_saved_path) || msg.media_url,
        type,
        caption: msg.body || "",
        msgId: msg.id,
        filename: msg.media_filename,
      }], 0)
    }
  }, [msgs, openMedia])

  // [PREFETCH] Fire high-priority media prefetch when this chat opens.
  // Downloads pending images/videos/stickers in background before user scrolls.
  useMediaPrefetch(jid)

  // ── [FIX-1 + FIX-5] On JID change: load messages, register active ────────
  useEffect(() => {
    if (!jid) return
    prevJidRef.current = jid
    setReplyTo(null)
    offsetRef.current = 0
    setHasMore(true)
    setActiveJid(jid)
    setLoading(true)

    console.log(`[ChatWindow] opening jid=${jid}`)
    loadMessages(jid, 50, 0).then(msgs => {
      if (prevJidRef.current !== jid) {
        console.log(`[ChatWindow] stale result for ${jid}, current = ${prevJidRef.current}, skipping`)
        return
      }
      setLoading(false)
      // Pakai store length — mungkin berbeda jika refreshActiveChat jalan bersamaan
      const stored = useChatStore.getState().messages[normalizeJid(jid)] || []
      const count = stored.length || msgs?.length || 0
      offsetRef.current = count
      if (count < 50) setHasMore(false)
      loadReactions(jid)
      // Refresh chat list agar history chats update preview mereka
      useChatStore.getState().loadChats?.()
    }).catch(() => {
      if (prevJidRef.current === jid) setLoading(false)
    })
  }, [jid])

  // ── [FIX-2] Auto-refresh: event-driven ──────────────────────────────────
  // Primary: listen to IPC events for this specific chat
  useEffect(() => {
    if (!jid || !window.api) return
    const subs = []

    // ── Source 1: messages:new dari Baileys client.js ─────────────────────
    // payload = buildRendererPayload(parsed) dari messageParser.js
    // Fields: chat_jid, id, from_me, sender_name, msg_type
    // (BUKAN jid/key/isMe/pushname/msgType — itu field raw Baileys)
    if (window.api.onMessagesNew) {
      subs.push(window.api.onMessagesNew(data => {
        // [FIX-FIELD] data.jid tidak ada — field yang benar adalah data.chat_jid
        // [FIX-4] normalize kedua sisi agar @c.us vs @s.whatsapp.net tidak mismatch
        if (!data?.chat_jid) return
        if (normalizeJid(data.chat_jid) !== normalizeJid(jid)) return
        if (data.is_history_sync) return

        // buildRendererPayload emit id langsung (tanpa key wrapper)
        const msgId = data.id
        if (!msgId) return

        // [REALTIME-REACTION] Jika ini adalah reaction message, update reaction di target
        if (data.msg_type === "reactionMessage" && data.reaction_target_id) {
          const sender = data.sender_jid || data.chat_jid || ""
          useChatStore.getState().updateReactions(
            normalizeJid(jid), data.reaction_target_id, sender,
            data.reaction_emoji || data.body || ""
          )
          return  // Don't add as regular message
        }

        appendMessage(jid, {
          id: msgId,
          chat_jid: jid,
          body: data.body || "",
          msg_type: data.msg_type || "conversation",
          timestamp: data.timestamp || Math.floor(Date.now() / 1000),
          from_me: data.from_me ?? 0,
          status: data.status ?? 0,
          sender_name: data.sender_name || "",
          sender_jid: data.sender_jid || null,
          is_group: toInt(isGroup),
          has_media: data.has_media ?? 0,
          mimetype: data.mimetype || null,
          media_duration: data.media_duration || null,
          media_filename: data.media_filename || null,
          media_saved_path: data.media_saved_path || null,
          media_url: data.media_url || null,
          is_ptt: data.is_ptt ?? 0,
          is_gif: data.is_gif ?? 0,
          is_view_once: data.is_view_once ?? 0,
          is_animated: data.is_animated ?? 0,
          quoted_id: data.quoted_id || null,
          quoted_body: data.quoted_body || null,
          quoted_sender: data.quoted_sender || null,
          quoted_type: data.quoted_type || null,
          quoted_has_media: data.quoted_has_media ?? 0,
          reaction_emoji: data.reaction_emoji || null,
          reaction_target_id: data.reaction_target_id || null,
          is_forwarded: data.is_forwarded ?? 0,
          starred: data.starred ?? 0,
        })
      }))
    }

    // ── Source 2: db:messages:new dari main.js ────────────────────────────
    if (window.api.onNewMessage) {
      subs.push(window.api.onNewMessage(data => {
        // [FIX-4] normalize JID comparison
        if (normalizeJid(data.chat_jid) !== normalizeJid(jid)) return
        const m = data.message
        if (!m?.id) return

        appendMessage(jid, {
          id: m.id,
          chat_jid: jid,
          body: m.body || "",
          msg_type: m.msg_type || "conversation",
          timestamp: m.timestamp || Math.floor(Date.now() / 1000),
          from_me: m.from_me ?? 0,
          status: m.status ?? 0,
          sender_name: m.sender_name || "",
          is_group: toInt(isGroup),
          mimetype: m.mimetype || null,
          duration: m.duration || null,
          media_saved_path: m.media_saved_path || null,
          media_url: m.media_url || null,
        })
      }))
    }

    // ── Source 3: db:chats:updated → silent refresh message list ──────────
    // Catches: status updates, edits, reactions, dll yang tidak emit new message
    if (window.api.onChatsUpdated) {
      subs.push(window.api.onChatsUpdated(() => {
        refreshActiveChat()
      }))
    }

    // ── Source 4: media:updated → update media path pesan tertentu ────────
    if (window.api.onMediaUpdated) {
      subs.push(window.api.onMediaUpdated(data => {
        if (normalizeJid(data.chat_jid) !== normalizeJid(jid)) return
        useChatStore.getState().updateMessageMedia(data)
      }))
    }

    // ── Source 5: messages:reaction → realtime update di target message ──
    // [FIX-REACTIONS-REALTIME] Setiap reaction event = array of {key, reaction} objects
    // Langsung update store TANPA reload — ReactionOverlay re-render otomatis
    if (window.api.onMessagesReaction) {
      subs.push(window.api.onMessagesReaction(reactions => {
        for (const item of (reactions || [])) {
          const reactionData = item.reaction || item
          const targetId = reactionData.key?.id || item.key?.id
          const chatJid = reactionData.key?.remoteJid || item.key?.remoteJid || jid
          const emoji = reactionData.text || ""
          const sender = reactionData.key?.participant || reactionData.key?.remoteJid || ""
          if (!targetId) continue
          // [REALTIME] Update langsung tanpa tunggu refresh
          useChatStore.getState().updateReactions(normalizeJid(chatJid || jid), targetId, sender, emoji)
        }
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
      const area = areaRef.current
      if (area) {
        const distFromBottom = area.scrollHeight - area.scrollTop - area.clientHeight
        if (distFromBottom < 200) {
          setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 60)
        } else {
          // User scrolled up — increment unread counter
          const newCount = msgs.length - prevMsgCountRef.current
          setUnreadCount(prev => prev + newCount)
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

  // [REPLY] Scroll to a message by ID and flash highlight it
  const scrollToMsg = useCallback((msgId) => {
    if (!msgId) return
    const el = document.querySelector(`[data - msgid= "${msgId}"]`)
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" })
      // Trigger highlight animation via custom event
      setTimeout(() => el.dispatchEvent(new CustomEvent("msg-highlight")), 350)
    }
  }, [])

  // [FIX-SCROLL] Load older messages saat user scroll ke atas
  const handleScroll = useCallback(async () => {
    const area = areaRef.current
    if (!area) return
    // Track scroll-to-bottom button visibility
    const dist = area.scrollHeight - area.scrollTop - area.clientHeight
    setShowScrollBtn(dist > 300)
    if (dist < 50) setUnreadCount(0)

    if (!loadingMore && hasMore && !loading) {
      if (area.scrollTop > 120) return  // belum dekat atas

      setLoadingMore(true)
      const currentOffset = offsetRef.current
      const LOAD_COUNT = 30

      const scrollHeightBefore = area.scrollHeight

      const older = await prependMessages(jid, LOAD_COUNT, currentOffset)
      offsetRef.current = currentOffset + older.length

      if (older.length < LOAD_COUNT) setHasMore(false)

      // Trigger media prefetch untuk messages yang baru di-load
      if (older.length > 0 && jid) {
        const { prefetchChat } = await import("../hooks/useMediaPrefetch")
        prefetchChat(jid, LOAD_COUNT + 10, false)
      }

      // Restore scroll position agar viewport tidak loncat
      requestAnimationFrame(() => {
        if (!area) return
        const scrollHeightAfter = area.scrollHeight
        area.scrollTop += (scrollHeightAfter - scrollHeightBefore)
      })

      setLoadingMore(false)
    }
  }, [jid, loadingMore, hasMore, loading, prependMessages])

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
          onClick={() => toggleRightPanel()}
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
      <div className="msg-area" ref={areaRef} onScroll={handleScroll}>
        {/* [FIX-SCROLL] Loading older messages spinner */}
        {loadingMore && (
          <div style={{ display: "flex", justifyContent: "center", padding: "8px 0" }}>
            <span className="spinner spinner-sm" style={{ borderTopColor: "var(--green)", borderColor: "rgba(37,211,102,.2)" }} />
          </div>
        )}
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
            return (
              <div key={item.key} data-msgid={item.msg?.id}>
                <MessageBubble
                  msg={item.msg}
                  onReply={setReplyTo}
                  onScrollToMsg={scrollToMsg}
                  onMediaClick={handleMediaClick}
                />
              </div>
            )
          })
        )}
        <div ref={bottomRef} />
      </div>

      {/* ── Scroll to bottom FAB ── */}
      {showScrollBtn && (
        <button
          className="scroll-to-bottom-btn"
          onClick={() => {
            bottomRef.current?.scrollIntoView({ behavior: "smooth" })
            setUnreadCount(0)
          }}
          title="Scroll ke pesan terbaru"
        >
          {unreadCount > 0 && (
            <span className="scroll-unread-badge">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14M5 12l7 7 7-7" />
          </svg>
        </button>
      )}

      {/* ── Input ── */}
      <MessageInput
        chatJid={jid}
        chatName={name}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
      />
    </div>
  )
}