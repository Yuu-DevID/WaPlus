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
// ║    connection:open         → { name, jid, phone,          ║
// ║                                offlineSince, offlineGapSec}║
// ║    connection:close        → { statusCode, reason }       ║
// ║    connection:reconnecting → { attempt, maxAttempt, ms }  ║
// ║    connection:failed       → { attempts }                 ║
// ║    connection:error        → { message }                  ║
// ║    messages:new            → MessagePayload               ║
// ║    messages:history        → { count, isComplete }        ║
// ║    sync:resume:start       → { offlineSince, gapSeconds } ║
// ║    sync:resume:progress    → { messages, chats }          ║
// ║    sync:resume:complete    → { messages, chats }          ║
// ╚═══════════════════════════════════════════════════════════╝

"use strict"

// Guard global — cegah Electron crash popup dari network error yang tidak tertangkap
// Khususnya: undici "terminated", fetch abort, dan ECONNRESET saat download media WA
//
// [FIX] Use a Set of known-safe substrings so the list is easy to extend without
// duplicating logic. Only suppress errors we have confirmed are already caught and
// logged in their own catch blocks — everything else is logged at error level so
// bugs are not silently swallowed.
const _SUPPRESSED_REJECTION_PATTERNS = new Set([
  'terminated',
  'Failed to fetch',
  'ECONNRESET',
  'ECACHEFULL',
  'empty media key',
  'Cannot derive',
  'Connection Closed',    // Baileys socket closed mid-download
  'Connection Terminated',
  'Stream ended unexpectedly',
  'Cache max keys',       // [FIX-CACHE-OVERFLOW] node-cache overflow — handled by LRU eviction wrapper
])

process.on('unhandledRejection', (reason) => {
  const msg = reason?.message || String(reason)
  for (const pattern of _SUPPRESSED_REJECTION_PATTERNS) {
    if (msg.includes(pattern)) return // already handled in per-call catch blocks
  }
  console.error('[AuroraChat] Unhandled rejection:', msg)
})

// [FIX] Also guard uncaughtException — Baileys WebSocket can throw outside of
// Promises in rare cases (e.g. ws 'error' event without a listener).
process.on('uncaughtException', (err) => {
  const msg = err?.message || String(err)
  for (const pattern of _SUPPRESSED_REJECTION_PATTERNS) {
    if (msg.includes(pattern)) return
  }
  console.error('[AuroraChat] Uncaught exception:', msg)
  // Do NOT call process.exit() — Electron handles its own lifecycle
})

const {
  makeWASocket,
  Browsers,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  isJidBroadcast,
  isJidGroup,
  isJidStatusBroadcast,
  jidNormalizedUser,
  jidDecode,
  downloadMediaMessage,
  proto,
  getAggregateVotesInPollMessage,
} = require("baileys")

// ADD MessageParser by Towartz
const { parseMessage, buildRendererPayload, normalizeJid, buildLidMap, isLidJid, resolveLid, tryResolveLid, seedLidMap, initSock } = require("./messageParser")
// [JID-UTILS] Baileys-native JID type checks — consistent with how Baileys itself validates JIDs
const {
  isGroupJid, isNewsletterJid, isUserJid, isBroadcastJid, isStatusBroadcastJid, sameUser,
  parseJid,
} = require("./parser/jid-utils")
const { Boom } = require("@hapi/boom")
const pino = require("pino")
const chalk = require("chalk")
const path = require("path")
const fs = require("fs")
const NodeCache = require("node-cache")

// ════════════════════════════════════════════════════════════
// DATABASE IMPORT
// ════════════════════════════════════════════════════════════
// Required dbHandler methods for gap-fill (add if missing):
//   db.getChatsWithGap(sinceTs)         → [{jid, newest_msg_id, newest_from_me, newest_ts}]
//     SELECT jid, last_message_id as newest_msg_id, last_message_from_me as newest_from_me,
//            last_message_timestamp as newest_ts
//     FROM chats WHERE last_message_timestamp < sinceTs/1000 AND unread_count > 0
//     ORDER BY unread_count DESC LIMIT 50
//
//   db.getPlaceholderMessages()         → [{id, chat_jid, from_me}]
//     SELECT id, chat_jid, from_me FROM messages
//     WHERE (body IS NULL OR body = '') AND msg_type IS NULL
//     AND created_at > (strftime('%s','now') - 86400)  -- last 24h only
//     LIMIT 30
const db = require("./dbHandler")

// [FIX-STALE-SEQ] Reference to main.js exports for the seq counter bump.
// main.js sets module.exports._bumpChatSeq = bumpChatSeq after requiring client.js.
// We use a lazy reference so circular-require is not a problem at load time.
let mainModule = null
try { mainModule = require("../main") } catch (_) { /* optional — graceful if unavailable */ }

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

// [FIX-ASAR] Resolve writable user data directory for session & media.
// __dirname inside .asar is read-only — we must write to app.getPath('userData').
// Falls back to __dirname only in dev mode (outside .asar).
const { app } = (() => {
  try { return require('electron') } catch (_) { return { app: null } }
})()
const _USER_DATA_DIR = (app && app.getPath)
  ? app.getPath('userData')   // production: %APPDATA%/AuroraChat | ~/.config/AuroraChat | ~/Library/...
  : path.resolve(__dirname)   // dev fallback

const CONFIG = {
  SESSION_DIR: path.join(_USER_DATA_DIR, "session"),
  MEDIA_DIR: path.join(_USER_DATA_DIR, "media"),
  AUTH_MODE: "pairing",
  MAX_RECONNECT: 10,
  RECONNECT_BASE_MS: 1000,    // [PERF-CONN] 2s→1s: reconnect faster on first attempt
  RECONNECT_MAX_MS: 20000,    // [PERF-CONN] 30s→20s: don't wait too long between retries
  RECONNECT_JITTER_MS: 800,   // [PERF-CONN] 1500→800ms: less jitter = faster reconnect
  SYNC_FULL_HISTORY: true,
  MSG_CACHE_TTL: 120,     // [FIX-CACHE] Reduced TTL: 5min → 2min to free memory faster
  MSG_CACHE_MAX: 5000,    // [FIX-CACHE] 3000→5000: more headroom for busy sessions
  AUTO_DOWNLOAD_MEDIA: true,
  MAX_MEDIA_SIZE_MB: 100,
  AUTO_VIEW_STATUS: false,   // Auto read stories (anti-SW view)
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
let _syncAutoCompleteTimer = null  // [FIX-ENDLESS-SYNC] auto-complete guard

// ── Post-pause / resume sync state ──────────────────────────────────────────
// Tracks the timestamp of the last clean disconnect so that on reconnect we
// can calculate the "gap window" (time offline) and request any missed messages.
//
// PERSISTENCE: stored in SQLite kv_store so it survives app restarts without
// a separate flat JSON file. Transactional and crash-safe.
let _lastDisconnectTs = 0          // unix ms — set on every clean close
let _isResumeSyncing  = false      // true while gap-fill is in progress
let _resumeSyncStats  = { messages: 0, chats: new Set() }

function _loadLastDisconnectTs() {
  try {
    const ts = db.getLastDisconnectTs?.() || 0
    if (ts > 0) {
      _lastDisconnectTs = ts
      log(`[ResumeSync] Last disconnect loaded from DB: ${new Date(_lastDisconnectTs).toISOString()}`)
    }
    // One-time migration from old last_disconnect.json flat file
    if (ts === 0) {
      const oldPath = path.resolve(CONFIG.SESSION_DIR, '../last_disconnect.json')
      if (fs.existsSync(oldPath)) {
        try {
          const raw = JSON.parse(fs.readFileSync(oldPath, 'utf8'))
          if (typeof raw.ts === 'number' && raw.ts > 0) {
            _lastDisconnectTs = raw.ts
            db.setLastDisconnectTs?.(raw.ts)
            log(`[ResumeSync] Migrated last_disconnect.json → DB: ${new Date(raw.ts).toISOString()}`)
          }
          fs.unlinkSync(oldPath)
          log('[ResumeSync] last_disconnect.json removed after migration')
        } catch (_) {}
      }
    }
  } catch (_) {}
}

function _saveLastDisconnectTs(ts) {
  _lastDisconnectTs = ts
  try { db.setLastDisconnectTs?.(ts) } catch (_) {}
}

// Load on module start so it's ready before any connection attempt
_loadLastDisconnectTs()

// [FIX-LID] Persistent lid → real JID map.
// Built incrementally as contacts arrive from Baileys.
// Passed to parseMessage() so @lid is never stored in DB or sent to renderer.
//
// PERSISTENCE: stored in SQLite kv_store (replaces lid_map.json flat file).
// Transactional, crash-safe, and eliminates an extra file in the session dir.
//
// STRICT FILTER: Only @s.whatsapp.net JIDs are accepted as resolved values.
// We use Baileys jidDecode() to validate the server field — anything that is
// not 's.whatsapp.net' (groups @g.us, @lid, @newsletter, etc.) is rejected.
let lidMap = new Map()

function _isValidLidTarget(jid) {
  // Strict: resolved JID must be a real user JID — @s.whatsapp.net ONLY.
  // Uses jidDecode from Baileys (already imported at top of file) to parse
  // the server field. Rejects groups, newsletters, broadcast, and @lid itself.
  if (!jid || typeof jid !== 'string') return false
  try {
    const decoded = jidDecode(jid)
    return decoded?.server === 's.whatsapp.net' && !!decoded?.user
  } catch (_) {
    // jidDecode not available in this Baileys build — fall back to string check
    return jid.endsWith('@s.whatsapp.net') && !jid.includes('@lid')
  }
}

let _lidSaveTimer = null
function _saveLidMapToDB() {
  // Debounce: batch multiple rapid lid updates into a single DB write.
  if (_lidSaveTimer) clearTimeout(_lidSaveTimer)
  _lidSaveTimer = setTimeout(() => {
    _lidSaveTimer = null
    try { db.setLidMap?.(lidMap) } catch (_) {}
  }, 3000)  // 3s debounce — lid map is not time-critical
}

// Compat alias used by mergeLidBatch internals
function saveLidMapToDisk() { _saveLidMapToDB() }

function loadLidMapFromDisk() {
  try {
    const loaded = db.getLidMap?.() || new Map()
    // Strict filter: only keep entries where value is @s.whatsapp.net
    let kept = 0, dropped = 0
    for (const [k, v] of loaded) {
      if (_isValidLidTarget(v)) {
        lidMap.set(k, v)
        kept++
      } else {
        dropped++
      }
    }
    if (kept > 0) {
      log(`[LID] Loaded ${kept} mappings from DB${dropped > 0 ? ` (dropped ${dropped} non-@s.whatsapp.net)` : ''}`)
      seedLidMap(lidMap)
    }
    // Migrate stale lid_map.json if it exists (one-time upgrade)
    _migrateLidMapJsonIfExists()
  } catch (_) {}
}

function _migrateLidMapJsonIfExists() {
  // One-time migration from the old lid_map.json flat file to DB.
  // After migration, the file is removed so it won't interfere with future runs.
  try {
    const oldPath = path.resolve(CONFIG.SESSION_DIR, '../lid_map.json')
    if (!fs.existsSync(oldPath)) return
    const raw = JSON.parse(fs.readFileSync(oldPath, 'utf8'))
    let migrated = 0
    for (const [k, v] of Object.entries(raw)) {
      if (!lidMap.has(k) && _isValidLidTarget(v)) {
        lidMap.set(k, v)
        migrated++
      }
    }
    if (migrated > 0) {
      log(`[LID] Migrated ${migrated} entries from lid_map.json → DB`)
      seedLidMap(lidMap)
      db.setLidMap?.(lidMap)
    }
    fs.unlinkSync(oldPath)
    log('[LID] lid_map.json removed after migration')
  } catch (_) {}
}

// Load persisted lid map immediately (before any connection)
loadLidMapFromDisk()

// [FIX-3] Load persisted settings from userData so AUTO_DOWNLOAD_MEDIA is correct at boot.
// [FIX] Deduplicated require() calls — use top-level fs/path already imported above.
;(function _loadPersistedSettings() {
  try {
    const { app } = require('electron')
    const sPath = path.join(app.getPath('userData'), 'wplus_settings.json')
    if (fs.existsSync(sPath)) {
      const s = JSON.parse(fs.readFileSync(sPath, 'utf8'))
      if (typeof s.autoDownloadMedia === 'boolean') {
        CONFIG.AUTO_DOWNLOAD_MEDIA = s.autoDownloadMedia
        console.log('[AuroraClient] Settings loaded: AUTO_DOWNLOAD_MEDIA =', CONFIG.AUTO_DOWNLOAD_MEDIA)
      }
      if (typeof s.autoViewStatus === 'boolean') {
        CONFIG.AUTO_VIEW_STATUS = s.autoViewStatus
        console.log('[AuroraClient] Settings loaded: AUTO_VIEW_STATUS =', CONFIG.AUTO_VIEW_STATUS)
      }
    }
  } catch (_) { }
})()

const msgRetryCache = new NodeCache({
  stdTTL: CONFIG.MSG_CACHE_TTL,
  maxKeys: CONFIG.MSG_CACHE_MAX,
  errorOnMissing: false,
})

// [FIX-CACHE-OVERFLOW] node-cache throws "Cache max keys amount exceeded" instead of
// silently evicting when full. Wrap .set() so overflow is handled gracefully:
//   1. On overflow error → evict the 10% oldest keys (LRU-lite) then retry once.
//   2. On any other error → log and skip (never crash the message handler).
// This proxy is transparent to Baileys which uses the same object as msgRetryCounterCache.
const _origMsgSet = msgRetryCache.set.bind(msgRetryCache)
msgRetryCache.set = function _safeMsgCacheSet(key, value, ttl) {
  try {
    return ttl !== undefined ? _origMsgSet(key, value, ttl) : _origMsgSet(key, value)
  } catch (err) {
    if (err?.message?.includes('max keys')) {
      // Evict oldest ~10% of entries to make room
      try {
        const keys = msgRetryCache.keys()
        const evictCount = Math.max(1, Math.floor(keys.length * 0.1))
        for (let i = 0; i < evictCount; i++) msgRetryCache.del(keys[i])
        // Retry once after eviction
        return ttl !== undefined ? _origMsgSet(key, value, ttl) : _origMsgSet(key, value)
      } catch (_) { /* eviction failed — skip silently */ }
    }
    // Any other error — skip, never crash message pipeline
  }
}

// Cache full WAMessage proto (msg) untuk DevEval full dump
// Simpan 500 pesan terakhir, TTL 5 menit — [FIX-CACHE] increased cap, no throw on miss
const rawMsgCache = new NodeCache({
  stdTTL: 300,
  maxKeys: 500,
  errorOnMissing: false,
})
// [FIX-CACHE-OVERFLOW] Same LRU eviction guard as msgRetryCache
const _origRawSet = rawMsgCache.set.bind(rawMsgCache)
rawMsgCache.set = function _safeRawCacheSet(key, value, ttl) {
  try {
    return ttl !== undefined ? _origRawSet(key, value, ttl) : _origRawSet(key, value)
  } catch (err) {
    if (err?.message?.includes('max keys')) {
      try {
        const keys = rawMsgCache.keys()
        const evictCount = Math.max(1, Math.floor(keys.length * 0.1))
        for (let i = 0; i < evictCount; i++) rawMsgCache.del(keys[i])
        return ttl !== undefined ? _origRawSet(key, value, ttl) : _origRawSet(key, value)
      } catch (_) {}
    }
  }
}

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
    // [STRICT-JID] Only accept @s.whatsapp.net as resolved target.
    // Rejects groups, newsletters, broadcast, and any remaining @lid values.
    if (!_isValidLidTarget(v)) continue
    if (!lidMap.has(k)) newEntries++
    lidMap.set(k, v)
  }
  if (newEntries > 0) {
    // [FIX-LID-WARN] Keep jid-utils _globalLidMap in sync — it's the one
    // normalizeJid() reads internally. Without this, new @lid entries added
    // via contacts.set/upsert during session won't be resolved.
    seedLidMap(batch)
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

// ── LID pending set ─────────────────────────────────────────────────────────
// @lid JIDs seen in messages before contacts.set populated the map.
// Resolution happens passively: when contacts events arrive and update lidMap,
// _drainLidProbeQueue() is called to patch the DB. No network probing needed —
// the only authoritative source of lid→JID is Baileys contact events and the
// pnJid/lidJid fields on chat objects in messaging-history.set.
const _pendingLidProbe = new Set()

function _enqueueLidProbe(lid) {
  if (!lid || !isLidJid(lid)) return
  if (lidMap.has(lid)) return
  _pendingLidProbe.add(lid)
}

async function _drainLidProbeQueue() {
  if (_pendingLidProbe.size === 0) return
  let resolved = 0
  for (const lid of [..._pendingLidProbe]) {
    if (!isLidJid(tryResolveLid(lid, lidMap))) {
      _pendingLidProbe.delete(lid)
      resolved++
    }
  }
  if (resolved > 0) {
    log(`[LID] Drained ${resolved} pending @lid (${_pendingLidProbe.size} still unknown)`)
    scheduleResolveLidInDB(500)
  }
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

// Sanitize data before IPC — handles BigInt, Buffer, undefined, circular refs
// [PERF-IPC] Fast sanitize — single JSON.stringify pass, no redundant JSON.parse.
// Electron's webContents.send() accepts a plain object directly; it calls its own
// structured-clone internally. We only need to strip types IPC can't handle:
// BigInt, Buffer/Uint8Array, undefined. JSON.parse is dropped — saves ~40% on
// large payloads (thumbnails, long messages).
function sanitize(obj) {
  try {
    const str = JSON.stringify(obj, (_, v) => {
      if (typeof v === 'bigint') return Number(v)
      if (v instanceof Uint8Array || Buffer.isBuffer(v)) return v.toString('base64')
      if (v === undefined) return null
      return v
    })
    return JSON.parse(str)
  } catch (_) {
    return null
  }
}

// [PERF-IPC] Fast-path: if data is a plain string/number/null, skip sanitize entirely.
// Used for high-frequency events like messages:new where payload is pre-built.
function sendRaw(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send(channel, data === undefined ? null : data)
    } catch (e) {
      console.warn(`[IPC] Failed to send "${channel}":`, e.message)
    }
  }
}

function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send(channel, data === undefined ? null : sanitize(data))
    } catch (e) {
      console.warn(`[IPC] Failed to send "${channel}":`, e.message)
    }
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

// ════════════════════════════════════════════════════════════
// NETWORK-AWARE RECONNECT
// ════════════════════════════════════════════════════════════
// Electron exposes net.isOnline() — use it to pause reconnect attempts when
// the network is gone (saves battery/CPU and avoids filling logs with futile
// attempts), then immediately trigger a fresh reconnect when network returns.
//
// Handles paused Wi-Fi, sleep/wake, VPN disconnect, etc.
// ────────────────────────────────────────────────────────────
let _networkResumeTimer = null

function _isNetworkOnline() {
  try { return require('electron').net.isOnline() } catch (_) { return true }
}

function _onNetworkOnline() {
  // Network just came back — if we were in a waiting-to-reconnect state,
  // cancel the pending backoff timer and reconnect immediately.
  if (isConnected || isLoggedOut) return
  logOk('[NET] Jaringan tersedia — reconnect segera...')
  send('connection:reconnecting', { attempt: reconnectAttempts, maxAttempt: CONFIG.MAX_RECONNECT, delayMs: 0 })
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  if (_networkResumeTimer) { clearTimeout(_networkResumeTimer); _networkResumeTimer = null }
  // [PERF-CONN] 200ms grace (was 500ms) — just enough for TCP stack to settle.
  // Faster network resume = fewer missed messages after sleep/reconnect.
  _networkResumeTimer = setTimeout(() => {
    _networkResumeTimer = null
    if (!isConnected && !isLoggedOut) {
      reconnectAttempts = Math.max(0, reconnectAttempts - 1)  // reset penalty — fresh network
      connectToWhatsApp().catch(err => {
        logE(`[NET] Reconnect error setelah jaringan online: ${err.message}`)
        scheduleReconnect()
      })
    }
  }, 200)
}

// Hook into Electron's powerMonitor for sleep/wake events too.
// [FIX-LISTENER-LEAK] Guard with a flag — this block runs at module load time
// (once), but be explicit so it can never accidentally stack on hot-reload.
let _electronListenersHooked = false
try {
  const { net, powerMonitor } = require('electron')
  if (!_electronListenersHooked) {
    _electronListenersHooked = true
    const _onOffline = () => {
      if (!isConnected) logW('[NET] Jaringan offline — tahan reconnect')
    }
    const _onPowerResume = () => {
      if (!isConnected && !isLoggedOut) {
        logOk('[PWR] Resume dari sleep — cek jaringan...')
        setTimeout(_onNetworkOnline, 1000)
      }
    }
    net.on?.('online',   _onNetworkOnline)
    net.on?.('offline',  _onOffline)
    powerMonitor.on?.('resume', _onPowerResume)
  }
} catch (_) { /* electron not available in test env */ }

function assertConnected() {
  if (!sock) throw new Error("Tidak ada koneksi aktif ke WhatsApp")
}

// ════════════════════════════════════════════════════════════
// MEDIA DOWNLOAD HANDLER
// ════════════════════════════════════════════════════════════
//
// Architecture: Priority Queue + Lazy Download
//
//  PRIORITY LEVELS (higher = downloaded first):
//    P0 = 10  Active conversation (user is looking at the chat right now)
//    P1 =  5  Recent chats (last N viewed)
//    P2 =  2  Background prefetch (triggered on chat-list load)
//    P3 =  0  History sync / bulk import
//
//  CONCURRENCY SLOTS:
//    - Active (P0)    : up to 3 parallel  → fast for visible media
//    - Background     : up to 1 parallel  → won't saturate WA connection
//
//  FLOOD PROTECTION:
//    - Jitter between downloads (300–800ms base)
//    - Exponential backoff on "Failed to re-upload" (WA rate limit)
//    - Per-JID cooldown: after N failures on same JID, pause that JID
//    - Global circuit breaker: after M consecutive failures → pause all
//    - "Failed to re-upload (2|3)" → expired media → skip silently
//
//  WA DISCONNECT SAFETY:
//    - Queue drains when socket drops (pause, not cancel)
//    - Resumes automatically on reconnect
//    - No request is ever made when isConnected=false
// ════════════════════════════════════════════════════════════

// ── Priority constants ────────────────────────────────────────────────────────
const DL_PRIORITY = Object.freeze({ ACTIVE: 10, RECENT: 5, BACKGROUND: 2, HISTORY: 0 })

// ── Per-JID failure tracker ───────────────────────────────────────────────────
// If a JID gets too many "re-upload failed" errors, we pause it temporarily.
const _jidFailCount  = new Map()   // jid → { count, pauseUntil }
const JID_FAIL_MAX   = 4           // failures before JID cooldown
const JID_FAIL_PAUSE = 60_000      // pause JID for 1 min

// ── Global circuit breaker ────────────────────────────────────────────────────
// Too many consecutive global failures → stop all downloads for a bit.
let _consecutiveFailures = 0
let _circuitOpenUntil    = 0
const CIRCUIT_FAIL_MAX   = 8
const CIRCUIT_PAUSE_MS   = 120_000   // 2 min pause when circuit opens

// ── Active conversation JID ───────────────────────────────────────────────────
// Set by setActiveChat() called from IPC when user opens a chat.
let _activeJid = null

function setActiveChat(jid) {
  _activeJid = jid || null
}

function getActiveChat() {
  return _activeJid
}

// ── Priority download queue ───────────────────────────────────────────────────
//
// Each item: { row, priority, resolve, reject, addedAt }
// Sorted by priority DESC, then addedAt ASC (FIFO within same priority).
//
// Active slot (P0): up to 3 concurrent
// Background slot : up to 1 concurrent
//
const _dlQueue      = []       // pending items sorted by priority
let _dlRunningHigh  = 0        // P0 (active chat) slots in use
let _dlRunningLow   = 0        // background slots in use
const DL_MAX_HIGH   = 3
const DL_MAX_LOW    = 1
// [FIX-DL-DEDUP] Track msgIds that are queued OR currently downloading.
// Prevents the same file being downloaded twice from parallel triggers
// (e.g. prefetchChatMedia + messages.upsert both firing for same msg).
const _dlInFlight   = new Set()   // msgId → true while queued or running

// Jitter between individual downloads to avoid pattern detection by WA
function _dlJitter(priority) {
  // Active = fast (50–200ms), background = slow (300–800ms)
  const base = priority >= DL_PRIORITY.ACTIVE ? 50 : 300
  const extra = priority >= DL_PRIORITY.ACTIVE ? 150 : 500
  return base + Math.floor(Math.random() * extra)
}

/**
 * _enqueueDownload — add a row to the priority download queue.
 * Returns a Promise that resolves when the download completes.
 *
 * @param {object} row       — DB message row
 * @param {number} priority  — DL_PRIORITY constant
 */
function _enqueueDownload(row, priority = DL_PRIORITY.BACKGROUND) {
  const msgId = row?.id
  return new Promise((resolve, reject) => {
    // [FIX-DL-DEDUP] If this msgId is already in-flight (queued or downloading),
    // don't add a duplicate. But if the new request has higher priority, upgrade
    // the existing queue item so it gets promoted to the front.
    if (msgId && _dlInFlight.has(msgId)) {
      const existing = _dlQueue.find(item => item.row?.id === msgId)
      if (existing && priority > existing.priority) {
        existing.priority = priority
        // Re-sort after priority upgrade
        _dlQueue.sort((a, b) =>
          b.priority !== a.priority ? b.priority - a.priority : a.addedAt - b.addedAt
        )
        _dlTick()
      }
      // Resolve immediately with a dedup signal — caller doesn't need to wait
      resolve({ skipped: true, reason: 'already_in_flight' })
      return
    }
    if (msgId) _dlInFlight.add(msgId)
    _dlQueue.push({ row, priority, resolve, reject, addedAt: Date.now() })
    // Keep sorted: highest priority first, oldest first on tie
    _dlQueue.sort((a, b) =>
      b.priority !== a.priority ? b.priority - a.priority : a.addedAt - b.addedAt
    )
    _dlTick()
  })
}

/**
 * _dlTick — try to start a pending download if a slot is free.
 * Called after every enqueue and every download completion.
 */
function _dlTick() {
  if (_dlQueue.length === 0) return
  if (!isConnected || !sock)  return   // queue pauses when disconnected

  // Circuit breaker check
  if (Date.now() < _circuitOpenUntil) return

  // Find next runnable item
  for (let i = 0; i < _dlQueue.length; i++) {
    const item = _dlQueue[i]
    const isHigh = item.priority >= DL_PRIORITY.ACTIVE

    // Check per-JID cooldown
    const jid = item.row.chat_jid || item.row.remote_jid || ''
    const jidState = _jidFailCount.get(jid)
    if (jidState?.pauseUntil && Date.now() < jidState.pauseUntil) continue

    if (isHigh && _dlRunningHigh < DL_MAX_HIGH) {
      _dlQueue.splice(i, 1)
      _dlRunningHigh++
      _runDownload(item, true)
      return
    }
    if (!isHigh && _dlRunningLow < DL_MAX_LOW) {
      _dlQueue.splice(i, 1)
      _dlRunningLow++
      _runDownload(item, false)
      return
    }
  }
}

/**
 * _runDownload — execute one download item, handle completion/failure.
 */
async function _runDownload(item, isHighPriority) {
  const { row, priority, resolve, reject } = item
  const jid = row.chat_jid || row.remote_jid || ''

  // Jitter before starting (skip for P0 to feel snappy)
  if (priority < DL_PRIORITY.ACTIVE) {
    await new Promise(r => setTimeout(r, _dlJitter(priority)))
  }

  try {
    const result = await _downloadMediaForRowInner(row)

    // Success → reset failure counters
    _consecutiveFailures = 0
    if (_jidFailCount.has(jid)) {
      _jidFailCount.get(jid).count = 0
      _jidFailCount.get(jid).pauseUntil = 0
    }

    resolve(result)
  } catch (err) {
    const msg = err?.message || String(err)
    const isExpired   = _isExpiredMedia(msg)
    const isReupload  = msg.includes('Failed to re-upload')
    const isRateLimit = msg.includes('rate') || msg.includes('429') || msg.includes('503')

    if (isExpired) {
      // Silently skip — media URL expired, no point retrying.
      // Mark in DB so this row is excluded from all future pending queries.
      if (row?.id) db.markMediaExpired?.(row.id)
      resolve({ skipped: true, reason: 'expired' })
    } else if (isReupload || isRateLimit) {
      // WA rate limiting — back off this JID and increment global counter
      _consecutiveFailures++
      const jidState = _jidFailCount.get(jid) || { count: 0, pauseUntil: 0 }
      jidState.count++
      if (jidState.count >= JID_FAIL_MAX) {
        jidState.pauseUntil = Date.now() + JID_FAIL_PAUSE
        logW(`[DL] JID ${jid.slice(0, 20)}… paused for ${JID_FAIL_PAUSE / 1000}s after ${jidState.count} failures`)
      }
      _jidFailCount.set(jid, jidState)

      if (_consecutiveFailures >= CIRCUIT_FAIL_MAX) {
        _circuitOpenUntil = Date.now() + CIRCUIT_PAUSE_MS
        _consecutiveFailures = 0
        logW(`[DL] Circuit breaker OPEN — pausing all downloads for ${CIRCUIT_PAUSE_MS / 1000}s`)
      }
      resolve({ skipped: true, reason: 'reupload_failed', error: msg })
    } else {
      _consecutiveFailures++
      logE(`[DL] Error ${row.id?.slice(0, 12)}: ${msg.slice(0, 100)}`)
      resolve({ error: msg })
    }
  } finally {
    if (isHighPriority) _dlRunningHigh--
    else                _dlRunningLow--
    // [FIX-DL-DEDUP] Clear in-flight tracking so this msgId can be re-queued if needed
    if (row?.id) _dlInFlight.delete(row.id)
    // Schedule next tick with minimal delay
    setImmediate(_dlTick)
  }
}

/**
 * _isExpiredMedia — detect WA expired media errors.
 * "Failed to re-upload media (2)" and "(3)" are WA's error codes for
 * expired/unavailable media that can never be recovered without the sender re-sending.
 */
function _isExpiredMedia(msg) {
  return (
    msg.includes('Failed to re-upload media (2)') ||
    msg.includes('Failed to re-upload media (3)') ||
    msg.includes('empty media key') ||
    msg.includes('Cannot derive') ||
    msg.includes('media not available') ||
    msg.includes('404') ||
    msg.includes('403') ||      // [FIX-EXPIRED] HTTP 403 = media CDN URL expired
    msg.includes('AggregateError') // [FIX-EXPIRED] DNS/network failure on dead CDN URL
  )
}

/**
 * pauseDownloads — called on socket disconnect to freeze the queue.
 * In-flight downloads will complete (or error) but no new ones start.
 * Also stamps the disconnect time so post-resume gap sync knows its window.
 */
function pauseDownloads() {
  // Record the moment we went offline so the resume sync can request the gap.
  // Only update if we were genuinely connected (avoids overwriting a valid
  // timestamp on intermediate reconnect attempts that never reached open).
  if (isConnected) {
    _saveLastDisconnectTs(Date.now())
    log(`[ResumeSync] Disconnect stamped: ${new Date(_lastDisconnectTs).toISOString()}`)
  }
  // Nothing else to do — _dlTick() already checks isConnected.
  // Items remain in _dlQueue, ready to resume on reconnect.
  logW(`[DL] Queue paused (${_dlQueue.length} pending)`)
}

/**
 * resumeDownloads — called on socket reconnect.
 * Kick the queue back into motion.
 */
function resumeDownloads() {
  _consecutiveFailures = 0   // fresh start on reconnect
  if (_dlQueue.length > 0) {
    log(`[DL] Queue resuming (${_dlQueue.length} pending)`)
    // Re-prioritize: bump up active chat items
    _reprioritizeQueue()
    _dlTick()
  }
}

/**
 * getResumeSyncStatus — expose gap-fill sync progress to renderer / IPC.
 */
function getResumeSyncStatus() {
  return {
    active:   _isResumeSyncing,
    messages: _resumeSyncStats.messages,
    chats:    _resumeSyncStats.chats.size,
  }
}

/**
 * _reprioritizeQueue — re-score pending items based on current _activeJid.
 * Called on reconnect and on setActiveChat().
 */
function _reprioritizeQueue() {
  if (!_activeJid) return
  for (const item of _dlQueue) {
    const jid = item.row.chat_jid || item.row.remote_jid || ''
    if (jid === _activeJid && item.priority < DL_PRIORITY.ACTIVE) {
      item.priority = DL_PRIORITY.ACTIVE
    }
  }
  _dlQueue.sort((a, b) =>
    b.priority !== a.priority ? b.priority - a.priority : a.addedAt - b.addedAt
  )
}

/**
 * prioritizeChat — boost all queued items for a JID to ACTIVE priority.
 * Call this when user opens a chat so their media loads first.
 */
function prioritizeChat(jid) {
  setActiveChat(jid)
  _reprioritizeQueue()
  // Also kick the tick in case a slot just freed up
  _dlTick()
}

// ── Core download implementation ──────────────────────────────────────────────

/**
 * _downloadMediaForRowInner — the actual download logic for one DB row.
 * Does NOT manage slots or retries — that's _runDownload's job.
 * Throws on all errors so _runDownload can classify them.
 */
async function _downloadMediaForRowInner(row) {
  const msgId  = row.id
  const msgType = row.msg_type || row.message_type

  // ── Already downloaded? ──────────────────────────────────
  // [FIX-DL-SMART] If file exists on disk, notify the renderer anyway.
  // The renderer may not have the path in its state (e.g. background download
  // completed while the chat wasn't loaded — the IPC event was missed).
  // Re-sending media:updated is idempotent and cheap.
  if (row.media_is_downloaded === 1 || row.media_saved_path) {
    if (row.media_saved_path && fs.existsSync(row.media_saved_path)) {
      const chatJid = row.chat_jid || row.remote_jid
      if (msgId && chatJid) {
        try {
          const mainModule = require('../main')
          mainModule?.onMediaDownloaded?.({ msgId, chatJid, localPath: row.media_saved_path })
        } catch (_) {}
      }
      return { skipped: true, reason: 'already_on_disk', localPath: row.media_saved_path }
    }
    // Flag set but file gone — fall through to re-download
  }

  // ── Build or reconstruct message object ──────────────────
  let message = null
  let mediaTypeKey = null
  let innerMediaObj = null

  if (row.raw_json || row.message_json) {
    try {
      message = JSON.parse(row.raw_json || row.message_json)
    } catch (_) { message = null }
  }

  if (message) {
    mediaTypeKey = resolveMediaTypeKey(msgType, message)
    if (mediaTypeKey) {
      const unwrapped = message?.ephemeralMessage?.message
        || message?.viewOnceMessage?.message
        || message?.viewOnceMessageV2?.message
        || message?.documentWithCaptionMessage?.message
        || message
      innerMediaObj = unwrapped?.[mediaTypeKey]
      if (!innerMediaObj?.url && !innerMediaObj?.directPath && !innerMediaObj?.mediaKey) {
        message = null; mediaTypeKey = null; innerMediaObj = null
      }
    } else {
      message = null
    }
  }

  // ── Reconstruct from DB crypto fields if message_json missing ──
  if (!message) {
    const dbKey  = row.media_key        || null
    const dbUrl  = row.media_url        || null
    const dbPath = row.media_direct_path|| null
    const dbEnc  = row.media_enc_sha256 || null
    const dbMime = row.media_mimetype   || row.mimetype || null
    const dbType = msgType              || 'imageMessage'

    if (!dbKey) {
      // Truly unrecoverable without re-upload from sender
      throw new Error(`No media_key in DB for ${msgId}`)
    }
    if (!dbUrl && !dbPath) {
      throw new Error(`No media_url/direct_path in DB for ${msgId}`)
    }

    let mediaKeyBuf
    try { mediaKeyBuf = Buffer.from(dbKey, 'base64') }
    catch (_) { throw new Error(`Invalid media_key base64 for ${msgId}`) }

    let encBuf = null
    if (dbEnc) { try { encBuf = Buffer.from(dbEnc, 'base64') } catch (_) {} }

    const simpleType = ['imageMessage','videoMessage','audioMessage','documentMessage','stickerMessage'].includes(dbType)
      ? dbType
      : (dbType === 'pttMessage' ? 'audioMessage' : 'imageMessage')

    const reconstructed = {
      url: dbUrl, directPath: dbPath,
      mediaKey: mediaKeyBuf,
      mimetype: dbMime || 'application/octet-stream',
      fileLength: row.media_size || undefined,
    }
    if (encBuf) reconstructed.fileEncSha256 = encBuf

    message = { [simpleType]: reconstructed }
    mediaTypeKey = simpleType
    innerMediaObj = reconstructed
  }

  if (!mediaTypeKey || !innerMediaObj) {
    throw new Error(`Cannot resolve mediaTypeKey for ${msgId} (${msgType})`)
  }

  // ── Abort early if socket gone ────────────────────────────
  if (!isConnected || !sock) throw new Error('Not connected')

  // ── Build fake msg key and download ──────────────────────
  const fromMe = row.from_me === 1 || row.from_me === true
  const fakeMsg = {
    key: {
      id:        msgId,
      remoteJid: row.chat_jid || row.remote_jid,
      fromMe,
    },
    message,
  }

  const chatJid = fakeMsg.key.remoteJid
  send('media:download:start', { msgId, chatJid })

  // Unwrap wrappers so downloadMediaMessage sees the right inner object
  const rawInner = message?.ephemeralMessage?.message
    || message?.viewOnceMessage?.message
    || message?.viewOnceMessageV2?.message
    || message?.documentWithCaptionMessage?.message
    || message
  const msgToDownload = rawInner !== message ? { ...fakeMsg, message: rawInner } : fakeMsg

  const buffer = await downloadMediaMessage(msgToDownload, 'buffer', {}, {
    logger,
    reuploadRequest: sock?.updateMediaMessage,
  })

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error(`Empty buffer for ${msgId}`)
  }

  const sizeMB = buffer.length / (1024 * 1024)
  if (sizeMB > CONFIG.MAX_MEDIA_SIZE_MB) {
    send('media:download:error', { msgId, chatJid, reason: 'too_large' })
    return { skipped: true, reason: 'too_large', size: buffer.length }
  }

  const msgObj   = rawInner?.[mediaTypeKey]
  const mime     = msgObj?.mimetype || 'application/octet-stream'
  const ext      = getExtensionFromMimetype(mime)
  const filename = `${msgId}_${Date.now()}.${ext}`
  // [MEDIA-SORT] Route to typed subfolder: stickers/, images/, videos/, audio/, documents/
  const localPath = resolveMediaPath(mime, mediaTypeKey, filename)

  fs.writeFileSync(localPath, buffer)
  db.updateMediaDownload?.(msgId, localPath, buffer.length, 'downloaded')

  // logOk(`[DL] Downloaded: ${filename} (${sizeMB.toFixed(2)}MB)`)

  try {
    const mainModule = require('../main')
    mainModule?.onMediaDownloaded?.({ msgId, chatJid, localPath })
  } catch (_) {}

  send('media:download:complete', { msgId, chatJid, localPath })
  return { localPath, size: buffer.length, filename }
}

// ── Public-facing download API ────────────────────────────────────────────────

/**
 * downloadAndSaveMedia — download from a live WAMessage (new messages arriving now).
 * Always runs at ACTIVE priority so visible messages get media immediately.
 *
 * @param {object}  msg           — full WAMessage from Baileys
 * @param {string}  messageType   — e.g. 'imageMessage'
 * @param {boolean} isHistorySync — if true, queue at HISTORY priority
 */
async function downloadAndSaveMedia(msg, messageType, isHistorySync = false) {
  const priority = isHistorySync ? DL_PRIORITY.HISTORY : DL_PRIORITY.ACTIVE
  const msgId    = msg.key?.id
  const chatJid  = msg.key?.remoteJid

  // Fast-path skip checks (DB + disk) before touching the queue
  if (msgId) {
    try {
      const existing = db.getMessageById?.(msgId)
      if (existing?.media_is_downloaded === 1 && existing?.media_saved_path) {
        if (fs.existsSync(existing.media_saved_path)) {
          return { skipped: true, reason: 'already_on_disk', localPath: existing.media_saved_path }
        }
      } else if (existing?.media_saved_path && fs.existsSync(existing.media_saved_path)) {
        db.updateMediaSavedPath?.(msgId, existing.media_saved_path)
        return { skipped: true, reason: 'already_on_disk_flag_fixed', localPath: existing.media_saved_path }
      }
    } catch (_) {}
  }

  if (!isConnected || !sock) return { skipped: true, reason: 'not_connected' }

  // Build minimal DB-like row from live message
  const fromMe = !!msg.key?.fromMe
  const fakeRow = {
    id:          msgId,
    chat_jid:    chatJid,
    from_me:     fromMe ? 1 : 0,
    msg_type:    messageType,
    message_type: messageType,
    raw_json:    (() => { try { return JSON.stringify(msg.message) } catch(_){return null} })(),
  }

  return _enqueueDownload(fakeRow, priority)
}

/**
 * downloadMediaForMsg — download from a DB row (prefetch / on-demand).
 *
 * @param {object} row        — DB message row
 * @param {number} [priority] — DL_PRIORITY constant (default BACKGROUND)
 */
async function downloadMediaForMsg(row, priority) {
  if (!row?.id) return null

  // Determine priority: active chat gets P0, others get BACKGROUND
  if (priority === undefined) {
    const jid = row.chat_jid || row.remote_jid || ''
    priority = (jid && jid === _activeJid)
      ? DL_PRIORITY.ACTIVE
      : DL_PRIORITY.BACKGROUND
  }

  return _enqueueDownload(row, priority)
}

/**
 * prefetchChatMedia — bulk-enqueue all pending media for a chat.
 * Active chat = P0 (downloads first), others = P2 (background).
 *
 * Call this when user opens a chat so media is ready quickly.
 *
 * @param {string} jid
 * @param {number} [limit=20]  — max rows to enqueue
 */
async function prefetchChatMedia(jid, limit = 20) {
  if (!jid || !isConnected) return { queued: 0 }
  try {
    const rows = db.getPendingMediaForChat?.(jid, limit) || []
    const priority = (jid === _activeJid) ? DL_PRIORITY.ACTIVE : DL_PRIORITY.RECENT
    let queued = 0
    for (const row of rows) {
      _enqueueDownload(row, priority).catch(() => {})
      queued++
    }
    if (queued > 0) log(`[DL] Queued ${queued} media for ${jid.slice(0, 20)}… (P${priority})`)
    return { queued }
  } catch (err) {
    logW(`[DL] prefetchChatMedia error: ${err.message}`)
    return { queued: 0 }
  }
}

/**
 * getDlQueueStatus — expose queue stats for debug / DevEval.
 */
function getDlQueueStatus() {
  return {
    queued:       _dlQueue.length,
    runningHigh:  _dlRunningHigh,
    runningLow:   _dlRunningLow,
    circuitOpen:  Date.now() < _circuitOpenUntil,
    circuitUntil: _circuitOpenUntil,
    activeJid:    _activeJid,
    jidCooldowns: [..._jidFailCount.entries()]
      .filter(([, v]) => v.pauseUntil > Date.now())
      .map(([jid, v]) => ({ jid, until: v.pauseUntil })),
  }
}

function getExtensionFromMimetype(mimetype) {
  const map = {
    // Images
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
    'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp',
    'image/tiff': 'tiff', 'image/svg+xml': 'svg', 'image/heic': 'heic',
    // Video
    'video/mp4': 'mp4', 'video/3gpp': '3gp', 'video/webm': 'webm',
    'video/quicktime': 'mov', 'video/x-matroska': 'mkv', 'video/avi': 'avi',
    // Audio
    'audio/ogg': 'ogg', 'audio/ogg; codecs=opus': 'ogg',
    'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/aac': 'aac',
    'audio/opus': 'opus', 'audio/wav': 'wav', 'audio/flac': 'flac',
    // Documents
    'application/pdf': 'pdf', 'text/plain': 'txt',
    'application/zip': 'zip', 'application/x-zip-compressed': 'zip',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/msword': 'doc', 'application/vnd.ms-excel': 'xls',
    'application/vnd.ms-powerpoint': 'ppt',
    'application/x-rar-compressed': 'rar', 'application/x-7z-compressed': '7z',
    'application/json': 'json', 'text/csv': 'csv',
  }
  // normalise: strip params like "; codecs=opus" for lookup fallback
  const base = (mimetype || '').split(';')[0].trim().toLowerCase()
  return map[mimetype] || map[base] || base.split('/')[1] || 'bin'
}

// ─────────────────────────────────────────────────────────────────────────────
// MEDIA SUBDIRECTORY ROUTING
// Automatically sort downloaded files into typed subfolders so the media/
// directory stays clean:
//   media/
//     images/   ← image/jpeg, image/png, image/gif (NOT webp — stickers use webp)
//     stickers/ ← image/webp (WhatsApp stickers)
//     videos/   ← video/*
//     audio/    ← audio/*
//     documents/← application/*, text/*
//     status/   ← (managed separately by STATUS_MEDIA_DIR)
//
// Returns the absolute folder path (created if absent).
// ─────────────────────────────────────────────────────────────────────────────
const _mediaDirCache = new Map()
function getMediaSubdir(mimetype, msgType) {
  // Stickers are always webp — route to stickers/ regardless of wider image/* rule
  if (msgType === 'stickerMessage' || mimetype === 'image/webp') return 'stickers'
  const base = (mimetype || '').split(';')[0].trim().toLowerCase()
  if (base.startsWith('image/'))        return 'images'
  if (base.startsWith('video/'))        return 'videos'
  if (base.startsWith('audio/'))        return 'audio'
  if (base.startsWith('application/') || base.startsWith('text/')) return 'documents'
  return 'others'
}

function resolveMediaPath(mimetype, msgType, filename) {
  const subdir   = getMediaSubdir(mimetype, msgType)
  const fullDir  = path.join(CONFIG.MEDIA_DIR, subdir)
  if (!_mediaDirCache.has(subdir)) {
    fs.mkdirSync(fullDir, { recursive: true })
    _mediaDirCache.set(subdir, true)
  }
  return path.join(fullDir, filename)
}


// ════════════════════════════════════════════════════════════
// LISTENER-LIMIT HELPER
// ════════════════════════════════════════════════════════════
// Baileys registers O(10) internal listeners on sock.ev and sock.ws per connect.
// Our app adds another ~20 on sock.ev. Total per socket ≈ 30-35 — well within 50.
// The warning fires because Baileys creates a NEW WebSocketClient every reconnect
// and immediately registers its own listeners before we can call setMaxListeners.
//
// Fix strategy:
//   1. Patch EventEmitter.prototype.addListener ONCE at startup so any
//      EventEmitter (including future ws objects) automatically gets a higher
//      limit whenever the listener count would overflow. This is the only
//      reliable way to act BEFORE Baileys touches the object.
//   2. In connectToWhatsApp(), also explicitly set limits after makeWASocket()
//      as belt-and-suspenders.
//   3. In cleanupSocket(), do a thorough teardown with error isolation per step.
// ────────────────────────────────────────────────────────────

const _SAFE_LISTENER_LIMIT = 150  // headroom for Baileys internals + our handlers + future growth

;(function _patchEventEmitterLimit() {
  const EventEmitter = require('events')
  const _origAddListener = EventEmitter.prototype.addListener
  EventEmitter.prototype.addListener = function _patchedAddListener(event, fn) {
    // Auto-raise limit when we're about to hit it, instead of emitting the warning.
    // Only touch emitters whose limit is still at the Node default (10) or Baileys
    // default (50) — don't override limits that were deliberately set higher.
    const currentMax = this.getMaxListeners()
    if (currentMax > 0 && currentMax <= 50) {
      const currentCount = this.listenerCount(event)
      if (currentCount >= currentMax - 2) {
        // About to hit limit — raise it smartly to cover expected growth
        this.setMaxListeners(_SAFE_LISTENER_LIMIT)
      }
    }
    return _origAddListener.call(this, event, fn)
  }
  // Keep .on() in sync — it's an alias but some Node versions implement separately
  EventEmitter.prototype.on = EventEmitter.prototype.addListener
})()

// ════════════════════════════════════════════════════════════
// CLEANUP
// ════════════════════════════════════════════════════════════

function cleanupSocket() {
  if (!sock) return
  const _dying = sock
  sock = null          // null first — prevent any in-flight handler from using stale sock
  isConnected = false
  // Clear probe drain — socket is dead, nothing to drain against
  _pendingLidProbe.clear()
  // Tear down listeners in isolation so one failure doesn't block the others
  try { _dying.ev.removeAllListeners() }    catch (_) { }
  try { _dying.ws?.removeAllListeners() }   catch (_) { }
  try { _dying.ws?.close?.() }              catch (_) { }
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


// ════════════════════════════════════════════════════════════
// STATUS / STORY HANDLER
// Persis seperti referensi: LorenzoBotInc.readMessages([mek.key])
// ════════════════════════════════════════════════════════════

const STATUS_SOURCE_LABEL = ['image','video','gif','audio','text','music']
const STATUS_ATTRIBUTION  = { NONE: 0, RESHARED_FROM_MENTION: 1, RESHARED_FROM_POST: 2 }

// In-memory store: jid → [entry, ...]
const _statusStore = new Map()

// ── Restore status entries from DB on startup (survives restarts) ─────────
function _loadStatusFromDB() {
    try {
        db.pruneExpiredStatusEntries?.()
        const saved = db.loadAllStatusEntries?.() || {}
        let total = 0
        for (const [jid, entries] of Object.entries(saved)) {
            if (!entries.length) continue
            // If any entry in this bucket is fromMe, remap it under sock.user.id
            // (handles old rows stored under wrong/stale JID before the _getStatusSender fix)
            const hasOwn = entries.some(e => e.fromMe)
            const myJid = sock?.user?.id ? normalizeJid(sock.user.id) : null
            const useJid = (hasOwn && myJid) ? myJid : jid
            const existing = _statusStore.get(useJid) || []
            const merged = [...existing, ...entries].filter((e, i, arr) => arr.findIndex(x => x.id === e.id) === i)
            merged.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
            _statusStore.set(useJid, merged)
            total += entries.length
        }
        if (total > 0) log(`[Status] Restored ${total} entries from DB across ${_statusStore.size} contacts`)
    } catch (e) { logW(`[Status] DB restore failed: ${e.message}`) }
}

// Status media disimpan ke disk — lebih efisien dari base64 di RAM
const STATUS_MEDIA_DIR = path.join(CONFIG.MEDIA_DIR, 'status')
// [FIX] Single mkdirSync call — original had two: one via require('fs') and one via fs.
// recursive: true makes this a no-op if the directory already exists.
fs.mkdirSync(STATUS_MEDIA_DIR, { recursive: true })

const _mimeToExt = {
  'image/jpeg':'jpg','image/jpg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif',
  'video/mp4':'mp4','video/3gpp':'3gp','video/webm':'webm',
  'audio/ogg':'ogg','audio/mpeg':'mp3','audio/mp4':'m4a',
}
function _extFromMime(m) { return _mimeToExt[m] || m?.split('/')[1]?.split(';')[0] || 'bin' }

function _getStatusSender(msg) {
  // For own status: Baileys sets fromMe=true but participant is null/absent.
  // Fall back to sock.user.id so own entries are keyed under our real JID.
  const participant = msg.key?.participant || msg.participant
  if (participant) return normalizeJid(participant)
  if (msg.key?.fromMe === true && sock?.user?.id) return normalizeJid(sock.user.id)
  return normalizeJid(msg.key?.remoteJid || '')
}
function _tsToNum(ts) {
  if (!ts) return 0
  if (typeof ts === 'object' && typeof ts.toNumber === 'function') return ts.toNumber()
  return Number(ts)
}
function _detectStatusType(mc) {
  if (mc?.statusSourceType != null)
    return { n: mc.statusSourceType, s: STATUS_SOURCE_LABEL[mc.statusSourceType] ?? 'unknown' }
  if (mc.imageMessage)        return { n: 0, s: 'image' }
  if (mc.videoMessage)        return mc.videoMessage.gifPlayback ? { n: 2, s: 'gif' } : { n: 1, s: 'video' }
  if (mc.audioMessage)        return { n: 3, s: 'audio' }
  if (mc.extendedTextMessage) return { n: 4, s: 'text' }
  if (mc.conversation)        return { n: 4, s: 'text' }
  return { n: -1, s: Object.keys(mc)[0] ?? 'unknown' }
}
function _isStatusNotif(mc) {
  if (mc?.messageContextInfo?.messageAssociation?.associationType === 'STATUS_NOTIFICATION') return true
  if (mc?.statusNotificationMessage != null) return true
  // Skip ALL protocolMessage types — they are internal WA signals, never renderable
  if (mc?.protocolMessage != null) return true
  if (mc?.associatedChildMessage && Object.keys(mc.associatedChildMessage?.message ?? {}).length === 0) return true
  return false
}
function _saveStatusMedia(buf, msgId, mime) {
  try {
    const fp = path.join(STATUS_MEDIA_DIR, `status_${msgId}.${_extFromMime(mime)}`)
    fs.writeFileSync(fp, buf)
    // [FIX-WEBSECURITY] Use media:// custom protocol — file:// is blocked by webSecurity:true
    // media:// handler in main.js reconstructs the path from hostname+pathname for both
    // double-slash (media://home/...) and triple-slash (media:///home/...) forms.
    const fileUrl = 'media:///' + fp.replace(/\\/g, '/').replace(/^\/+/, '')
    return { filePath: fp, mediaUrl: fileUrl }
  } catch (e) { logW(`[Status] save err: ${e.message}`); return { filePath: null, mediaUrl: null } }
}

async function handleStatusMessage(msg) {
  if (!msg?.message) return
  const senderJid = _getStatusSender(msg)
  if (!senderJid || senderJid === 'status@broadcast') return

  const mc = msg.message
  if (_isStatusNotif(mc)) return

  const { n: sourceTypeNum, s: sourceTypeStr } = _detectStatusType(mc)

  // Skip anything that isn't a renderable type — protocolMessage, unknown, etc.
  const RENDERABLE = ['image', 'video', 'gif', 'audio', 'text']
  if (!RENDERABLE.includes(sourceTypeStr)) {
    logW(`[Status] Skipping non-renderable type: ${sourceTypeStr} from ${senderJid}`)
    return
  }

  let mediaPath = null, mediaUrl = null, mime = null, mediaSize = null
  let caption = null, text = null, bg = null, font = null
  let duration = null, thumb = null, attr = 'none'

  try {
    // Attribution (reshare)
    const a = mc?.statusAttributionMessage?.attributionType
      ?? mc?.imageMessage?.statusAttributionMessage?.attributionType
      ?? mc?.videoMessage?.statusAttributionMessage?.attributionType ?? null
    if (a != null) attr = a === 1 ? 'reshared_mention' : a === 2 ? 'reshared_post' : 'none'

    if (sourceTypeStr === 'image') {
      mime    = mc.imageMessage?.mimetype || 'image/jpeg'
      caption = mc.imageMessage?.caption  || null
      if (mc.imageMessage?.jpegThumbnail)
        thumb = `data:image/jpeg;base64,${Buffer.from(mc.imageMessage.jpegThumbnail).toString('base64')}`
      // [FIX] Guard sock — can be null between reconnects
      if (sock) {
        const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage }).catch(() => null)
        if (buf) { const sv = _saveStatusMedia(buf, msg.key.id, mime); mediaPath = sv.filePath; mediaUrl = sv.mediaUrl; mediaSize = buf.length }
      }

    } else if (sourceTypeStr === 'video' || sourceTypeStr === 'gif') {
      mime    = mc.videoMessage?.mimetype || 'video/mp4'
      caption = mc.videoMessage?.caption  || null
      if (mc.videoMessage?.jpegThumbnail)
        thumb = `data:image/jpeg;base64,${Buffer.from(mc.videoMessage.jpegThumbnail).toString('base64')}`
      if (sock) {
        const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage }).catch(() => null)
        if (buf) { const sv = _saveStatusMedia(buf, msg.key.id, mime); mediaPath = sv.filePath; mediaUrl = sv.mediaUrl; mediaSize = buf.length }
      }

    } else if (sourceTypeStr === 'audio' || sourceTypeStr === 'music') {
      mime     = mc.audioMessage?.mimetype || 'audio/ogg'
      duration = mc.audioMessage?.seconds  || null
      if (sock) {
        const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage }).catch(() => null)
        if (buf) { const sv = _saveStatusMedia(buf, msg.key.id, mime); mediaPath = sv.filePath; mediaUrl = sv.mediaUrl; mediaSize = buf.length }
      }

    } else if (sourceTypeStr === 'text') {
      text = mc.extendedTextMessage?.text || mc.conversation || ''
      bg   = mc.extendedTextMessage?.backgroundArgb || null
      font = mc.extendedTextMessage?.font            || null
    }
  } catch (e) { logW(`[Status] process err: ${e.message}`) }

  // fromMe: true means this status was posted BY the connected account.
  const isFromMe = msg.key.fromMe === true

  const entry = {
    id: msg.key.id, senderJid,
    fromMe: isFromMe,
    timestamp:       _tsToNum(msg.messageTimestamp),
    sourceType:      sourceTypeStr, sourceTypeNum,
    attributionType: attr,
    mediaUrl, mediaPath, mediaMimetype: mime, mediaSize,
    thumbnailBase64: thumb,
    text, caption, backgroundColor: bg, font, audioDuration: duration,
    seen: CONFIG.AUTO_VIEW_STATUS,
  }

  if (!_statusStore.has(senderJid)) _statusStore.set(senderJid, [])
  const arr = _statusStore.get(senderJid)
  if (!arr.find(e => e.id === entry.id)) {
    arr.push(entry)
    arr.sort((a, b) => _tsToNum(a.timestamp) - _tsToNum(b.timestamp))
  }
  // ── Persist to SQLite so entries survive restart ──
  try { db.upsertStatusEntry?.({ ...entry, senderJid, senderName: null }) } catch (_) {}

  // ── Resolve contact display name before pushing to renderer ─────────────
  // Priority: contacts DB name > push_name > phone number
  // This ensures renderer shows "Yusuf (UCHI)" not "628312...@s.whatsapp.net"
  let senderName = null
  try {
    const contact = db.getContact?.(senderJid)
    senderName = contact?.name || contact?.push_name || msg.pushName || null
  } catch (_) {}
  if (!senderName) senderName = msg.pushName || senderJid.split('@')[0]

  send('status:new', { senderJid, senderName, entry: { ...entry, pushname: senderName } })
  log(`[Status] ✓ ${sourceTypeStr} from ${senderJid} [${senderName}]${mediaUrl ? ' [saved]' : ''}${CONFIG.AUTO_VIEW_STATUS ? ' [auto-viewed]' : ''}`)

  // ── Auto-view: kirim read receipt ke WA ─────────────────────────────────
  // Sama persis dengan: LorenzoBotInc.readMessages([mek.key])
  // Sender akan lihat "viewed" di story mereka
  if (CONFIG.AUTO_VIEW_STATUS) {
    try {
      await sock.readMessages([{
        remoteJid:   'status@broadcast',
        id:           msg.key.id,
        participant:  senderJid,
        fromMe:       false,
      }])
    } catch (e) { logW(`[Status] auto-view err: ${e.message}`) }
  }
}

// ── Public API ───────────────────────────────────────────────────────────────
function getContactStatuses() {
  const myJidNorm = sock?.user?.id ? normalizeJid(sock.user.id) : null
  const r = {}
  for (const [rawJid, entries] of _statusStore.entries()) {
    if (!entries.length) continue
    // [FIX-FROMME] If this bucket contains own entries, always use our real JID as key.
    // This collapses any stale/wrong JID keys that snuck in from old data.
    const hasOwn = entries.some(e => e.fromMe)
    const jid = (hasOwn && myJidNorm) ? myJidNorm : rawJid
    let contactName = null
    try {
      const c = db.getContact?.(jid)
      contactName = c?.name || c?.push_name || null
    } catch (_) {}
    if (!contactName && entries.length > 0) {
      contactName = entries.find(e => e.pushname)?.pushname || null
    }
    // Merge into r[jid] in case multiple raw keys map to same jid (e.g. own status)
    const existing = r[jid] || []
    const mapped = entries.map(e => ({ ...e, senderName: e.senderName || contactName || e.pushname || jid.split('@')[0] }))
    const merged = [...existing, ...mapped].filter((e, i, arr) => arr.findIndex(x => x.id === e.id) === i)
    merged.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
    r[jid] = merged
  }
  return r
}
function getStatusesBySender(jid) {
  return _statusStore.get(normalizeJid(jid)) || []
}
async function markStatusSeen(senderJid, statusId) {
  const jid = normalizeJid(senderJid)
  // Persist seen state to DB
  try { db.markStatusEntrySeen?.(statusId, jid) } catch (_) {}
  const e = (_statusStore.get(jid) || []).find(x => x.id === statusId)
  if (e) e.seen = true
  try {
    await sock.readMessages([{ remoteJid: 'status@broadcast', id: statusId, participant: jid, fromMe: false }])
  } catch (e) { logW(`[Status] markSeen err: ${e.message}`) }
}
async function fetchContactStories(jids = [], forceRefresh = false) {
  assertConnected()
  const targets = (jids.length ? jids.map(j => normalizeJid(j)) : getStatusJidList()).filter(Boolean)
  if (!targets.length) return { ok: false, error: 'No contacts' }
  if (forceRefresh) for (const j of targets) _statusStore.delete(j)
  for (let i = 0; i < targets.length; i += 20) {
    const batch = targets.slice(i, i + 20)
    try {
      // [FIX] Optional chaining — fetchMessagesFromWA may not exist on all Baileys builds
      if (typeof sock.fetchMessagesFromWA === 'function') {
        await sock.fetchMessagesFromWA('status@broadcast', 15, { before: null }, { statusJidList: batch })
      } else {
        await Promise.allSettled(batch.map(j => sock.presenceSubscribe(j).catch(() => {})))
      }
    }
    catch (_) { await Promise.allSettled(batch.map(j => sock.presenceSubscribe(j).catch(() => {}))) }
    if (i + 20 < targets.length) await new Promise(r => setTimeout(r, 800))
  }
  return { ok: true, stories: getContactStatuses() }
}
async function fetchSingleContactStory(jid) {
  assertConnected()
  const j = normalizeJid(jid)
  if (!j) return { ok: false, error: 'Invalid JID' }
  await sock.presenceSubscribe(j).catch(() => {})
  try { await sock.fetchMessagesFromWA('status@broadcast', 30, { before: null }, { statusJidList: [j] }) } catch (_) {}
  return { ok: true, jid: j, stories: getStatusesBySender(j) }
}
function setAutoViewStatus(enabled) {
  CONFIG.AUTO_VIEW_STATUS = !!enabled
  console.log('[AuroraClient] AUTO_VIEW_STATUS →', CONFIG.AUTO_VIEW_STATUS)
}
function getAutoViewStatus() { return CONFIG.AUTO_VIEW_STATUS }

// Prune media files > 25 jam
function _pruneStatusMedia() {
  try {
    const cut = Date.now() - 25 * 3600 * 1000
    for (const f of fs.readdirSync(STATUS_MEDIA_DIR)) {
      try { const fp = path.join(STATUS_MEDIA_DIR, f); if (fs.statSync(fp).mtimeMs < cut) fs.unlinkSync(fp) } catch (_) {}
    }
  } catch (_) {}
}
// Prune in-memory entries + disk setiap jam.
// [FIX] .unref() so this interval does not prevent Electron from shutting down cleanly.
const _statusPruneInterval = setInterval(() => {
  const cut = Math.floor(Date.now() / 1000) - 86400
  for (const [jid, arr] of _statusStore.entries()) {
    const fresh = arr.filter(e => _tsToNum(e.timestamp) > cut)
    fresh.length ? _statusStore.set(jid, fresh) : _statusStore.delete(jid)
  }
  _pruneStatusMedia()
}, 3600 * 1000)
if (_statusPruneInterval.unref) _statusPruneInterval.unref()

async function handleMessage(msg, type, isHistorySync = false) {
  if (!msg.message) return
  // [FIX-SPLIT-CHAT] Normalize remoteJid before ANY processing.
  if (msg.key?.remoteJid) {
    let rjid = normalizeJid(msg.key.remoteJid)
    if (isLidJid(rjid)) {
      rjid = resolveLid(rjid, lidMap)
      if (isLidJid(rjid)) _enqueueLidProbe(rjid)
    }
    msg.key.remoteJid = rjid
  }
  // [FIX-LID] Also resolve @lid in participant field (group sender)
  if (msg.key?.participant) {
    let p = normalizeJid(msg.key.participant)
    if (isLidJid(p)) {
      p = resolveLid(p, lidMap)
      if (isLidJid(p)) _enqueueLidProbe(p)
    }
    msg.key.participant = p
  }

  // [FIX-GROUP-PARTICIPANT] History sync terkadang mengisi participant dengan
  // JID group itu sendiri (@g.us) — data bogus dari proto WA.
  // Hapus sebelum fromMe check & parseMessage supaya tidak salah jadi senderId.
  if (
    msg.key?.participant &&
    isGroupJid(msg.key.participant) &&
    msg.key.participant === msg.key.remoteJid
  ) {
    msg.key.participant = undefined
  }

  // [FIX-7] AUTHORITATIVE fromMe for group messages.
  // Problem: WA sometimes delivers group messages from this device with
  //   key.fromMe = undefined/null/false when routed via multi-device.
  //   This makes our sent group messages appear as "opponent" bubbles.
  //
  // Canonical fix: if key.participant IS our JID, it's definitely fromMe.
  // If key.participant IS null/absent AND key.remoteJid is a group AND
  //   key.id matches a message we sent (check msgRetryCache or DB), also fix.
  //
  // We apply this BEFORE parseMessage so from_me is correct everywhere.
  if (sock?.user?.id) {
    const myJidClean = normalizeJid(sock.user.id)
    const participantClean = msg.key?.participant ? normalizeJid(msg.key.participant) : null

    if (participantClean && participantClean === myJidClean) {
      // Participant is us → definitely fromMe, even if Baileys flagged it false
      msg.key.fromMe = true
    }
    // Also check: no participant + remoteJid is DM + remoteJid matches our JID
    if (!participantClean && msg.key?.remoteJid && !isGroupJid(msg.key.remoteJid)) {
      const remoteClean = normalizeJid(msg.key.remoteJid)
      if (remoteClean === myJidClean) msg.key.fromMe = true
    }
  }

  if (isJidStatusBroadcast(msg.key?.remoteJid || "")) {
    await handleStatusMessage(msg)
    return
  }
  if (isJidBroadcast(msg.key?.remoteJid || "")) return

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
  // [PERF-MOD] Only await modManager if there are active mods that could block.
  // runOnMessage() returns false synchronously when no mods are loaded — skip
  // the async overhead entirely in that case (most users have no mods active).
  if (modManager && !isHistorySync) {
    try {
      const modResult = modManager.hasMessageHooks?.()
        ? await modManager.runOnMessage(parsed, msg)
        : modManager.runOnMessageSync?.(parsed, msg)
      if (modResult === false) return // plugin blocked this message
    } catch (e) {
      console.warn("[AuroraChat] ModManager.runOnMessage error:", e.message)
    }
  }

  // ── Simpan ke DB ─────────────────────────────────────────
  try {
    db.insertMessage(parsed)
    // [FIX-STALE-SEQ] Bump the per-chat monotonic write counter in main.js so
    // the renderer can detect if new messages arrived between its last fetch and
    // the current render cycle. The counter lives in main.js _chatMsgSeq Map and
    // is returned alongside data in the db:messages:list IPC response.
    // bumpChatSeq is injected as mainModule._bumpChatSeq by main.js at startup.
    try { mainModule?._bumpChatSeq?.(parsed.chat_jid) } catch (_) {}
  } catch (err) {
    if (err.message?.includes("UNIQUE")) {
      try { db.updateMessageStatus?.(parsed.id, parsed.status) } catch (_) { }
    } else {
      logE(`DB insert error: ${err.message}`)
      return
    }
  }

  // ── Queue media download (hanya live, bukan history sync) ─
  if (parsed.has_media && !isHistorySync) {
    const mediaTypeKey = resolveMediaTypeKey(parsed.msg_type, msg.message)
    if (mediaTypeKey) {
      // [FIX-NOT-MEDIA] Validate message has downloadable content before queuing.
      const unwrapped = msg.message?.ephemeralMessage?.message
        || msg.message?.viewOnceMessage?.message
        || msg.message?.viewOnceMessageV2?.message
        || msg.message?.documentWithCaptionMessage?.message
        || msg.message
      const innerMediaObj = unwrapped?.[mediaTypeKey]
      const hasDownloadable = innerMediaObj?.url || innerMediaObj?.directPath || innerMediaObj?.mediaKey
      // [FIX-AUTO-DL] Stickers always download. [FIX-FROMME] fromMe media also downloads.
      const isSticker = parsed.msg_type === "stickerMessage"
      if (hasDownloadable && (isSticker || CONFIG.AUTO_DOWNLOAD_MEDIA)) {
        // [PERF-WRITES] Only insert into media_downloads queue if not already downloaded.
        // Avoids redundant DB write on every message re-process (reconnect, history sync).
        if (!parsed.media_is_downloaded) {
          db.queueMediaDownload?.(parsed.id, parsed.chat_jid, parsed.msg_type, parsed.media_url)
        }
        downloadAndSaveMedia(msg, mediaTypeKey, false).catch(() => { })
      } else if (!hasDownloadable) {
        logW(`[MEDIA] Skip queuing ${parsed.id}: ${mediaTypeKey} has no downloadable fields`)
      }
    }
  }

  // ── Update chat last message di DB ────────────────────────
  if (!isHistorySync && parsed.chat_jid) {
    // [FIX-4][FIX-5] Use full upsert so last_message_timestamp is ALWAYS current.
    // updateChatLastMsg alone only updates body/ts columns but may leave the
    // chats.last_message_timestamp stale if the chat row existed before with a
    // higher timestamp (shouldn't happen, but be defensive).
    //
    // IMPORTANT: We call BOTH updateChatLastMsg (for body/type) AND a direct
    // SQL timestamp update, ensuring the ORDER BY c.last_message_timestamp DESC
    // in getChats() always returns this chat at the top after a send/receive.
    // [PERF-WRITES] updateChatLastMsg is now batched (500ms debounce) — single write per chat.
    // Removed redundant saveChat() call — it was doing a full upsert just to update timestamp,
    // which is already covered by the batched updateChatLastMsg. saveChat() stays for
    // initial chat creation (chats.set / history sync), not hot per-message path.
    db.updateChatLastMsg?.(parsed.chat_jid, {
      timestamp: parsed.timestamp,
      message_id: parsed.id,
      body: parsed.body || `[${parsed.msg_type}]`,
      msg_type: parsed.msg_type,
      from_me: parsed.from_me ? 1 : 0,
    })
  }

  // ── [FIX-PUSHNAME] Persist sender pushname → contacts table ──
  // This is the source of truth for display names in chat list.
  // Without this, getChats() JOIN returns null and raw JID is shown.
  // [FIX-LID-HISTORY] Also persist pushname from history sync messages — they
  // carry pushName/sender_name from WA which is the only source of truth for
  // @lid senders that were never in the address book.
  if (parsed.pushname && parsed.sender_jid && !parsed.from_me) {
    // Only persist if sender_jid is resolved (@s.whatsapp.net) — never store against @lid
    const senderIsPhone = parsed.sender_jid.endsWith('@s.whatsapp.net')
    if (senderIsPhone) {
      db.upsertContactPushname?.(parsed.sender_jid, parsed.pushname)
    }
  }

  // ── [FIX-SENDER-NAME] Resolve sender_name from contacts DB before insert/push ──
  // For live messages: buildRendererPayload only has parsed.pushname (proto field).
  // For history sync: sender_name field in DB row must be set here since
  // backfillSenderNamesFromMessages runs AFTER all messages are inserted.
  // We need: phonebook name > push_name > pushname from proto > null
  if (!parsed.from_me && parsed.sender_jid) {
    try {
      const contact = db.getContact?.(parsed.sender_jid)
      if (contact?.name || contact?.push_name) {
        parsed._resolved_sender_name = contact.name || contact.push_name
      }
    } catch (_) { }
    // [FIX-LID-SENDER-NAME] If sender_jid is still @lid, try to resolve via lidMap
    // then lookup contact. This ensures history sync messages from @lid senders get
    // proper sender_name stored in DB and shown in bubble.
    if (!parsed._resolved_sender_name && isLidJid(parsed.sender_jid)) {
      const resolvedJid = resolveLid(parsed.sender_jid, lidMap)
      if (!isLidJid(resolvedJid)) {
        try {
          const contact = db.getContact?.(resolvedJid)
          if (contact?.name || contact?.push_name) {
            parsed._resolved_sender_name = contact.name || contact.push_name
          }
        } catch (_) { }
        // Fallback: show phone number decoded from resolved JID
        if (!parsed._resolved_sender_name) {
          const phoneUser = resolvedJid.split('@')[0].split(':')[0]
          if (/^\d{6,}$/.test(phoneUser)) {
            parsed._resolved_sender_name = `+${phoneUser}`
          }
        }
      } else {
        // lid still unresolved — show pushname or lid-derived numeric as fallback
        if (!parsed.pushname) {
          const lidUser = parsed.sender_jid.split('@')[0]
          const numericPart = lidUser.replace(/\D/g, '')
          if (numericPart.length >= 6) parsed._resolved_sender_name = `+${numericPart}`
        }
      }
    }
    // Promote _resolved_sender_name as sender_name so it gets stored in DB
    if (parsed._resolved_sender_name && !parsed.pushname) {
      parsed.pushname = parsed._resolved_sender_name
    }
  }
  // Also resolve quoted sender name
  if (parsed.quoted_sender && parsed.quoted_sender !== '__me__' && parsed.quoted_sender !== '__self__') {
    try {
      const qContact = db.getContact?.(parsed.quoted_sender)
      if (qContact?.name || qContact?.push_name) {
        parsed._resolved_quoted_sender_name = qContact.name || qContact.push_name
      }
    } catch (_) { }
  }

  // History sync: hanya save ke DB, tidak push ke renderer
  if (isHistorySync) {
    syncStats.messages++
    return
  }

  // ── Cache for retry ───────────────────────────────────────
  if (msg.message) msgRetryCache.set(msg.key.id, msg.message)

  // ── Cache full proto untuk DevEval full dump ───────────────
  if (msg.key?.id) rawMsgCache.set(msg.key.id, msg)

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
  // [PERF-IPC] Use sendRaw — buildRendererPayload output is already IPC-safe
  // (all fields are strings/numbers/null/arrays). Skipping sanitize() saves
  // ~1-3ms per message on median hardware, which compounds on burst receives.
  sendRaw("messages:new", buildRendererPayload(parsed))
  // [FIX-CHAT-POS] Do NOT emit db:chats:updated here.
  // The renderer's appendMessage() already updates + re-sorts the chat list
  // atomically in-memory. Emitting db:chats:updated triggers loadChats() which
  // does an async DB read — if the DB write hasn't landed yet, the stale
  // timestamp causes the chat to sort back to its old position.
}

// ════════════════════════════════════════════════════════════
// KONEKSI UTAMA
// ════════════════════════════════════════════════════════════

async function connectToWhatsApp(phoneForPairing = null) {
  if (isLoggedOut) {
    logW("Tidak reconnect — akun telah logout")
    return
  }

  // Load persisted status entries from DB into memory on every connect
  _loadStatusFromDB()

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
  let version = [2, 3000, 1015901307]  // [FIX] Safe hardcoded fallback — never undefined
  let isLatest = false
  try {
    const fetched = await fetchLatestBaileysVersion()
    version  = fetched.version
    isLatest = fetched.isLatest
    log(`Versi WA terbaru: ${version} | isLatest: ${isLatest}`)
  } catch (_) {
    logW(`Gagal fetch versi WA terbaru — pakai fallback ${version.join('.')}`)
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

    // [PERF-CONN] Use macOS Chrome browser string — WA Web routes this through
    // the same fast web-tier infra, giving it near-identical message delivery
    // latency to WA Web. The Windows Desktop string can get lower-priority
    // background-device routing on WA's servers.
    browser: Browsers.macOS('Chrome'),

    syncFullHistory: CONFIG.SYNC_FULL_HISTORY,
    shouldSyncHistoryMessage: () => true,

    // [PERF-CONN] Disable high-quality link previews — this forces WA's servers
    // to do extra work on every outgoing message with a URL. Doesn't affect
    // receive latency but keeps our outgoing queue clean.
    generateHighQualityLinkPreview: false,

    msgRetryCounterCache: msgRetryCache,

    // [PERF-CONN] Tighter keepalive = WA servers treat connection as active,
    // not background. WA Web uses ~10-15s. 15s matches that cadence.
    keepAliveIntervalMs: 15000,

    connectTimeoutMs: 30000,          // 30s — fail fast, reconnect sooner
    defaultQueryTimeoutMs: 30000,     // 30s query timeout

    emitOwnEvents: true,
    retryRequestDelayMs: 250,         // [PERF-CONN] Halved — faster retry on transient errors

    maxMsgRetryCount: 5,
    fireInitQueries: true,

    // [PERF-CONN] Tell WA this is an active (online) client immediately on connect.
    // Without this, WA may classify us as a background/secondary device and
    // introduce a delivery delay. This is the biggest single factor in WA Web
    // receiving messages faster — it always declares presence:available on open.
    markOnlineOnConnect: true,

    getMessage: async (key) => {
      // [FIX] Wrap everything — a corrupt DB row must not crash the socket
      try {
        const cached = msgRetryCache.get(key.id)
        if (cached) return cached

        const dbMsg = db.getMessageById?.(key.id)
        if (dbMsg?.message_json) {
          try { return JSON.parse(dbMsg.message_json) } catch (_) { /* corrupt JSON — fall through */ }
        }
      } catch (_) { }

      return proto.Message.fromObject({})
    },
  })

  // [FIX-MAXLISTENERS] Baileys registers many internal listeners on sock.ev.
  // Each reconnect adds another set (connection.update, messages.media-update, etc.)
  // Raise the limit to 50 so Node does not emit the spurious MaxListeners warning.
  // [FIX-MAXLISTENERS] Belt-and-suspenders: explicit high limits on ev + ws.
  // The EventEmitter patch (_patchEventEmitterLimit) already auto-raises limits
  // before Baileys' internal listeners fire, but we also set explicitly here as
  // a safety net for any emitter created after this point during handshake.
  try { sock.ev?.setMaxListeners?.(_SAFE_LISTENER_LIMIT) }  catch (_) { }
  try { sock.ws?.setMaxListeners?.(_SAFE_LISTENER_LIMIT) }  catch (_) { }

  // Wire live sock ref into messageParser for resolveLidAsync()
  // MUST be called on every reconnect — sock is a new object each makeWASocket()
  initSock(sock)
  log('[LID] initSock() wired')

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
      // log("QR Code diterima → kirim ke renderer")
      send("auth:qr", qr)
    }

    // ── OPEN ─────────────────────────────────────────
    if (connection === "open") {
      isConnected = true
      reconnectAttempts = 0
      resumeDownloads()   // [DL] restart priority queue after reconnect
      isLoggedOut = false
      pendingPhone = null

      // Cancel any stale resume-sync state from the previous session so the
      // indicator doesn't flash incorrectly if the user reconnects very quickly.
      if (_isResumeSyncing) {
        _isResumeSyncing = false
        _resumeSyncStats = { messages: 0, chats: new Set() }
      }

      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }

      // sock.user may be unpopulated immediately at connection:open on reconnects.
      // Read synchronously — never await inside connection.update to avoid blocking
      // the event loop and missing messaging-history.set which fires right after.
      let me = sock?.user
      if (!me?.id) {
        try {
          const credsPath = require('path').join(CONFIG.SESSION_DIR, 'creds.json')
          const creds = JSON.parse(require('fs').readFileSync(credsPath, 'utf8'))
          if (creds?.me?.id) me = creds.me
        } catch (_) {}
      }
      logOk(`Terhubung sebagai: ${me?.name || '(loading...)'} | ${me?.id || '???'}`)
      // Async name patch — re-send connection:open once Baileys populates name
      if (!me?.name) setTimeout(() => {
        const m2 = sock?.user
        if (m2?.name) send("connection:open", { name: m2.name, jid: m2.id || me?.id || "", phone: (m2.id || me?.id || "").split(":")?.[0] || "" })
      }, 3000)

      // Calculate offline gap for renderer to display "X messages while offline"
      const offlineGapMs = (_lastDisconnectTs > 0) ? (Date.now() - _lastDisconnectTs) : 0
      const offlineGapSec = Math.round(offlineGapMs / 1000)

      send("connection:open", {
        name:          me?.name || "Unknown",
        jid:           me?.id || "",
        phone:         me?.id?.split(":")?.[0] || "",
        offlineSince:  _lastDisconnectTs || null,
        offlineGapSec,
      })

      // Set socket reference for mod manager
      if (modManager) {
        modManager.setSocket(sock)
        modManager.runOnConnect({ name: me?.name, jid: me?.id, phone: me?.id?.split(":")[0] }).catch(() => { })
      }

      // Start sync status
      // [FIX-SYNC-STATE] MUST set isSyncing=true HERE so the auto-complete timer
      // guard below (`if (!isSyncing) return`) works correctly. Previously isSyncing
      // was never set at connection:open — only the IPC message said isSyncing:true,
      // but the in-memory flag stayed false, causing the guard to exit immediately
      // and leave the renderer stuck at "Sinkronisasi pesan... 0%" forever.
      isSyncing = true
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
              // Also persist member count so header shows real number
              if (meta?.participants?.length) {
                db.updateMemberCount?.(jid, meta.participants.length)
              }
            } catch (_) { }
            // Small delay to avoid rate limit
            await new Promise(r => setTimeout(r, 300))
          }
          send("db:chats:updated")
        } catch (e) {
          logW(`[FIX-GROUP-NAME] fetch error: ${e.message}`)
        }
      }, 5000)

      // [PERF-CONN] Immediately declare presence:available so WA servers route
      // messages to us in real-time (same as WA Web). Without this, WA may treat
      // the connection as a background device and delay message delivery.
      // Fire-and-forget — don't await, don't block the connection:open handler.
      setImmediate(() => {
        try { sock?.sendPresenceUpdate?.('available').catch(() => {}) } catch (_) {}
      })

      // ── ACTIVE GAP-FILL on reconnect ────────────────────────────────────────
      // After a paused session, WA delivers missed messages via messages.upsert
      // 'append' passively. But like WA Web, we also ACTIVELY request the latest
      // app-state + any placeholder messages from chats with unread counts so
      // nothing is missed even if the passive 'append' stream is incomplete.
      //
      // Steps (run after a short delay to not race with the passive 'append' stream):
      //   1. resyncAppState(['critical_block','critical_unblock_to_primary']) — pulls
      //      the latest read-receipts, mute states, pin states, and unread counts
      //      from WA's app-state server. This is what WA Web calls on every reconnect.
      //   2. fetchMessageHistory for any chat that DB shows as having unread messages
      //      but whose newest DB message is older than our disconnect timestamp —
      //      i.e. chats that have a "gap". Uses sock.fetchMessageHistory() which
      //      triggers a messaging-history.set event with the missing messages.
      //   3. requestPlaceholderResend for any placeholder rows in DB (messages that
      //      arrived as stubs with no content — common after long offline periods).
      if (_lastDisconnectTs > 0) {
        setTimeout(() => _activeGapFill().catch(e => logW(`[GapFill] error: ${e.message}`)), 4000)
      }
    }

    // ── CLOSE ────────────────────────────────────────
    if (connection === "close") {
      pauseDownloads()   // [DL] freeze queue — items stay, no new downloads while disconnected
      isConnected = false
      // [FIX-SYNC-STATE] Reset isSyncing + gap-fill tracking on disconnect.
      isSyncing = false
      if (_syncAutoCompleteTimer) { clearTimeout(_syncAutoCompleteTimer); _syncAutoCompleteTimer = null }
      _gapFilledChats.clear()  // next reconnect fills all chats fresh

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
        modManager.runOnDisconnect(reason).catch(() => { })
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
        408, 428, 500, 503, -1,
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


  sock.ev.on("messaging-history.set", async ({ chats, contacts, messages, isLatest, progress, syncType }) => {
    log(`History Sync [${syncType ?? 'unknown'}]: ${messages.length} msg, ${chats.length} chats, ${contacts.length} contacts | isLatest: ${isLatest} | progress: ${progress}%`)

    isSyncing = true
    syncStats.chats += chats.length
    syncStats.messages += messages.length

    // ── STEP 0: Extract pnJid/lidJid from chat objects (WA Web technique) ──────
    // Each chat object in messaging-history.set may carry BOTH fields:
    //   chat.pnJid  = phone number JID (@s.whatsapp.net) when chat.id is @lid
    //   chat.lidJid = @lid JID when chat.id is a phone JID
    // This is the AUTHORITATIVE lid→JID mapping — extract it before contacts
    // so the lidMap is maximally populated before we process messages.
    {
      const pnBatch = new Map()
      for (const chat of chats) {
        if (!chat.id) continue
        const chatId = normalizeJid(chat.id)
        const isLid  = isLidJid(chatId)
        const isPn   = !isLid && chatId.endsWith('@s.whatsapp.net')

        if (isLid && chat.pnJid) {
          // chat.id = @lid, chat.pnJid = real phone JID
          const pn = normalizeJid(chat.pnJid)
          if (pn && !isLidJid(pn)) {
            pnBatch.set(chatId, pn)
            log(`[LID-PN] chat.pnJid: ${chatId} → ${pn}`)
          }
        } else if (isPn && chat.lidJid) {
          // chat.id = phone JID, chat.lidJid = @lid
          const lid = normalizeJid(chat.lidJid)
          if (lid && isLidJid(lid)) {
            pnBatch.set(lid, chatId)
            log(`[LID-PN] chat.lidJid: ${lid} → ${chatId}`)
          }
        }
      }
      if (pnBatch.size > 0) {
        mergeLidBatch(pnBatch)
        log(`[LID-PN] Extracted ${pnBatch.size} lid↔JID pairs from chat objects`)
      }
    }

    // ── STEP 1: Simpan contacts & bangun lidMap DULU ──────────────────────────
    // Urutan kritis: contacts → lidMap → chats → messages
    // Tanpa ini, chat/message dengan @lid tidak bisa di-resolve ke @s.whatsapp.net
    for (const contact of contacts) {
      if (!contact.id) continue

      // [FIX-LID-DOUBLE] Resolve @lid contact.id ke real JID sebelum disimpan ke DB.
      // Tanpa ini, DB akan punya 2 baris: satu dengan @lid dan satu dengan @s.whatsapp.net
      const rawJid = normalizeJid(contact.id)
      const resolvedJid = isLidJid(rawJid) ? tryResolveLid(rawJid, lidMap) : rawJid

      // Simpan contact dengan JID yang sudah resolved
      const contactToSave = { ...contact, id: resolvedJid }
      db.saveContact(contactToSave)

      // Upsert pushname/notify ke resolved JID (bukan @lid)
      const displayName = contact.notify || contact.pushname || contact.name
      if (displayName) {
        db.upsertContactPushname?.(resolvedJid, displayName)
        // Jika @lid belum resolved (tryResolveLid kembalikan rawJid karena belum ada mapping),
        // juga simpan ke rawJid agar tidak kehilangan nama saat resolve nanti
        if (resolvedJid !== rawJid) {
          db.upsertContactPushname?.(rawJid, displayName)
        }
      }
    }

    // [FIX-LID] Build lidMap SETELAH simpan contacts, SEBELUM proses chats & messages
    if (contacts.length > 0) {
      const batch = buildLidMap(contacts)
      // Explicitly extract contact.lid field: { id: phone@s.whatsapp.net, lid: xxx@lid }
      for (const c of contacts) {
        if (c.lid && c.id) {
          const lid = normalizeJid(c.lid)
          const pn  = normalizeJid(c.id)
          if (isLidJid(lid) && !isLidJid(pn)) batch.set(lid, pn)
        }
      }
      mergeLidBatch(batch)  // merge ke global lidMap + persist ke disk + seed jid-utils

      // [FIX-LID-NAME] Sekarang lidMap sudah diperbarui, simpan ulang nama untuk @lid contacts
      // yang tadi belum ter-resolve (karena lidMap belum terisi saat loop pertama)
      for (const contact of contacts) {
        if (!contact.id) continue
        const rawJid = normalizeJid(contact.id)
        if (!isLidJid(rawJid)) continue
        const resolved = tryResolveLid(rawJid, lidMap)
        if (resolved === rawJid) continue  // masih belum bisa di-resolve, skip
        const displayName = contact.notify || contact.pushname || contact.name
        if (displayName) db.upsertContactPushname?.(resolved, displayName)
      }
    }

    // ── STEP 2: Simpan chats — @lid di chat.id sudah bisa di-resolve ─────────
    for (const chat of chats) {
      if (!chat.id) continue

      // [FIX-DUPLICATE] Resolve @lid chat.id → real phone JID.
      // Jika berhasil di-resolve → update chat.id dan simpan.
      // Jika TIDAK bisa di-resolve → SKIP sepenuhnya.
      // Jangan pernah menyimpan @lid sebagai jid di DB — ini menyebabkan
      // duplikat chat (satu @lid + satu @s.whatsapp.net) di chat list.
      if (isLidJid(chat.id)) {
        const resolved = resolveLid(chat.id, lidMap)
        if (resolved === chat.id) {
          // Masih @lid — tidak bisa di-resolve, skip agar tidak ada duplikat
          log(`[LID] Chat ${chat.id} unresolved, skip saveChat`)
          continue
        }
        log(`[LID] Chat resolved: ${chat.id} → ${resolved}`)
        chat.id = resolved
      }
      db.saveChat(chat)
    }

    // ── STEP 3: Simpan messages — DM & GROUP, resolve @lid di semua field ─────
    // [FIX-GROUP] handleMessage TIDAK filter @g.us — grup tetap disimpan ke DB.
    // handleMessage sudah handle: remoteJid @lid resolve, participant @lid resolve,
    // isJidStatusBroadcast/isJidBroadcast filter, fromMe fix untuk grup.
    const BATCH_SIZE = 100
    for (let i = 0; i < messages.length; i += BATCH_SIZE) {
      const chunk = messages.slice(i, i + BATCH_SIZE)
      for (const msg of chunk) {
        // [FIX-LID-MSG] Pre-resolve @lid di remoteJid & participant SEBELUM handleMessage
        // supaya lidMap yang baru saja dibangun dari contacts batch ini langsung terpakai.
        // handleMessage juga melakukan ini, tapi ada race jika lidMap baru saja di-update.
        if (msg.key?.remoteJid && isLidJid(msg.key.remoteJid)) {
          const resolved = resolveLid(normalizeJid(msg.key.remoteJid), lidMap)
          if (resolved !== msg.key.remoteJid) msg.key.remoteJid = resolved
        }
        if (msg.key?.participant && isLidJid(msg.key.participant)) {
          const resolved = resolveLid(normalizeJid(msg.key.participant), lidMap)
          if (resolved !== msg.key.participant) msg.key.participant = resolved
        }
        await handleMessage(msg, 'history', true)
      }
      // Yield ke event loop antar chunk agar UI tetap responsif
      if (i + BATCH_SIZE < messages.length) {
        await new Promise(r => setImmediate(r))
      }
    }

    // ── STEP 4: Update sync status ────────────────────────────────────────────
    send("sync:status", {
      isSyncing: true,
      progress,
      stats: syncStats
    })

    // ── STEP 5: Incremental chat list update setiap batch ────────────────────
    if (chats.length > 0) {
      setImmediate(() => {
        try { db.backfillChatLastMessages?.() } catch (_) {}
        send("db:chats:updated")
      })
    }

    // ── STEP 6: Selesai (isLatest = batch terakhir) ───────────────────────────
    if (isLatest) {
      _clearSyncWatchdog()  // [FIX-6] Normal completion — cancel watchdog
      isSyncing = false
      db.endSync(syncStats.chats, syncStats.messages)

      // Backfill pushnames & last messages dari semua data yang sudah masuk,
      // lalu resolve sisa @lid yang mungkin masih tersisa di DB
      setImmediate(() => {
        try {
          db.backfillChatLastMessages?.()
          db.backfillContactPushnames?.()
          db.backfillSenderNamesFromMessages?.()
          send("db:chats:updated")
          send("db:contacts:updated")
        } catch (_) {}
      })

      // [FIX-LID-FINAL] Jalankan resolveLidInDB sekali lagi setelah sync selesai
      // untuk membersihkan sisa @lid yang mungkin masuk sebelum lidMap penuh
      scheduleResolveLidInDB(500)

      send("sync:status", {
        isSyncing: false,
        progress: 100,
        stats: syncStats,
        isComplete: true
      })
      logOk(`History sync complete [${syncType ?? 'unknown'}]: ${syncStats.messages} msg, ${syncStats.chats} chats, ${contacts.length} contacts`)

      // Reset stats untuk sync berikutnya
      syncStats = { chats: 0, messages: 0 }
    }
  })

  // ════════════════════════════════════════════════════════
  // EVENT: messages.upsert (NEW MESSAGES & OFFLINE MESSAGES)
  // ════════════════════════════════════════════════════════

  // [FIX] Cache the optional case handler once at socket-init time instead of
  // require()-ing it on every single incoming message (hot path).
  let _caseHandler = null
  try {
    _caseHandler = require("./case")
  } catch (e) {
    if (e.code !== "MODULE_NOT_FOUND") logE(`case.js load error: ${e.message}`)
  }

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
  // type === 'notify' → Real-time messages arriving now
  // type === 'append' → Offline catch-up: messages missed during a paused session.
  //                     These are NOT a full history sync — they are the delta
  //                     between our last disconnect and now. Treat them as live
  //                     messages (render in UI) but suppress desktop notifications.

  const isAppend = type === 'append'

  // If this is the first append batch after reconnect, begin resume-sync tracking
  if (isAppend && !_isResumeSyncing && messages.length > 0) {
    _isResumeSyncing = true
    _resumeSyncStats = { messages: 0, chats: new Set() }
    const gapSec = _lastDisconnectTs > 0
      ? Math.round((Date.now() - _lastDisconnectTs) / 1000)
      : null
    const gapLabel = gapSec != null
      ? (gapSec < 60 ? `${gapSec}s` : gapSec < 3600 ? `${Math.round(gapSec/60)}m` : `${(gapSec/3600).toFixed(1)}h`)
      : 'unknown'
    log(`[ResumeSync] Gap-fill started — offline for ${gapLabel}`)
    send('sync:resume:start', {
      offlineSince: _lastDisconnectTs || null,
      gapSeconds:   gapSec,
    })
  }

  for (const msg of messages) {
    // isHistorySync=false so all catch-up messages are rendered in the UI.
    // The renderer should suppress desktop notifications for 'append' messages
    // (use the 'type' field in the payload if needed).
    await handleMessage(msg, type, false)

    // [FIX-LID-RETROACTIVE] Saat live message datang dari @s.whatsapp.net dengan pushName,
    // update DB history dimana participant masih tersimpan sebagai @lid dengan user number
    // yang sama. Ini terjadi karena history sync menyimpan sender sebagai @lid (unresolved),
    // lalu pesan live pertama dari orang yang sama memberi kita @s.whatsapp.net + pushName.
    //
    // Kondisi: hanya untuk 'notify' (bukan 'append'), hanya pesan masuk (bukan fromMe),
    // hanya jika senderJid adalah @s.whatsapp.net (bukan @lid / @g.us / dll).
    if (type === 'notify' && !msg.key?.fromMe && msg.pushName) {
      try {
        const remoteJid = msg.key?.remoteJid
        // Ambil sender JID: untuk grup = participant, untuk DM = remoteJid
        const senderJid = normalizeJid(
          (remoteJid && isGroupJid(remoteJid) ? msg.key?.participant : remoteJid) || ''
        )
        if (senderJid && isUserJid(senderJid)) {
          const userNumber = senderJid.split('@')[0]
          const lidVariant  = `${userNumber}@lid`

          // Cek apakah ada rows di DB yang masih pakai @lid ini sebagai participant
          const hasLidRows = db.hasLidParticipant?.(lidVariant)

          if (hasLidRows) {
            // 1. Ganti semua participant @lid → @s.whatsapp.net di messages table
            db.statements?.lidFixParticipant?.run(senderJid, lidVariant)

            // 2. Perbarui lidMap global agar resolve ini persisten
            const newEntry = new Map([[lidVariant, senderJid]])
            mergeLidBatch?.(newEntry)

            // 3. Upsert pushName ke contacts sekarang kita tahu JID-nya
            if (msg.pushName) {
              db.upsertContactPushname?.(senderJid, msg.pushName)
            }

            log(`[LID-RETRO] Resolved ${lidVariant} → ${senderJid} (pushName: ${msg.pushName}) — updated history`)
          }
        }
      } catch (_) { /* non-critical, jangan crash */ }
    }

    // Track resume-sync progress
    if (isAppend && _isResumeSyncing) {
      _resumeSyncStats.messages++
      const chatJid = msg.key?.remoteJid
      if (chatJid) _resumeSyncStats.chats.add(chatJid)
    }
  }

  // Flush resume-sync progress to renderer on each append batch
  if (isAppend && _isResumeSyncing) {
    send('sync:resume:progress', {
      messages: _resumeSyncStats.messages,
      chats:    _resumeSyncStats.chats.size,
    })
  
  }

  // Handler case.js (opsional)
  if (_caseHandler) {
    try {
      await _caseHandler(sock, { messages, type })
    } catch (e) {
      logE(`Error di case handler: ${e.message}`)
    }
  }
})


  sock.ev.on("messages.update", async (updates) => {
    for (const { key, update } of updates) {
      // Handle poll votes
      if (update.pollUpdates) {
        const pollMsg = db.getMessageById(key.id)
        if (pollMsg?.poll_options) {
          // [FIX] Guard against corrupt raw column
          let pollCreation = {}
          try { pollCreation = JSON.parse(pollMsg.raw || '{}') } catch (_) {}
          try {
            const pollResults = getAggregateVotesInPollMessage({
              message: pollCreation,
              pollUpdates: update.pollUpdates,
            })

            // Update poll votes in database
            db.updatePollVotes?.(key.id, JSON.stringify(pollResults))

            // Save individual votes
            for (const vote of update.pollUpdates) {
              db.savePollVote?.(key.id, vote.pollUpdateSenderKeyRemoteJid, vote.vote)
            }
          } catch (pollErr) {
            logW(`[POLL] aggregateVotes error for ${key.id}: ${pollErr.message}`)
          }
        }
      }

      // Handle message status updates
      if (update.status) {
        db.updateMessageStatus(key.id, update.status)
      }

      // Handle message edits / fromMe media delivery
      if (update.message) {
        // Save raw proto — critical for fromMe messages that arrive in two steps:
        // step 1: handleMessage gets msg with empty message field (just key+timestamp)
        // step 2: messages.update delivers the actual message content
        try {
          const existing = db.getMessageById?.(key.id)
          if (existing && (!existing.message_json || existing.message_json === '{}')) {
            db.updateMessageRaw(key.id, JSON.stringify(update.message))

            // [FIX-FROMME-MEDIA] If this update carries media content for a fromMe message,
            // trigger download now so it renders without requiring Ctrl+R.
            if (key.fromMe && existing.has_media && !existing.media_is_downloaded) {
              const msgType = existing.message_type
              const mediaTypeKey = resolveMediaTypeKey(msgType, update.message)
              if (mediaTypeKey) {
                const unwrapped = update.message?.ephemeralMessage?.message
                  || update.message?.viewOnceMessage?.message
                  || update.message?.documentWithCaptionMessage?.message
                  || update.message
                const inner = unwrapped?.[mediaTypeKey]
                if (inner?.url || inner?.directPath || inner?.mediaKey) {
                  const fakeMsg = { key: { id: key.id, remoteJid: key.remoteJid, fromMe: true }, message: update.message }
                  downloadAndSaveMedia(fakeMsg, mediaTypeKey, false).catch(() => { })
                }
              }
            }
          }
        } catch (_) { }

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
      // [FIX-DUPLICATE] Resolve @lid → phone JID, skip if unresolvable
      if (chat.id && isLidJid(chat.id)) {
        const resolved = resolveLid(chat.id, lidMap)
        if (resolved === chat.id) continue  // still @lid — skip
        chat.id = resolved
      }
      db.saveChat(chat)
    }
    send("chats:set", chats)
  })

  sock.ev.on("chats.upsert", (c) => {
    for (const chat of c) {
      // [FIX-DUPLICATE] Resolve @lid → phone JID, skip if unresolvable
      if (chat.id && isLidJid(chat.id)) {
        const resolved = resolveLid(chat.id, lidMap)
        if (resolved === chat.id) continue  // still @lid — skip
        chat.id = resolved
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

    // Also explicitly extract contact.lid field (Baileys Contact type):
    //   { id: "628xxx@s.whatsapp.net", lid: "12345@lid" }  →  lid → id
    // buildLidMap may or may not handle this depending on jid-utils version.
    for (const c of contacts) {
      if (c.lid && c.id) {
        const lid = normalizeJid(c.lid)
        const pn  = normalizeJid(c.id)
        if (isLidJid(lid) && !isLidJid(pn)) batch.set(lid, pn)
      }
    }
    mergeLidBatch(batch)

    // Drain pending @lid queue now that map is updated
    if (_pendingLidProbe.size > 0) _drainLidProbeQueue().catch(() => {})

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

    // [FIX-NEW-SESSION] After full contacts.set + LID map is built, push updated
    // chat list to frontend so contact names resolve correctly on first open.
    // Also schedule resolveLidInDB so any @lid that slipped into DB gets cleaned.
    setImmediate(() => {
      try {
        db.backfillContactPushnames?.()
        db.backfillSenderNamesFromMessages?.()
        send("db:chats:updated")
        send("db:contacts:updated")
      } catch (_) {}
    })
    scheduleResolveLidInDB(1000)
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
    // Explicitly extract contact.lid field: { id: phone@s.whatsapp.net, lid: xxx@lid }
    for (const c of arr) {
      if (c.lid && c.id) {
        const lid = normalizeJid(c.lid)
        const pn  = normalizeJid(c.id)
        if (isLidJid(lid) && !isLidJid(pn)) batch.set(lid, pn)
      }
    }
    mergeLidBatch(batch)
    // Drain any pending @lid now that the map has new entries
    if (_pendingLidProbe.size > 0) _drainLidProbeQueue().catch(() => {})

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

  sock.ev.on("contacts.update", (updates) => {
    send("contacts:update", updates)
    // [FIX-LID] contacts.update also carries real JID info — process same as upsert
    const arr = Array.isArray(updates) ? updates : [updates]
    for (const contact of arr) {
      if (!contact.id) continue
      // Decode device suffix (628xxx:8@s.whatsapp.net → 628xxx@s.whatsapp.net)
      const rawId = normalizeJid(contact.id)
      const resolvedId = isLidJid(rawId) ? tryResolveLid(rawId, lidMap) : rawId
      // Upsert pushname under resolved JID
      const name = contact.notify || contact.name || contact.pushname
      if (name && resolvedId) {
        db.upsertContactPushname?.(resolvedId, name)
        if (resolvedId !== rawId) db.upsertContactPushname?.(rawId, name)
      }
    }
    // Build lid mappings from this batch and drain pending queue
    const batch = buildLidMap(arr)
    if (batch.size > 0) {
      mergeLidBatch(batch)
      if (_pendingLidProbe.size > 0) _drainLidProbeQueue().catch(() => {})
    }
  })

  // Other events
  sock.ev.on("presence.update", ({ id, presences }) => send("presence:update", { id, presences }))
  sock.ev.on("groups.update", (u) => {
    // [FIX-GROUP-NAME] Update group subjects when they change
    for (const update of u) {
      if (update.id && update.subject) {
        db.updateGroupSubject(normalizeJid(update.id), update.subject)
      }
      // Merge update into cache so next getGroupMetadata() call reflects changes
      const jid = normalizeJid(update.id)
      if (_groupMetaCache.has(jid)) {
        _groupMetaCache.set(jid, { ..._groupMetaCache.get(jid), ...update })
      }
    }
    send("groups:update", u)
  })

  // [FIX-GROUP-NAME] groups.upsert fires when groups are loaded by Baileys
  // Also cache full metadata so getGroupMetadata() can return instantly without network.
  sock.ev.on("groups.upsert", (groups) => {
    for (const group of groups) {
      if (group.id && group.subject) {
        const jid = normalizeJid(group.id)
        db.updateGroupSubject(jid, group.subject)
        db.saveChat({ id: group.id, name: group.subject, isGroup: true })
        log(`[FIX-GROUP-NAME] groups.upsert: ${jid} → "${group.subject}"`)
        // Cache full metadata — avoids network fetch later
        _groupMetaCache.set(jid, group)
        if (group.participants?.length) {
          db.updateMemberCount?.(jid, group.participants.length)
        }
      }
    }
    if (groups.length > 0) send("db:chats:updated")
  })
  sock.ev.on("group-participants.update", ({ id, participants, action }) => {
    send("groups:participants", { id, participants, action })
    // [FIX-MEMBER-COUNT] Re-fetch group metadata to get accurate participant count
    // after add/remove/promote/demote. Without this, member_count in DB never
    // updates from live changes and the header keeps showing the stale value.
    if (id) {
      sock.groupMetadata(id)
        .then(meta => {
          if (meta?.participants?.length) {
            db.updateMemberCount?.(id, meta.participants.length)
            send("db:chats:updated", { jid: id, member_count: meta.participants.length })
          }
        })
        .catch(() => {})
    }
  })
  sock.ev.on("call", (calls) => send("call:incoming", calls))
  sock.ev.on("labels.association", (a) => send("labels:association", a))
  sock.ev.on("labels.edit", (l) => send("labels:edit", l))

  return sock
}

// ════════════════════════════════════════════════════════════
// ACTIVE GAP-FILL — fetch missed messages after a paused session
// ════════════════════════════════════════════════════════════
//
// Called 4s after connection:open when _lastDisconnectTs > 0.
// Mimics exactly what WA Web does on reconnect:
//   1. resyncAppState  — sync read receipts, mute/pin/unread state from server
//   2. fetchMessageHistory — pull actual missing messages for chats with a gap
//   3. requestPlaceholderResend — recover stub messages with no content
//
// The passive 'append' stream covers most cases, but active gap-fill ensures
// correctness when the passive stream is incomplete (long offline, many chats).

// _gapFilledChats: tracks chats filled this session — skip on round 2+.
// Cleared on every disconnect so next reconnect always starts fresh.
const _gapFilledChats = new Set()

async function _activeGapFill() {
  if (!isConnected || !sock) return
  const offlineMs  = _lastDisconnectTs > 0 ? Date.now() - _lastDisconnectTs : 0
  const offlineMin = offlineMs / 60_000
  if (offlineMs < 5000) return

  const offlineLabel = offlineMin < 60
    ? `${Math.round(offlineMin)}m`
    : offlineMin < 1440
      ? `${(offlineMin / 60).toFixed(1)}h`
      : `${(offlineMin / 1440).toFixed(1)}d`
  log(`[GapFill] Starting — offline ${offlineLabel}`)

  // Tier thresholds
  const isMedium   = offlineMin >= 1       // 1m+
  const isLong     = offlineMin >= 360     // 6h+
  const isVeryLong = offlineMin >= 1440    // 24h+

  // ── STEP 1: resyncAppState ───────────────────────────────────────────────
  // critical_block/unblock: unread counts, mute, pin, archive, read receipts.
  // regular_low/high: message delivery state — only needed after long offline.
  try {
    const collections = isLong
      ? ['critical_block', 'critical_unblock_to_primary', 'regular_low', 'regular_high']
      : ['critical_block', 'critical_unblock_to_primary']
    await sock.resyncAppState(collections, false)
    log(`[GapFill] resyncAppState(${collections.join(', ')}) done`)
  } catch (e) {
    logW(`[GapFill] resyncAppState error: ${e.message}`)
  }

  if (!isConnected || !sock) return
  await new Promise(r => setTimeout(r, 1500))

  // ── STEP 2: fetchMessageHistory — tiered by offline duration ─────────────
  //
  //  SHORT  (<1m):    skip — passive append is sufficient
  //  MEDIUM (1m–6h):  50 msgs × 30 chats × 1 round
  //  LONG   (6h–24h): 100 msgs × 50 chats × 2 rounds
  //  VERY LONG (24h+):100 msgs × 60 chats × 3 rounds
  //
  // Round 1 (long/verylong) uses getChatsForDeepGapFill — ALL active chats,
  // because WA clears unread on other devices so unread_count can't be trusted.
  // Round 2+ uses getChatsWithGap to re-check remaining gaps only.

  if (isMedium) {
    const msgCount  = isLong ? 100 : 50
    const maxRounds = isVeryLong ? 3 : isLong ? 2 : 1
    const chatLimit = isVeryLong ? 60 : isLong ? 50 : 30

    for (let round = 1; round <= maxRounds; round++) {
      if (!isConnected || !sock) break

      let gapChats = (isLong && round === 1)
        ? (db.getChatsForDeepGapFill?.(chatLimit) || [])
        : (db.getChatsWithGap?.(_lastDisconnectTs, chatLimit) || [])

      // Skip chats already successfully filled in a previous round
      if (round > 1) gapChats = gapChats.filter(c => !_gapFilledChats.has(c.jid))

      if (gapChats.length === 0) {
        log(`[GapFill] Round ${round}: no remaining gaps — done`)
        break
      }

      log(`[GapFill] Round ${round}/${maxRounds}: ${gapChats.length} chats × ${msgCount} msgs`)

      let fetched = 0
      for (const chat of gapChats) {
        if (!isConnected || !sock) break
        try {
          const oldestKey = {
            remoteJid: chat.jid,
            id:        chat.newest_msg_id || null,
            fromMe:    chat.newest_from_me === 1,
          }
          // oldest_ts = time anchor for the fetch.
          // WA returns messages NEWER than this key — exactly the gap.
          const oldestTime = chat.newest_ts
            ? new Date(chat.newest_ts * 1000)
            : new Date(_lastDisconnectTs)

          await sock.fetchMessageHistory(msgCount, oldestKey, oldestTime)
          _gapFilledChats.add(chat.jid)
          fetched++
        } catch (e) {
          logW(`[GapFill] fetchHistory ${chat.jid?.slice(0, 20)}: ${e.message}`)
        }

        // Adaptive jitter: fast for first 3 (visible in UI immediately),
        // slower thereafter to avoid WA rate-limiting on bulk requests.
        const delay = fetched <= 3
          ? 200 + Math.floor(Math.random() * 200)
          : 600 + Math.floor(Math.random() * 400)
        await new Promise(r => setTimeout(r, delay))
      }

      log(`[GapFill] Round ${round}: fetched ${fetched}/${gapChats.length} chats`)

      // Refresh UI after each round so messages appear progressively
      setImmediate(() => {
        try { db.backfillChatLastMessages?.() } catch (_) {}
        send('db:chats:updated')
      })

      // Wait for messaging-history.set results to land before checking gaps again
      if (round < maxRounds && fetched > 0) {
        await new Promise(r => setTimeout(r, 3500))
      }
    }
  } else {
    log('[GapFill] Short offline (<1m) — passive append stream handles it')
  }

  if (!isConnected || !sock) return

  // ── STEP 3: requestPlaceholderResend ────────────────────────────────────
  // Stub messages with no body/type — WA sent notification before content ready.
  try {
    const placeholders = db.getPlaceholderMessages?.() || []
    if (placeholders.length > 0) {
      log(`[GapFill] ${placeholders.length} placeholder messages — requesting resend`)
      for (const ph of placeholders) {
        if (!isConnected || !sock) break
        try {
          await sock.requestPlaceholderResend({
            remoteJid: ph.chat_jid,
            id:        ph.id,
            fromMe:    ph.from_me === 1,
          })
        } catch (_) {}
        await new Promise(r => setTimeout(r, 200))
      }
    }
  } catch (e) {
    logW(`[GapFill] placeholder resend error: ${e.message}`)
  }

  log(`[GapFill] Complete — ${_gapFilledChats.size} chats gap-filled`)
  setImmediate(() => {
    try { db.backfillChatLastMessages?.() } catch (_) {}
    send('db:chats:updated')
  })
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

  // Clear stale sync state so the next connection:open starts fresh
  isSyncing = false
  if (_syncAutoCompleteTimer) { clearTimeout(_syncAutoCompleteTimer); _syncAutoCompleteTimer = null }

  // [FIX-NETWORK] If network is offline, don't waste attempts — the net 'online'
  // event will trigger an immediate reconnect when connectivity returns.
  if (!_isNetworkOnline()) {
    logW('[NET] Jaringan offline — menunggu koneksi kembali (reconnect ditunda)...')
    send("connection:reconnecting", { attempt: reconnectAttempts, maxAttempt: CONFIG.MAX_RECONNECT, delayMs: -1 })
    return
  }

  reconnectAttempts++

  if (reconnectAttempts > CONFIG.MAX_RECONNECT) {
    logE(`Gagal reconnect setelah ${CONFIG.MAX_RECONNECT}x. Berhenti.`)
    const finalAttempts = reconnectAttempts  // [FIX] capture before reset
    reconnectAttempts = 0
    send("connection:failed", { attempts: finalAttempts })
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

  // [FIX] Guard readdirSync — it can throw EACCES/ENOTDIR on corrupt session dirs
  let sessionExists = false
  try {
    sessionExists = fs.existsSync(CONFIG.SESSION_DIR) &&
      fs.readdirSync(CONFIG.SESSION_DIR).length > 0
  } catch (e) {
    logW(`Session dir unreadable: ${e.message} — treating as no session`)
  }

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
  if (!row?.id) return null
  if (!sock) return null

  try {
    const msgType = row.message_type

    // [FIX-RECONSTRUCT-MSG] Build message object from DB fields when message_json is null/empty.
    // This happens for history-synced messages where message_json was never stored,
    // OR for old messages parsed before we started persisting message_json.
    // We can reconstruct a minimal-but-valid Baileys message using:
    //   media_url (or media_direct_path) + media_key (base64) + media_enc_sha256 + mimetype
    let message = null

    if (row.message_json) {
      try {
        message = JSON.parse(row.message_json)
      } catch (parseErr) {
        logW(`[PREFETCH] ${row.id}: bad JSON — ${parseErr.message?.slice(0, 40)}`)
        message = null
      }
    }

    // Validate that the parsed message actually contains downloadable media.
    // If message_json is present but inner object lacks keys — fall through to reconstruction.
    let mediaTypeKey = null
    let innerMediaObj = null

    if (message) {
      mediaTypeKey = resolveMediaTypeKey(msgType, message)
      if (mediaTypeKey) {
        const unwrapped = message?.ephemeralMessage?.message
          || message?.viewOnceMessage?.message
          || message?.viewOnceMessageV2?.message
          || message?.documentWithCaptionMessage?.message
          || message
        innerMediaObj = unwrapped?.[mediaTypeKey]
        const hasDownloadable = innerMediaObj?.url || innerMediaObj?.directPath || innerMediaObj?.mediaKey
        if (!hasDownloadable) {
          // message_json present but media fields stripped — try reconstruction
          message = null
          mediaTypeKey = null
          innerMediaObj = null
        }
      } else {
        // message_json can't resolve type — try reconstruction
        message = null
      }
    }

    // [FIX-RECONSTRUCT-MSG] Reconstruct minimal Baileys message from DB columns
    // (media_key, media_url/direct_path, media_enc_sha256, mimetype).
    // This lets us re-download without needing the original message_json.
    if (!message) {
      const dbMsgKey = row.media_key || null   // base64 string
      const dbUrl = row.media_url || null
      const dbPath = row.media_direct_path || null
      const dbEnc = row.media_enc_sha256 || null
      const dbMime = row.media_mimetype || row.mimetype || null
      const dbType = row.message_type || "imageMessage"

      // Need at least (mediaKey + (url or directPath)) for Baileys to download
      if (!dbMsgKey) {
        logW(`[PREFETCH] Skip ${row.id}: no message_json and no media_key — marking expired`)
        db.markMediaExpired?.(row.id)  // [FIX-MEDIA-SPAM] never retry this row
        return null
      }
      if (!dbUrl && !dbPath) {
        logW(`[PREFETCH] Skip ${row.id}: no message_json and no media_url/direct_path — marking expired`)
        db.markMediaExpired?.(row.id)  // [FIX-MEDIA-SPAM] never retry
        return null
      }

      // Decode base64 media_key back to Buffer for Baileys
      let mediaKeyBuf
      try {
        mediaKeyBuf = Buffer.from(dbMsgKey, 'base64')
      } catch (_) {
        logW(`[PREFETCH] Skip ${row.id}: invalid media_key base64`)
        return null
      }

      let encSha256Buf = null
      if (dbEnc) {
        try { encSha256Buf = Buffer.from(dbEnc, 'base64') } catch (_) { }
      }

      // Determine the simple message type key (imageMessage, videoMessage, etc.)
      const simpleType = (['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(dbType))
        ? dbType
        : (dbType === 'pttMessage' ? 'audioMessage' : 'imageMessage')

      const reconstructed = {
        url: dbUrl,
        directPath: dbPath,
        mediaKey: mediaKeyBuf,
        mimetype: dbMime || 'application/octet-stream',
        fileLength: row.media_size || row.media_file_length || undefined,
      }
      if (encSha256Buf) reconstructed.fileEncSha256 = encSha256Buf

      message = { [simpleType]: reconstructed }
      mediaTypeKey = simpleType
      innerMediaObj = reconstructed
      log(`[PREFETCH] Reconstructed message for ${row.id} (${simpleType}) from DB fields`)
    }

    if (!mediaTypeKey) {
      logW(`[PREFETCH] Skip ${row.id} (${msgType}): cannot resolve media type key`)
      return null
    }

    if (!innerMediaObj) {
      // Final check — should not reach here
      logW(`[PREFETCH] Skip ${row.id}: inner ${mediaTypeKey} missing after reconstruction`)
      return null
    }

    // [FIX-REDOWNLOAD] Race condition guard — check DB flag AND file existence
    const already = db.getMessageById(row.id)
    if (already?.media_is_downloaded === 1) {
      if (already.media_saved_path && fs.existsSync(already.media_saved_path)) return null
      // File gone — fall through to re-download
    } else if (already?.media_saved_path && fs.existsSync(already.media_saved_path)) {
      // File exists but flag not set — fix flag, skip download
      db.updateMediaSavedPath?.(row.id, already.media_saved_path)
      return null
    }

    // [FIX-FROMME] Preserve fromMe flag from DB row so download logic has correct context
    const fromMe = row.from_me === 1 || row.from_me === true
    const fakeMsg = {
      key: {
        id: row.id,
        remoteJid: row.chat_jid || row.remote_jid,
        fromMe,
      },
      message,
    }

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
    modManager.runOnAfterSend(jid, payload, sentMsg).catch(() => { })
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
  if (modManager) modManager.runOnAfterSend(jid, payload, sentMsg).catch(() => { })
  return sentMsg
}

async function sendVideo(jid, video, caption = "", quoted = null, opts = {}) {
  assertConnected()
  const src = typeof video === "string" ? { url: video } : video
  // [FIX-VIDEO-PLAYBACK] Always set mimetype: "video/mp4" by default.
  // Without explicit mimetype, WA sometimes fails to play the video on first upload
  // (recipient gets "video cannot be played" until they re-download).
  // Reference: Yumi bot fix — always pass mimetype "video/mp4" for video messages.
  let payload = { video: src, caption, mimetype: "video/mp4" }
  // [FIX-GIF] Pass gifPlayback flag when sending GIFs as videoMessage
  if (opts.gifPlayback) payload.gifPlayback = true
  // Allow caller to override mimetype (e.g. video/webm, video/3gpp)
  if (opts.mimetype) payload.mimetype = opts.mimetype

  if (modManager) {
    const result = await modManager.runOnBeforeSend(jid, payload).catch(() => payload)
    if (result === false) return null
    if (result && typeof result === "object") payload = result
  }

  const sentMsg = await sock.sendMessage(jid, payload, quoted ? { quoted } : {})
  if (modManager) modManager.runOnAfterSend(jid, payload, sentMsg).catch(() => { })
  return sentMsg
}

// [FIX-GIF] Dedicated GIF sender — converts image/gif to WA videoMessage+gifPlayback
// WA protocol: GIFs are always sent as videoMessage with gifPlayback=true, NOT imageMessage.
// The file must be in a video container (mp4 preferred). Browser-side GIF files (.gif) are
// sent as-is and WA server transcodes them. mimetype must be "video/mp4" or "image/gif"
// — WA accepts image/gif and converts on upload.
async function sendGif(jid, gifBuffer, caption = "", quoted = null) {
  assertConnected()
  let payload = {
    video: gifBuffer,
    caption,
    gifPlayback: true,
    // WA accepts image/gif here and handles conversion; video/mp4 also works for pre-converted
    mimetype: "video/mp4",
  }

  if (modManager) {
    const result = await modManager.runOnBeforeSend(jid, payload).catch(() => payload)
    if (result === false) return null
    if (result && typeof result === "object") payload = result
  }

  const sentMsg = await sock.sendMessage(jid, payload, quoted ? { quoted } : {})
  if (modManager) modManager.runOnAfterSend(jid, payload, sentMsg).catch(() => { })
  return sentMsg
}

async function sendAudio(jid, audio, ptt = false, quoted = null, opts = {}) {
  assertConnected()
  const src = typeof audio === "string" ? { url: audio } : audio
  // [FIX-AUDIO-PLAYBACK] Determine mimetype correctly:
  // - PTT (voice note): always "audio/ogg; codecs=opus" — required by WA
  // - Regular audio: prefer caller-supplied mimetype, fallback "audio/mp4"
  //   (audio/mp4 = .m4a is the most universally playable on WA)
  // Previously hardcoded "audio/mp4" for all non-PTT audio caused some formats
  // (mp3, ogg, wav) to fail to play on WA status and regular chats.
  const mimetype = ptt
    ? "audio/ogg; codecs=opus"
    : (opts?.mimetype || "audio/mp4")
  return await sock.sendMessage(jid, {
    audio: src,
    ptt,
    mimetype,
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
  if (modManager) modManager.runOnAfterSend(jid, payload, sentMsg).catch(() => { })
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

// Pin or unpin a specific message in a chat.
// duration in seconds: 86400=24h, 604800=7d, 2592000=30d
// pin=false → unpin (sets type=0 in WA protocol)
async function pinChatMessage(jid, msgKey, pin = true, duration = 86400) {
  assertConnected()
  // Baileys sendMessage with pin type sends a PinInChat message
  await sock.sendMessage(jid, {
    pin: { type: pin ? (duration <= 86400 ? 1 : duration <= 604800 ? 2 : 3) : 0, key: msgKey },
  })
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
const _picFetchCooldown = new Map() // jid → timestamp of last fetch
const _groupMetaCache   = new Map() // jid → full groupMetadata object (populated by groups.upsert)
const _PIC_COOLDOWN_MAX = 5000      // [FIX] cap map size to prevent unbounded memory growth

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

  // [FIX] Evict oldest entry if map is getting large (LRU-lite)
  if (_picFetchCooldown.size >= _PIC_COOLDOWN_MAX) {
    const oldestKey = _picFetchCooldown.keys().next().value
    _picFetchCooldown.delete(oldestKey)
  }
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

// ── fetchContactStatus — get WhatsApp About/status for a contact ─────────────
async function fetchContactStatus(jid) {
  if (!jid) return { status: null }
  try {
    assertConnected()
    const normalized = jidNormalizedUser(jid)
    const res = await sock.fetchStatus(normalized)
    return { status: res?.status || null, setAt: res?.setAt || null }
  } catch (err) {
    return { status: null, error: err.message }
  }
}

async function fetchContactStatusBulk(jids) {
  const out = {}
  if (!Array.isArray(jids) || !sock) return out
  // Concurrency cap: fetch max 8 at a time to avoid WABinary flood
  const BATCH = 8
  for (let i = 0; i < jids.length; i += BATCH) {
    const chunk = jids.slice(i, i + BATCH)
    const results = await Promise.allSettled(
      chunk.map(async jid => {
        const normalized = jidNormalizedUser(jid)
        const res = await sock.fetchStatus(normalized)
        return { jid, status: res?.status || null, setAt: res?.setAt || null }
      })
    )
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value?.jid) {
        out[r.value.jid] = { status: r.value.status, setAt: r.value.setAt }
      }
    }
    // Small pause between batches to avoid rate limits
    if (i + BATCH < jids.length) await new Promise(r => setTimeout(r, 300))
  }
  return out
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
  const normalized = normalizeJid(jid)

  // 1. Serve from in-memory cache (populated by groups.upsert on startup) — instant, no network
  if (_groupMetaCache.has(normalized)) {
    return _groupMetaCache.get(normalized)
  }

  // 2. Cache miss → fetch from WA with a 10s timeout to prevent infinite hang
  const meta = await Promise.race([
    sock.groupMetadata(jid),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("groupMetadata timeout after 10s")), 10000)
    )
  ])

  // Cache the result for future calls
  if (meta) _groupMetaCache.set(normalized, meta)
  return meta
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
  const randomFont = STORY_FONTS[Math.floor(Math.random() * STORY_FONTS.length)]

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
      // [FIX-VIDEO-PLAYBACK] Always pass mimetype "video/mp4" for status video.
      // Use caller-provided mimetype if given, fallback to "video/mp4".
      { video: buf, caption: caption || "", mimetype: mimetype || "video/mp4" },
      { statusJidList }
    )

  } else if (type === "audio") {
    const buf = Buffer.isBuffer(mediaBuffer) ? mediaBuffer : Buffer.from(mediaBuffer)
    // [FIX-AUDIO-STATUS] WA status audio requires "audio/mp4" (NOT audio/ogg or audio/mpeg).
    // Use caller-provided mimetype if valid for WA status, otherwise force "audio/mp4".
    // Reference: Yumi bot always uses audio/mp4 for status audio.
    const audioMime = (mimetype && mimetype.startsWith("audio/")) ? mimetype : "audio/mp4"
    sentMsg = await sock.sendMessage(
      "status@broadcast",
      {
        audio: buf,
        mimetype: audioMime,
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
// PUBLIC: PRIVACY SETTINGS
// ════════════════════════════════════════════════════════════

/** Fetch all privacy settings (lastSeen, profilePicture, status, etc.) */
async function getPrivacySettings() {
  assertConnected()
  return await sock.fetchPrivacySettings(true)
}

/** Fetch raw privacy tokens for specific JIDs */
async function getPrivacyTokens(jids) {
  assertConnected()
  return await sock.getPrivacyTokens(jids)
}

/** Update last seen privacy: 'all' | 'contacts' | 'contact_blacklist' | 'none' */
async function updateLastSeenPrivacy(value) {
  assertConnected()
  return await sock.updateLastSeenPrivacy(value)
}

/** Update online privacy: 'all' | 'match_last_seen' */
async function updateOnlinePrivacy(value) {
  assertConnected()
  return await sock.updateOnlinePrivacy(value)
}

/** Update profile picture privacy: 'all' | 'contacts' | 'contact_blacklist' | 'none' */
async function updateProfilePicturePrivacy(value) {
  assertConnected()
  return await sock.updateProfilePicturePrivacy(value)
}

/** Update status/about privacy: 'all' | 'contacts' | 'contact_blacklist' | 'none' */
async function updateStatusPrivacy(value) {
  assertConnected()
  return await sock.updateStatusPrivacy(value)
}

/** Update read receipts privacy: 'all' | 'none' */
async function updateReadReceiptsPrivacy(value) {
  assertConnected()
  return await sock.updateReadReceiptsPrivacy(value)
}

/** Update groups add privacy: 'all' | 'contacts' | 'contact_blacklist' | 'none' */
async function updateGroupsAddPrivacy(value) {
  assertConnected()
  return await sock.updateGroupsAddPrivacy(value)
}

/** Update call privacy: 'all' | 'known' */
async function updateCallPrivacy(value) {
  assertConnected()
  return await sock.updateCallPrivacy(value)
}

/** Update messages privacy (for linked devices) */
async function updateMessagesPrivacy(value) {
  assertConnected()
  return await sock.updateMessagesPrivacy(value)
}

/** Toggle link preview privacy */
async function updateDisableLinkPreviewsPrivacy(value) {
  assertConnected()
  return await sock.updateDisableLinkPreviewsPrivacy(value)
}

/** Set default disappearing message duration (seconds, 0 = off) */
async function updateDefaultDisappearingMode(duration) {
  assertConnected()
  return await sock.updateDefaultDisappearingMode(duration)
}

/** Fetch disappearing duration for a chat */
async function fetchDisappearingDuration(jid) {
  assertConnected()
  return await sock.fetchDisappearingDuration(jid)
}

// ════════════════════════════════════════════════════════════
// PUBLIC: PROFILE PICTURE
// ════════════════════════════════════════════════════════════

/**
 * updateMyProfilePicture — set a new profile picture.
 * @param {Buffer} imageBuffer — JPEG/PNG image buffer
 */
async function updateMyProfilePicture(imageBuffer) {
  assertConnected()
  const buf = Buffer.isBuffer(imageBuffer) ? imageBuffer : Buffer.from(imageBuffer)
  return await sock.updateProfilePicture(sock.user.id, buf)
}

/**
 * updateProfilePicture — set profile picture for any JID (requires permission).
 * @param {string} jid
 * @param {Buffer} imageBuffer
 */
async function updateProfilePicture(jid, imageBuffer) {
  assertConnected()
  const buf = Buffer.isBuffer(imageBuffer) ? imageBuffer : Buffer.from(imageBuffer)
  return await sock.updateProfilePicture(jid, buf)
}

/** Remove profile picture for a JID */
async function removeProfilePicture(jid) {
  assertConnected()
  return await sock.removeProfilePicture(jid)
}

// ════════════════════════════════════════════════════════════
// PUBLIC: BLOCKLIST
// ════════════════════════════════════════════════════════════

/** Fetch full blocklist */
async function fetchBlocklist() {
  assertConnected()
  return await sock.fetchBlocklist()
}

// ════════════════════════════════════════════════════════════
// PUBLIC: CONTACTS
// ════════════════════════════════════════════════════════════

/**
 * addOrEditContact — add or edit a contact in WA address book.
 * @param {string} jid
 * @param {object} opts — { full_name, organization }
 */
async function addOrEditContact(jid, opts = {}) {
  assertConnected()
  return await sock.addOrEditContact({ jid, ...opts })
}

/** Remove a contact from WA address book */
async function removeContact(jid) {
  assertConnected()
  return await sock.removeContact({ jid })
}

/** Get business profile for a JID */
async function getBusinessProfile(jid) {
  assertConnected()
  return await sock.getBusinessProfile(jid)
}

// ════════════════════════════════════════════════════════════
// PUBLIC: LABELS
// ════════════════════════════════════════════════════════════

/** Add a label to WA account */
async function addLabel(label) {
  assertConnected()
  return await sock.addLabel(label)
}

/** Add a label to a chat */
async function addChatLabel(jid, labelId) {
  assertConnected()
  return await sock.addChatLabel(jid, labelId)
}

/** Remove a label from a chat */
async function removeChatLabel(jid, labelId) {
  assertConnected()
  return await sock.removeChatLabel(jid, labelId)
}

/** Add a label to a specific message */
async function addMessageLabel(jid, msgId, labelId) {
  assertConnected()
  return await sock.addMessageLabel(jid, msgId, labelId)
}

/** Remove a label from a specific message */
async function removeMessageLabel(jid, msgId, labelId) {
  assertConnected()
  return await sock.removeMessageLabel(jid, msgId, labelId)
}

// ════════════════════════════════════════════════════════════
// PUBLIC: APP STATE & SYNC
// ════════════════════════════════════════════════════════════

/** Re-sync app state patches from server (use after corruption/gap) */
async function resyncAppState(collections, isInitialSync = false) {
  assertConnected()
  return await sock.resyncAppState(collections, isInitialSync)
}

/** Clean dirty bits for specific app state collections */
async function cleanDirtyBits(type, fromTimestamp) {
  assertConnected()
  return await sock.cleanDirtyBits(type, fromTimestamp)
}

/** Upload pre-keys to server */
async function uploadPreKeys() {
  assertConnected()
  return await sock.uploadPreKeys()
}

/** Upload pre-keys only if required (below threshold) */
async function uploadPreKeysIfRequired() {
  assertConnected()
  return await sock.uploadPreKeysToServerIfRequired()
}

/** Upsert a message directly into Baileys state (store injection) */
async function upsertMessage(msg, type) {
  assertConnected()
  return await sock.upsertMessage(msg, type)
}

/** Patch app state (WA multi-device sync) */
async function appPatch(patchCreate) {
  assertConnected()
  return await sock.appPatch(patchCreate)
}

// ════════════════════════════════════════════════════════════
// PUBLIC: GROUP — EXTENDED
// ════════════════════════════════════════════════════════════

/** Raw group node query (low-level) */
async function groupQuery(jid, type, content) {
  assertConnected()
  return await sock.groupQuery(jid, type, content)
}

/** Revoke group invite link */
async function revokeGroupInvite(jid) {
  assertConnected()
  return await sock.groupRevokeInvite(jid)
}

/** Accept a group invite by code */
async function acceptGroupInvite(code) {
  assertConnected()
  return await sock.groupAcceptInvite(code)
}

/** Revoke a group invite V4 (newer WA protocol) */
async function revokeGroupInviteV4(jid, inviteStanza) {
  assertConnected()
  return await sock.groupRevokeInviteV4(jid, inviteStanza)
}

/** Accept a group invite V4 */
async function acceptGroupInviteV4(key, inviteMessage) {
  assertConnected()
  return await sock.groupAcceptInviteV4(key, inviteMessage)
}

/** Get info about a group invite (without joining) */
async function getGroupInviteInfo(code) {
  assertConnected()
  return await sock.groupGetInviteInfo(code)
}

/** Toggle ephemeral (disappearing) messages in a group */
async function groupToggleEphemeral(jid, ephemeralExpiration) {
  assertConnected()
  return await sock.groupToggleEphemeral(jid, ephemeralExpiration)
}

/**
 * Update group settings.
 * @param {string} jid
 * @param {'announcement'|'not_announcement'|'locked'|'unlocked'} setting
 */
async function groupSettingUpdate(jid, setting) {
  assertConnected()
  return await sock.groupSettingUpdate(jid, setting)
}

/**
 * Control who can add members to group.
 * @param {string} jid
 * @param {'all_member_add'|'admin_add'} mode
 */
async function groupMemberAddMode(jid, mode) {
  assertConnected()
  return await sock.groupMemberAddMode(jid, mode)
}

/**
 * Toggle join approval mode for group.
 * @param {string} jid
 * @param {'on'|'off'} mode
 */
async function groupJoinApprovalMode(jid, mode) {
  assertConnected()
  return await sock.groupJoinApprovalMode(jid, mode)
}

/** Get pending join requests list */
async function groupRequestParticipantsList(jid) {
  assertConnected()
  return await sock.groupRequestParticipantsList(jid)
}

/**
 * Approve or reject pending group join requests.
 * @param {string}   jid
 * @param {string[]} participants
 * @param {'approve'|'reject'} action
 */
async function groupRequestParticipantsUpdate(jid, participants, action) {
  assertConnected()
  return await sock.groupRequestParticipantsUpdate(jid, participants, action)
}

/** Fetch all groups this account is participating in */
async function groupFetchAllParticipating() {
  assertConnected()
  return await sock.groupFetchAllParticipating()
}

// ════════════════════════════════════════════════════════════
// PUBLIC: NEWSLETTER (WA Channels)
// ════════════════════════════════════════════════════════════

/** Subscribe to newsletter updates */
async function subscribeNewsletterUpdates(jid) {
  assertConnected()
  return await sock.subscribeNewsletterUpdates(jid)
}

/** Set reaction mode for a newsletter */
async function newsletterReactionMode(jid, reactionMode) {
  assertConnected()
  return await sock.newsletterReactionMode(jid, reactionMode)
}

/** Update newsletter description */
async function newsletterUpdateDescription(jid, description) {
  assertConnected()
  return await sock.newsletterUpdateDescription(jid, description)
}

/** Update newsletter name */
async function newsletterUpdateName(jid, name) {
  assertConnected()
  return await sock.newsletterUpdateName(jid, name)
}

/** Update newsletter picture */
async function newsletterUpdatePicture(jid, imageBuffer) {
  assertConnected()
  const buf = Buffer.isBuffer(imageBuffer) ? imageBuffer : Buffer.from(imageBuffer)
  return await sock.newsletterUpdatePicture(jid, buf)
}

/** Remove newsletter picture */
async function newsletterRemovePicture(jid) {
  assertConnected()
  return await sock.newsletterRemovePicture(jid)
}

/** Unfollow a newsletter */
async function newsletterUnfollow(jid) {
  assertConnected()
  return await sock.newsletterUnfollow(jid)
}

/** Follow a newsletter */
async function newsletterFollow(jid) {
  assertConnected()
  return await sock.newsletterFollow(jid)
}

/** Unmute a newsletter */
async function newsletterUnmute(jid) {
  assertConnected()
  return await sock.newsletterUnmute(jid)
}

/** Mute a newsletter */
async function newsletterMute(jid) {
  assertConnected()
  return await sock.newsletterMute(jid)
}

/** Create a new newsletter (WA Channel) */
async function newsletterCreate(name, opts = {}) {
  assertConnected()
  return await sock.newsletterCreate(name, opts)
}

/** Get newsletter metadata */
async function newsletterMetadata(type, key) {
  assertConnected()
  return await sock.newsletterMetadata(type, key)
}

/** Get newsletter admin count */
async function newsletterAdminCount(jid) {
  assertConnected()
  return await sock.newsletterAdminCount(jid)
}

/** Transfer newsletter ownership to another admin */
async function newsletterChangeOwner(jid, newOwnerJid) {
  assertConnected()
  return await sock.newsletterChangeOwner(jid, newOwnerJid)
}

/** Demote a newsletter admin */
async function newsletterDemote(jid, adminJid) {
  assertConnected()
  return await sock.newsletterDemote(jid, adminJid)
}

/** Delete a newsletter */
async function newsletterDelete(jid) {
  assertConnected()
  return await sock.newsletterDelete(jid)
}

/** React to a newsletter message */
async function newsletterReactMessage(jid, serverId, reaction) {
  assertConnected()
  return await sock.newsletterReactMessage(jid, serverId, reaction)
}

/** Fetch messages from a newsletter */
async function newsletterFetchMessages(type, jid, count, after) {
  assertConnected()
  return await sock.newsletterFetchMessages(type, jid, count, after)
}

/** Fetch newsletter updates since a timestamp */
async function newsletterFetchUpdates(jid) {
  assertConnected()
  return await sock.newsletterFetchUpdates(jid)
}

// ════════════════════════════════════════════════════════════
// PUBLIC: CALLS
// ════════════════════════════════════════════════════════════

/** Reject an incoming call */
async function rejectCall(callId, callFrom) {
  assertConnected()
  return await sock.rejectCall(callId, callFrom)
}

/** Initiate an outgoing call */
async function offerCall(toJid, isVideo = false) {
  assertConnected()
  return await sock.offerCall(toJid, isVideo)
}

/** Create a call link (shareable) */
async function createCallLink() {
  assertConnected()
  return await sock.createCallLink()
}

// ════════════════════════════════════════════════════════════
// PUBLIC: MESSAGING — LOW LEVEL
// ════════════════════════════════════════════════════════════

/**
 * relayMessage — send a pre-built WAMessage proto directly.
 * Use for forwarding or when you need full control over the message content.
 * @param {string} jid
 * @param {object} message — WAMessage.Message proto object
 * @param {object} opts    — { messageId, cachedGroupMetadata, ... }
 */
async function relayMessage(jid, message, opts = {}) {
  assertConnected()
  return await sock.relayMessage(jid, message, opts)
}

/**
 * sendMessageRaw — wrapper sock.sendMessage tanpa quoted, return full WAMessage.
 * Dipakai oleh group:send-status-v2 IPC untuk upload media ke WA CDN dulu
 * sebelum di-relay sebagai groupStatusMessageV2.
 */
async function sendMessageRaw(jid, payload) {
  assertConnected()
  return await sock.sendMessage(jid, payload)
}

/** Send a message receipt (delivered / read / played) */
async function sendReceipt(jid, participant, msgIds, type) {
  assertConnected()
  return await sock.sendReceipt(jid, participant, msgIds, type)
}

/** Send multiple receipts at once */
async function sendReceipts(keys, type) {
  assertConnected()
  return await sock.sendReceipts(keys, type)
}

/** Send ACK for a received message (internal Baileys use) */
async function sendMessageAck(node) {
  assertConnected()
  return await sock.sendMessageAck(node)
}

/** Send retry request for a failed decryption */
async function sendRetryRequest(node, forceIncludeKeys = false) {
  assertConnected()
  return await sock.sendRetryRequest(node, forceIncludeKeys)
}

/** Send peer data operation message (multi-device sync) */
async function sendPeerDataOperationMessage(patchMessage) {
  assertConnected()
  return await sock.sendPeerDataOperationMessage(patchMessage)
}

/** Refresh media connection credentials */
async function refreshMediaConn(forceGet = false) {
  assertConnected()
  return await sock.refreshMediaConn(forceGet)
}

/** Upload a file to WA servers */
async function waUploadToServer(fileBuf, opts = {}) {
  assertConnected()
  const buf = Buffer.isBuffer(fileBuf) ? fileBuf : Buffer.from(fileBuf)
  return await sock.waUploadToServer(buf, opts)
}

/** Get devices for uSync query */
async function getUSyncDevices(jids, useCache = true, ignoreZeroDevices = false) {
  assertConnected()
  return await sock.getUSyncDevices(jids, useCache, ignoreZeroDevices)
}

/** Create participant nodes for group message */
async function createParticipantNodes(jids, message, extraAttrs) {
  assertConnected()
  return await sock.createParticipantNodes(jids, message, extraAttrs)
}

/** Execute a USync query (contacts/devices sync) */
async function executeUSyncQuery(query) {
  assertConnected()
  return await sock.executeUSyncQuery(query)
}

/** Send a WAM analytics buffer */
async function sendWAMBuffer(wmBuffer) {
  assertConnected()
  return await sock.sendWAMBuffer(wmBuffer)
}

// ════════════════════════════════════════════════════════════
// PUBLIC: MESSAGE HISTORY
// ════════════════════════════════════════════════════════════

/**
 * fetchMessageHistory — request historical messages from WA servers.
 * @param {number} count          — number of messages to fetch
 * @param {object} oldestMsgKey   — WAMessageKey of the oldest known message
 * @param {Date}   oldestMsgTime  — timestamp of oldest message
 */
async function fetchMessageHistory(count, oldestMsgKey, oldestMsgTime) {
  assertConnected()
  return await sock.fetchMessageHistory(count, oldestMsgKey, oldestMsgTime)
}

/**
 * requestPlaceholderResend — request a missed/placeholder message to be re-sent.
 * @param {object} msgKey — WAMessageKey of the placeholder
 */
async function requestPlaceholderResend(msgKey) {
  assertConnected()
  return await sock.requestPlaceholderResend(msgKey)
}

// ════════════════════════════════════════════════════════════
// PUBLIC: COMMERCE (Orders, Catalog, Products)
// ════════════════════════════════════════════════════════════

/**
 * getOrderDetails — fetch order details.
 * @param {string} orderId
 * @param {string} tokenBase64
 */
async function getOrderDetails(orderId, tokenBase64) {
  assertConnected()
  return await sock.getOrderDetails(orderId, tokenBase64)
}

/**
 * getCatalog — fetch product catalog for a JID.
 * @param {string} jid
 * @param {number} [limit]
 * @param {string} [cursor]
 */
async function getCatalog(jid, limit, cursor) {
  assertConnected()
  return await sock.getCatalog({ jid, limit, cursor })
}

/**
 * getCollections — fetch product collections for a JID.
 * @param {string} jid
 * @param {number} [limit]
 */
async function getCollections(jid, limit) {
  assertConnected()
  return await sock.getCollections(jid, limit)
}

/**
 * productCreate — create a new product listing.
 * @param {object} product — product object (name, price, currency, description, etc.)
 * @param {Buffer[]} [images]
 */
async function productCreate(product, images = []) {
  assertConnected()
  const bufs = images.map(img => Buffer.isBuffer(img) ? img : Buffer.from(img))
  return await sock.productCreate(product, bufs)
}

/**
 * productDelete — delete products by catalog ID.
 * @param {string[]} productIds
 */
async function productDelete(productIds) {
  assertConnected()
  return await sock.productDelete(productIds)
}

/**
 * productUpdate — update an existing product.
 * @param {string} productId
 * @param {object} update
 * @param {Buffer[]} [images]
 */
async function productUpdate(productId, update, images = []) {
  assertConnected()
  const bufs = images.map(img => Buffer.isBuffer(img) ? img : Buffer.from(img))
  return await sock.productUpdate(productId, update, bufs)
}

// ════════════════════════════════════════════════════════════
// PUBLIC: BOT / USYNC
// ════════════════════════════════════════════════════════════

/** Get bot list V2 (for WA Business bots) */
async function getBotListV2(jid) {
  assertConnected()
  return await sock.getBotListV2(jid)
}

/** Assert sessions exist for a list of JIDs (creates if missing) */
async function assertSessions(jids, force = false) {
  assertConnected()
  return await sock.assertSessions(jids, force)
}

// ════════════════════════════════════════════════════════════
// PUBLIC: WAIT / CONNECTION UTILS
// ════════════════════════════════════════════════════════════

/** Generate a unique Baileys message tag */
function generateMessageTag() {
  if (!sock) throw new Error("Tidak ada koneksi aktif")
  return sock.generateMessageTag()
}

/**
 * waitForMessage — wait for a specific message matching predicate.
 * @param {string}   jid
 * @param {Function} check    — (msg) => boolean
 * @param {number}   [timeout=20000]
 */
async function waitForMessage(jid, check, timeout = 20000) {
  assertConnected()
  return await sock.waitForMessage(jid, check, timeout)
}

/**
 * waitForSocketOpen — wait until socket connection is fully open.
 * @param {number} [timeout=10000]
 */
async function waitForSocketOpen(timeout = 10000) {
  if (!sock) throw new Error("Tidak ada koneksi aktif")
  return await sock.waitForSocketOpen(timeout)
}

/**
 * waitForConnectionUpdate — wait for a specific connection state.
 * @param {Function} check     — (update) => boolean
 * @param {number}   [timeout=20000]
 */
async function waitForConnectionUpdate(check, timeout = 20000) {
  if (!sock) throw new Error("Tidak ada koneksi aktif")
  return await sock.waitForConnectionUpdate(check, timeout)
}

// ════════════════════════════════════════════════════════════
// PUBLIC: LOW-LEVEL SOCKET (use with caution)
// ════════════════════════════════════════════════════════════

/** Send a raw binary message over the socket (internal/advanced) */
async function sendRawMessage(data) {
  assertConnected()
  return await sock.sendRawMessage(data)
}

/** Send a WA XML node directly (internal/advanced) */
async function sendNode(node) {
  assertConnected()
  return await sock.sendNode(node)
}

/**
 * query — send a query node and await a response (internal/advanced).
 * @param {object} node
 * @param {number} [timeout]
 */
async function queryNode(node, timeout) {
  assertConnected()
  return await sock.query(node, timeout)
}

/** End the socket connection (does NOT logout — use logout() for clean exit) */
async function endSocket(error) {
  if (!sock) return
  return await sock.end(error)
}

// ════════════════════════════════════════════════════════════
// PUBLIC: DATABASE QUERIES (untuk IPC handlers)
// ════════════════════════════════════════════════════════════

function getMessagesFromDB(jid, limit = 20, offset = 0) {
  return db.getMessages(jid, limit, offset)
}

function searchMessagesInDB(jid, query) {
  return db.searchMessages(jid, query)
}

function getChatsFromDB(limit = 20, offset = 0) {
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

// [FIX-3] Toggle AUTO_DOWNLOAD_MEDIA at runtime (called from IPC settings:set-auto-download)
function setAutoDownloadMedia(enabled) {
  CONFIG.AUTO_DOWNLOAD_MEDIA = !!enabled
  console.log('[AuroraClient] AUTO_DOWNLOAD_MEDIA runtime →', CONFIG.AUTO_DOWNLOAD_MEDIA)
}

function getAutoDownloadMedia() {
  return CONFIG.AUTO_DOWNLOAD_MEDIA
}

// Immediate lid resolution — called from IPC on chat click.
// Runs DB fix pass immediately + drains any pending @lid from map.
function resolveLidNow() {
  resolveLidInDB()
  if (_pendingLidProbe.size > 0) _drainLidProbeQueue().catch(() => {})
}

// [FIX-LID-QUOTED] Expose lidMap entries to renderer for quoted-sender resolution.
// Returns a plain object { lidUser: phoneJid } so IPC can serialize it.
// The renderer uses this to pre-build a secondary lookup: @lid → @s.whatsapp.net.
function getLidMapEntries() {
  const out = {}
  for (const [k, v] of lidMap) out[k] = v
  return out
}

// Ambil full WAMessage proto dari in-memory cache (untuk DevEval full dump)
function getRawMsg(msgId) {
  return msgId ? rawMsgCache.get(msgId) || null : null
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
  getRawMsg,
  setAutoDownloadMedia,   // [FIX-3] Runtime toggle for auto download setting
  getAutoDownloadMedia,   // [FIX-3] Read current setting (used by main.js prefetch gate)
  resolveLidNow,          // [FIX-LID-CLICK] Immediate lid re-resolution on demand
  getLidMapEntries,       // [FIX-LID-QUOTED] Expose lid→phone map to renderer for quoted sender resolution
  getConnectionStatus,
  getResumeSyncStatus,    // [ResumeSync] live gap-fill progress (messages, chats, active)

  requestPairingCode,
  startQRMode,
  logout,
  clearSession,

  sendTextMessage,
  sendImage,
  sendVideo,
  sendGif,
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
  pinChatMessage,

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
  fetchContactStatus,
  fetchContactStatusBulk,
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
  getMyJid: () => sock?.user?.id || null,
  getContactStatuses,
  getStatusesBySender,
  markStatusSeen,
  fetchContactStories,
  fetchSingleContactStory,
  setAutoViewStatus,
  getAutoViewStatus,

  // [FIX-CONN-STATE] Expose connection state so main.js can gate prefetch/download
  isConnected: () => isConnected,

  // ── Privacy ────────────────────────────────────────────────
  getPrivacySettings,
  getPrivacyTokens,
  updateLastSeenPrivacy,
  updateOnlinePrivacy,
  updateProfilePicturePrivacy,
  updateStatusPrivacy,
  updateReadReceiptsPrivacy,
  updateGroupsAddPrivacy,
  updateCallPrivacy,
  updateMessagesPrivacy,
  updateDisableLinkPreviewsPrivacy,
  updateDefaultDisappearingMode,
  fetchDisappearingDuration,

  // ── Profile picture ────────────────────────────────────────
  updateMyProfilePicture,
  updateProfilePicture,
  removeProfilePicture,
  getMediaDir: () => CONFIG.MEDIA_DIR,

  // ── Blocklist ──────────────────────────────────────────────
  fetchBlocklist,

  // ── Contacts ──────────────────────────────────────────────
  addOrEditContact,
  removeContact,
  getBusinessProfile,

  // ── Labels ────────────────────────────────────────────────
  addLabel,
  addChatLabel,
  removeChatLabel,
  addMessageLabel,
  removeMessageLabel,

  // ── App state & sync ──────────────────────────────────────
  resyncAppState,
  cleanDirtyBits,
  uploadPreKeys,
  uploadPreKeysIfRequired,
  upsertMessage,
  appPatch,

  // ── Group — extended ──────────────────────────────────────
  groupQuery,
  revokeGroupInvite,
  acceptGroupInvite,
  revokeGroupInviteV4,
  acceptGroupInviteV4,
  getGroupInviteInfo,
  groupToggleEphemeral,
  groupSettingUpdate,
  groupMemberAddMode,
  groupJoinApprovalMode,
  groupRequestParticipantsList,
  groupRequestParticipantsUpdate,
  groupFetchAllParticipating,

  // ── Newsletter (WA Channels) ──────────────────────────────
  subscribeNewsletterUpdates,
  newsletterReactionMode,
  newsletterUpdateDescription,
  newsletterUpdateName,
  newsletterUpdatePicture,
  newsletterRemovePicture,
  newsletterUnfollow,
  newsletterFollow,
  newsletterUnmute,
  newsletterMute,
  newsletterCreate,
  newsletterMetadata,
  newsletterAdminCount,
  newsletterChangeOwner,
  newsletterDemote,
  newsletterDelete,
  newsletterReactMessage,
  newsletterFetchMessages,
  newsletterFetchUpdates,

  // ── Calls ─────────────────────────────────────────────────
  rejectCall,
  offerCall,
  createCallLink,

  // ── Messaging — low level ─────────────────────────────────
  relayMessage,
  sendMessageRaw,
  sendReceipt,
  sendReceipts,
  sendMessageAck,
  sendRetryRequest,
  sendPeerDataOperationMessage,
  refreshMediaConn,
  waUploadToServer,
  getUSyncDevices,
  createParticipantNodes,
  executeUSyncQuery,
  sendWAMBuffer,

  // ── Message history ───────────────────────────────────────
  fetchMessageHistory,
  requestPlaceholderResend,

  // ── Commerce ──────────────────────────────────────────────
  getOrderDetails,
  getCatalog,
  getCollections,
  productCreate,
  productDelete,
  productUpdate,

  // ── Bot / USync ───────────────────────────────────────────
  getBotListV2,
  assertSessions,

  // ── Wait / connection utils ───────────────────────────────
  generateMessageTag,
  waitForMessage,
  waitForSocketOpen,
  waitForConnectionUpdate,

  // ── Low-level socket (advanced use only) ──────────────────
  sendRawMessage,
  sendNode,
  queryNode,
  endSocket,

  // ── Download queue control ──────────────────────────────
  prioritizeChat,         // call when user opens a chat → boosts media to P0
  setActiveChat,          // set current active JID without re-sorting queue
  getActiveChat,
  prefetchChatMedia,      // bulk-queue pending media for a chat
  getDlQueueStatus,       // debug: queue stats
  pauseDownloads,
  resumeDownloads,

  // Database exports
  getMessagesFromDB,
  searchMessagesInDB,
  getChatsFromDB,
  getContactsFromDB,
  searchContactsInDB,
  getDBStats,
  getSyncStatus,
}