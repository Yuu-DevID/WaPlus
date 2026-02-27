const { app, BrowserWindow, ipcMain, protocol } = require("electron")
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

// ── Register custom protocol BEFORE app is ready ──────────────────
// Ini wajib agar file:// bisa diakses dari renderer (Electron security)
protocol.registerSchemesAsPrivileged([
  {
    scheme: "media",
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
      bypassCSP: true,
    },
  },
])

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
      // ── FIX 1: Allow file:// protocol dari renderer ──
      webSecurity: false,
    },
  })

  win.once("ready-to-show", () => win.show())

  if (isDev) {
    win.loadURL("http://localhost:5173")
  } else {
    win.loadFile(path.join(__dirname, "../dist/index.html"))
  }

  // ── FIX 2: Register custom "media://" protocol sebagai alternatif ──
  // Renderer bisa pakai: media:///absolute/path/to/file.jpg
  // Lebih aman daripada file:// langsung
  win.webContents.session.protocol.registerFileProtocol("media", (request, callback) => {
    try {
      // Strip "media://" prefix
      const url = request.url.replace("media://", "")
      // Decode URL encoding
      const filePath = decodeURIComponent(url)
      callback({ path: filePath })
    } catch (err) {
      console.error("[AuroraChat] Protocol error:", err.message)
      callback({ error: -2 }) // net::ERR_FAILED
    }
  })

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
    return {
      ok: true,
      message: {
        key: result?.key || {},
        id: result?.key?.id || null,
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
// ════════════════════════════════════════════════════════════

module.exports.onBaileysMessage = function (payload) {
  try {
    const d = getDB()
    const msgId = payload.key?.id
    if (!msgId) return

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

    // Push ke renderer — media_saved_path mungkin belum ada saat ini,
    // akan di-update via "media:updated" event setelah download selesai
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
        // FIX 3: media_saved_path awalnya null, akan di-update via event "media:updated"
        media_saved_path: null,
        media_url: payload.mediaUrl || null,
        is_group: payload.isGroup ? 1 : 0,
      }
    })

    win?.webContents.send("db:chats:updated")
  } catch (err) {
    console.error("[AuroraChat] DB write error:", err.message)
  }
}

// ── FIX 4: Event baru — dipanggil dari client.js setelah media selesai didownload ──
// Renderer listen event ini lalu update state message yang sudah ada
module.exports.onMediaDownloaded = function ({ msgId, chatJid, localPath }) {
  try {
    if (!msgId || !localPath) return
    // Normalize path jadi forward slash dan pastikan ada file:// prefix
    const normalized = localPath.replace(/\\/g, "/")
    const fileUrl = normalized.startsWith("file://") ? normalized : `file://${normalized}`

    win?.webContents.send("media:updated", {
      id: msgId,
      chat_jid: chatJid,
      media_saved_path: fileUrl,
    })

    console.log(`[AuroraChat] Media ready → renderer: ${msgId}`)
  } catch (err) {
    console.error("[AuroraChat] onMediaDownloaded error:", err.message)
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