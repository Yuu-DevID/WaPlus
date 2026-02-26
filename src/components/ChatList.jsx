import { useState, useEffect, useCallback, useRef } from "react"
import { useChatStore } from "../store/chat"
import { useAppStore } from "../store/app"
import ChatItem from "./ChatItem"

const SearchIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
)
const PlusIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
  </svg>
)

const STATUS_LABEL = { connected: "Terhubung", reconnecting: "Menyambung...", failed: "Koneksi Gagal", connecting: "Menghubungkan..." }

const CHAT_FILTERS = [
  { id: "all",    label: "Semua" },
  { id: "unread", label: "Belum dibaca" },
  { id: "groups", label: "Grup" },
]

function SkeletonItem() {
  return (
    <div style={{ display: "flex", gap: 11, padding: "9px 14px", alignItems: "center" }}>
      <div className="skel" style={{ width: 46, height: 46, borderRadius: "50%", flexShrink: 0 }} />
      <div style={{ flex: 1 }}>
        <div className="skel" style={{ width: "60%", height: 12, marginBottom: 7 }} />
        <div className="skel" style={{ width: "85%", height: 10 }} />
      </div>
    </div>
  )
}

function SyncBanner({ syncStatus }) {
  if (syncStatus !== "syncing") return null
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 6,
      padding: "5px 14px", fontSize: 11,
      background: "rgba(37,211,102,0.06)",
      color: "var(--text-3)",
      borderBottom: "1px solid var(--border)",
    }}>
      <span className="spinner spinner-sm" style={{ borderTopColor: "var(--green)", borderColor: "rgba(37,211,102,.2)" }} />
      <span>Menyinkronkan pesan...</span>
    </div>
  )
}

export default function ChatList({ connStatus }) {
  const { chats, contacts, groups, communities, loadChats, loadContacts, syncStatus, setSyncStatus } = useChatStore()
  const { activeJid, setActiveJid, navTab } = useAppStore()
  const [search, setSearch] = useState("")
  const [filter, setFilter] = useState("all")
  const [loading, setLoading] = useState(true)

  // Initial load from SQLite on mount — instant because SQLite is sync
  useEffect(() => {
    Promise.all([loadChats(), loadContacts()]).finally(() => setLoading(false))
  }, [])

  // Listen for events from main process
  useEffect(() => {
    if (!window.api) return
    // Progressive sync status
    window.api.onSyncStatus?.((d) => {
      setSyncStatus(d?.status || "idle")
      if (d?.status === "done") loadChats()
    })
    // DB updated events — reload from SQLite (incremental, fast)
    window.api.onChatsUpdated?.(() => loadChats())
    window.api.onContactsUpdated?.(() => loadContacts())
  }, [])

  const status = connStatus || "connecting"

  // Determine which list to show based on navTab + filter
  let baseItems
  if (navTab === "contacts") {
    baseItems = contacts
  } else if (navTab === "communities") {
    baseItems = communities
  } else {
    if (filter === "groups") baseItems = groups
    else if (filter === "unread") baseItems = chats.filter(c => c.unread_count > 0)
    else baseItems = chats
  }

  // Search filter (client-side for speed)
  let items = baseItems
  if (search) {
    const q = search.toLowerCase()
    items = baseItems.filter(c =>
      (c.name || "").toLowerCase().includes(q) ||
      (c.jid || "").includes(q) ||
      (c.phone || "").includes(q) ||
      (c.last_msg || "").toLowerCase().includes(q)
    )
  }

  const handleClick = useCallback((jid) => { setActiveJid(jid) }, [])

  const isContacts = navTab === "contacts"
  const isCommunities = navTab === "communities"

  const emptyIcon = search ? "🔍" : isCommunities ? "🏘️" : isContacts ? "👥" : filter === "unread" ? "✅" : filter === "groups" ? "👥" : "💬"
  const emptyTitle = search ? "Tidak ada hasil" : isCommunities ? "Belum ada komunitas" : isContacts ? "Belum ada kontak" : filter === "unread" ? "Semua sudah dibaca" : filter === "groups" ? "Belum ada grup" : "Belum ada pesan"
  const emptyDesc = search ? "Coba kata kunci lain" : "Mulai chat baru dengan tombol + di atas"

  const panelTitle = isCommunities ? "Komunitas" : isContacts ? "Kontak" : "Pesan"

  // Total unread badge for header
  const totalUnread = chats.reduce((s, c) => s + (c.unread_count || 0), 0)

  return (
    <div className="chat-panel">
      {/* Header */}
      <div className="chat-panel-header">
        <div className="chat-panel-title-row">
          <div className="chat-panel-title">
            <div className={"conn-dot " + status} />
            {panelTitle}
            {navTab === "chats" && totalUnread > 0 && (
              <span style={{
                marginLeft: 6, fontSize: 10, fontWeight: 700,
                background: "var(--green)", color: "#fff",
                borderRadius: 10, padding: "1px 6px", lineHeight: 1.6
              }}>
                {totalUnread > 99 ? "99+" : totalUnread}
              </span>
            )}
          </div>
          <button
            style={{ width: 30, height: 30, borderRadius: 8, background: "rgba(37,211,102,.1)", border: "1px solid rgba(37,211,102,.2)", color: "var(--green)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
            title="Chat Baru"
          >
            <PlusIcon />
          </button>
        </div>

        {/* Connection status */}
        <div style={{ fontSize: 11, color: status === "connected" ? "var(--green)" : status === "failed" ? "var(--text-danger)" : "var(--text-warn)", marginBottom: 8, display: "flex", alignItems: "center", gap: 5 }}>
          {STATUS_LABEL[status] || "Menghubungkan..."}
          {status === "reconnecting" && <span className="spinner spinner-sm" style={{ borderTopColor: "var(--text-warn)", borderColor: "rgba(251,191,36,.2)" }} />}
        </div>

        {/* Search */}
        <div className="search-wrap">
          <div className="search-icon"><SearchIcon /></div>
          <input
            className="search-input"
            placeholder={isCommunities ? "Cari komunitas..." : isContacts ? "Cari kontak..." : "Cari pesan atau kontak..."}
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* Filter tabs — only for chats tab */}
      {navTab === "chats" && (
        <div className="filter-row">
          {CHAT_FILTERS.map(f => (
            <button
              key={f.id}
              className={"filter-btn" + (filter === f.id ? " active" : "")}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
              {f.id === "unread" && totalUnread > 0 && (
                <span style={{ marginLeft: 4, fontSize: 10, background: "var(--green)", color: "#fff", borderRadius: 8, padding: "0 5px" }}>
                  {totalUnread > 99 ? "99+" : totalUnread}
                </span>
              )}
              {f.id === "groups" && groups.length > 0 && (
                <span style={{ marginLeft: 4, fontSize: 10, color: "var(--text-3)" }}>
                  {groups.length}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Progressive sync banner */}
      <SyncBanner syncStatus={syncStatus} />

      {/* List */}
      <div className="chat-list">
        {loading ? (
          Array.from({ length: 8 }).map((_, i) => <SkeletonItem key={i} />)
        ) : items.length === 0 ? (
          <div style={{ textAlign: "center", padding: "40px 20px", color: "var(--text-3)" }}>
            <div style={{ fontSize: 36, marginBottom: 10 }}>{emptyIcon}</div>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4, color: "var(--text-2)" }}>{emptyTitle}</div>
            <div style={{ fontSize: 11 }}>{emptyDesc}</div>
          </div>
        ) : (
          items.map(item => (
            <ChatItem
              key={item.jid}
              chat={item}
              active={activeJid === item.jid}
              onClick={() => handleClick(item.jid)}
              isContact={isContacts}
              isCommunity={isCommunities}
            />
          ))
        )}
      </div>
    </div>
  )
}
