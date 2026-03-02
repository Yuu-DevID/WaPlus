"use strict"

// ════════════════════════════════════════════════════════════
// MISC EXTRACTORS
// Mentions, Poll, Location, Contact, Reaction, ForwardInfo
// ════════════════════════════════════════════════════════════

// ── Mentions ──────────────────────────────────────────────────

/**
 * extractMentions — extract semua @mention JID dari contextInfo.mentionedJid.
 */
function extractMentions(message, msgType) {
  if (!message) return []

  const m = message.ephemeralMessage?.message || message

  const mentions = []
  const tryPush = (obj) => {
    if (obj?.contextInfo?.mentionedJid?.length) {
      mentions.push(...obj.contextInfo.mentionedJid)
    }
  }

  tryPush(m.extendedTextMessage)
  tryPush(m.imageMessage)
  tryPush(m.videoMessage)
  tryPush(m.documentMessage)
  tryPush(m.audioMessage)
  tryPush(m.buttonsMessage)
  tryPush(m.listMessage)
  tryPush(m.interactiveMessage)

  return [...new Set(mentions)]
}

// ── Poll ──────────────────────────────────────────────────────

/**
 * extractPollOptions — extract opsi poll dari pollCreationMessage.
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
    votes: 0, // diupdate dari pollUpdateMessage
  }))
}

// ── Location ──────────────────────────────────────────────────

function extractLocation(message, msgType) {
  if (msgType !== "locationMessage" && msgType !== "liveLocationMessage") return null

  const loc = message.locationMessage || message.liveLocationMessage
  if (!loc) return null

  return {
    lat:      loc.degreesLatitude  || null,
    lng:      loc.degreesLongitude || null,
    name:     loc.name             || null,
    address:  loc.address          || null,
    url:      loc.url              || null,
    accuracy: loc.accuracyInMeters || null,
    isLive:   msgType === "liveLocationMessage",
    speed:    loc.speedInMps       || null,
  }
}

// ── Contact ───────────────────────────────────────────────────

function extractContacts(message, msgType) {
  if (msgType === "contactMessage") {
    const c = message.contactMessage
    return [{ displayName: c?.displayName || "", vcard: c?.vcard || "" }]
  }
  if (msgType === "contactsArrayMessage") {
    return (message.contactsArrayMessage?.contacts || []).map(c => ({
      displayName: c.displayName || "",
      vcard:       c.vcard       || "",
    }))
  }
  return []
}

// ── Reaction ──────────────────────────────────────────────────

function extractReaction(message) {
  const r = message.reactionMessage
  if (!r) return null
  return {
    text:     r.text        || "",
    targetId: r.key?.id     || null,
    isRemove: !r.text,
  }
}

// ── Forward info ──────────────────────────────────────────────

function extractForwardInfo(message, msgType) {
  const m = message.ephemeralMessage?.message || message

  let contextInfo = null
  if (m.extendedTextMessage?.contextInfo) {
    contextInfo = m.extendedTextMessage.contextInfo
  } else if (msgType !== "conversation" && m[msgType]?.contextInfo) {
    contextInfo = m[msgType].contextInfo
  }

  if (!contextInfo) return { isForwarded: false, forwardingScore: 0 }

  return {
    isForwarded:     contextInfo.isForwarded || (contextInfo.forwardingScore > 0) || false,
    forwardingScore: contextInfo.forwardingScore || 0,
  }
}

module.exports = {
  extractMentions,
  extractPollOptions,
  extractLocation,
  extractContacts,
  extractReaction,
  extractForwardInfo,
}
