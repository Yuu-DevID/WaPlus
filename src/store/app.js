import { create } from "zustand"

// Mirror of normalizeJid from messageParser — single gate for all JIDs
function normalizeJid(jid) {
  if (!jid || typeof jid !== "string") return ""
  const atIdx = jid.lastIndexOf("@")
  if (atIdx === -1) return jid
  let user   = jid.slice(0, atIdx)
  let server = jid.slice(atIdx + 1)
  const colonIdx = user.indexOf(":")
  if (colonIdx !== -1) user = user.slice(0, colonIdx)
  if (server === "c.us") server = "s.whatsapp.net"
  return `${user}@${server}`
}

// Global app store — manages which view/panel is active
export const useAppStore = create((set) => ({
    // Active navigation tab: "chats" | "contacts" | "communities" | "settings"
    navTab: "chats",
    // Active chat filter: "all" | "unread" | "groups"
    chatFilter: "all",
    // Currently opened chat JID
    activeJid: null,
    // Right contact panel open/closed
    rightPanelOpen: false,
    // Current connected user info from Baileys
    connectedUser: null,

    setNavTab: (tab) => set({ navTab: tab }),
    setChatFilter: (f) => set({ chatFilter: f }),
    setActiveJid: (jid) => set({ activeJid: normalizeJid(jid) || jid }),
    setRightPanelOpen: (v) => set({ rightPanelOpen: v }),
    setConnectedUser: (u) => set({ connectedUser: u }),
    toggleRightPanel: () => set((s) => ({ rightPanelOpen: !s.rightPanelOpen })),

    // Media viewer — { items: [{src, type, caption, msgId}], index: number }
    mediaViewer: null,
    openMedia: (items, index = 0) => set({ mediaViewer: { items, index } }),
    closeMedia: () => set({ mediaViewer: null }),
}))
