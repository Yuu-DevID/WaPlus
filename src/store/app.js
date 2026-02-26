import { create } from "zustand"

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
    setActiveJid: (jid) => set({ activeJid: jid }),
    setRightPanelOpen: (v) => set({ rightPanelOpen: v }),
    setConnectedUser: (u) => set({ connectedUser: u }),
    toggleRightPanel: () => set((s) => ({ rightPanelOpen: !s.rightPanelOpen })),
}))
