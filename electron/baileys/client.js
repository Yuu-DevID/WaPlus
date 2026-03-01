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

// Guard global — cegah Electron crash popup dari network error yang tidak tertangkap
// Khususnya: undici "terminated", fetch abort, dan ECONNRESET saat download media WA
process.on('unhandledRejection', (reason) => {
  const msg = reason?.message || String(reason)
  const isMediaNetworkErr =
    msg.includes('terminated') ||
    msg.includes('Failed to fetch') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ECACHEFULL') ||
    msg.includes('empty media key') ||
    msg.includes('Cannot derive')
  if (isMediaNetworkErr) return // suppress — sudah di-log di catch block masing-masing
  console.error('[AuroraChat] Unhandled rejection:', msg)
})

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
} = require("wileys")

// ADD MessageParser by Towartz
const { parseMessage, buildRendererPayload, normalizeJid, buildLidMap, isLidJid, resolveLid, tryResolveLid } = require("./messageParser")
const { Boom } = require("@hapi/boom")
const pino = require("pino")
const chalk = require("chalk")
const path = require("path")
const fs = require("fs")
const NodeCache = require("node-cache")

// ════════════════════════════════════════════════════════════
// DATABASE IMPORT
// ════════════════════════════════════════════════════════════
const db = require("./database")

// ════════════════════════════════════════════════════════════
// MOD MANAGER IMPORT
// ════════════════════════════════════════════════════════════
let modManager = null
try {
  modManager = require("../mods/modManager")
} catch (e) {
  console.warn("[AuroraChat] ModManager not available:", e.message)
}

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

// [FIX-LID] Persistent lid → real JID map.
// Built incrementally as contacts arrive from Baileys.
// Passed to parseMessage() so @lid is never stored in DB or sent to renderer.
//
// PERSISTENCE: saved to disk so it's available on reconnect BEFORE
// contacts.set fires. Without this, messages arriving before contacts.set
// (which can be seconds into a reconnect) leak @lid into the DB.
let lidMap = new Map()

const LID_MAP_PATH = path.resolve(CONFIG.SESSION_DIR, "../lid_map.json")

function loadLidMapFromDisk() {
  try {
    if (fs.existsSync(LID_MAP_PATH)) {
      const raw = JSON.parse(fs.readFileSync(LID_MAP_PATH, "utf8"))
      for (const [k, v] of Object.entries(raw)) lidMap.set(k, v)
      if (lidMap.size > 0) log(`[LID] Loaded ${lidMap.size} mappings from disk`)
    }
  } catch (_) {}
}

function saveLidMapToDisk() {
  try {
    const obj = {}
    for (const [k, v] of lidMap) obj[k] = v
    fs.writeFileSync(LID_MAP_PATH, JSON.stringify(obj), "utf8")
  } catch (_) {}
}

// Load persisted lid map immediately (before any connection)
loadLidMapFromDisk()

const msgRetryCache = new NodeCache({
  stdTTL: CONFIG.MSG_CACHE_TTL,
  maxKeys: CONFIG.MSG_CACHE_MAX,
})

// Ensure media directory exists
if (!fs.existsSync(CONFIG.MEDIA_DIR)) {
  fs.mkdirSync(CONFIG.MEDIA_DIR, { recursive: true })
}

// ════════════════════════════════════════════════════════════
// LID UTILITIES — persist, merge, and retroactively fix @lid rows
// ════════════════════════════════════════════════════════════

/**
 * mergeLidBatch — merge new lid→JID entries into the global lidMap,
 * persist to disk, and schedule a DB cleanup pass (2s debounce).
 * Always call this instead of mutating lidMap directly.
 */
function mergeLidBatch(batch) {
  if (!batch || batch.size === 0) return
  let newEntries = 0
  for (const [k, v] of batch) {
    if (!lidMap.has(k)) newEntries++
    lidMap.set(k, v)
  }
  if (newEntries > 0) {
    saveLidMapToDisk()
    scheduleResolveLidInDB()
  }
}

let _resolveLidTimer = null
function scheduleResolveLidInDB(delayMs = 2000) {
  if (_resolveLidTimer) clearTimeout(_resolveLidTimer)
  _resolveLidTimer = setTimeout(() => {
    _resolveLidTimer = null
    resolveLidInDB()
  }, delayMs)
}

/**
 * resolveLidInDB — retroactively fix any @lid JIDs that leaked into the DB
 * because lidMap was empty when the message/chat was first processed.
 * Runs in the DB layer which does it all in one SQLite transaction.
 */
function resolveLidInDB() {
  if (lidMap.size === 0) return
  try {
    const fixed = db.resolveLidRows(lidMap)
    if (fixed > 0) {
      console.log(`[LID] resolveLidInDB: fixed ${fixed} stale @lid rows`)
      send("db:chats:updated")
    }
  } catch (err) {
    console.warn(`[LID] resolveLidInDB error: ${err.message}`)
  }
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

// Semaphore sederhana untuk batasi concurrent download
// Mencegah overload koneksi saat history sync (ratusan media sekaligus)
const _dlQueue = { running: 0, max: 3 }
async function _withDlSemaphore(fn) {
  while (_dlQueue.running >= _dlQueue.max) {
    await new Promise(r => setTimeout(r, 200))
  }
  _dlQueue.running++
  try { return await fn() }
  finally { _dlQueue.running-- }
}

async function downloadAndSaveMedia(msg, messageType, isHistorySync = false) {
  if (isHistorySync) return { skipped: true, reason: "history_sync" }

  return _withDlSemaphore(async () => {
    const msgId   = msg.key.id
    const chatJid = msg.key.remoteJid

    // ── Notify renderer: download started ──────────────────
    send("media:download:start", { msgId, chatJid })

    try {
      // Unwrap inner message untuk viewOnce & wrappers lain
      const rawMsg = msg.message?.ephemeralMessage?.message
        || msg.message?.viewOnceMessage?.message
        || msg.message?.viewOnceMessageV2?.message
        || msg.message?.documentWithCaptionMessage?.message
        || msg.message
      const msgToDownload = rawMsg !== msg.message ? { ...msg, message: rawMsg } : msg

      const buffer = await Promise.resolve(
        downloadMediaMessage(msgToDownload, "buffer", {}, {
          logger,
          reuploadRequest: sock?.updateMediaMessage,
        })
      )

      if (!buffer || buffer.length === 0) {
        send("media:download:error", { msgId, chatJid })
        return null
      }

      const sizeMB = buffer.length / (1024 * 1024)
      if (sizeMB > CONFIG.MAX_MEDIA_SIZE_MB) {
        logW(`Media too large: ${sizeMB.toFixed(2)}MB, skipping`)
        send("media:download:error", { msgId, chatJid, reason: "too_large" })
        return { skipped: true, reason: "too_large", size: buffer.length }
      }

      const msgObj = msgToDownload.message?.[messageType]
      const ext = getExtensionFromMimetype(msgObj?.mimetype || "application/octet-stream")
      const filename = `${msg.key.id}_${Date.now()}.${ext}`
      const localPath = path.join(CONFIG.MEDIA_DIR, filename)

      fs.writeFileSync(localPath, buffer)
      db.updateMediaDownload?.(msg.key.id, localPath, buffer.length, "downloaded")
      db.updateMediaSavedPath?.(msg.key.id, localPath)

      logOk(`Media downloaded: ${filename} (${sizeMB.toFixed(2)}MB)`)

      // ── Notify renderer via main.js ──────────────────────
      try {
        const mainModule = require("../main")
        mainModule?.onMediaDownloaded?.({ msgId, chatJid, localPath })
      } catch (_) {}

      return { localPath, size: buffer.length, filename }
    } catch (error) {
      const msg_err = error.message || String(error)
      const isExpired = msg_err.includes("empty media key") || msg_err.includes("Cannot derive")
      const isNetwork = msg_err.includes("terminated") || msg_err.includes("fetch") || msg_err.includes("ECONNRESET")

      if (!isExpired) {
        isNetwork
          ? logW(`Media network error (${msgId?.slice(0, 8)}…): ${msg_err.slice(0, 80)}`)
          : logE(`Error downloading media: ${msg_err}`)
      }

      send("media:download:error", { msgId, chatJid, reason: msg_err.slice(0, 100) })
      try { db.updateMediaDownload?.(msgId, null, null, "failed", msg_err.slice(0, 200)) } catch (_) {}
      return { error: msg_err }
    }
  })
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
// ── ADD: resolveMediaTypeKey ─────────────────────────────────
// Mapping msgType → key di msg.message untuk downloadMediaMessage
// ════════════════════════════════════════════════════════════

function resolveMediaTypeKey(msgType, message) {
  if (!message) return null
  const m = message.ephemeralMessage?.message
    || message.viewOnceMessage?.message
    || message.viewOnceMessageV2?.message
    || message.documentWithCaptionMessage?.message
    || message

  const map = {
    imageMessage: "imageMessage",
    videoMessage: "videoMessage",
    audioMessage: "audioMessage",
    pttMessage: "audioMessage",
    documentMessage: "documentMessage",
    stickerMessage: "stickerMessage",
  }
  if (map[msgType] && m[map[msgType]]) return map[msgType]

  if (msgType === "viewOnceMessage") {
    const inner = m.viewOnceMessage?.message
    if (inner?.imageMessage) return "imageMessage"
    if (inner?.videoMessage) return "videoMessage"
  }
  if (msgType === "viewOnceMessageV2") {
    const inner = m.viewOnceMessageV2?.message
    if (inner?.imageMessage) return "imageMessage"
    if (inner?.videoMessage) return "videoMessage"
  }
  return null
}

// ════════════════════════════════════════════════════════════
// MESSAGE HANDLER
// ════════════════════════════════════════════════════════════

async function handleMessage(msg, type, isHistorySync = false) {
  if (!msg.message) return
  // [FIX-SPLIT-CHAT] Normalize remoteJid before ANY processing.
  // @c.us legacy and :device multi-device suffixes both cause duplicate chat rows.
  // Mutate key.remoteJid so all downstream code (parseMessage, db.*) see the clean form.
  if (msg.key?.remoteJid) {
    let rjid = normalizeJid(msg.key.remoteJid)
    // [FIX-LID] Resolve @lid remoteJid → real JID before anything else
    if (isLidJid(rjid)) rjid = resolveLid(rjid, lidMap)
    msg.key.remoteJid = rjid
  }
  // [FIX-LID] Also resolve @lid in participant field (group sender)
  if (msg.key?.participant) {
    let p = normalizeJid(msg.key.participant)
    if (isLidJid(p)) p = resolveLid(p, lidMap)
    msg.key.participant = p
  }
  if (isJidStatusBroadcast(msg.key.remoteJid || "")) return
  if (isJidBroadcast(msg.key.remoteJid || "")) return

  // ── Parse dengan messageParser ───────────────────────────
  const parsed = parseMessage(msg, {
    jid: msg.key.remoteJid,
    pushname: msg.pushName || null,
    isHistorySync,
    myJid: sock?.user?.id || null,
    lidMap,  // [FIX-LID] pass lid→JID map so quoted senders are resolved
  })
  if (!parsed?.id) return

  // ── Run mod hooks (onMessage) ────────────────────────────
  if (modManager && !isHistorySync) {
    try {
      const modResult = await modManager.runOnMessage(parsed, msg)
      if (modResult === false) return // plugin blocked this message
    } catch (e) {
      console.warn("[AuroraChat] ModManager.runOnMessage error:", e.message)
    }
  }

  // ── Simpan ke DB ─────────────────────────────────────────
  try {
    db.insertMessage(parsed)
  } catch (err) {
    if (err.message?.includes("UNIQUE")) {
      try { db.updateMessageStatus?.(parsed.id, parsed.status) } catch (_) {}
    } else {
      logE(`DB insert error: ${err.message}`)
      return
    }
  }

  // ── Queue media download (hanya live, bukan history sync) ─
  if (parsed.has_media && CONFIG.AUTO_DOWNLOAD_MEDIA && !isHistorySync) {
    const mediaTypeKey = resolveMediaTypeKey(parsed.msg_type, msg.message)
    if (mediaTypeKey) {
      db.queueMediaDownload?.(parsed.id, parsed.chat_jid, parsed.msg_type, parsed.media_url)
      downloadAndSaveMedia(msg, mediaTypeKey, false).catch(() => {})
    }
  }

  // ── Update chat last message di DB ────────────────────────
  if (!isHistorySync && parsed.chat_jid) {
    // [FIX-PREVIEW] Use full statement with msg_type so chat list preview is always current.
    // Also pass from_me so getChats SQL JOIN on messages.from_me reflects actual sender.
    db.updateChatLastMsg?.(parsed.chat_jid, {
      timestamp:  parsed.timestamp,
      message_id: parsed.id,
      body:       parsed.body || `[${parsed.msg_type}]`,
      msg_type:   parsed.msg_type,
    })
  }

  // ── [FIX-PUSHNAME] Persist sender pushname → contacts table ──
  // This is the source of truth for display names in chat list.
  // Without this, getChats() JOIN returns null and raw JID is shown.
  if (!isHistorySync && parsed.pushname && parsed.sender_jid && !parsed.from_me) {
    db.upsertContactPushname?.(parsed.sender_jid, parsed.pushname)
  }

  // ── [FIX-SENDER-NAME] Resolve sender_name from contacts DB before pushing ──
  // buildRendererPayload only has parsed.pushname (proto field).
  // We need: phonebook name > push_name > pushname from proto > null
  // This prevents duplicate/wrong name when contacts table has a better name.
  if (!parsed.from_me && parsed.sender_jid) {
    try {
      const contact = db.getContact?.(parsed.sender_jid)
      if (contact?.name || contact?.push_name) {
        parsed._resolved_sender_name = contact.name || contact.push_name
      }
    } catch (_) {}
  }
  // Also resolve quoted sender name
  if (parsed.quoted_sender && parsed.quoted_sender !== '__me__' && parsed.quoted_sender !== '__self__') {
    try {
      const qContact = db.getContact?.(parsed.quoted_sender)
      if (qContact?.name || qContact?.push_name) {
        parsed._resolved_quoted_sender_name = qContact.name || qContact.push_name
      }
    } catch (_) {}
  }

  // History sync: hanya save ke DB, tidak push ke renderer
  if (isHistorySync) {
    syncStats.messages++
    return
  }

  // ── Cache for retry ───────────────────────────────────────
  if (msg.message) msgRetryCache.set(msg.key.id, msg.message)

  // ── Log ───────────────────────────────────────────────────
  if (!parsed.from_me && parsed.body) {
    const colors = ["green", "yellow", "magenta", "cyan", "blue"]
    const c = colors[Math.floor(Math.random() * colors.length)]
    console.log(
      tag("green", "MSG"),
      chalk[c](`${parsed.pushname} (${parsed.chat_jid})`),
      chalk.white("→"),
      chalk.white(parsed.body.length > 120 ? parsed.body.slice(0, 120) + "…" : parsed.body)
    )
  }

  // ── Push ke renderer ─────────────────────────────────────
  send("messages:new", buildRendererPayload(parsed))
  send("db:chats:updated")
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
      return true
    },
    generateHighQualityLinkPreview: true,
    msgRetryCounterCache: msgRetryCache,
    keepAliveIntervalMs: 15000,       // more frequent keepalive
    connectTimeoutMs: 60000,          // 60s connect timeout
    defaultQueryTimeoutMs: 60000,     // 60s query timeout
    emitOwnEvents: true,
    retryRequestDelayMs: 500,
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

      // Set socket reference for mod manager
      if (modManager) {
        modManager.setSocket(sock)
        modManager.runOnConnect({ name: me?.name, jid: me?.id, phone: me?.id?.split(":")[0] }).catch(() => {})
      }

      // Start sync status
      db.startSync()
      send("sync:status", { isSyncing: true, progress: 0 })

      // [FIX-GROUP-NAME] Fetch group subjects for groups that have no name yet.
      // Run after a short delay to not block initial sync.
      setTimeout(async () => {
        try {
          const missingJids = db.getGroupsWithoutName?.() || []
          if (missingJids.length === 0) return
          log(`[FIX-GROUP-NAME] Fetching metadata for ${missingJids.length} groups...`)
          for (const jid of missingJids) {
            try {
              const meta = await sock.groupMetadata(jid)
              if (meta?.subject) {
                db.updateGroupSubject(jid, meta.subject)
                log(`[FIX-GROUP-NAME] ${jid} → "${meta.subject}"`)
              }
            } catch (_) {}
            // Small delay to avoid rate limit
            await new Promise(r => setTimeout(r, 300))
          }
          send("db:chats:updated")
        } catch (e) {
          logW(`[FIX-GROUP-NAME] fetch error: ${e.message}`)
        }
      }, 5000)
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

      // Notify mods about disconnect
      if (modManager) {
        modManager.runOnDisconnect(reason).catch(() => {})
      }

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

      if (statusCode === DisconnectReason.connectionReplaced) {
        logW("Connection replaced (multiple devices) — reconnect...")
        scheduleReconnect(2000)
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

    // Save chats — resolve @lid in chat.id before touching DB
    // [FIX-LID] Contacts arrive BEFORE chats in the same history sync batch,
    // so lidMap should already have mappings by the time we process chats.
    // We save contacts first, build lidMap, THEN save chats.
    // But for safety, we also resolve @lid here even if lidMap is partial.
    for (const contact of contacts) {
      db.saveContact(contact)
      if (contact.id && (contact.notify || contact.pushname)) {
        db.upsertContactPushname?.(contact.id, contact.notify || contact.pushname)
      }
    }

    // [FIX-LID] Build lidMap BEFORE saving chats so chat.id @lid can be resolved
    if (contacts.length > 0) {
      const batch = buildLidMap(contacts)
      mergeLidBatch(batch)

      // [FIX-LID-NAME] Save name under resolved real JID for @lid contacts
      for (const contact of contacts) {
        if (!contact.id) continue
        const rawJid = normalizeJid(contact.id)
        if (isLidJid(rawJid)) {
          const resolved = tryResolveLid(rawJid, lidMap)
          if (resolved !== rawJid && (contact.notify || contact.pushname || contact.name)) {
            db.upsertContactPushname?.(resolved, contact.notify || contact.pushname || contact.name)
          }
        }
      }
    }

    // Save chats — now lidMap is populated, resolve @lid in chat.id
    for (const chat of chats) {
      // Resolve @lid chat JID → real JID
      if (chat.id && isLidJid(chat.id)) {
        const resolved = resolveLid(chat.id, lidMap)
        if (resolved !== chat.id) {
          log(`[LID] Chat id resolved: ${chat.id} → ${resolved}`)
          chat.id = resolved
        }
      }
      db.saveChat(chat)
    }

  // Save messages (history) — OPTIMIZED: batch insert via transaction
  // Process in chunks to avoid blocking the event loop
  const BATCH_SIZE = 100
  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const chunk = messages.slice(i, i + BATCH_SIZE)
    for (const msg of chunk) {
      await handleMessage(msg, 'history', true)
    }
    // Yield to event loop between chunks to keep UI responsive
    if (i + BATCH_SIZE < messages.length) {
      await new Promise(r => setImmediate(r))
    }
  }

    // ── 4. Update sync status ──
    send("sync:status", {
      isSyncing: true,
      progress,
      stats: syncStats
    })

    // ── 5. Incremental chat list update every batch ──
    // Push to UI progressively so chats show up as they sync
    if (chats.length > 0) {
      setImmediate(() => {
        try { db.backfillChatLastMessages?.() } catch (_) {}
        send("db:chats:updated")
      })
    }

    // If complete
    if (isLatest) {
      isSyncing = false
      db.endSync(syncStats.chats, syncStats.messages)

      // [FIX-PUSHNAME-BACKFILL] Populate contacts table from messages.push_name
      // for all DM contacts that don't have a contacts row yet (unsaved contacts).
      // This runs in background after sync so it doesn't block the UI.
      setImmediate(() => {
        try {
          db.backfillChatLastMessages?.()
          db.backfillContactPushnames?.()
          send("db:chats:updated")
          send("db:contacts:updated")
        } catch (_) {}
      })
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
          db.updatePollVotes(key.id, JSON.stringify(pollResults))

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
    for (const chat of chats) {
      // [FIX-LID] Resolve @lid in chat.id before saving
      if (chat.id && isLidJid(chat.id)) {
        chat.id = resolveLid(chat.id, lidMap)
      }
      db.saveChat(chat)
    }
    send("chats:set", chats)
  })

  sock.ev.on("chats.upsert", (c) => {
    for (const chat of c) {
      // [FIX-LID] Resolve @lid in chat.id before saving
      if (chat.id && isLidJid(chat.id)) {
        chat.id = resolveLid(chat.id, lidMap)
      }
      db.saveChat(chat)
    }
    send("chats:upsert", c)
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

    // [FIX-PUSHNAME] contacts.set contains notify field = WA display name.
    // saveContact() already handles this via push_name = contact.pushname || contact.notify
    // But upsert it explicitly for safety so no name is ever dropped.
    for (const c of contacts) {
      if (c.id && (c.notify || c.pushname)) {
        db.upsertContactPushname?.(c.id, c.notify || c.pushname)
      }
    }

    // [FIX-LID] Build lid map from full contacts snapshot
    const batch = buildLidMap(contacts)
    mergeLidBatch(batch)

    // [FIX-LID-NAME] For contacts that have a @lid JID (c.id is @lid-like),
    // also save the pushname under the real resolved JID so getChats COALESCE finds it.
    // This handles the case where WA sends contacts with lid-based IDs.
    for (const c of contacts) {
      if (!c.id) continue
      const realJid = normalizeJid(c.id)
      if (isLidJid(realJid)) {
        const resolved = tryResolveLid(realJid, lidMap)
        if (resolved !== realJid && (c.notify || c.pushname || c.name)) {
          db.upsertContactPushname?.(resolved, c.notify || c.pushname || c.name)
          log(`[LID-NAME] contacts.set: ${realJid} → ${resolved}, name saved`)
        }
      }
    }
  })

  sock.ev.on("contacts.upsert", (c) => {
    send("contacts:upsert", c)
    const arr = Array.isArray(c) ? c : [c]
    db.saveContacts(arr)
    // [FIX-PUSHNAME] Same as contacts.set — also upsert notify
    for (const contact of arr) {
      if (contact.id && (contact.notify || contact.pushname)) {
        db.upsertContactPushname?.(contact.id, contact.notify || contact.pushname)
      }
    }
    // [FIX-LID] Merge new lid mappings
    const batch = buildLidMap(arr)
    mergeLidBatch(batch)

    // [FIX-LID-NAME] Also save name under resolved real JID
    for (const contact of arr) {
      if (!contact.id) continue
      const realJid = normalizeJid(contact.id)
      if (isLidJid(realJid)) {
        const resolved = tryResolveLid(realJid, lidMap)
        if (resolved !== realJid && (contact.notify || contact.pushname || contact.name)) {
          db.upsertContactPushname?.(resolved, contact.notify || contact.pushname || contact.name)
        }
      }
    }
  })

  sock.ev.on("contacts.update", (u) => send("contacts:update", u))

  // Other events
  sock.ev.on("presence.update", ({ id, presences }) => send("presence:update", { id, presences }))
  sock.ev.on("groups.update", (u) => {
    // [FIX-GROUP-NAME] Update group subjects when they change
    for (const update of u) {
      if (update.id && update.subject) {
        db.updateGroupSubject(normalizeJid(update.id), update.subject)
      }
    }
    send("groups:update", u)
  })

  // [FIX-GROUP-NAME] groups.upsert fires when groups are loaded by Baileys
  sock.ev.on("groups.upsert", (groups) => {
    for (const group of groups) {
      if (group.id && group.subject) {
        const jid = normalizeJid(group.id)
        db.updateGroupSubject(jid, group.subject)
        // Also ensure chat row exists
        db.saveChat({ id: group.id, name: group.subject, isGroup: true })
        log(`[FIX-GROUP-NAME] groups.upsert: ${jid} → "${group.subject}"`)
      }
    }
    if (groups.length > 0) send("db:chats:updated")
  })
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

  // Init mod manager
  if (modManager) {
    try { await modManager.init(win) } catch (e) {
      console.warn("[AuroraChat] ModManager init error:", e.message)
    }
  }

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
// PUBLIC: MEDIA PREFETCH
// Download a single media message by its DB row.
// Called from main.js media:prefetch IPC handler.
// Re-uses the same downloadAndSaveMedia pipeline.
// ════════════════════════════════════════════════════════════

async function downloadMediaForMsg(row) {
  if (!row?.id || !row?.message_json) return null
  if (!sock) return null

  try {
    const message = JSON.parse(row.message_json)
    const msgType = row.message_type

    // Build a minimal WAMessage compatible with downloadAndSaveMedia
    const fakeMsg = {
      key: {
        id: row.id,
        remoteJid: row.chat_jid,
        fromMe: false,
      },
      message,
    }

    const mediaTypeKey = resolveMediaTypeKey(msgType, message)
    if (!mediaTypeKey) return null

    // Check not already downloaded (race condition guard)
    const already = db.getMessageById(row.id)
    if (already?.media_is_downloaded) return null

    return await downloadAndSaveMedia(fakeMsg, mediaTypeKey, false)
  } catch (err) {
    // Silent — prefetch is best-effort
    logW(`[PREFETCH] downloadMediaForMsg ${row.id}: ${err.message?.slice(0, 60)}`)
    return null
  }
}

async function sendTextMessage(jid, text, opts = {}) {
  assertConnected()
  let payload = {
    text,
    ...(opts.mentions?.length ? { mentions: opts.mentions } : {}),
  }

  // ── Mod hook: onBeforeSend ────────────────────────────────
  if (modManager) {
    const result = await modManager.runOnBeforeSend(jid, payload).catch(() => payload)
    if (result === false) return null
    if (result && typeof result === "object") payload = result
  }

  const sentMsg = await sock.sendMessage(jid, payload, opts.quoted ? { quoted: opts.quoted } : {})

  // ── Mod hook: onAfterSend ─────────────────────────────────
  if (modManager) {
    modManager.runOnAfterSend(jid, payload, sentMsg).catch(() => {})
  }

  return sentMsg
}

async function sendImage(jid, image, caption = "", quoted = null) {
  assertConnected()
  const src = typeof image === "string" ? { url: image } : image
  let payload = { image: src, caption }

  if (modManager) {
    const result = await modManager.runOnBeforeSend(jid, payload).catch(() => payload)
    if (result === false) return null
    if (result && typeof result === "object") payload = result
  }

  const sentMsg = await sock.sendMessage(jid, payload, quoted ? { quoted } : {})
  if (modManager) modManager.runOnAfterSend(jid, payload, sentMsg).catch(() => {})
  return sentMsg
}

async function sendVideo(jid, video, caption = "", quoted = null) {
  assertConnected()
  const src = typeof video === "string" ? { url: video } : video
  let payload = { video: src, caption }

  if (modManager) {
    const result = await modManager.runOnBeforeSend(jid, payload).catch(() => payload)
    if (result === false) return null
    if (result && typeof result === "object") payload = result
  }

  const sentMsg = await sock.sendMessage(jid, payload, quoted ? { quoted } : {})
  if (modManager) modManager.runOnAfterSend(jid, payload, sentMsg).catch(() => {})
  return sentMsg
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
  let payload = { document: src, fileName, mimetype, caption }

  if (modManager) {
    const result = await modManager.runOnBeforeSend(jid, payload).catch(() => payload)
    if (result === false) return null
    if (result && typeof result === "object") payload = result
  }

  const sentMsg = await sock.sendMessage(jid, payload, quoted ? { quoted } : {})
  if (modManager) modManager.runOnAfterSend(jid, payload, sentMsg).catch(() => {})
  return sentMsg
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

// [FIX-PROFILE-PIC] getProfilePic — called by ChatItem via IPC
// Strategy:
//   1. Return DB-cached URL immediately if available (fast path)
//   2. Fetch fresh from WA network, cache to DB, return URL
//   3. On any error (including 404 / no pic), cache null so we don't retry
const _picFetchInProgress = new Set()
const _picFetchCooldown   = new Map() // jid → timestamp of last fetch

async function getProfilePic(jid) {
  if (!jid) return { url: null }
  // [FIX-SPLIT-CHAT] Normalize so cache key is always canonical form
  const cleanJid = normalizeJid(jid)
  if (!cleanJid) return { url: null }

  // 1. Check DB cache first — avoid network if already fetched
  const cached = db.getCachedProfilePic?.(cleanJid)
  if (cached !== null && cached !== undefined) {
    return { url: cached || null }
  }

  // 2. Debounce: don't fetch same JID more than once per 30 minutes
  const now = Date.now()
  const lastFetch = _picFetchCooldown.get(cleanJid) || 0
  if (now - lastFetch < 30 * 60 * 1000) {
    return { url: null }
  }

  // 3. Guard concurrent fetches for same JID
  if (_picFetchInProgress.has(cleanJid)) {
    return { url: null }
  }

  _picFetchInProgress.add(cleanJid)
  _picFetchCooldown.set(cleanJid, now)

  try {
    if (!sock) return { url: null }
    const url = await sock.profilePictureUrl(cleanJid, "image")
    db.cacheProfilePic?.(cleanJid, url || null)
    return { url: url || null }
  } catch (err) {
    // 404 = no profile pic set — cache null to stop retrying
    db.cacheProfilePic?.(cleanJid, null)
    return { url: null }
  } finally {
    _picFetchInProgress.delete(cleanJid)
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
// PUBLIC: STATUS (WhatsApp Story)
// ════════════════════════════════════════════════════════════

const STORY_COLORS = [
  '#7ACAA7', '#6E257E', '#5796FF', '#7E90A4', '#736769',
  '#57C9FF', '#25C3DC', '#FF7B6C', '#55C265', '#FF898B',
  '#8C6991', '#C69FCC', '#B8B226', '#EFB32F', '#AD8774',
  '#792139', '#C1A03F', '#8FA842', '#A52C71', '#8394CA', '#243640',
]
const STORY_FONTS = [0, 1, 2, 6, 7, 8, 9, 10]

function getStatusJidList() {
  // Get all personal contacts (not groups) from DB
  try {
    const contacts = db.getContacts(9999, 0)
    return contacts
      .map(c => c.jid)
      .filter(jid => jid && jid.includes("@s.whatsapp.net"))
  } catch (_) {
    return []
  }
}

async function sendStatus(payload) {
  assertConnected()

  const statusJidList = getStatusJidList()
  const randomColor = STORY_COLORS[Math.floor(Math.random() * STORY_COLORS.length)]
  const randomFont  = STORY_FONTS[Math.floor(Math.random() * STORY_FONTS.length)]

  const { type, text, mediaBuffer, mimetype, caption } = payload

  let sentMsg

  if (type === "text") {
    if (!text) throw new Error("Teks tidak boleh kosong")
    sentMsg = await sock.sendMessage(
      "status@broadcast",
      {
        text,
        backgroundColor: randomColor,
        textArgb: 0xffffffff,
        font: randomFont,
      },
      { statusJidList }
    )

  } else if (type === "image") {
    const buf = Buffer.isBuffer(mediaBuffer) ? mediaBuffer : Buffer.from(mediaBuffer)
    sentMsg = await sock.sendMessage(
      "status@broadcast",
      { image: buf, caption: caption || "", mimetype: mimetype || "image/jpeg" },
      { statusJidList }
    )

  } else if (type === "video") {
    const buf = Buffer.isBuffer(mediaBuffer) ? mediaBuffer : Buffer.from(mediaBuffer)
    sentMsg = await sock.sendMessage(
      "status@broadcast",
      { video: buf, caption: caption || "", mimetype: mimetype || "video/mp4" },
      { statusJidList }
    )

  } else if (type === "audio") {
    const buf = Buffer.isBuffer(mediaBuffer) ? mediaBuffer : Buffer.from(mediaBuffer)
    sentMsg = await sock.sendMessage(
      "status@broadcast",
      {
        audio: buf,
        mimetype: "audio/mp4",
        ptt: true,
        waveform: [100, 0, 100, 0, 100, 0, 100],
        backgroundColor: randomColor,
      },
      { statusJidList }
    )

  } else {
    throw new Error(`Tipe tidak didukung: ${type}`)
  }

  return { sentMsg, statusJidList, count: statusJidList.length }
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
  getProfilePic,
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
  downloadMediaForMsg,

  blockContact,
  checkNumberExists,
  normalizePhone,
  extractBody,

  sendStatus,
  getStatusJidList,

  // Database exports
  getMessagesFromDB,
  searchMessagesInDB,
  getChatsFromDB,
  getContactsFromDB,
  searchContactsInDB,
  getDBStats,
  getSyncStatus,
}