"use strict"

// ════════════════════════════════════════════════════════════
// PROTO EXTRACTORS
// WAProto-specific message types: Event, CallLog, GroupInvite,
// PinInChat, KeepInChat, ScheduledCall, Album
// ════════════════════════════════════════════════════════════

// ── Event (WAProto: EventMessage) ─────────────────────────────

/**
 * extractEvent — extract WA Event details.
 * Fields: name, description, startTime, endTime, location, joinLink, isCanceled
 */
function extractEvent(message, msgType) {
  if (msgType !== "eventMessage") return null
  const ev = message.eventMessage?.event || message.eventMessage
  if (!ev) return null

  return {
    name:             ev.name        || null,
    description:      ev.description || null,
    start_time:       ev.startTime   ? Number(ev.startTime)  : null,
    end_time:         ev.endTime     ? Number(ev.endTime)    : null,
    location_name:    ev.location?.name              || null,
    location_address: ev.location?.address           || null,
    location_lat:     ev.location?.degreesLatitude   || null,
    location_lng:     ev.location?.degreesLongitude  || null,
    join_link:        ev.joinLink    || null,
    is_canceled:      ev.isCanceled  ? 1 : 0,
  }
}

// ── Call log (WAProto: CallLogMessage) ────────────────────────

const CALL_OUTCOMES = { 1: "answered", 2: "missed", 4: "declined", 8: "failed" }

/**
 * extractCallLog — extract call log metadata.
 * callOutcome enum: CONNECTED(1), MISSED(2), DECLINED(4), FAILED(8)
 */
function extractCallLog(message, msgType) {
  if (msgType !== "callLogMessage") return null
  const cl = message.callLogMessage
  if (!cl) return null

  return {
    is_video:      cl.isVideo     ? 1 : 0,
    outcome:       CALL_OUTCOMES[cl.callOutcome] || CALL_OUTCOMES[cl.callResult] || "unknown",
    duration_secs: cl.durationSecs || null,
    participants:  (cl.participants || []).map(p => p.jid || p).filter(Boolean),
  }
}

// ── Group invite (WAProto: GroupInviteMessage) ─────────────────

/**
 * extractGroupInvite — extract group invite details.
 * groupType: 0=DEFAULT, 1=PARENT (community)
 */
function extractGroupInvite(message, msgType) {
  if (msgType !== "groupInviteMessage") return null
  const gi = message.groupInviteMessage
  if (!gi) return null

  return {
    group_jid:     gi.groupJid         || null,
    group_name:    gi.groupName        || null,
    invite_code:   gi.inviteCode       || null,
    invite_expiry: gi.inviteExpiration ? Number(gi.inviteExpiration) : null,
    caption:       gi.caption          || null,
    group_type:    gi.groupType        ?? 0,
  }
}

// ── Pin in chat (WAProto: PinInChatMessage) ────────────────────

/**
 * extractPinInChat — extract pinned message metadata.
 * type: PIN(1), UNPIN(2)
 */
function extractPinInChat(message, msgType) {
  if (msgType !== "pinInChatMessage") return null
  const pin = message.pinInChatMessage
  if (!pin) return null

  return {
    pinned_msg_id:  pin.key?.id        || null,
    pinned_chat_id: pin.key?.remoteJid || null,
    pin_type:       pin.type === 2 ? "unpin" : "pin",
  }
}

// ── Keep in chat (WAProto: KeepInChatMessage) ─────────────────

/**
 * extractKeepInChat — extract keep-in-chat metadata.
 * keepType: KEEP_FOR_ALL(1), UNDO_KEEP_FOR_ALL(2)
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

// ── Scheduled call (WAProto: ScheduledCallCreationMessage) ─────

/**
 * extractScheduledCall — extract scheduled call details.
 * callType: AUDIO(1), VIDEO(2)
 */
function extractScheduledCall(message, msgType) {
  if (msgType !== "scheduledCallCreationMessage" && msgType !== "scheduledCallEditMessage") return null
  const sc = message.scheduledCallCreationMessage || message.scheduledCallEditMessage
  if (!sc) return null

  return {
    title:         sc.title               || null,
    scheduled_at:  sc.scheduledTimestamp  ? Number(sc.scheduledTimestamp) : null,
    is_video:      sc.callType === 2      ? 1 : 0,
    duration_secs: sc.duration            || null,
    participants:  (sc.callParticipants || []).map(p => p.jid || p).filter(Boolean),
  }
}

// ── Album (WAProto: AlbumMessage) ─────────────────────────────

/**
 * extractAlbum — extract album metadata.
 * Individual media items arrive as separate messages referencing this album.
 */
function extractAlbum(message, msgType) {
  if (msgType !== "albumMessage") return null
  const album = message.albumMessage
  if (!album) return null

  return {
    image_count: album.expectedImageCount || 0,
    video_count: album.expectedVideoCount || 0,
    total:       (album.expectedImageCount || 0) + (album.expectedVideoCount || 0),
  }
}

module.exports = {
  extractEvent,
  extractCallLog,
  extractGroupInvite,
  extractPinInChat,
  extractKeepInChat,
  extractScheduledCall,
  extractAlbum,
}
