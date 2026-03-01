const { app, BrowserWindow, ipcMain, protocol } = require("electron")
const path = require("path")
const fs = require("fs")

const isDev = !app.isPackaged

// Check if a valid WA session exists
// Priority: creds.json with "me" field — fallback: session folder has any files
function hasExistingSession() {
  const sessionDir = path.resolve(__dirname, "./baileys/session")
  if (!fs.existsSync(sessionDir)) return false
  // Primary: check creds.json has me field (fully authenticated)
  const credsPath = path.join(sessionDir, "creds.json")
  if (fs.existsSync(credsPath)) {
    try {
      const creds = JSON.parse(fs.readFileSync(credsPath, "utf8"))
      if (creds && creds.me) return true
    } catch { /* fall through */ }
  }
  // Fallback: if session folder has any content, assume session exists
  // (handles cases where creds.json exists but "me" not yet populated)
  try {
    const files = fs.readdirSync(sessionDir)
    return files.length > 0
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

// ── Send Media (images/video/doc from drag&drop or paste) ──────────────────
ipcMain.handle("msg:send-media", async (_e, { jid, items, quotedMsgId }) => {
  try {
    if (!baileysClient) return { ok: false, error: "Client belum siap." }

    let quotedWAMsg = null
    if (quotedMsgId) {
      try {
        const d   = getDB()
        const row = d.getMessageById?.(quotedMsgId)
        if (row) {
          let rawMessage = null
          try { rawMessage = JSON.parse(row.message_json) } catch (_) {}
          if (!rawMessage) rawMessage = row.body ? { conversation: row.body } : { conversation: "" }
          const isGrp = (row.remote_jid || "").endsWith("@g.us")
          const part  = isGrp && !row.from_me && row.participant ? row.participant : undefined
          quotedWAMsg = {
            key: { remoteJid: row.remote_jid, fromMe: row.from_me === 1, id: row.id, ...(part ? { participant: part } : {}) },
            message: rawMessage,
            messageTimestamp: row.message_timestamp || Math.floor(Date.now() / 1000),
            pushName: row.push_name || null,
          }
        }
      } catch (_) {}
    }

    const results = []
    for (const item of items) {
      const base64 = item.dataUrl.split(",")[1]
      const buf    = Buffer.from(base64, "base64")
      let r
      if (item.mimeType?.startsWith("image/")) {
        r = await baileysClient.sendImage(jid, buf, item.caption || "", quotedWAMsg)
      } else if (item.mimeType?.startsWith("video/")) {
        r = await baileysClient.sendVideo(jid, buf, item.caption || "", quotedWAMsg)
      } else {
        const fname = item.fileName || "file"
        r = await baileysClient.sendDocument(jid, buf, fname, item.mimeType || "application/octet-stream", item.caption || "", quotedWAMsg)
      }
      results.push({ ok: true, id: r?.key?.id })
      quotedWAMsg = null
    }
    return { ok: true, results }
  } catch (err) {
    console.error("[AuroraChat] sendMedia error:", err.message)
    return { ok: false, error: err.message }
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

// ── View Raw Message — fetch full DB row + raw message_json ──────────────────
// Used by the "View Raw" context menu item to show unparsed proto data.
ipcMain.handle("db:messages:raw", (_e, { id }) => {
  try {
    const db = getDB()
    const row = db.getMessageById?.(id)
    if (!row) return { ok: false, error: "Message not found" }
    // Parse message_json if stored, so renderer sees real object
    let parsedJson = null
    if (row.message_json) {
      try { parsedJson = JSON.parse(row.message_json) } catch (_) { parsedJson = row.message_json }
    }
    return {
      ok: true,
      data: {
        ...row,
        _message_json_parsed: parsedJson,
      }
    }
  } catch (err) { return { ok: false, error: err.message } }
})

ipcMain.handle("db:reactions:list", (_e, { jid }) => {
  try {
    return { ok: true, data: getDB().getReactionsForChat(jid) }
  } catch (err) { return { ok: false, error: err.message } }
})

// ── Backfill last message preview untuk history chats ─────────────────────
// Dipanggil setelah loadChats() menemukan chats dengan last_message_body null.
// Menjalankan backfillChatLastMessages() yang mengisi dari tabel messages.
ipcMain.handle("db:backfill:previews", () => {
  try {
    const d = getDB()
    if (d.backfillChatLastMessages) d.backfillChatLastMessages()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
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

// ════════════════════════════════════════════════════════════
// IPC — STATUS (WhatsApp Story)
// ════════════════════════════════════════════════════════════

ipcMain.handle("status:get-contact-count", () => {
  try {
    if (!baileysClient) return { ok: false, count: 0 }
    const list = baileysClient.getStatusJidList()
    return { ok: true, count: list.length }
  } catch (err) {
    return { ok: false, count: 0, error: err.message }
  }
})

ipcMain.handle("status:send", async (_e, payload) => {
  try {
    if (!baileysClient) return { ok: false, error: "Client belum siap" }

    // mediaBuffer comes as array from IPC serialization — convert back to Buffer
    if (payload.mediaBuffer) {
      payload.mediaBuffer = Buffer.from(payload.mediaBuffer)
    }

    const result = await baileysClient.sendStatus(payload)
    return { ok: true, count: result.count }
  } catch (err) {
    console.error("[AuroraChat] status:send error:", err.message)
    return { ok: false, error: err.message }
  }
})

// ════════════════════════════════════════════════════════════
// IPC — MOD MANAGER
// ════════════════════════════════════════════════════════════

function getModManager() {
  try { return require("./mods/modManager") } catch { return null }
}

ipcMain.handle("mods:list", () => {
  const mm = getModManager()
  if (!mm) return { ok: false, data: [] }
  return { ok: true, data: mm.listPlugins() }
})

ipcMain.handle("mods:toggle", async (_e, { id, enabled }) => {
  const mm = getModManager()
  if (!mm) return { ok: false, error: "ModManager not available" }
  return await mm.togglePlugin(id, enabled)
})

ipcMain.handle("mods:reload", async () => {
  const mm = getModManager()
  if (!mm) return { ok: false, error: "ModManager not available" }
  return await mm.reloadPlugins()
})

ipcMain.handle("mods:detail", (_e, { id }) => {
  const mm = getModManager()
  if (!mm) return { ok: false, error: "ModManager not available" }
  const detail = mm.getPluginDetail(id)
  return detail ? { ok: true, data: detail } : { ok: false, error: "Plugin not found" }
})

ipcMain.handle("mods:create", async (_e, { id, name, description, hooks }) => {
  const mm = getModManager()
  if (!mm) return { ok: false, error: "ModManager not available" }
  return await mm.createPlugin(id, name, description, hooks)
})

ipcMain.handle("mods:open-folder", (_e, { id }) => {
  const mm = getModManager()
  if (mm) mm.openPluginFolder(id)
  return { ok: true }
})

ipcMain.handle("mods:get-config", (_e, { id }) => {
  const mm = getModManager()
  if (!mm) return { ok: false, error: "ModManager not available" }
  const data = mm.getPluginConfig(id)
  return data ? { ok: true, data } : { ok: false, error: "Plugin not found" }
})

ipcMain.handle("mods:save-config", async (_e, { id, values }) => {
  const mm = getModManager()
  if (!mm) return { ok: false, error: "ModManager not available" }
  return await mm.savePluginConfig(id, values)
})

ipcMain.handle("mods:delete", async (_e, { id }) => {
  const mm = getModManager()
  if (!mm) return { ok: false, error: "ModManager not available" }
  return await mm.deletePlugin(id)
})

ipcMain.handle("mods:update-hooks", async (_e, { id, hooks }) => {
  const mm = getModManager()
  if (!mm) return { ok: false, error: "ModManager not available" }
  return await mm.updatePluginHooks(id, hooks)
})

ipcMain.handle("mods:delete-bulk", async (_e, { ids }) => {
  const mm = getModManager()
  if (!mm) return { ok: false, error: "ModManager not available" }
  return await mm.deletePlugins(ids)
})

// Handle image pick for plugin config (opens native file dialog)
ipcMain.handle("mods:pick-image", async () => {
  const { dialog } = require("electron")
  const result = await dialog.showOpenDialog({
    title: "Pilih Gambar",
    filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp", "gif"] }],
    properties: ["openFile"],
  })
  if (result.canceled || !result.filePaths.length) return { ok: false }
  const filePath = result.filePaths[0]
  // Return both local path and base64 data URL
  const buf  = require("fs").readFileSync(filePath)
  const ext  = require("path").extname(filePath).slice(1).toLowerCase()
  const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`
  const b64  = `data:${mime};base64,${buf.toString("base64")}`
  return { ok: true, filePath, dataUrl: b64 }
})

ipcMain.handle("shell:open-external", async (_e, url) => {
  const { shell } = require("electron")
  // Security: only allow http/https URLs
  if (typeof url === "string" && /^https?:\/\//i.test(url)) {
    await shell.openExternal(url)
    return { ok: true }
  }
  return { ok: false, error: "Invalid URL" }
})

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
// ── [F2] Emoji Picker — trigger OS emoji picker via Electron ──────────────────
ipcMain.handle("ui:emoji-picker", async (_e) => {
  try {
    // Windows: mengirim shortcut Win+Period via robotjs atau keyboard shortcut
    // Electron tidak support langsung Win+. injection, tapi bisa via globalShortcut
    // Cara paling simple: kirim pesan balik ke renderer agar dia handle sendiri
    if (win) win.webContents.executeJavaScript(`
      (function() {
        const focused = document.activeElement
        // Trigger native OS emoji picker via keyboard event simulation
        // Windows 10+: Win+. shortcut (harus dihandle di OS level)
        // Electron dapat trigger ini jika windowsManager enabled
        document.dispatchEvent(new KeyboardEvent('keydown', {key:'.',metaKey:true,bubbles:true}))
      })()
    `).catch(() => {})
    return { ok: true }
  } catch (e) { return { ok: false } }
})

// ── [F3] Mark Messages Read via Baileys ──────────────────────────────────────
ipcMain.handle("msg:mark-read", async (_e, { jid, msgIds }) => {
  try {
    if (!baileysClient) return { ok: false, error: "Client belum siap" }
    if (!Array.isArray(msgIds) || msgIds.length === 0) {
      // Hanya update DB
      getDB().markChatRead(jid)
      return { ok: true, baileys: false }
    }
    // Panggil baileys markRead
    await baileysClient.markRead(jid, msgIds)
    return { ok: true, baileys: true }
  } catch (e) {
    // Jika Baileys error, tetap update DB
    try { getDB().markChatRead(jid) } catch {}
    return { ok: false, error: e.message }
  }
})

// ════════════════════════════════════════════════════════════
// DEV EVAL — Baileys Sandbox (v10)
// Terinspirasi dari pattern > / => di case.js bot
//
// KEAMANAN:
//   • Hanya bisa diakses dari renderer (contextIsolation = true)
//   • Tidak ada akses dari luar proses Electron
//   • Variabel yang di-inject terbatas: sock, db, baileys, util, path, fs
//   • Tidak di-expose ke webContents dari window lain
//
// MODE:
//   "expr"  → eval satu ekspresi, auto-return (seperti => di case.js)
//   "block" → eval multi-statement block async (seperti > di case.js)
// ════════════════════════════════════════════════════════════
ipcMain.handle("dev:eval", async (_e, { code, mode, msgId, chatJid, fullOutput }) => {
  if (!code || typeof code !== "string") return { ok: false, error: "Code kosong" }

  const util    = require("util")
  const sock    = baileysClient?.getSocket?.() || null
  const db_     = getDB()
  const { dialog } = require("electron")

  let baileys = {}
  try { baileys = require("wileys") } catch {}

  const client = baileysClient || {}

  // ── Build smsg-style "m" object identical to output JSON ──────────────────
  // Matches: key, messageTimestamp, pushName, message, id, chatId, chatLid,
  //   fromMe, from, isGroup, isUser, senderId, participant, mtype, msg,
  //   quoted, body, mentionedJid, text, isCmd, cmd, args
  //   + media fields when applicable
  let mObj = null
  if (msgId && db_) {
    try {
      const row = db_.getMessageById?.(msgId) || null
      if (row) {
        const cJid     = chatJid || row.remote_jid || ""
        const msgType  = row.message_type || "conversation"
        const isGroup  = cJid.endsWith("@g.us")
        const fromMe   = row.from_me === 1
        const senderJid = isGroup
          ? (row.participant || "")
          : (fromMe ? (sock?.user?.id || cJid) : cJid)

        // Parse stored raw message JSON (WAMessage proto)
        let msgJson = {}
        try { if (row.message_json) msgJson = JSON.parse(row.message_json) } catch {}

        // Strip transport-layer keys to get content keys only
        const SKIP = new Set(["messageContextInfo", "senderKeyDistributionMessage",
                               "botInvokeMessage", "nativeFlowMessage"])
        const contentKeys = Object.keys(msgJson).filter(k => !SKIP.has(k))

        // Inner msg = msgJson[contentType]
        let innerMsg = {}
        const innerKey = contentKeys[0] || msgType
        innerMsg = msgJson[innerKey] || msgJson

        // Parse mentioned JIDs
        let mentionedJid = []
        try { mentionedJid = JSON.parse(row.mentioned_jids || "[]") } catch {}
        // Also pull from contextInfo
        if (!mentionedJid.length && innerMsg?.contextInfo?.mentionedJid)
          mentionedJid = innerMsg.contextInfo.mentionedJid || []

        // Reconstruct key
        const key = { remoteJid: cJid, fromMe, id: msgId }
        if (isGroup && row.participant) key.participant = row.participant

        // Reconstruct quoted
        let quoted = null
        if (row.context_stanza_id) {
          let qMsgJson = {}
          let qType = row.context_quoted_message || null
          try { if (qType) qMsgJson = JSON.parse(qType) } catch {}
          const qKey = {
            remoteJid: cJid, fromMe: false, id: row.context_stanza_id
          }
          if (isGroup && row.context_participant) qKey.participant = row.context_participant
          quoted = {
            key: qKey,
            message: qMsgJson,
            sender: row.context_participant || null,
            body: row.body ? "" : null,  // quoted body is separate in WA
          }
        }

        const body = row.body || innerMsg?.text || innerMsg?.caption ||
                     innerMsg?.conversation || ""

        // cmd/args parsing (bot-style)
        const cmdPrefix = /^[.!#/]/.test(body)
        const parts = body.trim().split(/\s+/)
        const cmd = parts[0] || ""
        const args = parts.slice(1)

        // Base smsg object
        mObj = {
          key,
          messageTimestamp: row.message_timestamp || row.timestamp || 0,
          pushName: row.push_name || null,
          broadcast: false,
          message: msgJson,
          id: msgId,
          isBaileys: !!(msgId?.length === 16 && /^[A-Z0-9]{16}$/.test(msgId)),
          chatId: cJid,
          chatLid: "",
          fromMe,
          from: cJid,
          isBroadcast: cJid.includes("broadcast"),
          isStatusBroadcast: cJid === "status@broadcast",
          isNewsletter: cJid.endsWith("@newsletter"),
          isGroup,
          isUser: !isGroup && !cJid.endsWith("@newsletter"),
          senderId: senderJid,
          participant: isGroup ? (row.participant || null) : undefined,
          mtype: msgType,
          msg: innerMsg,
          quoted,
          body,
          mentionedJid,
          text: body,
          isCmd: cmdPrefix,
          cmd,
          args,
        }

        // ── Media-type specific fields ─────────────────────────────────
        if (row.media_mimetype || row.has_media) {
          const mime = row.media_mimetype || ""
          const isImage    = msgType === "imageMessage"    || mime.startsWith("image/")
          const isVideo    = msgType === "videoMessage"    || mime.startsWith("video/")
          const isAudio    = msgType === "audioMessage"    || mime.startsWith("audio/") || msgType === "pttMessage"
          const isDoc      = msgType === "documentMessage"
          const isSticker  = msgType === "stickerMessage"
          const isViewOnce = msgType.includes("viewOnce")

          mObj.hasMedia    = true
          mObj.mimetype    = mime
          mObj.mediaUrl    = row.media_url || null
          mObj.mediaKey    = row.media_key || null
          mObj.fileLength  = row.media_file_length || null
          mObj.fileName    = row.media_file_name || row.media_filename || null
          mObj.mediaSavedPath = row.media_saved_path || null

          if (isImage || isVideo || isSticker) {
            mObj.width   = row.media_width  || innerMsg?.width  || null
            mObj.height  = row.media_height || innerMsg?.height || null
          }
          if (isAudio || isVideo) {
            mObj.duration = row.media_duration || innerMsg?.seconds || null
            mObj.isPtt    = msgType === "pttMessage" || !!(row.is_ptt)
            mObj.isGif    = !!(row.is_gif)
          }
          if (isSticker) {
            mObj.isAnimated = !!(row.is_animated)
          }
          if (isViewOnce) {
            mObj.isViewOnce = true
          }
          if (isDoc) {
            mObj.pageCount = innerMsg?.pageCount || null
            mObj.title     = innerMsg?.title || row.media_filename || null
          }
        }
      }
    } catch (e) {
      console.warn("[DevEval] m build error:", e.message)
    }
  }

  // Fallback m stub
  if (!mObj) mObj = {
    id: msgId || null, chatId: chatJid || null, body: "", mtype: "unknown",
    fromMe: false, isGroup: false, msg: {}, quoted: null, mentionedJid: [], text: ""
  }

  const ctx = {
    sock, dims: sock, ws: sock,
    db: db_, baileys, client, util,
    path: require("path"), fs: require("fs"),
    m: mObj, msg: mObj, message: mObj,
    fmt:  (v) => util.inspect(v, { depth: 12, colors: false, compact: false, maxArrayLength: Infinity, maxStringLength: Infinity }),
    json: (v) => JSON.stringify(v, null, 2),
    log:  (v) => { console.log("[DevEval]", typeof v === "object" ? JSON.stringify(v, null, 2) : v); return v },
  }

  try {
    let result
    if (mode === "expr") {
      const fn = new Function(...Object.keys(ctx), `"use strict"; return (async () => { return (${code}) })()`)
      result = await fn(...Object.values(ctx))
    } else {
      const fn = new Function(...Object.keys(ctx), `"use strict"; return (async () => { ${code} })()`)
      result = await fn(...Object.values(ctx))
    }

    let output
    if (result === undefined) output = "undefined"
    else if (result === null)  output = "null"
    else {
      try {
        output = util.inspect(result, {
          depth: 12,
          colors: false,
          compact: false,
          maxArrayLength: fullOutput ? Infinity : 500,
          maxStringLength: fullOutput ? Infinity : 20000,
          breakLength: 140,
        })
      } catch { output = String(result) }
    }

    return { ok: true, result: output, type: typeof result }
  } catch (err) {
    return { ok: false, error: err.message || String(err), stack: err.stack || null }
  }
})

// ── DevEval: save output to file ─────────────────────────────────────────────
ipcMain.handle("dev:save-file", async (_e, { content, filename }) => {
  try {
    const { dialog } = require("electron")
    const result = await dialog.showSaveDialog({
      title: "Simpan Output DevEval",
      defaultPath: filename || "deveval_output.txt",
      filters: [
        { name: "Text Files", extensions: ["txt", "json", "log"] },
        { name: "All Files",  extensions: ["*"] },
      ],
    })
    if (result.canceled || !result.filePath) return { ok: false, reason: "canceled" }
    require("fs").writeFileSync(result.filePath, content, "utf-8")
    return { ok: true, path: result.filePath }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})
