"use strict"

const { normalizeJid, isLidJid, resolveLid, getJidDisplayPhone } = require("./jid-utils")

// ════════════════════════════════════════════════════════════
// RENDERER PAYLOAD BUILDER
// ════════════════════════════════════════════════════════════

/**
 * buildRendererPayload — build slim payload untuk dikirim ke renderer via IPC.
 * Strip raw_json dan fields berat yang tidak dibutuhkan UI.
 * Event: "messages:new" atau "db:messages:new"
 *
 * @param {object} parsed - output dari parseMessage()
 * @returns {object|null}
 */
function buildRendererPayload(parsed) {
  if (!parsed) return null

  return {
    // Identity
    id:          parsed.id,
    chat_jid:    parsed.chat_jid,
    sender_jid:  parsed.sender_jid,
    sender_name: parsed._resolved_sender_name || parsed.pushname || null,
    is_group:    parsed.is_group,
    from_me:     parsed.from_me,

    // Content
    msg_type:  parsed.msg_type,
    body:      parsed.body,
    timestamp: parsed.timestamp,
    status:    parsed.status,

    // Media
    has_media:          parsed.has_media,
    mimetype:           parsed.mimetype,
    media_url:          parsed.media_url,
    media_saved_path:   parsed.media_saved_path,
    media_duration:     parsed.media_duration,
    media_filename:     parsed.media_filename,
    is_animated:        parsed.is_animated,
    is_ptt:             parsed.is_ptt,
    is_gif:             parsed.is_gif,
    is_view_once:       parsed.is_view_once,
    media_thumbnail_b64: parsed.media_thumbnail_b64,

    // Quoted
    quoted_id:               parsed.quoted_id,
    quoted_body:             parsed.quoted_body,
    quoted_sender:           parsed.quoted_sender,
    quoted_sender_name:      parsed._resolved_quoted_sender_name || null,
    quoted_type:             parsed.quoted_type,
    quoted_has_media:        parsed.quoted_has_media,

    // Mentions
    mentioned_jids: parsed.mentioned_jids
      ? JSON.parse(parsed.mentioned_jids)
      : [],

    // Poll
    poll_options: parsed.poll_options
      ? JSON.parse(parsed.poll_options)
      : null,

    // Location
    location_lat:     parsed.location_lat,
    location_lng:     parsed.location_lng,
    location_name:    parsed.location_name,
    location_address: parsed.location_address,

    // Contact
    contacts_json: parsed.contacts_json
      ? JSON.parse(parsed.contacts_json)
      : null,

    // Reaction
    reaction_emoji:     parsed.reaction_emoji,
    reaction_target_id: parsed.reaction_target_id,

    // Forward
    is_forwarded:    parsed.is_forwarded,
    forwarding_score: parsed.forwarding_score,

    // Event
    event_name:        parsed.event_name,
    event_description: parsed.event_description,
    event_start_time:  parsed.event_start_time,
    event_end_time:    parsed.event_end_time,
    event_location:    parsed.event_location,
    event_join_link:   parsed.event_join_link,
    event_is_canceled: parsed.event_is_canceled,

    // Call log
    call_is_video: parsed.call_is_video,
    call_outcome:  parsed.call_outcome,
    call_duration: parsed.call_duration,

    // Group invite
    group_invite_jid:    parsed.group_invite_jid,
    group_invite_name:   parsed.group_invite_name,
    group_invite_code:   parsed.group_invite_code,
    group_invite_expiry: parsed.group_invite_expiry,

    // Pin / Keep
    pin_msg_id:  parsed.pin_msg_id,
    pin_type:    parsed.pin_type,
    keep_msg_id: parsed.keep_msg_id,
    keep_type:   parsed.keep_type,

    // Scheduled call
    sched_call_title: parsed.sched_call_title,
    sched_call_at:    parsed.sched_call_at,
    sched_call_video: parsed.sched_call_video,

    // Album
    album_count: parsed.album_count,

    starred: parsed.starred,
  }
}

/**
 * dbRowToRendererMsg — konversi DB row (flat) → format renderer.
 * JSON fields di DB disimpan sebagai string — parse di sini.
 *
 * @param {object} row - SQLite row dari messages table
 * @returns {object|null}
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
// ENRICH MESSAGE — smsg()-style enrichment
// ════════════════════════════════════════════════════════════

/**
 * enrichMessage — tambah helper fields yang dipakai case.js / bot handlers.
 * Call ini setelah parseMessage() jika butuh bot-style fields.
 * Optional — WaPlus tidak wajib, tapi memudahkan porting bot commands.
 *
 * @param {object} parsed - output dari parseMessage()
 * @param {object} opts
 * @param {string} opts.myJid  - JID kita sendiri (normalized)
 * @returns {object} - same object, mutated
 */
function enrichMessage(parsed, opts = {}) {
  if (!parsed) return parsed

  const myJid = opts.myJid ? normalizeJid(opts.myJid) : null

  // Boolean variants (vs 0/1 integers di DB row)
  parsed.isGroup    = parsed.is_group    === 1
  parsed.fromMe     = parsed.from_me     === 1
  parsed.hasMedia   = parsed.has_media   === 1
  parsed.isGif      = parsed.is_gif      === 1
  parsed.isPtt      = parsed.is_ptt      === 1
  parsed.isViewOnce = parsed.is_view_once === 1
  parsed.isForwarded = parsed.is_forwarded === 1
  parsed.isBaileys  = parsed.id
    ? (parsed.id.startsWith("BAE5") && parsed.id.length === 16)
    : false

  // Sender display
  const sender = parsed.sender_jid || ""
  parsed.sender        = sender
  parsed.senderNumber  = sender.split("@")[0]
  parsed.senderDisplay = parsed.pushname || getJidDisplayPhone(sender) || sender

  // isBot — sender adalah account kita sendiri
  if (myJid) {
    parsed.isBot     = normalizeJid(sender) === normalizeJid(myJid)
    parsed.itsMeYumi = parsed.isBot
  }

  // Message type helpers
  const t = parsed.msg_type || "conversation"
  parsed.type       = t
  parsed.isImage    = t === "imageMessage"
  parsed.isVideo    = t === "videoMessage"
  parsed.isAudio    = t === "audioMessage" || t === "pttMessage"
  parsed.isSticker  = t === "stickerMessage"
  parsed.isDocument = t === "documentMessage"
  parsed.isText     = t === "conversation" || t === "extendedTextMessage"
  parsed.isPoll     = t === "pollCreationMessage"
  parsed.isReaction = t === "reactionMessage"
  parsed.isLocation = t === "locationMessage" || t === "liveLocationMessage"
  parsed.isContact  = t === "contactMessage"  || t === "contactsArrayMessage"

  // Quoted type helpers
  parsed.isQuotedImage    = parsed.quoted_type === "imageMessage"
  parsed.isQuotedVideo    = parsed.quoted_type === "videoMessage"
  parsed.isQuotedAudio    = parsed.quoted_type === "audioMessage" || parsed.quoted_type === "pttMessage"
  parsed.isQuotedSticker  = parsed.quoted_type === "stickerMessage"
  parsed.isQuotedDocument = parsed.quoted_type === "documentMessage"

  return parsed
}

module.exports = { buildRendererPayload, dbRowToRendererMsg, enrichMessage }
