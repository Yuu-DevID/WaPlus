// src/components/ChatWindow.jsx — FIXED v4
// [F3] markRead saat buka chat — panggil Baileys sock.readMessages via IPC
// [F5] Perbaikan nama: kontak > pushName > nomor
// [F1] Album render — grouping konsekutif image/video dari sender yang sama
import { useEffect, useRef, useState, useCallback } from "react"
import { useChatStore } from "../store/chat"
import { useAppStore } from "../store/app"
import { format, isToday, isYesterday } from "date-fns"
import MessageBubble, { AlbumBubbleWrapper } from "./MessageBubble"
import MessageInput from "./MessageInput"
import { useMediaPrefetch } from "../hooks/useMediaPrefetch"

const toBool = (v) => v === 1 || v === true
const ALBUM_TYPES = new Set(["imageMessage", "videoMessage"])
const ALBUM_WINDOW_S = 90

function normalizeJid(jid) {
  if (!jid || typeof jid !== "string") return ""
  const atIdx = jid.lastIndexOf("@")
  if (atIdx === -1) return jid
  let user = jid.slice(0, atIdx), server = jid.slice(atIdx + 1)
  const colonIdx = user.indexOf(":")
  if (colonIdx !== -1) user = user.slice(0, colonIdx)
  if (server === "c.us") server = "s.whatsapp.net"
  return `${user}@${server}`
}

// ─── [F5] resolveDisplayName — kontak > pushName > nomor ────────────────────
function resolveDisplayName(jid, chat) {
  const savedName = typeof chat === "string" ? chat : (chat?.name || "")
  const chatObj = typeof chat === "object" && chat !== null ? chat : {}
  const atIdx = jid ? jid.lastIndexOf("@") : -1
  const server = atIdx !== -1 ? jid.slice(atIdx + 1) : ""
  const user = atIdx !== -1 ? jid.slice(0, atIdx) : (jid || "")
  const cleanUser = user.split(":")[0]
  const isLid = server === "lid"

  if (server === "g.us" || server === "newsletter") {
    const n = savedName || chatObj.subject || ""
    return (n && !n.includes("@")) ? n : "Grup"
  }

  // Priority: kontak name (phonebook) > push_name dari pesan > nomor
  const candidates = [savedName, chatObj.push_name, chatObj.last_sender_name]
  for (const c of candidates) {
    if (c && typeof c === "string" && !c.includes("@") && c.trim()) return c.trim()
  }

  if (/^\d{6,}$/.test(cleanUser)) return isLid ? `~${cleanUser.slice(-8)}` : `+${cleanUser}`
  return cleanUser || "Unknown"
}

const COLORS = ["#1a5c3e","#1565c0","#6a1b9a","#b71c1c","#e65100","#2e7d32","#00695c","#4527a0","#00838f","#ad1457"]
function getColor(s) { if (!s) return COLORS[0]; let h = 0; for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h); return COLORS[Math.abs(h) % COLORS.length] }
function initials(n) {
  if (!n) return "?"
  const stripped = n.replace(/[\s\-+().]/g, "")
  if (/^\d{6,}$/.test(stripped)) return stripped.slice(-2)
  return n.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join("").toUpperCase()
}

const picCache = new Map(), fetching = new Set()
function Avatar({ jid, name, size = 38 }) {
  const [url, setUrl] = useState(() => picCache.has(jid) ? picCache.get(jid) : undefined)
  const [err, setErr] = useState(false)
  useEffect(() => {
    if (!jid) return
    if (picCache.has(jid)) { const cached = picCache.get(jid); if (cached !== url) setUrl(cached); return }
    if (fetching.has(jid)) return
    fetching.add(jid)
    window.api?.getProfilePic?.({ jid }).then(r => { const u = r?.url || null; picCache.set(jid, u); setUrl(u) }).catch(() => picCache.set(jid, null)).finally(() => fetching.delete(jid))
  }, [jid])
  useEffect(() => { setErr(false) }, [url])
  return (
    <div className="chat-header-avatar" style={{ width: size, height: size, background: getColor(jid || name) }}>
      {url && !err && <img src={url} alt={name} onError={() => setErr(true)} />}
      {(!url || err) && initials(name)}
    </div>
  )
}

function SearchIcon() { return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> }
function PhoneIcon() { return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.61 3.53 2 2 0 0 1 3.55 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.69a16 16 0 0 0 6.29 6.29l.9-.9a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg> }
function DotsIcon() { return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg> }

function DateSep({ date }) {
  const d = new Date(date * 1000)
  let label = format(d, "dd MMMM yyyy")
  if (isToday(d)) label = "Hari Ini"
  else if (isYesterday(d)) label = "Kemarin"
  return <div className="date-sep"><div className="date-sep-label">{label}</div></div>
}

// ─── [F1] Group messages into albums ─────────────────────────────────────────
// Returns array of render items:
//   { type: "date", key, ts }
//   { type: "album", key, msgs: [...] }
//   { type: "msg", key, msg }
function groupMessages(messages) {
  const items = []
  let lastDate = null
  let i = 0

  while (i < messages.length) {
    const msg = messages[i]
    const d = msg.timestamp ? new Date(msg.timestamp * 1000).toDateString() : null
    if (d && d !== lastDate) {
      items.push({ type: "date", key: "date-" + msg.timestamp, ts: msg.timestamp })
      lastDate = d
    }

    // Try to build album
    if (ALBUM_TYPES.has(msg.msg_type) && !toBool(msg.is_view_once) && (msg.media_saved_path || msg.media_url)) {
      const albumMsgs = [msg]
      let j = i + 1
      while (j < messages.length) {
        const next = messages[j]
        if (!ALBUM_TYPES.has(next.msg_type)) break
        if (toBool(next.is_view_once)) break
        if (next.from_me !== msg.from_me) break
        const diff = Math.abs((next.timestamp || 0) - (msg.timestamp || 0))
        if (diff > ALBUM_WINDOW_S) break
        albumMsgs.push(next)
        j++
      }

      if (albumMsgs.length >= 2) {
        items.push({ type: "album", key: "album-" + msg.id, msgs: albumMsgs })
        i = j
        continue
      }
    }

    items.push({ type: "msg", key: msg.id || String(msg.timestamp), msg })
    i++
  }

  return items
}

function SkeletonBubble({ isMe }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: isMe ? "flex-end" : "flex-start", padding: "4px 14px" }}>
      <div className="skel" style={{ width: isMe ? 180 : 220, height: 40, borderRadius: isMe ? "16px 4px 16px 16px" : "4px 16px 16px 16px" }} />
    </div>
  )
}

const toInt = (v) => (v === 1 || v === true ? 1 : 0)

// ─── [F3] markRead via Baileys + DB ──────────────────────────────────────────
async function markChatRead(jid, msgs) {
  if (!jid) return
  try {
    // 1. Update DB (markChatRead)
    await window.api?.dbMarkRead?.({ jid })

    // 2. Baileys readMessages — kirim semua unread msg ids
    if (window.api?.markMessagesRead) {
      const unreadIds = msgs
        .filter(m => !toBool(m.from_me) && Number(m.status) < 3)
        .map(m => m.id)
        .filter(Boolean)
      if (unreadIds.length > 0) {
        await window.api.markMessagesRead({ jid, msgIds: unreadIds })
      }
    }
  } catch (e) {
    console.warn("[markChatRead] error:", e)
  }
}

export default function ChatWindow({ jid }) {
  const { messages, loadMessages, refreshActiveChat, chats, appendMessage, setActiveJid, contacts, updateReactions, prependMessages, loadReactions } = useChatStore()
  const { toggleRightPanel, openMedia } = useAppStore()
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [replyTo, setReplyTo] = useState(null)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const [unreadCount, setUnreadCount] = useState(0)
  const bottomRef = useRef(null)
  const inputAreaRef = useRef(null)
  const [scrollBtnBottom, setScrollBtnBottom] = useState(80)

  useEffect(() => {
    const updateBtnPos = () => {
      const el = inputAreaRef.current
      if (!el) { setScrollBtnBottom(80); return }
      setScrollBtnBottom(el.offsetHeight + 14)
    }
    updateBtnPos()
    const ro = new ResizeObserver(updateBtnPos)
    if (inputAreaRef.current) ro.observe(inputAreaRef.current)
    return () => ro.disconnect()
  }, [replyTo])
  const areaRef = useRef(null)
  const prevJidRef = useRef(null)
  const offsetRef = useRef(0)
  const normalizedJid = normalizeJid(jid)
  const msgs = messages[normalizedJid] || []
  const isGroup = (jid || "").endsWith("@g.us")
  const chat = chats.find(c => normalizeJid(c.jid) === normalizedJid)

  // [F5] resolveDisplayName — kontak > pushName > nomor
  const name = resolveDisplayName(jid, chat || {})

  const handleMediaClick = useCallback((msg, src, type) => {
    // Build album items if available
    const ALBUM_TYPES_SET = new Set(["imageMessage", "videoMessage"])
    const ALBUM_WIN = 90
    if (ALBUM_TYPES_SET.has(msg.msg_type)) {
      const clickedIdx = msgs.findIndex(m => m.id === msg.id)
      if (clickedIdx !== -1) {
        const refTs = msg.timestamp || 0
        const isFromAlbum = m => ALBUM_TYPES_SET.has(m.msg_type) && (m.media_saved_path || m.media_url) && m.from_me === msg.from_me && Math.abs((m.timestamp || 0) - refTs) <= ALBUM_WIN
        let start = clickedIdx, end = clickedIdx
        for (let i = clickedIdx - 1; i >= 0; i--) { if (isFromAlbum(msgs[i])) start = i; else break }
        for (let i = clickedIdx + 1; i < msgs.length; i++) { if (isFromAlbum(msgs[i])) end = i; else break }
        const group = msgs.slice(start, end + 1)
        if (group.length >= 2) {
          const pathToSrc = raw => {
            if (!raw) return null
            if (raw.startsWith("file://")) return raw
            let p = raw.replace(/\\/g, "/")
            if (/^[A-Za-z]:\//.test(p)) return `file://${p.split("/").map((s, i) => i === 0 ? s : encodeURIComponent(s)).join("/")}`
            const w = p.startsWith("/") ? p : `/${p}`
            return `file://${w.split("/").map((s, i) => i === 0 ? s : encodeURIComponent(s)).join("/")}`
          }
          const items = group.map(m => ({ src: pathToSrc(m.media_saved_path) || m.media_url, type: m.msg_type === "videoMessage" ? "video" : "image", caption: m.body || "", msgId: m.id, filename: m.media_filename }))
          const idx = group.findIndex(m => m.id === msg.id)
          openMedia(items, idx >= 0 ? idx : 0)
          return
        }
      }
    }
    openMedia([{ src, type, caption: msg.body || "", msgId: msg.id, filename: msg.media_filename }], 0)
  }, [msgs, openMedia])

  useMediaPrefetch(jid)

  // ── Load messages + [F3] markRead on open ───────────────────────────────
  useEffect(() => {
    if (!jid) return
    prevJidRef.current = jid
    setReplyTo(null)
    offsetRef.current = 0
    setHasMore(true)
    setActiveJid(jid)
    setLoading(true)
    loadMessages(jid, 50, 0).then(loaded => {
      if (prevJidRef.current !== jid) return
      setLoading(false)
      const stored = useChatStore.getState().messages[normalizeJid(jid)] || []
      const count = stored.length || loaded?.length || 0
      offsetRef.current = count
      if (count < 50) setHasMore(false)
      loadReactions(jid)
      useChatStore.getState().loadChats?.()

      // [F3] markRead via Baileys setelah chat dibuka
      const allMsgs = useChatStore.getState().messages[normalizeJid(jid)] || []
      markChatRead(jid, allMsgs)
    }).catch(() => { if (prevJidRef.current === jid) setLoading(false) })
  }, [jid])

  // ── Event listeners ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!jid || !window.api) return
    const subs = []
    if (window.api.onMessagesNew) {
      subs.push(window.api.onMessagesNew(data => {
        if (!data?.chat_jid) return
        if (normalizeJid(data.chat_jid) !== normalizeJid(jid)) return
        if (data.is_history_sync) return
        const msgId = data.id; if (!msgId) return
        if (data.msg_type === "reactionMessage" && data.reaction_target_id) {
          useChatStore.getState().updateReactions(normalizeJid(jid), data.reaction_target_id, data.sender_jid || data.chat_jid || "", data.reaction_emoji || data.body || "")
          return
        }
        appendMessage(jid, {
          id: msgId, chat_jid: jid, body: data.body || "", msg_type: data.msg_type || "conversation",
          timestamp: data.timestamp || Math.floor(Date.now() / 1000), from_me: data.from_me ?? 0,
          status: data.status ?? 0, sender_name: data.sender_name || "", sender_jid: data.sender_jid || null,
          is_group: toInt(isGroup), has_media: data.has_media ?? 0, mimetype: data.mimetype || null,
          media_duration: data.media_duration || null, media_filename: data.media_filename || null,
          media_saved_path: data.media_saved_path || null, media_url: data.media_url || null,
          is_ptt: data.is_ptt ?? 0, is_gif: data.is_gif ?? 0, is_view_once: data.is_view_once ?? 0,
          is_animated: data.is_animated ?? 0, quoted_id: data.quoted_id || null, quoted_body: data.quoted_body || null,
          quoted_sender: data.quoted_sender || null, quoted_type: data.quoted_type || null,
          quoted_has_media: data.quoted_has_media ?? 0, is_forwarded: data.is_forwarded ?? 0, starred: data.starred ?? 0,
        })
        // [F3] Auto markRead untuk pesan masuk jika chat terbuka
        if (!data.from_me) {
          markChatRead(jid, [{ id: msgId, from_me: 0, status: 0 }])
        }
      }))
    }
    if (window.api.onChatsUpdated) subs.push(window.api.onChatsUpdated(() => refreshActiveChat()))
    if (window.api.onMediaUpdated) {
      subs.push(window.api.onMediaUpdated(data => {
        if (normalizeJid(data.chat_jid) !== normalizeJid(jid)) return
        useChatStore.getState().updateMessageMedia(data)
      }))
    }
    if (window.api.onMessagesReaction) {
      subs.push(window.api.onMessagesReaction(reactions => {
        for (const item of (reactions || [])) {
          const rd = item.reaction || item
          const targetId = rd.key?.id || item.key?.id
          const chatJid = rd.key?.remoteJid || item.key?.remoteJid || jid
          const emoji = rd.text || ""
          const sender = rd.key?.participant || rd.key?.remoteJid || ""
          if (!targetId) continue
          useChatStore.getState().updateReactions(normalizeJid(chatJid || jid), targetId, sender, emoji)
        }
      }))
    }
    return () => subs.forEach(fn => typeof fn === "function" && fn())
  }, [jid, isGroup])

  useEffect(() => {
    if (!jid) return
    const interval = setInterval(() => { if (!useChatStore.getState().messagesLoading) refreshActiveChat() }, 4000)
    return () => clearInterval(interval)
  }, [jid])

  // ── Auto-scroll ──────────────────────────────────────────────────────────
  const prevMsgCountRef = useRef(0)
  useEffect(() => {
    if (loading) return
    if (msgs.length > prevMsgCountRef.current) {
      const area = areaRef.current
      if (area) {
        const distFromBottom = area.scrollHeight - area.scrollTop - area.clientHeight
        if (distFromBottom < 200) setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 60)
        else setUnreadCount(prev => prev + (msgs.length - prevMsgCountRef.current))
      }
    }
    prevMsgCountRef.current = msgs.length
  }, [msgs.length, loading])

  useEffect(() => {
    if (!loading && msgs.length > 0) setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "auto" }), 80)
  }, [loading])

  // ── [F1] Group messages into render items ────────────────────────────────
  const renderItems = groupMessages(msgs)

  const scrollToMsg = useCallback(msgId => {
    if (!msgId) return
    const el = document.querySelector(`[data-msgid="${msgId}"]`)
    if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); setTimeout(() => el.dispatchEvent(new CustomEvent("msg-highlight")), 350) }
  }, [])

  const handleScroll = useCallback(async () => {
    const area = areaRef.current; if (!area) return
    const dist = area.scrollHeight - area.scrollTop - area.clientHeight
    setShowScrollBtn(dist > 300)
    if (dist < 50) {
      setUnreadCount(0)
      // [F3] markRead saat scroll ke bawah (semua pesan terlihat)
      const allMsgs = useChatStore.getState().messages[normalizeJid(jid)] || []
      markChatRead(jid, allMsgs)
    }
    if (!loadingMore && hasMore && !loading && area.scrollTop <= 120) {
      setLoadingMore(true)
      const currentOffset = offsetRef.current
      const LOAD_COUNT = 30
      const scrollHeightBefore = area.scrollHeight
      const older = await prependMessages(jid, LOAD_COUNT, currentOffset)
      offsetRef.current = currentOffset + older.length
      if (older.length < LOAD_COUNT) setHasMore(false)
      if (older.length > 0 && jid) { const { prefetchChat } = await import("../hooks/useMediaPrefetch"); prefetchChat(jid, LOAD_COUNT + 10, false) }
      requestAnimationFrame(() => { if (!area) return; area.scrollTop += (area.scrollHeight - scrollHeightBefore) })
      setLoadingMore(false)
    }
  }, [jid, loadingMore, hasMore, loading, prependMessages])

  return (
    <div className="chat-window">
      {/* Header */}
      <div className="chat-header">
        <Avatar jid={jid} name={name} />
        <div className="chat-header-info" style={{ cursor: "pointer" }} onClick={() => toggleRightPanel()}>
          <div className="chat-header-name">{name}</div>
          <div className="chat-header-status">
            {isGroup ? `${chat?.participant_count || "beberapa"} anggota` : "online"}
          </div>
        </div>
        <div className="chat-header-actions">
          <button className="header-btn" title="Cari"><SearchIcon /></button>
          <button className="header-btn" title="Telepon"><PhoneIcon /></button>
          <button className="header-btn" title="Lebih"><DotsIcon /></button>
        </div>
      </div>

      {/* Messages area */}
      <div className="msg-area" ref={areaRef} onScroll={handleScroll}>
        {loadingMore && (
          <div style={{ display: "flex", justifyContent: "center", padding: "8px 0" }}>
            <span className="spinner spinner-sm" style={{ borderTopColor: "var(--green)", borderColor: "rgba(37,211,102,.2)" }} />
          </div>
        )}
        {loading ? (
          Array.from({ length: 8 }).map((_, i) => <SkeletonBubble key={i} isMe={i % 3 === 0} />)
        ) : msgs.length === 0 ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 10, color: "var(--text-3)" }}>
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.3 }}>
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-2)" }}>Belum ada pesan</div>
            <div style={{ fontSize: 11 }}>Mulai percakapan di bawah</div>
          </div>
        ) : (
          renderItems.map(item => {
            if (item.type === "date") return <DateSep key={item.key} date={item.ts} />
            // [F1] Album render
            if (item.type === "album") {
              const first = item.msgs[0]
              return (
                <div key={item.key} data-msgid={first?.id}>
                  <AlbumBubbleWrapper
                    msgs={item.msgs}
                    isMe={toBool(first?.from_me)}
                    isGroup={toBool(first?.is_group)}
                    onMediaClick={handleMediaClick}
                    openMedia={openMedia}
                    onReply={setReplyTo}
                  />
                </div>
              )
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

      {/* Scroll to bottom FAB */}
      {showScrollBtn && (
        <button className="scroll-to-bottom-btn" style={{ bottom: scrollBtnBottom }} onClick={() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); setUnreadCount(0) }} title="Scroll ke pesan terbaru">
          {unreadCount > 0 && <span className="scroll-unread-badge">{unreadCount > 99 ? "99+" : unreadCount}</span>}
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14M5 12l7 7 7-7" />
          </svg>
        </button>
      )}

      {/* Input */}
      <div ref={inputAreaRef}>
        <MessageInput chatJid={jid} chatName={name} replyTo={replyTo} onCancelReply={() => setReplyTo(null)} />
      </div>
    </div>
  )
}
