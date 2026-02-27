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
    case "callLogMessage":
      return m.callLogMessage?.isVideo ? "Panggilan Video" : "Panggilan Suara"

    // ── Event ──────────────────────────────────────────────
    case "eventMessage":
      return m.eventMessage?.name || "Acara"

    // ── Newsletter ─────────────────────────────────────────
    case "newsletterAdminInviteMessage":
      return m.newsletterAdminInviteMessage?.newsletterName || "Undangan Newsletter"

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
 */
function extractQuoted(message, msgType) {
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

  // Sender quoted
  const qSender = contextInfo.participant
    || contextInfo.remoteJid
    || null

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
 * @param {string} opts.jid - Chat JID (override dari msg.key.remoteJid)
 * @param {string} opts.pushname - Display name pengirim
 * @param {boolean} opts.isHistorySync - Dari history sync atau live
 * @param {string} opts.myJid - JID kita sendiri
 * @returns {ParsedMessage|null}
 */
function parseMessage(msg, opts = {}) {
  if (!msg?.message) return null

  const key = msg.key || {}
  const jid = opts.jid || key.remoteJid || ""
  const isGroup = isJidGroup(jid)
  const isMe = !!key.fromMe

  // Sender JID
  const sender = isMe
    ? jidNormalizedUser(opts.myJid || jid)
    : jidNormalizedUser(key.participant || jid)

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
  const quoted = extractQuoted(rawMessage, msgType)
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
    "requestPaymentMessage",
    "sendPaymentMessage",
    "orderMessage",
    "eventMessage",
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
}