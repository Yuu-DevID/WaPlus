import { useEffect, useState } from "react"
import { useAuthStore } from "../store/auth"
import { useChatStore } from "../store/chat"
import { useAppStore } from "../store/app"
import Sidebar from "../components/Sidebar"
import ChatList from "../components/ChatList"
import ChatWindow from "../components/ChatWindow"
import ModManagerPage from "./ModManager"
import StatusUploader from "./StatusUploader"
import ContactStatusPage from "./ContactStatusPage"
import MediaViewer from "../components/MediaViewer"

const CONN_STATUS = { connected:"connected", open:"connected", reconnecting:"reconnecting", close:"failed", connecting:"connecting" }

// Welcome screen when no chat selected
function WelcomeScreen({ connStatus, user }) {
  const STATUS_LABEL = { connected:"Terhubung", reconnecting:"Menyambung ulang...", failed:"Koneksi gagal", connecting:"Menghubungkan..." }
  const STATUS_COLOR = { connected:"var(--green)", reconnecting:"var(--text-warn)", failed:"var(--text-danger)", connecting:"var(--blue)" }
  const st = connStatus || "connecting"
  const name = user?.name || user?.pushName || ""

  return (
    <div className="chat-window">
      <div className="welcome-screen">
        <div className="welcome-logo anim-float">
          <svg viewBox="0 0 48 48" fill="none" width="52" height="52">
            <path d="M24 4C13 4 4 13 4 24c0 3.5.95 6.8 2.6 9.65L4 44l10.6-2.55A19.93 19.93 0 0024 44c11 0 20-9 20-20S35 4 24 4z" fill="white" fillOpacity=".15"/>
            <path d="M24 4C13 4 4 13 4 24c0 3.5.95 6.8 2.6 9.65L4 44l10.6-2.55A19.93 19.93 0 0024 44c11 0 20-9 20-20S35 4 24 4z" fill="url(#wg)" fillOpacity=".7"/>
            <defs><linearGradient id="wg" x1="4" y1="4" x2="44" y2="44"><stop stopColor="#25d366"/><stop offset="1" stopColor="#1da851"/></linearGradient></defs>
            <circle cx="17" cy="24" r="2.2" fill="white"/>
            <circle cx="24" cy="24" r="2.2" fill="white"/>
            <circle cx="31" cy="24" r="2.2" fill="white"/>
          </svg>
        </div>

        <div className="welcome-title">AuroraChat</div>
        {name && <div style={{fontSize:13,color:"var(--green)",fontWeight:600}}>Halo, {name}! 👋</div>}
        <div className="welcome-sub">Pilih percakapan di sebelah kiri untuk mulai chatting</div>

        {/* Connection status */}
        <div className="welcome-status">
          <div className={"conn-dot " + st}/>
          <span className="welcome-status-text" style={{color:STATUS_COLOR[st]||"var(--text-3)"}}>
            {STATUS_LABEL[st]||"Menghubungkan..."}
          </span>
          {st==="reconnecting" && <span className="spinner spinner-sm" style={{borderTopColor:"var(--text-warn)",borderColor:"rgba(251,191,36,.2)"}}/>}
        </div>

        {/* Tips */}
        <div className="welcome-tips">
          {[
            {icon:"💬",title:"Chat",desc:"Kirim pesan ke siapa saja"},
            {icon:"👥",title:"Grup",desc:"Kelola percakapan grup"},
            {icon:"🖼️",title:"Media",desc:"Foto, video, dokumen"},
            {icon:"🔍",title:"Cari",desc:"Temukan chat dengan cepat"},
          ].map(t=>(
            <div key={t.title} className="tip-card">
              <div className="tip-icon">{t.icon}</div>
              <div className="tip-title">{t.title}</div>
              <div className="tip-desc">{t.desc}</div>
            </div>
          ))}
        </div>

        <div style={{fontSize:10,color:"var(--text-3)",marginTop:8}}>AuroraChat · Berbasis Baileys · Bukan produk resmi WhatsApp</div>
      </div>
    </div>
  )
}

// ── Status Tab: Upload & Fetch sub-tabs ───────────────────────────────────────
function StatusTabsView() {
  const [subTab, setSubTab] = useState("upload")
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{
        display: "flex", gap: 0, background: "var(--bg-2)",
        borderBottom: "1px solid var(--border)", flexShrink: 0,
      }}>
        {[
          { id: "upload", icon: "📡", label: "Upload Status" },
          { id: "fetch",  icon: "👁️", label: "Status Kontak" },
        ].map(t => (
          <button key={t.id} onClick={() => setSubTab(t.id)}
            style={{
              padding: "10px 18px", border: "none", background: "none", cursor: "pointer",
              fontSize: 13, fontWeight: subTab === t.id ? 700 : 400,
              color: subTab === t.id ? "var(--green)" : "var(--text-2)",
              borderBottom: subTab === t.id ? "2px solid var(--green)" : "2px solid transparent",
              transition: "all 0.15s", display: "flex", alignItems: "center", gap: 6,
            }}>
            <span>{t.icon}</span>{t.label}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, overflow: "hidden" }}>
        {subTab === "upload" ? <StatusUploader /> : <ContactStatusPage />}
      </div>
    </div>
  )
}

export default function Main() {
  const { connectedUser } = useAuthStore()
  const { loadChats, loadContacts, appendMessage, setSyncStatus } = useChatStore()
  const { activeJid, navTab, loadSettings } = useAppStore()
  const [connStatus, setConnStatus] = useState("connecting")

  useEffect(() => {
    // [FIX-3] Load persisted settings (auto-download etc.) from electron userData
    loadSettings?.()

    // Load from SQLite immediately on mount
    loadChats()
    loadContacts()
    if (!window.api) return

    // ── Connection events ──────────────────────────────────────
    // FIX: Track actual connection state — prevent stuck "Menghubungkan" loop
    // connection:open  → always means connected (reset any reconnecting state)
    // connection:reconnecting → only show if not yet connected
    // connection:close → only go to reconnecting if willReconnect flag set
    window.api.onConnected?.((data) => {
      setConnStatus("connected")
    })

    window.api.onReconnecting?.((data) => {
      // Only show reconnecting if we are NOT currently connected
      // This prevents the UI flickering to "reconnecting" on transient events
      setConnStatus(prev => prev === "connected" ? prev : "reconnecting")
    })

    window.api.onConnectionClose?.((data) => {
      // willReconnect means baileys will retry — show reconnecting
      // otherwise show failed
      if (data?.statusCode === 428 || data?.statusCode === 440) {
        // These codes mean: session mismatch / phone disconnected — fatal
        setConnStatus("failed")
      } else {
        setConnStatus("reconnecting")
      }
    })

    window.api.onConnectionFailed?.(() => setConnStatus("failed"))
    window.api.onConnectionError?.(() => setConnStatus(prev => prev === "connected" ? "connected" : "failed"))

    // Sync status (progressive Baileys sync indicator)
    window.api.onSyncStatus?.((d) => {
      setSyncStatus(d?.status || "idle")
      if (d?.status === "done") loadChats()
    })

    // Live chat updates — reload from SQLite
    window.api.onChatsSet?.((chats) => { if (chats?.length) loadChats() })
    window.api.onChatsUpsert?.(() => loadChats())
    window.api.onChatsUpdated?.(() => loadChats())
    window.api.onContactsUpdated?.(() => loadContacts())

    // New messages — append immediately for real-time feel.
    // [FIX-CHAT-POS] Do NOT call loadChats() here — appendMessage() already
    // updates last_msg_at and re-sorts the chat list atomically in-memory.
    // Calling loadChats() right after races against the DB write and reverts
    // the sort back to stale DB order, making the chat jump back down.
    window.api.onMessagesNew?.((payload) => {
      if (!payload?.chat_jid) return
      appendMessage(payload.chat_jid, payload)
    })

    // DB-written messages (fallback)
    window.api.onNewMessage?.((msg) => {
      if (!msg?.chat_jid) return
      appendMessage(msg.chat_jid, msg)
    })
  }, [])

  return (
    <div className="app-root">
      <MediaViewer />
      <Sidebar/>
      {navTab === "mods" ? (
        <div style={{ flex: 1, overflow: "hidden" }}>
          <ModManagerPage />
        </div>
      ) : navTab === "status" ? (
        <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          <StatusTabsView />
        </div>
      ) : (
        <>
          <ChatList connStatus={connStatus}/>
          {activeJid
            ? <ChatWindow key={activeJid} jid={activeJid}/>
            : <WelcomeScreen connStatus={connStatus} user={connectedUser}/>
          }
        </>
      )}
    </div>
  )
}
