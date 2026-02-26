// ╔═══════════════════════════════════════════════════════════╗
// ║             AuroraChat — SQLite Database Layer            ║
// ║   better-sqlite3: synchronous, fast, WAL mode enabled     ║
// ╚═══════════════════════════════════════════════════════════╝
"use strict"

const Database = require("better-sqlite3")
const path = require("path")
const fs = require("fs")
const { app } = require("electron")

// ── DB path ────────────────────────────────────────────────
const DB_DIR = path.join(app.getPath("userData"), "AuroraChat")
const DB_PATH = path.join(DB_DIR, "aurora.db")

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true })

let db = null

// ════════════════════════════════════════════════════════════
// INIT — open DB and run migrations
// ════════════════════════════════════════════════════════════
function init() {
    if (db) return db

    db = new Database(DB_PATH, { verbose: null })

    // Performance: WAL mode + busy timeout
    db.pragma("journal_mode = WAL")
    db.pragma("synchronous = NORMAL")
    db.pragma("cache_size = -32000")   // 32 MB cache
    db.pragma("temp_store = MEMORY")
    db.pragma("mmap_size = 268435456") // 256 MB mmap
    db.pragma("busy_timeout = 5000")

    runMigrations()
    // Safe column additions for existing DBs
    try { db.exec(`ALTER TABLE chats ADD COLUMN is_community INTEGER NOT NULL DEFAULT 0`) } catch (_) {}
    try { db.exec(`ALTER TABLE chats ADD COLUMN community_jid TEXT`) } catch (_) {}
    return db
}

// ════════════════════════════════════════════════════════════
// SCHEMA
// ════════════════════════════════════════════════════════════
function runMigrations() {
    db.exec(`
    -- Chats / conversations
    CREATE TABLE IF NOT EXISTS chats (
      jid          TEXT PRIMARY KEY,
      name         TEXT,
      phone        TEXT,
      is_group     INTEGER NOT NULL DEFAULT 0,
      is_community INTEGER NOT NULL DEFAULT 0,
      community_jid TEXT,
      avatar_url   TEXT,
      last_msg     TEXT,
      last_msg_at  INTEGER NOT NULL DEFAULT 0,
      last_msg_type TEXT,
      unread_count INTEGER NOT NULL DEFAULT 0,
      pinned       INTEGER NOT NULL DEFAULT 0,
      archived     INTEGER NOT NULL DEFAULT 0,
      muted_until  INTEGER NOT NULL DEFAULT 0,
      updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Attempt to add new columns if they don't exist (safe migration)
    -- SQLite will ignore these if columns already exist via the INSERT path

    CREATE INDEX IF NOT EXISTS idx_chats_last ON chats(last_msg_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chats_name ON chats(name);
    CREATE INDEX IF NOT EXISTS idx_chats_pinned ON chats(pinned DESC, last_msg_at DESC);

    -- Contacts
    CREATE TABLE IF NOT EXISTS contacts (
      jid          TEXT PRIMARY KEY,
      name         TEXT,
      notify       TEXT,
      phone        TEXT,
      avatar_url   TEXT,
      is_group     INTEGER NOT NULL DEFAULT 0,
      updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name);
    CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone);

    -- Messages
    CREATE TABLE IF NOT EXISTS messages (
      id           TEXT NOT NULL,
      chat_jid     TEXT NOT NULL REFERENCES chats(jid) ON DELETE CASCADE,
      sender_jid   TEXT,
      sender_name  TEXT,
      body         TEXT,
      msg_type     TEXT NOT NULL DEFAULT 'conversation',
      timestamp    INTEGER NOT NULL,
      status       INTEGER NOT NULL DEFAULT 0,
      from_me      INTEGER NOT NULL DEFAULT 0,
      is_group     INTEGER NOT NULL DEFAULT 0,
      has_media    INTEGER NOT NULL DEFAULT 0,
      starred      INTEGER NOT NULL DEFAULT 0,
      quoted_id    TEXT,
      raw          TEXT,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (id, chat_jid)
    );

    CREATE INDEX IF NOT EXISTS idx_msg_chat     ON messages(chat_jid, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_msg_ts       ON messages(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_msg_from_me  ON messages(chat_jid, from_me);
    CREATE INDEX IF NOT EXISTS idx_msg_starred  ON messages(starred) WHERE starred = 1;

    -- FTS5 for full-text search on messages
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      id UNINDEXED,
      chat_jid UNINDEXED,
      body,
      sender_name,
      content='messages',
      content_rowid='rowid'
    );

    -- Triggers to keep FTS in sync
    CREATE TRIGGER IF NOT EXISTS msg_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, id, chat_jid, body, sender_name)
        VALUES (new.rowid, new.id, new.chat_jid, new.body, new.sender_name);
    END;

    CREATE TRIGGER IF NOT EXISTS msg_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, id, chat_jid, body, sender_name)
        VALUES ('delete', old.rowid, old.id, old.chat_jid, old.body, old.sender_name);
    END;

    CREATE TRIGGER IF NOT EXISTS msg_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, id, chat_jid, body, sender_name)
        VALUES ('delete', old.rowid, old.id, old.chat_jid, old.body, old.sender_name);
      INSERT INTO messages_fts(rowid, id, chat_jid, body, sender_name)
        VALUES (new.rowid, new.id, new.chat_jid, new.body, new.sender_name);
    END;

    -- FTS5 for chats/contacts search
    CREATE VIRTUAL TABLE IF NOT EXISTS chats_fts USING fts5(
      jid UNINDEXED,
      name,
      phone,
      content='chats',
      content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS chat_ai AFTER INSERT ON chats BEGIN
      INSERT INTO chats_fts(rowid, jid, name, phone)
        VALUES (new.rowid, new.jid, new.name, new.phone);
    END;

    CREATE TRIGGER IF NOT EXISTS chat_au AFTER UPDATE OF name, phone ON chats BEGIN
      INSERT INTO chats_fts(chats_fts, rowid, jid, name, phone)
        VALUES ('delete', old.rowid, old.jid, old.name, old.phone);
      INSERT INTO chats_fts(rowid, jid, name, phone)
        VALUES (new.rowid, new.jid, new.name, new.phone);
    END;

    CREATE TRIGGER IF NOT EXISTS chat_ad AFTER DELETE ON chats BEGIN
      INSERT INTO chats_fts(chats_fts, rowid, jid, name, phone)
        VALUES ('delete', old.rowid, old.jid, old.name, old.phone);
    END;
  `)
}

// ════════════════════════════════════════════════════════════
// PREPARED STATEMENTS (compiled once, reused many times)
// ════════════════════════════════════════════════════════════
let stmts = null

function getStmts() {
    if (stmts) return stmts
    stmts = {
        // ── Chats ──────────────────────────────────────────────
        upsertChat: db.prepare(`
      INSERT INTO chats (jid, name, phone, is_group, is_community, community_jid, avatar_url, last_msg, last_msg_at, last_msg_type, unread_count, updated_at)
      VALUES (@jid, @name, @phone, @is_group, @is_community, @community_jid, @avatar_url, @last_msg, @last_msg_at, @last_msg_type, @unread_count, unixepoch())
      ON CONFLICT(jid) DO UPDATE SET
        name         = COALESCE(excluded.name, chats.name),
        phone        = COALESCE(excluded.phone, chats.phone),
        is_community = CASE WHEN excluded.is_community = 1 THEN 1 ELSE chats.is_community END,
        community_jid= COALESCE(excluded.community_jid, chats.community_jid),
        avatar_url   = COALESCE(excluded.avatar_url, chats.avatar_url),
        last_msg     = CASE WHEN excluded.last_msg_at >= chats.last_msg_at THEN excluded.last_msg ELSE chats.last_msg END,
        last_msg_at  = MAX(excluded.last_msg_at, chats.last_msg_at),
        last_msg_type= CASE WHEN excluded.last_msg_at >= chats.last_msg_at THEN excluded.last_msg_type ELSE chats.last_msg_type END,
        unread_count = chats.unread_count + excluded.unread_count,
        updated_at   = unixepoch()
    `),

        updateChatName: db.prepare(`
      UPDATE chats SET name = @name, updated_at = unixepoch() WHERE jid = @jid
    `),

        markChatRead: db.prepare(`
      UPDATE chats SET unread_count = 0 WHERE jid = ?
    `),

        getChats: db.prepare(`
      SELECT * FROM chats
      WHERE archived = 0
      ORDER BY pinned DESC, last_msg_at DESC
      LIMIT ? OFFSET ?
    `),

        getChatCount: db.prepare(`SELECT COUNT(*) as total FROM chats WHERE archived = 0`),

        getGroups: db.prepare(`
      SELECT * FROM chats
      WHERE is_group = 1 AND is_community = 0 AND archived = 0
      ORDER BY pinned DESC, last_msg_at DESC
      LIMIT ? OFFSET ?
    `),

        getGroupCount: db.prepare(`SELECT COUNT(*) as total FROM chats WHERE is_group = 1 AND is_community = 0 AND archived = 0`),

        getCommunities: db.prepare(`
      SELECT * FROM chats
      WHERE is_community = 1
      ORDER BY name ASC
      LIMIT ? OFFSET ?
    `),

        getCommunityCount: db.prepare(`SELECT COUNT(*) as total FROM chats WHERE is_community = 1`),

        getChat: db.prepare(`SELECT * FROM chats WHERE jid = ?`),

        searchChats: db.prepare(`
      SELECT c.* FROM chats c
      JOIN chats_fts f ON c.rowid = f.rowid
      WHERE chats_fts MATCH ?
      ORDER BY c.pinned DESC, c.last_msg_at DESC
      LIMIT 50
    `),

        pinChat: db.prepare(`UPDATE chats SET pinned = @pinned WHERE jid = @jid`),
        archiveChat: db.prepare(`UPDATE chats SET archived = @archived WHERE jid = @jid`),

        // ── Contacts ────────────────────────────────────────────
        upsertContact: db.prepare(`
      INSERT INTO contacts (jid, name, notify, phone, avatar_url, is_group, updated_at)
      VALUES (@jid, @name, @notify, @phone, @avatar_url, @is_group, unixepoch())
      ON CONFLICT(jid) DO UPDATE SET
        name       = COALESCE(excluded.name, contacts.name),
        notify     = COALESCE(excluded.notify, contacts.notify),
        phone      = COALESCE(excluded.phone, contacts.phone),
        avatar_url = COALESCE(excluded.avatar_url, contacts.avatar_url),
        updated_at = unixepoch()
    `),

        getContacts: db.prepare(`
      SELECT * FROM contacts
      WHERE is_group = 0
      ORDER BY name ASC
      LIMIT ? OFFSET ?
    `),

        getContactCount: db.prepare(`SELECT COUNT(*) as total FROM contacts WHERE is_group = 0`),

        searchContacts: db.prepare(`
      SELECT c.* FROM contacts c
      WHERE (c.name LIKE ? OR c.phone LIKE ? OR c.notify LIKE ?)
        AND c.is_group = 0
      ORDER BY c.name ASC
      LIMIT 50
    `),

        // ── Messages ────────────────────────────────────────────
        insertMessage: db.prepare(`
      INSERT OR IGNORE INTO messages
        (id, chat_jid, sender_jid, sender_name, body, msg_type, timestamp, status, from_me, is_group, has_media, starred, quoted_id, raw)
      VALUES
        (@id, @chat_jid, @sender_jid, @sender_name, @body, @msg_type, @timestamp, @status, @from_me, @is_group, @has_media, @starred, @quoted_id, @raw)
    `),

        getMessages: db.prepare(`
      SELECT * FROM messages
      WHERE chat_jid = ?
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `),

        getMessageCount: db.prepare(`
      SELECT COUNT(*) as total FROM messages WHERE chat_jid = ?
    `),

        searchMessages: db.prepare(`
      SELECT m.* FROM messages m
      JOIN messages_fts f ON m.rowid = f.rowid
      WHERE messages_fts MATCH ? AND m.chat_jid = ?
      ORDER BY m.timestamp DESC
      LIMIT 50
    `),

        searchMessagesGlobal: db.prepare(`
      SELECT m.*, c.name as chat_name FROM messages m
      JOIN messages_fts f ON m.rowid = f.rowid
      JOIN chats c ON m.chat_jid = c.jid
      WHERE messages_fts MATCH ?
      ORDER BY m.timestamp DESC
      LIMIT 50
    `),

        updateMessageStatus: db.prepare(`
      UPDATE messages SET status = @status WHERE id = @id AND chat_jid = @chat_jid
    `),

        toggleStar: db.prepare(`
      UPDATE messages SET starred = (1 - starred) WHERE id = ? AND chat_jid = ?
    `),
    }
    return stmts
}

// ════════════════════════════════════════════════════════════
// PUBLIC API
// ════════════════════════════════════════════════════════════

// ── Chats ─────────────────────────────────────────────────

function upsertChat(data) {
    const s = getStmts()
    return s.upsertChat.run({
        jid: data.jid || "",
        name: data.name || null,
        phone: data.phone || null,
        is_group: data.isGroup ? 1 : 0,
        is_community: data.isCommunity ? 1 : 0,
        community_jid: data.communityJid || null,
        avatar_url: data.avatarUrl || null,
        last_msg: data.lastMsg || null,
        last_msg_at: data.lastMsgAt || 0,
        last_msg_type: data.lastMsgType || null,
        unread_count: data.unreadDelta || 0,
    })
}

function getChats(limit = 50, offset = 0) {
    init()
    return getStmts().getChats.all(limit, offset)
}

function getChatCount() {
    init()
    return getStmts().getChatCount.get().total
}

function getGroups(limit = 200, offset = 0) {
    init()
    return getStmts().getGroups.all(limit, offset)
}

function getGroupCount() {
    init()
    return getStmts().getGroupCount.get().total
}

function getCommunities(limit = 100, offset = 0) {
    init()
    return getStmts().getCommunities.all(limit, offset)
}

function getCommunityCount() {
    init()
    return getStmts().getCommunityCount.get().total
}

function searchChats(query) {
    init()
    try {
        const q = `"${query.replace(/"/g, '""')}"*`
        return getStmts().searchChats.all(q)
    } catch {
        // Fallback to LIKE if FTS fails
        return db.prepare(`
      SELECT * FROM chats
      WHERE (name LIKE ? OR phone LIKE ?) AND archived = 0
      ORDER BY pinned DESC, last_msg_at DESC LIMIT 50
    `).all(`%${query}%`, `%${query}%`)
    }
}

function markChatRead(jid) {
    init()
    return getStmts().markChatRead.run(jid)
}

function pinChat(jid, pinned) {
    init()
    return getStmts().pinChat.run({ jid, pinned: pinned ? 1 : 0 })
}

function archiveChat(jid, archived) {
    init()
    return getStmts().archiveChat.run({ jid, archived: archived ? 1 : 0 })
}

// ── Contacts ───────────────────────────────────────────────

function upsertContact(data) {
    init()
    return getStmts().upsertContact.run({
        jid: data.jid || "",
        name: data.name || data.notify || null,
        notify: data.notify || null,
        phone: data.phone || null,
        avatar_url: data.avatarUrl || null,
        is_group: data.isGroup ? 1 : 0,
    })
}

function bulkUpsertContacts(contacts) {
    init()
    const s = getStmts()
    const tx = db.transaction((list) => {
        for (const c of list) s.upsertContact.run({
            jid: c.id || c.jid || "",
            name: c.name || c.notify || null,
            notify: c.notify || null,
            phone: c.id?.split("@")[0] || null,
            avatar_url: null,
            is_group: (c.id || "").endsWith("@g.us") ? 1 : 0,
        })
    })
    tx(contacts)
}

function getContacts(limit = 100, offset = 0) {
    init()
    return getStmts().getContacts.all(limit, offset)
}

function getContactCount() {
    init()
    return getStmts().getContactCount.get().total
}

function searchContacts(query) {
    init()
    const q = `%${query}%`
    return getStmts().searchContacts.all(q, q, q)
}

// ── Messages ───────────────────────────────────────────────

function insertMessage(data) {
    init()
    // Ensure chat exists first
    const s = getStmts()
    s.upsertChat.run({
        jid: data.chat_jid,
        name: null,
        phone: null,
        is_group: data.is_group ? 1 : 0,
        is_community: 0,
        community_jid: null,
        avatar_url: null,
        last_msg: data.body || null,
        last_msg_at: data.timestamp || 0,
        last_msg_type: data.msg_type || null,
        unread_count: data.from_me ? 0 : 1,
    })
    return s.insertMessage.run(data)
}

function bulkInsertMessages(messages) {
    init()
    const s = getStmts()
    const tx = db.transaction((list) => {
        for (const m of list) {
            try { s.insertMessage.run(m) } catch (_) { }
        }
    })
    tx(messages)
}

function getMessages(chatJid, limit = 50, offset = 0) {
    init()
    return getStmts().getMessages.all(chatJid, limit, offset)
}

function getMessageCount(chatJid) {
    init()
    return getStmts().getMessageCount.get(chatJid).total
}

function searchMessages(chatJid, query) {
    init()
    try {
        const q = `"${query.replace(/"/g, '""')}"*`
        return getStmts().searchMessages.all(q, chatJid)
    } catch {
        return db.prepare(`
      SELECT * FROM messages
      WHERE chat_jid = ? AND body LIKE ?
      ORDER BY timestamp DESC LIMIT 50
    `).all(chatJid, `%${query}%`)
    }
}

function searchMessagesGlobal(query) {
    init()
    try {
        const q = `"${query.replace(/"/g, '""')}"*`
        return getStmts().searchMessagesGlobal.all(q)
    } catch {
        return db.prepare(`
      SELECT m.*, c.name as chat_name FROM messages m
      JOIN chats c ON m.chat_jid = c.jid
      WHERE m.body LIKE ?
      ORDER BY m.timestamp DESC LIMIT 50
    `).all(`%${query}%`)
    }
}

function updateMessageStatus(id, chatJid, status) {
    init()
    return getStmts().updateMessageStatus.run({ id, chat_jid: chatJid, status })
}

// ── Misc ───────────────────────────────────────────────────

function getStats() {
    init()
    return {
        chats: getChatCount(),
        contacts: getContactCount(),
        messages: db.prepare("SELECT COUNT(*) as total FROM messages").get().total,
    }
}

function close() {
    if (db) { db.close(); db = null; stmts = null }
}

module.exports = {
    init,
    close,
    getStats,
    // Chats
    upsertChat,
    getChats,
    getChatCount,
    getGroups,
    getGroupCount,
    getCommunities,
    getCommunityCount,
    searchChats,
    markChatRead,
    pinChat,
    archiveChat,
    // Contacts
    upsertContact,
    bulkUpsertContacts,
    getContacts,
    getContactCount,
    searchContacts,
    // Messages
    insertMessage,
    bulkInsertMessages,
    getMessages,
    getMessageCount,
    searchMessages,
    searchMessagesGlobal,
    updateMessageStatus,
}
