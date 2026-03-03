// src/pages/ContactStatusPage.jsx
// Fetch & display WhatsApp "About" status for contacts
// Uses sock.fetchStatus(jid) via IPC
import { useState, useCallback, useRef } from "react"
import { useChatStore } from "../store/chat"

// ─── Helpers ─────────────────────────────────────────────────────────────────
function normalizeJid(jid) {
  if (!jid) return ""
  const at = jid.lastIndexOf("@")
  if (at === -1) return jid
  let user = jid.slice(0, at), server = jid.slice(at + 1)
  user = user.split(":")[0]
  if (server === "c.us") server = "s.whatsapp.net"
  return `${user}@${server}`
}

function formatDate(ts) {
  if (!ts) return ""
  const d = ts instanceof Date ? ts : new Date(ts)
  if (isNaN(d.getTime())) return ""
  return d.toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
}

const COLORS = ["#1a5c3e","#1565c0","#6a1b9a","#b71c1c","#e65100","#2e7d32","#00695c","#4527a0","#00838f","#ad1457"]
function seedColor(s) {
  if (!s) return COLORS[0]
  let h = 0
  for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h)
  return COLORS[Math.abs(h) % COLORS.length]
}
function initials(name) {
  if (!name) return "?"
  const stripped = name.replace(/[\s\-+().]/g, "")
  if (/^\d{6,}$/.test(stripped)) return stripped.slice(-2)
  const words = name.trim().split(/\s+/)
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

// ─── Avatar ───────────────────────────────────────────────────────────────────
const picCache = new Map()
const fetching = new Set()

function Avatar({ jid, name, size = 42 }) {
  const [url, setUrl] = useState(() => picCache.has(jid) ? picCache.get(jid) : undefined)
  const [err, setErr] = useState(false)

  useState(() => {
    if (!jid) return
    if (picCache.has(jid)) { const c = picCache.get(jid); if (c !== url) setUrl(c); return }
    if (fetching.has(jid)) return
    fetching.add(jid)
    window.api?.getProfilePic?.({ jid })
      .then(r => { const u = r?.url || null; picCache.set(jid, u); setUrl(u) })
      .catch(() => { picCache.set(jid, null); setUrl(null) })
      .finally(() => fetching.delete(jid))
  }, [jid])

  return (
    <div style={{
      width: size, height: size, borderRadius: "50%", flexShrink: 0,
      background: url && !err ? "transparent" : seedColor(jid),
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: Math.round(size * 0.36), fontWeight: 700, color: "#fff",
      overflow: "hidden", userSelect: "none",
    }}>
      {url && !err
        ? <img src={url} alt={name} onError={() => setErr(true)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        : initials(name)
      }
    </div>
  )
}

// ─── Status Card ─────────────────────────────────────────────────────────────
function StatusCard({ item, onFetch }) {
  return (
    <div style={{
      display: "flex", alignItems: "flex-start", gap: 12,
      padding: "12px 16px",
      borderBottom: "1px solid rgba(255,255,255,0.05)",
      transition: "background 0.1s",
    }}
      onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.03)"}
      onMouseLeave={e => e.currentTarget.style.background = "transparent"}
    >
      <Avatar jid={item.jid} name={item.name} size={44} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
          <span style={{ fontWeight: 600, fontSize: 14, color: "var(--text-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
            {item.name}
          </span>
          <button
            onClick={() => onFetch(item.jid)}
            disabled={item.loading}
            title="Refresh status"
            style={{
              background: "none", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 5,
              color: "var(--text-3)", cursor: item.loading ? "wait" : "pointer",
              padding: "2px 8px", fontSize: 11, flexShrink: 0,
              display: "flex", alignItems: "center", gap: 4,
            }}
          >
            {item.loading
              ? <span className="spinner spinner-sm" style={{ width: 10, height: 10, borderTopColor: "var(--green)", borderColor: "rgba(37,211,102,.2)" }} />
              : <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-.08-3.08"/></svg>
            }
            Refresh
          </button>
        </div>

        <div style={{ fontSize: 12, color: "var(--text-3)", fontFamily: "monospace", marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {item.jid.replace("@s.whatsapp.net", "")}
        </div>

        {item.error
          ? <div style={{ fontSize: 12, color: "#ef4444", fontStyle: "italic" }}>⚠ {item.error}</div>
          : item.status !== undefined && item.status !== null
            ? (
              <div style={{
                background: "rgba(37,211,102,0.08)", border: "1px solid rgba(37,211,102,0.18)",
                borderRadius: 6, padding: "7px 10px", marginTop: 2,
              }}>
                <div style={{
                  fontSize: 13.5, color: "var(--text-1)", lineHeight: 1.5,
                  wordBreak: "break-word",
                  // [FIX-SELECTABLE] Allow text selection on status
                  userSelect: "text", cursor: "text",
                }}>
                  {item.status || <span style={{ fontStyle: "italic", opacity: 0.5 }}>Status kosong</span>}
                </div>
                {item.setAt && (
                  <div style={{ fontSize: 10, color: "var(--text-3)", marginTop: 5 }}>
                    📅 {formatDate(item.setAt)}
                  </div>
                )}
              </div>
            )
            : (
              <div style={{ fontSize: 12, color: "var(--text-3)", fontStyle: "italic" }}>
                Belum difetch — klik Refresh
              </div>
            )
        }
      </div>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function ContactStatusPage() {
  const { contacts, chats } = useChatStore()
  const [statusMap, setStatusMap] = useState({})   // jid → { status, setAt, loading, error }
  const [search, setSearch] = useState("")
  const [fetching, setFetching] = useState(false)
  const [fetchProgress, setFetchProgress] = useState(null) // { done, total }
  const abortRef = useRef(false)

  // Build contact list from chats (non-group DMs) + contacts store
  const allContacts = (() => {
    const seen = new Set()
    const list = []
    // From chats: non-group DMs only
    for (const c of (chats || [])) {
      const jid = normalizeJid(c.jid || "")
      if (!jid || jid.endsWith("@g.us") || jid.endsWith("@newsletter") || seen.has(jid)) continue
      seen.add(jid)
      const name = c.name || c.subject || jid.split("@")[0]
      list.push({ jid, name })
    }
    // From contacts store — add any not already in list
    for (const ct of (contacts || [])) {
      const jid = normalizeJid(ct.jid || "")
      if (!jid || seen.has(jid)) continue
      seen.add(jid)
      const name = ct.name || ct.push_name || jid.split("@")[0]
      list.push({ jid, name })
    }
    return list
  })()

  const filtered = search.trim()
    ? allContacts.filter(c =>
        c.name.toLowerCase().includes(search.toLowerCase()) ||
        c.jid.includes(search.replace(/\D/g, ""))
      )
    : allContacts

  // Fetch single contact
  const fetchOne = useCallback(async (jid) => {
    setStatusMap(m => ({ ...m, [jid]: { ...m[jid], loading: true, error: undefined } }))
    try {
      const res = await window.api?.contactFetchStatus?.({ jid })
      if (res?.ok) {
        setStatusMap(m => ({ ...m, [jid]: { status: res.status, setAt: res.setAt, loading: false } }))
      } else {
        setStatusMap(m => ({ ...m, [jid]: { ...m[jid], loading: false, error: res?.error || "Gagal fetch" } }))
      }
    } catch (e) {
      setStatusMap(m => ({ ...m, [jid]: { ...m[jid], loading: false, error: e.message } }))
    }
  }, [])

  // Fetch all visible contacts (bulk, with progress)
  const fetchAll = useCallback(async () => {
    if (fetching) { abortRef.current = true; return }
    abortRef.current = false
    setFetching(true)
    const targets = filtered.map(c => c.jid)
    setFetchProgress({ done: 0, total: targets.length })

    for (let i = 0; i < targets.length; i++) {
      if (abortRef.current) break
      const jid = targets[i]
      setStatusMap(m => ({ ...m, [jid]: { ...m[jid], loading: true, error: undefined } }))
      try {
        const res = await window.api?.contactFetchStatus?.({ jid })
        if (res?.ok) {
          setStatusMap(m => ({ ...m, [jid]: { status: res.status, setAt: res.setAt, loading: false } }))
        } else {
          setStatusMap(m => ({ ...m, [jid]: { ...m[jid], loading: false, error: "Privat / gagal" } }))
        }
      } catch {
        setStatusMap(m => ({ ...m, [jid]: { ...m[jid], loading: false, error: "Error" } }))
      }
      setFetchProgress({ done: i + 1, total: targets.length })
      // Small delay to avoid WA rate limiting
      await new Promise(r => setTimeout(r, 200))
    }
    setFetching(false)
    setFetchProgress(null)
  }, [filtered, fetching])

  // Build display items
  const items = filtered.map(c => ({
    ...c,
    ...(statusMap[c.jid] || {}),
  }))

  const fetchedCount = Object.values(statusMap).filter(v => v.status !== undefined).length

  return (
    <div style={{
      display: "flex", flexDirection: "column", height: "100%",
      background: "var(--bg-1)", color: "var(--text-1)",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    }}>

      {/* Header */}
      <div style={{
        padding: "14px 18px 10px", borderBottom: "1px solid var(--border)",
        flexShrink: 0, display: "flex", flexDirection: "column", gap: 10,
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--green)" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="10"/><circle cx="12" cy="10" r="3"/>
              <path d="M7 20.662V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.662"/>
            </svg>
            <span style={{ fontWeight: 700, fontSize: 16 }}>Status Kontak</span>
            <span style={{ fontSize: 12, color: "var(--text-3)", background: "rgba(255,255,255,0.07)", borderRadius: 12, padding: "2px 8px" }}>
              {allContacts.length} kontak
            </span>
            {fetchedCount > 0 && (
              <span style={{ fontSize: 12, color: "var(--green)", background: "rgba(37,211,102,0.1)", borderRadius: 12, padding: "2px 8px" }}>
                ✓ {fetchedCount} difetch
              </span>
            )}
          </div>

          <button
            onClick={fetchAll}
            style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "7px 14px", borderRadius: 8, border: "none", cursor: "pointer",
              background: fetching ? "rgba(239,68,68,0.15)" : "var(--green)",
              color: fetching ? "#ef4444" : "#fff",
              fontSize: 13, fontWeight: 600, transition: "all 0.15s",
            }}
          >
            {fetching
              ? <><span className="spinner spinner-sm" style={{ borderTopColor: "#ef4444", borderColor: "rgba(239,68,68,.2)", width: 12, height: 12 }} /> Stop</>
              : <><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-.08-3.08"/></svg> Fetch Semua ({filtered.length})</>
            }
          </button>
        </div>

        {/* Search */}
        <div style={{ position: "relative" }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="2" strokeLinecap="round"
            style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}>
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Cari kontak…"
            style={{
              width: "100%", background: "var(--bg-3)", border: "1px solid var(--border)",
              borderRadius: 8, padding: "8px 12px 8px 32px", fontSize: 13,
              color: "var(--text-1)", outline: "none", boxSizing: "border-box",
            }}
          />
          {search && (
            <button onClick={() => setSearch("")} style={{
              position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)",
              background: "none", border: "none", color: "var(--text-3)", cursor: "pointer", fontSize: 14, lineHeight: 1,
            }}>✕</button>
          )}
        </div>

        {/* Progress bar */}
        {fetchProgress && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ flex: 1, height: 4, background: "rgba(255,255,255,0.08)", borderRadius: 2, overflow: "hidden" }}>
              <div style={{
                height: "100%", background: "var(--green)", borderRadius: 2,
                width: `${(fetchProgress.done / fetchProgress.total) * 100}%`,
                transition: "width 0.2s",
              }} />
            </div>
            <span style={{ fontSize: 11, color: "var(--text-3)", whiteSpace: "nowrap" }}>
              {fetchProgress.done}/{fetchProgress.total}
            </span>
          </div>
        )}
      </div>

      {/* Info bar */}
      <div style={{
        padding: "6px 16px", fontSize: 11, color: "var(--text-3)",
        borderBottom: "1px solid var(--border)", background: "rgba(0,0,0,0.15)",
        flexShrink: 0,
      }}>
        💡 Status = teks "About" profil WA kontak (bukan story/status foto). Klik Refresh per kontak atau Fetch Semua.
        Beberapa kontak mungkin privat / tidak bisa difetch.
      </div>

      {/* List */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {items.length === 0 ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 10, color: "var(--text-3)" }}>
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" style={{ opacity: 0.3 }}>
              <circle cx="12" cy="12" r="10"/><circle cx="12" cy="10" r="3"/>
              <path d="M7 20.662V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.662"/>
            </svg>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-2)" }}>
              {search ? "Tidak ada kontak cocok" : "Tidak ada kontak"}
            </div>
          </div>
        ) : (
          items.map(item => (
            <StatusCard key={item.jid} item={item} onFetch={fetchOne} />
          ))
        )}
      </div>
    </div>
  )
}
