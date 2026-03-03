"use strict"

// ════════════════════════════════════════════════════════════
// JID UTILS — single gate for ALL JIDs entering the system
// ════════════════════════════════════════════════════════════
// Import di file lain: const { normalizeJid, decodeJid, ... } = require('./parser/jid-utils')

// ── Module-level LID map ─────────────────────────────────────
// Set once via initLidMap(), auto-used by normalizeJid().
// Solusi "LID bocor" — tidak perlu pass lidMap manual ke setiap call.
let _globalLidMap = new Map()

/**
 * initLidMap — set global LID map dari Baileys contacts array.
 * WAJIB dipanggil saat handler contacts.upsert / contacts sync.
 *
 * @param {Array} contacts - Baileys contact objects
 */
function initLidMap(contacts) {
  _globalLidMap = buildLidMap(contacts)
}

/**
 * seedLidMap — directly merge a pre-built Map (e.g. loaded from lid_map.json on disk)
 * into the global lid map, without needing to re-parse contacts objects.
 * Call this in loadLidMapFromDisk() so normalizeJid resolves @lid from the first message.
 *
 * @param {Map} map — Map<lidUser|lidJid, realJid>
 */
function seedLidMap(map) {
  if (!map || !(map instanceof Map)) return
  for (const [k, v] of map) _globalLidMap.set(k, v)
}

/**
 * updateLidMap — tambah/update entries tanpa rebuild seluruh map.
 * Panggil di contacts.update event untuk incremental update.
 *
 * @param {Array} contacts - partial contacts array
 */
function updateLidMap(contacts) {
  if (!Array.isArray(contacts)) return
  const patch = buildLidMap(contacts)
  for (const [k, v] of patch) _globalLidMap.set(k, v)
}

// ── Internal base normalize (NO lid resolve — used by buildLidMap) ──────────
function _normalizeBase(jid) {
  if (!jid || typeof jid !== "string") return ""
  jid = jid.trim()
  const atIdx = jid.lastIndexOf("@")
  if (atIdx === -1) return jid
  let user   = jid.slice(0, atIdx)
  let server = jid.slice(atIdx + 1)
  const colonIdx = user.indexOf(":")
  if (colonIdx !== -1) user = user.slice(0, colonIdx)
  if (server === "c.us") server = "s.whatsapp.net"
  return `${user}@${server}`
}

/**
 * normalizeJid — canonical JID form used throughout DB and store.
 *
 * Handles every variant WhatsApp/Baileys can produce:
 *   @c.us        → @s.whatsapp.net   (legacy format from old history sync)
 *   :device      → stripped          (multi-device suffix, e.g. 628xxx:5@s.whatsapp.net)
 *   @lid         → resolved if in global map, else kept + warns
 *   @g.us        → kept as-is        (groups must not be changed)
 *   @newsletter  → kept as-is        (communities)
 *   null/""      → ""               (safe fallback)
 */
function normalizeJid(jid) {
  if (!jid || typeof jid !== "string") return ""

  jid = jid.trim()
  const atIdx = jid.lastIndexOf("@")
  if (atIdx === -1) return jid

  let user   = jid.slice(0, atIdx)
  let server = jid.slice(atIdx + 1)

  // Strip multi-device suffix (e.g. "6281234:5" → "6281234")
  const colonIdx = user.indexOf(":")
  if (colonIdx !== -1) user = user.slice(0, colonIdx)

  // Normalize legacy @c.us → @s.whatsapp.net
  if (server === "c.us") server = "s.whatsapp.net"

  const cleaned = `${user}@${server}`

  // @lid — attempt resolve via global map
  // If NOT resolved → return as-is (will be fixed later by resolveLidInDB).
  // We intentionally do NOT warn here — @lid JIDs arrive before contacts.set
  // fires during every session start, producing thousands of useless log lines.
  if (server === "lid") {
    const resolved = _globalLidMap.get(user) || _globalLidMap.get(cleaned)
    return resolved || cleaned
  }

  return cleaned
}

/**
 * decodeJid — alias normalizeJid, compatible dengan smsg pattern / Baileys dims.decodeJid().
 */
function decodeJid(jid) {
  return normalizeJid(jid)
}

// ── LID helpers ──────────────────────────────────────────────

function isLidJid(jid) {
  return typeof jid === "string" && jid.endsWith("@lid")
}

/**
 * resolveLid — resolve @lid → real @s.whatsapp.net JID.
 * Checks global map first, then optional override map.
 *
 * @param {string} lidJid
 * @param {Map}    [lidMapOverride]
 * @returns {string}
 */
function resolveLid(lidJid, lidMapOverride) {
  if (!lidJid) return ""
  if (!isLidJid(lidJid)) return lidJid

  const user = lidJid.split("@")[0]

  const fromGlobal = _globalLidMap.get(user) || _globalLidMap.get(lidJid)
  if (fromGlobal) return fromGlobal

  if (lidMapOverride) {
    const fromOverride = lidMapOverride.get(user) || lidMapOverride.get(lidJid)
    if (fromOverride) return fromOverride
  }

  return lidJid
}

/**
 * tryResolveLid — resolve @lid if possible, no-op otherwise.
 * Safe to call on any JID regardless of type.
 */
function tryResolveLid(jid, lidMapOverride) {
  if (!isLidJid(jid)) return jid
  return resolveLid(jid, lidMapOverride)
}

/**
 * buildLidMap — build a lid → real JID lookup map from Baileys contacts array.
 *
 * @param {Array} contacts - Array of Baileys contact objects
 * @returns {Map<string, string>}
 */
function buildLidMap(contacts) {
  const map = new Map()
  if (!Array.isArray(contacts)) return map

  for (const c of contacts) {
    if (!c.id) continue
    const realJid = _normalizeBase(c.id)
    if (!realJid) continue

    // Skip if c.id itself is a @lid — that means Baileys doesn't know the real phone
    // for this contact yet. We can only map when c.id is a real @s.whatsapp.net JID.
    const realServer = realJid.split("@")[1]
    if (realServer === "lid") continue

    if (c.lid) {
      const lidJid  = _normalizeBase(c.lid)
      const lidUser = lidJid.split("@")[0]
      if (lidUser) {
        // Standard: @lid JID → real JID
        map.set(lidUser, realJid)
        map.set(`${lidUser}@lid`, realJid)

        // [FIX-LID-PROMOTE] Also map lid-number@s.whatsapp.net → realJid.
        // When resolveLidRows runs BEFORE contacts.set (race), it renames
        // the chat row from lidUser@lid → lidUser@s.whatsapp.net using the
        // lid number as the "user" part. This produces fake JIDs like
        // 273517190848685@s.whatsapp.net. After contacts.set we can fix them.
        map.set(`${lidUser}@s.whatsapp.net`, realJid)
      }
    }

    const phone = realJid.split("@")[0]
    if (phone && /^\d+$/.test(phone)) {
      map.set(`phone:${phone}`, realJid)
    }
  }
  return map
}

// ── Display helpers ───────────────────────────────────────────

/**
 * formatJidAsPhone — human-readable phone number from JID.
 * Returns null for groups/newsletters.
 */
function formatJidAsPhone(jid) {
  if (!jid) return null
  const n = normalizeJid(jid)
  const atIdx = n.indexOf("@")
  if (atIdx === -1) return null
  const user   = n.slice(0, atIdx)
  const server = n.slice(atIdx + 1)

  if (server === "g.us" || server === "newsletter") return null
  if (server === "lid") return `+${user} (unresolved)`
  if (/^\d+$/.test(user)) return `+${user}`
  return user
}

/**
 * getJidDisplayPhone — alias formatJidAsPhone, returns "" instead of null.
 */
function getJidDisplayPhone(jid) {
  return formatJidAsPhone(jid) ?? ""
}

module.exports = {
  // Init (WAJIB di contacts.upsert handler)
  initLidMap,
  updateLidMap,
  seedLidMap,   // [FIX] seed from disk-loaded Map directly

  // Core
  normalizeJid,
  decodeJid,

  // LID
  isLidJid,
  resolveLid,
  tryResolveLid,
  buildLidMap,

  // Display
  formatJidAsPhone,
  getJidDisplayPhone,
}
