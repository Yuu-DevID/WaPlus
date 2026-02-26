const { app, BrowserWindow, ipcMain } = require("electron")
const path = require("path")
const fs = require("fs")

const isDev = !app.isPackaged

// Check if a valid WA session exists (creds.json with me field)
function hasExistingSession() {
  const sessionDir = path.resolve(__dirname, "./baileys/session")
  const credsPath = path.join(sessionDir, "creds.json")
  if (!fs.existsSync(credsPath)) return false
  try {
    const creds = JSON.parse(fs.readFileSync(credsPath, "utf8"))
    return !!(creds && creds.me)
  } catch {
    return false
  }
}

let win
let baileysClient = null
let db = null

// ── DB must be required AFTER app is ready (needs userData path) ──
function getDB() {
  if (!db) db = require("./baileys/database")  // single source of truth
  return db
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 600,
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

  // ── Init DB ─────────────────────────────────────
  try {
    getDB().init()
    console.log("[AuroraChat] Database initialized")
  } catch (err) {
    console.error("[AuroraChat] DB init error:", err.message)
  }

  // ── Init Baileys ─────────────────────────────────
  try {
    baileysClient = require("./baileys/client")
    baileysClient.init(win)
  } catch (err) {
    console.error("[AuroraChat] Baileys init error:", err.message)
  }
}

// ════════════════════════════════════════════════════════════
// IPC — AUTH
// ════════════════════════════════════════════════════════════

ipcMain.on("auth:request-pairing", async (_e, phone) => {
  console.log("[AuroraChat] Pairing for:", phone)
  try {
    if (baileysClient) await baileysClient.requestPairingCode(phone)
    else win?.webContents.send("auth:pairing-error", { message: "Client belum siap." })
  } catch (err) {
    console.error("[AuroraChat]", err.message)
  }
})

ipcMain.on("auth:start-qr", async () => {
  try {
    if (baileysClient) await baileysClient.startQRMode()
  } catch (err) {
    console.error("[AuroraChat]", err.message)
  }
})

// ── Send Message ────────────────────────────────────────────
ipcMain.handle("msg:send", async (_e, { jid, body, type = "text" }) => {
  try {
    if (!baileysClient) return { ok: false, error: "Client belum siap." }
    const result = await baileysClient.sendTextMessage(jid, body)
    // result adalah WAMessage dari Baileys: { key: { id, remoteJid, fromMe }, ... }
    // Pastikan key.id tersedia untuk dedup di renderer
    return {
      ok: true,
      message: {
        key: result?.key || {},
        id: result?.key?.id || null,  // shortcut untuk kemudahan akses
      }
    }
  } catch (err) {
    console.error("[AuroraChat] sendMessage error:", err.message)
    return { ok: false, error: err.message }
  }
})

ipcMain.on("auth:logout", async () => {
  try {
    if (baileysClient) await baileysClient.logout()
    getDB().close()
    db = null
  } catch (err) {
    console.error("[AuroraChat]", err.message)
  }
})

ipcMain.on("connection:force-reconnect", async () => {
  try {
    if (baileysClient) await baileysClient.forceReconnect()
  } catch (err) {
    console.error("[AuroraChat]", err.message)
  }
})

// ════════════════════════════════════════════════════════════
// IPC — DATABASE (synchronous via invoke)
// ════════════════════════════════════════════════════════════

// ── Chats ─────────────────────────────────────────────────
ipcMain.handle("db:chats:list", (_e, { limit = 60, offset = 0 } = {}) => {
  try { return { ok: true, data: getDB().getChats(limit, offset), total: getDB().getChatCount() } }
  catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle("db:chats:search", (_e, { query }) => {
  try {
    const d = getDB()
    const fn = d.searchChats || d.searchContacts
    return { ok: true, data: fn ? fn.call(d, query) : [] }
  } catch (err) { return { ok: false, error: err.message } }
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

// ── Contacts ───────────────────────────────────────────────
ipcMain.handle("db:contacts:list", (_e, { limit = 100, offset = 0 } = {}) => {
  try { return { ok: true, data: getDB().getContacts(limit, offset), total: getDB().getContactCount() } }
  catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle("db:contacts:search", (_e, { query }) => {
  try { return { ok: true, data: getDB().searchContacts(query) } }
  catch (err) { return { ok: false, error: err.message } }
})

// ── Groups ─────────────────────────────────────────────────
ipcMain.handle("db:groups:list", (_e, { limit = 200, offset = 0 } = {}) => {
  try { return { ok: true, data: getDB().getGroups(limit, offset), total: getDB().getGroupCount() } }
  catch (err) { return { ok: false, error: err.message } }
})

// ── Communities ────────────────────────────────────────────
ipcMain.handle("db:communities:list", (_e, { limit = 100, offset = 0 } = {}) => {
  try { return { ok: true, data: getDB().getCommunities(limit, offset), total: getDB().getCommunityCount() } }
  catch (err) { return { ok: false, error: err.message } }
})

// ── Messages ───────────────────────────────────────────────
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

ipcMain.handle("db:stats", () => {
  try { return { ok: true, data: getDB().getStats() } }
  catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle("db:sync:status", () => {
  try {
    if (!baileysClient) return { ok: false, error: "Client not ready" }
    const status = baileysClient.getSyncStatus()
    return { ok: true, data: status }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// ════════════════════════════════════════════════════════════
// BAILEYS EVENT → DB BRIDGE
// Called from baileys/client.js via direct require
// ════════════════════════════════════════════════════════════
// This module exports a function that the Baileys client can call
// to write events to SQLite without going through IPC
module.exports.onBaileysMessage = function (payload) {
  try {
    const d = getDB()
    // ID selalu dari payload.key.id (Baileys WAMessage key)
    const msgId = payload.key?.id
    if (!msgId) return // abaikan pesan tanpa ID valid

    d.insertMessage({
      id: msgId,
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
    })

    // Ambil media path dari DB setelah insert (bisa sudah didownload)
    let mediaSavedPath = null
    let mediaUrl = null
    try {
      const saved = d.getMessageById?.(msgId)
      mediaSavedPath = saved?.media_saved_path || null
      mediaUrl = saved?.media_url || null
    } catch (_) {}

    // Push ke renderer — payload harus lengkap agar MessageBubble bisa render
    win?.webContents.send("db:messages:new", {
      chat_jid: payload.jid,
      message: {
        id: msgId,
        chat_jid: payload.jid,
        sender_name: payload.pushname,
        body: payload.body,
        msg_type: payload.msgType,
        timestamp: payload.timestamp,
        from_me: payload.isMe ? 1 : 0,
        status: payload.status || 0,
        has_media: payload.hasMedia ? 1 : 0,
        mimetype: payload.mimetype || null,
        duration: payload.duration || null,
        media_saved_path: mediaSavedPath,
        media_url: mediaUrl,
        is_group: payload.isGroup ? 1 : 0,
      }
    })

    // Refresh chat list sidebar
    win?.webContents.send("db:chats:updated")
  } catch (err) {
    console.error("[AuroraChat] DB write error:", err.message)
  }
}

module.exports.onBaileysChats = function (chats) {
  try {
    const d = getDB()
    for (const c of chats) {
      const jid = c.id || ""
      const isCommunity = jid.endsWith("@newsletter") || (c.isCommunity === true)
      const isGroup = jid.endsWith("@g.us")
      d.upsertChat({
        jid,
        name: c.name || c.subject || null,
        isGroup,
        isCommunity,
        communityJid: c.linkedParent || null,
        phone: jid.split("@")[0] || null,
        lastMsgAt: c.conversationTimestamp ? Number(c.conversationTimestamp) : 0,
        unreadDelta: c.unreadCount || 0,
      })
    }
    win?.webContents.send("chats:set", chats)
    win?.webContents.send("db:chats:updated")
  } catch (err) {
    console.error("[AuroraChat] DB chats error:", err.message)
  }
}

module.exports.onBaileysContacts = function (contacts) {
  try {
    getDB().bulkUpsertContacts(contacts)
    win?.webContents.send("db:contacts:updated")
  } catch (err) {
    console.error("[AuroraChat] DB contacts error:", err.message)
  }
}

module.exports.onBaileysSyncStart = function () {
  win?.webContents.send("sync:status", { status: "syncing", isSyncing: true, progress: 0 })
}

module.exports.onBaileysSyncDone = function () {
  win?.webContents.send("sync:status", { status: "done", isSyncing: false, progress: 100 })
  win?.webContents.send("db:chats:updated")
}

// ── App Lifecycle ─────────────────────────────────────────
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
// ── Session check IPC ────────────────────────────────────
ipcMain.handle("auth:check-session", () => {
  return { hasSession: hasExistingSession() }
})

// ── Profile picture IPC ──────────────────────────────────
ipcMain.handle("profile:get-pic", async (_e, { jid }) => {
  try {
    if (!baileysClient) return { ok: false, url: null }
    const info = await baileysClient.getContactInfo(jid)
    return { ok: true, url: info.imgUrl }
  } catch {
    return { ok: false, url: null }
  }
})