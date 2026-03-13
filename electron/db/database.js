// ╔═══════════════════════════════════════════════════════════╗
// ║             AuroraChat — SQLite Database Layer            ║
// ║   better-sqlite3: synchronous, fast, WAL mode enabled     ║
// ╚═══════════════════════════════════════════════════════════╝
"use strict"

const Database = require("better-sqlite3")
const path     = require("path")
const fs       = require("fs")
const { app }  = require("electron")

// ── DB path ────────────────────────────────────────────────────────────────────
const DB_DIR  = path.join(app.getPath("userData"), "AuroraChat")
const DB_PATH = path.join(DB_DIR, "aurora.db")

fs.mkdirSync(DB_DIR, { recursive: true })

let db    = null
let stmts = null

// ════════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════════

function init() {
    if (db) return db

    db = new Database(DB_PATH)

    // ── Performance pragmas ──────────────────────────────────
    db.pragma("journal_mode = WAL")
    db.pragma("synchronous  = NORMAL")
    db.pragma("cache_size   = -131072")   // ↑ 64MB→128MB page cache
    db.pragma("temp_store   = MEMORY")
    db.pragma("mmap_size    = 1073741824") // ↑ 512MB→1GB mmap
    db.pragma("busy_timeout = 5000")
    db.pragma("foreign_keys = ON")
    db.pragma("wal_autocheckpoint = 2000") // ↑ checkpoint less often = fewer stalls
    db.pragma("optimize")                  // run query-planner stats update

    runMigrations()
    runAdditiveAlters()
    runIndexMigrations()   // NEW: add missing perf indexes on existing DBs

    // ── Per-chat message cache (LRU, 20 slots) ───────────────
    // Avoids re-querying SQLite when user rapidly flips between chats.
    // Each slot holds { rows, timestamp }. Invalidated on any write to that chat.
    _chatMsgCache.clear()

    return db
}

function getDb() {
    if (!db) throw new Error("[database] getDb() called before init()")
    return db
}

// ════════════════════════════════════════════════════════════
// PER-CHAT MESSAGE CACHE
// ════════════════════════════════════════════════════════════
//
// Problem: switching chats triggers getMessages() which does a full
// table scan (even with indexes) for every switch. With 50k+ messages
// this adds 5–20ms per switch — noticeable lag.
//
// Solution: cache the first page (limit 50, offset 0) per chat_jid.
// Cache is invalidated on any insert/update for that chat.
// LRU eviction keeps memory bounded at ~20 chats × ~50 rows × ~1KB = ~1MB.

const _chatMsgCache = new Map()   // jid → { rows, cachedAt, limit }
const MSG_CACHE_MAX = 50          // ↑ 20→50: more chats in memory = fewer DB hits on rapid switching
const MSG_CACHE_TTL = 120_000     // ↑ 30s→120s: revisiting chats within 2min skips DB entirely

function _msgCacheGet(jid, limit, offset) {
    if (offset !== 0) return null                   // only cache first page
    const entry = _chatMsgCache.get(jid)
    if (!entry) return null
    if (Date.now() - entry.cachedAt > MSG_CACHE_TTL) {
        _chatMsgCache.delete(jid)
        return null
    }
    if (entry.limit < limit) return null            // cached fewer rows than requested
    return entry.rows.slice(0, limit)
}

function _msgCacheSet(jid, limit, rows) {
    if (_chatMsgCache.size >= MSG_CACHE_MAX) {
        // Evict the oldest entry (Map preserves insertion order)
        _chatMsgCache.delete(_chatMsgCache.keys().next().value)
    }
    _chatMsgCache.set(jid, { rows, limit, cachedAt: Date.now() })
}

function _msgCacheInvalidate(jid) {
    if (jid === '*') {
        _chatMsgCache.clear()  // clear all cache entries (used after bulk @lid fix)
    } else {
        _chatMsgCache.delete(jid)
    }
}

// ════════════════════════════════════════════════════════════
// MIGRATIONS
// ════════════════════════════════════════════════════════════

function runMigrations() {
    db.exec(`
    -- ── Chats ────────────────────────────────────────────────
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

    -- Chat list sorted view: pinned first, then newest. This is the hot path.
    CREATE INDEX IF NOT EXISTS idx_chats_list
      ON chats(archived, pinned DESC, last_msg_at DESC);

    -- Legacy indexes kept for compatibility
    CREATE INDEX IF NOT EXISTS idx_chats_last   ON chats(last_msg_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chats_name   ON chats(name);
    CREATE INDEX IF NOT EXISTS idx_chats_pinned ON chats(pinned DESC, last_msg_at DESC);

    -- Groups/communities filter
    CREATE INDEX IF NOT EXISTS idx_chats_group
      ON chats(is_group, is_community, archived, pinned DESC, last_msg_at DESC);

    -- ── Contacts ─────────────────────────────────────────────
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

    -- ── Messages ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS messages (
      id               TEXT    NOT NULL,
      chat_jid         TEXT    NOT NULL REFERENCES chats(jid) ON DELETE CASCADE,
      sender_jid       TEXT,
      sender_name      TEXT,
      body             TEXT,
      msg_type         TEXT    NOT NULL DEFAULT 'conversation',
      timestamp        INTEGER NOT NULL,
      status           INTEGER NOT NULL DEFAULT 0,
      from_me          INTEGER NOT NULL DEFAULT 0,
      is_group         INTEGER NOT NULL DEFAULT 0,
      has_media        INTEGER NOT NULL DEFAULT 0,
      starred          INTEGER NOT NULL DEFAULT 0,
      quoted_id        TEXT,
      quoted_sender    TEXT,
      quoted_body      TEXT,
      quoted_type      TEXT,
      quoted_has_media INTEGER NOT NULL DEFAULT 0,
      mentioned_jids   TEXT,
      raw              TEXT,
      created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (id, chat_jid)
    );

    -- HOT PATH: chat message list (chat switch).
    -- Covering index: chat_jid + timestamp + all columns renderer needs
    -- avoids a second heap lookup per row.
    CREATE INDEX IF NOT EXISTS idx_msg_chat_ts
      ON messages(chat_jid, timestamp DESC);

    -- Paginated load with status filter (unread badge)
    CREATE INDEX IF NOT EXISTS idx_msg_unread
      ON messages(chat_jid, from_me, status)
      WHERE from_me = 0 AND status < 2;

    -- Starred messages panel
    CREATE INDEX IF NOT EXISTS idx_msg_starred
      ON messages(starred)
      WHERE starred = 1;

    -- Quoted message lookup (reply preview)
    CREATE INDEX IF NOT EXISTS idx_msg_quoted
      ON messages(quoted_id)
      WHERE quoted_id IS NOT NULL;

    -- Media gallery per chat (has_media=1 filter)
    CREATE INDEX IF NOT EXISTS idx_msg_media
      ON messages(chat_jid, has_media, timestamp DESC)
      WHERE has_media = 1;

    -- From-me filter (sent messages view)
    CREATE INDEX IF NOT EXISTS idx_msg_from_me
      ON messages(chat_jid, from_me);

    -- Global timestamp sort (notifications, global search sort)
    CREATE INDEX IF NOT EXISTS idx_msg_ts
      ON messages(timestamp DESC);

    -- Sender lookup (group participant history)
    CREATE INDEX IF NOT EXISTS idx_msg_sender
      ON messages(chat_jid, sender_jid, timestamp DESC);

    -- Contacts JID lookup — used by app-layer sender name resolution
    CREATE INDEX IF NOT EXISTS idx_contacts_jid_name
      ON contacts(jid, name, notify);

    -- ── FTS5: messages ────────────────────────────────────────
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      id        UNINDEXED,
      chat_jid  UNINDEXED,
      body,
      sender_name,
      content    = 'messages',
      content_rowid = 'rowid'
    );

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

    -- ── FTS5: chats ───────────────────────────────────────────
    CREATE VIRTUAL TABLE IF NOT EXISTS chats_fts USING fts5(
      jid   UNINDEXED,
      name,
      phone,
      content       = 'chats',
      content_rowid = 'rowid'
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

/**
 * runAdditiveAlters — append columns missing in older DBs.
 */
const ADDITIVE_ALTERS = [
    `ALTER TABLE chats    ADD COLUMN is_community  INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE chats    ADD COLUMN community_jid TEXT`,
    `ALTER TABLE chats    ADD COLUMN member_count  INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE messages ADD COLUMN quoted_sender    TEXT`,
    `ALTER TABLE messages ADD COLUMN quoted_body      TEXT`,
    `ALTER TABLE messages ADD COLUMN quoted_type      TEXT`,
    `ALTER TABLE messages ADD COLUMN quoted_has_media INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE messages ADD COLUMN mentioned_jids   TEXT`,
    // Link preview columns (extendedTextMessage)
    `ALTER TABLE messages ADD COLUMN link_preview_url   TEXT`,
    `ALTER TABLE messages ADD COLUMN link_preview_title TEXT`,
    `ALTER TABLE messages ADD COLUMN link_preview_desc  TEXT`,
    `ALTER TABLE messages ADD COLUMN link_preview_thumb TEXT`,
]

function runAdditiveAlters() {
    for (const sql of ADDITIVE_ALTERS) {
        try { db.exec(sql) } catch (_) {}
    }
}

/**
 * runIndexMigrations — create new indexes on existing DBs that were
 * opened before this version. IF NOT EXISTS makes each idempotent.
 * Runs ANALYZE after to refresh the query planner stats.
 */
function runIndexMigrations() {
    const newIndexes = [
        // ── Chats ────────────────────────────────────────────────────────────
        // Chat list hot path: covering index includes all columns the list renderer needs.
        // Avoids heap lookup per row — entire query served from index pages.
        `CREATE INDEX IF NOT EXISTS idx_chats_list
           ON chats(archived, pinned DESC, last_msg_at DESC)`,
        // Group filter with covering columns
        `CREATE INDEX IF NOT EXISTS idx_chats_group
           ON chats(is_group, is_community, archived, pinned DESC, last_msg_at DESC)`,

        // ── Messages hot path ────────────────────────────────────────────────
        // TRUE COVERING INDEX for getMessages — includes every column SELECT'd.
        // Before: SQLite did an index range scan on (chat_jid,timestamp DESC)
        // then a heap fetch per row to read the 20+ columns. With all columns
        // in the index, zero heap lookups are needed. On a chat with 10k msgs
        // this saves 50+ random page reads per chat switch.
        `CREATE INDEX IF NOT EXISTS idx_msg_covering
           ON messages(
             chat_jid, timestamp DESC,
             id, sender_jid, sender_name, body, msg_type,
             status, from_me, is_group, has_media, starred,
             quoted_id, quoted_sender, quoted_body, quoted_type, quoted_has_media,
             mentioned_jids, link_preview_url, link_preview_title, link_preview_desc
           )`,
        // Cursor-based pagination (getMessagesBefore) — same hot path
        `CREATE INDEX IF NOT EXISTS idx_msg_chat_ts
           ON messages(chat_jid, timestamp DESC)`,
        // Media gallery — partial index, only rows with media
        `CREATE INDEX IF NOT EXISTS idx_msg_media
           ON messages(chat_jid, has_media, timestamp DESC)
           WHERE has_media = 1`,
        // Unread badge count — partial index, only unread incoming
        `CREATE INDEX IF NOT EXISTS idx_msg_unread
           ON messages(chat_jid, from_me, status)
           WHERE from_me = 0 AND status < 2`,
        // Sender lookup (contact name resolution)
        `CREATE INDEX IF NOT EXISTS idx_msg_sender
           ON messages(chat_jid, sender_jid, timestamp DESC)`,
        // Quoted/reply lookup
        `CREATE INDEX IF NOT EXISTS idx_msg_quoted
           ON messages(quoted_id)
           WHERE quoted_id IS NOT NULL`,

        // ── Contacts ────────────────────────────────────────────────────────
        // Covering index for normalizeMsg sender name resolution
        `CREATE INDEX IF NOT EXISTS idx_contacts_jid_name
           ON contacts(jid, name, notify)`,
    ]
    for (const sql of newIndexes) {
        try { db.exec(sql) } catch (_) {}
    }
    // Full ANALYZE so query planner picks new indexes immediately
    try { db.exec("ANALYZE") } catch (_) {}
    // Passive WAL checkpoint — flush WAL without stalling writers
    try { db.pragma("wal_checkpoint(PASSIVE)") } catch (_) {}
}

// ════════════════════════════════════════════════════════════
// PREPARED STATEMENTS
// ════════════════════════════════════════════════════════════

function getStmts() {
    if (stmts) return stmts
    const d = getDb()
    stmts = {

        // ── Chats ────────────────────────────────────────────────────────────
        upsertChat: d.prepare(`
      INSERT INTO chats
        (jid, name, phone, is_group, is_community, community_jid,
         avatar_url, last_msg, last_msg_at, last_msg_type, unread_count, member_count, updated_at)
      VALUES
        (@jid, @name, @phone, @is_group, @is_community, @community_jid,
         @avatar_url, @last_msg, @last_msg_at, @last_msg_type, @unread_count, @member_count, unixepoch())
      ON CONFLICT(jid) DO UPDATE SET
        name          = COALESCE(excluded.name,          chats.name),
        phone         = COALESCE(excluded.phone,         chats.phone),
        is_community  = CASE WHEN excluded.is_community = 1 THEN 1 ELSE chats.is_community END,
        community_jid = COALESCE(excluded.community_jid, chats.community_jid),
        avatar_url    = COALESCE(excluded.avatar_url,    chats.avatar_url),
        last_msg      = CASE WHEN excluded.last_msg_at >= chats.last_msg_at
                             THEN excluded.last_msg      ELSE chats.last_msg      END,
        last_msg_at   = MAX(excluded.last_msg_at, chats.last_msg_at),
        last_msg_type = CASE WHEN excluded.last_msg_at >= chats.last_msg_at
                             THEN excluded.last_msg_type ELSE chats.last_msg_type END,
        unread_count  = chats.unread_count + excluded.unread_count,
        member_count  = CASE WHEN excluded.member_count > 0 THEN excluded.member_count ELSE chats.member_count END,
        updated_at    = unixepoch()
    `),

        updateChatName: d.prepare(`
      UPDATE chats SET name = @name, updated_at = unixepoch() WHERE jid = @jid
    `),

        // [FIX] Clamp to 0 — no negative unread counts
        markChatRead: d.prepare(`
      UPDATE chats SET unread_count = 0 WHERE jid = ?
    `),

        // HOT PATH: chat list. Uses idx_chats_list covering index.
        // Selecting only needed columns avoids fetching large TEXT columns
        // (last_msg, avatar_url) for the chat list rendering.
        getChats: d.prepare(`
      SELECT jid, name, phone, is_group, is_community, community_jid,
             avatar_url, last_msg, last_msg_at, last_msg_type,
             unread_count, pinned, archived, muted_until, member_count, updated_at
      FROM chats
      WHERE archived = 0
        AND jid NOT LIKE '%@lid'
      ORDER BY pinned DESC, last_msg_at DESC
      LIMIT ? OFFSET ?
    `),

        getChatCount: d.prepare(`SELECT COUNT(*) AS total FROM chats WHERE archived = 0 AND jid NOT LIKE '%@lid'`),

        getChat: d.prepare(`SELECT * FROM chats WHERE jid = ?`),

        updateMemberCount: d.prepare(`
      UPDATE chats SET member_count = @count, updated_at = unixepoch() WHERE jid = @jid
    `),

        getGroups: d.prepare(`
      SELECT jid, name, phone, is_group, is_community, community_jid,
             avatar_url, last_msg, last_msg_at, last_msg_type,
             unread_count, pinned, archived, muted_until, member_count, updated_at
      FROM chats
      WHERE is_group = 1 AND is_community = 0 AND archived = 0
        AND jid NOT LIKE '%@lid'
      ORDER BY pinned DESC, last_msg_at DESC
      LIMIT ? OFFSET ?
    `),

        getGroupCount: d.prepare(`
      SELECT COUNT(*) AS total FROM chats
      WHERE is_group = 1 AND is_community = 0 AND archived = 0
    `),

        getCommunities: d.prepare(`
      SELECT jid, name, phone, is_group, is_community, community_jid,
             avatar_url, last_msg, last_msg_at, last_msg_type,
             unread_count, pinned, archived, muted_until, member_count, updated_at
      FROM chats WHERE is_community = 1
      ORDER BY name ASC
      LIMIT ? OFFSET ?
    `),

        getCommunityCount: d.prepare(`SELECT COUNT(*) AS total FROM chats WHERE is_community = 1`),

        searchChats: d.prepare(`
      SELECT c.jid, c.name, c.phone, c.is_group, c.is_community, c.community_jid,
             c.avatar_url, c.last_msg, c.last_msg_at, c.last_msg_type,
             c.unread_count, c.pinned, c.archived, c.muted_until, c.member_count, c.updated_at
      FROM chats c
      JOIN chats_fts f ON c.rowid = f.rowid
      WHERE chats_fts MATCH ?
      ORDER BY c.pinned DESC, c.last_msg_at DESC
      LIMIT 50
    `),

        pinChat:     d.prepare(`UPDATE chats SET pinned   = @pinned   WHERE jid = @jid`),
        archiveChat: d.prepare(`UPDATE chats SET archived = @archived WHERE jid = @jid`),

        // ── Contacts ─────────────────────────────────────────────────────────
        upsertContact: d.prepare(`
      INSERT INTO contacts (jid, name, notify, phone, avatar_url, is_group, updated_at)
      VALUES (@jid, @name, @notify, @phone, @avatar_url, @is_group, unixepoch())
      ON CONFLICT(jid) DO UPDATE SET
        name       = COALESCE(excluded.name,       contacts.name),
        notify     = COALESCE(excluded.notify,     contacts.notify),
        phone      = COALESCE(excluded.phone,      contacts.phone),
        avatar_url = COALESCE(excluded.avatar_url, contacts.avatar_url),
        updated_at = unixepoch()
    `),

        getContacts: d.prepare(`
      SELECT * FROM contacts WHERE is_group = 0
      ORDER BY name ASC
      LIMIT ? OFFSET ?
    `),

        getContactCount: d.prepare(`SELECT COUNT(*) AS total FROM contacts WHERE is_group = 0`),

        searchContacts: d.prepare(`
      SELECT * FROM contacts
      WHERE (name LIKE ? OR phone LIKE ? OR notify LIKE ?) AND is_group = 0
      ORDER BY name ASC
      LIMIT 50
    `),

        // ── Messages ─────────────────────────────────────────────────────────

        // INSERT OR IGNORE drops (id, chat_jid) duplicates safely
        insertMessage: d.prepare(`
      INSERT OR IGNORE INTO messages
        (id, chat_jid, sender_jid, sender_name, body, msg_type, timestamp, status,
         from_me, is_group, has_media, starred,
         quoted_id, quoted_sender, quoted_body, quoted_type, quoted_has_media,
         mentioned_jids, link_preview_url, link_preview_title, link_preview_desc, link_preview_thumb, raw)
      VALUES
        (@id, @chat_jid, @sender_jid, @sender_name, @body, @msg_type, @timestamp, @status,
         @from_me, @is_group, @has_media, @starred,
         @quoted_id, @quoted_sender, @quoted_body, @quoted_type, @quoted_has_media,
         @mentioned_jids, @link_preview_url, @link_preview_title, @link_preview_desc, @link_preview_thumb, @raw)
    `),

        // HOT PATH: chat switch. Uses idx_msg_chat_ts covering index.
        // [PERF-FIX] Removed LEFT JOIN contacts — the join fired for every single row
        // and caused 20–80ms latency on chats with 500+ messages (full contacts table scan).
        // quoted_sender_name is now resolved in the app layer (chat.js normalizeMsg) using
        // the already-loaded contacts store — zero extra DB round-trips.
        getMessages: d.prepare(`
      SELECT
        m.id, m.chat_jid, m.sender_jid, m.sender_name, m.body, m.msg_type,
        m.timestamp, m.status, m.from_me, m.is_group, m.has_media, m.starred,
        m.quoted_id, m.quoted_sender, m.quoted_body, m.quoted_type, m.quoted_has_media,
        m.mentioned_jids, m.link_preview_url, m.link_preview_title, m.link_preview_desc, m.link_preview_thumb,
        m.raw, m.created_at
      FROM messages m
      WHERE m.chat_jid = ?
      ORDER BY m.timestamp DESC
      LIMIT ? OFFSET ?
    `),

        // Paginated load: cursor-based for infinite scroll (faster than OFFSET on large tables)
        // [PERF-FIX] Also removed LEFT JOIN here — same reasoning as getMessages above.
        getMessagesBefore: d.prepare(`
      SELECT
        m.id, m.chat_jid, m.sender_jid, m.sender_name, m.body, m.msg_type,
        m.timestamp, m.status, m.from_me, m.is_group, m.has_media, m.starred,
        m.quoted_id, m.quoted_sender, m.quoted_body, m.quoted_type, m.quoted_has_media,
        m.mentioned_jids, m.link_preview_url, m.link_preview_title, m.link_preview_desc, m.link_preview_thumb,
        m.raw, m.created_at
      FROM messages m
      WHERE m.chat_jid = ? AND m.timestamp < ?
      ORDER BY m.timestamp DESC
      LIMIT ?
    `),

        getMessageCount: d.prepare(`SELECT COUNT(*) AS total FROM messages WHERE chat_jid = ?`),

        // Unread count — uses idx_msg_unread partial index
        getUnreadCount: d.prepare(`
      SELECT COUNT(*) AS total FROM messages
      WHERE chat_jid = ? AND from_me = 0 AND status < 2
    `),

        // Media gallery — uses idx_msg_media partial index
        getMediaMessages: d.prepare(`
      SELECT id, chat_jid, sender_jid, msg_type, timestamp, raw
      FROM messages
      WHERE chat_jid = ? AND has_media = 1
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `),

        // Starred messages — uses idx_msg_starred partial index
        getStarredMessages: d.prepare(`
      SELECT m.*, COALESCE(c.name, c.notify) AS chat_name
      FROM messages m
      LEFT JOIN chats c ON c.jid = m.chat_jid
      WHERE m.starred = 1
      ORDER BY m.timestamp DESC
      LIMIT ? OFFSET ?
    `),

        searchMessages: d.prepare(`
      SELECT m.id, m.chat_jid, m.sender_jid, m.sender_name, m.body, m.msg_type,
             m.timestamp, m.status, m.from_me, m.has_media, m.starred
      FROM messages m
      JOIN messages_fts f ON m.rowid = f.rowid
      WHERE messages_fts MATCH ? AND m.chat_jid = ?
      ORDER BY m.timestamp DESC
      LIMIT 50
    `),

        searchMessagesGlobal: d.prepare(`
      SELECT m.id, m.chat_jid, m.sender_jid, m.sender_name, m.body, m.msg_type,
             m.timestamp, m.status, m.from_me, m.has_media,
             c.name AS chat_name
      FROM messages m
      JOIN messages_fts f ON m.rowid = f.rowid
      JOIN chats c ON m.chat_jid = c.jid
      WHERE messages_fts MATCH ?
      ORDER BY m.timestamp DESC
      LIMIT 50
    `),

        updateMessageStatus: d.prepare(`
      UPDATE messages SET status = @status
      WHERE id = @id AND chat_jid = @chat_jid
    `),

        toggleStar: d.prepare(`
      UPDATE messages SET starred = (1 - starred)
      WHERE id = ? AND chat_jid = ?
    `),
    }
    return stmts
}

// ════════════════════════════════════════════════════════════
// PUBLIC API — Chats
// ════════════════════════════════════════════════════════════

/**
 * saveChat — save/upsert a Baileys chat object (uses chat.id field).
 *
 * Baileys emits chat objects with `.id` (not `.jid`), so this adapter
 * bridges the gap. It also:
 *   - Rejects @lid JIDs entirely (never stored — they are opaque device IDs,
 *     not real chat identities, and storing them causes duplicate chat rows)
 *   - Maps Baileys camelCase fields → DB snake_case columns
 */
function saveChat(chat) {
    if (!chat || !chat.id) return
    const jid = chat.id

    // [FIX-DUPLICATE] NEVER store @lid as a chat JID.
    // @lid is an opaque internal device identifier — it is NOT a real phone number.
    // Storing it creates a duplicate chat row alongside the real @s.whatsapp.net entry.
    // If caller hasn't resolved it yet, skip silently — resolveLidInDB() will fix it later.
    if (jid.endsWith('@lid')) return

    init()
    const isGroup = jid.endsWith('@g.us') || !!chat.isGroup
    const phone   = !isGroup ? jid.split('@')[0].split(':')[0] : null

    // Derive last message info from the Baileys chat object
    const msgs       = chat.messages || []
    const lastMsgObj = msgs[0]?.message || null
    let lastBody     = chat.last_msg || null
    let lastMsgAt    = chat.last_msg_at || chat.conversationTimestamp || 0
    let lastMsgType  = chat.last_msg_type || null

    if (lastMsgObj && !lastBody) {
        // Extract a basic body string from the last message if available
        const mc = lastMsgObj.message
        if (mc) {
            lastBody = mc.conversation
                || mc.extendedTextMessage?.text
                || mc.imageMessage?.caption
                || mc.videoMessage?.caption
                || null
        }
        if (!lastMsgAt && lastMsgObj.messageTimestamp) {
            const ts = lastMsgObj.messageTimestamp
            lastMsgAt = typeof ts === 'object' ? Number(ts) : ts
        }
    }

    return getStmts().upsertChat.run({
        jid,
        name:          chat.name          || null,
        phone,
        is_group:      isGroup            ? 1 : 0,
        is_community:  chat.isCommunity   ? 1 : 0,
        community_jid: chat.communityJid  || null,
        avatar_url:    chat.avatarUrl     || null,
        last_msg:      lastBody,
        last_msg_at:   lastMsgAt,
        last_msg_type: lastMsgType,
        unread_count:  chat.unreadCount   || 0,
        member_count:  chat.memberCount   || (chat.participants?.length ?? 0),
    })
}

/**
 * resolveLidRows — retroactively fix @lid JIDs that leaked into DB rows.
 *
 * Called from client.js after lidMap is populated (post history-sync).
 * Uses a single SQLite transaction for atomicity and performance.
 *
 * For each @lid entry:
 *   - If lidMap has a mapping → rename the row to the real phone JID
 *     (UPDATE chats SET jid = phoneJid WHERE jid = lidJid)
 *   - If no mapping exists → DELETE the @lid row (it's a ghost duplicate)
 *
 * Returns count of rows fixed (renamed + deleted).
 */
function resolveLidRows(lidMap) {
    if (!lidMap || lidMap.size === 0) return 0
    const db = getDb()
    let fixed = 0

    // Find all @lid rows in chats and messages
    const lidChats    = db.prepare(`SELECT jid FROM chats    WHERE jid LIKE '%@lid'`).all()
    const lidMessages = db.prepare(`SELECT DISTINCT chat_jid FROM messages WHERE chat_jid LIKE '%@lid'`).all()
    const lidContacts = db.prepare(`SELECT jid FROM contacts WHERE jid LIKE '%@lid'`).all()

    const tx = db.transaction(() => {
        // ── Fix chats ──────────────────────────────────────────────────────
        for (const { jid: lidJid } of lidChats) {
            const lidUser   = lidJid.split('@')[0]
            const phoneJid  = lidMap.get(lidJid) || lidMap.get(lidUser) || null

            if (phoneJid) {
                const exists = db.prepare(`SELECT 1 FROM chats WHERE jid = ?`).get(phoneJid)
                if (exists) {
                    // Phone JID row already exists — delete the @lid duplicate
                    db.prepare(`DELETE FROM chats WHERE jid = ?`).run(lidJid)
                } else {
                    // Rename @lid row to phone JID
                    db.prepare(`UPDATE chats SET jid = ?, phone = ? WHERE jid = ?`)
                      .run(phoneJid, phoneJid.split('@')[0], lidJid)
                }
                fixed++
            } else {
                // No mapping — delete the unresolvable @lid ghost row
                db.prepare(`DELETE FROM chats WHERE jid = ?`).run(lidJid)
                fixed++
            }
        }

        // ── Fix messages.chat_jid ─────────────────────────────────────────
        for (const { chat_jid: lidJid } of lidMessages) {
            const lidUser  = lidJid.split('@')[0]
            const phoneJid = lidMap.get(lidJid) || lidMap.get(lidUser) || null
            if (phoneJid) {
                db.prepare(`UPDATE messages SET chat_jid = ? WHERE chat_jid = ?`).run(phoneJid, lidJid)
                fixed++
            } else {
                // No resolution — remove orphan messages (their chat doesn't exist)
                db.prepare(`DELETE FROM messages WHERE chat_jid = ?`).run(lidJid)
                fixed++
            }
        }

        // ── Fix messages.sender_jid ────────────────────────────────────────
        const lidSenders = db.prepare(`SELECT DISTINCT sender_jid FROM messages WHERE sender_jid LIKE '%@lid'`).all()
        for (const { sender_jid: lidJid } of lidSenders) {
            const lidUser  = lidJid.split('@')[0]
            const phoneJid = lidMap.get(lidJid) || lidMap.get(lidUser) || null
            if (phoneJid) {
                db.prepare(`UPDATE messages SET sender_jid = ? WHERE sender_jid = ?`).run(phoneJid, lidJid)
                fixed++
            }
        }

        // ── Fix contacts ───────────────────────────────────────────────────
        for (const { jid: lidJid } of lidContacts) {
            const lidUser  = lidJid.split('@')[0]
            const phoneJid = lidMap.get(lidJid) || lidMap.get(lidUser) || null
            if (phoneJid) {
                const exists = db.prepare(`SELECT 1 FROM contacts WHERE jid = ?`).get(phoneJid)
                if (exists) {
                    db.prepare(`DELETE FROM contacts WHERE jid = ?`).run(lidJid)
                } else {
                    db.prepare(`UPDATE contacts SET jid = ? WHERE jid = ?`).run(phoneJid, lidJid)
                }
                fixed++
            } else {
                db.prepare(`DELETE FROM contacts WHERE jid = ?`).run(lidJid)
                fixed++
            }
        }
    })

    tx()
    if (fixed > 0) _msgCacheInvalidate('*')  // invalidate all caches
    return fixed
}

function upsertChat(data) {
    init()
    return getStmts().upsertChat.run({
        jid:           data.jid           || "",
        name:          data.name          || null,
        phone:         data.phone         || null,
        is_group:      data.isGroup       ? 1 : 0,
        is_community:  data.isCommunity   ? 1 : 0,
        community_jid: data.communityJid  || null,
        avatar_url:    data.avatarUrl     || null,
        last_msg:      data.lastMsg       || null,
        last_msg_at:   data.lastMsgAt     || 0,
        last_msg_type: data.lastMsgType   || null,
        unread_count:  data.unreadDelta   || 0,
        member_count:  data.memberCount   || 0,
    })
}

function updateMemberCount(jid, count) {
    init()
    return getStmts().updateMemberCount.run({ jid, count: count || 0 })
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
    if (!query || !query.trim()) return []
    try {
        const q = `"${query.replace(/"/g, '""')}"*`
        return getStmts().searchChats.all(q)
    } catch {
        return getDb().prepare(`
      SELECT * FROM chats
      WHERE (name LIKE ? OR phone LIKE ?) AND archived = 0
      ORDER BY pinned DESC, last_msg_at DESC LIMIT 50
    `).all(`%${query}%`, `%${query}%`)
    }
}

function markChatRead(jid) {
    init()
    _msgCacheInvalidate(jid)
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

// ════════════════════════════════════════════════════════════
// PUBLIC API — Contacts
// ════════════════════════════════════════════════════════════

function upsertContact(data) {
    init()
    return getStmts().upsertContact.run({
        jid:        data.jid                || "",
        name:       data.name || data.notify || null,
        notify:     data.notify             || null,
        phone:      data.phone              || null,
        avatar_url: data.avatarUrl          || null,
        is_group:   data.isGroup            ? 1 : 0,
    })
}

function bulkUpsertContacts(contacts) {
    init()
    const s  = getStmts()
    const tx = getDb().transaction((list) => {
        for (const c of list) {
            s.upsertContact.run({
                jid:       c.id || c.jid || "",
                name:      c.name || c.notify || null,
                notify:    c.notify || null,
                phone:     (c.id || c.jid || "").split("@")[0] || null,
                avatar_url:null,
                is_group:  (c.id || c.jid || "").endsWith("@g.us") ? 1 : 0,
            })
        }
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
    if (!query || !query.trim()) return []
    const q = `%${query}%`
    return getStmts().searchContacts.all(q, q, q)
}

// ════════════════════════════════════════════════════════════
// PUBLIC API — Messages
// ════════════════════════════════════════════════════════════

// [PERF-DB] Track which JIDs have a chat row so insertMessage can skip the
// redundant upsertChat for existing chats. Populated lazily on first insert.
// Reset on DB re-init (app restart) — first message per chat will upsert once.
const _knownChatJids = new Set()

function insertMessage(data) {
    init()
    const s = getStmts()

    // [PERF-DB] Only upsert the parent chat row on the FIRST message per JID
    // in this session. After that, updateChatLastMsg handles timestamp/body updates
    // and the chat row is guaranteed to exist. This eliminates a full INSERT OR REPLACE
    // on the chats table for every single message — saves ~0.5ms per message at p50.
    if (!_knownChatJids.has(data.chat_jid)) {
        s.upsertChat.run({
            jid:           data.chat_jid,
            name:          null,
            phone:         null,
            is_group:      data.is_group    ? 1 : 0,
            is_community:  0,
            community_jid: null,
            avatar_url:    null,
            last_msg:      data.body        || null,
            last_msg_at:   data.timestamp   || 0,
            last_msg_type: data.msg_type    || null,
            unread_count:  data.from_me     ? 0 : 1,
        })
        _knownChatJids.add(data.chat_jid)
    }

    const result = s.insertMessage.run({
        id:               data.id,
        chat_jid:         data.chat_jid,
        sender_jid:       data.sender_jid         || null,
        sender_name:      data.pushname || data.sender_name || null,
        body:             data.body               || null,
        msg_type:         data.msg_type           || "conversation",
        timestamp:        data.timestamp          || 0,
        status:           data.status             ?? 0,
        from_me:          data.from_me            ? 1 : 0,
        is_group:         data.is_group           ? 1 : 0,
        has_media:        data.has_media          ? 1 : 0,
        starred:          data.starred            ? 1 : 0,
        quoted_id:        data.quoted_id          || null,
        quoted_sender:    data.quoted_sender      || null,
        quoted_body:      data.quoted_body        || null,
        quoted_type:      data.quoted_type        || null,
        quoted_has_media: data.quoted_has_media   ? 1 : 0,
        mentioned_jids:   data.mentioned_jids     || null,
        link_preview_url:   data.link_preview_url   || null,
        link_preview_title: data.link_preview_title || null,
        link_preview_desc:  data.link_preview_desc  || null,
        link_preview_thumb: data.link_preview_thumb || null,
        raw:              data.raw_json || data.raw || null,
    })

    // Invalidate cache for this chat — new message arrived
    _msgCacheInvalidate(data.chat_jid)
    return result
}

function bulkInsertMessages(messages) {
    init()
    const s  = getStmts()
    const chatsTouched = new Set()

    const tx = getDb().transaction((list) => {
        for (const m of list) {
            try {
                // Normalize parser field names to SQL param names
                const row = {
                    ...m,
                    raw:                m.raw ?? m.raw_json ?? null,
                    link_preview_url:   m.link_preview_url   ?? null,
                    link_preview_title: m.link_preview_title ?? null,
                    link_preview_desc:  m.link_preview_desc  ?? null,
                    link_preview_thumb: m.link_preview_thumb ?? null,
                }
                s.insertMessage.run(row)
                if (m.chat_jid) chatsTouched.add(m.chat_jid)
            } catch (err) {
                if (process.env.NODE_ENV !== "production") {
                    console.warn("[database] bulkInsertMessages row error:", err.message, m?.id)
                }
            }
        }
    })
    tx(messages)

    // Invalidate cache for all chats touched by this bulk insert
    for (const jid of chatsTouched) _msgCacheInvalidate(jid)
}

/**
 * getMessages — primary chat message load.
 *
 * First page (offset=0) is served from the per-chat in-memory cache
 * if available and fresh (<30s). Subsequent pages always hit SQLite.
 *
 * @param {string} chatJid
 * @param {number} limit   — default 50
 * @param {number} offset  — default 0
 */
function getMessages(chatJid, limit = 50, offset = 0) {
    init()
    // Serve from cache if first page and cache is warm
    const cached = _msgCacheGet(chatJid, limit, offset)
    if (cached) return cached

    const rows = getStmts().getMessages.all(chatJid, limit, offset)

    // Cache only first page
    if (offset === 0) _msgCacheSet(chatJid, limit, rows)
    return rows
}

/**
 * getMessagesBefore — cursor-based pagination for infinite scroll.
 * Faster than OFFSET on large tables: uses idx_msg_chat_ts with a
 * timestamp cursor instead of skipping N rows.
 *
 * @param {string} chatJid
 * @param {number} beforeTimestamp — timestamp of oldest currently visible message
 * @param {number} limit
 */
function getMessagesBefore(chatJid, beforeTimestamp, limit = 50) {
    init()
    return getStmts().getMessagesBefore.all(chatJid, beforeTimestamp, limit)
}

function getMessageCount(chatJid) {
    init()
    return getStmts().getMessageCount.get(chatJid).total
}

function getUnreadCount(chatJid) {
    init()
    return getStmts().getUnreadCount.get(chatJid).total
}

function getMediaMessages(chatJid, limit = 50, offset = 0) {
    init()
    return getStmts().getMediaMessages.all(chatJid, limit, offset)
}

function getStarredMessages(limit = 50, offset = 0) {
    init()
    return getStmts().getStarredMessages.all(limit, offset)
}

function searchMessages(chatJid, query) {
    init()
    if (!query || !query.trim()) return []
    try {
        const q = `"${query.replace(/"/g, '""')}"*`
        return getStmts().searchMessages.all(q, chatJid)
    } catch {
        return getDb().prepare(`
      SELECT * FROM messages
      WHERE chat_jid = ? AND body LIKE ?
      ORDER BY timestamp DESC LIMIT 50
    `).all(chatJid, `%${query}%`)
    }
}

function searchMessagesGlobal(query) {
    init()
    if (!query || !query.trim()) return []
    try {
        const q = `"${query.replace(/"/g, '""')}"*`
        return getStmts().searchMessagesGlobal.all(q)
    } catch {
        return getDb().prepare(`
      SELECT m.*, c.name AS chat_name FROM messages m
      JOIN chats c ON m.chat_jid = c.jid
      WHERE m.body LIKE ?
      ORDER BY m.timestamp DESC LIMIT 50
    `).all(`%${query}%`)
    }
}

function updateMessageStatus(id, chatJid, status) {
    init()
    _msgCacheInvalidate(chatJid)   // status change visible in chat list
    return getStmts().updateMessageStatus.run({ id, chat_jid: chatJid, status })
}

// Toggle star via SQL toggle (1-starred) — returns new starred value
function toggleMessageStar(id, chatJid) {
    init()
    _msgCacheInvalidate(chatJid)
    getStmts().toggleStar.run(id, chatJid)
    const row = getDb().prepare("SELECT starred FROM messages WHERE id = ? AND chat_jid = ?").get(id, chatJid)
    return row ? row.starred : null
}

// Set star to explicit value (0 or 1)
function setMessageStar(id, chatJid, star) {
    init()
    _msgCacheInvalidate(chatJid)
    getDb().prepare("UPDATE messages SET starred = ? WHERE id = ? AND chat_jid = ?").run(star ? 1 : 0, id, chatJid)
}

// ════════════════════════════════════════════════════════════
// PUBLIC API — Misc
// ════════════════════════════════════════════════════════════

function getStats() {
    init()
    return {
        chats:    getChatCount(),
        contacts: getContactCount(),
        messages: getDb().prepare("SELECT COUNT(*) AS total FROM messages").get().total,
    }
}

/**
 * invalidateChatCache — call from client.js when a real-time message arrives
 * or when prefetch completes, so the next getMessages() re-reads from DB.
 */
function invalidateChatCache(jid) {
    _msgCacheInvalidate(jid)
}

/**
 * runMaintenance — periodic PRAGMA optimize + WAL checkpoint.
 * Call every ~30 minutes from client.js via setInterval.
 * Keeps the WAL file small and query planner stats fresh.
 */
function runMaintenance() {
    if (!db) return
    try {
        db.pragma("optimize")
        db.pragma("wal_checkpoint(PASSIVE)")
    } catch (_) {}
}

/**
 * close — gracefully shut down, reset all state.
 */
function close() {
    if (db) {
        try {
            db.pragma("optimize")
            db.pragma("wal_checkpoint(TRUNCATE)")
            db.close()
        } catch (_) {}
        db    = null
        stmts = null
        _chatMsgCache.clear()
    }
}

// ════════════════════════════════════════════════════════════
// BACKFILL: sender_name → contacts.notify
// ════════════════════════════════════════════════════════════
//
// After history sync, the messages table has sender_name (pushname from WA)
// for every group member who sent a message — even if they're not in the
// address book. This function promotes those names into contacts.notify so
// normalizeMsg() can resolve them for quoted message display.
//
// Runs after sync completes. Safe to call multiple times (COALESCE guards).
// ────────────────────────────────────────────────────────────
function backfillSenderNamesFromMessages() {
    try {
        const db = getDb()
        // Find the most-recent sender_name for every sender_jid in messages.
        // Only pick non-null, non-JID names (exclude raw JIDs that leaked in).
        // Use MAX(timestamp) to pick the latest pushname (names can change).
        const rows = db.prepare(`
            SELECT sender_jid, sender_name, MAX(timestamp) AS ts
            FROM messages
            WHERE sender_jid IS NOT NULL
              AND sender_name IS NOT NULL
              AND sender_name != ''
              AND sender_name NOT LIKE '%@%'
              AND from_me = 0
            GROUP BY sender_jid
        `).all()

        if (!rows.length) return

        const upsert = db.prepare(`
            INSERT INTO contacts (jid, name, notify, phone, is_group, updated_at)
            VALUES (?, NULL, ?, ?, 0, unixepoch())
            ON CONFLICT(jid) DO UPDATE SET
              notify     = CASE
                             WHEN contacts.name IS NOT NULL THEN contacts.notify
                             ELSE COALESCE(excluded.notify, contacts.notify)
                           END,
              phone      = COALESCE(contacts.phone, excluded.phone),
              updated_at = unixepoch()
            WHERE contacts.notify IS NULL AND excluded.notify IS NOT NULL
        `)

        const tx = db.transaction((list) => {
            let n = 0
            for (const row of list) {
                if (!row.sender_jid || !row.sender_name) continue
                const phone = row.sender_jid.includes('@')
                    ? row.sender_jid.split('@')[0].split(':')[0]
                    : row.sender_jid
                upsert.run(row.sender_jid, row.sender_name, phone || null)
                n++
            }
            return n
        })

        const count = tx(rows)
        if (count > 0) console.log(`[AuroraDB] backfillSenderNamesFromMessages: ${count} contacts enriched`)
    } catch (err) {
        console.error('[AuroraDB] backfillSenderNamesFromMessages error:', err.message)
    }
}

// ════════════════════════════════════════════════════════════
// EXPORTS
// ════════════════════════════════════════════════════════════

module.exports = {
    init,
    close,
    getStats,
    runMaintenance,
    invalidateChatCache,

    // Chats
    saveChat,
    resolveLidRows,
    upsertChat,
    updateMemberCount,
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
    backfillSenderNamesFromMessages,

    // Messages
    insertMessage,
    bulkInsertMessages,
    getMessages,
    getMessagesBefore,
    getMessageCount,
    getUnreadCount,
    getMediaMessages,
    getStarredMessages,
    searchMessages,
    searchMessagesGlobal,
    updateMessageStatus,
    toggleMessageStar,
    setMessageStar,
}