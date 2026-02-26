// electron/baileys/client.js
// ╔═══════════════════════════════════════════════════════════╗
// ║              AuroraChat — Baileys Client                  ║
// ║            WhatsApp Desktop Connection Layer              ║
// ║                                                           ║
// ║  Dipanggil dari: electron/main.js                         ║
// ║                                                           ║
// ║  IPC Events yang di-emit ke renderer:                     ║
// ║    auth:need-phone-number  → perlu input nomor            ║
// ║    auth:qr                 → QR code (string)             ║
// ║    auth:pairing-code       → { code, phone }              ║
// ║    auth:pairing-error      → { message }                  ║
// ║    auth:logged-out         → null                         ║
// ║    connection:open         → { name, jid, phone }         ║
// ║    connection:close        → { statusCode, reason }       ║
// ║    connection:reconnecting → { attempt, maxAttempt, ms }  ║
// ║    connection:failed       → { attempts }                 ║
// ║    connection:error        → { message }                  ║
// ║    messages:new            → MessagePayload               ║
// ║    messages:history        → { count, isComplete }        ║
// ╚═══════════════════════════════════════════════════════════╝

"use strict"

const {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  isJidBroadcast,
  isJidGroup,
  isJidStatusBroadcast,
  jidNormalizedUser,
  downloadMediaMessage,
  proto,
  getAggregateVotesInPollMessage,
} = require("baileys")

const { Boom } = require("@hapi/boom")
const pino = require("pino")
const chalk = require("chalk")
const path = require("path")
const fs = require("fs")
const NodeCache = require("node-cache")

// ════════════════════════════════════════════════════════════
// DATABASE IMPORT
// ════════════════════════════════════════════════════════════
const db = require("../db/database")

// ════════════════════════════════════════════════════════════
// CONFIG
// ════════════════════════════════════════════════════════════

const CONFIG = {
  SESSION_DIR: path.resolve(__dirname, "./session"),
  MEDIA_DIR: path.resolve(__dirname, "./media"),
  AUTH_MODE: "pairing",
  MAX_RECONNECT: 10,
  RECONNECT_BASE_MS: 2000,
  RECONNECT_MAX_MS: 30000,
  RECONNECT_JITTER_MS: 1500,
  SYNC_FULL_HISTORY: true,
  MSG_CACHE_TTL: 300,
  MSG_CACHE_MAX: 1000,
  AUTO_DOWNLOAD_MEDIA: true,
  MAX_MEDIA_SIZE_MB: 100,
}

// ════════════════════════════════════════════════════════════
// STATE
// ════════════════════════════════════════════════════════════

let sock = null
let mainWindow = null
let reconnectAttempts = 0
let reconnectTimer = null
let isLoggedOut = false
let isConnected = false
let pendingPhone = null
let authMode = CONFIG.AUTH_MODE
let isSyncing = false
let historySyncBuffer = []
let syncStats = { chats: 0, messages: 0 }

const msgRetryCache = new NodeCache({
  stdTTL: CONFIG.MSG_CACHE_TTL,
  maxKeys: CONFIG.MSG_CACHE_MAX,
})

// Ensure media directory exists
if (!fs.existsSync(CONFIG.MEDIA_DIR)) {
  fs.mkdirSync(CONFIG.MEDIA_DIR, { recursive: true })
}

// ════════════════════════════════════════════════════════════
// LOGGER
// ════════════════════════════════════════════════════════════

const logger = pino({
  level: process.env.BAILEYS_LOG || "silent",
})

// ════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════

function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send(channel, data)
    } catch (_) { }
  }
}

const tag = (c, t) => chalk[c].bold(`[ ${t} ]`)
const log = (m) => console.log(tag("cyan", "AuroraChat"), chalk.white(m))
const logOk = (m) => console.log(tag("green", "AuroraChat"), chalk.green(m))
const logW = (m) => console.log(tag("yellow", "AuroraChat"), chalk.yellow(m))
const logE = (m) => console.error(tag("red", "AuroraChat"), chalk.red(m))

function normalizePhone(raw) {
  let n = String(raw).replace(/[\s\-\+\(\)]/g, "")
  if (n.startsWith("0")) n = "62" + n.slice(1)
  return n
}

function extractBody(message) {
  if (!message) return ""
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    message.audioMessage?.caption ||
    message.buttonsResponseMessage?.selectedButtonId ||
    message.listResponseMessage?.title ||
    message.templateButtonReplyMessage?.selectedId ||
    message.pollCreationMessage?.name ||
    message.reactionMessage?.text ||
    message.locationMessage?.name ||
    message.liveLocationMessage?.caption ||
    message.contactMessage?.displayName ||
    message.groupInviteMessage?.groupName ||
    ""
  )
}

function calcDelay(attempt) {
  const base = CONFIG.RECONNECT_BASE_MS * Math.pow(2, attempt - 1)
  const capped = Math.min(base, CONFIG.RECONNECT_MAX_MS)
  const jitter = Math.floor(Math.random() * CONFIG.RECONNECT_JITTER_MS)
  return capped + jitter
}

function assertConnected() {
  if (!sock) throw new Error("Tidak ada koneksi aktif ke WhatsApp")
}

// ════════════════════════════════════════════════════════════
// MEDIA DOWNLOAD HANDLER
// ════════════════════════════════════════════════════════════

async function downloadAndSaveMedia(msg, messageType) {
  try {
    const buffer = await downloadMediaMessage(
      msg,
      'buffer',
      {},
      {
        logger,
        reuploadRequest: sock.updateMediaMessage,
      }
    )

    if (!buffer) return null

    // Check file size
    const sizeMB = buffer.length / (1024 * 1024)
    if (sizeMB > CONFIG.MAX_MEDIA_SIZE_MB) {
      logW(`Media too large: ${sizeMB.toFixed(2)}MB, skipping download`)
      return { skipped: true, reason: 'too_large', size: buffer.length }
    }

    // Generate filename
    const ext = getExtensionFromMimetype(msg.message[messageType].mimetype)
    const timestamp = Date.now()
    const filename = `${msg.key.id}_${timestamp}.${ext}`
    const localPath = path.join(CONFIG.MEDIA_DIR, filename)

    // Save file
    fs.writeFileSync(localPath, buffer)

    // Update database
    db.updateMediaDownload(
      msg.key.id,
      localPath,
      buffer.length,
      'downloaded'
    )

    // Update message record
    const dbMsg = db.getMessageById(msg.key.id)
    if (dbMsg) {
      const { Database } = require('better-sqlite3')
      const database = new Database(path.join(__dirname, './database/aurora_chat.db'))
      database.prepare(`
        UPDATE messages SET 
          media_saved_path = ?,
          media_is_downloaded = 1
        WHERE id = ?
      `).run(localPath, msg.key.id)
      database.close()
    }

    logOk(`Media downloaded: ${filename} (${sizeMB.toFixed(2)}MB)`)
    return { localPath, size: buffer.length, filename }
  } catch (error) {
    logE(`Error downloading media: ${error.message}`)
    db.updateMediaDownload(msg.key.id, null, null, 'failed', error.message)
    return { error: error.message }
  }
}

function getExtensionFromMimetype(mimetype) {
  const map = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'video/3gpp': '3gp',
    'audio/ogg; codecs=opus': 'ogg',
    'audio/mp4': 'm4a',
    'audio/mpeg': 'mp3',
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'text/plain': 'txt',
    'application/zip': 'zip',
  }
  return map[mimetype] || 'bin'
}

// ════════════════════════════════════════════════════════════
// CLEANUP
// ════════════════════════════════════════════════════════════

function cleanupSocket() {
  if (!sock) return
  try {
    sock.ev.removeAllListeners()
    sock.ws?.removeAllListeners()
  } catch (_) { }
  sock = null
  isConnected = false
}

// ════════════════════════════════════════════════════════════
// MESSAGE HANDLER
// ════════════════════════════════════════════════════════════

async function handleMessage(msg, type, isHistorySync = false) {
  if (!msg.message) return

  // Skip status broadcasts
  if (isJidStatusBroadcast(msg.key.remoteJid || "")) return
  if (isJidBroadcast(msg.key.remoteJid || "")) return

  // Save to database
  const saveResult = db.saveMessage(msg, isHistorySync, isHistorySync ? 'history' : 'live')

  if (saveResult.success) {
    // Queue media download if has media
    if (saveResult.hasMedia && CONFIG.AUTO_DOWNLOAD_MEDIA) {
      const mediaTypes = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage']
      const mediaType = mediaTypes.find(mt => msg.message[mt])
      if (mediaType) {
        db.queueMediaDownload(msg.key.id, msg.key.remoteJid, mediaType.replace('Message', ''), msg.message[mediaType].url)
        // Download async
        downloadAndSaveMedia(msg, mediaType).catch(console.error)
      }
    }

    // Update sync stats if history sync
    if (isHistorySync) {
      syncStats.messages++
    }

    // Emit to renderer
    const jid = msg.key.remoteJid || ""
    const isGroup = isJidGroup(jid)
    const isMe = msg.key.fromMe
    const pushname = msg.pushName || "Unknown"
    const body = extractBody(msg.message)

    // Cache for retry
    if (msg.message) {
      msgRetryCache.set(msg.key.id, msg.message)
    }

    // Log
    if (!isMe && body && !isHistorySync) {
      const colors = ["green", "yellow", "magenta", "cyan", "blue"]
      const c = colors[Math.floor(Math.random() * colors.length)]
      console.log(
        tag("green", "MSG"),
        chalk[c](`${pushname} (${jid})`),
        chalk.white("→"),
        chalk.white(body.length > 120 ? body.slice(0, 120) + "…" : body)
      )
    }

    // Extract media info for renderer
    const msgObj = msg.message || {}
    const mediaMsg = msgObj.imageMessage || msgObj.videoMessage || msgObj.audioMessage ||
      msgObj.documentMessage || msgObj.stickerMessage || null
    const locMsg = msgObj.locationMessage || msgObj.liveLocationMessage || null
    const pollMsg = msgObj.pollCreationMessage || msgObj.pollCreationMessageV2 || msgObj.pollCreationMessageV3 || null
    const reactionMsg = msgObj.reactionMessage || null

    // Send to renderer
    send("messages:new", {
      key: msg.key,
      message: msg.message,
      body,
      msgType: saveResult.type,
      jid,
      sender: isMe ? (sock.user?.id ?? "") : (msg.participant || jid),
      pushname,
      isGroup,
      isMe,
      timestamp: Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000),
      status: msg.status ?? 0,
      starred: msg.starred ?? false,
      broadcast: msg.broadcast ?? false,
      hasMedia: saveResult.hasMedia,
      isHistorySync,
      isViewOnce: saveResult.isViewOnce || false,
      isEphemeral: saveResult.isEphemeral || false,
      mediaUrl: mediaMsg?.url || null,
      mediaMime: mediaMsg?.mimetype || null,
      mediaFilename: mediaMsg?.fileName || mediaMsg?.title || null,
      mediaDuration: mediaMsg?.seconds || null,
      mediaWidth: mediaMsg?.width || null,
      mediaHeight: mediaMsg?.height || null,
      locationLat: locMsg?.degreesLatitude || null,
      locationLng: locMsg?.degreesLongitude || null,
      locationName: locMsg?.name || null,
      pollOptions: pollMsg ? (pollMsg.options || []).map(o => o.optionName || o.name) : null,
      reactionEmoji: reactionMsg?.text || null,
      reactionTargetId: reactionMsg?.key?.id || null,
    })
  }
}

// ════════════════════════════════════════════════════════════
// KONEKSI UTAMA
// ════════════════════════════════════════════════════════════

async function connectToWhatsApp(phoneForPairing = null) {
  if (isLoggedOut) {
    logW("Tidak reconnect — akun telah logout")
    return
  }

  if (!fs.existsSync(CONFIG.SESSION_DIR)) {
    fs.mkdirSync(CONFIG.SESSION_DIR, { recursive: true })
  }

  // ── Load Auth State ──────────────────────────────────
  let state, saveCreds
  try {
    const auth = await useMultiFileAuthState(CONFIG.SESSION_DIR)
    state = auth.state
    saveCreds = auth.saveCreds
  } catch (err) {
    logE(`Gagal load auth state: ${err.message}`)
    send("connection:error", { message: `Gagal baca session: ${err.message}` })
    return
  }

  // ── Fetch Versi WA Terbaru ───────────────────────────
  let version, isLatest
  try {
    ; ({ version, isLatest } = await fetchLatestBaileysVersion())
  } catch (_) {
    logW("Gagal fetch versi WA terbaru — pakai fallback")
    version = [2, 3000, 1023141118]
    isLatest = false
  }

  log(`Baileys WA v${version.join(".")} | isLatest: ${isLatest}`)

  // ── Cleanup socket sebelumnya ────────────────────────
  cleanupSocket()

  // ── Tentukan mode berdasarkan apakah ada phoneForPairing ──
  const usePairingMode = !!phoneForPairing

  // ════════════════════════════════════════════════════════
  // PENTING: Browser identifier HARUS sesuai dengan
  // yang dikenali WhatsApp agar pairing berhasil!
  // ════════════════════════════════════════════════════════
  sock = makeWASocket({
    logger,
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    syncFullHistory: CONFIG.SYNC_FULL_HISTORY,
    shouldSyncHistoryMessage: (msg) => {
      // Terima semua history sync
      return true
    },
    generateHighQualityLinkPreview: true,
    msgRetryCounterCache: msgRetryCache,
    keepAliveIntervalMs: 25000,
    getMessage: async (key) => {
      const cached = msgRetryCache.get(key.id)
      if (cached) return cached

      // Try to get from database
      const dbMsg = db.getMessageById(key.id)
      if (dbMsg && dbMsg.message_json) {
        return JSON.parse(dbMsg.message_json)
      }

      return proto.Message.fromObject({})
    },
  })

  // ════════════════════════════════════════════════════════
  // PAIRING CODE — request SEGERA setelah socket dibuat
  // ════════════════════════════════════════════════════════
  if (usePairingMode && !sock.authState.creds.registered) {
    const cleaned = normalizePhone(phoneForPairing)
    log(`Mode Pairing — nomor: ${cleaned}`)

    await new Promise(r => setTimeout(r, 3000))

    try {
      const code = await sock.requestPairingCode(cleaned)
      logOk(`Pairing Code: ${code}`)
      send("auth:pairing-code", { code, phone: cleaned })
    } catch (err) {
      logE(`Gagal request pairing code: ${err.message}`)
      send("auth:pairing-error", { message: err.message })
    }
  } else if (!usePairingMode && !sock.authState.creds.registered) {
    log("Mode QR — menunggu scan dari HP")
  }

  // ════════════════════════════════════════════════════════
  // EVENT: connection.update
  // ════════════════════════════════════════════════════════
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update
    console.log("Nunggu Koneksi")
    if (qr) {
      log("QR Code diterima → kirim ke renderer")
      send("auth:qr", qr)
    }

    // ── OPEN ─────────────────────────────────────────
    if (connection === "open") {
      isConnected = true
      reconnectAttempts = 0
      isLoggedOut = false
      pendingPhone = null

      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }

      const me = sock.user
      logOk(`Terhubung sebagai: ${me?.name} | ${me?.id}`)
      send("connection:open", {
        name: me?.name || "Unknown",
        jid: me?.id || "",
        phone: me?.id?.split(":")[0] || "",
      })

      // Start sync status
      db.startSync()
      send("sync:status", { isSyncing: true, progress: 0 })
    }

    // ── CLOSE ────────────────────────────────────────
    if (connection === "close") {
      isConnected = false
      isSyncing = false

      const boom = new Boom(lastDisconnect?.error)
      const statusCode = boom?.output?.statusCode ?? -1
      const reason = (
        Object.entries(DisconnectReason).find(([, v]) => v === statusCode)?.[0]
        ?? "Unknown"
      )

      logE(`Koneksi terputus — code: ${statusCode} (${reason})`)
      send("connection:close", { statusCode, reason })

      if (statusCode === DisconnectReason.loggedOut) {
        isLoggedOut = true
        logW("Akun di-logout — menghapus session...")
        send("auth:logged-out", null)
        await clearSession()
        return
      }

      if (statusCode === DisconnectReason.restartRequired) {
        logW("Restart required — reconnect langsung...")
        scheduleReconnect(0)
        return
      }

      if (statusCode === DisconnectReason.multideviceMismatch) {
        logW("Multidevice mismatch — reconnect...")
        scheduleReconnect(0)
        return
      }

      const retriable = [
        DisconnectReason.connectionClosed,
        DisconnectReason.connectionLost,
        DisconnectReason.connectionReplaced,
        DisconnectReason.timedOut,
        DisconnectReason.unavailableService,
        DisconnectReason.badSession,
        408, 500, 503, -1,
      ]

      if (retriable.includes(statusCode)) {
        scheduleReconnect()
      } else {
        logW(`Status ${statusCode} tidak perlu reconnect otomatis`)
        send("connection:failed", { statusCode, reason })
      }
    }
  })

  // ── Save creds ───────────────────────────────────────
  sock.ev.on("creds.update", saveCreds)

  // ════════════════════════════════════════════════════════
  // EVENT: messaging-history.set (HISTORY SYNC)
  // ════════════════════════════════════════════════════════
  sock.ev.on("messaging-history.set", async ({ chats, contacts, messages, isLatest, progress }) => {
    log(`History Sync: ${messages.length} messages, ${chats.length} chats (isLatest: ${isLatest}, progress: ${progress}%)`)

    isSyncing = true
    syncStats.chats += chats.length
    syncStats.messages += messages.length

    // Save chats
    for (const chat of chats) {
      db.saveChat(chat)
    }

    // Save contacts
    for (const contact of contacts) {
      log(contact)
      db.saveContacts(contact)
    }

    // Save messages (history)
    for (const msg of messages) {
      await handleMessage(msg, 'history', true)
    }

    // Update sync status
    send("sync:status", {
      isSyncing: true,
      progress,
      stats: syncStats
    })

    // If complete
    if (isLatest) {
      isSyncing = false
      db.endSync(syncStats.chats, syncStats.messages)
      send("sync:status", {
        isSyncing: false,
        progress: 100,
        stats: syncStats,
        isComplete: true
      })
      logOk(`History sync complete: ${syncStats.messages} messages, ${syncStats.chats} chats`)

      // Reset stats for next sync
      syncStats = { chats: 0, messages: 0 }
    }
  })

  // ════════════════════════════════════════════════════════
  // EVENT: messages.upsert (NEW MESSAGES & OFFLINE MESSAGES)
  // ════════════════════════════════════════════════════════
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    // type === 'notify' -> Real-time messages
    // type === 'append' -> Offline messages (history sync during reconnect)

    for (const msg of messages) {
      // Handle both real-time and offline messages
      const isHistorySync = type === 'append'
      await handleMessage(msg, type, isHistorySync)
    }

    // Handler case.js (opsional)
    try {
      const handler = require("./case")
      await handler(sock, { messages, type })
    } catch (e) {
      if (e.code !== "MODULE_NOT_FOUND") {
        logE(`Error di case handler: ${e.message}`)
      }
    }
  })

  // ════════════════════════════════════════════════════════
  // EVENT: messages.update (STATUS UPDATES, POLL VOTES, EDITS)
  // ════════════════════════════════════════════════════════
  sock.ev.on("messages.update", async (updates) => {
    for (const { key, update } of updates) {
      // Handle poll votes
      if (update.pollUpdates) {
        const pollMsg = db.getMessageById(key.id)
        if (pollMsg && pollMsg.poll_options) {
          const pollCreation = JSON.parse(pollMsg.message_json)
          const pollResults = getAggregateVotesInPollMessage({
            message: pollCreation,
            pollUpdates: update.pollUpdates,
          })

          // Update poll votes in database
          const { Database } = require('better-sqlite3')
          const database = new Database(path.join(__dirname, './database/aurora_chat.db'))
          database.prepare(`
            UPDATE messages SET poll_votes = ? WHERE id = ?
          `).run(JSON.stringify(pollResults), key.id)
          database.close()

          // Save individual votes
          for (const vote of update.pollUpdates) {
            db.savePollVote(key.id, vote.pollUpdateSenderKeyRemoteJid, vote.vote)
          }
        }
      }

      // Handle message status updates
      if (update.status) {
        db.updateMessageStatus(key.id, update.status)
      }

      // Handle message edits
      if (update.message) {
        // Check if edited message
        const editedType = Object.keys(update.message).find(k => k.includes('edited'))
        if (editedType) {
          const newBody = extractBody(update.message)
          db.saveMessageEdit(key.id, newBody, Date.now())
        }
      }
    }

    send("messages:update", updates)
  })

  // ── Other events ─────────────────────────────────────
  sock.ev.on("message-receipt.update", (updates) => send("messages:receipt", updates))
  sock.ev.on("messages.delete", (item) => {
    // Mark as deleted in database
    if (item.keys) {
      for (const key of item.keys) {
        db.updateMessageStatus(key.id, -1) // -1 for deleted
      }
    }
    send("messages:delete", item)
  })
  sock.ev.on("messages.reaction", (reactions) => send("messages:reaction", reactions))

  // Chats events
  sock.ev.on("chats.set", ({ chats, isLatest }) => {
    log(`Loaded ${chats.length} chats (isLatest: ${isLatest})`)
    send("chats:set", chats)

    for (const chat of chats) {
      db.saveChat(chat)
    }
  })

  sock.ev.on("chats.upsert", (c) => {
    send("chats:upsert", c)
    for (const chat of c) {
      db.saveChat(chat)
    }
  })

  sock.ev.on("chats.update", (u) => {
    send("chats:update", u)
    for (const update of u) {
      if (update.unreadCount !== undefined) {
        db.updateChatUnread(update.id, update.unreadCount)
      }
    }
  })

  sock.ev.on("chats.delete", (i) => send("chats:delete", i))

  // Contacts events
  sock.ev.on("contacts.set", ({ contacts }) => {
    log(`Loaded ${contacts.length} contacts`)
    send("contacts:set", contacts)
    db.saveContacts(contacts)
  })

  sock.ev.on("contacts.upsert", (c) => {
    send("contacts:upsert", c)
    db.saveContacts(Array.isArray(c) ? c : [c])
  })

  sock.ev.on("contacts.update", (u) => send("contacts:update", u))

  // Other events
  sock.ev.on("presence.update", ({ id, presences }) => send("presence:update", { id, presences }))
  sock.ev.on("groups.update", (u) => send("groups:update", u))
  sock.ev.on("group-participants.update", ({ id, participants, action }) => {
    send("groups:participants", { id, participants, action })
  })
  sock.ev.on("call", (calls) => send("call:incoming", calls))
  sock.ev.on("labels.association", (a) => send("labels:association", a))
  sock.ev.on("labels.edit", (l) => send("labels:edit", l))

  return sock
}

// ════════════════════════════════════════════════════════════
// RECONNECT LOGIC
// ════════════════════════════════════════════════════════════

function scheduleReconnect(overrideDelayMs) {
  if (isLoggedOut) return

  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  reconnectAttempts++

  if (reconnectAttempts > CONFIG.MAX_RECONNECT) {
    logE(`Gagal reconnect setelah ${CONFIG.MAX_RECONNECT}x. Berhenti.`)
    send("connection:failed", { attempts: reconnectAttempts - 1 })
    reconnectAttempts = 0
    return
  }

  const delay = overrideDelayMs !== undefined ? overrideDelayMs : calcDelay(reconnectAttempts)

  logW(
    `↺ Reconnect ke-${reconnectAttempts}/${CONFIG.MAX_RECONNECT}` +
    ` dalam ${(delay / 1000).toFixed(1)}s...`
  )

  send("connection:reconnecting", {
    attempt: reconnectAttempts,
    maxAttempt: CONFIG.MAX_RECONNECT,
    delayMs: delay,
  })

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null
    try {
      await connectToWhatsApp()
    } catch (err) {
      logE(`Error saat reconnect: ${err.message}`)
      scheduleReconnect()
    }
  }, delay)
}

async function forceReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  reconnectAttempts = 0
  isLoggedOut = false
  logW("Force reconnect dipanggil dari UI")
  await connectToWhatsApp()
}

// ════════════════════════════════════════════════════════════
// SESSION
// ════════════════════════════════════════════════════════════

async function clearSession() {
  cleanupSocket()
  try {
    if (fs.existsSync(CONFIG.SESSION_DIR)) {
      const files = fs.readdirSync(CONFIG.SESSION_DIR)
      for (const f of files) {
        fs.rmSync(path.join(CONFIG.SESSION_DIR, f), { recursive: true, force: true })
      }
    }
    log("Session berhasil dihapus")
  } catch (err) {
    logE(`Gagal hapus session: ${err.message}`)
  }
}

// ════════════════════════════════════════════════════════════
// PUBLIC: INIT
// ════════════════════════════════════════════════════════════

async function init(win) {
  mainWindow = win
  isLoggedOut = false
  reconnectAttempts = 0

  const sessionExists = fs.existsSync(CONFIG.SESSION_DIR) &&
    fs.readdirSync(CONFIG.SESSION_DIR).length > 0

  if (sessionExists) {
    log("Session ditemukan — mencoba reconnect otomatis...")
    await connectToWhatsApp()
  } else {
    log("Belum ada session — menunggu pilihan dari UI...")
    send("auth:need-phone-number", null)
  }
}

// ════════════════════════════════════════════════════════════
// PUBLIC: AUTH
// ════════════════════════════════════════════════════════════

async function requestPairingCode(phoneNumber) {
  const cleaned = normalizePhone(phoneNumber)
  if (cleaned.length < 10) {
    const errMsg = `Nomor tidak valid: ${cleaned}`
    logE(errMsg)
    send("auth:pairing-error", { message: errMsg })
    throw new Error(errMsg)
  }

  log(`Memulai proses pairing untuk: ${cleaned}`)
  cleanupSocket()
  await clearSession()
  pendingPhone = cleaned
  await connectToWhatsApp(cleaned)
}

async function startQRMode() {
  log("Memulai mode QR Code...")
  cleanupSocket()
  await clearSession()
  authMode = "qr"
  await connectToWhatsApp(null)
}

// ════════════════════════════════════════════════════════════
// PUBLIC: SEND MESSAGES
// ════════════════════════════════════════════════════════════

async function sendTextMessage(jid, text, opts = {}) {
  assertConnected()
  const payload = {
    text,
    ...(opts.mentions?.length ? { mentions: opts.mentions } : {}),
  }
  return await sock.sendMessage(jid, payload, opts.quoted ? { quoted: opts.quoted } : {})
}

async function sendImage(jid, image, caption = "", quoted = null) {
  assertConnected()
  const src = typeof image === "string" ? { url: image } : image
  return await sock.sendMessage(jid, { image: src, caption }, quoted ? { quoted } : {})
}

async function sendVideo(jid, video, caption = "", quoted = null) {
  assertConnected()
  const src = typeof video === "string" ? { url: video } : video
  return await sock.sendMessage(jid, { video: src, caption }, quoted ? { quoted } : {})
}

async function sendAudio(jid, audio, ptt = false, quoted = null) {
  assertConnected()
  const src = typeof audio === "string" ? { url: audio } : audio
  return await sock.sendMessage(jid, {
    audio: src,
    ptt,
    mimetype: ptt ? "audio/ogg; codecs=opus" : "audio/mp4",
  }, quoted ? { quoted } : {})
}

async function sendDocument(jid, document, fileName, mimetype = "application/octet-stream", caption = "", quoted = null) {
  assertConnected()
  const src = typeof document === "string" ? { url: document } : document
  return await sock.sendMessage(jid, {
    document: src,
    fileName,
    mimetype,
    caption,
  }, quoted ? { quoted } : {})
}

async function sendSticker(jid, sticker, quoted = null) {
  assertConnected()
  const src = typeof sticker === "string" ? { url: sticker } : sticker
  return await sock.sendMessage(jid, { sticker: src }, quoted ? { quoted } : {})
}

async function sendLocation(jid, lat, lng, name = "", address = "", quoted = null) {
  assertConnected()
  return await sock.sendMessage(jid, {
    location: { degreesLatitude: lat, degreesLongitude: lng, name, address },
  }, quoted ? { quoted } : {})
}

async function sendContact(jid, displayName, phoneNumber, quoted = null) {
  assertConnected()
  const num = normalizePhone(phoneNumber)
  const vcard =
    `BEGIN:VCARD\nVERSION:3.0\n` +
    `FN:${displayName}\n` +
    `TEL;type=CELL;type=VOICE;waid=${num}:+${num}\n` +
    `END:VCARD`
  return await sock.sendMessage(jid, {
    contacts: { displayName, contacts: [{ vcard }] },
  }, quoted ? { quoted } : {})
}

async function forwardMessage(jid, message) {
  assertConnected()
  return await sock.sendMessage(jid, { forward: message })
}

// ════════════════════════════════════════════════════════════
// PUBLIC: MESSAGE ACTIONS
// ════════════════════════════════════════════════════════════

async function deleteMessage(jid, msgKey, forEveryone = false) {
  assertConnected()
  if (forEveryone) {
    return await sock.sendMessage(jid, { delete: msgKey })
  }
  return await sock.chatModify({
    clear: {
      messages: [{ id: msgKey.id, fromMe: msgKey.fromMe, timestamp: Date.now() }],
    },
  }, jid)
}

async function reactToMessage(jid, msgKey, emoji) {
  assertConnected()
  return await sock.sendMessage(jid, { react: { text: emoji, key: msgKey } })
}

async function editMessage(jid, msgKey, newText) {
  assertConnected()
  return await sock.sendMessage(jid, { edit: msgKey, text: newText })
}

async function starMessage(jid, messages, star = true) {
  assertConnected()
  return await sock.chatModify({ star: { messages, star } }, jid)
}

// ════════════════════════════════════════════════════════════
// PUBLIC: CHAT MANAGEMENT
// ════════════════════════════════════════════════════════════

async function markRead(jid, msgIds, participant = null) {
  assertConnected()
  const keys = msgIds.map((id) => ({
    remoteJid: jid,
    id,
    ...(participant ? { participant } : {}),
  }))
  await sock.readMessages(keys)

  // Update database
  db.updateChatRead(jid)
}

async function markUnread(jid) {
  assertConnected()
  await sock.chatModify({
    markRead: false,
    lastMessages: [{ key: { remoteJid: jid }, messageTimestamp: Date.now() }],
  }, jid)
}

async function archiveChat(jid, archive = true) {
  assertConnected()
  await sock.chatModify({
    archive,
    lastMessages: [{ key: { remoteJid: jid }, messageTimestamp: Date.now() }],
  }, jid)
  db.updateChatArchived(jid, archive)
}

async function pinChat(jid, pin = true) {
  assertConnected()
  await sock.chatModify({ pin }, jid)
  db.updateChatPinned(jid, pin)
}

async function muteChat(jid, muteEndMs = null) {
  assertConnected()
  await sock.chatModify({ mute: muteEndMs ?? -1 }, jid)
}

async function deleteChat(jid, lastMsgId, lastMsgFromMe, lastMsgTimestamp) {
  assertConnected()
  await sock.chatModify({
    delete: true,
    lastMessages: [{
      key: { remoteJid: jid, id: lastMsgId, fromMe: lastMsgFromMe },
      messageTimestamp: lastMsgTimestamp,
    }],
  }, jid)
}

// ════════════════════════════════════════════════════════════
// PUBLIC: PRESENCE
// ════════════════════════════════════════════════════════════

async function sendPresenceUpdate(jid, type = "composing") {
  assertConnected()
  await sock.sendPresenceUpdate(type, jid)
}

async function subscribePresence(jid) {
  assertConnected()
  await sock.presenceSubscribe(jid)
}

// ════════════════════════════════════════════════════════════
// PUBLIC: PROFILE
// ════════════════════════════════════════════════════════════

async function getContactInfo(jid) {
  assertConnected()
  const normalized = jidNormalizedUser(jid)
  const [statusRes, imgRes] = await Promise.allSettled([
    sock.fetchStatus(normalized),
    sock.profilePictureUrl(normalized, "image"),
  ])
  return {
    status: statusRes.status === "fulfilled" ? statusRes.value?.status || "" : "",
    imgUrl: imgRes.status === "fulfilled" ? imgRes.value : null,
  }
}

async function updateMyStatus(status) {
  assertConnected()
  await sock.updateProfileStatus(status)
}

async function updateMyName(name) {
  assertConnected()
  await sock.updateProfileName(name)
}

// ════════════════════════════════════════════════════════════
// PUBLIC: GROUP
// ════════════════════════════════════════════════════════════

async function getGroupMetadata(jid) {
  assertConnected()
  return await sock.groupMetadata(jid)
}

async function createGroup(name, participants) {
  assertConnected()
  return await sock.groupCreate(name, participants)
}

async function addGroupParticipants(jid, participants) {
  assertConnected()
  return await sock.groupParticipantsUpdate(jid, participants, "add")
}

async function removeGroupParticipants(jid, participants) {
  assertConnected()
  return await sock.groupParticipantsUpdate(jid, participants, "remove")
}

async function updateGroupAdmin(jid, participants, action) {
  assertConnected()
  return await sock.groupParticipantsUpdate(jid, participants, action)
}

async function leaveGroup(jid) {
  assertConnected()
  await sock.groupLeave(jid)
}

async function updateGroupDescription(jid, description) {
  assertConnected()
  await sock.groupUpdateDescription(jid, description)
}

async function updateGroupName(jid, name) {
  assertConnected()
  await sock.groupUpdateSubject(jid, name)
}

async function getGroupInviteLink(jid) {
  assertConnected()
  return await sock.groupInviteCode(jid)
}

// ════════════════════════════════════════════════════════════
// PUBLIC: MEDIA
// ════════════════════════════════════════════════════════════

async function downloadMedia(message, type = "buffer") {
  return await downloadMediaMessage(message, type, {}, {
    logger,
    reuploadRequest: sock?.updateMediaMessage,
  })
}

// ════════════════════════════════════════════════════════════
// PUBLIC: DATABASE QUERIES (untuk IPC handlers)
// ════════════════════════════════════════════════════════════

function getMessagesFromDB(jid, limit = 50, offset = 0) {
  return db.getMessages(jid, limit, offset)
}

function searchMessagesInDB(jid, query) {
  return db.searchMessages(jid, query)
}

function getChatsFromDB(limit = 50, offset = 0) {
  return db.getChats(limit, offset)
}

function getContactsFromDB(limit = 100, offset = 0) {
  return db.getContacts(limit, offset)
}

function searchContactsInDB(query) {
  return db.searchContacts(query)
}

function getDBStats() {
  return db.getStats()
}

function getSyncStatus() {
  return db.getSyncStatus()
}

// ════════════════════════════════════════════════════════════
// PUBLIC: MISC
// ════════════════════════════════════════════════════════════

async function blockContact(jid, action = "block") {
  assertConnected()
  await sock.updateBlockStatus(jid, action)
}

async function checkNumberExists(phoneNumber) {
  assertConnected()
  const cleaned = normalizePhone(phoneNumber)
  const [result] = await sock.onWhatsApp(cleaned)
  return {
    exists: result?.exists ?? false,
    jid: result?.jid ?? null,
  }
}

async function logout() {
  isLoggedOut = true
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  try {
    if (sock) await sock.logout()
  } catch (_) { }
  await clearSession()
  logW("Logout berhasil")
  send("auth:logged-out", null)
}

function getSocket() {
  return sock
}

function getConnectionStatus() {
  return {
    connected: isConnected,
    reconnecting: reconnectTimer !== null,
    reconnectAttempts,
    loggedOut: isLoggedOut,
    isSyncing,
  }
}

// ════════════════════════════════════════════════════════════
// EXPORT
// ════════════════════════════════════════════════════════════

module.exports = {
  init,
  forceReconnect,
  getSocket,
  getConnectionStatus,

  requestPairingCode,
  startQRMode,
  logout,
  clearSession,

  sendTextMessage,
  sendImage,
  sendVideo,
  sendAudio,
  sendDocument,
  sendSticker,
  sendLocation,
  sendContact,
  forwardMessage,

  deleteMessage,
  reactToMessage,
  editMessage,
  starMessage,

  markRead,
  markUnread,
  archiveChat,
  pinChat,
  muteChat,
  deleteChat,

  sendPresenceUpdate,
  subscribePresence,

  getContactInfo,
  updateMyStatus,
  updateMyName,

  getGroupMetadata,
  createGroup,
  addGroupParticipants,
  removeGroupParticipants,
  updateGroupAdmin,
  leaveGroup,
  updateGroupDescription,
  updateGroupName,
  getGroupInviteLink,

  downloadMedia,

  blockContact,
  checkNumberExists,
  normalizePhone,
  extractBody,

  // Database exports
  getMessagesFromDB,
  searchMessagesInDB,
  getChatsFromDB,
  getContactsFromDB,
  searchContactsInDB,
  getDBStats,
  getSyncStatus,
}