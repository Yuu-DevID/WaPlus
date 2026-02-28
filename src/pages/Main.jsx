import { useEffect, useState } from "react"
import { useAuthStore } from "../store/auth"
import { useChatStore } from "../store/chat"
import { useAppStore } from "../store/app"
import Sidebar from "../components/Sidebar"
import ChatList from "../components/ChatList"
import ChatWindow from "../components/ChatWindow"
import ModManagerPage from "./ModManager"
import StatusUploader from "./StatusUploader"

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

export default function Main() {
  const { connectedUser } = useAuthStore()
  const { loadChats, loadContacts, appendMessage, setSyncStatus } = useChatStore()
  const { activeJid, navTab } = useAppStore()
  const [connStatus, setConnStatus] = useState("connecting")

  useEffect(() => {
    // Load from SQLite immediately on mount
    loadChats()
    loadContacts()
    if (!window.api) return

    // Connection events
    window.api.onConnected?.(()    => setConnStatus("connected"))
    window.api.onReconnecting?.(() => setConnStatus("reconnecting"))
    window.api.onConnectionClose?.((data) => {
      if (data?.willReconnect) setConnStatus("reconnecting")
      else setConnStatus("failed")
    })
    window.api.onConnectionFailed?.(() => setConnStatus("failed"))

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

    // New messages — append immediately for real-time feel
    // payload is buildRendererPayload output — fields: chat_jid, from_me, body, msg_type, etc.
    window.api.onMessagesNew?.((payload) => {
      if (!payload?.chat_jid) return
      appendMessage(payload.chat_jid, payload)
      loadChats()
    })

    // DB-written messages (fallback)
    window.api.onNewMessage?.((msg) => {
      if (!msg?.chat_jid) return
      appendMessage(msg.chat_jid, msg)
      loadChats()
    })
  }, [])

  return (
    <div className="app-root">
      <Sidebar/>
      {navTab === "mods" ? (
        <div style={{ flex: 1, overflow: "hidden" }}>
          <ModManagerPage />
        </div>
      ) : navTab === "status" ? (
        <div style={{ flex: 1, overflow: "hidden" }}>
          <StatusUploader />
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
