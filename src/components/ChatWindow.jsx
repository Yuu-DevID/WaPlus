// src/components/ChatWindow.jsx — FIXED v4
// [F3] markRead saat buka chat — panggil Baileys sock.readMessages via IPC
// [F5] Perbaikan nama: kontak > pushName > nomor
// [F1] Album render — grouping konsekutif image/video dari sender yang sama
import { useEffect, useRef, useState, useCallback, useMemo, memo, startTransition, useDeferredValue } from "react"
import { useChatStore } from "../store/chat"
import { useAppStore } from "../store/app"
import { format, isToday, isYesterday } from "date-fns"
import MessageBubble, { AlbumBubbleWrapper } from "./MessageBubble"
import DevEvalModal from "./DevEvalModal"
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

    // [FIX-ALBUM] Build album group from consecutive image/video messages.
    // Previously required media_saved_path || media_url, which broke album detection
    // when autoDownloadMedia=false (nothing downloaded yet). Now we only require
    // msg_type to match — the album grid handles undownloaded items with download CTAs.
    if (ALBUM_TYPES.has(msg.msg_type) && !toBool(msg.is_view_once)) {
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

// Varied bubble sizes for realistic skeleton
const SKEL_SIZES = [
  { w: 200, h: 42 }, { w: 240, h: 38 }, { w: 160, h: 36 },
  { w: 280, h: 60 }, { w: 190, h: 38 }, { w: 220, h: 44 },
  { w: 150, h: 36 }, { w: 260, h: 38 },
]
function SkeletonBubble({ isMe, index = 0 }) {
  const sz = SKEL_SIZES[index % SKEL_SIZES.length]
  const r = isMe ? "16px 4px 16px 16px" : "4px 16px 16px 16px"
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: isMe ? "flex-end" : "flex-start", padding: "3px 14px" }}>
      {/* Avatar for non-me messages in groups */}
      {!isMe && index % 4 === 0 && (
        <div className="skel" style={{ width: 28, height: 9, borderRadius: 3, marginBottom: 4, marginLeft: 2 }} />
      )}
      <div className="skel" style={{ width: sz.w, height: sz.h, borderRadius: r }} />
      <div className="skel" style={{ width: 32, height: 8, borderRadius: 3, marginTop: 3, opacity: 0.6 }} />
    </div>
  )
}

// Header skeleton for when chat is switching
function SkeletonHeader() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px" }}>
      <div className="skel" style={{ width: 40, height: 40, borderRadius: "50%", flexShrink: 0 }} />
      <div style={{ flex: 1 }}>
        <div className="skel" style={{ width: "40%", height: 12, borderRadius: 4, marginBottom: 6 }} />
        <div className="skel" style={{ width: "25%", height: 9, borderRadius: 3 }} />
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════
// [PERF] WINDOWED MESSAGE LIST
// Renders only a window of renderItems to avoid "not responding" on
// large chats. Window moves as user scrolls.
// Threshold: >80 items → windowed. ≤80 → render all (no overhead).
// ════════════════════════════════════════════════════════════
const WINDOW_SIZE     = 60   // items rendered at once
const WINDOW_OVERSCAN = 15   // extra items above/below visible area

function useWindowedItems(renderItems, areaRef, loading) {
  // windowEnd tracks the last item index we show.
  // Starts at bottom (WINDOW_SIZE items from end) — matches initial scroll-to-bottom.
  const [windowEnd, setWindowEnd] = useState(() => Math.max(renderItems.length, WINDOW_SIZE))
  const prevLenRef = useRef(renderItems.length)

  // When new messages arrive (live), keep window anchored to bottom
  useEffect(() => {
    const prev = prevLenRef.current
    const cur  = renderItems.length
    if (cur > prev) {
      const area = areaRef.current
      const atBottom = !area || (area.scrollHeight - area.scrollTop - area.clientHeight < 250)
      if (atBottom) setWindowEnd(cur + WINDOW_OVERSCAN)
    }
    prevLenRef.current = cur
  }, [renderItems.length, areaRef])

  // On chat switch, reset window to bottom
  const prevItemsRef = useRef(renderItems)
  if (prevItemsRef.current !== renderItems) {
    prevItemsRef.current = renderItems
    // synchronous reset before render
    const newEnd = Math.max(renderItems.length, WINDOW_SIZE)
    if (windowEnd !== newEnd) {
      // Use setTimeout(0) to avoid setState-during-render warning
      setTimeout(() => setWindowEnd(newEnd), 0)
    }
  }

  const onScroll = useCallback(() => {
    const area = areaRef.current
    if (!area) return
    const { scrollTop, scrollHeight, clientHeight } = area
    const distFromBottom = scrollHeight - scrollTop - clientHeight
    const distFromTop    = scrollTop

    // Scroll up → expand window upward
    if (distFromTop < 200 && windowEnd > WINDOW_SIZE) {
      setWindowEnd(prev => Math.max(prev, renderItems.length))  // show all when near top
    }

    // Near bottom again → can shrink window back (keep bottom WINDOW_SIZE + overscan)
    if (distFromBottom < 100 && windowEnd > renderItems.length + WINDOW_OVERSCAN) {
      setWindowEnd(renderItems.length + WINDOW_OVERSCAN)
    }
  }, [areaRef, renderItems.length, windowEnd])

  const total      = renderItems.length
  const USE_WINDOW = total > WINDOW_SIZE * 1.5  // only virtualize for large lists
  const start      = USE_WINDOW ? Math.max(0, Math.min(windowEnd - WINDOW_SIZE, total - WINDOW_SIZE)) : 0
  const end        = USE_WINDOW ? Math.min(total, windowEnd + WINDOW_OVERSCAN) : total
  const slice      = renderItems.slice(start, end)
  const hasHidden  = start > 0

  return { slice, hasHidden, hiddenCount: start, onScroll, setWindowEnd }
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
  const [headerDevEvalOpen, setHeaderDevEvalOpen] = useState(false)
  const [headerDevEvalMsg,  setHeaderDevEvalMsg]  = useState(null)

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
    // Build album context — include all nearby image/video messages for gallery navigation.
    // [FIX-ALBUM] Don't require media_saved_path — undownloaded items show download CTA in viewer.
    const ALBUM_TYPES_SET = new Set(["imageMessage", "videoMessage"])
    const ALBUM_WIN = 90
    if (ALBUM_TYPES_SET.has(msg.msg_type)) {
      const clickedIdx = msgs.findIndex(m => m.id === msg.id)
      if (clickedIdx !== -1) {
        const refTs = msg.timestamp || 0
        const isFromAlbum = m =>
          ALBUM_TYPES_SET.has(m.msg_type) &&
          !toBool(m.is_view_once) &&
          m.from_me === msg.from_me &&
          Math.abs((m.timestamp || 0) - refTs) <= ALBUM_WIN
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
          const items = group.map(m => ({
            src: pathToSrc(m.media_saved_path) || m.media_url || null,
            type: m.msg_type === "videoMessage" ? "video" : "image",
            caption: m.body || "",
            msgId: m.id,
            filename: m.media_filename,
            thumbnailSrc: m.media_thumbnail_b64 || null,
          }))
          const idx = group.findIndex(m => m.id === msg.id)
          openMedia(items, idx >= 0 ? idx : 0)
          return
        }
      }
    }
    openMedia([{ src, type, caption: msg.body || "", msgId: msg.id, filename: msg.media_filename, thumbnailSrc: msg.media_thumbnail_b64 || null }], 0)
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
      // [PERF] startTransition: defer the loading→false flip so message list
      // rendering doesn't block the UI thread. User sees header/skeleton immediately,
      // then messages pop in without freezing input/scroll.
      startTransition(() => setLoading(false))
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
          timestamp: data.timestamp || Math.floor(Date.now() / 1000),
          // [FIX-FROM-ME] Explicitly cast to 0/1 — never undefined/null/true/false
          from_me: (data.from_me === true || data.from_me === 1) ? 1 : 0,
          status: data.status ?? 0,
          // [FIX-SENDER-NAME] Use resolved contact name from DB, not raw pushname
          sender_name: data.sender_name || null,
          sender_jid: data.sender_jid || null,
          is_group: toInt(isGroup), has_media: data.has_media ?? 0, mimetype: data.mimetype || null,
          media_duration: data.media_duration || null, media_filename: data.media_filename || null,
          media_saved_path: data.media_saved_path || null, media_url: data.media_url || null,
          media_thumbnail_b64: data.media_thumbnail_b64 || null,
          is_ptt: data.is_ptt ?? 0, is_gif: data.is_gif ?? 0, is_view_once: data.is_view_once ?? 0,
          is_animated: data.is_animated ?? 0, quoted_id: data.quoted_id || null, quoted_body: data.quoted_body || null,
          quoted_sender: data.quoted_sender || null, quoted_sender_name: data.quoted_sender_name || null,
          quoted_type: data.quoted_type || null,
          quoted_has_media: data.quoted_has_media ?? 0, is_forwarded: data.is_forwarded ?? 0, starred: data.starred ?? 0,
        })
        // [FIX-AUTO-SCROLL] Scroll to bottom on new messages
        // fromMe: always scroll (just sent), incoming: scroll only if near bottom
        setTimeout(() => {
          const area = areaRef.current
          if (!area) return
          const dist = area.scrollHeight - area.scrollTop - area.clientHeight
          const isFromMe = data.from_me === 1 || data.from_me === true
          if (isFromMe || dist < 300) {
            bottomRef.current?.scrollIntoView({ behavior: "smooth" })
            setUnreadCount(0)
          } else {
            setUnreadCount(prev => prev + 1)
          }
        }, 50)
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

  // [PERF] Reduced poll interval — 4s was too aggressive for low-end devices.
  // 8s is sufficient; live IPC events handle real-time updates.
  useEffect(() => {
    if (!jid) return
    const interval = setInterval(() => { if (!useChatStore.getState().messagesLoading) refreshActiveChat() }, 8000)
    return () => clearInterval(interval)
  }, [jid])

  // ── Auto-scroll ──────────────────────────────────────────────────────────
  // NOTE: Live message auto-scroll is handled inline in appendMessage callback above.
  // This effect handles: initial load, chat switch, and pagination edge cases.
  const prevMsgCountRef = useRef(0)
  useEffect(() => {
    if (loading) return
    // Only handles count increase from pagination/initial load — live messages
    // handled by the inline setTimeout in onMessagesNew callback
    prevMsgCountRef.current = msgs.length
  }, [msgs.length, loading])

  // [FIX-SCROLL] Scroll to bottom after chat load OR chat switch.
  // Problems fixed:
  //   1. 80ms timeout races layout for large chats → use rAF paint loop
  //   2. Already-cached chat (loading=false) switching → also scroll on jid change
  //   3. Was stuck on previous message position when re-opening a read chat
  const scrollJidRef = useRef(null)
  const scrollAfterLoad = useCallback(() => {
    let rafId, attempts = 0
    const MAX_ATTEMPTS = 12
    const tryScroll = () => {
      const area = areaRef.current
      if (area && area.scrollHeight > area.clientHeight + 10) {
        area.scrollTop = area.scrollHeight  // instant, no animation
      } else if (attempts++ < MAX_ATTEMPTS) {
        rafId = requestAnimationFrame(tryScroll)
      }
    }
    rafId = requestAnimationFrame(tryScroll)
    return () => cancelAnimationFrame(rafId)
  }, [])

  useEffect(() => {
    if (loading) return
    if (msgs.length === 0) return
    if (scrollJidRef.current === jid) return  // already scrolled for this jid
    scrollJidRef.current = jid
    // Also expand window to bottom
    setWindowEnd(renderItems.length + WINDOW_OVERSCAN)
    return scrollAfterLoad()
  }, [loading, jid, msgs.length > 0])  // eslint-disable-line

  // ── [F1] Group messages into render items ────────────────────────────────
  // [PERF] Memoize — groupMessages is O(n) and re-runs on every state update without this.
  const renderItemsImmediate = useMemo(() => groupMessages(msgs), [msgs])

  // [PERF] useDeferredValue — defers expensive renderItems recompute to idle time.
  // During chat switch, old renderItems stay visible (no blank flash) while new ones
  // compute in background. Eliminates the "not responding" jank on large chats.
  const renderItems = useDeferredValue(renderItemsImmediate)

  // [PERF] Windowed rendering — only render visible slice for large chats
  const { slice: windowedItems, hasHidden, hiddenCount, onScroll: windowScroll, setWindowEnd } = useWindowedItems(renderItems, areaRef, loading)

  const scrollToMsg = useCallback(msgId => {
    if (!msgId) return
    const el = document.querySelector(`[data-msgid="${msgId}"]`)
    if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); setTimeout(() => el.dispatchEvent(new CustomEvent("msg-highlight")), 350) }
  }, [])

  const handleScroll = useCallback(async () => {
    const area = areaRef.current; if (!area) return
    windowScroll()  // [PERF] update window position
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
          <button className="header-btn" title="Dev Eval" onClick={() => {
              // Open DevEval with last message in chat as context
              const msgs_ = useChatStore.getState().messages[normalizeJid(jid)] || []
              const last_ = msgs_[msgs_.length - 1] || null
              setHeaderDevEvalMsg(last_)
              setHeaderDevEvalOpen(true)
            }} style={{ position: "relative" }}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
              </svg>
            </button>
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
          Array.from({ length: 10 }).map((_, i) => <SkeletonBubble key={i} isMe={i % 3 === 0} index={i} />)
        ) : msgs.length === 0 ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 10, color: "var(--text-3)" }}>
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.3 }}>
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-2)" }}>Belum ada pesan</div>
            <div style={{ fontSize: 11 }}>Mulai percakapan di bawah</div>
          </div>
        ) : (
          <>
            {hasHidden && (
              <div style={{ textAlign: "center", padding: "6px 0", fontSize: 11, color: "var(--text-3)" }}>
                <span className="spinner spinner-sm" style={{ verticalAlign: "middle", marginRight: 5, borderTopColor: "var(--green)", borderColor: "rgba(37,211,102,.2)" }} />
                {hiddenCount} pesan di atas — scroll naik untuk memuat
              </div>
            )}
            {windowedItems.map(item => {
              if (item.type === "date") return <DateSep key={item.key} date={item.ts} />
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
            })}
          </>
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
      {headerDevEvalOpen && (
        // [FIX-2] Capture all pointer events at this layer so nothing leaks to the chat list behind
        <div
          style={{ position: "fixed", inset: 0, zIndex: 9999 }}
          onClick={e => e.stopPropagation()}
          onMouseDown={e => e.stopPropagation()}
          onPointerDown={e => e.stopPropagation()}
        >
          <DevEvalModal msg={headerDevEvalMsg} onClose={() => setHeaderDevEvalOpen(false)} />
        </div>
      )}
    </div>
  )
}
