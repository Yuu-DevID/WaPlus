"use strict"

// ════════════════════════════════════════════════════════════
// messageParser.js — Entry Point
// WaPlus-dev — Universal Message Parser
//
// Tugas file ini:
//   - parseMessage()      — main parser, WAMessage → flat DB object
//   - shouldStoreRaw()    — tipe yang perlu raw_json
//   - Re-export semua sub-module agar caller cukup require satu file
//
// Sub-modules (./parser/):
//   jid-utils.js          — JID normalization + LID resolution
//   type-detection.js     — getRealContentType, normalizeMsgType
//   body-extractor.js     — extractBody
//   media-extractor.js    — extractMediaInfo, hasMediaContent, MEDIA_TYPES
//   quoted-extractor.js   — extractQuoted
//   misc-extractors.js    — mentions, poll, location, contact, reaction, forward
//   proto-extractors.js   — event, callLog, groupInvite, pin, keep, schedCall, album
//   renderer.js           — buildRendererPayload, dbRowToRendererMsg, enrichMessage
// ════════════════════════════════════════════════════════════

const { isJidGroup } = require("wileys")

const {
  normalizeJid, decodeJid,
  isLidJid, resolveLid, tryResolveLid, buildLidMap,
  initLidMap, updateLidMap, seedLidMap,
  formatJidAsPhone, getJidDisplayPhone,
} = require("./parser/jid-utils")

const { getRealContentType, normalizeMsgType, TYPE_ALIASES } = require("./parser/type-detection")
const { extractBody }                                         = require("./parser/body-extractor")
const { extractMediaInfo, hasMediaContent, MEDIA_TYPES }     = require("./parser/media-extractor")
const { extractQuoted }                                       = require("./parser/quoted-extractor")
const {
  extractMentions, extractPollOptions, extractLocation,
  extractContacts, extractReaction, extractForwardInfo,
} = require("./parser/misc-extractors")
const {
  extractEvent, extractCallLog, extractGroupInvite,
  extractPinInChat, extractKeepInChat, extractScheduledCall, extractAlbum,
} = require("./parser/proto-extractors")
const { buildRendererPayload, dbRowToRendererMsg, enrichMessage } = require("./parser/renderer")

// ════════════════════════════════════════════════════════════
// MAIN PARSER
// ════════════════════════════════════════════════════════════

/**
 * parseMessage — parse WAMessage Baileys → objek flat siap simpan ke DB.
 *
 * @param {object} msg  - WAMessage dari Baileys (msg.message harus ada)
 * @param {object} opts
 * @param {string}  opts.jid          - Chat JID (override dari msg.key.remoteJid)
 * @param {string}  opts.pushname     - Display name pengirim
 * @param {boolean} opts.isHistorySync - Dari history sync atau live
 * @param {string}  opts.myJid        - JID kita sendiri
 * @param {Map}     [opts.lidMap]     - Override lidMap (opsional — biasanya tidak perlu
 *                                      karena global map sudah di-init via initLidMap())
 * @returns {ParsedMessage|null}
 */
function parseMessage(msg, opts = {}) {
  if (!msg?.message) return null

  const key    = msg.key || {}
  const lidMapOverride = opts.lidMap || null

  // ── Normalize chat JID — single gate ────────────────────
  // normalizeJid handles: @c.us, :device suffix, @lid resolve
  let jid = normalizeJid(opts.jid || key.remoteJid || "")

  // Extra: jika @lid masih lolos (global map belum populated), coba override
  if (isLidJid(jid) && lidMapOverride) {
    jid = resolveLid(jid, lidMapOverride)
  }

  const isGroup = isJidGroup(jid)

  // [FIX-7] Authoritative fromMe detection.
  // key.fromMe is the primary source. But in multi-device group chats, Baileys
  // sometimes delivers our own messages with fromMe=false (especially via linked
  // device relay).  Fallback check: if key.participant equals our own JID → fromMe.
  let isMe = !!key.fromMe
  if (!isMe && opts.myJid && key.participant) {
    // Strip :device suffix before comparing
    const myUser    = opts.myJid.split('@')[0].split(':')[0]
    const partUser  = key.participant.split('@')[0].split(':')[0]
    if (myUser && partUser && myUser === partUser) {
      isMe = true
    }
  }

  // ── Sender JID — normalized + lid resolved ───────────────
  const rawSender = isMe
    ? (opts.myJid || key.remoteJid || jid)
    : (key.participant || jid)

  let sender = normalizeJid(rawSender)
  if (isLidJid(sender) && lidMapOverride) {
    sender = resolveLid(sender, lidMapOverride)
  }

  // ── Unwrap ephemeral ─────────────────────────────────────
  let rawMessage = msg.message
  if (rawMessage.ephemeralMessage?.message) {
    rawMessage = rawMessage.ephemeralMessage.message
  }

  // ── Detect type ──────────────────────────────────────────
  const rawType = getRealContentType(rawMessage)
  let msgType   = normalizeMsgType(rawType)

  // audioMessage dengan ptt=true → pttMessage
  if (msgType === "audioMessage" && rawMessage.audioMessage?.ptt === true) {
    msgType = "pttMessage"
  }

  // ── Extract semua info ───────────────────────────────────
  const body        = extractBody(rawMessage, msgType)
  const mediaInfo   = extractMediaInfo(rawMessage, msgType)
  const quoted      = extractQuoted(rawMessage, msgType, lidMapOverride)
  const mentions    = extractMentions(rawMessage, msgType)
  const pollOptions = msgType === "pollCreationMessage" ? extractPollOptions(rawMessage) : null
  const location    = extractLocation(rawMessage, msgType)
  const contacts    = (msgType === "contactMessage" || msgType === "contactsArrayMessage")
    ? extractContacts(rawMessage, msgType) : null
  const reaction    = msgType === "reactionMessage" ? extractReaction(rawMessage) : null
  const forwardInfo = extractForwardInfo(rawMessage, msgType)
  const eventInfo   = extractEvent(rawMessage, msgType)
  const callInfo    = extractCallLog(rawMessage, msgType)
  const groupInvite = extractGroupInvite(rawMessage, msgType)
  const pinInfo     = extractPinInChat(rawMessage, msgType)
  const keepInfo    = extractKeepInChat(rawMessage, msgType)
  const schedCall   = extractScheduledCall(rawMessage, msgType)
  const albumInfo   = extractAlbum(rawMessage, msgType)

  const timestamp = Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000)
  const status    = msg.status ?? (isMe ? 1 : 0)

  return {
    // Identity
    id:         key.id,
    chat_jid:   jid,
    sender_jid: sender,
    is_group:   isGroup ? 1 : 0,
    from_me:    isMe    ? 1 : 0,

    // Content
    msg_type:  msgType,
    body,
    timestamp,
    status,

    // Sender info
    pushname: opts.pushname || msg.pushName || null,

    // Media
    has_media:           mediaInfo ? 1 : 0,
    mimetype:            mediaInfo?.mimetype    || null,
    media_url:           mediaInfo?.url         || null,
    media_saved_path:    null,
    media_size:          mediaInfo?.fileSize    || null,
    media_duration:      mediaInfo?.duration    || null,
    media_filename:      mediaInfo?.fileName    || null,
    media_width:         mediaInfo?.width       || null,
    media_height:        mediaInfo?.height      || null,
    is_animated:         mediaInfo?.isAnimated  ? 1 : 0,
    is_ptt:              mediaInfo?.isPtt       ? 1 : 0,
    is_gif:              mediaInfo?.isGif       ? 1 : 0,
    is_view_once:        mediaInfo?.isViewOnce  ? 1 : 0,
    media_thumbnail_b64: mediaInfo?.thumbnailDataUrl  || null,
    // [FIX-MEDIA-CRYPTO] Persist crypto fields so expired URLs can be re-downloaded
    // without needing the original live message. Baileys reconstructs the download
    // from mediaKey + directPath + fileEncSha256.
    media_key:           mediaInfo?.mediaKey    || null,
    media_direct_path:   mediaInfo?.directPath  || null,
    media_enc_sha256:    mediaInfo?.encSha256   || null,

    // Quoted
    quoted_id:        quoted?.id       || null,
    quoted_body:      quoted?.body     || null,
    quoted_sender:    quoted?.sender   || null,
    quoted_type:      quoted?.msgType  || null,
    quoted_has_media: quoted?.hasMedia ? 1 : 0,
    quoted_mimetype:  quoted?.mimetype || null,

    // Mentions
    mentioned_jids: mentions.length ? JSON.stringify(mentions) : null,

    // Poll
    poll_options: pollOptions ? JSON.stringify(pollOptions) : null,

    // Location
    location_lat:     location?.lat     || null,
    location_lng:     location?.lng     || null,
    location_name:    location?.name    || null,
    location_address: location?.address || null,

    // Contact
    contacts_json: contacts ? JSON.stringify(contacts) : null,

    // Reaction
    reaction_emoji:     reaction?.text     || null,
    reaction_target_id: reaction?.targetId || null,

    // Forward
    is_forwarded:    forwardInfo.isForwarded     ? 1 : 0,
    forwarding_score: forwardInfo.forwardingScore || 0,

    // Event
    event_name:        eventInfo?.name        || null,
    event_description: eventInfo?.description || null,
    event_start_time:  eventInfo?.start_time  || null,
    event_end_time:    eventInfo?.end_time    || null,
    event_location:    eventInfo?.location_name || eventInfo?.location_address || null,
    event_join_link:   eventInfo?.join_link   || null,
    event_is_canceled: eventInfo?.is_canceled ?? null,

    // Call log
    call_is_video:     callInfo?.is_video      ?? null,
    call_outcome:      callInfo?.outcome       || null,
    call_duration:     callInfo?.duration_secs || null,
    call_participants: callInfo?.participants?.length
      ? JSON.stringify(callInfo.participants)
      : null,

    // Group invite
    group_invite_jid:    groupInvite?.group_jid    || null,
    group_invite_name:   groupInvite?.group_name   || null,
    group_invite_code:   groupInvite?.invite_code  || null,
    group_invite_expiry: groupInvite?.invite_expiry || null,

    // Pin / Keep
    pin_msg_id:  pinInfo?.pinned_msg_id  || null,
    pin_type:    pinInfo?.pin_type       || null,
    keep_msg_id: keepInfo?.kept_msg_id   || null,
    keep_type:   keepInfo?.keep_type     || null,

    // Scheduled call
    sched_call_title: schedCall?.title        || null,
    sched_call_at:    schedCall?.scheduled_at || null,
    sched_call_video: schedCall?.is_video     ?? null,

    // Album
    album_count: albumInfo ? (albumInfo.image_count + albumInfo.video_count) : null,

    // Flags
    starred:         msg.starred         ? 1 : 0,
    is_history_sync: opts.isHistorySync  ? 1 : 0,

    // Raw — selalu disimpan untuk DevEval & re-parse
    raw_json: JSON.stringify(rawMessage),
  }
}

// ════════════════════════════════════════════════════════════
// SHOULD STORE RAW
// ════════════════════════════════════════════════════════════

const RAW_TYPES = new Set([
  "pollUpdateMessage",
  "reactionMessage",
  "encReactionMessage",
  "requestPaymentMessage",
  "sendPaymentMessage",
  "orderMessage",
  "eventMessage",
  "encEventUpdateMessage",
  "scheduledCallCreationMessage",
  "scheduledCallEditMessage",
  "albumMessage",
  "botInvokeMessage",
  "nativeFlowMessage",
  "interactiveResponseMessage",
])

function shouldStoreRaw(msgType) {
  return RAW_TYPES.has(msgType)
}

// ════════════════════════════════════════════════════════════
// EXPORT — re-export semua sub-modules agar caller cukup require sini
// ════════════════════════════════════════════════════════════

module.exports = {
  // ── Core ──────────────────────────────────────────────────
  parseMessage,
  shouldStoreRaw,

  // ── JID (./parser/jid-utils) ──────────────────────────────
  initLidMap,         // WAJIB dipanggil di contacts.upsert handler
  updateLidMap,       // Panggil di contacts.update (incremental)
  seedLidMap,         // [FIX] seed global map directly from disk-loaded Map
  normalizeJid,       // [FIX-SPLIT-CHAT] pakai ini di database.js & client.js
  decodeJid,          // Baileys dims.decodeJid() compatible
  isLidJid,
  resolveLid,
  tryResolveLid,
  buildLidMap,
  formatJidAsPhone,
  getJidDisplayPhone,

  // ── Type detection (./parser/type-detection) ──────────────
  getRealContentType,
  normalizeMsgType,
  TYPE_ALIASES,

  // ── Extractors ────────────────────────────────────────────
  extractBody,
  extractMediaInfo,
  extractQuoted,
  extractMentions,
  extractPollOptions,
  extractLocation,
  extractContacts,
  extractReaction,
  extractForwardInfo,
  hasMediaContent,
  MEDIA_TYPES,

  // ── Proto extractors (./parser/proto-extractors) ──────────
  extractEvent,
  extractCallLog,
  extractGroupInvite,
  extractPinInChat,
  extractKeepInChat,
  extractScheduledCall,
  extractAlbum,

  // ── Renderer (./parser/renderer) ──────────────────────────
  buildRendererPayload,
  dbRowToRendererMsg,
  enrichMessage,
}
