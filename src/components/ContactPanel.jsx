// src/components/ContactPanel.jsx
// ═══════════════════════════════════════════════════════════════════════════
// [FIX-8] Contact Tab — correct filtering + grouping:
//
//   ALLOWED:   @s.whatsapp.net JIDs (regular DMs)
//   FORBIDDEN: @g.us (groups), @newsletter (channels), @lid (raw device IDs),
//              @broadcast, and any unresolved JID with no usable name.
//
//   GROUPING:
//     - "Kontak Tersimpan" — contacts with a real name (contacts.name != null)
//     - "Tidak Tersimpan"  — contacts with only push_name (unsaved numbers)
//
//   @lid that leaked into the contacts table are excluded here.
//   Unsaved numbers are shown with their push_name as the display name.
// ═══════════════════════════════════════════════════════════════════════════

import { useMemo } from "react"
import { useChatStore } from "../store/chat"
import { useAppStore } from "../store/app"

const COLORS = ["#1a5c3e","#1565c0","#6a1b9a","#b71c1c","#e65100","#2e7d32","#00695c","#4527a0","#00838f","#ad1457"]
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

function ContactItem({ contact, active, onClick }) {
  const display = contact.name || contact.push_name || contact._phone || "?"
  const color = getColor(display)

  return (
    <div
      onClick={() => onClick(contact.jid)}
      style={{
        display: "flex", alignItems: "center", gap: 11,
        padding: "9px 14px", cursor: "pointer",
        background: active ? "rgba(37,211,102,0.12)" : "transparent",
        borderBottom: "1px solid rgba(255,255,255,0.04)",
        transition: "background 0.1s",
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = "rgba(255,255,255,0.04)" }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.background = "transparent" }}
    >
      {contact.profile_pic_url ? (
        <img
          src={contact.profile_pic_url} alt={display} draggable={false}
          style={{ width: 44, height: 44, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }}
          onError={e => { e.currentTarget.style.display = "none"; e.currentTarget.nextSibling.style.display = "flex" }}
        />
      ) : null}
      <div
        style={{
          width: 44, height: 44, borderRadius: "50%",
          background: color, flexShrink: 0,
          display: contact.profile_pic_url ? "none" : "flex",
          alignItems: "center", justifyContent: "center",
          fontSize: 14, fontWeight: 700, color: "#fff",
        }}
      >
        {initials(display)}
      </div>
      <div style={{ flex: 1, overflow: "hidden" }}>
        <div style={{
          fontSize: 13, fontWeight: 600, color: "var(--text-1)",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {display}
        </div>
        {contact._phone && display !== contact._phone && (
          <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 1 }}>
            +{contact._phone}
          </div>
        )}
        {!contact.name && contact.push_name && (
          <div style={{
            display: "inline-block", marginTop: 2,
            fontSize: 10, color: "var(--text-3)",
            background: "rgba(255,255,255,0.08)",
            borderRadius: 4, padding: "1px 5px",
          }}>
            Tidak tersimpan
          </div>
        )}
      </div>
    </div>
  )
}

function SectionLabel({ label, count }) {
  return (
    <div style={{
      padding: "8px 14px 4px",
      fontSize: 10, fontWeight: 700,
      color: "var(--green)", textTransform: "uppercase", letterSpacing: 0.8,
      display: "flex", alignItems: "center", gap: 6,
    }}>
      {label}
      {count > 0 && (
        <span style={{
          fontSize: 10, color: "var(--text-3)", fontWeight: 600,
          background: "rgba(255,255,255,0.08)", borderRadius: 8, padding: "0 5px",
        }}>
          {count}
        </span>
      )}
    </div>
  )
}

export default function ContactPanel() {
  const { contacts } = useChatStore()
  const { activeJid, setActiveJid } = useAppStore()

  // [FIX-8] Filter and group contacts
  const { saved, unsaved } = useMemo(() => {
    const saved = []
    const unsaved = []

    for (const c of contacts) {
      const jid = c.jid || ""

      // [FIX-8] ALLOW only @s.whatsapp.net
      if (!jid.endsWith("@s.whatsapp.net")) continue

      // Extract numeric phone part for display
      const user = jid.split("@")[0].split(":")[0]
      const phone = /^\d{6,}$/.test(user) ? user : null

      const enriched = { ...c, _phone: phone }

      // Saved: has a real name (from phonebook / contacts.name)
      // Unsaved: only push_name (WA display name), no phonebook entry
      if (c.name && c.name.trim()) {
        saved.push(enriched)
      } else if (c.push_name && c.push_name.trim()) {
        unsaved.push(enriched)
      } else if (phone) {
        // Number-only contact with no name at all — still show under unsaved
        unsaved.push({ ...enriched, push_name: `+${phone}` })
      }
      // If none of the above → skip (no usable identity)
    }

    // Sort each group alphabetically by display name
    const sortFn = (a, b) => {
      const na = (a.name || a.push_name || a._phone || "").toLowerCase()
      const nb = (b.name || b.push_name || b._phone || "").toLowerCase()
      return na.localeCompare(nb)
    }
    saved.sort(sortFn)
    unsaved.sort(sortFn)

    return { saved, unsaved }
  }, [contacts])

  const total = saved.length + unsaved.length

  if (total === 0) {
    return (
      <div style={{ textAlign: "center", padding: "40px 20px", color: "var(--text-3)" }}>
        <div style={{ fontSize: 36, marginBottom: 10 }}>👥</div>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-2)", marginBottom: 4 }}>Belum ada kontak</div>
        <div style={{ fontSize: 11 }}>Kontak akan muncul setelah sinkronisasi selesai</div>
      </div>
    )
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", overflow: "hidden", flex: 1 }}>
      {/* Saved contacts */}
      {saved.length > 0 && (
        <>
          <SectionLabel label="Kontak Tersimpan" count={saved.length} />
          {saved.map(c => (
            <ContactItem
              key={c.jid}
              contact={c}
              active={activeJid === c.jid}
              onClick={setActiveJid}
            />
          ))}
        </>
      )}

      {/* Unsaved contacts */}
      {unsaved.length > 0 && (
        <>
          <SectionLabel label="Tidak Tersimpan" count={unsaved.length} />
          {unsaved.map(c => (
            <ContactItem
              key={c.jid}
              contact={c}
              active={activeJid === c.jid}
              onClick={setActiveJid}
            />
          ))}
        </>
      )}
    </div>
  )
}
