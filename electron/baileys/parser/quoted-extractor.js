"use strict"

const { normalizeJid, isLidJid, resolveLid } = require("./jid-utils")
const { getRealContentType, normalizeMsgType } = require("./type-detection")
const { extractBody } = require("./body-extractor")
const { hasMediaContent } = require("./media-extractor")

// ════════════════════════════════════════════════════════════
// QUOTED MESSAGE EXTRACTOR
// ════════════════════════════════════════════════════════════

/**
 * extractQuoted — extract quoted/reply message dari contextInfo.
 * Resolve @lid sender secara otomatis via global LID map.
 *
 * @param {object} message - raw WA message
 * @param {string} msgType - normalized msg type
 * @param {Map}    [lidMapOverride] - optional override map (biasanya tidak perlu karena global map)
 * @returns {object|null}
 */
function extractQuoted(message, msgType, lidMapOverride) {
  if (!message) return null

  const m = message.ephemeralMessage?.message
    || message.viewOnceMessage?.message
    || message

  // Cari contextInfo di berbagai lokasi tergantung tipe
  let contextInfo = null

  if (m.extendedTextMessage?.contextInfo) {
    contextInfo = m.extendedTextMessage.contextInfo
  } else if (msgType !== "conversation" && m[msgType]?.contextInfo) {
    contextInfo = m[msgType].contextInfo
  } else {
    // Fallback: scan semua keys
    for (const key of Object.keys(m)) {
      if (m[key]?.contextInfo) {
        contextInfo = m[key].contextInfo
        break
      }
    }
  }

  if (!contextInfo?.quotedMessage) return null

  const qMsg     = contextInfo.quotedMessage
  const qType    = getRealContentType(qMsg)
  const qMsgType = normalizeMsgType(qType)
  const qBody    = extractBody(qMsg, qMsgType)

  // Sender quoted — normalize dan resolve @lid
  let qSender = contextInfo.participant || contextInfo.remoteJid || null
  if (qSender) {
    qSender = normalizeJid(qSender)
    // normalizeJid sudah auto-resolve via global map.
    // lidMapOverride hanya untuk kasus isolated (test/plugin).
    if (isLidJid(qSender) && lidMapOverride) {
      qSender = resolveLid(qSender, lidMapOverride)
    }
  }

  return {
    id:           contextInfo.stanzaId || null,
    sender:       qSender,
    body:         qBody,
    msgType:      qMsgType,
    hasMedia:     hasMediaContent(qMsgType),
    mimetype:     qMsg[qType]?.mimetype || null,
    mentionedJid: contextInfo.mentionedJid || [],
  }
}

module.exports = { extractQuoted }
