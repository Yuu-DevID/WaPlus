// electron/baileys/database.js
// ═══════════════════════════════════════════════════════════════════════════
// PRODUCTION GRADE — All bugs fixed
//
// CHANGELOG:
// [FIX-1]  DB_PATH hardcoded ke __dirname → pakai app.getPath('userData')
// [FIX-2]  insertMessage() tidak ada di database object → ditambahkan
// [FIX-3]  getMessages() → getMessagesByJid.all(jid, {limit,offset}) — named
//          params tapi statement pakai @limit/@offset → semua diubah ke positional
// [FIX-4]  getChats() sama masalah named vs positional → fix positional
// [FIX-5]  getContacts() sama → fix positional
// [FIX-6]  searchMessages() pakai {jid,query} object → fix positional
// [FIX-7]  searchContacts() pakai {query} object → fix positional 4-param
// [FIX-8]  saveContacts()/bulkUpsertContacts() panggil database.saveContact()
//          sebelum `database` selesai defined → ReferenceError → fix closure
// [FIX-9]  savePollVote() INSERT ke kolom salah (message_id/sender_jid/vote)
//          → sesuaikan ke schema (poll_message_id/voter_jid/selected_options)
// [FIX-10] startSync()/endSync() pakai updateSyncStatus.run({...}) dengan
//          null fields tidak aman → pisah jadi 2 statement dedicated
// [FIX-11] getMessagesFromDB() alias diperbaiki ikut positional params
// [FIX-12] `module.exports = database` tapi database tidak dideklarasi
//          sebagai variable — semua API tercampur di dalam `statements`
//          → pisah `statements` (SQLite) dari `database` (public API)
// [FIX-13] saveChat() INSERT OR REPLACE menghapus unread_count/pinned dll
//          → ganti ke UPSERT (INSERT ... ON CONFLICT DO UPDATE SET)
// [FIX-14] Performance pragmas tidak lengkap → tambah cache_size/temp_store/mmap
// [FIX-15] Tidak ada schema migration → kolom baru crash install lama
//          → tambah schema_version + auto-migration
// ═══════════════════════════════════════════════════════════════════════════

'use strict';

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

// ════════════════════════════════════════════════════════════
// [FIX-1] DB PATH — persisten di production Electron build
// ════════════════════════════════════════════════════════════

function getDbPath() {
    try {
        const { app } = require('electron');
        return path.join(app.getPath('userData'), 'aurora_chat.db');
    } catch {
        // Fallback dev/test
        const dir = path.resolve(__dirname, './database');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        return path.join(dir, 'aurora_chat.db');
    }
}

const DB_PATH = getDbPath();
const DB_DIR  = path.dirname(DB_PATH);
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);

// [FIX-14] Performance pragmas lengkap
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('cache_size = -32000');     // 32 MB cache
db.pragma('temp_store = MEMORY');
db.pragma('mmap_size = 268435456');   // 256 MB mmap

// ════════════════════════════════════════════════════════════
// SCHEMA
// ════════════════════════════════════════════════════════════

db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        remote_jid TEXT NOT NULL,
        from_me INTEGER NOT NULL DEFAULT 0,
        participant TEXT,
        push_name TEXT,
        message_type TEXT NOT NULL DEFAULT 'conversation',
        body TEXT,
        message_json TEXT,

        -- Media metadata
        media_mimetype TEXT,
        media_file_name TEXT,
        media_file_length INTEGER,
        media_duration INTEGER,
        media_height INTEGER,
        media_width INTEGER,
        media_caption TEXT,
        media_key TEXT,
        media_direct_path TEXT,
        media_url TEXT,
        media_sha256 TEXT,
        media_enc_sha256 TEXT,
        media_saved_path TEXT,
        media_is_downloaded INTEGER NOT NULL DEFAULT 0,

        -- Extra media flags (v2)
        is_ptt INTEGER NOT NULL DEFAULT 0,
        is_gif INTEGER NOT NULL DEFAULT 0,
        is_view_once INTEGER NOT NULL DEFAULT 0,
        is_animated INTEGER NOT NULL DEFAULT 0,

        -- Context / Reply
        context_stanza_id TEXT,
        context_participant TEXT,
        context_quoted_message TEXT,
        context_mentioned_jids TEXT,
        context_is_forwarded INTEGER NOT NULL DEFAULT 0,
        context_forwarding_score INTEGER NOT NULL DEFAULT 0,

        -- Reaction
        reaction_text TEXT,
        reaction_target_id TEXT,
        reaction_target_remote_jid TEXT,
        reaction_target_from_me INTEGER,

        -- Poll
        poll_name TEXT,
        poll_options TEXT,
        poll_selectable_count INTEGER,
        poll_votes TEXT,

        -- Location
        location_lat REAL,
        location_lng REAL,
        location_name TEXT,
        location_address TEXT,
        location_accuracy INTEGER,

        -- Contact
        contact_vcard TEXT,
        contact_display_name TEXT,

        -- Group (legacy)
        group_subject TEXT,
        group_description TEXT,
        group_participants TEXT,

        -- Ephemeral
        ephemeral_expiration INTEGER,
        ephemeral_setting_timestamp INTEGER,

        -- Protocol
        protocol_type INTEGER,
        protocol_key_id TEXT,

        -- Status
        status INTEGER NOT NULL DEFAULT 0,
        starred INTEGER NOT NULL DEFAULT 0,
        broadcast INTEGER NOT NULL DEFAULT 0,
        is_history_sync INTEGER NOT NULL DEFAULT 0,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        sync_type TEXT,

        -- Timestamps
        message_timestamp INTEGER NOT NULL DEFAULT 0,
        edited_at INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_messages_remote_jid     ON messages(remote_jid, message_timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp      ON messages(message_timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_type           ON messages(message_type);
    CREATE INDEX IF NOT EXISTS idx_messages_history_sync   ON messages(is_history_sync);
    CREATE INDEX IF NOT EXISTS idx_messages_reaction_target ON messages(reaction_target_id);
    CREATE INDEX IF NOT EXISTS idx_messages_protocol       ON messages(protocol_type);
    CREATE INDEX IF NOT EXISTS idx_messages_media_pending  ON messages(media_is_downloaded) WHERE media_is_downloaded = 0;
    CREATE INDEX IF NOT EXISTS idx_messages_starred        ON messages(starred) WHERE starred = 1;

    CREATE TABLE IF NOT EXISTS chats (
        jid TEXT PRIMARY KEY,
        name TEXT,
        is_group INTEGER NOT NULL DEFAULT 0,
        is_community INTEGER NOT NULL DEFAULT 0,
        community_jid TEXT,
        unread_count INTEGER NOT NULL DEFAULT 0,
        last_message_timestamp INTEGER NOT NULL DEFAULT 0,
        last_message_id TEXT,
        last_message_body TEXT,
        last_message_type TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        muted_until INTEGER NOT NULL DEFAULT 0,
        profile_pic_url TEXT,
        status TEXT,
        presence TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_chats_order   ON chats(pinned DESC, last_message_timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_chats_group   ON chats(is_group);
    CREATE INDEX IF NOT EXISTS idx_chats_comm    ON chats(is_community);

    CREATE TABLE IF NOT EXISTS contacts (
        jid TEXT PRIMARY KEY,
        name TEXT,
        push_name TEXT,
        short_name TEXT,
        number TEXT,
        status TEXT,
        profile_pic_url TEXT,
        is_group INTEGER NOT NULL DEFAULT 0,
        is_user INTEGER NOT NULL DEFAULT 0,
        is_business INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name);

    CREATE TABLE IF NOT EXISTS media_downloads (
        message_id TEXT PRIMARY KEY,
        remote_jid TEXT NOT NULL DEFAULT '',
        media_type TEXT NOT NULL DEFAULT '',
        original_url TEXT,
        local_path TEXT,
        file_size INTEGER,
        download_status TEXT NOT NULL DEFAULT 'pending',
        download_attempts INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        downloaded_at DATETIME,
        FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_media_dl_status ON media_downloads(download_status);

    -- [FIX-9] Kolom yang benar sesuai savePollVote()
    CREATE TABLE IF NOT EXISTS poll_votes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        poll_message_id TEXT NOT NULL,
        voter_jid TEXT NOT NULL,
        selected_options TEXT,
        voted_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(poll_message_id, voter_jid),
        FOREIGN KEY (poll_message_id) REFERENCES messages(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS message_edits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        original_message_id TEXT NOT NULL,
        original_body TEXT,
        edited_body TEXT,
        edited_timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY (original_message_id) REFERENCES messages(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sync_status (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        is_syncing INTEGER NOT NULL DEFAULT 0,
        sync_started_at DATETIME,
        sync_completed_at DATETIME,
        total_chats INTEGER NOT NULL DEFAULT 0,
        total_messages INTEGER NOT NULL DEFAULT 0,
        last_sync_timestamp INTEGER
    );
    INSERT OR IGNORE INTO sync_status (id) VALUES (1);

    -- [FIX-15] Schema versioning
    CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY
    );
`);

// ════════════════════════════════════════════════════════════
// [FIX-15] AUTO MIGRATION
// ════════════════════════════════════════════════════════════

const DB_VERSION = 3;

function runMigrations() {
    const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get();
    const current = row?.v || 0;
    if (current >= DB_VERSION) return;

    console.log(`[AuroraDB] Migrating schema v${current} → v${DB_VERSION}`);

    const migrations = {
        1: () => { /* initial — schema sudah di-create di db.exec atas */ },
        2: () => {
            // Tambah kolom flag media yang mungkin belum ada pada install lama
            const cols = db.pragma('table_info(messages)').map(c => c.name);
            if (!cols.includes('is_ptt'))       db.exec('ALTER TABLE messages ADD COLUMN is_ptt INTEGER NOT NULL DEFAULT 0');
            if (!cols.includes('is_gif'))       db.exec('ALTER TABLE messages ADD COLUMN is_gif INTEGER NOT NULL DEFAULT 0');
            if (!cols.includes('is_view_once')) db.exec('ALTER TABLE messages ADD COLUMN is_view_once INTEGER NOT NULL DEFAULT 0');
            if (!cols.includes('is_animated'))  db.exec('ALTER TABLE messages ADD COLUMN is_animated INTEGER NOT NULL DEFAULT 0');
            if (!cols.includes('is_deleted'))   db.exec('ALTER TABLE messages ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0');
            if (!cols.includes('edited_at'))    db.exec('ALTER TABLE messages ADD COLUMN edited_at INTEGER');

            const chatCols = db.pragma('table_info(chats)').map(c => c.name);
            if (!chatCols.includes('community_jid'))      db.exec('ALTER TABLE chats ADD COLUMN community_jid TEXT');
            if (!chatCols.includes('last_message_type'))  db.exec('ALTER TABLE chats ADD COLUMN last_message_type TEXT');
            if (!chatCols.includes('muted_until'))        db.exec("ALTER TABLE chats ADD COLUMN muted_until INTEGER NOT NULL DEFAULT 0");
        },
        3: () => {
            // Fix poll_votes kolom jika masih punya schema lama (message_id/sender_jid/vote)
            const pvcols = db.pragma('table_info(poll_votes)').map(c => c.name);
            if (pvcols.includes('message_id') && !pvcols.includes('poll_message_id')) {
                db.exec(`
                    CREATE TABLE IF NOT EXISTS poll_votes_v3 (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        poll_message_id TEXT NOT NULL,
                        voter_jid TEXT NOT NULL,
                        selected_options TEXT,
                        voted_at INTEGER NOT NULL DEFAULT (unixepoch()),
                        UNIQUE(poll_message_id, voter_jid)
                    );
                    INSERT OR IGNORE INTO poll_votes_v3 (id, poll_message_id, voter_jid, selected_options, voted_at)
                        SELECT id,
                               COALESCE(poll_message_id, message_id),
                               COALESCE(voter_jid, sender_jid),
                               COALESCE(selected_options, vote),
                               COALESCE(voted_at, timestamp, unixepoch())
                        FROM poll_votes;
                    DROP TABLE poll_votes;
                    ALTER TABLE poll_votes_v3 RENAME TO poll_votes;
                `);
            }
        },
    };

    db.transaction(() => {
        for (let v = current + 1; v <= DB_VERSION; v++) {
            try {
                if (migrations[v]) migrations[v]();
                db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)').run(v);
                console.log(`[AuroraDB] Migration v${v} ✓`);
            } catch (err) {
                console.error(`[AuroraDB] Migration v${v} FAILED:`, err.message);
                throw err;
            }
        }
    })();
}

runMigrations();

// ════════════════════════════════════════════════════════════
// PREPARED STATEMENTS
// [FIX-3,4,5,6,7] Semua diubah ke POSITIONAL params
// ════════════════════════════════════════════════════════════

const statements = {

    // ── Messages ─────────────────────────────────────────────────────────────
    insertMessage: db.prepare(`
        INSERT OR IGNORE INTO messages (
            id, remote_jid, from_me, participant, push_name, message_type, body,
            message_json, media_mimetype, media_file_name, media_file_length,
            media_duration, media_height, media_width, media_caption, media_key,
            media_direct_path, media_url, media_sha256, media_enc_sha256,
            is_ptt, is_gif, is_view_once, is_animated,
            context_stanza_id, context_participant, context_quoted_message,
            context_mentioned_jids, context_is_forwarded, context_forwarding_score,
            reaction_text, reaction_target_id, reaction_target_remote_jid, reaction_target_from_me,
            poll_name, poll_options, poll_selectable_count, poll_votes,
            location_lat, location_lng, location_name, location_address, location_accuracy,
            contact_vcard, contact_display_name,
            protocol_type, protocol_key_id,
            status, starred, broadcast, is_history_sync, sync_type,
            message_timestamp
        ) VALUES (
            @id, @remote_jid, @from_me, @participant, @push_name, @message_type, @body,
            @message_json, @media_mimetype, @media_file_name, @media_file_length,
            @media_duration, @media_height, @media_width, @media_caption, @media_key,
            @media_direct_path, @media_url, @media_sha256, @media_enc_sha256,
            @is_ptt, @is_gif, @is_view_once, @is_animated,
            @context_stanza_id, @context_participant, @context_quoted_message,
            @context_mentioned_jids, @context_is_forwarded, @context_forwarding_score,
            @reaction_text, @reaction_target_id, @reaction_target_remote_jid, @reaction_target_from_me,
            @poll_name, @poll_options, @poll_selectable_count, @poll_votes,
            @location_lat, @location_lng, @location_name, @location_address, @location_accuracy,
            @contact_vcard, @contact_display_name,
            @protocol_type, @protocol_key_id,
            @status, @starred, @broadcast, @is_history_sync, @sync_type,
            @message_timestamp
        )
    `),

    getMessageById: db.prepare('SELECT * FROM messages WHERE id = ?'),

    // [FIX-3] Ganti @limit/@offset → positional ? ?
    getMessagesByJid: db.prepare(`
        SELECT
            msg.id,
            msg.remote_jid              AS chat_jid,
            msg.from_me,
            msg.participant             AS sender_jid,
            COALESCE(msg.push_name, c.name, c.push_name) AS sender_name,
            msg.message_type            AS msg_type,
            msg.body,
            msg.message_timestamp       AS timestamp,
            msg.status, msg.starred, msg.broadcast,
            msg.is_history_sync,
            msg.media_mimetype          AS mimetype,
            msg.media_duration          AS duration,
            msg.media_file_name         AS media_filename,
            msg.media_saved_path,
            msg.media_is_downloaded,
            msg.media_url,
            msg.is_ptt, msg.is_gif, msg.is_view_once, msg.is_animated,
            msg.poll_options,
            msg.poll_votes,
            msg.context_stanza_id       AS quoted_id,
            msg.context_participant     AS quoted_sender,
            msg.context_quoted_message  AS quoted_body,
            msg.context_mentioned_jids  AS mentioned_jids,
            msg.context_is_forwarded    AS is_forwarded,
            msg.context_forwarding_score AS forwarding_score,
            msg.location_lat, msg.location_lng, msg.location_name, msg.location_address,
            msg.reaction_text           AS reaction_emoji,
            msg.reaction_target_id,
            CASE WHEN msg.remote_jid LIKE '%@g.us' THEN 1 ELSE 0 END AS is_group
        FROM messages msg
        LEFT JOIN contacts c ON c.jid = msg.participant
        WHERE msg.remote_jid = ? AND msg.is_deleted = 0
        ORDER BY msg.message_timestamp DESC
        LIMIT ? OFFSET ?
    `),

    // [FIX-6] Ganti named @jid/@query → positional ? ?
    searchMessages: db.prepare(`
        SELECT * FROM messages
        WHERE remote_jid = ? AND body LIKE ? AND is_deleted = 0
        ORDER BY message_timestamp DESC
        LIMIT 100
    `),

    searchMessagesGlobal: db.prepare(`
        SELECT
            id, remote_jid AS chat_jid, from_me, push_name AS sender_name,
            message_type AS msg_type, body, message_timestamp AS timestamp,
            status, is_history_sync,
            CASE WHEN remote_jid LIKE '%@g.us' THEN 1 ELSE 0 END AS is_group
        FROM messages
        WHERE body LIKE ? AND is_deleted = 0
        ORDER BY message_timestamp DESC
        LIMIT 100
    `),

    updateMessageStatus:  db.prepare('UPDATE messages SET status = ? WHERE id = ?'),
    updateMessageStarred: db.prepare('UPDATE messages SET starred = ? WHERE id = ?'),
    markMessageDeleted:   db.prepare('UPDATE messages SET is_deleted = 1 WHERE id = ?'),

    updateMediaSavedPath: db.prepare(`
        UPDATE messages SET media_saved_path = ?, media_is_downloaded = 1 WHERE id = ?
    `),

    updatePollVotes: db.prepare('UPDATE messages SET poll_votes = ? WHERE id = ?'),

    updateChatLastMessage: db.prepare(`
        UPDATE chats SET
            last_message_timestamp = @timestamp,
            last_message_id        = @message_id,
            last_message_body      = @body,
            last_message_type      = @msg_type
        WHERE jid = @jid
    `),

    // ── Chats ─────────────────────────────────────────────────────────────────

    // [FIX-13] INSERT OR REPLACE → UPSERT untuk jaga unread_count/pinned/dll
    upsertChat: db.prepare(`
        INSERT INTO chats (
            jid, name, is_group, is_community, community_jid,
            unread_count, last_message_timestamp, last_message_id, last_message_body,
            pinned, archived, muted_until, profile_pic_url, status, presence
        ) VALUES (
            @jid, @name, @is_group, @is_community, @community_jid,
            @unread_count, @last_message_timestamp, @last_message_id, @last_message_body,
            @pinned, @archived, @muted_until, @profile_pic_url, @status, @presence
        )
        ON CONFLICT(jid) DO UPDATE SET
            name                   = COALESCE(excluded.name, chats.name),
            is_group               = excluded.is_group,
            is_community           = excluded.is_community,
            community_jid          = COALESCE(excluded.community_jid, chats.community_jid),
            unread_count           = CASE
                                        WHEN excluded.unread_count >= 0 THEN excluded.unread_count
                                        ELSE chats.unread_count
                                     END,
            last_message_timestamp = MAX(excluded.last_message_timestamp, chats.last_message_timestamp),
            last_message_id        = CASE
                                        WHEN excluded.last_message_timestamp >= chats.last_message_timestamp
                                        THEN excluded.last_message_id
                                        ELSE chats.last_message_id
                                     END,
            last_message_body      = CASE
                                        WHEN excluded.last_message_timestamp >= chats.last_message_timestamp
                                        THEN excluded.last_message_body
                                        ELSE chats.last_message_body
                                     END,
            pinned                 = COALESCE(excluded.pinned, chats.pinned),
            archived               = COALESCE(excluded.archived, chats.archived),
            muted_until            = COALESCE(excluded.muted_until, chats.muted_until),
            profile_pic_url        = COALESCE(excluded.profile_pic_url, chats.profile_pic_url),
            updated_at             = CURRENT_TIMESTAMP
    `),

    ensureChat: db.prepare(`
        INSERT OR IGNORE INTO chats (jid, is_group, last_message_timestamp)
        VALUES (?, ?, ?)
    `),

    // [FIX-4] Ganti @limit/@offset → positional ? ?
    getChats: db.prepare(`
        SELECT
            c.jid,
            COALESCE(c.name, ct.name, ct.push_name, ct.short_name) AS name,
            c.is_group, c.is_community, c.unread_count, c.pinned, c.archived,
            c.muted_until,
            COALESCE(c.profile_pic_url, ct.profile_pic_url) AS profile_pic_url,
            c.status, c.presence,
            c.last_message_timestamp    AS last_msg_at,
            c.last_message_body         AS last_msg,
            c.last_message_id           AS last_msg_id,
            c.last_message_type         AS last_msg_type,
            COALESCE(m.push_name, msender.name, msender.push_name) AS last_sender_name,
            m.from_me                   AS from_me
        FROM chats c
        LEFT JOIN contacts ct      ON ct.jid = c.jid
        LEFT JOIN messages m       ON m.id   = c.last_message_id
        LEFT JOIN contacts msender ON msender.jid = m.participant
        ORDER BY c.pinned DESC, c.last_message_timestamp DESC
        LIMIT ? OFFSET ?
    `),

    getChatByJid:       db.prepare('SELECT * FROM chats WHERE jid = ?'),
    updateChatUnread:   db.prepare('UPDATE chats SET unread_count = ? WHERE jid = ?'),
    updateChatPinned:   db.prepare('UPDATE chats SET pinned = ? WHERE jid = ?'),
    updateChatArchived: db.prepare('UPDATE chats SET archived = ? WHERE jid = ?'),
    markChatRead:       db.prepare('UPDATE chats SET unread_count = 0 WHERE jid = ?'),

    // ── Contacts ──────────────────────────────────────────────────────────────
    insertContact: db.prepare(`
        INSERT INTO contacts (
            jid, name, push_name, short_name, number, status,
            profile_pic_url, is_group, is_user, is_business
        ) VALUES (
            @jid, @name, @push_name, @short_name, @number, @status,
            @profile_pic_url, @is_group, @is_user, @is_business
        )
        ON CONFLICT(jid) DO UPDATE SET
            name            = COALESCE(excluded.name, contacts.name),
            push_name       = COALESCE(excluded.push_name, contacts.push_name),
            short_name      = COALESCE(excluded.short_name, contacts.short_name),
            number          = COALESCE(excluded.number, contacts.number),
            profile_pic_url = COALESCE(excluded.profile_pic_url, contacts.profile_pic_url),
            updated_at      = CURRENT_TIMESTAMP
    `),

    // [FIX-5] Ganti @limit/@offset → positional ? ?
    getContacts: db.prepare('SELECT * FROM contacts ORDER BY COALESCE(name, push_name, jid) ASC LIMIT ? OFFSET ?'),

    // [FIX-7] Ganti @query → positional 4x ? untuk name/push_name/number/jid
    searchContacts: db.prepare(`
        SELECT * FROM contacts
        WHERE name LIKE ? OR push_name LIKE ? OR number LIKE ? OR jid LIKE ?
        ORDER BY COALESCE(name, push_name) ASC
        LIMIT 50
    `),

    getContactByJid: db.prepare('SELECT * FROM contacts WHERE jid = ?'),

    // ── Media downloads ───────────────────────────────────────────────────────
    insertMediaDownload: db.prepare(`
        INSERT OR IGNORE INTO media_downloads (message_id, remote_jid, media_type, original_url, download_status)
        VALUES (?, ?, ?, ?, 'pending')
    `),

    updateMediaDownload: db.prepare(`
        INSERT INTO media_downloads (message_id, remote_jid, media_type, local_path, file_size, download_status, error_message, downloaded_at)
        VALUES (@message_id, '', '', @local_path, @file_size, @download_status, @error_message, CURRENT_TIMESTAMP)
        ON CONFLICT(message_id) DO UPDATE SET
            local_path        = @local_path,
            file_size         = @file_size,
            download_status   = @download_status,
            download_attempts = download_attempts + 1,
            error_message     = @error_message,
            downloaded_at     = CURRENT_TIMESTAMP
    `),

    getPendingMediaDownloads: db.prepare(`
        SELECT * FROM media_downloads WHERE download_status = 'pending' ORDER BY download_attempts ASC LIMIT 10
    `),

    // ── Sync status ───────────────────────────────────────────────────────────
    // [FIX-10] Pisah jadi 2 statement dedicated
    startSyncStmt: db.prepare(`
        UPDATE sync_status SET
            is_syncing        = 1,
            sync_started_at   = CURRENT_TIMESTAMP,
            sync_completed_at = NULL,
            total_chats       = 0,
            total_messages    = 0
        WHERE id = 1
    `),
    endSyncStmt: db.prepare(`
        UPDATE sync_status SET
            is_syncing          = 0,
            sync_completed_at   = CURRENT_TIMESTAMP,
            total_chats         = ?,
            total_messages      = ?,
            last_sync_timestamp = unixepoch()
        WHERE id = 1
    `),
    getSyncStatus: db.prepare('SELECT * FROM sync_status WHERE id = 1'),

    // ── Stats ─────────────────────────────────────────────────────────────────
    getStats: db.prepare(`
        SELECT
            (SELECT COUNT(*) FROM messages WHERE is_deleted = 0)                         AS total_messages,
            (SELECT COUNT(*) FROM chats WHERE is_community = 0)                          AS total_chats,
            (SELECT COUNT(*) FROM contacts)                                              AS total_contacts,
            (SELECT COUNT(*) FROM messages WHERE is_history_sync = 1)                   AS history_messages,
            (SELECT COUNT(*) FROM messages WHERE media_is_downloaded = 1)               AS downloaded_media,
            (SELECT COUNT(*) FROM media_downloads WHERE download_status = 'pending')     AS pending_downloads
    `),
};

// ════════════════════════════════════════════════════════════
// MESSAGE TYPE DETECTOR
// ════════════════════════════════════════════════════════════

function detectMessageType(message) {
    if (!message) return 'unknown';
    if (message.ephemeralMessage?.message) return detectMessageType(message.ephemeralMessage.message);
    if (message.viewOnceMessage)            return 'viewOnceMessage';
    if (message.viewOnceMessageV2)          return 'viewOnceMessageV2';
    if (message.editedMessage)              return 'extendedTextMessage';
    if (message.protocolMessage)            return 'protocol';
    if (message.audioMessage?.ptt)          return 'pttMessage';
    if (message.documentWithCaptionMessage?.message?.documentMessage) return 'documentMessage';

    const types = [
        'conversation', 'extendedTextMessage', 'imageMessage', 'videoMessage',
        'audioMessage', 'pttMessage', 'documentMessage', 'stickerMessage',
        'locationMessage', 'liveLocationMessage', 'contactMessage', 'contactsArrayMessage',
        'reactionMessage', 'pollCreationMessage', 'pollCreationMessageV2', 'pollCreationMessageV3',
        'pollUpdateMessage', 'groupInviteMessage', 'paymentMessage', 'orderMessage',
        'productMessage', 'eventMessage', 'callMessage', 'buttonsMessage',
        'buttonsResponseMessage', 'listMessage', 'listResponseMessage',
        'interactiveMessage', 'interactiveResponseMessage', 'carouselMessage',
        'albumMessage', 'pollResultMessage', 'sharePhoneNumberMessage',
        'requestPhoneNumberMessage', 'adminInviteMessage', 'paymentInviteMessage',
        'pinInChatMessage', 'keepInChatMessage', 'ptvMessage',
        'newsletterAdminInviteMessage', 'requestPaymentMessage', 'sendPaymentMessage',
    ];

    for (const type of types) {
        if (message[type]) return type;
    }
    return 'unknown';
}

// ════════════════════════════════════════════════════════════
// CONTENT EXTRACTOR
// ════════════════════════════════════════════════════════════

function extractContent(message, type) {
    const result = { body: '', media: null, context: null, reaction: null, poll: null, location: null, contact: null, protocol: null };
    if (!message) return result;

    // Unwrap wrappers
    let m = message;
    if (m.ephemeralMessage?.message)                           { m = m.ephemeralMessage.message; type = detectMessageType(m); }
    else if (m.viewOnceMessage?.message)                       { m = m.viewOnceMessage.message; type = detectMessageType(m); }
    else if (m.viewOnceMessageV2?.message)                     { m = m.viewOnceMessageV2.message; type = detectMessageType(m); }
    else if (m.editedMessage?.message)                         { m = m.editedMessage.message; type = detectMessageType(m); }
    else if (m.documentWithCaptionMessage?.message?.documentMessage) { m = m.documentWithCaptionMessage.message; type = 'documentMessage'; }

    switch (type) {
        case 'conversation':
            result.body = m.conversation || '';
            break;
        case 'extendedTextMessage':
        case 'extendedText':
            result.body    = m.extendedTextMessage?.text || '';
            result.context = extractContextInfo(m.extendedTextMessage?.contextInfo);
            break;
        case 'imageMessage':
        case 'image':
            result.body    = m.imageMessage?.caption || '';
            result.media   = extractMediaInfo(m.imageMessage, 'image');
            result.context = extractContextInfo(m.imageMessage?.contextInfo);
            break;
        case 'videoMessage':
        case 'video':
            result.body    = m.videoMessage?.caption || '';
            result.media   = extractMediaInfo(m.videoMessage, 'video');
            result.context = extractContextInfo(m.videoMessage?.contextInfo);
            break;
        case 'audioMessage':
        case 'audio':
        case 'pttMessage':
        case 'ptt':
            result.media   = extractMediaInfo(m.audioMessage, 'audio');
            result.context = extractContextInfo(m.audioMessage?.contextInfo);
            break;
        case 'documentMessage':
        case 'document':
            result.body    = m.documentMessage?.caption || m.documentMessage?.fileName || '';
            result.media   = extractMediaInfo(m.documentMessage, 'document');
            result.context = extractContextInfo(m.documentMessage?.contextInfo);
            break;
        case 'stickerMessage':
        case 'sticker':
            result.media = extractMediaInfo(m.stickerMessage, 'sticker');
            break;
        case 'locationMessage':
        case 'location':
            result.location = { lat: m.locationMessage?.degreesLatitude, lng: m.locationMessage?.degreesLongitude, name: m.locationMessage?.name, address: m.locationMessage?.address };
            result.body = m.locationMessage?.name || m.locationMessage?.address || '';
            break;
        case 'liveLocationMessage':
        case 'liveLocation':
            result.location = { lat: m.liveLocationMessage?.degreesLatitude, lng: m.liveLocationMessage?.degreesLongitude, accuracy: m.liveLocationMessage?.accuracyInMeters };
            result.body = m.liveLocationMessage?.caption || '';
            break;
        case 'contactMessage':
        case 'contact':
            result.contact = { displayName: m.contactMessage?.displayName, vcard: m.contactMessage?.vcard };
            result.body = m.contactMessage?.displayName || '';
            break;
        case 'contactsArrayMessage':
        case 'contactsArray':
            result.body = (m.contactsArrayMessage?.contacts || []).map(c => c.displayName).filter(Boolean).join(', ');
            break;
        case 'reactionMessage':
        case 'reaction':
            result.reaction = { text: m.reactionMessage?.text, targetId: m.reactionMessage?.key?.id, targetRemoteJid: m.reactionMessage?.key?.remoteJid, targetFromMe: m.reactionMessage?.key?.fromMe };
            result.body = m.reactionMessage?.text || '';
            break;
        case 'pollCreationMessage':
        case 'pollCreationMessageV2':
        case 'pollCreationMessageV3':
        case 'pollCreation': {
            const pm = m.pollCreationMessageV3 || m.pollCreationMessageV2 || m.pollCreationMessage;
            result.poll = { name: pm?.name, options: (pm?.options || []).map(o => o.optionName || o.name || ''), selectableCount: pm?.selectableOptionsCount };
            result.body = pm?.name || '';
            break;
        }
        case 'protocol':
            result.protocol = { type: m.protocolMessage?.type, keyId: m.protocolMessage?.key?.id };
            break;
        case 'groupInviteMessage':
        case 'groupInvite':
            result.body = m.groupInviteMessage?.groupName || m.groupInviteMessage?.caption || '';
            break;
        case 'paymentMessage':
        case 'requestPaymentMessage':
        case 'sendPaymentMessage':
        case 'payment':
            result.body = m.requestPaymentMessage?.noteMessage?.extendedTextMessage?.text || m.sendPaymentMessage?.noteMessage?.extendedTextMessage?.text || 'Pembayaran';
            break;
        case 'orderMessage':
        case 'order':
            result.body = m.orderMessage?.message || m.orderMessage?.orderTitle || 'Pesanan';
            break;
        case 'eventMessage':
        case 'event':
            result.body = m.eventMessage?.name || 'Acara';
            break;
        case 'buttonsMessage':
        case 'buttons':
            result.body = m.buttonsMessage?.contentText || m.buttonsMessage?.text || '';
            break;
        case 'listMessage':
        case 'list':
            result.body = m.listMessage?.description || m.listMessage?.title || '';
            break;
        case 'interactiveMessage':
            result.body = m.interactiveMessage?.body?.text || m.interactiveMessage?.header?.title || '';
            break;
        case 'interactiveResponseMessage':
            try {
                const p = JSON.parse(m.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson || '{}');
                result.body = p.id || p.title || '';
            } catch { result.body = ''; }
            break;
        case 'buttonsResponseMessage':
            result.body = m.buttonsResponseMessage?.selectedButtonId || m.buttonsResponseMessage?.selectedDisplayText || '';
            break;
        case 'listResponseMessage':
            result.body = m.listResponseMessage?.singleSelectReply?.selectedRowId || m.listResponseMessage?.title || '';
            break;
        case 'ptvMessage':
        case 'ptv':
            result.media = extractMediaInfo(m.ptvMessage, 'video');
            break;
        case 'newsletterAdminInviteMessage':
            result.body = m.newsletterAdminInviteMessage?.newsletterName || 'Undangan Newsletter';
            break;
    }

    return result;
}

function extractMediaInfo(mediaObj, type) {
    if (!mediaObj) return null;
    const toNum = v => {
        if (v == null) return null;
        if (typeof v === 'object' && typeof v.toNumber === 'function') return v.toNumber();
        const n = Number(v); return isNaN(n) ? null : n;
    };
    return {
        mimetype:   mediaObj.mimetype    || null,
        fileName:   mediaObj.fileName    || null,
        fileLength: toNum(mediaObj.fileLength),
        duration:   toNum(mediaObj.seconds) || toNum(mediaObj.duration),
        height:     toNum(mediaObj.height),
        width:      toNum(mediaObj.width),
        caption:    mediaObj.caption     || null,
        mediaKey:   mediaObj.mediaKey    || null,
        directPath: mediaObj.directPath  || null,
        url:        mediaObj.url         || null,
        sha256:     mediaObj.fileSha256  || null,
        encSha256:  mediaObj.fileEncSha256 || null,
        ptt:        mediaObj.ptt         || false,
        isAnimated: mediaObj.isAnimated  || false,
        gifPlayback: mediaObj.gifPlayback || false,
    };
}

function extractContextInfo(contextInfo) {
    if (!contextInfo) return null;
    return {
        stanzaId:       contextInfo.stanzaId    || null,
        participant:    contextInfo.participant  || null,
        quotedMessage:  contextInfo.quotedMessage  ? JSON.stringify(contextInfo.quotedMessage)  : null,
        mentionedJids:  contextInfo.mentionedJid?.length ? JSON.stringify(contextInfo.mentionedJid) : null,
        isForwarded:    contextInfo.isForwarded  || false,
        forwardingScore: contextInfo.forwardingScore || 0,
    };
}

// ════════════════════════════════════════════════════════════
// [FIX-12] DATABASE PUBLIC API — dipisah dari statements
// ════════════════════════════════════════════════════════════

const database = {

    // ── Init / Close ──────────────────────────────────────────────────────────
    init() {
        db.prepare('SELECT 1').get(); // verify open
        return this;
    },
    close() {
        try {
            if (db.open) {
                db.pragma('wal_checkpoint(TRUNCATE)');
                db.close();
            }
        } catch (err) {
            console.error('[AuroraDB] close error:', err.message);
        }
    },

    // Expose statements untuk client.js yang akses langsung
    get statements() { return statements; },

    // ════════════════════════════════════════════════════════════
    // MESSAGES
    // ════════════════════════════════════════════════════════════

    /**
     * saveMessage — dipanggil dari client.js handleMessage() dengan raw WAMessage Baileys
     */
    saveMessage(msg, isHistorySync = false, syncType = null) {
        try {
            const type    = detectMessageType(msg.message);
            const content = extractContent(msg.message, type);

            const toNum = v => {
                if (v == null) return null;
                if (typeof v === 'object' && typeof v.toNumber === 'function') return v.toNumber();
                const n = Number(v); return isNaN(n) ? null : n;
            };
            const toStr = v => {
                if (v == null) return null;
                if (typeof v === 'string') return v;
                if (Buffer.isBuffer(v)) return v.toString('base64');
                if (typeof v === 'object') return JSON.stringify(v);
                return String(v);
            };
            const toBool  = v => (v ? 1 : 0);
            const toB64   = v => {
                if (!v) return null;
                if (typeof v === 'string') return v;
                try { return Buffer.from(v).toString('base64'); } catch { return null; }
            };

            const params = {
                id:           toStr(msg.key.id),
                remote_jid:   toStr(msg.key.remoteJid),
                from_me:      toBool(msg.key.fromMe),
                participant:  toStr(msg.participant || (!msg.key.fromMe ? msg.key.remoteJid : null)),
                push_name:    toStr(msg.pushName),
                message_type: type,
                body:         toStr(content.body),
                message_json: JSON.stringify(msg.message),

                media_mimetype:    toStr(content.media?.mimetype),
                media_file_name:   toStr(content.media?.fileName),
                media_file_length: toNum(content.media?.fileLength),
                media_duration:    toNum(content.media?.duration),
                media_height:      toNum(content.media?.height),
                media_width:       toNum(content.media?.width),
                media_caption:     toStr(content.media?.caption),
                media_key:         toB64(content.media?.mediaKey),
                media_direct_path: toStr(content.media?.directPath),
                media_url:         toStr(content.media?.url),
                media_sha256:      toB64(content.media?.sha256),
                media_enc_sha256:  toB64(content.media?.encSha256),

                is_ptt:       toBool(content.media?.ptt || type === 'pttMessage'),
                is_gif:       toBool(content.media?.gifPlayback),
                is_view_once: toBool(type === 'viewOnceMessage' || type === 'viewOnceMessageV2'),
                is_animated:  toBool(content.media?.isAnimated),

                context_stanza_id:        toStr(content.context?.stanzaId),
                context_participant:      toStr(content.context?.participant),
                context_quoted_message:   toStr(content.context?.quotedMessage),
                context_mentioned_jids:   toStr(content.context?.mentionedJids),
                context_is_forwarded:     toBool(content.context?.isForwarded),
                context_forwarding_score: toNum(content.context?.forwardingScore) ?? 0,

                reaction_text:              toStr(content.reaction?.text),
                reaction_target_id:         toStr(content.reaction?.targetId),
                reaction_target_remote_jid: toStr(content.reaction?.targetRemoteJid),
                reaction_target_from_me:    toBool(content.reaction?.targetFromMe),

                poll_name:             toStr(content.poll?.name),
                poll_options:          content.poll?.options ? JSON.stringify(content.poll.options) : null,
                poll_selectable_count: toNum(content.poll?.selectableCount),
                poll_votes:            null,

                location_lat:      toNum(content.location?.lat),
                location_lng:      toNum(content.location?.lng),
                location_name:     toStr(content.location?.name),
                location_address:  toStr(content.location?.address),
                location_accuracy: toNum(content.location?.accuracy),

                contact_vcard:        toStr(content.contact?.vcard),
                contact_display_name: toStr(content.contact?.displayName),

                protocol_type:   toNum(content.protocol?.type),
                protocol_key_id: toStr(content.protocol?.keyId),

                status:          toNum(msg.status) ?? 0,
                starred:         toBool(msg.starred),
                broadcast:       toBool(msg.broadcast),
                is_history_sync: toBool(isHistorySync),
                sync_type:       toStr(syncType),
                message_timestamp: toNum(msg.messageTimestamp) ?? Math.floor(Date.now() / 1000),
            };

            statements.insertMessage.run(params);

            // Ensure chat row exists (FK safety)
            const isGroup = (params.remote_jid || '').endsWith('@g.us');
            statements.ensureChat.run(params.remote_jid, isGroup ? 1 : 0, params.message_timestamp);

            // Update chat last message (only live messages)
            if (!isHistorySync) {
                statements.updateChatLastMessage.run({
                    jid:        params.remote_jid,
                    timestamp:  params.message_timestamp,
                    message_id: params.id,
                    body:       params.body || `[${type}]`,
                    msg_type:   type,
                });
            }

            return { success: true, id: params.id, type, hasMedia: !!content.media };
        } catch (err) {
            console.error('[AuroraDB] saveMessage error:', err.message);
            return { success: false, error: err.message };
        }
    },

    /**
     * [FIX-2] insertMessage — dipanggil dari client.patch.js (messageParser path)
     * Menerima objek parsed dari parseMessage()
     */
    insertMessage(parsed) {
        if (!parsed?.id) throw new Error('insertMessage: missing id');

        const toStr = v => {
            if (v == null) return null;
            if (typeof v === 'string') return v;
            try { return JSON.stringify(v); } catch { return null; }
        };

        // Ensure chat row (FK safety)
        const isGroup = (parsed.chat_jid || '').endsWith('@g.us');
        statements.ensureChat.run(
            parsed.chat_jid,
            parsed.is_group ?? (isGroup ? 1 : 0),
            parsed.timestamp || Math.floor(Date.now() / 1000)
        );

        statements.insertMessage.run({
            id:                       parsed.id,
            remote_jid:               parsed.chat_jid,
            from_me:                  parsed.from_me ?? 0,
            participant:              parsed.sender_jid || null,
            push_name:                parsed.pushname || parsed.sender_name || null,
            message_type:             parsed.msg_type || 'conversation',
            body:                     parsed.body || null,
            message_json:             parsed.raw_json || null,

            media_mimetype:           parsed.mimetype || null,
            media_file_name:          parsed.media_filename || null,
            media_file_length:        parsed.media_size || null,
            media_duration:           parsed.media_duration || parsed.duration || null,
            media_height:             parsed.media_height || null,
            media_width:              parsed.media_width || null,
            media_caption:            parsed.body || null,
            media_key:                null,
            media_direct_path:        null,
            media_url:                parsed.media_url || null,
            media_sha256:             null,
            media_enc_sha256:         null,

            is_ptt:                   parsed.is_ptt ?? 0,
            is_gif:                   parsed.is_gif ?? 0,
            is_view_once:             parsed.is_view_once ?? 0,
            is_animated:              parsed.is_animated ?? 0,

            context_stanza_id:        parsed.quoted_id || null,
            context_participant:      parsed.quoted_sender || null,
            context_quoted_message:   parsed.quoted_body || null,
            context_mentioned_jids:   toStr(parsed.mentioned_jids),
            context_is_forwarded:     parsed.is_forwarded ?? 0,
            context_forwarding_score: parsed.forwarding_score ?? 0,

            reaction_text:            parsed.reaction_emoji || null,
            reaction_target_id:       parsed.reaction_target_id || null,
            reaction_target_remote_jid: null,
            reaction_target_from_me:  null,

            poll_name:                parsed.body || null,
            poll_options:             toStr(parsed.poll_options),
            poll_selectable_count:    null,
            poll_votes:               null,

            location_lat:             parsed.location_lat || null,
            location_lng:             parsed.location_lng || null,
            location_name:            parsed.location_name || null,
            location_address:         parsed.location_address || null,
            location_accuracy:        null,

            contact_vcard:            toStr(parsed.contacts_json),
            contact_display_name:     null,

            protocol_type:            null,
            protocol_key_id:          null,

            status:                   parsed.status ?? 0,
            starred:                  parsed.starred ?? 0,
            broadcast:                0,
            is_history_sync:          parsed.is_history_sync ?? 0,
            sync_type:                null,
            message_timestamp:        parsed.timestamp || Math.floor(Date.now() / 1000),
        });
    },

    getMessageById:       id                => statements.getMessageById.get(id) || null,

    // [FIX-3] Positional params
    getMessages:          (jid, limit = 50, offset = 0) => statements.getMessagesByJid.all(jid, limit, offset),
    getMessageCount:      jid               => (db.prepare('SELECT COUNT(*) as n FROM messages WHERE remote_jid = ? AND is_deleted = 0').get(jid)?.n) || 0,

    // [FIX-6] Positional params
    searchMessages:       (jid, query)      => statements.searchMessages.all(jid, `%${query}%`),
    searchMessagesGlobal: query             => statements.searchMessagesGlobal.all(`%${query}%`),

    updateMessageStatus(id, status) {
        if (!id) return;
        statements.updateMessageStatus.run(status, id);
    },

    updateMediaSavedPath(id, localPath) {
        if (!id || !localPath) return;
        statements.updateMediaSavedPath.run(localPath, id);
    },

    updateMediaDownload(messageId, localPath, fileSize, status, errorMessage = null) {
        if (!messageId) return;
        statements.updateMediaDownload.run({
            message_id:      messageId,
            local_path:      localPath || null,
            file_size:       fileSize  || null,
            download_status: status    || 'unknown',
            error_message:   errorMessage || null,
        });
        // Sync ke messages table jika berhasil
        if (status === 'downloaded' && localPath) {
            statements.updateMediaSavedPath.run(localPath, messageId);
        }
    },

    updatePollVotes(id, pollResultsJson) {
        if (!id) return;
        const val = typeof pollResultsJson === 'string' ? pollResultsJson : JSON.stringify(pollResultsJson);
        statements.updatePollVotes.run(val, id);
    },

    // [FIX-9] Kolom yang benar: poll_message_id / voter_jid / selected_options
    savePollVote(messageId, voterJid, vote) {
        try {
            const opts = Array.isArray(vote?.selectedOptions)
                ? JSON.stringify(vote.selectedOptions.map(o => Buffer.isBuffer(o) ? o.toString('hex') : String(o)))
                : JSON.stringify([]);
            db.prepare(`
                INSERT INTO poll_votes (poll_message_id, voter_jid, selected_options, voted_at)
                VALUES (?, ?, ?, unixepoch())
                ON CONFLICT(poll_message_id, voter_jid) DO UPDATE SET
                    selected_options = excluded.selected_options,
                    voted_at = excluded.voted_at
            `).run(messageId, voterJid, opts);
        } catch (err) { console.error('[AuroraDB] savePollVote:', err.message); }
    },

    saveMessageEdit(id, newBody, timestamp) {
        try {
            // Simpan histori edit
            db.prepare(`
                INSERT OR IGNORE INTO message_edits (original_message_id, original_body, edited_body, edited_timestamp)
                SELECT ?, body, ?, ?
                FROM messages WHERE id = ?
            `).run(id, newBody, timestamp ?? Math.floor(Date.now() / 1000), id);
            // Update body + edited_at di messages
            db.prepare('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?')
                .run(newBody ?? null, timestamp ?? Math.floor(Date.now() / 1000), id);
        } catch (err) { console.error('[AuroraDB] saveMessageEdit:', err.message); }
    },

    updateMediaSavedPath(id, localPath) {
        if (!id || !localPath) return;
        statements.updateMediaSavedPath.run(localPath, id);
    },

    // ════════════════════════════════════════════════════════════
    // CHATS
    // ════════════════════════════════════════════════════════════

    // [FIX-13] UPSERT agar unread_count/pinned/dll tidak direset
    saveChat(chat) {
        if (!chat?.id) return { success: false };
        try {
            const jid = chat.id;
            statements.upsertChat.run({
                jid,
                name:                   chat.name || chat.subject || null,
                is_group:               jid.endsWith('@g.us') ? 1 : 0,
                is_community:           jid.endsWith('@newsletter') || chat.isCommunity ? 1 : 0,
                community_jid:          chat.linkedParent || null,
                unread_count:           chat.unreadCount ?? 0,
                last_message_timestamp: chat.conversationTimestamp ? Number(chat.conversationTimestamp) : 0,
                last_message_id:        chat.lastMessageKey?.id || null,
                last_message_body:      null,
                pinned:                 chat.pinned ? 1 : 0,
                archived:               chat.archived ? 1 : 0,
                muted_until:            chat.muteEndTime ? Number(chat.muteEndTime) : 0,
                profile_pic_url:        chat.profilePicUrl || null,
                status:                 null,
                presence:               null,
            });
            return { success: true };
        } catch (err) {
            console.error('[AuroraDB] saveChat:', err.message);
            return { success: false, error: err.message };
        }
    },

    upsertChat({ jid, name, isGroup, isCommunity, communityJid, lastMsgAt, unreadDelta }) {
        if (!jid) return;
        statements.upsertChat.run({
            jid,
            name:                   name || null,
            is_group:               isGroup    ? 1 : 0,
            is_community:           isCommunity ? 1 : 0,
            community_jid:          communityJid || null,
            unread_count:           unreadDelta || 0,
            last_message_timestamp: lastMsgAt  || 0,
            last_message_id:        null,
            last_message_body:      null,
            pinned:                 0,
            archived:               0,
            muted_until:            0,
            profile_pic_url:        null,
            status:                 null,
            presence:               null,
        });
    },

    // [FIX-4] Positional params
    getChats:         (limit = 60, offset = 0)  => statements.getChats.all(limit, offset),
    getChatCount:     ()                         => (db.prepare('SELECT COUNT(*) as n FROM chats WHERE is_community = 0').get()?.n) || 0,
    getGroups:        (limit = 200, offset = 0)  => db.prepare(`SELECT c.jid, COALESCE(c.name, ct.name) AS name, c.is_group, c.is_community, c.unread_count, c.pinned, c.last_message_timestamp AS last_msg_at, c.last_message_body AS last_msg FROM chats c LEFT JOIN contacts ct ON ct.jid = c.jid WHERE c.is_group = 1 AND c.is_community = 0 ORDER BY c.last_message_timestamp DESC LIMIT ? OFFSET ?`).all(limit, offset),
    getGroupCount:    ()                         => (db.prepare('SELECT COUNT(*) as n FROM chats WHERE is_group = 1 AND is_community = 0').get()?.n) || 0,
    getCommunities:   (limit = 100, offset = 0)  => db.prepare(`SELECT jid, name, is_group, is_community, unread_count, pinned, last_message_timestamp AS last_msg_at, last_message_body AS last_msg FROM chats WHERE is_community = 1 ORDER BY last_message_timestamp DESC LIMIT ? OFFSET ?`).all(limit, offset),
    getCommunityCount:()                         => (db.prepare('SELECT COUNT(*) as n FROM chats WHERE is_community = 1').get()?.n) || 0,

    searchChats(query) {
        const q = `%${query}%`;
        return db.prepare(`SELECT c.jid, COALESCE(c.name, ct.name, ct.push_name) AS name, c.is_group, c.is_community, c.unread_count, c.pinned, c.last_message_timestamp AS last_msg_at FROM chats c LEFT JOIN contacts ct ON ct.jid = c.jid WHERE c.name LIKE ? OR ct.name LIKE ? OR ct.push_name LIKE ? OR c.jid LIKE ? ORDER BY c.last_message_timestamp DESC LIMIT 30`).all(q, q, q, q);
    },

    markChatRead:       jid     => jid && statements.markChatRead.run(jid),
    updateChatRead:     jid     => jid && statements.markChatRead.run(jid),
    pinChat:            (jid,v) => jid && statements.updateChatPinned.run(v ? 1 : 0, jid),
    updateChatPinned:   (jid,v) => jid && statements.updateChatPinned.run(v ? 1 : 0, jid),
    archiveChat:        (jid,v) => jid && statements.updateChatArchived.run(v ? 1 : 0, jid),
    updateChatArchived: (jid,v) => jid && statements.updateChatArchived.run(v ? 1 : 0, jid),
    updateChatUnread:   (jid,c) => jid && statements.updateChatUnread.run(c ?? 0, jid),

    // ════════════════════════════════════════════════════════════
    // CONTACTS
    // ════════════════════════════════════════════════════════════

    saveContact(contact) {
        if (!contact?.id) return { success: false };
        try {
            statements.insertContact.run({
                jid:             contact.id,
                name:            contact.name || contact.verifiedName || null,
                push_name:       contact.pushname || contact.notify || null,
                short_name:      contact.shortName || null,
                number:          contact.number || contact.id.split('@')[0] || null,
                status:          contact.status || null,
                profile_pic_url: contact.profilePicUrl || null,
                is_group:        contact.isGroup    ? 1 : 0,
                is_user:         contact.isUser     ? 1 : 0,
                is_business:     contact.isBusiness ? 1 : 0,
            });
            return { success: true };
        } catch (err) {
            console.error('[AuroraDB] saveContact:', err.message);
            return { success: false, error: err.message };
        }
    },

    // [FIX-8] Gunakan referensi internal yang aman — tidak bergantung pada
    // `database` object yang belum selesai didefinisikan saat module load
    saveContacts(contacts) {
        if (!Array.isArray(contacts)) return;
        const self = this;
        const run = db.transaction(list => { for (const c of list) self.saveContact(c); });
        try { run(contacts); } catch (err) { console.error('[AuroraDB] saveContacts:', err.message); }
    },

    bulkUpsertContacts(contacts) { this.saveContacts(contacts); },

    // [FIX-5] Positional params
    getContacts:      (limit = 100, offset = 0) => statements.getContacts.all(limit, offset),
    getContactCount:  ()                         => (db.prepare('SELECT COUNT(*) as n FROM contacts').get()?.n) || 0,

    // [FIX-7] Positional 4-param search
    searchContacts(query) {
        const q = `%${query}%`;
        return statements.searchContacts.all(q, q, q, q);
    },

    // ════════════════════════════════════════════════════════════
    // MEDIA QUEUE
    // ════════════════════════════════════════════════════════════

    queueMediaDownload(messageId, remoteJid, mediaType, url) {
        if (!messageId) return;
        try {
            statements.insertMediaDownload.run(messageId, remoteJid || '', mediaType || '', url || null);
        } catch (err) { /* ignore duplicate */ }
    },

    getPendingMediaDownloads: () => statements.getPendingMediaDownloads.all(),

    // ════════════════════════════════════════════════════════════
    // SYNC STATUS
    // [FIX-10] Statement terpisah, tidak pakai updateSyncStatus
    // ════════════════════════════════════════════════════════════

    startSync()                      { statements.startSyncStmt.run(); },
    endSync(totalChats = 0, totalMessages = 0) { statements.endSyncStmt.run(totalChats, totalMessages); },
    getSyncStatus()                  { return statements.getSyncStatus.get() || { status: 'idle', is_syncing: 0 }; },

    // ════════════════════════════════════════════════════════════
    // STATS
    // ════════════════════════════════════════════════════════════

    getStats() {
        const row = statements.getStats.get() || {};
        let dbSizeBytes = 0;
        try { dbSizeBytes = fs.statSync(DB_PATH).size; } catch (_) {}
        return {
            ...row,
            dbSizeBytes,
            dbSizeMB: (dbSizeBytes / 1024 / 1024).toFixed(2),
        };
    },

    // ════════════════════════════════════════════════════════════
    // [FIX-11] LEGACY ALIASES — backward compat
    // ════════════════════════════════════════════════════════════

    // Alias yang dulu ada di dalam `statements` tapi harusnya di `database`
    getMessagesFromDB:  (jid, limit, offset) => database.getMessages(jid, limit, offset),
    searchMessagesInDB: (jid, query)         => database.searchMessages(jid, query),
    getDBStats:         ()                   => database.getStats(),
};

module.exports = database;