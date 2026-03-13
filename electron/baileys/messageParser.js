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

// [JID-UTILS] All JID type checks now come from jid-utils which wraps Baileys native funcs
// [FIX] Merged two separate destructures of the same module into one require() call.
// Node's cache means the file only executes once, but two destructure passes still
// double the property-read work at startup and create a maintenance trap where a
// symbol added to the wrong block silently resolves as undefined at call-time.
const {
  isJidGroup, isGroupJid, isNewsletterJid, isStatusBroadcastJid, isBroadcastJid,
  sameUser, parseJid,
  normalizeJid, decodeJid,
  isLidJid, resolveLid, tryResolveLid, resolveLidAsync, buildLidMap,
  initLidMap, updateLidMap, seedLidMap, initSock,
  normalizeJidAsync, formatJidAsPhone, getJidDisplayPhone,
  // Baileys identity helpers for fromMe detection
  isJidUser, isJidBot, isJidMetaAi, jidNormalizedUser,
} = require("./parser/jid-utils")

const { getRealContentType, normalizeMsgType, isViewOnceType, unwrapViewOnce, TYPE_ALIASES } = require("./parser/type-detection")
const { extractBody }                                         = require("./parser/body-extractor")
const { extractMediaInfo, extractMediaInfoAsync, hasMediaContent, MEDIA_TYPES } = require("./parser/media-extractor")
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
  // [FIX] Stricter guard — typeof object check rejects proto stubs that are
  // technically truthy (e.g. empty WAMessage instances) but contain no fields.
  if (!msg?.message || typeof msg.message !== "object") return null

  const key            = msg.key || {}
  const lidMapOverride = opts.lidMap || null

  // ── Normalize chat JID — single gate ────────────────────
  // normalizeJid handles: @c.us, :device suffix, @lid resolve
  let jid = normalizeJid(opts.jid || key.remoteJid || "")

  // Extra: jika @lid masih lolos (global map belum populated), coba override
  if (isLidJid(jid) && lidMapOverride) {
    jid = resolveLid(jid, lidMapOverride)
  }

  // [FIX] Early-exit on empty JID — an unroutable message would insert a row
  // with chat_jid='' which breaks every downstream JOIN and sort query.
  if (!jid) return null

  const isGroup = isJidGroup(jid)

  // ── Authoritative fromMe detection (multi-layer) ───────────────────────────
  // Baileys key.fromMe is the primary source but has known gaps:
  //   - Multi-device relay: own messages arrive with fromMe=false
  //   - Linked device: key.participant is our JID but fromMe=false
  //   - Bot JID: bot messages use different JID format
  //   - @lid sender: our own @lid must match after normalization
  //
  // We check every available signal and use areJidsSameUser (Baileys-native)
  // for ALL comparisons so :device suffixes and @c.us/@s.whatsapp.net variants
  // are handled correctly without manual string ops.
  let isMe = !!key.fromMe

  if (!isMe && opts.myJid) {
    const myNorm = jidNormalizedUser(opts.myJid) || opts.myJid

    // Check 1: key.participant vs myJid (multi-device group relay)
    if (!isMe && key.participant) {
      isMe = sameUser(myNorm, key.participant)
    }

    // Check 2: key.remoteJid vs myJid (DM from ourselves / note-to-self)
    if (!isMe && key.remoteJid && !isJidGroup(key.remoteJid)) {
      isMe = sameUser(myNorm, key.remoteJid)
    }

    // Check 3: resolved sender vs myJid (after @lid resolve)
    //   This catches the case where our own @lid appears as sender
    //   before key.fromMe is set correctly by Baileys.
    const rawSenderCheck = key.participant || key.remoteJid
    if (!isMe && rawSenderCheck) {
      const normSenderCheck = normalizeJid(rawSenderCheck)
      if (!isLidJid(normSenderCheck)) {
        isMe = sameUser(myNorm, normSenderCheck)
      }
    }

    // Check 4: getBotJid — if sock has a bot JID, check against that too
    if (!isMe && opts.sock) {
      try {
        const { getBotJid } = require("baileys")
        const botJid = typeof getBotJid === "function" ? getBotJid(opts.sock) : null
        if (botJid && key.participant) {
          isMe = sameUser(botJid, key.participant)
        }
      } catch (_) {}
    }
  }

  // ── Sender JID — normalized + lid resolved ───────────────
  // [FIX-GROUP-PARTICIPANT] History sync kadang mengisi key.participant dengan
  // JID group itu sendiri (@g.us) — data bogus dari proto WA. Kalau participant
  // sama dengan remoteJid (keduanya @g.us), abaikan dan fallback ke jid saja.
  const validParticipant = (key.participant && key.participant !== key.remoteJid)
    ? key.participant
    : undefined

  const rawSender = isMe
    ? (opts.myJid || key.remoteJid || jid)
    : (validParticipant || jid)

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

  // ── Unwrap ViewOnce (v1 / v2 / v2Extension) ───────────────
  // The single source-of-truth unwrap happens HERE so every downstream
  // extractor (body, media, quoted, mentions, forward) receives the real
  // inner message and works without any special-casing for viewOnce.
  // We track isViewOnce separately so the DB flag and renderer still know.
  let isViewOnce = false
  if (isViewOnceType(msgType)) {
    const vo = unwrapViewOnce(rawMessage)
    if (vo?.inner) {
      isViewOnce = true
      rawMessage = vo.inner  // ← ALL extractors now get the inner msg
      // [FIX] Re-detect type from the UNWRAPPED inner, not from rawType.split(":")[1].
      // The split approach read a suffix that getRealContentType never produces —
      // it returned null on every real Baileys message, so msgType silently fell
      // through to normalizeMsgType(null) → "unknown" for every viewOnce message.
      // [FIX] Also removed the unused `viewOnceInnerType` variable — it was assigned
      // but never read by any extractor, allocating a string on every viewOnce call.
      msgType = normalizeMsgType(getRealContentType(rawMessage) || "unknown")
    }
  }

  // audioMessage dengan ptt=true → pttMessage
  if (msgType === "audioMessage" && rawMessage.audioMessage?.ptt === true) {
    msgType = "pttMessage"
  }

  // ── Extract core fields — always required ────────────────
  const body        = extractBody(rawMessage, msgType)
  const mediaInfo   = extractMediaInfo(rawMessage, msgType, isViewOnce)
  const quoted      = extractQuoted(rawMessage, msgType, lidMapOverride)
  const mentions    = extractMentions(rawMessage, msgType)
  const forwardInfo = extractForwardInfo(rawMessage, msgType)  // cheap — one field read

  // ── Extract type-gated fields — skipped for irrelevant types ────────────
  // [PERF] ~90% of messages are text / image / video / audio / sticker / reaction.
  // The original code called all 9 proto extractors unconditionally — that's 9+
  // wasted function calls on every common message, multiplied by thousands during
  // history sync. Each extractor is now guarded to only run when msgType matches.
  const isPoll      = msgType === "pollCreationMessage"
  const isContact   = msgType === "contactMessage" || msgType === "contactsArrayMessage"
  const isReaction  = msgType === "reactionMessage"
  const isLocation  = msgType === "locationMessage" || msgType === "liveLocationMessage"
  const isEvent     = msgType === "eventMessage"    || msgType === "encEventUpdateMessage"
  const isCall      = msgType === "callLogMessage"
  const isInvite    = msgType === "groupInviteMessage"
  const isPin       = msgType === "pinInChatMessage"
  const isKeep      = msgType === "keepInChatMessage"
  const isSchedCall = msgType === "scheduledCallCreationMessage" || msgType === "scheduledCallEditMessage"
  const isAlbum     = msgType === "albumMessage"

  const pollOptions = isPoll      ? extractPollOptions(rawMessage)            : null
  const location    = isLocation  ? extractLocation(rawMessage, msgType)      : null
  const contacts    = isContact   ? extractContacts(rawMessage, msgType)      : null
  const reaction    = isReaction  ? extractReaction(rawMessage)               : null
  const eventInfo   = isEvent     ? extractEvent(rawMessage, msgType)         : null
  const callInfo    = isCall      ? extractCallLog(rawMessage, msgType)       : null
  const groupInvite = isInvite    ? extractGroupInvite(rawMessage, msgType)   : null
  const pinInfo     = isPin       ? extractPinInChat(rawMessage, msgType)     : null
  const keepInfo    = isKeep      ? extractKeepInChat(rawMessage, msgType)    : null
  const schedCall   = isSchedCall ? extractScheduledCall(rawMessage, msgType) : null
  const albumInfo   = isAlbum     ? extractAlbum(rawMessage, msgType)         : null

  // [FIX] Clamped timestamp — Number() on a proto Long is safe, but guard against:
  //   • NaN  (missing field)          → fall back to now
  //   • 0    (unset proto default)    → fall back to now
  //   • far-future clock skew > 1 day → clamp to now to avoid corrupt sort order
  const _nowSecs  = Math.floor(Date.now() / 1000)
  const _rawTs    = Number(msg.messageTimestamp)
  const timestamp = (_rawTs > 0 && _rawTs <= _nowSecs + 86400) ? _rawTs : _nowSecs

  const status = msg.status ?? (isMe ? 1 : 0)

  // [FIX] Guard raw_json serialization — an exotic proto field with a circular
  // ref, Symbol, or BigInt must not crash the parser and silently drop the entire
  // message from the DB. Fast path: plain JSON.stringify. Fallback: replacer that
  // handles BigInt and Buffer. Last resort: store null so the row still saves.
  let raw_json = null
  try {
    raw_json = JSON.stringify(rawMessage)
  } catch (_) {
    try {
      raw_json = JSON.stringify(rawMessage, (_, v) => {
        if (typeof v === "bigint")                          return Number(v)
        if (v instanceof Uint8Array || Buffer.isBuffer(v)) return v.toString("base64")
        return v
      })
    } catch (_2) { /* genuinely unserializable — null is safer than a crash */ }
  }

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
    mimetype:            mediaInfo?.mimetype         || null,
    media_url:           mediaInfo?.url              || null,
    media_saved_path:    null,
    media_size:          mediaInfo?.fileSize         || null,
    media_duration:      mediaInfo?.duration         || null,
    media_filename:      mediaInfo?.fileName         || null,
    media_width:         mediaInfo?.width            || null,
    media_height:        mediaInfo?.height           || null,
    is_animated:         mediaInfo?.isAnimated       ? 1 : 0,
    is_ptt:              mediaInfo?.isPtt            ? 1 : 0,
    is_gif:              mediaInfo?.isGif            ? 1 : 0,
    is_view_once:        isViewOnce                  ? 1 : 0,
    media_thumbnail_b64: mediaInfo?.thumbnailDataUrl || null,
    // [FIX-MEDIA-CRYPTO] Persist crypto fields so expired URLs can be re-downloaded
    // without needing the original live message. Baileys reconstructs the download
    // from mediaKey + directPath + fileEncSha256.
    media_key:           mediaInfo?.mediaKey         || null,
    media_direct_path:   mediaInfo?.directPath       || null,
    media_enc_sha256:    mediaInfo?.encSha256        || null,

    // Quoted
    quoted_id:            quoted?.id                 || null,
    quoted_body:          quoted?.body               || null,
    quoted_sender:        quoted?.sender             || null,
    quoted_type:          quoted?.msgType            || null,
    quoted_has_media:     quoted?.hasMedia           ? 1 : 0,
    quoted_mimetype:      quoted?.mimetype           || null,
    quoted_is_view_once:  quoted?.isViewOnce         ? 1 : 0,
    // [STATUS-REPLY] New fields for status reply display
    is_status_reply:      quoted?.isStatusReply      ? 1 : 0,
    quoted_thumbnail_b64: quoted?.quotedThumbnailB64 || null,
    quoted_status_music:  quoted?.statusMusicInfo    ? JSON.stringify(quoted.statusMusicInfo) : null,

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
    is_forwarded:     forwardInfo.isForwarded     ? 1 : 0,
    forwarding_score: forwardInfo.forwardingScore || 0,

    // Event
    event_name:        eventInfo?.name          || null,
    event_description: eventInfo?.description   || null,
    event_start_time:  eventInfo?.start_time    || null,
    event_end_time:    eventInfo?.end_time      || null,
    event_location:    eventInfo?.location_name || eventInfo?.location_address || null,
    event_join_link:   eventInfo?.join_link     || null,
    event_is_canceled: eventInfo?.is_canceled   ?? null,

    // Call log
    call_is_video:     callInfo?.is_video       ?? null,
    call_outcome:      callInfo?.outcome        || null,
    call_duration:     callInfo?.duration_secs  || null,
    call_participants: callInfo?.participants?.length
      ? JSON.stringify(callInfo.participants)
      : null,

    // Group invite
    group_invite_jid:    groupInvite?.group_jid     || null,
    group_invite_name:   groupInvite?.group_name    || null,
    group_invite_code:   groupInvite?.invite_code   || null,
    group_invite_expiry: groupInvite?.invite_expiry || null,

    // Pin / Keep
    pin_msg_id:  pinInfo?.pinned_msg_id || null,
    pin_type:    pinInfo?.pin_type      || null,
    keep_msg_id: keepInfo?.kept_msg_id  || null,
    keep_type:   keepInfo?.keep_type    || null,

    // Scheduled call
    sched_call_title: schedCall?.title        || null,
    sched_call_at:    schedCall?.scheduled_at || null,
    sched_call_video: schedCall?.is_video     ?? null,

    // Album
    album_count: albumInfo ? (albumInfo.image_count + albumInfo.video_count) : null,

    // Link preview (extendedTextMessage with matchedText/title/description/jpegThumbnail)
    link_preview_url:   rawMessage?.extendedTextMessage?.matchedText   || null,
    link_preview_title: rawMessage?.extendedTextMessage?.title         || null,
    link_preview_desc:  rawMessage?.extendedTextMessage?.description   || null,
    link_preview_thumb: (() => {
      const t = rawMessage?.extendedTextMessage?.jpegThumbnail
      if (!t) return null
      if (typeof t === "string") return t.startsWith("data:") ? t : `data:image/jpeg;base64,${t}`
      if (Buffer.isBuffer(t) || t instanceof Uint8Array) return `data:image/jpeg;base64,${Buffer.from(t).toString("base64")}`
      return null
    })(),

    // Flags
    starred:         msg.starred        ? 1 : 0,
    is_history_sync: opts.isHistorySync ? 1 : 0,

    // Raw — selalu disimpan untuk DevEval & re-parse
    raw_json,
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
  initSock,           // WAJIB untuk Baileys live lid lookup (panggil setelah makeWASocket)
  updateLidMap,       // Panggil di contacts.update (incremental)
  seedLidMap,         // [FIX] seed global map directly from disk-loaded Map
  normalizeJid,       // [FIX-SPLIT-CHAT] pakai ini di database.js & client.js
  decodeJid,          // Baileys dims.decodeJid() compatible
  isLidJid,
  resolveLid,
  tryResolveLid,
  resolveLidAsync,      // async: uses Baileys lidToJid() live lookup
  normalizeJidAsync,    // async normalizeJid with Baileys live lookup
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
  extractMediaInfoAsync,  // async: uses Baileys extractImageThumb/extractVideoThumb/generateThumbnail
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