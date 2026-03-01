// src/components/ChatItem.jsx
// ═══════════════════════════════════════════════════════════════════════════
// PRODUCTION GRADE v4 — AuroraChat Chat List Item
//
// FIXES v4:
// [FIX-1]  Name rendering — chat.name is already resolved by store's
//          normalizeChat(). No raw JID should ever reach the DOM here.
//          Final guard: if name still looks like a JID, format as phone.
// [FIX-2]  last_msg preview — show last message body, fallback to type label,
//          fallback to "Tap to open". Show sender prefix for groups.
// [FIX-3]  Unread badge — shows count, muted indicator, and delivery ticks.
// [FIX-4]  Avatar — color seeded from JID (not name) for stability. Shows
//          proper initials — NOT "+6" from "+628xxx" prefix.
// [FIX-5]  Timestamp format — today: "HH:mm", yesterday: "Kemarin",
//          older: "dd/MM/yyyy".
// [FIX-6]  Group icon on avatar for group chats.
// ═══════════════════════════════════════════════════════════════════════════

import { useState, useEffect, useRef, memo } from "react"
import { format, isToday, isYesterday } from "date-fns"

// ─── Colors for avatar background ────────────────────────────────────────────
const AVATAR_COLORS = [
  "#1a5c3e", "#1565c0", "#6a1b9a", "#b71c1c",
  "#e65100", "#2e7d32", "#00695c", "#4527a0",
  "#00838f", "#ad1457", "#0277bd", "#4a148c",
]

function seedColor(s) {
  if (!s) return AVATAR_COLORS[0]
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = s.charCodeAt(i) + ((h << 5) - h)
  }
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length]
}

// [FIX-4] Build initials from DISPLAY NAME — never from JID
// "Budi Santoso"   → "BS"
// "+6285770017326" → "73"  (last 2 digits — lebih unik tiap kontak)
// "Grup Keluarga"  → "GK"
function buildInitials(name) {
  if (!name) return "?"
  // Jika nama adalah nomor telepon → pakai 2 digit terakhir
  const stripped = name.replace(/[\s\-+().]/g, "")
  if (/^\d{6,}$/.test(stripped)) {
    return stripped.slice(-2)
  }
  const words = name.trim().split(/\s+/)
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

// [FIX-5] Format timestamp for chat list
function formatTs(ts) {
  if (!ts) return ""
  const d = new Date(ts * 1000)
  if (isToday(d))     return format(d, "HH:mm")
  if (isYesterday(d)) return "Kemarin"
  return format(d, "dd/MM/yy")
}

// ─── Avatar with profile pic cache ───────────────────────────────────────────
const picCache = new Map()
const fetching = new Set()

const ChatAvatar = memo(function ChatAvatar({ jid, name, isGroup, isChannel, size = 46 }) {
  // [FIX-AVATAR] Use picCache as source of truth. picCache stores:
  //   undefined = never fetched
  //   null      = fetched, no pic (show initials)
  //   string    = fetched, has URL (show image)
  const [url, setUrl] = useState(() => {
    if (picCache.has(jid)) return picCache.get(jid)
    return undefined  // undefined = not yet fetched
  })
  const [err, setErr] = useState(false)

  useEffect(() => {
    if (!jid) return
    // Already in cache (including null = confirmed no pic)
    if (picCache.has(jid)) {
      const cached = picCache.get(jid)
      if (cached !== url) setUrl(cached)
      return
    }
    if (fetching.has(jid)) return
    fetching.add(jid)
    window.api?.getProfilePic?.({ jid })
      .then(r => {
        const u = r?.url || null
        picCache.set(jid, u)
        setUrl(u)
      })
      .catch(() => {
        picCache.set(jid, null)
        setUrl(null)
      })
      .finally(() => fetching.delete(jid))
  }, [jid])

  // Reset err when url changes (new pic fetched)
  useEffect(() => { setErr(false) }, [url])

  const initials = buildInitials(name)
  const color    = seedColor(jid)  // Seed from JID, not name, for stability

  return (
    <div
      className="chat-item-avatar"
      style={{
        width:           size,
        height:          size,
        minWidth:        size,
        borderRadius:    "50%",
        background:      url && !err ? "transparent" : color,
        display:         "flex",
        alignItems:      "center",
        justifyContent:  "center",
        overflow:        "hidden",
        fontSize:        Math.round(size * 0.35),
        fontWeight:      700,
        color:           "#fff",
        position:        "relative",
        flexShrink:      0,
        userSelect:      "none",
      }}
    >
      {url && !err ? (
        <img
          src={url}
          alt={name}
          onError={() => setErr(true)}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        initials
      )}
      {/* [FIX-6] Group / Channel badge */}
      {(isGroup || isChannel) && !url && (
        <div style={{
          position: "absolute", bottom: -1, right: -1,
          width: 16, height: 16, borderRadius: "50%",
          background: "var(--bg-2, #1a1a1a)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 9,
        }}>
          {isChannel ? "📢" : "👥"}
        </div>
      )}
    </div>
  )
})

// ─── Delivery tick ────────────────────────────────────────────────────────────
function MiniTick({ status, fromMe }) {
  if (!fromMe) return null
  const s = Number(status)
  if (s === 0) return <span style={{ fontSize: 9, color: "var(--text-3, #888)", marginRight: 2 }}>⏱</span>
  if (s === 1) return <span style={{ fontSize: 10, color: "var(--text-3, #888)", marginRight: 2 }}>✓</span>
  if (s === 2) return <span style={{ fontSize: 10, color: "var(--text-3, #888)", marginRight: 2 }}>✓✓</span>
  return <span style={{ fontSize: 10, color: "#4caf93", marginRight: 2 }}>✓✓</span>
}

// ─── Message preview text ─────────────────────────────────────────────────────
// [FIX-2] Show: "[Foto]", "[Video]", etc. for media types
// In groups: "Budi: Hello there"
function PreviewText({ chat }) {
  const preview = chat.last_msg || ""
  const isGroup = !!(chat.is_group)
  // [FIX-LID] Never show raw JID or @lid in sender prefix
  const safeSenderName = (() => {
    const n = chat.last_sender_name
    if (!n) return null
    if (!n.includes("@")) return n
    // It's a JID — extract phone
    const u = n.split("@")[0].split(":")[0]
    return /^\d{6,}$/.test(u) ? `+${u}` : u || null
  })()
  const senderPrefix = isGroup && safeSenderName && !Number(chat.from_me)
    ? `${safeSenderName}: `
    : (Number(chat.from_me) ? "Kamu: " : "")

  if (!preview) {
    return (
      <span style={{ color: "var(--text-3, #666)", fontStyle: "italic", fontSize: 12 }}>
        Ketuk untuk membuka
      </span>
    )
  }

  return (
    <span className="chat-item-preview" style={{ fontSize: 12 }}>
      {senderPrefix && (
        <span style={{ color: "var(--text-2, #aaa)", fontWeight: 500 }}>
          {senderPrefix}
        </span>
      )}
      {preview}
    </span>
  )
}

// ════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ════════════════════════════════════════════════════════════

const ChatItem = memo(function ChatItem({ chat, isActive, onClick, observe, unobserve }) {
  const jid     = chat.jid     || ""
  const isGroup = !!(chat.is_group)
  const isMuted = chat.muted_until > (Date.now() / 1000)

  // [PREFETCH] Register this DOM node with the parent's IntersectionObserver
  const itemRef = useRef(null)
  useEffect(() => {
    const el = itemRef.current
    if (!el || !observe) return
    observe(el)
    return () => unobserve?.(el)
  }, [jid, observe, unobserve])

  // ── Display name resolution ─────────────────────────────────────────────
  // Never show raw @lid / @s.whatsapp.net JIDs. Priority:
  //   Groups  : chat.name (subject) > chat.subject > "Grup"
  //   @lid DM : chat.name (DB resolved push_name) > last_sender_name > push_name > +number
  //   DM      : chat.name (phonebook/push_name) > +number from JID
  const atIdx     = jid.lastIndexOf("@")
  const server    = atIdx !== -1 ? jid.slice(atIdx + 1) : ""
  const user      = atIdx !== -1 ? jid.slice(0, atIdx) : jid
  const cleanUser = user.split(":")[0]
  const isLidJid  = server === "lid"
  const isChannel = server === "newsletter"

  let displayName = ""

  if (isChannel) {
    // Newsletter/channel
    displayName = chat.name || chat.subject || "Saluran"
    if (displayName.includes("@")) displayName = "Saluran"
  } else if (isGroup || server === "g.us") {
    // GROUP — name = group subject
    displayName = chat.name || chat.subject || "Grup"
    if (displayName.includes("@")) displayName = "Grup"

  } else if (isLidJid) {
    // @LID DM — DB should have resolved push_name but try every fallback
    const candidateName = chat.name || chat.last_sender_name || chat.push_name || ""
    displayName = (candidateName && !candidateName.includes("@"))
      ? candidateName
      : (/^\d{6,}$/.test(cleanUser) ? `~${cleanUser.slice(-8)}` : cleanUser || "Unknown")

  } else {
    // Regular DM — phonebook name or format number
    const candidateName = chat.name || ""
    displayName = (candidateName && !candidateName.includes("@"))
      ? candidateName
      : (/^\d{6,}$/.test(cleanUser) ? `+${cleanUser}` : cleanUser || "Unknown")
  }

  const unread  = Number(chat.unread_count) || 0
  const ts      = chat.last_msg_at || chat.last_message_timestamp || 0

  return (
    <div
      ref={itemRef}
      data-jid={jid}
      className={`chat-item${isActive ? " active" : ""}`}
      onClick={() => onClick?.(jid)}
      style={{
        display:        "flex",
        alignItems:     "center",
        gap:            10,
        padding:        "10px 14px",
        cursor:         "pointer",
        borderRadius:   6,
        background:     isActive ? "var(--accent-bg, rgba(0,180,90,0.12))" : "transparent",
        transition:     "background 0.12s",
        position:       "relative",
        minWidth:       0,
      }}
      onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = "var(--hover-bg, rgba(255,255,255,0.05))" }}
      onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = "transparent" }}
    >
      {/* Avatar */}
      <ChatAvatar jid={jid} name={displayName} isGroup={isGroup} isChannel={isChannel} />

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>

        {/* Top row: name + timestamp */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 4 }}>
          <span
            className="chat-item-name"
            style={{
              fontWeight:   600,
              fontSize:     14,
              color:        "var(--text-1, #e8e8e8)",
              whiteSpace:   "nowrap",
              overflow:     "hidden",
              textOverflow: "ellipsis",
              flex:         1,
              minWidth:     0,
              display:      "flex",
              alignItems:   "center",
              gap:          5,
            }}
          >
            {displayName}
            {/* [F4] Newsletter/channel badge */}
            {isChannel && (
              <span className="channel-badge">
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M10.34 15.84c-.688-.06-1.386-.09-2.09-.09H7.5a4.5 4.5 0 1 1 0-9h.75c.704 0 1.402-.03 2.09-.09m0 9.18c.253.962.584 1.892.985 2.783M10.34 6.66a23.847 23.847 0 0 1 8.835-2.535m0 0A23.74 23.74 0 0 1 18.795 3"/></svg>
                Saluran
              </span>
            )}
          </span>
          <span
            style={{
              fontSize:   11,
              color:      unread > 0 && !isMuted
                ? "var(--accent, #00b45a)"
                : "var(--text-3, #666)",
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            {formatTs(ts)}
          </span>
        </div>

        {/* Bottom row: preview + badges */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 4 }}>
          <div
            style={{
              flex:         1,
              minWidth:     0,
              display:      "flex",
              alignItems:   "center",
              whiteSpace:   "nowrap",
              overflow:     "hidden",
              textOverflow: "ellipsis",
              color:        "var(--text-2, #999)",
            }}
          >
            <MiniTick status={chat.last_msg_status} fromMe={Number(chat.from_me)} />
            <PreviewText chat={chat} />
          </div>

          {/* Badges */}
          <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
            {/* Pinned indicator */}
            {chat.pinned > 0 && unread === 0 && (
              <span style={{ fontSize: 11, color: "var(--text-3, #666)" }}>📌</span>
            )}
            {/* Muted indicator */}
            {isMuted && unread === 0 && (
              <span style={{ fontSize: 11, color: "var(--text-3, #666)" }}>🔇</span>
            )}
            {/* Unread count badge */}
            {unread > 0 && (
              <div
                className="unread-badge"
                style={{
                  minWidth:       18,
                  height:         18,
                  borderRadius:   9,
                  background:     isMuted
                    ? "var(--text-3, #666)"
                    : "var(--accent, #00b45a)",
                  color:          "#fff",
                  fontSize:       11,
                  fontWeight:     700,
                  display:        "flex",
                  alignItems:     "center",
                  justifyContent: "center",
                  padding:        "0 4px",
                }}
              >
                {unread > 99 ? "99+" : unread}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
})

export default ChatItem