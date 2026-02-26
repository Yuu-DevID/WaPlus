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

  // Message events
  onNewMessage: createListener("db:messages:new"),
  onMessagesNew: createListener("messages:new"),
  onMessagesUpdate: createListener("messages:update"),
  onMessagesReaction: createListener("messages:reaction"),
  onMessagesDelete: createListener("messages:delete"),
  onMessagesReceipt: createListener("messages:receipt"),

  // ═══════════════════════════════════════════════════════════
  // MESSAGING
  // ═══════════════════════════════════════════════════════════
  sendMessage: ({ jid, body, type = "text", mediaPath = null }) =>
    ipcRenderer.invoke("msg:send", { jid, body, type, mediaPath }),

  // ═══════════════════════════════════════════════════════════
  // PRESENCE
  // ═══════════════════════════════════════════════════════════
  onPresenceUpdate: createListener("presence:update"),

  // ═══════════════════════════════════════════════════════════
  // PROFILE
  // ═══════════════════════════════════════════════════════════
  getProfilePic: ({ jid }) => ipcRenderer.invoke("profile:get-pic", { jid }),

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
})