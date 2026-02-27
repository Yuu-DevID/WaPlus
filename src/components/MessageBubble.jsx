// src/components/MessageBubble.jsx
// ═══════════════════════════════════════════════════════════════════════════
// PRODUCTION GRADE v3 — AuroraChat Message Bubble
//
// FIXES:
// [FIX-1] toBool() — SQLite 0/1 → boolean everywhere. {0 && <X/>} = "0" bug.
// [FIX-2] QuotedMsg sender — was showing raw JID "628xxx@s.whatsapp.net",
//         now shows clean display name (resolved upstream in chat.js store).
// [FIX-3] msg-row layout — ALL conditional renders use toBool().
//         No stray text nodes. msg-row flexbox alignment is clean.
// [FIX-4] Quoted bubble — added left accent bar + proper styling so it
//         doesn't visually break the bubble layout.
// [FIX-5] from_me detection — reliable, uses toBool(msg.from_me).
// ═══════════════════════════════════════════════════════════════════════════

import { format } from "date-fns"
import { useState } from "react"

// ════════════════════════════════════════════════════════════
// [FIX-1] toBool — normalize SQLite 0/1 → JS boolean
// CRITICAL: Never use {sqliteInt && <JSX/>} — renders "0" as text
// ════════════════════════════════════════════════════════════
const toBool = (v) => v === 1 || v === true

// ─── Media src resolver ───────────────────────────────────────────────────────
function getMediaSrc(msg) {
  if (msg.media_saved_path) {
    const p = msg.media_saved_path.replace(/\\/g, "/")
    return p.startsWith("file://") ? p : `file://${p}`
  }
  if (msg.media_url) return msg.media_url
  return null
}

// ─── Format phone number ──────────────────────────────────────────────────────
function fmtPhone(raw) {
  if (!raw) return "?"
  // Strip @domain if still present
  const n = raw.includes("@") ? raw.split("@")[0] : raw
  if (!/^\d{6,}$/.test(n)) return raw
  return `+${n}`
}

// ─── Tick indicators ──────────────────────────────────────────────────────────
function Ticks({ status }) {
  const s = Number(status)
  if (s === 0) return <span style={{ fontSize: 10, color: "var(--text-3)", marginLeft: 2 }}>⏱</span>
  if (s === 1) return <span className="tick-sent" style={{ marginLeft: 2 }}>✓</span>
  if (s === 2) return <span className="tick-sent" style={{ marginLeft: 2 }}>✓✓</span>
  return <span className="tick-read" style={{ marginLeft: 2 }}>✓✓</span>
}

function BubbleTime({ ts }) {
  if (!ts) return null
  return (
    <span className="bubble-time">
      {format(new Date(ts * 1000), "HH:mm")}
    </span>
  )
}

// ─── [FIX-2] Quoted/reply preview ────────────────────────────────────────────
// sender is now already resolved to display name by chat.js store
function QuotedMsg({ body, sender, type, hasMedia, mimetype }) {
  // Don't render if both sender and body are empty/null
  if (!sender && !body && !hasMedia) return null

  const mediaIcon = (() => {
    if (!hasMedia) return null
    if (mimetype?.startsWith("image")) return "🖼️ "
    if (mimetype?.startsWith("video")) return "🎬 "
    if (mimetype?.startsWith("audio")) return "🎵 "
    if (mimetype?.includes("pdf"))     return "📕 "
    return "📎 "
  })()

  // Resolve sender display: if still looks like a JID, strip it
  const displaySender = sender
    ? (sender.includes("@") ? fmtPhone(sender) : sender)
    : null

  return (
    <div className="quoted">
      {displaySender && (
        <div className="quoted-sender">{displaySender}</div>
      )}
      <div className="quoted-text">
        {mediaIcon}{body || (hasMedia ? "Pesan media" : "Pesan")}
      </div>
    </div>
  )
}

// ─── Reaction overlay ─────────────────────────────────────────────────────────
function ReactionOverlay({ reactions }) {
  if (!reactions?.length) return null
  const grouped = {}
  for (const r of reactions) grouped[r.text] = (grouped[r.text] || 0) + 1
  return (
    <div className="reaction-row">
      {Object.entries(grouped).map(([e, n]) => (
        <div key={e} className="reaction-chip">
          <span>{e}</span>
          {n > 1 && <span className="reaction-chip-count">{n}</span>}
        </div>
      ))}
    </div>
  )
}

// ─── Forward badge ────────────────────────────────────────────────────────────
function ForwardBadge({ score }) {
  if (!score) return null
  return (
    <div className="forward-badge">
      <span>↪</span>
      <span>{score >= 5 ? "Sering diteruskan" : "Diteruskan"}</span>
    </div>
  )
}

// ─── Image bubble ─────────────────────────────────────────────────────────────
function ImageBubble({ msg }) {
  const src = getMediaSrc(msg)
  const [err, setErr] = useState(false)

  if (!src || err) {
    return (
      <div className="media-img">
        <div className="media-img-thumb" style={{
          display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center",
          gap: 4, minHeight: 100,
        }}>
          <span style={{ fontSize: 38 }}>🖼️</span>
          <span style={{ fontSize: 10, color: "var(--text-3)" }}>
            {src ? "Gagal memuat" : "Mengunduh..."}
          </span>
        </div>
        {msg.body && <div className="media-caption">{msg.body}</div>}
      </div>
    )
  }

  return (
    <div className="media-img">
      <img
        src={src}
        alt={msg.body || "Foto"}
        onError={() => setErr(true)}
        style={{
          maxWidth: "100%", maxHeight: 300,
          borderRadius: 8, display: "block",
          objectFit: "cover", cursor: "pointer",
        }}
      />
      {msg.body && <div className="media-caption">{msg.body}</div>}
    </div>
  )
}

// ─── Video bubble ─────────────────────────────────────────────────────────────
function VideoBubble({ msg }) {
  const src = getMediaSrc(msg)
  const [err, setErr] = useState(false)
  const isGif = toBool(msg.is_gif)

  if (!src || err) {
    return (
      <div className="media-video">
        <div className="media-video-thumb">
          <div className="play-btn">{isGif ? "GIF" : "▶️"}</div>
          <span style={{ fontSize: 12, color: "var(--text-3)" }}>
            {msg.body || (isGif ? "GIF" : "Video")}
          </span>
        </div>
      </div>
    )
  }

  if (isGif) {
    return (
      <div className="media-img">
        <video
          src={src} autoPlay loop muted playsInline
          onError={() => setErr(true)}
          style={{ maxWidth: "100%", maxHeight: 280, borderRadius: 8, display: "block" }}
        />
        <div className="gif-badge">GIF</div>
        {msg.body && <div className="media-caption">{msg.body}</div>}
      </div>
    )
  }

  return (
    <div className="media-video">
      <video
        src={src} controls preload="metadata"
        onError={() => setErr(true)}
        style={{ maxWidth: "100%", maxHeight: 280, borderRadius: 8, display: "block" }}
      />
      {msg.body && <div className="media-caption">{msg.body}</div>}
    </div>
  )
}

// ─── Audio / PTT bubble ───────────────────────────────────────────────────────
function AudioBubble({ msg }) {
  const src = getMediaSrc(msg)
  const [playing, setPlaying] = useState(false)
  const isPtt = toBool(msg.is_ptt) || msg.msg_type === "pttMessage"
  const duration = msg.media_duration || msg.duration
  const fmt = s => s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "0:00"

  return (
    <div className="media-audio">
      <button className="audio-play-btn" onClick={() => setPlaying(!playing)}>
        {playing ? "⏸" : "▶"}
      </button>
      <div className="audio-track">
        <div className="audio-bar">
          <div className="audio-fill" style={{ width: playing ? "35%" : "0%", transition: "width .3s" }} />
        </div>
        <div className="audio-meta">
          <span className="audio-label">{isPtt ? "Pesan Suara" : "Audio"}</span>
          <span className="audio-dur">{fmt(duration)}</span>
        </div>
      </div>
    </div>
  )
}

// ─── Document bubble ──────────────────────────────────────────────────────────
const DOC_ICONS = {
  PDF: "📕", DOCX: "📘", DOC: "📘", XLSX: "📗", XLS: "📗",
  PPTX: "📙", PPT: "📙", ZIP: "🗜️", RAR: "🗜️", TXT: "📃",
  APK: "📱", MP4: "🎬", PNG: "🖼️", JPG: "🖼️", MP3: "🎵",
  OGG: "🎵", AAC: "🎵", CSV: "📊",
}

function DocBubble({ msg }) {
  const mimetype = msg.mimetype
  const filename = msg.media_filename || msg.body || "Dokumen"
  const ext = mimetype
    ? mimetype.split("/")[1]?.split(";")[0]?.toUpperCase()
    : "FILE"
  return (
    <div className="media-doc">
      <div className="doc-icon">{DOC_ICONS[ext] || "📄"}</div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="doc-name">{filename}</div>
        <div className="doc-ext">{ext || "FILE"}</div>
      </div>
    </div>
  )
}

// ─── Sticker bubble ───────────────────────────────────────────────────────────
function StickerBubble({ msg }) {
  const src = getMediaSrc(msg)
  const [err, setErr] = useState(false)

  if (!src || err) {
    return <div style={{ fontSize: 72, padding: 4, lineHeight: 1 }}>🎭</div>
  }
  return (
    <img
      src={src}
      alt="Stiker"
      onError={() => setErr(true)}
      style={{ width: 150, height: 150, objectFit: "contain", display: "block" }}
    />
  )
}

// ─── View once bubble ─────────────────────────────────────────────────────────
function ViewOnceBubble({ msg }) {
  const isVideo = msg.mimetype?.startsWith("video")
  return (
    <div className="viewonce-wrap">
      <div className="viewonce-eye">👁</div>
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
        <span style={{ fontSize: 20 }}>📊</span>
        <div>
          <div className="poll-title">{msg.body || "Polling"}</div>
          <div className="poll-sub">Pilih salah satu opsi</div>
        </div>
      </div>
      {opts.length > 0
        ? opts.map((o, i) => {
          const pct = total > 0 ? Math.round((o.votes || 0) / total * 100) : 0
          return (
            <div key={i} className="poll-option">
              <div className="poll-option-top">
                <span className="poll-option-name">{o.name || o}</span>
                <span className="poll-option-pct">{pct}%</span>
              </div>
              <div className="poll-bar">
                <div className="poll-bar-fill" style={{ width: `${pct}%` }} />
              </div>
            </div>
          )
        })
        : <div className="poll-sub">Buka di HP untuk melihat opsi</div>
      }
      {total > 0 && <div className="poll-total">{total} suara</div>}
    </div>
  )
}

// ─── Location bubble ──────────────────────────────────────────────────────────
function LocationBubble({ msg }) {
  const lat = msg.location_lat
  const lng = msg.location_lng
  const name = msg.location_name || msg.location_address || msg.body || "Lokasi"
  const isLive = msg.msg_type === "liveLocationMessage"
  const mapsUrl = (lat && lng) ? `https://www.google.com/maps?q=${lat},${lng}` : null

  return (
    <div
      className="media-location"
      onClick={() => mapsUrl && window.open(mapsUrl, "_blank")}
      style={{ cursor: mapsUrl ? "pointer" : "default" }}
    >
      <div className="location-map">
        {lat && lng ? (
          <img
            src={`https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=15&size=200x100&markers=${lat},${lng}`}
            alt="Peta"
            style={{ width: "100%", height: 80, objectFit: "cover", borderRadius: 6 }}
            onError={e => { e.target.style.display = "none" }}
          />
        ) : (
          <span style={{ fontSize: 32 }}>🗺️</span>
        )}
      </div>
      <div className="location-label">
        {isLive && <span style={{ fontSize: 10, color: "var(--accent)" }}>● LIVE  </span>}
        {name}
      </div>
      {lat && lng && (
        <div style={{ fontSize: 10, color: "var(--text-3)" }}>
          {lat.toFixed(5)}, {lng.toFixed(5)}
        </div>
      )}
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
        <div className="contact-icon">👤</div>
        <div>
          <div className="contact-name">{msg.body || "Kontak"}</div>
          <div className="contact-sub">Kontak WhatsApp</div>
        </div>
      </div>
    )
  }

  return (
    <div className="contact-msg-list">
      {contacts.map((c, i) => (
        <div key={i} className="contact-msg">
          <div className="contact-icon">👤</div>
          <div>
            <div className="contact-name">{c.displayName || "Kontak"}</div>
            <div className="contact-sub">
              {c.vcard?.match(/TEL[^:]*:([^\n]+)/)?.[1]?.trim() || "Kontak WhatsApp"}
            </div>
          </div>
        </div>
      ))}
      {isArray && contacts.length > 1 && (
        <div className="contact-count">{contacts.length} kontak</div>
      )}
    </div>
  )
}

// ─── Group invite bubble ──────────────────────────────────────────────────────
function GroupInviteBubble({ msg }) {
  return (
    <div className="invite-msg">
      <div className="invite-icon">👥</div>
      <div>
        <div className="invite-title">Undangan Grup</div>
        <div className="invite-sub">{msg.body || "Bergabung ke grup"}</div>
      </div>
    </div>
  )
}

// ─── Buttons/Interactive bubble ───────────────────────────────────────────────
function ButtonsBubble({ msg }) {
  return (
    <div className="buttons-bubble">
      <div className="bubble-text">{msg.body || ""}</div>
      <div className="buttons-hint">🔘 Pesan dengan tombol — buka di HP</div>
    </div>
  )
}

function InteractiveResponseBubble({ msg }) {
  return (
    <div className="bubble-text" style={{ fontStyle: "italic", color: "var(--text-2)" }}>
      ↩ {msg.body || "Memilih opsi"}
    </div>
  )
}

// ─── Commerce bubbles ─────────────────────────────────────────────────────────
function OrderBubble({ msg }) {
  return (
    <div className="media-doc">
      <div className="doc-icon">🛒</div>
      <div>
        <div className="doc-name">{msg.body || "Pesanan"}</div>
        <div className="doc-ext">Pesanan WhatsApp</div>
      </div>
    </div>
  )
}

function PaymentBubble({ msg }) {
  return (
    <div className="media-doc">
      <div className="doc-icon">💳</div>
      <div>
        <div className="doc-name">{msg.body || "Pembayaran"}</div>
        <div className="doc-ext">WhatsApp Pay</div>
      </div>
    </div>
  )
}

// ─── Call log bubble ─────────────────────────────────────────────────────────
function CallLogBubble({ msg }) {
  const isVideo = msg.body?.includes("Video") || msg.mimetype?.includes("video")
  return (
    <div className="call-log">
      <span>{isVideo ? "📹" : "📞"}</span>
      <span>{msg.body || (isVideo ? "Panggilan Video" : "Panggilan Suara")}</span>
    </div>
  )
}

function EventBubble({ msg }) {
  return (
    <div className="media-doc">
      <div className="doc-icon">📅</div>
      <div>
        <div className="doc-name">{msg.body || "Acara"}</div>
        <div className="doc-ext">Acara WhatsApp</div>
      </div>
    </div>
  )
}

function NewsletterBubble({ msg }) {
  return (
    <div className="invite-msg">
      <div className="invite-icon">📢</div>
      <div>
        <div className="invite-title">Undangan Newsletter</div>
        <div className="invite-sub">{msg.body || "Bergabung ke channel"}</div>
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════
// MAIN CONTENT RENDERER
// ════════════════════════════════════════════════════════════

function renderContent(msg) {
  const t = msg.msg_type || "conversation"

  // ViewOnce check — both type string and integer flag
  if (toBool(msg.is_view_once) || t === "viewOnceMessage" || t === "viewOnceMessageV2") {
    return <ViewOnceBubble msg={msg} />
  }

  switch (t) {
    case "conversation":
    case "extendedTextMessage":
      return <div className="bubble-text">{msg.body || ""}</div>

    case "imageMessage":    return <ImageBubble msg={msg} />
    case "videoMessage":    return <VideoBubble msg={msg} />
    case "audioMessage":
    case "pttMessage":      return <AudioBubble msg={msg} />
    case "documentMessage": return <DocBubble msg={msg} />
    case "stickerMessage":  return <StickerBubble msg={msg} />

    case "locationMessage":
    case "liveLocationMessage":
      return <LocationBubble msg={msg} />

    case "contactMessage":
    case "contactsArrayMessage":
      return <ContactBubble msg={msg} />

    case "pollCreationMessage":
      return <PollBubble msg={msg} />

    case "pollUpdateMessage":
      return (
        <div className="bubble-text" style={{ fontStyle: "italic", color: "var(--text-2)" }}>
          📊 Vote diperbarui
        </div>
      )

    case "reactionMessage":
      return (
        <div style={{ fontSize: 32, padding: "2px 4px", lineHeight: 1 }}>
          {msg.body || msg.reaction_emoji || "❤️"}
        </div>
      )

    case "groupInviteMessage":     return <GroupInviteBubble msg={msg} />

    case "buttonsMessage":
    case "listMessage":
    case "templateMessage":
    case "interactiveMessage":
      return <ButtonsBubble msg={msg} />

    case "buttonsResponseMessage":
    case "listResponseMessage":
    case "templateButtonReplyMessage":
    case "interactiveResponseMessage":
      return <InteractiveResponseBubble msg={msg} />

    case "orderMessage":           return <OrderBubble msg={msg} />

    case "productMessage":
      return (
        <div className="media-doc">
          <div className="doc-icon">🛍️</div>
          <div>
            <div className="doc-name">{msg.body || "Produk"}</div>
            <div className="doc-ext">Produk WhatsApp</div>
          </div>
        </div>
      )

    case "paymentMessage":
    case "requestPaymentMessage":
    case "sendPaymentMessage":
      return <PaymentBubble msg={msg} />

    case "callLogMessage":              return <CallLogBubble msg={msg} />
    case "eventMessage":                return <EventBubble msg={msg} />
    case "newsletterAdminInviteMessage": return <NewsletterBubble msg={msg} />

    // System messages — render nothing, parent will skip
    case "protocol":
    case "ephemeral":
    case "messageContextInfo":
    case "unknown":
      return null

    default: {
      if (msg.body) return <div className="bubble-text">{msg.body}</div>
      const LABELS = {
        call: "📞 Panggilan", payment: "💳 Pembayaran",
        order: "🛒 Pesanan", product: "🛍 Produk",
        event: "📅 Acara", buttons: "🔘 Tombol",
        list: "📋 Daftar", interactive: "💬 Interaktif",
        keepInChat: "📌 Disimpan", pinInChat: "📌 Disematkan",
      }
      return <div className="bubble-unsupported">{LABELS[t] || `📎 ${t}`}</div>
    }
  }
}

// ════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ════════════════════════════════════════════════════════════

export default function MessageBubble({ msg }) {
  // ── [FIX-1+FIX-5] Normalize ALL SQLite integer booleans ──────────────────
  const isMe        = toBool(msg.from_me)
  const isGroup     = toBool(msg.is_group)
  const isForwarded = toBool(msg.is_forwarded)

  const t          = msg.msg_type || "conversation"
  const isReaction = t === "reactionMessage"
  const isSticker  = t === "stickerMessage"

  // No-padding types (media rendered flush to bubble edge)
  const NO_PAD_TYPES = new Set([
    "imageMessage", "videoMessage", "stickerMessage",
    "viewOnceMessage", "viewOnceMessageV2",
  ])
  const hasNoPad = NO_PAD_TYPES.has(t)

  const bubbleClass = [
    "bubble",
    isMe ? "me" : null,
    (isReaction || isSticker) ? "sticker" : null,
    hasNoPad ? "no-pad" : null,
  ].filter(Boolean).join(" ")

  const content = renderContent(msg)

  // System messages render nothing
  if (content === null) return null

  // [FIX-4] Quoted message — check all possible fields
  const hasQuoted = !!(msg.quoted_id || msg.quoted_body || msg.quoted_sender)

  // [FIX-3] Null-safe sender initial
  const senderInitial = (msg.sender_name || msg.sender_jid || "?")[0].toUpperCase()

  // ── [FIX-3] LAYOUT: msg-row structure ────────────────────────────────────
  // Structure:
  //   .msg-row.me   → flex-end, my messages on right
  //   .msg-row.them → flex-start, their messages on left
  //
  //   Inside .msg-inner:
  //     [mini-avatar] [bubble-wrap > .bubble]
  //
  // CRITICAL: No text nodes should ever appear between .msg-row children.
  // All conditionals MUST use toBool() so 0 stays 0, not "0".

  return (
    <div className={"msg-row" + (isMe ? " me" : " them")}>

      {/* Sender name — group chats only, opponent only */}
      {/* [FIX-3] was: {!isMe && msg.is_group && ...} → "0" text node */}
      {!isMe && isGroup && msg.sender_name && (
        <div className="msg-sender-name">{msg.sender_name}</div>
      )}

      {/* Inner row: [avatar?] [bubble] */}
      <div className={"msg-inner" + (isMe ? " me" : "")}>

        {/* Group mini-avatar — opponent only */}
        {/* [FIX-3] was: {msg.is_group && <div>} → rendered "0" */}
        {!isMe && isGroup && (
          <div className="msg-mini-avatar" style={{ background: "#1565c0", flexShrink: 0 }}>
            {senderInitial}
          </div>
        )}

        {/* Bubble wrapper */}
        <div className="bubble-wrap">
          <div className={bubbleClass}>

            {/* Forward indicator */}
            {isForwarded && <ForwardBadge score={msg.forwarding_score} />}

            {/* [FIX-2+FIX-4] Quoted/reply preview */}
            {hasQuoted && (
              <QuotedMsg
                body={msg.quoted_body}
                sender={msg.quoted_sender}
                type={msg.quoted_type}
                hasMedia={toBool(msg.quoted_has_media)}
                mimetype={msg.quoted_mimetype}
              />
            )}

            {/* Main message content */}
            {content}

            {/* Footer: timestamp + delivery ticks */}
            {!isReaction && !isSticker && (
              <div className={"bubble-footer" + (isMe ? " me" : "")}>
                <BubbleTime ts={msg.timestamp} />
                {isMe && <Ticks status={msg.status} />}
              </div>
            )}
          </div>

          {/* Emoji reactions overlay */}
          {msg.reactions && <ReactionOverlay reactions={msg.reactions} />}
        </div>
      </div>
    </div>
  )
}