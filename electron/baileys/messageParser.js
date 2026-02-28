// electron/baileys/messageParser.js
// ═══════════════════════════════════════════════════════════════════════════
// WaPlus-dev — Universal Message Parser
//
// Terinspirasi dari smsg() di bot WA (index.js/case.js),
// diadaptasi untuk Electron desktop app dengan SQLite storage.
//
// Tugas utama:
//   - Normalisasi semua tipe pesan Baileys → format flat untuk DB & renderer
//   - Extract body text dari semua varian pesan
//   - Parse quoted/reply message
//   - Extract mention, poll options, reactions, dll
//   - Tentukan msgType yang konsisten
// ═══════════════════════════════════════════════════════════════════════════

"use strict"

const { getContentType, jidNormalizedUser, isJidGroup } = require("baileys")

// ════════════════════════════════════════════════════════════
// JID NORMALIZATION — single gate for ALL JIDs entering the system
// ════════════════════════════════════════════════════════════

/**
 * normalizeJid — canonical JID form used throughout DB and store.
 *
 * Handles every variant WhatsApp/Baileys can produce:
 *   @c.us        → @s.whatsapp.net   (legacy format from old history sync)
 *   :device      → stripped           (multi-device suffix, e.g. 628xxx:5@s.whatsapp.net)
 *   @lid         → kept as-is        (WhatsApp new Linked Identity — DO NOT convert here,
 *                                     use resolveLid() with a contacts map instead)
 *   @g.us        → kept as-is        (groups must not be changed)
 *   @newsletter  → kept as-is        (communities)
 *   null/""      → ""                (safe fallback)
 *
 * This function MUST be called on every JID before it touches the DB.
 * One normalization gate = zero split-chat bugs.
 */
function normalizeJid(jid) {
  if (!jid || typeof jid !== "string") return ""

  // Split into user part and server part
  const atIdx = jid.lastIndexOf("@")
  if (atIdx === -1) return jid // no @ — return as-is (shouldn't happen)

  let user   = jid.slice(0, atIdx)
  let server = jid.slice(atIdx + 1)

  // 1. Strip multi-device suffix from user part (e.g. "6281234:5" → "6281234")
  const colonIdx = user.indexOf(":")
  if (colonIdx !== -1) user = user.slice(0, colonIdx)

  // 2. Normalize legacy @c.us → @s.whatsapp.net
  if (server === "c.us") server = "s.whatsapp.net"

  // 3. @lid stays as-is — use resolveLid() to get real JID when contacts map available
  return `${user}@${server}`
}

/**
 * isLidJid — returns true if this is a WhatsApp Linked Identity JID.
 * @lid JIDs are used by WA for privacy — they map to real phone JIDs
 * only via the contacts/lid store Baileys provides.
 */
function isLidJid(jid) {
  return typeof jid === "string" && jid.endsWith("@lid")
}

/**
 * resolveLid — try to resolve a @lid JID to a real @s.whatsapp.net JID.
 *
 * @param {string} lidJid   - e.g. "12345678901234567@lid"
 * @param {object} lidMap   - Map<lid_user_string, real_jid_string> built from
 *                            Baileys contacts where contact.lid is present.
 *                            Pass null / undefined to skip resolution.
 * @returns {string}        - Resolved JID or original lidJid if not found.
 */
function resolveLid(lidJid, lidMap) {
  if (!lidJid || !lidMap) return lidJid || ""
  const user = lidJid.split("@")[0]
  // Try multiple key forms: numeric user part, full @lid JID
  return lidMap.get(user) || lidMap.get(lidJid) || lidJid
}

/**
 * tryResolveLid — resolve @lid if possible, return original if not in map.
 * Safe no-op when lidMap is empty or doesn't contain this JID.
 */
function tryResolveLid(jid, lidMap) {
  if (!isLidJid(jid)) return jid
  if (!lidMap || lidMap.size === 0) return jid
  const resolved = resolveLid(jid, lidMap)
  return resolved !== jid ? resolved : jid
}

/**
 * buildLidMap — build a lid → real JID lookup map from Baileys contacts array.
 *
 * Baileys contacts can have a `lid` field: { id: "628xxx@s.whatsapp.net", lid: "123@lid" }
 * We build a reverse map so we can resolve @lid → @s.whatsapp.net at parse time.
 *
 * Call this once when contacts are received and pass the result as `opts.lidMap`
 * to parseMessage().
 *
 * @param {Array} contacts - Array of Baileys contact objects
 * @returns {Map<string, string>} lid_user → real_jid
 */
function buildLidMap(contacts) {
  const map = new Map()
  if (!Array.isArray(contacts)) return map
  for (const c of contacts) {
    if (!c.id) continue
    const realJid = normalizeJid(c.id)
    if (!realJid) continue

    if (c.lid) {
      const lid = c.lid.split("@")[0]
      if (lid) {
        map.set(lid, realJid)
        map.set(c.lid, realJid) // also map full JID form
      }
    }

    // Also map phone number → realJid as secondary lookup key
    // so contacts arriving without .lid but with phone can be cross-matched
    const phone = realJid.split("@")[0]
    if (phone && /^\d+$/.test(phone)) {
      map.set(`phone:${phone}`, realJid)
    }
  }
  return map
}

/**
 * formatJidAsPhone — convert a JID or @lid to a human-readable phone number.
 *
 * Examples:
 *   "6281234567890@s.whatsapp.net" → "+62 812-3456-7890"
 *   "628xxx@lid"                   → "+628xxx (lid)"   ← fallback when unresolved
 *   "120363xxx@g.us"               → null              ← groups: return null
 */
function formatJidAsPhone(jid) {
  if (!jid) return null
  const [user, server] = jid.split("@")
  if (!user) return null
  if (server === "g.us" || server === "newsletter") return null // groups/newsletters

  // If still @lid and unresolved, show something readable
  if (server === "lid") return `+${user}`

  // Pure digits → format as phone with leading +
  if (/^\d+$/.test(user)) return `+${user}`

  return user
}

// normalizeJid is exported at the bottom with all other exports

// ════════════════════════════════════════════════════════════
// TYPE DETECTION
// ════════════════════════════════════════════════════════════

/**
 * Dapatkan tipe konten utama dari WAMessage.
 * Menangani wrapper: ephemeral, viewOnce, documentWithCaption, dll.
 */
function getRealContentType(message) {
  if (!message) return null

  // Unwrap ephemeral
  if (message.ephemeralMessage?.message) {
    return getRealContentType(message.ephemeralMessage.message)
  }

  // Unwrap viewOnce v1
  if (message.viewOnceMessage?.message) {
    const inner = message.viewOnceMessage.message
    const t = getContentType(inner)
    return t ? `viewOnceMessage:${t}` : "viewOnceMessage"
  }

  // Unwrap viewOnce v2
  if (message.viewOnceMessageV2?.message) {
    const inner = message.viewOnceMessageV2.message
    const t = getContentType(inner)
    return t ? `viewOnceMessageV2:${t}` : "viewOnceMessageV2"
  }

  // Unwrap documentWithCaption → treat as documentMessage
  if (message.documentWithCaptionMessage?.message?.documentMessage) {
    return "documentMessage"
  }

  // Unwrap highlyStructuredMessage (template)
  if (message.highlyStructuredMessage) return "templateMessage"

  // Unwrap interactiveResponseMessage
  if (message.interactiveResponseMessage) return "interactiveResponseMessage"

  // Normal content type
  return getContentType(message) || null
}

/**
 * Normalize type ke canonical msgType yang disimpan di DB.
 * Menghapus wrapper prefix (ephemeral:, viewOnce:, dll)
 */
function normalizeMsgType(rawType) {
  if (!rawType) return "unknown"

  // Handle viewOnce wrappers → simpan inner type tapi tandai sebagai viewOnce
  if (rawType.startsWith("viewOnceMessage:")) {
    return "viewOnceMessage"
  }
  if (rawType.startsWith("viewOnceMessageV2:")) {
    return "viewOnceMessageV2"
  }

  // Mapping alias → canonical
  const aliases = {
    "conversation": "conversation",
    "extendedTextMessage": "extendedTextMessage",
    "imageMessage": "imageMessage",
    "videoMessage": "videoMessage",
    "audioMessage": "audioMessage",
    "pttMessage": "pttMessage",                // voice note (PTT)
    "documentMessage": "documentMessage",
    "documentWithCaptionMessage": "documentMessage",
    "stickerMessage": "stickerMessage",
    "locationMessage": "locationMessage",
    "liveLocationMessage": "liveLocationMessage",
    "contactMessage": "contactMessage",
    "contactsArrayMessage": "contactsArrayMessage",
    "pollCreationMessage": "pollCreationMessage",
    "pollCreationMessageV2": "pollCreationMessage",
    "pollCreationMessageV3": "pollCreationMessage",
    "pollUpdateMessage": "pollUpdateMessage",
    "reactionMessage": "reactionMessage",
    "groupInviteMessage": "groupInviteMessage",
    "buttonsMessage": "buttonsMessage",
    "buttonsResponseMessage": "buttonsResponseMessage",
    "listMessage": "listMessage",
    "listResponseMessage": "listResponseMessage",
    "templateMessage": "templateMessage",
    "templateButtonReplyMessage": "templateButtonReplyMessage",
    "interactiveMessage": "interactiveMessage",
    "interactiveResponseMessage": "interactiveResponseMessage",
    "orderMessage": "orderMessage",
    "productMessage": "productMessage",
    "paymentMessage": "paymentMessage",
    "requestPaymentMessage": "requestPaymentMessage",
    "sendPaymentMessage": "sendPaymentMessage",
    "declinePaymentRequestMessage": "paymentMessage",
    "cancelPaymentRequestMessage": "paymentMessage",
    "callLogMessage": "callLogMessage",
    "scheduledCallCreationMessage": "scheduledCallCreationMessage",
    "scheduledCallEditMessage": "scheduledCallEditMessage",
    "eventMessage": "eventMessage",
    "keepInChatMessage": "keepInChatMessage",
    "pinInChatMessage": "pinInChatMessage",
    "newsletterAdminInviteMessage": "newsletterAdminInviteMessage",
    "protocolMessage": "protocol",
    "messageContextInfo": "messageContextInfo",
    "ephemeralMessage": "ephemeral",
    "viewOnceMessage": "viewOnceMessage",
    "viewOnceMessageV2": "viewOnceMessageV2",

    // ── Proto types tambahan dari WAProto.proto ────────────────────────────
    // Album (multiple images/videos in one message)
    "albumMessage": "albumMessage",

    // Encrypted comment (e.g. status replies, broadcast)
    "encCommentMessage": "encCommentMessage",

    // Status mention (when someone mentions you in their Status)
    "statusMentionMessage": "statusMentionMessage",

    // Group mentioned message (system message when group is tagged)
    "groupMentionedMessage": "groupMentionedMessage",

    // Business call (bcall = business/VOIP call message)
    "bcallMessage": "bcallMessage",

    // Placeholder — proto-level placeholder for unsupported future types
    "placeholderMessage": "placeholderMessage",

    // Encrypted event update (edit to a WA Event)
    "encEventUpdateMessage": "encEventUpdateMessage",

    // Bot invoke (AI/bot interactions inside WA)
    "botInvokeMessage": "botInvokeMessage",

    // Encrypted reaction (reaction with additional privacy layer)
    "encReactionMessage": "encReactionMessage",

    // Message history bundle (synced history chunk)
    "messageHistoryBundle": "messageHistoryBundle",

    // Product catalog + invoice
    "invoiceMessage": "invoiceMessage",
    "productCatalogMessage": "productCatalogMessage",

    // Payment invite (merchant payment link)
    "paymentInviteMessage": "paymentInviteMessage",

    // Request to join a call
    "callToAction": "callToAction",

    // Native flow (for interactive native flows like OTP, forms)
    "nativeFlowMessage": "nativeFlowMessage",
  }

  return aliases[rawType] || rawType
}

// ════════════════════════════════════════════════════════════
// BODY EXTRACTION
// ════════════════════════════════════════════════════════════

/**
 * Extract teks body dari semua tipe pesan.
 * Terinspirasi dari body parser di case.js (baris 65) + extractBody di client.js
 */
function extractBody(message, msgType) {
  if (!message) return ""

  // Unwrap layers dulu
  const m = message.ephemeralMessage?.message
    || message.viewOnceMessage?.message
    || message.viewOnceMessageV2?.message
    || message.documentWithCaptionMessage?.message
    || message

  switch (msgType) {
    // ── Text ──────────────────────────────────────────────
    case "conversation":
      return m.conversation || ""

    case "extendedTextMessage":
      return m.extendedTextMessage?.text || ""

    // ── Media dengan caption ───────────────────────────────
    case "imageMessage":
      return m.imageMessage?.caption || ""

    case "videoMessage":
      return m.videoMessage?.caption || ""

    case "documentMessage":
      return (
        m.documentWithCaptionMessage?.message?.documentMessage?.caption ||
        m.documentMessage?.caption ||
        m.documentMessage?.fileName ||
        ""
      )

    case "audioMessage":
      return m.audioMessage?.caption || ""

    case "stickerMessage":
      return "" // stiker tidak punya teks

    // ── Location ───────────────────────────────────────────
    case "locationMessage":
      return m.locationMessage?.name
        || m.locationMessage?.address
        || `${m.locationMessage?.degreesLatitude ?? ""},${m.locationMessage?.degreesLongitude ?? ""}`

    case "liveLocationMessage":
      return m.liveLocationMessage?.caption
        || m.liveLocationMessage?.name
        || "Live Location"

    // ── Contact ────────────────────────────────────────────
    case "contactMessage":
      return m.contactMessage?.displayName || ""

    case "contactsArrayMessage": {
      const names = (m.contactsArrayMessage?.contacts || [])
        .map(c => c.displayName)
        .filter(Boolean)
      return names.join(", ")
    }

    // ── Poll ───────────────────────────────────────────────
    case "pollCreationMessage":
      return (
        m.pollCreationMessageV3?.name ||
        m.pollCreationMessageV2?.name ||
        m.pollCreationMessage?.name ||
        ""
      )

    case "pollUpdateMessage":
      return "" // update poll tidak punya teks

    // ── Reaction ───────────────────────────────────────────
    case "reactionMessage":
      return m.reactionMessage?.text || ""

    // ── Group invite ───────────────────────────────────────
    case "groupInviteMessage":
      return m.groupInviteMessage?.groupName || m.groupInviteMessage?.caption || ""

    // ── Buttons (legacy) ──────────────────────────────────
    case "buttonsMessage":
      return m.buttonsMessage?.contentText || m.buttonsMessage?.text || ""

    case "buttonsResponseMessage":
      return (
        m.buttonsResponseMessage?.selectedButtonId ||
        m.buttonsResponseMessage?.selectedDisplayText ||
        ""
      )

    // ── List (legacy) ──────────────────────────────────────
    case "listMessage":
      return m.listMessage?.description || m.listMessage?.title || ""

    case "listResponseMessage":
      return (
        m.listResponseMessage?.singleSelectReply?.selectedRowId ||
        m.listResponseMessage?.title ||
        ""
      )

    // ── Template (legacy) ─────────────────────────────────
    case "templateMessage":
      return (
        m.templateMessage?.hydratedTemplate?.hydratedContentText ||
        m.templateMessage?.hydratedFourRowTemplate?.hydratedContentText ||
        ""
      )

    case "templateButtonReplyMessage":
      return (
        m.templateButtonReplyMessage?.selectedId ||
        m.templateButtonReplyMessage?.selectedDisplayText ||
        ""
      )

    // ── Interactive (new buttons/list) ─────────────────────
    case "interactiveMessage":
      return (
        m.interactiveMessage?.body?.text ||
        m.interactiveMessage?.header?.title ||
        ""
      )

    case "interactiveResponseMessage": {
      try {
        const params = JSON.parse(
          m.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson || "{}"
        )
        return params.id || params.title || ""
      } catch {
        return ""
      }
    }

    // ── Commerce ───────────────────────────────────────────
    case "orderMessage":
      return m.orderMessage?.message || `Order (${m.orderMessage?.itemCount ?? 0} items)`

    case "productMessage":
      return m.productMessage?.product?.title || "Produk"

    case "paymentMessage":
    case "requestPaymentMessage":
      return m.requestPaymentMessage?.noteMessage?.extendedTextMessage?.text
        || m.sendPaymentMessage?.noteMessage?.extendedTextMessage?.text
        || "Pembayaran"

    // ── ViewOnce ───────────────────────────────────────────
    case "viewOnceMessage":
    case "viewOnceMessageV2": {
      const inner = m.viewOnceMessage?.message || m.viewOnceMessageV2?.message
      if (!inner) return ""
      const innerType = getContentType(inner)
      if (innerType === "imageMessage") return inner.imageMessage?.caption || ""
      if (innerType === "videoMessage") return inner.videoMessage?.caption || ""
      return ""
    }

    // ── Call log ───────────────────────────────────────────
    case "callLogMessage": {
      const cl = m.callLogMessage
      if (!cl) return "Panggilan"
      const kind = cl.isVideo ? "Video" : "Suara"
      const outcome = cl.callOutcome
      // callOutcome: 1=answered, 2=missed, 4=declined, 8=failed
      if (outcome === 2) return `Panggilan ${kind} Tak Terjawab`
      if (outcome === 4) return `Panggilan ${kind} Ditolak`
      if (cl.durationSecs) {
        const m_ = Math.floor(cl.durationSecs / 60)
        const s_ = cl.durationSecs % 60
        const dur = m_ > 0 ? `${m_}m ${s_}d` : `${s_}d`
        return `Panggilan ${kind} (${dur})`
      }
      return `Panggilan ${kind}`
    }

    // ── Scheduled call ─────────────────────────────────────
    case "scheduledCallCreationMessage": {
      const sc = m.scheduledCallCreationMessage
      if (!sc) return "Jadwal Panggilan"
      const title = sc.title || sc.scheduledTimestamp
        ? `"${sc.title}" `
        : ""
      return `Jadwal Panggilan ${title}dibuat`
    }

    case "scheduledCallEditMessage":
      return m.scheduledCallEditMessage?.title
        ? `Jadwal Panggilan "${m.scheduledCallEditMessage.title}" diubah`
        : "Jadwal Panggilan diubah"

    // ── Event ──────────────────────────────────────────────
    case "eventMessage": {
      const ev = m.eventMessage?.event || m.eventMessage
      if (!ev) return "Acara"
      const parts = [ev.name || "Acara"]
      if (ev.startTime) {
        const d = new Date(Number(ev.startTime) * 1000)
        parts.push(d.toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" }))
      }
      if (ev.location?.name) parts.push(`📍 ${ev.location.name}`)
      return parts.join(" · ")
    }

    // ── Encrypted event update ─────────────────────────────
    case "encEventUpdateMessage":
      return m.encEventUpdateMessage?.description || "Acara diperbarui"

    // ── Pin in chat ────────────────────────────────────────
    case "pinInChatMessage": {
      const pin = m.pinInChatMessage
      if (!pin) return "Pesan disematkan"
      return pin.type === 1 ? "Pesan disematkan" : "Pesan dilepas sematan"
    }

    // ── Keep in chat ───────────────────────────────────────
    case "keepInChatMessage": {
      const keep = m.keepInChatMessage
      if (!keep) return "Pesan disimpan"
      return keep.keepType === 1 ? "Pesan disimpan" : "Pesan tidak disimpan"
    }

    // ── Newsletter ─────────────────────────────────────────
    case "newsletterAdminInviteMessage":
      return m.newsletterAdminInviteMessage?.newsletterName || "Undangan Newsletter"

    // ── Album (multiple media in one bubble) ───────────────
    case "albumMessage": {
      const album = m.albumMessage
      const count = album?.expectedImageCount || album?.expectedVideoCount || 0
      const hasVid = (album?.expectedVideoCount || 0) > 0
      if (count === 0) return "Album"
      return hasVid ? `Album (${count} media)` : `Album (${count} foto)`
    }

    // ── Encrypted comment (status reply) ───────────────────
    case "encCommentMessage":
      return m.encCommentMessage?.text || "Komentar"

    // ── Status mention ─────────────────────────────────────
    case "statusMentionMessage": {
      const sm = m.statusMentionMessage
      const count = sm?.message?.length || 0
      return count > 0 ? "Menyebut status Anda" : "Status"
    }

    // ── Group mentioned ────────────────────────────────────
    case "groupMentionedMessage":
      return m.groupMentionedMessage?.text || "Grup disebutkan"

    // ── Business call ──────────────────────────────────────
    case "bcallMessage": {
      const bc = m.bcallMessage
      return bc?.isVideo ? "Panggilan Video Bisnis" : "Panggilan Bisnis"
    }

    // ── Placeholder (unsupported msg type from newer WA) ───
    case "placeholderMessage":
      return m.placeholderMessage?.type != null
        ? "Pesan tidak didukung"
        : "Pesan tidak tersedia"

    // ── Bot invoke ─────────────────────────────────────────
    case "botInvokeMessage":
      return m.botInvokeMessage?.message?.conversation
        || m.botInvokeMessage?.message?.extendedTextMessage?.text
        || "Bot"

    // ── Encrypted reaction ─────────────────────────────────
    case "encReactionMessage":
      return m.encReactionMessage?.encPayload
        ? "Reaksi" // encrypted, can't decode without keys
        : ""

    // ── Invoice / product catalog ──────────────────────────
    case "invoiceMessage": {
      const inv = m.invoiceMessage
      return inv?.title || inv?.description || "Invoice"
    }

    case "productCatalogMessage": {
      const pc = m.productCatalogMessage
      return pc?.product?.title || pc?.product?.description || "Katalog Produk"
    }

    // ── Payment invite ─────────────────────────────────────
    case "paymentInviteMessage": {
      const pi = m.paymentInviteMessage
      return pi?.serviceType != null ? "Tautan Pembayaran" : "Undangan Pembayaran"
    }

    // ── Native flow (interactive form/OTP/etc) ─────────────
    case "nativeFlowMessage": {
      const nf = m.nativeFlowMessage || m.interactiveMessage?.nativeFlowMessage
      return nf?.name || nf?.buttonParamsJson
        ? "Formulir Interaktif"
        : ""
    }

    default:
      // Fallback: coba ambil dari conversation atau text fields yang umum
      return (
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.caption ||
        ""
      )
  }
}

// ════════════════════════════════════════════════════════════
// MEDIA INFO EXTRACTION
// ════════════════════════════════════════════════════════════

const MEDIA_TYPES = new Set([
  "imageMessage", "videoMessage", "audioMessage", "pttMessage",
  "documentMessage", "stickerMessage",
  "viewOnceMessage", "viewOnceMessageV2",
])

function hasMediaContent(msgType) {
  return MEDIA_TYPES.has(msgType)
}

/**
 * Extract info media: mimetype, fileSize, duration, url, dll
 */
function extractMediaInfo(message, msgType) {
  if (!message) return null
  if (!hasMediaContent(msgType)) return null

  const m = message.ephemeralMessage?.message
    || message.viewOnceMessage?.message
    || message.viewOnceMessageV2?.message
    || message.documentWithCaptionMessage?.message
    || message

  let mediaObj = null
  let actualType = msgType

  switch (msgType) {
    case "imageMessage":
      mediaObj = m.imageMessage
      break
    case "videoMessage":
      mediaObj = m.videoMessage
      break
    case "audioMessage":
      mediaObj = m.audioMessage
      actualType = m.audioMessage?.ptt ? "pttMessage" : "audioMessage"
      break
    case "pttMessage":
      mediaObj = m.audioMessage || m.pttMessage
      actualType = "pttMessage"
      break
    case "documentMessage":
      mediaObj = m.documentWithCaptionMessage?.message?.documentMessage || m.documentMessage
      break
    case "stickerMessage":
      mediaObj = m.stickerMessage
      break
    case "viewOnceMessage": {
      const inner = m.viewOnceMessage?.message
      if (!inner) return null
      const t = getContentType(inner)
      mediaObj = inner[t]
      actualType = `viewOnce_${t}` // misal: viewOnce_imageMessage
      break
    }
    case "viewOnceMessageV2": {
      const inner = m.viewOnceMessageV2?.message
      if (!inner) return null
      const t = getContentType(inner)
      mediaObj = inner[t]
      actualType = `viewOnce_${t}`
      break
    }
    default:
      return null
  }

  if (!mediaObj) return null

  return {
    actualType,
    mimetype: mediaObj.mimetype || null,
    fileSize: mediaObj.fileLength ? Number(mediaObj.fileLength) : null,
    duration: mediaObj.seconds || mediaObj.duration || null,
    fileName: mediaObj.fileName || null,
    width: mediaObj.width || null,
    height: mediaObj.height || null,
    // URL dari WA CDN (sementara, bisa expired)
    url: mediaObj.url || null,
    // Direct path tidak ada — akan diisi setelah download
    mediaKey: mediaObj.mediaKey ? Buffer.from(mediaObj.mediaKey).toString("base64") : null,
    isAnimated: mediaObj.isAnimated || false,
    isPtt: actualType === "pttMessage",
    isGif: msgType === "videoMessage" && (mediaObj.gifPlayback === true),
    isViewOnce: msgType === "viewOnceMessage" || msgType === "viewOnceMessageV2",
  }
}

// ════════════════════════════════════════════════════════════
// QUOTED MESSAGE PARSER
// ════════════════════════════════════════════════════════════

/**
 * Extract quoted/reply message dari contextInfo.
 * Terinspirasi dari pattern quoted di case.js (baris 74-75).
 *
 * @param {object} message  - Raw WA message object
 * @param {string} msgType  - Normalized message type
 * @param {Map}    lidMap   - Optional lid → real JID map for resolving @lid senders
 */
function extractQuoted(message, msgType, lidMap) {
  if (!message) return null

  const m = message.ephemeralMessage?.message
    || message.viewOnceMessage?.message
    || message
  
  // Cari contextInfo di berbagai lokasi tergantung tipe
  let contextInfo = null

  const msgTypeKey = msgType === "conversation" ? null : `${msgType}` 
  
  if (m.extendedTextMessage?.contextInfo) {
    contextInfo = m.extendedTextMessage.contextInfo
  } else if (msgTypeKey && m[msgTypeKey]?.contextInfo) {
    contextInfo = m[msgTypeKey].contextInfo
  } else {
    // Fallback: coba semua kemungkinan
    for (const key of Object.keys(m)) {
      if (m[key]?.contextInfo) {
        contextInfo = m[key].contextInfo
        break
      }
    }
  }

  if (!contextInfo?.quotedMessage) return null

  const qMsg = contextInfo.quotedMessage
  const qType = getRealContentType(qMsg)
  const qMsgTypeNorm = normalizeMsgType(qType)
  const qBody = extractBody(qMsg, qMsgTypeNorm)

  // Sender quoted — normalize JID and resolve @lid
  let qSender = contextInfo.participant
    || contextInfo.remoteJid
    || null

  if (qSender) {
    qSender = normalizeJid(qSender)
    // Resolve @lid → real @s.whatsapp.net JID using lidMap
    if (isLidJid(qSender) && lidMap) {
      qSender = resolveLid(qSender, lidMap)
    }
  }

  return {
    id: contextInfo.stanzaId || null,
    sender: qSender,
    body: qBody,
    msgType: qMsgTypeNorm,
    // Info tambahan untuk bubble preview
    hasMedia: hasMediaContent(qMsgTypeNorm),
    mimetype: qMsg[qType]?.mimetype || null,
    // Mention di dalam quoted
    mentionedJid: contextInfo.mentionedJid || [],
  }
}

// ════════════════════════════════════════════════════════════
// MENTION EXTRACTION
// ════════════════════════════════════════════════════════════

/**
 * Extract semua mention (@nomor) dari pesan.
 * Dari case.js pattern mentionUser (baris 104).
 */
function extractMentions(message, msgType) {
  if (!message) return []

  const m = message.ephemeralMessage?.message || message

  let mentions = []

  // Dari contextInfo.mentionedJid
  const tryExtractFromKey = (obj) => {
    if (!obj) return
    if (obj.contextInfo?.mentionedJid?.length) {
      mentions.push(...obj.contextInfo.mentionedJid)
    }
  }

  tryExtractFromKey(m.extendedTextMessage)
  tryExtractFromKey(m.imageMessage)
  tryExtractFromKey(m.videoMessage)
  tryExtractFromKey(m.documentMessage)
  tryExtractFromKey(m.audioMessage)
  tryExtractFromKey(m.buttonsMessage)
  tryExtractFromKey(m.listMessage)
  tryExtractFromKey(m.interactiveMessage)

  return [...new Set(mentions)]
}

// ════════════════════════════════════════════════════════════
// POLL OPTIONS PARSER
// ════════════════════════════════════════════════════════════

/**
 * Extract opsi poll dari pollCreationMessage.
 */
function extractPollOptions(message) {
  if (!message) return []

  const pm = message.pollCreationMessageV3
    || message.pollCreationMessageV2
    || message.pollCreationMessage

  if (!pm?.options) return []

  return pm.options.map((opt, idx) => ({
    idx,
    name: opt.optionName || opt.name || `Opsi ${idx + 1}`,
    votes: 0, // akan diupdate dari pollUpdateMessage
  }))
}

// ════════════════════════════════════════════════════════════
// LOCATION PARSER
// ════════════════════════════════════════════════════════════

function extractLocation(message, msgType) {
  if (msgType !== "locationMessage" && msgType !== "liveLocationMessage") return null

  const loc = message.locationMessage || message.liveLocationMessage
  if (!loc) return null

  return {
    lat: loc.degreesLatitude || null,
    lng: loc.degreesLongitude || null,
    name: loc.name || null,
    address: loc.address || null,
    url: loc.url || null,
    accuracy: loc.accuracyInMeters || null,
    isLive: msgType === "liveLocationMessage",
    speed: loc.speedInMps || null,
  }
}

// ════════════════════════════════════════════════════════════
// CONTACT VCARD PARSER
// ════════════════════════════════════════════════════════════

function extractContacts(message, msgType) {
  if (msgType === "contactMessage") {
    const c = message.contactMessage
    return [{
      displayName: c?.displayName || "",
      vcard: c?.vcard || "",
    }]
  }
  if (msgType === "contactsArrayMessage") {
    return (message.contactsArrayMessage?.contacts || []).map(c => ({
      displayName: c.displayName || "",
      vcard: c.vcard || "",
    }))
  }
  return []
}

// ════════════════════════════════════════════════════════════
// REACTION PARSER
// ════════════════════════════════════════════════════════════

function extractReaction(message) {
  const r = message.reactionMessage
  if (!r) return null
  return {
    text: r.text || "",          // emoji, atau "" jika unreact
    targetId: r.key?.id || null, // ID pesan yang direact
    isRemove: !r.text,
  }
}

// ════════════════════════════════════════════════════════════
// EVENT PARSER (WAProto: EventMessage)
// ════════════════════════════════════════════════════════════

/**
 * Extract WA Event details.
 * EventMessage fields: name, description, startTime, endTime, location,
 * joinLink, isCanceled, editToken, extraGuestListJid
 */
function extractEvent(message, msgType) {
  if (msgType !== "eventMessage") return null
  const ev = message.eventMessage?.event || message.eventMessage
  if (!ev) return null

  return {
    name:        ev.name        || null,
    description: ev.description || null,
    start_time:  ev.startTime   ? Number(ev.startTime)  : null,
    end_time:    ev.endTime     ? Number(ev.endTime)    : null,
    location_name:    ev.location?.name    || null,
    location_address: ev.location?.address || null,
    location_lat:     ev.location?.degreesLatitude  || null,
    location_lng:     ev.location?.degreesLongitude || null,
    join_link:   ev.joinLink    || null,
    is_canceled: ev.isCanceled  ? 1 : 0,
  }
}

// ════════════════════════════════════════════════════════════
// CALL LOG PARSER (WAProto: CallLogMessage)
// ════════════════════════════════════════════════════════════

/**
 * Extract call log metadata.
 * CallLogMessage fields: isVideo, callResult/callOutcome, durationSecs,
 * participants (repeated CallParticipant { jid, callResult })
 * callOutcome enum: CONNECTED(1), MISSED(2), DECLINED(4), FAILED(8)
 */
function extractCallLog(message, msgType) {
  if (msgType !== "callLogMessage") return null
  const cl = message.callLogMessage
  if (!cl) return null

  const OUTCOMES = { 1: "answered", 2: "missed", 4: "declined", 8: "failed" }

  return {
    is_video:     cl.isVideo     ? 1 : 0,
    outcome:      OUTCOMES[cl.callOutcome] || OUTCOMES[cl.callResult] || "unknown",
    duration_secs: cl.durationSecs || null,
    // Participants array — store JIDs of who was on the call
    participants: (cl.participants || [])
      .map(p => p.jid || p)
      .filter(Boolean),
  }
}

// ════════════════════════════════════════════════════════════
// GROUP INVITE PARSER (WAProto: GroupInviteMessage)
// ════════════════════════════════════════════════════════════

/**
 * Extract group invite details.
 * GroupInviteMessage fields: groupJid, inviteCode, inviteExpiration,
 * groupName, caption, groupType (DEFAULT/PARENT)
 */
function extractGroupInvite(message, msgType) {
  if (msgType !== "groupInviteMessage") return null
  const gi = message.groupInviteMessage
  if (!gi) return null

  return {
    group_jid:   gi.groupJid   || null,
    group_name:  gi.groupName  || null,
    invite_code: gi.inviteCode || null,
    // inviteExpiration is a Long — convert to unix timestamp
    invite_expiry: gi.inviteExpiration
      ? Number(gi.inviteExpiration)
      : null,
    caption:    gi.caption    || null,
    // groupType: 0=DEFAULT, 1=PARENT (community)
    group_type: gi.groupType  ?? 0,
  }
}

// ════════════════════════════════════════════════════════════
// PIN / KEEP PARSERS (WAProto: PinInChatMessage, KeepInChatMessage)
// ════════════════════════════════════════════════════════════

/**
 * Extract pinned message metadata.
 * PinInChatMessage fields: key (MessageKey of pinned msg), type (PIN=1, UNPIN=2)
 */
function extractPinInChat(message, msgType) {
  if (msgType !== "pinInChatMessage") return null
  const pin = message.pinInChatMessage
  if (!pin) return null

  return {
    pinned_msg_id:  pin.key?.id          || null,
    pinned_chat_id: pin.key?.remoteJid   || null,
    pin_type:       pin.type === 2 ? "unpin" : "pin",  // 1=pin, 2=unpin
  }
}

/**
 * Extract keep-in-chat metadata.
 * KeepInChatMessage fields: key (MessageKey), keepType (KEEP_FOR_ALL=1, UNDO_KEEP_FOR_ALL=2)
 */
function extractKeepInChat(message, msgType) {
  if (msgType !== "keepInChatMessage") return null
  const k = message.keepInChatMessage
  if (!k) return null

  return {
    kept_msg_id:  k.key?.id        || null,
    kept_chat_id: k.key?.remoteJid || null,
    keep_type:    k.keepType === 2 ? "undo" : "keep",
  }
}

// ════════════════════════════════════════════════════════════
// SCHEDULED CALL PARSER (WAProto: ScheduledCallCreationMessage)
// ════════════════════════════════════════════════════════════

/**
 * Extract scheduled call details.
 * ScheduledCallCreationMessage fields: title, scheduledTimestamp, callType (AUDIO=1/VIDEO=2),
 * duration, callParticipants (repeated { jid })
 */
function extractScheduledCall(message, msgType) {
  if (msgType !== "scheduledCallCreationMessage" && msgType !== "scheduledCallEditMessage") {
    return null
  }
  const sc = message.scheduledCallCreationMessage || message.scheduledCallEditMessage
  if (!sc) return null

  return {
    title:          sc.title             || null,
    scheduled_at:   sc.scheduledTimestamp ? Number(sc.scheduledTimestamp) : null,
    is_video:       sc.callType === 2    ? 1 : 0,
    duration_secs:  sc.duration          || null,
    participants:   (sc.callParticipants || [])
      .map(p => p.jid || p)
      .filter(Boolean),
  }
}

// ════════════════════════════════════════════════════════════
// ALBUM PARSER (WAProto: AlbumMessage)
// ════════════════════════════════════════════════════════════

/**
 * Extract album metadata.
 * AlbumMessage fields: expectedImageCount, expectedVideoCount,
 * mediaKeys (repeated bytes — one per media item)
 */
function extractAlbum(message, msgType) {
  if (msgType !== "albumMessage") return null
  const album = message.albumMessage
  if (!album) return null

  return {
    image_count: album.expectedImageCount || 0,
    video_count: album.expectedVideoCount || 0,
    total:       (album.expectedImageCount || 0) + (album.expectedVideoCount || 0),
    // We can't fully decode individual media without additional msgs,
    // but store count so UI can show "Album (3 foto)" correctly
  }
}

// ════════════════════════════════════════════════════════════
// FORWARDING INFO
// ════════════════════════════════════════════════════════════

function extractForwardInfo(message, msgType) {
  const m = message.ephemeralMessage?.message || message
  
  let contextInfo = null
  const typeKey = msgType !== "conversation" ? msgType : null
  
  if (m.extendedTextMessage?.contextInfo) contextInfo = m.extendedTextMessage.contextInfo
  else if (typeKey && m[typeKey]?.contextInfo) contextInfo = m[typeKey].contextInfo

  if (!contextInfo) return { isForwarded: false, forwardingScore: 0 }

  return {
    isForwarded: contextInfo.isForwarded || (contextInfo.forwardingScore > 0) || false,
    forwardingScore: contextInfo.forwardingScore || 0,
  }
}

// ════════════════════════════════════════════════════════════
// MAIN PARSER — ENTRY POINT
// ════════════════════════════════════════════════════════════

/**
 * Parse WAMessage Baileys → objek flat yang siap disimpan ke DB
 * dan dikirim ke renderer.
 *
 * @param {object} msg - WAMessage dari Baileys (msg.message harus ada)
 * @param {object} opts - Opsi tambahan
 * @param {string}  opts.jid          - Chat JID (override dari msg.key.remoteJid)
 * @param {string}  opts.pushname     - Display name pengirim
 * @param {boolean} opts.isHistorySync - Dari history sync atau live
 * @param {string}  opts.myJid        - JID kita sendiri
 * @param {Map}     opts.lidMap       - lid → real JID map dari buildLidMap(contacts).
 *                                      Wajib diisi agar @lid tidak bocor ke DB/renderer.
 * @returns {ParsedMessage|null}
 */
function parseMessage(msg, opts = {}) {
  if (!msg?.message) return null

  const key = msg.key || {}
  const lidMap = opts.lidMap || null

  // ── [FIX-SPLIT-CHAT] Normalize chat JID at entry — single gate ──────────
  // raw remoteJid can be @c.us (legacy) or have :device suffix (multi-device)
  // Both create duplicate chat rows in DB → split chat bug
  let jid = normalizeJid(opts.jid || key.remoteJid || "")

  // ── [FIX-LID] Resolve @lid chat JID → real @s.whatsapp.net / @g.us ──────
  // WA uses @lid for privacy in some cases. We resolve eagerly here so the
  // rest of the system never sees @lid in chat_jid / sender_jid fields.
  if (isLidJid(jid) && lidMap) {
    jid = resolveLid(jid, lidMap)
  }

  const isGroup = isJidGroup(jid)
  const isMe    = !!key.fromMe

  // Sender JID — also normalized and lid-resolved
  // For groups fromMe: participant may be undefined → fall back to myJid
  // For DMs fromMe: sender = our own JID (normalized, device suffix stripped)
  const rawSender = isMe
    ? (opts.myJid || key.remoteJid || jid)
    : (key.participant || jid)
  let sender = normalizeJid(rawSender)
  if (isLidJid(sender) && lidMap) {
    sender = resolveLid(sender, lidMap)
  }

  // ── Unwrap ephemeral dulu ──────────────────────────────
  let rawMessage = msg.message
  if (rawMessage.ephemeralMessage?.message) {
    rawMessage = rawMessage.ephemeralMessage.message
  }

  // ── Detect type ────────────────────────────────────────
  const rawType = getRealContentType(rawMessage)
  let msgType = normalizeMsgType(rawType)

  // Special: audioMessage dengan ptt=true → pttMessage
  if (msgType === "audioMessage" && rawMessage.audioMessage?.ptt === true) {
    msgType = "pttMessage"
  }

  // ── Extract semua info ─────────────────────────────────
  const body = extractBody(rawMessage, msgType)
  const mediaInfo = extractMediaInfo(rawMessage, msgType)
  const quoted = extractQuoted(rawMessage, msgType, lidMap)
  const mentions = extractMentions(rawMessage, msgType)
  const pollOptions = msgType === "pollCreationMessage"
    ? extractPollOptions(rawMessage)
    : null
  const location = extractLocation(rawMessage, msgType)
  const contacts = (msgType === "contactMessage" || msgType === "contactsArrayMessage")
    ? extractContacts(rawMessage, msgType)
    : null
  const reaction = msgType === "reactionMessage"
    ? extractReaction(rawMessage)
    : null
  const forwardInfo = extractForwardInfo(rawMessage, msgType)

  // ── New extractors ─────────────────────────────────────
  const eventInfo    = extractEvent(rawMessage, msgType)
  const callInfo     = extractCallLog(rawMessage, msgType)
  const groupInvite  = extractGroupInvite(rawMessage, msgType)
  const pinInfo      = extractPinInChat(rawMessage, msgType)
  const keepInfo     = extractKeepInChat(rawMessage, msgType)
  const schedCall    = extractScheduledCall(rawMessage, msgType)
  const albumInfo    = extractAlbum(rawMessage, msgType)

  // ── Timestamp ──────────────────────────────────────────
  const timestamp = Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000)

  // ── Status ────────────────────────────────────────────
  // 0=pending, 1=sent, 2=delivered, 3=read
  const status = msg.status ?? (isMe ? 1 : 0)

  return {
    // ── Identitas ──────────────────────────────────────
    id: key.id,
    chat_jid: jid,
    sender_jid: sender,
    is_group: isGroup ? 1 : 0,
    from_me: isMe ? 1 : 0,

    // ── Konten utama ───────────────────────────────────
    msg_type: msgType,
    body,
    timestamp,
    status,

    // ── Sender info ────────────────────────────────────
    pushname: opts.pushname || msg.pushName || null,

    // ── Media ──────────────────────────────────────────
    has_media: mediaInfo ? 1 : 0,
    mimetype: mediaInfo?.mimetype || null,
    media_url: mediaInfo?.url || null,
    media_saved_path: null, // diisi setelah download
    media_size: mediaInfo?.fileSize || null,
    media_duration: mediaInfo?.duration || null,
    media_filename: mediaInfo?.fileName || null,
    media_width: mediaInfo?.width || null,
    media_height: mediaInfo?.height || null,
    is_animated: mediaInfo?.isAnimated ? 1 : 0,
    is_ptt: mediaInfo?.isPtt ? 1 : 0,
    is_gif: mediaInfo?.isGif ? 1 : 0,
    is_view_once: mediaInfo?.isViewOnce ? 1 : 0,

    // ── Reply/Quoted ───────────────────────────────────
    quoted_id: quoted?.id || null,
    quoted_body: quoted?.body || null,
    quoted_sender: quoted?.sender || null,
    quoted_type: quoted?.msgType || null,
    quoted_has_media: quoted?.hasMedia ? 1 : 0,
    quoted_mimetype: quoted?.mimetype || null,

    // ── Mention ────────────────────────────────────────
    mentioned_jids: mentions.length ? JSON.stringify(mentions) : null,

    // ── Poll ───────────────────────────────────────────
    poll_options: pollOptions ? JSON.stringify(pollOptions) : null,

    // ── Location ───────────────────────────────────────
    location_lat: location?.lat || null,
    location_lng: location?.lng || null,
    location_name: location?.name || null,
    location_address: location?.address || null,

    // ── Contact ────────────────────────────────────────
    contacts_json: contacts ? JSON.stringify(contacts) : null,

    // ── Reaction ───────────────────────────────────────
    reaction_emoji: reaction?.text || null,
    reaction_target_id: reaction?.targetId || null,

    // ── Forward info ───────────────────────────────────
    is_forwarded: forwardInfo.isForwarded ? 1 : 0,
    forwarding_score: forwardInfo.forwardingScore || 0,

    // ── Event (WAProto: EventMessage) ──────────────────
    event_name:        eventInfo?.name        || null,
    event_description: eventInfo?.description || null,
    event_start_time:  eventInfo?.start_time  || null,
    event_end_time:    eventInfo?.end_time    || null,
    event_location:    eventInfo?.location_name || eventInfo?.location_address || null,
    event_join_link:   eventInfo?.join_link   || null,
    event_is_canceled: eventInfo?.is_canceled ?? null,

    // ── Call log (WAProto: CallLogMessage) ─────────────
    call_is_video:   callInfo?.is_video      ?? null,
    call_outcome:    callInfo?.outcome       || null,
    call_duration:   callInfo?.duration_secs || null,
    call_participants: callInfo?.participants?.length
      ? JSON.stringify(callInfo.participants)
      : null,

    // ── Group invite (WAProto: GroupInviteMessage) ─────
    group_invite_jid:    groupInvite?.group_jid    || null,
    group_invite_name:   groupInvite?.group_name   || null,
    group_invite_code:   groupInvite?.invite_code  || null,
    group_invite_expiry: groupInvite?.invite_expiry || null,

    // ── Pin / Keep ─────────────────────────────────────
    pin_msg_id:  pinInfo?.pinned_msg_id  || null,
    pin_type:    pinInfo?.pin_type       || null,
    keep_msg_id: keepInfo?.kept_msg_id   || null,
    keep_type:   keepInfo?.keep_type     || null,

    // ── Scheduled call ─────────────────────────────────
    sched_call_title:  schedCall?.title         || null,
    sched_call_at:     schedCall?.scheduled_at  || null,
    sched_call_video:  schedCall?.is_video      ?? null,

    // ── Album ──────────────────────────────────────────
    album_count: albumInfo
      ? (albumInfo.image_count + albumInfo.video_count)
      : null,

    // ── Flags ──────────────────────────────────────────
    starred: msg.starred ? 1 : 0,
    is_history_sync: opts.isHistorySync ? 1 : 0,

    // ── Raw untuk debugging/future use ────────────────
    // Simpan raw hanya untuk tipe yang mungkin butuh re-parse
    raw_json: shouldStoreRaw(msgType)
      ? JSON.stringify(rawMessage)
      : null,
  }
}

/**
 * Tipe yang butuh raw JSON (untuk poll update, reaction, payment, dll)
 */
function shouldStoreRaw(msgType) {
  return [
    "pollUpdateMessage",
    "reactionMessage",
    "encReactionMessage",      // encrypted reaction needs raw to decode later
    "requestPaymentMessage",
    "sendPaymentMessage",
    "orderMessage",
    "eventMessage",            // rich event data
    "encEventUpdateMessage",   // encrypted event update
    "scheduledCallCreationMessage",
    "scheduledCallEditMessage",
    "albumMessage",            // individual items arrive separately
    "botInvokeMessage",        // structured params useful for bot integrations
    "nativeFlowMessage",       // buttonParamsJson may have structured data
    "interactiveResponseMessage", // nativeFlowResponseMessage paramsJson
  ].includes(msgType)
}

// ════════════════════════════════════════════════════════════
// RENDERER PAYLOAD BUILDER
// ════════════════════════════════════════════════════════════

/**
 * Build payload yang dikirim ke renderer (lebih slim, tanpa raw_json).
 * Ini yang masuk ke MessageBubble via IPC event "messages:new" atau "db:messages:new"
 */
function buildRendererPayload(parsed) {
  if (!parsed) return null

  return {
    id: parsed.id,
    chat_jid: parsed.chat_jid,
    sender_jid: parsed.sender_jid,
    sender_name: parsed.pushname,
    is_group: parsed.is_group,
    from_me: parsed.from_me,

    msg_type: parsed.msg_type,
    body: parsed.body,
    timestamp: parsed.timestamp,
    status: parsed.status,

    has_media: parsed.has_media,
    mimetype: parsed.mimetype,
    media_url: parsed.media_url,
    media_saved_path: parsed.media_saved_path,
    media_duration: parsed.media_duration,
    media_filename: parsed.media_filename,
    is_animated: parsed.is_animated,
    is_ptt: parsed.is_ptt,
    is_gif: parsed.is_gif,
    is_view_once: parsed.is_view_once,

    quoted_id: parsed.quoted_id,
    quoted_body: parsed.quoted_body,
    quoted_sender: parsed.quoted_sender,
    quoted_type: parsed.quoted_type,
    quoted_has_media: parsed.quoted_has_media,

    mentioned_jids: parsed.mentioned_jids
      ? JSON.parse(parsed.mentioned_jids)
      : [],

    poll_options: parsed.poll_options
      ? JSON.parse(parsed.poll_options)
      : null,

    location_lat: parsed.location_lat,
    location_lng: parsed.location_lng,
    location_name: parsed.location_name,
    location_address: parsed.location_address,

    contacts_json: parsed.contacts_json
      ? JSON.parse(parsed.contacts_json)
      : null,

    reaction_emoji: parsed.reaction_emoji,
    reaction_target_id: parsed.reaction_target_id,

    is_forwarded: parsed.is_forwarded,
    forwarding_score: parsed.forwarding_score,

    // ── Event ──────────────────────────────────────────
    event_name:        parsed.event_name,
    event_description: parsed.event_description,
    event_start_time:  parsed.event_start_time,
    event_end_time:    parsed.event_end_time,
    event_location:    parsed.event_location,
    event_join_link:   parsed.event_join_link,
    event_is_canceled: parsed.event_is_canceled,

    // ── Call log ───────────────────────────────────────
    call_is_video:    parsed.call_is_video,
    call_outcome:     parsed.call_outcome,
    call_duration:    parsed.call_duration,

    // ── Group invite ───────────────────────────────────
    group_invite_jid:    parsed.group_invite_jid,
    group_invite_name:   parsed.group_invite_name,
    group_invite_code:   parsed.group_invite_code,
    group_invite_expiry: parsed.group_invite_expiry,

    // ── Pin / Keep ─────────────────────────────────────
    pin_msg_id:  parsed.pin_msg_id,
    pin_type:    parsed.pin_type,
    keep_msg_id: parsed.keep_msg_id,
    keep_type:   parsed.keep_type,

    // ── Scheduled call ─────────────────────────────────
    sched_call_title: parsed.sched_call_title,
    sched_call_at:    parsed.sched_call_at,
    sched_call_video: parsed.sched_call_video,

    // ── Album ──────────────────────────────────────────
    album_count: parsed.album_count,

    starred: parsed.starred,
  }
}

/**
 * Alias untuk dipakai di client.js.
 * Konversi DB row (flat) → format yang sama dengan buildRendererPayload
 */
function dbRowToRendererMsg(row) {
  if (!row) return null
  return {
    ...row,
    mentioned_jids: row.mentioned_jids
      ? (typeof row.mentioned_jids === "string" ? JSON.parse(row.mentioned_jids) : row.mentioned_jids)
      : [],
    poll_options: row.poll_options
      ? (typeof row.poll_options === "string" ? JSON.parse(row.poll_options) : row.poll_options)
      : null,
    contacts_json: row.contacts_json
      ? (typeof row.contacts_json === "string" ? JSON.parse(row.contacts_json) : row.contacts_json)
      : null,
  }
}

// ════════════════════════════════════════════════════════════
// EXPORT
// ════════════════════════════════════════════════════════════

module.exports = {
  parseMessage,
  buildRendererPayload,
  dbRowToRendererMsg,
  normalizeJid,        // [FIX-SPLIT-CHAT] exported for use in database.js and client.js

  // [FIX-LID] WhatsApp Linked Identity resolution
  isLidJid,
  resolveLid,
  tryResolveLid,
  buildLidMap,
  formatJidAsPhone,

  // Utils yang mungkin dibutuhkan di tempat lain
  getRealContentType,
  normalizeMsgType,
  extractBody,
  extractMediaInfo,
  extractQuoted,
  extractMentions,
  extractPollOptions,
  extractLocation,
  extractContacts,
  extractReaction,
  hasMediaContent,
  MEDIA_TYPES,

  // ── New proto extractors ──────────────────────────────
  extractEvent,
  extractCallLog,
  extractGroupInvite,
  extractPinInChat,
  extractKeepInChat,
  extractScheduledCall,
  extractAlbum,
}