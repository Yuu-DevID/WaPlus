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

// ── [FIX-3] Settings persistence helpers ──────────────────────────────────
// We use IPC (settings:load/settings:save) as the source of truth.
// For synchronous reads (initial render), we also mirror to localStorage
// as a warm cache since IPC is async.
function _readLocalCache() {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem("wplus_settings") : null
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}
function _writeLocalCache(settings) {
  try {
    if (typeof localStorage !== "undefined")
      localStorage.setItem("wplus_settings", JSON.stringify(settings))
  } catch {}
}

// Bootstrap defaults from localStorage cache (sync, instant)
const _cached = _readLocalCache()

// Global app store — manages which view/panel is active
export const useAppStore = create((set, get) => ({
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

    // [FIX-3] Settings — start from localStorage warm cache, hydrate from IPC on mount
    autoDownloadMedia: _cached.autoDownloadMedia !== undefined ? _cached.autoDownloadMedia : true,
    ramLimitMb: _cached.ramLimitMb || 256,

    setNavTab: (tab) => set({ navTab: tab }),
    setChatFilter: (f) => set({ chatFilter: f }),
    setActiveJid: (jid) => set({ activeJid: normalizeJid(jid) || jid }),
    setRightPanelOpen: (v) => set({ rightPanelOpen: v }),
    setConnectedUser: (u) => set({ connectedUser: u }),
    toggleRightPanel: () => set((s) => ({ rightPanelOpen: !s.rightPanelOpen })),

    // [FIX-3] Load persisted settings from electron userData via IPC
    loadSettings: async () => {
      try {
        const result = await window.api?.settingsLoad?.()
        if (result?.ok && result.data) {
          const s = result.data
          if (typeof s.autoDownloadMedia === "boolean") {
            set({ autoDownloadMedia: s.autoDownloadMedia })
            _writeLocalCache({ ..._readLocalCache(), autoDownloadMedia: s.autoDownloadMedia })
          }
        }
      } catch (_) {}
    },

    setRamLimitMb: async (mb) => {
      const safe = Math.min(512, Math.max(32, parseInt(mb, 10) || 256))
      set({ ramLimitMb: safe })
      _writeLocalCache({ ..._readLocalCache(), ramLimitMb: safe })
      try {
        await window.api?.settingsSetRamLimit?.({ mb: safe })
      } catch (_) {}
    },

    // [FIX-3] Toggle auto-download — persists to electron settings file + updates runtime CONFIG
    setAutoDownloadMedia: async (v) => {
      set({ autoDownloadMedia: v })
      _writeLocalCache({ ..._readLocalCache(), autoDownloadMedia: v })
      try {
        await window.api?.settingsSetAutoDownload?.({ enabled: v })
      } catch (_) {}
    },

    // Media viewer — { items: [{src, type, caption, msgId}], index: number }
    mediaViewer: null,
    openMedia: (items, index = 0) => set({ mediaViewer: { items, index } }),
    closeMedia: () => set({ mediaViewer: null }),
}))
