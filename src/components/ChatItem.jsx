import { useState, useEffect } from "react"
import { format, isToday, isYesterday } from "date-fns"

const COLORS = ["#1a5c3e", "#1565c0", "#6a1b9a", "#b71c1c", "#e65100", "#2e7d32", "#00695c", "#4527a0", "#00838f", "#ad1457", "#0277bd", "#37474f"]
function getColor(s) { if (!s) return COLORS[0]; let h = 0; for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h); return COLORS[Math.abs(h) % COLORS.length] }
function initials(n) { if (!n) return "?"; return n.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join("").toUpperCase() }

const picCache = new Map()
const fetching = new Set()

function Avatar({ jid, name, size = 46, isGroup, isCommunity }) {
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
    <div className="chat-avatar" style={{ width: size, height: size, background: getColor(jid || name) }}>
      {url && !err && <img src={url} alt={name} onError={() => setErr(true)} />}
      {(!url || err) && initials(name)}
      {isGroup && <div className="chat-avatar-group-badge">{isCommunity ? "🏘️" : "👥"}</div>}
    </div>
  )
}

function formatTime(ts) {
  if (!ts) return ""
  const d = new Date(ts * 1000)
  if (isToday(d)) return format(d, "HH:mm")
  if (isYesterday(d)) return "Kemarin"
  return format(d, "dd/MM/yy")
}

const PREVIEWS = {
  imageMessage: "📷 Foto", videoMessage: "🎬 Video", audioMessage: "🎵 Audio",
  pttMessage: "🎤 Pesan Suara", documentMessage: "📄 Dokumen", stickerMessage: "🎭 Stiker",
  locationMessage: "📍 Lokasi", pollCreationMessage: "📊 Polling", reactionMessage: "😊 Reaksi",
  viewOnceMessage: "👁 Sekali Lihat", viewOnceMessageV2: "👁 Sekali Lihat",
  liveLocationMessage: "📍 Lokasi Live", contactMessage: "👤 Kontak",
  groupInviteMessage: "👥 Undangan Grup",
}

export default function ChatItem({ chat, active, onClick, isContact, isCommunity }) {
  const name = chat.name || chat.phone || (chat.jid || "").split("@")[0] || "Unknown"
  const isGroup = chat.is_group || (chat.jid || "").endsWith("@g.us")
  const hasUnread = !isContact && !isCommunity && chat.unread_count > 0
  const isMuted = chat.muted_until > Date.now() / 1000
  const t = chat.last_msg_type
  const preview = (isContact || isCommunity)
    ? (chat.phone || (chat.jid || "").split("@")[0] || (isCommunity ? "Komunitas" : ""))
    : ((!t || t === "conversation" || t === "extendedTextMessage") ? (chat.last_msg || "") : (PREVIEWS[t] || "📎 Media"))

  return (
    <div className={"chat-item" + (active ? " active" : "")} onClick={onClick}>
      <Avatar jid={chat.jid} name={name} isGroup={isGroup} />
      <div className="chat-meta">
        <div className="chat-top">
          <span className="chat-name">
            {name}
            {isMuted && <span style={{ fontSize: 10, marginLeft: 4 }}>🔕</span>}
            {chat.pinned && !isContact && <span style={{ fontSize: 10, marginLeft: 4 }}>📌</span>}
          </span>
          <span className={"chat-time" + (hasUnread ? " unread" : "")}>
            {!isContact && formatTime(chat.last_msg_at)}
          </span>
        </div>
        <div className="chat-preview-row">
          <span className={"chat-preview" + (hasUnread ? " unread" : "")}>
            {isGroup && !isContact && chat.last_sender_name && (
              <b style={{ color: "var(--green)", fontWeight: 600, marginRight: 3 }}>
                {chat.last_sender_name.split(" ")[0]}:
              </b>
            )}
            {chat.from_me === 1 && !isContact && <span style={{ color: "var(--text-3)", fontSize: 11 }}>Kamu: </span>}
            {preview}
          </span>
          {hasUnread && (
            <div className={"unread-badge" + (isMuted ? " muted" : "")}>
              {chat.unread_count > 99 ? "99+" : chat.unread_count}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
