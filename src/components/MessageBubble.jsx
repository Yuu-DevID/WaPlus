// src/components/MessageBubble.jsx
// Mendukung semua jenis pesan WhatsApp
import { format } from "date-fns"
import { useState } from "react"

// ── Tick status ─────────────────────────────────────────────
function Ticks({ status }) {
  const s = Number(status)
  if (s === 0) return <span className="tick-pending">⏱</span>
  if (s === 1) return <span className="tick-sent">✓</span>
  if (s === 2) return <span className="tick-sent">✓✓</span>
  return <span className="tick-read">✓✓</span>
}

// ── Timestamp ───────────────────────────────────────────────
function BubbleTime({ ts }) {
  if (!ts) return null
  return <span className="bubble-time">{format(new Date(ts * 1000), "HH:mm")}</span>
}

// ── Quoted message ──────────────────────────────────────────
function QuotedMsg({ body, sender, type }) {
  if (!body && !sender) return null
  const icons = {
    imageMessage: "🖼️", videoMessage: "🎬", audioMessage: "🎵",
    pttMessage: "🎤", documentMessage: "📄", stickerMessage: "🎭",
    locationMessage: "📍", contactMessage: "👤", pollCreationMessage: "📊",
  }
  const icon = icons[type] || ""
  return (
    <div className="quoted">
      {sender && <div className="quoted-sender">{sender}</div>}
      <div className="quoted-text">{icon} {body || "Pesan"}</div>
    </div>
  )
}

// ── Reactions overlay ────────────────────────────────────────
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

// ── Audio / PTT ─────────────────────────────────────────────
function AudioBubble({ isPtt, duration, localPath }) {
  const [playing, setPlaying] = useState(false)
  const fmt = s => s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "0:00"
  return (
    <div className="media-audio">
      <div className="audio-avatar">
        {isPtt ? "🎤" : "🎵"}
      </div>
      <div className="audio-content">
        <button className="audio-play-btn" onClick={() => setPlaying(!playing)} title={playing ? "Pause" : "Play"}>
          {playing ? "⏸" : "▶"}
        </button>
        <div className="audio-track">
          <div className="audio-bar">
            <div className="audio-fill" style={{ width: playing ? "35%" : "0%", transition: "width .3s" }} />
          </div>
        </div>
        <div className="audio-meta">
          <span className="audio-label">{isPtt ? "Pesan Suara" : "Audio"}</span>
          <span className="audio-dur">{fmt(duration)}</span>
        </div>
      </div>
    </div>
  )
}

// ── Document ─────────────────────────────────────────────────
const DOC_ICONS = {
  PDF: "📕", DOCX: "📘", DOC: "📘", XLSX: "📗", XLS: "📗", PPTX: "📙", PPT: "📙",
  ZIP: "🗜️", RAR: "🗜️", TXT: "📃", APK: "📱", MP4: "🎬", PNG: "🖼️", JPG: "🖼️",
  JPEG: "🖼️", GIF: "🖼️", CSV: "📊", JSON: "📋", HTML: "🌐", JS: "⚡"
}

function DocBubble({ body, mimetype, filename, size }) {
  const ext = filename
    ? filename.split(".").pop()?.toUpperCase() || "FILE"
    : (mimetype ? mimetype.split("/")[1]?.split(";")[0]?.toUpperCase() : "FILE") || "FILE"
  const icon = DOC_ICONS[ext] || "📄"
  const sizeLabel = size ? (size > 1024 * 1024
    ? `${(size / 1024 / 1024).toFixed(1)} MB`
    : `${(size / 1024).toFixed(0)} KB`) : ""

  return (
    <div className="media-doc">
      <div className="doc-icon">{icon}</div>
      <div className="doc-info">
        <div className="doc-name">{filename || body || "Dokumen"}</div>
        <div className="doc-meta">{ext}{sizeLabel ? ` · ${sizeLabel}` : ""}</div>
      </div>
      <div className="doc-download-btn" title="Unduh">⬇</div>
    </div>
  )
}

// ── Image ────────────────────────────────────────────────────
function ImageBubble({ body, localPath, width, height }) {
  const [expanded, setExpanded] = useState(false)
  const aspectRatio = (width && height) ? width / height : 1
  const maxW = Math.min(300, 280)
  const h = Math.min(Math.round(maxW / aspectRatio), 260)

  if (localPath) {
    return (
      <div className="media-img-wrap">
        <img
          src={`file://${localPath}`}
          alt={body || "Foto"}
          className="media-img-real"
          style={{ maxWidth: maxW, maxHeight: 300, cursor: "pointer" }}
          onClick={() => setExpanded(true)}
          loading="lazy"
        />
        {body && <div className="media-caption">{body}</div>}
        {expanded && (
          <div className="lightbox" onClick={() => setExpanded(false)}>
            <img src={`file://${localPath}`} alt={body} className="lightbox-img" />
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="media-img">
      <div className="media-img-thumb" style={{ width: maxW, height: h }}>
        <div className="media-img-placeholder">
          <span style={{ fontSize: 32 }}>🖼️</span>
          <span className="media-status-label">Foto</span>
        </div>
      </div>
      {body && <div className="media-caption">{body}</div>}
    </div>
  )
}

// ── Video ─────────────────────────────────────────────────────
function VideoBubble({ body, duration, localPath, width, height }) {
  const fmt = s => s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : ""

  if (localPath) {
    return (
      <div className="media-video">
        <video
          src={`file://${localPath}`}
          controls
          className="media-video-player"
          style={{ maxWidth: 300, maxHeight: 220 }}
        />
        {body && <div className="media-caption">{body}</div>}
      </div>
    )
  }

  return (
    <div className="media-video">
      <div className="media-video-thumb">
        <div className="play-btn">▶️</div>
        {duration && <div className="video-dur">{fmt(duration)}</div>}
      </div>
      {body && <div className="media-caption">{body}</div>}
    </div>
  )
}

// ── Sticker ──────────────────────────────────────────────────
function StickerBubble({ localPath }) {
  if (localPath) {
    return <img src={`file://${localPath}`} alt="Stiker" className="sticker-img" loading="lazy" />
  }
  return <div className="sticker-placeholder">🎭</div>
}

// ── Poll ─────────────────────────────────────────────────────
function PollBubble({ body, pollOptions, pollVotes }) {
  let opts = []
  try { opts = pollOptions ? JSON.parse(pollOptions) : [] } catch (_) {}

  let votes = {}
  try { votes = pollVotes ? JSON.parse(pollVotes) : {} } catch (_) {}

  const total = opts.reduce((s, o) => s + (votes[o.name] || o.votes || 0), 0)

  return (
    <div className="poll-wrap">
      <div className="poll-header">
        <span className="poll-icon">📊</span>
        <div>
          <div className="poll-title">{body || "Polling"}</div>
          <div className="poll-sub">{total > 0 ? `${total} suara` : "Pilih opsi"}</div>
        </div>
      </div>
      {opts.length > 0 ? opts.map((o, i) => {
        const v = votes[o.name] || o.votes || 0
        const pct = total > 0 ? Math.round(v / total * 100) : 0
        return (
          <div key={i} className="poll-option">
            <div className="poll-option-top">
              <span className="poll-option-name">{o.name || o}</span>
              <span className="poll-option-pct">{pct}%</span>
            </div>
            <div className="poll-bar"><div className="poll-bar-fill" style={{ width: `${pct}%` }} /></div>
          </div>
        )
      }) : <div className="poll-sub">Buka di HP untuk melihat opsi</div>}
    </div>
  )
}

// ── Location ─────────────────────────────────────────────────
function LocationBubble({ name, address, lat, lng }) {
  const hasCoords = lat && lng
  const mapsUrl = hasCoords ? `https://maps.google.com/?q=${lat},${lng}` : null

  return (
    <div className="media-location">
      <div className="location-map-preview">
        <span className="location-pin">📍</span>
      </div>
      <div className="location-info">
        <div className="location-label">{name || "Lokasi"}</div>
        {address && <div className="location-address">{address}</div>}
        {hasCoords && <div className="location-coords">{lat?.toFixed(5)}, {lng?.toFixed(5)}</div>}
      </div>
      {mapsUrl && (
        <a href={mapsUrl} target="_blank" rel="noopener noreferrer" className="location-open-btn">
          Buka →
        </a>
      )}
    </div>
  )
}

// ── Contact ──────────────────────────────────────────────────
function ContactBubble({ name, vcard }) {
  return (
    <div className="contact-msg">
      <div className="contact-icon">👤</div>
      <div>
        <div className="contact-name">{name || "Kontak"}</div>
        <div className="contact-sub">Kontak WhatsApp</div>
      </div>
      <button className="contact-add-btn" title="Tambah Kontak">+</button>
    </div>
  )
}

// ── View Once ────────────────────────────────────────────────
function ViewOnceBubble({ mediaType }) {
  return (
    <div className="viewonce-wrap">
      <div className="viewonce-eye">👁</div>
      <div>
        <div className="viewonce-title">
          {mediaType === "video" ? "Video" : "Foto"} sekali lihat
        </div>
        <div className="viewonce-sub">Buka di WhatsApp HP</div>
      </div>
    </div>
  )
}

// ── Ephemeral ────────────────────────────────────────────────
function EphemeralBadge({ expiryTs }) {
  return (
    <div className="ephemeral-badge" title="Pesan sementara">
      <span>⏳</span>
      <span>Sementara</span>
    </div>
  )
}

// ── Group Invite ─────────────────────────────────────────────
function GroupInviteBubble({ body }) {
  return (
    <div className="invite-msg">
      <div className="invite-icon">👥</div>
      <div>
        <div className="invite-title">Undangan Grup</div>
        <div className="invite-sub">{body || "Bergabung ke grup"}</div>
      </div>
      <button className="invite-join-btn">Gabung</button>
    </div>
  )
}

// ── Reaction Message ─────────────────────────────────────────
function ReactionMsgBubble({ emoji, targetId }) {
  return (
    <div className="reaction-msg-bubble">
      <span className="reaction-emoji-big">{emoji || "❤️"}</span>
    </div>
  )
}

// ── Protocol / System ────────────────────────────────────────
function SystemMsgBubble({ type }) {
  const labels = {
    protocolMessage: "Pesan dihapus",
    ephemeralMessage: "Pesan sementara diaktifkan",
    senderKeyDistributionMessage: null,
    callLogMessage: "Panggilan",
    pinInChatMessage: "Pesan disematkan",
    keepInChatMessage: "Pesan disimpan",
    requestPaymentMessage: "Permintaan Pembayaran",
    sendPaymentMessage: "Pembayaran Terkirim",
    orderMessage: "Pesanan",
    invoiceMessage: "Invoice",
  }
  const label = labels[type]
  if (!label) return null
  return (
    <div className="system-msg">
      <span>{label}</span>
    </div>
  )
}

// ── Forwarded badge ──────────────────────────────────────────
function ForwardedBadge({ score }) {
  return (
    <div className="forwarded-badge">
      <span>↪</span>
      <span>{score > 4 ? "Sering diteruskan" : "Diteruskan"}</span>
    </div>
  )
}

// ════════════════════════════════════════════════════════════
// MAIN RENDER CONTENT
// ════════════════════════════════════════════════════════════
function renderContent(msg) {
  const t = msg.msg_type || "conversation"

  // View once
  if (t === "viewOnceMessage" || t === "viewOnceMessageV2") {
    const subType = msg.body?.includes("video") ? "video" : "image"
    return <ViewOnceBubble mediaType={subType} />
  }

  // System messages
  const systemTypes = ["protocolMessage", "senderKeyDistributionMessage", "callLogMessage", "pinInChatMessage", "keepInChatMessage"]
  if (systemTypes.includes(t)) return <SystemMsgBubble type={t} />

  switch (t) {
    case "imageMessage":
      return (
        <ImageBubble
          body={msg.body}
          localPath={msg.media_saved_path}
          width={msg.media_width}
          height={msg.media_height}
        />
      )

    case "videoMessage":
      return (
        <VideoBubble
          body={msg.body}
          duration={msg.media_duration}
          localPath={msg.media_saved_path}
          width={msg.media_width}
          height={msg.media_height}
        />
      )

    case "audioMessage":
    case "pttMessage":
      return (
        <AudioBubble
          isPtt={t === "pttMessage" || (msg.media_mime?.includes("ogg"))}
          duration={msg.media_duration}
          localPath={msg.media_saved_path}
        />
      )

    case "documentMessage":
    case "documentWithCaptionMessage":
      return (
        <DocBubble
          body={msg.body}
          mimetype={msg.media_mime}
          filename={msg.media_filename}
          size={msg.media_size}
        />
      )

    case "stickerMessage":
      return <StickerBubble localPath={msg.media_saved_path} />

    case "locationMessage":
    case "liveLocationMessage":
      return (
        <LocationBubble
          name={msg.location_name || msg.body}
          address={msg.location_address}
          lat={msg.location_lat}
          lng={msg.location_lng}
        />
      )

    case "pollCreationMessage":
      return (
        <PollBubble
          body={msg.body}
          pollOptions={msg.poll_options}
          pollVotes={msg.poll_votes}
        />
      )

    case "contactMessage":
    case "contactsArrayMessage":
      return (
        <ContactBubble
          name={msg.contact_display_name || msg.body}
          vcard={msg.contact_vcard}
        />
      )

    case "groupInviteMessage":
      return <GroupInviteBubble body={msg.body} />

    case "reactionMessage":
      return <ReactionMsgBubble emoji={msg.reaction_emoji} targetId={msg.reaction_target_id} />

    case "requestPaymentMessage":
    case "sendPaymentMessage":
      return (
        <div className="payment-msg">
          <span>{t === "sendPaymentMessage" ? "💸" : "💰"}</span>
          <div>
            <div className="payment-label">{t === "sendPaymentMessage" ? "Pembayaran Terkirim" : "Permintaan Pembayaran"}</div>
            {msg.body && <div className="payment-body">{msg.body}</div>}
          </div>
        </div>
      )

    case "orderMessage":
      return (
        <div className="order-msg">
          <span>🛍️</span>
          <div>
            <div className="order-label">Pesanan</div>
            {msg.body && <div className="order-body">{msg.body}</div>}
          </div>
        </div>
      )

    case "conversation":
    case "extendedTextMessage":
    default:
      if (msg.body) {
        return <div className="bubble-text">{msg.body}</div>
      }
      if (t && t !== "conversation" && t !== "unknown") {
        return <div className="bubble-unsupported">📦 {t}</div>
      }
      return <div className="bubble-unsupported">⚠️ Pesan tidak didukung</div>
  }
}

// ════════════════════════════════════════════════════════════
// BUBBLE COMPONENT
// ════════════════════════════════════════════════════════════
export default function MessageBubble({ msg }) {
  const isMe = msg.from_me === 1
  const t = msg.msg_type || "conversation"
  const isReaction = t === "reactionMessage"
  const isSticker = t === "stickerMessage"
  const isSystem = ["protocolMessage", "senderKeyDistributionMessage"].includes(t)
  const isDeleted = msg.is_deleted === 1

  const hasNoPad = [
    "imageMessage", "videoMessage", "stickerMessage", "viewOnceMessage", "viewOnceMessageV2"
  ].includes(t)

  if (isSystem) {
    return (
      <div className="msg-row system">
        <SystemMsgBubble type={t} />
      </div>
    )
  }

  if (isDeleted) {
    return (
      <div className={`msg-row${isMe ? " me" : " them"}`}>
        <div className={`msg-inner${isMe ? " me" : ""}`}>
          <div className="bubble deleted-msg">
            <span>🚫 Pesan telah dihapus</span>
            <BubbleTime ts={msg.timestamp} />
          </div>
        </div>
      </div>
    )
  }

  const bubbleClass = "bubble"
    + (isMe ? " me" : "")
    + (isReaction || isSticker ? " sticker" : "")
    + (hasNoPad ? " no-pad" : "")

  return (
    <div className={`msg-row${isMe ? " me" : " them"}`}>
      {/* Group sender name */}
      {!isMe && msg.is_group === 1 && msg.sender_name && (
        <div className="msg-sender-name">{msg.sender_name}</div>
      )}

      <div className={`msg-inner${isMe ? " me" : ""}`}>
        {/* Mini avatar for group */}
        {!isMe && msg.is_group === 1 && (
          <div className="msg-mini-avatar" style={{ background: "#1565c0", flexShrink: 0 }}>
            {(msg.sender_name || "?")[0].toUpperCase()}
          </div>
        )}

        <div style={{ maxWidth: "72%" }}>
          <div className={bubbleClass}>
            {/* Badges */}
            {msg.is_ephemeral === 1 && <EphemeralBadge />}
            {msg.is_forwarded === 1 && <ForwardedBadge score={msg.forward_score || 0} />}

            {/* Quoted */}
            {msg.quoted_id && (
              <QuotedMsg
                body={msg.quoted_body}
                sender={msg.quoted_sender}
                type={msg.quoted_type}
              />
            )}

            {/* Content */}
            {renderContent(msg)}

            {/* Footer (time + ticks) */}
            {!isReaction && !isSticker && (
              <div className={`bubble-footer${isMe ? " me" : ""}`}>
                {msg.edited_at && <span className="edited-badge">diedit</span>}
                <BubbleTime ts={msg.timestamp} />
                {isMe && <Ticks status={msg.status} />}
              </div>
            )}
          </div>

          {/* Reactions overlay */}
          {msg.reactions && <ReactionOverlay reactions={msg.reactions} />}
        </div>
      </div>
    </div>
  )
}
