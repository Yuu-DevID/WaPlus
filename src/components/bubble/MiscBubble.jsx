
// src/components/bubble/MiscBubble.jsx
// ═══════════════════════════════════════════════════════════════════════════
// Non-media message type bubbles: Document, Poll, Location, Contact, Group Invite,
// Interactive Buttons, Commerce (Order/Payment), Call Log, Event, Newsletter.
// ═══════════════════════════════════════════════════════════════════════════

import { useCallback } from "react"
import { RichText } from "./utils"
import {
  DocTypeIcon, HiChartBar, HiMapPin, HiUser, HiUserGroup,
  HiSpeakerWave, HiShoppingCart, HiCreditCard, HiCalendar,
  HiMegaphone, HiShoppingBag, HiPhone, HiVideoRecording,
} from "./icons"

// ════════════════════════════════════════════════════════════
// DOCUMENT BUBBLE
// ════════════════════════════════════════════════════════════
export function DocBubble({ msg }) {
  const filename = msg.media_filename || msg.body || "Dokumen"
  const ext = msg.mimetype
    ? msg.mimetype.split("/")[1]?.split(";")[0]?.toUpperCase()
    : "FILE"
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

// ════════════════════════════════════════════════════════════
// POLL BUBBLE
// ════════════════════════════════════════════════════════════
export function PollBubble({ msg }) {
  const opts  = msg.poll_options || []
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
            <div className="poll-option-top">
              <span className="poll-option-name">{o.name || o}</span>
              <span className="poll-option-pct">{pct}%</span>
            </div>
            <div className="poll-bar"><div className="poll-bar-fill" style={{ width: `${pct}%` }} /></div>
          </div>
        )
      }) : <div className="poll-sub">Buka di HP untuk melihat opsi</div>}
      {total > 0 && <div className="poll-total">{total} suara</div>}
    </div>
  )
}

// ════════════════════════════════════════════════════════════
// LOCATION BUBBLE
// ════════════════════════════════════════════════════════════
export function LocationBubble({ msg }) {
  const lat  = msg.location_lat
  const lng  = msg.location_lng
  const name = msg.location_name || msg.location_address || msg.body || "Lokasi"
  const isLive = msg.msg_type === "liveLocationMessage"
  const mapsUrl = (lat && lng) ? `https://www.google.com/maps?q=${lat},${lng}` : null

  const handleClick = useCallback(() => {
    if (mapsUrl) window.open(mapsUrl, "_blank")
  }, [mapsUrl])

  return (
    <div className="media-location" onClick={handleClick}
      role={mapsUrl ? "link" : undefined}
      tabIndex={mapsUrl ? 0 : undefined}
      style={{ cursor: mapsUrl ? "pointer" : "default" }}>
      <div className="location-map">
        {lat && lng ? (
          <img
            src={`https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=15&size=200x100&markers=${lat},${lng}`}
            alt="Peta" style={{ width: "100%", height: 80, objectFit: "cover", borderRadius: 6 }}
            onError={e => { e.target.style.display = "none" }} />
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

// ════════════════════════════════════════════════════════════
// CONTACT BUBBLE
// ════════════════════════════════════════════════════════════
export function ContactBubble({ msg }) {
  const contacts = msg.contacts_json || []
  const isArray  = msg.msg_type === "contactsArrayMessage"

  if (!contacts.length) {
    return (
      <div className="contact-msg">
        <div className="contact-icon" style={{ color: "var(--text-2)" }}><HiUser size={24} /></div>
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
          <div className="contact-icon" style={{ color: "var(--text-2)" }}><HiUser size={24} /></div>
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

// ════════════════════════════════════════════════════════════
// GROUP INVITE BUBBLE
// ════════════════════════════════════════════════════════════
export function GroupInviteBubble({ msg }) {
  return (
    <div className="invite-msg">
      <div className="invite-icon" style={{ color: "var(--green)" }}><HiUserGroup size={24} /></div>
      <div>
        <div className="invite-title">Undangan Grup</div>
        <div className="invite-sub">{msg.body || "Bergabung ke grup"}</div>
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════
// INTERACTIVE / BUTTONS BUBBLES
// ════════════════════════════════════════════════════════════
export function ButtonsBubble({ msg }) {
  return (
    <div className="buttons-bubble">
      <div className="bubble-text">{msg.body || ""}</div>
      <div className="buttons-hint" style={{ display: "flex", alignItems: "center", gap: 5 }}>
        <HiSpeakerWave size={14} /> Pesan dengan tombol — buka di HP
      </div>
    </div>
  )
}

export function InteractiveResponseBubble({ msg }) {
  return (
    <div className="bubble-text" style={{ fontStyle: "italic", color: "var(--text-2)" }}>
      ↩ {msg.body || "Memilih opsi"}
    </div>
  )
}

// ════════════════════════════════════════════════════════════
// COMMERCE BUBBLES
// ════════════════════════════════════════════════════════════
export function OrderBubble({ msg }) {
  return (
    <div className="media-doc">
      <div className="doc-icon" style={{ color: "var(--green)" }}><HiShoppingCart size={22} /></div>
      <div>
        <div className="doc-name">{msg.body || "Pesanan"}</div>
        <div className="doc-ext">Pesanan WhatsApp</div>
      </div>
    </div>
  )
}

export function ProductBubble({ msg }) {
  return (
    <div className="media-doc">
      <div className="doc-icon" style={{ color: "var(--text-2)" }}><HiShoppingBag size={22} /></div>
      <div>
        <div className="doc-name">{msg.body || "Produk"}</div>
        <div className="doc-ext">Produk WhatsApp</div>
      </div>
    </div>
  )
}

export function PaymentBubble({ msg }) {
  return (
    <div className="media-doc">
      <div className="doc-icon" style={{ color: "var(--green)" }}><HiCreditCard size={22} /></div>
      <div>
        <div className="doc-name">{msg.body || "Pembayaran"}</div>
        <div className="doc-ext">WhatsApp Pay</div>
      </div>
    </div>
  )
}

export function CallLogBubble({ msg }) {
  const isVideo = msg.body?.includes("Video") || msg.mimetype?.includes("video")
  return (
    <div className="call-log">
      <span style={{ color: "var(--text-2)" }}>
        {isVideo ? <HiVideoRecording size={16} /> : <HiPhone size={16} />}
      </span>
      <span>{msg.body || (isVideo ? "Panggilan Video" : "Panggilan Suara")}</span>
    </div>
  )
}

export function EventBubble({ msg }) {
  return (
    <div className="media-doc">
      <div className="doc-icon" style={{ color: "var(--text-2)" }}><HiCalendar size={22} /></div>
      <div>
        <div className="doc-name">{msg.body || "Acara"}</div>
        <div className="doc-ext">Acara WhatsApp</div>
      </div>
    </div>
  )
}

export function NewsletterBubble({ msg }) {
  return (
    <div className="invite-msg">
      <div className="invite-icon" style={{ color: "var(--green)" }}><HiMegaphone size={24} /></div>
      <div>
        <div className="invite-title">Undangan Newsletter</div>
        <div className="invite-sub">{msg.body || "Bergabung ke channel"}</div>
      </div>
    </div>
  )
}