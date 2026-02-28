import { useAuthStore } from "../store/auth"
import { useAppStore } from "../store/app"

const IconChats = () => (
  <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
  </svg>
)
const IconContacts = () => (
  <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
    <circle cx="9" cy="7" r="4"/>
    <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>
  </svg>
)
const IconCommunity = () => (
  <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="7" r="3"/>
    <path d="M5.5 21v-2A3.5 3.5 0 0 1 9 15.5h6a3.5 3.5 0 0 1 3.5 3.5v2"/>
    <circle cx="5" cy="10" r="2"/>
    <path d="M2 20v-1.5A2.5 2.5 0 0 1 4.5 16"/>
    <circle cx="19" cy="10" r="2"/>
    <path d="M22 20v-1.5A2.5 2.5 0 0 0 19.5 16"/>
  </svg>
)
const IconSettings = () => (
  <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
  </svg>
)
const IconLogout = () => (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
    <polyline points="16 17 21 12 16 7"/>
    <line x1="21" y1="12" x2="9" y2="12"/>
  </svg>
)

const COLORS = ["#1a5c3e","#1565c0","#6a1b9a","#b71c1c","#e65100","#2e7d32","#00695c","#4527a0","#00838f","#ad1457"]
function getColor(s) { if(!s) return COLORS[0]; let h=0; for(let i=0;i<s.length;i++) h=s.charCodeAt(i)+((h<<5)-h); return COLORS[Math.abs(h)%COLORS.length] }
function initials(n) { if(!n) return "?"; return n.trim().split(/\s+/).slice(0,2).map(w=>w[0]).join("").toUpperCase() }

const IconStatus = () => (
  <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10"/>
    <circle cx="12" cy="12" r="3"/>
    <line x1="12" y1="2" x2="12" y2="5"/>
    <line x1="12" y1="19" x2="12" y2="22"/>
    <line x1="2" y1="12" x2="5" y2="12"/>
    <line x1="19" y1="12" x2="22" y2="12"/>
  </svg>
)

const IconPlugin = () => (
  <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/>
    <line x1="16" y1="8" x2="2" y2="22"/>
    <line x1="17.5" y1="15" x2="9" y2="15"/>
  </svg>
)
const IconChannel = () => (
  <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.61 3.53 2 2 0 0 1 3.55 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.69a16 16 0 0 0 6.29 6.29l.9-.9a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>
    <line x1="3" y1="3" x2="21" y2="21" stroke="none"/>
    <circle cx="12" cy="12" r="4"/>
    <path d="M12 2v2M12 20v2M2 12h2M20 12h2" stroke="currentColor" strokeWidth="1.5"/>
  </svg>
)

const NAV = [
  { id:"chats",       icon:<IconChats/>,     tip:"Pesan" },
  { id:"contacts",    icon:<IconContacts/>,  tip:"Kontak" },
  { id:"communities", icon:<IconCommunity/>, tip:"Komunitas" },
  { id:"channels",    icon:<IconChannel/>,   tip:"Saluran (Channel)" },
  { id:"status",      icon:<IconStatus/>,    tip:"Upload Status" },
  { id:"mods",        icon:<IconPlugin/>,    tip:"Plugin Manager" },
]

export default function Sidebar() {
  const { navTab, setNavTab } = useAppStore()
  const { connectedUser } = useAuthStore()
  const name = connectedUser?.name || connectedUser?.pushName || "Me"
  const color = getColor(name)

  const handleLogout = () => {
    if (window.confirm("Keluar dari AuroraChat?")) window.api?.logout?.()
  }

  return (
    <div className="sidebar">
      {/* Logo */}
      <div className="sidebar-logo">
        <svg viewBox="0 0 20 20" fill="none" width="20" height="20">
          <path d="M10 1C5.03 1 1 5.03 1 10c0 1.66.45 3.2 1.23 4.54L1 19l4.6-1.2A8.97 8.97 0 0010 19c4.97 0 9-4.03 9-9s-4.03-9-9-9z" fill="white" fillOpacity=".92"/>
          <circle cx="7" cy="10" r="1.1" fill="#1da851"/>
          <circle cx="10" cy="10" r="1.1" fill="#1da851"/>
          <circle cx="13" cy="10" r="1.1" fill="#1da851"/>
        </svg>
      </div>

      {/* Nav */}
      {NAV.map(item => (
        <button
          key={item.id}
          className={"sidebar-nav-btn" + (navTab===item.id ? " active" : "")}
          title={item.tip}
          onClick={()=>setNavTab(item.id)}
        >
          {item.icon}
        </button>
      ))}

      <div className="sidebar-spacer"/>

      <button className="sidebar-nav-btn" title="Pengaturan"><IconSettings/></button>
      <button className="sidebar-nav-btn" title="Keluar" onClick={handleLogout}><IconLogout/></button>

      {/* User avatar */}
      <div className="sidebar-avatar" style={{background:color}} title={name}>
        {initials(name)}
      </div>
    </div>
  )
}
