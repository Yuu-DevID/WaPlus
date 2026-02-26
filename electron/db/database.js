// ╔═══════════════════════════════════════════════════════════╗
// ║         WaPlus — SQLite Database Layer (Full)             ║
// ║   better-sqlite3: synchronous, fast, WAL mode enabled     ║
// ║                                                           ║
// ║  Features:                                                ║
// ║  - History Sync: simpan semua pesan saat offline          ║
// ║  - Semua jenis media WA (image/video/audio/doc/sticker)   ║
// ║  - Special: reaction, poll, location, contact, ephemeral  ║
// ║  - Media download tracking + queue                        ║
// ║  - Poll votes, message edits, delete tracking             ║
// ║  - Sync status log                                        ║
// ╚═══════════════════════════════════════════════════════════╝
"use strict"

const Database = require("better-sqlite3")
const path = require("path")
const fs = require("fs")
const { app } = require("electron")

// ── DB path ────────────────────────────────────────────────
const DB_DIR = path.join(app.getPath("userData"), "WaPlus")
const DB_PATH = path.join(DB_DIR, "waplus.db")

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true })

let db = null

// ════════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════════
function init() {
  if (db) return db
  db = new Database(DB_PATH, { verbose: null })
  db.pragma("journal_mode = WAL")
  db.pragma("synchronous = NORMAL")
  db.pragma("cache_size = -32000")
  db.pragma("temp_store = MEMORY")
  db.pragma("mmap_size = 268435456")
  db.pragma("busy_timeout = 5000")
  db.pragma("foreign_keys = ON")
  runMigrations()
  runSafeMigrations()
  return db
}

// ── Safe column additions ──────────────────────────────────
function runSafeMigrations() {
  const safe = (sql) => { try { db.exec(sql) } catch (_) { } }
  safe(`ALTER TABLE chats ADD COLUMN is_community INTEGER NOT NULL DEFAULT 0`)
  safe(`ALTER TABLE chats ADD COLUMN community_jid TEXT`)
  safe(`ALTER TABLE chats ADD COLUMN muted_until INTEGER NOT NULL DEFAULT 0`)
  safe(`ALTER TABLE messages ADD COLUMN message_json TEXT`)
  safe(`ALTER TABLE messages ADD COLUMN media_url TEXT`)
  safe(`ALTER TABLE messages ADD COLUMN media_mime TEXT`)
  safe(`ALTER TABLE messages ADD COLUMN media_size INTEGER`)
  safe(`ALTER TABLE messages ADD COLUMN media_filename TEXT`)
  safe(`ALTER TABLE messages ADD COLUMN media_duration INTEGER`)
  safe(`ALTER TABLE messages ADD COLUMN media_width INTEGER`)
  safe(`ALTER TABLE messages ADD COLUMN media_height INTEGER`)
  safe(`ALTER TABLE messages ADD COLUMN media_saved_path TEXT`)
  safe(`ALTER TABLE messages ADD COLUMN media_is_downloaded INTEGER NOT NULL DEFAULT 0`)
  safe(`ALTER TABLE messages ADD COLUMN media_download_status TEXT DEFAULT 'pending'`)
  safe(`ALTER TABLE messages ADD COLUMN is_view_once INTEGER NOT NULL DEFAULT 0`)
  safe(`ALTER TABLE messages ADD COLUMN is_ephemeral INTEGER NOT NULL DEFAULT 0`)
  safe(`ALTER TABLE messages ADD COLUMN ephemeral_expiry INTEGER`)
  safe(`ALTER TABLE messages ADD COLUMN poll_options TEXT`)
  safe(`ALTER TABLE messages ADD COLUMN poll_votes TEXT`)
  safe(`ALTER TABLE messages ADD COLUMN location_lat REAL`)
  safe(`ALTER TABLE messages ADD COLUMN location_lng REAL`)
  safe(`ALTER TABLE messages ADD COLUMN location_name TEXT`)
  safe(`ALTER TABLE messages ADD COLUMN location_address TEXT`)
  safe(`ALTER TABLE messages ADD COLUMN contact_display_name TEXT`)
  safe(`ALTER TABLE messages ADD COLUMN contact_vcard TEXT`)
  safe(`ALTER TABLE messages ADD COLUMN reaction_emoji TEXT`)
  safe(`ALTER TABLE messages ADD COLUMN reaction_target_id TEXT`)
  safe(`ALTER TABLE messages ADD COLUMN is_forwarded INTEGER NOT NULL DEFAULT 0`)
  safe(`ALTER TABLE messages ADD COLUMN forward_score INTEGER NOT NULL DEFAULT 0`)
  safe(`ALTER TABLE messages ADD COLUMN edited_at INTEGER`)
  safe(`ALTER TABLE messages ADD COLUMN edit_count INTEGER NOT NULL DEFAULT 0`)
  safe(`ALTER TABLE messages ADD COLUMN quoted_body TEXT`)
  safe(`ALTER TABLE messages ADD COLUMN quoted_sender TEXT`)
  safe(`ALTER TABLE messages ADD COLUMN quoted_type TEXT`)
  safe(`ALTER TABLE messages ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0`)
  safe(`ALTER TABLE messages ADD COLUMN source TEXT DEFAULT 'live'`)
}

// ════════════════════════════════════════════════════════════
// SCHEMA
// ════════════════════════════════════════════════════════════
function runMigrations() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid           TEXT PRIMARY KEY,
      name          TEXT,
      phone         TEXT,
      is_group      INTEGER NOT NULL DEFAULT 0,
      is_community  INTEGER NOT NULL DEFAULT 0,
      community_jid TEXT,
      avatar_url    TEXT,
      last_msg      TEXT,
      last_msg_at   INTEGER NOT NULL DEFAULT 0,
      last_msg_type TEXT,
      unread_count  INTEGER NOT NULL DEFAULT 0,
      pinned        INTEGER NOT NULL DEFAULT 0,
      archived      INTEGER NOT NULL DEFAULT 0,
      muted_until   INTEGER NOT NULL DEFAULT 0,
      updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_chats_last   ON chats(last_msg_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chats_name   ON chats(name);
    CREATE INDEX IF NOT EXISTS idx_chats_pinned ON chats(pinned DESC, last_msg_at DESC);

    CREATE TABLE IF NOT EXISTS contacts (
      jid        TEXT PRIMARY KEY,
      name       TEXT,
      notify     TEXT,
      phone      TEXT,
      avatar_url TEXT,
      is_group   INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_contacts_name  ON contacts(name);
    CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone);

    CREATE TABLE IF NOT EXISTS messages (
      id                   TEXT NOT NULL,
      chat_jid             TEXT NOT NULL,
      sender_jid           TEXT,
      sender_name          TEXT,
      body                 TEXT,
      msg_type             TEXT NOT NULL DEFAULT 'conversation',
      message_json         TEXT,
      media_url            TEXT,
      media_mime           TEXT,
      media_size           INTEGER,
      media_filename       TEXT,
      media_duration       INTEGER,
      media_width          INTEGER,
      media_height         INTEGER,
      media_saved_path     TEXT,
      media_is_downloaded  INTEGER NOT NULL DEFAULT 0,
      media_download_status TEXT DEFAULT 'pending',
      is_view_once         INTEGER NOT NULL DEFAULT 0,
      is_ephemeral         INTEGER NOT NULL DEFAULT 0,
      ephemeral_expiry     INTEGER,
      poll_options         TEXT,
      poll_votes           TEXT,
      location_lat         REAL,
      location_lng         REAL,
      location_name        TEXT,
      location_address     TEXT,
      contact_display_name TEXT,
      contact_vcard        TEXT,
      reaction_emoji       TEXT,
      reaction_target_id   TEXT,
      is_forwarded         INTEGER NOT NULL DEFAULT 0,
      forward_score        INTEGER NOT NULL DEFAULT 0,
      edited_at            INTEGER,
      edit_count           INTEGER NOT NULL DEFAULT 0,
      quoted_id            TEXT,
      quoted_body          TEXT,
      quoted_sender        TEXT,
      quoted_type          TEXT,
      timestamp            INTEGER NOT NULL,
      status               INTEGER NOT NULL DEFAULT 0,
      from_me              INTEGER NOT NULL DEFAULT 0,
      is_group             INTEGER NOT NULL DEFAULT 0,
      has_media            INTEGER NOT NULL DEFAULT 0,
      starred              INTEGER NOT NULL DEFAULT 0,
      is_deleted           INTEGER NOT NULL DEFAULT 0,
      source               TEXT DEFAULT 'live',
      raw                  TEXT,
      created_at           INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (id, chat_jid)
    );
    CREATE INDEX IF NOT EXISTS idx_msg_chat    ON messages(chat_jid, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_msg_ts      ON messages(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_msg_media   ON messages(chat_jid, has_media) WHERE has_media = 1;
    CREATE INDEX IF NOT EXISTS idx_msg_type    ON messages(msg_type);
    CREATE INDEX IF NOT EXISTS idx_msg_source  ON messages(source);

    CREATE TABLE IF NOT EXISTS message_edits (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL,
      chat_jid   TEXT NOT NULL,
      old_body   TEXT,
      new_body   TEXT,
      edited_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_edits ON message_edits(message_id);

    CREATE TABLE IF NOT EXISTS poll_votes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      poll_id     TEXT NOT NULL,
      chat_jid    TEXT NOT NULL,
      voter_jid   TEXT NOT NULL,
      option_name TEXT,
      voted_at    INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(poll_id, voter_jid)
    );
    CREATE INDEX IF NOT EXISTS idx_poll ON poll_votes(poll_id);

    CREATE TABLE IF NOT EXISTS media_queue (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL UNIQUE,
      chat_jid   TEXT NOT NULL,
      media_type TEXT NOT NULL,
      media_url  TEXT,
      status     TEXT NOT NULL DEFAULT 'pending',
      error      TEXT,
      retries    INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_mqueue ON media_queue(status);

    CREATE TABLE IF NOT EXISTS sync_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      finished_at  INTEGER,
      chats_synced INTEGER DEFAULT 0,
      msgs_synced  INTEGER DEFAULT 0,
      status       TEXT DEFAULT 'running'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      id UNINDEXED, chat_jid UNINDEXED,
      body, sender_name,
      content='messages', content_rowid='rowid'
    );
    CREATE TRIGGER IF NOT EXISTS msg_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, id, chat_jid, body, sender_name)
        VALUES (new.rowid, new.id, new.chat_jid, new.body, new.sender_name);
    END;
    CREATE TRIGGER IF NOT EXISTS msg_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, id, chat_jid, body, sender_name)
        VALUES ('delete', old.rowid, old.id, old.chat_jid, old.body, old.sender_name);
    END;
    CREATE TRIGGER IF NOT EXISTS msg_au AFTER UPDATE OF body, sender_name ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, id, chat_jid, body, sender_name)
        VALUES ('delete', old.rowid, old.id, old.chat_jid, old.body, old.sender_name);
      INSERT INTO messages_fts(rowid, id, chat_jid, body, sender_name)
        VALUES (new.rowid, new.id, new.chat_jid, new.body, new.sender_name);
    END;

    CREATE VIRTUAL TABLE IF NOT EXISTS chats_fts USING fts5(
      jid UNINDEXED, name, phone,
      content='chats', content_rowid='rowid'
    );
    CREATE TRIGGER IF NOT EXISTS chat_ai AFTER INSERT ON chats BEGIN
      INSERT INTO chats_fts(rowid, jid, name, phone) VALUES (new.rowid, new.jid, new.name, new.phone);
    END;
    CREATE TRIGGER IF NOT EXISTS chat_au AFTER UPDATE OF name, phone ON chats BEGIN
      INSERT INTO chats_fts(chats_fts, rowid, jid, name, phone) VALUES ('delete', old.rowid, old.jid, old.name, old.phone);
      INSERT INTO chats_fts(rowid, jid, name, phone) VALUES (new.rowid, new.jid, new.name, new.phone);
    END;
    CREATE TRIGGER IF NOT EXISTS chat_ad AFTER DELETE ON chats BEGIN
      INSERT INTO chats_fts(chats_fts, rowid, jid, name, phone) VALUES ('delete', old.rowid, old.jid, old.name, old.phone);
    END;
  `)
}

// ════════════════════════════════════════════════════════════
// PREPARED STATEMENTS
// ════════════════════════════════════════════════════════════
let stmts = null
function getStmts() {
  if (stmts) return stmts
  stmts = {
    upsertChat: db.prepare(`
      INSERT INTO chats (jid,name,phone,is_group,is_community,community_jid,avatar_url,last_msg,last_msg_at,last_msg_type,unread_count,updated_at)
      VALUES (@jid,@name,@phone,@is_group,@is_community,@community_jid,@avatar_url,@last_msg,@last_msg_at,@last_msg_type,@unread_count,unixepoch())
      ON CONFLICT(jid) DO UPDATE SET
        name=COALESCE(excluded.name,chats.name), phone=COALESCE(excluded.phone,chats.phone),
        is_community=CASE WHEN excluded.is_community=1 THEN 1 ELSE chats.is_community END,
        community_jid=COALESCE(excluded.community_jid,chats.community_jid),
        avatar_url=COALESCE(excluded.avatar_url,chats.avatar_url),
        last_msg=CASE WHEN excluded.last_msg_at>=chats.last_msg_at THEN excluded.last_msg ELSE chats.last_msg END,
        last_msg_at=MAX(excluded.last_msg_at,chats.last_msg_at),
        last_msg_type=CASE WHEN excluded.last_msg_at>=chats.last_msg_at THEN excluded.last_msg_type ELSE chats.last_msg_type END,
        unread_count=chats.unread_count+excluded.unread_count,
        updated_at=unixepoch()
    `),
    getChat: db.prepare(`SELECT * FROM chats WHERE jid = ?`),
    getChats: db.prepare(`SELECT * FROM chats WHERE archived=0 ORDER BY pinned DESC,last_msg_at DESC LIMIT ? OFFSET ?`),
    getChatCount: db.prepare(`SELECT COUNT(*) as total FROM chats WHERE archived=0`),
    getGroups: db.prepare(`SELECT * FROM chats WHERE is_group=1 AND is_community=0 AND archived=0 ORDER BY pinned DESC,last_msg_at DESC LIMIT ? OFFSET ?`),
    getGroupCount: db.prepare(`SELECT COUNT(*) as total FROM chats WHERE is_group=1 AND is_community=0 AND archived=0`),
    getCommunities: db.prepare(`SELECT * FROM chats WHERE is_community=1 ORDER BY name ASC LIMIT ? OFFSET ?`),
    getCommunityCount: db.prepare(`SELECT COUNT(*) as total FROM chats WHERE is_community=1`),
    markChatRead: db.prepare(`UPDATE chats SET unread_count=0 WHERE jid=?`),
    updateChatUnread: db.prepare(`UPDATE chats SET unread_count=? WHERE jid=?`),
    pinChat: db.prepare(`UPDATE chats SET pinned=@pinned WHERE jid=@jid`),
    archiveChat: db.prepare(`UPDATE chats SET archived=@archived WHERE jid=@jid`),
    searchChats: db.prepare(`SELECT c.* FROM chats c JOIN chats_fts f ON c.rowid=f.rowid WHERE chats_fts MATCH ? ORDER BY c.pinned DESC,c.last_msg_at DESC LIMIT 50`),

    upsertContact: db.prepare(`
      INSERT INTO contacts(jid,name,notify,phone,avatar_url,is_group,updated_at)
      VALUES(@jid,@name,@notify,@phone,@avatar_url,@is_group,unixepoch())
      ON CONFLICT(jid) DO UPDATE SET
        name=COALESCE(excluded.name,contacts.name), notify=COALESCE(excluded.notify,contacts.notify),
        phone=COALESCE(excluded.phone,contacts.phone), avatar_url=COALESCE(excluded.avatar_url,contacts.avatar_url),
        updated_at=unixepoch()
    `),
    getContacts: db.prepare(`SELECT * FROM contacts WHERE is_group=0 ORDER BY name ASC LIMIT ? OFFSET ?`),
    getContactCount: db.prepare(`SELECT COUNT(*) as total FROM contacts WHERE is_group=0`),
    searchContacts: db.prepare(`SELECT * FROM contacts WHERE (name LIKE ? OR phone LIKE ? OR notify LIKE ?) AND is_group=0 ORDER BY name ASC LIMIT 50`),

    insertMessage: db.prepare(`
      INSERT OR IGNORE INTO messages(
        id,chat_jid,sender_jid,sender_name,body,msg_type,message_json,
        media_url,media_mime,media_size,media_filename,media_duration,media_width,media_height,
        media_is_downloaded,media_download_status,
        is_view_once,is_ephemeral,ephemeral_expiry,
        poll_options,poll_votes,
        location_lat,location_lng,location_name,location_address,
        contact_display_name,contact_vcard,
        reaction_emoji,reaction_target_id,
        is_forwarded,forward_score,
        quoted_id,quoted_body,quoted_sender,quoted_type,
        timestamp,status,from_me,is_group,has_media,starred,is_deleted,source,raw
      ) VALUES(
        @id,@chat_jid,@sender_jid,@sender_name,@body,@msg_type,@message_json,
        @media_url,@media_mime,@media_size,@media_filename,@media_duration,@media_width,@media_height,
        @media_is_downloaded,@media_download_status,
        @is_view_once,@is_ephemeral,@ephemeral_expiry,
        @poll_options,@poll_votes,
        @location_lat,@location_lng,@location_name,@location_address,
        @contact_display_name,@contact_vcard,
        @reaction_emoji,@reaction_target_id,
        @is_forwarded,@forward_score,
        @quoted_id,@quoted_body,@quoted_sender,@quoted_type,
        @timestamp,@status,@from_me,@is_group,@has_media,@starred,@is_deleted,@source,@raw
      )
    `),
    getMessages: db.prepare(`SELECT * FROM messages WHERE chat_jid=? AND is_deleted=0 ORDER BY timestamp ASC LIMIT ? OFFSET ?`),
    getMessageById: db.prepare(`SELECT * FROM messages WHERE id=? LIMIT 1`),
    getMessageCount: db.prepare(`SELECT COUNT(*) as total FROM messages WHERE chat_jid=? AND is_deleted=0`),
    updateStatus: db.prepare(`UPDATE messages SET status=? WHERE id=?`),
    markDeleted: db.prepare(`UPDATE messages SET is_deleted=1 WHERE id=?`),
    updateEdited: db.prepare(`UPDATE messages SET body=@body,edited_at=unixepoch(),edit_count=edit_count+1 WHERE id=@id`),
    updatePollVotes: db.prepare(`UPDATE messages SET poll_votes=@votes WHERE id=@id`),
    updateMedia: db.prepare(`UPDATE messages SET media_saved_path=@path,media_is_downloaded=@dl,media_download_status=@status WHERE id=@id`),
    searchMessages: db.prepare(`SELECT m.* FROM messages m JOIN messages_fts f ON m.rowid=f.rowid WHERE messages_fts MATCH ? AND m.chat_jid=? ORDER BY m.timestamp DESC LIMIT 50`),
    searchGlobal: db.prepare(`SELECT m.*,c.name as chat_name FROM messages m JOIN messages_fts f ON m.rowid=f.rowid JOIN chats c ON m.chat_jid=c.jid WHERE messages_fts MATCH ? ORDER BY m.timestamp DESC LIMIT 100`),

    upsertPollVote: db.prepare(`
      INSERT INTO poll_votes(poll_id,chat_jid,voter_jid,option_name,voted_at)
      VALUES(@poll_id,@chat_jid,@voter_jid,@option_name,unixepoch())
      ON CONFLICT(poll_id,voter_jid) DO UPDATE SET option_name=excluded.option_name,voted_at=unixepoch()
    `),

    insertMediaQueue: db.prepare(`
      INSERT OR IGNORE INTO media_queue(message_id,chat_jid,media_type,media_url,status)
      VALUES(@message_id,@chat_jid,@media_type,@media_url,'pending')
    `),
    updateMediaQueue: db.prepare(`UPDATE media_queue SET status=@status,error=@error,updated_at=unixepoch() WHERE message_id=@message_id`),
    getPendingMedia: db.prepare(`SELECT * FROM media_queue WHERE status='pending' ORDER BY created_at ASC LIMIT 50`),

    startSync: db.prepare(`INSERT INTO sync_log(started_at,status) VALUES(unixepoch(),'running')`),
    endSync: db.prepare(`UPDATE sync_log SET finished_at=unixepoch(),chats_synced=@chats,msgs_synced=@msgs,status='done' WHERE id=(SELECT MAX(id) FROM sync_log WHERE status='running')`),
    getLastSync: db.prepare(`SELECT * FROM sync_log WHERE status='done' ORDER BY finished_at DESC LIMIT 1`),
  }
  return stmts
}

// ════════════════════════════════════════════════════════════
// MESSAGE PARSING HELPERS
// ════════════════════════════════════════════════════════════

function detectMsgType(message) {
  if (!message) return "conversation"
  const keys = [
    "conversation", "extendedTextMessage", "imageMessage", "videoMessage", "audioMessage",
    "documentMessage", "stickerMessage", "reactionMessage",
    "pollCreationMessage", "pollCreationMessageV2", "pollCreationMessageV3", "pollUpdateMessage",
    "locationMessage", "liveLocationMessage", "contactMessage", "contactsArrayMessage",
    "groupInviteMessage", "viewOnceMessage", "viewOnceMessageV2", "ephemeralMessage",
    "protocolMessage", "buttonsMessage", "buttonsResponseMessage", "listMessage", "listResponseMessage",
    "templateMessage", "templateButtonReplyMessage", "interactiveMessage", "interactiveResponseMessage",
    "documentWithCaptionMessage", "orderMessage", "productMessage", "invoiceMessage",
    "requestPaymentMessage", "sendPaymentMessage", "pinInChatMessage", "callLogMessage",
    "keepInChatMessage", "nativeFlowResponseMessage",
  ]
  for (const k of keys) {
    if (message[k]) {
      // Normalize poll variants
      if (k.startsWith("pollCreation")) return "pollCreationMessage"
      return k
    }
  }
  return "unknown"
}

function extractBody(message) {
  if (!message) return ""
  const m = message.ephemeralMessage?.message ||
    message.viewOnceMessage?.message?.imageMessage ||
    message.viewOnceMessageV2?.message?.imageMessage || message
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.documentMessage?.title ||
    m.audioMessage?.caption ||
    m.documentWithCaptionMessage?.message?.documentMessage?.caption ||
    m.pollCreationMessage?.name ||
    m.pollCreationMessageV2?.name ||
    m.pollCreationMessageV3?.name ||
    m.reactionMessage?.text ||
    m.locationMessage?.name ||
    m.liveLocationMessage?.caption ||
    m.contactMessage?.displayName ||
    m.contactsArrayMessage?.displayName ||
    m.groupInviteMessage?.groupName ||
    m.buttonsMessage?.contentText ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    m.interactiveMessage?.body?.text ||
    m.orderMessage?.message ||
    ""
  )
}

function extractQuoted(contextInfo) {
  if (!contextInfo?.quotedMessage) return {}
  return {
    quoted_id: contextInfo.stanzaId || null,
    quoted_body: extractBody(contextInfo.quotedMessage) || null,
    quoted_sender: contextInfo.participant || contextInfo.remoteJid || null,
    quoted_type: detectMsgType(contextInfo.quotedMessage) || null,
  }
}

function extractMedia(message, msgType) {
  let mediaMsg = null
  if (msgType === "documentWithCaptionMessage") {
    mediaMsg = message.documentWithCaptionMessage?.message?.documentMessage
  } else if (["imageMessage", "videoMessage", "audioMessage", "documentMessage", "stickerMessage", "pttMessage"].includes(msgType)) {
    mediaMsg = message[msgType]
  }
  if (!mediaMsg) return { has_media: 0, media_is_downloaded: 0, media_download_status: "pending" }
  return {
    has_media: 1,
    media_url: mediaMsg.url || null,
    media_mime: mediaMsg.mimetype || null,
    media_size: mediaMsg.fileLength ? Number(mediaMsg.fileLength) : null,
    media_filename: mediaMsg.fileName || mediaMsg.title || null,
    media_duration: mediaMsg.seconds || null,
    media_width: mediaMsg.width || null,
    media_height: mediaMsg.height || null,
    media_is_downloaded: 0,
    media_download_status: "pending",
  }
}

// ════════════════════════════════════════════════════════════
// MAIN SAVE MESSAGE (from Baileys WAMessage)
// ════════════════════════════════════════════════════════════
function saveMessage(msg, isHistorySync = false, source = "live") {
  init()
  if (!msg?.message) return { success: false }
  const jid = msg.key?.remoteJid || ""
  if (!jid) return { success: false }

  let message = msg.message
  let isEphemeral = false, isViewOnce = false, ephemeralExpiry = null

  if (message.ephemeralMessage?.message) {
    isEphemeral = true
    ephemeralExpiry = message.ephemeralMessage?.expirationStartTimestamp || null
    message = message.ephemeralMessage.message
  }
  if (message.viewOnceMessage?.message) { isViewOnce = true; message = message.viewOnceMessage.message }
  if (message.viewOnceMessageV2?.message) { isViewOnce = true; message = message.viewOnceMessageV2.message }

  const msgType = detectMsgType(message)
  const body = extractBody(message)
  const mediaInfo = extractMedia(message, msgType)

  // Context info (for quoted + forward)
  const ctxKeys = ["extendedTextMessage", "imageMessage", "videoMessage", "audioMessage", "documentMessage", "stickerMessage", "pollCreationMessage"]
  let contextInfo = null
  for (const k of ctxKeys) {
    if (message[k]?.contextInfo) { contextInfo = message[k].contextInfo; break }
  }
  const quotedInfo = extractQuoted(contextInfo)
  const isForwarded = contextInfo?.isForwarded || false
  const forwardScore = contextInfo?.forwardingScore || 0

  // Poll
  const pollMsg = message.pollCreationMessage || message.pollCreationMessageV2 || message.pollCreationMessageV3
  const pollOptions = pollMsg
    ? JSON.stringify((pollMsg.options || []).map(o => ({ name: o.optionName || o.name, votes: 0 })))
    : null

  // Location
  const locMsg = message.locationMessage || message.liveLocationMessage
  const locationLat = locMsg?.degreesLatitude || null
  const locationLng = locMsg?.degreesLongitude || null
  const locationName = locMsg?.name || null
  const locationAddress = locMsg?.address || null

  // Contact
  const contactMsg = message.contactMessage
  const contactName = contactMsg?.displayName || null
  const contactVcard = contactMsg?.vcard || null

  // Reaction
  const reactionMsg = message.reactionMessage
  const reactionEmoji = reactionMsg?.text || null
  const reactionTargetId = reactionMsg?.key?.id || null

  const isGroup = jid.endsWith("@g.us")
  const isMe = msg.key?.fromMe || false
  const sender = isMe ? "" : (msg.key?.participant || msg.participant || jid)
  const pushname = msg.pushName || ""
  const ts = Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000)
  const msgId = msg.key?.id || `${ts}_${Math.random().toString(36).slice(2)}`

  ensureChatExists(jid, isGroup, ts, body, msgType, isMe)

  let messageJson = null
  if (mediaInfo.has_media) {
    try { messageJson = JSON.stringify(msg.message) } catch (_) { }
  }

  const record = {
    id: msgId, chat_jid: jid, sender_jid: sender || null, sender_name: pushname || null,
    body: body || null, msg_type: msgType, message_json: messageJson,
    ...mediaInfo,
    is_view_once: isViewOnce ? 1 : 0, is_ephemeral: isEphemeral ? 1 : 0, ephemeral_expiry: ephemeralExpiry,
    poll_options: pollOptions, poll_votes: null,
    location_lat: locationLat, location_lng: locationLng, location_name: locationName, location_address: locationAddress,
    contact_display_name: contactName, contact_vcard: contactVcard,
    reaction_emoji: reactionEmoji, reaction_target_id: reactionTargetId,
    is_forwarded: isForwarded ? 1 : 0, forward_score: forwardScore,
    ...quotedInfo,
    timestamp: ts, status: msg.status ?? 0,
    from_me: isMe ? 1 : 0, is_group: isGroup ? 1 : 0,
    starred: msg.starred ? 1 : 0, is_deleted: 0,
    source, raw: null,
  }

  try {
    getStmts().insertMessage.run(record)
  } catch (err) {
    if (!err.message?.includes("UNIQUE")) console.error("[WaPlus DB]", err.message)
    return { success: false, duplicate: true }
  }

  return { success: true, type: msgType, hasMedia: mediaInfo.has_media === 1, isViewOnce, isEphemeral }
}

function ensureChatExists(jid, isGroup, ts, body, msgType, isMe) {
  init()
  const existing = getStmts().getChat.get(jid)
  if (!existing) {
    getStmts().upsertChat.run({
      jid, name: null, phone: jid.split("@")[0] || null,
      is_group: isGroup ? 1 : 0, is_community: 0, community_jid: null, avatar_url: null,
      last_msg: body || null, last_msg_at: ts, last_msg_type: msgType || null,
      unread_count: isMe ? 0 : 1,
    })
  } else if (ts >= (existing.last_msg_at || 0)) {
    db.prepare(`
      UPDATE chats SET
        last_msg=CASE WHEN ?>=last_msg_at THEN ? ELSE last_msg END,
        last_msg_at=MAX(?,last_msg_at),
        last_msg_type=CASE WHEN ?>=last_msg_at THEN ? ELSE last_msg_type END,
        unread_count=unread_count+CASE WHEN ?=0 THEN 1 ELSE 0 END,
        updated_at=unixepoch()
      WHERE jid=?
    `).run(ts, body, ts, ts, msgType, isMe ? 1 : 0, jid)
  }
}

// ════════════════════════════════════════════════════════════
// CHATS
// ════════════════════════════════════════════════════════════
function upsertChat(data) {
  init()
  return getStmts().upsertChat.run({
    jid: data.jid || "", name: data.name || null, phone: data.phone || data.jid?.split("@")[0] || null,
    is_group: data.isGroup ? 1 : 0, is_community: data.isCommunity ? 1 : 0,
    community_jid: data.communityJid || null, avatar_url: data.avatarUrl || null,
    last_msg: data.lastMsg || null, last_msg_at: data.lastMsgAt || 0,
    last_msg_type: data.lastMsgType || null, unread_count: data.unreadDelta || 0,
  })
}

function saveChat(chat) {
  init()
  const jid = chat.id || chat.jid || ""
  if (!jid) return
  const isCommunity = jid.endsWith("@newsletter") || chat.isCommunity === true
  const isGroup = jid.endsWith("@g.us")
  getStmts().upsertChat.run({
    jid, name: chat.name || chat.subject || null, phone: jid.split("@")[0] || null,
    is_group: isGroup ? 1 : 0, is_community: isCommunity ? 1 : 0,
    community_jid: chat.linkedParent || null, avatar_url: null,
    last_msg: null, last_msg_at: chat.conversationTimestamp ? Number(chat.conversationTimestamp) : 0,
    last_msg_type: null, unread_count: Math.max(0, chat.unreadCount || 0),
  })
}

function getChats(limit = 60, offset = 0) { init(); return getStmts().getChats.all(limit, offset) }
function getChatCount() { init(); return getStmts().getChatCount.get().total }
function getGroups(limit = 200, offset = 0) { init(); return getStmts().getGroups.all(limit, offset) }
function getGroupCount() { init(); return getStmts().getGroupCount.get().total }
function getCommunities(limit = 100, offset = 0) { init(); return getStmts().getCommunities.all(limit, offset) }
function getCommunityCount() { init(); return getStmts().getCommunityCount.get().total }
function markChatRead(jid) { init(); return getStmts().markChatRead.run(jid) }
function updateChatUnread(jid, count) { init(); return getStmts().updateChatUnread.run(count, jid) }
function pinChat(jid, pinned) { init(); return getStmts().pinChat.run({ jid, pinned: pinned ? 1 : 0 }) }
function archiveChat(jid, archived) { init(); return getStmts().archiveChat.run({ jid, archived: archived ? 1 : 0 }) }
function updateChatRead(jid) { return markChatRead(jid) }
function updateChatPinned(jid, pinned) { return pinChat(jid, pinned) }
function updateChatArchived(jid, archived) { return archiveChat(jid, archived) }

function searchChats(query) {
  init()
  try { return getStmts().searchChats.all(`"${query.replace(/"/g, '""')}"*`) }
  catch { return db.prepare(`SELECT * FROM chats WHERE (name LIKE ? OR phone LIKE ?) AND archived=0 ORDER BY pinned DESC,last_msg_at DESC LIMIT 50`).all(`%${query}%`, `%${query}%`) }
}

// ════════════════════════════════════════════════════════════
// CONTACTS
// ════════════════════════════════════════════════════════════
function upsertContact(data) {
  init()
  return getStmts().upsertContact.run({
    jid: data.jid || "", name: data.name || data.notify || null, notify: data.notify || null,
    phone: data.phone || null, avatar_url: data.avatarUrl || null, is_group: data.isGroup ? 1 : 0,
  })
}
function bulkUpsertContacts(contacts) { return saveContacts(contacts) }
function saveContacts(contacts) {
  init()
  const tx = db.transaction((list) => {
    for (const c of list) {
      try {
        getStmts().upsertContact.run({
          jid: c.id || c.jid || "", name: c.name || c.notify || null, notify: c.notify || null,
          phone: (c.id || c.jid || "").split("@")[0] || null, avatar_url: null,
          is_group: ((c.id || c.jid || "").endsWith("@g.us")) ? 1 : 0,
        })
      } catch (_) { }
    }
  })
  tx(contacts)
}
function getContacts(limit = 100, offset = 0) { init(); return getStmts().getContacts.all(limit, offset) }
function getContactCount() { init(); return getStmts().getContactCount.get().total }
function searchContacts(query) { init(); const q = `%${query}%`; return getStmts().searchContacts.all(q, q, q) }

// ════════════════════════════════════════════════════════════
// MESSAGES
// ════════════════════════════════════════════════════════════
function insertMessage(data) {
  init()
  ensureChatExists(data.chat_jid, data.is_group, data.timestamp, data.body, data.msg_type, data.from_me)
  return getStmts().insertMessage.run({
    id: data.id,
    chat_jid: data.chat_jid,
    sender_jid: data.sender_jid || null,
    sender_name: data.sender_name || null,
    body: data.body || null,
    msg_type: data.msg_type || "conversation",
    message_json: null,

    // ← INI yang kurang, semua harus ada walau null:
    media_url: null,
    media_mime: null,
    media_size: null,
    media_filename: null,
    media_duration: null,
    media_width: null,
    media_height: null,
    media_is_downloaded: 0,
    media_download_status: "pending",

    is_view_once: 0,
    is_ephemeral: 0,
    ephemeral_expiry: null,

    poll_options: null,
    poll_votes: null,

    location_lat: null,
    location_lng: null,
    location_name: null,
    location_address: null,

    contact_display_name: null,
    contact_vcard: null,

    reaction_emoji: null,
    reaction_target_id: null,

    is_forwarded: 0,
    forward_score: 0,

    quoted_id: data.quoted_id || null,
    quoted_body: null,
    quoted_sender: null,
    quoted_type: null,

    timestamp: data.timestamp,
    status: data.status || 0,
    from_me: data.from_me || 0,
    is_group: data.is_group || 0,
    has_media: data.has_media || 0,
    starred: data.starred || 0,
    is_deleted: 0,
    source: "live",
    raw: data.raw || null,
  })
}

function bulkInsertMessages(messages) {
  init()
  const tx = db.transaction((list) => { for (const m of list) { try { insertMessage(m) } catch (_) { } } })
  tx(messages)
}

function getMessages(chatJid, limit = 50, offset = 0) { init(); return getStmts().getMessages.all(chatJid, limit, offset) }
function getMessageCount(chatJid) { init(); return getStmts().getMessageCount.get(chatJid).total }
function getMessageById(id) { init(); return getStmts().getMessageById.get(id) }

function updateMessageStatus(id, status) {
  init()
  if (status === -1) return getStmts().markDeleted.run(id)
  return getStmts().updateStatus.run(status, id)
}

function saveMessageEdit(id, newBody, editedAt) {
  init()
  const existing = getStmts().getMessageById.get(id)
  if (!existing) return
  db.prepare(`INSERT INTO message_edits(message_id,chat_jid,old_body,new_body,edited_at) VALUES(?,?,?,?,?)`).run(
    id, existing.chat_jid, existing.body, newBody, Math.floor(editedAt / 1000)
  )
  getStmts().updateEdited.run({ id, body: newBody })
}

function savePollVote(pollId, voterJid, vote) {
  init()
  const poll = getStmts().getMessageById.get(pollId)
  getStmts().upsertPollVote.run({
    poll_id: pollId, chat_jid: poll?.chat_jid || "",
    voter_jid: voterJid, option_name: Array.isArray(vote) ? vote[0] : (vote || null),
  })
}

function updatePollVotes(pollId, aggregatedVotes) {
  init()
  getStmts().updatePollVotes.run({ id: pollId, votes: JSON.stringify(aggregatedVotes) })
}

function searchMessages(chatJid, query) {
  init()
  try { return getStmts().searchMessages.all(`"${query.replace(/"/g, '""')}"*`, chatJid) }
  catch { return db.prepare(`SELECT * FROM messages WHERE chat_jid=? AND body LIKE ? ORDER BY timestamp DESC LIMIT 50`).all(chatJid, `%${query}%`) }
}

function searchMessagesGlobal(query) {
  init()
  try { return getStmts().searchGlobal.all(`"${query.replace(/"/g, '""')}"*`) }
  catch { return db.prepare(`SELECT m.*,c.name as chat_name FROM messages m JOIN chats c ON m.chat_jid=c.jid WHERE m.body LIKE ? ORDER BY m.timestamp DESC LIMIT 50`).all(`%${query}%`) }
}

// ════════════════════════════════════════════════════════════
// MEDIA
// ════════════════════════════════════════════════════════════
function queueMediaDownload(messageId, chatJid, mediaType, mediaUrl) {
  init()
  try { getStmts().insertMediaQueue.run({ message_id: messageId, chat_jid: chatJid, media_type: mediaType, media_url: mediaUrl }) }
  catch (_) { }
}

function updateMediaDownload(messageId, localPath, size, status = "downloaded", error = null) {
  init()
  try {
    getStmts().updateMedia.run({ id: messageId, path: localPath, dl: status === "downloaded" ? 1 : 0, status })
    getStmts().updateMediaQueue.run({ message_id: messageId, status: status === "downloaded" ? "done" : status, error: error || null })
  } catch (_) { }
}

function getPendingMediaDownloads() { init(); return getStmts().getPendingMedia.all() }

// ════════════════════════════════════════════════════════════
// SYNC LOG
// ════════════════════════════════════════════════════════════
function startSync() { init(); try { getStmts().startSync.run() } catch (_) { } }
function endSync(chatsSynced = 0, msgsSynced = 0) { init(); try { getStmts().endSync.run({ chats: chatsSynced, msgs: msgsSynced }) } catch (_) { } }
function getSyncStatus() {
  init()
  try {
    const last = getStmts().getLastSync.get()
    return { lastSync: last?.finished_at || null, chatsSynced: last?.chats_synced || 0, msgsSynced: last?.msgs_synced || 0 }
  } catch { return { lastSync: null, chatsSynced: 0, msgsSynced: 0 } }
}

// ════════════════════════════════════════════════════════════
// STATS & CLOSE
// ════════════════════════════════════════════════════════════
function getStats() {
  init()
  return {
    chats: getChatCount(), contacts: getContactCount(), groups: getGroupCount(), communities: getCommunityCount(),
    messages: db.prepare("SELECT COUNT(*) as total FROM messages WHERE is_deleted=0").get().total,
    media: db.prepare("SELECT COUNT(*) as total FROM messages WHERE has_media=1 AND is_deleted=0").get().total,
  }
}

function close() { if (db) { db.close(); db = null; stmts = null } }

module.exports = {
  init, close, getStats,
  upsertChat, saveChat, getChats, getChatCount, getGroups, getGroupCount, getCommunities, getCommunityCount,
  searchChats, markChatRead, updateChatUnread, pinChat, archiveChat, updateChatRead, updateChatPinned, updateChatArchived,
  upsertContact, bulkUpsertContacts, saveContacts, getContacts, getContactCount, searchContacts,
  saveMessage, insertMessage, bulkInsertMessages, getMessages, getMessageCount, getMessageById,
  updateMessageStatus, saveMessageEdit, savePollVote, updatePollVotes, searchMessages, searchMessagesGlobal,
  queueMediaDownload, updateMediaDownload, getPendingMediaDownloads,
  startSync, endSync, getSyncStatus,
  // Export helpers for client.js
  extractBody, detectMsgType,
}
