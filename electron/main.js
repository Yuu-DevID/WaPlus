// electron/main.js
// ╔═══════════════════════════════════════════════════════════╗
// ║             WaPlus — Electron Main Process                ║
// ╚═══════════════════════════════════════════════════════════╝
const { app, BrowserWindow, ipcMain } = require("electron")
const path = require("path")
const fs = require("fs")

const isDev = !app.isPackaged

function hasExistingSession() {
  const sessionDir = path.resolve(__dirname, "./baileys/session")
  const credsPath = path.join(sessionDir, "creds.json")
  if (!fs.existsSync(credsPath)) return false
  try {
    const creds = JSON.parse(fs.readFileSync(credsPath, "utf8"))
    return !!(creds && creds.me)
  } catch { return false }
}

let win = null
let baileysClient = null
let db = null

function getDB() {
  if (!db) db = require("./db/database")
  return db
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 600,
    backgroundColor: "#080e18",
    show: false,
    frame: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.once("ready-to-show", () => win.show())

  if (isDev) {
    win.loadURL("http://localhost:5173")
  } else {
    win.loadFile(path.join(__dirname, "../dist/index.html"))
  }

  try { getDB().init(); console.log("[WaPlus] Database initialized") }
  catch (err) { console.error("[WaPlus] DB init error:", err.message) }

  try {
    baileysClient = require("./baileys/client")
    baileysClient.init(win)
  } catch (err) { console.error("[WaPlus] Baileys init error:", err.message) }
}

// ════════════════════════════════════════════════════════════
// IPC — AUTH
// ════════════════════════════════════════════════════════════
ipcMain.on("auth:request-pairing", async (_e, phone) => {
  try {
    if (baileysClient) await baileysClient.requestPairingCode(phone)
    else win?.webContents.send("auth:pairing-error", { message: "Client belum siap." })
  } catch (err) { console.error("[WaPlus]", err.message) }
})

ipcMain.on("auth:start-qr", async () => {
  try { if (baileysClient) await baileysClient.startQRMode() }
  catch (err) { console.error("[WaPlus]", err.message) }
})

ipcMain.on("auth:logout", async () => {
  try {
    if (baileysClient) await baileysClient.logout()
    getDB().close(); db = null
  } catch (err) { console.error("[WaPlus]", err.message) }
})

ipcMain.on("connection:force-reconnect", async () => {
  try { if (baileysClient) await baileysClient.forceReconnect() }
  catch (err) { console.error("[WaPlus]", err.message) }
})

ipcMain.handle("auth:check-session", () => ({ hasSession: hasExistingSession() }))

// ════════════════════════════════════════════════════════════
// IPC — SEND MESSAGE
// ════════════════════════════════════════════════════════════
ipcMain.handle("msg:send", async (_e, { jid, body, type = "text" }) => {
  try {
    if (!baileysClient) return { ok: false, error: "Client belum siap." }
    const result = await baileysClient.sendTextMessage(jid, body)
    return { ok: true, message: result }
  } catch (err) { return { ok: false, error: err.message } }
})

// ════════════════════════════════════════════════════════════
// IPC — DATABASE CHATS
// ════════════════════════════════════════════════════════════
ipcMain.handle("db:chats:list", (_e, { limit = 60, offset = 0 } = {}) => {
  try { return { ok: true, data: getDB().getChats(limit, offset), total: getDB().getChatCount() } }
  catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle("db:chats:search", (_e, { query }) => {
  try { return { ok: true, data: getDB().searchChats(query) } }
  catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle("db:chats:read", (_e, { jid }) => {
  try { getDB().markChatRead(jid); return { ok: true } }
  catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle("db:chats:pin", (_e, { jid, pinned }) => {
  try { getDB().pinChat(jid, pinned); return { ok: true } }
  catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle("db:chats:archive", (_e, { jid, archived }) => {
  try { getDB().archiveChat(jid, archived); return { ok: true } }
  catch (err) { return { ok: false, error: err.message } }
})

// ════════════════════════════════════════════════════════════
// IPC — DATABASE CONTACTS
// ════════════════════════════════════════════════════════════
ipcMain.handle("db:contacts:list", (_e, { limit = 100, offset = 0 } = {}) => {
  try { return { ok: true, data: getDB().getContacts(limit, offset), total: getDB().getContactCount() } }
  catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle("db:contacts:search", (_e, { query }) => {
  try { return { ok: true, data: getDB().searchContacts(query) } }
  catch (err) { return { ok: false, error: err.message } }
})

// ════════════════════════════════════════════════════════════
// IPC — DATABASE GROUPS & COMMUNITIES
// ════════════════════════════════════════════════════════════
ipcMain.handle("db:groups:list", (_e, { limit = 200, offset = 0 } = {}) => {
  try { return { ok: true, data: getDB().getGroups(limit, offset), total: getDB().getGroupCount() } }
  catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle("db:communities:list", (_e, { limit = 100, offset = 0 } = {}) => {
  try { return { ok: true, data: getDB().getCommunities(limit, offset), total: getDB().getCommunityCount() } }
  catch (err) { return { ok: false, error: err.message } }
})

// ════════════════════════════════════════════════════════════
// IPC — DATABASE MESSAGES
// ════════════════════════════════════════════════════════════
ipcMain.handle("db:messages:list", (_e, { jid, limit = 50, offset = 0 }) => {
  try {
    return {
      ok: true,
      data: getDB().getMessages(jid, limit, offset),
      total: getDB().getMessageCount(jid),
    }
  } catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle("db:messages:search", (_e, { jid, query }) => {
  try {
    const data = jid
      ? getDB().searchMessages(jid, query)
      : getDB().searchMessagesGlobal(query)
    return { ok: true, data }
  } catch (err) { return { ok: false, error: err.message } }
})

// ════════════════════════════════════════════════════════════
// IPC — STATS & SYNC
// ════════════════════════════════════════════════════════════
ipcMain.handle("db:stats", () => {
  try { return { ok: true, data: getDB().getStats() } }
  catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle("db:sync:status", () => {
  try { return { ok: true, data: getDB().getSyncStatus() } }
  catch (err) { return { ok: false, error: err.message } }
})

// ════════════════════════════════════════════════════════════
// PROFILE PIC
// ════════════════════════════════════════════════════════════
ipcMain.handle("profile:get-pic", async (_e, { jid }) => {
  try {
    if (!baileysClient) return { ok: false, url: null }
    const info = await baileysClient.getContactInfo(jid)
    return { ok: true, url: info.imgUrl }
  } catch { return { ok: false, url: null } }
})

// ════════════════════════════════════════════════════════════
// BAILEYS EVENT → DB BRIDGE
// Called from baileys/client.js
// ════════════════════════════════════════════════════════════

/**
 * Dipanggil dari client.js setiap ada pesan masuk (live & offline).
 * Meneruskan ke database dan push update ke renderer.
 */
module.exports.onBaileysMessage = function (payload) {
  try {
    const d = getDB()
    d.insertMessage({
      id: payload.key?.id || `${Date.now()}`,
      chat_jid: payload.jid,
      sender_jid: payload.sender,
      sender_name: payload.pushname,
      body: payload.body || null,
      msg_type: payload.msgType || "conversation",
      timestamp: payload.timestamp,
      status: payload.status || 0,
      from_me: payload.isMe ? 1 : 0,
      is_group: payload.isGroup ? 1 : 0,
      has_media: payload.hasMedia ? 1 : 0,
      starred: payload.starred ? 1 : 0,
      quoted_id: null,
      raw: null,
      // ↓ TAMBAHKAN INI:
      media_url: null, media_mime: null, media_size: null,
      media_filename: null, media_duration: null,
      media_width: null, media_height: null,
      media_is_downloaded: 0, media_download_status: "pending",
      is_view_once: 0, is_ephemeral: 0, ephemeral_expiry: null,
      poll_options: null, poll_votes: null,
      location_lat: null, location_lng: null,
      location_name: null, location_address: null,
      contact_display_name: null, contact_vcard: null,
      reaction_emoji: null, reaction_target_id: null,
      is_forwarded: 0, forward_score: 0,
      quoted_body: null, quoted_sender: null, quoted_type: null,
      message_json: null, is_deleted: 0, source: "live",
    })

    // Push ke renderer
    win?.webContents.send("db:messages:new", {
      chat_jid: payload.jid,
      message: {
        id: payload.key?.id,
        chat_jid: payload.jid,
        sender_name: payload.pushname,
        body: payload.body,
        msg_type: payload.msgType,
        timestamp: payload.timestamp,
        from_me: payload.isMe ? 1 : 0,
        status: payload.status || 0,
        has_media: payload.hasMedia ? 1 : 0,
        // Media extras
        media_url: payload.mediaUrl || null,
        media_mime: payload.mediaMime || null,
        media_filename: payload.mediaFilename || null,
        is_view_once: payload.isViewOnce ? 1 : 0,
        is_ephemeral: payload.isEphemeral ? 1 : 0,
        poll_options: payload.pollOptions || null,
        location_lat: payload.locationLat || null,
        location_lng: payload.locationLng || null,
        reaction_emoji: payload.reactionEmoji || null,
        reaction_target_id: payload.reactionTargetId || null,
      }
    })
    win?.webContents.send("db:chats:updated")
  } catch (err) { console.error("[WaPlus] DB write error:", err.message) }
}

module.exports.onBaileysChats = function (chats) {
  try {
    const d = getDB()
    for (const c of chats) d.saveChat(c)
    win?.webContents.send("chats:set", chats)
    win?.webContents.send("db:chats:updated")
  } catch (err) { console.error("[WaPlus] DB chats error:", err.message) }
}

module.exports.onBaileysContacts = function (contacts) {
  try {
    getDB().saveContacts(contacts)
    win?.webContents.send("db:contacts:updated")
  } catch (err) { console.error("[WaPlus] DB contacts error:", err.message) }
}

module.exports.onBaileysSyncStart = function () {
  win?.webContents.send("sync:status", { status: "syncing", isSyncing: true, progress: 0 })
}

module.exports.onBaileysSyncDone = function (stats) {
  win?.webContents.send("sync:status", {
    status: "done", isSyncing: false, progress: 100,
    stats: stats || { chats: 0, messages: 0 }
  })
  win?.webContents.send("db:chats:updated")
}

// ════════════════════════════════════════════════════════════
// APP LIFECYCLE
// ════════════════════════════════════════════════════════════
app.whenReady().then(createWindow)

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})

app.on("will-quit", () => {
  try { if (db) db.close() } catch (_) { }
})

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
