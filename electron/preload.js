// electron/preload.js
const { contextBridge, ipcRenderer } = require("electron")

// Helper untuk cleanup listeners
const createListener = (channel) => (callback) => {
  const handler = (_event, data) => callback(data)
  ipcRenderer.on(channel, handler)
  // Return cleanup function
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld("api", {
  // ═══════════════════════════════════════════════════════════
  // AUTH ACTIONS
  // ═══════════════════════════════════════════════════════════
  requestPairing: (phone) => ipcRenderer.send("auth:request-pairing", phone),
  startQRMode: () => ipcRenderer.send("auth:start-qr"),
  logout: () => ipcRenderer.send("auth:logout"),
  forceReconnect: () => ipcRenderer.send("connection:force-reconnect"),
  checkSession: () => ipcRenderer.invoke("auth:check-session"),

  // ═══════════════════════════════════════════════════════════
  // AUTH EVENTS (Listeners)
  // ═══════════════════════════════════════════════════════════
  onPairingCode: createListener("auth:pairing-code"),
  onPairingError: createListener("auth:pairing-error"),
  onQR: createListener("auth:qr"),
  onConnected: createListener("connection:open"),
  onNeedPhone: createListener("auth:need-phone-number"),
  onLoggedOut: createListener("auth:logged-out"),

  // ═══════════════════════════════════════════════════════════
  // CONNECTION EVENTS
  // ═══════════════════════════════════════════════════════════
  onConnectionClose: createListener("connection:close"),
  onReconnecting: createListener("connection:reconnecting"),
  onConnectionFailed: createListener("connection:failed"),
  onConnectionError: createListener("connection:error"),

  // ═══════════════════════════════════════════════════════════
  // SYNC STATUS (History Sync)
  // ═══════════════════════════════════════════════════════════
  onSyncStatus: createListener("sync:status"),

  // ═══════════════════════════════════════════════════════════
  // DATABASE: CHATS
  // ═══════════════════════════════════════════════════════════
  dbChats: (opts = {}) => ipcRenderer.invoke("db:chats:list", opts),
  dbSearchChats: (query) => ipcRenderer.invoke("db:chats:search", { query }),
  dbMarkRead: ({ jid }) => ipcRenderer.invoke("db:chats:read", { jid }),
  dbPinChat: ({ jid, pinned }) => ipcRenderer.invoke("db:chats:pin", { jid, pinned }),
  dbArchiveChat: ({ jid, archived }) => ipcRenderer.invoke("db:chats:archive", { jid, archived }),

  // Chat events
  onChatsUpdated: createListener("db:chats:updated"),
  onChatsSet: createListener("chats:set"),
  onChatsUpsert: createListener("chats:upsert"),

  // ═══════════════════════════════════════════════════════════
  // DATABASE: CONTACTS
  // ═══════════════════════════════════════════════════════════
  dbContacts: (opts = {}) => ipcRenderer.invoke("db:contacts:list", opts),
  dbSearchContacts: (query) => ipcRenderer.invoke("db:contacts:search", { query }),

  // Contact events
  onContactsUpdated: createListener("db:contacts:updated"),

  // ═══════════════════════════════════════════════════════════
  // DATABASE: GROUPS
  // ═══════════════════════════════════════════════════════════
  dbGroups: (opts = {}) => ipcRenderer.invoke("db:groups:list", opts),

  // ═══════════════════════════════════════════════════════════
  // DATABASE: COMMUNITIES
  // ═══════════════════════════════════════════════════════════
  dbCommunities: (opts = {}) => ipcRenderer.invoke("db:communities:list", opts),

  // ═══════════════════════════════════════════════════════════
  // DATABASE: MESSAGES
  // ═══════════════════════════════════════════════════════════
  dbMessages: ({ jid, limit = 50, offset = 0 }) =>
    ipcRenderer.invoke("db:messages:list", { jid, limit, offset }),
  dbSearchMsgs: ({ jid, query }) =>
    ipcRenderer.invoke("db:messages:search", { jid, query }),
  dbStats: () => ipcRenderer.invoke("db:stats"),
  dbReactions: ({ jid }) =>
    ipcRenderer.invoke("db:reactions:list", { jid }),
  dbBackfillPreviews: () => ipcRenderer.invoke("db:backfill:previews"),

  // Message events
  onNewMessage: createListener("db:messages:new"),
  onMessagesNew: createListener("messages:new"),
  onMessagesUpdate: createListener("messages:update"),
  onMessagesReaction: createListener("messages:reaction"),
  onMessagesDelete: createListener("messages:delete"),
  onMessagesReceipt: createListener("messages:receipt"),

  // ═══════════════════════════════════════════════════════════
  // MEDIA
  // ═══════════════════════════════════════════════════════════
  // FIX: Event baru — dipanggil main.js setelah media berhasil didownload
  // Renderer listen ini untuk update image bubble secara realtime
  onMediaUpdated: createListener("media:updated"),

  // [PREFETCH] Trigger background media download for a chat (fire-and-forget)
  // Call this when a chat scrolls into view or is clicked.
  mediaPrefetch: ({ jid, limit = 20 }) =>
    ipcRenderer.invoke("media:prefetch", { jid, limit }),

  // ═══════════════════════════════════════════════════════════
  // MESSAGING
  // ═══════════════════════════════════════════════════════════
  sendMessage: ({ jid, body, type = "text", mediaPath = null, quotedMsgId = null }) =>
    ipcRenderer.invoke("msg:send", { jid, body, type, mediaPath, quotedMsgId }),
  sendMedia: ({ jid, items, quotedMsgId = null }) =>
    ipcRenderer.invoke("msg:send-media", { jid, items, quotedMsgId }),

  // ═══════════════════════════════════════════════════════════
  // PRESENCE
  // ═══════════════════════════════════════════════════════════
  onPresenceUpdate: createListener("presence:update"),

  // ═══════════════════════════════════════════════════════════
  // PROFILE
  // ═══════════════════════════════════════════════════════════
  getProfilePic: ({ jid }) => ipcRenderer.invoke("profile:get-pic", { jid }),

  // ═══════════════════════════════════════════════════════════
  // FILESYSTEM
  // ═══════════════════════════════════════════════════════════
  // Check if a media file actually exists on disk (raw path or file:// URL).
  // Used by MessageBubble to show "downloading..." vs broken-image icon.
  fsExists: ({ rawPath }) => ipcRenderer.invoke("fs:exists", { rawPath }),

  // ═══════════════════════════════════════════════════════════
  // GROUP EVENTS
  // ═══════════════════════════════════════════════════════════
  onGroupsUpdate: createListener("groups:update"),
  onGroupParticipantsUpdate: createListener("groups:participants"),

  // ═══════════════════════════════════════════════════════════
  // CALL EVENTS
  // ═══════════════════════════════════════════════════════════
  onCallIncoming: createListener("call:incoming"),

  // ═══════════════════════════════════════════════════════════
  // LABELS
  // ═══════════════════════════════════════════════════════════
  onLabelsAssociation: createListener("labels:association"),
  onLabelsEdit: createListener("labels:edit"),

  // ═══════════════════════════════════════════════════════════
  // STATUS (WhatsApp Story)
  // ═══════════════════════════════════════════════════════════
  statusGetContactCount: ()        => ipcRenderer.invoke("status:get-contact-count"),
  statusSend:            (payload) => ipcRenderer.invoke("status:send", payload),

  // ═══════════════════════════════════════════════════════════
  // MOD / PLUGIN MANAGER
  // ═══════════════════════════════════════════════════════════
  modsList:       ()           => ipcRenderer.invoke("mods:list"),
  modsToggle:     ({ id, enabled }) => ipcRenderer.invoke("mods:toggle", { id, enabled }),
  modsReload:     ()           => ipcRenderer.invoke("mods:reload"),
  modsDetail:     ({ id })     => ipcRenderer.invoke("mods:detail", { id }),
  modsCreate:     (opts)       => ipcRenderer.invoke("mods:create", opts),
  modsOpenFolder: ({ id } = {}) => ipcRenderer.invoke("mods:open-folder", { id }),
  modsGetConfig:  ({ id })     => ipcRenderer.invoke("mods:get-config",  { id }),
  modsSaveConfig: ({ id, values }) => ipcRenderer.invoke("mods:save-config", { id, values }),
  modsPickImage:  ()           => ipcRenderer.invoke("mods:pick-image"),
  modsDelete:     ({ id })     => ipcRenderer.invoke("mods:delete", { id }),
  modsDeleteBulk: ({ ids })    => ipcRenderer.invoke("mods:delete-bulk", { ids }),
  modsUpdateHooks: ({ id, hooks }) => ipcRenderer.invoke("mods:update-hooks", { id, hooks }),
  openExternal:   (url)        => ipcRenderer.invoke("shell:open-external", url),
  onModsUpdated:  createListener("mods:updated"),
})