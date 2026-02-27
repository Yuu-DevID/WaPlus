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
      // ── FIX-MEDIA: Allow mixed content & local media files ──
      allowRunningInsecureContent: true,
    },
  })

  win.once("ready-to-show", () => win.show())

  if (isDev) {
    win.loadURL("http://localhost:5173")
  } else {
    win.loadFile(path.join(__dirname, "../dist/index.html"))
  }

  // ── FIX 2: Register custom "media://" protocol sebagai alternatif ──
  // Renderer bisa pakai: media:///absolute/path/to/file.webp
  // Menangani webp/sticker/gambar dengan mime type yang benar
  win.webContents.session.protocol.registerFileProtocol("media", (request, callback) => {
    try {
      // Strip "media://" prefix
      const url = request.url.replace("media://", "")
      // Decode URL encoding
      const filePath = decodeURIComponent(url)
      // Deteksi mime type dari ekstensi untuk webp/sticker
      const ext = path.extname(filePath).toLowerCase().slice(1)
      const mimeMap = {
        webp: "image/webp",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        png: "image/png",
        gif: "image/gif",
        mp4: "video/mp4",
        ogg: "audio/ogg",
        mp3: "audio/mpeg",
        m4a: "audio/mp4",
      }
      const mimeType = mimeMap[ext] || "application/octet-stream"
      callback({ path: filePath, mimeType })
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
ipcMain.handle("msg:send", async (_e, { jid, body, type = "text", quotedMsgId = null }) => {
  try {
    if (!baileysClient) return { ok: false, error: "Client belum siap." }

    let quotedWAMsg = null

    // [REPLY] Rebuild proper WAMessage object dari DB untuk Baileys quoted param.
    // Persis seperti cara case.js: { quoted: m } dimana m adalah full WAMessage
    // dengan key, message, messageTimestamp, pushName, participant.
    // Baileys butuh ini untuk membangun contextInfo yang benar di pesan terkirim.
    if (quotedMsgId) {
      try {
        const d = getDB()
        const row = d.getMessageById?.(quotedMsgId)
        if (row) {
          // Parse raw message JSON yang disimpan saat receive
          let rawMessage = null
          if (row.message_json) {
            try { rawMessage = JSON.parse(row.message_json) } catch (_) {}
          }

          // Fallback: buat minimal message object dari field DB
          if (!rawMessage) {
            rawMessage = row.body
              ? { conversation: row.body }
              : { conversation: "" }
          }

          // Build WAMessage object — format yang sama dengan apa yang Baileys emit
          // key.participant hanya diisi untuk pesan di group (bukan from_me)
          const isGroup = (row.remote_jid || "").endsWith("@g.us")
          const participant = isGroup && !row.from_me && row.participant
            ? row.participant
            : undefined

          quotedWAMsg = {
            key: {
              remoteJid:  row.remote_jid,
              fromMe:     row.from_me === 1,
              id:         row.id,
              ...(participant ? { participant } : {}),
            },
            message:          rawMessage,
            messageTimestamp: row.message_timestamp || Math.floor(Date.now() / 1000),
            pushName:         row.push_name || null,
          }
        }
      } catch (qErr) {
        console.warn("[AuroraChat] Could not fetch quoted message:", qErr.message)
      }
    }

    const result = await baileysClient.sendTextMessage(
      jid,
      body,
      quotedWAMsg ? { quoted: quotedWAMsg } : {}
    )

    return {
      ok: true,
      message: {
        key: result?.key || {},
        id:  result?.key?.id || null,
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

// ── Media prefetch IPC ────────────────────────────────────
// Called by renderer when a chat scrolls into view or is clicked.
// Triggers background download of all pending media for a chat.
// Fire-and-forget: returns immediately, downloads happen in background.
// Each downloaded file emits a "media:updated" event to the renderer.
ipcMain.handle("media:prefetch", async (_e, { jid, limit = 20 }) => {
  try {
    if (!baileysClient) return { ok: false, queued: 0 }
    const db = getDB()
    const pending = db.getMediaPendingForChat?.(jid, limit) || []
    if (pending.length === 0) return { ok: true, queued: 0 }

    // Kick off downloads in background — do NOT await
    setImmediate(async () => {
      for (const row of pending) {
        try {
          await baileysClient.downloadMediaForMsg?.(row)
        } catch (_) {}
      }
    })

    return { ok: true, queued: pending.length }
  } catch (err) {
    return { ok: false, error: err.message }
  }
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

    // Send the RAW local path to the renderer.
    // MessageBubble.pathToFileUrl() is the single conversion point —
    // it correctly handles Windows drive letters (D:\), Unix paths, and spaces.
    // Pre-converting to file:// here caused D: → D%3A corruption on Windows.
    win?.webContents.send("media:updated", {
      id: msgId,
      chat_jid: chatJid,
      media_saved_path: localPath,   // raw path — renderer converts via pathToFileUrl
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

// ── File existence check — renderer uses this to detect missing/deleted media ─
// Accepts raw paths (D:\path\file) or file:// URLs.
ipcMain.handle("fs:exists", (_e, { rawPath }) => {
  try {
    if (!rawPath) return false
    let p = rawPath
    if (p.startsWith("file://")) {
      p = decodeURIComponent(p.replace(/^file:\/\/\/?/, ""))
      p = p.replace(/^([A-Za-z])%3A/i, "$1:")
      if (process.platform !== "win32" && !p.startsWith("/")) p = "/" + p
    } else {
      // Raw Windows path: D:\path → normalize
      p = p.replace(/\\/g, "/")
    }
    return require("fs").existsSync(p)
  } catch {
    return false
  }
})